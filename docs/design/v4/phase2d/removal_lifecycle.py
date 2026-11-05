"""Remove the first hired member using a fake-clock roster rewind; inspect the whole departure."""
import json,math
from pathlib import Path
from browser_probe import CDP
b=CDP(9232);b.virtual_clock();b.navigate('hiring');b.evaluate('window.advanceTime(0)')
for _ in range(100):b.step(40)
for _ in range(750):b.evaluate('window.advanceTime(40)')
before=b.evaluate('JSON.parse(window.render_game_to_text(true))');assert before['characterCount']==4
b.evaluate('window.__studioClock.now-=4000;window.__studioClock.intervals.forEach(fn=>fn())')
for _ in range(5):b.evaluate('new Promise(requestAnimationFrame)')
phases=set();nearest=999;last=None;samples=0
for _ in range(1500):
    b.evaluate('window.advanceTime(40)');s=b.evaluate('JSON.parse(window.render_game_to_text(false))');samples+=1
    p=next((p for p in s['people'] if p['id']=='M-0016'),None)
    if not p:break
    phases.add(p['pose']);nearest=min(nearest,math.hypot(p['x']-s['entryDoor']['x'],p['z']-s['entryDoor']['z']))
    last=p
assert s['expectedCount']==3 and s['characterCount']==3 and len(s['workstations'])==3
assert 'rising' in phases and 'walking' in phases and nearest<.15
result={'beforeCharacters':4,'beforeWorkstations':4,'afterCharacters':s['characterCount'],
    'afterWorkstations':len(s['workstations']),'phases':sorted(phases),'nearestDoorMetres':nearest,
    'samples':samples,'lastDeparture':last,'errors':b.errors}
Path('docs/design/v4/phase2d/removal-lifecycle.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
b.ws.close();print(result)
