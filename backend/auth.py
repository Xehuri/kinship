# -*- coding: utf-8 -*-
"""
简单Token认证系统
"""
import os
import json
import time
import hmac
import hashlib
import secrets
import tempfile
import threading
import bcrypt
from datetime import datetime, timedelta
from typing import Optional
import logging
from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

# 配置文件路径（使用绝对路径）
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
# 认证状态目录：缺省 <project>/backend/config；staging 用 AEUH_AUTH_STATE_DIR 隔离。
_PROJECT_ROOT = os.environ.get("AXEUH_PROJECT_ROOT") or os.path.dirname(BACKEND_DIR)
AUTH_STATE_DIR = (
    os.environ.get("AXEUH_AUTH_STATE_DIR")
    or os.environ.get("AEUH_AUTH_STATE_DIR")
    or os.path.join(_PROJECT_ROOT, "backend", "config")
)
AUTH_CONFIG_FILE = os.path.join(AUTH_STATE_DIR, "auth.json")

# 凭据变更互斥锁：保护"创建首个用户""修改凭据"等写操作
_auth_lock = threading.RLock()

# Token有效期（小时）
TOKEN_EXPIRE_HOURS = 24

# 服务 Token 常量：供 AI 自动化脚本长期使用，不随登录/改密失效
SERVICE_TOKEN_KIND = "service"
SERVICE_TOKEN_EXPIRY = "2099-12-31T00:00:00"

# 设备 Token 常量：P2P 配对后签发，kind="device" 且绑定 device_id
DEVICE_TOKEN_KIND = "device"

# 首次初始化引导令牌文件：仅系统尚无用户时存在，setup 成功后删除。
SETUP_TOKEN_FILE = os.path.join(AUTH_STATE_DIR, ".setup_token")

# WebSocket / 长连接一次性票据：
# 用于 <audio>、EventSource、WebSocket 等无法携带 Authorization 头的场景，
# 先经 Bearer 认证换取，再以 ?ticket= 一次性消费，避免长期 token 进入 URL/日志/历史。
# scope 限定票据用途：download 只能换下载端点；generic 可用于任意用途。
WS_TICKET_TTL_SECONDS = 30
TICKET_SCOPE_GENERIC = "generic"
TICKET_SCOPE_DOWNLOAD = "download"
_WS_TICKET_SCOPES = frozenset({TICKET_SCOPE_GENERIC, TICKET_SCOPE_DOWNLOAD})
_ws_ticket_lock = threading.Lock()
_ws_tickets: dict[str, dict] = {}  # ticket -> {"user_id", "expires_at", "scope"}


def create_ws_ticket(
    user_id: str,
    ttl_seconds: int = WS_TICKET_TTL_SECONDS,
    scope: str = TICKET_SCOPE_GENERIC,
) -> tuple[str, int]:
    """创建一次性票据，返回 (ticket, expires_in)。

    ticket 为 32 字节随机数的 hex 表示（64 个十六进制字符），默认 30 秒内
    一次性有效；文件下载等场景可显式传入更长的 TTL。scope 标识用途，
    下载端点只接受 download 或 generic 票据。
    """
    normalized_scope = (scope or "").strip()
    if normalized_scope not in _WS_TICKET_SCOPES:
        raise ValueError("unsupported ws ticket scope")
    ttl = max(1, int(ttl_seconds))
    ticket = secrets.token_hex(32)
    now = time.time()
    with _ws_ticket_lock:
        # 顺带清理过期票据，避免字典无限增长
        for stale in [t for t, e in _ws_tickets.items() if e["expires_at"] < now]:
            _ws_tickets.pop(stale, None)
        _ws_tickets[ticket] = {
            "user_id": user_id,
            "expires_at": now + ttl,
            "scope": normalized_scope,
        }
    return ticket, ttl


def consume_ws_ticket(
    ticket: str, required_scope: Optional[str] = None
) -> tuple[bool, Optional[str]]:
    """校验并消费一次性票据（用过即删），返回 (是否有效, user_id)。

    ``required_scope`` 非空时只接受同 scope 或 generic 票据；scope 不匹配
    的票据原样保留（不被误消费），过期票据则直接清除。
    """
    if not ticket:
        return False, None
    with _ws_ticket_lock:
        entry = _ws_tickets.get(ticket)
        if not entry:
            return False, None
        if time.time() > entry["expires_at"]:
            _ws_tickets.pop(ticket, None)
            return False, None
        scope = str(entry.get("scope") or TICKET_SCOPE_GENERIC)
        if (
            required_scope is not None
            and scope != TICKET_SCOPE_GENERIC
            and scope != required_scope
        ):
            return False, None
        _ws_tickets.pop(ticket, None)
    return True, entry["user_id"]


def clear_ws_tickets():
    """清空全部票据（测试用，避免测试间相互污染）。"""
    with _ws_ticket_lock:
        _ws_tickets.clear()


def _remove_setup_token_file():
    """删除引导令牌文件（不存在或删除失败时静默忽略）。"""
    try:
        if os.path.exists(SETUP_TOKEN_FILE):
            os.remove(SETUP_TOKEN_FILE)
    except OSError:
        pass


def _ensure_setup_token_dir() -> None:
    """确保引导令牌目录存在且仅属主可访问（0700）。"""
    directory = os.path.dirname(SETUP_TOKEN_FILE)
    if directory:
        os.makedirs(directory, mode=0o700, exist_ok=True)


def get_or_create_setup_token() -> str:
    """获取或生成首次初始化引导令牌。

    - 已有用户时：删除可能残留的引导文件并返回空串（无需引导）。
    - 尚无用户时：优先读取本地文件中的既有令牌；不存在则生成随机令牌，
      以 0600 权限写入本地文件并打印日志，供管理员在服务器上查看。
    - 令牌未能落盘时返回空串并记录错误，绝不返回无法再次读取的令牌。

    引导令牌仅用于 `/auth/setup` 的抢注防护，不参与常规接口认证。
    """
    with _auth_lock:
        if get_auth_config().users:
            _remove_setup_token_file()
            return ""

        if os.path.exists(SETUP_TOKEN_FILE):
            try:
                with open(SETUP_TOKEN_FILE, "r", encoding="utf-8") as f:
                    existing = f.read().strip()
                if existing:
                    return existing
            except OSError:
                pass

        token = secrets.token_hex(32)
        try:
            _ensure_setup_token_dir()
            fd = os.open(SETUP_TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(token)
        except OSError as e:
            logger.error(
                "[Auth] 引导令牌写入失败，跳过引导令牌生成: %s",
                type(e).__name__,
            )
            return ""
        logger.debug(
            "[Auth] 首次初始化引导令牌已生成，请查看 %s；"
            "调用 /auth/setup 时需通过 X-Setup-Token 头携带。",
            SETUP_TOKEN_FILE,
        )
        return token


def verify_setup_token(token: str) -> bool:
    """校验引导令牌（常量时间比较，避免时序侧信道）。"""
    expected = get_or_create_setup_token()
    if not expected:
        return False
    return secrets.compare_digest(expected, (token or "").strip())


def clear_setup_token():
    """删除引导令牌文件（setup 成功后调用）。"""
    with _auth_lock:
        _remove_setup_token_file()


class UserInfo(BaseModel):
    """用户信息"""
    password_hash: str
    display_name: str = "用户"


class TokenInfo(BaseModel):
    """Token信息"""
    user_id: str
    expires_at: str
    kind: str = "user"  # 默认 "user"，保持所有既有 Token 有效
    device_id: str = ""  # kind="device" 时绑定设备；旧 auth.json 缺省为空串


class AuthConfig(BaseModel):
    """认证配置"""
    users: dict[str, UserInfo] = {}
    tokens: dict[str, TokenInfo] = {}  # token -> TokenInfo


class LoginRequest(BaseModel):
    """登录请求"""
    username: str
    password: str


class LoginResponse(BaseModel):
    """登录响应"""
    success: bool
    token: Optional[str] = None
    user_id: Optional[str] = None
    display_name: Optional[str] = None
    message: str


class ChangeCredentialsRequest(BaseModel):
    """修改凭据请求：原密码必填，新用户名/新密码可任选其一或同时提供"""
    old_password: str
    new_username: Optional[str] = None
    new_password: Optional[str] = None


def hash_password(password: str) -> str:
    """使用 bcrypt 密码哈希"""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def load_auth_config() -> AuthConfig:
    """加载认证配置。

    文件不存在时返回空配置（首次初始化由 setup 流程负责），
    不再回退到 config.yaml 密码，也不自动创建默认用户或写盘。
    """
    config_dir = os.path.dirname(AUTH_CONFIG_FILE)
    if config_dir and not os.path.exists(config_dir):
        os.makedirs(config_dir)

    if os.path.exists(AUTH_CONFIG_FILE):
        with open(AUTH_CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # 检查是否需要从旧格式迁移（单用户 -> 多用户）
        if "username" in data and "password_hash" in data:
            config = AuthConfig(
                users={
                    data["username"]: UserInfo(
                        password_hash=data["password_hash"],
                        display_name=data["username"]
                    )
                }
            )
            # 如果旧格式有 tokens，也迁移
            if "tokens" in data:
                for token, expiry_str in data["tokens"].items():
                    config.tokens[token] = TokenInfo(user_id=data["username"], expires_at=expiry_str)
            save_auth_config(config)
            logger.info(f"[Auth] 已从旧格式迁移: {data['username']}")
            return config

        try:
            return AuthConfig(**data)
        except ValidationError:
            logger.error("[Auth] auth.json 格式无效，请检查文件结构")
            raise ValueError("auth.json 格式无效") from None
    else:
        # 首次运行：无 auth.json 时返回空配置，等待首次初始化设置凭据
        return AuthConfig()


def save_auth_config(config: AuthConfig):
    """原子保存认证配置：先写同目录临时文件，再 os.replace 覆盖目标。"""
    config_dir = os.path.dirname(AUTH_CONFIG_FILE)
    if config_dir and not os.path.exists(config_dir):
        os.makedirs(config_dir)

    # 临时文件与目标文件同目录，保证 os.replace 在同一文件系统内原子完成
    fd, tmp_path = tempfile.mkstemp(
        dir=config_dir or ".", prefix=".auth_", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(config.model_dump(), f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, AUTH_CONFIG_FILE)
    except Exception:
        # 写入失败时清理临时文件，避免残留
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise


# 全局配置实例
_auth_config: Optional[AuthConfig] = None


def get_auth_config() -> AuthConfig:
    """获取认证配置"""
    global _auth_config
    if _auth_config is None:
        _auth_config = load_auth_config()
    return _auth_config


def _reload_config() -> AuthConfig:
    """强制重新读取认证配置（清空内存缓存后经 get_auth_config 重新加载）。

    供所有写操作在锁内使用，避免基于过期缓存做判断导致并发丢写。
    测试中 get_auth_config 被替换为内存 mock 时同样适用。
    """
    global _auth_config
    _auth_config = None
    config = get_auth_config()
    # 即便 get_auth_config 被替换为 mock（不会回写全局），这里也显式回写全局指针，
    # 保证后续读取拿到 reload 后的对象。
    _auth_config = config
    return config


def _is_bcrypt_hash(hashed_password: str) -> bool:
    """判断是否为 bcrypt 哈希（$2a$/$2b$/$2y$）。"""
    return bool(hashed_password) and hashed_password.startswith(('$2a$', '$2b$', '$2y$'))


def _is_sha256_hex(hashed_password: str) -> bool:
    """判断是否为 64 位十六进制 SHA256 摘要（旧版格式）。"""
    if not hashed_password or len(hashed_password) != 64:
        return False
    try:
        int(hashed_password, 16)
        return True
    except ValueError:
        return False


def _check_password(plain_password: str, hashed_password: str) -> bool:
    """检查密码是否匹配哈希。

    - bcrypt：使用 bcrypt.checkpw 校验。
    - 旧版 SHA256：使用 hmac.compare_digest 常量时间比较。
    - 未知哈希格式：直接拒绝（不进入任何非常量时间比较）。
    """
    if _is_bcrypt_hash(hashed_password):
        try:
            return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))
        except Exception:
            return False
    if _is_sha256_hex(hashed_password):
        digest = hashlib.sha256(plain_password.encode()).hexdigest()
        return hmac.compare_digest(digest, hashed_password)
    # 未知哈希格式，拒绝
    return False


def _migrate_password_hash(username: str, plain_password: str) -> None:
    """登录成功时，把旧版 SHA256 哈希就地迁移为 bcrypt（BE-SEC-M3）。

    - 在 _auth_lock 内 reload，避免与并发登录/改密相互丢写。
    - 仅当当前存的仍是 SHA256 时才迁移；已是 bcrypt 则跳过。
    """
    global _auth_config
    with _auth_lock:
        config = _reload_config()
        user = config.users.get(username)
        if not user or not _is_sha256_hex(user.password_hash):
            return
        user.password_hash = hash_password(plain_password)
        _auth_config = config
        save_auth_config(config)
        logger.info(f"[Auth] 用户 {username} 的旧版 SHA256 密码哈希已迁移为 bcrypt")


def verify_password(username: str, password: str) -> tuple[bool, Optional[str]]:
    """验证密码，返回 (是否成功, user_id)

    旧版 SHA256 哈希在登录成功后自动迁移为 bcrypt。
    """
    config = get_auth_config()
    if username in config.users:
        stored_hash = config.users[username].password_hash
        if _check_password(password, stored_hash):
            if _is_sha256_hex(stored_hash):
                # 登录成功：将旧哈希迁移为 bcrypt
                try:
                    _migrate_password_hash(username, password)
                except Exception as e:
                    logger.warning(f"[Auth] 密码哈希迁移失败（不影响本次登录）: {e}")
            return True, username
    return False, None


def check_user_password(username: str, password: str) -> bool:
    """只读校验用户密码，不迁移哈希、不写 auth.json。

    供引导向导入口一次性验证管理员密码：与 verify_password 不同，本函数
    不触发旧版 SHA256 -> bcrypt 迁移，也不签发 Token，只回答密码是否匹配。
    未知用户、空密码、未知哈希格式一律返回 False。
    """
    normalized = (username or "").strip()
    if not normalized or not password:
        return False
    with _auth_lock:
        config = _reload_config()
        user = config.users.get(normalized)
        if not user:
            return False
        return _check_password(password, user.password_hash)


def generate_token() -> str:
    """生成Token"""
    return secrets.token_urlsafe(32)


def create_token(username: str) -> str:
    """创建登录Token，关联 user_id

    BE-SEC-M2: 所有写操作统一在 _auth_lock 内 reload 后再改，
    避免并发 login/logout 相互覆盖导致丢 token。
    """
    global _auth_config
    with _auth_lock:
        config = _reload_config()
        token = generate_token()
        expiry = datetime.now() + timedelta(hours=TOKEN_EXPIRE_HOURS)
        config.tokens[token] = TokenInfo(user_id=username, expires_at=expiry.isoformat())

        # 清理过期token
        clean_expired_tokens(config)

        _auth_config = config
        save_auth_config(config)
        return token


def create_device_token(username: str, device_id: str, expires_days: int = 365) -> str:
    """创建设备 Token（kind="device"，绑定 device_id）。

    设备 Token 与用户 Token/服务 Token 共存于 auth.json；撤销某设备只删除
    该 device_id 的 kind="device" 条目，不影响其它凭据。
    """
    if not device_id:
        raise ValueError("device_id is required")
    global _auth_config
    with _auth_lock:
        config = _reload_config()
        token = generate_token()
        expiry = datetime.now() + timedelta(days=expires_days)
        config.tokens[token] = TokenInfo(
            user_id=username,
            expires_at=expiry.isoformat(),
            kind=DEVICE_TOKEN_KIND,
            device_id=device_id,
        )
        clean_expired_tokens(config)
        _auth_config = config
        save_auth_config(config)
        return token


def revoke_device_tokens(device_id: str) -> int:
    """吊销某设备的全部设备 Token，返回删除数量。

    仅匹配 kind="device" 且 device_id 相同的条目；用户/服务 Token 与其它
    设备的 Token 原样保留。
    """
    if not device_id:
        return 0
    global _auth_config
    with _auth_lock:
        config = _reload_config()
        doomed = [
            token
            for token, info in config.tokens.items()
            if info.kind == DEVICE_TOKEN_KIND and info.device_id == device_id
        ]
        if not doomed:
            return 0
        for token in doomed:
            del config.tokens[token]
        _auth_config = config
        save_auth_config(config)
        return len(doomed)


def ensure_service_token() -> Optional[str]:
    """确保存在一个长期有效的服务 Token（供 AI 自动化脚本使用）。

    行为：
      - 已存在 kind == "service" 的 Token 时原样返回（幂等，不重复创建）。
      - 否则在已存在用户的前提下，创建一个 far-future 的服务 Token 并持久化。
      - 尚无任何用户（首次初始化未完成）时不创建任何 Token，返回 None。
    """
    global _auth_config
    with _auth_lock:
        config = _reload_config()

        # 已有服务 Token：直接返回，保证幂等
        for token, info in config.tokens.items():
            if info.kind == SERVICE_TOKEN_KIND:
                return token

        # 尚无用户：首次初始化尚未完成，不伪造 Token
        if not config.users:
            return None

        # 选取一个有效用户作为归属（优先 config.users 中的第一个用户）
        user_id = next(iter(config.users))
        token = generate_token()
        config.tokens[token] = TokenInfo(
            user_id=user_id,
            expires_at=SERVICE_TOKEN_EXPIRY,
            kind=SERVICE_TOKEN_KIND,
        )

        save_auth_config(config)
        _auth_config = config
        return token


def is_setup_required() -> bool:
    """是否需要首次初始化：系统中尚无任何用户。"""
    return len(get_auth_config().users) == 0


def create_first_user(username: str, password: str) -> tuple[bool, str, Optional[str]]:
    """首次初始化：创建第一个用户并返回登录 Token。

    仅当系统尚无任何用户时可调用；成功后同步创建长期服务 Token，
    使 AI 自动化脚本无需重启即可拿到凭据。

    返回 (是否成功, 提示信息, token)。
    """
    global _auth_config
    with _auth_lock:
        # 锁内重新读取，避免并发下基于过期缓存重复初始化
        config = _reload_config()

        if config.users:
            return False, "系统已初始化，无法重复设置", None

        username = (username or "").strip()
        if not username:
            return False, "用户名不能为空", None
        if len(password or "") < 6:
            return False, "密码长度至少6位", None

        config.users[username] = UserInfo(
            password_hash=hash_password(password),
            display_name=username,
        )

        _auth_config = config
        save_auth_config(config)

        token = create_token(username)
        # 同步创建服务 Token，保证 AI 脚本立即可用
        ensure_service_token()
        # 初始化完成，删除一次性引导令牌文件
        clear_setup_token()
        return True, "设置成功", token


def verify_token_full(token: str) -> tuple[bool, Optional[str], str, str]:
    """验证Token，返回 (是否有效, user_id, kind, device_id)。

    kind 为 "user"（含旧格式缺省）/ "service" / "device"；device_id 仅设备
    Token 非空。过期 Token 的清理语义与 verify_token 保持一致。
    """
    global _auth_config
    if not token:
        return False, None, "", ""

    config = get_auth_config()
    token_info = config.tokens.get(token)
    if token_info is None:
        return False, None, "", ""

    # 检查是否过期
    try:
        expiry = datetime.fromisoformat(token_info.expires_at)
    except Exception:
        return False, None, "", ""

    if datetime.now() > expiry:
        # Token已过期：删除属于写操作，需在锁内 reload，
        # 避免覆盖并发新增的其它 token（BE-SEC-M2）
        with _auth_lock:
            fresh = _reload_config()
            if token in fresh.tokens:
                del fresh.tokens[token]
                _auth_config = fresh
                save_auth_config(fresh)
        return False, None, "", ""

    return True, token_info.user_id, token_info.kind, token_info.device_id


def verify_token(token: str) -> tuple[bool, Optional[str]]:
    """验证Token，返回 (是否有效, user_id)"""
    is_valid, user_id, _kind, _device_id = verify_token_full(token)
    return is_valid, user_id


def clean_expired_tokens(config: AuthConfig):
    """清理过期Token"""
    now = datetime.now()
    expired = []
    for token, token_info in config.tokens.items():
        try:
            expiry = datetime.fromisoformat(token_info.expires_at)
            if now > expiry:
                expired.append(token)
        except:
            expired.append(token)
    
    for token in expired:
        del config.tokens[token]


def logout(token: str):
    """登出（BE-SEC-M2: 锁内 reload，避免与并发登录相互覆盖）"""
    global _auth_config
    with _auth_lock:
        config = _reload_config()
        if token in config.tokens:
            del config.tokens[token]
            _auth_config = config
            save_auth_config(config)


def change_credentials(
    user_id: str,
    old_password: str,
    new_username: Optional[str] = None,
    new_password: Optional[str] = None,
) -> tuple[bool, str, Optional[str]]:
    """修改用户凭据（用户名和/或密码）。

    - 校验原密码；用户名可改可不变；密码可改可不变。
    - 用户名变更时同步所有归属该用户的 Token（含服务 Token）的 user_id。
    - 改密（提供 new_password）时吊销该用户全部**普通** Token，
      使旧登录凭证立即失效；kind == "service" 的服务 Token 保持不变，
      避免打断 AI/OpenCode 自动化链路。
    - 改密成功后会为当前会话签发一个绑定目标用户名的新 Token 并返回，
      保证发起改密的本次会话无缝延续；其它设备/App 因旧 Token 失效需重新登录。
    - 仅改名不改密时保留既有 Token，仅同步归属，不轮换 Token。

    返回 (是否成功, 提示信息, 新 Token 或 None)；仅改密时新 Token 非 None。
    """
    global _auth_config
    with _auth_lock:
        config = _reload_config()

        if user_id not in config.users:
            return False, "用户不存在", None

        if not _check_password(old_password, config.users[user_id].password_hash):
            return False, "原密码错误", None

        # 目标用户名：未提供或全为空白时保持原名
        target_username = (new_username or user_id).strip() or user_id
        renamed = target_username != user_id
        if renamed and target_username in config.users:
            return False, "用户名已存在", None

        # 目标密码哈希：提供新密码则校验并重算，否则沿用旧哈希
        current_hash = config.users[user_id].password_hash
        if new_password is not None:
            if len(new_password) < 6:
                return False, "密码长度至少6位", None
            target_hash = hash_password(new_password)
        else:
            target_hash = current_hash

        if renamed:
            del config.users[user_id]
            config.users[target_username] = UserInfo(
                password_hash=target_hash,
                display_name=target_username,
            )
        elif new_password is not None:
            config.users[user_id].password_hash = target_hash

        # 用户名变更时同步归属该用户的所有 Token（含服务 Token）
        if renamed:
            for info in config.tokens.values():
                if info.user_id == user_id:
                    info.user_id = target_username

        # BE-SEC-H3: 改密后吊销该用户全部普通 Token（保留 service Token 不动）
        if new_password is not None:
            for tk in [
                t for t, info in config.tokens.items()
                if info.user_id == target_username and info.kind != SERVICE_TOKEN_KIND
            ]:
                del config.tokens[tk]

        save_auth_config(config)
        _auth_config = config

        # 改密后为当前会话签发新 Token（旧普通 Token 已全部吊销）；
        # create_token 内部会在 _auth_lock（可重入）内 reload 后写入。
        # 仅改名不改密时不轮换 Token，返回 None。
        new_token = create_token(target_username) if new_password is not None else None

        return True, "修改成功", new_token


def change_password(user_id: str, old_password: str, new_password: str) -> tuple[bool, str]:
    """修改密码（向后兼容包装，内部委托给 change_credentials）。

    注意：改密会吊销该用户的普通 Token（旧登录凭证立即失效），
    但保留 kind == "service" 的服务 Token。
    """
    ok, msg, _ = change_credentials(user_id, old_password, None, new_password)
    return ok, msg