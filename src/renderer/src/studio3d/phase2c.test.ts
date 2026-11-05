// @ts-expect-error The renderer web tsconfig omits Node types; this test reads built GLBs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deskSeats, producerSeat } from './placement';
import { firstFittingTag, type TagRectangle } from './tags';
import { walkFootContact } from './footContact';

function glb(name:string) {
  const bytes=readFileSync(`src/renderer/public/studio3d/${name}.glb`);
  expect(bytes.toString('ascii',0,4)).toBe('glTF');
  const length=bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString('utf8',20,20+length));
}

describe('Studio 3D phase 2c contracts',()=>{
  it('keeps only shared chairs in the room and exports a member chair module',()=>{
    const nodes=glb('room').nodes;
    const expected=['meeting south left','meeting south right','meeting north'];
    const actual=nodes.filter((node:{name:string})=>expected.includes(node.name));
    expect(actual.map((node:{name:string})=>node.name).sort()).toEqual(expected.sort());
    expect(actual.every((node:{children?:number[]})=>node.children?.length===3)).toBe(true);
    expect(nodes.some((node:{name:string})=>/^chair \d+$|^producer chair$/.test(node.name))).toBe(false);
    const kit=glb('workstation_kit');
    expect(kit.nodes.some((node:{name:string})=>node.name==='chair')).toBe(true);
    // Mutation: dropping the runtime chair module leaves every hire without a chair.
    expect(kit.nodes.filter((node:{name:string})=>node.name!=='chair')
      .some((node:{name:string})=>node.name==='chair')).toBe(false);
  });

  it('keeps each actor’s own face channels and a carried-folder walk',()=>{
    for(const garment of ['cardigan','hoodie','shirt','vest','blazer','fleece','tee_long','sweater','producer']){
      const data=glb(`kit_${garment}`);
      const clips=new Map<string,Array<{target:{path:string}}>>(data.animations.map((animation:{name:string;channels:Array<{target:{path:string}}>})=>
        [animation.name,animation.channels]));
      for(const name of ['sit_type','sofa_talk','walk_folder']){
        const channels=clips.get(name);
        expect(channels,`${garment} ${name}`).toBeDefined();
        expect(channels?.some(channel=>channel.target.path==='weights')).toBe(true);
      }
      // Mutation: removing the hoodie's face channel violates the same contract.
      if(garment==='hoodie'){const channels=clips.get('sofa_talk')??[];
        expect(channels.filter(channel=>channel.target.path!=='weights')
          .some(channel=>channel.target.path==='weights')).toBe(false);}
    }
  });

  it('forms a perpendicular nook with 12 member seats and a separate producer',()=>{
    expect(deskSeats).toHaveLength(12);
    expect(new Set(deskSeats.map(seat=>`${seat.x},${seat.z}`)).size).toBe(12);
    expect(deskSeats.slice(10).every(seat=>seat.yaw===-Math.PI/2)).toBe(true);
    expect(producerSeat).toEqual({x:.05,z:-3.35,yaw:0,place:'producer'});
    // Mutation: a straightened last desk recreates the repeated four-desk grid.
    expect({...deskSeats[11],yaw:0}.yaw).not.toBe(deskSeats[11].yaw);
  });

  it('keeps pose chips outside head and hand protection rectangles',()=>{
    const candidates:TagRectangle[]=[{x:80,y:65,width:76,height:28},{x:180,y:65,width:76,height:28}];
    const face={x:95,y:60,width:26,height:30};
    expect(firstFittingTag(candidates,[],[face])).toEqual(candidates[1]);
    // Mutation: dropping protected areas chooses the face-covering candidate.
    expect(firstFittingTag(candidates,[],[])).toEqual(candidates[0]);
  });

  it('marks alternating planted feet and blends contact at both ends',()=>{
    expect(walkFootContact(0)).toEqual({side:'L',weight:1,measuring:true});
    expect(walkFootContact(.5)).toEqual({side:'R',weight:1,measuring:true});
    expect(walkFootContact(.25)).toBeNull();
    expect(walkFootContact(.75)).toBeNull();
    // Mutation: using one side for both half strides would lose alternate contact.
    expect(walkFootContact(.5)?.side).not.toBe(walkFootContact(0)?.side);
  });
});
