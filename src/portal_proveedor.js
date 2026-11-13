"use strict";
// Portal del proveedor: todo lo que antes hacía con Excel, directo en la plataforma.
//  - Ve las subastas abiertas con SOLO sus productos parametrizados y envía su propuesta de precio.
//  - Ve las contrapropuestas que Mercaldas le envió y responde: acepta, mantiene su precio o propone uno intermedio.
//    Las envía el admin cuando lo decide; lo que ya tiene contrapropuesta no se cambia desde la solicitud.
//  - Agrega a su stock productos del catálogo de Mercaldas, fijos (habitual) o temporales hasta una fecha (adicional).
// Cada consulta se filtra por el proveedor de la sesión: nunca ve datos de otros proveedores.
const crypto = require("crypto");
const db = require("./db");
const auth = require("./auth");
const notificaciones = require("./notificaciones");
const subastas = require("./subastas");
const hoja = require("./negociacion_hoja");

const ahora = () => new Date().toISOString();
const DIAS_HISTORIAL = 30;
const PRECIO_MAXIMO = 100000000;
const DISPONIBILIDADES = ["Disponible", "Limitado", "No disponible"];
const ACCIONES = {
  aceptar: "Acepta la contrapropuesta",
  mantener: "Mantiene su precio",
  contraproponer: "Contrapropone un precio intermedio",
};

const MAX_DIAS_TEMPORAL = 366;
const hoyBogota = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
const sumarDias = (iso, dias) => new Date(Date.parse(iso + "T00:00:00Z") + dias * 86400000).toISOString().slice(0, 10);
const fechaCorta = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const nombreArchivo = (cicloId) => "Portal proveedor - " + cicloId;
const tienePresentacionProveedor = () => db.prepare("PRAGMA table_info(proveedor_productos)").all().some((c) => c.name === "presentacion_proveedor");

function misProductos(proveedor) {
  const conPresentacion = tienePresentacionProveedor();
  return new Map(db.prepare(
    "SELECT codigo, tipo" + (conPresentacion ? ", presentacion_proveedor" : "") + " FROM proveedor_productos WHERE proveedor = ? AND activo = 1"
  ).all(proveedor).map((r) => [String(r.codigo), r]));
}

function misOfertas(proveedor, cicloId) {
  return new Map(db.prepare(`
    SELECT q.codigo, q.precio, q.disponibilidad, q.observacion
    FROM quotes q JOIN files f ON f.id = q.file_id
    WHERE q.proveedor = ? AND q.ciclo_id = ? AND f.name = ?
    ORDER BY q.id
  `).all(proveedor, cicloId, nombreArchivo(cicloId)).map((r) => [String(r.codigo), r]));
}

function negociacionDeCiclo(proveedor, cicloId) {
  try {
    return db.prepare("SELECT id FROM negociaciones_unificadas WHERE ciclo_id = ? AND proveedor = ?").get(cicloId, proveedor) || null;
  } catch (e) {
    return null;
  }
}

// PLU del proveedor que ya entraron a negociación esa semana: ya no se cambian desde la solicitud
function codigosEnNegociacion(proveedor, cicloId) {
  try {
    return new Set(db.prepare(`
      SELECT p.codigo FROM negociacion_unificada_productos p
      JOIN negociaciones_unificadas n ON n.id = p.negociacion_id
      WHERE n.ciclo_id = ? AND n.proveedor = ?
    `).all(cicloId, proveedor).map((r) => String(r.codigo)));
  } catch (e) {
    return new Set();
  }
}

function negociacionDisponible() {
  try { return hoja.esquemaFaltante().length === 0; } catch (e) { return false; }
}

function subastasDelProveedor(proveedor) {
  const mios = misProductos(proveedor);
  const desde = new Date(Date.now() - DIAS_HISTORIAL * 86400000).toISOString();
  const lista = db.prepare(`
    SELECT * FROM subastas
    WHERE estado = 'abierta' OR (estado = 'cerrada' AND COALESCE(cerrado_en, fecha_limite) >= ?)
    ORDER BY CASE WHEN estado = 'abierta' THEN 0 ELSE 1 END, fecha_limite DESC
  `).all(desde);
  const marcarVisto = db.prepare(`
    INSERT INTO subasta_proveedores (subasta_id, proveedor, visto_en) VALUES (?, ?, ?)
    ON CONFLICT(subasta_id, proveedor) DO UPDATE SET visto_en = COALESCE(subasta_proveedores.visto_en, excluded.visto_en)
  `);
  const resultado = [];
  for (const s of lista) {
    const productos = subastas.productosDe(s.id).filter((p) => mios.has(String(p.codigo)));
    if (!productos.length) continue;
    const ciclo = db.prepare("SELECT id, cerrado_en, fecha_inicio_vigencia, fecha_fin_vigencia FROM ciclos WHERE id = ?").get(s.ciclo_id);
    const ofertas = misOfertas(proveedor, s.ciclo_id);
    const negociacion = negociacionDeCiclo(proveedor, s.ciclo_id);
    const negociados = codigosEnNegociacion(proveedor, s.ciclo_id);
    const estado = subastas.estadoEfectivo(s);
    const seg = db.prepare("SELECT respondido_en FROM subasta_proveedores WHERE subasta_id = ? AND proveedor = ?").get(s.id, proveedor) || {};
    if (estado === "abierta") marcarVisto.run(s.id, proveedor, ahora());
    const recibe = estado === "abierta" && !!ciclo && !ciclo.cerrado_en;
    resultado.push({
      id: s.id, ciclo_id: s.ciclo_id, titulo: s.titulo, observacion: s.observacion, fecha_limite: s.fecha_limite, estado,
      vigencia: ciclo ? { desde: ciclo.fecha_inicio_vigencia, hasta: ciclo.fecha_fin_vigencia } : null,
      respondido_en: seg.respondido_en || null,
      negociacion_iniciada: !!negociacion,
      // Lo que ya entró a negociación se responde en Contrapropuestas; lo demás se puede seguir cotizando
      puede_ofertar: recibe && productos.some((p) => !negociados.has(String(p.codigo))),
      productos: productos.map((p) => {
        const o = ofertas.get(String(p.codigo));
        const rel = mios.get(String(p.codigo));
        return {
          codigo: p.codigo, producto: p.producto, presentacion: (rel && rel.presentacion_proveedor) || p.presentacion || "",
          cantidad_estimada: p.cantidad_estimada, observacion: p.observacion, tipo: rel ? rel.tipo : null,
          en_negociacion: negociados.has(String(p.codigo)),
          oferta: o ? { precio: o.precio, disponibilidad: o.disponibilidad || "", observacion: o.observacion || "" } : null,
        };
      }),
    });
  }
  return resultado;
}

function negociacionesDelProveedor(proveedor) {
  if (!negociacionDisponible()) return [];
  const lista = db.prepare("SELECT * FROM negociaciones_unificadas WHERE proveedor = ? ORDER BY id DESC LIMIT 8").all(proveedor);
  const resultado = [];
  for (const n of lista) {
    const h = hoja.armarHoja(n);
    const pub = hoja.rondaPublicada(n.id);
    const visible = (p) => p.estado === "abierto" && p.turno === "proveedor" && pub && p.ultimaRonda <= pub.ronda;
    const pendientes = h.productos.filter(visible).map((p) => ({
      codigo: p.codigo, producto: p.producto, presentacion: p.presentacion, tu_precio: p.proveedorActual, contrapropuesta: p.contraActual,
    }));
    const cerrados = h.productos.filter((p) => p.estado !== "abierto").map((p) => ({
      codigo: p.codigo, producto: p.producto, presentacion: p.presentacion, cotizaste: p.cotizo, precio_final: p.precio_final, estado: p.estado,
    }));
    const enRevision = h.productos.filter((p) => p.estado === "abierto" && !visible(p)).length;
    if (!pendientes.length && !cerrados.length && !enRevision) continue;
    resultado.push({ id: n.id, ciclo_id: n.ciclo_id, estado: n.estado, publicado_en: pub ? pub.publicado_en : null, pendientes, cerrados, en_revision: enRevision });
  }
  return resultado;
}

function avisarAdmins(datos) {
  notificaciones.paraTipo("admin", datos);
}

// ---------- Stock del proveedor ----------

// Un producto temporal sale solo del stock el día siguiente a su fecha "hasta"
function retirarTemporalesVencidos() {
  const r = db.prepare(`
    UPDATE proveedor_productos SET activo = 0, disponible_hasta = NULL, actualizado_en = ?
    WHERE activo = 1 AND disponible_hasta IS NOT NULL AND disponible_hasta < ?
  `).run(ahora(), hoyBogota());
  if (r.changes) console.log("[portal proveedor] " + r.changes + " producto(s) temporal(es) salieron del stock por fecha.");
}

function stockDelProveedor(proveedor) {
  const presentacion = tienePresentacionProveedor() ? "COALESCE(pp.presentacion_proveedor, c.presentacion, '')" : "COALESCE(c.presentacion, '')";
  return db.prepare(`
    SELECT pp.codigo, c.producto, ${presentacion} AS presentacion, pp.tipo, pp.disponible_hasta
    FROM proveedor_productos pp JOIN catalogo c ON c.codigo = pp.codigo
    WHERE pp.proveedor = ? AND pp.activo = 1
    ORDER BY CASE WHEN pp.tipo = 'habitual' THEN 0 ELSE 1 END, c.producto COLLATE NOCASE
  `).all(proveedor).map((r) => ({
    codigo: r.codigo, producto: r.producto || r.codigo, presentacion: r.presentacion, fijo: r.tipo === "habitual", hasta: r.disponible_hasta || null,
  }));
}

// La frecuencia se toma de como ya se cotiza ese PLU con otros proveedores; si nadie lo tiene, la más común en su stock
function frecuenciaPara(proveedor, codigo) {
  const masComun = (campo, valor) => (db.prepare(
    "SELECT frecuencia FROM proveedor_productos WHERE " + campo + " = ? AND activo = 1 GROUP BY frecuencia ORDER BY COUNT(*) DESC LIMIT 1"
  ).get(valor) || {}).frecuencia;
  return (masComun("codigo", codigo) || masComun("proveedor", proveedor)) === "diario" ? "diario" : "semanal";
}

// Si hay una solicitud abierta, el producto entra en ella para cotizarlo ya (aunque otros ya estén en negociación)
function sumarASolicitudesAbiertas(proveedor, c, t) {
  const abiertas = db.prepare("SELECT * FROM subastas WHERE estado = 'abierta'").all().filter((s) => {
    const ciclo = db.prepare("SELECT cerrado_en FROM ciclos WHERE id = ?").get(s.ciclo_id);
    return subastas.estadoEfectivo(s) === "abierta" && ciclo && !ciclo.cerrado_en;
  });
  const producto = db.prepare("INSERT OR IGNORE INTO subasta_productos (subasta_id, codigo, producto, presentacion) VALUES (?, ?, ?, ?)");
  const invitado = db.prepare(`
    INSERT INTO subasta_proveedores (subasta_id, proveedor, productos_invitados, notificado_en) VALUES (?, ?, 1, ?)
    ON CONFLICT(subasta_id, proveedor) DO UPDATE SET productos_invitados = subasta_proveedores.productos_invitados + 1
  `);
  abiertas.forEach((s) => {
    producto.run(s.id, c.codigo, c.producto || "", c.presentacion || "");
    invitado.run(s.id, proveedor, t);
  });
  return abiertas;
}

module.exports = function registrarPortalProveedor(app) {
  const soloProveedor = auth.requireProveedor;

  retirarTemporalesVencidos();
  setInterval(() => {
    try { retirarTemporalesVencidos(); } catch (e) { console.error("[portal proveedor] temporales:", e); }
  }, 60 * 60 * 1000).unref();

  app.get("/api/proveedor/inicio", soloProveedor, (req, res) => {
    try {
      const u = req.usuarioActual;
      const proveedor = u.proveedor_nombre;
      retirarTemporalesVencidos();
      res.json({
        proveedor,
        usuario: u.usuario,
        nombre: u.nombre || u.usuario,
        email: u.email,
        hoy: hoyBogota(),
        subastas: subastasDelProveedor(proveedor),
        negociaciones: negociacionesDelProveedor(proveedor),
        productos: stockDelProveedor(proveedor),
        no_leidas: db.prepare("SELECT COUNT(*) AS n FROM notificaciones WHERE usuario_id = ? AND leida_en IS NULL").get(u.id).n,
      });
    } catch (e) {
      console.error("[portal proveedor] inicio:", e);
      res.status(500).json({ error: "No se pudo cargar el portal." });
    }
  });

  app.post("/api/proveedor/subastas/:id(\\d+)/oferta", soloProveedor, (req, res) => {
    try {
      const proveedor = req.usuarioActual.proveedor_nombre;
      const s = subastas.subastaPorId(req.params.id);
      if (!s || !["abierta", "cerrada"].includes(s.estado)) return res.status(404).json({ error: "La solicitud no existe." });
      if (subastas.estadoEfectivo(s) !== "abierta") return res.status(409).json({ error: "Esta solicitud ya cerró: no recibe más propuestas." });
      const ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(s.ciclo_id);
      if (!ciclo || ciclo.cerrado_en) return res.status(409).json({ error: "La semana " + s.ciclo_id + " ya está cerrada." });
      const negociados = codigosEnNegociacion(proveedor, s.ciclo_id);
      const mios = misProductos(proveedor);
      const pedidos = new Map(subastas.productosDe(s.id).filter((p) => mios.has(String(p.codigo))).map((p) => [String(p.codigo), p]));
      if (!pedidos.size) return res.status(403).json({ error: "Esta solicitud no incluye productos tuyos." });

      const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
      const errores = [], vistos = new Set(), plan = [];
      for (const it of items) {
        const codigo = String((it && it.codigo) || "").trim();
        const p = pedidos.get(codigo);
        if (!p) { errores.push("El PLU " + codigo + " no está en esta solicitud o no es tuyo."); continue; }
        if (vistos.has(codigo)) { errores.push(p.producto + " aparece dos veces."); continue; }
        vistos.add(codigo);
        if (negociados.has(codigo)) {
          errores.push(p.producto + " ya tiene contrapropuesta de Mercaldas: respóndela en Contrapropuestas (recarga la página).");
          continue;
        }
        const vacio = it.precio === null || it.precio === undefined || String(it.precio).trim() === "";
        if (vacio) { plan.push({ codigo, p, retirar: true }); continue; }
        const precio = Number(it.precio);
        if (!Number.isInteger(precio) || precio <= 0 || precio > PRECIO_MAXIMO) { errores.push(p.producto + ": escribe un precio en pesos, entero y mayor que cero."); continue; }
        const disponibilidad = String(it.disponibilidad || "").trim();
        if (disponibilidad && !DISPONIBILIDADES.includes(disponibilidad)) { errores.push(p.producto + ": disponibilidad no válida."); continue; }
        plan.push({ codigo, p, precio, disponibilidad: disponibilidad || null, observacion: auth.limpiar(it.observacion, 300) || null });
      }
      if (errores.length) return res.status(400).json({ error: errores.join(" "), errores });
      const ofertas = plan.filter((x) => !x.retirar);
      const anteriores = misOfertas(proveedor, s.ciclo_id);
      if (!ofertas.length && !plan.some((x) => anteriores.has(x.codigo))) return res.status(400).json({ error: "Escribe el precio de al menos un producto." });

      const conPresentacion = tienePresentacionProveedor();
      const t = ahora();
      db.transaction(() => {
        const nombre = nombreArchivo(s.ciclo_id);
        let archivo = db.prepare("SELECT id FROM files WHERE proveedor = ? AND ciclo_id = ? AND name = ? LIMIT 1").get(proveedor, s.ciclo_id, nombre);
        if (archivo) db.prepare("UPDATE files SET uploaded_at = ? WHERE id = ?").run(t, archivo.id);
        else {
          archivo = { id: crypto.randomUUID() };
          db.prepare("INSERT INTO files (id, name, proveedor, semana, fecha_envio, uploaded_at, ciclo_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(archivo.id, nombre, proveedor, s.ciclo_id, t.slice(0, 10), t, s.ciclo_id);
        }
        const borrar = db.prepare("DELETE FROM quotes WHERE file_id = ? AND codigo = ?");
        const insertar = db.prepare(`
          INSERT INTO quotes (file_id, codigo, producto, presentacion, disponibilidad, precio, observacion, proveedor, semana, vigencia_fin, ciclo_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const x of plan) {
          borrar.run(archivo.id, x.codigo);
          if (x.retirar) continue;
          const rel = mios.get(x.codigo);
          const presentacion = (conPresentacion && rel && rel.presentacion_proveedor) || x.p.presentacion || "";
          insertar.run(archivo.id, x.codigo, x.p.producto || "", presentacion, x.disponibilidad, x.precio, x.observacion, proveedor, s.ciclo_id, ciclo.fecha_fin_vigencia, s.ciclo_id);
        }
        db.prepare(`
          INSERT INTO subasta_proveedores (subasta_id, proveedor, visto_en, respondido_en) VALUES (?, ?, ?, ?)
          ON CONFLICT(subasta_id, proveedor) DO UPDATE SET respondido_en = excluded.respondido_en, visto_en = COALESCE(subasta_proveedores.visto_en, excluded.visto_en)
        `).run(s.id, proveedor, t, t);
      })();

      auth.bitacora(req, "oferta_enviada", "Subasta #" + s.id + ": " + ofertas.length + " precios");
      avisarAdmins({ tipo: "oferta", titulo: proveedor + " envió su propuesta", mensaje: "«" + s.titulo + "» · " + ofertas.length + " de " + pedidos.size + " productos con precio.", enlace: "subastas" });
      res.json({ ok: true, ofertados: ofertas.length, retirados: plan.length - ofertas.length });
    } catch (e) {
      console.error("[portal proveedor] oferta:", e);
      res.status(500).json({ error: "No se pudo guardar tu propuesta." });
    }
  });

  app.post("/api/proveedor/negociaciones/:id(\\d+)/responder", soloProveedor, (req, res) => {
    try {
      if (!negociacionDisponible()) return res.status(503).json({ error: "La negociación no está disponible en este momento." });
      const proveedor = req.usuarioActual.proveedor_nombre;
      const neg = hoja.negociacionPorId(req.params.id);
      if (!neg || neg.proveedor !== proveedor) return res.status(404).json({ error: "No existe esa negociación." });
      const pub = hoja.rondaPublicada(neg.id);
      const h = hoja.armarHoja(neg);
      const pendientes = new Map(h.productos
        .filter((p) => p.estado === "abierto" && p.turno === "proveedor" && pub && p.ultimaRonda <= pub.ronda)
        .map((p) => [String(p.codigo), p]));

      const lista = Array.isArray(req.body && req.body.respuestas) ? req.body.respuestas : [];
      if (!lista.length) return res.status(400).json({ error: "Responde al menos un producto." });
      const errores = [], vistos = new Set(), respuestas = [];
      for (const r of lista) {
        const codigo = String((r && r.codigo) || "").trim();
        const p = pendientes.get(codigo);
        if (!p) { errores.push("El producto " + codigo + " ya no espera tu respuesta."); continue; }
        if (vistos.has(codigo)) { errores.push(p.producto + " aparece dos veces."); continue; }
        vistos.add(codigo);
        let precio;
        if (r.accion === "aceptar") precio = p.contraActual;
        else if (r.accion === "mantener") precio = p.proveedorActual;
        else if (r.accion === "contraproponer") {
          precio = Number(r.precio);
          if (!Number.isInteger(precio) || precio <= 0) { errores.push(p.producto + ": escribe un precio entero mayor que cero."); continue; }
          if (p.contraActual != null && precio <= p.contraActual) { errores.push(p.producto + ": si el precio es igual a la contrapropuesta, elige «Acepto»."); continue; }
          if (p.proveedorActual != null && precio >= p.proveedorActual) { errores.push(p.producto + ": el precio intermedio debe ser menor que tu precio actual; si no, elige «Mantengo mi precio»."); continue; }
        } else { errores.push(p.producto + ": elige una respuesta."); continue; }
        if (!(precio > 0)) { errores.push(p.producto + ": no hay un precio para esa respuesta."); continue; }
        respuestas.push({ codigo, ronda: p.ultimaRonda + 1, respuesta: precio, acepta: r.accion === "aceptar", observacion: ACCIONES[r.accion] });
      }
      if (errores.length) return res.status(400).json({ error: errores.join(" "), errores });

      const guardadas = hoja.aplicarRespuestas(neg, respuestas, "Precio final respondido por el proveedor en el portal");
      auth.bitacora(req, "contrapropuesta_respondida", "Negociación #" + neg.id + ": " + guardadas + " productos");
      const aceptadas = respuestas.filter((r) => r.acepta).length;
      avisarAdmins({ tipo: "respuesta", titulo: proveedor + " respondió la contrapropuesta", mensaje: "Semana " + neg.ciclo_id + " · " + guardadas + " producto(s), " + aceptadas + " aceptado(s).", enlace: "hoja-negociacion" });
      res.json({ ok: true, guardadas });
    } catch (e) {
      console.error("[portal proveedor] responder:", e);
      res.status(500).json({ error: "No se pudo guardar tu respuesta." });
    }
  });

  // Productos del catálogo que el proveedor todavía no tiene en su stock
  app.get("/api/proveedor/catalogo", soloProveedor, (req, res) => {
    try {
      const q = String(req.query.q || "").trim().slice(0, 60);
      if (q.length < 2) return res.json([]);
      const like = "%" + q + "%";
      res.json(db.prepare(`
        SELECT c.codigo, c.producto, COALESCE(c.presentacion, '') AS presentacion FROM catalogo c
        WHERE (c.codigo LIKE ? OR c.producto LIKE ?)
          AND NOT EXISTS (SELECT 1 FROM proveedor_productos pp WHERE pp.proveedor = ? AND pp.codigo = c.codigo AND pp.activo = 1)
        ORDER BY c.producto COLLATE NOCASE LIMIT 20
      `).all(like, like, req.usuarioActual.proveedor_nombre));
    } catch (e) {
      console.error("[portal proveedor] catálogo:", e);
      res.status(500).json({ error: "No se pudo buscar en el catálogo." });
    }
  });

  app.post("/api/proveedor/productos", soloProveedor, (req, res) => {
    try {
      const proveedor = req.usuarioActual.proveedor_nombre;
      const b = req.body || {};
      const codigo = String(b.codigo || "").trim();
      // El producto nuevo toma los datos del catálogo: PLU, nombre y presentación
      const c = codigo && db.prepare("SELECT codigo, producto, presentacion FROM catalogo WHERE codigo = ?").get(codigo);
      if (!c) return res.status(404).json({ error: "Ese producto no está en el catálogo de Mercaldas." });
      retirarTemporalesVencidos();
      const actual = db.prepare("SELECT activo FROM proveedor_productos WHERE proveedor = ? AND codigo = ?").get(proveedor, codigo);
      if (actual && actual.activo) return res.status(409).json({ error: c.producto + " ya está en tu stock." });
      if (b.tipo !== "fijo" && b.tipo !== "temporal") return res.status(400).json({ error: "Elige si el producto es fijo o temporal." });

      let hasta = null;
      if (b.tipo === "temporal") {
        hasta = String(b.hasta || "").trim();
        const valida = /^\d{4}-\d{2}-\d{2}$/.test(hasta) && !isNaN(Date.parse(hasta + "T00:00:00Z")) && new Date(hasta + "T00:00:00Z").toISOString().slice(0, 10) === hasta;
        if (!valida) return res.status(400).json({ error: "Escribe hasta qué fecha tendrás el producto." });
        const hoy = hoyBogota();
        if (hasta < hoy) return res.status(400).json({ error: "La fecha no puede ser anterior a hoy." });
        if (hasta > sumarDias(hoy, MAX_DIAS_TEMPORAL)) return res.status(400).json({ error: "Un producto temporal puede durar hasta un año. Si lo tendrás siempre, márcalo como fijo." });
      }

      const t = ahora();
      let solicitudes = [];
      db.transaction(() => {
        // Si ya lo tuvo antes, conserva su frecuencia y la contrapropuesta manual que haya puesto Mercaldas
        db.prepare(`
          INSERT INTO proveedor_productos (proveedor, codigo, tipo, actualizado_en, activo, frecuencia, disponible_hasta) VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(proveedor, codigo) DO UPDATE SET tipo = excluded.tipo, actualizado_en = excluded.actualizado_en, activo = 1, disponible_hasta = excluded.disponible_hasta
        `).run(proveedor, codigo, b.tipo === "fijo" ? "habitual" : "adicional", t, frecuenciaPara(proveedor, codigo), hasta);
        solicitudes = sumarASolicitudesAbiertas(proveedor, c, t);
      })();

      const detalle = c.producto + " (PLU " + codigo + ") · " + (hasta ? "temporal hasta el " + fechaCorta(hasta) : "fijo");
      auth.bitacora(req, "producto_agregado", detalle);
      avisarAdmins({
        tipo: "producto", titulo: proveedor + " agregó un producto a su stock",
        mensaje: detalle + (solicitudes.length ? " · Entró a la solicitud «" + solicitudes[0].titulo + "»." : "."), enlace: "por-proveedor",
      });
      res.json({ ok: true, codigo, producto: c.producto, tipo: b.tipo, hasta, en_solicitud: solicitudes.length > 0 });
    } catch (e) {
      console.error("[portal proveedor] agregar producto:", e);
      res.status(500).json({ error: "No se pudo agregar el producto." });
    }
  });
};
