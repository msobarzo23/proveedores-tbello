/**
 * Proveedores TBELLO — Google Apps Script backend
 *
 * Cómo usar:
 *   1. Crear un Google Sheet nuevo (o usar uno existente). Guardar su ID.
 *   2. Extensiones → Apps Script. Pegar este código completo.
 *   3. Ejecutar `setup` una vez (crea las hojas: Defontana, OC, FactCL, Compra, Reviews).
 *   4. Implementar → Nueva implementación → tipo: App web
 *      - Ejecutar como: yo mismo
 *      - Quién tiene acceso: cualquiera (o "cualquiera con enlace")
 *   5. Copiar la URL /exec y pegarla en el panel ⚙️ de la app.
 */

// Versión del backend. El cliente la compara con la que espera y muestra un
// aviso si el Web App desplegado está desactualizado. Subirla en cada cambio.
const GAS_VERSION = 5;

const SHEETS = {
  DEFONTANA: "Defontana",
  OC: "OC",
  FACTCL: "FactCL",
  COMPRA: "Compra",
  REVIEWS: "Reviews",
  REVIEWS_ARCHIVE: "ReviewsArchivo",
  META: "Meta",
};

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.values(SHEETS).forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  // Headers Reviews. Si la hoja existe y le falta la columna 'snapshot',
  // se la agregamos en la fila 1 para sheets ya creadas con la versión vieja.
  const rev = ss.getSheetByName(SHEETS.REVIEWS);
  const expected = ["key", "estado", "nota", "updated_at", "snapshot"];
  if (rev.getLastRow() === 0) {
    rev.getRange(1, 1, 1, expected.length).setValues([expected]);
  } else {
    const lastCol = Math.max(rev.getLastColumn(), 1);
    const current = rev.getRange(1, 1, 1, lastCol).getValues()[0];
    if (current.length < expected.length) {
      rev.getRange(1, 1, 1, expected.length).setValues([expected]);
    }
  }
  const arch = ss.getSheetByName(SHEETS.REVIEWS_ARCHIVE);
  if (arch.getLastRow() === 0) {
    arch.getRange(1, 1, 1, 6).setValues([["key", "estado", "nota", "updated_at", "snapshot", "archived_at"]]);
  }
  ensureTextUpdatedAt_(rev);
}

function doGet(e) {
  const action = e?.parameter?.action || "load_all";
  try {
    if (action === "load_all") return jsonOut(loadAll_());
    return jsonOut({ ok: false, error: "Acción desconocida: " + action });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "save_dataset")        return jsonOut(saveDataset_(body));
    if (action === "save_review")         return jsonOut(saveReview_(body));
    if (action === "save_reviews_batch")  return jsonOut(saveReviewsBatch_(body));
    if (action === "archive_reviews")     return jsonOut(archiveReviews_(body));
    return jsonOut({ ok: false, error: "Acción desconocida: " + action });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function loadAll_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Formatear Date objects como "dd/MM/yyyy" para mantener el formato
  // original de Defontana/OC/Fact.cl (Sheets los auto-convierte al guardar).
  const fmtDate = (d) => {
    if (!(d instanceof Date)) return d;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  };

  const readSheet = (name) => {
    const sh = ss.getSheetByName(name);
    if (!sh) return [];
    const values = sh.getDataRange().getValues();
    if (values.length < 2) return [];
    const headers = values[0];
    return values.slice(1).map(row => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = row[i] instanceof Date ? fmtDate(row[i]) : row[i];
      });
      return o;
    });
  };

  const defontana = readSheet(SHEETS.DEFONTANA);
  const oc        = readSheet(SHEETS.OC);
  const factcl    = readSheet(SHEETS.FACTCL);
  const compra    = readSheet(SHEETS.COMPRA);

  // Reviews → objeto keyed por key. Lee también columna 'snapshot' si existe
  // (JSON con proveedor/vencimiento/montos para reconstruir la fila cuando la
  // factura ya no aparece en el Defontana actual).
  const revSheet = ss.getSheetByName(SHEETS.REVIEWS);
  const reviews = {};
  if (revSheet && revSheet.getLastRow() > 1) {
    const values = revSheet.getDataRange().getValues().slice(1);
    values.forEach(row => {
      const [key, estado, nota, updated_at, snapshotRaw] = row;
      if (!key) return;
      const rev = { estado, nota, updated_at };
      if (snapshotRaw) {
        try { rev.snapshot = JSON.parse(snapshotRaw); } catch (e) { /* snapshot corrupto, ignorar */ }
      }
      reviews[key] = rev;
    });
  }

  // Keys de reviews archivadas (facturas pagadas ya procesadas, movidas a la
  // hoja ReviewsArchivo). Solo la columna key: el detalle (nota, snapshot) se
  // queda en el Sheet y NO viaja en cada load_all — ese peso era justamente lo
  // que hacía lenta la app. El cliente usa estas keys para excluir esas
  // facturas del listado y para no re-subirlas desde copias locales viejas.
  const archSheet = ss.getSheetByName(SHEETS.REVIEWS_ARCHIVE);
  let archivedKeys = [];
  if (archSheet && archSheet.getLastRow() > 1) {
    archivedKeys = archSheet.getRange(2, 1, archSheet.getLastRow() - 1, 1).getValues()
      .map(function (r) { return String(r[0] || ""); })
      .filter(String);
  }

  return { ok: true, gasVersion: GAS_VERSION, defontana, oc, factcl, compra, reviews, archivedKeys, meta: readMeta_(ss) };
}

// ─── Archivo de reviews ───────────────────────────────────────────
// Mueve reviews de la hoja Reviews a ReviewsArchivo (mismas columnas +
// archived_at). Se usa para las facturas pagadas (saldo 0) ya procesadas:
// dejan de viajar en load_all y de aparecer en la app, pero el trabajo de
// revisión (estado, comentario, snapshot) queda guardado en el Sheet.
// Idempotente: una key que ya no está en Reviews simplemente se salta, así
// un reintento tras un rate-limit no duplica filas en el archivo.
function archiveReviews_({ keys }) {
  if (!Array.isArray(keys) || !keys.length) return { ok: true, archived: 0, missing: 0 };

  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); }
  catch (e) { throw new Error("Lock timeout al archivar: " + e.message); }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEETS.REVIEWS);
    if (!sh || sh.getLastRow() < 2) return { ok: true, archived: 0, missing: keys.length };
    ensureTextUpdatedAt_(sh);

    let arch = ss.getSheetByName(SHEETS.REVIEWS_ARCHIVE);
    if (!arch) {
      arch = ss.insertSheet(SHEETS.REVIEWS_ARCHIVE);
      arch.getRange(1, 1, 1, 6).setValues([["key", "estado", "nota", "updated_at", "snapshot", "archived_at"]]);
    }

    const wanted = {};
    keys.forEach(function (k) { if (k) wanted[String(k)] = true; });

    // Keys que ya están en el archivo: si vuelven a llegar (p.ej. una review
    // "resucitada" en Reviews por un cliente con copia vieja), se quitan de
    // Reviews pero NO se re-appendean — el archivo no acumula duplicados.
    const yaArchivadas = {};
    if (arch.getLastRow() > 1) {
      arch.getRange(2, 1, arch.getLastRow() - 1, 1).getValues()
        .forEach(function (r) { if (r[0]) yaArchivadas[String(r[0])] = true; });
    }

    const data = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    const keep = [];
    const move = [];
    let dropped = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < data.length; i++) {
      const k = String(data[i][0] || "");
      if (k && wanted[k]) {
        if (yaArchivadas[k]) { dropped++; continue; }
        move.push([data[i][0], data[i][1], data[i][2], data[i][3], data[i][4], now]);
        yaArchivadas[k] = true; // por si la key viene duplicada en Reviews
      } else {
        keep.push(data[i]);
      }
    }

    if (move.length || dropped) {
      if (move.length) {
        arch.getRange(arch.getLastRow() + 1, 1, move.length, 6).setValues(move);
      }
      // Reescribir Reviews sin las archivadas (limpiar el rango viejo completo
      // para no dejar filas fantasma al final).
      sh.getRange(2, 1, data.length, 5).clearContent();
      if (keep.length) sh.getRange(2, 1, keep.length, 5).setValues(keep);
    }

    return { ok: true, archived: move.length, dropped: dropped, missing: Math.max(0, keys.length - move.length - dropped) };
  } finally {
    lock.releaseLock();
  }
}

// ─── Meta: total esperado por dataset ─────────────────────────────
// Se anota al PRIMER lote de cada carga (el cliente manda totalRows). Si la
// carga muere a medias, el Sheet queda con menos filas que el total esperado
// y cualquier cliente puede detectarlo y avisar, en vez de mostrar datos
// truncados como si estuvieran completos.
function writeMeta_(ss, dataset, count) {
  let sh = ss.getSheetByName(SHEETS.META);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.META);
    sh.getRange(1, 1, 1, 3).setValues([["dataset", "count", "updated_at"]]);
  }
  const now = new Date().toISOString();
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const keys = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i][0] === dataset) {
        sh.getRange(i + 2, 1, 1, 3).setValues([[dataset, count, now]]);
        return;
      }
    }
  }
  sh.getRange(lastRow + 1, 1, 1, 3).setValues([[dataset, count, now]]);
}

function readMeta_(ss) {
  const sh = ss.getSheetByName(SHEETS.META);
  if (!sh || sh.getLastRow() < 2) return {};
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  const out = {};
  for (let i = 0; i < vals.length; i++) {
    const d = vals[i][0];
    if (d) out[d] = { count: Number(vals[i][1]) || 0, updated_at: String(vals[i][2] || "") };
  }
  return out;
}

function saveDataset_({ dataset, rows, clear, isLast, batchStart, totalRows }) {
  const name = {
    defontana: SHEETS.DEFONTANA,
    oc:        SHEETS.OC,
    factcl:    SHEETS.FACTCL,
    compra:    SHEETS.COMPRA,
  }[dataset];
  if (!name) throw new Error("Dataset inválido: " + dataset);

  // Lock: sin él, dos personas subiendo a la vez (o un reintento cruzado con
  // una carga en curso) intercalaban lotes de datasets distintos y el Sheet
  // quedaba con una mezcla corrupta. También serializa contra las escrituras
  // de reviews.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error("Lock timeout (otra carga en curso): " + e.message); }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);

    if (clear) {
      sh.clear();
      // Anotar el total esperado ANTES de escribir datos: si la carga muere a
      // medias, el desbalance filas-reales vs esperadas queda detectable.
      // Clientes antiguos no mandan totalRows → 0 = "sin información".
      writeMeta_(ss, dataset, (typeof totalRows === "number" && totalRows > 0) ? totalRows : 0);
    }

    if (!rows || !rows.length) return { ok: true, count: 0 };

    // Si es la primera carga, escribir headers a partir de las claves del primer objeto.
    const headers = Object.keys(rows[0]);
    if (clear) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }

    // Escritura idempotente: si el cliente envía batchStart (índice de la
    // primera fila del lote dentro del dataset), la fila destino es
    // determinista (headers en fila 1 → datos desde fila 2). Un lote repetido
    // —porque Google aplicó el POST pero respondió con HTML de rate-limit y el
    // cliente reintentó— sobreescribe su propio rango en vez de appendearse al
    // final (eso triplicó facturas en jul-2026). Clientes antiguos no envían
    // batchStart y conservan el append.
    const startRow = (typeof batchStart === "number" && batchStart >= 0)
      ? batchStart + 2
      : sh.getLastRow() + 1;
    const values = rows.map(o => headers.map(h => o[h] ?? ""));
    sh.getRange(startRow, 1, values.length, headers.length).setValues(values);

    return { ok: true, count: rows.length, isLast: !!isLast };
  } finally {
    lock.releaseLock();
  }
}

// La columna updated_at (D) de Reviews debe ser TEXTO PLANO: si Sheets la
// interpreta como fecha, el round-trip pierde los milisegundos del ISO y la
// review vuelve "distinta" a la copia local → el cliente la acusa como
// pendiente de sincronizar para siempre. Formatear la columna como "@" hace
// que los strings entren y salgan byte a byte idénticos.
function ensureTextUpdatedAt_(sh) {
  sh.getRange(1, 4, sh.getMaxRows(), 1).setNumberFormat("@");
}

function saveReview_({ key, estado, nota, snapshot, updated_at }) {
  if (!key) throw new Error("key requerido");

  // Lock para serializar con saveReviewsBatch_ y con otras instancias de
  // saveReview_. 30s de espera es más que suficiente para el batch típico.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error("Lock timeout (otra escritura en curso): " + e.message); }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(SHEETS.REVIEWS);
    if (!sh) {
      sh = ss.insertSheet(SHEETS.REVIEWS);
      sh.getRange(1, 1, 1, 5).setValues([["key", "estado", "nota", "updated_at", "snapshot"]]);
    }
    ensureTextUpdatedAt_(sh);

    // Conservar el updated_at que manda el cliente (es su número de versión
    // lógico): si el server estampara su propio reloj, un navegador con la
    // hora adelantada vería su copia local "más nueva" que la del Sheet
    // eternamente. Fallback al reloj del server para clientes antiguos.
    const upd = updated_at ? String(updated_at) : new Date().toISOString();
    const snapStr = snapshot ? JSON.stringify(snapshot) : "";
    const rowValues = [key, estado, nota || "", upd, snapStr];

    const lastRow = sh.getLastRow();
    if (lastRow > 1) {
      const keys = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < keys.length; i++) {
        if (keys[i][0] === key) {
          // Si no llega snapshot nuevo, preservar el que ya hay en la hoja.
          if (!snapshot) {
            const prev = sh.getRange(i + 2, 5).getValue();
            if (prev) rowValues[4] = prev;
          }
          sh.getRange(i + 2, 1, 1, 5).setValues([rowValues]);
          return { ok: true, updated: true };
        }
      }
    }
    sh.getRange(lastRow + 1, 1, 1, 5).setValues([rowValues]);
    return { ok: true, inserted: true };
  } finally {
    lock.releaseLock();
  }
}

// Upsert masivo: recibe un array de reviews y los aplica en una sola
// ejecución, leyendo el Sheet una sola vez. Decenas de veces más rápido que
// llamar a saveReview_ una vez por revisión cuando hay muchas pendientes.
function saveReviewsBatch_({ reviews }) {
  if (!Array.isArray(reviews) || !reviews.length) return { ok: true, updated: 0, inserted: 0 };

  // 60s de espera: el batch normal toma 3-10s pero damos margen por si otro
  // batch ya está corriendo en paralelo.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); }
  catch (e) { throw new Error("Lock timeout en batch: " + e.message); }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(SHEETS.REVIEWS);
    if (!sh) {
      sh = ss.insertSheet(SHEETS.REVIEWS);
      sh.getRange(1, 1, 1, 5).setValues([["key", "estado", "nota", "updated_at", "snapshot"]]);
    }
    ensureTextUpdatedAt_(sh);

    // Una sola lectura: key + snapshot existente (para preservarlo cuando el
    // cliente no manda snapshot nuevo).
    const lastRow = sh.getLastRow();
    const keyToRow = {};
    const existingSnapByKey = {};
    if (lastRow > 1) {
      const data = sh.getRange(2, 1, lastRow - 1, 5).getValues();
      for (let i = 0; i < data.length; i++) {
        const k = data[i][0];
        if (!k) continue;
        keyToRow[k] = i + 2;
        if (data[i][4]) existingSnapByKey[k] = data[i][4];
      }
    }

    const now = new Date().toISOString();
    const toUpdate = []; // { rowIndex, values }
    const toAppend = []; // values
    let updated = 0;
    let inserted = 0;

    for (const rev of reviews) {
      if (!rev || !rev.key) continue;
      let snapStr = rev.snapshot ? JSON.stringify(rev.snapshot) : "";
      // Conservar el updated_at del cliente (ver saveReview_); fallback al
      // reloj del server para clientes antiguos que no lo mandan.
      const upd = rev.updated_at ? String(rev.updated_at) : now;
      const existingRow = keyToRow[rev.key];
      if (existingRow) {
        if (!rev.snapshot && existingSnapByKey[rev.key]) snapStr = existingSnapByKey[rev.key];
        toUpdate.push({
          rowIndex: existingRow,
          values: [rev.key, rev.estado, rev.nota || "", upd, snapStr],
        });
        updated++;
      } else {
        toAppend.push([rev.key, rev.estado, rev.nota || "", upd, snapStr]);
        inserted++;
      }
    }

    // Updates: dispersos por rowIndex, hay que hacer setValues por cada uno.
    // Es rápido dentro de una sola ejecución del script (no son round-trips).
    for (const u of toUpdate) {
      sh.getRange(u.rowIndex, 1, 1, 5).setValues([u.values]);
    }

    // Inserts: una sola escritura masiva al final.
    if (toAppend.length) {
      sh.getRange(lastRow + 1, 1, toAppend.length, 5).setValues(toAppend);
    }

    return { ok: true, updated, inserted };
  } finally {
    lock.releaseLock();
  }
}
