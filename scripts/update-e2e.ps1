param([string]$Old, [string]$Feed, [string]$Out = 'smoke-out')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null

function Installed {
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Viciont Studios Launcher*' }
}

$serve = @'
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  console.log(req.method, req.url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}).listen(8123, '127.0.0.1');
'@
Set-Content -Path (Join-Path $env:RUNNER_TEMP 'serve.cjs') -Value $serve -Encoding utf8
$server = Start-Process node -ArgumentList (Join-Path $env:RUNNER_TEMP 'serve.cjs'), $Feed -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $Out 'servidor.txt')
Start-Sleep 2

Start-Process $Old -ArgumentList '/S' -Wait
$inst = Installed
$before = $inst.DisplayVersion
$loc = if ($inst.InstallLocation) { $inst.InstallLocation.Trim('"') } else { Split-Path (($inst.UninstallString -replace '^"([^"]+)".*$', '$1')) }
$app = (Get-ChildItem $loc -Filter *.exe | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1).FullName
Write-Host "Instalada: $before en $app"
$yml = Join-Path (Split-Path $app) 'resourcespp-update.yml'
if (Test-Path $yml) { Get-Content $yml | ForEach-Object { Write-Host "   $_" } } else { Write-Host '   sin app-update.yml' }
Start-Process $app
Start-Sleep 20
Get-Process | Where-Object { $_.ProcessName -like '*Viciont*' } | ForEach-Object { Write-Host "   proceso: $($_.ProcessName) $($_.Id) '$($_.MainWindowTitle)'" }
Get-ChildItem (Join-Path $env:APPDATA 'ViciontStudioLauncher') -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "   $($_.FullName)" }

$after = $before
for ($i = 0; $i -lt 240 -and $after -eq $before; $i++) {
  Start-Sleep 1
  $after = (Installed).DisplayVersion
}
Write-Host "Después de abrir el launcher: $after"
Start-Sleep 25
$open = [bool](Get-Process 'Viciont Studio Launcher' -ErrorAction SilentlyContinue)
Write-Host "Launcher abierto otra vez: $open"
$log = Join-Path $env:APPDATA 'ViciontStudioLauncher\launcher_logs\launcher.log'
if (Test-Path $log) { Copy-Item $log (Join-Path $Out 'launcher.log'); Get-Content $log | Select-String 'updater|instalador|actualizaci|Viciont Studios Launcher' | ForEach-Object { Write-Host "   $_" } }
Get-Process 'Viciont Studio Launcher' -ErrorAction SilentlyContinue | Stop-Process -Force
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
if ($after -eq $before) { throw "El launcher no se actualizó ($before)" }
if (-not $open) { throw 'El launcher no se volvió a abrir después de actualizar' }
