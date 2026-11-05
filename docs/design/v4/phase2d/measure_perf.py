"""Measure rAF throughput and renderer main-thread TaskDuration on the real studio."""
import argparse
import json
import time
from pathlib import Path
from browser_probe import CDP


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=9232)
    parser.add_argument('--runs',type=int,default=5)
    parser.add_argument('--seconds',type=float,default=5)
    parser.add_argument('--walkers',type=int,default=0)
    parser.add_argument('--counts',nargs='+',type=int,default=[20,30])
    parser.add_argument('--output',default='docs/design/v4/phase2d/performance.json')
    args=parser.parse_args()
    browser=CDP(args.port)
    browser.call('Performance.enable')
    runs=[]
    for repeat in range(args.runs):
        for count in args.counts:
            browser.navigate(f'team{count}'+('&perfWalk=1' if args.walkers else ''))
            if args.walkers:browser.evaluate(f'window.studio3dPerfWalk(true,{args.walkers})')
            time.sleep(1)
            gpu=browser.evaluate('(() => {const c=document.querySelector(".office-scene canvas").getContext("webgl2");'
                'const e=c.getExtension("WEBGL_debug_renderer_info");return e?c.getParameter(e.UNMASKED_RENDERER_WEBGL):"unknown";})()')
            before={item['name']:item['value'] for item in browser.call('Performance.getMetrics')['metrics']}
            frames=browser.evaluate('new Promise(resolve=>{let count=0;const start=performance.now();'
                f'function frame(){{count++;const elapsed=performance.now()-start;if(elapsed>={args.seconds*1000})'
                '{resolve({frames:count,seconds:elapsed/1000,fps:count/(elapsed/1000)});}else requestAnimationFrame(frame);}'
                'requestAnimationFrame(frame);})')
            after={item['name']:item['value'] for item in browser.call('Performance.getMetrics')['metrics']}
            state=browser.evaluate('JSON.parse(window.render_game_to_text(false))')
            result={'people':count,'requestedWalkers':args.walkers,'repeat':repeat+1,'gpu':gpu,**frames,
                'busy':(after['TaskDuration']-before['TaskDuration'])/(after['Timestamp']-before['Timestamp']),
                'render':state['render'],'actualPeople':state['characterCount'],
                'walkingAtEnd':sum(person['walking'] for person in state['people']),
                'locomotionAtEnd':sum(person['activeClip'] in ['walk','walk_folder','turn_left','turn_right'] for person in state['people']),
                'workstations':len(state['workstations']),'errors':browser.errors.copy()}
            runs.append(result)
            Path(args.output).write_text(json.dumps(runs,indent=2),encoding='utf-8')
            print(json.dumps(result),flush=True)
    browser.ws.close()


if __name__=='__main__':main()
