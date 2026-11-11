/**
 * externalRevokedBudget (SERVER_DESIGN 4.5, 리드 결정 S7-17 A1·S7-19 R3·S7-20): 이 실행에서 폐기한 턴 토큰(끝난 턴의 것)으로 다시 온 `/mcp` 요청.
 * - 그 401은 요청마다 그 턴의 거부 한 줄(활동 기록, 메시지 수와 함께)을 남기지만, 인증 없는 요청의 몫(리스너 하나에 1분 120번)에 든다 — 1분 안에 N번 보내면
 *   줄은 120개까지이고 그 뒤는 429(Retry-After)이며 줄을 남기지 않는다. 그 사이에도 살아 있는 턴 토큰은 받는다
 * - 그 401은 인증 전의 답이라 본문을 64KB까지만 읽는다 (고침 3차, 리드 결정 S7-22 S3 — S7-19 R3의 '인증된 요청과 같은 상한 4MB'를 바꿨다. S7F1a): 64KB 그대로면 풀어서
 *   메시지 수를 적고, 1바이트라도 넘으면 읽지 않고 '본문이 64KB를 넘어 읽지 않음'으로 적고 연결을 닫는다(Connection: close). 인증된 요청은 그대로 4MB에서 받고(200)
 *   넘으면 413이다
 * 몫은 리스너마다라 이 파일은 제 서버를 띄운다(다른 시험의 인증 없는 요청이 섞이지 않게). 메인 턴은 모두 모의 실행이다 (externalRig close())
 */
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { AGENT_RATE_UNAUTHENTICATED } from '../../src/server/agentApiTypes';
import { PRE_AUTH_READ_MAX_BYTES } from '../../src/main/mcp/server';
import { bootExternal, situation, until, type ExternalEnv } from './externalRig';

/** 앱 도구 서버의 본문 상한 (mcp/server.ts MAX_BODY_BYTES — 인증된 요청과 같다) */
const BODY_MAX = 4 * 1024 * 1024;
const REVOKED_TURN = 'TN-RVK001';
const LIVE_TURN = 'TN-LIV001';
const INVALID = '토큰이 유효하지 않거나 이미 폐기되었습니다 (턴이 끝났을 수 있습니다)';

let x: ExternalEnv;
let revoked = '';
let live = '';

/** CLI 턴과 같은 신원의 토큰 (서버가 띄운 CLI의 메인 턴 토큰과 같은 길) */
const issue = (turnId: string): string =>
  x.h.core.toolServer.issueToken({ turnId, sessionId: `S-${turnId}`, sessionKey: 'main:general', sessionKind: 'main_general', memberId: MAIN_AGENT_ID, projectId: null, isMain: true, isProducer: false, canReview: false });

beforeAll(async () => {
  x = await bootExternal({});
  await until(() => x.h.core.turns.count() === 0 && x.h.core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).length === 0, '시작 일이 끝남', 60_000, () => situation(x));
  revoked = issue(REVOKED_TURN);
  live = issue(LIVE_TURN);
  // 끝난 턴의 토큰 — 이 실행에서 폐기했으므로 서버가 그 주인을 기억한다
  x.h.core.toolServer.revokeToken(revoked);
}, 120_000);

afterAll(async () => {
  await x?.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** POST /mcp 한 번 — 본문은 그대로 */
function post(token: string, body: Buffer): Promise<Reply> {
  const url = new URL(x.mcp);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': String(body.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** tools/call get_overview 하나 — 덧붙임(pad)으로 본문을 꼭 bytes 바이트로 맞춘다 */
function callOfSize(bytes: number): Buffer {
  const shape = (pad: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_overview', arguments: { pad } } });
  const body = Buffer.from(shape('a'.repeat(bytes - Buffer.byteLength(shape('')))), 'utf8');
  expect(body.length).toBe(bytes);
  return body;
}
const SMALL = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_overview', arguments: {} } }), 'utf8');

/** 끝난 턴의 거부 줄 — 그 턴의 활동 기록 */
const revokedRows = (): string[] => x.h.core.ctx.store.activity.search({ kinds: ['app_tool'], turnId: REVOKED_TURN, limit: 10_000 }).map((a) => a.result ?? '');

describe('externalRevokedBudget — 끝난 턴의 토큰은 요청마다 한 줄이지만 인증 없는 몫에 들고, 본문 상한은 인증된 요청과 같다 (S7-19 R3)', () => {
  it('본문 상한: 인증된 요청은 4MB 그대로 받고 넘으면 413, 끝난 턴의 토큰(인증 전의 401)은 64KB 그대로는 풀고 1바이트 넘으면 읽지 않는다 (S7-22 S3)', async () => {
    // 인증된 요청 — 상한 그대로는 처리(200), 넘으면 413
    const liveAtMax = await post(live, callOfSize(BODY_MAX));
    const liveOver = await post(live, callOfSize(BODY_MAX + 1));
    expect([liveAtMax.status, liveOver.status]).toEqual([200, 413]);
    // 끝난 턴의 토큰 — 둘 다 401. 64KB 그대로는 풀어 메시지 수를, 넘으면 읽지 않았다고 적고 연결을 닫는다
    const revokedAtMax = await post(revoked, callOfSize(PRE_AUTH_READ_MAX_BYTES));
    const revokedOver = await post(revoked, callOfSize(PRE_AUTH_READ_MAX_BYTES + 1));
    expect([revokedAtMax.status, revokedOver.status]).toEqual([401, 401]);
    expect([revokedAtMax.headers.connection, revokedOver.headers.connection]).toEqual(['close', 'close']);
    expect(revokedRows().sort()).toEqual([`${INVALID} — 끝난 턴 ${REVOKED_TURN}의 토큰입니다 (메시지 1개)`, `${INVALID} — 끝난 턴 ${REVOKED_TURN}의 토큰입니다 (본문이 64KB를 넘어 읽지 않음)`].sort());
  }, 60_000);

  it(`1분 안에 끝난 턴의 토큰으로 ${AGENT_RATE_UNAUTHENTICATED + 15}번 보내면 줄은 ${AGENT_RATE_UNAUTHENTICATED}개까지이고 그 뒤는 429 — 줄을 남기지 않으며, 살아 있는 토큰은 그 사이에도 받는다`, async () => {
    // 앞 시험이 끝난 턴의 토큰으로 두 번 썼다 — 같은 1분 창이다 (리스너의 첫 인증 없는 요청부터)
    const spent = revokedRows().length;
    expect(spent).toBe(2);
    const statuses: number[] = [];
    const retryAfter: number[] = [];
    for (let i = 0; i < AGENT_RATE_UNAUTHENTICATED + 15 - spent; i += 1) {
      const r = await post(revoked, SMALL);
      statuses.push(r.status);
      if (r.status === 429) retryAfter.push(Number(r.headers['retry-after']));
    }
    const count = (s: number) => statuses.filter((v) => v === s).length;
    expect({ 401: count(401), 429: count(429), other: statuses.length - count(401) - count(429) }).toEqual({ 401: AGENT_RATE_UNAUTHENTICATED - spent, 429: 15, other: 0 });
    // 401이 먼저, 몫을 넘은 뒤로는 모두 429
    expect(statuses.indexOf(429)).toBe(AGENT_RATE_UNAUTHENTICATED - spent);
    expect(retryAfter.every((v) => v >= 1 && v <= 60)).toBe(true);
    // 줄은 몫(120)까지 — 429는 줄을 남기지 않는다
    const rows = revokedRows();
    expect(rows).toHaveLength(AGENT_RATE_UNAUTHENTICATED);
    expect(rows.filter((r) => r === `${INVALID} — 끝난 턴 ${REVOKED_TURN}의 토큰입니다 (메시지 1개)`)).toHaveLength(AGENT_RATE_UNAUTHENTICATED - 1);
    // 몫을 다 쓴 뒤에도 살아 있는 턴 토큰은 받는다 (몫에 들지 않는다)
    expect((await post(live, SMALL)).status).toBe(200);
    expect((await post(revoked, SMALL)).status).toBe(429);
    expect(revokedRows()).toHaveLength(AGENT_RATE_UNAUTHENTICATED);
  }, 120_000);
});
