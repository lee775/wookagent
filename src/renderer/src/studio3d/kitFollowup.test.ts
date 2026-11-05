// @ts-expect-error Renderer web compilation intentionally omits Node types.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnimationMixer, Box3, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { garments } from './characterKit';
async function load(name:string){const raw=readFileSync(`src/renderer/public/studio3d/${name}.glb`);
  return new GLTFLoader().parseAsync(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),'');}
const colours=[[.25,.36,.29],[.79,.69,.54],[.45,.57,.39]];
function hemIndices(body:SkinnedMesh,height:number){
  const geometry=body.geometry;
  const position=geometry.getAttribute('position'),color=geometry.getAttribute('color'),indices=new Set<number>();
  const joints=geometry.getAttribute('skinIndex'),weights=geometry.getAttribute('skinWeight');
  for(let i=0;i<position.count;i++){
    const originalY=.92+(position.getY(i)-.92)/height;
    if(Math.abs(position.getX(i))>.28||originalY<.74||originalY>1.105)continue;
    // Bent sleeves can enter this rest-space box. Only pelvis/torso cloth is a hem.
    if([0,1,2,3].some(axis=>weights.getComponent(i,axis)>.0001&&
      !['hips','spine'].includes(body.skeleton.bones[joints.getComponent(i,axis)].name)))continue;
    if(colours.some(rgb=>Math.hypot(color.getX(i)-rgb[0],color.getY(i)-rgb[1],color.getZ(i)-rgb[2])<.025))indices.add(i);
  }
  return indices;
}
function hemMeasure(body:SkinnedMesh,indices:Set<number>){
  const points=new Map([...indices].map(i=>[i,body.getVertexPosition(i,new Vector3())]));
  const bounds=new Box3().setFromPoints([...points.values()]);let shelfArea=0;
  const geometry=body.geometry,index=geometry.index,count=index?.count??geometry.getAttribute('position').count;
  for(let i=0;i<count;i+=3){const a=points.get(index?index.getX(i):i),b=points.get(index?index.getX(i+1):i+1),c=points.get(index?index.getX(i+2):i+2);
    if(!a||!b||!c)continue;
    const normal=b.clone().sub(a).cross(c.clone().sub(a));
    if(Math.abs(normal.clone().normalize().y)>.8)shelfArea+=normal.length()/2;
  }
  return {depth:bounds.max.z-bounds.min.z,shelfArea};
}
describe('Kit follow-up: fitted headphones and seated cloth',()=>{
  it('fits all twelve headphone/hair pairs below the hair top, with safe cup-only fallbacks',async()=>{
    const kit=await load('appearance_kit');kit.scene.updateMatrixWorld(true);
    for(let hair=0;hair<12;hair++){
      const style=kit.scene.getObjectByName(`hair_${hair}`)!,headphones=kit.scene.getObjectByName(`headphones_${hair}`)!;
      expect(headphones,`hair ${hair}`).toBeDefined();
      expect(headphones.userData.headphone_mode).toBe([1,3,5,10,11].includes(hair)?'cups':'band');
      const hairBox=new Box3().setFromObject(style),bandBox=new Box3().setFromObject(headphones);
      expect(bandBox.max.y,`hair ${hair}`).toBeLessThanOrEqual(hairBox.max.y+.001);
      // Mutation: restoring the old 1.91 m pointed apex breaks the low-crown fit.
      if(hair===0)expect(1.91).toBeGreaterThan(hairBox.max.y+.001);
    }
  });
  it.each([...garments,'producer'])('keeps %s hems fitted through every sampled seated pose',async name=>{
    const gltf=await load(`kit_${name}`),bodies:SkinnedMesh[]=[];
    gltf.scene.traverse(object=>{if(object instanceof SkinnedMesh)bodies.push(object);});
    const body=bodies[0],height=Number(gltf.scene.getObjectByName('Rig')?.userData.kit_height),hem=hemIndices(body,height);
    expect(hem.size).toBeGreaterThan(40);
    const mixer=new AnimationMixer(gltf.scene);
    for(const clip of ['sit_type','sofa_talk','sit_lean_back','sit_think']){
      mixer.stopAllAction();mixer.clipAction(gltf.animations.find(action=>action.name===clip)!).play();
      for(let frame=0;frame<33;frame++){
        mixer.setTime(frame/25);gltf.scene.updateMatrixWorld(true);
        const measure=hemMeasure(body,hem);
        // Includes the front seam's lean around a long coat; the old sweater
        // cylinder alone was 0.477 m deep before any lean.
        expect(measure.depth,`${name} ${clip} ${frame}`).toBeLessThan(.46);
        expect(measure.shelfArea,`${name} ${clip} ${frame}`).toBeLessThan(.025);
      }
    }
    // The runtime's idle meeting seats use sit_think.
    if(name==='sweater'){
      // Mutation: the old capped circular hem is 0.45*hip deep and has a >0.16 m² shelf.
      expect(.45*1.06).toBeGreaterThan(.46);expect(Math.PI*(.225*1.06)**2).toBeGreaterThan(.025);
    }
  });
});
