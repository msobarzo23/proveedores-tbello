// Lista de empresas de factoring (Google Sheet publicado como CSV).
// Si un RUT aparece aquí → es una empresa de factoring: las facturas ingresadas
// a su nombre son cesiones de crédito (la factura original de otro proveedor fue
// factorizada y solo quedó la del factoring). Mismo patrón que historico.js.
//
// PASO MANUAL (Miguel): crear una pestaña "Factoring" en el MISMO spreadsheet del
// histórico de crédito con columnas "RUT" y "Nombre", publicarla como CSV
// (Archivo → Compartir → Publicar en la web → esa hoja → formato CSV) y pegar
// abajo la URL ...pub?gid=XXXX&single=true&output=csv (el gid será DISTINTO al
// del histórico). Mientras esté vacía, la detección automática por folio+monto
// sigue funcionando igual.

import { normalizeRut } from "./historico";

const FACTORING_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT-21fUz3q3GNIZcdLubtFf7AgyekFwd-NXvZeWglZTop8JUqByP2x7Z8FPuPKSUSB3u_jhlsVjCLcu/pub?gid=0&single=true&output=csv";

// Parseo CSV simple: busca las columnas "RUT" (obligatoria) y "Nombre" (opcional)
// por nombre de header, no por posición.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().toUpperCase());
  const rutIdx = headers.findIndex(h => h === "RUT");
  const nomIdx = headers.findIndex(h => h === "NOMBRE");
  if (rutIdx === -1) return [];
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    return {
      rut: cols[rutIdx],
      nombre: nomIdx >= 0 ? String(cols[nomIdx] || "").trim() : "",
    };
  }).filter(r => r.rut);
}

export async function loadFactoring() {
  // Sin URL configurada: la detección automática por folio+monto sigue operando.
  if (!FACTORING_CSV_URL) {
    return { ok: false, set: new Set(), byRut: new Map(), count: 0, error: "URL no configurada" };
  }
  try {
    const res = await fetch(FACTORING_CSV_URL, { redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = parseCsv(await res.text());
    const set = new Set();
    const byRut = new Map();
    for (const { rut, nombre } of rows) {
      const n = normalizeRut(rut);
      if (!n) continue;
      set.add(n);
      if (nombre) byRut.set(n, nombre);
    }
    return { ok: true, set, byRut, count: set.size };
  } catch (e) {
    console.warn("Lista factoring no disponible:", e.message);
    return { ok: false, set: new Set(), byRut: new Map(), count: 0, error: e.message };
  }
}
