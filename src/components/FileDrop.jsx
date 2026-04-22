import { useRef, useState } from "react";
import { IconFile, IconUpload, IconCheck, IconAlert } from "./Icons";

export default function FileDrop({ label, description, accept = ".xlsx,.xls", onFileParsed, parser, accent = "#6366f1" }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState(null); // { ok, msg, count }
  const [parsing, setParsing] = useState(false);

  const handle = async (f) => {
    if (!f) return;
    setFile(f);
    setStatus(null);
    setParsing(true);
    try {
      const rows = await parser(f);
      setStatus({ ok: true, count: rows.length, msg: `${rows.length.toLocaleString("es-CL")} filas procesadas` });
      onFileParsed?.(rows, f);
    } catch (e) {
      setStatus({ ok: false, msg: e.message });
    } finally {
      setParsing(false);
    }
  };

  return (
    <div style={{
      border: `2px dashed ${accent}55`,
      borderRadius: 14,
      padding: 20,
      background: `${accent}08`,
      transition: "all 0.2s",
    }}
      onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = accent; }}
      onDragLeave={e => { e.currentTarget.style.borderColor = `${accent}55`; }}
      onDrop={e => {
        e.preventDefault();
        e.currentTarget.style.borderColor = `${accent}55`;
        handle(e.dataTransfer.files?.[0]);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept={accept} style={{ display: "none" }} onChange={e => handle(e.target.files?.[0])} />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ color: accent, opacity: 0.6 }}><IconFile /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: accent }}>{label}</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{description}</div>
          {file && (
            <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 6, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {file.name}
            </div>
          )}
        </div>
        <div style={{ cursor: "pointer", color: accent, opacity: 0.7 }}>
          <IconUpload />
        </div>
      </div>
      {parsing && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8" }}>Procesando...</div>
      )}
      {status && (
        <div style={{
          marginTop: 10,
          padding: "8px 12px",
          borderRadius: 8,
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: status.ok ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
          color: status.ok ? "#22c55e" : "#f87171",
          border: `1px solid ${status.ok ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
        }}>
          {status.ok ? <IconCheck /> : <IconAlert />}
          {status.msg}
        </div>
      )}
    </div>
  );
}
