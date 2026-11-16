$ErrorActionPreference = 'Stop'
$realCorepack = (Get-Command corepack.cmd -ErrorAction Stop).Source
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("wp01-corepack-negative-" + [guid]::NewGuid().ToString('N'))
$originalPath = $env:PATH

try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $shim = @(
        '@echo off'
        'if "%~1"=="--version" (echo 0.34.4 & exit /b 0)'
        ('"{0}" %*' -f $realCorepack)
    )
    Set-Content -LiteralPath (Join-Path $fixtureRoot 'corepack.cmd') -Value $shim -Encoding ascii
    $env:PATH = "$fixtureRoot;$originalPath"

    $output = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verify-runner-contract.ps1') 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) { throw 'mismatched Corepack version unexpectedly passed the Windows runner contract' }
    $result = ($output | Select-Object -Last 1) | ConvertFrom-Json
    if ($result.status -ne 'fail') { throw "expected fail status, got '$($result.status)'" }
    if (-not ($result.mismatches -match '^corepack: expected')) {
        throw "Corepack mismatch was not reported: $($result.mismatches -join '; ')"
    }
    [ordered]@{ probe='windows-corepack-negative'; status='pass'; rejected='0.34.4' } | ConvertTo-Json -Compress
}
finally {
    $env:PATH = $originalPath
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
