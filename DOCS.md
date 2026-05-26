# Proveedores TBELLO — documentación operativa

Documento de referencia para entender la app de un vistazo y trabajar más rápido sobre ella.
Complementa al `README.md` (que está orientado al usuario final); este `DOCS.md` apunta a quién va a leer o tocar el código.

---

## 1. Qué hace la app

Cruza facturas de proveedores de **Transportes Bello** desde 4 fuentes para detectar facturas sospechosas, ya sea por mal ingreso contable, por plazo legal violado o porque faltan en Defontana.

- **URL pública:** https://proveedores-tbello.vercel.app/
- **Repo:** https://github.com/msobarzo23/proveedores-tbello
- **Carpeta local:** `C:\Users\Miguel Sobarzo\proveedores-tbello`

---

## 2. Stack y arquitectura

```
+---------------------------+         +---------------------------+
|  Frontend                 |  HTTPS  |  Google Apps Script       |
|  React 18 + Vite          | <-----> |  (Web App /exec)          |
|  Vercel (auto-deploy main)|         |  gas/Code.gs              |
+---------------------------+         +-----------+---------------+
            |                                     |
            | localStorage                        | Google Sheet
            v                                     v
   (data_defontana, data_oc,            Hojas: Defontana, OC, FactCL,
    data_factcl, data_compra,                  Compra, Reviews
    data_reviews, data_reviews_pending,
    data_pending_datasets, etc.)
```

- **Frontend:** React + Vite, sin librería de UI (estilos inline con tema oscuro). Única dependencia pesada: `xlsx` para leer/exportar Excel.
- **Backend:** Google Apps Script publicado como Web App. La hoja vive en Drive del equipo. **Importante:** los datos no van a una base de datos propia — todo es Sheet.
- **Persistencia local:** cada navegador guarda en `localStorage` y sincroniza al Sheet en cada acción. Si el POST falla, queda en cola y se reintenta en el siguiente `loadAll`.
- **Deploy:** push a `main` ⇒ Vercel construye y publica el frontend. Cambios en `gas/Code.gs` **no** se despliegan solos (ver §10).

---

## 3. Fuentes de datos (los 4 archivos)

| Archivo | Origen | Para qué sirve | Parser |
|---|---|---|---|
| **Defontana** | "Informe por Análisis" del ledger contable | Fuente principal de facturas: condición (1NOMINA / 2CONTADO), fecha de ingreso a contabilidad, vencimiento, RUT, folio, montos | `parseDefontana` |
| **Reporte OC** | TMS | Órdenes de compra con `Formapago` (crédito / contado) | `parseReporteOC` |
| **Referencia Fact.cl** | Facturación.cl | Vincula factura ↔ OC por `N Referencia` | `parseReferenciaFactCL` |
| **Informe de Compra Fact.cl** | Facturación.cl | Fecha real de emisión SII en col Z (fuente de verdad para el plazo legal) | `parseInformeCompraFactCL` |

> El **Defontana debe exportarse con facturas pagadas + pendientes** (sin filtrar por saldo). Si no, la pestaña "Sin registro" no funciona — la app necesita el universo completo para distinguir "no registrada" de "pagada".

### Histórico de crédito y factoring (auxiliares)

- **`historico.js`** carga un CSV publicado con la lista de RUTs que históricamente han operado a crédito. Se usa para gatillar la regla "CONTADO con histórico de crédito".
- **`factoring.js`** carga otro CSV con RUTs de empresas de factoring. A mayo 2026 la hoja está vacía; la detección automática por folio+monto cubre los casos.

---

## 4. Reglas de detección (línea roja)

Una factura queda **SOSPECHOSA** (fila roja) si se cumple **cualquiera**:

1. **Contado con OC o histórico de crédito.** `2CONTADO` pero tiene OC válida en el TMS o el RUT aparece en el histórico de crédito ⇒ debería ser `1NOMINA`.
2. **Plazo NÓMINA corto.** `1NOMINA` con menos de 28 días entre emisión SII y vencimiento.
3. **Ingreso tardío.** Defontana col F (fecha de ingreso a contabilidad) supera en más de 8 días a la fecha real de emisión SII. El plazo legal para declarar es 8 días.

**Excepción factoring:** una factura cedida llega sin OC y suele ingresarse como asiento/CONTADO. La regla #1 **no** la marca como sospechosa cuando se detecta cesión. Las reglas #2 y #3 sí siguen aplicando.

Toda la lógica está en `src/lib/crossref.js → buildCrossref`.

---

## 5. Pestañas y flujo de revisión

| Pestaña | Qué muestra | Acciones |
|---|---|---|
| **Carga** | Drop zones para los 4 archivos | Subir + `Guardar todo` |
| **Principal** | Facturas pendientes (estadoRev = PENDIENTE). Las sospechosas en rojo. | `OK` → al histórico · `Revisar` → Problemas · Toggle "Mostrar pagadas" |
| **Sin registro** | Facturas aceptadas en SII (Fact.cl) que **no** están en Defontana. Key con prefijo `FCL\|`. | `Revisar` (marca para que contabilidad ingrese) o `OK` (descartar). Tiene selector de estado y export Excel/PDF. |
| **Problemas** | Las marcadas como `REVISAR`. | `Revisada` o `OK` cuando se arregla. |
| **Histórico** | Todo lo procesado (`OK` + `REVISADA`). Reclasificable. | Filtro por estado, toggle pagadas. |

### Auto-conciliación

Al subir un Defontana nuevo:

- Facturas en `REVISAR` que **desaparecieron** del Defontana ⇒ se marcan `REVISADA` con nota "Conciliado".
- Fantasmas (`FCL|…`) que **aparecieron** en el nuevo Defontana ⇒ se marcan `REVISADA` (ya no son fantasma).

El estado anterior queda en `snapshot` para preservar proveedor/montos cuando la factura ya no esté en el ledger.

---

## 6. Estados de revisión y keys

```
PENDIENTE  → estado por defecto (no se guarda)
OK         → revisada y aceptada, sin acción pendiente
REVISAR    → marcada para que contabilidad la corrija
REVISADA   → ya corregida (o auto-conciliada)
```

**Formato de key:**
- Flujo principal: `RUT|Folio|TipoDoc` (ej. `761234567|12345|Factura Compra Electrónica`).
- Pestaña Sin registro: `FCL|RUT|Folio|TipoDocCode` (ej. `FCL|761234567|9876|33`).

**Fallback por RUT+Folio:** si el texto de `tipoDoc` cambia entre exports de Defontana (ej. "Factura Compra Electrónica" con espacio extra), `applyReviewState` recupera el estado por `RUT|Folio` para no perder la revisión.

**Gotcha importante:** las keys `FCL|` están **excluidas a propósito** del flujo principal (incluida la pestaña Histórico). `FantasmaTable` recibe todos los estados y filtra en UI con su propio selector.

---

## 7. Sincronización con el Google Sheet

Patrón general: **escribe local primero, luego intenta GAS**. Si GAS falla, marca pendiente y se reintenta.

### Datasets (los 4 archivos)

- Se suben en lotes de 250 filas vía `save_dataset` con flags `clear` (primer batch) e `isLast`.
- Si un batch falla → el dataset queda en `data_pending_datasets` y aparece botón "Reintentar" en la pestaña Carga. **No hay que volver a subir el archivo** — los datos ya están en `localStorage`.

### Reviews (cada click `OK`/`Revisar`/`Revisada`)

- Cada save toca dos LS keys: `data_reviews` (estado completo) y `data_reviews_pending` (lista de keys aún no confirmadas por GAS).
- Mutex (`withLsLock`) serializa todas las escrituras locales para evitar carreras cuando varios saves corren en paralelo (auto-conciliación, clicks rápidos).
- **`save_reviews_batch`** (commit `e6977cf`, mayo 2026): sube 250 reviews por POST con `LockService` del lado GAS. Es 30-50× más rápido que `save_review` uno por uno. Si el GAS desplegado es viejo y responde "acción desconocida", el cliente cae automáticamente a `save_review` per-item.
- **Banner naranjo:** se muestra arriba cuando hay reviews pendientes. Botón "Forzar sincronización ahora" llama a `forceSyncPendingReviews` con barra de progreso.
- **`beforeunload`:** si hay pendientes y se cierra la pestaña, avisa antes de salir.

### Por qué tanta paranoia con la sync

Una compañera trabajó meses marcando facturas. Sus revisiones quedaron sólo en su `localStorage` porque los POSTs a GAS fallaban silenciosamente. Sólo se descubrió cuando los números no cuadraban entre navegadores. Sin el banner + forzar sync + mutex + pending tracking, ese trabajo se hubiera perdido al limpiar caché. Cualquier cambio futuro en el flujo de saves **debe** preservar este invariante: una review marcada nunca se pierde sin dejar rastro visible.

---

## 8. Factoring / cesión de crédito

Cuando un proveedor cede una factura, en Defontana la factura original **desaparece** y reaparece con el **mismo folio** pero el RUT de la empresa de factoring. Sin manejo especial, el comentario de la original quedaría huérfano.

**Detección híbrida** en `buildCrossref`:

1. **Lista explícita** (`factoring.js`): RUTs de empresas de factoring conocidas (hoja actualmente vacía).
2. **Match automático por folio + monto:** si un folio aparece en el Defontana actual bajo otro RUT cuya factura original ya no está, y el monto coincide (±1), se considera cedida.

**Comportamiento:**
- La fila muestra badge morado **"Cedida"**, el proveedor original y el comentario heredado (de sólo lectura) en `notaHeredada`.
- Su propio comentario se guarda bajo **su** key, sin mutar la original.
- El filtro "Factoring / cedidas" en `InvoiceTable` permite aislarlas.
- La regla "CONTADO con OC/histórico" **no** dispara para cedidas (la cesión justifica el ingreso como contado).

---

## 9. Pestaña "Sin registro" (fantasmas)

Detecta facturas aceptadas en SII (presentes en Fact.cl) que **no** están en el Defontana cargado. Caso típico: "se aceptó la factura pero faltó ingresarla a contabilidad".

- Keys con prefijo `FCL|` para no chocar con las del flujo principal.
- `FantasmaTable` recibe **todos los estados** (no solo pendientes) y filtra en UI con un selector: "Por revisar" (default), "Revisadas/descartadas", "Todos".
- El badge de la pestaña sigue contando sólo pendientes (PENDIENTE + REVISAR).
- La bandera 🚩 (REVISAR) **no** envía a la pestaña Problemas — se queda en Sin registro.
- Export Excel (vía `xlsx`) y PDF (vía impresión del navegador con iframe oculto) en `src/lib/export.js`. Exportan lo filtrado/visible.

---

## 10. Configuración del backend GAS

### Hojas que crea `setup()`

`Defontana`, `OC`, `FactCL`, `Compra`, `Reviews`. La hoja `Reviews` tiene columnas: `key | estado | nota | updated_at | snapshot`.

### Endpoints expuestos

| Acción | Método | Para qué |
|---|---|---|
| `load_all` | GET | Devuelve los 5 datasets en un JSON |
| `save_dataset` | POST | Sube un dataset por lotes (con `clear` e `isLast`) |
| `save_review` | POST | Guarda una review |
| `save_reviews_batch` | POST | Guarda hasta 250 reviews atómicamente con `LockService` |

### URL por defecto

Está hardcodeada en `src/lib/gas.js`:

```js
DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycby.../exec";
```

El usuario puede sobreescribirla por navegador desde el panel ⚙️. Hay un sistema de versión (`URL_VERSION`) para invalidar URLs guardadas obsoletas.

### Deploy del backend (paso manual obligatorio)

Vercel **no** despliega `gas/Code.gs`. Cada vez que se modifique:

1. Abrir el Google Sheet asociado.
2. Extensiones → Apps Script.
3. Pegar el contenido del `gas/Code.gs` actualizado.
4. Guardar (Ctrl+S).
5. **Implementar → Administrar implementaciones → Editar → Versión nueva → Implementar.**
6. La URL `/exec` se mantiene (no hay que actualizar el frontend).

Cualquier feature del cliente que dependa de un endpoint nuevo en GAS **debe** incluir fallback automático para clientes corriendo contra un GAS viejo. El cliente ya lo hace para `save_reviews_batch`; mantener ese patrón.

---

## 11. Estructura de archivos

```
proveedores-tbello/
├── DOCS.md                          ← este archivo
├── README.md                        ← guía del usuario final
├── index.html
├── package.json
├── vite.config.js
├── gas/
│   └── Code.gs                      ← backend (pegar en Apps Script)
└── src/
    ├── main.jsx
    ├── App.jsx                      ← shell, tabs, estado global, auto-conciliación
    ├── components/
    │   ├── Icons.jsx
    │   ├── FileDrop.jsx             ← drag & drop reutilizable
    │   ├── CargaTab.jsx             ← pestaña Carga
    │   ├── InvoiceTable.jsx         ← tabla del flujo principal/problemas/histórico
    │   └── FantasmaTable.jsx        ← tabla Sin registro
    └── lib/
        ├── parsers.js               ← parsers de los 4 archivos + groupDefontanaByInvoice
        ├── crossref.js              ← motor de cruce + reglas + findFactCLSinDefontana
        ├── gas.js                   ← cliente Apps Script + fallback localStorage + sync
        ├── historico.js             ← CSV histórico de crédito
        ├── factoring.js             ← CSV factoring + normalizeRut
        ├── export.js                ← export Excel/PDF
        └── ui.js                    ← formato CLP, fechas, helpers visuales
```

---

## 12. Variables relevantes de localStorage

| Key | Contenido |
|---|---|
| `gas_url`, `gas_url_version` | URL personalizada del Web App (si la hay) |
| `data_defontana`, `data_oc`, `data_factcl`, `data_compra` | Datasets parseados |
| `data_reviews` | Diccionario `key → { estado, nota, updated_at, snapshot }` |
| `data_reviews_pending` | Lista de keys aún no confirmadas por GAS |
| `data_pending_datasets` | Datasets que fallaron al subir y deben reintentarse |
| `data_timestamps` | Última hora de save de cada dataset |

---

## 13. Cosas a tener presentes al tocar el código

- **No mutar `gas/Code.gs` sin desplegar manualmente.** Y siempre dejar fallback automático en el cliente.
- **Exclusión `FCL|` en App.jsx ~línea 198:** las keys de fantasma están excluidas a propósito del flujo principal. Removerlas rompería la pestaña Sin registro.
- **`withLsLock` en gas.js:** todo read+modify+write sobre `data_reviews` y `data_reviews_pending` debe ir adentro del lock. Sin él, saves paralelos se pisan.
- **`snapshot`:** se captura al marcar/notear para preservar proveedor/vencimiento/montos cuando la factura desaparezca de Defontana (auto-conciliación o cesión).
- **Normalización de RUT y folio:** siempre usar `normRut` / `normFolio`. La planilla mezcla RUTs con y sin puntos por fila; ver `feedback_csv_ventas_formato` en memoria.
- **Tipo doc en Fact.cl:** filtrar a `33` (factura electrónica) y `34` (factura exenta). Las guías (`52`) y notas de crédito/débito (`61`/`56`) deben excluirse.
- **Defontana col F vs Fact.cl col Z:** col F de Defontana es **fecha de ingreso a contabilidad**, no de emisión. La fecha de emisión real SII viene del Informe de Compra col Z (fallback: Referencia col K, pero esa fecha puede ser de la OC referenciada, no del documento).

---

## 14. Desarrollo

```powershell
cd "C:\Users\Miguel Sobarzo\proveedores-tbello"
npm install          # primera vez
npm run dev          # vite dev server
npm run build        # genera dist/ (lo mismo que Vercel)
npm run preview      # sirve el build local
```

Push a `main` ⇒ Vercel construye y publica automáticamente. **El frontend nunca toca producción del Sheet hasta que el usuario configura la URL** (o usa la default, que sí es la del Sheet del equipo).
