/**
 * 대표 세션 게이트 (SERVER_DESIGN 2.4·2.5, 10.1 ownerSurface, OWN-05, AC-51, G12).
 * - 대표가 부르는 길(Backend.invoke)은 대표 메서드(OWNER_METHODS, 2.4 '유지' 32개)만 받는다. 뺀 메서드는 `forbidden`이고 활동 기록·로그에 남으며
 *   아무것도 바뀌지 않는다 — 처리기가 거절한 것이 아니라 게이트가 막은 것인지 보려고, 막지 않으면 성공했을 인자로 부른다
 * - CLI 다시 확인(system.recheckAi)은 보기라 대표에게 남는다 (리드 결정 7) — 메인의 AI 종류가 재로그인 필요로 막혀도 대표가 풀 수 있다
 * - 데스크톱 앱은 운영자 로컬 메서드(개발 로그인·구글 설정·API 키, settings.update의 계정·CLI 위치·운영자 몫·메인 AI)를 더 받는다. 다른 설정이 섞이면 거부.
 *   모의 실행은 끄기만 받는다(projects.setMock {enabled:false}, developer.mainAgentMock false — 리드 결정 23, mockOffDesktop.test.ts)
 * - 원격(remote) 길(서버, 3단계에서 붙임)은 화면 약속에 남은 뺀 메서드 27개와 데스크톱 운영자 로컬 메서드를 모두 거부한다 — 게이트 판정은 지금부터 같다
 *   (리드 결정 13)
 * - 기능 자체를 없앤 3개(대표 직접 메시지 members.sendMessage, 대표 검수 tasks.ownerReview, 폴더 고르기 system.pickFolder)는 화면 정리 뒤 화면 약속과
 *   처리기에서 지웠다 — 대표 세션에는 알 수 없는 요청(not_found)이다 (리드 결정 21, removedOwnerPowers.test.ts). 대신 메인 에이전트의 긴급 지시
 *   (instruct_member urgent)와 메인 에이전트 대체 검수가 있다 (S1b)
 * - 타입 시험: OWNER_METHODS ⊆ WookApiMethods, 뺀 메서드가 대표 목록에 다시 들어오지 않음, 59개 모두 어느 한쪽으로 분류됨, 없앤 3개는 WookMethod가 아님
 *   (tsc -p tsconfig.node.json)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_METHODS,
  DESKTOP_OPERATOR_METHODS,
  IPC_METHODS,
  OWNER_METHODS,
  type OwnerMethod,
  type RoleInput,
  type WookMethod,
} from '@shared/ipc';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask } from './orchHarness';
import { createOwnerInvoke, ownerRefusal } from '../../src/main/backend/ownerGate';
import { createInternalApi } from '../../src/main/orchestrator/api';

/**
 * 2.4에서 대표에게서 뺀 30개 가운데 화면 약속에 남은 27개: → 메인 도구 23, → 운영자 4 (system.recheckAi는 대표에게 돌아갔다 — 리드 결정 7).
 * 운영자 내부 API와 메인 도구 처리기가 같은 처리기를 쓴다
 */
const REMOVED = [
  'auth.devLogin',
  'projects.create',
  'projects.update',
  'projects.pause',
  'projects.resume',
  'projects.setMock',
  'members.add',
  'members.update',
  'members.remove',
  'members.replaceProducer',
  'members.pause',
  'members.resume',
  'members.interrupt',
  'directives.cancel',
  'tasks.resume',
  'tasks.cancel',
  'tasks.interrupt',
  'recovery.resolve',
  'settings.update',
  'settings.setGoogleSecret',
  'settings.setApiKey',
  'roles.create',
  'roles.update',
  'roles.delete',
  'skills.setMode',
  'skills.setRoleSkills',
  'system.backupNow',
] as const satisfies readonly WookMethod[];
type Removed = (typeof REMOVED)[number];
/** 2.4 '없앰' 3개 — 화면 약속(WookApiMethods·IPC_METHODS)과 처리기에서 지웠다 (리드 결정 21) */
const GONE = ['members.sendMessage', 'tasks.ownerReview', 'system.pickFolder'] as const;
type Gone = (typeof GONE)[number];

// ───── 타입 시험 (tsc가 검사한다 — 어긋나면 'Type false does not satisfy the constraint true') ─────
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
export type OwnerListIsApiSubset = Assert<OwnerMethod extends WookMethod ? true : false>;
export type RemovedNeverOwner = Assert<IsNever<Extract<OwnerMethod, Removed>>>;
export type EveryMethodClassified = Assert<IsNever<Exclude<WookMethod, OwnerMethod | Removed>>>;
export type GoneNotInContract = Assert<IsNever<Extract<WookMethod, Gone>>>;

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const roleInput: RoleInput = {
  name: '사운드',
  instructions: '효과음과 배경음을 만든다',
  taskTypes: ['design'],
  allowedSkills: [],
  defaultAi: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null },
  canReview: false,
};

describe('대표 메서드 목록 (2.4)', () => {
  it('대표 목록 41개(3단계 서버 로그인 5개, 4단계 자리·일지 보기 4개 포함)와 화면 약속에 남은 뺀 메서드 27개는 겹치지 않고, 합치면 화면 약속(IPC_METHODS) 68개 전부다 — CLI 다시 확인은 대표 목록에 있고, 없앤 3개는 화면 약속에 없다', () => {
    expect(OWNER_METHODS).toHaveLength(41);
    expect(REMOVED).toHaveLength(27);
    expect(new Set(OWNER_METHODS).size).toBe(41);
    expect(OWNER_METHODS).toContain('system.recheckAi');
    const owner = new Set<string>(OWNER_METHODS);
    expect(REMOVED.filter((m) => owner.has(m))).toEqual([]);
    // 리드 결정 21 (10-29, 결정 14 적용): 화면 정리(Codex, docs/design/permission-ui)가 들어와 화면이 더는 부르지 않으므로 없앤 3개를
    // WookApiMethods·IPC_METHODS와 처리기 자리에서 지웠다(@deprecated 타입과 함께, 2.5)
    expect([...OWNER_METHODS, ...REMOVED].sort()).toEqual([...IPC_METHODS].sort());
    expect(IPC_METHODS).toHaveLength(68);
    expect(IPC_METHODS.filter((m) => (GONE as readonly string[]).includes(m))).toEqual([]);
  });

  it('데스크톱 preload 목록 = 대표 메서드 + 운영자 로컬 메서드 (대표 직접 메시지·대표 검수·폴더 고르기는 없다)', () => {
    // 프로젝트 모의 실행은 끄기만 받는다 (리드 결정 23 — 인자는 게이트가 본다)
    expect([...DESKTOP_OPERATOR_METHODS].sort()).toEqual(['auth.devLogin', 'projects.setMock', 'settings.setApiKey', 'settings.setGoogleSecret', 'settings.update']);
    expect([...DESKTOP_METHODS].sort()).toEqual([...OWNER_METHODS, ...DESKTOP_OPERATOR_METHODS].sort());
    for (const m of GONE) expect(DESKTOP_METHODS as readonly string[], m).not.toContain(m);
  });
});

describe('대표 세션 게이트 (Backend.invoke)', () => {
  it('뺀 메서드는 대표 세션으로 부르면 모두 forbidden이고 활동 기록에 남으며, 아무것도 바뀌지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const newDir = join(mkdtempSync(join(tmpdir(), 'wook-test-owner-surface-')), 'p2');
    // 게이트가 없으면 성공했을 인자 (처리기의 거절과 가리기 위해)
    const args: Partial<Record<Removed, unknown[]>> = {
      'projects.create': [{ mode: 'new', path: newDir, name: '대표가 만든 프로젝트' }],
      'projects.update': [e.projectId, { name: '대표가 바꾼 이름' }],
      'projects.pause': [e.projectId, 'immediate'],
      'projects.resume': [e.projectId],
      'projects.setMock': [e.projectId, { enabled: false }],
      'members.add': [{ projectId: e.projectId, roleId: 'docs' }],
      'members.update': [e.devId, { name: '대표가 바꾼 이름' }],
      'members.remove': [e.qaId],
      'members.replaceProducer': [e.projectId, { name: '새프로듀서' }],
      'members.pause': [e.devId, 'immediate'],
      'members.resume': [e.devId],
      'members.interrupt': [e.devId, 'hold'],
      'directives.cancel': [d.id],
      'tasks.resume': [t.id],
      'tasks.cancel': [t.id],
      'tasks.interrupt': [t.id, 'hold'],
      'recovery.resolve': ['RQ-없음', 'retry'],
      'settings.update': [{ execution: { maxConcurrent: 2 } }],
      'roles.create': [roleInput],
      'roles.update': ['docs', { ...roleInput, name: '문서' }],
      'roles.delete': ['docs'],
      'skills.setMode': ['some-skill', 'manual'],
      'skills.setRoleSkills': ['docs', ['some-skill']],
      'system.backupNow': [],
    };
    // 프로젝트 모의 실행 끄기(projects.setMock {enabled:false})도 데스크톱 운영자 로컬이다 — 켜기 거부는 mockOffDesktop.test.ts (리드 결정 23)
    const desktopLocal = new Set<string>(['auth.devLogin', 'settings.setGoogleSecret', 'settings.setApiKey', 'projects.setMock']);
    const refused = REMOVED.filter((m) => !desktopLocal.has(m));
    expect(refused).toHaveLength(23);
    expect(refused.filter((m) => !args[m])).toEqual([]);

    const before = {
      projects: e.ctx.store.projects.list().map((p) => [p.id, p.name, p.mock.enabled]),
      members: e.ctx.store.members.list().map((m) => [m.id, m.name, m.deletedAt, m.isProducer]),
      roles: e.ctx.store.roles.list().map((r) => [r.id, r.name, r.allowedSkills]),
      task: e.ctx.store.tasks.require(t.id).state,
      directive: e.ctx.store.directives.require(d.id).state,
      stop: e.ctx.stop(),
      settings: e.ctx.settings(),
      backups: e.ctx.store.activity.search({ text: '백업 완료' }).length,
      messages: e.ctx.store.messages.list().length,
      reviews: e.ctx.store.reviews.list().length,
    };
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0;
    for (const m of refused) {
      const call = (e.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)(m, ...args[m]!);
      await expect(call, m).rejects.toMatchObject({ code: 'forbidden' });
      await expect((e.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)(m, ...args[m]!), m).rejects.toThrow(/메인 에이전트/);
    }
    // 기록: 거부마다 한 줄 (두 번씩 불렀다), 대표가 한 요청으로, 인자 없이
    const rows = e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부', limit: 500 }).filter((r) => r.seq > seq0);
    expect(rows).toHaveLength(refused.length * 2);
    for (const m of refused) expect(rows.filter((r) => r.text === `대표 권한 밖 요청 거부: ${m}`), m).toHaveLength(2);
    expect(rows.every((r) => r.actor === 'owner' && r.level === 'warn' && r.kind === 'auth')).toBe(true);
    expect(rows.some((r) => `${r.text} ${r.result}`.includes('대표가 바꾼 이름'))).toBe(false);
    // 아무것도 바뀌지 않았다
    expect({
      projects: e.ctx.store.projects.list().map((p) => [p.id, p.name, p.mock.enabled]),
      members: e.ctx.store.members.list().map((m) => [m.id, m.name, m.deletedAt, m.isProducer]),
      roles: e.ctx.store.roles.list().map((r) => [r.id, r.name, r.allowedSkills]),
      task: e.ctx.store.tasks.require(t.id).state,
      directive: e.ctx.store.directives.require(d.id).state,
      stop: e.ctx.stop(),
      settings: e.ctx.settings(),
      backups: e.ctx.store.activity.search({ text: '백업 완료' }).length,
      messages: e.ctx.store.messages.list().length,
      reviews: e.ctx.store.reviews.list().length,
    }).toEqual(before);
    // 같은 일은 메인 에이전트가 앱 도구로 한다
    await e.main('pause_member', { member_id: e.devId, mode: 'immediate', reason: '대표 명령: 개발자 잠깐 멈춰' });
    expect(e.ctx.stop().members[e.devId]).toMatchObject({ paused: true, by: 'M-MAIN' });
  });

  it('원격(remote) 길은 화면 약속에 남은 뺀 메서드 27개와 데스크톱 운영자 로컬 메서드(개발 로그인·구글 설정·API 키·운영자 설정 항목)를 모두 거부·기록하고 아무것도 바꾸지 않는다 — 대표 메서드는 지나간다 (2.5, 리드 결정 13)', async () => {
    env = await bootOrch();
    const e = env;
    const remote = createOwnerInvoke(e.core, 'remote') as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const newDir = join(mkdtempSync(join(tmpdir(), 'wook-test-owner-surface-remote-')), 'p2');
    // 게이트가 없으면(또는 데스크톱이면) 성공했을 인자
    const args: Record<Removed, unknown[]> = {
      'auth.devLogin': [],
      'projects.create': [{ mode: 'new', path: newDir, name: '원격 대표가 만든 프로젝트' }],
      'projects.update': [e.projectId, { name: '원격 대표가 바꾼 이름' }],
      'projects.pause': [e.projectId, 'immediate'],
      'projects.resume': [e.projectId],
      'projects.setMock': [e.projectId, { enabled: false }],
      'members.add': [{ projectId: e.projectId, roleId: 'docs' }],
      'members.update': [e.devId, { name: '원격 대표가 바꾼 이름' }],
      'members.remove': [e.qaId],
      'members.replaceProducer': [e.projectId, { name: '새프로듀서' }],
      'members.pause': [e.devId, 'immediate'],
      'members.resume': [e.devId],
      'members.interrupt': [e.devId, 'hold'],
      'directives.cancel': [d.id],
      'tasks.resume': [t.id],
      'tasks.cancel': [t.id],
      'tasks.interrupt': [t.id, 'hold'],
      'recovery.resolve': ['RQ-없음', 'retry'],
      // 데스크톱에서는 지나가는 운영자 항목(CLI 실행 파일 위치)만 담았다 — 원격에는 운영자 로컬 메서드가 아예 없다
      'settings.update': [{ cli: { claudePath: 'C:\\remote\\claude.exe' } }],
      'settings.setGoogleSecret': ['remote-google-secret-0000'],
      'settings.setApiKey': ['claude', 'sk-ant-remote-surface-0000000000000000'],
      'roles.create': [roleInput],
      'roles.update': ['docs', { ...roleInput, name: '문서' }],
      'roles.delete': ['docs'],
      'skills.setMode': ['some-skill', 'manual'],
      'skills.setRoleSkills': ['docs', ['some-skill']],
      'system.backupNow': [],
    };
    expect(Object.keys(args).sort()).toEqual([...REMOVED].sort());
    // 판정 함수: 원격에서는 화면 약속에 남은 뺀 메서드 모두, 데스크톱 운영자 로컬 메서드도 모두(운영자 설정 항목만 담은 settings.update 포함) 거부한다
    for (const m of REMOVED) expect(ownerRefusal(m, args[m], 'remote'), m).toBeTruthy();
    for (const m of DESKTOP_OPERATOR_METHODS) {
      expect(ownerRefusal(m, args[m], 'remote'), m).toBeTruthy();
      expect(ownerRefusal(m, args[m], 'desktop'), m).toBeNull();
    }
    for (const patch of [{ cli: { codexPath: 'C:\\x\\codex.exe' } }, { account: { authMode: { claude: 'api_key' } } }, { general: { mainAgent: { kind: 'codex' } } }, { logs: { retentionDays: 1 } }]) {
      expect(ownerRefusal('settings.update', [patch], 'remote'), JSON.stringify(patch)).toBeTruthy();
    }

    const before = {
      projects: e.ctx.store.projects.list().map((p) => [p.id, p.name, p.mock.enabled]),
      members: e.ctx.store.members.list().map((m) => [m.id, m.name, m.deletedAt, m.isProducer]),
      roles: e.ctx.store.roles.list().map((r) => [r.id, r.name, r.allowedSkills]),
      task: e.ctx.store.tasks.require(t.id).state,
      directive: e.ctx.store.directives.require(d.id).state,
      stop: e.ctx.stop(),
      settings: e.ctx.settings(),
      auth: e.core.auth.isLoggedIn(),
      messages: e.ctx.store.messages.list().length,
      reviews: e.ctx.store.reviews.list().length,
    };
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0;
    for (const m of REMOVED) await expect(remote(m, args[m]), m).rejects.toMatchObject({ code: 'forbidden' });
    const rows = e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부', limit: 500 }).filter((r) => r.seq > seq0);
    expect(rows.map((r) => r.text).sort()).toEqual(REMOVED.map((m) => `대표 권한 밖 요청 거부: ${m}`).sort());
    expect(rows.every((r) => r.actor === 'owner' && r.level === 'warn' && r.kind === 'auth')).toBe(true);
    // 인자(비밀 값)는 기록에 남지 않는다
    expect(JSON.stringify(e.ctx.store.activity.search({ limit: 500 }))).not.toMatch(/sk-ant-remote-surface|remote-google-secret/);
    expect({
      projects: e.ctx.store.projects.list().map((p) => [p.id, p.name, p.mock.enabled]),
      members: e.ctx.store.members.list().map((m) => [m.id, m.name, m.deletedAt, m.isProducer]),
      roles: e.ctx.store.roles.list().map((r) => [r.id, r.name, r.allowedSkills]),
      task: e.ctx.store.tasks.require(t.id).state,
      directive: e.ctx.store.directives.require(d.id).state,
      stop: e.ctx.stop(),
      settings: e.ctx.settings(),
      auth: e.core.auth.isLoggedIn(),
      messages: e.ctx.store.messages.list().length,
      reviews: e.ctx.store.reviews.list().length,
    }).toEqual(before);
    // 대표 메서드는 원격에서도 지나간다 (대조)
    expect((await remote('snapshot.get', [])) as { projects: { id: string }[] }).toMatchObject({ projects: expect.arrayContaining([expect.objectContaining({ id: e.projectId })]) });
  });

  it('대표 메서드와 데스크톱 운영자 로컬 메서드는 지나간다 — settings.update는 운영자 항목(계정·CLI 위치·메인 AI 등)만, 다른 항목이 섞이면 거부·기록', async () => {
    env = await bootOrch();
    const e = env;
    // 대표 메서드 (보기·명령·긴급 정지)
    expect((await e.invoke('snapshot.get')).projects.map((p) => p.id)).toContain(e.projectId);
    expect(await e.invoke('roles.list')).not.toHaveLength(0);
    // CLI 다시 확인은 보기다 — 대표 세션으로 지나가고, 원격 길에서도 대표 메서드다 (리드 결정 7)
    await e.invoke('system.recheckAi', 'claude');
    expect(ownerRefusal('system.recheckAi', ['claude'], 'remote')).toBeNull();
    await e.invoke('command.send', { target: 'main', text: '사운드 담당을 하나 붙여 줘' });
    expect(e.ctx.store.queue.list({ ref1: 'M-MAIN', state: 'queued' }).map((q) => q.kind)).toContain('main_command');
    // 데스크톱 운영자 로컬
    const s1 = await e.invoke('settings.update', { cli: { claudePath: 'C:\\tools\\claude.exe' } });
    expect(s1.cli.claudePath).toBe('C:\\tools\\claude.exe');
    const s2 = await e.invoke('settings.update', { account: { authMode: { claude: 'api_key' } } });
    expect(s2.account.authMode.claude).toBe('api_key');
    await e.invoke('settings.setApiKey', 'claude', 'sk-ant-owner-surface-0000000000000000');
    // 섞이면 거부, 아무것도 바뀌지 않는다
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0;
    await expect(e.invoke('settings.update', { cli: { codexPath: 'C:\\x\\codex.exe' }, execution: { maxConcurrent: 2 } })).rejects.toMatchObject({ code: 'forbidden' });
    // 개발자 옵션은 메인 에이전트 모의 모드 끄기만 운영자 로컬이다(리드 결정 23) — 다른 개발자 옵션이 섞이면 거부
    await expect(e.invoke('settings.update', { developer: { mainAgentMock: false, mockSpeed: 5 } })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(e.invoke('settings.update', { general: { backup: { keep: 2 }, mainAgent: { kind: 'codex' } } })).rejects.toMatchObject({ code: 'forbidden' });
    expect(e.ctx.settings().cli.codexPath).toBeNull();
    expect(e.ctx.settings().execution.maxConcurrent).not.toBe(2);
    expect(e.ctx.settings().general.mainAgent.kind).toBe('claude');
    const rows = e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부: settings.update', limit: 50 }).filter((r) => r.seq > seq0);
    expect(rows).toHaveLength(3);
    // general은 운영자 몫(자동 백업 켜기·로그인 때 실행·메인 AI, 리드 결정 2·8) 밖의 항목만 거부 사유에 나온다
    // 개발자 옵션은 메인 에이전트도 바꾸지 못한다 — 메인 에이전트가 바꾼다고 하지 않는다 (리드 결정 40)
    expect(rows.map((r) => r.result).sort()).toEqual([
      '개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다',
      '운영 설정(execution)은 메인 에이전트가 바꿉니다',
      '운영 설정(general.backup.keep)은 메인 에이전트가 바꿉니다',
    ]);
    expect(e.ctx.settings().developer.mockSpeed).not.toBe(5);
    // 인자(키 값)는 기록에 남지 않는다
    expect(JSON.stringify(e.ctx.store.activity.search({ limit: 500 }))).not.toContain('sk-ant-owner-surface');
  });

  it('대표 직접 메시지·대표 검수는 화면 약속에도 처리기에도 없고(알 수 없는 요청), 그 일은 메인 에이전트가 긴급 지시·대체 검수로 한다 — 운영자 내부 API에도 그 길은 없다 (리드 결정 21)', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    e.ctx.store.tasks.patch(t.id, { activatedAt: e.ctx.now() });
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0;
    const invoke = e.invoke as unknown as (m: string, ...a: unknown[]) => Promise<unknown>;
    await expect(invoke('members.sendMessage', e.devId, '로그인은 OAuth로', false)).rejects.toMatchObject({ code: 'not_found' });
    const reviewing = seedInReviewTask(e, MAIN_AGENT_ID);
    await expect(invoke('tasks.ownerReview', reviewing.id, { verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '' }], reason: '' })).rejects.toMatchObject({ code: 'not_found' });
    // 없는 요청이라 '대표 권한 밖 요청 거부' 기록도 없다 (화면 약속 밖의 이름은 IPC 길에서 먼저 막힌다 — shell/ipc.ts unknown_method)
    expect(e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부', limit: 50 }).filter((x) => x.seq > seq0)).toEqual([]);
    expect(e.ctx.store.messages.list()).toEqual([]);
    expect(e.ctx.store.reviews.list({ ref1: reviewing.id })).toEqual([]);
    // 운영자 내부 API(시험·운영자 준비 길)에도 대표 직접 메시지·대표 검수 처리기가 없다
    const internalApi = createInternalApi(e.core);
    for (const m of GONE) expect(Object.hasOwn(internalApi, m), m).toBe(false);
    // 같은 일은 메인 에이전트가 한다: 긴급 지시
    const sent = await e.main('instruct_member', { member_id: e.devId, text: '로그인은 OAuth로', urgent: true });
    expect(sent).toMatchObject({ sessionKey: `task:${t.id}`, urgent: true });
    expect(e.ctx.store.messages.list().map((m) => [m.fromActor, m.kind, m.urgent, m.text])).toEqual([[MAIN_AGENT_ID, 'urgent', true, '로그인은 OAuth로']]);
  });
});

describe('운영자 몫 설정 (리드 결정 2, 2026-10-29 — SERVER_DESIGN 2.5·2.6)', () => {
  it('보안 정책·기록 보관 기간·자동 백업 켜기·로그인 때 실행은 데스크톱 운영자 로컬로만 바뀐다 — 원격 대표 길과 메인 에이전트 update_settings는 거부한다', async () => {
    env = await bootOrch();
    const e = env;
    const areas = [{ kind: 'secret' as const, paths: ['C:\\wook-test-secret-area'] }];
    // 데스크톱: 그 PC의 사람은 대표이자 운영자다
    const s = await e.invoke('settings.update', { policy: { sensitiveAreas: areas }, logs: { retentionDays: 45 }, general: { backup: { enabled: false }, launchAtLogin: true } });
    expect([s.policy.sensitiveAreas, s.logs.retentionDays, s.general.backup.enabled, s.general.launchAtLogin]).toEqual([areas, 45, false, true]);
    // 원격 대표 길(서버, 3단계에서 붙임)에는 운영자 로컬 메서드가 없다
    for (const patch of [{ policy: { sensitiveAreas: [] } }, { logs: { retentionDays: 1 } }, { general: { launchAtLogin: false } }, { general: { mainAgent: { kind: 'codex' } } }]) {
      expect(ownerRefusal('settings.update', [patch], 'remote'), JSON.stringify(patch)).toBeTruthy();
      expect(ownerRefusal('settings.update', [patch], 'desktop'), JSON.stringify(patch)).toBeNull();
    }
    // 메인 에이전트는 보안 정책을 약하게 하거나 기록을 줄이지 못하고, 메인 AI도 바꾸지 못한다 (AC-19, LOG-03, 리드 결정 8 — 자리 넘기기는 4단계)
    for (const patch of [{ policy: { sensitiveAreas: [] } }, { policy: { emergencyShortcut: 'F1' } }, { logs: { retentionDays: 1 } }, { general: { backup: { enabled: true } } }, { general: { launchAtLogin: false } }, { general: { mainAgent: { kind: 'codex' } } }]) {
      await expect(e.main('update_settings', { patch }), JSON.stringify(patch)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect([e.ctx.settings().policy.sensitiveAreas, e.ctx.settings().logs.retentionDays, e.ctx.settings().general.backup.enabled, e.ctx.settings().general.launchAtLogin]).toEqual([areas, 45, false, true]);
    expect([e.ctx.settings().general.mainAgent.kind, e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind]).toEqual(['claude', 'claude']);
    // 메인의 허용 항목(백업 보관 수)은 바뀐다 — 대조
    await e.main('update_settings', { patch: { general: { backup: { keep: 3 } } } });
    expect(e.ctx.settings().general.backup).toEqual({ enabled: false, keep: 3 });
  });
});

describe('메인 자리 정책(seat.*)의 거부 글 (리드 결정 S4-33, S4-12·S4-23)', () => {
  const TELL_MAIN = '명령창으로 메인 에이전트에게 말하세요';
  const messageOf = (p: Promise<unknown>) => p.then(() => 'ok', (x: Error & { code?: string }) => `${x.code}: ${x.message}`);
  const DESKTOP = '메인 자리 정책(seat: 앉을 수 있는 보유자, 교체 때 마무리를 기다리는 시간)은 데스크톱에서 바꾸지 않습니다 — 이 PC는 기본값(마무리 120초)을 씁니다';
  const REMOTE = '메인 자리 정책(seat)은 서버 PC의 운영자가 server.json에서 바꿉니다';

  it('seat.*만 보내면 데스크톱은 기본값을 쓴다고, 원격은 서버 PC의 운영자가 server.json에서 바꾼다고 말한다 — 메인 에이전트도 못 하는 일이라 메인에게 말하라고 하지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const remote = createOwnerInvoke(e.core, 'remote') as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    for (const patch of [{ seat: { drainMs: 1_000 } }, { seat: { holders: ['launched:codex'] } }]) {
      expect(await messageOf(e.invoke('settings.update', patch as never)), JSON.stringify(patch)).toBe(`forbidden: ${DESKTOP} (settings.update).`);
      expect(await messageOf(remote('settings.update', [patch])), JSON.stringify(patch)).toBe(`forbidden: ${REMOTE} (settings.update).`);
    }
    // 그 글이 맞다 — 메인 에이전트의 update_settings도 메인 자리 정책을 운영자 몫으로 거부한다
    await expect(e.main('update_settings', { patch: { seat: { drainMs: 1_000 } }, reason: '시험' })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('메인 자리 정책(seat.*') });
    expect(e.core.seat.policy().drainMs).toBe(120_000);
    expect(e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부: settings.update', limit: 10 }).map((a) => a.result)).toEqual([REMOTE, DESKTOP, REMOTE, DESKTOP]);
  });

  it('섞인 요청은 다른 항목의 글을 예전대로 두고, 메인 몫 항목이 있을 때만 메인 안내를 붙인다', async () => {
    env = await bootOrch();
    const e = env;
    const remote = createOwnerInvoke(e.core, 'remote') as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    // 메인 몫(execution)과 함께: 그 항목은 메인이 바꾼다고 하고 메인 안내를 붙인다
    expect(await messageOf(e.invoke('settings.update', { execution: { maxConcurrent: 4 }, seat: { drainMs: 1_000 } } as never))).toBe(
      `forbidden: 운영 설정(execution)은 메인 에이전트가 바꿉니다. ${DESKTOP} (settings.update). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    expect(await messageOf(remote('settings.update', [{ execution: { maxConcurrent: 4 }, seat: { drainMs: 1_000 } }]))).toBe(
      `forbidden: 운영 설정(execution)은 메인 에이전트가 바꿉니다. ${REMOTE} (settings.update). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    // 개발자 옵션·운영자 항목과 함께: 메인 안내 없이 각자의 글
    expect(ownerRefusal('settings.update', [{ seat: { drainMs: 1_000 }, developer: { mockSpeed: 5 } }], 'desktop')).toBe(
      `${DESKTOP}. 개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다`,
    );
    expect(await messageOf(e.invoke('settings.update', { seat: { drainMs: 1_000 }, developer: { mockSpeed: 5 } } as never))).not.toContain(TELL_MAIN);
    expect(await messageOf(remote('settings.update', [{ logs: { retentionDays: 30 }, seat: { holders: ['launched:codex'] } }]))).toBe(
      `forbidden: 설치·운영자 설정은 서버 PC의 운영자가 바꿉니다. ${REMOTE} (settings.update).`,
    );
    // 다른 항목의 글은 예전 그대로다 — 데스크톱은 운영자 항목을 받고, 메인 몫만이면 메인 안내
    expect(ownerRefusal('settings.update', [{ logs: { retentionDays: 30 } }], 'desktop')).toBeNull();
    expect(await messageOf(e.invoke('settings.update', { execution: { maxConcurrent: 4 } }))).toBe(
      `forbidden: 운영 설정(execution)은 메인 에이전트가 바꿉니다 (settings.update). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    expect(e.core.seat.policy().drainMs).toBe(120_000);
  });
});
