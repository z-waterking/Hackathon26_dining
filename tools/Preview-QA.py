"""Create one compact JPEG contact sheet from selected test screenshots."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("images", nargs="+")
args = parser.parse_args()
paths = [Path(value) for value in args.images]
columns = 2
rows = (len(paths) + columns - 1) // columns
width = 1280
height = min(1280, rows * 426)
cell_w, cell_h = width // columns, height // rows
canvas = Image.new("RGB", (width, height), "#e9edef")
draw = ImageDraw.Draw(canvas)
for index, path in enumerate(paths):
    with Image.open(path) as original:
        # Keep the entire screenshot; originals remain unchanged on disk.
        preview = ImageOps.contain(original.convert("RGB"), (cell_w - 16, cell_h - 28))
    x = (index % columns) * cell_w
    y = (index // columns) * cell_h
    canvas.paste(preview, (x + (cell_w - preview.width) // 2, y + 24))
    draw.text((x + 8, y + 5), f"{index + 1}. {path.name}", fill="#23323d")
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
quality = 82
canvas.save(output, format="JPEG", quality=quality, optimize=True)
while output.stat().st_size > 350_000 and quality > 35:
    quality -= 8
    canvas.save(output, format="JPEG", quality=quality, optimize=True)
print(f"{output.resolve()} | {width}x{height} | {output.stat().st_size} bytes | ready")
