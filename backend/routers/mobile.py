"""
Axeuh Home System - Mobile API Router
手机端 API：文件浏览、报告列表、看板数据
"""
import os
import re
import json
import logging
import uuid
from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Request
from fastapi.responses import JSONResponse, Response
from datetime import datetime

logger = logging.getLogger(__name__)

# 双根目录 — 每次调用现读统一配置，配置热重载后无需重启路由
from config.config import get_config
from services import perception_reader

router = APIRouter(tags=["mobile"])

# ── 工具函数 ──────────────────────────────────────


def _roots() -> tuple[str, str]:
    """返回当前 (AI_ROOT, DATA_DIR) 快照；同一请求内调用方自行复用。"""
    cfg = get_config()
    return cfg.AI_ROOT, cfg.DATA_DIR


# 密钥/凭证类路径黑名单：文件浏览 API 绝不列出、绝不读取。
# 目录段覆盖 .loom/.git/.ssh/.env；文件名覆盖 auth.json 等固定凭证文件，
# 以及 token/secret/credential/password/passwd 关键词与 *_key.* / *.key 形态。
# 普通数据文件（health.json/perception.jsonl/profile.json/keyboard.png）不受影响。
_SECRET_PATH_SEGMENTS = frozenset({".loom", ".git", ".ssh", ".env"})
_SECRET_PATH_NAMES = frozenset({
    "auth.json",
    ".setup_token",
    ".credentials",
    "deepseek_key.txt",
})
_SECRET_PATH_SUFFIXES = (".key", ".pem", ".kdbx")
_SECRET_NAME_MARKERS = ("token", "secret", "credential", "password", "passwd")
_KEY_FILE_RE = re.compile(r"(?:^|[._-])key\.[^.]+$", re.IGNORECASE)


def _is_secret_entry(name: str) -> bool:
    """单个路径段/文件名是否属于禁止暴露的密钥类条目。"""
    lowered = (name or "").strip().lower()
    if not lowered or lowered in {".", ".."}:
        return False
    if lowered in _SECRET_PATH_SEGMENTS or lowered in _SECRET_PATH_NAMES:
        return True
    if lowered.startswith(".env."):
        return True
    if lowered.endswith(_SECRET_PATH_SUFFIXES):
        return True
    if any(marker in lowered for marker in _SECRET_NAME_MARKERS):
        return True
    return bool(_KEY_FILE_RE.search(lowered))


def _is_secret_relative_path(relative_path: str) -> bool:
    """相对路径中任一段命中黑名单即为密钥类路径。"""
    parts = re.split(r"[\\/]+", relative_path or "")
    return any(_is_secret_entry(part) for part in parts)


def _get_file_type(abs_path: str) -> str:
    """根据路径和扩展名判断文件类型"""
    if os.path.isdir(abs_path):
        return "dir"
    ext = os.path.splitext(abs_path)[1].lower()
    type_map = {
        ".json": "json", ".jsonl": "json",
        ".txt": "txt", ".md": "md",
        ".wav": "wav", ".flac": "flac",
        ".jpg": "jpg", ".jpeg": "jpg", ".png": "png",
    }
    return type_map.get(ext, "file")


def _safe_resolve(relative_path: str, scope: str = "data") -> str:
    """安全解析路径，防止目录穿越

    Args:
        relative_path: 相对于 scope 根目录的路径
        scope: "data" → ai/data/（文件浏览数据根），"root" → ai/

    Returns:
        解析后的绝对路径
    """
    ai_root, data_root = _roots()
    root = os.path.normpath(data_root if scope == "data" else ai_root)
    clean = relative_path.lstrip('/\\')
    abs_path = os.path.normpath(os.path.join(root, clean))
    # 严格用 commonpath 校验：公共路径必须恰好等于根目录。
    # 不能用 startswith，否则 ".../ai/data_evil" 这类同前缀兄弟目录会被误判为合法。
    try:
        common = os.path.commonpath([root, abs_path])
    except ValueError:
        # 不同盘符/驱动器时 commonpath 抛 ValueError，视为越界
        raise HTTPException(status_code=403, detail="路径访问被拒绝：禁止目录穿越")
    if common != root:
        raise HTTPException(status_code=403, detail="路径访问被拒绝：禁止目录穿越")
    if _is_secret_relative_path(os.path.relpath(abs_path, root)):
        raise HTTPException(status_code=403, detail="路径访问被拒绝：禁止访问密钥/凭证文件")
    return abs_path


_FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---\s*\n', re.DOTALL)
_H1_RE = re.compile(r'^#\s+(.+?)\s*$', re.MULTILINE)
_DATE_ONLY_RE = re.compile(r'\d{4}-\d{2}-\d{2}')
_DATE_RANGE_RE = re.compile(
    r'(\d{4})-(\d{2})-(\d{2})\s*~\s*(?:(\d{4})-)?(\d{2})-(\d{2})'
)


def _normalize_date(value: str):
    """从文本中取第一个合法 YYYY-MM-DD；没有合法日期返回 None。"""
    for candidate in _DATE_ONLY_RE.findall(value or ""):
        try:
            datetime.strptime(candidate, "%Y-%m-%d")
        except ValueError:
            continue
        return candidate
    return None


def _parse_frontmatter(content: str) -> dict:
    """解析 Markdown YAML frontmatter，返回 {date, tags, title}。

    title 取 frontmatter 之后正文的第一个 H1；没有 frontmatter 时同样扫正文。
    """
    meta = {"date": None, "tags": [], "title": ""}
    body = content
    m = _FRONTMATTER_RE.match(content)
    if m:
        body = content[m.end():]
        for line in m.group(1).split('\n'):
            line = line.strip()
            if line.startswith('date:'):
                meta["date"] = _normalize_date(line.split(':', 1)[1])
            elif line.startswith('tags:'):
                # tags: [tag1, tag2] 或 tags: [日志, 数据检查]
                bracket_m = re.search(r'\[(.*?)\]', line)
                if bracket_m:
                    meta["tags"] = [t.strip().strip('"\'') for t in bracket_m.group(1).split(',') if t.strip()]
    h1 = _H1_RE.search(body)
    if h1:
        meta["title"] = h1.group(1).strip()
    return meta


def _date_from_filename(filename: str):
    """从文件名取报告日期：日期区间取结束日，跨年自动进一位。"""
    stem = os.path.splitext(os.path.basename(filename))[0]
    range_m = _DATE_RANGE_RE.search(stem)
    if range_m:
        start_year = int(range_m.group(1))
        end_year = int(range_m.group(4)) if range_m.group(4) else start_year
        try:
            start = datetime(start_year, int(range_m.group(2)), int(range_m.group(3)))
            end = datetime(end_year, int(range_m.group(5)), int(range_m.group(6)))
            if not range_m.group(4) and end < start:
                end = datetime(end_year + 1, int(range_m.group(5)), int(range_m.group(6)))
        except ValueError:
            return None
        return end.strftime("%Y-%m-%d")
    return _normalize_date(stem)


def _report_kind(path: str, title: str, tags: list) -> str:
    """从路径/标题/标签推导报告类别，无法判定时回落 other。

    判定顺序即优先级：周报、月报优先，其次复盘/审计类，最后日报/理解类。
    """
    haystack = " ".join([path, title, " ".join(tags)])
    markers = (
        ("weekly", ("每周", "周报", "周总结")),
        ("monthly", ("每月", "月度", "月报", "月总结")),
        ("audit", ("复盘", "回顾", "审计", "数据检查", "核查")),
        ("daily", ("日常理解", "每日", "理解记录", "理解", "当日摘要", "健康清单", "daily/")),
    )
    for kind, words in markers:
        if any(word in haystack for word in words):
            return kind
    return "other"


# 用户面报告类别（顺序即响应 families 顺序）
_REPORT_FAMILIES = (
    ("health", "健康清单"),
    ("daily", "日报"),
    ("weekly", "周报"),
    ("review", "复盘"),
)
_REPORT_FAMILY_IDS = {family_id for family_id, _ in _REPORT_FAMILIES}

# (扫描域, 相对 ai/ 的子目录, 最大目录深度) —— 只扫这两处，不碰 ai/ 其余内容
_REPORT_SCAN_ROOTS = (
    ("daily", "data/daily", 1),
    ("reports", "data/reports", 0),
)

_DAILY_HEALTH_RE = re.compile(r'^健康清单-\d{4}-\d{2}-\d{2}\.md$')
_DAILY_REVIEW_RE = re.compile(r'^复盘-\d{4}-\d{2}-\d{2}\.md$')
_WEEKLY_PREFIX = "每周总结-"
_REVIEW_PREFIXES = ("深度回顾-", "培训全程总结")


def _classify_report(area: str, relative_path: str):
    """按扫描域与相对路径判定报告类别；不属于允许清单时返回 None。"""
    parts = relative_path.split('/')
    if area == "daily":
        if len(parts) != 2 or _normalize_date(parts[0]) != parts[0]:
            return None
        name = parts[1]
        if _DAILY_HEALTH_RE.match(name):
            return "health"
        if _DAILY_REVIEW_RE.match(name):
            return "daily"
        return None
    if area == "reports":
        if len(parts) != 1:
            return None
        name = parts[0]
        if name.startswith(_WEEKLY_PREFIX):
            return "weekly"
        if name.startswith(_REVIEW_PREFIXES):
            return "review"
    return None


def _walk_md_files(root_dir: str, max_depth: int = 0) -> list:
    """扫描目录下的 .md 文件，返回 [{path, mtime, size}]。

    max_depth 为相对 root_dir 的最大目录深度（根目录 = 0），超过即剪枝。
    """
    results = []
    root_dir = os.path.normpath(root_dir)
    if not os.path.isdir(root_dir):
        return results
    skip_dirs = {'node_modules', '.opencode', '_template', '.obsidian', '__pycache__'}
    for root, dirs, files in os.walk(root_dir):
        rel_dir = os.path.relpath(root, root_dir).replace('\\', '/')
        depth = 0 if rel_dir == '.' else rel_dir.count('/') + 1
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith('.')]
        if depth >= max_depth:
            dirs[:] = []
        for name in files:
            if not name.endswith('.md'):
                continue
            full = os.path.join(root, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            results.append({
                "path": os.path.relpath(full, root_dir).replace('\\', '/'),
                "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(),
                "size": st.st_size,
            })
    return results


def _scan_report_files() -> list:
    """扫描允许清单内的报告文件，返回带 family 的原始行。"""
    reports = []
    ai_root, _ = _roots()
    for area, relative_root, max_depth in _REPORT_SCAN_ROOTS:
        scan_root = os.path.join(ai_root, relative_root)
        for entry in _walk_md_files(scan_root, max_depth=max_depth):
            family = _classify_report(area, entry["path"])
            if family is None:
                continue
            full_path = os.path.join(scan_root, entry["path"])
            try:
                with open(full_path, "r", encoding="utf-8") as fh:
                    content = fh.read(8192)
            except OSError:
                continue

            meta = _parse_frontmatter(content)
            filename = os.path.basename(entry["path"])
            title = meta["title"] or os.path.splitext(filename)[0]
            report_date = (
                meta["date"]
                or _date_from_filename(filename)
                or entry["mtime"][:10]
            )
            report_path = f"{relative_root}/{entry['path']}"
            reports.append({
                "path": report_path,
                "title": title,
                "date": report_date,
                "mtime": entry["mtime"],
                "tags": meta["tags"],
                "size_bytes": entry["size"],
                "kind": _report_kind(report_path, title, meta["tags"]),
                "family": family,
            })
    return reports


# ── 文件浏览 API ─────────────────────────────────

@router.get("/files")
async def list_files(
    path: str = Query("", description="路径，空字符串表示根目录"),
    scope: str = Query("data", description='作用域: "data"(ai/data/) 或 "root"(ai/)'),
):
    """列出目录内容"""
    abs_path = _safe_resolve(path, scope)
    if not os.path.exists(abs_path):
        # 根目录不存在不是错误，返回空列表，前端显示"无数据"
        return {"entries": []}
    if not os.path.isdir(abs_path):
        raise HTTPException(status_code=400, detail="指定路径不是目录")

    try:
        entries = []
        for name in os.listdir(abs_path):
            full_path = os.path.join(abs_path, name)
            if name.startswith(".") or _is_secret_entry(name):
                continue
            file_type = _get_file_type(full_path)
            stat = os.stat(full_path)
            mtime_dt = datetime.fromtimestamp(stat.st_mtime)
            entries.append({
                "name": name,
                "type": file_type,
                "size": stat.st_size if file_type != "dir" else 0,
                "mtime": mtime_dt.isoformat(),
            })
        entries.sort(key=lambda e: (0 if e["type"] == "dir" else 1, e["name"].lower()))
        return {"entries": entries}
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权限访问此路径")
    except OSError as e:
        logger.error(f"列出目录失败 {abs_path}: {e}")
        raise HTTPException(status_code=500, detail=f"读取目录失败: {str(e)}")


@router.get("/files/content")
async def read_file(
    path: str = Query(..., description="文件路径"),
    scope: str = Query("data", description='作用域: "data"(ai/data/) 或 "root"(ai/)'),
):
    """读取文件内容"""
    abs_path = _safe_resolve(path, scope)
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=400, detail="指定路径不是文件")

    file_type = _get_file_type(abs_path)
    stat = os.stat(abs_path)

    try:
        if file_type == "json":
            with open(abs_path, "r", encoding="utf-8") as f:
                raw = f.read()
            if abs_path.endswith(".jsonl"):
                lines = [line.strip() for line in raw.split("\n") if line.strip()]
                objects = []
                parse_errors = 0
                for line in lines:
                    try:
                        objects.append(json.loads(line))
                    except json.JSONDecodeError:
                        parse_errors += 1
                return {"objects": objects, "total_lines": len(lines), "parse_errors": parse_errors}
            else:
                # 始终返回 {content: raw} 包裹原始文本，让前端 extractTextContent 统一提取
                # 此前直接 return json.loads(raw) 导致前端收到 plain object 无法提取
                return {"content": raw, "type": file_type, "size": stat.st_size}
        elif file_type in ("txt", "md"):
            with open(abs_path, "r", encoding="utf-8") as f:
                content = f.read()
            return Response(content=content, media_type="text/plain; charset=utf-8")
        else:
            try:
                with open(abs_path, "r", encoding="utf-8") as f:
                    content = f.read()
                return {"content": content, "type": file_type, "size": stat.st_size}
            except UnicodeDecodeError:
                return {"content": f"[二进制文件，大小: {stat.st_size} 字节]", "type": file_type, "size": stat.st_size, "binary": True}
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权限读取此文件")
    except OSError as e:
        logger.error(f"读取文件失败 {abs_path}: {e}")
        raise HTTPException(status_code=500, detail=f"读取文件失败: {str(e)}")


# ── 原始文件直出 API (音频/图片) ──────────────────

@router.get("/files/raw")
async def read_file_raw(
    path: str = Query(..., description="文件路径"),
    scope: str = Query("data", description='作用域: "data"(ai/data/) 或 "root"(ai/)'),
):
    """直接返回二进制文件内容，支持音频/图片的正确 MIME 类型。

    用于前端 <audio> / <img> 标签的 src 直接加载。
    """
    abs_path = _safe_resolve(path, scope)
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=400, detail="指定路径不是文件")

    ext = os.path.splitext(abs_path)[1].lower()
    media_type_map = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
        ".m4a": "audio/mp4",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
    }
    media_type = media_type_map.get(ext, "application/octet-stream")

    try:
        with open(abs_path, "rb") as f:
            content = f.read()
        return Response(content=content, media_type=media_type)
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权限读取此文件")
    except OSError as e:
        logger.error(f"读取原始文件失败 {abs_path}: {e}")
        raise HTTPException(status_code=500, detail=f"读取文件失败: {str(e)}")


# ── 文件上传 API ──────────────────────────────────

@router.post("/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
):
    """接收用户上传的文件，保存到用户专属上传目录。

    返回文件路径和访问 URL，前端可将其附加到消息中发送给 AI。
    """
    # 获取上传目录配置
    cfg = get_config()
    upload_root = cfg.UPLOAD_DIR

    # 获取用户 ID（由 AuthMiddleware 注入）
    user_id = getattr(request.state, 'user_id', 'anonymous')
    # 清理 user_id 中的非法字符（防止路径穿越）
    safe_user_id = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(user_id))
    if not safe_user_id or safe_user_id == 'anonymous':
        safe_user_id = 'anonymous'

    # 用户上传目录
    user_dir = os.path.join(upload_root, safe_user_id)
    os.makedirs(user_dir, exist_ok=True)

    # 生成唯一文件名：保留原始扩展名，前缀加时间戳防冲突
    original_name = file.filename or 'unknown'
    name, ext = os.path.splitext(original_name)
    if not ext:
        ext = '.bin'
    safe_name = re.sub(r'[<>:"/\\|?*]', '_', name)[:100]
    unique_name = f"{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"

    file_path = os.path.join(user_dir, unique_name)

    # 写入文件
    try:
        content = await file.read()
        with open(file_path, 'wb') as f:
            f.write(content)
    except OSError as e:
        logger.error(f"文件写入失败 {file_path}: {e}")
        raise HTTPException(status_code=500, detail=f"文件保存失败: {str(e)}")

    # 相对路径（相对于 AI_ROOT，方便 AI 访问）
    rel_path = os.path.relpath(file_path, cfg.AI_ROOT).replace('\\', '/')

    # 文件大小
    file_size = os.path.getsize(file_path)

    logger.info(f"[UPLOAD] 用户 {safe_user_id} 上传文件: {original_name} -> {rel_path} ({file_size} bytes)")

    return {
        "status": "ok",
        "file_name": original_name,
        "file_path": file_path,        # 绝对路径
        "file_rel_path": rel_path,      # 相对 AI_ROOT 的路径
        "file_size": file_size,
        "user_id": safe_user_id,
    }


# ── 报告列表 API ──────────────────────────────────

@router.get("/reports")
async def list_reports(
    tag: str = Query(None, description="按标签筛选，如 '日常理解'"),
    date_from: str = Query(None, description="起始日期（含），YYYY-MM-DD"),
    date_to: str = Query(None, description="结束日期（含），YYYY-MM-DD"),
    family: str = Query(None, description="报告类别: health/daily/weekly/review"),
):
    """列出用户面 AI Markdown 报告。

    只扫描 ai/data/daily 与 ai/data/reports 的允许清单文件（健康清单/日报/周报/复盘），
    每行带 family，并返回 total/counts/families 汇总。
    """
    if family is not None and family not in _REPORT_FAMILY_IDS:
        return JSONResponse(status_code=400, content={"detail": "未知报告类别"})

    reports = []
    for row in _scan_report_files():
        if tag and tag not in row["tags"]:
            continue
        if date_from and row["date"] < date_from:
            continue
        if date_to and row["date"] > date_to:
            continue
        if family and row["family"] != family:
            continue
        reports.append(row)

    # 两趟稳定排序：先 path 升序，再 (date, mtime) 倒序，得到日期/mtime 倒序 + path 升序
    reports.sort(key=lambda r: r["path"])
    reports.sort(key=lambda r: (r["date"], r["mtime"]), reverse=True)

    counts = {family_id: 0 for family_id, _ in _REPORT_FAMILIES}
    for row in reports:
        counts[row["family"]] += 1

    return {
        "reports": reports,
        "total": len(reports),
        "counts": counts,
        "families": [
            {"id": family_id, "label": label, "count": counts[family_id]}
            for family_id, label in _REPORT_FAMILIES
        ],
    }


# ── 看板聚合 API ─────────────────────────────────

@router.get("/dashboard")
async def get_dashboard(
    date: str = Query(None, description="日期 YYYY-MM-DD，默认今天"),
    request: Request = None,
):
    """聚合健康 + 感知数据，返回看板所需的统计数据。

    实时计算，不依赖预生成文件。
    """
    from services.health_storage import query_health_data

    # H6：健康读路径按认证用户取数（架构 §5.5，与 /api/health/query 同口径）。
    # /api/mobile/dashboard 不在 PUBLIC_PATHS，中间件必注入 user_id；
    # 缺失即 401 拒绝，绝不降级 "default"（A5 物理隔离）
    user_id = getattr(request.state, "user_id", None) if request else None
    if not user_id:
        raise HTTPException(
            status_code=401,
            detail="缺少用户身份（user_id 未注入），拒绝访问看板数据",
        )

    target_date = date or datetime.now().strftime("%Y-%m-%d")
    _, data_root = _roots()

    # 1. 健康数据
    health = {}
    try:
        health_data = query_health_data(target_date, user_id=user_id)
        if health_data:
            samples = health_data.get("samples", [])
            daily = health_data.get("daily_summary", {})
            sleep = health_data.get("sleep_data", {})

            hr_vals = [s.get("hr") for s in samples if s.get("hr")]
            spo2_vals = [s.get("spo2") for s in samples if s.get("spo2")]
            stress_vals = [s.get("stress") for s in samples if s.get("stress")]
            step_vals = [s.get("steps") for s in samples if s.get("steps")]

            # 步数：样本中的 steps 是区间增量，日总优先读日总，缺失时对增量求和
            total_steps = daily.get("total_steps")
            if not total_steps and step_vals:
                # 增量语义：直接求和即全天总步数（差值累加是错误口径）
                total_steps = sum(step_vals)

            # 睡眠：用 stages 计算实际时长（避免跨天累计导致 duration_min 虚高）
            sleep_data = None
            if sleep:
                stages = sleep.get("stages", [])
                if stages:
                    # 从 stages 时间戳计算：第一个 stage 到最后一个 stage
                    first_t = stages[0].get("t", "00:00")
                    last_t = stages[-1].get("t", "00:00")
                    def _to_min(t_str):
                        try:
                            parts = t_str.split(":")
                            return int(parts[0]) * 60 + int(parts[1])
                        except:
                            return 0
                    f_min = _to_min(first_t)
                    l_min = _to_min(last_t)
                    if l_min >= f_min:
                        calc_dur = l_min - f_min
                    else:
                        calc_dur = (24*60 - f_min) + l_min  # 跨午夜
                    if 180 < calc_dur < 1440:  # 3h~24h 合理范围
                        sleep_data = {
                            "duration_min": calc_dur,
                            "deep_min": sleep.get("deep_min", 0),
                            "light_min": sleep.get("light_min", 0),
                            "rem_min": sleep.get("rem_min", 0),
                        }
                # stages 不可用时，用上报值（但不超过24h）
                if not sleep_data and sleep.get("duration_min", 0) < 1440:
                    sleep_data = {
                        "duration_min": sleep.get("duration_min", 0),
                        "deep_min": sleep.get("deep_min", 0),
                        "light_min": sleep.get("light_min", 0),
                        "rem_min": sleep.get("rem_min", 0),
                    }

            health = {
                "heart_rate": {
                    "avg": round(sum(hr_vals) / len(hr_vals)) if hr_vals else None,
                    "min": min(hr_vals) if hr_vals else None,
                    "max": max(hr_vals) if hr_vals else None,
                    "samples": len(hr_vals),
                },
                "spo2": {
                    "avg": round(sum(spo2_vals) / len(spo2_vals), 1) if spo2_vals else None,
                    "min": min(spo2_vals) if spo2_vals else None,
                },
                "stress": {
                    "avg": round(sum(stress_vals) / len(stress_vals)) if stress_vals else None,
                },
                "steps": total_steps,
                "sleep": sleep_data,
            }
    except Exception as e:
        logger.warning(f"看板健康数据加载失败: {e}")

    # 2. 感知数据摘要（含 GPS 和电量）
    perception_summary = {}
    gps_count = 0
    latest_battery = None
    battery_timeline = []  # [{ts, level}]
    try:
        if perception_reader.has_perception(target_date, data_root=data_root):
            voice_count = 0
            sensor_count = 0
            app_count = 0
            for entry in perception_reader.read_day(target_date, data_root=data_root):
                t = entry.get("type", "")
                if t == "voice":
                    voice_count += 1
                elif t == "sensor":
                    sensor_count += 1
                    if entry.get("gps"):
                        gps_count += 1
                    batt = entry.get("phone_battery") or entry.get("battery")
                    if batt:
                        latest_battery = batt
                        t_raw = entry.get("t") or entry.get("ts") or entry.get("client_time")
                        if t_raw:
                            battery_timeline.append({"t": t_raw, "level": batt})
                elif t in ("app", "media", "notify"):
                    app_count += 1
            perception_summary = {
                "voice_sessions": voice_count,
                "sensor_events": sensor_count,
                "app_media_events": app_count,
                "gps_records": gps_count if gps_count > 0 else None,
                "battery": latest_battery,
                "battery_timeline": battery_timeline if battery_timeline else None,
            }
    except Exception as e:
        logger.warning(f"看板感知数据加载失败: {e}")

    return {
        "date": target_date,
        "health": health,
        "perception": perception_summary,
    }
