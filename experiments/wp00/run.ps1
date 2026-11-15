param(
    [string]$PaperclipSource = (Join-Path $PSScriptRoot '..\..\..\paperclip'),

    [int]$TestTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$resolvedSource = (Resolve-Path -LiteralPath $PaperclipSource).Path
$expectationPath = Join-Path $PSScriptRoot 'expected-host-fingerprint.json'
$fingerprintScript = Join-Path $PSScriptRoot 'verify-host-fingerprint.ps1'

& $fingerprintScript -PaperclipSource $resolvedSource -ExpectationPath $expectationPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$expectation = Get-Content -Raw -LiteralPath $expectationPath | ConvertFrom-Json
$tsx = Join-Path $resolvedSource $expectation.runner.relativeCliPath
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
    throw "Pinned tsx runner is missing: $($expectation.runner.relativeCliPath)"
}

$initdb = (Get-Command initdb -ErrorAction Stop).Source
$pgCtl = (Get-Command pg_ctl -ErrorAction Stop).Source
$scratchBase = if ($env:PAPERCLIP_RUN_SCRATCH_DIR) {
    $env:PAPERCLIP_RUN_SCRATCH_DIR
} else {
    [System.IO.Path]::GetTempPath()
}
$probeRoot = Join-Path $scratchBase ('wp00-probe-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $probeRoot 'postgres'
$logPath = Join-Path $probeRoot 'postgres.log'
New-Item -ItemType Directory -Path $probeRoot | Out-Null

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$env:PAPERCLIP_SOURCE = $resolvedSource
$testExit = 1
try {
    & $initdb -D $dataDir -U wp00_probe -A trust --encoding=UTF8 --no-locale
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
    & $pgCtl -D $dataDir -l $logPath -o "-h 127.0.0.1 -p $port -F" start -w
    if ($LASTEXITCODE -ne 0) { throw 'isolated PostgreSQL start failed' }

    $env:WP00_DATABASE_URL = "postgres://wp00_probe@127.0.0.1:$port/postgres"
    $timeoutMilliseconds = $TestTimeoutSeconds * 1000
    & node $tsx --test --test-reporter=tap "--test-timeout=$timeoutMilliseconds" `
        (Join-Path $PSScriptRoot 'operation-contract.test.ts')
    $testExit = $LASTEXITCODE
} finally {
    Remove-Item Env:WP00_DATABASE_URL -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $dataDir) {
        & $pgCtl -D $dataDir stop -m fast
    }
    $resolvedProbeRoot = [IO.Path]::GetFullPath($probeRoot)
    $resolvedScratchBase = [IO.Path]::GetFullPath($scratchBase)
    $leaf = [IO.Path]::GetFileName($resolvedProbeRoot)
    if (-not $resolvedProbeRoot.StartsWith($resolvedScratchBase, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith('wp00-probe-', [StringComparison]::Ordinal)) {
        throw "Refusing unsafe probe cleanup target: $resolvedProbeRoot"
    }
    Remove-Item -LiteralPath $resolvedProbeRoot -Recurse -Force
}

[ordered]@{
    probe = 'wp00-contracts'
    status = if ($testExit -eq 0) { 'pass' } else { 'fail' }
    database = 'isolated-temporary-postgresql'
    externalIo = $false
    testFile = 'experiments/wp00/operation-contract.test.ts'
    timeoutSeconds = $TestTimeoutSeconds
} | ConvertTo-Json -Compress
exit $testExit
