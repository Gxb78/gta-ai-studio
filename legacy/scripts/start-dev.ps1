param(
    [ValidateSet('tauri', 'web')]
    [string]$Frontend = 'tauri',
    [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$ownedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Test-Command([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-Api {
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/v1/health' -TimeoutSec 1
        return $response.status -in @('ok', 'degraded')
    } catch {
        return $false
    }
}

function Start-OwnedProcess([string]$FilePath, [string[]]$ArgumentList) {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $repoRoot -PassThru -NoNewWindow
    $ownedProcesses.Add($process)
    return $process
}

function Stop-OwnedProcessTree([int]$RootProcessId) {
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ordered = [System.Collections.Generic.List[int]]::new()
    function Add-Children([int]$ParentId) {
        foreach ($child in $snapshot | Where-Object { $_.ParentProcessId -eq $ParentId }) {
            Add-Children ([int]$child.ProcessId)
            $ordered.Add([int]$child.ProcessId)
        }
    }
    Add-Children $RootProcessId
    $ordered.Add($RootProcessId)
    foreach ($processId in $ordered) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Command 'uv')) { throw 'uv est introuvable. Installe uv puis relance npm run dev.' }
if (-not (Test-Command 'npm')) { throw 'npm est introuvable. Installe Node.js puis relance npm run dev.' }

$apiProcess = $null
try {
    if (Test-Api) {
        Write-Host '[studio] API existante détectée sur http://127.0.0.1:8765'
    } else {
        Write-Host '[studio] Démarrage de l’API locale…'
        $apiProcess = Start-OwnedProcess 'uv' @('run', '--project', 'services/api', 'uvicorn', 'gta_studio_api.main:app', '--app-dir', 'services/api/src', '--host', '127.0.0.1', '--port', '8765')
        $deadline = (Get-Date).AddSeconds(45)
        while (-not (Test-Api)) {
            if ($apiProcess.HasExited) { throw "L’API s’est arrêtée avec le code $($apiProcess.ExitCode)." }
            if ((Get-Date) -gt $deadline) { throw 'L’API n’a pas répondu dans les 45 secondes.' }
            Start-Sleep -Milliseconds 350
        }
        Write-Host '[studio] API prête.'
    }

    $npmExecutable = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { (Get-Command 'npm.cmd').Source } else { (Get-Command 'npm').Source }
    $frontendArguments = if ($Frontend -eq 'tauri') {
        @('run', 'tauri', '--workspace', '@gta-ai-studio/desktop', '--', 'dev')
    } else {
        @('run', 'dev', '--workspace', '@gta-ai-studio/desktop')
    }
    Write-Host "[studio] Démarrage du frontend $Frontend…"
    $frontendProcess = Start-OwnedProcess $npmExecutable $frontendArguments

    if ($SmokeTest) {
        $frontendDeadline = (Get-Date).AddSeconds(45)
        while ($true) {
            if ($frontendProcess.HasExited) { throw "Le frontend s’est arrêté avec le code $($frontendProcess.ExitCode)." }
            try {
                $response = Invoke-WebRequest -Uri 'http://127.0.0.1:1420' -TimeoutSec 1 -UseBasicParsing
                if ($response.StatusCode -eq 200) { break }
            } catch {
                if ((Get-Date) -gt $frontendDeadline) { throw 'Le frontend n’a pas répondu dans les 45 secondes.' }
            }
            Start-Sleep -Milliseconds 350
        }
        Write-Host '[studio] Smoke test API + frontend réussi.'
        return
    }

    while (-not $frontendProcess.HasExited) {
        if ($apiProcess -and $apiProcess.HasExited) { throw "L’API s’est arrêtée avec le code $($apiProcess.ExitCode)." }
        Start-Sleep -Milliseconds 500
    }
    exit $frontendProcess.ExitCode
} finally {
    foreach ($process in $ownedProcesses) {
        if (-not $process.HasExited) {
            Stop-OwnedProcessTree $process.Id
        }
    }
}
