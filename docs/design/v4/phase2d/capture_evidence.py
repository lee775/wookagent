"""Capture the actual renderer at 25 fps and build native-resolution review artifacts."""
import argparse
import base64
import io
import json
import math
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from browser_probe import CDP
from verify_scene import check

OUT=Path('docs/design/v4/phase2d')

def screenshot(browser,path=None):
    raw=base64.b64decode(browser.call('Page.captureScreenshot',{'format':'png','fromSurface':True})['data'])
    if path:Path(path).write_bytes(raw)
    return raw

def stills(browser):
    measurements=[]
    for mode in ['team2','cycle','team20','team24','team30','team50']:
        browser.navigate(mode);browser.evaluate('window.advanceTime(0)');state=browser.step(200,True)
        screenshot(browser,OUT/('default-1440.png' if mode=='cycle' else f'{mode}-1440.png'))
        standing=browser.evaluate('window.studio3dMeasureStanding()')
        measurements.append({'mode':mode,'people':state['characterCount'],'workstations':len(state['workstations']),
            'minimumSeatedHeadTorsoPx':min(p['headTorsoHeight'] for p in state['people']),
            'minimumStandingPx':min(p['height'] for p in standing),
            'stationMinX':min(p['x'] for p in state['workstations']),
            'standing':standing})
    OUT.joinpath('size-measurements.json').write_text(json.dumps(measurements,indent=2),encoding='utf-8')
    print('stills and size measurements captured',flush=True)

def lineup(browser):
    browser.navigate('team24');browser.evaluate('window.advanceTime(0)')
    members=browser.evaluate('window.studio3dLineup()')
    sheet=Image.new('RGB',(384*6,520*4),'#e9e4d6')
    draw=ImageDraw.Draw(sheet)
    font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',18)
    for index,member in enumerate(members):
        picture=Image.open(io.BytesIO(base64.b64decode(member['image'].split(',')[1]))).convert('RGBA')
        x=(index%6)*384;y=(index//6)*520
        sheet.paste(picture,(x,y),picture)
        draw.text((x+16,y+482),f'{member["id"]}  {member["role"]}',font=font,fill='#354b47')
    sheet.save(OUT/'lineup-24-2x.png')
    print('24-member 2x lineup captured',flush=True)

def closeups(browser):
    browser.navigate('cycle');browser.evaluate('window.advanceTime(0)')
    for _ in range(82):state=browser.step(1000,False)
    sofa=next(p for p in state['people'] if p['place']=='sofa' and p['pose']=='seated')
    browser.evaluate(f'window.studio3dCapture({json.dumps(sofa["id"])},undefined,4.5,"front")')
    screenshot(browser,OUT/'sofa-talk-2x.png')
    browser.navigate('cycle');browser.evaluate('window.advanceTime(0)');browser.step(500)
    browser.evaluate('window.studio3dCapture("M-0018",undefined,7,"side")')
    screenshot(browser,OUT/'hands-2x.png')
    print('sofa and hand close-ups captured',flush=True)

def video(browser,mode,seconds):
    browser.navigate(mode);browser.evaluate('window.advanceTime(0)')
    destination=OUT/('cycle-88s-25fps.webm' if mode=='cycle' else 'hiring-25fps.webm')
    encoder=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','image2pipe','-vcodec','png',
        '-r','25','-i','-','-an','-c:v','libvpx-vp9','-crf','31','-b:v','0','-pix_fmt','yuv420p',str(destination)],stdin=subprocess.PIPE)
    previous=None;violations=[];arrivals=[];known=set();last_count=0;max_motion=0;setups=[]
    contact=Image.new('RGB',(360*6,225*4),'#e9e4d6');sheet_index=0;cells=0
    for frame in range(seconds*25):
        state=browser.step(40,False)
        problems=check(state,previous,mode)
        old_stations={station['id']:station for station in previous['workstations']} if previous else {}
        for station in state['workstations']:
            old=old_stations.get(station['id'])
            if old and old['settle']<1:
                if station['settle']<old['settle'] or station['settle']-old['settle']>.06:problems.append('desk settle time jump')
                if station['y']>old['y']+.001 or old['y']-station['y']>.015:problems.append('desk settle position jump')
            elif not old and frame>0:
                setups.append({'frame':frame,'id':station['id'],'y':station['y'],'settle':station['settle']})
                if station['settle']>.12 or station['y']<.14:problems.append('desk appeared already settled')
        for person in state['people']:
            if person.get('activeClip') and person['id'] not in known:
                if frame>0:
                    arrivals.append({'frame':frame,'id':person['id'],'x':person['x'],'z':person['z'],'hipHeight':person['hipHeight']})
                    if math.hypot(person['x']-state['entryDoor']['x'],person['z']-state['entryDoor']['z'])>.15:problems.append('newcomer did not enter at door')
                    if person['hipHeight']<.8:problems.append('newcomer entered in a seated pose')
                known.add(person['id'])
            if previous:
                old=next((p for p in previous['people'] if p['id']==person['id'] and p.get('activeClip')),None)
                if old and person.get('activeClip'):
                    max_motion=max(max_motion,((person['visualX']-old['visualX'])**2+(person['visualZ']-old['visualZ'])**2)**.5)
        if problems:violations.append({'frame':frame,'time':state['time'],'problems':problems})
        raw=screenshot(browser);encoder.stdin.write(raw)
        if frame%25==0:
            thumb=Image.open(io.BytesIO(raw)).convert('RGB').resize((360,225))
            ImageDraw.Draw(thumb).text((4,4),f'{frame/25:.0f}s / {state["expectedCount"]}',fill='black')
            contact.paste(thumb,((cells%6)*360,(cells//6)*225));cells+=1
            if cells==24 or frame//25==seconds-1:
                contact.save(OUT/f'{mode}-contact-{sheet_index:02}.png');sheet_index+=1;cells=0
                contact=Image.new('RGB',(360*6,225*4),'#e9e4d6')
        if state['expectedCount']!=last_count:
            print(mode,'frame',frame,'members',state['expectedCount'],flush=True);last_count=state['expectedCount']
        previous=state
    encoder.stdin.close()
    if encoder.wait()!=0:raise RuntimeError('Video encoding failed')
    capture=cv2.VideoCapture(str(destination));decoded=0;differences=[];last=None
    while True:
        ok,frame=capture.read()
        if not ok:break
        crop=cv2.cvtColor(frame[200:790,225:1390],cv2.COLOR_BGR2GRAY)
        if last is not None:differences.append(float(np.abs(crop.astype(float)-last.astype(float)).mean()))
        last=crop;decoded+=1
    capture.release()
    review={'mode':mode,'fps':25,'expectedFrames':seconds*25,'decodedFrames':decoded,'violations':violations,
        'arrivals':arrivals,'deskSetups':setups,'maximumRootTravelPer40ms':max_motion,'maximumSceneDifference255':max(differences,default=0),
        'bytes':destination.stat().st_size,'finalCharacters':state['characterCount'],
        'finalWorkstations':len(state['workstations']),'finalSeated':sum(p['pose']=='seated' for p in state['people'])}
    if mode=='hiring' and (state['characterCount']!=14 or review['finalSeated']!=14):
        violations.append({'frame':seconds*25-1,'time':state['time'],'problems':['hiring did not finish at every desk']})
    OUT.joinpath(f'{mode}-frame-review.json').write_text(json.dumps(review,indent=2),encoding='utf-8')
    print(mode,'video complete',decoded,'frames',len(violations),'violations',flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--part',choices=['stills','lineup','closeups','cycle','hiring','all'],default='all')
    parser.add_argument('--port',type=int,default=9232)
    args=parser.parse_args();browser=CDP(args.port);browser.virtual_clock()
    if args.part in ('all','stills'):stills(browser)
    if args.part in ('all','lineup'):lineup(browser)
    if args.part in ('all','closeups'):closeups(browser)
    if args.part in ('all','cycle'):video(browser,'cycle',88)
    if args.part in ('all','hiring'):video(browser,'hiring',75)
    browser.ws.close()

if __name__=='__main__':main()
