import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { snapshot } from '../api/fake/data';
import { MemberPanel } from './MemberPanel';
import { Studio } from '../screens/Studio';

vi.stubGlobal('window', { wook: {}, location: { search: '' } });
const noStop = { ...snapshot };
Reflect.deleteProperty(noStop, 'stop');
const noop = () => undefined;

describe('snapshots without the optional stop view', () => {
  it('mounts the member panel', () => {
    expect(renderToString(createElement(MemberPanel, {
      id: 'M-0005', snapshot: noStop, close: noop, openTask: noop,
    }))).toContain('member-panel');
  });
  it('mounts the studio card list', () => {
    expect(renderToString(createElement(Studio, {
      snapshot: noStop, project: noStop.projects[0], back: noop,
      openMember: noop, openTask: noop, openDirective: noop, openReport: noop,
    }))).toContain('member-grid');
  });
  it('shows why a demo member was paused by the system', () => {
    const markup = renderToString(createElement(Studio, {
      snapshot, project: snapshot.projects[2], back: noop,
      openMember: noop, openTask: noop, openDirective: noop, openReport: noop,
    }));
    expect(markup).toContain('자동 일시정지');
    expect(markup).toContain('프로세스 종료를 확인하지 못해');
  });
});
