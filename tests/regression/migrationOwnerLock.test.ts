/**
 * v0.6 데이터 이전 — 대표 고정 없애기 (SERVER_DESIGN 2.7·10.1 'DB 이전: 잠금 값은 지운다', migrations.ts).
 * 예전 DB에 남은 aiLockedByOwner(팀원)와 team.mainAgentDecidesAi(운영 설정)는 시작 때 지운다. 누가 정했는지(aiDecision의 '대표가 정함')는 이력으로 둔다.
 * 다시 시작해도(중간에 꺼져도) 같은 결과이고 이전 기록은 한 번만 남는다. 지운 뒤에는 예전에 대표가 고정한 팀원의 AI도 메인 에이전트가 정한다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Member, Settings } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { PRODUCER_SELF_REVIEW_LINE } from '../../src/main/orchestrator/defaults';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

type LegacyMember = Member & { aiLockedByOwner?: boolean };
const migrationRows = (e: RestartableEnv) => e.ctx.store.activity.search({ text: '데이터 이전 (v0.6 권한 모델)', limit: 50 });

describe('대표 고정 값 지우기 (v0.6 데이터 이전)', () => {
  it('예전 DB의 aiLockedByOwner·team.mainAgentDecidesAi는 시작 때 지워지고 이력은 남으며, 다시 시작해도 같은 결과다 — 그 뒤에는 메인 에이전트가 AI를 정한다', async () => {
    let e = (env = await bootRestartable());
    // 예전 앱이 남긴 값: 대표가 개발자 AI를 고정했고, 운영 설정에서 메인 에이전트 AI 결정을 껐다
    const dev = e.ctx.store.members.require(e.devId);
    const decided = { by: OWNER, reason: '대표 지정', at: e.ctx.now() };
    e.ctx.store.members.put({ ...dev, ai: { ...dev.ai, effortTier: 'low' }, aiDecision: decided, aiLockedByOwner: true } as LegacyMember);
    const main = e.ctx.store.members.require(MAIN_AGENT_ID);
    e.ctx.store.members.put({ ...main, aiLockedByOwner: true } as LegacyMember);
    const raw = e.ctx.store.kv.get<Settings>('settings')!;
    e.ctx.store.kv.set('settings', { ...raw, team: { ...raw.team, mainAgentDecidesAi: false } });
    expect(migrationRows(e)).toEqual([]);

    // 전원이 꺼졌다 켜진다 → 시작 때 이전
    e.crash();
    e = env = await e.reboot();
    const after = e.ctx.store.members.require(e.devId) as LegacyMember;
    expect(Object.hasOwn(after, 'aiLockedByOwner')).toBe(false);
    expect(Object.hasOwn(e.ctx.store.members.require(MAIN_AGENT_ID), 'aiLockedByOwner')).toBe(false);
    expect(after.aiDecision).toEqual(decided); // 이력은 그대로
    expect(after.ai.effortTier).toBe('low');
    expect(Object.hasOwn(e.ctx.store.kv.get<Settings>('settings')!.team, 'mainAgentDecidesAi')).toBe(false);
    expect(Object.hasOwn(e.ctx.settings().team, 'mainAgentDecidesAi')).toBe(false);
    const rows = migrationRows(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('대표 AI 고정 값 2건 지움');
    expect(rows[0]!.text).toContain('team.mainAgentDecidesAi 지움');

    // 다시 시작해도 같은 결과 — 이전 기록은 늘지 않는다
    e = env = await e.stopGracefully();
    expect(migrationRows(e)).toHaveLength(1);
    expect(Object.hasOwn(e.ctx.store.members.require(e.devId), 'aiLockedByOwner')).toBe(false);
    expect(e.ctx.store.members.require(e.devId).aiDecision).toEqual(decided);

    // 고정이 없으니 메인 에이전트가 그 팀원의 AI를 정한다
    const r = await e.main('set_member_ai', { member_id: e.devId, model: 'gpt-6-sol', effort_tier: 'high', reason: '어려운 구현' });
    expect(r).toMatchObject({ memberId: e.devId });
    expect(e.ctx.store.members.require(e.devId)).toMatchObject({ ai: { effortTier: 'high' }, aiDecision: { by: MAIN_AGENT_ID, reason: '어려운 구현' } });
    // 화면에도 대표 고정 표시가 없다 (예전 결정은 '대표가 정함' 이력으로만)
    expect(e.core.views.memberView(e.ctx.store.members.require(e.devId))).not.toHaveProperty('aiLockedByOwner');
  });

  it('예전 DB의 프로듀서 기본 지침에 남은 "대표가 검수한다" 문장은 시작 때 메인 에이전트 검수로 고친다 — 고친 지침은 건드리지 않고, 다시 시작해도 같은 결과다', async () => {
    let e = (env = await bootRestartable());
    // 기본 역할은 빈 DB에만 넣는다 — 예전 앱이 넣은 프로듀서 지침에는 대표 검수 문장이 있다
    const producer = e.ctx.store.roles.require('producer');
    expect(producer.instructions).toContain(PRODUCER_SELF_REVIEW_LINE);
    e.ctx.store.roles.put({ ...producer, instructions: producer.instructions.replace(PRODUCER_SELF_REVIEW_LINE, '네가 직접 한 작업은 다른 팀원이나 대표가 검수한다.') });

    e.crash();
    e = env = await e.reboot();
    expect(e.ctx.store.roles.require('producer').instructions).toBe(producer.instructions);
    expect(e.ctx.store.roles.require('producer').instructions).not.toContain('대표가 검수');
    expect(migrationRows(e).map((r) => r.text)).toEqual([expect.stringContaining('프로듀서 기본 지침의 대표 검수 문장 고침')]);

    // 다시 시작해도 이전 기록은 늘지 않는다
    e = env = await e.stopGracefully();
    expect(migrationRows(e)).toHaveLength(1);
    // 메인 에이전트가 고친 지침(옛 문장이 없음)은 그대로 둔다
    const custom = '너는 이 프로젝트의 프로듀서다. 검수자는 늘 QA로 정한다.';
    e.ctx.store.roles.put({ ...e.ctx.store.roles.require('producer'), instructions: custom });
    e = env = await e.stopGracefully();
    expect(e.ctx.store.roles.require('producer').instructions).toBe(custom);
    expect(migrationRows(e)).toHaveLength(1);
  });
});
