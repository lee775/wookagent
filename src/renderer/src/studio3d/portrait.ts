import { AmbientLight, AnimationMixer, Color, DirectionalLight, Group, OrthographicCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import type { AnimationClip } from 'three';
import { assembleCharacter, loadCharacterKit, lookForMember, type CharacterMember } from './characterKit';

const cache=new Map<string,Promise<string>>();
async function draw(root:Group,animations:AnimationClip[],size:number,standing=false):Promise<string> {
    const canvas=document.createElement('canvas');
    const renderer=new WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});
    try {
      renderer.setPixelRatio(1);renderer.setSize(size,standing?size*1.25:size,false);renderer.outputColorSpace=SRGBColorSpace;
      renderer.setClearColor(new Color('#ffffff'),0);
      const scene=new Scene();scene.add(root);
      scene.add(new AmbientLight('#fff4df',1.7));
      const light=new DirectionalLight('#ffffff',2.5);light.position.set(2,5,4);scene.add(light);
      const camera=new OrthographicCamera(standing?-.896:-.4,standing?.896:.4,standing?1.12:.48,standing?-1.12:-.48,.1,10);
      camera.position.set(.4,standing?1.15:1.65,3);camera.lookAt(0,standing?.98:1.43,0);
      const idle=animations.find(clip=>clip.name==='stand_idle');
      if(idle){const mixer=new AnimationMixer(root);mixer.clipAction(idle).play();mixer.update(.18);}
      renderer.render(scene,camera);
      return canvas.toDataURL('image/png');
    } finally {renderer.dispose();renderer.forceContextLoss();}
}

export async function renderGeneratedStanding(member:CharacterMember,size=384):Promise<string> {
  const generated=assembleCharacter(member,await loadCharacterKit());
  return draw(generated.root,generated.animations,size,true);
}

export function renderGeneratedPortrait(member:CharacterMember,size:number):Promise<string> {
  if(size<32||size>1024)return Promise.reject(new Error('Invalid studio portrait request'));
  const key=`${member.id}:${JSON.stringify(lookForMember(member))}:${size}`;
  const existing=cache.get(key);if(existing)return existing;
  const requested=loadCharacterKit().then(kit=>{
    const generated=assembleCharacter(member,kit);
    return draw(generated.root,generated.animations,size);
  });
  cache.set(key,requested);requested.catch(()=>cache.delete(key));
  return requested;
}

// Preserve the numeric portrait API for callers that still hold an asset number.
export function renderMemberPortrait(asset:number,size:number):Promise<string> {
  if(!Number.isInteger(asset)||asset<1||asset>13)return Promise.reject(new Error('Invalid studio portrait request'));
  return renderGeneratedPortrait({id:`M-${String(asset).padStart(4,'0')}`,roleId:'developer',
    isProducer:asset===13},size);
}
