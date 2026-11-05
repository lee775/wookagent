import { readFileSync } from 'node:fs';
import { AnimationMixer, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const bytes=readFileSync('src/renderer/public/studio3d/kit_cardigan.glb');
const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
let body;
gltf.scene.traverse(object=>{if(object instanceof SkinnedMesh)body=object;});
const mixer=new AnimationMixer(gltf.scene);
mixer.clipAction(gltf.animations.find(clip=>clip.name==='walk')).play();
for(const time of [.12,.25,.38,.62,.75,.88]){
  mixer.setTime(time);gltf.scene.updateMatrixWorld(true);
  console.log(time,...['L','R'].map(side=>{
    const bone=body.skeleton.bones.find(bone=>bone.name.replaceAll('.','').replaceAll('_','')===`foot${side}`);
    const p=bone.getWorldPosition(new Vector3());return `${side}: ${p.z.toFixed(4)}`;
  }));
}
