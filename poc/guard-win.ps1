$ErrorActionPreference = 'Stop'

try {
    Add-Type -Path (Join-Path $PSScriptRoot 'GuardWin.cs')
    if ($env:QUOTAFLOW_GUARD_VERIFY -eq '1') {
        $quotaGuardReady = Get-Content -Raw -LiteralPath (Join-Path $env:QUOTAFLOW_GUARD_STATUS 'ready.json') | ConvertFrom-Json
        [QuotaFlowGuard]::VerifyStopped($env:QUOTAFLOW_GUARD_STATUS, $quotaGuardReady.job, $quotaGuardReady.session,
            $quotaGuardReady.supervisorPid, $quotaGuardReady.workerPid)
        exit 0
    }
    $quotaWorkerArguments = [string[]]((ConvertFrom-Json -InputObject $env:QUOTAFLOW_GUARD_ARGS).args)
    [QuotaFlowGuard]::Run(
        $env:QUOTAFLOW_GUARD_EXE,
        $quotaWorkerArguments,
        $env:QUOTAFLOW_GUARD_CWD,
        $env:QUOTAFLOW_GUARD_STATUS,
        [uint32]$env:QUOTAFLOW_GUARD_OWNER,
        [int64]$env:QUOTAFLOW_GUARD_CREATED_BY,
        $env:QUOTAFLOW_GUARD_JOB
    )
} catch {
    [IO.File]::WriteAllText((Join-Path $env:QUOTAFLOW_GUARD_STATUS 'guard-error.txt'), $_.Exception.Message)
    exit 70
}
