param(
    [ValidateSet('Offline')]
    [string]$Mode = 'Offline'
)

$ErrorActionPreference = 'Stop'

# There is deliberately no execute mode in WP00. A future live mode requires a
# separately approved isolated Paperclip instance and dummy-data contract.
$safeTool = [ordered]@{
    id = 'wp00.synthetic:echo'
    risk = 'read'
    sideEffects = $false
    dataClass = 'synthetic'
    transport = 'local-only'
}

function Test-SafeDispatchMetadata {
    param([hashtable]$Metadata)

    if ($Metadata.id -cne $safeTool.id) { throw 'tool is not on the fixed WP00 allowlist' }
    if ($Metadata.risk -cne $safeTool.risk) { throw 'tool risk class is not read-only' }
    if ($Metadata.sideEffects -ne $false) { throw 'tool metadata permits side effects' }
    if ($Metadata.dataClass -cne 'synthetic') { throw 'tool metadata permits non-synthetic data' }
    if ($Metadata.transport -cne 'local-only') { throw 'tool metadata permits a remote dispatch' }
    return $true
}

$allowed = Test-SafeDispatchMetadata ([hashtable]$safeTool)
$negativeCases = @(
    @{ name = 'arbitrary-tool-id'; metadata = @{ id = 'srahmel.personal-todo:list_tasks'; risk = 'read'; sideEffects = $false; dataClass = 'synthetic'; transport = 'local-only' } },
    @{ name = 'unsafe-risk'; metadata = @{ id = $safeTool.id; risk = 'write'; sideEffects = $false; dataClass = 'synthetic'; transport = 'local-only' } },
    @{ name = 'side-effects'; metadata = @{ id = $safeTool.id; risk = 'read'; sideEffects = $true; dataClass = 'synthetic'; transport = 'local-only' } },
    @{ name = 'real-data'; metadata = @{ id = $safeTool.id; risk = 'read'; sideEffects = $false; dataClass = 'production'; transport = 'local-only' } },
    @{ name = 'remote-dispatch'; metadata = @{ id = $safeTool.id; risk = 'read'; sideEffects = $false; dataClass = 'synthetic'; transport = 'http' } }
)
$rejected = foreach ($case in $negativeCases) {
    try {
        $null = Test-SafeDispatchMetadata $case.metadata
        throw "unsafe case was accepted: $($case.name)"
    } catch {
        if ($_.Exception.Message -like 'unsafe case was accepted:*') { throw }
        [ordered]@{ case = $case.name; rejected = $true; reason = $_.Exception.Message }
    }
}

[ordered]@{
    probe = 'gateway-dispatch-contract'
    status = 'pass'
    mode = $Mode
    networkCalls = 0
    dispatches = 0
    allowedTool = $safeTool
    allowedMetadataAccepted = $allowed
    negativeCases = $rejected
} | ConvertTo-Json -Depth 6 -Compress
