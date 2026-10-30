#---
#enabled: true
#name: cleanexit
#lang: python
#respawn: true
#---
# 发一条 heartbeat 后以退出码 0 干净收尾。
# 即便 respawn: true，宿主也必须把"干净退出"视为正常结束、不再重拉。
import json

print(json.dumps({"type": "heartbeat", "note": "exiting-clean"}), flush=True)
