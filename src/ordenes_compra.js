const db = require("./db");
const ExcelJS = require("exceljs");

// ---------- Esquema (se crea solo al arrancar; seguro de ejecutar siempre) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS ordenes_compra_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL UNIQUE,
    proveedor TEXT NOT NULL,
    ciclo_id TEXT NOT NULL,
    periodo TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'emitida',
    subtotal REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL,
    creado_por TEXT,
    observacion TEXT
  );

  CREATE TABLE IF NOT EXISTS orden_compra_v2_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_compra_id INTEGER NOT NULL,
    pedido_asignacion_id INTEGER NOT NULL UNIQUE,
    codigo TEXT NOT NULL,
    producto TEXT NOT NULL,
    presentacion TEXT,
    cantidad REAL NOT NULL,
    precio_unitario REAL NOT NULL,
    subtotal REAL NOT NULL,
    FOREIGN KEY (orden_compra_id) REFERENCES ordenes_compra_v2(id) ON DELETE CASCADE
  );
`);

const columnasAsignaciones = db.prepare("PRAGMA table_info(pedido_asignaciones)").all().map((c) => c.name);
if (!columnasAsignaciones.includes("orden_compra_id")) {
  db.exec("ALTER TABLE pedido_asignaciones ADD COLUMN orden_compra_id INTEGER REFERENCES ordenes_compra_v2(id)");
}

// Consecutivo compartido con provee-mercaldas: ese sistema arranca en 1069 y aún
// no ha emitido ninguna OC real, así que este es el único que las emite por ahora.
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('oc_consecutivo_v2', '1068')").run();

// ---------- Lógica ----------

function siguienteNumeroOC() {
  const obtenerYAvanzar = db.transaction(() => {
    const fila = db.prepare("SELECT value FROM settings WHERE key = 'oc_consecutivo_v2'").get();
    const siguiente = Number(fila.value) + 1;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'oc_consecutivo_v2'").run(String(siguiente));
    return siguiente;
  });
  return (process.env.APP_ENV === "dev" ? "PRUEBA-OC-" : "OC-") + obtenerYAvanzar();
}

function getPendientesPorProveedor(cicloId, periodo) {
  return db.prepare(`
    SELECT pa.proveedor, COUNT(*) AS num_items, SUM(pa.subtotal) AS total_estimado
    FROM pedido_asignaciones pa
    JOIN demanda_pedido_detalles dpd ON dpd.id = pa.demanda_detalle_id
    JOIN demandas_pedido dp ON dp.id = dpd.demanda_id
    WHERE dp.ciclo_id = ? AND dp.periodo = ?
      AND pa.orden_compra_id IS NULL AND pa.cantidad_asignada > 0
    GROUP BY pa.proveedor
    ORDER BY pa.proveedor
  `).all(cicloId, periodo);
}

function generarOrdenCompra(cicloId, periodo, proveedor, creadoPor) {
  const items = db.prepare(`
    SELECT pa.id AS asignacion_id, dpd.codigo, dpd.producto, c.presentacion,
           pa.cantidad_asignada, pa.precio_unitario, pa.subtotal
    FROM pedido_asignaciones pa
    JOIN demanda_pedido_detalles dpd ON dpd.id = pa.demanda_detalle_id
    JOIN demandas_pedido dp ON dp.id = dpd.demanda_id
    LEFT JOIN catalogo c ON c.codigo = dpd.codigo
    WHERE dp.ciclo_id = ? AND dp.periodo = ? AND pa.proveedor = ?
      AND pa.orden_compra_id IS NULL AND pa.cantidad_asignada > 0
  `).all(cicloId, periodo, proveedor);

  if (items.length === 0) {
    const err = new Error("Este proveedor no tiene asignaciones pendientes de orden de compra en este ciclo/periodo.");
    err.codigo = "SIN_PENDIENTES";
    throw err;
  }

  // El precio de la orden es el PRECIO FINAL NEGOCIADO (Hoja de negociación); si falta, se bloquea la orden
  const _preciosFinales = preciosFinalesNegociados(cicloId);
  items.forEach((it) => {
    const pf = _preciosFinales.get(llavePC(proveedor, it.codigo));
    it.precio_unitario = pf != null ? pf : null;
    it.subtotal = pf != null ? Number(it.cantidad_asignada) * pf : 0;
  });

  const sinPrecio = items.filter((it) => !(Number(it.precio_unitario) > 0));
  if (sinPrecio.length > 0) {
    const err = new Error("Faltan precios finales negociados; no se puede generar la orden. Productos: " + sinPrecio.map((it) => it.codigo + " " + it.producto).join(", "));
    err.codigo = "SIN_PRECIO";
    throw err;
  }

  const subtotal = items.reduce((s, it) => s + Number(it.subtotal || 0), 0);
  const ahora = new Date().toISOString();

  const crear = db.transaction(() => {
    const numero = siguienteNumeroOC();
    const info = db.prepare(`
      INSERT INTO ordenes_compra_v2 (numero, proveedor, ciclo_id, periodo, estado, subtotal, total, creado_en, creado_por)
      VALUES (?, ?, ?, ?, 'emitida', ?, ?, ?, ?)
    `).run(numero, proveedor, cicloId, periodo, subtotal, subtotal, ahora, creadoPor || null);

    const ordenId = info.lastInsertRowid;
    const insertarItem = db.prepare(`
      INSERT INTO orden_compra_v2_items (orden_compra_id, pedido_asignacion_id, codigo, producto, presentacion, cantidad, precio_unitario, subtotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const marcarAsignacion = db.prepare("UPDATE pedido_asignaciones SET orden_compra_id = ? WHERE id = ?");

    items.forEach((it) => {
      insertarItem.run(ordenId, it.asignacion_id, it.codigo, it.producto, it.presentacion || "", it.cantidad_asignada, it.precio_unitario, it.subtotal);
      marcarAsignacion.run(ordenId, it.asignacion_id);
    });

    return ordenId;
  });

  return getOrdenCompraPorId(crear());
}

function getOrdenCompraPorId(id) {
  const orden = db.prepare("SELECT * FROM ordenes_compra_v2 WHERE id = ?").get(id);
  if (!orden) return null;
  const items = db.prepare("SELECT * FROM orden_compra_v2_items WHERE orden_compra_id = ? ORDER BY id").all(id);
  return { orden, items };
}

function listarOrdenesCompra() {
  return db.prepare("SELECT * FROM ordenes_compra_v2 ORDER BY id DESC").all();
}

async function generarExcelOrdenCompra(orden, items, res) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Orden de Compra");

  sheet.getCell("A1").value = "MERCALDAS ORDEN DE COMPRA";
  sheet.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF1C8B3C" } };

  sheet.getCell("A2").value = orden.numero;
  sheet.getCell("A2").font = { bold: true, size: 12 };

  sheet.getCell("A4").value = "Proveedor:";
  sheet.getCell("B4").value = orden.proveedor;
  sheet.getCell("C4").value = "Fecha y hora:";
  sheet.getCell("D4").value = new Date(orden.creado_en).toLocaleString("es-CO");

  sheet.getCell("A5").value = "Ciclo/Periodo:";
  sheet.getCell("B5").value = `${orden.ciclo_id} - ${orden.periodo}`;
  sheet.getCell("C5").value = "Solicitado por:";
  sheet.getCell("D5").value = orden.creado_por || "—";

  const headerRow = sheet.getRow(7);
  headerRow.values = ["PLU", "Descripción", "Cantidad", "Unidad", "Costo unidad", "Costo total"];
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C8B3C" } };
  });

  let fila = 8;
  items.forEach((it) => {
    sheet.getRow(fila).values = [it.codigo, it.producto, it.cantidad, it.presentacion, it.precio_unitario, it.subtotal];
    fila++;
  });

  sheet.getCell(`A${fila + 1}`).value = "Total general";
  sheet.getCell(`A${fila + 1}`).font = { bold: true };
  sheet.getCell(`F${fila + 1}`).value = orden.total;
  sheet.getCell(`F${fila + 1}`).font = { bold: true };

  sheet.columns = [{ width: 10 }, { width: 32 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }];
  sheet.getColumn(5).numFmt = "$ #,##0";
  sheet.getColumn(6).numFmt = "$ #,##0";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${orden.numero}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

// ---------- Orden de compra con PRECIO FINAL NEGOCIADO + PDF + vista previa por proveedor ----------
/*oc-pdf-negociado*/
const fs = require("fs");
const path = require("path");

function claveNorm(v) {
  return String(v == null ? "" : v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
}
function llavePC(proveedor, codigo) {
  return claveNorm(proveedor) + "|" + String(codigo == null ? "" : codigo).trim();
}

// Precio final de la negociación (Hoja de negociación) por proveedor+PLU del ciclo
function preciosFinalesNegociados(cicloId) {
  const mapa = new Map();
  try {
    db.prepare(`
      SELECT n.proveedor AS proveedor, p.codigo AS codigo, p.precio_final AS precio
      FROM negociacion_unificada_productos p
      JOIN negociaciones_unificadas n ON n.id = p.negociacion_id
      WHERE n.ciclo_id = ? AND p.precio_final IS NOT NULL AND p.precio_final > 0
    `).all(cicloId).forEach((r) => mapa.set(llavePC(r.proveedor, r.codigo), Number(r.precio)));
  } catch (e) {
    console.error("[OC] precios finales:", e.message);
  }
  return mapa;
}

function asignacionesProveedor(cicloId, periodo, proveedor) {
  return db.prepare(`
    SELECT pa.id AS asignacion_id, pa.proveedor, pa.orden_compra_id, dpd.codigo, dpd.producto,
           c.presentacion, pa.cantidad_asignada
    FROM pedido_asignaciones pa
    JOIN demanda_pedido_detalles dpd ON dpd.id = pa.demanda_detalle_id
    JOIN demandas_pedido dp ON dp.id = dpd.demanda_id
    LEFT JOIN catalogo c ON c.codigo = dpd.codigo
    WHERE dp.ciclo_id = ? AND dp.periodo = ? AND pa.proveedor = ? AND pa.cantidad_asignada > 0
    ORDER BY dpd.producto
  `).all(cicloId, periodo, proveedor);
}

// Cuadro con TODOS los proveedores del pedido, en orden alfabético
function resumenProveedores(cicloId, periodo) {
  const filas = db.prepare(`
    SELECT pa.proveedor, pa.orden_compra_id, dpd.codigo, pa.cantidad_asignada
    FROM pedido_asignaciones pa
    JOIN demanda_pedido_detalles dpd ON dpd.id = pa.demanda_detalle_id
    JOIN demandas_pedido dp ON dp.id = dpd.demanda_id
    WHERE dp.ciclo_id = ? AND dp.periodo = ? AND pa.cantidad_asignada > 0
  `).all(cicloId, periodo);
  const precios = preciosFinalesNegociados(cicloId);
  const porProv = new Map();
  filas.forEach((f) => {
    if (!porProv.has(f.proveedor)) porProv.set(f.proveedor, { proveedor: f.proveedor, productos: 0, pendientes: 0, sin_precio: 0, total_estimado: 0, ordenes: new Set() });
    const g = porProv.get(f.proveedor);
    g.productos++;
    if (f.orden_compra_id) { g.ordenes.add(f.orden_compra_id); return; }
    g.pendientes++;
    const p = precios.get(llavePC(f.proveedor, f.codigo));
    if (p == null) g.sin_precio++; else g.total_estimado += p * Number(f.cantidad_asignada);
  });
  const ordenesPorId = new Map(db.prepare("SELECT id, numero FROM ordenes_compra_v2").all().map((o) => [o.id, o.numero]));
  return [...porProv.values()].map((g) => ({
    proveedor: g.proveedor,
    productos: g.productos,
    pendientes: g.pendientes,
    sin_precio: g.sin_precio,
    total_estimado: Math.round(g.total_estimado),
    estado: g.pendientes === 0 ? "emitida" : g.sin_precio > 0 ? "faltan_precios" : "listo",
    ordenes: [...g.ordenes].sort((a, b) => b - a).map((id) => ({ id, numero: ordenesPorId.get(id) })),
  })).sort((a, b) => a.proveedor.localeCompare(b.proveedor, "es"));
}

// Vista previa de lo que se le va a pedir al proveedor
function vistaPreviaProveedor(cicloId, periodo, proveedor) {
  const precios = preciosFinalesNegociados(cicloId);
  const todas = asignacionesProveedor(cicloId, periodo, proveedor);
  const pendientes = todas.filter((f) => !f.orden_compra_id);
  const items = pendientes.map((f) => {
    const precio = precios.has(llavePC(proveedor, f.codigo)) ? precios.get(llavePC(proveedor, f.codigo)) : null;
    const pedido = Number(f.cantidad_asignada);
    return { codigo: f.codigo, producto: f.producto, presentacion: f.presentacion || "", pedido, precio, total: precio == null ? null : Math.round(precio * pedido), falta_precio: precio == null };
  });
  const ordenIds = [...new Set(todas.filter((f) => f.orden_compra_id).map((f) => f.orden_compra_id))];
  const ordenes = ordenIds.length
    ? db.prepare(`SELECT id, numero, total, creado_en FROM ordenes_compra_v2 WHERE id IN (${ordenIds.map(() => "?").join(",")}) ORDER BY id DESC`).all(...ordenIds)
    : [];
  return {
    proveedor,
    items,
    sin_precio: items.filter((i) => i.falta_precio).length,
    total: items.reduce((s, i) => s + (i.total || 0), 0),
    listo: items.length > 0 && items.every((i) => !i.falta_precio),
    ordenes,
  };
}

function numeroDe(numero) {
  return Number(String(numero || "").replace(/^\D+/, "")) || 0;
}
function maxNumeroEmitido() {
  return db.prepare("SELECT numero FROM ordenes_compra_v2").all().reduce((m, r) => Math.max(m, numeroDe(r.numero)), 0);
}
function configNumeracion() {
  const fila = db.prepare("SELECT value FROM settings WHERE key = 'oc_consecutivo_v2'").get();
  const ultimo = Number(fila && fila.value) || 0;
  return { siguiente: ultimo + 1, ultimo_emitido: maxNumeroEmitido(), minimo: 1, maximo: 10000, prefijo: process.env.APP_ENV === "dev" ? "PRUEBA-OC-" : "OC-" };
}

// NIT: se busca en cualquier tabla que tenga una columna de NIT y otra de nombre del proveedor
function buscarNit(proveedor) {
  try {
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    for (const t of tablas) {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      const colNit = cols.find((c) => /^(nit|nit_proveedor|documento)$/i.test(c));
      const colNom = cols.find((c) => /^(nombre|proveedor|razon_social)$/i.test(c));
      if (!colNit || !colNom) continue;
      const fila = db.prepare(`SELECT "${colNit}" AS nit FROM "${t}" WHERE UPPER(TRIM("${colNom}")) = ? LIMIT 1`).get(String(proveedor).trim().toUpperCase());
      if (fila && fila.nit) return String(fila.nit);
    }
  } catch (e) { /* sin NIT */ }
  return "";
}

function rutaLogo() {
  for (const ext of ["png", "jpg", "jpeg"]) {
    const p = path.join(__dirname, "..", "public", "assets", "logo-mercaldas." + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function enviarPdfOrdenCompra(orden, items, res) {
  const { generarPdfOrdenCompra } = require("./oc_pdf"); // se carga aquí para que, si falta pdfkit, no se caiga todo el servidor
  const buffer = await generarPdfOrdenCompra(
    { numero: orden.numero, proveedor: orden.proveedor, nit: buscarNit(orden.proveedor), creado_en: orden.creado_en, solicitado_por: orden.creado_por, otros: 0, otro_rubro: 0 },
    items.map((it) => ({ codigo: it.codigo, descripcion: it.producto, cantidad: it.cantidad, unidad: String(it.presentacion || "").toUpperCase(), precio: it.precio_unitario, iva: 0 })),
    rutaLogo()
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${orden.numero}.pdf"`);
  res.send(buffer);
}

// ---------- Registro de rutas (llamado una sola vez desde server.js) ----------
module.exports = function registrarRutasOrdenesCompra(app, requireAdmin) {
  app.get("/api/ordenes-compra/pendientes", requireAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo_id || "").trim();
    const periodo = String(req.query.periodo || "LUNES-MARTES").trim().toUpperCase();
    if (!ciclo) return res.status(400).json({ error: "Falta seleccionar el ciclo." });
    res.json(getPendientesPorProveedor(ciclo, periodo));
  });

  app.post("/api/ordenes-compra/generar", requireAdmin, (req, res) => {
    try {
      const ciclo = String(req.body.ciclo_id || "").trim();
      const periodo = String(req.body.periodo || "LUNES-MARTES").trim().toUpperCase();
      const proveedor = String(req.body.proveedor || "").trim();
      if (!ciclo || !proveedor) return res.status(400).json({ error: "Falta ciclo o proveedor." });
      const resultado = generarOrdenCompra(ciclo, periodo, proveedor, req.usuarioActual && req.usuarioActual.usuario);
      res.json(resultado);
    } catch (err) {
      if (err.codigo === "SIN_PENDIENTES" || err.codigo === "SIN_PRECIO") return res.status(400).json({ error: err.message });
      console.error("[ORDEN COMPRA ERROR]", err);
      res.status(500).json({ error: "Error generando la orden de compra." });
    }
  });

  app.get("/api/ordenes-compra", requireAdmin, (req, res) => {
    res.json(listarOrdenesCompra());
  });

  app.get("/api/ordenes-compra/:id/excel", requireAdmin, async (req, res) => {
    try {
      const data = getOrdenCompraPorId(req.params.id);
      if (!data) return res.status(404).json({ error: "Orden de compra no encontrada." });
      await generarExcelOrdenCompra(data.orden, data.items, res);
    } catch (err) {
      console.error("[ORDEN COMPRA EXCEL ERROR]", err);
      res.status(500).json({ error: "Error generando el Excel." });
    }
  });

  // ---- Orden de compra con precio final negociado, PDF y numeración ----
  app.get("/api/ordenes-compra/resumen", requireAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo_id || "").trim();
    const periodo = String(req.query.periodo || "LUNES-MARTES").trim().toUpperCase();
    if (!ciclo) return res.status(400).json({ error: "Falta seleccionar el ciclo." });
    res.json(resumenProveedores(ciclo, periodo));
  });

  app.get("/api/ordenes-compra/preliminar", requireAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo_id || "").trim();
    const periodo = String(req.query.periodo || "LUNES-MARTES").trim().toUpperCase();
    const proveedor = String(req.query.proveedor || "").trim();
    if (!ciclo || !proveedor) return res.status(400).json({ error: "Falta ciclo o proveedor." });
    res.json(vistaPreviaProveedor(ciclo, periodo, proveedor));
  });

  app.get("/api/ordenes-compra/config", requireAdmin, (req, res) => {
    res.json(configNumeracion());
  });

  app.post("/api/ordenes-compra/config", requireAdmin, (req, res) => {
    const inicio = Number(req.body && req.body.inicio);
    if (!Number.isInteger(inicio) || inicio < 1 || inicio > 10000) return res.status(400).json({ error: "El número inicial debe ser un entero entre 1 y 10000." });
    const maxEmitido = maxNumeroEmitido();
    if (inicio <= maxEmitido) return res.status(400).json({ error: "Ya existe la orden número " + maxEmitido + ". El número inicial debe ser mayor que " + maxEmitido + "." });
    db.prepare("INSERT INTO settings (key, value) VALUES ('oc_consecutivo_v2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(inicio - 1));
    res.json(configNumeracion());
  });

  app.get("/api/ordenes-compra/:id/pdf", requireAdmin, async (req, res) => {
    try {
      const data = getOrdenCompraPorId(req.params.id);
      if (!data) return res.status(404).json({ error: "Orden de compra no encontrada." });
      await enviarPdfOrdenCompra(data.orden, data.items, res);
    } catch (err) {
      console.error("[ORDEN COMPRA PDF ERROR]", err);
      const falta = err && err.code === "MODULE_NOT_FOUND";
      res.status(500).json({ error: falta ? "Falta instalar la librería pdfkit en el servidor." : "Error generando el PDF." });
    }
  });
};
