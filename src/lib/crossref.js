// Motor de cruce:
// Defontana (agrupado por factura) → Facturación.cl (por RUT+Folio) → N Referencia = OC
//                                                                       → Reporte OC (por Nro)
//                                → Histórico crédito (por RUT)
//
// Regla de alerta (línea roja):
//   Si la factura Defontana tiene condición 2CONTADO
//   Y (tiene una referencia a OC válida  ó  el RUT está en el histórico de crédito)
//   → SOSPECHOSA (debería estar como 1NOMINA).

import { normalizeRut } from "./historico";

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
    const enHistoricoCredito = historicoCreditoSet.has(normalizeRut(inv.rut));
    const sospechosa = isContado && (tieneRefOC || enHistoricoCredito);

    let alerta = "";
    if (sospechosa) {
      if (tieneRefOC) {
        alerta = `Ingresada al CONTADO pero tiene OC ${nRef} (${ocLinked.formapago || "crédito"}) — debería ser NÓMINA`;
      } else {
        alerta = `Ingresada al CONTADO pero el proveedor aparece en el histórico de crédito — debería ser NÓMINA`;
      }
    }

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
