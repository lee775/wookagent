/**
 * 검수 자격·기본 검수자 (REV-02, REV-03, REV-06, CLI-08).
 * 자격 = 검수 권한 역할 + 그 작업의 검수자로 배정 + 작업자·실질 수정 참여자 아님 + 삭제되지 않음.
 * 메인 에이전트는 적격 팀원이 없을 때의 대체 검수자다 (REV-06 v0.6) — 작업 폴더를 고치지 않으므로 그 작업의 기여자가 아니면 독립 검수가 된다.
 */
import type { CriterionResult, Member, MemberId, Role, Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';

export type Eligibility = { ok: true } | { ok: false; reason: string };

/** 메인 에이전트가 이 작업을 검수할 수 있는지 — 그 작업의 작업자·실질 수정 참여자로 기록돼 있지 않을 때만 (REV-02·06 v0.6) */
export function mainCanReview(task: Task): boolean {
  return task.assigneeId !== MAIN_AGENT_ID && !task.contributors.includes(MAIN_AGENT_ID);
}

/** 이 팀원이 검수자가 될 수 있는지 (배정 여부는 보지 않음) */
export function canBeReviewer(member: Member, role: Role | null, task: Task): Eligibility {
  if (member.deletedAt) return { ok: false, reason: '삭제된 팀원입니다' };
  // 메인 에이전트는 프로젝트·역할과 상관없이 대체 검수자가 될 수 있다 — 그 작업에 기여했으면 아니다 (REV-06 v0.6)
  if (member.isMain) return mainCanReview(task) ? { ok: true } : { ok: false, reason: '메인 에이전트가 이 작업에 기여해 검수할 수 없습니다' };
  if (member.projectId !== task.projectId) return { ok: false, reason: '다른 프로젝트 팀원입니다' };
  if (!role?.canReview && !member.isProducer) return { ok: false, reason: '검수 권한이 없는 역할입니다' };
  if (task.assigneeId === member.id || task.contributors.includes(member.id)) {
    return { ok: false, reason: '작업자 또는 실질 수정 참여자는 검수할 수 없습니다' };
  }
  return { ok: true };
}

/** 검수 결과 등록 허용 (REV-03): 자격 + 이 작업의 배정 검수자 */
export function canSubmitReview(member: Member, role: Role | null, task: Task): Eligibility {
  if (task.reviewerId !== member.id) return { ok: false, reason: '이 작업의 검수자로 배정되지 않았습니다' };
  return canBeReviewer(member, role, task);
}

const ROLE_PREFERENCE = ['qa', 'architect'];

/**
 * 기본 검수자: 프로듀서 → 적격 검수 권한 팀원(QA, 설계자, 사용자 정의 순) → 메인 에이전트 (REV-02, REV-06 v0.6).
 * 메인 에이전트도 그 작업의 기여자라 대신할 수 없으면 null — 부르는 쪽이 작업을 보류하고 메인에게 '검수자 없음'을 알린다 (tasks.dispatchReview).
 * 자동 통과·본인 검수로 대체하지 않는다.
 */
export function chooseReviewer(
  task: Task,
  members: readonly Member[],
  roleOf: (roleId: string) => Role | null,
  exclude: readonly MemberId[] = [],
): MemberId | null {
  const pool = members.filter((m) => m.projectId === task.projectId && !m.deletedAt && !exclude.includes(m.id));
  const producer = pool.find((m) => m.isProducer);
  if (producer && canBeReviewer(producer, roleOf(producer.roleId), task).ok) return producer.id;
  const eligible = pool
    .filter((m) => !m.isProducer && canBeReviewer(m, roleOf(m.roleId), task).ok)
    .sort((a, b) => {
      const ra = ROLE_PREFERENCE.indexOf(a.roleId);
      const rb = ROLE_PREFERENCE.indexOf(b.roleId);
      const pa = ra < 0 ? ROLE_PREFERENCE.length : ra;
      const pb = rb < 0 ? ROLE_PREFERENCE.length : rb;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : 1;
    });
  if (eligible[0]) return eligible[0].id;
  return mainCanReview(task) && !exclude.includes(MAIN_AGENT_ID) ? MAIN_AGENT_ID : null;
}

/** 완료 조건 글을 비교용으로: 줄바꿈·연속 공백을 하나로, 앞뒤 공백과 앞의 번호·글머리("1." "1)" "-")를 뗀다 */
function criterionKey(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\d+[.)]|[-*•])\s*/, '')
    .trim();
}

/**
 * 완료 조건을 바꿀 때(update_task·replan_task) 새 목록에서 더해지거나 바뀐 조건 — 이번 변경 전 목록에 같은 글(공백·번호 정리)이 없는 조건과,
 * 앞 변경들에서 더해지거나 바뀐 조건(prev) 중 아직 목록에 있는 조건 (REV-03). 쌓아 두고 통과가 기록될 때 비운다(taskMachine review_pass) —
 * 통과 전에 조건을 또 바꿔도(더하기·순서 바꾸기) 앞 변경의 조건이 다시 자리로 덮이지 않게.
 * 목록이 그대로면(같은 글이 같은 순서) 조건을 바꾼 것이 아니므로 앞 변경의 것(prev)을 그대로 둔다
 */
export function changedCriteria(before: readonly string[], after: readonly string[], prev: readonly string[] = []): string[] {
  const b = before.map(criterionKey);
  const a = after.map(criterionKey);
  if (a.length === b.length && a.every((k, i) => k === b[i])) return [...prev];
  const old = new Set(b);
  const kept = new Set(prev.map(criterionKey));
  return after.filter((_, i) => !old.has(a[i]!) || kept.has(a[i]!));
}

/**
 * 통과 판정이 통과 결과를 주지 않은 지금 완료 조건 (REV-03 완료 조건별 결과, 검수 규칙 '확인하지 못한 조건은 통과로 처리하지 않는다').
 * 조건은 같은 글(공백·번호를 정리해 비교)의 통과 결과로 덮이고, 같은 순서 자리의 통과 결과로도 덮인다 — 조건 글을 조금 바꿔 적은 결과를
 * 받기 위해서다. 다만 조건 변경에서 더해지거나 바뀐 뒤 아직 통과를 받지 않은 조건(changed — changedCriteria)은 같은 글의 결과로만 덮인다: 검수 세션은 차수를 넘어
 * 이어지므로 이전 목록을 보고 그 자리에 적은 결과(이전 조건을 제 말로 옮긴 것 포함)는 그 조건을 판정한 것이 아니다 (AC-43). 자리 결과의 글이
 * 다른 지금 조건과 같거나 이 작업의 이전 조건 글(former — 빠지거나 바뀐 조건)이면 그 조건의 결과이므로 이 조건을 덮지 않는다. 빈 글(공백·번호뿐)의
 * 결과는 아무 조건도 덮지 않는다. 남는 결과는 무시한다
 */
export function uncoveredCriteria(
  criteria: readonly string[],
  results: readonly CriterionResult[],
  former: readonly string[] = [],
  changed: readonly string[] = [],
): string[] {
  const keys = criteria.map(criterionKey);
  const current = new Set(keys);
  const formerKeys = new Set(former.map(criterionKey).filter((k) => k && !current.has(k)));
  const changedKeys = new Set(changed.map(criterionKey));
  const passed = new Set(
    results
      .filter((r) => r.pass)
      .map((r) => criterionKey(r.criterion))
      .filter(Boolean),
  );
  return criteria.filter((_, i) => {
    if (keys[i] && passed.has(keys[i]!)) return false;
    if (changedKeys.has(keys[i]!)) return true;
    const r = results[i];
    if (!r?.pass) return true;
    const k = criterionKey(r.criterion);
    return !k || formerKeys.has(k) || keys.some((other, j) => j !== i && other === k);
  });
}
