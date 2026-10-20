<#
.SYNOPSIS
  Installs (if needed), builds and serves both applications, then opens the Dimension.

.DESCRIPTION
  Expects the Dimension repository to sit next to this one (default ..\big-hero-6-fractured-dimension).
  Dimension -> http://127.0.0.1:4183/   ATLAS Command -> http://127.0.0.1:5184/
  Each server opens in its own PowerShell window; close those windows to stop. No process is ever killed by this script.
  Use -Dev to run Vite dev servers instead of production builds (slower to render, no build step).

  powershell -ExecutionPolicy Bypass -File scripts\start-live-demo.ps1 [-Dev] [-NoOpen] [-DimensionPath <dir>]
#>
param(
  [string]$DimensionPath = '',
  [switch]$Dev,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$atlas = Split-Path -Parent $PSScriptRoot
if (-not $DimensionPath) { $DimensionPath = Join-Path (Split-Path -Parent $atlas) 'big-hero-6-fractured-dimension' }
if (-not (Test-Path (Join-Path $DimensionPath 'package.json'))) {
  Write-Host "Dimension repository not found at $DimensionPath" -ForegroundColor Red
  Write-Host 'Clone it next to this folder:  git clone https://github.com/Aadit-issar/big-hero-6-fractured-dimension.git' -ForegroundColor Red
  exit 1
}
$DimensionPath = (Resolve-Path $DimensionPath).Path

function Test-Port([int]$port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Test-Http([string]$url) { try { (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }

foreach ($port in 4183, 5184) {
  if (Test-Port $port) { Write-Host "Port $port is already in use. Close whatever is using it (or the earlier demo windows) and run again." -ForegroundColor Red; exit 1 }
}
foreach ($root in $DimensionPath, $atlas) {
  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Host "Installing dependencies in $root ..."
    Push-Location $root; npm ci --no-audit --no-fund; $code = $LASTEXITCODE; Pop-Location
    if ($code -ne 0) { Write-Host "npm ci failed in $root" -ForegroundColor Red; exit 1 }
  }
}
$script = $(if ($Dev) { 'start' } else { 'serve' })
Write-Host "Starting Dimension and ATLAS ('npm run $script'); the production mode builds first, which can take a minute ..."
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$DimensionPath'; npm run $script"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$atlas'; npm run $script"

$deadline = (Get-Date).AddMinutes(5)
foreach ($pair in @(@('Dimension', 'http://127.0.0.1:4183/'), @('ATLAS', 'http://127.0.0.1:5184/'))) {
  while (-not (Test-Http $pair[1])) {
    if ((Get-Date) -gt $deadline) { Write-Host "$($pair[0]) did not answer at $($pair[1]). Check its PowerShell window for errors." -ForegroundColor Red; exit 1 }
    Start-Sleep -Seconds 2
  }
  Write-Host "$($pair[0]) is up: $($pair[1])" -ForegroundColor Green
}
$dimUrl = 'http://127.0.0.1:4183/?quality=cinematic&view=baymax&atlas=http://127.0.0.1:5184/'
Write-Host ''
Write-Host "Open in Chrome or Edge: $dimUrl"
Write-Host 'Then press L in the Dimension to open ATLAS linked to it. See docs\JUDGE_GUIDE.md.'
Write-Host 'To stop: close the two PowerShell server windows (or press Ctrl+C in each).'
if (-not $NoOpen) { Start-Process $dimUrl }
