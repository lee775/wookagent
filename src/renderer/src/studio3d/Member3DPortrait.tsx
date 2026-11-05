import { useEffect, useState } from 'react';
import type { MemberView } from '../../../shared/views';
import { PersonPortrait } from '../studio/Person';

interface Props { member:MemberView; className?:string; size?:number }

export function Member3DPortrait({member,className,size=256}:Props) {
  const [image,setImage]=useState<string|null>(null);
  useEffect(()=>{
    let live=true;
    import('./portrait').then(module=>module.renderGeneratedPortrait(member,size))
      .then(url=>{if(live)setImage(url);}).catch(()=>{if(live)setImage(null);});
    return()=>{live=false;};
  },[member.id,member.roleId,member.isProducer,size]);
  if(!image)return <PersonPortrait member={member} className={className} />;
  return <img src={image} alt="" className={className} style={{objectFit:'contain'}} />;
}
