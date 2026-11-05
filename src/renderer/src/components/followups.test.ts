import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-expect-error Node is available in Vitest, outside the browser type environment.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node is available in Vitest, outside the browser type environment.
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationView } from '../../../shared/views';
import { snapshot, settings } from '../api/fake/data';
import { ServerNotice } from './ServerNotice';
import { SettingsBoundary } from './SettingsBoundary';
import { subscribeCommand } from '../lib/commands';
import { EXECUTION_LIMITS, BACKUP_KEEP_LIMIT } from '../lib/operationLimits';
import { AiStatusSummary } from './AiStatusSummary';

function buttons(node: ReactNode): { children?: ReactNode; onClick?: () => void }[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
  return [...(node.type === 'button' ? [node.props] : []), ...buttons(node.props.children)];
}

describe('step-1 follow-ups', () => {
  it('F1-fake. only exact mock-off arguments pass and rejected values leave state intact', async () => {
    vi.stubGlobal('window', { wook: {}, location: { search: '' } });
    const { fakeBridge, FORBIDDEN_MESSAGE } = await import('../api/fake');
    const project = snapshot.projects[0]; const original = structuredClone(project.mock); const developer = structuredClone(settings.developer);
    try {
      project.mock.enabled = true; settings.developer.mainAgentMock = true;
      for (const input of [{ enabled: true }, { enabled: false, speed: 1 }, {}, null, { enabled: 0 }, []]) {
        await expect(Reflect.apply(fakeBridge.invoke, fakeBridge, ['projects.setMock', project.id, input])).rejects.toMatchObject({ code: 'forbidden', message: FORBIDDEN_MESSAGE });
        expect(project.mock.enabled).toBe(true);
      }
      for (const args of [[project.id], [project.id, { enabled: false }, 'extra']]) {
        await expect(Reflect.apply(fakeBridge.invoke, fakeBridge, ['projects.setMock', ...args])).rejects.toMatchObject({ code: 'forbidden', message: FORBIDDEN_MESSAGE });
        expect(project.mock.enabled).toBe(true);
      }
      await expect(fakeBridge.invoke('settings.update', { developer: { mainAgentMock: true } })).rejects.toMatchObject({ code: 'forbidden', message: FORBIDDEN_MESSAGE });
      await expect(fakeBridge.invoke('settings.update', { developer: { mainAgentMock: false }, logs: { retentionDays: 7 } })).rejects.toMatchObject({ code: 'forbidden' });
      await fakeBridge.invoke('projects.setMock', project.id, { enabled: false });
      await fakeBridge.invoke('settings.update', { developer: { mainAgentMock: false } });
      expect(project.mock.enabled).toBe(false); expect(settings.developer.mainAgentMock).toBe(false);
    } finally { Object.assign(project.mock, original); Object.assign(settings.developer, developer); vi.unstubAllGlobals(); }
  });
  it('F2-family. rendering accepts future families and uses their supplied labels', () => {
    // Runtime contract can add families before this renderer is updated.
    const ai = Object.assign({}, snapshot.ai[0], { blocked: false, problem: null, authRequired: false, usageLimitedUntil: null,
      modelLimits: [{ family: 'a-future-family', label: '새 계열', until: '2026-11-03T12:35:00Z' }] });
    const html = renderToStaticMarkup(createElement(AiStatusSummary, { ai: Object.assign({}, snapshot.ai[0], ai) }));
    expect(html).toContain('새 계열 주간 한도'); expect(html).not.toContain('막혔습니다');
  });
  it('F3. notices preserve server text and link, and draft the named subject without resume', () => {
    const draft = vi.fn(); const off = subscribeCommand(draft);
    const task = snapshot.tasks[0]; const member = snapshot.members.find(m => !m.isMain)!;
    const subjects: Pick<NotificationView, 'id' | 'title' | 'link'>[] = [
      { id: '1', title: '실행 설정을 기본값으로 되돌림', link: { tab: 'settings', section: 'execution' } },
      { id: '2', title: '모의 실행이 켜져 있음', link: { tab: 'settings', section: 'account' } },
      { id: '3', title: 'Fable 주간 한도', link: { tab: 'settings', section: 'account' } },
      { id: '4', title: '검수 멈춤', link: { tab: 'projects', projectId: task.projectId, taskId: task.id } },
      { id: '5', title: '메인 에이전트 처리 지연', link: { tab: 'projects', taskId: task.id } },
      { id: '6', title: '메인 에이전트 처리 지연', link: { tab: 'projects', memberId: member.id } },
      { id: '7', title: '검수 멈춤', link: { tab: 'projects', projectId: task.projectId, directiveId: task.directiveId } },
    ];
    const items = subjects.map(item => ({ ...item, body: '서버 글 M-0016\n변경된 보류 안내 / 그대로', level: 'info', createdAt: snapshot.generatedAt, read: false } satisfies NotificationView));
    try {
      for (const item of items) {
        const navigate = vi.fn(), markRead = vi.fn(), close = vi.fn();
        const tree = ServerNotice({ item, snapshot, navigate, markRead, close });
        const html = renderToStaticMarkup(tree);
        expect(html).toContain(item.title); expect(html).toContain(item.body);
        expect(html).not.toMatch(/>재개<|>다시 시도<|>재시도</);
        buttons(tree)[0].onClick?.(); expect(navigate).toHaveBeenCalledWith(item.link);
        if (item.link?.tab === 'projects') {
          const command = buttons(tree).find(b => b.children === '메인 에이전트에게 말하기'); expect(command).toBeDefined(); command?.onClick?.();
          expect(draft).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining(item.link.memberId ?? item.link.taskId ?? item.link.directiveId ?? '') }));
        }
      }
    } finally { off(); }
  });
  it('F5-source. renderer range copy equals server source without importing main', () => {
    const source = readFileSync('src/main/orchestrator/settingsPolicy.ts', 'utf8');
    const ast = ts.createSourceFile('settingsPolicy.ts', source, ts.ScriptTarget.Latest, true);
    function constant(name: string) {
      for (const statement of ast.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(ast) !== name || !declaration.initializer) continue;
        const init = ts.isAsExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer;
        return runInNewContext(`(${init.getText(ast)})`);
      }
      throw new Error(`Missing ${name}`);
    }
    expect(EXECUTION_LIMITS).toEqual(constant('EXECUTION_LIMITS'));
    expect(BACKUP_KEEP_LIMIT).toEqual(constant('BACKUP_KEEP_LIMIT'));
  });
  it('F8. settings errors have a Korean fallback and the boundary encloses only settings', () => {
    const boundary = new SettingsBoundary({ children: createElement('span', null, '정상 설정') });
    expect(renderToStaticMarkup(boundary.render())).toContain('정상 설정');
    boundary.state = SettingsBoundary.getDerivedStateFromError();
    expect(renderToStaticMarkup(boundary.render())).toContain('설정을 표시하지 못했습니다');
    expect(renderToStaticMarkup(boundary.render())).toContain('다른 화면은 계속 사용할 수 있습니다');
    const source = readFileSync('src/renderer/src/App.tsx', 'utf8');
    expect(source).toMatch(/<SettingsBoundary[^>]*><SettingsScreen[\s\S]*?\/><\/SettingsBoundary>/);
    expect(source).not.toMatch(/<SettingsBoundary[^>]*>(?:(?!<\/SettingsBoundary>)[\s\S])*<CommandBar/);
  });
});
