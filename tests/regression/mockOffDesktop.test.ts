/**
 * 1단계 전에 켜 둔 모의 실행을 데스크톱 운영자가 끌 수 있다 (리드 결정 23, 10-30 — owner-surface 2차 재리뷰 M1, 프로브 zz-s1fix2-os-m1-mock-lockout).
 * 1단계 전 설정 화면의 '개발자 옵션'은 설치된 앱에서도 보였고 체크박스 하나로 메인 에이전트 모의 모드(developer.mainAgentMock)와 프로젝트 모의 실행
 * (projects.setMock)을 켰다. 1단계 뒤에는 그 값을 끌 길이 없어 메인과 그 팀이 계속 모의 에이전트로 돌았다 — 대표 명령이 실제로 처리되지 않는다.
 * - 데스크톱 운영자(그 PC의 사람)는 모의 실행을 끄기만 한다: settings.update {developer:{mainAgentMock:false}}, projects.setMock(id, {enabled:false}).
 *   값까지 본다 — 켜기·다른 값·다른 개발자 옵션이 섞이면 forbidden이다
 * - 켜기는 데스크톱·원격 길과 메인 에이전트 모두 거부한다. 원격 길과 메인은 끄기도 거부한다
 * - 설치된 앱에서 시작할 때 모의 실행이 켜져 있으면 정보 알림 하나(key mock-on)로 설치 설정에서 끌 수 있다고 알린다. 같은 상태로 다시 시작하면 다시
 *   알리지 않는다(멱등)
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createOwnerInvoke, ownerRefusal } from '../../src/main/backend/ownerGate';
import { bootRestartable, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';
import { bootApp, removeDirs, tempDir, type App } from '../acceptance/security-helpers';

let env: RestartableEnv | null = null;
const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await env?.close();
  env = null;
  for (const a of apps.splice(0)) await a.close();
  await removeDirs(dirs.splice(0));
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { code?: string }) => err.code ?? 'error',
  );

const mockState = (e: { ctx: RestartableEnv['ctx'] }, projectId: string) => ({
  main: e.ctx.settings().developer.mainAgentMock,
  project: e.ctx.store.projects.require(projectId).mock.enabled,
});

describe('모의 실행 끄기 (리드 결정 23)', () => {
  it('(M1) 켜 둔 모의 실행을 데스크톱 운영자가 끄면 메인 턴이 실제 CLI 길로 뜬다 — 켜기·다른 값은 데스크톱·원격·메인 모두 거부하고 값이 그대로다', async () => {
    env = await bootRestartable({ mock: false });
    let e = env;
    // 1단계 전 대표가 '개발자 옵션'에서 켠 값 — 지금은 내부 API로 재현
    await e.internal('settings.update', { developer: { mainAgentMock: true } });
    await e.internal('projects.setMock', e.projectId, { enabled: true, speed: 1, defaultScenario: 'normal' });
    const pid = e.projectId;
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]!.seq;
    const invoke = e.invoke as unknown as (m: string, ...a: unknown[]) => Promise<unknown>;

    // 데스크톱: 켜기, 다른 값(문자열 'false'·null), 다른 개발자 옵션이 섞인 요청은 거부한다 — 값까지 본다
    for (const patch of [{ developer: { mainAgentMock: true } }, { developer: { mainAgentMock: 'false' } }, { developer: { mainAgentMock: null } }, { developer: { mainAgentMock: false, mockSpeed: 5 } }, { developer: { mockSpeed: 5 } }, { developer: false }]) {
      expect(await codeOf(invoke('settings.update', patch)), JSON.stringify(patch)).toBe('forbidden');
    }
    for (const args of [[pid, { enabled: true }], [pid, { enabled: 'false' }], [pid, { enabled: false, speed: 1 }], [pid, { enabled: false, defaultScenario: 'normal' }], [pid, {}], [pid], [{ id: pid }, { enabled: false }], [pid, { enabled: false }, 'x']]) {
      expect(await codeOf(invoke('projects.setMock', ...args)), JSON.stringify(args)).toBe('forbidden');
    }
    // 켜기를 거부할 때는 메인에게 말하라고 하지 않는다 (메인도 켜지 못한다)
    const onRefusal = await invoke('settings.update', { developer: { mainAgentMock: true } }).catch((x: Error) => x.message);
    expect(onRefusal).toContain('끄기만 할 수 있습니다');
    expect(onRefusal).not.toContain('메인 에이전트에게 말하세요');
    // 원격 길: 끄기도 받지 않는다 (운영자 로컬 메서드가 없다)
    const remote = createOwnerInvoke(e.core, 'remote') as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    expect(ownerRefusal('settings.update', [{ developer: { mainAgentMock: false } }], 'remote')).toBeTruthy();
    expect(ownerRefusal('projects.setMock', [pid, { enabled: false }], 'remote')).toBeTruthy();
    expect(await codeOf(remote('settings.update', [{ developer: { mainAgentMock: false } }]))).toBe('forbidden');
    expect(await codeOf(remote('projects.setMock', [pid, { enabled: false }]))).toBe('forbidden');
    // 메인 에이전트: 개발자 옵션은 운영자 몫 — 끄기도 켜기도 거부 (리드 결정 1)
    expect(await codeOf(e.main('update_settings', { patch: { developer: { mainAgentMock: false } } }))).toBe('forbidden');
    expect(await codeOf(e.main('update_settings', { patch: { developer: { mainAgentMock: true } } }))).toBe('forbidden');
    expect(mockState(e, pid)).toEqual({ main: true, project: true });
    // 거부는 대표 기록에 남는다 (인자 없이)
    const refusedRows = e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부', limit: 100 }).filter((r) => r.seq > seq0);
    expect(refusedRows.filter((r) => r.text === '대표 권한 밖 요청 거부: settings.update').length).toBeGreaterThanOrEqual(6);
    expect(refusedRows.filter((r) => r.text === '대표 권한 밖 요청 거부: projects.setMock').length).toBeGreaterThanOrEqual(8);

    // 데스크톱 운영자가 끈다
    expect(await codeOf(e.invoke('settings.update', { developer: { mainAgentMock: false } }))).toBe('ok');
    expect(await codeOf(e.invoke('projects.setMock', pid, { enabled: false }))).toBe('ok');
    expect(mockState(e, pid)).toEqual({ main: false, project: false });
    expect(e.ctx.store.activity.search({ text: `모의 에이전트 모드 끔 (${pid})`, limit: 5 }).filter((r) => r.seq > seq0).map((r) => r.actor)).toEqual(['owner']);
    // 끈 뒤에도 다시 켜기는 거부한다
    expect(await codeOf(e.invoke('settings.update', { developer: { mainAgentMock: true } }))).toBe('forbidden');
    expect(await codeOf(e.invoke('projects.setMock', pid, { enabled: true }))).toBe('forbidden');

    // 재시작 뒤에도 꺼져 있고, 대표 명령으로 뜬 메인 턴은 모의 실행이 아니다
    env = await e.stopGracefully();
    e = env;
    expect(mockState(e, pid)).toEqual({ main: false, project: false });
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '진짜로 일해 줘' });
    e.tick();
    await waitUntil(() => e.launchesOf('main:general').length >= 1, '메인 턴 시작');
    expect(e.launchesOf('main:general').at(-1)!.mock).toBe(false);
    expect(e.launchesOf('main:general').at(-1)!.memberId).toBe(MAIN_AGENT_ID);
    e.liveProc('main:general')?.finishOk();
    await sleep(50);
  });

  it('설치된 앱에서 모의 실행이 켜져 있으면 시작 때 정보 알림 하나(mock-on)로 설치 설정에서 끌 수 있다고 알린다 — 같은 상태로 다시 시작하면 다시 알리지 않는다', async () => {
    const dataDir = tempDir('mockon');
    dirs.push(dataDir);
    const projRoot = tempDir('mockon-proj');
    dirs.push(projRoot);
    const boot = async (isPackaged: boolean): Promise<App> => {
      const a = await bootApp({ dataDir, isPackaged, stopScheduler: true, runnerMode: 'taskkill', devLogin: false });
      apps.push(a);
      return a;
    };
    const notices = (a: App) => a.ctx.store.notifications.list({ ref1: 'mock-on' });
    const rows = (a: App) => a.ctx.store.activity.search({ text: '시작 때 확인: 모의 실행이 켜져 있음', limit: 50 });
    const stop = async (a: App) => {
      await a.stop();
      apps.splice(apps.indexOf(a), 1);
    };

    // 개발 실행: 모의 실행이 켜진 채 시작해도 알리지 않는다 (개발·시험에서는 켜 두는 것이 정상)
    const dev = await boot(false);
    await dev.internal('settings.update', { developer: { mainAgentMock: true } });
    const p = await dev.internal('projects.create', { mode: 'new', path: join(projRoot, 'p1'), name: '모의 프로젝트' });
    await dev.internal('projects.setMock', p.id, { enabled: true, speed: 1, defaultScenario: 'normal' });
    await stop(dev);
    const dev2 = await boot(false);
    expect(mockState(dev2, p.id)).toEqual({ main: true, project: true });
    expect(notices(dev2)).toEqual([]);
    expect(rows(dev2)).toEqual([]);
    await stop(dev2);

    // 설치된 앱으로 시작: 알림 하나와 기록 한 줄
    const pkg1 = await boot(true);
    expect(notices(pkg1)).toHaveLength(1);
    expect(notices(pkg1)[0]).toMatchObject({ level: 'info', title: '모의 실행이 켜져 있음', link: { tab: 'settings', section: 'account' }, readAt: null });
    expect(notices(pkg1)[0]!.body).toContain('메인 에이전트');
    expect(notices(pkg1)[0]!.body).toContain(`프로젝트 모의 프로젝트(${p.id})`);
    expect(notices(pkg1)[0]!.body).toContain('설치 설정에서 끌 수 있습니다');
    expect(rows(pkg1)).toHaveLength(1);
    const first = notices(pkg1)[0]!;
    await stop(pkg1);

    // 같은 상태로 다시 시작: 그대로 (읽음으로 둔 뒤에도)
    const pkg2 = await boot(true);
    expect(notices(pkg2)).toEqual([first]);
    pkg2.ctx.store.notifications.put({ ...first, readAt: pkg2.ctx.now() });
    await stop(pkg2);
    const pkg3 = await boot(true);
    expect(notices(pkg3)).toHaveLength(1);
    expect(rows(pkg3)).toHaveLength(1);

    // 모두 끄고 다시 시작하면 알리지 않고, 다시 켜면(켜진 대상이 바뀜) 새로 알린다
    await pkg3.internal('settings.update', { developer: { mainAgentMock: false } });
    await pkg3.internal('projects.setMock', p.id, { enabled: false });
    await stop(pkg3);
    const pkg4 = await boot(true);
    expect(notices(pkg4)).toHaveLength(1);
    await pkg4.internal('settings.update', { developer: { mainAgentMock: true } });
    await stop(pkg4);
    const pkg5 = await boot(true);
    const after = notices(pkg5).filter((n) => n.readAt === null);
    expect(after).toHaveLength(1);
    expect(after[0]!.body).toContain('메인 에이전트');
    expect(after[0]!.body).not.toContain('모의 프로젝트');
    expect(rows(pkg5)).toHaveLength(2);
  });
});
