import type { officeLabel } from '../lib/officePeople';
import { placeDetailCard, placeNameTag, type TagRectangle } from '../studio3d/tags';

export type OfficePersonLabel = ReturnType<typeof officeLabel>;
export interface OfficeLabelAnchor {
  id:string;
  label:OfficePersonLabel;
  head:{x:number;y:number;radius:number};
  headArea:TagRectangle;
  bodyArea:TagRectangle;
}
let visibleController:OfficeLabelController|null=null;
let cardSequence=0;
const contains=(element:Element|null,target:EventTarget|null)=>target instanceof Node&&!!element?.contains(target);

/** Shared DOM adapter for SVG and WebGL. One name per person and one requested detail card. */
export class OfficeLabelController {
  private readonly card:HTMLDivElement;
  private readonly title:HTMLElement;
  private readonly ai:HTMLElement;
  private readonly work:HTMLElement;
  private readonly details:HTMLButtonElement;
  private readonly bindings=new Map<Element,Array<()=>void>>();
  private readonly anchors=new Map<string,OfficeLabelAnchor>();
  private readonly names=new Map<string,TagRectangle>();
  private protectedAreas:readonly TagRectangle[]=[];
  private activeId:string|null=null;
  private mode:'hover'|'focus'|'touch'='hover';
  private closeTimer:ReturnType<typeof setTimeout>|undefined;
  private pointerType='mouse';
  private restoringFocus=false;

  constructor(private readonly scene:HTMLElement,private readonly buttons:Map<string,HTMLButtonElement>,
    private readonly onMember:(id:string)=>void) {
    this.card=document.createElement('div');this.card.className='office-detail-card';this.card.hidden=true;
    this.card.id=`office-person-details-${++cardSequence}`;this.card.setAttribute('role','group');
    const header=document.createElement('div');header.className='office-detail-heading';
    this.title=document.createElement('strong');
    const close=document.createElement('button');close.type='button';close.className='office-detail-close';
    close.textContent='×';close.setAttribute('aria-label','업무 정보 닫기');close.addEventListener('click',()=>this.close(true));
    header.append(this.title,close);
    this.ai=document.createElement('p');this.ai.className='office-detail-ai';
    this.work=document.createElement('p');this.work.className='office-detail-work';
    this.details=document.createElement('button');this.details.type='button';this.details.className='office-detail-open';this.details.textContent='자세히 보기 →';
    this.details.addEventListener('click',()=>{const id=this.activeId;this.close();if(id)this.onMember(id);});
    this.card.append(header,this.ai,this.work,this.details);this.scene.appendChild(this.card);
    this.card.addEventListener('pointerenter',()=>this.cancelClose());
    this.card.addEventListener('pointerleave',event=>{if(this.mode==='hover'&&!this.isActiveControl(event.relatedTarget))this.scheduleClose();});
    this.card.addEventListener('focusout',event=>{if(!contains(this.card,event.relatedTarget)&&!this.isActiveControl(event.relatedTarget))this.scheduleClose();});
    document.addEventListener('pointerdown',this.outside,true);document.addEventListener('keydown',this.escape);
  }

  private outside=(event:PointerEvent)=>{
    this.pointerType=event.pointerType;
    if(this.activeId&&!contains(this.card,event.target)&&!this.isActiveControl(event.target))this.close();
  };
  private escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&this.activeId){event.preventDefault();event.stopPropagation();this.close(true);}};
  private isActiveControl(target:EventTarget|null) {
    return this.activeId!==null&&(contains(this.buttons.get(this.activeId)??null,target)||
      [...this.bindings.keys()].some(element=>element.getAttribute('data-member-id')===this.activeId&&contains(element,target)));
  }
  private cancelClose(){if(this.closeTimer!==undefined){clearTimeout(this.closeTimer);this.closeTimer=undefined;}}
  private scheduleClose(){this.cancelClose();this.closeTimer=setTimeout(()=>this.close(),160);}

  bind(element:HTMLElement|SVGElement,id:string) {
    if(this.bindings.has(element))return;
    const removers:Array<()=>void>=[];
    const listen=(name:string,listener:EventListener)=>{
      element.addEventListener(name,listener);removers.push(()=>element.removeEventListener(name,listener));
    };
    listen('pointerenter',event=>{if(event instanceof PointerEvent&&event.pointerType!=='touch')this.open(id,'hover');});
    listen('pointerleave',event=>{if(event instanceof PointerEvent&&this.mode==='hover'&&!contains(this.card,event.relatedTarget))this.scheduleClose();});
    listen('focus',()=>{if(!this.restoringFocus)this.open(id,'focus');});
    listen('blur',event=>{if(event instanceof FocusEvent&&!contains(this.card,event.relatedTarget))this.scheduleClose();});
    if(element instanceof HTMLButtonElement)listen('click',()=>{
      if(this.pointerType==='touch'&&this.activeId===id&&this.mode==='touch')this.close();
      else this.open(id,this.pointerType==='touch'?'touch':'focus');
    });
    listen('keydown',event=>{if(event instanceof KeyboardEvent&&event.key==='Tab'&&!event.shiftKey&&this.activeId===id&&!this.card.hidden){event.preventDefault();this.card.querySelector<HTMLButtonElement>('button')?.focus();}});
    this.bindings.set(element,removers);
  }

  showPerson(id:string,pointerType=this.pointerType){this.open(id,pointerType==='touch'?'touch':'hover');}
  hoverAt(x:number,y:number) {
    if(this.mode==='focus'&&this.activeId)return;
    const hit=[...this.anchors.values()].filter(item=>x>=item.bodyArea.x&&x<=item.bodyArea.x+item.bodyArea.width&&y>=item.bodyArea.y&&y<=item.bodyArea.y+item.bodyArea.height)
      .sort((a,b)=>Math.hypot(x-a.head.x,y-a.head.y)-Math.hypot(x-b.head.x,y-b.head.y))[0];
    if(hit)this.open(hit.id,'hover');else if(this.mode==='hover')this.scheduleClose();
  }
  leave(target:EventTarget|null){if(this.mode==='hover'&&!contains(this.card,target)&&!this.isActiveControl(target))this.scheduleClose();}

  update(anchors:readonly OfficeLabelAnchor[],protectedAreas:readonly TagRectangle[]) {
    this.scene.dataset.officeBoard=JSON.stringify(protectedAreas);
    this.anchors.clear();this.names.clear();this.protectedAreas=protectedAreas;
    const viewport={width:this.scene.clientWidth,height:this.scene.clientHeight};
    const heads=anchors.map(item=>item.headArea);
    const priority=(item:OfficeLabelAnchor)=>item.label.state==='대표 답변 대기'||item.label.state==='작업 막힘'?0:item.label.active?1:2;
    const sorted=[...anchors].sort((a,b)=>priority(a)-priority(b)||a.id.localeCompare(b.id));
    for(const item of sorted){
      this.anchors.set(item.id,item);
      const button=this.buttons.get(item.id);if(!button)continue;
      this.bind(button,item.id);button.dataset.active=String(item.label.active);
      button.style.left='0px';button.style.top='0px';
      button.setAttribute('aria-label',`${item.label.name} 업무 보기`);button.setAttribute('aria-controls',this.card.id);
      button.setAttribute('aria-expanded',String(this.activeId===item.id));
      const name=button.querySelector('strong');if(name)name.textContent=item.label.name;
      const rectangle=placeNameTag(item.head,{width:button.offsetWidth,height:button.offsetHeight},viewport,[...this.names.values()],[...heads,...protectedAreas]);
      if(rectangle){this.names.set(item.id,rectangle);button.style.transform=`translate3d(${rectangle.x}px,${rectangle.y}px,0)`;}
    }
    if(this.activeId&&!this.anchors.has(this.activeId))this.close();
    else if(this.activeId)this.positionCard();
    for(const [element,removers]of this.bindings)if(!element.isConnected){removers.forEach(remove=>remove());this.bindings.delete(element);}
  }

  private open(id:string,mode:'hover'|'focus'|'touch') {
    const item=this.anchors.get(id);if(!item)return;
    this.cancelClose();if(visibleController&&visibleController!==this)visibleController.close();visibleController=this;
    if(this.activeId!==id){this.buttons.get(this.activeId??'')?.setAttribute('aria-expanded','false');}
    this.activeId=id;this.mode=mode;
    this.title.textContent=`${item.label.name} · ${item.label.role}`;this.ai.textContent=item.label.ai;this.work.textContent=item.label.work;
    this.card.setAttribute('aria-label',`${item.label.name} 업무 정보`);
    this.details.setAttribute('aria-label',`${item.label.name} 팀원 상세 열기`);
    this.card.hidden=false;this.buttons.get(id)?.setAttribute('aria-expanded','true');this.positionCard();
  }
  private positionCard() {
    const item=this.anchors.get(this.activeId??''),name=this.names.get(this.activeId??'');if(!item||!name)return;
    const root=this.scene.getBoundingClientRect(),main=this.scene.closest('.main-content')?.getBoundingClientRect();
    const top=Math.max(0,(main?.top??0)-root.top),bottom=Math.min(this.scene.clientHeight,(main?.bottom??window.innerHeight)-root.top);
    const bounds={x:0,y:top,width:this.scene.clientWidth,height:Math.max(0,bottom-top)};
    this.card.hidden=false;
    this.card.style.width=`${Math.min(bounds.width<500?bounds.width-12:288,bounds.width-12)}px`;this.card.style.maxHeight='none';
    const rectangle=placeDetailCard({width:this.card.offsetWidth,height:this.card.scrollHeight},bounds,name,item.headArea,this.protectedAreas);
    if(!rectangle){this.card.hidden=true;return;}
    this.card.hidden=false;this.card.style.transform=`translate3d(${rectangle.x}px,${rectangle.y}px,0)`;this.card.style.maxHeight=`${rectangle.height}px`;
  }
  close(restoreFocus=false) {
    const id=this.activeId;this.cancelClose();this.activeId=null;this.card.hidden=true;
    if(id)this.buttons.get(id)?.setAttribute('aria-expanded','false');
    if(visibleController===this)visibleController=null;
    if(restoreFocus&&id){this.restoringFocus=true;this.buttons.get(id)?.focus({preventScroll:true});this.restoringFocus=false;}
  }
  dispose(){this.close();document.removeEventListener('pointerdown',this.outside,true);document.removeEventListener('keydown',this.escape);for(const removers of this.bindings.values())removers.forEach(remove=>remove());this.bindings.clear();this.card.remove();}
}
