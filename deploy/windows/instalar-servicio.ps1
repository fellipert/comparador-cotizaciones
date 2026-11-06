<#
  Instala Subastas Fruver (antes "Comparador de Cotizaciones") como servicio de Windows (con NSSM) y programa el respaldo diario de la base.
  El servicio se sigue llamando ComparadorMercaldas por dentro (así lo usan los comandos); el nombre visible es "Subastas Fruver Mercaldas".
  Ejecutar en PowerShell COMO ADMINISTRADOR, desde la carpeta del proyecto. Ejemplo (pruebas, sin correo ni tareas automáticas):

    powershell -ExecutionPolicy Bypass -File deploy\windows\instalar-servicio.ps1 -Nssm C:\NSSM\nssm.exe `
      -Node C:\planeacion\prod\node20\node.exe -Datos C:\planeacion\prod\datos -Puerto 8006

  -Node: el node.exe con que corre el servicio. Las dependencias (node_modules) vienen compiladas para Node 20; si el
  servidor tiene otra versión para otras aplicaciones, se usa un Node 20 portátil solo para el comparador.
  Para salir en vivo se vuelve a correr igual, agregando el SMTP (-SmtpHost, -SmtpUsuario, -SmtpRemitente) y
  -TareasAutomaticas 1 (reemplaza la configuración del servicio). La contraseña del SMTP se pide en pantalla.
#>
param(
  [Parameter(Mandatory = $true)][string]$Nssm,
  [string]$Node = "",
  [string]$Datos = "C:\planeacion\prod\datos",
  [string]$AppUrl = "https://comparador.mercaldas-apps.com",
  [int]$Puerto = 8006,
  [ValidateSet("0", "1")][string]$TareasAutomaticas = "0",
  [string]$SmtpHost = "",
  [int]$SmtpPort = 587,
  [string]$SmtpUsuario = "",
  [string]$SmtpRemitente = "",
  [string]$HoraRespaldo = "02:00",
  [int]$DiasRespaldo = 30,
  [string]$Servicio = "ComparadorMercaldas"
)
$ErrorActionPreference = "Stop"

function Paso($texto) { Write-Host ""; Write-Host "== $texto" -ForegroundColor Cyan }

# ---------- Revisiones ----------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Abre PowerShell como Administrador y vuelve a correr el script." }
if (-not (Test-Path $Nssm)) { throw "No encuentro NSSM en $Nssm" }

$carpeta = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Test-Path (Join-Path $carpeta "src\server.js"))) { throw "No encuentro src\server.js en $carpeta" }
if (-not (Test-Path (Join-Path $carpeta "node_modules\better-sqlite3"))) { throw "Faltan las dependencias: corre 'npm ci --omit=dev' en $carpeta o copia la carpeta node_modules." }

if ($Node) {
  if (-not (Test-Path $Node)) { throw "No encuentro $Node" }
  $node = (Resolve-Path $Node).Path
} else {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "No hay Node.js en el PATH. Indica el node.exe con -Node (Node 20 portátil)." }
}
$version = & $node -v
# La base (better-sqlite3) debe cargar con ese Node; si no, el servicio se cae apenas arranca
Push-Location $carpeta
try {
  $prueba = & $node -e "const D=require('better-sqlite3');new D(':memory:').close();console.log('ok')" 2>&1
  $cargo = ($LASTEXITCODE -eq 0) -and ("$prueba" -match 'ok')
} finally { Pop-Location }
if (-not $cargo) {
  throw "Con Node $version no carga la base de datos (node_modules se compiló para Node 20). Usa -Node con el node.exe de Node 20 portátil. Detalle: $prueba"
}
Write-Host "Node $version ($node): la base de datos carga bien."

New-Item -ItemType Directory -Force -Path $Datos, (Join-Path $Datos "logs"), (Join-Path $Datos "respaldos") | Out-Null
# La app no crea desde cero algunas tablas (se hicieron a mano en el servidor original): siempre se arranca con la base existente
if (-not (Test-Path (Join-Path $Datos "cotizaciones.db"))) {
  throw "No hay base en $Datos\cotizaciones.db. Copia ahí la base del servidor actual antes de instalar."
}

$smtpPass = ""
if ($SmtpHost) {
  if (-not $SmtpUsuario -or -not $SmtpRemitente) { throw "Con -SmtpHost también van -SmtpUsuario y -SmtpRemitente." }
  $seguro = Read-Host "Contraseña de la cuenta SMTP $SmtpUsuario" -AsSecureString
  $smtpPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro))
} else {
  Write-Host "Sin -SmtpHost el correo queda apagado (CORREO=0): los avisos llegan solo a la campana del sistema y el administrador asigna las contraseñas."
}

# ---------- Servicio ----------
Paso "Servicio $Servicio"
if (Get-Service -Name $Servicio -ErrorAction SilentlyContinue) {
  & $Nssm stop $Servicio | Out-Null
  & $Nssm remove $Servicio confirm | Out-Null
  Start-Sleep -Seconds 3
}
# El puerto debe estar libre (en IPv4 y en IPv6): si otro programa lo usa, el navegador mostraría ese otro programa
$ocupado = Get-NetTCPConnection -LocalPort $Puerto -State Listen -ErrorAction SilentlyContinue
if ($ocupado) {
  $quien = ($ocupado | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "$($p.ProcessName) (PID $($_.OwningProcess), $($_.LocalAddress))" } | Select-Object -Unique) -join "; "
  throw "El puerto $Puerto ya lo usa otro programa: $quien. Elige un puerto libre y vuelve a correr con -Puerto <número>."
}
& $Nssm install $Servicio $node "src\server.js" | Out-Null
& $Nssm set $Servicio AppDirectory $carpeta | Out-Null
& $Nssm set $Servicio DisplayName "Subastas Fruver Mercaldas" | Out-Null
& $Nssm set $Servicio Description "Subastas Fruver: cotizaciones, subastas y portal de proveedores (Node.js). Datos en $Datos" | Out-Null
& $Nssm set $Servicio Start SERVICE_AUTO_START | Out-Null

$entorno = @(
  "NODE_ENV=production", "PORT=$Puerto", "HOST=127.0.0.1", "DATA_DIR=$Datos",
  "APP_URL=$AppUrl", "TAREAS_AUTOMATICAS=$TareasAutomaticas"
)
if ($SmtpHost) {
  $seguroSmtp = if ($SmtpPort -eq 465) { "1" } else { "0" }
  $entorno += @("SMTP_HOST=$SmtpHost", "SMTP_PORT=$SmtpPort", "SMTP_SECURE=$seguroSmtp", "SMTP_USER=$SmtpUsuario", "SMTP_PASS=$smtpPass", "SMTP_FROM=$SmtpRemitente")
} else {
  $entorno += "CORREO=0"
}
& $Nssm set $Servicio AppEnvironmentExtra @entorno | Out-Null

$log = Join-Path $Datos "logs\servidor.log"
& $Nssm set $Servicio AppStdout $log | Out-Null
& $Nssm set $Servicio AppStderr $log | Out-Null
& $Nssm set $Servicio AppRotateFiles 1 | Out-Null
& $Nssm set $Servicio AppRotateOnline 1 | Out-Null
& $Nssm set $Servicio AppRotateBytes 10485760 | Out-Null
& $Nssm set $Servicio AppExit Default Restart | Out-Null
& $Nssm set $Servicio AppRestartDelay 5000 | Out-Null

# Solo Administradores y SYSTEM leen los datos y registros (el registro puede traer enlaces de recuperación de contraseña)
icacls $Datos /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null

& $Nssm start $Servicio | Out-Null

Paso "Comprobando que responda"
# Debe estar corriendo, el puerto debe ser de ESTE node.exe y /api/health debe ser la respuesta del comparador
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep -Seconds 1
  try {
    $corriendo = (Get-Service -Name $Servicio).Status -eq "Running"
    $dueno = Get-NetTCPConnection -LocalPort $Puerto -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Path } | Select-Object -First 1
    $salud = Invoke-RestMethod "http://127.0.0.1:$Puerto/api/health" -TimeoutSec 3
    $ok = $corriendo -and ($dueno -eq $node) -and ($salud.ok -eq $true) -and $salud.time
  } catch { }
}
if ($ok) {
  Write-Host "El comparador responde en http://127.0.0.1:$Puerto" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "Estado del servicio: $((Get-Service -Name $Servicio).Status)" -ForegroundColor Yellow
  if (Test-Path $log) { Write-Host "Últimas líneas de ${log}:" -ForegroundColor Yellow; Get-Content $log -Tail 20 }
  throw "El comparador no arrancó en 30 s. Revisa el detalle de arriba."
}

# ---------- Respaldo diario ----------
Paso "Respaldo diario a las $HoraRespaldo"
$script = Join-Path $carpeta "scripts\respaldar_base.js"
$accion = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --datos `"$Datos`" --dias $DiasRespaldo" -WorkingDirectory $carpeta
$disparador = New-ScheduledTaskTrigger -Daily -At $HoraRespaldo
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "Comparador Mercaldas - respaldo diario" -Action $accion -Trigger $disparador -Principal $principal -Force | Out-Null
Write-Host "Respaldos en $Datos\respaldos (se guardan $DiasRespaldo días; resultado en respaldos.log)."

Paso "Listo"
Write-Host "Tareas automáticas: $(if ($TareasAutomaticas -eq '1') { 'ENCENDIDAS' } else { 'apagadas (para salir en vivo, corre de nuevo con -TareasAutomaticas 1)' })"
Write-Host "Prueba en el navegador del servidor: http://127.0.0.1:$Puerto (no uses 'localhost': puede ir a otro programa por IPv6)."
Write-Host "Falta: Cloudflare Tunnel apuntando comparador.mercaldas-apps.com a http://127.0.0.1:$Puerto (ver deploy\windows\LEEME.md)."
