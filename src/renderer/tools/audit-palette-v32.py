"""Measure the v3.2 office crop and interface colour separation."""
import importlib.util
import json
import math
import sys
from collections import Counter
from pathlib import Path
from PIL import Image

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('palette-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

image = Image.open(sys.argv[1]).convert('RGB')
room = image.crop((225, 200, 1405, 800))
colours = room.getcolors(maxcolors=1000000) or []
total = sum(count for count, _ in colours)
colourful = 0
hues = Counter()
references = ['#3e5546', '#dcc39b', '#d8cfb4']
near = Counter()
near_colours = {colour: Counter() for colour in references}
for count, rgb in colours:
    lab = gate.srgb_to_lab(*rgb)
    chroma = math.hypot(lab[1], lab[2])
    if chroma >= 15:
        colourful += count
        hue = (math.degrees(math.atan2(lab[2], lab[1])) + 360) % 360
        hues[int(hue // 60) * 60] += count
    for colour in references:
        if gate.de(lab, gate.hex_lab(colour)) < 10:
            near[colour] += count
            near_colours[colour][rgb] += count
brand = gate.hex_lab('#216b83')
chips = ['#d7e7dc', '#e8d5c7', '#f1e1b7', '#c5dce8']
chip_pairs = [(a, b, gate.de(gate.hex_lab(a), gate.hex_lab(b))) for index, a in enumerate(chips) for b in chips[index + 1:]]
chip_pair = min(chip_pairs, key=lambda item: item[2])
report = {
    'officePixels': total,
    'chroma15Percent': round(100 * colourful / total, 2),
    'hueFamiliesPercent': {f'{h}-{h+59}': round(100 * count / total, 2) for h, count in sorted(hues.items())},
    'nearReferencesPercent': {colour: round(100 * near[colour] / total, 3) for colour in references},
    'topNearColours': {colour: [(f'#{r:02x}{g:02x}{b:02x}', count) for (r, g, b), count in near_colours[colour].most_common(5)] for colour in references},
    'brandToErrorDeltaE76': round(gate.de(brand, gate.hex_lab('#a9493f')), 1),
    'brandToEmergencyDeltaE76': round(gate.de(brand, gate.hex_lab('#963d35')), 1),
    'minStatusChipDeltaE76': round(chip_pair[2], 1),
    'closestStatusChips': chip_pair[:2],
}
if len(sys.argv) > 2:
    Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
