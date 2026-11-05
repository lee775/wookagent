"""Compose Blender character renders into a labeled 2x review sheet."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

here=Path(__file__).resolve().parent
tile_w,tile_h=480,640
sheet=Image.new('RGB',(13*tile_w,2*tile_h),(222,226,221))
draw=ImageDraw.Draw(sheet)
font_path=Path('C:/Windows/Fonts/malgun.ttf')
font=ImageFont.truetype(str(font_path),32) if font_path.exists() else ImageFont.load_default()
for index in range(1,14):
    for row,view in enumerate(('front','quarter')):
        image=Image.open(here/'lineup_parts'/f'person_{index:02d}_{view}.png').convert('RGBA')
        x=(index-1)*tile_w;y=row*tile_h
        sheet.paste(image,(x,y),image)
        draw.rectangle((x,y,x+tile_w-1,y+tile_h-1),outline=(177,188,179),width=2)
        draw.text((x+16,y+tile_h-56),f'{index:02d}  {view}',font=font,fill=(42,61,60))
sheet.save(here/'lineup-2x.png')
