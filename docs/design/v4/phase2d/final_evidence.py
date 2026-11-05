"""Validate recorded artifacts and summarize measured results without rerunning the browser."""
import json,statistics
from pathlib import Path
from PIL import Image
out=Path(__file__).resolve().parent
read=lambda name:json.loads((out/name).read_text(encoding='utf-8-sig'))
summary={}
for name in ['probe-results.json','probe-extra.json']:
    cases=read(name)
    assert len(cases)==(15 if name=='probe-results.json' else 6)
    assert all(not c['violations'] and not c['errors'] and all(p['passed'] for p in c['clicks']) for c in cases)
    summary[name]={'cases':len(cases),'samples':sum(c['samples'] for c in cases),'pointerClicks':sum(len(c['clicks']) for c in cases),'violations':0}
summary['videos']={}
for name in ['cycle','hiring']:
    r=read(f'{name}-frame-review.json');assert not r['violations'] and r['decodedFrames']==r['expectedFrames']
    if name=='hiring':assert r['finalCharacters']==r['finalWorkstations']==r['finalSeated']==14 and len(r['deskSetups'])==len(r['arrivals'])==11
    summary['videos'][name]={k:r[k] for k in ['fps','decodedFrames','bytes','finalCharacters','finalWorkstations','finalSeated']}
summary['performance']={}
for name in ['performance-final.json','performance-12-walkers-final.json','performance-49-walkers.json']:
    rows=read(name);groups={}
    for count in sorted(set(r['people'] for r in rows)):
        a=[r for r in rows if r['people']==count]
        assert all(r['actualPeople']==count and r['workstations']==count and not r['errors'] for r in a)
        groups[count]={'runs':len(a),'fpsMedian':statistics.median(r['fps'] for r in a),'fpsMin':min(r['fps'] for r in a),
            'busyMedian':statistics.median(r['busy'] for r in a),'busyMin':min(r['busy'] for r in a),'busyMax':max(r['busy'] for r in a)}
    summary['performance'][name]=groups
    if name!='performance-49-walkers.json':assert groups[20]['fpsMin']>=55 and groups[20]['busyMax']<=.15
sizes=read('size-measurements.json')
assert all(r['minimumStandingPx']>=64 and r['minimumSeatedHeadTorsoPx']>=36 for r in sizes if r['people']<=24)
summary['sizes']=[{k:r[k] for k in ['mode','people','minimumStandingPx','minimumSeatedHeadTorsoPx','stationMinX']} for r in sizes]
followup=(out/'kit-followup-vitest.log').exists()
test_bytes=(out/('kit-followup-vitest.log' if followup else 'vitest-final.log')).read_bytes()
test_log=test_bytes.decode('utf-16') if test_bytes.startswith((b'\xff\xfe',b'\xfe\xff')) else test_bytes.decode('utf-8-sig')
expected_tests,expected_files=(167,24) if followup else (157,23)
assert f'{expected_tests} passed ({expected_tests})' in test_log and f'{expected_files} passed ({expected_files})' in test_log
summary['rendererTests']={'filesPassed':expected_files,'testsPassed':expected_tests}
if followup:
    coverage=read('kit-followup/coverage.json');validation=read('kit-followup/validation.json')
    assert coverage['cases']==864 and not coverage['errors'] and validation['fullResolutionPages']==24
    summary['kitFollowup']={'cases':864,'pages':24,'cellPixels':validation['cellPixels'],
        'videoEvidence':'Original phase 2d, before the kit artifact follow-up'}
foot=read('foot-slide.json');assert foot['cycle']['afterPerStep']<=.041 and foot['reversal']['maxStep']<=.08
summary['footSlide']={k:{field:foot[k][field] for field in ['steps','afterPerStep','maxStep']} for k in ['cycle','reversal']}
mutations=read('mutation-results.json');assert len(mutations['results'])==13 and all(r['killed'] for r in mutations['results'])
summary['mutations']={'baseline':mutations['baseline'],'killed':13,'survived':0}
assets=read('asset-audit.json');assert assets['totalBytes']<=15_000_000;summary['assetBytes']=assets['totalBytes']
summary['images']={}
for name in ['lineup-24-2x.png','team2-1440.png','default-1440.png','team30-1440.png','sofa-talk-2x.png','hands-2x.png']:
    with Image.open(out/name) as picture:summary['images'][name]=list(picture.size)
summary['loading']=read('loading-membership.json');summary['removal']=read('removal-lifecycle.json')
assert summary['loading']['allInitiallySettled'] and summary['removal']['afterCharacters']==summary['removal']['afterWorkstations']==3
summary['smallProjectLifecycle']=read('small-project-lifecycle.json')
(out/'verification-summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False),encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k not in ['images','removal','smallProjectLifecycle']},indent=2))
