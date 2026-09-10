$ErrorActionPreference = "Stop"
$diningRoot = Split-Path -Parent $PSScriptRoot
$diningDirectory = Join-Path $diningRoot "app/data/cloudflare"
$diningStatePath = Join-Path $diningDirectory "state.json"
if (-not (Test-Path -LiteralPath $diningStatePath)) { Write-Output "No Dining tunnel state found."; return }
$diningState = Get-Content -LiteralPath $diningStatePath -Raw | ConvertFrom-Json
$diningRunner = Join-Path $PSScriptRoot "Run-DiningTunnel.mjs"
$diningExecutable = Join-Path $diningDirectory "cloudflared.exe"
# Verify exact executable/script before stopping only this project's processes.
if ($diningState.tunnelPid) {
    $diningChild = Get-CimInstance Win32_Process -Filter "ProcessId = $($diningState.tunnelPid)"
    if ($diningChild -and $diningChild.ExecutablePath -eq $diningExecutable -and $diningChild.ParentProcessId -eq $diningState.pid) {
        Stop-Process -Id $diningChild.ProcessId
    }
}
$diningParent = Get-CimInstance Win32_Process -Filter "ProcessId = $($diningState.pid)"
if ($diningParent -and $diningParent.CommandLine.Contains($diningRunner)) { Stop-Process -Id $diningParent.ProcessId }
$diningState.status = "stopped"
$diningState.url = $null
$diningState | ConvertTo-Json | Set-Content -LiteralPath $diningStatePath -Encoding utf8
Write-Output "Dining Cloudflare tunnel stopped. The Dining application remains running."
