const path = require("path");
const fs = require("fs");
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

  CREATE TABLE IF NOT EXISTS proveedor_productos (
    proveedor TEXT NOT NULL,
    codigo TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'adicional',
    actualizado_en TEXT NOT NULL,
    PRIMARY KEY (proveedor, codigo)
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
if (!columnas.includes("presentacion_proveedor")) {
  db.exec("ALTER TABLE proveedor_productos ADD COLUMN presentacion_proveedor TEXT");
}

module.exports = db;

