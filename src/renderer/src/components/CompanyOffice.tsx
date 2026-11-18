import type { AppSnapshot, MemberView } from '../../../shared/views';
import { PersonPortrait } from '../studio/Person';
import { departmentState, officeLabel } from '../lib/officePeople';
import { Progress } from '../lib/ui';
import { OfficeScene } from './OfficeScene';
import { OfficeViewport } from './OfficeViewport';

function Staff({member,snapshot,openMember}:{member:MemberView;snapshot:AppSnapshot;openMember:(id:string)=>void}) {
  const label=officeLabel(member,snapshot,snapshot.stop?.global?.active);
  return <button className={`company-staff ${member.isMain?'main-agent-banner':''}`} data-company-member={member.id} data-active={label.active} onClick={()=>openMember(member.id)} aria-label={`${member.name} 팀원 상세 열기`}>
    <PersonPortrait member={member} className="company-portrait" />
    <span className="company-staff-copy"><strong>{label.name} <small>{label.role}</small></strong><span className="company-ai">{label.ai}</span><span className="company-work">{label.work}</span></span>
  </button>;
}

export function CompanyOffice({snapshot,openProject,openMember,officeSuspended}:{snapshot:AppSnapshot;openProject:(id:string)=>void;openMember:(id:string)=>void;officeSuspended?:boolean}) {
  const main=snapshot.members.find(member=>member.isMain&&!member.deleted);
  const holder=snapshot.seat.holder;
  return <section className="company-office" aria-label="회사 사무실">
    <section className="company-live-office" aria-labelledby="company-office-title">
      <div className="scene-heading"><h2 id="company-office-title">회사 사무실</h2><p>일이 없어도 언제든 들러 보세요. 이름이나 인물을 가리키거나 누르면 업무 정보가 열립니다.</p></div>
      <p className="office-quiet">{holder ? `${holder.label} · ${holder.kind === 'external' ? '외부 에이전트' : '서버 실행'} · 메인 자리${snapshot.seat.state === 'stopped' ? ' · 정지 중' : ''}` : '메인 자리가 비어 있습니다. 사무실은 언제든 볼 수 있습니다.'}</p>
      <OfficeViewport label="메인 사무실" suspended={officeSuspended}><OfficeScene members={holder && main ? [main] : []} desksForMembersOnly seat={snapshot.seat} emergency={snapshot.stop.global.active} onMember={openMember} /></OfficeViewport>
      <p className="office-quiet">메인 에이전트가 머무는 공간입니다. 부서 직원들은 아래의 각 부서 사무실에서 만날 수 있습니다.</p>
    </section>
    <div className="company-heading"><div><span className="eyebrow">우리 회사</span><h2>부서와 직원</h2></div><span>{snapshot.projects.length}개 부서</span></div>
    <div className="company-main"><div className="company-main-heading"><strong>메인 에이전트</strong><span>{holder ? `${holder.label} · ${holder.kind==='external'?'외부 에이전트':'서버 실행'}${snapshot.seat.state==='stopped'?' · 정지 중':''}` : '메인 자리 비어 있음'}</span></div>{main ? <Staff member={main} snapshot={snapshot} openMember={openMember} /> : <p className="office-quiet">등록된 메인 에이전트가 없습니다.</p>}</div>
    {snapshot.stop?.global?.active&&<p className="company-stop" role="status">긴급 정지 중입니다. 새 실행을 멈췄습니다. 종료 확인 결과는 상단의 긴급 정지 안내에서 확인하세요.</p>}
    {snapshot.projects.length>1&&<nav className="department-jumps" aria-label="부서 바로가기">{snapshot.projects.map(project=><a key={project.id} href={`#department-${project.id}`}>{project.name}</a>)}</nav>}
    <div className="department-list">{snapshot.projects.map(project=>{
      const department=departmentState(snapshot,project);
      return <section className="department" data-department={project.id} id={`department-${project.id}`} key={project.id} aria-label={`${project.name} 부서`}>
        <header className="department-heading"><div><span className="eyebrow">부서{project.mock.enabled?' · 모의 실행':''}</span><h3><button className="project-card department-entry" onClick={()=>openProject(project.id)} aria-label={`${project.name} 사무실 열기`}><span className="project-card-top"><strong>{project.name}</strong></span><small>사무실 보기 →</small></button></h3></div><div className="department-count"><strong>{department.active}명 업무 중 / {department.members.length}명</strong></div></header>
        <p className="department-state">{department.text}{department.members.length===1&&department.members[0].isProducer?' 프로듀서 한 명이 있는 부서입니다.':''}</p>
        <p className="muted project-path">{project.path}</p>
        <div className="department-progress" role="group" aria-label={`${project.name} 부서 진행도`}><Progress value={project.progress} /></div>
        <div className="department-directives" role="group" aria-label={`${project.name} 진행 중 지시`}>
          {department.directives.map(directive=><div className="department-directive" key={directive.id}><span>{directive.title}</span><Progress value={directive.progress} /><small>{directive.progress.done}/{directive.progress.total}단계</small></div>)}
          {!department.directives.length&&<span>진행 중인 지시 없음</span>}
        </div>
        <div className="department-staff">{department.members.map(member=><Staff key={member.id} member={member} snapshot={snapshot} openMember={openMember} />)}</div>
        {!department.members.length&&<p className="office-quiet">아직 등록된 직원이 없습니다.</p>}
      </section>;
    })}</div>
    {!snapshot.projects.length&&<p className="office-quiet">아직 부서가 없습니다. 회사 사무실에서 쉬어 가세요.</p>}
  </section>;
}
