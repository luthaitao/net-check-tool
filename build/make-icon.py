#!/usr/bin/env python3
"""生成程序图标（纯程序化绘制，不含任何第三方/版权素材）。

用法：python build/make-icon.py
产出：build/icon.ico（多尺寸）、build/icon.png
需要 Pillow。
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("需要 Pillow：pip install Pillow", file=sys.stderr)
    sys.exit(1)

SIZES = [16, 24, 32, 48, 64, 128, 256]
BG = (37, 99, 235, 255)      # 主蓝 #2563eb
BG_DARK = (29, 78, 216, 255)  # 底部加深
FG = (255, 255, 255, 255)


def draw_icon(s: int) -> Image.Image:
    """画一枚 s×s 的图标：蓝色圆角底 + 白色网络插头。"""
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # 圆角底板
    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)
    # 底部压一条深色，做出轻微层次
    d.rounded_rectangle(
        [0, int(s * 0.72), s - 1, s - 1], radius=radius, fill=BG_DARK
    )

    cx = s / 2.0

    # 插头主体
    bw, bh = s * 0.44, s * 0.28
    d.rounded_rectangle(
        [cx - bw / 2, s * 0.44, cx + bw / 2, s * 0.44 + bh],
        radius=int(s * 0.05), fill=FG,
    )

    # 两个金属齿
    tw = s * 0.07
    d.rectangle([cx - tw * 1.7, s * 0.28, cx - tw * 0.7, s * 0.46], fill=FG)
    d.rectangle([cx + tw * 0.7, s * 0.28, cx + tw * 1.7, s * 0.46], fill=FG)

    # 引线：竖线 + 底线
    d.rectangle([cx - s * 0.018, s * 0.70, cx + s * 0.018, s * 0.86], fill=FG)
    d.rectangle([cx - s * 0.12, s * 0.84, cx + s * 0.12, s * 0.90], fill=FG)

    return im


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    images = [draw_icon(s) for s in SIZES]

    ico_path = os.path.join(here, "icon.ico")
    png_path = os.path.join(here, "icon.png")

    images[-1].save(ico_path, format="ICO", sizes=[(s, s) for s in SIZES])
    images[-1].save(png_path)

    print(f"icon.ico: {os.path.getsize(ico_path)} bytes ({len(SIZES)} sizes)")
    print(f"icon.png: {os.path.getsize(png_path)} bytes (256x256)")


if __name__ == "__main__":
    main()