param(
    [ValidateRange(1024, 65535)][int]$Port = 4317,
    [ValidateRange(1024, 65535)][int]$GatewayPort = 4319,
    [ValidateSet("basic", "none")][string]$Authentication
)

$ErrorActionPreference = "Stop"
$diningRoot = Split-Path -Parent $PSScriptRoot
$diningDirectory = Join-Path $diningRoot "app/data/cloudflare"
$diningExecutable = Join-Path $diningDirectory "cloudflared.exe"
$diningStatePath = Join-Path $diningDirectory "state.json"
$diningSettingsPath = Join-Path $diningDirectory "settings.json"
$diningRunner = Join-Path $PSScriptRoot "Run-DiningTunnel.mjs"
$diningNode = (Get-Command node -ErrorAction Stop).Source
if ($Port -eq $GatewayPort) { throw "Application and gateway ports must differ." }
New-Item -ItemType Directory -Path $diningDirectory -Force | Out-Null
# Windows ignores POSIX file modes; protect credentials before the runner writes them.
$diningAcl = [Security.AccessControl.DirectorySecurity]::new()
$diningAcl.SetAccessRuleProtection($true, $false)
$diningUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
$diningAcl.SetOwner($diningUser)
foreach ($diningSid in @($diningUser.Value, "S-1-5-18", "S-1-5-32-544")) {
    $diningIdentity = [Security.Principal.SecurityIdentifier]::new($diningSid)
    $diningRule = [Security.AccessControl.FileSystemAccessRule]::new($diningIdentity, "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow")
    $diningAcl.AddAccessRule($diningRule)
}
$diningExistingAcl = Get-Acl -LiteralPath $diningDirectory
$diningAllowedSids = @($diningUser.Value, "S-1-5-18", "S-1-5-32-544")
$diningRules = @($diningExistingAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$diningAclMatches = $diningExistingAcl.AreAccessRulesProtected -and $diningRules.Count -eq 3
foreach ($diningExistingRule in $diningRules) {
    $diningAclMatches = $diningAclMatches -and $diningExistingRule.IdentityReference.Value -in $diningAllowedSids `
        -and $diningExistingRule.AccessControlType -eq "Allow" `
        -and $diningExistingRule.FileSystemRights -eq "FullControl" `
        -and $diningExistingRule.InheritanceFlags -eq "ContainerInherit, ObjectInherit"
}
if (-not $diningAclMatches) { Set-Acl -LiteralPath $diningDirectory -AclObject $diningAcl }
if (-not $Authentication) {
    $Authentication = if (Test-Path -LiteralPath $diningSettingsPath) {
        (Get-Content -LiteralPath $diningSettingsPath -Raw | ConvertFrom-Json).authentication
    } else { "basic" }
}
if ($Authentication -notin @("basic", "none")) { throw "Authentication must be basic or none." }
if (Test-Path -LiteralPath $diningStatePath) {
    $diningPrevious = Get-Content -LiteralPath $diningStatePath -Raw | ConvertFrom-Json
    $diningRunning = Get-CimInstance Win32_Process -Filter "ProcessId = $($diningPrevious.pid)" -ErrorAction SilentlyContinue
    if ($diningRunning -and $diningRunning.CommandLine.Contains($diningRunner)) {
        $diningPreviousAuthentication = if ($diningPrevious.authentication) { $diningPrevious.authentication } else { "basic" }
        if ($diningPreviousAuthentication -ne $Authentication) { throw "Stop the current tunnel with Stop-DiningTunnel.ps1 before changing authentication." }
        Write-Output "Tunnel already running: $($diningPrevious.url)"
        if ($Authentication -eq "none") { Write-Output "No login required." }
        else { Write-Output "Login details: $(Join-Path $diningDirectory 'access.txt')" }
        return
    }
}
# Pinned official Windows x64 release; verify before each execution.
$diningExpectedHash = "83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae"
if (-not (Test-Path -LiteralPath $diningExecutable)) {
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-windows-amd64.exe" -OutFile $diningExecutable -TimeoutSec 120
}
if ((Get-FileHash -LiteralPath $diningExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $diningExpectedHash) {
    throw "cloudflared checksum mismatch; refusing to execute."
}
$diningHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
if ($diningHealth.ok -ne $true) { throw "Start Dining on port $Port first." }
@{ authentication = $Authentication } | ConvertTo-Json | Set-Content -LiteralPath $diningSettingsPath -Encoding utf8
$diningProcess = Start-Process -FilePath $diningNode -WorkingDirectory $diningRoot -WindowStyle Hidden -ArgumentList @(
    ('"' + $diningRunner + '"'), [string]$Port, [string]$GatewayPort, $Authentication
) -RedirectStandardOutput (Join-Path $diningDirectory "runner.stdout.log") -RedirectStandardError (Join-Path $diningDirectory "runner.stderr.log") -PassThru
$diningDeadline = [DateTime]::UtcNow.AddSeconds(45)
do {
    Start-Sleep -Milliseconds 500
    $diningProcess.Refresh()
    if ($diningProcess.HasExited) { throw "Tunnel stopped. Check app/data/cloudflare/runner.stderr.log and cloudflared.log." }
    if (Test-Path -LiteralPath $diningStatePath) {
        try { $diningState = Get-Content -LiteralPath $diningStatePath -Raw | ConvertFrom-Json } catch { continue }
        if ($diningState.pid -eq $diningProcess.Id -and $diningState.status -eq "ready") {
            Write-Output "Cloudflare URL: $($diningState.url)"
            if ($Authentication -eq "none") { Write-Output "No login required." }
            else { Write-Output "Login details: $($diningState.accessFile)" }
            return
        }
    }
} while ([DateTime]::UtcNow -lt $diningDeadline)
Write-Output "Tunnel is connecting in the background. Status: $diningStatePath"
