# Subastas Fruver - Mercaldas

Antes se llamaba «Comparador de Cotizaciones»; desde el 2026-11-06 el nombre visible es **Subastas Fruver**. Los nombres internos (repositorio, carpetas, servicio `ComparadorMercaldas` y dominio `comparador.mercaldas-apps.com`) no cambiaron.

Aplicación web interna para comparar cotizaciones de proveedores de frutas y verduras, negociar precios, distribuir el pedido por proveedor, emitir órdenes de compra en PDF y medir la gestión de compra.

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Servidor | Node.js 20 + Express (`src/server.js`) |
| Base de datos | SQLite con `better-sqlite3` (`data/cotizaciones.db`) |
| Excel | `exceljs` (generar/leer) y `xlsx` (leer) |
| Cargas de archivos | `multer` |
| Sesión | `cookie-parser` (sesión por cookie; tres roles en `src/auth.js`) |
| Correo | `nodemailer` (recuperación de contraseña y avisos; `src/correo.js`) |
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

## Usuarios y roles

| Rol | Qué hace | Página |
|---|---|---|
| `admin` | Todo el sistema: subastas, comparativo, negociación, pedidos, OC, configuración y usuarios | `index.html` |
| `planeacion` | Resumen de productos en subasta (sin proveedores ni precios), demanda, distribución, pedido por proveedor y OC desde Pedidos (sin el menú Órdenes de compra) | `index.html` (solo 2 pestañas) |
| `proveedor` | Portal: cotiza las subastas de sus productos, responde contrapropuestas y agrega productos a su stock, sin Excel | `proveedor.html` |

- Login con usuario o correo. Bloqueo de 15 min tras 5 intentos fallidos y límite por IP. Contraseñas de 8+ caracteres con letras y números.
- Recuperación por correo: enlace de un solo uso que vence en 60 min (`login.html?token=`). Las sesiones guardan el hash del token.
- El admin puede dar una contraseña temporal: el usuario debe cambiarla al entrar (`debe_cambiar_password`).
- El proveedor se registra solo (`/api/auth/registro`) y queda `pendiente` hasta que el admin lo aprueba y lo vincula a un proveedor de `proveedores`.
- Planeación solo pasa por las rutas de `PERMISOS_PLANEACION` (server.js); en `/api/pedidos*` se le vacían los precios ofertados y las contrapropuestas.
- Todo evento de seguridad queda en la tabla `bitacora` (pestaña Usuarios → Bitácora de seguridad).

## Estructura principal

- `src/server.js`: servidor y la mayoría de las rutas (cotizaciones, comparativo, negociación, pedidos, exportaciones).
- `src/auth.js`: login, recuperación, registro de proveedores, permisos por rol y páginas protegidas.
- `src/usuarios_admin.js`: pestaña Usuarios (crear, buscar, editar, eliminar, contraseña, aprobar proveedores, bitácora).
- `src/subastas.js`: solicitudes de cotización a proveedores y resumen para Planeación.
- `src/calendario.js`: horario de la semana (abre viernes 6:00 a.m., cierra lunes 7:00 p.m., contrapropuestas a las 7:00 p.m.) y el interruptor `TAREAS_AUTOMATICAS`.
- `src/automatizacion.js`: tareas que corren solas cada minuto: abrir la semana el viernes a las 6:00 a.m. y enviar las contrapropuestas de viernes a lunes a las 7:00 p.m.
- `src/portal_proveedor.js`: portal del proveedor (ofertas, respuesta a contrapropuestas y su stock en «Mis productos»).
- `src/notificaciones.js` y `src/correo.js`: avisos de la campana y correos.
- `src/db.js`: conexión a SQLite.
- `src/ordenes_compra.js`: órdenes de compra por proveedor, numeración y rutas de PDF. También registra el módulo de indicadores.
- `src/oc_pdf.js`: PDF de la orden de compra (formato OC-1068, logo Mercaldas).
- `src/indicadores_compra.js`: indicadores de compra por proveedor y evolución de precios (solo lectura).
- `src/negociacion_hoja.js` y `src/negociacion_lector.js`: hoja de negociación en Excel (generación y lectura del precio final), cálculo de la contrapropuesta del sistema y publicación en el portal (la usan el botón manual y el envío automático).
- `public/marca/`: logo de Mercaldas con fondo transparente (`mercaldas-logo.png`) e ícono cuadrado (`mercaldas-icono.png`); `public/favicon.ico`. Van en git y se promueven.
- `public/assets/logo-mercaldas.{png,jpg}`: logo opcional para el PDF de las OC (se sube en Configuración; no está en git ni se promueve). Si no existe, el PDF usa `public/marca/mercaldas-icono.png`.

## Identidad visual

- Colores del logo: verde `#038A41` (botones y acciones), verde hoja `#02672F` (textos de marca y encabezados de tabla), amarillo `#FCF103` (ítem activo del menú, como el letrero de la tienda, siempre con texto `#02582A`) y rojo `#D7141B` (contador de avisos y acciones peligrosas). Todo está en variables CSS en `public/styles.css`, con modo oscuro.
- Tipografía: Barlow (texto e interfaz, cifras tabulares en tablas) y Barlow Semi Condensed (títulos y cifras grandes).
- El menú lateral agrupa las pestañas por etapa: Cotizar, Negociar, Comprar y Administrar.

## Pestañas de la aplicación

1. **Cargar cotizaciones**: semana de trabajo y carga de Excel de proveedores que no usan el portal.
2. **Subastas**: solicitudes de cotización (productos, cantidad estimada, plazo) y seguimiento de quién respondió.
3. **Comparativo / Alertas / Productos en Promoción / Por Proveedor**: análisis de las cotizaciones.
4. **Negociación** (hoja unificada) y **Negociación (anterior)**: rondas de propuesta, contrapropuesta y precio final por proveedor y PLU. La hoja tiene «Enviar contrapropuesta al portal del proveedor»; el Excel queda para proveedores sin acceso.
5. **Pedidos**: demanda de la semana, distribución por porcentajes entre proveedores y pedido por proveedor (con recuadro de proveedores, vista previa y botón de generar OC).
6. **Órdenes de Compra**: listado de las órdenes emitidas.
7. **Indicadores de compra**: compra por proveedor (valor, participación, concentración) y evolución de precios (variación contra la semana anterior y tendencia de 6 semanas), con descarga a Excel.
8. **Configuración**: proveedores (con «Descargar proveedores»: Excel con hoja Proveedores —NIT, productos y cuenta del portal— y hoja Productos —NIT Proveedor, Proveedor, PLU, Descripción, presentación, tipo y frecuencia—, solo admin), catálogo, ciclos, logo y «Descargar respaldo» (copia completa de la base para guardarla fuera del servidor, solo admin).
9. **Usuarios**: administración de cuentas y aprobación de proveedores registrados.
10. **Productos en subasta** (solo Planeación): avance por producto sin datos de proveedores.

## Flujo semanal

1. **Viernes 6:00 a.m.** (sola, `src/automatizacion.js`): se abre la semana (ciclo, ej. `COT-2026-46`), se cierra la semana anterior si seguía activa, y se envía la **solicitud de cotización** (`solicitudSemanal` en `src/subastas.js`) con todos los productos que tienen proveedor activo y plazo hasta el **lunes a las 7:00 p.m.**; cada proveedor recibe aviso en la campana y correo solo de sus productos (`proveedor_productos` activo). El admin también puede abrir la semana a mano, cualquier día: la solicitud sale en ese momento y los proveedores la ven de inmediato en su portal (el viernes a las 6:00 a.m. ya no se envía otra). Lo que coticen antes del viernes recibe la contrapropuesta automática el viernes a las 7:00 p.m. Si la semana ya tiene una solicitud, si el admin la cerró o si ya se trabaja en una semana posterior, no se abre ni se envía otra. Para pedir productos extra se crea otra **subasta** a mano.
2. Los proveedores cotizan en el portal hasta la fecha límite (sus ofertas quedan en `quotes`, archivo «Portal proveedor - ciclo»). Quien no tenga acceso puede seguir enviando Excel.
3. **De viernes a lunes, a las 7:00 p.m.** (sola): a cada proveedor con cuenta en el portal le llega la **contrapropuesta** de lo que cotizó y aún no se negociaba: el precio más bajo de la semana (entre todos los proveedores, también los de Excel) menos el % de contrapropuesta de Cargar cotizaciones, redondeado hacia abajo a la centena. Se crea o se amplía su negociación, se publica en su portal y recibe aviso y correo; los admins reciben un resumen en la campana y queda en la bitácora. Lo que ya tiene contrapropuesta no se puede cambiar desde la solicitud; lo demás se puede seguir cotizando y sale en el envío del día siguiente (el último es el lunes a las 7:00 p.m.). El admin puede enviarla antes con «Enviar contrapropuesta al portal», y los proveedores sin cuenta se siguen negociando a mano (Iniciar negociación + Excel). El proveedor acepta, mantiene su precio o propone uno intermedio; su respuesta queda como **precio final**, igual que con el Excel.
4. Cargar la **demanda** (planeación) y la **distribución** por porcentajes (el total por PLU debe ser 100 %; las celdas en 0 o vacías se ignoran).
5. Aplicar la distribución: genera `pedido_asignaciones`.
6. Generar una **orden de compra por proveedor** (PDF) con el precio final negociado. Si falta el precio final de algún producto, la orden se bloquea y se lista lo que falta.
7. Revisar la pestaña de indicadores.

## Modelo de datos (tablas clave)

- `quotes` (cotizaciones: `codigo`, `precio`, `proveedor`, `semana`, `ciclo_id`) y `files`.
- `catalogo` (`codigo`, `producto`, `presentacion`) y `proveedores_info` (nombre y NIT).
- `proveedor_productos` (stock de cada proveedor: `tipo` habitual/adicional, `frecuencia`, `activo`, `disponible_hasta` para los temporales).
- `negociaciones_unificadas` (`ciclo_id`, `proveedor`, `estado`) y `negociacion_unificada_productos` (`codigo`, `propuesta_inicial`, `contrapropuesta_mercaldas`, `propuesta_final_proveedor`, `precio_final`).
- `demandas_pedido` (`ciclo_id`, `periodo`), `demanda_pedido_detalles` (`codigo`, `cantidad_requerida`), `pedido_distribucion_porcentajes` y `pedido_asignaciones` (`proveedor`, `cantidad_asignada`, `orden_compra_id`).
- `ordenes_compra_v2` (`numero` único, `proveedor`, `ciclo_id`, `periodo`) y `settings` (consecutivo en `oc_consecutivo_v2`).
- `usuarios` (`tipo` admin/planeacion/proveedor, `email`, `estado` activo/inactivo/pendiente/rechazado, `proveedor_nombre`, bloqueo y `debe_cambiar_password`), `sesiones` (hash del token), `tokens_recuperacion`, `notificaciones` y `bitacora`.
- `subastas` (`ciclo_id`, `fecha_limite`, `estado` borrador/abierta/cerrada), `subasta_productos` y `subasta_proveedores` (notificado, visto, respondió).
- `negociacion_publicaciones`: rondas de contrapropuesta enviadas al portal (el proveedor solo ve lo publicado).

## Variables de entorno

`PORT`, `HOST` (`127.0.0.1` para escuchar solo dentro del servidor), `DATA_DIR`, `APP_ENV=dev`, `ADMIN_PASSWORD` (solo al crear la base), `APP_URL` (enlaces de los correos), `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `CORREO=0` (apaga el correo del todo: avisos solo en la campana, sin recuperación de contraseña ni invitaciones; así está producción), `COOKIE_SECURE` (opcional) y `TAREAS_AUTOMATICAS` (las tareas del viernes 6:00 a.m. y de las 7:00 p.m. corren por defecto en producción y quedan apagadas con `APP_ENV=dev`; `1` las enciende y `0` las apaga). Sin SMTP los correos se escriben en el registro del servidor. Ver `.env.example`.

## Reglas de negocio importantes

- **Ciclo**: `COT-AAAA-NN`; **periodo**: `LUNES-MARTES`, etc. Cada semana conserva sus propios archivos y datos.
- **Calendario del ciclo** (`calcularVentanaRecepcion` en `src/analytics.js` y horas en `src/calendario.js`): recepción de **viernes 6:00 a.m. a lunes 7:00 p.m.** (hora Colombia) y vigencia de precios de **miércoles a martes**. `NN` es la semana ISO del miércoles en que empiezan a regir los precios. Una semana creada con un calendario anterior (jueves a sábado, viernes a martes) se ajusta al abrirla, solo si todavía no tiene cotizaciones ni solicitudes.
- **Envíos automáticos**: el último corte de contrapropuestas procesado queda en `settings.contrapropuestas_auto_ultimo_corte` y la última semana abierta sola en `settings.apertura_auto_ciclo`. Si el servidor estaba apagado a la hora del envío, lo hace al arrancar mientras la semana no empiece a regir.
- **Renombrar un proveedor** (Configuración) cambia el nombre en todas las tablas que tengan columna `proveedor` o `proveedor_nombre` (cotizaciones, productos, usuarios del portal, negociaciones, solicitudes, pedidos y órdenes), así conserva su acceso y su historia. Si el nombre nuevo ya tiene datos de un proveedor eliminado, se rechaza sin cambiar nada.
- **Precio de la OC** = `precio_final` de la negociación del ciclo, buscado por proveedor + PLU con nombres normalizados (sin tildes, mayúsculas y espacios).
- **Numeración OC**: configurable entre 1 y 10000; el siguiente número es `oc_consecutivo_v2 + 1` y debe ser mayor que la última orden emitida.
- Moneda `es-CO` (`$9.500`) y hora de Bogotá (`America/Bogota`).
- Un PLU puede estar en la distribución aunque no esté en la demanda; el proveedor debe estar activo para ese PLU.
- **Mis productos (portal del proveedor)**: el proveedor agrega a su stock productos del catálogo que aún no ofrece. Toman del catálogo el PLU, el nombre y la presentación, y la frecuencia de cómo ya se cotiza ese PLU con otros proveedores (si nadie lo tiene, la más común en su stock). **Fijo** = `habitual`; **temporal** = `adicional` con `disponible_hasta` (máximo un año). Al día siguiente de esa fecha (hora Colombia) sale solo del stock (`activo = 0`). Queda activo de una vez, entra a la solicitud de cotización abierta para cotizarlo ya, y los administradores reciben aviso en la campana y en la bitácora. Si el admin lo pasa a habitual en Configuración, deja de ser temporal.

## Cómo se entregan los cambios

**Servidor Windows (comparador.mercaldas-apps.com):** servicio NSSM `ComparadorMercaldas` en el puerto interno 8006, Cloudflare Tunnel, código en `C:\planeacion\prod\comparador-cotizaciones`, Node 20 portátil en `C:\planeacion\prod\node20` (el servidor tiene Node 24 para otras aplicaciones y `node_modules` está compilado para Node 20), datos en `C:\planeacion\prod\datos` y respaldo diario con `scripts/respaldar_base.js`. El paso a paso está en `deploy/windows/LEEME.md` y el instalador en `deploy/windows/instalar-servicio.ps1`.

**Servidor Linux anterior:** los cambios se hacían con scripts Python de parche (en `/tmp`) que:

1. Se aplican primero en DEV (`--probar` hace una prueba sin escribir), con respaldo `.antes_*`, comprobación `node --check` y vuelta atrás automática si algo falla.
2. Se prueban en DEV (a veces copiando la base de producción a DEV con la API de respaldo de SQLite).
3. Se promueven a producción con un promotor (`/tmp/promover_*.py`): verifica que DEV = producción + parche, respalda código y base, reinicia el servicio, comprueba HTTP, registros y número de cotizaciones, se revierte solo si falla, y hace commit y push.

Los directorios `node_modules`, `data`, `.git`, `backups`, `assets` y `uploads` no se promueven.

## Pendientes conocidos

- La app no arranca con una base vacía: `pedido_asignaciones`, `files`, `proveedor_productos` y las tablas de negociación se crearon a mano en el servidor original y el código no las crea. Siempre se despliega con la base existente. Falta escribir su `CREATE TABLE` (también sería el primer paso para pasar a PostgreSQL).

- Configurar `APP_URL` y el SMTP en los servicios de DEV y producción, y correr `npm install` (nueva dependencia `nodemailer`).
- Agregar el correo a las cuentas antiguas de proveedores (usuario tipo `agro.andes`, sin correo): sin correo no reciben avisos por email ni pueden recuperar la contraseña.
- Fijar el número inicial de OC antes de emitir la primera orden real (el logo ya no es obligatorio: sin logo subido, el PDF usa el ícono de Mercaldas).
- Cargar demanda y distribución de la semana 43 (`COT-2026-43`); en el Excel de distribución hay que corregir la Guayaba Pera (PLU 14650), que suma 101 %.
- Revisar el reporte "Descargar Excel" de cotizaciones: filas duplicadas y semanas mezcladas (el origen está en la tabla `quotes`).
- Idea abierta: automatizar más la negociación (reglas de decisión automática) y agregar el indicador de ahorro entre propuesta inicial y precio final.
