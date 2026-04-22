// Helpers visuales compartidos

export const fmtCLP = (n) => {
  const num = Math.round(Number(n) || 0);
  const neg = num < 0;
  const abs = Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return neg ? `-$${abs}` : `$${abs}`;
};

export const fmtShort = (n) => {
  const num = Math.round(Number(n) || 0);
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(num / 1_000).toFixed(0)}K`;
  return fmtCLP(num);
};

export const fmtDate = (s) => {
  if (!s) return "";
  // Acepta Date, string ISO "2026-04-21T04:00:00.000Z", o string dd/MM/yyyy.
  // Siempre devuelve dd/MM/yyyy (formato Defontana).
  const pad = (n) => String(n).padStart(2, "0");
  if (s instanceof Date && !isNaN(s)) {
    return `${pad(s.getDate())}/${pad(s.getMonth() + 1)}/${s.getFullYear()}`;
  }
  const str = String(s).trim();
  // ISO 8601 o similar con "T"
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
  return str;
};

export const fmtRut = (r) => {
  if (!r) return "";
  const s = String(r).replace(/\./g, "").replace(/-/g, "").toUpperCase();
  if (s.length < 2) return s;
  const dv = s.slice(-1);
  const body = s.slice(0, -1);
  const withDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${dv}`;
};

export const STATE_COLORS = {
  PENDIENTE: { bg: "rgba(99,102,241,0.12)", border: "rgba(99,102,241,0.3)", fg: "#a5b4fc" },
  OK:        { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.3)",  fg: "#22c55e" },
  REVISAR:   { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.3)",  fg: "#f87171" },
  REVISADA:  { bg: "rgba(148,163,184,0.12)", border: "rgba(148,163,184,0.3)", fg: "#94a3b8" },
};
