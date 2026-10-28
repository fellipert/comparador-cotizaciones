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

  // ===== SEMANA DE TRABAJO (única para todo el sistema) =====
  // Se elige en "Cargar cotizaciones" y la usan TODOS los módulos. No es lo mismo que la
  // "semana de recepción" (el ciclo activo), que es donde cargan los proveedores.
  function stEstado() {
    if (!window.__semanaTrabajo) window.__semanaTrabajo = { trabajo: null, recepcion: null, ciclos: [], pendiente: null };
    return window.__semanaTrabajo;
  }

  function stEtiqueta(c) {
    const id = c ? String(c.id || c) : "";
    const m = /^COT-(\d{4})-(\d{1,2})$/.exec(id);
    return m ? "Semana " + Number(m[2]) + " (" + id + ")" : (id || "—");
  }

  function stEstadoDe(c) { return c ? String(c.estado_efectivo || c.estado || "") : ""; }
  function stTerminada(c) { return /^(FINALIZADO|CERRADO)$/i.test(stEstadoDe(c)); }

  function stDistinta() {
    const st = stEstado();
    return !!(st.trabajo && st.recepcion && st.trabajo.id !== st.recepcion.id);
  }

  async function stCargar() {
    const st = stEstado();
    const semana = await (await api("/api/semana")).json();
    const ciclos = await (await api("/api/ciclos")).json();
    st.trabajo = semana.trabajo || null;
    st.recepcion = semana.recepcion || null;
    st.ciclos = Array.isArray(ciclos)
      ? ciclos.slice().sort((a, b) => String(b.id).localeCompare(String(a.id)))
      : [];
    return st;
  }

  async function stEstablecer(id) {
    const r = await api("/api/semana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciclo_id: id })
    });
    const data = await r.json();
    if (data && data.error) throw new Error(data.error);
    const aviso = document.getElementById("stAviso");
    if (aviso) aviso.remove();
    stEstado().pendiente = null;
    await stCargar();
    stAplicarSelectores();
  }

  // Deja un <select> con las semanas existentes y el valor pedido. Devuelve true si el valor cambió.
  function stFijar(select, valor, opciones) {
    if (!select) return false;
    const actuales = Array.from(select.options).map((o) => o.value).join("|");
    if (actuales !== opciones.map((o) => o.value).join("|")) {
      select.innerHTML = "";
      opciones.forEach((o) => {
        const op = document.createElement("option");
        op.value = o.value;
        op.textContent = o.label;
        select.appendChild(op);
      });
    }
    const antes = select.value;
    if (valor && Array.from(select.options).some((o) => o.value === valor)) select.value = valor;
    return antes !== select.value;
  }

  // Para selectores cuyas opciones arma otro código: solo asegura que exista la semana y la elige.
  function stForzar(select, valor) {
    if (!select || !valor) return false;
    if (!Array.from(select.options).some((o) => o.value === valor)) {
      const op = document.createElement("option");
      op.value = valor;
      op.textContent = valor;
      select.appendChild(op);
    }
    const antes = select.value;
    select.value = valor;
    return antes !== select.value;
  }

  function stOcultarSelectores() {
    ["cicloFiltroSelect", "pedidoCicloSelect", "negUniCiclo"].forEach((id) => {
      const s = document.getElementById(id);
      if (!s) return;
      s.style.display = "none";
      const previo = s.previousElementSibling;
      if (previo && previo.tagName === "LABEL") previo.style.display = "none";
    });
  }

  function stAplicarSelectores() {
    const st = stEstado();
    const id = st.trabajo ? st.trabajo.id : "";
    const opciones = st.ciclos.map((c) => ({ value: c.id, label: c.id + " (" + (c.estado || "") + ")" }));
    const cambiados = [];
    const filtro = document.getElementById("cicloFiltroSelect");
    const pedidos = document.getElementById("pedidoCicloSelect");
    const negociacion = document.getElementById("negUniCiclo");
    if (stFijar(filtro, id, opciones)) cambiados.push(filtro);
    if (stFijar(pedidos, id, opciones)) cambiados.push(pedidos);
    if (stForzar(negociacion, id)) cambiados.push(negociacion);
    stOcultarSelectores();
    stActualizarTarjeta();
    stActualizarAvisos();
    cambiados.forEach((s) => s.dispatchEvent(new Event("change", { bubbles: true })));
  }

  // Tras abrir cualquier pestaña, vuelve a alinear los selectores que otro código haya rearmado.
  function stReconciliar() {
    const st = stEstado();
    const id = st.trabajo ? st.trabajo.id : "";
    if (!id) return;
    ["cicloFiltroSelect", "pedidoCicloSelect", "negUniCiclo"].forEach((nombre) => {
      const s = document.getElementById(nombre);
      if (s && s.value !== id && stForzar(s, id)) s.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function stEstilos() {
    if (document.getElementById("stEstilos")) return;
    const s = document.createElement("style");
    s.id = "stEstilos";
    s.textContent =
      ".st-chip{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;margin:0 0 12px;padding:8px 12px;border-radius:8px;font-size:.86rem;border:1px solid;}" +
      ".st-ok{background:#e8f6ee;border-color:#a8d8b9;color:#1b5e36;}" +
      ".st-warn{background:#fff3d6;border-color:#f0c36b;color:#7a4b00;}" +
      ".st-chip a{color:inherit;text-decoration:underline;cursor:pointer;margin-left:auto;}" +
      ".st-sub{color:var(--ink-soft,#666);font-size:.85rem;margin:4px 0 10px;}" +
      ".st-fila{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}" +
      ".st-recep{margin-top:10px;padding:8px 12px;border-radius:8px;font-size:.86rem;border:1px solid;}" +
      ".st-recep button{margin-left:10px;}" +
      ".st-nota{margin:14px 0 6px;font-size:.85rem;color:var(--ink-soft,#666);}" +
      ".st-aviso{position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;background:#7a4b00;color:#fff;display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;font-size:.9rem;}" +
      ".st-aviso button{padding:4px 14px;border-radius:6px;border:0;cursor:pointer;font-weight:600;}";
    document.head.appendChild(s);
  }

  function stInyectarTarjeta() {
    const cargar = document.getElementById("tab-cargar");
    if (!cargar || document.getElementById("stCard")) return;
    const card = document.createElement("div");
    card.className = "card";
    card.id = "stCard";
    card.innerHTML =
      '<div style="font-weight:700;font-size:1.05rem;">Semana de trabajo</div>' +
      '<p class="st-sub">Todo el sistema muestra y usa esta semana: Comparativo, Alertas, Por Proveedor, Negociación, Pedidos y Órdenes de Compra. ' +
      'Es la misma para todos los usuarios. Cambiarla no abre ni cierra nada.</p>' +
      '<div class="st-fila"><select id="semanaTrabajoSelect" class="manual-input" style="min-width:300px;"></select>' +
      '<span id="stEstadoTxt" class="st-sub" style="margin:0;"></span></div>' +
      '<div id="stRecepTxt" class="st-recep"></div>';
    cargar.insertBefore(card, cargar.firstChild);
    document.getElementById("semanaTrabajoSelect").addEventListener("change", stAlElegir);

    const abrir = document.getElementById("btnAbrirCiclo");
    const tarjetaRecepcion = abrir && abrir.closest(".card");
    if (tarjetaRecepcion && !document.getElementById("stNotaRecep")) {
      const nota = document.createElement("div");
      nota.id = "stNotaRecep";
      nota.className = "st-nota";
      nota.textContent = "Recepción de proveedores: la semana que abres o cierras aquí es donde cargan los proveedores. " +
        "Al abrir una semana, también pasa a ser la semana de trabajo.";
      tarjetaRecepcion.parentNode.insertBefore(nota, tarjetaRecepcion);
    }
  }

  async function stAlElegir(ev) {
    const id = ev.target.value;
    if (!id) return;
    try {
      await stEstablecer(id);
      toast("Semana de trabajo: " + stEtiqueta(stEstado().trabajo));
    } catch (e) {
      toast("No se pudo cambiar la semana: " + e.message);
      try { await stCargar(); stAplicarSelectores(); } catch (e2) {}
    }
  }

  function stActualizarTarjeta() {
    const sel = document.getElementById("semanaTrabajoSelect");
    if (!sel) return;
    const st = stEstado();
    stFijar(sel, st.trabajo ? st.trabajo.id : "", st.ciclos.map((c) => ({
      value: c.id,
      label: stEtiqueta(c).replace(/ \(COT-.*\)$/, "") + " · " + c.id + " · " + (c.estado || "")
    })));
    const txt = document.getElementById("stEstadoTxt");
    if (txt) txt.textContent = st.trabajo ? "Estado: " + stEstadoDe(st.trabajo) : "";
    const rec = document.getElementById("stRecepTxt");
    if (!rec) return;
    rec.innerHTML = "";
    if (!st.trabajo) {
      rec.className = "st-recep st-warn";
      rec.textContent = "Aún no hay una semana. Abre una en la tarjeta de recepción, más abajo.";
    } else if (!st.recepcion) {
      rec.className = "st-recep st-warn";
      rec.textContent = "No hay una semana abierta para los proveedores. Ábrela más abajo.";
    } else if (stDistinta()) {
      rec.className = "st-recep st-warn";
      rec.appendChild(document.createTextNode("⚠ Los proveedores están cargando en la " + stEtiqueta(st.recepcion) + ", no en la semana de trabajo."));
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-secondary";
      b.textContent = "Ir a la semana de recepción";
      b.addEventListener("click", () => stAlElegir({ target: { value: st.recepcion.id } }));
      rec.appendChild(b);
    } else {
      rec.className = "st-recep st-ok";
      rec.textContent = "✓ Es la misma semana en la que cargan los proveedores.";
    }
  }

  const ST_TABS_CON_AVISO = ["comparativo", "alertas", "por-proveedor", "hoja-negociacion", "negociacion", "pedidos", "configuracion", "ordenes-compra"];

  function stInyectarAvisos() {
    ST_TABS_CON_AVISO.forEach((t) => {
      const seccion = document.getElementById("tab-" + t);
      if (!seccion || seccion.querySelector("[data-st-chip]")) return;
      const chip = document.createElement("div");
      chip.setAttribute("data-st-chip", "1");
      seccion.insertBefore(chip, seccion.firstChild);
    });
  }

  function stActualizarAvisos() {
    const st = stEstado();
    document.querySelectorAll("[data-st-chip]").forEach((el) => {
      el.innerHTML = "";
      el.className = "st-chip " + (stDistinta() || !st.trabajo ? "st-warn" : "st-ok");
      const t = document.createElement("span");
      if (st.trabajo) {
        const b = document.createElement("b");
        b.textContent = "Semana de trabajo: " + stEtiqueta(st.trabajo).replace(/^Semana /, "");
        t.appendChild(b);
        const e = stEstadoDe(st.trabajo);
        if (e) t.appendChild(document.createTextNode(" · " + e));
      } else {
        t.textContent = "Sin semana de trabajo. Abre una semana en «Cargar cotizaciones».";
      }
      el.appendChild(t);
      if (stDistinta()) {
        const w = document.createElement("span");
        w.textContent = "⚠ Los proveedores están cargando en la " + stEtiqueta(st.recepcion);
        el.appendChild(w);
      }
      const a = document.createElement("a");
      a.textContent = "Cambiar en «Cargar cotizaciones»";
      a.addEventListener("click", () => {
        const btn = document.querySelector('nav.tabs button[data-tab="cargar"]');
        if (btn) btn.click();
      });
      el.appendChild(a);
    });
  }

  // Si otro usuario cambia la semana, avisa y deja que tú actualices (no mueve la pantalla sola).
  function stMostrarAviso(data) {
    stEstado().pendiente = data;
    let el = document.getElementById("stAviso");
    if (!el) {
      el = document.createElement("div");
      el.id = "stAviso";
      el.className = "st-aviso";
      document.body.appendChild(el);
    }
    el.innerHTML = "";
    const t = document.createElement("span");
    t.textContent = "La semana de trabajo cambió a " + stEtiqueta(data.trabajo) + " (la cambió otro usuario).";
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Actualizar";
    b.addEventListener("click", async () => {
      el.remove();
      stEstado().pendiente = null;
      try { await stCargar(); stAplicarSelectores(); } catch (e) { toast("No se pudo actualizar la semana: " + e.message); }
    });
    el.appendChild(t);
    el.appendChild(b);
  }

  async function stRevisar() {
    if (document.hidden) return;
    try {
      const data = await (await api("/api/semana")).json();
      const st = stEstado();
      const nuevo = data.trabajo ? data.trabajo.id : null;
      const actual = st.trabajo ? st.trabajo.id : null;
      st.recepcion = data.recepcion || null;
      if (nuevo !== actual) {
        stMostrarAviso(data);
      } else {
        const aviso = document.getElementById("stAviso");
        if (aviso) aviso.remove();
        stActualizarTarjeta();
        stActualizarAvisos();
      }
    } catch (e) {}
  }

  let stIniciado = false;
  async function stIniciar() {
    if (stIniciado) return;
    stIniciado = true;
    stEstilos();
    stInyectarTarjeta();
    stInyectarAvisos();
    stOcultarSelectores();
    document.querySelectorAll("nav.tabs button[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setTimeout(stReconciliar, 250);
        setTimeout(stReconciliar, 1000);
      });
    });
    try { await stCargar(); stAplicarSelectores(); } catch (e) {}
    setInterval(stRevisar, Number(window.__ST_POLL_MS) || 20000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) stRevisar(); });
  }
  setTimeout(stIniciar, 0);
  // ===== FIN SEMANA DE TRABAJO =====

  // ===== PRODUCTOS EN PROMOCIÓN =====
  // Productos cuyo PRECIO FINAL (acordado en la negociación) bajó 15% o más frente al mejor precio de la semana anterior.
  const PROMO = { datos: null, filtro: "todas", texto: "", error: "" };

  function promoMoneda(n) {
    return n == null ? "—" : "$" + Number(n).toLocaleString("es-CO", { maximumFractionDigits: 2 });
  }

  function promoPorcentaje(n) {
    return Number(n).toLocaleString("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
  }

  function promoCiclo() {
    const st = typeof stEstado === "function" ? stEstado() : null;
    if (st && st.trabajo && st.trabajo.id) return st.trabajo.id;
    const f = document.getElementById("cicloFiltroSelect");
    return f && f.value ? f.value : "";
  }

  function promoVisible() {
    const s = document.getElementById("tab-promociones");
    return !!s && s.style.display === "block";
  }

  async function promoCargar() {
    const ciclo = promoCiclo();
    const r = await api("/api/promociones" + (ciclo ? "?ciclo=" + encodeURIComponent(ciclo) : ""));
    const d = await r.json();
    if (d && d.error) throw new Error(d.error);
    PROMO.datos = d;
    PROMO.error = "";
    return d;
  }

  function promoPintarConteo() {
    const el = document.getElementById("countPromos");
    if (!el) return;
    const n = PROMO.datos && PROMO.datos.resumen ? PROMO.datos.resumen.promociones : 0;
    el.textContent = String(n || 0);
    el.style.background = n > 0 ? "#c2410c" : "";
    el.style.color = n > 0 ? "#fff" : "";
  }

  async function promoRefrescar() {
    if (document.hidden && !promoVisible()) return;
    try {
      await promoCargar();
    } catch (e) {
      PROMO.error = e.message || "No se pudieron calcular las promociones.";
      PROMO.datos = null;
    }
    promoPintarConteo();
    if (promoVisible()) promoPintar();
  }

  async function renderPromociones() {
    await promoRefrescar();
  }

  function promoEstilos() {
    if (document.getElementById("promoEstilos")) return;
    const s = document.createElement("style");
    s.id = "promoEstilos";
    s.textContent =
      ".promo-sub{color:var(--ink-soft,#666);font-size:.85rem;margin:3px 0 0;}" +
      ".promo-cabecera{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;}" +
      ".promo-resumen{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0;}" +
      ".promo-caja{flex:1 1 150px;border:1px solid #ddd;border-radius:8px;padding:10px 12px;}" +
      ".promo-caja b{display:block;font-size:1.5rem;line-height:1.2;}" +
      ".promo-caja span{font-size:.8rem;color:var(--ink-soft,#666);}" +
      ".promo-aviso{margin:8px 0;padding:8px 12px;border-radius:8px;font-size:.88rem;border:1px solid #f0c36b;background:#fff3d6;color:#7a4b00;}" +
      ".promo-info{margin:8px 0;padding:8px 12px;border-radius:8px;font-size:.88rem;border:1px solid #ddd;background:#f6f7f8;color:#444;}" +
      ".promo-filtros{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0;}" +
      ".promo-filtros input{min-width:220px;}" +
      ".promo-tabla{width:100%;border-collapse:collapse;font-size:.88rem;}" +
      ".promo-tabla th,.promo-tabla td{padding:7px 10px;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top;}" +
      ".promo-tabla th{font-size:.78rem;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-soft,#666);}" +
      ".promo-tabla .num{text-align:right;white-space:nowrap;}" +
      ".promo-nivel{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.76rem;font-weight:700;white-space:nowrap;}" +
      ".promo-fuerte{background:#fde7d9;color:#9a3412;border:1px solid #f4b793;}" +
      ".promo-normal{background:#e8f6ee;color:#1b5e36;border:1px solid #a8d8b9;}";
    document.head.appendChild(s);
  }

  function promoFilasVisibles() {
    const d = PROMO.datos;
    if (!d) return [];
    const t = PROMO.texto.trim().toLowerCase();
    return d.filas.filter((f) => {
      if (PROMO.filtro === "fuerte" && f.nivel !== "fuerte") return false;
      if (PROMO.filtro === "promocion" && f.nivel !== "promocion") return false;
      if (!t) return true;
      return (f.producto + " " + f.codigo + " " + f.proveedor + " " + f.presentacion).toLowerCase().includes(t);
    });
  }

  function promoPintarTabla() {
    const cont = document.getElementById("promoTabla");
    if (!cont || !PROMO.datos) return;
    const filas = promoFilasVisibles();
    if (!filas.length) {
      cont.innerHTML = PROMO.datos.filas.length
        ? '<p class="promo-sub">Ningún producto coincide con el filtro.</p>'
        : "";
      return;
    }
    cont.innerHTML =
      '<div style="overflow-x:auto;"><table class="promo-tabla"><thead><tr>' +
      "<th>Nivel</th><th>Producto</th><th>Proveedor</th>" +
      '<th class="num">Precio final</th><th class="num">Mejor precio semana anterior</th><th class="num">Ahorro por unidad</th><th class="num">Baja</th>' +
      "</tr></thead><tbody>" +
      filas
        .map(
          (f) =>
            "<tr>" +
            '<td><span class="promo-nivel ' + (f.nivel === "fuerte" ? "promo-fuerte" : "promo-normal") + '">' + (f.nivel === "fuerte" ? "Promoción fuerte" : "Promoción") + "</span></td>" +
            "<td><b>" + esc(f.producto) + '</b><div class="promo-sub">Cód. ' + esc(f.codigo) + (f.presentacion ? " · " + esc(f.presentacion) : "") + "</div></td>" +
            "<td>" + esc(f.proveedor) + "</td>" +
            '<td class="num"><b>' + promoMoneda(f.precio_final) + "</b></td>" +
            '<td class="num">' + promoMoneda(f.referencia) + '<div class="promo-sub">' + esc(f.referencia_proveedor || "—") + " · " + esc(f.referencia_origen) + "</div></td>" +
            '<td class="num">' + promoMoneda(f.ahorro) + "</td>" +
            '<td class="num"><b>' + promoPorcentaje(f.baja_pct) + "</b></td>" +
            "</tr>"
        )
        .join("") +
      "</tbody></table></div>";
  }

  function promoPintar() {
    const raiz = document.getElementById("promoRaiz");
    if (!raiz) return;
    const d = PROMO.datos;
    if (!d) {
      raiz.innerHTML = '<div class="card"><p class="promo-sub">' + (PROMO.error ? esc(PROMO.error) : "Cargando…") + "</p></div>";
      return;
    }
    const r = d.resumen;
    const u = d.umbrales;
    const vigencia = d.ciclo.fecha_inicio_vigencia ? " · Vigencia: " + esc(d.ciclo.fecha_inicio_vigencia) + " al " + esc(d.ciclo.fecha_fin_vigencia || "—") : "";
    const avisos = [];
    if (!d.anterior || !d.anterior.existe) {
      avisos.push('<div class="promo-aviso">No hay una semana anterior cargada' + (d.anterior ? " (" + esc(d.anterior.id) + ")" : "") + ". Sin ella no se puede comparar.</div>");
    } else if (r.evaluados === 0) {
      avisos.push('<div class="promo-info">Todavía no hay precios finales en esta semana. Cuando cierres precios finales en Negociación (por Excel o a mano), aparecerán aquí.</div>');
    } else if (!d.filas.length) {
      avisos.push('<div class="promo-info">Ningún producto con precio final bajó ' + u.promocion + "% o más frente a la semana anterior.</div>");
    }
    if (r.sin_referencia > 0) avisos.push('<div class="promo-info">' + (r.sin_referencia === 1 ? "1 producto con precio final no tiene precio la semana anterior, así que no se puede comparar." : r.sin_referencia + " productos con precio final no tienen precio la semana anterior, así que no se pueden comparar.") + "</div>");
    if (r.sin_precio_final > 0) avisos.push('<div class="promo-info">' + (r.sin_precio_final === 1 ? "1 producto de las negociaciones de esta semana todavía no tiene precio final y no se evalúa." : r.sin_precio_final + " productos de las negociaciones de esta semana todavía no tienen precio final y no se evalúan.") + "</div>");

    const boton = (clave, texto) =>
      '<button type="button" class="' + (PROMO.filtro === clave ? "btn-primary" : "btn-secondary") + '" data-promo-filtro="' + clave + '">' + texto + "</button>";

    raiz.innerHTML =
      '<div class="card">' +
      '<div class="promo-cabecera"><div><div style="font-weight:700;font-size:1.05rem;">Productos en promoción</div>' +
      '<p class="promo-sub">Productos cuyo precio final bajó ' + u.promocion + "% o más frente al mejor precio de la semana anterior" + (d.anterior ? " (" + esc(d.anterior.id) + ")" : "") + ".</p>" +
      '<p class="promo-sub">' + esc(d.ciclo.etiqueta) + vigencia + "</p></div>" +
      '<button type="button" class="btn-primary" id="promoExportar">Exportar a Excel</button></div>' +
      '<div class="promo-resumen">' +
      '<div class="promo-caja"><b>' + r.fuertes + "</b><span>Promoción fuerte (" + u.fuerte + "% o más)</span></div>" +
      '<div class="promo-caja"><b>' + r.normales + "</b><span>Promoción (" + u.promocion + "% a menos de " + u.fuerte + "%)</span></div>" +
      '<div class="promo-caja"><b>' + r.evaluados + "</b><span>Productos con precio final evaluados</span></div>" +
      '<div class="promo-caja"><b>' + r.sin_precio_final + "</b><span>Sin precio final todavía</span></div>" +
      "</div>" +
      avisos.join("") +
      '<div class="promo-filtros">' +
      boton("todas", "Todas (" + d.filas.length + ")") + boton("fuerte", "Promoción fuerte (" + r.fuertes + ")") + boton("promocion", "Promoción (" + r.normales + ")") +
      '<input type="text" class="manual-input" id="promoBuscar" placeholder="Buscar producto, código o proveedor…" value="' + esc(PROMO.texto) + '">' +
      "</div>" +
      '<div id="promoTabla"></div>' +
      "</div>";
    promoPintarTabla();
  }

  function promoClic(e) {
    const filtro = e.target.closest && e.target.closest("[data-promo-filtro]");
    if (filtro) {
      PROMO.filtro = filtro.getAttribute("data-promo-filtro");
      promoPintar();
      return;
    }
    if (e.target.closest && e.target.closest("#promoExportar")) {
      const ciclo = promoCiclo();
      window.location.href = "/api/promociones/exportar" + (ciclo ? "?ciclo=" + encodeURIComponent(ciclo) : "");
    }
  }

  function promoEntrada(e) {
    if (e.target && e.target.id === "promoBuscar") {
      PROMO.texto = e.target.value;
      promoPintarTabla();
    }
  }

  let promoIniciado = false;
  function promoIniciar() {
    if (promoIniciado) return;
    promoIniciado = true;
    promoEstilos();
    const raiz = document.getElementById("promoRaiz");
    if (raiz) {
      raiz.addEventListener("click", promoClic);
      raiz.addEventListener("input", promoEntrada);
    }
    // Cuando cambia la semana de trabajo, se recalcula (el selector oculto avisa con "change").
    document.addEventListener("change", (e) => {
      if (e.target && e.target.id === "cicloFiltroSelect") promoRefrescar();
    });
    // Al moverte entre módulos se actualiza el número de la insignia.
    document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => {
      if (b.dataset.tab !== "promociones") b.addEventListener("click", () => setTimeout(promoRefrescar, 500));
    });
    setTimeout(promoRefrescar, 1500);
    setInterval(promoRefrescar, Number(window.__PROMO_MS) || 45000);
  }
  setTimeout(promoIniciar, 0);
  // ===== FIN PRODUCTOS EN PROMOCIÓN =====

  // ===== LOS MÁS CAROS DE LA SEMANA (recuadro en Alertas, por proveedor) =====
  // Muestra el proveedor más caro de la semana de trabajo. Al hacer clic en un proveedor se ven sus productos
  // que están por encima de la propuesta más barata de cada uno.
  const MC = { datos: null, error: "", seleccion: null, detalle: null, detalleError: "", verTodos: false, huellaResumen: "", huellaDetalle: "" };

  function mcMoneda(n) {
    return n == null ? "—" : "$" + Number(n).toLocaleString("es-CO", { maximumFractionDigits: 2 });
  }

  function mcPorcentaje(n) {
    return Number(n).toLocaleString("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
  }

  function mcCiclo() {
    const st = typeof stEstado === "function" ? stEstado() : null;
    if (st && st.trabajo && st.trabajo.id) return st.trabajo.id;
    const f = document.getElementById("cicloFiltroSelect");
    return f && f.value ? f.value : "";
  }

  function mcVisible() {
    const s = document.getElementById("tab-alertas");
    return !!s && s.style.display === "block";
  }

  async function mcCargar() {
    const ciclo = mcCiclo();
    const r = await api("/api/alertas/mas-caros" + (ciclo ? "?ciclo=" + encodeURIComponent(ciclo) : ""));
    const d = await r.json();
    if (d && d.error) throw new Error(d.error);
    MC.datos = d;
    MC.error = "";
    // Si el proveedor elegido ya no está en la lista (por ejemplo, cambió la semana), se cierra su detalle.
    if (MC.seleccion && !d.proveedores.some((p) => p.proveedor === MC.seleccion)) {
      MC.seleccion = null;
      MC.detalle = null;
    }
  }

  async function mcCargarDetalle() {
    if (!MC.seleccion) return;
    const ciclo = mcCiclo();
    const nombre = MC.seleccion;
    const r = await api("/api/alertas/mas-caros/proveedor?proveedor=" + encodeURIComponent(nombre) + (ciclo ? "&ciclo=" + encodeURIComponent(ciclo) : ""));
    const d = await r.json();
    if (nombre !== MC.seleccion) return;
    if (d && d.error) throw new Error(d.error);
    MC.detalle = d;
    MC.detalleError = "";
  }

  function mcEstilos() {
    if (document.getElementById("mcEstilos")) return;
    const s = document.createElement("style");
    s.id = "mcEstilos";
    s.textContent =
      ".mc-caja{border-left:4px solid #c2410c;}" +
      ".mc-titulo{font-weight:700;font-size:1.05rem;}" +
      ".mc-sub{color:var(--ink-soft,#666);font-size:.85rem;margin:3px 0 0;}" +
      ".mc-principal{display:block;width:100%;text-align:left;font:inherit;cursor:pointer;margin-top:12px;border:1px solid #fdba74;background:#fff7ed;border-radius:8px;padding:12px 14px;color:inherit;}" +
      ".mc-principal:hover,.mc-principal.mc-activa{border-color:#c2410c;background:#ffedd5;}" +
      ".mc-etq{font-size:.76rem;text-transform:uppercase;letter-spacing:.04em;color:#9a3412;font-weight:700;}" +
      ".mc-nombre{font-size:1.3rem;font-weight:700;margin:4px 0 2px;}" +
      ".mc-dato{font-size:.9rem;margin:3px 0;}" +
      ".mc-dato b.mc-pct{color:#c2410c;font-size:1.05rem;}" +
      ".mc-ver{margin-top:8px;font-size:.85rem;font-weight:700;color:#9a3412;}" +
      ".mc-lista{margin-top:12px;max-height:260px;overflow:auto;border:1px solid #e5e5e5;border-radius:8px;}" +
      ".mc-fila{display:flex;justify-content:space-between;gap:12px;align-items:center;width:100%;text-align:left;font:inherit;cursor:pointer;border:0;border-bottom:1px solid #eee;background:transparent;padding:8px 12px;color:inherit;}" +
      ".mc-fila:hover,.mc-fila.mc-activa{background:#fff7ed;}" +
      ".mc-fila span.mc-num{white-space:nowrap;color:var(--ink-soft,#666);font-size:.85rem;}" +
      ".mc-detalle-caja{margin-top:14px;border-top:2px solid #fdba74;padding-top:12px;}" +
      ".mc-detalle-cab{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;}" +
      ".mc-tabla{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:10px;}" +
      ".mc-tabla th,.mc-tabla td{padding:7px 10px;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top;}" +
      ".mc-tabla th{font-size:.78rem;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-soft,#666);}" +
      ".mc-tabla .num{text-align:right;white-space:nowrap;}" +
      ".mc-todos{display:inline-block;margin-top:3px;padding:1px 8px;border-radius:999px;font-size:.72rem;font-weight:700;background:#fde7d9;color:#9a3412;border:1px solid #f4b793;}" +
      ".mc-fuerte{color:#c2410c;font-weight:700;}";
    document.head.appendChild(s);
  }

  // El recuadro va justo debajo del aviso de la semana (o arriba de todo si el aviso aún no existe).
  function mcCaja() {
    const seccion = document.getElementById("tab-alertas");
    if (!seccion) return null;
    let caja = document.getElementById("mcCaja");
    if (!caja) {
      caja = document.createElement("div");
      caja.id = "mcCaja";
      caja.className = "card mc-caja";
      caja.addEventListener("click", mcClic);
      const chip = seccion.querySelector("[data-st-chip]");
      if (chip && chip.parentNode === seccion) seccion.insertBefore(caja, chip.nextSibling);
      else seccion.insertBefore(caja, seccion.firstChild);
      MC.huellaResumen = "";
      MC.huellaDetalle = "";
    }
    if (!document.getElementById("mcResumen")) {
      caja.innerHTML = '<div id="mcResumen"></div><div id="mcDetalle"></div>';
      MC.huellaResumen = "";
      MC.huellaDetalle = "";
    }
    return caja;
  }

  function mcHtmlResumen() {
    const d = MC.datos;
    const titulo = '<div class="mc-titulo">Los más caros de la semana' + (d ? " · " + esc(d.ciclo.etiqueta) : "") + "</div>";
    if (!d) return titulo + '<p class="mc-sub">' + (MC.error ? esc(MC.error) : "Cargando…") + "</p>";
    if (!d.resumen.productos_comparables) {
      return titulo + '<p class="mc-sub">Todavía no hay productos cotizados por 2 o más proveedores en esta semana, así que no hay con qué comparar.</p>';
    }
    const p = d.proveedor_mas_caro;
    if (!p) return titulo + '<p class="mc-sub">Todas las propuestas de esta semana tienen el mismo precio: no hay un proveedor más caro.</p>';
    const um = d.resumen.umbral_pct;
    const idx = d.proveedores.findIndex((x) => x.proveedor === p.proveedor);
    const activa = MC.seleccion === p.proveedor ? " mc-activa" : "";
    const principal =
      '<button type="button" class="mc-principal' + activa + '" data-mc-i="' + idx + '" aria-expanded="' + (activa ? "true" : "false") + '">' +
      '<div class="mc-etq">Proveedor más caro</div>' +
      '<div class="mc-nombre">' + esc(p.proveedor) + "</div>" +
      '<div class="mc-dato"><b class="mc-pct">+' + mcPorcentaje(p.promedio_pct) + "</b> en promedio sobre el mejor precio</div>" +
      '<div class="mc-sub">En ' + p.productos_comparados + (p.productos_comparados === 1 ? " producto comparado" : " productos comparados") +
      " · el más caro de todos en " + p.veces_mas_caro + " · " + p.productos_sobre_umbral + " con " + um + "% o más de diferencia</div>" +
      (p.pocos_productos ? '<div class="mc-sub">Pocos productos comparados (menos de ' + d.resumen.minimo_productos_proveedor + "): tómalo como referencia.</div>" : "") +
      '<div class="mc-ver">' + (activa ? "Ocultar sus productos más caros ▴" : "Ver sus productos más caros ▸") + "</div>" +
      "</button>";
    const filas = d.proveedores
      .map((x, i) =>
        '<button type="button" class="mc-fila' + (MC.seleccion === x.proveedor ? " mc-activa" : "") + '" data-mc-i="' + i + '">' +
        "<span><b>" + esc(x.proveedor) + "</b></span>" +
        '<span class="mc-num">+' + mcPorcentaje(x.promedio_pct) + " · " + x.productos_comparados + (x.productos_comparados === 1 ? " producto" : " productos") + " · " + x.productos_sobre_umbral + " con " + um + "% o más</span>" +
        "</button>"
      )
      .join("");
    return titulo + principal +
      '<div class="mc-sub" style="margin-top:12px;">Todos los proveedores (haz clic en uno para ver sus productos):</div>' +
      '<div class="mc-lista">' + filas + "</div>" +
      '<p class="mc-sub" style="margin-top:10px;">Cada propuesta se compara con la más barata del mismo producto. Solo cuentan productos con 2 o más proveedores.</p>';
  }

  function mcHtmlDetalle() {
    if (!MC.seleccion) return "";
    const nombre = esc(MC.seleccion);
    const cerrar = '<button type="button" class="btn-secondary" data-mc-cerrar="1">Cerrar</button>';
    const d = MC.detalle;
    if (!d) {
      return '<div class="mc-detalle-caja"><div class="mc-titulo">Productos más caros de ' + nombre + "</div>" +
        '<p class="mc-sub">' + (MC.detalleError ? esc(MC.detalleError) : "Cargando…") + "</p></div>";
    }
    const r = d.resumen;
    const um = d.umbral_pct;
    const cabecera = (sub, boton) =>
      '<div class="mc-detalle-cab"><div><div class="mc-titulo">Productos más caros de ' + nombre + "</div>" +
      '<div class="mc-sub">' + sub + "</div></div><div>" + (boton || "") + " " + cerrar + "</div></div>";
    if (!r.por_encima_del_mejor) {
      return '<div class="mc-detalle-caja">' + cabecera("Está al mejor precio, o empatado con el mejor, " + (r.productos_comparados === 1 ? "en el único producto que se compara." : "en los " + r.productos_comparados + " productos que se comparan."), "") + "</div>";
    }
    const mostrar = MC.verTodos ? d.productos : d.productos.filter((f) => f.sobre_umbral);
    const boton = MC.verTodos
      ? '<button type="button" class="btn-secondary" data-mc-todos="1">Ver solo los de ' + um + "% o más</button>"
      : '<button type="button" class="btn-secondary" data-mc-todos="1">Ver todos los que están por encima</button>';
    const sub = MC.verTodos
      ? "Los " + r.por_encima_del_mejor + " productos en los que está por encima del mejor precio, de mayor a menor diferencia."
      : "Mostrando " + mostrar.length + " de " + r.por_encima_del_mejor + " productos por encima del mejor precio (solo los de " + um + "% o más).";
    if (!mostrar.length) {
      return '<div class="mc-detalle-caja">' + cabecera(sub, boton) +
        '<p class="mc-sub" style="margin-top:10px;">Ningún producto de ' + nombre + " supera el " + um + "% sobre el mejor precio. Usa «Ver todos los que están por encima».</p></div>";
    }
    const filas = mostrar
      .map(
        (f) =>
          "<tr>" +
          "<td><b>" + esc(f.producto || f.codigo) + '</b><div class="mc-sub">Cód. ' + esc(f.codigo) + (f.presentacion ? " · " + esc(f.presentacion) : "") + " · " + f.proveedores + " proveedores</div>" +
          (f.mas_caro_de_todos ? '<span class="mc-todos">El más caro de todos</span>' : "") + "</td>" +
          '<td class="num"><b>' + mcMoneda(f.precio) + "</b></td>" +
          '<td class="num">' + mcMoneda(f.mejor_precio) + '<div class="mc-sub">' + esc(f.mejor_proveedor) + (f.tambien_mejor && f.tambien_mejor.length ? " (y " + f.tambien_mejor.length + " más)" : "") + "</div></td>" +
          '<td class="num">' + mcMoneda(f.diferencia) + "</td>" +
          '<td class="num ' + (f.sobre_umbral ? "mc-fuerte" : "") + '">+' + mcPorcentaje(f.diferencia_pct) + "</td>" +
          "</tr>"
      )
      .join("");
    return '<div class="mc-detalle-caja">' + cabecera(sub, boton) +
      '<div style="overflow-x:auto;"><table class="mc-tabla"><thead><tr><th>Producto</th><th class="num">Su precio</th><th class="num">Mejor precio</th><th class="num">Diferencia</th><th class="num">Más caro en</th></tr></thead><tbody>' +
      filas + "</tbody></table></div></div>";
  }

  function mcPintar() {
    if (!mcCaja()) return;
    const hr = mcHtmlResumen();
    if (hr !== MC.huellaResumen) {
      document.getElementById("mcResumen").innerHTML = hr;
      MC.huellaResumen = hr;
    }
    const hd = mcHtmlDetalle();
    if (hd !== MC.huellaDetalle) {
      document.getElementById("mcDetalle").innerHTML = hd;
      MC.huellaDetalle = hd;
    }
  }

  async function mcSeleccionar(nombre) {
    if (MC.seleccion === nombre) {
      MC.seleccion = null;
      MC.detalle = null;
      mcPintar();
      return;
    }
    MC.seleccion = nombre;
    MC.detalle = null;
    MC.detalleError = "";
    MC.verTodos = false;
    mcPintar();
    try {
      await mcCargarDetalle();
    } catch (e) {
      MC.detalleError = e.message || "No se pudieron cargar los productos de ese proveedor.";
    }
    mcPintar();
    const det = document.getElementById("mcDetalle");
    if (det && det.scrollIntoView) det.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function mcClic(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-mc-i],[data-mc-todos],[data-mc-cerrar]") : null;
    if (!el) return;
    if (el.hasAttribute("data-mc-i")) {
      const p = MC.datos && MC.datos.proveedores[Number(el.getAttribute("data-mc-i"))];
      if (p) mcSeleccionar(p.proveedor);
    } else if (el.hasAttribute("data-mc-todos")) {
      MC.verTodos = !MC.verTodos;
      mcPintar();
    } else if (el.hasAttribute("data-mc-cerrar")) {
      MC.seleccion = null;
      MC.detalle = null;
      mcPintar();
    }
  }

  async function mcRefrescar() {
    if (document.hidden) return;
    try {
      await mcCargar();
    } catch (e) {
      MC.error = e.message || "No se pudo calcular quién es el más caro.";
      MC.datos = null;
    }
    if (MC.seleccion) {
      try {
        await mcCargarDetalle();
      } catch (e) {
        MC.detalleError = e.message || "No se pudieron cargar los productos de ese proveedor.";
      }
    }
    if (mcVisible()) mcPintar();
  }

  let mcIniciado = false;
  function mcIniciar() {
    if (mcIniciado) return;
    mcIniciado = true;
    mcEstilos();
    const boton = document.querySelector('nav.tabs button[data-tab="alertas"]');
    if (boton) boton.addEventListener("click", () => { mcPintar(); setTimeout(mcRefrescar, 150); });
    // Si cambia la semana de trabajo (el selector oculto avisa con "change"), se recalcula desde cero.
    document.addEventListener("change", (e) => {
      if (e.target && e.target.id === "cicloFiltroSelect") {
        MC.datos = null;
        MC.seleccion = null;
        MC.detalle = null;
        mcRefrescar();
      }
    });
    // Si el código de Alertas vuelve a dibujar la pestaña y borra el recuadro, se vuelve a poner.
    const seccion = document.getElementById("tab-alertas");
    if (seccion && typeof MutationObserver === "function") {
      new MutationObserver(() => { if (mcVisible() && !document.getElementById("mcCaja")) mcPintar(); }).observe(seccion, { childList: true });
    }
    setInterval(() => { if (mcVisible()) mcRefrescar(); }, Number(window.__MC_MS) || 60000);
  }
  setTimeout(mcIniciar, 0);
  // ===== FIN LOS MÁS CAROS DE LA SEMANA =====

  // ---------- carga de archivos ----------
  async function uploadFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (files.length === 0) { toast("Selecciona archivos .xlsx válidos."); return; }
    {
      const st = stEstado();
      if (st.trabajo && (stTerminada(st.trabajo) || stDistinta())) {
        const aviso = "Estas cotizaciones se guardarán en la " + stEtiqueta(st.trabajo) +
          (stTerminada(st.trabajo) ? ", que ya terminó" : "") + "." +
          (stDistinta() ? "\n\nOjo: los proveedores están cargando en la " + stEtiqueta(st.recepcion) + "." : "") +
          "\n\n¿Continuar?";
        if (!confirm(aviso)) return;
      }
    }
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    { const stv = stEstado(); if (stv.trabajo) form.append("semana_trabajo", stv.trabajo.id); }
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

      await loadAvisosCiclo(ciclo.id);

    } catch (err) {
      document.getElementById("cicloFechas").textContent =
        "No se pudo cargar el ciclo activo.";
    }
  }

  // Seguimiento del aviso de semana nueva que reciben los proveedores en su portal
  async function loadAvisosCiclo(cicloId) {
    const linea = document.getElementById("cicloAvisos");
    linea.style.display = "none";
    try {
      const r = await (await api("/api/avisos-proveedores/resumen?ciclo=" + encodeURIComponent(cicloId))).json();
      if (!r.enviados) return;
      linea.textContent =
        "Aviso a proveedores: " + r.enviados + " enviados · " + r.vistos + " vistos · " +
        r.con_propuesta + " con propuesta" +
        (r.sin_usuario ? " · " + r.sin_usuario + " sin usuario del portal (no lo verán)" : "");
      linea.style.display = "";
    } catch (err) {}
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
      "¿Abrir el ciclo " + codigo + "?\n\n" +
      "Las nuevas cotizaciones quedarán guardadas en esta semana.\n" +
      "Todos los proveedores verán en su portal el aviso para enviar su propuesta."
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

      toast(
        "Ciclo " + data.ciclo.id + " abierto." +
        (data.avisos ? " Aviso enviado a " + data.avisos.proveedores + " proveedores." : "")
      );

      await loadCicloActual();
      await loadCiclosParaFiltro();

      await stEstablecer(data.ciclo.id);

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
      await stCargar();
      stAplicarSelectores();
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
    ["cargar", "comparativo", "alertas", "por-proveedor", "pedidos", "ordenes-compra", "hoja-negociacion", "promociones", "configuracion"].forEach((t) => {
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
    ["cargar", "comparativo", "alertas", "por-proveedor", "pedidos", "ordenes-compra", "hoja-negociacion", "promociones", "configuracion"].forEach((t) => {
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
  function actualizarTextosPct(p) {
    const n = Number(p);
    if (isNaN(n)) return;
    document.querySelectorAll(".js-pct").forEach((el) => { el.textContent = String(n); });
  }
  async function loadSettings() {
    const s = await (await api("/api/settings")).json();
    document.getElementById("pctSlider").value = s.contrapropuestaPct;
    document.getElementById("pctValue").textContent = s.contrapropuestaPct.toFixed(1) + "%";
    actualizarTextosPct(s.contrapropuestaPct);
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
      actualizarTextosPct(pct);
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

  // ===== SELECTOR DE PROVEEDOR (llenado manual) =====
  (function proveedorManualSelector() {
    const input = document.getElementById("manualProveedor");
    const form = document.getElementById("manualForm");
    if (!input || !form || input.dataset.provSel) return;
    input.dataset.provSel = "1";

    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative; margin-top:4px;";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.marginTop = "0";
    input.setAttribute("autocomplete", "off");
    input.placeholder = "Escribe para buscar o elige un proveedor…";

    const lista = document.createElement("div");
    lista.className = "catalogo-dropdown";
    lista.id = "manualProveedorLista";
    lista.style.cssText = "display:none; position:absolute; left:0; right:0; top:100%; z-index:60; max-height:260px; overflow-y:auto;";
    wrap.appendChild(lista);
    const aviso = document.createElement("div");
    aviso.id = "manualProveedorAviso";
    aviso.style.cssText = "font-size:0.75rem; margin-top:4px; min-height:1.1em;";
    wrap.parentNode.insertBefore(aviso, wrap.nextSibling);

    let nombres = [];
    let visibles = [];
    let activo = -1;

    const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
    const h = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    async function cargar() {
      try {
        const d = await (await api("/api/proveedores")).json();
        if (Array.isArray(d)) nombres = d.map(String).sort((a, b) => a.localeCompare(b, "es"));
      } catch (e) { /* si falla, el formulario sigue funcionando como antes */ }
    }
    function filtrar(q) {
      const toks = norm(q).split(" ").filter(Boolean);
      return nombres.filter((n) => { const nn = norm(n); return toks.every((t) => nn.includes(t)); }).slice(0, 80);
    }
    function pintar() {
      visibles = filtrar(input.value);
      if (!visibles.length) {
        lista.innerHTML = '<div class="catalogo-item" style="cursor:default;color:var(--ink-soft);">' +
          (nombres.length ? "Sin coincidencias. Si es un proveedor nuevo, se creará al guardar." : "No se pudo cargar la lista de proveedores.") + "</div>";
      } else {
        lista.innerHTML = visibles.map((n, i) =>
          '<div class="catalogo-item" data-i="' + i + '"' + (i === activo ? ' style="background:rgba(0,0,0,0.07);"' : "") + ">" + h(n) + "</div>").join("");
      }
      lista.style.display = "block";
      const a = lista.querySelector('[data-i="' + activo + '"]');
      if (a && a.scrollIntoView) a.scrollIntoView({ block: "nearest" });
    }
    function cerrar() { lista.style.display = "none"; activo = -1; }
    function evaluar() {
      const v = input.value.trim();
      if (!v) { aviso.textContent = ""; return { existe: false, vacio: true }; }
      const ex = nombres.find((n) => norm(n) === norm(v));
      if (ex) { aviso.style.color = "var(--ok, #2e7d32)"; aviso.textContent = "✓ Proveedor registrado"; return { existe: true, nombre: ex }; }
      if (nombres.length) { aviso.style.color = "var(--warn, #b26a00)"; aviso.textContent = "⚠ Este proveedor no está en la tabla: se creará como nuevo al guardar."; }
      else aviso.textContent = "";
      return { existe: false };
    }
    function completar() {
      const v = input.value.trim();
      if (!v) return;
      const ex = nombres.find((n) => norm(n) === norm(v));
      if (ex) { input.value = ex; return; }
      const nv = norm(v);
      const c = nombres.filter((n) => norm(n).startsWith(nv));
      if (nv.length >= 3 && c.length === 1) { input.value = c[0]; }
    }
    function elegir(n) {
      input.value = n; cerrar(); evaluar();
      const sem = document.getElementById("manualSemana");
      if (sem && !sem.value) sem.focus();
    }

    input.addEventListener("focus", async () => { await cargar(); pintar(); evaluar(); });
    input.addEventListener("input", () => { activo = -1; pintar(); evaluar(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (lista.style.display === "none") pintar(); activo = Math.min(visibles.length - 1, activo + 1); pintar(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activo = Math.max(0, activo - 1); pintar(); }
      else if (e.key === "Enter") {
        if (lista.style.display !== "none" && visibles.length && (activo >= 0 || visibles.length === 1)) { e.preventDefault(); elegir(visibles[activo >= 0 ? activo : 0]); }
      }
      else if (e.key === "Escape") { cerrar(); }
    });
    input.addEventListener("blur", () => { setTimeout(() => { cerrar(); const antes = input.value; completar(); evaluar(); if (input.value !== antes) { aviso.style.color = "var(--ok, #2e7d32)"; aviso.textContent = "✓ Se completó con el proveedor registrado"; } }, 150); });
    lista.addEventListener("mousedown", (e) => {
      const it = e.target.closest("[data-i]");
      if (!it) return;
      e.preventDefault();
      elegir(visibles[Number(it.dataset.i)]);
    });

    // Antes de guardar: si el proveedor no está en la tabla, pedir confirmación (evita duplicados por error de escritura).
    form.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("#btnSaveManual");
      if (!btn) return;
      completar();
      const v = input.value.trim();
      const r = evaluar();
      if (v && !r.existe && nombres.length &&
          !confirm("«" + v.toUpperCase() + "» no está en la tabla de proveedores.\n\n¿Crearlo como proveedor nuevo?\n(Si fue un error al escribir, cancela y elígelo de la lista.)")) {
        e.stopPropagation(); e.preventDefault();
        return;
      }
      setTimeout(async () => { await cargar(); evaluar(); }, 1500);
    }, true);
    document.getElementById("btnToggleManual").addEventListener("click", () => { cargar(); });
    cargar();
  })();

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
    try {
      await stCargar();
      stAplicarSelectores();
    } catch (err) {
      toast("No se pudieron cargar los ciclos: " + err.message);
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

      /*refresca-distribucion-tras-demanda*/
      try {
        if (typeof cargarPedidoPct === "function") await cargarPedidoPct();
        else if (window.cargarPedidoPct) await window.cargarPedidoPct();
      } catch (e2) { console.error("No se pudo refrescar la distribución", e2); }


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
      ["cargar", "comparativo", "alertas", "por-proveedor", "pedidos", "ordenes-compra", "hoja-negociacion", "promociones", "configuracion"].forEach((t) => {
        document.getElementById("tab-" + t).style.display = t === btn.dataset.tab ? "block" : "none";
      });
      if (btn.dataset.tab === "alertas") await renderAlertas();
      if (btn.dataset.tab === "por-proveedor") await loadProveedoresSelect();
      if (btn.dataset.tab === "pedidos") await renderPedidos(); try { if (window.ocCargarResumen) await window.ocCargarResumen(); } catch (e) { console.error(e); }
      if (btn.dataset.tab === "configuracion") { await cargarLogoCorporativo(); await loadProveedoresTabla(); await loadCatalogoTabla(); await loadCiclosTabla(); }
      if (btn.dataset.tab === "ordenes-compra") await renderOrdenesCompra();
      if (btn.dataset.tab === "hoja-negociacion") await renderHojaNegociacion();
      if (btn.dataset.tab === "promociones") await renderPromociones();
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
    if (false /* la semana ya no se restaura del navegador: manda la semana de trabajo del sistema */ && ultima.ciclo && cicloFiltroRecordar) {

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

      mostrarErroresArchivoPct(err.message);


    } finally {

      e.target.value =
        "";
    }
  }


  function mostrarErroresArchivoPct(msg) {
    const lineas = String(msg || "").split("\n");
    if (lineas.length < 2) { toast("No se pudo cargar: " + msg); return; }
    const previo = document.getElementById("errArchivoPctOverlay");
    if (previo) previo.remove();
    const ov = document.createElement("div");
    ov.id = "errArchivoPctOverlay";
    ov.setAttribute("style", "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;");
    const box = document.createElement("div");
    box.setAttribute("style", "background:#fff;color:#222;border-radius:10px;max-width:680px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.35);");
    const h = document.createElement("div");
    h.setAttribute("style", "background:#b3261e;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px;");
    h.textContent = "No se cargó el archivo de distribución";
    const sub = document.createElement("div");
    sub.setAttribute("style", "padding:12px 18px 4px;font-size:14px;");
    sub.textContent = lineas[0];
    const cuerpo = document.createElement("div");
    cuerpo.setAttribute("style", "padding:4px 18px 12px;overflow:auto;font-size:13px;line-height:1.5;");
    lineas.slice(1).forEach(function (l) {
      const d = document.createElement("div");
      d.setAttribute("style", "padding:5px 0;border-bottom:1px solid #eee;");
      d.textContent = l;
      cuerpo.appendChild(d);
    });
    const pie = document.createElement("div");
    pie.setAttribute("style", "padding:10px 18px 14px;text-align:right;border-top:1px solid #eee;");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Entendido";
    b.setAttribute("style", "background:#b3261e;color:#fff;border:0;border-radius:6px;padding:8px 18px;font-size:14px;cursor:pointer;");
    b.onclick = function () { ov.remove(); };
    pie.appendChild(b);
    box.appendChild(h); box.appendChild(sub); box.appendChild(cuerpo); box.appendChild(pie);
    ov.appendChild(box);
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }

  // ===== Órdenes de compra por proveedor (paso 4): cuadro de proveedores, vista previa, PDF y numeración =====
  /*oc-cuadro-proveedores*/
  function ocEsc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function ocSeleccion() {
    return {
      ciclo: (document.getElementById("pedidoCicloSelect") || {}).value || "",
      periodo: (document.getElementById("pedidoPeriodoSelect") || {}).value || "LUNES-MARTES"
    };
  }

  function ocModal(titulo, color, cuerpo, botones) {
    const previo = document.getElementById("ocModalOverlay");
    if (previo) previo.remove();
    const ov = document.createElement("div");
    ov.id = "ocModalOverlay";
    ov.setAttribute("style", "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;");
    const box = document.createElement("div");
    box.setAttribute("style", "background:#fff;color:#222;border-radius:10px;max-width:560px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.35);");
    const h = document.createElement("div");
    h.setAttribute("style", "background:" + color + ";color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px;");
    h.textContent = titulo;
    const c = document.createElement("div");
    c.setAttribute("style", "padding:14px 18px;overflow:auto;font-size:14px;line-height:1.5;");
    if (typeof cuerpo === "string") c.textContent = cuerpo; else c.appendChild(cuerpo);
    const pie = document.createElement("div");
    pie.setAttribute("style", "padding:10px 18px 14px;text-align:right;border-top:1px solid #eee;display:flex;gap:8px;justify-content:flex-end;");
    botones.forEach(function (b) {
      const bt = document.createElement("button");
      bt.type = "button";
      bt.textContent = b.texto;
      bt.setAttribute("style", "border:0;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer;" + (b.primario ? "background:" + color + ";color:#fff;" : "background:#e8e8e8;color:#222;"));
      bt.onclick = function () { if (b.accion) { const r = b.accion(); if (r === false) return; } ov.remove(); };
      pie.appendChild(bt);
    });
    box.appendChild(h); box.appendChild(c); box.appendChild(pie);
    ov.appendChild(box);
    document.body.appendChild(ov);
    return ov;
  }

  const OC = { proveedor: "", proveedores: [] };

  async function ocCargarResumen() {
    const box = document.getElementById("ocProveedoresBox");
    if (!box) return;
    const { ciclo, periodo } = ocSeleccion();
    if (!ciclo) { box.innerHTML = '<p style="color:var(--ink-soft);font-size:0.85rem;">Selecciona el ciclo para ver los proveedores.</p>'; return; }
    try {
      const res = await api("/api/ordenes-compra/resumen?ciclo_id=" + encodeURIComponent(ciclo) + "&periodo=" + encodeURIComponent(periodo));
      OC.proveedores = await res.json();
    } catch (err) {
      box.innerHTML = '<p style="color:#b3261e;font-size:0.85rem;">No se pudo cargar el cuadro de proveedores: ' + ocEsc(err.message) + "</p>";
      return;
    }
    ocPintarResumen();
  }

  function ocPintarResumen() {
    const box = document.getElementById("ocProveedoresBox");
    if (!box) return;
    const filas = OC.proveedores;
    if (!filas.length) {
      box.innerHTML = '<p style="color:var(--ink-soft);font-size:0.85rem;">Todavía no hay pedido asignado a proveedores en este ciclo. Aplica la distribución primero.</p>';
      return;
    }
    const badge = function (p) {
      if (p.estado === "emitida") return '<span style="background:#1F4E79;color:#fff;border-radius:10px;padding:2px 8px;font-size:12px;">OC emitida</span>';
      if (p.estado === "faltan_precios") return '<span style="background:#e67e22;color:#fff;border-radius:10px;padding:2px 8px;font-size:12px;">Faltan ' + p.sin_precio + " precio(s)</span>";
      return '<span style="background:#1C8B3C;color:#fff;border-radius:10px;padding:2px 8px;font-size:12px;">Listo para OC</span>';
    };
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<strong style="font-size:0.9rem;">Proveedores del pedido (' + filas.length + ") · clic en uno para ver su pedido preliminar</strong>" +
      '<button class="btn-secondary" id="ocBtnActualizar" type="button">↻ Actualizar</button></div>' +
      '<div class="table-scroll" style="max-height:320px;overflow:auto;"><table><thead><tr>' +
      "<th>#</th><th>Proveedor</th><th>Productos</th><th>Total estimado</th><th>Estado</th><th>Orden(es)</th></tr></thead><tbody>" +
      filas.map(function (p, i) {
        const sel = p.proveedor === OC.proveedor;
        return '<tr class="oc-fila" data-prov="' + ocEsc(p.proveedor) + '" style="cursor:pointer;' + (sel ? "background:#e8f0fa;" : "") + '">' +
          "<td>" + (i + 1) + "</td><td><strong>" + ocEsc(p.proveedor) + "</strong></td><td>" + p.productos + "</td>" +
          "<td>" + (p.estado === "emitida" ? "—" : fmtMoney(p.total_estimado)) + "</td><td>" + badge(p) + "</td>" +
          "<td>" + (p.ordenes.length ? p.ordenes.map(function (o) { return ocEsc(o.numero); }).join(", ") : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  async function ocVerPrevia(proveedor) {
    OC.proveedor = proveedor;
    const sel = document.getElementById("pedidoProveedorSelect");
    if (sel && [...sel.options].some(function (o) { return o.value === proveedor; })) sel.value = proveedor;
    ocPintarResumen();
    const cont = document.getElementById("ocPreviaBox");
    if (!cont) return;
    const { ciclo, periodo } = ocSeleccion();
    let d;
    try {
      const res = await api("/api/ordenes-compra/preliminar?ciclo_id=" + encodeURIComponent(ciclo) + "&periodo=" + encodeURIComponent(periodo) + "&proveedor=" + encodeURIComponent(proveedor));
      d = await res.json();
    } catch (err) { toast("No se pudo cargar el pedido: " + err.message); return; }

    let html = '<div style="border:1px solid #cfd8e3;border-radius:8px;padding:12px;margin-top:12px;">' +
      '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center;">' +
      "<strong>Pedido preliminar · " + ocEsc(d.proveedor) + "</strong>" +
      "<span>" + d.items.length + " productos · Total: <strong>" + fmtMoney(d.total) + "</strong></span></div>";
    if (d.items.length) {
      html += '<div class="table-scroll" style="margin-top:8px;max-height:340px;overflow:auto;"><table><thead><tr>' +
        "<th>PLU</th><th>Producto</th><th>Presentación</th><th>Pedido</th><th>Precio final negociado</th><th>Total</th></tr></thead><tbody>" +
        d.items.map(function (it) {
          return "<tr><td>" + ocEsc(it.codigo) + "</td><td>" + ocEsc(it.producto) + "</td><td>" + ocEsc(it.presentacion) + "</td><td>" + it.pedido + "</td>" +
            (it.falta_precio
              ? '<td style="color:#b3261e;font-weight:600;">Sin precio negociado</td><td>—</td>'
              : "<td>" + fmtMoney(it.precio) + "</td><td>" + fmtMoney(it.total) + "</td>") + "</tr>";
        }).join("") + "</tbody></table></div>";
      if (d.sin_precio) html += '<p style="color:#b3261e;font-size:0.85rem;margin:8px 0 0;">Faltan ' + d.sin_precio + " producto(s) sin precio final negociado. Cierra su negociación para poder generar la orden.</p>";
      html += '<div style="margin-top:10px;"><button class="btn-primary" id="ocBtnGenerarPanel" type="button"' + (d.listo ? "" : " disabled") + ">🧾 Generar orden de compra</button></div>";
    } else {
      html += '<p style="color:var(--ink-soft);font-size:0.85rem;margin:8px 0 0;">No hay productos pendientes de orden de compra para este proveedor.</p>';
    }
    if (d.ordenes.length) {
      html += '<div style="margin-top:10px;font-size:0.85rem;"><strong>Órdenes ya emitidas:</strong> ' +
        d.ordenes.map(function (o) { return '<a href="/api/ordenes-compra/' + o.id + '/pdf">' + ocEsc(o.numero) + " ⬇ PDF</a>"; }).join(" · ") + "</div>";
    }
    cont.innerHTML = html + "</div>";
  }

  async function ocGenerar(proveedor) {
    if (!proveedor) { toast("Selecciona un proveedor del cuadro."); return; }
    const { ciclo, periodo } = ocSeleccion();
    if (!ciclo) { toast("Selecciona el ciclo."); return; }
    let prev, cfg;
    try {
      prev = await (await api("/api/ordenes-compra/preliminar?ciclo_id=" + encodeURIComponent(ciclo) + "&periodo=" + encodeURIComponent(periodo) + "&proveedor=" + encodeURIComponent(proveedor))).json();
      cfg = await (await api("/api/ordenes-compra/config")).json();
    } catch (err) { toast(err.message); return; }
    if (!prev.items.length) { ocModal("Sin pedido pendiente", "#1F4E79", "Este proveedor no tiene productos pendientes de orden de compra.", [{ texto: "Entendido", primario: true }]); return; }
    if (!prev.listo) {
      const faltan = prev.items.filter(function (i) { return i.falta_precio; }).map(function (i) { return i.codigo + " " + i.producto; });
      ocModal("No se puede generar la orden", "#b3261e", "Faltan precios finales negociados de " + prev.proveedor + ":\n" + faltan.join("\n"), [{ texto: "Entendido", primario: true }]);
      return;
    }
    const texto = "Se generará la orden " + cfg.prefijo + cfg.siguiente + " para " + prev.proveedor + " (" + prev.items.length + " productos, total " + fmtMoney(prev.total) + "). El número queda consumido. ¿Continuar?";
    const cuerpo = document.createElement("div"); cuerpo.textContent = texto;
    ocModal("Generar orden de compra", "#1C8B3C", cuerpo, [
      { texto: "Cancelar" },
      { texto: "Generar y descargar PDF", primario: true, accion: function () { ocConfirmarGenerar(proveedor, ciclo, periodo); } }
    ]);
  }

  async function ocConfirmarGenerar(proveedor, ciclo, periodo) {
    try {
      const res = await api("/api/ordenes-compra/generar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ciclo_id: ciclo, periodo: periodo, proveedor: proveedor }) });
      const data = await res.json();
      toast("Orden " + data.orden.numero + " generada.");
      window.location.href = "/api/ordenes-compra/" + data.orden.id + "/pdf";
      await ocCargarResumen();
      await ocVerPrevia(proveedor);
    } catch (err) {
      ocModal("No se pudo generar la orden", "#b3261e", err.message, [{ texto: "Entendido", primario: true }]);
    }
  }

  async function ocConfigNumeracion() {
    let cfg;
    try { cfg = await (await api("/api/ordenes-compra/config")).json(); } catch (err) { toast(err.message); return; }
    const cuerpo = document.createElement("div");
    const info = document.createElement("p");
    info.setAttribute("style", "margin:0 0 10px;");
    info.textContent = "La próxima orden saldrá como " + cfg.prefijo + cfg.siguiente + (cfg.ultimo_emitido ? " (última emitida: " + cfg.prefijo + cfg.ultimo_emitido + ")." : ".");
    const lbl = document.createElement("label");
    lbl.textContent = "Número inicial (de " + cfg.minimo + " a " + cfg.maximo + "): ";
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = cfg.minimo; inp.max = cfg.maximo; inp.value = cfg.siguiente; inp.className = "manual-input"; inp.setAttribute("style", "width:120px;");
    const msg = document.createElement("p");
    msg.setAttribute("style", "color:#b3261e;margin:8px 0 0;min-height:1.2em;");
    cuerpo.appendChild(info); lbl.appendChild(inp); cuerpo.appendChild(lbl); cuerpo.appendChild(msg);
    ocModal("Numeración de órdenes de compra", "#1F4E79", cuerpo, [
      { texto: "Cancelar" },
      { texto: "Guardar", primario: true, accion: function () {
        const n = Number(inp.value);
        if (!Number.isInteger(n) || n < cfg.minimo || n > cfg.maximo) { msg.textContent = "Escribe un entero entre " + cfg.minimo + " y " + cfg.maximo + "."; return false; }
        api("/api/ordenes-compra/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inicio: n }) })
          .then(function (r) { return r.json(); })
          .then(function (c) { toast("Próxima orden: " + c.prefijo + c.siguiente); })
          .catch(function (err) { ocModal("No se pudo guardar", "#b3261e", err.message, [{ texto: "Entendido", primario: true }]); });
      } }
    ]);
  }

  (function ocConectar() {
    const caja = document.getElementById("ocProveedoresBox");
    if (caja) {
      caja.addEventListener("click", function (e) {
        if (e.target.closest("#ocBtnActualizar")) { ocCargarResumen(); return; }
        const fila = e.target.closest(".oc-fila");
        if (fila) ocVerPrevia(fila.getAttribute("data-prov"));
      });
    }
    const prev = document.getElementById("ocPreviaBox");
    if (prev) prev.addEventListener("click", function (e) { if (e.target.closest("#ocBtnGenerarPanel")) ocGenerar(OC.proveedor); });
    const bg = document.getElementById("btnGenerarOC");
    if (bg) bg.addEventListener("click", function () {
      const sel = document.getElementById("pedidoProveedorSelect");
      ocGenerar((sel && sel.value) || OC.proveedor);
    });
    const bc = document.getElementById("btnConfigNumeracionOC");
    if (bc) bc.addEventListener("click", ocConfigNumeracion);
    ["pedidoCicloSelect", "pedidoPeriodoSelect"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", function () { OC.proveedor = ""; const p = document.getElementById("ocPreviaBox"); if (p) p.innerHTML = ""; ocCargarResumen(); });
    });
  })();
  window.ocCargarResumen = ocCargarResumen;

  // ===== Indicadores de compra: compra por proveedor y evolución de precios =====
  /*indicadores-compra-ui*/
  (function indicadoresCompra() {
    const raiz = document.getElementById("indRaiz");
    const boton = document.querySelector('button[data-tab="indicadores-compra"]');
    const seccion = document.getElementById("tab-indicadores-compra");
    if (!raiz || !boton || !seccion) return;
    const E = { cargado: false, ciclos: [], periodos: {}, datos: null, filtro: "", tipo: "todos" };
    const esc = function (v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };
    const money = function (n) { return n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CO"); };
    const pct = function (n, signo) { if (n == null) return "—"; return (signo && n > 0 ? "+" : "") + n.toFixed(1).replace(".", ",") + "%"; };
    const COL_ALZA = "#b3261e", COL_BAJA = "#1C8B3C", AZUL = "#1F4E79";

    function sel() { return { ciclo: (document.getElementById("indCiclo") || {}).value || "", periodo: (document.getElementById("indPeriodo") || {}).value || "" }; }

    function esqueleto() {
      raiz.innerHTML =
        '<div class="card"><p class="section-title">Indicadores de gestión de compra</p>' +
        '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-top:8px;">' +
        '<label style="font-size:0.85rem;">Semana (ciclo)<br><select id="indCiclo" class="manual-input"></select></label>' +
        '<label style="font-size:0.85rem;">Periodo del pedido<br><select id="indPeriodo" class="manual-input"></select></label>' +
        '<button class="btn-secondary" id="indActualizar" type="button">↻ Actualizar</button>' +
        '<button class="btn-primary" id="indExcel" type="button">⬇ Descargar Excel</button></div>' +
        '<div id="indTiles"></div></div>' +
        '<div class="card" id="indCompra"></div><div class="card" id="indPrecios"></div>';
      document.getElementById("indActualizar").addEventListener("click", cargar);
      document.getElementById("indCiclo").addEventListener("change", function () { llenarPeriodos(); cargar(); });
      document.getElementById("indPeriodo").addEventListener("change", cargar);
      document.getElementById("indExcel").addEventListener("click", function () {
        const s = sel();
        if (!s.ciclo) { toast("Selecciona el ciclo."); return; }
        window.location.href = "/api/indicadores-compra/excel?ciclo_id=" + encodeURIComponent(s.ciclo) + "&periodo=" + encodeURIComponent(s.periodo);
      });
    }

    function llenarPeriodos() {
      const c = document.getElementById("indCiclo").value;
      const ps = E.periodos[c] || [];
      document.getElementById("indPeriodo").innerHTML = '<option value="">Todos los periodos</option>' + ps.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + "</option>"; }).join("");
    }

    async function iniciar() {
      esqueleto();
      try {
        const r = await api("/api/indicadores-compra/ciclos");
        const d = await r.json();
        E.ciclos = d.ciclos; E.periodos = d.periodos;
        document.getElementById("indCiclo").innerHTML = d.ciclos.slice().reverse().map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + "</option>"; }).join("");
        if (d.sugerido) document.getElementById("indCiclo").value = d.sugerido;
        llenarPeriodos();
        E.cargado = true;
      } catch (err) { raiz.innerHTML = '<div class="card" style="color:#b3261e;">No se pudo cargar: ' + esc(err.message) + "</div>"; return; }
      await cargar();
    }

    async function cargar() {
      const s = sel();
      if (!s.ciclo) { document.getElementById("indTiles").innerHTML = '<p style="color:var(--ink-soft);">No hay ciclos cargados todavía.</p>'; return; }
      try {
        const r = await api("/api/indicadores-compra?ciclo_id=" + encodeURIComponent(s.ciclo) + "&periodo=" + encodeURIComponent(s.periodo));
        E.datos = await r.json();
      } catch (err) { toast("No se pudieron calcular los indicadores: " + err.message); return; }
      pintar();
    }

    function tile(titulo, valor, nota, color) {
      return '<div style="border:1px solid #d9e1ea;border-radius:8px;padding:10px 12px;min-width:150px;flex:1;">' +
        '<div style="font-size:0.75rem;color:#555;">' + titulo + '</div><div style="font-size:1.35rem;font-weight:700;color:' + (color || "#222") + ';">' + valor + "</div>" +
        '<div style="font-size:0.75rem;color:#555;min-height:1em;">' + (nota || "") + "</div></div>";
    }
    function flecha(v) { return v == null ? "" : v > 0.005 ? "▲ " : v < -0.005 ? "▼ " : "= "; }
    function colorVar(v) { return v == null || Math.abs(v) <= 0.005 ? "#555" : v > 0 ? COL_ALZA : COL_BAJA; }

    function pintar() {
      const d = E.datos, c = d.compra, p = d.precios;
      document.getElementById("indTiles").innerHTML =
        '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;">' +
        tile("Compra total " + esc(d.ciclo), c.hay_pedido ? money(c.total) : "—", c.hay_pedido && c.var_total_pct != null ? '<span style="color:' + colorVar(c.var_total_pct) + ';">' + flecha(c.var_total_pct) + pct(c.var_total_pct, true) + "</span> vs " + esc(c.ciclo_previo) : "") +
        tile("Proveedores con pedido", c.hay_pedido ? c.n_proveedores : "—", c.hay_pedido ? "Top 3 concentran " + pct(c.top3_pct) : "") +
        tile("Líneas con precio final", c.hay_pedido ? c.pct_precio_final + "%" : "—", c.hay_pedido ? "El resto usa el precio de la distribución" : "") +
        tile("Precios al alza", p.resumen.alzas, "de " + p.cobertura.comparables + " comparables", p.resumen.alzas ? COL_ALZA : "") +
        tile("Precios a la baja", p.resumen.bajas, "vs " + esc(p.ciclo_previo || "—"), p.resumen.bajas ? COL_BAJA : "") +
        "</div>";
      pintarCompra(); pintarPrecios();
    }

    function pintarCompra() {
      const c = E.datos.compra, cont = document.getElementById("indCompra");
      let h = '<p class="section-title">1. Compra por proveedor</p>';
      if (!c.hay_pedido) {
        cont.innerHTML = h + '<p style="color:var(--ink-soft);font-size:0.85rem;">Todavía no hay pedido distribuido para ' + esc(E.datos.ciclo) + ". Carga la demanda y la distribución en Pedidos y pulsa Aplicar para ver este cuadro.</p>";
        return;
      }
      const maxv = Math.max.apply(null, c.proveedores.map(function (x) { return x.valor; })) || 1;
      h += '<p style="font-size:0.8rem;color:#555;margin:4px 0 8px;">Valor = cantidad asignada × precio final negociado. Comparado con ' + esc(c.ciclo_previo || "—") + (c.ciclo_previo ? "" : " (no hay semana anterior con pedido)") + ". Concentración (HHI): " + c.hhi + ".</p>";
      h += '<div class="table-scroll" style="max-height:460px;overflow:auto;"><table><thead><tr><th>#</th><th>Proveedor</th><th>Productos</th><th style="min-width:220px;">Valor comprado</th><th>% part.</th><th>Semana anterior</th><th>Var.</th><th>Precio final</th></tr></thead><tbody>';
      c.proveedores.forEach(function (x, i) {
        h += "<tr><td>" + (i + 1) + "</td><td><strong>" + esc(x.proveedor) + "</strong></td><td>" + x.productos + "</td>" +
          '<td><div style="display:flex;align-items:center;gap:8px;"><div style="background:#e8eef5;border-radius:3px;flex:1;height:10px;"><div style="background:' + AZUL + ";width:" + Math.max(2, Math.round((x.valor / maxv) * 100)) + '%;height:10px;border-radius:3px;"></div></div><span style="min-width:84px;text-align:right;">' + money(x.valor) + "</span></div></td>" +
          "<td>" + pct(x.pct) + "</td><td>" + money(x.valor_previo) + '</td><td style="color:' + colorVar(x.pct_var) + ';">' + flecha(x.pct_var) + pct(x.pct_var, true) + "</td>" +
          '<td style="color:' + (x.pct_final < 100 ? "#e67e22" : "#1C8B3C") + ';">' + x.pct_final + "%</td></tr>";
      });
      cont.innerHTML = h + "</tbody></table></div>";
    }

    function spark(serie) {
      const pts = serie.map(function (v, i) { return v == null ? null : { i: i, v: v }; }).filter(Boolean);
      if (pts.length < 2) return '<span style="color:#999;">—</span>';
      const w = 92, hgt = 24, mn = Math.min.apply(null, pts.map(function (q) { return q.v; })), mx = Math.max.apply(null, pts.map(function (q) { return q.v; }));
      const x = function (i) { return 3 + (i / Math.max(1, serie.length - 1)) * (w - 6); };
      const y = function (v) { return mx === mn ? hgt / 2 : 3 + (1 - (v - mn) / (mx - mn)) * (hgt - 6); };
      const ult = pts[pts.length - 1];
      return '<svg width="' + w + '" height="' + hgt + '" viewBox="0 0 ' + w + " " + hgt + '" role="img" aria-label="Tendencia"><polyline fill="none" stroke="' + AZUL + '" stroke-width="1.6" points="' +
        pts.map(function (q) { return x(q.i).toFixed(1) + "," + y(q.v).toFixed(1); }).join(" ") + '"/><circle cx="' + x(ult.i).toFixed(1) + '" cy="' + y(ult.v).toFixed(1) + '" r="2.5" fill="' + AZUL + '"/></svg>';
    }

    function pintarPrecios() {
      const p = E.datos.precios, cont = document.getElementById("indPrecios");
      let h = '<p class="section-title">2. Evolución de precios (precio final negociado, promedio entre proveedores)</p>';
      if (!p.cobertura.con_precio) {
        cont.innerHTML = h + '<p style="color:var(--ink-soft);font-size:0.85rem;">' + esc(E.datos.ciclo) + " no tiene precios finales negociados todavía.</p>";
        return;
      }
      h += '<p style="font-size:0.8rem;color:#555;margin:4px 0 8px;">' + p.cobertura.con_precio + " productos con precio final; " + p.cobertura.comparables + " comparables con " + esc(p.ciclo_previo || "—") + (p.ciclo_previo ? "" : " (no hay semana anterior con precios)") + ". La tendencia muestra las últimas " + p.ventana.length + " semanas (" + esc(p.ventana[0]) + " → " + esc(p.ventana[p.ventana.length - 1]) + ").</p>" +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;"><input id="indBuscar" class="manual-input" type="search" placeholder="Buscar PLU o producto" value="' + esc(E.filtro) + '" style="min-width:220px;">' +
        '<select id="indTipo" class="manual-input"><option value="todos">Todos</option><option value="alza">Solo alzas</option><option value="baja">Solo bajas</option><option value="igual">Sin cambio</option></select></div>' +
        '<div class="table-scroll" style="max-height:520px;overflow:auto;"><table><thead><tr><th>PLU</th><th>Producto</th><th>Presentación</th><th>' + esc(p.ciclo_previo || "Anterior") + "</th><th>" + esc(E.datos.ciclo) + '</th><th>Dif. $</th><th>Var. %</th><th>Mínimo</th><th>Tendencia</th></tr></thead><tbody id="indFilasPrecios"></tbody></table></div>';
      cont.innerHTML = h;
      document.getElementById("indTipo").value = E.tipo;
      document.getElementById("indBuscar").addEventListener("input", function (e) { E.filtro = e.target.value; filasPrecios(); });
      document.getElementById("indTipo").addEventListener("change", function (e) { E.tipo = e.target.value; filasPrecios(); });
      filasPrecios();
    }

    function filasPrecios() {
      const q = E.filtro.trim().toLowerCase();
      const filas = E.datos.precios.filas.filter(function (f) {
        if (q && (f.codigo + " " + f.producto).toLowerCase().indexOf(q) < 0) return false;
        if (E.tipo === "alza") return f.pct != null && f.pct > 0.005;
        if (E.tipo === "baja") return f.pct != null && f.pct < -0.005;
        if (E.tipo === "igual") return f.pct != null && Math.abs(f.pct) <= 0.005;
        return true;
      });
      document.getElementById("indFilasPrecios").innerHTML = filas.length ? filas.map(function (f) {
        return "<tr><td>" + esc(f.codigo) + "</td><td>" + esc(f.producto) + "</td><td>" + esc(f.presentacion) + "</td><td>" + money(f.prom_previo) + "</td><td><strong>" + money(f.prom_actual) + "</strong></td>" +
          '<td style="color:' + colorVar(f.pct) + ';">' + (f.dif == null ? "—" : (f.dif > 0 ? "+" : "") + money(f.dif)) + '</td><td style="color:' + colorVar(f.pct) + ';font-weight:600;">' + flecha(f.pct) + pct(f.pct, true) + "</td>" +
          '<td title="' + esc(f.prov_min) + '">' + money(f.minimo) + '<div style="font-size:0.7rem;color:#777;">' + esc(f.prov_min) + "</div></td><td>" + spark(f.serie) + "</td></tr>";
      }).join("") : '<tr><td colspan="9" style="color:#777;">Ningún producto coincide con el filtro.</td></tr>';
    }

    // Mostrar/ocultar la pestaña sin depender del manejador general
    document.querySelectorAll("button[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () {
        setTimeout(function () {
          const es = b === boton;
          seccion.style.display = es ? "block" : "none";
          if (es) {
            document.querySelectorAll('section[id^="tab-"]').forEach(function (s) { if (s !== seccion) s.style.display = "none"; });
            document.querySelectorAll("button[data-tab]").forEach(function (x) { x.classList.toggle("active", x === boton); });
            if (!E.cargado) iniciar(); else cargar();
          }
        }, 0);
      });
    });
  })();

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
    try { await stCargar(); } catch (e) {}
    let ciclos = [];
    try { ciclos = await (await api("/api/ciclos")).json(); } catch (e) {}
    let activo = null;
    try {
      const a = await (await api("/api/ciclos/actual")).json();
      activo = (a && (a.ciclo_id || (a.ciclo && a.ciclo.id) || a.id || (a.activo && a.activo.id))) || null;
    } catch (e) {}
    const ids = ciclos.map((c) => c.id).sort().reverse();
    HN.ciclos = ids;
    const trabajoId = (stEstado().trabajo && stEstado().trabajo.id) || null;
    HN.ciclo = trabajoId && ids.includes(trabajoId) ? trabajoId : (activo && ids.includes(activo) ? activo : ids[0] || null);
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
      const cicloAntes = HN.ciclo;
      await hnCargarCiclos();
      if (cicloAntes && cicloAntes !== HN.ciclo) { HN.negId = null; HN.hoja = null; HN.archivo = null; HN.editando = false; }
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
      "</div></div>" +
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
