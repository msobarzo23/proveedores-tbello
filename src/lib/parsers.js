import * as XLSX from "xlsx";

// ─── Helpers ───────────────────────────────────────────────────────
export const normRut = (r) => {
  if (!r) return "";
  return String(r).replace(/[.\s]/g, "").replace(/-/g, "").toUpperCase().trim();
};

export const normFolio = (f) => {
  if (f == null || f === "") return "";
  const s = String(f).trim();
  const n = Number(s.replace(/[^\d]/g, ""));
  return isNaN(n) ? s : String(n);
};

export const normOC = (o) => {
  if (o == null || o === "") return "";
  const s = String(o).trim();
  const n = Number(s.replace(/[^\d]/g, ""));
  return isNaN(n) ? s : String(n);
};

export const parseCLP = (v) => {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const cleaned = s.replace(/\./g, "").replace(/,/g, ".");
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
};

const readWorkbook = async (file) => {
  const buf = await file.arrayBuffer();
  return XLSX.read(new Uint8Array(buf), { type: "array" });
};

// ─── DEFONTANA ─────────────────────────────────────────────────────
// Header row: first column contains "Cuenta"
// Key columns (0-indexed):
//   3  Clasificador 1 → 1NOMINA / 2CONTADO (col D)
//   5  Fecha (F)
//   6  Tipo mov. (Cpra_FCA / EGRESO / ...) (G)
//   7  Número (H)
//   8  RUT / ID Ficha (I)
//   9  Ficha / Nombre proveedor (J)
//  10  Cargo (K)
//  11  Abono (L)
//  12  Saldo (M)
//  14  Documento (ej Factura Compra Electrónica) (O)
//  15  Vencimiento (P)
//  16  Número Doc. / Folio (Q)
export async function parseDefontana(file) {
  const wb = await readWorkbook(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  let headerIdx = -1;
  for (let i = 0; i < Math.min(raw.length, 20); i++) {
    if (String(raw[i]?.[0] ?? "").toLowerCase().includes("cuenta")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error("No se encontró fila de encabezado (Cuenta) en Defontana");

  const rows = raw.slice(headerIdx + 1).filter(r => r.some(c => c !== "" && c != null));

  return rows.map(r => ({
    condicion: String(r[3] ?? "").trim(),     // 1NOMINA / 2CONTADO
    fecha:     String(r[5] ?? "").trim(),
    tipoMov:   String(r[6] ?? "").trim(),     // Cpra_FCA / EGRESO
    numero:    String(r[7] ?? "").trim(),
    rut:       normRut(r[8]),
    rutRaw:    String(r[8] ?? "").trim(),
    proveedor: String(r[9] ?? "").trim(),
    cargo:     parseCLP(r[10]),
    abono:     parseCLP(r[11]),
    saldo:     parseCLP(r[12]),
    tipoDoc:   String(r[14] ?? "").trim(),    // Factura Compra Electrónica
    vencimiento: String(r[15] ?? "").trim(),
    folio:     normFolio(r[16]),
    folioRaw:  String(r[16] ?? "").trim(),
  }));
}

// Agrupar Defontana en 1 fila por factura (RUT + Folio + TipoDoc).
// Suma cargos/abonos y calcula saldo real. La "condición" y la fecha
// viene de la fila de compra (Cpra_FCA, Cpra_*, etc.). Los EGRESOs se suman.
export function groupDefontanaByInvoice(rows) {
  const map = new Map();
  const COMPRA_RE = /^Cpra/i;

  for (const r of rows) {
    // Ignorar filas sin folio
    if (!r.folio) continue;
    const key = `${r.rut}|${r.folio}|${r.tipoDoc}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        rut: r.rut,
        rutRaw: r.rutRaw,
        folio: r.folio,
        folioRaw: r.folioRaw,
        tipoDoc: r.tipoDoc,
        proveedor: r.proveedor,
        condicion: "",
        fechaFactura: "",
        vencimiento: "",
        cargoTotal: 0,
        abonoTotal: 0,
        movimientos: 0,
        tieneCompra: false,
        tieneEgreso: false,
      });
    }
    const g = map.get(key);
    g.cargoTotal += r.cargo;
    g.abonoTotal += r.abono;
    g.movimientos += 1;
    if (COMPRA_RE.test(r.tipoMov)) {
      g.tieneCompra = true;
      g.condicion = r.condicion || g.condicion;
      g.fechaFactura = r.fecha || g.fechaFactura;
      g.vencimiento = r.vencimiento || g.vencimiento;
      if (!g.proveedor) g.proveedor = r.proveedor;
    } else {
      g.tieneEgreso = true;
    }
  }

  // saldo = abono - cargo (convención Defontana para proveedores)
  return Array.from(map.values()).map(g => ({
    ...g,
    saldo: g.abonoTotal - g.cargoTotal,
    pagada: Math.abs(g.abonoTotal - g.cargoTotal) < 1, // saldo ~ 0
  }));
}

// ─── REPORTE OC (xls binario) ──────────────────────────────────────
// Columnas: Nro, Fecha, Tipo, CreadaPor, Sucursal, Proveedor, Empresa, Formapago, Total, Estado
export async function parseReporteOC(file) {
  const wb = await readWorkbook(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (!raw.length) throw new Error("Reporte OC vacío");

  // El header está en la fila 0
  const headers = raw[0].map(h => String(h ?? "").trim().toLowerCase());
  const col = (name) => headers.findIndex(h => h === name.toLowerCase());

  const cNro = col("Nro");
  const cFecha = col("Fecha");
  const cProv = col("Proveedor");
  const cForma = col("Formapago");
  const cTotal = col("Total");
  const cEstado = col("Estado");
  const cCreada = col("CreadaPor");
  const cSucursal = col("Sucursal");

  if (cNro < 0) throw new Error("Reporte OC sin columna 'Nro'");

  return raw.slice(1)
    .filter(r => r.some(c => c !== "" && c != null))
    .map(r => ({
      oc: normOC(r[cNro]),
      ocRaw: String(r[cNro] ?? "").trim(),
      fecha: String(r[cFecha] ?? "").trim(),
      proveedor: String(r[cProv] ?? "").trim(),
      formapago: String(r[cForma] ?? "").trim(),
      total: parseCLP(r[cTotal]),
      estado: String(r[cEstado] ?? "").trim(),
      creadaPor: cCreada >= 0 ? String(r[cCreada] ?? "").trim() : "",
      sucursal: cSucursal >= 0 ? String(r[cSucursal] ?? "").trim() : "",
    }));
}

// ─── REFERENCIA FACTURACIÓN.CL ─────────────────────────────────────
// Columnas: Item, Folio, Documento, Tipo Documento, Rut Proveedor, Razon Social,
//           Monto Total Documento, Fecha Emision (H=aceptación), Referencia, N Referencia,
//           Fecha Referencia (K=emisión real SII), Razon Referencia, Usuario
export async function parseReferenciaFactCL(file) {
  const wb = await readWorkbook(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (!raw.length) throw new Error("Referencia Facturación.cl vacía");

  const headers = raw[0].map(h => String(h ?? "").trim().toLowerCase());
  const find = (...names) => headers.findIndex(h => names.some(n => h === n.toLowerCase()));

  const cFolio = find("Folio");
  const cDoc = find("Documento");
  const cTipoDoc = find("Tipo Documento");
  const cRut = find("Rut Proveedor");
  const cRazon = find("Razon Social");
  const cMonto = find("Monto Total Documento");
  const cFecha = find("Fecha Emision");
  const cRef = find("Referencia");
  const cNRef = find("N Referencia");
  const cFechaRef = find("Fecha Referencia");
  const cRazonRef = find("Razon Referencia");

  if (cFolio < 0 || cRut < 0) throw new Error("Referencia Fact.cl sin columnas Folio/Rut");

  return raw.slice(1)
    .filter(r => r.some(c => c !== "" && c != null))
    .map(r => ({
      folio: normFolio(r[cFolio]),
      documento: String(r[cDoc] ?? "").trim(),
      tipoDoc: String(r[cTipoDoc] ?? "").trim(),    // "33" = factura, "52" = guía, etc.
      rut: normRut(r[cRut]),
      razonSocial: String(r[cRazon] ?? "").trim(),
      monto: parseCLP(r[cMonto]),
      fecha: String(r[cFechaRef] ?? "").trim(),   // col K: fecha real de emisión SII
      fechaAceptacion: String(r[cFecha] ?? "").trim(), // col H: fecha de aceptación
      referencia: String(r[cRef] ?? "").trim(),
      nReferencia: normOC(r[cNRef]),
      fechaRef: String(r[cFechaRef] ?? "").trim(),
      razonRef: String(r[cRazonRef] ?? "").trim(),
    }))
    // Filtrar sólo facturas (ignorar guías de despacho y otros).
    // Tipo doc SII: 33 = Factura electrónica, 34 = Factura exenta, 56 = Nota débito,
    // 61 = Nota crédito, 52 = Guía de despacho. Consideramos facturas = 33, 34.
    .filter(r => {
      const t = r.tipoDoc.toUpperCase();
      // Puede venir como número (33) o como texto ("FACTURA ELECTRONICA"). Aceptamos ambos.
      if (t === "33" || t === "34") return true;
      if (t.includes("FACTURA")) return true;
      return false;
    });
}

// ─── INFORME DE COMPRA FACTURACIÓN.CL ──────────────────────────────
// Archivo distinto al de "Referencia": trae la fecha REAL de emisión SII
// del documento comprado (no de su OC referenciada, que puede ser de años atrás).
// Columnas (0-indexed):
//   A (0)  N° Linea
//   B (1)  Folio                    ← cruce con Defontana
//   C (2)  Emitido
//   D (3)  Documento                (FACTURA ELECTRONICA, GUIA, NOTA CREDITO, ...)
//   E (4)  Tipo Documento           (33=fact, 34=exenta, 52=guía, 61=NC)
//   F (5)  Rut                      ← cruce con Defontana
//   G (6)  Razon Social
//   T (19) Monto Total documento
//   Y (24) Fecha Creacion
//   Z (25) Fecha Emision            ← fecha real de emisión SII
//
// El archivo trae una fila por línea de detalle (varias filas por factura).
// Aquí agrupamos por rut+folio y tomamos la primera aparición, porque todas
// las líneas de una misma factura comparten rut, folio, razón y fecha.
export async function parseInformeCompraFactCL(file) {
  const wb = await readWorkbook(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (!raw.length) throw new Error("Informe de Compra vacío");

  // Validar encabezados esperados en fila 0
  const headers = raw[0].map(h => String(h ?? "").trim().toLowerCase());
  const hasFolio = headers[1]?.includes("folio");
  const hasRut = headers[5]?.includes("rut");
  const hasFechaEm = headers[25]?.includes("fecha emision");
  if (!hasFolio || !hasRut || !hasFechaEm) {
    throw new Error("Informe de Compra con encabezados inesperados (B=Folio, F=Rut, Z=Fecha Emision)");
  }

  const map = new Map();
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || !r.some(c => c !== "" && c != null)) continue;

    const tipoDoc = String(r[4] ?? "").trim().toUpperCase();
    const documento = String(r[3] ?? "").trim();
    // Sólo facturas (33 = afecta, 34 = exenta). Descartamos guías (52),
    // notas de crédito/débito (61/56) y otros.
    const esFactura = tipoDoc === "33" || tipoDoc === "34"
      || (documento.toUpperCase().startsWith("FACTURA") && !documento.toUpperCase().includes("NOTA"));
    if (!esFactura) continue;

    const rut = normRut(r[5]);
    const folio = normFolio(r[1]);
    if (!rut || !folio) continue;

    const key = `${rut}|${folio}`;
    if (map.has(key)) continue; // ya tenemos la fecha — saltamos líneas adicionales

    map.set(key, {
      folio,
      rut,
      rutRaw: String(r[5] ?? "").trim(),
      razonSocial: String(r[6] ?? "").trim(),
      documento,
      tipoDoc,
      fechaEmision: String(r[25] ?? "").trim(),   // col Z — la que importa
      fechaCreacion: String(r[24] ?? "").trim(),  // col Y — creación en el portal
      montoTotal: parseCLP(r[19]),
    });
  }

  return Array.from(map.values());
}
