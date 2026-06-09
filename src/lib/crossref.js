// Motor de cruce:
// Defontana (agrupado por factura) → Informe Compra Fact.cl (por RUT+Folio) → Fecha Emisión real
//                                  → Referencia Fact.cl (por RUT+Folio)      → N Referencia = OC
//                                                                            → Reporte OC (por Nro)
//                                  → Histórico crédito (por RUT)
//
// Hay dos archivos de Facturación.cl:
//   - "Informe de Compra": fila por línea de detalle, col Z = fecha real de
//      emisión SII del documento comprado. Es la fuente de verdad para la fecha.
//   - "Referencia": fila por referencia declarada (N Ref). Sirve para enlazar
//      con la OC en Reporte OC. Su fecha puede ser de años atrás si la OC es
//      antigua, por eso ya no la usamos como fecha de emisión.
//
// Reglas de alerta (línea roja). Una factura queda SOSPECHOSA si se cumple cualquiera:
//   1. CONTADO con OC válida o RUT en histórico de crédito — debería ser NÓMINA.
//   2. NÓMINA con plazo emisión→vencimiento < 28 días.
//   3. Ingreso tardío: Defontana col F (fecha de ingreso a contabilidad) supera
//      en más de 8 días a la fecha real de emisión SII (Informe de Compra col Z,
//      con fallback a Referencia col K). El plazo legal para declarar es 8 días.

import { normalizeRut } from "./historico";

// Parsea "dd/MM/yyyy", "dd-MM-yyyy", "yyyy-MM-dd[...]" o Date → Date. null si no se puede.
function toDate(s) {
  if (!s) return null;
  if (s instanceof Date && !isNaN(s)) return s;
  const str = String(s).trim();
  // dd/MM/yyyy o dd-MM-yyyy
  let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d) ? null : d;
  }
  // yyyy-MM-dd
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d;
  }
  return null;
}

const daysBetween = (a, b) => Math.round((b - a) / (1000 * 60 * 60 * 24));

export function buildCrossref(defontanaInvoices, ocRows, factclRows, historicoCreditoSet = new Set(), compraRows = [], factoringByRut = new Map(), reviews = {}) {
  // Indexar Reporte OC por Nro
  const ocByNro = new Map();
  for (const oc of ocRows) {
    if (oc.oc) ocByNro.set(oc.oc, oc);
  }

  // Indexar Fact.cl Referencia por RUT+Folio. Puede haber varias entradas por
  // la misma factura (si tiene varias referencias). Guardamos todas.
  const factByRutFolio = new Map();
  for (const f of factclRows) {
    if (!f.rut || !f.folio) continue;
    const k = `${f.rut}|${f.folio}`;
    if (!factByRutFolio.has(k)) factByRutFolio.set(k, []);
    factByRutFolio.get(k).push(f);
  }

  // Indexar Informe de Compra por RUT+Folio (ya viene con una fila por factura).
  const compraByRutFolio = new Map();
  for (const c of compraRows) {
    if (!c.rut || !c.folio) continue;
    compraByRutFolio.set(`${c.rut}|${c.folio}`, c);
  }

  // ── Factoring: índice de reviews originales por folio ──────────────
  // Cuando una factura se factoriza, la original (de su proveedor) desaparece y
  // reaparece con el MISMO folio pero el RUT de la empresa de factoring. Para
  // enlazar la cedida con su original (y heredar el comentario) indexamos las
  // reviews existentes por folio. Ignoramos las fantasma (FCL|).
  const reviewsByFolio = new Map();
  for (const [rk, rev] of Object.entries(reviews || {})) {
    if (!rev || String(rk).startsWith("FCL|")) continue;
    const [rut = "", folio = "", tipoDoc = ""] = String(rk).split("|");
    if (!folio) continue;
    if (!reviewsByFolio.has(folio)) reviewsByFolio.set(folio, []);
    reviewsByFolio.get(folio).push({ rut, tipoDoc, key: rk, nota: rev.nota || "", snapshot: rev.snapshot || null });
  }
  // Monto de comparación robusto: prioriza la deuda original (abono/cargo) sobre
  // el saldo, que muta con pagos parciales.
  const montoDe = (x) => Math.max(
    Math.abs(x.abonoTotal || 0), Math.abs(x.cargoTotal || 0), Math.abs(x.saldo || 0)
  );
  // Facturas presentes en el Defontana actual (rut|folio): la detección
  // automática solo aplica si la original YA NO está presente (fue factorizada).
  const presentRutFolio = new Set(defontanaInvoices.map(d => `${d.rut}|${d.folio}`));

  return defontanaInvoices.map(inv => {
    const k = `${inv.rut}|${inv.folio}`;
    const factRefs = factByRutFolio.get(k) || [];

    // Buscar la primera referencia que sea una OC válida en el TMS
    let ocLinked = null;
    let nRef = "";
    for (const f of factRefs) {
      if (f.nReferencia && ocByNro.has(f.nReferencia)) {
        ocLinked = ocByNro.get(f.nReferencia);
        nRef = f.nReferencia;
        break;
      }
    }
    // Si no encontramos OC en el TMS, al menos registrar el N Referencia
    // declarado por Fact.cl (informativo, no dispara alerta).
    if (!nRef) {
      const first = factRefs.find(f => f.nReferencia);
      if (first) nRef = first.nReferencia;
    }

    const tieneRefOC = !!ocLinked;
    const isContado = inv.condicion === "2CONTADO";
    const isNomina  = inv.condicion === "1NOMINA";
    const rutNorm = normalizeRut(inv.rut);
    const enHistoricoCredito = historicoCreditoSet.has(rutNorm);

    // ── Factoring / cesión de crédito ──────────────────────────────
    // Es "cedida" si su RUT está en la lista de factoring, o si comparte
    // folio+monto con un review existente de OTRO RUT cuya factura ya no está
    // en el Defontana (la original que fue factorizada). En ese caso heredamos
    // proveedor original y comentario de la original (solo lectura en la UI).
    let esFactoring = factoringByRut.has(rutNorm);
    let factoringNombre = factoringByRut.get(rutNorm) || "";
    let cedidaDe = null;
    let notaHeredada = "";
    let keyOriginal = "";
    const montoInv = montoDe(inv);
    const candidatos = (reviewsByFolio.get(inv.folio) || []).filter(c => {
      if (normalizeRut(c.rut) === rutNorm) return false;             // distinto RUT
      if (presentRutFolio.has(`${c.rut}|${inv.folio}`)) return false; // la original ya no debe estar
      return true;
    });
    let matchOrig = candidatos.find(c => {
      const montoOrig = montoDe(c.snapshot || {});
      return montoOrig > 0 && Math.abs(montoOrig - montoInv) < 1;
    });
    // Fallback: si la original no tiene snapshot con monto pero es la única con
    // ese folio, la tomamos igual (folios son por-emisor → poca ambigüedad).
    if (!matchOrig && candidatos.length === 1 && !candidatos[0].snapshot) {
      matchOrig = candidatos[0];
    }
    if (matchOrig) {
      const sm = matchOrig.snapshot || {};
      cedidaDe = { rut: matchOrig.rut, proveedor: sm.proveedor || "" };
      notaHeredada = matchOrig.nota || "";
      keyOriginal = matchOrig.key;
      esFactoring = true;                                  // detección automática
      if (!factoringNombre) factoringNombre = inv.proveedor; // el RUT actual es la factoring
    }

    // Fecha de emisión real SII: preferimos el Informe de Compra (col Z),
    // porque es del documento actual. Si no está, caemos al archivo de
    // Referencia (col K), pero OJO: esa fecha puede ser de la OC referenciada
    // y no del documento emitido.
    const compra = compraByRutFolio.get(k);
    const factRefFecha = factRefs.find(f => f.fecha)?.fecha || "";
    const factEmision = compra?.fechaEmision || factRefFecha;
    const fechaEmisionFact = factEmision;
    const fuenteFecha = compra?.fechaEmision ? "informe_compra" : (factRefFecha ? "referencia" : "");

    // Regla NOMINA: vencimiento debe ser >= 28 días después de la emisión.
    // Si no hay fecha de emisión en Fact.cl → sospechosa (no se puede validar plazo).
    let nominaPlazoSospechoso = false;
    let diasPlazo = null;
    let motivoNomina = "";
    if (isNomina) {
      const dEm = toDate(factEmision);
      const dVe = toDate(inv.vencimiento);
      if (!dEm) {
        nominaPlazoSospechoso = true;
        motivoNomina = "NÓMINA sin fecha de emisión en Fact.cl — no se puede validar plazo";
      } else if (dVe) {
        diasPlazo = daysBetween(dEm, dVe);
        if (diasPlazo < 28) {
          nominaPlazoSospechoso = true;
          motivoNomina = `NÓMINA con plazo de ${diasPlazo} día${diasPlazo === 1 ? "" : "s"} (emisión ${factEmision} → vencimiento ${inv.vencimiento}) — debería ser ≥ 28`;
        }
      }
    }

    // Regla INGRESO TARDÍO: Defontana col F es la fecha en que se ingresó la
    // factura a contabilidad (no la de emisión). Si entre la emisión real
    // (Fact.cl col K) y el ingreso Defontana hay > 8 días, la factura quedó
    // "guardada" antes de entrar al sistema. Aplica a todas las condiciones.
    let ingresoTardioSospechoso = false;
    let diasIngreso = null;
    let motivoIngreso = "";
    const dEmFactIng = toDate(factEmision);
    const dIngreso = toDate(inv.fechaFactura);
    if (dEmFactIng && dIngreso) {
      diasIngreso = daysBetween(dEmFactIng, dIngreso);
      if (diasIngreso > 8) {
        ingresoTardioSospechoso = true;
        motivoIngreso = `Ingresada a Defontana ${diasIngreso} día${diasIngreso === 1 ? "" : "s"} después de la emisión SII (Fact.cl ${factEmision} → Defontana ${inv.fechaFactura}) — plazo legal ≤ 8`;
      }
    }

    // Una factura cedida (factoring) llega sin OC y como asiento/CONTADO: no debe
    // marcarse sospechosa por la regla contado/sin-OC. Las reglas de plazo NÓMINA
    // e ingreso tardío sí se mantienen (son independientes de la cesión).
    const sospechosaContado = isContado && (tieneRefOC || enHistoricoCredito) && !esFactoring;
    const sospechosa = sospechosaContado || nominaPlazoSospechoso || ingresoTardioSospechoso;

    const alertas = [];
    if (sospechosaContado) {
      if (tieneRefOC) {
        alertas.push(`Ingresada al CONTADO pero tiene OC ${nRef} (${ocLinked.formapago || "crédito"}) — debería ser NÓMINA`);
      } else {
        alertas.push(`Ingresada al CONTADO pero el proveedor aparece en el histórico de crédito — debería ser NÓMINA`);
      }
    }
    if (esFactoring) {
      const orig = cedidaDe ? (cedidaDe.proveedor || cedidaDe.rut) : "";
      alertas.push(`Factura cedida (factoring${factoringNombre ? " " + factoringNombre : ""})${orig ? ` — proveedor original ${orig}` : ""}`);
    }
    if (nominaPlazoSospechoso) alertas.push(motivoNomina);
    if (ingresoTardioSospechoso) alertas.push(motivoIngreso);
    const alerta = alertas.join(" · ");

    return {
      ...inv,
      nReferencia: nRef,
      ocFormapago: ocLinked?.formapago || "",
      ocTotal: ocLinked?.total || 0,
      ocEstado: ocLinked?.estado || "",
      ocProveedor: ocLinked?.proveedor || "",
      ocFecha: ocLinked?.fecha || "",
      ocCreadaPor: ocLinked?.creadaPor || "",
      ocSucursal: ocLinked?.sucursal || "",
      tieneRefOC,
      enHistoricoCredito,
      fechaEmisionFact,
      fuenteFecha,
      diasPlazo,
      nominaPlazoSospechoso,
      diasIngreso,
      ingresoTardioSospechoso,
      esFactoring,
      factoringNombre,
      cedidaDe,
      notaHeredada,
      keyOriginal,
      sospechosa,
      alerta,
    };
  });
}

// ─── FANTASMAS: aceptadas en SII pero sin registro en Defontana ────
// Cruza el set de facturas Defontana (RUT+Folio) contra los archivos de
// Facturación.cl (Informe de Compra y Referencia). Devuelve filas con la
// misma forma que las del listado principal para reutilizar el sistema de
// revisiones; key con prefijo `FCL|` para no chocar con keys de Defontana.
//
// Los parsers de Fact.cl ya filtran sólo facturas (33/34). Del lado Defontana
// el set "enDefontana" considera únicamente filas cuyo Documento empieza con
// "Factura", para no matchear contra notas de crédito o débito que casualmente
// compartan folio.
export function findFactCLSinDefontana(defontanaInvoices, compraRows = [], factclRows = []) {
  const enDefontana = new Set();
  for (const inv of defontanaInvoices) {
    if (!inv.rut || !inv.folio) continue;
    const td = String(inv.tipoDoc || "").toLowerCase();
    if (!td.startsWith("factura")) continue;
    enDefontana.add(`${inv.rut}|${inv.folio}`);
  }

  // Preferimos Informe de Compra porque trae fecha de emisión real SII.
  const candidatos = new Map();
  for (const c of compraRows) {
    if (!c.rut || !c.folio) continue;
    const k = `${c.rut}|${c.folio}`;
    if (candidatos.has(k)) continue;
    candidatos.set(k, {
      rut: c.rut,
      folio: c.folio,
      proveedor: c.razonSocial,
      tipoDoc: c.documento || c.tipoDoc,
      tipoDocCode: c.tipoDoc || "",
      monto: c.montoTotal || 0,
      fechaEmision: c.fechaEmision || c.fechaCreacion || "",
      fuente: "informe_compra",
    });
  }
  for (const f of factclRows) {
    if (!f.rut || !f.folio) continue;
    const k = `${f.rut}|${f.folio}`;
    if (candidatos.has(k)) continue;
    candidatos.set(k, {
      rut: f.rut,
      folio: f.folio,
      proveedor: f.razonSocial,
      tipoDoc: f.documento || `Factura electrónica (cód. ${f.tipoDoc})`,
      tipoDocCode: f.tipoDoc || "",
      monto: f.monto || 0,
      fechaEmision: f.fecha || f.fechaAceptacion || "",
      fuente: "referencia",
    });
  }

  const fantasmas = [];
  for (const [k, row] of candidatos) {
    if (enDefontana.has(k)) continue;
    // Key estable por RUT+Folio. Antes incluía el código de tipo de documento
    // al final, pero ese código varía según la fuente del fantasma (Informe de
    // Compra trae "33"/"34"; Referencia trae el texto), así que si entre cargas
    // cambiaba la fuente la key cambiaba y la review marcada quedaba huérfana.
    // applyReviewState recupera reviews viejas con el 4º segmento por fallback.
    const fantasmaKey = `FCL|${k}`;
    fantasmas.push({
      key: fantasmaKey,
      rut: row.rut,
      rutRaw: row.rut,
      folio: row.folio,
      folioRaw: row.folio,
      tipoDoc: row.tipoDoc,
      proveedor: row.proveedor,
      condicion: "",
      fechaFactura: row.fechaEmision,
      vencimiento: "",
      vencimientos: [],
      cargoTotal: row.monto,
      abonoTotal: 0,
      saldo: row.monto,
      pagada: false,
      tieneCompra: false,
      tieneEgreso: false,
      movimientos: 0,
      soloEnFactCL: true,
      fuenteFantasma: row.fuente,
      nReferencia: "",
      ocFormapago: "",
      ocTotal: 0,
      ocEstado: "",
      ocProveedor: "",
      ocFecha: "",
      ocCreadaPor: "",
      ocSucursal: "",
      tieneRefOC: false,
      enHistoricoCredito: false,
      fechaEmisionFact: row.fechaEmision,
      fuenteFecha: row.fuente,
      diasPlazo: null,
      nominaPlazoSospechoso: false,
      diasIngreso: null,
      ingresoTardioSospechoso: false,
      sospechosa: true,
      alerta: "Aceptada en SII pero sin registro en Defontana",
    });
  }

  return fantasmas;
}

// Utilidades para filtrar por estado de revisión
export const REVIEW_STATES = {
  PENDIENTE: "PENDIENTE",
  OK: "OK",
  REVISAR: "REVISAR",
  REVISADA: "REVISADA",
};

export function applyReviewState(invoices, reviews) {
  // reviews: { [key]: { estado, nota, updated_at } }
  // Índice secundario por rut|folio (sin tipoDoc) para recuperar el estado
  // si el texto de tipoDoc varió entre exports de Defontana (ej. "Factura
  // Compra Electrónica" vs variantes con espacios/acentos distintos). Sólo
  // para reviews del flujo principal — los fantasma (prefijo "FCL|") se
  // excluyen porque su key tiene otra forma.
  const byRutFolio = {};
  // Índice paralelo para las reviews fantasma (FCL|), agrupadas por
  // FCL|rut|folio e ignorando un posible 4º segmento (tipoDocCode) que traían
  // las keys viejas. Permite que una fila fantasma con key estable FCL|rut|folio
  // recupere su estado aunque la review se guardara antes con el código de tipo
  // de documento al final.
  const fclByRutFolio = {};
  for (const [k, rev] of Object.entries(reviews || {})) {
    if (!rev || !k) continue;
    const ks = String(k);
    if (ks.startsWith("FCL|")) {
      const parts = ks.split("|");          // ["FCL", rut, folio, tipoDocCode?]
      if (parts.length < 3 || !parts[1] || !parts[2]) continue;
      const idx = `FCL|${parts[1]}|${parts[2]}`;
      const prev = fclByRutFolio[idx];
      if (!prev || String(rev.updated_at || "") > String(prev.updated_at || "")) {
        fclByRutFolio[idx] = rev;
      }
      continue;
    }
    const parts = ks.split("|");
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const idx = `${parts[0]}|${parts[1]}`;
    const prev = byRutFolio[idx];
    if (!prev || String(rev.updated_at || "") > String(prev.updated_at || "")) {
      byRutFolio[idx] = rev;
    }
  }

  return invoices.map(inv => {
    let rev = reviews?.[inv.key];
    if (!rev) {
      const key = String(inv.key || "");
      if (key.startsWith("FCL|")) {
        const parts = key.split("|");
        if (parts.length >= 3) rev = fclByRutFolio[`FCL|${parts[1]}|${parts[2]}`];
      } else if (inv.rut && inv.folio) {
        rev = byRutFolio[`${inv.rut}|${inv.folio}`];
      }
    }
    return {
      ...inv,
      estadoRev: rev?.estado || REVIEW_STATES.PENDIENTE,
      nota: rev?.nota || "",
      revUpdatedAt: rev?.updated_at || "",
    };
  });
}
