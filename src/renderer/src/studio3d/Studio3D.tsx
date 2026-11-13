import { devParam, hasDevParam } from '../api/env';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ACESFilmicToneMapping, AmbientLight, AnimationAction, AnimationMixer, Box3, BoxGeometry, CanvasTexture,
  Clock, Color, CylinderGeometry, DirectionalLight, DoubleSide, Group, HemisphereLight,
  LoopOnce, LoopRepeat, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, OrthographicCamera, PlaneGeometry,
  Raycaster, Scene, SkinnedMesh, SRGBColorSpace, TorusGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ActivityView, DirectiveView, MemberView, TaskView } from '../../../shared/views';
import { officeDemoStep } from '../studio/officeDemoStep';
import { snapshotPlacement, placementProblems, restSlots, MemberSlots, homeForAsset, entryApron, entryDoor, type StudioClip, type StudioPosition } from './placement';
import { OfficeBehaviour, visitIntents, type ActorFrame } from './behaviour';
import { NavigationGrid, roomFootprints, type Footprint } from './navigation';
import { workstationFootprintsForAssets } from './navigation';
import { assembleCharacter, loadCharacterKit, looksForMembers } from './characterKit';
import { createWorkstation, floorExtension, settleWorkstation, type Workstation } from './workstations';
import { OfficeLabelController, type OfficeLabelAnchor } from '../studio/OfficeLabelController';
import { officeLabel } from '../lib/officePeople';
import { walkFootContact } from './footContact';

declare global { interface Window {
  advanceTime?: (ms:number)=>void;
  render_game_to_text?: (detail?:boolean)=>string;
  studio3dCapture?: (memberId:string,clip?:StudioClip,level?:number,view?:'front'|'frontOther'|'rear'|'side')=>void;
  studio3dPerfWalk?: (enabled:boolean,limit?:number)=>void;
  studio3dLineup?: ()=>Promise<Array<{id:string;name:string;role:string;image:string}>>;
  studio3dMeasureStanding?: ()=>Array<{id:string;height:number;headTorso:number}>;
} }
interface Props { members:MemberView[];tasks:TaskView[];directives:DirectiveView[];activity:ActivityView[];emergency:boolean;onMember:(id:string)=>void }
type Actor={root:Group;mixer:AnimationMixer;actions:Map<StudioClip,AnimationAction>;current:StudioClip|null;mug:Group;folder:Group;
  memberId:string;headScale:number;offset:number;variance:number;fade:number;blinkClock:number;animationDebt:number;ownMaterials?:boolean;
  mixerBlink:number;mixerMouth:number;
  footSide:'L'|'R'|null;footAnchor:Vector3;footOffset:Vector3;
  basePosition:Vector3;visualPrevious:Vector3|null;
  pendingFoot:{bone:Object3D;base:Vector3;measuring:boolean}|null;
  footLastBase:Vector3|null;footLastFinal:Vector3|null;footSteps:number;footSlideBefore:number;footSlideAfter:number;
  footStepSlide:number;footMaxSlide:number;
  blinkTargets:Array<{mesh:SkinnedMesh;index:number}>;mouthTargets:Array<{mesh:SkinnedMesh;index:number}>;
  materials:Array<{material:Material;opacity:number;transparent:boolean}>};
type Runtime={actors:Actor[];apply:(people:StudioPosition[],title:string,step:string,names:Map<string,string>,emergency:boolean,
  members:MemberView[],tasks:TaskView[],activity:ActivityView[])=>void};
const clipNames:StudioClip[]=['sit_type','sit_idle','stand_up','sit_down','walk','walk_folder','stand_drink','sofa_sit','sofa_talk',
  'sit_draw','sit_check','sit_write','sit_plan','sit_think','sit_lean_back','head_in_hands','hand_raise',
  'sit_celebrate','stand_idle','stand_talk','window_gaze','hold_folder','hand_over','receive','turn_left','turn_right'];
const centre=new Vector3(-1.7,.95,-.35);

function play(actor:Actor,clip:StudioClip,speed=1):void {
  const action=actor.actions.get(clip);
  const rate=actor.variance*(clip==='stand_up'||clip==='sit_down'?(action?.getClip().duration??.9)/.9:speed);
  if(actor.current===clip){action?.setEffectiveTimeScale(rate);return;}
  const next=actor.actions.get(clip);if(!next)return;
  const previous=actor.current?actor.actions.get(actor.current):undefined;
  next.reset().setEffectiveWeight(1).setEffectiveTimeScale(rate);
  next.time=['stand_up','sit_down','hand_over','receive','hand_raise'].includes(clip)?0:actor.offset*next.getClip().duration;
  const gait=(name:StudioClip|null)=>name==='walk'||name==='walk_folder'||name==='turn_left'||name==='turn_right';
  if(previous&&gait(actor.current)&&gait(clip))next.time=previous.time%next.getClip().duration;
  else if(gait(clip))next.time=0;
  next.setLoop(['stand_up','sit_down','hand_over','receive','hand_raise'].includes(clip)?LoopOnce:LoopRepeat,Infinity);
  next.clampWhenFinished=true;next.play();
  if(previous){const fade=gait(clip)?.12:.25;previous.fadeOut(fade);next.fadeIn(fade);}
  actor.current=clip;
}
function makeMug():Group {
  const mug=new Group(),ceramic=new MeshStandardMaterial({color:'#f8eee0',roughness:.4});
  const cup=new Mesh(new CylinderGeometry(.047,.040,.085,12),ceramic);cup.position.y=.045;mug.add(cup);
  const drink=new Mesh(new CylinderGeometry(.040,.040,.003,12),new MeshStandardMaterial({color:'#51392b'}));
  drink.position.y=.089;mug.add(drink);
  const handle=new Mesh(new TorusGeometry(.028,.009,6,10),ceramic);handle.position.set(.055,.045,0);mug.add(handle);
  mug.visible=false;return mug;
}
function makeFolder():Group {
  const folder=new Group();
  folder.add(new Mesh(new BoxGeometry(.22,.30,.018),new MeshStandardMaterial({color:'#c7a475',roughness:.82})));
  folder.rotation.x=-.22;folder.visible=false;return folder;
}
const rigBones=new WeakMap<Group,Map<string,Object3D>>();
function disposeMeshes(root:Object3D,ownMaterials:boolean):void {
  const geometries=new Set<Mesh['geometry']>(),materials=new Set<Material>();
  root.traverse(object=>{if(object instanceof Mesh){geometries.add(object.geometry);
    if(ownMaterials)for(const material of Array.isArray(object.material)?object.material:[object.material])materials.add(material);}});
  for(const geometry of geometries)geometry.dispose();
  for(const material of materials)material.dispose();
}
function rigBone(root:Group,name:string):Object3D|undefined {
  let bones=rigBones.get(root);
  if(!bones){bones=new Map();root.traverse(object=>{
    if(object instanceof SkinnedMesh)for(const bone of object.skeleton.bones){
      bones!.set(bone.name,bone);bones!.set(bone.name.replaceAll('_','.'),bone);
      bones!.set(bone.name.replaceAll('.','').replaceAll('_',''),bone);
    }
  });rigBones.set(root,bones);}
  return bones.get(name)??bones.get(name.replaceAll('.','_'))??bones.get(name.replaceAll('.','').replaceAll('_',''));
}
function lockPlantedFoot(actor:Actor,frozen:boolean):void {
  if(frozen){actor.root.position.add(actor.footOffset);return;}
  const walking=actor.current==='walk'||actor.current==='walk_folder'||actor.current==='turn_left'||actor.current==='turn_right';
  const action=walking?actor.actions.get(actor.current!):undefined;
  if(!action){actor.footSide=null;
    actor.footLastBase=null;actor.footLastFinal=null;return;}
  // The source walk is one second per stride pair. Each half second has one
  // planted foot; the edges are blended to avoid a snap at contact changes.
  const contact=walkFootContact(action.time);
  if(!contact){actor.footSide=null;
    actor.footLastBase=null;actor.footLastFinal=null;return;}
  const {side,weight,measuring}=contact;
  const bone=rigBone(actor.root,`foot.${side}`);
  if(!bone)return;
  actor.root.updateMatrixWorld(true);
  const base=new Vector3().setFromMatrixPosition(bone.matrixWorld);
  if(actor.footSide!==side){actor.footSide=side;actor.footAnchor.copy(base).add(actor.footOffset);
    actor.footLastBase=null;actor.footLastFinal=null;actor.footSteps++;actor.footStepSlide=0;}
  const correction=actor.footAnchor.clone().sub(base);correction.y=0;
  if(correction.length()>.50)correction.setLength(.50);
  correction.multiplyScalar(weight);actor.root.position.add(correction);
  actor.pendingFoot={bone,base,measuring};
}
function settleVisualRoot(actor:Actor,dt:number,frozen:boolean,footprints:readonly Footprint[]):void {
  // Limit changes to the foot-lock correction, not the walk itself. A global
  // root speed limit makes the planted foot drift while the path advances.
  if(!frozen){const desired=actor.root.position.clone().sub(actor.basePosition);
    const change=desired.sub(actor.footOffset),limit=3.2*dt;
    if(change.length()>limit)change.setLength(limit);
    actor.root.position.copy(actor.basePosition).add(actor.footOffset).add(change);}
  if(!frozen&&(actor.current==='walk'||actor.current==='walk_folder'||actor.current==='turn_left'||actor.current==='turn_right')){
    const clear=(point:Vector3)=>!footprints.some(box=>point.x>box.minX-.18&&point.x<box.maxX+.18&&
      point.z>box.minZ-.18&&point.z<box.maxZ+.18);
    if(clear(actor.basePosition)&&!clear(actor.root.position)){
      const desired=actor.root.position.clone();let low=0,high=1;
      for(let i=0;i<10;i++){const middle=(low+high)/2;
        if(clear(actor.basePosition.clone().lerp(desired,middle)))low=middle;else high=middle;}
      actor.root.position.copy(actor.basePosition).lerp(desired,low);
    }
  }
  actor.footOffset.copy(actor.root.position).sub(actor.basePosition);
  actor.visualPrevious=actor.root.position.clone();
}
function measureFoot(actor:Actor):void {
  const pending=actor.pendingFoot;
  if(!pending)return;
  actor.root.updateMatrixWorld(true);
  const {bone,base,measuring}=pending,final=new Vector3().setFromMatrixPosition(bone.matrixWorld);
  if(measuring){
    if(actor.footLastBase&&actor.footLastFinal){
      actor.footSlideBefore+=Math.hypot(base.x-actor.footLastBase.x,base.z-actor.footLastBase.z);
      const travel=Math.hypot(final.x-actor.footLastFinal.x,final.z-actor.footLastFinal.z);
      actor.footSlideAfter+=travel;actor.footStepSlide+=travel;actor.footMaxSlide=Math.max(actor.footMaxSlide,actor.footStepSlide);}
    actor.footLastBase=base;actor.footLastFinal=final;
  } else {actor.footLastBase=null;actor.footLastFinal=null;}
  actor.pendingFoot=null;
}
function boardCopy(directives:DirectiveView[],tasks:TaskView[]):[string,string] {
  const directive=directives.find(item=>item.state!=='closed');
  if(!directive)return ['오늘의 작업','다음 단계를 준비합니다'];
  const step=tasks.filter(task=>task.directiveId===directive.id).flatMap(task=>task.steps).find(item=>!item.done);
  return [directive.title,step?.title??'결과를 확인합니다'];
}
function paintBoard(texture:CanvasTexture,title:string,step:string):void {
  const canvas=texture.image;if(!(canvas instanceof HTMLCanvasElement))return;
  const context=canvas.getContext('2d');if(!context)return;
  context.fillStyle='#f6f1e5';context.fillRect(0,0,2048,512);
  context.fillStyle='#42675f';context.fillRect(0,0,2048,52);
  context.fillStyle='#f8f3e7';context.font='bold 31px sans-serif';context.fillText('STUDIO  /  진행 중',44,38);
  const words=title.trim().split(/\s+/);
  const lines:string[]=[''];
  for(const word of words){
    const candidate=lines[lines.length-1]?`${lines[lines.length-1]} ${word}`:word;
    if(candidate.length>12&&lines[lines.length-1]&&lines.length<2)lines.push(word);
    else lines[lines.length-1]=candidate;
  }
  if(lines[0].length>12&&lines.length===1){lines[1]=lines[0].slice(11);lines[0]=lines[0].slice(0,11);}
  context.fillStyle='#263e40';context.font='bold 175px sans-serif';
  if(lines.length===1)context.fillText(lines[0],44,255,1950);
  else {context.fillText(lines[0],44,190,1950);context.fillText(lines[1].slice(0,14),44,345,1950);}
  context.fillStyle='#a46c4e';context.fillRect(44,384,1960,4);
  context.fillStyle='#405a57';context.font='84px sans-serif';
  context.fillText(step.length>25?`${step.slice(0,24)}…`:step,44,478,1950);
  texture.needsUpdate=true;
}

function projectedPose(root:Group,camera:OrthographicCamera,width:number,height:number) {
  let top=Infinity,bottom=-Infinity,left=Infinity,right=-Infinity;
  const local=new Vector3(),world=new Vector3();
  root.traverse(object=>{
    if(!(object instanceof SkinnedMesh))return;
    const positions=object.geometry.attributes.position;
    for(let index=0;index<positions.count;index++){
      object.getVertexPosition(index,local);
      world.copy(local).applyMatrix4(object.matrixWorld).project(camera);
      const x=(world.x+1)*width/2,y=(1-world.y)*height/2;
      top=Math.min(top,y);bottom=Math.max(bottom,y);
      left=Math.min(left,x);right=Math.max(right,x);
    }
  });
  const hips=rigBone(root,'hips');
  const hipY=hips?(1-hips.getWorldPosition(world).project(camera).y)*height/2:bottom;
  return {screenX:+((left+right)/2).toFixed(1),screenY:+((top+bottom)/2).toFixed(1),
    screenHeight:+(bottom-top).toFixed(1),headTorsoHeight:+(hipY-top).toFixed(1),
    bounds:{left,top,right,bottom}};
}

export function Studio3D({members,tasks,directives,activity,emergency,onMember}:Props) {
  const container=useRef<HTMLDivElement>(null),runtime=useRef<Runtime|null>(null),onMemberRef=useRef(onMember);
  const memberCount=useRef(members.length);
  onMemberRef.current=onMember;
  const [error,setError]=useState('');
  const [title,step]=boardCopy(directives,tasks);
  const committedInput=useRef({members,tasks,directives,activity,emergency,title,step});
  useLayoutEffect(()=>{committedInput.current={members,tasks,directives,activity,emergency,title,step};
    memberCount.current=members.length;
    runtime.current?.apply(snapshotPlacement({members,tasks,directives,activity,emergency}),title,step,
    new Map(members.map(member=>[member.id,member.name])),emergency,members,tasks,activity);},
    [members,tasks,directives,activity,emergency,title,step]);
  useEffect(()=>{
    const host=container.current;if(!host)return;
    let renderer:WebGLRenderer;
    try{renderer=new WebGLRenderer({antialias:true,powerPreference:'high-performance'});}
    catch{setError('WebGL2를 사용할 수 없습니다. 2D 화면으로 전환해 주세요.');return;}
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.outputColorSpace=SRGBColorSpace;
    renderer.toneMapping=ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;renderer.shadowMap.enabled=true;
    const canvas=renderer.domElement;canvas.style.cssText='display:block;width:100%;height:100%;touch-action:none';host.appendChild(canvas);
    const scene=new Scene();scene.background=new Color('#cbd2cc');
    scene.add(new AmbientLight('#f5eee1',.55));scene.add(new HemisphereLight('#e4eff1','#aa9175',1.3));
    const sun=new DirectionalLight('#fff1d5',2.3);sun.position.set(-6,10,-2);sun.castShadow=true;
    sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-12;sun.shadow.camera.right=12;
    sun.shadow.camera.top=12;sun.shadow.camera.bottom=-12;sun.shadow.camera.near=.1;sun.shadow.camera.far=32;
    sun.shadow.bias=-.0004;sun.shadow.normalBias=.025;scene.add(sun);
    sun.shadow.autoUpdate=false;
    const fill=new DirectionalLight('#d7e4e5',.65);fill.position.set(5,6,7);scene.add(fill);
    const camera=new OrthographicCamera(-8,8,5,-5,.1,100),offset=new Vector3(-12,9,13),pan=new Vector3();
    let currentPeople:StudioPosition[]=[];
    const pendingArrivals=new Map<string,StudioPosition>();
    const newcomers=new Set<string>();
    const departingIds=new Set<string>();
    let selectedMember:string|null=null;
    const selectMember=(id:string)=>{selectedMember=id;onMemberRef.current(id);};
    const defaultOffset=offset.clone();
    let zoom=1;
    let cameraTween:{from:Vector3;to:Vector3;before:number[];after:number[];time:number}|null=null;
    const fit=(smooth=false)=>{
      const beforePosition=camera.position.clone(),beforeBounds=[camera.left,camera.right,camera.top,camera.bottom];
      const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);
      const small=currentPeople.length>0&&currentPeople.length<=4&&!pendingArrivals.size&&!newcomers.size&&!departingIds.size;
      const occupied=currentPeople.flatMap(person=>[homeForAsset(person.asset),person]);
      const minSeatX=occupied.length?Math.min(...occupied.map(person=>person.x)):-7.4;
      const maxSeatX=occupied.length?Math.max(...occupied.map(person=>person.x)):.05;
      const minSeatZ=occupied.length?Math.min(...occupied.map(person=>person.z)):-3.35;
      const maxSeatZ=occupied.length?Math.max(...occupied.map(person=>person.z)):3.15;
      const large=!small&&(currentPeople.length>13||minSeatX<-9.1);
      const focus=small?new Vector3((minSeatX+maxSeatX)/2,.95,(minSeatZ+maxSeatZ)/2):
        large?new Vector3((minSeatX+5.8)/2,.95,-.35):centre;
      camera.position.copy(focus).add(offset).add(pan);camera.lookAt(focus.clone().add(pan));camera.updateMatrixWorld();
      const right=new Vector3().setFromMatrixColumn(camera.matrixWorld,0);
      const up=new Vector3().setFromMatrixColumn(camera.matrixWorld,1);
      const xBounds=small?[minSeatX-1.3,maxSeatX+1.9]:[Math.min(-9.22,minSeatX-1.1),5.82];
      const zBounds=small?[minSeatZ-1.8,maxSeatZ+1.9]:[-5.36,4.68];
      const points=xBounds.flatMap(x=>zBounds.flatMap(z=>[-.3,3.05].map(y=>new Vector3(x,y,z).sub(focus))));
      const viewDirection=offset.clone().normalize(),depths=points.map(point=>point.dot(viewDirection));
      const cameraDistance=Math.max(offset.length(),Math.max(...depths)+4);
      camera.position.copy(focus).addScaledVector(viewDirection,cameraDistance).add(pan);
      camera.far=Math.max(100,cameraDistance-Math.min(...depths)+10);
      const xs=points.map(point=>point.dot(right)),ys=points.map(point=>point.dot(up));
      const halfW=(Math.max(...xs)-Math.min(...xs))*.54,halfY=(Math.max(...ys)-Math.min(...ys))*.55;
      const halfH=Math.max(halfY,halfW*h/w)*(large?(currentPeople.length<=24?.85:1.02):.76);
      const frameX=large?(Math.max(...xs)+Math.min(...xs))/2:0;
      const frameY=large?(Math.max(...ys)+Math.min(...ys))/2:0;
      camera.left=frameX-halfH*w/h;camera.right=frameX+halfH*w/h;
      camera.top=frameY+halfH;camera.bottom=frameY-halfH;
      camera.zoom=zoom;camera.updateProjectionMatrix();renderer.setSize(w,h,false);
      if(smooth){
        cameraTween={from:beforePosition,to:camera.position.clone(),before:beforeBounds,
          after:[camera.left,camera.right,camera.top,camera.bottom],time:0};
        camera.position.copy(beforePosition);
        [camera.left,camera.right,camera.top,camera.bottom]=beforeBounds;camera.updateProjectionMatrix();
      } else {cameraTween=null;}
      camera.updateMatrixWorld();renderer.render(scene,camera);
    };
    const observer=new ResizeObserver(()=>fit());observer.observe(host);fit();
    let down:{x:number;y:number}|null=null,dragged=false;
    const onDown=(event:PointerEvent)=>{down={x:event.clientX,y:event.clientY};dragged=false;canvas.setPointerCapture(event.pointerId);};
    const onMove=(event:PointerEvent)=>{
      if(!down){if(event.pointerType!=='touch'){const rect=canvas.getBoundingClientRect();tagController.hoverAt(event.clientX-rect.left,event.clientY-rect.top);}return;}const dx=event.clientX-down.x,dy=event.clientY-down.y;
      if(Math.hypot(dx,dy)>3)dragged=true;if(!dragged)return;tagController.close();
      const scale=(camera.top-camera.bottom)/Math.max(1,host.clientHeight)/camera.zoom;
      pan.addScaledVector(new Vector3().setFromMatrixColumn(camera.matrixWorld,0),-dx*scale);
      pan.addScaledVector(new Vector3().setFromMatrixColumn(camera.matrixWorld,1),dy*scale);
      pan.x=Math.max(-2.3,Math.min(2.3,pan.x));pan.y=Math.max(-.5,Math.min(.5,pan.y));
      pan.z=Math.max(-2,Math.min(2,pan.z));down={x:event.clientX,y:event.clientY};fit();
    };
    const pointer=new Vector2(),raycaster=new Raycaster();
    const onUp=(event:PointerEvent)=>{
      if(!down)return;down=null;if(dragged)return;
      const rect=canvas.getBoundingClientRect();
      pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
      raycaster.setFromCamera(pointer,camera);
      const actors=runtime.current?.actors??[];
      // SkinnedMesh caches its first raycast bounds. Refresh them for the
      // current pose so a head rising out of a seated pose remains clickable.
      for(const actor of actors)actor.root.traverse(object=>{
        if(object instanceof SkinnedMesh){object.computeBoundingSphere();
          if(object.boundingBox)object.computeBoundingBox();}
      });
      const hits=raycaster.intersectObjects(actors.map(actor=>actor.root),true);
      for(const hit of hits){
        const actor=actors.find(item=>{let object=hit.object;while(object.parent){if(object===item.root)return true;object=object.parent;}return object===item.root;});
        if(actor){tagController.showPerson(actor.memberId,event.pointerType);break;}
      }
    };
    const onWheel=(event:WheelEvent)=>{event.preventDefault();zoom=Math.max(.8,Math.min(1.8,zoom*Math.exp(-event.deltaY*.001)));fit();};
    const onDoubleClick=()=>{pan.set(0,0,0);offset.copy(defaultOffset);zoom=1;fit();};
    const onLeave=(event:PointerEvent)=>tagController.leave(event.relatedTarget);
    canvas.addEventListener('pointerleave',onLeave);
    canvas.addEventListener('pointerdown',onDown);canvas.addEventListener('pointermove',onMove);
    canvas.addEventListener('pointerup',onUp);canvas.addEventListener('wheel',onWheel,{passive:false});
    canvas.addEventListener('dblclick',onDoubleClick);
    const boardCanvas=document.createElement('canvas');boardCanvas.width=2048;boardCanvas.height=512;
    const board=new CanvasTexture(boardCanvas);board.colorSpace=SRGBColorSpace;
    board.anisotropy=renderer.capabilities.getMaxAnisotropy();
    const boardMesh=new Mesh(new PlaneGeometry(2.98,.82),new MeshBasicMaterial({map:board,side:DoubleSide,
      depthTest:false,depthWrite:false,toneMapped:false}));
    boardMesh.renderOrder=10;
    boardMesh.position.set(2.2,2.08,-2.86);boardMesh.rotation.y=-.27;scene.add(boardMesh);
    const actors:Actor[]=[];const actorById=new Map<string,Actor>();let roomRoot:Group|null=null;
    const stations=new Map<string,Workstation>();let extension:Group|null=null;
    const memberSlots=new MemberSlots();let layoutSignature='';
    let behaviour:OfficeBehaviour|null=null;
    let footprints:Footprint[]=[];
    let navigationFootprints:Footprint[]=[];
    const labelLayer=document.createElement('div');labelLayer.className='studio3d-tags';host.parentElement?.appendChild(labelLayer);
    const labels=new Map<string,HTMLButtonElement>();
    const tagController=new OfficeLabelController(host.parentElement??host,labels,selectMember);
    let processPending:()=>void=()=>{};
    const stopOverlay=document.createElement('div');stopOverlay.className='studio3d-stop';
    stopOverlay.innerHTML='<span>긴급 정지 중</span>';host.parentElement?.appendChild(stopOverlay);
    const chairs=new Map<string,{object:Object3D;x:number;z:number;local?:boolean}>();
    let labelViewportWidth=1,labelViewportHeight=1;
    const projectedBone=(actor:Actor|undefined,name:string)=>{
      const bone=actor&&rigBone(actor.root,name);if(!bone)return null;
      const point=new Vector3().setFromMatrixPosition(bone.matrixWorld).project(camera);
      return {x:(point.x+1)*labelViewportWidth/2,y:(1-point.y)*labelViewportHeight/2};
    };
    const projectedHead=(actor:Actor|undefined)=>{
      const head=actor&&rigBone(actor.root,'head');if(!actor||!head)return null;
      const point=new Vector3(0,.14*actor.headScale,.015).applyMatrix4(head.matrixWorld).project(camera);
      return {x:(point.x+1)*labelViewportWidth/2,y:(1-point.y)*labelViewportHeight/2,
        radius:.21*actor.headScale*labelViewportHeight*camera.zoom/(camera.top-camera.bottom)};
    };
    const updateLabels=(frames:ActorFrame[])=>{
      labelViewportWidth=host.clientWidth;labelViewportHeight=host.clientHeight;
      scene.updateMatrixWorld(true);
      const anchors:OfficeLabelAnchor[]=[];
      let arrivalFinished=false;
      for(const frame of frames){
        const actor=actorById.get(frame.id),head=projectedHead(actor);
        const member=latest?.members.find(member=>member.id===frame.id);if(!head||!member)continue;
        if(newcomers.has(frame.id)&&frame.phase==='seated'){newcomers.delete(frame.id);arrivalFinished=true;}
        const feet=new Vector3(frame.x,0,frame.z).project(camera),feetY=(1-feet.y)*labelViewportHeight/2;
        anchors.push({id:frame.id,label:officeLabel(member,{tasks:latest?.tasks??[],directives:committedInput.current.directives},latest?.emergency),head,
          headArea:{x:head.x-head.radius,y:head.y-head.radius*1.15,width:head.radius*2,height:head.radius*2.2},
          bodyArea:{x:head.x-head.radius*1.5,y:head.y-head.radius,width:head.radius*3,height:Math.max(head.radius*3,feetY-head.y+head.radius*1.4)}});
      }
      const boardPoints=[[-1.49,-.41],[1.49,-.41],[-1.49,.41],[1.49,.41]].map(([x,y])=>new Vector3(x,y,0).applyMatrix4(boardMesh.matrixWorld).project(camera));
      const xs=boardPoints.map(point=>(point.x+1)*labelViewportWidth/2),ys=boardPoints.map(point=>(1-point.y)*labelViewportHeight/2);
      tagController.update(anchors,[{x:Math.min(...xs)-4,y:Math.min(...ys)-4,width:Math.max(...xs)-Math.min(...xs)+8,height:Math.max(...ys)-Math.min(...ys)+8}]);
      if(arrivalFinished&&currentPeople.length<=4&&!newcomers.size&&!pendingArrivals.size&&!departingIds.size)fit(true);
    };
    let disposed=false,ready=false,manual=false,elapsed=0,frame=0,labelClock=0,shadowClock=0;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    const tick=(dt:number,draw=true)=>{
      let labelFrames:ActorFrame[]=[];
      elapsed+=dt;
      processPending();
      if(ready&&behaviour){behaviour.advance(dt,reduced.matches);const state=behaviour.snapshot();
        labelFrames=state.frames;
        stopOverlay.classList.toggle('visible',state.emergency);
        for(const person of state.frames){const actor=actorById.get(person.id);if(!actor)continue;
          const jumped=reduced.matches&&Math.hypot(actor.root.position.x-person.x,actor.root.position.z-person.z)>.1;
          if(jumped){actor.fade=0;
            if(!actor.ownMaterials){
              actor.root.traverse(object=>{if(object instanceof Mesh)object.material=Array.isArray(object.material)?object.material.map(material=>material.clone()):object.material.clone();});
              const privateMaterials=new Set<Material>();actor.root.traverse(object=>{if(object instanceof Mesh)for(const material of Array.isArray(object.material)?object.material:[object.material])privateMaterials.add(material);});
              actor.materials=[...privateMaterials].map(material=>({material,opacity:material.opacity,transparent:material.transparent}));actor.ownMaterials=true;
            }
          }
          actor.root.position.set(person.x,0,person.z);actor.root.rotation.y=person.yaw;
          actor.basePosition.copy(actor.root.position);
          if(reduced.matches){const prior=actor.fade;actor.fade=Math.min(1,actor.fade+dt/.24);
            if(prior<1||jumped){
            for(const entry of actor.materials){entry.material.transparent=actor.fade<1||entry.transparent;
              entry.material.opacity=entry.opacity*actor.fade;entry.material.needsUpdate=true;}
            const label=labels.get(person.id);if(label)label.style.opacity=String(actor.fade);
            }
          } else if(actor.fade<1){actor.fade=1;
            for(const entry of actor.materials){entry.material.opacity=entry.opacity;
              entry.material.transparent=entry.transparent;entry.material.needsUpdate=true;}
            const label=labels.get(person.id);if(label)label.style.opacity='1';}
          const playedClip=person.clip==='walk'&&person.carryingFolder?'walk_folder':person.clip;
          play(actor,playedClip,person.clip==='walk'?Math.max(.20,person.speed/1.1):1);
          actor.folder.visible=(person.carryingFolder||person.clip==='receive')&&actor.root.visible;
          const meetingIndex=person.place==='meeting'?[restSlots[3],restSlots[7],restSlots[8]]
            .findIndex(slot=>Math.hypot(slot.x-person.x,slot.z-person.z)<.3):-1;
          const homeChair=chairs.get(person.id);
          const factor=person.phase==='seated'?0:person.phase==='rising'?person.phaseProgress:
            person.phase==='sitting'?1-person.phaseProgress:1;
          if(homeChair){const home=currentPeople.find(item=>item.memberId===person.id);
            const homeFactor=person.place==='desk'||person.place==='producer'?factor:1;
            if(homeChair.local){homeChair.object.position.x=0;homeChair.object.position.z=-.22*homeFactor;}
            else {homeChair.object.position.x=homeChair.x-Math.sin(home?.yaw??0)*.22*homeFactor;
              homeChair.object.position.z=homeChair.z-Math.cos(home?.yaw??0)*.22*homeFactor;}}
          if(meetingIndex>=0){const meetingChair=chairs.get(`meeting ${meetingIndex}`);
            if(meetingChair){meetingChair.object.position.x=meetingChair.x-Math.sin(person.yaw)*.22*factor;
              meetingChair.object.position.z=meetingChair.z-Math.cos(person.yaw)*.22*factor;}}
        }
      }
      const frozen=behaviour?.snapshot().emergency??false;
      if(cameraTween&&!frozen){
        cameraTween.time+=dt;const t=Math.min(1,cameraTween.time/.75),eased=t*t*(3-2*t);
        camera.position.lerpVectors(cameraTween.from,cameraTween.to,eased);
        [camera.left,camera.right,camera.top,camera.bottom]=cameraTween.before.map((value,index)=>value+(cameraTween!.after[index]-value)*eased);
        camera.updateMatrixWorld();camera.updateProjectionMatrix();if(t===1)cameraTween=null;
      }
      for(const station of stations.values())settleWorkstation(station,elapsed,manual&&elapsed===0,frozen);
      if(ready&&behaviour){
        const active=new Set(behaviour.snapshot().frames.map(person=>person.id));
        let retired=false;
        for(const [id,actor] of actorById)if(!active.has(id)){
          retired=true;departingIds.delete(id);newcomers.delete(id);
          actor.mixer.stopAllAction();scene.remove(actor.root,actor.mug,actor.folder);
          disposeMeshes(actor.root,!!actor.ownMaterials);disposeMeshes(actor.mug,true);disposeMeshes(actor.folder,true);
          actorById.delete(id);actors.splice(actors.indexOf(actor),1);
          const station=stations.get(id);if(station){scene.remove(station.root);disposeMeshes(station.root,true);stations.delete(id);chairs.delete(id);}
          memberSlots.release(id);
          labels.get(id)?.remove();labels.delete(id);
        }
        currentPeople=currentPeople.filter(person=>active.has(person.memberId)||pendingArrivals.has(person.memberId));
        if(retired&&currentPeople.length<=4)fit(true);
      }
      if(ready)for(const actor of actors){
        actor.animationDebt+=frozen?0:dt*(reduced.matches?.12:1);
        const continuous=['walk','walk_folder','turn_left','turn_right','stand_up','sit_down','hand_over','receive'].includes(actor.current??'');
        if(continuous||actor.animationDebt>=1/25||dt===0){actor.mixer.update(actor.animationDebt);actor.animationDebt=0;}
        actor.pendingFoot=null;
        actor.mixerBlink=actor.blinkTargets.reduce((value,target)=>
          Math.max(value,target.mesh.morphTargetInfluences?.[target.index]??0),0);
        actor.mixerMouth=actor.mouthTargets.reduce((value,target)=>
          Math.max(value,target.mesh.morphTargetInfluences?.[target.index]??0),0);
        if(!frozen){actor.blinkClock+=dt;const cycle=(actor.blinkClock%3.73);
          const blink=cycle<.09?cycle/.09:cycle<.22?(.22-cycle)/.13:0;
          for(const {mesh,index} of actor.blinkTargets)if(mesh.morphTargetInfluences)
            mesh.morphTargetInfluences[index]=Math.max(mesh.morphTargetInfluences[index],blink);}
        lockPlantedFoot(actor,frozen);
        settleVisualRoot(actor,dt,frozen||reduced.matches,navigationFootprints);
        const hand=rigBone(actor.root,actor.current==='receive'?'handL':'handR');
        actor.mug.visible=actor.root.visible&&actor.current==='stand_drink'&&!!hand;
        if((actor.mug.visible||actor.folder.visible)&&hand)actor.root.updateMatrixWorld(true);
        if(actor.mug.visible&&hand){actor.mug.position.setFromMatrixPosition(hand.matrixWorld);
          actor.mug.position.add(new Vector3(-.075,.01,.015).applyQuaternion(actor.root.quaternion));}
        if(actor.folder.visible&&hand){actor.folder.position.setFromMatrixPosition(hand.matrixWorld);
          actor.folder.position.add(new Vector3(.02,-.12,.01).applyQuaternion(actor.root.quaternion));
          actor.folder.rotation.y=actor.root.rotation.y;}
      }
      if(!frozen)for(let pass=0;pass<3;pass++)for(let i=0;i<actors.length;i++)for(let j=i+1;j<actors.length;j++){
        const actor=actors[i],other=actors[j];
        if(actor.footOffset.lengthSq()<.00000001&&other.footOffset.lengthSq()<.00000001)continue;
        if(actor.root.position.distanceTo(other.root.position)>=.48)continue;
        const wantedA=actor.root.position.clone(),wantedB=other.root.position.clone();let low=0,high=1;
        for(let step=0;step<10;step++){
          const t=(low+high)/2,a=actor.basePosition.clone().lerp(wantedA,t),b=other.basePosition.clone().lerp(wantedB,t);
          if(a.distanceTo(b)>=.48)low=t;else high=t;
        }
        actor.root.position.copy(actor.basePosition).lerp(wantedA,low);
        other.root.position.copy(other.basePosition).lerp(wantedB,low);
        actor.footOffset.copy(actor.root.position).sub(actor.basePosition);
        other.footOffset.copy(other.root.position).sub(other.basePosition);
      }
      // Foot QA samples are useful in deterministic playback. Live rendering
      // already computes these world matrices, so avoid a second traversal.
      if(manual)for(const actor of actors)measureFoot(actor);
      labelClock+=dt;
      if(ready&&(labelClock>=(cameraTween?1/30:1/15)||dt===0||reduced.matches)){
        updateLabels(labelFrames);labelClock=0;}
      shadowClock+=dt;
      if(shadowClock>=1/15-.0001||dt===0){sun.shadow.needsUpdate=true;shadowClock%=1/15;}
      if(draw)renderer.render(scene,camera);
    };
    const clock=new Clock();
    const animate=()=>{frame=requestAnimationFrame(animate);if(!manual)tick(Math.min(.05,clock.getDelta())*(reduced.matches?.12:1));};
    frame=requestAnimationFrame(animate);
    window.advanceTime=(ms)=>{if(!manual){manual=true;elapsed=0;behaviour?.reset();
      for(const actor of actors){const action=actor.current?actor.actions.get(actor.current):undefined;
        if(action)action.time=actor.offset*action.getClip().duration;}}
      let left=Math.max(0,ms)/1000;while(left>0){const dt=Math.min(left,1/60);tick(dt,false);left-=dt;}tick(0);};
    if(import.meta.env.DEV||hasDevParam('perfWalk'))
      window.studio3dPerfWalk=(enabled,limit)=>{
        behaviour?.setPerformanceWalk(enabled,limit);
        if(enabled)for(const actor of actors){
          actor.mixer.stopAllAction();actor.current=null;actor.footSide=null;actor.footOffset.set(0,0,0);
          actor.footLastBase=null;actor.footLastFinal=null;actor.footSteps=0;
          actor.footSlideBefore=0;actor.footSlideAfter=0;actor.footStepSlide=0;actor.footMaxSlide=0;
        }
      };
    window.studio3dCapture=(memberId,clip,level=5.3,view='front')=>{
      const frames=behaviour?.snapshot().frames??[];
      const person=frames.find(item=>item.id===memberId);
      if(!person)return;
      labelLayer.style.display='none';
      boardMesh.visible=false;
      roomRoot?.traverse(object=>{
        if(object instanceof Mesh)object.visible=person.place!=='coffee'||
          /^(floor slab|plank |coffee cabinet|coffee counter|coffee shelf|coffee cup|coffee book)/.test(object.name);
      });
      const partner=person.place==='sofa'?frames.find(item=>item.place==='sofa'&&item.id!==person.id):undefined;
      for(const actor of actors){
        actor.root.visible=actor.memberId===person.id||actor.memberId===partner?.id;
        if(!actor.root.visible){actor.mug.visible=false;actor.folder.visible=false;}
      }
      for(const station of stations.values())station.root.visible=(person.place==='desk'||person.place==='producer')&&station.memberId===person.id;
      pan.set((partner?(person.x+partner.x)/2:person.x)-centre.x,0,person.z-centre.z);zoom=level;
      const angle=person.place==='sofa'?.2:view==='side'?1.9:person.yaw+(view==='rear'?Math.PI:view==='frontOther'?-.4:.4);
      offset.set(Math.sin(angle)*12,view==='side'?4.7:6.7,Math.cos(angle)*12);
      if(clip){const actor=actorById.get(person.id);if(actor)play(actor,clip);}
      fit();
    };
    window.render_game_to_text=(detail=true)=>{scene.updateMatrixWorld(true);const state=behaviour?.snapshot();
      const hostRect=host.getBoundingClientRect();
      return JSON.stringify({ready,time:+elapsed.toFixed(2),expectedCount:memberCount.current,selectedMember,
      projectId:committedInput.current.members[0]?.projectId??null,entryDoor,emergency:state?.emergency,
      footprints:navigationFootprints,sharedFootprints:footprints,
      render:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles},
      characterCount:actorById.size,
      workstations:[...stations.values()].map(station=>({id:station.memberId,
        x:station.root.position.x,y:station.root.position.y,z:station.root.position.z,scale:station.root.scale.y,
        settle:station.settled?1:Math.min(1,Math.max(0,(elapsed-station.bornAt)/.85))})),
      chairs:[...chairs].map(([name,chair])=>({name,x:chair.object.getWorldPosition(new Vector3()).x,z:chair.object.getWorldPosition(new Vector3()).z,
        homeX:chair.x,homeZ:chair.z})),
      footSlide:{steps:actors.reduce((sum,actor)=>sum+actor.footSteps,0),
        before:actors.reduce((sum,actor)=>sum+actor.footSlideBefore,0),
        after:actors.reduce((sum,actor)=>sum+actor.footSlideAfter,0),maxStep:Math.max(0,...actors.map(actor=>actor.footMaxSlide)),
        actors:actors.map(actor=>({id:actor.memberId,max:actor.footMaxSlide,offset:actor.footOffset.length()}))},
      camera:{zoom:+zoom.toFixed(2),panX:+pan.x.toFixed(2),panZ:+pan.z.toFixed(2),width:host.clientWidth,height:host.clientHeight},
      people:currentPeople.map(person=>{
        const frame=state?.frames.find(item=>item.id===person.memberId);
        const actor=actorById.get(person.memberId);
        const head=projectedHead(actor);
        const bounds=detail&&actor?projectedPose(actor.root,camera,host.clientWidth,host.clientHeight):null;
        const hand=actor?rigBone(actor.root,'handR'):undefined;
        const tag=labels.get(person.memberId),tagRect=tag?.style.display==='none'?null:tag?.getBoundingClientRect();
        return {id:person.memberId,x:frame?.x??person.x,z:frame?.z??person.z,
          visualX:actor?.root.position.x??person.x,visualZ:actor?.root.position.z??person.z,
          target:frame?.target??{x:person.x,z:person.z},clip:frame?.clip??actor?.current,
          activeClip:actor?.current,
          hipHeight:actor?new Vector3().setFromMatrixPosition(rigBone(actor.root,'hips')!.matrixWorld).y:null,
          clickPoint:head?{x:head.x+hostRect.left,y:head.y+hostRect.top}:null,headRadius:head?.radius??0,
          place:frame?.place??person.place,seat:person.seat,role:person.role,status:frame?.status??person.status,
          pose:frame?.phase??'seated',walking:frame?.phase==='walking',yaw:frame?.yaw??person.yaw,
          eyeBlink:actor?.blinkTargets.reduce((value,target)=>Math.max(value,target.mesh.morphTargetInfluences?.[target.index]??0),0)??0,
          mouthOpen:actor?.mouthTargets.reduce((value,target)=>Math.max(value,target.mesh.morphTargetInfluences?.[target.index]??0),0)??0,
          mixerBlink:actor?.mixerBlink??0,mixerMouth:actor?.mixerMouth??0,
          posePoints:frame?.status==='awaiting_answer'||frame?.status==='error'?
            ['head','handR',...(frame.status==='error'?['handL']:[])].flatMap(name=>{
              const point=projectedBone(actor,name);
              return point?[{name,x:point.x+hostRect.left,y:point.y+hostRect.top}]:[];}):[],
          visiting:frame?.visitId??null,tagRect:tagRect?{x:+tagRect.x.toFixed(1),y:+tagRect.y.toFixed(1),width:tagRect.width,height:tagRect.height}:null,
          folderHeld:frame?.carryingFolder&&!!actor?.folder.visible,
          mugHeld:frame?.clip==='stand_drink'&&!!actor?.mug.visible&&!!hand&&
            actor.mug.position.distanceTo(hand.getWorldPosition(new Vector3()))<.1,
          mugDiagnostic:frame?.clip==='stand_drink'?{
            visible:actor?.mug.visible,hasHand:!!hand,
            distance:hand&&actor?+actor.mug.position.distanceTo(hand.getWorldPosition(new Vector3())).toFixed(3):null,
          }:undefined,...bounds};
      }),problems:placementProblems(currentPeople)});};
    const loader=new GLTFLoader();
    let firstApply=true;
    let lastBoard='';
    let latest:{positions:StudioPosition[];emergency:boolean;members:MemberView[];tasks:TaskView[];activity:ActivityView[]}|null=null;
    Promise.all([loader.loadAsync('./studio3d/room.glb'),loader.loadAsync('./studio3d/workstation_kit.glb'),
      loadCharacterKit()]).then(([room,stationKit,characterKit])=>{
      if(disposed)return;
      roomRoot=room.scene;
      footprints=roomFootprints(room.scene);
      behaviour=new OfficeBehaviour(new NavigationGrid(footprints));
      room.scene.updateMatrixWorld(true);
      room.scene.traverse(object=>{object.matrixAutoUpdate=false;if(object instanceof Mesh){object.receiveShadow=true;
        object.castShadow=object.parent?.name.startsWith('chair_')||
          object.parent?.name.includes('chair')||false;}});
      // GLTFLoader sanitizes exported spaces to underscores in node names.
      room.scene.traverse(object=>{if(!/^chair_\d+$|^producer_chair$|^meeting_(?:south_left|south_right|north)$/.test(object.name))return;
        const key=object.name==='meeting_south_left'?'meeting 0':object.name==='meeting_south_right'?'meeting 1':
          object.name==='meeting_north'?'meeting 2':object.name.replaceAll('_',' ');
        object.matrixAutoUpdate=true;
        chairs.set(key,{object,x:object.position.x,z:object.position.z});});
      scene.add(room.scene);
      const createActor=(member:MemberView,person:StudioPosition,arriving=false)=>{
        const generated=assembleCharacter(member,characterKit);
        const root=generated.root;const materialSet=new Set<Material>();
        const blinkTargets:Array<{mesh:SkinnedMesh;index:number}>=[],mouthTargets:Array<{mesh:SkinnedMesh;index:number}>=[];
        root.traverse(object=>{if(object instanceof Mesh){object.castShadow=true;object.receiveShadow=false;
          const materials=Array.isArray(object.material)?object.material:[object.material];
          for(const material of materials)materialSet.add(material);
          if(object instanceof SkinnedMesh){const blink=object.morphTargetDictionary?.eyeBlink;
            if(blink!==undefined)blinkTargets.push({mesh:object,index:blink});
            const mouth=object.morphTargetDictionary?.mouthOpen;
            if(mouth!==undefined)mouthTargets.push({mesh:object,index:mouth});}}});
        const mixer=new AnimationMixer(root),actions=new Map<StudioClip,AnimationAction>();
        for(const name of clipNames){const clip=generated.animations.find(item=>item.name===name);
          if(clip)actions.set(name,mixer.clipAction(clip));}
        const mug=makeMug(),folder=makeFolder();scene.add(mug);scene.add(folder);scene.add(root);
        const index=actors.length;
        const actor:Actor={root,mixer,actions,current:null,mug,folder,memberId:member.id,
          headScale:Number(root.getObjectByName('Rig')?.userData.kit_height??1),
          offset:(index*.61803398875)%1,variance:1,fade:1,blinkClock:index*.61803398875*3.73,animationDebt:0,
          mixerBlink:0,mixerMouth:0,
          blinkTargets,mouthTargets,
          footSide:null,footAnchor:new Vector3(),footOffset:new Vector3(),footLastBase:null,footLastFinal:null,
          basePosition:new Vector3(),visualPrevious:null,pendingFoot:null,
          footSteps:0,footSlideBefore:0,footSlideAfter:0,footStepSlide:0,footMaxSlide:0,
          materials:[...materialSet].map(material=>({material,opacity:material.opacity,transparent:material.transparent}))};
        actors.push(actor);actorById.set(member.id,actor);
        root.position.set(arriving?entryDoor.x:person.x,0,arriving?entryDoor.z:person.z);root.rotation.y=person.yaw;
        actor.basePosition.copy(root.position);actor.visualPrevious=root.position.clone();
        play(actor,arriving?'stand_idle':person.clip);mixer.update(0);
        const bounds=new Box3().setFromObject(root);
        if(bounds.getSize(new Vector3()).y>3)console.warn('studio3d: unexpected character scale');
        const label=document.createElement('button');label.type='button';label.className='studio3d-tag';
        label.dataset.memberId=member.id;
        labelLayer.appendChild(label);labels.set(member.id,label);
        const name=document.createElement('strong');name.className='staff-name';name.textContent=member.name;label.appendChild(name);
      };
      const enterPending=()=>{
        if(!latest||!behaviour)return;
        if(behaviour.snapshot().emergency||actors.some(actor=>actor.root.position.x>entryApron.x-.25&&actor.root.position.z<entryApron.z+.35))return;
        let added=false;
        for(const [id,person] of pendingArrivals)if((stations.get(id)?.bornAt??Infinity)+.85<=elapsed){
          const member=latest.members.find(item=>item.id===id);
          if(member){createActor(member,person,true);newcomers.add(id);added=true;}
          pendingArrivals.delete(id);
          break;
        }
        if(added){const demo=devParam('officeDemo');
          behaviour.apply(latest.positions.filter(person=>!pendingArrivals.has(person.memberId)),latest.emergency,
            demo?officeDemoStep(demo,elapsed*1000):null,demo==='cycle',
            visitIntents(latest.members,latest.tasks,latest.activity,Date.now()));}
      };
      processPending=enterPending;
      window.studio3dLineup=async()=>{
        const module=await import('./portrait');
        const members=[...(latest?.members??[])].sort((a,b)=>Number(b.isProducer)-Number(a.isProducer)).slice(0,24);
        const result:Array<{id:string;name:string;role:string;image:string}>=[];
        for(const member of members)result.push({id:member.id,name:member.name,role:member.roleId,image:await module.renderGeneratedStanding(member)});
        return result;
      };
      window.studio3dMeasureStanding=()=>actors.map(actor=>{
        const previous=actor.current;
        actor.mixer.stopAllAction();actor.current=null;play(actor,'stand_idle');actor.mixer.update(.18);
        scene.updateMatrixWorld(true);
        const bounds=projectedPose(actor.root,camera,host.clientWidth,host.clientHeight);
        actor.mixer.stopAllAction();actor.current=null;if(previous)play(actor,previous);actor.mixer.update(0);
        return {id:actor.memberId,height:bounds.screenHeight,headTorso:bounds.headTorsoHeight};
      });
      const apply=(positions:StudioPosition[],newTitle:string,newStep:string,names:Map<string,string>,isEmergency:boolean,
        liveMembers:MemberView[],liveTasks:TaskView[],liveActivity:ActivityView[])=>{
        const assignments=memberSlots.assign(liveMembers);
        positions=positions.map(person=>{
          const asset=assignments.get(person.memberId)??person.asset;
          const home=homeForAsset(asset);
          return {...person,asset,seat:asset,...(person.place==='desk'||person.place==='producer'?home:{})};
        });
        looksForMembers(liveMembers);
        latest={positions,emergency:isEmergency,members:liveMembers,tasks:liveTasks,activity:liveActivity};
        const previous=currentPeople;
        currentPeople=[...positions,...previous.filter(item=>!positions.some(person=>person.memberId===item.memberId))];
        const wasDeparting=departingIds.size>0;
        departingIds.clear();
        for(const person of previous)if(actorById.has(person.memberId)&&!positions.some(item=>item.memberId===person.memberId))departingIds.add(person.memberId);
        const boardKey=`${newTitle}\n${newStep}`;
        if(boardKey!==lastBoard){paintBoard(board,newTitle,newStep);lastBoard=boardKey;}
        for(const [id] of pendingArrivals)if(!positions.some(person=>person.memberId===id)){
          pendingArrivals.delete(id);const station=stations.get(id);
          if(station){scene.remove(station.root);disposeMeshes(station.root,true);stations.delete(id);chairs.delete(id);}memberSlots.release(id);
          currentPeople=currentPeople.filter(person=>person.memberId!==id);}
        for(const person of positions){
          const member=liveMembers.find(item=>item.id===person.memberId);if(!member)continue;
          if(!stations.has(member.id)){
            const index=person.asset<13?person.asset-1:person.asset-2;
            const station=createWorkstation(stationKit,member,index,firstApply?-Infinity:elapsed);
            stations.set(member.id,station);scene.add(station.root);
            chairs.set(member.id,{object:station.chair,x:person.x,z:person.z,local:true});
            settleWorkstation(station,elapsed,firstApply);
          }
          if(!actorById.has(member.id)&&!pendingArrivals.has(member.id)){
            if(firstApply)createActor(member,person);else pendingArrivals.set(member.id,person);
          }
          if(pendingArrivals.has(member.id))pendingArrivals.set(member.id,person);
        }
        const signature=[...stations.keys()].sort().join('|');
        const layoutChanged=signature!==layoutSignature;
        if(layoutChanged){
          layoutSignature=signature;
          if(extension){scene.remove(extension);disposeMeshes(extension,true);}
          const assets=memberSlots.assets();
          const extent=Math.max(0,...assets.map(asset=>asset===13?1:asset<13?asset+1:asset));
          extension=floorExtension(extent);scene.add(extension);
          // Keep the circulation lanes around the original pods clear before
          // hiring fills them. They are navigation reservations, never meshes.
          const reserved=[13,...Array.from({length:12},(_,index)=>index+1)];
          const navigationAssets=[...new Set([...reserved,...assets])];
          navigationFootprints=[...footprints,...workstationFootprintsForAssets(navigationAssets,new Set(navigationAssets))];
          behaviour?.setNavigation(new NavigationGrid(navigationFootprints));
        }
        const demo=devParam('officeDemo');
        behaviour?.apply(positions.filter(person=>!pendingArrivals.has(person.memberId)),isEmergency&&!(manual&&demo==='cycle'),
          demo?officeDemoStep(demo,elapsed*1000):null,demo==='cycle',
          visitIntents(liveMembers,liveTasks,liveActivity,Date.now()));
        positions.forEach(person=>{const actor=actorById.get(person.memberId);if(!actor)return;
          actor.root.visible=true;
          const timing=behaviour?.timing(person.memberId);actor.variance=timing?.timeScale??1;
        });
        if(layoutChanged||wasDeparting!==(departingIds.size>0))fit(!firstApply);
        if(behaviour)updateLabels(behaviour.snapshot().frames);
        if(positions.length)firstApply=false;
      };
      ready=true;runtime.current={actors,apply};
      const current=committedInput.current;
      apply(snapshotPlacement(current),current.title,current.step,
        new Map(current.members.map(member=>[member.id,member.name])),current.emergency,current.members,current.tasks,current.activity);
    }).catch((reason:unknown)=>{if(!disposed)setError(reason instanceof Error?reason.message:'3D 자산을 불러오지 못했습니다.');});
    return()=>{
      disposed=true;cancelAnimationFrame(frame);observer.disconnect();
      tagController.dispose();canvas.removeEventListener('pointerleave',onLeave);
      canvas.removeEventListener('pointerdown',onDown);canvas.removeEventListener('pointermove',onMove);
      canvas.removeEventListener('pointerup',onUp);canvas.removeEventListener('wheel',onWheel);
      canvas.removeEventListener('dblclick',onDoubleClick);delete window.advanceTime;
      delete window.render_game_to_text;delete window.studio3dCapture;
      delete window.studio3dPerfWalk;
      delete window.studio3dLineup;
      delete window.studio3dMeasureStanding;
      for(const actor of actors)actor.mixer.stopAllAction();board.dispose();runtime.current=null;renderer.dispose();renderer.forceContextLoss();canvas.remove();labelLayer.remove();stopOverlay.remove();
    };
  },[]);
  return <div className="office-scene" style={{borderColor:'#7a857d',background:'#cbd2cc'}}>
    <div ref={container} style={{position:'absolute',inset:0}} />
    {error&&<p style={{position:'absolute',inset:20,color:'#713c31'}}>{error}</p>}
  </div>;
}
