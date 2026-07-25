param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$binaryDir = Join-Path $repoRoot "apps\desktop\src-tauri\binaries"
$buildDir = Join-Path $repoRoot "apps\desktop\.sidecar-build"
$migrationDir = Join-Path $repoRoot "packages\database\migrations"
$speechScript = Join-Path $repoRoot "services\api\scripts\synthesize_speech.ps1"
$gameAdapterDir = Join-Path $repoRoot "game-adapters"
$templateDir = Join-Path $repoRoot "templates"
$outputName = "gta-studio-api-$TargetTriple.exe"
$outputPath = Join-Path $binaryDir $outputName

New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

Push-Location $repoRoot
try {
    uv run --project services/api pyinstaller `
        --noconfirm `
        --clean `
        --onefile `
        --name gta-studio-api `
        --paths services/api/src `
        --collect-submodules gta_studio_api `
        --collect-all rapidocr `
        --collect-all onnxruntime `
        --hidden-import gta_studio_api.main `
        --add-data "$migrationDir;migrations" `
        --add-data "$speechScript;scripts" `
        --add-data "$gameAdapterDir;game-adapters" `
        --add-data "$templateDir;templates" `
        --distpath "$buildDir\dist" `
        --workpath "$buildDir\work" `
        --specpath "$buildDir" `
        services/api/src/gta_studio_api/sidecar.py
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE"
    }
    Copy-Item -LiteralPath "$buildDir\dist\gta-studio-api.exe" -Destination $outputPath -Force
    & $outputPath --smoke-test
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged sidecar smoke test failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host "Sidecar ready: $outputPath"
