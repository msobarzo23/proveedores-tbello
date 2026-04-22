/**
 * Proveedores TBELLO — Google Apps Script backend
 *
 * Cómo usar:
 *   1. Crear un Google Sheet nuevo (o usar uno existente). Guardar su ID.
 *   2. Extensiones → Apps Script. Pegar este código completo.
 *   3. Ejecutar `setup` una vez (crea las hojas: Defontana, OC, FactCL, Reviews).
 *   4. Implementar → Nueva implementación → tipo: App web
 *      - Ejecutar como: yo mismo
 *      - Quién tiene acceso: cualquiera (o "cualquiera con enlace")
 *   5. Copiar la URL /exec y pegarla en el panel ⚙️ de la app.
 */

const SHEETS = {
  DEFONTANA: "Defontana",
  OC: "OC",
  FACTCL: "FactCL",
  REVIEWS: "Reviews",
};

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.values(SHEETS).forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  // Headers
  const rev = ss.getSheetByName(SHEETS.REVIEWS);
  if (rev.getLastRow() === 0) {
    rev.appendRow(["key", "estado", "nota", "updated_at"]);
  }
}

function doGet(e) {
  const action = e?.parameter?.action || "load_all";
  try {
    if (action === "load_all") return jsonOut(loadAll_());
    return jsonOut({ ok: false, error: "Acción desconocida: " + action });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "save_dataset") return jsonOut(saveDataset_(body));
    if (action === "save_review")  return jsonOut(saveReview_(body));
    return jsonOut({ ok: false, error: "Acción desconocida: " + action });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function loadAll_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Formatear Date objects como "dd/MM/yyyy" para mantener el formato
  // original de Defontana/OC/Fact.cl (Sheets los auto-convierte al guardar).
  const fmtDate = (d) => {
    if (!(d instanceof Date)) return d;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  };

  const readSheet = (name) => {
    const sh = ss.getSheetByName(name);
    if (!sh) return [];
    const values = sh.getDataRange().getValues();
    if (values.length < 2) return [];
    const headers = values[0];
    return values.slice(1).map(row => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = row[i] instanceof Date ? fmtDate(row[i]) : row[i];
      });
      return o;
    });
  };

  const defontana = readSheet(SHEETS.DEFONTANA);
  const oc = readSheet(SHEETS.OC);
  const factcl = readSheet(SHEETS.FACTCL);

  // Reviews → objeto keyed por key
  const revSheet = ss.getSheetByName(SHEETS.REVIEWS);
  const reviews = {};
  if (revSheet && revSheet.getLastRow() > 1) {
    const values = revSheet.getDataRange().getValues().slice(1);
    values.forEach(row => {
      const [key, estado, nota, updated_at] = row;
      if (key) reviews[key] = { estado, nota, updated_at };
    });
  }

  return { ok: true, defontana, oc, factcl, reviews };
}

function saveDataset_({ dataset, rows, clear, isLast }) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = {
    defontana: SHEETS.DEFONTANA,
    oc: SHEETS.OC,
    factcl: SHEETS.FACTCL,
  }[dataset];
  if (!name) throw new Error("Dataset inválido: " + dataset);

  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  if (clear) sh.clear();

  if (!rows || !rows.length) return { ok: true, count: 0 };

  // Si es la primera carga, escribir headers a partir de las claves del primer objeto.
  const headers = Object.keys(rows[0]);
  if (clear) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  const lastRow = sh.getLastRow();
  const values = rows.map(o => headers.map(h => o[h] ?? ""));
  sh.getRange(lastRow + 1, 1, values.length, headers.length).setValues(values);

  return { ok: true, count: rows.length, isLast: !!isLast };
}

function saveReview_({ key, estado, nota }) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.REVIEWS);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.REVIEWS);
    sh.appendRow(["key", "estado", "nota", "updated_at"]);
  }
  if (!key) throw new Error("key requerido");

  const now = new Date().toISOString();
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const keys = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i][0] === key) {
        sh.getRange(i + 2, 1, 1, 4).setValues([[key, estado, nota || "", now]]);
        return { ok: true, updated: true };
      }
    }
  }
  sh.appendRow([key, estado, nota || "", now]);
  return { ok: true, inserted: true };
}
