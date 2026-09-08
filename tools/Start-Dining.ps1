param([int]$Port = 4317)

$ErrorActionPreference = 'Stop'
$diningRoot = Split-Path -Parent $PSScriptRoot
$diningApp = Join-Path $diningRoot 'app'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 is required.' }
$diningNodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($diningNodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
if (-not (Test-Path -LiteralPath (Join-Path $diningRoot 'materials/inspection/inventory.json'))) {
    Write-Host 'Preparing source materials...'
    & (Join-Path $PSScriptRoot 'Prepare-Materials.ps1') -Root $diningRoot
}
if (-not (Test-Path -LiteralPath (Join-Path $diningApp 'node_modules/.package-lock.json'))) {
    Write-Host 'Installing dependencies...'
    npm --prefix $diningApp ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host 'Building the local workbench...'
npm --prefix $diningApp run build
if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
$env:PORT = [string]$Port
Write-Host "Opening service on http://127.0.0.1:$Port (Ctrl+C to stop)."
npm --prefix $diningApp start
if ($LASTEXITCODE -ne 0) { throw 'Service failed. Check the error above.' }
