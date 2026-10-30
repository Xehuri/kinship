#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""[DEPRECATED 2026-09-24 / 外层 Wave B4] 负样本审查网页工具

状态：写回功能已停用（数据源已迁内核 state-dir，本工具写外层本地文件 = 分裂脑）。

背景与处置：
  - 本工具的候选筛选数据源是 perception.jsonl（不是 cohort 文件），属外层
    业务 IO，**只读审查 + 音频试听功能仍可用**（离线人工复核候选负样本）。
  - 但「导出确认样本」写回的 `ai/data/cohort_verified.jsonl`：
      (1) 外层 CohortManager 的 verified > active > legacy 加载优先级在内核
          侧不存在——内核 load_cohort 只读 cohort_active.jsonl / cohort.jsonl，
          不认 verified；生产采集自 9-22 起已绕外层走内核，写此文件对现行链路
          **零效果**（死机制）；
      (2) 且本工具导出的 embedding 恒为 `[]`（旧实现即如此，无向量提取），
          外层 _load 会过滤非 192 维/全零 embedding，历史上也从未真正入池。
  - 因此 `_handle_select` 写回已停用并返回 501，不再落任何 cohort 文件。
  - 正式处置：待内核提供 additive 的 cohort review 写回端点（缺口报告已登记，
    建议形状 POST /v1/voiceprint/cohort/review {ref, reviewed, rejected}
    ——ref 定位 audit 行，写回 reviewed/rejected 标志位；届时改用该端点，
    或直接用 vaudit 审计台 + compact 语义替代本工具）。
  - 过渡期 cohort 人工审查请用 frontend/vaudit/ 审计台（已切内核 audit 端点，
    展示 reviewed/rejected 徽标）；压缩时 `rejected=true` 条目由内核 compact
    过滤（cohort_compact_facts.dropped_rejected）。

以下为原工具说明：
解析 perception.jsonl 中的语音段，筛选候选负样本，提供 Web 审查界面。
"""

import json
import os
import re
import sys
import threading
import webbrowser
from datetime import date
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """多线程 HTTP 服务器，支持并发请求"""
    daemon_threads = True

import soundfile as sf

# ============================================================
# 配置
# ============================================================
MAX_SIM = 0.05            # 旧格式 (cosine similarity)
MAX_ASNORM_SIM = 0.0      # 新格式 (AS-Norm 分数，负值=非本人)
MIN_DURATION = 3.0         # 最短时长（秒）
MIN_TEXT_LEN = 5            # 最少文字长度

AI_DATA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "ai", "data")
)
OUTPUT_DIR = os.environ.get("COHORT_REVIEW_OUTPUT_DIR", "/opt/kinship/cohort-review")
# [DEPRECATED B4] 写回已停用，本路径不再写入任何文件（保留仅作历史指引）
EXPORT_PATH = os.path.join(AI_DATA_DIR, "cohort_verified.jsonl")
PORT = 18890


# ============================================================
# 数据加载与筛选
# ============================================================
def find_latest_perception():
    """找到最新的包含 perception.jsonl 的日期目录"""
    base = AI_DATA_DIR
    if not os.path.isdir(base):
        print(f"[错误] ai/data 目录不存在: {base}")
        sys.exit(1)
    today_str = date.today().isoformat()

    # 先看 daily/ 目录（新位置）
    daily_base = os.path.join(base, "daily")
    if os.path.isdir(daily_base):
        today_path = os.path.join(daily_base, today_str, "perception.jsonl")
        if os.path.isfile(today_path):
            return today_path, today_str
        # 倒序遍历 daily/ 子目录
        dirs = [d for d in os.listdir(daily_base) if re.match(r"^\d{4}-\d{2}-\d{2}$", d) and os.path.isdir(os.path.join(daily_base, d))]
        for d in sorted(dirs, reverse=True):
            fp = os.path.join(daily_base, d, "perception.jsonl")
            if os.path.isfile(fp):
                return fp, d

    # 回退：旧位置 ai/data/{date}/
    today_path = os.path.join(base, today_str)
    if os.path.isdir(today_path) and os.path.isfile(os.path.join(today_path, "perception.jsonl")):
        return os.path.join(today_path, "perception.jsonl"), today_str
    dirs = [d for d in os.listdir(base) if re.match(r"^\d{4}-\d{2}-\d{2}$", d) and os.path.isdir(os.path.join(base, d))]
    dirs.sort(reverse=True)
    for d in dirs:
        p = os.path.join(base, d, "perception.jsonl")
        if os.path.isfile(p):
            return p, d
    print("[错误] 未找到任何 perception.jsonl 文件")
    sys.exit(1)


def load_candidates(perception_path, date_str):
    """解析 perception.jsonl，筛选候选负样本。
    兼容两种格式:
      - 旧格式: segments[].voiceprint_sim (cosine 相似度, 0~1)
      - 新格式: segs[].vp.sim (AS-Norm 分数, -1~1, 负值=非本人)
    """
    base_dir = os.path.dirname(perception_path)  # ai/data/{date}/
    data_root = AI_DATA_DIR
    candidates = []
    errors = []

    with open(perception_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") != "voice":
                continue

            # ── 探测格式 ──
            segs_new = d.get("segs")       # 新格式: segs[]
            segs_old = d.get("segments")   # 旧格式: segments[]
            tag = d.get("tag", "")

            audio_rel = d.get("audio", "")
            if audio_rel:
                if os.path.isabs(audio_rel):
                    audio_full = audio_rel
                else:
                    audio_full = os.path.normpath(os.path.join(data_root, audio_rel))
            else:
                # 旧格式可能没有 audio 字段（回退到日期目录）
                audio_full = ""

            t = d.get("t", "")

            # ── 新格式处理 ──
            if segs_new:
                # 过滤整分钟包裹：同一条 voice 只有 1 个 seg 且 dur>=55s → 跳过
                if len(segs_new) == 1:
                    s0 = segs_new[0]
                    if (s0.get("end", 0) - s0.get("start", 0)) >= 55:
                        continue

                for seg in segs_new:
                    text = seg.get("text", "").strip()
                    if not text or "<|nospeech|>" in text or "<|Event_UNK|>" in text:
                        continue
                    if len(text) < MIN_TEXT_LEN:
                        continue

                    vp = seg.get("vp")
                    if not vp:
                        continue
                    sim = vp.get("sim", 0)
                    if sim >= MAX_ASNORM_SIM:  # 新格式: 正分数=本人/匹配，只收负的
                        continue

                    start = seg.get("start", 0)
                    end = seg.get("end", 0)
                    dur = end - start
                    if dur < MIN_DURATION:
                        continue

                    candidates.append({
                        "text": text,
                        "sim": round(sim, 4),
                        "t": t,
                        "start": start,
                        "end": end,
                        "dur": round(dur, 2),
                        "speech_prob": 1.0,
                        "speaker": vp.get("spk", ""),
                        "audio_path": audio_full,
                        "date": date_str,
                    })
                continue  # 新格式已处理，跳过旧格式逻辑

            # ── 旧格式处理 ──
            if segs_old:
                for seg in segs_old:
                    text = seg.get("text", "").strip()
                    if not text or "<|nospeech|>" in text or "<|Event_UNK|>" in text:
                        continue
                    sim = seg.get("voiceprint_sim", 0)
                    if sim >= MAX_SIM:
                        continue
                    start = seg.get("start", 0)
                    end = seg.get("end", 0)
                    dur = end - start
                    if dur < MIN_DURATION:
                        continue
                    if len(text) < MIN_TEXT_LEN:
                        continue
                    speech_prob = seg.get("speech_prob", 0)

                    if not audio_full:
                        # 旧格式: audio 路径从额外字段解析
                        pass  # audio_full 已在上面处理

                    candidates.append({
                        "text": text,
                        "sim": round(sim, 4),
                        "t": t,
                        "start": start,
                        "end": end,
                        "dur": round(dur, 2),
                        "speech_prob": round(speech_prob, 3) if isinstance(speech_prob, (int, float)) else 0,
                        "speaker": seg.get("voiceprint_speaker", ""),
                        "audio_path": audio_full,
                        "date": date_str,
                    })

    return candidates


def crop_audio(candidates):
    """裁剪音频段并保存为临时 WAV 文件"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 清理旧文件
    for fname in os.listdir(OUTPUT_DIR):
        if fname.endswith(".wav"):
            try:
                os.remove(os.path.join(OUTPUT_DIR, fname))
            except OSError:
                pass

    result = []
    for i, c in enumerate(candidates):
        idx = i + 1
        out_path = os.path.join(OUTPUT_DIR, f"{idx}.wav")
        audio_path = c.pop("audio_path")  # remove from dict, we only need id

        try:
            if not os.path.isfile(audio_path):
                print(f"  [跳过] 音频不存在: {audio_path}")
                continue

            wav, sr = sf.read(audio_path)
            if wav.ndim > 1:
                wav = wav.mean(axis=1)

            start_s = int(c["start"] * sr)
            end_s = int(c["end"] * sr)
            # 边界安全
            if start_s >= len(wav):
                print(f"  [跳过] start 超出音频长度: {audio_path}")
                continue
            end_s = min(end_s, len(wav))
            if end_s <= start_s:
                print(f"  [跳过] 空段: {audio_path}")
                continue

            segment = wav[start_s:end_s]
            sf.write(out_path, segment, sr)
            result.append({"id": idx, **c, "audio_file": f"{idx}.wav"})
        except Exception as e:
            print(f"  [错误] 裁剪失败 {audio_path}: {e}")

    return result


# ============================================================
# HTTP 服务器
# ============================================================
class CohortReviewHandler(BaseHTTPRequestHandler):
    # 类级别共享数据
    items = []  # 候选列表
    lock = threading.Lock()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            self._serve_html()
        elif path == "/api/list":
            self._serve_list()
        elif path.startswith("/audio/"):
            self._serve_audio(path)
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/select":
            self._handle_select()
        else:
            self._send_json({"error": "not found"}, 404)

    def _serve_html(self):
        html = self._build_html()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def _serve_list(self):
        with self.lock:
            data = json.dumps(self.items, ensure_ascii=False)
        self._send_json(data)

    def _serve_audio(self, path):
        fname = os.path.basename(path)
        filepath = os.path.join(OUTPUT_DIR, fname)
        if not os.path.isfile(filepath):
            self._send_json({"error": "audio not found"}, 404)
            return

        file_size = os.path.getsize(filepath)
        range_header = self.headers.get("Range")

        if range_header:
            match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if match:
                start = int(match.group(1))
                end = match.group(2)
                end = int(end) if end else file_size - 1
                length = end - start + 1

                self.send_response(206)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(length))
                self.end_headers()

                with open(filepath, "rb") as f:
                    f.seek(start)
                    self.wfile.write(f.read(length))
                return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(file_size))
        self.end_headers()
        with open(filepath, "rb") as f:
            self.wfile.write(f.read())

    def _handle_select(self):
        # [DEPRECATED B4] 写回已停用：cohort 唯一真相源在内核 state-dir，
        # 本工具无向量提取能力，写外层文件既不合法也无效果（详见文件头说明）。
        content_len = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(content_len))
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, 400)
            return
        self._send_json({
            "status": "disabled",
            "selected_count": len(data.get("selected", []) or []),
            "rejected_count": len(data.get("rejected", []) or []),
            "written": 0,
            "message": ("写回功能已停用（B4: cohort 真相源迁内核 state-dir，"
                        "内核暂无 review 写回端点——见缺口报告）。"
                        "过渡期请使用 /vaudit/ 审计台。"),
        }, 501)

    def _send_json(self, data, code=200):
        if isinstance(data, str):
            payload = data
        else:
            payload = json.dumps(data, ensure_ascii=False)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def log_message(self, format, *args):
        """静默日志，只记录非静态文件请求"""
        if not args[0].startswith("GET /audio/") and args[0] != "GET /api/list":
            super().log_message(format, *args)

    def _build_html(self):
        return HTML_TEMPLATE


# ============================================================
# HTML 模板（内嵌在 Python 中）
# ============================================================
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>负样本审查 - Cohort Review</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#000;--card:#1c1c1e;--text:#fff;--text-secondary:#98989e;--border:#2c2c2e;--accent:#0a84ff;--accent-hover:#409cff;--danger:#ff453a;--success:#30d158;--playing-bg:#1a2a3a;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
body{background:var(--bg);color:var(--text);min-height:100vh}
.toolbar{position:sticky;top:0;z-index:100;background:rgba(0,0,0,.92);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:12px 16px}
.toolbar-inner{max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.toolbar h1{font-size:18px;font-weight:600;margin-right:auto}
.toolbar .stats{font-size:13px;color:var(--text-secondary);display:flex;gap:16px}
.toolbar .stats span{white-space:nowrap}
.toolbar .stats .num{color:var(--text);font-weight:500}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;font-size:13px;font-weight:500;border:none;cursor:pointer;transition:all .15s ease}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{background:var(--card);color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{background:#2c2c2e}
.btn-danger{background:var(--danger);color:#fff}
.btn-success{background:var(--success);color:#000}
.btn:disabled{opacity:.4;cursor:not-allowed}
.container{max-width:1200px;margin:0 auto;padding:16px}
.empty-state{text-align:center;padding:80px 20px;color:var(--text-secondary)}
.empty-state p{font-size:16px;margin-bottom:8px}
.empty-state .sub{font-size:13px}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;font-weight:500;color:var(--text-secondary);border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:57px;background:rgba(0,0,0,.95);z-index:10}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.03)}
tr.playing td{background:var(--playing-bg)}
tr.playing .play-btn{background:var(--accent);color:#fff}
.col-check{width:36px;text-align:center}
.col-id{width:40px;color:var(--text-secondary);font-weight:500;text-align:center}
.col-play{width:40px;text-align:center}
.col-text{min-width:180px;max-width:400px;word-break:break-all}
.col-text .truncated{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.col-meta{white-space:nowrap}
.sim-bad{color:var(--danger)}
.sim-ok{color:#ff9f0a}
.sim-good{color:var(--success)}
.play-btn{width:30px;height:30px;border-radius:50%;border:none;background:var(--card);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s}
.play-btn:hover{background:#3a3a3c}
.play-btn svg{width:14px;height:14px;fill:currentColor}
.checkbox-custom{width:18px;height:18px;border-radius:4px;border:2px solid var(--border);background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s;position:relative;appearance:none;-webkit-appearance:none}
.checkbox-custom:checked{background:var(--accent);border-color:var(--accent)}
.checkbox-custom:checked::after{content:'';width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);position:absolute;top:2px}
.sp-prob{display:inline-block;width:44px;text-align:right;font-variant-numeric:tabular-nums}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card);color:var(--text);padding:12px 24px;border-radius:12px;border:1px solid var(--border);font-size:14px;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
@media(max-width:640px){
.toolbar{padding:10px 12px}
.toolbar h1{font-size:16px;width:100%;margin-bottom:4px}
.toolbar .stats{gap:10px;font-size:12px}
.container{padding:8px}
td,th{padding:8px 6px}
.col-text{max-width:160px;min-width:100px}
table{font-size:12px}
}
</style>
</head>
<body>

<div class="toolbar">
  <div class="toolbar-inner">
    <h1>负样本审查</h1>
    <div class="stats">
      <span>总数 <span class="num" id="totalCount">0</span></span>
      <span>已选 <span class="num" id="selectedCount">0</span></span>
    </div>
    <button class="btn btn-secondary" onclick="selectAll()">全选</button>
    <button class="btn btn-secondary" onclick="deselectAll()">取消全选</button>
    <button class="btn btn-success" onclick="exportSelected()" id="exportBtn">导出确认样本</button>
  </div>
</div>

<div class="container">
  <div class="table-wrap">
    <table id="candidateTable">
      <thead>
        <tr>
          <th class="col-check"></th>
          <th class="col-id">#</th>
          <th class="col-play"></th>
          <th>时间</th>
          <th>ASR文本</th>
          <th>时长</th>
          <th>相似度</th>
          <th>语音概率</th>
        </tr>
      </thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
  <div class="empty-state" id="emptyState" style="display:none">
    <p>没有候选负样本</p>
    <p class="sub">检查 perception.jsonl 是否包含符合条件的语音段</p>
  </div>
</div>

<div class="toast" id="toast"></div>

<audio id="audioPlayer" preload="none" style="display:none"></audio>

<script>
let items = [];
let currentPlaying = null;
const audioPlayer = document.getElementById('audioPlayer');
const tbody = document.getElementById('tableBody');
const emptyState = document.getElementById('emptyState');
const totalCount = document.getElementById('totalCount');
const selectedCount = document.getElementById('selectedCount');
const toast = document.getElementById('toast');
const exportBtn = document.getElementById('exportBtn');

function showToast(msg, dur) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), dur || 2500);
}

function formatTime(t) { return t; }

function simClass(sim) {
  if (sim < 0.01) return 'sim-bad';
  if (sim < 0.03) return 'sim-ok';
  return 'sim-good';
}

function truncateText(text) {
  if (text.length > 60) return text.slice(0, 60) + '...';
  return text;
}

function render() {
  if (items.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    totalCount.textContent = '0';
    selectedCount.textContent = '0';
    return;
  }
  emptyState.style.display = 'none';

  let html = '';
  const selected = new Set(getSelectedIds());
  for (const item of items) {
    html += '<tr' + (currentPlaying === item.id ? ' class="playing"' : '') + '>';
    html += '<td class="col-check"><input type="checkbox" class="checkbox-custom" data-id="' + item.id + '"' + (selected.has(item.id) ? ' checked' : '') + ' onchange="updateCount()"></td>';
    html += '<td class="col-id">' + item.id + '</td>';
    html += '<td class="col-play"><button class="play-btn" data-id="' + item.id + '" onclick="togglePlay(' + item.id + ')" title="播放/暂停"><svg viewBox="0 0 24 24">' + (currentPlaying === item.id ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M8 5v14l11-7z"/>') + '</svg></button></td>';
    html += '<td class="col-meta">' + formatTime(item.t) + '</td>';
    html += '<td class="col-text"><div class="truncated" title="' + item.text.replace(/"/g,'&quot;') + '">' + item.text + '</div></td>';
    html += '<td class="col-meta">' + item.dur.toFixed(1) + 's</td>';
    html += '<td class="col-meta ' + simClass(item.sim) + '">' + item.sim.toFixed(4) + '</td>';
    html += '<td class="col-meta"><span class="sp-prob">' + (item.speech_prob * 100).toFixed(1) + '%</span></td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;
  updateCount();
}

function getSelectedIds() {
  const ids = [];
  const cbs = document.querySelectorAll('#tableBody .checkbox-custom');
  for (const cb of cbs) {
    if (cb.checked) ids.push(parseInt(cb.dataset.id));
  }
  return ids;
}

function updateCount() {
  const ids = getSelectedIds();
  totalCount.textContent = items.length;
  selectedCount.textContent = ids.length;
  exportBtn.disabled = ids.length === 0;
}

function selectAll() {
  const cbs = document.querySelectorAll('#tableBody .checkbox-custom');
  for (const cb of cbs) cb.checked = true;
  updateCount();
}

function deselectAll() {
  const cbs = document.querySelectorAll('#tableBody .checkbox-custom');
  for (const cb of cbs) cb.checked = false;
  updateCount();
}

function togglePlay(id) {
  if (currentPlaying === id) {
    audioPlayer.pause();
    currentPlaying = null;
    render();
    return;
  }

  const item = items.find(x => x.id === id);
  if (!item) return;

  // 停止之前的播放
  audioPlayer.pause();
  currentPlaying = id;
  audioPlayer.src = '/audio/' + item.audio_file;
  audioPlayer.currentTime = 0;
  audioPlayer.play().catch(function(e) {
    // autoplay blocked, user interaction should allow it
    showToast('播放失败: ' + e.message);
  });

  render();

  audioPlayer.onended = function() {
    currentPlaying = null;
    render();
  };

  audioPlayer.onerror = function() {
    showToast('音频加载失败');
    currentPlaying = null;
    render();
  };
}

function exportSelected() {
  const ids = getSelectedIds();
  if (ids.length === 0) {
    showToast('请至少选择一个样本');
    return;
  }

  const rejected = items.filter(x => !ids.includes(x.id)).map(x => x.id);
  exportBtn.disabled = true;
  exportBtn.textContent = '导出中...';

  fetch('/api/select', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({selected: ids, rejected: rejected})
  })
  .then(r => r.json().then(j => ({status: r.status, j: j})))
  .then(({status, j}) => {
    if (status === 501 || j.status === 'disabled') {
      showToast(j.message || '写回功能已停用（B4 迁移，请用 /vaudit/ 审计台）', 6000);
    } else {
      showToast('已导出 ' + j.written + ' 条确认样本');
    }
    exportBtn.textContent = '导出确认样本';
    exportBtn.disabled = false;
  })
  .catch(function(err) {
    showToast('导出失败: ' + err.message);
    exportBtn.textContent = '导出确认样本';
    exportBtn.disabled = false;
  });
}

// 加载数据
fetch('/api/list')
  .then(r => r.json())
  .then(function(data) {
    items = data;
    render();
  })
  .catch(function(err) {
    showToast('加载数据失败: ' + err.message);
  });
</script>
</body>
</html>"""


# ============================================================
# 主流程
# ============================================================
def main():
    print("=" * 60)
    print("  [DEPRECATED] 负样本审查工具 - Cohort Review Server")
    print("  迁移说明: cohort 唯一真相源已迁内核 state-dir（B4, 2026-09-24），")
    print("  「导出确认样本」写回已停用（写外层文件=分裂脑, 且导出 embedding 恒空）。")
    print("  只读审查/试听仍可用；过渡期人工复核请用 /vaudit/ 审计台；")
    print("  review 写回端点等内核 additive（见缺口报告）。")
    print("  筛选阈值: 时长>=3s | 文字>=5字符 | 相似度<0.05")
    print("=" * 60)

    # 1. 找最新 perception.jsonl
    perception_path, date_str = find_latest_perception()
    print(f"  数据文件: {perception_path}")
    print(f"  日期: {date_str}")

    # 2. 筛选候选
    print("  筛选候选负样本...")
    raw_candidates = load_candidates(perception_path, date_str)
    print(f"  原始候选: {len(raw_candidates)} 条")

    if not raw_candidates:
        print("  [提示] 没有符合条件的候选负样本")
        print("=" * 60)

    # 3. 裁剪音频
    print("  裁剪音频段...")
    items = crop_audio(raw_candidates)
    if items:
        print(f"  成功裁剪: {len(items)} 条")
    else:
        print("  [提示] 没有可用的候选样本（所有音频段裁剪失败）")
    print("=" * 60)

    # 4. 设置共享数据
    CohortReviewHandler.items = items

    # 5. 启动 HTTP 服务器
    server = ThreadingHTTPServer(("127.0.0.1", PORT), CohortReviewHandler)
    print(f"\n  服务器启动: http://127.0.0.1:{PORT}")
    print(f"  音频缓存: {OUTPUT_DIR}")
    print("  写回: 已停用（B4 迁移，不再写 cohort_verified.jsonl）")
    print("  按 Ctrl+C 停止\n")

    # 6. 自动打开浏览器
    webbrowser.open(f"http://127.0.0.1:{PORT}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  正在停止服务器...")
        server.shutdown()
        print("  已停止")


if __name__ == "__main__":
    main()
