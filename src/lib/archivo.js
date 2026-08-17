// Archivo de facturas pagadas ya procesadas.
//
// Cuando una factura con saldo 0 (cargo = abono) ya fue marcada OK/REVISADA,
// mantenerla viva en la hoja Reviews y en el dataset Defontana solo engorda
// cada load_all y cada subida (miles de filas + snapshots JSON que viajan en
// todos los refresh). El archivado la saca de circulación sin destruir nada:
// la review completa queda en la hoja ReviewsArchivo del mismo Google Sheet.
//
// Reglas:
// - Solo se archivan facturas PAGADAS (|saldo| < 1). Si una archivada
//   reaparece en un Defontana futuro con saldo distinto de 0 (p.ej. se
//   reversó un pago), revive automáticamente: la exclusión exige pagada.
// - El match usa la key exacta (rut|folio|tipoDoc) con fallback a rut|folio,
//   el mismo criterio que applyReviewState usa para recuperar reviews cuando
//   el texto del tipoDoc varía entre exports de Defontana.

// Índice de keys archivadas para lookups O(1).
export function buildArchivedIndex(keys) {
  const exact = new Set();
  const rutFolio = new Set();
  for (const k of keys || []) {
    const ks = String(k || "");
    if (!ks) continue;
    exact.add(ks);
    if (ks.startsWith("FCL|")) continue;
    const p = ks.split("|");
    if (p.length >= 2 && p[0] && p[1]) rutFolio.add(`${p[0]}|${p[1]}`);
  }
  return { exact, rutFolio, size: exact.size };
}

// ¿Esta factura (agrupada por groupDefontanaByInvoice) está archivada y sigue
// saldada? Si volvió a tener saldo, NO se considera archivada (revive).
export function esFacturaArchivada(idx, inv) {
  if (!idx || !idx.size) return false;
  if (!inv.pagada) return false;
  if (idx.exact.has(inv.key)) return true;
  return !!(inv.rut && inv.folio && idx.rutFolio.has(`${inv.rut}|${inv.folio}`));
}

// Filtra del Defontana recién parseado las filas de facturas archivadas que
// siguen saldadas en el archivo nuevo. Se aplica ANTES de subir al Sheet:
// menos filas = menos lotes POST (menos rate-limit de Google), GET más
// liviano y menos presión sobre la cuota de localStorage.
export function filtrarDefontanaArchivadas(rows, idx) {
  if (!idx || !idx.size || !Array.isArray(rows) || !rows.length) {
    return { rows, filasExcluidas: 0, facturasExcluidas: 0 };
  }

  // Saldo por factura dentro del archivo nuevo (mismo agrupado que la app).
  const totales = new Map();
  for (const r of rows) {
    if (!r.folio) continue;
    const key = `${r.rut}|${r.folio}|${r.tipoDoc}`;
    const t = totales.get(key) || { cargo: 0, abono: 0 };
    t.cargo += r.cargo || 0;
    t.abono += r.abono || 0;
    totales.set(key, t);
  }

  const excluir = new Set();
  for (const [key, t] of totales) {
    if (Math.abs(t.abono - t.cargo) >= 1) continue; // volvió a tener saldo → se conserva
    const p = key.split("|");
    if (idx.exact.has(key) || idx.rutFolio.has(`${p[0]}|${p[1]}`)) excluir.add(key);
  }
  if (!excluir.size) return { rows, filasExcluidas: 0, facturasExcluidas: 0 };

  const out = rows.filter(r => !r.folio || !excluir.has(`${r.rut}|${r.folio}|${r.tipoDoc}`));
  return { rows: out, filasExcluidas: rows.length - out.length, facturasExcluidas: excluir.size };
}
