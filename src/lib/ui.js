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
  return String(s);
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
