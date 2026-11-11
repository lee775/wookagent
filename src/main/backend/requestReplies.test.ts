/**
 * 같은 요청은 한 번만 (리드 결정 S3-9) — 저장한 답 저장소: 처음이면 처리하고 답을 남긴다, 같은 ID는 처리하지 않고 저장한 답(성공 값 또는 같은 오류),
 * 같은 ID로 다른 요청이면 conflict, 처리 중인 같은 ID는 기다렸다가 같은 답(다른 기기 세션의 같은 ID는 동시에 와도 따로 — S3-30), 24시간이 지나면 없는 것으로 본다, 요청 ID·인자 원문은 저장하지 않는다,
 * 2판 DB를 열면 표가 더해진다. HTTP 길의 시험은 tests/server/requestReplies.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../db/store';
import { argsDigest, createRequestReplies, isReplayMethod, REPLAY_METHODS, REPLY_KEEP_MS, REQUEST_ID_REUSED, type ReplayOnce } from './requestReplies';
import { BackendError } from './types';

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function rig() {
  const store = openStore(':memory:');
  stores.push(store);
  const clock = { t: Date.parse('2026-11-02T00:00:00.000Z') };
  const saveErrors: unknown[] = [];
  const replies = createRequestReplies({ store, now: () => clock.t, onSaveError: (e) => saveErrors.push(e) });
  return { store, clock, replies, saveErrors };
}

const outcomeOfError = (e: unknown) => (e instanceof BackendError ? { ok: false as const, code: e.code, message: e.message } : { ok: false as const, code: 'internal', message: '내부 오류' });

function call(o: Partial<ReplayOnce> & { run: () => Promise<unknown> }): ReplayOnce {
  const args = ['명령'];
  return { sessionId: 'ds_1', requestId: 'req-1', method: 'command.send', digest: argsDigest(args), outcomeOfError, ...o };
}

const caught = (p: Promise<unknown>) => p.then((v) => ({ value: v }), (e: BackendError) => ({ code: e.code, message: e.message }));

describe('같은 요청 ID의 저장한 답 (S3-9)', () => {
  it('대상 메서드는 명령·질문 답변·결과 승인·수정 요청·정지 해제·기기 끊기이고 긴급 정지는 아니다', () => {
    expect([...REPLAY_METHODS].sort()).toEqual(['auth.revokeDevice', 'command.send', 'questions.answer', 'reports.approve', 'reports.requestChanges', 'stop.release']);
    expect(isReplayMethod('stop.emergency')).toBe(false);
    expect(isReplayMethod('snapshot.get')).toBe(false);
  });

  it('처음이면 처리하고, 같은 ID는 처리하지 않고 저장한 답을 준다 — 값이 없는 성공은 값 칸이 없다', async () => {
    const { replies, store } = rig();
    let runs = 0;
    const first = await replies.once(call({ run: async () => ({ conversationId: `C-${++runs}` }) }));
    const again = await replies.once(call({ run: async () => ({ conversationId: `C-${++runs}` }) }));
    expect([first, again, runs]).toEqual([{ conversationId: 'C-1' }, { conversationId: 'C-1' }, 1]);
    // 다른 ID·다른 기기 세션은 따로 처리한다
    await replies.once(call({ requestId: 'req-2', run: async () => ({ conversationId: `C-${++runs}` }) }));
    await replies.once(call({ sessionId: 'ds_2', run: async () => ({ conversationId: `C-${++runs}` }) }));
    expect(runs).toBe(3);
    // void 성공
    await replies.once(call({ requestId: 'void', method: 'stop.release', run: async () => undefined }));
    const stored = store.db.prepare('SELECT outcome FROM request_replies WHERE method = ?').get('stop.release') as { outcome: string };
    expect(JSON.parse(stored.outcome)).toEqual({ ok: true });
    expect(await replies.once(call({ requestId: 'void', method: 'stop.release', run: async () => 'again' }))).toBeUndefined();
  });

  it('첫 결과가 거부·오류면 같은 code·글로 다시 거부한다 — 그 사이 상태가 바뀌어도 다시 처리하지 않는다', async () => {
    const { replies } = rig();
    let runs = 0;
    const fail = async () => {
      runs++;
      throw new BackendError('not_found', '질문을 찾을 수 없습니다');
    };
    expect(await caught(replies.once(call({ method: 'questions.answer', run: fail })))).toEqual({ code: 'not_found', message: '질문을 찾을 수 없습니다' });
    expect(await caught(replies.once(call({ method: 'questions.answer', run: async () => ++runs })))).toEqual({ code: 'not_found', message: '질문을 찾을 수 없습니다' });
    expect(runs).toBe(1);
    // 예기치 않은 오류는 internal로 남긴다 (게이트가 invokeCore와 같은 답을 만든다)
    expect(await caught(replies.once(call({ requestId: 'boom', run: async () => { throw new Error('터짐'); } })))).toEqual({ code: undefined, message: '터짐' });
    expect(await caught(replies.once(call({ requestId: 'boom', run: async () => 'again' })))).toEqual({ code: 'internal', message: '내부 오류' });
  });

  it('같은 ID로 다른 요청(인자·메서드가 다름)이면 처리하지 않고 conflict', async () => {
    const { replies } = rig();
    let runs = 0;
    await replies.once(call({ run: async () => ++runs }));
    expect(await caught(replies.once(call({ digest: argsDigest(['다른 명령']), run: async () => ++runs })))).toEqual({ code: 'conflict', message: REQUEST_ID_REUSED });
    expect(await caught(replies.once(call({ method: 'reports.approve', run: async () => ++runs })))).toEqual({ code: 'conflict', message: REQUEST_ID_REUSED });
    expect(runs).toBe(1);
  });

  it('첫 요청이 처리 중이면 같은 ID는 끝날 때까지 기다렸다가 같은 답 — 두 번 처리하지 않는다', async () => {
    const { replies } = rig();
    let runs = 0;
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const slow = async () => {
      runs++;
      await gate;
      return { conversationId: 'C-느림' };
    };
    const a = replies.once(call({ run: slow }));
    const b = replies.once(call({ run: slow }));
    await new Promise((r) => setTimeout(r, 20));
    finish();
    expect(await Promise.all([a, b])).toEqual([{ conversationId: 'C-느림' }, { conversationId: 'C-느림' }]);
    expect(runs).toBe(1);
  });

  it('두 기기 세션이 같은 요청 ID를 동시에 보내면 둘 다 처리한다 — 저마다 제 답이고, 한쪽이 다른 쪽의 처리를 기다리지 않는다 (S3-30)', async () => {
    // 요청 ID를 1부터 세는 화면이면 기기끼리 ID가 겹치기 쉽다 — 처리 중인 것을 세션 없이 ID로만 찾으면 둘째 기기는 첫 기기의 답을 받고 제 명령은 들어가지 않는다
    const { replies } = rig();
    const ran: string[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const slow = (who: string) => async () => {
      ran.push(who);
      await gate;
      return { conversationId: `C-${who}` };
    };
    const phone = replies.once(call({ sessionId: 'ds_phone', requestId: '1', run: slow('휴대폰') }));
    const pc = replies.once(call({ sessionId: 'ds_pc', requestId: '1', run: slow('PC') }));
    await new Promise((r) => setTimeout(r, 20));
    // 첫 처리가 끝나기 전에 둘 다 처리를 시작했다
    expect([...ran].sort()).toEqual(['PC', '휴대폰']);
    finish();
    expect(await Promise.all([phone, pc])).toEqual([{ conversationId: 'C-휴대폰' }, { conversationId: 'C-PC' }]);
    // 저장한 답도 세션마다 — 다시 보내면 저마다 제 답이고 다시 처리하지 않는다
    expect(await replies.once(call({ sessionId: 'ds_pc', requestId: '1', run: slow('PC 다시') }))).toEqual({ conversationId: 'C-PC' });
    expect(ran).toHaveLength(2);
  });

  it('24시간이 지난 답은 없는 것으로 보고 지운다', async () => {
    const { replies, clock, store } = rig();
    let runs = 0;
    await replies.once(call({ run: async () => ++runs }));
    clock.t += REPLY_KEEP_MS - 1000;
    await replies.once(call({ run: async () => ++runs }));
    expect(runs).toBe(1);
    clock.t += 2000;
    await replies.once(call({ run: async () => ++runs }));
    expect(runs).toBe(2);
    clock.t += REPLY_KEEP_MS + 1;
    expect(replies.sweep()).toBe(1);
    expect((store.db.prepare('SELECT COUNT(*) AS c FROM request_replies').get() as { c: number }).c).toBe(0);
  });

  it('요청 ID와 인자 원문은 저장하지 않는다 — 지문만', async () => {
    const { replies, store } = rig();
    const SECRET_ID = 'sk-ant-api03-RequestIdSecretValue123456';
    const args = ['비밀 명령 글 9f3a'];
    await replies.once(call({ requestId: SECRET_ID, digest: argsDigest(args), run: async () => ({ conversationId: 'C-1' }) }));
    const raw = JSON.stringify(store.db.prepare('SELECT * FROM request_replies').all());
    expect(raw.includes(SECRET_ID)).toBe(false);
    expect(raw.includes('비밀 명령 글')).toBe(false);
    expect(store.db.prepare('SELECT request_id FROM request_replies').get()).toEqual({ request_id: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('답을 저장하지 못해도 처리 결과는 그대로 주고 알린다', async () => {
    const { replies, store, saveErrors } = rig();
    store.requestReplies.insert = () => {
      throw new Error('디스크가 가득 참');
    };
    expect(await replies.once(call({ run: async () => 'done' }))).toBe('done');
    expect(saveErrors).toHaveLength(1);
  });

  it('request_replies가 없는 2판 DB를 열면 표가 더해지고 지금 판(5판)이 된다 — 있던 자료는 그대로', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-replies-migrate-'));
    dirs.push(dir);
    const file = join(dir, 'wook.db');
    const v2 = openStore(file);
    v2.kv.set('owner', { sub: 'owner-sub', email: 'owner@example.com' });
    v2.db.exec('DROP TABLE request_replies');
    // 4판의 메인 자리 표, 5판의 메인 일지 표, 6판의 화면 조작 기록 표, 7판의 외부 에이전트 표도 2판에는 없다 (S4-2·S4-6·S6-7·S7-2)
    for (const t of ['seat', 'seat_history', 'seat_handover', 'main_journal', 'gui_actions', 'external_agents']) v2.db.exec(`DROP TABLE ${t}`);
    v2.db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
    v2.close();
    const check = openStore(file);
    stores.push(check);
    expect((check.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('7');
    expect(check.externalAgents.list()).toEqual([]);
    expect(check.kv.get('owner')).toEqual({ sub: 'owner-sub', email: 'owner@example.com' });
    check.requestReplies.insert({ sessionId: 's', requestId: 'r', method: 'command.send', argsDigest: 'd', outcome: { ok: true }, createdAt: new Date().toISOString() });
    // 첫 답이 남는다 — 같은 키를 다시 넣어도 바꾸지 않는다
    check.requestReplies.insert({ sessionId: 's', requestId: 'r', method: 'command.send', argsDigest: 'd2', outcome: { ok: true, value: 2 }, createdAt: new Date().toISOString() });
    expect(check.requestReplies.get('s', 'r', '2000-01-01T00:00:00.000Z')?.argsDigest).toBe('d');
  });
});
