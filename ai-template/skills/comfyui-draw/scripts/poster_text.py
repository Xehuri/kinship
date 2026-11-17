#!/usr/bin/env python3
"""把中文文案压到海报底图上（真字体排版，不靠模型画字）。

用法:
    python poster_text.py <底图.png> <输出.png>

实例接入前先把下面 TEXTS 里的占位符换成自己的文案；字体路径按本机 Noto CJK
安装位置改（Linux 常见路径已给出，macOS/Windows 换成系统字体文件即可）。
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SERIF_BLACK = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Black.ttc"
SERIF_MED = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Medium.ttc"
SANS_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
SANS_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"

INK = (58, 52, 50)
SUB = (122, 108, 104)
ROSE = (198, 118, 138)

# 文案占位：替换成实例自己的品牌名、称呼与正文。
TEXTS = {
    "eyebrow": "{品牌}   ·   {产品名}",
    "title": "{主智能体名称}",
    "subtitle": "{用户称呼}的伙伴　·　{角色定位}",
    "lines": [
        "{三到五行正文，一行一句}",
        "{一行一个卖点或日常场景}",
        "{保持短句，避免长文案}",
    ],
    "quote": "“{一句用户会认同的话}”",
    "footer": "{年份} · {城市}",
}


def main() -> int:
    if len(sys.argv) < 3:
        print("用法: python poster_text.py <底图> <输出>", file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])

    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img)
    W, H = img.size

    f_title = ImageFont.truetype(SERIF_BLACK, 132)
    f_sub = ImageFont.truetype(SANS_REG, 40)
    f_body = ImageFont.truetype(SANS_REG, 44)
    f_foot = ImageFont.truetype(SANS_REG, 28)

    x = 92

    # 顶部小标
    draw.text((x, 150), TEXTS["eyebrow"], font=f_foot, fill=SUB)
    draw.line((x, 210, x + 72, 210), fill=ROSE, width=4)

    # 主标题
    draw.text((x - 6, 268), TEXTS["title"], font=f_title, fill=INK)

    # 副标题
    draw.text((x, 452), TEXTS["subtitle"], font=f_sub, fill=SUB)

    # 三行
    y = 600
    for line in TEXTS["lines"]:
        draw.text((x, y), line, font=f_body, fill=INK)
        y += 92

    # 引言
    draw.line((x, 1000, x + 520, 1000), fill=(214, 204, 198), width=2)
    draw.text((x, 1040), TEXTS["quote"], font=ImageFont.truetype(SERIF_MED, 40), fill=SUB)

    # 页脚（放右上，避开底部插画）
    foot = TEXTS["footer"]
    fw = draw.textlength(foot, font=f_foot)
    draw.text((W - 92 - fw, 150), foot, font=f_foot, fill=SUB)

    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, quality=95)
    print(dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
