"""Check small-office framing after the first new hire sits, and project teardown."""
import base64,json
from pathlib import Path
from browser_probe import CDP
from verify_scene import click_all
out=Path('docs/design/v4/phase2d')
b=CDP(9232);b.virtual_clock();b.navigate('hiring');b.evaluate('window.advanceTime(0)')
for _ in range(100):b.step(40)
b.evaluate('new Promise(requestAnimationFrame)')
for _ in range(750):b.evaluate('window.advanceTime(40)')
s=b.evaluate('JSON.parse(window.render_game_to_text(true))')
assert s['expectedCount']==4 and s['characterCount']==4 and len(s['workstations'])==4
assert all(p['pose']=='seated' for p in s['people'])
clicks=click_all(b,s);assert all(c['passed'] for c in clicks)
standing=b.evaluate('window.studio3dMeasureStanding()');assert min(p['height'] for p in standing)>130
m=b.evaluate('JSON.parse(window.render_game_to_text(true))')
print(json.dumps({'people':4,'heights':standing}),flush=True)
out.joinpath('small-team-after-arrival.png').write_bytes(base64.b64decode(b.call('Page.captureScreenshot',{'format':'png'})['data']))
buttons=b.evaluate('[...document.querySelectorAll("button")].map(x=>x.textContent).filter(x=>x.includes("책방")||x.includes("스튜디오"))')
print(buttons,flush=True)
results={'smallArrival':{'count':4,'seated':4,'standing':standing,'clicks':clicks},'projectSwitch':[]}
for name in ['동네 산책 기록장','열두 팀원 스튜디오']:
    assert b.evaluate(f'(()=>{{const e=[...document.querySelectorAll("button")].find(x=>x.textContent.includes({json.dumps(name)}));e?.click();return !!e;}})()')
    for _ in range(40):
        b.evaluate('new Promise(requestAnimationFrame)')
        s=b.evaluate('typeof window.render_game_to_text==="function"?JSON.parse(window.render_game_to_text(true)):null')
        if s and s['ready'] and s['expectedCount']==s['characterCount'] and len(s['workstations'])==s['expectedCount']:break
    for _ in range(15):b.evaluate('new Promise(requestAnimationFrame)')
    b.evaluate('window.advanceTime(0)');s=b.evaluate('JSON.parse(window.render_game_to_text(true))')
    assert s['characterCount']==s['expectedCount']==len(s['workstations'])
    assert all(p['settle']==1 for p in s['workstations'])
    c=click_all(b,s);print(name,c,flush=True);assert all(p['passed'] for p in c)
    results['projectSwitch'].append({'name':name,'projectId':s['projectId'],'count':s['characterCount'],'clicks':c})
out.joinpath('small-project-lifecycle.json').write_text(json.dumps(results,indent=2,ensure_ascii=False),encoding='utf-8')
b.ws.close()

