param([string]$Setup, [string]$Old, [string]$Out = 'smoke-out')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static string Text(IntPtr h) { var s = new StringBuilder(256); GetWindowTextW(h, s, 256); return s.ToString(); }
}
'@

$script:n = 0
function Shot([string]$name) {
  $script:n++
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $img = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($img)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $img.Save((Join-Path $Out ('{0:D3}-{1}.png' -f $script:n, $name)), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $img.Dispose()
}

function WaitTitle([string]$like, [int]$seconds = 90) {
  $until = [DateTime]::Now.AddSeconds($seconds)
  while ([DateTime]::Now -lt $until) {
    $w = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $like } | Select-Object -First 1
    if ($w) { return $w.MainWindowHandle }
    Start-Sleep -Milliseconds 150
  }
  throw "No apareció ninguna ventana '$like'"
}

function Click([IntPtr]$h, [int]$id) {
  [Win]::SetForegroundWindow($h) | Out-Null
  [Win]::SendMessageW([Win]::GetDlgItem($h, $id), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}

function Installed([string]$hive = 'HKCU') {
  Get-ItemProperty "${hive}:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Viciont Studios Launcher*' }
}

function Quiet {
  Get-Process devenv -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 1
}

function StopApp {
  Get-Process 'Viciont Studio Launcher' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 3
}

Quiet
Write-Host '== Actualizar desde la versión publicada'
Start-Process $Old -ArgumentList '/S' -Wait
$inst = Installed
$app = ($inst.DisplayIcon -replace ',\s*-?\d+$', '').Trim('"')
$loc = Split-Path $app
$uninstaller = $inst.UninstallString -replace '^"([^"]+)".*$', '$1'
Write-Host "Instalada: $((Installed).DisplayVersion) en $loc"
Get-ChildItem $loc -Filter *.exe | ForEach-Object { Write-Host "   $($_.Name)" }
Start-Process $app
Start-Sleep 20
Shot 'launcher-anterior'
$u = Start-Process $Setup -ArgumentList '--updated', '/S', '--force-run' -PassThru
$title = ''
for ($i = 0; $i -lt 300 -and -not $u.HasExited; $i++) {
  $w = Get-Process -Id $u.Id -ErrorAction SilentlyContinue
  if ($w -and $w.MainWindowHandle -ne 0 -and -not $title) {
    $title = $w.MainWindowTitle
    Write-Host "Ventana del instalador: '$title'"
  }
  if ($i -eq 20) { Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { Write-Host "   ventana: $($_.ProcessName) · '$($_.MainWindowTitle)'" } }
  if ($i % 2 -eq 0 -and $script:n -lt 90) { Shot 'actualizando' }
  Start-Sleep -Milliseconds 500
}
$u.WaitForExit(240000) | Out-Null
Write-Host "Salida del instalador: $($u.ExitCode) · instalada: $((Installed).DisplayVersion)"
Start-Sleep 20
Shot 'relanzado'
Write-Host "Launcher abierto después de actualizar: $([bool](Get-Process 'Viciont Studio Launcher' -ErrorAction SilentlyContinue))"
StopApp

Quiet
Write-Host '== Instalación nueva'
Start-Process $uninstaller -ArgumentList '/S' -Wait
Start-Sleep 8
$p = Start-Process $Setup -PassThru
$h = WaitTitle 'Instalación de Viciont Studios Launcher*'
Start-Sleep 3
Shot 'bienvenida'
Click $h 1
Start-Sleep 3
Shot 'carpeta'
Click $h 1
$i = 0
while (([Win]::Text([Win]::GetDlgItem($h, 1))) -notmatch 'Terminar' -and $i -lt 150) {
  if ($i % 3 -eq 0) { Shot 'instalando' }
  $i++
  Start-Sleep -Milliseconds 400
}
Start-Sleep 2
Shot 'final'
Click $h 1
$p.WaitForExit(60000) | Out-Null
Start-Sleep 20
Shot 'launcher-nuevo'
$inst = Installed
Write-Host "Instalada: $($inst.DisplayVersion) en $($inst.DisplayIcon) · para todos los usuarios: $([bool](Installed 'HKLM'))"
StopApp

Quiet
Write-Host '== Desinstalador'
Start-Process $uninstaller
$h = WaitTitle '*Viciont Studios Launcher*' 60
Start-Sleep 3
Shot 'desinstalador'
Click $h 2
Start-Sleep 2
