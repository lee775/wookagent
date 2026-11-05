import type { AppSnapshot, DirectiveView, MemberStatus, TaskView } from '../../../../shared/views';

const steps = ['idle', 'busy', 'assignment', 'step', 'review', 'submit', 'check', 'rejected', 'passed', 'conflict', 'waiting', 'error', 'paused', 'report', 'emergency', 'release', 'events',
  'hiring', 'team2', 'team20', 'team24', 'team30', 'team50'] as const;
export type DemoStep = typeof steps[number];
const activityText: Partial<Record<DemoStep, string>> = {
  step: '작업 단계를 마쳤습니다.', rejected: '검수 의견을 받고 수정합니다.',
  passed: '검수를 통과했습니다.', conflict: '파일 충돌을 확인하고 해결합니다.',
};

export function officeDemoStep(query: string | null, elapsedMs: number): DemoStep | null {
  if (query === 'cycle') {
    const second = ((Math.max(0, elapsedMs) / 1000) % 88 + 88) % 88;
    const schedule: Array<[number, DemoStep]> = [[4, 'busy'], [11, 'assignment'], [30, 'review'],
      [32, 'passed'], [34, 'conflict'], [47, 'report'], [49, 'waiting'], [53, 'error'],
      [57, 'emergency'], [61, 'release'], [64, 'busy'], [88, 'idle']];
    return schedule.find(([until]) => second < until)?.[1] ?? 'busy';
  }
  if (query === 'working') return 'busy';
  return steps.find(step => step === query) ?? null;
}

export function officeDemoSnapshot(base: AppSnapshot, step: DemoStep, elapsedMs: number): AppSnapshot {
  const demo = structuredClone(base);
  const finalDesk = demo.members.find(member => member.id === 'M-0024');
  if (finalDesk && !demo.members.some(member => member.id === 'M-0025'))
    demo.members.push({ ...finalDesk, id: 'M-0025', name: '은채', currentTask: null,
      currentSessionId: 'S-M-0025', lastLine: null });
  const requested=step==='team2'?2:step==='team20'?20:step==='team24'?24:step==='team30'?30:step==='team50'?50:
    step==='hiring'?Math.min(14,3+Math.floor(Math.max(0,elapsedMs)/4000)):13;
  const officeMembers=demo.members.filter(member=>member.projectId==='P-0003'&&!member.deleted);
  const producerMember=officeMembers.find(member=>member.isProducer);
  const nonProducers=officeMembers.filter(member=>!member.isProducer);
  const template=nonProducers.at(-1);
  if(template)for(let index=nonProducers.length;index<requested-(producerMember?1:0);index++){
    const serial=26+index-nonProducers.length;
    const id=`M-${String(serial).padStart(4,'0')}`;
    demo.members.push({...template,id,name:`팀원 ${index+1}`,roleId:
      ['developer','ui_designer','qa','docs','planner','architect'][index%6],
      currentTask:null,currentSessionId:`S-${id}`,lastLine:null});
  }
  if(requested<officeMembers.length){
    const keep=new Set([...(producerMember?[producerMember.id]:[]),...nonProducers.slice(0,Math.max(0,requested-1)).map(member=>member.id)]);
    demo.members=demo.members.filter(member=>member.projectId!=='P-0003'||keep.has(member.id));
  }
  const stamp = new Date().toISOString();
  demo.auth.loggedIn = true;
  demo.auth.owner = { email: 'preview@example.com', name: '미리보기' };
  const team = demo.members.filter(member => member.projectId === 'P-0003');
  const producer = team.find(member => member.isProducer);
  const byId = (id: string) => team.find(member => member.id === id);
  const workLabels: Record<string, string> = {
    producer: '작업 순서와 담당자를 조율합니다.', planner: '화면 흐름을 정리합니다.', architect: '구성도를 다듬습니다.',
    developer: '코드를 작성하고 확인합니다.', ui_designer: '화면 요소를 그리고 있습니다.', qa: '검사 항목을 확인합니다.', docs: '사용 안내를 작성합니다.',
  };
  const setStatus = (id: string, status: MemberStatus) => {
    const member = byId(id);
    if (!member) return;
    member.status = status;
    member.statusReasons = [status === 'working' ? '업무 중입니다.' : status === 'idle' ? '쉬는 중입니다.' : status === 'awaiting_answer' ? '대표의 답변을 기다립니다.' : status === 'paused' ? '일시정지 중입니다.' : '오류를 확인합니다.'];
    member.currentWork = status === 'working' ? { kind: member.isProducer ? 'plan' : 'task_work', label: workLabels[member.roleId] ?? '작업을 진행합니다.', turnId: `demo-${id}`, startedAt: stamp } : null;
  };
  team.forEach(member => { setStatus(member.id, 'working'); member.currentTask = null; member.lastLine = null; member.deleted = false; });
  if (step === 'idle') {
    team.forEach(member => setStatus(member.id, 'idle'));
  }
  if (step === 'events') {
    ['M-0019', 'M-0020', 'M-0022', 'M-0023'].forEach(id => setStatus(id, 'idle'));
    const coffee = byId('M-0022');
    if (coffee) coffee.lastActivityAt = new Date(Date.now() - 30000).toISOString();
  }
  if (step === 'release') ['M-0015', 'M-0018', 'M-0019'].forEach(id => setStatus(id, 'paused'));
  if (step === 'waiting') { setStatus('M-0017', 'awaiting_answer'); setStatus('M-0022', 'awaiting_answer'); }
  if (step === 'error') setStatus('M-0016', 'error');
  if (step === 'paused') setStatus('M-0018', 'paused');
  if (step === 'emergency') { demo.stop.global = { active: true, since: stamp }; team.forEach(member => setStatus(member.id, 'paused')); }

  const source = demo.tasks.find(task => task.projectId === 'P-0003') ?? demo.tasks[0];
  const directiveTemplate = demo.directives.find(item => item.projectId === 'P-0003') ?? demo.directives[0];
  const sourceDirective: DirectiveView | null = directiveTemplate ? { ...directiveTemplate, id: 'D-DEMO', projectId: 'P-0003', title: '작업실 안내 화면 다듬기', state: 'in_progress' as const,
    text: '화면 구성, 구현, 검수, 결과 보고', progress: { done: step === 'report' ? 3 : 2, total: 4, ratio: step === 'report' ? .75 : .5 }, taskIds: [] } : null;
  if (sourceDirective && step !== 'idle') demo.directives.unshift(sourceDirective);
  if (source && sourceDirective && step !== 'idle') demo.tasks.unshift({ ...source, id: 'T-DEMO-BASE',
    projectId: 'P-0003', directiveId: sourceDirective.id, assigneeId: 'M-0014', reviewerId: null,
    state: 'in_progress', activatedAt: null, hold: null, conflictFiles: [], steps: source.steps.map((entry, index) => ({ ...entry,
      done: index < (step === 'report' ? 3 : 2), doneAt: null })) });
  const addTask = (id: string, assigneeId: string, reviewerId: string, state: TaskView['state']): TaskView | null => {
    if (!source || !sourceDirective) return null;
    const task: TaskView = { ...source, id, projectId: 'P-0003', directiveId: sourceDirective.id, assigneeId, reviewerId,
      state, activatedAt: step === 'assignment' && assigneeId === 'M-0014' ? stamp : source.activatedAt,
      completedAt: step === 'passed' ? stamp : null, conflictFiles: step === 'conflict' ? ['src/renderer/src/App.tsx'] : [],
      review: { ...source.review, autoCheck: step === 'check' ? 'running' : 'not_run', rejectsTotal: step === 'rejected' ? 1 : 0 },
      hold: step === 'waiting' ? { reasons: [{ kind: 'answer_wait', label: '대표 답변 대기', note: '', since: stamp }], returnState: 'in_progress' } : null,
    };
    demo.tasks.unshift(task);
    const assignee = byId(assigneeId);
    if (assignee) assignee.currentTask = { id, title: task.title, state, progress: { done: 2, total: 3, ratio: 2 / 3 }, currentStep: '화면 구성', inReview: state === 'in_review', branch: null };
    return task;
  };
  if (step === 'review') addTask('T-DEMO-REVIEW', 'M-0016', 'M-0021', 'in_review');
  if (step === 'submit') addTask('T-DEMO-SUBMIT', 'M-0018', 'M-0015', 'in_review');
  if (step === 'assignment') addTask('T-DEMO-ASSIGN', 'M-0014', 'M-0013', 'in_progress');
  if (['step', 'check', 'rejected', 'passed', 'conflict', 'waiting', 'error'].includes(step)) addTask('T-DEMO-WORK', 'M-0016', 'M-0021', step === 'passed' ? 'done' : 'in_progress');
  if (step === 'waiting') setStatus('M-0016', 'awaiting_answer');
  if (step === 'report' && producer) {
    const sourceActivity = demo.recentActivity[0];
    if (sourceActivity) demo.recentActivity.unshift({ ...sourceActivity, seq: 90000, ts: stamp, projectId: 'P-0003', memberId: producer.id, kind: 'report', text: '보고서를 전달했습니다.' });
    demo.ownerTodos.unshift({ kind: 'unread_report', id: 'todo-demo-report', reportId: 'R-DEMO', title: '작업실 안내 화면 결과 보고', projectId: 'P-0003', since: stamp });
  }
  if (['step', 'rejected', 'passed', 'conflict'].includes(step)) {
    const sourceActivity = demo.recentActivity[0];
    if (sourceActivity) demo.recentActivity.unshift({ ...sourceActivity, seq: 90001, ts: stamp, projectId: 'P-0003', memberId: 'M-0016', taskId: 'T-DEMO-WORK',
      kind: step === 'step' ? 'file_change' : step === 'conflict' || step === 'passed' ? 'merge' : 'review',
      level: step === 'conflict' || step === 'rejected' ? 'warn' : 'info', text: activityText[step] ?? '작업을 확인합니다.' });
  }
  if (step === 'idle') demo.recentActivity = demo.recentActivity.filter(item => item.projectId !== 'P-0003');
  if (sourceDirective && step !== 'idle') {
    const active = demo.tasks.filter(task => task.directiveId === sourceDirective.id);
    sourceDirective.progress = { done: step === 'report' ? 3 : 2, total: 4, ratio: step === 'report' ? .75 : .5 };
    sourceDirective.taskIds = active.map(task => task.id);
  }
  const project = demo.projects.find(item => item.id === 'P-0003');
  if (project) {
    project.activeDirectiveCount = step === 'idle' ? 0 : 1;
    project.progress = step === 'idle' ? { done: 0, total: 0, ratio: 0 } : sourceDirective?.progress ?? project.progress;
    project.memberStatusCounts = { working: 0, idle: 0, awaiting_answer: 0, paused: 0, error: 0 };
    team.filter(member => !member.deleted).forEach(member => { project.memberStatusCounts[member.status]++; });
  }
  demo.running.cap = Math.max(13,team.length);
  demo.running.generalCap = Math.max(12,team.length-1);
  demo.running.total = team.filter(member => !member.deleted && member.status === 'working').length;
  demo.running.management = producer?.status === 'working' ? 1 : 0;
  demo.running.general = demo.running.total - demo.running.management;
  demo.generatedAt = stamp;
  demo.version = base.version + Math.floor(elapsedMs / 1000);
  return demo;
}
