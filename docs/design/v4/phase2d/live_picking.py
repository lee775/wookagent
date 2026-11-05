"""Exercise the newcomer callback before its name tag appears."""
import json
from pathlib import Path
from browser_probe import CDP
from verify_scene import click_all

b=CDP(9232);b.virtual_clock();b.navigate('hiring');b.evaluate('window.advanceTime(0)')
results=[]
for frame in range(500):
    state=b.step(40,False)
    if frame not in [124,162,199,249,299,374,499]:continue
    state=b.evaluate('JSON.parse(window.render_game_to_text(true))')
    person=next(p for p in state['people'] if p['id']=='M-0016')
    result=click_all(b,{'people':[person]})[0]
    results.append({'time':state['time'],'pose':person['pose'],'clip':person['activeClip'],
        'tagVisible':person['tagRect'] is not None,**result})
    print(results[-1],flush=True)
Path('docs/design/v4/phase2d/live-picking.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
b.ws.close()
assert all(result['passed'] for result in results)
