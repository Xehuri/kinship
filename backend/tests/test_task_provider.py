# -*- coding: utf-8 -*-
"""
任务 provider 支持测试

覆盖三条链路：
  1. YAML 任务（task_storage）：顶层 provider 键 / model 字典内 provider /
     仅 model / 字典与顶层同时出现时的优先级
  2. Python 脚本 frontmatter（script_runner._get_script_info）：provider 解析
  3. 脚本运行时（scripts.context.trigger_task）：动态传 model/provider 覆盖
"""
import json

from services.task_storage import TaskStorage
from services.script_runner import _get_script_info
from services.scripts.context import Context


def _write_yaml(tmp_path, filename: str, body: str) -> None:
    tasks_dir = tmp_path / "tasks"
    tasks_dir.mkdir(exist_ok=True)
    (tasks_dir / filename).write_text(body, encoding="utf-8")


def _load_tasks(tmp_path):
    storage = TaskStorage(data_dir=str(tmp_path))
    assert storage._load_tasks_from_directory(), "任务加载失败"
    return {t.task_name: t for t in storage._tasks_cache.values()}


# ============================================================
# 1. YAML 任务
# ============================================================

class TestYamlProvider:
    def test_toplevel_provider_key(self, tmp_path):
        """model 与 provider 并列书写（本次新增能力）"""
        _write_yaml(tmp_path, "t1.yaml", """
name: 顶层provider
schedule:
  daily: "08:00"
prompt: hello
model: deepseek-flash
provider: deepseek
""")
        task = _load_tasks(tmp_path)["顶层provider"]
        assert task.model_id == "deepseek-flash"
        assert task.provider_id == "deepseek"

    def test_model_dict_provider(self, tmp_path):
        """结构化字典写法（原有能力，防回归）"""
        _write_yaml(tmp_path, "t2.yaml", """
name: 字典provider
schedule:
  daily: "08:00"
prompt: hello
model:
  id: deepseek-flash
  provider: deepseek
""")
        task = _load_tasks(tmp_path)["字典provider"]
        assert task.model_id == "deepseek-flash"
        assert task.provider_id == "deepseek"

    def test_model_only_leaves_provider_none(self, tmp_path):
        """只写 model 时不注入 provider，交给全局默认"""
        _write_yaml(tmp_path, "t3.yaml", """
name: 仅model
schedule:
  daily: "08:00"
prompt: hello
model: deepseek-flash
""")
        task = _load_tasks(tmp_path)["仅model"]
        assert task.model_id == "deepseek-flash"
        assert task.provider_id is None

    def test_dict_provider_wins_over_toplevel(self, tmp_path):
        """两种写法同时出现时，model 字典内的 provider 优先"""
        _write_yaml(tmp_path, "t4.yaml", """
name: 优先级
schedule:
  daily: "08:00"
prompt: hello
model:
  id: deepseek-flash
  provider: from-dict
provider: from-top
""")
        task = _load_tasks(tmp_path)["优先级"]
        assert task.provider_id == "from-dict"

    def test_blank_toplevel_provider_ignored(self, tmp_path):
        """顶层 provider 为空串时不生效"""
        _write_yaml(tmp_path, "t5.yaml", """
name: 空provider
schedule:
  daily: "08:00"
prompt: hello
model: deepseek-flash
provider: ""
""")
        task = _load_tasks(tmp_path)["空provider"]
        assert task.provider_id is None


# ============================================================
# 2. Python 脚本 frontmatter
# ============================================================

class TestScriptFrontmatterProvider:
    _SRC_WITH_PROVIDER = '''
"""
name: 脚本A
enabled: true
model: deepseek-flash
provider: deepseek
note: 备注
prompt: 默认提示词
"""

def run(context):
    pass
'''

    _SRC_MODEL_ONLY = '''
"""
name: 脚本B
enabled: true
model: deepseek-flash
"""

def run(context):
    pass
'''

    def test_provider_parsed(self):
        info = _get_script_info(self._SRC_WITH_PROVIDER)
        assert info["model"] == "deepseek-flash"
        assert info["provider"] == "deepseek"

    def test_provider_defaults_to_empty_string(self):
        """未写 provider 时返回空串（由桥接层回落到全局默认）"""
        info = _get_script_info(self._SRC_MODEL_ONLY)
        assert info["model"] == "deepseek-flash"
        assert info["provider"] == ""


# ============================================================
# 3. 脚本运行时 trigger_task
# ============================================================

def _last_json_line(capsys) -> dict:
    lines = [ln for ln in capsys.readouterr().out.strip().splitlines() if ln.strip()]
    assert lines, "trigger_task 未输出任何 JSON 行"
    return json.loads(lines[-1])


class TestTriggerTaskOverrides:
    def test_carries_explicit_model_and_provider(self, capsys):
        ctx = Context(script_name="t", demo_mode=True, default_prompt="dp")
        ctx.trigger_task("目标", "内容", model="deepseek-flash", provider="deepseek")
        payload = _last_json_line(capsys)
        assert payload["type"] == "trigger_task"
        assert payload["target"] == "目标"
        assert payload["model"] == "deepseek-flash"
        assert payload["provider"] == "deepseek"

    def test_omits_keys_when_not_specified(self, capsys):
        """未指定时不携带键，避免用 None 覆盖 frontmatter 配置"""
        ctx = Context(script_name="t", demo_mode=True, default_prompt="dp")
        ctx.trigger_task("目标")
        payload = _last_json_line(capsys)
        assert "model" not in payload
        assert "provider" not in payload
        assert payload["prompt"] == "dp"
