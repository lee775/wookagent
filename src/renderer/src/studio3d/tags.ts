export interface TagRectangle { x:number;y:number;width:number;height:number }

export function tagsOverlap(a:TagRectangle,b:TagRectangle,gap=2):boolean {
  return a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&
    a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y;
}

export function tagFits(candidate:TagRectangle,visible:readonly TagRectangle[]):boolean {
  return visible.every(other=>!tagsOverlap(candidate,other));
}

export function firstFittingTag(candidates:readonly TagRectangle[],placed:readonly TagRectangle[],
  protectedAreas:readonly TagRectangle[]):TagRectangle|undefined {
  return candidates.find(candidate=>tagFits(candidate,placed)&&tagFits(candidate,protectedAreas));
}

const nameOffsets=Array.from({length:44},(_,row)=>Array.from({length:81},(_,column)=>({dx:(column-40)*2,dy:6-row*2}))).flat()
  .sort((a,b)=>a.dx*a.dx+a.dy*a.dy-b.dx*b.dx-b.dy*b.dy||Math.abs(a.dx)-Math.abs(b.dx));

/** Keep the first name at its head; only move a lower-priority name as far as a collision requires. */
export function placeNameTag(head:{x:number;y:number;radius:number},size:{width:number;height:number},
  viewport:{width:number;height:number},placed:readonly TagRectangle[],protectedAreas:readonly TagRectangle[]) {
  const {width,height}=size;
  const x=Math.max(4,Math.min(viewport.width-width-4,head.x-width/2));
  const y=head.y-head.radius*1.15-height-4;
  for(const offset of nameOffsets){
    const candidate={x:x+offset.dx,y:y+offset.dy,width,height};
    if(candidate.x<4||candidate.y<4||candidate.x+width>viewport.width-4||candidate.y+height>viewport.height-4)continue;
    if(tagFits(candidate,placed)&&tagFits(candidate,protectedAreas))return candidate;
  }
}

export function placeDetailCard(size:{width:number;height:number},bounds:TagRectangle,name:TagRectangle,
  head:TagRectangle,protectedAreas:readonly TagRectangle[]):TagRectangle|undefined {
  const width=Math.min(size.width,bounds.width-12);
  const centre=name.x+name.width/2;
  for(const height of [...new Set([Math.min(size.height,bounds.height-12),140,110,88])]){
    if(height>bounds.height-12)continue;
    const positions=[
      {x:centre-width/2,y:head.y+head.height+8},
      {x:centre-width/2,y:name.y-height-8},
      {x:Math.max(name.x+name.width,head.x+head.width)+8,y:head.y-height/2},
      {x:Math.min(name.x,head.x)-width-8,y:head.y-height/2},
    ];
    for(let y=bounds.y+6;y+height<=bounds.y+bounds.height-6;y+=8)
      for(let x=bounds.x+6;x+width<=bounds.x+bounds.width-6;x+=16)positions.push({x,y});
    const candidates=positions.map(point=>({x:Math.max(bounds.x+6,Math.min(bounds.x+bounds.width-width-6,point.x)),
      y:Math.max(bounds.y+6,Math.min(bounds.y+bounds.height-height-6,point.y)),width,height}));
    const found=firstFittingTag(candidates,[],[name,head,...protectedAreas]);
    if(found)return found;
  }
}
