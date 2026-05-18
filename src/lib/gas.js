// Cliente del Google Apps Script. Si no hay URL configurada, persiste en localStorage.

// URL por defecto del Web App. Si el usuario guarda otra en ⚙️ en su
// navegador, esa toma precedencia (permite cambiar de hoja sin redeployar).
export const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbyAe6b-Flbg5vpHoM27696ZPCqRJpB-DGHrJWPzurEQD2NZalWCN7hC_rGOmry7k32Y/exec";

const LS_KEYS = {
  URL: "gas_url",
  URL_VERSION: "gas_url_version",
  DEFONTANA: "data_defontana",
  OC: "data_oc",
  FACTCL: "data_factcl",
  COMPRA: "data_compra",
  REVIEWS: "data_reviews",
  REVIEWS_PENDING: "data_reviews_pending", // keys con cambios locales aún no confirmados por GAS
  TIMESTAMPS: "data_timestamps",
  PENDING_DATASETS: "data_pending_datasets", // datasets que fallaron al guardar en GAS y deben reintentarse
};

// Bump cuando la URL por defecto cambie o haya que forzar limpieza de URLs viejas.
const URL_VERSION = "2";

// Tamaño de batch para POSTs a GAS. 250 da buen balance entre velocidad y
// confiabilidad: payloads chicos llegan completos aun en redes inestables.
const BATCH_SIZE = 250;

// Reintentos por batch ante errores transitorios de red ("Failed to fetch",
// timeouts). Backoff exponencial con jitter.
const MAX_RETRIES = 3;

export const getGasUrl = () => {
  try {
    // Migración: si la versión guardada no es la actual, descartar la URL guardada.
    if (localStorage.getItem(LS_KEYS.URL_VERSION) !== URL_VERSION) {
      localStorage.removeItem(LS_KEYS.URL);
      localStorage.setItem(LS_KEYS.URL_VERSION, URL_VERSION);
    }
    const stored = localStorage.getItem(LS_KEYS.URL);
    return stored ? stored : DEFAULT_GAS_URL;
  } catch { return DEFAULT_GAS_URL; }
};

export const setGasUrl = (url) => {
  try {
    if (!url || url === DEFAULT_GAS_URL) localStorage.removeItem(LS_KEYS.URL);
    else localStorage.setItem(LS_KEYS.URL, url);
  } catch {}
};

export const resetGasUrl = () => {
  try { localStorage.removeItem(LS_KEYS.URL); } catch {}
};

// ─── LOCAL STORAGE FALLBACK ──────────────────────────────────────
const lsGet = (k, dflt = null) => {
  try {
    const s = localStorage.getItem(k);
    return s ? JSON.parse(s) : dflt;
  } catch { return dflt; }
};
const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

const stampSave = (dataset) => {
  const t = lsGet(LS_KEYS.TIMESTAMPS, {}) || {};
  t[dataset] = new Date().toISOString();
  lsSet(LS_KEYS.TIMESTAMPS, t);
};

export const getTimestamps = () => lsGet(LS_KEYS.TIMESTAMPS, {}) || {};

// ─── PENDING DATASETS (fallaron al sincronizar con GAS) ──────────
// Si un dataset quedó solo en local porque GAS dio "Failed to fetch" u otro
// error transitorio, lo registramos para que el usuario lo pueda reintentar
// sin volver a subir el archivo (los datos parseados ya están en localStorage).
export const getPendingDatasets = () => {
  const arr = lsGet(LS_KEYS.PENDING_DATASETS, []);
  return Array.isArray(arr) ? arr : [];
};
const setPendingDatasets = (arr) => lsSet(LS_KEYS.PENDING_DATASETS, arr);
const addPendingDataset = (dataset) => {
  const p = getPendingDatasets();
  if (!p.includes(dataset)) { p.push(dataset); setPendingDatasets(p); }
};
const removePendingDataset = (dataset) => {
  setPendingDatasets(getPendingDatasets().filter(d => d !== dataset));
};

// ─── REVIEWS PENDING SYNC ────────────────────────────────────────
// Track de las keys cuyos cambios aún no se confirmaron en GAS. Si el POST
// silenciosamente falla (timeout, cuota, CORS), la review queda sólo local.
// loadAll() reintenta esta lista en background, así el estado no se pierde.
const getPendingReviewKeys = () => {
  const arr = lsGet(LS_KEYS.REVIEWS_PENDING, []);
  return Array.isArray(arr) ? arr : [];
};
const setPendingReviewKeys = (arr) => lsSet(LS_KEYS.REVIEWS_PENDING, arr);
const addPendingReviewKey = (key) => {
  const p = getPendingReviewKeys();
  if (!p.includes(key)) { p.push(key); setPendingReviewKeys(p); }
};
const removePendingReviewKey = (key) => {
  setPendingReviewKeys(getPendingReviewKeys().filter(k => k !== key));
};
export const getPendingReviewsCount = () => getPendingReviewKeys().length;

// Combina reviews de GAS con las locales preservando las locales que GAS no
// tiene (probablemente saves que nunca llegaron a sincronizar) y las locales
// más recientes que GAS (cambios hechos antes que GAS lo refleje).
function mergeReviews(gasReviews, localReviews) {
  const out = { ...(gasReviews || {}) };
  for (const [key, lrev] of Object.entries(localReviews || {})) {
    if (!lrev) continue;
    const grev = out[key];
    if (!grev) {
      out[key] = lrev;
    } else {
      const lt = String(lrev.updated_at || "");
      const gt = String(grev.updated_at || "");
      if (lt && lt > gt) out[key] = lrev;
    }
  }
  return out;
}

// Calcula qué reviews del estado local todavía no están en GAS, o son más
// recientes que las de GAS. Incluye también los que se marcaron como fallo
// explícito en getPendingReviewKeys().
function computePendingSyncKeys(localReviews, gasReviews) {
  const candidates = new Set(getPendingReviewKeys());
  for (const [key, lrev] of Object.entries(localReviews || {})) {
    if (!lrev) continue;
    const grev = (gasReviews || {})[key];
    if (!grev) { candidates.add(key); continue; }
    const lt = String(lrev.updated_at || "");
    const gt = String(grev.updated_at || "");
    if (lt && lt > gt) candidates.add(key);
  }
  return candidates;
}

// Tamaño del lote al usar save_reviews_batch. 250 da buen balance: payload
// chico (~50-100KB), no se acerca al límite de 6 min de ejecución de GAS,
// progreso visible para el usuario.
const REVIEWS_BATCH_SIZE = 250;

// Heurística para detectar que el GAS desplegado no soporta save_reviews_batch
// (versión vieja del Code.gs). Cuando ocurre, caemos a la ruta uno-por-uno
// para que el usuario siga sincronizando incluso si todavía no redepoyó GAS.
function isUnknownActionError(err) {
  const msg = (err && err.message) || String(err || "");
  return /desconocida/i.test(msg) || /acci[óo]n/i.test(msg) || /unknown action/i.test(msg);
}

// Sube al GAS las reviews dadas. Por defecto usa save_reviews_batch para ir
// 30-50x más rápido. Si el endpoint no existe (Code.gs viejo), cae automáticamente
// a save_review uno-por-uno. onProgress recibe { done, total, failed } después
// de cada batch (o de cada review en modo fallback).
async function syncReviewKeys(url, keys, localReviews, onProgress) {
  const total = keys.length;
  let done = 0;
  let failed = 0;
  if (onProgress) onProgress({ done: 0, total, failed: 0 });
  if (!total) return { total: 0, done: 0, failed: 0, stillPending: [] };

  const stillPending = [];
  let batchSupported = true; // empezamos asumiendo que sí; primer error nos baja

  for (let i = 0; i < keys.length; i += REVIEWS_BATCH_SIZE) {
    const batchKeys = keys.slice(i, i + REVIEWS_BATCH_SIZE);
    const batchReviews = batchKeys
      .map(k => {
        const rev = (localReviews || {})[k];
        return rev ? {
          key: k,
          estado: rev.estado,
          nota: rev.nota || "",
          snapshot: rev.snapshot || null,
        } : null;
      })
      .filter(Boolean);

    let handled = false;

    if (batchSupported) {
      try {
        await postJSON(url, { action: "save_reviews_batch", reviews: batchReviews });
        done += batchReviews.length;
        handled = true;
      } catch (e) {
        if (isUnknownActionError(e)) {
          // GAS viejo: deshabilitar batch y reprocesar este lote per-item.
          console.info("[sync] GAS sin save_reviews_batch, cayendo a modo uno-por-uno");
          batchSupported = false;
        } else {
          // Falla real del batch: marcamos todo el lote como pendiente y seguimos.
          console.warn(`[sync] Batch falló (${batchReviews.length} reviews):`, e.message);
          failed += batchReviews.length;
          for (const r of batchReviews) stillPending.push(r.key);
          handled = true;
        }
      }
    }

    if (!handled) {
      // Modo fallback (per-item) para este batch.
      for (const r of batchReviews) {
        try {
          await postJSON(url, {
            action: "save_review",
            key: r.key,
            estado: r.estado,
            nota: r.nota,
            snapshot: r.snapshot,
          });
          done++;
        } catch (e) {
          console.warn(`[sync] Review ${r.key} sigue sin sincronizar:`, e.message);
          failed++;
          stillPending.push(r.key);
        }
        if (onProgress) onProgress({ done, total, failed });
      }
    } else {
      if (onProgress) onProgress({ done, total, failed });
    }
  }

  // Mezclamos los que quedaron pendientes con los explícitos previos para no
  // perder fallos que vinieran de otra ruta (e.g. saveReview directo).
  const remaining = new Set(getPendingReviewKeys());
  for (const key of keys) remaining.delete(key);
  for (const key of stillPending) remaining.add(key);
  setPendingReviewKeys(Array.from(remaining));

  return { total, done, failed, stillPending };
}

// Sincroniza en background cualquier review que esté local pero no en GAS, o
// más reciente que GAS. No bloquea el render.
async function syncPendingReviewsToGAS(url, localReviews, gasReviews) {
  const candidates = Array.from(computePendingSyncKeys(localReviews, gasReviews));
  if (!candidates.length) return;
  await syncReviewKeys(url, candidates, localReviews);
}

// Cuenta cuántas reviews están pendientes de sincronizar sin pegarle a GAS.
// Conservador: sólo cuenta los fallos explícitos. Para un conteo real
// re-comparado con GAS, usar forceSyncPendingReviews o loadAll (que devuelve
// pendingSyncCount).
export const getExplicitPendingCount = () => getPendingReviewKeys().length;

// Re-fetchea GAS para obtener el estado más fresco, calcula qué reviews
// faltan, y las sube una por una llamando a onProgress({ done, total, failed }).
// Es la versión "manual" que el usuario dispara con un botón en la UI.
export async function forceSyncPendingReviews(onProgress) {
  const url = getGasUrl();
  if (!url) return { ok: false, error: "No hay URL de Google Sheet configurada." };

  const localReviews = lsGet(LS_KEYS.REVIEWS, {}) || {};

  let gasReviews = {};
  try {
    const res = await fetch(`${url}?action=load_all`, { redirect: "follow" });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) json = JSON.parse(m[0]);
    }
    if (json && json.ok) gasReviews = json.reviews || {};
    else if (json && json.error) {
      return { ok: false, error: "GAS respondió error: " + json.error };
    }
  } catch (e) {
    // Si falla el fetch, igual intentamos subir los explícitos pendientes
    console.warn("No pude leer GAS antes de sincronizar:", e.message);
  }

  const candidates = Array.from(computePendingSyncKeys(localReviews, gasReviews));
  const result = await syncReviewKeys(url, candidates, localReviews, onProgress);
  return { ok: true, ...result };
}

// ─── FETCH HELPERS ───────────────────────────────────────────────
// Post JSON al GAS con reintentos. "Failed to fetch" suele ser transitorio
// (redirect intermedio que falla, conexión interrumpida) y se resuelve al
// reintentar. Si el error es de GAS (ok:false) NO reintentamos: el problema
// no se va a arreglar solo.
async function postJSON(url, body, { maxRetries = MAX_RETRIES } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
        redirect: "follow",
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try { json = JSON.parse(m[0]); }
          catch { throw new Error("Respuesta inválida del servidor"); }
        } else {
          throw new Error("Respuesta inválida: " + text.slice(0, 200));
        }
      }
      if (!json.ok) {
        // Error reportado por GAS: no reintentar, devolvemos el error.
        throw new Error(json.error || "Error del servidor");
      }
      return json;
    } catch (e) {
      lastErr = e;
      const msg = e.message || String(e);
      // Errores de GAS (devolvió ok:false) no se reintentan
      if (msg.startsWith("Error del servidor") || msg.startsWith("Respuesta inválida")) {
        throw e;
      }
      // Errores de red: backoff y reintentar
      if (attempt < maxRetries - 1) {
        const delay = 800 * Math.pow(2, attempt) + Math.random() * 400;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error("Falló después de reintentos");
}

// ─── SAVE DATASETS ───────────────────────────────────────────────
// Guarda en local SIEMPRE, intenta GAS después. Si GAS falla, deja el dataset
// en cola de pendientes para que se pueda reintentar.
async function saveWithFallback(key, dataset, rows, onProgress) {
  lsSet(key, rows);
  stampSave(dataset);
  const url = getGasUrl();
  if (!url) {
    removePendingDataset(dataset);
    return { ok: true, source: "local", count: rows.length };
  }
  try {
    const r = await postDataset(url, dataset, rows, onProgress);
    removePendingDataset(dataset);
    return r;
  } catch (e) {
    console.warn(`[${dataset}] GAS falló, guardado solo en local:`, e.message);
    addPendingDataset(dataset);
    return { ok: true, source: "local", count: rows.length, warning: e.message };
  }
}

export const saveDefontana     = (rows, onProgress) => saveWithFallback(LS_KEYS.DEFONTANA, "defontana", rows, onProgress);
export const saveOC            = (rows, onProgress) => saveWithFallback(LS_KEYS.OC, "oc", rows, onProgress);
export const saveFactCL        = (rows, onProgress) => saveWithFallback(LS_KEYS.FACTCL, "factcl", rows, onProgress);
export const saveInformeCompra = (rows, onProgress) => saveWithFallback(LS_KEYS.COMPRA, "compra", rows, onProgress);

// Reintentar pendientes desde lo que está en localStorage. No requiere
// volver a subir los archivos.
export async function retryPendingDatasets(onProgress) {
  const results = {};
  const pending = getPendingDatasets();
  for (const dataset of pending) {
    const key = {
      defontana: LS_KEYS.DEFONTANA,
      oc: LS_KEYS.OC,
      factcl: LS_KEYS.FACTCL,
      compra: LS_KEYS.COMPRA,
    }[dataset];
    const rows = lsGet(key, []) || [];
    if (!rows.length) {
      removePendingDataset(dataset);
      results[dataset] = { ok: true, source: "local", count: 0, skipped: true };
      continue;
    }
    results[dataset] = await saveWithFallback(key, dataset, rows, onProgress ? (p) => onProgress(dataset, p) : null);
  }
  return results;
}

async function postDataset(url, dataset, rows, onProgress) {
  const total = rows.length;
  const batches = Math.max(1, Math.ceil(total / BATCH_SIZE));
  for (let i = 0, b = 0; i < total; i += BATCH_SIZE, b++) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const isFirst = i === 0;
    const isLast = i + BATCH_SIZE >= total;
    await postJSON(url, {
      action: "save_dataset",
      dataset,
      rows: batch,
      clear: isFirst,
      isLast,
    });
    if (onProgress) onProgress({ dataset, batch: b + 1, batches, rows: Math.min(i + BATCH_SIZE, total), total });
  }
  return { ok: true, source: "gas", count: total };
}

// ─── LOAD DATASETS ───────────────────────────────────────────────
export async function loadAll() {
  const url = getGasUrl();
  if (url) {
    try {
      const res = await fetch(`${url}?action=load_all`, { redirect: "follow" });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) json = JSON.parse(m[0]); else throw new Error("GAS respuesta no JSON");
      }
      if (!json.ok) throw new Error(json.error || "Error al cargar");

      // Combinar reviews de GAS con las locales para no perder cambios que
      // nunca llegaron a sincronizar (e.g. POST falló en silencio). Sin esta
      // mezcla, lsSet(REVIEWS, json.reviews) sobrescribía estados REVISADA/OK
      // que el usuario marcó pero que nunca alcanzaron a guardarse en GAS,
      // haciendo que las facturas reaparecieran como PENDIENTE.
      const localReviews = lsGet(LS_KEYS.REVIEWS, {}) || {};
      const gasReviews = json.reviews || {};
      const mergedReviews = mergeReviews(gasReviews, localReviews);

      // Persistir todo en local (para modo offline) usando la versión mezclada.
      // Si un dataset está pendiente de sincronizar a GAS, NO lo sobrescribimos
      // con la versión de GAS — los datos locales son más nuevos y aún no
      // llegaron al sheet.
      const pending = new Set(getPendingDatasets());
      if (json.defontana && !pending.has("defontana")) lsSet(LS_KEYS.DEFONTANA, json.defontana);
      if (json.oc && !pending.has("oc")) lsSet(LS_KEYS.OC, json.oc);
      if (json.factcl && !pending.has("factcl")) lsSet(LS_KEYS.FACTCL, json.factcl);
      if (json.compra && !pending.has("compra")) lsSet(LS_KEYS.COMPRA, json.compra);
      lsSet(LS_KEYS.REVIEWS, mergedReviews);

      // Conteo de reviews local-only / más-nuevas-que-GAS, para mostrarlo en
      // la UI. Es el mismo cálculo que hace la sincronización automática.
      const pendingSyncKeys = Array.from(computePendingSyncKeys(mergedReviews, gasReviews));

      // Sincronizar en background cualquier review local pendiente. No
      // bloquea el render; si vuelve a fallar, queda en cola para el próximo
      // loadAll. (El usuario puede acelerar esto con el botón "Forzar
      // sincronización" en la UI, que usa forceSyncPendingReviews.)
      syncPendingReviewsToGAS(url, mergedReviews, gasReviews)
        .catch(e => console.warn("Error sincronizando reviews pendientes:", e));

      return {
        defontana: pending.has("defontana") ? (lsGet(LS_KEYS.DEFONTANA, []) || []) : (json.defontana || []),
        oc:        pending.has("oc")        ? (lsGet(LS_KEYS.OC, []) || [])        : (json.oc || []),
        factcl:    pending.has("factcl")    ? (lsGet(LS_KEYS.FACTCL, []) || [])    : (json.factcl || []),
        compra:    pending.has("compra")    ? (lsGet(LS_KEYS.COMPRA, []) || [])    : (json.compra || lsGet(LS_KEYS.COMPRA, []) || []),
        reviews: mergedReviews,
        source: pending.size > 0 ? "gas+pending" : "gas",
        pendingSyncCount: pendingSyncKeys.length,
      };
    } catch (e) {
      console.warn("Fallback a localStorage:", e.message);
    }
  }
  // Fallback puro local: el conteo de pendientes equivale al de fallos
  // explícitos, porque no podemos comparar contra GAS sin conexión.
  return {
    defontana: lsGet(LS_KEYS.DEFONTANA, []) || [],
    oc: lsGet(LS_KEYS.OC, []) || [],
    factcl: lsGet(LS_KEYS.FACTCL, []) || [],
    compra: lsGet(LS_KEYS.COMPRA, []) || [],
    reviews: lsGet(LS_KEYS.REVIEWS, {}) || {},
    source: "local",
    pendingSyncCount: getPendingReviewKeys().length,
  };
}

// ─── REVIEWS ────────────────────────────────────────────────────
// snapshot: opcional, objeto con campos para preservar info de la fila
// (proveedor, vencimiento, montos, etc.) cuando la factura desaparece
// de Defontana en cargas posteriores.
export async function saveReview(key, estado, nota = "", snapshot = null) {
  const reviews = lsGet(LS_KEYS.REVIEWS, {}) || {};
  const existing = reviews[key] || {};
  reviews[key] = {
    estado,
    nota,
    updated_at: new Date().toISOString(),
    snapshot: snapshot || existing.snapshot || null,
  };
  lsSet(LS_KEYS.REVIEWS, reviews);

  const url = getGasUrl();
  if (!url) return { ok: true, source: "local" };
  try {
    await postJSON(url, {
      action: "save_review",
      key,
      estado,
      nota,
      snapshot: reviews[key].snapshot,
    });
    removePendingReviewKey(key);
    return { ok: true, source: "gas" };
  } catch (e) {
    console.warn("Review guardada sólo en local:", e.message);
    addPendingReviewKey(key);
    return { ok: true, source: "local", warning: e.message };
  }
}
