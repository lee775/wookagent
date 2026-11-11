/**
 * 외부 에이전트 시험 도구 (SERVER_DESIGN 10.7, 리드 결정 S7-7): 서버 모드 하네스를 프로세스 안 서버(startServer)로 감싸고, 모의 외부 에이전트
 * (resources/mock-agent/mock-external.mjs)를 자식 프로세스로 띄운다 — 띄운 자식은 close()에서 모두 끝낸다.
 * - 메인 모의 실행은 하네스가 시작 전에 켠다(createHarness — 리드 결정 S6-19). close()는 모든 M-MAIN 턴이 모의 실행이거나 외부 보유자의 턴(runner external)인지 확인한다
 * - 키·턴 토큰은 시험 출력에 내지 않는다: 실패 글(expect의 실제 값)에 키나 토큰이 든 글을 넣지 않는다
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createHarness, type Harness, type HarnessOptions } from '../e2e/harness';
import { adminRequest } from '../../src/server/admin';
import { startServer, agentEndpointPath, type RunningServer } from '../../src/server/server';
import { createBackendOperator } from '../../src/main/backend/operator';
import type { BackendOperator } from '../../src/main/backend/types';
import type { Clock } from '@core/time';
import { invokeHttp, memoryLogger, remoteBackendOf, REPO, removeDir, sleep } from './helpers';

export const MOCK_EXTERNAL = join(REPO, 'resources', 'mock-agent', 'mock-external.mjs');

export interface ExternalEnv {
  h: Harness;
  server: RunningServer;
  operator: BackendOperator;
  /** 대표의 기기 세션 토큰 (운영자 시험 세션) */
  owner: string;
  logger: ReturnType<typeof memoryLogger>;
  /** 에이전트 API 주소 (`http://127.0.0.1:<port>/agent/v1`) */
  api: string;
  mcp: string;
  tmp: string;
  /** 모의 외부 에이전트를 띄운다 — 기록 파일 경로를 돌려준다 */
  spawnMock(key: string, args: string[], tag?: string): { child: ChildProcess; log: string };
  /** 모의 외부 에이전트의 기록 (JSONL) */
  mockLog(file: string): Record<string, unknown>[];
  /** 대표의 길로 부른다 (HTTP) — 값 */
  owner$<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  close(): Promise<void>;
}

/**
 * 정리 단계를 모두 돈다 — 앞 단계가 던져도 뒤 단계를 건너뛰지 않는다(자식 프로세스·서버·하네스·임시 폴더가 남지 않게). 끝에 오류를 던진다: 하나면 그것, 여럿이면
 * 모두 담아서 (리드 결정 S7-20 TI-9)
 */
export async function cleanupAll(steps: readonly (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `정리 중 오류 ${errors.length}개: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join(' / ')}`);
}

/** 시험이 띄운 자식 프로세스(ChildProcess 손잡이)를 끝내고 끝날 때까지 기다린다 — 살아 있는 것만, 10초까지 */
export async function endChildren(children: readonly ChildProcess[]): Promise<void> {
  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  const gone = Promise.all(alive.map((c) => new Promise((r) => c.once('exit', r))));
  for (const c of alive) c.kill();
  await Promise.race([gone, sleep(10_000)]);
}

/** 실제 시계 + 차이 (advance로 앞당긴다) */
export function offsetClock(): Clock & { advance(ms: number): void } {
  let off = 0;
  return {
    now: () => new Date(Date.now() + off),
    iso: () => new Date(Date.now() + off).toISOString(),
    ms: () => Date.now() + off,
    advance(ms: number) {
      off += ms;
    },
  };
}

export async function bootExternal(o: HarnessOptions = {}): Promise<ExternalEnv> {
  const h = await createHarness({ mode: 'server', noProject: true, ...o });
  const logger = memoryLogger();
  const server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: true, logger, version: 'test' });
  const reply = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
  if (!reply.ok) throw new Error('시험용 세션을 받지 못했습니다');
  const owner = (reply.result as { token: string }).token;
  const ep = JSON.parse(readFileSync(agentEndpointPath(h.dataDir), 'utf8')) as { agentApi: string; mcp: string; proof: string };
  const tmp = mkdtempSync(join(tmpdir(), 'wook-test-ext-'));
  const children: ChildProcess[] = [];
  let n = 0;
  const env: ExternalEnv = {
    h,
    server,
    operator: createBackendOperator(() => h.core),
    owner,
    logger,
    api: ep.agentApi,
    mcp: ep.mcp,
    tmp,
    spawnMock(key, args, tag = 'mock') {
      const log = join(tmp, `${tag}-${++n}.jsonl`);
      const child = spawn(process.execPath, [MOCK_EXTERNAL, '--endpoint', agentEndpointPath(h.dataDir), '--log', log, ...args], {
        cwd: REPO,
        env: { ...process.env, WOOK_AGENT_KEY: key },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      child.stderr?.resume();
      children.push(child);
      return { child, log };
    },
    mockLog(file) {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    async owner$<T>(method: string, ...args: unknown[]): Promise<T> {
      const r = await invokeHttp(server.url, owner, method, args);
      const body = r.json<{ ok: boolean; value: T; error?: { code: string; message: string } }>();
      if (r.status !== 200 || !body.ok) throw new Error(`${method} 실패 ${r.status} ${body.error?.code}: ${body.error?.message}`);
      return body.value;
    },
    async close() {
      // 한 단계가 던져도 뒤 단계(서버·하네스·임시 폴더)를 건너뛰지 않는다 — 모의 실행이 아닌 메인 턴·proof의 오류는 모두 정리한 뒤에 던진다 (리드 결정 S7-20 TI-9)
      let bad: string[] = [];
      let proofLeak = false;
      await cleanupAll([
        () => endChildren(children),
        () => server.close(),
        () => {
          // 메인 턴은 모두 모의 실행이거나 외부 보유자의 턴이다 — 실제 CLI가 뜨지 않았다 (리드 결정 S6-19·S7-13)
          bad = h.core.ctx.store.turns
            .list({ ref1: MAIN_AGENT_ID })
            .filter((t) => !t.mock && t.runner !== 'external')
            .map((t) => t.id);
        },
        () => {
          // 서버 확인값(proof)은 agent-endpoint.json에만 있다 — 서버 기록·모의 에이전트 기록(JSONL)에는 없다 (리드 결정 S7-19 C3) // S7F2c
          proofLeak = !!ep.proof && (logger.text().includes(ep.proof) || readdirSync(tmp).some((f) => f.endsWith('.jsonl') && readFileSync(join(tmp, f), 'utf8').includes(ep.proof))); // S7F2c
        },
        () => h.close(),
        () => removeDir(tmp),
        () => {
          if (bad.length) throw new Error(`모의 실행이 아닌 메인 턴이 있습니다: ${bad.join(', ')}`);
        },
        () => {
          if (proofLeak) throw new Error('서버 확인값(proof)이 서버 기록이나 모의 에이전트 기록에 있습니다'); // S7F2c
        },
      ]);
    },
  };
  return env;
}

export interface AgentReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  json<T = Record<string, unknown>>(): T;
}

/** 에이전트 API 한 번 — key가 null이면 Authorization 머리 없이 */
export function agentCall(api: string, key: string | null, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {}): Promise<AgentReply> {
  const url = new URL(`${api}${path}`);
  const data = o.rawBody !== undefined ? Buffer.from(o.rawBody, 'utf8') : o.body !== undefined ? Buffer.from(JSON.stringify(o.body), 'utf8') : null;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: o.method ?? (data ? 'POST' : 'GET'),
        agent: false,
        headers: { ...(key !== null ? { Authorization: `Bearer ${key}` } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}), ...o.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T>() => JSON.parse(body.toString('utf8') || 'null') as T });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

/** MCP tools/call 한 번 (턴 토큰만) */
export async function mcpCall(mcpUrl: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; isError: boolean; text: string }> {
  const url = new URL(mcpUrl);
  const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), 'utf8');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': String(data.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let isError = false;
          let inner = text;
          try {
            const j = JSON.parse(text) as { result?: { isError?: boolean; content?: { text?: string }[] } };
            isError = !!j.result?.isError;
            inner = j.result?.content?.[0]?.text ?? text;
          } catch {
            // 그대로
          }
          resolve({ status: res.statusCode ?? 0, isError, text: inner });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** 조건이 될 때까지 (간격 50ms). dump: 시간이 다 되면 붙일 상황 (키·토큰이 들지 않는 것만) */
export async function until(pred: () => boolean | Promise<boolean>, label: string, ms = 60_000, dump?: () => unknown): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}${dump ? `\n${JSON.stringify(dump(), null, 1)}` : ''}`);
    await sleep(50);
  }
}

/** 시간 초과 때 붙일 상황 — 대기열·M-MAIN 턴·최근 활동·모의 에이전트 기록 (키·토큰 없음) */
export function situation(x: ExternalEnv, mockLog?: string): unknown {
  const ctx = x.h.core.ctx;
  return {
    seat: (({ generation, state, holder, unresponsiveReason }) => ({ generation, state, holder, unresponsiveReason }))(ctx.store.seat.get('main')!),
    queue: ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).map((q) => `${q.id} ${q.kind} ${q.sessionKey} ${q.state} a${q.attempts}`),
    turns: ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).map((t) => `${t.id} ${t.runner} ${t.endReason} ${t.endDetail}`),
    activity: ctx.store.activity.search({ limit: 25 }).map((a) => `${a.kind} ${a.text.slice(0, 160)}`),
    mock: mockLog ? x.mockLog(mockLog).filter((e) => e.ev !== 'heartbeat' || e.status !== 200).slice(-25) : null,
  };
}

/** 시험이 직접 에이전트가 될 때 — claim과 롱폴 */
export async function claimAs(api: string, key: string): Promise<{ leaseId: string; generation: number }> {
  const r = await agentCall(api, key, '/seat/claim', { body: {} });
  if (r.status !== 200) throw new Error(`claim 실패 ${r.status} ${r.json<{ error?: { code: string } }>().error?.code}`);
  const j = r.json<{ leaseId: string; generation: number }>();
  return { leaseId: j.leaseId, generation: j.generation };
}

export interface Work {
  turnId: string;
  kind: string;
  workKey: string;
  generation: number;
  message: string;
  instructions: string;
  cwd: string;
  digest: string | null;
  mcp: { url: string; token: string };
  deadlineAt: string;
}

/** 일 하나를 받을 때까지 롱폴을 되풀이한다 */
export async function nextWork(api: string, key: string, leaseId: string, ms = 30_000): Promise<Work> {
  const t0 = Date.now();
  for (;;) {
    const r = await agentCall(api, key, '/work/next', { body: { leaseId, waitMs: 2000 } });
    if (r.status === 200) return r.json<Work>();
    if (r.status !== 204) throw new Error(`work/next ${r.status} ${r.json<{ error?: { code: string } }>().error?.code}`);
    if (Date.now() - t0 > ms) throw new Error('일이 오지 않았습니다');
  }
}

export const errCode = (r: AgentReply): string | null => (r.body.length ? (r.json<{ error?: { code: string } }>().error?.code ?? null) : null);
/** 거부 글 — 받아 준 답(error 없음)이나 빈 본문이면 null (단언이 TypeError 대신 그 답을 보이게, 리드 결정 S7-20 TI-6) */
export const errMessage = (r: AgentReply): string | null => (r.body.length ? (r.json<{ error?: { message?: string } } | null>()?.error?.message ?? null) : null);

export { sleep, removeDir };
