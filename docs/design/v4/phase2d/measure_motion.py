import json
from pathlib import Path
from browser_probe import CDP

browser=CDP(9232)
results={'method':'Sum planar planted-foot bone travel during the authored contact window; report mean per contact and maximum single contact.','unit':'metres'}
for name,seconds,stress in [('cycle',88,False),('reversal',15,True)]:
    browser.navigate('cycle&perfWalk=1')
    browser.evaluate('window.advanceTime(0)')
    if stress:browser.evaluate('window.studio3dPerfWalk(true)')
    for _ in range(int(seconds)):
        browser.evaluate('window.advanceTime(1000)')
    state=browser.evaluate('JSON.parse(window.render_game_to_text(false))')
    foot=state['footSlide']
    results[name]={**foot,'beforePerStep':foot['before']/max(1,foot['steps']),
        'afterPerStep':foot['after']/max(1,foot['steps'])}
    print(name,json.dumps(results[name]),flush=True)
Path('docs/design/v4/phase2d/foot-slide.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
browser.ws.close()
