// Motor de cruce:
// Defontana (agrupado por factura) → Facturación.cl (por RUT+Folio) → N Referencia = OC
//                                                                       → Reporte OC (por Nro)
//                                → Histórico crédito (por RUT)
//
// Reglas de alerta (línea roja). Una factura queda SOSPECHOSA si se cumple cualquiera:
//   1. CONTADO con OC válida o RUT en histórico de crédito — debería ser NÓMINA.
//   2. NÓMINA con plazo emisión→vencimiento < 28 días.
//   3. Ingreso tardío: Defontana col F (fecha de ingreso a contabilidad) supera
//      en más de 8 días a Fact.cl col K (fecha real de emisión SII). El plazo
//      legal para declarar es 8 días; por eso el umbral.

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

export function buildCrossref(defontanaInvoices, ocRows, factclRows, historicoCreditoSet = new Set()) {
  // Indexar Reporte OC por Nro
  const ocByNro = new Map();
  for (const oc of ocRows) {
    if (oc.oc) ocByNro.set(oc.oc, oc);
  }

  // Indexar Fact.cl por RUT+Folio. Puede haber varias entradas por la misma
  // factura (si tiene varias referencias). Guardamos todas.
  const factByRutFolio = new Map();
  for (const f of factclRows) {
    if (!f.rut || !f.folio) continue;
    const k = `${f.rut}|${f.folio}`;
    if (!factByRutFolio.has(k)) factByRutFolio.set(k, []);
    factByRutFolio.get(k).push(f);
  }

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
    const enHistoricoCredito = historicoCreditoSet.has(normalizeRut(inv.rut));

    // Fecha de emisión la tomamos de Fact.cl (la más confiable para el SII).
    const factEmision = factRefs.find(f => f.fecha)?.fecha || "";
    const fechaEmisionFact = factEmision;

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

    const sospechosaContado = isContado && (tieneRefOC || enHistoricoCredito);
    const sospechosa = sospechosaContado || nominaPlazoSospechoso || ingresoTardioSospechoso;

    const alertas = [];
    if (sospechosaContado) {
      if (tieneRefOC) {
        alertas.push(`Ingresada al CONTADO pero tiene OC ${nRef} (${ocLinked.formapago || "crédito"}) — debería ser NÓMINA`);
      } else {
        alertas.push(`Ingresada al CONTADO pero el proveedor aparece en el histórico de crédito — debería ser NÓMINA`);
      }
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
      diasPlazo,
      nominaPlazoSospechoso,
      diasIngreso,
      ingresoTardioSospechoso,
      sospechosa,
      alerta,
    };
  });
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
  return invoices.map(inv => {
    const rev = reviews?.[inv.key];
    return {
      ...inv,
      estadoRev: rev?.estado || REVIEW_STATES.PENDIENTE,
      nota: rev?.nota || "",
      revUpdatedAt: rev?.updated_at || "",
    };
  });
}
