# 品牌资源

Kinship 的图标只有一个矢量主源；生成脚本从主源派生圆角卡片 SVG，再生成全部位图。

## 源文件

| 项 | 值 |
| --- | --- |
| 主源 | `assets/brand/kinship-mascot-rose.svg` |
| SHA-256 | `667f4d38d9a2abfb4c6a7e405ec8c5e8509df8ad41472a9ed1dcd24a911c90d8` |
| 主源画布 | 1024x1024（`viewBox="0 0 1536 1536"`，保持未裁剪） |
| 派生 SVG | `frontend/mobile/public/favicon.svg`（圆角卡片，卡片外透明） |

主源顶部的白色矩形同时是卡片内部和外部背景，不能删除。生成器把整幅内容包进 `clipPath id="card"`：卡片外边界为 `x=66..1470`、`y=66..1470`，圆角半径 316（1404 的 22.5%）；`viewBox` 为 `64 64 1408 1408`，卡片四周留 2 单位透明边。裁剪组内末尾用 `rx=39`、`stroke-width=14` 的白色圆环盖住主源原有细框，避免出现双层边框；组外用 `rx=309`、`stroke-width=14` 的 `#d67d99` 玫瑰色边框重绘轮廓，边框外缘与卡片外边界齐平。

`desktop/scripts/make-brand-assets.mjs` 在生成或校验前先比对主源 SHA-256，不一致立即失败。派生 SVG 由脚本确定性生成，禁止手改。

## 命令

以下命令均在 `desktop/` 目录执行：

```bash
npm run icons          # 重新生成全部 SVG/位图产物
npm run icons:check    # 只读校验；发现漂移时退出码 1
npm run icon           # 历史别名，等价于 npm run icons
```

## 产物

| 产物 | 尺寸 |
| --- | --- |
| `frontend/mobile/public/favicon.svg` | 1024x1024（`viewBox="64 64 1408 1408"`） |
| `desktop/resources/icon.png` | 512x512 |
| `desktop/resources/icon.ico` | 16/24/32/48/64/128/256 |
| `app/src/main/res/mipmap-mdpi/ic_launcher.png` | 48x48 |
| `app/src/main/res/mipmap-hdpi/ic_launcher.png` | 72x72 |
| `app/src/main/res/mipmap-xhdpi/ic_launcher.png` | 96x96 |
| `app/src/main/res/mipmap-xxhdpi/ic_launcher.png` | 144x144 |
| `app/src/main/res/mipmap-xxxhdpi/ic_launcher.png` | 192x192 |
| `desktop/pc-sensor/assets/tray-icon-32.png` | 32x32 |
| `desktop/pc-sensor/assets/tray-icon-64.png` | 64x64 |
| `desktop/pc-sensor/assets/kinship-pc-sensor.ico` | 16/24/32/48/64/128/256 |

生成流程固定：主源经 `buildRoundedSvg()` 裁剪为圆角卡片并输出派生 SVG；以 `density: 144` 渲染为 2048x2048，保留 alpha，再用 `lanczos2` 缩放到目标尺寸，PNG `compressionLevel: 9`。`.ico` 由同一批 PNG 经 `png-to-ico` 生成。全部 PNG 与 ICO 的圆角外区域保持透明，卡片内部保持不透明白/米色。

## 规则

- 主源保持原样：不裁剪白边、不做圆角、不改色、不压缩、不做任何优化。
- 生成器负责裁剪到卡片外边界、应用 22.5% 圆角、隐藏主源细框并重绘玫瑰色边框；不要手工修改生成出的 `frontend/mobile/public/favicon.svg`。
- 不使用被否决的 `final-v2` 素材，也不使用任何 `br-*` / `c8-*` 实验产物。
- 位图是生成物，但必须提交到仓库；主源或派生规则变更后重新生成并提交全部产物。
- `npm run icons:check` 逐像素比对 PNG、逐字节比对 ICO 与派生 SVG，并检查尺寸与主源 SHA-256；测试 `desktop/tests/brand-assets.test.ts` 也调用该模式。
