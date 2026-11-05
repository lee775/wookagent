import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSession, AiKind, MockScenario, QueueEntry } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import type { WorkContext, WorkTaskCard } from '../mcp/catalog';
import { createAppToolServer } from '../mcp/server';
import { buildTurnMessage } from '../orchestrator/prompts';
import type { TokenIdentity, ToolCallLog, ToolCallResult } from '../mcp/types';
import { LaunchError } from './common';
import { createMockAdapter } from './mockAdapter';
import type { MockLaunchOptions, TurnLaunch } from './types';
import { FakeWork, type FakeAgentSetup, type RecordedCall } from './__mock_tests__/fakeWork';
import { startFakeMcp, type FakeMcpServer } from './__mock_tests__/fakeMcp';
import { runMockTurn, unknownEvents, type MockRun, type RunOptions } from './__mock_tests__/runMock';
import {
  DEV,
  DOCS,
  PLANNER,
  PRODUCER,
  QA,
  directive,
  directiveContext,
  mainContext,
  ownerCommandMessage,
  reviewContext,
  taskCard,
  taskContext,
  turnMessage,
  type TeamMember,
} from './__mock_tests__/contexts';

const SCRIPT = fileURLToPath(new URL('../../../resources/mock-agent/mock-agent.mjs', import.meta.url));
const FORMATS: AiKind[] = ['claude', 'codex'];

let root: string;
let work: FakeWork;
let sse: FakeMcpServer;
let json: FakeMcpServer;
let dirCount = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-mock-agent-'));
  work = new FakeWork();
  sse = await startFakeMcp(work, { style: 'sse' });
  json = await startFakeMcp(work, { style: 'json' });
});
afterAll(async () => {
  await sse?.stop();
  await json?.stop();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const adapter = createMockAdapter({ nodeExecPath: process.execPath, nodeExecEnv: {}, scriptPath: SCRIPT });

async function newDir(name: string): Promise<string> {
  const d = path.join(root, `${String(++dirCount).padStart(3, '0')} ${name}`);
  await mkdir(d, { recursive: true });
  return d;
}

interface TurnOpts {
  format: AiKind;
  ctx: WorkContext;
  scenario?: MockScenario;
  speed?: number;
  /** 같은 에이전트(가짜 처리기 상태)로 이어서 */
  agent?: string;
  setup?: Omit<FakeAgentSetup, 'ctx'>;
  cwd?: string;
  stateDir?: string;
  resume?: string | null;
  newSessionId?: string | null;
  turnNumber?: number;
  message?: string;
  systemPrompt?: string;
  server?: 'sse' | 'json';
  url?: string;
  token?: string;
  run?: RunOptions;
}

interface TurnResult {
  run: MockRun;
  agent: string;
  calls: RecordedCall[];
  cwd: string;
  stateDir: string;
  launch: TurnLaunch;
  sessionId: string;
}

function defaultMessage(ctx: WorkContext): string {
  return turnMessage(
    ctx.session.sessionKey,
    ctx.workKinds.map((kind, i) => ({ kind, message: ctx.messages[i]?.text ?? '' })),
  );
}

function makeLaunch(o: TurnOpts, x: { agent: string; cwd: string; stateDir: string }): TurnLaunch {
  const role: MockLaunchOptions['role'] = o.ctx.you.isMain ? 'main' : o.ctx.you.isProducer ? 'producer' : 'member';
  return {
    format: o.format,
    cwd: x.cwd,
    message: o.message ?? defaultMessage(o.ctx),
    systemPrompt: o.systemPrompt ?? '# 시험 지침\n- 먼저 get_work_context를 부른다',
    resumeCliSessionId: o.resume ?? null,
    newSessionId: o.resume ? null : o.newSessionId === undefined ? randomUUID() : o.newSessionId,
    model: null,
    effort: null,
    mcp: { url: o.url ?? (o.server === 'json' ? json.url : sse.url), token: o.token ?? x.agent, serverName: 'wook' },
    maxTurns: null,
    images: [],
    addDirs: [],
    tempDir: path.join(root, 'tmp turns'),
    env: {},
    mock: {
      scenario: o.scenario ?? 'normal',
      speed: o.speed ?? 1000,
      role,
      memberId: o.ctx.you.memberId,
      workKey: o.ctx.session.sessionKey,
      turnNumber: o.turnNumber ?? 1,
      stateDir: x.stateDir,
    },
  };
}

async function turn(o: TurnOpts): Promise<TurnResult> {
  const agent = o.agent ?? `tok-${randomUUID()}`;
  if (work.has(agent)) work.update(agent, { ctx: o.ctx, ...(o.setup ?? {}) });
  else work.register(agent, { ctx: o.ctx, ...(o.setup ?? {}) });
  const cwd = o.cwd ?? (await newDir('작업 폴더'));
  const stateDir = o.stateDir ?? (await newDir('모의 상태'));
  const launch = makeLaunch(o, { agent, cwd, stateDir });
  const before = work.calls.length;
  const run = await runMockTurn(adapter, launch, o.run);
  if (process.env.WOOK_MOCK_DEBUG) {
    console.log(`── ${o.format} ${o.scenario ?? 'normal'} ${o.ctx.session.sessionKey} (종료 ${run.exitCode}, ${Math.round(run.durationMs)}ms)`);
    console.log([...run.stdout.map((l) => `out ${l.slice(0, 400)}`), ...run.stderr.map((l) => `err ${l}`)].join('\n'));
    console.log(run.events.map((e) => `  ${e.kind.padEnd(12)} ${e.text.replace(/\s+/g, ' ').slice(0, 160)} ${e.data ? JSON.stringify(e.data).slice(0, 200) : ''}`).join('\n'));
  }
  return { run, agent, calls: work.calls.slice(before).filter((c) => c.agent === agent), cwd, stateDir, launch, sessionId: run.prepared.expectedCliSessionId! };
}

const toolNames = (calls: RecordedCall[]) => calls.map((c) => c.tool);
const callsOf = (calls: RecordedCall[], tool: string) => calls.filter((c) => c.tool === tool);
const failures = (calls: RecordedCall[]) => calls.filter((c) => !c.result.ok).map((c) => `${c.tool}: ${c.result.ok ? '' : c.result.message}`);
const ofKind = (events: ParsedCliEvent[], kind: ParsedCliEvent['kind']) => events.filter((e) => e.kind === kind);
const resultOf = (run: MockRun) => ofKind(run.events, 'result').at(-1);

/** 모든 줄이 실제 파서가 아는 형식이고, 세션 이벤트로 시작해 결과 이벤트로 끝난다 */
function expectWellFormed(run: MockRun, o: { result?: boolean } = {}): void {
  for (const line of run.stdout) {
    const v = JSON.parse(line) as { type?: unknown };
    expect(typeof v.type).toBe('string');
  }
  expect(unknownEvents(run.events)).toEqual([]);
  const main = run.events.filter((e) => e.kind !== 'stderr');
  expect(main[0]?.kind).toBe('session');
  expect(main[0]?.data?.cliSessionId).toBe(run.prepared.expectedCliSessionId);
  if (o.result !== false) expect(main.at(-1)?.kind).toBe('result');
}

/** 정상 끝: 오류 출력·거부 없음, 종료 코드 0, 결과 이벤트 정상 */
function expectCleanTurn(t: TurnResult): void {
  expect(t.run.stderr).toEqual([]);
  expect(t.run.exitCode).toBe(0);
  expectWellFormed(t.run);
  expect(failures(t.calls)).toEqual([]);
  expect(resultOf(t.run)?.data?.isError).toBe(false);
  expect(ofKind(t.run.events, 'error')).toEqual([]);
}

function devTask(id = 'T-0001', o: Partial<WorkTaskCard> = {}) {
  return taskContext({ member: DEV, task: taskCard({ ...o, id }) });
}

// ───────────────────────── 어댑터 ─────────────────────────

describe('createMockAdapter — 준비·확인', () => {
  const baseLaunch = async (over: Partial<TurnLaunch> = {}, mock: Partial<MockLaunchOptions> = {}): Promise<TurnLaunch> => {
    const cwd = await newDir('어댑터 작업 폴더');
    return {
      format: 'claude',
      cwd,
      message: '작업 메시지 "따옴표" 한글',
      systemPrompt: '# 역할 지침\n- 규칙 하나',
      resumeCliSessionId: null,
      newSessionId: '11111111-2222-4333-8444-555555555555',
      model: null,
      effort: null,
      mcp: { url: 'http://127.0.0.1:5999/mcp', token: 'tok-secret-1', serverName: 'wook' },
      maxTurns: null,
      images: [],
      addDirs: [],
      tempDir: path.join(cwd, 'tmp'),
      env: { EXTRA_KEY: 'extra' },
      mock: { scenario: 'slow', speed: 7, role: 'member', memberId: 'M-0002', workKey: 'task:T-0001', turnNumber: 3, stateDir: path.join(cwd, '상태'), ...mock },
      ...over,
    };
  };

  it('첫 턴: node 스크립트 --format --session-id, 모의 환경 변수, 지침 블록 + 메시지를 표준 입력으로', async () => {
    const a = createMockAdapter({
      nodeExecPath: process.execPath,
      nodeExecEnv: { ELECTRON_RUN_AS_NODE: '1' },
      scriptPath: SCRIPT,
      baseEnv: () => ({ PATH: 'C:\\Windows', CLAUDECODE: '1', WOOK_MCP_TOKEN: 'stale', KEEP: 'yes' }),
      platform: 'win32',
    });
    const launch = await baseLaunch();
    const p = await a.prepare(launch);
    expect(p.spec.command).toBe(process.execPath);
    expect(p.spec.args).toEqual([SCRIPT, '--format', 'claude', '--session-id', '11111111-2222-4333-8444-555555555555']);
    expect(p.spec.cwd).toBe(launch.cwd);
    expect(p.expectedCliSessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(p.cleanup).toEqual([]);
    expect(p.spec.env).toMatchObject({
      PATH: 'C:\\Windows',
      KEEP: 'yes',
      ELECTRON_RUN_AS_NODE: '1',
      EXTRA_KEY: 'extra',
      WOOK_MCP_URL: 'http://127.0.0.1:5999/mcp',
      WOOK_MCP_TOKEN: 'tok-secret-1',
      WOOK_MCP_SERVER: 'wook',
      WOOK_MOCK_SCENARIO: 'slow',
      WOOK_MOCK_SPEED: '7',
      WOOK_MOCK_ROLE: 'member',
      WOOK_MOCK_MEMBER: 'M-0002',
      WOOK_MOCK_WORKKEY: 'task:T-0001',
      WOOK_MOCK_TURN: '3',
      WOOK_MOCK_STATE_DIR: launch.mock!.stateDir,
    });
    expect(p.spec.env.CLAUDECODE).toBeUndefined();
    expect(p.spec.stdinText).toBe(`<wook_instructions>\n아래는 욱채 프로그램이 넣는 작업 규칙이다. 이 턴에도 그대로 따른다.\n\n# 역할 지침\n- 규칙 하나\n</wook_instructions>\n\n작업 메시지 "따옴표" 한글`);
    expect(p.display).toContain('모의 시나리오 slow');
    expect(p.display).not.toContain('tok-secret-1');
  });

  it('이어하기: --resume, 세션 ID는 그대로 / codex 형식도 첫 턴 세션 ID를 미리 정한다 / 지침이 없으면 메시지만', async () => {
    const resume = await adapter.prepare(await baseLaunch({ resumeCliSessionId: 'sess-abc', newSessionId: null }));
    expect(resume.spec.args.slice(1)).toEqual(['--format', 'claude', '--resume', 'sess-abc']);
    expect(resume.expectedCliSessionId).toBe('sess-abc');
    const codex = await adapter.prepare(await baseLaunch({ format: 'codex', newSessionId: null, systemPrompt: '  ' }));
    expect(codex.spec.args[2]).toBe('codex');
    expect(codex.spec.args[3]).toBe('--session-id');
    expect(codex.expectedCliSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(codex.spec.args[4]).toBe(codex.expectedCliSessionId);
    expect(codex.spec.stdinText).toBe('작업 메시지 "따옴표" 한글');
  });

  it('잘못된 실행 값은 한국어 LaunchError로 막는다', async () => {
    const bad: [Partial<TurnLaunch>, Partial<MockLaunchOptions>, RegExp][] = [
      [{ mock: undefined }, {}, /모의 에이전트 실행 설정/],
      [{}, { scenario: 'nope' as MockScenario }, /알 수 없는 모의 시나리오/],
      [{}, { speed: 0 }, /속도 배수/],
      [{}, { role: 'boss' as MockLaunchOptions['role'] }, /모의 역할/],
      [{}, { memberId: ' ' }, /팀원 ID/],
      [{}, { turnNumber: 0 }, /턴 번호/],
      [{}, { stateDir: 'relative\\state' }, /상태 폴더는 절대 경로/],
      [{ cwd: path.join(root, '없는 폴더') }, {}, /모의 에이전트\(claude 형식\): Claude Code 작업 폴더가 없습니다/],
      [{ mcp: { url: 'ftp://x', token: 't', serverName: 'wook' } }, {}, /앱 도구 서버 주소/],
      [{ effort: 'turbo' }, {}, /노력치/],
      [{ newSessionId: 'not-a-uuid' }, {}, /UUID/],
    ];
    for (const [over, mock, re] of bad) {
      const launch = await baseLaunch(over, mock);
      if ('mock' in over) launch.mock = over.mock;
      await expect(adapter.prepare(launch)).rejects.toThrow(re);
      await expect(adapter.prepare(launch)).rejects.toBeInstanceOf(LaunchError);
    }
    const missing = createMockAdapter({ nodeExecPath: process.execPath, nodeExecEnv: {}, scriptPath: path.join(root, '없음.mjs') });
    await expect(missing.prepare(await baseLaunch())).rejects.toThrow(/스크립트가 없습니다/);
  });

  it('detect: 스크립트가 있으면 설치됨·버전 mock, 없으면 문제로 알린다', async () => {
    expect(await adapter.detect()).toMatchObject({ installed: true, version: 'mock', loggedIn: true, problem: null, path: SCRIPT });
    const missing = createMockAdapter({ nodeExecPath: process.execPath, nodeExecEnv: {}, scriptPath: path.join(root, '없음.mjs') });
    const st = await missing.detect();
    expect(st.installed).toBe(false);
    expect(st.problem).toMatch(/스크립트가 없습니다/);
    expect(adapter.kind).toBe('mock');
  });

  it('createParser: 형식에 맞는 실제 파서를 돌려준다', async () => {
    const claude = adapter.createParser(await baseLaunch());
    expect(claude.pushLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'bypassPermissions', mcp_servers: [{ name: 'wook', status: 'connected' }] }))[0]).toMatchObject({
      kind: 'session',
      data: { cliSessionId: 's1', permissionMode: 'bypassPermissions' },
    });
    const codex = adapter.createParser(await baseLaunch({ format: 'codex' }));
    expect(codex.pushLine(JSON.stringify({ type: 'thread.started', thread_id: 't1' }))[0]).toMatchObject({ kind: 'session', data: { cliSessionId: 't1' } });
  });
});

// ───────────────────────── 작업 세션 ─────────────────────────

describe('모의 에이전트 — 작업 세션', () => {
  for (const format of FORMATS) {
    it(`${format}: set_steps → complete_step ×3 → submit_for_review, 작업 폴더에 파일을 쓴다`, async () => {
      const t = await turn({ format, ctx: devTask() });
      expectCleanTurn(t);
      expect(toolNames(t.calls)).toEqual(['get_work_context', 'set_steps', 'complete_step', 'complete_step', 'complete_step', 'submit_for_review']);
      expect(callsOf(t.calls, 'complete_step').map((c) => c.args.step_index)).toEqual([0, 1, 2]);
      const files = [1, 2, 3].map((i) => path.join(t.cwd, 'wook-mock', 'T-0001', `step-${i}.md`));
      for (const f of files) {
        expect(existsSync(f)).toBe(true);
        expect(readFileSync(f, 'utf8')).toMatch(/# T-0001 · .+\n[\s\S]*모의 에이전트/);
      }
      // 이벤트: 앱 도구 호출 순서 그대로, 파일 변경은 절대 경로로
      expect(ofKind(t.run.events, 'mcp_call').map((e) => e.data?.tool)).toEqual(toolNames(t.calls));
      expect(ofKind(t.run.events, 'mcp_call').every((e) => e.data?.server === 'wook')).toBe(true);
      expect(ofKind(t.run.events, 'file_change').flatMap((e) => e.data?.paths ?? [])).toEqual(files);
      expect(ofKind(t.run.events, 'usage')).toHaveLength(1);
      expect(resultOf(t.run)?.text).toContain('검수를 요청했습니다');
      const session = t.run.events[0]!;
      if (format === 'claude') {
        expect(session.data).toMatchObject({ permissionMode: 'bypassPermissions', mcpServers: [{ name: 'wook', status: 'connected' }] });
      } else {
        expect(session.data?.permissionMode).toBeUndefined();
      }
      // 메시지는 지침 블록과 함께 전달된다 (get_work_context가 첫 호출)
      expect(t.calls[0]!.tool).toBe('get_work_context');
    });
  }

  it('산출물형 작업은 저장소가 아닌 artifactDir에 쓴다', async () => {
    const artifactDir = await newDir('산출물 work');
    const t = await turn({ format: 'claude', ctx: taskContext({ member: PLANNER, task: taskCard({ id: 'T-0007', type: 'spec', outputMode: 'artifact', artifactDir }) }) });
    expectCleanTurn(t);
    expect(callsOf(t.calls, 'set_steps')[0]!.args.steps).toEqual(['요구사항 수집', '기획서 작성', '검토 정리']);
    expect(existsSync(path.join(artifactDir, 'wook-mock', 'T-0007', 'step-3.md'))).toBe(true);
    expect(existsSync(path.join(t.cwd, 'wook-mock'))).toBe(false);
  });

  it('이미 끝낸 단계는 건너뛰고 남은 단계만 진행한다', async () => {
    const steps = [
      { idx: 0, title: '하나', done: true },
      { idx: 1, title: '둘', done: false },
      { idx: 2, title: '셋', done: false },
    ];
    const t = await turn({ format: 'codex', ctx: devTask('T-0002', { steps }) });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'complete_step', 'complete_step', 'submit_for_review']);
    expect(callsOf(t.calls, 'complete_step').map((c) => c.args.step_index)).toEqual([1, 2]);
  });

  for (const format of FORMATS) {
    it(`${format}: 반려된 작업은 반영 단계를 추가해 새 버전으로 다시 제출한다 (같은 차수에서 한 번만)`, async () => {
      const steps = [0, 1, 2].map((idx) => ({ idx, title: `단계 ${idx + 1}`, done: true }));
      const ctx = devTask('T-0003', { steps, rejectsInRound: 1, lastRejectReason: '빈 입력 검사가 빠졌습니다 [빈 입력을 막는다: 확인 안 됨]' });
      const t = await turn({ format, ctx });
      expectCleanTurn(t);
      expect(toolNames(t.calls)).toEqual(['get_work_context', 'add_steps', 'complete_step', 'submit_for_review']);
      expect(callsOf(t.calls, 'add_steps')[0]!.args.steps).toEqual(['검수 반려 반영 (1차 1회)']);
      expect(callsOf(t.calls, 'complete_step')[0]!.args.step_index).toBe(3);
      expect(readFileSync(path.join(t.cwd, 'wook-mock', 'T-0003', 'step-4.md'), 'utf8')).toContain('빈 입력 검사가 빠졌습니다');
      // 같은 반려에 대해 다시 턴을 받으면(예: 제출 직전 끊김) 단계를 또 늘리지 않고 제출만 한다
      const again = await turn({ format, ctx, agent: t.agent, stateDir: t.stateDir, cwd: t.cwd, resume: t.sessionId, turnNumber: 2 });
      expectCleanTurn(again);
      expect(toolNames(again.calls)).toEqual(['get_work_context', 'submit_for_review']);
    });
  }

  it('정지 요청으로 complete_step이 "턴을 마치세요"라고 하면 그 단계에서 끝낸다', async () => {
    const t = await turn({ format: 'claude', ctx: devTask('T-0004'), setup: { stopAfterStep: true } });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'set_steps', 'complete_step']);
    expect(resultOf(t.run)?.text).toContain('정지 요청');
  });

  it('진행 상태가 아닌 작업은 건드리지 않는다', async () => {
    const t = await turn({ format: 'codex', ctx: devTask('T-0005', { state: 'in_review' }) });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context']);
    expect(resultOf(t.run)?.text).toContain('진행 상태가 아니어서');
  });

  it('작업 세션의 메시지 업무는 작업 계속과 같게 처리하고, 묶여 와도 한 번만 진행한다', async () => {
    const ctx = taskContext({ member: DEV, task: taskCard({ id: 'T-0006' }), workKinds: ['task_work', 'message'], messages: ['작업 카드', '대표 메시지: 서둘러 주세요'] });
    const t = await turn({ format: 'claude', ctx });
    expectCleanTurn(t);
    expect(callsOf(t.calls, 'set_steps')).toHaveLength(1);
    expect(callsOf(t.calls, 'submit_for_review')).toHaveLength(1);
  });

  for (const format of FORMATS) {
    it(`${format}: 충돌 해결 — 실제 git 충돌 표시를 지워 두 변경을 합치고 report_conflict_resolved`, async () => {
      const repo = await newDir('충돌 저장소');
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', '시험');
      git('config', 'user.email', 'test@wook.local');
      await writeFile(path.join(repo, 'README.md'), '기준\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'task/T-0010');
      await writeFile(path.join(repo, 'conflict-zone.txt'), '# 충돌 시험 영역\n작성: 개발자 김 (M-0002)\n이 줄은 M-0002의 변경입니다.\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'task');
      git('checkout', '-q', 'main');
      await writeFile(path.join(repo, 'conflict-zone.txt'), '# 충돌 시험 영역\n작성: QA 박 (M-0003)\n이 줄은 M-0003의 변경입니다.\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'main');
      git('checkout', '-q', 'task/T-0010');
      expect(() => git('merge', '--no-edit', 'main')).toThrow();
      const before = readFileSync(path.join(repo, 'conflict-zone.txt'), 'utf8');
      expect(before).toContain('<<<<<<<');

      const ctx = taskContext({ member: DEV, task: taskCard({ id: 'T-0010', conflictFiles: ['conflict-zone.txt'] }), workKinds: ['conflict_fix'], messages: ['충돌 파일: conflict-zone.txt'] });
      const t = await turn({ format, ctx, cwd: repo });
      expectCleanTurn(t);
      expect(toolNames(t.calls)).toEqual(['get_work_context', 'report_conflict_resolved']);
      const after = readFileSync(path.join(repo, 'conflict-zone.txt'), 'utf8');
      expect(after).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
      // 줄 끝은 git이 쓴 그대로 유지한다 (Windows의 core.autocrlf=true면 CRLF)
      const eol = before.includes('\r\n') ? '\r\n' : '\n';
      expect(after).toBe('# 충돌 시험 영역\n작성: 개발자 김 (M-0002)\n이 줄은 M-0002의 변경입니다.\n작성: QA 박 (M-0003)\n이 줄은 M-0003의 변경입니다.\n'.replace(/\n/g, eol));
      expect(ofKind(t.run.events, 'file_change').flatMap((e) => e.data?.paths ?? [])).toEqual([path.join(repo, 'conflict-zone.txt')]);
      // git이 해결된 내용으로 받아들인다 (모의 에이전트는 git을 실행하지 않는다)
      git('add', 'conflict-zone.txt');
      expect(git('diff', '--cached', '--check')).toBe('');
    });
  }

  it('diff3 형식(기준 구간 포함)·CRLF·끝 줄바꿈 없는 파일의 충돌 표시도 정리하고, 짝이 안 맞으면 그대로 둔다', async () => {
    const cwd = await newDir('diff3');
    await mkdir(path.join(cwd, '하위 폴더'), { recursive: true });
    await writeFile(path.join(cwd, 'a.txt'), '위\n<<<<<<< ours\n우리 줄\n||||||| base\n기준 줄\n=======\n그쪽 줄\n>>>>>>> theirs\n아래\n');
    await writeFile(path.join(cwd, '하위 폴더', 'b.txt'), '<<<<<<< HEAD\r\n같은 줄\r\n우리\r\n=======\r\n같은 줄\r\n그쪽\r\n>>>>>>> main');
    const broken = '<<<<<<< HEAD\n짝 없는 충돌\n';
    await writeFile(path.join(cwd, 'c.txt'), broken);
    const ctx = taskContext({ member: DEV, task: taskCard({ id: 'T-0011', conflictFiles: ['a.txt', '하위 폴더/b.txt', 'c.txt'] }), workKinds: ['conflict_fix'] });
    const t = await turn({ format: 'codex', ctx, cwd });
    expectCleanTurn(t);
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('위\n우리 줄\n그쪽 줄\n아래\n');
    expect(readFileSync(path.join(cwd, '하위 폴더', 'b.txt'), 'utf8')).toBe('같은 줄\r\n우리\r\n그쪽\r\n');
    expect(readFileSync(path.join(cwd, 'c.txt'), 'utf8')).toBe(broken);
    expect(callsOf(t.calls, 'report_conflict_resolved')[0]!.args.note).toContain('2/3');
    expect(resultOf(t.run)?.text).toContain('짝이 맞지 않아 그대로 두었습니다: c.txt');
  });
});

// ───────────────────────── 검수 ─────────────────────────

describe('모의 에이전트 — 검수', () => {
  for (const format of FORMATS) {
    it(`${format}: get_review_target → 모든 조건 통과로 submit_review`, async () => {
      const copy = await newDir('검수 사본');
      await mkdir(path.join(copy, 'wook-mock', 'T-0001'), { recursive: true });
      await writeFile(path.join(copy, 'wook-mock', 'T-0001', 'step-1.md'), '기록');
      const t = await turn({ format, ctx: reviewContext({ taskId: 'T-0001', reviewCopyPath: copy }), cwd: copy });
      expectCleanTurn(t);
      expect(toolNames(t.calls)).toEqual(['get_work_context', 'get_review_target', 'submit_review']);
      const args = callsOf(t.calls, 'submit_review')[0]!.args;
      expect(args).toMatchObject({ task_id: 'T-0001', verdict: 'pass' });
      expect(args.criteria).toEqual([
        { criterion: '로그인 화면이 보인다', pass: true, note: '모의 검수: 확인함 (작업 기록 1개)' },
        { criterion: '빈 입력을 막는다', pass: true, note: '모의 검수: 확인함 (작업 기록 1개)' },
      ]);
    });
  }

  it('triple_reject: 1차 검수에서는 반려, 2차에서는 통과', async () => {
    const copy = await newDir('검수 사본 반려');
    const r1 = await turn({ format: 'claude', scenario: 'triple_reject', ctx: reviewContext({ taskId: 'T-0001', reviewCopyPath: copy, round: 1 }), cwd: copy, setup: { reviewRound: 1, rejectsInRound: 2 } });
    expectCleanTurn(r1);
    const rej = callsOf(r1.calls, 'submit_review')[0]!.args;
    expect(rej.verdict).toBe('reject');
    expect(String(rej.reason)).toContain('1차 검수에서는 반려');
    expect(String(rej.reason)).toContain('3번째');
    expect((rej.criteria as { pass: boolean }[]).map((c) => c.pass)).toEqual([false, true]);
    const r2 = await turn({ format: 'claude', scenario: 'triple_reject', ctx: reviewContext({ taskId: 'T-0001', reviewCopyPath: copy, round: 2 }), cwd: copy, setup: { reviewRound: 2 } });
    expectCleanTurn(r2);
    expect(callsOf(r2.calls, 'submit_review')[0]!.args.verdict).toBe('pass');
  });

  for (const format of FORMATS) {
    it(`${format}: review_violation — 본인·미배정 작업 검수를 시도해 거부당한 뒤 정상 검수 (세션당 한 번)`, async () => {
      const stateDir = await newDir('위반 상태');
      // 프로듀서 계획으로 작업 목록(담당·검수자)을 같은 상태 폴더에 남긴다
      const plan = await turn({ format, stateDir, ctx: directiveContext({ kinds: ['plan'], team: [DEV, DOCS, QA] }) });
      expectCleanTurn(plan);
      const [devId, docsId, qaId] = callsOf(plan.calls, 'create_task').map((c) => (c.result.ok ? (c.result.data as { taskId: string }).taskId : ''));
      const copy = await newDir('검수 사본 위반');
      const ctx = reviewContext({ member: QA, taskId: devId!, reviewCopyPath: copy });
      const t = await turn({ format, stateDir, scenario: 'review_violation', ctx, cwd: copy });
      expect(t.run.exitCode).toBe(0);
      expectWellFormed(t.run);
      expect(toolNames(t.calls)).toEqual(['get_work_context', 'submit_review', 'submit_review', 'get_review_target', 'submit_review']);
      const reviews = callsOf(t.calls, 'submit_review');
      expect(reviews.map((c) => c.args.task_id)).toEqual([qaId, docsId, devId]);
      expect(reviews.map((c) => c.result.ok)).toEqual([false, false, true]);
      expect(resultOf(t.run)?.text).toMatch(/본인 작업\(.+\) 검수 등록이 거부되었습니다/);
      // 같은 세션의 다음 검수 턴에서는 다시 시도하지 않는다
      const again = await turn({ format, stateDir, scenario: 'review_violation', ctx, cwd: copy, agent: t.agent, resume: t.sessionId, turnNumber: 2 });
      expect(toolNames(again.calls)).toEqual(['get_work_context', 'get_review_target', 'submit_review']);
    });
  }

  it('review_violation: 작업 세션에서도 본인 작업 검수를 시도한 뒤 정상 작업', async () => {
    const t = await turn({ format: 'codex', scenario: 'review_violation', ctx: taskContext({ member: QA, task: taskCard({ id: 'T-0020', type: 'test' }) }) });
    expect(toolNames(t.calls).slice(0, 2)).toEqual(['get_work_context', 'submit_review']);
    expect(callsOf(t.calls, 'submit_review')[0]!.args.task_id).toBe('T-0020');
    expect(callsOf(t.calls, 'submit_review')[0]!.result.ok).toBe(false);
    expect(toolNames(t.calls).slice(-1)).toEqual(['submit_for_review']);
  });
});

// ───────────────────────── 프로듀서 ─────────────────────────

describe('모의 에이전트 — 프로듀서', () => {
  for (const format of FORMATS) {
    it(`${format}: plan — 프로듀서를 뺀 팀원마다 역할에 맞는 작업, QA는 개발 작업을 선행으로`, async () => {
      const t = await turn({ format, ctx: directiveContext({ kinds: ['plan'], team: [QA, DEV, PLANNER] }) });
      expectCleanTurn(t);
      const creates = callsOf(t.calls, 'create_task');
      expect(creates.map((c) => c.args.assignee_id)).toEqual([DEV.memberId, PLANNER.memberId, QA.memberId]);
      expect(creates.map((c) => [c.args.type, c.args.output_mode])).toEqual([
        ['development', 'repo'],
        ['spec', 'artifact'],
        ['test', 'repo'],
      ]);
      const devId = (creates[0]!.result as { data: { taskId: string } }).data.taskId;
      expect(creates[2]!.args.prerequisite_ids).toEqual([devId]);
      expect(creates[0]!.args.prerequisite_ids).toEqual([]);
      expect(creates.map((c) => c.args.request_id)).toEqual(creates.map((c) => `mock-plan-D-0001-r1-${String(c.args.assignee_id)}`));
      for (const c of creates) {
        expect(String(c.args.title)).toMatch(/^로그인 화면을 만들어 줘 — /);
        expect((c.args.acceptance_criteria as string[]).length).toBeGreaterThan(0);
        expect(c.args.directive_id).toBe('D-0001');
      }
      expect(resultOf(t.run)?.text).toContain('작업 3개');
    });
  }

  it('plan: 팀원이 없으면 프로듀서 자신에게, 수정 회차는 제목에 회차 표시', async () => {
    const t = await turn({ format: 'claude', ctx: directiveContext({ kinds: ['plan'], team: [], directive: directive({ round: 2 }) }) });
    expectCleanTurn(t);
    const creates = callsOf(t.calls, 'create_task');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args).toMatchObject({ assignee_id: PRODUCER.memberId, type: 'development', output_mode: 'repo', request_id: 'mock-plan-D-0001-r2-M-0001' });
    expect(String(creates[0]!.args.title)).toContain('(2회차 수정)');
    expect(String(creates[0]!.args.goal)).toContain('2회차 수정 요청');
  });

  it('plan: 사용자 정의 역할은 역할이 맡는 첫 작업 유형으로 — 에셋은 출력 방식을 정하지 않고(서버가 산출물형으로), 기본 역할은 작업 유형을 고쳐도 고정 표대로 (리드 결정 S5-15)', async () => {
    const SOUND: TeamMember = { memberId: 'M-0006', name: '사운드 정', roleId: 'role-0001', roleName: '사운드', canReview: false, taskTypes: ['asset', 'research'] };
    // 작업 유형을 보내지 않는 예전 서버의 사용자 정의 역할 — 이름으로 고른다
    const OLD: TeamMember = { memberId: 'M-0007', name: '조사 강', roleId: 'role-0002', roleName: '자료 조사', canReview: false };
    // 메인 에이전트가 기본 역할의 작업 유형을 고쳐도 그 역할의 작업은 고정 표대로
    const dev: TeamMember = { ...DEV, taskTypes: ['docs', 'development'] };
    const t = await turn({ format: 'codex', ctx: directiveContext({ kinds: ['plan'], team: [SOUND, OLD, dev] }) });
    expectCleanTurn(t);
    const creates = callsOf(t.calls, 'create_task');
    expect(creates.map((c) => [c.args.assignee_id, c.args.type, c.args.output_mode])).toEqual([
      [SOUND.memberId, 'asset', undefined],
      [OLD.memberId, 'research', 'artifact'],
      [DEV.memberId, 'development', 'repo'],
    ]);
    expect(Object.hasOwn(creates[0]!.args, 'output_mode')).toBe(false);
    expect(creates.every((c) => c.result.ok)).toBe(true);
    expect(String(creates[0]!.args.title)).toMatch(/ — 에셋$/);
    expect(creates[0]!.args.acceptance_criteria).toEqual(['요청한 에셋 산출물이 있다', '에셋의 사양과 쓰임새가 정리되어 있다']);
  });

  it('replan·answer·reviewer_assign·merge_decision을 한 턴에 묶어 처리한다', async () => {
    const tasks: WorkContext['tasks'] = [
      { id: 'T-0001', title: '개발', state: 'on_hold', assigneeId: DEV.memberId, reviewerId: PRODUCER.memberId, holdReasons: ['replan: 3회 반려'] },
      { id: 'T-0002', title: '문서', state: 'on_hold', assigneeId: DOCS.memberId, reviewerId: PRODUCER.memberId, holdReasons: ['blocked: 자료 없음'] },
      { id: 'T-0003', title: '테스트', state: 'on_hold', assigneeId: QA.memberId, reviewerId: PRODUCER.memberId, holdReasons: ['prereq_cancelled: 선행 작업 T-0009 취소'] },
      { id: 'T-0004', title: '검수 지연', state: 'in_review', assigneeId: DEV.memberId, reviewerId: QA.memberId, holdReasons: [] },
      { id: 'T-0005', title: '답변 대기', state: 'on_hold', assigneeId: DEV.memberId, reviewerId: null, holdReasons: ['answer_wait: 질문'] },
    ];
    const ctx = directiveContext({
      kinds: ['merge_decision', 'answer', 'replan', 'reviewer_assign'],
      team: [DEV, QA, DOCS],
      tasks,
      questions: [{ questionId: 'Q-0007', fromId: DEV.memberId, fromName: DEV.name, taskId: 'T-0005', text: '어느 화면부터 할까요?' }],
      mergeCandidates: [{ taskId: 'T-0006', title: '병합 후보', reviewerId: PRODUCER.memberId }],
      messages: ['병합 후보 T-0006', '질문 Q-0007', '재계획', 'T-0004 검수가 반복해서 등록되지 않았습니다'],
    });
    const t = await turn({ format: 'codex', ctx });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'answer_question', 'replan_task', 'resolve_hold', 'update_task', 'resolve_hold', 'assign_reviewer', 'request_merge']);
    expect(callsOf(t.calls, 'answer_question')[0]!.args.question_id).toBe('Q-0007');
    expect(callsOf(t.calls, 'resolve_hold').map((c) => c.args.kind)).toEqual(['blocked', 'prereq_cancelled']);
    expect(callsOf(t.calls, 'update_task')[0]!.args).toMatchObject({ task_id: 'T-0003', prerequisite_ids: [] });
    // 검수자는 작업자·현재 검수자가 아닌 검수 권한 팀원 (없으면 메인 에이전트 "main" — REV-06 v0.6)
    expect(callsOf(t.calls, 'assign_reviewer')[0]!.args).toMatchObject({ task_id: 'T-0004', reviewer_id: PRODUCER.memberId });
    expect(callsOf(t.calls, 'request_merge')[0]!.args.task_id).toBe('T-0006');
  });

  it('replan: 같은 작업은 3번까지만 재계획하고 그 뒤에는 대표 판단에 맡긴다 (spin 팀원과 끝없이 돌지 않게)', async () => {
    const stateDir = await newDir('재계획 상한');
    const tasks: WorkContext['tasks'] = [{ id: 'T-0008', title: '헛돌기 작업', state: 'on_hold', assigneeId: DEV.memberId, reviewerId: PRODUCER.memberId, holdReasons: ['replan: 헛돌기: 같은 오류 5회'] }];
    const ctx = directiveContext({ kinds: ['replan'], tasks });
    let prev: TurnResult | null = null;
    const counts: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const t: TurnResult = await turn({ format: 'claude', ctx, stateDir, agent: prev?.agent, resume: prev?.sessionId ?? null, turnNumber: i });
      expectCleanTurn(t);
      counts.push(callsOf(t.calls, 'replan_task').length);
      prev = t;
    }
    expect(counts).toEqual([1, 1, 1, 0]);
    expect(resultOf(prev!.run)?.text).toContain('대표 판단이 필요합니다');
  });

  it('지시 세션의 메시지는 확인만 한다', async () => {
    const t = await turn({ format: 'codex', ctx: directiveContext({ kinds: ['message'], messages: ['개발자 김(M-0002)의 메시지: 화면 시안을 올렸습니다'] }) });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context']);
    expect(resultOf(t.run)?.text).toContain('메시지 1건을 확인했습니다: 개발자 김(M-0002)의 메시지');
  });

  it('final_result: 작업 결과를 정리해 submit_final_result', async () => {
    const tasks: WorkContext['tasks'] = [
      { id: 'T-0001', title: '개발', state: 'done', assigneeId: DEV.memberId, reviewerId: PRODUCER.memberId, holdReasons: [] },
      { id: 'T-0002', title: '문서', state: 'cancelled', assigneeId: DOCS.memberId, reviewerId: PRODUCER.memberId, holdReasons: [] },
    ];
    const t = await turn({ format: 'claude', ctx: directiveContext({ kinds: ['final_result'], tasks }) });
    expectCleanTurn(t);
    const args = callsOf(t.calls, 'submit_final_result')[0]!.args;
    expect(args).toMatchObject({ directive_id: 'D-0001', outputs: ['T-0001 개발'], changed_files: ['wook-mock/T-0001/'], issues: ['T-0002 문서 취소됨'] });
    expect(String(args.summary)).toContain('작업 1개 완료, 1개 취소');
  });

  for (const format of FORMATS) {
    it(`${format}: revert — 병합 뒤 최종 결과 차례에 첫 병합 작업을 한 번만 되돌린다`, async () => {
      const stateDir = await newDir('되돌리기 상태');
      const merge = await turn({ format, stateDir, scenario: 'revert', ctx: directiveContext({ kinds: ['merge_decision'], mergeCandidates: [{ taskId: 'T-0001', title: '개발', reviewerId: PRODUCER.memberId }] }) });
      expectCleanTurn(merge);
      expect(toolNames(merge.calls)).toEqual(['get_work_context', 'request_merge']);
      const done: WorkContext['tasks'] = [
        { id: 'T-0001', title: '개발', state: 'done', assigneeId: DEV.memberId, reviewerId: PRODUCER.memberId, holdReasons: [] },
        { id: 'T-0002', title: '테스트', state: 'done', assigneeId: QA.memberId, reviewerId: PRODUCER.memberId, holdReasons: [] },
      ];
      const fin = await turn({ format, stateDir, scenario: 'revert', agent: merge.agent, resume: merge.sessionId, turnNumber: 2, ctx: directiveContext({ kinds: ['final_result'], tasks: done }) });
      expectCleanTurn(fin);
      expect(toolNames(fin.calls)).toEqual(['get_work_context', 'request_revert']);
      expect(callsOf(fin.calls, 'request_revert')[0]!.args.task_id).toBe('T-0001');
      // 되돌리기 작업까지 끝나 다시 최종 결과 차례가 오면 그때 결과를 낸다
      const after = await turn({
        format,
        stateDir,
        scenario: 'revert',
        agent: merge.agent,
        resume: merge.sessionId,
        turnNumber: 3,
        ctx: directiveContext({ kinds: ['final_result'], tasks: [...done, { id: 'T-0099', title: '[되돌리기] 개발', state: 'done', assigneeId: PRODUCER.memberId, reviewerId: QA.memberId, holdReasons: [] }] }),
      });
      expectCleanTurn(after);
      expect(toolNames(after.calls)).toEqual(['get_work_context', 'submit_final_result']);
    });
  }

  it('revert: 상태 기록이 없어도 최종 결과 안내의 "(병합 …)" 표시로 병합 작업을 찾는다', async () => {
    const tasks: WorkContext['tasks'] = [{ id: 'T-0005', title: '기능', state: 'done', assigneeId: DEV.memberId, reviewerId: PRODUCER.memberId, holdReasons: [] }];
    const message = turnMessage('directive:D-0001', [{ kind: 'final_result', message: '지시 D-0001 1회차의 작업이 모두 끝났습니다.\n- T-0005 기능: 완료 (병합 abcdef12)\n결과를 정리해 submit_final_result를 호출하세요.' }]);
    const t = await turn({ format: 'codex', scenario: 'revert', message, ctx: directiveContext({ kinds: ['final_result'], tasks }) });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'request_revert']);
  });
});

// ───────────────────────── 메인 에이전트 ─────────────────────────

describe('모의 에이전트 — 메인 에이전트', () => {
  for (const format of FORMATS) {
    it(`${format}: 프로젝트 명령 → register_directive (제목 = 첫 줄 40자)`, async () => {
      const text = '로그인 화면을 만들어 줘\n아이디·비밀번호 입력과 오류 표시가 필요해';
      const ctx = mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [ownerCommandMessage(text)] });
      const t = await turn({ format, ctx });
      expectCleanTurn(t);
      expect(toolNames(t.calls)).toEqual(['get_work_context', 'register_directive']);
      expect(callsOf(t.calls, 'register_directive')[0]!.args).toMatchObject({ project_id: 'P-0001', title: '로그인 화면을 만들어 줘', text });
      expect(resultOf(t.run)?.text).toContain('지시 D-0009을(를) 등록해 프로듀서에게 전달했습니다');
    });
  }

  it('수정 요청(change_request) → revise_directive로 다음 회차를 연다, 정지 해제(stop_released)·검수자 없음(no_reviewer)은 확인만 한다 (저절로 재개하지 않음)', async () => {
    const request = [
      '대표가 보고서 R-0002 "로그인 화면"에 수정 요청을 했습니다 (지시 D-0009 1회차):',
      '버튼 색을 파란색으로 바꿔 주세요',
      '다음 회차를 열려면 revise_directive(directive_id="D-0009", report_id="R-0002", instructions="프로듀서에게 줄 지시")를 호출하세요.',
    ].join('\n');
    const cr = await turn({ format: 'claude', ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['change_request'], messages: [request] }) });
    expectCleanTurn(cr);
    expect(toolNames(cr.calls)).toEqual(['get_work_context', 'revise_directive']);
    expect(callsOf(cr.calls, 'revise_directive')[0]!.args).toMatchObject({ directive_id: 'D-0009', report_id: 'R-0002', request_id: 'mock-revise-D-0009-R-0002' });
    const released = await turn({
      format: 'codex',
      ctx: mainContext({ sessionKey: 'main:general', kinds: ['stop_released'], messages: ['대표가 긴급 정지를 해제했습니다. 긴급 정지로 보류된 작업 2건은 저절로 재개되지 않습니다 (CTL-10).\n- T-0003 "로그인"\n- T-0004 "결제"'] }),
    });
    expectCleanTurn(released);
    expect(toolNames(released.calls)).toEqual(['get_work_context']);
    expect(resultOf(released.run)?.text).toContain('T-0003, T-0004');
    const none = await turn({ format: 'claude', ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['no_reviewer'], messages: ['T-0005 "로그인" 검수자 없음 — resume_task(task_id="T-0005")'] }) });
    expectCleanTurn(none);
    expect(toolNames(none.calls)).toEqual(['get_work_context']);
    // 대표에게만 가던 보류·실패를 넘겨받은 일(alert, SERVER_DESIGN 5.3) — 모의 메인도 아는 업무 종류다: 확인만 하고 저절로 처리하지 않는다
    const alert = await turn({
      format: 'codex',
      ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['alert'], messages: ['T-0006 "결제" — 병합 실패로 보류됨\n- 보류 사유(병합 보류): 병합 실패: git 오류\n원인을 확인한 뒤 resume_task(task_id="T-0006", reason="…")로 보류를 푸세요.'] }),
    });
    expectCleanTurn(alert);
    expect(toolNames(alert.calls)).toEqual(['get_work_context']);
    expect(resultOf(alert.run)?.text).toContain('보류·실패 1건을 넘겨받았습니다: T-0006 "결제" — 병합 실패로 보류됨');
    expect(resultOf(alert.run)?.text).not.toContain('처리할 수 없는 업무 종류');
    // 실제 메인 턴은 알림 업무를 다른 업무와 묶어 싣는다 — "### n. 보류·실패 처리" 구간으로 원문을 가른다 (S5-7)
    const alertText = 'T-0007 "정산" — 작업 공간 생성 실패로 보류됨\n- 보류 사유(오류): 작업 공간 생성 실패: 디스크 부족';
    const mem = '대표가 보고서 R-0003 "정산"에 수정 요청을 했습니다:\n표를 줄여 주세요\n드러난 선호를 프로젝트 기억에 반영하세요.';
    const both = await turn({ format: 'claude', ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['alert', 'memory_update'], messages: [alertText, mem] }) });
    expectCleanTurn(both);
    expect(toolNames(both.calls)).toEqual(['get_work_context', 'read_memory', 'write_memory']);
    expect(both.run.events.map((e) => e.text).join('\n')).toContain('보류·실패 1건을 넘겨받았습니다: T-0007 "정산" — 작업 공간 생성 실패로 보류됨');
    expect(String(callsOf(both.calls, 'write_memory')[0]!.args.content)).not.toContain('작업 공간 생성 실패');
  });

  it('지시 제목은 첫 문장으로 하고, 길면 단어 경계에서 잘라 말줄임표를 붙인다', async () => {
    const sentence = await turn({ format: 'claude', ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [ownerCommandMessage('카페 게임 첫 화면을 만들어 줘. 메뉴판 디자인, 주문 버튼까지.')] }) });
    expectCleanTurn(sentence);
    expect(callsOf(sentence.calls, 'register_directive')[0]!.args.title).toBe('카페 게임 첫 화면을 만들어 줘');
    const words = '메뉴판 화면에 가격표와 할인 배지와 품절 표시와 추천 메뉴 강조와 계절 한정 메뉴 섹션을 추가해 줘';
    const long = await turn({ format: 'claude', ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [ownerCommandMessage(words)] }) });
    expectCleanTurn(long);
    const title = String(callsOf(long.calls, 'register_directive')[0]!.args.title);
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith('…')).toBe(true);
    expect(words.startsWith(title.slice(0, -1))).toBe(true);
    expect(words.charAt(title.length - 1)).toBe(' ');
    const noSpace = '가'.repeat(30) + '나'.repeat(30);
    const hard = await turn({ format: 'claude', ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [ownerCommandMessage(noSpace)] }) });
    expect(callsOf(hard.calls, 'register_directive')[0]!.args.title).toBe(`${noSpace.slice(0, 39)}…`);
  });

  for (const format of FORMATS) {
    it(`${format}: [질문]이 있으면 ask_owner 후 턴 종료, 답이 오면 원래 명령으로 지시 등록`, async () => {
      const text = '[질문] 관리 화면을 고쳐 줘';
      const ask = await turn({ format, ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [ownerCommandMessage(text)] }) });
      expectCleanTurn(ask);
      expect(toolNames(ask.calls)).toEqual(['get_work_context', 'ask_owner']);
      expect(String(callsOf(ask.calls, 'ask_owner')[0]!.args.question)).toContain('관리 화면을 고쳐 줘');
      const answer = '질문 Q-0002에 대한 답변 (대표): 목록 화면부터 해 주세요';
      const reg = await turn({
        format,
        agent: ask.agent,
        stateDir: ask.stateDir,
        cwd: ask.cwd,
        resume: ask.sessionId,
        turnNumber: 2,
        ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [answer] }),
      });
      expectCleanTurn(reg);
      const args = callsOf(reg.calls, 'register_directive')[0]!.args;
      expect(args.title).toBe('관리 화면을 고쳐 줘');
      expect(String(args.text)).toContain('관리 화면을 고쳐 줘');
      expect(String(args.text)).toContain('목록 화면부터 해 주세요');
    });
  }

  it('일반 세션(main:general): 텍스트로 답하고 지시 없는 submit_report', async () => {
    const ctx = mainContext({ sessionKey: 'main:general', kinds: ['main_command'], messages: [ownerCommandMessage('오늘 할 일을 정리해 줘', null)] });
    const t = await turn({ format: 'codex', ctx });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'submit_report']);
    const args = callsOf(t.calls, 'submit_report')[0]!.args;
    expect(args.directive_id).toBeUndefined();
    expect(args.title).toBe('오늘 할 일을 정리해 줘');
    expect(ofKind(t.run.events, 'text').some((e) => e.text.includes('직접 명령을 처리했습니다'))).toBe(true);
  });

  it('main_report: 안내의 지시 ID·요약·변경 파일로 submit_report', async () => {
    const msg = [
      '프로듀서 프로듀서 한이(가) 지시 D-0003 "로그인" 1회차 결과를 제출했습니다. 정리해서 submit_report(directive_id="D-0003")로 대표에게 보고하세요.',
      '요약: 로그인 화면과 테스트를 마쳤습니다',
      '변경 파일:\n- src/login.ts\n- src/login.test.ts',
    ].join('\n');
    const ctx = mainContext({ sessionKey: 'main:P-0001', kinds: ['main_report'], messages: [msg], directive: directive({ id: 'D-0003', title: '로그인' }) });
    const t = await turn({ format: 'claude', ctx });
    expectCleanTurn(t);
    expect(callsOf(t.calls, 'submit_report')[0]!.args).toMatchObject({
      directive_id: 'D-0003',
      title: '로그인 — 1회차 결과',
      summary: '로그인 화면과 테스트를 마쳤습니다',
      changed_files: ['src/login.ts', 'src/login.test.ts'],
    });
  });

  it('memory_update: read_memory → 대표 선호 구간에 한 줄 추가해 write_memory', async () => {
    const memory = '# 테스트 프로젝트 기억\n\n## 목표\n로그인\n\n## 대표 선호\n- 짧은 보고\n\n## 기타\n끝\n';
    const msg = '대표가 보고서 R-0001 "로그인"을(를) 결과 승인했습니다. 코멘트: 버튼은 파란색이 좋아요 드러난 선호가 있으면 프로젝트 기억에 반영하세요.';
    const ctx = mainContext({ sessionKey: 'main:P-0001', kinds: ['memory_update'], messages: [msg] });
    const t = await turn({ format: 'codex', ctx, setup: { memory } });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'read_memory', 'write_memory']);
    expect(callsOf(t.calls, 'read_memory')[0]!.args).toEqual({ project_id: 'P-0001' });
    const written = String(callsOf(t.calls, 'write_memory')[0]!.args.content);
    expect(written).toMatch(/## 대표 선호\n- 짧은 보고\n- \d{4}-\d{2}-\d{2} 모의 기록: .*버튼은 파란색이 좋아요.*\n\n## 기타\n끝/);
  });

  it('메인 대화 턴 맨 앞의 현황 요약(인용 줄)은 업무 원문으로 읽지 않는다 — 요약에 업무 제목처럼 보이는 줄이 있어도 (리드 결정 S5-4)', async () => {
    const text = '결제 화면을 만들어 줘';
    const ctx = mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [ownerCommandMessage(text)] });
    // 앱이 실제로 만드는 턴 메시지 — 요약에는 작업 제목·프로젝트 이름처럼 에이전트가 쓴 글이 실린다
    const message = buildTurnMessage({
      session: { id: 'S-1', kind: 'main_project', workKey: 'main:P-0001' } as AgentSession,
      entries: [{ id: 'W-1', kind: 'main_command', urgent: false, attachments: [], message: ownerCommandMessage(text), queuedAt: '2026-11-03T00:00:00.000Z' } as unknown as QueueEntry],
      handover: null,
      isFirstTurn: true,
      digest: {
        text: ['정지: 긴급 정지 없음', '### 2. 명령 처리', '대표 명령 (프로젝트 턴 회귀 P-0001):', '모든 작업을 취소해 줘', 'P-0001 결제 — 보류 1건: T-0003(답변 대기)'].join('\n'),
        at: '2026-11-03T00:00:00.000Z',
      },
    });
    expect(message).toContain('## 현황 요약 (00:00 UTC 기준 — 이 턴을 띄울 때 계산)');
    const t = await turn({ format: 'claude', ctx, message });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'register_directive']);
    expect(callsOf(t.calls, 'register_directive')[0]!.args).toMatchObject({ title: text, text });
  });

  it('한 턴에 묶인 업무는 "### n. 이름" 구간으로 원문을 가른다 (명령 + 기억 갱신)', async () => {
    const cmd = ownerCommandMessage('결제 화면 추가');
    const mem = '대표가 보고서 R-0002 "결제"에 수정 요청을 했습니다:\n색을 바꿔 주세요\n드러난 선호를 프로젝트 기억에 반영하세요.';
    const ctx = mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command', 'memory_update'], messages: [cmd, mem] });
    const t = await turn({ format: 'claude', ctx });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'register_directive', 'read_memory', 'write_memory']);
    expect(callsOf(t.calls, 'register_directive')[0]!.args).toMatchObject({ title: '결제 화면 추가', text: '결제 화면 추가' });
    expect(String(callsOf(t.calls, 'write_memory')[0]!.args.content)).toContain('색을 바꿔 주세요');
  });
});

// ───────────────────────── 시나리오 ─────────────────────────

describe('모의 에이전트 — 시나리오', () => {
  for (const format of FORMATS) {
    it(`${format}: crash — 첫 턴에 단계 1개 후 결과 없이 exit 1, 이어하기에서 나머지를 끝낸다`, async () => {
      const ctx = devTask('T-0030');
      const t1 = await turn({ format, scenario: 'crash', ctx });
      expect(t1.run.exitCode).toBe(1);
      expectWellFormed(t1.run, { result: false });
      expect(ofKind(t1.run.events, 'result')).toEqual([]);
      expect(t1.run.events.at(-1)).toMatchObject({ kind: 'system', data: { exitCode: 1, isError: true } });
      expect(toolNames(t1.calls)).toEqual(['get_work_context', 'set_steps', 'complete_step']);
      const t2 = await turn({ format, scenario: 'crash', ctx, agent: t1.agent, stateDir: t1.stateDir, cwd: t1.cwd, resume: t1.sessionId, turnNumber: 2 });
      expectCleanTurn(t2);
      expect(t2.sessionId).toBe(t1.sessionId);
      expect(t2.run.events[0]!.data?.cliSessionId).toBe(t1.sessionId);
      expect(toolNames(t2.calls)).toEqual(['get_work_context', 'complete_step', 'complete_step', 'submit_for_review']);
      expect(callsOf(t2.calls, 'complete_step').map((c) => c.args.step_index)).toEqual([1, 2]);
    });
  }

  it('crash: 작업이 아닌 세션은 업무 정보만 받고 끊긴 뒤 다음 턴에 처리한다', async () => {
    const ctx = directiveContext({ kinds: ['plan'], team: [DEV] });
    const t1 = await turn({ format: 'claude', scenario: 'crash', ctx });
    expect(t1.run.exitCode).toBe(1);
    expect(toolNames(t1.calls)).toEqual(['get_work_context']);
    const t2 = await turn({ format: 'claude', scenario: 'crash', ctx, agent: t1.agent, stateDir: t1.stateDir, resume: t1.sessionId, turnNumber: 2 });
    expectCleanTurn(t2);
    expect(toolNames(t2.calls)).toEqual(['get_work_context', 'create_task']);
  });

  it('crash_loop: 매 턴 결과 없이 exit 1', async () => {
    const ctx = devTask('T-0031');
    const t1 = await turn({ format: 'codex', scenario: 'crash_loop', ctx });
    const t2 = await turn({ format: 'codex', scenario: 'crash_loop', ctx, agent: t1.agent, stateDir: t1.stateDir, resume: t1.sessionId, turnNumber: 2 });
    for (const t of [t1, t2]) {
      expect(t.run.exitCode).toBe(1);
      expect(ofKind(t.run.events, 'result')).toEqual([]);
      expect(toolNames(t.calls)).toEqual(['get_work_context']);
    }
  });

  for (const format of FORMATS) {
    it(`${format}: hang — 첫 턴에 출력한 뒤 끝나지 않는다, 다음 턴은 정상`, async () => {
      const ctx = devTask('T-0032');
      const t1 = await turn({ format, scenario: 'hang', ctx, run: { killAfterMs: 1500 } });
      expect(t1.run.killed).toBe(true);
      expect(t1.run.durationMs).toBeGreaterThanOrEqual(1400);
      expectWellFormed(t1.run, { result: false });
      expect(ofKind(t1.run.events, 'text').map((e) => e.text)).toEqual(['업무를 시작합니다. 필요한 정보를 확인하는 중입니다…']);
      expect(ofKind(t1.run.events, 'result')).toEqual([]);
      expect(t1.calls).toEqual([]);
      const t2 = await turn({ format, scenario: 'hang', ctx, agent: t1.agent, stateDir: t1.stateDir, resume: t1.sessionId, turnNumber: 2 });
      expectCleanTurn(t2);
      expect(callsOf(t2.calls, 'submit_for_review')).toHaveLength(1);
    });
  }

  for (const format of FORMATS) {
    it(`${format}: spin — 같은 명령 실패 5회, 단계 진척 없음 (매 턴)`, async () => {
      const ctx = devTask('T-0033');
      for (const turnNumber of [1, 2]) {
        const t = await turn({ format, scenario: 'spin', ctx, turnNumber });
        expect(t.run.exitCode).toBe(0);
        expectWellFormed(t.run);
        expect(callsOf(t.calls, 'complete_step')).toEqual([]);
        expect(callsOf(t.calls, 'submit_for_review')).toEqual([]);
        const ends = ofKind(t.run.events, 'command_end');
        expect(ends).toHaveLength(5);
        expect(new Set(ends.map((e) => e.data?.command)).size).toBe(1);
        expect(ends.every((e) => e.data?.exitCode === 1 && e.data?.ok === false)).toBe(true);
        expect(ofKind(t.run.events, 'command_start')).toHaveLength(5);
      }
    });
  }

  for (const format of FORMATS) {
    it(`${format}: bypass_mismatch — ${format === 'claude' ? "init permissionMode 'default'" : '권한 확인 오류'}, 앱 도구는 부르지 않는다`, async () => {
      const t = await turn({ format, scenario: 'bypass_mismatch', ctx: devTask('T-0034') });
      expect(t.run.exitCode).toBe(0);
      expectWellFormed(t.run);
      expect(t.calls).toEqual([]);
      const session = t.run.events[0]!;
      if (format === 'claude') expect(session.data?.permissionMode).toBe('default');
      const errors = ofKind(t.run.events, 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.data?.errorKind).toBe('permission');
      expect(resultOf(t.run)?.data?.permissionDenials).toBe(1);
      expect(existsSync(path.join(t.cwd, 'wook-mock'))).toBe(false);
    });
  }

  for (const format of FORMATS) {
    it(`${format}: answer_wait — 첫 턴에 ask_producer 후 종료, 답변 뒤 턴은 정상`, async () => {
      const ctx = devTask('T-0035');
      const t1 = await turn({ format, scenario: 'answer_wait', ctx });
      expectCleanTurn(t1);
      expect(toolNames(t1.calls)).toEqual(['get_work_context', 'ask_producer']);
      expect(String(callsOf(t1.calls, 'ask_producer')[0]!.args.question)).toContain('T-0035');
      const t2 = await turn({ format, scenario: 'answer_wait', ctx, agent: t1.agent, stateDir: t1.stateDir, cwd: t1.cwd, resume: t1.sessionId, turnNumber: 2 });
      expectCleanTurn(t2);
      expect(callsOf(t2.calls, 'ask_producer')).toEqual([]);
      expect(callsOf(t2.calls, 'complete_step')).toHaveLength(3);
    });
  }

  for (const format of FORMATS) {
    it(`${format}: usage_limit — 첫 턴에 한도 오류(usage_limit·해제 시각), 다음 턴은 정상`, async () => {
      const ctx = devTask('T-0036');
      const t1 = await turn({ format, scenario: 'usage_limit', ctx });
      expect(t1.run.exitCode).toBe(1);
      expectWellFormed(t1.run);
      expect(t1.calls).toEqual([]);
      const errors = ofKind(t1.run.events, 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.data?.errorKind).toBe('usage_limit');
      const resetMs = Date.parse(errors[0]!.data!.resetAt!) - Date.now();
      expect(resetMs).toBeGreaterThan(25 * 60_000);
      expect(resetMs).toBeLessThan(35 * 60_000);
      expect(resultOf(t1.run)?.data).toMatchObject({ isError: true, errorKind: 'usage_limit' });
      const t2 = await turn({ format, scenario: 'usage_limit', ctx, agent: t1.agent, stateDir: t1.stateDir, resume: t1.sessionId, turnNumber: 2 });
      expectCleanTurn(t2);
    });
  }

  it('merge_conflict: 저장소 최상위 conflict-zone.txt에 팀원별 내용을 쓴다', async () => {
    const t = await turn({ format: 'claude', scenario: 'merge_conflict', ctx: devTask('T-0037') });
    expectCleanTurn(t);
    const zone = readFileSync(path.join(t.cwd, 'conflict-zone.txt'), 'utf8');
    expect(zone).toContain(`(${DEV.memberId})`);
    expect(zone).toContain('T-0037');
    expect(ofKind(t.run.events, 'file_change').flatMap((e) => e.data?.paths ?? [])).toContain(path.join(t.cwd, 'conflict-zone.txt'));
  });

  for (const format of FORMATS) {
    it(`${format}: duplicate_tool — 같은 request_id로 complete_step·submit_for_review를 두 번 보낸다`, async () => {
      const t = await turn({ format, scenario: 'duplicate_tool', ctx: devTask('T-0038') });
      expectCleanTurn(t);
      const steps = callsOf(t.calls, 'complete_step');
      expect(steps).toHaveLength(6);
      for (let i = 0; i < 6; i += 2) {
        expect(steps[i]!.args).toEqual(steps[i + 1]!.args);
        expect(steps[i + 1]!.result).toMatchObject({ ok: true, data: { duplicateRequest: true } });
      }
      expect(new Set(steps.map((c) => c.args.request_id)).size).toBe(3);
      const submits = callsOf(t.calls, 'submit_for_review');
      expect(submits).toHaveLength(2);
      expect(submits[0]!.args.request_id).toBe(submits[1]!.args.request_id);
    });
  }

  it('보통 실행은 상태 변경 요청마다 다른 request_id를 쓴다', async () => {
    const t = await turn({ format: 'codex', ctx: devTask('T-0039') });
    const ids = t.calls.filter((c) => typeof c.args.request_id === 'string').map((c) => c.args.request_id);
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('속도: WOOK_MOCK_SPEED 배수만큼 단계 간격이 줄고, slow는 5배 느리다', async () => {
    const gap = (t: TurnResult) => {
      const at = callsOf(t.calls, 'complete_step').map((c) => c.at);
      return at[2]! - at[0]!;
    };
    const slowSpeed = await turn({ format: 'claude', speed: 4, ctx: devTask('T-0040') }); // 단계당 250ms
    const fast = await turn({ format: 'claude', speed: 1000, ctx: devTask('T-0041') }); // 최소 20ms
    const slowScenario = await turn({ format: 'claude', speed: 20, scenario: 'slow', ctx: devTask('T-0042') }); // 50ms × 5
    expect(gap(slowSpeed)).toBeGreaterThanOrEqual(450);
    expect(gap(fast)).toBeLessThan(300);
    expect(gap(slowScenario)).toBeGreaterThanOrEqual(450);
  });
});

// ───────────────────────── 세션·이어하기 ─────────────────────────

describe('모의 에이전트 — 세션·이어하기', () => {
  for (const format of FORMATS) {
    it(`${format}: 이어하기는 같은 세션 ID로 시작 이벤트를 낸다`, async () => {
      const t1 = await turn({ format, ctx: devTask('T-0050', { state: 'in_review' }) });
      const t2 = await turn({ format, ctx: devTask('T-0050', { state: 'in_review' }), agent: t1.agent, stateDir: t1.stateDir, resume: t1.sessionId, turnNumber: 2 });
      expectCleanTurn(t2);
      expect(t2.run.events[0]!.data?.cliSessionId).toBe(t1.sessionId);
      expect(JSON.parse(t2.run.stdout[0]!)).toMatchObject(format === 'claude' ? { type: 'system', subtype: 'init', session_id: t1.sessionId } : { type: 'thread.started', thread_id: t1.sessionId });
    });
  }

  for (const format of FORMATS) {
    it(`${format}: 없는 세션을 이어하면 실제 CLI처럼 이어하기 실패(resumeFailed)로 끝난다`, async () => {
      const missing = randomUUID();
      const t = await turn({ format, ctx: devTask('T-0051'), resume: missing });
      expect(t.run.exitCode).toBe(1);
      expect(t.calls).toEqual([]);
      const failed = t.run.events.filter((e) => e.data?.resumeFailed === true);
      expect(failed.length).toBeGreaterThan(0);
      expect(t.run.stderr.join('\n')).toContain(missing);
      expect(unknownEvents(t.run.events)).toEqual([]);
    });
  }

  it('claude: 이미 쓴 --session-id는 다시 쓸 수 없고, UUID가 아니면 거부한다 (실제 CLI와 같음)', async () => {
    const t1 = await turn({ format: 'claude', ctx: devTask('T-0052', { state: 'in_review' }) });
    const reuse = await turn({ format: 'claude', ctx: devTask('T-0052', { state: 'in_review' }), agent: t1.agent, stateDir: t1.stateDir, newSessionId: t1.sessionId });
    expect(reuse.run.exitCode).toBe(1);
    expect(reuse.run.stdout).toEqual([]);
    expect(reuse.run.stderr).toEqual([`Error: Session ID ${t1.sessionId} is already in use.`]);
    const invalid = await turn({ format: 'claude', ctx: devTask('T-0052', { state: 'in_review' }), run: { argsOverride: ['--format', 'claude', '--session-id', 'not-a-uuid'] } });
    expect(invalid.run.exitCode).toBe(1);
    expect(invalid.run.stderr).toEqual(['Error: Invalid session ID. Must be a valid UUID.']);
  });

  it('잘못된 인자는 exit 2 + 오류 한 줄', async () => {
    for (const [args, msg] of [
      [['--session-id', randomUUID()], '--format claude|codex가 필요합니다'],
      [['--format', 'claude', '--bogus', 'x'], '알 수 없는 인자입니다: --bogus'],
      [['--format', 'codex', '--resume'], '--resume 값이 없습니다'],
      [['--format', 'codex', '--session-id', 'a', '--resume', 'b'], '--session-id와 --resume은 함께 쓸 수 없습니다'],
    ] as const) {
      const t = await turn({ format: 'claude', ctx: devTask('T-0053'), run: { argsOverride: [...args] } });
      expect(t.run.exitCode).toBe(2);
      expect(t.run.stdout).toEqual([]);
      expect(t.run.stderr).toEqual([`Error: ${msg}`]);
    }
  });

  it('상태 폴더 없이 직접 실행하면 첫 턴 판정을 WOOK_MOCK_TURN으로 하고, 이어하기 확인은 하지 않는다', async () => {
    const ctx = devTask('T-0054');
    const first = await turn({ format: 'codex', scenario: 'crash', ctx, run: { envOverride: { WOOK_MOCK_STATE_DIR: undefined } } });
    expect(first.run.exitCode).toBe(1);
    expect(callsOf(first.calls, 'complete_step')).toHaveLength(1);
    const second = await turn({ format: 'codex', scenario: 'crash', ctx, agent: first.agent, resume: randomUUID(), turnNumber: 2, run: { envOverride: { WOOK_MOCK_STATE_DIR: undefined } } });
    expectCleanTurn(second);
    expect(callsOf(second.calls, 'complete_step')).toHaveLength(2);
  });

  it('알 수 없는 시나리오·속도 값은 경고하고 normal·1배로 진행한다', async () => {
    const t = await turn({ format: 'claude', ctx: devTask('T-0055', { state: 'in_review' }), run: { envOverride: { WOOK_MOCK_SCENARIO: 'nope', WOOK_MOCK_SPEED: 'fast' } } });
    expect(t.run.exitCode).toBe(0);
    expectWellFormed(t.run);
    expect(t.run.stderr).toEqual(["모의 에이전트: 알 수 없는 시나리오 'nope' — normal로 진행합니다", "모의 에이전트: 속도 값이 올바르지 않습니다 ('fast') — 1배로 진행합니다"]);
    expect(ofKind(t.run.events, 'error')).toEqual([]);
  });
});

// ───────────────────────── 앱 도구 연결 ─────────────────────────

describe('모의 에이전트 — 앱 도구 연결', () => {
  it('SSE·세션 서버: 세션 ID와 프로토콜 버전을 되돌려 보내고 SSE 응답을 해석한다', async () => {
    const t = await turn({ format: 'codex', ctx: devTask('T-0060'), server: 'sse' });
    expectCleanTurn(t);
    const log = sse.httpLog.filter((h) => h.agent === t.agent);
    expect(log[0]).toMatchObject({ rpcMethod: 'initialize', sessionIdHeader: null, status: 200 });
    expect(log[0]!.contentType).toContain('text/event-stream');
    expect(log[1]).toMatchObject({ rpcMethod: 'notifications/initialized', status: 202 });
    for (const h of log.slice(1)) {
      expect(h.sessionIdHeader).toMatch(/^[0-9a-f-]{36}$/);
      expect(h.protocolVersionHeader).toBe('2025-06-18');
    }
    expect(log.filter((h) => h.rpcMethod === 'tools/call')).toHaveLength(t.calls.length);
  });

  it('JSON·세션 없는 서버에서도 같은 흐름', async () => {
    const t = await turn({ format: 'claude', ctx: devTask('T-0061'), server: 'json' });
    expectCleanTurn(t);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'set_steps', 'complete_step', 'complete_step', 'complete_step', 'submit_for_review']);
    const log = json.httpLog.filter((h) => h.agent === t.agent);
    expect(log.every((h) => h.sessionIdHeader === null)).toBe(true);
    expect(log.find((h) => h.rpcMethod === 'tools/call')!.contentType).toContain('application/json');
  });

  async function closedUrl(): Promise<string> {
    const s = await startFakeMcp(new FakeWork(), { style: 'json' });
    await s.stop();
    return s.url;
  }

  it('claude: 서버에 연결하지 못하면 init에 failed로 알리고 턴은 결과로 끝난다', async () => {
    const t = await turn({ format: 'claude', ctx: devTask('T-0062'), url: await closedUrl() });
    expect(t.run.exitCode).toBe(0);
    expectWellFormed(t.run);
    expect(t.run.events[0]!.data?.mcpServers).toEqual([{ name: 'wook', status: 'failed' }]);
    expect(ofKind(t.run.events, 'error').map((e) => e.data?.errorKind)).toEqual(['mcp']);
    expect(resultOf(t.run)?.text).toContain('앱 도구 서버(wook)에 연결하지 못해');
    // Claude는 연결 실패에도 세션이 남으므로 다음 턴은 이어할 수 있다
    const next = await turn({ format: 'claude', ctx: devTask('T-0062'), agent: t.agent, stateDir: t.stateDir, resume: t.sessionId, turnNumber: 2 });
    expectCleanTurn(next);
  });

  it('codex: 필수 앱 도구 서버 연결 실패로 시작하지 못한다 (stderr, exit 1) — 스레드가 없어 이어할 수도 없다', async () => {
    const t = await turn({ format: 'codex', ctx: devTask('T-0063'), url: await closedUrl() });
    expect(t.run.exitCode).toBe(1);
    expect(t.run.stdout).toEqual([]);
    expect(t.run.stderr.join('\n')).toContain('required MCP servers failed to initialize: wook');
    expect(ofKind(t.run.events, 'error').map((e) => e.data?.errorKind)).toEqual(['mcp']);
    const next = await turn({ format: 'codex', ctx: devTask('T-0063'), agent: t.agent, stateDir: t.stateDir, resume: t.sessionId, turnNumber: 2 });
    expect(next.run.exitCode).toBe(1);
    expect(next.run.events.some((e) => e.data?.resumeFailed === true)).toBe(true);
  });

  it('모르는 토큰(401)도 연결 실패로 다룬다', async () => {
    const t = await turn({ format: 'claude', ctx: devTask('T-0064'), token: 'tok-unknown' });
    expect(t.run.exitCode).toBe(0);
    expect(t.run.events[0]!.data?.mcpServers).toEqual([{ name: 'wook', status: 'failed' }]);
    expect(resultOf(t.run)?.text).toContain('HTTP 401');
  });

  it('도구가 거부(isError)해도 죽지 않고 결과를 글로 알린다', async () => {
    const ctx = devTask('T-0065', { steps: [{ idx: 0, title: '하나', done: false }] });
    const t = await turn({ format: 'codex', ctx, setup: { failTools: { complete_step: '모의 거부: 이 단계는 지금 완료할 수 없습니다' } } });
    expect(t.run.exitCode).toBe(0);
    expectWellFormed(t.run);
    expect(toolNames(t.calls)).toEqual(['get_work_context', 'complete_step']);
    const failed = ofKind(t.run.events, 'tool_result').find((e) => e.data?.tool === 'complete_step');
    expect(failed?.data?.ok).toBe(false);
    expect(resultOf(t.run)?.text).toContain('모의 거부');
  });
});

// ───────────────────────── 앱 실행 환경 (Electron 내장 Node) ─────────────────────────

/** 앱은 Electron 실행 파일을 ELECTRON_RUN_AS_NODE=1로 써서 모의 에이전트를 띄운다 (buildDeps nodeExecPath/nodeExecEnv) */
function electronBinary(): string | null {
  try {
    const p = createRequire(import.meta.url)('electron') as unknown;
    return typeof p === 'string' && existsSync(p) ? p : null;
  } catch {
    return null; // electron 패키지가 없는 환경(CI 등) — 아래 시험을 건너뛴다
  }
}
const ELECTRON = electronBinary();

describe.skipIf(!ELECTRON)('모의 에이전트 — Electron 내장 Node로 실행', () => {
  for (const format of FORMATS) {
    it(`${format}: ELECTRON_RUN_AS_NODE=1로도 같은 턴을 끝낸다`, async () => {
      const electronAdapter = createMockAdapter({ nodeExecPath: ELECTRON!, nodeExecEnv: { ELECTRON_RUN_AS_NODE: '1' }, scriptPath: SCRIPT });
      const agent = `tok-${randomUUID()}`;
      const ctx = devTask('T-0080');
      work.register(agent, { ctx });
      const cwd = await newDir('일렉트론 작업 폴더');
      const launch = makeLaunch({ format, ctx }, { agent, cwd, stateDir: await newDir('일렉트론 상태') });
      const before = work.calls.length;
      const run = await runMockTurn(electronAdapter, launch);
      const calls = work.calls.slice(before).filter((c) => c.agent === agent);
      expectCleanTurn({ run, agent, calls, cwd, stateDir: launch.mock!.stateDir, launch, sessionId: run.prepared.expectedCliSessionId! });
      expect(toolNames(calls)).toEqual(['get_work_context', 'set_steps', 'complete_step', 'complete_step', 'complete_step', 'submit_for_review']);
    });
  }
});

// ───────────────────────── 실제 앱 도구 서버 ─────────────────────────

describe('모의 에이전트 — 실제 앱 도구 서버(mcp/server.ts)와 호환', () => {
  const codes = ['forbidden', 'invalid', 'conflict', 'not_found', 'stopped', 'error'] as const;
  const toToolResult = (r: ReturnType<FakeWork['handle']>): ToolCallResult =>
    r.ok ? { ok: true, data: r.data } : { ok: false, code: codes.find((c) => c === r.code) ?? 'error', message: r.message };

  for (const format of FORMATS) {
    it(`${format}: 작업·검수 흐름이 실제 서버의 역할별 도구 공개·입력 검사를 통과한다`, async () => {
      const logs: ToolCallLog[] = [];
      const server = createAppToolServer({ handler: async (identity, tool, args) => toToolResult(work.handle(identity.turnId, tool, args)), onCall: (l) => logs.push(l) });
      const { url } = await server.start();
      try {
        const member: TokenIdentity = { turnId: `TN-${randomUUID()}`, sessionId: 'S-000001', sessionKey: 'task:T-0070', sessionKind: 'task', memberId: DEV.memberId, projectId: 'P-0001', isMain: false, isProducer: false, canReview: false };
        const t = await turn({ format, ctx: devTask('T-0070'), agent: member.turnId, url, token: server.issueToken(member) });
        expectCleanTurn(t);
        expect(toolNames(t.calls)).toEqual(['get_work_context', 'set_steps', 'complete_step', 'complete_step', 'complete_step', 'submit_for_review']);

        const reviewer: TokenIdentity = { ...member, turnId: `TN-${randomUUID()}`, sessionKey: 'review:T-0070', sessionKind: 'review', memberId: QA.memberId, canReview: true };
        const copy = await newDir('실서버 검수 사본');
        const r = await turn({ format, ctx: reviewContext({ member: QA, taskId: 'T-0070', reviewCopyPath: copy }), cwd: copy, agent: reviewer.turnId, url, token: server.issueToken(reviewer) });
        expectCleanTurn(r);
        expect(toolNames(r.calls)).toEqual(['get_work_context', 'get_review_target', 'submit_review']);

        const producer: TokenIdentity = { ...member, turnId: `TN-${randomUUID()}`, sessionKey: 'directive:D-0001', sessionKind: 'directive', memberId: PRODUCER.memberId, isProducer: true, canReview: true };
        const p = await turn({ format, ctx: directiveContext({ kinds: ['plan'], team: [DEV, QA] }), agent: producer.turnId, url, token: server.issueToken(producer) });
        expectCleanTurn(p);
        expect(callsOf(p.calls, 'create_task')).toHaveLength(2);

        const main: TokenIdentity = { ...member, turnId: `TN-${randomUUID()}`, sessionKey: 'main:P-0001', sessionKind: 'main_project', memberId: 'M-MAIN', isMain: true };
        const m = await turn({ format, ctx: mainContext({ sessionKey: 'main:P-0001', kinds: ['main_command'], messages: [ownerCommandMessage('대시보드 만들기')] }), agent: main.turnId, url, token: server.issueToken(main) });
        expectCleanTurn(m);
        expect(toolNames(m.calls)).toEqual(['get_work_context', 'register_directive']);
        // 서버 기록: 모든 호출이 처리기까지 갔다 (입력 검사·역할 거부 없음)
        expect(logs.filter((l) => !l.result.ok)).toEqual([]);
      } finally {
        await server.stop();
      }
    });
  }
});
