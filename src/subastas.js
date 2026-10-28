"use strict";
// Subastas (solicitudes de cotización): el admin pide a los proveedores los productos que necesita en una semana.
// A cada proveedor solo le llegan los productos que tiene parametrizados (proveedor_productos activo).
// Las ofertas que envían desde el portal quedan en "quotes", así el comparativo y la negociación siguen igual.
const db = require("./db");
const auth = require("./auth");
const correo = require("./correo");
const notificaciones = require("./notificaciones");

db.exec(`
  CREATE TABLE IF NOT EXISTS subastas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ciclo_id TEXT NOT NULL,
    titulo TEXT NOT NULL,
    observacion TEXT,
    fecha_limite TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'borrador',
    creado_por TEXT,
    creado_en TEXT NOT NULL,
    enviado_en TEXT,
    cerrado_en TEXT,
    actualizado_en TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_subastas_ciclo ON subastas(ciclo_id);

  CREATE TABLE IF NOT EXISTS subasta_productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subasta_id INTEGER NOT NULL,
    codigo TEXT NOT NULL,
    producto TEXT,
    presentacion TEXT,
    cantidad_estimada REAL,
    observacion TEXT,
    UNIQUE(subasta_id, codigo),
    FOREIGN KEY (subasta_id) REFERENCES subastas(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subasta_proveedores (
    subasta_id INTEGER NOT NULL,
    proveedor TEXT NOT NULL,
    productos_invitados INTEGER NOT NULL DEFAULT 0,
    notificado_en TEXT,
    visto_en TEXT,
    respondido_en TEXT,
    PRIMARY KEY (subasta_id, proveedor),
    FOREIGN KEY (subasta_id) REFERENCES subastas(id) ON DELETE CASCADE
  );
`);

const ahora = () => new Date().toISOString();
const ESTADOS_VISIBLES = ["abierta", "cerrada"];

// La fecha límite llega como hora de Bogotá ("2026-10-23T17:00") y se guarda en UTC
function leerFechaLimite(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return null;
  const d = new Date(s + ":00-05:00");
  return isNaN(d) ? null : d.toISOString();
}

function fechaBogota(iso) {
  return new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
}

function estadoEfectivo(s) {
  if (s.estado === "abierta" && new Date(s.fecha_limite) < new Date()) return "vencida";
  return s.estado;
}

function subastaPorId(id) {
  return db.prepare("SELECT * FROM subastas WHERE id = ?").get(Number(id)) || null;
}

function productosDe(subastaId) {
  return db.prepare("SELECT codigo, producto, presentacion, cantidad_estimada, observacion FROM subasta_productos WHERE subasta_id = ? ORDER BY producto COLLATE NOCASE, codigo").all(subastaId);
}

// codigo -> [proveedores con el producto activo]
function proveedoresPorCodigo() {
  const mapa = new Map();
  db.prepare("SELECT proveedor, codigo FROM proveedor_productos WHERE activo = 1").all().forEach((r) => {
    const c = String(r.codigo);
    if (!mapa.has(c)) mapa.set(c, []);
    mapa.get(c).push(r.proveedor);
  });
  return mapa;
}

// codigo -> Set(proveedores que ofertaron) en la semana
function ofertasDelCiclo(cicloId) {
  const mapa = new Map();
  db.prepare("SELECT DISTINCT codigo, proveedor FROM quotes WHERE ciclo_id = ?").all(cicloId).forEach((r) => {
    const c = String(r.codigo);
    if (!mapa.has(c)) mapa.set(c, new Set());
    mapa.get(c).add(r.proveedor);
  });
  return mapa;
}

function proveedoresConCuenta() {
  return new Set(db.prepare("SELECT proveedor_nombre FROM usuarios WHERE tipo = 'proveedor' AND estado = 'activo' AND proveedor_nombre IS NOT NULL").all()
    .map((r) => notificaciones.clave(r.proveedor_nombre)));
}

// Invitados de una subasta: proveedor -> códigos de la subasta que suministra
function invitados(productos, porCodigo) {
  const mapa = new Map();
  productos.forEach((p) => (porCodigo.get(String(p.codigo)) || []).forEach((prov) => {
    if (!mapa.has(prov)) mapa.set(prov, []);
    mapa.get(prov).push(String(p.codigo));
  }));
  return mapa;
}

function validarProductos(lista) {
  if (!Array.isArray(lista) || !lista.length) return { error: "Agrega al menos un producto a la solicitud." };
  const vistos = new Set(), filas = [];
  const cat = db.prepare("SELECT codigo, producto, presentacion FROM catalogo WHERE codigo = ?");
  for (const it of lista) {
    const codigo = String((it && it.codigo) || "").trim();
    if (!codigo || vistos.has(codigo)) continue;
    vistos.add(codigo);
    const c = cat.get(codigo);
    if (!c) return { error: "El PLU " + codigo + " no está en el catálogo." };
    let cantidad = null;
    if (it.cantidad_estimada !== undefined && it.cantidad_estimada !== null && String(it.cantidad_estimada).trim() !== "") {
      cantidad = Number(it.cantidad_estimada);
      if (!Number.isFinite(cantidad) || cantidad < 0) return { error: "La cantidad estimada de " + c.producto + " no es válida." };
    }
    filas.push({ codigo, producto: c.producto || "", presentacion: c.presentacion || "", cantidad_estimada: cantidad, observacion: auth.limpiar(it.observacion, 200) || null });
  }
  if (!filas.length) return { error: "Agrega al menos un producto a la solicitud." };
  return { filas };
}

function guardarProductos(subastaId, filas) {
  db.prepare("DELETE FROM subasta_productos WHERE subasta_id = ?").run(subastaId);
  const ins = db.prepare("INSERT INTO subasta_productos (subasta_id, codigo, producto, presentacion, cantidad_estimada, observacion) VALUES (?, ?, ?, ?, ?, ?)");
  filas.forEach((f) => ins.run(subastaId, f.codigo, f.producto, f.presentacion, f.cantidad_estimada, f.observacion));
}

function resumenSubasta(s, porCodigo, conCuenta) {
  const productos = productosDe(s.id);
  const inv = invitados(productos, porCodigo);
  const respondieron = db.prepare("SELECT COUNT(*) AS n FROM subasta_proveedores WHERE subasta_id = ? AND respondido_en IS NOT NULL").get(s.id).n;
  return {
    id: s.id, ciclo_id: s.ciclo_id, titulo: s.titulo, observacion: s.observacion, fecha_limite: s.fecha_limite,
    estado: s.estado, estado_efectivo: estadoEfectivo(s), creado_en: s.creado_en, enviado_en: s.enviado_en, cerrado_en: s.cerrado_en,
    productos: productos.length,
    productos_sin_proveedor: productos.filter((p) => !(porCodigo.get(String(p.codigo)) || []).length).length,
    proveedores: inv.size,
    proveedores_sin_cuenta: [...inv.keys()].filter((p) => !conCuenta.has(notificaciones.clave(p))).length,
    respondieron,
  };
}

// Estado de la negociación de cada PLU en la semana (sin decir de qué proveedor)
function negociacionPorCodigo(cicloId) {
  const mapa = new Map();
  try {
    db.prepare(`
      SELECT p.codigo, p.estado FROM negociacion_unificada_productos p
      JOIN negociaciones_unificadas n ON n.id = p.negociacion_id WHERE n.ciclo_id = ?
    `).all(cicloId).forEach((r) => {
      const c = String(r.codigo);
      if (!mapa.has(c)) mapa.set(c, { acuerdo: 0, sin_acuerdo: 0, abierto: 0 });
      const g = mapa.get(c);
      if (r.estado === "acuerdo") g.acuerdo++; else if (r.estado === "sin_acuerdo") g.sin_acuerdo++; else g.abierto++;
    });
  } catch (e) { /* sin tablas de negociación */ }
  return mapa;
}

function avisarProveedores(s, inv, conCuenta) {
  const limite = fechaBogota(s.fecha_limite);
  let usuariosAvisados = 0;
  for (const [proveedor, codigos] of inv) {
    if (!conCuenta.has(notificaciones.clave(proveedor))) continue;
    const usuarios = notificaciones.paraProveedor(proveedor, {
      tipo: "subasta",
      titulo: "Nueva solicitud de cotización: " + codigos.length + " producto" + (codigos.length === 1 ? "" : "s"),
      mensaje: s.titulo + " · Semana " + s.ciclo_id + " · Envía tu propuesta antes del " + limite + ".",
      enlace: "subastas",
    });
    usuariosAvisados += usuarios.length;
    correo.enviar({
      para: usuarios.map((u) => u.email).filter(Boolean),
      asunto: "Mercaldas solicita tu cotización · " + s.ciclo_id,
      titulo: "Nueva solicitud de cotización",
      parrafos: ["Hola, " + proveedor + ".", "Mercaldas abrió la solicitud «" + s.titulo + "» para la semana " + s.ciclo_id + ".",
        "Te pedimos precio para " + codigos.length + " producto(s) que tienes registrados con nosotros.",
        "Plazo para enviar tu propuesta: " + limite + " (hora de Colombia).", s.observacion ? "Nota de Mercaldas: " + s.observacion : ""].filter(Boolean),
      boton: { texto: "Cotizar en el portal", url: correo.urlApp("/login.html") },
    });
  }
  return usuariosAvisados;
}

module.exports = function registrarSubastas(app, deps) {
  const soloAdmin = auth.requireAdmin;
  const adminOPlaneacion = auth.requireRol("admin", "planeacion");
  const cicloPorDefecto = () => { try { const c = deps.obtenerSemanaTrabajo(); return c ? c.id : null; } catch (e) { return null; } };

  // Productos del catálogo con cuántos proveedores los suministran (para armar la solicitud)
  app.get("/api/subastas/catalogo", soloAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo || cicloPorDefecto() || "");
    const porCodigo = proveedoresPorCodigo();
    let enDemanda = new Set();
    try {
      enDemanda = new Set(db.prepare("SELECT DISTINCT d.codigo FROM demanda_pedido_detalles d JOIN demandas_pedido p ON p.id = d.demanda_id WHERE p.ciclo_id = ?").all(ciclo).map((r) => String(r.codigo)));
    } catch (e) { /* sin demanda */ }
    res.json(db.prepare("SELECT codigo, producto, presentacion FROM catalogo ORDER BY producto COLLATE NOCASE").all().map((c) => ({
      codigo: c.codigo, producto: c.producto || "", presentacion: c.presentacion || "",
      proveedores: (porCodigo.get(String(c.codigo)) || []).length, en_demanda: enDemanda.has(String(c.codigo)),
    })));
  });

  app.get("/api/subastas", soloAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo || "").trim();
    const filas = ciclo
      ? db.prepare("SELECT * FROM subastas WHERE ciclo_id = ? ORDER BY id DESC").all(ciclo)
      : db.prepare("SELECT * FROM subastas ORDER BY id DESC LIMIT 50").all();
    const porCodigo = proveedoresPorCodigo(), conCuenta = proveedoresConCuenta();
    res.json(filas.map((s) => resumenSubasta(s, porCodigo, conCuenta)));
  });

  app.get("/api/subastas/:id(\\d+)", soloAdmin, (req, res) => {
    const s = subastaPorId(req.params.id);
    if (!s) return res.status(404).json({ error: "La subasta no existe." });
    const porCodigo = proveedoresPorCodigo(), conCuenta = proveedoresConCuenta(), ofertas = ofertasDelCiclo(s.ciclo_id);
    const productos = productosDe(s.id);
    const inv = invitados(productos, porCodigo);
    const seguimiento = new Map(db.prepare("SELECT * FROM subasta_proveedores WHERE subasta_id = ?").all(s.id).map((r) => [r.proveedor, r]));
    res.json({
      subasta: resumenSubasta(s, porCodigo, conCuenta),
      productos: productos.map((p) => ({
        ...p,
        proveedores: (porCodigo.get(String(p.codigo)) || []).length,
        ofertas: (ofertas.get(String(p.codigo)) || new Set()).size,
      })),
      proveedores: [...inv.entries()].map(([proveedor, codigos]) => {
        const seg = seguimiento.get(proveedor) || {};
        return {
          proveedor,
          productos_invitados: codigos.length,
          productos_ofertados: codigos.filter((c) => (ofertas.get(c) || new Set()).has(proveedor)).length,
          con_cuenta: conCuenta.has(notificaciones.clave(proveedor)),
          notificado_en: seg.notificado_en || null, visto_en: seg.visto_en || null, respondido_en: seg.respondido_en || null,
        };
      }).sort((a, b) => a.proveedor.localeCompare(b.proveedor, "es")),
    });
  });

  app.post("/api/subastas", soloAdmin, (req, res) => {
    const b = req.body || {};
    const ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(String(b.ciclo_id || "").trim());
    if (!ciclo) return res.status(400).json({ error: "Elige la semana (ciclo) de la solicitud." });
    if (ciclo.cerrado_en) return res.status(400).json({ error: "La semana " + ciclo.id + " está cerrada. Ábrela antes de pedir cotizaciones." });
    const limite = leerFechaLimite(b.fecha_limite);
    if (!limite) return res.status(400).json({ error: "Escribe la fecha y hora límite para recibir propuestas." });
    if (new Date(limite) <= new Date()) return res.status(400).json({ error: "La fecha límite debe ser posterior a este momento." });
    const v = validarProductos(b.productos);
    if (v.error) return res.status(400).json({ error: v.error });
    const titulo = auth.limpiar(b.titulo, 120) || "Solicitud de cotización " + ciclo.id;
    const id = db.transaction(() => {
      const info = db.prepare("INSERT INTO subastas (ciclo_id, titulo, observacion, fecha_limite, estado, creado_por, creado_en, actualizado_en) VALUES (?, ?, ?, ?, 'borrador', ?, ?, ?)")
        .run(ciclo.id, titulo, auth.limpiar(b.observacion, 500) || null, limite, req.usuarioActual.usuario, ahora(), ahora());
      guardarProductos(info.lastInsertRowid, v.filas);
      return info.lastInsertRowid;
    })();
    auth.bitacora(req, "subasta_creada", "#" + id + " " + ciclo.id + " (" + v.filas.length + " productos)");
    res.json({ ok: true, id });
  });

  app.put("/api/subastas/:id(\\d+)", soloAdmin, (req, res) => {
    const s = subastaPorId(req.params.id);
    if (!s) return res.status(404).json({ error: "La subasta no existe." });
    if (!["borrador", "abierta"].includes(s.estado)) return res.status(400).json({ error: "Solo se editan solicitudes en borrador o abiertas." });
    const b = req.body || {};
    const limite = b.fecha_limite !== undefined ? leerFechaLimite(b.fecha_limite) : s.fecha_limite;
    if (!limite) return res.status(400).json({ error: "La fecha límite no es válida." });
    if (limite !== s.fecha_limite && new Date(limite) <= new Date()) return res.status(400).json({ error: "La fecha límite debe ser posterior a este momento." });
    const titulo = b.titulo !== undefined ? auth.limpiar(b.titulo, 120) || s.titulo : s.titulo;
    const observacion = b.observacion !== undefined ? auth.limpiar(b.observacion, 500) || null : s.observacion;
    let v = null;
    if (b.productos !== undefined) {
      if (s.estado !== "borrador") return res.status(400).json({ error: "La solicitud ya se envió: para pedir más productos crea una nueva." });
      v = validarProductos(b.productos);
      if (v.error) return res.status(400).json({ error: v.error });
    }
    db.transaction(() => {
      db.prepare("UPDATE subastas SET titulo = ?, observacion = ?, fecha_limite = ?, actualizado_en = ? WHERE id = ?").run(titulo, observacion, limite, ahora(), s.id);
      if (v) guardarProductos(s.id, v.filas);
    })();
    if (s.estado === "abierta" && limite !== s.fecha_limite) {
      const provs = db.prepare("SELECT proveedor FROM subasta_proveedores WHERE subasta_id = ?").all(s.id).map((r) => r.proveedor);
      provs.forEach((p) => notificaciones.paraProveedor(p, { tipo: "subasta", titulo: "Cambió el plazo de «" + titulo + "»", mensaje: "Nueva fecha límite: " + fechaBogota(limite) + ".", enlace: "subastas" }));
    }
    res.json({ ok: true });
  });

  app.delete("/api/subastas/:id(\\d+)", soloAdmin, (req, res) => {
    const s = subastaPorId(req.params.id);
    if (!s) return res.status(404).json({ error: "La subasta no existe." });
    if (s.estado !== "borrador") return res.status(400).json({ error: "Solo se eliminan solicitudes en borrador. Si ya se envió, ciérrala." });
    db.prepare("DELETE FROM subastas WHERE id = ?").run(s.id);
    auth.bitacora(req, "subasta_eliminada", "#" + s.id);
    res.json({ ok: true });
  });

  app.post("/api/subastas/:id(\\d+)/enviar", soloAdmin, (req, res) => {
    const s = subastaPorId(req.params.id);
    if (!s) return res.status(404).json({ error: "La subasta no existe." });
    if (s.estado !== "borrador") return res.status(400).json({ error: "Esta solicitud ya se envió." });
    const ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(s.ciclo_id);
    if (!ciclo || ciclo.cerrado_en) return res.status(400).json({ error: "La semana " + s.ciclo_id + " está cerrada. Ábrela antes de enviar la solicitud." });
    if (new Date(s.fecha_limite) <= new Date()) return res.status(400).json({ error: "La fecha límite ya pasó. Cámbiala antes de enviar." });
    const productos = productosDe(s.id);
    const porCodigo = proveedoresPorCodigo(), conCuenta = proveedoresConCuenta();
    const inv = invitados(productos, porCodigo);
    if (!inv.size) return res.status(400).json({ error: "Ninguno de los productos tiene proveedores asociados. Asócialos en Configuración." });

    const t = ahora();
    db.transaction(() => {
      db.prepare("UPDATE subastas SET estado = 'abierta', enviado_en = ?, actualizado_en = ? WHERE id = ?").run(t, t, s.id);
      const ins = db.prepare(`
        INSERT INTO subasta_proveedores (subasta_id, proveedor, productos_invitados, notificado_en) VALUES (?, ?, ?, ?)
        ON CONFLICT(subasta_id, proveedor) DO UPDATE SET productos_invitados = excluded.productos_invitados, notificado_en = excluded.notificado_en
      `);
      for (const [prov, codigos] of inv) ins.run(s.id, prov, codigos.length, conCuenta.has(notificaciones.clave(prov)) ? t : null);
    })();
    const usuarios = avisarProveedores(subastaPorId(s.id), inv, conCuenta);
    const sinCuenta = [...inv.keys()].filter((p) => !conCuenta.has(notificaciones.clave(p))).sort();
    auth.bitacora(req, "subasta_enviada", "#" + s.id + " a " + inv.size + " proveedores");
    res.json({
      ok: true, proveedores: inv.size, usuarios_avisados: usuarios, sin_cuenta: sinCuenta,
      productos_sin_proveedor: productos.filter((p) => !(porCodigo.get(String(p.codigo)) || []).length).map((p) => p.codigo + " " + p.producto),
    });
  });

  app.post("/api/subastas/:id(\\d+)/cerrar", soloAdmin, (req, res) => {
    const s = subastaPorId(req.params.id);
    if (!s) return res.status(404).json({ error: "La subasta no existe." });
    if (s.estado !== "abierta") return res.status(400).json({ error: "Solo se cierran solicitudes abiertas." });
    db.prepare("UPDATE subastas SET estado = 'cerrada', cerrado_en = ?, actualizado_en = ? WHERE id = ?").run(ahora(), ahora(), s.id);
    auth.bitacora(req, "subasta_cerrada", "#" + s.id);
    res.json({ ok: true });
  });

  app.post("/api/subastas/:id(\\d+)/reabrir", soloAdmin, (req, res) => {
    const s = subastaPorId(req.params.id);
    if (!s) return res.status(404).json({ error: "La subasta no existe." });
    if (!["cerrada", "abierta"].includes(s.estado)) return res.status(400).json({ error: "Esta solicitud no se puede reabrir." });
    const limite = leerFechaLimite(req.body && req.body.fecha_limite);
    if (!limite || new Date(limite) <= new Date()) return res.status(400).json({ error: "Escribe una nueva fecha límite posterior a este momento." });
    db.prepare("UPDATE subastas SET estado = 'abierta', fecha_limite = ?, cerrado_en = NULL, actualizado_en = ? WHERE id = ?").run(limite, ahora(), s.id);
    db.prepare("SELECT proveedor FROM subasta_proveedores WHERE subasta_id = ?").all(s.id).forEach((r) =>
      notificaciones.paraProveedor(r.proveedor, { tipo: "subasta", titulo: "Se reabrió «" + s.titulo + "»", mensaje: "Puedes enviar o ajustar tu propuesta hasta el " + fechaBogota(limite) + ".", enlace: "subastas" }));
    auth.bitacora(req, "subasta_reabierta", "#" + s.id);
    res.json({ ok: true });
  });

  // Resumen general por producto, sin nombres ni precios de proveedores (lo usa Planeación)
  app.get("/api/subastas/resumen", adminOPlaneacion, (req, res) => {
    const ciclo = String(req.query.ciclo || cicloPorDefecto() || "").trim();
    if (!ciclo) return res.json({ ciclo: null, subastas: [], productos: [] });
    const subastas = db.prepare("SELECT * FROM subastas WHERE ciclo_id = ? AND estado IN (" + ESTADOS_VISIBLES.map(() => "?").join(",") + ") ORDER BY id").all(ciclo, ...ESTADOS_VISIBLES);
    const porCodigo = proveedoresPorCodigo(), conCuenta = proveedoresConCuenta(), ofertas = ofertasDelCiclo(ciclo), neg = negociacionPorCodigo(ciclo);
    const productos = new Map();
    subastas.forEach((s) => productosDe(s.id).forEach((p) => {
      const c = String(p.codigo);
      const previo = productos.get(c);
      if (previo) {
        previo.solicitudes.push(s.titulo);
        if (p.cantidad_estimada != null) previo.cantidad_estimada = (previo.cantidad_estimada || 0) + Number(p.cantidad_estimada);
        if (estadoEfectivo(s) === "abierta") previo.abierta = true;
        return;
      }
      productos.set(c, { codigo: c, producto: p.producto, presentacion: p.presentacion, cantidad_estimada: p.cantidad_estimada, solicitudes: [s.titulo], abierta: estadoEfectivo(s) === "abierta" });
    }));
    const filas = [...productos.values()].map((p) => {
      const n = neg.get(p.codigo) || { acuerdo: 0, sin_acuerdo: 0, abierto: 0 };
      const nOfertas = (ofertas.get(p.codigo) || new Set()).size;
      const estado = n.acuerdo > 0 ? "acordado" : n.abierto > 0 ? "negociacion" : nOfertas > 0 ? "con_ofertas" : p.abierta ? "esperando" : "sin_ofertas";
      return {
        codigo: p.codigo, producto: p.producto, presentacion: p.presentacion, cantidad_estimada: p.cantidad_estimada, solicitudes: p.solicitudes,
        proveedores_invitados: (porCodigo.get(p.codigo) || []).length, ofertas: nOfertas,
        acuerdos: n.acuerdo, en_negociacion: n.abierto, sin_acuerdo: n.sin_acuerdo, estado,
      };
    }).sort((a, b) => String(a.producto).localeCompare(String(b.producto), "es"));
    res.json({ ciclo, subastas: subastas.map((s) => resumenSubasta(s, porCodigo, conCuenta)), productos: filas });
  });
};

Object.assign(module.exports, { subastaPorId, productosDe, estadoEfectivo, fechaBogota, proveedoresPorCodigo });
