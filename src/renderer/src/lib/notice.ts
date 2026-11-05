import type { ModelLimitFamily, NavTarget } from '../../../shared/domain';
import type { AppSnapshot, NotificationView } from '../../../shared/views';
const familyLabels = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable' } satisfies Record<ModelLimitFamily, string>;

export function noticeTitle(item: NotificationView): string {
  const key = item.key;
  if (key == null) return item.title;
  if (key.startsWith('device-login:')) return '새 기기가 로그인했습니다';
  if (key.startsWith('usage:')) {
    const family = key.split(':')[2];
    const label = Object.entries(familyLabels).find(([value]) => value === family)?.[1] ?? family;
    return family ? `${label} 주간 한도` : '사용량 한도';
  }
  if (key.startsWith('mock-on')) return '모의 실행이 켜져 있음';
  if (key.startsWith('execution-reset')) return '실행 설정을 기본값으로 되돌림';
  if (key.startsWith('review-stuck:')) return '검수 멈춤';
  if (key.startsWith('handoff-stuck:') || key.startsWith('pause-stuck:')) return '메인 에이전트 처리 지연';
  if (key.startsWith('crash:')) return '자동 복구 실패';
  if (key.startsWith('start-fail:')) return '업무 시작 실패';
  if (key.startsWith('spin:')) return '헛돌기';
  return item.title;
}

export function taskCommand(taskId: string, snapshot: Pick<AppSnapshot, 'tasks'>): string {
  const task = snapshot.tasks.find(value => value.id === taskId);
  return `${taskId}${task ? ` "${task.title}"` : ''}에 대해: `;
}

function linkedCommand(link: NavTarget | null, snapshot: AppSnapshot) {
  if (link?.tab !== 'projects') return null;
  const task = snapshot.tasks.find(task => task.id === link.taskId);
  const member = snapshot.members.find(member => member.id === link.memberId);
  const directive = snapshot.directives.find(directive => directive.id === link.directiveId);
  if (link.taskId) return { projectId: link.projectId ?? task?.projectId ?? null, text: taskCommand(link.taskId, snapshot) };
  if (link.memberId) return { projectId: link.projectId ?? member?.projectId ?? null, text: `${link.memberId}${member ? ` ${member.name}(${member.roleName})` : ''}에 대해: ` };
  if (link.directiveId) return { projectId: link.projectId ?? directive?.projectId ?? null, text: `${link.directiveId}${directive ? ` "${directive.title}"` : ''}의 멈춘 작업을 확인해 줘: ` };
  return null;
}

export function noticePresentation(item: NotificationView, snapshot: AppSnapshot): { title: string; link: NavTarget | null; command: ReturnType<typeof linkedCommand> } {
  const key = item.key;
  let link = item.link;
  let command: ReturnType<typeof linkedCommand> = null;
  if (link?.tab === 'seat' || key?.startsWith('seat-unresponsive:')) return { title: item.title, link: { tab: 'seat' }, command: null };
  if (key == null) return { title: item.title, link, command: linkedCommand(link, snapshot) };
  if (key.startsWith('device-login:')) {
    link = { tab: 'settings', section: 'account' };
  } else if (key.startsWith('usage:') || key.startsWith('mock-on')) {
    link = { tab: 'settings', section: 'account' };
  } else if (key.startsWith('execution-reset')) {
    link = { tab: 'settings', section: 'execution' };
    command = { projectId: null, text: '실행 설정에 대해: ' };
  } else if (key.startsWith('review-stuck:') || key.startsWith('handoff-stuck:')) {
    if (link?.tab === 'projects') {
      const taskId = link.taskId;
      const task = snapshot.tasks.find(value => value.id === taskId);
      link = { tab: 'projects', projectId: link.projectId ?? task?.projectId, directiveId: link.directiveId, taskId: link.taskId };
      command = linkedCommand(link, snapshot);
    }
  } else if (key.startsWith('pause-stuck:')) {
    const memberId = link?.tab === 'projects' ? link.memberId ?? key.split(':')[1] : key.split(':')[1];
    const member = snapshot.members.find(value => value.id === memberId);
    link = { tab: 'projects', projectId: (link?.tab === 'projects' ? link.projectId : undefined) ?? member?.projectId ?? undefined, memberId };
    command = linkedCommand(link, snapshot);
  } else if (key.startsWith('crash:') || key.startsWith('start-fail:') || key.startsWith('spin:')) {
    // A per-drop suffix may follow the session. Never infer a request from body text.
    const linked = linkedCommand(link, snapshot);
    const projectId = (link?.tab === 'projects' ? link.projectId : null) ?? linked?.projectId ??
      snapshot.projects.find(project => key.split(':').includes(project.id))?.id ?? null;
    link ??= { tab: 'projects', ...(projectId ? { projectId } : {}) };
    command = { projectId, text: '' };
  }
  return { title: noticeTitle(item), link, command };
}
