import json
import time
from pathlib import Path
from browser_probe import CDP

browser=CDP(9232)
browser.navigate('team20')
time.sleep(2)
browser.call('Profiler.enable')
browser.call('Profiler.start')
time.sleep(3)
profile=browser.call('Profiler.stop')['profile']
Path('docs/design/v4/phase2d/runtime.cpuprofile').write_text(json.dumps(profile),encoding='utf-8')
counts={}
nodes={node['id']:node['callFrame'] for node in profile['nodes']}
for sample,delta in zip(profile.get('samples',[]),profile.get('timeDeltas',[])):
    node=nodes[sample]
    key=(node['functionName'],node['url'].split('?')[0])
    counts[key]=counts.get(key,0)+delta
print(sorted([(round(value/1000,1),*key) for key,value in counts.items()],reverse=True)[:25])
browser.ws.close()
