"""config.load_config 的契约测试（harness 副本：启动宽容语义）。

覆盖：正常加载、SEARCH_MCP_CONFIG 覆盖、env key 覆盖、default_provider 非法、
零 key、文件缺失、坏 JSON。
与原版差异：宽容版对"配置问题"只打 stderr 中文警告并回落默认值，不再
SystemExit —— 相应断言全部改为"不抛 + 返回默认/空 key + capsys 验证警告"。
"""

import json

import pytest

from config import load_config

# 测试期间必须隔离的环境变量，防止本机真实配置干扰
_ENV_KEYS = [
    "SEARCH_MCP_CONFIG",
    "SEARCH_MCP_TAVILY_KEY",
    "SEARCH_MCP_EXA_KEY",
    "SEARCH_MCP_DEFAULT_PROVIDER",
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _write_cfg(tmp_path, data, name="config.json"):
    p = tmp_path / name
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return p


def _base_cfg(**overrides):
    data = {
        "default_provider": "tavily",
        "fallback_enabled": True,
        "request_deadline_s": 55,
        "providers": {
            "tavily": {"api_key": "file-tavily-key"},
            "exa": {"api_key": "file-exa-key", "monthly_budget_usd": 8.5},
        },
    }
    data.update(overrides)
    return data


def test_正常加载字段映射(tmp_path):
    """完整 config.json → Config 各字段按规格映射。"""
    path = _write_cfg(tmp_path, _base_cfg())
    cfg = load_config(str(path))
    assert cfg.default_provider == "tavily"
    assert cfg.fallback_enabled is True
    assert cfg.request_deadline_s == 55
    assert cfg.tavily_key == "file-tavily-key"
    assert cfg.exa_key == "file-exa-key"
    assert cfg.exa_monthly_budget_usd == 8.5
    assert cfg.config_path == path


def test_可选字段默认值(tmp_path):
    """缺省字段：exa 预算默认 10.0，fallback 默认开，deadline 默认 55。"""
    data = {"providers": {"tavily": {"api_key": "k1"}}}
    path = _write_cfg(tmp_path, data)
    cfg = load_config(str(path))
    assert cfg.default_provider == "tavily"
    assert cfg.fallback_enabled is True
    assert cfg.request_deadline_s == 55
    assert cfg.exa_monthly_budget_usd == 10.0
    assert cfg.exa_key is None


def test_SEARCH_MCP_CONFIG环境变量指定路径(tmp_path, monkeypatch):
    """无显式参数时，env SEARCH_MCP_CONFIG 指向的文件生效。"""
    env_file = _write_cfg(tmp_path, _base_cfg(default_provider="exa"), name="env.json")
    monkeypatch.setenv("SEARCH_MCP_CONFIG", str(env_file))
    cfg = load_config()
    assert cfg.default_provider == "exa"
    assert cfg.config_path == env_file


def test_显式参数优先于SEARCH_MCP_CONFIG(tmp_path, monkeypatch):
    """显式 path 参数 > env SEARCH_MCP_CONFIG。"""
    env_file = _write_cfg(tmp_path, _base_cfg(default_provider="exa"), name="env.json")
    arg_file = _write_cfg(tmp_path, _base_cfg(default_provider="tavily"), name="arg.json")
    monkeypatch.setenv("SEARCH_MCP_CONFIG", str(env_file))
    cfg = load_config(str(arg_file))
    assert cfg.default_provider == "tavily"
    assert cfg.config_path == arg_file


def test_环境变量覆盖key与默认提供商(tmp_path, monkeypatch):
    """SEARCH_MCP_TAVILY_KEY / EXA_KEY / DEFAULT_PROVIDER 覆盖文件值。"""
    path = _write_cfg(tmp_path, _base_cfg())
    monkeypatch.setenv("SEARCH_MCP_TAVILY_KEY", "env-tavily")
    monkeypatch.setenv("SEARCH_MCP_EXA_KEY", "env-exa")
    monkeypatch.setenv("SEARCH_MCP_DEFAULT_PROVIDER", "exa")
    cfg = load_config(str(path))
    assert cfg.tavily_key == "env-tavily"
    assert cfg.exa_key == "env-exa"
    assert cfg.default_provider == "exa"


def test_非法default_provider警告并回落默认(tmp_path, capsys):
    """宽容版：非法 default_provider 不抛，回落 'tavily'，警告走 stderr。"""
    path = _write_cfg(tmp_path, _base_cfg(default_provider="google"))
    cfg = load_config(str(path))
    assert cfg.default_provider == "tavily"
    # key 不受影响：仍正常带回
    assert cfg.tavily_key == "file-tavily-key"
    err = capsys.readouterr().err
    # 中文警告含非法值；不得泄露 api key 明文
    assert "default_provider" in err
    assert "google" in err
    assert "file-tavily-key" not in err


def test_env非法default_provider同样回落(tmp_path, monkeypatch, capsys):
    """宽容版：env 注入的非法 default_provider 同样警告 + 回落 tavily。"""
    path = _write_cfg(tmp_path, _base_cfg())
    monkeypatch.setenv("SEARCH_MCP_DEFAULT_PROVIDER", "bing")
    cfg = load_config(str(path))
    assert cfg.default_provider == "tavily"
    assert "bing" in capsys.readouterr().err


def test_两个key全空警告但不拦启动(tmp_path, capsys):
    """宽容版：文件存在但零 key → 正常返回（key 归一 None），stderr 中文警告。"""
    data = {
        "providers": {
            "tavily": {"api_key": None},
            "exa": {"api_key": ""},
        }
    }
    path = _write_cfg(tmp_path, data)
    cfg = load_config(str(path))
    assert cfg.tavily_key is None
    assert cfg.exa_key is None
    assert cfg.default_provider == "tavily"
    err = capsys.readouterr().err
    assert "两个提供商均未配置 api_key" in err


def test_完全无providers警告但不拦启动(tmp_path, capsys):
    """宽容版：无 providers 段 → 零 key 警告 + 默认配置返回。"""
    path = _write_cfg(tmp_path, {"default_provider": "tavily"})
    cfg = load_config(str(path))
    assert cfg.tavily_key is None
    assert cfg.exa_key is None
    err = capsys.readouterr().err
    assert "两个提供商均未配置 api_key" in err


def test_文件缺失警告并返回全默认(tmp_path, capsys):
    """宽容版：文件不存在 → 不抛，返回全默认 Config，stderr 警告含路径与指引。"""
    missing = tmp_path / "nope" / "config.json"
    cfg = load_config(str(missing))
    assert cfg.default_provider == "tavily"
    assert cfg.fallback_enabled is True
    assert cfg.request_deadline_s == 55.0
    assert cfg.tavily_key is None
    assert cfg.exa_key is None
    assert cfg.exa_monthly_budget_usd == 10.0
    assert cfg.config_path == missing
    err = capsys.readouterr().err
    assert "未找到配置文件" in err
    assert str(missing) in err
    assert "config.example.json" in err


def test_文件缺失但env注入key仍可用(tmp_path, monkeypatch, capsys):
    """宽容版：文件缺失警告不影响 env 注入 key 的覆盖路径。"""
    missing = tmp_path / "nope" / "config.json"
    monkeypatch.setenv("SEARCH_MCP_TAVILY_KEY", "env-tavily")
    cfg = load_config(str(missing))
    assert cfg.tavily_key == "env-tavily"
    # 已注入 key，不再叠加"零 key"警告
    err = capsys.readouterr().err
    assert "两个提供商均未配置 api_key" not in err


def test_坏JSON警告后按空配置继续(tmp_path, capsys):
    """宽容版：JSON 语法非法 → 不抛，按空配置返回默认值，stderr 说明原因。"""
    p = tmp_path / "config.json"
    p.write_text("{not valid json", encoding="utf-8")
    cfg = load_config(str(p))
    assert cfg.tavily_key is None
    assert cfg.default_provider == "tavily"
    err = capsys.readouterr().err
    assert "JSON" in err
    assert str(p) in err


def test_顶层非对象警告后按空配置继续(tmp_path, capsys):
    """宽容版：顶层是数组等非对象 → 警告 + 空配置，不抛。"""
    p = tmp_path / "config.json"
    p.write_text("[1, 2]", encoding="utf-8")
    cfg = load_config(str(p))
    assert cfg.tavily_key is None
    err = capsys.readouterr().err
    assert "JSON 对象" in err


def test_非数字deadline警告并回落默认(tmp_path, capsys):
    """宽容版：request_deadline_s 非数字 → 警告 + 回落 55.0，不抛。"""
    path = _write_cfg(tmp_path, _base_cfg(request_deadline_s="fast"))
    cfg = load_config(str(path))
    assert cfg.request_deadline_s == 55.0
    err = capsys.readouterr().err
    assert "request_deadline_s" in err


def test_警告绝不写stdout(tmp_path, capsys):
    """stdio 协议红线：缺文件警告只能出现在 stderr，stdout 必须为空。"""
    missing = tmp_path / "nope" / "config.json"
    load_config(str(missing))
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.startswith("search-mcp:")
