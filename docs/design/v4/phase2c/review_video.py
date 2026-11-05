"""Scan every 25 fps cycle frame for discontinuities in the 3D scene crop."""
import json
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
VIDEO = ROOT / 'cycle-88s-25fps.webm'
WIDTH, HEIGHT = 291, 148
FRAME_BYTES = WIDTH * HEIGHT

probe = subprocess.run([
    'ffprobe', '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames,duration',
    '-of', 'json', str(VIDEO)
], check=True, capture_output=True, text=True)
stream = json.loads(probe.stdout)['streams'][0]

decoder = subprocess.Popen([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(VIDEO),
    '-vf', f'crop=1164:592:225:200,scale={WIDTH}:{HEIGHT},format=gray',
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'
], stdout=subprocess.PIPE)
assert decoder.stdout
previous = None
diffs = []
frames = 0
while True:
    raw = decoder.stdout.read(FRAME_BYTES)
    if not raw:
        break
    if len(raw) != FRAME_BYTES:
        raise RuntimeError(f'partial decoded frame {frames}: {len(raw)} bytes')
    frame = np.frombuffer(raw, dtype=np.uint8).reshape(HEIGHT, WIDTH)
    if previous is not None:
        delta = np.abs(frame.astype(np.int16) - previous.astype(np.int16))
        diffs.append({'frame': frames, 'second': round(frames / 25, 2),
                      'mean': round(float(delta.mean()), 4),
                      'changed_fraction': round(float((delta > 24).mean()), 4)})
    previous = frame.copy()
    frames += 1
decoder.wait()
if decoder.returncode != 0 or frames != 2200:
    raise RuntimeError(f'decoder exit {decoder.returncode}, frames {frames}')

report = {'video': VIDEO.name, 'width': stream['width'], 'height': stream['height'],
          'fps': stream['avg_frame_rate'], 'frames': frames,
          'scene_crop': [225, 200, 1164, 592],
          'mean_frame_difference': round(float(np.mean([item['mean'] for item in diffs])), 4),
          'largest_changes': sorted(diffs, key=lambda item: item['mean'], reverse=True)[:24]}
(ROOT / 'frame-review.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
