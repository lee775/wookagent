"""Capture the complete 9 x 12 x 2 x 4 seated kit matrix through the real assembler."""
import base64,io,json
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from browser_probe import CDP
from capture_evidence import lineup,closeups,screenshot
out=Path('docs/design/v4/phase2d');pages=out/'kit-followup';pages.mkdir(exist_ok=True)
b=CDP(9232);b.virtual_clock();b.navigate('team24');b.evaluate('window.advanceTime(0)')
b.evaluate('window.__kitReview=import("/src/studio3d/kitReview.ts")')
pose_clips=b.evaluate('window.__kitReview.then(m=>Object.fromEntries(m.seatedReviewPoses.map(p=>[p.name,p.clip])))')
assert pose_clips=={'sit_type':'sit_type','sofa_talk':'sofa_talk','sit_lean_back':'sit_lean_back','meeting':'sit_think'}
garments=['cardigan','hoodie','shirt','vest','blazer','fleece','tee_long','sweater','producer']
poses=['sit_type','sofa_talk','sit_lean_back','meeting'];manifest=[];font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',18)
for pose_index,pose in enumerate(poses):
 for block in range(3):
  for headphones in [False,True]:
   sheet=Image.new('RGB',(384*6,52+470*6),'#e9e4d6');draw=ImageDraw.Draw(sheet)
   title=f'{pose} | headphones {"ON" if headphones else "OFF"} | 2x (384 x 440 per render)'
   draw.text((16,16),title,font=font,fill='#354b47')
   rows=[]
   for garment_index,garment in enumerate(garments[block*3:block*3+3]):
    for hair in range(12):
     raw=b.evaluate(f'window.__kitReview.then(m=>m.renderSeatedReview({json.dumps(garment)},{hair},{str(headphones).lower()},{pose_index}))')
     picture=Image.open(io.BytesIO(base64.b64decode(raw.split(',')[1]))).convert('RGB')
     x=(hair%6)*384;y=52+(garment_index*2+hair//6)*470
     sheet.paste(picture,(x,y));mode='cups' if hair in [1,3,5,10,11] else 'curve'
     draw.text((x+10,y+442),f'{garment} / hair {hair:02} / {mode if headphones else "bare"}',font=font,fill='#354b47')
     rows.append({'garment':garment,'hair':hair,'headphones':headphones,'pose':pose,'mode':mode if headphones else 'none'})
   name=f'seated-{pose}-{block+1}-{"headphones" if headphones else "bare"}-2x.png'
   sheet.save(pages/name);manifest.append({'file':name,'width':sheet.width,'height':sheet.height,'cases':rows});print(name,len(rows),flush=True)
b.evaluate('window.__kitReview.then(m=>m.disposeSeatedReview())')
assert len(manifest)==24 and sum(len(p['cases']) for p in manifest)==864
assert len({(c['garment'],c['hair'],c['headphones'],c['pose']) for p in manifest for c in p['cases']})==864
index=Image.new('RGB',(384*6,480*4),'#e9e4d6');draw=ImageDraw.Draw(index)
for i,p in enumerate(manifest):
 image=Image.open(pages/p['file']);image.thumbnail((384,440));x=(i%6)*384;y=(i//6)*480
 index.paste(image,(x,y));draw.text((x+4,y+442),p['file'].replace('seated-','').replace('-2x.png',''),font=font,fill='#354b47')
index.save(pages/'seated-matrix-index.png')
lineup(b);closeups(b)
b.navigate('cycle');b.evaluate('window.advanceTime(0)')
for _ in range(82):state=b.step(1000,False)
meeting=next(p for p in state['people'] if p['place']=='meeting' and p['pose']=='seated')
b.evaluate(f'window.studio3dCapture({json.dumps(meeting["id"])},undefined,4.5,"side")')
screenshot(b,pages/'meeting-table-2x.png')
# Copy the reviewed images to versioned names, keeping the original acceptance links current.
for name in ['lineup-24-2x.png','sofa-talk-2x.png']:(pages/name).write_bytes((out/name).read_bytes())
(pages/'coverage.json').write_text(json.dumps({'cases':864,'garments':9,'hairstyles':12,'headphoneStates':2,'poseContexts':4,'poseClips':pose_clips,'pages':manifest,'errors':b.errors},indent=2),encoding='utf-8')
b.ws.close();assert not b.errors
