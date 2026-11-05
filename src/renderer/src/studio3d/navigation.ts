import { Box3, Mesh, Object3D, Vector3 } from 'three';
import { homeForAsset } from './placement';

export interface FloorPoint { x: number; z: number }
export interface Footprint { name: string; minX: number; maxX: number; minZ: number; maxZ: number }

const solidName = /^(?:meeting table top|meeting top|coffee counter|coffee cabinet|sofa plinth|sofa seat|coffee table|printer body|water cooler base|phone booth)/i;
const radius = .21;
const cell = .25;
const rectangle = (name:string,x:number,z:number,width:number,depth:number):Footprint =>
  ({name,minX:x-width/2,maxX:x+width/2,minZ:z-depth/2,maxZ:z+depth/2});
// The static room is merged by material; these authored top surfaces are the
// navigable plan. The room GLB geometry check in behaviour.test.ts guards drift.
export const sharedFootprints:Footprint[] = [
  rectangle('coffee alcove wall',2.475,-3.38,3.35,.13),
  rectangle('meeting table',-.35,3.31,1.5,.76),
  rectangle('coffee counter',2.78,-2.72,2.37,.72),
  rectangle('sofa',2.58,1.63,2,.74),
  rectangle('coffee table',2.57,2.67,1.32,.65),
  rectangle('storage shelves',-3.10,-4.82,1.13,.38),
  rectangle('printer',3.58,-2.61,.52,.44),
  rectangle('water cooler',4.89,-2.20,.36,.36),
  rectangle('phone booth',4.77,-.19,1.48,1.55),
  ...[[-3.73,2.63],[3.76,2.84],[3.92,-1.20],[-8.65,-4.26],[-1.79,4.18],[4.84,-4.47]]
    .map(([x,z],index)=>rectangle(`planter ${index}`,x,z,.40,.40)),
];
export function workstationFootprints(count:number):Footprint[] {
  return workstationFootprintsForAssets(Array.from({length:count},(_,index)=>index===0?13:index<13?index:index+1));
}
export function workstationFootprintsForAssets(assets:readonly number[],lAssets:ReadonlySet<number>=new Set()):Footprint[] {
  return assets.flatMap(asset=>{
    const seat=homeForAsset(asset);
    const name=asset===13?'producer':`desk ${asset}`;
    const x=seat.x+Math.sin(seat.yaw)*.6,z=seat.z+Math.cos(seat.yaw)*.6;
    const rotated=Math.abs(Math.sin(seat.yaw))>.7;
    const boxes=[rectangle(`${name} top`,x,z,rotated?.69:1.3,rotated?1.3:.69),
      rectangle(`${name} chair`,seat.x,seat.z,.52,.48)];
    if(lAssets.has(asset))boxes.push(rectangle(`${name} return`,
      seat.x-.56*Math.cos(seat.yaw)+.09*Math.sin(seat.yaw),
      seat.z+.56*Math.sin(seat.yaw)+.09*Math.cos(seat.yaw),rotated?.84:.48,rotated?.48:.84));
    return boxes;
  });
}
export const authoredFootprints:Footprint[]=[...sharedFootprints,...workstationFootprints(13)];

export function roomFootprints(room: Object3D): Footprint[] {
  room.updateMatrixWorld(true);
  const result: Footprint[] = [];
  room.traverse(object => {
    if (!(object instanceof Mesh) || !solidName.test(object.name)) return;
    const box = new Box3().setFromObject(object);
    const size = box.getSize(new Vector3());
    if (size.x < .2 || size.z < .2 || box.max.y < .25) return;
    result.push({ name: object.name, minX: box.min.x, maxX: box.max.x,
      minZ: box.min.z, maxZ: box.max.z });
  });
  return result.length?result:sharedFootprints;
}

function inside(point: FloorPoint, box: Footprint, margin = radius): boolean {
  return point.x > box.minX-margin && point.x < box.maxX+margin &&
    point.z > box.minZ-margin && point.z < box.maxZ+margin;
}

export function segmentCrossesFootprint(a: FloorPoint, b: FloorPoint, box: Footprint, margin = radius): boolean {
  const dx = b.x-a.x, dz = b.z-a.z;
  let enter = 0, leave = 1;
  for (const [p,q] of [[-dx,a.x-box.minX+margin],[dx,box.maxX+margin-a.x],
    [-dz,a.z-box.minZ+margin],[dz,box.maxZ+margin-a.z]]) {
    if (Math.abs(p) < 1e-8) { if (q < 0) return false; continue; }
    const t = q/p;
    if (p < 0) enter = Math.max(enter,t); else leave = Math.min(leave,t);
    if (enter > leave) return false;
  }
  return true;
}

export class NavigationGrid {
  readonly footprints: Footprint[];
  private readonly minX:number;
  private readonly minZ:number;
  private readonly cols:number;
  private readonly rows:number;
  private readonly open: Uint8Array;

  constructor(footprints: Footprint[]) {
    this.footprints = footprints;
    this.minX=Math.min(-9.1,...footprints.map(box=>box.minX-.25));
    this.minZ=-4.95;
    this.cols=Math.ceil((5.55-this.minX)/cell)+1;
    this.rows=Math.ceil((5.25-this.minZ)/cell)+1;
    this.open = new Uint8Array(this.cols*this.rows);
    for (let z=0;z<this.rows;z++) for (let x=0;x<this.cols;x++) {
      const point=this.point(x,z);
      this.open[z*this.cols+x] = footprints.some(box=>inside(point,box)) ? 0 : 1;
    }
  }
  private point(x:number,z:number):FloorPoint { return {x:this.minX+x*cell,z:this.minZ+z*cell}; }
  private nearest(point:FloorPoint):number {
    const cx=Math.max(0,Math.min(this.cols-1,Math.round((point.x-this.minX)/cell)));
    const cz=Math.max(0,Math.min(this.rows-1,Math.round((point.z-this.minZ)/cell)));
    let best=-1,bestDistance=Infinity;
    for(let ring=0;ring<12;ring++) {
      for(let dz=-ring;dz<=ring;dz++) for(let dx=-ring;dx<=ring;dx++) {
        if(Math.max(Math.abs(dx),Math.abs(dz))!==ring)continue;
        const x=cx+dx,z=cz+dz,index=z*this.cols+x;
        if(x<0||z<0||x>=this.cols||z>=this.rows||!this.open[index])continue;
        const candidate=this.point(x,z),distance=Math.hypot(candidate.x-point.x,candidate.z-point.z);
        if(distance<bestDistance){best=index;bestDistance=distance;}
      }
      if(best>=0)return best;
    }
    return -1;
  }
  route(from:FloorPoint,to:FloorPoint):FloorPoint[] {
    if(Math.hypot(from.x-to.x,from.z-to.z)<.03)return [];
    const start=this.nearest(from),end=this.nearest(to);
    if(start<0||end<0)return [];
    const count=this.open.length,score=new Float32Array(count).fill(Infinity),previous=new Int32Array(count).fill(-1);
    const visited=new Uint8Array(count),queue:Array<{index:number;priority:number}>=[];
    const endPoint=this.point(end%this.cols,Math.floor(end/this.cols));
    score[start]=0;queue.push({index:start,priority:0});
    while(queue.length) {
      let smallest=0;
      for(let i=1;i<queue.length;i++)if(queue[i].priority<queue[smallest].priority)smallest=i;
      const current=queue.splice(smallest,1)[0].index;
      if(visited[current])continue;
      visited[current]=1;if(current===end)break;
      const x=current%this.cols,z=Math.floor(current/this.cols);
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx=x+dx,nz=z+dz,next=nz*this.cols+nx;
        if(nx<0||nz<0||nx>=this.cols||nz>=this.rows||!this.open[next]||visited[next])continue;
        if(dx&&dz&&(!this.open[z*this.cols+nx]||!this.open[nz*this.cols+x]))continue;
        const candidate=score[current]+Math.hypot(dx,dz)*cell;
        if(candidate>=score[next])continue;
        score[next]=candidate;previous[next]=current;
        const p=this.point(nx,nz);
        queue.push({index:next,priority:candidate+Math.hypot(endPoint.x-p.x,endPoint.z-p.z)});
      }
    }
    if(start!==end&&previous[end]<0)return [];
    const raw:FloorPoint[]=[];
    for(let cursor=end;cursor!==start;cursor=previous[cursor])raw.push(this.point(cursor%this.cols,Math.floor(cursor/this.cols)));
    raw.push(this.point(start%this.cols,Math.floor(start/this.cols)));raw.reverse();
    // Only the actor's own start and destination footprint may touch the short connector.
    const startBoxes=new Set(footprintsAt(from,this.footprints));
    const endBoxes=new Set(footprintsAt(to,this.footprints));
    const clear=(a:FloorPoint,b:FloorPoint,allowed:ReadonlySet<Footprint>)=>
      !this.footprints.some(box=>!allowed.has(box)&&segmentCrossesFootprint(a,b,box));
    const result:FloorPoint[]=[];let current=from,index=0;
    while(index<raw.length) {
      let furthest=index;
      for(let j=index;j<raw.length;j++)if(clear(current,raw[j],result.length?new Set():startBoxes))furthest=j;else break;
      const next=raw[furthest];
      if(Math.hypot(current.x-next.x,current.z-next.z)>.01)result.push(next);
      current=next;index=furthest+1;
    }
    if(clear(current,to,endBoxes))result.push(to);else result.push(...raw.slice(-1),to);
    return result;
  }
}

function footprintsAt(point:FloorPoint,boxes:Footprint[]):Footprint[] {return boxes.filter(box=>inside(point,box));}
