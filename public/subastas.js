// Subastas (solicitudes de cotización a proveedores).
//  - Administrador: arma la solicitud con los productos que necesita, la envía y sigue quién respondió.
//  - Planeación de la demanda: ve el resumen general de los productos en subasta, sin datos de proveedores.
(function () {
  "use strict";
  const C = window.Comun;
  if (!C) return;
  const { api, toast, esc, fecha, modal } = C;

  const ESTADOS = {
    borrador: ["Borrador", "gris"], abierta: ["Abierta", "ok"], vencida: ["Plazo vencido", "espera"], cerrada: ["Cerrada", "gris"],
  };
  const ESTADOS_PRODUCTO = {
    esperando: ["Esperando ofertas", "espera"], sin_ofertas: ["Sin ofertas", "mal"], con_ofertas: ["Con ofertas", ""],
    negociacion: ["En negociación", "espera"], acordado: ["Precio acordado", "ok"],
  };
  const etiqueta = (mapa, e) => { const [t, c] = mapa[e] || [e, "gris"]; return '<span class="etiqueta ' + c + '">' + esc(t) + "</span>"; };
  const num = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("es-CO", { maximumFractionDigits: 2 }));
  // Bogotá no cambia de horario: UTC-5 todo el año
  const aLocal = (iso) => new Date(new Date(iso).getTime() - 5 * 3600000).toISOString().slice(0, 16);

  async function datosSemanas() {
    const [s, ciclos] = await Promise.all([api("/api/semana"), api("/api/ciclos")]);
    return {
      trabajo: s && s.trabajo ? s.trabajo.id : null,
      ciclos: (Array.isArray(ciclos) ? ciclos : []).slice().sort((a, b) => String(b.id).localeCompare(String(a.id))),
    };
  }

  function opcionesCiclo(ciclos, elegido) {
    return ciclos.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === elegido ? " selected" : "") + ">" + esc(c.id) + (c.cerrado_en ? " (cerrada)" : "") + "</option>").join("");
  }

  // =====================================================================
  // ADMINISTRADOR
  // =====================================================================
  const S = { ciclo: null, ciclos: [], lista: [], detalle: null, catalogo: [], editor: null };
  const raiz = () => document.getElementById("subRaiz");

  async function abrirAdmin() {
    const sem = await datosSemanas();
    S.ciclos = sem.ciclos;
    if (!S.ciclo || !S.ciclos.some((c) => c.id === S.ciclo)) S.ciclo = sem.trabajo || (S.ciclos[0] && S.ciclos[0].id) || null;
    if (S.editor) return pintarEditor();
    if (S.detalle) return verDetalle(S.detalle.subasta.id);
    await verLista();
  }

  async function verLista() {
    S.detalle = null; S.editor = null;
    S.lista = S.ciclo ? await api("/api/subastas?ciclo=" + encodeURIComponent(S.ciclo)) : [];
    actualizarContador();
    const filas = S.lista.map((s) => {
      const acciones = ['<button class="btn-secondary btn-chico" data-sub="ver" data-id="' + s.id + '">Ver</button>'];
      if (s.estado === "borrador") acciones.push('<button class="btn-primary btn-chico" data-sub="enviar" data-id="' + s.id + '">Enviar</button>');
      return "<tr><td class='envuelve'><b>" + esc(s.titulo) + "</b>" + (s.observacion ? "<div class='texto-suave'>" + esc(s.observacion) + "</div>" : "") + "</td>" +
        "<td>" + etiqueta(ESTADOS, s.estado_efectivo) + "</td><td>" + esc(fecha(s.fecha_limite)) + "</td>" +
        "<td class='celda-num'>" + s.productos + (s.productos_sin_proveedor ? " <span class='etiqueta mal' title='Productos sin proveedor asociado'>" + s.productos_sin_proveedor + " sin proveedor</span>" : "") + "</td>" +
        "<td class='celda-num'>" + s.proveedores + (s.proveedores_sin_cuenta ? " <span class='etiqueta espera' title='Proveedores sin cuenta activa en el portal'>" + s.proveedores_sin_cuenta + " sin cuenta</span>" : "") + "</td>" +
        "<td class='celda-num'>" + (s.estado === "borrador" ? "—" : s.respondieron + " de " + s.proveedores) + "</td>" +
        "<td><div class='fila-acciones'>" + acciones.join("") + "</div></td></tr>";
    }).join("");
    raiz().innerHTML =
      '<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">' +
      '<div><p class="section-title" style="margin:0">Subastas · solicitudes de cotización</p>' +
      '<p class="texto-suave" style="margin:6px 0 0;max-width:640px">Pide a los proveedores los productos que necesitas. A cada proveedor solo le llegan los productos que tiene parametrizados; recibe un aviso y un correo, y cotiza desde su portal, sin Excel.</p></div>' +
      '<div class="fila-acciones"><label class="etiqueta-campo" for="subCiclo" style="margin:0">Semana</label><select id="subCiclo" class="manual-input" style="width:auto">' + opcionesCiclo(S.ciclos, S.ciclo) + "</select>" +
      '<button class="btn-primary" data-sub="nueva">+ Nueva solicitud</button></div></div></div>' +
      (filas
        ? '<div class="card"><div class="table-scroll"><table><thead><tr><th>Solicitud</th><th>Estado</th><th>Fecha límite</th><th class="celda-num">Productos</th><th class="celda-num">Proveedores</th><th class="celda-num">Respondieron</th><th></th></tr></thead><tbody>' + filas + "</tbody></table></div></div>"
        : '<div class="card"><p class="texto-suave" style="margin:0">No hay solicitudes en la semana ' + esc(S.ciclo || "") + '. Crea una con «Nueva solicitud».</p></div>');
  }

  function actualizarContador() {
    const n = (S.lista || []).filter((s) => s.estado_efectivo === "abierta").length;
    const el = document.getElementById("countSubastas");
    if (el) { el.textContent = n; el.style.display = n ? "" : "none"; el.title = n + " solicitud(es) abierta(s)"; }
  }

  async function verDetalle(id) {
    S.editor = null;
    const d = await api("/api/subastas/" + id);
    S.detalle = d;
    const s = d.subasta;
    const conOfertas = d.productos.filter((p) => p.ofertas > 0).length;
    const acciones = [];
    if (s.estado === "borrador") {
      acciones.push('<button class="btn-primary" data-sub="enviar" data-id="' + s.id + '">Enviar a proveedores</button>');
      acciones.push('<button class="btn-secondary" data-sub="editar" data-id="' + s.id + '">Editar</button>');
      acciones.push('<button class="btn-secondary btn-peligro" data-sub="eliminar" data-id="' + s.id + '">Eliminar</button>');
    } else if (s.estado === "abierta") {
      acciones.push('<button class="btn-secondary" data-sub="editar" data-id="' + s.id + '">Cambiar plazo o nota</button>');
      acciones.push('<button class="btn-secondary" data-sub="cerrar" data-id="' + s.id + '">Cerrar recepción</button>');
    }
    if (s.estado === "cerrada" || s.estado_efectivo === "vencida") acciones.push('<button class="btn-secondary" data-sub="reabrir" data-id="' + s.id + '">Reabrir</button>');
    if (s.estado !== "borrador") acciones.push('<button class="btn-secondary" data-sub="ir" data-tab="comparativo">Ver comparativo</button><button class="btn-secondary" data-sub="ir" data-tab="hoja-negociacion">Ir a negociación</button>');

    const filasProv = d.proveedores.map((p) => {
      const respondio = p.respondido_en ? '<span class="etiqueta ok">Respondió ' + esc(fecha(p.respondido_en)) + "</span>"
        : p.visto_en ? '<span class="etiqueta espera">Lo vio ' + esc(fecha(p.visto_en)) + "</span>"
        : s.estado === "borrador" ? '<span class="etiqueta gris">Sin enviar</span>' : '<span class="etiqueta gris">Sin abrir</span>';
      return "<tr><td>" + esc(p.proveedor) + "</td><td class='celda-num'>" + p.productos_invitados + "</td><td class='celda-num'>" + p.productos_ofertados + "</td>" +
        "<td>" + (p.con_cuenta ? '<span class="etiqueta ok">Sí</span>' : '<span class="etiqueta mal" title="Créale un usuario en la pestaña Usuarios o cárgale su Excel">No tiene cuenta</span>') + "</td><td>" + respondio + "</td></tr>";
    }).join("");
    const filasProd = d.productos.map((p) =>
      "<tr><td>" + esc(p.codigo) + "</td><td class='envuelve'>" + esc(p.producto) + (p.observacion ? "<div class='texto-suave'>" + esc(p.observacion) + "</div>" : "") + "</td><td>" + esc(p.presentacion) + "</td>" +
      "<td class='celda-num'>" + num(p.cantidad_estimada) + "</td><td class='celda-num'>" + (p.proveedores ? p.proveedores : '<span class="etiqueta mal">Sin proveedor</span>') + "</td><td class='celda-num'>" + p.ofertas + "</td></tr>").join("");

    raiz().innerHTML =
      '<div class="card"><div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-start">' +
      '<div><p class="section-title" style="margin:0">' + esc(s.titulo) + " " + etiqueta(ESTADOS, s.estado_efectivo) + "</p>" +
      '<p class="texto-suave" style="margin:6px 0 0">Semana ' + esc(s.ciclo_id) + " · Fecha límite: <b>" + esc(fecha(s.fecha_limite)) + "</b>" + (s.enviado_en ? " · Enviada " + esc(fecha(s.enviado_en)) : "") + "</p>" +
      (s.observacion ? '<p class="texto-suave" style="margin:4px 0 0">Nota para proveedores: ' + esc(s.observacion) + "</p>" : "") + "</div>" +
      '<div class="fila-acciones"><button class="btn-secondary" data-sub="volver">← Todas</button><button class="btn-secondary" data-sub="ver" data-id="' + s.id + '">Actualizar</button></div></div>' +
      '<div class="fila-acciones" style="margin-top:14px">' + acciones.join("") + "</div></div>" +
      '<div class="metricas"><div class="metrica"><span>Productos pedidos</span><b>' + s.productos + '</b></div><div class="metrica"><span>Proveedores invitados</span><b>' + s.proveedores + "</b></div>" +
      '<div class="metrica"><span>Respondieron</span><b>' + (s.estado === "borrador" ? "—" : s.respondieron) + '</b></div><div class="metrica"><span>Productos con ofertas</span><b>' + conOfertas + " de " + s.productos + "</b></div></div>" +
      '<div class="card"><p class="section-title">Seguimiento por proveedor</p>' +
      (filasProv ? '<div class="table-scroll"><table><thead><tr><th>Proveedor</th><th class="celda-num">Productos pedidos</th><th class="celda-num">Con precio</th><th>Cuenta en el portal</th><th>Respuesta</th></tr></thead><tbody>' + filasProv + "</tbody></table></div>"
        : '<p class="texto-suave">Ningún proveedor tiene asociados estos productos.</p>') + "</div>" +
      '<div class="card"><p class="section-title">Productos solicitados</p><div class="table-scroll"><table><thead><tr><th>PLU</th><th>Producto</th><th>Presentación</th><th class="celda-num">Cant. estimada</th><th class="celda-num">Proveedores</th><th class="celda-num">Ofertas</th></tr></thead><tbody>' + filasProd + "</tbody></table></div></div>";
  }

  // ---------- Editor de la solicitud ----------
  function plazoPorDefecto() {
    const c = S.ciclos.find((x) => x.id === S.ciclo);
    // La recepción cierra el martes a las 12:00 m. (igual que la solicitud automática al abrir la semana)
    const candidato = c && c.fecha_fin_recepcion ? c.fecha_fin_recepcion + "T12:00" : null;
    if (candidato && new Date(candidato + ":00-05:00") > new Date()) return candidato;
    return aLocal(new Date(Date.now() + 24 * 3600000).toISOString()).slice(0, 11) + "12:00";
  }

  async function abrirEditor(id) {
    let base = null, productos = [];
    if (id) {
      const d = await api("/api/subastas/" + id);
      base = d.subasta; productos = d.productos;
    }
    const ciclo = base ? base.ciclo_id : S.ciclo;
    S.catalogo = await api("/api/subastas/catalogo?ciclo=" + encodeURIComponent(ciclo || ""));
    S.editor = {
      id: base ? base.id : null,
      estado: base ? base.estado : "borrador",
      ciclo_id: ciclo,
      titulo: base ? base.titulo : "Solicitud de cotización " + (ciclo || ""),
      fecha_limite: base ? aLocal(base.fecha_limite) : plazoPorDefecto(),
      observacion: base ? base.observacion || "" : "",
      seleccion: new Map(productos.map((p) => [String(p.codigo), { cantidad: p.cantidad_estimada == null ? "" : p.cantidad_estimada }])),
      filtro: "", soloConProveedor: true, soloDemanda: false,
    };
    pintarEditor();
  }

  function pintarEditor() {
    const e = S.editor;
    const soloDatos = e.estado !== "borrador";
    raiz().innerHTML =
      '<div class="card"><div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-bottom:14px">' +
      '<p class="section-title" style="margin:0">' + (e.id ? "Editar solicitud" : "Nueva solicitud de cotización") + "</p>" +
      '<button class="btn-secondary" data-sub="' + (e.id ? "ver" : "volver") + '" data-id="' + (e.id || "") + '">Cancelar</button></div>' +
      '<div class="form-grid">' +
      '<div><label for="seCiclo">Semana</label><select id="seCiclo" class="campo"' + (e.id ? " disabled" : "") + ">" + opcionesCiclo(S.ciclos, e.ciclo_id) + "</select></div>" +
      '<div><label for="seTitulo">Título</label><input id="seTitulo" class="campo" maxlength="120" value="' + esc(e.titulo) + '"></div>' +
      '<div><label for="seLimite">Fecha y hora límite (hora de Colombia)</label><input id="seLimite" type="datetime-local" class="campo" value="' + esc(e.fecha_limite) + '"></div>' +
      '<div style="grid-column:1/-1"><label for="seObs">Nota para los proveedores (opcional)</label><input id="seObs" class="campo" maxlength="500" placeholder="Ej.: precios por kilo, puesto en bodega Manizales" value="' + esc(e.observacion) + '"></div>' +
      "</div></div>" +
      (soloDatos
        ? '<div class="nota" style="margin-bottom:16px">La solicitud ya se envió: solo puedes cambiar el título, la nota y el plazo. Para pedir más productos crea otra solicitud.</div>'
        : '<div class="card"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
          '<p class="section-title" style="margin:0">Productos <span class="texto-suave" id="seResumen"></span></p>' +
          '<div class="fila-acciones"><input id="seBuscar" class="campo" style="width:240px" placeholder="Buscar PLU o producto…" value="' + esc(e.filtro) + '">' +
          '<label class="texto-suave"><input type="checkbox" id="seConProv"' + (e.soloConProveedor ? " checked" : "") + "> Solo con proveedor</label>" +
          '<label class="texto-suave"><input type="checkbox" id="seDemanda"' + (e.soloDemanda ? " checked" : "") + "> Solo los de la demanda</label>" +
          '<button class="btn-secondary btn-chico" data-sub="todos">Marcar los visibles</button><button class="btn-secondary btn-chico" data-sub="ninguno">Quitar todos</button></div></div>' +
          '<div class="table-scroll" style="max-height:52vh"><table><thead><tr><th></th><th>PLU</th><th>Producto</th><th>Presentación</th><th class="celda-num">Proveedores</th><th>Cant. estimada (opcional)</th></tr></thead><tbody id="seFilas"></tbody></table></div></div>') +
      '<div class="fila-acciones derecha"><button class="btn-primary" data-sub="guardar">' + (e.id ? "Guardar cambios" : "Guardar borrador") + "</button></div>";
    if (!soloDatos) pintarFilasEditor();
  }

  function visiblesEditor() {
    const e = S.editor;
    const q = String(e.filtro || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
    return S.catalogo.filter((p) => {
      if (e.soloConProveedor && !p.proveedores && !e.seleccion.has(String(p.codigo))) return false;
      if (e.soloDemanda && !p.en_demanda) return false;
      if (!q) return true;
      return (String(p.codigo) + " " + p.producto).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().includes(q);
    });
  }

  function pintarFilasEditor() {
    const e = S.editor, tbody = document.getElementById("seFilas");
    if (!tbody) return;
    const lista = visiblesEditor();
    tbody.innerHTML = lista.length ? lista.slice(0, 600).map((p) => {
      const sel = e.seleccion.get(String(p.codigo));
      return "<tr><td><input type='checkbox' class='se-chk' data-codigo='" + esc(p.codigo) + "'" + (sel ? " checked" : "") + "></td>" +
        "<td>" + esc(p.codigo) + "</td><td class='envuelve'>" + esc(p.producto) + (p.en_demanda ? " <span class='etiqueta'>En demanda</span>" : "") + "</td><td>" + esc(p.presentacion) + "</td>" +
        "<td class='celda-num'>" + (p.proveedores || "<span class='etiqueta mal'>0</span>") + "</td>" +
        "<td><input type='number' min='0' step='any' class='manual-input se-cant' style='width:120px' data-codigo='" + esc(p.codigo) + "' value='" + esc(sel ? sel.cantidad : "") + "'" + (sel ? "" : " disabled") + "></td></tr>";
    }).join("") : "<tr><td colspan='6' class='texto-suave'>Ningún producto coincide con el filtro.</td></tr>";
    const resumen = document.getElementById("seResumen");
    if (resumen) {
      const provs = e.seleccion.size;
      const sinProv = [...e.seleccion.keys()].filter((c) => { const p = S.catalogo.find((x) => String(x.codigo) === c); return !p || !p.proveedores; }).length;
      resumen.textContent = "· " + provs + " seleccionado(s)" + (sinProv ? " · " + sinProv + " sin proveedor" : "");
    }
  }

  async function guardarEditor() {
    const e = S.editor;
    const cuerpo = {
      titulo: document.getElementById("seTitulo").value,
      fecha_limite: document.getElementById("seLimite").value,
      observacion: document.getElementById("seObs").value,
    };
    if (e.estado === "borrador") cuerpo.productos = [...e.seleccion.entries()].map(([codigo, v]) => ({ codigo, cantidad_estimada: v.cantidad }));
    if (e.estado === "borrador" && !cuerpo.productos.length) { toast("Marca al menos un producto."); return; }
    let id = e.id;
    if (id) await api("/api/subastas/" + id, { method: "PUT", json: cuerpo });
    else id = (await api("/api/subastas", { method: "POST", json: Object.assign({ ciclo_id: document.getElementById("seCiclo").value }, cuerpo) })).id;
    S.editor = null;
    toast(e.id ? "Cambios guardados." : "Borrador guardado. Revísalo y envíalo a los proveedores.");
    await verDetalle(id);
  }

  async function enviar(id) {
    const d = await api("/api/subastas/" + id);
    const s = d.subasta;
    const sinCuenta = d.proveedores.filter((p) => !p.con_cuenta).length;
    if (!confirm("Se enviará «" + s.titulo + "» a " + s.proveedores + " proveedor(es) con " + s.productos + " producto(s).\nPlazo: " + fecha(s.fecha_limite) +
      (sinCuenta ? "\n\n" + sinCuenta + " proveedor(es) no tienen cuenta en el portal: no recibirán el aviso." : "") + "\n\n¿Enviar ahora?")) return;
    const r = await api("/api/subastas/" + id + "/enviar", { method: "POST" });
    const avisos = [];
    avisos.push("<p>Se envió a <b>" + r.proveedores + "</b> proveedor(es). Recibieron aviso <b>" + r.usuarios_avisados + "</b> usuario(s).</p>");
    if (r.sin_cuenta.length) avisos.push('<div class="nota alerta" style="margin-top:10px"><b>Sin cuenta en el portal (no recibieron nada):</b><br>' + r.sin_cuenta.map(esc).join("<br>") + '<br><span class="texto-suave">Créales un usuario en la pestaña Usuarios o cárgales la cotización por Excel.</span></div>');
    if (r.productos_sin_proveedor.length) avisos.push('<div class="nota error" style="margin-top:10px"><b>Productos sin proveedor asociado:</b><br>' + r.productos_sin_proveedor.map(esc).join("<br>") + "</div>");
    modal("Solicitud enviada", avisos.join("") + '<div class="fila-acciones derecha" style="margin-top:16px"><button class="btn-primary" data-cerrar>Entendido</button></div>');
    await verDetalle(id);
  }

  function reabrir(id) {
    const m = modal("Reabrir la solicitud",
      '<label class="etiqueta-campo" for="raLimite">Nueva fecha y hora límite (hora de Colombia)</label><input id="raLimite" type="datetime-local" class="campo" value="' + esc(plazoPorDefecto()) + '">' +
      '<p class="texto-suave">Los proveedores invitados reciben un aviso y pueden enviar o ajustar su propuesta.</p>' +
      '<div class="fila-acciones derecha" style="margin-top:14px"><button class="btn-secondary" data-cerrar>Cancelar</button><button class="btn-primary" id="raOk">Reabrir</button></div>', { ancho: 420 });
    m.caja.querySelector("#raOk").addEventListener("click", async () => {
      try {
        await api("/api/subastas/" + id + "/reabrir", { method: "POST", json: { fecha_limite: m.caja.querySelector("#raLimite").value } });
        m.cerrar(); toast("Solicitud reabierta.");
        await verDetalle(id);
      } catch (err) { toast(err.message); }
    });
  }

  async function clicAdmin(ev) {
    const el = ev.target.closest("[data-sub]");
    if (!el) return;
    const accion = el.dataset.sub, id = el.dataset.id;
    try {
      if (accion === "nueva") await abrirEditor(null);
      else if (accion === "ver") await verDetalle(id);
      else if (accion === "volver") await verLista();
      else if (accion === "editar") await abrirEditor(id);
      else if (accion === "guardar") await guardarEditor();
      else if (accion === "enviar") await enviar(id);
      else if (accion === "ir") C.irA(el.dataset.tab);
      else if (accion === "reabrir") reabrir(id);
      else if (accion === "cerrar") {
        if (!confirm("¿Cerrar la recepción? Los proveedores ya no podrán enviar ni cambiar su propuesta.")) return;
        await api("/api/subastas/" + id + "/cerrar", { method: "POST" }); toast("Recepción cerrada."); await verDetalle(id);
      } else if (accion === "eliminar") {
        if (!confirm("¿Eliminar este borrador?")) return;
        await api("/api/subastas/" + id, { method: "DELETE" }); toast("Borrador eliminado."); await verLista();
      } else if (accion === "todos" || accion === "ninguno") {
        if (accion === "ninguno") S.editor.seleccion.clear();
        else visiblesEditor().forEach((p) => { if (!S.editor.seleccion.has(String(p.codigo))) S.editor.seleccion.set(String(p.codigo), { cantidad: "" }); });
        pintarFilasEditor();
      }
    } catch (err) {
      toast(err.message);
    }
  }

  function cambioAdmin(ev) {
    const t = ev.target, e = S.editor;
    if (t.id === "subCiclo") { S.ciclo = t.value; verLista().catch((err) => toast(err.message)); return; }
    if (!e) return;
    if (t.id === "seCiclo") {
      e.ciclo_id = t.value; S.ciclo = t.value;
      api("/api/subastas/catalogo?ciclo=" + encodeURIComponent(t.value)).then((c) => { S.catalogo = c; pintarFilasEditor(); }).catch((err) => toast(err.message));
    } else if (t.id === "seConProv") { e.soloConProveedor = t.checked; pintarFilasEditor(); }
    else if (t.id === "seDemanda") { e.soloDemanda = t.checked; pintarFilasEditor(); }
    else if (t.classList.contains("se-chk")) {
      const c = t.dataset.codigo;
      if (t.checked) e.seleccion.set(c, { cantidad: "" }); else e.seleccion.delete(c);
      pintarFilasEditor();
    }
  }

  function entradaAdmin(ev) {
    const t = ev.target, e = S.editor;
    if (!e) return;
    if (t.id === "seBuscar") { e.filtro = t.value; pintarFilasEditor(); }
    else if (t.id === "seTitulo") e.titulo = t.value;
    else if (t.id === "seLimite") e.fecha_limite = t.value;
    else if (t.id === "seObs") e.observacion = t.value;
    else if (t.classList.contains("se-cant")) { const s = e.seleccion.get(t.dataset.codigo); if (s) s.cantidad = t.value; }
  }

  if (C.USUARIO.tipo === "admin" && raiz()) {
    raiz().addEventListener("click", clicAdmin);
    raiz().addEventListener("change", cambioAdmin);
    raiz().addEventListener("input", entradaAdmin);
    C.registrarPestana("subastas", abrirAdmin);
    // Número de solicitudes abiertas en el menú
    datosSemanas().then((sem) => { S.ciclos = sem.ciclos; S.ciclo = sem.trabajo; return S.ciclo ? api("/api/subastas?ciclo=" + encodeURIComponent(S.ciclo)) : []; })
      .then((l) => { S.lista = l; actualizarContador(); }).catch(() => {});
  }

  // =====================================================================
  // PLANEACIÓN DE LA DEMANDA: resumen general (sin proveedores ni precios)
  // =====================================================================
  const R = { ciclo: null, ciclos: [], datos: null, filtro: "" };
  const raizResumen = () => document.getElementById("subResumenRaiz");

  async function abrirResumen() {
    const sem = await datosSemanas();
    R.ciclos = sem.ciclos;
    if (!R.ciclo || !R.ciclos.some((c) => c.id === R.ciclo)) R.ciclo = sem.trabajo || (R.ciclos[0] && R.ciclos[0].id) || null;
    R.datos = R.ciclo ? await api("/api/subastas/resumen?ciclo=" + encodeURIComponent(R.ciclo)) : { subastas: [], productos: [] };
    pintarResumen();
  }

  function pintarResumen() {
    const d = R.datos, prods = d.productos || [];
    const cuenta = (f) => prods.filter(f).length;
    const subs = (d.subastas || []).map((s) =>
      "<tr><td class='envuelve'><b>" + esc(s.titulo) + "</b></td><td>" + etiqueta(ESTADOS, s.estado_efectivo) + "</td><td>" + esc(fecha(s.fecha_limite)) + "</td>" +
      "<td class='celda-num'>" + s.productos + "</td><td class='celda-num'>" + s.proveedores + "</td><td class='celda-num'>" + s.respondieron + "</td></tr>").join("");
    raizResumen().innerHTML = (
      '<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">' +
      '<div><p class="section-title" style="margin:0">Productos en subasta</p><p class="texto-suave" style="margin:6px 0 0;max-width:640px">Avance general de lo que Mercaldas pidió a los proveedores esta semana: cuántas ofertas llegaron y en qué va la negociación de cada producto.</p></div>' +
      '<div class="fila-acciones"><label class="etiqueta-campo" for="srCiclo" style="margin:0">Semana</label><select id="srCiclo" class="manual-input" style="width:auto">' + opcionesCiclo(R.ciclos, R.ciclo) + "</select>" +
      '<button class="btn-secondary" data-sr="actualizar">Actualizar</button></div></div></div>' +
      '<div class="metricas"><div class="metrica"><span>Productos solicitados</span><b>' + prods.length + '</b></div><div class="metrica"><span>Con ofertas</span><b>' + cuenta((p) => p.ofertas > 0) + "</b></div>" +
      '<div class="metrica"><span>En negociación</span><b>' + cuenta((p) => p.estado === "negociacion") + '</b></div><div class="metrica"><span>Con precio acordado</span><b>' + cuenta((p) => p.estado === "acordado") + "</b></div></div>" +
      (subs ? '<div class="card"><p class="section-title">Solicitudes de la semana</p><div class="table-scroll"><table><thead><tr><th>Solicitud</th><th>Estado</th><th>Fecha límite</th><th class="celda-num">Productos</th><th class="celda-num">Proveedores invitados</th><th class="celda-num">Respondieron</th></tr></thead><tbody>' + subs + "</tbody></table></div></div>" : "") +
      '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px"><p class="section-title" style="margin:0">Productos</p>' +
      '<input id="srBuscar" class="campo" style="width:260px" placeholder="Buscar PLU o producto…" value="' + esc(R.filtro) + '"></div>' +
      '<div class="table-scroll"><table><thead><tr><th>PLU</th><th>Producto</th><th>Presentación</th><th class="celda-num">Cant. estimada</th><th class="celda-num">Proveedores invitados</th><th class="celda-num">Ofertas recibidas</th><th>Estado</th></tr></thead><tbody id="srFilas"></tbody></table></div></div>');
    pintarFilasResumen();
  }

  function pintarFilasResumen() {
    const tbody = document.getElementById("srFilas");
    if (!tbody) return;
    const q = R.filtro.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
    const prods = (R.datos.productos || []).filter((p) => !q || (p.codigo + " " + p.producto).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().includes(q));
    tbody.innerHTML = prods.length ? prods.map((p) =>
      "<tr><td>" + esc(p.codigo) + "</td><td class='envuelve'>" + esc(p.producto) + "</td><td>" + esc(p.presentacion) + "</td><td class='celda-num'>" + num(p.cantidad_estimada) + "</td>" +
      "<td class='celda-num'>" + p.proveedores_invitados + "</td><td class='celda-num'>" + p.ofertas + "</td><td>" + etiqueta(ESTADOS_PRODUCTO, p.estado) + "</td></tr>").join("")
      : "<tr><td colspan='7' class='texto-suave'>" + ((R.datos.productos || []).length ? "Ningún producto coincide con la búsqueda." : "No hay solicitudes enviadas en esta semana.") + "</td></tr>";
  }

  if (raizResumen()) {
    raizResumen().addEventListener("change", (e) => {
      if (e.target.id === "srCiclo") { R.ciclo = e.target.value; abrirResumen().catch((err) => toast(err.message)); }
    });
    raizResumen().addEventListener("input", (e) => { if (e.target.id === "srBuscar") { R.filtro = e.target.value; pintarFilasResumen(); } });
    raizResumen().addEventListener("click", (e) => { if (e.target.closest("[data-sr='actualizar']")) abrirResumen().catch((err) => toast(err.message)); });
    C.registrarPestana("subasta-resumen", abrirResumen);
  }
})();
