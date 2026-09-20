const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");

const db = require("./db");
const { parseWorkbook } = require("./parser");
const { computeComparativo, computeDashboard, computeAlertas, computeAgrupamiento, computeVistaProveedor } = require("./analytics");

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error("Solo se aceptan archivos .xlsx o .xls"), ok);
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function getAllQuotes() {
  return db.prepare("SELECT * FROM quotes").all();
}
function getAllFiles() {
  return db
    .prepare(
      `SELECT f.*, COUNT(q.id) as n_productos
       FROM files f LEFT JOIN quotes q ON q.file_id = f.id
       GROUP BY f.id ORDER BY f.uploaded_at DESC`
    )
    .all();
}
function getContrapropuestaPct() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'contrapropuesta_pct'").get();
  return row ? Number(row.value) : 2;
}
function upsertCatalogo(entries) {
  if (!entries || entries.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO catalogo (codigo, producto, presentacion) VALUES (@codigo, @producto, @presentacion)
    ON CONFLICT(codigo) DO UPDATE SET
      producto = CASE WHEN excluded.producto <> '' THEN excluded.producto ELSE catalogo.producto END,
      presentacion = CASE WHEN excluded.presentacion <> '' THEN excluded.presentacion ELSE catalogo.presentacion END
  `);
  const insertAll = db.transaction((rows) => { rows.forEach((r) => stmt.run(r)); });
  insertAll(entries);
}

app.post("/api/upload", upload.array("files", 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No se recibió ningún archivo." });
  }
  const results = [];
  const insertFile = db.prepare(
    "INSERT INTO files (id, name, proveedor, semana, fecha_envio, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertQuote = db.prepare(`
    INSERT INTO quotes (file_id, codigo, producto, presentacion, disponibilidad, precio, observacion, proveedor, semana, vigencia_fin)
    VALUES (@file_id, @codigo, @producto, @presentacion, @disponibilidad, @precio, @observacion, @proveedor, @semana, @vigenciaFin)
  `);

  for (const file of req.files) {
    try {
      const { meta, records, catalogo } = parseWorkbook(file.buffer, file.originalname);
      const fileId = crypto.randomUUID();
      const insertAll = db.transaction(() => {
        insertFile.run(fileId, file.originalname, meta.proveedor, meta.semana, meta.fechaEnvio, new Date().toISOString());
        records.forEach((r) => insertQuote.run({ file_id: fileId, ...r }));
      });
      insertAll();
      upsertCatalogo(catalogo);
      results.push({ file: file.originalname, ok: true, proveedor: meta.proveedor, nProductos: records.length });
    } catch (err) {
      results.push({ file: file.originalname, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

app.get("/api/catalogo", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  const like = "%" + q + "%";
  const rows = db
    .prepare("SELECT codigo, producto, presentacion FROM catalogo WHERE codigo LIKE ? OR producto LIKE ? OR presentacion LIKE ? ORDER BY producto LIMIT 20")
    .all(like, like, like);
  res.json(rows);
});

app.post("/api/catalogo", (req, res) => {
  const { codigo, producto, presentacion } = req.body || {};
  const cod = codigo !== undefined && codigo !== null ? String(codigo).trim() : "";
  if (!cod) return res.status(400).json({ error: "Falta el código del producto." });
  if (!producto || !String(producto).trim()) return res.status(400).json({ error: "Falta el nombre del producto." });

  const existente = db.prepare("SELECT codigo FROM catalogo WHERE codigo = ?").get(cod);
  if (existente) {
    return res.status(409).json({ error: "Ya existe un producto con ese código en el catálogo.", codigo: cod });
  }
  db.prepare("INSERT INTO catalogo (codigo, producto, presentacion) VALUES (?, ?, ?)")
    .run(cod, String(producto).trim(), presentacion ? String(presentacion).trim() : "");
  res.json({ ok: true, codigo: cod, producto: String(producto).trim(), presentacion: presentacion || "" });
});

app.get("/api/producto-referencia", (req, res) => {
  const codigo = (req.query.codigo || "").trim();
  if (!codigo) return res.status(400).json({ error: "Falta el código del producto." });
  const pct = getContrapropuestaPct();
  const comparativoGlobal = computeComparativo(getAllQuotes(), pct);
  const fila = comparativoGlobal.find((r) => r.codigo === codigo);
  if (!fila) {
    return res.json({ codigo, precioMinimo: null, proveedorMinimo: null, contrapropuestaSugerida: null, nProveedores: 0 });
  }
  res.json({
    codigo,
    precioMinimo: fila.precioMin,
    proveedorMinimo: fila.proveedorMin,
    contrapropuestaSugerida: fila.redondeada,
    nProveedores: fila.nProveedores,
  });
});

app.get("/api/proveedor-productos", (req, res) => {
  const proveedor = (req.query.proveedor || "").trim();
  if (!proveedor) return res.status(400).json({ error: "Falta el parámetro proveedor." });
  const rows = db.prepare(`
    SELECT
      pp.codigo,
      pp.tipo,
      pp.actualizado_en,
      pp.contrapropuesta_manual,
      pp.activo,
      pp.presentacion_proveedor,
      c.producto,
      c.presentacion AS presentacion_catalogo,
      COALESCE(NULLIF(pp.presentacion_proveedor, ''), c.presentacion) AS presentacion
    FROM proveedor_productos pp
    LEFT JOIN catalogo c ON c.codigo = pp.codigo
    WHERE pp.proveedor = ?
    ORDER BY c.producto
  `).all(proveedor);
  res.json(rows);
});

app.post("/api/proveedor-productos", (req, res) => {
  const { proveedor, codigo, tipo, presentacion, precio, contrapropuesta } = req.body || {};
  const prov = proveedor && String(proveedor).trim();
  const cod = codigo !== undefined && codigo !== null ? String(codigo).trim() : "";
  const tipoFinal = tipo === "habitual" ? "habitual" : "adicional";
  if (!prov) return res.status(400).json({ error: "Falta el proveedor." });
  if (!cod) return res.status(400).json({ error: "Falta el código del producto." });

  const existeProducto = db.prepare("SELECT codigo, presentacion FROM catalogo WHERE codigo = ?").get(cod);
  if (!existeProducto) {
    return res.status(404).json({ error: "Ese código no existe en el catálogo. Créalo primero." });
  }

  const presentacionProveedor =
    presentacion !== undefined && presentacion !== null && String(presentacion).trim()
      ? String(presentacion).trim()
      : null;

  const contrapropuestaManual = contrapropuesta !== undefined && contrapropuesta !== null && contrapropuesta !== ""
    ? Number(contrapropuesta) : null;

  db.prepare(`
    INSERT INTO proveedor_productos (
      proveedor, codigo, tipo, actualizado_en,
      contrapropuesta_manual, activo, presentacion_proveedor
    )
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(proveedor, codigo) DO UPDATE SET
      tipo = excluded.tipo,
      actualizado_en = excluded.actualizado_en,
      contrapropuesta_manual = excluded.contrapropuesta_manual,
      presentacion_proveedor = COALESCE(
        excluded.presentacion_proveedor,
        proveedor_productos.presentacion_proveedor
      ),
      activo = 1
  `).run(
    prov,
    cod,
    tipoFinal,
    new Date().toISOString(),
    contrapropuestaManual,
    presentacionProveedor
  );

  const precioNum = Number(precio);
  let cotizacionCreada = false;
  if (precio !== undefined && precio !== null && precio !== "" && !isNaN(precioNum) && precioNum > 0) {
    const catActual = db.prepare("SELECT producto, presentacion FROM catalogo WHERE codigo = ?").get(cod);
    const fileId = crypto.randomUUID();
    const insertFile = db.prepare(
      "INSERT INTO files (id, name, proveedor, semana, fecha_envio, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertQuote = db.prepare(`
      INSERT INTO quotes (file_id, codigo, producto, presentacion, disponibilidad, precio, observacion, proveedor, semana, vigencia_fin)
      VALUES (@file_id, @codigo, @producto, @presentacion, @disponibilidad, @precio, @observacion, @proveedor, @semana, @vigenciaFin)
    `);
    const insertAll = db.transaction(() => {
      insertFile.run(fileId, "Agregado desde Por Proveedor", prov, "N/D", null, new Date().toISOString());
      insertQuote.run({
        file_id: fileId,
        codigo: cod,
        producto: catActual.producto,
        presentacion: presentacionProveedor || catActual.presentacion,
        disponibilidad: null, precio: precioNum, observacion: null, proveedor: prov, semana: "N/D", vigenciaFin: null,
      });
    });
    insertAll();
    cotizacionCreada = true;
  }

  res.json({ ok: true, proveedor: prov, codigo: cod, tipo: tipoFinal, contrapropuestaManual, cotizacionCreada });
});

app.post("/api/proveedor-productos/quitar", (req, res) => {
  const { proveedor, codigo } = req.body || {};
  const prov = proveedor && String(proveedor).trim();
  const cod = codigo !== undefined && codigo !== null ? String(codigo).trim() : "";
  if (!prov || !cod) return res.status(400).json({ error: "Falta proveedor o código." });

  db.prepare(`
    INSERT INTO proveedor_productos (proveedor, codigo, tipo, actualizado_en, activo)
    VALUES (?, ?, 'adicional', ?, 0)
    ON CONFLICT(proveedor, codigo) DO UPDATE SET activo = 0, actualizado_en = excluded.actualizado_en
  `).run(prov, cod, new Date().toISOString());

  res.json({ ok: true, proveedor: prov, codigo: cod, activo: false });
});

app.post("/api/proveedor-productos/restaurar", (req, res) => {
  const { proveedor, codigo } = req.body || {};
  const prov = proveedor && String(proveedor).trim();
  const cod = codigo !== undefined && codigo !== null ? String(codigo).trim() : "";
  if (!prov || !cod) return res.status(400).json({ error: "Falta proveedor o código." });

  db.prepare("UPDATE proveedor_productos SET activo = 1, actualizado_en = ? WHERE proveedor = ? AND codigo = ?")
    .run(new Date().toISOString(), prov, cod);

  res.json({ ok: true, proveedor: prov, codigo: cod, activo: true });
});

app.post("/api/manual", (req, res) => {
  const { proveedor, semana, fechaEnvio, vigenciaFin, items } = req.body || {};
  if (!proveedor || !String(proveedor).trim()) {
    return res.status(400).json({ error: "Falta el nombre del proveedor." });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Agrega al menos un producto." });
  }

  const validos = items.filter((it) => {
    const codigo = it && it.codigo !== undefined && it.codigo !== null ? String(it.codigo).trim() : "";
    const precio = Number(it && it.precio);
    return codigo !== "" && !isNaN(precio) && precio > 0;
  });
  if (validos.length === 0) {
    return res.status(400).json({ error: "Ningún producto tiene código y precio válidos (mayor a 0)." });
  }

  const fileId = crypto.randomUUID();
  const insertFile = db.prepare(
    "INSERT INTO files (id, name, proveedor, semana, fecha_envio, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertQuote = db.prepare(`
    INSERT INTO quotes (file_id, codigo, producto, presentacion, disponibilidad, precio, observacion, proveedor, semana, vigencia_fin)
    VALUES (@file_id, @codigo, @producto, @presentacion, @disponibilidad, @precio, @observacion, @proveedor, @semana, @vigenciaFin)
  `);

  const proveedorNorm = String(proveedor).trim().toUpperCase();
  const semanaFinal = semana && String(semana).trim() ? String(semana).trim() : "N/D";

  const insertAll = db.transaction(() => {
    insertFile.run(
      fileId,
      "Ingreso manual",
      proveedorNorm,
      semanaFinal,
      fechaEnvio || null,
      new Date().toISOString()
    );
    validos.forEach((it) => {
      insertQuote.run({
        file_id: fileId,
        codigo: String(it.codigo).trim(),
        producto: it.producto ? String(it.producto).trim() : "",
        presentacion: it.presentacion ? String(it.presentacion).trim() : "",
        disponibilidad: it.disponibilidad ? String(it.disponibilidad) : null,
        precio: Number(it.precio),
        observacion: it.observacion ? String(it.observacion) : null,
        proveedor: proveedorNorm,
        semana: semanaFinal,
        vigenciaFin: vigenciaFin || null,
      });
    });
  });
  insertAll();
  upsertCatalogo(validos.map((it) => ({
    codigo: String(it.codigo).trim(),
    producto: it.producto ? String(it.producto).trim() : "",
    presentacion: it.presentacion ? String(it.presentacion).trim() : "",
  })));

  res.json({ ok: true, proveedor: proveedorNorm, nProductos: validos.length });
});

app.get("/api/files", (req, res) => {
  res.json(getAllFiles());
});

app.delete("/api/files/:id", (req, res) => {
  const del = db.transaction((id) => {
    db.prepare("DELETE FROM quotes WHERE file_id = ?").run(id);
    db.prepare("DELETE FROM files WHERE id = ?").run(id);
  });
  del(req.params.id);
  res.json({ ok: true });
});

app.get("/api/quotes", (req, res) => {
  res.json(getAllQuotes());
});

app.get("/api/comparativo", (req, res) => {
  const pct = getContrapropuestaPct();
  const rows = computeComparativo(getAllQuotes(), pct).map(({ _quotes, ...rest }) => rest);
  res.json(rows);
});

app.get("/api/alertas", (req, res) => {
  const pct = getContrapropuestaPct();
  const comparativo = computeComparativo(getAllQuotes(), pct);
  res.json(computeAlertas(comparativo));
});

app.get("/api/proveedores", (req, res) => {
  const rows = db.prepare("SELECT DISTINCT proveedor FROM quotes ORDER BY proveedor").all();
  res.json(rows.map((r) => r.proveedor));
});

app.get("/api/por-proveedor", (req, res) => {
  const proveedor = (req.query.proveedor || "").trim();
  if (!proveedor) return res.status(400).json({ error: "Falta el parámetro proveedor." });
  const pct = getContrapropuestaPct();
  const quotes = getAllQuotes();
  let items = computeVistaProveedor(quotes, proveedor, pct);

  const asociados = db.prepare(
    "SELECT codigo, tipo, contrapropuesta_manual, activo, presentacion_proveedor FROM proveedor_productos WHERE proveedor = ?"
  ).all(proveedor);

  const tipoPorCodigo = {};
  const manualPorCodigo = {};
  const activoPorCodigo = {};
  const presentacionPorCodigo = {};
  asociados.forEach((a) => {
    tipoPorCodigo[a.codigo] = a.tipo;
    manualPorCodigo[a.codigo] = a.contrapropuesta_manual;
    activoPorCodigo[a.codigo] = a.activo;
    presentacionPorCodigo[a.codigo] = a.presentacion_proveedor;
  });

  items = items.filter((it) => activoPorCodigo[it.codigo] !== 0);

  const minimoHistoricoProveedor = {};
  quotes
    .filter((q) => q.proveedor === proveedor)
    .forEach((q) => {
      const precio = Number(q.precio);
      if (!Number.isFinite(precio) || precio <= 0) return;

      if (
        minimoHistoricoProveedor[q.codigo] === undefined ||
        precio < minimoHistoricoProveedor[q.codigo]
      ) {
        minimoHistoricoProveedor[q.codigo] = precio;
      }
    });

  items.forEach((it) => {
    it.tipo = tipoPorCodigo[it.codigo] || null;

    if (
      presentacionPorCodigo[it.codigo] !== undefined &&
      presentacionPorCodigo[it.codigo] !== null &&
      String(presentacionPorCodigo[it.codigo]).trim() !== ""
    ) {
      it.presentacion = presentacionPorCodigo[it.codigo];
    }

    it.precioMinimoProveedor =
      minimoHistoricoProveedor[it.codigo] !== undefined
        ? minimoHistoricoProveedor[it.codigo]
        : null;
    if (manualPorCodigo[it.codigo] !== undefined && manualPorCodigo[it.codigo] !== null) {
      it.contrapropuesta = manualPorCodigo[it.codigo];
      it.redondeada = manualPorCodigo[it.codigo];
      it.contrapropuestaEsManual = true;
    }
  });

  const yaIncluidos = new Set(items.map((it) => it.codigo));
  const comparativoGlobal = computeComparativo(quotes, pct);
  const porCodigoGlobal = {};
  comparativoGlobal.forEach((r) => { porCodigoGlobal[r.codigo] = r; });

  asociados
    .filter((a) => a.activo !== 0 && !yaIncluidos.has(a.codigo))
    .forEach((a) => {
      const cat = db.prepare("SELECT producto, presentacion FROM catalogo WHERE codigo = ?").get(a.codigo) || {};
      const global = porCodigoGlobal[a.codigo] || null;
      const manual = manualPorCodigo[a.codigo];
      items.push({
        codigo: a.codigo,
        producto: cat.producto || a.codigo,
        presentacion:
          presentacionPorCodigo[a.codigo] ||
          cat.presentacion ||
          "",
        precioProveedor: null,
        precioMinimoProveedor:
          minimoHistoricoProveedor[a.codigo] !== undefined
            ? minimoHistoricoProveedor[a.codigo]
            : null,
        precioMinimo: global ? global.precioMin : null,
        proveedorMinimo: global ? global.proveedorMin : null,
        esElMinimo: false,
        esUnico: global ? global.nProveedores === 1 : false,
        nProveedores: global ? global.nProveedores : 0,
        contrapropuesta: manual !== undefined && manual !== null ? manual : (global ? global.contrapropuesta : null),
        redondeada: manual !== undefined && manual !== null ? manual : (global ? global.redondeada : null),
        contrapropuestaEsManual: manual !== undefined && manual !== null,
        tipo: a.tipo,
        sinCotizarEstaSemana: true,
      });
    });

  items.sort((a, b) => (a.producto || "").localeCompare(b.producto || ""));
  res.json({ proveedor, contrapropuestaPct: pct, items });
});

app.get("/api/por-proveedor/export", (req, res) => {
  const proveedor = (req.query.proveedor || "").trim();
  if (!proveedor) return res.status(400).json({ error: "Falta el parámetro proveedor." });
  const pct = getContrapropuestaPct();
  const items = computeVistaProveedor(getAllQuotes(), proveedor, pct);

  const ws = XLSX.utils.json_to_sheet(
    items.map((it) => ({
      "Código": it.codigo,
      Producto: it.producto,
      "Presentación": it.presentacion,
      [`Precio ${proveedor}`]: it.precioProveedor,
      "Precio Mínimo del Mercado": it.precioMinimo,
      "Proveedor Mínimo": it.proveedorMinimo,
      [`Contrapropuesta -${pct}%`]: Math.round(it.contrapropuesta),
      "Contrapropuesta Redondeada (centenas)": it.redondeada,
      "Estado": it.esUnico ? "Proveedor único" : (it.esElMinimo ? "Ya es el más barato" : "Negociar"),
    }))
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Contrapropuesta");
  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

  const nombreArchivo = "Contrapropuesta_" + proveedor.replace(/[^a-zA-Z0-9]+/g, "_") + ".xlsx";
  res.setHeader("Content-Disposition", `attachment; filename="${nombreArchivo}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

app.get("/api/agrupamiento", (req, res) => {
  const umbral = req.query.umbral !== undefined ? Number(req.query.umbral) : 10;
  res.json(computeAgrupamiento(getAllQuotes(), isNaN(umbral) ? 10 : umbral));
});

app.get("/api/settings", (req, res) => {
  res.json({ contrapropuestaPct: getContrapropuestaPct() });
});

app.post("/api/settings", (req, res) => {
  const { contrapropuestaPct } = req.body || {};
  const pct = Number(contrapropuestaPct);
  if (isNaN(pct) || pct < 1.5 || pct > 2) {
    return res.status(400).json({ error: "El % de contrapropuesta debe estar entre 1.5 y 2." });
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('contrapropuesta_pct', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(pct));
  res.json({ ok: true, contrapropuestaPct: pct });
});

app.get("/api/dashboard", (req, res) => {
  const quotes = getAllQuotes();
  const pct = getContrapropuestaPct();
  const comparativo = computeComparativo(quotes, pct);
  res.json(computeDashboard(quotes, comparativo));
});

app.get("/api/export", (req, res) => {
  const quotes = getAllQuotes();
  const pct = getContrapropuestaPct();
  const comparativo = computeComparativo(quotes, pct);
  const dashboard = computeDashboard(quotes, comparativo);

  const wsCot = XLSX.utils.json_to_sheet(
    quotes.map((q) => ({
      Proveedor: q.proveedor,
      Semana: q.semana,
      "Código": q.codigo,
      Producto: q.producto,
      "Presentación": q.presentacion,
      Disponibilidad: q.disponibilidad,
      "Precio Cotizado": q.precio,
      "Vigencia": q.vigencia_fin,
      "Observación": q.observacion,
    }))
  );
  const wsComp = XLSX.utils.json_to_sheet(
    comparativo.map((r) => ({
      "Código": r.codigo,
      Producto: r.producto,
      "Presentación": r.presentacion,
      "N° Proveedores": r.nProveedores,
      "Precio Mínimo": r.precioMin,
      "Proveedor Mejor Precio": r.proveedorMin,
      "Precio Segundo Mejor": r.precioSegundo,
      "Proveedor Segundo Mejor": r.proveedorSegundo,
      "Precio Máximo": r.precioMax,
      "% Diferencia": r.diffPct,
      [`Contrapropuesta -${pct}%`]: Math.round(r.contrapropuesta),
      "Contrapropuesta Redondeada (centenas)": r.redondeada,
      "Vigencia Mejor Oferta": r.vigencia,
    }))
  );
  const wsDash = XLSX.utils.json_to_sheet([
    { Indicador: "Total de productos cotizados", Valor: dashboard.totalProductos },
    { Indicador: "Productos con más de 1 proveedor", Valor: dashboard.conVarios },
    { Indicador: "Ahorro potencial (máx. vs mín.)", Valor: Math.round(dashboard.ahorroPotencial) },
    { Indicador: `Ahorro adicional por contrapropuesta -${pct}%`, Valor: Math.round(dashboard.ahorroContrapropuesta) },
    {},
    { Indicador: "Proveedor", Valor: "Precio Promedio / % Dif. Promedio / N° Ganados" },
    ...dashboard.proveedores.map((p) => ({
      Indicador: p.proveedor,
      Valor: `${Math.round(p.avgPrecio)} / ${(p.avgDiff * 100).toFixed(1)}% / ${p.victorias}`,
    })),
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsCot, "Cotizaciones");
  XLSX.utils.book_append_sheet(wb, wsComp, "Comparativo");
  XLSX.utils.book_append_sheet(wb, wsDash, "Dashboard");
  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

  res.setHeader("Content-Disposition", 'attachment; filename="Comparativo_Cotizaciones.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

app.post("/api/reset", (req, res) => {
  db.exec("DELETE FROM quotes; DELETE FROM files;");
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Error inesperado" });
});

app.listen(PORT, () => {
  console.log(`Comparador de Cotizaciones escuchando en el puerto ${PORT}`);
});

