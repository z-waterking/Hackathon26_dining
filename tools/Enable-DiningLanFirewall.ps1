param([ValidateRange(1024, 65535)][int]$Port = 4317)

$ErrorActionPreference = "Stop"
$diningIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$diningPrincipal = [Security.Principal.WindowsPrincipal]::new($diningIdentity)
if (-not $diningPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script in an Administrator PowerShell to allow company LAN connections."
}
$diningNode = (Get-Command node -ErrorAction Stop).Source
$diningAddresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.AddressState -eq "Preferred" -and $_.IPAddress -match "^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)"
} | Select-Object -ExpandProperty IPAddress -Unique)
if ($diningAddresses.Count -eq 0) { throw "No private IPv4 address found. Connect to the company network first." }
$diningRuleName = "DiningWorkbench-LAN-$Port"
$diningRule = @{
    DisplayName = "Dining Workbench LAN ($Port)"
    Description = "Allow Dining on this machine private IPv4 addresses, from private IPv4 networks only."
    Enabled = "True"
    Direction = "Inbound"
    Action = "Allow"
    Profile = "Any"
    Program = $diningNode
    Protocol = "TCP"
    LocalPort = $Port
    LocalAddress = $diningAddresses
    RemoteAddress = @("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    EdgeTraversalPolicy = "Block"
}
if (Get-NetFirewallRule -Name $diningRuleName -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $diningRuleName @diningRule | Out-Null
} else {
    New-NetFirewallRule -Name $diningRuleName @diningRule | Out-Null
}
Write-Output "Enabled $diningRuleName for Node.js on $($diningAddresses -join ", "):$Port (private IPv4 clients only)."
