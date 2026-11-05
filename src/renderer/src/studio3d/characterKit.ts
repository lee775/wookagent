import { Bone, BufferAttribute, BufferGeometry, Float32BufferAttribute, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MemberView } from '../../../shared/views';

export const garments=['cardigan','hoodie','shirt','vest','blazer','fleece','tee_long','sweater'] as const;
export type CharacterMember=Pick<MemberView,'id'|'roleId'|'isProducer'>;
type RGB=readonly [number,number,number];
const source:Record<string,RGB>={
  skin:[.58,.34,.22],hair:[.055,.048,.043],top:[.25,.36,.29],inner:[.79,.69,.54],
  pants:[.16,.22,.25],shoe:[.09,.085,.077],accent:[.45,.57,.39],
  eye:[.045,.047,.045],white:[.89,.80,.69],metal:[.40,.44,.41],
};
const skins:RGB[]=[
  [.58,.34,.22],[.37,.20,.13],[.76,.52,.40],[.69,.46,.33],
  [.87,.62,.47],[.49,.29,.20],[.78,.55,.42],[.42,.25,.18],
];
const hairs:RGB[]=[
  [.055,.048,.043],[.22,.10,.07],[.08,.06,.05],[.36,.20,.10],
  [.11,.07,.05],[.04,.045,.055],[.30,.24,.15],[.15,.07,.05],
];
const tops:RGB[]=[
  [.25,.36,.29],[.15,.27,.35],[.40,.56,.58],[.23,.40,.34],
  [.48,.33,.30],[.50,.51,.37],[.23,.30,.44],[.57,.43,.27],
  [.32,.45,.48],[.57,.32,.21],[.33,.39,.27],[.37,.44,.55],
];
const accents:RGB[]=[
  [.45,.57,.39],[.80,.65,.41],[.54,.28,.22],[.68,.36,.24],
  [.78,.55,.25],[.42,.60,.54],[.62,.42,.31],[.40,.59,.49],
  [.74,.42,.23],[.56,.63,.44],[.64,.48,.32],[.72,.41,.33],
];
const pants:RGB[]=[ [.16,.22,.25],[.37,.35,.31],[.19,.22,.26],[.31,.28,.25] ];
const hash=(value:string)=>[...value].reduce((n,c)=>(Math.imul(n,33)+c.charCodeAt(0))>>>0,2166136261);
export interface GeneratedLook {
  hair:number;garment:string;family:number;skin:number;hairColour:number;build:number;height:number;
  glasses:boolean;beard:boolean;headphones:boolean;lanyard:boolean;
}
const assigned=new Map<string,GeneratedLook>();
const lookSeedKey='studio3d.look-seeds.v1';
function readLookSeeds():Map<string,number> {
  try {
    const saved:unknown=JSON.parse(localStorage.getItem(lookSeedKey)??'[]');
    if(!Array.isArray(saved))return new Map();
    return new Map(saved.filter((entry):entry is [string,number]=>Array.isArray(entry)&&entry.length===2&&
      typeof entry[0]==='string'&&Number.isSafeInteger(entry[1])&&entry[1]>=0&&entry[1]<1152));
  }catch{return new Map();}
}
const lookSeeds=readLookSeeds();
function seedFor(id:string):number {
  const numeric=/^M-(\d+)$/.exec(id);
  return numeric?(Number(numeric[1])*137+29)>>>0:hash(id);
}
function lookFrom(member:CharacterMember,bump=0):GeneratedLook {
  const n=seedFor(member.id)+bump*173;
  const hair=n%12,family=Math.floor(n/96)%12;
  const garment=member.isProducer?'producer':garments[Math.floor(n/12)%garments.length];
  const cue=hash(`${member.id}:${member.roleId}`);
  return {hair,garment,family,skin:(cue>>>5)%skins.length,hairColour:(cue>>>10)%hairs.length,
    build:((cue>>>15)%9-4)/100,height:((cue>>>20)%9-4)/100,
    glasses:member.roleId==='architect'||member.roleId==='qa'||(cue&7)===0,
    beard:!member.isProducer&&(cue&15)===3,
    headphones:member.roleId==='developer'||member.roleId==='ui_designer'||(cue&15)===5,
    lanyard:member.isProducer||member.roleId==='planner'||(cue&7)===2};
}
export function looksForMembers(members:readonly CharacterMember[]):Map<string,GeneratedLook> {
  const used=new Set<string>(),result=new Map<string,GeneratedLook>();
  let changed=false;
  const reserved=(id:string)=>assigned.has(id)||lookSeeds.has(id);
  for(const member of [...members].sort((a,b)=>Number(reserved(b.id))-Number(reserved(a.id))||a.id.localeCompare(b.id))){
    let bump=lookSeeds.get(member.id)??0,attempt=0,look=assigned.get(member.id)??lookFrom(member,bump);
    let key=`${look.hair}:${look.garment}:${look.family}`;
    while(used.has(key)&&attempt++<1152){bump=(bump+1)%1152;look=lookFrom(member,bump);key=`${look.hair}:${look.garment}:${look.family}`;}
    used.add(key);result.set(member.id,look);assigned.set(member.id,look);
    if(lookSeeds.get(member.id)!==bump){lookSeeds.set(member.id,bump);changed=true;}
  }
  if(changed)try{localStorage.setItem(lookSeedKey,JSON.stringify([...lookSeeds]));}catch{/* Storage can be disabled; the session reservations still work. */}
  return result;
}
export function lookForMember(member:CharacterMember):GeneratedLook {
  return assigned.get(member.id)??lookFrom(member,lookSeeds.get(member.id)??0);
}

const loader=new GLTFLoader();
let kitPromise:Promise<{garments:Map<string,GLTF>;appearance:GLTF}>|null=null;
export function loadCharacterKit():Promise<{garments:Map<string,GLTF>;appearance:GLTF}> {
  if(!kitPromise)kitPromise=(async()=>{
    const names=[...garments,'producer'];
    const loaded=await Promise.all([...names.map(name=>loader.loadAsync(`./studio3d/kit_${name}.glb`)),
      loader.loadAsync('./studio3d/appearance_kit.glb')]);
    return {garments:new Map(names.map((name,index)=>[name,loaded[index]])),appearance:loaded.at(-1)!};
  })();
  return kitPromise;
}
function bone(root:Group,name:string):Object3D|undefined {
  let found:Object3D|undefined;
  root.traverse(object=>{
    if(!found&&object instanceof SkinnedMesh)found=object.skeleton.getBoneByName(name)??
      object.skeleton.getBoneByName(name.replaceAll('.','_'))??undefined;
  });
  return found;
}
function nearestSource(r:number,g:number,b:number):string {
  let best='skin',distance=Infinity;
  for(const [key,swatch] of Object.entries(source)){
    const d=(r-swatch[0])**2+(g-swatch[1])**2+(b-swatch[2])**2;
    if(d<distance){best=key;distance=d;}
  }
  return best;
}
function recolour(root:Group,look:GeneratedLook):void {
  const palette:Record<string,RGB>={
    ...source,skin:skins[look.skin],hair:hairs[look.hairColour],top:tops[look.family],
    inner:[.79,.69,.54],pants:pants[look.family%pants.length],accent:accents[look.family],
  };
  root.traverse(object=>{
    if(!(object instanceof SkinnedMesh))return;
    object.geometry=object.geometry.clone();
    const attribute=object.geometry.getAttribute('color');
    if(!attribute)return;
    const color=attribute.clone();
    for(let index=0;index<color.count;index++){
      const key=nearestSource(color.getX(index),color.getY(index),color.getZ(index));
      const rgb=palette[key];color.setXYZ(index,rgb[0],rgb[1],rgb[2]);
    }
    object.geometry.setAttribute('color',color);
  });
}
function attachModule(root:Group,kit:GLTF,name:string,parentBone:string,colour?:RGB):void {
  const target=bone(root,parentBone),sourceObject=kit.scene.getObjectByName(name);
  if(!target||!sourceObject)return;
  const object=sourceObject.clone(true);
  const profile=root.getObjectByName('Rig')?.userData??{};
  const height=Number(profile.kit_height??1);
  if(parentBone==='head'){
    const face=name.startsWith('hair_')||name.startsWith('headphones')||name==='beard'?Number(profile.kit_face_height??1):1;
    object.scale.set(Number(profile.kit_face_width??1),height*face,1);
    object.position.y=height*(.12-1.65*face);
  }else{
    object.scale.y=height;object.position.y=-1.05*height;
  }
  if(colour)object.traverse(part=>{
    if(!(part instanceof Mesh))return;
    const original=Array.isArray(part.material)?part.material[0]:part.material;
    if(!(original instanceof MeshStandardMaterial))return;
    const material=original.clone();
    material.color.setRGB(...colour);part.material=material;
  });
  target.add(object);
}
function mergeAppearance(root:Group):void {
  let body:SkinnedMesh|undefined;
  const attachments:Mesh[]=[];
  root.traverse(object=>{
    if(object instanceof SkinnedMesh)body=object;
    else if(object instanceof Mesh)attachments.push(object);
  });
  if(!body)return;
  root.updateMatrixWorld(true);
  const inverse=new Matrix4().copy(body.matrixWorld).invert();
  const base=body.geometry.index?body.geometry.toNonIndexed():body.geometry.clone();
  const indices=base.getAttribute('skinIndex');
  base.setAttribute('skinIndex',new Uint16BufferAttribute(Array.from({length:indices.count*4},(_,i)=>indices.array[i]),4));
  for(const attribute of Object.keys(base.attributes))if(!['position','normal','color','skinIndex','skinWeight'].includes(attribute))base.deleteAttribute(attribute);
  const parts:BufferGeometry[]=[base];
  for(const mesh of attachments){
    let parent:Object3D|null=mesh.parent;
    while(parent&&!(parent instanceof Bone))parent=parent.parent;
    if(!(parent instanceof Bone))continue;
    const joint=body.skeleton.bones.indexOf(parent);if(joint<0)continue;
    const geometry=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();
    geometry.applyMatrix4(new Matrix4().multiplyMatrices(inverse,mesh.matrixWorld));
    for(const attribute of Object.keys(geometry.attributes))if(attribute!=='position'&&attribute!=='normal')geometry.deleteAttribute(attribute);
    const count=geometry.getAttribute('position').count;
    const colors=new Float32Array(count*3),skinIndices=new Uint16Array(count*4),weights=new Float32Array(count*4);
    const material=Array.isArray(mesh.material)?mesh.material[0]:mesh.material;
    if(!(material instanceof MeshStandardMaterial))continue;
    for(let i=0;i<count;i++){
      colors.set([material.color.r,material.color.g,material.color.b],i*3);
      skinIndices[i*4]=joint;weights[i*4]=1;
    }
    geometry.setAttribute('color',new Float32BufferAttribute(colors,3));
    geometry.setAttribute('skinIndex',new Uint16BufferAttribute(skinIndices,4));
    geometry.setAttribute('skinWeight',new Float32BufferAttribute(weights,4));
    geometry.morphTargetsRelative=base.morphTargetsRelative;
    for(const name of ['position','normal','color'] as const){
      const targets=base.morphAttributes[name];
      if(targets)geometry.morphAttributes[name]=targets.map(target=>new Float32BufferAttribute(new Float32Array(count*target.itemSize),target.itemSize));
    }
    parts.push(geometry);
  }
  const merged=mergeGeometries(parts);
  if(!merged)throw new Error('Cannot merge generated character');
  merged.morphTargetsRelative=base.morphTargetsRelative;
  body.geometry=merged;
  for(const mesh of attachments)mesh.removeFromParent();
  for(const part of parts)part.dispose();
}
export function assembleCharacter(member:CharacterMember,kit:{garments:Map<string,GLTF>;appearance:GLTF},look=lookForMember(member)):{
  root:Group;animations:GLTF['animations'];look:GeneratedLook
} {
  const template=kit.garments.get(look.garment)!;
  const root=cloneSkeleton(template.scene);
  if(!(root instanceof Group))throw new Error('Character kit root is not a group');
  recolour(root,look);
  attachModule(root,kit.appearance,`hair_${look.hair}`,'head',hairs[look.hairColour]);
  if(look.glasses)attachModule(root,kit.appearance,'glasses','head');
  if(look.beard)attachModule(root,kit.appearance,'beard','head',hairs[look.hairColour]);
  if(look.headphones){
    const name=kit.appearance.scene.getObjectByName(`headphones_${look.hair}`)?`headphones_${look.hair}`:'headphones';
    attachModule(root,kit.appearance,name,'head',accents[look.family]);
  }
  if(look.lanyard)attachModule(root,kit.appearance,'lanyard','spine');
  mergeAppearance(root);
  const spine=bone(root,'spine');if(spine)spine.scale.set(1+look.build,1+look.height,1+look.build);
  return {root,animations:template.animations,look};
}
