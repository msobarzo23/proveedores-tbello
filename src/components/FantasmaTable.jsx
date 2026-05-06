import { useMemo, useState, useEffect } from "react";
import { fmtCLP, fmtRut, fmtDate, STATE_COLORS } from "../lib/ui";
import { IconCheck, IconFlag, IconDone, IconSearch } from "./Icons";

// Tabla específica para facturas aceptadas en SII (Fact.cl) que no aparecen
// en Defontana. Más simple que InvoiceTable: no tiene condición ni OC, sólo
// muestra los datos que vienen del lado SII más estado de revisión y nota.
export default function FantasmaTable({ rows, onMark, onNote }) {
  const [searchText, setSearchText] = useState("");
  const [filterFuente, setFilterFuente] = useState("TODAS");
  const [sortCol, setSortCol] = useState("fechaFactura");
  const [sortDir, setSortDir] = useState("desc");

  const filtered = useMemo(() => {
    const q = searchText.toLowerCase().trim();
    return rows.filter(r => {
      if (q) {
        const hay = [r.rutRaw, r.rut, r.proveedor, r.folio, r.tipoDoc]
          .map(x => String(x ?? "").toLowerCase())
          .some(s => s.includes(q));
        if (!hay) return false;
      }
      if (filterFuente !== "TODAS" && r.fuenteFantasma !== filterFuente) return false;
      return true;
    });
  }, [rows, searchText, filterFuente]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = a[sortCol] ?? "";
      const vb = b[sortCol] ?? "";
      if (typeof va === "number" && typeof vb === "number") {
        return sortDir === "asc" ? va - vb : vb - va;
      }
      const sa = String(va).toLowerCase();
      const sb = String(vb).toLowerCase();
      if (sa < sb) return sortDir === "asc" ? -1 : 1;
      if (sa > sb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortCol, sortDir]);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const totalMonto = useMemo(() => rows.reduce((s, r) => s + (r.cargoTotal || 0), 0), [rows]);

  const cols = [
    ["fechaFactura", "Fecha emisión SII"],
    ["tipoDoc", "Doc"],
    ["folio", "Folio"],
    ["rut", "RUT"],
    ["proveedor", "Proveedor"],
    ["cargoTotal", "Monto"],
    ["fuenteFantasma", "Fuente"],
    [null, "Comentario"],
    ["estadoRev", "Estado"],
    [null, "Acciones"],
  ];

  return (
    <div>
      <div style={{
        marginBottom: 14,
        padding: "12px 16px",
        background: "rgba(239,68,68,0.08)",
        borderRadius: 12,
        border: "1px solid rgba(239,68,68,0.25)",
        fontSize: 12,
        color: "#fca5a5",
        lineHeight: 1.5,
      }}>
        <strong style={{ color: "#f87171" }}>Aceptadas en SII pero sin registro en Defontana.</strong>
        {" "}Son facturas que aparecen en los archivos de Facturación.cl (Informe de Compra
        o Referencia) pero <em>no</em> existen en el ledger Defontana cargado. Pueden ser
        facturas que faltó ingresar a contabilidad. Marca <strong>Revisar</strong> para que
        contabilidad las ingrese; cuando aparezcan en el próximo Defontana, salen
        automáticamente de este listado.
      </div>

      {/* Resumen */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 10,
        marginBottom: 14,
      }}>
        {[
          { label: "Sin registro", value: rows.length.toLocaleString("es-CL"), color: rows.length > 0 ? "#ef4444" : "#64748b" },
          { label: "Monto total", value: fmtCLP(totalMonto), color: "#f59e0b" },
          { label: "Mostradas", value: filtered.length.toLocaleString("es-CL"), color: "#a5b4fc" },
        ].map((s, i) => (
          <div key={i} style={{
            background: "rgba(30,41,59,0.6)",
            borderRadius: 10,
            padding: "10px 14px",
            border: `1px solid ${s.color}33`,
          }}>
            <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: "monospace" }}>{s.value}</div>
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
            placeholder="Buscar por RUT, proveedor, folio..."
            style={{
              width: "100%",
              padding: "10px 12px 10px 38px",
              background: "rgba(30,41,59,0.6)",
              border: "1px solid rgba(99,102,241,0.2)",
              borderRadius: 10,
              color: "#e2e8f0",
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        </div>
        <select value={filterFuente} onChange={e => setFilterFuente(e.target.value)} style={selectStyle}>
          <option value="TODAS">Todas las fuentes</option>
          <option value="informe_compra">Informe de Compra</option>
          <option value="referencia">Referencia</option>
        </select>
      </div>

      <div style={{
        background: "rgba(30,41,59,0.4)",
        borderRadius: 12,
        border: "1px solid rgba(99,102,241,0.15)",
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
                    color: sortCol === k ? "#a5b4fc" : "#94a3b8",
                    borderBottom: "1px solid rgba(99,102,241,0.15)",
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
                    {rows.length === 0
                      ? "Sin alertas: todo lo aceptado en Fact.cl está registrado en Defontana."
                      : "Sin resultados con los filtros actuales."}
                  </td>
                </tr>
              ) : (
                sorted.slice(0, 800).map(r => (
                  <FantasmaRow key={r.key} row={r} onMark={onMark} onNote={onNote} />
                ))
              )}
            </tbody>
          </table>
        </div>
        {sorted.length > 800 && (
          <div style={{ padding: "10px 16px", textAlign: "center", fontSize: 12, color: "#64748b", borderTop: "1px solid rgba(99,102,241,0.1)" }}>
            Mostrando 800 de {sorted.length.toLocaleString("es-CL")} · usa los filtros para acotar
          </div>
        )}
      </div>
    </div>
  );
}

function FantasmaRow({ row, onMark, onNote }) {
  const sc = STATE_COLORS[row.estadoRev] || STATE_COLORS.PENDIENTE;
  const fuenteLabel = row.fuenteFantasma === "informe_compra"
    ? "Informe Compra"
    : row.fuenteFantasma === "referencia" ? "Referencia" : "—";

  return (
    <tr
      title={row.alerta || ""}
      style={{
        background: "rgba(239,68,68,0.06)",
        borderLeft: "3px solid #ef4444",
        transition: "background 0.15s",
      }}
    >
      <td style={tdStyle}>{fmtDate(row.fechaFactura)}</td>
      <td style={{ ...tdStyle, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
        {String(row.tipoDoc || "").replace("Electrónica", "Elec.").replace("Factura", "Fact.")}
      </td>
      <td style={{ ...tdStyle, fontFamily: "monospace", fontWeight: 600, color: "#e2e8f0" }}>{row.folio}</td>
      <td style={{ ...tdStyle, fontFamily: "monospace" }}>{fmtRut(row.rut)}</td>
      <td style={{ ...tdStyle, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{row.proveedor}</td>
      <td style={{ ...tdStyle, fontFamily: "monospace", textAlign: "right", color: "#f59e0b" }}>{fmtCLP(row.cargoTotal)}</td>
      <td style={{ ...tdStyle, fontSize: 11, color: "#94a3b8" }}>{fuenteLabel}</td>
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
        <div style={{ display: "flex", gap: 4 }}>
          <ActionBtn color="#ef4444" title="Marcar para revisar (pedir a contabilidad ingresarla)" onClick={() => onMark(row, "REVISAR")}>
            <IconFlag />
          </ActionBtn>
          <ActionBtn color="#94a3b8" title="Marcar revisada / ya ingresada" onClick={() => onMark(row, "REVISADA")}>
            <IconDone />
          </ActionBtn>
          <ActionBtn color="#22c55e" title="Descartar (no aplica)" onClick={() => onMark(row, "OK")}>
            <IconCheck />
          </ActionBtn>
        </div>
      </td>
    </tr>
  );
}

function NoteCell({ row, onNote }) {
  const [draft, setDraft] = useState(row.nota || "");
  const [saved, setSaved] = useState(false);

  useEffect(() => { setDraft(row.nota || ""); }, [row.nota]);

  const save = async () => {
    if (draft === (row.nota || "")) return;
    await onNote(row, draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
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
          background: draft ? "rgba(99,102,241,0.08)" : "rgba(15,23,42,0.5)",
          border: `1px solid ${draft ? "rgba(99,102,241,0.35)" : "rgba(99,102,241,0.12)"}`,
          borderRadius: 6,
          color: "#e2e8f0",
          fontSize: 11,
          fontFamily: "inherit",
          outline: "none",
          minWidth: 0,
          transition: "border-color 0.15s, background 0.15s",
        }}
      />
      {saved && (
        <span style={{ fontSize: 10, color: "#22c55e", whiteSpace: "nowrap" }}>✓ guardado</span>
      )}
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
  borderBottom: "1px solid rgba(99,102,241,0.05)",
  whiteSpace: "nowrap",
  color: "#cbd5e1",
};

const selectStyle = {
  padding: "10px 12px",
  background: "rgba(30,41,59,0.6)",
  border: "1px solid rgba(99,102,241,0.2)",
  borderRadius: 10,
  color: "#e2e8f0",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  cursor: "pointer",
};
