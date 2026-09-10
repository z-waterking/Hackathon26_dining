param(
    [int]$Port = 4317,
    [ValidateSet("local", "lan")][string]$NetworkMode,
    [switch]$VerifyAi
)

$ErrorActionPreference = 'Stop'
$diningRoot = Split-Path -Parent $PSScriptRoot
$diningApp = Join-Path $diningRoot 'app'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 is required.' }
$diningNodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($diningNodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
if (-not (Test-Path -LiteralPath (Join-Path $diningApp 'data/dining.sqlite')) -and -not (Test-Path -LiteralPath (Join-Path $diningRoot 'materials/inspection/inventory.json'))) {
    Write-Host 'Preparing source materials...'
    & (Join-Path $PSScriptRoot 'Prepare-Materials.ps1') -Root $diningRoot
}
if (-not (Test-Path -LiteralPath (Join-Path $diningApp 'node_modules/.package-lock.json'))) {
    Write-Host 'Installing dependencies...'
    npm --prefix $diningApp ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $diningApp 'data/dining.sqlite'))) {
    Write-Host 'Initializing the database and importing the original catalog once...'
    Push-Location $diningRoot
    try {
        node --input-type=module -e 'import { initializeLocalStore } from "./app/server/bootstrap.mjs"; const store = await initializeLocalStore(); store.close();'
        if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed.' }
        node tools/Import-StallCatalog.mjs --apply
        if ($LASTEXITCODE -ne 0) { throw 'Catalog import failed. Resolve the error and rerun tools/Import-StallCatalog.mjs --apply.' }
    } finally { Pop-Location }
}
Write-Host 'Building the local workbench...'
npm --prefix $diningApp run build
if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
$env:PORT = [string]$Port
if ($NetworkMode) { $env:DINING_NETWORK = $NetworkMode }
Write-Host "Starting workbench on port $Port (Ctrl+C to stop). Access URLs follow."
if ($VerifyAi) {
    Write-Host 'Verifying Azure AI from the server process (one small billable request)...'
    npm --prefix $diningApp start -- --verify-ai
} else {
    npm --prefix $diningApp start
}
if ($LASTEXITCODE -ne 0) { throw 'Service failed. Check the error above.' }
