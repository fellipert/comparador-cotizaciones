const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "cotizaciones.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    proveedor TEXT NOT NULL,
    semana TEXT,
    fecha_envio TEXT,
    uploaded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT NOT NULL,
    codigo TEXT NOT NULL,
    producto TEXT,
    presentacion TEXT,
    disponibilidad TEXT,
    precio REAL NOT NULL,
    observacion TEXT,
    proveedor TEXT NOT NULL,
    semana TEXT,
    vigencia_fin TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_quotes_codigo ON quotes(codigo);
  CREATE INDEX IF NOT EXISTS idx_quotes_file ON quotes(file_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalogo (
    codigo TEXT PRIMARY KEY,
    producto TEXT,
    presentacion TEXT
  );

  CREATE TABLE IF NOT EXISTS proveedores (
    nombre TEXT PRIMARY KEY,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'proveedor',
    proveedor_nombre TEXT,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    expira_en TEXT NOT NULL,
    creado_en TEXT NOT NULL,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS codigos_recuperacion (
    usuario TEXT PRIMARY KEY,
    codigo TEXT NOT NULL,
    expira_en TEXT NOT NULL,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS proveedor_productos (
    proveedor TEXT NOT NULL,
    codigo TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'adicional',
    actualizado_en TEXT NOT NULL,
    PRIMARY KEY (proveedor, codigo)
  );

  CREATE TABLE IF NOT EXISTS ciclos (
    id TEXT PRIMARY KEY,
    anio INTEGER NOT NULL,
    semana_calendario INTEGER NOT NULL,
    fecha_inicio_recepcion TEXT NOT NULL,
    fecha_fin_recepcion TEXT NOT NULL,
    fecha_inicio_vigencia TEXT NOT NULL,
    fecha_fin_vigencia TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'BORRADOR',
    creado_en TEXT NOT NULL,
    cerrado_en TEXT,
    cerrado_por TEXT
  );
`);

db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('contrapropuesta_pct', '2')").run();

const columnas = db.prepare("PRAGMA table_info(proveedor_productos)").all().map((c) => c.name);
if (!columnas.includes("contrapropuesta_manual")) {
  db.exec("ALTER TABLE proveedor_productos ADD COLUMN contrapropuesta_manual REAL");
}
if (!columnas.includes("activo")) {
  db.exec("ALTER TABLE proveedor_productos ADD COLUMN activo INTEGER NOT NULL DEFAULT 1");
}
if (!columnas.includes("frecuencia")) {
  db.exec("ALTER TABLE proveedor_productos ADD COLUMN frecuencia TEXT NOT NULL DEFAULT 'diario'");
}

const columnasQuotes = db.prepare("PRAGMA table_info(quotes)").all().map((c) => c.name);
if (!columnasQuotes.includes("ciclo_id")) {
  db.exec("ALTER TABLE quotes ADD COLUMN ciclo_id TEXT");
}

const totalProveedoresRegistrados = db.prepare("SELECT COUNT(*) as n FROM proveedores").get().n;
if (totalProveedoresRegistrados === 0) {
  const nombresExistentes = db.prepare(`
    SELECT DISTINCT proveedor as nombre FROM quotes
    UNION
    SELECT DISTINCT proveedor as nombre FROM proveedor_productos
  `).all();
  const insertProv = db.prepare("INSERT OR IGNORE INTO proveedores (nombre, creado_en) VALUES (?, ?)");
  const ahora = new Date().toISOString();
  const sembrar = db.transaction((rows) => { rows.forEach((r) => insertProv.run(r.nombre, ahora)); });
  sembrar(nombresExistentes);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
const totalUsuarios = db.prepare("SELECT COUNT(*) as n FROM usuarios").get().n;
if (totalUsuarios === 0) {
  const passwordInicial = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(passwordInicial, salt);
  db.prepare(`
    INSERT INTO usuarios (usuario, password_hash, password_salt, tipo, proveedor_nombre, creado_en)
    VALUES ('admin', ?, ?, 'admin', NULL, ?)
  `).run(hash, salt, new Date().toISOString());
  console.log("=".repeat(60));
  console.log("USUARIO ADMINISTRADOR CREADO POR PRIMERA VEZ");
  console.log("  usuario:    admin");
  console.log("  contraseña: " + passwordInicial);
  console.log("Guárdala ahora — no se volverá a mostrar.");
  console.log("=".repeat(60));
}

module.exports = db;
module.exports.hashPassword = hashPassword;
