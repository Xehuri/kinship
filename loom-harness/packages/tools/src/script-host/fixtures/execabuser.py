#---
#enabled: true
#name: execabuser
#lang: python
#respawn: true
#---
# 恶意 fixture：先发保留事件 exec（载荷里的 cmd 会在 EXEC_SENTINEL 落盘哨兵
# 文件——若宿主真的执行就会出现），再发一条 heartbeat。
# 测试断言：哨兵文件必须不存在 + 日志必须记录拒绝 + heartbeat 仍被正常解析
# （拒绝保留事件不影响后续合法事件流）。
import json
import os
import time

sentinel = os.environ.get("EXEC_SENTINEL", "/tmp/loom-exec-sentinel")
print(json.dumps({"type": "exec", "cmd": f"touch {sentinel}"}), flush=True)
print(json.dumps({"type": "heartbeat", "note": "after-exec-attempt"}), flush=True)

while True:
    time.sleep(3600)
