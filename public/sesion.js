// Piezas comunes de las páginas con sesión (index.html y proveedor.html): usuario en la cabecera,
// campana de avisos, cambio de contraseña y utilidades que usan subastas.js y usuarios.js (window.Comun).
(function () {
  "use strict";

  const USUARIO = window.__USUARIO || {};

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const moneda = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CO"));
  const fecha = (iso, conHora = true) => {
    if (!iso) return "—";
    const op = conHora ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" };
    return new Date(iso).toLocaleString("es-CO", Object.assign({ timeZone: "America/Bogota" }, op));
  };
  const hace = (iso) => {
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    if (min < 1) return "ahora";
    if (min < 60) return "hace " + min + " min";
    const h = Math.round(min / 60);
    if (h < 24) return "hace " + h + " h";
    return fecha(iso, false);
  };

  function toast(msg) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 3500);
  }

  // Devuelve el JSON de la respuesta; si hay error lanza Error con el mensaje del servidor
  async function api(ruta, opciones = {}) {
    const op = Object.assign({}, opciones);
    if (op.json !== undefined) {
      op.headers = Object.assign({ "Content-Type": "application/json" }, op.headers || {});
      op.body = JSON.stringify(op.json);
      delete op.json;
    }
    const res = await fetch(ruta, op);
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("Tu sesión terminó.");
    }
    let datos = null;
    try { datos = await res.json(); } catch (e) { datos = null; }
    if (!res.ok) {
      if (datos && datos.codigo === "DEBE_CAMBIAR_PASSWORD") window.location.href = "/login.html?cambiar=1";
      throw new Error((datos && datos.error) || "Error del servidor (" + res.status + ").");
    }
    return datos;
  }

  // Ventana modal sencilla: devuelve { caja, cerrar }
  function modal(titulo, html, { ancho = 520, alCerrar } = {}) {
    const fondo = document.createElement("div");
    fondo.className = "modal-overlay";
    fondo.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true" style="max-width:' + ancho + 'px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px">' +
      '<p class="section-title" style="margin:0">' + esc(titulo) + '</p><button type="button" class="btn-secondary btn-chico" data-cerrar aria-label="Cerrar">✕</button></div>' +
      '<div class="modal-cuerpo">' + html + "</div></div>";
    document.body.appendChild(fondo);
    const cerrar = () => {
      fondo.remove();
      document.removeEventListener("keydown", tecla);
      if (alCerrar) alCerrar();
    };
    const tecla = (e) => { if (e.key === "Escape") cerrar(); };
    document.addEventListener("keydown", tecla);
    fondo.addEventListener("click", (e) => { if (e.target === fondo || e.target.closest("[data-cerrar]")) cerrar(); });
    const primero = fondo.querySelector("input, select, textarea");
    if (primero) setTimeout(() => primero.focus(), 30);
    return { caja: fondo.querySelector(".modal-cuerpo"), cerrar };
  }

  // Pestañas propias (las de app.js tienen su propio manejador): muestra la sección y oculta las demás
  function registrarPestana(nombre, alAbrir) {
    const boton = document.querySelector('nav.tabs button[data-tab="' + nombre + '"]');
    const seccion = document.getElementById("tab-" + nombre);
    if (!boton || !seccion) return;
    document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => {
      b.addEventListener("click", () => {
        if (b !== boton) { seccion.style.display = "none"; return; }
        document.querySelectorAll('section[id^="tab-"]').forEach((s) => { s.style.display = s === seccion ? "block" : "none"; });
        document.querySelectorAll("nav.tabs button[data-tab]").forEach((x) => x.classList.toggle("active", x === boton));
        Promise.resolve().then(alAbrir).catch((e) => toast(e.message));
      });
    });
  }

  function irA(enlace) {
    const b = enlace && document.querySelector('nav.tabs button[data-tab="' + enlace + '"]');
    if (b && getComputedStyle(b).display !== "none") b.click();
    document.dispatchEvent(new CustomEvent("aviso:abrir", { detail: enlace }));
  }

  // ---------- Cabecera: quién está conectado ----------
  const chip = document.getElementById("usuarioChip");
  if (chip && USUARIO.usuario) {
    const segunda = USUARIO.proveedorNombre || (USUARIO.nombre === USUARIO.tipoNombre ? USUARIO.usuario : USUARIO.tipoNombre);
    chip.innerHTML = "<b>" + esc(USUARIO.nombre) + "</b><span>" + esc(segunda) + "</span>";
  }

  // ---------- Menú del usuario (cambiar contraseña, cerrar sesión) ----------
  const btnUsuario = document.getElementById("btnUsuario");
  const menuUsuario = document.getElementById("menuUsuario");
  if (btnUsuario && menuUsuario) {
    const mostrarMenu = (si) => { menuUsuario.hidden = !si; btnUsuario.setAttribute("aria-expanded", String(si)); };
    btnUsuario.addEventListener("click", (e) => { e.stopPropagation(); mostrarMenu(menuUsuario.hidden); });
    menuUsuario.addEventListener("click", () => mostrarMenu(false));
    document.addEventListener("click", (e) => { if (!e.target.closest(".menu-usuario")) mostrarMenu(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") mostrarMenu(false); });
  }

  // ---------- Cambiar contraseña ----------
  function abrirCambioPassword() {
    const m = modal("Cambiar contraseña",
      '<form id="formCambioPass" autocomplete="off">' +
      '<label class="etiqueta-campo" for="cpActual">Contraseña actual</label><input class="campo" type="password" id="cpActual" autocomplete="current-password" required>' +
      '<label class="etiqueta-campo" for="cpNueva" style="margin-top:12px">Contraseña nueva</label><input class="campo" type="password" id="cpNueva" autocomplete="new-password" required>' +
      '<label class="etiqueta-campo" for="cpConfirma" style="margin-top:12px">Repite la contraseña nueva</label><input class="campo" type="password" id="cpConfirma" autocomplete="new-password" required>' +
      '<p class="texto-suave" style="margin:8px 0 0">Mínimo 8 caracteres, con letras y números. Al cambiarla se cierran tus otras sesiones abiertas.</p>' +
      '<div id="cpError" class="nota error" style="display:none;margin-top:12px"></div>' +
      '<div class="fila-acciones derecha" style="margin-top:16px"><button type="button" class="btn-secondary" data-cerrar>Cancelar</button><button type="submit" class="btn-primary">Guardar</button></div></form>', { ancho: 420 });
    m.caja.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const error = m.caja.querySelector("#cpError");
      const actual = m.caja.querySelector("#cpActual").value, nueva = m.caja.querySelector("#cpNueva").value;
      error.style.display = "none";
      if (nueva !== m.caja.querySelector("#cpConfirma").value) { error.textContent = "Las contraseñas nuevas no coinciden."; error.style.display = "block"; return; }
      try {
        await api("/api/auth/cambiar-password", { method: "POST", json: { actual, nueva } });
        m.cerrar();
        toast("Contraseña actualizada.");
      } catch (err) {
        error.textContent = err.message;
        error.style.display = "block";
      }
    });
  }
  const btnPass = document.getElementById("btnCambiarPassword");
  if (btnPass) btnPass.addEventListener("click", abrirCambioPassword);

  // ---------- Campana de avisos ----------
  const btnAvisos = document.getElementById("btnAvisos");
  const numAvisos = document.getElementById("avisosNum");
  let panel = null, ultimoTotal = null;

  function pintarNumero(n) {
    if (!numAvisos) return;
    numAvisos.textContent = n > 99 ? "99+" : String(n);
    numAvisos.classList.toggle("si", n > 0);
    if (btnAvisos) btnAvisos.title = n ? n + " aviso(s) sin leer" : "Avisos";
  }

  async function revisarAvisos() {
    if (document.hidden || !btnAvisos) return;
    try {
      const d = await api("/api/notificaciones?limite=1");
      if (ultimoTotal !== null && d.no_leidas > ultimoTotal) {
        toast("Tienes " + (d.no_leidas - ultimoTotal) + " aviso(s) nuevo(s).");
        document.dispatchEvent(new CustomEvent("avisos:nuevos"));
      }
      ultimoTotal = d.no_leidas;
      pintarNumero(d.no_leidas);
    } catch (e) { /* sin red: se reintenta en el siguiente ciclo */ }
  }

  async function abrirPanel() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement("div");
    panel.className = "panel-avisos";
    panel.innerHTML = '<div class="cab"><span>Avisos</span><button type="button" data-todos>Marcar todo como leído</button></div><div class="cuerpo"><div class="aviso-item">Cargando…</div></div>';
    document.body.appendChild(panel);
    try {
      const d = await api("/api/notificaciones?limite=30");
      const cuerpo = panel.querySelector(".cuerpo");
      cuerpo.innerHTML = d.items.length
        ? d.items.map((n) => '<div class="aviso-item' + (n.leida_en ? "" : " nuevo") + '" data-id="' + n.id + '" data-enlace="' + esc(n.enlace || "") + '">' +
            '<div class="t">' + esc(n.titulo) + "</div>" + (n.mensaje ? '<div class="m">' + esc(n.mensaje) + "</div>" : "") + '<div class="f">' + esc(hace(n.creado_en)) + "</div></div>").join("")
        : '<div class="aviso-item" style="cursor:default">No tienes avisos.</div>';
    } catch (e) {
      panel.querySelector(".cuerpo").innerHTML = '<div class="aviso-item">' + esc(e.message) + "</div>";
    }
  }

  if (btnAvisos) {
    btnAvisos.addEventListener("click", (e) => { e.stopPropagation(); abrirPanel(); });
    document.addEventListener("click", async (e) => {
      if (!panel) return;
      if (e.target.closest("[data-todos]")) {
        await api("/api/notificaciones/leer", { method: "POST", json: {} }).catch(() => {});
        panel.querySelectorAll(".aviso-item.nuevo").forEach((x) => x.classList.remove("nuevo"));
        ultimoTotal = 0; pintarNumero(0);
        return;
      }
      const item = e.target.closest(".aviso-item[data-id]");
      if (item) {
        api("/api/notificaciones/leer", { method: "POST", json: { ids: [Number(item.dataset.id)] } }).then(revisarAvisos).catch(() => {});
        panel.remove(); panel = null;
        irA(item.dataset.enlace);
        return;
      }
      if (!e.target.closest(".panel-avisos")) { panel.remove(); panel = null; }
    });
    revisarAvisos();
    setInterval(revisarAvisos, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) revisarAvisos(); });
  }

  // ---------- Planeación: arranca en una pestaña que sí puede ver ----------
  if (USUARIO.tipo === "planeacion") {
    const activo = document.querySelector("nav.tabs button.active");
    if (!activo || getComputedStyle(activo).display === "none") {
      const inicio = document.querySelector('nav.tabs button[data-tab="subasta-resumen"]');
      if (inicio) setTimeout(() => inicio.click(), 0);
    }
  }

  window.Comun = { USUARIO, api, toast, esc, moneda, fecha, hace, modal, registrarPestana, irA, revisarAvisos };
})();
