# -*- coding: utf-8 -*-
"""Phi-4-multimodal 推理服务客户端（懒启动 + pidfile 复用）。

与 services/kernel_client.py 同范式但极简: Phi-4 只暴露一个同步 /infer。
- ensure(): 读 state_dir/phi4.pid -> 探活 -> 复用; 否则 spawn tools/phi4_serve.py
  (conda phi4mm 独立环境, 与后端 axeuh-multi-agent 隔离, 加载约 15-20s)。
- infer(wav_path, prompt, start, end): 裁剪 16k 单声道 WAV 内存缓冲 ->
  base64 POST /infer -> dict(text, seconds, ...)。服务不可达抛 Phi4Unavailable。

state 目录: backend/data/phi4_state/  (pid/port/token/log)
spawn python: config CONDAPYTHON_PATH 同级的 phi4mm 环境, 或 env PHI4_PYTHON 覆盖。
"""
import base64
import io
import json
import os
import queue
import secrets
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_SERVE_SCRIPT = _PROJECT_ROOT / "tools" / "phi4_serve" / "serve.py"
_DEFAULT_STATE_DIR = _PROJECT_ROOT / "backend" / "data" / "phi4_state"
_PIDFILE_NAME = "phi4.pid"
_HEALTH_TIMEOUT = 2.0
_SPAWN_WAIT = 90.0        # bnb 量化加载实测 15-20s, 冷缓存放宽到 90s
_LOCK = threading.Lock()


class Phi4Unavailable(RuntimeError):
    pass


def _state_dir() -> Path:
    env = os.environ.get("AXEUH_PHI4_STATE_DIR", "").strip()
    return Path(env) if env else _DEFAULT_STATE_DIR


def _phi4_python() -> str:
    env = os.environ.get("PHI4_PYTHON", "").strip()
    if env and os.path.isfile(env):
        return env
    program_data = os.environ.get("ProgramData", "").strip()
    if program_data:
        default = str(Path(program_data) / "miniconda3" / "envs" / "phi4mm" / "python.exe")
        if os.path.isfile(default):
            return default
    # Linux(未来 Ubuntu 迁移): conda 环境同名直用
    return "python"


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        h = kernel32.OpenProcess(0x1000, False, int(pid))
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(h, ctypes.byref(code)):
                return False
            return code.value == 259
        finally:
            kernel32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _probe_health(port: int) -> bool:
    try:
        r = httpx.get("http://127.0.0.1:%d/health" % port, timeout=_HEALTH_TIMEOUT)
        return r.status_code == 200
    except Exception:
        return False


def _read_pidfile() -> Optional[Dict[str, Any]]:
    p = _state_dir() / _PIDFILE_NAME
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _write_pidfile(data: Dict[str, Any]) -> None:
    d = _state_dir()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / (_PIDFILE_NAME + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, d / _PIDFILE_NAME)


class Phi4Client:
    """单例见 get_phi4_client()。线程安全: ensure 加锁; 推理并发由服务端信号量兜底。"""

    def __init__(self):
        self.base_url = ""
        self.token = ""
        self._connected = False

    # ─── spawn / 复用 ─────────────────────────────

    def available(self) -> bool:
        """非阻塞探活: pidfile -> pid 存活 + /health。不 spawn。"""
        link = _read_pidfile()
        if not link:
            return False
        pid, port = int(link.get("pid") or 0), int(link.get("port") or 0)
        return bool(pid and port and _pid_alive(pid) and _probe_health(port))

    def ensure(self) -> None:
        if self._connected and _probe_health(int(self.base_url.rsplit(":", 1)[-1])):
            return
        with _LOCK:
            if self._connected and _probe_health(int(self.base_url.rsplit(":", 1)[-1])):
                return
            link = _read_pidfile()
            if link:
                pid = int(link.get("pid") or 0)
                port = int(link.get("port") or 0)
                if pid and port and _pid_alive(pid) and _probe_health(port):
                    self.base_url = "http://127.0.0.1:%d" % port
                    self.token = str(link.get("token") or "")
                    self._connected = True
                    return
            self._spawn()

    def _spawn(self) -> None:
        sd = _state_dir()
        sd.mkdir(parents=True, exist_ok=True)
        token = os.environ.get("AXEUH_PHI4_TOKEN", "").strip() or secrets.token_urlsafe(32)
        env = dict(os.environ)
        env["PHI4_TOKEN"] = token
        env["PHI4_STATE_DIR"] = str(sd)
        env.setdefault("PHI4_MODEL_DIR", "/opt/kinship-models/Phi-4-multimodal-instruct")
        err_log = open(sd / "phi4.stderr.log", "ab")
        try:
            proc = subprocess.Popen(
                [_phi4_python(), str(_SERVE_SCRIPT)],
                cwd=str(_PROJECT_ROOT / "tools"), env=env,
                stdout=subprocess.PIPE, stderr=err_log,
            )
        except OSError as e:
            raise Phi4Unavailable("无法启动 Phi-4 服务(%s): %s" % (_phi4_python(), e))
        finally:
            err_log.close()
        # 等握手行 JSON {"port":..,"pid":..}(跳过 "[PHI4] loading" 等前缀噪声)
        assert proc.stdout is not None
        q: "queue.Queue[bytes]" = queue.Queue()

        def _pump():
            try:
                while True:
                    ln = proc.stdout.readline()
                    if not ln:
                        q.put(b"")
                        return
                    q.put(ln)
            except Exception:
                q.put(b"")

        threading.Thread(target=_pump, daemon=True).start()
        deadline = time.time() + _SPAWN_WAIT
        while time.time() < deadline:
            try:
                line = q.get(timeout=max(0.1, deadline - time.time()))
            except queue.Empty:
                break
            if line == b"":
                break
            try:
                hs = json.loads(line.decode("utf-8").strip())
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(hs, dict):
                continue
            port = int(hs.get("port") or 0)
            if port and _probe_health(port):
                self.base_url = "http://127.0.0.1:%d" % port
                self.token = token
                self._connected = True
                _write_pidfile({"pid": proc.pid, "port": port, "token": token})
                return
            break
        if proc.poll() is None:
            proc.terminate()
        raise Phi4Unavailable(
            "Phi-4 服务启动失败(握手未完成, 冷加载可能超时), 详见 %s"
            % (sd / "phi4.stderr.log"))

    # ─── 推理 ────────────────────────────────────

    def infer_wav_bytes(self, wav_bytes: bytes, prompt: str,
                        max_new_tokens: int = 512, timeout: float = 180.0) -> Dict[str, Any]:
        self.ensure()
        try:
            r = httpx.post(self.base_url + "/infer",
                           headers={"Authorization": "Bearer " + self.token},
                           json={"wav_b64": base64.b64encode(wav_bytes).decode("ascii"),
                                 "prompt": prompt, "max_new_tokens": max_new_tokens},
                           timeout=timeout)
        except httpx.HTTPError as e:
            self._connected = False
            raise Phi4Unavailable("Phi-4 请求失败: %s" % e)
        if r.status_code == 401:
            self._connected = False
            raise Phi4Unavailable("Phi-4 token 不符(服务可能被重启)")
        if r.status_code != 200:
            try:
                detail = (r.json().get("error") or "")[:300]
            except Exception:
                detail = r.text[:200]
            raise Phi4Unavailable("Phi-4 HTTP %d: %s" % (r.status_code, detail))
        return r.json()


class _LineReader:
    """后台线程读一行, 主线程带超时 join(Windows 管道 readline 不可 select)。"""

    def __init__(self, stream):
        self._stream = stream
        self._result: Optional[bytes] = None
        self._t: Optional[threading.Thread] = None

    def _reader(self):
        try:
            self._result = self._stream.readline()
        except Exception:
            self._result = b""

    def readline(self, timeout: float) -> bytes:
        if self._result is not None:
            return self._result
        if self._t is None:
            self._t = threading.Thread(target=self._reader, daemon=True)
            self._t.start()
        self._t.join(timeout)
        return self._result if self._result is not None else b""


_client: Optional[Phi4Client] = None


def get_phi4_client() -> Phi4Client:
    global _client
    if _client is None:
        _client = Phi4Client()
    return _client


# ─── WAV 裁剪工具(纯 io, 无 ML; 供 router 复用) ─────────────

def crop_wav_16k_mono(src_path: str, start: float, end: float) -> bytes:
    """从 wav/flac 裁 [start,end) 返回 16k/mono/PCM16 WAV 字节。

    soundfile 直读(libsndfile 原生支持 flac seek), 多声道取均值;
    重采样兜底交给服务端 processor(感知链存储恒 16k, 正常不触发)。
    """
    import soundfile as sf
    try:
        info = sf.info(src_path)
    except Exception as e:
        raise Phi4Unavailable("无法读取音频(%s): %s" % (os.path.basename(src_path), e))
    sr = int(info.samplerate or 16000)
    a = int(max(0.0, start) * sr)
    b = min(int(info.frames), int(end * sr))
    if b <= a:
        raise Phi4Unavailable("区间为空: start=%.1f end=%.1f 总长=%.1fs"
                              % (start, end, info.frames / max(sr, 1)))
    audio, sr2 = sf.read(src_path, start=a, stop=b, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr2 != 16000:
        import soxr
        audio = soxr.resample(audio, sr2, 16000).astype("float32")
        sr2 = 16000
    out = io.BytesIO()
    sf.write(out, audio, sr2, format="WAV", subtype="PCM_16")
    return out.getvalue()


def probe_duration(src_path: str) -> float:
    """音频总时长(秒), 失败返回 0。仅读头, 不载数据。"""
    import soundfile as sf
    try:
        info = sf.info(src_path)
        return round(info.frames / max(int(info.samplerate or 1), 1), 1)
    except Exception:
        return 0.0
