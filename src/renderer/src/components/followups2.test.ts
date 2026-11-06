import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationView } from '../../../shared/views';
import { snapshot, notifications, settings } from '../api/fake/data';
import { noticePresentation, noticeTitle } from '../lib/notice';
import { subscribeCommand } from '../lib/commands';
import { ServerNotice } from './ServerNotice';
import { Home } from '../screens/Home';

const task = snapshot.tasks[0];
const member = snapshot.members.find(value => !value.isMain)!;
function notice(key: NotificationView['key'], link: NotificationView['link'] = null): NotificationView {
  return { id: 'notice-test', key, title: '서버가 바꾼 제목', body: '서버 원문 M-0016\n둘째 줄 / 변경하지 않는 글',
    link, level: 'normal', createdAt: snapshot.generatedAt, read: false };
}
function buttons(node: ReactNode): { children?: ReactNode; onClick?: () => void }[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
  return [...(node.type === 'button' ? [node.props] : []), ...buttons(node.props.children)];
}

describe('step-1 second screen follow-ups', () => {
  it('S2-1. keys select titles, settings targets and shortcuts regardless of title or body', () => {
    for (const [key, title, section] of [
      ['usage:claude', '사용량 한도', 'account'], ['usage:codex', '사용량 한도', 'account'],
      ['usage:claude:opus', 'Opus 주간 한도', 'account'], ['usage:claude:sonnet', 'Sonnet 주간 한도', 'account'],
      ['usage:claude:fable', 'Fable 주간 한도', 'account'], ['mock-on', '모의 실행이 켜져 있음', 'account'],
      ['execution-reset', '실행 설정을 기본값으로 되돌림', 'execution'],
    ]) {
      const item = notice(key, { tab: 'projects', taskId: task.id });
      const view = noticePresentation(item, snapshot);
      expect(view.title).toBe(title); expect(view.link).toEqual({ tab: 'settings', section });
      expect(view.command).toEqual(key === 'execution-reset' ? { projectId: null, text: '실행 설정에 대해: ' } : null);
      expect(noticePresentation({ ...item, title: '검수 멈춤', body: '본문도 전혀 달라짐' }, snapshot)).toEqual(view);
    }
  });

  it('S2-1-task. review and handoff use link.taskId and its snapshot title, with ID-only fallback', () => {
    for (const key of [`review-stuck:${task.id}:M-MAIN`, `handoff-stuck:${task.id}`]) {
      const item = notice(key, { tab: 'projects', taskId: task.id, directiveId: task.directiveId, memberId: member.id });
      const view = noticePresentation(item, snapshot);
      expect(view.link).toEqual({ tab: 'projects', projectId: task.projectId, taskId: task.id, directiveId: task.directiveId });
      expect(view.command).toEqual({ projectId: task.projectId, text: `${task.id} "${task.title}"에 대해: ` });
      const missing = noticePresentation({ ...item, link: { tab: 'projects', projectId: task.projectId, taskId: 'T-9999' } }, snapshot);
      expect(missing.command).toEqual({ projectId: task.projectId, text: 'T-9999에 대해: ' });
    }
    const paused = noticePresentation(notice(`pause-stuck:${member.id}`, { tab: 'projects', memberId: member.id, taskId: task.id }), snapshot);
    expect(paused.link).toEqual({ tab: 'projects', projectId: member.projectId, memberId: member.id });
    expect(paused.command).toEqual({ projectId: member.projectId, text: `${member.id} ${member.name}(${member.roleName})에 대해: ` });
  });

  it('S2-1-drop. crash, start-fail and spin accept per-drop suffixes and open contextual project drafts', () => {
    for (const [prefix, title] of [['crash:', '자동 복구 실패'], ['start-fail:', '업무 시작 실패'], ['spin:', '헛돌기']]) {
      for (const suffix of ['', ':Q-000123', ':Q-000456']) {
        for (const body of ['다른 서버 글', '메인 에이전트에게 전하지 못한 대표 요청: ... — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요']) {
          const item = { ...notice(`${prefix}main:${task.projectId}${suffix}`, { tab: 'projects', projectId: task.projectId, memberId: 'M-MAIN' }), body };
          const view = noticePresentation(item, snapshot);
          expect(view.title).toBe(title); expect(view.link).toEqual(item.link);
          expect(view.command).toEqual({ projectId: task.projectId, text: `${title} 알림에 대해: ` });
          const withoutLink = noticePresentation({ ...item, link: null }, snapshot);
          expect(withoutLink.link).toEqual({ tab: 'projects', projectId: task.projectId });
          expect(withoutLink.command).toEqual(view.command);
        }
      }
    }
  });

  it('S2-1-legacy. absent/null keys retain server titles, links and subject drafts', () => {
    for (const key of [undefined, null]) {
      const item = notice(key, { tab: 'projects', projectId: task.projectId, taskId: task.id });
      expect(noticePresentation(item, snapshot)).toEqual({ title: item.title, link: item.link,
        command: { projectId: task.projectId, text: `${task.id} "${task.title}"에 대해: ` } });
    }
    expect(noticePresentation(notice('future-key', { tab: 'simulation' }), snapshot)).toEqual({
      title: '서버가 바꾼 제목', link: { tab: 'simulation' }, command: null,
    });
  });

  it('S2-1-controls. notice actions navigate or draft without resuming, and preserve every body character', () => {
    const draft = vi.fn(); const off = subscribeCommand(draft);
    try {
      for (const key of [`review-stuck:${task.id}:M-MAIN`, `crash:main:${task.projectId}:Q-000123`, 'usage:claude:fable']) {
        const item = notice(key, { tab: 'projects', taskId: task.id, projectId: task.projectId });
        const navigate = vi.fn(), markRead = vi.fn(), close = vi.fn();
        const tree = ServerNotice({ item, snapshot, navigate, markRead, close });
        const html = renderToStaticMarkup(tree);
        expect(html).toContain(noticeTitle(item)); expect(html).toContain(item.body);
        expect(html).not.toMatch(/>재개<|>다시 시도<|>재시도</);
        buttons(tree)[0].onClick?.(); expect(navigate).toHaveBeenCalledWith(noticePresentation(item, snapshot).link);
        const shortcut = buttons(tree).find(button => button.children === '메인 에이전트에게 말하기');
        const command = noticePresentation(item, snapshot).command;
        if (command) { shortcut?.onClick?.(); expect(draft).toHaveBeenLastCalledWith({ target: command.projectId ?? 'main', text: command.text }); }
        else expect(shortcut).toBeUndefined();
        expect(markRead).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
      }
    } finally { off(); }
  });

  it('S2-2. the list keeps the entire body inside a native, keyboard-operable disclosure', () => {
    const item = notice('crash:main:P-0001:Q-000123');
    const html = renderToStaticMarkup(createElement(ServerNotice, { item, snapshot, navigate: vi.fn(), markRead: vi.fn(), close: vi.fn() }));
    expect(html).toContain('<details class="notice-body"><summary>');
    expect(html).toContain('본문 펼치기'); expect(html).toContain('본문 접기');
    expect(html).toContain(item.body); expect(html).not.toContain('<details open');
  });

  it('S2-fake. preview includes keyed notices and both new and older todo fields', () => {
    expect(notifications.some(value => value.key?.startsWith('review-stuck:') && value.link?.tab === 'projects' && value.link.taskId)).toBe(true);
    expect(notifications.some(value => value.key?.startsWith('crash:'))).toBe(true);
    expect(notifications.some(value => value.key == null)).toBe(true);
    const errors = snapshot.ownerTodos.filter(value => value.kind === 'error');
    expect(errors.some(value => value.reachesMain === true)).toBe(true);
    expect(errors.some(value => value.reachesMain === false)).toBe(true);
    expect(errors.some(value => value.reachesMain === undefined)).toBe(true);
    for (const error of errors) {
      if (error.reachesMain === undefined) continue;
      const held = snapshot.tasks.find(value => value.id === error.taskId);
      expect(held?.hold?.reasons.some(reason => reason.reachesMain === error.reachesMain)).toBe(true);
      const noop = () => undefined;
      const html = renderToStaticMarkup(createElement(Home, { snapshot: { ...snapshot, ownerTodos: [error] },
        openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
      expect(html).toContain(`<strong>${error.reachesMain ? '메인 에이전트가 처리 중' : '보류된 작업'}</strong>`);
      expect(html.includes('이 보류는 메인 에이전트에게 따로 전해지지 않습니다.')).toBe(!error.reachesMain);
    }
    expect(snapshot.tasks.some(task => task.hold?.reasons.some(reason => reason.kind === 'merge_blocked' && reason.reachesMain === true))).toBe(true);
    expect(snapshot.tasks.some(task => task.hold?.reasons.some(reason => reason.kind === 'recovery_check' && reason.reachesMain === true))).toBe(true);
    expect(snapshot.ownerTodos.some(todo => todo.kind === 'recovery_check' && todo.reachesMain === true)).toBe(true);
  });

  it('S2-5-fake. invalid auth modes reject mixed patches without changing any settings', async () => {
    const { fakeBridge } = await import('../api/fake');
    const original = structuredClone(settings);
    for (const authMode of [{ claude: 'free' }, { codex: 'oauth' }, { claude: null }, { claude: 1 }, { other: 'api_key' }, null, 'subscription', []]) {
      await expect(Reflect.apply(fakeBridge.invoke, fakeBridge, ['settings.update', { account: { authMode }, logs: { retentionDays: 7 } }])).rejects.toMatchObject({ code: 'invalid' });
      expect(settings).toEqual(original);
    }
  });
});
