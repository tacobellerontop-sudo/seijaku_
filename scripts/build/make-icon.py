#!/usr/bin/env python3
"""Draws Seijaku's icon at build time: a vermilion seal square with the
white kanji for simplicity inside it.

Why at build time: the icon is generated, not committed, so the repo
stays text-only and the icon never goes stale with the code. Needs
Pillow (pip install pillow) and a CJK font on the build machine
(Windows runners have Microsoft YaHei and Yu Gothic).
"""

import argparse
import sys

VERMILION = (216, 68, 42, 255)
WHITE = (255, 255, 255, 255)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Path for the .ico file")
    parser.add_argument("--png", default=None, help="Optional path for a 256px .png")
    args = parser.parse_args()

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("make-icon: Pillow is not installed, skipping the icon")
        return 0

    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([4, 4, size - 4, size - 4], radius=48, fill=VERMILION)

    font = None
    for name in [
        "Microsoft YaHei",
        "Yu Gothic",
        "SimSun",
        "Noto Sans CJK JP",
        "DejaVu Sans",
    ]:
        try:
            font = ImageFont.truetype(name, 150)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()

    text = "\u7c21"  # the kanji for simplicity
    box = draw.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), text, font=font, fill=WHITE)

    # Breached's exact size set: Windows asks for 20/24/40 too (the
    # taskbar uses 24), and an icon without the size Windows asks for
    # is one more reason to fall back to the exe's icon.
    img.save(args.out, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (40, 40), (32, 32), (24, 24), (20, 20), (16, 16)])
    if args.png:
        img.save(args.png)
    print(f"make-icon: wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
