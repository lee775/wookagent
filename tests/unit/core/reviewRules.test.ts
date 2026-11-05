/**
 * 검수 자격·기본 검수자 — 기획서 REV-02·03·06, 4.2 역할 표(검수 권한), CLI-08, AC-09·32·38·39.
 */
import { describe, expect, it } from 'vitest';
import type { Member, Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { canBeReviewer, canSubmitReview, chooseReviewer } from '@core/reviewRules';
import { lcg, mainAgent, makeMember, makeTask, ROLES, roleOf, T0 } from './fixtures';

const PD = makeMember('M-PD', 'producer');
const DEV = makeMember('M-DEV', 'developer');
const DEV2 = makeMember('M-DEV2', 'developer');
const QA = makeMember('M-QA', 'qa');
const QA2 = makeMember('M-QA0', 'qa');
const ARCH = makeMember('M-ARCH', 'architect');
const PLAN = makeMember('M-PLAN', 'planner');
const UI = makeMember('M-UI', 'ui_designer');
const DOCS = makeMember('M-DOCS', 'docs');
const CUST = makeMember('M-CUST', 'role-0001'); // 사용자 정의 역할, 검수 권한 있음
const CUSTNO = makeMember('M-CUSTNO', 'role-0002'); // 사용자 정의 역할, 검수 권한 없음
const OTHER_QA = makeMember('M-OQA', 'qa', { projectId: 'P-0002' });
const DEL_QA = makeMember('M-DQA', 'qa', { deletedAt: T0 });
const MAIN = mainAgent();

const TEAM: Member[] = [PD, DEV, DEV2, QA, ARCH, PLAN, UI, DOCS, CUST, CUSTNO, OTHER_QA, DEL_QA, MAIN];
const task = (over: Partial<Task> = {}) => makeTask({ assigneeId: 'M-DEV', contributors: ['M-DEV'], ...over });

describe('4.2 역할 표의 검수 권한 열', () => {
  it.each([
    ['producer', true],
    ['planner', false],
    ['architect', true],
    ['developer', false],
    ['ui_designer', false],
    ['qa', true],
    ['docs', false],
  ] as const)('%s → %s', (id, can) => {
    expect(ROLES[id]!.canReview).toBe(can);
  });
});

describe('canBeReviewer — REV-02: 작업자·실질 수정 참여자 제외, 검수 권한 역할(또는 프로듀서)만', () => {
  const table: { who: Member; t: Task; ok: boolean; why: string }[] = [
    { who: PD, t: task(), ok: true, why: '프로듀서 (본인 작업 아님)' },
    { who: QA, t: task(), ok: true, why: 'QA' },
    { who: ARCH, t: task(), ok: true, why: '설계자' },
    { who: CUST, t: task(), ok: true, why: '검수 권한 있는 사용자 정의 역할' },
    { who: DEV, t: task(), ok: false, why: '작업자 본인' },
    { who: DEV2, t: task(), ok: false, why: '검수 권한 없는 개발자' },
    { who: PLAN, t: task(), ok: false, why: '기획자' },
    { who: UI, t: task(), ok: false, why: 'UI 디자이너' },
    { who: DOCS, t: task(), ok: false, why: '문서 담당' },
    { who: CUSTNO, t: task(), ok: false, why: '검수 권한 없는 사용자 정의 역할' },
    { who: OTHER_QA, t: task(), ok: false, why: '다른 프로젝트 QA' },
    { who: DEL_QA, t: task(), ok: false, why: '삭제된 팀원' },
    { who: MAIN, t: task(), ok: true, why: '메인 에이전트 — 적격 팀원이 없을 때의 대체 검수자 (REV-06 v0.6)' },
    { who: MAIN, t: task({ contributors: ['M-DEV', MAIN_AGENT_ID] }), ok: false, why: '그 작업에 기여한 메인 에이전트' },
    { who: QA, t: task({ contributors: ['M-DEV', 'M-QA'] }), ok: false, why: '충돌 해결 등 실질 수정 참여자 QA (GIT-07)' },
    { who: PD, t: task({ assigneeId: 'M-PD', contributors: ['M-PD'] }), ok: false, why: '프로듀서 본인 작업 (REV-06)' },
    { who: PD, t: task({ contributors: ['M-DEV', 'M-PD'] }), ok: false, why: '충돌을 해결한 프로듀서' },
    { who: ARCH, t: task({ assigneeId: 'M-DEV2', contributors: ['M-DEV', 'M-DEV2'] }), ok: true, why: '재배정된 작업의 제3자' },
    { who: DEV, t: task({ assigneeId: 'M-DEV2', contributors: ['M-DEV', 'M-DEV2'] }), ok: false, why: '재배정 전 작업자' },
  ];

  it.each(table)('$why → $ok', ({ who, t, ok }) => {
    const r = canBeReviewer(who, roleOf(who.roleId), t);
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.reason).not.toBe('');
  });
});

describe('canSubmitReview — REV-03 / CLI-08: 권한 + 배정 + 본인 아님을 모두 (AC-32·38)', () => {
  const table: { name: string; who: Member; t: Task; ok: boolean }[] = [
    { name: '배정된 QA → 등록 가능', who: QA, t: task({ reviewerId: 'M-QA' }), ok: true },
    { name: '배정된 설계자 → 등록 가능', who: ARCH, t: task({ reviewerId: 'M-ARCH' }), ok: true },
    { name: '배정된 프로듀서 → 등록 가능', who: PD, t: task({ reviewerId: 'M-PD' }), ok: true },
    { name: '권한은 있지만 미배정 QA → 거부 (AC-38)', who: QA, t: task({ reviewerId: 'M-ARCH' }), ok: false },
    { name: '옛 대표 검수 작업(검수자 owner, 이력)에 팀원이 등록 → 거부', who: PD, t: task({ reviewerId: OWNER }), ok: false },
    { name: '메인 에이전트가 검수자로 배정됨 → 등록 가능 (REV-06 v0.6)', who: MAIN, t: task({ reviewerId: MAIN_AGENT_ID }), ok: true },
    { name: '메인 에이전트에게 배정되지 않은 작업 → 거부', who: MAIN, t: task({ reviewerId: 'M-QA' }), ok: false },
    { name: '검수자 미정 → 거부', who: QA, t: task({ reviewerId: null }), ok: false },
    { name: '작업자 본인이 검수자로 잘못 배정 → 거부 (AC-09)', who: DEV, t: task({ reviewerId: 'M-DEV' }), ok: false },
    { name: '배정 후 실질 수정 참여자가 됨 → 거부', who: QA, t: task({ reviewerId: 'M-QA', contributors: ['M-DEV', 'M-QA'] }), ok: false },
    { name: '권한 없는 역할이 배정됨 → 거부', who: DEV2, t: task({ reviewerId: 'M-DEV2' }), ok: false },
    { name: '다른 프로젝트 팀원이 배정됨 → 거부', who: OTHER_QA, t: task({ reviewerId: 'M-OQA' }), ok: false },
    { name: '삭제된 팀원 → 거부', who: DEL_QA, t: task({ reviewerId: 'M-DQA' }), ok: false },
  ];

  it.each(table)('$name', ({ who, t, ok }) => {
    expect(canSubmitReview(who, roleOf(who.roleId), t).ok).toBe(ok);
  });
});

describe('chooseReviewer — 기본 검수자 프로듀서 → QA → 설계자 → 사용자 정의 → 메인 에이전트 (REV-02·06 v0.6, AC-39)', () => {
  const table: { name: string; team: Member[]; t: Task; exclude?: string[]; expected: string }[] = [
    { name: '기본은 프로듀서', team: TEAM, t: task(), expected: 'M-PD' },
    { name: '프로듀서 본인 작업 → QA', team: TEAM, t: task({ assigneeId: 'M-PD', contributors: ['M-PD'] }), expected: 'M-QA' },
    {
      name: '프로듀서 본인 작업, QA 없음 → 설계자',
      team: TEAM.filter((m) => m !== QA),
      t: task({ assigneeId: 'M-PD', contributors: ['M-PD'] }),
      expected: 'M-ARCH',
    },
    {
      name: '프로듀서 본인 작업, QA·설계자 없음 → 사용자 정의 검수 역할',
      team: TEAM.filter((m) => m !== QA && m !== ARCH),
      t: task({ assigneeId: 'M-PD', contributors: ['M-PD'] }),
      expected: 'M-CUST',
    },
    {
      name: '프로듀서 본인 작업, 적격 팀원 없음 → 메인 에이전트 (자동 통과·본인 검수 없음)',
      team: [PD, DEV, DEV2, PLAN, UI, DOCS, CUSTNO, OTHER_QA, DEL_QA, MAIN],
      t: task({ assigneeId: 'M-PD', contributors: ['M-PD'] }),
      expected: MAIN_AGENT_ID,
    },
    { name: '충돌을 해결한 프로듀서는 제외 → QA', team: TEAM, t: task({ contributors: ['M-DEV', 'M-PD'] }), expected: 'M-QA' },
    {
      name: '프로듀서·QA 모두 실질 수정 참여 → 설계자',
      team: TEAM,
      t: task({ assigneeId: 'M-PD', contributors: ['M-PD', 'M-QA'] }),
      expected: 'M-ARCH',
    },
    { name: '제외 목록의 프로듀서 → QA', team: TEAM, t: task(), exclude: ['M-PD'], expected: 'M-QA' },
    {
      name: 'QA 둘이면 ID 순',
      team: [PD, DEV, QA, QA2],
      t: task({ assigneeId: 'M-PD', contributors: ['M-PD'] }),
      expected: 'M-QA',
    },
    {
      name: '삭제·다른 프로젝트 QA는 후보 아님',
      team: [PD, DEV, DEL_QA, OTHER_QA, ARCH],
      t: task({ assigneeId: 'M-PD', contributors: ['M-PD'] }),
      expected: 'M-ARCH',
    },
    {
      name: 'QA 작업자 → 프로듀서',
      team: TEAM,
      t: task({ assigneeId: 'M-QA', contributors: ['M-QA'] }),
      expected: 'M-PD',
    },
  ];

  it.each(table)('$name → $expected', ({ team, t, exclude, expected }) => {
    expect(chooseReviewer(t, team, roleOf, exclude)).toBe(expected);
  });

  it('메인 에이전트도 그 작업의 기여자면 아무도 고르지 않는다 (null — 보류하고 메인에게 검수자 없음)', () => {
    const t = task({ assigneeId: 'M-PD', contributors: ['M-PD', MAIN_AGENT_ID] });
    expect(chooseReviewer(t, [PD, DEV, DEV2, MAIN], roleOf)).toBeNull();
    expect(chooseReviewer(t, [PD, DEV, QA, MAIN], roleOf)).toBe('M-QA');
  });

  it('무작위 팀 300개: 결과는 항상 적격 팀원이거나, 적격 팀원이 하나도 없을 때만 메인 에이전트(메인도 기여자면 null)', () => {
    const rnd = lcg(42);
    const pool = [PD, DEV, DEV2, QA, QA2, ARCH, PLAN, UI, DOCS, CUST, CUSTNO, OTHER_QA, DEL_QA, MAIN];
    for (let i = 0; i < 300; i++) {
      const team = pool.filter(() => rnd() < 0.6);
      const inProject = pool.filter((m) => m.projectId === 'P-0001' && !m.deletedAt);
      const assignee = inProject[Math.floor(rnd() * inProject.length)]!;
      const contributors = [assignee.id, ...inProject.filter(() => rnd() < 0.2).map((m) => m.id)];
      const t = task({ assigneeId: assignee.id, contributors: [...new Set(contributors)] });
      const chosen = chooseReviewer(t, team, roleOf);
      const eligible = team.filter((m) => !m.isMain && canBeReviewer(m, roleOf(m.roleId), t).ok);
      if (chosen === MAIN_AGENT_ID || chosen === null) {
        expect(eligible).toEqual([]);
        expect(chosen === null).toBe(t.contributors.includes(MAIN_AGENT_ID));
      } else {
        const m = team.find((x) => x.id === chosen)!;
        expect(canBeReviewer(m, roleOf(m.roleId), t).ok).toBe(true);
        expect(t.contributors).not.toContain(chosen);
        expect(chosen).not.toBe(t.assigneeId);
        // 프로듀서가 적격이면 항상 프로듀서
        if (eligible.some((x) => x.isProducer)) expect(m.isProducer).toBe(true);
      }
    }
  });
});
