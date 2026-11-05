"""Local Chrome DevTools probe. Run with python -B; profile belongs in OS temp."""
import argparse
import base64
import json
import time
import urllib.request
from pathlib import Path

from websockets.sync.client import connect


class CDP:
    def __init__(self, port):
        tabs=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
        page=next(tab for tab in tabs if tab['type']=='page')
        self.ws=connect(page['webSocketDebuggerUrl'],origin='http://localhost',legacy=True,max_size=50_000_000)
        self.counter=0
        self.errors=[]
        self.paused_requests=[]

    def call(self,method,params=None):
        self.counter+=1
        identifier=self.counter
        self.ws.send(json.dumps({'id':identifier,'method':method,'params':params or {}}))
        while True:
            message=json.loads(self.ws.recv(timeout=30))
            if message.get('method')=='Runtime.exceptionThrown':self.errors.append(message['params'])
            if message.get('method')=='Fetch.requestPaused':self.paused_requests.append(message['params'])
            if message.get('id')==identifier:
                if 'error' in message:raise RuntimeError(message['error'])
                return message.get('result',{})

    def evaluate(self,expression):
        result=self.call('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True})
        if 'exceptionDetails' in result:raise RuntimeError(result['exceptionDetails'])
        return result.get('result',{}).get('value')

    def navigate(self,mode,width=1440,height=900):
        self.call('Runtime.enable')
        self.call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':False})
        self.call('Page.navigate',{'url':f'http://127.0.0.1:5198/?officeDemo={mode}'})
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            try:
                state=self.evaluate('typeof window.render_game_to_text==="function"?JSON.parse(window.render_game_to_text(false)):null')
                if state and state['ready'] and len(state['workstations'])==state['expectedCount']:return state
            except RuntimeError:pass
            time.sleep(.1)
        raise RuntimeError({'notReady':self.evaluate('document.body.innerText.slice(0,1000)'),'errors':self.errors})

    def virtual_clock(self):
        self.call('Page.enable')
        self.call('Page.addScriptToEvaluateOnNewDocument',{'source':r'''
          (()=>{
            const NativeDate=Date,clock={now:NativeDate.now(),elapsed:0,intervals:[]};
            window.__studioClock=clock;
            window.Date=class extends NativeDate {
              constructor(...args){super(...(args.length?args:[clock.now]));}
              static now(){return clock.now;}
            };
            const interval=window.setInterval.bind(window);
            window.setInterval=(fn,delay,...args)=>{
              if(delay===1000){clock.intervals.push(()=>fn(...args));return -clock.intervals.length;}
              return interval(fn,delay,...args);
            };
            window.__studioStep=async(ms,detail=false)=>{
              const previous=Math.floor(clock.elapsed/1000);
              clock.now+=ms;clock.elapsed+=ms;
              for(let i=previous;i<Math.floor(clock.elapsed/1000);i++)for(const fn of clock.intervals)fn();
              await new Promise(requestAnimationFrame);
              window.advanceTime(ms);
              return JSON.parse(window.render_game_to_text(detail));
            };
          })();
        '''})

    def step(self,ms,detail=False):
        return self.evaluate(f'window.__studioStep({ms},{str(detail).lower()})')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=9232)
    parser.add_argument('--mode',default='cycle')
    parser.add_argument('--width',type=int,default=1440)
    parser.add_argument('--height',type=int,default=900)
    parser.add_argument('--seconds',type=float,default=0)
    parser.add_argument('--wait',type=float,default=0)
    parser.add_argument('--screenshot')
    args=parser.parse_args()
    browser=CDP(args.port)
    browser.call('Emulation.setDeviceMetricsOverride',{'width':args.width,'height':args.height,
        'deviceScaleFactor':1,'mobile':False})
    browser.call('Page.navigate',{'url':f'http://127.0.0.1:5198/?officeDemo={args.mode}'})
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        try:
            if browser.evaluate('(() => {if(typeof window.render_game_to_text!=="function")return false;'
                    'const s=JSON.parse(window.render_game_to_text(false));'
                    'return s.ready && s.workstations.length===s.expectedCount;})()'):
                break
        except RuntimeError:
            pass
        time.sleep(.15)
    else:
        print('NOT_READY',browser.evaluate('document.body.innerText.slice(0,1000)'))
        return 1
    if args.seconds:
        browser.evaluate(f'window.advanceTime({args.seconds*1000})')
    if args.wait:time.sleep(args.wait)
    state=browser.evaluate('JSON.parse(window.render_game_to_text(true))')
    summary={key:state.get(key) for key in ('ready','time','expectedCount','camera','problems')}
    summary['peopleCount']=len(state.get('people',[]))
    summary['workstationCount']=len(state.get('workstations',[]))
    summary['ids']=[person['id'] for person in state.get('people',[])]
    summary['minHeight']=min([person.get('screenHeight',0) for person in state.get('people',[])],default=0)
    summary['minHeadTorso']=min([person.get('headTorsoHeight',0) for person in state.get('people',[])],default=0)
    print(json.dumps(summary,ensure_ascii=False))
    if args.screenshot:
        image=browser.call('Page.captureScreenshot',{'format':'png','fromSurface':True})['data']
        Path(args.screenshot).write_bytes(base64.b64decode(image))
    browser.ws.close()
    return 0


if __name__=='__main__':raise SystemExit(main())
