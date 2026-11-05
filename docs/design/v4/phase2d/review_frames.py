"""Extract consecutive native-pixel crops from the encoded 25 fps hiring video."""
from pathlib import Path
import cv2
from PIL import Image,ImageDraw

out=Path('docs/design/v4/phase2d')
video=cv2.VideoCapture(str(out/'hiring-25fps.webm'))
assert video.get(cv2.CAP_PROP_FPS)==25
for name,frame in [('hiring-first-setup',110),('hiring-last-setup',1110),('hiring-first-entry',120),('hiring-final-1440',1874)]:
    video.set(cv2.CAP_PROP_POS_FRAMES,frame);ok,picture=video.read();assert ok
    cv2.imwrite(str(out/f'{name}.png'),picture)
for name,start,box in [
    ('hiring-first-settle-25-frames',99,(710,470,1030,790)),
    ('hiring-first-entry-25-frames',120,(850,205,1100,490)),
    ('hiring-first-walk-25-frames',160,(790,220,1080,560)),
    ('hiring-last-settle-25-frames',1099,(225,420,625,790)),
]:
    x0,y0,x1,y1=box;width=x1-x0;height=y1-y0
    sheet=Image.new('RGB',(width*5,(height+22)*5),'#e9e4d6')
    draw=ImageDraw.Draw(sheet);video.set(cv2.CAP_PROP_POS_FRAMES,start)
    for index in range(25):
        ok,frame=video.read();assert ok
        image=Image.fromarray(cv2.cvtColor(frame[y0:y1,x0:x1],cv2.COLOR_BGR2RGB))
        x=(index%5)*width;y=(index//5)*(height+22)
        sheet.paste(image,(x,y));draw.text((x+5,y+height+4),f'{(start+index)/25:.2f}s / frame {start+index}',fill='#283f3a')
    sheet.save(out/f'{name}.png')
video.release()
