# -*- coding: utf-8 -*-
"""Sortformer 常驻切分服务 — 启动脚本 (nemo_bench env)

用法(项目根目录):
    python backend/scripts/sortformer_server.py
    模型权重路径由环境变量 SORTFORMER_MODEL_PATH 指定（默认 /opt/kinship-models/diar_sortformer_4spk-v1.nemo）

服务说明:
- 端口 127.0.0.1:9799 (HTTP, 仅本地)
- 模型: nemo_bench env 已装 NeMo 2.7.3; 权重 .nemo 需在本地模型目录
   (首次运行请确认该文件存在; 若缺失从 hf-mirror 下载)
- API:
    GET  /health            -> {"ready": bool}
    POST /diarize {"path"}  -> {"ok", "blocks":[{start,end,dur,speaker}], "n_speakers", "speech_ratio"}
- 预览台调用方: backend/routers/preview.py engine=sortformer

备注: A/B demo 用, 与主后端(pyannote 生产链路)并存可切换。
"""
import ast
import json
import os
import time
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.disable(logging.WARNING)

MODEL_PATH = os.environ.get(
    "SORTFORMER_MODEL_PATH", "/opt/kinship-models/diar_sortformer_4spk-v1.nemo"
)
_model = None


def _load_model():
    global _model
    if _model is None:
        from nemo.collections.asr.models import SortformerEncLabelModel
        t0 = time.time()
        _model = SortformerEncLabelModel.restore_from(
            restore_path=MODEL_PATH, map_location="cuda")
        _model.eval()
        print(f"[SortformerSrv] 模型加载完成 ({time.time()-t0:.0f}s)", flush=True)
    return _model


def _diarize(path: str):
    model = _load_model()
    preds = model.diarize(audio=path, batch_size=1)
    # 解析 NeMo 返回: 嵌套 list / str 字面量
    if isinstance(preds, list) and preds and isinstance(preds[0], str):
        raw = preds[0]
        try:
            inner = ast.literal_eval(raw)
        except Exception:
            inner = [x.strip() for x in raw.split(",")]
    elif isinstance(preds, list) and preds and isinstance(preds[0], list):
        inner = preds[0]
    else:
        inner = preds
    blocks = []
    speech_dur = 0.0
    for item in inner:
        parts = None
        if isinstance(item, str):
            parts = item.split()
        elif isinstance(item, (list, tuple)) and len(item) == 3:
            parts = [str(x) for x in item]
        if parts and len(parts) >= 3:
            try:
                s, e = float(parts[0]), float(parts[1])
            except ValueError:
                continue
            blocks.append({"start": round(s, 3), "end": round(e, 3),
                           "dur": round(e - s, 3), "speaker": parts[2]})
            speech_dur += (e - s)
    blocks.sort(key=lambda b: b["start"])
    # 合并同 speaker 的微间隙块(间隙<0.4s)成连续段, 供展示
    merged = []
    for b in blocks:
        if merged and merged[-1]["speaker"] == b["speaker"] and \
                b["start"] - merged[-1]["end"] < 0.4:
            merged[-1]["end"] = b["end"]
            merged[-1]["dur"] = round(merged[-1]["end"] - merged[-1]["start"], 3)
        else:
            merged.append(dict(b))
    spk_set = sorted(set(b["speaker"] for b in merged))
    return {"ok": True, "blocks": merged, "n_speakers": len(spk_set),
            "speech_ratio": round(min(1.0, speech_dur / 60.0), 3)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ready": _model is not None,
                             "model": "sortformer_4spk-v1"})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            ln = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(ln).decode("utf-8"))
            path = data.get("path", "")
            import os
            if not os.path.isfile(path):
                self._send(400, {"ok": False, "error": f"文件不存在: {path}"})
                return
            t0 = time.time()
            result = _diarize(path)
            result["elapsed_s"] = round(time.time() - t0, 2)
            self._send(200, result)
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    print("[SortformerSrv] 预热加载模型...", flush=True)
    _load_model()
    srv = ThreadingHTTPServer(("127.0.0.1", 9799), Handler)
    print("[SortformerSrv] 监听 127.0.0.1:9799", flush=True)
    srv.serve_forever()
