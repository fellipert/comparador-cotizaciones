const XLSX = require("xlsx");

function norm(s) {
  return (s === null || s === undefined ? "" : String(s))
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toUpperCase();
}

function findValueAfter(row, idx) {
  const v = row[idx + 1];
  return v !== null && v !== undefined && String(v).trim() !== "" ? v : null;
}

function toDateString(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v === null || v === undefined) return null;
  return String(v);
}

const MAX_LABEL_LEN = 40;

function findHeaderAndColMap(rows) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const normed = row.map((c) => (norm(c).length <= MAX_LABEL_LEN ? norm(c) : ""));
    const codigoIdx = normed.findIndex((c) => c.includes("CODIGO"));
    const productoIdx = normed.findIndex((c) => c.includes("PRODUCTO"));
    const precioIdx = normed.findIndex((c) => c.includes("PRECIO"));
    const hasCodigo = codigoIdx !== -1;
    const hasProducto = productoIdx !== -1 && productoIdx !== codigoIdx;
    const hasPrecio = precioIdx !== -1 && precioIdx !== codigoIdx && precioIdx !== productoIdx;
    if (hasCodigo && hasProducto && hasPrecio) {
      const colMap = {};
      row.forEach((cell, idx) => {
        const n = norm(cell);
        if (n.includes("CODIGO") && colMap.codigo === undefined) colMap.codigo = idx;
        else if (n.includes("PRODUCTO") && colMap.producto === undefined) colMap.producto = idx;
        else if (n.includes("PRESENTAC") && colMap.presentacion === undefined) colMap.presentacion = idx;
        else if (n.includes("DISPONIB") && colMap.disponibilidad === undefined) colMap.disponibilidad = idx;
        else if (n.includes("PRECIO") && colMap.precio === undefined) colMap.precio = idx;
        else if (n.includes("OBSERVAC") && colMap.observacion === undefined) colMap.observacion = idx;
        else if (n === "OFRECER" && colMap.ofrecer === undefined) colMap.ofrecer = idx;
        else if (n.includes("CATEGOR") && colMap.categoria === undefined) colMap.categoria = idx;
      });
      return { headerRowIdx: r, colMap };
    }
  }
  return null;
}

function scanMetadata(rows, headerRowIdx, meta) {
  for (let r = 0; r < headerRowIdx; r++) {
    const row = rows[r] || [];
    row.forEach((cell, idx) => {
      const n = norm(cell);
      if (n === "PROVEEDOR" && !meta.proveedor) meta.proveedor = findValueAfter(row, idx);
      else if (n === "SEMANA" && !meta.semana) meta.semana = findValueAfter(row, idx);
      else if (n.includes("FECHA DE ENVIO") || (n.includes("FECHA ENVIO") && !meta.fechaEnvio))
        meta.fechaEnvio = meta.fechaEnvio || findValueAfter(row, idx);
      else if (n.includes("FIN VIGENCIA") && !meta.vigenciaFin) meta.vigenciaFin = findValueAfter(row, idx);
    });
  }
}

function esNoDisponible(v) {
  const n = norm(v);
  return n.startsWith("NO");
}
function esOfrecerSi(v) {
  return norm(v).startsWith("SI");
}

function extractRecords(rows, headerRowIdx, colMap, meta) {
  const records = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const codigo = colMap.codigo !== undefined ? row[colMap.codigo] : null;
    if (codigo === null || codigo === undefined || String(codigo).trim() === "") continue;

    if (colMap.ofrecer !== undefined && !esOfrecerSi(row[colMap.ofrecer])) continue;

    if (colMap.disponibilidad !== undefined && esNoDisponible(row[colMap.disponibilidad])) continue;

    const precio = colMap.precio !== undefined ? row[colMap.precio] : null;
    if (precio === null || precio === undefined || String(precio).trim() === "" || isNaN(Number(precio))) continue;
    if (Number(precio) <= 0) continue;

    records.push({
      codigo: String(codigo).trim(),
      producto: colMap.producto !== undefined ? String(row[colMap.producto] || "").trim() : "",
      presentacion: colMap.presentacion !== undefined ? String(row[colMap.presentacion] || "").trim() : "",
      disponibilidad: colMap.disponibilidad !== undefined ? (row[colMap.disponibilidad] === null ? null : String(row[colMap.disponibilidad])) : null,
      precio: Number(precio),
      observacion: colMap.observacion !== undefined ? (row[colMap.observacion] === null ? null : String(row[colMap.observacion])) : null,
      proveedor: meta.proveedor,
      semana: String(meta.semana),
      vigenciaFin: meta.vigenciaFin,
    });
  }
  return records;
}

function findCatalogOnlyHeader(rows) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const normed = row.map((c) => (norm(c).length <= MAX_LABEL_LEN ? norm(c) : ""));
    const codigoIdx = normed.findIndex((c) => c.includes("CODIGO"));
    const productoIdx = normed.findIndex((c) => c.includes("PRODUCTO"));
    if (codigoIdx !== -1 && productoIdx !== -1 && productoIdx !== codigoIdx) {
      const colMap = {};
      row.forEach((cell, idx) => {
        const n = norm(cell);
        if (n.includes("CODIGO") && colMap.codigo === undefined) colMap.codigo = idx;
        else if (n.includes("PRODUCTO") && colMap.producto === undefined) colMap.producto = idx;
        else if (n.includes("PRESENTAC") && colMap.presentacion === undefined) colMap.presentacion = idx;
      });
      return { headerRowIdx: r, colMap };
    }
  }
  return null;
}

function extractCatalogEntries(rows, headerRowIdx, colMap) {
  const entries = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const codigo = colMap.codigo !== undefined ? row[colMap.codigo] : null;
    if (codigo === null || codigo === undefined || String(codigo).trim() === "") continue;
    entries.push({
      codigo: String(codigo).trim(),
      producto: colMap.producto !== undefined ? String(row[colMap.producto] || "").trim() : "",
      presentacion: colMap.presentacion !== undefined ? String(row[colMap.presentacion] || "").trim() : "",
    });
  }
  return entries;
}

function parseWorkbook(buffer, filename) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });

  const meta = { proveedor: "", semana: "", fechaEnvio: null, vigenciaFin: null };
  const sheets = wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true });
    const detected = findHeaderAndColMap(rows);
    if (detected) scanMetadata(rows, detected.headerRowIdx, meta);
    return { name, rows, detected };
  });

  if (!meta.proveedor) {
    for (const sheet of sheets) {
      if (!sheet.detected) continue;
      const posible = sheet.rows[1] && sheet.rows[1][1];
      if (posible !== null && posible !== undefined && String(posible).trim() !== "") {
        meta.proveedor = posible;
        break;
      }
    }
  }
  if (!meta.proveedor) {
    const base = filename.replace(/\.(xlsx|xls)$/i, "");
    const parts = base.split(/[_\-]/);
    meta.proveedor = (parts.length > 1 ? parts.slice(1).join(" ") : base).trim().toUpperCase();
  } else {
    meta.proveedor = String(meta.proveedor).trim().toUpperCase();
  }
  if (!meta.semana) meta.semana = "N/D";
  meta.fechaEnvio = toDateString(meta.fechaEnvio);
  meta.vigenciaFin = toDateString(meta.vigenciaFin);

  let records = [];
  let catalogo = [];
  for (const sheet of sheets) {
    if (sheet.detected) {
      records = records.concat(extractRecords(sheet.rows, sheet.detected.headerRowIdx, sheet.detected.colMap, meta));
      catalogo = catalogo.concat(extractCatalogEntries(sheet.rows, sheet.detected.headerRowIdx, sheet.detected.colMap));
    } else {
      const soloDetected = findCatalogOnlyHeader(sheet.rows);
      if (soloDetected) {
        catalogo = catalogo.concat(extractCatalogEntries(sheet.rows, soloDetected.headerRowIdx, soloDetected.colMap));
      }
    }
  }

  if (records.length === 0) {
    throw new Error(`No se encontraron filas con precio cotizado en "${filename}".`);
  }
  return { meta, records, catalogo };
}

module.exports = { parseWorkbook, norm };

