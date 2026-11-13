import { expect, it,vi } from 'vitest';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { snapshot as seed } from '../api/fake/data';
import { Office } from '../studio/Office';
import { officeLabel, departmentState } from '../lib/officePeople';
import { placeDetailCard, placeNameTag, tagsOverlap } from '../studio3d/tags';
import { CompanyOffice } from './CompanyOffice';
import { officeDepartmentSnapshot,mainReplyFixture,OFFICE_STATES } from '../api/fake/departments';
import { ServerNotice } from './ServerNotice';
import { subscribeConversation,openConversation } from '../lib/commands';
import { browserNotificationContent,browserReplyTarget } from '../lib/browserNotifications';
import { noticePresentation } from '../lib/notice';
import { Studio } from '../screens/Studio';
vi.mock('../api/runtime',()=>({runtime:()=>({web:true,server:true,desktop:false})}));

it('keeps only the name always visible and carries role AI and work in detail data', () => {
  const snapshot=structuredClone(seed);
  const member=snapshot.members.find(member=>!member.isMain)!;
  member.status='working';
  member.currentTask={id:'T-OFFICE',title:'검색 화면 완성',state:'in_progress',currentStep:'검색 조건 연결',inReview:false,branch:null,progress:{done:1,total:3,ratio:1/3}};
  member.ai={...member.ai,kind:'codex',modelValue:'gpt-5.4',effortTier:'high',effortValue:'high',mock:true};
  const label=officeLabel(member,snapshot);
  expect(label.ai).toContain('Codex · gpt-5.4');
  expect(label.ai).toContain('높게 (high) · 모의');
  expect(label.role).toBe(member.roleName);
  expect(label.work).toContain('검색 화면 완성 · 검색 조건 연결');
  expect(label.active).toBe(true);
  const html=renderToStaticMarkup(createElement(Office,{members:[member],tasks:snapshot.tasks,directives:snapshot.directives,onMember:()=>undefined}));
  const plate=html.slice(html.indexOf('class="office-person-label"'));
  expect(plate).toContain(member.name);
  for(const text of [member.roleName,label.ai,label.work])expect(plate).not.toContain(text);
  expect(plate).not.toContain('staff-tether');

});

it('says nobody is working in an idle department without a directive', () => {
  const snapshot=structuredClone(seed),project=snapshot.projects[0];
  snapshot.directives=[];
  snapshot.members.filter(member=>member.projectId===project.id).forEach(member=>{member.status='idle';member.currentTask=null;member.currentWork=null;});
  expect(departmentState(snapshot,project).text).toBe('진행 중인 지시가 없어 지금 일하는 직원이 없습니다.');
  expect(departmentState(snapshot,project).active).toBe(0);
});

it('does not invent activity when working details are absent',()=>{
  const member=structuredClone(seed.members[0]);member.status='working';member.currentTask=null;member.currentWork=null;member.statusReasons=[];
  expect(officeLabel(member,seed).work).toBe('업무 중 · 현재 업무 내용이 전달되지 않았습니다.');
});

it('keeps name-only tags inside both viewports without overlap and away from the board',()=>{
  for(const width of [1200,362]){
    const height=width===362?440:610;
    const heads=Array.from({length:12},(_,i)=>({x:width===362?42+(i%6)*55:100+(i%6)*195,y:width===362?210+Math.floor(i/6)*70:250+Math.floor(i/6)*240,radius:8}));
    const board={x:width*.33,y:55,width:width*.24,height:80};
    const protectedAreas=[board,...heads.map(head=>({x:head.x-8,y:head.y-9,width:16,height:18}))];
    const names:NonNullable<ReturnType<typeof placeNameTag>>[]=[];
    for(const head of heads){const name=placeNameTag(head,{width:46,height:20},{width,height},names,protectedAreas);
      expect(name).toBeDefined();if(name){expect(name.x).toBeGreaterThanOrEqual(0);expect(name.x+name.width).toBeLessThanOrEqual(width);expect(tagsOverlap(name,board)).toBe(false);for(const previous of names)expect(tagsOverlap(name,previous)).toBe(false);names.push(name);}}
  }
});

it('nudges colliding edge names and protects whiteboard writing',()=>{
  const viewport={width:362,height:440},head={x:4,y:200,radius:8},heads=[{x:0,y:192,width:12,height:18}];
  const first=placeNameTag(head,{width:46,height:20},viewport,[],heads);expect(first).toBeDefined();
  if(first){expect(first.x).toBe(4);expect(first.y).toBeCloseTo(head.y-head.radius*1.15-20-4);const second=placeNameTag(head,{width:46,height:20},viewport,[first],heads);expect(second).toBeDefined();if(second)expect(tagsOverlap(first,second)).toBe(false);}
  const board={x:120,y:55,width:90,height:45};
  const name=placeNameTag({x:165,y:122,radius:8},{width:46,height:20},viewport,[],[board]);expect(name).toBeDefined();if(name)expect(tagsOverlap(name,board)).toBe(false);
});

it('keeps the directory directly below the office with every member role AI task and step',()=>{
  const snapshot=officeDepartmentSnapshot(seed,'busy'),project=snapshot.projects[0];
  const html=renderToStaticMarkup(createElement(Studio,{snapshot,project,back:()=>undefined,openMember:()=>undefined,openTask:()=>undefined,openDirective:()=>undefined,openReport:()=>undefined}));
  const rows=html.match(/<button class="member-card"[\s\S]*?<\/button>/g)??[];
  const members=snapshot.members.filter(member=>member.projectId===project.id);
  expect(rows).toHaveLength(members.length);
  for(const member of members){const row=rows.find(row=>row.includes(`data-directory-member="${member.id}"`));expect(row).toBeDefined();const label=officeLabel(member,snapshot);for(const fact of [label.name,label.role,label.ai,label.work])expect(row).toContain(fact);}
  expect(html).toMatch(/<\/section><section[^>]*><div[^>]*><h2>팀원 디렉터리/);
});

it('places an on-demand card inside the scene without covering its name head or whiteboard',()=>{
  for(const width of [1200,362]){
    const name={x:width/2-25,y:190,width:50,height:20},head={x:width/2-12,y:218,width:24,height:30};
    for(const board of [{x:width*.33,y:60,width:width*.24,height:75},{x:0,y:252,width,height:180}])for(const low of [false,true]){
      const ownName=low?{...name,y:372}:name,ownHead=low?{...head,y:400}:head;
      const card=placeDetailCard({width:288,height:170},{x:0,y:0,width,height:440},ownName,ownHead,[board]);
      expect(card).toBeDefined();if(card){expect(card.x).toBeGreaterThanOrEqual(0);expect(card.x+card.width).toBeLessThanOrEqual(width);expect(card.y+card.height).toBeLessThanOrEqual(440);for(const area of [ownName,ownHead,board])expect(tagsOverlap(card,area)).toBe(false);}
    }
  }
});

it('lists every company project and live member exactly once including a producer-only department',()=>{
  for(const snapshot of [seed,officeDepartmentSnapshot(seed,'producer'),officeDepartmentSnapshot(seed,'six')]){
    const html=renderToStaticMarkup(createElement(CompanyOffice,{snapshot,openProject:()=>undefined,openMember:()=>undefined}));
    expect(html.match(/data-department=/g)).toHaveLength(snapshot.projects.length);
    for(const project of snapshot.projects)expect(html.split(`data-department="${project.id}"`).length-1).toBe(1);
    const members=snapshot.members.filter(member=>!member.deleted);
    expect(html.match(/data-company-member=/g)).toHaveLength(members.length);
    for(const member of members)expect(html.split(`data-company-member="${member.id}"`).length-1).toBe(1);
    if(snapshot.projects.length===6)expect(members).toHaveLength(73);
  }
});

it('renders truthful quiet, paused, emergency, review and owner-waiting states',()=>{
  const busy=officeDepartmentSnapshot(seed,'busy');
  const stopped=renderToStaticMarkup(createElement(Office,{members:busy.members.filter(member=>!member.isMain),tasks:busy.tasks,directives:busy.directives,emergency:true,onMember:()=>undefined}));
  expect(stopped).toContain('0명 업무 중 / 12명');
  for(const mode of OFFICE_STATES){
    const snapshot=officeDepartmentSnapshot(seed,mode);
    const html=renderToStaticMarkup(createElement(CompanyOffice,{snapshot,openProject:()=>undefined,openMember:()=>undefined}));
    if(mode==='producer'){expect(html).toContain('프로듀서 한 명이 있는 부서입니다.');expect(departmentState(snapshot,snapshot.projects[0]).members).toHaveLength(1);}
    if(mode==='idle'||mode==='producer')expect(html).toContain('진행 중인 지시가 없어 지금 일하는 직원이 없습니다.');
    if(mode==='paused')expect(html).toContain('부서가 일시정지 중입니다.');
    if(mode==='emergency')expect(html).toContain('긴급 정지 중입니다.');
    if(mode==='busy'||mode==='six')for(const state of ['검수 중','대표 답변 대기','일시정지','작업 막힘'])expect(html).toContain(state);
    const working=snapshot.stop.global.active?0:snapshot.members.filter(member=>!member.isMain&&member.status==='working').length;
    expect(working).toBe(mode==='busy'?8:mode==='six'?48:0);
  }
});

function actionButtons(node:ReactNode):Array<{onClick?:()=>void}> {
  if(Array.isArray(node))return node.flatMap(actionButtons);
  if(!isValidElement<{children?:ReactNode;onClick?:()=>void}>(node))return [];
  return [...(node.type==='button'?[node.props]:[]),...actionButtons(node.props.children)];
}
it('opens the exact direct or project conversation from main-reply bell actions and browser destinations',()=>{
  for(const target of [null,seed.projects[0].id]){
    const {notice}=mainReplyFixture(target,seed.generatedAt);
    const opened:string[]=[];const off=subscribeConversation(target=>opened.push(target));
    const pages:unknown[]=[];
    const element=ServerNotice({item:notice,snapshot:seed,navigate:target=>pages.push(target),markRead:()=>{throw new Error('Must see the answer before marking it read');},close:()=>undefined});
    const html=renderToStaticMarkup(element);
    expect(html).toContain(notice.body);expect(html).toContain('답변 대화 열기');expect(html).not.toContain('notice-line');
    actionButtons(element)[0].onClick?.();
    expect(opened).toEqual([target??'main']);expect(pages).toEqual([]);
    expect(noticePresentation(notice,seed)).toMatchObject({title:notice.title,command:null});
    const content=browserNotificationContent(notice);
    expect(content.body).toBe(notice.body);expect(content.title).toBe(notice.title);expect(browserReplyTarget(content.link)).toBe(target??'main');
    off();
  }
});

it('retains a cold notification conversation until the composer subscribes',async()=>{
  const targets:string[]=[];
  const observer=subscribeConversation(()=>undefined,false);
  openConversation('P-COLD');
  const off=subscribeConversation(target=>targets.push(target));
  await Promise.resolve();
  expect(targets).toEqual(['P-COLD']);off();observer();
});
