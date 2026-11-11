/**
 * 에이전트 API의 HTTP 층 (리드 결정 S7-2·S7-3): 인증(머리·Bearer·키·쿼리의 키·토큰) — 401이면 처리기를 부르지 않는다, 틀린 키와 폐기된 키는 같은 글,
 * 401 기록은 창마다 한 줄, 인증 없는 요청·키마다의 횟수 상한(429·Retry-After), 본문 상한(1MB·도구 4MB → 413), 코드 → HTTP 상태, 화면 길의 403 seat_changed.
 * 백엔드는 가짜(부른 횟수를 센다) — 도메인 동작은 tests/server/external*.test.ts가 본다
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BackendError, type AgentBackend } from '../main/backend/types';
import type { UnauthenticatedBudget } from '../main/mcp/types';
import { AGENT_API_ROUTES, AGENT_KEY_REFUSAL, AGENT_UNAUTHENTICATED_ROUTES, createAgentApi, type AgentApi, type AgentApiLimits } from './agentApi';

const GOOD = `wsk_${'A'.repeat(43)}`;
const TOKEN = `wtt_${'B'.repeat(43)}`;
/** 이 시험의 확인값 (S7-19 C3) — 답·기록 어디에도 나오면 안 된다 */
const PROOF = randomBytes(32).toString('base64url');
const macOf = (nonce: Buffer, proof = PROOF): string => createHmac('sha256', Buffer.from(proof, 'base64url')).update(nonce).digest('base64url');

interface Rig {
  api: AgentApi;
  server: Server;
  port: number;
  calls: string[];
  lines: string[];
  behave: Partial<Record<keyof AgentBackend, (...args: unknown[]) => unknown>>;
}

const rigs: Rig[] = [];

async function rig(limits: Partial<AgentApiLimits> = {}, budget?: UnauthenticatedBudget): Promise<Rig> {
  const calls: string[] = [];
  const lines: string[] = [];
  const behave: Rig['behave'] = {};
  const call = (name: keyof AgentBackend, dflt: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
    calls.push(name);
    return (behave[name] ?? dflt)(...a);
  };
  const agents: AgentBackend = {
    baseUrl: () => null,
    mcpUrl: () => null,
    mount: () => undefined,
    authenticate: (key) => {
      calls.push('authenticate');
      return key === GOOD ? { id: 'X-0001', label: '봇' } : null;
    },
    claim: call('claim', () => ({ agentId: 'X-0001' })) as AgentBackend['claim'],
    heartbeat: call('heartbeat', () => ({ state: 'active', generation: 1, leaseExpiresAt: 'x', queued: 0 })) as AgentBackend['heartbeat'],
    release: call('release', () => undefined) as AgentBackend['release'],
    seat: call('seat', () => ({ assigned: true })) as AgentBackend['seat'],
    next: call('next', async () => null) as AgentBackend['next'],
    progress: call('progress', () => undefined) as AgentBackend['progress'],
    finish: call('finish', async () => ({ endReason: 'completed' })) as AgentBackend['finish'],
    tool: call('tool', async () => ({ ok: true, data: { fine: true } })) as AgentBackend['tool'],
    screen: call('screen', () => Buffer.from('png')) as AgentBackend['screen'],
    stop: call('stop', async () => ({ at: 'x', completed: true, stoppedTurns: [], heldTasks: [], failures: [] })) as AgentBackend['stop'],
  };
  const logger = { info: (m: string) => lines.push(`I ${m}`), warn: (m: string) => lines.push(`W ${m}`), error: (m: string) => lines.push(`E ${m}`) };
  const api = createAgentApi({ agents, logger, limits, proof: PROOF });
  const server = createServer((req, res) => void api.handle(req, res, budget));
  await new Promise<void>((r) => server.listen({ host: '127.0.0.1', port: 0 }, () => r()));
  const r: Rig = { api, server, port: (server.address() as AddressInfo).port, calls, lines, behave };
  rigs.push(r);
  return r;
}

afterEach(() => undefined);
afterAll(async () => {
  for (const r of rigs) await new Promise<void>((done) => r.server.close(() => done()));
});

function send(r: Rig, path: string, o: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? null : Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, 'utf8');
    const req = request(
      { host: '127.0.0.1', port: r.port, path: `/agent/v1${path}`, method: o.method ?? (data ? 'POST' : 'GET'), agent: false, headers: { ...(data ? { 'Content-Length': String(data.length) } : {}), ...o.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
const auth = { Authorization: `Bearer ${GOOD}` };
const code = (t: string): string | undefined => (t ? (JSON.parse(t) as { error?: { code: string } }).error?.code : undefined);
const msg = (t: string): string | undefined => (JSON.parse(t) as { error?: { message: string } }).error?.message;
const handlerCalls = (r: Rig): string[] => r.calls.filter((c) => c !== 'authenticate');

let shared: Rig;
beforeAll(async () => {
  shared = await rig();
});

describe('agentApi — 401은 처리기를 부르지 않는다 (AC-32, S7-3)', () => {
  it('머리 없음·Bearer 아님·모르는 키·폐기된 키(같은 글)·쿼리의 키나 토큰은 401이고 처리기가 돌지 않는다', async () => {
    const r = await rig();
    const cases: [string, Record<string, string>, string][] = [
      ['/seat/claim', {}, 'Authorization: Bearer <에이전트 키> 머리가 없습니다'],
      ['/seat/claim', { Authorization: `Basic ${GOOD}` }, 'Authorization 머리가 "Bearer <에이전트 키>" 꼴이 아닙니다'],
      ['/seat/claim', { Authorization: `Bearer wsk_${'Z'.repeat(43)}` }, AGENT_KEY_REFUSAL],
      ['/seat/claim', { Authorization: 'Bearer revoked-or-wrong' }, AGENT_KEY_REFUSAL],
      [`/seat/claim?key=${GOOD}`, auth, '에이전트 키나 턴 토큰은 주소(쿼리)에 넣지 않습니다 — Authorization 머리와 X-Wook-Turn-Token 머리로 보내세요'],
      [`/seat?x=${TOKEN}`, auth, '에이전트 키나 턴 토큰은 주소(쿼리)에 넣지 않습니다 — Authorization 머리와 X-Wook-Turn-Token 머리로 보내세요'],
      ['/seat?token=abc', auth, '에이전트 키나 턴 토큰은 주소(쿼리)에 넣지 않습니다 — Authorization 머리와 X-Wook-Turn-Token 머리로 보내세요'],
      ['/no/such/route', {}, 'Authorization: Bearer <에이전트 키> 머리가 없습니다'],
    ];
    for (const [path, headers, sentence] of cases) {
      const res = await send(r, path, { headers, ...(path.startsWith('/seat/claim') ? { body: '{}' } : {}) });
      expect([path, res.status, code(res.text), msg(res.text)]).toEqual([path, 401, 'unauthorized', sentence]);
      expect(String(res.headers['www-authenticate'])).toContain('Bearer');
    }
    expect(handlerCalls(r)).toEqual([]);
    // 쿼리 거부는 키를 보기도 전이다 — 맞는 키도 확인하지 않았다
    expect(r.calls.filter((c) => c === 'authenticate')).toHaveLength(2);
  });

  it('401 기록은 창마다 한 줄로 모인다 — 요청마다 쓰지 않고, 창이 끝나면 더 온 수를 한 줄로', async () => {
    const r = await rig({ windowMs: 300, unauthenticated: 1000 });
    for (let i = 0; i < 25; i++) await send(r, '/seat', { headers: { Authorization: 'Bearer nope' } });
    expect(r.lines.filter((l) => l.includes('인증하지 못한'))).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 450));
    const all = r.lines.filter((l) => l.includes('인증하지 못한'));
    expect(all).toHaveLength(2);
    expect(all[1]).toContain('24번 더');
    // 기록에 키·쿼리 값이 없다
    expect(r.lines.join('\n')).not.toContain('nope');
  });
});

describe('agentApi — 횟수 상한 (S7-3)', () => {
  it('인증하지 못한 요청은 모두 합쳐 상한까지 401, 넘으면 429와 Retry-After — 처리기는 돌지 않는다', async () => {
    const r = await rig({ unauthenticated: 3 });
    const got: number[] = [];
    for (let i = 0; i < 5; i++) got.push((await send(r, '/seat', { headers: { Authorization: 'Bearer nope' } })).status);
    expect(got).toEqual([401, 401, 401, 429, 429]);
    const last = await send(r, '/seat');
    expect([last.status, code(last.text), Number(last.headers['retry-after']) > 0]).toEqual([429, 'rate_limited', true]);
    // 맞는 키의 요청은 그 상한에 걸리지 않는다
    expect((await send(r, '/seat', { headers: auth })).status).toBe(200);
    expect(handlerCalls(r)).toEqual(['seat']);
  });

  it('키마다 상한을 넘으면 429와 Retry-After — 넘은 요청은 처리기를 부르지 않는다', async () => {
    const r = await rig({ perKey: 3 });
    const got: number[] = [];
    for (let i = 0; i < 5; i++) got.push((await send(r, '/seat', { headers: auth })).status);
    expect(got).toEqual([200, 200, 200, 429, 429]);
    expect(handlerCalls(r)).toEqual(['seat', 'seat', 'seat']);
    const res = await send(r, '/seat', { headers: auth });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('agentApi — 본문과 길 (S7-2)', () => {
  it('본문은 1MB까지 (도구 인자는 4MB까지) — 넘으면 413, 처리기는 돌지 않는다', async () => {
    const r = await rig();
    const big = `{"label":"${'x'.repeat(1024 * 1024)}"}`;
    const over = await send(r, '/seat/claim', { headers: auth, body: big });
    expect([over.status, code(over.text)]).toEqual([413, 'too_large']);
    const toolOk = await send(r, '/tool/get_overview', { headers: { ...auth, 'X-Wook-Turn-Token': TOKEN }, body: `{"x":"${'y'.repeat(2 * 1024 * 1024)}"}` });
    expect(toolOk.status).toBe(200);
    const toolOver = await send(r, '/tool/get_overview', { headers: { ...auth, 'X-Wook-Turn-Token': TOKEN }, body: `{"x":"${'y'.repeat(4 * 1024 * 1024)}"}` });
    expect([toolOver.status, code(toolOver.text)]).toEqual([413, 'too_large']);
    expect(handlerCalls(r)).toEqual(['tool']);
  });

  it('JSON이 아니거나 객체가 아니면 400, 모르는 길·메서드는 인증 뒤 404, 글 상한·outcome은 400', async () => {
    const r = await rig();
    expect(code((await send(r, '/seat/heartbeat', { headers: auth, body: '{나쁜' })).text)).toBe('invalid');
    expect(code((await send(r, '/seat/heartbeat', { headers: auth, body: '[1]' })).text)).toBe('invalid');
    const nf = await send(r, '/seat/unknown', { headers: auth, body: '{}' });
    expect([nf.status, code(nf.text)]).toEqual([404, 'not_found']);
    expect((await send(r, '/seat/claim', { headers: auth })).status).toBe(404); // GET은 없다
    const long = await send(r, '/work/TN-000001/progress', { headers: auth, body: JSON.stringify({ leaseId: 'l', text: 'x'.repeat(4001) }) });
    expect([long.status, msg(long.text)]).toEqual([400, 'text은(는) 4,000자까지입니다 (4,001자)']);
    const outcome = await send(r, '/work/TN-000001/finish', { headers: auth, body: JSON.stringify({ leaseId: 'l', finalText: '끝', outcome: 'maybe' }) });
    expect(outcome.status).toBe(400);
    const tooLongFinal = await send(r, '/work/TN-000001/finish', { headers: auth, body: JSON.stringify({ leaseId: 'l', finalText: 'x'.repeat(20001), outcome: 'completed' }) });
    expect(tooLongFinal.status).toBe(400);
    expect(handlerCalls(r)).toEqual([]);
  });

  it('도메인의 거부 코드는 그 HTTP 상태로, 일이 없으면 204, 화면 길의 seat_changed는 403, 턴 토큰이 없으면 401', async () => {
    const r = shared;
    r.behave.heartbeat = () => {
      throw new BackendError('seat_changed', '메인 자리가 바뀌었습니다 (이 임대는 세대 1, 지금은 세대 2 — Codex CLI)');
    };
    const hb = await send(r, '/seat/heartbeat', { headers: auth, body: '{"leaseId":"l"}' });
    expect([hb.status, code(hb.text), msg(hb.text)]).toEqual([409, 'seat_changed', '메인 자리가 바뀌었습니다 (이 임대는 세대 1, 지금은 세대 2 — Codex CLI)']);
    const nx = await send(r, '/work/next', { headers: auth, body: '{"leaseId":"l","waitMs":10}' });
    expect([nx.status, nx.text]).toEqual([204, '']);
    r.behave.screen = () => {
      throw new BackendError('seat_changed', '이 캡처는 다른 세대의 것');
    };
    const sc = await send(r, '/screens/SC-000001', { headers: { ...auth, 'X-Wook-Turn-Token': TOKEN } });
    expect([sc.status, code(sc.text)]).toEqual([403, 'seat_changed']);
    const noTok = await send(r, '/screens/SC-000001', { headers: auth });
    expect([noTok.status, code(noTok.text)]).toEqual([401, 'unauthorized']);
    r.behave.claim = () => {
      throw new Error('예상 밖');
    };
    const boom = await send(r, '/seat/claim', { headers: auth, body: '{}' });
    expect([boom.status, code(boom.text)]).toEqual([500, 'internal']);
    r.behave.screen = () => Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const png = await send(r, '/screens/SC-000001', { headers: { ...auth, 'X-Wook-Turn-Token': TOKEN } });
    expect([png.status, png.headers['content-type'], png.headers['cache-control']]).toEqual([200, 'image/png', 'no-store']);
  });
});

describe('agentApi — 서버 확인 POST hello (리드 결정 S7-19 C3)', () => {
  const hello = (r: Rig, body: string | Buffer, headers: Record<string, string> = {}) => send(r, '/hello', { headers: { 'Content-Type': 'application/json', ...headers }, body });

  it('nonce(16~64바이트)마다 mac = base64url(HMAC-SHA256(proof, nonce)) — 어떤 nonce에도 같은 꼴 {ok, mac}이고, proof·실행 ID는 내지 않는다', async () => {
    const r = await rig();
    for (const n of [16, 17, 32, 63, 64]) {
      const nonce = randomBytes(n);
      const res = await hello(r, JSON.stringify({ nonce: nonce.toString('base64url') }));
      const j = JSON.parse(res.text) as Record<string, unknown>;
      expect([n, res.status, Object.keys(j), j['ok'], j['mac'] === macOf(nonce), res.headers['cache-control']]).toEqual([n, 200, ['ok', 'mac'], true, true, 'no-store']);
      expect(res.text.includes(PROOF)).toBe(false);
      // 다른 확인값이면 다른 mac — 답이 proof에 매여 있다
      expect(j['mac'] === macOf(nonce, randomBytes(32).toString('base64url'))).toBe(false);
    }
    // 키 머리가 있어도(맞는 키여도) 보지 않는다 — 키 확인(마지막 접속)도 처리기도 없다
    const nonce = randomBytes(32);
    const withKey = await hello(r, JSON.stringify({ nonce: nonce.toString('base64url') }), { ...auth, 'X-Wook-Turn-Token': TOKEN });
    expect([withKey.status, (JSON.parse(withKey.text) as { mac: string }).mac === macOf(nonce)]).toEqual([200, true]);
    expect(r.calls).toEqual([]);
    // 기록도 남기지 않는다 (확인값은 어떤 줄에도 없다)
    expect(r.lines).toEqual([]);
  });

  it('꼴이 틀린 본문은 400 (16바이트 미만·64바이트 초과·base64url이 아님·= 붙임·nonce 없음·JSON 아님), 1KB 넘는 본문은 413 — 처리기·키 확인 없음', async () => {
    const r = await rig();
    const bad = [
      JSON.stringify({ nonce: randomBytes(15).toString('base64url') }),
      JSON.stringify({ nonce: randomBytes(65).toString('base64url') }),
      JSON.stringify({ nonce: randomBytes(32).toString('base64') + '+/' }),
      JSON.stringify({ nonce: `${randomBytes(16).toString('base64url')}==` }),
      JSON.stringify({ nonce: 'Ab+' }),
      JSON.stringify({ nonce: 12345678901234567890 }),
      JSON.stringify({}),
      JSON.stringify([randomBytes(32).toString('base64url')]),
      '{나쁜',
      '',
    ];
    for (const body of bad) {
      const res = await hello(r, body);
      expect([body.slice(0, 20), res.status, code(res.text)]).toEqual([body.slice(0, 20), 400, 'invalid']);
      expect(res.text.includes('mac')).toBe(false);
    }
    // 1KB 경계: 1,024바이트 본문은 읽어 답하고(200), 1,025바이트는 413
    const pad = (n: number): string => {
      const base = JSON.stringify({ nonce: randomBytes(32).toString('base64url'), pad: '' });
      return JSON.stringify({ nonce: JSON.parse(base).nonce, pad: 'x'.repeat(n - base.length) });
    };
    expect([pad(1024).length, (await hello(r, pad(1024))).status]).toEqual([1024, 200]);
    const huge = await hello(r, pad(1025));
    expect([huge.status, code(huge.text)]).toEqual([413, 'too_large']);
    // GET hello는 없는 길 — 인증 없는 401 (몫으로 센다)
    const get = await send(r, '/hello');
    expect([get.status, code(get.text)]).toEqual([401, 'unauthorized']);
    expect(r.calls).toEqual([]);
  });

  it('인증 없는 요청의 몫으로 세지 않고 몫이 다 써져도 답한다 — 제 횟수 상한도 없다 (리드 후속 11-11). 몫은 401·429에만 쓰이고, 맞는 키도 그대로 된다', async () => {
    let hits = 0;
    const budget: UnauthenticatedBudget = { hit: () => (++hits > 3 ? 42 : null) };
    const r = await rig({}, budget);
    // 쓰레기 요청이 몫을 다 쓴다
    const junk: number[] = [];
    for (let i = 0; i < 5; i++) junk.push((await send(r, '/seat', { headers: { Authorization: 'Bearer nope' } })).status);
    expect(junk).toEqual([401, 401, 401, 429, 429]);
    const spent = hits;
    // 그 뒤에도 hello는 200과 맞는 mac — 몫을 세지 않는다 (꼴이 틀린 hello도)
    for (let i = 0; i < 500; i++) {
      const nonce = randomBytes(32);
      const res = await hello(r, JSON.stringify({ nonce: nonce.toString('base64url') }));
      if (res.status !== 200 || (JSON.parse(res.text) as { mac: string }).mac !== macOf(nonce)) expect([i, res.status, res.text]).toEqual([i, 200, 'mac']);
    }
    expect((await hello(r, '{}')).status).toBe(400);
    expect(hits).toBe(spent);
    // 맞는 키의 요청도 그대로 (몫으로 세지 않는다)
    expect((await send(r, '/seat', { headers: auth })).status).toBe(200);
    expect(hits).toBe(spent);
    expect(handlerCalls(r)).toEqual(['seat']);
    // 500번의 hello는 기록 한 줄도 남기지 않았다 (위 401·429의 모은 줄만)
    expect(r.lines.every((l) => l.includes('인증하지 못한') || l.includes('횟수 상한'))).toBe(true);
  }, 60_000);

  it('길 목록: 인증 없는 길은 POST hello 하나다', () => {
    expect(AGENT_UNAUTHENTICATED_ROUTES).toEqual(['POST hello']);
    expect(AGENT_API_ROUTES).toContain('POST hello');
    expect(AGENT_API_ROUTES).toHaveLength(11);
  });
});
