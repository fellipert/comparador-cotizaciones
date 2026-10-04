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


function parseFormatoMercaldasNuevo(wb, filename) {

  let hojaObjetivo = null;
  let rows = null;

  for (const nombre of wb.SheetNames) {

    const filas = XLSX.utils.sheet_to_json(
      wb.Sheets[nombre],
      {
        header: 1,
        defval: null,
        raw: true
      }
    );

    const textoInicial = filas
      .slice(0, 8)
      .flat()
      .filter(v => v !== null && v !== undefined)
      .map(v => String(v))
      .join(" ")
      .toUpperCase();

    if (
      textoInicial.includes("MERCALDAS") &&
      textoInicial.includes("COTIZACIÓN FRUVER")
    ) {
      hojaObjetivo = nombre;
      rows = filas;
      break;
    }

  }

  if (!rows) {
    return null;
  }


  // ===================================================
  // METADATOS
  // ===================================================

  let proveedor = "";
  let ciclo = "";
  let vigenciaFin = null;

  for (const row of rows.slice(0, 10)) {

    for (const celda of row || []) {

      if (celda === null || celda === undefined) continue;

      const texto = String(celda).trim();

      const mProveedor =
        texto.match(/^Proveedor\s*:\s*(.+)$/i);

      if (mProveedor) {
        proveedor = mProveedor[1].trim().toUpperCase();
      }

      const mCiclo =
        texto.match(/COT-\d{4}-\d{1,2}/i);

      if (mCiclo) {
        ciclo = mCiclo[0].toUpperCase();
      }

      const mVigencia =
        texto.match(
          /Vigencia\s*:\s*(\d{4}-\d{2}-\d{2})\s+al\s+(\d{4}-\d{2}-\d{2})/i
        );

      if (mVigencia) {
        vigenciaFin = mVigencia[2];
      }

    }

  }


  if (!proveedor) {
    return null;
  }


  // ===================================================
  // PRODUCTOS
  // ===================================================

  const records = [];
  const catalogo = [];

  let seccion = null;
  let columnas = null;


  for (let i = 0; i < rows.length; i++) {

    const row = rows[i] || [];

    const textos = row
      .filter(v => v !== null && v !== undefined)
      .map(v => String(v).trim());

    if (!textos.length) continue;

    const textoFila =
      textos.join(" ").toLowerCase();


    // -----------------------------------------------
    // Detectar sección
    // -----------------------------------------------

    if (
      textoFila.includes(
        "cotización habitual de productos"
      )
    ) {
      seccion = "habitual";
      columnas = null;
      continue;
    }

    if (
      textoFila.includes(
        "productos de temporada"
      ) ||
      textoFila.includes(
        "otras oportunidades"
      )
    ) {
      seccion = "oportunidades";
      columnas = null;
      continue;
    }


    // -----------------------------------------------
    // Detectar encabezado
    // -----------------------------------------------

    const normalizados =
      row.map(v =>
        v === null || v === undefined
          ? ""
          : norm(v)
      );

    const idxCodigo =
      normalizados.findIndex(v =>
        v === "PLU" ||
        v === "CODIGO"
      );

    const idxProducto =
      normalizados.findIndex(v =>
        v === "PRODUCTO"
      );

    const idxPresentacion =
      normalizados.findIndex(v =>
        v === "PRESENTACION"
      );

    const idxPrecio =
      normalizados.findIndex(v =>
        v === "PRECIO OFERTADO" ||
        v === "PRECIO"
      );

    if (
      idxCodigo >= 0 &&
      idxProducto >= 0 &&
      idxPrecio >= 0
    ) {

      columnas = {
        codigo: idxCodigo,
        producto: idxProducto,
        presentacion: idxPresentacion,
        precio: idxPrecio,
        disponibilidad:
          normalizados.findIndex(v =>
            v === "DISPONIBILIDAD"
          ),
        observacion:
          normalizados.findIndex(v =>
            v === "OBSERVACION"
          ),
        ofertar:
          normalizados.findIndex(v =>
            v === "OFERTAR ESTA SEMANA" ||
            v === "OFERTAR"
          )
      };

      continue;
    }


    if (!columnas || !seccion) {
      continue;
    }


    // -----------------------------------------------
    // Leer producto
    // -----------------------------------------------

    const codigo =
      columnas.codigo >= 0
        ? String(
            row[columnas.codigo] ?? ""
          ).trim()
        : "";

    if (!codigo) continue;


    const producto =
      columnas.producto >= 0
        ? String(
            row[columnas.producto] ?? ""
          ).trim()
        : "";

    const presentacion =
      columnas.presentacion >= 0
        ? String(
            row[columnas.presentacion] ?? ""
          ).trim()
        : "";


    // Siempre alimentamos catálogo
    catalogo.push({
      codigo,
      producto,
      presentacion
    });


    // -----------------------------------------------
    // Oportunidades: SOLO cuando diga SI
    // -----------------------------------------------

    if (seccion === "oportunidades") {

      const ofertar =
        columnas.ofertar >= 0
          ? norm(
              row[columnas.ofertar] ?? ""
            )
          : "";

      const si =
        [
          "SI",
          "S",
          "YES",
          "1"
        ].includes(ofertar);

      if (!si) {
        continue;
      }

    }


    // -----------------------------------------------
    // Precio
    // -----------------------------------------------

    const precioRaw =
      columnas.precio >= 0
        ? row[columnas.precio]
        : null;

    let precio =
      typeof precioRaw === "number"
        ? precioRaw
        : Number(
            String(precioRaw ?? "")
              .replace(/\$/g, "")
              .replace(/\s/g, "")
              .replace(/\./g, "")
              .replace(",", ".")
          );

    if (
      !Number.isFinite(precio) ||
      precio <= 0
    ) {
      continue;
    }


    const disponibilidad =
      columnas.disponibilidad >= 0
        ? row[columnas.disponibilidad]
        : null;

    const observacion =
      columnas.observacion >= 0
        ? row[columnas.observacion]
        : null;


    records.push({
      codigo,
      producto,
      presentacion,
      disponibilidad:
        disponibilidad === null ||
        disponibilidad === undefined
          ? null
          : String(disponibilidad).trim(),
      precio,
      observacion:
        observacion === null ||
        observacion === undefined
          ? null
          : String(observacion).trim(),
      proveedor,
      semana:
        ciclo || "N/D",
      vigenciaFin
    });

  }


  if (!records.length) {
    throw new Error(
      'El formato Mercaldas fue reconocido, pero no contiene productos con precio válido.'
    );
  }


  return {
    meta: {
      proveedor,
      semana: ciclo || "N/D",
      fechaEnvio: null,
      vigenciaFin
    },
    records,
    catalogo
  };

}


function parseWorkbook(buffer, filename) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });

  // Primero intentamos el formato oficial nuevo Mercaldas.
  // Si no corresponde, continuamos con el parser histórico.
  const formatoMercaldas =
    parseFormatoMercaldasNuevo(
      wb,
      filename
    );

  if (formatoMercaldas) {
    return formatoMercaldas;
  }

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

