import json
from browser_probe import CDP
from capture_evidence import screenshot
b=CDP(9232);b.virtual_clock();b.navigate('cycle');b.evaluate('window.advanceTime(0)')
for _ in range(82):state=b.step(1000,False)
p=next(p for p in state['people'] if p['place']=='meeting' and p['pose']=='seated')
b.evaluate(f'window.studio3dCapture({json.dumps(p["id"])},undefined,4.5,"side")')
screenshot(b,'docs/design/v4/phase2d/kit-followup/meeting-table-2x.png');print(p['id'],p['clip'],p['place'],b.errors);b.ws.close()
