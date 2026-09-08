param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
foreach ($name in @('六周菜单.zip', '新六周菜单.zip')) {
    $path = Join-Path $Root $name
    $destination = Join-Path $Root ('materials/extracted/' + [IO.Path]::GetFileNameWithoutExtension($name))
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing source archive: $name" }
    if (-not (Test-Path -LiteralPath $destination)) {
        Expand-Archive -LiteralPath $path -DestinationPath $destination
    }
    $archive = [IO.Compression.ZipFile]::OpenRead($path)
    try {
        foreach ($entry in $archive.Entries) {
            if (-not $entry.Name) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
            $prefix = [IO.Path]::GetFullPath($destination) + [IO.Path]::DirectorySeparatorChar
            if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path outside destination' }
            if (-not (Test-Path -LiteralPath $target)) { throw "Incomplete extracted directory: $target" }
            $stream = $entry.Open()
            try { $expected = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) }
            finally { $stream.Dispose() }
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $expected) { throw "Extracted file differs from source; refusing to overwrite: $target" }
        }
    }
    finally { $archive.Dispose() }
}
& (Join-Path $PSScriptRoot 'Read-DiningMaterials.ps1') -Root $Root
