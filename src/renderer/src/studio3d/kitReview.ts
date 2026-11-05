/** Explicit kit matrix entry point for the local 2x asset review, imported only by its probe. */
import { AmbientLight, AnimationMixer, Color, DirectionalLight, Mesh, OrthographicCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import { assembleCharacter, garments, loadCharacterKit, lookForMember } from './characterKit';

export const seatedReviewPoses=[
  {name:'sit_type',clip:'sit_type',x:2.1,z:3.5},
  {name:'sofa_talk',clip:'sofa_talk',x:3.2,z:2.5},
  {name:'sit_lean_back',clip:'sit_lean_back',x:2.5,z:3.2},
  {name:'meeting',clip:'sit_think',x:-2.8,z:3.1},
] as const;
let renderer:WebGLRenderer|null=null;
export async function renderSeatedReview(garment:string,hair:number,headphones:boolean,pose:number):Promise<string>{
  if(![...garments,'producer'].includes(garment)||!Number.isInteger(hair)||hair<0||hair>11||!seatedReviewPoses[pose])
    throw new Error('Invalid kit review cell');
  renderer??=new WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
  renderer.setSize(384,440,false);renderer.setPixelRatio(1);renderer.outputColorSpace=SRGBColorSpace;
  renderer.setClearColor(new Color('#e9e4d6'),1);
  const member={id:'kit-review',roleId:'developer',isProducer:garment==='producer'};
  const generated=assembleCharacter(member,await loadCharacterKit(),{...lookForMember(member),garment,hair,headphones,
    glasses:false,beard:false,lanyard:false,build:0,height:0,family:2,hairColour:0});
  const scene=new Scene();scene.add(generated.root);scene.add(new AmbientLight('#fff4df',1.7));
  const light=new DirectionalLight('#ffffff',2.5);light.position.set(2,5,4);scene.add(light);
  const selected=seatedReviewPoses[pose],mixer=new AnimationMixer(generated.root);
  const clip=generated.animations.find(action=>action.name===selected.clip);
  if(!clip)throw new Error('Missing review clip');
  mixer.clipAction(clip).play();mixer.update(.55);
  const camera=new OrthographicCamera(-.83,.83,.95,-.95,.1,20);
  camera.position.set(selected.x,1.65,selected.z);camera.lookAt(0,.73,.16);
  renderer.render(scene,camera);const image=renderer.domElement.toDataURL('image/png');
  mixer.stopAllAction();mixer.uncacheRoot(generated.root);
  generated.root.traverse(object=>{if(object instanceof Mesh)object.geometry.dispose();});
  return image;
}
export function disposeSeatedReview():void {renderer?.dispose();renderer?.forceContextLoss();renderer=null;}
