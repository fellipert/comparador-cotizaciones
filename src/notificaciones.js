"use strict";
// Avisos dentro de la aplicación (la campana). Cada aviso es una fila por usuario, así cada quien marca lo suyo como leído.
const db = require("./db");

const ahora = () => new Date().toISOString();
const clave = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

// Usuarios activos que representan a un proveedor (el nombre se compara sin tildes ni mayúsculas)
function usuariosDeProveedor(proveedor) {
  const buscado = clave(proveedor);
  return db.prepare("SELECT id, usuario, nombre, email, proveedor_nombre FROM usuarios WHERE tipo = 'proveedor' AND estado = 'activo' AND proveedor_nombre IS NOT NULL")
    .all().filter((u) => clave(u.proveedor_nombre) === buscado);
}

function usuariosPorTipo(tipo) {
  return db.prepare("SELECT id, usuario, nombre, email FROM usuarios WHERE tipo = ? AND estado = 'activo'").all(tipo);
}

function crear(usuarioIds, { tipo, titulo, mensaje = null, enlace = null }) {
  const ids = [...new Set((usuarioIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  const insertar = db.prepare("INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, enlace, creado_en) VALUES (?, ?, ?, ?, ?, ?)");
  const t = ahora();
  db.transaction(() => ids.forEach((id) => insertar.run(id, tipo, String(titulo).slice(0, 200), mensaje ? String(mensaje).slice(0, 1000) : null, enlace, t)))();
  return ids.length;
}

// Devuelven los usuarios avisados, para que quien llama pueda mandarles también el correo
function paraProveedor(proveedor, datos) {
  const usuarios = usuariosDeProveedor(proveedor);
  crear(usuarios.map((u) => u.id), datos);
  return usuarios;
}

function paraTipo(tipo, datos) {
  const usuarios = usuariosPorTipo(tipo);
  crear(usuarios.map((u) => u.id), datos);
  return usuarios;
}

// Los avisos leídos de más de 90 días se borran al arrancar
try {
  db.prepare("DELETE FROM notificaciones WHERE leida_en IS NOT NULL AND creado_en < ?").run(new Date(Date.now() - 90 * 86400000).toISOString());
} catch (e) { /* tabla recién creada */ }

function registrarRutas(app, requireSesion) {
  app.get("/api/notificaciones", requireSesion, (req, res) => {
    const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 30));
    const items = db.prepare("SELECT id, tipo, titulo, mensaje, enlace, leida_en, creado_en FROM notificaciones WHERE usuario_id = ? ORDER BY id DESC LIMIT ?")
      .all(req.usuarioActual.id, limite);
    const noLeidas = db.prepare("SELECT COUNT(*) AS n FROM notificaciones WHERE usuario_id = ? AND leida_en IS NULL").get(req.usuarioActual.id).n;
    res.json({ no_leidas: noLeidas, items });
  });

  app.post("/api/notificaciones/leer", requireSesion, (req, res) => {
    const t = ahora();
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (ids.length) {
      const marcar = db.prepare("UPDATE notificaciones SET leida_en = ? WHERE id = ? AND usuario_id = ? AND leida_en IS NULL");
      db.transaction(() => ids.forEach((id) => marcar.run(t, id, req.usuarioActual.id)))();
    } else {
      db.prepare("UPDATE notificaciones SET leida_en = ? WHERE usuario_id = ? AND leida_en IS NULL").run(t, req.usuarioActual.id);
    }
    res.json({ ok: true });
  });
}

module.exports = { crear, paraProveedor, paraTipo, usuariosDeProveedor, usuariosPorTipo, registrarRutas, clave };
