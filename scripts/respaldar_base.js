"use strict";
// Respaldo en caliente de la base del comparador con la API de respaldo de SQLite: la copia queda consistente
// aunque la aplicación esté corriendo (copiar el archivo .db a mano mientras corre puede dejarlo dañado).
// Revisa la integridad de la copia y borra los respaldos más viejos que N días.
//
// Uso:  node scripts/respaldar_base.js [--datos <carpeta>] [--destino <carpeta>] [--dias <n>]
//   --datos    carpeta de la base (por defecto DATA_DIR o ./data)
//   --destino  carpeta de los respaldos (por defecto RESPALDOS_DIR o <datos>\respaldos)
//   --dias     días que se guardan (por defecto RESPALDOS_DIAS o 30)
// Sale con código 0 si todo salió bien y 1 si falló (el Programador de tareas lo muestra como error).
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

function arg(nombre) {
  const i = process.argv.indexOf("--" + nombre);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const datos = path.resolve(arg("datos") || process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const destino = path.resolve(arg("destino") || process.env.RESPALDOS_DIR || path.join(datos, "respaldos"));
const dias = Number(arg("dias") || process.env.RESPALDOS_DIAS || 30);
const origen = path.join(datos, "cotizaciones.db");

// Cada resultado queda también en <destino>\respaldos.log (la tarea programada no muestra la consola)
function anotar(linea) {
  try { fs.mkdirSync(destino, { recursive: true }); fs.appendFileSync(path.join(destino, "respaldos.log"), linea + "\r\n"); } catch (e) { /* sin bitácora */ }
}

(async () => {
  try {
    if (!fs.existsSync(origen)) throw new Error("No existe la base " + origen);
    if (!Number.isInteger(dias) || dias < 1) throw new Error("--dias debe ser un número entero mayor que cero");
    fs.mkdirSync(destino, { recursive: true });

    const marca = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" })
      .format(new Date()).replace(" ", "_").replace(":", "");
    const archivo = path.join(destino, "cotizaciones_" + marca + ".db");

    const db = new Database(origen, { readonly: true, fileMustExist: true });
    await db.backup(archivo);
    db.close();

    // La copia queda como un solo archivo (sin -wal/-shm) y debe pasar la revisión de integridad y tener las tablas principales
    const copia = new Database(archivo, { fileMustExist: true });
    copia.pragma("journal_mode = DELETE");
    const integridad = copia.pragma("integrity_check", { simple: true });
    const tablas = copia.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('proveedores', 'usuarios', 'quotes')").get().n;
    copia.close();
    if (integridad !== "ok" || tablas !== 3) {
      fs.rmSync(archivo, { force: true });
      throw new Error("La copia no pasó la revisión (integridad: " + integridad + ", tablas principales: " + tablas + " de 3)");
    }

    // Retención: borra los respaldos de este script con más de N días
    const limite = Date.now() - dias * 86400000;
    let borrados = 0;
    for (const f of fs.readdirSync(destino)) {
      if (!/^cotizaciones_\d{4}-\d{2}-\d{2}_\d{4}\.db$/.test(f)) continue;
      const ruta = path.join(destino, f);
      if (fs.statSync(ruta).mtimeMs < limite) {
        ["", "-wal", "-shm", "-journal"].forEach((sufijo) => fs.rmSync(ruta + sufijo, { force: true }));
        borrados++;
      }
    }

    const mb = (fs.statSync(archivo).size / 1048576).toFixed(1);
    const linea = new Date().toISOString() + " Respaldo OK: " + archivo + " (" + mb + " MB). Borrados por antigüedad: " + borrados + ".";
    console.log(linea);
    anotar(linea);
    process.exit(0);
  } catch (e) {
    const linea = new Date().toISOString() + " RESPALDO FALLÓ: " + e.message;
    console.error(linea);
    anotar(linea);
    process.exit(1);
  }
})();
