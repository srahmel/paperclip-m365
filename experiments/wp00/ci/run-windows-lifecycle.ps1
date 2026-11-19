param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Work,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceRevision
)

$ErrorActionPreference = 'Stop'
$phase = 'initialize'
trap {
    $detail = ($_.Exception.Message -replace '%', '%25' -replace "`r", '%0D' -replace "`n", '%0A')
    Write-Output "::error title=Windows lifecycle failed::$phase - $detail"
    exit 1
}
$source = Join-Path $Work 'paperclip-source'
$store = Join-Path $Work 'pnpm-store'
$npmCache = Join-Path $Work 'npm-cache'
$pluginInstall = Join-Path $Work 'plugin-installed'
$artifactDir = Join-Path $Work 'plugin-artifact'
$artifact = Join-Path $Repo 'paperclip-plugin-m365-0.1.0.tgz'
$manifest = Join-Path $artifactDir 'package-manifest.json'
$evidence = Join-Path $Work 'evidence'

foreach ($path in @($source, $store, $npmCache, $pluginInstall, $artifactDir, $evidence)) {
    if (Test-Path -LiteralPath $path) { throw "Windows lifecycle path is not fresh: $path" }
}
New-Item -ItemType Directory -Force -Path $Work, $store, $npmCache, $pluginInstall, $artifactDir, $evidence | Out-Null

$phase = 'fetch-pinned-host'
& git init -q $source
if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
& git -C $source remote add origin 'https://github.com/paperclipai/paperclip.git'
& git -C $source fetch --depth=1 origin d69631b01b9c658f80bf8bed389863dce82643e1
if ($LASTEXITCODE -ne 0) { throw 'pinned host fetch failed' }
& git -C $source checkout -q --detach FETCH_HEAD
& git -C $source fetch --depth=1 origin refs/tags/v2026.1106.0:refs/tags/v2026.1106.0
if ($LASTEXITCODE -ne 0) { throw 'pinned host tag fetch failed' }

$phase = 'install-pinned-host'
$env:npm_config_cache = $npmCache
& corepack pnpm@9.15.4 install --dir $source --frozen-lockfile --store-dir $store 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'host-install.log')
if ($LASTEXITCODE -ne 0) { throw 'pinned host install failed' }

$phase = 'verify-host-install-policy'
$policyOutput = & node (Join-Path $Repo 'experiments/wp00/install-log-policy.mjs') `
    (Join-Path $evidence 'host-install.log') (Join-Path $source 'pnpm-lock.yaml')
if ($LASTEXITCODE -ne 0) { throw 'host install policy failed' }
Write-Output $policyOutput
$policy = $policyOutput | ConvertFrom-Json
if ($policy.requireFallbackProbe) {
    & node (Join-Path $Repo 'experiments/wp00/verify-optional-fallback.mjs') `
        $source ($policy.packages -join ',')
    if ($LASTEXITCODE -ne 0) { throw 'optional native fallback probe failed' }
}
$phase = 'verify-host-fingerprint'
& pwsh -NoProfile -File (Join-Path $Repo 'experiments/wp00/verify-host-fingerprint.ps1') `
    -PaperclipSource $source 2>&1 | Tee-Object -FilePath (Join-Path $evidence 'host-fingerprint.jsonl')
if ($LASTEXITCODE -ne 0) { throw 'host fingerprint failed' }

$phase = 'build-and-verify-plugin'
Push-Location $Repo
try {
    & npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'plugin npm ci failed' }
    $env:WP01_SOURCE_REVISION = $SourceRevision
    $env:WP01_PACKAGE_MANIFEST = $manifest
    & npm run verify
    if ($LASTEXITCODE -ne 0) { throw 'plugin verification failed' }
} finally {
    Pop-Location
}

$phase = 'verify-and-install-package'
& node (Join-Path $Repo 'scripts/package-integrity.mjs') verify `
    $artifact $manifest $SourceRevision install
if ($LASTEXITCODE -ne 0) { throw 'pre-install package integrity failed' }
& npm install --prefix $pluginInstall --ignore-scripts $artifact
if ($LASTEXITCODE -ne 0) { throw 'fresh plugin installation failed' }
Copy-Item -LiteralPath $artifact -Destination (Join-Path $artifactDir (Split-Path -Leaf $artifact))

$env:PAPERCLIP_SOURCE = $source
$env:PAPERCLIP_PACKAGE_ROOT = Join-Path $pluginInstall 'node_modules/paperclip-plugin-m365'
$env:PAPERCLIP_PACKAGE_ARCHIVE = Join-Path $artifactDir (Split-Path -Leaf $artifact)
$env:PAPERCLIP_PACKAGE_MANIFEST = $manifest
$env:PAPERCLIP_SOURCE_REVISION = $SourceRevision
$env:PAPERCLIP_REGISTRY_ROOT = $pluginInstall
$expected = Get-Content -Raw -LiteralPath (Join-Path $Repo 'experiments/wp00/expected-host-fingerprint.json') | ConvertFrom-Json
$runner = Join-Path $source $expected.runner.relativeCliPath
$tsxLoader = Join-Path (Split-Path -Parent $runner) 'loader.mjs'
$registryLoader = Join-Path $Repo 'scripts/register-registry-sdk-pin.mjs'
$importUrlsJson = & node -e "const { pathToFileURL } = require('node:url'); console.log(JSON.stringify(process.argv.slice(1).map((value) => pathToFileURL(value).href)))" `
    $tsxLoader $registryLoader
if ($LASTEXITCODE -ne 0) { throw 'Windows import URL conversion failed' }
$importUrls = $importUrlsJson | ConvertFrom-Json
if ($importUrls.Count -ne 2) { throw 'Windows import URL conversion returned an unexpected result' }

$lifecycleStdout = Join-Path $evidence 'plugin-lifecycle.stdout.log'
$lifecycleStderr = Join-Path $evidence 'plugin-lifecycle.stderr.log'
$lifecycleEvidence = Join-Path $evidence 'plugin-lifecycle.jsonl'
$lifecyclePhases = Join-Path $evidence 'plugin-lifecycle.phases.jsonl'
$postgresBin = Join-Path $source 'node_modules/.pnpm/@embedded-postgres+windows-x64@18.1.0-beta.16/node_modules/@embedded-postgres/windows-x64/native/bin'
$initdb = Join-Path $postgresBin 'initdb.exe'
$pgCtl = Join-Path $postgresBin 'pg_ctl.exe'
$postgresData = Join-Path $Work 'postgres-data'
$postgresLog = Join-Path $evidence 'postgresql.log'
$postgresStarted = $false

foreach ($executable in @($initdb, $pgCtl)) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "Pinned PostgreSQL executable is missing: $executable"
    }
}

$listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
)
$listener.Start()
$postgresPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

try {
    $phase = 'initialize-disposable-postgresql'
    & $initdb -D $postgresData -U wp01_probe -A trust --encoding=UTF8 --no-locale
    if ($LASTEXITCODE -ne 0) { throw 'disposable PostgreSQL initdb failed' }

    $phase = 'start-disposable-postgresql'
    & $pgCtl -D $postgresData -l $postgresLog `
        -o "-h 127.0.0.1 -p $postgresPort -F" start -w
    if ($LASTEXITCODE -ne 0) { throw 'disposable PostgreSQL start failed' }
    $postgresStarted = $true
    $env:PAPERCLIP_DATABASE_URL = "postgresql://wp01_probe@127.0.0.1:$postgresPort/postgres"
    $env:WP00_DATABASE_URL = $env:PAPERCLIP_DATABASE_URL
    $env:PAPERCLIP_LIFECYCLE_RESULT_PATH = $lifecycleEvidence
    $env:PAPERCLIP_LIFECYCLE_PHASE_PATH = $lifecyclePhases

    $phase = 'run-wp02-postgresql'
    & node --import $importUrls[0] --test --test-reporter=tap --test-timeout=120000 `
        (Join-Path $Repo 'tests/sql-connection-store.postgres.integration.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows WP02 PostgreSQL integration failed' }

    $phase = 'run-host-lifecycle'
    Write-Output "::notice title=Windows lifecycle phase::$phase - starting node with 2 file URL imports"
    & node --import $importUrls[0] --import $importUrls[1] `
        (Join-Path $Repo 'tests/host-lifecycle.integration.mjs') `
        1> $lifecycleStdout 2> $lifecycleStderr
    $lifecycleExitCode = $LASTEXITCODE
    $exitMarker = [ordered]@{
        check = 'isolated-host-lifecycle-phase'
        phase = 'process-exit'
        sourceRevision = $SourceRevision
        exitCode = $lifecycleExitCode
    } | ConvertTo-Json -Compress
    Add-Content -LiteralPath $lifecyclePhases -Value $exitMarker -Encoding utf8
    Get-Content -LiteralPath $lifecycleStdout | Write-Output
    Get-Content -LiteralPath $lifecycleStderr | Write-Output
    Get-Content -LiteralPath $lifecycleEvidence | Write-Output
    Get-Content -LiteralPath $lifecyclePhases | Write-Output
    Write-Output "::notice title=Windows lifecycle phase::$phase - node exit code $lifecycleExitCode"
    if ($lifecycleExitCode -ne 0) { throw "Windows host lifecycle failed with exit code $lifecycleExitCode" }

    $lifecycle = Get-Content -Raw -LiteralPath $lifecycleEvidence
    if ([string]::IsNullOrWhiteSpace($lifecycle)) { throw 'Windows lifecycle evidence is empty' }
    $phaseEvidence = Get-Content -Raw -LiteralPath $lifecyclePhases
    if ([string]::IsNullOrWhiteSpace($phaseEvidence)) { throw 'Windows lifecycle phase evidence is empty' }
    & node (Join-Path $Repo 'scripts/lifecycle-evidence.mjs') `
        $lifecycleEvidence $lifecyclePhases $SourceRevision
    if ($LASTEXITCODE -ne 0) { throw 'Windows lifecycle evidence is invalid' }
} finally {
    Remove-Item Env:PAPERCLIP_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:WP00_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:PAPERCLIP_LIFECYCLE_RESULT_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:PAPERCLIP_LIFECYCLE_PHASE_PATH -ErrorAction SilentlyContinue
    if ($postgresStarted) {
        $phase = 'stop-disposable-postgresql'
        & $pgCtl -D $postgresData stop -m fast -w
        if ($LASTEXITCODE -ne 0) { throw 'disposable PostgreSQL stop failed' }
    }
}

[ordered]@{
    probe = 'wp01-windows-host-lifecycle'
    status = 'pass'
    sourceRevision = $SourceRevision
    hostCommit = 'd69631b01b9c658f80bf8bed389863dce82643e1'
    database = 'disposable-loopback-postgresql'
    syntheticDataOnly = $true
    packageDigestVerifiedAt = @('install', 'restore')
} | ConvertTo-Json -Compress
