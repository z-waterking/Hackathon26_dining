param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [switch]$DetailedReport
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression

function Read-ZipXml {
    param($Archive, [string]$Name)
    $entry = $Archive.GetEntry($Name)
    if ($null -eq $entry) { return $null }
    $reader = [IO.StreamReader]::new($entry.Open())
    try {
        $document = [xml]::new()
        $document.XmlResolver = $null
        $document.LoadXml($reader.ReadToEnd())
        return ,$document
    }
    finally { $reader.Dispose() }
}

$output = Join-Path $Root 'materials/inspection'
$null = New-Item -ItemType Directory -Path $output -Force
$files = @(
    Get-ChildItem -LiteralPath $Root -Filter '*.xlsx' -File
    if (Test-Path -LiteralPath (Join-Path $Root 'materials/extracted')) {
        Get-ChildItem -LiteralPath (Join-Path $Root 'materials/extracted') -Filter '*.xlsx' -File -Recurse
    }
) | Where-Object { -not $_.Name.StartsWith('~$') } | Sort-Object FullName
$inventory = [Collections.Generic.List[object]]::new()
$bookNumber = 0
foreach ($file in $files) {
    $bookNumber++
    $bookId = 'book-{0:D2}' -f $bookNumber
    $archive = [IO.Compression.ZipFile]::OpenRead($file.FullName)
    try {
        $workbook = Read-ZipXml $archive 'xl/workbook.xml'
        $relations = Read-ZipXml $archive 'xl/_rels/workbook.xml.rels'
        if ($null -eq $workbook -or $null -eq $relations) { throw "Invalid workbook: $($file.Name)" }
        $strings = [Collections.Generic.List[string]]::new()
        $shared = Read-ZipXml $archive 'xl/sharedStrings.xml'
        if ($null -ne $shared) {
            foreach ($item in $shared.SelectNodes('//*[local-name()="si"]')) {
                $text = ($item.SelectNodes('./*[local-name()="t"] | ./*[local-name()="r"]/*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join ''
                $strings.Add($text)
            }
        }
        $sheetNumber = 0
        foreach ($sheet in $workbook.SelectNodes('//*[local-name()="sheet"]')) {
            $sheetNumber++
            $relationId = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
            $relation = $relations.DocumentElement.ChildNodes | Where-Object { $_.GetAttribute('Id') -eq $relationId }
            $target = $relation.GetAttribute('Target')
            $uri = [Uri]::new([Uri]'https://workbook.local/xl/workbook.xml', $target)
            $sheetXml = Read-ZipXml $archive $uri.AbsolutePath.TrimStart('/')
            if ($null -eq $sheetXml) { throw "Missing worksheet: $target" }
            $rows = [Collections.Generic.List[object]]::new()
            $lines = [Collections.Generic.List[string]]::new()
            $lines.Add("SOURCE: $([IO.Path]::GetRelativePath($Root, $file.FullName))")
            $lines.Add("SHEET: $($sheet.GetAttribute('name'))")
            $formulaCount = 0
            $errors = [Collections.Generic.List[string]]::new()
            foreach ($row in $sheetXml.SelectNodes('//*[local-name()="sheetData"]/*[local-name()="row"]')) {
                $cells = [Collections.Generic.List[object]]::new()
                foreach ($cell in $row.SelectNodes('./*[local-name()="c"]')) {
                    $value = $cell.SelectSingleNode('./*[local-name()="v"]')
                    $formula = $cell.SelectSingleNode('./*[local-name()="f"]')
                    $text = if ($null -ne $value) { $value.InnerText } else { '' }
                    $type = $cell.GetAttribute('t')
                    if ($type -eq 's') { $text = $strings[[int]$text] }
                    if ($type -eq 'inlineStr') {
                        $text = ($cell.SelectNodes('./*[local-name()="is"]/*[local-name()="t"] | ./*[local-name()="is"]/*[local-name()="r"]/*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join ''
                    }
                    if ($null -ne $formula) { $formulaCount++ }
                    if ($type -eq 'e') { $errors.Add("$($cell.GetAttribute('r'))=$text") }
                    if (-not [string]::IsNullOrWhiteSpace($text) -or $null -ne $formula) {
                        $cells.Add([pscustomobject]@{ Ref = $cell.GetAttribute('r'); Text = $text; Type = $type; Style = $cell.GetAttribute('s'); Formula = $(if ($null -ne $formula) { $formula.InnerText } else { $null }) })
                    }
                }
                if ($cells.Count -gt 0) {
                    $rows.Add([pscustomobject]@{ Row = [int]$row.GetAttribute('r'); Cells = $cells.ToArray() })
                    $lines.Add(($cells | ForEach-Object { "$($_.Ref)=$($_.Text.Replace("`r", '').Replace("`n", '\n'))$(if ($null -ne $_.Formula) { ' [=' + $_.Formula + ']' })" }) -join ' | ')
                }
            }
            $sheetId = '{0}-sheet-{1:D3}' -f $bookId, $sheetNumber
            $state = $sheet.GetAttribute('state')
            $merges = @($sheetXml.SelectNodes('//*[local-name()="mergeCell"]') | ForEach-Object { $_.GetAttribute('ref') })
            $data = [pscustomobject]@{ Source = [IO.Path]::GetRelativePath($Root, $file.FullName); Sheet = $sheet.GetAttribute('name'); State = $state; Merges = $merges; Rows = $rows.ToArray() }
            $data | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $output "$sheetId.json") -Encoding utf8
            $lines | Set-Content -LiteralPath (Join-Path $output "$sheetId.txt") -Encoding utf8
            $inventory.Add([pscustomobject]@{ Id = $sheetId; Source = $data.Source; Sheet = $data.Sheet; State = $state; NonemptyRows = $rows.Count; NonemptyCells = ($rows | ForEach-Object { $_.Cells.Count } | Measure-Object -Sum).Sum; FormulaCount = $formulaCount; Errors = $errors.ToArray(); Merges = $merges.Count })
        }
    }
    finally { $archive.Dispose() }
}
$inventory | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'inventory.json') -Encoding utf8
if ($DetailedReport) {
    $inventory | Select-Object Id, Sheet, NonemptyRows, NonemptyCells, FormulaCount, Merges, @{ Name = 'Errors'; Expression = { $_.Errors.Count } } | Format-Table -AutoSize | Out-String -Width 200
}
"Workbooks: $bookNumber; Sheets: $($inventory.Count); Rows: $(($inventory | Measure-Object NonemptyRows -Sum).Sum); Cells: $(($inventory | Measure-Object NonemptyCells -Sum).Sum)"
