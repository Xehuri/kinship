param(
    [Parameter(Mandatory = $true)]
    [string]$AiRoot,
    [string]$Index = "",
    [string]$Workspace = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $AiRoot -PathType Container)) {
    throw "AI root does not exist: $AiRoot"
}

$AiRoot = (Resolve-Path -LiteralPath $AiRoot).Path
if (-not $Index) {
    $Index = Join-Path $AiRoot "data/index"
}
if (-not (Test-Path -LiteralPath $Index -PathType Container)) {
    throw "legacy index directory does not exist: $Index"
}
$Index = (Resolve-Path -LiteralPath $Index).Path

$Python = if (Get-Command python -ErrorAction SilentlyContinue) {
    "python"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    "py"
} else {
    throw "Python 3.11+ is required, but py/python was not found."
}

$stratumArgs = @("-m", "stratum", "migrate-legacy", "--index", $Index)
if ($Workspace) {
    $stratumArgs += @("--workspace", $Workspace)
}

if ($DryRun) {
    Write-Host ("Would run: " + $Python + " " + ($stratumArgs -join " "))
    exit 0
}

Push-Location -LiteralPath $AiRoot
try {
    & $Python @stratumArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Legacy import failed."
    }
} finally {
    Pop-Location
}
