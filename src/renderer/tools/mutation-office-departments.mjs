// Extension of mutation-check.mjs. Run with the 5196 dev server stopped.
// Sources are restored in finally, and only the server started here is stopped.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'vite';
const vt='C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh';
const root='src/renderer/src/';
const tests='src/renderer/tools/vitest.config.ts';
const cases=[
  {bug:'office model omitted',file:'lib/officePeople.ts',from:"${member.ai.modelValue ?? '기본 모델'}",to:'모델 숨김',test:'keeps only the name'},
  {bug:'office task title omitted',file:'lib/officePeople.ts',from:'${task.title}${task.currentStep ?',to:"${''}${task.currentStep ?",test:'keeps only the name'},
  {bug:'idle department unexplained',file:'lib/officePeople.ts',from:'진행 중인 지시가 없어 지금 일하는 직원이 없습니다.',to:'부서 대기 중',test:'says nobody is working'},
  {bug:'missing work details replaced with invented activity',file:'lib/officePeople.ts',from:'현재 업무 내용이 전달되지 않았습니다.',to:'다음 작업을 검토하고 있습니다.',test:'does not invent activity'},
  {bug:'company drops a project',file:'components/CompanyOffice.tsx',from:'<div className="department-list">{snapshot.projects.map',to:'<div className="department-list">{snapshot.projects.slice(1).map',test:'lists every company project'},
  {bug:'company drops a member',file:'components/CompanyOffice.tsx',from:'department.members.map(member=>',to:'department.members.slice(1).map(member=>',test:'lists every company project'},
  {bug:'company duplicates its members',file:'components/CompanyOffice.tsx',from:'department.members.map(member=>',to:'department.members.flatMap(member=>[member,member]).map(member=>',test:'lists every company project'},
  {bug:'project answer opens direct conversation',file:'lib/notice.ts',from:"(item.link?.tab==='projects'?item.link.projectId:undefined) ?? 'main'",to:"'main'",test:'opens the exact direct or project'},
  {bug:'browser hides main answer body',file:'lib/browserNotifications.ts',from:'{title:item.title,body:item.body,link:',to:'{title:item.title,body:NOTIFICATION_BODY,link:',test:'opens the exact direct or project'},
  {bug:'unread conversation mark removed',file:'components/CommandBar.tsx',from:'notifications.filter(item=>!item.read',to:'notifications.filter(item=>item.read',test:'Office-reply-unread',hook:true},
  {bug:'bell mark-all erases an unseen conversation answer',file:'components/CommandBar.tsx',from:'[...pendingReplies,...arrivingReplies]',to:'[...arrivingReplies]',test:'Office-reply-unread',hook:true},
  {bug:'browser reply worker opens a page instead',file:'lib/browserNotifications.ts',from:'if(reply!==undefined){openConversation(reply);return;}',to:"if(reply!==undefined){navigate({tab:'projects'});return;}",test:'Office-reply-browser',hook:true},
  {bug:'cold notification target lost',file:'lib/commands.ts',from:'if(conversationListeners.has(listener))listener(target);',to:"if(conversationListeners.has(listener))listener('main');",test:'retains a cold notification'},
  {bug:'Home imports the heavy 3D office',file:'components/CompanyOffice.tsx',from:'  const main=snapshot.members.find',to:"  void import('../studio3d/Studio3D');\n  const main=snapshot.members.find",browser:true,home:true,evidence:'Home loaded heavy 3D assets'},
  {bug:'answer conversation opens at the oldest visible message',file:'components/CommandBar.tsx',from:'conversation.current.scrollTop=conversation.current.scrollHeight;',to:'conversation.current.scrollTop=0;',browser:true,replies:true,evidence:'Conversation did not open at newest message'},
  {bug:'fixture events cannot find a department member',file:'api/fake/index.ts',from:'(officeState||officeDemoQuery?previewSnapshot():snapshot).members.find((value) => value.id === id && !value.deleted)',to:'snapshot.members.find((value) => value.id === id && !value.deleted)',browser:true,twoD:true,members:true,evidence:'Fixture member panel could not read'},
  {bug:'fixture diff cannot find the current task',file:'api/fake/index.ts',from:'(officeState||officeDemoQuery?previewSnapshot():snapshot).tasks.find((value) => value.id === id)',to:'snapshot.tasks.find((value) => value.id === id)',browser:true,twoD:true,members:true,evidence:'Fixture member panel could not read'},
  {bug:'2D floating paragraph returned',file:'components/OfficeLabel.tsx',from:'return <strong className="staff-name">{label.name}</strong>;',to:'return <><strong className="staff-name">{label.name}</strong><span>{label.work}</span></>;',test:'keeps only the name'},
  {bug:'floating AI text returned',file:'studio/OfficeLabelController.ts',from:'if(name)name.textContent=item.label.name;',to:'if(name)name.textContent=`${item.label.name} ${item.label.ai}`;',browser:true,evidence:'Always-visible office label contains more than the name'},
  {bug:'on-demand AI omitted',file:'studio/OfficeLabelController.ts',from:'this.ai.textContent=item.label.ai;',to:"this.ai.textContent='';",browser:true,evidence:'On-demand card lost role AI or current work'},
  {bug:'on-demand work omitted',file:'studio/OfficeLabelController.ts',from:'this.work.textContent=item.label.work;',to:"this.work.textContent='';",browser:true,evidence:'On-demand card lost role AI or current work'},
  {bug:'on-demand role omitted',file:'studio/OfficeLabelController.ts',from:'${item.label.name} · ${item.label.role}',to:'${item.label.name}',browser:true,evidence:'On-demand card lost role AI or current work'},
  {bug:'2D first tap opens the member panel',file:'studio/Office.tsx',from:'aria-label={`${member.name} 업무 보기`}',to:'onClick={() => onMember(member.id)} aria-label={`${member.name} 업무 보기`}',browser:true,twoD:true,phone:true,evidence:'Office name opened member panel before details were requested'},
  {bug:'Escape does not close card',file:'studio/OfficeLabelController.ts',from:"event.key==='Escape'&&this.activeId",to:"event.key==='UnboundEscape'&&this.activeId",browser:true,evidence:'Escape did not close office card'},
  {bug:'hover leave does not close card',file:'studio/OfficeLabelController.ts',from:'this.closeTimer=setTimeout(()=>this.close(),160)',to:'this.closeTimer=setTimeout(()=>undefined,160)',browser:true,evidence:'Office hover card stayed after leaving'},
  {bug:'blur does not close card',file:'studio/OfficeLabelController.ts',from:"listen('blur',event=>{if(event instanceof FocusEvent&&!contains(this.card,event.relatedTarget))this.scheduleClose();});",to:"listen('blur',()=>undefined);",browser:true,evidence:'Blur did not close office card'},
  {bug:'outside touch does not close card',file:'studio/OfficeLabelController.ts',from:'if(this.activeId&&!contains(this.card,event.target)&&!this.isActiveControl(event.target))this.close();',to:'if(false)this.close();',browser:true,phone:true,evidence:'Tap elsewhere did not close office card'},
  {bug:'keyboard focus does not open card',file:'studio/OfficeLabelController.ts',from:"listen('focus',()=>{if(!this.restoringFocus)this.open(id,'focus');});",to:"listen('focus',()=>undefined);",browser:true,evidence:'Requested office detail card did not open'},
  {bug:'member detail action removed',file:'studio/OfficeLabelController.ts',from:'if(id)this.onMember(id);',to:'if(id)void id;',browser:true,evidence:'Office detail control did not open member panel'},
  {bug:'multiple office cards open',file:'studio/OfficeLabelController.ts',from:"this.card.hidden=false;this.buttons.get(id)?.setAttribute",to:"this.card.hidden=false;this.scene.appendChild(this.card.cloneNode(true));this.buttons.get(id)?.setAttribute",browser:true,evidence:'Requested office detail card did not open'},
  {bug:'keyboard cannot enter card',file:'studio/OfficeLabelController.ts',from:"event.key==='Tab'&&!event.shiftKey",to:"event.key==='UnboundTab'&&!event.shiftKey",browser:true,evidence:'Keyboard cannot reach member details'},
  {bug:'directory work omitted',file:'screens/Studio.tsx',from:'<p className="member-line">{label.work}</p>',to:'<p className="member-line">{label.state}</p>',test:'keeps the directory'},
  {bug:'directory AI omitted',file:'screens/Studio.tsx',from:'<p className="member-ai">{label.ai}</p>',to:'<p className="member-ai">{label.role}</p>',test:'keeps the directory'},
  {bug:'stopped office still counts people as working',file:'studio/Office.tsx',from:'visible.filter(member => officeLabel(member,{tasks,directives},emergency).active).length',to:"visible.filter(member => member.status === 'working').length",test:'renders truthful quiet'},
  {bug:'name bounds ignored',file:'studio3d/tags.ts',from:'if(tagFits(candidate,placed)&&tagFits(candidate,protectedAreas))return candidate;',to:'return {x:head.x-width/2,y,width,height};',test:'nudges colliding edge names'},
  {bug:'name floats far above the head',file:'studio3d/tags.ts',from:'const y=head.y-head.radius*1.15-height-4;',to:'const y=head.y-head.radius*1.15-height-70;',test:'nudges colliding edge names'},
  {bug:'name collisions ignored',file:'studio3d/tags.ts',from:'if(tagFits(candidate,placed)&&tagFits(candidate,protectedAreas))return candidate;',to:'if(tagFits(candidate,protectedAreas))return candidate;',test:'nudges colliding edge names'},
  {bug:'whiteboard covered by name',file:'studio3d/tags.ts',from:'if(tagFits(candidate,placed)&&tagFits(candidate,protectedAreas))return candidate;',to:'if(tagFits(candidate,placed))return candidate;',test:'nudges colliding edge names'},
  {bug:'card covers own head or name',file:'studio3d/tags.ts',from:'firstFittingTag(candidates,[],[name,head,...protectedAreas])',to:'candidates[0]',test:'places an on-demand card'},
  {bug:'card covers whiteboard writing',file:'studio3d/tags.ts',from:'[name,head,...protectedAreas]',to:'[name,head]',test:'places an on-demand card'},
];
const results=[];
let server;
function runBrowser(args){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',error=>resolve({status:null,stdout,stderr,error}));
    child.once('close',status=>resolve({status,stdout,stderr}));
  });
}
async function check(item){
  const file=root+item.file,original=readFileSync(file,'utf8');
  assert.equal(original.split(item.from).length,2,`Mutation anchor must be unique: ${item.bug}`);
  try{
    writeFileSync(file,original.replace(item.from,item.to),'utf8');
    const args=item.browser?['src/renderer/tools/check-office-departments.mjs','--smoke',...(item.home?['--home']:[]),...(item.replies?['--replies']:[]),...(item.twoD?['--2d']:[]),...(item.members?['--members']:[]),...(item.phone?['--phone']:[])]:
      [vt,'run','--config',tests,`src/renderer/src/components/${item.hook?'web-stage8':'office-departments'}.test.ts`,'--testNamePattern',item.test];
    const run=item.browser?await runBrowser(args):spawnSync('bash',args,{encoding:'utf8',timeout:1200000,maxBuffer:3_000_000,windowsHide:true});
    const output=`${run.stdout??''}\n${run.stderr??''}`;
    const caught=run.status!==0&&output.includes(item.browser?item.evidence:'AssertionError');
    results.push({bug:item.bug,caught,exit:run.status,evidence:output.split(/\r?\n/).find(line=>line.includes(item.browser?item.evidence:'AssertionError'))??String(run.error??'')});
    console.log(`${item.bug}: ${caught?'caught':'MISSED'}`);
    if(!caught)console.log(output.slice(-1800));
  }finally{writeFileSync(file,original,'utf8');}
}
try{
  for(const item of cases.filter(item=>!item.browser))await check(item);
  server=await createServer({configFile:'vite.web.config.ts',server:{host:'127.0.0.1',port:5196,strictPort:true}});
  await server.listen();
  for(const item of cases.filter(item=>item.browser))await check(item);
}finally{
  if(server)await server.close();
  writeFileSync('docs/design/permission-ui/office-departments/mutation-results.json',JSON.stringify(results,null,2)+'\n','utf8');
}
assert.ok(results.length===cases.length&&results.every(item=>item.caught),'A required office mutant survived');
process.exit(0);
