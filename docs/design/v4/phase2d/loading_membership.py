"""Keep GLBs pending while hiring advances, then verify the first scene uses the latest roster."""
import json
import time
from pathlib import Path
from browser_probe import CDP

b=CDP(9232);b.virtual_clock();b.call('Runtime.enable');b.call('Network.enable')
b.call('Network.setCacheDisabled',{'cacheDisabled':True})
b.call('Fetch.enable',{'patterns':[{'urlPattern':'*studio3d/*.glb','requestStage':'Request'}]})
b.call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':900,'deviceScaleFactor':1,'mobile':False})
b.call('Page.navigate',{'url':'http://127.0.0.1:5198/?officeDemo=hiring'})
deadline=time.monotonic()+30
while not b.evaluate('typeof window.advanceTime==="function"'):
    assert time.monotonic()<deadline
    time.sleep(.02)
before=b.step(20000,False)
while before['expectedCount']!=8 and time.monotonic()<deadline:
    b.evaluate('new Promise(requestAnimationFrame)')
    before=b.evaluate('JSON.parse(window.render_game_to_text(false))')
print({'readyBeforeRelease':before['ready'],'expectedBeforeRelease':before['expectedCount'],'paused':len(b.paused_requests)},flush=True)
assert not before['ready'] and before['expectedCount']==8
released=set()
while True:
    for request in b.paused_requests.copy():
        if request['requestId'] not in released:
            released.add(request['requestId']);b.call('Fetch.continueRequest',{'requestId':request['requestId']})
    state=b.evaluate('JSON.parse(window.render_game_to_text(false))')
    if state['ready']:break
    assert time.monotonic()<deadline
    time.sleep(.02)
b.evaluate('window.advanceTime(0)');state=b.evaluate('JSON.parse(window.render_game_to_text(false))')
result={'pausedGLBs':len(released),'membersBeforeAssetReady':before['expectedCount'],
    'membersAtFirstScene':state['expectedCount'],'workstations':len(state['workstations']),
    'characters':state['characterCount'],'allInitiallySettled':all(s['settle']==1 for s in state['workstations']),
    'errors':b.errors}
Path('docs/design/v4/phase2d/loading-membership.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
b.call('Fetch.disable');b.ws.close();print(result)
assert result['membersAtFirstScene']==result['workstations']==result['characters']==8
assert result['allInitiallySettled'] and not result['errors']
