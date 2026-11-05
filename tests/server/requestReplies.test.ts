/**
 * 같은 요청 ID는 한 번만 — HTTP 길 (리드 결정 S3-9, SERVER_DESIGN 3.4·9.1 AC-45): 서버 모드 백엔드를 연 프로세스 안 서버에 기기 세션으로 보낸다.
 * - 같은 ID의 command.send는 한 번만 들어가고 다시 보내면 같은 답(상태 코드·본문)이다. 동시에 두 번 보내도 한 번이다
 * - 다른 ID, 다른 기기 세션은 따로 처리한다. 같은 ID로 다른 요청이면 409이고 처리하지 않는다
 * - 첫 결과가 거부면 그 거부를 다시 준다 — 그사이 상태가 바뀌어도(질문이 생김) 처리하지 않는다
 * - 서버를 다시 시작해도(같은 데이터 폴더) 저장한 답을 준다 — 휴대폰이 재시작 전에 보낸 요청을 다시 보내도 두 번 들어가지 않는다
 * - 24시간이 지나면 새 요청으로 처리한다. 저장한 표에 요청 ID·명령 글 원문이 없다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../e2e/harness';
import { REQUEST_ID_REUSED } from '../../src/main/backend/requestReplies';
import { startServer, type RunningServer } from '../../src/server/server';
import { invokeHttp, memoryLogger, remoteBackendOf } from './helpers';
import { ownerServer, TEST_OWNER_RECORD, type OwnerServer } from './ownerServer';

let s: OwnerServer;

beforeAll(async () => {
  s = await ownerServer();
}, 120_000);

afterAll(async () => {
  await s?.close();
});

const ownerCommands = (h: Harness, text: string) => h.core.ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'owner' && m.text === text).length;
const send = (token: string, id: string, text: string) => invokeHttp(s.server.url, token, 'command.send', [{ target: 'main', text }], { id });

describe('같은 요청 ID는 한 번만 (S3-9)', () => {
  it('같은 ID의 command.send는 한 번만 들어가고 같은 답을 받는다 — 동시에 보내도, 다른 ID는 따로', async () => {
    const first = await send(s.token, 'phone-1', '오늘 일정을 정리해 줘');
    const again = await send(s.token, 'phone-1', '오늘 일정을 정리해 줘');
    expect(first.status).toBe(200);
    expect([again.status, again.text]).toEqual([first.status, first.text]);
    expect(ownerCommands(s.h, '오늘 일정을 정리해 줘')).toBe(1);
    const both = await Promise.all([send(s.token, 'phone-2', '동시에 보낸 명령'), send(s.token, 'phone-2', '동시에 보낸 명령')]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both[0]!.text).toBe(both[1]!.text);
    expect(ownerCommands(s.h, '동시에 보낸 명령')).toBe(1);
    await send(s.token, 'phone-3', '오늘 일정을 정리해 줘');
    expect(ownerCommands(s.h, '오늘 일정을 정리해 줘')).toBe(2);
  });

  it('다른 기기 세션의 같은 ID는 따로 처리하고, 같은 ID로 다른 요청을 보내면 409이고 처리하지 않는다', async () => {
    const tablet = s.issue('태블릿');
    await send(s.token, 'shared-id', '휴대폰 명령');
    expect((await send(tablet.token, 'shared-id', '태블릿 명령')).status).toBe(200);
    expect([ownerCommands(s.h, '휴대폰 명령'), ownerCommands(s.h, '태블릿 명령')]).toEqual([1, 1]);
    const reused = await send(s.token, 'shared-id', '다른 명령');
    expect([reused.status, reused.json()]).toEqual([409, { ok: false, error: { code: 'conflict', message: REQUEST_ID_REUSED } }]);
    const otherMethod = await invokeHttp(s.server.url, s.token, 'stop.release', [], { id: 'shared-id' });
    expect(otherMethod.status).toBe(409);
    expect(ownerCommands(s.h, '다른 명령')).toBe(0);
  });

  it('첫 결과가 거부면 그 거부를 다시 준다 — 그사이 질문이 생겨도 처리하지 않고, 새 ID로는 처리한다', async () => {
    const early = await invokeHttp(s.server.url, s.token, 'questions.answer', ['Q-0001', '네'], { id: 'answer-1' });
    expect([early.status, early.json<{ error: { code: string } }>().error.code]).toEqual([404, 'not_found']);
    await s.h.main('ask_owner', { question: '이 색으로 할까요?' });
    const q = s.h.core.ctx.store.questions.list()[0]!;
    expect(q.id).toBe('Q-0001');
    const replay = await invokeHttp(s.server.url, s.token, 'questions.answer', ['Q-0001', '네'], { id: 'answer-1' });
    expect([replay.status, replay.text]).toEqual([early.status, early.text]);
    expect(s.h.core.ctx.store.questions.require('Q-0001').status).toBe('open');
    expect((await invokeHttp(s.server.url, s.token, 'questions.answer', ['Q-0001', '네'], { id: 'answer-2' })).status).toBe(200);
    expect(s.h.core.ctx.store.questions.require('Q-0001').status).not.toBe('open');
  });

  it('상태를 바꾸지 않는 요청과 세션 없는 요청은 남기지 않는다 — 저장한 표에 요청 ID·명령 글 원문이 없다', async () => {
    const rows = () => (s.h.core.ctx.store.db.prepare('SELECT * FROM request_replies').all() as Record<string, unknown>[]);
    const before = rows().length;
    await invokeHttp(s.server.url, s.token, 'snapshot.get', [], { id: 'view-1' });
    await invokeHttp(s.server.url, null, 'auth.getState', [], { id: 'anon-1' });
    expect(rows().length).toBe(before);
    await send(s.token, 'secret-id-7c1e-요청', '원문이 남으면 안 되는 명령 8b2d');
    const raw = JSON.stringify(rows());
    expect([raw.includes('secret-id-7c1e'), raw.includes('원문이 남으면 안 되는 명령'), rows().every((r) => /^[0-9a-f]{64}$/.test(String(r.request_id)))]).toEqual([false, false, true]);
  });

  it('24시간이 지난 답은 쓰지 않는다 — 같은 ID를 새 요청으로 처리한다', async () => {
    await send(s.token, 'old-1', '어제 보낸 명령');
    s.h.core.ctx.store.db.prepare(`UPDATE request_replies SET created_at = ?`).run(new Date(Date.now() - 25 * 3600_000).toISOString());
    await send(s.token, 'old-1', '어제 보낸 명령');
    expect(ownerCommands(s.h, '어제 보낸 명령')).toBe(2);
  });
});

describe('서버를 다시 시작해도 (S3-9)', () => {
  let h: Harness | null = null;
  let server: RunningServer | null = null;
  afterAll(async () => {
    await server?.close();
    await h?.close();
  });

  it('재시작 전에 처리한 요청을 같은 ID로 다시 보내면 저장한 답을 받고 명령은 한 번만 들어간다', async () => {
    h = await createHarness({ mode: 'server', noProject: true });
    h.core.ctx.store.kv.set('owner', { ...TEST_OWNER_RECORD, registeredAt: h.core.ctx.now(), lastLoginAt: null });
    const { token } = h.core.deviceSessions.issue({ deviceName: '휴대폰' });
    server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    const before = await invokeHttp(server.url, token, 'command.send', [{ target: 'main', text: '재시작 전 명령' }], { id: 'restart-1' });
    expect(before.status).toBe(200);
    await server.close();
    server = null;
    h = await h.restart();
    server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    const after = await invokeHttp(server.url, token, 'command.send', [{ target: 'main', text: '재시작 전 명령' }], { id: 'restart-1' });
    expect([after.status, after.text]).toEqual([before.status, before.text]);
    expect(ownerCommands(h, '재시작 전 명령')).toBe(1);
  }, 120_000);
});
