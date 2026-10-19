// Indicadores de gestión de compra: compra por proveedor y evolución de precios (solo lectura).
const db = require("./db");
const ExcelJS = require("exceljs");

function claveNorm(v) {
  return String(v == null ? "" : v).normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toUpperCase();
}
const llave = (prov, cod) => claveNorm(prov) + "|" + String(cod == null ? "" : cod).trim();
const r2 = (n) => Math.round(n * 100) / 100;

function ciclosDisponibles() {
  const a = db.prepare("SELECT DISTINCT ciclo_id FROM negociaciones_unificadas").all();
  const b = db.prepare("SELECT DISTINCT ciclo_id FROM demandas_pedido").all();
  return [...new Set([...a, ...b].map((r) => r.ciclo_id).filter(Boolean))].sort();
}
function periodosDe(ciclo) {
  return db.prepare("SELECT DISTINCT periodo FROM demandas_pedido WHERE ciclo_id = ? ORDER BY periodo").all(ciclo).map((r) => r.periodo);
}

// ---- Precios finales negociados por ciclo ----
function filasPrecios(ciclo) {
  return db.prepare(`
    SELECT n.proveedor AS proveedor, p.codigo AS codigo, p.producto AS producto, p.presentacion AS presentacion, p.precio_final AS precio
    FROM negociacion_unificada_productos p
    JOIN negociaciones_unificadas n ON n.id = p.negociacion_id
    WHERE n.ciclo_id = ? AND p.precio_final IS NOT NULL AND p.precio_final > 0
  `).all(ciclo);
}
function mapaPrecios(ciclo) {
  const m = new Map();
  filasPrecios(ciclo).forEach((r) => m.set(llave(r.proveedor, r.codigo), Number(r.precio)));
  return m;
}
// Por PLU: promedio, mínimo y proveedor del mínimo
function resumenPorPlu(ciclo) {
  const por = new Map();
  filasPrecios(ciclo).forEach((r) => {
    const k = String(r.codigo).trim();
    if (!por.has(k)) por.set(k, { codigo: k, producto: r.producto, presentacion: r.presentacion, suma: 0, n: 0, min: Infinity, prov_min: "" });
    const g = por.get(k);
    const p = Number(r.precio);
    g.suma += p; g.n++;
    if (p < g.min) { g.min = p; g.prov_min = r.proveedor; }
  });
  por.forEach((g) => { g.prom = g.suma / g.n; });
  return por;
}
function ciclosConPrecios() {
  return db.prepare(`
    SELECT DISTINCT n.ciclo_id AS c FROM negociacion_unificada_productos p
    JOIN negociaciones_unificadas n ON n.id = p.negociacion_id
    WHERE p.precio_final IS NOT NULL AND p.precio_final > 0 ORDER BY 1
  `).all().map((r) => r.c);
}

function evolucionPrecios(ciclo) {
  const todos = ciclosConPrecios();
  const hasta = todos.filter((c) => c <= ciclo);
  const previo = todos.filter((c) => c < ciclo).pop() || null;
  const ventana = hasta.slice(-6);
  const res = new Map(ventana.map((c) => [c, resumenPorPlu(c)]));
  const actual = res.get(ciclo) || resumenPorPlu(ciclo);
  const ant = previo ? (res.get(previo) || resumenPorPlu(previo)) : new Map();
  const filas = [];
  actual.forEach((g, cod) => {
    const a = ant.get(cod);
    const dif = a ? g.prom - a.prom : null;
    const pct = a && a.prom > 0 ? (dif / a.prom) * 100 : null;
    filas.push({
      codigo: cod, producto: g.producto, presentacion: g.presentacion || "",
      prom_actual: r2(g.prom), prom_previo: a ? r2(a.prom) : null,
      dif: dif == null ? null : r2(dif), pct: pct == null ? null : r2(pct),
      minimo: r2(g.min), prov_min: g.prov_min, proveedores: g.n,
      serie: ventana.map((c) => { const x = res.get(c).get(cod); return x ? r2(x.prom) : null; }),
    });
  });
  filas.sort((x, y) => Math.abs(y.pct == null ? 0 : y.pct) - Math.abs(x.pct == null ? 0 : x.pct) || String(x.producto).localeCompare(String(y.producto), "es"));
  return {
    ciclo_previo: previo, ventana,
    cobertura: { con_precio: filas.length, comparables: filas.filter((f) => f.pct != null).length },
    resumen: {
      alzas: filas.filter((f) => f.pct != null && f.pct > 0.005).length,
      bajas: filas.filter((f) => f.pct != null && f.pct < -0.005).length,
      sin_cambio: filas.filter((f) => f.pct != null && Math.abs(f.pct) <= 0.005).length,
    },
    filas,
  };
}

// ---- Compra por proveedor (pedido distribuido × precio final negociado) ----
function ciclosConPedido(periodo) {
  return db.prepare(`
    SELECT DISTINCT dp.ciclo_id AS c FROM pedido_asignaciones pa
    JOIN demanda_pedido_detalles dpd ON dpd.id = pa.demanda_detalle_id
    JOIN demandas_pedido dp ON dp.id = dpd.demanda_id
    WHERE pa.cantidad_asignada > 0 AND (? = '' OR dp.periodo = ?) ORDER BY 1
  `).all(periodo, periodo).map((r) => r.c);
}
function compraCiclo(ciclo, periodo) {
  const filas = db.prepare(`
    SELECT pa.proveedor AS proveedor, dpd.codigo AS codigo, pa.cantidad_asignada AS cant,
           pa.subtotal AS subtotal, pa.precio_unitario AS pu
    FROM pedido_asignaciones pa
    JOIN demanda_pedido_detalles dpd ON dpd.id = pa.demanda_detalle_id
    JOIN demandas_pedido dp ON dp.id = dpd.demanda_id
    WHERE dp.ciclo_id = ? AND (? = '' OR dp.periodo = ?) AND pa.cantidad_asignada > 0
  `).all(ciclo, periodo, periodo);
  const precios = mapaPrecios(ciclo);
  const por = new Map();
  let lineas = 0, finales = 0;
  filas.forEach((f) => {
    if (!por.has(f.proveedor)) por.set(f.proveedor, { proveedor: f.proveedor, productos: 0, valor: 0, con_final: 0 });
    const g = por.get(f.proveedor);
    const pf = precios.get(llave(f.proveedor, f.codigo));
    let v;
    if (pf != null) { v = Number(f.cant) * pf; g.con_final++; finales++; }
    else v = Number(f.subtotal) > 0 ? Number(f.subtotal) : Number(f.cant) * (Number(f.pu) || 0);
    g.productos++; g.valor += v; lineas++;
  });
  const total = [...por.values()].reduce((s, g) => s + g.valor, 0);
  const lista = [...por.values()].map((g) => ({
    proveedor: g.proveedor, productos: g.productos, valor: Math.round(g.valor),
    pct: total > 0 ? r2((g.valor / total) * 100) : 0,
    pct_final: g.productos ? Math.round((g.con_final / g.productos) * 100) : 0,
  })).sort((a, b) => b.valor - a.valor);
  return { ciclo, total: Math.round(total), lineas, lineas_final: finales, proveedores: lista };
}

function indicadores(ciclo, periodo) {
  const actual = compraCiclo(ciclo, periodo);
  const previoId = ciclosConPedido(periodo).filter((c) => c < ciclo).pop() || null;
  const previo = previoId ? compraCiclo(previoId, periodo) : null;
  const mapPrev = new Map((previo ? previo.proveedores : []).map((p) => [claveNorm(p.proveedor), p.valor]));
  actual.proveedores.forEach((p) => {
    const v = mapPrev.get(claveNorm(p.proveedor));
    p.valor_previo = v == null ? null : v;
    p.pct_var = v ? r2(((p.valor - v) / v) * 100) : null;
  });
  const top3 = actual.proveedores.slice(0, 3).reduce((s, p) => s + p.pct, 0);
  const hhi = Math.round(actual.proveedores.reduce((s, p) => s + p.pct * p.pct, 0));
  return {
    ciclo, periodo,
    compra: {
      hay_pedido: actual.lineas > 0,
      ciclo_previo: previoId,
      total: actual.total, total_previo: previo ? previo.total : null,
      var_total_pct: actual.lineas > 0 && previo && previo.total > 0 ? r2(((actual.total - previo.total) / previo.total) * 100) : null,
      n_proveedores: actual.proveedores.length,
      top3_pct: r2(top3), hhi,
      pct_precio_final: actual.lineas ? Math.round((actual.lineas_final / actual.lineas) * 100) : 0,
      proveedores: actual.proveedores,
    },
    precios: evolucionPrecios(ciclo),
  };
}

module.exports = function registrarIndicadoresCompra(app, requireAdmin) {
  app.get("/api/indicadores-compra/ciclos", requireAdmin, (req, res) => {
    const ciclos = ciclosDisponibles();
    const periodos = {};
    ciclos.forEach((c) => { periodos[c] = periodosDe(c); });
    res.json({ ciclos, periodos, sugerido: ciclos[ciclos.length - 1] || "" });
  });

  app.get("/api/indicadores-compra", requireAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo_id || "").trim();
    const periodo = String(req.query.periodo || "").trim().toUpperCase();
    if (!ciclo) return res.status(400).json({ error: "Falta seleccionar el ciclo." });
    try { res.json(indicadores(ciclo, periodo)); }
    catch (e) { console.error("[INDICADORES]", e); res.status(500).json({ error: "No se pudieron calcular los indicadores." }); }
  });

  app.get("/api/indicadores-compra/excel", requireAdmin, async (req, res) => {
    const ciclo = String(req.query.ciclo_id || "").trim();
    const periodo = String(req.query.periodo || "").trim().toUpperCase();
    if (!ciclo) return res.status(400).json({ error: "Falta seleccionar el ciclo." });
    try {
      const d = indicadores(ciclo, periodo);
      const wb = new ExcelJS.Workbook();
      const s1 = wb.addWorksheet("Compra por proveedor");
      s1.addRow(["Proveedor", "Productos", "Valor comprado", "% participación", "Valor semana anterior (" + (d.compra.ciclo_previo || "—") + ")", "Variación %", "% líneas con precio final"]);
      d.compra.proveedores.forEach((p) => s1.addRow([p.proveedor, p.productos, p.valor, p.pct / 100, p.valor_previo, p.pct_var == null ? null : p.pct_var / 100, p.pct_final / 100]));
      s1.addRow([]); s1.addRow(["TOTAL", "", d.compra.total]);
      s1.getColumn(3).numFmt = "$#,##0"; s1.getColumn(5).numFmt = "$#,##0";
      [4, 6, 7].forEach((c) => { s1.getColumn(c).numFmt = "0.0%"; });
      const s2 = wb.addWorksheet("Evolución de precios");
      s2.addRow(["PLU", "Producto", "Presentación", "Promedio " + (d.precios.ciclo_previo || "anterior"), "Promedio " + ciclo, "Diferencia $", "Variación %", "Precio mínimo", "Proveedor del mínimo", "Proveedores"]);
      d.precios.filas.forEach((f) => s2.addRow([f.codigo, f.producto, f.presentacion, f.prom_previo, f.prom_actual, f.dif, f.pct == null ? null : f.pct / 100, f.minimo, f.prov_min, f.proveedores]));
      [4, 5, 6, 8].forEach((c) => { s2.getColumn(c).numFmt = "$#,##0"; });
      s2.getColumn(7).numFmt = "0.0%";
      [s1, s2].forEach((ws) => {
        ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
        ws.columns.forEach((c, i) => { c.width = i === 0 || (ws === s2 && (i === 1 || i === 8)) ? 34 : 18; });
      });
      const buf = await wb.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Indicadores_compra_${ciclo}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (e) {
      console.error("[INDICADORES EXCEL]", e);
      res.status(500).json({ error: "No se pudo generar el Excel." });
    }
  });
};
module.exports._indicadores = indicadores;
