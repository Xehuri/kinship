[CmdletBinding()]
param(
    [switch]$Check,
    [string]$PythonExe = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Python = if ($PythonExe) { $PythonExe } else { Join-Path $RepoRoot '.venv\Scripts\python.exe' }

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    [Console]::Error.WriteLine("start: Python environment not found: $Python")
    [Console]::Error.WriteLine('       run setup.bat first')
    exit 3
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'config.yaml') -PathType Leaf)) {
    [Console]::Error.WriteLine('start: config.yaml is missing; run setup.bat first')
    exit 3
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'ai') -PathType Container)) {
    [Console]::Error.WriteLine('start: ai/ is missing; run setup.bat first')
    exit 3
}

if ($Check) {
    Write-Host 'start check: ok'
    exit 0
}

Write-Host 'Starting Kinship backend...'
Push-Location (Join-Path $RepoRoot 'backend')
try {
    & $Python -m core.hot_server
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
