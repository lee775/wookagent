/**
 * 4단계로 옮긴 데이터에서도 메인 도구는 한 번만 처리된다 (리드 결정 S4-21, AC-45, S4-4):
 * - 4단계 이전(3판) DB의 메인 도구 중복 캐시는 세대 없는 키 'toolreq:M-MAIN:<도구>:<요청ID>'였다. 옮긴 DB의 1세대는 그 키도 보관 기간(7일 — 옮길 때 적은
 *   때부터) 안에서 본다 — 업그레이드 전에 처리한 요청을 끊긴 턴이 같은 request_id로 다시 보내도 두 번 처리하지 않는다
 * - 새로 쓰는 것은 늘 세대가 든 키다. 보관 기간이 지난 옛 키와 다른 세대는 옛 키를 보지 않는다
 * 탐침 zz-s4fl-cache-across-migration(server-s4-flows-lifecycle)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import { openStore } from '../../src/main/db/store';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { createHarness, type Harness } from '../e2e/harness';

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const mainIdentity = (generation: number): TokenIdentity => ({
  turnId: 'TN-upgrade',
  sessionId: 'S-upgrade',
  sessionKey: 'main:general',
  sessionKind: 'main_general',
  memberId: MAIN_AGENT_ID,
  projectId: null,
  isMain: true,
  isProducer: false,
  canReview: false,
  seatGeneration: generation,
});
const ASK = { question: '배포는 금요일로 할까요?', reason: '확인' };
const duplicate = (r: { ok: boolean; data?: unknown }) => (r.ok ? ((r.data as { duplicateRequest?: boolean }).duplicateRequest ?? false) : r);

/** 3판 DB를 만든다: 메인이 그 판에서 ask_owner를 한 번 처리했고(request_id rq-upg), 그 캐시는 세대 없는 키이고 때가 없다. 자리·일지 표는 없다 */
async function stage3Db(): Promise<{ dataDir: string; questions: number }> {
  const old = await createHarness({ noProject: true });
  const { dataDir } = old;
  expect((await old.core.tools.handle(mainIdentity(1), 'ask_owner', { ...ASK, request_id: 'rq-upg' })).ok).toBe(true);
  await old.close({ keepDirs: true });
  const v3 = openStore(dataPaths(dataDir).db);
  const g1 = 'toolreq:M-MAIN:g1:ask_owner:rq-upg';
  const cached = v3.kv.get<{ data: unknown }>(g1)!;
  expect(cached).toBeTruthy();
  v3.db.prepare('DELETE FROM kv WHERE key = ?').run(g1);
  v3.kv.set('toolreq:M-MAIN:ask_owner:rq-upg', { data: cached.data });
  for (const t of ['seat', 'seat_history', 'seat_handover', 'main_journal']) v3.db.exec(`DROP TABLE ${t}`);
  v3.db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
  const questions = v3.questions.list().length;
  v3.close();
  return { dataDir, questions };
}

describe('옮긴 DB의 메인 도구 중복 캐시 (seatCacheUpgrade)', () => {
  it('업그레이드 전에 처리한 request_id를 1세대가 다시 보내면 다시 처리하지 않는다 — 새 요청은 새 키로 쓴다', async () => {
    const { dataDir, questions } = await stage3Db();
    const h = await createHarness({ dataDir, noProject: true });
    open.push(h);
    expect(h.core.seat.view()).toMatchObject({ generation: 1, state: 'active' });
    // 옮김이 옛 키에 때를 적었다 (보관 기간이 지금부터)
    expect(typeof h.core.ctx.store.kv.get<{ at?: string }>('toolreq:M-MAIN:ask_owner:rq-upg')?.at).toBe('string');
    const again = await h.core.tools.handle(mainIdentity(1), 'ask_owner', { ...ASK, request_id: 'rq-upg' });
    expect({ duplicate: duplicate(again), questions: h.core.ctx.store.questions.list().length }).toEqual({ duplicate: true, questions });
    // 새 요청은 세대가 든 키로만 남는다
    expect((await h.core.tools.handle(mainIdentity(1), 'ask_owner', { ...ASK, request_id: 'rq-new' })).ok).toBe(true);
    expect(h.core.ctx.store.kv.get('toolreq:M-MAIN:g1:ask_owner:rq-new')).toBeTruthy();
    expect(h.core.ctx.store.kv.get('toolreq:M-MAIN:ask_owner:rq-new')).toBeNull();
    expect(h.core.ctx.store.questions.list()).toHaveLength(questions + 1);
  }, 120_000);

  it('보관 기간(7일)이 지난 옛 키는 보지 않고, 다른 세대는 옛 키를 보지 않는다', async () => {
    // 옮긴 뒤 8일이 지났는데 아직 지우지 않은 옛 캐시(정리는 시작 때와 6시간마다) — 1세대도 다시 처리한다
    const stale = await stage3Db();
    const h = await createHarness({ dataDir: stale.dataDir, noProject: true });
    open.push(h);
    const legacy = 'toolreq:M-MAIN:ask_owner:rq-upg';
    h.core.ctx.store.kv.set(legacy, { ...h.core.ctx.store.kv.get<{ data: unknown }>(legacy)!, at: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() });
    const r = await h.core.tools.handle(mainIdentity(1), 'ask_owner', { ...ASK, request_id: 'rq-upg' });
    expect({ duplicate: duplicate(r), questions: h.core.ctx.store.questions.list().length }).toEqual({ duplicate: false, questions: stale.questions + 1 });

    // 보관 기간 안의 옛 캐시라도 2세대(교체 뒤의 새 메인)는 세대가 다르므로 실제로 처리한다 (S4-4)
    const fresh = await stage3Db();
    const h2 = await createHarness({ dataDir: fresh.dataDir, noProject: true });
    open.push(h2);
    const codex: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
    await h2.core.seat.assign({ holder: { kind: 'launched', ai: codex }, by: 'operator', reason: '운영자 교체', force: true }).done;
    expect(h2.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
    const r2 = await h2.core.tools.handle(mainIdentity(2), 'ask_owner', { ...ASK, request_id: 'rq-upg' });
    expect({ duplicate: duplicate(r2), questions: h2.core.ctx.store.questions.list().length }).toEqual({ duplicate: false, questions: fresh.questions + 1 });
  }, 180_000);
});
