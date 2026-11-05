/**
 * 로그아웃 뒤 화면 푸시 (security:SEC-F2, AUTH-04: 로그아웃하면 작업은 계속되고 화면 접근만 막힌다).
 * invoke는 로그인 검사를 하지만 푸시(onTopic)는 하지 않아, 로그아웃 뒤에도 전체 스냅샷·알림 본문이 창으로 갔고
 * 로그인 화면 위에 질문 본문 토스트가 떴다. OS 알림에도 본문이 그대로 나갔다.
 * 실제 오케스트레이터 Backend(onTopic)로 확인한다 — 껍데기(shell/ipc.ts forwardTopics)는 이 주제들을 그대로 창에 보낸다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSnapshot, NotificationView } from '@shared/views';
import type { WookTopics } from '@shared/ipc';
import type { ShellServices } from '../../src/main/backend/types';
import { LOCKED_TOAST_BODY } from '../../src/main/orchestrator/context';
import type { OrchEnv } from './orchHarness';
import { bootOrch, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('로그아웃 중에는 업무 내용을 화면·바탕화면으로 보내지 않는다 (SEC-F2, AUTH-04)', () => {
  it('스냅샷은 로그인 화면 신호만, 알림·CLI 이벤트는 보내지 않고 DB에 남겨 로그인 뒤 보인다. OS 알림은 본문을 가린다', async () => {
    env = await bootOrch();
    const e = env;
    const toasts: { level: string; title: string; body: string }[] = [];
    const shell: ShellServices = {
      openExternal: async () => undefined,
      openPath: async () => undefined,
      pickFiles: async () => [],
      showOsNotification: (n) => toasts.push({ level: n.level, title: n.title, body: n.body }),
      focusWindow: () => undefined,
    };
    e.ctx.deps.shell = shell;
    const snaps: AppSnapshot[] = [];
    const notes: NotificationView[] = [];
    const cli: WookTopics['cliEvents'][] = [];
    const navs: WookTopics['navigate'][] = [];
    const offs = [
      e.orch.backend.onTopic('snapshot', (s) => snaps.push(s)),
      e.orch.backend.onTopic('notification', (n) => notes.push(n)),
      e.orch.backend.onTopic('cliEvents', (c) => cli.push(c)),
      e.orch.backend.onTopic('navigate', (n) => navs.push(n)),
    ];
    try {
      // 로그인 중: 그대로 간다 (대조)
      e.ctx.notify({ level: 'normal', title: '보고서 도착', body: 'D-0001 결제 리뉴얼 보고서' });
      expect(notes.at(-1)?.body).toBe('D-0001 결제 리뉴얼 보고서');
      expect(toasts.at(-1)?.body).toBe('D-0001 결제 리뉴얼 보고서');

      await e.invoke('auth.logout');
      await waitFor(() => snaps.length > 0 && !snaps.at(-1)!.auth.loggedIn, '로그아웃 스냅샷');
      const locked = snaps.at(-1)!;
      expect(locked.auth).toMatchObject({ loggedIn: false, owner: null });
      expect(locked).toMatchObject({ projects: [], members: [], directives: [], tasks: [], ownerTodos: [], recentActivity: [], roles: [], notifications: { unread: 0, urgentUnread: 0 } });
      expect(locked.stop).toMatchObject({ pausedProjects: [], pausedMembers: [], lastEmergency: null });
      expect(typeof locked.trayStatus).toBe('string');
      await expect(e.invoke('snapshot.get')).rejects.toMatchObject({ code: 'unauthorized' });

      // 작업은 계속된다 (AUTH-04): 질문 알림이 생겨도 화면·바탕화면에는 내용이 가지 않는다
      const before = notes.length;
      e.ctx.notify({ level: 'urgent', title: '메인 에이전트 질문', body: '대표님, 결제 서버 주소를 알려 주세요', link: { tab: 'projects', projectId: e.projectId } });
      e.ctx.bus.emit('cliEvents', { memberId: e.devId, turnId: 'TN-x', events: [] });
      expect(notes.length).toBe(before);
      expect(cli).toEqual([]);
      expect(toasts.at(-1)).toEqual({ level: 'urgent', title: '메인 에이전트 질문', body: LOCKED_TOAST_BODY });
      expect(JSON.stringify(snaps.filter((s) => !s.auth.loggedIn))).not.toContain('결제 서버');
      // 화면 이동 신호는 그대로 (로그인 화면은 내용을 그리지 않는다)
      e.ctx.bus.emit('navigate', { tab: 'settings', section: 'policy' });
      expect(navs.at(-1)).toEqual({ tab: 'settings', section: 'policy' });

      // 다시 로그인하면 전체 스냅샷이 오고, 로그아웃 중 알림은 목록에 그대로 있다
      await e.invoke('auth.devLogin');
      await waitFor(() => snaps.at(-1)!.auth.loggedIn, '로그인 스냅샷');
      expect(snaps.at(-1)!.projects.map((p) => p.id)).toContain(e.projectId);
      const list = await e.invoke('notifications.list', {});
      expect(list.some((n) => n.title === '메인 에이전트 질문' && n.body === '대표님, 결제 서버 주소를 알려 주세요')).toBe(true);
      e.ctx.notify({ level: 'normal', title: '보고서 도착', body: '다시 보임' });
      expect(notes.at(-1)?.body).toBe('다시 보임');
      expect(toasts.at(-1)?.body).toBe('다시 보임');
    } finally {
      for (const off of offs) off();
    }
  });
});
