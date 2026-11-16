/**
 * 메인 에이전트 운영 도구 (SERVER_DESIGN 2.6, 10.1 mainControlTools).
 * - 도구마다 옛 대표 메서드와 같은 상태 전이와 기록을 낸다 — 행위자만 M-MAIN. 같은 준비를 한 두 환경에서 한쪽은 옛 대표 처리기(createApi(core),
 *   게이트 없이)로, 다른 쪽은 메인 도구로 같은 순서를 밟고, 단계마다 새로 생긴 상태 전이·활동 기록·결과 상태를 견준다(행위자·행위자 이름만 맞춘다)
 * - 메인 쪽에는 사유 기록(행위자 M-MAIN)이 한 줄 더 남고, 눈에 띄는 조작은 대표에게 정보 알림이 간다
 * - 긴급 정지 중에는 모두 'stopped'로 거부되고 아무것도 바뀌지 않는다. 같은 request_id는 한 번만 반영된다. 사유가 없거나 메인이 아니면 거부된다
 * - update_settings는 허용 항목만 받는다 (계정·구글·CLI 위치·메인 AI·개발자 옵션은 거부)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityEntry, ExecRecord, StopState, Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { RoleInput } from '@shared/ipc';
import { createApi, type ApiHandlers } from '../../src/main/orchestrator/api';
import { MAIN_SETTINGS } from '../../src/main/orchestrator/settingsPolicy';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective } from './orchHarness';

interface Pair {
  owner: OrchEnv;
  main: OrchEnv;
  ownerApi: ApiHandlers;
}

let pair: Pair | null = null;
const shared: { directiveId: string; t1: string; t2: string; t3: string; recovery: string } = { directiveId: '', t1: '', t2: '', t3: '', recovery: '' };

/** 두 환경에 같은 준비: 지시 하나, 작업 셋(개발자 T1·QA T2·개발자 T3 — T3은 복구 확인 보류) */
function seed(e: OrchEnv): typeof shared {
  const d = seedDirective(e, '운영 도구 대조 지시');
  const mk = (title: string, assigneeId: string) =>
    e.core.tasks.create({ directiveId: d.id, title, goal: title, type: 'development', assigneeId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId).id;
  const t1 = mk('개발 작업', e.devId);
  const t2 = mk('검사 작업', e.qaId);
  const t3 = mk('복구 확인 작업', e.devId);
  // 팀원 중단은 활성 작업 단위다 — QA의 작업을 활성으로 둔다 (턴 없이)
  e.ctx.store.tasks.patch(t2, { activatedAt: e.ctx.now() });
  const recovery = 'RQ-mct-0001';
  const exec: ExecRecord = {
    requestId: recovery,
    kind: 'git_push',
    projectId: e.projectId,
    taskId: t3,
    cwd: e.projectDir,
    command: 'git push origin main',
    target: 'origin',
    state: 'unknown',
    startedAt: e.ctx.now(),
    endedAt: null,
    result: { recovered: 'unclear' },
  };
  e.ctx.store.execs.insert(exec);
  e.core.tasks.hold(t3, 'recovery_check', 'task', '외부 실행이 끝났는지 확인할 수 없습니다', 'system', recovery);
  return { directiveId: d.id, t1, t2, t3, recovery };
}

beforeAll(async () => {
  const owner = await bootOrch();
  const main = await bootOrch();
  const a = seed(owner);
  const b = seed(main);
  expect(b).toEqual(a); // 두 환경의 ID가 같다 — 단계별 대조의 전제
  Object.assign(shared, a);
  pair = { owner, main, ownerApi: createApi(owner.core) };
}, 120_000);

afterAll(async () => {
  await pair?.owner.close();
  await pair?.main.close();
});

/** 두 환경을 견줄 수 있게: 행위자(대표·메인 에이전트)와 그 이름, 임시 폴더, 시각을 같은 표시로 */
function normalizer(e: OrchEnv) {
  const roots = [e.dataDir, e.projectDir].map((p) => p.replace(/\\/g, '\\\\'));
  return (v: unknown): unknown =>
    JSON.parse(
      roots
        .reduce((s, r) => s.split(r).join('<DIR>'), JSON.stringify(v))
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}[.-]\d{3}Z/g, '<TIME>')
        .replace(/M-MAIN|\bowner\b/g, '<ACTOR>')
        .replace(/대표|메인 에이전트/g, '<ACTOR>'),
    );
}

const isReasonRow = (r: ActivityEntry) => r.actor === MAIN_AGENT_ID && / \([a-z_]+\) — 사유: /.test(r.text);

interface Mark {
  seq: number;
  transitions: number;
}

function mark(e: OrchEnv): Mark {
  const all = [shared.t1, shared.t2, shared.t3, shared.directiveId].flatMap((id) => e.ctx.store.transitions.list(id));
  return { seq: e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0, transitions: Math.max(0, ...all.map((t) => t.seq)) };
}

function since(e: OrchEnv, m: Mark) {
  const rows = e.ctx.store.activity
    .search({ limit: 500 })
    .filter((r) => r.seq > m.seq)
    .sort((x, y) => x.seq - y.seq);
  const transitions = [shared.t1, shared.t2, shared.t3, shared.directiveId]
    .flatMap((id) => e.ctx.store.transitions.list(id))
    .filter((t) => t.seq > m.transitions)
    .sort((x, y) => x.seq - y.seq)
    .map(({ entity, entityId, from, event, to, reason, actor }) => ({ entity, entityId, from, event, to, reason, actor }));
  return { rows, transitions };
}

/** 상태 대조용 요약 (도구 결과와 상관없이 저장된 상태) */
function state(e: OrchEnv) {
  const t = (id: string): Pick<Task, 'state' | 'reviewerId' | 'assigneeId'> & { holds: string[] } => {
    const x = e.ctx.store.tasks.require(id);
    return { state: x.state, reviewerId: x.reviewerId, assigneeId: x.assigneeId, holds: x.hold.reasons.map((r) => `${r.kind}/${r.scope}/${r.by}/${r.note}`) };
  };
  const stop: StopState = e.ctx.stop();
  const strip = (s: StopState) => ({
    global: s.global.active,
    projects: Object.fromEntries(Object.entries(s.projects).map(([k, v]) => [k, { paused: v.paused, mode: v.mode, by: v.by }])),
    members: Object.fromEntries(Object.entries(s.members).map(([k, v]) => [k, { paused: v.paused, mode: v.mode, by: v.by }])),
  });
  const s = e.ctx.settings();
  return {
    tasks: [shared.t1, shared.t2, shared.t3].map(t),
    directive: e.ctx.store.directives.require(shared.directiveId).state,
    stop: strip(stop),
    project: (({ name, checkCommands, networkPolicy, deploy, producerId }) => ({ name, checkCommands, networkPolicy, deploy, producerId }))(e.ctx.store.projects.require(e.projectId)),
    members: e.ctx.store.members.list().map((m) => ({ id: m.id, name: m.name, roleId: m.roleId, isProducer: m.isProducer, deleted: !!m.deletedAt, replacedById: m.replacedById })),
    roles: e.ctx.store.roles.list().map((r) => ({ id: r.id, name: r.name, canReview: r.canReview, taskTypes: r.taskTypes, allowedSkills: r.allowedSkills, defaultAi: r.defaultAi })),
    settings: { execution: s.execution, skills: s.skills, effortMapping: s.team.effortMapping, backupKeep: s.general.backup.keep },
    exec: (({ state: st, result }) => ({ state: st, result }))(e.ctx.store.execs.require(shared.recovery)),
  };
}

interface Step {
  tool: string;
  args: () => Record<string, unknown>;
  owner: (api: ApiHandlers) => unknown;
  /** 대표에게 정보 알림이 가는 조작인지 (2.6 '일시정지·취소·역할·설정처럼 눈에 띄는 조작') */
  notifies: boolean;
}

const sound: RoleInput = {
  name: '사운드',
  instructions: '효과음과 배경음을 만든다',
  taskTypes: ['design', 'research'],
  allowedSkills: [],
  defaultAi: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null },
  canReview: false,
};

const pid = () => pair!.main.projectId;
const STEPS: Step[] = [
  {
    tool: 'update_project',
    args: () => ({ project_id: pid(), name: '운영 도구 프로젝트', check_commands: ['node --version'], network_policy: 'restricted' }),
    owner: (api) => api['projects.update'](pid(), { name: '운영 도구 프로젝트', checkCommands: ['node --version'], networkPolicy: 'restricted' }),
    notifies: true,
  },
  { tool: 'pause_project', args: () => ({ project_id: pid(), mode: 'immediate' }), owner: (api) => api['projects.pause'](pid(), 'immediate'), notifies: true },
  { tool: 'resume_project', args: () => ({ project_id: pid() }), owner: (api) => api['projects.resume'](pid()), notifies: true },
  { tool: 'pause_member', args: () => ({ member_id: pair!.main.devId, mode: 'graceful' }), owner: (api) => api['members.pause'](pair!.owner.devId, 'graceful'), notifies: true },
  { tool: 'resume_member', args: () => ({ member_id: pair!.main.devId }), owner: (api) => api['members.resume'](pair!.owner.devId), notifies: true },
  { tool: 'interrupt_task', args: () => ({ task_id: shared.t1, then: 'hold' }), owner: (api) => api['tasks.interrupt'](shared.t1, 'hold'), notifies: true },
  { tool: 'resume_task', args: () => ({ task_id: shared.t1 }), owner: (api) => api['tasks.resume'](shared.t1), notifies: false },
  { tool: 'interrupt_member', args: () => ({ member_id: pair!.main.qaId, then: 'hold' }), owner: (api) => api['members.interrupt'](pair!.owner.qaId, 'hold'), notifies: true },
  { tool: 'resume_task', args: () => ({ task_id: shared.t2 }), owner: (api) => api['tasks.resume'](shared.t2), notifies: false },
  { tool: 'resolve_recovery', args: () => ({ recovery_id: shared.recovery, action: 'retry' }), owner: (api) => api['recovery.resolve'](shared.recovery, 'retry'), notifies: false },
  { tool: 'cancel_task', args: () => ({ task_id: shared.t2 }), owner: (api) => api['tasks.cancel'](shared.t2), notifies: true },
  { tool: 'update_member', args: () => ({ member_id: pair!.main.devId, name: '새이름' }), owner: (api) => api['members.update'](pair!.owner.devId, { name: '새이름' }), notifies: false },
  { tool: 'replace_producer', args: () => ({ project_id: pid(), name: '민서' }), owner: (api) => api['members.replaceProducer'](pid(), { name: '민서' }), notifies: true },
  { tool: 'cancel_directive', args: () => ({ directive_id: shared.directiveId }), owner: (api) => api['directives.cancel'](shared.directiveId), notifies: true },
  {
    tool: 'update_settings',
    args: () => ({ patch: { execution: { maxConcurrent: 3, preventSleep: false }, general: { backup: { keep: 3 } } } }),
    owner: (api) => api['settings.update']({ execution: { maxConcurrent: 3, preventSleep: false }, general: { backup: { keep: 3 } } }),
    notifies: true,
  },
  { tool: 'set_skill_mode', args: () => ({ name: 'some-skill', mode: 'manual' }), owner: (api) => api['skills.setMode']('some-skill', 'manual'), notifies: true },
  {
    tool: 'create_role',
    args: () => ({ name: '사운드', instructions: sound.instructions, task_types: sound.taskTypes, default_ai: { kind: 'claude', model: null, effort_tier: 'normal' }, allowed_skills: [], can_review: false }),
    owner: (api) => api['roles.create'](sound),
    notifies: true,
  },
  {
    tool: 'update_role',
    args: () => ({ role_id: 'role-0001', instructions: '효과음·배경음·음성 안내를 만든다', allowed_skills: ['some-skill'] }),
    owner: (api) => api['roles.update']('role-0001', { ...sound, instructions: '효과음·배경음·음성 안내를 만든다', allowedSkills: ['some-skill'] }),
    notifies: true,
  },
  { tool: 'delete_role', args: () => ({ role_id: 'role-0001' }), owner: (api) => api['roles.delete']('role-0001'), notifies: true },
  { tool: 'recheck_ai', args: () => ({ kind: 'codex' }), owner: (api) => api['system.recheckAi']('codex'), notifies: false },
  { tool: 'backup_now', args: () => ({}), owner: (api) => api['system.backupNow'](), notifies: false },
];

describe('메인 운영 도구 = 옛 대표 메서드 (행위자만 M-MAIN)', () => {
  it.each(STEPS.map((s, i) => [`${i + 1}. ${s.tool}`, s] as const))('%s', async (_label, step) => {
    const { owner, main, ownerApi } = pair!;
    const mo = mark(owner);
    const mm = mark(main);
    await step.owner(ownerApi);
    const notesBefore = main.ctx.store.notifications.list().filter((n) => n.title === '메인 에이전트 조작').length;
    const reason = `대표 명령 처리: ${step.tool}`;
    await main.main(step.tool, { ...step.args(), reason, request_id: `rq-${step.tool}-${mm.seq}` });
    await new Promise((r) => setTimeout(r, 30)); // 비동기 후속 처리(턴 정리 등)가 기록을 마치도록

    const o = since(owner, mo);
    const m = since(main, mm);
    // 같은 상태 전이 (행위자만 다름)
    expect(normalizer(main)(m.transitions), '상태 전이').toEqual(normalizer(owner)(o.transitions));
    for (const t of m.transitions) expect([MAIN_AGENT_ID, 'system']).toContain(t.actor);
    expect(m.transitions.filter((t) => t.actor === MAIN_AGENT_ID).length).toBe(o.transitions.filter((t) => t.actor === OWNER).length);
    // 같은 활동 기록 + 메인 쪽 사유 한 줄
    const strip = (rows: ActivityEntry[]) => rows.map(({ kind, level, actor, projectId, taskId, memberId, directiveId, text, result }) => ({ kind, level, actor, projectId, taskId, memberId, directiveId, text, result }));
    expect(normalizer(main)(strip(m.rows.filter((r) => !isReasonRow(r)))), '활동 기록').toEqual(normalizer(owner)(strip(o.rows)));
    for (const r of m.rows.filter((x) => !isReasonRow(x))) expect(r.actor, r.text).not.toBe(OWNER);
    const reasons = m.rows.filter(isReasonRow);
    expect(reasons, '사유 기록').toHaveLength(1);
    expect(reasons[0]).toMatchObject({ actor: MAIN_AGENT_ID, level: 'info' });
    expect(reasons[0]!.text).toContain(`(${step.tool}) — 사유: ${reason}`);
    // 같은 결과 상태
    expect(normalizer(main)(state(main)), '결과 상태').toEqual(normalizer(owner)(state(owner)));
    // 대표 정보 알림 (같은 대상의 읽지 않은 알림은 새 내용으로 갱신된다)
    const mine = main.ctx.store.notifications.list().filter((n) => n.title === '메인 에이전트 조작' && n.body.includes(reason));
    if (step.notifies) {
      expect(mine, '정보 알림').toHaveLength(1);
      expect(mine[0]).toMatchObject({ level: 'info' });
    } else {
      expect(mine, '알림 없음').toEqual([]);
      expect(main.ctx.store.notifications.list().filter((n) => n.title === '메인 에이전트 조작')).toHaveLength(notesBefore);
    }
  });
});

describe('메인 운영 도구의 공통 규칙', () => {
  let e: OrchEnv | null = null;
  afterAll(async () => {
    await e?.close();
  });

  it('긴급 정지 중에는 상태를 바꾸는 운영 도구가 모두 stopped로 거부되고 아무것도 바뀌지 않는다 (조회 도구는 된다)', async () => {
    e = await bootOrch();
    const env = e;
    const d = seedDirective(env);
    const t = env.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: env.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, env.producerId);
    await env.invoke('stop.emergency');
    const before = JSON.stringify({ stop: env.ctx.stop(), tasks: env.ctx.store.tasks.list(), members: env.ctx.store.members.list(), roles: env.ctx.store.roles.list(), settings: env.ctx.settings(), project: env.ctx.store.projects.list() });
    const calls: [string, Record<string, unknown>][] = [
      ['update_project', { project_id: env.projectId, name: 'x' }],
      ['pause_project', { project_id: env.projectId, mode: 'graceful' }],
      ['resume_project', { project_id: env.projectId }],
      ['update_member', { member_id: env.devId, name: 'x' }],
      ['replace_producer', { project_id: env.projectId }],
      ['pause_member', { member_id: env.devId, mode: 'graceful' }],
      ['resume_member', { member_id: env.devId }],
      ['interrupt_member', { member_id: env.devId, then: 'hold' }],
      ['interrupt_task', { task_id: t.id, then: 'hold' }],
      ['resume_task', { task_id: t.id }],
      ['cancel_task', { task_id: t.id }],
      ['cancel_directive', { directive_id: d.id }],
      ['resolve_recovery', { recovery_id: 'RQ-x', action: 'retry' }],
      ['update_settings', { patch: { execution: { maxConcurrent: 2 } } }],
      ['set_skill_mode', { name: 'x', mode: 'manual' }],
      ['create_role', { name: '사운드', instructions: '', task_types: ['design'], default_ai: { kind: 'claude', effort_tier: 'normal' }, can_review: false }],
      ['update_role', { role_id: 'docs', instructions: 'x' }],
      ['delete_role', { role_id: 'docs' }],
      ['recheck_ai', { kind: 'claude' }],
      ['backup_now', {}],
    ];
    for (const [tool, args] of calls) await expect(env.main(tool, args), tool).rejects.toMatchObject({ code: 'stopped' });
    expect(JSON.stringify({ stop: env.ctx.stop(), tasks: env.ctx.store.tasks.list(), members: env.ctx.store.members.list(), roles: env.ctx.store.roles.list(), settings: env.ctx.settings(), project: env.ctx.store.projects.list() })).toBe(before);
    // 조회는 된다
    expect(Array.isArray(await env.main('list_roles'))).toBe(true);
    expect(Array.isArray(await env.main('search_activity', { text: '긴급 정지' }))).toBe(true);
    // 해제는 대표 몫 — 해제 뒤에는 메인이 항목별로 재개한다
    await env.invoke('stop.release');
    await env.main('resume_task', { task_id: t.id });
    expect(env.ctx.store.tasks.require(t.id).state).not.toBe('on_hold');
  });

  it('같은 request_id는 한 번만 반영되고, 사유가 없거나 메인이 아닌 호출자는 거부된다', async () => {
    await e?.close();
    e = await bootOrch();
    const env = e;
    const first = await env.main('pause_member', { member_id: env.devId, mode: 'graceful', request_id: 'rq-same' });
    expect(first.duplicateRequest).toBeUndefined();
    const again = await env.main('pause_member', { member_id: env.devId, mode: 'graceful', request_id: 'rq-same' });
    expect(again.duplicateRequest).toBe(true);
    expect(env.ctx.store.activity.search({ text: '일시정지 (단계 마치고)' }).filter((r) => r.actor === MAIN_AGENT_ID && !isReasonRow(r))).toHaveLength(1);
    expect(env.ctx.store.activity.search({ text: '사유:' }).filter(isReasonRow)).toHaveLength(1);
    // 사유 없음
    await expect(env.main('resume_member', { member_id: env.devId, reason: '  ' })).rejects.toMatchObject({ code: 'invalid' });
    expect(env.ctx.stop().members[env.devId]?.paused).toBe(true);
    // 메인이 아닌 호출자 (프로듀서 토큰으로 처리기를 바로 부름 — 도구 서버는 역할로 먼저 거른다)
    const producer = env.ctx.store.members.require(env.producerId);
    const asProducer = await env.core.tools.handle(
      { turnId: 'TN-p', sessionId: 'S-p', sessionKey: 'directive:D-0001', sessionKind: 'directive', memberId: producer.id, projectId: env.projectId, isMain: false, isProducer: true, canReview: true },
      'resume_member',
      { member_id: env.devId, reason: '프로듀서가 풀어 봄' },
    );
    expect(asProducer).toMatchObject({ ok: false, code: 'forbidden' });
    expect(env.ctx.stop().members[env.devId]?.paused).toBe(true);
    // 메인 에이전트 자신은 일시정지·중단하지 않는다 (풀 도구를 쓸 수 없게 된다)
    await expect(env.main('pause_member', { member_id: MAIN_AGENT_ID, mode: 'graceful' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(env.main('interrupt_member', { member_id: MAIN_AGENT_ID, then: 'hold' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('update_settings는 허용 항목만 받는다 — 계정·구글·CLI 위치·메인 AI·개발자 옵션·로그 보관은 거부하고 아무것도 바꾸지 않는다', async () => {
    await e?.close();
    e = await bootOrch();
    const env = e;
    const before = JSON.stringify(env.ctx.settings());
    const refused: Record<string, unknown>[] = [
      { account: { googleClientId: '1-abc.apps.googleusercontent.com' } },
      { cli: { claudePath: 'C:\\evil\\claude.exe' } },
      { general: { mainAgent: { kind: 'codex' } } },
      { developer: { mainAgentMock: true } },
      { logs: { retentionDays: 1 } },
      { execution: { maxConcurrent: 4 }, policy: { emergencyShortcut: 'F1' } },
      { team: { mainAgentDecidesAi: false } },
    ];
    for (const patch of refused) await expect(env.main('update_settings', { patch }), JSON.stringify(patch)).rejects.toMatchObject({ code: 'forbidden' });
    expect(JSON.stringify(env.ctx.settings())).toBe(before);
    expect(MAIN_SETTINGS).toEqual(['execution', 'team.effortMapping', 'team.modelCatalog', 'account.authMode', 'general.backup.keep']);
    const r = await env.main('update_settings', { patch: { execution: { maxConcurrent: 4 }, team: { effortMapping: { codex: { high: 'xhigh' } } }, account: { authMode: { codex: 'api_key' } } } });
    expect(r).toMatchObject({ execution: { maxConcurrent: 4 }, team: { effortMapping: { codex: { high: 'xhigh' } } }, account: { authMode: { codex: 'api_key' } } });
    // 값 검사는 대표 처리기와 같다
    await expect(env.main('update_settings', { patch: { execution: { maxConcurrent: 0 } } })).rejects.toMatchObject({ code: 'invalid' });
  });
});
