# Builds the release files in dist\:
#   FBWG Online Co-op Installer v<ver>.exe     single-file installer (mod embedded)
#   FBWG_Online_Coop_v<ver>.zip                folder with that exe + README/CHANGELOG/CREDITS
#   FBWG_Online_Coop_v<ver>_folder.zip         small exe + installer\mod\ files (nothing embedded)
# Every file gets a neutral fixed date, and the exe a fixed PE build timestamp (privacy).
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$ver   = '1.1'
$dist  = Join-Path $root 'dist'
$name  = "FBWG_Online_Coop_v$ver"
$exe   = Join-Path $dist "FBWG Online Co-op Installer v$ver.exe"
$fixedDate = Get-Date '2026-01-01T00:00:00'
New-Item -ItemType Directory -Force $dist | Out-Null
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

# the mod refuses to connect across versions, so keep the installer and net.js in step
$jsVer = [regex]::Match((Get-Content (Join-Path $root 'src\net.js') -Raw), "MOD_VERSION = '([^']+)'").Groups[1].Value
if (-not $jsVer.StartsWith($ver)) { throw "net.js says $jsVer but package says $ver" }

function Set-NeutralStamp($path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $pe = [BitConverter]::ToInt32($bytes, 0x3C)
    $stamp = [uint32]([DateTimeOffset]::new(2026, 1, 1, 0, 0, 0, [TimeSpan]::Zero).ToUnixTimeSeconds())
    [BitConverter]::GetBytes($stamp).CopyTo($bytes, $pe + 8)
    [IO.File]::WriteAllBytes($path, $bytes)
    (Get-Item $path).LastWriteTime = $fixedDate
}
function New-NeutralZip($dir, $zip) {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    [IO.Compression.ZipFile]::CreateFromDirectory($dir, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
    $z = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Update)
    foreach ($e in $z.Entries) { $e.LastWriteTime = [DateTimeOffset]$fixedDate }
    $z.Dispose()
    "{0}  ({1:N0} KB)" -f $zip, ((Get-Item $zip).Length / 1KB)
}
$docs = 'README.txt', 'CHANGELOG.txt', 'CREDITS.txt' | ForEach-Object { Join-Path $root "installer\$_" }

# 1. single-file installer
if (Test-Path $exe) { Remove-Item $exe -Force }
& (Join-Path $PSScriptRoot 'build_installer.ps1') -Embed -Out $exe
Set-NeutralStamp $exe

# 2. zip: exe + docs
$stage = Join-Path $dist 'stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$top = Join-Path $stage $name
New-Item -ItemType Directory -Force $top | Out-Null
Copy-Item (@($exe) + $docs) $top
New-NeutralZip $top (Join-Path $dist "$name.zip")

# 3. folder zip: small exe + plain mod files
Remove-Item $stage -Recurse -Force
New-Item -ItemType Directory -Force (Join-Path $top 'installer\mod') | Out-Null
Copy-Item (Join-Path $root 'src\net.js') (Join-Path $top 'installer\mod')
Copy-Item (Join-Path $root 'installer\README.txt') (Join-Path $top 'installer\mod')
Copy-Item $docs $top
$small = Join-Path $top 'FBWG Online Co-op Installer.exe'
& (Join-Path $PSScriptRoot 'build_installer.ps1') -Out $small | Out-Null
Set-NeutralStamp $small
Get-ChildItem $top -Recurse | ForEach-Object { $_.LastWriteTime = $fixedDate }
New-NeutralZip $top (Join-Path $dist "${name}_folder.zip")
Remove-Item $stage -Recurse -Force
"{0}  ({1:N0} KB)" -f $exe, ((Get-Item $exe).Length / 1KB)
