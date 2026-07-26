param(
    [string]$SourceDirectory = $env:GTA_STUDIO_FFMPEG_DIR
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $repositoryRoot "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $destination | Out-Null

function Resolve-MediaTool([string]$name) {
    if ($SourceDirectory) {
        $candidate = Join-Path $SourceDirectory "$name.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
        throw "$name.exe est absent de GTA_STUDIO_FFMPEG_DIR ($SourceDirectory)."
    }

    $command = Get-Command "$name.exe" -CommandType Application -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "$name.exe est introuvable. Installe FFmpeg ou définis GTA_STUDIO_FFMPEG_DIR."
    }
    return $command.Source
}

foreach ($name in @("ffmpeg", "ffprobe")) {
    $source = Resolve-MediaTool $name
    $target = Join-Path $destination "$name.exe"
    Copy-Item -LiteralPath $source -Destination $target -Force
    $versionOutput = & $target -version 2>&1
    $versionExitCode = $LASTEXITCODE
    $versionOutput | Select-Object -First 1
    if ($versionExitCode -ne 0) {
        throw "Le binaire provisionné $target ne démarre pas."
    }
}

Write-Host "FFmpeg et FFprobe prêts dans $destination"
