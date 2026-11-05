"""Locate remaining pixels near the v3.2 reference colours in a 1440 capture."""
import importlib.util
from collections import Counter
from pathlib import Path
from PIL import Image
import sys

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('palette-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
image = Image.open(sys.argv[1]).convert('RGB')
for target in ['#3e5546', '#dcc39b', '#d8cfb4']:
    lab = gate.hex_lab(target)
    tiles = Counter()
    colours = Counter()
    examples = []
    for y in range(200, 800):
        for x in range(225, 1405):
            rgb = image.getpixel((x, y))
            if gate.de(gate.srgb_to_lab(*rgb), lab) < 10:
                tiles[(x // 100 * 100, y // 100 * 100)] += 1
                colours[rgb] += 1
                if len(examples) < 8: examples.append((x, y, rgb))
    print(target, sum(tiles.values()), 'tiles', tiles.most_common(12), 'colours', colours.most_common(8), 'examples', examples)
