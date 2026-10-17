"use strict";
const db = require("./db");

// ---------------------------------------------------------------------------
// LOS MÁS CAROS DE LA SEMANA (recuadro de la pestaña Alertas), POR PROVEEDOR
// Cada propuesta se compara con la MÁS BARATA del mismo producto en la semana:
//   - Proveedor más caro: el que, en promedio, cotiza más por encima del mejor precio.
//   - Detalle de un proveedor: los productos en los que está por encima del mejor precio.
// Solo cuentan productos cotizados por 2 o más proveedores. De cada proveedor se usa su precio más bajo por producto.
// ---------------------------------------------------------------------------
const MIN_PRODUCTOS_PROVEEDOR = 3;
const UMBRAL_PCT = 15;

const REQUERIDAS = {
  ciclos: ["id"],
  quotes: ["codigo", "precio", "proveedor", "ciclo_id"],
};

function esquemaFaltante() {
  const falta = [];
  for (const [tabla, cols] of Object.entries(REQUERIDAS)) {
    const reales = new Set(db.prepare('PRAGMA table_info("' + tabla + '")').all().map((c) => c.name));
    cols.filter((c) => !reales.has(c)).forEach((c) => falta.push(tabla + "." + c));
  }
  return falta;
}

function leerAjuste(clave) {
  try {
    const f = db.prepare("SELECT value FROM settings WHERE key = ?").get(clave);
    return f && f.value != null ? f.value : null;
  } catch (e) {
    return null;
  }
}

function umbralPct() {
  const n = Number(leerAjuste("mas_caros_umbral_pct"));
  return Number.isFinite(n) && n > 0 && n < 100 ? n : UMBRAL_PCT;
}

function cicloPorDefecto() {
  const existe = (id) => (id ? db.prepare("SELECT id FROM ciclos WHERE id = ?").get(String(id)) : null);
  const trabajo = leerAjuste("semana_trabajo_id");
  if (existe(trabajo)) return String(trabajo);
  const activo = leerAjuste("ciclo_activo_id");
  if (existe(activo)) return String(activo);
  return null;
}

function etiquetaCiclo(id) {
  const m = /^COT-(\d{4})-(\d{1,2})$/.exec(String(id || ""));
  return m ? "Semana " + Number(m[2]) + " (" + id + ")" : String(id || "");
}

const redondear1 = (n) => Math.round(n * 10) / 10;
const redondear2 = (n) => Math.round(n * 100) / 100;

// Productos de la semana cotizados por 2 o más proveedores, con el precio más bajo de cada proveedor.
function analizar(cicloId, deps) {
  const ciclo = db.prepare("SELECT id FROM ciclos WHERE id = ?").get(cicloId);
  if (!ciclo) return null;

  const productos = new Map();
  for (const q of deps.getAllQuotes(cicloId)) {
    const precio = Number(q.precio);
    const proveedor = String(q.proveedor || "").trim();
    if (!(precio > 0) || !proveedor) continue;
    const clave = String(q.codigo);
    let p = productos.get(clave);
    if (!p) {
      p = { codigo: clave, producto: "", presentacion: "", porProveedor: new Map() };
      productos.set(clave, p);
    }
    if (!p.producto && q.producto) p.producto = String(q.producto);
    if (!p.presentacion && q.presentacion) p.presentacion = String(q.presentacion);
    const actual = p.porProveedor.get(proveedor);
    if (actual === undefined || precio < actual) p.porProveedor.set(proveedor, precio);
  }

  const comparables = [];
  for (const p of productos.values()) {
    if (p.porProveedor.size < 2) continue;
    const lista = Array.from(p.porProveedor.entries()).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const min = lista[0][1];
    const max = lista[lista.length - 1][1];
    comparables.push({
      codigo: p.codigo,
      producto: p.producto,
      presentacion: p.presentacion,
      lista,
      min,
      max,
      mejores: lista.filter((e) => e[1] === min).map((e) => e[0]).sort(),
      topes: lista.filter((e) => e[1] === max).map((e) => e[0]).sort(),
    });
  }
  return { ciclo, comparables };
}

function calcular(cicloId, deps) {
  const a = analizar(cicloId, deps);
  if (!a) return null;
  const um = umbralPct();

  const stats = new Map();
  let masCaro = null;
  for (const p of a.comparables) {
    for (const [proveedor, precio] of p.lista) {
      const over = ((precio - p.min) / p.min) * 100;
      const s = stats.get(proveedor) || { suma: 0, n: 0, veces: 0, sobre: 0 };
      s.suma += over;
      s.n++;
      if (p.max > p.min && precio === p.max) s.veces++;
      if (redondear1(over) >= um) s.sobre++;
      stats.set(proveedor, s);
    }
    if (p.max > p.min) {
      const dif = p.max - p.min;
      const pct = (dif / p.min) * 100;
      if (!masCaro || pct > masCaro._pct || (pct === masCaro._pct && (dif > masCaro._dif || (dif === masCaro._dif && p.producto.localeCompare(masCaro.producto) < 0)))) {
        masCaro = {
          codigo: p.codigo,
          producto: p.producto,
          presentacion: p.presentacion,
          proveedor_mas_caro: p.topes[0],
          tambien_mas_caro: p.topes.slice(1),
          precio_mas_caro: p.max,
          proveedor_mas_barato: p.mejores[0],
          precio_mas_barato: p.min,
          diferencia: redondear2(dif),
          diferencia_pct: redondear1(pct),
          proveedores: p.lista.length,
          _pct: pct,
          _dif: dif,
        };
      }
    }
  }

  const ranking = Array.from(stats.entries()).map(([proveedor, s]) => ({ proveedor, promedio: s.suma / s.n, n: s.n, veces: s.veces, sobre: s.sobre }));
  const ordenar = (x, y) => y.promedio - x.promedio || y.veces - x.veces || y.n - x.n || x.proveedor.localeCompare(y.proveedor);
  const elegibles = ranking.filter((r) => r.n >= MIN_PRODUCTOS_PROVEEDOR).sort(ordenar);
  const otros = ranking.filter((r) => r.n < MIN_PRODUCTOS_PROVEEDOR).sort(ordenar);
  const top = (elegibles.length ? elegibles : otros)[0];
  const fila = (r) => ({
    proveedor: r.proveedor,
    promedio_pct: redondear1(r.promedio),
    productos_comparados: r.n,
    veces_mas_caro: r.veces,
    productos_sobre_umbral: r.sobre,
    pocos_productos: r.n < MIN_PRODUCTOS_PROVEEDOR,
  });

  let productoMasCaro = null;
  if (masCaro) {
    productoMasCaro = Object.assign({}, masCaro);
    delete productoMasCaro._pct;
    delete productoMasCaro._dif;
  }

  return {
    ciclo: { id: a.ciclo.id, etiqueta: etiquetaCiclo(a.ciclo.id) },
    resumen: { productos_comparables: a.comparables.length, proveedores: stats.size, minimo_productos_proveedor: MIN_PRODUCTOS_PROVEEDOR, umbral_pct: um },
    proveedor_mas_caro: top && top.promedio > 0 ? fila(top) : null,
    proveedores: elegibles.concat(otros).map(fila),
    producto_mas_caro: productoMasCaro,
  };
}

// Los productos de UN proveedor en los que está por encima del mejor precio, del más caro al menos.
function detalleProveedor(cicloId, proveedor, deps) {
  const a = analizar(cicloId, deps);
  if (!a) return null;
  const um = umbralPct();
  let comparados = 0;
  const filas = [];
  for (const p of a.comparables) {
    const mio = p.lista.find((e) => e[0] === proveedor);
    if (!mio) continue;
    comparados++;
    const precio = mio[1];
    if (precio > p.min) {
      const dif = precio - p.min;
      const pct = (dif / p.min) * 100;
      filas.push({
        codigo: p.codigo,
        producto: p.producto,
        presentacion: p.presentacion,
        precio,
        mejor_precio: p.min,
        mejor_proveedor: p.mejores[0],
        tambien_mejor: p.mejores.slice(1),
        diferencia: redondear2(dif),
        diferencia_pct: redondear1(pct),
        sobre_umbral: redondear1(pct) >= um,
        mas_caro_de_todos: precio === p.max,
        proveedores: p.lista.length,
        _pct: pct,
      });
    }
  }
  if (!comparados) return { sinDatos: true };
  filas.sort((x, y) => y._pct - x._pct || String(x.producto).localeCompare(String(y.producto)));
  filas.forEach((f) => delete f._pct);
  return {
    ciclo: { id: a.ciclo.id, etiqueta: etiquetaCiclo(a.ciclo.id) },
    proveedor,
    umbral_pct: um,
    resumen: {
      productos_comparados: comparados,
      por_encima_del_mejor: filas.length,
      sobre_umbral: filas.filter((f) => f.sobre_umbral).length,
      mas_caro_de_todos: filas.filter((f) => f.mas_caro_de_todos).length,
    },
    productos: filas,
  };
}

// ---------- Rutas ----------
module.exports = function registrarMasCaros(app, requireAdmin, deps) {
  if (!deps || typeof deps.getAllQuotes !== "function") {
    console.error("[mas_caros] NO se registró: el servidor no entregó getAllQuotes.");
    return;
  }
  const falta = esquemaFaltante();
  if (falta.length) {
    console.error("[mas_caros] NO se registró: faltan columnas esperadas: " + falta.join(", "));
    return;
  }

  const resolver = (req) => String(req.query.ciclo || "").trim() || cicloPorDefecto();

  app.get("/api/alertas/mas-caros", requireAdmin, (req, res) => {
    try {
      const ciclo = resolver(req);
      if (!ciclo) return res.status(404).json({ error: "Todavía no hay una semana de trabajo." });
      const datos = calcular(ciclo, deps);
      if (!datos) return res.status(404).json({ error: "Esa semana no existe." });
      res.json(datos);
    } catch (e) {
      console.error("[mas_caros] calcular:", e);
      res.status(500).json({ error: "No se pudo calcular quién es el más caro." });
    }
  });

  app.get("/api/alertas/mas-caros/proveedor", requireAdmin, (req, res) => {
    try {
      const proveedor = String(req.query.proveedor || "").trim();
      if (!proveedor) return res.status(400).json({ error: "Falta indicar el proveedor." });
      const ciclo = resolver(req);
      if (!ciclo) return res.status(404).json({ error: "Todavía no hay una semana de trabajo." });
      const datos = detalleProveedor(ciclo, proveedor, deps);
      if (!datos) return res.status(404).json({ error: "Esa semana no existe." });
      if (datos.sinDatos) return res.status(404).json({ error: "Ese proveedor no tiene productos comparables en esta semana." });
      res.json(datos);
    } catch (e) {
      console.error("[mas_caros] detalle:", e);
      res.status(500).json({ error: "No se pudieron calcular los productos de ese proveedor." });
    }
  });

  console.log("Los más caros de la semana listos (/api/alertas/mas-caros)");
};

module.exports.calcular = calcular;
module.exports.detalleProveedor = detalleProveedor;
