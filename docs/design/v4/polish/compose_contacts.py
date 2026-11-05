"""Compose and remove the temporary tiles rendered by render_contact_sheets.py."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

here=Path(__file__).resolve().parent
parts=here/'contact_parts'
font_path=Path('C:/Windows/Fonts/malgun.ttf')
font=ImageFont.truetype(str(font_path),17) if font_path.exists() else ImageFont.load_default()
for person in range(1,14):
    files=sorted(parts.glob(f'person_{person:02d}_*.png'))
    pairs={}
    for path in files:
        stem=path.stem.removeprefix(f'person_{person:02d}_')
        clip,kind,frame=stem.rsplit('_',2)
        pairs.setdefault(clip,{})[kind]=(path,int(frame))
    assert len(pairs)==23 and all(set(value)=={'first','extreme','last'} for value in pairs.values())
    sheet=Image.new('RGB',(9*320,8*450),(224,228,224))
    draw=ImageDraw.Draw(sheet)
    for pair_number,(clip,pair) in enumerate(sorted(pairs.items())):
        for column_offset,kind in enumerate(('first','extreme','last')):
            tile=pair_number*3+column_offset
            x=(tile%9)*320;y=(tile//9)*450
            path,frame=pair[kind]
            image=Image.open(path).convert('RGBA')
            sheet.paste(image,(x,y),image)
            draw.rectangle((x,y,x+319,y+449),outline=(150,162,153),width=2)
            draw.text((x+8,y+420),f'{clip}  {kind} f{frame}',font=font,fill=(36,50,43))
    sheet.save(here/f'contact-person_{person:02d}-2x.png')
    for path in files:path.unlink()
parts.rmdir()
