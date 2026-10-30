"""
统一配置模块 - 所有服务从此文件读取配置

``Config`` 是 ``ConfigStore`` 的稳定 live facade：同一 facade 对象在
``ConfigStore`` 热更新后立即读到新快照。启动不再要求配置文件存在或完整，
缺失/损坏只进入 degraded 状态，缺省值由 store 的 schema 默认值兜底。

兼容入口：``CONFIG_PATH`` / ``set_config_path`` 仍可指定配置文件位置，
``_load_yaml`` 返回当前 base 文档（不含默认值），``_resolve_base`` 恒为仓库根。
"""
import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from .config_schema import mask_document
from .providers import ProviderInfo
from .store import get_config_store, reset_config_store


_CONFIG_PATH: Optional[str] = os.environ.get('CONFIG_PATH')  # launcher.py --config 也走这里
if _CONFIG_PATH and not os.environ.get('AXEUH_CONFIG_PATH'):
    # 兼容旧变量：ConfigStore 只认 AEUH_CONFIG_PATH，旧部署仅设置 CONFIG_PATH。
    os.environ['AXEUH_CONFIG_PATH'] = _CONFIG_PATH


def set_config_path(path: str | None) -> None:
    """设置自定义配置文件路径（launcher.py 传入）。

    同步 AEUH_CONFIG_PATH 并重建进程级 ConfigStore；路径不存在只让新 store
    进入 degraded，不在此抛异常。
    """
    global _CONFIG_PATH
    _CONFIG_PATH = path
    if path:
        os.environ['AXEUH_CONFIG_PATH'] = str(path)
    else:
        os.environ.pop('AXEUH_CONFIG_PATH', None)
    reset_config_store()


def _resolve_base() -> Path:
    """返回项目根目录；配置载体位置不参与相对路径解析。"""
    from config.paths import project_root

    return project_root()


def _load_yaml() -> dict[str, Any]:
    """返回 ConfigStore 当前 base 文档（不含 schema 默认值）；缺失/损坏返回 {}。"""
    try:
        return get_config_store().base_document()
    except Exception:
        return {}


def _to_int(value: Any) -> Optional[int]:
    """int / 数字字符串归一为 int；其余（含 bool）返回 None。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _parse_cpu_affinity(raw: Any) -> list[int]:
    """解析 kernel.cpu_affinity：list[int] 或 "2-4"/"2,3,4"。

    负数与非法值被过滤，结果去重升序；空/无法解析 = 不限制。
    """
    if isinstance(raw, str):
        tokens: list[Any] = [t.strip() for t in raw.split(',') if t.strip()]
    elif isinstance(raw, (list, tuple)):
        tokens = list(raw)
    else:
        return []
    cpus: set[int] = set()
    for token in tokens:
        if isinstance(token, str) and '-' in token:
            start_s, _, end_s = token.partition('-')
            start, end = _to_int(start_s), _to_int(end_s)
            if start is not None and end is not None and start <= end:
                cpus.update(range(start, end + 1))
            continue
        value = _to_int(token)
        if value is not None:
            cpus.add(value)
    return sorted(cpu for cpu in cpus if cpu >= 0)


def _parse_nice(raw: Any) -> Optional[int]:
    """解析 kernel.nice：int / 数字字符串，夹取 [-20, 19]；非法 = None。"""
    value = _to_int(raw)
    if value is None:
        return None
    return max(-20, min(19, value))


_LOOM_TOKEN_FILE_CACHE: dict[tuple[str, int, int], str] = {}
_LOOM_TOKEN_FILE_CACHE_LOCK = threading.Lock()
_LOOM_TOKEN_FILE_CACHE_LIMIT = 32


def _parse_env_file_value(text: str, key: str) -> str:
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate or candidate.startswith("#"):
            continue
        if candidate.startswith("export "):
            candidate = candidate[len("export "):].lstrip()
        name, separator, value = candidate.partition("=")
        if not separator or name.strip() != key:
            continue
        return value.strip().strip("'\"")
    return ""


def _read_loom_token_file(path: str) -> str:
    try:
        stat = os.stat(path)
    except OSError:
        return ""
    cache_key = (path, stat.st_mtime_ns, stat.st_size)
    with _LOOM_TOKEN_FILE_CACHE_LOCK:
        cached = _LOOM_TOKEN_FILE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    value = _parse_env_file_value(text, "LOOM_TOKEN")
    with _LOOM_TOKEN_FILE_CACHE_LOCK:
        if len(_LOOM_TOKEN_FILE_CACHE) >= _LOOM_TOKEN_FILE_CACHE_LIMIT:
            _LOOM_TOKEN_FILE_CACHE.clear()
        _LOOM_TOKEN_FILE_CACHE[cache_key] = value
    return value


class Config:
    """配置访问门面：live 模式读 ConfigStore 快照，静态模式读注入文档。"""

    # OpenCode 请求体必填字段：缺失时只进入 degraded 状态并暴露缺失键。
    _OPENCODE_REQUIRED_KEYS: tuple[str, ...] = ('default_model', 'default_provider', 'default_agent')

    def __init__(self, data: dict[str, Any] | None = None) -> None:
        self._static_data: dict[str, Any] | None = data

    @property
    def _data(self) -> dict[str, Any]:
        """当前配置快照。

        live 模式返回 ConfigStore 的当前快照引用：生产代码必须只读；
        测试沿用历史习惯可直接改它，改动只影响当前快照。
        """
        if self._static_data is not None:
            return self._static_data
        return get_config_store().snapshot()

    def _section(self, name: str) -> dict[str, Any]:
        value = self._data.get(name)
        return value if isinstance(value, dict) else {}

    @property
    def MISSING_OPENCODE_KEYS(self) -> list[str]:
        opencode = self._section('opencode')
        return [
            key
            for key in self._OPENCODE_REQUIRED_KEYS
            if not str(opencode.get(key) or '').strip()
        ]

    @property
    def DEGRADED(self) -> bool:
        if self._static_data is not None:
            return bool(self.MISSING_OPENCODE_KEYS)
        return get_config_store().is_degraded()

    @property
    def DEGRADED_REASONS(self) -> list[str]:
        if self._static_data is not None:
            return [
                f"opencode.{key} 未配置"
                for key in self.MISSING_OPENCODE_KEYS
            ]
        return get_config_store().degraded

    @property
    def CONFIG_WARNINGS(self) -> list[dict[str, Any]]:
        if self._static_data is not None:
            return []
        return [
            {
                'path': warning.path,
                'code': warning.code,
                'message': warning.message,
                'severity': warning.severity,
            }
            for warning in get_config_store().warnings
        ]

    @property
    def UNCONFIGURED(self) -> bool:
        """兼容旧名：等同 DEGRADED。"""
        return self.DEGRADED

    def is_degraded(self) -> bool:
        return self.DEGRADED

    def provider_info(self) -> ProviderInfo:
        if self._static_data is not None:
            return ProviderInfo(
                kind='static',
                location='',
                writable=False,
                detail='static test document',
            )
        return get_config_store().provider_info()

    def provider_info_dict(self) -> dict[str, Any]:
        info = self.provider_info()
        return {
            'kind': info.kind,
            'location': info.location,
            'writable': info.writable,
            'detail': info.detail,
        }

    def current_config_path(self) -> str:
        return self.provider_info().location

    def config_path(self) -> str:
        return self.current_config_path()

    def revision(self) -> str:
        if self._static_data is not None:
            return 'static'
        return get_config_store().revision

    def masked_config(self) -> dict[str, Any]:
        if self._static_data is not None:
            return mask_document(self._static_data)
        return get_config_store().masked_config()

    @property
    def CONFIG_STATUS(self) -> dict[str, Any]:
        provider = self.provider_info_dict()
        if self._static_data is not None:
            return {
                'revision': 'static',
                'provider': provider,
                'degraded': self.DEGRADED,
                'warnings': [],
                'apply_failures': {},
                'config_path': provider['location'],
            }
        store = get_config_store()
        return {
            'revision': store.revision,
            'provider': provider,
            'degraded': store.is_degraded(),
            'warnings': self.CONFIG_WARNINGS,
            'apply_failures': store.apply_failures,
            'config_path': provider['location'],
        }

    # ── 服务端口 ─────────────────────────────────────

    @property
    def BACKEND_HOST(self) -> str:
        return self._section('server').get('host', '0.0.0.0')

    @property
    def BACKEND_PORT(self) -> int:
        value = _to_int(self._section('server').get('port', 8768))
        return 8768 if value is None else value

    @property
    def BACKEND_HTTPS_PORT(self) -> int:
        """只读兼容别名：单端口后与 BACKEND_PORT 恒等。"""
        return self.BACKEND_PORT

    @property
    def BACKEND_HTTP_PORT(self) -> int:
        """只读兼容别名：单端口后与 BACKEND_PORT 恒等。"""
        return self.BACKEND_PORT

    # ── OpenCode ─────────────────────────────────────

    @property
    def OPENCODE_ENABLED(self) -> bool:
        return bool(self._section('opencode').get('enabled', True))

    @property
    def OPENCODE_URL(self) -> str:
        return self._section('opencode').get('url', 'http://127.0.0.1:4096')

    @property
    def OPENCODE_DIRECTORY(self) -> str:
        """OpenCode 实例目录（发送到 x-opencode-directory 头）。

        空 = ``data.ai_root``：OpenCode 属于 AI 工作区；显式值优先，相对路径
        按项目根解析。
        """
        raw = str(self._section('opencode').get('directory') or '').strip()
        if not raw:
            return self.AI_ROOT
        if os.path.isabs(raw):
            return raw
        return str(_resolve_base() / raw)

    @property
    def OPENCODE_PORT(self) -> int:
        url = self.OPENCODE_URL
        if ':' in url:
            try:
                return int(url.split(':')[-1].rstrip('/'))
            except (ValueError, IndexError):
                pass
        return 4096

    @property
    def OPENCODE_HOST(self) -> str:
        return 'localhost'

    @property
    def OPENCODE_DEFAULT_MODEL(self) -> str:
        """OpenCode 请求体的 modelID（缺失为空串，见 MISSING_OPENCODE_KEYS）"""
        return str(self._section('opencode').get('default_model') or '')

    @property
    def OPENCODE_DEFAULT_PROVIDER(self) -> str:
        """OpenCode 请求体的 providerID（缺失为空串，见 MISSING_OPENCODE_KEYS）"""
        return str(self._section('opencode').get('default_provider') or '')

    @property
    def OPENCODE_DEFAULT_AGENT(self) -> str:
        """OpenCode 请求体的 agent 字段（缺失为空串，见 MISSING_OPENCODE_KEYS）"""
        return str(self._section('opencode').get('default_agent') or '')

    @property
    def MODEL_CONFIG_PATH(self) -> str:
        """model_config.json 单一真源路径（V5 双缓存收敛）。

        router 写与 client 读共用此 KEY，杜绝"写到哪读到哪"漂移。
        默认 = client 原探测顺序的第一优先位 opencode.directory/config/model_config.json；
        可用 config.yaml opencode.model_config_path 覆盖（绝对路径直用，相对路径按项目根解析）。
        """
        raw = self._section('opencode').get('model_config_path', '')
        if raw:
            if os.path.isabs(raw):
                return raw
            return str(_resolve_base() / raw)
        return str(Path(self.OPENCODE_DIRECTORY) / 'config' / 'model_config.json')

    @property
    def OPENCODE_SERVER_PASSWORD(self) -> str:
        """OpenCode loopback HTTP Basic 认证密码（空串 = 不启用，fail-open 维持现状）。

        优先级: config.yaml opencode.server_password > 环境变量 OPENCODE_SERVER_PASSWORD > 空。
        配置后: launcher.py 启动 opencode serve 时注入 OPENCODE_SERVER_PASSWORD 环境变量，
        同时 opencode_client 对每个请求带 Authorization: Basic 头（双向同源配置）。
        未配置时两端都不带认证——老部署零改动照常工作（向后兼容）。
        """
        password = self._section('opencode').get('server_password') or ''
        if password:
            return str(password)
        return os.environ.get('OPENCODE_SERVER_PASSWORD') or ''

    @property
    def OPENCODE_SERVER_USERNAME(self) -> str:
        """OpenCode HTTP Basic 认证用户名（默认 opencode，与上游 OPENCODE_SERVER_USERNAME 默认一致）。

        优先级: config.yaml opencode.server_username > 环境变量 OPENCODE_SERVER_USERNAME > 'opencode'。
        schema 默认值 'opencode' 不算显式配置，否则会遮蔽环境变量回退。
        """
        username = self._section('opencode').get('server_username') or ''
        if username and str(username) != 'opencode':
            return str(username)
        return os.environ.get('OPENCODE_SERVER_USERNAME') or 'opencode'

    # ── AI 后端双通道（loom 转正 + opencode 兜底热回退）─────

    @property
    def AI_BACKEND(self) -> str:
        """AI 后端通道选择：'opencode'（默认，现网链路）| 'loom'（axeuh-harness）。

        顶层标量键 ai_backend；缺省/空 = 'opencode'（现网零影响）。
        切流=编排者手改 config.yaml 后重启后端（不做热切，避免运行期单例漂移）。
        非法值不在本层拦截——由 services/ai_client_factory 在取用点 fail-fast，
        保证"配置能加载、通道取用时响亮报错"的既有分层。
        """
        return str(self._data.get('ai_backend') or 'opencode').strip().lower()

    @property
    def LOOM_URL(self) -> str:
        """Loom（axeuh-harness）服务地址；缺省独立 systemd 监听的 loopback 端口 5100。"""
        return self._section('loom').get('url', 'http://127.0.0.1:5100')

    @property
    def LOOM_TOKEN(self) -> str:
        """Loom API Bearer 令牌（无未鉴权路径，loom Router 拒绝一切空 token）。

        优先级: config.yaml loom.token > 环境变量 LOOM_TOKEN（systemd Environment= 注入，
        照 axeuh-harness 仓 docs/04-切换日附录.md §6 草样）> loom.token_file（读取其中
        的 LOOM_TOKEN= 行）> 空。相对路径按项目根解析；文件内容不写日志。
        空值不在配置层拦截——loom_client 首次发请求时打一次 WARNING，请求照常发出，
        由 loom 侧 401 响亮暴露（与 opencode server_password 的 fail-open 告警风格一致，
        但 loom 强制鉴权，缺 token 必然失败，不存在静默裸奔窗口）。
        """
        token = self._section('loom').get('token') or ''
        if token:
            return str(token)
        env_token = os.environ.get('LOOM_TOKEN') or ''
        if env_token:
            return env_token
        token_file = self.LOOM_TOKEN_FILE
        if token_file:
            return _read_loom_token_file(token_file)
        return ''

    @property
    def LOOM_TOKEN_FILE(self) -> str:
        """loom.token_file 绝对路径；空 = 未配置。相对路径按项目根解析。"""
        raw = str(self._section('loom').get('token_file') or '').strip()
        if not raw:
            return ''
        if os.path.isabs(raw):
            return raw
        return str(_resolve_base() / raw)

    @property
    def LOOM_CREDENTIALS_FILE(self) -> str:
        """loom.credentials_file 绝对路径；空 = 未配置。相对路径按项目根解析。"""
        raw = str(self._section('loom').get('credentials_file') or '').strip()
        if not raw:
            return ''
        if os.path.isabs(raw):
            return raw
        return str(_resolve_base() / raw)

    @property
    def LOOM_MANAGE_CONFIG(self) -> bool:
        """是否允许后端托管写入 Loom 配置；默认关闭（只读）。"""
        return bool(self._section('loom').get('manage_config', False))

    # ── 功能开关 ─────────────────────────────────────

    @property
    def OPENCODE_MOCK_ENABLED(self) -> bool:
        return bool(self._section('features').get('opencode_mock_enabled', False))

    # ── 音频压缩归档 ─────────────────────────────────

    @property
    def AUDIO_COMPRESSOR_ENABLED(self) -> bool:
        """是否启用每日音频自动压缩归档（默认关闭）"""
        return bool(self._section('audio_compressor').get('enabled', False))

    @property
    def AUDIO_COMPRESSOR_KEEP_DAYS(self) -> int:
        """保留最近 N 天的原始 WAV，其余压缩为 M4A 归档（默认 3 天）"""
        return int(self._section('audio_compressor').get('keep_days', 3))

    @property
    def AUDIO_COMPRESSOR_FFMPEG_THREADS(self) -> int:
        """归档 ffmpeg 编码线程上限（默认 0 = ffmpeg 自选；夹取 0..64）"""
        value = _to_int(
            self._section('audio_compressor').get('ffmpeg_threads'))
        if value is None:
            return 0
        return max(0, min(64, value))

    @property
    def AUDIO_COMPRESSOR_NICE(self) -> int:
        """归档 ffmpeg 子进程 nice 优先级（默认 0 = 不调整；夹取 -20..19）"""
        value = _parse_nice(
            self._section('audio_compressor').get('nice'))
        return 0 if value is None else value

    # ── 音频内核（spawn 注入）─────────────────────────────

    @property
    def KERNEL_DEVICE(self) -> str:
        """内核 torch 推理设备：cpu | gpu | auto（缺省空=不注入，内核按 cpu）。

        经 AXEUH_KERNEL_DEVICE 环境变量随 spawn 下发给内核子进程；gpu 时内核
        自行检测 CUDA 可用性，不可用自动回退 cpu。改后需重启后端并让内核重新
        spawn 生效（内核生命周期独立，必要时重启内核）。
        """
        return str(self._section('kernel').get('device', '') or '').strip().lower()

    @property
    def KERNEL_CUDA_VISIBLE_DEVICES(self) -> str:
        """内核子进程可见 GPU（spawn 注入 CUDA_VISIBLE_DEVICES）："" = 不注入。

        torch 的 cuda:0 顺序受 CUDA_DEVICE_ORDER 影响，不保证等于 nvidia-smi
        的 0 号卡；多进程共用 GPU 时用本键把内核钉到空闲卡（如 "1"）。
        改后需重启后端并让内核重新 spawn。
        """
        return str(
            self._section('kernel').get('cuda_visible_devices', '') or ''
        ).strip()

    @property
    def KERNEL_CPU_AFFINITY(self) -> list[int]:
        """内核进程 CPU 亲和（spawn 后 os.sched_setaffinity）：[] = 不限制。

        接受 list[int] 或 "2-4"/"2,3,4" 字符串；负数与非法值被过滤，
        结果去重升序。仅 POSIX 生效；改后需重启后端并让内核重新 spawn。
        """
        raw = self._section('kernel').get('cpu_affinity', [])
        return _parse_cpu_affinity(raw)

    @property
    def KERNEL_NICE(self) -> Optional[int]:
        """内核进程 nice 优先级（spawn 后 os.setpriority）：None = 不调整。

        接受 int 或数字字符串，非法按 None，夹取到 [-20, 19]。
        仅 POSIX 生效；改后需重启后端并让内核重新 spawn。
        """
        raw = self._section('kernel').get('nice')
        return _parse_nice(raw)

    @property
    def KERNEL_PYTHON(self) -> str:
        """内核解释器路径；空 = 调用方自动探测（如 AXEUH_KERNEL_PYTHON / venv）。"""
        return str(self._section('kernel').get('python') or '').strip()

    @property
    def KERNEL_MODEL_DIR(self) -> str:
        """内核模型根目录；空 = 内核默认解析链。相对路径按项目根解析。"""
        raw = str(self._section('kernel').get('model_dir') or '').strip()
        if not raw:
            return ''
        if os.path.isabs(raw):
            return raw
        return str(_resolve_base() / raw)

    @property
    def KERNEL_TORCH_INDEX_URL(self) -> str:
        """torch 安装源覆盖；空 = kernel_bootstrap 按 nvidia-smi 驱动自动判定。"""
        return str(self._section('kernel').get('torch_index_url') or '').strip()

    # ── 认证 ─────────────────────────────────────────

    @property
    def setup_require_token(self) -> bool:
        """首次初始化是否强制校验引导令牌；默认 True（防公网抢注）。"""
        return bool(self._section('auth').get('setup_require_token', True))

    # ── SSL ──────────────────────────────────────────

    @property
    def SSL_ENABLED(self) -> bool:
        """SSL/HTTPS 开关"""
        return bool(self._section('ssl').get('enabled', True))

    @property
    def SSL_CERT(self) -> str:
        return self._section('ssl').get('cert', '')

    @property
    def SSL_KEY(self) -> str:
        return self._section('ssl').get('key', '')

    # ── API ──────────────────────────────────────────

    @property
    def DASHSCOPE_KEY(self) -> str:
        return self._section('api').get('dashscope_key', '')

    @property
    def MIMO_API_KEY(self) -> str:
        return self._section('api').get('mimo_key', '')

    # ── 健康数据 ─────────────────────────────────────

    @property
    def HEALTH_PRIMARY_USER(self) -> str:
        """主用户标识（架构文档第 8 节 health.primary_user）。

        主用户的数据额外派生到 legacy 兼容视图 daily/{date}/health.json；
        缺省返回空字符串（falsy，HealthStore 视为无主用户、按写入者导出）。
        """
        return self._section('health').get('primary_user', '') or ''

    # ── 健康数据源选择 / 小米云（H5，架构文档第 8 节） ──────────

    @property
    def HEALTH_SOURCE_MODE(self) -> str:
        """源选择模式：exclusive（默认，仅主源可写）| merge（双源共存）。"""
        value = self._section('health').get('source_mode', 'exclusive')
        return str(value) if value else 'exclusive'

    @property
    def HEALTH_DEFAULT_SOURCE(self) -> str:
        """每用户默认主数据源（运行时文件 backend/data/health_source_selection.json 可覆盖）。"""
        value = self._section('health').get('default_source', 'phone')
        return str(value) if value else 'phone'

    @property
    def HEALTH_CLOUD_POLL_INTERVAL_MIN(self) -> int:
        """小米云拉取任务周期（分钟，默认 30）。"""
        try:
            return int(self._section('health').get('cloud_poll_interval_min', 30))
        except (TypeError, ValueError):
            return 30

    def _health_cloud(self) -> dict[str, Any]:
        cloud = self._section('health').get('cloud')
        return cloud if isinstance(cloud, dict) else {}

    @property
    def HEALTH_CLOUD_USERID(self) -> str:
        """小米账号 userId（真实值只进 gitignored config.yaml）。"""
        cloud = self._health_cloud()
        return str(cloud.get('userid', '') or '')

    @property
    def HEALTH_CLOUD_PASSTOKEN(self) -> str:
        """小米账号 passToken（真实值只进 gitignored config.yaml，绝不提交）。"""
        cloud = self._health_cloud()
        return str(cloud.get('passtoken', '') or '')

    @property
    def HEALTH_CLOUD_REGION(self) -> str:
        """小米云区域：cn（默认）| ru | de | i2 | sg | us。"""
        cloud = self._health_cloud()
        value = cloud.get('region', 'cn')
        return str(value) if value else 'cn'

    @property
    def HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS(self) -> int:
        """首次拉取（无水位）回看天数，默认 3。"""
        cloud = self._health_cloud()
        try:
            return max(1, int(cloud.get('initial_lookback_days', 3)))
        except (TypeError, ValueError):
            return 3

    @property
    def HEALTH_CLOUD_ENABLED(self) -> bool:
        """小米云自动拉取部署默认开关（运行时状态文件可覆盖），默认 False。"""
        cloud = self._health_cloud()
        return bool(cloud.get('enabled', False))

    @property
    def HEALTH_CLOUD_OVERLAP_DAYS(self) -> int:
        """每次拉取向前重叠的天数，用于吸收云端晚到/补发数据，默认 7。"""
        cloud = self._health_cloud()
        try:
            return max(1, int(cloud.get('overlap_days', 7)))
        except (TypeError, ValueError):
            return 7

    @property
    def HEALTH_CLOUD_STATE_PATH(self) -> str:
        """小米云运行时状态文件；空 = ``<AI_ROOT>/data/health/health_cloud_state.json``。"""
        raw = self._configured_path('data', 'health_cloud_state')
        if raw:
            return raw
        return self._ai_data_path('health', 'health_cloud_state.json')

    # ── 启动器路径 ───────────────────────────────────

    @property
    def CONDAPYTHON_PATH(self) -> str:
        return self._section('launcher').get('conda_python', 'python')

    @property
    def OPENCODE_CMD_PATH(self) -> str:
        return self._section('launcher').get('opencode_cmd', 'opencode')

    # ── 智能体 ───────────────────────────────────────

    @property
    def DEFAULT_AGENT_TYPE(self) -> str:
        return self._section('agent').get('default_type', 'explore')

    @property
    def AVAILABLE_AGENTS(self) -> str:
        agents = self._section('agent').get('available', ['explore'])
        return ','.join(agents) if isinstance(agents, list) else str(agents)

    # ── 日志 ─────────────────────────────────────────

    @property
    def LOG_LEVEL(self) -> str:
        return self._section('log').get('level', 'INFO')

    # ── 记忆系统 (memory) ─────────────────────────────

    @property
    def MEMORY_SEARCH_THRESHOLD(self) -> float:
        return float(self._section('memory').get('search_threshold', 0.7))

    @property
    def MEMORY_SEARCH_LIMIT(self) -> int:
        return int(self._section('memory').get('search_limit', 10))

    # ── 语音识别/声纹 ─────────────────────────────────
    # VAD 阈值与 cohort 上限统一走 audio.* 配置节
    # （见 services/audio_config.py），原死配置 property 已删除。

    @property
    def VOICEPRINT_MIN_SNR(self) -> float:
        """语音最小信噪比(dB)"""
        return float(self._section('voiceprint').get('min_snr', 15.0))

    @property
    def VOICEPRINT_MIN_SEG_SNR(self) -> float:
        """注册时单个 VAD 段的最小信噪比(dB)（逐段过滤，容忍低音量录音）"""
        return float(self._section('voiceprint').get('min_seg_snr', 1.0))

    @property
    def VOICEPRINT_MIN_CONSISTENCY(self) -> float:
        """注册时段间一致性过滤阈值：某段与其它段的平均余弦低于该值则视为混入的
        他人声音/噪音，丢弃不进质心（防注册污染）。仅段数>=3 时启用。"""
        return float(self._section('voiceprint').get('min_consistency', 0.55))

    @property
    def VOICEPRINT_MIN_SPEECH_RATIO(self) -> float:
        """音频最小语音占比"""
        return float(self._section('voiceprint').get('min_speech_ratio', 0.5))

    @property
    def VOICEPRINT_MIN_DURATION(self) -> float:
        """声纹注册最小音频时长(秒)"""
        return float(self._section('voiceprint').get('min_duration', 3.0))

    # ── 数据目录 ─────────────────────────────────────
    # AI 相关路径统一由 data.ai_root 派生；data.root / models.dir / kernel.*
    # 以及 SSL、launcher、OTA 路径保持独立，不随 AI_ROOT 漂移。

    @staticmethod
    def _as_configured_text(value: Any) -> str:
        return str(value or '').strip()

    def _configured_path(self, section: str, key: str) -> str:
        """读取配置路径：空 = 未配置；相对路径按项目根解析。"""
        raw = self._as_configured_text(self._section(section).get(key))
        if not raw:
            return ''
        if os.path.isabs(raw):
            return raw
        return str(_resolve_base() / raw)

    def _ai_data_path(self, *parts: str) -> str:
        return os.path.join(self.AI_ROOT, 'data', *parts)

    @property
    def AI_ROOT(self) -> str:
        """AI 单一根目录（AI 数据/配置/会话/上传的共同祖先）。

        解析顺序：``data.ai_root``（非空）-> 有效 ``data.dir`` 的父目录 ->
        ``<项目根>/ai``。相对路径按项目根解析。AI_ROOT 只读原始 data.dir，
        不反向依赖 DATA_DIR，从而打破两者互相推导的循环。
        """
        raw = self._configured_path('data', 'ai_root')
        if raw:
            return raw
        data_dir = self._configured_path('data', 'dir')
        if data_dir:
            return os.path.dirname(os.path.normpath(data_dir))
        return str(_resolve_base() / 'ai')

    @property
    def DATA_DIR(self) -> str:
        """AI 数据根目录：``data.dir``（非空）-> ``<AI_ROOT>/data``。"""
        raw = self._configured_path('data', 'dir')
        if raw:
            return raw
        return self._ai_data_path()

    @property
    def DATA_ROOT(self) -> str:
        """运行时数据根（secrets/run/logs/models 的父目录），独立于 AI_ROOT。

        空 = 由 ``config.paths.data_root()`` 兜底到 ``<项目根>/var``；相对路径按
        项目根解析。env ``AXEUH_DATA_ROOT`` 的优先级由 paths 层处理，本属性只读配置。
        """
        return self._configured_path('data', 'root')

    @property
    def MODELS_DIR(self) -> str:
        """本地模型权重根目录，独立于 AI_ROOT。

        空 = ``<data.root>/models``（由 paths 层兜底）；相对路径按项目根解析。
        env ``AXEUH_MODELS_DIR`` 的优先级由 paths 层处理。
        """
        return self._configured_path('models', 'dir')

    @property
    def SESSIONS_PATH(self) -> str:
        """用户会话列表 JSON 路径；空 = ``<AI_ROOT>/data/cache/usersessions.json``。"""
        raw = self._configured_path('data', 'sessions')
        if raw:
            return raw
        return self._ai_data_path('cache', 'usersessions.json')

    @property
    def WEB_BACKEND_STATE_PATH(self) -> Path:
        """Web 通道热切换状态文件（W30），固定与 SESSIONS_PATH 同目录派生。

        默认落位 ``<AI_ROOT>/data/cache/web_backend.json``（随 data.sessions
        覆盖自动跟随）。唯一写者 = POST /api/screen/backend（原子 tmp+os.replace）；
        读者 services/web_backend_selector 每次现读，缺失/损坏回落全局 AI_BACKEND
        ——Web 通道与主链路同源起步，被显式切换后才独立，绝不让对话管线因状态
        文件问题崩溃。
        """
        return Path(self.SESSIONS_PATH).parent / "web_backend.json"

    @property
    def VOICEPRINTS_PATH(self) -> str:
        """外层声纹档案；空 = ``<AI_ROOT>/data/cache/voiceprints.json``。"""
        raw = self._configured_path('data', 'voiceprints')
        if raw:
            return raw
        return self._ai_data_path('cache', 'voiceprints.json')

    @property
    def HEALTH_DIR(self) -> str:
        # 健康数据与感知数据同目录（<DATA_DIR>/daily/{date}/health.json）
        return self.DATA_DIR

    @property
    def AUDIO_DIR(self) -> str:
        """(已弃用) 音频文件存储目录，现使用 DATA_DIR/daily/{date}/audio/ 和 DATA_DIR/voice/"""
        return os.path.join(self.DATA_DIR, 'voice')

    @property
    def UPLOAD_DIR(self) -> str:
        """用户上传文件存储目录；空 = ``<AI_ROOT>/data/uploads``。"""
        raw = self._configured_path('data', 'upload_dir')
        if raw:
            return raw
        return self._ai_data_path('uploads')

    @property
    def TASKS_DIR(self) -> str:
        """定时任务数据目录；空 = ``<AI_ROOT>/data``。"""
        raw = self._configured_path('data', 'tasks')
        if raw:
            return raw
        return self._ai_data_path()

    @property
    def SCRIPTS_DIR(self) -> str:
        """自定义脚本目录；空 = ``<AI_ROOT>/data/tasks``（与 YAML 任务同目录）。"""
        raw = self._configured_path('scripts', 'dir')
        if raw:
            return raw
        return self._ai_data_path('tasks')

    # ── 运行时数据路径（V14：五处逃逸硬编码收编；AI 派生项跟随 AI_ROOT）──

    @property
    def HEALTH_DEVICES_PATH(self) -> str:
        """设备注册表文件；空 = ``<AI_ROOT>/data/health/health_devices.json``。"""
        raw = self._configured_path('data', 'health_devices')
        if raw:
            return raw
        return self._ai_data_path('health', 'health_devices.json')

    @property
    def HEALTH_SOURCE_SELECTION_PATH(self) -> str:
        """运行时源选择文件；空 = ``<AI_ROOT>/data/health/health_source_selection.json``。"""
        raw = self._configured_path('data', 'health_source_selection')
        if raw:
            return raw
        return self._ai_data_path('health', 'health_source_selection.json')

    @property
    def KERNEL_STATE_DIR(self) -> str:
        """内核私有状态根（pidfile/voiceprint/jobs/artifacts），默认 backend/data/kernel_state。

        原 kernel_client.py:_DEFAULT_STATE_DIR 按文件位上溯等价路径；
        环境变量 AXEUH_KERNEL_STATE_DIR 的更高优先级保留在 kernel_client
        _state_dir() 内（spawn 参数与 pidfile 读点语义不变）。内核路径不随
        AI_ROOT 漂移。
        """
        raw = self._configured_path('kernel', 'state_dir')
        if raw:
            return raw
        return str(_resolve_base() / 'backend' / 'data' / 'kernel_state')

    @property
    def TASK_LOGS_DIR(self) -> str:
        """脚本任务日志根目录；空 = ``<AI_ROOT>/data/tasks/logs``。

        其下 <name>/ 为脚本日志、audit/ 为审计日志。刻意独立于 SCRIPTS_DIR：
        覆盖 scripts.dir 时日志根不应跟着漂移。
        """
        raw = self._configured_path('data', 'task_logs')
        if raw:
            return raw
        return self._ai_data_path('tasks', 'logs')

    @property
    def STREAM_DIR(self) -> str:
        """流式音频根目录（daily 之外，origin="stream" 专用）。

        空 = ``<AI_ROOT>/data/stream``；可用 data.stream_dir 显式覆盖，相对
        路径按项目根解析。
        """
        raw = self._configured_path('data', 'stream_dir')
        if raw:
            return raw
        return self._ai_data_path('stream')

    @property
    def OTA_APK_DIR(self) -> str:
        """APK 构建输出目录"""
        return self._section('ota').get('apk_dir', os.path.join(str(_resolve_base()), 'app', 'build', 'outputs', 'apk', 'debug'))

    @property
    def PC_SENSOR_EXE_PATH(self) -> str:
        """
        PC 采集端可执行文件路径（设置页下载入口）

        默认 <项目根>/desktop/pc-sensor/dist/Kinship-PCSensor.exe。该文件由 desktop/pc-sensor/build.bat
        (PyInstaller) 生成，且被 .gitignore 忽略（*.exe / dist/），因此新部署的环境需
        自行构建一次，否则下载端点返回 404。

        覆盖方式：环境变量 PC_SENSOR_EXE_PATH > 配置 pc_sensor.exe_path > 默认值。
        """
        env_path = os.environ.get('PC_SENSOR_EXE_PATH')
        if env_path:
            return env_path
        raw = self._section('pc_sensor').get('exe_path', 'desktop/pc-sensor/dist/Kinship-PCSensor.exe')
        if os.path.isabs(raw):
            return raw
        return str(_resolve_base() / raw)

    @property
    def QQ_GATEWAY(self) -> dict:
        return self._section('qq_gateway')

    # ── P2P 设备直连（Phase 1；默认关闭）───────────────

    @property
    def P2P(self) -> dict:
        """p2p 原始配置节；无该节时返回空 dict（等同 disabled）。"""
        return self._section('p2p')

    @property
    def P2P_DEVICES_PATH(self) -> str:
        """P2P 设备注册表文件，默认 backend/data/p2p/devices.json。"""
        raw = self.P2P.get('devices_path', 'backend/data/p2p/devices.json')
        raw = str(raw or 'backend/data/p2p/devices.json')
        if os.path.isabs(raw):
            return raw
        return str(_resolve_base() / raw)

    # ── 首次引导 / MOSS / 客户端发行 ─────────────────────

    @property
    def ONBOARDING_RELEASE_MANIFEST_URL(self) -> str:
        return str(self._section('onboarding').get('release_manifest_url') or '').strip()

    @property
    def ONBOARDING_RELEASE_BASE_URL(self) -> str:
        return str(self._section('onboarding').get('release_base_url') or '').strip()

    @property
    def ONBOARDING_FRONTEND_AUTODOWNLOAD(self) -> bool:
        return bool(self._section('onboarding').get('frontend_autodownload', True))

    @property
    def ONBOARDING_KERNEL_RELEASE_TAG(self) -> str:
        return str(self._section('onboarding').get('kernel_release_tag') or '').strip()

    @property
    def ONBOARDING_ALLOW_MODEL_DOWNLOAD(self) -> bool:
        return bool(self._section('onboarding').get('allow_model_download', True))

    @property
    def ONBOARDING_MODEL_TIERS(self) -> list[str]:
        """引导默认模型档位；缺失/非列表回退 ["required", "recommended"]。"""
        raw = self._section('onboarding').get('model_tiers')
        if not isinstance(raw, list):
            return ["required", "recommended"]
        return [item for item in raw if isinstance(item, str) and item]

    @property
    def MOSS_ENABLED(self) -> bool:
        return bool(self._section('moss').get('enabled', False))

    @property
    def MOSS_PYTHON(self) -> str:
        """MOSS watcher 解释器；空 = 编排 spec 按固定顺序探测现有 venv。"""
        return str(self._section('moss').get('python') or '').strip()

    @property
    def MOSS_BASE_URL(self) -> str:
        raw = str(self._section('moss').get('base_url') or '').strip()
        return raw or 'http://127.0.0.1:8100'

    @property
    def MOSS_MODEL(self) -> str:
        raw = str(self._section('moss').get('model') or '').strip()
        return raw or 'moss-audio-4b'

    @property
    def CLIENTS_ANDROID_URL(self) -> str:
        return str(self._section('clients').get('android_url') or '').strip()

    @property
    def CLIENTS_ANDROID_SHA256(self) -> str:
        return str(self._section('clients').get('android_sha256') or '').strip()

    @property
    def CLIENTS_DESKTOP_URL(self) -> str:
        return str(self._section('clients').get('desktop_url') or '').strip()

    @property
    def CLIENTS_DESKTOP_SHA256(self) -> str:
        return str(self._section('clients').get('desktop_sha256') or '').strip()

    @property
    def CLIENTS_GITHUB_RELEASE_TAG(self) -> str:
        """GitHub 发行标签；显式空串 = 使用 releases/latest。"""
        raw = self._section('clients').get('github_release_tag')
        if raw is None:
            return "onboarding-v1.0.0"
        return str(raw).strip()

    @property
    def CLIENTS_GITHUB_RELEASE_BASE(self) -> str:
        """GitHub 仓库基址；显式空串 = 禁用发行页回退。"""
        raw = self._section('clients').get('github_release_base')
        if raw is None:
            return "https://github.com/Xehuri/kinship"
        return str(raw).strip()


@lru_cache()
def get_config() -> Config:
    """获取全局配置门面；live 模式属性始终读取 ConfigStore 当前快照。"""
    return Config()
