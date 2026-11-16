// @ts-expect-error Renderer web compilation intentionally omits Node types.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AnimationMixer, Raycaster, SkinnedMesh, Vector3 } from 'three';
import { snapshot } from '../api/fake/data';
import { officeDemoSnapshot } from '../api/fake/officeDemo';
import { MemberSlots, entryApron, entryDoor, homeForAsset, snapshotPlacement, workstationSeats } from './placement';
import { sharedFootprints, workstationFootprints, workstationFootprintsForAssets, NavigationGrid } from './navigation';
import { assembleCharacter, garments, looksForMembers } from './characterKit';
import { walkFootContact } from './footContact';
import { createWorkstation, settleWorkstation } from './workstations';
import { OfficeBehaviour } from './behaviour';

const source=officeDemoSnapshot(snapshot,'busy',0).members.filter(member=>member.projectId==='P-0003');
const producer=source.find(member=>member.isProducer)!;
const worker=source.find(member=>!member.isProducer)!;
function team(count:number){return count===0?[]:[producer,...Array.from({length:count-1},(_,index)=>
  ({...worker,id:`M-${String(100+index).padStart(4,'0')}`,name:`Member ${index+1}`}))];}
const place=(count:number)=>snapshotPlacement({members:team(count),tasks:[],directives:[],activity:[],emergency:false,now:0});
const intersects=(a:(typeof sharedFootprints)[number],b:(typeof sharedFootprints)[number])=>
  a.minX<b.maxX&&a.maxX>b.minX&&a.minZ<b.maxZ&&a.maxZ>b.minZ;
async function parse(name:string){
  const bytes=readFileSync(`src/renderer/public/studio3d/${name}.glb`);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
}

describe('Studio 3D member-created workstations',()=>{
  it('exports 12 hair choices, 17-bone rigs and all 26 per-actor actions within 15 MB',async()=>{
    const appearance=await parse('appearance_kit');
    for(let index=0;index<12;index++)expect(appearance.scene.getObjectByName(`hair_${index}`)).toBeDefined();
    let bytes=0;
    for(const name of ['room','workstation_kit','appearance_kit',...[...garments,'producer'].map(garment=>`kit_${garment}`)]){
      bytes+=readFileSync(`src/renderer/public/studio3d/${name}.glb`).byteLength;
      if(!name.startsWith('kit_'))continue;
      const gltf=await parse(name),bodies:SkinnedMesh[]=[];
      const profile=gltf.scene.getObjectByName('Rig')?.userData;
      expect(profile?.kit_height).toBeGreaterThan(.8);
      expect(profile?.kit_face_width).toBeGreaterThan(.8);
      expect(profile?.kit_face_height).toBeGreaterThan(.8);
      gltf.scene.traverse(object=>{if(object instanceof SkinnedMesh)bodies.push(object);});
      expect(bodies).toHaveLength(1);expect(bodies[0].skeleton.bones).toHaveLength(17);
      expect(gltf.animations).toHaveLength(26);
      expect(gltf.animations.every(clip=>clip.tracks.some(track=>track.name.endsWith('morphTargetInfluences')))).toBe(true);
    }
    expect(bytes).toBeLessThan(15_000_000);
  });
  it.each([0,1,2,12,13,20,24,30,50])('represents all %i members, including the producer',count=>{
    const people=place(count);
    expect(people).toHaveLength(count);
    expect(workstationSeats(count)).toHaveLength(count);
    expect(workstationFootprints(count).filter(box=>box.name.endsWith(' top'))).toHaveLength(count);
    expect(new Set(people.map(person=>person.memberId)).size).toBe(count);
    // Mutation: the former 12-member truncation drops somebody at 13+ workers.
    if(count>13)expect(people.filter(person=>person.asset<=13)).not.toHaveLength(count);
  });

  it('keeps the room shared-only and creates exactly one independently movable station per hire',async()=>{
    const kit=await parse('workstation_kit');
    const members=team(3);
    const stations=members.slice(0,2).map((member,index)=>createWorkstation(kit,member,index-1,-Infinity));
    expect(stations).toHaveLength(2);
    const added=createWorkstation(kit,members[2],1,10);stations.push(added);
    expect(stations).toHaveLength(3);
    expect(settleWorkstation(added,10)).toBe(0);
    expect(settleWorkstation(added,10.425)).toBeCloseTo(.5);
    expect(settleWorkstation(added,10.85)).toBeCloseTo(1);
    stations.splice(stations.findIndex(station=>station.memberId===members[2].id),1);
    expect(stations).toHaveLength(2);
    // Mutation: a desk that jumps straight to its final position loses the settle.
    expect(settleWorkstation(createWorkstation(kit,members[2],1,10),10,true)).not.toBe(0);
    const room=await parse('room');
    expect(room.scene.children.some(object=>/^chair_\d+$|producer_chair/.test(object.name))).toBe(false);
  });

  it('freezes an unfinished desk setup and resumes it after emergency stop',async()=>{
    const station=createWorkstation(await parse('workstation_kit'),worker,0,10);
    settleWorkstation(station,10.3);const height=station.root.position.y,scale=station.root.scale.y;
    settleWorkstation(station,12.3,false,true);
    expect(station.root.position.y).toBeCloseTo(height,10);expect(station.root.scale.y).toBeCloseTo(scale,10);
    settleWorkstation(station,12.55);expect(station.root.position.y).toBeLessThan(height);
  });

  it('preserves everybody else’s seat when a member leaves',()=>{
    const slots=new MemberSlots(),members=team(5);
    const before=new Map(slots.assign(members));
    slots.assign(members.filter(member=>member.id!==members[1].id));
    for(const member of members.slice(2))expect(slots.assign([member]).get(member.id)).toBe(before.get(member.id));
    slots.release(members[1].id);
    const next={...worker,id:'M-NEW'};
    expect(slots.assign([next]).get(next.id)).toBe(before.get(members[1].id));
    // Mutation: reindexing the filtered array moves the former third colleague.
    expect(homeForAsset(1)).not.toEqual(homeForAsset(before.get(members[2].id)!));
  });

  it('uses repeatable looks with no neighbouring hair, garment and palette twins',async()=>{
    const members=team(50),first=looksForMembers(members),second=looksForMembers([...members].reverse());
    expect([...first]).toEqual([...second]);
    vi.resetModules();
    const fresh=await import('./characterKit');
    expect([...fresh.looksForMembers(members)]).toEqual([...first]);
    const keys=members.map(member=>{const look=first.get(member.id)!;return `${look.hair}:${look.garment}:${look.family}`;});
    expect(new Set(keys).size).toBe(50);
    expect(first.get(producer.id)?.garment).toBe('producer');
    const mutated=[keys[0],keys[0],...keys.slice(2)];
    expect(new Set(mutated).size).toBeLessThan(50);
  });

  it('bumps the newcomer rather than an existing look when their signatures collide',()=>{
    const older={...worker,id:'M-9900'},newer={...worker,id:'M-8748'};
    const before=looksForMembers([older]).get(older.id);
    const after=looksForMembers([newer,older]);
    expect(after.get(older.id)).toEqual(before);
    const signature=(look:NonNullable<typeof before>)=>`${look.hair}:${look.garment}:${look.family}`;
    expect(signature(after.get(newer.id)!)).not.toBe(signature(before!));
    // Mutation: processing only lexical order gives the newcomer the old signature.
    expect(newer.id.localeCompare(older.id)).toBeLessThan(0);
  });

  it('merges the look into one skinned draw while a blink leaves the legs unchanged',async()=>{
    const look=looksForMembers([worker]).get(worker.id)!;
    const garment=await parse(`kit_${look.garment}`),appearance=await parse('appearance_kit');
    const generated=assembleCharacter(worker,{garments:new Map([[look.garment,garment]]),appearance});
    const meshes:SkinnedMesh[]=[];
    generated.root.traverse(object=>{if(object instanceof SkinnedMesh)meshes.push(object);});
    expect(meshes).toHaveLength(1);
    const body=meshes[0],positions=body.geometry.getAttribute('position');
    const index=Array.from({length:positions.count},(_,i)=>i).find(i=>positions.getY(i)<.3)!;
    generated.root.updateMatrixWorld(true);
    const before=body.getVertexPosition(index,new Vector3());
    body.morphTargetInfluences![body.morphTargetDictionary!.eyeBlink]=1;
    const blink=body.getVertexPosition(index,new Vector3());
    expect(blink.distanceTo(before)).toBeLessThan(.00001);
    // Mutation: losing relative morph mode used to collapse the whole body on a blink.
    body.geometry.morphTargetsRelative=false;
    expect(body.getVertexPosition(index,new Vector3()).distanceTo(before)).toBeGreaterThan(.01);
  });

  it('aligns the planted-foot window with the backwards-moving foot in the exported walk',async()=>{
    const gltf=await parse('kit_cardigan'),mixer=new AnimationMixer(gltf.scene);
    mixer.clipAction(gltf.animations.find(clip=>clip.name==='walk')!).play();
    const bodies:SkinnedMesh[]=[];gltf.scene.traverse(object=>{if(object instanceof SkinnedMesh)bodies.push(object);});
    const foot=(side:string)=>bodies[0].skeleton.bones.find(bone=>bone.name.replaceAll('.','').replaceAll('_','')===`foot${side}`)!;
    mixer.setTime(.37);gltf.scene.updateMatrixWorld(true);
    const rightStart=foot('R').getWorldPosition(new Vector3()).z,leftStart=foot('L').getWorldPosition(new Vector3()).z;
    mixer.setTime(.63);gltf.scene.updateMatrixWorld(true);
    expect(foot('R').getWorldPosition(new Vector3()).z).toBeLessThan(rightStart);
    expect(walkFootContact(.5)?.side).toBe('R');
    // Mutation: the opposite foot is travelling forwards during this contact.
    expect(foot('L').getWorldPosition(new Vector3()).z).toBeGreaterThan(leftStart);
  });

  it('keeps sofa partners hands on their own laps throughout a conversation',async()=>{
    const templates=await Promise.all(['kit_cardigan','kit_sweater'].map(parse));
    const mixers=templates.map((gltf,index)=>{
      gltf.scene.position.set(index===0?2.13:3.03,0,1.6);
      gltf.scene.rotation.y=index===0?Math.PI/2:-Math.PI/2;
      const mixer=new AnimationMixer(gltf.scene);mixer.clipAction(gltf.animations.find(clip=>clip.name==='sofa_talk')!).play();return mixer;
    });
    const hands=templates.map(gltf=>{
      const bodies:SkinnedMesh[]=[];gltf.scene.traverse(object=>{if(object instanceof SkinnedMesh)bodies.push(object);});
      return bodies[0].skeleton.bones.filter(bone=>/^hand[._][LR]$/.test(bone.name));
    });
    for(let frame=0;frame<50;frame++){
      mixers.forEach((mixer,index)=>{mixer.setTime(frame/25);templates[index].scene.updateMatrixWorld(true);});
      for(const left of hands[0])for(const right of hands[1])
        expect(left.getWorldPosition(new Vector3()).distanceTo(right.getWorldPosition(new Vector3()))).toBeGreaterThan(.30);
    }
    // Mutation: coincident wrist targets cannot satisfy the same hand-clearance threshold.
    expect(new Vector3().distanceTo(new Vector3())).toBeLessThan(.30);
  });

  it('keeps 50 workstations clear of shared furniture and every home foot outside tabletops',()=>{
    const desks=workstationFootprints(50).filter(box=>box.name.endsWith(' top'));
    for(const desk of desks)for(const shared of sharedFootprints)expect(intersects(desk,shared),`${desk.name} / ${shared.name}`).toBe(false);
    for(const person of place(50))for(const desk of desks)
      expect(person.x>desk.minX&&person.x<desk.maxX&&person.z>desk.minZ&&person.z<desk.maxZ).toBe(false);
    // Mutation: putting a new station on the sofa is caught by the same check.
    expect(intersects({...desks[0],...sharedFootprints.find(box=>box.name==='sofa')!},sharedFootprints.find(box=>box.name==='sofa')!)).toBe(true);
  });

  it('spawns a new character at the door and removes only that character after walking out',()=>{
    const nav=new NavigationGrid([...sharedFootprints,...workstationFootprints(3)]);
    const engine=new OfficeBehaviour(nav),two=place(2),three=place(3);
    engine.apply(two,false,null);
    expect(engine.snapshot().frames).toHaveLength(2);
    engine.apply(three,false,null);
    const added=engine.snapshot().frames.find(frame=>frame.id===three[1].memberId)!;
    expect(added.x).toBeCloseTo(entryDoor.x);expect(added.z).toBeCloseTo(entryDoor.z);
    for(let tick=0;tick<1500;tick++)engine.advance(.04);
    expect(engine.snapshot().frames.find(frame=>frame.id===added.id)?.phase).toBe('seated');
    engine.apply(two,false,null);
    expect(engine.snapshot().frames).toHaveLength(3);
    for(let tick=0;tick<1500;tick++)engine.advance(.04);
    expect(engine.snapshot().frames.map(frame=>frame.id).sort()).toEqual(two.map(person=>person.memberId).sort());
    // Mutation: spawning at the workstation would fail the door assertion.
    expect([three[1].x,three[1].z]).not.toEqual([entryDoor.x,entryDoor.z]);
  });

  it('routes every one of 50 home approaches through the clear entrance apron',()=>{
    const people=place(50),assets=people.map(person=>person.asset);
    const nav=new NavigationGrid([...sharedFootprints,...workstationFootprintsForAssets(assets,new Set(assets))]);
    expect(nav.route(entryDoor,entryApron).length).toBeGreaterThan(0);
    for(const person of people){
      const goal={x:person.x-Math.sin(person.yaw)*.57,z:person.z-Math.cos(person.yaw)*.57};
      expect(nav.route(entryApron,goal).length,person.memberId).toBeGreaterThan(0);
      expect(nav.route(goal,entryApron).length,person.memberId).toBeGreaterThan(0);
    }
  });

  it('shows an idle newcomer seated immediately instead of playing an entrance walk',()=>{
    const nav=new NavigationGrid([...sharedFootprints,...workstationFootprints(3)]),engine=new OfficeBehaviour(nav);
    const two=place(2),three=place(3),added=three.find(person=>!two.some(old=>old.memberId===person.memberId))!;
    added.status='idle';added.clip='sit_idle';engine.apply(two,false,null);engine.apply(three,false,null);
    const initial=engine.snapshot().frames.find(frame=>frame.id===added.memberId)!;
    expect(initial.phase).toBe('seated');expect(['desk','sofa']).toContain(initial.place);
    for(let tick=0;tick<1500;tick++)engine.advance(.04);
    const rested=engine.snapshot().frames.find(frame=>frame.id===added.memberId)!;
    expect(rested.phase).toBe('seated');
    expect([rested.x,rested.z]).toEqual([initial.x,initial.z]);
  });

  it('finishes a four-second hiring stream with all fourteen people seated',()=>{
    const reserved=[13,...Array.from({length:12},(_,index)=>index+1)];
    const grid=(count:number)=>{
      const assets=[...new Set([...reserved,...place(count).map(person=>person.asset)])];
      return new NavigationGrid([...sharedFootprints,...workstationFootprintsForAssets(assets,new Set(assets))]);
    };
    const engine=new OfficeBehaviour(grid(3));engine.apply(place(3),false,null);
    const initial=new Set(place(3).map(person=>person.memberId)),nearest=new Map<string,number>();
    let count=3;
    for(let tick=0;tick<1875;tick++){
      const next=Math.min(14,3+Math.floor((tick*.04)/4));
      if(next!==count){count=next;engine.setNavigation(grid(count));engine.apply(place(count),false,null);}
      engine.advance(.04);
      for(const actor of engine.snapshot().frames)if(!initial.has(actor.id))nearest.set(actor.id,
        Math.min(nearest.get(actor.id)??Infinity,Math.hypot(actor.x-entryApron.x,actor.z-entryApron.z)));
    }
    expect(engine.snapshot().frames.filter(frame=>frame.phase==='seated')).toHaveLength(14);
    expect(nearest.size).toBe(11);for(const distance of nearest.values())expect(distance).toBeLessThan(.4);
  });

  it('shows the arrival head through the real room opening instead of behind the alcove wall',async()=>{
    const room=await parse('room');room.scene.updateMatrixWorld(true);
    const direction=new Vector3(-12,9,13).normalize();
    for(const height of [1.55,1.72,1.9]){
      const ray=new Raycaster(new Vector3(entryDoor.x,height,entryDoor.z),direction,0,8);
      expect(ray.intersectObject(room.scene,true)).toHaveLength(0);
    }
    // Mutation: an origin behind the solid part of the wall is actually occluded.
    expect(new Raycaster(new Vector3(3,1.55,-3.9),direction,0,8).intersectObject(room.scene,true).length).toBeGreaterThan(0);
  });


  it('queues excess walkers in large teams while the benchmark can exercise all of them',()=>{
    const engine=new OfficeBehaviour(new NavigationGrid([...sharedFootprints,...workstationFootprints(50)]));
    engine.apply(place(50),false,null);engine.setPerformanceWalk(true,30);engine.advance(.04);
    const moving=()=>engine.snapshot().frames.filter(frame=>frame.clip==='walk'||frame.clip==='turn_left'||frame.clip==='turn_right').length;
    expect(moving()).toBeGreaterThan(12);
    engine.setPerformanceWalk(false);engine.advance(.04);
    expect(moving()).toBeLessThanOrEqual(12);
    // Mutation: bypassing the normal-team gate is precisely the uncapped benchmark above.
  });

  it('seats two sofa guests and keeps the other idle colleagues at their desks',()=>{
    const engine=new OfficeBehaviour(new NavigationGrid([...sharedFootprints,...workstationFootprints(13)]));
    engine.apply(place(13),false,'idle');
    for(let tick=0;tick<750;tick++)engine.advance(.04);
    const frames=engine.snapshot().frames;
    expect(frames.filter(frame=>frame.place==='sofa')).toHaveLength(2);
    expect(frames.every(frame=>frame.phase==='seated'&&['desk','producer','sofa'].includes(frame.place))).toBe(true);
  });
});
