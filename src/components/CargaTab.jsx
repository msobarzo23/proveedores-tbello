import { useState, useEffect } from "react";
import FileDrop from "./FileDrop";
import { parseDefontana, parseReporteOC, parseReferenciaFactCL, parseInformeCompraFactCL } from "../lib/parsers";
import {
  saveDefontana, saveOC, saveFactCL, saveInformeCompra,
  getTimestamps, getPendingDatasets, retryPendingDatasets,
} from "../lib/gas";
import { IconCheck, IconAlert, IconRefresh } from "./Icons";

const DATASET_LABELS = {
  defontana: "Defontana",
  oc: "Reporte OC",
  factcl: "Referencia Fact.cl",
  compra: "Informe de Compra",
};

export default function CargaTab({ onDataChanged }) {
  const [pending, setPending] = useState({ defontana: null, oc: null, factcl: null, compra: null });
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null); // { dataset, batch, batches, rows, total }
  const [result, setResult] = useState(null);
  const [stamps, setStamps] = useState(() => getTimestamps());
  const [pendingDatasets, setPendingDatasets] = useState(() => getPendingDatasets());
  const [retrying, setRetrying] = useState(false);

  // Refrescar lista de pendientes (en caso de cambios desde otra pestaña).
  useEffect(() => {
    const id = setInterval(() => setPendingDatasets(getPendingDatasets()), 2000);
    return () => clearInterval(id);
  }, []);

  const handleParsed = (key) => (rows) => {
    setPending(p => ({ ...p, [key]: rows }));
    setResult(null);
  };

  // Guardado SECUENCIAL: evita saturar a GAS con muchos POSTs concurrentes
  // (era la causa del "Failed to fetch" intermitente en archivos grandes
  // como Fact.cl). Cada dataset reporta progreso por batch.
  const handleSaveAll = async () => {
    setUploading(true);
    setResult(null);
    setProgress(null);
    const out = [];
    const errors = [];
    const warnings = [];

    const datasets = [
      ["defontana", pending.defontana, saveDefontana],
      ["oc",        pending.oc,        saveOC],
      ["factcl",    pending.factcl,    saveFactCL],
      ["compra",    pending.compra,    saveInformeCompra],
    ];

    const anyPending = datasets.some(([, rows]) => !!rows);
    if (!anyPending) {
      setResult({ ok: false, msg: "Carga al menos un archivo antes de guardar." });
      setUploading(false);
      return;
    }

    for (const [name, rows, fn] of datasets) {
      if (!rows) continue;
      setProgress({ dataset: name, batch: 0, batches: 0, rows: 0, total: rows.length });
      try {
        const r = await fn(rows, (p) => setProgress(p));
        out.push([name, r]);
        if (r.warning) warnings.push(`${DATASET_LABELS[name]}: ${r.warning}`);
      } catch (e) {
        errors.push(`${DATASET_LABELS[name]}: ${e.message}`);
      }
    }

    setProgress(null);
    setStamps(getTimestamps());
    setPendingDatasets(getPendingDatasets());

    if (errors.length && !out.length) {
      setResult({ ok: false, msg: errors.join(" · ") });
    } else {
      const msgs = out.map(([name, r]) => `${DATASET_LABELS[name]}: ${r.count.toLocaleString("es-CL")} filas (${r.source})`).join(" · ");
      const allOk = !warnings.length && !errors.length;
      setResult({
        ok: allOk,
        msg: msgs
          + (warnings.length ? ` · ⚠️ ${warnings.join(", ")}` : "")
          + (errors.length ? ` · ❌ ${errors.join(", ")}` : ""),
      });
    }

    setUploading(false);
    onDataChanged?.(!!pending.defontana);
  };

  const handleRetryPending = async () => {
    setRetrying(true);
    setResult(null);
    setProgress(null);
    try {
      const results = await retryPendingDatasets((dataset, p) => setProgress(p));
      const warnings = [];
      const successes = [];
      for (const [dataset, r] of Object.entries(results)) {
        if (r.skipped) continue;
        if (r.warning) warnings.push(`${DATASET_LABELS[dataset]}: ${r.warning}`);
        else if (r.source === "gas") successes.push(`${DATASET_LABELS[dataset]}: ${r.count.toLocaleString("es-CL")} filas`);
      }
      setStamps(getTimestamps());
      setPendingDatasets(getPendingDatasets());
      if (successes.length && !warnings.length) {
        setResult({ ok: true, msg: "Sincronizado con GAS · " + successes.join(" · ") });
      } else if (warnings.length) {
        setResult({ ok: false, msg: "Aún hay datasets sin sincronizar: " + warnings.join(", ") });
      } else {
        setResult({ ok: true, msg: "Nada pendiente que reintentar." });
      }
      onDataChanged?.(false);
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setProgress(null);
      setRetrying(false);
    }
  };

  const anyPending = pending.defontana || pending.oc || pending.factcl || pending.compra;
  const busy = uploading || retrying;

  return (
    <div>
      <div style={{
        marginBottom: 20,
        padding: "14px 18px",
        background: "rgba(99,102,241,0.08)",
        border: "1px solid rgba(99,102,241,0.2)",
        borderRadius: 12,
        fontSize: 13,
        color: "#cbd5e1",
        lineHeight: 1.6,
      }}>
        <strong style={{ color: "#a5b4fc" }}>Flujo:</strong> carga los 4 archivos y pulsa <em>Guardar todo</em>.
        El sistema cruza Defontana (facturas) con <em>Referencia Fact.cl</em> (link a OC),
        <em> Informe de Compra</em> (fecha real de emisión SII) y Reporte OC (TMS). Detecta
        facturas <strong style={{ color: "#f87171" }}>CONTADO con OC asociada</strong>,
        <strong style={{ color: "#f87171" }}> NÓMINA con plazo &lt; 28 días</strong> y
        <strong style={{ color: "#f87171" }}> ingresadas tarde a contabilidad (&gt; 8 días post-emisión)</strong>.
      </div>

      {/* Banner: datasets que quedaron sólo en local (GAS falló) */}
      {pendingDatasets.length > 0 && !busy && (
        <div style={{
          marginBottom: 16,
          padding: "12px 16px",
          background: "rgba(245,158,11,0.1)",
          border: "1px solid rgba(245,158,11,0.3)",
          borderRadius: 10,
          color: "#fbbf24",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <span>
            ⚠️ Hay {pendingDatasets.length} {pendingDatasets.length === 1 ? "archivo guardado" : "archivos guardados"} sólo localmente
            que no llegaron a Google Sheet: <strong>{pendingDatasets.map(d => DATASET_LABELS[d]).join(", ")}</strong>.
            Los datos están seguros en este navegador, pero no son visibles para otros usuarios hasta que se reintenten.
          </span>
          <button
            onClick={handleRetryPending}
            disabled={busy}
            style={{
              padding: "8px 14px",
              background: "linear-gradient(135deg, #f59e0b, #d97706)",
              border: "none",
              borderRadius: 8,
              color: "#fff",
              cursor: busy ? "not-allowed" : "pointer",
              fontWeight: 600,
              fontSize: 12,
              fontFamily: "inherit",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <IconRefresh /> Reintentar sincronización
          </button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginBottom: 20 }}>
        <FileDrop
          label="1. DEFONTANA"
          description="Informe por Análisis · fuente principal"
          parser={parseDefontana}
          accent="#6366f1"
          onFileParsed={handleParsed("defontana")}
        />
        <FileDrop
          label="2. REPORTE OC"
          description="Ordenes de compra · TMS (.xls)"
          parser={parseReporteOC}
          accent="#22c55e"
          onFileParsed={handleParsed("oc")}
        />
        <FileDrop
          label="3. REFERENCIA FACT.CL"
          description="Detalle referencia compra · sólo para enlazar con OC"
          parser={parseReferenciaFactCL}
          accent="#ec4899"
          onFileParsed={handleParsed("factcl")}
        />
        <FileDrop
          label="4. INFORME DE COMPRA"
          description="Informe por análisis · fecha real de emisión SII (col Z)"
          parser={parseInformeCompraFactCL}
          accent="#f59e0b"
          onFileParsed={handleParsed("compra")}
        />
      </div>

      {/* Stamps de última carga */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: 10,
        marginBottom: 16,
        fontSize: 12,
        color: "#64748b",
      }}>
        {[
          ["defontana", "Defontana"],
          ["oc", "Reporte OC"],
          ["factcl", "Referencia Fact.cl"],
          ["compra", "Informe de Compra"],
        ].map(([k, name]) => {
          const isPending = pendingDatasets.includes(k);
          return (
            <div key={k} style={{
              padding: 10,
              background: "rgba(15,23,42,0.4)",
              borderRadius: 8,
              border: isPending ? "1px solid rgba(245,158,11,0.4)" : "1px solid transparent",
            }}>
              <div style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: isPending ? "#fbbf24" : "#475569",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}>
                {name}
                {isPending && <span title="No sincronizado con Google Sheet">⚠️</span>}
              </div>
              <div style={{ color: stamps[k] ? (isPending ? "#fbbf24" : "#cbd5e1") : "#475569", marginTop: 2 }}>
                {stamps[k] ? new Date(stamps[k]).toLocaleString("es-CL") : "Nunca cargado"}
                {isPending && <span style={{ fontSize: 10, marginLeft: 6, color: "#fbbf24" }}>(sólo local)</span>}
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={handleSaveAll}
        disabled={busy || !anyPending}
        style={{
          width: "100%",
          padding: 14,
          border: "none",
          borderRadius: 12,
          background: (busy || !anyPending) ? "rgba(99,102,241,0.3)" : "linear-gradient(135deg, #6366f1, #7c3aed)",
          color: "#fff",
          fontSize: 15,
          fontWeight: 700,
          fontFamily: "inherit",
          cursor: (busy || !anyPending) ? "not-allowed" : "pointer",
          boxShadow: (busy || !anyPending) ? "none" : "0 4px 15px rgba(99,102,241,0.3)",
        }}
      >
        {uploading
          ? "Guardando..."
          : retrying
            ? "Reintentando..."
            : `Guardar ${[
                pending.defontana && "Defontana",
                pending.oc && "OC",
                pending.factcl && "Referencia",
                pending.compra && "Compra",
              ].filter(Boolean).join(" + ") || "todo"}`}
      </button>

      {/* Progress bar — visible cuando hay un guardado en curso */}
      {progress && (
        <div style={{
          marginTop: 12,
          padding: "10px 14px",
          background: "rgba(15,23,42,0.6)",
          border: "1px solid rgba(99,102,241,0.25)",
          borderRadius: 10,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#cbd5e1", marginBottom: 6 }}>
            <span>
              <strong style={{ color: "#a5b4fc" }}>{DATASET_LABELS[progress.dataset]}</strong>
              {progress.batches > 0 && (
                <span style={{ color: "#64748b" }}>
                  {" "}· batch {progress.batch} / {progress.batches}
                </span>
              )}
            </span>
            <span style={{ color: "#64748b" }}>
              {progress.rows.toLocaleString("es-CL")} / {progress.total.toLocaleString("es-CL")} filas
            </span>
          </div>
          <div style={{
            height: 6,
            background: "rgba(99,102,241,0.15)",
            borderRadius: 3,
            overflow: "hidden",
          }}>
            <div style={{
              height: "100%",
              width: progress.total > 0 ? `${Math.min(100, (progress.rows / progress.total) * 100)}%` : "0%",
              background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
              transition: "width 0.3s",
            }} />
          </div>
        </div>
      )}

      {result && (
        <div style={{
          marginTop: 14,
          padding: "12px 16px",
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: result.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
          border: `1px solid ${result.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
          color: result.ok ? "#22c55e" : "#f87171",
          fontSize: 13,
        }}>
          {result.ok ? <IconCheck /> : <IconAlert />}
          <div style={{ flex: 1 }}>{result.msg}</div>
        </div>
      )}
    </div>
  );
}
