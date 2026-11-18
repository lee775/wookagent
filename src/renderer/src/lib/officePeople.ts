import type { AppSnapshot, MemberView, ProjectView } from '../../../shared/views';
import { AI_KIND_LABEL, EFFORT_TIER_LABEL } from '../../../shared/labels';
import { resolveDisplayText, resolveWorkLabel } from './displayText';

type Context = Pick<AppSnapshot, 'tasks' | 'directives'> & Partial<Pick<AppSnapshot, 'seat'>>;
export function officeLabel(member: MemberView, context: Context, stopped = false, paused = false) {
  const holder = member.isMain ? context.seat?.holder : null;
  const ai = holder?.kind === 'external' ? `${holder.label} · 외부 에이전트 · AI 설정은 외부에서 관리합니다.` : `${AI_KIND_LABEL[member.ai.kind]} · ${member.ai.modelValue ?? '기본 모델'} · ${EFFORT_TIER_LABEL[member.ai.effortTier]} (${member.ai.effortValue})${member.ai.mock ? ' · 모의' : ''}`;
  const reason = resolveDisplayText(member.statusReasons[0] ?? '', context);
  const task = member.currentTask;
  const active = !stopped && !paused && member.status === 'working';
  const state = stopped ? '긴급 정지' : paused || member.status === 'paused' ? '일시정지' : member.status === 'awaiting_answer' ? '대표 답변 대기' : member.status === 'error' ? '작업 막힘' : task?.inReview ? '검수 중' : task?.state === 'on_hold' ? '작업 보류' : active ? '업무 중' : '대기 중';
  const work = task ? `${task.title}${task.currentStep ? ` · ${task.currentStep}` : ''}` : member.currentWork ? member.currentWork.kind==='screen_check'?'화면 확인':resolveWorkLabel(member.currentWork.label, context) : '';
  const detail = active && !task?.inReview ? work || reason || '현재 업무 내용이 전달되지 않았습니다.' : [reason, work].filter(Boolean).join(' · ');
  return { name: member.name, role: member.roleName, ai, active, state, work: `${state}${detail ? ` · ${detail}` : ''}` };
}

export function departmentMembers(snapshot: AppSnapshot, project: ProjectView) {
  return snapshot.members.filter(member => member.projectId === project.id && !member.deleted && !member.isMain);
}
export function departmentState(snapshot: AppSnapshot, project: ProjectView) {
  const members = departmentMembers(snapshot, project);
  const active = snapshot.stop?.global?.active ? 0 : members.filter(member => member.status === 'working').length;
  const directives = snapshot.directives.filter(directive => directive.projectId === project.id && directive.state !== 'closed' && directive.state !== 'cancelled');
  const text = snapshot.stop?.global?.active ? '긴급 정지 중입니다. 새 실행을 멈췄습니다.' : project.paused ? '부서가 일시정지 중입니다.' : !directives.length && !active ? '진행 중인 지시가 없어 지금 일하는 직원이 없습니다.' : !active ? '지금 일하는 직원이 없습니다. 각 직원의 대기 사유를 확인해 주세요.' : `${active}명이 업무를 진행하고 있습니다.`;
  return { members, active, directives, text };
}
