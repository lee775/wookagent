import { officeDemoStep, type DemoStep } from '../studio/officeDemoStep';
import { entryApron, entryDoor, homeForAsset, restSlots, workClip, type StudioClip, type StudioPlace, type StudioPosition } from './placement';
import { NavigationGrid, type FloorPoint } from './navigation';
import type { ActivityView, MemberView, TaskView } from '../../../shared/views';

export interface VisitIntent { visitorId:string; visitedId:string; kind:'assignment'|'review'|'report' }

export function visitIntents(members:MemberView[],tasks:TaskView[],activity:ActivityView[],now:number):VisitIntent[] {
  const producer=members.find(member=>member.isProducer);
  const visible=new Set(members.map(member=>member.id));
  const fresh=(stamp:string|null,span:number)=>stamp!==null&&now-Date.parse(stamp)>=0&&now-Date.parse(stamp)<span;
  const visits:VisitIntent[]=[];
  for(const task of tasks){
    if(producer&&task.assigneeId!==producer.id&&visible.has(task.assigneeId)&&fresh(task.activatedAt,9000))
      visits.push({visitorId:producer.id,visitedId:task.assigneeId,kind:'assignment'});
    if(task.state==='in_review'&&task.reviewerId&&visible.has(task.reviewerId)&&visible.has(task.assigneeId))
      visits.push({visitorId:task.reviewerId,visitedId:task.assigneeId,kind:'review'});
  }
  if(producer)for(const item of activity)if(item.kind==='report'&&item.memberId&&item.memberId!==producer.id&&
    visible.has(item.memberId)&&fresh(item.ts,12000))
    visits.push({visitorId:item.memberId,visitedId:producer.id,kind:'report'});
  return visits;
}

export type MotionPhase = 'seated' | 'rising' | 'walking' | 'standing' | 'sitting';
export interface ActorFrame extends FloorPoint {
  id: string; asset: number; role: string; status: StudioPosition['status']; place: StudioPlace | 'visit';
  target: FloorPoint; clip: StudioClip; yaw: number; phase: MotionPhase; seat: number | null;
  speed: number; visitId: string | null; distance: number; phaseProgress:number; carryingFolder:boolean; headHeight:number;
}
interface ActorState extends ActorFrame {
  path: FloorPoint[]; pathIndex: number; pathGoal:FloorPoint; phaseTime: number; wait: number;
  desiredClip: StudioClip; desiredYaw: number; assignedPlace: StudioPlace | 'visit';
  timeScale: number; offset: number; transitionFrom: FloorPoint; transitionTo: FloorPoint; statusAt:number;
  suspendedPhase:MotionPhase|null; idlePending:boolean;
  departing:boolean;
  arriving:boolean;entrancePending:boolean;
}
export interface BehaviourSnapshot { time: number; emergency: boolean; frames: ActorFrame[] }

const seating = (place: StudioPlace | 'visit') => place==='desk'||place==='producer'||place==='sofa'||place==='meeting';
const seatedClip = (clip:StudioClip) => clip.startsWith('sit_')||clip==='sofa_sit'||clip==='sofa_talk'||clip==='head_in_hands'||clip==='hand_raise'||clip==='receive';
const norm = (angle:number) => Math.atan2(Math.sin(angle),Math.cos(angle));
const hash = (value:string) => [...value].reduce((number,char)=>(number*31+char.charCodeAt(0))>>>0,7);
const distance = (a:FloorPoint,b:FloorPoint) => Math.hypot(a.x-b.x,a.z-b.z);
const approach = (point:FloorPoint,yaw:number,place:StudioPlace|'visit'):FloorPoint => {
  const distance=place==='sofa'?.85:.57;
  return {x:point.x-Math.sin(yaw)*distance,z:point.z-Math.cos(yaw)*distance};
};
const ease = (fraction:number) => {const t=Math.max(0,Math.min(1,fraction));return t*t*(3-2*t);};
const transitionDuration=.9;
const stressPoint=(home:Pick<StudioPosition,'x'|'z'|'yaw'>,asset:number,distance:number):FloorPoint=>{
  const lateral=asset===9?-.9:asset===10?.9:0;
  return {x:home.x+lateral*Math.cos(home.yaw)-distance*Math.sin(home.yaw),
    z:home.z-lateral*Math.sin(home.yaw)-distance*Math.cos(home.yaw)};
};
const visitKey=(visit:VisitIntent)=>`${visit.kind}:${visit.visitorId}:${visit.visitedId}`;
const homeSeat=homeForAsset;

function restAssignment(count:number,cycle:number):number[] {
  const initial=Array.from({length:count},(_,i)=>i<12?i%12:9);
  if(cycle%2===0)return initial;
  const place=(index:number)=>index<9?restSlots[index].place:'desk';
  const slots=Array.from({length:12},(_,i)=>i);
  const result:number[]=[];
  for(let i=0;i<count;i++) {
    const old=place(initial[i]);
    const options=slots.filter(slot=>place(slot)!==old);
    const selected=options.sort((a,b)=>((a+cycle*7+i*3)%12)-((b+cycle*7+i*3)%12))[0]??slots[0];
    result.push(selected);slots.splice(slots.indexOf(selected),1);
  }
  return result;
}

function visitPoint(person:StudioPosition):FloorPoint {
  return {x:person.x-Math.sin(person.yaw)*.85+.24*Math.cos(person.yaw),
    z:person.z-Math.cos(person.yaw)*.85-.24*Math.sin(person.yaw)};
}

function facing(from:FloorPoint,to:FloorPoint):number {return Math.atan2(to.x-from.x,to.z-from.z);}

export class OfficeBehaviour {
  private readonly states=new Map<string,ActorState>();
  private nav:NavigationGrid;
  private people:StudioPosition[]=[];
  private demoStep:DemoStep|null=null;
  private cycleMode=false;
  private visits:VisitIntent[]=[];
  private visitSince=new Map<string,number>();
  private stop=false;
  private performanceWalk=false;
  private walkerLimit=12;
  private initialized=false;
  time=0;

  constructor(nav:NavigationGrid) {this.nav=nav;}
  private routeForActor(state:ActorState,origin:FloorPoint,goal:FloorPoint,navigation=this.nav):FloorPoint[] {
    return state.entrancePending?[...navigation.route(origin,entryApron),...navigation.route(entryApron,goal)]:navigation.route(origin,goal);
  }
  setNavigation(nav:NavigationGrid):void {
    this.nav=nav;
    for(const state of this.states.values())if(state.path.length){
      const origin=state.phase==='rising'?state.transitionTo:state;
      const route=this.routeForActor(state,origin,state.pathGoal);
      // A same-cell replan has no waypoints. Keep the last valid approach so
      // a hire during that step cannot strand somebody in the walking phase.
      if(!route.length&&distance(origin,state.pathGoal)<.35)continue;
      state.path=route;state.pathIndex=0;
    }
  }

  setPerformanceWalk(enabled:boolean,limit=12):void {
    this.performanceWalk=enabled;
    this.walkerLimit=limit;
    if(!enabled){this.setTargets();return;}
    for(const state of this.states.values()){
      if(state.asset===13||(state.asset<13?state.asset-1:state.asset-2)>=this.walkerLimit)continue;
      const home=homeSeat(state.asset);
      const origin=stressPoint(home,state.asset,.57);
      const goal=stressPoint(home,state.asset,1.0);
      state.x=origin.x;state.z=origin.z;
      state.target=goal;state.pathGoal=goal;state.path=[goal];
      state.pathIndex=0;state.phase='walking';state.phaseTime=0;state.speed=0;
      state.assignedPlace='visit';state.desiredClip='stand_idle';
    }
  }

  reset():void {
    const people=this.people,step=this.cycleMode?officeDemoStep('cycle',0):this.demoStep;
    const cycle=this.cycleMode,visits=this.visits,emergency=this.stop&&!cycle;
    this.states.clear();this.visitSince.clear();this.time=0;this.initialized=false;this.apply(people,emergency,step,cycle,visits);
  }

  apply(people:StudioPosition[],emergency:boolean,demoStep:DemoStep|null,cycleMode=false,visits:VisitIntent[]=[]):void {
    this.people=people;
    this.demoStep=demoStep;
    this.cycleMode=cycleMode;
    this.visits=visits;
    const active=new Set(visits.map(visitKey));
    for(const key of this.visitSince.keys())if(!active.has(key))this.visitSince.delete(key);
    for(const visit of visits){const key=visitKey(visit);if(!this.visitSince.has(key))this.visitSince.set(key,this.time);}
    this.stop=emergency||demoStep==='emergency';
    for(const person of people)if(!this.states.has(person.memberId)) {
      const phase:MotionPhase=seating(person.place)&&seatedClip(person.clip)?'seated':'standing';
      const arriving=this.initialized;
      const start=arriving?{...entryDoor}:{x:person.x,z:person.z};
      const startYaw=arriving?facing(entryDoor,entryApron):person.yaw;
      this.states.set(person.memberId,{id:person.memberId,asset:person.asset,role:person.role,status:person.status,
        x:start.x,z:start.z,target:start,yaw:startYaw,desiredYaw:person.yaw,
        clip:arriving?'stand_idle':person.clip,desiredClip:person.clip,place:arriving?'visit':person.place,assignedPlace:person.place,
        phase:arriving?'standing':phase,phaseTime:0,path:[],pathIndex:0,pathGoal:start,wait:0,seat:person.seat,speed:0,
        visitId:null,distance:0,phaseProgress:0,carryingFolder:false,headHeight:1.27,
        timeScale:.95+(hash(person.memberId)%101)/1000,statusAt:0,suspendedPhase:null,idlePending:false,departing:false,
        arriving,entrancePending:arriving,
        offset:(hash(`${person.memberId}:clip`)%1000)/1000,
        transitionFrom:start,transitionTo:start});
    }
    const visible=new Set(people.map(person=>person.memberId));
    for(const person of people){const state=this.states.get(person.memberId);if(state){state.asset=person.asset;state.departing=false;}}
    for(const state of this.states.values())if(!visible.has(state.id)&&!state.departing){
      state.departing=true;state.target={...entryDoor};state.assignedPlace='visit';
      state.arriving=false;state.entrancePending=distance(state,entryDoor)>1;
      state.desiredClip='stand_idle';state.desiredYaw=0;
      const leavingSeat=state.phase==='seated'||state.phase==='sitting';
      const origin=leavingSeat?approach(state,state.yaw,state.place):{x:state.x,z:state.z};
      state.pathGoal=state.target;state.path=this.routeForActor(state,origin,state.target);
      state.pathIndex=0;
      if(leavingSeat){state.phase='rising';state.phaseTime=0;state.clip='stand_up';
        state.transitionFrom={x:state.x,z:state.z};state.transitionTo=origin;}
      else {state.phase='walking';state.clip='walk';}
    }
    if(people.length)this.initialized=true;
    this.setTargets();
  }

  private setTargets():void {
    if(this.performanceWalk)return;
    if(this.stop)return;
    const cycle=Math.floor(this.time/(this.demoStep?88:45));
    const rest=restAssignment(this.people.filter(person=>person.place!=='producer').length,cycle);
    const liveVisits=this.visits.filter(visit=>visit.kind!=='review'||
      this.time-(this.visitSince.get(visitKey(visit))??this.time)<12);
    for(const person of this.people) {
      const state=this.states.get(person.memberId);if(!state)continue;
      let status=person.status,clip=person.clip,place:StudioPlace|'visit'=person.place;
      let target:FloorPoint={x:person.x,z:person.z},yaw=person.yaw,visitId:string|null=null,carryingFolder=false;
      const step=this.demoStep;
      if(step) {
        status=step==='idle'?'idle':'working';
        if(step==='waiting'&&['M-0016','M-0017','M-0022'].includes(person.memberId))status='awaiting_answer';
        if(step==='error'&&person.memberId==='M-0016')status='error';
        if(step==='paused'&&person.memberId==='M-0018')status='paused';
        if(step==='events'&&person.status==='idle')status='idle';
        if(step==='release'&&['M-0015','M-0018','M-0019'].includes(person.memberId))status='paused';
        clip=status==='working'?workClip(person.role):status==='error'?'head_in_hands':
          status==='awaiting_answer'?'hand_raise':status==='paused'?'sit_lean_back':'sit_idle';
        place=person.asset===13?'producer':'desk';
        const home=homeSeat(person.asset);
        target={x:home.x,z:home.z};yaw=home.yaw;
        if(step==='passed'&&person.memberId==='M-0016')clip='sit_celebrate';
        if(step==='conflict'&&person.memberId==='M-0016')clip='sit_think';
        const visitor=step==='assignment'&&person.asset===13?'M-0014':
          step==='review'&&person.memberId==='M-0021'?'M-0016':
          step==='report'&&person.memberId==='M-0016'?'M-0013':null;
        if(visitor){const visited=this.people.find(other=>other.memberId===visitor);
          if(visited){place='visit';target=visitPoint(visited);yaw=facing(target,visited);visitId=visitor;
            carryingFolder=step==='assignment'||step==='review';
            clip=step==='assignment'?'hand_over':step==='review'?'hand_over':'stand_talk';}}
        const sender=step==='assignment'&&person.memberId==='M-0014'?'M-0013':
          step==='review'&&person.memberId==='M-0016'?'M-0021':null;
        if(sender){const incoming=this.states.get(sender);if(incoming&&distance(incoming,person)<1.3)clip='receive';}
      } else {
        const visit=liveVisits.find(item=>item.visitorId===person.memberId);
        if(visit){const visited=this.people.find(other=>other.memberId===visit.visitedId);
          if(visited){place='visit';target=visitPoint(visited);yaw=facing(target,visited);
            visitId=visited.memberId;carryingFolder=visit.kind!=='report';
            clip=visit.kind==='report'?'stand_talk':'hand_over';}}
        const sender=liveVisits.find(item=>item.visitedId===person.memberId&&item.kind!=='report');
        if(sender){const incoming=this.states.get(sender.visitorId);
          if(incoming&&distance(incoming,person)<1.3)clip='receive';}
      }
      if(status==='idle'&&person.asset!==13&&place!=='visit'){
        const choice=rest[person.asset<13?person.asset-1:person.asset-2]??9;
        if(choice<9){const slot=restSlots[choice];place=slot.place;target={x:slot.x,z:slot.z};yaw=slot.yaw;
          clip=place==='sofa'?'sofa_sit':place==='coffee'?'stand_drink':place==='window'?'window_gaze':'sit_think';
          if(place==='sofa'){
            const partnerIndex=rest.findIndex((other,index)=>index!==(person.asset<13?person.asset-1:person.asset-2)&&other<9&&
              restSlots[other].place==='sofa'&&this.people.some(member=>member.asset===index+1&&
                (step==='idle'||member.status==='idle')));
            const partner=partnerIndex>=0?restSlots[rest[partnerIndex]]:null;
            if(partner){yaw=facing(target,partner);clip='sofa_talk';}
          }
        } else {place='desk';const home=homeSeat(person.asset);target={x:home.x,z:home.z};yaw=home.yaw;
          clip=['sit_idle','sit_think','sit_lean_back'][person.asset%3] as StudioClip;}
      }
      if(status!==state.status){state.statusAt=this.time;state.idlePending=status==='idle'&&!step&&person.asset!==13;}
      if(status!=='idle')state.idlePending=false;
      if(status==='idle'&&!step&&state.idlePending&&place!=='visit'){
        if(cycle*45<state.statusAt+15){
          const home=homeSeat(person.asset);
          place='desk';target={x:home.x,z:home.z};yaw=home.yaw;clip='sit_think';
        } else state.idlePending=false;
      }
      if(state.arriving){
        const home=homeSeat(state.asset);place=state.asset===13?'producer':'desk';
        target={x:home.x,z:home.z};yaw=home.yaw;clip=status==='working'?workClip(person.role):'sit_idle';
        visitId=null;carryingFolder=false;
      }
      // The one-shot hand_raise action holds its final, hand-visible waiting pose.
      state.status=status;state.seat=person.seat;state.role=person.role;state.visitId=visitId;
      state.carryingFolder=carryingFolder;
      if(visitId&&distance(state,target)<1.2){const receiver=this.states.get(visitId);if(receiver)yaw=facing(state,receiver);}
      state.desiredClip=clip;state.desiredYaw=yaw;state.assignedPlace=place;
      if(distance(state.target,target)>.05) {
        state.target=target;
        if(state.phase==='rising'&&seating(place)&&distance(state,target)<.7&&distance(target,homeSeat(state.asset))<.05){
          state.path=[];state.pathIndex=0;state.phase='sitting';state.phaseTime=0;state.clip='sit_down';
          state.transitionFrom={x:state.x,z:state.z};state.transitionTo=target;
          continue;
        }
        const alreadyRising=state.phase==='rising';
        const leavingSeat=state.phase==='seated'||state.phase==='sitting';
        const origin=alreadyRising?state.transitionTo:leavingSeat?approach(state,state.yaw,state.place):{x:state.x,z:state.z};
        const walkingGoal=seating(place)?approach(target,yaw,place):target;
        state.pathGoal=walkingGoal;
        if(visitId){const visited=this.people.find(other=>other.memberId===visitId);
          const approach=visited?{x:target.x-Math.sin(visited.yaw)*.65,
            z:target.z-Math.cos(visited.yaw)*.65}:target;
          state.path=[...this.nav.route(origin,approach),target];
        } else state.path=this.routeForActor(state,origin,walkingGoal);
        state.pathIndex=0;
        if(!state.path.length&&distance(origin,walkingGoal)>.1)state.path=[walkingGoal];
        state.wait=0;
        if(alreadyRising)continue;
        if(leavingSeat) {state.phase='rising';state.phaseTime=0;state.clip='stand_up';
          state.transitionFrom={x:state.x,z:state.z};state.transitionTo=origin;}
        else {state.phase='walking';state.phaseTime=0;state.clip='walk';}
      } else if(state.phase==='seated'||state.phase==='standing') {
        state.clip=clip;state.place=place;
      }
    }
  }

  advance(dt:number,reduced=false):void {
    dt=Math.max(0,Math.min(dt,.05));this.time+=dt;
    if(this.cycleMode)this.demoStep=officeDemoStep('cycle',this.time*1000);
    if(this.demoStep==='emergency')this.stop=true;
    else if(this.stop&&this.demoStep!==null)this.stop=false;
    if(!this.stop)for(const state of this.states.values())if(state.suspendedPhase){
      state.phase=state.suspendedPhase;state.suspendedPhase=null;
      state.clip=state.phase==='rising'?'stand_up':state.phase==='sitting'?'sit_down':'walk';
    }
    if(!this.stop)for(const state of this.states.values()){
      if(state.entrancePending&&state.x>entryApron.x-.45&&state.z>entryApron.z-.2&&state.z<entryApron.z+.35)
        state.entrancePending=false;
      if(state.arriving&&!state.entrancePending&&state.phase==='seated'&&distance(state,homeSeat(state.asset))<.1){
        state.arriving=false;state.statusAt=this.time;state.idlePending=state.status==='idle';
      }
    }
    this.setTargets();
    if(this.stop) {
      for(const state of this.states.values()){
        state.speed=0;
        if(state.phase!=='seated'&&!state.suspendedPhase){state.suspendedPhase=state.phase;
          state.clip='stand_idle';state.phase='standing';}
      }
      return;
    }
    if(reduced){for(const state of this.states.values()){
      state.x=state.target.x;state.z=state.target.z;state.path=[];state.speed=0;
      state.phase=seating(state.assignedPlace)?'seated':'standing';state.clip=state.desiredClip;
      state.place=state.assignedPlace;state.yaw=state.desiredYaw;
    }return;}
    const states=[...this.states.values()].sort((a,b)=>a.asset-b.asset);
    if(this.performanceWalk)for(const state of states){
      if(state.asset===13||(state.asset<13?state.asset-1:state.asset-2)>=this.walkerLimit||state.phase!=='standing'||state.path.length)continue;
      const home=homeSeat(state.asset);
      const far=stressPoint(home,state.asset,1.0);
      const near=stressPoint(home,state.asset,.57);
      const goal=distance(state,far)<.25?near:far;
      state.target=goal;state.pathGoal=goal;state.path=[goal];
      state.pathIndex=0;
    }
    let walkers=0;
    for(const state of states){
      if(!this.performanceWalk&&this.people.length>24&&state.phase==='walking'&&state.path.length){
        if(walkers>=12){state.speed=0;state.clip='stand_idle';continue;}
        walkers++;
      }
      state.phaseTime+=dt;
      if(state.phase==='rising') {
        if(state.phaseTime<=dt+.000001&&states.some(other=>other!==state&&
          ((other.phase==='rising'&&other.asset<state.asset&&distance(other.transitionTo,state.transitionTo)<.70)||
           (other.phase==='walking'&&distance(other,state.transitionTo)<.70)))){
          state.phaseTime=0;state.clip='sit_idle';continue;
        }
        state.clip='stand_up';
        const fraction=ease(state.phaseTime/transitionDuration);
        const next={x:state.transitionFrom.x+(state.transitionTo.x-state.transitionFrom.x)*fraction,
          z:state.transitionFrom.z+(state.transitionTo.z-state.transitionFrom.z)*fraction};
        if(states.some(other=>other!==state&&distance(next,other)<.48)){state.phaseTime-=dt;continue;}
        state.x=next.x;state.z=next.z;
        if(state.phaseTime>=transitionDuration){state.phase='walking';state.phaseTime=0;state.clip='walk';}
        continue;
      }
      if(state.phase==='sitting') {
        const fraction=ease(state.phaseTime/transitionDuration);
        const next={x:state.transitionFrom.x+(state.transitionTo.x-state.transitionFrom.x)*fraction,
          z:state.transitionFrom.z+(state.transitionTo.z-state.transitionFrom.z)*fraction};
        if(states.some(other=>other!==state&&distance(next,other)<.48)){state.phaseTime-=dt;continue;}
        state.x=next.x;state.z=next.z;
        if(state.phaseTime>=transitionDuration){state.phase='seated';state.phaseTime=0;state.clip=state.desiredClip;state.place=state.assignedPlace;}
        continue;
      }
      if(state.pathIndex<state.path.length){
        if(state.phase!=='walking'){state.phase='walking';state.phaseTime=0;state.clip='walk';}
        const point=state.path[state.pathIndex],remaining=distance(state,point);
        const targetYaw=state.visitId&&distance(state,state.target)<1.2?state.desiredYaw:facing(state,point);
        const turn=norm(targetYaw-state.yaw),turnRate=state.visitId?6:2.5;
        state.yaw=norm(state.yaw+Math.max(-turnRate*dt,Math.min(turnRate*dt,turn)));
        // Plant and turn before a short reversal rather than translating
        // backwards while the body still faces the previous segment.
        if(!state.visitId&&Math.abs(turn)>.70){state.speed=0;state.clip=turn>0?'turn_left':'turn_right';continue;}
        const desired=Math.min(1.1,Math.sqrt(2*2.8*Math.max(.01,remaining)));
        state.speed=Math.min(desired,state.speed+2.8*dt);
        const step=Math.min(remaining,state.speed*dt),next=remaining>0?
          {x:state.x+(point.x-state.x)*step/remaining,z:state.z+(point.z-state.z)*step/remaining}:point;
        const blocked=states.some(other=>other!==state&&distance(next,other)<.48);
        if(blocked){state.speed=0;state.wait+=dt;state.clip='stand_idle';
          if(state.wait>.8){const obstacles=states.filter(other=>other!==state&&distance(state,other)<1.6)
            .map(other=>({name:`person ${other.id}`,minX:other.x-.42,maxX:other.x+.42,
              minZ:other.z-.42,maxZ:other.z+.42}));
            const alternate=this.routeForActor(state,state,state.pathGoal,new NavigationGrid([...this.nav.footprints,...obstacles]));
            if(alternate.length){state.path=alternate;state.pathIndex=0;}
            state.wait=0;
          }
          continue;}
        state.wait=0;state.clip='walk';state.x=next.x;state.z=next.z;state.distance+=step;
        if(remaining<=step+.005)state.pathIndex++;
        if(state.pathIndex>=state.path.length){state.path=[];state.pathIndex=0;state.speed=0;
          state.phase=seating(state.assignedPlace)?'sitting':'standing';state.phaseTime=0;
          state.transitionFrom={x:state.x,z:state.z};state.transitionTo={...state.target};
          state.clip=state.phase==='sitting'?'sit_down':state.desiredClip;state.place=state.assignedPlace;}
      } else {
        const turn=norm(state.desiredYaw-state.yaw);
        state.yaw=norm(state.yaw+Math.max(-3*dt,Math.min(3*dt,turn)));
        state.clip=state.desiredClip;state.place=state.assignedPlace;
      }
    }
    for(const state of states)if(state.departing&&state.phase==='standing'&&distance(state,state.target)<.1)
      this.states.delete(state.id);
  }

  snapshot():BehaviourSnapshot {return {time:this.time,emergency:this.stop,frames:[...this.states.values()].map(state=>({
    id:state.id,asset:state.asset,role:state.role,status:state.status,place:state.place,
    x:state.x,z:state.z,target:{...state.target},clip:state.clip,yaw:state.yaw,
    phase:state.phase,seat:state.seat,speed:state.speed,visitId:state.visitId,distance:state.distance,
    phaseProgress:Math.min(1,state.phaseTime/transitionDuration),carryingFolder:state.carryingFolder,
    headHeight:(state.suspendedPhase??state.phase)==='seated'?1.27:
      (state.suspendedPhase??state.phase)==='rising'?1.27+.6*ease(state.phaseTime/transitionDuration):
      (state.suspendedPhase??state.phase)==='sitting'?1.87-.6*ease(state.phaseTime/transitionDuration):1.87,
  }))};}
  timing(id:string):{offset:number;timeScale:number}|undefined {const state=this.states.get(id);return state&&{offset:state.offset,timeScale:state.timeScale};}
}
