"use strict";
// Tareas automáticas de la semana (hora de Colombia). Se revisan cada minuto:
//  1. Viernes 6:00 a.m.: abre la semana y envía la solicitud de cotización, si nadie lo hizo antes.
//  2. Viernes a lunes, 7:00 p.m.: a cada proveedor con cuenta en el portal le llega la contrapropuesta de lo que
//     cotizó y aún no se negociaba (precio más bajo de la semana menos el % de contrapropuesta que fija el admin).
//     Lo que envíe después de las 7:00 p.m. sale en el envío del día siguiente; el último es el lunes a las 7:00 p.m.
// Si el servidor estaba apagado a esa hora, lo hace apenas arranca, mientras la semana todavía no empiece a regir.
const db = require("./db");
const auth = require("./auth");
const notificaciones = require("./notificaciones");
const subastas = require("./subastas");
const hoja = require("./negociacion_hoja");
const cal = require("./calendario");
const { calcularVentanaRecepcion } = require("./analytics");

const SISTEMA = "sistema";
const CLAVE_ULTIMO_CORTE = "contrapropuestas_auto_ultimo_corte";
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

// ---------- 2. Contrapropuestas a las 7:00 p.m. ----------
function enviarContrapropuestas(cicloId) {
  if (hoja.esquemaFaltante().length) return { ciclo: cicloId, proveedores: [], productos: 0, error: "Faltan las tablas de negociación." };
  const quotes = db.prepare("SELECT * FROM quotes WHERE ciclo_id = ?").all(cicloId);
  const conCuenta = subastas.proveedoresConCuenta();
  const proveedores = [...new Set(quotes.map((q) => q.proveedor))].filter((p) => conCuenta.has(notificaciones.clave(p)));
  const observacion = "Contrapropuesta automática de las 7:00 p.m. (" + String(hoja.pctContrapropuesta()).replace(".", ",") + " % bajo el mejor precio).";
  const resultado = { ciclo: cicloId, proveedores: [], productos: 0 };
  for (const proveedor of proveedores.sort((a, b) => a.localeCompare(b, "es"))) {
    try {
      const r = hoja.contraproponerAutomatico(cicloId, proveedor, quotes, SISTEMA, observacion);
      if (r.productos) {
        resultado.proveedores.push(proveedor + " (" + r.productos + ")");
        resultado.productos += r.productos;
      }
    } catch (e) {
      console.error("[automático] contrapropuesta de " + proveedor + ":", e);
    }
  }
  if (resultado.productos) {
    const n = resultado.proveedores.length;
    auth.bitacora(null, "contrapropuestas_automaticas", cicloId + " · " + resultado.proveedores.join(", "), SISTEMA);
    notificaciones.paraTipo("admin", {
      tipo: "contrapropuesta",
      titulo: "Contrapropuestas enviadas: " + n + " proveedor" + (n === 1 ? "" : "es") + ", " + resultado.productos + " producto(s)",
      mensaje: "Semana " + cicloId + " · " + resultado.proveedores.join(", ") + ".",
      enlace: "hoja-negociacion",
    });
    console.log("[automático] Contrapropuestas " + cicloId + ": " + resultado.proveedores.join(", "));
  }
  return resultado;
}

function enviarContrapropuestasSiToca(ahora) {
  const corte = cal.ultimoCorte(ahora);
  if (!corte) return null;
  const ultimo = leerSetting(CLAVE_ULTIMO_CORTE);
  if (ultimo && ultimo >= corte.instante) return null;
  // El corte queda marcado aunque algo falle, para no repetir avisos cada minuto
  guardarSetting(CLAVE_ULTIMO_CORTE, corte.instante);
  return Object.assign({ corte: corte.instante }, enviarContrapropuestas(corte.ciclo_id));
}

function revisar(ahora = new Date()) {
  if (!deps) throw new Error("automatizacion.iniciar() no se ha llamado");
  let apertura = null, contrapropuestas = null;
  try { apertura = abrirSemanaSiToca(ahora); } catch (e) { console.error("[automático] apertura:", e); }
  try { contrapropuestas = enviarContrapropuestasSiToca(ahora); } catch (e) { console.error("[automático] contrapropuestas:", e); }
  return { apertura, contrapropuestas };
}

// deps: cicloActivo() y cicloDeVentana(ventana) vienen de server.js
function iniciar(d) {
  deps = d;
  if (!cal.tareasAutomaticasActivas()) {
    console.log("Tareas automáticas apagadas (APP_ENV=dev o TAREAS_AUTOMATICAS=0): la semana y las contrapropuestas se envían a mano.");
    return;
  }
  const tick = () => revisar(new Date());
  setTimeout(tick, 5000).unref();
  setInterval(tick, 60 * 1000).unref();
  console.log("Tareas automáticas: solicitud el viernes 6:00 a.m. y contrapropuestas de viernes a lunes a las 7:00 p.m. (hora de Colombia)");
}

module.exports = { iniciar, revisar, enviarContrapropuestas };
