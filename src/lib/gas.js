// Cliente del Google Apps Script. Si no hay URL configurada, persiste en localStorage.

const LS_KEYS = {
  URL: "gas_url",
  DEFONTANA: "data_defontana",
  OC: "data_oc",
  FACTCL: "data_factcl",
  REVIEWS: "data_reviews",
  TIMESTAMPS: "data_timestamps",
};

export const getGasUrl = () => {
  try { return localStorage.getItem(LS_KEYS.URL) || ""; } catch { return ""; }
};

export const setGasUrl = (url) => {
  try { localStorage.setItem(LS_KEYS.URL, url); } catch {}
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

// ─── SAVE DATASETS ───────────────────────────────────────────────
export async function saveDefontana(rows) {
  lsSet(LS_KEYS.DEFONTANA, rows);
  stampSave("defontana");
  const url = getGasUrl();
  if (!url) return { ok: true, source: "local", count: rows.length };
  return postDataset(url, "defontana", rows);
}

export async function saveOC(rows) {
  lsSet(LS_KEYS.OC, rows);
  stampSave("oc");
  const url = getGasUrl();
  if (!url) return { ok: true, source: "local", count: rows.length };
  return postDataset(url, "oc", rows);
}

export async function saveFactCL(rows) {
  lsSet(LS_KEYS.FACTCL, rows);
  stampSave("factcl");
  const url = getGasUrl();
  if (!url) return { ok: true, source: "local", count: rows.length };
  return postDataset(url, "factcl", rows);
}

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
      // guardamos también en local para modo offline
      if (json.defontana) lsSet(LS_KEYS.DEFONTANA, json.defontana);
      if (json.oc) lsSet(LS_KEYS.OC, json.oc);
      if (json.factcl) lsSet(LS_KEYS.FACTCL, json.factcl);
      if (json.reviews) lsSet(LS_KEYS.REVIEWS, json.reviews);
      return {
        defontana: json.defontana || [],
        oc: json.oc || [],
        factcl: json.factcl || [],
        reviews: json.reviews || {},
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
    reviews: lsGet(LS_KEYS.REVIEWS, {}) || {},
    source: "local",
  };
}

// ─── REVIEWS ────────────────────────────────────────────────────
export async function saveReview(key, estado, nota = "") {
  const reviews = lsGet(LS_KEYS.REVIEWS, {}) || {};
  reviews[key] = { estado, nota, updated_at: new Date().toISOString() };
  lsSet(LS_KEYS.REVIEWS, reviews);

  const url = getGasUrl();
  if (!url) return { ok: true, source: "local" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_review", key, estado, nota }),
    });
    const text = await res.text();
    const json = JSON.parse(text);
    if (!json.ok) throw new Error(json.error);
    return { ok: true, source: "gas" };
  } catch (e) {
    console.warn("Review guardada sólo en local:", e.message);
    return { ok: true, source: "local", warning: e.message };
  }
}
