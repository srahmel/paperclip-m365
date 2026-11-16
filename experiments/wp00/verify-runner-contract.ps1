param([string]$ContractPath = (Join-Path $PSScriptRoot 'runner-contract.json'))
$ErrorActionPreference = 'Stop'
$contract = Get-Content -Raw -LiteralPath $ContractPath | ConvertFrom-Json
$expected = $contract.windows
$mismatches = [Collections.Generic.List[string]]::new()
function Check([string]$Name, [string]$Wanted, [string]$Actual) {
    if ($Wanted -cne $Actual) { $mismatches.Add("${Name}: expected '$Wanted', got '$Actual'") }
}
Check 'node' $expected.node ((& node --version).Trim().TrimStart('v'))
Check 'npm' $expected.npm ((& npm --version).Trim())
Check 'pnpm' $expected.pnpm ((& corepack pnpm@$($expected.pnpm) --version).Trim())
Check 'git' $expected.git ((& git --version).Trim().Substring(12))
Check 'python' $expected.python ((& python --version).Trim().Substring(7))
$postgresVersion = (& postgres --version).Trim()
if ($postgresVersion -notmatch "^postgres \(PostgreSQL\) $([regex]::Escape($expected.postgresqlMajor))\.") { $mismatches.Add("postgresql: expected major $($expected.postgresqlMajor), got '$postgresVersion'") }
$msvcRoot = "C:\Program Files\Microsoft Visual Studio\$($expected.visualStudio)\Community\VC\Tools\MSVC\$($expected.msvc)"
if (-not (Test-Path -LiteralPath (Join-Path $msvcRoot 'bin\Hostx64\x64\cl.exe') -PathType Leaf)) { $mismatches.Add("MSVC missing: $msvcRoot") }
$sdkRoot = "C:\Program Files (x86)\Windows Kits\10\Include\$($expected.windowsSdk)"
if (-not (Test-Path -LiteralPath $sdkRoot -PathType Container)) { $mismatches.Add("Windows SDK missing: $sdkRoot") }
if (-not (Test-Path -LiteralPath $expected.vsDevCmd -PathType Leaf)) { $mismatches.Add("VsDevCmd missing: $($expected.vsDevCmd)") }
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($expected.workspaceRoot).TrimEnd(':','\'))
$required = [double]$contract.minimumFreeGiB + [double]$contract.reserveFreeGiB
$free = [math]::Round($drive.Free / 1GB, 2)
if ($free -lt $required) { $mismatches.Add("capacity: expected at least ${required} GiB free, got ${free} GiB") }
$result = [ordered]@{ probe='windows-runner-contract'; status=if($mismatches.Count){'fail'}else{'pass'}; freeGiB=$free; requiredGiB=$required; contract=$expected; mismatches=$mismatches }
$result | ConvertTo-Json -Depth 6 -Compress
if ($mismatches.Count) { exit 1 }
