import json
from browser_probe import CDP
from verify_scene import click_all

b=CDP(9232);b.virtual_clock();b.navigate('team30',1100);b.evaluate('window.advanceTime(0)')
for _ in range(100):b.step(40,False)
state=b.evaluate('JSON.parse(window.render_game_to_text(true))')
results=click_all(b,state)
for result in results:
    if result['passed']:continue
    person=next(p for p in state['people'] if p['id']==result['id'])
    point=person['clickPoint']
    element=b.evaluate('document.elementFromPoint(%s,%s)?.outerHTML.slice(0,500)'%(point['x'],point['y']))
    print(json.dumps({'id':person['id'],'tag':person['tagRect'],'head':point,'element':element},ensure_ascii=False))
    found=None
    for dy in [0,-3,-6,-9,3,6]:
        for dx in [0,-3,3,-6,6]:
            at={'x':point['x']+dx,'y':point['y']+dy}
            b.call('Input.dispatchMouseEvent',{'type':'mousePressed','button':'left','clickCount':1,**at})
            b.call('Input.dispatchMouseEvent',{'type':'mouseReleased','button':'left','clickCount':1,**at})
            selected=b.evaluate('new Promise(requestAnimationFrame).then(()=>JSON.parse(window.render_game_to_text(false)).selectedMember)')
            b.evaluate("document.querySelector('.member-panel button[aria-label]')?.click()")
            b.evaluate('new Promise(requestAnimationFrame)')
            if selected==person['id']:found=at;break
        if found:break
    print('visible hit',found)
b.ws.close()
