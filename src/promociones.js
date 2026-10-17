"use strict";
const ExcelJS = require("exceljs");
const db = require("./db");

// ---------------------------------------------------------------------------
// PRODUCTOS EN PROMOCIÓN
// Un producto está en promoción cuando su PRECIO FINAL (el acordado en la negociación, por el Excel del
// proveedor o puesto a mano) es 15% o más bajo que el MEJOR precio de la semana anterior: el más bajo que
// cualquier proveedor ofreció, calculado con la misma regla del Comparativo. 20% o más = promoción fuerte.
// ---------------------------------------------------------------------------
const UMBRAL_PROMOCION = 15;
const UMBRAL_FUERTE = 20;

const REQUERIDAS = {
  ciclos: ["id", "fecha_inicio_vigencia", "fecha_fin_vigencia"],
  quotes: ["codigo", "precio", "proveedor", "ciclo_id"],
  negociaciones_unificadas: ["id", "ciclo_id", "proveedor"],
  negociacion_unificada_productos: ["negociacion_id", "codigo", "producto", "propuesta_inicial", "precio_final", "estado"],
};

function columnasDe(tabla) {
  return new Set(db.prepare('PRAGMA table_info("' + tabla + '")').all().map((c) => c.name));
}

function esquemaFaltante() {
  const falta = [];
  for (const [tabla, cols] of Object.entries(REQUERIDAS)) {
    const reales = columnasDe(tabla);
    cols.filter((c) => !reales.has(c)).forEach((c) => falta.push(tabla + "." + c));
  }
  return falta;
}

function leerAjuste(clave) {
  try {
    const f = db.prepare("SELECT value FROM settings WHERE key = ?").get(clave);
    return f && f.value != null ? f.value : null;
  } catch (e) {
    return null;
  }
}

function umbrales() {
  const p = Number(leerAjuste("promo_umbral_promocion"));
  const f = Number(leerAjuste("promo_umbral_fuerte"));
  const promocion = Number.isFinite(p) && p > 0 && p < 100 ? p : UMBRAL_PROMOCION;
  const fuerte = Number.isFinite(f) && f > promocion && f < 100 ? f : UMBRAL_FUERTE > promocion ? UMBRAL_FUERTE : promocion + 5;
  return { promocion, fuerte };
}

// Número de semanas ISO de un año (la semana del 28 de diciembre).
function semanasDelAnio(anio) {
  const d = new Date(Date.UTC(anio, 11, 28));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const inicio = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - inicio) / 86400000 + 1) / 7);
}

// COT-2026-41 -> COT-2026-40. La semana 1 pasa a la última del año anterior.
function cicloAnteriorId(id) {
  const m = /^COT-(\d{4})-(\d{1,2})$/.exec(String(id || ""));
  if (!m) return null;
  let anio = Number(m[1]);
  let semana = Number(m[2]) - 1;
  if (semana < 1) {
    anio -= 1;
    semana = semanasDelAnio(anio);
  }
  return "COT-" + anio + "-" + String(semana).padStart(2, "0");
}

function etiquetaCiclo(id) {
  const m = /^COT-(\d{4})-(\d{1,2})$/.exec(String(id || ""));
  return m ? "Semana " + Number(m[2]) + " (" + id + ")" : String(id || "");
}

function cicloPorDefecto() {
  const existe = (id) => (id ? db.prepare("SELECT id FROM ciclos WHERE id = ?").get(String(id)) : null);
  const trabajo = leerAjuste("semana_trabajo_id");
  if (existe(trabajo)) return String(trabajo);
  const activo = leerAjuste("ciclo_activo_id");
  if (existe(activo)) return String(activo);
  return null;
}

// Precios finales acordados (por Excel del proveedor o a mano) de una semana.
const SQL_FINALES =
  "SELECT n.proveedor AS proveedor, p.codigo AS codigo, p.producto AS producto, p.presentacion AS presentacion, " +
  "p.propuesta_inicial AS cotizado, p.precio_final AS precio_final " +
  "FROM negociacion_unificada_productos p JOIN negociaciones_unificadas n ON n.id = p.negociacion_id " +
  "WHERE n.ciclo_id = ? AND p.estado = 'acuerdo' AND p.precio_final IS NOT NULL AND p.precio_final > 0";

// El mejor precio de la semana anterior, por producto: el más bajo cotizado (misma regla del Comparativo);
// si ese mismo producto se negoció aún más bajo esa semana, cuenta el precio negociado.
function referenciaAnterior(cicloId, deps) {
  const ref = new Map();
  let filas = [];
  try {
    filas = deps.computeComparativo(deps.getAllQuotes(cicloId), 0);
  } catch (e) {
    console.error("[promociones] no pude calcular el comparativo de " + cicloId + ":", e.message);
  }
  for (const r of filas) {
    const precio = Number(r.precioMin);
    if (precio > 0) ref.set(String(r.codigo), { precio, proveedor: r.proveedorMin || "", origen: "cotizado" });
  }
  for (const f of db.prepare(SQL_FINALES).all(cicloId)) {
    const k = String(f.codigo);
    const actual = ref.get(k);
    if (!actual || f.precio_final < actual.precio) ref.set(k, { precio: f.precio_final, proveedor: f.proveedor, origen: "negociado" });
  }
  return ref;
}

function calcular(cicloId, deps) {
  const ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(cicloId);
  if (!ciclo) return null;
  const um = umbrales();
  const antId = cicloAnteriorId(cicloId);
  const anterior = antId ? db.prepare("SELECT id FROM ciclos WHERE id = ?").get(antId) : null;

  const finales = db.prepare(SQL_FINALES).all(cicloId);
  const sinPrecioFinal = db
    .prepare(
      "SELECT COUNT(*) AS n FROM negociacion_unificada_productos p JOIN negociaciones_unificadas n ON n.id = p.negociacion_id " +
        "WHERE n.ciclo_id = ? AND NOT (p.estado = 'acuerdo' AND p.precio_final IS NOT NULL AND p.precio_final > 0)"
    )
    .get(cicloId).n;

  const filas = [];
  let sinReferencia = 0;
  if (anterior) {
    const ref = referenciaAnterior(anterior.id, deps);
    for (const f of finales) {
      const r = ref.get(String(f.codigo));
      if (!r) {
        sinReferencia++;
        continue;
      }
      const baja = Math.round(((r.precio - f.precio_final) / r.precio) * 1000) / 10;
      if (baja < um.promocion) continue;
      filas.push({
        codigo: f.codigo,
        producto: f.producto || "",
        presentacion: f.presentacion || "",
        proveedor: f.proveedor,
        precio_final: f.precio_final,
        referencia: r.precio,
        referencia_proveedor: r.proveedor,
        referencia_origen: r.origen,
        ahorro: Math.round((r.precio - f.precio_final) * 100) / 100,
        baja_pct: baja,
        nivel: baja >= um.fuerte ? "fuerte" : "promocion",
      });
    }
    filas.sort((a, b) => b.baja_pct - a.baja_pct || String(a.producto).localeCompare(String(b.producto)) || String(a.proveedor).localeCompare(String(b.proveedor)));
  }

  const fuertes = filas.filter((f) => f.nivel === "fuerte").length;
  return {
    ciclo: {
      id: ciclo.id,
      etiqueta: etiquetaCiclo(ciclo.id),
      fecha_inicio_vigencia: ciclo.fecha_inicio_vigencia || null,
      fecha_fin_vigencia: ciclo.fecha_fin_vigencia || null,
    },
    anterior: antId ? { id: antId, existe: !!anterior } : null,
    umbrales: um,
    resumen: {
      evaluados: finales.length,
      promociones: filas.length,
      fuertes,
      normales: filas.length - fuertes,
      sin_referencia: anterior ? sinReferencia : 0,
      sin_precio_final: sinPrecioFinal,
    },
    filas,
  };
}

async function generarExcel(d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Comparador de Cotizaciones Mercaldas";
  const ws = wb.addWorksheet("Promociones");
  const prueba = process.env.APP_ENV === "dev" ? " (PRUEBAS)" : "";
  ws.mergeCells("A1:J1");
  ws.getCell("A1").value = "Productos en promoción — " + d.ciclo.etiqueta + prueba;
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.mergeCells("A2:J2");
  ws.getCell("A2").value =
    "Precio final de la semana frente al mejor precio de la semana anterior" + (d.anterior ? " (" + d.anterior.id + ")" : "") +
    ". Promoción: baja de " + d.umbrales.promocion + "% o más. Fuerte: " + d.umbrales.fuerte + "% o más.";
  ws.mergeCells("A3:J3");
  ws.getCell("A3").value = "Vigencia de la semana: " + (d.ciclo.fecha_inicio_vigencia || "—") + " al " + (d.ciclo.fecha_fin_vigencia || "—");

  const encabezado = ["Nivel", "Código", "Producto", "Presentación", "Proveedor", "Precio final", "Mejor precio semana anterior", "Lo ofreció (semana anterior)", "Ahorro por unidad", "Baja %"];
  const fila = ws.getRow(5);
  fila.values = encabezado;
  fila.font = { bold: true };
  fila.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF4" } };
    c.alignment = { vertical: "middle", wrapText: true };
  });

  let n = 6;
  for (const f of d.filas) {
    const r = ws.getRow(n++);
    r.values = [
      f.nivel === "fuerte" ? "Promoción fuerte" : "Promoción",
      f.codigo,
      f.producto,
      f.presentacion,
      f.proveedor,
      f.precio_final,
      f.referencia,
      (f.referencia_proveedor || "—") + " (" + f.referencia_origen + ")",
      f.ahorro,
      f.baja_pct,
    ];
    if (f.nivel === "fuerte") r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7D9" } };
    [6, 7, 9].forEach((k) => (r.getCell(k).numFmt = '"$"#,##0'));
    r.getCell(10).numFmt = '0.0"%"';
  }
  if (!d.filas.length) {
    ws.mergeCells("A6:J6");
    ws.getCell("A6").value = "Ningún producto con precio final bajó " + d.umbrales.promocion + "% o más frente a la semana anterior.";
  }
  [16, 10, 36, 16, 26, 14, 18, 30, 16, 10].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.views = [{ state: "frozen", ySplit: 5 }];
  return wb.xlsx.writeBuffer();
}

// ---------- Rutas ----------
module.exports = function registrarPromociones(app, requireAdmin, deps) {
  if (!deps || typeof deps.getAllQuotes !== "function" || typeof deps.computeComparativo !== "function") {
    console.error("[promociones] NO se registró: el servidor no entregó getAllQuotes y computeComparativo.");
    return;
  }
  const falta = esquemaFaltante();
  if (falta.length) {
    console.error("[promociones] NO se registró: faltan columnas esperadas: " + falta.join(", "));
    return;
  }

  const resolver = (req) => String(req.query.ciclo || "").trim() || cicloPorDefecto();

  app.get("/api/promociones", requireAdmin, (req, res) => {
    try {
      const ciclo = resolver(req);
      if (!ciclo) return res.status(404).json({ error: "Todavía no hay una semana de trabajo." });
      const datos = calcular(ciclo, deps);
      if (!datos) return res.status(404).json({ error: "Esa semana no existe." });
      res.json(datos);
    } catch (e) {
      console.error("[promociones] calcular:", e);
      res.status(500).json({ error: "No se pudieron calcular las promociones." });
    }
  });

  app.get("/api/promociones/exportar", requireAdmin, async (req, res) => {
    try {
      const ciclo = resolver(req);
      const datos = ciclo ? calcular(ciclo, deps) : null;
      if (!datos) return res.status(404).json({ error: "Esa semana no existe." });
      const buffer = await generarExcel(datos);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="PRODUCTOS_EN_PROMOCION_' + datos.ciclo.id + '.xlsx"');
      res.send(Buffer.from(buffer));
    } catch (e) {
      console.error("[promociones] exportar:", e);
      res.status(500).json({ error: "No se pudo generar el Excel." });
    }
  });

  console.log("Productos en promoción listos (/api/promociones)");
};

module.exports.cicloAnteriorId = cicloAnteriorId;
module.exports.semanasDelAnio = semanasDelAnio;
