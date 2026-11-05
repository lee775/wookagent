/**
 * 느린 본문은 Node의 requestTimeout이 아니라 길마다의 시간 상한으로 본다 (SERVER_DESIGN 3.4, 리드 결정 S3-32 — 둘째 검토 security-surface의 프로브
 * zz-s3ss-slowupload를 옮김). 프로브는 1KB/s로 335KB를 올려 약 330초 만에 Node의 requestTimeout(300초)에 끊겨 본문 없는 400을 받았다 — 50MB를 약속한
 * 업로드가 느린 휴대폰 연결에서 5분을 넘기면 잘린다. 이 시험은 그 대신 startServer의 timeouts로 상한을 줄여 본다(환경 변수 스위치가 아니다).
 * - HTTP 서버는 requestTimeout 0, headersTimeout 60초(기본) — 줄인 상한보다 오래 흘러 들어오는 업로드도 데이터가 이어지면 끝까지 받는다
 * - 업로드: 데이터 없이 쉼 상한이 지나면, 또는 통째로 전체 상한이 지나면 408과 InvokeResponse 본문(그 상한을 말하는 글). 받다 만 파일은 남지 않고, 그 기기의
 *   동시 업로드 자리도 돌려준다
 * - /api/invoke 본문은 통째로 상한 안에 와야 한다 — 넘으면 408과 InvokeResponse, 처리하지 않는다. 본문이 다 오면 그 타이머를 지운다(S3-41 — 남으면 답한 뒤
 *   울려 처리되지 않은 예외를 던진다)
 * - Node가 요청을 읽다 멈추면(clientError) 머리 시간 넘김은 408, 요청 모양이 아니면 400 — 둘 다 JSON InvokeResponse 본문
 * - 본문을 읽지 않고 답한 길은 응답 뒤에도 본문이 계속 오면 상한 뒤 연결을 끊는다 — requestTimeout을 꺼도 끝없는 본문이 연결을 붙잡지 못한다
 * 토큰은 시험 출력에 내지 않는다
 */
import { existsSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSurfaceServer, DEFAULT_HTTP_TIMEOUTS } from '../../src/server/http';
import { invokeHttp, sleep } from './helpers';
import { ownerServer, type OwnerServer } from './ownerServer';

/** 줄인 상한 — 머리·invoke 본문 0.6초, 업로드 쉼 0.5초·전체 2초, 읽지 않는 본문 0.3초 */
const LIMITS = { headersMs: 600, invokeBodyMs: 600, uploadIdleMs: 500, uploadTotalMs: 2000, unreadBodyMs: 300 };

let s: OwnerServer;
beforeAll(async () => {
  s = await ownerServer({ server: { timeouts: LIMITS } });
}, 120_000);
afterAll(async () => {
  await s?.close();
});

const uploadsDir = () => join(s.h.dataDir, 'uploads');
const files = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []);

/**
 * 본문을 정한 때에 나눠 보내는 POST (writes: [보낸 뒤 기다릴 ms, 보낼 글]…, end: 다 보내고 끝낼지). 응답이 오면 그 상태와 본문, 응답 없이 끊기면 그 오류 code
 */
function slowPost(path: string, headers: Record<string, string>, writes: [waitMs: number, chunk: string][], end: boolean): Promise<{ status: number | string; text: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolveIt) => {
    let done = false;
    const finish = (r: { status: number | string; text: string }) => {
      if (done) return;
      done = true;
      resolveIt({ ...r, ms: Date.now() - started });
    };
    const req = request({ host: '127.0.0.1', port: s.server.port, path, method: 'POST', headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => finish({ status: res.statusCode ?? 0, text }));
      res.on('error', () => finish({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => finish({ status: e.code ?? 'error', text: '' }));
    void (async () => {
      for (const [waitMs, chunk] of writes) {
        if (done) return;
        req.write(chunk);
        await sleep(waitMs);
      }
      if (end && !done) req.end();
    })();
  });
}

const bearer = () => ({ Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
const error = (text: string) => (JSON.parse(text) as { ok: boolean; error?: { code: string; message: string } });

/** 날것의 연결로 글을 보내고 서버가 닫을 때까지 받은 글 */
function raw(text: string): Promise<string> {
  return new Promise((resolveIt) => {
    let got = '';
    const c = connect(s.server.port, '127.0.0.1', () => c.write(text));
    c.setEncoding('utf8');
    c.on('data', (d: string) => (got += d));
    c.on('error', () => undefined);
    c.on('close', () => resolveIt(got));
  });
}

describe('Node의 시간 상한 (S3-32)', () => {
  it('HTTP 서버는 requestTimeout을 끄고(0) headersTimeout만 건다 — 기본 60초, 본문 상한은 invoke 30초·업로드 쉼 60초·전체 60분', () => {
    expect(DEFAULT_HTTP_TIMEOUTS).toEqual({ headersMs: 60_000, invokeBodyMs: 30_000, uploadIdleMs: 60_000, uploadTotalMs: 3_600_000, unreadBodyMs: 10_000 });
    const plain = createSurfaceServer({ handle: () => undefined });
    const short = createSurfaceServer({ handle: () => undefined }, { headersMs: 600 });
    expect([plain.requestTimeout, plain.headersTimeout, short.requestTimeout, short.headersTimeout]).toEqual([0, 60_000, 0, 600]);
  });

  it('줄인 상한보다 오래 흘러 들어와도 데이터가 이어지는 업로드는 끝까지 받는다 (쉼마다 상한을 다시 잰다)', async () => {
    const before = files().length;
    // 0.15초마다 한 조각, 모두 1.2초 — 머리·invoke 상한(0.6초)과 업로드 쉼 상한(0.5초)보다 길고 전체 상한(2초)보다 짧다
    const r = await slowPost('/api/uploads?name=slow.txt', bearer(), Array.from({ length: 8 }, (_, i) => [150, `조각 ${i}\n`] as [number, string]), true);
    expect([r.status, r.ms > 1000]).toEqual([200, true]);
    const value = (JSON.parse(r.text) as { value: { uploadId: string; size: number } }).value;
    expect(value.uploadId).toMatch(/^up_[0-9a-f]{32}$/);
    expect(files().length).toBe(before + 2);
  });
});

describe('업로드의 쉼·전체 상한 (S3-32)', () => {
  it('데이터 없이 쉼 상한이 지나면 408과 InvokeResponse — 받다 만 파일이 남지 않고, 그 기기의 동시 업로드 자리도 돌려준다', async () => {
    const before = files().filter((f) => !f.endsWith('.part'));
    // 셋을 함께 연다(한 기기의 동시 업로드 상한) — 모두 한 조각만 보내고 멈춘다
    const stalled = await Promise.all(Array.from({ length: 3 }, (_, i) => slowPost(`/api/uploads?name=stall-${i}.bin`, bearer(), [[0, '조금만']], false)));
    for (const r of stalled) {
      expect([r.status, error(r.text)]).toEqual([
        408,
        { ok: false, error: { code: 'timeout', message: '올리는 중 0.5초 동안 데이터가 오지 않아 멈췄습니다. 연결을 확인하고 다시 올려 주세요.' } },
      ]);
      expect(r.ms).toBeGreaterThanOrEqual(450);
    }
    const until = Date.now() + 3000;
    while (files().some((f) => f.endsWith('.part')) && Date.now() < until) await sleep(50);
    expect(files().filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(files().filter((f) => !f.endsWith('.part')).sort()).toEqual(before.sort());
    // 자리를 돌려주었다 — 바로 다음 업로드를 받는다(돌려주지 않았으면 429)
    const next = await slowPost('/api/uploads?name=after.txt', bearer(), [[0, '다음 파일']], true);
    expect(next.status).toBe(200);
    expect(s.log.text()).toContain('업로드를 멈췄습니다 (0.5초 동안 데이터 없음)');
  });

  it('통째로 전체 상한이 지나면 데이터가 이어져도 408 — 그 상한을 말하고 받다 만 파일이 남지 않는다', async () => {
    const before = files().filter((f) => !f.endsWith('.part'));
    // 0.3초마다 한 조각(쉼 상한 안) 1.8초 동안 보내고 멈춘다 — 전체 상한(2초)이 먼저 온다
    const r = await slowPost('/api/uploads?name=long.bin', bearer(), Array.from({ length: 7 }, () => [300, 'x'.repeat(100)] as [number, string]), false);
    expect([r.status, error(r.text)]).toEqual([
      408,
      { ok: false, error: { code: 'timeout', message: '올리는 데 2초 넘게 걸려 멈췄습니다. 더 빠른 연결에서 다시 올리거나 파일을 나눠 올려 주세요.' } },
    ]);
    expect(r.ms).toBeGreaterThanOrEqual(1900);
    const until = Date.now() + 3000;
    while (files().some((f) => f.endsWith('.part')) && Date.now() < until) await sleep(50);
    expect(files().filter((f) => !f.endsWith('.part')).sort()).toEqual(before.sort());
    expect(files().filter((f) => f.endsWith('.part'))).toEqual([]);
  });
});

describe('/api/invoke 본문과 Node의 clientError (S3-32)', () => {
  it('invoke 본문이 상한 안에 다 오지 않으면 408과 InvokeResponse — 처리하지 않는다', async () => {
    const before = s.h.core.ctx.store.conversation.list({ ref1: 'main' }).length;
    const body = JSON.stringify({ id: 'slow-1', method: 'command.send', args: [{ target: 'main', text: '느리게 온 명령' }] });
    const r = await slowPost('/api/invoke', { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, [[0, body.slice(0, 20)]], false);
    expect([r.status, error(r.text)]).toEqual([408, { ok: false, error: { code: 'timeout', message: '요청 본문이 0.6초 안에 다 오지 않아 멈췄습니다. 연결을 확인하고 다시 해 주세요.' } }]);
    await sleep(200);
    expect(s.h.core.ctx.store.conversation.list({ ref1: 'main' }).length).toBe(before);
  });

  it('본문이 다 온 invoke는 시간 상한 타이머를 남기지 않는다 — 상한이 지나도 처리되지 않은 예외가 없고 다음 요청도 200 (S3-41)', async () => {
    // 셋째 검토 tests-integrity의 프로브 zz-s3f2ti-invoke-timer: 'end'에서 clearTimeout을 빼도(변이 Z-TO16) 시험이 모두 통과했다. 그러면 상한이 지난 뒤
    // 타이머가 이미 끝난 응답에 408을 쓰려다 ERR_HTTP_HEADERS_SENT를 던진다 — 서버 기록에 성공한 요청마다 '처리되지 않은 예외'가 남는다
    const thrown: string[] = [];
    const onUncaught = (e: Error & { code?: string }): void => void thrown.push(e.code ?? e.name);
    process.on('uncaughtException', onUncaught);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await invokeHttp(s.server.url, s.token, 'auth.getState')).status);
      await sleep(LIMITS.invokeBodyMs + 500);
      const after = (await invokeHttp(s.server.url, s.token, 'auth.getState')).status;
      await sleep(LIMITS.invokeBodyMs + 300);
      expect({ statuses, after, thrown }).toEqual({ statuses: [200, 200, 200], after: 200, thrown: [] });
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('머리를 머리 상한 안에 다 보내지 않으면 408, HTTP 요청 모양이 아니면 400 — 둘 다 JSON InvokeResponse 본문', async () => {
    const parse = (text: string) => {
      const [head, payload] = text.split('\r\n\r\n');
      return { status: head!.split('\r\n')[0], json: head!.includes('Content-Type: application/json; charset=utf-8'), body: JSON.parse(payload!) as unknown };
    };
    const slowHead = await raw(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${s.server.port}\r\n`);
    expect(parse(slowHead)).toEqual({
      status: 'HTTP/1.1 408 Request Timeout',
      json: true,
      body: { ok: false, error: { code: 'timeout', message: '요청이 제시간에 다 오지 않아 끊었습니다. 연결을 확인하고 다시 해 주세요.' } },
    });
    const garbage = await raw('BAD STUFF\r\n\r\n');
    expect(parse(garbage)).toEqual({ status: 'HTTP/1.1 400 Bad Request', json: true, body: { ok: false, error: { code: 'bad_request', message: 'HTTP 요청을 읽지 못했습니다 — 요청 모양이 맞지 않습니다' } } });
  });

  it('본문을 읽지 않고 답한 길에 본문이 계속 흘러 들어오면 응답 뒤 상한(0.3초) 안에 연결을 끊는다 — requestTimeout을 꺼도 연결을 붙잡지 못한다', async () => {
    const started = Date.now();
    const r = await new Promise<{ status: string; closedMs: number }>((resolveIt) => {
      let got = '';
      const c = connect(s.server.port, '127.0.0.1', () => c.write(`POST /x HTTP/1.1\r\nHost: 127.0.0.1:${s.server.port}\r\nTransfer-Encoding: chunked\r\n\r\n`));
      // 0.1초마다 한 조각 — 끊기지 않으면 3초 동안 보낸다
      const tick = setInterval(() => {
        if (!c.destroyed) c.write('1\r\nx\r\n');
      }, 100);
      const stop = setTimeout(() => c.destroy(), 3000);
      c.setEncoding('utf8');
      c.on('data', (d: string) => (got += d));
      c.on('error', () => undefined);
      c.on('close', () => {
        clearInterval(tick);
        clearTimeout(stop);
        resolveIt({ status: got.split('\r\n')[0] ?? '', closedMs: Date.now() - started });
      });
    });
    expect(r.status).toBe('HTTP/1.1 405 Method Not Allowed');
    expect(r.closedMs).toBeLessThan(2000);
  });
});
