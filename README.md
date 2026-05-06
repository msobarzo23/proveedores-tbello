# Proveedores TBELLO

Auditoría de facturas de proveedores cruzando 3 fuentes:

| Fuente            | Rol                                                   |
| ----------------- | ----------------------------------------------------- |
| **Defontana**     | Informe por Análisis — fuente principal de facturas.  |
| **Reporte OC**    | TMS — órdenes de compra con `Formapago`.              |
| **Facturación.cl**| Referencia factura ↔ OC (por `N Referencia`).         |

## Reglas de alerta (línea roja)

Una factura queda **SOSPECHOSA** si se cumple cualquiera:

1. **Contado con OC** — Defontana en `2CONTADO` con referencia a una OC del TMS, o RUT en histórico de crédito → debería ser `1NOMINA`.
2. **Plazo NÓMINA corto** — `1NOMINA` con menos de 28 días entre emisión SII y vencimiento.
3. **Ingreso tardío** — Defontana ingresada >8 días después de la emisión SII (plazo legal para declarar).

### Pestaña "Sin registro" (nuevo)

Facturas que **están aceptadas en SII (Fact.cl) pero no aparecen en el ledger Defontana cargado**. Detecta el caso típico de "se aceptó la factura pero faltó ingresarla a contabilidad", que antes pasaba desapercibido (la app asumía que toda factura ausente en Defontana ya estaba pagada). Para que esto funcione, exportar el Defontana **incluyendo facturas pagadas + pendientes** (sin filtrar por saldo ≠ 0).

## Flujo de revisión

1. **Carga**: subir los 3 archivos en *Carga* y pulsar *Guardar todo*.
2. **Principal**: facturas pendientes. Sospechosas en rojo. Acciones:
   - ✓ **OK** → al histórico.
   - 🚩 **Revisar** → a la pestaña *Problemas*.
   - Toggle *Mostrar pagadas*: por defecto oculta facturas con saldo 0; actívalo si necesitas verlas en el listado.
3. **Sin registro**: facturas en Fact.cl que faltan en Defontana. Acciones:
   - 🚩 **Revisar** → marcar para que contabilidad las ingrese. Cuando aparezcan en el siguiente Defontana, se auto-concilian a *Revisada*.
   - ✓ **OK** → descartar (no aplica).
4. **Problemas**: marcadas como *Revisar*. Cuando contabilidad las arregla:
   - ✓ **Revisada** / ✓ **OK** según corresponda.
5. **Histórico**: todo lo procesado. Reclasificable.

Estado persistido por `RUT + Folio + TipoDoc` (prefijo `FCL|` para fantasmas).

## Dos modos de persistencia

### Modo local (por defecto)
Sin configuración adicional, todo se guarda en `localStorage` del navegador.
Útil para probar. No se comparte entre usuarios/equipos.

### Modo Google Sheet (recomendado en prod)

1. Crear un Google Sheet nuevo.
2. *Extensiones → Apps Script*. Pegar el contenido de [`gas/Code.gs`](gas/Code.gs).
3. Ejecutar la función `setup` una vez (crea las hojas `Defontana`, `OC`,
   `FactCL`, `Reviews`).
4. *Implementar → Nueva implementación → tipo App web*:
   - Ejecutar como: **yo mismo**
   - Quién tiene acceso: **cualquiera** (o "cualquiera con enlace")
5. Copiar la URL `.../exec`.
6. En la app, pulsar ⚙️ arriba a la derecha, pegar la URL y guardar.

A partir de ahí, cada carga y cada click de revisión se sincroniza
al Google Sheet. Múltiples usuarios ven lo mismo en tiempo real
(al refrescar).

## Desarrollo

```bash
npm install
npm run dev     # vite dev server
npm run build   # genera dist/
```

## Estructura

```
src/
├── App.jsx                    # Shell principal, tabs, estado
├── main.jsx
├── components/
│   ├── Icons.jsx
│   ├── FileDrop.jsx           # zona de drag&drop reutilizable
│   ├── CargaTab.jsx           # pestaña de carga de los 3 archivos
│   ├── InvoiceTable.jsx       # tabla de facturas + acciones OK/Revisar
│   └── FantasmaTable.jsx      # tabla de facturas Fact.cl sin registro Defontana
└── lib/
    ├── parsers.js             # parsers de Defontana, OC, FactCL + agrupación
    ├── crossref.js            # motor de cruce y detección de sospechosas
    ├── gas.js                 # cliente Apps Script + fallback localStorage
    └── ui.js                  # helpers de formato
gas/
└── Code.gs                    # backend Apps Script para pegar en el Sheet
```
