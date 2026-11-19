param(
    [Parameter(Mandatory = $true)]
    [string]$PaperclipSource,

    [string]$ExpectationPath = (Join-Path $PSScriptRoot 'expected-host-fingerprint.json')
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PaperclipSource).Path
$expectation = Get-Content -Raw -LiteralPath $ExpectationPath | ConvertFrom-Json
$mismatches = [System.Collections.Generic.List[object]]::new()

$dirtyStatus = (& git -C $source status --porcelain=v1 --untracked-files=all) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
if ($dirtyStatus.Length -ne 0) { throw "source is dirty: $($dirtyStatus.Split("`n")[0])" }
$sparse = (& git -C $source config --bool core.sparseCheckout 2>$null) -join ''
if ($sparse -ceq 'true') { throw 'sparse checkout is not accepted by the reproducibility gate' }
$worktrees = @(& git -C $source worktree list --porcelain | Where-Object { $_ -like 'worktree *' })
if ($LASTEXITCODE -ne 0 -or $worktrees.Count -ne 1) { throw 'additional or unreadable worktree state' }
if (Test-Path -LiteralPath (Join-Path $source '.gitmodules')) {
    $submodules = @(& git -C $source submodule status --recursive)
    if ($LASTEXITCODE -ne 0 -or @($submodules | Where-Object { -not $_.StartsWith(' ') }).Count -ne 0) {
        throw 'uninitialized or divergent submodule state'
    }
}

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
$tree = (& git -C $source rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'git tree lookup failed' }
$repository = (& git -C $source remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git origin lookup failed' }
$tagCommit = (& git -C $source rev-parse "$($expectation.source.tag)^{commit}").Trim()
if ($LASTEXITCODE -ne 0) { throw "git tag lookup failed: $($expectation.source.tag)" }
$describe = (& git -C $source describe --always --dirty).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git describe failed' }
$trackedDiffHash = (& git -C $source diff --binary HEAD | git hash-object --stdin).Trim()
if ($LASTEXITCODE -ne 0) { throw 'tracked diff hash failed' }
$nodeVersion = (& node --version).Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0) { throw 'node --version failed' }

$sdkPackage = Get-Content -Raw -LiteralPath (Join-Path $source 'packages/plugins/sdk/package.json') | ConvertFrom-Json
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $source 'package.json') | ConvertFrom-Json
$runnerPackage = Get-Content -Raw -LiteralPath (Join-Path $source 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/package.json') | ConvertFrom-Json
$sourceLockPath = Join-Path $source $expectation.source.lockfile.path
$sourceLockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceLockPath).Hash.ToLowerInvariant()
$registryLockPath = Join-Path $PSScriptRoot $expectation.registryLockPath
$registryLock = Get-Content -Raw -LiteralPath $registryLockPath | ConvertFrom-Json -AsHashtable

Compare-Value 'source.repository' $expectation.source.repository $repository
Compare-Value 'source.commit' $expectation.source.commit $commit
Compare-Value 'source.tagCommit' $expectation.source.commit $tagCommit
Compare-Value 'source.tree' $expectation.source.tree $tree
Compare-Value 'source.trackedDiffHash' $expectation.source.trackedDiffHash $trackedDiffHash
Compare-Value 'source.packageManager' $expectation.source.packageManager $rootPackage.packageManager
Compare-Value 'source.lockfile.sha256' $expectation.source.lockfile.sha256 $sourceLockHash
Compare-Value 'nodeVersion' $expectation.nodeVersion $nodeVersion
Compare-Value 'sdk.name' $expectation.sdk.name $sdkPackage.name
Compare-Value 'sdk.sourceVersion' $expectation.sdk.sourceVersion $sdkPackage.version
Compare-Value 'sdk.nodeEngine' $expectation.sdk.nodeEngine $sdkPackage.engines.node
Compare-Value 'runner.package' $expectation.runner.package $runnerPackage.name
Compare-Value 'runner.version' $expectation.runner.version $runnerPackage.version

Compare-Value 'registryLock.lockfileVersion' 3 $registryLock.lockfileVersion
Compare-Value 'registryLock.sdkDependency' $expectation.sdk.publishedVersion $registryLock.packages[''].dependencies['@paperclipai/plugin-sdk']
foreach ($property in $expectation.registryPackages.PSObject.Properties) {
    $packagePath = "node_modules/$($property.Name)"
    $locked = $registryLock.packages[$packagePath]
    if ($null -eq $locked) {
        Add-Mismatch "registryPackages.$($property.Name)" $property.Value $null
        continue
    }
    Compare-Value "registryPackages.$($property.Name).version" $property.Value.version $locked.version
    Compare-Value "registryPackages.$($property.Name).resolved" $property.Value.resolved $locked.resolved
    Compare-Value "registryPackages.$($property.Name).integrity" $property.Value.integrity $locked.integrity
}
foreach ($entry in $registryLock.packages.GetEnumerator()) {
    if ($entry.Key -eq '') { continue }
    if ([string]::IsNullOrWhiteSpace([string]$entry.Value.version) -or
        [string]::IsNullOrWhiteSpace([string]$entry.Value.resolved) -or
        [string]::IsNullOrWhiteSpace([string]$entry.Value.integrity)) {
        Add-Mismatch "registryLock.complete.$($entry.Key)" 'version, resolved, and integrity' $entry.Value
    }
}

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

$runnerPath = Join-Path $source $expectation.runner.relativeCliPath
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    Add-Mismatch 'runner.relativeCliPath' $expectation.runner.relativeCliPath $null
}

$result = [ordered]@{
    probe = 'host-fingerprint'
    status = if ($mismatches.Count -eq 0) { 'pass' } else { 'fail' }
    source = $source
    repository = $repository
    tag = $expectation.source.tag
    commit = $commit
    tree = $tree
    gitDescribeInformational = $describe
    trackedDiffHash = $trackedDiffHash
    packageManager = $rootPackage.packageManager
    sourceLockSha256 = $sourceLockHash
    nodeVersion = $nodeVersion
    sdk = [ordered]@{ name = $sdkPackage.name; sourceVersion = $sdkPackage.version; publishedVersion = $expectation.sdk.publishedVersion; nodeEngine = $sdkPackage.engines.node }
    registryPackages = $expectation.registryPackages
    runner = [ordered]@{ package = $runnerPackage.name; version = $runnerPackage.version; path = $runnerPath }
    files = $actualFiles
    mismatches = $mismatches
}
$result | ConvertTo-Json -Depth 8 -Compress
if ($mismatches.Count -ne 0) { exit 1 }
