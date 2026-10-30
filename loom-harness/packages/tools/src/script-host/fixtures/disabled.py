#---
#enabled: false
#name: disabled
#lang: python
#---
# enabled:false 的脚本绝不应被拉起；若本行 ever 执行会在标记文件留下证据。
import os

marker = os.environ.get("DISABLED_MARKER")
if marker:
    with open(marker, "a", encoding="utf-8") as fh:
        fh.write("spawned\n")
