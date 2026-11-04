param(
    [Parameter(Mandatory = $true)]
    [string]$AiRoot,
    [string]$Version = "v0.1.0",
    [string]$WorkspaceName = "personal"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $AiRoot -PathType Container)) {
    throw "AI root does not exist: $AiRoot"
}

py -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
py -m pip install "git+https://github.com/Xehuri/stratum.git@$Version"
py -m stratum --version
py -m stratum init --root $AiRoot --name $WorkspaceName
py -m stratum status
