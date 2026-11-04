# Despliegue en Windows Server: comparador.mercaldas-apps.com

La app corre como servicio de Windows (NSSM) con un **Node.js 20 portátil propio** y la base SQLite en `C:\planeacion\prod\datos`.
Cloudflare Tunnel publica el dominio con HTTPS: no hace falta IIS, ni certificado en el servidor, ni abrir puertos.
La app solo escucha en `127.0.0.1:8006`.

```
Usuarios ──https──> Cloudflare ──túnel──> cloudflared (servicio) ──> http://127.0.0.1:8006 (ComparadorMercaldas)
                                                                        └─ C:\planeacion\prod\datos\cotizaciones.db
```

| Qué | Dónde |
|---|---|
| Código | `C:\planeacion\prod\comparador-cotizaciones` |
| Node 20 portátil (solo para el comparador) | `C:\planeacion\prod\node20\node.exe` |
| Datos, registros y respaldos | `C:\planeacion\prod\datos` |
| NSSM | `C:\NSSM\nssm.exe` |
| Puerto interno | `8006` (el 8004 lo usa otra aplicación) |

## 1. Node 20 portátil
- El servidor tiene **Node 24** para otras aplicaciones; no se cambia.
- La carpeta `node_modules` viene compilada para **Node 20**, y con Node 24 la base de datos no carga.
- Por eso el comparador usa su propio `node.exe` de Node 20 en `C:\planeacion\prod\node20\node.exe`. No se instala nada en el sistema.
- Se copia desde el equipo de desarrollo (`C:\Proyectos\para_servidor\node20\node.exe`) o se saca de `node-v20.20.2-win-x64.zip` en nodejs.org.

## 2. Código
- Copiar la carpeta completa `C:\Proyectos\comparador-cotizaciones` (incluidos `node_modules` y `public\assets`, el logo de las OC) a `C:\planeacion\prod\comparador-cotizaciones`.

## 3. Datos
- La base real es la del equipo de desarrollo (`localhost:3999`), con los proveedores ya unificados.
- Se saca una copia consistente y se pone en `C:\planeacion\prod\datos\cotizaciones.db`.
  - **No** se copia el archivo `.db` a mano mientras la app corre: puede quedar dañado.
- La app no arranca con una base vacía: siempre se usa la existente.

## 4. Instalar el servicio
En PowerShell **como administrador**, desde `C:\planeacion\prod\comparador-cotizaciones`:
```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\instalar-servicio.ps1 -Nssm C:\NSSM\nssm.exe `
  -Node C:\planeacion\prod\node20\node.exe -Datos C:\planeacion\prod\datos -Puerto 8006
```
El script:
- comprueba que la base de datos cargue con ese Node y que el puerto esté libre;
- crea el servicio `ComparadorMercaldas`, con inicio automático, reinicio si falla y registro en `C:\planeacion\prod\datos\logs`;
- deja los datos accesibles solo a Administradores y SYSTEM;
- programa el respaldo diario de las 2:00 a.m., que guarda 30 días;
- confirma que quien responde en el puerto es el comparador.

Así queda **sin correo y sin tareas automáticas**, para probar sin escribirles a los proveedores reales.
Prueba en el navegador del servidor: `http://127.0.0.1:8006` (no `localhost`).

## 5. Cloudflare Tunnel (túnel propio: `comparador-fruver`)
El servidor ya tiene otro servicio `cloudflared`, con un túnel compartido.
- Ese túnel publica otras aplicaciones de Mercaldas y está **administrado localmente**: sus rutas viven en un archivo de configuración del servidor y no se cambian desde el panel.
- **No se toca.**

El comparador usa un túnel aparte, administrado desde el panel, que corre como un segundo servicio con NSSM:
1. En Cloudflare → **Zero Trust → Networks → Tunnels**, el túnel **`comparador-fruver`** tiene la ruta `comparador.mercaldas-apps.com` → `http://127.0.0.1:8006`.
   - Se usa `127.0.0.1` y no `localhost`, porque `localhost` puede resolver a IPv6 y llegar a otro programa.
   - El DNS lo crea Cloudflare solo.
2. En el servidor, PowerShell **como administrador**. El token es el código que va después de `service install` en la página del túnel; es secreto y no se comparte:
   ```powershell
   $token = Read-Host "Token del túnel comparador-fruver"
   C:\NSSM\nssm.exe install CloudflaredComparador "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --no-autoupdate run --token $token
   C:\NSSM\nssm.exe set CloudflaredComparador DisplayName "Cloudflare Tunnel - Comparador"
   C:\NSSM\nssm.exe set CloudflaredComparador Start SERVICE_AUTO_START
   C:\NSSM\nssm.exe set CloudflaredComparador AppStdout C:\planeacion\prod\datos\logs\cloudflared.log
   C:\NSSM\nssm.exe set CloudflaredComparador AppStderr C:\planeacion\prod\datos\logs\cloudflared.log
   C:\NSSM\nssm.exe start CloudflaredComparador
   ```
3. Revisar que `Get-Service CloudflaredComparador` diga `Running` y que el túnel aparezca **Healthy** en el panel.

## 6. Probar
- Entrar en `https://comparador.mercaldas-apps.com` como admin, como Planeación y como proveedor.
- Cargar un Excel, descargar proveedores y generar el PDF de una OC.

## 7. Salir en vivo (sin correo)
Mercaldas no usa correo: los avisos llegan a la campana del sistema y el administrador asigna las contraseñas en **Usuarios**.
Sin `-SmtpHost`, el instalador deja `CORREO=0`.
1. Hacerlo **de martes a jueves**, nunca entre el viernes a las 6:00 a.m. y el lunes a las 7:00 p.m.
2. Dejar de usar el equipo de desarrollo (`localhost:3999`).
3. Detener el servicio: `C:\NSSM\nssm.exe stop ComparadorMercaldas`.
4. Borrar los movimientos de ensayo. Se conservan proveedores, catálogo, usuarios y configuración. Primero se mira lo que borraría y después se aplica; el script hace un respaldo antes:
   ```powershell
   C:\planeacion\prod\node20\node.exe scripts\limpiar_ensayos.js --datos C:\planeacion\prod\datos
   C:\planeacion\prod\node20\node.exe scripts\limpiar_ensayos.js --datos C:\planeacion\prod\datos --aplicar
   ```
5. Instalar con las tareas automáticas encendidas (también arranca el servicio):
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\instalar-servicio.ps1 -Nssm C:\NSSM\nssm.exe `
     -Node C:\planeacion\prod\node20\node.exe -Datos C:\planeacion\prod\datos -Puerto 8006 -TareasAutomaticas 1
   ```
6. El viernes a las 6:00 a.m. se abre sola la semana y les llega la solicitud a los proveedores, en su campana.

## Operación
- **Ver estado:** `Get-Service ComparadorMercaldas, CloudflaredComparador`.
- **Reiniciar:** `C:\NSSM\nssm.exe restart ComparadorMercaldas`. El túnel no hace falta reiniciarlo.
- **Registros:** `C:\planeacion\prod\datos\logs\servidor.log` (rota cada 10 MB) y `cloudflared.log`, el del túnel.
- **Respaldos:** `C:\planeacion\prod\datos\respaldos`, con el resultado de cada uno en `respaldos.log`.
  - Esos respaldos quedan en el mismo disco del servidor. Para tener una copia afuera, el admin entra a **Configuración → Descargar respaldo** y guarda el archivo `comparador_respaldo_<fecha>.db` en su equipo. Recomendado cada martes.
  - **Restaurar:**
    1. Detener el servicio.
    2. Copiar el respaldo (del servidor o el descargado) como `C:\planeacion\prod\datos\cotizaciones.db`, reemplazando el actual.
    3. Arrancar el servicio.
- **Actualizar el código:**
  1. Detener el servicio.
  2. Reemplazar los archivos.
  3. Arrancar.
  - Si cambian las dependencias, se copia también `node_modules` desde el equipo de desarrollo, que usa Node 20.
