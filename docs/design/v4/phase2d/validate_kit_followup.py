"""Validate every 2x matrix cell and write its navigable full-resolution index."""
import hashlib,itertools,json
from pathlib import Path
import numpy as np
from PIL import Image
out=Path('docs/design/v4/phase2d/kit-followup');coverage=json.loads((out/'coverage.json').read_text())
assert not coverage['errors'];cases=[c for p in coverage['pages'] for c in p['cases']]
assert coverage['poseClips']=={'sit_type':'sit_type','sofa_talk':'sofa_talk','sit_lean_back':'sit_lean_back','meeting':'sit_think'}
expected=set(itertools.product(['cardigan','hoodie','shirt','vest','blazer','fleece','tee_long','sweater','producer'],range(12),[False,True],['sit_type','sofa_talk','sit_lean_back','meeting']))
assert len(cases)==864 and {(c['garment'],c['hair'],c['headphones'],c['pose']) for c in cases}==expected
hashes={};maximum_body_difference=0;minimum_foreground=1_000_000
for page in coverage['pages']:
 path=out/page['file'];hashes[path.name]=hashlib.sha256(path.read_bytes()).hexdigest()
 with Image.open(path) as image:
  assert image.size==(2304,2872)
  pixels=np.array(image.convert('RGB'))
 for i in range(36):
  x=(i%6)*384;y=52+(i//6)*470
  minimum_foreground=min(minimum_foreground,int(np.any(pixels[y:y+440,x:x+384]!=[233,228,214],axis=2).sum()))
 if '-headphones-' not in path.name:continue
 with Image.open(out/path.name.replace('-headphones-','-bare-')) as image:bare=np.array(image.convert('RGB'))
 for i in range(36):
  x=(i%6)*384;y=52+(i//6)*470
  delta=np.abs(pixels[y+250:y+440,x:x+384].astype(int)-bare[y+250:y+440,x:x+384].astype(int))
  maximum_body_difference=max(maximum_body_difference,int(delta.max()))
assert minimum_foreground>500 and maximum_body_difference<=1
for name in ['lineup-24-2x.png','sofa-talk-2x.png','meeting-table-2x.png']:
 with Image.open(out/name) as image:assert image.width>=1440
 hashes[name]=hashlib.sha256((out/name).read_bytes()).hexdigest()
validation={'cases':864,'fullResolutionPages':24,'cellPixels':[384,440],'logicalCellPixels':[192,220],
 'minimumForegroundPixels':minimum_foreground,'maximumBodyPixelDifferenceWithHeadphonesOff':maximum_body_difference,
 'headphoneFallbackHairStyles':[1,3,5,10,11],'filesSHA256':hashes}
(out/'validation.json').write_text(json.dumps(validation,indent=2),encoding='utf-8')
lines=['# Character kit follow-up: 2x review','','[24-member lineup](lineup-24-2x.png) | [Sofa conversation](sofa-talk-2x.png) | [Actual meeting table](meeting-table-2x.png)','','The 24 full-resolution pages cover all 864 combinations: nine garments (including the producer coat), twelve hairstyles, headphones on/off, and four seated contexts. Each character render is 384 x 440 pixels for a 192 x 220 logical cell (2x). Furniture is omitted from the matrix so it cannot hide the hem. The actual studio close-ups above show furniture context.','','Meeting uses the runtime `sit_think` pose. Other poses are `sit_type`, `sofa_talk`, and `sit_lean_back`. Five hairstyles (1, 3, 5, 10, 11) use ear cups without a band. All other styles use their fitted curved strap.','','[Overview](seated-matrix-index.png) is reduced for navigation; the links below open the full 2x pages. [Coverage](coverage.json) and [validation](validation.json) record the complete Cartesian product and image integrity checks.','','| Pose | Garments | Headphones on | Headphones off |','| --- | --- | --- | --- |']
for pose in ['sit_type','sofa_talk','sit_lean_back','meeting']:
 for block,label in enumerate(['cardigan, hoodie, shirt','vest, blazer, fleece','tee, sweater, coat'],1):
  prefix=f'seated-{pose}-{block}'
  lines.append(f'| {pose} | {label} | [2x]({prefix}-headphones-2x.png) | [2x]({prefix}-bare-2x.png) |')
(out/'README.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print({k:v for k,v in validation.items() if k!='filesSHA256'})
