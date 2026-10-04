const XLSX = require("xlsx");
const db = require("./src/db");

const archivo = "./data/Credenciales_Proveedores_Nuevas.xlsx";

const wb = XLSX.readFile(archivo);
const ws = wb.Sheets["Credenciales"] || wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws);

let correctos = 0;
let errores = [];

for (const r of rows) {
  const proveedor = String(r["Proveedor"] || "").trim();
  const usuario = String(r["Usuario"] || "").trim();
  const password = String(r["Contraseña nueva"] || "").trim();

  if (!proveedor || !usuario || !password) {
    errores.push(`Fila incompleta: ${proveedor} / ${usuario}`);
    continue;
  }

  const u = db.prepare(`
    SELECT usuario, proveedor_nombre, tipo
    FROM usuarios
    WHERE usuario = ?
  `).get(usuario);

  if (!u) {
    errores.push(`Usuario no existe: ${usuario}`);
    continue;
  }

  if (u.tipo !== "proveedor") {
    errores.push(`NO SE TOCA: ${usuario} no es proveedor`);
    continue;
  }

  if (u.proveedor_nombre !== proveedor) {
    errores.push(
      `No coincide proveedor: ${usuario} -> BD="${u.proveedor_nombre}" / Excel="${proveedor}"`
    );
    continue;
  }

  correctos++;
}

console.log("Filas Excel:", rows.length);
console.log("Credenciales válidas:", correctos);
console.log("Errores:", errores.length);

if (errores.length) {
  console.log("\nDETALLE:");
  errores.forEach(e => console.log("-", e));
  process.exit(2);
}

console.log("\nVALIDACIÓN OK. Todavía NO se modificó ninguna contraseña.");
