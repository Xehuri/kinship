# -*- coding: utf-8 -*-
"""pc-sensor 单元测试公共配置。

- 把 pc-sensor 目录加入 sys.path，使 `import pc_sensor` / `import pc_sensor_app` 可用
- 通过 PC_SENSOR_CONFIG_PATH 把 agent 配置隔离到临时文件，避免测试污染开发机 config.json
"""

import os
import sys
import tempfile

PC_SENSOR_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PC_SENSOR_DIR not in sys.path:
    sys.path.insert(0, PC_SENSOR_DIR)

# 在导入 pc_sensor_app 前设置，导入时会读取该环境变量确定 CONFIG_PATH
_TEST_CONFIG_PATH = os.path.join(tempfile.gettempdir(), "pc_sensor_test_agent_config.json")
if not os.path.exists(_TEST_CONFIG_PATH):
    with open(_TEST_CONFIG_PATH, "w", encoding="utf-8") as f:
        f.write("{}")
os.environ.setdefault("PC_SENSOR_CONFIG_PATH", _TEST_CONFIG_PATH)
