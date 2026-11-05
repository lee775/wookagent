/**
 * 처음 보유자 (SERVER_DESIGN 4.3·10.4 seatInitialHolder, 리드 결정 S4-12):
 * - 빈 자리(새 DB)는 서버면 운영자 설정 seat.initialHolder로, 없으면(데스크톱 포함) 운영 설정의 메인 AI(general.mainAgent)로 앉는다 — 바꾼 쪽은 server
 * - 이미 앉은 자리는 설정의 처음 보유자를 바꿔도 그대로다 (다시 시작해도, config reload로 다시 읽어도). 자리가 비었을 때만 reload의 처음 보유자가 앉힌다
 * - M-MAIN의 AI와 운영 설정의 메인 AI는 앉은 보유자를 따른다. 자리 정책(앉을 수 있는 보유자·마무리 기다림)도 서버 설정에서 온다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const startRow = (h: Harness) => h.core.ctx.store.seatHistory.list().map((r) => [r.generation, r.changedBy, r.startReason, r.endReason]);

describe('처음 보유자 (seatInitialHolder)', () => {
  it('새 DB의 빈 자리는 서버 설정의 처음 보유자로 앉고, 이미 앉은 자리는 다시 시작해도·다시 읽어도 그대로다', async () => {
    const first = await createHarness({ mode: 'server', noProject: true, seat: { initialHolder: 'launched:codex', holders: ['launched:claude', 'launched:codex'], drainMs: 30_000 } });
    open.push(first);
    expect(first.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { kind: 'launched', label: 'Codex CLI', ai: { kind: 'codex', model: null } } });
    expect(startRow(first)).toEqual([[1, 'server', '처음 보유자 — 운영자 설정 seat.initialHolder(launched:codex)', null]]);
    expect([first.core.ctx.store.members.require(MAIN_AGENT_ID).ai.kind, first.core.ctx.settings().general.mainAgent.kind]).toEqual(['codex', 'codex']);
    expect(first.core.seat.policy()).toEqual({ holders: ['launched:claude', 'launched:codex'], drainMs: 30_000 });
    expect(first.core.ctx.store.activity.search({ kinds: ['seat'], limit: 10 }).map((r) => [r.actor, r.text])).toContainEqual([
      'system',
      '메인 자리에 Codex CLI가 앉음 (세대 1, 서버) — 처음 보유자 — 운영자 설정 seat.initialHolder(launched:codex)',
    ]);
    open.splice(open.indexOf(first), 1);
    await first.close({ keepDirs: true });

    // 다시 시작 — 설정의 처음 보유자를 claude로 바꿔도 앉은 자리는 그대로
    const again = await createHarness({ mode: 'server', noProject: true, dataDir: first.dataDir, projectDir: first.projectDir, seat: { initialHolder: 'launched:claude', holders: null, drainMs: null } });
    open.push(again);
    expect(again.core.seat.view()).toMatchObject({ generation: 1, holder: { label: 'Codex CLI' } });
    expect(startRow(again)).toHaveLength(1);
    expect(again.core.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('codex');
    // config reload로 다시 읽어도 그대로 — 바꾼 것 없음
    expect(again.core.seat.applyOperatorConfig({ initialHolder: 'launched:claude', holders: null, drainMs: null }, 'server.json')).toEqual([]);
    expect(again.core.seat.view()).toMatchObject({ generation: 1, holder: { label: 'Codex CLI' } });

    // 자리가 비었으면 reload의 처음 보유자가 앉힌다
    const row = again.core.ctx.store.seat.get('main')!;
    again.core.ctx.store.seat.put({ ...row, state: 'vacant', holder: null, since: null });
    expect(again.core.seat.applyOperatorConfig({ initialHolder: 'launched:claude', holders: null, drainMs: null }, 'server.json')).toEqual([
      { item: 'seat.initialHolder', text: '빈 메인 자리에 처음 보유자 Claude CLI가 앉음' },
    ]);
    expect(again.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Claude CLI' } });
    expect(again.core.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
  });

  it('처음 보유자가 없으면 운영 설정의 메인 AI로 앉는다 — 데스크톱 새 DB', async () => {
    const h = await createHarness({ noProject: true });
    open.push(h);
    expect(h.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI', ai: h.core.ctx.settings().general.mainAgent } });
    expect(startRow(h)).toEqual([[1, 'server', '처음 보유자 — 운영 설정의 메인 AI(general.mainAgent)', null]]);
    expect(h.core.seat.policy()).toEqual({ holders: ['launched:claude', 'launched:codex', 'external:*'], drainMs: 120_000 });
  });
});
