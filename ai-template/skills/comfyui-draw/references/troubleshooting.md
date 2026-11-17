# 排障

## 服务不可达

```bash
systemctl is-active comfyui
systemctl status comfyui
journalctl -u comfyui -n 100 --no-pager
ss -lnt | grep ':8188'
curl -s http://127.0.0.1:8188/system_stats
```

- `inactive`：`sudo systemctl start comfyui`。
- `failed`：看 journal，常见原因是模型盘未挂载、模型路径错误、torch/CUDA 不匹配。
- 端口被占：确认没有第二个 ComfyUI 实例；不要改端口，先按 PID 停掉冲突进程。

## 显存不足（OOM）

- 先降到 512×512。
- 降低步数（FLUX3 最低 16；MOSS 可 25）。
- 确认 ComfyUI 没跑在错误的卡上：`CUDA_VISIBLE_DEVICES` 应只暴露目标卡。
- 不要停本机其他生产推理服务来腾显存。

## 模型缺失

```bash
# 模型根按本机 ComfyUI 的 extra_model_paths.yaml / 启动参数确定
ls -lh "{ComfyUI模型根}/diffusion_models/"
ls -lh "{ComfyUI模型根}/text_encoders/"
ls -lh "{ComfyUI模型根}/vae/"
```

必需文件见 `references/models.md`。缺文件就补下载，不要改 ComfyUI 的 `extra_model_paths.yaml` 指向别处。

## 第一次生成很慢

模型加载（5-10GB）会计入第一次的 `exec_s`。同一模型连续第二次才是稳态速度。汇报时要说明冷态还是热态。

## 中文字形不对

- 检查提示词：是否把要渲染的字放进引号、是否写清 `exactly N characters`、是否写了 `no other text`。
- 换 MOSS-Image；FLUX.3 的中文文字能力弱得多。
- 提高步数到 50、CFG 3.0，使用官方设置。
- 仍然错字/缺笔：直接判定“画不成”，不要换一张勉强能看的图充当通过。
- 产品化建议加 OCR 校验闸（PaddleOCR/Tesseract）：识别结果与目标文字不一致就重试或拒绝。

## 提交被拒绝（HTTP 400）

ComfyUI 会在响应里返回 `node_errors`，通常原因：
- 模型文件名写错；
- `CLIPLoader.type` 与模型不匹配（FLUX3 用 `flux3`，MOSS 用 `moss_image`）；
- 宽高不是 16 的倍数；
- 缺少节点或输入类型错误。

用 `--dry-run` 打印实际提交的图，逐项核对。

## 成品没有出现在 data/images

脚本会先把图生成到 ComfyUI 输出目录，再 `shutil.move` 到 `{AI目录}/data/images/{subfolder}/`。

- 源文件不存在：说明 ComfyUI 的 `--output-directory` 与脚本的 `--comfy-output-dir` / `$COMFYUI_OUTPUT` 不一致；先核对服务启动参数。
- 移动失败：检查目标目录权限和磁盘空间；源文件仍在 ComfyUI 输出目录。
- `--subfolder` 只接受相对路径，不能带 `..`。

## 长命令超时 / 会话被打断

按运行时规定用长任务机制（Loom 为 `pty_spawn(notifyOnExit=true)`；其他后端用后台 job + 完成通知）跑脚本，不要 `nohup ... & sleep`。MOSS 50 步 1024² 约 104 秒，给足超时；脚本自身默认 900 秒。

## 磁盘

- 禁止把输出、缓存、临时文件写到系统盘的用户目录；产物统一落 `{AI目录}/data/` 下。
- 生成图按日期分片在 `{AI目录}/data/images/{YYYY-MM-DD}/`；不要把所有图堆在一个目录。

## 鉴权

ComfyUI 只监听 `127.0.0.1`，没有原生 token 鉴权。不要把它直接暴露到公网；如果要给其他设备用，先加带 Bearer token 的本机反代。
