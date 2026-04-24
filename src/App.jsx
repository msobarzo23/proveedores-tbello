import { useState, useEffect, useMemo, useCallback } from "react";
import CargaTab from "./components/CargaTab";
import InvoiceTable from "./components/InvoiceTable";
import { IconTruck, IconUpload, IconSearch, IconAlert, IconRefresh } from "./components/Icons";
import { loadAll, saveReview, getGasUrl, setGasUrl, resetGasUrl, DEFAULT_GAS_URL } from "./lib/gas";
import { groupDefontanaByInvoice } from "./lib/parsers";
import { buildCrossref, applyReviewState } from "./lib/crossref";
import { loadHistoricoCredito } from "./lib/historico";

export default function App() {
  const [tab, setTab] = useState("carga");
  const [showConfig, setShowConfig] = useState(false);
  const [gasUrlInput, setGasUrlInput] = useState(() => getGasUrl());

  const [defontana, setDefontana] = useState([]);
  const [oc, setOc] = useState([]);
  const [factcl, setFactcl] = useState([]);
  const [compra, setCompra] = useState([]);
  const [reviews, setReviews] = useState({});
  const [historicoCredito, setHistoricoCredito] = useState(new Set());
  const [historicoCount, setHistoricoCount] = useState(0);
  const [source, setSource] = useState("local");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async (conConciliacion = false) => {
    setLoading(true);
    setErr(null);
    try {
      const [r, h] = await Promise.all([loadAll(), loadHistoricoCredito()]);

      let updatedReviews = r.reviews || {};

      // Auto-conciliar: facturas en REVISAR que ya no están en el nuevo Defontana
      // se marcan REVISADA con nota "Conciliado". Solo corre al subir Defontana.
      if (conConciliacion && r.defontana && r.defontana.length > 0) {
        const keysNuevos = new Set(groupDefontanaByInvoice(r.defontana).map(inv => inv.key));
        const autoConciliadas = [];
        updatedReviews = { ...updatedReviews };
        for (const [key, rev] of Object.entries(updatedReviews)) {
          if (rev.estado === "REVISAR" && !keysNuevos.has(key)) {
            const notaPrevia = rev.nota || "";
            const nuevaNota = notaPrevia ? `${notaPrevia} · Conciliado` : "Conciliado";
            updatedReviews[key] = { estado: "REVISADA", nota: nuevaNota, updated_at: new Date().toISOString() };
            autoConciliadas.push({ key, nota: nuevaNota });
          }
        }
        if (autoConciliadas.length > 0) {
          Promise.all(autoConciliadas.map(({ key, nota }) => saveReview(key, "REVISADA", nota)))
            .catch(e => console.warn("Error guardando auto-conciliación:", e));
        }
      }

      setDefontana(r.defontana || []);
      setOc(r.oc || []);
      setFactcl(r.factcl || []);
      setCompra(r.compra || []);
      setReviews(updatedReviews);
      setSource(r.source);
      setHistoricoCredito(h.set);
      setHistoricoCount(h.count);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // ─── Procesamiento: agrupar + cruzar + aplicar estado de revisión ──
  const enrichedAll = useMemo(() => {
    if (!defontana.length) return [];
    const grouped = groupDefontanaByInvoice(defontana);
    const crossed = buildCrossref(grouped, oc, factcl, historicoCredito, compra);
    return applyReviewState(crossed, reviews);
  }, [defontana, oc, factcl, compra, reviews, historicoCredito]);

  // Principal: todo lo que no esté OK o REVISADA (es decir PENDIENTE + REVISAR)
  // La pestaña problemas los filtra aparte, así que aquí mostramos PENDIENTE.
  const principalRows = useMemo(
    () => enrichedAll.filter(r => r.estadoRev === "PENDIENTE"),
    [enrichedAll]
  );

  // Problemas: las que están marcadas REVISAR
  const problemasRows = useMemo(
    () => enrichedAll.filter(r => r.estadoRev === "REVISAR"),
    [enrichedAll]
  );

  const historicoRows = useMemo(
    () => enrichedAll.filter(r => r.estadoRev === "OK" || r.estadoRev === "REVISADA"),
    [enrichedAll]
  );

  const sospechosasCount = useMemo(
    () => principalRows.filter(r => r.sospechosa).length,
    [principalRows]
  );

  const handleMark = useCallback(async (row, estado) => {
    const nota = row.nota || "";
    setReviews(prev => ({
      ...prev,
      [row.key]: { estado, nota, updated_at: new Date().toISOString() },
    }));
    try {
      await saveReview(row.key, estado, nota);
    } catch (e) {
      console.error(e);
      setReviews(prev => {
        const next = { ...prev };
        delete next[row.key];
        return next;
      });
      alert("Error guardando: " + e.message);
    }
  }, []);

  const handleNote = useCallback(async (row, nota) => {
    setReviews(prev => ({
      ...prev,
      [row.key]: { ...prev[row.key], nota, updated_at: new Date().toISOString() },
    }));
    try {
      await saveReview(row.key, row.estadoRev, nota);
    } catch (e) {
      console.error("Error guardando nota:", e);
    }
  }, []);

  const saveGas = () => {
    setGasUrl(gasUrlInput);
    setShowConfig(false);
    refresh();
  };

  const resetGas = () => {
    resetGasUrl();
    setGasUrlInput(DEFAULT_GAS_URL);
    setShowConfig(false);
    refresh();
  };

  const tabs = [
    { id: "carga", label: "Carga", icon: <IconUpload /> },
    { id: "principal", label: "Principal", icon: <IconSearch />, count: principalRows.length, alert: sospechosasCount },
    { id: "problemas", label: "Problemas", icon: <IconAlert />, count: problemasRows.length, color: problemasRows.length > 0 ? "#ef4444" : null },
    { id: "historico", label: "Histórico", icon: <IconRefresh />, count: historicoRows.length },
  ];

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
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            borderRadius: 10,
            padding: 8,
            display: "flex",
          }}>
            <IconTruck />
          </div>
          <div>
            <div style={{
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              background: "linear-gradient(135deg, #e2e8f0, #94a3b8)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}>
              PROVEEDORES TBELLO
            </div>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.05em", textTransform: "uppercase" }}>
              Auditoría de facturas · Defontana × OC × Fact.cl
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            display: "flex",
            background: "rgba(30,41,59,0.8)",
            borderRadius: 10,
            padding: 3,
            border: "1px solid rgba(99,102,241,0.15)",
          }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 14px",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                transition: "all 0.2s",
                background: tab === t.id
                  ? "linear-gradient(135deg, #6366f1, #7c3aed)"
                  : "transparent",
                color: tab === t.id ? "#fff" : "#94a3b8",
              }}>
                {t.icon}
                {t.label}
                {t.count != null && (
                  <span style={{
                    background: t.color || "rgba(148,163,184,0.25)",
                    color: "#fff",
                    borderRadius: 10,
                    padding: "1px 7px",
                    fontSize: 10,
                    fontWeight: 700,
                    minWidth: 18,
                    textAlign: "center",
                  }}>
                    {t.count.toLocaleString("es-CL")}
                  </span>
                )}
                {t.alert > 0 && tab !== t.id && (
                  <span title={`${t.alert} sospechosas`} style={{
                    background: "#ef4444",
                    color: "#fff",
                    borderRadius: "50%",
                    width: 8,
                    height: 8,
                  }} />
                )}
              </button>
            ))}
          </div>

          <button onClick={() => setShowConfig(!showConfig)} style={{
            background: "rgba(30,41,59,0.8)",
            border: "1px solid rgba(99,102,241,0.15)",
            borderRadius: 8,
            padding: 8,
            cursor: "pointer",
            color: "#94a3b8",
            fontSize: 14,
          }}>⚙️</button>

          <button onClick={refresh} title="Refrescar" style={{
            background: "rgba(30,41,59,0.8)",
            border: "1px solid rgba(99,102,241,0.15)",
            borderRadius: 8,
            padding: 8,
            cursor: "pointer",
            color: "#94a3b8",
            display: "flex",
          }}>
            <IconRefresh />
          </button>
        </div>
      </div>

      {/* Banner de fuente + advertencia */}
      <div style={{
        padding: "8px 24px",
        background: source === "gas" ? "rgba(34,197,94,0.06)" : "rgba(245,158,11,0.06)",
        borderBottom: `1px solid ${source === "gas" ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)"}`,
        fontSize: 11,
        color: source === "gas" ? "#86efac" : "#fbbf24",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span>
          {source === "gas" ? "🟢 Sincronizado con Google Sheet" : "🟡 Modo local (navegador) · configura Google Sheet en ⚙️ para sincronizar"}
          {historicoCount > 0 && (
            <span style={{ marginLeft: 12, color: "#94a3b8" }}>
              · Histórico crédito: {historicoCount.toLocaleString("es-CL")} proveedores
            </span>
          )}
        </span>
        {sospechosasCount > 0 && (
          <span style={{ color: "#f87171", fontWeight: 600 }}>
            ⚠️ {sospechosasCount} factura{sospechosasCount === 1 ? "" : "s"} sospechosa{sospechosasCount === 1 ? "" : "s"} (contado con OC asociada)
          </span>
        )}
      </div>

      {/* Config panel */}
      {showConfig && (
        <div style={{
          margin: "14px 24px 0",
          padding: "14px 18px",
          background: "rgba(30,41,59,0.6)",
          borderRadius: 12,
          border: "1px solid rgba(99,102,241,0.2)",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "#94a3b8" }}>
            URL Google Apps Script (Web App) — opcional
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={gasUrlInput}
              onChange={e => setGasUrlInput(e.target.value)}
              placeholder="https://script.google.com/macros/s/.../exec"
              style={{
                flex: 1,
                padding: "10px 12px",
                background: "rgba(15,23,42,0.8)",
                border: "1px solid rgba(99,102,241,0.2)",
                borderRadius: 8,
                color: "#e2e8f0",
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                outline: "none",
              }}
            />
            <button onClick={saveGas} style={{
              padding: "10px 16px",
              background: "linear-gradient(135deg, #6366f1, #7c3aed)",
              border: "none",
              borderRadius: 8,
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 13,
              fontFamily: "inherit",
            }}>Guardar</button>
            <button onClick={resetGas} title="Volver a la URL por defecto" style={{
              padding: "10px 14px",
              background: "rgba(148,163,184,0.15)",
              border: "1px solid rgba(148,163,184,0.25)",
              borderRadius: 8,
              color: "#cbd5e1",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 12,
              fontFamily: "inherit",
            }}>Usar default</button>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
            Si queda vacío, se usa la URL por defecto (Sheet compartido del equipo).
          </div>
        </div>
      )}

      {err && (
        <div style={{
          margin: "14px 24px 0",
          padding: "10px 14px",
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 10,
          color: "#f87171",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <IconAlert /> {err}
        </div>
      )}

      {/* Contenido */}
      <div style={{ padding: 24, maxWidth: 1600, margin: "0 auto" }}>
        {tab === "carga" && <CargaTab onDataChanged={refresh} />}
        {tab === "principal" && (
          <InvoiceTable rows={principalRows} onMark={handleMark} />
        )}
        {tab === "problemas" && (
          <>
            {problemasRows.length === 0 && (
              <div style={{
                padding: "40px",
                textAlign: "center",
                background: "rgba(30,41,59,0.4)",
                borderRadius: 12,
                border: "1px solid rgba(99,102,241,0.15)",
                color: "#64748b",
              }}>
                Sin facturas marcadas para revisar.
              </div>
            )}
            {problemasRows.length > 0 && (
              <InvoiceTable rows={problemasRows} onMark={handleMark} onNote={handleNote} showProblems />
            )}
          </>
        )}
        {tab === "historico" && (
          <>
            <div style={{ marginBottom: 12, fontSize: 12, color: "#64748b" }}>
              Facturas ya procesadas (OK o REVISADA). Se ocultan del listado principal.
            </div>
            <InvoiceTable rows={historicoRows} onMark={handleMark} onNote={handleNote} showNotes />
          </>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
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
