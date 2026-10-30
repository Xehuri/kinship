# Kinship Windows 引导脚本
# 用法: setup.bat（双击）或 powershell -ExecutionPolicy Bypass -File setup.ps1
#
# 无管理员权限、不修改系统 PATH、不写注册表、不全局安装、不结束任何进程。
# 非交互参数（自动化/QA 用）:
#   -NonInteractive -PythonMode venv -PythonSource auto -PipIndex aliyun
#   -KernelMode skip -NoBrowser -Port 8768 -HealthTimeoutSeconds 180
# -PythonSource: menu（默认，缺 Python 时弹菜单）| auto（自动下载 3.12.10）| manual
# -PythonMode:   venv（默认，建 .venv）| existing（用已有 venv/conda；基础解释器拒绝，避免全局安装）
# -PipIndex:     aliyun（默认）| tsinghua | official | 自定义 https URL
# -KernelMode:   full（默认，构建+内核 venv+依赖）| build（只构建）| skip
# -SkipKernel:   -KernelMode skip 的别名
# -NoReuseRunning: 即使 8768 上已有 Kinship 健康实例也按“端口占用”报告并非 0 退出

[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [ValidateSet('menu', 'auto', 'manual')]
    [string]$PythonSource = 'menu',
    [string]$PythonExe = '',
    [ValidateSet('venv', 'existing')]
    [string]$PythonMode = 'venv',
    [string]$PipIndex = 'aliyun',
    [ValidateSet('full', 'build', 'skip')]
    [string]$KernelMode = 'full',
    [switch]$SkipKernel,
    [int]$Port = 8768,
    [switch]$NoBrowser,
    [switch]$NoReuseRunning,
    [int]$HealthTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:ConfigExample = Join-Path $script:RepoRoot 'config.example.yaml'
$script:ConfigPath = Join-Path $script:RepoRoot 'config.yaml'
$script:AiTemplate = Join-Path $script:RepoRoot 'ai-template'
$script:AiPath = Join-Path $script:RepoRoot 'ai'
if (-not (Test-Path -LiteralPath $script:ConfigPath) -and (Test-Path -LiteralPath $script:ConfigExample)) {
    Copy-Item -LiteralPath $script:ConfigExample -Destination $script:ConfigPath
}
if (-not (Test-Path -LiteralPath $script:AiPath) -and (Test-Path -LiteralPath $script:AiTemplate)) {
    Copy-Item -LiteralPath $script:AiTemplate -Destination $script:AiPath -Recurse
}
$script:RejectedPython = @()
$script:PythonModeBound = $PSBoundParameters.ContainsKey('PythonMode')
$script:PipIndexBound = $PSBoundParameters.ContainsKey('PipIndex')

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Warn([string]$Text) {
    Write-Host "  [WARN] $Text" -ForegroundColor Yellow
}

function Write-Err([string]$Text) {
    Write-Host "  [ERROR] $Text" -ForegroundColor Red
}

function Read-Choice {
    param(
        [string]$Prompt,
        [string[]]$Allowed,
        [string]$Default
    )
    if ($NonInteractive) { return $Default }
    for ($i = 0; $i -lt 20; $i++) {
        try { $raw = Read-Host $Prompt } catch { return $Default }
        if ([string]::IsNullOrWhiteSpace($raw)) { $raw = $Default }
        $raw = ([string]$raw).Trim()
        if ($Allowed -contains $raw) { return $raw }
        Write-Warn "无效选择: $raw（可选: $($Allowed -join '/')）"
    }
    return $Default
}

function Get-PythonInfo {
    param([string]$Exe)
    if ([string]::IsNullOrWhiteSpace($Exe)) { return $null }
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $null }
    try {
        $lines = @(& $Exe -c 'import sys; print(sys.executable); print(sys.version.split()[0])' 2>$null)
    } catch {
        return $null
    }
    if ($LASTEXITCODE -ne 0 -or $lines.Count -lt 2) { return $null }
    $versionText = ([string]$lines[$lines.Count - 1]).Trim()
    $realExe = ([string]$lines[$lines.Count - 2]).Trim()
    if ($versionText -match '^(\d+)\.(\d+)\.(\d+)$') {
        return [pscustomobject]@{
            Path    = $realExe
            Version = $versionText
            Major   = [int]$Matches[1]
            Minor   = [int]$Matches[2]
            Patch   = [int]$Matches[3]
        }
    }
    return $null
}

function Test-PythonSupported {
    param($Info)
    if ($null -eq $Info) { return $false }
    return ($Info.Major -eq 3 -and $Info.Minor -ge 10 -and $Info.Minor -le 12)
}

function Test-IsVirtualEnv {
    param([string]$Python)
    try {
        $out = @(& $Python -c 'import sys; print(1 if sys.prefix != sys.base_prefix else 0)' 2>$null)
        return ($LASTEXITCODE -eq 0 -and $out.Count -ge 1 -and ([string]$out[0]).Trim() -eq '1')
    } catch {
        return $false
    }
}

function Add-RejectedPython {
    param([string]$Message)
    $script:RejectedPython += $Message
}

function Find-Python {
    # 1) py 启动器：3.12 -> 3.11 -> 3.10
    $pyCmd = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pyCmd) {
        foreach ($ver in @('3.12', '3.11', '3.10')) {
            try {
                $candidate = @(& $pyCmd.Source "-$ver" -c 'import sys; print(sys.executable)' 2>$null)
            } catch {
                continue
            }
            if ($LASTEXITCODE -ne 0 -or $candidate.Count -lt 1) { continue }
            $info = Get-PythonInfo ([string]$candidate[$candidate.Count - 1])
            if (Test-PythonSupported $info) { return $info }
            if ($info -and $info.Minor -gt 12) {
                Add-RejectedPython "Python $($info.Version)（$($info.Path)）：暂不支持，请使用 3.10-3.12"
            }
        }
    }

    # 2) python.exe：必须排除 Windows Store 应用执行别名（*WindowsApps*）
    $seen = @{}
    $candidates = @(Get-Command python.exe -CommandType Application -All -ErrorAction SilentlyContinue)
    foreach ($cmd in $candidates) {
        $source = [string]$cmd.Source
        if ([string]::IsNullOrWhiteSpace($source)) { continue }
        if ($source -like '*WindowsApps*') {
            Write-Warn "忽略 Windows Store 应用执行别名: $source"
            continue
        }
        $key = $source.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $info = Get-PythonInfo $source
        if (Test-PythonSupported $info) { return $info }
        if ($info -and $info.Minor -gt 12) {
            Add-RejectedPython "Python $($info.Version)（$($info.Path)）：暂不支持（3.13 缺预编译 wheel），请使用 3.10-3.12"
        } elseif ($info -and $info.Minor -lt 10) {
            Add-RejectedPython "Python $($info.Version)（$($info.Path)）：版本过低，请使用 3.10-3.12"
        }
    }
    return $null
}

function Install-PythonAuto {
    $url = 'https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-amd64.exe'
    $expectedSize = 26964224
    $expectedSha256 = '67B5635E80EA51072B87941312D00EC8927C4DB9BA18938F7AD2D27B328B95FB'
    $downloadDir = Join-Path $env:TEMP 'kinship-setup'
    $installer = Join-Path $downloadDir 'python-3.12.10-amd64.exe'

    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $needDownload = $true
    if (Test-Path -LiteralPath $installer) {
        $existing = Get-Item -LiteralPath $installer
        if ($existing.Length -eq $expectedSize) { $needDownload = $false }
    }
    if ($needDownload) {
        if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }
        Write-Host '  下载 Python 3.12.10（华为云，25.7 MB）...'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $installer
        } catch {
            throw "下载失败：$url。请手动下载安装后再运行 setup.bat。"
        }
    }
    $item = Get-Item -LiteralPath $installer
    if ($item.Length -ne $expectedSize) {
        throw "安装包大小异常（$($item.Length) != $expectedSize），请重新下载：$url"
    }
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    if ($hash -ne $expectedSha256) {
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
        throw "安装包校验失败（SHA256 不匹配），请重新下载：$url"
    }

    Write-Host '  运行安装程序（per-user，无需管理员，不修改 PATH）...'
    $installArgs = @(
        '/quiet',
        'InstallAllUsers=0',
        'PrependPath=0',
        'Include_test=0',
        'Include_launcher=0',
        'Include_pip=1'
    )
    $proc = Start-Process -FilePath $installer -ArgumentList $installArgs -Wait -PassThru
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
        throw "Python 安装程序退出码 $($proc.ExitCode)，请手动安装 3.12.10 后重试"
    }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312-32\python.exe'),
        'C:\Python312\python.exe',
        'C:\Python311\python.exe',
        'C:\Python310\python.exe'
    )
    foreach ($candidate in $candidates) {
        $info = Get-PythonInfo $candidate
        if (Test-PythonSupported $info) { return $info }
    }
    $programsDir = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path -LiteralPath $programsDir) {
        $found = Get-ChildItem -LiteralPath $programsDir -Filter python.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $info = Get-PythonInfo $found.FullName
            if (Test-PythonSupported $info) { return $info }
        }
    }
    $detected = Find-Python
    if (Test-PythonSupported $detected) { return $detected }
    throw "安装完成但未找到 python.exe，请手动安装 Python 3.12.10 后重试"
}

function Show-PythonManual {
    Write-Host '  请手动安装 Python 3.10-3.12（推荐 3.12.10）：'
    Write-Host '    华为云: https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-amd64.exe'
    Write-Host '    官网:   https://www.python.org/downloads/windows/'
    Write-Host '  安装时勾选 “Add python.exe to PATH”，或安装后把 python.exe 路径传给 -PythonExe。'
}

function Resolve-PipIndexUrl {
    param([string]$Value)
    $key = $Value.Trim().ToLowerInvariant()
    switch ($key) {
        'aliyun' { return 'https://mirrors.aliyun.com/pypi/simple/' }
        'tsinghua' { return 'https://pypi.tuna.tsinghua.edu.cn/simple' }
        'official' { return 'https://pypi.org/simple' }
        default {
            if ($key -match '^https?://') { return $Value.Trim() }
            throw "未知 pip 源: $Value（可用: aliyun/tsinghua/official 或 https URL）"
        }
    }
}

function Ensure-Venv {
    param($BaseInfo)
    $venvDir = Join-Path $script:RepoRoot '.venv'
    $venvPython = Join-Path $venvDir 'Scripts\python.exe'
    $reused = $false

    if (Test-Path -LiteralPath $venvDir) {
        $reuseOk = $false
        if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
            $info = Get-PythonInfo $venvPython
            if (Test-PythonSupported $info) {
                & $venvPython -c 'import fastapi' 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $reuseOk = $true
                    $reused = $true
                    Write-Ok "复用现有 .venv（Python $($info.Version)）"
                    return (Get-PythonInfo $venvPython)
                }
                Write-Warn '现有 .venv 缺少 fastapi，将重建'
            } else {
                $shown = if ($info) { $info.Version } else { '未知' }
                Write-Warn "现有 .venv 的 Python 版本不合格（$shown），将重建"
            }
        } else {
            Write-Warn '现有 .venv 不完整（缺少 Scripts\python.exe），将重建'
        }

        if (-not $reuseOk) {
            $choice = '1'
            if (-not $NonInteractive) {
                Write-Host '  [1] 重建 .venv（推荐）'
                Write-Host '  [2] 退出'
                $choice = Read-Choice -Prompt '选择' -Allowed @('1', '2') -Default '1'
            }
            if ($choice -ne '1') { throw '用户取消：保留现有 .venv' }
            $backup = "$venvDir.broken-" + (Get-Date -Format 'yyyyMMddHHmmss')
            Move-Item -LiteralPath $venvDir -Destination $backup -Force
            Write-Warn "旧 .venv 已改名保留: $backup"
        }
    }

    Write-Step '创建虚拟环境 .venv'
    & $BaseInfo.Path -m venv $venvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        throw '创建 .venv 失败（python -m venv 退出码非 0 或缺少 python.exe）'
    }
    $created = Get-PythonInfo $venvPython
    if (-not (Test-PythonSupported $created)) {
        throw "新建 .venv 的 Python 版本不合格: $($created.Version)"
    }
    Write-Ok ".venv 已创建（Python $($created.Version)）"
    return $created
}

function Invoke-PipInstall {
    param([string]$Python, [string]$IndexUrl)
    Write-Step "安装项目依赖（pip 源: $IndexUrl）"
    $pipArgs = @(
        '-m', 'pip', 'install',
        '--disable-pip-version-check',
        '--no-input',
        '--prefer-binary',
        '--timeout', '60',
        '--retries', '3',
        '--progress-bar', 'off',
        '--index-url', $IndexUrl,
        '-e', '.'
    )
    Push-Location -LiteralPath $script:RepoRoot
    try {
        & $Python @pipArgs
        $rc = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($rc -ne 0) { throw "pip install -e . 失败（exit=$rc）" }
    Write-Ok 'pip install -e . 完成'
}

function Invoke-FfmpegBootstrap {
    param([string]$Python)
    Write-Step '落地 ffmpeg（imageio-ffmpeg wheel）'
    $backendDir = Join-Path $script:RepoRoot 'backend'
    $code = "import sys; sys.path.insert(0, sys.argv[1]); from services.ffmpeg_bootstrap import ensure_ffmpeg; print('FFMPEG=' + str(ensure_ffmpeg()))"
    & $Python -c $code $backendDir
    if ($LASTEXITCODE -ne 0) {
        Write-Warn 'ffmpeg 落地失败；音频转码会降级，请检查 imageio-ffmpeg 安装'
        return $false
    }
    Write-Ok 'ffmpeg 已就绪（backend\bin\ffmpeg.exe）'
    return $true
}

function Invoke-KernelBootstrap {
    param([string]$Python, [string]$Mode, [string]$IndexUrl)
    if ($Mode -eq 'skip') {
        Write-Warn '已跳过内核构建/内核 venv（-KernelMode skip）'
        return $false
    }
    $kernelPyproject = Join-Path $script:RepoRoot 'kernel\pyproject.toml'
    if (-not (Test-Path -LiteralPath $kernelPyproject -PathType Leaf)) {
        Write-Step '内核运行时（无源码发行包）'
        Write-Warn '未找到 kernel\pyproject.toml：跳过本地构建与内核 bootstrap。'
        Write-Warn '安装向导的“内核”步骤会下载预编译内核，并自动创建 .venv-kernel（自动检测 GPU；CPU 约 1.1GB / CUDA 约 6.3GB，需要数分钟）。'
        Write-Warn '请先设置 KERNEL_MANIFEST_URL 环境变量，或在 config.yaml 配置 onboarding.release_manifest_url。'
        return $false
    }
    $backendDir = Join-Path $script:RepoRoot 'backend'
    Write-Step "内核本地构建/venv（模式: $Mode）"
    $previousIndex = $env:PIP_INDEX_URL
    $env:PIP_INDEX_URL = $IndexUrl
    try {
        if ($Mode -eq 'build') {
            $code = "import json, sys; sys.path.insert(0, sys.argv[1]); from services.kernel_bootstrap import build_kernel; print('KERNEL_BUILD=' + json.dumps(build_kernel(sys.argv[2]), ensure_ascii=False))"
            & $Python -c $code $backendDir $script:RepoRoot
            $rc = $LASTEXITCODE
            if ($rc -ne 0) {
                Write-Warn "内核构建失败（exit=$rc），后端仍可启动，音频内核不可用"
                return $false
            }
            Write-Ok '内核构建完成（kernel\dist\axeuh-kernel）'
            return $true
        }

        $code = @'
import json
import sys

sys.path.insert(0, sys.argv[1])
from services.kernel_bootstrap import bootstrap_kernel

result = bootstrap_kernel(sys.argv[2])
print('KERNEL_RESULT=' + json.dumps(result, ensure_ascii=False))
raise SystemExit(0 if result.get('ok') else 2)
'@
        & $Python -c $code $backendDir $script:RepoRoot
        $rc = $LASTEXITCODE
        if ($rc -ne 0) {
            Write-Warn "内核 bootstrap 未完成（exit=$rc）；后端仍可启动，音频内核不可用"
            return $false
        }
        Write-Ok '内核构建 + .venv-kernel + 依赖安装完成'
        return $true
    } finally {
        if ($null -eq $previousIndex) {
            Remove-Item Env:PIP_INDEX_URL -ErrorAction SilentlyContinue
        } else {
            $env:PIP_INDEX_URL = $previousIndex
        }
    }
}

function Ensure-Frontend {
    $index = Join-Path $script:RepoRoot 'frontend\mobile\dist\index.html'
    if (Test-Path -LiteralPath $index -PathType Leaf) {
        Write-Ok '前端产物存在（frontend\mobile\dist\index.html）'
        return $true
    }
    Write-Warn '缺少前端产物: frontend\mobile\dist\index.html'
    Write-Host '  请下载任务 26 的发行资产 axeuh-mobile-dist-<版本>.tar.gz，解压后把 dist 目录放到 frontend\mobile\dist。'
    if ($NonInteractive) {
        Write-Warn '非交互模式：继续启动后端（浏览器打开后页面可能 404）'
        return $false
    }
    while ($true) {
        Write-Host '  [1] 已放置，重新检查'
        Write-Host '  [2] 继续（仅后端）'
        Write-Host '  [3] 退出'
        $choice = Read-Choice -Prompt '选择' -Allowed @('1', '2', '3') -Default '2'
        if ($choice -eq '1') {
            if (Test-Path -LiteralPath $index -PathType Leaf) { return $true }
            Write-Warn '仍未找到 index.html'
            continue
        }
        if ($choice -eq '2') { return $false }
        throw '用户取消：缺少前端产物'
    }
}

function Test-Health {
    param([int]$HealthPort, [int]$TimeoutSec = 3)
    $urls = @("http://127.0.0.1:$HealthPort/health", "https://127.0.0.1:$HealthPort/health")
    foreach ($url in $urls) {
        $isHttps = $url.StartsWith('https')
        $oldCallback = $null
        if ($isHttps) {
            $oldCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        }
        try {
            $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec $TimeoutSec
            if ([int]$resp.StatusCode -eq 200) {
                $service = ''
                try { $service = [string](ConvertFrom-Json ([string]$resp.Content)).service } catch { }
                return [pscustomobject]@{ Ok = $true; Url = $url; Service = $service; Body = [string]$resp.Content }
            }
        } catch {
            # 尝试下一个协议
        } finally {
            if ($isHttps) {
                [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $oldCallback
            }
        }
    }
    return [pscustomobject]@{ Ok = $false; Url = ''; Service = ''; Body = '' }
}

function Get-PortOwner {
    param([int]$LocalPort)
    $ownerPid = 0
    try {
        $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { $ownerPid = [int]$conn.OwningProcess }
    } catch {
        $netstatLines = @(netstat -ano | Select-String -Pattern ":$LocalPort\s+\S+\s+LISTENING\s+(\d+)")
        foreach ($line in $netstatLines) {
            if ($line.Line -match ":$LocalPort\s+\S+\s+LISTENING\s+(\d+)") {
                $ownerPid = [int]$Matches[1]
                break
            }
        }
    }
    if ($ownerPid -le 0) { return $null }
    $name = 'unknown'
    $exePath = ''
    try {
        $proc = Get-Process -Id $ownerPid -ErrorAction Stop
        $name = $proc.ProcessName
        try { $exePath = [string]$proc.Path } catch { }
    } catch { }
    $display = if ($exePath) { $exePath } else { $name }
    return [pscustomobject]@{ Pid = $ownerPid; Name = $name; Path = $exePath; Display = $display }
}

function Start-KinshipServer {
    param([string]$Python, [int]$HealthPort, [int]$TimeoutSeconds)
    $backendDir = Join-Path $script:RepoRoot 'backend'
    $logDir = Join-Path $backendDir 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $outLog = Join-Path $logDir 'setup-server.out.log'
    $errLog = Join-Path $logDir 'setup-server.err.log'

    Write-Step "启动后端: python -m core.hot_server（cwd=backend）"
    $proc = Start-Process -FilePath $Python -ArgumentList @('-m', 'core.hot_server') `
        -WorkingDirectory $backendDir -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Write-Host "  后端 PID: $($proc.Id)"
    Write-Host "  日志: $outLog"

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if ($proc.HasExited) {
            Write-Err "后端进程已退出（exit=$($proc.ExitCode)）"
            if (Test-Path -LiteralPath $errLog) {
                Get-Content -LiteralPath $errLog -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
            }
            return $null
        }
        $health = Test-Health -HealthPort $HealthPort -TimeoutSec 3
        if ($health.Ok) {
            Write-Ok "健康检查 200: $($health.Url)"
            return $proc
        }
        Write-Host '  等待 /health ...'
    }
    Write-Err "健康检查超时（$TimeoutSeconds 秒）"
    if (Test-Path -LiteralPath $errLog) {
        Get-Content -LiteralPath $errLog -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    }
    return $null
}

function Show-Banner {
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host '  Kinship Windows 引导脚本' -ForegroundColor Cyan
    Write-Host '  无需管理员 / 不改 PATH / 不全局安装 / 不结束进程' -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host "  项目目录: $($script:RepoRoot)"
    Write-Host "  安装目录: $($script:RepoRoot)"
}

# ── 主流程 ────────────────────────────────────────────────────────────────

try {
    Show-Banner
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'backend\core\hot_server.py') -PathType Leaf)) {
        throw "项目目录不完整，缺少 backend\core\hot_server.py：$($script:RepoRoot)"
    }

    try {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Warn '当前以管理员身份运行；本脚本不需要管理员权限，建议普通用户运行。'
        }
    } catch { }

    # (1) 探测 Python
    Write-Step '检测 Python（3.10-3.12，排除 Windows Store 别名）'
    $baseInfo = $null
    if ($PythonExe) {
        if ($PythonExe -like '*WindowsApps*') {
            throw "指定的是 Windows Store 应用执行别名，不是真实 Python：$PythonExe"
        }
        $baseInfo = Get-PythonInfo $PythonExe
        if (-not $baseInfo) { throw "指定的 Python 不可用: $PythonExe" }
        if (-not (Test-PythonSupported $baseInfo)) {
            throw "指定的 Python 版本不受支持: $($baseInfo.Version)（需要 3.10-3.12；3.13 缺预编译 wheel）"
        }
    } else {
        $baseInfo = Find-Python
    }

    if (-not $baseInfo) {
        foreach ($reason in $script:RejectedPython) { Write-Warn $reason }
        Write-Host ''
        Write-Host '未检测到可用的 Python（3.10-3.12）。'
        Write-Host '  [1] 自动下载安装 Python 3.12.10（华为云，25.7 MB，per-user 免管理员）'
        Write-Host '  [2] 手动安装'
        Write-Host '  [3] 退出'
        $sourceChoice = '3'
        if ($PythonSource -eq 'auto') {
            $sourceChoice = '1'
        } elseif ($PythonSource -eq 'manual') {
            $sourceChoice = '2'
        } elseif ($NonInteractive) {
            throw '未检测到 Python；非交互模式请使用 -PythonSource auto 或 -PythonExe <path>'
        } else {
            $sourceChoice = Read-Choice -Prompt '选择' -Allowed @('1', '2', '3') -Default '3'
        }
        if ($sourceChoice -eq '1') {
            $baseInfo = Install-PythonAuto
        } elseif ($sourceChoice -eq '2') {
            Show-PythonManual
            throw '已选择手动安装，请安装后重新运行 setup.bat'
        } else {
            throw '用户选择退出'
        }
    }
    Write-Ok "使用 Python $($baseInfo.Version): $($baseInfo.Path)"

    # (2) 运行模式
    $mode = $PythonMode
    if (-not $NonInteractive -and -not $script:PythonModeBound) {
        Write-Host ''
        Write-Host '  [1] 创建 .venv（推荐，隔离依赖）'
        Write-Host '  [2] 使用现有 Python（须为 venv/conda 环境；基础解释器会被拒绝）'
        Write-Host '  [3] 退出'
        $modeChoice = Read-Choice -Prompt '选择' -Allowed @('1', '2', '3') -Default '1'
        if ($modeChoice -eq '2') { $mode = 'existing' }
        if ($modeChoice -eq '3') { throw '用户选择退出' }
    }

    # (3) pip 源
    $pipChoice = $PipIndex
    if (-not $NonInteractive -and -not $script:PipIndexBound) {
        Write-Host ''
        Write-Host '  [1] 阿里云（默认，推荐国内）'
        Write-Host '  [2] 清华'
        Write-Host '  [3] 官方 PyPI'
        $indexChoice = Read-Choice -Prompt '选择' -Allowed @('1', '2', '3') -Default '1'
        if ($indexChoice -eq '2') { $pipChoice = 'tsinghua' }
        elseif ($indexChoice -eq '3') { $pipChoice = 'official' }
        else { $pipChoice = 'aliyun' }
    }
    $indexUrl = Resolve-PipIndexUrl $pipChoice
    Write-Ok "pip 源: $indexUrl"

    $runPython = $baseInfo
    if ($mode -eq 'venv') {
        $runPython = Ensure-Venv $baseInfo
    } else {
        if (-not (Test-IsVirtualEnv $baseInfo.Path)) {
            throw "所选 Python 不是虚拟环境（sys.prefix == sys.base_prefix）: $($baseInfo.Path)。为避免全局安装，请改用 .venv（选项 1），或指定已有 venv/conda 环境里的 python.exe。"
        }
        Write-Ok "使用现有虚拟环境（不创建 .venv，不全局安装）: $($baseInfo.Path)"
    }
    if (-not (Test-Path -LiteralPath $runPython.Path -PathType Leaf)) {
        throw "运行用 Python 不存在: $($runPython.Path)"
    }

    # (4) 依赖 + bootstrap
    Invoke-PipInstall -Python $runPython.Path -IndexUrl $indexUrl
    Invoke-FfmpegBootstrap -Python $runPython.Path | Out-Null
    $kernelMode = if ($SkipKernel) { 'skip' } else { $KernelMode }
    Invoke-KernelBootstrap -Python $runPython.Path -Mode $kernelMode -IndexUrl $indexUrl | Out-Null

    # (5) 前端产物
    Ensure-Frontend | Out-Null

    # (6) 启动后端并等待 /health
    Write-Step "检查端口 $Port"
    $existing = Test-Health -HealthPort $Port -TimeoutSec 3
    if ($existing.Ok -and $existing.Service -eq 'kinship-health-monitor' -and -not $NoReuseRunning) {
        $owner = Get-PortOwner -LocalPort $Port
        $ownerText = if ($owner) { "PID $($owner.Pid) ($($owner.Display))" } else { '已有实例' }
        Write-Ok "Kinship 后端已在运行（$ownerText），跳过启动"
        if (-not $NoBrowser) {
            try { Start-Process "http://127.0.0.1:$Port" | Out-Null } catch { Write-Warn "无法自动打开浏览器: $_" }
        }
        Write-Host ''
        Write-Ok "完成：http://127.0.0.1:$Port/health 返回 200"
        exit 0
    }

    $owner = Get-PortOwner -LocalPort $Port
    if ($owner) {
        Write-Err "端口 $Port 被 PID $($owner.Pid) ($($owner.Display)) 占用，请关闭或改用 --port"
        exit 3
    }

    $serverProc = Start-KinshipServer -Python $runPython.Path -HealthPort $Port -TimeoutSeconds $HealthTimeoutSeconds
    if (-not $serverProc) { throw '后端启动失败或健康检查未通过' }

    if (-not $NoBrowser) {
        try {
            Start-Process "http://127.0.0.1:$Port" | Out-Null
        } catch {
            Write-Warn "无法自动打开浏览器，请手动访问 http://127.0.0.1:$Port"
        }
    }

    Write-Host ''
    Write-Host '============================================' -ForegroundColor Green
    Write-Host '  Kinship 已启动' -ForegroundColor Green
    Write-Host "  地址: http://127.0.0.1:$Port" -ForegroundColor Green
    Write-Host "  后端 PID: $($serverProc.Id)" -ForegroundColor Green
    Write-Host '============================================' -ForegroundColor Green
    exit 0
} catch {
    Write-Err $_.Exception.Message
    exit 1
}
