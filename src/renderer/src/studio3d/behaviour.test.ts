// @ts-expect-error The renderer's web tsconfig omits Node types; this test alone reads the fixture.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Raycaster, Vector3 } from 'three';
import { snapshot } from '../api/fake/data';
import { officeDemoSnapshot, officeDemoStep } from '../api/fake/officeDemo';
import { OfficeBehaviour, visitIntents, type ActorFrame } from './behaviour';
import { authoredFootprints, sharedFootprints, NavigationGrid, roomFootprints, segmentCrossesFootprint, workstationFootprints, type FloorPoint } from './navigation';
import { deskSeats, snapshotPlacement, restCapacity, restSlots } from './placement';
import { tagFits, tagsOverlap, type TagRectangle } from './tags';

const gap=(a:FloorPoint,b:FloorPoint)=>Math.hypot(a.x-b.x,a.z-b.z);
const inside=(point:FloorPoint,box:(typeof authoredFootprints)[number])=>
  point.x>box.minX&&point.x<box.maxX&&point.z>box.minZ&&point.z<box.maxZ;
const minGap=(frames:ActorFrame[])=>Math.min(...frames.flatMap((a,i)=>frames.slice(i+1).map(b=>gap(a,b))));
const capacityOkay=(frames:ActorFrame[])=>Object.entries(restCapacity).every(([place,limit])=>
  frames.filter(frame=>frame.place===place).length<=limit);
const facesVisitor=(frames:ActorFrame[])=>frames.every(frame=>{
  if(!frame.visitId||gap(frame,frame.target)>.12)return true;
  const visited=frames.find(other=>other.id===frame.visitId);if(!visited)return false;
  const wanted=Math.atan2(visited.x-frame.x,visited.z-frame.z);
  return Math.abs(Math.atan2(Math.sin(frame.yaw-wanted),Math.cos(frame.yaw-wanted)))<=.45;
});

function demoPeople() {
  const demo=officeDemoSnapshot(snapshot,'busy',0);
  const members=demo.members.filter(member=>member.projectId==='P-0003'&&!member.deleted);
  expect(members).toHaveLength(13);
  return snapshotPlacement({members,tasks:demo.tasks,directives:demo.directives,
    activity:demo.recentActivity,emergency:false,now:0});
}

describe('Studio 3D behaviour',()=>{
  it('keeps its authored furniture plan aligned with the merged room GLB',async()=>{
    const bytes=readFileSync('src/renderer/public/studio3d/room.glb');
    const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const gltf=await new GLTFLoader().parseAsync(buffer,'');
    const footprints=roomFootprints(gltf.scene);
    expect(footprints).toEqual(sharedFootprints);
    expect([...footprints,...workstationFootprints(13)]).toEqual(authoredFootprints);
    const raycaster=new Raycaster();
    for(const box of footprints.filter(item=>/^desk \d+$|meeting table|coffee counter|sofa$/.test(item.name))){
      const x=(box.minX+box.maxX)/2,z=(box.minZ+box.maxZ)/2;
      raycaster.set(new Vector3(x,2.5,z),new Vector3(0,-1,0));
      const hit=raycaster.intersectObjects(gltf.scene.children,true)[0];
      expect(hit?.point.y,box.name).toBeGreaterThan(.35);
    }
  });

  it('routes around every furniture footprint and detects a direct-line mutation',()=>{
    const nav=new NavigationGrid(authoredFootprints);
    const from={x:-2.45,z:-1.09},to={x:3.12,z:-1.77};
    const route=nav.route(from,to);
    expect(route.at(-1)).toEqual(to);
    let previous=from;
    for(const point of route){
      for(const box of authoredFootprints.filter(box=>!inside(from,box)&&!inside(to,box)))
        expect(segmentCrossesFootprint(previous,point,box,0),box.name).toBe(false);
      previous=point;
    }
    const wrong=[{x:2.78,z:-2.72},to];
    expect(wrong.some(point=>authoredFootprints.some(box=>box.name==='coffee counter'&&inside(point,box)))).toBe(true);
  });

  it('holds separation, rest limits, facing and freeze throughout two cycles at 25 fps',()=>{
    const people=demoPeople(),engine=new OfficeBehaviour(new NavigationGrid(authoredFootprints));
    engine.apply(people,false,'busy',true);
    const home=new Map(people.map(person=>[person.memberId,{x:person.x,z:person.z}]));
    const idleMovers=new Set<string>();const choices=new Map<string,string[]>();
    let minimum=Infinity,freeze:Map<string,FloorPoint>|null=null,visits=new Set<string>();
    for(let tick=1;tick<=4400;tick++){
      engine.advance(.04);const state=engine.snapshot();
      minimum=Math.min(minimum,minGap(state.frames));
      expect(minGap(state.frames),`separation at ${state.time.toFixed(2)}`).toBeGreaterThanOrEqual(.45);
      expect(capacityOkay(state.frames),`rest capacity at ${state.time.toFixed(2)}`).toBe(true);
      expect(facesVisitor(state.frames),`visitor facing at ${state.time.toFixed(2)}`).toBe(true);
      for(const frame of state.frames)if(frame.phase==='walking')for(const box of authoredFootprints)
        expect(inside(frame,box),`${JSON.stringify(frame)} in ${box.name} at ${state.time.toFixed(2)}`).toBe(false);
      if(state.emergency){
        if(!freeze)freeze=new Map(state.frames.map(frame=>[frame.id,{x:frame.x,z:frame.z}]));
        for(const frame of state.frames)expect(gap(frame,freeze.get(frame.id)??frame)).toBeLessThan(.001);
      } else freeze=null;
      if(state.time>=64&&state.time<88)for(const frame of state.frames){
        const seat=home.get(frame.id);if(seat&&gap(frame,seat)>.6)idleMovers.add(frame.id);
      }
      if(Math.abs(state.time-66)<.021||Math.abs(state.time-154)<.021)for(const frame of state.frames){
        if(frame.asset===13)continue;
        const slot=restSlots.find(item=>gap(item,frame.target)<.05);
        const place=slot?.place??'desk';const entry=choices.get(frame.id)??[];entry.push(place);choices.set(frame.id,entry);
      }
      for(const frame of state.frames)if(frame.visitId&&gap(frame,frame.target)<.12)visits.add(frame.id);
    }
    expect(minimum).toBeGreaterThanOrEqual(.45);
    expect(idleMovers.size).toBeGreaterThanOrEqual(6);
    expect(visits).toEqual(new Set(['M-0013','M-0021','M-0016']));
    for(const [id,places] of choices)expect(new Set(places).size,`${id} rest variety`).toBeGreaterThan(1);
    // Mutations recreate a coincident pair, an overfull sofa, and a visitor facing away.
    const frames=engine.snapshot().frames;
    expect(minGap([frames[0],{...frames[1],x:frames[0].x,z:frames[0].z}])).toBeLessThan(.45);
    expect(capacityOkay(frames.map((frame,i)=>i<3?{...frame,place:'sofa'}:frame))).toBe(false);
    const visitor={...frames[0],visitId:frames[1].id,x:frames[1].x+1,z:frames[1].z,
      target:{x:frames[1].x+1,z:frames[1].z},yaw:Math.PI/2};
    expect(facesVisitor([visitor,frames[1]])).toBe(false);
  });

  it('declutters tags and contains an explicit 24-second idle segment',()=>{
    const visible:TagRectangle[]=[{x:12,y:15,width:48,height:17}];
    const colliding={x:30,y:20,width:48,height:17};
    expect(tagFits(colliding,visible)).toBe(false);
    expect(tagsOverlap(colliding,visible[0])).toBe(true);
    expect(tagFits({x:70,y:50,width:48,height:17},visible)).toBe(true);
    // Mutation: force-accepting the second rectangle would overlap a visible tag.
    expect([visible[0],colliding].some((tag,i,tags)=>tags.slice(i+1).some(other=>tagsOverlap(tag,other)))).toBe(true);
    expect(officeDemoStep('cycle',64_000)).toBe('idle');
    expect(officeDemoStep('cycle',87_999)).toBe('idle');
    expect(officeDemoStep('cycle',88_000)).toBe('busy');
    const base=officeDemoSnapshot(snapshot,'busy',0).tasks.find(task=>task.id==='T-DEMO-BASE');
    expect(base?.hold).toBeNull();
  });

  it('turns live assignments, reviews and reports into visits and holds the waiting gesture',()=>{
    const demo=officeDemoSnapshot(snapshot,'assignment',0);
    const members=demo.members.filter(member=>member.projectId==='P-0003'&&!member.deleted);
    const assigned=demo.tasks.find(task=>task.id==='T-DEMO-ASSIGN');
    expect(assigned).toBeDefined();
    const intents=visitIntents(members,assigned?[assigned]:[],[],Date.parse(assigned?.activatedAt??''));
    expect(intents).toContainEqual({visitorId:'M-0013',visitedId:'M-0014',kind:'assignment'});
    expect(visitIntents(members,assigned?[{...assigned,activatedAt:null}]:[],[],Date.now())).toEqual([]);
    const reviewed=officeDemoSnapshot(snapshot,'review',0).tasks.find(task=>task.id==='T-DEMO-REVIEW');
    expect(visitIntents(members,reviewed?[reviewed]:[],[],Date.now()))
      .toContainEqual({visitorId:'M-0021',visitedId:'M-0016',kind:'review'});
    const reported=officeDemoSnapshot(snapshot,'report',0).recentActivity.find(item=>item.kind==='report'&&item.seq===90000);
    expect(visitIntents(members,[],reported?[{...reported,memberId:'M-0016'}]:[],Date.parse(reported?.ts??'')))
      .toContainEqual({visitorId:'M-0016',visitedId:'M-0013',kind:'report'});
    const people=demoPeople(),waiting=people.map(person=>person.memberId==='M-0016'?
      {...person,status:'awaiting_answer' as const,clip:'hand_raise' as const}:person);
    const engine=new OfficeBehaviour(new NavigationGrid(authoredFootprints));
    engine.apply(waiting,false,null);
    expect(engine.snapshot().frames.find(frame=>frame.id==='M-0016')?.clip).toBe('hand_raise');
    for(let tick=0;tick<35;tick++)engine.advance(.04);
    const settled=engine.snapshot().frames.find(frame=>frame.id==='M-0016');
    expect([settled?.status,settled?.clip]).toEqual(['awaiting_answer','hand_raise']);
    // Mutation: a working typist cannot satisfy the waiting status and gesture pair.
    expect([settled?.status,'sit_type']).not.toEqual(['awaiting_answer','hand_raise']);
  });

  it('keeps standalone paused and social preview statuses visible',()=>{
    const people=demoPeople(),engine=new OfficeBehaviour(new NavigationGrid(authoredFootprints));
    engine.apply(people,false,'paused');
    const paused=engine.snapshot().frames.find(frame=>frame.id==='M-0018');
    expect([paused?.status,paused?.clip]).toEqual(['paused','sit_lean_back']);
    const events=officeDemoSnapshot(snapshot,'events',0);
    const members=events.members.filter(member=>member.projectId==='P-0003'&&!member.deleted);
    const positioned=snapshotPlacement({members,tasks:events.tasks,directives:events.directives,
      activity:events.recentActivity,emergency:false,now:0});
    engine.apply(positioned,false,'events');
    expect(engine.snapshot().frames.filter(frame=>frame.status==='idle').length).toBeGreaterThanOrEqual(4);
  });

  it('ends a live review visit after the hand-off dwell',()=>{
    const engine=new OfficeBehaviour(new NavigationGrid(authoredFootprints));
    engine.apply(demoPeople(),false,null,false,[{visitorId:'M-0021',visitedId:'M-0016',kind:'review'}]);
    expect(engine.snapshot().frames.find(frame=>frame.id==='M-0021')?.visitId).toBe('M-0016');
    for(let tick=0;tick<325;tick++)engine.advance(.04);
    expect(engine.snapshot().frames.find(frame=>frame.id==='M-0021')?.visitId).toBeNull();
  });

  it('gives a newly idle member a full rest dwell across a rotation boundary',()=>{
    const people=demoPeople(),engine=new OfficeBehaviour(new NavigationGrid(authoredFootprints));
    engine.apply(people,false,null);
    while(engine.time<37)engine.advance(.04);
    engine.apply(people.map(person=>person.memberId==='M-0014'?
      {...person,status:'idle' as const,clip:'sit_idle' as const}:person),false,null);
    const home=deskSeats[0];
    while(engine.time<89.9)engine.advance(.04);
    const waiting=engine.snapshot().frames.find(frame=>frame.id==='M-0014');
    expect(waiting?.place).toBe('desk');
    expect(waiting?.target).toEqual({x:home.x,z:home.z});
    while(engine.time<90.2)engine.advance(.04);
    const rest=engine.snapshot().frames.find(frame=>frame.id==='M-0014');
    expect(rest?.target).not.toEqual({x:home.x,z:home.z});
    while(engine.time<134.9)engine.advance(.04);
    expect(engine.snapshot().frames.find(frame=>frame.id==='M-0014')?.target).toEqual(rest?.target);
  });
});
