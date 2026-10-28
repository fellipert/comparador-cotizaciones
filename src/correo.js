"use strict";
// Envío de correos (recuperación de contraseña, avisos de subasta y de contrapropuestas).
// Se configura con variables de entorno; si no hay SMTP, el mensaje se escribe en el registro del servidor
// para que nada se bloquee mientras se configura el correo.
//
//   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (1 = TLS directo, puerto 465), SMTP_USER, SMTP_PASS,
//   SMTP_FROM ("Mercaldas Compras <compras@mercaldas.com.co>"), APP_URL (https://dominio-del-comparador)

let transporte = null;
let intentado = false;

function configurado() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function obtenerTransporte() {
  if (intentado) return transporte;
  intentado = true;
  try {
    const nodemailer = require("nodemailer");
    const puerto = Number(process.env.SMTP_PORT) || 587;
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: puerto,
      secure: process.env.SMTP_SECURE === "1" || puerto === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
    });
  } catch (e) {
    console.error("[correo] No se pudo preparar el envío (¿falta instalar nodemailer?):", e.message);
    transporte = null;
  }
  return transporte;
}

// Enlace absoluto a una página de la aplicación. Sin APP_URL no se arman enlaces: así un encabezado Host
// falso nunca termina dentro de un correo de recuperación.
function urlApp(ruta) {
  const base = String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
  return base ? base + ruta : null;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function html(titulo, parrafos, boton) {
  const cuerpo = parrafos.map((p) => '<p style="margin:0 0 12px;line-height:1.5">' + esc(p) + "</p>").join("");
  const btn = boton && boton.url
    ? '<p style="margin:20px 0"><a href="' + esc(boton.url) + '" style="background:#038A41;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">' + esc(boton.texto) + "</a></p>" +
      '<p style="margin:0 0 12px;font-size:12px;color:#56635A">Si el botón no funciona, copia este enlace en tu navegador:<br>' + esc(boton.url) + "</p>"
    : "";
  // Colores del logo de Mercaldas: verde #038A41 y franja amarilla #FCF103
  return '<div style="font-family:Arial,Helvetica,sans-serif;background:#F3F5F0;padding:24px">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #D9E0D5;border-radius:12px;overflow:hidden">' +
    '<div style="background:#038A41;color:#fff;padding:16px 22px;font-size:17px;font-weight:700;font-style:italic">Mercaldas · Compras Fruver</div>' +
    '<div style="background:#FCF103;height:6px;line-height:6px;font-size:0">&nbsp;</div>' +
    '<div style="padding:22px;color:#17251C;font-size:14px"><h2 style="margin:0 0 14px;font-size:18px;color:#02672F">' + esc(titulo) + "</h2>" + cuerpo + btn +
    '<p style="margin:18px 0 0;font-size:12px;color:#56635A">Este es un mensaje automático del comparador de cotizaciones de Mercaldas. No respondas a este correo.</p>' +
    "</div></div></div>";
}

function texto(titulo, parrafos, boton) {
  return [titulo, "", ...parrafos, boton && boton.url ? "\n" + boton.texto + ": " + boton.url : ""].join("\n").trim();
}

// Nunca lanza error: devuelve { ok, motivo }. Quien lo llama no debe esperar a que el correo salga.
async function enviar({ para, asunto, titulo, parrafos = [], boton = null }) {
  const destinatarios = (Array.isArray(para) ? para : [para]).map((x) => String(x || "").trim()).filter(Boolean);
  if (!destinatarios.length) return { ok: false, motivo: "sin_destinatario" };
  const t = configurado() ? obtenerTransporte() : null;
  if (!t) {
    console.log("=".repeat(60));
    console.log("[correo] SMTP sin configurar. Este correo NO se envió:");
    console.log("  Para:   " + destinatarios.join(", "));
    console.log("  Asunto: " + asunto);
    console.log(texto(titulo || asunto, parrafos, boton));
    console.log("=".repeat(60));
    return { ok: false, motivo: "sin_smtp" };
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM,
      to: destinatarios.join(", "),
      subject: asunto,
      text: texto(titulo || asunto, parrafos, boton),
      html: html(titulo || asunto, parrafos, boton),
    });
    return { ok: true };
  } catch (e) {
    console.error("[correo] Error enviando a " + destinatarios.join(", ") + ": " + e.message);
    return { ok: false, motivo: "error" };
  }
}

module.exports = { enviar, configurado, urlApp };
