"use strict";
// Calendario semanal de la subasta, en hora de Colombia (UTC-5 todo el año):
//  - La solicitud de cotización se abre el viernes a las 6:00 a.m. y cierra el lunes a las 7:00 p.m.
//  - Las contrapropuestas las envía el admin cuando lo decide (botón «Enviar contrapropuestas»).
//  - Los precios rigen de miércoles a martes (calcularVentanaRecepcion en analytics.js).
const HORA_APERTURA = "06:00";
const HORA_CIERRE = "19:00";

const fechaBogota = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(d);
const instante = (fecha, hora) => new Date(fecha + "T" + hora + ":00-05:00");
const sumarDias = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// La tarea automática (abrir la semana el viernes) corre en producción.
// En DEV (APP_ENV=dev), que suele tener una copia de la base real, queda apagada salvo TAREAS_AUTOMATICAS=1,
// para no escribir ni mandar correos a los proveedores dos veces.
function tareasAutomaticasActivas() {
  const v = String(process.env.TAREAS_AUTOMATICAS || "").trim().toLowerCase();
  if (["0", "no", "off", "false"].includes(v)) return false;
  if (["1", "si", "sí", "on", "true"].includes(v)) return true;
  return process.env.APP_ENV !== "dev";
}

module.exports = {
  HORA_APERTURA, HORA_CIERRE,
  fechaBogota, instante, sumarDias, tareasAutomaticasActivas,
};
