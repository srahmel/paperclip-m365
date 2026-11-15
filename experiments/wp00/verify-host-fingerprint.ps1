param(
    [Parameter(Mandatory = $true)]
    [string]$PaperclipSource,

    [string]$ExpectationPath = (Join-Path $PSScriptRoot 'expected-host-fingerprint.json')
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PaperclipSource).Path
$expectation = Get-Content -Raw -LiteralPath $ExpectationPath | ConvertFrom-Json
$mismatches = [System.Collections.Generic.List[object]]::new()

function Add-Mismatch {
    param([string]$Field, [object]$Expected, [object]$Actual)
    $mismatches.Add([ordered]@{ field = $Field; expected = $Expected; actual = $Actual })
}

function Compare-Value {
    param([string]$Field, [object]$Expected, [object]$Actual)
    if ([string]$Expected -cne [string]$Actual) { Add-Mismatch $Field $Expected $Actual }
}

$commit = (& git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed' }
$describe = (& git -C $source describe --always --dirty).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git describe failed' }
$trackedDiffHash = (& git -C $source diff --binary HEAD | git hash-object --stdin).Trim()
if ($LASTEXITCODE -ne 0) { throw 'tracked diff hash failed' }
$nodeVersion = (& node --version).Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0) { throw 'node --version failed' }

$sdkPackage = Get-Content -Raw -LiteralPath (Join-Path $source 'packages/plugins/sdk/package.json') | ConvertFrom-Json
$runnerPackage = Get-Content -Raw -LiteralPath (Join-Path $source 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/package.json') | ConvertFrom-Json

Compare-Value 'commit' $expectation.commit $commit
Compare-Value 'trackedDiffHash' $expectation.trackedDiffHash $trackedDiffHash
Compare-Value 'nodeVersion' $expectation.nodeVersion $nodeVersion
Compare-Value 'sdk.name' $expectation.sdk.name $sdkPackage.name
Compare-Value 'sdk.version' $expectation.sdk.version $sdkPackage.version
Compare-Value 'sdk.nodeEngine' $expectation.sdk.nodeEngine $sdkPackage.engines.node
Compare-Value 'runner.package' $expectation.runner.package $runnerPackage.name
Compare-Value 'runner.version' $expectation.runner.version $runnerPackage.version

$actualFiles = [ordered]@{}
foreach ($property in $expectation.files.PSObject.Properties) {
    $path = Join-Path $source $property.Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $actualFiles[$property.Name] = $null
        Add-Mismatch "files.$($property.Name)" $property.Value $null
        continue
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    $actualFiles[$property.Name] = $hash
    Compare-Value "files.$($property.Name)" $property.Value $hash
}

$trackedFiles = [ordered]@{}
foreach ($property in $expectation.preExistingTrackedFiles.PSObject.Properties) {
    $path = Join-Path $source $property.Name
    $hash = if (Test-Path -LiteralPath $path -PathType Leaf) {
        (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    } else { $null }
    $trackedFiles[$property.Name] = $hash
    Compare-Value "preExistingTrackedFiles.$($property.Name)" $property.Value $hash
}

$runnerPath = Join-Path $source $expectation.runner.relativeCliPath
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    Add-Mismatch 'runner.relativeCliPath' $expectation.runner.relativeCliPath $null
}

$result = [ordered]@{
    probe = 'host-fingerprint'
    status = if ($mismatches.Count -eq 0) { 'pass' } else { 'fail' }
    source = $source
    commit = $commit
    gitDescribeInformational = $describe
    trackedDiffHash = $trackedDiffHash
    nodeVersion = $nodeVersion
    sdk = [ordered]@{ name = $sdkPackage.name; version = $sdkPackage.version; nodeEngine = $sdkPackage.engines.node }
    runner = [ordered]@{ package = $runnerPackage.name; version = $runnerPackage.version; path = $runnerPath }
    files = $actualFiles
    preExistingTrackedFiles = $trackedFiles
    mismatches = $mismatches
}
$result | ConvertTo-Json -Depth 8 -Compress
if ($mismatches.Count -ne 0) { exit 1 }
