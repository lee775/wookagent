/**
 * 앱 도구 서버는 4MB를 넘는 요청 본문에도 413(JSON-RPC 오류 본문)으로 답하고, 그 답이 클라이언트에 닿는다 (15.3 앱 도구 서버, CLI-07).
 * 단계 5까지는 본문을 다 받기 전에 413을 보내고 연결을 닫았다. 클라이언트(CLI의 MCP 클라이언트·fetch)는 아직 본문을 보내는 중이라,
 * 읽지 않은 본문이 남은 채 닫힌 연결에 Windows가 RST를 보내 클라이언트가 413을 읽기 전에 ECONNRESET을 받았다 — 전체 실행(부하)에서만
 * src/main/mcp/server.test.ts의 '4MB 초과 → 413' 시험이 실패한 까닭. 이제 넘친 본문은 버리며 끝까지 받은 뒤에 답한다.
 * 여기서는 본문을 천천히 나눠 보내 '응답 뒤에도 보내는 중'인 상황을 늘 만든다.
 */
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppToolServer } from '../../src/main/mcp/server';
import type { AppToolServer, TokenIdentity, ToolCallLog } from '../../src/main/mcp/types';

const MEMBER: TokenIdentity = {
  turnId: 'TN-000001',
  sessionId: 'S-000001',
  sessionKey: 'task:T-0001',
  sessionKind: 'task',
  memberId: 'M-0002',
  projectId: 'P-0001',
  isMain: false,
  isProducer: false,
  canReview: false,
};

const servers: AppToolServer[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((s) => s.stop()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 날 HTTP로 본문을 조각조각 천천히 보내고, 받은 응답과 소켓 오류를 돌려준다 */
async function slowPost(port: number, token: string, bodyBytes: number, o: { chunked: boolean }): Promise<{ status: number; body: string; socketError: string | null }> {
  const socket = connect({ host: '127.0.0.1', port });
  let received = '';
  let socketError: string | null = null;
  socket.setEncoding('utf8');
  socket.on('data', (d: string) => (received += d));
  socket.on('error', (e: NodeJS.ErrnoException) => (socketError = e.code ?? e.message));
  const closed = new Promise<void>((r) => socket.on('close', () => r()));
  await new Promise<void>((r, j) => {
    socket.once('connect', () => r());
    socket.once('error', j);
  });
  const head = [
    'POST /mcp HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${token}`,
    'Content-Type: application/json',
    'Accept: application/json, text/event-stream',
    o.chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${bodyBytes}`,
    '',
    '',
  ].join('\r\n');
  socket.write(head);
  const piece = Buffer.alloc(64 * 1024, 0x78);
  for (let sent = 0; sent < bodyBytes && !socket.destroyed; sent += piece.length) {
    const n = Math.min(piece.length, bodyBytes - sent);
    const chunk = n === piece.length ? piece : piece.subarray(0, n);
    socket.write(o.chunked ? Buffer.concat([Buffer.from(`${n.toString(16)}\r\n`), chunk, Buffer.from('\r\n')]) : chunk);
    await sleep(2);
  }
  if (o.chunked && !socket.destroyed) socket.write('0\r\n\r\n');
  await Promise.race([closed, sleep(15_000)]);
  socket.destroy();
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0);
  return { status, body: received.slice(received.indexOf('\r\n\r\n') + 4), socketError };
}

describe('앱 도구 서버의 너무 큰 요청 본문', () => {
  for (const chunked of [false, true]) {
    it(`본문을 보내는 중인 클라이언트도 연결이 끊기지 않고 413 응답을 받는다 (${chunked ? '분할 전송' : 'Content-Length'})`, async () => {
      const logs: ToolCallLog[] = [];
      let handled = 0;
      const server = createAppToolServer({
        handler: async () => {
          handled += 1;
          return { ok: true, data: {} };
        },
        onCall: (l) => logs.push(l),
      });
      servers.push(server);
      const { port } = await server.start();
      const token = server.issueToken(MEMBER);
      const r = await slowPost(port, token, 5 * 1024 * 1024, { chunked });
      expect({ status: r.status, socketError: r.socketError, rpc: r.status ? (JSON.parse(r.body.trim().split('\r\n').pop() ?? '{}') as { error?: { code: number } }).error?.code : null, handled, logs: logs.length }).toEqual({
        status: 413,
        socketError: null,
        rpc: -32000,
        handled: 0,
        logs: 0,
      });
    }, 30_000);
  }
});
