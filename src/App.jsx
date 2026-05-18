import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import CargaTab from "./components/CargaTab";
import InvoiceTable from "./components/InvoiceTable";
import FantasmaTable from "./components/FantasmaTable";
import { IconTruck, IconUpload, IconSearch, IconAlert, IconRefresh } from "./components/Icons";
import { loadAll, saveReview, getGasUrl, setGasUrl, resetGasUrl, DEFAULT_GAS_URL, forceSyncPendingReviews } from "./lib/gas";
import { groupDefontanaByInvoice } from "./lib/parsers";
import { buildCrossref, applyReviewState, findFactCLSinDefontana } from "./lib/crossref";
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

  // Pendientes de sincronizar al Google Sheet (reviews que están en local pero
  // no llegaron al Sheet). Se calcula en cada loadAll comparando contra GAS.
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null); // { done, total, failed } | null
  const [syncResult, setSyncResult] = useState(null); // { done, total, failed } | null

  // Ref con el último enrichedAll, para poder snapshotear datos de filas que
  // están a punto de desaparecer del nuevo Defontana al auto-conciliar.
  const enrichedRef = useRef([]);

  const refresh = useCallback(async (conConciliacion = false) => {
    setLoading(true);
    setErr(null);
    try {
      const [r, h] = await Promise.all([loadAll(), loadHistoricoCredito()]);

      let updatedReviews = r.reviews || {};

      // Auto-conciliar: facturas en REVISAR que ya no aplican se marcan REVISADA
      // con nota "Conciliado". Hay dos clases de keys con lógica distinta:
      //   - Defontana (sin prefijo): se concilia si la factura ya no aparece
      //     en el nuevo Defontana (resuelta por contabilidad).
      //   - Fantasma (prefijo FCL|): se concilia si la factura SÍ apareció
      //     en el nuevo Defontana — es decir, ya no es fantasma.
      // Solo corre al subir Defontana.
      if (conConciliacion && r.defontana && r.defontana.length > 0) {
        const grouped = groupDefontanaByInvoice(r.defontana);
        const keysNuevos = new Set(grouped.map(inv => inv.key));
        // Índice por rut|folio: si el nuevo Defontana trae la misma factura
        // pero con un tipoDoc levemente distinto, NO debe contar como "salió"
        // del Defontana — sigue ahí, sólo con otra etiqueta.
        const rutFolioNuevos = new Set(grouped.map(inv => `${inv.rut}|${inv.folio}`));
        const fantasmaKeysNuevos = new Set(
          findFactCLSinDefontana(grouped, r.compra || [], r.factcl || []).map(f => f.key)
        );
        const previousByKey = new Map(enrichedRef.current.map(row => [row.key, row]));
        const autoConciliadas = [];
        updatedReviews = { ...updatedReviews };
        for (const [key, rev] of Object.entries(updatedReviews)) {
          if (rev.estado !== "REVISAR") continue;
          const esFantasma = key.startsWith("FCL|");
          const parts = String(key).split("|");
          const rutFolio = parts.length >= 2 ? `${parts[0]}|${parts[1]}` : "";
          const yaNoAplica = esFantasma
            ? !fantasmaKeysNuevos.has(key)   // apareció en Defontana
            : (!keysNuevos.has(key) && !rutFolioNuevos.has(rutFolio));
          if (!yaNoAplica) continue;
          const notaPrevia = rev.nota || "";
          const nuevaNota = notaPrevia ? `${notaPrevia} · Conciliado` : "Conciliado";
          const previous = previousByKey.get(key);
          const snapshot = (previous ? snapshotFromRow(previous) : null) || rev.snapshot || null;
          updatedReviews[key] = {
            ...rev,
            estado: "REVISADA",
            nota: nuevaNota,
            updated_at: new Date().toISOString(),
            snapshot,
          };
          autoConciliadas.push({ key, nota: nuevaNota, snapshot });
        }
        if (autoConciliadas.length > 0) {
          Promise.all(
            autoConciliadas.map(({ key, nota, snapshot }) => saveReview(key, "REVISADA", nota, snapshot))
          ).catch(e => console.warn("Error guardando auto-conciliación:", e));
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
      setPendingSyncCount(r.pendingSyncCount || 0);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Extrae los campos persistibles de una fila enriquecida.
  function snapshotFromRow(row) {
    if (!row) return null;
    return {
      rut: row.rut, rutRaw: row.rutRaw,
      folio: row.folio, folioRaw: row.folioRaw,
      tipoDoc: row.tipoDoc,
      proveedor: row.proveedor,
      condicion: row.condicion,
      fechaFactura: row.fechaFactura,
      vencimiento: row.vencimiento,
      vencimientos: row.vencimientos,
      cargoTotal: row.cargoTotal,
      abonoTotal: row.abonoTotal,
      saldo: row.saldo,
      pagada: row.pagada,
      nReferencia: row.nReferencia,
      ocFormapago: row.ocFormapago,
    };
  }

  useEffect(() => { refresh(); }, [refresh]);

  // ─── Procesamiento: agrupar + cruzar + aplicar estado de revisión ──
  // Incluye filas "fantasma" para reviews OK/REVISADA cuya factura ya no está
  // en el Defontana actual (auto-conciliadas o eliminadas). Si la review tiene
  // snapshot, se usa para llenar proveedor/vencimiento/montos; igual pasa por
  // buildCrossref para que Fact.cl/Informe de Compra rellenen lo que puedan.
  const enrichedAll = useMemo(() => {
    const grouped = groupDefontanaByInvoice(defontana);
    const realKeys = new Set(grouped.map(g => g.key));
    // Si la review apunta a la misma factura que ya está en el Defontana
    // actual (mismo rut+folio aunque difiera tipoDoc), no la inyectamos como
    // phantom — applyReviewState va a recuperar el estado por el fallback
    // rut|folio. Evitamos duplicar filas.
    const realRutFolio = new Set(grouped.map(g => `${g.rut}|${g.folio}`));
    const phantoms = [];
    for (const [key, rev] of Object.entries(reviews || {})) {
      // Las reviews con prefijo FCL| pertenecen a la pestaña "Sin registro";
      // no las re-inyectamos al listado principal como phantoms.
      if (key.startsWith("FCL|")) continue;
      if (realKeys.has(key)) continue;
      const parts = String(key).split("|");
      if (parts.length >= 2 && realRutFolio.has(`${parts[0]}|${parts[1]}`)) continue;
      if (rev.estado !== "OK" && rev.estado !== "REVISADA") continue;
      const [rut = "", folio = "", tipoDoc = ""] = key.split("|");
      const s = rev.snapshot || {};
      phantoms.push({
        key,
        rut: s.rut || rut,
        rutRaw: s.rutRaw || rut,
        folio: s.folio || folio,
        folioRaw: s.folioRaw || folio,
        tipoDoc: s.tipoDoc || tipoDoc,
        proveedor: s.proveedor || "",
        condicion: s.condicion || "",
        fechaFactura: s.fechaFactura || "",
        vencimiento: s.vencimiento || "",
        vencimientos: s.vencimientos || [],
        cargoTotal: s.cargoTotal || 0,
        abonoTotal: s.abonoTotal || 0,
        saldo: s.saldo || 0,
        movimientos: 0,
        tieneCompra: false,
        tieneEgreso: false,
        pagada: s.pagada ?? true,
        soloEnReviews: true,
      });
    }
    if (!grouped.length && !phantoms.length) return [];
    const crossed = buildCrossref([...grouped, ...phantoms], oc, factcl, historicoCredito, compra);
    return applyReviewState(crossed, reviews);
  }, [defontana, oc, factcl, compra, reviews, historicoCredito]);

  // Mantener ref en sync para el auto-conciliador de refresh.
  useEffect(() => { enrichedRef.current = enrichedAll; }, [enrichedAll]);

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

  // Fantasmas: aceptadas en SII (Fact.cl) que no están en Defontana.
  // Usan keys con prefijo "FCL|" para no chocar con las reviews del flujo principal.
  const fantasmaAll = useMemo(() => {
    const grouped = groupDefontanaByInvoice(defontana);
    const raw = findFactCLSinDefontana(grouped, compra, factcl);
    return applyReviewState(raw, reviews);
  }, [defontana, compra, factcl, reviews]);

  const fantasmaPendientes = useMemo(
    () => fantasmaAll.filter(r => r.estadoRev === "PENDIENTE" || r.estadoRev === "REVISAR"),
    [fantasmaAll]
  );

  const sospechosasCount = useMemo(
    () => principalRows.filter(r => r.sospechosa).length,
    [principalRows]
  );

  const handleMark = useCallback(async (row, estado) => {
    const nota = row.nota || "";
    // Si la fila no es fantasma, capturamos snapshot fresco para preservar
    // proveedor/vencimiento/montos cuando la factura desaparezca de Defontana.
    const snapshot = row.soloEnReviews ? null : snapshotFromRow(row);
    setReviews(prev => ({
      ...prev,
      [row.key]: { estado, nota, updated_at: new Date().toISOString(), snapshot: snapshot || prev[row.key]?.snapshot || null },
    }));
    try {
      await saveReview(row.key, estado, nota, snapshot);
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
    const snapshot = row.soloEnReviews ? null : snapshotFromRow(row);
    setReviews(prev => ({
      ...prev,
      [row.key]: { ...prev[row.key], nota, updated_at: new Date().toISOString(), snapshot: snapshot || prev[row.key]?.snapshot || null },
    }));
    try {
      await saveReview(row.key, row.estadoRev, nota, snapshot);
    } catch (e) {
      console.error("Error guardando nota:", e);
    }
  }, []);

  // Dispara la sincronización manual de reviews pendientes. Re-fetchea GAS,
  // calcula qué falta, y las sube una por una mostrando progreso. Al terminar,
  // refresca para que el conteo y el estado queden coherentes.
  const handleForceSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncProgress({ done: 0, total: pendingSyncCount, failed: 0 });
    setSyncResult(null);
    try {
      const r = await forceSyncPendingReviews((p) => setSyncProgress(p));
      if (r.ok) {
        setSyncResult({ done: r.done, total: r.total, failed: r.failed });
      } else {
        setSyncResult({ done: 0, total: 0, failed: 0, error: r.error || "Error desconocido" });
      }
    } catch (e) {
      setSyncResult({ done: 0, total: 0, failed: 0, error: e.message });
    } finally {
      setSyncing(false);
      setSyncProgress(null);
      // Refrescar para recalcular pendientes desde GAS.
      refresh();
      // Limpiar el banner de resultado a los 8s.
      setTimeout(() => setSyncResult(null), 8000);
    }
  }, [syncing, pendingSyncCount, refresh]);

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
    { id: "fantasmas", label: "Sin registro", icon: <IconAlert />, count: fantasmaPendientes.length, color: fantasmaPendientes.length > 0 ? "#ef4444" : null },
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
          {source === "gas"
            ? "🟢 Sincronizado con Google Sheet"
            : source === "gas+pending"
              ? "🟡 Conectado a Google Sheet · hay archivos pendientes de sincronizar (ve a Carga → Reintentar)"
              : "🟡 Modo local (navegador) · configura Google Sheet en ⚙️ para sincronizar"}
          {historicoCount > 0 && (
            <span style={{ marginLeft: 12, color: "#94a3b8" }}>
              · Histórico crédito: {historicoCount.toLocaleString("es-CL")} proveedores
            </span>
          )}
        </span>
        <span style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {sospechosasCount > 0 && (
            <span style={{ color: "#f87171", fontWeight: 600 }}>
              ⚠️ {sospechosasCount} sospechosa{sospechosasCount === 1 ? "" : "s"} (contado con OC)
            </span>
          )}
          {fantasmaPendientes.length > 0 && (
            <span style={{ color: "#f87171", fontWeight: 600 }}>
              ⚠️ {fantasmaPendientes.length} sin registro Defontana
            </span>
          )}
        </span>
      </div>

      {/* Banner de sincronización pendiente */}
      {(pendingSyncCount > 0 || syncing || syncResult) && (
        <div style={{
          padding: "8px 24px",
          background: syncResult && !syncResult.failed && !syncResult.error
            ? "rgba(34,197,94,0.08)"
            : syncResult && (syncResult.failed || syncResult.error)
              ? "rgba(239,68,68,0.08)"
              : "rgba(249,115,22,0.08)",
          borderBottom: `1px solid ${
            syncResult && !syncResult.failed && !syncResult.error
              ? "rgba(34,197,94,0.2)"
              : syncResult && (syncResult.failed || syncResult.error)
                ? "rgba(239,68,68,0.2)"
                : "rgba(249,115,22,0.2)"
          }`,
          fontSize: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            {syncing ? (
              <>
                <span style={{
                  display: "inline-block",
                  width: 12, height: 12,
                  border: "2px solid rgba(249,115,22,0.3)",
                  borderTopColor: "#fb923c",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }} />
                <span style={{ color: "#fdba74", fontWeight: 600 }}>
                  Sincronizando con Google Sheet…{" "}
                  {syncProgress && (
                    <span style={{ color: "#fed7aa", fontWeight: 500 }}>
                      {syncProgress.done.toLocaleString("es-CL")} / {syncProgress.total.toLocaleString("es-CL")}
                      {syncProgress.failed > 0 && (
                        <span style={{ color: "#f87171", marginLeft: 6 }}>
                          ({syncProgress.failed} con error)
                        </span>
                      )}
                    </span>
                  )}
                </span>
                {syncProgress && syncProgress.total > 0 && (
                  <div style={{
                    flex: 1,
                    height: 6,
                    maxWidth: 320,
                    background: "rgba(249,115,22,0.15)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}>
                    <div style={{
                      width: `${Math.min(100, (syncProgress.done / syncProgress.total) * 100)}%`,
                      height: "100%",
                      background: "linear-gradient(90deg, #fb923c, #f97316)",
                      transition: "width 0.2s",
                    }} />
                  </div>
                )}
              </>
            ) : syncResult ? (
              syncResult.error ? (
                <span style={{ color: "#f87171", fontWeight: 600 }}>
                  ⚠️ Error al sincronizar: {syncResult.error}
                </span>
              ) : syncResult.failed > 0 ? (
                <span style={{ color: "#fcd34d", fontWeight: 600 }}>
                  ⚠️ {syncResult.done.toLocaleString("es-CL")} sincronizadas, {syncResult.failed} fallaron.
                  Puedes intentar de nuevo.
                </span>
              ) : (
                <span style={{ color: "#86efac", fontWeight: 600 }}>
                  ✓ {syncResult.done.toLocaleString("es-CL")} revisión{syncResult.done === 1 ? "" : "es"} sincronizada{syncResult.done === 1 ? "" : "s"} al Google Sheet.
                </span>
              )
            ) : (
              <span style={{ color: "#fdba74", fontWeight: 600 }}>
                🟠 {pendingSyncCount.toLocaleString("es-CL")} revisión{pendingSyncCount === 1 ? "" : "es"} sin sincronizar al Google Sheet
                <span style={{ color: "#fed7aa", fontWeight: 400, marginLeft: 6 }}>
                  · viven sólo en este navegador hasta que se suban
                </span>
              </span>
            )}
          </div>
          {!syncing && pendingSyncCount > 0 && (
            <button
              onClick={handleForceSync}
              style={{
                padding: "6px 14px",
                background: "linear-gradient(135deg, #f97316, #ea580c)",
                border: "none",
                borderRadius: 8,
                color: "#fff",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 12,
                fontFamily: "inherit",
                whiteSpace: "nowrap",
                boxShadow: "0 2px 8px rgba(249,115,22,0.3)",
              }}
            >
              Forzar sincronización ahora
            </button>
          )}
        </div>
      )}

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
          <InvoiceTable rows={principalRows} onMark={handleMark} onNote={handleNote} />
        )}
        {tab === "fantasmas" && (
          <FantasmaTable rows={fantasmaPendientes} onMark={handleMark} onNote={handleNote} />
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
            <InvoiceTable rows={historicoRows} onMark={handleMark} onNote={handleNote} showEstadoFilter defaultShowPagadas />
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
