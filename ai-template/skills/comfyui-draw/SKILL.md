---
name: comfyui-draw
description: 用本机 ComfyUI 生成图片并落盘到 AI 目录的 data/images。当用户要求画图、出图、生成图片/头像/海报/插画/写实照片，或要求画面里出现指定中文文字，或提到 ComfyUI、MOSS-Image、FLUX.3 Klein、文生图、配图、做一张图时使用。适用于本地生成并需要耗时、显存、文件路径记录的场景；不用于看图理解或图生图编辑。
---

# ComfyUI 本地绘图

用本机 ComfyUI（默认 `http://127.0.0.1:8188`）生成图片。脚本封装模型选择、API 提交、轮询、显存采样、元数据，并把成品从 ComfyUI 输出目录移动到 `{AI目录}/data/images/{YYYY-MM-DD}/`。

> 本目录是生产实例的脱敏模板：路径、环境变量、文案均按占位符给出。接入实例前按「环境变量」一节确认路径。

## 边界

- 只在 AI 目录内落产物：`{AI目录}/data/images/{YYYY-MM-DD}/`。
- 只调用本机 ComfyUI 服务；不读项目代码、不改服务配置、不抢其他占用 GPU 的生产服务。
- 生成图属于运行时产物，不提交 git，除非用户明确要求。
- 不接公网；ComfyUI 只监听 `127.0.0.1`。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `COMFYUI_BASE` | ComfyUI 地址 | `http://127.0.0.1:8188` |
| `COMFYUI_DIR` | ComfyUI 根目录；input/output 默认取它下面的 `input` / `output` | 空 |
| `COMFYUI_OUTPUT` | ComfyUI 输出目录，必须与服务的 `--output-directory` 一致 | `$COMFYUI_DIR/output`，否则 `{AI目录}/data/cache/comfy/output` |
| `COMFYUI_INPUT` | ComfyUI 输入目录，参考图会拷到这里 | `$COMFYUI_DIR/input`，否则 `{AI目录}/data/cache/comfy/input` |
| `COMFYUI_IMAGE_DIR` | 成品图片根目录 | `{AI目录}/data/images` |
| `COMFYUI_GPU_INDEX` | `nvidia-smi` 设备号，用于显存采样 | `0` |

命令行参数 `--comfy-output-dir` / `--comfy-input-dir` / `--dest-dir` / `--base` / `--gpu-index` 可逐次覆盖。

## 依赖

- Python 3.10+，`numpy` 不需要；`Pillow` 用于扩图/局部重绘与图片尺寸检查。
- 本机可用的 ComfyUI 与模型文件（见 `references/models.md`）。

## 运行方式（必须遵守 10 秒规则）

生成通常超过 10 秒，按运行时规定走长任务机制，并设置完成通知；不要用 `nohup ... & sleep` 或前台 `sleep` 干等。

- Loom：`pty_spawn(notifyOnExit=true)`，收到 `<pty_exited>` 后 `pty_read` 取最后几行。
- 其他后端：用该后端自带的后台任务/通知能力（例如后台 job + 完成回调）。

```text
SCRIPT={AI目录}/skills/comfyui-draw/scripts/draw.py

pty_spawn(
  command="python3",
  args=[SCRIPT, "--model", "flux3", "--prompt", "<英文画面描述>"],
  description="ComfyUI generate image",
  notifyOnExit=true
)
```

收到完成通知后，读最后几行拿文件路径；再用 `read` 打开 PNG 验收。

快速检查（短命令可直接用 bash）：

```bash
python3 "$SCRIPT" --check
python3 "$SCRIPT" --list-models
```

## 模型选择

| 任务 | 模型 | 默认参数 | 1024² 热态基线（参考） |
|---|---|---|---|
| 通用、写实、头像、插画 | `flux3` | 16 步，CFG 1.0 | 约 13 秒，峰值约 13.3GB |
| 中文文字、海报、版式、信息图 | `moss` | 50 步，CFG 3.0，shift 5.0 | 约 104 秒，峰值约 13.4GB |
| 最低延迟 | `flux3` + 512×512 | 16 步 | 约 3.9 秒，峰值约 10GB |

- 用户要“快/先看看”→ `flux3` + 512×512。
- 画面里要有准确中文/长文字、海报、卡片 → `moss`；嫌慢先 25 步试，字形不对再加回 50 步，不要靠降步数硬凑。
- 中文文字不要用 `flux3`，它的中文渲染明显弱于 MOSS。MOSS 50 步、896×1280 实测短句（3 行、每行 5~9 字）笔画全对；但长文案、多行小字仍不稳，产品级排版建议底图 MOSS/FLUX + 真字体压字（脚本参考 `scripts/poster_text.py`，文案在文件顶部 `TEXTS` 里替换）。

## 图生图与扩图

```bash
python3 "$SCRIPT" --model flux3 \
  --init-image /path/ref.png --denoise 0.55 \
  --width 768 --height 768 --prompt "<改什么>"
```

- `--init-image`：参考图，会被拷进 ComfyUI input 目录后作为 latents 起点（LoadImage + VAEEncode）。
- `--denoise`：重绘强度，默认 0.65；越小越像原图（0.4~0.6 保结构，0.75+ 基本重画）。
- `--outpaint WxH`：外扩画布，本地铺边 + 掩码后只重绘外扩区域（需同时给 `--init-image`）。
- `--mask-region x,y,w,h`：只重画框内区域（局部重绘）。

## 提示词

用英文描述“完成的画面”，不要写“帮我画一个”的指令。中文文字必须把要渲染的字原样放进引号，并写清数量、位置、字体风格、不要其他文字。

**头像/吉祥物**

```
A minimalist line-art mascot avatar of <subject>, rounded simple shapes, clean black outlines, small dot eyes, subtle smile, warm cream background, flat vector illustration, centered circular avatar composition, cute and approachable, no text, no letters
```

**写实场景**

```
A warm photorealistic <interior/product/portrait> photograph of <scene>, <key objects>, soft natural light, shallow depth of field, natural colors, 35mm photography
```

**中文文字/海报**

```
A clean minimalist poster on a pure white background. In the center, exactly <N> large black Chinese characters "<字1 字2 字3 字4>" arranged horizontally in one row. Bold sans-serif Chinese typeface, crisp and correct strokes, even spacing, perfectly legible, no other text, no decorative elements.
```

## 验收与汇报

1. `read` 打开生成的 PNG。
2. 中文文字逐字核对：缺笔、错字、多字、乱序、糊成一团都算失败。
3. 失败就直说“画不成”，说明哪个字坏了；不要换一张“看起来还行”的图充当通过。
4. 汇报：模型、分辨率、步数/CFG、执行耗时、显存峰值、文件路径。
5. 如果用户要发到 QQ，用 QQ 发送工具并附本地文件路径；没拿到成功回执就不要说“已发送”。

产品级中文排版建议加 OCR/字形校验闸：生成后用 OCR 识别目标文字，不匹配就拒绝重试；或者文字层用真实字体排版，模型只生成背景。

## 输出

- 图片：`{AI目录}/data/images/{YYYY-MM-DD}/<name>.png`
- 同名 `.json`：提示词、模型、分辨率、步数、CFG、seed、耗时、显存峰值、sha256。
- 脚本会先把图生成到 ComfyUI 输出目录，再移动到 `{AI目录}/data/images/{date}/`；移动失败时源文件仍在 ComfyUI 输出目录（comfy 输出目录不是 `$COMFYUI_OUTPUT` 的典型表现）。

## 排障

- 服务不可达：`systemctl status comfyui`、`journalctl -u comfyui -n 100 --no-pager`；未启动则 `sudo systemctl start comfyui`。
- 显存不足：降到 512×512 或减步数；不要停本机其他生产推理服务来腾显存。
- 模型缺失：检查 ComfyUI 的模型根（由服务端 `extra_model_paths.yaml` 或启动参数决定）下的 `diffusion_models/`、`text_encoders/`、`vae/` 三层。
- 第一次生成慢：模型加载计入耗时，报告时注明冷态/热态。
- 更细的排障：`references/troubleshooting.md`。
- 模型文件、节点图、许可证：`references/models.md`。

## 许可证

- FLUX.3 Klein：FLUX Kommunity License v1.0（非商用；年收入 <$5M 的 Qualifying User 可用输出商用）。
- MOSS-Image：Apache-2.0（可商用）。
