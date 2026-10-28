// Pestaña Usuarios (solo administrador): crear, buscar, editar, eliminar, cambiar contraseña,
// aprobar los proveedores que se registraron solos y ver la bitácora de seguridad.
(function () {
  "use strict";
  const C = window.Comun;
  if (!C || C.USUARIO.tipo !== "admin") return;
  const { api, toast, esc, fecha, hace, modal } = C;
  const raiz = document.getElementById("usrRaiz");
  if (!raiz) return;

  const TIPOS = { admin: "Administrador", planeacion: "Planeación de la demanda", proveedor: "Proveedor" };
  const U = { datos: null, proveedores: [], q: "", tipo: "", estado: "" };

  function estadoDe(u) {
    if (u.estado === "pendiente") return '<span class="etiqueta espera">Pendiente de aprobar</span>';
    if (u.estado === "rechazado") return '<span class="etiqueta mal">Rechazado</span>';
    if (u.estado === "inactivo") return '<span class="etiqueta gris">Inactivo</span>';
    let html = '<span class="etiqueta ok">Activo</span>';
    if (u.bloqueado) html += ' <span class="etiqueta mal" title="Bloqueado por intentos fallidos">Bloqueado</span>';
    if (u.debe_cambiar_password) html += ' <span class="etiqueta espera" title="Debe cambiar la contraseña al entrar">Contraseña temporal</span>';
    return html;
  }

  // 12 caracteres sin los que se confunden (0/O, 1/l/I), con al menos una letra y un número
  function generarPassword() {
    const letras = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ", digitos = "23456789", todos = letras + digitos;
    const r = new Uint32Array(24);
    crypto.getRandomValues(r);
    const c = [letras[r[0] % letras.length], digitos[r[1] % digitos.length]];
    for (let i = 2; i < 12; i++) c.push(todos[r[i] % todos.length]);
    for (let i = c.length - 1; i > 0; i--) { const j = r[12 + i] % (i + 1); [c[i], c[j]] = [c[j], c[i]]; }
    return c.join("");
  }

  function opcionesProveedor(elegido) {
    return '<option value="">Elige el proveedor…</option>' + U.proveedores.map((p) =>
      '<option value="' + esc(p.nombre) + '"' + (p.nombre === elegido ? " selected" : "") + ">" + esc(p.nombre) + " · " + p.productos + " productos" + (p.cuentas ? " · " + p.cuentas + " cuenta(s)" : "") + "</option>").join("");
  }

  async function cargar() {
    const qs = new URLSearchParams({ q: U.q, tipo: U.tipo, estado: U.estado }).toString();
    const [datos, proveedores] = await Promise.all([api("/api/usuarios?" + qs), api("/api/usuarios/proveedores")]);
    U.datos = datos; U.proveedores = proveedores;
    contador(datos.resumen.pendientes);
    pintar();
  }

  function contador(n) {
    const el = document.getElementById("countUsuariosPendientes");
    if (el) { el.textContent = n; el.style.display = n ? "" : "none"; el.title = n + " registro(s) de proveedor por aprobar"; }
  }

  function pintar() {
    const d = U.datos, r = d.resumen;
    const pendientes = d.usuarios.filter((u) => u.estado === "pendiente");
    const filas = d.usuarios.map((u) => {
      const acciones = [];
      if (u.estado === "pendiente") {
        acciones.push('<button class="btn-primary btn-chico" data-usr="aprobar" data-id="' + u.id + '">Aprobar</button>');
        acciones.push('<button class="btn-secondary btn-chico" data-usr="rechazar" data-id="' + u.id + '">Rechazar</button>');
      } else {
        acciones.push('<button class="btn-secondary btn-chico" data-usr="editar" data-id="' + u.id + '">Editar</button>');
        acciones.push('<button class="btn-secondary btn-chico" data-usr="password" data-id="' + u.id + '">Contraseña</button>');
      }
      if (u.bloqueado) acciones.push('<button class="btn-secondary btn-chico" data-usr="desbloquear" data-id="' + u.id + '">Desbloquear</button>');
      if (u.id !== d.yo) acciones.push('<button class="btn-secondary btn-chico btn-peligro" data-usr="eliminar" data-id="' + u.id + '" title="Eliminar usuario" aria-label="Eliminar usuario">🗑</button>');
      // El usuario para entrar casi siempre es el correo; el correo aparte solo se muestra si es distinto (cuentas antiguas)
      const correoAparte = u.email && u.email.toLowerCase() !== u.usuario.toLowerCase()
        ? "<div class='texto-suave'>" + esc(u.email) + "</div>"
        : !u.email ? " <span class='etiqueta gris' title='Sin correo no puede recuperar su contraseña'>Sin correo</span>" : "";
      return "<tr><td class='envuelve'><b>" + esc(u.nombre || u.usuario) + "</b>" + (u.id === d.yo ? " <span class='etiqueta'>Tú</span>" : "") + "<div class='texto-suave'>" + esc(u.usuario) + correoAparte + "</div></td>" +
        "<td>" + esc(TIPOS[u.tipo] || u.tipo) + "</td>" +
        "<td class='envuelve'>" + (u.proveedor_nombre ? esc(u.proveedor_nombre) : u.registro && u.registro.empresa ? "<span class='texto-suave'>" + esc(u.registro.empresa) + "</span>" : "—") + "</td>" +
        "<td class='envuelve'>" + estadoDe(u) + "</td><td>" + (u.ultimo_acceso ? esc(hace(u.ultimo_acceso)) : "<span class='texto-suave'>Nunca</span>") + "</td>" +
        "<td><div class='fila-acciones'>" + acciones.join("") + "</div></td></tr>";
    }).join("");

    const bloquePendientes = pendientes.length && !U.estado
      ? '<div class="card" style="border-color:var(--second)"><p class="section-title">Proveedores que se registraron y esperan aprobación</p>' +
        pendientes.map((u) => {
          const g = u.registro || {};
          return '<div class="file-row"><div class="meta"><span class="name">' + esc(g.empresa || u.nombre) + (g.nit ? " · NIT " + esc(g.nit) : "") + "</span>" +
            '<span class="sub">' + esc(u.email) + (g.contacto ? " · " + esc(g.contacto) : "") + (g.telefono ? " · Tel. " + esc(g.telefono) : "") + " · " + esc(hace(u.creado_en)) + "</span>" +
            (u.sugerencia_proveedor ? '<span class="sub">Parece ser: <b>' + esc(u.sugerencia_proveedor) + "</b></span>" : '<span class="sub">No se parece a ningún proveedor registrado.</span>') + "</div>" +
            '<div class="fila-acciones"><button class="btn-primary btn-chico" data-usr="aprobar" data-id="' + u.id + '">Aprobar</button><button class="btn-secondary btn-chico" data-usr="rechazar" data-id="' + u.id + '">Rechazar</button></div></div>';
        }).join("") + "</div>"
      : "";

    raiz.innerHTML =
      '<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">' +
      '<div><p class="section-title" style="margin:0">Usuarios</p><p class="texto-suave" style="margin:6px 0 0;max-width:620px">Administradores, Planeación de la demanda y proveedores. Los proveedores pueden registrarse solos desde la página de ingreso; entran cuando los apruebas y los vinculas a su proveedor.</p></div>' +
      '<div class="fila-acciones"><button class="btn-secondary" data-usr="bitacora">Bitácora de seguridad</button><button class="btn-primary" data-usr="nuevo">+ Nuevo usuario</button></div></div></div>' +
      '<div class="metricas"><div class="metrica"><span>Usuarios</span><b>' + r.total + '</b></div><div class="metrica"><span>Administradores</span><b>' + r.admin + "</b></div>" +
      '<div class="metrica"><span>Planeación</span><b>' + r.planeacion + '</b></div><div class="metrica"><span>Proveedores</span><b>' + r.proveedor + "</b></div>" +
      '<div class="metrica"><span>Por aprobar</span><b>' + r.pendientes + "</b></div></div>" +
      bloquePendientes +
      '<div class="card"><div class="fila-acciones" style="margin-bottom:12px">' +
      '<input id="usrBuscar" class="campo" style="width:280px" placeholder="Buscar por nombre, correo, usuario o proveedor…" value="' + esc(U.q) + '">' +
      '<select id="usrTipo" class="manual-input" style="width:auto"><option value="">Todos los tipos</option>' + Object.entries(TIPOS).map(([k, v]) => '<option value="' + k + '"' + (U.tipo === k ? " selected" : "") + ">" + v + "</option>").join("") + "</select>" +
      '<select id="usrEstado" class="manual-input" style="width:auto">' + [["", "Todos los estados"], ["activo", "Activos"], ["inactivo", "Inactivos"], ["pendiente", "Pendientes"], ["rechazado", "Rechazados"], ["bloqueado", "Bloqueados"]]
        .map(([k, v]) => '<option value="' + k + '"' + (U.estado === k ? " selected" : "") + ">" + v + "</option>").join("") + "</select></div>" +
      (filas ? '<div class="table-scroll"><table><thead><tr><th>Nombre / usuario</th><th>Tipo</th><th>Proveedor</th><th>Estado</th><th>Último ingreso</th><th></th></tr></thead><tbody>' + filas + "</tbody></table></div>"
        : '<p class="texto-suave">Ningún usuario coincide con la búsqueda.</p>') + "</div>";
  }

  const usuario = (id) => U.datos.usuarios.find((u) => String(u.id) === String(id));

  // ---------- Crear y editar ----------
  function formularioUsuario(u) {
    const nuevo = !u;
    const tipo = u ? u.tipo : "planeacion";
    const m = modal(nuevo ? "Nuevo usuario" : "Editar usuario",
      '<form id="fUsr" autocomplete="off"><div class="form-grid">' +
      '<div><label for="fuNombre">Nombre</label><input id="fuNombre" class="campo" maxlength="120" required value="' + esc(u ? u.nombre : "") + '"></div>' +
      '<div><label for="fuEmail">Correo (es el usuario para entrar)</label><input id="fuEmail" type="email" class="campo" maxlength="160"' + (nuevo || u.email ? " required" : "") + ' value="' + esc(u ? u.email : "") + '"></div>' +
      '<div><label for="fuTipo">Tipo</label><select id="fuTipo" class="campo"' + (u && u.id === U.datos.yo ? " disabled" : "") + ">" + Object.entries(TIPOS).map(([k, v]) => '<option value="' + k + '"' + (k === tipo ? " selected" : "") + ">" + v + "</option>").join("") + "</select></div>" +
      '<div id="fuProvCaja"><label for="fuProv">Proveedor</label><select id="fuProv" class="campo">' + opcionesProveedor(u ? u.proveedor_nombre : "") + "</select></div>" +
      (u && ["activo", "inactivo"].includes(u.estado) && u.id !== U.datos.yo
        ? '<div><label for="fuEstado">Estado</label><select id="fuEstado" class="campo"><option value="activo"' + (u.estado === "activo" ? " selected" : "") + '>Activo</option><option value="inactivo"' + (u.estado === "inactivo" ? " selected" : "") + ">Inactivo (no puede entrar)</option></select></div>"
        : "") +
      "</div>" +
      (nuevo
        ? '<div style="margin-top:14px"><label class="texto-suave"><input type="checkbox" id="fuInvitar"> Enviarle un enlace por correo para que él mismo defina su contraseña</label></div>' +
          '<div id="fuPassCaja" class="form-grid" style="margin-top:10px"><div><label for="fuPass">Contraseña inicial</label><div class="fila-acciones" style="flex-wrap:nowrap"><input id="fuPass" class="campo" autocomplete="new-password"><button type="button" class="btn-secondary btn-chico" id="fuGenerar">Generar</button></div></div>' +
          '<div style="align-self:end"><label class="texto-suave"><input type="checkbox" id="fuCambiar" checked> Pedir que la cambie al entrar</label></div></div>'
        : "") +
      '<p class="texto-suave" style="margin:10px 0 0">Las contraseñas deben tener mínimo 8 caracteres, con letras y números.</p>' +
      '<div id="fuError" class="nota error" style="display:none;margin-top:12px"></div>' +
      '<div class="fila-acciones derecha" style="margin-top:16px"><button type="button" class="btn-secondary" data-cerrar>Cancelar</button><button type="submit" class="btn-primary">' + (nuevo ? "Crear usuario" : "Guardar") + "</button></div></form>", { ancho: 640 });
    const $ = (s) => m.caja.querySelector(s);
    const verProveedor = () => { $("#fuProvCaja").style.display = $("#fuTipo").value === "proveedor" ? "" : "none"; };
    verProveedor();
    $("#fuTipo").addEventListener("change", verProveedor);
    if (nuevo) {
      $("#fuGenerar").addEventListener("click", () => { $("#fuPass").value = generarPassword(); });
      $("#fuInvitar").addEventListener("change", () => { $("#fuPassCaja").style.display = $("#fuInvitar").checked ? "none" : ""; });
    }
    $("#fUsr").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const error = $("#fuError");
      error.style.display = "none";
      const cuerpo = { nombre: $("#fuNombre").value, email: $("#fuEmail").value, tipo: $("#fuTipo").value, proveedor_nombre: $("#fuProv").value };
      try {
        if (nuevo) {
          const invitar = $("#fuInvitar").checked;
          Object.assign(cuerpo, { enviar_invitacion: invitar, password: invitar ? "" : $("#fuPass").value, debe_cambiar_password: $("#fuCambiar").checked });
          const r = await api("/api/usuarios", { method: "POST", json: cuerpo });
          m.cerrar();
          if (invitar) toast(r.correoEnviado ? "Usuario creado. Le enviamos el enlace por correo." : "Usuario creado, pero el correo no salió (revisa la configuración SMTP). Usa «Contraseña» para asignarle una.");
          else toast("Usuario creado. Entrégale su usuario (" + cuerpo.email.trim().toLowerCase() + ") y la contraseña inicial.");
        } else {
          if ($("#fuEstado")) cuerpo.estado = $("#fuEstado").value;
          if ($("#fuTipo").disabled) delete cuerpo.tipo;
          await api("/api/usuarios/" + u.id, { method: "PUT", json: cuerpo });
          m.cerrar();
          toast("Cambios guardados.");
        }
        await cargar();
      } catch (err) {
        error.textContent = err.message;
        error.style.display = "block";
      }
    });
  }

  // ---------- Contraseña ----------
  function formularioPassword(u) {
    const esYo = u.id === U.datos.yo;
    const m = modal("Contraseña de " + (u.nombre || u.usuario),
      '<form id="fPass" autocomplete="off"><label class="etiqueta-campo" for="fpPass">Contraseña nueva</label>' +
      '<div class="fila-acciones" style="flex-wrap:nowrap"><input id="fpPass" class="campo" autocomplete="new-password" required><button type="button" class="btn-secondary btn-chico" id="fpGenerar">Generar</button></div>' +
      (esYo ? "" : '<label class="texto-suave" style="display:block;margin-top:10px"><input type="checkbox" id="fpCambiar" checked> Pedir que la cambie al entrar (contraseña temporal)</label>') +
      '<p class="texto-suave" style="margin:10px 0 0">Mínimo 8 caracteres, con letras y números. Se cierran sus sesiones abiertas y se quita el bloqueo, si lo tenía.</p>' +
      (u.email && u.estado === "activo" && !esYo ? '<div class="nota" style="margin-top:12px">También puedes <a href="#" id="fpEnlace">enviarle un enlace a ' + esc(u.email) + "</a> para que la defina él mismo.</div>" : "") +
      '<div id="fpError" class="nota error" style="display:none;margin-top:12px"></div>' +
      '<div class="fila-acciones derecha" style="margin-top:16px"><button type="button" class="btn-secondary" data-cerrar>Cancelar</button><button type="submit" class="btn-primary">Guardar contraseña</button></div></form>', { ancho: 460 });
    const $ = (s) => m.caja.querySelector(s);
    $("#fpGenerar").addEventListener("click", () => { $("#fpPass").value = generarPassword(); });
    if ($("#fpEnlace")) $("#fpEnlace").addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        const r = await api("/api/usuarios/" + u.id + "/enlace", { method: "POST" });
        m.cerrar();
        toast(r.correoEnviado ? "Enlace enviado a " + u.email + "." : "No se pudo enviar el correo (revisa la configuración SMTP).");
      } catch (err) { toast(err.message); }
    });
    $("#fPass").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await api("/api/usuarios/" + u.id + "/password", { method: "POST", json: { password: $("#fpPass").value, debe_cambiar_password: $("#fpCambiar") ? $("#fpCambiar").checked : false } });
        m.cerrar();
        toast("Contraseña actualizada. Entrégasela por un medio seguro.");
        await cargar();
      } catch (err) {
        $("#fpError").textContent = err.message;
        $("#fpError").style.display = "block";
      }
    });
  }

  // ---------- Aprobar / rechazar registros de proveedores ----------
  function formularioAprobar(u) {
    const g = u.registro || {};
    const sugerido = u.sugerencia_proveedor || "";
    const m = modal("Aprobar proveedor",
      '<p style="margin:0 0 10px"><b>' + esc(g.empresa || u.nombre) + "</b>" + (g.nit ? " · NIT " + esc(g.nit) : "") + '<br><span class="texto-suave">' + esc(u.email) + (g.telefono ? " · Tel. " + esc(g.telefono) : "") + "</span></p>" +
      '<p class="texto-suave">Vincúlalo al proveedor que ya tienes parametrizado: así solo verá las solicitudes de sus productos.</p>' +
      '<label class="texto-suave"><input type="radio" name="faModo" value="existente" checked> Es un proveedor que ya existe</label>' +
      '<select id="faProv" class="campo" style="margin:6px 0 12px">' + opcionesProveedor(sugerido) + "</select>" +
      '<label class="texto-suave"><input type="radio" name="faModo" value="nuevo"> Es un proveedor nuevo</label>' +
      '<input id="faNuevo" class="campo" style="margin-top:6px" maxlength="160" value="' + esc(String(g.empresa || "").toUpperCase()) + '" disabled>' +
      '<p class="texto-suave" style="margin:6px 0 0">Si es nuevo, luego asocia sus productos en Configuración para que reciba solicitudes.</p>' +
      '<div id="faError" class="nota error" style="display:none;margin-top:12px"></div>' +
      '<div class="fila-acciones derecha" style="margin-top:16px"><button type="button" class="btn-secondary" data-cerrar>Cancelar</button><button type="button" class="btn-primary" id="faOk">Aprobar y avisarle</button></div>', { ancho: 520 });
    const $ = (s) => m.caja.querySelector(s);
    m.caja.querySelectorAll("input[name=faModo]").forEach((r) => r.addEventListener("change", () => {
      const nuevo = $("input[name=faModo]:checked").value === "nuevo";
      $("#faNuevo").disabled = !nuevo; $("#faProv").disabled = nuevo;
    }));
    $("#faOk").addEventListener("click", async () => {
      const nuevo = $("input[name=faModo]:checked").value === "nuevo";
      try {
        const r = await api("/api/usuarios/" + u.id + "/aprobar", { method: "POST", json: { crear_proveedor: nuevo, proveedor_nombre: nuevo ? $("#faNuevo").value : $("#faProv").value } });
        m.cerrar();
        toast("Aprobado. " + (r.productos ? "Tiene " + r.productos + " producto(s) asociados." : "Aún no tiene productos asociados: asígnaselos en Configuración."));
        await cargar();
      } catch (err) {
        $("#faError").textContent = err.message;
        $("#faError").style.display = "block";
      }
    });
  }

  function formularioRechazar(u) {
    const m = modal("Rechazar registro",
      '<p style="margin:0 0 10px">' + esc((u.registro && u.registro.empresa) || u.nombre) + " · " + esc(u.email) + "</p>" +
      '<label class="etiqueta-campo" for="frMotivo">Motivo (se le envía por correo, opcional)</label><input id="frMotivo" class="campo" maxlength="300">' +
      '<div class="fila-acciones derecha" style="margin-top:16px"><button type="button" class="btn-secondary" data-cerrar>Cancelar</button><button type="button" class="btn-primary btn-peligro" id="frOk">Rechazar</button></div>', { ancho: 460 });
    m.caja.querySelector("#frOk").addEventListener("click", async () => {
      try {
        await api("/api/usuarios/" + u.id + "/rechazar", { method: "POST", json: { motivo: m.caja.querySelector("#frMotivo").value } });
        m.cerrar(); toast("Registro rechazado."); await cargar();
      } catch (err) { toast(err.message); }
    });
  }

  const ACCIONES_BITACORA = {
    login: "Ingreso", login_fallido: "Ingreso fallido", cuenta_bloqueada: "Cuenta bloqueada", cambio_password: "Cambió su contraseña",
    cambio_password_fallido: "Cambio de contraseña fallido", recuperacion_solicitada: "Pidió recuperar contraseña", recuperacion_sin_correo: "Pidió recuperar (sin correo registrado)",
    password_restablecida: "Restableció su contraseña", password_definida: "Definió su contraseña", registro_proveedor: "Registro de proveedor",
    usuario_creado: "Usuario creado", usuario_editado: "Usuario editado", usuario_eliminado: "Usuario eliminado", password_asignada: "Contraseña asignada por el admin",
    enlace_enviado: "Enlace de contraseña enviado", usuario_desbloqueado: "Usuario desbloqueado", proveedor_aprobado: "Proveedor aprobado", proveedor_rechazado: "Proveedor rechazado",
    subasta_creada: "Subasta creada", subasta_enviada: "Subasta enviada", subasta_cerrada: "Subasta cerrada", subasta_reabierta: "Subasta reabierta", subasta_eliminada: "Subasta eliminada",
    oferta_enviada: "Oferta del proveedor", contrapropuesta_respondida: "Respuesta a contrapropuesta",
  };

  async function verBitacora() {
    const filas = await api("/api/usuarios/bitacora?limite=300");
    modal("Bitácora de seguridad (últimos 300 eventos)",
      '<div class="table-scroll" style="max-height:60vh"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Evento</th><th>Detalle</th><th>IP</th></tr></thead><tbody>' +
      filas.map((b) => "<tr><td>" + esc(fecha(b.creado_en)) + "</td><td>" + esc(b.usuario || "—") + "</td><td>" + esc(ACCIONES_BITACORA[b.accion] || b.accion) + "</td><td class='envuelve'>" + esc(b.detalle || "") + "</td><td>" + esc(b.ip || "") + "</td></tr>").join("") +
      "</tbody></table></div>", { ancho: 980 });
  }

  raiz.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-usr]");
    if (!el) return;
    const u = el.dataset.id ? usuario(el.dataset.id) : null;
    try {
      switch (el.dataset.usr) {
        case "nuevo": formularioUsuario(null); break;
        case "editar": formularioUsuario(u); break;
        case "password": formularioPassword(u); break;
        case "aprobar": formularioAprobar(u); break;
        case "rechazar": formularioRechazar(u); break;
        case "bitacora": await verBitacora(); break;
        case "desbloquear": await api("/api/usuarios/" + u.id + "/desbloquear", { method: "POST" }); toast("Usuario desbloqueado."); await cargar(); break;
        case "eliminar":
          if (!confirm("¿Eliminar a " + (u.nombre || u.usuario) + "? Ya no podrá entrar. Esta acción no se puede deshacer.\n\nSi solo quieres quitarle el acceso por un tiempo, edítalo y déjalo Inactivo.")) return;
          await api("/api/usuarios/" + u.id, { method: "DELETE" }); toast("Usuario eliminado."); await cargar(); break;
      }
    } catch (err) {
      toast(err.message);
    }
  });

  let espera = null;
  raiz.addEventListener("input", (ev) => {
    if (ev.target.id !== "usrBuscar") return;
    U.q = ev.target.value;
    clearTimeout(espera);
    espera = setTimeout(() => cargar().then(() => {
      const b = document.getElementById("usrBuscar");
      if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
    }).catch((err) => toast(err.message)), 300);
  });
  raiz.addEventListener("change", (ev) => {
    if (ev.target.id === "usrTipo") { U.tipo = ev.target.value; cargar().catch((err) => toast(err.message)); }
    if (ev.target.id === "usrEstado") { U.estado = ev.target.value; cargar().catch((err) => toast(err.message)); }
  });

  C.registrarPestana("usuarios", cargar);
  // Número de registros por aprobar en el menú (y se actualiza cuando llega un aviso nuevo)
  const revisarPendientes = () => api("/api/usuarios?estado=pendiente").then((d) => contador(d.resumen.pendientes)).catch(() => {});
  revisarPendientes();
  document.addEventListener("avisos:nuevos", revisarPendientes);
})();
