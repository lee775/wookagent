/**
 * 서버 기록에 부른 쪽의 글이 들어가지 않는다 (SERVER_DESIGN 3.4, S2-8 마지막 줄, S2-13 — 리뷰 security-surface E1의 프로브를 옮김).
 * not_found 같은 백엔드 오류 글은 인자를 되풀이한다('팀원 <id>을(를) 찾을 수 없습니다'). HTTP 길은 그 글과 모르는 메서드 이름을 기록하지 않고
 * 아는 메서드 이름과 오류 code만 남긴다. 줄바꿈을 낀 인자로 가짜 줄을 만들 수 없고, 큰 인자가 기록을 늘리지 않는다.
 * 서버(serve.ts)와 같은 파일 기록기·가리기로 프로세스 안 서버를 연다. 응답 본문에는 메시지가 그대로 간다
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest } from '../../src/server/admin';
import { startServer, type RunningServer } from '../../src/server/server';
import { redactSessionTokens } from '../../src/server/sessions';
import { createFileLogger, defaultRedact, type FileLogger } from '../../src/main/shell/logger';
import { invokeHttp, remoteBackendOf, removeDir } from './helpers';

const MARK = 'WOOK-ECHO-MARK-5e1d';
const FORGED = '2026-10-30T00:00:00.000Z [INFO] HTTP POST /api/invoke stop.release → 200 (1ms) FORGED-LINE';

let h: Harness;
let server: RunningServer;
let logger: FileLogger;
let logDir = '';
let token = '';
const logText = () => readFileSync(join(logDir, 'server.log'), 'utf8');

beforeAll(async () => {
  h = await createHarness({ noProject: true });
  logDir = mkdtempSync(join(tmpdir(), 'wook-test-arg-echo-'));
  logger = createFileLogger({ dir: logDir, fileName: 'server.log' });
  logger.setRedactor((t) => {
    const out = redactSessionTokens(defaultRedact(t));
    return server?.redactAdminToken(out) ?? out;
  });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: true, logger, version: 'test' });
  const reply = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
  if (!reply.ok) throw new Error('시험용 세션을 받지 못했습니다');
  token = (reply.result as { token: string }).token;
}, 120_000);

afterAll(async () => {
  await server?.close();
  logger?.close();
  await h?.close();
  await removeDir(logDir);
});

describe('HTTP 인자가 서버 기록에 남지 않는다 (S2-13)', () => {
  it('없는 ID로 부른 대표 메서드의 인자(줄바꿈 포함)는 기록에 없고, 응답 본문에는 그 글이 그대로 간다', async () => {
    const calls: [string, unknown[]][] = [
      ['members.getDetail', [`${MARK}-member\n${FORGED}`]],
      ['tasks.get', [`${MARK}-task`]],
      ['directives.get', [`${MARK}-directive`]],
    ];
    for (const [method, args] of calls) {
      const r = await invokeHttp(server.url, token, method, args);
      expect(r.status, method).toBe(404);
      expect(r.json<{ error: { code: string; message: string } }>().error.code).toBe('not_found');
    }
    // 대표에게는 메시지가 그대로 간다 (부른 쪽 자신의 글)
    const echoed = await invokeHttp(server.url, token, 'members.getDetail', [`${MARK}-reply`]);
    expect(echoed.json<{ error: { message: string } }>().error.message).toContain(`${MARK}-reply`);
    const text = logText();
    expect(text.includes(MARK)).toBe(false);
    expect(text.split('\n').filter((l) => l.startsWith('2026-10-30T00:00:00.000Z'))).toEqual([]);
    // 아는 메서드 이름과 code는 남는다
    expect(text).toContain('[WARN] HTTP 요청 실패: members.getDetail [not_found]\n');
    expect(text).toContain('HTTP POST /api/invoke members.getDetail → 404');
  });

  it('줄바꿈을 낀 모르는 메서드 이름도 기록하지 않는다 — (알 수 없는 메서드)로만', async () => {
    const r = await invokeHttp(server.url, token, `${MARK.slice(0, 12)}\n2026-10-30T00:00:01.000Z [INFO] FORGED-BY-METHOD`, []);
    expect(r.status).toBe(404);
    const text = logText();
    expect(text.includes(MARK.slice(0, 12))).toBe(false);
    expect(text.includes('FORGED-BY-METHOD')).toBe(false);
    expect(text).toContain('[WARN] 허용 목록에 없는 HTTP 메서드를 거부했습니다: (알 수 없는 메서드)\n');
  });

  it('큰 인자(200KB)가 기록을 늘리지 않는다 — 회전을 밀어내지 못한다', async () => {
    const before = readFileSync(join(logDir, 'server.log')).length;
    expect((await invokeHttp(server.url, token, 'members.getDetail', [`${MARK}-big-${'x'.repeat(200_000)}`])).status).toBe(404);
    const grown = readFileSync(join(logDir, 'server.log')).length - before;
    expect(grown).toBeLessThan(1_000);
    // 토큰은 원래부터 남지 않는다
    expect(logText().includes(token)).toBe(false);
  });
});
