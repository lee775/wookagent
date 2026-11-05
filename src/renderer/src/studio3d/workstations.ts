import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MemberView } from '../../../shared/views';
import { deskSeat, producerSeat } from './placement';

const hash=(value:string)=>[...value].reduce((n,c)=>(Math.imul(n,33)+c.charCodeAt(0))>>>0,5381);
export interface Workstation { memberId:string;asset:number;variant:string;root:Group;chair:Object3D;bornAt:number;lastAt:number;leaving:boolean;settled:boolean }
export function workstationVariant(member:MemberView):'desk_straight'|'desk_l'|'desk_standing' {
  if(member.isProducer||member.roleId==='planner')return 'desk_l';
  const choice=hash(member.id)%7;
  return choice===0?'desk_standing':choice===1?'desk_l':'desk_straight';
}
export function workstationModules(member:MemberView,variant=workstationVariant(member)):string[] {
  const hashValue=hash(member.id);
  const role=member.roleId;
  const primary=role==='ui_designer'?'pen_tablet':role==='docs'||role==='qa'?'document_tray':
    role==='planner'||role==='architect'?'sticky_board':'notebook';
  const screen=role==='docs'||role==='planner'||(hashValue&7)===0?'laptop':'monitor';
  const personal=['mug','plant','photo','headphones'][(hashValue>>>4)%4];
  const second=['mug','plant','photo','headphones'][(hashValue>>>9)%4];
  return [variant,'chair',screen,primary,personal,...(second!==personal?[second]:[])];
}
export function createWorkstation(kit:GLTF,member:MemberView,index:number,bornAt:number):Workstation {
  const seat=member.isProducer?producerSeat:deskSeat(index);
  const variant=Math.abs(Math.sin(seat.yaw))>.7?'desk_straight':workstationVariant(member);
  const root=new Group();root.name=`workstation_${member.id}`;
  root.position.set(seat.x,0,seat.z);root.rotation.y=seat.yaw;
  let chair:Object3D|undefined;
  for(const name of workstationModules(member,variant)){
    const module=kit.scene.getObjectByName(name);
    if(!module)throw new Error(`workstation module missing: ${name}`);
    const copy=module.clone(true);copy.name=name;
    copy.traverse(part=>{if(part instanceof Mesh){part.castShadow=true;part.receiveShadow=true;}});
    root.add(copy);if(name==='chair')chair=copy;
  }
  if(!chair)throw new Error('workstation chair missing');
  root.remove(chair);
  batchFurniture(root);batchFurniture(chair);root.add(chair);
  return {memberId:member.id,asset:member.isProducer?13:index<12?index+1:index+2,
    variant,root,chair,bornAt,lastAt:Number.isFinite(bornAt)?bornAt:0,leaving:false,settled:false};
}
// Vertex colours retain the warm material palette while the static desktop and
// its independently moving chair each cost a single draw call.
function batchFurniture(group:Object3D):void {
  group.updateWorldMatrix(true,true);
  const inverse=new Matrix4().copy(group.matrixWorld).invert();
  const geometries:BufferGeometry[]=[];
  group.traverse(object=>{
    if(!(object instanceof Mesh))return;
    const material=Array.isArray(object.material)?object.material[0]:object.material;
    if(!(material instanceof MeshStandardMaterial))return;
    let geometry=object.geometry.clone();
    if(geometry.index)geometry=geometry.toNonIndexed();
    geometry.applyMatrix4(new Matrix4().multiplyMatrices(inverse,object.matrixWorld));
    for(const attribute of Object.keys(geometry.attributes))if(attribute!=='position'&&attribute!=='normal')geometry.deleteAttribute(attribute);
    const count=geometry.getAttribute('position').count,colors=new Float32Array(count*3);
    for(let i=0;i<count;i++)colors.set([material.color.r,material.color.g,material.color.b],i*3);
    geometry.setAttribute('color',new Float32BufferAttribute(colors,3));
    geometries.push(geometry);
  });
  const geometry=mergeGeometries(geometries);
  if(!geometry)throw new Error('Cannot batch workstation geometry');
  group.clear();
  const mesh=new Mesh(geometry,new MeshStandardMaterial({vertexColors:true,roughness:.77}));
  mesh.castShadow=true;mesh.receiveShadow=true;mesh.updateMatrix();mesh.matrixAutoUpdate=false;group.add(mesh);
  for(const part of geometries)part.dispose();
}
export function settleWorkstation(station:Workstation,now:number,instant=false,paused=false):number {
  if(paused&&!station.settled)station.bornAt+=Math.max(0,now-station.lastAt);
  station.lastAt=now;
  const t=instant?1:Math.min(1,Math.max(0,(now-station.bornAt)/.85));
  if(t===1&&station.settled)return 1;
  const eased=t*t*(3-2*t);
  station.root.position.y=(1-eased)*.18;
  station.root.scale.set(.96+.04*eased,.94+.06*eased,.96+.04*eased);
  const opacity=Math.min(1,t/.35);
  station.root.traverse(object=>{
    if(!(object instanceof Mesh))return;
    const materials=Array.isArray(object.material)?object.material:[object.material];
    for(const material of materials){
      if(material.transparent!==(opacity<1)){material.transparent=opacity<1;material.needsUpdate=true;}
      material.opacity=opacity;
    }
    object.castShadow=opacity>.5;
  });
  if(t===1)station.settled=true;
  return t;
}
export function floorExtension(memberCount:number):Group {
  const group=new Group();group.name='studio_floor_extension';
  const minX=memberCount>13?Math.min(...Array.from({length:memberCount-13},(_,index)=>deskSeat(index+12).x))-1.1:-9.15;
  const edge=Math.min(-9.15,minX);
  const wall=new MeshStandardMaterial({color:'#aca69a',roughness:.98});
  const wood=new MeshStandardMaterial({color:'#8f6441',roughness:.82});
  const plank=new MeshStandardMaterial({color:'#a8794c',roughness:.8});
  if(memberCount>=12){
    const width=5.8-edge;
    const apron=new Mesh(new BoxGeometry(width,.25,.7),wood);
    apron.position.set((edge+5.8)/2,-.13,5);apron.receiveShadow=true;group.add(apron);
    for(const z of [4.85,5.2]){
      const board=new Mesh(new BoxGeometry(width,.015,.343),plank);
      board.position.set((edge+5.8)/2,.005,z);board.receiveShadow=true;group.add(board);
    }
  }
  if(edge< -9.2){
    const width=-9.2-edge;
    const base=new Mesh(new BoxGeometry(width, .25,10),wood);
    base.position.set((edge-9.2)/2,-.13,-.35);base.receiveShadow=true;group.add(base);
    for(let row=0;row<25;row++){
      const board=new Mesh(new BoxGeometry(width,.015,.393),plank);
      board.position.set((edge-9.2)/2,.005,4.45-row*.4);board.receiveShadow=true;group.add(board);
    }
    const linen=new MeshStandardMaterial({color:'#6e8b88',roughness:.98});
    for(let band=0;band*8+4<=memberCount-13;band++){
      const rug=new Mesh(new BoxGeometry(3.0,.014,3.15),linen);
      rug.position.set(-11.08-band*3.25,.021,-1.21);rug.receiveShadow=true;group.add(rug);
    }
    const back=new Mesh(new BoxGeometry(width,3,.16),wall);
    back.position.set((edge-9.2)/2,1.5,-5.27);back.castShadow=true;group.add(back);
    const glass=new MeshStandardMaterial({color:'#89a4a8',roughness:.44,metalness:.05});
    const frame=new MeshStandardMaterial({color:'#8f633d',roughness:.75});
    for(let x=edge+.95;x< -9.65;x+=1.72){
      const window=new Mesh(new BoxGeometry(1.52,1.43,.03),glass);
      window.position.set(x,1.82,-5.17);group.add(window);
      for(const side of [-.76,.76]){
        const jamb=new Mesh(new BoxGeometry(.055,1.57,.12),frame);
        jamb.position.set(x+side,1.82,-5.08);group.add(jamb);
      }
      for(const height of [1.07,2.59]){
        const rail=new Mesh(new BoxGeometry(1.58,.06,.12),frame);
        rail.position.set(x,height,-5.08);group.add(rail);
      }
      const mullion=new Mesh(new BoxGeometry(.035,1.48,.08),frame);
      mullion.position.set(x,1.82,-5.05);group.add(mullion);
    }
  }
  const left=new Mesh(new BoxGeometry(.15,2.95,2.65),wall);
  left.position.set(edge,1.47,-3.9);left.castShadow=true;group.add(left);
  group.updateMatrixWorld(true);group.traverse(object=>{object.matrixAutoUpdate=false;});
  return group;
}
