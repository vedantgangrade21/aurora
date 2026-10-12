<#
  Creates an Aurora shortcut carrying the app icon.

    .\Create-Shortcut.ps1                -> on the Desktop
    .\Create-Shortcut.ps1 -Startup       -> starts with Windows, tray only
    .\Create-Shortcut.ps1 -OutDir C:\... -> somewhere specific

  The shortcut points straight at pythonw.exe rather than at Aurora.bat, so
  there is no console window and the icon applies to the running app.
#>
param(
    [switch]$Startup,
    [string]$OutDir
)

$root = Split-Path -Parent $PSCommandPath
$icon = Join-Path $root 'assets\aurora.ico'
$pyw = Join-Path $root '.venv\Scripts\pythonw.exe'
$py = Join-Path $root '.venv\Scripts\python.exe'

if (-not (Test-Path $pyw)) {
    throw "pythonw.exe not found at $pyw. Create the virtual environment first."
}
if (-not (Test-Path $icon)) {
    & $py -m aurora.icon | Out-Null
}
if (-not $OutDir) {
    $OutDir = if ($Startup) {
        [Environment]::GetFolderPath('Startup')
    } else {
        [Environment]::GetFolderPath('Desktop')
    }
}
if (-not (Test-Path $OutDir)) {
    throw "Target folder does not exist: $OutDir"
}

$target = Join-Path $OutDir 'Aurora.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($target)
$link.TargetPath = $pyw
$link.Arguments = if ($Startup) { '-m aurora --tray' } else { '-m aurora' }
$link.WorkingDirectory = $root
$link.IconLocation = "$icon,0"
$link.Description = 'Aurora - ambient album display'
$link.Save()

Write-Output "Created $target"
