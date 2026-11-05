"""Keep the upstream Pretendard variable chunks used by renderer and shared copy."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'node_modules/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
OUT = ROOT / 'src/renderer/src/styles/pretendard-used.css'

characters = set((ROOT / 'src/renderer/tools/pretendard-glyphs.txt').read_text(encoding='utf-8'))

blocks = re.findall(r'/\* \[(\d+)\] \*/\s*(@font-face\s*\{[^}]+\})', SRC.read_text(encoding='utf-8'))
selected = []
for index, body in blocks:
    ranges = [(int(first, 16), int(last or first, 16))
              for first, last in re.findall(r'U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?', body)]
    if any(any(start <= ord(char) <= end for start, end in ranges) for char in characters):
        selected.append(body.replace('url(./woff2-dynamic-subset/',
                                     'url(../../../../node_modules/pretendard/dist/web/variable/woff2-dynamic-subset/'))

OUT.write_text('/* Selected upstream Pretendard Variable chunks. Regenerate with tools/subset-pretendard.py. */\n'
               + '\n\n'.join(selected) + '\n', encoding='utf-8', newline='\n')
print(f'{len(selected)} font chunks for {len(characters)} rendered glyphs')
