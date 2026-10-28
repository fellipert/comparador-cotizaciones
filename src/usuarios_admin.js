"use strict";
// Administración de usuarios (solo admin): crear, buscar, editar, eliminar, cambiar contraseña,
// aprobar o rechazar proveedores que se registraron solos, y consultar la bitácora de seguridad.
const crypto = require("crypto");
const db = require("./db");
const auth = require("./auth");
const correo = require("./correo");
const notificaciones = require("./notificaciones");

const ahora = () => new Date().toISOString();
const clave = notificaciones.clave;
const ESTADOS_EDITABLES = ["activo", "inactivo"];

function leerJSON(v) {
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

function usuarioPorId(id) {
  return db.prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(id)) || null;
}

function adminsActivosSin(id) {
  return db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE tipo = 'admin' AND estado = 'activo' AND id <> ?").get(Number(id)).n;
}

function proveedorExiste(nombre) {
  return db.prepare("SELECT nombre, nit FROM proveedores WHERE nombre = ?").get(String(nombre || "").trim()) || null;
}

// Proveedor ya parametrizado cuyo nombre se parece al que escribió quien se registró
function sugerirProveedor(empresa, nombres) {
  const e = clave(empresa).replace(/\b(S\.?A\.?S?|LTDA|S\.?A)\b\.?/g, "").replace(/[^A-Z0-9 ]/g, "").trim();
  if (!e) return null;
  const exacto = nombres.find((n) => clave(n).replace(/[^A-Z0-9 ]/g, "").trim() === e);
  if (exacto) return exacto;
  return nombres.find((n) => { const c = clave(n); return c.includes(e) || (e.length >= 5 && e.includes(c)); }) || null;
}

function publico(u, nombresProveedores) {
  const registro = leerJSON(u.datos_registro);
  return {
    id: u.id,
    usuario: u.usuario,
    nombre: u.nombre || "",
    email: u.email || "",
    tipo: u.tipo,
    tipoNombre: auth.NOMBRE_TIPO[u.tipo] || u.tipo,
    proveedor_nombre: u.proveedor_nombre || "",
    estado: u.estado,
    bloqueado: !!(u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()),
    debe_cambiar_password: !!u.debe_cambiar_password,
    ultimo_acceso: u.ultimo_acceso,
    creado_en: u.creado_en,
    registro,
    sugerencia_proveedor: u.estado === "pendiente" && registro && nombresProveedores ? sugerirProveedor(registro.empresa, nombresProveedores) : null,
  };
}

function avisarAprobacion(u) {
  notificaciones.crear([u.id], { tipo: "cuenta", titulo: "Tu cuenta quedó activa", mensaje: "Ya puedes ver las solicitudes de cotización de tus productos." });
  if (!u.email) return;
  correo.enviar({
    para: u.email,
    asunto: "Tu cuenta en el portal de proveedores de Mercaldas está activa",
    titulo: "Cuenta aprobada",
    parrafos: ["Hola " + (u.nombre || u.usuario) + ".", "Mercaldas aprobó tu acceso al portal de proveedores como " + u.proveedor_nombre + ".",
      "Desde el portal recibirás las solicitudes de cotización de tus productos y las contrapropuestas, sin enviar archivos de Excel.",
      "Tu usuario es: " + u.usuario],
    boton: { texto: "Entrar al portal", url: correo.urlApp("/login.html") },
  });
}

module.exports = function registrarUsuariosAdmin(app) {
  const soloAdmin = auth.requireAdmin;

  app.get("/api/usuarios", soloAdmin, (req, res) => {
    const q = clave(req.query.q || "");
    const tipo = String(req.query.tipo || "").trim();
    const estado = String(req.query.estado || "").trim();
    const nombresProveedores = db.prepare("SELECT nombre FROM proveedores").all().map((r) => r.nombre);
    const todos = db.prepare("SELECT * FROM usuarios ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, tipo, LOWER(COALESCE(nombre, usuario))").all();
    const lista = todos
      .filter((u) => (!tipo || u.tipo === tipo) && (!estado || (estado === "bloqueado" ? u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date() : u.estado === estado)))
      .filter((u) => {
        if (!q) return true;
        const r = leerJSON(u.datos_registro) || {};
        return [u.usuario, u.nombre, u.email, u.proveedor_nombre, r.empresa, r.nit].some((v) => clave(v).includes(q));
      })
      .map((u) => publico(u, nombresProveedores));
    const resumen = { total: todos.length, pendientes: todos.filter((u) => u.estado === "pendiente").length };
    auth.TIPOS.forEach((t) => { resumen[t] = todos.filter((u) => u.tipo === t).length; });
    res.json({ resumen, usuarios: lista, yo: req.usuarioActual.id });
  });

  app.get("/api/usuarios/proveedores", soloAdmin, (req, res) => {
    const productos = new Map(db.prepare("SELECT proveedor, COUNT(*) AS n FROM proveedor_productos WHERE activo = 1 GROUP BY proveedor").all().map((r) => [r.proveedor, r.n]));
    const cuentas = new Map(db.prepare("SELECT proveedor_nombre AS p, COUNT(*) AS n FROM usuarios WHERE tipo = 'proveedor' AND proveedor_nombre IS NOT NULL GROUP BY proveedor_nombre").all().map((r) => [r.p, r.n]));
    res.json(db.prepare("SELECT nombre, nit FROM proveedores ORDER BY nombre").all()
      .map((p) => ({ nombre: p.nombre, nit: p.nit || "", productos: productos.get(p.nombre) || 0, cuentas: cuentas.get(p.nombre) || 0 })));
  });

  app.get("/api/usuarios/bitacora", soloAdmin, (req, res) => {
    const limite = Math.min(500, Math.max(1, Number(req.query.limite) || 100));
    res.json(db.prepare("SELECT usuario, accion, detalle, ip, creado_en FROM bitacora ORDER BY id DESC LIMIT ?").all(limite));
  });

  app.post("/api/usuarios", soloAdmin, async (req, res) => {
    const b = req.body || {};
    const nombre = auth.limpiar(b.nombre, 120);
    const email = auth.normalizarEmail(b.email);
    const tipo = String(b.tipo || "").trim();
    const proveedor = auth.limpiar(b.proveedor_nombre, 160);
    const invitar = !!b.enviar_invitacion;
    const password = String(b.password || "");
    if (!auth.TIPOS.includes(tipo)) return res.status(400).json({ error: "Elige el tipo de usuario." });
    if (nombre.length < 2) return res.status(400).json({ error: "Escribe el nombre de la persona." });
    if (!auth.emailValido(email)) return res.status(400).json({ error: "Escribe un correo válido: será el usuario para entrar." });
    if (auth.existeIdentificador(email)) return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
    if (tipo === "proveedor" && !proveedorExiste(proveedor)) return res.status(400).json({ error: "Elige el proveedor al que pertenece este usuario." });
    if (!password && !invitar) return res.status(400).json({ error: "Escribe una contraseña inicial o marca «Enviar enlace por correo»." });
    if (password) {
      const error = auth.validarPassword(password, email);
      if (error) return res.status(400).json({ error });
    }

    // Con invitación y sin contraseña, la cuenta queda con una clave aleatoria que nadie conoce hasta que se use el enlace
    const { salt, hash } = auth.hashNuevo(password || crypto.randomBytes(24).toString("base64url"));
    const debeCambiar = password && b.debe_cambiar_password !== false ? 1 : 0;
    const info = db.prepare(`
      INSERT INTO usuarios (usuario, password_hash, password_salt, tipo, proveedor_nombre, creado_en, nombre, email, estado, debe_cambiar_password, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?)
    `).run(email, hash, salt, tipo, tipo === "proveedor" ? proveedor : null, ahora(), nombre, email, debeCambiar, ahora());
    const u = usuarioPorId(info.lastInsertRowid);
    auth.bitacora(req, "usuario_creado", tipo + " " + email);
    let correoEnviado = null;
    if (invitar) correoEnviado = (await auth.enviarEnlaceContrasena(u, "invitacion")).ok;
    res.json({ ok: true, usuario: publico(u), correoEnviado });
  });

  app.put("/api/usuarios/:id", soloAdmin, (req, res) => {
    const u = usuarioPorId(req.params.id);
    if (!u) return res.status(404).json({ error: "El usuario ya no existe." });
    const b = req.body || {};
    const esYo = u.id === req.usuarioActual.id;
    const nombre = b.nombre !== undefined ? auth.limpiar(b.nombre, 120) : u.nombre;
    const tipo = b.tipo !== undefined ? String(b.tipo).trim() : u.tipo;
    const estado = b.estado !== undefined ? String(b.estado).trim() : u.estado;
    let email = b.email !== undefined ? auth.normalizarEmail(b.email) : (u.email || "");
    let proveedor = b.proveedor_nombre !== undefined ? auth.limpiar(b.proveedor_nombre, 160) : (u.proveedor_nombre || "");

    if (!auth.TIPOS.includes(tipo)) return res.status(400).json({ error: "Tipo de usuario no válido." });
    if (estado !== u.estado && !ESTADOS_EDITABLES.includes(estado)) return res.status(400).json({ error: "Estado no válido." });
    if (esYo && (tipo !== u.tipo || estado !== u.estado)) return res.status(400).json({ error: "No puedes cambiar tu propio tipo ni desactivarte." });
    if (u.tipo === "admin" && u.estado === "activo" && (tipo !== "admin" || estado !== "activo") && adminsActivosSin(u.id) === 0) {
      return res.status(400).json({ error: "Debe quedar al menos un administrador activo." });
    }
    if (email && !auth.emailValido(email)) return res.status(400).json({ error: "Escribe un correo válido." });
    if (!email && u.email) return res.status(400).json({ error: "El correo no se puede dejar vacío." });
    if (email && auth.existeIdentificador(email, u.id)) return res.status(409).json({ error: "Ese correo ya lo usa otra cuenta." });
    if (tipo === "proveedor") {
      if (!proveedorExiste(proveedor) && estado === "activo") return res.status(400).json({ error: "Elige el proveedor al que pertenece este usuario." });
    } else proveedor = "";

    // Si el usuario para entrar era el correo, se mueve junto con el correo
    const usuario = email && u.email && u.usuario.toLowerCase() === u.email.toLowerCase() ? email : u.usuario;
    if (usuario !== u.usuario && auth.existeIdentificador(usuario, u.id)) return res.status(409).json({ error: "Ese correo ya lo usa otra cuenta." });
    db.prepare("UPDATE usuarios SET usuario = ?, nombre = ?, email = ?, tipo = ?, proveedor_nombre = ?, estado = ?, actualizado_en = ? WHERE id = ?")
      .run(usuario, nombre || null, email || null, tipo, proveedor || null, estado, ahora(), u.id);
    if (tipo !== u.tipo || estado !== u.estado || (proveedor || null) !== (u.proveedor_nombre || null)) auth.cerrarSesionesDe(u.id);
    auth.bitacora(req, "usuario_editado", u.usuario + (tipo !== u.tipo ? " tipo " + u.tipo + "→" + tipo : "") + (estado !== u.estado ? " estado " + u.estado + "→" + estado : ""));
    res.json({ ok: true, usuario: publico(usuarioPorId(u.id)) });
  });

  app.delete("/api/usuarios/:id", soloAdmin, (req, res) => {
    const u = usuarioPorId(req.params.id);
    if (!u) return res.status(404).json({ error: "El usuario ya no existe." });
    if (u.id === req.usuarioActual.id) return res.status(400).json({ error: "No puedes eliminar tu propio usuario." });
    if (u.tipo === "admin" && u.estado === "activo" && adminsActivosSin(u.id) === 0) return res.status(400).json({ error: "Debe quedar al menos un administrador activo." });
    db.prepare("DELETE FROM usuarios WHERE id = ?").run(u.id);
    auth.bitacora(req, "usuario_eliminado", u.tipo + " " + u.usuario);
    res.json({ ok: true });
  });

  app.post("/api/usuarios/:id/password", soloAdmin, (req, res) => {
    const u = usuarioPorId(req.params.id);
    if (!u) return res.status(404).json({ error: "El usuario ya no existe." });
    const password = String((req.body && req.body.password) || "");
    const error = auth.validarPassword(password, u.usuario);
    if (error) return res.status(400).json({ error });
    const debeCambiar = req.body && req.body.debe_cambiar_password === false ? 0 : 1;
    const { salt, hash } = auth.hashNuevo(password);
    db.prepare("UPDATE usuarios SET password_hash = ?, password_salt = ?, debe_cambiar_password = ?, intentos_fallidos = 0, bloqueado_hasta = NULL, actualizado_en = ? WHERE id = ?")
      .run(hash, salt, u.id === req.usuarioActual.id ? 0 : debeCambiar, ahora(), u.id);
    if (u.id !== req.usuarioActual.id) auth.cerrarSesionesDe(u.id);
    auth.bitacora(req, "password_asignada", u.usuario + (debeCambiar ? " (temporal)" : ""));
    res.json({ ok: true });
  });

  // Envía al correo del usuario un enlace para que él mismo defina su contraseña
  app.post("/api/usuarios/:id/enlace", soloAdmin, async (req, res) => {
    const u = usuarioPorId(req.params.id);
    if (!u) return res.status(404).json({ error: "El usuario ya no existe." });
    if (!u.email) return res.status(400).json({ error: "Este usuario no tiene correo. Agrégalo primero." });
    if (u.estado !== "activo") return res.status(400).json({ error: "Activa la cuenta antes de enviarle el enlace." });
    const r = await auth.enviarEnlaceContrasena(u, "invitacion");
    auth.bitacora(req, "enlace_enviado", u.usuario);
    res.json({ ok: true, correoEnviado: r.ok, motivo: r.motivo || null });
  });

  app.post("/api/usuarios/:id/desbloquear", soloAdmin, (req, res) => {
    const u = usuarioPorId(req.params.id);
    if (!u) return res.status(404).json({ error: "El usuario ya no existe." });
    db.prepare("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?").run(u.id);
    auth.bitacora(req, "usuario_desbloqueado", u.usuario);
    res.json({ ok: true });
  });

  // Aprobar un proveedor que se registró solo: se vincula a un proveedor ya parametrizado o se crea uno nuevo
  app.post("/api/usuarios/:id/aprobar", soloAdmin, (req, res) => {
    const u = usuarioPorId(req.params.id);
    if (!u) return res.status(404).json({ error: "El usuario ya no existe." });
    if (u.tipo !== "proveedor") return res.status(400).json({ error: "Solo se aprueban cuentas de proveedor." });
    const b = req.body || {};
    const registro = leerJSON(u.datos_registro) || {};
    let nombre = auth.limpiar(b.proveedor_nombre, 160);
    if (b.crear_proveedor) {
      nombre = nombre.toUpperCase();
      if (nombre.length < 3) return res.status(400).json({ error: "Escribe el nombre del proveedor nuevo." });
      if (proveedorExiste(nombre)) return res.status(409).json({ error: "Ya existe un proveedor con ese nombre: elígelo de la lista." });
      db.prepare("INSERT INTO proveedores (nombre, creado_en, nit) VALUES (?, ?, ?)").run(nombre, ahora(), registro.nit || null);
    } else if (!proveedorExiste(nombre)) {
      return res.status(400).json({ error: "Elige el proveedor al que pertenece esta cuenta." });
    }
    if (registro.nit) db.prepare("UPDATE proveedores SET nit = ? WHERE nombre = ? AND (nit IS NULL OR nit = '')").run(registro.nit, nombre);
    db.prepare("UPDATE usuarios SET proveedor_nombre = ?, estado = 'activo', actualizado_en = ? WHERE id = ?").run(nombre, ahora(), u.id);
    auth.bitacora(req, "proveedor_aprobado", u.usuario + " → " + nombre);
    const actualizado = usuarioPorId(u.id);
    avisarAprobacion(actualizado);
    const productos = db.prepare("SELECT COUNT(*) AS n FROM proveedor_productos WHERE proveedor = ? AND activo = 1").get(nombre).n;
    res.json({ ok: true, usuario: publico(actualizado), productos });
  });

  app.post("/api/usuarios/:id/rechazar", soloAdmin, (req, res) => {
    const u = usuarioPorId(req.params.id);
    if (!u) return res.status(404).json({ error: "El usuario ya no existe." });
    if (u.estado !== "pendiente") return res.status(400).json({ error: "Solo se rechazan registros pendientes." });
    const motivo = auth.limpiar(req.body && req.body.motivo, 300);
    db.prepare("UPDATE usuarios SET estado = 'rechazado', actualizado_en = ? WHERE id = ?").run(ahora(), u.id);
    auth.bitacora(req, "proveedor_rechazado", u.usuario + (motivo ? ": " + motivo : ""));
    if (u.email) {
      correo.enviar({
        para: u.email,
        asunto: "Tu registro en el portal de proveedores de Mercaldas",
        titulo: "Registro no aprobado",
        parrafos: ["Hola " + (u.nombre || u.usuario) + ".", "Mercaldas no aprobó por ahora tu solicitud de acceso al portal de proveedores.",
          motivo ? "Motivo: " + motivo : "", "Si crees que es un error, comunícate con el área de compras de Mercaldas."].filter(Boolean),
      });
    }
    res.json({ ok: true });
  });
};
