const db = require("./db");

// Avisos que ve el proveedor en su portal. Se llaman "avisos" para no confundirlos
// con la pestaña Alertas (alertas de precio del equipo interno).

// ---------- Esquema (se crea solo al arrancar; seguro de ejecutar siempre) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS avisos_proveedor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor TEXT NOT NULL,
    ciclo_id TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'nueva_semana',
    creado_en TEXT NOT NULL,
    visto_en TEXT,
    UNIQUE (proveedor, ciclo_id, tipo)
  );
`);

// Al abrir una semana se avisa a todos los proveedores registrados.
// Si la misma semana se vuelve a abrir, no se repite el aviso a quien ya lo tiene.
function avisarNuevaSemana(cicloId) {
  const proveedores = db.prepare("SELECT nombre FROM proveedores ORDER BY nombre").all();
  const insertar = db.prepare(`
    INSERT OR IGNORE INTO avisos_proveedor (proveedor, ciclo_id, tipo, creado_en)
    VALUES (?, ?, 'nueva_semana', ?)
  `);
  const ahora = new Date().toISOString();
  let nuevos = 0;
  db.transaction(() => {
    proveedores.forEach((p) => { nuevos += insertar.run(p.nombre, cicloId, ahora).changes; });
  })();
  return { proveedores: proveedores.length, nuevos };
}

// El aviso se muestra mientras el proveedor no lo haya marcado como visto y no haya enviado propuesta en la semana.
function avisoPendiente(proveedor, cicloId) {
  const aviso = db.prepare(`
    SELECT id, ciclo_id, creado_en
    FROM avisos_proveedor
    WHERE proveedor = ? AND ciclo_id = ? AND tipo = 'nueva_semana' AND visto_en IS NULL
  `).get(proveedor, cicloId);
  if (!aviso) return null;
  const yaCotizo = db.prepare("SELECT 1 FROM quotes WHERE proveedor = ? AND ciclo_id = ? LIMIT 1").get(proveedor, cicloId);
  return yaCotizo ? null : aviso;
}

function resumenAvisos(cicloId) {
  const r = db.prepare(`
    SELECT
      COUNT(*) AS enviados,
      COALESCE(SUM(CASE WHEN a.visto_en IS NOT NULL THEN 1 ELSE 0 END), 0) AS vistos,
      COALESCE(SUM(CASE WHEN EXISTS (
        SELECT 1 FROM quotes q WHERE q.proveedor = a.proveedor AND q.ciclo_id = a.ciclo_id
      ) THEN 1 ELSE 0 END), 0) AS con_propuesta,
      COALESCE(SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM usuarios u WHERE u.tipo = 'proveedor' AND u.proveedor_nombre = a.proveedor
      ) THEN 1 ELSE 0 END), 0) AS sin_usuario
    FROM avisos_proveedor a
    WHERE a.ciclo_id = ? AND a.tipo = 'nueva_semana'
  `).get(cicloId);
  return Object.assign({ ciclo_id: cicloId }, r);
}

// ---------- Registro de rutas (llamado una sola vez desde server.js) ----------
module.exports = function registrarAvisosProveedor(app, requireAdmin, requireProveedor) {
  app.post("/api/proveedor/avisos/:id/visto", requireProveedor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Aviso inválido." });
    db.prepare(`
      UPDATE avisos_proveedor SET visto_en = ?
      WHERE id = ? AND proveedor = ? AND visto_en IS NULL
    `).run(new Date().toISOString(), id, req.usuarioActual.proveedor_nombre);
    res.json({ ok: true });
  });

  app.get("/api/avisos-proveedores/resumen", requireAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo || "").trim();
    if (!ciclo) return res.status(400).json({ error: "Falta indicar el ciclo." });
    res.json(resumenAvisos(ciclo));
  });
};

module.exports.avisarNuevaSemana = avisarNuevaSemana;
module.exports.avisoPendiente = avisoPendiente;
