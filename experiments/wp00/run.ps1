param(
    [string]$PaperclipSource = (Join-Path $PSScriptRoot '..\..\..\paperclip')
)

$ErrorActionPreference = 'Stop'
$resolvedSource = (Resolve-Path -LiteralPath $PaperclipSource).Path
$tsxPackage = Get-ChildItem -LiteralPath (Join-Path $resolvedSource 'node_modules\.pnpm') -Directory -Filter 'tsx@*' |
    Sort-Object Name -Descending |
    Select-Object -First 1
if (-not $tsxPackage) {
    throw "tsx is missing in Paperclip source checkout: $resolvedSource"
}
$tsx = Join-Path $tsxPackage.FullName 'node_modules\tsx\dist\cli.mjs'

$env:PAPERCLIP_SOURCE = $resolvedSource
& node $tsx (Join-Path $PSScriptRoot 'contract-probe.ts')
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
