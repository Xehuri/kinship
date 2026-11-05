param(
    [Parameter(Mandatory = $true)]
    [string]$AiRoot,
    [string]$Version = "",
    [string]$WorkspaceName = "personal",
    [ValidateSet("user", "system")]
    [string]$Scope = "user",
    [string]$Proxy = "",
    [switch]$NoProxy,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
    $Version = if ($env:STRATUM_VERSION) { $env:STRATUM_VERSION } else { "v0.1.3" }
}
if ($Proxy -and $NoProxy) {
    throw "Use either -Proxy or -NoProxy, not both."
}
if ($Scope -eq "system") {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Scope system requires an elevated PowerShell."
    }
}
if (-not (Test-Path -LiteralPath $AiRoot -PathType Container)) {
    throw "AI root does not exist: $AiRoot"
}

$Python = if (Get-Command python -ErrorAction SilentlyContinue) {
    "python"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    "py"
} else {
    throw "Python 3.11+ is required, but py/python was not found."
}

& $Python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.11 or newer is required."
}

$proxyKeys = @("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
$previousProxy = @{}
foreach ($key in $proxyKeys) {
    $previousProxy[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

function Show-Command {
    param([string]$Text)
    Write-Host $Text
}

try {
    if ($Proxy) {
        foreach ($key in $proxyKeys) {
            [Environment]::SetEnvironmentVariable($key, $Proxy, "Process")
        }
    } elseif ($NoProxy) {
        foreach ($key in $proxyKeys) {
            [Environment]::SetEnvironmentVariable($key, $null, "Process")
        }
    } elseif ($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:http_proxy -or $env:https_proxy) {
        Write-Warning "A proxy environment variable is set. If GitHub TLS fails, retry with -NoProxy or pass -Proxy <url>."
    }

    $pipArgs = @("-m", "pip", "install")
    if ($Scope -eq "user") {
        $pipArgs += "--user"
    }
    $source = "git+https://github.com/Xehuri/stratum.git@$Version"
    $initArgs = @("-m", "stratum", "init", "--root", $AiRoot, "--name", $WorkspaceName)
    $statusArgs = @("-m", "stratum", "status")
    $versionArgs = @("-m", "stratum", "--version")

    if ($DryRun) {
        Show-Command "$Python $($pipArgs -join ' ') $source"
        Show-Command "$Python $($versionArgs -join ' ')"
        Show-Command "$Python $($initArgs -join ' ')"
        Show-Command "$Python $($statusArgs -join ' ')"
        Write-Host "Dry run only; no changes made."
        exit 0
    }

    & $Python @pipArgs $source
    if ($LASTEXITCODE -ne 0) {
        throw "Stratum install failed."
    }

    $versionOutput = & $Python @versionArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Stratum version check failed."
    }
    $expected = "stratum " + $Version.TrimStart("v")
    if (($versionOutput | Out-String).Trim() -ne $expected) {
        throw "Unexpected Stratum version: $versionOutput (expected $expected)"
    }

    $marker = Join-Path $AiRoot ".stratum\workspace.toml"
    if (Test-Path -LiteralPath $marker -PathType Leaf) {
        Write-Host "Workspace already initialized: $AiRoot"
        & $Python @statusArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Stratum status failed."
        }
        exit 0
    }

    if (-not $Force) {
        $answer = Read-Host "Initialize Stratum workspace at '$AiRoot'? [y/N]"
        if ($answer -notmatch '^[yY]') {
            throw "Aborted before init."
        }
    }

    & $Python @initArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Stratum init failed."
    }
    & $Python @statusArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Stratum status failed."
    }
} finally {
    foreach ($key in $proxyKeys) {
        [Environment]::SetEnvironmentVariable($key, $previousProxy[$key], "Process")
    }
}
