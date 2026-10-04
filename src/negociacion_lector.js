const ExcelJS = require("exceljs");

const sinAcentos = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const norm = (s) => sinAcentos(s).replace(/\s+/g, " ").trim().toUpperCase();
const normNombre = (s) => norm(s).replace(/[.,;:]/g, "").replace(/\s+/g, " ");

const SINONIMOS = {
  plu: ["PLU", "CODIGO"],
  producto: ["PRODUCTO", "DESCRIPCION"],
  proveedor: ["PROVEEDOR"],
  cotizado: ["PRECIO COTIZADO", "COTIZADO"],
  contra: ["CONTRAPROPUESTA"],
  respuesta: ["PRECIO FINAL", "RESPUESTA", "RESPUESTA PROVEEDOR"],
};

function valorCelda(cell) {
  let v = cell.value;
  if (v && typeof v === "object") {
    if (v.richText) v = v.richText.map((t) => t.text).join("");
    else if ("result" in v) v = v.result;
    else if (v.text) v = v.text;
  }
  return v === undefined ? null : v;
}

// Devuelve { valor, sinCotizacion, error }. Solo acepta formatos que no se prestan a confusión.
function leerPrecio(v) {
  if (v === null || v === "") return { valor: null };
  if (typeof v === "number") return v > 0 ? { valor: v } : { valor: null, error: "precio no válido" };
  const t = String(v).trim();
  if (t === "" || t === "-") return { valor: null };
  if (/^sin\s+cotizaci/i.test(sinAcentos(t))) return { valor: null, sinCotizacion: true };
  const limpio = t.replace(/[$\s]/g, "");
  if (/^\d+$/.test(limpio)) return { valor: Number(limpio) };
  if (/^\d{1,3}([.,]\d{3})+$/.test(limpio)) return { valor: Number(limpio.replace(/[.,]/g, "")) };
  return { valor: null, error: "formato de precio no reconocido (\"" + t + "\")" };
}

async function leerRespuesta(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) {
    return { ok: false, errores: ["No pude abrir el archivo: no parece un Excel (.xlsx) válido."], filas: [], meta: {} };
  }
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(30, ws.rowCount); r++) {
      const cols = {};
      ws.getRow(r).eachCell((cell, c) => {
        const t = norm(valorCelda(cell));
        for (const [clave, lista] of Object.entries(SINONIMOS)) if (!cols[clave] && lista.includes(t)) cols[clave] = c;
      });
      if (!(cols.plu && cols.contra && cols.respuesta)) continue;

      const meta = { hoja: ws.name, ciclo: null, ronda: null, proveedores: [] };
      for (let k = 1; k < r; k++) ws.getRow(k).eachCell((cell) => {
        const t = String(valorCelda(cell) == null ? "" : valorCelda(cell));
        const mc = t.match(/COT-\d{4}-\d{2}/i), mr = t.match(/RONDA\s*:?\s*(\d)/i);
        if (mc && !meta.ciclo) meta.ciclo = mc[0].toUpperCase();
        if (mr && !meta.ronda) meta.ronda = Number(mr[1]);
      });

      const filas = [];
      for (let i = r + 1; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const get = (k) => (cols[k] ? valorCelda(row.getCell(cols[k])) : null);
        const pluRaw = get("plu");
        const plu = pluRaw == null ? "" : (typeof pluRaw === "number" ? String(Math.round(pluRaw)) : String(pluRaw).trim());
        const producto = get("producto") == null ? "" : String(get("producto")).trim();
        if (!plu && !producto && get("respuesta") == null && get("contra") == null) continue;
        const prov = get("proveedor") == null ? "" : String(get("proveedor")).trim();
        if (prov && !meta.proveedores.includes(prov)) meta.proveedores.push(prov);
        const cot = leerPrecio(get("cotizado")), con = leerPrecio(get("contra")), res = leerPrecio(get("respuesta"));
        filas.push({
          fila: i, plu, producto, proveedor: prov,
          cotizado: cot.valor, sinCotizacion: !!cot.sinCotizacion, contra: con.valor, respuesta: res.valor,
          errorPrecio: res.error || null,
        });
      }
      return { ok: true, errores: [], filas, meta };
    }
  }
  return { ok: false, errores: ["No encontré las columnas PLU, CONTRAPROPUESTA y PRECIO FINAL. ¿Es el archivo de contrapropuesta?"], filas: [], meta: {} };
}

// Siempre se clasifica con los precios que tiene el SISTEMA, no con los que trae el archivo.
function clasificar(cotizado, contra, respuesta) {
  if (respuesta == null) return { tipo: "sin_respuesta" };
  if (contra == null) return { tipo: "revisar", motivo: "el producto no tiene contrapropuesta en el sistema" };
  if (respuesta === contra) return { tipo: "acepta" };
  if (cotizado != null && respuesta === cotizado) return { tipo: "mantiene" };
  if (cotizado != null && respuesta > contra && respuesta < cotizado) return { tipo: "contrapropone" };
  if (respuesta < contra) return { tipo: "revisar", motivo: "responde por debajo de tu contrapropuesta" };
  if (cotizado != null && respuesta > cotizado) return { tipo: "revisar", motivo: "responde por encima de lo que había cotizado" };
  return { tipo: "revisar", motivo: "no había cotización y responde con un precio distinto a tu contrapropuesta" };
}

// esperado: { proveedor, cicloId, etiquetasAceptadas, ronda, productos: { plu: { producto, cotizado, contra } } }
function validar(lectura, esperado) {
  const avisos = [], filas = [];
  const add = (nivel, texto) => avisos.push({ nivel, texto });
  if (!lectura.ok) { lectura.errores.forEach((t) => add("error", t)); return { puedeGuardar: false, resumen: {}, filas, avisos }; }

  const { meta } = lectura;
  if (meta.proveedores.length > 1) add("error", "El archivo trae más de un proveedor: " + meta.proveedores.join(", "));
  else if (meta.proveedores.length === 1 && normNombre(meta.proveedores[0]) !== normNombre(esperado.proveedor))
    add("error", "El archivo es de \"" + meta.proveedores[0] + "\" y esta negociación es de \"" + esperado.proveedor + "\".");
  if (meta.ronda != null && meta.ronda !== esperado.ronda) add("error", "El archivo es de la ronda " + meta.ronda + " y esta negociación va en la ronda " + esperado.ronda + ".");
  if (meta.ronda == null) add("info", "El archivo no indica la ronda; se asume la ronda " + esperado.ronda + ".");
  if (meta.ciclo && meta.ciclo !== esperado.cicloId) {
    if ((esperado.etiquetasAceptadas || []).includes(meta.ciclo)) add("info", "El archivo dice " + meta.ciclo + ", el nombre anterior de " + esperado.cicloId + ". Es normal si se exportó antes del cambio de numeración.");
    else add("aviso", "El archivo dice " + meta.ciclo + " y estás en " + esperado.cicloId + ". Revisa que sea el archivo correcto.");
  }

  const vistos = {};
  lectura.filas.forEach((f) => { vistos[f.plu] = (vistos[f.plu] || 0) + 1; });
  Object.entries(vistos).filter(([p, n]) => p && n > 1).forEach(([p, n]) => add("error", "El PLU " + p + " aparece " + n + " veces en el archivo."));
  lectura.filas.filter((f) => !f.plu).forEach((f) => add("error", "La fila " + f.fila + " no tiene PLU."));

  const grupos = { ignorados: {}, cotizado: [], contra: [], ilegibles: [] };
  const fmt = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CO"));
  for (const f of lectura.filas) {
    if (!f.plu) continue;
    const sis = esperado.productos[f.plu];
    if (!sis) {
      const motivo = (esperado.otros && esperado.otros[f.plu]) || "no está en esta negociación";
      (grupos.ignorados[motivo] = grupos.ignorados[motivo] || []).push(f.producto + " (PLU " + f.plu + ")");
      continue;
    }
    if (f.cotizado !== sis.cotizado && !(f.cotizado == null && sis.cotizado == null)) grupos.cotizado.push(f.producto + ": archivo " + fmt(f.cotizado) + ", sistema " + fmt(sis.cotizado));
    if (f.contra !== sis.contra) grupos.contra.push(f.producto + ": archivo " + fmt(f.contra) + ", tuya " + fmt(sis.contra));
    if (f.errorPrecio) grupos.ilegibles.push(f.producto + " (" + f.errorPrecio + ")");
    const c = clasificar(sis.cotizado, sis.contra, f.errorPrecio ? null : f.respuesta);
    filas.push({ plu: f.plu, producto: sis.producto || f.producto, cotizado: sis.cotizado, contra: sis.contra, respuesta: f.errorPrecio ? null : f.respuesta, tipo: c.tipo, motivo: c.motivo || null });
  }
  // Hasta 3 avisos del mismo tipo se muestran uno por uno; si son más, se resumen en uno solo con ejemplos
  const avisar = (lista, uno, varios) => {
    if (!lista.length) return;
    if (lista.length <= 3) lista.forEach((x) => add("aviso", uno(x)));
    else add("aviso", varios(lista.length) + " Por ejemplo: " + lista.slice(0, 3).join("; ") + ".");
  };
  Object.entries(grupos.ignorados).forEach(([motivo, lista]) => avisar(lista, (x) => "Se ignora " + x + ": " + motivo + ".", (n) => n + " productos del archivo se ignoran (" + motivo + ")."));
  avisar(grupos.cotizado, (x) => "Precio cotizado distinto en " + x + ". Se usa el del sistema.", (n) => n + " productos traen un precio cotizado distinto al del sistema. Se usa el del sistema.");
  avisar(grupos.contra, (x) => "Contrapropuesta distinta en " + x + ". Se usa la tuya.", (n) => n + " productos traen una contrapropuesta distinta a la tuya. Se usa la tuya.");
  avisar(grupos.ilegibles, (x) => "No pude leer el precio de respuesta de " + x + ". Se toma como sin respuesta.", (n) => n + " productos tienen un precio de respuesta que no pude leer. Se toman como sin respuesta.");
  const enArchivo = new Set(lectura.filas.map((f) => f.plu));
  const faltan = Object.keys(esperado.productos).filter((p) => !enArchivo.has(p));
  faltan.forEach((p) => filas.push({ plu: p, producto: esperado.productos[p].producto, cotizado: esperado.productos[p].cotizado, contra: esperado.productos[p].contra, respuesta: null, tipo: "sin_respuesta", motivo: "no viene en el archivo" }));
  if (faltan.length) add("aviso", faltan.length + " producto(s) de la negociación no vienen en el archivo; quedan sin respuesta.");

  const resumen = { acepta: 0, mantiene: 0, contrapropone: 0, sin_respuesta: 0, revisar: 0 };
  filas.forEach((f) => { resumen[f.tipo]++; });
  return { puedeGuardar: !avisos.some((a) => a.nivel === "error"), resumen, filas, avisos };
}

// Para usar al EXPORTAR: contrapropuestas que piden una baja demasiado grande (posible error de presentación o unidad)
function alertasContrapropuesta(filas, umbral = 0.10) {
  return filas.filter((f) => f.cotizado > 0 && f.contra != null && (f.cotizado - f.contra) / f.cotizado > umbral)
    .map((f) => ({ plu: f.plu, producto: f.producto, cotizado: f.cotizado, contra: f.contra, bajaPct: Math.round((f.cotizado - f.contra) / f.cotizado * 1000) / 10 }));
}

module.exports = { leerRespuesta, validar, clasificar, alertasContrapropuesta, leerPrecio };
