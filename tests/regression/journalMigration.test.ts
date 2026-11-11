/**
 * 메인 일지 표의 DB 이전 (스키마 5판, 리드 결정 S4-6, S4b): 앞 판 DB를 열면 main_journal이 더해지고 판이 5가 된다. 있던 자료는 그대로다.
 * - 4판 DB(S4a — 자리·이력·꾸러미는 있고 일지 표가 없다): 자리·이력·저장된 꾸러미는 그대로이고, 그 뒤의 명령부터 일지에 쌓인다. 넘기며 남긴 말 칸이 없는 옛 꾸러미로도
 *   최신판(MEM-09)을 만든다
 * - 3판 DB(4단계 이전 — 자리 표도 없다): 운영 설정의 메인 AI로 1세대가 앉고, 그것이 일지의 첫 서버 기록이다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { createHarness, type Harness } from '../e2e/harness';

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const version = (h: Harness) => (h.core.ctx.store.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value;
const hasJournalTable = (h: Harness) => !!h.core.ctx.store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'main_journal'`).get();

/** 지금 판으로 만든 DB를 옛 판으로 되돌린다 */
function downgrade(dataDir: string, ver: 3 | 4): void {
  const s = openStore(dataPaths(dataDir).db);
  s.db.exec('DROP TABLE main_journal');
  if (ver === 3) for (const t of ['seat', 'seat_history', 'seat_handover']) s.db.exec(`DROP TABLE ${t}`);
  // 4판의 꾸러미에는 넘기며 남긴 말 칸이 없었다
  if (ver === 4) for (const p of s.seatHandovers.list()) s.seatHandovers.put({ ...p, note: undefined });
  s.db.exec(`UPDATE meta SET value = '${ver}' WHERE key = 'schema_version'`);
  s.close();
}

describe('메인 일지 표의 DB 이전 (스키마 5판)', () => {
  it('4판 DB를 열면 일지 표가 더해지고 지금 판(7판)이 된다 — 자리·이력·꾸러미는 그대로, 그 뒤의 명령부터 일지에 쌓인다', async () => {
    const old = await createHarness({ noProject: true });
    const { dataDir, projectDir } = old;
    await old.core.seat.assign({ holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } }, by: 'operator', reason: '4판 때의 교체', force: true }).done;
    const packetBefore = old.core.seat.handover(2)!;
    await old.close({ keepDirs: true });
    downgrade(dataDir, 4);

    const h = await createHarness({ dataDir, projectDir });
    open.push(h);
    expect([version(h), hasJournalTable(h)]).toEqual(['7', true]);
    expect(h.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(h.core.seat.history().map((r) => [r.generation, r.changedBy, r.hasHandover])).toEqual([
      [2, 'operator', true],
      [1, 'server', false],
    ]);
    expect(h.core.seat.handover(2)).toEqual(packetBefore);
    // 이전한 일지는 비어 있고(앉은 자리는 다시 앉히지 않는다), 그 뒤의 명령부터 쌓인다
    expect((await h.invoke('journal.list', {})).entries).toEqual([]);
    await h.invoke('command.send', { target: 'main', text: '이전 뒤 첫 명령' });
    const page = await h.invoke('journal.list', {});
    expect(page.entries.map((x) => [x.author, x.kind, x.generation, x.holderLabel, x.text])).toEqual([['server', 'command', 2, 'Codex CLI', '대표 명령 (직접 명령): 이전 뒤 첫 명령']]);
    // 넘기며 남긴 말 칸이 없는 옛 꾸러미로도 최신판을 만든다
    expect(h.core.handover.latest(2).text).toContain('[메인 자리 인계 꾸러미 — 세대 2,');
    await h.waitFor(() => h.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).some((t) => !!t.endedAt) && h.core.turns.count() === 0, { label: '메인 턴', timeoutMs: 60_000 });
  }, 120_000);

  it('3판 DB(4단계 이전)를 열면 자리와 일지 표가 더해지고 지금 판(7판)이 된다 — 1세대가 앉은 것이 일지의 첫 서버 기록이다', async () => {
    const old = await createHarness({ noProject: true });
    const { dataDir, projectDir } = old;
    await old.close({ keepDirs: true });
    downgrade(dataDir, 3);

    const h = await createHarness({ dataDir, projectDir });
    open.push(h);
    expect([version(h), hasJournalTable(h)]).toEqual(['7', true]);
    expect(h.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI' } });
    const entries = (await h.invoke('journal.list', {})).entries;
    expect(entries.map((x) => [x.author, x.kind, x.generation, x.text])).toEqual([
      ['server', 'seat', 1, '메인 자리에 Claude CLI가 앉음 (세대 1, 서버) — 4단계 이전 데이터에서 옮김 — 운영 설정의 메인 AI(general.mainAgent)'],
    ]);
  }, 120_000);
});
