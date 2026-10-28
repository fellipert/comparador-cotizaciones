"use strict";
// Portal del proveedor: todo lo que antes hacía con Excel, directo en la plataforma.
//  - Ve las subastas abiertas con SOLO sus productos parametrizados y envía su propuesta de precio.
//  - Ve las contrapropuestas que Mercaldas le envió y responde: acepta, mantiene su precio o propone uno intermedio.
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
    const estado = subastas.estadoEfectivo(s);
    const seg = db.prepare("SELECT respondido_en FROM subasta_proveedores WHERE subasta_id = ? AND proveedor = ?").get(s.id, proveedor) || {};
    if (estado === "abierta") marcarVisto.run(s.id, proveedor, ahora());
    resultado.push({
      id: s.id, ciclo_id: s.ciclo_id, titulo: s.titulo, observacion: s.observacion, fecha_limite: s.fecha_limite, estado,
      vigencia: ciclo ? { desde: ciclo.fecha_inicio_vigencia, hasta: ciclo.fecha_fin_vigencia } : null,
      respondido_en: seg.respondido_en || null,
      negociacion_iniciada: !!negociacion,
      puede_ofertar: estado === "abierta" && !negociacion && !!ciclo && !ciclo.cerrado_en,
      productos: productos.map((p) => {
        const o = ofertas.get(String(p.codigo));
        const rel = mios.get(String(p.codigo));
        return {
          codigo: p.codigo, producto: p.producto, presentacion: (rel && rel.presentacion_proveedor) || p.presentacion || "",
          cantidad_estimada: p.cantidad_estimada, observacion: p.observacion, tipo: rel ? rel.tipo : null,
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

module.exports = function registrarPortalProveedor(app) {
  const soloProveedor = auth.requireProveedor;

  app.get("/api/proveedor/inicio", soloProveedor, (req, res) => {
    try {
      const u = req.usuarioActual;
      const proveedor = u.proveedor_nombre;
      res.json({
        proveedor,
        usuario: u.usuario,
        nombre: u.nombre || u.usuario,
        email: u.email,
        subastas: subastasDelProveedor(proveedor),
        negociaciones: negociacionesDelProveedor(proveedor),
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
      if (negociacionDeCiclo(proveedor, s.ciclo_id)) {
        return res.status(409).json({ error: "Mercaldas ya está negociando tu propuesta de esta semana. Revisa la sección Contrapropuestas." });
      }
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
};
