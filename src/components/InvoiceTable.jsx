import { useMemo, useState, useEffect, useRef } from "react";
import { fmtCLP, fmtRut, fmtDate, STATE_COLORS, normalizeSearch, parseDate } from "../lib/ui";
import { IconCheck, IconAlert, IconFlag, IconDone, IconSearch } from "./Icons";
import { exportFacturasExcel } from "../lib/export";

export default function InvoiceTable({ rows, onMark, onNote, showProblems = false, showEstadoFilter = false, defaultShowPagadas = false, exportName = "facturas" }) {
  const [searchText, setSearchText] = useState("");
  const [filterCond, setFilterCond] = useState("TODAS");
  const [filterAlert, setFilterAlert] = useState("TODAS");
  const [filterEstado, setFilterEstado] = useState("TODAS");
  const [showPagadas, setShowPagadas] = useState(defaultShowPagadas);
  const [sortCol, setSortCol] = useState("fechaFactura");
  const [sortDir, setSortDir] = useState("desc");

  const pagadasCount = useMemo(() => rows.filter(r => r.pagada).length, [rows]);

  const filtered = useMemo(() => {
    const qRaw = searchText.toLowerCase().trim();
    const qNorm = normalizeSearch(searchText);
    return rows.filter(r => {
      // Las pagadas (saldo 0) se ocultan por defecto para enfocar lo pendiente,
      // PERO una factura sospechosa nunca se esconde por estar pagada: sigue
      // siendo relevante para la auditoría aunque ya se haya cancelado.
      // Con el toggle activado se muestra TODO (pagadas + pendientes); antes
      // mostraba "solo pagadas" y en Histórico escondía las facturas OK con
      // saldo. En Problemas nunca se oculta nada: si la marcaste REVISAR,
      // tiene que estar visible siempre.
      if (!showProblems && !showPagadas && r.pagada && !r.sospechosa) {
        return false;
      }
      if (qRaw) {
        // Match flexible: campos RUT/folio/OC se comparan también con la
        // versión normalizada (sin puntos/guiones) para que "76.123.456-7"
        // encuentre a "761234567" y viceversa.
        const textos = [r.proveedor, r.tipoDoc]
          .map(x => String(x ?? "").toLowerCase());
        const codigos = [r.rutRaw, r.rut, r.folio, r.folioRaw, r.nReferencia]
          .map(x => normalizeSearch(x));
        const hay =
          textos.some(s => s.includes(qRaw)) ||
          (qNorm && codigos.some(s => s.includes(qNorm)));
        if (!hay) return false;
      }
      if (filterCond !== "TODAS" && r.condicion !== filterCond) return false;
      if (filterAlert === "SOSPECHOSAS" && !r.sospechosa) return false;
      if (filterAlert === "CON_OC" && !r.tieneRefOC) return false;
      if (filterAlert === "SIN_OC" && r.tieneRefOC) return false;
      if (filterAlert === "FACTORING" && !r.esFactoring) return false;
      if (showEstadoFilter && filterEstado !== "TODAS" && r.estadoRev !== filterEstado) return false;
      return true;
    });
  }, [rows, searchText, filterCond, filterAlert, filterEstado, showEstadoFilter, showPagadas, showProblems]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    const isDateCol = sortCol === "fechaFactura" || sortCol === "vencimiento";
    const isNumericCol = sortCol === "folio" || sortCol === "nReferencia";
    arr.sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      // Fechas: parsear a timestamp.
      if (isDateCol) {
        const ta = parseDate(va);
        const tb = parseDate(vb);
        const na = isNaN(ta), nb = isNaN(tb);
        if (na && nb) return 0;
        if (na) return 1;   // valores sin fecha siempre al final
        if (nb) return -1;
        return (ta - tb) * dir;
      }
      // Folio/OC: ordenar numéricamente (vienen como string).
      if (isNumericCol) {
        const na = Number(String(va ?? "").replace(/[^\d.-]/g, ""));
        const nb = Number(String(vb ?? "").replace(/[^\d.-]/g, ""));
        const aOk = !isNaN(na) && va !== "" && va != null;
        const bOk = !isNaN(nb) && vb !== "" && vb != null;
        if (!aOk && !bOk) return 0;
        if (!aOk) return 1;
        if (!bOk) return -1;
        return (na - nb) * dir;
      }
      // Numéricos puros (cargo/abono/saldo).
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * dir;
      }
      const sa = String(va ?? "").toLowerCase();
      const sb = String(vb ?? "").toLowerCase();
      if (sa < sb) return -1 * dir;
      if (sa > sb) return 1 * dir;
      return 0;
    });
    return arr;
  }, [filtered, sortCol, sortDir]);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const sospechosasCount = rows.filter(r => r.sospechosa).length;

  const cols = [
    ["condicion", "Cond."],
    ["fechaFactura", "Fecha"],
    ["vencimiento", "Vencimiento"],
    ["tipoDoc", "Doc"],
    ["folio", "Folio"],
    ["rut", "RUT"],
    ["proveedor", "Proveedor"],
    ["cargoTotal", "Cargo"],
    ["abonoTotal", "Abono"],
    ["saldo", "Saldo"],
    ["nReferencia", "OC"],
    ["ocFormapago", "Forma pago OC"],
    [null, "Comentario"],
    ["estadoRev", "Estado"],
    [null, "Acciones"],
  ];

  return (
    <div>
      {/* Resumen rápido */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 10,
        marginBottom: 14,
      }}>
        {[
          { label: "Facturas", value: rows.length.toLocaleString("es-CL"), color: "#3b82f6" },
          { label: "Con OC", value: rows.filter(r => r.tieneRefOC).length.toLocaleString("es-CL"), color: "#22c55e" },
          { label: "Sospechosas", value: sospechosasCount.toLocaleString("es-CL"), color: sospechosasCount > 0 ? "#ef4444" : "#64748b" },
          { label: "Mostradas", value: filtered.length.toLocaleString("es-CL"), color: "#93c5fd" },
        ].map((s, i) => (
          <div key={i} style={{
            background: "rgba(30,41,59,0.6)",
            borderRadius: 10,
            padding: "10px 14px",
            border: `1px solid ${s.color}33`,
          }}>
            <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px", position: "relative", display: "flex", alignItems: "center" }}>
          <div style={{ position: "absolute", left: 12, color: "#64748b", pointerEvents: "none", display: "flex" }}>
            <IconSearch />
          </div>
          <input
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Buscar por RUT, proveedor, folio, OC..."
            style={{
              width: "100%",
              padding: "10px 12px 10px 38px",
              background: "rgba(30,41,59,0.6)",
              border: "1px solid rgba(59,130,246,0.2)",
              borderRadius: 10,
              color: "#e2e8f0",
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        </div>
        <select value={filterCond} onChange={e => setFilterCond(e.target.value)} style={selectStyle}>
          <option value="TODAS">Todas las condiciones</option>
          <option value="1NOMINA">NÓMINA (crédito)</option>
          <option value="2CONTADO">CONTADO</option>
        </select>
        <select value={filterAlert} onChange={e => setFilterAlert(e.target.value)} style={selectStyle}>
          <option value="TODAS">Todas</option>
          <option value="SOSPECHOSAS">Sólo sospechosas</option>
          <option value="CON_OC">Con OC</option>
          <option value="SIN_OC">Sin OC</option>
          <option value="FACTORING">Factoring / cedidas</option>
        </select>
        {showEstadoFilter && (
          <select value={filterEstado} onChange={e => setFilterEstado(e.target.value)} style={selectStyle}>
            <option value="TODAS">Todos los estados</option>
            <option value="OK">OK</option>
            <option value="REVISADA">REVISADA</option>
          </select>
        )}
        {!showProblems && pagadasCount > 0 && (
          <button
            onClick={() => setShowPagadas(v => !v)}
            title={showPagadas ? "Ocultar facturas pagadas (saldo 0) no sospechosas" : "Incluir también las facturas ya pagadas (saldo 0)"}
            style={{
              padding: "10px 14px",
              background: showPagadas ? "rgba(34,197,94,0.15)" : "rgba(30,41,59,0.6)",
              border: `1px solid ${showPagadas ? "rgba(34,197,94,0.35)" : "rgba(59,130,246,0.2)"}`,
              borderRadius: 10,
              color: showPagadas ? "#86efac" : "#cbd5e1",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            {showPagadas ? "✓" : "○"} Mostrar pagadas
            <span style={{
              background: "rgba(148,163,184,0.2)",
              color: "#cbd5e1",
              borderRadius: 8,
              padding: "1px 6px",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {pagadasCount.toLocaleString("es-CL")}
            </span>
          </button>
        )}
        <button
          onClick={() => exportFacturasExcel(sorted, exportName)}
          disabled={sorted.length === 0}
          title="Descargar las facturas mostradas (con filtros aplicados) como planilla Excel (.xlsx)"
          style={exportBtnStyle("#16a34a", sorted.length === 0)}
        >
          ⬇ Excel
        </button>
      </div>

      <div style={{
        background: "rgba(30,41,59,0.4)",
        borderRadius: 12,
        border: "1px solid rgba(59,130,246,0.15)",
        overflow: "hidden",
      }}>
        <div style={{ overflowX: "auto", maxHeight: "65vh" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 5 }}>
              <tr>
                {cols.map(([k, label], i) => (
                  <th key={i} onClick={() => k && handleSort(k)} style={{
                    padding: "10px 10px",
                    textAlign: "left",
                    fontWeight: 600,
                    color: sortCol === k ? "#93c5fd" : "#94a3b8",
                    borderBottom: "1px solid rgba(59,130,246,0.15)",
                    whiteSpace: "nowrap",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    cursor: k ? "pointer" : "default",
                    userSelect: "none",
                    background: "rgba(15,23,42,0.95)",
                    position: "sticky",
                    top: 0,
                  }}>
                    {label}
                    {sortCol === k && <span style={{ marginLeft: 4 }}>{sortDir === "asc" ? "▲" : "▼"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={cols.length} style={{ padding: 48, textAlign: "center", color: "#64748b", fontSize: 14 }}>
                    {rows.length === 0 ? "Sin datos. Carga Defontana en la pestaña Carga." : "Sin resultados con los filtros actuales."}
                  </td>
                </tr>
              ) : (
                sorted.slice(0, 800).map(r => (
                  <InvoiceRow key={r.key} row={r} onMark={onMark} onNote={onNote} showProblems={showProblems} />
                ))
              )}
            </tbody>
          </table>
        </div>
        {sorted.length > 800 && (
          <div style={{ padding: "10px 16px", textAlign: "center", fontSize: 12, color: "#64748b", borderTop: "1px solid rgba(59,130,246,0.1)" }}>
            Mostrando 800 de {sorted.length.toLocaleString("es-CL")} · usa los filtros para acotar
          </div>
        )}
      </div>
    </div>
  );
}

function InvoiceRow({ row, onMark, onNote, showProblems }) {
  const sc = STATE_COLORS[row.estadoRev] || STATE_COLORS.PENDIENTE;
  // Factoring (sin otra sospecha) se señala en morado, no en rojo: es informativo.
  const esFactoringNoSosp = row.esFactoring && !row.sospechosa;
  const rowBg = row.sospechosa
    ? "rgba(239,68,68,0.06)"
    : esFactoringNoSosp
      ? "rgba(168,85,247,0.06)"
      : "transparent";

  return (
    <tr
      title={row.alerta || ""}
      style={{
        background: rowBg,
        borderLeft: row.sospechosa
          ? "3px solid #ef4444"
          : esFactoringNoSosp
            ? "3px solid #a855f7"
            : "3px solid transparent",
        transition: "background 0.15s",
      }}
    >
      <td style={tdStyle}>
        <span style={{
          padding: "2px 6px",
          borderRadius: 4,
          fontSize: 10,
          fontWeight: 700,
          background: row.condicion === "1NOMINA" ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.12)",
          color: row.condicion === "1NOMINA" ? "#22c55e" : "#f59e0b",
          border: `1px solid ${row.condicion === "1NOMINA" ? "rgba(34,197,94,0.25)" : "rgba(245,158,11,0.25)"}`,
        }}>
          {row.condicion === "1NOMINA" ? "NOM" : row.condicion === "2CONTADO" ? "CTD" : "-"}
        </span>
      </td>
      <td style={tdStyle}>
        {fmtDate(row.fechaFactura)}
        {row.ingresoTardioSospechoso && (
          <span
            title={`Ingresada ${row.diasIngreso} días después de la emisión SII (> 8)`}
            style={{
              marginLeft: 6,
              padding: "1px 5px",
              borderRadius: 4,
              fontSize: 9,
              fontWeight: 700,
              background: "rgba(239,68,68,0.15)",
              color: "#f87171",
              border: "1px solid rgba(239,68,68,0.35)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            +{row.diasIngreso}d
          </span>
        )}
      </td>
      <td style={tdStyle}>
        {row.vencimientos && row.vencimientos.length > 1 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {row.vencimientos.map((v, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", whiteSpace: "nowrap" }}>
                <span>{fmtDate(v.fecha)}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#94a3b8" }}>
                  {fmtCLP(v.monto)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          fmtDate(row.vencimiento)
        )}
      </td>
      <td style={{ ...tdStyle, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
        {row.tipoDoc.replace("Electrónica", "Elec.").replace("Factura", "Fact.")}
      </td>
      <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: "#e2e8f0" }}>
        {row.folio}
        {row.soloEnReviews && (
          <span
            title="Auto-conciliada: ya no está en el Defontana actual, solo persiste en la pestaña Reviews del Google Sheet"
            style={{
              marginLeft: 6,
              padding: "1px 5px",
              borderRadius: 4,
              fontSize: 9,
              fontWeight: 700,
              background: "rgba(148,163,184,0.15)",
              color: "#94a3b8",
              border: "1px solid rgba(148,163,184,0.35)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            solo reviews
          </span>
        )}
        {row.esFactoring && (
          <span
            title={row.cedidaDe
              ? `Factura cedida (factoring) — proveedor original: ${row.cedidaDe.proveedor || ""}${row.cedidaDe.rut ? " (" + fmtRut(row.cedidaDe.rut) + ")" : ""}`
              : "Factura cedida a empresa de factoring"}
            style={{
              marginLeft: 6,
              padding: "1px 5px",
              borderRadius: 4,
              fontSize: 9,
              fontWeight: 700,
              background: "rgba(168,85,247,0.15)",
              color: "#c084fc",
              border: "1px solid rgba(168,85,247,0.35)",
            }}
          >
            Cedida
          </span>
        )}
      </td>
      <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace" }}>{fmtRut(row.rut)}</td>
      <td
        title={row.esFactoring && row.cedidaDe?.proveedor ? `${row.proveedor} ← cedida de ${row.cedidaDe.proveedor}` : row.proveedor}
        style={{ ...tdStyle, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {row.proveedor}
        {row.esFactoring && row.cedidaDe?.proveedor && (
          <span style={{ color: "#94a3b8", fontStyle: "italic", marginLeft: 6 }}>
            ← {row.cedidaDe.proveedor}
          </span>
        )}
      </td>
      <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", textAlign: "right" }}>{fmtCLP(row.cargoTotal)}</td>
      <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", textAlign: "right", color: "#22c55e" }}>{fmtCLP(row.abonoTotal)}</td>
      <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", textAlign: "right", color: row.saldo < 0 ? "#f87171" : "#e2e8f0" }}>
        {fmtCLP(row.saldo)}
      </td>
      <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace" }}>
        {row.tieneRefOC ? (
          <span style={{ color: "#22c55e", fontWeight: 600 }}>{row.nReferencia}</span>
        ) : (
          <span style={{ color: "#475569" }}>{row.nReferencia || "—"}</span>
        )}
      </td>
      <td style={{ ...tdStyle, fontSize: 11 }}>
        {row.ocFormapago ? (
          <span style={{ color: row.sospechosa ? "#f87171" : "#cbd5e1" }}>
            {row.ocFormapago}
            {row.sospechosa && <span style={{ marginLeft: 6 }}>⚠️</span>}
          </span>
        ) : (
          <span style={{ color: "#475569" }}>—</span>
        )}
      </td>
      <td style={{ ...tdStyle, minWidth: 200 }}>
        <NoteCell row={row} onNote={onNote} />
      </td>
      <td style={tdStyle}>
        <span style={{
          padding: "2px 8px",
          borderRadius: 4,
          fontSize: 10,
          fontWeight: 700,
          background: sc.bg,
          color: sc.fg,
          border: `1px solid ${sc.border}`,
        }}>
          {row.estadoRev}
        </span>
      </td>
      <td style={tdStyle}>
        <RowActions row={row} onMark={onMark} showProblems={showProblems} />
      </td>
    </tr>
  );
}

function NoteCell({ row, onNote }) {
  const [draft, setDraft] = useState(row.nota || "");
  const [saved, setSaved] = useState(false);
  // Último valor enviado: evita el doble guardado cuando Enter dispara save()
  // y el blur inmediato lo vuelve a disparar antes de que row.nota se actualice.
  const lastSentRef = useRef(null);

  useEffect(() => { setDraft(row.nota || ""); }, [row.nota]);

  const save = async () => {
    if (draft === (row.nota || "") || draft === lastSentRef.current) return;
    lastSentRef.current = draft;
    await onNote(row, draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {row.notaHeredada && (
        <div
          title={`Comentario de la factura original${row.cedidaDe?.proveedor ? " (" + row.cedidaDe.proveedor + ")" : ""} — se conserva intacto, no se edita aquí`}
          style={{
            fontSize: 10,
            color: "#c084fc",
            fontStyle: "italic",
            lineHeight: 1.3,
            whiteSpace: "normal",
            maxWidth: 240,
          }}
        >
          heredado: {row.notaHeredada}
        </div>
      )}
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === "Enter") { save(); e.target.blur(); } }}
        placeholder="Agregar comentario..."
        style={{
          flex: 1,
          padding: "4px 8px",
          background: draft ? "rgba(59,130,246,0.08)" : "rgba(15,23,42,0.5)",
          border: `1px solid ${draft ? "rgba(59,130,246,0.35)" : "rgba(59,130,246,0.12)"}`,
          borderRadius: 6,
          color: "#e2e8f0",
          fontSize: 11,
          fontFamily: "inherit",
          outline: "none",
          minWidth: 0,
          transition: "border-color 0.15s, background 0.15s",
        }}
        onFocus={e => { e.currentTarget.style.borderColor = "rgba(59,130,246,0.6)"; }}
      />
      {saved && (
        <span style={{ fontSize: 10, color: "#22c55e", whiteSpace: "nowrap" }}>✓ guardado</span>
      )}
      </div>
    </div>
  );
}

function RowActions({ row, onMark, showProblems }) {
  if (showProblems) {
    // Pestaña problemas: sólo dejar marcar como REVISADA o volver a OK
    return (
      <div style={{ display: "flex", gap: 4 }}>
        <ActionBtn color="#94a3b8" title="Marcar como revisada (solucionado con contabilidad)" onClick={() => onMark(row, "REVISADA")}>
          <IconDone />
        </ActionBtn>
        <ActionBtn color="#22c55e" title="Descartar, estaba OK" onClick={() => onMark(row, "OK")}>
          <IconCheck />
        </ActionBtn>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <ActionBtn color="#22c55e" title="Marcar OK" onClick={() => onMark(row, "OK")}>
        <IconCheck />
      </ActionBtn>
      <ActionBtn color="#ef4444" title="Marcar para revisar" onClick={() => onMark(row, "REVISAR")}>
        <IconFlag />
      </ActionBtn>
    </div>
  );
}

function ActionBtn({ color, title, onClick, children }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 28,
      height: 28,
      padding: 0,
      border: `1px solid ${color}44`,
      background: `${color}15`,
      color,
      borderRadius: 6,
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "all 0.15s",
    }}
      onMouseEnter={e => { e.currentTarget.style.background = `${color}30`; }}
      onMouseLeave={e => { e.currentTarget.style.background = `${color}15`; }}
    >
      {children}
    </button>
  );
}

const tdStyle = {
  padding: "8px 10px",
  borderBottom: "1px solid rgba(59,130,246,0.05)",
  whiteSpace: "nowrap",
  color: "#cbd5e1",
};

const selectStyle = {
  padding: "10px 12px",
  background: "rgba(30,41,59,0.6)",
  border: "1px solid rgba(59,130,246,0.2)",
  borderRadius: 10,
  color: "#e2e8f0",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  cursor: "pointer",
};

const exportBtnStyle = (color, disabled) => ({
  padding: "10px 14px",
  background: disabled ? "rgba(148,163,184,0.1)" : `${color}1f`,
  border: `1px solid ${disabled ? "rgba(148,163,184,0.2)" : `${color}66`}`,
  borderRadius: 10,
  color: disabled ? "#64748b" : color,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  outline: "none",
  cursor: disabled ? "not-allowed" : "pointer",
  whiteSpace: "nowrap",
});
