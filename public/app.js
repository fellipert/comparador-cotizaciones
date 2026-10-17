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
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("Sesión expirada");
    }
    if (!res.ok) {
      let msg = "Error de servidor";
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    return res;
  }

  // ---------- carga de archivos ----------
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


  function inicializarSelectorSemanas() {
    const anioSelect = document.getElementById("cicloAnioSelect");
    const semanaSelect = document.getElementById("cicloSemanaSelect");

    const anioActual = new Date().getFullYear();

    anioSelect.innerHTML = "";

    for (let a = anioActual - 1; a <= anioActual + 2; a++) {
      const option = document.createElement("option");
      option.value = a;
      option.textContent = "Año " + a;
      if (a === anioActual) option.selected = true;
      anioSelect.appendChild(option);
    }

    semanaSelect.innerHTML = '<option value="">Selecciona semana...</option>';

    for (let s = 1; s <= 53; s++) {
      const option = document.createElement("option");
      option.value = s;
      option.textContent = "Semana " + s;
      semanaSelect.appendChild(option);
    }

    // Propone por defecto la semana SIGUIENTE a la actual (lo que se cargue ahora rige la semana que viene)
    const proxima = new Date();
    proxima.setDate(proxima.getDate() + 7);
    const t = new Date(Date.UTC(proxima.getFullYear(), proxima.getMonth(), proxima.getDate()));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
    const semanaProxima = 1 + Math.round((t - new Date(Date.UTC(t.getUTCFullYear(), 0, 4))) / (7 * 24 * 3600 * 1000));
    anioSelect.value = String(t.getUTCFullYear());
    semanaSelect.value = String(semanaProxima);
  }

  inicializarSelectorSemanas();

  // ---------- ciclo de cotización actual ----------
  async function loadCicloActual() {
    try {
      const data = await (await api("/api/ciclos/actual")).json();

      const btnCerrar = document.getElementById("btnCerrarCiclo");
      const btnAbrir = document.getElementById("btnAbrirCiclo");

      if (!data.activo || !data.ciclo) {
        document.getElementById("cicloId").textContent = "Sin ciclo activo";
        document.getElementById("cicloEstado").textContent = "—";
        document.getElementById("cicloFechas").textContent =
          "Selecciona Año y Semana para iniciar una nueva cotización.";

        btnCerrar.disabled = true;
        btnCerrar.dataset.cicloId = "";
        btnAbrir.disabled = false;
        return;
      }

      const ciclo = data.ciclo;

      document.getElementById("cicloId").textContent = ciclo.id;
      document.getElementById("cicloEstado").textContent = ciclo.estado;
      document.getElementById("cicloFechas").textContent =
        "Recepción: " + ciclo.fecha_inicio_recepcion + " al " + ciclo.fecha_fin_recepcion +
        " · Vigencia: " + ciclo.fecha_inicio_vigencia + " al " + ciclo.fecha_fin_vigencia;

      btnCerrar.disabled = !!ciclo.cerrado_en;
      btnAbrir.disabled = false;

      btnCerrar.dataset.cicloId = ciclo.id;
      btnAbrir.dataset.cicloId = ciclo.id;

    } catch (err) {
      document.getElementById("cicloFechas").textContent =
        "No se pudo cargar el ciclo activo.";
    }
  }

  document.getElementById("btnAbrirCiclo").addEventListener("click", async () => {
    const anio = Number(document.getElementById("cicloAnioSelect").value);
    const semana = Number(document.getElementById("cicloSemanaSelect").value);

    if (!anio || !semana) {
      toast("Selecciona el año y la semana.");
      return;
    }

    const codigo = "COT-" + anio + "-" + String(semana).padStart(2, "0");

    if (!confirm(
      "¿Abrir el ciclo " + codigo + "?\\n\\n" +
      "Las nuevas cotizaciones quedarán guardadas en esta semana."
    )) {
      return;
    }

    try {
      const r = await api("/api/ciclos/abrir-semana", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          anio,
          semana
        })
      });

      const data = await r.json();

      if (!r.ok) {
        throw new Error(data.error || "No fue posible abrir el ciclo.");
      }

      toast("Ciclo " + data.ciclo.id + " abierto.");

      await loadCicloActual();
      await loadCiclosParaFiltro();

      const filtro = document.getElementById("cicloFiltroSelect");
      filtro.value = data.ciclo.id;

      filtro.dispatchEvent(new Event("change"));

    } catch (err) {
      toast("No se pudo abrir: " + err.message);
    }
  });

  document.getElementById("btnCerrarCiclo").addEventListener("click", async () => {
    const id = document.getElementById("btnCerrarCiclo").dataset.cicloId;
    if (!id) return;
    if (!confirm("¿Cerrar el ciclo " + id + "? Ya no se podrán recibir más cotizaciones para esta semana.")) return;
    try {
      await api("/api/ciclos/" + encodeURIComponent(id) + "/cerrar", { method: "POST" });
      toast("Ciclo " + id + " cerrado.");
      await loadCicloActual();
    } catch (err) {
      toast("No se pudo cerrar: " + err.message);
    }
  });

  async function loadCiclosParaFiltro() {
    try {
      const ciclos = await (await api("/api/ciclos")).json();
      const select = document.getElementById("cicloFiltroSelect");
      const actual = select.value;
      select.innerHTML = '<option value="">Todos los ciclos</option>' +
        ciclos.map((c) => '<option value="' + c.id + '">' + c.id + " (" + c.estado + ")</option>").join("");
      if (ciclos.some((c) => c.id === actual)) select.value = actual;
    } catch (err) {}
  }

  async function loadCiclosTabla() {
    try {
      const ciclos = await (await api("/api/ciclos")).json();
      const tbody = document.getElementById("ciclosTableBody");
      tbody.innerHTML = ciclos.length ? ciclos.map((c) =>
        "<tr>" +
          "<td>" + c.id + "</td>" +
          "<td>" + c.fecha_inicio_recepcion + " al " + c.fecha_fin_recepcion + "</td>" +
          "<td>" + c.fecha_inicio_vigencia + " al " + c.fecha_fin_vigencia + "</td>" +
          "<td>" + c.estado + "</td>" +
          "<td>" + (c.cerrado_por || "—") + "</td>" +
        "</tr>"
      ).join("") : '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--ink-soft)">Sin ciclos todavía.</td></tr>';
    } catch (err) {}
  }

  // ---------- render ----------
  async function renderFiles() {
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const qsCiclo = cicloSeleccionado ? "?ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    const files = await (await api("/api/files" + qsCiclo)).json();
    const container = document.getElementById("fileList");
    container.innerHTML = "";
    files.forEach((f) => {
      const div = document.createElement("div");
      div.className = "file-row";
      div.innerHTML =
        '<div class="meta"><span class="name file-name-link" data-proveedor="' + esc(f.proveedor) + '" style="cursor:pointer; text-decoration:underline; text-decoration-style:dotted;">' + f.proveedor + "</span>" +
        '<span class="sub">' + f.name + " · Semana " + f.semana + " · " + f.n_productos + " productos</span></div>";
      const btn = document.createElement("button");
      btn.className = "btn-ghost";
      btn.textContent = "Quitar";
      btn.onclick = () => removeFile(f.id);
      div.appendChild(btn);
      container.appendChild(div);
    });
  }

  async function goToPorProveedor(proveedor) {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelector('nav.tabs button[data-tab="por-proveedor"]').classList.add("active");
    ["cargar", "comparativo", "alertas", "por-proveedor", "pedidos", "ordenes-compra", "hoja-negociacion", "configuracion"].forEach((t) => {
      document.getElementById("tab-" + t).style.display = t === "por-proveedor" ? "block" : "none";
    });
    await loadProveedoresSelect();
    const select = document.getElementById("porProveedorSelect");
    select.value = proveedor;
    await renderPorProveedor(proveedor);
    document.getElementById("tab-por-proveedor").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.addEventListener("click", (e) => {
    const link = e.target.closest(".file-name-link[data-proveedor]");
    if (link) goToPorProveedor(link.dataset.proveedor);
  });

  async function renderComparativo(filterText) {
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const qs = cicloSeleccionado ? "?ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    const rows = await (await api("/api/comparativo" + qs)).json();
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

  document.getElementById("cicloFiltroSelect").addEventListener("change", async () => {
    try {
      await renderFiles();
      await renderComparativo(document.getElementById("searchBox").value);
      await refreshAlertCount();
      await renderUploadAlertsBanner();
      await renderAlertas();

      const proveedorSeleccionado = document.getElementById("porProveedorSelect").value;
      if (proveedorSeleccionado) {
        await renderPorProveedor(proveedorSeleccionado);
      }
    } catch (err) {
      console.error("Error al cambiar ciclo:", err);
      toast("No se pudieron actualizar todas las vistas del ciclo.");
    }
  });

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
    ["cargar", "comparativo", "alertas", "por-proveedor", "pedidos", "ordenes-compra", "hoja-negociacion", "configuracion"].forEach((t) => {
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
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const qsCiclo = cicloSeleccionado ? "?ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    const a = await (await api("/api/alertas" + qsCiclo)).json();
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
    await loadCicloActual();
    await loadCiclosParaFiltro();
    await renderFiles();
    await renderComparativo(document.getElementById("searchBox").value);
    await refreshAlertCount();
    await renderUploadAlertsBanner();
  }

  async function refreshAlertCount() {
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const qsCiclo = cicloSeleccionado ? "?ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    const a = await (await api("/api/alertas" + qsCiclo)).json();
    const total = a.diferenciasImportantes.length + a.vigenciasPorVencer.length;
    document.getElementById("countAlertas").textContent = total;
  }

  async function renderAlertas() {
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const qsCiclo = cicloSeleccionado ? "?ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    const a = await (await api("/api/alertas" + qsCiclo)).json();
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

  // ---------- configuración: % de contrapropuesta ----------
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

  // ---------- llenado manual ----------
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

  // ---------- buscador del catálogo (autocompletar código + producto) ----------
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

  async function renderPorProveedor(proveedor) {
    const card = document.getElementById("porProveedorCard");
    if (!proveedor) { card.style.display = "none"; return; }
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const cicloParam = cicloSeleccionado ? "&ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    const data = await (await api("/api/por-proveedor?proveedor=" + encodeURIComponent(proveedor) + cicloParam)).json();
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
      const frecuenciaTxt = it.frecuencia === "semanal"
        ? "Semanal" + (it.semanaVigencia ? '<div class="cell-sub">' + it.semanaVigencia.etiqueta + '</div>' : "")
        : "Diario";
      return "<tr>" +
        "<td>" + it.codigo + "</td>" +
        "<td>" + it.producto + "</td>" +
        "<td>" + it.presentacion + "</td>" +
        "<td" + filaCls + "><strong>" + precioTxt + "</strong></td>" +
        "<td>" + fmtMoney(it.precioMinimo) + "</td>" +
        "<td>" + (it.proveedorMinimo || "—") + "</td>" +
        "<td><strong>" + contraTxt + "</strong></td>" +
        "<td>" + tipoTxt + "</td>" +
        "<td>" + frecuenciaTxt + "</td>" +
        "<td>" + estado + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--ink-soft)">Este proveedor no tiene productos cotizados.</td></tr>';
    card.style.display = "block";
  }

  document.getElementById("porProveedorSelect").addEventListener("change", (e) => {
    renderPorProveedor(e.target.value);
  });
  
  document.getElementById("btnPlantillaCotizacionProveedor").addEventListener("click", () => {

    const proveedor =
      document.getElementById("porProveedorSelect").value;

    if (!proveedor) {
      toast("Primero selecciona un proveedor.");
      return;
    }

    window.location.href =
      "/api/por-proveedor/plantilla-cotizacion?proveedor=" +
      encodeURIComponent(proveedor);

  });

  document.getElementById("btnExportPorProveedor").addEventListener("click", () => {
    const proveedor = document.getElementById("porProveedorSelect").value;
    if (!proveedor) return;
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const cicloParam = cicloSeleccionado ? "&ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    window.location.href = "/api/por-proveedor/export?proveedor=" + encodeURIComponent(proveedor) + cicloParam;
  });
  document.getElementById("btnMarcarHabituales").addEventListener("click", async () => {
    const proveedor = document.getElementById("porProveedorSelect").value;
    if (!proveedor) { toast("Primero selecciona un proveedor."); return; }
    if (!confirm('¿Marcar todos los productos que "' + proveedor + '" ya cotiza como HABITUALES?')) return;
    try {
      const res = await api("/api/proveedor-productos/marcar-habituales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proveedor }),
      });
      const data = await res.json();
      toast(data.actualizados + " producto(s) marcados como habituales.");
      await renderPorProveedor(proveedor);
    } catch (err) {
      toast("No se pudo marcar: " + err.message);
    }
  });

  // ---------- modal: agregar producto al proveedor ----------
  let agpProductoElegido = null; // {codigo, producto, presentacion}

  function agpMostrarPaso(paso) {
    document.getElementById("pasoBuscar").style.display = paso === "buscar" ? "block" : "none";
    document.getElementById("pasoCrear").style.display = paso === "crear" ? "block" : "none";
    document.getElementById("pasoTipo").style.display = paso === "tipo" ? "block" : "none";
  }

  function agpAbrir() {
    const proveedor = document.getElementById("porProveedorSelect").value;
    if (!proveedor) { toast("Primero selecciona un proveedor."); return; }
    agpProductoElegido = null;
    document.getElementById("agpBuscar").value = "";
    document.getElementById("agpResultados").innerHTML = '<p style="color:var(--ink-soft); font-size:0.85rem;">Cargando catálogo…</p>';
    document.getElementById("agpNuevoCodigo").value = "";
    document.getElementById("agpNuevoNombre").value = "";
    document.getElementById("agpNuevaPresentacion").value = "";
    agpMostrarPaso("buscar");
    document.getElementById("agregarProductoOverlay").style.display = "flex";
    document.getElementById("agpBuscar").focus();
    cargarCatalogoParaModal();
  }
  function agpCerrar() {
    document.getElementById("agregarProductoOverlay").style.display = "none";
  }

  function renderAgpResultados(lista) {
    const resultados = document.getElementById("agpResultados");
    resultados.innerHTML = lista.length
      ? lista.map((r) =>
          '<div class="agp-item" data-codigo="' + r.codigo + '" data-producto="' + esc(r.producto) +
          '" data-presentacion="' + esc(r.presentacion) + '">' +
            (r.producto || "(sin nombre)") + '<br><span class="c-codigo">Código ' + r.codigo + (r.presentacion ? " · " + r.presentacion : "") + '</span>' +
          '</div>'
        ).join("")
      : '<p style="color:var(--ink-soft); font-size:0.85rem;">Sin resultados. Puedes crear el producto abajo.</p>';
  }

  let agpCatalogoCompleto = [];
  async function cargarCatalogoParaModal() {
    try {
      agpCatalogoCompleto = await (await api("/api/catalogo/lista")).json();
      renderAgpResultados(agpCatalogoCompleto.slice(0, 200));
    } catch (err) {
      document.getElementById("agpResultados").innerHTML = '<p style="color:var(--ink-soft); font-size:0.85rem;">No se pudo cargar el catálogo.</p>';
    }
  }

  document.getElementById("btnAbrirAgregarProducto").addEventListener("click", agpAbrir);
  document.getElementById("btnCerrarAgregarProducto").addEventListener("click", agpCerrar);
  document.getElementById("agregarProductoOverlay").addEventListener("click", (e) => {
    if (e.target.id === "agregarProductoOverlay") agpCerrar();
  });

  let agpDebounce = null;
  document.getElementById("agpBuscar").addEventListener("input", (e) => {
    const q = norm(e.target.value.trim());
    clearTimeout(agpDebounce);
    agpDebounce = setTimeout(() => {
      const filtrados = q
        ? agpCatalogoCompleto.filter((r) => norm(r.codigo).includes(q) || norm(r.producto).includes(q) || norm(r.presentacion).includes(q))
        : agpCatalogoCompleto.slice(0, 200);
      renderAgpResultados(filtrados);
    }, 120);
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

  async function agpAbrirPasoTipo() {
    document.getElementById("agpProductoElegidoNombre").textContent = agpProductoElegido.producto + " (" + agpProductoElegido.codigo + ")";
    document.getElementById("agpEditPresentacion").value = agpProductoElegido.presentacion || "";
    document.getElementById("agpEditPrecio").value = "";
    document.getElementById("agpRefMinimo").value = "Consultando…";
    document.getElementById("agpRefProveedor").value = "—";
    document.getElementById("agpEditContrapropuesta").value = "";
    agpMostrarPaso("tipo");

    try {
      const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
      const cicloParam = cicloSeleccionado ? "&ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
      const ref = await (await api("/api/producto-referencia?codigo=" + encodeURIComponent(agpProductoElegido.codigo) + cicloParam)).json();
      document.getElementById("agpRefMinimo").value = ref.precioMinimo !== null
        ? fmtMoney(ref.precioMinimo) + " (" + ref.nProveedores + " proveedor" + (ref.nProveedores === 1 ? "" : "es") + ")"
        : "Sin cotizaciones todavía";
      document.getElementById("agpRefProveedor").value = ref.proveedorMinimo || "—";
      document.getElementById("agpEditContrapropuesta").value = ref.contrapropuestaSugerida !== null ? ref.contrapropuestaSugerida : "";
    } catch (err) {
      document.getElementById("agpRefMinimo").value = "No se pudo consultar";
    }
  }

  document.getElementById("btnConfirmarAsociar").addEventListener("click", async () => {
    if (!agpProductoElegido) return;
    const proveedor = document.getElementById("porProveedorSelect").value;
    const tipo = document.querySelector('input[name="agpTipo"]:checked').value;
    const frecuencia = document.querySelector('input[name="agpFrecuencia"]:checked').value;
    const presentacion = document.getElementById("agpEditPresentacion").value.trim();
    const precio = document.getElementById("agpEditPrecio").value;
    const contrapropuesta = document.getElementById("agpEditContrapropuesta").value;
    try {
      await api("/api/proveedor-productos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proveedor, codigo: agpProductoElegido.codigo, tipo, frecuencia, presentacion, precio, contrapropuesta }),
      });
      toast(agpProductoElegido.producto + " guardado para " + proveedor + ".");
      agpCerrar();
      await renderPorProveedor(proveedor);
    } catch (err) {
      toast("No se pudo guardar: " + err.message);
    }
  });

  // ---------- onboarding completo (producto + tipo + frecuencia + credenciales) ----------
  document.getElementById("btnDescargarPlantillaOnboarding").addEventListener("click", () => {
    window.location.href = "/api/onboarding/plantilla";
  });
  document.getElementById("btnSubirOnboarding").addEventListener("click", () => {
    document.getElementById("inputOnboarding").click();
  });
  document.getElementById("inputOnboarding").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append("archivo", file);
    try {
      const res = await fetch("/api/onboarding/importar", { method: "POST", body: form });
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Error de servidor");
      }
      const actualizados = res.headers.get("X-Productos-Actualizados") || "?";
      const omitidos = res.headers.get("X-Omitidos") || "0";
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Credenciales_Proveedores.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast("Importación terminada: " + actualizados + " relaciones proveedor-PLU actualizadas" + (omitidos !== "0" ? " · " + omitidos + " filas omitidas" : "") + ".");
      await loadProveedoresTabla();
    } catch (err) {
      toast("No se pudo procesar: " + err.message);
    } finally {
      e.target.value = "";
    }
  });


  // ---------- Base PLU por proveedor ----------
  document.getElementById("btnDescargarPLU").addEventListener("click", () => {
    window.location.href = "/api/onboarding/plantilla";
  });

  document.getElementById("btnSubirPLU").addEventListener("click", () => {
    document.getElementById("inputPLU").click();
  });

  document.getElementById("inputPLU").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const form = new FormData();
    form.append("archivo", file);

    try {
      toast("Procesando base PLU por proveedor...");

      const res = await api("/api/onboarding/importar", {
        method: "POST",
        body: form
      });

      const actualizados = res.headers.get("X-Productos-Actualizados") || "0";
      const omitidos = res.headers.get("X-Omitidos") || "0";

      const blob = await res.blob();

      // El backend devuelve también credenciales de proveedores nuevos
      if (blob && blob.size > 0) {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "Credenciales_Proveedores.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      }

      toast(
        "Importación terminada: " +
        actualizados +
        " relaciones proveedor-PLU actualizadas" +
        (omitidos !== "0" ? " · " + omitidos + " filas omitidas" : "") +
        "."
      );

      await loadProveedoresTabla();

    } catch (err) {
      toast("No se pudo importar: " + err.message);
    } finally {
      e.target.value = "";
    }
  });


  // ---------- sincronizar credenciales de proveedores ----------
  document.getElementById("btnImportarCredencialesProveedores").addEventListener("click", () => {
    document.getElementById("inputCredencialesProveedores").click();
  });

  document.getElementById("inputCredencialesProveedores").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm(
      "¿Sincronizar las contraseñas del archivo con las cuentas de proveedores? " +
      "Las contraseñas actuales serán reemplazadas."
    )) {
      e.target.value = "";
      return;
    }

    const form = new FormData();
    form.append("archivo", file);

    try {
      toast("Validando credenciales...");

      const res = await api("/api/usuarios-proveedores/importar-credenciales", {
        method: "POST",
        body: form
      });

      const data = await res.json();

      toast(
        "Credenciales sincronizadas: " +
        data.actualizados +
        " proveedores actualizados."
      );

      alert(
        "Sincronización terminada.\n\n" +
        "Filas procesadas: " + data.filas + "\n" +
        "Contraseñas actualizadas: " + data.actualizados
      );

    } catch (err) {
      toast("No se pudieron sincronizar las credenciales: " + err.message);
    } finally {
      e.target.value = "";
    }
  });

  // ---------- plantilla de frecuencias (diario/semanal) ----------
  document.getElementById("btnDescargarPlantillaFrecuencias").addEventListener("click", () => {
    window.location.href = "/api/frecuencias/plantilla";
  });
  document.getElementById("btnSubirPlantillaFrecuencias").addEventListener("click", () => {
    document.getElementById("inputPlantillaFrecuencias").click();
  });
  document.getElementById("inputPlantillaFrecuencias").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append("archivo", file);
    try {
      const res = await api("/api/frecuencias/importar", { method: "POST", body: form });
      const data = await res.json();
      toast("Frecuencias actualizadas: " + data.actualizados + (data.omitidos ? " (omitidas " + data.omitidos + " filas incompletas)" : ""));
      await loadProveedoresTabla();
    } catch (err) {
      toast("No se pudo importar: " + err.message);
    } finally {
      e.target.value = "";
    }
  });


  // ---------- logo corporativo Mercaldas ----------

  async function cargarLogoCorporativo() {

    try {

      const res =
        await api("/api/configuracion/logo");

      const data =
        await res.json();

      const img =
        document.getElementById(
          "logoCorporativoPreview"
        );

      if (data.logo) {

        img.src =
          data.logo + "?v=" + Date.now();

        img.style.display =
          "block";

      } else {

        img.style.display =
          "none";

      }

    } catch (e) {}

  }


  document
    .getElementById(
      "btnSubirLogoCorporativo"
    )
    .addEventListener(
      "click",
      () => {

        document
          .getElementById(
            "inputLogoCorporativo"
          )
          .click();

      }
    );


  document
    .getElementById(
      "inputLogoCorporativo"
    )
    .addEventListener(
      "change",
      async e => {

        const file =
          e.target.files[0];

        if (!file) return;

        const form =
          new FormData();

        form.append(
          "logo",
          file
        );

        try {

          toast(
            "Subiendo logo corporativo..."
          );

          const res =
            await api(
              "/api/configuracion/logo",
              {
                method:"POST",
                body:form
              }
            );

          const data =
            await res.json();

          const img =
            document.getElementById(
              "logoCorporativoPreview"
            );

          img.src =
            data.logo +
            "?v=" +
            Date.now();

          img.style.display =
            "block";

          toast(
            "Logo corporativo actualizado."
          );

        } catch (err) {

          toast(
            "No se pudo subir el logo: " +
            err.message
          );

        } finally {

          e.target.value = "";

        }

      }
    );


  // ---------- pestaña "Configuración" → Proveedores ----------
  let proveedoresCompleto = [];
  let provModoEdicion = null; // null = crear, o el nombre actual que se está editando

  async function loadProveedoresTabla() {
    proveedoresCompleto = await (await api("/api/proveedores/lista")).json();
    renderProveedoresTabla();
  }

  function renderProveedoresTabla() {
    const tbody = document.getElementById("proveedoresTableBody");
    tbody.innerHTML = proveedoresCompleto.length ? proveedoresCompleto.map((p) =>
      "<tr>" +
        "<td>" + p.nombre + "</td>" +
        '<td style="display:flex; gap:6px;">' +
          '<button class="btn-ghost" type="button" style="color:var(--brand);" data-editar-proveedor="' + esc(p.nombre) + '">Editar</button>' +
          '<button class="btn-ghost" type="button" data-eliminar-proveedor="' + esc(p.nombre) + '">Eliminar</button>' +
        "</td>" +
      "</tr>"
    ).join("") : '<tr><td colspan="2" style="text-align:center;padding:20px;color:var(--ink-soft)">Sin proveedores registrados todavía.</td></tr>';
  }

  document.getElementById("btnNuevoProveedor").addEventListener("click", () => {
    provModoEdicion = null;
    document.getElementById("proveedorModalTitulo").textContent = "Nuevo proveedor";
    document.getElementById("provModalNombre").value = "";
    document.getElementById("proveedorModalOverlay").style.display = "flex";
  });

  function cerrarProveedorModal() {
    document.getElementById("proveedorModalOverlay").style.display = "none";
  }
  document.getElementById("btnCerrarProveedorModal").addEventListener("click", cerrarProveedorModal);
  document.getElementById("btnCancelarProveedorModal").addEventListener("click", cerrarProveedorModal);
  document.getElementById("proveedorModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "proveedorModalOverlay") cerrarProveedorModal();
  });

  document.getElementById("proveedoresTableBody").addEventListener("click", async (e) => {
    const btnEditar = e.target.closest("[data-editar-proveedor]");
    if (btnEditar) {
      provModoEdicion = btnEditar.dataset.editarProveedor;
      document.getElementById("proveedorModalTitulo").textContent = "Editar proveedor";
      document.getElementById("provModalNombre").value = provModoEdicion;
      document.getElementById("proveedorModalOverlay").style.display = "flex";
      return;
    }
    const btnEliminar = e.target.closest("[data-eliminar-proveedor]");
    if (btnEliminar) {
      const nombre = btnEliminar.dataset.eliminarProveedor;
      if (!confirm('¿Eliminar al proveedor "' + nombre + '" de la lista? Sus cotizaciones históricas NO se borran, solo deja de aparecer para nuevas gestiones.')) return;
      try {
        await api("/api/proveedores/" + encodeURIComponent(nombre), { method: "DELETE" });
        toast("Proveedor eliminado de la lista.");
        await loadProveedoresTabla();
      } catch (err) {
        toast("No se pudo eliminar: " + err.message);
      }
    }
  });

  document.getElementById("btnGuardarProveedorModal").addEventListener("click", async () => {
    const nombre = document.getElementById("provModalNombre").value.trim();
    if (!nombre) { toast("Escribe el nombre del proveedor."); return; }
    try {
      if (provModoEdicion) {
        await api("/api/proveedores/" + encodeURIComponent(provModoEdicion), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nuevoNombre: nombre }),
        });
        toast("Proveedor actualizado.");
      } else {
        await api("/api/proveedores", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nombre }),
        });
        toast("Proveedor creado.");
      }
      cerrarProveedorModal();
      await loadProveedoresTabla();
    } catch (err) {
      toast("No se pudo guardar: " + err.message);
    }
  });

  // ---------- pestaña "Catálogo" ----------
  let catalogoCompleto = [];
  let catModoEdicion = null; // null = crear, o el código que se está editando

  async function loadCatalogoTabla() {
    catalogoCompleto = await (await api("/api/catalogo/lista")).json();
    renderCatalogoTabla(document.getElementById("catalogoFiltro").value);
  }

  function renderCatalogoTabla(filtro) {
    const f = norm(filtro || "");
    const filtrados = f
      ? catalogoCompleto.filter((p) => norm(p.codigo).includes(f) || norm(p.producto).includes(f) || norm(p.presentacion).includes(f))
      : catalogoCompleto;
    const tbody = document.getElementById("catalogoTableBody");
    tbody.innerHTML = filtrados.length ? filtrados.map((p) =>
      "<tr>" +
        "<td>" + p.codigo + "</td>" +
        "<td>" + (p.producto || "—") + "</td>" +
        "<td>" + (p.presentacion || "—") + "</td>" +
        '<td style="display:flex; gap:6px;">' +
          '<button class="btn-ghost" type="button" style="color:var(--brand);" data-editar-codigo="' + esc(p.codigo) + '">Editar</button>' +
          '<button class="btn-ghost" type="button" data-eliminar-codigo="' + esc(p.codigo) + '">Eliminar</button>' +
        '</td>' +
      "</tr>"
    ).join("") : '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--ink-soft)">Sin productos que coincidan.</td></tr>';
  }

  document.getElementById("catalogoFiltro").addEventListener("input", (e) => renderCatalogoTabla(e.target.value));

  document.getElementById("catalogoTableBody").addEventListener("click", async (e) => {
    const btnEditar = e.target.closest("[data-editar-codigo]");
    if (btnEditar) {
      const p = catalogoCompleto.find((x) => x.codigo === btnEditar.dataset.editarCodigo);
      if (!p) return;
      catModoEdicion = p.codigo;
      document.getElementById("catalogoModalTitulo").textContent = "Editar producto";
      document.getElementById("catModalCodigo").value = p.codigo;
      document.getElementById("catModalCodigo").disabled = true;
      document.getElementById("catModalNombre").value = p.producto || "";
      document.getElementById("catModalPresentacion").value = p.presentacion || "";
      document.getElementById("catalogoModalOverlay").style.display = "flex";
      return;
    }
    const btnEliminar = e.target.closest("[data-eliminar-codigo]");
    if (btnEliminar) {
      const cod = btnEliminar.dataset.eliminarCodigo;
      const p = catalogoCompleto.find((x) => x.codigo === cod);
      if (!confirm("¿Eliminar \"" + (p ? p.producto : cod) + "\" del catálogo? Las cotizaciones ya guardadas no se ven afectadas.")) return;
      try {
        await api("/api/catalogo/" + encodeURIComponent(cod), { method: "DELETE" });
        toast("Producto eliminado del catálogo.");
        await loadCatalogoTabla();
      } catch (err) {
        toast("No se pudo eliminar: " + err.message);
      }
    }
  });

  document.getElementById("btnNuevoProducto").addEventListener("click", () => {
    catModoEdicion = null;
    document.getElementById("catalogoModalTitulo").textContent = "Nuevo producto";
    document.getElementById("catModalCodigo").value = "";
    document.getElementById("catModalCodigo").disabled = false;
    document.getElementById("catModalNombre").value = "";
    document.getElementById("catModalPresentacion").value = "";
    document.getElementById("catalogoModalOverlay").style.display = "flex";
  });

  function cerrarCatalogoModal() {
    document.getElementById("catalogoModalOverlay").style.display = "none";
  }
  document.getElementById("btnCerrarCatalogoModal").addEventListener("click", cerrarCatalogoModal);
  document.getElementById("btnCancelarCatalogoModal").addEventListener("click", cerrarCatalogoModal);
  document.getElementById("catalogoModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "catalogoModalOverlay") cerrarCatalogoModal();
  });

  document.getElementById("btnGuardarCatalogoModal").addEventListener("click", async () => {
    const codigo = document.getElementById("catModalCodigo").value.trim();
    const producto = document.getElementById("catModalNombre").value.trim();
    const presentacion = document.getElementById("catModalPresentacion").value.trim();
    if (!codigo || !producto) { toast("Escribe al menos el código y el nombre del producto."); return; }
    try {
      if (catModoEdicion) {
        await api("/api/catalogo/" + encodeURIComponent(catModoEdicion), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ producto, presentacion }),
        });
        toast("Producto actualizado.");
      } else {
        await api("/api/catalogo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codigo, producto, presentacion }),
        });
        toast("Producto creado.");
      }
      cerrarCatalogoModal();
      await loadCatalogoTabla();
    } catch (err) {
      toast("No se pudo guardar: " + err.message);
    }
  });



  // ============================================================
  // PEDIDOS
  // ============================================================

  let pedidosData = null;


  async function cargarCiclosPedidos() {

    const select =
      document.getElementById("pedidoCicloSelect");

    if (!select) return;

    try {

      const ciclos =
        await (await api("/api/ciclos")).json();

      const actualAnterior =
        select.value;

      select.innerHTML =
        ciclos.map(c =>
          '<option value="' +
          esc(c.id) +
          '">' +
          esc(c.id) +
          " (" +
          esc(c.estado || "") +
          ")</option>"
        ).join("");


      let cicloActual = null;

      try {
        cicloActual =
          await (
            await api("/api/ciclos/actual")
          ).json();
      } catch (e) {}


      if (
        actualAnterior &&
        ciclos.some(c => c.id === actualAnterior)
      ) {
        select.value =
          actualAnterior;

      } else if (
        cicloActual &&
        cicloActual.id &&
        ciclos.some(c => c.id === cicloActual.id)
      ) {
        select.value =
          cicloActual.id;
      }

    } catch (err) {

      toast(
        "No se pudieron cargar los ciclos: " +
        err.message
      );
    }
  }


  function estadoPedidoBadge(estado) {

    if (estado === "COMPLETO") {
      return '<span class="count">COMPLETO</span>';
    }

    if (estado === "EXCEDIDO") {
      return '<span style="font-weight:700;color:var(--warn);">⚠ EXCEDIDO</span>';
    }

    return '<span style="font-weight:600;">PENDIENTE</span>';
  }


  function renderTablaPedidos(filtro) {

    const tbody =
      document.getElementById("pedidoTableBody");

    if (!tbody) return;

    if (
      !pedidosData ||
      !pedidosData.items ||
      !pedidosData.items.length
    ) {

      tbody.innerHTML =
        '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--ink-soft);">' +
        "No hay pedido cargado para este ciclo." +
        "</td></tr>";

      return;
    }


    const q =
      String(filtro || "")
        .trim()
        .toUpperCase();


    const items =
      pedidosData.items.filter(it => {

        if (!q) return true;

        return (
          String(it.codigo || "")
            .toUpperCase()
            .includes(q) ||
          String(it.producto || "")
            .toUpperCase()
            .includes(q)
        );
      });


    tbody.innerHTML =
      items.map(it => {

        const proveedores =
          Array.isArray(it.proveedores_cotizados)
            ? it.proveedores_cotizados.length
            : 0;

        return (
          "<tr>" +

          "<td>" +
          esc(it.codigo) +
          "</td>" +

          "<td>" +
          esc(it.producto) +
          "</td>" +

          "<td><strong>" +
          Number(it.cantidad_requerida || 0) +
          " kg</strong></td>" +

          "<td>" +
          Number(it.cantidad_asignada || 0) +
          " kg</td>" +

          "<td>" +
          Number(it.pendiente || 0) +
          " kg</td>" +

          '<td style="' +
          (Number(it.exceso || 0) > 0
            ? "font-weight:700;color:var(--warn);"
            : "") +
          '">' +
          Number(it.exceso || 0) +
          " kg</td>" +

          "<td>" +
          proveedores +
          "</td>" +

          "<td>" +
          estadoPedidoBadge(it.estado) +
          "</td>" +

          '<td><button class="btn-secondary btn-distribuir-pedido" data-detalle-id="' +
          Number(it.demanda_detalle_id) +
          '">Distribuir</button></td>' +

          "</tr>"
        );
      }).join("");
  }






  let pedidoDistribucionActual = null;


  function actualizarResumenDistribucion() {

    if (!pedidoDistribucionActual) {
      toast("No se encontró el producto que estás distribuyendo. Cierra y vuelve a abrir Distribuir.");
      return;
    }


    const requerido =
      Number(
        pedidoDistribucionActual
          .detalle
          .cantidad_requerida || 0
      );


    const inputs =
      Array.from(
        document.querySelectorAll(
          ".pedido-distribucion-kg"
        )
      );


    const asignado =
      inputs.reduce(
        (acc, input) =>
          acc +
          Number(input.value || 0),
        0
      );


    const pendiente =
      Math.max(
        0,
        requerido - asignado
      );


    const exceso =
      Math.max(
        0,
        asignado - requerido
      );


    const resumen =
      document.getElementById(
        "pedidoDistribucionResumen"
      );


    resumen.innerHTML =
      "Requerido: <strong>" +
      requerido +
      " kg</strong> · " +
      "Asignado: <strong>" +
      asignado +
      " kg</strong> · " +
      "Pendiente: <strong>" +
      pendiente +
      " kg</strong>";


    const alerta =
      document.getElementById(
        "pedidoDistribucionAlerta"
      );


    if (exceso > 0) {

      alerta.style.display =
        "block";

      alerta.textContent =
        "⚠ Pedido excedido en " +
        exceso +
        " kg. Reduce las cantidades antes de guardar.";

    } else {

      alerta.style.display =
        "none";

      alerta.textContent =
        "";
    }


    const btn =
      document.getElementById(
        "btnGuardarDistribucion"
      );

    if (btn) {
      btn.disabled = false;

      btn.dataset.exceso =
        String(exceso);
    }
  }


  async function abrirDistribucionPedido(
    detalleId
  ) {

    try {

      const res =
        await api(
          "/api/pedidos/distribucion/" +
          encodeURIComponent(detalleId)
        );


      const data =
        await res.json();


      pedidoDistribucionActual =
        data;


      document
        .getElementById(
          "pedidoDistribucionTitulo"
        )
        .textContent =
          data.detalle.codigo +
          " · " +
          data.detalle.producto;


      const body =
        document.getElementById(
          "pedidoDistribucionBody"
        );


      if (
        !data.proveedores ||
        !data.proveedores.length
      ) {

        body.innerHTML =
          '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--ink-soft);">' +
          "Ningún proveedor cotizó este producto en el ciclo." +
          "</td></tr>";

      } else {

        body.innerHTML =
          data.proveedores.map(p => {

            const oferta =
              p.precio_ofertado !== null &&
              p.precio_ofertado !== undefined
                ? fmtMoney(
                    p.precio_ofertado
                  )
                : "—";


            const contra =
              p.contrapropuesta !== null &&
              p.contrapropuesta !== undefined
                ? fmtMoney(
                    p.contrapropuesta
                  )
                : "—";


            return (
              "<tr>" +

              "<td><strong>" +
              esc(p.proveedor) +
              "</strong>" +
              (
                p.cotizo
                  ? '<div class="cell-sub">Cotizó esta semana</div>'
                  : '<div class="cell-sub" style="font-weight:700;">NO COTIZÓ</div>'
              ) +
              "</td>" +

              "<td>" +
              oferta +
              "</td>" +

              "<td>" +
              contra +
              "</td>" +

              '<td><input ' +
              'type="number" ' +
              'min="0" ' +
              'step="0.01" ' +
              'class="manual-input pedido-distribucion-kg" ' +
              'data-proveedor="' +
              esc(p.proveedor) +
              '" ' +
              'value="' +
              Number(
                p.cantidad_asignada || 0
              ) +
              '" ' +
              'style="width:120px;"> kg</td>' +

              "</tr>"
            );

          }).join("");
      }


      document
        .getElementById(
          "pedidoDistribucionOverlay"
        )
        .style.display =
          "flex";


      document
        .querySelectorAll(
          ".pedido-distribucion-kg"
        )
        .forEach(input => {

          input.addEventListener(
            "input",
            actualizarResumenDistribucion
          );
        });


      actualizarResumenDistribucion();


    } catch (err) {

      toast(
        "No se pudo abrir la distribución: " +
        err.message
      );
    }
  }


  function cerrarDistribucionPedido() {

    document
      .getElementById(
        "pedidoDistribucionOverlay"
      )
      .style.display =
        "none";

    pedidoDistribucionActual =
      null;
  }


  async function guardarDistribucionPedido() {

    if (!pedidoDistribucionActual) {
      return;
    }


    const inputs =
      Array.from(
        document.querySelectorAll(
          ".pedido-distribucion-kg"
        )
      );


    const asignaciones =
      inputs.map(input => ({

        proveedor:
          input.dataset.proveedor,

        cantidad:
          Number(
            input.value || 0
          )

      }));


    const requerido =
      Number(
        pedidoDistribucionActual
          .detalle
          .cantidad_requerida || 0
      );

    const totalAsignado =
      asignaciones.reduce(
        (acc, a) =>
          acc + Number(a.cantidad || 0),
        0
      );

    if (totalAsignado > requerido) {

      const exceso =
        totalAsignado - requerido;

      toast(
        "No se puede guardar. El pedido está excedido en " +
        exceso +
        " kg."
      );

      return;
    }


    try {

      toast("Guardando distribución...");

      const res =
        await api(
          "/api/pedidos/distribucion",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({

                demanda_detalle_id:
                  pedidoDistribucionActual
                    .detalle
                    .id,

                asignaciones

              })
          }
        );


      const data =
        await res.json();


      toast(
        data.estado === "COMPLETO"
          ? "Pedido completo."
          : "Distribución guardada. Faltan " +
            data.pendiente +
            " kg."
      );


      // Cerrar siempre la ventana después de guardar correctamente
      cerrarDistribucionPedido();

      const overlay =
        document.getElementById(
          "pedidoDistribucionOverlay"
        );

      if (overlay) {
        overlay.style.display = "none";
      }

      pedidoDistribucionActual = null;

      await renderPedidos();


    } catch (err) {

      toast(
        err.message
      );
    }
  }


  async function cargarProveedoresPedidos() {

    const select =
      document.getElementById(
        "pedidoProveedorSelect"
      );

    if (!select) return;

    try {

      const proveedores =
        await (
          await api("/api/proveedores")
        ).json();

      const actual =
        select.value;

      select.innerHTML =
        '<option value="">Selecciona un proveedor…</option>' +
        proveedores.map(p => {

          const nombre =
            typeof p === "string"
              ? p
              : (p.nombre || p.proveedor || "");

          return (
            '<option value="' +
            esc(nombre) +
            '">' +
            esc(nombre) +
            "</option>"
          );

        }).join("");


      if (
        actual &&
        Array.from(select.options)
          .some(o => o.value === actual)
      ) {
        select.value = actual;
      }

    } catch (err) {

      toast(
        "No se pudieron cargar los proveedores."
      );
    }
  }


  async function verPedidoProveedor() {

    const proveedor =
      document.getElementById(
        "pedidoProveedorSelect"
      ).value;

    const ciclo =
      document.getElementById(
        "pedidoCicloSelect"
      ).value;

    const periodo =
      document.getElementById(
        "pedidoPeriodoSelect"
      ).value || "LUNES-MARTES";


    if (!proveedor) {

      toast(
        "Selecciona un proveedor."
      );

      return;
    }


    if (!ciclo) {

      toast(
        "Selecciona el ciclo."
      );

      return;
    }


    try {

      const url =
        "/api/pedidos/proveedor" +
        "?ciclo=" +
        encodeURIComponent(ciclo) +
        "&periodo=" +
        encodeURIComponent(periodo) +
        "&proveedor=" +
        encodeURIComponent(proveedor);


      const res =
        await api(url);

      const data =
        await res.json();


      const contenedor =
        document.getElementById(
          "pedidoProveedorTablaContenedor"
        );

      const body =
        document.getElementById(
          "pedidoProveedorBody"
        );

      const resumen =
        document.getElementById(
          "pedidoProveedorResumen"
        );


      if (
        !data.items ||
        !data.items.length
      ) {

        contenedor.style.display =
          "none";

        resumen.textContent =
          "Este proveedor no tiene productos relacionados con el pedido.";

        return;
      }


      resumen.innerHTML =
        "<strong>" +
        esc(proveedor) +
        "</strong> · " +
        data.productos +
        " productos · " +
        Number(
          data.total_pedido_kg || 0
        ) +
        " kg asignados";


      body.innerHTML =
        data.items.map(it => {

          const oferta =
            it.precio_ofertado !== null &&
            it.precio_ofertado !== undefined
              ? fmtMoney(
                  it.precio_ofertado
                )
              : "—";


          const contra =
            it.contrapropuesta !== null &&
            it.contrapropuesta !== undefined
              ? fmtMoney(
                  it.contrapropuesta
                )
              : "—";


          return (
            "<tr>" +

            "<td>" +
            esc(it.codigo) +
            "</td>" +

            "<td>" +
            esc(it.producto) +
            "</td>" +

            "<td>" +
            esc(it.presentacion || "") +
            "</td>" +

            "<td>" +
            oferta +
            "</td>" +

            "<td><strong>" +
            contra +
            "</strong></td>" +

            "<td>" +
            Number(
              it.cantidad_requerida || 0
            ).toFixed(2) +
            " kg</td>" +

            "<td><strong>" +
            Number(
              it.porcentaje_distribucion || 0
            ).toFixed(2) +
            "%</strong></td>" +

            "<td><strong>" +
            Number(
              it.pedido_kg || 0
            ).toFixed(2) +
            " kg</strong></td>" +

            "</tr>"
          );

        }).join("");


      contenedor.style.display =
        "block";


    } catch (err) {

      toast(
        "No se pudo consultar el pedido: " +
        err.message
      );
    }
  }


  async function descargarPedidoProveedor() {

    const proveedor =
      document.getElementById(
        "pedidoProveedorSelect"
      ).value;

    const ciclo =
      document.getElementById(
        "pedidoCicloSelect"
      ).value;

    const periodo =
      document.getElementById(
        "pedidoPeriodoSelect"
      ).value || "LUNES-MARTES";


    if (!proveedor) {
      toast("Selecciona un proveedor.");
      return;
    }

    if (!ciclo) {
      toast("Selecciona el ciclo.");
      return;
    }


    const url =
      "/api/pedidos/proveedor/excel" +
      "?ciclo=" +
      encodeURIComponent(ciclo) +
      "&periodo=" +
      encodeURIComponent(periodo) +
      "&proveedor=" +
      encodeURIComponent(proveedor);


    try {

      toast("Generando Excel del proveedor...");

      const res =
        await api(url);

      const blob =
        await res.blob();


      let nombre =
        "PEDIDO_" +
        proveedor.replace(
          /[^a-zA-Z0-9_-]+/g,
          "_"
        ) +
        ".xlsx";


      const disposition =
        res.headers.get(
          "Content-Disposition"
        );

      if (disposition) {

        const match =
          disposition.match(
            /filename="?([^"]+)"?/i
          );

        if (match && match[1]) {
          nombre = match[1];
        }
      }


      const href =
        URL.createObjectURL(blob);

      const a =
        document.createElement("a");

      a.href = href;
      a.download = nombre;

      document.body.appendChild(a);
      a.click();
      a.remove();

      URL.revokeObjectURL(href);

      toast(
        "Excel generado para " +
        proveedor +
        "."
      );


    } catch (err) {

      toast(
        "No se pudo descargar el pedido: " +
        err.message
      );
    }
  }


  async function renderPedidos() {

    await cargarCiclosPedidos();
    await cargarProveedoresPedidos();

    const cicloSelect =
      document.getElementById("pedidoCicloSelect");

    if (!cicloSelect) return;

    const ciclo =
      cicloSelect.value;

    const periodo =
      document.getElementById(
        "pedidoPeriodoSelect"
      ).value || "LUNES-MARTES";


    if (!ciclo) {

      pedidosData = null;
      renderTablaPedidos();

      return;
    }


    try {

      const url =
        "/api/pedidos-demanda?ciclo=" +
        encodeURIComponent(ciclo) +
        "&periodo=" +
        encodeURIComponent(periodo);


      pedidosData =
        await (await api(url)).json();


      const resumen =
        pedidosData.resumen || {
          productos: 0,
          completos: 0,
          pendientes: 0,
          excedidos: 0
        };


      document
        .getElementById(
          "pedidoResumenCard"
        )
        .style.display =
          pedidosData.demanda
            ? "block"
            : "none";


      document
        .getElementById(
          "pedidoResumenProductos"
        )
        .textContent =
          resumen.productos || 0;


      document
        .getElementById(
          "pedidoResumenCompletos"
        )
        .textContent =
          resumen.completos || 0;


      document
        .getElementById(
          "pedidoResumenPendientes"
        )
        .textContent =
          resumen.pendientes || 0;


      document
        .getElementById(
          "pedidoResumenExcedidos"
        )
        .textContent =
          resumen.excedidos || 0;


      document
        .getElementById(
          "pedidoArchivoActual"
        )
        .textContent =
          pedidosData.demanda
            ? "Archivo cargado: " +
              (
                pedidosData.demanda
                  .archivo_nombre || "—"
              )
            : "Sin archivo cargado.";


      renderTablaPedidos(
        document
          .getElementById(
            "pedidoBuscar"
          ).value
      );


    } catch (err) {

      toast(
        "No se pudo cargar Pedidos: " +
        err.message
      );
    }
  }


  async function importarPedidoDemanda() {

    const input =
      document.getElementById(
        "pedidoArchivoInput"
      );

    if (
      !input ||
      !input.files ||
      !input.files.length
    ) {

      toast(
        "Selecciona el archivo Excel del pedido."
      );

      return;
    }


    const ciclo =
      document.getElementById(
        "pedidoCicloSelect"
      ).value;

    const periodo =
      document.getElementById(
        "pedidoPeriodoSelect"
      ).value ||
      "LUNES-MARTES";


    if (!ciclo) {

      toast(
        "Selecciona primero el ciclo."
      );

      return;
    }


    const form =
      new FormData();

    form.append(
      "archivo",
      input.files[0]
    );

    form.append(
      "ciclo_id",
      ciclo
    );

    form.append(
      "periodo",
      periodo
    );


    try {

      const res =
        await api(
          "/api/pedidos-demanda/importar",
          {
            method: "POST",
            body: form
          }
        );

      const data =
        await res.json();


      toast(
        "Pedido cargado: " +
        data.productos +
        " productos."
      );


      input.value = "";

      await renderPedidos();


    } catch (err) {

      toast(
        "No se pudo importar el pedido: " +
        err.message
      );
    }
  }


  // ---------- eventos ----------
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      ["cargar", "comparativo", "alertas", "por-proveedor", "pedidos", "ordenes-compra", "hoja-negociacion", "configuracion"].forEach((t) => {
        document.getElementById("tab-" + t).style.display = t === btn.dataset.tab ? "block" : "none";
      });
      if (btn.dataset.tab === "alertas") await renderAlertas();
      if (btn.dataset.tab === "por-proveedor") await loadProveedoresSelect();
      if (btn.dataset.tab === "pedidos") await renderPedidos();
      if (btn.dataset.tab === "configuracion") { await cargarLogoCorporativo(); await loadProveedoresTabla(); await loadCatalogoTabla(); await loadCiclosTabla(); }
      if (btn.dataset.tab === "ordenes-compra") await renderOrdenesCompra();
      if (btn.dataset.tab === "hoja-negociacion") await renderHojaNegociacion();
    });
  });

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => { uploadFiles(e.target.files); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });







  document
    .getElementById(
      "pedidoTableBody"
    )
    .addEventListener(
      "click",
      e => {

        const btn =
          e.target.closest(
            ".btn-distribuir-pedido"
          );

        if (!btn) return;

        abrirDistribucionPedido(
          btn.dataset.detalleId
        );
      }
    );


  const btnCerrarDistribucion =
    document.getElementById(
      "btnCerrarDistribucion"
    );

  if (btnCerrarDistribucion) {

    btnCerrarDistribucion.addEventListener(
      "click",
      cerrarDistribucionPedido
    );
  }


  // Guardar distribución se maneja por delegación global
  // para evitar problemas si el modal cambia o se vuelve a renderizar.



  document.addEventListener(
    "click",
    async (e) => {

      const btn =
        e.target.closest(
          "#btnGuardarDistribucion"
        );

      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      await guardarDistribucionPedido();
    }
  );


  const btnVerPedidoProveedor =
    document.getElementById(
      "btnVerPedidoProveedor"
    );

  if (btnVerPedidoProveedor) {

    btnVerPedidoProveedor.addEventListener(
      "click",
      verPedidoProveedor
    );
  }


  const btnDescargarPedidoProveedor =
    document.getElementById(
      "btnDescargarPedidoProveedor"
    );

  if (btnDescargarPedidoProveedor) {

    btnDescargarPedidoProveedor.addEventListener(
      "click",
      descargarPedidoProveedor
    );
  }


  const pedidoProveedorSelect =
    document.getElementById(
      "pedidoProveedorSelect"
    );

  if (pedidoProveedorSelect) {

    pedidoProveedorSelect.addEventListener(
      "change",
      () => {

        document.getElementById(
          "pedidoProveedorTablaContenedor"
        ).style.display = "none";

        document.getElementById(
          "pedidoProveedorResumen"
        ).textContent = "";
      }
    );
  }


  const btnImportarPedido =
    document.getElementById(
      "btnImportarPedido"
    );

  if (btnImportarPedido) {

    btnImportarPedido.addEventListener(
      "click",
      importarPedidoDemanda
    );
  }


  const pedidoCicloSelect =
    document.getElementById(
      "pedidoCicloSelect"
    );

  if (pedidoCicloSelect) {

    pedidoCicloSelect.addEventListener(
      "change",
      renderPedidos
    );
  }


  const pedidoPeriodoSelect =
    document.getElementById(
      "pedidoPeriodoSelect"
    );

  if (pedidoPeriodoSelect) {

    pedidoPeriodoSelect.addEventListener(
      "change",
      renderPedidos
    );
  }


  const pedidoBuscar =
    document.getElementById(
      "pedidoBuscar"
    );

  if (pedidoBuscar) {

    pedidoBuscar.addEventListener(
      "input",
      e =>
        renderTablaPedidos(
          e.target.value
        )
    );
  }


  document.getElementById("searchBox").addEventListener("input", (e) => renderComparativo(e.target.value));
  document.getElementById("btnExport").addEventListener("click", () => {
    const cicloSeleccionado = document.getElementById("cicloFiltroSelect").value;
    const qsCiclo = cicloSeleccionado ? "?ciclo=" + encodeURIComponent(cicloSeleccionado) : "";
    window.location.href = "/api/export" + qsCiclo;
  });
  document.getElementById("btnClear").addEventListener("click", async () => {
    if (!confirm("¿Borrar TODAS las cotizaciones guardadas en el servidor? Esta acción no se puede deshacer.")) return;
    await api("/api/reset", { method: "POST" });
    await renderAll();
    toast("Datos borrados.");
  });
  document.getElementById("btnLogout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  renderAll();
  loadSettings();


  // === RECORDAR ULTIMA SESION MERCALDAS ===

  const CLAVE_SESION_MERCALDAS = "mercaldas_ultima_sesion_v1";

  function leerUltimaSesion() {
    try {
      return JSON.parse(
        localStorage.getItem(CLAVE_SESION_MERCALDAS) || "{}"
      );
    } catch (e) {
      return {};
    }
  }

  function guardarUltimaSesion(cambios = {}) {
    try {
      const actual = leerUltimaSesion();

      localStorage.setItem(
        CLAVE_SESION_MERCALDAS,
        JSON.stringify({
          ...actual,
          ...cambios,
          actualizadoEn: new Date().toISOString()
        })
      );
    } catch (e) {}
  }


  // --------------------------------------------------
  // RECORDAR PESTAÑA
  // --------------------------------------------------

  document
    .querySelectorAll('nav.tabs button[data-tab]')
    .forEach((btn) => {

      btn.addEventListener("click", () => {

        guardarUltimaSesion({
          tab: btn.dataset.tab
        });

      });

    });


  // --------------------------------------------------
  // RECORDAR CICLO / SEMANA DEL FILTRO
  // --------------------------------------------------

  const cicloFiltroRecordar =
    document.getElementById("cicloFiltroSelect");

  if (cicloFiltroRecordar) {

    cicloFiltroRecordar.addEventListener(
      "change",
      () => {

        guardarUltimaSesion({
          ciclo:
            cicloFiltroRecordar.value || ""
        });

      }
    );

  }


  // --------------------------------------------------
  // RECORDAR AÑO Y SEMANA DE LA CABECERA
  // --------------------------------------------------

  const anioRecordar =
    document.getElementById("cicloAnioSelect");

  const semanaRecordar =
    document.getElementById("cicloSemanaSelect");

  if (anioRecordar) {

    anioRecordar.addEventListener(
      "change",
      () => {

        guardarUltimaSesion({
          anio: anioRecordar.value
        });

      }
    );

  }

  if (semanaRecordar) {

    semanaRecordar.addEventListener(
      "change",
      () => {

        guardarUltimaSesion({
          semana: semanaRecordar.value
        });

      }
    );

  }


  // --------------------------------------------------
  // RECORDAR PROVEEDOR
  // --------------------------------------------------

  const proveedorRecordar =
    document.getElementById("porProveedorSelect");

  if (proveedorRecordar) {

    proveedorRecordar.addEventListener(
      "change",
      () => {

        guardarUltimaSesion({
          proveedor:
            proveedorRecordar.value || ""
        });

      }
    );

  }


  // --------------------------------------------------
  // RESTAURAR ÚLTIMA SESIÓN
  // --------------------------------------------------

  async function restaurarUltimaSesionMercaldas() {

    const ultima =
      leerUltimaSesion();


    // Restaurar año
    if (
      ultima.anio &&
      anioRecordar &&
      Array.from(anioRecordar.options)
        .some(o => o.value === String(ultima.anio))
    ) {
      anioRecordar.value =
        String(ultima.anio);
    }


    // Restaurar semana
    if (
      ultima.semana &&
      semanaRecordar &&
      Array.from(semanaRecordar.options)
        .some(o => o.value === String(ultima.semana))
    ) {
      semanaRecordar.value =
        String(ultima.semana);
    }


    // Esperar a que se carguen los ciclos
    if (
      ultima.ciclo &&
      cicloFiltroRecordar
    ) {

      for (
        let intento = 0;
        intento < 40;
        intento++
      ) {

        const existe =
          Array
            .from(
              cicloFiltroRecordar.options
            )
            .some(
              o =>
                o.value === ultima.ciclo
            );

        if (existe) {

          cicloFiltroRecordar.value =
            ultima.ciclo;

          cicloFiltroRecordar.dispatchEvent(
            new Event("change", {
              bubbles: true
            })
          );

          break;
        }

        await new Promise(
          r => setTimeout(r, 100)
        );

      }

    }


    // Restaurar pestaña
    if (ultima.tab) {

      const btn =
        document.querySelector(
          'nav.tabs button[data-tab="' +
          ultima.tab +
          '"]'
        );

      if (btn) {

        btn.click();

        // Si estábamos en Por Proveedor,
        // restauramos también el proveedor.
        if (
          ultima.tab === "por-proveedor" &&
          ultima.proveedor
        ) {

          await new Promise(
            r => setTimeout(r, 600)
          );

          const select =
            document.getElementById(
              "porProveedorSelect"
            );

          if (
            select &&
            Array
              .from(select.options)
              .some(
                o =>
                  o.value ===
                  ultima.proveedor
              )
          ) {

            select.value =
              ultima.proveedor;

            select.dispatchEvent(
              new Event("change", {
                bubbles: true
              })
            );

          }

        }

      }

    }

  }


  // Esperamos a que la carga inicial de la app termine.
  setTimeout(
    restaurarUltimaSesionMercaldas,
    350
  );




  // ==========================================================
  // PEDIDOS - DISTRIBUCIÓN PORCENTUAL
  // ==========================================================

  function crearBloqueDistribucionPorcentual() {

    if (
      document.getElementById(
        "pedidoPctCard"
      )
    ) {
      return;
    }


    const tab =
      document.getElementById(
        "tab-pedidos"
      );

    if (!tab) {
      return;
    }


    const card =
      document.createElement(
        "div"
      );

    card.className =
      "card";

    card.id =
      "pedidoPctCard";

    card.style.marginTop =
      "16px";


    card.innerHTML = `
      <div style="
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        gap:15px;
        flex-wrap:wrap;
      ">

        <div>
          <p class="section-title" style="margin:0;">
            3. Distribución por proveedores
          </p>

          <div style="
            margin-top:5px;
            color:var(--ink-soft);
            font-size:.86rem;
          ">
            Carga los porcentajes de participación de cada proveedor
            por producto y conviértelos automáticamente en kilos.
          </div>
        </div>

        <div style="
          display:flex;
          gap:8px;
          flex-wrap:wrap;
        ">

          <button
            type="button"
            class="btn-secondary"
            id="btnPedidoPctPlantilla"
          >
            ⬇ Descargar plantilla %
          </button>

          <button
            type="button"
            class="btn-secondary"
            id="btnPedidoPctCargar"
          >
            ⬆ Cargar archivo %
          </button>

          <button
            type="button"
            class="btn-primary"
            id="btnPedidoPctAplicar"
          >
            Aplicar distribución
          </button>

          <input
            type="file"
            id="pedidoPctArchivo"
            accept=".xlsx,.xls"
            style="display:none;"
          >

        </div>
      </div>


      <div
        id="pedidoPctResumen"
        style="
          display:grid;
          grid-template-columns:repeat(4,minmax(120px,1fr));
          gap:10px;
          margin-top:18px;
        "
      >
        <div class="stat">
          <span>Productos</span>
          <strong id="pedidoPctProductos">0</strong>
        </div>

        <div class="stat">
          <span>Al 100%</span>
          <strong id="pedidoPctCompletos">0</strong>
        </div>

        <div class="stat">
          <span>Pendientes</span>
          <strong id="pedidoPctPendientes">0</strong>
        </div>

        <div class="stat">
          <span>Excedidos</span>
          <strong id="pedidoPctExcedidos">0</strong>
        </div>
      </div>


      <div
        id="pedidoPctMensaje"
        style="
          margin-top:14px;
          font-size:.85rem;
          color:var(--ink-soft);
        "
      >
        Aún no se ha cargado una distribución.
      </div>


      <div
        style="
          overflow:auto;
          margin-top:14px;
        "
      >
        <table>
          <thead>
            <tr>
              <th>PLU</th>
              <th>Producto</th>
              <th>Demanda KG</th>
              <th>% Distribuido</th>
              <th>KG calculados</th>
              <th>Estado</th>
            </tr>
          </thead>

          <tbody
            id="pedidoPctBody"
          ></tbody>
        </table>
      </div>
    `;


    const primerCard =
      tab.querySelector(
        ".card"
      );


    if (
      primerCard &&
      primerCard.nextSibling
    ) {

      primerCard.parentNode.insertBefore(
        card,
        primerCard.nextSibling
      );

    } else {

      tab.appendChild(
        card
      );
    }


    document.getElementById(
      "btnPedidoPctPlantilla"
    ).addEventListener(
      "click",
      descargarPlantillaPedidoPct
    );


    document.getElementById(
      "btnPedidoPctCargar"
    ).addEventListener(
      "click",
      () => {

        document.getElementById(
          "pedidoPctArchivo"
        ).click();
      }
    );


    document.getElementById(
      "pedidoPctArchivo"
    ).addEventListener(
      "change",
      importarPedidoPct
    );


    document.getElementById(
      "btnPedidoPctAplicar"
    ).addEventListener(
      "click",
      aplicarPedidoPct
    );
  }


  function datosSeleccionPedidoPct() {

    return {
      ciclo:
        document.getElementById(
          "pedidoCicloSelect"
        )?.value || "",

      periodo:
        document.getElementById(
          "pedidoPeriodoSelect"
        )?.value ||
        "LUNES-MARTES"
    };
  }


  function descargarPlantillaPedidoPct() {

    const {
      ciclo,
      periodo
    } =
      datosSeleccionPedidoPct();


    if (!ciclo) {

      toast(
        "Selecciona primero el ciclo."
      );

      return;
    }


    window.location.href =
      "/api/pedidos/distribucion-porcentajes/plantilla" +
      "?ciclo=" +
      encodeURIComponent(
        ciclo
      ) +
      "&periodo=" +
      encodeURIComponent(
        periodo
      );
  }


  function etiquetaEstadoPedidoPct(
    estado
  ) {

    if (
      estado === "completo"
    ) {
      return "✓ 100%";
    }

    if (
      estado === "excedido"
    ) {
      return "⚠ Excedido";
    }

    if (
      estado === "pendiente"
    ) {
      return "Pendiente";
    }

    return "Sin configurar";
  }



  // ==========================================================
  // DETALLE DESPLEGABLE DE DISTRIBUCIÓN POR PRODUCTO
  // ==========================================================

  window.__pedidoPctItems =
    window.__pedidoPctItems || {};


  function formatoDineroPedidoPct(valor) {

    if (
      valor === null ||
      valor === undefined ||
      valor === ""
    ) {
      return "—";
    }

    return "$" +
      Number(valor).toLocaleString(
        "es-CO",
        {
          maximumFractionDigits: 0
        }
      );
  }



  function abrirDetallePedidoPct(
    detalleId
  ) {

    const fila =
      document.getElementById(
        "pedidoPctDetalle_" +
        detalleId
      );

    const icono =
      document.getElementById(
        "pedidoPctIcono_" +
        detalleId
      );


    if (!fila) {
      return;
    }


    const abierto =
      fila.style.display ===
      "table-row";


    fila.style.display =
      abierto
        ? "none"
        : "table-row";


    if (icono) {
      icono.textContent =
        abierto
          ? "▶"
          : "▼";
    }
  }


  window.abrirDetallePedidoPct =
    abrirDetallePedidoPct;


  async function cargarPedidoPct() {

    crearBloqueDistribucionPorcentual();


    const {
      ciclo,
      periodo
    } =
      datosSeleccionPedidoPct();


    const tbody =
      document.getElementById(
        "pedidoPctBody"
      );


    if (!tbody) {
      return;
    }


    if (!ciclo) {

      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;padding:20px;">Selecciona un ciclo.</td></tr>';

      return;
    }


    try {

      const url =
        "/api/pedidos/distribucion-porcentajes" +
        "?ciclo=" +
        encodeURIComponent(
          ciclo
        ) +
        "&periodo=" +
        encodeURIComponent(
          periodo
        );


      const res =
        await api(url);


      const data =
        await res.json();


      const resumen =
        data.resumen || {
          productos: 0,
          completos: 0,
          pendientes: 0,
          excedidos: 0
        };


      const elProductos =
        document.getElementById(
          "pedidoPctProductos"
        );

      const elCompletos =
        document.getElementById(
          "pedidoPctCompletos"
        );

      const elPendientes =
        document.getElementById(
          "pedidoPctPendientes"
        );

      const elExcedidos =
        document.getElementById(
          "pedidoPctExcedidos"
        );


      if (elProductos) {
        elProductos.textContent =
          resumen.productos || 0;
      }

      if (elCompletos) {
        elCompletos.textContent =
          resumen.completos || 0;
      }

      if (elPendientes) {
        elPendientes.textContent =
          resumen.pendientes || 0;
      }

      if (elExcedidos) {
        elExcedidos.textContent =
          resumen.excedidos || 0;
      }


      const mensaje =
        document.getElementById(
          "pedidoPctMensaje"
        );


      if (mensaje) {

        mensaje.textContent =
          data.demanda
            ? "Haz clic sobre un producto para ver cómo quedó distribuido entre los proveedores."
            : "Aún no se ha cargado una distribución.";
      }


      window.__pedidoPctItems = {};


      if (
        !data.items ||
        !data.items.length
      ) {

        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center;padding:20px;">No hay demanda cargada.</td></tr>';

        return;
      }


      tbody.innerHTML =
        data.items.map(
          i => {

            const id =
              Number(
                i.demanda_detalle_id
              );


            window.__pedidoPctItems[
              id
            ] = i;


            const requerido =
              Number(
                i.cantidad_requerida || 0
              );


            const pct =
              Number(
                i.total_porcentaje || 0
              );


            const kg =
              Number(
                i.kg_calculados || 0
              );


            const distribucion =
              Array.isArray(
                i.distribucion
              )
                ? i.distribucion
                : [];


            let detalleDistribucion =
              "";


            if (
              distribucion.length
            ) {

              let totalPctDetalle = 0;
              let totalKgDetalle = 0;


              const filasDetalle =
                distribucion.map(
                  d => {

                    const pctProveedor =
                      Number(
                        d.porcentaje || 0
                      );


                    const kgProveedor =
                      requerido *
                      pctProveedor /
                      100;


                    totalPctDetalle +=
                      pctProveedor;

                    totalKgDetalle +=
                      kgProveedor;


                    return (
                      "<tr>" +

                      "<td><strong>" +
                      esc(
                        d.proveedor || ""
                      ) +
                      "</strong></td>" +

                      "<td>" +
                      pctProveedor.toFixed(2) +
                      "%</td>" +

                      "<td><strong>" +
                      kgProveedor.toFixed(2) +
                      " kg</strong></td>" +

                      "</tr>"
                    );
                  }
                ).join("");


              detalleDistribucion =
                '<div style="' +
                'padding:14px;' +
                'background:var(--surface-soft,#f7faf8);' +
                'border-radius:8px;' +
                '">' +

                '<div style="' +
                'margin-bottom:10px;' +
                'font-weight:600;' +
                '">' +
                'Distribución del producto' +
                '</div>' +

                '<div style="overflow:auto;">' +

                '<table style="width:100%;">' +

                '<thead>' +
                '<tr>' +
                '<th>Proveedor</th>' +
                '<th>% asignado</th>' +
                '<th>KG asignados</th>' +
                '</tr>' +
                '</thead>' +

                '<tbody>' +
                filasDetalle +
                '</tbody>' +

                '<tfoot>' +
                '<tr>' +

                '<td><strong>TOTAL</strong></td>' +

                '<td><strong>' +
                totalPctDetalle.toFixed(2) +
                '%</strong></td>' +

                '<td><strong>' +
                totalKgDetalle.toFixed(2) +
                ' kg</strong></td>' +

                '</tr>' +
                '</tfoot>' +

                '</table>' +

                '</div>' +

                '</div>';

            } else {

              detalleDistribucion =
                '<div style="' +
                'padding:14px;' +
                'color:var(--ink-soft);' +
                '">' +
                'Este producto no tiene distribución por proveedor cargada.' +
                '</div>';
            }


            return (
              '<tr class="pedido-pct-producto" ' +
              'data-detalle-id="' +
              id +
              '" ' +
              'onclick="window.abrirDetallePedidoPct(' +
              id +
              ')" ' +
              'style="cursor:pointer;">' +

              '<td>' +
              '<span id="pedidoPctIcono_' +
              id +
              '" style="display:inline-block;width:18px;">▶</span>' +
              esc(
                i.codigo || ""
              ) +
              '</td>' +

              '<td><strong>' +
              esc(
                i.producto || ""
              ) +
              '</strong></td>' +

              '<td>' +
              requerido.toFixed(2) +
              '</td>' +

              '<td><strong>' +
              pct.toFixed(2) +
              '%</strong></td>' +

              '<td>' +
              kg.toFixed(2) +
              '</td>' +

              '<td>' +
              etiquetaEstadoPedidoPct(
                i.estado
              ) +
              '</td>' +

              '</tr>' +

              '<tr ' +
              'id="pedidoPctDetalle_' +
              id +
              '" ' +
              'style="display:none;">' +

              '<td colspan="6" style="padding:8px 12px 14px 30px;">' +

              '<div id="pedidoPctContenido_' +
              id +
              '">' +
              detalleDistribucion +
              '</div>' +

              '</td>' +

              '</tr>'
            );
          }
        ).join("");


    } catch (err) {

      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;padding:20px;">No se pudo cargar la distribución.</td></tr>';
    }
  }


  async function importarPedidoPct(
    e
  ) {

    const archivo =
      e.target.files[0];


    if (!archivo) {
      return;
    }


    const {
      ciclo,
      periodo
    } =
      datosSeleccionPedidoPct();


    if (!ciclo) {

      toast(
        "Selecciona primero el ciclo."
      );

      e.target.value =
        "";

      return;
    }


    const form =
      new FormData();

    form.append(
      "archivo",
      archivo
    );

    form.append(
      "ciclo_id",
      ciclo
    );

    form.append(
      "periodo",
      periodo
    );


    try {

      toast(
        "Cargando distribución porcentual..."
      );


      const res =
        await api(
          "/api/pedidos/distribucion-porcentajes/importar",
          {
            method: "POST",
            body: form
          }
        );


      const data =
        await res.json();


      toast(
        "Distribución cargada: " +
        data.completos +
        " completos, " +
        data.pendientes +
        " pendientes, " +
        data.excedidos +
        " excedidos."
      );


      await cargarPedidoPct();


    } catch (err) {

      toast(
        "No se pudo cargar: " +
        err.message
      );


    } finally {

      e.target.value =
        "";
    }
  }


  async function aplicarPedidoPct() {

    const {
      ciclo,
      periodo
    } =
      datosSeleccionPedidoPct();


    if (!ciclo) {

      toast(
        "Selecciona primero el ciclo."
      );

      return;
    }


    if (
      !confirm(
        "¿Aplicar los porcentajes a los kilos del pedido?\n\n" +
        "Para los productos configurados se reemplazará la distribución manual actual. " +
        "Los productos sin porcentajes no se modificarán."
      )
    ) {
      return;
    }


    try {

      toast(
        "Aplicando distribución..."
      );


      const res =
        await api(
          "/api/pedidos/distribucion-porcentajes/aplicar",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body:
              JSON.stringify({
                ciclo_id:
                  ciclo,
                periodo
              })
          }
        );


      const data =
        await res.json();


      toast(
        "Distribución aplicada a " +
        data.productos_aplicados +
        " producto(s)."
      );


      await cargarPedidoPct();

      await renderPedidos();


    } catch (err) {

      toast(
        "No se pudo aplicar: " +
        err.message
      );
    }
  }


  crearBloqueDistribucionPorcentual();


  document.getElementById(
    "pedidoCicloSelect"
  )?.addEventListener(
    "change",
    cargarPedidoPct
  );


  document.getElementById(
    "pedidoPeriodoSelect"
  )?.addEventListener(
    "change",
    cargarPedidoPct
  );


  setTimeout(
    cargarPedidoPct,
    700
  );





  // ==========================================================
  // ORDEN VISUAL DEL FLUJO DE PEDIDOS
  // ==========================================================

  function ordenarFlujoPedidosUI() {

    const tab =
      document.getElementById(
        "tab-pedidos"
      );

    if (!tab) {
      return;
    }


    // Primera tarjeta = encabezado general Pedidos Fruver.
    const cabecera =
      tab.querySelector(
        ":scope > .card"
      );


    const planeacion =
      document.getElementById(
        "pedidoPlaneacionCard"
      );

    const resumen =
      document.getElementById(
        "pedidoResumenCard"
      );

    const distribucion =
      document.getElementById(
        "pedidoPctCard"
      );

    const proveedor =
      document.getElementById(
        "pedidoProveedorCard"
      );

    const productos =
      document.getElementById(
        "pedidoProductosCard"
      );


    if (
      !cabecera ||
      !planeacion ||
      !resumen ||
      !proveedor
    ) {
      return;
    }


    // Orden:
    // Cabecera
    // 1 Planeación
    // 2 Resumen
    // 3 Distribución
    // 4 Pedido proveedor

    cabecera.after(
      planeacion
    );

    planeacion.after(
      resumen
    );


    if (distribucion) {

      resumen.after(
        distribucion
      );

      distribucion.after(
        proveedor
      );

    } else {

      resumen.after(
        proveedor
      );
    }


    // Mantener la tabla vieja en DOM,
    // pero completamente oculta.
    if (productos) {

      productos.style.display =
        "none";

      proveedor.after(
        productos
      );
    }
  }


  setTimeout(
    ordenarFlujoPedidosUI,
    850
  );


  document
    .querySelector(
      'nav.tabs button[data-tab="pedidos"]'
    )
    ?.addEventListener(
      "click",
      () => {

        setTimeout(
          ordenarFlujoPedidosUI,
          150
        );
      }
    );




  // ==========================================================
  // NEGOCIACIÓN UNIFICADA
  // ==========================================================

  async function cargarNegociacionUnificada() {

    const cicloSelect =
      document.getElementById("negUniCiclo");

    const proveedorSelect =
      document.getElementById("negUniProveedor");

    if (!cicloSelect || !proveedorSelect) {
      return;
    }


    try {

      // ------------------------------------------------------
      // CICLOS
      // ------------------------------------------------------

      const ciclos =
        await (
          await api("/api/ciclos")
        ).json();


      const cicloActual =
        cicloSelect.value;


      cicloSelect.innerHTML =
        '<option value="">Selecciona ciclo…</option>' +
        ciclos.map(c => {

          const id =
            typeof c === "string"
              ? c
              : (
                  c.id ||
                  c.ciclo_id ||
                  c.codigo ||
                  ""
                );

          return (
            '<option value="' +
            esc(id) +
            '">' +
            esc(id) +
            '</option>'
          );

        }).join("");


      if (
        cicloActual &&
        Array.from(cicloSelect.options)
          .some(o => o.value === cicloActual)
      ) {
        cicloSelect.value = cicloActual;
      }


      // ------------------------------------------------------
      // PROVEEDORES
      // ------------------------------------------------------

      const proveedores =
        await (
          await api("/api/proveedores")
        ).json();


      const proveedorActual =
        proveedorSelect.value;


      proveedorSelect.innerHTML =
        '<option value="">Selecciona proveedor…</option>' +
        proveedores.map(p => {

          const nombre =
            typeof p === "string"
              ? p
              : (
                  p.nombre ||
                  p.proveedor ||
                  ""
                );

          return (
            '<option value="' +
            esc(nombre) +
            '">' +
            esc(nombre) +
            '</option>'
          );

        }).join("");


      if (
        proveedorActual &&
        Array.from(proveedorSelect.options)
          .some(o => o.value === proveedorActual)
      ) {
        proveedorSelect.value =
          proveedorActual;
      }


      if (cicloSelect.value) {
        await listarNegociacionesUnificadas(
          cicloSelect.value
        );
      }

    } catch (err) {

      toast(
        "No se pudo cargar Negociación: " +
        err.message
      );

    }
  }



  async function listarNegociacionesUnificadas(
    ciclo
  ) {

    const cont =
      document.getElementById(
        "negUniLista"
      );

    if (!cont) return;


    if (!ciclo) {

      cont.innerHTML =
        '<div style="color:var(--ink-soft);">' +
        'Selecciona un ciclo.' +
        '</div>';

      return;
    }


    try {

      const rows =
        await (
          await api(
            "/api/negociaciones-unificadas?ciclo=" +
            encodeURIComponent(ciclo)
          )
        ).json();


      if (!rows.length) {

        cont.innerHTML =
          '<div style="color:var(--ink-soft);">' +
          'Todavía no hay negociaciones iniciadas en este ciclo.' +
          '</div>';

        return;
      }


      cont.innerHTML =
        rows.map(n => {

          return (
            '<div class="file-row" ' +
            'style="cursor:pointer;" ' +
            'onclick="window.abrirNegociacionUnificada(' +
            Number(n.id) +
            ')">' +

              '<div class="meta">' +

                '<span class="name">' +
                esc(n.proveedor) +
                '</span>' +

                '<span class="sub">' +
                esc(n.ciclo_id) +
                ' · Ronda ' +
                Number(n.ronda_actual || 1) +
                ' · ' +
                esc(n.estado || "abierta") +
                ' · ' +
                Number(n.productos || 0) +
                ' productos' +
                '</span>' +

              '</div>' +

            '</div>'
          );

        }).join("");

    } catch (err) {

      cont.innerHTML =
        '<div style="color:var(--warn);">' +
        esc(err.message) +
        '</div>';

    }
  }



  async function abrirNegociacionUnificada(
    id
  ) {

    try {

      const data =
        await (
          await api(
            "/api/negociaciones-unificadas/" +
            Number(id)
          )
        ).json();


      const n =
        data.negociacion;


      document.getElementById(
        "negUniDetalleCard"
      ).style.display =
        "block";


      document.getElementById(
        "negUniTitulo"
      ).textContent =
        n.proveedor +
        " · " +
        n.ciclo_id;


      document.getElementById(
        "negUniEstado"
      ).innerHTML =
        "Estado: <strong>" +
        esc(n.estado) +
        "</strong> · Ronda actual: <strong>" +
        Number(n.ronda_actual || 1) +
        "</strong>";


      const body =
        document.getElementById(
          "negUniBody"
        );


      body.innerHTML =
        data.productos.map(p => {

          const inicial =
            p.propuesta_inicial !== null
              ? fmtMoney(
                  p.propuesta_inicial
                )
              : "—";

          const contra =
            p.contrapropuesta_mercaldas !== null
              ? fmtMoney(
                  p.contrapropuesta_mercaldas
                )
              : "—";

          const finalProveedor =
            p.propuesta_final_proveedor !== null
              ? fmtMoney(
                  p.propuesta_final_proveedor
                )
              : "—";

          const precioFinal =
            p.precio_final !== null
              ? fmtMoney(
                  p.precio_final
                )
              : "—";


          return (
            "<tr>" +

            "<td>" +
            esc(p.codigo) +
            "</td>" +

            "<td>" +
            esc(p.producto || "") +
            "</td>" +

            "<td>" +
            esc(p.presentacion || "") +
            "</td>" +

            "<td>" +
            inicial +
            "</td>" +

            "<td><strong>" +
            contra +
            "</strong></td>" +

            "<td>" +
            finalProveedor +
            "</td>" +

            "<td><strong>" +
            precioFinal +
            "</strong></td>" +

            "<td>" +
            esc(p.estado || "pendiente") +
            "</td>" +

            "</tr>"
          );

        }).join("");


    } catch (err) {

      toast(
        "No se pudo abrir la negociación: " +
        err.message
      );

    }
  }


  window.abrirNegociacionUnificada =
    abrirNegociacionUnificada;



  async function iniciarNegociacionUnificada() {

    const ciclo =
      document.getElementById(
        "negUniCiclo"
      ).value;

    const proveedor =
      document.getElementById(
        "negUniProveedor"
      ).value;


    if (!ciclo) {

      toast(
        "Selecciona el ciclo."
      );

      return;
    }


    if (!proveedor) {

      toast(
        "Selecciona el proveedor."
      );

      return;
    }


    try {

      const res =
        await api(
          "/api/negociaciones-unificadas/iniciar",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              ciclo,
              proveedor
            })
          }
        );


      const data =
        await res.json();


      if (data.existente) {

        toast(
          "La negociación ya existía. Se abrió el expediente."
        );

      } else {

        toast(
          "Negociación iniciada: " +
          data.productos +
          " productos."
        );

      }


      await listarNegociacionesUnificadas(
        ciclo
      );


      await abrirNegociacionUnificada(
        data.negociacion_id
      );


    } catch (err) {

      toast(
        "No se pudo iniciar: " +
        err.message
      );

    }
  }



  // ----------------------------------------------------------
  // EVENTOS
  // ----------------------------------------------------------

  const btnNegUni =
    document.getElementById(
      "btnNegUniIniciar"
    );

  if (btnNegUni) {

    btnNegUni.addEventListener(
      "click",
      iniciarNegociacionUnificada
    );

  }


  const cicloNegUni =
    document.getElementById(
      "negUniCiclo"
    );

  if (cicloNegUni) {

    cicloNegUni.addEventListener(
      "change",
      () => {

        listarNegociacionesUnificadas(
          cicloNegUni.value
        );

      }
    );

  }



  // ----------------------------------------------------------
  // CONTROL ESPECÍFICO DE LA NUEVA PESTAÑA
  // Captura el clic antes del controlador antiguo.
  // ----------------------------------------------------------

  const btnTabNegUni =
    document.querySelector(
      'nav.tabs button[data-tab="negociacion"]'
    );

  if (btnTabNegUni) {

    btnTabNegUni.addEventListener(
      "click",
      async (e) => {

        e.preventDefault();
        e.stopImmediatePropagation();


        document
          .querySelectorAll(
            "nav.tabs button"
          )
          .forEach(
            b =>
              b.classList.remove(
                "active"
              )
          );


        btnTabNegUni.classList.add(
          "active"
        );


        document
          .querySelectorAll(
            'section[id^="tab-"]'
          )
          .forEach(sec => {

            sec.style.display =
              sec.id ===
              "tab-negociacion"
                ? "block"
                : "none";

          });


        await cargarNegociacionUnificada();

      },
      true
    );

  }




  async function renderOrdenesCompra() {
    if (typeof cargarCiclosPedidos === "function") await cargarCiclosPedidos();
    const cicloSelect = document.getElementById("pedidoCicloSelect");
    const periodoSelect = document.getElementById("pedidoPeriodoSelect");
    const ciclo = cicloSelect ? cicloSelect.value : "";
    const periodo = periodoSelect ? (periodoSelect.value || "LUNES-MARTES") : "LUNES-MARTES";

    const tbodyPend = document.querySelector("#ocPendientesTabla tbody");
    const tbodyHist = document.querySelector("#ocHistoricoTabla tbody");
    if (!tbodyPend || !tbodyHist) return;

    if (!ciclo) {
      tbodyPend.innerHTML = '<tr><td colspan="4">Selecciona un ciclo en la pestaña Pedidos primero.</td></tr>';
      tbodyHist.innerHTML = "";
      return;
    }

    try {
      const pendientes = await (await api("/api/ordenes-compra/pendientes?ciclo_id=" + encodeURIComponent(ciclo) + "&periodo=" + encodeURIComponent(periodo))).json();

      if (!pendientes.length) {
        tbodyPend.innerHTML = '<tr><td colspan="4">No hay pedidos confirmados pendientes de orden de compra para ' + ciclo + ' (' + periodo + ').</td></tr>';
      } else {
        tbodyPend.innerHTML = pendientes.map((p) => (
          "<tr><td style=\"padding:6px;\">" + p.proveedor + "</td>" +
          "<td style=\"padding:6px;\">" + p.num_items + "</td>" +
          "<td style=\"padding:6px;\">$ " + Math.round(p.total_estimado).toLocaleString("es-CO") + "</td>" +
          "<td style=\"padding:6px;\"><button class=\"btn-primary btn-generar-oc\" data-proveedor=\"" + encodeURIComponent(p.proveedor) + "\">Generar Orden de Compra</button></td></tr>"
        )).join("");

        tbodyPend.querySelectorAll(".btn-generar-oc").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const proveedor = decodeURIComponent(btn.dataset.proveedor);
            if (!confirm("¿Generar la orden de compra para " + proveedor + "?")) return;
            try {
              const res = await (await api("/api/ordenes-compra/generar", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ciclo_id: ciclo, periodo: periodo, proveedor: proveedor })
              })).json();
              toast("Orden " + res.orden.numero + " generada correctamente.");
              await renderOrdenesCompra();
            } catch (err) {
              toast("No se pudo generar: " + err.message);
            }
          });
        });
      }

      const historico = await (await api("/api/ordenes-compra")).json();
      if (!historico.length) {
        tbodyHist.innerHTML = '<tr><td colspan="4">Aún no se ha generado ninguna orden de compra.</td></tr>';
      } else {
        tbodyHist.innerHTML = historico.map((oc) => (
          "<tr><td style=\"padding:6px;\"><strong>" + oc.numero + "</strong></td>" +
          "<td style=\"padding:6px;\">" + oc.proveedor + "</td>" +
          "<td style=\"padding:6px;\">$ " + Math.round(oc.total).toLocaleString("es-CO") + "</td>" +
          "<td style=\"padding:6px;\">" + new Date(oc.creado_en).toLocaleDateString("es-CO") + "</td>" +
          "<td style=\"padding:6px;\"><a href=\"/api/ordenes-compra/" + oc.id + "/excel\" target=\"_blank\">Descargar Excel</a></td></tr>"
        )).join("");
      }
    } catch (err) {
      toast("Error cargando órdenes de compra: " + err.message);
    }
  }



  // ===== Hoja de negociación: todas las rondas de un proveedor en una sola hoja =====
  const HN = { ciclos: [], ciclo: null, negId: null, hoja: null, archivo: null, editando: false };
  const hnEsc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hnMoneda = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CO"));
  const hnRaiz = () => document.getElementById("hojaNegRaiz");

  function hnEstilos() {
    if (document.getElementById("hnEstilos")) return;
    const s = document.createElement("style");
    s.id = "hnEstilos";
    s.textContent = [
      ".hn-card{background:#fff;border:1px solid #B7C9BD;border-radius:12px;padding:16px 18px;margin:0 0 14px}",
      ".hn-top{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}",
      ".hn-h{margin:0;font-size:1.15rem;color:#1F6B45}.hn-sub{margin:4px 0 0;color:#5b6b61;font-size:.88rem}",
      ".hn-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 14px}",
      ".hn-m{background:#F7FBF8;border:1px solid #E3ECE6;border-radius:10px;padding:10px 14px}.hn-m span{display:block;font-size:.8rem;color:#5b6b61}.hn-m b{font-size:1.4rem;color:#24342B}",
      ".hn-wrap{overflow-x:auto;border:1px solid #B7C9BD;border-radius:12px;background:#fff;margin:0 0 14px}",
      ".hn-t{width:100%;min-width:940px;border-collapse:collapse;font-size:.88rem}",
      ".hn-t th{background:#6FAE82;color:#fff;font-weight:600;padding:8px 10px;text-align:center;border:1px solid #B7C9BD}",
      ".hn-t td{padding:8px 10px;border-top:1px solid #E3ECE6;vertical-align:middle;color:#24342B}.hn-t td.n{text-align:right;white-space:nowrap}",
      ".hn-t tbody tr:nth-child(even) td{background:#F7FBF8}.hn-t small{display:block;color:#5b6b61}",
      ".hn-b{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.78rem;white-space:nowrap}",
      ".hn-ok{background:#E3F4E8;color:#1b6b3a}.hn-wait{background:#FFF2CC;color:#8a5a00}.hn-turn{background:#E1EEFB;color:#14508c}.hn-no{background:#FDE7E7;color:#9c2a2a}.hn-none{background:#EEF3F0;color:#44554b}",
      ".hn-btn{padding:8px 14px;border-radius:8px;border:1px solid #1F6B45;background:#fff;color:#1F6B45;font-weight:600;cursor:pointer}.hn-btn.p{background:#1F6B45;color:#fff}",
      ".hn-in{width:88px;padding:5px 6px;border:1px dashed #1F6B45;border-radius:6px;text-align:right;background:#F1F8FE}",
      ".hn-pf{width:96px;padding:5px 6px;border:1px solid #1F6B45;border-radius:6px;text-align:right;background:#FFFBEA}",
      ".hn-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.hn-av{margin:6px 0;padding:8px 12px;border-radius:8px;font-size:.88rem}",
      ".hn-av.error{background:#FDE7E7;color:#9c2a2a}.hn-av.aviso{background:#FFF2CC;color:#8a5a00}.hn-av.info{background:#EEF3F0;color:#44554b}",
    ].join("\n");
    document.head.appendChild(s);
  }

  async function hnCargarCiclos() {
    let ciclos = [];
    try { ciclos = await (await api("/api/ciclos")).json(); } catch (e) {}
    let activo = null;
    try {
      const a = await (await api("/api/ciclos/actual")).json();
      activo = (a && (a.ciclo_id || (a.ciclo && a.ciclo.id) || a.id || (a.activo && a.activo.id))) || null;
    } catch (e) {}
    const ids = ciclos.map((c) => c.id).sort().reverse();
    HN.ciclos = ids;
    HN.ciclo = activo && ids.includes(activo) ? activo : ids[0] || null;
  }

  async function renderHojaNegociacion() {
    hnEstilos();
    const raiz = hnRaiz();
    if (!raiz) return;
    if (!raiz.dataset.listo) {
      raiz.dataset.listo = "1";
      raiz.addEventListener("click", hnClick);
      raiz.addEventListener("change", hnCambio);
    }
    try {
      if (!HN.ciclo) await hnCargarCiclos();
      if (HN.negId) await hnAbrirHoja(HN.negId); else await hnTablero();
    } catch (err) {
      toast("No se pudo cargar la negociación: " + err.message);
    }
  }

  async function hnDatosTablero() {
    return (await api("/api/negociacion/tablero?ciclo=" + encodeURIComponent(HN.ciclo || ""))).json();
  }

  async function hnTablero() {
    HN.negId = null; HN.hoja = null; HN.archivo = null; HN.editando = false;
    const datos = await hnDatosTablero();
    const opciones = HN.ciclos.map((c) => '<option value="' + hnEsc(c) + '"' + (c === HN.ciclo ? " selected" : "") + ">" + hnEsc(c) + "</option>").join("");
    const filas = datos.proveedores.map((p) => {
      const sin = p.negociacion_id == null;
      let estado, accion;
      if (sin) {
        estado = '<span class="hn-b hn-none">Sin iniciar</span>';
        accion = '<button class="hn-btn p" data-hn="iniciar" data-prov="' + hnEsc(p.proveedor) + '">Iniciar negociación</button>';
      } else {
        estado = p.estado === "cerrada" ? '<span class="hn-b hn-ok">Cerrada</span>'
          : p.tu_turno > 0 ? '<span class="hn-b hn-turn">Te toca decidir (' + p.tu_turno + ")</span>"
          : '<span class="hn-b hn-wait">Esperando al proveedor</span>';
        accion = '<button class="hn-btn" data-hn="abrir" data-id="' + p.negociacion_id + '">Abrir hoja</button>';
      }
      return "<tr><td>" + hnEsc(p.proveedor) + '</td><td class="n">' + p.cotizaciones + "</td><td>" + estado + '</td><td class="n">' + (sin ? "—" : p.ronda_visible + " de 3") + '</td><td class="n">' + (sin ? "—" : p.cerrados + " de " + p.total) + "</td><td>" + accion + "</td></tr>";
    }).join("");
    hnRaiz().innerHTML =
      '<div class="hn-card"><div class="hn-top"><div><h2 class="hn-h">Negociación</h2><p class="hn-sub">Todas las rondas de cada proveedor en una sola hoja: lo que cotizó, tu contrapropuesta, su respuesta y el precio final.</p></div>' +
      '<label class="hn-sub">Ciclo <select id="hnCiclo">' + opciones + "</select></label></div></div>" +
      (filas ? '<div class="hn-wrap"><table class="hn-t" style="min-width:720px"><thead><tr><th>Proveedor</th><th>Cotizaciones</th><th>Estado</th><th>Ronda</th><th>Cerrados</th><th></th></tr></thead><tbody>' + filas + "</tbody></table></div>"
        : '<div class="hn-card"><p class="hn-sub">No hay cotizaciones ni negociaciones en este ciclo.</p></div>');
  }

  async function hnIniciar(prov) {
    await api("/api/negociaciones-unificadas/iniciar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ciclo: HN.ciclo, proveedor: prov }) });
    toast("Negociación iniciada con " + prov);
    const x = (await hnDatosTablero()).proveedores.find((p) => p.proveedor === prov);
    if (x && x.negociacion_id) await hnAbrirHoja(x.negociacion_id); else await hnTablero();
  }

  async function hnAbrirHoja(id) {
    HN.hoja = await (await api("/api/negociacion/" + id + "/hoja")).json();
    HN.negId = id;
    HN.editando = false;
    hnRenderHoja();
  }

  function hnSugerencia(p) {
    if (p.contraActual == null || p.proveedorActual == null) return "";
    let s = Math.floor((p.contraActual + p.proveedorActual) / 2 / 100) * 100;
    if (s <= p.contraActual) s = p.contraActual + 100;
    return s > 0 && s < p.proveedorActual ? s : "";
  }

  function hnCeldasRonda(p, k) {
    const r = p.rondas[k];
    const sigueIndice = p.turno === "mercaldas" && p.ultimaRonda < 7 ? (p.ultimaRonda - 1) / 2 : -1;
    let m;
    if (r.mercaldas != null) m = hnMoneda(r.mercaldas);
    else if (sigueIndice === k) m = '<input class="hn-in" type="number" min="100" step="100" data-codigo="' + hnEsc(p.codigo) + '" value="' + hnSugerencia(p) + '" title="Tu nueva contrapropuesta">';
    else m = '<span style="color:#9aa8a0">—</span>';
    let v;
    if (r.proveedor != null) v = r.mercaldas != null && r.proveedor === r.mercaldas ? '<span style="color:#1b6b3a;font-weight:600">Acepta</span>' : hnMoneda(r.proveedor);
    else if (p.turno === "proveedor" && p.ultimaRonda === 2 * (k + 1)) v = '<span style="color:#8a5a00">Esperando</span>';
    else v = '<span style="color:#9aa8a0">—</span>';
    return '<td class="n">' + m + '</td><td class="n">' + v + "</td>";
  }

  function hnCeldaFinal(p) {
    if (HN.editando) {
      const actual = p.estado === "acuerdo" && p.precio_final != null ? p.precio_final : "";
      return '<input class="hn-pf" type="number" min="100" step="50" data-codigo="' + hnEsc(p.codigo) + '" data-orig="' + actual + '" value="' + actual + '" title="Precio final acordado">';
    }
    return "<b>" + hnMoneda(p.precio_final) + "</b>" + (p.manual ? ' <span class="hn-b hn-none" title="' + hnEsc(p.notaManual || "Registrado manualmente") + '">manual</span>' : "");
  }

  function hnRenderHoja() {
    const h = HN.hoja, n = h.negociacion, r = h.resumen;
    const filas = h.productos.map((p) => {
      const badge = p.estado === "acuerdo" ? '<span class="hn-b hn-ok">Acuerdo</span>'
        : p.estado === "sin_acuerdo" ? '<span class="hn-b hn-no">Sin acuerdo</span>'
        : p.turno === "mercaldas" ? '<span class="hn-b hn-turn">Tu turno</span>' : '<span class="hn-b hn-wait">Esperando proveedor</span>';
      const chk = p.turno === "mercaldas" ? '<input type="checkbox" class="hn-chk" data-codigo="' + hnEsc(p.codigo) + '">' : "";
      return "<tr><td>" + chk + "</td><td>" + hnEsc(p.producto) + (p.presentacion ? "<small>" + hnEsc(p.presentacion) + "</small>" : "") + '</td><td class="n">' + hnMoneda(p.cotizo) + "</td>" +
        hnCeldasRonda(p, 0) + hnCeldasRonda(p, 1) + hnCeldasRonda(p, 2) +
        '<td class="n">' + hnCeldaFinal(p) + '</td><td class="n">' + (p.ahorro_pct == null ? "—" : String(p.ahorro_pct).replace(".", ",") + " %") + "</td><td>" + badge + "</td></tr>";
    }).join("");
    const barra = r.tu_turno > 0
      ? '<div class="hn-card"><div class="hn-row"><b>Productos seleccionados:</b>' +
        '<button class="hn-btn p" data-hn="aceptar">Aceptar su precio</button><button class="hn-btn" data-hn="contraproponer">Contraproponer</button><button class="hn-btn" data-hn="sinacuerdo">Sin acuerdo</button></div>' +
        '<p class="hn-sub">Marca los productos en tu turno. "Contraproponer" usa el precio de la casilla de cada fila (ya viene con una sugerencia que puedes cambiar).</p></div>' : "";
    const barraEdicion = '<div class="hn-card"><div class="hn-row"><b>Modo edición:</b> escribe el precio final acordado en cada producto y pulsa Guardar.' +
      '<input id="hnNota" type="text" maxlength="300" placeholder="Nota (opcional): ej. acordado por teléfono con Juan" style="flex:1;min-width:260px;padding:6px 8px;border:1px solid #B7C9BD;border-radius:6px">' +
      '<button class="hn-btn p" data-hn="guardarpf">Guardar precios</button><button class="hn-btn" data-hn="cancelarpf">Cancelar</button></div>' +
      '<p class="hn-sub">Solo se guardan los precios que cambies. Quedan marcados como "manual" en el historial, con tu nota.</p></div>';
    hnRaiz().innerHTML =
      '<div class="hn-card"><div class="hn-top"><div><h2 class="hn-h">' + hnEsc(n.proveedor) + '</h2><p class="hn-sub">Ciclo ' + hnEsc(n.ciclo) + " · Ronda " + n.ronda_visible + " de " + n.max_rondas + (n.estado === "cerrada" ? " · Negociación cerrada" : "") + "</p></div>" +
      '<button class="hn-btn" data-hn="volver">← Todos los proveedores</button></div></div>' +
      '<div class="hn-metrics"><div class="hn-m"><span>Ronda actual</span><b>' + n.ronda_visible + '</b></div><div class="hn-m"><span>Productos cerrados</span><b>' + r.cerrados + " de " + r.total + '</b></div>' +
      '<div class="hn-m"><span>Esperan tu decisión</span><b>' + r.tu_turno + '</b></div><div class="hn-m"><span>Ahorro promedio</span><b>' + (r.ahorro_promedio_pct == null ? "—" : String(r.ahorro_promedio_pct).replace(".", ",") + " %") + "</b></div></div>" +
      '<div class="hn-card"><div class="hn-row"><button class="hn-btn" data-hn="exportar">Descargar Excel de la ronda</button><button class="hn-btn" data-hn="editar">Editar precios finales (sin Excel)</button>' +
      '<span class="hn-sub" style="margin:0 0 0 8px">Respuesta del proveedor:</span><input type="file" id="hnArchivo" accept=".xlsx"><button class="hn-btn p" data-hn="revisar">Revisar archivo</button></div><div id="hnPrevia"></div></div>' +
      '<div class="hn-wrap"><table class="hn-t"><thead><tr><th rowspan="2"><input type="checkbox" data-hn="todos" title="Marcar todos los que esperan tu decisión"></th><th rowspan="2" style="text-align:left">Producto</th><th rowspan="2">Cotizó</th><th colspan="2">Ronda 1</th><th colspan="2">Ronda 2</th><th colspan="2">Ronda 3</th><th rowspan="2">Precio final</th><th rowspan="2">Ahorro</th><th rowspan="2">Estado</th></tr>' +
      "<tr><th>Mercaldas</th><th>Proveedor</th><th>Mercaldas</th><th>Proveedor</th><th>Mercaldas</th><th>Proveedor</th></tr></thead><tbody>" + filas + "</tbody></table></div>" + (HN.editando ? barraEdicion : barra);
  }

  async function hnExportar() {
    const info = await (await api("/api/negociacion/" + HN.negId + "/exportar?previsualizar=1")).json();
    if (info.alertas.length) {
      const lista = info.alertas.slice(0, 6).map((a) => "• " + a.producto + ": cotizó " + hnMoneda(a.cotizado) + ", contrapropuesta " + hnMoneda(a.contra) + " (baja " + String(a.bajaPct).replace(".", ",") + " %)").join("\n");
      if (!confirm("Estas contrapropuestas piden una baja de más de " + info.umbral_pct + " %. Puede ser un error de presentación o de unidad:\n\n" + lista + "\n\n¿Descargar el Excel de todos modos?")) return;
    }
    window.location.href = "/api/negociacion/" + HN.negId + "/exportar";
  }

  async function hnRevisar(confirmar) {
    if (!HN.archivo) { toast("Primero elige el archivo Excel que devolvió el proveedor."); return; }
    const fd = new FormData();
    fd.append("archivo", HN.archivo);
    const v = await (await api("/api/negociacion/" + HN.negId + "/importar" + (confirmar ? "?confirmar=1" : ""), { method: "POST", body: fd })).json();
    if (confirmar) {
      toast("Respuestas guardadas: " + v.guardadas);
      HN.archivo = null;
      await hnAbrirHoja(HN.negId);
      return;
    }
    const rs = v.resumen || {};
    const chips = [["acepta", "aceptan", "hn-ok"], ["mantiene", "mantienen su precio", "hn-wait"], ["contrapropone", "contraproponen", "hn-turn"], ["sin_respuesta", "sin respuesta", "hn-none"], ["revisar", "para revisar", "hn-no"]]
      .filter(([k]) => rs[k]).map(([k, t, c]) => '<span class="hn-b ' + c + '">' + rs[k] + " " + t + "</span>").join(" ");
    const avisos = (v.avisos || []).map((a) => '<div class="hn-av ' + a.nivel + '">' + hnEsc(a.texto) + "</div>").join("");
    const nombres = { acepta: "Acepta", mantiene: "Mantiene su precio", contrapropone: "Contrapropone", sin_respuesta: "Sin respuesta", revisar: "Revisar" };
    const tabla = (v.filas || []).map((f) => "<tr><td>" + hnEsc(f.producto) + '</td><td class="n">' + hnMoneda(f.cotizado) + '</td><td class="n">' + hnMoneda(f.contra) + '</td><td class="n">' + hnMoneda(f.respuesta) + "</td><td>" + nombres[f.tipo] + (f.motivo ? " — " + hnEsc(f.motivo) : "") + "</td></tr>").join("");
    document.getElementById("hnPrevia").innerHTML =
      '<p class="hn-sub" style="margin-top:12px"><b>Vista previa (todavía no se guardó nada).</b> Respuesta a la ronda ' + (v.ronda || "") + ": " + chips + "</p>" + avisos +
      (tabla ? '<div class="hn-wrap" style="margin-top:8px"><table class="hn-t" style="min-width:640px"><thead><tr><th style="text-align:left">Producto</th><th>Cotizó</th><th>Tu contrapropuesta</th><th>Respondió</th><th style="text-align:left">Resultado</th></tr></thead><tbody>' + tabla + "</tbody></table></div>" : "") +
      '<div class="hn-row">' + (v.puedeGuardar ? '<button class="hn-btn p" data-hn="guardar">Guardar respuestas</button>' : '<span class="hn-b hn-no">Hay errores: corrígelos y vuelve a cargar el archivo</span>') + '<button class="hn-btn" data-hn="cancelar">Cancelar</button></div>';
  }

  async function hnDecidir(accion) {
    const marcados = [...document.querySelectorAll(".hn-chk:checked")].map((c) => c.dataset.codigo);
    if (!marcados.length) { toast("Marca primero los productos."); return; }
    const decisiones = marcados.map((codigo) => {
      const d = { codigo, accion };
      if (accion === "contraproponer") {
        const inp = document.querySelector('.hn-in[data-codigo="' + (window.CSS && CSS.escape ? CSS.escape(codigo) : codigo) + '"]');
        d.precio = inp ? Number(inp.value) : NaN;
      }
      return d;
    });
    if (accion !== "contraproponer" && !confirm((accion === "aceptar" || accion === "aceptar_precio_proveedor" ? "¿Aceptar el precio del proveedor en " : "¿Marcar sin acuerdo ") + marcados.length + " producto(s)? Quedan cerrados.")) return;
    const res = await api("/api/negociacion/" + HN.negId + "/decidir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisiones }) });
    const j = await res.json();
    toast("Decisiones guardadas: " + j.aplicadas);
    HN.hoja = j.hoja;
    hnRenderHoja();
  }

  async function hnGuardarPrecios() {
    const cambios = [];
    document.querySelectorAll(".hn-pf").forEach((inp) => {
      const v = inp.value.trim();
      if (v === "" || v === inp.dataset.orig) return;
      cambios.push({ codigo: inp.dataset.codigo, precio: Number(v) });
    });
    if (!cambios.length) { toast("No cambiaste ningún precio."); return; }
    const rarezas = cambios.map((c) => {
      const p = HN.hoja.productos.find((x) => x.codigo === c.codigo);
      if (!p || !p.cotizo) return null;
      if (c.precio > p.cotizo) return p.producto + ": " + hnMoneda(c.precio) + " es MAYOR que lo que cotizó (" + hnMoneda(p.cotizo) + ")";
      if (c.precio < p.cotizo * 0.7) return p.producto + ": " + hnMoneda(c.precio) + " baja más de 30 % frente a lo que cotizó (" + hnMoneda(p.cotizo) + ")";
      return null;
    }).filter(Boolean);
    if (rarezas.length && !confirm("Revisa estos precios, parecen raros:\n\n" + rarezas.slice(0, 6).map((x) => "• " + x).join("\n") + "\n\n¿Guardar de todos modos?")) return;
    const nota = (document.getElementById("hnNota") || { value: "" }).value;
    const res = await api("/api/negociacion/" + HN.negId + "/precio-final", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cambios, nota }) });
    const j = await res.json();
    toast("Precios finales guardados: " + j.aplicados);
    HN.editando = false;
    HN.hoja = j.hoja;
    hnRenderHoja();
  }

  async function hnClick(e) {
    const el = e.target.closest("[data-hn]");
    if (!el) return;
    const que = el.dataset.hn;
    try {
      if (que === "todos") { document.querySelectorAll(".hn-chk").forEach((c) => { c.checked = el.checked; }); return; }
      if (que === "abrir") await hnAbrirHoja(el.dataset.id);
      else if (que === "iniciar") await hnIniciar(el.dataset.prov);
      else if (que === "volver") await hnTablero();
      else if (que === "exportar") await hnExportar();
      else if (que === "revisar") await hnRevisar(false);
      else if (que === "guardar") await hnRevisar(true);
      else if (que === "cancelar") document.getElementById("hnPrevia").innerHTML = "";
      else if (que === "aceptar") await hnDecidir("aceptar_precio_proveedor");
      else if (que === "contraproponer") await hnDecidir("contraproponer");
      else if (que === "sinacuerdo") await hnDecidir("sin_acuerdo");
      else if (que === "editar") { HN.editando = true; hnRenderHoja(); }
      else if (que === "cancelarpf") { HN.editando = false; hnRenderHoja(); }
      else if (que === "guardarpf") await hnGuardarPrecios();
    } catch (err) {
      toast(err.message);
    }
  }

  async function hnCambio(e) {
    if (e.target.id === "hnCiclo") { HN.ciclo = e.target.value; try { await hnTablero(); } catch (err) { toast(err.message); } }
    else if (e.target.id === "hnArchivo") HN.archivo = e.target.files[0] || null;
  }

  // Si se hace clic en cualquier otra pestaña, la hoja se oculta sola (aunque la lista de pestañas de la aplicación no la conozca)
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-tab]");
    if (b && b.dataset.tab !== "hoja-negociacion") {
      const s = document.getElementById("tab-hoja-negociacion");
      if (s) s.style.display = "none";
    }
  });

})();
