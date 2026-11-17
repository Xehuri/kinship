# 模型与参数

## 已安装模型

### FLUX.3 Klein（默认，通用/写实/头像）

| 角色 | 文件 | 大小 |
|---|---|---|
| DiT | `flux3-image-klein-int8-convrot.safetensors` | 5.83 GB |
| 文本编码器 | `qwen3vl_4b_int8_convrot.safetensors` | 4.86 GB |
| VAE | `flux2-vae.safetensors` | 0.34 GB |

- 许可证：FLUX Kommunity License v1.0（非商用；年收入 <$5M 的 Qualifying User 可用输出商用）
- 官方推荐：16 步，CFG 1.0
- 热态基线：1024² 约 13 秒，峰值约 13.3GB；512² 约 3.9 秒，峰值约 10GB（具体看显卡）

### MOSS-Image SFT（中文文字/海报/版式）

| 角色 | 文件 | 大小 |
|---|---|---|
| DiT | `moss_image_sft_int8_convrot.safetensors` | 5.41 GB |
| 文本编码器 | `qwen3.5_9b_w4a8_gptq.safetensors` | 7.34 GB |
| VAE | `flux2-vae_small.safetensors` | 0.25 GB |

- 许可证：Apache-2.0（可商用）
- 官方推荐：50 步，CFG 3.0，euler，shift 5.0
- 模板默认：25 步，CFG 2.5，`er_sde`
- 热态基线：1024² / 50 步约 104 秒，峰值约 13.4GB（具体看显卡）
- 只做文生图，不支持参考图/编辑
- 中文长文本覆盖率官方 92.4%，不是 100%

## API 工作流

### FLUX.3

```
UNETLoader(flux3-image-klein-int8-convrot, default)
  -> KSampler(model, positive=CLIPTextEncode, negative=CLIPTextEncode,
              latent=EmptyFlux2LatentImage, steps=16, cfg=1.0,
              sampler=euler, scheduler=simple)
  -> VAEDecode(flux2-vae)
  -> SaveImage
CLIPLoader(qwen3vl_4b_int8_convrot, type=flux3)
```

### MOSS-Image

```
UNETLoader(moss_image_sft_int8_convrot, default)
  -> ModelSamplingAuraFlow(shift=5.0)
  -> KSampler(model, positive=CLIPTextEncode, negative=CLIPTextEncode,
              latent=EmptyFlux2LatentImage, steps=50, cfg=3.0,
              sampler=euler, scheduler=simple)
  -> VAEDecode(flux2-vae_small)
  -> SaveImage
CLIPLoader(qwen3.5_9b_w4a8_gptq, type=moss_image)
```

两个模型都用 `EmptyFlux2LatentImage`（FLUX.2 VAE，32 通道，2×2 patch，16px 有效步长）。

## 选择建议

| 需求 | 选择 | 理由 |
|---|---|---|
| 快、写实、人物、室内、产品 | FLUX.3 | 通用画质高，13 秒级 |
| 头像/吉祥物/扁平插画 | FLUX.3 | 线条和构图稳定 |
| 中文文字、海报、信息图、UI 稿 | MOSS-Image | 文字渲染和布局是强项 |
| 中文文字但嫌慢 | MOSS 25 步先试 | 时间减半，字形可能下降；不行再加回 50 步 |
| 最低延迟 | FLUX.3 512² | 约 3.9 秒 |

## 显卡兼容性

- Turing（sm_75）没有原生 bf16、没有 FP8 计算、没有 NVFP4：不要装 Nunchaku AWQ / SageAttention（要求 sm_80+），走 `int8_convrot` + fp16 计算。
- 多卡机器用 `CUDA_VISIBLE_DEVICES` 把 ComfyUI 锁在空闲卡上；本机若还有别的推理/音频服务占卡，不要抢它的显存，也不要重启它。
- `nvidia-smi` 的显存采样用 `--gpu-index` 指定设备号，多卡时别采错卡。

## 输出约定

- 图片：`{AI目录}/data/images/{YYYY-MM-DD}/<name>.png`
- 元数据：同目录同名 `.json`，含 prompt、模型、分辨率、步数、CFG、seed、耗时、显存峰值、sha256。
- 时间口径：`exec_s` 来自 ComfyUI 的 `execution_start`→`execution_success`；`wall_s` 是提交到完成的墙钟时间。首次生成包含模型加载。
