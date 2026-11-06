import { useState } from 'react';
import { AiStatusSummary, hasAiWarning } from '../components/AiStatusSummary';
import { ArrowRight, FolderPlus, CircleHelp, CircleAlert, FileText, RefreshCw, Pause, KeyRound } from 'lucide-react';
import type { AppSnapshot, OwnerTodo } from '../../../shared/views';
import { AI_KIND_LABEL, ACTIVITY_KIND_LABEL, REPORT_STATUS_LABEL } from '../../../shared/labels';
import { call, toast } from '../api/store';
import { date, Progress, Section, StatusBadge } from '../lib/ui';
import { Member3DPortrait } from '../studio3d/Member3DPortrait';
import { openCommand } from '../lib/commands';
import { taskCommand } from '../lib/notice';
import { MainPauseNotice, mainPauseReason } from '../components/MainPauseNotice';
import { resolveDisplayText, resolveWorkLabel } from '../lib/displayText';
import { ActivityMarker } from '../components/ActivityMarker';

type HomeTodo = Extract<OwnerTodo, { kind: 'question' | 'unread_report' | 'error' | 'recovery_check' | 'auth_required' | 'emergency_held' }>;
const todoKinds = new Set(['question', 'unread_report', 'error', 'recovery_check', 'auth_required', 'emergency_held']);
function todoReachesMain(todo: HomeTodo): boolean {
  if ('reachesMain' in todo && todo.reachesMain !== undefined) return todo.reachesMain;
  return todo.kind === 'error' && todo.message.includes('검수자 없음 —');
}
function Todo({ todo, act, snapshot }: { todo: HomeTodo; act: (todo: HomeTodo, answer?: string) => void; snapshot: AppSnapshot }) {
  const [answer, setAnswer] = useState('');
  const reachesMain = todoReachesMain(todo);
  const emergencyNotDelivered = todo.kind === 'emergency_held' && todo.reachesMain === false;
  const needsCommand = (todo.kind === 'recovery_check' || todo.kind === 'error') && !reachesMain;
  const taskId = 'taskId' in todo ? todo.taskId : null;
  const task = snapshot.tasks.find(value => value.id === taskId);
  const commandProject = ('projectId' in todo ? todo.projectId : null) ?? task?.projectId ?? null;
  const commandText = emergencyNotDelivered ? '긴급 정지로 보류된 작업에 대해: ' : taskId ? taskCommand(taskId, snapshot) : '이 보류 항목에 대해: ';
  const meta = {
    question: { icon: <CircleHelp size={17} />, label: '질문', text: todo.kind === 'question' ? `${todo.fromName}: ${todo.text}` : '' },
    unread_report: { icon: <FileText size={17} />, label: '새 보고', text: todo.kind === 'unread_report' ? todo.title : '' },
    error: { icon: <CircleAlert size={17} />, label: reachesMain ? '메인 에이전트가 처리 중' : '보류된 작업', text: todo.kind === 'error' ? todo.message : '' },
    recovery_check: { icon: <RefreshCw size={17} />, label: reachesMain ? '메인 에이전트가 처리 중' : '복구 확인 필요', text: todo.kind === 'recovery_check' ? todo.message : '' },
    auth_required: { icon: <KeyRound size={17} />, label: 'AI 인증', text: todo.kind === 'auth_required' ? `${AI_KIND_LABEL[todo.aiKind]} 로그인을 다시 확인하세요.` : '' },
    emergency_held: { icon: <Pause size={17} />, label: emergencyNotDelivered ? `보류된 작업 ${todo.count}건` : '보류 작업', text: todo.kind === 'emergency_held' && !emergencyNotDelivered ? `${todo.count}건의 보류 작업은 메인 에이전트가 확인해 항목별로 재개합니다.` : '' },
  }[todo.kind];
  return <div className="todo" id={todo.kind === 'question' ? `question-${todo.questionId}` : undefined}><span className="todo-icon">{meta.icon}</span><div><strong>{meta.label}</strong>{reachesMain && <p>{task ? `${task.id} ${task.title}` : todo.kind === 'recovery_check' ? `복구 확인 ${todo.requestId}` : '보류된 작업'}</p>}{meta.text && (reachesMain ? <details className="hold-history"><summary>보류 당시 기록</summary><p>{meta.text}</p></details> : <p>{meta.text}</p>)}{todo.kind === 'auth_required' && <p className="muted">API 키 방식이면 설치 설정에서 키를 다시 등록하세요. 재로그인 필요 상태가 해제됩니다.</p>}{needsCommand && <p className="muted">이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 필요한 조치는 명령창으로 메인 에이전트에게 알려 주세요.</p>}{emergencyNotDelivered && <p className="muted">이 보류 목록은 메인 에이전트에게 전해지지 않았습니다. 필요한 조치는 명령창으로 메인 에이전트에게 알려 주세요.</p>}{todo.kind === 'question' && <textarea rows={2} value={answer} onChange={e => setAnswer(e.target.value)} placeholder="답변을 입력하세요" />}</div><button onClick={() => act(todo, answer)} disabled={todo.kind === 'question' && !answer.trim()}>{todo.kind === 'question' ? '답변 보내기' : todo.kind === 'auth_required' ? '다시 확인' : '열기'} <ArrowRight size={14} /></button>{(todo.kind === 'error' || todo.kind === 'recovery_check' || todo.kind === 'emergency_held') && <button onClick={() => openCommand(commandProject, commandText)}>메인 에이전트에게 말하기</button>}</div>;
}
export function Home({ snapshot, openProject, openTask, openReport, openMember, openPolicy }: { snapshot: AppSnapshot; openProject: (id: string) => void; openTask: (id: string) => void; openReport: (id: string) => void; openMember: (id: string) => void; openPolicy: () => void }) {
  // Older servers repeat error:<taskId> for different reasons. Keep both rows.
  const occurrences = new Map<string, number>();
  const todos = snapshot.ownerTodos.filter((todo): todo is HomeTodo => todoKinds.has(todo.kind)).map(todo => {
    const occurrence = occurrences.get(todo.id) ?? 0;
    occurrences.set(todo.id, occurrence + 1);
    return { todo, key: `${todo.id}:${occurrence}` };
  });
  const mainTodos = todos.filter(({ todo }) => todoReachesMain(todo));
  const ownerTodos = todos.filter(({ todo }) => !todoReachesMain(todo) &&
    (todo.kind === 'question' || todo.kind === 'unread_report' || todo.kind === 'emergency_held'));
  const otherTodos = todos.filter(({ todo }) => !todoReachesMain(todo) &&
    todo.kind !== 'question' && todo.kind !== 'unread_report' && todo.kind !== 'emergency_held');
  const mainPaused = mainPauseReason(snapshot);
  const globalStopped = snapshot.stop.global.active && !mainPaused;
  const ownerCount = ownerTodos.filter(({ todo }) => todo.kind === 'question' || todo.kind === 'unread_report').length +
    (mainPaused || globalStopped || ownerTodos.some(({ todo }) => todo.kind === 'emergency_held') ? 1 : 0);
  const mainAgent = snapshot.members.find(member => member.isMain);
  const act = (todo: HomeTodo, answer?: string) => {
    switch (todo.kind) {
      case 'question': void call('questions.answer', todo.questionId, answer ?? '').then(() => toast('답변을 전달했습니다', '', 'info')).catch(() => undefined); break;
      case 'unread_report': openReport(todo.reportId); break;
      case 'error': if (todo.memberId) openMember(todo.memberId); else if (todo.taskId) openTask(todo.taskId); else openPolicy(); break;
      case 'recovery_check': openPolicy(); break;
      case 'auth_required': void call('system.recheckAi', todo.aiKind).catch(() => undefined); break;
      case 'emergency_held': openPolicy(); break;
    }
  };
  return <div className="screen home"><div className="page-heading"><div><span className="eyebrow">전체 현황</span><h1>프로젝트 현황</h1><p>진행 중인 일과 대표의 확인이 필요한 항목입니다.</p></div><button className="primary-button" onClick={() => openCommand(null, '새 프로젝트를 만들어 줘: ')}><FolderPlus size={17} /> 프로젝트 만들기 요청</button></div>
    {snapshot.ai.some(hasAiWarning) && <div className="ai-warning"><CircleAlert size={18} /><div>{snapshot.ai.filter(hasAiWarning).map(ai => <AiStatusSummary key={ai.kind} ai={ai} />)}</div><button onClick={openPolicy}>운영 상태 보기 <ArrowRight size={14} /></button></div>}
    {mainAgent && <button className="main-agent-banner" onClick={() => openMember(mainAgent.id)}><Member3DPortrait member={mainAgent} className="main-agent-portrait" /><span className="main-agent-copy"><span className="eyebrow">메인 에이전트</span><strong>{mainAgent.name}</strong><small>{resolveDisplayText(mainPaused ? `메인 에이전트가 정지했습니다. ${mainPaused}` : mainAgent.currentWork ? resolveWorkLabel(mainAgent.currentWork.label, snapshot) : mainAgent.statusReasons[0] ?? '작업을 기다리고 있습니다.', snapshot)}</small></span><StatusBadge status={mainAgent.status} /><ArrowRight size={18} /></button>}
    <div className="home-grid"><div><Section title="진행 중인 프로젝트"><div className="project-grid">{snapshot.projects.map(project => <button className="project-card" key={project.id} onClick={() => openProject(project.id)}><div className="project-card-top"><span className={`project-dot ${project.paused ? 'dot-paused' : ''}`} /><strong>{project.name}</strong><ArrowRight size={17} /></div><p className="muted project-path">{project.path}</p><div className="stat-line"><span><strong>{project.activeDirectiveCount}</strong> 진행 중 지시</span><span>{project.mock.enabled ? '모의 실행' : '실제 실행'}</span></div><Progress value={project.progress} /><div className="status-counts">{Object.entries(project.memberStatusCounts).filter(([, count]) => count).map(([status, count]) => <span key={status}><StatusBadge status={status as keyof typeof project.memberStatusCounts} /> {count}</span>)}</div><div className="latest-report">{project.latestReport ? <>최근 보고 <strong>{project.latestReport.title}</strong><small>{REPORT_STATUS_LABEL[project.latestReport.status]} · {date(project.latestReport.createdAt)}</small></> : '아직 보고서가 없습니다.'}</div></button>)}</div></Section><Section title="최근 활동"><div className="activity-list">{snapshot.recentActivity.map(item => <div className="activity-row" key={item.seq}><ActivityMarker item={item} /><div><strong>{item.actorName}</strong> <small>{ACTIVITY_KIND_LABEL[item.kind]}</small><p>{item.text}</p></div><time>{date(item.ts)}</time></div>)}</div></Section></div><div className="home-todos"><Section title="대표 할 일" action={<span className="todo-number">{ownerCount}</span>}><div className="todo-list">{mainPaused && <MainPauseNotice snapshot={snapshot} openMember={openMember} />}{globalStopped && <p className="hint">긴급 정지 중입니다. 상단의 정지 해제에서 새 실행을 허용할 수 있습니다.</p>}{ownerTodos.map(({ todo, key }) => <Todo key={key} todo={todo} act={act} snapshot={snapshot} />)}{!ownerCount && <p className="empty">지금 결정할 일이 없습니다.</p>}</div></Section>{mainTodos.length > 0 && <Section title="메인 에이전트가 처리 중"><div className="todo-list">{mainTodos.map(({ todo, key }) => <Todo key={key} todo={todo} act={act} snapshot={snapshot} />)}</div></Section>}{otherTodos.length > 0 && <Section title="확인이 필요한 항목"><div className="todo-list">{otherTodos.map(({ todo, key }) => <Todo key={key} todo={todo} act={act} snapshot={snapshot} />)}</div></Section>}</div></div></div>;
}
