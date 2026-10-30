#---
#enabled: true
#name: crasher
#lang: python
#respawn: true
#---
# 每次被拉起在 CRASH_MARKER 文件追加一行（记录 pid），随后非零退出，
# 用于验证 respawn + 指数退避序列。CRASH_MARKER 由宿主 env 注入。
import os
import sys

marker = os.environ.get("CRASH_MARKER")
if marker:
    with open(marker, "a", encoding="utf-8") as fh:
        fh.write(f"launch pid={os.getpid()}\n")

sys.exit(3)
