# Compiles installer\Installer.cs with the built-in .NET Framework C# compiler (no Visual Studio).
#   -Embed     embeds src\net.js and the README so the exe is a single self-contained file.
#   -Out <exe> output path (default: installer\FBWG Online Co-op Installer.exe)
param([switch]$Embed, [string]$Out = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'installer'
if (-not $Out) { $Out = Join-Path $src 'FBWG Online Co-op Installer.exe' }
$csc  = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path (Join-Path $src 'icon.ico'))) { & (Join-Path $PSScriptRoot 'make_icon.ps1') | Out-Null }
$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
    "/out:$Out", "/win32icon:$(Join-Path $src 'icon.ico')", "/win32manifest:$(Join-Path $src 'app.manifest')",
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll')
if ($Embed) {
    $cscArgs += "/resource:$(Join-Path $root 'src\net.js'),net.js"
    $cscArgs += "/resource:$(Join-Path $src 'README.txt'),README.txt"
}
$cscArgs += (Join-Path $src 'Installer.cs')
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "compile failed" }
"built $Out ({0:N0} KB)" -f ((Get-Item $Out).Length / 1KB)
