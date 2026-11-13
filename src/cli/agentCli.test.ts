/**
 * `wook` CLI (리드 결정 S7-5·S7-16·S7-19) — 프로세스 안에서 runWook을 부르고, 가짜 에이전트 API(이 시험이 띄우는 루프백 HTTP)를 상대로 본다.
 * 실제 서버의 한 턴은 tests/server/wookCli.test.ts(빌드한 wook.mjs)가 본다. 여기서 보는 것:
 * - 쓰임새 오류는 적은 값을 되풀이하지 않고 서버에 붙지 않는다 (S3-39) — --file·--json-file·--data-dir로 받은 경로도 (S7-19 C12)
 * - 키: WOOK_AGENT_KEY → ~/.wook/agent.json (지금 사용자만 읽어야 한다 — 아니면 2, 그 계정과 지우는 명령을 말한다 S7-19 C8). 주소: WOOK_AGENT_URL(루프백만) →
 *   agent-endpoint.json (없음·끝난 서버·pid·proof 없음·알 수 없는 내용·닫힌 포트·에이전트 API가 아닌 답 → 5)
 * - 서버 확인 (S7-19 C3): 키·턴 토큰을 싣는 모든 요청(뒤에서 보내는 heartbeat 포함) 앞에 hello 한 번 — 틀리거나·없거나·늦거나·넘겨 주는 답이면 듣는 쪽은
 *   Authorization도 X-Wook-Turn-Token도 받지 않는다
 * - 끝 코드: 401 → 3, 409 → 4(서버의 글), 그 밖의 거부·도구의 거부(200 ok:false) → 1
 * - S7-16 3 (d): tool·screen capture·work next --wait는 기다리는 동안 heartbeatMs마다 heartbeat를 보내고, heartbeat의 실패는 명령의 글 뒤의 줄이다
 * - S7-16 6: work done은 30초 넘게 기다린다 (finish는 10초까지 기다린다). work done은 UTF-8 파일만 보낸다 (S7-19 C2), tool --json-file도 (C7)
 * - S7-19 C4: 요청마다 전체 상한·답 크기 상한. C5: 같은 임대의 두 롱폴이 서로를 끝내도 횟수를 태우지 않는다. C6: state.json은 다시 읽고 바꾼다
 * - state.json은 지금 사용자만 읽고, 키·임대 ID·턴 토큰·proof는 어떤 출력에도 없다
 * 집 폴더는 이 시험의 임시 폴더다 — 실제 ~/.wook는 쓰지 않는다
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { aclFixText, DONE_TIMEOUT_MS, HELLO_TIMEOUT_MS, icaclsNames, loopbackApi, OTHER_POLLER, REPLY_MAX_BYTES, runWook, sddlOpenToOthers, sddlOthers, WOOK_EXIT, type WookIo } from './agentCli';

const KEY = `wsk_${randomBytes(32).toString('base64url')}`;
const LEASE = randomBytes(24).toString('base64url');
const TOKEN = `wtt_${randomBytes(32).toString('base64url')}`;
/** 가짜 서버의 확인값 (S7-19 C3) — 출력 어디에도 나오면 안 된다 */
const PROOF = randomBytes(32).toString('base64url');
const SECRETS = [KEY, LEASE, TOKEN, KEY.slice(4), TOKEN.slice(4), PROOF];
const PREFIX = '/agent/v1';
/** 가짜 서버가 요청에 찍는 시각 — 뒤로 가지 않는다. 두 요청의 간격을 아래 한계로 견주는 시험이 있어, 벽시계(WSL2는 30초마다 0.5초쯤 뒤로 당겨진다)로 찍지 않는다 (S10-19) */
const steadyNow = (): number => performance.timeOrigin + performance.now();
const win = process.platform === 'win32';
const sys32 = (exe: string): string => join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', exe);
const me = (): string => /"(S-1-[0-9-]+)"/.exec(execFileSync(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }).toString('latin1'))![1]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const macOf = (nonce: string, proof = PROOF): string => createHmac('sha256', Buffer.from(proof, 'base64url')).update(Buffer.from(nonce, 'base64url')).digest('base64url');

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  token: string | undefined;
  body: Record<string, unknown>;
  at: number;
  /** 연결 번호 (이 가짜 서버가 받은 TCP 연결의 차례) */
  conn: number;
  /** 이 요청 앞에 같은 연결에서 hello에 맞게 답했는지 (S7-22 K1 — 키를 실은 요청은 늘 참이어야 한다) */
  onProved: boolean;
}
type Answer = {
  status: number;
  json?: unknown;
  raw?: Buffer;
  type?: string;
  delayMs?: number;
  headers?: Record<string, string>;
  /** 소켓을 끊는다 (답하지 않음) */
  destroy?: boolean;
  /** 답하지 않고 둔다 (클라이언트가 끊을 때까지) */
  hang?: boolean;
  /** 머리를 보낸 뒤 이 간격마다 한 바이트 (trickleForMs가 지나면 끝낸다 — 클라이언트의 전체 상한이 없으면 그때 빈칸만 든 본문을 받는다) */
  trickleMs?: number;
  trickleForMs?: number;
  /** Content-Length 없이 조각으로 보낸다 */
  chunked?: boolean;
};
type Route = (s: Seen) => Answer | Promise<Answer>;

let server: Server;
let api = '';
let port = 0;
let seen: Seen[] = [];
let routes: Record<string, Route> = {};
const dirs: string[] = [];
const realWook = join(homedir(), '.wook');
/** 실제 ~/.wook의 모습 — 없으면 null, 있으면 그 안의 모든 항목(상대 경로·크기·수정 시각). 폴더의 수정 시각만으로는 안의 파일을 고쳐 쓴 것을 모른다 */
function wookShape(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const out: string[] = [];
  const walk = (p: string, rel: string): void => {
    const st = statSync(p);
    out.push(`${rel}|${st.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n), `${rel}/${n}`);
  };
  walk(dir, '.');
  return out.join('\n');
}
const realWookBefore = wookShape(realWook);

/** 맞는 hello — 가짜 서버의 확인값으로 */
const goodHello: Route = (s) => ({ status: 200, json: { ok: true, mac: macOf(String(s.body['nonce'])) } });

function answer(res: ServerResponse, a: Answer): void {
  if (res.destroyed) return;
  if (a.destroy) {
    res.socket?.destroy();
    return;
  }
  if (a.hang) return;
  if (a.trickleMs) {
    res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/json; charset=utf-8', ...a.headers });
    const t = setInterval(() => res.write(' '), a.trickleMs);
    const stop = a.trickleForMs ? setTimeout(() => res.end(), a.trickleForMs) : null;
    res.on('close', () => {
      clearInterval(t);
      if (stop) clearTimeout(stop);
    });
    return;
  }
  const raw = a.raw ?? (a.json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(a.json), 'utf8'));
  if (a.chunked) {
    res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/json; charset=utf-8', ...a.headers });
    for (let i = 0; i < raw.length; i += 1024 * 1024) res.write(raw.subarray(i, i + 1024 * 1024));
    res.end();
    return;
  }
  res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/json; charset=utf-8', 'Content-Length': String(raw.length), ...a.headers });
  res.end(raw);
}

const connIds = new WeakMap<Socket, number>();
let connCount = 0;
/** 이 가짜 서버가 그 연결에서 hello에 맞게(가짜 서버의 확인값으로) 답한 연결 */
const provedConns = new WeakSet<Socket>();
const connOf = (socket: Socket): number => {
  if (!connIds.has(socket)) connIds.set(socket, ++connCount);
  return connIds.get(socket)!;
};

/** 가짜 리스너 — 받은 요청을 seen에 적고 routes로 답한다 */
function fakeHandler(log: () => Seen[], table: () => Record<string, Route>) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      let body: Record<string, unknown> = {};
      try {
        body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const s: Seen = { method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, token: req.headers['x-wook-turn-token'] as string | undefined, body, at: steadyNow(), conn: connOf(req.socket), onProved: provedConns.has(req.socket) };
      log().push(s);
      const name = `${s.method} ${s.path.replace(PREFIX, '')}`;
      const routesNow = table();
      const route = routesNow[name] ?? routesNow[`${s.method} ${s.path.replace(PREFIX, '').replace(/\/(TN|SC)-\d+/, '/$1-*').replace(/^\/tool\/.*/, '/tool/*')}`] ?? (name === 'POST /hello' ? goodHello : undefined);
      const a: Answer = route ? await route(s) : { status: 404, json: { ok: false, error: { code: 'not_found', message: '가짜: 없는 길' } } };
      if (name === 'POST /hello' && a.status === 200 && isObj(a.json) && a.json['mac'] === macOf(String(s.body['nonce']))) provedConns.add(req.socket);
      if (a.delayMs) await sleep(a.delayMs);
      answer(res, a);
    });
  };
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

beforeAll(async () => {
  server = createServer(fakeHandler(() => seen, () => routes));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  api = `http://127.0.0.1:${port}${PREFIX}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  // 실제 ~/.wook는 만들지도 바꾸지도 않았다
  expect(wookShape(realWook)).toBe(realWookBefore);
});

beforeEach(() => {
  seen = [];
  routes = {};
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-cli-${tag}-`));
  dirs.push(d);
  return d;
};

/** 시험의 환경 — 실제 WOOK_* 값은 지운다 */
function envOf(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['WOOK_AGENT_KEY', 'WOOK_AGENT_URL', 'WOOK_AGENT_PROOF', 'WOOK_DATA_DIR']) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

interface Run {
  code: number;
  out: string;
  err: string[];
  ms: number;
}

/** runWook 한 번 — 어떤 출력에도 키·임대·토큰·proof가 없는지 늘 본다 (실패 글에 값을 내지 않게 참거짓으로) */
async function run(argv: string[], o: { home: string; env?: Record<string, string | undefined>; io?: Partial<WookIo> }): Promise<Run> {
  let out = '';
  let errText = '';
  const env = envOf({ WOOK_AGENT_KEY: KEY, WOOK_AGENT_URL: api, ...o.env });
  for (const [k, v] of Object.entries(o.env ?? {})) if (v === undefined) delete env[k];
  const io: WookIo = { out: async (t) => void (out += t), err: async (t) => void (errText += t), env, home: o.home, ...o.io };
  // 걸린 시간은 단조 시계로 잰다 — 벽시계(Date.now)는 그사이 시각 맞춤으로 뒤로 갈 수 있다 (WSL2에서 5초 창이 4,468ms로 재여 실패, 리드 결정 S10-5.5).
  // 제품의 상한은 setTimeout(단조 시계)이다
  const t0 = performance.now();
  const code = await runWook(argv, io);
  const ms = Math.round(performance.now() - t0);
  expect(SECRETS.some((s) => out.includes(s) || errText.includes(s))).toBe(false);
  return { code, out, err: errText.split('\n').filter((l) => l.trim()), ms };
}

const statePath = (home: string): string => join(home, '.wook', 'state.json');

/** state.json을 손으로 둔다 (claim·next를 거친 것처럼) */
function seedState(home: string, o: { heartbeatMs?: number; turn?: boolean; pollMaxMs?: number; leaseId?: string } = {}): void {
  mkdirSync(join(home, '.wook'), { recursive: true });
  writeFileSync(
    statePath(home),
    JSON.stringify({
      version: 1,
      api,
      agentId: 'X-0001',
      label: '그록봇',
      generation: 2,
      leaseId: o.leaseId ?? LEASE,
      leaseMs: 60_000,
      heartbeatMs: o.heartbeatMs ?? 100,
      pollMaxMs: o.pollMaxMs ?? 300,
      claimedAt: new Date().toISOString(),
      turn: o.turn === false ? null : { turnId: 'TN-0007', token: TOKEN, generation: 2, deadlineAt: new Date(Date.now() + 3600_000).toISOString() },
    }),
  );
}

const ok = (extra: Record<string, unknown> = {}): Answer => ({ status: 200, json: { ok: true, ...extra } });
const refuse = (status: number, code: string, message: string): Answer => ({ status, json: { ok: false, error: { code, message } } });
const beats = (): Seen[] => seen.filter((s) => s.method === 'POST' && s.path === `${PREFIX}/seat/heartbeat`);
const keyed = (): Seen[] => seen.filter((s) => s.auth !== undefined || s.token !== undefined);
const SEAT_OK = (): Answer => ok({ assigned: false, generation: 1, state: 'active', holder: { kind: 'launched', ai: {}, label: 'Claude CLI' }, leaseExpiresAt: null });
const WORK = () => ({ turnId: 'TN-0012', workKey: 'Q-1', kind: 'main_general', projectId: null, generation: 2, cwd: 'C:\\w\\main', instructions: '규칙', message: '일', digest: null, attachments: [], mcp: { url: 'http://127.0.0.1:9/mcp', token: TOKEN }, deadlineAt: new Date(Date.now() + 60_000).toISOString() });

/** 지금 사용자만 읽는 키 파일 (Windows: 상속을 끊고 지금 사용자만 — AGENT_GUIDE의 순서, POSIX: 0600) */
function writeKeyFile(home: string, content: string): string {
  mkdirSync(join(home, '.wook'), { recursive: true });
  const f = join(home, '.wook', 'agent.json');
  if (win) {
    closeSync(openSync(f, 'w'));
    execFileSync(sys32('icacls.exe'), [f, '/inheritance:r', '/grant:r', `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}:F`], { stdio: 'ignore', windowsHide: true });
    writeFileSync(f, content);
  } else {
    writeFileSync(f, content, { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  return f;
}

/** 다른 계정도 읽게 연다 (Windows: Users 그룹 읽기, POSIX: 0644) */
function openToOthers(f: string): void {
  if (win) execFileSync(sys32('icacls.exe'), [f, '/grant', '*S-1-5-32-545:R'], { stdio: 'ignore', windowsHide: true });
  else chmodSync(f, 0o644);
}

/** agent-endpoint.json (서버가 쓰는 꼴) — 바꿀 칸만 준다. 칸 값이 undefined면 뺀다 */
function writeEndpoint(dataDir: string, o: Record<string, unknown> = {}): string {
  const f = join(dataDir, 'agent-endpoint.json');
  const e: Record<string, unknown> = { version: 1, agentApi: api, mcp: api.replace(/\/agent\/v1$/, '/mcp'), runId: 'r', pid: process.pid, startedAt: new Date().toISOString(), proof: PROOF, ...o };
  for (const [k, v] of Object.entries(o)) if (v === undefined) delete e[k];
  writeFileSync(f, JSON.stringify(e));
  return f;
}

describe('wook 인자 — 쓰임새 오류는 2이고 적은 값을 되풀이하지 않으며 서버에 붙지 않는다 (S3-39)', () => {
  it('모르는 명령·옵션, 틀린 턴 ID·도구 이름·JSON·outcome, 빠진 값, 다른 명령의 옵션', async () => {
    const home = tempDir('usage');
    const cases: [string[], RegExp][] = [
      [[], /명령이 없습니다/],
      [['seat'], /알 수 없는 명령입니다: seat$/m],
      [['seat', 'claim', 'SECRETX'], /알 수 없는 명령입니다: seat claim … \(뒤의 낱말은 값일 수 있어 보이지 않습니다\)/],
      [['SECRETX'], /알 수 없는 명령입니다 \(적은 낱말은 값일 수 있어 보이지 않습니다\)/],
      [['--SECRETX'], /모르는 옵션이 있습니다/],
      [['work', 'next', '--wait=SECRETX'], /옵션의 값이 맞지 않습니다/],
      [['work', 'done', 'TN-0001'], /work done에는 --file <파일>을 붙입니다/],
      [['work', 'done', 'SECRETX', '--file', 'a.md'], /턴 ID는 TN-0001 꼴입니다/],
      [['work', 'done', 'TN-0001', '--file', 'a.md', '--outcome', 'SECRETX'], /--outcome은 completed 또는 failed입니다/],
      [['work', 'progress', 'TN-0001'], /work progress에는 --text <글>을 붙입니다/],
      [['work', 'progress'], /work progress 뒤에는 턴 ID 하나를 적습니다/],
      [['tool', 'SECRETX'], /도구 이름은 영문 소문자로 시작하는/],
      [['tool', 'get_overview', '--json', '{"a":"SECRETX"'], /--json의 글을 JSON으로 읽을 수 없습니다 .*--json-file <파일>을 쓰세요/],
      [['tool', 'get_overview', '--json', '["SECRETX"]'], /--json은 JSON 객체여야 합니다/],
      [['tool', 'get_overview', '--json', '{}', '--json-file', 'SECRETX.json'], /--json과 --json-file은 함께 쓰지 않습니다/],
      [['tool', 'get_overview', '--json-file', '  '], /--json-file에는 도구 인자 JSON 파일을 붙입니다/],
      [['screen', 'capture'], /screen capture에는 --out <파일\.png>를 붙입니다/],
      [['seat', 'claim', '--wait'], /--wait 옵션은 work next에만 씁니다/],
      [['stop', '--note', 'SECRETX'], /--note 옵션은 seat release에만 씁니다/],
      [['work', 'next', '--json', '{}'], /--json 옵션은 tool에만 씁니다/],
      [['work', 'next', '--json-file', 'SECRETX'], /--json-file 옵션은 tool에만 씁니다/],
    ];
    for (const [argv, re] of cases) {
      const r = await run(argv, { home });
      expect([argv.join(' '), r.code]).toEqual([argv.join(' '), WOOK_EXIT.usage]);
      expect(r.err[0]).toMatch(re);
      expect(r.err.join('\n')).not.toContain('SECRETX');
    }
    expect(seen).toHaveLength(0);
    expect(existsSync(join(home, '.wook'))).toBe(false);
  });

  it('--help는 0이고 쓰임새를 표준 출력에 낸다', async () => {
    const r = await run(['--help'], { home: tempDir('help') });
    expect([r.code, r.out.startsWith('욱채 에이전트 명령 wook'), r.out.includes('끝 코드  0 됨 · 1 거부·도구의 거부 · 2 쓰임새·설정 · 3 인증 실패(401) · 4 충돌(409 — 서버의 글) · 5 서버에 닿지 못함')]).toEqual([0, true, true]);
    expect(r.out).toContain("wook tool <도구 이름> [--json '<인자 JSON 객체>' | --json-file <파일>]");
  });
});

describe('설정 — 키와 주소 (S7-5)', () => {
  it('키가 없으면 2이고 서버에 붙지 않는다', async () => {
    const home = tempDir('nokey');
    const r = await run(['seat', 'status'], { home, env: { WOOK_AGENT_KEY: undefined } });
    expect(r.code).toBe(WOOK_EXIT.usage);
    expect(r.err[0]).toMatch(/^에이전트 키가 없습니다 — 환경 변수 WOOK_AGENT_KEY나 지금 사용자만 읽는 .*agent\.json\(\{"key": "wsk_…"\}\)에 두세요/);
    expect(seen).toHaveLength(0);
  });

  it('~/.wook/agent.json: 지금 사용자만 읽으면 그 키를 쓰고, 다른 계정도 읽을 수 있으면 쓰지 않는다(2). 깨진 파일도 내용을 되풀이하지 않는다', async () => {
    const home = tempDir('keyfile');
    routes['GET /seat'] = () => ok({ assigned: true, generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0001', label: '그록봇' }, leaseExpiresAt: null });
    const f = writeKeyFile(home, `\uFEFF${JSON.stringify({ key: KEY })}`);
    const good = await run(['seat', 'status'], { home, env: { WOOK_AGENT_KEY: undefined } });
    expect(good.code).toBe(0);
    expect(seen.map((s) => s.auth === `Bearer ${KEY}`)).toEqual([true]);

    openToOthers(f);
    seen = [];
    const open = await run(['seat', 'status'], { home, env: { WOOK_AGENT_KEY: undefined } });
    expect(open.code).toBe(WOOK_EXIT.usage);
    expect(open.err[0]).toMatch(win ? /권한\(ACL\)이 지금 사용자 밖의 계정에도 열려 있어 키를 쓰지 않습니다 — 열린 계정: / : /다른 사용자도 읽을 수 있어 키를 쓰지 않습니다 — chmod 600/);
    expect(seen).toHaveLength(0);

    // 깨진 내용 (키 조각이 든 글) — 내용은 보이지 않는다
    unlinkSync(f);
    writeKeyFile(home, `key=${KEY}`);
    const broken = await run(['seat', 'status'], { home, env: { WOOK_AGENT_KEY: undefined } });
    expect(broken.code).toBe(WOOK_EXIT.usage);
    expect(broken.err[0]).toMatch(/을\(를\) 읽을 수 없습니다 — \{"key": "wsk_…"\} 꼴의 JSON이어야 합니다 \(내용은 보이지 않습니다\)/);
    expect(seen).toHaveLength(0);
  });

  it.skipIf(!win)('agent.json의 거부 글은 열린 계정(이름·SID, 물려받은 권한인지)을 말하고, 그 글의 icacls 명령을 차례로 하면 받아들인다 (S7-19 C8)', async () => {
    const home = tempDir('acl');
    routes['GET /seat'] = SEAT_OK;
    const env = { WOOK_AGENT_KEY: undefined };
    const commands = (r: Run): string[] => r.err.filter((l) => l.startsWith('  icacls ')).map((l) => l.trim());
    const runAll = (cmds: string[]): void => {
      for (const c of cmds) execSync(c, { shell: sys32('cmd.exe'), stdio: 'ignore', windowsHide: true });
    };
    // ① 따로 준 권한 (Users 읽기) — 이름과 SID, 그 항목을 지우는 명령
    const f = writeKeyFile(home, JSON.stringify({ key: KEY }));
    openToOthers(f);
    const explicit = await run(['seat', 'status'], { home, env });
    expect(explicit.code).toBe(WOOK_EXIT.usage);
    expect(explicit.err[0]).toBe(`${f}의 권한(ACL)이 지금 사용자 밖의 계정에도 열려 있어 키를 쓰지 않습니다 — 열린 계정: BUILTIN\\Users (S-1-5-32-545) — 따로 준 권한. 지금 사용자만 읽게 좁히세요:`);
    expect(commands(explicit)).toEqual([`icacls "${f}" /remove:g "*S-1-5-32-545"`]);
    runAll(commands(explicit));
    expect((await run(['seat', 'status'], { home, env })).code).toBe(0);
    // ② 물려받은 권한 — 폴더에 다른 계정을 주고 새로 만든 파일 (상속을 끊는 명령)
    const home2 = tempDir('acl2');
    mkdirSync(join(home2, '.wook'));
    execFileSync(sys32('icacls.exe'), [join(home2, '.wook'), '/grant', '*S-1-5-32-545:(OI)(CI)R'], { stdio: 'ignore', windowsHide: true });
    const f2 = join(home2, '.wook', 'agent.json');
    writeFileSync(f2, JSON.stringify({ key: KEY }));
    const inherited = await run(['seat', 'status'], { home: home2, env });
    expect(inherited.code).toBe(WOOK_EXIT.usage);
    expect(inherited.err[0]).toContain('BUILTIN\\Users (S-1-5-32-545) — 물려받은 권한');
    expect(commands(inherited)[0]).toBe(`icacls "${f2}" /inheritance:r /grant:r "${process.env['USERDOMAIN']}\\${process.env['USERNAME']}:F"`);
    runAll(commands(inherited));
    expect((await run(['seat', 'status'], { home: home2, env })).code).toBe(0);
    // ③ 둘 다 — 상속을 끊고 따로 준 것을 지운다
    openToOthers(f2);
    execFileSync(sys32('icacls.exe'), [f2, '/inheritance:e'], { stdio: 'ignore', windowsHide: true });
    const both = await run(['seat', 'status'], { home: home2, env });
    expect(commands(both)).toEqual([
      `icacls "${f2}" /inheritance:r /grant:r "${process.env['USERDOMAIN']}\\${process.env['USERNAME']}:F"`,
      `icacls "${f2}" /remove:g "*S-1-5-32-545"`,
    ]);
    runAll(commands(both));
    expect((await run(['seat', 'status'], { home: home2, env })).code).toBe(0);
    expect(keyed().every((s) => s.path === `${PREFIX}/seat`)).toBe(true);
  });

  it('SDDL 판정·거부 글: 지금 사용자·SYSTEM·Administrators만이면 닫힘, 다른 허용 항목·NULL DACL이면 열림 (거부·상속 전용 항목은 보지 않는다)', () => {
    const u = 'S-1-5-21-1-2-3-1001';
    expect(sddlOpenToOthers(`f\r\nD:PAI(A;;FA;;;${u})(A;ID;FA;;;SY)(A;ID;FA;;;BA)\r\n`, u)).toBe(false);
    expect(sddlOpenToOthers(`f\r\nD:AI(A;ID;FA;;;${u})(A;;FR;;;BU)\r\n`, u)).toBe(true);
    expect(sddlOpenToOthers(`f\r\nD:AI(A;ID;FA;;;${u})(A;ID;0x1301bf;;;S-1-5-21-9-9-9-1002)\r\n`, u)).toBe(true);
    expect(sddlOpenToOthers(`f\r\nD:AI(A;ID;FA;;;${u})(D;;FA;;;WD)(A;OICIIO;FA;;;CO)\r\n`, u)).toBe(false);
    expect(sddlOpenToOthers('f\r\nD:NO_ACCESS_CONTROL\r\n', u)).toBe(true);
    expect(sddlOpenToOthers('f\r\n', u)).toBe(true);
    const others = sddlOthers(`f\r\nD:AI(A;;FR;;;BU)(A;ID;0x1301bf;;;S-1-5-21-9-9-9-1002)(A;ID;0x1301ff;;;S-1-5-21-9-9-9-1002)(A;ID;FA;;;SY)(A;ID;FA;;;${u})\r\n`, u);
    expect(others).toEqual([
      { sid: 'BU', inherited: false },
      { sid: 'S-1-5-21-9-9-9-1002', inherited: true },
      { sid: 'S-1-5-21-9-9-9-1002', inherited: true },
    ]);
    const names = new Map([['S-1-5-21-9-9-9-1002', 'PC\\Sandbox']]);
    expect(aclFixText('C:\\h\\agent.json', others, names, 'PC\\me')).toBe(
      [
        '열린 계정: BUILTIN\\Users (S-1-5-32-545) — 따로 준 권한, PC\\Sandbox (S-1-5-21-9-9-9-1002) — 물려받은 권한. 지금 사용자만 읽게 좁히세요:',
        '  icacls "C:\\h\\agent.json" /inheritance:r /grant:r "PC\\me:F"',
        '  icacls "C:\\h\\agent.json" /remove:g "*S-1-5-32-545"',
      ].join('\n'),
    );
    expect(aclFixText('C:\\a', null, new Map(), 'PC\\me')).toBe('권한(ACL) 목록이 없어 누구에게나 열려 있습니다. 지금 사용자만 읽게 좁히세요:\n  icacls "C:\\a" /inheritance:r /grant:r "PC\\me:F"');
    // icacls의 보통 출력 → 차례대로 이름 (첫 줄은 파일 이름 뒤)
    expect(icaclsNames('agent.json BUILTIN\\Users:(R)\r\n           S-1-5-21-9-9-9-1002:(I)(M)\r\n           NT AUTHORITY\\SYSTEM:(I)(F)\r\n\r\n1 파일을 처리했으며\r\n', 'agent.json')).toEqual(['BUILTIN\\Users', 'S-1-5-21-9-9-9-1002', 'NT AUTHORITY\\SYSTEM']);
    expect(icaclsNames('other.json X:(F)\r\n', 'agent.json')).toEqual([]);
  });

  it('WOOK_AGENT_URL은 루프백 http …/agent/v1만 — 아니면 2이고 그 값을 되풀이하지 않으며 어디에도 붙지 않는다. WOOK_AGENT_PROOF의 꼴이 틀려도 2', async () => {
    const home = tempDir('url');
    // 0.0.0.0: 호스트 규칙만 거부한다 (나머지는 포트·쿼리·https·경로·사용자 정보 규칙도 걸린다) — 거부하지 않으면 이 PC 밖으로 나가지 않고 실패한다
    for (const url of [`http://0.0.0.0:${port}/agent/v1`, 'http://SECRETX.example:80/agent/v1', `http://127.0.0.1:${port}/agent/v1?token=SECRETX`, `https://127.0.0.1:${port}/agent/v1`, `http://127.0.0.1:${port}/SECRETX`, `http://u:SECRETX@127.0.0.1:${port}/agent/v1`]) {
      const r = await run(['seat', 'status'], { home, env: { WOOK_AGENT_URL: url } });
      expect(r.code).toBe(WOOK_EXIT.usage);
      expect(r.err[0]).toMatch(/^WOOK_AGENT_URL은 이 PC의 루프백 주소/);
      expect(r.err.join('\n')).not.toContain('SECRETX');
    }
    for (const proof of ['SECRETX', `${PROOF}=`, randomBytes(31).toString('base64url'), randomBytes(32).toString('base64')]) {
      const r = await run(['seat', 'status'], { home, env: { WOOK_AGENT_PROOF: proof } });
      expect([r.code, r.err[0]]).toEqual([WOOK_EXIT.usage, 'WOOK_AGENT_PROOF는 agent-endpoint.json의 proof 값(43자 base64url)이어야 합니다 (적은 값은 보이지 않습니다)']);
      expect(r.err.join('\n').includes(proof)).toBe(false);
    }
    expect(seen).toHaveLength(0);
    expect([loopbackApi(`http://localhost:${port}/agent/v1/`), loopbackApi(`http://[::1]:${port}/agent/v1`)]).toEqual([`http://localhost:${port}/agent/v1`, `http://[::1]:${port}/agent/v1`]);
  });

  it('agent-endpoint.json: 없음·알 수 없는 내용·pid 없음·proof 없음·끝난 서버(pid)는 5 — 그 포트로 아무것도 보내지 않는다. 살아 있는 서버면 hello로 확인한 뒤 그 주소', async () => {
    const home = tempDir('ep');
    const dataDir = tempDir('epdata');
    const file = join(dataDir, 'agent-endpoint.json');
    const env = { WOOK_AGENT_URL: undefined, WOOK_DATA_DIR: dataDir };
    routes['GET /seat'] = SEAT_OK;

    const missing = await run(['seat', 'status'], { home, env });
    expect([missing.code, missing.err[0]]).toEqual([WOOK_EXIT.unreachable, `이 데이터 폴더(${dataDir})로 실행 중인 욱채 서버가 없습니다 (agent-endpoint.json 없음) — 서버가 떠 있는지, --data-dir·WOOK_DATA_DIR이 서버와 같은지 보세요`]);

    writeFileSync(file, '{"version": 1, "agentApi": "http://example.com/agent/v1"}');
    const strange = await run(['seat', 'status'], { home, env });
    expect([strange.code, strange.err[0]]).toEqual([WOOK_EXIT.unreachable, `${file}의 내용을 알 수 없습니다 — 서버를 다시 시작하면 새로 씁니다`]);

    writeEndpoint(dataDir, { pid: undefined });
    const noPid = await run(['seat', 'status'], { home, env });
    expect([noPid.code, noPid.err[0]]).toEqual([WOOK_EXIT.unreachable, `${file}에 서버 pid가 없습니다 — 지금 판의 욱채 서버가 쓴 파일이 아닙니다. 서버를 다시 시작하면 새로 씁니다 (키를 보내지 않았습니다)`]);
    for (const proof of [undefined, 'short', `${PROOF}=`, 42]) {
      writeEndpoint(dataDir, { proof });
      const noProof = await run(['seat', 'status'], { home, env });
      expect([noProof.code, noProof.err[0]]).toEqual([WOOK_EXIT.unreachable, `${file}에 서버 확인값(proof)이 없거나 꼴이 틀립니다 — 지금 판의 욱채 서버가 쓴 파일이 아닙니다. 서버를 다시 시작하면 새로 씁니다 (키를 보내지 않았습니다)`]);
    }

    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    writeEndpoint(dataDir, { pid: dead });
    const stale = await run(['seat', 'status'], { home, env });
    expect([stale.code, stale.err[0]]).toEqual([WOOK_EXIT.unreachable, `${file}이(가) 가리키는 서버(pid ${dead})가 끝났습니다 — 서버를 다시 띄우면 새 주소를 씁니다 (키를 그 포트로 보내지 않았습니다)`]);
    expect(seen).toHaveLength(0);

    writeEndpoint(dataDir);
    const live = await run(['seat', 'status', '--data-dir', dataDir], { home, env: { WOOK_AGENT_URL: undefined } });
    expect(live.code).toBe(0);
    expect(live.out).toBe('메인 자리: 세대 1 · 앉아 있음 · 보유자 Claude CLI\n  이 에이전트에게 배정됨: 아니요\n  이 에이전트의 임대: 없음 — wook seat claim으로 잡습니다\n');
    // hello(키 없이, 새 32바이트 nonce) 다음에 키를 실은 요청
    expect(seen.map((s) => [s.method, s.path.replace(PREFIX, ''), s.auth === undefined, s.token === undefined])).toEqual([
      ['POST', '/hello', true, true],
      ['GET', '/seat', false, true],
    ]);
    expect(Buffer.from(String(seen[0]!.body['nonce']), 'base64url')).toHaveLength(32);
  });

  it('--data-dir·--file·--json-file로 받은 경로는 거부 글에 되풀이하지 않는다 — WOOK_DATA_DIR이면 그 폴더를 말한다 (S7-19 C12)', async () => {
    const home = tempDir('echo');
    seedState(home);
    const flagDir = join(tempDir('echodir'), 'SECRETX');
    const viaFlag = await run(['seat', 'status', '--data-dir', flagDir], { home, env: { WOOK_AGENT_URL: undefined } });
    expect([viaFlag.code, viaFlag.err[0]]).toEqual([WOOK_EXIT.unreachable, '--data-dir로 준 데이터 폴더로 실행 중인 욱채 서버가 없습니다 (agent-endpoint.json 없음) — 서버가 떠 있는지, --data-dir·WOOK_DATA_DIR이 서버와 같은지 보세요']);
    mkdirSync(flagDir);
    writeEndpoint(flagDir, { pid: undefined });
    const noPid = await run(['seat', 'status', '--data-dir', flagDir], { home, env: { WOOK_AGENT_URL: undefined } });
    expect([noPid.code, noPid.err[0]]).toEqual([WOOK_EXIT.unreachable, '--data-dir로 준 데이터 폴더의 agent-endpoint.json에 서버 pid가 없습니다 — 지금 판의 욱채 서버가 쓴 파일이 아닙니다. 서버를 다시 시작하면 새로 씁니다 (키를 보내지 않았습니다)']);
    const viaEnv = await run(['seat', 'status'], { home, env: { WOOK_AGENT_URL: undefined, WOOK_DATA_DIR: flagDir } });
    expect(viaEnv.err[0]).toContain(join(flagDir, 'agent-endpoint.json'));
    const file = await run(['work', 'done', 'TN-0007', '--file', join(home, 'SECRETX.md')], { home });
    expect([file.code, file.err[0]]).toEqual([WOOK_EXIT.usage, '마지막 답 파일(--file)을 읽지 못했습니다 (ENOENT) — 경로를 확인하세요 (적은 값은 보이지 않습니다)']);
    const args = await run(['tool', 'get_overview', '--json-file', join(home, 'SECRETX.json')], { home });
    expect([args.code, args.err[0]]).toEqual([WOOK_EXIT.usage, '도구 인자 파일(--json-file)을 읽지 못했습니다 (ENOENT) — 경로를 확인하세요 (적은 값은 보이지 않습니다)']);
    for (const r of [viaFlag, noPid, file, args]) expect(r.err.join('\n')).not.toContain('SECRETX');
    expect(seen).toHaveLength(0);
    // --out: 캡처는 됐지만 그 파일을 쓰지 못함 — 적은 경로를 되풀이하지 않는다 (S7-22 K4)
    seedState(home, { heartbeatMs: 60_000 });
    routes['POST /tool/*'] = () => ok({ data: { capture_id: 'SC-000044', width: 10, height: 10 } });
    routes['GET /screens/SC-*'] = () => ({ status: 200, raw: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' });
    const out = await run(['screen', 'capture', '--out', join(home, 'no-such-folder', 'SECRETX.png')], { home });
    expect([out.code, out.err]).toEqual([WOOK_EXIT.refused, ['캡처를 --out의 파일에 쓰지 못했습니다 (ENOENT) — 경로를 확인하세요 (적은 값은 보이지 않습니다)']]);
  });

  it('POSIX의 agent.json 거부 글은 경로를 따옴표로 감싼 chmod 명령을 말한다 — 빈칸이 든 집 폴더에서도 그대로 쓸 수 있게 (S7-22 K7)', async () => {
    const home = join(tempDir('posix'), '빈칸 든 집');
    const f = writeKeyFile(home, JSON.stringify({ key: KEY }));
    if (win) execFileSync(sys32('icacls.exe'), [f, '/grant', '*S-1-5-32-545:R'], { stdio: 'ignore', windowsHide: true });
    else chmodSync(f, 0o644);
    // Windows에서는 파일의 mode가 늘 그룹·다른 사용자 읽기를 말하므로 POSIX 갈래가 거부한다 — 그 글만 본다
    const r = await run(['seat', 'status'], { home, env: { WOOK_AGENT_KEY: undefined }, io: { platform: 'linux' } });
    expect([r.code, r.err[0]]).toEqual([WOOK_EXIT.usage, `${f}을(를) 다른 사용자도 읽을 수 있어 키를 쓰지 않습니다 — chmod 600 "${f}"로 지금 사용자만 읽게 하세요`]);
    expect(seen).toHaveLength(0);
  });

  it('닫힌 포트는 5, 에이전트 API가 아닌 답은 5 — 키를 그 프로그램에 보냈을 수 있으니 폐기와 새 등록을 말한다 (S7-19 C3)', async () => {
    const home = tempDir('down');
    const closed = await run(['seat', 'status'], { home, env: { WOOK_AGENT_URL: 'http://127.0.0.1:1/agent/v1' } });
    expect(closed.code).toBe(WOOK_EXIT.unreachable);
    expect(closed.err[0]).toMatch(/^욱채 서버의 에이전트 API\(http:\/\/127\.0\.0\.1:1\/agent\/v1\)에 닿지 못했습니다 \(ECONNREFUSED\)/);
    routes['GET /seat'] = () => ({ status: 200, raw: Buffer.from('<html>다른 프로그램</html>'), type: 'text/html' });
    const other = await run(['seat', 'status'], { home });
    expect([other.code, other.err[0]]).toEqual([
      WOOK_EXIT.unreachable,
      '그 주소에서 답한 쪽이 욱채 에이전트 API가 아닙니다 (HTTP 200) — 키를 그 프로그램에 보냈을 수 있습니다: 운영자에게 이 에이전트를 폐기(wook-server agent revoke)하고 새로 등록(agent add)해 달라고 하세요. 서버가 끝났거나 다시 시작해 주소가 바뀌었을 수도 있습니다',
    ]);
  });
});

describe('서버 확인 — 키·턴 토큰을 싣는 요청 앞의 hello (리드 결정 S7-19 C3)', () => {
  /** 모든 명령 — 임대·턴이 있는 state.json으로 (임대·턴이 없어서 거부되지 않게) */
  const COMMANDS = (home: string): string[][] => {
    const answer = join(home, 'a.md');
    writeFileSync(answer, '답');
    const args = join(home, 'args.json');
    writeFileSync(args, '{}');
    return [
      ['seat', 'claim'],
      ['seat', 'status'],
      ['seat', 'heartbeat'],
      ['seat', 'release'],
      ['work', 'next'],
      ['work', 'next', '--wait'],
      ['work', 'progress', 'TN-0007', '--text', '진행'],
      ['work', 'done', 'TN-0007', '--file', answer],
      ['tool', 'get_overview'],
      ['tool', 'get_overview', '--json-file', args],
      ['screen', 'capture', '--out', join(home, 'a.png')],
      ['stop'],
    ];
  };
  const proofEnv = { WOOK_AGENT_PROOF: PROOF };

  it('맞지 않는 mac·모양이 다른 답·다른 확인값의 mac·끊긴 연결이면 어느 명령도 키·턴 토큰을 보내지 않는다 (5) — 뒤에서 보내는 heartbeat도', async () => {
    const home = tempDir('hello-bad');
    const wrongs: [string, Route, RegExp][] = [
      ['틀린 mac', () => ok({ mac: randomBytes(32).toString('base64url') }), /\(확인값이 맞지 않음\) — 키를 보내지 않았습니다/],
      ['다른 proof의 mac', (s) => ok({ mac: macOf(String(s.body['nonce']), randomBytes(32).toString('base64url')) }), /\(확인값이 맞지 않음\)/],
      ['mac 없음', () => ok({}), /\(답의 모양이 다름\)/],
      ['짧은 mac', () => ok({ mac: 'AAAA' }), /\(확인값이 맞지 않음\)/],
      ['HTML 404', () => ({ status: 404, raw: Buffer.from('not here'), type: 'text/plain' }), /\(HTTP 404\)/],
      ['인증 거부', () => refuse(401, 'unauthorized', '키'), /\(HTTP 401\)/],
    ];
    for (const [what, route, re] of wrongs) {
      for (const argv of COMMANDS(home)) {
        seedState(home, { heartbeatMs: 50 });
        seen = [];
        routes = { 'POST /hello': route, 'POST /seat/heartbeat': () => ok({ state: 'active', generation: 2, leaseExpiresAt: 'x', queued: 0 }) };
        const r = await run(argv, { home, env: proofEnv });
        expect([what, argv.join(' '), r.code]).toEqual([what, argv.join(' '), WOOK_EXIT.unreachable]);
        expect(r.err[0]).toMatch(/^그 주소\(http:\/\/127\.0\.0\.1:\d+\/agent\/v1\)에서 듣는 쪽이 WOOK_AGENT_PROOF를 아는 욱채 서버임을 증명하지 못했습니다 /);
        expect(r.err[0]).toMatch(re);
        expect(r.err).toHaveLength(1);
        expect([what, argv.join(' '), seen.map((s) => s.path.replace(PREFIX, '')), keyed().length]).toEqual([what, argv.join(' '), ['/hello'], 0]);
      }
    }
    // 연결을 끊는 듣는 쪽 — 닿지 못함(5), 키 없음
    for (const argv of COMMANDS(home)) {
      seedState(home, { heartbeatMs: 50 });
      seen = [];
      routes = { 'POST /hello': () => ({ status: 0, destroy: true }) };
      const r = await run(argv, { home, env: proofEnv });
      expect([argv.join(' '), r.code, keyed().length]).toEqual([argv.join(' '), WOOK_EXIT.unreachable, 0]);
      expect(r.err[0]).toMatch(/에 닿지 못했습니다 \(/);
    }
  });

  it('답하지 않거나 조금씩 흘려 보내는 hello는 5초에 끊는다 — 그동안 heartbeat 시계가 돌아도 키를 보내지 않는다', async () => {
    const home = tempDir('hello-slow');
    for (const [what, a] of [
      ['답 없음', { status: 0, hang: true }],
      ['조금씩', { status: 200, trickleMs: 200, trickleForMs: 9000 }],
    ] as [string, Answer][]) {
      for (const argv of [['tool', 'get_overview'], ['work', 'next', '--wait']]) {
        seedState(home, { heartbeatMs: 50, turn: argv[0] === 'tool' });
        seen = [];
        routes = { 'POST /hello': () => a };
        const r = await run(argv, { home, env: proofEnv });
        expect([what, argv.join(' '), r.code, r.err[0]]).toEqual([
          what,
          argv.join(' '),
          WOOK_EXIT.unreachable,
          `그 주소(${api})에서 듣는 쪽이 WOOK_AGENT_PROOF를 아는 욱채 서버임을 증명하지 못했습니다 (${HELLO_TIMEOUT_MS / 1000}초 안에 답이 끝나지 않음) — 키를 보내지 않았습니다. 서버가 다시 시작했으면 WOOK_AGENT_URL과 WOOK_AGENT_PROOF를 새 agent-endpoint.json의 agentApi·proof로 바꾸세요`,
        ]);
        expect(r.ms).toBeGreaterThanOrEqual(HELLO_TIMEOUT_MS - 100);
        expect(r.ms).toBeLessThan(HELLO_TIMEOUT_MS + 3000);
        expect(keyed()).toHaveLength(0);
        // heartbeat 시계는 서버 확인이 끝날 때까지 아무것도 하지 않는다 — 같은 실패를 heartbeat 줄로 되풀이하지 않는다
        expect(r.err).toHaveLength(1);
      }
    }
    server.closeAllConnections();
  }, 60_000);

  it('넘겨 주는 hello(302·307)는 따라가지 않는다 — 넘겨 준 곳도 넘겨 받은 곳도 키·턴 토큰을 받지 않는다', async () => {
    const home = tempDir('hello-redirect');
    const target: Seen[] = [];
    const other = createServer((req, res) => {
      target.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, token: req.headers['x-wook-turn-token'] as string | undefined, body: {}, at: steadyNow(), conn: connOf(req.socket), onProved: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"mac":"x"}');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    try {
      const to = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
      for (const status of [302, 307]) {
        for (const argv of [['seat', 'status'], ['tool', 'get_overview']]) {
          seedState(home);
          seen = [];
          // 본문에 맞는 mac이 있어도(그 proof를 아는 쪽이어도) 200이 아닌 답은 받지 않는다
          routes = { 'POST /hello': (s) => ({ status, headers: { Location: `${to}/agent/v1/hello` }, json: { ok: true, mac: macOf(String(s.body['nonce'])) } }) };
          const r = await run(argv, { home, env: proofEnv });
          expect([status, argv.join(' '), r.code, keyed().length]).toEqual([status, argv.join(' '), WOOK_EXIT.unreachable, 0]);
          expect(r.err[0]).toContain(`(HTTP ${status}) — 키를 보내지 않았습니다`);
        }
      }
      expect(target).toEqual([]);
    } finally {
      other.closeAllConnections();
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it('hello는 연결마다 한 번 — 키를 실은 요청은 모두 그 연결에서 먼저 맞게 답한 연결로 간다. 쉬는 증명한 연결은 다시 쓰고 묻지 않는다. 429도 5이고 키는 보내지 않는다 (S7-22 K1·K3)', async () => {
    const home = tempDir('hello-once');
    seedState(home, { heartbeatMs: 50 });
    routes['POST /seat/heartbeat'] = () => ok({ state: 'active', generation: 2, leaseExpiresAt: 'x', queued: 0 });
    routes['POST /tool/*'] = () => ({ ...ok({ data: { fine: true } }), delayMs: 500 });
    const r = await run(['tool', 'get_overview'], { home, env: proofEnv });
    expect(r.code).toBe(0);
    expect(seen[0]!.path).toBe(`${PREFIX}/hello`);
    expect(beats().length).toBeGreaterThanOrEqual(3);
    // 키를 실은 요청은 모두 같은 연결에서 먼저 증명한 연결로 갔다. 도구가 한 연결을 쥐는 동안 heartbeat는 둘째 연결을 증명해 썼다 — 연결마다 hello 하나, 그 뒤로는 다시 묻지 않는다
    const keyedReqs = seen.filter((s) => s.auth !== undefined);
    expect(keyedReqs.every((s) => s.auth === `Bearer ${KEY}` && s.onProved)).toBe(true);
    const hellos = seen.filter((s) => s.path.endsWith('/hello'));
    expect(hellos.length).toBe(new Set(hellos.map((s) => s.conn)).size);
    expect(new Set(keyedReqs.map((s) => s.conn)).size).toBe(hellos.length);
    expect(hellos.length).toBeLessThanOrEqual(3);
    // 파일에서 주소를 읽었을 때도 (WOOK_AGENT_PROOF 없이 그 파일의 proof로)
    const dataDir = tempDir('hello-once-data');
    writeEndpoint(dataDir);
    seen = [];
    routes['GET /seat'] = SEAT_OK;
    expect((await run(['seat', 'status'], { home, env: { WOOK_AGENT_URL: undefined, WOOK_DATA_DIR: dataDir } })).code).toBe(0);
    expect(seen.map((s) => s.path.replace(PREFIX, ''))).toEqual(['/hello', '/seat']);
    // WOOK_AGENT_URL만(WOOK_AGENT_PROOF 없이)이면 묻지 않는다 — 듣는 쪽을 확인하지 않는다(안내서가 그렇게 말한다)
    seen = [];
    expect((await run(['seat', 'status'], { home })).code).toBe(0);
    expect(seen.map((s) => s.path.replace(PREFIX, ''))).toEqual(['/seat']);
    // 429도 '증명하지 못함' — 이 서버는 hello에 429로 답하지 않는다 (S7-22 K3). 5이고 키는 보내지 않는다
    seen = [];
    routes['POST /hello'] = () => ({ ...refuse(429, 'rate_limited', '인증하지 못한 요청이 너무 많습니다 — 30초 뒤에 다시 하세요'), headers: { 'Retry-After': '30' } });
    const limited = await run(['seat', 'status'], { home, env: proofEnv });
    expect([limited.code, limited.err[0]!.includes('증명하지 못했습니다 (HTTP 429) — 키를 보내지 않았습니다'), keyed().length]).toEqual([WOOK_EXIT.unreachable, true, 0]);
  });

  it('nonce는 프로세스마다 새것이다 — 둘은 다르고, 앞 nonce의 mac을 되풀이하는 듣는 쪽은 증명하지 못한다 (S7-22 K5)', async () => {
    const home = tempDir('nonce');
    routes['GET /seat'] = SEAT_OK;
    expect((await run(['seat', 'status'], { home, env: proofEnv })).code).toBe(0);
    expect((await run(['seat', 'status'], { home, env: proofEnv })).code).toBe(0);
    const nonces = seen.filter((s) => s.path.endsWith('/hello')).map((s) => String(s.body['nonce']));
    expect([nonces.length, new Set(nonces).size, nonces.every((n) => Buffer.from(n, 'base64url').length === 32)]).toEqual([2, 2, true]);
    // 되풀이: 앞서 본 맞는 답(nonce와 mac)을 그대로 돌려주는 듣는 쪽
    const recorded = { ok: true, mac: macOf(nonces[0]!) };
    seen = [];
    routes['POST /hello'] = () => ({ status: 200, json: recorded });
    const replay = await run(['seat', 'status'], { home, env: proofEnv });
    expect([replay.code, replay.err[0]!.includes('(확인값이 맞지 않음) — 키를 보내지 않았습니다'), keyed().length]).toEqual([WOOK_EXIT.unreachable, true, 0]);
  });
});

describe('연결마다 서버 확인 — 바뀐 듣는 쪽에는 키·임대 ID·턴 토큰이 가지 않는다 (리드 결정 S7-22 K1)', () => {
  /** 따로 띄우는 가짜 리스너 (port를 주면 그 포트에 — 앞 리스너가 놓은 포트를 다른 프로그램이 차지하는 것처럼) */
  async function listener(table: Record<string, Route>, at = 0): Promise<{ server: Server; port: number; seen: Seen[] }> {
    const own: Seen[] = [];
    const srv = createServer(fakeHandler(() => own, () => table));
    const t0 = Date.now();
    for (;;) {
      try {
        await new Promise<void>((ok2, fail) => {
          srv.once('error', fail);
          srv.listen(at, '127.0.0.1', () => {
            srv.off('error', fail);
            ok2();
          });
        });
        break;
      } catch (error) {
        if (Date.now() - t0 > 3000) throw error;
        await sleep(5);
      }
    }
    return { server: srv, port: (srv.address() as { port: number }).port, seen: own };
  }
  const shut = async (l: { server: Server }): Promise<void> => {
    l.server.closeAllConnections();
    await new Promise<void>((r) => l.server.close(() => r()));
  };
  const leaked = (list: Seen[]): boolean => list.some((s) => s.auth !== undefined || s.token !== undefined || JSON.stringify(s.body).includes(LEASE));
  const notSent = /에서 듣는 쪽이 WOOK_AGENT_PROOF를 아는 욱채 서버임을 증명하지 못했습니다 \(.+\) — 키를 보내지 않았습니다/;

  it('work next --wait: 증명한 서버가 롱폴에 204를 준 뒤 사라지고 다른 프로그램이 그 포트를 차지하면, 다음 롱폴 전에 새 연결을 증명하지 못해 5 — 그 프로그램은 키·임대를 받지 않는다 (리뷰 R5/PA)', async () => {
    let squat: Awaited<ReturnType<typeof listener>> | null = null;
    const genuine = await listener({
      'POST /work/next': () => {
        // 정상 종료하는 서버처럼 열린 롱폴에 204를 곧바로 주고 사라진다 — 다른 프로그램이 그 포트를 곧바로 차지한다
        setTimeout(async () => {
          await shut(genuine);
          squat = await listener({ 'POST /hello': () => ({ status: 404, json: { nope: true } }) }, genuine.port);
        }, 300);
        return { status: 204, delayMs: 200 };
      },
    });
    const home = tempDir('pa');
    seedState(home, { heartbeatMs: 600_000, pollMaxMs: 25_000, turn: false });
    const r = await run(['work', 'next', '--wait'], { home, env: { WOOK_AGENT_URL: `http://127.0.0.1:${genuine.port}${PREFIX}`, WOOK_AGENT_PROOF: PROOF } });
    const got = (squat as Awaited<ReturnType<typeof listener>> | null)?.seen ?? [];
    expect([r.code, r.err.length, notSent.test(r.err[0] ?? '')]).toEqual([WOOK_EXIT.unreachable, 1, true]);
    expect(got.length).toBeGreaterThan(0);
    expect([leaked(got), got.map((s) => s.path)]).toEqual([false, [`${PREFIX}/hello`]]);
    // 진짜 서버에는 hello 다음에 키를 실은 롱폴 — 같은 연결에서
    expect(genuine.seen.filter((s) => s.auth !== undefined).every((s) => s.onProved)).toBe(true);
    if (squat) await shut(squat);
  }, 20_000);

  it('wook tool의 heartbeat: 도구가 도는 사이 서버가 사라지고 다른 프로그램이 그 포트에서 받으면, heartbeat도 도구의 재시도도 새 연결을 증명하지 못해 아무것도 보내지 않는다 — 5', async () => {
    // 포트를 다시 묶는 틈 없이 바꾼다: 한 리스너가 그때까지의 연결을 모두 끊고, 그 뒤의 연결에는 그 proof를 모르는 프로그램처럼 답한다
    let replaced = false;
    const after: Seen[] = [];
    const l = await listener({
      'POST /hello': (s) => {
        if (replaced) after.push(s);
        return replaced ? { status: 200, json: { ok: true, mac: randomBytes(32).toString('base64url') } } : { status: 200, json: { ok: true, mac: macOf(String(s.body['nonce'])) } };
      },
      'POST /seat/heartbeat': (s) => {
        if (replaced) after.push(s);
        return ok({ state: 'active', generation: 2, leaseExpiresAt: 'x', queued: 0 });
      },
      'POST /tool/*': (s) => {
        if (replaced) {
          after.push(s);
          return ok({ data: { wrong: true } });
        }
        setTimeout(() => {
          replaced = true;
          l.server.closeAllConnections();
        }, 400);
        return { ...ok({ data: { fine: true } }), delayMs: 3000 };
      },
    });
    const home = tempDir('pa-hb');
    seedState(home, { heartbeatMs: 100 });
    const r = await run(['tool', 'get_overview'], { home, env: { WOOK_AGENT_URL: `http://127.0.0.1:${l.port}${PREFIX}`, WOOK_AGENT_PROOF: PROOF } });
    // 도구의 연결이 끊기자 새 연결을 증명하려 했고 실패했다 — 5. 그 뒤의 heartbeat도 키를 보내지 않았다
    expect([r.code, r.out, notSent.test(r.err[0] ?? '')]).toEqual([WOOK_EXIT.unreachable, '', true]);
    expect(after.length).toBeGreaterThan(0);
    expect([leaked(after), after.every((s) => s.path === `${PREFIX}/hello`)]).toEqual([false, true]);
    // 바뀌기 전의 heartbeat는 증명한 둘째 연결로 갔다
    expect(l.seen.filter((s) => s.path.endsWith('/seat/heartbeat')).length).toBeGreaterThanOrEqual(1);
    expect(l.seen.filter((s) => s.auth !== undefined).every((s) => s.onProved)).toBe(true);
    await shut(l);
  }, 20_000);

  it('첫 hello에 맞게 답하고 그 연결을 닫는 듣는 쪽 — 키를 실은 요청은 새 연결을 다시 증명한 뒤에만 간다', async () => {
    let first = true;
    const l = await listener({
      'POST /hello': (s) => {
        const a: Answer = { status: 200, json: { ok: true, mac: macOf(String(s.body['nonce'])) }, ...(first ? { headers: { Connection: 'close' } } : {}) };
        first = false;
        return a;
      },
      'GET /seat': SEAT_OK,
    });
    const r = await run(['seat', 'status'], { home: tempDir('close'), env: { WOOK_AGENT_URL: `http://127.0.0.1:${l.port}${PREFIX}`, WOOK_AGENT_PROOF: PROOF } });
    expect(r.code).toBe(0);
    const paths = l.seen.map((s) => [s.path.replace(PREFIX, ''), s.conn, s.onProved]);
    expect(paths.map((p) => p[0])).toEqual(['/hello', '/hello', '/seat']);
    // 둘째 hello와 키를 실은 요청은 같은 (새) 연결 — 첫 연결에는 키가 가지 않았다
    expect([paths[1]![1] === paths[2]![1], paths[0]![1] !== paths[2]![1], paths[2]![2]]).toEqual([true, true, true]);
    await shut(l);
  });

  it('같은 포트에서 첫 연결은 증명하고 다음 연결은 다른 듣는 쪽 — 도구는 증명한 연결에서 끝나고, 새 연결의 heartbeat는 증명하지 못해 키를 보내지 않는다', async () => {
    // 연결 차례로 행동을 바꾸는 한 리스너 — 첫 연결은 진짜, 그 뒤의 연결은 그 proof를 모르는 다른 프로그램
    const conns: number[] = [];
    const l = await listener({
      'POST /hello': (s) => {
        if (!conns.length) conns.push(s.conn);
        return s.conn === conns[0] ? { status: 200, json: { ok: true, mac: macOf(String(s.body['nonce'])) } } : { status: 200, json: { ok: true, mac: randomBytes(32).toString('base64url') } };
      },
      'POST /tool/*': () => ({ ...ok({ data: { fine: true } }), delayMs: 800 }),
      'POST /seat/heartbeat': () => ok({ state: 'active', generation: 2, leaseExpiresAt: 'x', queued: 0 }),
    });
    const home = tempDir('two-conns');
    seedState(home, { heartbeatMs: 100 });
    const r = await run(['tool', 'get_overview'], { home, env: { WOOK_AGENT_URL: `http://127.0.0.1:${l.port}${PREFIX}`, WOOK_AGENT_PROOF: PROOF } });
    expect([r.code, JSON.parse(r.out)]).toEqual([0, { fine: true }]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(/^\(heartbeat\) 그 주소\(.+\)에서 듣는 쪽이 WOOK_AGENT_PROOF를 아는 욱채 서버임을 증명하지 못했습니다 \(확인값이 맞지 않음\) — 키를 보내지 않았습니다/);
    const other = l.seen.filter((s) => s.conn !== conns[0]);
    expect(other.length).toBeGreaterThan(0);
    expect([leaked(other), other.every((s) => s.path === `${PREFIX}/hello`)]).toEqual([false, true]);
    expect(l.seen.filter((s) => s.auth !== undefined).every((s) => s.conn === conns[0] && s.onProved)).toBe(true);
    await shut(l);
  });

  it('agent-endpoint.json에서 읽었으면 next --wait는 기다리는 사이 그 파일이 없어지거나 runId·proof가 바뀌면 다음 롱폴을 보내지 않고 5 (둘째 지킴)', async () => {
    const dataDir = tempDir('guard');
    const file = writeEndpoint(dataDir);
    const home = tempDir('guard-home');
    seedState(home, { heartbeatMs: 600_000, pollMaxMs: 25_000, turn: false });
    const env = { WOOK_AGENT_URL: undefined, WOOK_DATA_DIR: dataDir };
    for (const [what, change, sentence] of [
      ['파일 없음', () => unlinkSync(file), `서버가 끝났습니다 (${file} 없음) — 기다리기를 멈췄습니다. 키를 보내지 않았습니다 — 서버가 다시 뜨면 wook seat claim부터 하세요`],
      ['runId 바뀜', () => writeEndpoint(dataDir, { runId: 'r2' }), `서버가 다시 시작했거나 바뀌었습니다 (${file}의 runId·proof가 바뀜) — 기다리기를 멈췄습니다. 키를 보내지 않았습니다 — wook seat claim부터 다시 하세요`],
      ['proof 바뀜', () => writeEndpoint(dataDir, { proof: randomBytes(32).toString('base64url') }), `서버가 다시 시작했거나 바뀌었습니다 (${file}의 runId·proof가 바뀜) — 기다리기를 멈췄습니다. 키를 보내지 않았습니다 — wook seat claim부터 다시 하세요`],
    ] as [string, () => void, string][]) {
      writeEndpoint(dataDir);
      seen = [];
      let polls = 0;
      routes['POST /work/next'] = () => {
        polls += 1;
        if (polls === 1) change();
        return { status: 204, delayMs: 100 };
      };
      const r = await run(['work', 'next', '--wait'], { home, env });
      expect([what, r.code, r.err]).toEqual([what, WOOK_EXIT.unreachable, [sentence]]);
      expect([what, polls]).toEqual([what, 1]);
    }
  }, 20_000);
});

describe('끝 코드 — 서버의 답 (S7-5)', () => {
  it('401 → 3, 409 → 4, 403·404 → 1 — 서버의 코드와 글을 그대로', async () => {
    const home = tempDir('codes');
    seedState(home);
    routes['POST /seat/heartbeat'] = () => refuse(401, 'unauthorized', '에이전트 키가 맞지 않거나 폐기됐습니다');
    expect(await run(['seat', 'heartbeat'], { home })).toMatchObject({ code: WOOK_EXIT.unauthorized, err: ['unauthorized: 에이전트 키가 맞지 않거나 폐기됐습니다'] });
    routes['POST /seat/heartbeat'] = () => refuse(409, 'lease_superseded', '같은 에이전트가 자리를 다시 요청해 이 임대는 끝났습니다 — 새 임대(leaseId)를 쓰세요');
    expect(await run(['seat', 'heartbeat'], { home })).toMatchObject({ code: WOOK_EXIT.conflict, err: ['lease_superseded: 같은 에이전트가 자리를 다시 요청해 이 임대는 끝났습니다 — 새 임대(leaseId)를 쓰세요'] });
    routes['POST /seat/claim'] = () => refuse(403, 'not_assigned', '메인 자리는 이 에이전트(X-0001)에게 배정돼 있지 않습니다');
    expect(await run(['seat', 'claim'], { home })).toMatchObject({ code: WOOK_EXIT.refused, err: ['not_assigned: 메인 자리는 이 에이전트(X-0001)에게 배정돼 있지 않습니다'] });
    expect(await run(['work', 'progress', 'TN-0009', '--text', '진행'], { home })).toMatchObject({ code: WOOK_EXIT.refused, err: ['not_found: 가짜: 없는 길'] });
    // 거부한 claim은 state.json을 바꾸지 않는다
    expect(JSON.parse(readFileSync(statePath(home), 'utf8')).leaseId === LEASE).toBe(true);
  });

  it('도구의 거부(200 ok:false)는 1 — 도구의 코드와 글을 표준 오류에 (S7-16 3 (h))', async () => {
    const home = tempDir('toolref');
    seedState(home, { heartbeatMs: 60_000 });
    routes['POST /tool/*'] = () => ({ status: 200, json: { ok: false, error: { code: 'forbidden', message: '그 도구는 메인 전용입니다' } } });
    const r = await run(['tool', 'list_questions', '--json', '{"project_id":"general"}'], { home });
    expect(r).toMatchObject({ code: WOOK_EXIT.refused, out: '', err: ['도구 거부(list_questions) — forbidden: 그 도구는 메인 전용입니다'] });
    // 키와 그 턴의 토큰을 함께, 본문은 인자 그대로
    expect(seen.map((s) => [s.path, s.auth === `Bearer ${KEY}`, s.token === TOKEN, s.body])).toEqual([[`${PREFIX}/tool/list_questions`, true, true, { project_id: 'general' }]]);
  });

  it('임대가 없거나 받은 턴이 없으면 1이고 서버에 붙지 않는다', async () => {
    const home = tempDir('nolease');
    const none = await run(['seat', 'heartbeat'], { home });
    expect([none.code, none.err[0]]).toEqual([WOOK_EXIT.refused, `임대가 없습니다 — wook seat claim으로 메인 자리를 먼저 잡으세요 (${statePath(home)}에 임대가 없음)`]);
    seedState(home, { turn: false });
    const noTurn = await run(['tool', 'get_overview'], { home });
    expect([noTurn.code, noTurn.err[0]]).toEqual([WOOK_EXIT.refused, '받은 턴이 없습니다 — wook work next로 일을 받은 뒤 부르세요 (도구와 화면은 그 턴의 토큰으로 부릅니다)']);
    expect((await run(['screen', 'capture', '--out', join(home, 'a.png')], { home })).code).toBe(WOOK_EXIT.refused);
    // 서버 확인이 있어도 이 PC에서 막는 일은 아무것도 보내지 않는다 (hello도)
    expect((await run(['tool', 'get_overview'], { home, env: { WOOK_AGENT_PROOF: PROOF } })).code).toBe(WOOK_EXIT.refused);
    expect(seen).toHaveLength(0);
  });
});

describe('JSON 출력은 ASCII만 (리드 후속 11-11 — PowerShell 5.1·코드 페이지 949)', () => {
  const ascii = (t: string): boolean => [...t].every((c) => c.charCodeAt(0) < 0x80);
  const cp949 = (t: string): string => new TextDecoder('euc-kr').decode(Buffer.from(t, 'utf8'));

  it('work next의 일과 tool의 결과에 든 한글·이모지는 유니코드 이스케이프로 — cp949로 읽어도 같은 글이고 JSON으로 읽으면 원래 글이다. 들여쓰기는 그대로', async () => {
    const home = tempDir('ascii');
    seedState(home, { heartbeatMs: 60_000, turn: false });
    const item = { ...WORK(), message: '대표 명령: 오늘 할 일을 정리해 줘 😀', instructions: '# 욱채 메인 에이전트 작업 규칙', cwd: 'D:/작업 폴더/main', attachments: [{ name: '보고서.png', path: 'D:/첨부/보고서.png' }] };
    routes['POST /work/next'] = () => ok(item);
    const next = await run(['work', 'next'], { home });
    expect(next.code).toBe(0);
    expect([ascii(next.out), cp949(next.out) === next.out, next.out.startsWith('{\n  "turnId": "TN-0012",\n')]).toEqual([true, true, true]);
    const { ok: _ok, mcp: _mcp, ...rest } = { ok: true, ...item };
    expect(JSON.parse(cp949(next.out))).toEqual({ ...rest, mcp: { url: item.mcp.url } });

    routes['POST /tool/*'] = () => ok({ data: { summary: '프로젝트 둘 — 진행 중', members: ['개발자', 'QA'], emoji: '✅' } });
    const tool = await run(['tool', 'get_overview'], { home });
    expect(tool.code).toBe(0);
    expect([ascii(tool.out), cp949(tool.out) === tool.out]).toEqual([true, true]);
    expect(JSON.parse(cp949(tool.out))).toEqual({ summary: '프로젝트 둘 — 진행 중', members: ['개발자', 'QA'], emoji: '✅' });
    // 한국어 문장을 내는 명령은 그대로 (JSON이 아니다)
    expect(ascii((await run(['tool', 'get_overview', '--json', '[]'], { home })).err[0]!)).toBe(false);
  });
});

describe('임대 — 기다리는 동안 heartbeat (리드 결정 S7-16 3 (d))', () => {
  it('wook tool: 도구가 도는 동안 heartbeatMs마다 그 임대로 heartbeat를 보낸다', async () => {
    const home = tempDir('hbtool');
    seedState(home, { heartbeatMs: 100 });
    routes['POST /seat/heartbeat'] = () => ok({ state: 'active', generation: 2, leaseExpiresAt: new Date().toISOString(), queued: 0 });
    routes['POST /tool/*'] = () => ({ ...ok({ data: { projects: [] } }), delayMs: 900 });
    const r = await run(['tool', 'get_overview', '--json', '{}'], { home });
    expect([r.code, JSON.parse(r.out), r.err]).toEqual([0, { projects: [] }, []]);
    expect(beats().length).toBeGreaterThanOrEqual(4);
    expect(beats().every((b) => b.body['leaseId'] === LEASE && b.auth === `Bearer ${KEY}`)).toBe(true);
    // 도구가 끝나면 heartbeat도 멈춘다
    const n = beats().length;
    await sleep(350);
    expect(beats().length).toBe(n);
  });

  it('wook work next --wait: 일이 올 때까지 롱폴을 되풀이하며 heartbeat를 보낸다 — 받은 일은 토큰 없이 JSON으로, 토큰은 state.json에', async () => {
    const home = tempDir('hbnext');
    seedState(home, { heartbeatMs: 100, turn: false, pollMaxMs: 300 });
    routes['POST /seat/heartbeat'] = () => ok({ state: 'active', generation: 2, leaseExpiresAt: new Date().toISOString(), queued: 0 });
    let polls = 0;
    routes['POST /work/next'] = (s) => {
      polls += 1;
      if (polls < 4) return { status: 204, delayMs: Number(s.body['waitMs']) };
      return ok(WORK());
    };
    const r = await run(['work', 'next', '--wait'], { home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ turnId: 'TN-0012', workKey: 'Q-1', kind: 'main_general', projectId: null, generation: 2, cwd: 'C:\\w\\main', instructions: '규칙', message: '일', digest: null, attachments: [], deadlineAt: JSON.parse(r.out).deadlineAt, mcp: { url: 'http://127.0.0.1:9/mcp' } });
    expect(polls).toBe(4);
    expect(seen.filter((s) => s.path === `${PREFIX}/work/next`).every((s) => s.body['leaseId'] === LEASE && s.body['waitMs'] === 1000)).toBe(true);
    expect(beats().length).toBeGreaterThanOrEqual(3);
    const st = JSON.parse(readFileSync(statePath(home), 'utf8')) as { turn: { turnId: string; token: string } };
    expect([st.turn.turnId, st.turn.token === TOKEN]).toEqual(['TN-0012', true]);
  });

  it('--wait 없는 work next는 한 번만 묻고 heartbeat를 보내지 않는다 — 일이 없으면 0과 표준 오류의 한 줄', async () => {
    const home = tempDir('nowait');
    seedState(home, { heartbeatMs: 50, turn: false });
    routes['POST /work/next'] = () => ({ status: 204, delayMs: 300 });
    const r = await run(['work', 'next'], { home });
    expect([r.code, r.out, r.err]).toEqual([0, '', ['지금은 받을 일이 없습니다 (다시 하거나 --wait로 기다리세요)']]);
    expect(seen.map((s) => [s.path.replace(PREFIX, ''), s.body['waitMs']])).toEqual([['/work/next', 0]]);
  });

  it('wook screen capture: screen_capture 뒤 GET screens/{id}를 키와 턴 토큰으로 받아 파일에 쓰고, 기다리는 동안 heartbeat를 보낸다', async () => {
    const home = tempDir('hbcap');
    seedState(home, { heartbeatMs: 100 });
    routes['POST /seat/heartbeat'] = () => ok({ state: 'active', generation: 2, leaseExpiresAt: new Date().toISOString(), queued: 0 });
    routes['POST /tool/*'] = () => ({ ...ok({ data: { capture_id: 'SC-000042', width: 1280, height: 720, image: 'file_only', note: null } }), delayMs: 400 });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
    routes['GET /screens/SC-*'] = () => ({ status: 200, raw: png, type: 'image/png', delayMs: 400 });
    const out = join(home, 'a.png');
    const r = await run(['screen', 'capture', '--out', out], { home });
    expect([r.code, r.out, r.err]).toEqual([0, `화면을 찍어 저장했습니다: ${out} (캡처 SC-000042, 1280×720, ${png.length}바이트, 30초 동안 gui_input에 씁니다)\n`, []]);
    expect(readFileSync(out).equals(png)).toBe(true);
    expect(seen.filter((s) => !s.path.endsWith('/heartbeat')).map((s) => [s.method, s.path.replace(PREFIX, ''), s.token === TOKEN, s.auth === `Bearer ${KEY}`])).toEqual([
      ['POST', '/tool/screen_capture', true, true],
      ['GET', '/screens/SC-000042', true, true],
    ]);
    expect(beats().length).toBeGreaterThanOrEqual(4);
  });

  it('heartbeat의 409는 명령의 결과를 가리지 않는다 — 실패한 명령이면 그 글 뒤의 둘째 줄, 성공한 명령이면 표준 오류의 그 한 줄이고, 그 뒤로는 heartbeat를 보내지 않는다', async () => {
    const home = tempDir('hb409');
    seedState(home, { heartbeatMs: 100 });
    routes['POST /seat/heartbeat'] = () => refuse(409, 'lease_expired', '이 임대는 1.5초 동안 heartbeat가 없어 끝났습니다 — 다시 claim하세요');
    routes['POST /tool/*'] = () => ({ status: 200, json: { ok: false, error: { code: 'seat_changed', message: '메인 자리가 바뀌었습니다' } }, delayMs: 600 });
    const refused = await run(['tool', 'get_overview'], { home });
    expect([refused.code, refused.err]).toEqual([WOOK_EXIT.refused, ['도구 거부(get_overview) — seat_changed: 메인 자리가 바뀌었습니다', '(heartbeat) lease_expired: 이 임대는 1.5초 동안 heartbeat가 없어 끝났습니다 — 다시 claim하세요']]);
    expect(beats()).toHaveLength(1);

    seen = [];
    routes['POST /tool/*'] = () => ({ ...ok({ data: { fine: true } }), delayMs: 400 });
    const fine = await run(['tool', 'get_overview'], { home });
    expect([fine.code, JSON.parse(fine.out), fine.err]).toEqual([0, { fine: true }, ['(heartbeat) lease_expired: 이 임대는 1.5초 동안 heartbeat가 없어 끝났습니다 — 다시 claim하세요']]);
  });

  // 리드 결정 S10t: 예전에는 명령이 끝날 때 보내는 중인 heartbeat를 기다리지 않았다. 명령이 연결을 닫으면 끊긴 heartbeat가 새 연결로 hello부터 다시 보냈고(프로세스
  // 안에서 부르면 다음 명령 때 서버에 닿았다 — Linux 부하에서 'hello는 연결마다 한 번'과 '409' 시험이 다음 명령의 요청 목록에 낀 heartbeat로 가끔 실패), 그 실패는
  // 명령의 글에 붙지 않았다
  it('명령이 끝난 뒤에는 서버에 아무 요청도 닿지 않는다 — 보내는 중인 heartbeat는 그 답까지 기다리고, 그 실패도 명령의 글 뒤에 붙는다', async () => {
    const home = tempDir('hb-drain');
    seedState(home, { heartbeatMs: 50 });
    // 도구는 0.4초, heartbeat의 답은 1초 — 도구가 끝날 때 증명한 둘째 연결의 heartbeat가 답을 기다린다
    routes['POST /seat/heartbeat'] = () => ({ ...refuse(409, 'lease_expired', '이 임대는 끝났습니다 — 다시 claim하세요'), delayMs: 1000 });
    routes['POST /tool/*'] = () => ({ ...ok({ data: { fine: true } }), delayMs: 400 });
    const r = await run(['tool', 'get_overview'], { home, env: { WOOK_AGENT_PROOF: PROOF } });
    expect([r.code, JSON.parse(r.out), r.err]).toEqual([0, { fine: true }, ['(heartbeat) lease_expired: 이 임대는 끝났습니다 — 다시 claim하세요']]);
    const at = seen.length;
    await sleep(1500);
    expect(seen.slice(at).map((s) => s.path.replace(PREFIX, ''))).toEqual([]);
    expect(beats()).toHaveLength(1);
  });

  it('보내는 중인 heartbeat의 답이 2초 넘게 오지 않으면 기다리지 않고 끝낸다 — 연결을 닫은 뒤에는 그 heartbeat를 새 연결로 다시 보내지 않는다', async () => {
    const home = tempDir('hb-drain-cap');
    seedState(home, { heartbeatMs: 50 });
    routes['POST /seat/heartbeat'] = () => ({ ...ok({ state: 'active', generation: 2, leaseExpiresAt: 'x', queued: 0 }), delayMs: 4000 });
    routes['POST /tool/*'] = () => ({ ...ok({ data: { fine: true } }), delayMs: 200 });
    const r = await run(['tool', 'get_overview'], { home, env: { WOOK_AGENT_PROOF: PROOF } });
    expect([r.code, JSON.parse(r.out), r.err]).toEqual([0, { fine: true }, []]);
    // 답(4초)을 기다리지 않았다 — 도구 0.2초 + 기다림 상한 2초
    expect(r.ms).toBeLessThan(3800);
    const at = seen.length;
    await sleep(2500);
    expect(seen.slice(at).map((s) => s.path.replace(PREFIX, ''))).toEqual([]);
  }, 20_000);
});

describe('롱폴 둘 — 같은 임대의 두 work next --wait (리드 결정 S7-19 C5)', () => {
  it('기다림의 절반도 안 돼 돌아온 204는 1초 쉬고, 세 번 잇따르면 1로 그만둔다 — 횟수를 태우지 않는다', async () => {
    const home = tempDir('twopoll');
    seedState(home, { heartbeatMs: 60_000, turn: false, pollMaxMs: 2000 });
    // 열 번 넘게 물으면(그만두지 않으면) 409로 끝내 준다 — 시험이 시간 초과가 아니라 단언으로 실패하게
    let n = 0;
    routes['POST /work/next'] = () => (++n > 10 ? refuse(409, 'stopped', '긴급 정지 중입니다') : { status: 204 });
    const r = await run(['work', 'next', '--wait'], { home });
    expect([r.code, r.out, r.err]).toEqual([WOOK_EXIT.refused, '', [OTHER_POLLER]]);
    const polls = seen.filter((s) => s.path === `${PREFIX}/work/next`);
    expect(polls).toHaveLength(3);
    // 1초씩 쉬었다
    expect(polls[1]!.at - polls[0]!.at).toBeGreaterThanOrEqual(950);
    expect(polls[2]!.at - polls[1]!.at).toBeGreaterThanOrEqual(950);
    // state.json은 그대로
    expect(JSON.parse(readFileSync(statePath(home), 'utf8')).turn).toBeNull();
  }, 20_000);

  it('제때 돌아온 204는 그 셈을 처음으로 돌린다 — 일찍·일찍·제때·일찍·일찍 뒤에 일이 오면 받는다', async () => {
    const home = tempDir('twopoll2');
    seedState(home, { heartbeatMs: 60_000, turn: false, pollMaxMs: 1000 });
    const plan = ['early', 'early', 'full', 'early', 'early', 'work'];
    let i = 0;
    routes['POST /work/next'] = () => {
      const step = plan[i++];
      if (step === 'early') return { status: 204 };
      if (step === 'full') return { status: 204, delayMs: 900 };
      return ok(WORK());
    };
    const r = await run(['work', 'next', '--wait'], { home });
    expect([r.code, i]).toEqual([0, 6]);
    expect(JSON.parse(r.out).turnId).toBe('TN-0012');
  }, 20_000);
});

describe('요청 상한 — 전체 시간과 답 크기 (리드 결정 S7-19 C4)', () => {
  it('머리 뒤에 조금씩 흘려 보내는 답은 쉬는 시간 상한으로는 끝나지 않는다 — 전체 상한에 5로 끝난다', async () => {
    const home = tempDir('trickle');
    routes['GET /seat'] = () => ({ status: 200, trickleMs: 150, trickleForMs: 6000 });
    const r = await run(['seat', 'status'], { home, io: { requestTimeoutMs: 1500 } });
    expect([r.code, r.err[0]]).toEqual([WOOK_EXIT.unreachable, `욱채 서버의 에이전트 API(${api})에 닿지 못했습니다 (2초 안에 답이 끝나지 않음) — 서버가 떠 있는지, 다시 시작해 주소가 바뀌지 않았는지 보세요`]);
    expect(r.ms).toBeLessThan(4000);
    server.closeAllConnections();
  }, 20_000);

  it('8MB를 넘는 답은 5 (에이전트 API의 답이 아님) — 화면 PNG는 64MB까지 받는다', async () => {
    const home = tempDir('big');
    routes['GET /seat'] = () => ({ status: 200, raw: Buffer.alloc(REPLY_MAX_BYTES + 1024, 0x20) });
    const big = await run(['seat', 'status'], { home });
    expect([big.code, big.err[0]]).toEqual([WOOK_EXIT.unreachable, expect.stringMatching(/^그 주소에서 답한 쪽이 욱채 에이전트 API가 아닙니다 \(답이 8MB를 넘음\) — 키를 그 프로그램에 보냈을 수 있습니다/)]);
    routes['GET /seat'] = () => ({ status: 200, raw: Buffer.from('{}'), headers: { 'Content-Length': String(REPLY_MAX_BYTES + 1) } });
    expect((await run(['seat', 'status'], { home })).code).toBe(WOOK_EXIT.unreachable);
    // 길이를 말하지 않고 조각으로 보내도 읽는 동안 끊는다
    routes['GET /seat'] = () => ({ status: 200, raw: Buffer.alloc(REPLY_MAX_BYTES + 1024, 0x20), chunked: true });
    const chunked = await run(['seat', 'status'], { home });
    expect([chunked.code, chunked.err[0]]).toEqual([WOOK_EXIT.unreachable, expect.stringMatching(/^그 주소에서 답한 쪽이 욱채 에이전트 API가 아닙니다 \(답이 8MB를 넘음\) — /)]);
    server.closeAllConnections();
    // 9MB PNG는 받는다
    seedState(home, { heartbeatMs: 60_000 });
    routes['POST /tool/*'] = () => ok({ data: { capture_id: 'SC-000043', width: 4000, height: 3000 } });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(9 * 1024 * 1024)]);
    routes['GET /screens/SC-*'] = () => ({ status: 200, raw: png, type: 'image/png' });
    const cap = await run(['screen', 'capture', '--out', join(home, 'big.png')], { home });
    expect([cap.code, statSync(join(home, 'big.png')).size]).toEqual([0, png.length]);
  }, 30_000);
});

describe('work done — 마지막 답 파일, 30초 넘는 요청 상한 (리드 결정 S7-16 6)', () => {
  it('finish가 10초 넘게 걸려도 기다려 끝 까닭을 내고, 받은 턴을 state.json에서 지운다', async () => {
    expect(DONE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    const home = tempDir('done');
    seedState(home);
    const answer = join(home, 'answer.md');
    writeFileSync(answer, '\uFEFF오늘 할 일:\n- 하나', 'utf8');
    routes['POST /work/TN-*/finish'] = () => ({ ...ok({ endReason: 'completed' }), delayMs: 10_500 });
    const r = await run(['work', 'done', 'TN-0007', '--file', answer], { home });
    expect([r.code, r.out, r.err]).toEqual([0, '턴을 마쳤습니다: TN-0007 (끝 까닭 completed)\n', []]);
    expect(seen.map((s) => [s.path.replace(PREFIX, ''), s.body['leaseId'] === LEASE, s.body['finalText'], s.body['outcome']])).toEqual([['/work/TN-0007/finish', true, '오늘 할 일:\n- 하나', 'completed']]);
    expect(JSON.parse(readFileSync(statePath(home), 'utf8')).turn).toBeNull();
    // 파일이 없으면 2 (서버에 붙지 않는다)
    seen = [];
    expect((await run(['work', 'done', 'TN-0007', '--file', join(home, 'none.md'), '--outcome', 'failed'], { home })).code).toBe(WOOK_EXIT.usage);
    expect(seen).toHaveLength(0);
  }, 40_000);

  it('UTF-8이 아닌 답 파일(cp949·UTF-16 LE/BE·깨진 UTF-8)은 2이고 아무것도 보내지 않는다 — 저장하는 법을 말한다. 빈 답은 --outcome failed일 때만 (S7-19 C2)', async () => {
    const home = tempDir('enc');
    seedState(home);
    routes['POST /work/TN-*/finish'] = () => ok({ endReason: 'completed' });
    const hint = 'UTF-8로 저장하세요 (PowerShell 5.1: Set-Content -Encoding utf8 — 그 셸의 > 와 Out-File은 UTF-16으로 씁니다, Python: open(…, "w", encoding="utf-8")). 아무것도 보내지 않았습니다';
    const cases: [string, Buffer, string][] = [
      ['cp949', Buffer.from('bec8b3e7c7cfbcbcbfe4', 'hex'), `마지막 답 파일(--file)이 UTF-8이 아닙니다 — ${hint}`],
      ['utf16le', Buffer.from('\uFEFF답을 정리했습니다', 'utf16le'), `마지막 답 파일(--file)이 UTF-16입니다 — ${hint}`],
      ['utf16be', Buffer.from(Buffer.from('\uFEFF답', 'utf16le').swap16()), `마지막 답 파일(--file)이 UTF-16입니다 — ${hint}`],
      ['broken', Buffer.concat([Buffer.from('앞은 맞고 ', 'utf8'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from(' 뒤', 'utf8')]), `마지막 답 파일(--file)이 UTF-8이 아닙니다 — ${hint}`],
      ['empty', Buffer.alloc(0), '마지막 답 파일(--file)이 비었습니다 — 답을 쓰거나, 해내지 못한 턴이면 --outcome failed를 붙이세요. 아무것도 보내지 않았습니다'],
      // BOM 없는 UTF-16(ASCII만 든) — UTF-8로도 읽히지만 글자마다 NUL이 낀다. NUL만 든 파일도 답이 아니다 (S7-22 K2)
      ['utf16le-nobom', Buffer.from('Done: summary of today', 'utf16le'), `마지막 답 파일(--file)에 NUL 글자(U+0000)가 있습니다 — BOM 없는 UTF-16일 수 있습니다. ${hint}`],
      ['utf16be-nobom', Buffer.from(Buffer.from('Done', 'utf16le')).swap16(), `마지막 답 파일(--file)에 NUL 글자(U+0000)가 있습니다 — BOM 없는 UTF-16일 수 있습니다. ${hint}`],
      ['nul-only', Buffer.alloc(8, 0), `마지막 답 파일(--file)에 NUL 글자(U+0000)가 있습니다 — BOM 없는 UTF-16일 수 있습니다. ${hint}`],
      ['blank', Buffer.from('\uFEFF \r\n\t\n', 'utf8'), '마지막 답 파일(--file)이 비었습니다 — 답을 쓰거나, 해내지 못한 턴이면 --outcome failed를 붙이세요. 아무것도 보내지 않았습니다'],
    ];
    for (const [what, bytes, sentence] of cases) {
      const f = join(home, `${what}.md`);
      writeFileSync(f, bytes);
      const r = await run(['work', 'done', 'TN-0007', '--file', f], { home });
      expect([what, r.code, r.err]).toEqual([what, WOOK_EXIT.usage, [sentence]]);
    }
    expect(seen).toHaveLength(0);
    // 빈 답 + --outcome failed는 보낸다 (해내지 못한 턴)
    const empty = join(home, 'empty.md');
    const failed = await run(['work', 'done', 'TN-0007', '--file', empty, '--outcome', 'failed'], { home });
    expect([failed.code, seen.map((s) => [s.body['finalText'], s.body['outcome']])]).toEqual([0, [['', 'failed']]]);
    // CRLF·BOM 하나는 그대로 (BOM만 뺀다)
    seedState(home);
    seen = [];
    const crlf = join(home, 'crlf.md');
    writeFileSync(crlf, '\uFEFF첫 줄\r\n둘째 줄\r\n', 'utf8');
    expect((await run(['work', 'done', 'TN-0007', '--file', crlf], { home })).code).toBe(0);
    expect(seen.map((s) => s.body['finalText'])).toEqual(['첫 줄\r\n둘째 줄\r\n']);
  });
});

describe('도구 인자 파일 --json-file (리드 결정 S7-19 C7)', () => {
  it('UTF-8 JSON 객체 파일을 그대로 인자로 — UTF-8이 아니거나·JSON이 아니거나·객체가 아니면 2이고 보내지 않는다', async () => {
    const home = tempDir('jsonfile');
    seedState(home, { heartbeatMs: 60_000 });
    routes['POST /tool/*'] = () => ok({ data: { done: true } });
    const f = join(home, 'args.json');
    writeFileSync(f, `\uFEFF${JSON.stringify({ to: 'launched:codex', reason: '대표 명령', note: '넘깁니다 "따옴표"' })}`, 'utf8');
    const r = await run(['tool', 'hand_off_seat', '--json-file', f], { home });
    expect([r.code, JSON.parse(r.out)]).toEqual([0, { done: true }]);
    expect(seen.map((s) => [s.path.replace(PREFIX, ''), s.body, s.token === TOKEN])).toEqual([['/tool/hand_off_seat', { to: 'launched:codex', reason: '대표 명령', note: '넘깁니다 "따옴표"' }, true]]);
    seen = [];
    const cases: [string, Buffer, string][] = [
      ['cp949', Buffer.concat([Buffer.from('{"note":"'), Buffer.from('bec8b3e7', 'hex'), Buffer.from('"}')]), '도구 인자 파일(--json-file)이 UTF-8이 아닙니다 — '],
      ['utf16', Buffer.from('\uFEFF{}', 'utf16le'), '도구 인자 파일(--json-file)이 UTF-16입니다 — '],
      ['notjson', Buffer.from('{to:launched:codex}'), '도구 인자 파일(--json-file)의 글을 JSON으로 읽을 수 없습니다 — 예: {"project_id": "general"} (내용은 보이지 않습니다)'],
      ['array', Buffer.from('["SECRETX"]'), '도구 인자 파일(--json-file)의 JSON은 객체여야 합니다 — 예: {"project_id": "general"} (내용은 보이지 않습니다)'],
      ['empty', Buffer.alloc(0), '도구 인자 파일(--json-file)의 글을 JSON으로 읽을 수 없습니다 — 예: {"project_id": "general"} (내용은 보이지 않습니다)'],
      ['utf16-nobom', Buffer.from('{}', 'utf16le'), '도구 인자 파일(--json-file)에 NUL 글자(U+0000)가 있습니다 — BOM 없는 UTF-16일 수 있습니다. '],
    ];
    for (const [what, bytes, start] of cases) {
      const g = join(home, `${what}.json`);
      writeFileSync(g, bytes);
      const bad = await run(['tool', 'get_overview', '--json-file', g], { home });
      expect([what, bad.code, bad.err[0]!.startsWith(start), bad.err.join('\n').includes('SECRETX')]).toEqual([what, WOOK_EXIT.usage, true, false]);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('state.json — 지금 사용자만 읽고, 출력에는 임대·토큰이 없다', () => {
  it('claim이 그 사용자만 읽는 state.json에 임대를 두고, release가 지운다', async () => {
    const home = tempDir('state');
    routes['POST /seat/claim'] = () =>
      ok({ agentId: 'X-0001', label: '그록봇', generation: 2, leaseId: LEASE, leaseMs: 60_000, heartbeatMs: 15_000, pollMaxMs: 25_000, mcpUrl: 'http://127.0.0.1:9/mcp', rules: '규칙', skills: [], handover: null });
    const r = await run(['seat', 'claim'], { home });
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        '메인 자리를 잡았습니다: 그록봇(X-0001), 세대 2',
        '  임대 60초 — 15초마다 wook seat heartbeat를 보내세요. 임대를 싣는 요청(heartbeat·work next·progress·done)만 임대를 늘립니다',
        '  일 받기: wook work next --wait (한 번에 25초까지 기다리고 되풀이합니다)',
        '  인계 꾸러미: 없음',
        `  임대는 ${statePath(home)}에 두었습니다 (지금 사용자만 읽는 파일)`,
        '',
      ].join('\n'),
    );
    const f = statePath(home);
    expect(JSON.parse(readFileSync(f, 'utf8')).leaseId === LEASE).toBe(true);
    if (win) {
      const out = join(home, 'acl.txt');
      execFileSync(sys32('icacls.exe'), [f, '/save', out], { stdio: 'ignore', windowsHide: true });
      const sddl = readFileSync(out).toString('utf16le');
      // 상속을 끊고(D:P) 지금 사용자만
      expect([/D:P/.test(sddl), sddlOpenToOthers(sddl, me())]).toEqual([true, false]);
    } else {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    routes['POST /seat/release'] = () => ok();
    const rel = await run(['seat', 'release', '--note', '쉬러 갑니다'], { home });
    expect([rel.code, existsSync(f)]).toEqual([0, false]);
    expect(seen.at(-1)?.body).toEqual({ leaseId: LEASE, note: '쉬러 갑니다' });
  });

  it.skipIf(!win)('권한을 좁히지 못하면 claim은 "지금 사용자만 읽는 파일"이라고 말하지 않는다 — 경고와 함께 (S7-19 C6)', async () => {
    const home = tempDir('state-open');
    mkdirSync(join(home, '.wook'));
    routes['POST /seat/claim'] = () =>
      ok({ agentId: 'X-0001', label: '그록봇', generation: 2, leaseId: LEASE, leaseMs: 60_000, heartbeatMs: 15_000, pollMaxMs: 25_000, mcpUrl: 'http://127.0.0.1:9/mcp', rules: '규칙', skills: [], handover: null });
    const r = await run(['seat', 'claim'], {
      home,
      io: {
        restrictFile: () => {
          throw new Error('icacls 실패');
        },
      },
    });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[4]).toBe(`  임대는 ${statePath(home)}에 두었습니다 (권한을 좁히지 못해 그 폴더의 권한을 따릅니다 — 위 경고를 보세요)`);
    expect(r.err).toEqual([`경고: ${statePath(home)}의 권한을 지금 사용자만으로 좁히지 못했습니다 (그 폴더의 권한을 따릅니다)`]);
  });

  it('work done은 마치는 사이 다른 wook이 잡은 새 임대를 지우지 않는다 — 다시 읽고, 읽은 임대·턴이 그대로일 때만 턴을 지운다 (S7-19 C6)', async () => {
    const home = tempDir('lost');
    seedState(home);
    const answer = join(home, 'a.md');
    writeFileSync(answer, '답');
    const NEW = randomBytes(24).toString('base64url');
    routes['POST /work/TN-*/finish'] = async () => {
      // 마치는 사이 다른 wook이 다시 claim했다
      seedState(home, { leaseId: NEW, turn: false });
      return ok({ endReason: 'completed' });
    };
    const r = await run(['work', 'done', 'TN-0007', '--file', answer], { home });
    expect([r.code, r.out]).toEqual([0, '턴을 마쳤습니다: TN-0007 (끝 까닭 completed)\n']);
    const st = JSON.parse(readFileSync(statePath(home), 'utf8')) as { leaseId: string };
    expect(st.leaseId === NEW).toBe(true);
  });

  it('work next는 기다리는 사이 state.json의 임대가 바뀌었으면 받은 일을 두지 않고 1 — 새 임대는 그대로 (S7-19 C6)', async () => {
    const home = tempDir('lost-next');
    seedState(home, { turn: false, heartbeatMs: 60_000 });
    const NEW = randomBytes(24).toString('base64url');
    routes['POST /work/next'] = () => {
      seedState(home, { leaseId: NEW, turn: false });
      return ok(WORK());
    };
    const r = await run(['work', 'next'], { home });
    expect([r.code, r.out, r.err]).toEqual([
      WOOK_EXIT.refused,
      '',
      ['받은 일(TN-0012)을 state.json에 두지 않았습니다 — 기다리는 사이 다른 wook이 state.json의 임대나 턴을 바꿨습니다 (한 계정의 ~/.wook는 에이전트 하나가 씁니다). wook seat status로 본 뒤 다시 하세요'],
    ]);
    const st = JSON.parse(readFileSync(statePath(home), 'utf8')) as { leaseId: string; turn: unknown };
    expect([st.leaseId === NEW, st.turn]).toEqual([true, null]);
    // 다른 wook이 같은 일을 이미 두었으면(같은 임대·같은 턴) 그대로 받는다
    seedState(home, { turn: false, heartbeatMs: 60_000 });
    routes['POST /work/next'] = () => ok(WORK());
    expect((await run(['work', 'next'], { home })).code).toBe(0);
    expect((await run(['work', 'next'], { home })).code).toBe(0);
  });

  it('끊긴 쓰기가 남긴 state.json.tmp-*는 시작할 때 지운다 — 1분 안의 것(다른 wook이 막 쓰는 것)은 둔다 (S7-19 C6)', async () => {
    const home = tempDir('tmp');
    seedState(home, { turn: false });
    const old = join(home, '.wook', 'state.json.tmp-0a0b0c0d');
    const fresh = join(home, '.wook', 'state.json.tmp-01020304');
    writeFileSync(old, JSON.stringify({ leaseId: LEASE, token: TOKEN }));
    writeFileSync(fresh, '{}');
    const past = new Date(Date.now() - 5 * 60_000);
    utimesSync(old, past, past);
    routes['GET /seat'] = SEAT_OK;
    expect((await run(['seat', 'status'], { home })).code).toBe(0);
    expect(readdirSync(join(home, '.wook')).sort()).toEqual(['state.json', 'state.json.tmp-01020304']);
  });
});
