/**
 * 인수 시험 도구 bootApp은 화면 도우미가 없는 실행에서도 메인 턴이 모두 모의 실행이었는지 본다 (리드 결정 S6-19 · S7-20 TI-7).
 * 예전에는 화면 도우미를 붙인 실행만 확인해, 모의 실행 설정을 잃은 다른 실행(예: AC-20의 서버 모드)에서 실제 CLI로 뜬 메인 턴을 놓쳤다 — 그러면 대표 계정의
 * 사용량이 들고, 모의 에이전트의 감싸기로만 넣는 값의 누출 확인은 헛돈다. 실제 CLI는 띄우지 않는다: 모의 메인 턴을 한 번 돌린 뒤 그런 턴의 기록만 넣어 본다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { bootApp, waitFor, type App } from '../acceptance/security-helpers';

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});

/** 화면 도우미 없이 띄우고 메인에 명령 하나를 보내 모의 메인 턴을 한 번 돌린다 */
async function bootWithMainTurn(o: Parameters<typeof bootApp>[0] = {}): Promise<App> {
  const app = await bootApp(o);
  apps.push(app);
  await app.invoke('command.send', { target: 'main', text: '현황 알려 줘' } as never);
  await waitFor(() => app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).some((t) => !!t.endedAt) && app.core.turns.count() === 0, '메인 턴 종료', 120_000);
  return app;
}

describe('bootApp: 화면 도우미가 없는 실행도 메인 턴이 모의였는지 본다 (S7-20 TI-7)', () => {
  it('모의 메인 턴만 돈 실행은 확인을 통과하고, 모의 실행이 아닌 메인 턴이 하나라도 있으면 close()가 던진다', async () => {
    const app = await bootWithMainTurn();
    const turns = app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect([turns.length > 0 && turns.every((t) => t.mock), app.launches.some((l) => l.memberId === MAIN_AGENT_ID), app.mainTurnProblem()]).toEqual([true, true, null]);
    // 이 실행에 모의 실행이 아닌 메인 턴이 떴던 것처럼 (기록만 — CLI는 띄우지 않는다)
    app.ctx.store.turns.insert({ ...turns[0]!, id: `${turns[0]!.id}9` as (typeof turns)[number]['id'], mock: false });
    expect(app.mainTurnProblem() ?? '(확인이 통과함)').toContain('모의 실행이 아닌 메인 턴이 떴습니다');
    apps.splice(apps.indexOf(app), 1);
    await expect(app.close()).rejects.toThrow('모의 실행이 아닌 메인 턴이 떴습니다');
  }, 180_000);

  it('모의로 적혔지만 모의 어댑터를 거치지 않고 프로세스가 뜬 메인 턴이 있어도 stop()이 던진다', async () => {
    const app = await bootWithMainTurn();
    const turns = app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect(turns.length > 0 && turns.every((t) => t.mock && t.process.pid !== null)).toBe(true);
    app.ctx.store.turns.insert({ ...turns[0]!, id: `${turns[0]!.id}8` as (typeof turns)[number]['id'], mock: true });
    await expect(app.stop()).rejects.toThrow('모의 실행이 아닌 메인 턴이 떴습니다');
  }, 180_000);
});
