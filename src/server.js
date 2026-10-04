const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const XLSX = require("xlsx");

const db = require("./db");
const { parseWorkbook } = require("./parser");
const ExcelJS = require("exceljs");
const fs = require("fs");
const {
  computeComparativo, computeDashboard, computeAlertas, computeAgrupamiento, computeVistaProveedor,
  calcularSemanaVigencia, calcularVentanaRecepcion, estadoEfectivoCiclo,
} = require("./analytics");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_ENV = process.env.APP_ENV || "produccion";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error("Solo se aceptan archivos .xlsx o .xls"), ok);
  },
});

app.use(express.json());
app.use(cookieParser());
require("./ordenes_compra")(app, requireAdmin);
require("./negociacion_hoja")(app, requireAdmin);
const BANNER_PRUEBAS = `(function () {
  function poner() {
    var b = document.createElement("div");
    b.textContent = "ENTORNO DE PRUEBAS: los datos son una copia y nada de aquí afecta a producción";
    b.style.cssText = "position:sticky;top:0;z-index:99999;background:#b3261e;color:#fff;text-align:center;padding:6px 10px;font:600 13px Calibri,Arial,sans-serif";
    document.body.insertBefore(b, document.body.firstChild);
    document.title = "[PRUEBAS] " + document.title;
  }
  if (document.body) poner(); else document.addEventListener("DOMContentLoaded", poner);
})();`;
// Marca de entorno: en desarrollo agrega una franja roja a cada página; en producción devuelve un script vacío
app.get("/entorno.js", (req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store");
  res.send(APP_ENV === "dev" ? BANNER_PRUEBAS : "");
});
app.use(express.static(path.join(__dirname, "..", "public")));

const SESION_DIAS = 7;
const COOKIE_NAME = process.env.COOKIE_NAME || "sesion_token";

function getUsuarioDeSesion(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  const fila = db.prepare(`
    SELECT u.id, u.usuario, u.tipo, u.proveedor_nombre, s.expira_en
    FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ?
  `).get(token);
  if (!fila) return null;
  if (new Date(fila.expira_en) < new Date()) {
    db.prepare("DELETE FROM sesiones WHERE token = ?").run(token);
    return null;
  }
  return fila;
}

function requireAdmin(req, res, next) {
  const usuario = getUsuarioDeSesion(req);
  if (!usuario || usuario.tipo !== "admin") {
    return res.status(401).json({ error: "No autorizado. Inicia sesión." });
  }
  req.usuarioActual = usuario;
  next();
}

app.post("/api/auth/login", (req, res) => {
  const { usuario, password } = req.body || {};
  const nombreUsuario = usuario ? String(usuario).trim() : "";
  if (!nombreUsuario || !password) {
    return res.status(400).json({ error: "Falta usuario o contraseña." });
  }
  const fila = db.prepare("SELECT * FROM usuarios WHERE usuario = ?").get(nombreUsuario);
  if (!fila) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });

  const hashIntento = db.hashPassword(password, fila.password_salt);
  if (hashIntento !== fila.password_hash) {
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expira = new Date(Date.now() + SESION_DIAS * 24 * 60 * 60 * 1000);
  db.prepare("INSERT INTO sesiones (token, usuario_id, expira_en, creado_en) VALUES (?, ?, ?, ?)")
    .run(token, fila.id, expira.toISOString(), new Date().toISOString());

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESION_DIAS * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, usuario: fila.usuario, tipo: fila.tipo, proveedorNombre: fila.proveedor_nombre });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) db.prepare("DELETE FROM sesiones WHERE token = ?").run(token);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const usuario = getUsuarioDeSesion(req);
  if (!usuario) return res.status(401).json({ error: "No hay sesión activa." });
  res.json({ usuario: usuario.usuario, tipo: usuario.tipo, proveedorNombre: usuario.proveedor_nombre });
});

app.post("/api/auth/solicitar-codigo", (req, res) => {
  const { usuario } = req.body || {};
  const nombreUsuario = usuario ? String(usuario).trim() : "";
  if (nombreUsuario) {
    const fila = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get(nombreUsuario);
    if (fila) {
      const codigo = String(crypto.randomInt(100000, 999999));
      const expira = new Date(Date.now() + 15 * 60 * 1000);
      db.prepare(`
        INSERT INTO codigos_recuperacion (usuario, codigo, expira_en, creado_en)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(usuario) DO UPDATE SET codigo = excluded.codigo, expira_en = excluded.expira_en, creado_en = excluded.creado_en
      `).run(nombreUsuario, codigo, expira.toISOString(), new Date().toISOString());
      console.log("=".repeat(60));
      console.log("CÓDIGO DE RECUPERACIÓN SOLICITADO");
      console.log("  usuario: " + nombreUsuario);
      console.log("  código:  " + codigo + "  (válido 15 minutos)");
      console.log("=".repeat(60));
    }
  }
  res.json({ ok: true });
});

app.post("/api/auth/resetear-password", (req, res) => {
  const { usuario, codigo, nuevaPassword } = req.body || {};
  const nombreUsuario = usuario ? String(usuario).trim() : "";
  const codigoIntento = codigo ? String(codigo).trim() : "";
  if (!nombreUsuario || !codigoIntento || !nuevaPassword) {
    return res.status(400).json({ error: "Faltan datos." });
  }
  if (String(nuevaPassword).length < 6) {
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres." });
  }

  const fila = db.prepare("SELECT * FROM codigos_recuperacion WHERE usuario = ?").get(nombreUsuario);
  if (!fila || fila.codigo !== codigoIntento) {
    return res.status(401).json({ error: "Código incorrecto." });
  }
  if (new Date(fila.expira_en) < new Date()) {
    db.prepare("DELETE FROM codigos_recuperacion WHERE usuario = ?").run(nombreUsuario);
    return res.status(401).json({ error: "El código expiró. Solicita uno nuevo." });
  }

  const usuarioFila = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get(nombreUsuario);
  if (!usuarioFila) return res.status(404).json({ error: "Usuario no encontrado." });

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = db.hashPassword(nuevaPassword, salt);
  const resetear = db.transaction(() => {
    db.prepare("UPDATE usuarios SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, usuarioFila.id);
    db.prepare("DELETE FROM codigos_recuperacion WHERE usuario = ?").run(nombreUsuario);
    db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(usuarioFila.id);
  });
  resetear();

  res.json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// todo lo que sigue bajo /api requiere sesión de administrador activa

function requireProveedor(req, res, next) {
  const usuario = getUsuarioDeSesion(req);

  if (!usuario || usuario.tipo !== "proveedor") {
    return res.status(401).json({
      error: "No autorizado como proveedor."
    });
  }

  req.usuarioActual = usuario;
  next();
}


// ======================================================
// PORTAL DE PROVEEDORES
// Estas rutas están ANTES del middleware requireAdmin
// ======================================================

app.get("/api/proveedor/portal", requireProveedor, (req, res) => {
  try {
    const proveedor = req.usuarioActual.proveedor_nombre;

    const ciclo = obtenerCicloActivo();

    const productos = db.prepare(`
      SELECT
        pp.codigo,
        pp.tipo,
        pp.frecuencia,
        pp.presentacion_proveedor,
        c.producto,
        c.presentacion
      FROM proveedor_productos pp
      LEFT JOIN catalogo c
        ON c.codigo = pp.codigo
      WHERE pp.proveedor = ?
        AND pp.activo = 1
      ORDER BY
        CASE WHEN pp.tipo = 'habitual' THEN 0 ELSE 1 END,
        COALESCE(c.producto, pp.codigo)
    `).all(proveedor);

    let cotizados = {};

    if (ciclo) {
      const filas = db.prepare(`
        SELECT
          q.codigo,
          q.precio,
          q.disponibilidad,
          q.observacion
        FROM quotes q
        INNER JOIN files f
          ON f.id = q.file_id
        WHERE q.proveedor = ?
          AND q.ciclo_id = ?
          AND f.name = ?
      `).all(
        proveedor,
        ciclo.id,
        "Portal proveedor - " + ciclo.id
      );

      filas.forEach(r => {
        cotizados[r.codigo] = {
          precio: r.precio,
          disponibilidad: r.disponibilidad,
          observacion: r.observacion
        };
      });
    }

    const items = productos.map(p => ({
      codigo: p.codigo,
      producto: p.producto || "",
      presentacion:
        p.presentacion_proveedor ||
        p.presentacion ||
        "",
      tipo: p.tipo,
      frecuencia: p.frecuencia,
      propuesta: cotizados[p.codigo] || null
    }));

    res.json({
      proveedor,
      usuario: req.usuarioActual.usuario,
      ciclo: ciclo || null,
      puedeCotizar: !!(
        ciclo &&
        !ciclo.cerrado_en
      ),
      habituales: items.filter(x => x.tipo === "habitual"),
      adicionales: items.filter(x => x.tipo !== "habitual")
    });

  } catch (err) {
    console.error("Error portal proveedor:", err);
    res.status(500).json({
      error: "No se pudo cargar el portal del proveedor."
    });
  }
});


app.post("/api/proveedor/propuesta", requireProveedor, (req, res) => {
  try {
    const proveedor = req.usuarioActual.proveedor_nombre;
    const ciclo = obtenerCicloActivo();

    if (!ciclo) {
      return res.status(409).json({
        error: "Mercaldas no tiene un ciclo de cotización activo."
      });
    }

    if (ciclo.cerrado_en) {
      return res.status(409).json({
        error: "El ciclo de cotización ya está cerrado."
      });
    }

    const items = Array.isArray(req.body?.items)
      ? req.body.items
      : [];

    if (!items.length) {
      return res.status(400).json({
        error: "No se recibieron productos para cotizar."
      });
    }

    const permitidos = new Map();

    db.prepare(`
      SELECT
        pp.codigo,
        pp.tipo,
        c.producto,
        COALESCE(pp.presentacion_proveedor, c.presentacion) AS presentacion
      FROM proveedor_productos pp
      LEFT JOIN catalogo c ON c.codigo = pp.codigo
      WHERE pp.proveedor = ?
        AND pp.activo = 1
    `).all(proveedor).forEach(p => {
      permitidos.set(String(p.codigo), p);
    });

    const validos = [];

    for (const item of items) {
      const codigo = String(item.codigo || "").trim();

      if (!permitidos.has(codigo)) {
        continue;
      }

      const precio = Number(item.precio);

      if (!Number.isFinite(precio) || precio <= 0) {
        continue;
      }

      const p = permitidos.get(codigo);

      validos.push({
        codigo,
        precio,
        producto: p.producto || "",
        presentacion: p.presentacion || "",
        disponibilidad:
          item.disponibilidad
            ? String(item.disponibilidad).trim()
            : null,
        observacion:
          item.observacion
            ? String(item.observacion).trim()
            : null
      });
    }

    if (!validos.length) {
      return res.status(400).json({
        error: "Debes ingresar al menos un precio válido."
      });
    }

    const nombreArchivo = "Portal proveedor - " + ciclo.id;

    let archivo = db.prepare(`
      SELECT id
      FROM files
      WHERE proveedor = ?
        AND ciclo_id = ?
        AND name = ?
      LIMIT 1
    `).get(proveedor, ciclo.id, nombreArchivo);

    const guardar = db.transaction(() => {
      let fileId;

      if (archivo) {
        fileId = archivo.id;

        db.prepare(`
          DELETE FROM quotes
          WHERE file_id = ?
        `).run(fileId);

        db.prepare(`
          UPDATE files
          SET uploaded_at = ?
          WHERE id = ?
        `).run(new Date().toISOString(), fileId);

      } else {
        fileId = crypto.randomUUID();

        db.prepare(`
          INSERT INTO files
          (
            id,
            name,
            proveedor,
            semana,
            fecha_envio,
            uploaded_at,
            ciclo_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          fileId,
          nombreArchivo,
          proveedor,
          ciclo.id,
          new Date().toISOString().slice(0, 10),
          new Date().toISOString(),
          ciclo.id
        );
      }

      const insertQuote = db.prepare(`
        INSERT INTO quotes
        (
          file_id,
          codigo,
          producto,
          presentacion,
          disponibilidad,
          precio,
          observacion,
          proveedor,
          semana,
          vigencia_fin,
          ciclo_id
        )
        VALUES
        (
          @file_id,
          @codigo,
          @producto,
          @presentacion,
          @disponibilidad,
          @precio,
          @observacion,
          @proveedor,
          @semana,
          @vigencia_fin,
          @ciclo_id
        )
      `);

      for (const item of validos) {
        insertQuote.run({
          file_id: fileId,
          codigo: item.codigo,
          producto: item.producto,
          presentacion: item.presentacion,
          disponibilidad: item.disponibilidad,
          precio: item.precio,
          observacion: item.observacion,
          proveedor,
          semana: ciclo.id,
          vigencia_fin: ciclo.fecha_fin_vigencia,
          ciclo_id: ciclo.id
        });
      }

      return fileId;
    });

    guardar();

    res.json({
      ok: true,
      proveedor,
      ciclo: ciclo.id,
      nProductos: validos.length,
      mensaje: "Propuesta comercial guardada."
    });

  } catch (err) {
    console.error("Error guardando propuesta proveedor:", err);

    res.status(500).json({
      error: "No se pudo guardar la propuesta comercial."
    });
  }
});





// ======================================================
// EXCEL DE COTIZACIÓN PARA EL PROVEEDOR
// ======================================================

app.get("/api/proveedor/plantilla-cotizacion", requireProveedor, (req, res) => {
  try {
    const proveedor = req.usuarioActual.proveedor_nombre;
    const ciclo = obtenerCicloActivo();

    if (!ciclo) {
      return res.status(409).json({
        error: "Mercaldas todavía no tiene un ciclo de cotización activo."
      });
    }

    const productos = db.prepare(`
      SELECT
        pp.codigo,
        pp.tipo,
        pp.frecuencia,
        COALESCE(pp.presentacion_proveedor, c.presentacion, '') AS presentacion,
        COALESCE(c.producto, '') AS producto
      FROM proveedor_productos pp
      LEFT JOIN catalogo c ON c.codigo = pp.codigo
      WHERE pp.proveedor = ?
        AND pp.activo = 1
      ORDER BY
        CASE WHEN pp.tipo = 'habitual' THEN 0 ELSE 1 END,
        c.producto
    `).all(proveedor);

    const cotizacionesActuales = new Map();

    db.prepare(`
      SELECT codigo, precio, disponibilidad, observacion
      FROM quotes
      WHERE proveedor = ?
        AND ciclo_id = ?
      ORDER BY id DESC
    `).all(proveedor, ciclo.id).forEach(q => {
      if (!cotizacionesActuales.has(String(q.codigo))) {
        cotizacionesActuales.set(String(q.codigo), q);
      }
    });

    const filas = productos.map(p => {
      const actual = cotizacionesActuales.get(String(p.codigo));

      return {
        "PLU": p.codigo,
        "Producto": p.producto,
        "Presentación": p.presentacion,
        "Tipo": p.tipo,
        "Frecuencia": p.frecuencia,
        "Ofertar esta semana": p.tipo === "habitual"
          ? "SI"
          : (actual ? "SI" : "NO"),
        "Precio": actual ? actual.precio : "",
        "Disponibilidad": actual ? (actual.disponibilidad || "") : "",
        "Observación": actual ? (actual.observacion || "") : ""
      };
    });

    const ws = XLSX.utils.json_to_sheet(filas);

    ws["!cols"] = [
      { wch: 12 },
      { wch: 34 },
      { wch: 18 },
      { wch: 14 },
      { wch: 14 },
      { wch: 20 },
      { wch: 15 },
      { wch: 18 },
      { wch: 35 }
    ];

    const instrucciones = [
      ["PORTAL DE PROVEEDORES MERCALDAS", ""],
      ["Proveedor", proveedor],
      ["Ciclo de cotización", ciclo.id],
      ["Inicio recepción", ciclo.fecha_inicio_recepcion],
      ["Fin recepción", ciclo.fecha_fin_recepcion],
      ["Inicio vigencia", ciclo.fecha_inicio_vigencia],
      ["Fin vigencia", ciclo.fecha_fin_vigencia],
      ["", ""],
      ["INSTRUCCIONES", ""],
      ["1", "No cambie el PLU ni el nombre del producto."],
      ["2", "Ingrese el precio únicamente de los productos que desea cotizar."],
      ["3", "Para productos adicionales use SI o NO en 'Ofertar esta semana'."],
      ["4", "El sistema solo aceptará PLU asociados a su empresa."],
      ["5", "La semana se asigna automáticamente según el ciclo abierto por Mercaldas."]
    ];

    const wsInfo = XLSX.utils.aoa_to_sheet(instrucciones);
    wsInfo["!cols"] = [{ wch: 24 }, { wch: 75 }];

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
      wb,
      ws,
      "Cotizacion"
    );

    XLSX.utils.book_append_sheet(
      wb,
      wsInfo,
      "Instrucciones"
    );

    const buffer = XLSX.write(wb, {
      bookType: "xlsx",
      type: "buffer"
    });

    const nombreSeguro = proveedor
      .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+/g, "_")
      .replace(/^_+|_+$/g, "");

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="Cotizacion_' +
        nombreSeguro +
        "_" +
        ciclo.id +
        '.xlsx"'
    );

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.send(buffer);

  } catch (err) {
    console.error("Error plantilla proveedor:", err);

    res.status(500).json({
      error: "No se pudo generar la plantilla de cotización."
    });
  }
});


app.post(
  "/api/proveedor/importar-cotizacion",
  requireProveedor,
  upload.single("archivo"),
  (req, res) => {

    try {
      const proveedor = req.usuarioActual.proveedor_nombre;
      const ciclo = obtenerCicloActivo();

      if (!ciclo) {
        return res.status(409).json({
          error: "Mercaldas no tiene un ciclo de cotización activo."
        });
      }

      if (ciclo.cerrado_en) {
        return res.status(409).json({
          error: "El ciclo de cotización está cerrado."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "No se recibió el archivo Excel."
        });
      }

      const wb = XLSX.read(req.file.buffer, {
        type: "buffer"
      });

      const ws =
        wb.Sheets["Cotizacion"] ||
        wb.Sheets["Cotización"] ||
        wb.Sheets[wb.SheetNames[0]];

      // =====================================================
      // LECTURA DEL EXCEL CON DOS SECCIONES
      // Habituales + Temporada / adicionales
      // =====================================================

      const matriz = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: ""
      });

      if (!matriz.length) {
        return res.status(400).json({
          error: "El archivo no contiene productos."
        });
      }


      function normalizarTexto(valor) {
        return String(valor ?? "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toLowerCase();
      }


      function nombreColumna(valor) {
        return normalizarTexto(valor)
          .replace(/\s+/g, " ");
      }


      const permitidos = new Map();

      db.prepare(`
        SELECT
          pp.codigo,
          pp.tipo,
          COALESCE(c.producto, '') AS producto,
          COALESCE(
            pp.presentacion_proveedor,
            c.presentacion,
            ''
          ) AS presentacion
        FROM proveedor_productos pp
        LEFT JOIN catalogo c
          ON c.codigo = pp.codigo
        WHERE pp.proveedor = ?
          AND pp.activo = 1
      `).all(proveedor).forEach(p => {
        permitidos.set(
          String(p.codigo).trim(),
          p
        );
      });


      function precioEntero(valor) {

        if (
          valor === null ||
          valor === undefined ||
          valor === ""
        ) {
          return null;
        }

        if (typeof valor === "number") {
          return valor > 0 ? valor : null;
        }

        const limpio = String(valor)
          .trim()
          .replace(/[^\d]/g, "");

        if (!limpio) return null;

        const n = Number(limpio);

        return Number.isFinite(n) && n > 0
          ? n
          : null;
      }


      const validos = [];
      const errores = [];

      let encabezados = null;
      let seccionActual = null;


      matriz.forEach((fila, indiceFila) => {

        const valores = fila.map(v =>
          String(v ?? "").trim()
        );

        const noVacios = valores.filter(v => v !== "");

        if (!noVacios.length) {
          return;
        }


        // ---------------------------------------------
        // Detectar títulos de las secciones
        // ---------------------------------------------

        const textoFila = normalizarTexto(
          valores.join(" ")
        );

        if (
          textoFila.includes(
            "cotizacion habitual de productos"
          )
        ) {
          seccionActual = "habitual";
          encabezados = null;
          return;
        }

        if (
          textoFila.includes("productos de temporada") ||
          textoFila.includes("otras oportunidades") ||
          textoFila.includes("productos adicionales")
        ) {
          seccionActual = "oportunidades";
          encabezados = null;
          return;
        }


        // ---------------------------------------------
        // Detectar encabezado de cada tabla
        // ---------------------------------------------

        const nombres = valores.map(
          nombreColumna
        );

        const tienePLU =
          nombres.some(x =>
            x === "plu" ||
            x === "codigo"
          );

        const tieneProducto =
          nombres.some(x =>
            x === "producto"
          );

        const tienePrecio =
          nombres.some(x =>
            x === "precio ofertado" ||
            x === "precio"
          );


        if (
          tienePLU &&
          tieneProducto &&
          tienePrecio
        ) {

          encabezados = {};

          nombres.forEach(
            (nombre, posicion) => {

              if (
                nombre === "plu" ||
                nombre === "codigo"
              ) {
                encabezados.codigo = posicion;
              }

              if (
                nombre === "producto"
              ) {
                encabezados.producto = posicion;
              }

              if (
                nombre === "presentacion"
              ) {
                encabezados.presentacion = posicion;
              }

              if (
                nombre === "frecuencia"
              ) {
                encabezados.frecuencia = posicion;
              }

              if (
                nombre === "ofertar esta semana" ||
                nombre === "ofertar"
              ) {
                encabezados.ofertar = posicion;
              }

              if (
                nombre === "precio ofertado" ||
                nombre === "precio"
              ) {
                encabezados.precio = posicion;
              }

              if (
                nombre === "disponibilidad"
              ) {
                encabezados.disponibilidad = posicion;
              }

              if (
                nombre === "observacion"
              ) {
                encabezados.observacion = posicion;
              }

            }
          );

          return;
        }


        // Si todavía no estamos dentro de una tabla,
        // ignoramos títulos y datos generales.
        if (
          !encabezados ||
          encabezados.codigo === undefined
        ) {
          return;
        }


        // Una fila con solamente un texto suele ser
        // título/separador, no producto.
        if (noVacios.length === 1) {
          return;
        }


        const codigo = String(
          valores[encabezados.codigo] || ""
        ).trim();


        if (!codigo) {
          return;
        }


        // ---------------------------------------------
        // Seguridad: el PLU debe pertenecer al proveedor
        // ---------------------------------------------

        if (!permitidos.has(codigo)) {

          errores.push(
            "Fila " +
            (indiceFila + 1) +
            ": el PLU " +
            codigo +
            " no está asociado a " +
            proveedor +
            "."
          );

          return;
        }


        const productoDB =
          permitidos.get(codigo);


        // ---------------------------------------------
        // Validar coherencia de la sección
        // ---------------------------------------------

        if (
          seccionActual === "habitual" &&
          productoDB.tipo !== "habitual"
        ) {

          errores.push(
            "Fila " +
            (indiceFila + 1) +
            ": el PLU " +
            codigo +
            " aparece en Cotización habitual, " +
            "pero está registrado como producto adicional."
          );

          return;
        }


        if (
          seccionActual === "adicional" &&
          productoDB.tipo === "habitual"
        ) {

          errores.push(
            "Fila " +
            (indiceFila + 1) +
            ": el PLU " +
            codigo +
            " aparece como producto de temporada, " +
            "pero está registrado como habitual."
          );

          return;
        }


        // ---------------------------------------------
        // Productos de temporada
        // ---------------------------------------------

        let ofertar = "";

        if (
          encabezados.ofertar !== undefined
        ) {

          ofertar = normalizarTexto(
            valores[encabezados.ofertar]
          ).toUpperCase();

        }


        if (
          productoDB.tipo !== "habitual" &&
          ["NO", "N", "0"].includes(ofertar)
        ) {
          return;
        }


        // ---------------------------------------------
        // Precio
        // ---------------------------------------------

        const precio =
          encabezados.precio !== undefined
            ? precioEntero(
                valores[encabezados.precio]
              )
            : null;


        // Precio vacío = no participa esta semana.
        if (precio === null) {
          return;
        }


        const disponibilidad =
          encabezados.disponibilidad !== undefined
            ? String(
                valores[
                  encabezados.disponibilidad
                ] || ""
              ).trim()
            : "";


        const observacion =
          encabezados.observacion !== undefined
            ? String(
                valores[
                  encabezados.observacion
                ] || ""
              ).trim()
            : "";


        validos.push({
          codigo,
          producto:
            productoDB.producto,
          presentacion:
            productoDB.presentacion,
          precio,
          disponibilidad:
            disponibilidad || null,
          observacion:
            observacion || null,
          tipo:
            productoDB.tipo
        });

      });


      if (!validos.length && !errores.length) {

        return res.status(400).json({
          error:
            "No se encontraron productos con precio para importar. " +
            "Diligencia al menos un precio ofertado."
        });

      }


      if (errores.length) {
        return res.status(400).json({
          error:
            "El archivo contiene PLU que no pertenecen a este proveedor.",
          errores
        });
      }


      if (!validos.length) {
        return res.status(400).json({
          error:
            "No se encontraron productos con precio para importar."
        });
      }


      const nombreArchivo =
        "Portal proveedor - " + ciclo.id;

      let archivo = db.prepare(`
        SELECT id
        FROM files
        WHERE proveedor = ?
          AND ciclo_id = ?
          AND name = ?
        LIMIT 1
      `).get(
        proveedor,
        ciclo.id,
        nombreArchivo
      );


      const guardar = db.transaction(() => {

        let fileId;

        if (archivo) {

          fileId = archivo.id;

          db.prepare(`
            UPDATE files
            SET uploaded_at = ?
            WHERE id = ?
          `).run(
            new Date().toISOString(),
            fileId
          );

        } else {

          fileId = crypto.randomUUID();

          db.prepare(`
            INSERT INTO files
            (
              id,
              name,
              proveedor,
              semana,
              fecha_envio,
              uploaded_at,
              ciclo_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            fileId,
            nombreArchivo,
            proveedor,
            ciclo.id,
            new Date().toISOString().slice(0, 10),
            new Date().toISOString(),
            ciclo.id
          );
        }


        const borrarProducto = db.prepare(`
          DELETE FROM quotes
          WHERE file_id = ?
            AND codigo = ?
        `);


        const insertar = db.prepare(`
          INSERT INTO quotes
          (
            file_id,
            codigo,
            producto,
            presentacion,
            disponibilidad,
            precio,
            observacion,
            proveedor,
            semana,
            vigencia_fin,
            ciclo_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);


        validos.forEach(item => {

          borrarProducto.run(
            fileId,
            item.codigo
          );

          insertar.run(
            fileId,
            item.codigo,
            item.producto,
            item.presentacion,
            item.disponibilidad,
            item.precio,
            item.observacion,
            proveedor,
            ciclo.id,
            ciclo.fecha_fin_vigencia,
            ciclo.id
          );

        });

      });


      guardar();


      res.json({
        ok: true,
        proveedor,
        ciclo: ciclo.id,
        actualizados: validos.length,
        mensaje:
          "Cotización importada correctamente."
      });

    } catch (err) {

      console.error(
        "Error importando Excel proveedor:",
        err
      );

      res.status(400).json({
        error:
          "No se pudo procesar el archivo: " +
          err.message
      });

    }

  }
);



// ======================================================
// LOGO CORPORATIVO MERCALDAS
// ======================================================

app.post(
  "/api/configuracion/logo",
  requireAdmin,
  upload.single("logo"),
  (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error: "No se recibió ninguna imagen."
        });
      }

      const tipo = String(req.file.mimetype || "");

      if (!["image/jpeg", "image/png"].includes(tipo)) {
        return res.status(400).json({
          error: "El logo debe ser JPG o PNG."
        });
      }

      const carpeta =
        require("path").join(
          __dirname,
          "..",
          "public",
          "assets"
        );

      fs.mkdirSync(carpeta, {
        recursive: true
      });

      // Guardamos siempre una versión JPG/PNG según el archivo recibido
      const extension =
        tipo === "image/png"
          ? "png"
          : "jpg";

      // Limpiar logo anterior
      ["jpg", "png"].forEach(ext => {
        const anterior =
          require("path").join(
            carpeta,
            "logo-mercaldas." + ext
          );

        if (fs.existsSync(anterior)) {
          fs.unlinkSync(anterior);
        }
      });

      const destino =
        require("path").join(
          carpeta,
          "logo-mercaldas." + extension
        );

      fs.writeFileSync(
        destino,
        req.file.buffer
      );

      guardarSetting(
        "logo_corporativo",
        "/assets/logo-mercaldas." + extension
      );

      res.json({
        ok: true,
        logo:
          "/assets/logo-mercaldas." + extension
      });

    } catch (err) {

      console.error(
        "Error guardando logo:",
        err
      );

      res.status(500).json({
        error:
          "No se pudo guardar el logo."
      });

    }

  }
);


app.get(
  "/api/configuracion/logo",
  requireAdmin,
  (req, res) => {

    const logo =
      obtenerSetting("logo_corporativo");

    res.json({
      logo: logo || null
    });

  }
);



app.use("/api", requireAdmin);

// ---------- helpers ----------
function getAllQuotes(cicloId) {
  if (cicloId) return db.prepare("SELECT * FROM quotes WHERE ciclo_id = ?").all(cicloId);
  return db.prepare("SELECT * FROM quotes").all();
}
function getAllFiles(cicloId) {
  if (cicloId) {
    return db.prepare(`
      SELECT
        f.*,
        COUNT(q.id) AS n_productos
      FROM files f
      JOIN quotes q ON q.file_id = f.id
      WHERE q.ciclo_id = ?
      GROUP BY f.id
      ORDER BY f.uploaded_at DESC
    `).all(cicloId);
  }

  return db.prepare(`
    SELECT
      f.*,
      COUNT(q.id) AS n_productos
    FROM files f
    LEFT JOIN quotes q ON q.file_id = f.id
    GROUP BY f.id
    ORDER BY f.uploaded_at DESC
  `).all();
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
function upsertProveedor(nombre) {
  if (!nombre) return;
  db.prepare("INSERT OR IGNORE INTO proveedores (nombre, creado_en) VALUES (?, ?)").run(nombre, new Date().toISOString());
}

// ---------- Ciclo de Cotización Mercaldas ----------
function refrescarEstadoCiclo(ciclo, hoy) {
  const estado = estadoEfectivoCiclo(ciclo, hoy);
  if (estado !== ciclo.estado) {
    db.prepare("UPDATE ciclos SET estado = ? WHERE id = ?").run(estado, ciclo.id);
    ciclo.estado = estado;
  }
  return ciclo;
}


function guardarSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function obtenerSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

/*
  Devuelve el jueves correspondiente a una semana ISO.
*/
function juevesSemanaISO(anio, semana) {
  const enero4 = new Date(Date.UTC(anio, 0, 4));
  const dia = enero4.getUTCDay() || 7;

  const lunesSemana1 = new Date(enero4);
  lunesSemana1.setUTCDate(enero4.getUTCDate() - dia + 1);

  const jueves = new Date(lunesSemana1);
  jueves.setUTCDate(
    lunesSemana1.getUTCDate() + ((semana - 1) * 7) + 3
  );

  return jueves.toISOString().slice(0, 10);
}

function obtenerOCrearCicloPorSemana(anio, semana) {
  const codigo = "COT-" + anio + "-" + String(semana).padStart(2, "0");

  let ciclo = db.prepare(
    "SELECT * FROM ciclos WHERE id = ?"
  ).get(codigo);

  if (ciclo) return ciclo;

  // El número es la semana en que RIGE: la recepción es el jueves de la semana anterior
  const juevesVigencia = juevesSemanaISO(anio, semana);
  const dRecepcion = new Date(juevesVigencia + "T00:00:00Z");
  dRecepcion.setUTCDate(dRecepcion.getUTCDate() - 7);
  const jueves = dRecepcion.toISOString().slice(0, 10);
  const ventana = calcularVentanaRecepcion(jueves);

  db.prepare(`
    INSERT INTO ciclos (
      id,
      anio,
      semana_calendario,
      fecha_inicio_recepcion,
      fecha_fin_recepcion,
      fecha_inicio_vigencia,
      fecha_fin_vigencia,
      estado,
      creado_en
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    codigo,
    anio,
    semana,
    ventana.fecha_inicio_recepcion,
    ventana.fecha_fin_recepcion,
    ventana.fecha_inicio_vigencia,
    ventana.fecha_fin_vigencia,
    "ABIERTO",
    new Date().toISOString()
  );

  return db.prepare(
    "SELECT * FROM ciclos WHERE id = ?"
  ).get(codigo);
}

function obtenerCicloActivo() {
  const cicloId = obtenerSetting("ciclo_activo_id");

  if (!cicloId) return null;

  return db.prepare(
    "SELECT * FROM ciclos WHERE id = ?"
  ).get(cicloId) || null;
}

function obtenerOCrearCiclo(fechaISO) {
  const ventana = calcularVentanaRecepcion(fechaISO);
  let ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(ventana.id);
  if (!ciclo) {
    const estadoInicial = estadoEfectivoCiclo(ventana, fechaISO);
    db.prepare(`
      INSERT INTO ciclos (id, anio, semana_calendario, fecha_inicio_recepcion, fecha_fin_recepcion, fecha_inicio_vigencia, fecha_fin_vigencia, estado, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ventana.id, ventana.anio, ventana.semana_calendario,
      ventana.fecha_inicio_recepcion, ventana.fecha_fin_recepcion,
      ventana.fecha_inicio_vigencia, ventana.fecha_fin_vigencia,
      estadoInicial, new Date().toISOString()
    );
    ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(ventana.id);
  }
  return refrescarEstadoCiclo(ciclo, fechaISO);
}

app.get("/api/ciclos", (req, res) => {
  const hoy = new Date().toISOString().slice(0, 10);
  const ciclos = db.prepare("SELECT * FROM ciclos ORDER BY fecha_inicio_recepcion DESC").all();
  const actualizados = ciclos.map((c) => refrescarEstadoCiclo(c, hoy));
  res.json(actualizados);
});

app.get("/api/ciclos/actual", (req, res) => {
  const ciclo = obtenerCicloActivo();

  if (!ciclo) {
    return res.json({
      activo: false,
      ciclo: null
    });
  }

  res.json({
    activo: true,
    ciclo
  });
});


app.post("/api/ciclos/abrir-semana", (req, res) => {
  const anio = Number(req.body && req.body.anio);
  const semana = Number(req.body && req.body.semana);

  if (!Number.isInteger(anio) || anio < 2020 || anio > 2100) {
    return res.status(400).json({ error: "Año inválido." });
  }

  if (!Number.isInteger(semana) || semana < 1 || semana > 53) {
    return res.status(400).json({ error: "La semana debe estar entre 1 y 53." });
  }

  const codigoSolicitado =
    "COT-" + anio + "-" + String(semana).padStart(2, "0");

  const cicloActivo = obtenerCicloActivo();

  if (
    cicloActivo &&
    cicloActivo.id !== codigoSolicitado &&
    !cicloActivo.cerrado_en
  ) {
    return res.status(409).json({
      error:
        "Ya existe un ciclo activo: " +
        cicloActivo.id +
        ". Debes cerrarlo antes de abrir " +
        codigoSolicitado +
        "."
    });
  }

  const ciclo = obtenerOCrearCicloPorSemana(anio, semana);

  db.prepare(`
    UPDATE ciclos
    SET cerrado_en = NULL,
        cerrado_por = NULL,
        estado = 'ABIERTO'
    WHERE id = ?
  `).run(ciclo.id);

  guardarSetting("ciclo_activo_id", ciclo.id);

  const actualizado = db.prepare(
    "SELECT * FROM ciclos WHERE id = ?"
  ).get(ciclo.id);

  res.json({
    ok: true,
    ciclo: actualizado
  });
});

app.post("/api/ciclos/:id/abrir", (req, res) => {
  const ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(req.params.id);

  if (!ciclo) {
    return res.status(404).json({ error: "No existe ese ciclo." });
  }

  if (!ciclo.cerrado_en) {
    return res.status(409).json({ error: "Este ciclo ya está abierto." });
  }

  db.prepare(`
    UPDATE ciclos
    SET cerrado_en = NULL,
        cerrado_por = NULL
    WHERE id = ?
  `).run(ciclo.id);

  const hoy = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const actualizado = refrescarEstadoCiclo(
    db.prepare("SELECT * FROM ciclos WHERE id = ?").get(ciclo.id),
    hoy
  );

  res.json(actualizado);
});

app.post("/api/ciclos/:id/cerrar", (req, res) => {
  const ciclo = db.prepare("SELECT * FROM ciclos WHERE id = ?").get(req.params.id);
  if (!ciclo) return res.status(404).json({ error: "No existe ese ciclo." });
  if (ciclo.cerrado_en) return res.status(409).json({ error: "Este ciclo ya estaba cerrado." });

  db.prepare("UPDATE ciclos SET cerrado_en = ?, cerrado_por = ? WHERE id = ?")
    .run(new Date().toISOString(), req.usuarioActual.usuario, ciclo.id);

  const cicloActivoId = obtenerSetting("ciclo_activo_id");

  if (cicloActivoId === ciclo.id) {
    db.prepare("DELETE FROM settings WHERE key = 'ciclo_activo_id'").run();
  }

  const actualizado = refrescarEstadoCiclo(
    db.prepare("SELECT * FROM ciclos WHERE id = ?").get(ciclo.id),
    new Date().toISOString().slice(0, 10)
  );

  res.json(actualizado);
});

// ---------- API ----------
app.post("/api/upload", upload.array("files", 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No se recibió ningún archivo." });
  }
  const cicloActual = obtenerCicloActivo();

  if (!cicloActual) {
    return res.status(409).json({
      error: "No hay un ciclo abierto. Selecciona primero la semana que vas a cotizar."
    });
  }

  if (cicloActual.cerrado_en) {
    return res.status(409).json({
      error: "El ciclo " + cicloActual.id + " está cerrado. Debes abrirlo antes de cargar nuevas cotizaciones."
    });
  }

  const results = [];
  const insertFile = db.prepare(
    "INSERT INTO files (id, name, proveedor, semana, fecha_envio, uploaded_at, ciclo_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertQuote = db.prepare(`
    INSERT INTO quotes (file_id, codigo, producto, presentacion, disponibilidad, precio, observacion, proveedor, semana, vigencia_fin, ciclo_id)
    VALUES (@file_id, @codigo, @producto, @presentacion, @disponibilidad, @precio, @observacion, @proveedor, @semana, @vigenciaFin, @ciclo_id)
  `);

  for (const file of req.files) {
    try {
      const { meta, records, catalogo } = parseWorkbook(file.buffer, file.originalname);
      const fileId = crypto.randomUUID();
      const insertAll = db.transaction(() => {
        insertFile.run(
          fileId,
          file.originalname,
          meta.proveedor,
          meta.semana,
          meta.fechaEnvio,
          new Date().toISOString(),
          cicloActual.id
        );
        records.forEach((r) => insertQuote.run({ file_id: fileId, ...r, ciclo_id: cicloActual.id }));
      });
      insertAll();
      upsertCatalogo(catalogo);
      upsertProveedor(meta.proveedor);
      results.push({ file: file.originalname, ok: true, proveedor: meta.proveedor, nProductos: records.length });
    } catch (err) {
      console.error(
        "[UPLOAD ERROR]",
        file.originalname,
        err && err.stack ? err.stack : err
      );

      results.push({
        file: file.originalname,
        ok: false,
        error: err.message
      });
    }
  }
  res.json({ results, ciclo: cicloActual.id });
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

app.get("/api/catalogo/lista", (req, res) => {
  const rows = db.prepare("SELECT codigo, producto, presentacion FROM catalogo ORDER BY producto").all();
  res.json(rows);
});

app.put("/api/catalogo/:codigo", (req, res) => {
  const codigo = String(req.params.codigo).trim();
  const { producto, presentacion } = req.body || {};
  if (!producto || !String(producto).trim()) return res.status(400).json({ error: "Falta el nombre del producto." });

  const existente = db.prepare("SELECT codigo FROM catalogo WHERE codigo = ?").get(codigo);
  if (!existente) return res.status(404).json({ error: "No existe ese código en el catálogo." });

  db.prepare("UPDATE catalogo SET producto = ?, presentacion = ? WHERE codigo = ?")
    .run(String(producto).trim(), presentacion ? String(presentacion).trim() : "", codigo);
  res.json({ ok: true, codigo, producto: String(producto).trim(), presentacion: presentacion || "" });
});

app.delete("/api/catalogo/:codigo", (req, res) => {

  const codigo =
    String(req.params.codigo || "").trim();

  if (!codigo) {
    return res.status(400).json({
      error: "Falta el código del producto."
    });
  }

  const producto =
    db.prepare(`
      SELECT codigo, producto
      FROM catalogo
      WHERE codigo = ?
    `).get(codigo);

  if (!producto) {
    return res.status(404).json({
      error: "El producto ya no existe en el catálogo."
    });
  }

  const eliminarProducto =
    db.transaction(() => {

      // Desactivar este PLU para TODOS los proveedores.
      // No borramos la relación: queda trazabilidad.
      const relaciones =
        db.prepare(`
          UPDATE proveedor_productos
          SET
            activo = 0,
            actualizado_en = ?
          WHERE codigo = ?
        `).run(
          new Date().toISOString(),
          codigo
        );

      // El catálogo es la base maestra operativa.
      db.prepare(`
        DELETE FROM catalogo
        WHERE codigo = ?
      `).run(codigo);

      return relaciones.changes;
    });

  const relacionesDesactivadas =
    eliminarProducto();

  res.json({
    ok: true,
    codigo,
    producto: producto.producto,
    relacionesDesactivadas,
    historicoConservado: true
  });

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
  const comparativoGlobal = computeComparativo(getAllQuotes(req.query.ciclo), pct);
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
    SELECT pp.codigo, pp.tipo, pp.actualizado_en, c.producto, c.presentacion
    FROM proveedor_productos pp
    LEFT JOIN catalogo c ON c.codigo = pp.codigo
    WHERE pp.proveedor = ?
    ORDER BY c.producto
  `).all(proveedor);
  res.json(rows);
});

app.post("/api/proveedor-productos", (req, res) => {
  const { proveedor, codigo, tipo, presentacion, precio, contrapropuesta, frecuencia } = req.body || {};
  const prov = proveedor && String(proveedor).trim();
  const cod = codigo !== undefined && codigo !== null ? String(codigo).trim() : "";
  const tipoFinal = tipo === "habitual" ? "habitual" : "adicional";
  const frecuenciaFinal = frecuencia === "semanal" ? "semanal" : "diario";
  if (!prov) return res.status(400).json({ error: "Falta el proveedor." });
  if (!cod) return res.status(400).json({ error: "Falta el código del producto." });

  const existeProducto = db.prepare("SELECT codigo, presentacion FROM catalogo WHERE codigo = ?").get(cod);
  if (!existeProducto) {
    return res.status(404).json({ error: "Ese código no existe en el catálogo. Créalo primero." });
  }

  if (presentacion !== undefined && String(presentacion).trim() && String(presentacion).trim() !== existeProducto.presentacion) {
    db.prepare("UPDATE catalogo SET presentacion = ? WHERE codigo = ?").run(String(presentacion).trim(), cod);
  }

  const contrapropuestaManual = contrapropuesta !== undefined && contrapropuesta !== null && contrapropuesta !== ""
    ? Number(contrapropuesta) : null;

  db.prepare(`
    INSERT INTO proveedor_productos (proveedor, codigo, tipo, actualizado_en, contrapropuesta_manual, activo, frecuencia)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(proveedor, codigo) DO UPDATE SET
      tipo = excluded.tipo, actualizado_en = excluded.actualizado_en, contrapropuesta_manual = excluded.contrapropuesta_manual,
      activo = 1, frecuencia = excluded.frecuencia
  `).run(prov, cod, tipoFinal, new Date().toISOString(), contrapropuestaManual, frecuenciaFinal);

  const precioNum = Number(precio);
  let cotizacionCreada = false;
  if (precio !== undefined && precio !== null && precio !== "" && !isNaN(precioNum) && precioNum > 0) {
    const catActual = db.prepare("SELECT producto, presentacion FROM catalogo WHERE codigo = ?").get(cod);
    const hoy = new Date().toISOString().slice(0, 10);
    const cicloActual = obtenerOCrearCiclo(hoy);
    const fileId = crypto.randomUUID();
    const insertFile = db.prepare(
      "INSERT INTO files (id, name, proveedor, semana, fecha_envio, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertQuote = db.prepare(`
      INSERT INTO quotes (file_id, codigo, producto, presentacion, disponibilidad, precio, observacion, proveedor, semana, vigencia_fin, ciclo_id)
      VALUES (@file_id, @codigo, @producto, @presentacion, @disponibilidad, @precio, @observacion, @proveedor, @semana, @vigenciaFin, @ciclo_id)
    `);
    const insertAll = db.transaction(() => {
      insertFile.run(fileId, "Agregado desde Por Proveedor", prov, "N/D", null, new Date().toISOString());
      insertQuote.run({
        file_id: fileId, codigo: cod, producto: catActual.producto, presentacion: catActual.presentacion,
        disponibilidad: null, precio: precioNum, observacion: null, proveedor: prov, semana: "N/D", vigenciaFin: null,
        ciclo_id: cicloActual.id,
      });
    });
    insertAll();
    cotizacionCreada = true;
  }

  res.json({ ok: true, proveedor: prov, codigo: cod, tipo: tipoFinal, contrapropuestaManual, cotizacionCreada });
});

function slugifyUsuario(nombre) {
  const base = String(nombre)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 30);
  return base || "proveedor";
}

app.get("/api/onboarding/plantilla", (req, res) => {
  const combos = db.prepare(`
    SELECT DISTINCT proveedor, codigo FROM quotes
    UNION
    SELECT proveedor, codigo FROM proveedor_productos
  `).all();

  const asocMap = {};
  db.prepare("SELECT proveedor, codigo, frecuencia, tipo FROM proveedor_productos").all().forEach((r) => {
    asocMap[r.proveedor + "|" + r.codigo] = r;
  });
  const catMap = {};
  db.prepare("SELECT codigo, producto, presentacion FROM catalogo").all().forEach((r) => { catMap[r.codigo] = r; });

  const filas = combos.map((c) => {
    const cat = catMap[c.codigo] || {};
    const asoc = asocMap[c.proveedor + "|" + c.codigo];
    return {
      Proveedor: c.proveedor,
      "Código": c.codigo,
      Producto: cat.producto || "",
      "Presentación": cat.presentacion || "",
      Frecuencia: asoc && asoc.frecuencia === "semanal" ? "semanal" : "diario",
      Tipo: asoc && asoc.tipo === "habitual" ? "habitual" : "adicional",
    };
  }).sort((a, b) => a.Proveedor.localeCompare(b.Proveedor) || (a.Producto || "").localeCompare(b.Producto || ""));

  const ws = XLSX.utils.json_to_sheet(filas);
  ws["!cols"] = [{ wch: 26 }, { wch: 12 }, { wch: 32 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Onboarding");
  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

  res.setHeader("Content-Disposition", 'attachment; filename="Plantilla_Onboarding_Proveedores.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

app.post("/api/onboarding/importar", upload.single("archivo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió el archivo." });
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    const ahora = new Date().toISOString();
    const upsertCat = db.prepare(`
      INSERT INTO catalogo (codigo, producto, presentacion) VALUES (?, ?, ?)
      ON CONFLICT(codigo) DO UPDATE SET
        producto = CASE WHEN excluded.producto <> '' THEN excluded.producto ELSE catalogo.producto END,
        presentacion = CASE WHEN excluded.presentacion <> '' THEN excluded.presentacion ELSE catalogo.presentacion END
    `);
    const upsertPP = db.prepare(`
      INSERT INTO proveedor_productos (proveedor, codigo, tipo, actualizado_en, activo, frecuencia)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(proveedor, codigo) DO UPDATE SET tipo = excluded.tipo, frecuencia = excluded.frecuencia, actualizado_en = excluded.actualizado_en
    `);
    const upsertProv = db.prepare("INSERT OR IGNORE INTO proveedores (nombre, creado_en) VALUES (?, ?)");

    const proveedoresEnHoja = new Set();
    let productosActualizados = 0;
    let omitidos = 0;

    const importar = db.transaction((filas) => {
      filas.forEach((r) => {
        const proveedor = String(
          r["PROVEEDOR CORREGIDO / SUGERIDO"] ||
          r["Nombre de porveedor"] ||
          r["Proveedor"] ||
          ""
        ).trim().toUpperCase();

        const codigo = String(
          r["PLU CORREGIDO"] ||
          r["Código"] ||
          r["Codigo"] ||
          ""
        ).trim();

        const producto = String(
          r["Descripción Producto"] ||
          r["Producto"] ||
          ""
        ).trim();

        const presentacion = String(
          r["Presentacion"] ||
          r["Presentación"] ||
          ""
        ).trim();

        const frecRaw = String(
          r["Frecuencia"] || "semanal"
        ).trim().toLowerCase();

        const tipoRaw = String(
          r["Tipo"] || "habitual"
        ).trim().toLowerCase();
        if (!proveedor || !codigo) { omitidos++; return; }

        upsertProv.run(proveedor, ahora);
        proveedoresEnHoja.add(proveedor);
        if (producto) upsertCat.run(codigo, producto, presentacion);

        const frecuencia = frecRaw === "semanal" ? "semanal" : "diario";
        const tipo = tipoRaw === "habitual" ? "habitual" : "adicional";
        upsertPP.run(proveedor, codigo, tipo, ahora, frecuencia);
        productosActualizados++;
      });
    });
    importar(rows);

    const usuarioDeProveedor = db.prepare("SELECT usuario FROM usuarios WHERE proveedor_nombre = ? AND tipo = 'proveedor'");
    const usuarioOcupado = db.prepare("SELECT 1 as x FROM usuarios WHERE usuario = ?");
    const crearUsuario = db.prepare(`
      INSERT INTO usuarios (usuario, password_hash, password_salt, tipo, proveedor_nombre, creado_en)
      VALUES (?, ?, ?, 'proveedor', ?, ?)
    `);

    const filasCredenciales = [];
    proveedoresEnHoja.forEach((proveedor) => {
      const existente = usuarioDeProveedor.get(proveedor);
      if (existente) {
        filasCredenciales.push({ Proveedor: proveedor, Usuario: existente.usuario, "Contraseña": "(cuenta ya existente, sin cambios)", Estado: "Existente" });
        return;
      }
      let usuario = slugifyUsuario(proveedor);
      let intento = 1;
      while (usuarioOcupado.get(usuario)) {
        usuario = slugifyUsuario(proveedor) + intento;
        intento++;
      }
      const password = crypto.randomBytes(6).toString("base64url");
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = db.hashPassword(password, salt);
      crearUsuario.run(usuario, hash, salt, proveedor, ahora);
      filasCredenciales.push({ Proveedor: proveedor, Usuario: usuario, "Contraseña": password, Estado: "Cuenta nueva" });
    });
    filasCredenciales.sort((a, b) => a.Proveedor.localeCompare(b.Proveedor));

    const wsOut = XLSX.utils.json_to_sheet(filasCredenciales);
    wsOut["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 22 }, { wch: 16 }];
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, wsOut, "Credenciales");
    const buffer = XLSX.write(wbOut, { bookType: "xlsx", type: "buffer" });

    res.setHeader("Content-Disposition", 'attachment; filename="Credenciales_Proveedores.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("X-Productos-Actualizados", String(productosActualizados));
    res.setHeader("X-Omitidos", String(omitidos));
    res.setHeader("Access-Control-Expose-Headers", "X-Productos-Actualizados, X-Omitidos");
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: "No se pudo procesar el archivo: " + err.message });
  }
});


app.post("/api/usuarios-proveedores/importar-credenciales", upload.single("archivo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No se recibió el archivo Excel." });
  }

  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets["Credenciales"] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    if (!rows.length) {
      return res.status(400).json({ error: "El archivo no contiene credenciales." });
    }

    const buscarUsuario = db.prepare(`
      SELECT usuario, proveedor_nombre, tipo
      FROM usuarios
      WHERE usuario = ?
    `);

    const errores = [];
    const validos = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      const proveedor = String(r["Proveedor"] || "").trim();
      const usuario = String(r["Usuario"] || "").trim();
      const password = String(
        r["Contraseña nueva"] ||
        r["Contrasena nueva"] ||
        r["Contraseña"] ||
        ""
      ).trim();

      if (!proveedor || !usuario || !password) {
        errores.push({
          fila: i + 2,
          error: "Faltan Proveedor, Usuario o Contraseña nueva."
        });
        continue;
      }

      const existente = buscarUsuario.get(usuario);

      if (!existente) {
        errores.push({
          fila: i + 2,
          usuario,
          error: "El usuario no existe en la base de datos."
        });
        continue;
      }

      if (existente.tipo !== "proveedor") {
        errores.push({
          fila: i + 2,
          usuario,
          error: "La cuenta no es de tipo proveedor."
        });
        continue;
      }

      if (String(existente.proveedor_nombre || "").trim() !== proveedor) {
        errores.push({
          fila: i + 2,
          usuario,
          error:
            'El proveedor no coincide. BD="' +
            existente.proveedor_nombre +
            '" / Excel="' +
            proveedor +
            '"'
        });
        continue;
      }

      validos.push({ proveedor, usuario, password });
    }

    // Seguridad: si hay cualquier error, no cambia ninguna contraseña.
    if (errores.length) {
      return res.status(400).json({
        error: "La validación encontró errores. No se modificó ninguna contraseña.",
        filas: rows.length,
        validos: validos.length,
        errores
      });
    }

    const actualizar = db.prepare(`
      UPDATE usuarios
      SET password_hash = ?, password_salt = ?
      WHERE usuario = ? AND tipo = 'proveedor'
    `);

    const aplicar = db.transaction((datos) => {
      let actualizados = 0;

      for (const item of datos) {
        const salt = crypto.randomBytes(16).toString("hex");
        const hash = db.hashPassword(item.password, salt);

        const info = actualizar.run(hash, salt, item.usuario);
        actualizados += info.changes;
      }

      return actualizados;
    });

    const actualizados = aplicar(validos);

    res.json({
      ok: true,
      filas: rows.length,
      actualizados,
      mensaje: "Credenciales sincronizadas correctamente."
    });

  } catch (err) {
    console.error("Error importando credenciales:", err);
    res.status(400).json({
      error: "No se pudo procesar el archivo: " + err.message
    });
  }
});

app.get("/api/frecuencias/plantilla", (req, res) => {
  const combos = db.prepare(`
    SELECT DISTINCT proveedor, codigo FROM quotes
    UNION
    SELECT proveedor, codigo FROM proveedor_productos
  `).all();

  const frecActual = {};
  db.prepare("SELECT proveedor, codigo, frecuencia FROM proveedor_productos").all().forEach((r) => {
    frecActual[r.proveedor + "|" + r.codigo] = r.frecuencia;
  });
  const catMap = {};
  db.prepare("SELECT codigo, producto, presentacion FROM catalogo").all().forEach((r) => { catMap[r.codigo] = r; });

  const filas = combos.map((c) => {
    const cat = catMap[c.codigo] || {};
    return {
      Proveedor: c.proveedor,
      "Código": c.codigo,
      Producto: cat.producto || "",
      "Presentación": cat.presentacion || "",
      Frecuencia: frecActual[c.proveedor + "|" + c.codigo] === "semanal" ? "semanal" : "diario",
    };
  }).sort((a, b) => a.Proveedor.localeCompare(b.Proveedor) || (a.Producto || "").localeCompare(b.Producto || ""));

  const ws = XLSX.utils.json_to_sheet(filas);
  ws["!cols"] = [{ wch: 26 }, { wch: 12 }, { wch: 32 }, { wch: 16 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Frecuencias");
  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

  res.setHeader("Content-Disposition", 'attachment; filename="Plantilla_Frecuencias.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

app.post("/api/frecuencias/importar", upload.single("archivo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió el archivo." });
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    let actualizados = 0;
    let omitidos = 0;
    const ahora = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO proveedor_productos (proveedor, codigo, tipo, actualizado_en, activo, frecuencia)
      VALUES (?, ?, 'adicional', ?, 1, ?)
      ON CONFLICT(proveedor, codigo) DO UPDATE SET frecuencia = excluded.frecuencia, actualizado_en = excluded.actualizado_en
    `);
    const importar = db.transaction((filas) => {
      filas.forEach((r) => {
        const proveedor = String(r["Proveedor"] || "").trim();
        const codigo = String(r["Código"] || r["Codigo"] || "").trim();
        const frecRaw = String(r["Frecuencia"] || "").trim().toLowerCase();
        if (!proveedor || !codigo) { omitidos++; return; }
        const frecuencia = frecRaw === "semanal" ? "semanal" : "diario";
        stmt.run(proveedor, codigo, ahora, frecuencia);
        actualizados++;
      });
    });
    importar(rows);
    res.json({ ok: true, actualizados, omitidos });
  } catch (err) {
    res.status(400).json({ error: "No se pudo procesar el archivo: " + err.message });
  }
});

app.post("/api/proveedor-productos/marcar-habituales", (req, res) => {
  const { proveedor } = req.body || {};
  const prov = proveedor ? String(proveedor).trim() : "";
  if (!prov) return res.status(400).json({ error: "Falta el proveedor." });

  const codigos = db.prepare("SELECT DISTINCT codigo FROM quotes WHERE proveedor = ?").all(prov).map((r) => r.codigo);
  const ahora = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO proveedor_productos (proveedor, codigo, tipo, actualizado_en, activo, frecuencia)
    VALUES (?, ?, 'habitual', ?, 1, 'diario')
    ON CONFLICT(proveedor, codigo) DO UPDATE SET tipo = 'habitual', actualizado_en = excluded.actualizado_en
  `);
  const marcar = db.transaction((cods) => { cods.forEach((c) => stmt.run(prov, c, ahora)); });
  marcar(codigos);

  res.json({ ok: true, actualizados: codigos.length });
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

  const hoy = new Date().toISOString().slice(0, 10);
  const cicloActual = obtenerOCrearCiclo(hoy);
  const fileId = crypto.randomUUID();
  const insertFile = db.prepare(
    "INSERT INTO files (id, name, proveedor, semana, fecha_envio, uploaded_at, ciclo_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertQuote = db.prepare(`
    INSERT INTO quotes (file_id, codigo, producto, presentacion, disponibilidad, precio, observacion, proveedor, semana, vigencia_fin, ciclo_id)
    VALUES (@file_id, @codigo, @producto, @presentacion, @disponibilidad, @precio, @observacion, @proveedor, @semana, @vigenciaFin, @ciclo_id)
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
      new Date().toISOString(),
      cicloActual.id
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
        ciclo_id: cicloActual.id,
      });
    });
  });
  insertAll();
  upsertCatalogo(validos.map((it) => ({
    codigo: String(it.codigo).trim(),
    producto: it.producto ? String(it.producto).trim() : "",
    presentacion: it.presentacion ? String(it.presentacion).trim() : "",
  })));
  upsertProveedor(proveedorNorm);

  // Una cotización manual confirma que este proveedor
  // está ofreciendo actualmente estos productos.
  // Reactivamos la relación sin cambiar su tipo/frecuencia
  // cuando ya existía.
  const ahoraRelacion = new Date().toISOString();

  const activarRelacion = db.prepare(`
    INSERT INTO proveedor_productos (
      proveedor,
      codigo,
      tipo,
      actualizado_en,
      activo,
      frecuencia
    )
    VALUES (?, ?, 'adicional', ?, 1, 'diario')
    ON CONFLICT(proveedor, codigo) DO UPDATE SET
      activo = 1,
      actualizado_en = excluded.actualizado_en
  `);

  const activarRelaciones = db.transaction((items) => {
    items.forEach((it) => {
      activarRelacion.run(
        proveedorNorm,
        String(it.codigo).trim(),
        ahoraRelacion
      );
    });
  });

  activarRelaciones(validos);

  res.json({
    ok: true,
    proveedor: proveedorNorm,
    nProductos: validos.length,
    ciclo: cicloActual.id
  });
});



// ============================================================
// PEDIDOS - IMPORTAR DEMANDA BASE
// PLU | Producto | Kg/Cantidad
// ============================================================

app.post(
  "/api/pedidos-demanda/importar",
  upload.single("archivo"),
  (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        error: "No se recibió el archivo Excel."
      });
    }

    try {

      const cicloSolicitado =
        req.body && req.body.ciclo_id
          ? String(req.body.ciclo_id).trim()
          : "";

      const ciclo =
        cicloSolicitado
          ? db.prepare(
              "SELECT * FROM ciclos WHERE id = ?"
            ).get(cicloSolicitado)
          : obtenerCicloActivo();

      if (!ciclo) {
        return res.status(409).json({
          error:
            "No hay un ciclo activo. Abre primero el ciclo de cotización."
        });
      }

      const periodo =
        req.body && req.body.periodo
          ? String(req.body.periodo).trim().toUpperCase()
          : "LUNES-MARTES";


      // ------------------------------------------------------
      // Leer Excel
      // ------------------------------------------------------

      const wb = XLSX.read(
        req.file.buffer,
        {
          type: "buffer",
          cellDates: true
        }
      );

      let filasValidas = [];

      function normalizar(v) {
        return String(v ?? "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toUpperCase();
      }


      // Buscamos automáticamente la hoja y encabezado.
      for (const nombreHoja of wb.SheetNames) {

        const ws = wb.Sheets[nombreHoja];

        const rows =
          XLSX.utils.sheet_to_json(
            ws,
            {
              header: 1,
              defval: null,
              raw: true
            }
          );

        let headerIdx = -1;
        let colCodigo = -1;
        let colProducto = -1;
        let colCantidad = -1;

        for (let i = 0; i < rows.length; i++) {

          const n =
            (rows[i] || []).map(normalizar);

          const idxCodigo =
            n.findIndex(x =>
              x === "PLU" ||
              x === "CODIGO" ||
              x === "CODIGO / PLU"
            );

          const idxProducto =
            n.findIndex(x =>
              x === "PRODUCTO" ||
              x === "NOMBRE" ||
              x === "NOMBRE PRODUCTO"
            );

          const idxCantidad =
            n.findIndex(x =>
              x === "KG" ||
              x === "KILOS" ||
              x === "CANTIDAD" ||
              x === "CANTIDAD KG"
            );

          if (
            idxCodigo >= 0 &&
            idxProducto >= 0 &&
            idxCantidad >= 0
          ) {
            headerIdx = i;
            colCodigo = idxCodigo;
            colProducto = idxProducto;
            colCantidad = idxCantidad;
            break;
          }
        }


        if (headerIdx < 0) {
          continue;
        }


        for (
          let i = headerIdx + 1;
          i < rows.length;
          i++
        ) {

          const row = rows[i] || [];

          const codigo =
            String(
              row[colCodigo] ?? ""
            ).trim();

          const producto =
            String(
              row[colProducto] ?? ""
            ).trim();

          let cantidadRaw =
            row[colCantidad];

          let cantidad;

          if (typeof cantidadRaw === "number") {
            cantidad = cantidadRaw;
          } else {
            cantidad = Number(
              String(cantidadRaw ?? "")
                .replace(/\s/g, "")
                .replace(",", ".")
            );
          }


          if (!codigo) continue;

          if (
            !Number.isFinite(cantidad) ||
            cantidad < 0
          ) {
            continue;
          }


          filasValidas.push({
            codigo,
            producto,
            cantidad
          });
        }


        // Si ya encontramos una hoja válida,
        // no necesitamos seguir buscando.
        if (filasValidas.length) {
          break;
        }
      }


      if (!filasValidas.length) {
        return res.status(400).json({
          error:
            "No se encontraron filas válidas. El archivo debe contener PLU, Producto y Kg/Cantidad."
        });
      }


      // ------------------------------------------------------
      // Consolidar PLU repetidos
      // ------------------------------------------------------

      const consolidado = new Map();

      for (const fila of filasValidas) {

        if (!consolidado.has(fila.codigo)) {

          consolidado.set(
            fila.codigo,
            {
              codigo: fila.codigo,
              producto: fila.producto,
              cantidad: fila.cantidad
            }
          );

        } else {

          const actual =
            consolidado.get(fila.codigo);

          actual.cantidad += fila.cantidad;

          if (
            !actual.producto &&
            fila.producto
          ) {
            actual.producto =
              fila.producto;
          }
        }
      }


      const filas =
        Array.from(consolidado.values());


      const ahora =
        new Date().toISOString();


      // ------------------------------------------------------
      // Crear / actualizar demanda
      // ------------------------------------------------------

      const guardar =
        db.transaction(() => {

          let demanda =
            db.prepare(`
              SELECT *
              FROM demandas_pedido
              WHERE ciclo_id = ?
                AND periodo = ?
            `).get(
              ciclo.id,
              periodo
            );


          if (!demanda) {

            const r =
              db.prepare(`
                INSERT INTO demandas_pedido (
                  ciclo_id,
                  periodo,
                  archivo_nombre,
                  estado,
                  creado_en,
                  actualizado_en
                )
                VALUES (?, ?, ?, 'borrador', ?, ?)
              `).run(
                ciclo.id,
                periodo,
                req.file.originalname,
                ahora,
                ahora
              );

            demanda =
              db.prepare(`
                SELECT *
                FROM demandas_pedido
                WHERE id = ?
              `).get(r.lastInsertRowid);

          } else {

            // Si se vuelve a cargar Planeación de la Demanda,
            // reiniciamos la distribución anterior del mismo ciclo/período.
            // La Planeación es siempre el paso 1 del flujo.

            db.prepare(`
              DELETE FROM pedido_asignaciones
              WHERE demanda_detalle_id IN (
                SELECT id
                FROM demanda_pedido_detalles
                WHERE demanda_id = ?
              )
            `).run(demanda.id);

            db.prepare(`
              DELETE FROM pedido_distribucion_porcentajes
              WHERE ciclo_id = ?
                AND periodo = ?
            `).run(
              ciclo.id,
              periodo
            );

            db.prepare(`
              DELETE FROM demanda_pedido_detalles
              WHERE demanda_id = ?
            `).run(demanda.id);


            db.prepare(`
              UPDATE demandas_pedido
              SET
                archivo_nombre = ?,
                actualizado_en = ?,
                estado = 'borrador'
              WHERE id = ?
            `).run(
              req.file.originalname,
              ahora,
              demanda.id
            );
          }


          const insertar =
            db.prepare(`
              INSERT INTO demanda_pedido_detalles (
                demanda_id,
                codigo,
                producto,
                cantidad_requerida,
                creado_en,
                actualizado_en
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `);


          for (const fila of filas) {

            insertar.run(
              demanda.id,
              fila.codigo,
              fila.producto,
              fila.cantidad,
              ahora,
              ahora
            );
          }


          return demanda.id;
        });


      const demandaId =
        guardar();


      const totalKg =
        filas.reduce(
          (acc, x) =>
            acc + Number(x.cantidad || 0),
          0
        );


      res.json({
        ok: true,
        demanda_id: demandaId,
        ciclo_id: ciclo.id,
        periodo,
        archivo: req.file.originalname,
        productos: filas.length,
        kg_total: totalKg
      });


    } catch (err) {

      console.error(
        "[PEDIDOS DEMANDA ERROR]",
        err
      );

      res.status(400).json({
        error:
          err && err.message
            ? err.message
            : "No se pudo importar la demanda."
      });
    }
  }
);




// ============================================================
// PEDIDOS - CONSULTAR DEMANDA + ASIGNACIONES
// ============================================================

app.get("/api/pedidos-demanda", (req, res) => {

  const cicloId =
    req.query.ciclo
      ? String(req.query.ciclo).trim()
      : "";

  const periodo =
    req.query.periodo
      ? String(req.query.periodo).trim().toUpperCase()
      : "LUNES-MARTES";

  const ciclo =
    cicloId
      ? db.prepare(
          "SELECT * FROM ciclos WHERE id = ?"
        ).get(cicloId)
      : obtenerCicloActivo();

  if (!ciclo) {
    return res.status(404).json({
      error: "No se encontró el ciclo solicitado."
    });
  }

  const demanda =
    db.prepare(`
      SELECT *
      FROM demandas_pedido
      WHERE ciclo_id = ?
        AND periodo = ?
    `).get(
      ciclo.id,
      periodo
    );

  if (!demanda) {
    return res.json({
      ciclo_id: ciclo.id,
      periodo,
      demanda: null,
      items: []
    });
  }

  const detalles =
    db.prepare(`
      SELECT
        id,
        codigo,
        producto,
        cantidad_requerida
      FROM demanda_pedido_detalles
      WHERE demanda_id = ?
      ORDER BY producto
    `).all(demanda.id);


  const obtenerAsignaciones =
    db.prepare(`
      SELECT
        pa.id,
        pa.proveedor,
        pa.precio_unitario,
        pa.cantidad_asignada,
        pa.subtotal,
        pa.fuente_precio,
        pa.negociacion_producto_id
      FROM pedido_asignaciones pa
      WHERE pa.demanda_detalle_id = ?
      ORDER BY pa.proveedor
    `);


  const obtenerCotizaciones =
    db.prepare(`
      SELECT
        q.proveedor,
        q.precio,
        q.id AS quote_id
      FROM quotes q
      WHERE q.codigo = ?
        AND q.ciclo_id = ?
      ORDER BY q.precio ASC
    `);


  const items = detalles.map((d) => {

    const asignaciones =
      obtenerAsignaciones.all(d.id);

    const cotizaciones =
      obtenerCotizaciones.all(
        d.codigo,
        ciclo.id
      );

    const asignado =
      asignaciones.reduce(
        (acc, a) =>
          acc + Number(a.cantidad_asignada || 0),
        0
      );

    const requerido =
      Number(d.cantidad_requerida || 0);

    const pendiente =
      requerido - asignado;

    let estado = "PENDIENTE";

    if (asignado === requerido) {
      estado = "COMPLETO";
    }

    if (asignado > requerido) {
      estado = "EXCEDIDO";
    }

    return {
      demanda_detalle_id: d.id,
      codigo: d.codigo,
      producto: d.producto,

      cantidad_requerida: requerido,
      cantidad_asignada: asignado,

      pendiente:
        pendiente > 0
          ? pendiente
          : 0,

      exceso:
        pendiente < 0
          ? Math.abs(pendiente)
          : 0,

      estado,

      asignaciones,
      proveedores_cotizados: cotizaciones
    };
  });


  const resumen = {
    productos: items.length,

    completos:
      items.filter(
        x => x.estado === "COMPLETO"
      ).length,

    pendientes:
      items.filter(
        x => x.estado === "PENDIENTE"
      ).length,

    excedidos:
      items.filter(
        x => x.estado === "EXCEDIDO"
      ).length
  };


  res.json({
    ciclo_id: ciclo.id,
    periodo,

    demanda: {
      id: demanda.id,
      archivo_nombre:
        demanda.archivo_nombre,
      estado:
        demanda.estado
    },

    resumen,
    items
  });

});




// ============================================================
// PEDIDOS - VISTA Y EXCEL POR PROVEEDOR
// ============================================================

function construirVistaPedidoProveedor(cicloId, periodo, proveedor) {

  const demanda = db.prepare(`
    SELECT *
    FROM demandas_pedido
    WHERE ciclo_id = ?
      AND periodo = ?
  `).get(cicloId, periodo);

  if (!demanda) {
    return {
      demanda: null,
      items: []
    };
  }


  const detalles = db.prepare(`
    SELECT
      id,
      codigo,
      producto,
      cantidad_requerida
    FROM demanda_pedido_detalles
    WHERE demanda_id = ?
    ORDER BY producto
  `).all(demanda.id);


  // ==========================================================
  // ASIGNACIONES REALES DEL PEDIDO PARA ESTE PROVEEDOR
  // Estas mandan, haya cotizado o no el producto.
  // ==========================================================

  const asignaciones = db.prepare(`
    SELECT
      demanda_detalle_id,
      proveedor,
      precio_unitario,
      cantidad_asignada,
      subtotal,
      fuente_precio
    FROM pedido_asignaciones
    WHERE proveedor = ?
  `).all(proveedor);

  const asignacionPorDetalle = {};

  asignaciones.forEach(a => {
    asignacionPorDetalle[String(a.demanda_detalle_id)] = a;
  });


  // ==========================================================
  // DISTRIBUCIÓN PORCENTUAL OFICIAL DEL PROVEEDOR
  // Esta será la fuente del Pedido por proveedor.
  // ==========================================================

  const distribuciones = db.prepare(`
    SELECT
      id,
      codigo,
      proveedor,
      porcentaje
    FROM pedido_distribucion_porcentajes
    WHERE ciclo_id = ?
      AND periodo = ?
      AND proveedor = ?
  `).all(
    cicloId,
    periodo,
    proveedor
  );

  const distribucionPorCodigo = {};

  distribuciones.forEach(r => {
    distribucionPorCodigo[String(r.codigo)] = {
      id: r.id,
      porcentaje: Number(r.porcentaje || 0)
    };
  });


  // ==========================================================
  // PORTAFOLIO ACTIVO DEL PROVEEDOR
  // ==========================================================

  const relaciones = db.prepare(`
    SELECT
      codigo,
      activo,
      contrapropuesta_manual
    FROM proveedor_productos
    WHERE proveedor = ?
  `).all(proveedor);

  const relacionPorCodigo = {};

  relaciones.forEach(r => {
    relacionPorCodigo[String(r.codigo)] = r;
  });


  // ==========================================================
  // COTIZACIÓN DE ESTE CICLO
  // ==========================================================

  const pct =
    getContrapropuestaPct();

  const quotes =
    getAllQuotes(cicloId);

  const vistaCotizada =
    computeVistaProveedor(
      quotes,
      proveedor,
      pct
    );

  const cotizacionPorCodigo = {};

  vistaCotizada.forEach(it => {
    cotizacionPorCodigo[String(it.codigo)] = it;
  });


  // ==========================================================
  // CATÁLOGO
  // ==========================================================

  const catalogoPorCodigo = {};

  db.prepare(`
    SELECT
      codigo,
      producto,
      presentacion
    FROM catalogo
  `).all().forEach(c => {
    catalogoPorCodigo[String(c.codigo)] = c;
  });


  const items = [];


  for (const d of detalles) {

    const codigo =
      String(d.codigo);

    const relacion =
      relacionPorCodigo[codigo] || null;

    const asignacion =
      asignacionPorDetalle[String(d.id)] || null;

    const cotizacion =
      cotizacionPorCodigo[codigo] || null;

    const catalogo =
      catalogoPorCodigo[codigo] || {};


    const distribucion =
      distribucionPorCodigo[codigo] || null;

    const porcentajeDistribucion =
      distribucion
        ? Number(distribucion.porcentaje || 0)
        : 0;

    const pedidoKgDistribucion =
      Number(d.cantidad_requerida || 0) *
      porcentajeDistribucion /
      100;


    const suministra =
      !!(
        relacion &&
        relacion.activo !== 0
      );

    const tieneAsignacion =
      !!(
        asignacion &&
        Number(
          asignacion.cantidad_asignada || 0
        ) > 0
      );


    // Mostrar si lo suministra o si ya se le asignaron kilos.
    if (!suministra && !tieneAsignacion) {
      continue;
    }


    let contrapropuesta = null;

    if (
      relacion &&
      relacion.contrapropuesta_manual !== null &&
      relacion.contrapropuesta_manual !== undefined
    ) {

      contrapropuesta =
        Number(
          relacion.contrapropuesta_manual
        );

    } else if (
      cotizacion &&
      cotizacion.contrapropuesta !== null &&
      cotizacion.contrapropuesta !== undefined
    ) {

      contrapropuesta =
        Number(
          cotizacion.contrapropuesta
        );
    }


    items.push({

      demanda_detalle_id:
        d.id,

      codigo,

      producto:
        d.producto ||
        catalogo.producto ||
        codigo,

      presentacion:
        cotizacion
          ? (
              cotizacion.presentacion ||
              catalogo.presentacion ||
              ""
            )
          : (
              catalogo.presentacion ||
              ""
            ),

      cantidad_requerida:
        Number(
          d.cantidad_requerida || 0
        ),

      cotizo:
        !!cotizacion,

      precio_ofertado:
        cotizacion &&
        cotizacion.precioProveedor !== null &&
        cotizacion.precioProveedor !== undefined
          ? Number(
              cotizacion.precioProveedor
            )
          : null,

      contrapropuesta,

      porcentaje_distribucion:
        porcentajeDistribucion,

      distribucion_porcentaje_id:
        distribucion
          ? distribucion.id
          : null,

      pedido_kg:
        pedidoKgDistribucion,

      precio_asignado:
        asignacion &&
        asignacion.precio_unitario !== null &&
        asignacion.precio_unitario !== undefined
          ? Number(
              asignacion.precio_unitario
            )
          : null,

      subtotal:
        asignacion
          ? Number(
              asignacion.subtotal || 0
            )
          : 0,

      fuente_precio:
        asignacion
          ? asignacion.fuente_precio
          : null

    });
  }


  items.sort(
    (a, b) =>
      String(a.producto || "")
        .localeCompare(
          String(b.producto || "")
        )
  );


  return {
    demanda,
    items
  };
}


// ============================================================
// PREVISUALIZAR PEDIDO POR PROVEEDOR
// ============================================================

app.get(
  "/api/pedidos/proveedor",
  (req, res) => {

    try {

      const ciclo =
        String(
          req.query.ciclo || ""
        ).trim();

      const proveedor =
        String(
          req.query.proveedor || ""
        ).trim();

      const periodo =
        String(
          req.query.periodo ||
          "LUNES-MARTES"
        )
          .trim()
          .toUpperCase();


      if (!ciclo) {
        return res.status(400).json({
          error:
            "Falta seleccionar el ciclo."
        });
      }


      if (!proveedor) {
        return res.status(400).json({
          error:
            "Falta seleccionar el proveedor."
        });
      }


      const resultado =
        construirVistaPedidoProveedor(
          ciclo,
          periodo,
          proveedor
        );


      const totalPedidoKg =
        resultado.items.reduce(
          (acc, x) =>
            acc +
            Number(x.pedido_kg || 0),
          0
        );


      res.json({
        ciclo,
        periodo,
        proveedor,
        demanda:
          resultado.demanda
            ? {
                id:
                  resultado.demanda.id,

                archivo_nombre:
                  resultado.demanda
                    .archivo_nombre
              }
            : null,

        productos:
          resultado.items.length,

        total_pedido_kg:
          totalPedidoKg,

        items:
          resultado.items
      });


    } catch (err) {

      console.error(
        "[PEDIDO PROVEEDOR ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo generar la vista del proveedor."
      });
    }
  }
);


// ============================================================
// DESCARGAR EXCEL POR PROVEEDOR
// ============================================================

app.get(
  "/api/pedidos/proveedor/excel",
  (req, res) => {

    try {

      const ciclo =
        String(
          req.query.ciclo || ""
        ).trim();

      const proveedor =
        String(
          req.query.proveedor || ""
        ).trim();

      const periodo =
        String(
          req.query.periodo ||
          "LUNES-MARTES"
        )
          .trim()
          .toUpperCase();


      if (!ciclo) {
        return res.status(400).json({
          error:
            "Falta seleccionar el ciclo."
        });
      }


      if (!proveedor) {
        return res.status(400).json({
          error:
            "Falta seleccionar el proveedor."
        });
      }


      const resultado =
        construirVistaPedidoProveedor(
          ciclo,
          periodo,
          proveedor
        );


      if (!resultado.demanda) {
        return res.status(404).json({
          error:
            "No existe una demanda cargada para este ciclo y periodo."
        });
      }


      if (!resultado.items.length) {
        return res.status(404).json({
          error:
            "Este proveedor no tiene productos relacionados con el pedido."
        });
      }


      // Solo salen productos realmente asignados
      // a este proveedor.
      const itemsPedido =
        resultado.items.filter(
          it => Number(it.pedido_kg || 0) > 0
        );

      if (!itemsPedido.length) {
        return res.status(404).json({
          error:
            "Este proveedor todavía no tiene kilos asignados en el pedido."
        });
      }


      const filas =
        itemsPedido.map(it => ({

          "PLU":
            it.codigo,

          "Producto":
            it.producto,

          "Presentación":
            it.presentacion,

          "Precio ofertado proveedor":
            it.precio_ofertado,

          "Contrapropuesta":
            it.contrapropuesta,

          "Pedido KG":
            it.pedido_kg,

          "Precio usado pedido":
            it.precio_asignado,

          "Subtotal":
            it.subtotal

        }));


      const ws =
        XLSX.utils.json_to_sheet(filas);


      ws["!cols"] = [
        { wch: 14 },
        { wch: 38 },
        { wch: 18 },
        { wch: 24 },
        { wch: 18 },
        { wch: 14 },
        { wch: 20 },
        { wch: 18 }
      ];


      const wb =
        XLSX.utils.book_new();


      XLSX.utils.book_append_sheet(
        wb,
        ws,
        "Pedido"
      );


      const buffer =
        XLSX.write(
          wb,
          {
            bookType: "xlsx",
            type: "buffer"
          }
        );


      const nombreSeguro =
        proveedor
          .replace(
            /[^a-zA-Z0-9ÁÉÍÓÚáéíóúÑñ_-]+/g,
            "_"
          )
          .replace(
            /^_+|_+$/g,
            ""
          );


      const archivo =
        "PEDIDO_" +
        nombreSeguro +
        "_" +
        ciclo +
        "_" +
        periodo +
        ".xlsx";


      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );


      res.setHeader(
        "Content-Disposition",
        'attachment; filename="' +
        archivo +
        '"'
      );


      res.send(buffer);


    } catch (err) {

      console.error(
        "[PEDIDO PROVEEDOR EXCEL ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo generar el Excel."
      });
    }
  }
);




// ============================================================
// PEDIDOS - DISTRIBUIR KG ENTRE PROVEEDORES
// ============================================================


// ============================================================
// PEDIDOS - DISTRIBUCIÓN PORCENTUAL POR PROVEEDOR
// ============================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS pedido_distribucion_porcentajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ciclo_id TEXT NOT NULL,
    periodo TEXT NOT NULL,
    codigo TEXT NOT NULL,
    proveedor TEXT NOT NULL,
    porcentaje REAL NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL,
    UNIQUE(ciclo_id, periodo, codigo, proveedor)
  );

  CREATE INDEX IF NOT EXISTS idx_pedido_pct_ciclo_periodo
  ON pedido_distribucion_porcentajes(ciclo_id, periodo);
`);


function normalizarCabeceraPedidoPct(v) {

  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}


function obtenerDemandaPedidoPct(ciclo, periodo) {

  return db.prepare(`
    SELECT *
    FROM demandas_pedido
    WHERE ciclo_id = ?
      AND periodo = ?
    LIMIT 1
  `).get(ciclo, periodo);
}


// ------------------------------------------------------------
// DESCARGAR PLANTILLA
// ------------------------------------------------------------

app.get(
  "/api/pedidos/distribucion-porcentajes/plantilla",
  async (req, res) => {

    try {

      const ciclo =
        String(req.query.ciclo || "").trim();

      const periodo =
        String(
          req.query.periodo ||
          "LUNES-MARTES"
        )
          .trim()
          .toUpperCase();


      if (!ciclo) {

        return res.status(400).json({
          error:
            "Selecciona primero el ciclo."
        });
      }


      const demanda =
        obtenerDemandaPedidoPct(
          ciclo,
          periodo
        );


      if (!demanda) {

        return res.status(404).json({
          error:
            "No existe una demanda cargada para este ciclo y periodo."
        });
      }


      const detalles =
        db.prepare(`
          SELECT
            id,
            codigo,
            producto,
            cantidad_requerida
          FROM demanda_pedido_detalles
          WHERE demanda_id = ?
          ORDER BY producto
        `).all(demanda.id);


      const pctGuardados =
        db.prepare(`
          SELECT
            codigo,
            proveedor,
            porcentaje
          FROM pedido_distribucion_porcentajes
          WHERE ciclo_id = ?
            AND periodo = ?
        `).all(
          ciclo,
          periodo
        );


      const pctMapa = {};

      pctGuardados.forEach(r => {

        pctMapa[
          String(r.codigo) +
          "||" +
          String(r.proveedor)
        ] =
          Number(r.porcentaje || 0);
      });


      const workbook =
        new ExcelJS.Workbook();

      workbook.creator =
        "Mercaldas Fruver";


      const ws =
        workbook.addWorksheet(
          "Distribucion",
          {
            views: [
              {
                state: "frozen",
                ySplit: 4
              }
            ]
          }
        );


      const VERDE_OSCURO =
        "1F6B45";

      const VERDE_MEDIO =
        "6FAE82";

      const VERDE_CLARO =
        "EAF5EE";

      const BLANCO =
        "FFFFFF";

      const BORDE =
        "B7C9BD";


      ws.mergeCells("A1:E1");

      ws.getCell("A1").value =
        "MERCALDAS - DISTRIBUCIÓN DE PEDIDOS POR PROVEEDOR";

      ws.getCell("A1").font = {
        bold: true,
        size: 16,
        color: {
          argb: BLANCO
        }
      };

      ws.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb: VERDE_OSCURO
        }
      };

      ws.getCell("A1").alignment = {
        horizontal: "center",
        vertical: "middle"
      };

      ws.getRow(1).height = 34;


      ws.mergeCells("A2:E2");

      ws.getCell("A2").value =
        "Ciclo: " +
        ciclo +
        "   |   Periodo: " +
        periodo;


      ws.mergeCells("A3:E3");

      ws.getCell("A3").value =
        "Ingrese el porcentaje que desea asignar a cada proveedor. Por producto, el total ideal es 100%.";


      const headers = [
        "PLU",
        "Producto",
        "Proveedor",
        "% Distribución",
        "Demanda KG"
      ];


      headers.forEach(
        (h, i) => {

          const c =
            ws.getCell(
              4,
              i + 1
            );

          c.value = h;

          c.font = {
            bold: true,
            color: {
              argb: BLANCO
            }
          };

          c.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: {
              argb: VERDE_MEDIO
            }
          };

          c.alignment = {
            horizontal: "center",
            vertical: "middle",
            wrapText: true
          };

          c.border = {
            top: {
              style: "thin",
              color: {
                argb: BORDE
              }
            },
            bottom: {
              style: "thin",
              color: {
                argb: BORDE
              }
            },
            left: {
              style: "thin",
              color: {
                argb: BORDE
              }
            },
            right: {
              style: "thin",
              color: {
                argb: BORDE
              }
            }
          };
        }
      );


      let fila = 5;


      for (const d of detalles) {

        const proveedores =
          db.prepare(`
            SELECT DISTINCT proveedor
            FROM proveedor_productos
            WHERE codigo = ?
              AND activo = 1
            ORDER BY proveedor
          `).all(d.codigo);


        for (const pr of proveedores) {

          const key =
            String(d.codigo) +
            "||" +
            String(pr.proveedor);


          ws.getCell(
            fila,
            1
          ).value =
            String(d.codigo);

          ws.getCell(
            fila,
            2
          ).value =
            d.producto || "";

          ws.getCell(
            fila,
            3
          ).value =
            pr.proveedor;

          ws.getCell(
            fila,
            4
          ).value =
            pctMapa[key] !== undefined
              ? pctMapa[key]
              : null;

          ws.getCell(
            fila,
            5
          ).value =
            Number(
              d.cantidad_requerida || 0
            );


          for (
            let col = 1;
            col <= 5;
            col++
          ) {

            const c =
              ws.getCell(
                fila,
                col
              );

            c.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: {
                argb:
                  fila % 2 === 0
                    ? VERDE_CLARO
                    : BLANCO
              }
            };

            c.border = {
              top: {
                style: "thin",
                color: {
                  argb: BORDE
                }
              },
              bottom: {
                style: "thin",
                color: {
                  argb: BORDE
                }
              },
              left: {
                style: "thin",
                color: {
                  argb: BORDE
                }
              },
              right: {
                style: "thin",
                color: {
                  argb: BORDE
                }
              }
            };
          }


          ws.getCell(
            fila,
            1
          ).numFmt = "@";

          ws.getCell(
            fila,
            4
          ).numFmt = '0.00"%"';

          ws.getCell(
            fila,
            5
          ).numFmt = '0.00';


          fila++;
        }
      }


      ws.getColumn(1).width = 14;
      ws.getColumn(2).width = 38;
      ws.getColumn(3).width = 34;
      ws.getColumn(4).width = 18;
      ws.getColumn(5).width = 16;


      ws.autoFilter = {
        from: {
          row: 4,
          column: 1
        },
        to: {
          row: 4,
          column: 5
        }
      };


      const buffer =
        await workbook.xlsx.writeBuffer();


      const archivo =
        "DISTRIBUCION_PROVEEDORES_" +
        ciclo +
        "_" +
        periodo +
        ".xlsx";


      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="' +
        archivo +
        '"'
      );


      res.send(
        Buffer.from(buffer)
      );


    } catch (err) {

      console.error(
        "[PLANTILLA DISTRIBUCION % ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo generar la plantilla."
      });
    }
  }
);


// ------------------------------------------------------------
// IMPORTAR PORCENTAJES
// ------------------------------------------------------------

app.post(
  "/api/pedidos/distribucion-porcentajes/importar",
  upload.single("archivo"),
  (req, res) => {

    try {

      if (
        !req.file ||
        !req.file.buffer
      ) {

        return res.status(400).json({
          error:
            "Selecciona un archivo Excel."
        });
      }


      const ciclo =
        String(
          req.body.ciclo_id ||
          req.query.ciclo ||
          ""
        ).trim();


      const periodo =
        String(
          req.body.periodo ||
          req.query.periodo ||
          "LUNES-MARTES"
        )
          .trim()
          .toUpperCase();


      if (!ciclo) {

        return res.status(400).json({
          error:
            "Falta seleccionar el ciclo."
        });
      }


      const demanda =
        obtenerDemandaPedidoPct(
          ciclo,
          periodo
        );


      if (!demanda) {

        return res.status(404).json({
          error:
            "No existe demanda para este ciclo y periodo."
        });
      }


      const wb =
        XLSX.read(
          req.file.buffer,
          {
            type: "buffer"
          }
        );


      const hoja =
        wb.Sheets[
          wb.SheetNames[0]
        ];


      // Leemos como matriz porque la plantilla tiene
      // título, ciclo e instrucciones antes del encabezado.
      const matriz =
        XLSX.utils.sheet_to_json(
          hoja,
          {
            header: 1,
            defval: "",
            raw: true
          }
        );


      if (!matriz.length) {

        return res.status(400).json({
          error:
            "El archivo no contiene filas."
        });
      }


      // Buscar automáticamente la fila donde están:
      // PLU / Producto / Proveedor / % Distribución
      let indiceCabecera = -1;

      for (
        let i = 0;
        i < Math.min(
          matriz.length,
          20
        );
        i++
      ) {

        const cabeceras =
          (matriz[i] || []).map(
            v =>
              normalizarCabeceraPedidoPct(v)
          );


        const tienePlu =
          cabeceras.includes("PLU") ||
          cabeceras.includes("CODIGO") ||
          cabeceras.includes("CÓDIGO");

        const tieneProveedor =
          cabeceras.includes("PROVEEDOR");

        const tieneDistribucion =
          cabeceras.includes("% DISTRIBUCION") ||
          cabeceras.includes("% DISTRIBUCIÓN") ||
          cabeceras.includes("PORCENTAJE") ||
          cabeceras.includes("DISTRIBUCION");


        if (
          tienePlu &&
          tieneProveedor &&
          tieneDistribucion
        ) {

          indiceCabecera = i;
          break;
        }
      }


      if (indiceCabecera === -1) {

        return res.status(400).json({
          error:
            "No encontré las columnas PLU, Proveedor y % Distribución en el archivo."
        });
      }


      const cabeceras =
        matriz[
          indiceCabecera
        ].map(
          v =>
            String(v || "").trim()
        );


      const filas = [];


      for (
        let i =
          indiceCabecera + 1;
        i < matriz.length;
        i++
      ) {

        const valores =
          matriz[i] || [];


        const vacia =
          valores.every(
            v =>
              v === "" ||
              v === null ||
              v === undefined
          );


        if (vacia) {
          continue;
        }


        const objeto = {};


        cabeceras.forEach(
          (cabecera, col) => {

            if (!cabecera) {
              return;
            }

            objeto[cabecera] =
              valores[col] !== undefined
                ? valores[col]
                : "";
          }
        );


        filas.push(objeto);
      }


      if (!filas.length) {

        return res.status(400).json({
          error:
            "No encontré productos debajo de los encabezados."
        });
      }


      console.log(
        "[DISTRIBUCION % IMPORT]",
        {
          hoja:
            wb.SheetNames[0],
          filaCabecera:
            indiceCabecera + 1,
          cabeceras,
          filas:
            filas.length
        }
      );


      const detalles =
        db.prepare(`
          SELECT
            id,
            codigo,
            producto,
            cantidad_requerida
          FROM demanda_pedido_detalles
          WHERE demanda_id = ?
        `).all(demanda.id);


      const detallePorCodigo = {};

      detalles.forEach(d => {

        detallePorCodigo[
          String(d.codigo).trim()
        ] = d;
      });


      const errores = [];
      const registros = [];
      const vistos = new Set();


      filas.forEach(
        (fila, index) => {

          const mapa = {};

          Object.keys(fila).forEach(k => {

            mapa[
              normalizarCabeceraPedidoPct(k)
            ] =
              fila[k];
          });


          const codigo =
            String(
              mapa["PLU"] ||
              mapa["CODIGO"] ||
              mapa["CÓDIGO"] ||
              ""
            ).trim();


          const proveedor =
            String(
              mapa["PROVEEDOR"] ||
              ""
            )
              .trim()
              .toUpperCase();


          // Buscar cualquier encabezado que contenga
          // DISTRIBUCION o PORCENTAJE.
          let porcentajeRaw = undefined;

          for (const [clave, valor] of Object.entries(mapa)) {

            const k =
              normalizarCabeceraPedidoPct(clave);

            if (
              k.includes("DISTRIBUCION") ||
              k.includes("PORCENTAJE")
            ) {

              porcentajeRaw =
                valor;

              break;
            }
          }


          let porcentaje = null;

          if (
            porcentajeRaw !== undefined &&
            porcentajeRaw !== null &&
            porcentajeRaw !== ""
          ) {

            let valorTexto =
              String(porcentajeRaw)
                .trim()
                .replace(",", ".");

            const teniaSimbolo =
              valorTexto.includes("%");

            valorTexto =
              valorTexto.replace("%", "");

            let valor =
              Number(valorTexto);

            if (
              Number.isFinite(valor)
            ) {

              // Excel puede guardar 60% como 0.60.
              // Si viene entre 0 y 1, lo convertimos a porcentaje.
              if (
                !teniaSimbolo &&
                valor > 0 &&
                valor <= 1
              ) {
                valor =
                  valor * 100;
              }

              porcentaje =
                valor;
            }
          }


          // Si no diligenciaron porcentaje, ignorar la fila.
          // La plantilla incluye todos los proveedores posibles,
          // pero no todos necesariamente participan en el pedido.
          if (
            porcentajeRaw === "" ||
            porcentajeRaw === null ||
            porcentajeRaw === undefined
          ) {
            return;
          }


          const nFila =
            index + 2;


          if (!codigo) {

            errores.push(
              "Fila " +
              nFila +
              ": falta PLU."
            );

            return;
          }


          if (!proveedor) {

            errores.push(
              "Fila " +
              nFila +
              ": falta proveedor."
            );

            return;
          }


          if (
            Number.isFinite(porcentaje) &&
            porcentaje === 0
          ) {
            return;
          }

          if (
            !Number.isFinite(
              porcentaje
            ) ||
            porcentaje < 0 ||
            porcentaje > 100
          ) {

            errores.push(
              "Fila " +
              nFila +
              ": porcentaje inválido."
            );

            return;
          }


          const detalle =
            detallePorCodigo[
              codigo
            ];


          if (!detalle) {

            errores.push(
              "Fila " +
              nFila +
              ": el PLU " +
              codigo +
              " no está en la demanda."
            );

            return;
          }


          const relacion =
            db.prepare(`
              SELECT 1
              FROM proveedor_productos
              WHERE proveedor = ?
                AND codigo = ?
                AND activo = 1
              LIMIT 1
            `).get(
              proveedor,
              codigo
            );


          if (!relacion) {

            errores.push(
              "Fila " +
              nFila +
              ": " +
              proveedor +
              " no está activo para el PLU " +
              codigo +
              "."
            );

            return;
          }


          const key =
            codigo +
            "||" +
            proveedor;


          if (
            vistos.has(key)
          ) {

            errores.push(
              "Fila " +
              nFila +
              ": combinación PLU/proveedor duplicada."
            );

            return;
          }


          vistos.add(key);


          registros.push({
            codigo,
            proveedor,
            porcentaje
          });
        }
      );


      if (errores.length) {

        return res.status(400).json({
          error:
            "El archivo tiene errores.",
          errores:
            errores.slice(0, 30)
        });
      }


      if (!registros.length) {

        return res.status(400).json({
          error:
            "No se encontraron porcentajes válidos."
        });
      }


      const ahora =
        new Date().toISOString();


      const guardarPct =
        db.transaction(() => {

          db.prepare(`
            DELETE FROM pedido_distribucion_porcentajes
            WHERE ciclo_id = ?
              AND periodo = ?
          `).run(
            ciclo,
            periodo
          );


          const insertar =
            db.prepare(`
              INSERT INTO pedido_distribucion_porcentajes (
                ciclo_id,
                periodo,
                codigo,
                proveedor,
                porcentaje,
                creado_en,
                actualizado_en
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);


          registros.forEach(r => {

            insertar.run(
              ciclo,
              periodo,
              r.codigo,
              r.proveedor,
              r.porcentaje,
              ahora,
              ahora
            );
          });
        });


      guardarPct();


      const porProducto = {};

      registros.forEach(r => {

        if (
          !porProducto[r.codigo]
        ) {
          porProducto[r.codigo] = 0;
        }

        porProducto[r.codigo] +=
          Number(
            r.porcentaje || 0
          );
      });


      let completos = 0;
      let pendientes = 0;
      let excedidos = 0;


      Object.values(
        porProducto
      ).forEach(total => {

        if (
          Math.abs(
            total - 100
          ) < 0.01
        ) {
          completos++;
        } else if (
          total < 100
        ) {
          pendientes++;
        } else {
          excedidos++;
        }
      });


      res.json({
        ok: true,
        registros:
          registros.length,
        productos:
          Object.keys(
            porProducto
          ).length,
        completos,
        pendientes,
        excedidos
      });


    } catch (err) {

      console.error(
        "[IMPORTAR DISTRIBUCION % ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo importar la distribución."
      });
    }
  }
);


// ------------------------------------------------------------
// CONSULTAR DISTRIBUCIÓN PORCENTUAL
// ------------------------------------------------------------

app.get(
  "/api/pedidos/distribucion-porcentajes",
  (req, res) => {

    try {

      const ciclo =
        String(
          req.query.ciclo || ""
        ).trim();


      const periodo =
        String(
          req.query.periodo ||
          "LUNES-MARTES"
        )
          .trim()
          .toUpperCase();


      if (!ciclo) {

        return res.status(400).json({
          error:
            "Selecciona un ciclo."
        });
      }


      const demanda =
        obtenerDemandaPedidoPct(
          ciclo,
          periodo
        );


      if (!demanda) {

        return res.json({
          demanda: null,
          items: [],
          resumen: {
            productos: 0,
            completos: 0,
            pendientes: 0,
            excedidos: 0
          }
        });
      }


      const detalles =
        db.prepare(`
          SELECT
            id,
            codigo,
            producto,
            cantidad_requerida
          FROM demanda_pedido_detalles
          WHERE demanda_id = ?
          ORDER BY producto
        `).all(demanda.id);


      const porcentajes =
        db.prepare(`
          SELECT
            codigo,
            proveedor,
            porcentaje
          FROM pedido_distribucion_porcentajes
          WHERE ciclo_id = ?
            AND periodo = ?
          ORDER BY codigo, proveedor
        `).all(
          ciclo,
          periodo
        );


      const pctPorCodigo = {};

      porcentajes.forEach(r => {

        if (
          !pctPorCodigo[
            String(r.codigo)
          ]
        ) {
          pctPorCodigo[
            String(r.codigo)
          ] = [];
        }

        pctPorCodigo[
          String(r.codigo)
        ].push({
          proveedor:
            r.proveedor,
          porcentaje:
            Number(
              r.porcentaje || 0
            )
        });
      });


      const items =
        detalles.map(d => {

          const distribucion =
            pctPorCodigo[
              String(d.codigo)
            ] || [];


          const totalPct =
            distribucion.reduce(
              (s, r) =>
                s +
                Number(
                  r.porcentaje || 0
                ),
              0
            );


          const requerido =
            Number(
              d.cantidad_requerida || 0
            );


          const kgCalculados =
            requerido *
            totalPct /
            100;


          let estado =
            "sin_configurar";

          if (totalPct > 100.01) {
            estado = "excedido";
          } else if (
            Math.abs(
              totalPct - 100
            ) < 0.01
          ) {
            estado = "completo";
          } else if (
            totalPct > 0
          ) {
            estado = "pendiente";
          }


          return {
            demanda_detalle_id:
              d.id,
            codigo:
              d.codigo,
            producto:
              d.producto,
            cantidad_requerida:
              requerido,
            total_porcentaje:
              totalPct,
            kg_calculados:
              kgCalculados,
            estado,
            distribucion
          };
        });


      const resumen = {
        productos:
          items.length,
        completos:
          items.filter(
            i =>
              i.estado ===
              "completo"
          ).length,
        pendientes:
          items.filter(
            i =>
              i.estado ===
                "pendiente" ||
              i.estado ===
                "sin_configurar"
          ).length,
        excedidos:
          items.filter(
            i =>
              i.estado ===
              "excedido"
          ).length
      };


      res.json({
        demanda,
        items,
        resumen
      });


    } catch (err) {

      console.error(
        "[GET DISTRIBUCION % ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo consultar la distribución."
      });
    }
  }
);


// ------------------------------------------------------------
// APLICAR PORCENTAJES A KILOS
// ------------------------------------------------------------

app.post(
  "/api/pedidos/distribucion-porcentajes/aplicar",
  (req, res) => {

    try {

      const ciclo =
        String(
          req.body.ciclo_id || ""
        ).trim();


      const periodo =
        String(
          req.body.periodo ||
          "LUNES-MARTES"
        )
          .trim()
          .toUpperCase();


      if (!ciclo) {

        return res.status(400).json({
          error:
            "Falta seleccionar el ciclo."
        });
      }


      const demanda =
        obtenerDemandaPedidoPct(
          ciclo,
          periodo
        );


      if (!demanda) {

        return res.status(404).json({
          error:
            "No existe demanda para este ciclo y periodo."
        });
      }


      const detalles =
        db.prepare(`
          SELECT
            id,
            codigo,
            producto,
            cantidad_requerida
          FROM demanda_pedido_detalles
          WHERE demanda_id = ?
        `).all(demanda.id);


      const configs =
        db.prepare(`
          SELECT
            codigo,
            proveedor,
            porcentaje
          FROM pedido_distribucion_porcentajes
          WHERE ciclo_id = ?
            AND periodo = ?
          ORDER BY codigo, proveedor
        `).all(
          ciclo,
          periodo
        );


      if (!configs.length) {

        return res.status(400).json({
          error:
            "Primero carga un archivo de porcentajes."
        });
      }


      const configPorCodigo = {};

      configs.forEach(r => {

        const cod =
          String(r.codigo);

        if (!configPorCodigo[cod]) {
          configPorCodigo[cod] = [];
        }

        configPorCodigo[cod].push({
          proveedor:
            r.proveedor,
          porcentaje:
            Number(
              r.porcentaje || 0
            )
        });
      });


      const excedidos = [];


      for (
        const [codigo, lista]
        of Object.entries(
          configPorCodigo
        )
      ) {

        const total =
          lista.reduce(
            (s, r) =>
              s +
              Number(
                r.porcentaje || 0
              ),
            0
          );


        if (total > 100.01) {

          excedidos.push({
            codigo,
            porcentaje:
              total
          });
        }
      }


      if (excedidos.length) {

        return res.status(409).json({
          error:
            "Hay productos cuya distribución supera el 100%. Corrige el archivo antes de aplicar.",
          excedidos
        });
      }


      const insertar =
        db.prepare(`
          INSERT INTO pedido_asignaciones (
            demanda_detalle_id,
            proveedor,
            negociacion_producto_id,
            precio_unitario,
            cantidad_asignada,
            subtotal,
            fuente_precio,
            creado_en,
            actualizado_en
          )
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `);


      const ahora =
        new Date().toISOString();


      let productosAplicados = 0;
      let asignacionesCreadas = 0;


      const aplicar =
        db.transaction(() => {

          for (const detalle of detalles) {

            const lista =
              configPorCodigo[
                String(
                  detalle.codigo
                )
              ];


            if (
              !lista ||
              !lista.length
            ) {
              continue;
            }


            const totalPct =
              lista.reduce(
                (s, r) =>
                  s +
                  Number(
                    r.porcentaje || 0
                  ),
                0
              );


            if (totalPct <= 0) {
              continue;
            }


            // Para productos configurados,
            // reemplazamos la distribución manual anterior.
            db.prepare(`
              DELETE FROM pedido_asignaciones
              WHERE demanda_detalle_id = ?
            `).run(
              detalle.id
            );


            const requerido =
              Number(
                detalle.cantidad_requerida || 0
              );


            const vista =
              datosDistribucionPedido(
                detalle.id
              );


            let acumuladoKg = 0;


            lista.forEach(
              (r, index) => {

                if (
                  Number(
                    r.porcentaje || 0
                  ) <= 0
                ) {
                  return;
                }


                let cantidad =
                  Math.round(
                    (
                      requerido *
                      Number(
                        r.porcentaje
                      ) /
                      100
                    ) *
                    1000
                  ) /
                  1000;


                // Cuando suma exactamente 100%,
                // el último proveedor absorbe
                // cualquier diferencia por redondeo.
                if (
                  Math.abs(
                    totalPct - 100
                  ) < 0.01 &&
                  index ===
                    lista.length - 1
                ) {

                  cantidad =
                    Math.max(
                      0,
                      Math.round(
                        (
                          requerido -
                          acumuladoKg
                        ) *
                        1000
                      ) /
                      1000
                    );
                }


                acumuladoKg +=
                  cantidad;


                const proveedorVista =
                  vista &&
                  Array.isArray(
                    vista.proveedores
                  )
                    ? vista.proveedores.find(
                        p =>
                          p.proveedor ===
                          r.proveedor
                      )
                    : null;


                let precio = null;
                let fuente =
                  "sin_precio";


                if (
                  proveedorVista &&
                  proveedorVista.contrapropuesta !== null &&
                  proveedorVista.contrapropuesta !== undefined
                ) {

                  precio =
                    Number(
                      proveedorVista.contrapropuesta
                    );

                  fuente =
                    "contrapropuesta";

                } else if (
                  proveedorVista &&
                  proveedorVista.precio_ofertado !== null &&
                  proveedorVista.precio_ofertado !== undefined
                ) {

                  precio =
                    Number(
                      proveedorVista.precio_ofertado
                    );

                  fuente =
                    "precio_ofertado";
                }


                insertar.run(
                  detalle.id,
                  r.proveedor,
                  precio,
                  cantidad,
                  precio !== null
                    ? precio *
                      cantidad
                    : 0,
                  fuente,
                  ahora,
                  ahora
                );


                asignacionesCreadas++;
              }
            );


            productosAplicados++;
          }
        });


      aplicar();


      res.json({
        ok: true,
        productos_aplicados:
          productosAplicados,
        asignaciones:
          asignacionesCreadas
      });


    } catch (err) {

      console.error(
        "[APLICAR DISTRIBUCION % ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo aplicar la distribución."
      });
    }
  }
);



function datosDistribucionPedido(detalleId) {

  const detalle = db.prepare(`
    SELECT
      d.id,
      d.demanda_id,
      d.codigo,
      d.producto,
      d.cantidad_requerida,
      dp.ciclo_id,
      dp.periodo
    FROM demanda_pedido_detalles d
    JOIN demandas_pedido dp
      ON dp.id = d.demanda_id
    WHERE d.id = ?
  `).get(detalleId);

  if (!detalle) {
    return null;
  }


  const quotes =
    getAllQuotes(detalle.ciclo_id);

  const pct =
    getContrapropuestaPct();


  const proveedores =
    db.prepare(`
      SELECT DISTINCT proveedor
      FROM proveedor_productos
      WHERE codigo = ?
        AND activo = 1
      ORDER BY proveedor
    `).all(detalle.codigo)
      .map(r => r.proveedor);


  const asignacionesActuales =
    db.prepare(`
      SELECT *
      FROM pedido_asignaciones
      WHERE demanda_detalle_id = ?
    `).all(detalle.id);


  const asignacionPorProveedor = {};

  asignacionesActuales.forEach(a => {
    asignacionPorProveedor[a.proveedor] = a;
  });


  const opciones = [];


  for (const proveedor of proveedores) {

    const vista =
      computeVistaProveedor(
        quotes,
        proveedor,
        pct
      );

    const item =
      vista.find(
        x =>
          String(x.codigo) ===
          String(detalle.codigo)
      ) || null;


    const relacion =
      db.prepare(`
        SELECT
          activo,
          contrapropuesta_manual
        FROM proveedor_productos
        WHERE proveedor = ?
          AND codigo = ?
      `).get(
        proveedor,
        detalle.codigo
      );


    if (
      relacion &&
      relacion.activo === 0
    ) {
      continue;
    }


    let contrapropuesta =
      item
        ? item.contrapropuesta
        : null;


    if (
      relacion &&
      relacion.contrapropuesta_manual !== null &&
      relacion.contrapropuesta_manual !== undefined
    ) {
      contrapropuesta =
        Number(
          relacion.contrapropuesta_manual
        );
    }


    const asignacion =
      asignacionPorProveedor[proveedor];


    opciones.push({

      proveedor,

      cotizo:
        !!item,

      precio_ofertado:
        item &&
        item.precioProveedor !== null &&
        item.precioProveedor !== undefined
          ? Number(item.precioProveedor)
          : null,

      contrapropuesta:
        contrapropuesta !== null &&
        contrapropuesta !== undefined
          ? Number(contrapropuesta)
          : null,

      cantidad_asignada:
        asignacion
          ? Number(
              asignacion.cantidad_asignada || 0
            )
          : 0

    });
  }


  opciones.sort((a, b) => {

    const pa =
      a.contrapropuesta === null
        ? Infinity
        : a.contrapropuesta;

    const pb =
      b.contrapropuesta === null
        ? Infinity
        : b.contrapropuesta;

    return pa - pb;
  });


  const totalAsignado =
    opciones.reduce(
      (acc, x) =>
        acc +
        Number(x.cantidad_asignada || 0),
      0
    );


  return {

    detalle: {
      id:
        detalle.id,

      codigo:
        detalle.codigo,

      producto:
        detalle.producto,

      cantidad_requerida:
        Number(
          detalle.cantidad_requerida || 0
        ),

      ciclo_id:
        detalle.ciclo_id,

      periodo:
        detalle.periodo
    },

    proveedores:
      opciones,

    total_asignado:
      totalAsignado,

    pendiente:
      Math.max(
        0,
        Number(detalle.cantidad_requerida || 0) -
        totalAsignado
      ),

    exceso:
      Math.max(
        0,
        totalAsignado -
        Number(detalle.cantidad_requerida || 0)
      )

  };
}


// ============================================================
// CONSULTAR DISTRIBUCIÓN
// ============================================================

app.get(
  "/api/pedidos/distribucion/:detalleId",
  (req, res) => {

    try {

      const detalleId =
        Number(req.params.detalleId);

      if (!detalleId) {

        return res.status(400).json({
          error:
            "Detalle de pedido inválido."
        });
      }


      const data =
        datosDistribucionPedido(
          detalleId
        );


      if (!data) {

        return res.status(404).json({
          error:
            "No se encontró el producto del pedido."
        });
      }


      res.json(data);


    } catch (err) {

      console.error(
        "[PEDIDOS DISTRIBUCION GET ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo consultar la distribución."
      });
    }
  }
);


// ============================================================
// GUARDAR DISTRIBUCIÓN
// ============================================================

app.post(
  "/api/pedidos/distribucion",
  (req, res) => {

    console.log(
      "[PEDIDOS DISTRIBUCION POST RECIBIDO]",
      JSON.stringify(req.body || {})
    );

    try {

      const detalleId =
        Number(
          req.body &&
          req.body.demanda_detalle_id
        );


      const asignaciones =
        Array.isArray(
          req.body &&
          req.body.asignaciones
        )
          ? req.body.asignaciones
          : [];


      if (!detalleId) {

        return res.status(400).json({
          error:
            "Detalle de pedido inválido."
        });
      }


      const data =
        datosDistribucionPedido(
          detalleId
        );


      if (!data) {

        return res.status(404).json({
          error:
            "No se encontró el producto del pedido."
        });
      }


      const proveedoresPermitidos =
        new Map(
          data.proveedores.map(p => [
            p.proveedor,
            p
          ])
        );


      let totalNuevo = 0;

      const limpias = [];


      for (const a of asignaciones) {

        const proveedor =
          String(
            a.proveedor || ""
          ).trim();

        const cantidad =
          Number(
            a.cantidad || 0
          );


        if (!proveedor) {
          continue;
        }


        if (
          !Number.isFinite(cantidad) ||
          cantidad < 0
        ) {

          return res.status(400).json({
            error:
              "Hay una cantidad inválida para " +
              proveedor +
              "."
          });
        }


        const info =
          proveedoresPermitidos.get(
            proveedor
          );


        if (!info) {

          return res.status(400).json({
            error:
              "El proveedor " +
              proveedor +
              " no cotizó este producto en el ciclo."
          });
        }


        totalNuevo += cantidad;


        limpias.push({
          proveedor,
          cantidad,
          contrapropuesta:
            info.contrapropuesta,
          precio_ofertado:
            info.precio_ofertado
        });
      }


      const requerido =
        Number(
          data.detalle.cantidad_requerida || 0
        );


      if (
        totalNuevo >
        requerido + 0.000001
      ) {

        const exceso =
          totalNuevo - requerido;

        return res.status(409).json({

          error:
            "Pedido excedido. Requerido: " +
            requerido +
            " kg. Asignado: " +
            totalNuevo +
            " kg. Exceso: " +
            exceso +
            " kg.",

          requerido,
          asignado:
            totalNuevo,

          exceso

        });
      }


      const ahora =
        new Date().toISOString();


      const guardar =
        db.transaction(() => {

          // Eliminamos distribución anterior
          // para reconstruirla exactamente
          // con lo enviado por la interfaz.

          db.prepare(`
            DELETE FROM pedido_asignaciones
            WHERE demanda_detalle_id = ?
          `).run(detalleId);


          const insertar =
            db.prepare(`
              INSERT INTO pedido_asignaciones (
                demanda_detalle_id,
                proveedor,
                negociacion_producto_id,
                precio_unitario,
                cantidad_asignada,
                subtotal,
                fuente_precio,
                creado_en,
                actualizado_en
              )
              VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
            `);


          for (const a of limpias) {

            if (a.cantidad <= 0) {
              continue;
            }


            let precio = null;
            let fuente = "sin_precio";

            if (
              a.contrapropuesta !== null &&
              a.contrapropuesta !== undefined
            ) {
              precio =
                Number(a.contrapropuesta);

              fuente =
                "contrapropuesta";

            } else if (
              a.precio_ofertado !== null &&
              a.precio_ofertado !== undefined
            ) {
              precio =
                Number(a.precio_ofertado);

              fuente =
                "precio_ofertado";
            }


            insertar.run(
              detalleId,
              a.proveedor,
              precio,
              a.cantidad,
              precio !== null
                ? precio * a.cantidad
                : 0,
              fuente,
              ahora,
              ahora
            );
          }
        });


      guardar();


      const actualizado =
        datosDistribucionPedido(
          detalleId
        );


      res.json({
        ok: true,

        requerido:
          actualizado.detalle
            .cantidad_requerida,

        asignado:
          actualizado.total_asignado,

        pendiente:
          actualizado.pendiente,

        exceso:
          actualizado.exceso,

        estado:
          actualizado.exceso > 0
            ? "EXCEDIDO"
            : actualizado.pendiente > 0
              ? "PENDIENTE"
              : "COMPLETO"
      });


    } catch (err) {

      console.error(
        "[PEDIDOS DISTRIBUCION POST ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo guardar la distribución."
      });
    }
  }
);


app.get("/api/files", (req, res) => {
  res.json(getAllFiles(req.query.ciclo));
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
  res.json(getAllQuotes(req.query.ciclo));
});

app.get("/api/comparativo", (req, res) => {
  const pct = getContrapropuestaPct();
  const rows = computeComparativo(getAllQuotes(req.query.ciclo), pct).map(({ _quotes, ...rest }) => rest);
  res.json(rows);
});

app.get("/api/alertas", (req, res) => {
  const pct = getContrapropuestaPct();
  const comparativo = computeComparativo(getAllQuotes(req.query.ciclo), pct);
  res.json(computeAlertas(comparativo));
});

app.get("/api/proveedores", (req, res) => {
  const rows = db.prepare("SELECT nombre FROM proveedores ORDER BY nombre").all();
  res.json(rows.map((r) => r.nombre));
});

app.get("/api/proveedores/lista", (req, res) => {
  const rows = db.prepare("SELECT nombre, creado_en FROM proveedores ORDER BY nombre").all();
  res.json(rows);
});

app.post("/api/proveedores", (req, res) => {
  const { nombre } = req.body || {};
  const nom = nombre ? String(nombre).trim().toUpperCase() : "";
  if (!nom) return res.status(400).json({ error: "Falta el nombre del proveedor." });

  const existente = db.prepare("SELECT nombre FROM proveedores WHERE nombre = ?").get(nom);
  if (existente) return res.status(409).json({ error: "Ya existe un proveedor con ese nombre." });

  db.prepare("INSERT INTO proveedores (nombre, creado_en) VALUES (?, ?)").run(nom, new Date().toISOString());
  res.json({ ok: true, nombre: nom });
});

app.put("/api/proveedores/:nombre", (req, res) => {
  const nombreActual = String(req.params.nombre).trim();
  const { nuevoNombre } = req.body || {};
  const nuevo = nuevoNombre ? String(nuevoNombre).trim().toUpperCase() : "";
  if (!nuevo) return res.status(400).json({ error: "Falta el nuevo nombre." });

  const existente = db.prepare("SELECT nombre FROM proveedores WHERE nombre = ?").get(nombreActual);
  if (!existente) return res.status(404).json({ error: "No existe ese proveedor." });
  if (nuevo !== nombreActual) {
    const choque = db.prepare("SELECT nombre FROM proveedores WHERE nombre = ?").get(nuevo);
    if (choque) return res.status(409).json({ error: "Ya existe un proveedor con ese nombre nuevo." });
  }

  const renombrar = db.transaction(() => {
    db.prepare("UPDATE proveedores SET nombre = ? WHERE nombre = ?").run(nuevo, nombreActual);
    db.prepare("UPDATE quotes SET proveedor = ? WHERE proveedor = ?").run(nuevo, nombreActual);
    db.prepare("UPDATE proveedor_productos SET proveedor = ? WHERE proveedor = ?").run(nuevo, nombreActual);
    db.prepare("UPDATE files SET proveedor = ? WHERE proveedor = ?").run(nuevo, nombreActual);
  });
  renombrar();

  res.json({ ok: true, nombre: nuevo });
});

app.delete("/api/proveedores/:nombre", (req, res) => {

  const nombre =
    String(req.params.nombre || "").trim();

  if (!nombre) {
    return res.status(400).json({
      error: "Falta el nombre del proveedor."
    });
  }

  const existente =
    db.prepare(`
      SELECT nombre
      FROM proveedores
      WHERE nombre = ?
    `).get(nombre);

  if (!existente) {
    return res.status(404).json({
      error: "El proveedor ya no existe."
    });
  }

  const eliminarProveedor =
    db.transaction(() => {

      // Se desactivan todos sus productos.
      // No se borran cotizaciones históricas.
      const relaciones =
        db.prepare(`
          UPDATE proveedor_productos
          SET
            activo = 0,
            actualizado_en = ?
          WHERE proveedor = ?
        `).run(
          new Date().toISOString(),
          nombre
        );

      db.prepare(`
        DELETE FROM proveedores
        WHERE nombre = ?
      `).run(nombre);

      return relaciones.changes;
    });

  const relacionesDesactivadas =
    eliminarProveedor();

  res.json({
    ok: true,
    nombre,
    relacionesDesactivadas,
    historicoConservado: true
  });

});

app.get("/api/por-proveedor", (req, res) => {
  const proveedor = (req.query.proveedor || "").trim();
  if (!proveedor) return res.status(400).json({ error: "Falta el parámetro proveedor." });
  const pct = getContrapropuestaPct();
  const quotes = getAllQuotes(req.query.ciclo);
  let items = computeVistaProveedor(quotes, proveedor, pct);

  const asociados = db.prepare("SELECT codigo, tipo, contrapropuesta_manual, activo, frecuencia FROM proveedor_productos WHERE proveedor = ?").all(proveedor);
  const tipoPorCodigo = {};
  const manualPorCodigo = {};
  const activoPorCodigo = {};
  const frecuenciaPorCodigo = {};
  asociados.forEach((a) => {
    tipoPorCodigo[a.codigo] = a.tipo;
    manualPorCodigo[a.codigo] = a.contrapropuesta_manual;
    activoPorCodigo[a.codigo] = a.activo;
    frecuenciaPorCodigo[a.codigo] = a.frecuencia || "diario";
  });

  const ultimaFechaPorCodigo = {};
  db.prepare(`
    SELECT q.codigo, MAX(f.uploaded_at) as ultima_fecha
    FROM quotes q JOIN files f ON f.id = q.file_id
    WHERE q.proveedor = ?
    GROUP BY q.codigo
  `).all(proveedor).forEach((r) => { ultimaFechaPorCodigo[r.codigo] = r.ultima_fecha; });

  // El catálogo maestro manda.
  // Si un PLU fue eliminado del catálogo, no debe aparecer
  // en la operación actual aunque exista en quotes históricos.
  const codigosCatalogoActivos = new Set(
    db.prepare(`
      SELECT codigo
      FROM catalogo
    `).all().map(r => String(r.codigo))
  );

  items = items.filter((it) =>
    activoPorCodigo[it.codigo] !== 0 &&
    codigosCatalogoActivos.has(String(it.codigo))
  );

  items.forEach((it) => {
    it.tipo = tipoPorCodigo[it.codigo] || null;
    it.frecuencia = frecuenciaPorCodigo[it.codigo] || "diario";
    if (it.frecuencia === "semanal" && ultimaFechaPorCodigo[it.codigo]) {
      it.semanaVigencia = calcularSemanaVigencia(ultimaFechaPorCodigo[it.codigo]);
    } else {
      it.semanaVigencia = null;
    }
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
        presentacion: cat.presentacion || "",
        precioProveedor: null,
        precioMinimo: global ? global.precioMin : null,
        proveedorMinimo: global ? global.proveedorMin : null,
        esElMinimo: false,
        esUnico: global ? global.nProveedores === 1 : false,
        nProveedores: global ? global.nProveedores : 0,
        contrapropuesta: manual !== undefined && manual !== null ? manual : (global ? global.contrapropuesta : null),
        redondeada: manual !== undefined && manual !== null ? manual : (global ? global.redondeada : null),
        contrapropuestaEsManual: manual !== undefined && manual !== null,
        tipo: a.tipo,
        frecuencia: a.frecuencia || "diario",
        semanaVigencia: null,
        sinCotizarEstaSemana: true,
      });
    });

  items.sort((a, b) => (a.producto || "").localeCompare(b.producto || ""));
  res.json({ proveedor, contrapropuestaPct: pct, items });
});


app.get("/api/por-proveedor/plantilla-cotizacion", async (req, res) => {
  try {

    const proveedor = String(req.query.proveedor || "").trim();

    if (!proveedor) {
      return res.status(400).json({
        error: "Falta seleccionar el proveedor."
      });
    }

    const ciclo = obtenerCicloActivo();

    const portafolio = db.prepare(`
      SELECT
        pp.codigo,
        pp.tipo,
        pp.frecuencia,
        COALESCE(pp.presentacion_proveedor, c.presentacion, '') AS presentacion,
        COALESCE(c.producto, '') AS producto
      FROM proveedor_productos pp
      LEFT JOIN catalogo c ON c.codigo = pp.codigo
      WHERE pp.proveedor = ?
        AND pp.activo = 1
      ORDER BY
        CASE WHEN pp.tipo = 'habitual' THEN 0 ELSE 1 END,
        c.producto,
        pp.codigo
    `).all(proveedor);

    const habituales = portafolio.filter(
      p => p.tipo === "habitual"
    );

    const temporales = portafolio.filter(
      p => p.tipo !== "habitual"
    );

    // PLU del catálogo que NO están actualmente en el portafolio del proveedor
    const otros = db.prepare(`
      SELECT
        c.codigo,
        COALESCE(c.producto, '') AS producto,
        COALESCE(c.presentacion, '') AS presentacion
      FROM catalogo c
      WHERE NOT EXISTS (
        SELECT 1
        FROM proveedor_productos pp
        WHERE pp.proveedor = ?
          AND pp.codigo = c.codigo
          AND pp.activo = 1
      )
      ORDER BY c.producto, c.codigo
    `).all(proveedor);


    const workbook = new ExcelJS.Workbook();

    workbook.creator = "Mercaldas Fruver";
    workbook.created = new Date();

    const ws = workbook.addWorksheet("Cotizacion", {
      views: [{ state: "frozen", ySplit: 4 }]
    });


    // =====================================================
    // COLORES CORPORATIVOS
    // =====================================================

    const VERDE_OSCURO = "1F6B45";
    const VERDE_MEDIO  = "6FAE82";
    const VERDE_CLARO  = "EAF5EE";
    const VERDE_MUY_CLARO = "F7FBF8";
    const BLANCO       = "FFFFFF";
    const BORDE        = "B7C9BD";
    const TEXTO        = "24342B";


    function capitalizar(texto) {
      const t = String(texto || "").trim().toLowerCase();

      return t.replace(/\b\p{L}/gu, letra => letra.toUpperCase());
    }


    function bordeCelda(cell) {
      cell.border = {
        top:    { style: "thin", color: { argb: BORDE } },
        left:   { style: "thin", color: { argb: BORDE } },
        bottom: { style: "thin", color: { argb: BORDE } },
        right:  { style: "thin", color: { argb: BORDE } }
      };
    }


    function tituloSeccion(fila, texto) {

      ws.mergeCells(`A${fila}:G${fila}`);

      const c = ws.getCell(`A${fila}`);

      c.value = texto;

      c.font = {
        bold: true,
        size: 13,
        color: { argb: BLANCO }
      };

      c.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: VERDE_OSCURO }
      };

      c.alignment = {
        horizontal: "left",
        vertical: "middle"
      };

      ws.getRow(fila).height = 27;

      for (let col = 1; col <= 7; col++) {
        bordeCelda(ws.getCell(fila, col));
      }
    }


    function encabezado(fila, valores) {

      valores.forEach((valor, i) => {

        const cell = ws.getCell(fila, i + 1);

        cell.value = valor;

        cell.font = {
          bold: true,
          color: { argb: BLANCO }
        };

        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: VERDE_MEDIO }
        };

        cell.alignment = {
          horizontal: "center",
          vertical: "middle",
          wrapText: true
        };

        bordeCelda(cell);
      });

      ws.getRow(fila).height = 30;
    }


    function filaProducto(fila, indice) {

      const color =
        indice % 2 === 0
          ? BLANCO
          : VERDE_MUY_CLARO;

      for (let col = 1; col <= 7; col++) {

        const cell = ws.getCell(fila, col);

        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: color }
        };

        cell.font = {
          color: { argb: TEXTO }
        };

        cell.alignment = {
          vertical: "middle",
          wrapText: true
        };

        bordeCelda(cell);
      }

      ws.getRow(fila).height = 23;
    }


    // =====================================================
    // CABECERA
    // =====================================================

    ws.mergeCells("A1:G1");

    ws.getCell("A1").value =
      "MERCALDAS - COTIZACIÓN FRUVER";

    ws.getCell("A1").font = {
      bold: true,
      size: 17,
      color: { argb: BLANCO }
    };

    ws.getCell("A1").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: VERDE_OSCURO }
    };

    ws.getCell("A1").alignment = {
      horizontal: "center",
      vertical: "middle"
    };

    ws.getRow(1).height = 34;


    ws.mergeCells("A2:G2");

    ws.getCell("A2").value =
      "Proveedor: " + capitalizar(proveedor);

    ws.getCell("A2").font = {
      bold: true,
      size: 12,
      color: { argb: VERDE_OSCURO }
    };


    ws.mergeCells("A3:G3");

    ws.getCell("A3").value =
      ciclo
        ? "Semana / ciclo: " + ciclo.id +
          "   |   Vigencia: " +
          ciclo.fecha_inicio_vigencia +
          " al " +
          ciclo.fecha_fin_vigencia
        : "Sin ciclo de cotización activo";

    ws.getCell("A3").font = {
      bold: true,
      color: { argb: TEXTO }
    };


    // =====================================================
    // HABITUALES
    // =====================================================

    let fila = 5;

    tituloSeccion(
      fila,
      "Cotización habitual de productos - " +
      (ciclo ? ciclo.id : "Sin ciclo")
    );

    fila++;

    encabezado(fila, [
      "PLU",
      "Producto",
      "Presentación",
      "Frecuencia",
      "Precio Ofertado",
      "Disponibilidad",
      "Observación"
    ]);

    fila++;

    habituales.forEach((p, i) => {

      ws.getCell(fila, 1).value = String(p.codigo);
      ws.getCell(fila, 2).value = capitalizar(p.producto);
      ws.getCell(fila, 3).value = capitalizar(p.presentacion);
      ws.getCell(fila, 4).value = capitalizar(p.frecuencia);
      ws.getCell(fila, 5).value = "";
      ws.getCell(fila, 6).value = "";
      ws.getCell(fila, 7).value = "";

      filaProducto(fila, i);

      fila++;
    });


    // =====================================================
    // TEMPORADA + OTRAS OPORTUNIDADES
    // =====================================================

    fila += 2;

    tituloSeccion(
      fila,
      "Productos de temporada y otras oportunidades - " +
      (ciclo ? ciclo.id : "Sin ciclo")
    );

    fila++;

    encabezado(fila, [
      "PLU",
      "Producto",
      "Presentación",
      "Ofertar Esta Semana",
      "Precio Ofertado",
      "Disponibilidad",
      "Observación"
    ]);

    fila++;

    const oportunidades = [
      ...temporales.map(p => ({
        codigo: p.codigo,
        producto: p.producto,
        presentacion: p.presentacion
      })),
      ...otros.map(p => ({
        codigo: p.codigo,
        producto: p.producto,
        presentacion: p.presentacion
      }))
    ];

    oportunidades.forEach((p, i) => {

      ws.getCell(fila, 1).value = String(p.codigo);
      ws.getCell(fila, 2).value = capitalizar(p.producto);
      ws.getCell(fila, 3).value = capitalizar(p.presentacion);
      ws.getCell(fila, 4).value = "NO";
      ws.getCell(fila, 5).value = "";
      ws.getCell(fila, 6).value = "";
      ws.getCell(fila, 7).value = "";

      filaProducto(fila, i);

      fila++;
    });


    // =====================================================
    // FORMATOS / ANCHOS
    // =====================================================

    ws.columns = [
      { width: 13 },
      { width: 38 },
      { width: 18 },
      { width: 22 },
      { width: 18 },
      { width: 20 },
      { width: 42 }
    ];


    // =====================================================
    // INSTRUCCIONES
    // =====================================================

    const info = workbook.addWorksheet("Instrucciones");

    info.columns = [
      { width: 27 },
      { width: 88 }
    ];

    const instrucciones = [
      ["Formato", "Cotización Mercaldas Fruver"],
      ["Proveedor", capitalizar(proveedor)],
      ["Ciclo", ciclo ? ciclo.id : "Sin ciclo activo"],
      [
        "Vigencia",
        ciclo
          ? ciclo.fecha_inicio_vigencia +
            " al " +
            ciclo.fecha_fin_vigencia
          : ""
      ],
      ["", ""],
      [
        "Habituales",
        "Ingrese el precio de los productos que normalmente suministra."
      ],
      [
        "Temporada",
        'Cambie "Ofertar Esta Semana" a SI únicamente en los productos que desea ofrecer.'
      ],
      [
        "Otros productos",
        "Puede seleccionar excepcionalmente cualquier otro PLU Mercaldas disponible en la tercera sección."
      ],
      [
        "Importante",
        "No cambie el código PLU. El sistema valida todos los productos durante la carga."
      ]
    ];

    instrucciones.forEach((datos, i) => {

      const row = info.addRow(datos);

      row.getCell(1).font = {
        bold: true
      };

      row.eachCell(cell => {

        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: {
            argb:
              i % 2 === 0
                ? VERDE_CLARO
                : BLANCO
          }
        };

        bordeCelda(cell);
      });
    });


    const proveedorSeguro = proveedor
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    const cicloNombre =
      ciclo ? ciclo.id : "SIN_CICLO";

    const buffer =
      await workbook.xlsx.writeBuffer();

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Cotizacion_${proveedorSeguro}_${cicloNombre}.xlsx"`
    );

    res.send(Buffer.from(buffer));

  } catch (err) {

    console.error(
      "Error generando formato de cotización:",
      err
    );

    res.status(500).json({
      error:
        "No se pudo generar el formato de cotización."
    });
  }
});




app.get("/api/por-proveedor/export", async (req, res) => {

  try {

    const proveedor =
      String(
        req.query.proveedor || ""
      ).trim();

    if (!proveedor) {
      return res.status(400).json({
        error:
          "Falta el parámetro proveedor."
      });
    }


    // Para este formato de contrapropuesta
    // Mercaldas aplicará siempre 2%.
    const pct = 2;

    // =====================================================
    // PRODUCTOS DEL PROVEEDOR + REFERENCIAS DE MERCADO
    // =====================================================

    const quotes =
      getAllQuotes(req.query.ciclo);

    // Vista de los productos que ESTE proveedor sí cotizó.
    const vistaPropia =
      computeVistaProveedor(
        quotes,
        proveedor,
        pct
      );

    const propiaPorCodigo = {};

    vistaPropia.forEach(it => {
      propiaPorCodigo[
        String(it.codigo)
      ] = it;
    });


    // Comparativo general del mercado.
    // Aquí obtenemos el mejor precio por PLU
    // y la contrapropuesta redondeada al 2%.
    const comparativo =
      computeComparativo(
        quotes,
        pct
      );

    const referenciaPorCodigo = {};

    comparativo.forEach(it => {
      referenciaPorCodigo[
        String(it.codigo)
      ] = it;
    });


    // Productos activos que el proveedor puede suministrar.
    const portafolio =
      db.prepare(`
        SELECT
          pp.codigo,
          COALESCE(c.producto, '') AS producto,
          COALESCE(c.presentacion, '') AS presentacion
        FROM proveedor_productos pp
        LEFT JOIN catalogo c
          ON c.codigo = pp.codigo
        WHERE pp.proveedor = ?
          AND pp.activo = 1
        ORDER BY c.producto, pp.codigo
      `).all(proveedor);


    const items = [];


    for (const prod of portafolio) {

      const codigo =
        String(prod.codigo);

      const propia =
        propiaPorCodigo[codigo] || null;

      const referencia =
        referenciaPorCodigo[codigo] || null;


      // Si no cotizó y tampoco existe ninguna referencia
      // de mercado, no podemos generar una contrapropuesta.
      if (!propia && !referencia) {
        continue;
      }


      let precioProveedor = null;

      if (
        propia &&
        propia.precioProveedor !== null &&
        propia.precioProveedor !== undefined
      ) {
        precioProveedor =
          Number(
            propia.precioProveedor
          );
      }


      let contrapropuesta = null;
      let redondeada = null;


      if (propia) {

        contrapropuesta =
          propia.contrapropuesta !== null &&
          propia.contrapropuesta !== undefined
            ? Number(
                propia.contrapropuesta
              )
            : null;

        redondeada =
          propia.redondeada !== null &&
          propia.redondeada !== undefined
            ? Number(
                propia.redondeada
              )
            : null;

      } else if (referencia) {

        // No existe cotización propia:
        // usamos el mercado como referencia.
        contrapropuesta =
          referencia.contrapropuesta !== null &&
          referencia.contrapropuesta !== undefined
            ? Number(
                referencia.contrapropuesta
              )
            : null;

        redondeada =
          referencia.redondeada !== null &&
          referencia.redondeada !== undefined
            ? Number(
                referencia.redondeada
              )
            : null;
      }


      items.push({

        codigo,

        producto:
          propia && propia.producto
            ? propia.producto
            : prod.producto,

        presentacion:
          propia && propia.presentacion
            ? propia.presentacion
            : prod.presentacion,

        precioProveedor,

        contrapropuesta,

        redondeada,

        sinCotizacionPropia:
          !propia,

        precioReferencia:
          referencia &&
          referencia.precioMin !== null &&
          referencia.precioMin !== undefined
            ? Number(
                referencia.precioMin
              )
            : null

      });
    }


    if (!items.length) {

      return res.status(404).json({
        error:
          "No hay productos con cotización o referencia de mercado para este proveedor."
      });
    }


    // =====================================================
    // CREAR EXCEL
    // =====================================================

    const workbook =
      new ExcelJS.Workbook();

    workbook.creator =
      "Mercaldas Fruver";

    workbook.created =
      new Date();


    const ws =
      workbook.addWorksheet(
        "Contrapropuesta",
        {
          views: [
            {
              state: "frozen",
              ySplit: 5
            }
          ]
        }
      );


    // =====================================================
    // COLORES MERCALDAS
    // =====================================================

    const VERDE_OSCURO =
      "1F6B45";

    const VERDE_MEDIO =
      "6FAE82";

    const VERDE_CLARO =
      "EAF5EE";

    const VERDE_MUY_CLARO =
      "F7FBF8";

    const BLANCO =
      "FFFFFF";

    const BORDE =
      "B7C9BD";

    const TEXTO =
      "24342B";


    function capitalizar(texto) {

      const t =
        String(texto || "")
          .trim()
          .toLowerCase();

      return t.replace(
        /\b\p{L}/gu,
        letra =>
          letra.toUpperCase()
      );
    }


    function borde(cell) {

      cell.border = {

        top: {
          style: "thin",
          color: {
            argb: BORDE
          }
        },

        left: {
          style: "thin",
          color: {
            argb: BORDE
          }
        },

        bottom: {
          style: "thin",
          color: {
            argb: BORDE
          }
        },

        right: {
          style: "thin",
          color: {
            argb: BORDE
          }
        }

      };
    }


    // =====================================================
    // TÍTULO
    // =====================================================

    ws.mergeCells("A1:F1");

    const titulo =
      ws.getCell("A1");

    titulo.value =
      "MERCALDAS - CONTRAPROPUESTA COMERCIAL FRUVER";

    titulo.font = {
      bold: true,
      size: 17,
      color: {
        argb: BLANCO
      }
    };

    titulo.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb: VERDE_OSCURO
      }
    };

    titulo.alignment = {
      horizontal: "center",
      vertical: "middle"
    };

    ws.getRow(1).height = 35;


    // =====================================================
    // PROVEEDOR
    // =====================================================

    ws.mergeCells("A2:F2");

    const provCell =
      ws.getCell("A2");

    provCell.value =
      "Proveedor: " +
      capitalizar(proveedor);

    provCell.font = {
      bold: true,
      size: 12,
      color: {
        argb: VERDE_OSCURO
      }
    };

    provCell.alignment = {
      vertical: "middle"
    };

    ws.getRow(2).height = 23;


    // =====================================================
    // CICLO / MENSAJE
    // =====================================================

    ws.mergeCells("A3:F3");

    ws.getCell("A3").value =
      "Ciclo: " +
      (
        req.query.ciclo ||
        "Actual"
      ) +
      "   |   Contrapropuesta aplicada: 2%";


    ws.getCell("A3").font = {
      color: {
        argb: TEXTO
      },
      italic: true
    };


    ws.mergeCells("A4:F4");

    ws.getCell("A4").value =
      "Propuesta comercial Mercaldas";

    ws.getCell("A4").font = {
      bold: true,
      color: {
        argb: VERDE_OSCURO
      }
    };


    // =====================================================
    // ENCABEZADOS
    // =====================================================

    const headers = [
      "PROVEEDOR",
      "PLU",
      "PRODUCTO",
      "PRECIO COTIZADO",
      "CONTRAPROPUESTA",
      "PRECIO FINAL"
    ];


    headers.forEach(
      (valor, index) => {

        const cell =
          ws.getCell(
            5,
            index + 1
          );

        cell.value =
          valor;

        cell.font = {
          bold: true,
          color: {
            argb: BLANCO
          }
        };

        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: {
            argb: VERDE_MEDIO
          }
        };

        cell.alignment = {
          horizontal: "center",
          vertical: "middle",
          wrapText: true
        };

        borde(cell);
      }
    );

    ws.getRow(5).height =
      32;


    // =====================================================
    // PRODUCTOS
    // =====================================================

    items.forEach(
      (it, index) => {

        const fila =
          6 + index;

        const colorFila =
          index % 2 === 0
            ? BLANCO
            : VERDE_MUY_CLARO;


        // 1. PROVEEDOR
        ws.getCell(
          fila,
          1
        ).value =
          capitalizar(proveedor);


        // 2. PLU
        ws.getCell(
          fila,
          2
        ).value =
          String(
            it.codigo || ""
          );


        // 3. PRODUCTO
        ws.getCell(
          fila,
          3
        ).value =
          it.producto || "";


        // 4. PRECIO COTIZADO
        ws.getCell(
          fila,
          4
        ).value =
          it.precioProveedor !== null &&
          it.precioProveedor !== undefined
            ? Number(
                it.precioProveedor
              )
            : "SIN COTIZACIÓN";


        // 5. CONTRAPROPUESTA
        // Se usa la contrapropuesta REDONDEADA
        // calculada por la lógica del sistema al 2%.
        ws.getCell(
          fila,
          5
        ).value =
          it.redondeada !== null &&
          it.redondeada !== undefined
            ? Number(
                it.redondeada
              )
            : (
                it.contrapropuesta !== null &&
                it.contrapropuesta !== undefined
                  ? Math.round(
                      Number(
                        it.contrapropuesta
                      )
                    )
                  : null
              );


        // 6. PRECIO FINAL
        // Se deja vacío para diligenciar el valor definitivo
        // después de la negociación.
        ws.getCell(
          fila,
          6
        ).value = null;


        for (
          let col = 1;
          col <= 6;
          col++
        ) {

          const cell =
            ws.getCell(
              fila,
              col
            );

          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: {
              argb: colorFila
            }
          };

          cell.font = {
            color: {
              argb: TEXTO
            }
          };

          cell.alignment = {
            vertical: "middle",
            wrapText: true
          };

          borde(cell);
        }


        // PLU como texto
        ws.getCell(
          fila,
          2
        ).numFmt =
          "@";


        // Moneda
        ws.getCell(
          fila,
          4
        ).numFmt =
          '$ #,##0';

        ws.getCell(
          fila,
          5
        ).numFmt =
          '$ #,##0';

        ws.getCell(
          fila,
          6
        ).numFmt =
          '$ #,##0';


        // Centrar PLU y precios
        ws.getCell(
          fila,
          2
        ).alignment = {
          horizontal: "center",
          vertical: "middle"
        };

        ws.getCell(
          fila,
          4
        ).alignment = {
          horizontal: "right",
          vertical: "middle"
        };

        ws.getCell(
          fila,
          5
        ).alignment = {
          horizontal: "right",
          vertical: "middle"
        };

        ws.getCell(
          fila,
          6
        ).alignment = {
          horizontal: "right",
          vertical: "middle"
        };


        ws.getRow(
          fila
        ).height =
          23;
      }
    );


    // =====================================================
    // ANCHOS
    // =====================================================

    ws.getColumn(1).width =
      28;

    ws.getColumn(2).width =
      14;

    ws.getColumn(3).width =
      42;

    ws.getColumn(4).width =
      20;

    ws.getColumn(5).width =
      22;

    ws.getColumn(6).width =
      20;


    // =====================================================
    // FILTROS
    // =====================================================

    ws.autoFilter = {
      from: {
        row: 5,
        column: 1
      },
      to: {
        row: 5,
        column: 6
      }
    };


    // =====================================================
    // DESCARGAR
    // =====================================================

    const buffer =
      await workbook.xlsx.writeBuffer();


    const nombreSeguro =
      proveedor
        .replace(
          /[^a-zA-Z0-9ÁÉÍÓÚáéíóúÑñ_-]+/g,
          "_"
        )
        .replace(
          /^_+|_+$/g,
          ""
        );


    const nombreArchivo =
      "CONTRAPROPUESTA_" +
      nombreSeguro +
      ".xlsx";


    res.setHeader(
      "Content-Disposition",
      'attachment; filename="' +
      nombreArchivo +
      '"'
    );


    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );


    res.send(
      Buffer.from(buffer)
    );


  } catch (err) {

    console.error(
      "[EXPORT CONTRAPROPUESTA ERROR]",
      err
    );

    res.status(500).json({
      error:
        err.message ||
        "No se pudo generar la contrapropuesta."
    });
  }
});


app.get("/api/agrupamiento", (req, res) => {
  const umbral = req.query.umbral !== undefined ? Number(req.query.umbral) : 10;
  res.json(computeAgrupamiento(getAllQuotes(req.query.ciclo), isNaN(umbral) ? 10 : umbral));
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
  const quotes = getAllQuotes(req.query.ciclo);
  const pct = getContrapropuestaPct();
  const comparativo = computeComparativo(quotes, pct);
  res.json(computeDashboard(quotes, comparativo));
});

app.get("/api/export", (req, res) => {
  const quotes = getAllQuotes(req.query.ciclo);
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

// manejo de errores de multer / parseo
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Error inesperado" });
});



// ============================================================
// NEGOCIACIÓN UNIFICADA
// ============================================================


// ------------------------------------------------------------
// LISTAR NEGOCIACIONES
// ------------------------------------------------------------

app.get(
  "/api/negociaciones-unificadas",
  (req, res) => {

    try {

      const ciclo =
        String(
          req.query.ciclo || ""
        ).trim();


      let rows;


      if (ciclo) {

        rows = db.prepare(`
          SELECT
            n.id,
            n.ciclo_id,
            n.proveedor,
            n.estado,
            n.ronda_actual,
            n.creado_en,
            n.actualizado_en,
            n.cerrado_en,

            COUNT(p.id) AS productos,

            SUM(
              CASE
                WHEN p.estado = 'aceptado'
                THEN 1
                ELSE 0
              END
            ) AS aceptados,

            SUM(
              CASE
                WHEN p.estado = 'pendiente'
                THEN 1
                ELSE 0
              END
            ) AS pendientes

          FROM negociaciones_unificadas n

          LEFT JOIN negociacion_unificada_productos p
            ON p.negociacion_id = n.id

          WHERE n.ciclo_id = ?

          GROUP BY n.id

          ORDER BY
            n.actualizado_en DESC,
            n.proveedor
        `).all(ciclo);

      } else {

        rows = db.prepare(`
          SELECT
            n.id,
            n.ciclo_id,
            n.proveedor,
            n.estado,
            n.ronda_actual,
            n.creado_en,
            n.actualizado_en,
            n.cerrado_en,

            COUNT(p.id) AS productos,

            SUM(
              CASE
                WHEN p.estado = 'aceptado'
                THEN 1
                ELSE 0
              END
            ) AS aceptados,

            SUM(
              CASE
                WHEN p.estado = 'pendiente'
                THEN 1
                ELSE 0
              END
            ) AS pendientes

          FROM negociaciones_unificadas n

          LEFT JOIN negociacion_unificada_productos p
            ON p.negociacion_id = n.id

          GROUP BY n.id

          ORDER BY
            n.actualizado_en DESC,
            n.proveedor
        `).all();

      }


      res.json(rows);

    } catch (err) {

      console.error(
        "[NEGOCIACION UNIFICADA LISTA ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudieron consultar las negociaciones."
      });

    }
  }
);


// ------------------------------------------------------------
// VER UNA NEGOCIACIÓN
// ------------------------------------------------------------

app.get(
  "/api/negociaciones-unificadas/:id",
  (req, res) => {

    try {

      const id =
        Number(req.params.id);


      if (!Number.isInteger(id) || id <= 0) {

        return res.status(400).json({
          error:
            "ID de negociación inválido."
        });
      }


      const negociacion =
        db.prepare(`
          SELECT *
          FROM negociaciones_unificadas
          WHERE id = ?
        `).get(id);


      if (!negociacion) {

        return res.status(404).json({
          error:
            "No existe la negociación."
        });
      }


      const productos =
        db.prepare(`
          SELECT *
          FROM negociacion_unificada_productos
          WHERE negociacion_id = ?
          ORDER BY producto, codigo
        `).all(id);


      const historial =
        db.prepare(`
          SELECT *
          FROM negociacion_unificada_historial
          WHERE negociacion_id = ?
          ORDER BY
            ronda,
            id
        `).all(id);


      res.json({
        negociacion,
        productos,
        historial
      });

    } catch (err) {

      console.error(
        "[NEGOCIACION UNIFICADA DETALLE ERROR]",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "No se pudo consultar la negociación."
      });

    }
  }
);


// ------------------------------------------------------------
// INICIAR NEGOCIACIÓN DESDE LA COTIZACIÓN DEL PROVEEDOR
// ------------------------------------------------------------

app.post(
  "/api/negociaciones-unificadas/iniciar",
  (req, res) => {

    try {

      const ciclo =
        String(
          req.body?.ciclo || ""
        ).trim();


      const proveedor =
        String(
          req.body?.proveedor || ""
        ).trim();


      if (!ciclo) {

        return res.status(400).json({
          error:
            "Falta seleccionar el ciclo."
        });
      }


      if (!proveedor) {

        return res.status(400).json({
          error:
            "Falta seleccionar el proveedor."
        });
      }


      // ======================================================
      // Evitar dos expedientes para el mismo proveedor/ciclo
      // ======================================================

      const existente =
        db.prepare(`
          SELECT *
          FROM negociaciones_unificadas
          WHERE ciclo_id = ?
            AND proveedor = ?
        `).get(
          ciclo,
          proveedor
        );


      if (existente) {

        const productos =
          db.prepare(`
            SELECT *
            FROM negociacion_unificada_productos
            WHERE negociacion_id = ?
            ORDER BY producto
          `).all(existente.id);


        return res.json({
          ok: true,
          existente: true,
          negociacion_id:
            existente.id,
          ciclo:
            existente.ciclo_id,
          proveedor:
            existente.proveedor,
          estado:
            existente.estado,
          ronda_actual:
            existente.ronda_actual,
          productos:
            productos.length,
          items:
            productos
        });
      }


      // ======================================================
      // Tomar únicamente las cotizaciones del ciclo
      // ======================================================

      const quotes =
        getAllQuotes(ciclo);


      if (!quotes.length) {

        return res.status(404).json({
          error:
            "No existen cotizaciones para este ciclo."
        });
      }


      // ======================================================
      // Aplicar la misma lógica actual del comparativo
      // ======================================================

      const pct =
        getContrapropuestaPct();


      const vistaProveedor =
        computeVistaProveedor(
          quotes,
          proveedor,
          pct
        );


      if (!vistaProveedor.length) {

        return res.status(404).json({
          error:
            "Este proveedor no tiene cotizaciones en el ciclo seleccionado."
        });
      }


      const ahora =
        new Date().toISOString();


      const crear =
        db.transaction(() => {


          // ==================================================
          // CABECERA
          // ==================================================

          const resultado =
            db.prepare(`
              INSERT INTO negociaciones_unificadas (
                ciclo_id,
                proveedor,
                estado,
                ronda_actual,
                creado_en,
                actualizado_en
              )
              VALUES (
                ?,
                ?,
                'abierta',
                2,
                ?,
                ?
              )
            `).run(
              ciclo,
              proveedor,
              ahora,
              ahora
            );


          const negociacionId =
            Number(
              resultado.lastInsertRowid
            );


          // ==================================================
          // PRODUCTOS
          // ==================================================

          const insertarProducto =
            db.prepare(`
              INSERT INTO negociacion_unificada_productos (
                negociacion_id,
                codigo,
                producto,
                presentacion,
                propuesta_inicial,
                contrapropuesta_mercaldas,
                propuesta_final_proveedor,
                precio_final,
                estado,
                observacion,
                creado_en,
                actualizado_en
              )
              VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                NULL,
                NULL,
                'pendiente',
                NULL,
                ?,
                ?
              )
            `);


          const insertarHistorial =
            db.prepare(`
              INSERT INTO negociacion_unificada_historial (
                negociacion_id,
                codigo,
                ronda,
                origen,
                precio,
                estado,
                observacion,
                creado_en
              )
              VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?
              )
            `);


          vistaProveedor.forEach(it => {

            const inicial =
              it.precioProveedor !== null &&
              it.precioProveedor !== undefined
                ? Number(
                    it.precioProveedor
                  )
                : null;


            // Usamos la contrapropuesta que ya calcula
            // actualmente la plataforma.
            //
            // Si existe la versión redondeada,
            // esa tiene prioridad.
            const contrapropuesta =
              it.redondeada !== null &&
              it.redondeada !== undefined
                ? Number(
                    it.redondeada
                  )
                : (
                    it.contrapropuesta !== null &&
                    it.contrapropuesta !== undefined
                      ? Number(
                          it.contrapropuesta
                        )
                      : null
                  );


            insertarProducto.run(
              negociacionId,
              String(it.codigo),
              it.producto || "",
              it.presentacion || "",
              inicial,
              contrapropuesta,
              ahora,
              ahora
            );


            // ================================================
            // RONDA 1 - PROPUESTA INICIAL PROVEEDOR
            // ================================================

            insertarHistorial.run(
              negociacionId,
              String(it.codigo),
              1,
              "PROVEEDOR",
              inicial,
              "propuesta_inicial",
              "Cotización inicial del proveedor.",
              ahora
            );


            // ================================================
            // RONDA 2 - CONTRAPROPUESTA MERCALDAS
            // ================================================

            insertarHistorial.run(
              negociacionId,
              String(it.codigo),
              2,
              "MERCALDAS",
              contrapropuesta,
              "contrapropuesta",
              "Contrapropuesta generada por Mercaldas.",
              ahora
            );

          });


          return negociacionId;

        });


      const negociacionId =
        crear();


      const productos =
        db.prepare(`
          SELECT *
          FROM negociacion_unificada_productos
          WHERE negociacion_id = ?
          ORDER BY producto
        `).all(negociacionId);


      res.json({
        ok: true,
        existente: false,
        negociacion_id:
          negociacionId,
        ciclo,
        proveedor,
        estado:
          "abierta",
        ronda_actual:
          2,
        contrapropuesta_pct:
          pct,
        productos:
          productos.length,
        items:
          productos
      });


    } catch (err) {

      console.error(
        "[NEGOCIACION UNIFICADA INICIAR ERROR]",
        err
      );


      res.status(500).json({
        error:
          err.message ||
          "No se pudo iniciar la negociación."
      });

    }
  }
);


app.listen(PORT, () => {
  console.log(`Comparador de Cotizaciones escuchando en el puerto ${PORT}`);
});
