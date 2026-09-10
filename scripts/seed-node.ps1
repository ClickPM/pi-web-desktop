<#
.SYNOPSIS
  Provision the bundled Node.js runtime at vendor/node (node.exe + npm), so the
  packaged app runs both embedded servers with ZERO system dependency.

.DESCRIPTION
  Downloads node-v<Version>-win-x64.zip (default mirror: npmmirror; falls back to
  nodejs.org), extracts it, and moves the result into vendor/node.

  VERSION FLOOR — historical, and kept. It was raised for @deepseek-ai/dsh,
  which declares `engines: ^22.19.0 || >=24.0.0` and MEANS it: on the previous
  bundled 22.12.0 `dsh web` died at boot importing `createZstdDecompress` from
  node:zlib (22.15+) and `stripTypeScriptTypes` from node:module (22.13+).
  That runtime is no longer bundled — DeepSeek Harness is now upstream's own
  application, which carries its own Node — so nothing here still REQUIRES the
  floor. It stays anyway: pi-web/Next.js is happy on the 22 LTS line, the
  provisioned runtime already satisfies it, and lowering it would buy nothing
  while re-opening a class of boot failures that took real time to diagnose.

  Idempotent: an existing vendor/node that already satisfies the floor is left
  alone unless -Force. The previous tree is renamed aside (vendor/node.bak-<ver>)
  rather than deleted, so a bad bump can be rolled back by hand.

.EXAMPLE
  npm run seed:node
  powershell -ExecutionPolicy Bypass -File scripts/seed-node.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$Version = "22.23.2",
  [string]$Mirror  = "https://registry.npmmirror.com/-/binary/node",
  [string]$Origin  = "https://nodejs.org/dist",
  [switch]$Force
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# The inherited floor (see .DESCRIPTION); checked against whatever is on disk.
$MinMajor = 22
$MinMinor = 19

$repo      = Split-Path -Parent $PSScriptRoot
$vendorDir = Join-Path $repo "vendor"
$nodeDir   = Join-Path $vendorDir "node"
$nodeExe   = Join-Path $nodeDir "node.exe"
$asset     = "node-v$Version-win-x64.zip"

function Info($m) { Write-Host "[seed:node] $m" -ForegroundColor Cyan }

function Test-NodeFloor($exe) {
  if (-not (Test-Path $exe)) { return $false }
  $raw = (& $exe -v) -replace '^v', ''
  $parts = $raw.Split('.')
  $major = [int]$parts[0]; $minor = [int]$parts[1]
  if ($major -gt $MinMajor) { return $true }
  return ($major -eq $MinMajor -and $minor -ge $MinMinor)
}

if ((Test-NodeFloor $nodeExe) -and -not $Force) {
  Info "vendor/node already at $(& $nodeExe -v) (>= v$MinMajor.$MinMinor). Use -Force to re-provision. Skipping."
  exit 0
}

New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
$tmpZip = Join-Path $env:TEMP $asset
$tmpDir = Join-Path $env:TEMP "seed-node-$Version"

$urls = @("$Mirror/v$Version/$asset", "$Origin/v$Version/$asset")
$ok = $false
foreach ($u in $urls) {
  Info "downloading $u"
  # curl.exe (Win10+) is far more TLS-robust here than Invoke-WebRequest.
  & curl.exe -fSL --retry 3 --retry-delay 2 --connect-timeout 20 -o $tmpZip $u
  if ($LASTEXITCODE -eq 0 -and (Test-Path $tmpZip) -and (Get-Item $tmpZip).Length -gt 10MB) { $ok = $true; break }
  Info "  failed from this source, trying next..."
}
if (-not $ok) { throw "Could not download $asset from any source." }
Info "downloaded $([math]::Round((Get-Item $tmpZip).Length/1MB,1)) MB"

if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
Info "extracting"
& tar.exe -xf $tmpZip -C $env:TEMP
if ($LASTEXITCODE -ne 0) { throw "extraction failed" }
$extracted = Join-Path $env:TEMP "node-v$Version-win-x64"
if (-not (Test-Path (Join-Path $extracted "node.exe"))) { throw "extraction did not yield node.exe in $extracted" }

if (Test-Path $nodeExe) {
  $oldVer = ((& $nodeExe -v) -replace '^v', '')
  $backup = Join-Path $vendorDir "node.bak-$oldVer"
  if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
  Info "keeping previous runtime at vendor/node.bak-$oldVer (delete it once the bump is verified)"
  Move-Item $nodeDir $backup
} elseif (Test-Path $nodeDir) {
  Remove-Item -Recurse -Force $nodeDir
}

Move-Item $extracted $nodeDir
Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue

if (-not (Test-NodeFloor $nodeExe)) { throw "provisioned runtime $(& $nodeExe -v) is below the v$MinMajor.$MinMinor floor" }
$npmCli = Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path $npmCli)) { throw "bundled npm missing at $npmCli" }

Info "node: $(& $nodeExe -v)   npm: $(& $nodeExe $npmCli -v)"
$size = [math]::Round((Get-ChildItem $nodeDir -Recurse -File | Measure-Object Length -Sum).Sum/1MB, 0)
Info "DONE. vendor/node provisioned (~$size MB). Ships to resources/node via electron-builder."
