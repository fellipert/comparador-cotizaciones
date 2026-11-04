"use strict";
// Calendario semanal de la subasta, en hora de Colombia (UTC-5 todo el año):
//  - La solicitud de cotización se abre el viernes a las 6:00 a.m. y cierra el lunes a las 7:00 p.m.
//  - De viernes a lunes, a las 7:00 p.m., salen solas las contrapropuestas de lo que enviaron los proveedores.
//  - Los precios rigen de miércoles a martes (calcularVentanaRecepcion en analytics.js).
const db = require("./db");
const { calcularVentanaRecepcion } = require("./analytics");

const HORA_APERTURA = "06:00";
const HORA_CIERRE = "19:00";
const HORA_CONTRAPROPUESTAS = "19:00";

const fechaBogota = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(d);
const instante = (fecha, hora) => new Date(fecha + "T" + hora + ":00-05:00");
const sumarDias = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Las tareas automáticas (abrir la semana y enviar contrapropuestas) corren en producción.
// En DEV (APP_ENV=dev), que suele tener una copia de la base real, quedan apagadas salvo TAREAS_AUTOMATICAS=1,
// para no escribir ni mandar correos a los proveedores dos veces.
function tareasAutomaticasActivas() {
  const v = String(process.env.TAREAS_AUTOMATICAS || "").trim().toLowerCase();
  if (["0", "no", "off", "false"].includes(v)) return false;
  if (["1", "si", "sí", "on", "true"].includes(v)) return true;
  return process.env.APP_ENV !== "dev";
}

// Semana a la que pertenece una fecha; si ya existe en la base, mandan sus fechas de recepción
function ventanaDe(fecha) {
  const v = calcularVentanaRecepcion(fecha);
  const fila = db.prepare("SELECT fecha_inicio_recepcion, fecha_fin_recepcion, fecha_inicio_vigencia FROM ciclos WHERE id = ?").get(v.id);
  return fila ? Object.assign({}, v, fila) : v;
}

// Último corte de las 7:00 p.m. que ya pasó, si cayó en un día de recepción y esa semana todavía no empieza a regir
function ultimoCorte(ahora = new Date()) {
  const hoy = fechaBogota(ahora);
  for (let k = 0; k <= 4; k++) {
    const fecha = sumarDias(hoy, -k);
    const t = instante(fecha, HORA_CONTRAPROPUESTAS);
    if (t > ahora) continue;
    const v = ventanaDe(fecha);
    if (fecha < v.fecha_inicio_recepcion || fecha > v.fecha_fin_recepcion) continue;
    if (hoy >= v.fecha_inicio_vigencia) return null;
    return { fecha, instante: t.toISOString(), ciclo_id: v.id };
  }
  return null;
}

// Próximo envío automático de contrapropuestas de una semana (null si ya no hay más o las tareas están apagadas)
function proximoCorte(cicloId, ahora = new Date()) {
  if (!tareasAutomaticasActivas()) return null;
  const fila = db.prepare("SELECT fecha_inicio_recepcion, fecha_fin_recepcion FROM ciclos WHERE id = ?").get(cicloId);
  if (!fila) return null;
  for (let f = fila.fecha_inicio_recepcion; f <= fila.fecha_fin_recepcion; f = sumarDias(f, 1)) {
    const t = instante(f, HORA_CONTRAPROPUESTAS);
    if (t > ahora) return t.toISOString();
  }
  return null;
}

module.exports = {
  HORA_APERTURA, HORA_CIERRE, HORA_CONTRAPROPUESTAS,
  fechaBogota, instante, sumarDias, tareasAutomaticasActivas, ventanaDe, ultimoCorte, proximoCorte,
};
