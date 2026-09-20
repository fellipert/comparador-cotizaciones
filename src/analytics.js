function computeComparativo(quotes, contrapropuestaPct) {
  const pct = typeof contrapropuestaPct === "number" ? contrapropuestaPct : 2;
  const factor = 1 - pct / 100;
  const byCodigo = {};
  quotes.forEach((q) => {
    if (!byCodigo[q.codigo]) byCodigo[q.codigo] = [];
    byCodigo[q.codigo].push(q);
  });

  const rows = Object.keys(byCodigo).map((codigo) => {
    const list = byCodigo[codigo].slice().sort((a, b) => a.precio - b.precio);
    const min = list[0];
    const second = list.length > 1 ? list[1] : null;
    const max = list[list.length - 1];
    const contrapropuesta = min.precio * factor;
    const redondeada = Math.floor(contrapropuesta / 100) * 100;
    const diffPct = min.precio > 0 ? (max.precio - min.precio) / min.precio : 0;
    return {
      codigo,
      producto: min.producto,
      presentacion: min.presentacion,
      nProveedores: list.length,
      precioMin: min.precio,
      proveedorMin: min.proveedor,
      precioSegundo: second ? second.precio : null,
      proveedorSegundo: second ? second.proveedor : null,
      precioMax: max.precio,
      diffPct,
      contrapropuesta,
      redondeada,
      vigencia: min.vigencia_fin,
      _quotes: list,
    };
  });
  rows.sort((a, b) => a.producto.localeCompare(b.producto));
  return rows;
}

const DIFF_IMPORTANTE_UMBRAL = 0.15;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function parseFecha(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function computeAlertas(comparativo) {
  const hoy = todayISO();
  const diferenciasImportantes = comparativo
    .filter((r) => r.diffPct > DIFF_IMPORTANTE_UMBRAL)
    .map((r) => ({
      codigo: r.codigo,
      producto: r.producto,
      precioMin: r.precioMin,
      proveedorMin: r.proveedorMin,
      precioMax: r.precioMax,
      diffPct: r.diffPct,
    }));

  const vigenciasPorVencer = [];
  comparativo.forEach((r) => {
    const fecha = parseFecha(r.vigencia);
    if (!fecha) return;
    if (fecha <= hoy) {
      vigenciasPorVencer.push({
        codigo: r.codigo,
        producto: r.producto,
        proveedor: r.proveedorMin,
        vigencia: fecha,
        estado: fecha < hoy ? "vencida" : "vence_hoy",
      });
    }
  });

  return { diferenciasImportantes, vigenciasPorVencer, umbralDiferencia: DIFF_IMPORTANTE_UMBRAL };
}

function computeDashboard(quotes, comparativo) {
  const totalProductos = comparativo.length;
  const conVarios = comparativo.filter((r) => r.nProveedores > 1).length;
  const ahorroPotencial = comparativo.reduce((s, r) => s + (r.precioMax - r.precioMin), 0);
  const ahorroContrapropuesta = comparativo.reduce((s, r) => s + (r.precioMin - r.redondeada), 0);

  const porProveedor = {};
  quotes.forEach((q) => {
    if (!porProveedor[q.proveedor]) porProveedor[q.proveedor] = { precios: [], diffs: [], victorias: 0 };
    porProveedor[q.proveedor].precios.push(q.precio);
  });
  comparativo.forEach((r) => {
    r._quotes.forEach((q) => {
      const diff = (q.precio - r.precioMin) / r.precioMin;
      porProveedor[q.proveedor].diffs.push(diff);
      if (q.precio === r.precioMin) porProveedor[q.proveedor].victorias++;
    });
  });
  const proveedores = Object.keys(porProveedor).map((p) => {
    const d = porProveedor[p];
    const avgPrecio = d.precios.reduce((s, v) => s + v, 0) / d.precios.length;
    const avgDiff = d.diffs.reduce((s, v) => s + v, 0) / d.diffs.length;
    return { proveedor: p, avgPrecio, avgDiff, victorias: d.victorias };
  });

  return { totalProductos, conVarios, ahorroPotencial, ahorroContrapropuesta, proveedores };
}

function computeAgrupamiento(quotes, umbralPct) {
  const umbral = typeof umbralPct === "number" ? umbralPct : 10;

  const portafolios = {};
  const nombreProducto = {};
  const precioPorProveedor = {};
  quotes.forEach((q) => {
    if (!portafolios[q.proveedor]) portafolios[q.proveedor] = new Set();
    portafolios[q.proveedor].add(q.codigo);
    if (!nombreProducto[q.codigo] && q.producto) nombreProducto[q.codigo] = q.producto;
    if (!precioPorProveedor[q.proveedor]) precioPorProveedor[q.proveedor] = {};
    const actual = precioPorProveedor[q.proveedor][q.codigo];
    if (actual === undefined || q.precio < actual) precioPorProveedor[q.proveedor][q.codigo] = q.precio;
  });
  const proveedores = Object.keys(portafolios);

  const pares = [];
  for (let i = 0; i < proveedores.length; i++) {
    for (let j = i + 1; j < proveedores.length; j++) {
      const a = proveedores[i], b = proveedores[j];
      const setA = portafolios[a], setB = portafolios[b];
      let comunes = 0;
      setA.forEach((cod) => { if (setB.has(cod)) comunes++; });
      const pctA = setA.size > 0 ? (comunes / setA.size) * 100 : 0;
      const pctB = setB.size > 0 ? (comunes / setB.size) * 100 : 0;
      pares.push({
        proveedorA: a, proveedorB: b, comunes,
        totalA: setA.size, totalB: setB.size,
        pctA, pctB, conectados: Math.max(pctA, pctB) >= umbral,
        codigosComunes: Array.from(setA).filter((cod) => setB.has(cod)).map((cod) => ({
          codigo: cod, producto: nombreProducto[cod] || cod,
          precioA: precioPorProveedor[a][cod], precioB: precioPorProveedor[b][cod],
        })),
      });
    }
  }

  const parent = {};
  proveedores.forEach((p) => { parent[p] = p; });
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(x, y) { const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; }
  pares.filter((p) => p.conectados).forEach((p) => union(p.proveedorA, p.proveedorB));

  const gruposMap = {};
  proveedores.forEach((p) => {
    const raiz = find(p);
    if (!gruposMap[raiz]) gruposMap[raiz] = [];
    gruposMap[raiz].push(p);
  });
  const grupos = Object.values(gruposMap)
    .map((miembros) => ({ miembros: miembros.sort(), tamano: miembros.length }))
    .sort((a, b) => b.tamano - a.tamano);

  pares.sort((a, b) => Math.max(b.pctA, b.pctB) - Math.max(a.pctA, a.pctB));

  return { umbral, proveedores, pares, grupos };
}

function computeVistaProveedor(quotes, proveedor, contrapropuestaPct) {
  const comparativoGlobal = computeComparativo(quotes, contrapropuestaPct);
  const porCodigo = {};
  comparativoGlobal.forEach((r) => { porCodigo[r.codigo] = r; });

  const misCotizaciones = {};
  quotes
    .filter((q) => q.proveedor === proveedor)
    .forEach((q) => {
      const actual = misCotizaciones[q.codigo];
      if (!actual || q.precio < actual.precio) misCotizaciones[q.codigo] = q;
    });

  const items = Object.keys(misCotizaciones).map((codigo) => {
    const mia = misCotizaciones[codigo];
    const global = porCodigo[codigo];
    return {
      codigo,
      producto: mia.producto,
      presentacion: mia.presentacion,
      precioProveedor: mia.precio,
      precioMinimo: global.precioMin,
      proveedorMinimo: global.proveedorMin,
      esElMinimo: global.proveedorMin === proveedor,
      esUnico: global.nProveedores === 1,
      nProveedores: global.nProveedores,
      contrapropuesta: global.contrapropuesta,
      redondeada: global.redondeada,
    };
  });
  items.sort((a, b) => a.producto.localeCompare(b.producto));
  return items;
}

module.exports = { computeComparativo, computeDashboard, computeAlertas, computeAgrupamiento, computeVistaProveedor };

