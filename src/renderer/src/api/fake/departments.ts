import type { AppSnapshot, ConversationView, NotificationView, ProjectView, TaskView } from '../../../../shared/views';
import { demoName } from './names';

export const OFFICE_STATES=['no-project','empty-seat','producer','busy','idle','idle2','idle6','paused','emergency','six'] as const;
export function officeDepartmentSnapshot(base:AppSnapshot,mode:string|null):AppSnapshot {
  if(!OFFICE_STATES.some(state=>state===mode))return base;
  const view=structuredClone(base);
  const templateProject=base.projects[0],templateTask=base.tasks[0],templateDirective=base.directives[0];
  const people=base.members.filter(member=>member.projectId==='P-0003'&&!member.deleted).slice(0,12);
  const main=base.members.find(member=>member.isMain);
  view.projects=[];view.tasks=[];view.directives=[];view.members=main?[structuredClone(main)]:[];
  view.ownerTodos=[];view.recentActivity=[];
  view.auth.loggedIn=true;
  view.stop={global:{active:mode==='emergency',since:mode==='emergency'?view.generatedAt:null},pausedMembers:[],pausedProjects:[],lastEmergency:null,heldByEmergency:0};
  if(mode==='no-project'||mode==='empty-seat'||mode?.startsWith('idle')){
    for(const member of view.members){member.status='idle';member.currentTask=null;member.currentWork=null;member.lastLine=null;member.queuedCount=0;member.statusReasons=['진행 중인 지시가 없습니다.'];}
  }
  if(mode==='empty-seat')view.seat={...view.seat,state:'vacant',holder:null,pendingHolder:null,since:null};
  const names=['서비스 개발','운영 지원','콘텐츠 제작','디자인','품질 관리','자료 조사'];
  for(let index=0;index<(mode==='no-project'||mode==='empty-seat'?0:mode==='six'?6:1);index++){
    const id=`P-${8001+index}`,directiveId=`D-${8001+index}`;
    const quiet=mode?.startsWith('idle')||mode==='producer';
    const paused=mode==='paused'||mode==='emergency';
    const project:ProjectView={...structuredClone(templateProject),id,name:names[index],producerId:`M-${8001+index*12}`,paused:mode==='paused',pauseMode:mode==='paused'?'immediate':null,activeDirectiveCount:quiet?0:1,latestReport:null};
    project.progress={done:quiet?0:3,total:quiet?0:12,ratio:quiet?0:.25};
    project.memberStatusCounts={working:0,idle:0,awaiting_answer:0,paused:0,error:0};
    view.projects.push(project);
    const team=people.slice(0,mode==='producer'?1:mode==='idle2'?2:mode==='idle6'?6:12).map((source,rank)=>{
      const member=structuredClone(source);
      member.id=`M-${8001+index*12+rank}`;member.projectId=id;
      member.name=demoName(1+index*12+rank);
      member.isProducer=rank===0;member.isMain=false;member.deleted=false;
      if(rank===0){member.roleId='producer';member.roleName='프로듀서';}
      member.ai={...member.ai,modelValue:member.ai.kind==='codex'?'gpt-6-sol':'sonnet',mock:true};
      member.status=quiet?'idle':paused?'paused':rank===2?'idle':rank===3?'awaiting_answer':rank===4?'paused':rank===5?'error':'working';
      member.statusReasons=[quiet?'진행 중인 지시가 없습니다.':paused?(mode==='emergency'?'긴급 정지로 실행을 멈췄습니다.':'부서가 일시정지 중입니다.'):rank===2?'검수 결과를 기다리고 있습니다.':rank===3?'배포 환경에 대한 대표의 답변을 기다리고 있습니다.':rank===4?'다른 업무를 먼저 마치도록 일시정지했습니다.':rank===5?'자료에 접근할 수 없어 확인이 필요합니다.':'검색 화면을 만들고 있습니다.'];
      member.queuedCount=0;member.currentTask=null;member.currentWork=null;member.lastLine=null;member.currentSessionId=null;member.pendingAiChange=null;
      if(!quiet){
        if(rank===0&&!paused){member.currentWork={kind:'plan',label:'작업 순서와 담당자를 조율합니다.',turnId:`TN-${member.id}`,startedAt:view.generatedAt};}
        if(rank>0){
          const title=rank===2?'검색 결과 정리':rank===3?'배포 환경 확인':rank===5?'참고 자료 확인':`${member.roleName} 검색 화면 개선`;
          const state:TaskView['state']=paused||['awaiting_answer','paused','error'].includes(member.status)?'on_hold':rank===2?'in_review':'in_progress';
          const task={...structuredClone(templateTask),id:`T-${8001+index*12+rank}`,directiveId,projectId:id,title,assigneeId:member.id,reviewerId:teamReviewer(index),state,prerequisiteIds:[]};
          task.progress={done:1,total:4,ratio:.25};
          task.steps=task.steps.map((step,i)=>({...step,title:i===1?'검색 조건 연결':step.title,done:i===0}));
          view.tasks.push(task);
          member.currentTask={id:task.id,title,state,progress:task.progress,currentStep:'검색 조건 연결',inReview:rank===2,branch:null};
          if(member.status==='working')member.currentWork={kind:'task_work',label:title,turnId:`TN-${member.id}`,startedAt:view.generatedAt};
        }
      }
      project.memberStatusCounts[member.status]++;
      return member;
    });
    view.members.push(...team);
    if(!quiet)view.directives.push({...structuredClone(templateDirective),id:directiveId,projectId:id,title:'검색 화면을 만들고 확인하기',state:'in_progress',progress:project.progress,taskIds:view.tasks.filter(task=>task.projectId===id).map(task=>task.id),latestReportId:null});
    if(mode==='paused')view.stop.pausedProjects.push({projectId:id,mode:'immediate',since:view.generatedAt,reason:'부서 일정 조정'});
  }
  if(mode==='emergency'&&view.members[0]?.isMain){view.members[0].status='paused';view.members[0].currentWork=null;view.members[0].statusReasons=['긴급 정지 중입니다.'];view.seat.state='stopped';}
  const active=view.members.filter(member=>member.status==='working').length;
  view.running={...view.running,total:active,cap:Math.max(active,5),generalCap:Math.max(active-1,4),management:view.members.filter(member=>member.status==='working'&&(member.isMain||member.isProducer)).length,general:view.members.filter(member=>member.status==='working'&&!member.isMain&&!member.isProducer).length,queued:0};
  return view;
}
const teamReviewer=(index:number)=>`M-${8001+index*12}`;

export function mainReplyFixture(target:string|null,stamp:string):{notice:NotificationView;message:ConversationView} {
  const direct=target===null;
  const answer=direct?'전체 부서의 업무를 확인했습니다. 대표의 확인이 필요한 항목은 답변 대기 직원에게 표시해 두었습니다.':'검색 화면의 기본 흐름을 연결했습니다. 검색 조건을 바꿔 결과가 갱신되는지 확인하고 있습니다.';
  return {notice:{id:`N-OFFICE-${direct?'DIRECT':'PROJECT'}`,key:`main-reply:TN-OFFICE-${direct?'DIRECT':'PROJECT'}`,title:`메인 에이전트의 답${direct?'':' — 서비스 개발'}`,body:answer,level:'normal',link:{tab:'projects',...(target?{projectId:target}:{})},read:false,createdAt:stamp},
    message:{id:`C-OFFICE-${direct?'DIRECT':'PROJECT'}`,role:'main_agent',text:answer,attachments:[],directiveId:null,createdAt:stamp}};
}

export function mainReplyHistory(stamp:string):ConversationView[] {
  return Array.from({length:70},(_,index)=>({id:`C-OFFICE-OLDER-${index}`,role:index%2?'main_agent':'owner',text:`${index+1}번째 업무 확인 기록입니다. 부서의 작업 범위와 확인할 내용을 정리했습니다.`,attachments:[],directiveId:null,createdAt:new Date(Date.parse(stamp)-(70-index)*60000).toISOString()}));
}
