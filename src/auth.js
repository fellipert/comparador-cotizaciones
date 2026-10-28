"use strict";
// Inicio de sesión, recuperación de contraseña por correo, registro de proveedores y permisos por rol.
// Roles: admin (todo el sistema), planeacion (demanda, distribución, órdenes de compra y resumen de subasta)
// y proveedor (portal: subastas y contrapropuestas de sus productos).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const correo = require("./correo");
const notificaciones = require("./notificaciones");

const SESION_DIAS = 7;
const COOKIE_NAME = process.env.COOKIE_NAME || "sesion_token";
const MAX_INTENTOS = 5;
const BLOQUEO_MINUTOS = 15;
const RECUPERACION_MINUTOS = 60;
const INVITACION_HORAS = 48;

const TIPOS = ["admin", "planeacion", "proveedor"];
const NOMBRE_TIPO = { admin: "Administrador", planeacion: "Planeación de la demanda", proveedor: "Proveedor" };
const PUBLICO = path.join(__dirname, "..", "public");

const ahora = () => new Date().toISOString();
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const normalizarEmail = (v) => String(v == null ? "" : v).trim().toLowerCase();
const emailValido = (v) => v.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const limpiar = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

// ---------- Contraseñas ----------
function validarPassword(password, usuario) {
  const s = String(password == null ? "" : password);
  if (s.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (s.length > 128) return "La contraseña no puede tener más de 128 caracteres.";
  if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(s) || !/[0-9]/.test(s)) return "La contraseña debe combinar letras y números.";
  if (usuario && s.toLowerCase() === String(usuario).toLowerCase()) return "La contraseña no puede ser igual al usuario.";
  return null;
}

function hashNuevo(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: db.hashPassword(String(password), salt) };
}

function passwordCorrecta(fila, password) {
  const a = Buffer.from(db.hashPassword(String(password), fila.password_salt), "hex");
  const b = Buffer.from(String(fila.password_hash || ""), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Para que un usuario inexistente tarde lo mismo que una contraseña equivocada
const SAL_FALSA = crypto.randomBytes(16).toString("hex");

// ---------- Límite de intentos por IP (en memoria; el servidor corre en un solo proceso) ----------
const ventanas = new Map();
function limitar(clave, maximo, minutos) {
  const t = Date.now(), lapso = minutos * 60000;
  const lista = (ventanas.get(clave) || []).filter((x) => t - x < lapso);
  const permitido = lista.length < maximo;
  if (permitido) lista.push(t);
  ventanas.set(clave, lista);
  return permitido;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, lista] of ventanas) if (!lista.some((x) => t - x < 3600000)) ventanas.delete(k);
}, 10 * 60000).unref();

// ---------- Bitácora de seguridad ----------
function bitacora(req, accion, detalle, usuario) {
  try {
    const quien = usuario !== undefined ? usuario : req && req.usuarioActual ? req.usuarioActual.usuario : null;
    db.prepare("INSERT INTO bitacora (usuario, accion, detalle, ip, creado_en) VALUES (?, ?, ?, ?, ?)")
      .run(quien, accion, detalle ? String(detalle).slice(0, 500) : null, req ? req.ip : null, ahora());
  } catch (e) {
    console.error("[bitacora]", e.message);
  }
}

// ---------- Usuarios ----------
function buscarPorIdentificador(ident) {
  const v = String(ident || "").trim().toLowerCase();
  if (!v) return null;
  return db.prepare(`
    SELECT * FROM usuarios
    WHERE LOWER(usuario) = ? OR LOWER(email) = ?
    ORDER BY CASE WHEN LOWER(usuario) = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(v, v, v) || null;
}

// ¿El correo o usuario ya lo usa otra cuenta? (se compara contra usuario y correo de todas)
function existeIdentificador(valor, excluirId) {
  const v = String(valor || "").trim().toLowerCase();
  if (!v) return false;
  return !!db.prepare("SELECT 1 FROM usuarios WHERE (LOWER(usuario) = ? OR LOWER(email) = ?) AND id <> ?").get(v, v, Number(excluirId) || 0);
}

function destinoDe(u) {
  if (u.debe_cambiar_password) return "/login.html?cambiar=1";
  return u.tipo === "proveedor" ? "/proveedor.html" : "/index.html";
}

function perfil(u) {
  return {
    usuario: u.usuario,
    nombre: u.nombre || u.usuario,
    email: u.email || null,
    tipo: u.tipo,
    tipoNombre: NOMBRE_TIPO[u.tipo] || u.tipo,
    proveedorNombre: u.proveedor_nombre || null,
    debeCambiarPassword: !!u.debe_cambiar_password,
    destino: destinoDe(u),
  };
}

// ---------- Sesiones ----------
function opcionesCookie(req) {
  return { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.COOKIE_SECURE === "1" || !!req.secure, maxAge: SESION_DIAS * 86400000 };
}

function crearSesion(req, res, usuarioId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sesiones (token, usuario_id, expira_en, creado_en) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), usuarioId, new Date(Date.now() + SESION_DIAS * 86400000).toISOString(), ahora());
  res.cookie(COOKIE_NAME, token, opcionesCookie(req));
}

function buscarSesion(req) {
  if (Object.prototype.hasOwnProperty.call(req, "_sesion")) return req._sesion;
  let fila = null;
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    const f = db.prepare(`
      SELECT u.id, u.usuario, u.nombre, u.email, u.tipo, u.proveedor_nombre, u.estado, u.debe_cambiar_password,
             s.expira_en, s.token AS token_hash
      FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = ?
    `).get(hashToken(token));
    if (f) {
      const vencida = new Date(f.expira_en) < new Date();
      const sinAcceso = f.estado !== "activo" || (f.tipo === "proveedor" && !f.proveedor_nombre);
      if (vencida || sinAcceso) db.prepare("DELETE FROM sesiones WHERE token = ?").run(f.token_hash);
      else fila = f;
    }
  }
  req._sesion = fila;
  return fila;
}

function cerrarSesionesDe(usuarioId, exceptoTokenHash) {
  if (exceptoTokenHash) db.prepare("DELETE FROM sesiones WHERE usuario_id = ? AND token <> ?").run(usuarioId, exceptoTokenHash);
  else db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(usuarioId);
}

// ---------- Middlewares ----------
function rechazar(res, u) {
  if (!u) return res.status(401).json({ error: "Tu sesión terminó. Inicia sesión de nuevo." });
  if (u.debe_cambiar_password) return res.status(403).json({ error: "Debes cambiar tu contraseña antes de continuar.", codigo: "DEBE_CAMBIAR_PASSWORD" });
  return res.status(403).json({ error: "Tu usuario no tiene permiso para esta acción.", codigo: "SIN_PERMISO" });
}

function requireRol(...tipos) {
  return function (req, res, next) {
    const u = buscarSesion(req);
    if (!u || u.debe_cambiar_password || (tipos.length && !tipos.includes(u.tipo))) return rechazar(res, u);
    req.usuarioActual = u;
    next();
  };
}

const requireSesion = requireRol();
const requireAdmin = requireRol("admin");
const requireProveedor = requireRol("proveedor");

// Guardián de todo /api interno: el admin pasa siempre; Planeación solo a las rutas de su lista.
function requireInterno(permisosPlaneacion) {
  return function (req, res, next) {
    const u = buscarSesion(req);
    if (!u || u.debe_cambiar_password) return rechazar(res, u);
    const ruta = (req.baseUrl || "") + req.path;
    const metodo = req.method === "HEAD" ? "GET" : req.method;
    const permitido = u.tipo === "admin" ||
      (u.tipo === "planeacion" && permisosPlaneacion.some(([m, re]) => m === metodo && re.test(ruta)));
    if (!permitido) return rechazar(res, u);
    req.usuarioActual = u;
    next();
  };
}

function cabecerasSeguridad(req, res, next) {
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "same-origin" });
  next();
}

// ---------- Enlaces para crear o recuperar la contraseña ----------
function tokenValido(token) {
  const t = String(token || "");
  if (!t || t.length > 200) return null;
  const f = db.prepare(`
    SELECT t.id, t.usuario_id, t.proposito, t.expira_en, t.usado_en, u.usuario, u.nombre, u.email, u.estado
    FROM tokens_recuperacion t JOIN usuarios u ON u.id = t.usuario_id
    WHERE t.token_hash = ?
  `).get(hashToken(t));
  if (!f || f.usado_en || new Date(f.expira_en) < new Date() || f.estado !== "activo") return null;
  return f;
}

// proposito: "recuperar" (olvidó la contraseña) o "invitacion" (el admin le crea la cuenta y él define su contraseña)
function enviarEnlaceContrasena(fila, proposito) {
  const token = crypto.randomBytes(32).toString("base64url");
  const minutos = proposito === "invitacion" ? INVITACION_HORAS * 60 : RECUPERACION_MINUTOS;
  db.transaction(() => {
    db.prepare("UPDATE tokens_recuperacion SET usado_en = ? WHERE usuario_id = ? AND usado_en IS NULL").run(ahora(), fila.id);
    db.prepare("INSERT INTO tokens_recuperacion (usuario_id, token_hash, proposito, expira_en, creado_en) VALUES (?, ?, ?, ?, ?)")
      .run(fila.id, hashToken(token), proposito, new Date(Date.now() + minutos * 60000).toISOString(), ahora());
  })();
  const ruta = "/login.html?token=" + encodeURIComponent(token);
  const url = correo.urlApp(ruta);
  if (!url) console.warn("[auth] APP_URL no está configurada: el enlace del correo queda incompleto (" + ruta + ").");
  const nombre = fila.nombre || fila.usuario;
  const invitacion = proposito === "invitacion";
  return correo.enviar({
    para: fila.email,
    asunto: invitacion ? "Tu acceso al comparador de cotizaciones de Mercaldas" : "Restablece tu contraseña · Mercaldas",
    titulo: invitacion ? "Define tu contraseña" : "Restablecer contraseña",
    parrafos: invitacion
      ? ["Hola " + nombre + ".", "Mercaldas creó tu acceso al comparador de cotizaciones. Tu usuario es: " + fila.usuario + ".",
         "Usa el botón para definir tu contraseña. El enlace vence en " + INVITACION_HORAS + " horas y solo sirve una vez."]
      : ["Hola " + nombre + ".", "Recibimos una solicitud para restablecer la contraseña de tu cuenta (" + fila.usuario + ").",
         "Usa el botón para crear una contraseña nueva. El enlace vence en " + minutos + " minutos y solo sirve una vez.",
         "Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue funcionando."],
    boton: { texto: invitacion ? "Definir mi contraseña" : "Crear contraseña nueva", url: url || ruta },
  });
}

function avisarCambioPassword(fila) {
  if (!fila.email) return;
  correo.enviar({
    para: fila.email,
    asunto: "Tu contraseña fue cambiada · Mercaldas",
    titulo: "Contraseña actualizada",
    parrafos: ["Hola " + (fila.nombre || fila.usuario) + ".", "La contraseña de tu cuenta (" + fila.usuario + ") se cambió el " +
      new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" }) + ".",
      "Si no fuiste tú, recupera tu contraseña de inmediato y avisa al administrador de Mercaldas."],
    boton: { texto: "Ir al comparador", url: correo.urlApp("/login.html") },
  });
}

// ---------- Páginas protegidas ----------
function enviarPagina(res, archivo, u) {
  let html = fs.readFileSync(path.join(PUBLICO, archivo), "utf8");
  if (u) {
    const datos = JSON.stringify(perfil(u)).replace(/</g, "\\u003c");
    html = html
      .replace("<body>", '<body class="rol-' + u.tipo + '">')
      .replace('<script src="/entorno.js"></script>', "<script>window.__USUARIO = " + datos + ';</script><script src="/entorno.js"></script>');
  }
  res.set("Cache-Control", "no-store").type("html").send(html);
}

function registrarPaginas(app) {
  app.get(["/", "/index.html"], (req, res) => {
    const u = buscarSesion(req);
    if (!u) return res.redirect("/login.html");
    if (u.tipo === "proveedor" || u.debe_cambiar_password) return res.redirect(destinoDe(u));
    enviarPagina(res, "index.html", u);
  });

  app.get("/proveedor.html", (req, res) => {
    const u = buscarSesion(req);
    if (!u) return res.redirect("/login.html");
    if (u.tipo !== "proveedor" || u.debe_cambiar_password) return res.redirect(destinoDe(u));
    enviarPagina(res, "proveedor.html", u);
  });

  app.get("/login.html", (req, res) => {
    const u = buscarSesion(req);
    if (u && !u.debe_cambiar_password && !req.query.token) return res.redirect(destinoDe(u));
    enviarPagina(res, "login.html", null);
  });
}

// ---------- Rutas /api/auth ----------
function registrarRutas(app) {
  app.post("/api/auth/login", (req, res) => {
    const ident = limpiar(req.body && (req.body.usuario || req.body.correo), 160);
    const password = String((req.body && req.body.password) || "");
    if (!ident || !password) return res.status(400).json({ error: "Escribe tu usuario (o correo) y tu contraseña." });
    if (!limitar("login-ip:" + req.ip, 30, 15) || !limitar("login:" + req.ip + ":" + ident.toLowerCase(), 10, 15)) {
      return res.status(429).json({ error: "Demasiados intentos desde este equipo. Espera unos minutos e inténtalo de nuevo." });
    }

    const fila = buscarPorIdentificador(ident);
    if (!fila) {
      db.hashPassword(password, SAL_FALSA);
      bitacora(req, "login_fallido", "Usuario inexistente: " + ident.slice(0, 80), null);
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }
    if (fila.bloqueado_hasta && new Date(fila.bloqueado_hasta) > new Date()) {
      const min = Math.max(1, Math.ceil((new Date(fila.bloqueado_hasta) - Date.now()) / 60000));
      return res.status(423).json({ error: "Tu cuenta está bloqueada por varios intentos fallidos. Intenta de nuevo en " + min + " minuto(s) o recupera tu contraseña.", codigo: "BLOQUEADA" });
    }
    if (!passwordCorrecta(fila, password)) {
      const intentos = Number(fila.intentos_fallidos || 0) + 1;
      if (intentos >= MAX_INTENTOS) {
        db.prepare("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = ? WHERE id = ?")
          .run(new Date(Date.now() + BLOQUEO_MINUTOS * 60000).toISOString(), fila.id);
        bitacora(req, "cuenta_bloqueada", MAX_INTENTOS + " intentos fallidos", fila.usuario);
        return res.status(423).json({ error: "Tu cuenta quedó bloqueada " + BLOQUEO_MINUTOS + " minutos por intentos fallidos. Puedes esperar o recuperar tu contraseña.", codigo: "BLOQUEADA" });
      }
      db.prepare("UPDATE usuarios SET intentos_fallidos = ? WHERE id = ?").run(intentos, fila.id);
      bitacora(req, "login_fallido", "Contraseña incorrecta", fila.usuario);
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    // Contraseña correcta: solo ahora se dice por qué no puede entrar (así no se revela qué cuentas existen)
    if (fila.estado === "pendiente" || (fila.tipo === "proveedor" && !fila.proveedor_nombre && fila.estado === "activo")) {
      return res.status(403).json({ error: "Tu cuenta todavía está pendiente de aprobación por Mercaldas. Te avisaremos por correo cuando quede activa.", codigo: "PENDIENTE" });
    }
    if (fila.estado !== "activo") {
      return res.status(403).json({ error: "Tu cuenta está desactivada. Comunícate con Mercaldas.", codigo: "INACTIVA" });
    }

    db.prepare("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?").run(ahora(), fila.id);
    crearSesion(req, res, fila.id);
    bitacora(req, "login", null, fila.usuario);
    res.json({ ok: true, ...perfil(fila) });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (token) db.prepare("DELETE FROM sesiones WHERE token = ?").run(hashToken(token));
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const u = buscarSesion(req);
    if (!u) return res.status(401).json({ error: "No hay sesión activa." });
    res.json(perfil(u));
  });

  // Cambiar la contraseña estando dentro (también la usa quien debe cambiar una contraseña temporal)
  app.post("/api/auth/cambiar-password", (req, res) => {
    const u = buscarSesion(req);
    if (!u) return rechazar(res, null);
    if (!limitar("cambiar:" + u.id, 10, 15)) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    const actual = String((req.body && req.body.actual) || "");
    const nueva = String((req.body && req.body.nueva) || "");
    const fila = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(u.id);
    if (!passwordCorrecta(fila, actual)) {
      bitacora(req, "cambio_password_fallido", "Contraseña actual incorrecta", fila.usuario);
      return res.status(400).json({ error: "La contraseña actual no es correcta." });
    }
    const error = validarPassword(nueva, fila.usuario);
    if (error) return res.status(400).json({ error });
    if (passwordCorrecta(fila, nueva)) return res.status(400).json({ error: "La nueva contraseña debe ser distinta de la actual." });

    const { salt, hash } = hashNuevo(nueva);
    db.transaction(() => {
      db.prepare("UPDATE usuarios SET password_hash = ?, password_salt = ?, debe_cambiar_password = 0, actualizado_en = ? WHERE id = ?").run(hash, salt, ahora(), fila.id);
      cerrarSesionesDe(fila.id, u.token_hash);
    })();
    bitacora(req, "cambio_password", null, fila.usuario);
    avisarCambioPassword(fila);
    res.json({ ok: true, destino: destinoDe({ ...fila, debe_cambiar_password: 0 }) });
  });

  // Paso 1 de la recuperación: siempre responde lo mismo, exista o no la cuenta
  app.post("/api/auth/recuperar", (req, res) => {
    const ident = limpiar(req.body && (req.body.correo || req.body.usuario), 160);
    if (!ident) return res.status(400).json({ error: "Escribe tu correo o tu usuario." });
    if (!limitar("recuperar-ip:" + req.ip, 8, 15)) return res.status(429).json({ error: "Demasiadas solicitudes. Espera unos minutos." });
    const fila = buscarPorIdentificador(ident);
    if (fila && fila.estado === "activo") {
      if (!fila.email) bitacora(req, "recuperacion_sin_correo", "La cuenta no tiene correo registrado", fila.usuario);
      else if (limitar("recuperar-usuario:" + fila.id, 3, 60)) {
        bitacora(req, "recuperacion_solicitada", null, fila.usuario);
        enviarEnlaceContrasena(fila, "recuperar");
      }
    }
    res.json({
      ok: true,
      mensaje: "Si los datos corresponden a una cuenta activa con correo registrado, en unos minutos recibirás un enlace para crear una contraseña nueva. Revisa también la carpeta de correo no deseado.",
    });
  });

  // Paso 2: el enlace del correo abre login.html?token=..., que primero pregunta si el enlace sirve
  app.get("/api/auth/restablecer", (req, res) => {
    if (!limitar("restablecer-ip:" + req.ip, 30, 15)) return res.status(429).json({ error: "Demasiadas solicitudes. Espera unos minutos." });
    const f = tokenValido(req.query.token);
    if (!f) return res.status(400).json({ error: "El enlace no es válido, ya se usó o venció. Solicita uno nuevo." });
    res.json({ ok: true, usuario: f.usuario, nombre: f.nombre || f.usuario, proposito: f.proposito });
  });

  app.post("/api/auth/restablecer", (req, res) => {
    if (!limitar("restablecer-ip:" + req.ip, 30, 15)) return res.status(429).json({ error: "Demasiadas solicitudes. Espera unos minutos." });
    const f = tokenValido(req.body && req.body.token);
    if (!f) return res.status(400).json({ error: "El enlace no es válido, ya se usó o venció. Solicita uno nuevo." });
    const nueva = String((req.body && req.body.nueva) || "");
    const error = validarPassword(nueva, f.usuario);
    if (error) return res.status(400).json({ error });
    const { salt, hash } = hashNuevo(nueva);
    db.transaction(() => {
      db.prepare("UPDATE usuarios SET password_hash = ?, password_salt = ?, debe_cambiar_password = 0, intentos_fallidos = 0, bloqueado_hasta = NULL, actualizado_en = ? WHERE id = ?")
        .run(hash, salt, ahora(), f.usuario_id);
      db.prepare("UPDATE tokens_recuperacion SET usado_en = ? WHERE id = ?").run(ahora(), f.id);
      cerrarSesionesDe(f.usuario_id);
    })();
    bitacora(req, f.proposito === "invitacion" ? "password_definida" : "password_restablecida", null, f.usuario);
    avisarCambioPassword(db.prepare("SELECT * FROM usuarios WHERE id = ?").get(f.usuario_id));
    res.json({ ok: true });
  });

  // Registro de un proveedor nuevo: queda pendiente hasta que el admin lo apruebe y lo vincule a un proveedor
  app.post("/api/auth/registro", (req, res) => {
    if (!limitar("registro-ip:" + req.ip, 5, 60)) return res.status(429).json({ error: "Demasiados registros desde este equipo. Intenta más tarde." });
    const b = req.body || {};
    const empresa = limpiar(b.empresa, 120);
    const nit = limpiar(b.nit, 30);
    const contacto = limpiar(b.contacto, 120);
    const telefono = limpiar(b.telefono, 40);
    const email = normalizarEmail(b.correo);
    const password = String(b.password || "");
    if (empresa.length < 3) return res.status(400).json({ error: "Escribe el nombre del proveedor (razón social)." });
    if (!emailValido(email)) return res.status(400).json({ error: "Escribe un correo electrónico válido." });
    const error = validarPassword(password, email);
    if (error) return res.status(400).json({ error });
    if (existeIdentificador(email)) {
      return res.status(409).json({ error: "Ya existe una cuenta con ese correo. Si olvidaste la contraseña, usa «¿Olvidaste tu contraseña?»." });
    }

    const { salt, hash } = hashNuevo(password);
    try {
      db.prepare(`
        INSERT INTO usuarios (usuario, password_hash, password_salt, tipo, proveedor_nombre, creado_en, nombre, email, estado, datos_registro, actualizado_en)
        VALUES (?, ?, ?, 'proveedor', NULL, ?, ?, ?, 'pendiente', ?, ?)
      `).run(email, hash, salt, ahora(), contacto || empresa, email, JSON.stringify({ empresa, nit, contacto, telefono }), ahora());
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
      throw e;
    }
    bitacora(req, "registro_proveedor", empresa + " <" + email + ">", email);

    const admins = notificaciones.paraTipo("admin", {
      tipo: "registro",
      titulo: "Proveedor por aprobar: " + empresa,
      mensaje: email + (nit ? " · NIT " + nit : "") + (telefono ? " · Tel. " + telefono : ""),
      enlace: "usuarios",
    });
    correo.enviar({
      para: admins.map((a) => a.email).filter(Boolean),
      asunto: "Nuevo registro de proveedor por aprobar: " + empresa,
      titulo: "Un proveedor se registró en el portal",
      parrafos: ["Empresa: " + empresa, "Correo: " + email, nit ? "NIT: " + nit : "", contacto ? "Contacto: " + contacto : "", telefono ? "Teléfono: " + telefono : "",
        "Apruébalo en la pestaña Usuarios y vincúlalo al proveedor que corresponde, para que vea sus productos."].filter(Boolean),
      boton: { texto: "Revisar en el comparador", url: correo.urlApp("/index.html") },
    });
    correo.enviar({
      para: email,
      asunto: "Recibimos tu registro en el portal de proveedores de Mercaldas",
      titulo: "Registro recibido",
      parrafos: ["Hola " + (contacto || empresa) + ".", "Recibimos la solicitud de acceso de " + empresa + " al portal de proveedores de Mercaldas.",
        "Mercaldas revisará tus datos y te avisaremos a este correo cuando tu cuenta quede activa."],
    });
    res.json({ ok: true, mensaje: "Tu registro quedó pendiente de aprobación. Te avisaremos por correo cuando Mercaldas active tu cuenta." });
  });
}

// ---------- Limpieza de sesiones y enlaces vencidos ----------
function limpiarVencidos() {
  try {
    db.prepare("DELETE FROM sesiones WHERE expira_en < ?").run(ahora());
    db.prepare("DELETE FROM tokens_recuperacion WHERE expira_en < ?").run(new Date(Date.now() - 7 * 86400000).toISOString());
  } catch (e) {
    console.error("[auth] limpieza:", e.message);
  }
}
limpiarVencidos();
setInterval(limpiarVencidos, 6 * 3600000).unref();

module.exports = {
  registrarRutas, registrarPaginas, cabecerasSeguridad,
  requireRol, requireSesion, requireAdmin, requireProveedor, requireInterno,
  getUsuarioDeSesion: buscarSesion,
  validarPassword, hashNuevo, normalizarEmail, emailValido, existeIdentificador, cerrarSesionesDe,
  enviarEnlaceContrasena, bitacora, limpiar, TIPOS, NOMBRE_TIPO,
};
