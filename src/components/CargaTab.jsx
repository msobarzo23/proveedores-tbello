import { useState } from "react";
import FileDrop from "./FileDrop";
import { parseDefontana, parseReporteOC, parseReferenciaFactCL } from "../lib/parsers";
import { saveDefontana, saveOC, saveFactCL, getTimestamps } from "../lib/gas";
import { IconCheck, IconAlert, IconRefresh } from "./Icons";

export default function CargaTab({ onDataChanged }) {
  const [pending, setPending] = useState({ defontana: null, oc: null, factcl: null });
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [stamps, setStamps] = useState(() => getTimestamps());

  const handleParsed = (key) => (rows) => {
    setPending(p => ({ ...p, [key]: rows }));
    setResult(null);
  };

  const handleSaveAll = async () => {
    setUploading(true);
    setResult(null);
    try {
      const tasks = [];
      if (pending.defontana) tasks.push(saveDefontana(pending.defontana).then(r => ["Defontana", r]));
      if (pending.oc)        tasks.push(saveOC(pending.oc).then(r => ["Reporte OC", r]));
      if (pending.factcl)    tasks.push(saveFactCL(pending.factcl).then(r => ["Referencia Fact.cl", r]));
      if (!tasks.length) {
        setResult({ ok: false, msg: "Carga al menos un archivo antes de guardar." });
        return;
      }
      const out = await Promise.all(tasks);
      const msgs = out.map(([name, r]) => `${name}: ${r.count} filas (${r.source})`).join(" · ");
      const warns = out.map(([n, r]) => r.warning ? `${n}: ${r.warning}` : null).filter(Boolean);
      setResult({
        ok: true,
        msg: msgs + (warns.length ? ` · ⚠️ ${warns.join(", ")}` : ""),
      });
      setStamps(getTimestamps());
      onDataChanged?.(!!pending.defontana);
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setUploading(false);
    }
  };

  const anyPending = pending.defontana || pending.oc || pending.factcl;

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
        <strong style={{ color: "#a5b4fc" }}>Flujo:</strong> carga los 3 archivos y pulsa <em>Guardar todo</em>.
        El sistema cruza Defontana (facturas) con Fact.cl (referencia a OC) y Reporte OC (TMS)
        para detectar facturas <strong style={{ color: "#f87171" }}>ingresadas al CONTADO</strong> que
        tengan OC asociada (deberían ser NÓMINA).
      </div>

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
          description="Detalle referencia compra · Facturación.cl"
          parser={parseReferenciaFactCL}
          accent="#ec4899"
          onFileParsed={handleParsed("factcl")}
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
        ].map(([k, name]) => (
          <div key={k} style={{ padding: 10, background: "rgba(15,23,42,0.4)", borderRadius: 8 }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#475569" }}>{name}</div>
            <div style={{ color: stamps[k] ? "#cbd5e1" : "#475569", marginTop: 2 }}>
              {stamps[k] ? new Date(stamps[k]).toLocaleString("es-CL") : "Nunca cargado"}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={handleSaveAll}
        disabled={uploading || !anyPending}
        style={{
          width: "100%",
          padding: 14,
          border: "none",
          borderRadius: 12,
          background: (uploading || !anyPending) ? "rgba(99,102,241,0.3)" : "linear-gradient(135deg, #6366f1, #7c3aed)",
          color: "#fff",
          fontSize: 15,
          fontWeight: 700,
          fontFamily: "inherit",
          cursor: (uploading || !anyPending) ? "not-allowed" : "pointer",
          boxShadow: (uploading || !anyPending) ? "none" : "0 4px 15px rgba(99,102,241,0.3)",
        }}
      >
        {uploading ? "Guardando..." : `Guardar ${[
          pending.defontana && "Defontana",
          pending.oc && "OC",
          pending.factcl && "Fact.cl",
        ].filter(Boolean).join(" + ") || "todo"}`}
      </button>

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
          {result.msg}
        </div>
      )}
    </div>
  );
}
