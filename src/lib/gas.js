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
};

// Bump cuando la URL por defecto cambie o haya que forzar limpieza de URLs viejas.
const URL_VERSION = "2";

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

// Sincroniza en background cualquier review que esté local pero no en GAS, o
// más reciente que GAS. No bloquea el render.
async function syncPendingReviewsToGAS(url, mergedReviews, gasReviews) {
  const candidates = new Set(getPendingReviewKeys());
  for (const [key, mrev] of Object.entries(mergedReviews || {})) {
    if (!mrev) continue;
    const grev = (gasReviews || {})[key];
    if (!grev) { candidates.add(key); continue; }
    const mt = String(mrev.updated_at || "");
    const gt = String(grev.updated_at || "");
    if (mt && mt > gt) candidates.add(key);
  }
  if (!candidates.size) return;

  const stillPending = [];
  for (const key of candidates) {
    const rev = mergedReviews[key];
    if (!rev) continue;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "save_review",
          key,
          estado: rev.estado,
          nota: rev.nota || "",
          snapshot: rev.snapshot || null,
        }),
      });
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json.ok) throw new Error(json.error || "GAS error");
    } catch (e) {
      console.warn(`[sync] Review ${key} sigue sin sincronizar:`, e.message);
      stillPending.push(key);
    }
  }
  setPendingReviewKeys(stillPending);
}

// ─── SAVE DATASETS ───────────────────────────────────────────────
async function saveWithFallback(key, dataset, rows) {
  lsSet(key, rows);
  stampSave(dataset);
  const url = getGasUrl();
  if (!url) return { ok: true, source: "local", count: rows.length };
  try {
    return await postDataset(url, dataset, rows);
  } catch (e) {
    console.warn(`[${dataset}] GAS falló, guardado solo en local:`, e.message);
    return { ok: true, source: "local", count: rows.length, warning: e.message };
  }
}

export const saveDefontana     = (rows) => saveWithFallback(LS_KEYS.DEFONTANA, "defontana", rows);
export const saveOC            = (rows) => saveWithFallback(LS_KEYS.OC, "oc", rows);
export const saveFactCL        = (rows) => saveWithFallback(LS_KEYS.FACTCL, "factcl", rows);
export const saveInformeCompra = (rows) => saveWithFallback(LS_KEYS.COMPRA, "compra", rows);

async function postDataset(url, dataset, rows) {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const isFirst = i === 0;
    const isLast = i + BATCH >= rows.length;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "save_dataset",
        dataset,
        rows: batch,
        clear: isFirst,
        isLast,
      }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("Respuesta inválida: " + text.slice(0, 200)); }
    if (!json.ok) throw new Error(json.error || "Error al guardar " + dataset);
  }
  return { ok: true, source: "gas", count: rows.length };
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
      if (json.defontana) lsSet(LS_KEYS.DEFONTANA, json.defontana);
      if (json.oc) lsSet(LS_KEYS.OC, json.oc);
      if (json.factcl) lsSet(LS_KEYS.FACTCL, json.factcl);
      if (json.compra) lsSet(LS_KEYS.COMPRA, json.compra);
      lsSet(LS_KEYS.REVIEWS, mergedReviews);

      // Sincronizar en background cualquier review local pendiente. No
      // bloquea el render; si vuelve a fallar, queda en cola para el próximo
      // loadAll.
      syncPendingReviewsToGAS(url, mergedReviews, gasReviews)
        .catch(e => console.warn("Error sincronizando reviews pendientes:", e));

      return {
        defontana: json.defontana || [],
        oc: json.oc || [],
        factcl: json.factcl || [],
        compra: json.compra || lsGet(LS_KEYS.COMPRA, []) || [],
        reviews: mergedReviews,
        source: "gas",
      };
    } catch (e) {
      console.warn("Fallback a localStorage:", e.message);
    }
  }
  return {
    defontana: lsGet(LS_KEYS.DEFONTANA, []) || [],
    oc: lsGet(LS_KEYS.OC, []) || [],
    factcl: lsGet(LS_KEYS.FACTCL, []) || [],
    compra: lsGet(LS_KEYS.COMPRA, []) || [],
    reviews: lsGet(LS_KEYS.REVIEWS, {}) || {},
    source: "local",
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_review", key, estado, nota, snapshot: reviews[key].snapshot }),
    });
    const text = await res.text();
    const json = JSON.parse(text);
    if (!json.ok) throw new Error(json.error || "GAS error");
    removePendingReviewKey(key);
    return { ok: true, source: "gas" };
  } catch (e) {
    console.warn("Review guardada sólo en local:", e.message);
    addPendingReviewKey(key);
    return { ok: true, source: "local", warning: e.message };
  }
}
