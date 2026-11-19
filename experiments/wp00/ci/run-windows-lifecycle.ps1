param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Work,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceRevision
)

$ErrorActionPreference = 'Stop'
$phase = 'initialize'
trap {
    Write-Output "::error title=Windows lifecycle failed::$phase - lifecycle_phase_failed"
    exit 1
}
function ConvertTo-PostgresVersion([string]$Output, [string]$ExpectedMajor) {
    if ($Output -notmatch '^\S+ \(PostgreSQL\) (?<version>\d+\.\d+(?:\.\d+)?)$') { throw 'postgresql_version_invalid' }
    $version = $Matches.version
    if ($version.Split('.')[0] -ne $ExpectedMajor) { throw 'postgresql_major_mismatch' }
    return $version
}
function Assert-TapCounts([string]$Path, [int]$Count) {
    $lines = Get-Content -LiteralPath $Path
    foreach ($expected in @("# tests $Count", "# pass $Count", '# fail 0')) {
        if ($lines -notcontains $expected) { throw "PostgreSQL evidence missing '$expected' in $Path" }
    }
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

$phase = 'build-pinned-host-plugin-dependencies'
# Use the pinned host's own cross-platform compiler/fingerprint helper. The
# actual gateway imports the workspace SDK's dist entrypoint, not a test shim.
& node (Join-Path $source 'scripts/ensure-plugin-build-deps.mjs') 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'host-build-deps.log')
if ($LASTEXITCODE -ne 0) { throw 'pinned host plugin dependency build failed' }
foreach ($relative in @('packages/shared/dist/index.js', 'packages/plugins/sdk/dist/index.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)) {
        throw "pinned host build output missing: $relative"
    }
}
& pwsh -NoProfile -File (Join-Path $Repo 'experiments/wp00/verify-host-fingerprint.ps1') `
    -PaperclipSource $source 2>&1 | Tee-Object -FilePath (Join-Path $evidence 'host-fingerprint-after-build.jsonl')
if ($LASTEXITCODE -ne 0) { throw 'host fingerprint after dependency build failed' }

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
$phase = 'verify-postgresql-toolchain'
$runnerContract = Get-Content -LiteralPath (Join-Path $Repo 'experiments/wp00/runner-contract.json') -Raw | ConvertFrom-Json
$postgresMajor = [string]$runnerContract.windows.postgresqlMajor
if ($postgresMajor -notmatch '^\d+$') { throw 'postgresql_contract_invalid' }
$postgresBin = $env:PGBIN
if (-not $postgresBin -or -not [System.IO.Path]::IsPathFullyQualified($postgresBin) -or -not (Test-Path -LiteralPath $postgresBin -PathType Container)) { throw 'postgresql_bin_unavailable' }
$toolVersion = $null
$versionEvidence = Join-Path $evidence 'postgresql-tools.jsonl'
foreach ($tool in @('initdb', 'pg_ctl', 'postgres', 'pg_dump', 'pg_restore', 'createdb', 'dropdb')) {
    $phase = "verify-postgresql-$tool"
    $executable = Join-Path $postgresBin "$tool.exe"
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'postgresql_tool_missing' }
    $output = & $executable --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'postgresql_version_probe_failed' }
    $version = ConvertTo-PostgresVersion (($output -join "`n").Trim()) $postgresMajor
    if ($null -ne $toolVersion -and $toolVersion -ne $version) { throw 'postgresql_toolchain_mixed_versions' }
    $toolVersion = $version
    [ordered]@{ probe = 'postgresql-tool-version'; tool = $tool; version = $version; requiredMajor = $postgresMajor } |
        ConvertTo-Json -Compress | Tee-Object -FilePath $versionEvidence -Append
}
$initdb = Join-Path $postgresBin 'initdb.exe'
$pgCtl = Join-Path $postgresBin 'pg_ctl.exe'
$postgresData = Join-Path $Work 'postgres-data'
$postgresLog = Join-Path $evidence 'postgresql.log'
$postgresStarted = $false
$primaryFailure = $false

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
        (Join-Path $Repo 'tests/sql-connection-store.postgres.integration.ts') 2>&1 |
        Tee-Object -FilePath (Join-Path $evidence 'wp02-postgresql.tap')
    if ($LASTEXITCODE -ne 0) { throw 'Windows WP02 PostgreSQL integration failed' }
    Assert-TapCounts (Join-Path $evidence 'wp02-postgresql.tap') 6

    $phase = 'run-wp03-postgresql'
    & node --import $importUrls[0] --test --test-reporter=tap --test-timeout=120000 `
        (Join-Path $Repo 'tests/governance.postgres.integration.ts') 2>&1 |
        Tee-Object -FilePath (Join-Path $evidence 'wp03-postgresql.tap')
    if ($LASTEXITCODE -ne 0) { throw 'Windows WP03 PostgreSQL integration failed' }
    Assert-TapCounts (Join-Path $evidence 'wp03-postgresql.tap') 11

    $phase = 'run-wp04-postgresql'
    & node --import $importUrls[0] --test --test-reporter=tap --test-timeout=120000 `
        (Join-Path $Repo 'tests/telemetry.postgres.integration.ts') 2>&1 |
        Tee-Object -FilePath (Join-Path $evidence 'wp04-postgresql.tap')
    if ($LASTEXITCODE -ne 0) { throw 'Windows WP04 PostgreSQL integration failed' }
    Assert-TapCounts (Join-Path $evidence 'wp04-postgresql.tap') 6

    $phase = 'run-wp11-postgresql'
    $env:WP01_PACKAGE_PATH = $artifact
    $env:WP11_PG_DUMP = Join-Path $postgresBin 'pg_dump.exe'
    $env:WP11_PG_RESTORE = Join-Path $postgresBin 'pg_restore.exe'
    $env:WP11_BACKUP_PATH = Join-Path $Work 'wp11-schema.backup'
    & node --import $importUrls[0] --test --test-reporter=tap --test-timeout=120000 `
        (Join-Path $Repo 'tests/recovery.postgres.integration.ts') 2>&1 |
        Tee-Object -FilePath (Join-Path $evidence 'wp11-postgresql.tap')
    if ($LASTEXITCODE -ne 0) { throw 'Windows WP11 recovery integration failed' }
    Assert-TapCounts (Join-Path $evidence 'wp11-postgresql.tap') 5

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

    $phase = 'run-authenticated-agent-gateway'
    $env:PAPERCLIP_AGENT_GATEWAY_DATABASE_URL = "postgresql://wp01_probe@127.0.0.1:$postgresPort/paperclip_m365_agent_gateway"
    & (Join-Path $postgresBin 'createdb.exe') -h 127.0.0.1 -p $postgresPort -U wp01_probe paperclip_m365_agent_gateway
    if ($LASTEXITCODE -ne 0) { throw 'disposable agent gateway database creation failed' }
    $agentEvidence = Join-Path $evidence 'agent-gateway.log'
    & node --import $importUrls[0] --import $importUrls[1] `
        (Join-Path $Repo 'tests/host-agent-gateway.integration.mjs') 2>&1 | Tee-Object -FilePath $agentEvidence
    if ($LASTEXITCODE -ne 0) { throw 'Windows authenticated agent gateway failed' }
    if (-not (Select-String -LiteralPath $agentEvidence -SimpleMatch '"check":"isolated-authenticated-agent-gateway"' -Quiet)) { throw 'agent gateway evidence missing' }
    & (Join-Path $postgresBin 'dropdb.exe') -h 127.0.0.1 -p $postgresPort -U wp01_probe paperclip_m365_agent_gateway
    if ($LASTEXITCODE -ne 0) { throw 'disposable agent gateway database cleanup failed' }
} catch {
    # Preserve the operation phase. Cleanup must not overwrite its diagnosis.
    $primaryFailure = $true
    Write-Output "::error title=Windows lifecycle primary failure::$phase - lifecycle_phase_failed"
} finally {
    Remove-Item Env:PAPERCLIP_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:WP00_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:WP01_PACKAGE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:WP11_PG_DUMP -ErrorAction SilentlyContinue
    Remove-Item Env:WP11_PG_RESTORE -ErrorAction SilentlyContinue
    Remove-Item Env:WP11_BACKUP_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:PAPERCLIP_AGENT_GATEWAY_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:PAPERCLIP_LIFECYCLE_RESULT_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:PAPERCLIP_LIFECYCLE_PHASE_PATH -ErrorAction SilentlyContinue
    if ($postgresStarted) {
        try {
            & $pgCtl -D $postgresData stop -m fast -w
            if ($LASTEXITCODE -ne 0) { throw 'postgresql_stop_failed' }
        } catch {
            Write-Output '::error title=Windows lifecycle cleanup failure::stop-disposable-postgresql - postgresql_stop_failed'
            if (-not $primaryFailure) { $phase = 'stop-disposable-postgresql'; $primaryFailure = $true }
        }
    }
}
if ($primaryFailure) { exit 1 }

[ordered]@{
    probe = 'wp01-windows-host-lifecycle'
    status = 'pass'
    sourceRevision = $SourceRevision
    hostCommit = 'd69631b01b9c658f80bf8bed389863dce82643e1'
    database = 'disposable-loopback-postgresql'
    postgresqlVersion = $toolVersion
    syntheticDataOnly = $true
    wp02PostgresAssertions = '6/6'
    wp03PostgresAssertions = '11/11'
    wp04PostgresAssertions = '6/6'
    wp11PostgresAssertions = '5/5'
    authenticatedAgentGateway = 'actual-worker-jwt-http'
    packageDigestVerifiedAt = @('install', 'restore')
} | ConvertTo-Json -Compress
