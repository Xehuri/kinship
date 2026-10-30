"""
Kinship - Launcher（已退役，仅作回滚路径保留）

systemd 现在直接运行 ``python -m core.hot_server``（见 deploy/axeuh-health.service）。
本文件不再被生产 unit 调用，也不再管理 OpenCode；只保留后端进程监督逻辑，
以便把 ExecStart 改回 launcher.py 时仍能拉起后端。

回滚命令（迁移窗口内由用户执行，本仓库不自动执行）：
    sudo sed -i 's|^ExecStart=.*|ExecStart=/opt/kinship/.venv-health/bin/python launcher.py|' /etc/systemd/system/axeuh-health.service
    sudo systemctl daemon-reload
    sudo systemctl restart axeuh-health

若需恢复已删除的 OpenCode 管理，先从任务 25 之前的提交取回本文件：
    git checkout 4945af5a -- launcher.py
"""

import argparse
import os
import signal
import ssl
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'backend'))

from config.paths import backend_dir as _backend_dir


def parse_args():
    parser = argparse.ArgumentParser(
        description='Kinship Launcher (retired; backend-only rollback path)'
    )
    parser.add_argument('--config', help='自定义配置文件路径')
    parser.add_argument('--data-dir', help='自定义数据目录')
    return parser.parse_args()


def log(service, message):
    print(f'[{service}] {message}')


class ServiceManager:
    """后端监督器（回滚路径；生产入口已切换为 core.hot_server）。"""

    def __init__(self):
        self.backend_proc = None
        self.running = True
        self.backend_dir = _backend_dir()

        args = parse_args()
        # --data-dir 经 env 覆盖层传给配置加载器与后端子进程；不再改 cfg._data
        # （N04 起 _data 只读，且 launcher 进程内改动不会继承给子进程）。
        self.data_dir = str(args.data_dir) if args.data_dir else None
        if self.data_dir:
            os.environ['AXEUH_SETTINGS__DATA__DIR'] = self.data_dir
        from config.config import get_config, set_config_path
        if args.config:
            set_config_path(args.config)
        # 记录解析后的配置文件绝对路径，供启动后端子进程时通过 CONFIG_PATH 环境变量传递。
        # set_config_path 只改本进程的模块全局变量，子进程不会继承；转为绝对路径可避免
        # 子进程 cwd=backend 时相对路径解析基准不一致。None 表示未指定 --config，保持默认行为。
        self.config_path = os.path.abspath(args.config) if args.config else None
        cfg = get_config()

        self.python_path = cfg.CONDAPYTHON_PATH
        self.backend_host = cfg.BACKEND_HOST
        self.backend_port = cfg.BACKEND_PORT
        self.ssl_enabled = cfg.SSL_ENABLED
        self.ssl_cert = cfg.SSL_CERT
        self.ssl_key = cfg.SSL_KEY

    # ── 后端管理 ─────────────────────────────────────

    def _refresh_backend_snapshot(self):
        """重读后端监听参数；配置不可读时回退默认值。

        热更新后端口/SSL 可能已变化，__init__ 时的快照不再可信。
        读取失败只降级日志与健康检查，不阻塞 launcher 主循环；
        HotServer 进程内部有同样的回退逻辑。
        """
        try:
            from config.config import get_config
            cfg = get_config()
            host = str(getattr(cfg, 'BACKEND_HOST', '') or '0.0.0.0')
            ssl_enabled = bool(getattr(cfg, 'SSL_ENABLED', False))
            cert = str(getattr(cfg, 'SSL_CERT', '') or '')
            key = str(getattr(cfg, 'SSL_KEY', '') or '')
            tls_ready = ssl_enabled and os.path.exists(cert) and os.path.exists(key)
            port_attr = 'BACKEND_HTTPS_PORT' if tls_ready else 'BACKEND_HTTP_PORT'
            port = int(getattr(cfg, port_attr, 8768) or 8768)
            self.backend_host = host
            self.backend_port = port
            self.ssl_enabled = tls_ready
            self.ssl_cert = cert
            self.ssl_key = key
        except Exception as e:
            log('BACKEND', f'配置读取失败，监听参数回退 0.0.0.0:8768/HTTP: {e}')
            self.backend_host = '0.0.0.0'
            self.backend_port = 8768
            self.ssl_enabled = False
            self.ssl_cert = ''
            self.ssl_key = ''

    def start_backend(self):
        """启动后端 HotServer 进程（lifespan 单次，支持进程内 rebind/TLS 轮换）"""
        self._refresh_backend_snapshot()
        python = self.python_path if os.path.exists(self.python_path) else sys.executable
        cmd = [python, '-m', 'core.hot_server']

        if self.ssl_enabled:
            log('BACKEND', 'HTTPS mode (SSL enabled)')
        else:
            log('BACKEND', 'HTTP mode (no SSL)')

        log('BACKEND', f'Starting on {self.backend_host}:{self.backend_port}...')
        # 将 launcher 解析的配置路径通过 CONFIG_PATH 传给后端子进程：后端 config.py
        # 在导入时读取该环境变量，否则子进程会回退到默认配置路径，使 --config 失效。
        # 未指定 --config 时不设置该变量，子进程沿用默认路径（启动行为不变）。
        env = os.environ.copy()
        if self.config_path:
            env['CONFIG_PATH'] = self.config_path
        if self.data_dir:
            env['AXEUH_SETTINGS__DATA__DIR'] = self.data_dir
        self.backend_proc = subprocess.Popen(cmd, cwd=str(self.backend_dir), env=env)
        log('BACKEND', f'Started (PID: {self.backend_proc.pid})')

    def health_url(self) -> str:
        """健康检查 URL：未启用 TLS 时必须走 BACKEND_HTTP_PORT。"""
        self._refresh_backend_snapshot()
        protocol = 'https' if self.ssl_enabled else 'http'
        return f'{protocol}://127.0.0.1:{self.backend_port}/health'

    def wait_health(self):
        """等待后端健康检查通过（协议/端口取刷新后的快照）"""
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        url = self.health_url()
        for i in range(10):
            try:
                with urllib.request.urlopen(url, timeout=2, context=ctx):
                    log('BACKEND', 'Health check passed')
                    return
            except Exception:
                time.sleep(0.5)
        log('BACKEND', 'Health check failed')

    def stop_backend(self):
        """优雅停止后端进程"""
        if self.backend_proc and self.backend_proc.poll() is None:
            log('SYSTEM', 'Stopping backend...')
            self.backend_proc.terminate()
            try:
                self.backend_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.backend_proc.kill()
            log('SYSTEM', 'Backend stopped')

    def run(self):
        """主循环：启动后端 → 监控自动重启（OpenCode 已退役）"""
        log('SYSTEM', 'Kinship Launcher (retired; backend-only rollback path)')

        def handle_signal(signum, frame):
            self.running = False

        signal.signal(signal.SIGINT, handle_signal)
        signal.signal(signal.SIGTERM, handle_signal)

        # 1. 启动后端
        self.start_backend()
        self.wait_health()

        # 2. 监控循环
        while self.running:
            if self.backend_proc and self.backend_proc.poll() is not None:
                self._refresh_backend_snapshot()
                log('BACKEND',
                    f'Process exited (code: {self.backend_proc.returncode}), '
                    f'restarting on {self.backend_host}:{self.backend_port} in 2s...')
                time.sleep(2)
                self.start_backend()
                self.wait_health()

            time.sleep(1)

        # 3. 停止
        self.stop_backend()


if __name__ == '__main__':
    ServiceManager().run()
