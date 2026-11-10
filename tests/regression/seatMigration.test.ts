/**
 * 4단계 이전 DB를 연다 (스키마 4판, 리드 결정 S4-12): 3판 DB(메인 자리 표가 없고, M-MAIN의 AI를 운영 설정의 메인 AI가 정하던 때)를 열면
 * - 자리 표(seat·seat_history·seat_handover)가 더해지고 판 번호가 지금 판(5판 — S4b의 메인 일지 표까지)이 된다. 있던 자료(프로젝트·팀원·설정)는 그대로다
 * - 자리는 운영 설정의 메인 AI(general.mainAgent)로 1세대·active, 이력은 바꾼 쪽 server·끝난 까닭 없음
 * - 도구 중복 캐시에 남은 값에는 때(at)가 적혀 7일 보관이 그때부터 센다 (S4-4)
 * - 그 메인이 그대로 일한다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Settings } from '@shared/domain';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { createHarness, type Harness } from '../e2e/harness';

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const CODEX = { kind: 'codex', model: null, effortTier: 'normal', effortOverride: null } as const;

describe('4단계 이전 DB를 연다 (스키마 4판)', () => {
  it('3판 DB를 열면 자리 표가 더해지고, 운영 설정의 메인 AI로 1세대가 앉는다 — 있던 자료는 그대로, 도구 캐시에는 때가 적힌다', async () => {
    const old = await createHarness({ team: ['developer'] });
    const { dataDir, projectDir, projectId } = old;
    const dev = old.members.developer!;
    await old.close({ keepDirs: true });

    // 3판 DB로 되돌린다: 4판의 표(와 5판의 메인 일지 표, S4b)를 지우고, 그때처럼 운영 설정의 메인 AI가 M-MAIN의 AI다(codex). 그때의 도구 캐시에는 때가 없다
    const v3 = openStore(dataPaths(dataDir).db);
    for (const t of ['seat', 'seat_history', 'seat_handover', 'main_journal']) v3.db.exec(`DROP TABLE ${t}`);
    v3.db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    const settings = v3.kv.get<Settings>('settings')!;
    v3.kv.set('settings', { ...settings, general: { ...settings.general, mainAgent: CODEX } });
    v3.members.put({ ...v3.members.require(MAIN_AGENT_ID), ai: { ...CODEX } });
    v3.kv.set('toolreq:M-MAIN:ask_owner:rq-before', { data: { questionId: 'Q-0001' } });
    v3.kv.set('toolreq:M-0002:complete_step:rq-step', { data: { done: true } });
    v3.close();

    const t0 = new Date().toISOString();
    const h = await createHarness({ dataDir, projectDir });
    open.push(h);
    const ctx = h.core.ctx;
    // 지금 판은 6판이다 (S4b의 메인 일지 표, S6b의 화면 조작 기록 표까지)
    expect((ctx.store.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('6');
    expect(h.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { kind: 'launched', label: 'Codex CLI', ai: CODEX }, pendingHolder: null, unresponsiveSince: null, vision: 'unknown' });
    expect(ctx.store.seatHistory.list().map((r) => [r.generation, r.changedBy, r.endedAt, r.endReason, r.startReason])).toEqual([
      [1, 'server', null, null, '4단계 이전 데이터에서 옮김 — 운영 설정의 메인 AI(general.mainAgent)'],
    ]);
    expect(h.core.seat.history()).toEqual([
      { generation: 1, holder: { kind: 'launched', ai: CODEX, label: 'Codex CLI' }, startedAt: expect.any(String), endedAt: null, endReason: null, changedBy: 'server', hasHandover: false },
    ]);
    // 첫 세대의 인계 꾸러미는 없다
    expect(h.core.seat.handover()).toBeNull();
    // 있던 자료는 그대로 — 운영 설정의 메인 AI를 자리가 받았다
    expect([h.projectId, h.members.developer, ctx.store.members.require(dev).deletedAt]).toEqual([projectId, dev, null]);
    expect([ctx.store.members.require(MAIN_AGENT_ID).ai, ctx.settings().general.mainAgent]).toEqual([CODEX, CODEX]);
    // 도구 캐시에 때가 적혔다 (옮긴 때부터 7일)
    for (const key of ['toolreq:M-MAIN:ask_owner:rq-before', 'toolreq:M-0002:complete_step:rq-step']) {
      const v = ctx.store.kv.get<{ data: unknown; at: string }>(key)!;
      expect([v.data !== undefined, v.at >= t0.slice(0, 10)]).toEqual([true, true]);
    }
    // 그 메인이 그대로 일한다
    expect(h.core.seat.runsMain()).toBe(true);
    await h.invoke('command.send', { target: 'main', text: '안녕하세요' });
    await h.waitFor(() => ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).some((t) => !!t.endedAt), { label: '메인 턴', timeoutMs: 60_000 });
    expect(ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).map((t) => t.aiKind)).toEqual(['codex']);
  }, 120_000);
});
