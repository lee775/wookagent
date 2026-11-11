/**
 * 서버 시험 도우미 (SERVER_DESIGN 10.2, S2-11).
 * - 빌드: 각 시험 파일이 `out/test-server-…/`에 따로 묶는다(동시에 도는 파일끼리 out/server를 서로 지우지 않게). 그 폴더는 out/server처럼 저장소 루트의
 *   두 단계 아래라 앱 루트(resources/)와 node_modules를 같은 식으로 찾는다. boot.test만 `npm run build:server`로 out/server를 만든다
 * - 서버 띄우기·운영자 명령·HTTP·SSE 요청 (Host 머리를 바꿔 보내야 해서 fetch 대신 node:http)
 * - 프로세스 안 서버: 하네스 백엔드를 서버가 쓰는 모양(호출자를 받는 invoke, 거르지 않은 토픽, 운영자 길, 기기 세션)으로 감싼다
 * - 가짜 백엔드 SSE 시험: 메모리 저장소의 기기 세션(memorySessions)과 토픽을 손으로 내는 가짜(fakeTopicBackend)
 * 토큰은 시험 출력에 나오지 않게 다룬다 — 실패 메시지에 들어갈 수 있는 자리(expect의 실제 값)에 토큰이 담긴 글을 넣지 않는다
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { WookTopic } from '@shared/ipc';
import { createBackendOperator } from '../../src/main/backend/operator';
import { BackendError, type Backend, type RemoteCaller } from '../../src/main/backend/types';
import { createDeviceSessionStore, type DeviceSessionStore } from '../../src/main/auth/deviceSessions';
import { openStore } from '../../src/main/db/store';
import { formatDetail, type Logger } from '../../src/main/shell/logger';
import type { ServerBackend } from '../../src/server/server';
import { ADMIN_PROTOCOL, adminProof, type AdminReply } from '../../src/server/admin';
import { connect } from 'node:net';
import type { Harness } from '../e2e/harness';

export const REPO = resolve(process.cwd());
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 시험용 빌드 폴더 (out/ 아래 — .gitignore) */
export function testBuildDir(tag: string): string {
  return join(REPO, 'out', `test-server-${tag}-${process.pid}-${randomBytes(3).toString('hex')}`);
}

/** vite.server.config.ts로 outDir에 서버를 묶는다 — index.mjs 경로를 돌려준다 */
export function buildServerTo(outDir: string): string {
  const r = spawnSync(process.execPath, [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.server.config.ts', '--outDir', outDir, '--logLevel', 'warn'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
  });
  if (r.status !== 0) throw new Error(`서버 빌드 실패 (${r.status}): ${r.stderr}`);
  const entry = join(outDir, 'index.mjs');
  if (!existsSync(entry)) throw new Error(`빌드 결과가 없습니다: ${entry}`);
  return entry;
}

export async function removeDir(dir: string): Promise<void> {
  // rmSync는 Node 24.13(Windows)에서 한글 경로면 프로세스가 죽어 비동기 rm을 쓴다
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}

export interface BuiltServer {
  child: ChildProcess & { pid: number };
  url: string;
  port: number;
  runId: string;
  dataDir: string;
  stdout(): string;
  stderr(): string;
  /** 끝난 결과 (이미 끝났으면 바로) */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * 시험 서버의 작업 폴더 위치 인자 (리드 결정 S5-20) — 주지 않으면 서버가 실제 사용자 폴더의 ~/wook-workspace에 메인 작업 폴더를 만든다. 데이터 폴더 옆(이 실행의
 * 임시 폴더 안)에 둔다. 시험이 직접 --workspace-root를 주면 그것을 쓴다
 */
export function workspaceArgs(dataDir: string, args: readonly string[] = []): string[] {
  return args.includes('--workspace-root') ? [] : ['--workspace-root', `${dataDir}-ws`];
}

/** 빌드한 서버를 띄우고 준비 줄을 기다린다. 준비 전에 끝나면 그 결과로 던진다 */
export async function startBuilt(o: { entry: string; dataDir: string; args?: string[]; nodeArgs?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<BuiltServer> {
  const child = spawn(process.execPath, [...(o.nodeArgs ?? []), o.entry, 'serve', '--data-dir', o.dataDir, '--port', '0', ...workspaceArgs(o.dataDir, o.args), ...(o.args ?? [])], {
    cwd: REPO,
    env: { ...process.env, ...o.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcess & { pid: number };
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr!.setEncoding('utf8').on('data', (c: string) => (err += c));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  let done: { code: number | null } | null = null;
  void exited.then((x) => (done = x));
  for (;;) {
    // 주소 뒤 괄호는 듣는 루프백 주소 (S2-14)
    const m = /욱채 서버 준비 완료: 주소 (http:\/\/\S+)(?: \([^)]*\))? · 실행 ID (\S+) · 데이터 폴더 /.exec(out);
    if (m) {
      const url = m[1]!;
      return { child, url, port: Number(new URL(url).port), runId: m[2]!, dataDir: o.dataDir, stdout: () => out, stderr: () => err, exited };
    }
    if (done) throw new Error(`서버가 준비 전에 끝났습니다 (코드 ${(done as { code: number | null }).code}): ${err}`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`서버 준비 시간 초과: ${err}`);
    }
    await sleep(50);
  }
}

/** 운영자 명령을 실행한다 (wook-server <명령>) */
export function runClient(entry: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: REPO, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 운영자 명령을 비동기로 (동시에 여러 개를 보낼 때) */
export function runClientAsync(entry: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: REPO, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** 운영자 명령 JSON 결과 (--json) */
export function clientJson(entry: string, args: string[]): { code: number | null; reply: { ok: boolean; result?: unknown; error?: { code: string; message: string } } } {
  const r = runClient(entry, [...args, '--json']);
  let reply;
  try {
    reply = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
  } catch {
    throw new Error(`운영자 명령의 JSON 결과를 읽지 못했습니다 (코드 ${r.code}, stderr ${r.stderr.slice(0, 500)})`);
  }
  return { code: r.code, reply };
}

/**
 * 관리 채널에 서로 증명 약속(S3-16)으로 직접 붙는다 — 시험이 둘째 줄을 마음대로 만든다. 운영자 쪽 증명은 proofToken으로 만들고(틀린 토큰이면 틀린 증명),
 * 서버의 증명은 확인하지 않고 돌려준다(시험이 본다). line2가 있으면 그 글을 그대로 보낸다
 */
export function adminHandshake(
  endpoint: string,
  o: { proofToken: string; command: string; args?: unknown; secret?: unknown; clientNonce?: string; line2?: (c: { nonce: string; proof: string; clientNonce: string }) => string },
): Promise<{ reply: AdminReply | null; challenge: { nonce: string; proof: string; clientNonce: string } | null }> {
  return new Promise((resolveIt) => {
    const socket = connect(endpoint);
    const clientNonce = o.clientNonce ?? randomBytes(32).toString('base64url');
    let challenge: { nonce: string; proof: string; clientNonce: string } | null = null;
    let text = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ hello: ADMIN_PROTOCOL, nonce: clientNonce })}\n`));
    socket.on('data', (c: string) => {
      text += c;
      if (challenge || !text.includes('\n')) return;
      const first = JSON.parse(text.slice(0, text.indexOf('\n'))) as { nonce: string; proof: string };
      challenge = { ...first, clientNonce };
      text = text.slice(text.indexOf('\n') + 1);
      const line = o.line2
        ? o.line2(challenge)
        : JSON.stringify({ proof: adminProof(o.proofToken, 'client', clientNonce, first.nonce), command: o.command, ...(o.args !== undefined ? { args: o.args } : {}), ...(o.secret !== undefined ? { secret: o.secret } : {}) });
      socket.write(`${line}\n`);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      const line = text.split('\n')[0] ?? '';
      let reply: AdminReply | null = null;
      try {
        reply = line ? (JSON.parse(line) as AdminReply) : null;
      } catch {
        reply = null;
      }
      resolveIt({ reply, challenge });
    });
  });
}

/** 빌드한 서버의 관리 채널로 운영자 시험 세션(기기 세션, S3-4)의 토큰을 받는다 (토큰은 출력하지 않는다) */
export function issueTokenBuilt(entry: string, dataDir: string): string {
  const { code, reply } = clientJson(entry, ['session', 'test', '--data-dir', dataDir]);
  const token = (reply.result as { token?: unknown } | undefined)?.token;
  if (code !== 0 || !reply.ok || typeof token !== 'string') throw new Error(`시험용 세션을 받지 못했습니다: ${reply.error?.code ?? code}`);
  return token;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = unknown>(): T;
}

/** node:http 요청 (Host 머리를 바꿀 수 있다) */
export function httpCall(o: { url: string; path: string; method?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<HttpResult> {
  const base = new URL(o.url);
  return new Promise((resolveReq, reject) => {
    const req = request(
      { host: base.hostname.replace(/^\[|\]$/g, ''), port: Number(base.port), path: o.path, method: o.method ?? 'GET', headers: o.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveReq({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/**
 * POST /api/invoke. 요청 ID는 넘기지 않으면 부를 때마다 새로 만든다 — 실제 화면처럼 요청마다 다른 ID다. 상태를 바꾸는 요청은 같은 ID를 한 번만 처리하므로
 * (S3-9) 같은 ID를 다시 보내는 시험은 id를 넘긴다
 */
export function invokeHttp(url: string, token: string | null, method: string, args: unknown[] = [], extra: { headers?: Record<string, string>; id?: unknown } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra.headers };
  return httpCall({ url, path: '/api/invoke', method: 'POST', headers, body: JSON.stringify({ id: extra.id ?? `req-${randomBytes(6).toString('hex')}`, method, args }) });
}

export interface SseEvent {
  event: WookTopic | string;
  data: { runId: string; payload: unknown };
}

export interface SseClient {
  status: number;
  events: SseEvent[];
  /** 받은 글 전부 (살아 있음 신호 확인용) */
  raw(): string;
  ended(): boolean;
  waitFor(pred: (events: SseEvent[]) => boolean, label: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** GET /api/events 를 열고 이벤트를 모은다. token이 비면 Authorization 머리 없이(세션 없는 연결·쿠키 연결 — headers로 쿠키를 싣는다) */
export function openSse(url: string, token: string, query = '', headers: Record<string, string> = {}): Promise<SseClient> {
  const base = new URL(url);
  return new Promise((resolveSse, reject) => {
    const events: SseEvent[] = [];
    let raw = '';
    let buffer = '';
    let ended = false;
    const req = request(
      { host: base.hostname.replace(/^\[|\]$/g, ''), port: Number(base.port), path: `/api/events${query}`, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, agent: false },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
          buffer += chunk;
          for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
          }
        });
        const markEnded = () => (ended = true);
        res.on('end', markEnded);
        res.on('close', markEnded);
        res.on('error', markEnded);
        resolveSse({
          status: res.statusCode ?? 0,
          events,
          raw: () => raw,
          ended: () => ended,
          async waitFor(pred, label, timeoutMs = 60_000) {
            const t0 = Date.now();
            while (!pred(events)) {
              if (Date.now() - t0 > timeoutMs) throw new Error(`SSE 대기 시간 초과: ${label} (받은 이벤트 ${events.map((e) => e.event).join(',')})`);
              await sleep(25);
            }
          },
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', (e) => {
      ended = true;
      reject(e);
    });
    req.end();
  });
}

/** 줄을 모으는 기록기 (프로세스 안 서버) */
export function memoryLogger(): Logger & { lines: string[]; text(): string } {
  const lines: string[] = [];
  const add = (level: string) => (message: string, ...details: unknown[]) => {
    lines.push(`[${level}] ${message}${details.length ? ` ${details.map(formatDetail).join(' ')}` : ''}`);
  };
  return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR'), text: () => lines.join('\n') };
}

/**
 * 하네스 백엔드를 서버가 쓰는 모양으로 — createBackend와 같은 조립: 호출자를 받는 invoke(HTTP가 넘긴 호출자로 원격 길 게이트, S3-3), 거르지 않은 토픽과
 * 호출자별 거르기, 운영자 길, 기기 세션 저장소(S3-4), 업로드·내려받기(S3-10)
 */
export function remoteBackendOf(h: Harness): ServerBackend {
  const b = h.orch.backend;
  return {
    invoke: b.invoke,
    onTopicRaw: b.onTopicRaw,
    topicFor: b.topicFor,
    snapshotFor: b.snapshotFor,
    hasActiveWork: b.hasActiveWork,
    operator: createBackendOperator(() => h.core),
    sessions: h.core.deviceSessions,
    files: h.core.serverFiles,
    // 외부 에이전트 API (리드 결정 S7-2) — 서버 모드 하네스에만 있다
    ...(b.agents ? { agents: b.agents } : {}),
  };
}

/**
 * 가짜 백엔드로 연 서버의 백엔드 (관리 채널·접근 기록 시험): fakeTopicBackend + 메모리 기기 세션 + 운영자 길(시험 세션은 그 저장소에서 낸다)
 */
export function fakeServerBackend(): { backend: ServerBackend; close(): void } {
  const fake = fakeTopicBackend();
  const mem = memorySessions();
  return {
    backend: {
      ...fake.backend,
      hasActiveWork: () => false,
      sessions: mem.sessions,
      operator: {
        emergencyStop: async () => ({}) as never,
        openTestSession: () => {
          const { token, session } = mem.sessions.issue({ deviceName: '운영자 시험 세션' });
          return { token, expiresAt: session.idleExpiresAt, sessionId: session.id, ownerCreated: false };
        },
        note: () => undefined,
        // 가짜 백엔드에는 가리개가 없다 (S5-30)
        registerSecret: () => undefined,
        status: () => ({ emergencyStop: { active: false, since: null }, secretStore: { backend: 'keyring', fallbackReason: null } }),
        // 운영자 설정 (S3-8) — 가짜 백엔드는 바꾸는 것이 없다
        applyServerConfig: () => [],
        serverConfigState: () => ({
          ownerEmail: null,
          ownerEmailSource: null,
          ownerRegistered: false,
          setupCodeExpiresAt: null,
          google: { clientId: null, secretSet: false },
          cli: { claudePath: null, codexPath: null },
          deviceSessions: mem.sessions.list().length,
        }),
        setGoogleClientSecret: async () => undefined,
        issueSetupCode: () => null,
        // 메인 자리 (S4-8) — 가짜 백엔드에는 자리가 없다
        seatStatus: () => {
          throw new BackendError('unavailable', '가짜 백엔드에는 메인 자리가 없습니다');
        },
        assignSeat: async () => {
          throw new BackendError('unavailable', '가짜 백엔드에는 메인 자리가 없습니다');
        },
        // 외부 에이전트 (S7-2) — 가짜 백엔드에는 등록 기록이 없다
        addExternalAgent: () => {
          throw new BackendError('unavailable', '가짜 백엔드에는 외부 에이전트 기록이 없습니다');
        },
        revokeExternalAgent: () => {
          throw new BackendError('unavailable', '가짜 백엔드에는 외부 에이전트 기록이 없습니다');
        },
        listExternalAgents: () => [],
      },
    },
    close: mem.close,
  };
}

/** 메모리 저장소의 기기 세션 (가짜 백엔드 SSE 시험) — 대표 하나('owner-시험')의 세션을 낸다 */
export function memorySessions(o: { now?: () => number; idleMs?: number } = {}): { sessions: DeviceSessionStore; issue(): string; close(): void } {
  const store = openStore(':memory:');
  const sessions = createDeviceSessionStore({ store, ownerSub: () => 'owner-시험', now: o.now, idleMs: o.idleMs });
  return { sessions, issue: () => sessions.issue({ deviceName: '시험 기기' }).token, close: () => store.close() };
}

/**
 * 토픽을 손으로 내는 가짜 백엔드 (SSE 시험). 호출자 거르기는 데스크톱 로그아웃 규칙을 흉내 낸다: 세션이 없으면 스냅숏에 locked 표시를 붙이고 알림·CLI
 * 이벤트는 보내지 않는다. 첫 스냅숏(snapshotFor)은 { version, from: 'invoke' }
 */
export function fakeTopicBackend(o: { snapshotVersion?: number; snapshotDelayMs?: number } = {}): {
  backend: Pick<Backend, 'invoke' | 'onTopicRaw' | 'topicFor' | 'snapshotFor'>;
  emit(topic: string, payload: unknown): void;
  listeners(): number;
} {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  const locked = (snap: unknown) => ({ ...(snap as object), locked: true });
  const backend: Pick<Backend, 'invoke' | 'onTopicRaw' | 'topicFor' | 'snapshotFor'> = {
    // 게이트 흉내: auth.getState는 누구나(세션이 있으면 로그인), 그 밖은 세션이 있어야 한다(답은 null)
    invoke: (async (method: string, _args: unknown[], caller?: RemoteCaller) => {
      if (method === 'auth.getState') return { loggedIn: !!caller?.session };
      if (!caller?.session) throw new BackendError('unauthorized', '로그인이 필요합니다');
      return null;
    }) as unknown as Backend['invoke'],
    onTopicRaw: ((topic: string, cb: (p: unknown) => void) => {
      const set = subs.get(topic) ?? new Set();
      set.add(cb);
      subs.set(topic, set);
      return () => set.delete(cb);
    }) as Backend['onTopicRaw'],
    topicFor: ((topic: string, payload: unknown, caller: { session: unknown }) => {
      if (caller.session) return payload;
      if (topic === 'snapshot') return locked(payload);
      return topic === 'notification' || topic === 'cliEvents' ? undefined : payload;
    }) as Backend['topicFor'],
    snapshotFor: (async (caller: { session: unknown }) => {
      if (o.snapshotDelayMs) await sleep(o.snapshotDelayMs);
      const snap = { version: o.snapshotVersion ?? 5, from: 'invoke' };
      return caller.session ? snap : locked(snap);
    }) as unknown as Backend['snapshotFor'],
  };
  return {
    backend,
    emit: (topic, payload) => {
      for (const cb of subs.get(topic) ?? []) cb(payload);
    },
    listeners: () => [...subs.values()].reduce((n, x) => n + x.size, 0),
  };
}

export interface WindowsAcl {
  /** 상속을 끊었는지 (AreAccessRulesProtected) */
  protected: boolean;
  /** 접근 규칙 — 계정 이름은 소문자로 */
  rules: { id: string; inherited: boolean; rights: string; flags: string; type: string }[];
}

/** Windows: 경로의 ACL (Get-Acl). icacls로 준 권한을 읽어 본다 — 출력이 지역화되는 icacls 대신 구조로 */
export function windowsAcl(path: string): WindowsAcl {
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $a = Get-Acl -LiteralPath $env:WOOK_ACL_PATH; " +
    "[pscustomobject]@{ protected = $a.AreAccessRulesProtected; rules = @($a.Access | ForEach-Object { [pscustomobject]@{ id = $_.IdentityReference.Value; inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString(); flags = $_.InheritanceFlags.ToString(); type = $_.AccessControlType.ToString() } }) } | ConvertTo-Json -Depth 4 -Compress";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, WOOK_ACL_PATH: path } });
  const acl = JSON.parse(out) as WindowsAcl;
  return { protected: acl.protected, rules: acl.rules.map((r) => ({ ...r, id: r.id.toLowerCase() })) };
}

/** Windows 지금 사용자 (Get-Acl의 계정 이름 모양, 소문자) */
export const windowsMe = (): string => `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}`.toLowerCase();

/** pid의 자손 프로세스 (pid·생성 시각) — 남은 프로세스 확인용 */
export function descendantsOf(rootPid: number): number[] {
  const edges: [number, number][] = [];
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"], {
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
      if (m) edges.push([Number(m[1]), Number(m[2])]);
    }
  } else {
    const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout ?? '';
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) edges.push([Number(m[1]), Number(m[2])]);
    }
  }
  const found = new Set<number>();
  let frontier = [rootPid];
  while (frontier.length) {
    const next: number[] = [];
    for (const [pid, ppid] of edges) if (frontier.includes(ppid) && !found.has(pid) && pid !== rootPid) next.push(pid);
    for (const p of next) found.add(p);
    frontier = next;
  }
  return [...found];
}
