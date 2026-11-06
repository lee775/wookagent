import type { AppSnapshot, CheckRunView, HoldReasonView, TaskDetail, TaskView } from '../../../shared/views';

export function changedCriteriaOf(task: TaskView): string[] {
  return task.changedCriteria ?? [];
}

export function unverifiableConflictFiles(task: TaskView): string[] {
  return task.conflictUnverifiable ?? [];
}

export function checkRunsOf(detail: TaskDetail): CheckRunView[] {
  return detail.checkRuns ?? [];
}

export function checkRunDetails(run: CheckRunView): string[] {
  const details: string[] = [];
  if (run.remaining === -1) details.push('종료 확인 못 함');
  else if (run.remaining !== null && run.remaining > 0) details.push(`남은 프로세스 ${run.remaining}개`);
  if (run.leftFiles.length > 0) details.push(`남은 파일: ${run.leftFiles.join(', ')}`);
  return details;
}

export function isRejudgeHold(task: TaskView): boolean {
  return !!task.hold?.reasons.some(reason => reason.kind === 'error' && reason.refId === 'rejudge');
}

function reasonNeedsMainCommand(reason: HoldReasonView): boolean {
  if (reason.reachesMain !== undefined) return !reason.reachesMain;
  return (reason.kind === 'error' && reason.refId !== 'no_reviewer') ||
    reason.kind === 'merge_blocked' || reason.kind === 'recovery_check';
}

export function holdNeedsMainCommand(task: TaskView): boolean {
  return !!task.hold?.reasons.some(reasonNeedsMainCommand);
}

export function holdReasonHint(reason: HoldReasonView, runs: readonly CheckRunView[]): string {
  if (reason.reachesMain === true) return '메인 에이전트가 처리 중';
  const heldRuns = reason.kind === 'error' && reason.scope === 'task'
    ? runs.filter(run => run.requestId === reason.refId) : [];
  if (heldRuns.length) {
    const result = heldRuns.some(run => run.leftFiles.length > 0)
      ? '메인 에이전트가 재개해도 검사에서 남긴 파일이 그대로면 제출을 거부하고 담당에게 정리를 맡깁니다.'
      : '메인 에이전트가 재개하면 같은 버전일 때 기록된 검사 결과로 이어 갑니다.';
    return `이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 남은 프로세스가 정리되면 명령창으로 메인 에이전트에게 알려 주세요. ${result}`;
  }
  if (reason.reachesMain === undefined && reason.kind === 'error' && reason.refId === 'rejudge') {
    return '이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 다시 판정을 받을지, 등록한 통과로 이어 갈지 명령창으로 메인 에이전트에게 말해 주세요.';
  }
  if (reasonNeedsMainCommand(reason)) {
    return '이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 원인이 정리되면 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다.';
  }
  return '메인 에이전트가 보류 사유를 확인하고 필요한 조치를 마친 뒤 작업을 재개합니다.';
}

export function isUnconfirmedCheckHold(task: TaskView, runs: readonly CheckRunView[]): boolean {
  return !!task.hold?.reasons.some(reason => reason.kind === 'error' && reason.scope === 'task' &&
    !!reason.refId && runs.some(run => run.requestId === reason.refId));
}

export function checkResumeHint(task: TaskView, runs: readonly CheckRunView[]): string | null {
  if (!isUnconfirmedCheckHold(task, runs)) return null;
  return [...new Set(task.hold?.reasons.filter(reason => reason.kind === 'error' && reason.scope === 'task' &&
    runs.some(run => run.requestId === reason.refId)).map(reason => holdReasonHint(reason, runs)))].join(' ');
}

export function pauseRelease(task: TaskView, snapshot: AppSnapshot): 'member' | 'project' | null {
  if (task.state !== 'on_hold' || !task.hold?.reasons.some(reason => reason.kind === 'paused')) return null;
  const projectPaused = snapshot.stop.pausedProjects.some(project => project.projectId === task.projectId);
  const memberPaused = snapshot.stop.pausedMembers.some(member => member.memberId === task.assigneeId);
  const pausedReasons = task.hold.reasons.filter(reason => reason.kind === 'paused');
  if (pausedReasons.some(reason => reason.scope === 'member')) return memberPaused ? 'member' : null;
  if (pausedReasons.some(reason => reason.scope === 'project')) return projectPaused ? 'project' : null;
  const note = pausedReasons.map(reason => reason.note).join(' ');
  if (memberPaused && /팀원 .+ 재개로 풀림/.test(note)) return 'member';
  if (projectPaused && note.includes('프로젝트 재개로 풀림')) return 'project';
  if (projectPaused && !memberPaused) return 'project';
  if (memberPaused && !projectPaused) return 'member';
  return null;
}

export function messageDeliveryStatus(message: { text: string; delivered: boolean; undelivered?: string | null }): string {
  if (message.undelivered) return '전달 못 함';
  if (message.delivered) return '전달됨';
  return message.text.startsWith('(다시 전달 —') ? '다시 전달 대기' : '전달 대기';
}

export function emergencyHeadline(summary: { completed: boolean; failures: { remaining?: number }[] }, server = false): string {
  if (summary.completed) return '실행 종료를 확인했습니다.';
  const unknown = summary.failures.filter(failure => failure.remaining === -1).length;
  if (unknown && unknown === summary.failures.length) return server ? '종료를 확인하지 못했습니다 — 서버 PC의 남은 프로세스를 운영자에게 확인해 주세요' : '종료를 확인하지 못했습니다 — 작업 관리자에서 남은 프로세스를 확인하세요';
  if (unknown) return '종료 실패 — 남은 프로세스가 있습니다 (일부는 확인하지 못함)';
  return '종료 실패 — 남은 프로세스가 있습니다';
}

export function emergencyFailureKey(memberId: string, index: number): string {
  return `${memberId}:${index}`;
}

export function noticeLines(title: string, body: string): string[] {
  return title === '프로젝트 폴더 동기화 필요' ? body.split(' / ') : [body];
}
