import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "sheetjs";

// ─── CONFIG ────────────────────────────────────────────────────────
// Reemplazar con tu Google Apps Script Web App URL una vez desplegado
const GAS_URL = "PEGAR_URL_AQUI";

// Columnas del xlsx de Defontana que nos interesan (0-indexed)
const COL_MAP = {
  D: 3,  // Condición (1NOMINA / 2CONTADO)
  F: 5,  // Fecha
  G: 6,  // Tipo
  H: 7,  // Número
  I: 8,  // RUT / ID Ficha
  J: 9,  // Nombre proveedor (Ficha)
  K: 10, // Cargo ($)
  L: 11, // Abono ($)
  M: 12, // Saldo ($)
  O: 14, // Tipo Documento
  P: 15, // Vencimiento
  Q: 16, // Número Doc.
};

const HEADERS = [
  "Condición", "Fecha", "Tipo", "Número", "RUT",
  "Proveedor", "Cargo", "Abono", "Saldo",
  "Documento", "Vencimiento", "Nº Doc."
];

const HEADER_KEYS = ["D","F","G","H","I","J","K","L","M","O","P","Q"];

// ─── HELPERS ───────────────────────────────────────────────────────
const fmt = (n) => {
  if (n == null || n === "" || isNaN(n)) return "$0";
  const num = Math.round(Number(n));
  const neg = num < 0;
  const abs = Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return neg ? `-$${abs}` : `$${abs}`;
};

const fmtShort = (n) => {
  if (n == null || isNaN(n)) return "$0";
  const num = Math.round(Number(n));
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(num / 1_000).toFixed(0)}K`;
  return fmt(num);
};

const parseDate = (s) => {
  if (!s) return null;
  if (typeof s === "string" && s.includes("/")) {
    const [d, m, y] = s.split("/");
    return new Date(+y, +m - 1, +d);
  }
  return null;
};

const fmtDate = (s) => {
  if (!s) return "";
  return s; // Already dd/mm/yyyy string
};

const isDateInRange = (dateStr, from, to) => {
  if (!from && !to) return true;
  const d = parseDate(dateStr);
  if (!d) return true;
  if (from) {
    const f = new Date(from + "T00:00:00");
    if (d < f) return false;
  }
  if (to) {
    const t = new Date(to + "T23:59:59");
    if (d > t) return false;
  }
  return true;
};

// ─── ICONS ─────────────────────────────────────────────────────────
const IconUpload = () => (
  <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);

const IconSearch = () => (
  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

const IconCheck = () => (
  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const IconAlert = () => (
  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const IconFile = () => (
  <svg width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" strokeLinecap="round" strokeLinejoin="round"/>
    <polyline points="14 2 14 8 20 8" strokeLinecap="round" strokeLinejoin="round"/>
    <line x1="8" y1="13" x2="16" y2="13" strokeLinecap="round"/><line x1="8" y1="17" x2="16" y2="17" strokeLinecap="round"/>
  </svg>
);

const IconTruck = () => (
  <svg width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <rect x="1" y="3" width="15" height="13" rx="1"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
    <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
  </svg>
);

const IconRefresh = () => (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
  </svg>
);

const IconFilter = () => (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
);

const IconX = () => (
  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" viewBox="0 0 24 24">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

// ─── MAIN APP ──────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("upload");
  const [gasUrl, setGasUrl] = useState(() => {
    try { return localStorage?.getItem?.("gas_url") || GAS_URL; } catch { return GAS_URL; }
  });
  const [showConfig, setShowConfig] = useState(false);

  // Upload state
  const [file, setFile] = useState(null);
  const [parsedData, setParsedData] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [parseStats, setParseStats] = useState(null);
  const fileInputRef = useRef(null);

  // Search state
  const [searchData, setSearchData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [filterCondicion, setFilterCondicion] = useState("TODAS");
  const [filterTipo, setFilterTipo] = useState("TODOS");
  const [filterDocumento, setFilterDocumento] = useState("TODOS");
  const [filterVencDesde, setFilterVencDesde] = useState("");
  const [filterVencHasta, setFilterVencHasta] = useState("");
  const [filterMontoMin, setFilterMontoMin] = useState("");
  const [filterMontoMax, setFilterMontoMax] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [lastUpdate, setLastUpdate] = useState(null);

  const saveGasUrl = (url) => {
    setGasUrl(url);
    try { localStorage?.setItem?.("gas_url", url); } catch {}
  };

  // ─── FILE PARSING ──────────────────────────────────────────────
  const handleFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setUploadResult(null);
    setParsedData([]);
    setParseStats(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

        // Find header row (row with "Cuenta" in col A)
        let headerIdx = -1;
        for (let i = 0; i < Math.min(raw.length, 15); i++) {
          if (raw[i]?.[0]?.toString().toLowerCase().includes("cuenta")) {
            headerIdx = i;
            break;
          }
        }
        if (headerIdx === -1) {
          setUploadResult({ ok: false, msg: "No se encontró la fila de encabezado (Cuenta). ¿Es el formato correcto de Defontana?" });
          return;
        }

        const dataRows = raw.slice(headerIdx + 1).filter(r => r.some(c => c !== "" && c != null));
        const extracted = dataRows.map(r => {
          return HEADER_KEYS.map(k => {
            const val = r[COL_MAP[k]];
            return val != null ? val.toString() : "";
          });
        });

        // Stats
        const nomina = extracted.filter(r => r[0] === "1NOMINA").length;
        const contado = extracted.filter(r => r[0] === "2CONTADO").length;
        const tipos = [...new Set(extracted.map(r => r[2]))].filter(Boolean);
        const proveedores = [...new Set(extracted.map(r => r[5]))].filter(Boolean).length;

        setParsedData(extracted);
        setParseStats({
          total: extracted.length,
          nomina,
          contado,
          tipos,
          proveedores,
        });
      } catch (err) {
        setUploadResult({ ok: false, msg: `Error al leer archivo: ${err.message}` });
      }
    };
    reader.readAsArrayBuffer(f);
  }, []);

  // ─── UPLOAD TO GOOGLE SHEETS ───────────────────────────────────
  const handleUpload = useCallback(async () => {
    if (!parsedData.length) return;
    if (!gasUrl || gasUrl === "PEGAR_URL_AQUI") {
      setUploadResult({ ok: false, msg: "Configura la URL del Google Apps Script primero (botón ⚙️)." });
      return;
    }
    setUploading(true);
    setUploadResult(null);

    try {
      // Send in batches of 500 to avoid payload limits
      const BATCH = 500;
      const total = parsedData.length;
      let sent = 0;

      for (let i = 0; i < total; i += BATCH) {
        const batch = parsedData.slice(i, i + BATCH);
        const isFirst = i === 0;
        const isLast = i + BATCH >= total;

        const res = await fetch(gasUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "upload",
            headers: isFirst ? HEADERS : null,
            data: batch,
            clear: isFirst,
            isLast,
          }),
        });

        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch {
          throw new Error("Respuesta inválida del servidor: " + text.substring(0, 200));
        }
        if (!json.ok) throw new Error(json.error || "Error desconocido");
        sent += batch.length;
      }

      setUploadResult({ ok: true, msg: `${total.toLocaleString("es-CL")} filas cargadas exitosamente al Google Sheet.` });
    } catch (err) {
      setUploadResult({ ok: false, msg: `Error: ${err.message}` });
    } finally {
      setUploading(false);
    }
  }, [parsedData, gasUrl]);

  // ─── FETCH DATA FOR SEARCH ────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!gasUrl || gasUrl === "PEGAR_URL_AQUI") return;
    setLoading(true);
    try {
      const res = await fetch(`${gasUrl}?action=read`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (json.ok) {
        setSearchData(json.data || []);
        setLastUpdate(new Date().toLocaleString("es-CL"));
      }
    } catch (err) {
      console.error("Error fetching data:", err);
    } finally {
      setLoading(false);
    }
  }, [gasUrl]);

  useEffect(() => {
    if (tab === "search") fetchData();
  }, [tab, fetchData]);

  // ─── FILTERED + SORTED DATA ───────────────────────────────────
  const uniqueTipos = useMemo(() => ["TODOS", ...new Set(searchData.map(r => r[2]).filter(Boolean))], [searchData]);
  const uniqueDocs = useMemo(() => ["TODOS", ...new Set(searchData.map(r => r[9]).filter(Boolean))], [searchData]);

  const filtered = useMemo(() => {
    const q = searchText.toLowerCase().trim();
    return searchData.filter(row => {
      // Text search: RUT (4), Proveedor (5), Nº Doc (11)
      if (q) {
        const rut = (row[4] || "").toLowerCase();
        const prov = (row[5] || "").toLowerCase();
        const ndoc = (row[11] || "").toString().toLowerCase();
        const num = (row[3] || "").toString().toLowerCase();
        if (!rut.includes(q) && !prov.includes(q) && !ndoc.includes(q) && !num.includes(q)) return false;
      }
      // Condición
      if (filterCondicion !== "TODAS") {
        if (row[0] !== filterCondicion) return false;
      }
      // Tipo
      if (filterTipo !== "TODOS" && row[2] !== filterTipo) return false;
      // Documento
      if (filterDocumento !== "TODOS" && row[9] !== filterDocumento) return false;
      // Vencimiento range
      if (!isDateInRange(row[10], filterVencDesde, filterVencHasta)) return false;
      // Monto (saldo col index 8)
      if (filterMontoMin) {
        const saldo = Math.abs(Number(row[8]) || 0);
        if (saldo < Number(filterMontoMin)) return false;
      }
      if (filterMontoMax) {
        const saldo = Math.abs(Number(row[8]) || 0);
        if (saldo > Number(filterMontoMax)) return false;
      }
      return true;
    });
  }, [searchData, searchText, filterCondicion, filterTipo, filterDocumento, filterVencDesde, filterVencHasta, filterMontoMin, filterMontoMax]);

  const sorted = useMemo(() => {
    if (sortCol === null) return filtered;
    const arr = [...filtered];
    const idx = sortCol;
    const moneyIdx = [6, 7, 8]; // Cargo, Abono, Saldo
    arr.sort((a, b) => {
      let va = a[idx] || "";
      let vb = b[idx] || "";
      if (moneyIdx.includes(idx)) {
        va = Number(va) || 0;
        vb = Number(vb) || 0;
      } else {
        va = va.toString().toLowerCase();
        vb = vb.toString().toLowerCase();
      }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortCol, sortDir]);

  const handleSort = (idx) => {
    if (sortCol === idx) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(idx);
      setSortDir("asc");
    }
  };

  // Totals
  const totals = useMemo(() => {
    let cargo = 0, abono = 0, saldo = 0;
    filtered.forEach(r => {
      cargo += Number(r[6]) || 0;
      abono += Number(r[7]) || 0;
      saldo += Number(r[8]) || 0;
    });
    return { cargo, abono, saldo };
  }, [filtered]);

  const clearFilters = () => {
    setSearchText("");
    setFilterCondicion("TODAS");
    setFilterTipo("TODOS");
    setFilterDocumento("TODOS");
    setFilterVencDesde("");
    setFilterVencHasta("");
    setFilterMontoMin("");
    setFilterMontoMax("");
  };

  const hasActiveFilters = searchText || filterCondicion !== "TODAS" || filterTipo !== "TODOS" || filterDocumento !== "TODOS" || filterVencDesde || filterVencHasta || filterMontoMin || filterMontoMax;

  // ─── RENDER ────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh",
      fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
      color: "#e2e8f0",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        background: "rgba(15,23,42,0.8)",
        borderBottom: "1px solid rgba(99,102,241,0.2)",
        backdropFilter: "blur(20px)",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            borderRadius: "10px",
            padding: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <IconTruck />
          </div>
          <div>
            <div style={{
              fontSize: "18px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              background: "linear-gradient(135deg, #e2e8f0, #94a3b8)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}>
              PROVEEDORES TBELLO
            </div>
            <div style={{ fontSize: "11px", color: "#64748b", letterSpacing: "0.05em", textTransform: "uppercase" }}>
              Auditoría de documentos · Defontana
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Tabs */}
          <div style={{
            display: "flex",
            background: "rgba(30,41,59,0.8)",
            borderRadius: "10px",
            padding: "3px",
            border: "1px solid rgba(99,102,241,0.15)",
          }}>
            {[
              { id: "upload", label: "Carga", icon: <IconUpload /> },
              { id: "search", label: "Buscador", icon: <IconSearch /> },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 16px",
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: 600,
                fontFamily: "inherit",
                transition: "all 0.2s",
                background: tab === t.id ? "linear-gradient(135deg, #6366f1, #7c3aed)" : "transparent",
                color: tab === t.id ? "#fff" : "#94a3b8",
                boxShadow: tab === t.id ? "0 2px 8px rgba(99,102,241,0.3)" : "none",
              }}>
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {/* Config button */}
          <button onClick={() => setShowConfig(!showConfig)} style={{
            background: "rgba(30,41,59,0.8)",
            border: "1px solid rgba(99,102,241,0.15)",
            borderRadius: "8px",
            padding: "8px",
            cursor: "pointer",
            color: "#94a3b8",
            fontSize: "16px",
            display: "flex",
            alignItems: "center",
          }}>
            ⚙️
          </button>
        </div>
      </div>

      {/* Config Panel */}
      {showConfig && (
        <div style={{
          margin: "16px 24px 0",
          padding: "16px 20px",
          background: "rgba(30,41,59,0.6)",
          borderRadius: "12px",
          border: "1px solid rgba(99,102,241,0.2)",
        }}>
          <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px", color: "#94a3b8" }}>
            URL Google Apps Script (Web App)
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              value={gasUrl}
              onChange={e => saveGasUrl(e.target.value)}
              placeholder="https://script.google.com/macros/s/.../exec"
              style={{
                flex: 1,
                padding: "10px 14px",
                background: "rgba(15,23,42,0.8)",
                border: "1px solid rgba(99,102,241,0.2)",
                borderRadius: "8px",
                color: "#e2e8f0",
                fontSize: "13px",
                fontFamily: "'JetBrains Mono', monospace",
                outline: "none",
              }}
            />
            <button onClick={() => setShowConfig(false)} style={{
              padding: "10px 16px",
              background: "linear-gradient(135deg, #6366f1, #7c3aed)",
              border: "none",
              borderRadius: "8px",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "13px",
              fontFamily: "inherit",
            }}>
              Guardar
            </button>
          </div>
        </div>
      )}

      <div style={{ padding: "24px", maxWidth: "1400px", margin: "0 auto" }}>

        {/* ═══ UPLOAD TAB ═══ */}
        {tab === "upload" && (
          <div>
            {/* Drop zone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = "#6366f1"; }}
              onDragLeave={e => { e.currentTarget.style.borderColor = "rgba(99,102,241,0.3)"; }}
              onDrop={e => {
                e.preventDefault();
                e.currentTarget.style.borderColor = "rgba(99,102,241,0.3)";
                const f = e.dataTransfer.files[0];
                if (f) {
                  const dt = new DataTransfer();
                  dt.items.add(f);
                  fileInputRef.current.files = dt.files;
                  handleFile({ target: { files: [f] } });
                }
              }}
              style={{
                border: "2px dashed rgba(99,102,241,0.3)",
                borderRadius: "16px",
                padding: "48px 32px",
                textAlign: "center",
                cursor: "pointer",
                transition: "all 0.3s",
                background: "rgba(30,41,59,0.3)",
              }}
            >
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ display: "none" }} />
              <div style={{ opacity: 0.5, marginBottom: "16px" }}><IconFile /></div>
              {file ? (
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 600, color: "#a5b4fc" }}>{file.name}</div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
                    {(file.size / 1024).toFixed(0)} KB · Clic para cambiar archivo
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 600, color: "#94a3b8" }}>
                    Arrastra el archivo de Defontana aquí
                  </div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
                    o haz clic para seleccionar · .xlsx
                  </div>
                </div>
              )}
            </div>

            {/* Parse Stats */}
            {parseStats && (
              <div style={{ marginTop: "20px" }}>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: "12px",
                  marginBottom: "20px",
                }}>
                  {[
                    { label: "Total filas", value: parseStats.total.toLocaleString("es-CL"), color: "#6366f1" },
                    { label: "Nómina (crédito)", value: parseStats.nomina.toLocaleString("es-CL"), color: "#22c55e" },
                    { label: "Contado", value: parseStats.contado.toLocaleString("es-CL"), color: "#f59e0b" },
                    { label: "Proveedores", value: parseStats.proveedores.toLocaleString("es-CL"), color: "#ec4899" },
                  ].map((s, i) => (
                    <div key={i} style={{
                      background: "rgba(30,41,59,0.6)",
                      borderRadius: "12px",
                      padding: "16px",
                      border: `1px solid ${s.color}33`,
                    }}>
                      <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {s.label}
                      </div>
                      <div style={{ fontSize: "24px", fontWeight: 700, color: s.color, marginTop: "4px" }}>
                        {s.value}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Preview table */}
                <div style={{
                  background: "rgba(30,41,59,0.4)",
                  borderRadius: "12px",
                  border: "1px solid rgba(99,102,241,0.15)",
                  overflow: "hidden",
                  marginBottom: "20px",
                }}>
                  <div style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid rgba(99,102,241,0.1)",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "#94a3b8",
                  }}>
                    Vista previa (primeras 10 filas)
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr>
                          {HEADERS.map((h, i) => (
                            <th key={i} style={{
                              padding: "10px 12px",
                              textAlign: "left",
                              fontWeight: 600,
                              color: "#94a3b8",
                              borderBottom: "1px solid rgba(99,102,241,0.1)",
                              whiteSpace: "nowrap",
                              fontSize: "11px",
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {parsedData.slice(0, 10).map((row, ri) => (
                          <tr key={ri} style={{ background: ri % 2 === 0 ? "transparent" : "rgba(15,23,42,0.3)" }}>
                            {row.map((cell, ci) => (
                              <td key={ci} style={{
                                padding: "8px 12px",
                                borderBottom: "1px solid rgba(99,102,241,0.05)",
                                whiteSpace: "nowrap",
                                color: ci === 0 ? (cell === "1NOMINA" ? "#22c55e" : "#f59e0b") : "#cbd5e1",
                                fontFamily: [6, 7, 8].includes(ci) ? "'JetBrains Mono', monospace" : "inherit",
                                fontWeight: [6, 7, 8].includes(ci) ? 500 : 400,
                                textAlign: [6, 7, 8].includes(ci) ? "right" : "left",
                              }}>
                                {[6, 7, 8].includes(ci) ? fmt(cell) : cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Upload button */}
                <button onClick={handleUpload} disabled={uploading} style={{
                  width: "100%",
                  padding: "14px",
                  border: "none",
                  borderRadius: "12px",
                  background: uploading
                    ? "rgba(99,102,241,0.3)"
                    : "linear-gradient(135deg, #6366f1, #7c3aed)",
                  color: "#fff",
                  fontSize: "15px",
                  fontWeight: 700,
                  fontFamily: "inherit",
                  cursor: uploading ? "wait" : "pointer",
                  boxShadow: uploading ? "none" : "0 4px 15px rgba(99,102,241,0.3)",
                  transition: "all 0.3s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}>
                  {uploading ? (
                    <>
                      <div style={{
                        width: "18px", height: "18px",
                        border: "2px solid rgba(255,255,255,0.3)",
                        borderTopColor: "#fff",
                        borderRadius: "50%",
                        animation: "spin 0.8s linear infinite",
                      }} />
                      Enviando al Google Sheet...
                    </>
                  ) : (
                    <>
                      <IconUpload />
                      Sobrescribir Google Sheet ({parseStats.total.toLocaleString("es-CL")} filas)
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Result message */}
            {uploadResult && (
              <div style={{
                marginTop: "16px",
                padding: "14px 18px",
                borderRadius: "12px",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                background: uploadResult.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                border: `1px solid ${uploadResult.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                color: uploadResult.ok ? "#22c55e" : "#ef4444",
                fontSize: "14px",
                fontWeight: 500,
              }}>
                {uploadResult.ok ? <IconCheck /> : <IconAlert />}
                {uploadResult.msg}
              </div>
            )}
          </div>
        )}

        {/* ═══ SEARCH TAB ═══ */}
        {tab === "search" && (
          <div>
            {/* Search bar */}
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
              <div style={{
                flex: 1,
                position: "relative",
                display: "flex",
                alignItems: "center",
              }}>
                <div style={{
                  position: "absolute",
                  left: "14px",
                  color: "#64748b",
                  display: "flex",
                  pointerEvents: "none",
                }}>
                  <IconSearch />
                </div>
                <input
                  type="text"
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  placeholder="Buscar por RUT, proveedor, Nº documento, número..."
                  style={{
                    width: "100%",
                    padding: "12px 14px 12px 42px",
                    background: "rgba(30,41,59,0.6)",
                    border: "1px solid rgba(99,102,241,0.2)",
                    borderRadius: "10px",
                    color: "#e2e8f0",
                    fontSize: "14px",
                    fontFamily: "inherit",
                    outline: "none",
                    transition: "border-color 0.2s",
                  }}
                  onFocus={e => e.target.style.borderColor = "#6366f1"}
                  onBlur={e => e.target.style.borderColor = "rgba(99,102,241,0.2)"}
                />
              </div>
              <button onClick={() => setShowFilters(!showFilters)} style={{
                padding: "12px 16px",
                background: hasActiveFilters ? "rgba(99,102,241,0.2)" : "rgba(30,41,59,0.6)",
                border: `1px solid ${hasActiveFilters ? "#6366f1" : "rgba(99,102,241,0.2)"}`,
                borderRadius: "10px",
                color: hasActiveFilters ? "#a5b4fc" : "#94a3b8",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "13px",
                fontWeight: 600,
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}>
                <IconFilter />
                Filtros
                {hasActiveFilters && (
                  <span style={{
                    background: "#6366f1",
                    color: "#fff",
                    borderRadius: "50%",
                    width: "18px",
                    height: "18px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    fontWeight: 700,
                  }}>!</span>
                )}
              </button>
              <button onClick={fetchData} disabled={loading} title="Refrescar datos" style={{
                padding: "12px",
                background: "rgba(30,41,59,0.6)",
                border: "1px solid rgba(99,102,241,0.2)",
                borderRadius: "10px",
                color: "#94a3b8",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
              }}>
                <IconRefresh />
              </button>
            </div>

            {/* Filters panel */}
            {showFilters && (
              <div style={{
                padding: "16px 20px",
                background: "rgba(30,41,59,0.4)",
                borderRadius: "12px",
                border: "1px solid rgba(99,102,241,0.15)",
                marginBottom: "16px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "12px",
              }}>
                {/* Condición */}
                <div>
                  <label style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px", display: "block" }}>
                    Condición
                  </label>
                  <select value={filterCondicion} onChange={e => setFilterCondicion(e.target.value)} style={selectStyle}>
                    <option value="TODAS">Todas</option>
                    <option value="1NOMINA">1NOMINA (Crédito)</option>
                    <option value="2CONTADO">2CONTADO</option>
                  </select>
                </div>
                {/* Tipo */}
                <div>
                  <label style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px", display: "block" }}>
                    Tipo movimiento
                  </label>
                  <select value={filterTipo} onChange={e => setFilterTipo(e.target.value)} style={selectStyle}>
                    {uniqueTipos.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {/* Documento */}
                <div>
                  <label style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px", display: "block" }}>
                    Tipo documento
                  </label>
                  <select value={filterDocumento} onChange={e => setFilterDocumento(e.target.value)} style={selectStyle}>
                    {uniqueDocs.map(t => <option key={t} value={t}>{t === "TODOS" ? "Todos" : t}</option>)}
                  </select>
                </div>
                {/* Vencimiento desde */}
                <div>
                  <label style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px", display: "block" }}>
                    Vencimiento desde
                  </label>
                  <input type="date" value={filterVencDesde} onChange={e => setFilterVencDesde(e.target.value)} style={selectStyle} />
                </div>
                {/* Vencimiento hasta */}
                <div>
                  <label style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px", display: "block" }}>
                    Vencimiento hasta
                  </label>
                  <input type="date" value={filterVencHasta} onChange={e => setFilterVencHasta(e.target.value)} style={selectStyle} />
                </div>
                {/* Monto mín */}
                <div>
                  <label style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px", display: "block" }}>
                    Saldo mínimo ($)
                  </label>
                  <input type="number" value={filterMontoMin} onChange={e => setFilterMontoMin(e.target.value)} placeholder="0" style={selectStyle} />
                </div>
                {/* Monto máx */}
                <div>
                  <label style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px", display: "block" }}>
                    Saldo máximo ($)
                  </label>
                  <input type="number" value={filterMontoMax} onChange={e => setFilterMontoMax(e.target.value)} placeholder="Sin límite" style={selectStyle} />
                </div>
                {/* Clear */}
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <button onClick={clearFilters} style={{
                    padding: "10px 16px",
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    borderRadius: "8px",
                    color: "#f87171",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 600,
                    fontFamily: "inherit",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    width: "100%",
                    justifyContent: "center",
                  }}>
                    <IconX /> Limpiar filtros
                  </button>
                </div>
              </div>
            )}

            {/* Summary cards */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "12px",
              marginBottom: "16px",
            }}>
              {[
                { label: "Resultados", value: filtered.length.toLocaleString("es-CL"), color: "#6366f1" },
                { label: "Total Cargo", value: fmtShort(totals.cargo), color: "#ef4444" },
                { label: "Total Abono", value: fmtShort(totals.abono), color: "#22c55e" },
                { label: "Saldo Neto", value: fmtShort(totals.saldo), color: totals.saldo >= 0 ? "#f59e0b" : "#ec4899" },
              ].map((s, i) => (
                <div key={i} style={{
                  background: "rgba(30,41,59,0.6)",
                  borderRadius: "12px",
                  padding: "14px 16px",
                  border: `1px solid ${s.color}33`,
                }}>
                  <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {s.label}
                  </div>
                  <div style={{ fontSize: "20px", fontWeight: 700, color: s.color, marginTop: "2px", fontFamily: "'JetBrains Mono', monospace" }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Info bar */}
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "12px",
              color: "#64748b",
              marginBottom: "8px",
              padding: "0 4px",
            }}>
              <span>
                {loading ? "Cargando..." : `${filtered.length.toLocaleString("es-CL")} de ${searchData.length.toLocaleString("es-CL")} registros`}
              </span>
              {lastUpdate && <span>Última carga: {lastUpdate}</span>}
            </div>

            {/* Data table */}
            <div style={{
              background: "rgba(30,41,59,0.4)",
              borderRadius: "12px",
              border: "1px solid rgba(99,102,241,0.15)",
              overflow: "hidden",
            }}>
              <div style={{ overflowX: "auto", maxHeight: "65vh" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                    <tr>
                      {HEADERS.map((h, i) => (
                        <th key={i} onClick={() => handleSort(i)} style={{
                          padding: "10px 12px",
                          textAlign: [6, 7, 8].includes(i) ? "right" : "left",
                          fontWeight: 600,
                          color: sortCol === i ? "#a5b4fc" : "#94a3b8",
                          borderBottom: "1px solid rgba(99,102,241,0.15)",
                          whiteSpace: "nowrap",
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          cursor: "pointer",
                          userSelect: "none",
                          background: "rgba(15,23,42,0.95)",
                          position: "sticky",
                          top: 0,
                        }}>
                          {h}
                          {sortCol === i && (
                            <span style={{ marginLeft: "4px" }}>
                              {sortDir === "asc" ? "▲" : "▼"}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.length === 0 ? (
                      <tr>
                        <td colSpan={HEADERS.length} style={{
                          padding: "48px",
                          textAlign: "center",
                          color: "#64748b",
                          fontSize: "14px",
                        }}>
                          {searchData.length === 0
                            ? "Sin datos. Carga un archivo en la pestaña Carga primero."
                            : "No se encontraron resultados con los filtros actuales."}
                        </td>
                      </tr>
                    ) : (
                      sorted.slice(0, 500).map((row, ri) => (
                        <tr key={ri} style={{
                          background: ri % 2 === 0 ? "transparent" : "rgba(15,23,42,0.3)",
                          transition: "background 0.15s",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(99,102,241,0.08)"}
                        onMouseLeave={e => e.currentTarget.style.background = ri % 2 === 0 ? "transparent" : "rgba(15,23,42,0.3)"}
                        >
                          {row.map((cell, ci) => {
                            const isCondicion = ci === 0;
                            const isMoney = [6, 7, 8].includes(ci);
                            const isNeg = isMoney && Number(cell) < 0;
                            return (
                              <td key={ci} style={{
                                padding: "8px 12px",
                                borderBottom: "1px solid rgba(99,102,241,0.05)",
                                whiteSpace: "nowrap",
                                color: isCondicion
                                  ? (cell === "1NOMINA" ? "#22c55e" : "#f59e0b")
                                  : isNeg ? "#f87171" : isMoney ? "#e2e8f0" : "#cbd5e1",
                                fontFamily: isMoney ? "'JetBrains Mono', monospace" : "inherit",
                                fontWeight: isMoney ? 500 : 400,
                                textAlign: isMoney ? "right" : "left",
                                fontSize: isCondicion ? "11px" : "12px",
                              }}>
                                {isCondicion ? (
                                  <span style={{
                                    padding: "2px 8px",
                                    borderRadius: "4px",
                                    background: cell === "1NOMINA" ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.12)",
                                    border: `1px solid ${cell === "1NOMINA" ? "rgba(34,197,94,0.25)" : "rgba(245,158,11,0.25)"}`,
                                    fontWeight: 600,
                                  }}>
                                    {cell === "1NOMINA" ? "NÓMINA" : "CONTADO"}
                                  </span>
                                ) : isMoney ? fmt(cell) : cell}
                              </td>
                            );
                          })}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {sorted.length > 500 && (
                <div style={{
                  padding: "10px 16px",
                  textAlign: "center",
                  fontSize: "12px",
                  color: "#64748b",
                  borderTop: "1px solid rgba(99,102,241,0.1)",
                }}>
                  Mostrando 500 de {sorted.length.toLocaleString("es-CL")} resultados. Usa los filtros para acotar.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Spinner animation */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: rgba(15,23,42,0.5); }
        ::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.3); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.5); }
        select option { background: #1e293b; color: #e2e8f0; }
      `}</style>
    </div>
  );
}

const selectStyle = {
  width: "100%",
  padding: "10px 12px",
  background: "rgba(15,23,42,0.8)",
  border: "1px solid rgba(99,102,241,0.2)",
  borderRadius: "8px",
  color: "#e2e8f0",
  fontSize: "13px",
  fontFamily: "'DM Sans', system-ui, sans-serif",
  outline: "none",
};