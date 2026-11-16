param(
    [Parameter(Mandatory = $true)][string]$SourceSeed,
    [string]$ContractPath = (Join-Path $PSScriptRoot 'runner-contract.json')
)
$ErrorActionPreference = 'Stop'
$contract = Get-Content -Raw -LiteralPath $ContractPath | ConvertFrom-Json
$expected = $contract.windows
& (Join-Path $PSScriptRoot 'verify-runner-contract.ps1') -ContractPath $ContractPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($path in @($expected.workspaceRoot, $expected.pnpmStoreRoot, $expected.npmCacheRoot, $expected.nodeGypRoot)) {
    if (Test-Path -LiteralPath $path) { throw "Fresh-run path already exists: $path" }
}
$parent = Split-Path -Parent $expected.workspaceRoot
New-Item -ItemType Directory -Force -Path $parent | Out-Null
& git clone --no-hardlinks (Resolve-Path -LiteralPath $SourceSeed).Path $expected.workspaceRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git -C $expected.workspaceRoot remote set-url origin 'https://github.com/paperclipai/paperclip.git'
& node (Join-Path $PSScriptRoot 'verify-source.mjs') $expected.workspaceRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Path $expected.pnpmStoreRoot, $expected.npmCacheRoot, $expected.nodeGypRoot | Out-Null
$install = 'call "{0}" -arch=x64 -host_arch=x64 && set "npm_config_cache={1}" && set "npm_config_devdir={2}" && set "npm_config_msvs_version=2022" && corepack pnpm@{3} install --dir "{4}" --frozen-lockfile --store-dir "{5}"' -f `
    $expected.vsDevCmd, $expected.npmCacheRoot, $expected.nodeGypRoot, $expected.pnpm, $expected.workspaceRoot, $expected.pnpmStoreRoot
$installLog = Join-Path $expected.npmCacheRoot 'fresh-install.log'
& cmd.exe /d /s /c $install 2>&1 | Tee-Object -FilePath $installLog
$installExit = $LASTEXITCODE
if ($installExit -ne 0) { exit $installExit }
$policyOutput = & node (Join-Path $PSScriptRoot 'install-log-policy.mjs') $installLog (Join-Path $expected.workspaceRoot 'pnpm-lock.yaml')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$policy = $policyOutput | ConvertFrom-Json
if ($policy.requireFallbackProbe) {
    & node (Join-Path $PSScriptRoot 'verify-optional-fallback.mjs') $expected.workspaceRoot ($policy.packages -join ',')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$headers = Join-Path $expected.nodeGypRoot $expected.nodeHeadersVersion
if (-not (Test-Path -LiteralPath $headers -PathType Container)) { throw "Pinned Node headers were not materialized: $headers" }
$dirty = (& git -C $expected.workspaceRoot status --porcelain=v1 --untracked-files=all) -join "`n"
if ($dirty.Trim()) { throw 'Source became dirty during install' }
[ordered]@{ probe='fresh-source-install'; status='pass'; workspace=$expected.workspaceRoot; pnpmStore=$expected.pnpmStoreRoot; npmCache=$expected.npmCacheRoot; nodeHeaders=$headers } | ConvertTo-Json -Compress
