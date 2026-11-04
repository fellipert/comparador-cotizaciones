"use strict";
// Arranque limpio para producción: borra los MOVIMIENTOS de ensayo (semanas, solicitudes, cotizaciones, negociaciones
// y avisos) y conserva los datos maestros: proveedores, catálogo, productos de cada proveedor, usuarios, configuración
// (% de contrapropuesta, consecutivo de OC, logo) y la bitácora de seguridad.
//
// Uso:  node scripts/limpiar_ensayos.js --datos <carpeta de la base>            (solo muestra lo que borraría)
//       node scripts/limpiar_ensayos.js --datos <carpeta de la base> --aplicar  (respalda y borra)
// Hacerlo con el servicio detenido. Si hay órdenes de compra, demanda o distribución, se detiene sin tocar nada.
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

function arg(nombre) {
  const i = process.argv.indexOf("--" + nombre);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const APLICAR = process.argv.includes("--aplicar");
const datos = path.resolve(arg("datos") || process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const base = path.join(datos, "cotizaciones.db");

// Movimientos que se borran (en este orden: primero los que dependen de otros)
const BORRAR = [
  "negociacion_publicaciones", "negociacion_unificada_historial", "negociacion_unificada_productos", "negociaciones_unificadas",
  "subasta_proveedores", "subasta_productos", "subastas",
  "quotes", "files",
  "notificaciones", "tokens_recuperacion", "codigos_recuperacion",
  "ciclos",
];
// Si alguna de estas tiene datos, no son ensayos: no se toca nada
const PROTEGIDAS = ["ordenes_compra_v2", "orden_compra_v2_items", "pedido_asignaciones", "demandas_pedido", "demanda_pedido_detalles", "pedido_distribucion_porcentajes"];
// Ajustes que apuntan a semanas que se borran (el % de contrapropuesta, el consecutivo de OC y el logo se conservan)
const AJUSTES = ["ciclo_activo_id", "semana_trabajo_id", "contrapropuestas_auto_ultimo_corte", "apertura_auto_ciclo"];
const CONSERVAR = ["proveedores", "catalogo", "proveedor_productos", "usuarios", "bitacora", "settings"];

(async () => {
  try {
    if (!fs.existsSync(base)) throw new Error("No existe la base " + base);
    const db = new Database(base, { fileMustExist: true });
    const existe = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const cuenta = (t) => (existe(t) ? db.prepare('SELECT COUNT(*) AS n FROM "' + t + '"').get().n : null);

    const conDatos = PROTEGIDAS.filter((t) => cuenta(t) > 0);
    if (conDatos.length) {
      throw new Error("Hay datos en " + conDatos.map((t) => t + " (" + cuenta(t) + ")").join(", ") + ". No parecen ensayos: no se tocó nada.");
    }

    console.log((APLICAR ? "LIMPIEZA" : "PRUEBA (no se borra nada; para borrar agrega --aplicar)") + " sobre " + base);
    console.log("\nSemanas que se borran: " + (existe("ciclos") ? db.prepare("SELECT id FROM ciclos ORDER BY id").all().map((c) => c.id).join(", ") || "ninguna" : "ninguna"));
    console.log("\nSe borra:");
    BORRAR.filter(existe).forEach((t) => console.log("  " + String(cuenta(t)).padStart(6) + "  " + t));
    console.log("\nSe conserva:");
    CONSERVAR.filter(existe).forEach((t) => console.log("  " + String(cuenta(t)).padStart(6) + "  " + t));
    console.log("\nAjustes que se quitan: " + AJUSTES.filter((k) => db.prepare("SELECT 1 FROM settings WHERE key = ?").get(k)).join(", "));
    const quedan = db.prepare("SELECT key, value FROM settings WHERE key NOT IN (" + AJUSTES.map(() => "?").join(",") + ")").all(...AJUSTES);
    console.log("Ajustes que se conservan: " + quedan.map((r) => r.key + (/(pct|consecutivo)/.test(r.key) ? "=" + r.value : "")).join(", "));

    if (!APLICAR) { db.close(); process.exit(0); }

    const carpeta = path.join(datos, "respaldos");
    fs.mkdirSync(carpeta, { recursive: true });
    const respaldo = path.join(carpeta, "cotizaciones.antes_limpieza_" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
    await db.backup(respaldo);
    console.log("\nRespaldo: " + respaldo);

    const borrados = {};
    db.transaction(() => {
      for (const t of BORRAR.filter(existe)) borrados[t] = db.prepare('DELETE FROM "' + t + '"').run().changes;
      db.prepare("DELETE FROM settings WHERE key IN (" + AJUSTES.map(() => "?").join(",") + ")").run(...AJUSTES);
      // Que los nuevos registros no reutilicen números viejos solo importa en tablas con AUTOINCREMENT; se dejan como están.
      db.prepare("INSERT INTO bitacora (usuario, accion, detalle, ip, creado_en) VALUES ('sistema', 'ensayos_borrados', ?, NULL, ?)")
        .run(("Arranque limpio: " + Object.entries(borrados).filter(([, n]) => n).map(([t, n]) => t + " " + n).join(", ")).slice(0, 500), new Date().toISOString());
    })();
    const integridad = db.pragma("integrity_check", { simple: true });
    db.close();
    console.log("Borrado: " + JSON.stringify(borrados));
    console.log("Integridad de la base: " + integridad);
    process.exit(integridad === "ok" ? 0 : 1);
  } catch (e) {
    console.error("NO SE APLICÓ NADA: " + e.message);
    process.exit(1);
  }
})();
