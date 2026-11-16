param(
    [Parameter(Mandatory = $true)][string]$PaperclipSource,
    [Parameter(Mandatory = $true)][string]$TarballDirectory,
    [Parameter(Mandatory = $true)][string]$PreparedPackageRoot,
    [Parameter(Mandatory = $true)][string]$LinuxNodeRoot,
    [ValidateSet('selftest','positive')][string]$Mode = 'selftest',
    [string]$WslDistribution = 'Ubuntu'
)
$ErrorActionPreference = 'Stop'
function ConvertTo-WslPath([string]$Path) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if ($resolved -notmatch '^([A-Za-z]):\\(.*)$') { throw "Unsupported WSL path: $resolved" }
    return "/mnt/$($Matches[1].ToLowerInvariant())/$($Matches[2].Replace('\','/'))"
}
$repo = ConvertTo-WslPath (Join-Path $PSScriptRoot '..\..')
$source = ConvertTo-WslPath $PaperclipSource
$tarballs = ConvertTo-WslPath $TarballDirectory
$packages = ConvertTo-WslPath $PreparedPackageRoot
$nodeRoot = ConvertTo-WslPath $LinuxNodeRoot
$script = "$repo/experiments/wp00/isolation/run-gate.sh"
& wsl -d $WslDistribution --exec sh $script $Mode $repo $source $tarballs $packages $nodeRoot
exit $LASTEXITCODE
