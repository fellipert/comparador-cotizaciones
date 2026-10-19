// PDF de la orden de compra con el diseño del OC-1068 (encabezado azul, tabla con cebra, totales).
const PDFDocument = require("pdfkit");
const fs = require("fs");

const AZUL = "#1F4E79";
const GRIS_FILA = "#F2F2F2";
const GRIS_TXT = "#555555";

function pesos(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (v < 0 ? "-$" : "$") + s;
}
function cantidad(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(".", ",");
}
function fechaHora(iso) {
  const d = iso ? new Date(iso) : new Date();
  const z = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${z.day}/${z.month}/${z.year} ${z.hour}:${z.minute}`;
}

// orden: { numero, proveedor, nit, creado_en, solicitado_por, otros, otro_rubro }
// items: [{ codigo, descripcion, cantidad, unidad, precio, iva }]  (iva en %, ej. 0 o 19)
function generarPdfOrdenCompra(orden, items, logoPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 0, info: { Title: orden.numero, Author: "Mercaldas" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width, H = doc.page.height, M = 34;
    const generado = fechaHora();

    function encabezado() {
      doc.rect(0, 0, W, 68).fill(AZUL);
      let conLogo = false;
      if (logoPath && fs.existsSync(logoPath)) {
        try {
          doc.roundedRect(M, 12, 44, 44, 6).fill("#FFFFFF");
          doc.image(logoPath, M + 3, 15, { fit: [38, 38], align: "center", valign: "center" });
          conLogo = true;
        } catch (e) { conLogo = false; }
      }
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(conLogo ? 15 : 17).text("MERCALDAS", conLogo ? M + 54 : M, conLogo ? 26 : 24, { lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(14).text("ORDEN DE COMPRA", 0, 17, { width: W - M, align: "right", lineBreak: false });
      doc.fontSize(11).text(orden.numero, 0, 39, { width: W - M, align: "right", lineBreak: false });
    }

    function datos() {
      const y = 86;
      doc.fillColor("#222222").fontSize(9);
      const fila = (x, yy, etq, val, ancho) => {
        doc.font("Helvetica-Bold").text(etq, x, yy, { width: 90, lineBreak: false });
        doc.font("Helvetica").text(String(val == null || val === "" ? "—" : val), x + 95, yy, { width: ancho, lineBreak: false, ellipsis: true });
      };
      fila(M, y, "Proveedor:", orden.proveedor, 230);
      fila(M, y + 17, "NIT:", orden.nit, 230);
      fila(W / 2 + 10, y, "Fecha y hora:", fechaHora(orden.creado_en), 130);
      fila(W / 2 + 10, y + 17, "Solicitado por:", orden.solicitado_por, 130);
    }

    const cols = [
      { t: "PLU", w: 46, a: "left" }, { t: "Descripción", w: 172, a: "left" }, { t: "Cantidad", w: 46, a: "right" },
      { t: "Unidad", w: 48, a: "left" }, { t: "Costo unidad", w: 62, a: "right" }, { t: "Costo total", w: 62, a: "right" },
      { t: "% IVA", w: 36, a: "right" }, { t: "Valor total PLU", w: 76, a: "right" },
    ];
    const tablaAncho = cols.reduce((s, c) => s + c.w, 0);
    const X0 = (W - tablaAncho) / 2;

    function cabeceraTabla(y) {
      doc.rect(X0, y, tablaAncho, 20).fill(AZUL);
      let x = X0;
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
      cols.forEach((c) => { doc.text(c.t, x + 5, y + 6, { width: c.w - 10, align: c.a, lineBreak: false }); x += c.w; });
      return y + 20;
    }

    function pie() {
      doc.fillColor(GRIS_TXT).font("Helvetica-Bold").fontSize(7).text(`Documento generado el ${generado}`, M, H - 40, { lineBreak: false });
    }

    encabezado(); datos();
    let y = cabeceraTabla(128);
    const ROW = 19, LIMITE = H - 190;
    let subtotal = 0;
    items.forEach((it, i) => {
      if (y + ROW > LIMITE) { pie(); doc.addPage(); encabezado(); y = cabeceraTabla(86); }
      const costoTotal = (Number(it.cantidad) || 0) * (Number(it.precio) || 0);
      const iva = Number(it.iva) || 0;
      const valorPlu = costoTotal * (1 + iva / 100);
      subtotal += valorPlu;
      if (i % 2 === 0) doc.rect(X0, y, tablaAncho, ROW).fill(GRIS_FILA);
      const celdas = [String(it.codigo), String(it.descripcion), cantidad(it.cantidad), String(it.unidad || ""), pesos(it.precio), pesos(costoTotal), iva + "%", pesos(valorPlu)];
      let x = X0;
      doc.fillColor("#333333").font("Helvetica").fontSize(8);
      celdas.forEach((v, k) => { doc.text(v, x + 5, y + 6, { width: cols[k].w - 10, align: cols[k].a, height: 10, ellipsis: true }); x += cols[k].w; });
      y += ROW;
    });

    // totales (si no caben, pasan a otra página)
    if (y + 110 > H - 50) { pie(); doc.addPage(); encabezado(); y = 90; }
    const otros = Number(orden.otros) || 0, otroRubro = Number(orden.otro_rubro) || 0;
    const totalProv = subtotal + otros, totalGen = totalProv + otroRubro;
    const xe = X0 + tablaAncho - 200, xv = X0 + tablaAncho - 80;
    let ty = y + 10;
    const linea = (etq, val, grande) => {
      doc.fillColor("#222222").font(grande ? "Helvetica-Bold" : "Helvetica").fontSize(grande ? 11 : 9);
      doc.text(etq, xe, ty, { width: 112, align: "right", lineBreak: false });
      doc.text(pesos(val), xv, ty, { width: 75, align: "right", lineBreak: false });
      ty += grande ? 20 : 16;
    };
    linea("Subtotal", subtotal); linea("Otros", otros); linea("Total proveedor", totalProv); linea("Otro rubro", otroRubro); linea("Total general", totalGen, true);
    pie();
    doc.end();
  });
}

module.exports = { generarPdfOrdenCompra, pesos };
