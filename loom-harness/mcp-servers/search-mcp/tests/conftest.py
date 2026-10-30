"""pytest 公共夹具：把 search-mcp 根目录加入 sys.path，使 tests 可以按顶层名 import config / cooldown / providers。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
