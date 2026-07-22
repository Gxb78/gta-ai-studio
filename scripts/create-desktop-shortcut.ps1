param(
    [string]$Executable = (Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\desktop\src-tauri\target\release\gta-ai-studio.exe')
)

$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'GTA AI Studio.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $resolvedExecutable
$shortcut.WorkingDirectory = Split-Path -Parent $resolvedExecutable
$shortcut.IconLocation = "$resolvedExecutable,0"
$shortcut.Description = 'Ouvrir GTA AI Studio'
$shortcut.Save()
Write-Output $shortcutPath
