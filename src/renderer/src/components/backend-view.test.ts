import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { snapshot } from '../api/fake/data';
import { TaskRevertLinks } from './TaskDetail';

describe('backend links in the task view', () => {
  it('renders both directions of a revert relation using task titles', () => {
    const source = { ...snapshot.tasks[0], revertedByTaskId: 'T-0002' };
    const revert = { ...snapshot.tasks[1], revertOfTaskId: 'T-0001' };
    const noop = () => undefined;
    const sourceHtml = renderToString(createElement(TaskRevertLinks, { task: source, snapshot, openTask: noop }));
    const revertHtml = renderToString(createElement(TaskRevertLinks, { task: revert, snapshot, openTask: noop }));
    expect(sourceHtml).toContain(snapshot.tasks[1].title);
    expect(revertHtml).toContain(snapshot.tasks[0].title);
    expect(sourceHtml + revertHtml).not.toMatch(/\bT-\d{4}\b/);
  });
});
