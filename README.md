# Proveedores TBELLO

Auditoría de facturas de proveedores cruzando 3 fuentes:

| Fuente            | Rol                                                   |
| ----------------- | ----------------------------------------------------- |
| **Defontana**     | Informe por Análisis — fuente principal de facturas.  |
| **Reporte OC**    | TMS — órdenes de compra con `Formapago`.              |
| **Facturación.cl**| Referencia factura ↔ OC (por `N Referencia`).         |

## Regla de alerta (línea roja)

Se marca como **SOSPECHOSA** toda factura Defontana que:

1. Tenga condición `2CONTADO`, **y**
2. Tenga una referencia a OC en Fact.cl, **y**
3. Esa OC exista en el Reporte OC del TMS.

→ Debería estar como `1NOMINA` (crédito).

Facturas sin referencia a OC se ignoran (no disparan alerta).

## Flujo de revisión

1. **Carga**: subir los 3 archivos en la pestaña *Carga* y pulsar *Guardar todo*.
2. **Principal**: listado de facturas pendientes. Las sospechosas aparecen
   resaltadas en rojo. Por cada una puedes:
   - ✓ **OK** → se oculta del listado (se va al histórico).
   - 🚩 **Revisar** → pasa a la pestaña *Problemas*.
3. **Problemas**: facturas marcadas para revisar. Cuando contabilidad
   las arregla:
   - ✓ **Revisada** → se oculta (histórico).
   - ✓ **OK** → descartar, estaba bien.
4. **Histórico**: todo lo ya procesado. Si te equivocaste puedes volver
   a clasificarla.

El estado se persiste por `RUT + Folio + TipoDoc`, así que al resubir
Defontana no se pierde lo revisado.

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
│   └── InvoiceTable.jsx       # tabla de facturas + acciones OK/Revisar
└── lib/
    ├── parsers.js             # parsers de Defontana, OC, FactCL + agrupación
    ├── crossref.js            # motor de cruce y detección de sospechosas
    ├── gas.js                 # cliente Apps Script + fallback localStorage
    └── ui.js                  # helpers de formato
gas/
└── Code.gs                    # backend Apps Script para pegar en el Sheet
```
