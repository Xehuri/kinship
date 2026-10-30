<#
.SYNOPSIS
    Removes a pre-rebrand "Axeuh Health Desktop" installation.

.DESCRIPTION
    Runs the old per-user NSIS uninstaller silently when it is present, then
    removes any leftover program directory, shortcuts, and stale per-user
    uninstall registry entries.

    User data under %APPDATA%\Axeuh Health Desktop is NEVER read, moved, or
    deleted. The rebranded "Kinship Desktop" app keeps using that directory.

.PARAMETER LocalAppDataPath
    Overrides %LOCALAPPDATA%. Only useful for testing.

.PARAMETER RoamingAppDataPath
    Overrides %APPDATA%. Only used to print and guard the protected user data
    directory.

.PARAMETER UninstallTimeoutSeconds
    How long to wait for the old uninstaller to remove the install directory.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\cleanup-legacy-install.ps1 -WhatIf

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\cleanup-legacy-install.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$LocalAppDataPath = $env:LOCALAPPDATA,
    [string]$RoamingAppDataPath = $env:APPDATA,
    [ValidateRange(1, 3600)]
    [int]$UninstallTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$legacyName = 'Axeuh Health Desktop'
$newName = 'Kinship Desktop'

if ([string]::IsNullOrWhiteSpace($LocalAppDataPath)) {
    throw 'LOCALAPPDATA is not set. Run this script in a normal Windows user session.'
}

$programsRoot = Join-Path $LocalAppDataPath 'Programs'
$installDir = Join-Path $programsRoot $legacyName
$uninstaller = Join-Path $installDir "Uninstall $legacyName.exe"
$userDataDir = if ([string]::IsNullOrWhiteSpace($RoamingAppDataPath)) {
    ''
} else {
    Join-Path $RoamingAppDataPath $legacyName
}

$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) "$legacyName.lnk"
$startMenuRoot = [Environment]::GetFolderPath('Programs')
$startMenuShortcut = Join-Path $startMenuRoot "$legacyName.lnk"
$startMenuFolder = Join-Path $startMenuRoot $legacyName
$uninstallRegistryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

$summary = New-Object System.Collections.Generic.List[string]

Write-Host "Legacy install:   $installDir"
Write-Host "Legacy uninstall: $uninstaller"
if ($userDataDir.Length -gt 0) {
    Write-Host "User data (kept, never touched): $userDataDir"
}
Write-Host ''

$running = @(Get-Process -Name $legacyName -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    throw "Close the legacy app first: $($running | ForEach-Object { $_.Id })"
}

$removalTargets = @(
    @{ Path = $installDir; Label = 'legacy install directory' },
    @{ Path = $desktopShortcut; Label = 'desktop shortcut' },
    @{ Path = $startMenuShortcut; Label = 'Start Menu shortcut' },
    @{ Path = $startMenuFolder; Label = 'Start Menu folder' }
)

if ($userDataDir.Length -gt 0) {
    foreach ($target in $removalTargets) {
        $prefix = $userDataDir.TrimEnd('\') + '\'
        if ($target.Path -eq $userDataDir -or $target.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove user data path: $($target.Path)"
        }
    }
}

if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    if ($PSCmdlet.ShouldProcess($uninstaller, 'Run the legacy uninstaller silently')) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
        $process | Wait-Process -Timeout $UninstallTimeoutSeconds -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds($UninstallTimeoutSeconds)
        while ((Test-Path -LiteralPath $installDir) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
        if (Test-Path -LiteralPath $installDir) {
            $summary.Add("WARN    uninstaller finished but the directory is still present; leftover files will be removed")
        } else {
            $summary.Add("OK      legacy uninstaller completed")
        }
    } else {
        $summary.Add("WOULD   run the legacy uninstaller: $uninstaller")
    }
} else {
    $summary.Add("SKIP    legacy uninstaller not found")
}

foreach ($target in $removalTargets) {
    if (-not (Test-Path -LiteralPath $target.Path)) {
        $summary.Add("SKIP    $($target.Label) not found: $($target.Path)")
        continue
    }
    if ($PSCmdlet.ShouldProcess($target.Path, "Remove $($target.Label)")) {
        Remove-Item -LiteralPath $target.Path -Recurse -Force
        $summary.Add("REMOVED $($target.Label): $($target.Path)")
    } else {
        $summary.Add("WOULD   remove $($target.Label): $($target.Path)")
    }
}

if (Test-Path -LiteralPath $uninstallRegistryRoot) {
    foreach ($key in Get-ChildItem -LiteralPath $uninstallRegistryRoot -ErrorAction SilentlyContinue) {
        $displayName = ''
        $installLocation = ''
        try {
            $displayName = Get-ItemPropertyValue -LiteralPath $key.PSPath -Name DisplayName -ErrorAction Stop
        } catch {
            $displayName = ''
        }
        try {
            $installLocation = Get-ItemPropertyValue -LiteralPath $key.PSPath -Name InstallLocation -ErrorAction Stop
        } catch {
            $installLocation = ''
        }
        $matchesDisplayName = $displayName -eq $legacyName
        $matchesInstallLocation = $installLocation.Length -gt 0 -and $installLocation.TrimEnd('\') -eq $installDir.TrimEnd('\')
        if (-not ($matchesDisplayName -or $matchesInstallLocation)) {
            continue
        }
        if ($PSCmdlet.ShouldProcess($key.Name, "Remove stale uninstall registry entry for $legacyName")) {
            Remove-Item -LiteralPath $key.PSPath -Recurse -Force
            $summary.Add("REMOVED stale uninstall registry entry: $($key.Name)")
        } else {
            $summary.Add("WOULD   remove stale uninstall registry entry: $($key.Name)")
        }
    }
}

Write-Host ''
Write-Host "Summary ($legacyName -> $newName):"
foreach ($line in $summary) {
    Write-Host "  $line"
}
if ($WhatIfPreference) {
    Write-Host ''
    Write-Host 'Dry run: -WhatIf was set, so nothing was changed.'
}
Write-Host ''
Write-Host "User data was not touched: $userDataDir"
