"""AI health 读方共享层：分片合成视图优先，派生文件回落。

机制：
- health 真源 = backend HealthStore 分片 users/{u}/health/{d}/{phone,cloud}.json；
  派生视图 daily/{d}/health.json 的双写已退役，只保留存量历史日。
- read_view 与派生文件共用同一合成逻辑，分片优先不改变消费方口径。
- backend 目录按候选解析：`AXEUH_BACKEND_DIR` 环境变量优先，其次按 AI 根位置
  推 `../backend` 与 `../../backend`；都不存在时仍按第一个候选尝试导入。
- backend 不可用（ImportError/store 异常）时返回 None，由调用方回退文件读取；
  脚本保持独立可跑，不因跨目录依赖断裂。
"""
import os
import sys

_AI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ROOT = os.path.dirname(_AI_ROOT)

_BACKEND_CANDIDATES = [
    os.environ.get("AXEUH_BACKEND_DIR", "").strip(),
    os.path.join(_REPO_ROOT, "backend"),
    os.path.join(os.path.dirname(_REPO_ROOT), "backend"),
]
_BACKEND_CANDIDATES = [path for path in _BACKEND_CANDIDATES if path]
_BACKEND_DIR = next(
    (path for path in _BACKEND_CANDIDATES if os.path.isdir(path)),
    _BACKEND_CANDIDATES[0] if _BACKEND_CANDIDATES else "",
)

_warned = False


def read_health_view(date_str):
    """经 backend HealthStore 合成某日派生视图形状 dict；无分片/不可用返回 None。"""
    global _warned
    try:
        if _BACKEND_DIR and _BACKEND_DIR not in sys.path:
            sys.path.insert(0, _BACKEND_DIR)
        from services.health_storage import get_health_store
        store = get_health_store()
        return store.read_view(store.primary_user or "default", date_str)
    except Exception as e:
        if not _warned:
            print(f"警告: backend store 不可用，health 回落文件读取: {e}",
                  file=sys.stderr)
            _warned = True
        return None
