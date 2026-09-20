(function () {
  "use strict";

  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2800);
  }
  function norm(s) {
    return (s === null || s === undefined ? "" : String(s))
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return "$" + Math.round(n).toLocaleString("es-CO");
  }
  function fmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return (n * 100).toFixed(1) + "%";
  }
  function fmtDate(v) {
    if (!v) return "—";
    return String(v);
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) {
      let msg = "Error de servidor";
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    return res;
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (files.length === 0) { toast("Selecciona archivos .xlsx válidos."); return; }
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    const btn = document.getElementById("dropzone");
    btn.style.opacity = "0.6";
    try {
      const res = await api("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      const ok = data.results.filter((r) => r.ok).length;
      const fail = data.results.filter((r) => !r.ok);
      if (ok > 0) toast(`Se cargaron ${ok} archivo(s) correctamente.`);
      fail.forEach((f) => toast(`⚠ ${f.file}: ${f.error}`));
      await renderAll();
    } catch (err) {
      toast("No se pudo subir el archivo: " + err.message);
    } finally {
      btn.style.opacity = "1";
    }
  }

  async function removeFile(fileId) {
    try {
      await api("/api/files/" + fileId, { method: "DELETE" });
      await renderAll();
    } catch (err) {
      toast("No se pudo eliminar el archivo.");
    }
  }

  async function renderFiles() {
    const files = await (await api("/api/files")).json();
    const container = document.getElementById("fileList");
    container.innerHTML = "";
    files.forEach((f) => {
      const div = document.createElement("div");
      div.className = "file-row";
      div.innerHTML =
        '<div class="meta"><span class="name">' + f.proveedor + "</span>" +
        '<span class="sub">' + f.name + " · Semana " + f.semana + " · " + f.n_productos + " productos</span></div>";
      const btn = document.createElement("button");
      btn.className = "btn-ghost";
      btn.textContent = "Quitar";
      btn.onclick = () => removeFile(f.id);
      div.appendChild(btn);
      container.appendChild(div);
    });
  }

  async function renderComparativo(filterText) {
    const rows = await (await api("/api/comparativo")).json();
    document.getElementById("countComparativo").textContent = rows.length;
    document.getElementById("btnExport").disabled = rows.length === 0;

    const filtered = filterText
      ? rows.filter((r) => norm(r.producto).includes(norm(filterText)) || norm(r.codigo).includes(norm(filterText)))
      : rows;

    const tbody = document.getElementById("comparativoBody");
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;padding:30px;color:var(--ink-soft)">Sin resultados.</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map((r) => {
      const warnCell = r.diffPct > 0.15 ? ' class="cell-warn"' : "";
      return "<tr>" +
        "<td>" + r.codigo + "</td>" +
        "<td>" + r.producto + "</td>" +
        "<td>" + r.presentacion + "</td>" +
        "<td>" + r.nProveedores + "</td>" +
        '<td class="cell-best"><div>' + fmtMoney(r.precioMin) + '</div><div class="cell-sub">' + r.proveedorMin + "</div></td>" +
        "<td>" + r.proveedorMin + "</td>" +
        '<td class="' + (r.precioSegundo !== null ? "cell-second" : "") + '">' +
          (r.precioSegundo !== null ? '<div>' + fmtMoney(r.precioSegundo) + '</div><div class="cell-sub">' + r.proveedorSegundo + "</div>" : "—") + "</td>" +
        "<td>" + (r.proveedorSegundo || "—") + "</td>" +
        "<td" + warnCell + ">" + fmtMoney(r.precioMax) + "</td>" +
        "<td" + warnCell + ">" + fmtPct(r.diffPct) + "</td>" +
        "<td>" + fmtMoney(r.contrapropuesta) + "</td>" +
        "<td><strong>" + fmtMoney(r.redondeada) + "</strong></td>" +
        "<td>" + fmtDate(r.vigencia) + "</td>" +
        "</tr>";
    }).join("");
  }

  async function renderDashboard() {
    const d = await (await api("/api/dashboard")).json();
    const kpis = [
      { label: "Total de productos cotizados", value: d.totalProductos },
      { label: "Productos con más de 1 proveedor", value: d.conVarios },
      { label: "Ahorro potencial (máx. vs. mín.)", value: fmtMoney(d.ahorroPotencial) },
      { label: "Ahorro adicional por contrapropuesta -2%", value: fmtMoney(d.ahorroContrapropuesta) },
    ];
    document.getElementById("kpiGrid").innerHTML = kpis.map((k) =>
      '<div class="kpi"><div class="label">' + k.label + '</div><div class="value">' + k.value + "</div></div>"
    ).join("");

    const maxPrecio = Math.max(1, ...d.proveedores.map((p) => p.avgPrecio));
    document.getElementById("barsPromedio").innerHTML = d.proveedores.length ? d.proveedores.map((p) =>
      '<div class="bar-row"><div class="name">' + p.proveedor + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (p.avgPrecio / maxPrecio * 100) + '%"></div></div>' +
      '<div class="val">' + fmtMoney(p.avgPrecio) + "</div></div>"
    ).join("") : '<p style="color:var(--ink-soft);font-size:0.85rem">Sin datos todavía.</p>';

    const maxDiff = Math.max(0.01, ...d.proveedores.map((p) => p.avgDiff));
    document.getElementById("barsDiferencia").innerHTML = d.proveedores.length ? d.proveedores.map((p) =>
      '<div class="bar-row"><div class="name">' + p.proveedor + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (p.avgDiff / maxDiff * 100) + '%;background:var(--second)"></div></div>' +
      '<div class="val">' + fmtPct(p.avgDiff) + "</div></div>"
    ).join("") : '<p style="color:var(--ink-soft);font-size:0.85rem">Sin datos todavía.</p>';

    const maxVict = Math.max(1, ...d.proveedores.map((p) => p.victorias));
    document.getElementById("barsGanados").innerHTML = d.proveedores.length ? d.proveedores.map((p) =>
      '<div class="bar-row"><div class="name">' + p.proveedor + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (p.victorias / maxVict * 100) + '%;background:var(--best)"></div></div>' +
      '<div class="val">' + p.victorias + "</div></div>"
    ).join("") : '<p style="color:var(--ink-soft);font-size:0.85rem">Sin datos todavía.</p>';
  }

  function buildAlertRowsHTML(a) {
    let html = "";
    if (a.diferenciasImportantes.length) {
      html += a.diferenciasImportantes.map((r) =>
        '<div class="alert-row warn" data-codigo="' + r.codigo + '" role="button" tabindex="0">' +
        '<div><div class="a-name">⚠ ' + r.producto + " (" + r.codigo + ")</div>" +
        '<div class="a-sub">Más barato: ' + r.proveedorMin + " a " + fmtMoney(r.precioMin) + "</div></div>" +
        '<div class="a-val">' + fmtPct(r.diffPct) + " de diferencia ›</div></div>"
      ).join("");
    }
    if (a.vigenciasPorVencer.length) {
      html += a.vigenciasPorVencer.map((r) =>
        '<div class="alert-row warn" data-codigo="' + r.codigo + '" role="button" tabindex="0">' +
        '<div><div class="a-name">⏰ ' + r.producto + " (" + r.codigo + ")</div>" +
        '<div class="a-sub">Proveedor: ' + r.proveedor + "</div></div>" +
        '<div class="a-val">' + (r.estado === "vencida" ? "Vencida: " : "Vence hoy: ") + fmtDate(r.vigencia) + " ›</div></div>"
      ).join("");
    }
    return html;
  }

  function goToComparativo(codigo) {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelector('nav.tabs button[data-tab="comparativo"]').classList.add("active");
    ["cargar", "comparativo", "alertas", "proveedores", "por-proveedor", "dashboard"].forEach((t) => {
      document.getElementById("tab-" + t).style.display = t === "comparativo" ? "block" : "none";
    });
    const box = document.getElementById("searchBox");
    box.value = codigo;
    renderComparativo(codigo);
    document.getElementById("tab-comparativo").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.addEventListener("click", (e) => {
    const row = e.target.closest(".alert-row[data-codigo]");
    if (row) goToComparativo(row.dataset.codigo);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".alert-row[data-codigo]");
    if (row) { e.preventDefault(); goToComparativo(row.dataset.codigo); }
  });

  async function renderUploadAlertsBanner() {
    const a = await (await api("/api/alertas")).json();
    const card = document.getElementById("uploadAlertsCard");
    const container = document.getElementById("uploadAlerts");
    const html = buildAlertRowsHTML(a);
    if (html) {
      container.innerHTML = html;
      card.style.display = "block";
    } else {
      card.style.display = "none";
    }
  }

  async function renderAll() {
    await renderFiles();
    await renderComparativo(document.getElementById("searchBox").value);
    await refreshAlertCount();
    await renderUploadAlertsBanner();
  }

  async function refreshAlertCount() {
    const a = await (await api("/api/alertas")).json();
    const total = a.diferenciasImportantes.length + a.vigenciasPorVencer.length;
    document.getElementById("countAlertas").textContent = total;
  }

  async function renderAlertas() {
    const a = await (await api("/api/alertas")).json();
    document.getElementById("countAlertas").textContent = a.diferenciasImportantes.length + a.vigenciasPorVencer.length;

    const diffContainer = document.getElementById("alertasDiferencias");
    diffContainer.innerHTML = a.diferenciasImportantes.length
      ? a.diferenciasImportantes.map((r) =>
          '<div class="alert-row warn" data-codigo="' + r.codigo + '" role="button" tabindex="0"><div><div class="a-name">' + r.producto + " (" + r.codigo + ")</div>" +
          '<div class="a-sub">Más barato: ' + r.proveedorMin + " a " + fmtMoney(r.precioMin) + "</div></div>" +
          '<div class="a-val">' + fmtPct(r.diffPct) + " de diferencia ›</div></div>"
        ).join("")
      : '<p class="empty-alert">No hay diferencias mayores al 15% por ahora.</p>';

    const vigContainer = document.getElementById("alertasVigencias");
    vigContainer.innerHTML = a.vigenciasPorVencer.length
      ? a.vigenciasPorVencer.map((r) =>
          '<div class="alert-row warn" data-codigo="' + r.codigo + '" role="button" tabindex="0"><div><div class="a-name">' + r.producto + " (" + r.codigo + ")</div>" +
          '<div class="a-sub">Proveedor: ' + r.proveedor + "</div></div>" +
          '<div class="a-val">' + (r.estado === "vencida" ? "Vencida: " : "Vence hoy: ") + fmtDate(r.vigencia) + " ›</div></div>"
        ).join("")
      : '<p class="empty-alert">No hay vigencias por vencer hoy.</p>';
  }

  let umbralActual = 10;
  async function renderAgrupamiento() {
    const data = await (await api("/api/agrupamiento?umbral=" + umbralActual)).json();

    const gruposEl = document.getElementById("gruposProveedores");
    const gruposReales = data.grupos.filter((g) => g.tamano > 1);
    const sueltos = data.grupos.filter((g) => g.tamano === 1);
    let html = "";
    gruposReales.forEach((g, i) => {
      html += '<div class="alert-row" style="background:var(--brand-tint); cursor:default;">' +
        '<div><div class="a-name">Grupo ' + (i + 1) + '</div>' +
        '<div class="a-sub">' + g.miembros.join(" · ") + '</div></div>' +
        '<div class="a-val">' + g.tamano + ' proveedores</div></div>';
    });
    if (sueltos.length) {
      html += '<p style="color:var(--ink-soft); font-size:0.82rem; margin-top:14px;">Sin coincidencias suficientes: ' +
        sueltos.map((g) => g.miembros[0]).join(", ") + '</p>';
    }
    gruposEl.innerHTML = html || '<p class="empty-alert">Sube cotizaciones de al menos 2 proveedores para ver agrupamientos.</p>';

    const tbody = document.getElementById("paresBody");
    tbody.innerHTML = data.pares.length ? data.pares.map((p, i) => {
      const cls = p.conectados ? ' class="cell-best"' : "";
      const productosHtml = p.codigosComunes.length
        ? '<table style="width:100%;font-size:0.8rem;"><thead><tr><th style="text-align:left;padding:4px 8px;">Producto</th><th style="text-align:right;padding:4px 8px;">' +
          p.proveedorA + '</th><th style="text-align:right;padding:4px 8px;">' + p.proveedorB + '</th></tr></thead><tbody>' +
          p.codigosComunes.map((c) => {
            const menorA = c.precioA < c.precioB ? ' style="font-weight:700;color:var(--best)"' : "";
            const menorB = c.precioB < c.precioA ? ' style="font-weight:700;color:var(--best)"' : "";
            return "<tr><td style=\"padding:4px 8px;\">" + c.producto + " (" + c.codigo + ")</td>" +
              "<td" + menorA + " style=\"text-align:right;padding:4px 8px;\">" + fmtMoney(c.precioA) + "</td>" +
              "<td" + menorB + " style=\"text-align:right;padding:4px 8px;\">" + fmtMoney(c.precioB) + "</td></tr>";
          }).join("") + "</tbody></table>"
        : "Ninguno en común.";
      return "<tr>" +
        "<td>" + p.proveedorA + "</td>" +
        "<td>" + p.proveedorB + "</td>" +
        "<td>" + p.comunes + (p.comunes > 0
          ? ' <button class="btn-ghost" type="button" style="color:var(--brand);" data-toggle-productos="' + i + '">ver ›</button>'
          : "") + "</td>" +
        "<td" + cls + ">" + p.pctA.toFixed(1) + "% (de " + p.totalA + ")</td>" +
        "<td" + cls + ">" + p.pctB.toFixed(1) + "% (de " + p.totalB + ")</td>" +
        "<td>" + (p.conectados ? "✓ Sí" : "—") + "</td>" +
        "</tr>" +
        '<tr class="productos-comunes-row" id="productos-comunes-' + i + '" style="display:none;">' +
        '<td colspan="6" style="white-space:normal; background:var(--brand-tint); font-size:0.82rem;">' + productosHtml + "</td></tr>";
    }).join("") : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--ink-soft)">Necesitas al menos 2 proveedores con cotizaciones.</td></tr>';
    tbody.querySelectorAll("[data-toggle-productos]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = document.getElementById("productos-comunes-" + btn.dataset.toggleProductos);
        row.style.display = row.style.display === "none" ? "table-row" : "none";
      });
    });
  }
  document.getElementById("umbralSlider").addEventListener("input", async (e) => {
    umbralActual = Number(e.target.value);
    document.getElementById("umbralValue").textContent = umbralActual + "%";
    await renderAgrupamiento();
  });

  async function loadSettings() {
    const s = await (await api("/api/settings")).json();
    document.getElementById("pctSlider").value = s.contrapropuestaPct;
    document.getElementById("pctValue").textContent = s.contrapropuestaPct.toFixed(1) + "%";
  }
  document.getElementById("pctSlider").addEventListener("input", (e) => {
    document.getElementById("pctValue").textContent = Number(e.target.value).toFixed(1) + "%";
  });
  document.getElementById("btnSavePct").addEventListener("click", async () => {
    const pct = Number(document.getElementById("pctSlider").value);
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contrapropuestaPct: pct }),
      });
      toast("% de contrapropuesta actualizado a " + pct.toFixed(1) + "%.");
      await renderAll();
    } catch (err) {
      toast("No se pudo guardar: " + err.message);
    }
  });

  let manualRowCount = 0;
  function esc(v) { return (v || "").toString().replace(/"/g, "&quot;"); }

  async function autofillByCodigo(tr) {
    const codigoInput = tr.querySelector('[data-field="codigo"]');
    const codigo = codigoInput.value.trim();
    if (!codigo) return;
    try {
      const rows = await (await api("/api/catalogo?q=" + encodeURIComponent(codigo))).json();
      const match = rows.find((r) => norm(r.codigo) === norm(codigo));
      if (match) {
        tr.querySelector('[data-field="producto"]').value = match.producto || "";
        tr.querySelector('[data-field="presentacion"]').value = match.presentacion || "";
        tr.querySelector('[data-field="precio"]').focus();
        toast("Producto encontrado: " + (match.producto || match.codigo));
      }
    } catch (err) {
    }
  }

  function addManualRow(values) {
    values = values || {};
    manualRowCount++;
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td><input class="manual-input" data-field="codigo" placeholder="14721" value="' + esc(values.codigo) + '"></td>' +
      '<td><input class="manual-input" data-field="producto" placeholder="Acelga común kg" value="' + esc(values.producto) + '"></td>' +
      '<td><input class="manual-input" data-field="presentacion" placeholder="Kilo" value="' + esc(values.presentacion) + '"></td>' +
      '<td><select class="manual-input" data-field="disponibilidad">' +
        '<option value="Disponible">Disponible</option><option value="No disponible">No disponible</option>' +
        '</select></td>' +
      '<td><input class="manual-input" data-field="precio" type="number" min="0" placeholder="2400" value="' + esc(values.precio) + '"></td>' +
      '<td><input class="manual-input" data-field="observacion" placeholder="Opcional"></td>' +
      '<td><button class="btn-ghost" type="button">✕</button></td>';
    tr.querySelector(".btn-ghost").addEventListener("click", () => tr.remove());
    const codigoInput = tr.querySelector('[data-field="codigo"]');
    codigoInput.addEventListener("blur", () => autofillByCodigo(tr));
    codigoInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); autofillByCodigo(tr); }
    });
    document.getElementById("manualBody").appendChild(tr);
    if (values.codigo) tr.querySelector('[data-field="precio"]').focus();
  }

  document.getElementById("btnToggleManual").addEventListener("click", () => {
    const form = document.getElementById("manualForm");
    const isOpen = form.style.display !== "none";
    form.style.display = isOpen ? "none" : "block";
    document.getElementById("btnToggleManual").textContent = isOpen ? "Abrir formulario" : "Cerrar formulario";
    if (!isOpen && document.getElementById("manualBody").children.length === 0) {
      addManualRow(); addManualRow(); addManualRow();
    }
  });
  document.getElementById("btnAddRow").addEventListener("click", () => addManualRow());

  document.getElementById("btnSaveManual").addEventListener("click", async () => {
    const proveedor = document.getElementById("manualProveedor").value.trim();
    const semana = document.getElementById("manualSemana").value.trim();
    if (!proveedor) { toast("Escribe el nombre del proveedor."); return; }

    const items = Array.from(document.getElementById("manualBody").querySelectorAll("tr")).map((tr) => {
      const item = {};
      tr.querySelectorAll("[data-field]").forEach((el) => { item[el.dataset.field] = el.value; });
      return item;
    });

    try {
      const res = await api("/api/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proveedor, semana, items }),
      });
      const data = await res.json();
      toast("Se guardó la cotización de " + data.proveedor + " (" + data.nProductos + " productos).");
      document.getElementById("manualProveedor").value = "";
      document.getElementById("manualSemana").value = "";
      document.getElementById("manualBody").innerHTML = "";
      addManualRow(); addManualRow(); addManualRow();
      await renderAll();
    } catch (err) {
      toast("No se pudo guardar: " + err.message);
    }
  });

  let catalogoDebounce = null;
  const catalogoSearch = document.getElementById("catalogoSearch");
  const catalogoResults = document.getElementById("catalogoResults");

  catalogoSearch.addEventListener("input", () => {
    const q = catalogoSearch.value.trim();
    clearTimeout(catalogoDebounce);
    if (q.length < 2) { catalogoResults.style.display = "none"; return; }
    catalogoDebounce = setTimeout(async () => {
      try {
        const rows = await (await api("/api/catalogo?q=" + encodeURIComponent(q))).json();
        if (rows.length === 0) {
          catalogoResults.innerHTML = '<div class="catalogo-item" style="cursor:default;color:var(--ink-soft);">Sin coincidencias. Puedes agregarlo manualmente en una fila nueva.</div>';
        } else {
          catalogoResults.innerHTML = rows.map((r) =>
            '<div class="catalogo-item" data-codigo="' + r.codigo + '" data-producto="' + (r.producto || "").replace(/"/g, "&quot;") +
            '" data-presentacion="' + (r.presentacion || "").replace(/"/g, "&quot;") + '">' +
              (r.producto || "(sin nombre)") + '<br><span class="c-codigo">Código ' + r.codigo + (r.presentacion ? " · " + r.presentacion : "") + '</span>' +
            '</div>'
          ).join("");
        }
        catalogoResults.style.display = "block";
      } catch (err) {
        catalogoResults.style.display = "none";
      }
    }, 250);
  });

  catalogoResults.addEventListener("click", (e) => {
    const item = e.target.closest(".catalogo-item[data-codigo]");
    if (!item) return;
    addManualRow({
      codigo: item.dataset.codigo,
      producto: item.dataset.producto,
      presentacion: item.dataset.presentacion,
    });
    catalogoSearch.value = "";
    catalogoResults.style.display = "none";
    catalogoSearch.focus();
    toast("Producto agregado: " + item.dataset.producto);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#catalogoSearch") && !e.target.closest("#catalogoResults")) {
      catalogoResults.style.display = "none";
    }
  });

  // ---------- vista "Por Proveedor" ----------
  async function loadProveedoresSelect() {
    const nombres = await (await api("/api/proveedores")).json();
    const select = document.getElementById("porProveedorSelect");
    const actual = select.value;
    select.innerHTML = '<option value="">Selecciona un proveedor…</option>' +
      nombres.map((n) => '<option value="' + esc(n) + '">' + n + "</option>").join("");
    if (nombres.includes(actual)) select.value = actual;
  }

  let porProveedorItemsActuales = [];

  async function renderPorProveedor(proveedor) {
    const card = document.getElementById("porProveedorCard");
    if (!proveedor) { card.style.display = "none"; return; }
    const data = await (await api("/api/por-proveedor?proveedor=" + encodeURIComponent(proveedor))).json();
    porProveedorItemsActuales = data.items || [];
    document.getElementById("porProveedorTitulo").textContent = "Productos de " + data.proveedor + " (" + data.items.length + ")";
    const tbody = document.getElementById("porProveedorBody");
    tbody.innerHTML = data.items.length ? data.items.map((it) => {
      const filaCls = it.esUnico ? ' class="cell-warn"' : (it.esElMinimo ? ' class="cell-best"' : "");
      let estado;
      if (it.sinCotizarEstaSemana) estado = "Sin cotizar esta semana";
      else if (it.esUnico) estado = "Proveedor único";
      else if (it.esElMinimo) estado = "✓ Ya es el más barato";
      else estado = "Negociar con " + it.proveedorMinimo;
      const tipoTxt = it.tipo === "habitual" ? "Habitual" : (it.tipo === "adicional" ? "Adicional" : "—");
      const precioTxt = it.precioProveedor !== null ? fmtMoney(it.precioProveedor) : "—";
      const contraTxt = fmtMoney(it.redondeada) + (it.contrapropuestaEsManual ? ' <span class="cell-sub" style="display:inline;">(manual)</span>' : "");
      return "<tr>" +
        "<td>" + it.codigo + "</td>" +
        "<td>" + it.producto + "</td>" +
        "<td>" + it.presentacion + "</td>" +
        "<td" + filaCls + "><strong>" + precioTxt + "</strong></td>" +
        "<td>" + fmtMoney(it.precioMinimoProveedor) + "</td>" +
        "<td>" + fmtMoney(it.precioMinimo) + "</td>" +
        "<td>" + (it.proveedorMinimo || "—") + "</td>" +
        "<td><strong>" + contraTxt + "</strong></td>" +
        "<td>" + tipoTxt + "</td>" +
        "<td>" + estado + "</td>" +
        '<td><div style="display:flex;gap:6px;white-space:nowrap;">' +
          '<button class="btn-secondary btn-editar-proveedor" data-codigo="' + esc(it.codigo) + '">✏ Editar</button>' +
          '<button class="btn-ghost btn-eliminar-proveedor" data-codigo="' + esc(it.codigo) + '">🗑 Eliminar</button>' +
        "</div></td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--ink-soft)">Este proveedor no tiene productos cotizados.</td></tr>';
    card.style.display = "block";
  }

  document.getElementById("porProveedorSelect").addEventListener("change", (e) => {
    renderPorProveedor(e.target.value);
  });
  document.getElementById("btnExportPorProveedor").addEventListener("click", () => {
    const proveedor = document.getElementById("porProveedorSelect").value;
    if (!proveedor) return;
    window.location.href = "/api/por-proveedor/export?proveedor=" + encodeURIComponent(proveedor);
  });

  // ---------- editar / eliminar desde la tabla ----------
  document.getElementById("porProveedorBody").addEventListener("click", async (e) => {
    const btnEditar = e.target.closest(".btn-editar-proveedor");
    const btnEliminar = e.target.closest(".btn-eliminar-proveedor");

    if (!btnEditar && !btnEliminar) return;

    const boton = btnEditar || btnEliminar;
    const codigo = boton.dataset.codigo;
    const proveedor = document.getElementById("porProveedorSelect").value;

    const item = porProveedorItemsActuales.find(
      (x) => String(x.codigo) === String(codigo)
    );

    if (!item) {
      toast("No se encontró el producto seleccionado.");
      return;
    }

    if (btnEditar) {
      agpProductoElegido = {
        codigo: item.codigo,
        producto: item.producto,
        presentacion: item.presentacion
      };

      document.getElementById("agregarProductoOverlay").style.display = "flex";
      await agpAbrirPasoTipo(item);
      return;
    }

    if (btnEliminar) {
      const confirmar = window.confirm(
        "¿Deseas quitar " +
        item.producto +
        " de " +
        proveedor +
        "?\n\nEl historial de cotizaciones NO se eliminará."
      );

      if (!confirmar) return;

      try {
        await api("/api/proveedor-productos/quitar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proveedor,
            codigo: item.codigo
          })
        });

        toast(item.producto + " fue retirado de " + proveedor + ".");
        await renderPorProveedor(proveedor);
      } catch (err) {
        toast("No se pudo quitar el producto: " + err.message);
      }
    }
  });

  // ---------- modal: agregar / editar producto del proveedor ----------
  let agpProductoElegido = null;
  let agpModoEdicion = false;
  let agpPrecioOriginal = null;

  function agpMostrarPaso(paso) {
    document.getElementById("pasoBuscar").style.display = paso === "buscar" ? "block" : "none";
    document.getElementById("pasoCrear").style.display = paso === "crear" ? "block" : "none";
    document.getElementById("pasoTipo").style.display = paso === "tipo" ? "block" : "none";
  }

  function agpAbrir() {
    const proveedor = document.getElementById("porProveedorSelect").value;
    if (!proveedor) { toast("Primero selecciona un proveedor."); return; }

    agpModoEdicion = false;
    agpPrecioOriginal = null;
    document.getElementById("agpModalTitulo").textContent = "Agregar producto al proveedor";
    document.getElementById("btnConfirmarAsociar").textContent = "Guardar";

    agpProductoElegido = null;
    document.getElementById("agpBuscar").value = "";
    document.getElementById("agpResultados").innerHTML = "";
    document.getElementById("agpNuevoCodigo").value = "";
    document.getElementById("agpNuevoNombre").value = "";
    document.getElementById("agpNuevaPresentacion").value = "";
    agpMostrarPaso("buscar");
    document.getElementById("agregarProductoOverlay").style.display = "flex";
    document.getElementById("agpBuscar").focus();
  }
  function agpCerrar() {
    document.getElementById("agregarProductoOverlay").style.display = "none";
  }

  document.getElementById("btnAbrirAgregarProducto").addEventListener("click", agpAbrir);
  document.getElementById("btnCerrarAgregarProducto").addEventListener("click", agpCerrar);
  document.getElementById("agregarProductoOverlay").addEventListener("click", (e) => {
    if (e.target.id === "agregarProductoOverlay") agpCerrar();
  });

  let agpDebounce = null;
  document.getElementById("agpBuscar").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    clearTimeout(agpDebounce);
    const resultados = document.getElementById("agpResultados");
    if (q.length < 2) { resultados.innerHTML = ""; return; }
    agpDebounce = setTimeout(async () => {
      const rows = await (await api("/api/catalogo?q=" + encodeURIComponent(q))).json();
      resultados.innerHTML = rows.length
        ? rows.map((r) =>
            '<div class="agp-item" data-codigo="' + r.codigo + '" data-producto="' + esc(r.producto) +
            '" data-presentacion="' + esc(r.presentacion) + '">' +
              (r.producto || "(sin nombre)") + '<br><span class="c-codigo">Código ' + r.codigo + (r.presentacion ? " · " + r.presentacion : "") + '</span>' +
            '</div>'
          ).join("")
        : '<p style="color:var(--ink-soft); font-size:0.85rem;">Sin resultados. Puedes crear el producto abajo.</p>';
    }, 250);
  });

  document.getElementById("agpResultados").addEventListener("click", (e) => {
    const item = e.target.closest(".agp-item[data-codigo]");
    if (!item) return;
    agpProductoElegido = { codigo: item.dataset.codigo, producto: item.dataset.producto, presentacion: item.dataset.presentacion };
    agpAbrirPasoTipo();
  });

  document.getElementById("btnIrACrear").addEventListener("click", () => {
    document.getElementById("agpNuevoCodigo").value = document.getElementById("agpBuscar").value.trim();
    agpMostrarPaso("crear");
  });
  document.getElementById("btnVolverABuscar").addEventListener("click", () => agpMostrarPaso("buscar"));
  document.getElementById("btnVolverABuscarDesdeTipo").addEventListener("click", () => agpMostrarPaso("buscar"));

  document.getElementById("btnCrearYContinuar").addEventListener("click", async () => {
    const codigo = document.getElementById("agpNuevoCodigo").value.trim();
    const producto = document.getElementById("agpNuevoNombre").value.trim();
    const presentacion = document.getElementById("agpNuevaPresentacion").value.trim();
    if (!codigo || !producto) { toast("Escribe al menos el código y el nombre del producto."); return; }
    try {
      await api("/api/catalogo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo, producto, presentacion }),
      });
      agpProductoElegido = { codigo, producto, presentacion };
      agpAbrirPasoTipo();
    } catch (err) {
      toast("No se pudo crear: " + err.message);
    }
  });

  async function agpAbrirPasoTipo(itemExistente = null) {
    const esEdicion = !!itemExistente;

    if (esEdicion) {
      agpModoEdicion = true;
      agpPrecioOriginal = itemExistente.precioProveedor;

      document.getElementById("agpModalTitulo").textContent = "Editar producto del proveedor";
      document.getElementById("btnConfirmarAsociar").textContent = "Guardar cambios";
    }

    document.getElementById("agpProductoElegidoNombre").textContent =
      agpProductoElegido.producto + " (" + agpProductoElegido.codigo + ")";

    document.getElementById("agpEditPresentacion").value =
      itemExistente?.presentacion || agpProductoElegido.presentacion || "";

    document.getElementById("agpEditPrecio").value =
      itemExistente?.precioProveedor ?? "";

    document.getElementById("agpRefMinimoProveedor").value =
      itemExistente?.precioMinimoProveedor != null
        ? fmtMoney(itemExistente.precioMinimoProveedor)
        : "—";

    document.getElementById("agpRefMinimo").value = "Consultando…";
    document.getElementById("agpRefProveedor").value = "—";

    document.getElementById("agpEditContrapropuesta").value =
      itemExistente?.contrapropuestaEsManual
        ? itemExistente.redondeada
        : "";

    const tipoActual = itemExistente?.tipo || "habitual";
    const radioTipo = document.querySelector(
      'input[name="agpTipo"][value="' + tipoActual + '"]'
    );
    if (radioTipo) radioTipo.checked = true;

    agpMostrarPaso("tipo");

    try {
      const ref = await (
        await api(
          "/api/producto-referencia?codigo=" +
          encodeURIComponent(agpProductoElegido.codigo)
        )
      ).json();

      document.getElementById("agpRefMinimo").value =
        ref.precioMinimo !== null
          ? fmtMoney(ref.precioMinimo) +
            " (" +
            ref.nProveedores +
            " proveedor" +
            (ref.nProveedores === 1 ? "" : "es") +
            ")"
          : "Sin cotizaciones todavía";

      document.getElementById("agpRefProveedor").value =
        ref.proveedorMinimo || "—";

      if (!itemExistente?.contrapropuestaEsManual) {
        document.getElementById("agpEditContrapropuesta").value =
          ref.contrapropuestaSugerida !== null
            ? ref.contrapropuestaSugerida
            : "";
      }
    } catch (err) {
      document.getElementById("agpRefMinimo").value =
        "No se pudo consultar";
    }
  }

  document.getElementById("btnConfirmarAsociar").addEventListener("click", async () => {
    if (!agpProductoElegido) return;
    const proveedor = document.getElementById("porProveedorSelect").value;
    const tipo = document.querySelector('input[name="agpTipo"]:checked').value;
    const presentacion = document.getElementById("agpEditPresentacion").value.trim();
    let precio = document.getElementById("agpEditPrecio").value;
    const contrapropuesta = document.getElementById("agpEditContrapropuesta").value;

    // Si estamos editando y el precio sigue igual, no crear otra cotización histórica.
    if (
      agpModoEdicion &&
      precio !== "" &&
      agpPrecioOriginal !== null &&
      Number(precio) === Number(agpPrecioOriginal)
    ) {
      precio = "";
    }

    try {
      await api("/api/proveedor-productos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proveedor, codigo: agpProductoElegido.codigo, tipo, presentacion, precio, contrapropuesta }),
      });
      toast(agpProductoElegido.producto + " guardado para " + proveedor + ".");
      agpCerrar();
      await renderPorProveedor(proveedor);
    } catch (err) {
      toast("No se pudo guardar: " + err.message);
    }
  });

  // ---------- eventos ----------
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      ["cargar", "comparativo", "alertas", "proveedores", "por-proveedor", "dashboard"].forEach((t) => {
        document.getElementById("tab-" + t).style.display = t === btn.dataset.tab ? "block" : "none";
      });
      if (btn.dataset.tab === "dashboard") await renderDashboard();
      if (btn.dataset.tab === "alertas") await renderAlertas();
      if (btn.dataset.tab === "proveedores") await renderAgrupamiento();
      if (btn.dataset.tab === "por-proveedor") await loadProveedoresSelect();
    });
  });

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => { uploadFiles(e.target.files); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

  document.getElementById("searchBox").addEventListener("input", (e) => renderComparativo(e.target.value));
  document.getElementById("btnExport").addEventListener("click", () => { window.location.href = "/api/export"; });
  document.getElementById("btnClear").addEventListener("click", async () => {
    if (!confirm("¿Borrar TODAS las cotizaciones guardadas en el servidor? Esta acción no se puede deshacer.")) return;
    await api("/api/reset", { method: "POST" });
    await renderAll();
    toast("Datos borrados.");
  });

  renderAll();
  loadSettings();
})();

