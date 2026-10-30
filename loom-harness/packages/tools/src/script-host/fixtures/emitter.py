#---
#enabled: true
#name: emitter
#lang: python
#respawn: true
#---
# 逐事件发射 fixture：fact / deliver / dispatch / heartbeat 各一行 JSON，
# 之后保持存活，由宿主 stop() 走进程组终止路径（顺带验证杀组）。
import json
import time


def emit(**fields):
    print(json.dumps(fields, ensure_ascii=False), flush=True)


emit(type="fact", key="cpu", value=0.42)
emit(type="deliver", channel="main", text="挂载脚本事件协议测试")
emit(type="dispatch", workflow="data-check", dedup_key="d1")
emit(type="heartbeat", alive=True)

while True:
    time.sleep(3600)
