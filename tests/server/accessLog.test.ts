/**
 * 토큰 없이 누구나 보낼 수 있는 요청의 접근 줄 모으기 (SERVER_DESIGN 3.4, S2-8·S2-13·S2-20 — 리뷰 security-surface N1의 프로브 zz-s2f1sec-n1-logflood를 옮김).
 * 같은 PC의 아무 계정(또는 DNS 재바인딩 페이지)이 Host가 틀린 요청·세션 없는 API 요청(로그인 전에도 열린 길, S3-3)·틀린 토큰·API 밖 경로 요청만 퍼부어도
 * 서버 기록(회전한 파일 포함)의 앞 기록이 밀려나지 않는다: 종류마다 창(1분)의 첫 줄 하나, 나머지는 수만 한 줄이다. 세션이 맞는 /api 요청은 요청마다 한 줄이다.
 * 서버(serve.ts)와 같은 파일 기록기·가리기로 프로세스 안 서버를 연다 — 회전 크기만 작게 해(8KB × 4) 프로브가 4분 넘게 보내던 양을 1,600건으로 줄였다
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileLogger, defaultRedact, type FileLogger } from '../../src/main/shell/logger';
import { adminRequest } from '../../src/server/admin';
import { HTTP_ACCESS_WINDOW_MS } from '../../src/server/http';
import { startServer, type RunningServer } from '../../src/server/server';
import { redactSessionTokens } from '../../src/server/sessions';
import { fakeServerBackend, invokeHttp, removeDir, sleep } from './helpers';

const MARK = 'WOOK-FLOOD-MARK-3c9e 시험용 세션 발급 뒤의 중요한 기록';
/** 종류마다 보내는 요청 수 */
const N = 400;

let dir = '';
let logDir = '';
let logger: FileLogger;
let server: RunningServer | null = null;
let token = '';

const fake = fakeServerBackend();

/** server.log와 회전한 파일 전부 */
function allLogs(): string {
  return ['server.log', 'server.log.1', 'server.log.2', 'server.log.3']
    .map((name) => join(logDir, name))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8'))
    .join('');
}

const linesOf = (text: string, re: RegExp): string[] => text.split('\n').filter((l) => re.test(l));

/** 같은 요청을 n번 (연결을 다시 쓰며 16개씩 동시에) */
async function flood(n: number, o: { path: string; method: string; headers?: Record<string, string>; body?: string }): Promise<number[]> {
  const agent = new Agent({ keepAlive: true, maxSockets: 16 });
  const one = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server!.port, path: o.path, method: o.method, headers: o.headers, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(o.body);
    });
  try {
    return await Promise.all(Array.from({ length: n }, one));
  } finally {
    agent.destroy();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wook-test-access-log-'));
  logDir = join(dir, 'logs');
  logger = createFileLogger({ dir: logDir, fileName: 'server.log', maxBytes: 8 * 1024, keep: 3 });
  logger.setRedactor((t) => {
    const out = redactSessionTokens(defaultRedact(t));
    return server?.redactAdminToken(out) ?? out;
  });
  // 이 시험은 퍼부은 요청이 모두 처리 길(401)까지 가야 한다 — 횟수 제한(S3-11)은 넉넉히 둔다. 횟수 제한 자체와 그 거부의 접근 줄 모으기는 rateLimit.test가 본다
  server = await startServer({ backend: fake.backend, dataDir: dir, port: 0, allowTestSession: true, logger, version: 'test', rateLimits: { anonymousPerKey: 100_000, anonymousTotal: 100_000 } });
  const reply = await adminRequest({ dataDir: dir, command: 'session.test' });
  if (!reply.ok) throw new Error('시험용 세션을 받지 못했습니다');
  token = (reply.result as { token: string }).token;
}, 60_000);

afterAll(async () => {
  await server?.close();
  logger?.close();
  fake.close();
  if (dir) await removeDir(dir);
});

describe('거부한 요청·API 밖 경로의 접근 줄 모으기 (S2-20)', () => {
  it('세션 없는 요청 1,600건이 앞 기록을 회전 밖으로 밀어내지 못한다 — 종류마다 첫 줄 하나, 닫을 때 수 한 줄. 세션이 맞는 요청은 요청마다 한 줄', async () => {
    expect(HTTP_ACCESS_WINDOW_MS).toBe(60_000);
    logger.warn(MARK);
    const port = server!.port;
    // DNS 재바인딩 꼴(Host 거부 403), 세션 없는 API(로그인 필요 401 — S3-3), 틀린 토큰(401), API 밖 경로(안내 쪽 200·없는 쪽 404·POST 405)
    const host = await flood(N, { path: '/', method: 'GET', headers: { Host: `rebind.evil.test:${port}` } });
    const noToken = await flood(N, { path: '/api/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"1","method":"snapshot.get","args":[]}' });
    const badToken = await flood(N, { path: '/api/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer wos_${'B'.repeat(43)}` }, body: '{}' });
    const pages = [
      ...(await flood(N / 2, { path: '/', method: 'GET' })),
      ...(await flood(N / 4, { path: '/favicon.ico', method: 'GET' })),
      ...(await flood(N / 4, { path: '/', method: 'POST' })),
    ];
    expect([...new Set(host)], 'Host 거부').toEqual([403]);
    expect([...new Set(noToken)], '세션 없음').toEqual([401]);
    expect([...new Set(badToken)], '틀린 토큰').toEqual([401]);
    expect([...new Set(pages)].sort(), 'API 밖 경로').toEqual([200, 404, 405]);
    for (let i = 0; i < 5; i++) expect((await invokeHttp(server!.url, token, 'auth.getState')).status).toBe(200);
    await sleep(200);

    const text = allLogs();
    expect(text.includes(MARK), '앞 기록이 남아 있다').toBe(true);
    // 창(1분) 안: 종류마다 첫 줄 하나뿐이다
    expect(linesOf(text, / HTTP \S+ Host 거부 → 403 /)).toHaveLength(1);
    expect(linesOf(text, / HTTP POST \/api\/invoke snapshot\.get → 401 /)).toHaveLength(1);
    expect(linesOf(text, /HTTP 요청 실패: snapshot\.get \[unauthorized\]/)).toHaveLength(1);
    expect(linesOf(text, / HTTP POST \/api\/invoke → 401 /)).toHaveLength(1);
    expect(linesOf(text, / HTTP \S+ static → \d{3} /)).toHaveLength(1);
    // 토큰이 맞는 /api 요청은 요청마다
    expect(linesOf(text, / HTTP POST \/api\/invoke auth\.getState → 200 /)).toHaveLength(5);

    // 닫을 때 남은 수를 쓴다
    await server!.close();
    server = null;
    const after = allLogs();
    expect(after.includes(MARK)).toBe(true);
    expect(linesOf(after, / HTTP: /).map((l) => l.replace(/^.*\[(?:INFO|WARN)\] /, '')).sort()).toEqual(
      [
        `HTTP: Host 검사에서 거부한 요청이 지난 1분 동안 ${N - 1}번 더 있었습니다`,
        `HTTP: 토큰이 없거나 맞지 않아 거부한 API 요청이 지난 1분 동안 ${N - 1}번 더 있었습니다`,
        `HTTP: 세션 없이 온 API 요청이 지난 1분 동안 ${N - 1}번 더 있었습니다`,
        // 세션 없이 온 요청의 처리 기록(게이트가 거부한 'HTTP 요청 실패: snapshot.get [unauthorized]')도 모은다 (S3-3)
        `HTTP: 세션 없이 온 요청의 처리 기록이 지난 1분 동안 ${N - 1}번 더 있었습니다`,
        `HTTP: API 밖 경로(정적 화면·안내 쪽) 요청이 지난 1분 동안 ${N - 1}번 더 있었습니다`,
      ].sort(),
    );
    // 토큰은 원래부터 남지 않는다
    expect(after.includes(token)).toBe(false);
  }, 120_000);
});
