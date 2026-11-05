"""Create the readable per-person, per-clip deformation comparison."""
from pathlib import Path
import json

root = Path(__file__).resolve().parents[3]
folder = root / 'docs/design/v4/polish'
before = json.loads((folder / 'deformation-before.json').read_text(encoding='utf-8'))
after = json.loads((folder / 'deformation-after.json').read_text(encoding='utf-8'))
lines = [
    '# Deformation by person and clip', '',
    'Maximum deformed edge length divided by its rest length. The same sampling '
    'method was used before and after. Edges shorter than 2 mm at rest are '
    'excluded. Frames sampled: start, end, quarter points, and frames 10, 17, '
    '18, and 25 when in range. Long loops repeat the original body gesture.', '',
    'The covered body transfer source is removed from the final GLB after weights are projected. '
    'Garment-through-covered-body penetration is therefore 0 m in the final asset for every clip. '
    'The baseline penetration was not sampled, so it is reported as n/a rather than invented. '
    'Separate garment layers can still intersect and are checked in the contact sheets.', '',
    '| Person | Clip | Stretch before | Stretch after | Before frame | After frame | Covered-body penetration before | After |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
]
for number in range(1, 14):
    original = before[str(number)]
    polished = after[str(number)]
    assert original.keys() == polished.keys()
    for clip in sorted(original):
        left, right = original[clip], polished[clip]
        lines.append(f"| {number:02d} | `{clip}` | {left['max_edge_stretch']:.3f}x | "
                     f"{right['max_edge_stretch']:.3f}x | {left['frame']} | "
                     f"{right['frame']} | n/a | {right['garment_through_covered_body_m']:.3f} m |")
(folder / 'deformation-table.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('Wrote', 13 * 23, 'comparisons')
