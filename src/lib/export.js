// Exportación de la pestaña "Sin registro" (facturas aceptadas en SII sin
// registro en Defontana) a Excel y PDF, para enviar a contabilidad.
//
// - Excel: usa la librería xlsx que ya está en el proyecto. Monto va como
//   número para que contabilidad pueda sumar/filtrar en la planilla.
// - PDF: se genera con la impresión del navegador (un iframe oculto con HTML
//   formateado → "Guardar como PDF"). Así no agregamos dependencias nuevas y
//   el archivo queda con el aspecto de un reporte para imprimir/enviar.

import * as XLSX from "xlsx";
import { fmtCLP, fmtRut, fmtDate } from "./ui";

const fuenteLabel = (f) =>
  f === "informe_compra" ? "Informe de Compra" : f === "referencia" ? "Referencia" : "—";

// Fecha de hoy como dd-MM-yyyy para el nombre de archivo.
function hoyParaArchivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Fecha y hora legible para el encabezado del reporte.
function ahoraLegible() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── Excel ──────────────────────────────────────────────────────────────
export function exportFantasmasExcel(rows) {
  const encabezados = [
    "Fecha emisión SII",
    "Documento",
    "Folio",
    "RUT",
    "Proveedor",
    "Monto",
    "Fuente",
    "Comentario",
    "Estado",
  ];

  const filas = rows.map((r) => [
    fmtDate(r.fechaFactura),
    r.tipoDoc || "",
    r.folio || "",
    fmtRut(r.rut),
    r.proveedor || "",
    Math.round(Number(r.cargoTotal) || 0), // número, no texto: contabilidad puede sumar
    fuenteLabel(r.fuenteFantasma),
    r.nota || "",
    r.estadoRev || "",
  ]);

  const totalMonto = rows.reduce((s, r) => s + (Math.round(Number(r.cargoTotal) || 0)), 0);
  const filaTotal = ["", "", "", "", "TOTAL", totalMonto, "", "", ""];

  const aoa = [encabezados, ...filas, [], filaTotal];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Anchos de columna para que se lea cómodo.
  ws["!cols"] = [
    { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 38 },
    { wch: 14 }, { wch: 18 }, { wch: 30 }, { wch: 12 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sin registro");
  XLSX.writeFile(wb, `sin-registro-defontana_${hoyParaArchivo()}.xlsx`);
}

// ─── PDF (vía impresión del navegador) ──────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function exportFantasmasPDF(rows) {
  const totalMonto = rows.reduce((s, r) => s + (Number(r.cargoTotal) || 0), 0);

  const filasHtml = rows
    .map(
      (r) => `
      <tr>
        <td>${esc(fmtDate(r.fechaFactura))}</td>
        <td>${esc(r.tipoDoc || "")}</td>
        <td class="mono">${esc(r.folio || "")}</td>
        <td class="mono">${esc(fmtRut(r.rut))}</td>
        <td>${esc(r.proveedor || "")}</td>
        <td class="num">${esc(fmtCLP(r.cargoTotal))}</td>
        <td>${esc(fuenteLabel(r.fuenteFantasma))}</td>
        <td>${esc(r.nota || "")}</td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Sin registro en Defontana</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { font-size: 11px; color: #64748b; margin-bottom: 2px; }
  .meta { font-size: 11px; color: #475569; margin: 10px 0 14px; }
  .meta strong { color: #b91c1c; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  thead th {
    background: #f1f5f9; text-align: left; padding: 6px 7px;
    border-bottom: 2px solid #cbd5e1; text-transform: uppercase;
    font-size: 9px; letter-spacing: 0.03em; color: #475569;
  }
  tbody td { padding: 5px 7px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  .mono { font-family: 'Consolas', monospace; }
  .num { text-align: right; font-family: 'Consolas', monospace; white-space: nowrap; }
  tfoot td { padding: 8px 7px; font-weight: 700; border-top: 2px solid #cbd5e1; }
  tfoot .num { color: #b91c1c; }
  .footer { margin-top: 16px; font-size: 9px; color: #94a3b8; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
  <h1>Facturas aceptadas en SII sin registro en Defontana</h1>
  <div class="sub">PROVEEDORES TBELLO · Auditoría de facturas · Transportes Bello</div>
  <div class="meta">
    Generado el ${esc(ahoraLegible())} ·
    <strong>${rows.length.toLocaleString("es-CL")}</strong> factura${rows.length === 1 ? "" : "s"} sin registro ·
    Monto total: <strong>${esc(fmtCLP(totalMonto))}</strong>
  </div>
  <table>
    <thead>
      <tr>
        <th>Fecha emisión SII</th>
        <th>Documento</th>
        <th>Folio</th>
        <th>RUT</th>
        <th>Proveedor</th>
        <th style="text-align:right">Monto</th>
        <th>Fuente</th>
        <th>Comentario</th>
      </tr>
    </thead>
    <tbody>
      ${filasHtml || `<tr><td colspan="8" style="text-align:center;padding:24px;color:#94a3b8">Sin facturas para exportar.</td></tr>`}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="5" style="text-align:right">TOTAL</td>
        <td class="num">${esc(fmtCLP(totalMonto))}</td>
        <td colspan="2"></td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">
    Facturas que aparecen en Facturación.cl (Informe de Compra o Referencia) pero no existen
    en el ledger Defontana cargado. Pueden ser facturas que faltó ingresar a contabilidad.
  </div>
</body>
</html>`;

  // Iframe oculto: imprime sin que el navegador bloquee pop-ups.
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  // Esperar a que el contenido se asiente antes de abrir el diálogo de impresión.
  const printAndCleanup = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 1000);
    }
  };
  setTimeout(printAndCleanup, 250);
}
