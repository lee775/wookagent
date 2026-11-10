/**
 * 없앤 대표 기능의 흔적 정리 (리드 결정 21 — 결정 14 적용, SERVER_DESIGN 2.4 '없앰'·2.7·10.11 끝의 grep 확인).
 * 화면 정리(Codex, docs/design/permission-ui)가 들어온 뒤 대표 직접 메시지(members.sendMessage)·대표 검수(tasks.ownerReview)·폴더 고르기
 * (system.pickFolder)를 화면 약속(WookApiMethods·IPC_METHODS)과 처리기 자리에서 지우고, @deprecated로 남겨 둔 타입도 지웠다:
 * MemberView·UpdateMemberInput의 aiLockedByOwner, Settings.team.mainAgentDecidesAi, OwnerMessageResult·OwnerReviewInput,
 * TaskView.review.awaitingOwner, OwnerTodo 'owner_review'. 예전 저장값을 지우는 DB 이전 코드(migrations.ts·defaults.ts)는 그대로다.
 * - grep 확인 (10.11 끝): src/ 안(DB 이전 코드는 빼고, 빌드해 둔 옛 화면 묶음이 있는 docs 폴더도 뺀다)에 다섯 이름과 지운 타입 이름이 없다
 * - 세 메서드는 화면 약속에도 처리기에도 없다 — 대표 세션(데스크톱·원격)도 운영자 내부 API도 알 수 없는 요청(not_found)이고, 아무것도 바뀌지 않는다
 * - 서버가 내보내는 보기에 지운 칸이 없다 (작업 보기의 대표 검수 대기, 팀원 보기의 대표 고정, 설정의 '메인이 AI를 정함', 대표 할 일의 대표 검수)
 * - 타입 시험(tsc -p tsconfig.node.json): 세 이름은 WookMethod가 아니고, 지운 칸은 그 타입의 키가 아니다
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Settings } from '@shared/domain';
import { DESKTOP_METHODS, IPC_METHODS, OWNER_METHODS, type UpdateMemberInput, type WookMethod } from '@shared/ipc';
import type { MemberView, OwnerTodo, TaskView } from '@shared/views';
import { createOwnerInvoke } from '../../src/main/backend/ownerGate';
import { createApi, createInternalApi } from '../../src/main/orchestrator/api';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask } from './orchHarness';

/** 2.4에서 '없앰'으로 정한 세 메서드 — 화면 약속에서 지웠다 */
const GONE = ['members.sendMessage', 'tasks.ownerReview', 'system.pickFolder'] as const;
type Gone = (typeof GONE)[number];

// ───── 타입 시험 (tsc가 검사한다 — 어긋나면 'Type false does not satisfy the constraint true') ─────
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
export type GoneNotInContract = Assert<IsNever<Extract<WookMethod, Gone>>>;
export type NoAwaitingOwner = Assert<IsNever<Extract<keyof TaskView['review'], 'awaitingOwner'>>>;
export type NoMemberViewLock = Assert<IsNever<Extract<keyof MemberView, 'aiLockedByOwner'>>>;
export type NoUpdateMemberLock = Assert<IsNever<Extract<keyof UpdateMemberInput, 'aiLockedByOwner'>>>;
export type NoMainAgentDecidesAi = Assert<IsNever<Extract<keyof Settings['team'], 'mainAgentDecidesAi'>>>;
export type NoOwnerReviewTodo = Assert<IsNever<Extract<OwnerTodo['kind'], 'owner_review'>>>;

const ROOT = join(__dirname, '..', '..');
/** 10.11 끝의 grep 이름 다섯 개와 이번에 지운 타입 이름 */
const PATTERNS = ['members.sendMessage', 'ownerReview', 'aiLockedByOwner', 'mainAgentDecidesAi', "reviewer: 'owner'", 'OwnerMessageResult', 'OwnerReviewInput', 'awaitingOwner'];
/** 예전 저장값을 지우는 DB 이전 코드 — 10.11이 셈에서 뺀다 */
const MIGRATION = new Set(['src/main/orchestrator/migrations.ts', 'src/main/orchestrator/defaults.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'docs') continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('없앤 대표 기능의 이름이 코드에 남지 않는다 (리드 결정 21, 10.11)', () => {
  it('src/ 안(DB 이전 코드 빼고)에 10.11의 다섯 이름과 지운 타입 이름이 한 줄도 없다', () => {
    const hits: string[] = [];
    for (const f of sourceFiles(join(ROOT, 'src'))) {
      const rel = relative(ROOT, f).replace(/\\/g, '/');
      if (MIGRATION.has(rel)) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          for (const p of PATTERNS) if (text.includes(p)) hits.push(`${rel}:${i + 1} ${p}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('세 메서드는 화면 약속(IPC_METHODS)에 없다 — 화면 약속은 대표 메서드 43개와 내부 API·메인 도구가 쓰는 뺀 메서드 27개, 70개다', () => {
    expect(IPC_METHODS.filter((m) => (GONE as readonly string[]).includes(m))).toEqual([]);
    expect(IPC_METHODS).toHaveLength(70);
    expect(new Set(IPC_METHODS).size).toBe(70);
    expect(OWNER_METHODS.every((m) => IPC_METHODS.includes(m))).toBe(true);
    expect(DESKTOP_METHODS.every((m) => IPC_METHODS.includes(m))).toBe(true);
  });
});

describe('세 메서드는 어느 길에도 없다', () => {
  it('대표 세션(데스크톱·원격)은 알 수 없는 요청(not_found)이고 거부 기록도 남지 않는다. 운영자 내부 API·메인 도구 처리기에도 그 자리가 없다. 아무것도 바뀌지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const reviewing = seedInReviewTask(e, MAIN_AGENT_ID);
    // 예전에는 이 인자로 부르면 게이트가 forbidden으로 막고 '대표 권한 밖 요청 거부'를 남겼다
    const args: Record<Gone, unknown[]> = {
      'members.sendMessage': [e.devId, '로그인은 OAuth로', false],
      'tasks.ownerReview': [reviewing.id, { verdict: 'pass', criteria: [{ criterion: '동작', pass: true, note: '' }], reason: '' }],
      'system.pickFolder': [],
    };
    const desktop = e.invoke as unknown as (m: string, ...a: unknown[]) => Promise<unknown>;
    const remote = createOwnerInvoke(e.core, 'remote') as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    const before = {
      task: e.ctx.store.tasks.require(t.id).state,
      reviewing: e.ctx.store.tasks.require(reviewing.id).review.passed,
      messages: e.ctx.store.messages.list().length,
      reviews: e.ctx.store.reviews.list().length,
      queue: e.ctx.store.queue.list({ state: ['queued', 'running'] }).length,
    };
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0;
    for (const m of GONE) {
      await expect(desktop(m, ...args[m]), m).rejects.toMatchObject({ code: 'not_found', message: `알 수 없는 요청: ${m}` });
      await expect(remote(m, args[m]), m).rejects.toMatchObject({ code: 'not_found' });
      expect(Object.hasOwn(createInternalApi(e.core), m), m).toBe(false);
      expect(Object.hasOwn(createApi(e.core, MAIN_AGENT_ID), m), m).toBe(false);
    }
    expect(e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부', limit: 50 }).filter((r) => r.seq > seq0)).toEqual([]);
    expect({
      task: e.ctx.store.tasks.require(t.id).state,
      reviewing: e.ctx.store.tasks.require(reviewing.id).review.passed,
      messages: e.ctx.store.messages.list().length,
      reviews: e.ctx.store.reviews.list().length,
      queue: e.ctx.store.queue.list({ state: ['queued', 'running'] }).length,
    }).toEqual(before);
  });

  it('서버가 내보내는 보기에 지운 칸이 없다 — 작업 보기의 대표 검수 대기, 팀원 보기의 대표 고정, 설정의 메인 AI 결정 끄기, 대표 할 일의 대표 검수', async () => {
    env = await bootOrch();
    const e = env;
    const reviewing = seedInReviewTask(e, MAIN_AGENT_ID);
    const snap = e.core.views.snapshot();
    const task = snap.tasks.find((v) => v.id === reviewing.id)!;
    expect(task.review.passed).toBe(false);
    expect(task.review).not.toHaveProperty('awaitingOwner');
    expect(e.core.views.taskView(e.ctx.store.tasks.require(reviewing.id)).review).not.toHaveProperty('awaitingOwner');
    expect(snap.members.length).toBeGreaterThan(0);
    for (const m of snap.members) expect(m, m.id).not.toHaveProperty('aiLockedByOwner');
    expect(e.core.views.memberView(e.ctx.store.members.require(e.devId))).not.toHaveProperty('aiLockedByOwner');
    expect(e.ctx.settings().team).not.toHaveProperty('mainAgentDecidesAi');
    expect(snap.ownerTodos.map((x) => x.kind as string)).not.toContain('owner_review');
  });
});
