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
