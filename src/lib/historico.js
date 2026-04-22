// Histórico de proveedores pagados al crédito (Google Sheet publicado CSV).
// Si un RUT aparece aquí → históricamente se le paga al crédito → señal de
// que una factura 2CONTADO para ese RUT probablemente debería ser 1NOMINA.

const HISTORICO_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT1ILHR8Hehw4FiGRKgTm__paCyusHvn5LcHlOeFtZAxENpO8GKr2MzV6s1iX7R8e1KbTJqYOCWIMTU/pub?gid=1453444709&single=true&output=csv";

// Normaliza RUT: quita puntos, guiones, espacios y pasa a mayúsculas.
// "99.520.000-7" → "995200007"
export const normalizeRut = (r) =>
  String(r || "").replace(/[.\-\s]/g, "").toUpperCase();

// Parseo CSV simple (el sheet publicado no tiene comas dentro de campos).
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  const rutIdx = headers.findIndex(h => h.toUpperCase() === "RUT");
  if (rutIdx === -1) return [];
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    return cols[rutIdx];
  }).filter(Boolean);
}

export async function loadHistoricoCredito() {
  try {
    const res = await fetch(HISTORICO_CSV_URL, { redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const ruts = parseCsv(text);
    const set = new Set(ruts.map(normalizeRut));
    return { ok: true, set, count: set.size };
  } catch (e) {
    console.warn("Histórico crédito no disponible:", e.message);
    return { ok: false, set: new Set(), count: 0, error: e.message };
  }
}
