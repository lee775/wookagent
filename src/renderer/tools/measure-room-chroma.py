"""Measure object chroma in the 1440px studio scene after masking carpet colours."""
import json
import math
import sys
from functools import lru_cache
from pathlib import Path
from PIL import Image


@lru_cache(maxsize=None)
def lab(rgb):
    def linear(v):
        v /= 255
        return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    r, g, b = map(linear, rgb)
    x = (.4124 * r + .3576 * g + .1805 * b) / .95047
    y = .2126 * r + .7152 * g + .0722 * b
    z = (.0193 * r + .1192 * g + .9505 * b) / 1.08883
    def f(v):
        return v ** (1 / 3) if v > .008856 else 7.787 * v + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


source = Image.open(sys.argv[1]).convert('RGB')
image = source if source.width <= 1200 else source.crop((225, 200, 1405, 800))
carpet = [(174, 189, 198), (181, 194, 200), (158, 173, 181), (179, 192, 198)]
total = kept = coloured = 0
families = set()
for y in range(image.height):
    for x in range(image.width):
        rgb = image.getpixel((x, y))
        total += 1
        if y >= 175 * image.height / 610 and any(sum((a - b) ** 2 for a, b in zip(rgb, c)) < 11 ** 2 for c in carpet):
            continue
        kept += 1
        _, a, b = lab(rgb)
        if math.hypot(a, b) >= 15:
            coloured += 1
            families.add(int(((math.degrees(math.atan2(b, a)) + 360) % 360) // 60))
result = {'officePixels': total, 'afterCarpetMask': kept, 'chromaticPixels': coloured,
          'chromaticPercentOfOffice': round(100 * coloured / total, 2),
          'chromaticPercentOfUnmasked': round(100 * coloured / kept, 2),
          'hueFamilies': sorted(families)}
print(json.dumps(result))
if len(sys.argv) > 2:
    Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
if len(families) < 3 or coloured / total < .1:
    raise SystemExit(1)
