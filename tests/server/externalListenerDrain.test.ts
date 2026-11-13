/**
 * 루프백 리스너(앱 도구 서버 — `/mcp`와 `/agent/v1`)가 인증 전에 읽는 양과 시간 (SERVER_DESIGN 4.5, 리드 결정 S7-22 S3 — 검토 round 2 server 3, 그 검토의 `zz-r2s-listener`):
 * - 인증 전에 주는 답(Host 거부 403, 없는 길 404, 토큰 없는 401, 몫을 넘은 429, hello의 413)은 본문을 64KB까지만 읽고 곧바로 답한 뒤 연결을 끊는다(Connection: close).
 *   예전에는 100MB를 보내면 403·404는 100MB를, 401·hello는 64MB를 끝까지 받아 버렸다
 * - 리스너는 요청 하나를 받는 시간(기본 30초)과 머리를 받는 시간(기본 10초)에 상한이 있다 — 느리게 보내는 쪽은 그때 끊긴다(408). 받는 시간만 잰다: 상한보다 오래
 *   기다리는 롱폴(work/next)과 인증한 4MB 도구 본문은 그대로 된다
 * - 인증한 요청과 맞는 hello는 연결을 이어 쓴다(keep-alive) — Connection: close는 거부에만 붙는다
 * 이 파일은 상한을 1.5초로 줄인다(timing.listenerRequestMs). 메인 턴은 모두 모의 실행이거나 외부 턴이다(externalRig close()가 확인한다)
 */
import { randomBytes } from 'node:crypto';
import { Agent, request } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentCall, bootExternal, claimAs, errCode, mcpCall, nextWork, type ExternalEnv } from './externalRig';

/** 이 파일의 받는 시간 상한 (기본 30초를 줄인다) */
const REQUEST_MS = 1500;
/** 롱폴 상한 — 받는 시간 상한보다 길다 */
const POLL_MS = 4000;
/** 100MB를 밀어 넣을 때 리스너가 받아 들였다고 볼 수 있는 상한 — 64KB를 읽고 멈추므로 나머지는 두 쪽 소켓 버퍼뿐이다 (예전: 64~100MB) */
const ACCEPTED_MAX_MB = 16;
const MB100 = 100 * 1024 * 1024;

let x: ExternalEnv;
let key = '';

beforeAll(async () => {
  x = await bootExternal({ timing: { listenerRequestMs: REQUEST_MS, agentPollMaxMs: POLL_MS } });
  key = x.operator.addExternalAgent('그록봇').key;
  await x.operator.assignSeat('external:X-0001', true);
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const port = (): number => Number(new URL(x.mcp).port);
const statusLines = (t: string): string[] => t.split('\r\n').filter((l) => /^HTTP\/1\.1 \d{3}/.test(l));

/**
 * 머리를 보낸 뒤 본문 total바이트를 1MB씩 밀어 넣는다 (Connection: close 없이). 답의 상태 줄, 리스너가 받아 들인 양(보낸 쪽의 쓰기가 끝난 양), 첫 답 바이트까지의 시간,
 * 연결이 닫힌 때를 돌려준다. 받아 들이지 않으면(소켓 버퍼가 차면) ms 뒤에 이쪽이 끊는다
 */
function push(head: string, total: number, ms = 8000): Promise<{ status: string[]; acceptedMB: number; firstByteMs: number; closedMs: number; closedBy: 'server' | 'client' }> {
  return new Promise((resolve) => {
    // 이 파일의 걸린 시간은 모두 단조 시계로 잰다 — 벽시계는 뒤로 갈 수 있다(WSL2는 30초쯤마다 0.5초, 리드 결정 S10t)
    const t0 = performance.now();
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let flushed = 0;
    let written = 0;
    let first = -1;
    let closedBy: 'server' | 'client' = 'server';
    const replies: Buffer[] = [];
    const s = connect({ host: '127.0.0.1', port: port() }, () => {
      s.write(head);
      const pump = (): void => {
        while (written < total && !s.destroyed) {
          written += chunk.length;
          const ok = s.write(chunk, (err) => {
            if (!err) flushed += chunk.length;
          });
          if (!ok) return void s.once('drain', pump);
        }
      };
      pump();
    });
    s.on('data', (c: Buffer) => {
      if (first < 0) first = performance.now() - t0;
      replies.push(c);
    });
    s.on('error', () => undefined);
    s.on('close', () =>
      resolve({ status: statusLines(Buffer.concat(replies).toString('latin1')), acceptedMB: Math.round((flushed / 1024 / 1024) * 10) / 10, firstByteMs: first, closedMs: performance.now() - t0, closedBy }),
    );
    setTimeout(() => {
      if (!s.destroyed) {
        closedBy = 'client';
        s.destroy();
      }
    }, ms).unref();
  });
}

/** 머리(와 본문 앞부분)를 보내고 그 뒤로 아무것도 보내지 않는다 — 리스너가 끊을 때까지의 시간과 답 */
function stall(text: string, ms = 10_000): Promise<{ text: string; closedMs: number; closedBy: 'server' | 'client' }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const replies: Buffer[] = [];
    let closedBy: 'server' | 'client' = 'server';
    const s = connect({ host: '127.0.0.1', port: port() }, () => s.write(text));
    s.on('data', (c: Buffer) => replies.push(c));
    s.on('error', () => undefined);
    s.on('close', () => resolve({ text: Buffer.concat(replies).toString('latin1'), closedMs: performance.now() - t0, closedBy }));
    setTimeout(() => {
      if (!s.destroyed) {
        closedBy = 'client';
        s.destroy();
      }
    }, ms).unref();
  });
}

/**
 * 반쯤 열린(allowHalfOpen) 쪽 — 서버의 FIN을 받아도 제 쪽을 닫지 않고 runMs 동안 1MB씩 계속 보낸다(검토 round 3의 zzR3S3Linger 꼴). 서버가 받아 들인 양(쓰기가 끝난 양),
 * 답의 상태, 서버가 소켓을 없앤 때(쓰기가 깨지거나 닫힌 때)를 돌려준다
 */
function halfOpen(h: string, runMs = 4000): Promise<{ status: string; acceptedMB: number; answerMs: number; closedMs: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let flushed = 0;
    let answerMs = -1;
    let reply = '';
    const s = connect({ host: '127.0.0.1', port: port(), allowHalfOpen: true }, () => {
      s.write(h);
      const pump = (): void => {
        while (!s.destroyed && performance.now() - t0 < runMs) {
          const ok = s.write(chunk, (err) => {
            if (!err) flushed += chunk.length;
          });
          if (!ok) return void s.once('drain', pump);
        }
      };
      pump();
    });
    s.on('data', (c: Buffer) => {
      reply += c.toString('latin1');
      if (answerMs < 0) answerMs = performance.now() - t0;
    });
    s.on('error', () => undefined);
    s.on('close', () => resolve({ status: /^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? '', acceptedMB: Math.round((flushed / 1048576) * 10) / 10, answerMs, closedMs: performance.now() - t0 }));
    setTimeout(() => {
      if (!s.destroyed) s.destroy();
    }, runMs + 2000).unref();
  });
}
/**
 * 반쯤 열린 쪽이 계속 보낼 때 받아 들인 양의 상한 (MB). 보낸 쪽의 쓰기가 끝난 양으로 재므로 두 쪽 커널의 소켓 버퍼가 든다 — 이 PC의 루프백에서 서버가 64KB 뒤로 읽지
 * 않을 때(청크) 8MB였다. 서버가 읽은 양은 64KB와 Node의 읽기 한 번 남짓이다. 고치기 전(선언한 길이)은 2초 동안 1,161~1,430MB였다 (S7-24 W1)
 */
const HALF_OPEN_MAX_MB = 12;
const TEN_GB = 10 * 1024 * 1024 * 1024;

const head = (method: string, path: string, host: string, extra = ''): string => `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n${extra}`;
const sized = (h: string): string => `${h}Content-Length: ${MB100}\r\n\r\n`;
/** 청크 전송 — 거대한 청크 하나를 알리고 1MB씩 그 데이터로 보낸다(선언한 길이로 거르지 못하게) */
const chunked = (h: string): string => `${h}Transfer-Encoding: chunked\r\n\r\n${MB100.toString(16)}\r\n`;

/** 인증 없는 요청 몫을 쓴 수 (이 파일) */
let spent = 0;

describe('externalListenerDrain — 인증 전의 답은 64KB까지만 읽고 곧바로 답한 뒤 끊는다 (S7-22 S3)', () => {
  it('100MB 본문: Host 거부·없는 길·토큰 없는 /mcp·hello — 모두 곧바로 답하고, 64KB 뒤로는 읽지 않으며, 연결을 닫는다', async () => {
    const p = port();
    const local = `127.0.0.1:${p}`;
    const cases: Record<string, string> = {
      badHost: sized(head('POST', '/mcp', `rebind.example:${p}`)),
      badHostChunked: chunked(head('POST', '/agent/v1/seat/claim', `rebind.example:${p}`)),
      unknownPath: sized(head('POST', '/nope', local)),
      unknownPathChunked: chunked(head('POST', '/nope', local)),
      mcpNoToken: chunked(head('POST', '/mcp', local)),
      agentNoKey: chunked(head('POST', '/agent/v1/seat/claim', local)),
      helloChunked: chunked(head('POST', '/agent/v1/hello', local)),
      helloSized: sized(head('POST', '/agent/v1/hello', local)),
    };
    const want: Record<string, string> = {
      badHost: '403',
      badHostChunked: '403',
      unknownPath: '404',
      unknownPathChunked: '404',
      mcpNoToken: '401',
      agentNoKey: '401',
      helloChunked: '413',
      helloSized: '413',
    };
    const got: Record<string, unknown> = {};
    for (const [name, h] of Object.entries(cases)) {
      const r = await push(h, MB100);
      if (name === 'mcpNoToken' || name === 'agentNoKey') spent += 1;
      got[name] = { status: r.status.map((s) => s.slice(9, 12)), acceptedUnderBound: r.acceptedMB <= ACCEPTED_MAX_MB, answeredAtOnce: r.firstByteMs >= 0 && r.firstByteMs < 3000, closedByServer: r.closedBy === 'server' };
    }
    expect(got).toEqual(Object.fromEntries(Object.entries(want).map(([k, s]) => [k, { status: [s], acceptedUnderBound: true, answeredAtOnce: true, closedByServer: true }])));
  }, 120_000);

  it(`FIN을 받고도 계속 보내는 쪽(allowHalfOpen) — 선언한 길이·청크 모두 거부한 뒤로는 읽지 않는다: Host 거부·없는 길·토큰 없는 /mcp·키 없는 API·hello 413, 받는 양 ${HALF_OPEN_MAX_MB}MB 안 (S7-24 W1)`, async () => {
    const p = port();
    const local = `127.0.0.1:${p}`;
    const forms: Record<string, (path: string, host: string) => string> = {
      declared: (path, host) => `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${TEN_GB}\r\n\r\n`,
      chunked: (path, host) => `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${TEN_GB.toString(16)}\r\n`,
    };
    const paths: Record<string, [string, string, string]> = {
      badHost: ['/mcp', `rebind.example:${p}`, '403'],
      unknownPath: ['/nope', local, '404'],
      mcpNoToken: ['/mcp', local, '401'],
      agentNoKey: ['/agent/v1/seat/claim', local, '401'],
      hello: ['/agent/v1/hello', local, '413'],
    };
    const got: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    const seen: Record<string, unknown> = {};
    for (const [name, [path, host, status]] of Object.entries(paths)) {
      for (const [form, make] of Object.entries(forms)) {
        const r = await halfOpen(make(path, host));
        if (name === 'mcpNoToken' || name === 'agentNoKey') spent += 1;
        seen[`${name}/${form}`] = r;
        // 서버가 2초 뒤에 없앤다 — 이쪽이 4초 동안 보내다 스스로 멈추기 전에 닫힌다
        got[`${name}/${form}`] = { status: r.status, underBound: r.acceptedMB <= HALF_OPEN_MAX_MB, answeredAtOnce: r.answerMs >= 0 && r.answerMs < 3000, cutByServer: r.closedMs < 3500 };
        want[`${name}/${form}`] = { status, underBound: true, answeredAtOnce: true, cutByServer: true };
      }
    }
    expect(got, JSON.stringify(seen)).toEqual(want);
  }, 120_000);

  it('작은 본문의 거부도 Connection: close로 답하고 연결을 닫는다 — 인증하지 못한 연결은 이어 쓰지 않는다', async () => {
    const p = port();
    const r = await stall(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\n\r\n`, 5000);
    expect([statusLines(r.text), /\r\nConnection: close\r\n/i.test(r.text), r.closedBy]).toEqual([['HTTP/1.1 405 Method Not Allowed'], true, 'server']);
    const bad = await stall(`POST /agent/v1/hello HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`, 5000);
    expect([statusLines(bad.text), /\r\nConnection: close\r\n/i.test(bad.text), bad.closedBy]).toEqual([['HTTP/1.1 400 Bad Request'], true, 'server']);
  }, 30_000);

  it('계속 보내며 답을 늦게(0.5초 뒤) 읽는 쪽도 거부의 답을 받는다 — 리스너는 답한 뒤 읽지 않은 채 잠깐 기다렸다가 끊는다(곧바로 끊으면 RST가 보내는 쪽의 쓰기를 깨뜨려 받은 답까지 버리게 한다)', async () => {
    const p = port();
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const late = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      let sent = 0;
      const s = connect({ host: '127.0.0.1', port: p }, () => {
        s.pause();
        s.write(`POST /nope HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Length: ${MB100}\r\n\r\n`);
        const pump = (): void => {
          while (sent < MB100 && !s.destroyed) {
            sent += chunk.length;
            if (!s.write(chunk)) return void s.once('drain', pump);
          }
        };
        pump();
        setTimeout(() => s.resume(), 500);
      });
      s.on('data', (c: Buffer) => chunks.push(c));
      s.on('error', () => undefined);
      s.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
      setTimeout(() => s.destroy(), 10_000).unref();
    });
    expect([statusLines(late), /\r\nConnection: close\r\n/i.test(late)]).toEqual([['HTTP/1.1 404 Not Found'], true]);
  }, 30_000);

  it('느리게 보내는 쪽은 받는 시간 상한에서 끊긴다 — 머리를 다 보내지 않거나, 본문을 다 보내지 않거나 (408)', async () => {
    const p = port();
    const slowHead = await stall(`POST /agent/v1/hello HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: appl`);
    const slowBody = await stall(`POST /agent/v1/hello HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"non`);
    const slowMcp = await stall(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"json`);
    spent += 1; // 토큰 없는 /mcp — 머리에서 몫을 센다
    for (const r of [slowHead, slowBody, slowMcp]) {
      expect([r.closedBy, r.closedMs >= REQUEST_MS - 200, r.closedMs < REQUEST_MS + 3000]).toEqual(['server', true, true]);
    }
    expect(statusLines(slowBody.text)).toEqual(['HTTP/1.1 408 Request Timeout']);
  }, 60_000);

  it('받는 시간만 잰다: 상한보다 오래 기다리는 롱폴(work/next)은 답하고, 인증한 4MB 도구 본문은 REST·MCP 모두 처리한다', async () => {
    const lease = await claimAs(x.api, key);
    const t0 = performance.now();
    const idle = await agentCall(x.api, key, '/work/next', { body: { leaseId: lease.leaseId, waitMs: POLL_MS } });
    const waited = performance.now() - t0;
    expect([idle.status, waited > REQUEST_MS * 2]).toEqual([204, true]);
    await x.owner$('command.send', { target: 'main', text: '큰 도구 본문' });
    const w = await nextWork(x.api, key, lease.leaseId);
    const pad = 'y'.repeat(4 * 1024 * 1024 - 64);
    const rest = await agentCall(x.api, key, '/tool/get_overview', { rawBody: `{"pad":"${pad}"}`, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([rest.status, rest.json<{ ok: boolean }>().ok]).toEqual([200, true]);
    const mcp = await mcpCall(x.mcp, w.mcp.token, 'get_overview', { pad: pad.slice(0, 4 * 1024 * 1024 - 200) });
    expect([mcp.status, mcp.isError]).toEqual([200, false]);
    const fin = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '끝', outcome: 'completed' } });
    expect(fin.status).toBe(200);
  }, 120_000);

  it('인증한 요청과 맞는 hello는 연결을 이어 쓴다(keep-alive) — Connection: close는 거부에만 붙는다', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const u = new URL(x.api);
    const sockets = new Set<unknown>();
    const call = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; connection: string | undefined }> =>
      new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body));
        const req = request(
          { host: u.hostname, port: Number(u.port), path: `${u.pathname}${path}`, method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length), ...headers } },
          (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }));
          },
        );
        req.on('socket', (s) => sockets.add(s));
        req.on('error', reject);
        req.end(data);
      });
    try {
      const hello = await call('/hello', { nonce: randomBytes(32).toString('base64url') });
      const lease = await call('/seat/claim', {}, { Authorization: `Bearer ${key}` });
      const seat = await call('/seat/claim', {}, { Authorization: `Bearer ${key}` });
      expect([hello.status, lease.status, seat.status, sockets.size]).toEqual([200, 200, 200, 1]);
      expect([hello.connection, lease.connection]).toEqual(['keep-alive', 'keep-alive']);
      // 거부(401)는 Connection: close — 다음 요청은 새 연결이다
      const refused = await call('/seat/claim', {}, { Authorization: 'Bearer nope' });
      spent += 1;
      expect([refused.status, refused.connection]).toEqual([401, 'close']);
      const after = await call('/hello', { nonce: randomBytes(32).toString('base64url') });
      expect([after.status, sockets.size]).toEqual([200, 2]);
    } finally {
      agent.destroy();
    }
  }, 60_000);

  it('몫을 넘은 요청(429)도 100MB를 받지 않는다', async () => {
    for (let i = spent; i < 120; i += 1) {
      const r = await agentCall(x.api, null, '/seat');
      expect(r.status).toBe(401);
    }
    const p = port();
    const over = await push(chunked(head('POST', '/mcp', `127.0.0.1:${p}`)), MB100);
    const overApi = await push(chunked(head('POST', '/agent/v1/seat/claim', `127.0.0.1:${p}`)), MB100);
    for (const r of [over, overApi]) expect([r.status.map((s) => s.slice(9, 12)), r.acceptedMB <= ACCEPTED_MAX_MB, r.closedBy]).toEqual([['429'], true, 'server']);
    // FIN을 받고도 계속 보내는 쪽 — 선언한 길이도 청크도 429 뒤로는 읽지 않는다 (S7-24 W1)
    const halfDeclared = await halfOpen(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nContent-Length: ${TEN_GB}\r\n\r\n`);
    const halfChunked = await halfOpen(chunked(head('POST', '/agent/v1/seat/claim', `127.0.0.1:${p}`)));
    expect(
      [halfDeclared, halfChunked].map((r) => [r.status, r.acceptedMB <= HALF_OPEN_MAX_MB, r.closedMs < 3500]),
      JSON.stringify([halfDeclared, halfChunked]),
    ).toEqual([
      ['429', true, true],
      ['429', true, true],
    ]);
    // 맞는 hello는 몫과 상관없이 답한다 (S7-21)
    const hello = await agentCall(x.api, null, '/hello', { body: { nonce: randomBytes(32).toString('base64url') } });
    expect([hello.status, errCode(hello)]).toEqual([200, null]);
  }, 120_000);
});
