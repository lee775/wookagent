import { afterEach, expect, it, vi } from 'vitest';
import { createElement, isValidElement, Suspense, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { snapshot as seed } from '../api/fake/data';
import { createFakeSeat } from '../api/fake/seat';
import { officeDepartmentSnapshot } from '../api/fake/departments';
import { Home } from '../screens/Home';
import { CompanyOffice } from './CompanyOffice';
import { OfficeScene } from './OfficeScene';
import { OfficeViewport } from './OfficeViewport';
import { behaviourFor, renderActorTick, stations, updateActorMotion, type ActorMotion } from '../studio/motion';
import { officeLabel } from '../lib/officePeople';
import { officeIsStill } from '../lib/officeRendering';
import { OfficeBehaviour } from '../studio3d/behaviour';
import { NavigationGrid, authoredFootprints } from '../studio3d/navigation';
import { homeForAsset, snapshotPlacement } from '../studio3d/placement';

const environment = vi.hoisted(() => ({ web: true }));
vi.mock('../api/runtime', () => ({ runtime: () => environment }));
afterEach(() => { vi.unstubAllGlobals(); environment.web = true; });
const noop = () => undefined;
const fixture = (mode: string) => officeDepartmentSnapshot({ ...seed, seat: createFakeSeat(new URLSearchParams()).seat }, mode);
const markup = (mode: string) => renderToStaticMarkup(createElement(Home, {
  snapshot: fixture(mode), openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop,
}));

it('renders a real office directly on Home with no projects, directives or tasks', () => {
  const view = fixture('no-project');
  expect(view.projects).toEqual([]);
  expect(view.directives).toEqual([]);
  expect(view.tasks).toEqual([]);
  const html = markup('no-project');
  expect(html).toContain('aria-label="메인 사무실"');
  expect(html).toContain('class="office-svg"');
  expect(html.match(/data-desk=/g)).toHaveLength(1);
  expect(html.match(/data-chair=/g)).toHaveLength(1);
  expect(html.match(/data-desk-partition=/g)).toHaveLength(1);
  expect(html).toContain('부서와 직원');
});

function offices(node: ReactNode): Array<{ onMember: (id: string) => void }> {
  if (Array.isArray(node)) return node.flatMap(offices);
  if (!isValidElement<{ children?: ReactNode; onMember: (id: string) => void }>(node)) return [];
  return [...(node.type === OfficeScene ? [node.props] : []), ...offices(node.props.children)];
}
it('shows the main agent and connects the office to the existing member detail callback', () => {
  const snapshot = fixture('no-project'), openMember = vi.fn();
  const main = snapshot.members.find(member => member.isMain)!;
  const element = CompanyOffice({ snapshot, openProject: noop, openMember });
  const html = renderToStaticMarkup(element);
  expect(html).toContain(`data-member-id="${main.id}"`);
  expect(html).toContain(`${main.name} 업무 보기`);
  expect(offices(element)).toHaveLength(1);
  offices(element)[0].onMember(main.id);
  expect(openMember).toHaveBeenCalledWith(main.id);
});

it('keeps the room without desks, chairs or a phantom person when the main seat is vacant', () => {
  const view = fixture('empty-seat');
  expect(view.projects).toEqual([]);
  expect(view.seat.holder).toBeNull();
  const html = markup('empty-seat');
  expect(html).toContain('메인 자리가 비어 있습니다.');
  expect(html).toContain('class="office-svg"');
  expect(html).not.toContain('data-desk=');
  expect(html).not.toContain('data-chair=');
  expect(html).not.toContain('data-desk-partition=');
  expect(html).not.toContain('data-member-id=');
});

it('uses the shared studio rule for both office renderers, including WebGL failure and query overrides', async () => {
  for (const [web, narrow, query, webgl, expected] of [
    [true, false, '', true, true], [true, false, '?studio3d=0', true, false],
    [true, true, '', true, false], [true, true, '?studio3d=1', true, true],
    [true, true, '?studio3d=0', true, false], [false, true, '', true, true],
    [false, true, '?studio3d=0', true, false], [true, false, '', false, false],
    [true, false, '?studio3d=1', false, false],
  ] as const) {
    vi.resetModules(); environment.web = web;
    const loseContext = vi.fn();
    vi.stubGlobal('window', { location: { search: query }, matchMedia: () => ({ matches: narrow }) });
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => webgl ? { getExtension: () => ({ loseContext }) } : null }) });
    const { useStudio3D } = await import('../lib/useStudio3D');
    const { OfficeScene: Scene } = await import('./OfficeScene');
    expect(useStudio3D(), `${web}/${narrow}/${query}/${webgl}`).toBe(expected);
    expect(Scene({ members: [], onMember: noop }).type === Suspense).toBe(expected);
    if (expected) expect(loseContext).toHaveBeenCalledOnce();
  }
});

it('keeps the 3D main agent seated at its own desk for an hour, including reduced motion and emergency', () => {
  const members = fixture('no-project').members;
  for (const reduced of [false, true]) for (const emergency of [false, true]) {
    const people = snapshotPlacement({ members, tasks: [], directives: [], activity: [], emergency, now: 0 });
    expect(people).toHaveLength(1);
    const person = people[0], home = homeForAsset(person.asset);
    expect(person.place).toBe('desk');
    expect([person.x, person.z]).toEqual([home.x, home.z]);
    const engine = new OfficeBehaviour(new NavigationGrid(authoredFootprints));
    engine.apply(people, emergency, null);
    for (const seconds of [0, 1, 40, 900, 3600]) {
      while (engine.time + .00001 < seconds) engine.advance(1, reduced);
      const frame = engine.snapshot().frames[0];
      expect(frame.phase).toBe('seated');
      expect(frame.place).toBe('desk');
      expect([frame.x, frame.z]).toEqual([home.x, home.z]);
      expect(frame.clip).toMatch(/^sit_/);
    }
  }
  expect(snapshotPlacement({ members: [], tasks: [], directives: [], activity: [], emergency: false })).toEqual([]);
});

it('uses the actual external seat holder in main office details', () => {
  const view = fixture('no-project');
  view.seat.holder = { kind: 'external', agentId: 'A-DEMO', label: '연결된 에이전트' };
  const main = view.members.find(member => member.isMain)!;
  expect(officeLabel(main, view).ai).toBe('연결된 에이전트 · 외부 에이전트 · AI 설정은 외부에서 관리합니다.');
});

it('keeps the company main agent seated at its own desk for an hour, also with reduced motion and emergency stop', () => {
  const view = fixture('no-project'), members = view.members;
  for (const reduced of [false, true]) for (const emergency of [false, true]) {
    const actors = new Map<string, ActorMotion>();
    for (const seconds of [0, 1, 40, 120, 300, 900, 3600]) members.forEach((member, index) => {
      const seat = stations[index];
      const target = behaviourFor({ member, seat, index, now: seconds * 1000, seconds,
        tasks: [], directives: [], activity: [], seats: new Map([[member.id, seat]]), members, emergency });
      const prior = actors.get(member.id) ?? { walker: { point: target.point, path: [], segment: 0, distance: 0 }, key: target.key, phase: 'seated', phaseAt: 0, departAt: 0 };
      const actor = updateActorMotion(prior, target, seconds * 1000, .1, emergency, reduced);
      actors.set(member.id, actor);
      const render = renderActorTick({ actor, behaviour: target, seat, now: seconds * 1000, poseUntil: 0, emergency, reduced, facing: 1 });
      expect(target.place).toBe('desk');
      expect(actor.walker.point).toMatchObject({ x: seat.x, y: seat.y });
      expect(render.seated).toBe(true);
      expect(actor.phase).toBe('seated');
    });
  }
});

it('does not mount any scene while the page is hidden or the member portrait is open', () => {
  vi.stubGlobal('document', { hidden: true });
  const html = markup('no-project');
  expect(html).toContain('data-office-sleeping="true"');
  expect(html).not.toContain('class="office-svg"');
  vi.stubGlobal('document', { hidden: false });
  const suspended = renderToStaticMarkup(createElement(OfficeViewport, { label: '사무실', suspended: true, children: createElement('canvas') }));
  expect(suspended).not.toContain('<canvas');
  const home = renderToStaticMarkup(createElement(Home, {
    snapshot: fixture('no-project'), openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop, officeSuspended: true,
  }));
  expect(home).toContain('data-office-sleeping="true"');
  expect(home).not.toContain('class="office-svg"');
  expect(markup('no-project')).toContain('class="office-svg"');
});

it('keeps idle, reduced-motion and stopped 3D offices still, and animates a working office', () => {
  const idle = fixture('idle').members, busy = fixture('busy').members;
  expect(officeIsStill(idle, false, false)).toBe(true);
  expect(officeIsStill([], false, false)).toBe(true);
  expect(officeIsStill(busy, false, false)).toBe(false);
  expect(officeIsStill(busy, true, false)).toBe(true);
  expect(officeIsStill(busy, false, true)).toBe(true);
});
