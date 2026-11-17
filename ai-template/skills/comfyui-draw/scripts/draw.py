#!/usr/bin/env python3
"""Generate an image with the local ComfyUI server and move it into {AI目录}/data/images.

Skill helper for the AI root; stdlib only plus Pillow for the optional
outpaint/mask paths. The only external dependency is the local ComfyUI
service (default 127.0.0.1:8188).

Paths are configurable through the environment:
    COMFYUI_DIR          ComfyUI root; input/output default to $COMFYUI_DIR/{input,output}
    COMFYUI_OUTPUT       ComfyUI output dir (must match the server's --output-directory)
    COMFYUI_INPUT        ComfyUI input dir (reference images are copied here)
    COMFYUI_IMAGE_DIR    final image root (default {AI目录}/data/images)
    COMFYUI_GPU_INDEX    nvidia-smi device index used for VRAM sampling (default 0)
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from PIL import Image

AI_ROOT = Path(__file__).resolve().parents[3]
COMFY_DIR = os.environ.get("COMFYUI_DIR", "").strip()

DEFAULT_BASE = os.environ.get("COMFYUI_BASE", "http://127.0.0.1:8188")
DEFAULT_COMFY_OUTPUT = os.environ.get("COMFYUI_OUTPUT") or str(
    Path(COMFY_DIR) / "output" if COMFY_DIR else AI_ROOT / "data" / "cache" / "comfy" / "output"
)
DEFAULT_COMFY_INPUT = os.environ.get("COMFYUI_INPUT") or str(
    Path(COMFY_DIR) / "input" if COMFY_DIR else AI_ROOT / "data" / "cache" / "comfy" / "input"
)
DEFAULT_DEST_BASE = os.environ.get("COMFYUI_IMAGE_DIR") or str(AI_ROOT / "data" / "images")
DEFAULT_GPU_INDEX = os.environ.get("COMFYUI_GPU_INDEX", "0")

MODELS = {
    "flux3": {
        "label": "FLUX.3 Klein int8",
        "unet": "flux3-image-klein-int8-convrot.safetensors",
        "clip": "qwen3vl_4b_int8_convrot.safetensors",
        "clip_type": "flux3",
        "vae": "flux2-vae.safetensors",
        "steps": 16,
        "cfg": 1.0,
        "negative": "",
        "shift": None,
        "sampler": "euler",
        "scheduler": "simple",
        "speed": "1024² 约 13s / 512² 约 4s（热态，硬件相关）",
    },
    "moss": {
        "label": "MOSS-Image SFT int8",
        "unet": "moss_image_sft_int8_convrot.safetensors",
        "clip": "qwen3.5_9b_w4a8_gptq.safetensors",
        "clip_type": "moss_image",
        "vae": "flux2-vae_small.safetensors",
        "steps": 50,
        "cfg": 3.0,
        "negative": "nsfw, worst quality, bad anatomy, watermark, jpeg artifact",
        "shift": 5.0,
        "sampler": "euler",
        "scheduler": "simple",
        "speed": "1024² 约 104s / 512² 约 30s（50 步，热态，硬件相关）",
    },
}


class VramSampler(threading.Thread):
    def __init__(self, gpu_index):
        super().__init__(daemon=True)
        self.gpu_index = gpu_index
        self.samples = []
        self.stop = False

    def run(self):
        while not self.stop:
            try:
                out = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits", "-i", self.gpu_index],
                    text=True,
                    stderr=subprocess.DEVNULL,
                ).strip()
                self.samples.append(int(out))
            except Exception:
                pass
            time.sleep(0.25)


def build_graph(model_key, cfg, prompt, negative, width, height, steps, cfg_scale, seed, sampler, scheduler, shift, prefix, init_name=None, denoise=1.0, outpaint=None):
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": cfg["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": cfg["clip"], "type": cfg["clip_type"], "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": cfg["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": negative}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg_scale,
                "sampler_name": sampler,
                "scheduler": scheduler,
                "positive": ["4", 0],
                "negative": ["5", 0],
                "latent_image": ["6", 0],
                "denoise": 1.0,
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }

    if init_name and isinstance(outpaint, tuple) and len(outpaint) == 2 and outpaint[0] == "__region__":
        # 局部重绘：原图 + 选区掩码
        _, mask_name = outpaint
        graph["6"] = {"class_type": "LoadImage", "inputs": {"image": init_name}}
        graph["72"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        graph["73"] = {"class_type": "ImageToMask", "inputs": {"image": ["72", 0], "channel": "red"}}
        graph["71"] = {"class_type": "VAEEncode", "inputs": {
            "pixels": ["6", 0], "vae": ["3", 0],
        }}
        graph["74"] = {"class_type": "SetLatentNoiseMask", "inputs": {
            "samples": ["71", 0], "mask": ["73", 0],
        }}
        graph["7"]["inputs"]["latent_image"] = ["74", 0]
        graph["7"]["inputs"]["denoise"] = denoise
    elif init_name and outpaint:
        # 扩图：本地铺边 + 掩码，再交给 VAEEncodeForInpaint 只重绘外扩区域
        padded_name, mask_name = outpaint
        graph["6"] = {"class_type": "LoadImage", "inputs": {"image": padded_name}}
        graph["72"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        graph["73"] = {"class_type": "ImageToMask", "inputs": {"image": ["72", 0], "channel": "red"}}
        graph["71"] = {"class_type": "VAEEncodeForInpaint", "inputs": {
            "pixels": ["6", 0], "vae": ["3", 0], "mask": ["73", 0], "grow_mask_by": 32,
        }}
        graph["7"]["inputs"]["latent_image"] = ["71", 0]
        graph["7"]["inputs"]["denoise"] = denoise
    elif init_name:
        # 图生图：LoadImage -> VAEEncode 代替空 latent，并降 denoise
        graph["6"] = {"class_type": "LoadImage", "inputs": {"image": init_name}}
        graph["60"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["6", 0], "vae": ["3", 0]}}
        graph["7"]["inputs"]["latent_image"] = ["60", 0]
        graph["7"]["inputs"]["denoise"] = denoise

    if model_key == "moss":
        if shift is None:
            shift = 5.0
        graph["7"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": shift}}
        graph["8"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["7", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg_scale,
                "sampler_name": sampler,
                "scheduler": scheduler,
                "positive": ["4", 0],
                "negative": ["5", 0],
                "latent_image": ["6", 0],
                "denoise": 1.0,
            },
        }
        graph["9"] = {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}}
        graph["10"] = {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": prefix}}
        if init_name:
            graph["6"] = {"class_type": "LoadImage", "inputs": {"image": init_name}}
            graph["60"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["6", 0], "vae": ["3", 0]}}
            graph["8"]["inputs"]["latent_image"] = ["60", 0]
            graph["8"]["inputs"]["denoise"] = denoise

    return graph


def sanitize_name(name):
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._-")
    return clean[:80] or "image"


def check_service(base):
    try:
        with urllib.request.urlopen(base + "/system_stats", timeout=5) as r:
            return json.load(r)
    except Exception:
        return None


def submit(base, graph):
    payload = json.dumps({"prompt": graph, "client_id": "comfyui-draw"}).encode("utf-8")
    req = urllib.request.Request(base + "/prompt", data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r), None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return None, f"HTTP {e.code}: {body}"
    except Exception as e:
        return None, str(e)


def main():
    parser = argparse.ArgumentParser(
        description="Generate an image with the local ComfyUI server and move it into the AI root's data/images.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  draw.py --model flux3 --prompt \"a red apple on a table\"\n"
            "  draw.py --model flux3 --width 512 --height 512 --prompt \"a cat avatar\"\n"
            "  draw.py --model moss --steps 50 --cfg 3.0 --prompt 'poster with exactly four characters \"春夏秋冬\"'\n"
            "\nEnvironment:\n"
            "  COMFYUI_DIR / COMFYUI_OUTPUT / COMFYUI_INPUT / COMFYUI_IMAGE_DIR / COMFYUI_GPU_INDEX\n"
        ),
    )
    parser.add_argument("--prompt", help="Image description. For Chinese text, quote the exact characters.")
    parser.add_argument("--model", choices=sorted(MODELS), default="flux3", help="Model to use (default: flux3).")
    parser.add_argument("--width", type=int, default=1024, help="Width, multiple of 16 (default: 1024).")
    parser.add_argument("--height", type=int, default=1024, help="Height, multiple of 16 (default: 1024).")
    parser.add_argument("--steps", type=int, help="Sampling steps (default: model-specific).")
    parser.add_argument("--cfg", type=float, help="CFG scale (default: model-specific).")
    parser.add_argument("--seed", type=int, default=42, help="Seed (default: 42).")
    parser.add_argument("--negative", help="Negative prompt (default: model-specific).")
    parser.add_argument("--sampler", help="Sampler name (default: euler).")
    parser.add_argument("--scheduler", help="Scheduler name (default: simple).")
    parser.add_argument("--shift", type=float, help="MOSS ModelSamplingAuraFlow shift (default: 5.0).")
    parser.add_argument("--init-image", help="参考图路径（图生图）；拷进 ComfyUI input 目录后作为 latents 起点。")
    parser.add_argument("--denoise", type=float, default=0.65, help="图生图重绘强度 0~1（默认 0.65，越大越偏离原图）。")
    parser.add_argument("--comfy-input-dir", default=DEFAULT_COMFY_INPUT, help="ComfyUI input dir (default: $COMFYUI_INPUT or $COMFYUI_DIR/input).")
    parser.add_argument("--outpaint", help="扩图目标尺寸 WxH，如 1152x768；需同时给 --init-image。")
    parser.add_argument("--outpaint-feather", type=int, default=40, help="扩图接缝羽化像素（默认 40）。")
    parser.add_argument("--mask-region", help="局部重绘选区 x,y,w,h（像素）；与 --init-image 搭配，只重画框内。")
    parser.add_argument("--name", help="Output filename stem (default: comfyui_<timestamp>).")
    parser.add_argument("--comfy-output-dir", default=DEFAULT_COMFY_OUTPUT, help="ComfyUI output dir (default: $COMFYUI_OUTPUT or $COMFYUI_DIR/output).")
    parser.add_argument("--dest-dir", default=DEFAULT_DEST_BASE, help="Destination root inside the AI root (default: $COMFYUI_IMAGE_DIR or {AI目录}/data/images).")
    parser.add_argument("--subfolder", help="Destination subfolder (default: today's YYYY-MM-DD).")
    parser.add_argument("--base", default=DEFAULT_BASE, help="ComfyUI base URL (default: $COMFYUI_BASE or http://127.0.0.1:8188).")
    parser.add_argument("--gpu-index", default=DEFAULT_GPU_INDEX, help="nvidia-smi GPU index for VRAM sampling (default: $COMFYUI_GPU_INDEX or 0).")
    parser.add_argument("--timeout", type=int, default=900, help="Max seconds to wait (default: 900).")
    parser.add_argument("--no-vram", action="store_true", help="Skip VRAM sampling.")
    parser.add_argument("--dry-run", action="store_true", help="Print the API graph and exit without submitting.")
    parser.add_argument("--check", action="store_true", help="Check the ComfyUI service and print device info.")
    parser.add_argument("--list-models", action="store_true", help="List models and defaults.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    args = parser.parse_args()

    if args.list_models:
        for key in sorted(MODELS):
            m = MODELS[key]
            print(f"{key:6} {m['label']:22} steps={m['steps']:<3} cfg={m['cfg']:<4} {m['speed']}")
        return 0

    stats = check_service(args.base)
    if stats is None:
        print(f"ComfyUI 不可达: {args.base}", file=sys.stderr)
        print("检查: systemctl status comfyui ; sudo systemctl start comfyui", file=sys.stderr)
        return 3

    if args.check:
        print(f"ComfyUI {stats.get('system', {}).get('comfyui_version', '?')} OK")
        for d in stats.get("devices", []):
            print(f"  {d.get('name')}  vram_total={d.get('vram_total', 0) / 1024**3:.1f} GiB")
        return 0

    if not args.prompt:
        parser.error("--prompt is required (unless --check / --list-models)")

    if args.width % 16 or args.height % 16:
        parser.error("--width and --height must be multiples of 16")

    subfolder = args.subfolder or datetime.now().strftime("%Y-%m-%d")
    if os.path.isabs(subfolder) or ".." in subfolder.split(os.sep):
        parser.error("--subfolder must be a relative path without '..'")

    model_cfg = MODELS[args.model]
    steps = args.steps if args.steps is not None else model_cfg["steps"]
    cfg_scale = args.cfg if args.cfg is not None else model_cfg["cfg"]
    negative = args.negative if args.negative is not None else model_cfg["negative"]
    sampler = args.sampler or model_cfg["sampler"]
    scheduler = args.scheduler or model_cfg["scheduler"]

    name = sanitize_name(args.name or f"comfyui_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    prefix = f"{subfolder}/{name}"

    init_name = None
    if args.init_image:
        src = os.path.expanduser(args.init_image)
        if not os.path.isfile(src):
            parser.error(f"--init-image not found: {src}")
        if not (0.0 < args.denoise <= 1.0):
            parser.error("--denoise must be in (0, 1]")
        os.makedirs(args.comfy_input_dir, exist_ok=True)
        stem, ext = os.path.splitext(os.path.basename(src))
        init_name = sanitize_name(stem) + "_init_" + str(int(time.time())) + ext.lower()
        shutil.copyfile(src, os.path.join(args.comfy_input_dir, init_name))

    outpaint = None
    if args.mask_region:
        if not init_name:
            parser.error("--mask-region 需要同时给 --init-image")
        try:
            rx, ry, rw, rh = (int(v) for v in args.mask_region.replace(" ", "").split(","))
        except Exception:
            parser.error("--mask-region 格式应为 x,y,w,h")
        mask_name = _write_region_mask(
            args.comfy_input_dir,
            os.path.join(args.comfy_input_dir, init_name),
            rx, ry, rw, rh,
        )
        outpaint = ("__region__", mask_name)
    elif args.outpaint:
        if not init_name:
            parser.error("--outpaint 需要同时给 --init-image")
        try:
            tw, th = (int(v) for v in args.outpaint.lower().replace(" ", "").split("x"))
        except Exception:
            parser.error("--outpaint 格式应为 WxH，例如 1152x768")
        tw = (tw + 15) // 16 * 16
        th = (th + 15) // 16 * 16
        with Image.open(os.path.join(args.comfy_input_dir, init_name)) as im:
            iw, ih = im.size
        if tw < iw or th < ih or (tw == iw and th == ih):
            parser.error(f"--outpaint 目标尺寸必须大于原图 {iw}x{ih}（至少一维更大）")
        pad_w, pad_h = tw - iw, th - ih
        left, top = pad_w // 2, pad_h // 2
        padded_name = _write_padded(os.path.join(args.comfy_input_dir, init_name), tw, th, left, top)
        mask_name = _write_mask(args.comfy_input_dir, tw, th, iw, ih, left, top)
        outpaint = (padded_name, mask_name)

    graph = build_graph(
        args.model, model_cfg, args.prompt, negative, args.width, args.height,
        steps, cfg_scale, args.seed, sampler, scheduler, args.shift, prefix,
        init_name=init_name, denoise=args.denoise, outpaint=outpaint,
    )

    if args.dry_run:
        print(json.dumps({"prompt": graph}, ensure_ascii=False, indent=2))
        return 0

    sampler_thread = None
    if not args.no_vram:
        sampler_thread = VramSampler(args.gpu_index)
        sampler_thread.start()

    t0 = time.time()
    resp, err = submit(args.base, graph)
    if err:
        if sampler_thread:
            sampler_thread.stop = True
        print(f"ComfyUI 拒绝了工作流: {err}", file=sys.stderr)
        return 2

    pid = resp.get("prompt_id")
    if not pid:
        print(f"提交失败: {json.dumps(resp, ensure_ascii=False)}", file=sys.stderr)
        return 2

    hist = None
    while time.time() - t0 < args.timeout:
        try:
            with urllib.request.urlopen(f"{args.base}/history/{pid}", timeout=10) as r:
                data = json.load(r)
        except Exception:
            data = {}
        if pid in data:
            status = data[pid].get("status", {})
            if status.get("status_str") in ("success", "error"):
                hist = data[pid]
                break
        time.sleep(0.5)

    wall = time.time() - t0
    if sampler_thread:
        sampler_thread.stop = True
        sampler_thread.join(timeout=2)

    if hist is None:
        print(f"超时（{args.timeout}s）: prompt_id={pid}", file=sys.stderr)
        return 4

    status = hist.get("status", {})
    messages = status.get("messages", [])
    ts = {m[0]: m[1].get("timestamp") for m in messages if isinstance(m, list) and len(m) == 2}
    exec_s = None
    if ts.get("execution_start") and ts.get("execution_success"):
        exec_s = (ts["execution_success"] - ts["execution_start"]) / 1000.0

    if status.get("status_str") == "error":
        errs = [m for m in messages if m[0] in ("execution_error", "execution_interrupted")]
        print("执行失败:", json.dumps(errs, ensure_ascii=False, indent=2), file=sys.stderr)
        return 5

    # Move generated files from ComfyUI's output dir into the AI root's data/images/{subfolder}/.
    images = []
    dest_dir = os.path.join(args.dest_dir, subfolder)
    os.makedirs(dest_dir, exist_ok=True)
    for node in hist.get("outputs", {}).values():
        for im in node.get("images", []):
            src = os.path.join(args.comfy_output_dir, im.get("subfolder", ""), im["filename"])
            dst = os.path.join(dest_dir, im["filename"])
            if not os.path.exists(src):
                print(f"生成成功但源文件不存在: {src}", file=sys.stderr)
                print("核对 ComfyUI 启动参数 --output-directory 与脚本的 --comfy-output-dir / $COMFYUI_OUTPUT 是否一致", file=sys.stderr)
                return 5
            shutil.move(src, dst)
            images.append(dst)

    vram_peak = max(sampler_thread.samples) if sampler_thread and sampler_thread.samples else None

    metadata = {
        "status": "success",
        "prompt": args.prompt,
        "negative": negative,
        "model": args.model,
        "model_label": model_cfg["label"],
        "width": args.width,
        "height": args.height,
        "steps": steps,
        "cfg": cfg_scale,
        "seed": args.seed,
        "sampler": sampler,
        "scheduler": scheduler,
        "exec_s": round(exec_s, 2) if exec_s is not None else None,
        "wall_s": round(wall, 2),
        "vram_peak_mib": vram_peak,
        "images": images,
        "prompt_id": pid,
    }

    for path in images:
        metadata.setdefault("sha256", {})[path] = hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]
        sidecar = os.path.splitext(path)[0] + ".json"
        with open(sidecar, "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

    if args.json:
        print(json.dumps(metadata, ensure_ascii=False, indent=2))
    else:
        print(f"OK  {model_cfg['label']}")
        print(f"    size={args.width}x{args.height}  steps={steps}  cfg={cfg_scale}  seed={args.seed}  sampler={sampler}/{scheduler}")
        print(f"    exec={metadata['exec_s']}s  wall={metadata['wall_s']}s  vram_peak={vram_peak} MiB")
        for path in images:
            print(f"    file={path}")
        if not images:
            print("    (no images returned)", file=sys.stderr)
            return 5

    return 0



def _write_padded(src, tw, th, left, top):
    """把原图贴到 tw x th 画布中间，四周用重模糊的放大底图填充（不给模型留可辨认的鬼影）。"""
    from PIL import ImageFilter
    with Image.open(src).convert("RGB") as im:
        iw, ih = im.size
        bg = im.resize((tw, th), Image.BICUBIC).filter(ImageFilter.GaussianBlur(radius=max(tw, th) // 12))
        bg.paste(im, (left, top))
        dst = os.path.join(os.path.dirname(src), os.path.splitext(os.path.basename(src))[0] + "_pad.png")
        bg.save(dst)
    return os.path.basename(dst)


def _write_region_mask(dirpath, src, x, y, w, h):
    """局部重绘掩码：白=重画，黑=保留。"""
    from PIL import ImageDraw
    with Image.open(src) as im:
        iw, ih = im.size
    mask = Image.new("L", (iw, ih), 0)
    ImageDraw.Draw(mask).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
    dst = os.path.join(dirpath, f"region_mask_{iw}x{ih}_{x}_{y}_{w}_{h}.png")
    mask.save(dst)
    return os.path.basename(dst)


def _write_mask(dirpath, tw, th, iw, ih, left, top):
    """白色=需要重绘的外扩区域，黑色=保留原图。"""
    from PIL import ImageDraw
    mask = Image.new("L", (tw, th), 255)
    ImageDraw.Draw(mask).rectangle([left, top, left + iw - 1, top + ih - 1], fill=0)
    dst = os.path.join(dirpath, f"outpaint_mask_{tw}x{th}.png")
    mask.save(dst)
    return os.path.basename(dst)


if __name__ == "__main__":
    sys.exit(main())
