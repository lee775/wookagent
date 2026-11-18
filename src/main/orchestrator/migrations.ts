/**
 * 저장된 데이터를 v0.6 권한 모델로 옮긴다 (SERVER_DESIGN 2.7, 10.1 'DB 이전'). 앱을 시작할 때마다 돌고, 이미 옮긴 데이터에는 아무것도 하지 않는다 —
 * 중간에 꺼졌다 다시 시작해도 같은 결과가 된다. 기록(활동·상태 전이·aiDecision의 '대표가 정함')은 이력으로 그대로 둔다
 */
import type { Member, RoleCreator, Settings } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { mainCanReview } from '@core/reviewRules';
import type { Ctx } from './context';
import type { Core } from './core';
import { normalizeSettings, PRODUCER_SELF_REVIEW_LINE, roleCreatorOf } from './defaults';

/** v0.6 전 프로듀서 기본 지침의 문장 (이전 대상) */
const OLD_PRODUCER_SELF_REVIEW_LINE = '네가 직접 한 작업은 다른 팀원이나 대표가 검수한다.';

export function migrateOwnerPowers(ctx: Ctx): void {
  const changed: string[] = [];
  ctx.store.tx(() => {
    // 대표 고정(aiLockedByOwner) 값을 지운다 — 이제 팀원 AI는 메인 에이전트가 정한다. 누가 정했는지(aiDecision)는 이력으로 남긴다
    let unlocked = 0;
    for (const m of ctx.store.members.list()) {
      if (!Object.hasOwn(m, 'aiLockedByOwner')) continue;
      const { aiLockedByOwner: _dropped, ...rest } = m as Member & { aiLockedByOwner?: unknown };
      ctx.store.members.put(rest as Member);
      unlocked++;
    }
    if (unlocked) changed.push(`대표 AI 고정 값 ${unlocked}건 지움`);
    // 운영 설정의 '메인 에이전트가 AI를 정함' 켜기·끄기(team.mainAgentDecidesAi)를 지운다 — 늘 메인 에이전트가 정한다
    const saved = ctx.store.kv.get<Settings>('settings');
    if (saved?.team && Object.hasOwn(saved.team, 'mainAgentDecidesAi')) {
      ctx.saveSettings(normalizeSettings(saved));
      changed.push('운영 설정 team.mainAgentDecidesAi 지움');
    }
    // 프로듀서 기본 지침의 '네가 직접 한 작업은 … 대표가 검수한다'를 메인 에이전트 검수로 고친다 (REV-06 v0.6) — 기본 역할은 빈 DB에만 넣으므로
    // 예전 DB에는 옛 문장이 남는다. 그 문장이 그대로 있을 때만 바꾸고, 메인 에이전트가 고친 지침은 건드리지 않는다
    const producer = ctx.store.roles.get('producer');
    if (producer?.instructions.includes(OLD_PRODUCER_SELF_REVIEW_LINE)) {
      ctx.store.roles.put({ ...producer, instructions: producer.instructions.replace(OLD_PRODUCER_SELF_REVIEW_LINE, PRODUCER_SELF_REVIEW_LINE), updatedAt: ctx.now() });
      changed.push('프로듀서 기본 지침의 대표 검수 문장 고침');
    }
  });
  if (!changed.length) return;
  ctx.log('info', `데이터 이전 (v0.6 권한 모델): ${changed.join(', ')}`);
  ctx.activity({ kind: 'system', text: `데이터 이전 (v0.6 권한 모델): ${changed.join(', ')}` });
}

/**
 * 역할을 만든 쪽(Role.createdBy)을 채운다 (SERVER_DESIGN 7장, 리드 결정 S5-12) — 5단계 전에 저장된 역할에는 없다. 기본 역할은 'seed', 그 밖의 역할은
 * 만들 때 남은 활동 기록('역할 추가 <id> …')의 행위자로(메인 에이전트 → main, 운영자 → operator), 그 기록이 없으면 'owner' — 보관 기간보다 오래된
 * 역할은 대표가 역할을 만들던 v0.6 전의 것이다. 시작마다 돌고, 채운 역할은 다시 보지 않는다. 활동 기록은 이력으로 그대로 둔다
 */
export function backfillRoleCreators(ctx: Ctx): void {
  const filled: string[] = [];
  ctx.store.tx(() => {
    for (const r of ctx.store.roles.list()) {
      if (r.createdBy) continue;
      const prefix = `역할 추가 ${r.id} `;
      const row = r.builtin
        ? undefined
        : ctx.store.activity
            .search({ text: prefix, kinds: ['settings'], limit: 50 })
            .filter((e) => e.text.startsWith(prefix))
            .sort((a, b) => a.seq - b.seq)[0];
      const createdBy: RoleCreator = r.builtin ? 'seed' : row ? roleCreatorOf(row.actor) : 'owner';
      ctx.store.roles.put({ ...r, createdBy });
      filled.push(`${r.id} ${createdBy}`);
    }
  });
  if (!filled.length) return;
  const text = `데이터 이전 (역할 만든 쪽): ${filled.length}건 채움 — ${filled.join(', ')}`;
  ctx.log('info', text);
  ctx.activity({ kind: 'system', text });
}

/**
 * 대표 검수를 메인 에이전트 검수로 옮긴다 (SERVER_DESIGN 2.7·10.1 'DB 이전: 검수자 owner는 M-MAIN으로 바꾸고 검수 업무를 넣는다'). 끝나지 않은 작업 중 검수자가
 * 대표('owner')인 것은 M-MAIN으로 바꾼다 — M-MAIN이 그 작업의 기여자면 비워 두고 검수 등록 때 '검수자 없음'으로 보류한다. 검수 중이고 아직 통과하지 않은
 * 작업은 메인 에이전트의 검수 세션(review:T)에 검수 업무를 넣는다(보류 중인 작업은 풀릴 때 넣는다). 남아 있던 '대표 검수 요청' 알림은 읽음으로 둔다.
 * 끝난 작업의 검수자 칸과 판정 기록(검수자 'owner')은 이력으로 둔다. 한 트랜잭션이고, 옮긴 뒤에는 대상이 없어 다시 시작해도 아무것도 하지 않는다.
 * M-MAIN이 있어야 하므로 ensureMainAgent 뒤, 재시작 복구 전에 부른다
 */
export function migrateOwnerReviewers(core: Core): void {
  const ctx = core.ctx;
  const moved: string[] = [];
  ctx.store.tx(() => {
    for (const t of ctx.store.tasks.list({ state: ['waiting', 'in_progress', 'in_review', 'on_hold'] })) {
      if (t.reviewerId !== OWNER) continue;
      ctx.store.tasks.patch(t.id, { reviewerId: mainCanReview(t) ? MAIN_AGENT_ID : null });
      for (const n of ctx.store.notifications.list({ ref1: `owner-review:${t.id}`, state: 'unread' })) ctx.store.notifications.put({ ...n, readAt: ctx.now() });
      const cur = ctx.store.tasks.require(t.id);
      if (cur.state === 'in_review' && !cur.review.passed) core.tasks.dispatchReview(cur);
      moved.push(t.id);
    }
  });
  if (!moved.length) return;
  const text = `데이터 이전 (v0.6 권한 모델): 대표 검수 작업 ${moved.length}건 → 메인 에이전트 검수 (${moved.join(', ')})`;
  ctx.log('info', text);
  ctx.activity({ kind: 'review', text });
}

/** 팀원 이름을 사람 이름으로 바꿨다는 기록 (kv) — 데이터 폴더마다 한 번 */
export const PERSON_NAMES_KEY = 'names.person.v1';

/**
 * 사람 이름이 아닌 팀원 이름("코덱스 개발1" 등)을 사람 이름으로 바꾼다 (대표 지시 2026-11-16, team.renameLabelNames). 이 규칙이 생기기 전의 데이터 폴더를
 * 처음 열 때 한 번만 한다 — 한 뒤에는 kv에 적어 두고 다시 보지 않는다. 그 뒤에 운영자(내부 API)가 붙인 이름은 건드리지 않는다. 지금부터 메인 에이전트가
 * 짓는 이름은 추가·변경 때 바로 본다 (team.uniqueName·renamed)
 */
export function migratePersonNames(core: Core): void {
  const ctx = core.ctx;
  if (ctx.store.kv.get(PERSON_NAMES_KEY)) return;
  const renamed = core.team.renameLabelNames();
  ctx.store.kv.set(PERSON_NAMES_KEY, { at: ctx.now(), renamed: renamed.length });
  if (renamed.length) ctx.log('info', `데이터 이전 (팀원 이름): ${renamed.length}명의 이름을 사람 이름으로 바꿈`);
}

/** 모델이 정해지지 않은 팀원의 모델 결정을 메인 에이전트에게 요청했다는 기록 (kv) — 데이터 폴더마다 한 번 */
export const MODEL_DECISIONS_KEY = 'ai.model.v1';

/**
 * 모델이 정해지지 않은 팀원('CLI 기본 모델')의 모델을 메인 에이전트가 정하도록 요청한다 (대표 지시 2026-11-18, team.requestMissingModels). 메인이 팀원
 * AI를 정할 때 모델도 꼭 정하는 규칙이 생기기 전의 데이터 폴더를 처음 열 때 한 번만 한다 — 프로그램이 모델을 고르지 않는다(팀원 AI는 메인이 정한다).
 * 지금부터 추가하는 팀원은 추가할 때의 결정 요청과 set_member_ai의 검사로 모델이 정해진다
 */
export function migrateModelDecisions(core: Core): void {
  const ctx = core.ctx;
  if (ctx.store.kv.get(MODEL_DECISIONS_KEY)) return;
  const asked = core.team.requestMissingModels();
  ctx.store.kv.set(MODEL_DECISIONS_KEY, { at: ctx.now(), asked: asked.length });
  if (!asked.length) return;
  const text = `데이터 이전 (팀원 모델): 모델이 정해지지 않은 팀원 ${asked.length}명의 모델을 정하도록 메인 에이전트에게 요청 — ${asked.map((m) => `${m.name}(${m.id})`).join(', ')}`;
  ctx.log('info', text);
  ctx.activity({ kind: 'system', text });
}
