param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectId,

    [string]$ReadOnlyTool = 'srahmel.personal-todo:list_tasks'
)

$ErrorActionPreference = 'Stop'
$requiredEnvironment = @(
    'PAPERCLIP_API_URL',
    'PAPERCLIP_API_KEY',
    'PAPERCLIP_COMPANY_ID',
    'PAPERCLIP_AGENT_ID',
    'PAPERCLIP_RUN_ID'
)
foreach ($name in $requiredEnvironment) {
    if (-not [Environment]::GetEnvironmentVariable($name)) {
        throw "Required environment variable is missing: $name"
    }
}

$base = $env:PAPERCLIP_API_URL.TrimEnd('/')
$api = if ($base.EndsWith('/api')) { $base } else { "$base/api" }
$headers = @{
    Authorization = "Bearer $env:PAPERCLIP_API_KEY"
    'Content-Type' = 'application/json'
}

function Invoke-RejectedProbe {
    param(
        [string]$Name,
        [string]$CompanyId,
        [string]$AgentId,
        [string]$RunId,
        [string]$ProbeProjectId
    )

    $body = @{
        tool = $ReadOnlyTool
        parameters = @{}
        runContext = @{
            companyId = $CompanyId
            agentId = $AgentId
            runId = $RunId
            projectId = $ProbeProjectId
        }
    } | ConvertTo-Json -Depth 5 -Compress
    $response = Invoke-WebRequest -Uri "$api/plugins/tools/execute" -Headers $headers -Method Post -Body $body -SkipHttpErrorCheck
    $parsed = $null
    try { $parsed = $response.Content | ConvertFrom-Json } catch { }
    [pscustomobject]@{
        case = $Name
        status = [int]$response.StatusCode
        error = $parsed.error
    }
}

$negativeResults = @(
    Invoke-RejectedProbe 'foreign-company' '00000000-0000-4000-8000-000000000001' $env:PAPERCLIP_AGENT_ID $env:PAPERCLIP_RUN_ID $ProjectId
    Invoke-RejectedProbe 'forged-agent' $env:PAPERCLIP_COMPANY_ID '00000000-0000-4000-8000-000000000002' $env:PAPERCLIP_RUN_ID $ProjectId
    Invoke-RejectedProbe 'forged-run' $env:PAPERCLIP_COMPANY_ID $env:PAPERCLIP_AGENT_ID '00000000-0000-4000-8000-000000000003' $ProjectId
    Invoke-RejectedProbe 'foreign-project' $env:PAPERCLIP_COMPANY_ID $env:PAPERCLIP_AGENT_ID $env:PAPERCLIP_RUN_ID '00000000-0000-4000-8000-000000000004'
)
foreach ($result in $negativeResults) {
    if ($result.status -ne 403) {
        throw "Expected HTTP 403 for $($result.case), received $($result.status)"
    }
}

$bytes = New-Object byte[] (4 * 1024 * 1024)
[Array]::Fill[byte]($bytes, 0xA5)
$base64 = [Convert]::ToBase64String($bytes)
$largeBody = @{
    tool = $ReadOnlyTool
    parameters = @{ contentBase64 = $base64 }
    runContext = @{
        companyId = $env:PAPERCLIP_COMPANY_ID
        agentId = $env:PAPERCLIP_AGENT_ID
        runId = $env:PAPERCLIP_RUN_ID
        projectId = $ProjectId
    }
} | ConvertTo-Json -Depth 5 -Compress
$largeResponse = Invoke-WebRequest -Uri "$api/plugins/tools/execute" -Headers $headers -Method Post -Body $largeBody -SkipHttpErrorCheck
if ([int]$largeResponse.StatusCode -ne 200) {
    throw "Expected HTTP 200 for the synthetic 4-MiB request, received $([int]$largeResponse.StatusCode)"
}

[pscustomobject]@{
    status = 'pass'
    negativeCases = $negativeResults
    transport = [pscustomobject]@{
        status = [int]$largeResponse.StatusCode
        requestBytes = [Text.Encoding]::UTF8.GetByteCount($largeBody)
        rawBytes = $bytes.Length
        base64Bytes = [Text.Encoding]::UTF8.GetByteCount($base64)
        responseBytes = [Text.Encoding]::UTF8.GetByteCount($largeResponse.Content)
    }
} | ConvertTo-Json -Depth 5
