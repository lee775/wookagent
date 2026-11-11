/**
 * 루프백 리스너(앱 도구 서버 — `/mcp`와 `/agent/v1`)의 인증 없는 요청 (SERVER_DESIGN 4.5, 리드 결정 S7-3·S7-8·S7-17 A1 — 검토 agent-security 1, 그 검토의 P6):
 * - 토큰 없는 큰 묶음 POST /mcp(text/plain, 메시지 4,000개 — 브라우저의 단순 요청 꼴, 미리 묻기 없음)는 본문을 풀지 않고 곧바로 401이다. DB(활동 기록·메인 일지·알림)에
 *   한 줄도 쓰지 않는다. 예전에는 메시지마다 app_tool 거부 줄을 써 4,000줄과 몇 초의 멈춤이 났다
 * - Host 거부(403)도 DB에 쓰지 않는다. 둘 다 기록 파일에 1분 창 한 줄이다(창의 첫 줄과, 창이 끝날 때 나머지 수)
 * - 인증 없는 요청의 몫은 리스너 하나에 1분 120번 — `/mcp`와 `/agent/v1`이 함께 세고, 넘으면 둘 다 429와 Retry-After. 맞는 에이전트 키와 살아 있는 CLI 턴 토큰은
 *   몫에 들지 않고 몫을 다 쓴 뒤에도 받는다
 * 메인 턴은 모두 모의 실행이다(externalRig close()가 확인한다)
 */
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { agentCall, bootExternal, errCode, mcpCall, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;
let key = '';
/** 백엔드 기록(ctx.log — 서버 모드의 backend.log)에 간 줄: [수준, 글] */
const logCalls: [string, string][] = [];

beforeAll(async () => {
  x = await bootExternal({});
  key = x.operator.addExternalAgent('그록봇').key;
  // 앱 도구 서버의 거부 기록은 백엔드 기록으로 간다 — 그 줄을 모은다
  const ctx = x.h.core.ctx;
  const original = ctx.log.bind(ctx);
  ctx.log = (level, msg, extra) => {
    logCalls.push([level, msg]);
    original(level, msg, extra);
  };
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const mcpPort = (): number => Number(new URL(x.mcp).port);

/**
 * 소켓에 날것의 HTTP 한 번 — 응답 전체(상태 줄·머리·본문). 인증 전의 거부는 본문을 64KB까지만 읽고 답한 뒤 연결을 끊으므로(리드 결정 S7-22 S3) 더 큰 본문을 보내는
 * 쪽은 답을 받은 뒤 연결 끊김(ECONNRESET)을 볼 수 있다 — 그때도 받은 답을 돌려준다
 */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port }, () => s.end(text));
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('error', () => undefined);
    s.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
const statusOf = (r: string): number => Number(/^HTTP\/1\.\d (\d{3})/.exec(r)?.[1] ?? 0);
const bodyOf = (r: string): unknown => JSON.parse(r.slice(r.indexOf('\r\n\r\n') + 4));

/** DB에 남는 것 — 활동 기록·메인 일지·알림의 수 */
const rows = (): { activity: number; journal: number; notices: number } => {
  const ctx = x.h.core.ctx;
  return { activity: ctx.store.activity.search({ limit: 100_000 }).length, journal: ctx.store.journal.count({}), notices: ctx.store.notifications.list().length };
};
/** 거부 기록 줄 (그 글이 든 것) */
const logged = (needle: string): string[] => logCalls.map((c) => c[1]).filter((m) => m.includes(needle));

/** 인증 없는 요청 몫을 이미 쓴 수 — 이 파일의 앞 시험들 */
let spent = 0;

describe('externalListenerFlood — 루프백 리스너의 인증 없는 요청은 DB에 쓰지 않고, 리스너 하나의 몫으로 센다 (S7-17 A1)', () => {
  it('토큰 없는 큰 묶음 POST /mcp(text/plain, 메시지 4,000개)는 본문을 풀지 않고 곧바로 401 — DB는 한 줄도 바뀌지 않는다 (P6)', async () => {
    await until(() => x.h.core.turns.count() === 0 && x.h.core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).length === 0, '시작 일이 끝남');
    const before = rows();
    const p = mcpPort();
    const batch = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'create_project', arguments: { name: `p${i}` } } })));
    expect(Buffer.byteLength(batch)).toBeGreaterThan(160_000);
    const t0 = Date.now();
    const r = await raw(
      p,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nOrigin: http://evil.example\r\nContent-Type: text/plain;charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(batch)}\r\nConnection: close\r\n\r\n${batch}`,
    );
    const ms = Date.now() - t0;
    spent += 1;
    expect(statusOf(r)).toBe(401);
    expect(r).not.toMatch(/access-control-allow-origin/i);
    // 예전 길(메시지마다 활동 기록 한 줄)은 이 묶음에 4,000줄을 쓰며 이벤트 루프를 몇 초 막았다 — 이제 본문을 읽어 버리기만 한다
    expect(ms).toBeLessThan(3000);
    // 하나짜리 요청도 본문을 풀지 않는다 — 401의 id가 그 요청의 id가 아니라 null이다
    const single = JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'x' } } });
    const one = await raw(p, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(single)}\r\nConnection: close\r\n\r\n${single}`);
    spent += 1;
    expect([statusOf(one), bodyOf(one)]).toEqual([401, { jsonrpc: '2.0', error: { code: -32001, message: 'Authorization: Bearer <토큰> 헤더가 없습니다' }, id: null }]);
    expect(rows()).toEqual(before);
    expect(x.h.core.ctx.store.projects.list()).toEqual([]);
  }, 60_000);

  it('Host 거부(403)도 DB에 쓰지 않는다 — 50번 보내도 한 줄도 늘지 않는다', async () => {
    const before = rows();
    const p = mcpPort();
    for (let i = 0; i < 50; i += 1) {
      const r = await raw(p, `POST /mcp HTTP/1.1\r\nHost: rebind.example:${p}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      expect(statusOf(r)).toBe(403);
    }
    // 같은 리스너의 에이전트 API도 Host 검사 뒤에 붙는다
    const api = await raw(p, `GET /agent/v1/seat HTTP/1.1\r\nHost: rebind.example:${p}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(api)).toBe(403);
    expect(rows()).toEqual(before);
  }, 60_000);

  it('거부는 기록 파일에 종류마다 1분 창 한 줄이다 — 요청마다 쓰지 않는다', () => {
    expect(logged('앱 도구 서버(/mcp): 인증하지 못한 요청을 401로 거부함')).toEqual(['앱 도구 서버(/mcp): 인증하지 못한 요청을 401로 거부함 (Authorization 헤더 없음) — 같은 1분 동안의 나머지는 한 줄로 모읍니다']);
    expect(logged('허용되지 않은 Host 헤더')).toEqual([`앱 도구 서버: 허용되지 않은 Host 헤더(rebind.example:${mcpPort()})의 요청을 403으로 거부함 — 같은 1분 동안의 나머지는 한 줄로 모읍니다`]);
    expect(logCalls.filter((c) => c[1].includes('앱 도구 서버')).every((c) => c[0] === 'warn')).toBe(true);
  });

  it('인증 없는 요청은 리스너 하나에 1분 120번 — /mcp와 /agent/v1이 함께 세고 넘으면 둘 다 429. 맞는 에이전트 키와 살아 있는 CLI 턴 토큰은 몫을 다 쓴 뒤에도 받는다', async () => {
    const before = rows();
    // CLI 턴과 같은 토큰 (외부 에이전트가 아닌 신원 — 서버가 띄운 CLI의 턴 토큰과 같은 길)
    const cli = x.h.core.toolServer.issueToken({
      turnId: 'TN-FLOOD1',
      sessionId: 'S-FLOOD1',
      sessionKey: 'main:general',
      sessionKind: 'main_general',
      memberId: MAIN_AGENT_ID,
      projectId: null,
      isMain: true,
      isProducer: false,
      canReview: false,
    });
    const statuses: Record<string, number> = {};
    for (let i = spent; i < 120; i += 1) {
      // /mcp(모르는 토큰)와 에이전트 API(키 없음)를 번갈아 — 같은 몫을 쓴다
      const s = i % 2 === 0 ? (await mcpCall(x.mcp, 'wtt_not-a-live-token', 'get_overview')).status : (await agentCall(x.api, null, '/seat')).status;
      statuses[s] = (statuses[s] ?? 0) + 1;
      // 그 사이의 맞는 요청은 몫에 들지 않는다
      if (i % 40 === 0) {
        expect((await agentCall(x.api, key, '/seat')).status).toBe(200);
        expect((await mcpCall(x.mcp, cli, 'get_overview')).status).toBe(200);
      }
    }
    expect(statuses).toEqual({ 401: 120 - spent });
    const mcpOver = await mcpCall(x.mcp, 'wtt_not-a-live-token', 'get_overview');
    const apiOver = await agentCall(x.api, null, '/seat');
    expect([mcpOver.status, apiOver.status, errCode(apiOver)]).toEqual([429, 429, 'rate_limited']);
    expect(Number(apiOver.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(apiOver.headers['retry-after'])).toBeLessThanOrEqual(60);
    // 몫을 다 쓴 뒤에도: 맞는 에이전트 키는 에이전트 API를, 살아 있는 CLI 턴 토큰은 MCP를 쓴다
    const seat = await agentCall(x.api, key, '/seat');
    const tool = await mcpCall(x.mcp, cli, 'get_overview');
    expect([seat.status, tool.status, tool.isError]).toEqual([200, 200, false]);
    // 거부는 DB에 한 줄도 남기지 않았다 — 늘어난 것은 맞는 도구 호출의 app_tool 줄뿐이다
    const after = rows();
    const added = x.h.core.ctx.store.activity.search({ limit: after.activity - before.activity });
    expect(added.map((a) => [a.kind, a.text])).toEqual(added.map(() => ['app_tool', 'get_overview']));
    expect([after.journal, after.notices]).toEqual([before.journal, before.notices]);
    expect(logged('인증하지 못한 요청이 1분에 120번을 넘어 429로 답함')).toHaveLength(1);
    x.h.core.toolServer.revokeToken(cli);
  }, 120_000);
});
