/**
 * 메인 에이전트 작업 폴더 옮기기 (SERVER_DESIGN 3.7, 리드 결정 S5-20):
 * - 메인 대화 턴은 데이터 폴더 밖의 메인 작업 폴더에서 돈다. 그 폴더는 그 사용자만 쓰게 만들고 git 저장소로 시작한다. 예전 폴더(<dataDir>/main-agent)는 새로 만들지 않는다
 * - 옮기면 활동 기록 한 줄(예전 → 새 폴더, 다시 시작해도 한 번), 예전 폴더는 그대로 둔다. 다음 메인 턴은 '실행 위치 변경'으로 새 세션이 되어 인계 요약을 받는다
 * - 시작 때 확인: 데이터 폴더·등록된 프로젝트와 겹치면 서버는 시작하지 않고(BackendError), 데스크톱은 예전 폴더를 쓰며 host_exec는 cwd 없이 그 까닭으로 거부한다
 * - 프로젝트 등록은 메인 작업 폴더와 그 안·그 폴더를 품은 상위 폴더를 거부한다
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { settleMainWork } from '../../src/main/orchestrator/mainWork';
import { bootOrch, waitFor, type OrchEnv } from './orchHarness';
import { hostExec, liveMainTurn, MAIN_KEY } from './hostExecRig';
import { windowsAcl, windowsMe } from '../server/helpers';

let env: OrchEnv | null = null;
afterEach(async () => {
  env?.hold.clear();
  await env?.close();
  env = null;
});

const win = process.platform === 'win32';
const movedRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['system'], limit: 200 }).filter((r) => r.text.startsWith('메인 에이전트 작업 폴더를 옮겼습니다')).map((r) => r.text);
const mainSessions = (e: OrchEnv) => e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: MAIN_KEY });

/** 메인 턴 하나를 끝까지 돌린다 */
async function mainTurnOnce(e: OrchEnv, text: string): Promise<string> {
  const { proc, turnId } = await liveMainTurn(e, text);
  e.hold.clear();
  proc.finishOk();
  await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
  await e.idle();
  return turnId;
}

describe('메인 에이전트 작업 폴더 (mainWorkFolder)', () => {
  it('메인 대화 턴은 데이터 폴더 밖의 메인 작업 폴더에서 돈다 — 그 사용자만 쓰는 git 저장소, 예전 폴더는 만들지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const dir = e.mainWorkDir!;
    expect(e.core.mainWork).toEqual({ dir, problem: null });
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(e.ctx.paths.mainAgent)).toBe(false);
    if (win) expect(windowsAcl(dir)).toMatchObject({ protected: true, rules: [{ id: windowsMe(), inherited: false, rights: 'FullControl' }] });
    else expect(statSync(dir).mode & 0o777).toBe(0o700);
    const turnId = await mainTurnOnce(e, '상태 알려줘');
    expect(e.specs.find((s) => s.args[2] === turnId)!.cwd).toBe(dir);
    expect(mainSessions(e).map((s) => s.cwd)).toEqual([dir]);
  });

  it('옮기면 활동 기록 한 줄(예전 → 새 폴더)과 예전 폴더는 그대로 — 다음 메인 턴은 실행 위치 변경으로 새 세션이 되어 인계 요약을 받는다. 다시 시작해도 한 줄', async () => {
    const e = (env = await bootOrch());
    const legacy = e.ctx.paths.mainAgent;
    await mainTurnOnce(e, '첫 명령');
    const [first] = mainSessions(e);
    expect(first!.cwd).toBe(legacy);
    // 5단계 전의 설치를 새 작업 폴더로 시작한다 (마지막으로 쓴 폴더 기록도 없다)
    e.ctx.store.kv.set('mainWork.dir', null);
    const next = join(dirname(e.projectDir), 'ws', 'main');
    (e.ctx.deps as { mainWorkDir?: string }).mainWorkDir = next;
    settleMainWork(e.core);
    expect(e.core.mainWork).toEqual({ dir: next, problem: null });
    expect(movedRows(e)).toEqual([`메인 에이전트 작업 폴더를 옮겼습니다: ${legacy} → ${next} — 예전 폴더는 지우지 않고 그대로 둡니다. 메인 에이전트 세션은 다음 턴에 새 세션으로 이어 갑니다`]);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(next)).toBe(true);
    const turnId = await mainTurnOnce(e, '둘째 명령');
    const sessions = mainSessions(e);
    expect(sessions).toHaveLength(2);
    const second = sessions.find((s) => s.id !== first!.id)!;
    expect(second).toMatchObject({ cwd: next, previousSessionId: first!.id, replaceReason: '실행 위치 변경' });
    expect(e.ctx.store.sessions.get(first!.id)).toMatchObject({ replaceReason: '실행 위치 변경' });
    expect(second.handoverSummary).toContain(`이전 세션 ${first!.id}`);
    expect(e.launches.find((l) => l.turnId === turnId)!.message).toContain(`이전 세션 ${first!.id}`);
    // 다시 시작해도 같은 폴더면 남기지 않는다
    settleMainWork(e.core);
    expect(movedRows(e)).toHaveLength(1);
  });

  it('데스크톱: 데이터 폴더 안의 폴더를 받으면 예전 폴더를 쓰고 그 까닭을 남긴다 — host_exec는 cwd 없이 그 까닭으로 거부한다', async () => {
    const e = (env = await bootOrch({ workspace: (dataDir) => join(dataDir, 'ws', 'main') }));
    const legacy = e.ctx.paths.mainAgent;
    const problem = `메인 에이전트 작업 폴더(${join(e.dataDir, 'ws', 'main')})가 데이터 폴더(${e.dataDir})와 그 안입니다 — 데이터 폴더 밖의 다른 위치를 메인 에이전트 작업 폴더로 정하세요`;
    expect(e.core.mainWork).toEqual({ dir: legacy, problem });
    expect(e.ctx.store.activity.search({ kinds: ['system'], limit: 200 }).some((r) => r.level === 'warn' && r.text.startsWith(`메인 에이전트 작업 폴더(${join(e.dataDir, 'ws', 'main')})를 쓸 수 없어 예전 폴더(${legacy})를 씁니다 — ${problem}`))).toBe(true);
    const { turnId } = await liveMainTurn(e);
    const r = await hostExec(e, turnId, { command: 'echo hi' });
    expect(r).toEqual({ ok: false, code: 'forbidden', message: `메인 작업 폴더를 쓸 수 없어 기본 실행 위치가 없습니다 — ${problem}. 실행할 폴더를 cwd로 주세요` });
    expect(e.specs.find((s) => s.args[2] === turnId)!.cwd).toBe(legacy);
  });

  it('등록된 프로젝트와 겹치면 데스크톱은 예전 폴더를 쓰고, 서버는 시작하지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const inside = join(e.projectDir, 'tools');
    (e.ctx.deps as { mainWorkDir?: string }).mainWorkDir = inside;
    settleMainWork(e.core);
    expect(e.core.mainWork.dir).toBe(e.ctx.paths.mainAgent);
    expect(e.core.mainWork.problem).toBe(`메인 에이전트 작업 폴더(${inside})가 등록된 프로젝트(${e.projectId} 턴 회귀, ${e.projectDir})와 그 안입니다 — 프로젝트와 겹치지 않는 위치를 정하세요`);
    (e.ctx.deps as { mode?: string }).mode = 'server';
    expect(() => settleMainWork(e.core)).toThrow(`메인 에이전트 작업 폴더를 쓸 수 없어 시작하지 않았습니다 — 메인 에이전트 작업 폴더(${inside})가 등록된 프로젝트`);
    (e.ctx.deps as { mode?: string }).mode = 'desktop';
  });

  it('서버: 데이터 폴더와 겹치는 메인 작업 폴더로는 백엔드가 시작하지 않는다', async () => {
    await expect(bootOrch({ mode: 'server', workspace: (dataDir) => join(dataDir, 'main') })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/^메인 에이전트 작업 폴더를 쓸 수 없어 시작하지 않았습니다 — 메인 에이전트 작업 폴더\(.+\)가 데이터 폴더\(.+\)와 그 안입니다/),
    });
  });

  it('프로젝트 등록은 메인 작업 폴더·그 안·그 폴더를 품은 상위 폴더를 거부한다 — 옆 폴더는 된다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const dir = e.mainWorkDir!;
    const root = dirname(dir);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    for (const [path, mode, area] of [
      [dir, 'existing', '메인 에이전트 작업 폴더(앱이 관리하는 폴더)'],
      [join(dir, 'sub'), 'existing', '메인 에이전트 작업 폴더(앱이 관리하는 폴더)'],
      [join(dir, 'new-app'), 'new', '메인 에이전트 작업 폴더(앱이 관리하는 폴더)'],
      [root, 'existing', '메인 에이전트 작업 폴더를 품은 상위 폴더(메인 에이전트가 우회 권한으로 일하는 폴더가 저장소에 들어간다)'],
    ] as const) {
      await expect(e.internal('projects.create', { mode, path, name: '겹침' }), path).rejects.toMatchObject({ code: 'forbidden', message: `앱 금지 정책: ${area}는 프로젝트로 등록할 수 없습니다 — ${path}` });
    }
    // 메인 에이전트가 청해도 같다 — 앱 금지 정책 위반으로 대표에게 긴급 알림
    await expect(e.main('create_project', { mode: 'new', path: join(dir, 'x'), name: '겹침' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(e.ctx.store.notifications.list().some((n) => n.title === '앱 금지 정책 위반' && n.body.includes('메인 에이전트 작업 폴더'))).toBe(true);
    const sibling = await e.internal('projects.create', { mode: 'new', path: join(root, 'other-app'), name: '옆 폴더' });
    expect(sibling.path).toBe(join(root, 'other-app'));
  });
});
