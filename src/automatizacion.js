"use strict";
// Tarea automática de la semana (hora de Colombia), revisada cada minuto: el viernes a las 6:00 a.m. abre la semana
// y envía la solicitud de cotización, si el admin no lo hizo antes. Si el servidor estaba apagado a esa hora, lo hace
// apenas arranca, mientras la recepción siga abierta.
// Las contrapropuestas ya no salen solas: las envía el admin con el botón «Enviar contrapropuestas» (negociacion_hoja.js).
const db = require("./db");
const auth = require("./auth");
const notificaciones = require("./notificaciones");
const subastas = require("./subastas");
const cal = require("./calendario");
const { calcularVentanaRecepcion } = require("./analytics");

const SISTEMA = "sistema";
const CLAVE_APERTURA = "apertura_auto_ciclo";
let deps = null;

const leerSetting = (key) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) || {}).value || null;
const guardarSetting = (key, value) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));

// ---------- 1. Apertura de la semana el viernes a las 6:00 a.m. ----------
function abrirSemanaSiToca(ahora) {
  const v = calcularVentanaRecepcion(cal.fechaBogota(ahora));
  if (ahora < cal.instante(v.fecha_inicio_recepcion, cal.HORA_APERTURA) || ahora >= cal.instante(v.fecha_fin_recepcion, cal.HORA_CIERRE)) return null;
  if (leerSetting(CLAVE_APERTURA) === v.id) return null; // ya se intentó esta semana
  if (db.prepare("SELECT 1 FROM subastas WHERE ciclo_id = ? LIMIT 1").get(v.id)) return null;
  const existente = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(v.id);
  if (existente && existente.cerrado_en) return null; // el admin la cerró a propósito
  const activo = deps.cicloActivo();
  if (activo && activo.id !== v.id && activo.fecha_inicio_recepcion > v.fecha_inicio_recepcion) return null; // ya se trabaja en una semana posterior

  const ciclo = deps.cicloDeVentana(v);
  const t = new Date().toISOString();
  db.transaction(() => {
    if (activo && activo.id !== ciclo.id && !activo.cerrado_en) {
      db.prepare("UPDATE ciclos SET cerrado_en = ?, cerrado_por = ? WHERE id = ?").run(t, SISTEMA, activo.id);
    }
    db.prepare("UPDATE ciclos SET cerrado_en = NULL, cerrado_por = NULL, estado = 'ABIERTO' WHERE id = ?").run(ciclo.id);
    guardarSetting("ciclo_activo_id", ciclo.id);
    guardarSetting(CLAVE_APERTURA, ciclo.id);
  })();

  let solicitud;
  try {
    solicitud = subastas.solicitudSemanal(db.prepare("SELECT * FROM ciclos WHERE id = ?").get(ciclo.id), SISTEMA, ahora);
  } catch (e) {
    console.error("[automático] solicitud semanal:", e);
    solicitud = { enviada: false, motivo: "No se pudo enviar la solicitud automática. Créala en Subastas." };
  }
  const cerrada = activo && activo.id !== ciclo.id && !activo.cerrado_en ? " Se cerró la semana " + activo.id + "." : "";
  auth.bitacora(null, "semana_abierta_automatica", ciclo.id + (solicitud.enviada ? " · solicitud #" + solicitud.id + " a " + solicitud.proveedores + " proveedores" : " · " + solicitud.motivo) + cerrada, SISTEMA);
  notificaciones.paraTipo("admin", {
    tipo: "subasta",
    titulo: "Se abrió la semana " + ciclo.id,
    mensaje: (solicitud.enviada
      ? "La solicitud de cotización salió a " + solicitud.proveedores + " proveedor(es) con plazo hasta el lunes a las 7:00 p.m."
      : "No se envió la solicitud de cotización: " + solicitud.motivo) + cerrada,
    enlace: "subastas",
  });
  console.log("[automático] Semana " + ciclo.id + " abierta" + (solicitud.enviada ? " y solicitud enviada." : ": " + solicitud.motivo));
  return { ciclo: ciclo.id, solicitud };
}

function revisar(ahora = new Date()) {
  if (!deps) throw new Error("automatizacion.iniciar() no se ha llamado");
  let apertura = null;
  try { apertura = abrirSemanaSiToca(ahora); } catch (e) { console.error("[automático] apertura:", e); }
  return { apertura };
}

// deps: cicloActivo() y cicloDeVentana(ventana) vienen de server.js
function iniciar(d) {
  deps = d;
  if (!cal.tareasAutomaticasActivas()) {
    console.log("Tareas automáticas apagadas (APP_ENV=dev o TAREAS_AUTOMATICAS=0): la semana se abre a mano.");
    return;
  }
  const tick = () => revisar(new Date());
  setTimeout(tick, 5000).unref();
  setInterval(tick, 60 * 1000).unref();
  console.log("Tarea automática: apertura de la semana y solicitud el viernes 6:00 a.m. (hora de Colombia). Las contrapropuestas las envía el admin.");
}

module.exports = { iniciar, revisar };
