"use strict";
const ExcelJS = require("exceljs");
const multer = require("multer");
const db = require("./db");
const { leerRespuesta, validar, alertasContrapropuesta } = require("./negociacion_lector");

// Numeración del historial (la misma que ya usa "iniciar"): 1 = cotización del proveedor,
// 2 = contrapropuesta de Mercaldas, 3 = respuesta del proveedor, 4 = nueva contrapropuesta, ...
// Una "ronda" que ve el usuario es el par (Mercaldas 2k, Proveedor 2k+1).
const MAX_RONDAS = 3;
const UMBRAL_ALERTA = 0.1;

const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const ahora = () => new Date().toISOString();
const moneda = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CO"));

function columnasDe(tabla) {
  return new Set(db.prepare('PRAGMA table_info("' + tabla + '")').all().map((c) => c.name));
}

const REQUERIDAS = {
  negociaciones_unificadas: ["id", "ciclo_id", "proveedor", "estado", "ronda_actual"],
  negociacion_unificada_productos: ["negociacion_id", "codigo", "producto", "propuesta_inicial", "contrapropuesta_mercaldas", "precio_final", "estado"],
  negociacion_unificada_historial: ["negociacion_id", "codigo", "ronda", "origen", "precio", "estado"],
};

function esquemaFaltante() {
  const falta = [];
  for (const [tabla, cols] of Object.entries(REQUERIDAS)) {
    const reales = columnasDe(tabla);
    cols.filter((c) => !reales.has(c)).forEach((c) => falta.push(tabla + "." + c));
  }
  return falta;
}

function negociacionPorId(id) {
  return db.prepare("SELECT * FROM negociaciones_unificadas WHERE id = ?").get(Number(id));
}

function insertarHistorial(negId, codigo, ronda, origen, precio, estado, observacion) {
  const campos = { negociacion_id: negId, codigo, ronda, origen, precio, estado, observacion, creado_en: ahora() };
  const cols = columnasDe("negociacion_unificada_historial");
  const usar = Object.keys(campos).filter((c) => cols.has(c));
  db.prepare("INSERT INTO negociacion_unificada_historial (" + usar.join(",") + ") VALUES (" + usar.map(() => "?").join(",") + ")").run(...usar.map((c) => campos[c]));
}

function actualizarProducto(negId, codigo, campos) {
  const cols = columnasDe("negociacion_unificada_productos");
  const todos = { ...campos, actualizado_en: ahora() };
  const usar = Object.keys(todos).filter((c) => cols.has(c));
  db.prepare("UPDATE negociacion_unificada_productos SET " + usar.map((c) => c + " = ?").join(", ") + " WHERE negociacion_id = ? AND codigo = ?").run(...usar.map((c) => todos[c]), negId, codigo);
}

// ---------- La hoja: una fila por producto y las rondas de izquierda a derecha ----------
function armarHoja(neg) {
  const productos = db.prepare("SELECT * FROM negociacion_unificada_productos WHERE negociacion_id = ? ORDER BY producto COLLATE NOCASE").all(neg.id);
  const eventos = db.prepare("SELECT * FROM negociacion_unificada_historial WHERE negociacion_id = ? ORDER BY id").all(neg.id);
  const porCodigo = {};
  for (const e of eventos) (porCodigo[e.codigo] = porCodigo[e.codigo] || []).push(e);

  const filas = productos.map((p) => {
    const lista = porCodigo[p.codigo] || [];
    const precioDe = (ronda, origen, estados) => {
      const m = lista.filter((e) => e.ronda === ronda && e.origen === origen && estados.includes(e.estado));
      return m.length ? m[m.length - 1].precio : null;
    };
    const cotizo = precioDe(1, "PROVEEDOR", ["propuesta_inicial"]) != null ? precioDe(1, "PROVEEDOR", ["propuesta_inicial"]) : p.propuesta_inicial;
    const rondas = [];
    let ultimaRonda = 1, proveedorActual = cotizo, contraActual = null;
    for (let k = 1; k <= MAX_RONDAS; k++) {
      let m = precioDe(2 * k, "MERCALDAS", ["contrapropuesta"]);
      if (k === 1 && m == null) m = p.contrapropuesta_mercaldas;
      const r = precioDe(2 * k + 1, "PROVEEDOR", ["respuesta_proveedor", "acepta_contrapropuesta"]);
      rondas.push({ mercaldas: m, proveedor: r });
      if (m != null) { ultimaRonda = 2 * k; contraActual = m; }
      if (r != null) { ultimaRonda = 2 * k + 1; proveedorActual = r; }
    }
    const estado = p.estado === "acuerdo" ? "acuerdo" : p.estado === "sin_acuerdo" ? "sin_acuerdo" : "abierto";
    const turno = estado === "abierto" ? (ultimaRonda % 2 === 0 ? "proveedor" : "mercaldas") : null;
    const ahorroExacto = estado === "acuerdo" && cotizo > 0 && p.precio_final != null ? ((cotizo - p.precio_final) / cotizo) * 100 : null;
    const ahorro = ahorroExacto == null ? null : Math.round(ahorroExacto * 10) / 10;
    const ultimo = lista.length ? lista[lista.length - 1] : null;
    const manual = estado === "acuerdo" && !!ultimo && ultimo.estado === "acuerdo_manual";
    return {
      codigo: p.codigo, producto: p.producto, presentacion: p.presentacion || "", cotizo, rondas,
      precio_final: p.precio_final, ahorro_pct: ahorro, ahorroExacto, estado, turno, ultimaRonda, proveedorActual, contraActual,
      manual, notaManual: manual ? ultimo.observacion || "" : "",
    };
  });

  const cuenta = (f) => filas.filter(f).length;
  const conAhorro = filas.filter((f) => f.ahorroExacto != null);
  const maxRonda = filas.reduce((m, f) => Math.max(m, f.ultimaRonda), 1);
  return {
    negociacion: { id: neg.id, ciclo: neg.ciclo_id, proveedor: neg.proveedor, estado: neg.estado, ronda_visible: Math.max(1, Math.floor(maxRonda / 2)), max_rondas: MAX_RONDAS },
    resumen: {
      total: filas.length,
      acuerdo: cuenta((f) => f.estado === "acuerdo"),
      sin_acuerdo: cuenta((f) => f.estado === "sin_acuerdo"),
      esperando_proveedor: cuenta((f) => f.turno === "proveedor"),
      tu_turno: cuenta((f) => f.turno === "mercaldas"),
      cerrados: cuenta((f) => f.estado !== "abierto"),
      ahorro_promedio_pct: conAhorro.length ? Math.round((conAhorro.reduce((a, f) => a + f.ahorroExacto, 0) / conAhorro.length) * 10) / 10 : null,
    },
    productos: filas,
  };
}

function sincronizarCabecera(negId) {
  const neg = negociacionPorId(negId);
  const h = armarHoja(neg);
  const maxRonda = h.productos.reduce((m, f) => Math.max(m, f.ultimaRonda), 2);
  const abiertos = h.productos.filter((f) => f.estado === "abierto").length;
  const cols = columnasDe("negociaciones_unificadas");
  const set = ["ronda_actual = ?", "estado = ?"], vals = [maxRonda, abiertos === 0 && h.productos.length ? "cerrada" : "abierta"];
  if (cols.has("cerrado_en")) { set.push("cerrado_en = ?"); vals.push(abiertos === 0 && h.productos.length ? neg.cerrado_en || ahora() : null); }
  if (cols.has("actualizado_en")) { set.push("actualizado_en = ?"); vals.push(ahora()); }
  db.prepare("UPDATE negociaciones_unificadas SET " + set.join(", ") + " WHERE id = ?").run(...vals, negId);
}

// ---------- Importación del Excel de respuesta ----------
function pendientesDeProveedor(hoja) {
  const esperando = hoja.productos.filter((p) => p.estado === "abierto" && p.turno === "proveedor");
  if (!esperando.length) return null;
  const rondaEvento = Math.max(...esperando.map((p) => p.ultimaRonda));
  return { rondaEvento, k: rondaEvento / 2, productos: esperando.filter((p) => p.ultimaRonda === rondaEvento) };
}

function etiquetaAnterior(cicloId) {
  const m = /^COT-(\d{4})-(\d{2})$/.exec(cicloId || "");
  return m && Number(m[2]) > 1 ? ["COT-" + m[1] + "-" + String(Number(m[2]) - 1).padStart(2, "0")] : [];
}

async function prepararImportacion(neg, buffer) {
  const hoja = armarHoja(neg);
  const pend = pendientesDeProveedor(hoja);
  if (!pend) return { error: "No hay productos esperando respuesta del proveedor en esta negociación." };
  const productos = {}, otros = {};
  pend.productos.forEach((p) => { productos[p.codigo] = { producto: p.producto, cotizado: p.proveedorActual, contra: p.contraActual }; });
  hoja.productos.filter((p) => !productos[p.codigo]).forEach((p) => {
    otros[p.codigo] = p.estado !== "abierto" ? "ya está cerrado" : p.turno === "mercaldas" ? "está esperando tu decisión" : "espera una respuesta de una ronda anterior";
  });
  const lectura = await leerRespuesta(buffer);
  const vista = validar(lectura, { proveedor: neg.proveedor, cicloId: neg.ciclo_id, etiquetasAceptadas: etiquetaAnterior(neg.ciclo_id), ronda: pend.k, productos, otros });
  return { pend, vista };
}

const TEXTO_TIPO = { acepta: "Acepta la contrapropuesta", mantiene: "Mantiene su precio", contrapropone: "Contrapropone un precio intermedio", revisar: "Revisar" };

// ---------- Excel de la siguiente ronda (mismo aspecto que el de Por proveedor) ----------
async function generarExcel(neg, k, filas) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Contrapropuesta");
  const VERDE = "FF1F6B45", CLARO = "FF6FAE82", TEXTO = "FF24342B", BORDE = "FFB7C9BD", ZEBRA = "FFF7FBF8", AMARILLO = "FFFFF2CC";
  ws.columns = [{ width: 28 }, { width: 14 }, { width: 42 }, { width: 20 }, { width: 22 }, { width: 20 }];
  const borde = { style: "thin", color: { argb: BORDE } };
  const bordes = { top: borde, left: borde, bottom: borde, right: borde };

  ws.mergeCells("A1:F1");
  Object.assign(ws.getCell("A1"), { value: "MERCALDAS - CONTRAPROPUESTA COMERCIAL FRUVER" });
  ws.getCell("A1").font = { name: "Calibri", size: 17, bold: true, color: { argb: "FFFFFFFF" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERDE } };
  ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 35;

  ws.mergeCells("A2:F2");
  ws.getCell("A2").value = "Proveedor: " + neg.proveedor;
  ws.getCell("A2").font = { name: "Calibri", size: 12, bold: true, color: { argb: VERDE } };
  ws.getCell("A2").alignment = { vertical: "middle" };
  ws.getRow(2).height = 23;

  ws.mergeCells("A3:F3");
  ws.getCell("A3").value = "Ciclo: " + neg.ciclo_id + "   |   Ronda: " + k;
  ws.getCell("A3").font = { name: "Calibri", size: 11, color: { argb: TEXTO } };

  ws.mergeCells("A4:F4");
  ws.getCell("A4").value = "Escriba su respuesta solo en la columna PRECIO FINAL (celdas amarillas). Las demás columnas están bloqueadas.";
  ws.getCell("A4").font = { name: "Calibri", size: 11, bold: true, color: { argb: VERDE } };

  const encabezados = ["PROVEEDOR", "PLU", "PRODUCTO", "PRECIO COTIZADO", "CONTRAPROPUESTA", "PRECIO FINAL"];
  encabezados.forEach((t, i) => {
    const c = ws.getRow(5).getCell(i + 1);
    c.value = t;
    c.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLARO } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = bordes;
  });
  ws.getRow(5).height = 32;

  filas.forEach((f, idx) => {
    const r = ws.getRow(6 + idx);
    r.height = 23;
    const valores = [neg.proveedor, String(f.codigo), f.producto, f.cotizado, f.contra, null];
    valores.forEach((v, i) => {
      const c = r.getCell(i + 1);
      c.value = v;
      c.font = { name: "Calibri", size: 11, color: { argb: TEXTO } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i === 5 ? AMARILLO : idx % 2 ? ZEBRA : "FFFFFFFF" } };
      c.border = bordes;
      c.protection = { locked: i !== 5 };
      if (i === 1) { c.numFmt = "@"; c.alignment = { horizontal: "center", vertical: "middle" }; }
      else if (i >= 3) { c.numFmt = '"$" #,##0'; c.alignment = { horizontal: "right", vertical: "middle" }; }
      else c.alignment = { vertical: "middle", wrapText: true };
    });
  });
  ws.views = [{ state: "frozen", ySplit: 5 }];
  ws.autoFilter = "A5:F5";
  await ws.protect("", { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, autoFilter: true });
  return wb.xlsx.writeBuffer();
}

function filasParaExportar(neg) {
  const hoja = armarHoja(neg);
  const pend = pendientesDeProveedor(hoja);
  if (!pend) return null;
  return { k: pend.k, filas: pend.productos.map((p) => ({ codigo: p.codigo, plu: p.codigo, producto: p.producto, cotizado: p.proveedorActual, contra: p.contraActual })) };
}

// ---------- Rutas ----------
module.exports = function registrarNegociacionHoja(app, requireAdmin) {
  const falta = esquemaFaltante();
  if (falta.length) {
    console.error("[negociacion_hoja] NO se registró: faltan columnas esperadas: " + falta.join(", "));
    return;
  }

  app.get("/api/negociacion/tablero", requireAdmin, (req, res) => {
    const ciclo = String(req.query.ciclo || "").trim();
    if (!ciclo) return res.status(400).json({ error: "Falta el ciclo." });
    const mapa = new Map();
    db.prepare("SELECT proveedor, COUNT(*) AS n FROM quotes WHERE ciclo_id = ? GROUP BY proveedor").all(ciclo)
      .forEach((c) => mapa.set(c.proveedor, { proveedor: c.proveedor, cotizaciones: c.n, negociacion_id: null }));
    db.prepare("SELECT * FROM negociaciones_unificadas WHERE ciclo_id = ?").all(ciclo).forEach((n) => {
      const h = armarHoja(n);
      const previo = mapa.get(n.proveedor) || { proveedor: n.proveedor, cotizaciones: 0 };
      mapa.set(n.proveedor, { ...previo, negociacion_id: n.id, estado: n.estado, ronda_visible: h.negociacion.ronda_visible, ...h.resumen });
    });
    const prioridad = (x) => (x.negociacion_id == null ? 2 : x.estado === "cerrada" ? 3 : x.tu_turno > 0 ? 0 : 1);
    const lista = [...mapa.values()].sort((a, b) => prioridad(a) - prioridad(b) || a.proveedor.localeCompare(b.proveedor, "es"));
    res.json({ ciclo, proveedores: lista });
  });

  app.get("/api/negociacion/:id/hoja", requireAdmin, (req, res) => {
    const neg = negociacionPorId(req.params.id);
    if (!neg) return res.status(404).json({ error: "No existe esa negociación." });
    res.json(armarHoja(neg));
  });

  const recibirArchivo = (req, res, next) =>
    subida.single("archivo")(req, res, (err) => (err ? res.status(400).json({ error: "No se pudo leer el archivo (máximo 8 MB)." }) : next()));

  app.post("/api/negociacion/:id/importar", requireAdmin, recibirArchivo, async (req, res) => {
    try {
      const neg = negociacionPorId(req.params.id);
      if (!neg) return res.status(404).json({ error: "No existe esa negociación." });
      if (!req.file) return res.status(400).json({ error: "Selecciona el archivo Excel con la respuesta del proveedor." });
      const prep = await prepararImportacion(neg, req.file.buffer);
      if (prep.error) return res.status(400).json({ error: prep.error });
      if (String(req.query.confirmar || "") !== "1") return res.json({ confirmado: false, ronda: prep.pend.k, ...prep.vista });
      if (!prep.vista.puedeGuardar) return res.status(400).json({ error: "El archivo tiene errores que impiden guardarlo.", ronda: prep.pend.k, ...prep.vista });

      const rondaNueva = prep.pend.rondaEvento + 1;
      let guardadas = 0;
      db.transaction(() => {
        for (const f of prep.vista.filas) {
          if (f.tipo === "sin_respuesta" || f.respuesta == null) continue;
          const acepta = f.tipo === "acepta";
          const obs = f.tipo === "revisar" ? "Revisar: " + f.motivo : TEXTO_TIPO[f.tipo];
          insertarHistorial(neg.id, f.plu, rondaNueva, "PROVEEDOR", f.respuesta, acepta ? "acepta_contrapropuesta" : "respuesta_proveedor", obs);
          actualizarProducto(neg.id, f.plu, acepta ? { propuesta_final_proveedor: f.respuesta, precio_final: f.respuesta, estado: "acuerdo" } : { propuesta_final_proveedor: f.respuesta });
          guardadas++;
        }
        sincronizarCabecera(neg.id);
      })();
      res.json({ confirmado: true, guardadas, ronda: prep.pend.k, resumen: prep.vista.resumen, hoja: armarHoja(negociacionPorId(neg.id)) });
    } catch (e) {
      console.error("[negociacion_hoja] importar:", e);
      res.status(500).json({ error: "No se pudo procesar el archivo." });
    }
  });

  app.post("/api/negociacion/:id/decidir", requireAdmin, (req, res) => {
    try {
      const neg = negociacionPorId(req.params.id);
      if (!neg) return res.status(404).json({ error: "No existe esa negociación." });
      const decisiones = Array.isArray(req.body && req.body.decisiones) ? req.body.decisiones : [];
      if (!decisiones.length) return res.status(400).json({ error: "No hay decisiones para guardar." });
      const hoja = armarHoja(neg);
      const porCodigo = Object.fromEntries(hoja.productos.map((p) => [p.codigo, p]));
      const errores = [], vistos = new Set(), plan = [];
      for (const d of decisiones) {
        const codigo = String(d && d.codigo != null ? d.codigo : "").trim();
        const p = porCodigo[codigo];
        if (!p) { errores.push("El producto " + codigo + " no está en esta negociación."); continue; }
        if (vistos.has(codigo)) { errores.push(p.producto + ": aparece dos veces en la solicitud."); continue; }
        vistos.add(codigo);
        if (p.estado !== "abierto") { errores.push(p.producto + ": ya está cerrado."); continue; }
        if (p.turno !== "mercaldas") { errores.push(p.producto + ": todavía espera la respuesta del proveedor."); continue; }
        if (d.accion === "aceptar_precio_proveedor") plan.push({ p, accion: d.accion });
        else if (d.accion === "sin_acuerdo") plan.push({ p, accion: d.accion });
        else if (d.accion === "contraproponer") {
          const precio = Number(d.precio);
          if (!Number.isInteger(precio) || precio <= 0) errores.push(p.producto + ": escribe un precio entero mayor que cero.");
          else if (precio >= p.proveedorActual) errores.push(p.producto + ": la contrapropuesta debe ser menor que el precio del proveedor (" + moneda(p.proveedorActual) + ").");
          else if (p.ultimaRonda + 1 > 2 * MAX_RONDAS) errores.push(p.producto + ": ya se hicieron las " + MAX_RONDAS + " rondas. Acepta su precio o márcalo sin acuerdo.");
          else plan.push({ p, accion: d.accion, precio });
        } else errores.push(p.producto + ": acción no válida.");
      }
      if (errores.length) return res.status(400).json({ error: errores.join(" "), errores });

      db.transaction(() => {
        for (const { p, accion, precio } of plan) {
          if (accion === "aceptar_precio_proveedor") {
            insertarHistorial(neg.id, p.codigo, p.ultimaRonda, "MERCALDAS", p.proveedorActual, "acuerdo", "Mercaldas acepta el precio del proveedor");
            actualizarProducto(neg.id, p.codigo, { estado: "acuerdo", precio_final: p.proveedorActual });
          } else if (accion === "sin_acuerdo") {
            insertarHistorial(neg.id, p.codigo, p.ultimaRonda, "MERCALDAS", null, "sin_acuerdo", "Sin acuerdo");
            actualizarProducto(neg.id, p.codigo, { estado: "sin_acuerdo", precio_final: null });
          } else {
            insertarHistorial(neg.id, p.codigo, p.ultimaRonda + 1, "MERCALDAS", precio, "contrapropuesta", null);
            actualizarProducto(neg.id, p.codigo, { contrapropuesta_mercaldas: precio });
          }
        }
        sincronizarCabecera(neg.id);
      })();
      res.json({ ok: true, aplicadas: plan.length, hoja: armarHoja(negociacionPorId(neg.id)) });
    } catch (e) {
      console.error("[negociacion_hoja] decidir:", e);
      res.status(500).json({ error: "No se pudieron guardar las decisiones." });
    }
  });

  // Precio final escrito a mano (proveedores sin internet, acuerdos por teléfono) y corrección de precios ya guardados
  app.post("/api/negociacion/:id/precio-final", requireAdmin, (req, res) => {
    try {
      const neg = negociacionPorId(req.params.id);
      if (!neg) return res.status(404).json({ error: "No existe esa negociación." });
      const cambios = Array.isArray(req.body && req.body.cambios) ? req.body.cambios : [];
      if (!cambios.length) return res.status(400).json({ error: "No hay precios para guardar." });
      const nota = String((req.body && req.body.nota) || "").trim().slice(0, 300);
      const hoja = armarHoja(neg);
      const porCodigo = Object.fromEntries(hoja.productos.map((p) => [p.codigo, p]));
      const errores = [], vistos = new Set(), plan = [];
      for (const c of cambios) {
        const codigo = String(c && c.codigo != null ? c.codigo : "").trim();
        const p = porCodigo[codigo];
        if (!p) { errores.push("El producto " + codigo + " no está en esta negociación."); continue; }
        if (vistos.has(codigo)) { errores.push(p.producto + ": aparece dos veces en la solicitud."); continue; }
        vistos.add(codigo);
        const precio = Number(c.precio);
        if (!Number.isInteger(precio) || precio <= 0) { errores.push(p.producto + ": escribe un precio entero mayor que cero."); continue; }
        if (p.estado === "acuerdo" && p.precio_final === precio) continue;
        plan.push({ p, precio });
      }
      if (errores.length) return res.status(400).json({ error: errores.join(" "), errores });
      if (!plan.length) return res.status(400).json({ error: "No cambiaste ningún precio." });
      db.transaction(() => {
        for (const { p, precio } of plan) {
          const antes = p.estado === "acuerdo" ? " (antes " + moneda(p.precio_final) + ")" : p.estado === "sin_acuerdo" ? " (antes: sin acuerdo)" : "";
          insertarHistorial(neg.id, p.codigo, p.ultimaRonda, "MERCALDAS", precio, "acuerdo_manual", "Precio final registrado manualmente" + antes + (nota ? ": " + nota : ""));
          actualizarProducto(neg.id, p.codigo, { estado: "acuerdo", precio_final: precio });
        }
        sincronizarCabecera(neg.id);
      })();
      res.json({ ok: true, aplicados: plan.length, hoja: armarHoja(negociacionPorId(neg.id)) });
    } catch (e) {
      console.error("[negociacion_hoja] precio-final:", e);
      res.status(500).json({ error: "No se pudieron guardar los precios." });
    }
  });

  app.get("/api/negociacion/:id/exportar", requireAdmin, async (req, res) => {
    try {
      const neg = negociacionPorId(req.params.id);
      if (!neg) return res.status(404).json({ error: "No existe esa negociación." });
      const datos = filasParaExportar(neg);
      if (!datos) return res.status(400).json({ error: "No hay contrapropuestas pendientes de enviar. Primero decide los productos que están en tu turno." });
      const alertas = alertasContrapropuesta(datos.filas, UMBRAL_ALERTA);
      if (String(req.query.previsualizar || "") === "1") return res.json({ ronda: datos.k, total: datos.filas.length, umbral_pct: UMBRAL_ALERTA * 100, alertas });
      const buffer = await generarExcel(neg, datos.k, datos.filas);
      const nombre = "CONTRAPROPUESTA_" + String(neg.proveedor).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() + "_R" + datos.k + ".xlsx";
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="' + nombre + '"');
      res.send(Buffer.from(buffer));
    } catch (e) {
      console.error("[negociacion_hoja] exportar:", e);
      res.status(500).json({ error: "No se pudo generar el Excel." });
    }
  });

  console.log("Hoja de negociación lista (/api/negociacion/...)");
};
