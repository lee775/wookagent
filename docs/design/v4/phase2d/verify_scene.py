"""Repeatable real-browser probes of the shipped scene, including real pointer clicks."""
import argparse
import json
import math
from pathlib import Path
from browser_probe import CDP

OUTPUT=Path('docs/design/v4/phase2d')

def check(state,previous,mode):
    problems=[]
    count=state['expectedCount']
    if len(state['workstations'])!=count:problems.append('workstation count')
    if len(state['people'])!=count:problems.append('member count')
    if mode!='hiring' and state['characterCount']!=count:problems.append('character count')
    people=[person for person in state['people'] if person.get('activeClip')]
    for i,person in enumerate(people):
        for other in people[i+1:]:
            if math.hypot(person['x']-other['x'],person['z']-other['z'])<.449:problems.append(f'path overlap {person["id"]} {other["id"]}')
            if math.hypot(person['visualX']-other['visualX'],person['visualZ']-other['visualZ'])<.449:problems.append(f'visual overlap {person["id"]} {other["id"]}')
        if person['walking']:
            for box in state['footprints']:
                if box['minX']<person['x']<box['maxX'] and box['minZ']<person['z']<box['maxZ']:
                    problems.append(f'path furniture {person["id"]} {box["name"]}')
                if box['minX']<person['visualX']<box['maxX'] and box['minZ']<person['visualZ']<box['maxZ']:
                    problems.append(f'visual furniture {person["id"]} {box["name"]}')
        bounds=person.get('bounds')
        if bounds and (bounds['left']<0 or bounds['top']<0 or bounds['right']>state['camera']['width'] or bounds['bottom']>state['camera']['height']):
            problems.append(f'outside frame {person["id"]}')
        if previous and state['emergency'] and previous['emergency']:
            old=next((item for item in previous['people'] if item['id']==person['id']),None)
            if old and math.hypot(person['visualX']-old['visualX'],person['visualZ']-old['visualZ'])>.001:problems.append(f'freeze {person["id"]}')
    for place,capacity in [('coffee',2),('sofa',2),('window',2),('meeting',3)]:
        if sum(person['place']==place for person in people)>capacity:problems.append(f'capacity {place}')
    tags=[person['tagRect'] for person in people if person.get('tagRect')]
    for i,a in enumerate(tags):
        for b in tags[i+1:]:
            if a['x']<b['x']+b['width'] and a['x']+a['width']>b['x'] and a['y']<b['y']+b['height'] and a['y']+a['height']>b['y']:problems.append('tag overlap')
    return problems

def click_all(browser,state):
    results=[]
    for person in state['people']:
        browser.evaluate('window.advanceTime(0)')
        current=browser.evaluate('JSON.parse(window.render_game_to_text(true))')
        person=next(item for item in current['people'] if item['id']==person['id'])
        candidates=[]
        if person.get('tagRect'):
            tag=person['tagRect'];candidates.append({'x':tag['x']+tag['width']/2,'y':tag['y']+tag['height']/2})
        if person.get('clickPoint'):candidates.append(person['clickPoint'])
        passed=False
        for point in candidates:
            browser.call('Input.dispatchMouseEvent',{'type':'mouseMoved',**point})
            browser.evaluate('new Promise(requestAnimationFrame)')
            browser.call('Input.dispatchMouseEvent',{'type':'mousePressed','button':'left','clickCount':1,**point})
            browser.call('Input.dispatchMouseEvent',{'type':'mouseReleased','button':'left','clickCount':1,**point})
            result=browser.evaluate('new Promise(requestAnimationFrame).then(()=>({selected:JSON.parse(window.render_game_to_text(false)).selectedMember,panel:!!document.querySelector(".member-panel")}))')
            for _ in range(5):
                if result['selected']==person['id'] and result['panel']:break
                result=browser.evaluate('new Promise(requestAnimationFrame).then(()=>({selected:JSON.parse(window.render_game_to_text(false)).selectedMember,panel:!!document.querySelector(".member-panel")}))')
            passed=result['selected']==person['id'] and result['panel']
            browser.evaluate("document.querySelector('[aria-label=\"팀원 상세 닫기\"]')?.click()")
            browser.evaluate('new Promise(requestAnimationFrame)')
            if passed:break
        if not passed:print('CLICK FAILURE',person['id'],candidates,result,browser.evaluate('({selected:JSON.parse(window.render_game_to_text(false)).selectedMember,panel:!!document.querySelector(".member-panel")})'),flush=True)
        results.append({'id':person['id'],'passed':passed})
    return results

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--quick',action='store_true');parser.add_argument('--width',type=int)
    parser.add_argument('--modes',nargs='+',default=['cycle','hiring','team2','team20','team30'])
    parser.add_argument('--output',default='probe-results.json')
    args=parser.parse_args()
    browser=CDP(9232);browser.virtual_clock()
    results=[]
    for width in ([args.width] if args.width else [1100,1440,1920]):
        for mode in args.modes:
            browser.navigate(mode,width,900);browser.evaluate('window.advanceTime(0)')
            previous=None;violations=[];samples=0;minimum_torso=999
            duration=3 if args.quick else 88 if mode=='cycle' else 75 if mode=='hiring' else 4
            for tick in range(duration*25):
                state=browser.step(40,tick%25==0)
                minimum_torso=min(minimum_torso,*[p.get('headTorsoHeight',999) for p in state['people']])
                found=check(state,previous,mode)
                if found:violations.append({'time':state['time'],'problems':found})
                previous=state;samples+=1
            state=browser.evaluate('JSON.parse(window.render_game_to_text(true))')
            if mode=='hiring' and not args.quick and (state['characterCount']!=state['expectedCount'] or any(p['pose']!='seated' for p in state['people'])):
                violations.append({'time':state['time'],'problems':['hiring did not finish at every desk']})
            clicks=click_all(browser,state)
            result={'width':width,'mode':mode,'samples':samples,'violations':violations,
                'clicks':clicks,'minimumHeadTorsoPx':minimum_torso,'errors':browser.errors.copy(),
                'finalCharacters':state['characterCount'],'finalWorkstations':len(state['workstations']),
                'finalSeated':sum(p['pose']=='seated' for p in state['people'])}
            results.append(result)
            OUTPUT.joinpath(args.output).write_text(json.dumps(results,indent=2),encoding='utf-8')
            print(json.dumps({'width':width,'mode':mode,'samples':samples,'violations':len(violations),
                'first':violations[:2],'clicks':sum(item['passed'] for item in clicks),'total':len(clicks)}),flush=True)
    browser.ws.close()

if __name__=='__main__':main()
