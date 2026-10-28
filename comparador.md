# Comparador de Cotizaciones - Mercaldas

Aplicación web interna para comparar cotizaciones de proveedores de frutas y verduras, negociar precios, distribuir el pedido por proveedor, emitir órdenes de compra en PDF y medir la gestión de compra.

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Servidor | Node.js 20 + Express (`src/server.js`) |
| Base de datos | SQLite con `better-sqlite3` (`data/cotizaciones.db`) |
| Excel | `exceljs` (generar/leer) y `xlsx` (leer) |
| Cargas de archivos | `multer` |
| Sesión | `cookie-parser` (autenticación por cookie, roles con `requireAdmin`) |
| PDF | `pdfkit` (órdenes de compra, `src/oc_pdf.js`) |
| Front end | HTML + JavaScript puro (`public/index.html`, `public/app.js`), sin framework |
| Hosting | VPS Ubuntu 24.04, servicio `systemd`, sin Docker |
| Control de versiones | Git (el promotor hace commit y push a `origin` en cada paso a producción) |

## Entornos en el servidor

| Entorno | Carpeta | Servicio systemd |
|---|---|---|
| Producción | `/var/www/comparador-cotizaciones` (puerto 3000) | `comparador-cotizaciones` |
| Desarrollo (DEV) | `/var/www/comparador-cotizaciones-dev` | `comparador-cotizaciones-dev` (`APP_ENV=dev`) |

- Las OC emitidas en DEV salen con prefijo `PRUEBA-OC-`; en producción `OC-`.
- DEV se apaga cuando no se usa: `systemctl stop comparador-cotizaciones-dev`.
- Respaldos de código y base: `/var/backups/comparador-cotizaciones/<fecha_hora>/` con `revertir.sh` (y `--con-base-de-datos`).

## Estructura principal

- `src/server.js`: servidor y la mayoría de las rutas (cotizaciones, comparativo, negociación, pedidos, exportaciones).
- `src/db.js`: conexión a SQLite.
- `src/ordenes_compra.js`: órdenes de compra por proveedor, numeración y rutas de PDF. También registra el módulo de indicadores.
- `src/oc_pdf.js`: PDF de la orden de compra (formato OC-1068, logo Mercaldas).
- `src/indicadores_compra.js`: indicadores de compra por proveedor y evolución de precios (solo lectura).
- `src/negociacion_hoja.js` y `src/negociacion_lector.js`: hoja de negociación en Excel (generación y lectura del precio final).
- `src/avisos_proveedor.js`: aviso de semana nueva en el portal del proveedor (tabla `avisos_proveedor`).
- `public/assets/logo-mercaldas.{png,jpg}`: logo (ya cargado en Configuración; no está en git).

## Identidad visual

- El logo de Mercaldas ya está implementado en la aplicación.
- Todo el sistema usa los colores del logo (verde, amarillo y rojo de Mercaldas).

## Pestañas de la aplicación

1. **Cargar cotizaciones**: carga de los Excel de cada proveedor por semana.
2. **Comparativo / Alertas / Productos en Promoción / Por Proveedor**: análisis de las cotizaciones.
3. **Negociación** (hoja unificada) y **Negociación (anterior)**: rondas de propuesta, contrapropuesta y precio final por proveedor y PLU.
4. **Pedidos**: demanda de la semana, distribución por porcentajes entre proveedores y pedido por proveedor (con recuadro de proveedores, vista previa y botón de generar OC).
5. **Órdenes de Compra**: listado de las órdenes emitidas.
6. **Indicadores de compra**: compra por proveedor (valor, participación, concentración) y evolución de precios (variación contra la semana anterior y tendencia de 6 semanas), con descarga a Excel.
7. **Configuración**: proveedores, catálogo, ciclos y logo.

## Flujo semanal

1. Abrir el ciclo de la semana (ej. `COT-2026-43`) y cargar las cotizaciones. Al abrirlo, todos los proveedores ven en su portal un aviso para enviar su propuesta, y el formato de cotización arranca en blanco. El aviso se oculta cuando el proveedor lo marca como visto o envía su propuesta; en la tarjeta del ciclo se ve cuántos lo vieron y cuántos ya cotizaron.
2. Negociar y cerrar el **precio final** de cada producto por proveedor.
3. Cargar la **demanda** (planeación) y la **distribución** por porcentajes (el total por PLU debe ser 100 %; las celdas en 0 o vacías se ignoran).
4. Aplicar la distribución: genera `pedido_asignaciones`.
5. Generar una **orden de compra por proveedor** (PDF) con el precio final negociado. Si falta el precio final de algún producto, la orden se bloquea y se lista lo que falta.
6. Revisar la pestaña de indicadores.

## Modelo de datos (tablas clave)

- `quotes` (cotizaciones: `codigo`, `precio`, `proveedor`, `semana`, `ciclo_id`) y `files`.
- `catalogo` (`codigo`, `producto`, `presentacion`) y `proveedores_info` (nombre y NIT).
- `negociaciones_unificadas` (`ciclo_id`, `proveedor`, `estado`) y `negociacion_unificada_productos` (`codigo`, `propuesta_inicial`, `contrapropuesta_mercaldas`, `propuesta_final_proveedor`, `precio_final`).
- `demandas_pedido` (`ciclo_id`, `periodo`), `demanda_pedido_detalles` (`codigo`, `cantidad_requerida`), `pedido_distribucion_porcentajes` y `pedido_asignaciones` (`proveedor`, `cantidad_asignada`, `orden_compra_id`).
- `ordenes_compra_v2` (`numero` único, `proveedor`, `ciclo_id`, `periodo`) y `settings` (consecutivo en `oc_consecutivo_v2`).

## Reglas de negocio importantes

- **Ciclo**: `COT-AAAA-NN`; **periodo**: `LUNES-MARTES`, etc. Cada semana conserva sus propios archivos y datos.
- **Precio de la OC** = `precio_final` de la negociación del ciclo, buscado por proveedor + PLU con nombres normalizados (sin tildes, mayúsculas y espacios).
- **Numeración OC**: configurable entre 1 y 10000; el siguiente número es `oc_consecutivo_v2 + 1` y debe ser mayor que la última orden emitida.
- Moneda `es-CO` (`$9.500`) y hora de Bogotá (`America/Bogota`).
- Un PLU puede estar en la distribución aunque no esté en la demanda; el proveedor debe estar activo para ese PLU.

## Cómo se entregan los cambios

Los cambios se hacen con scripts Python de parche (en `/tmp`) que:

1. Se aplican primero en DEV (`--probar` hace una prueba sin escribir), con respaldo `.antes_*`, comprobación `node --check` y vuelta atrás automática si algo falla.
2. Se prueban en DEV (a veces copiando la base de producción a DEV con la API de respaldo de SQLite).
3. Se promueven a producción con un promotor (`/tmp/promover_*.py`): verifica que DEV = producción + parche, respalda código y base, reinicia el servicio, comprueba HTTP, registros y número de cotizaciones, se revierte solo si falla, y hace commit y push.

Los directorios `node_modules`, `data`, `.git`, `backups`, `assets` y `uploads` no se promueven.

## Pendientes conocidos

- Fijar el número inicial de OC antes de emitir la primera orden real.
- Cargar demanda y distribución de la semana 43 (`COT-2026-43`); en el Excel de distribución hay que corregir la Guayaba Pera (PLU 14650), que suma 101 %.
- Revisar el reporte "Descargar Excel" de cotizaciones: filas duplicadas y semanas mezcladas (el origen está en la tabla `quotes`).
- Idea abierta: automatizar más la negociación (reglas de decisión automática) y agregar el indicador de ahorro entre propuesta inicial y precio final.
