import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { WookBridge } from '../../../../shared/ipc';
import { Home } from '../../screens/Home';
import { Studio } from '../../screens/Studio';
import { Simulation } from '../../screens/Simulation';
import { Office } from '../../studio/Office';

let bridge: WookBridge;
beforeAll(async () => {
  vi.stubGlobal('window', { wook: {}, location: { search: '' } });
  bridge = (await import('./index')).fakeBridge;
});

describe('브라우저 가짜 브리지의 사용자 흐름', () => {
  it('로그인, 지시, 보고서 피드백, 긴급 정지 해제가 이어진다', async () => {
    const first = await bridge.invoke('auth.getState');
    expect(first.loggedIn).toBe(false);
    expect(first.devLoginAllowed).toBe(true);
    await bridge.invoke('auth.devLogin');
    const signedIn = await bridge.invoke('snapshot.get');
    expect(signedIn.auth.loggedIn).toBe(true);
    expect(signedIn.running.total).toBe(5);
    expect(signedIn.running.general).toBe(3);
    expect(signedIn.running.management).toBe(2);

    const versions: number[] = [];
    const unsubscribe = bridge.subscribe('snapshot', (value) => versions.push(value.version));
    const response = await bridge.invoke('command.send', { target: 'P-0001', text: '장소 카드를 개선해 주세요.' });
    expect((await bridge.invoke('command.history', 'P-0001', {})).some((item) => item.directiveId === response.conversationId)).toBe(true);
    expect((await bridge.invoke('directives.get', response.conversationId)).directive.state).toBe('received');

    await bridge.invoke('reports.requestChanges', 'R-0001', {
      overall: '버튼 문구를 다듬어 주세요.',
      anchored: [{ quote: '기록 저장', comment: '좀 더 분명하게' }],
    });
    expect((await bridge.invoke('reports.get', 'R-0001')).status).toBe('changes_requested');
    expect((await bridge.invoke('reports.get', 'R-0001')).canApprove).toBe(true);
    expect((await bridge.invoke('directives.get', 'D-0001')).directive.round).toBe(2);
    await bridge.invoke('reports.approve', 'R-0001', '이 결과로 확정합니다.');
    expect((await bridge.invoke('directives.get', 'D-0001')).directive.state).toBe('closed');

    const summary = await bridge.invoke('stop.emergency');
    expect(summary.completed).toBe(true);
    expect(summary.heldTasks.length).toBeGreaterThan(0);
    expect((await bridge.invoke('snapshot.get')).stop.global.active).toBe(true);
    await bridge.invoke('stop.release');
    const held = (await bridge.invoke('snapshot.get')).tasks.filter((task) => task.state === 'on_hold');
    expect(held.length).toBeGreaterThan(0);
    expect(held.every(task => task.state === 'on_hold')).toBe(true);
    expect(versions.length).toBeGreaterThanOrEqual(4);
    unsubscribe();
  });
  it('전체 현황, 스튜디오, 시뮬레이션 화면을 실제 데이터로 렌더링한다', async () => {
    const snapshot = await bridge.invoke('snapshot.get');
    const noop = () => undefined;
    const home = renderToString(
      createElement(Home, { snapshot, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }),
    );
    const studio = renderToString(
      createElement(Studio, {
        snapshot,
        project: snapshot.projects[0],
        back: noop,
        openMember: noop,
        openTask: noop,
        openDirective: noop,
        openReport: noop,
      }),
    );
    const simulation = renderToString(createElement(Simulation, { projects: snapshot.projects }));
    expect(home).toContain('동네 산책 기록장');
    expect(studio).toContain('office-scene');
    expect(studio).toContain('프로듀서');
    expect(simulation).toContain('2차 개발 예정');
  });
  it('1, 4, 7, 12명 오피스를 배치하고 실행 슬롯 상한을 지킨다', async () => {
    const snapshot = await bridge.invoke('snapshot.get');
    const members = snapshot.members.filter((member) => member.projectId === 'P-0003');
    expect(members).toHaveLength(12);
    for (const count of [1, 4, 7, 12]) {
      const markup = renderToString(createElement(Office, { members: members.slice(0, count), onMember: () => undefined }));
      expect(markup.match(/팀원 상세 열기/g) ?? []).toHaveLength(count);
      expect(markup.match(/class="office-person-label"/g) ?? []).toHaveLength(count);
      if (count > 1) expect(markup.indexOf(members[0].name)).toBeLessThan(markup.indexOf(members[1].name));
    }
    expect(snapshot.running.total).toBeLessThanOrEqual(snapshot.running.cap);
    expect(snapshot.running.general).toBeLessThanOrEqual(snapshot.running.generalCap);
    expect(snapshot.running.total).toBe(snapshot.running.general + snapshot.running.management);
    expect(snapshot.running.cap).toBe(5);
    expect(snapshot.running.generalCap).toBe(4);
  });
  it('새 설정 계약을 fake 브리지에 저장하고 다시 읽는다', async () => {
    const info = await bridge.invoke('system.info');
    expect(info.dataDir).toBeTruthy();
    expect(info.processRunner.mode).toBe('jobobject');
    await bridge.invoke('settings.update', { general: { backup: { enabled: false }, launchAtLogin: true, mainAgent: { kind: 'codex' } }, logs: { retentionDays: 120 }, policy: { emergencyShortcut: 'Ctrl+Shift+F10' }, account: { authMode: { codex: 'api_key' } }, cli: { codexPath: 'C:/codex.cmd' } });
    const updated = await bridge.invoke('settings.get');
    expect(updated.general.backup.enabled).toBe(false);
    expect(updated.general.backup.keep).toBe(7);
    expect(updated.account.authMode.claude).toBe('subscription');
    expect(updated.general.launchAtLogin).toBe(true);
    expect(updated.general.mainAgent.kind).toBe('codex');
    expect(updated.account.authMode.codex).toBe('api_key');
    expect(updated.logs.retentionDays).toBe(120);
    await expect(bridge.invoke('settings.update', { account: { googleClientId: 'mixed' }, execution: { maxConcurrent: 2 } })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await bridge.invoke('settings.get')).account.googleClientId).not.toBe('mixed');
  });
});
