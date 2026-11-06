import { runtime } from '../api/runtime';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ActivityMarker } from '../components/ActivityMarker';
import { ArrowLeft, ChevronRight, Settings2 } from 'lucide-react';
import type { AppSnapshot, ProjectView } from '../../../shared/views';
import type { Settings } from '../../../shared/domain';
import { AI_KIND_LABEL, DIRECTIVE_STATE_LABEL, EFFORT_TIER_LABEL, PRIORITY_LABEL, TASK_STATE_LABEL } from '../../../shared/labels';
import { call } from '../api/store';
import { date, Progress, Section, StatusBadge } from '../lib/ui';
import { openCommand } from '../lib/commands';
import { ProjectSettings } from '../components/ProjectSettings';
import { Office } from '../studio/Office';
import { PersonPortrait } from '../studio/Person';
import { resolveDisplayText, resolveWorkLabel } from '../lib/displayText';

const Studio3D = lazy(async () => ({ default: (await import('../studio3d/Studio3D')).Studio3D }));
let webgl2Available: boolean | null = null;
const useStudio3D = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined' ||
      new URLSearchParams(window.location.search).get('studio3d') === '0') return false;
  if (runtime().web && window.matchMedia?.('(max-width: 760px)').matches) return false;
  if (webgl2Available === null) {
    const context = document.createElement('canvas').getContext('webgl2');
    webgl2Available = !!context;
    context?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return webgl2Available;
};

interface StudioProps {
  snapshot: AppSnapshot;
  project: ProjectView;
  back: () => void;
  openMember: (id: string) => void;
  openTask: (id: string) => void;
  openDirective: (id: string) => void;
  openReport: (id: string) => void;
}

export function Studio({ snapshot, project, back, openMember, openTask, openDirective, openReport }: StudioProps) {
  const [projectSettings, setProjectSettings] = useState(false);
  const [effortMapping, setEffortMapping] = useState<Settings['team']['effortMapping'] | null>(null);
  useEffect(() => { void call('settings.get').then(value => setEffortMapping(value.team.effortMapping)).catch(() => undefined); }, []);
  const members = snapshot.members.filter((member) => member.projectId === project.id && !member.deleted);
  const directives = snapshot.directives.filter((directive) => directive.projectId === project.id);
  const tasks = snapshot.tasks.filter((task) => task.projectId === project.id);
  const activities = snapshot.recentActivity.filter((item) => item.projectId === project.id);

  return (
    <div className="screen studio">
      <button className="back-link" onClick={back}>
        <ArrowLeft size={16} /> 전체 현황
      </button>
      <div className="page-heading studio-heading">
        <div>
          <span className="eyebrow">팀 작업 현황</span>
          <h1>
            {project.name} {project.mock.enabled && <span className="mock-badge">모의 실행</span>}
          </h1>
          <p>
            {project.path} <span className="middot">·</span> 기준 브랜치 {project.baseBranch}
          </p>
        </div>
        <div className="heading-actions">
          <button onClick={() => setProjectSettings(true)}>
            <Settings2 size={16} /> 프로젝트 설정
          </button>
          <button className="primary-button" onClick={() => openCommand(project.id, `${project.name}에 대해: `)}>메인 에이전트에게 말하기</button>
        </div>
      </div>
      <div className="studio-metrics">
        <div>
          <small>진행 중 지시</small>
          <strong>{project.activeDirectiveCount}건</strong>
        </div>
        <div>
          <small>전체 진행도</small>
          <Progress value={project.progress} />
        </div>
        <div>
          <small>팀원</small>
          <strong>{members.length}명</strong>
        </div>
        <div>
          <small>실행 상태</small>
          <strong>{snapshot.stop?.global?.active ? '긴급 정지 중' : project.paused ? '일시정지 중' : '운영 중'}</strong>
        </div>
      </div>
      <div className="studio-main">
        <div>
          <section className="studio-scene-section">
            <div className="scene-heading"><h2>지금 작업실</h2><p>인물을 누르면 작업과 판단 근거를 볼 수 있습니다.</p></div>
            {useStudio3D()
              ? <Suspense fallback={<div className="office-scene" />}><Studio3D key={project.id} members={members} tasks={tasks} directives={directives} activity={activities} emergency={snapshot.stop?.global?.active ?? false} onMember={openMember} /></Suspense>
              : <Office members={members} tasks={tasks} directives={directives} activity={activities} emergency={snapshot.stop?.global?.active ?? false} unread={snapshot.ownerTodos.filter(todo => todo.kind === 'unread_report' && todo.projectId === project.id).length} onMember={openMember} />}
          </section>
          <Section title="팀원 디렉터리" action={<span className="muted">{members.length}명의 작업 좌석</span>}>
            <div className="member-grid">
              {members.map((member) => (
                <button className="member-card" key={member.id} onClick={() => openMember(member.id)}>
                  <div className="member-card-head">
                    <span className="avatar character-avatar"><PersonPortrait member={member} /></span>
                    <div>
                      <strong>{member.name}</strong>
                      <small>{member.roleName}</small>
                    </div>
                    <StatusBadge status={member.status} />
                  </div>
                  <p className="member-ai">
                    {AI_KIND_LABEL[member.ai.kind]} · {member.ai.modelValue ?? '기본 모델'} · {EFFORT_TIER_LABEL[member.ai.effortTier]} ({member.ai.effortValue}){member.ai.mock ? ' · 모의' : ''}
                  </p>
                  {member.aiDecision && <p className="hint">AI 선택: {member.aiDecision.byName} · {member.aiDecision.reason}</p>}
                  {member.pendingAiChange && (
                    <p className="hint">
                      다음 작업부터 적용: {AI_KIND_LABEL[member.pendingAiChange.kind]} · {member.pendingAiChange.model ?? '기본 모델'} ·{' '}
                      {EFFORT_TIER_LABEL[member.pendingAiChange.effortTier]} ({member.pendingAiChange.effortOverride ?? effortMapping?.[member.pendingAiChange.kind][member.pendingAiChange.effortTier] ?? '설정값 확인 중'})
                    </p>
                  )}
                  {(!member.currentTask || !(member.lastLine ?? member.currentWork?.label ?? '').includes(member.currentTask.title)) &&
                    <p className="member-line">{resolveDisplayText(member.lastLine ?? (member.currentWork ? resolveWorkLabel(member.currentWork.label, snapshot) : member.statusReasons[0] ?? '다음 작업을 기다리고 있습니다.'), snapshot)}</p>}
                  {(snapshot.stop?.pausedMembers ?? []).filter(entry => entry.memberId === member.id && entry.by === 'system').map(entry =>
                    <p className="member-line" key={entry.memberId}>자동 일시정지 · {entry.reason ? resolveDisplayText(entry.reason, snapshot) : '시스템이 실행을 멈췄습니다.'}</p>)}
                  {member.currentTask ? (
                    <div className="current-task">
                      <strong>{member.currentTask.title}</strong>
                      <Progress value={member.currentTask.progress} compact />
                      {member.currentTask.inReview && <small>검수 중</small>}
                    </div>
                  ) : null}
                  <small>대기 작업 {member.queuedCount}개</small>
                </button>
              ))}
            </div>
          </Section>
        </div>
        <Section title="활동 타임라인">
          <div className="activity-list activity-compact">
            {activities.length ? (
              activities.map((item) => (
                <div className="activity-row" key={item.seq}>
                  <ActivityMarker item={item} />
                  <div>
                    <strong>{item.memberId === 'M-MAIN' ? '메인 에이전트' : item.actorName}</strong>
                    <p>{item.text}</p>
                    <small>{date(item.ts)}</small>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">최근 기록이 없습니다.</p>
            )}
          </div>
        </Section>
      </div>
      <Section
        title="진행 중 지시"
        action={
          !runtime().web && <button className="muted-button" disabled>
            작업 보드 · 준비 중
          </button>
        }
      >
        <div className="directive-list">
          {directives.map((directive) => (
            <div className="directive-block" key={directive.id}>
              <button className="directive-title" onClick={() => openDirective(directive.id)}>
                <span className="state-chip">{DIRECTIVE_STATE_LABEL[directive.state]}</span>
                <strong>{directive.title}</strong>
                <small>
                  {directive.round}회차
                </small>
                <ChevronRight size={17} />
              </button>
              <Progress value={directive.progress} compact />
              {directive.latestReportId && (
                <button className="text-button" onClick={() => openReport(directive.latestReportId!)}>
                  최근 보고 열기 →
                </button>
              )}
              <div className="task-row-list">
                {tasks
                  .filter((task) => task.directiveId === directive.id)
                  .map((task) => (
                    <button className="task-row" key={task.id} onClick={() => openTask(task.id)}>
                      <span className={`task-state task-${task.state}`}>{TASK_STATE_LABEL[task.state]}</span>
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {snapshot.members.find((member) => member.id === task.assigneeId)?.name ?? '담당 없음'} →{' '}
                          {task.reviewerId === 'M-MAIN'
                            ? '메인 에이전트'
                            : (snapshot.members.find((member) => member.id === task.reviewerId)?.name ?? '검수 미정')}
                        </small>
                      </span>
                      <span className="muted">{PRIORITY_LABEL[task.priority]}</span>
                      <span className="muted">{task.hold?.reasons[0]?.label ?? `단계 ${task.progress.done}/${task.progress.total}`}</span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
      {projectSettings && <ProjectSettings project={project} close={() => setProjectSettings(false)} />}

    </div>
  );
}
