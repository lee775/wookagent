import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, ExternalAgentView, MemberDetail } from '../../../shared/views';
import { snapshot as seed, settings, roles } from '../api/fake/data';
import { createFakeSeat } from '../api/fake/seat';
import { createFakeAgents } from '../api/fake/agents';
import { SeatChip, SeatUnresponsive } from './SeatStatus';
import { SeatScreen } from '../screens/Seat';
import { AgentConnection, ExternalAgents, ExternalHolderConnection } from './ExternalAgents';
import { MemberPanel, MainSeatSummary, TurnDetails } from './MemberPanel';
import { EXTERNAL_ACCESS_ENDED } from '../lib/agents';
import { date, Section } from '../lib/ui';

const runtime = vi.hoisted(() => ({ host: null as HookHost | null, invoke: vi.fn(), subscribe: vi.fn() }));
vi.mock('../api/bridge', () => ({ getBridge: () => ({ invoke: runtime.invoke, subscribe: runtime.subscribe, platform: 'win32' }) }));
vi.mock('../studio3d/Member3DPortrait', () => ({ Member3DPortrait: () => null }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (init: unknown) => runtime.host ? runtime.host.state(init) : actual.useState(init),
    useRef: (init: unknown) => runtime.host ? runtime.host.state({ current: init })[0] : actual.useRef(init),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => runtime.host ? runtime.host.effect(fn, deps) : actual.useEffect(fn, deps),
  };
});
type Slot = { value: unknown; deps?: unknown[]; cleanup?: () => void };
class HookHost {
  slots: Slot[] = []; index = 0; effects: (() => void)[] = []; tree: ReactNode = null;
  state(init: unknown): [unknown, (value: unknown) => void] {
    const index = this.index++, slot = this.slots[index] ??= { value: typeof init === 'function' ? init() : init };
    return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
  }
  effect(fn: () => void | (() => void), deps?: unknown[]) {
    const index = this.index++, old = this.slots[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) this.effects.push(() => {
      old?.cleanup?.(); const cleanup = fn(); this.slots[index] = { value: null, deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    });
  }
  async render(component: () => ReactNode) {
    for (let pass = 0; pass < 4; pass++) {
      this.index = 0; runtime.host = this;
      try { this.tree = component(); } finally { runtime.host = null; }
      this.effects.splice(0).forEach(effect => effect());
      for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    }
  }
  html() { return renderToStaticMarkup(this.tree); }
  dispose() { this.slots.forEach(slot => slot.cleanup?.()); }
}
type Props = { children?: ReactNode; title?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; 'aria-label'?: string; className?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : [];
}
const html = (node: ReactNode) => renderToStaticMarkup(node);
let host: HookHost, snapshot: AppSnapshot, agents: ExternalAgentView[], detail: MemberDetail;
let hidden = false;
const visibility = new Set<() => void>();
const renderSeat = () => host.render(() => SeatScreen({ snapshot, navigate: vi.fn() }));
const renderMember = () => host.render(() => MemberPanel({ id: 'M-MAIN', snapshot, close: vi.fn(), openTask: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  host = new HookHost(); snapshot = structuredClone(seed); snapshot.auth.loggedIn = true;
  const fixture = createFakeSeat(new URLSearchParams('fakeAgents=connected'));
  snapshot.seat = fixture.seat; agents = fixture.agents; hidden = false; visibility.clear();
  const member = snapshot.members.find(row => row.isMain)!;
  detail = { member, role: roles[0], sessions: [
    { id: 'S-external', aiKind: 'external', kind: 'main_general', workKey: 'main', label: '전체 관리', cliSessionId: null, mock: false, createdAt: '2026-11-10T11:00:00Z', closedAt: null, previousSessionId: 'S-cli', replaceReason: '자리 교체', turnCount: 1, current: true },
    { id: 'S-cli', aiKind: 'codex', kind: 'main_general', workKey: 'main', label: '전체 관리', cliSessionId: 'old-cli', mock: false, createdAt: '2026-11-09T11:00:00Z', closedAt: '2026-11-10T11:00:00Z', previousSessionId: null, replaceReason: null, turnCount: 1, current: false },
  ], recentTurns: [
    { id: member.currentWork?.turnId ?? 'TN-external', sessionId: 'S-external', runner: 'external', startedAt: '2026-11-10T11:00:00Z', endedAt: null, endReason: null, endDetail: '', bypass: 'verified', mcp: 'unknown', eventCount: 0, usage: null, running: true },
    { id: 'TN-cli', sessionId: 'S-cli', startedAt: '2026-11-09T11:00:00Z', endedAt: '2026-11-09T11:01:00Z', endReason: 'completed', endDetail: '', bypass: 'verified', mcp: 'connected', eventCount: 0, usage: null, running: false },
  ], currentTask: null, queuedTasks: [], history: [], messages: [] };
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), location: { search: '' }, localStorage: { getItem: () => null, setItem: vi.fn() }, setInterval, clearInterval });
  vi.stubGlobal('document', { get hidden() { return hidden; }, addEventListener: (_: string, fn: () => void) => visibility.add(fn), removeEventListener: (_: string, fn: () => void) => visibility.delete(fn) });
  runtime.subscribe.mockReset().mockReturnValue(() => undefined);
  runtime.invoke.mockReset().mockImplementation(async (method: string) => {
    if (method === 'agents.list') return structuredClone(agents);
    if (method === 'seat.get') return structuredClone(snapshot.seat);
    if (method === 'seat.history') return fixture.history;
    if (method === 'settings.get') return structuredClone(settings);
    if (method === 'members.getDetail') return structuredClone(detail);
    if (method === 'members.getEvents') return { events: [], nextCursor: null, turnId: null };
    throw new Error(`Unexpected call: ${method}`);
  });
});
afterEach(() => { host.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('stage 7 external agent viewing', () => {
  it('S7-chip. identifies the external holder and incoming holder even while stopped', () => {
    for (const state of ['active', 'switching', 'stopped'] as const) {
      snapshot.seat.state = state;
      if (state === 'switching') snapshot.seat.pendingHolder = { kind: 'external', agentId: 'X-0002', label: '다음 도우미' };
      const value = html(createElement(SeatChip, { snapshot, open: vi.fn() }));
      expect(value).toContain('산책 도우미 · 외부 에이전트');
      expect(value).not.toMatch(/Claude|Codex|<small>|opus|gpt-/);
      if (state === 'switching') expect(value).toContain('다음 도우미 · 외부 에이전트');
    }
  });
  it('S7-seat. uses the holder type and live connection in the actual seat view', async () => {
    await renderSeat();
    const section = elements(host.tree).find(node => node.type === Section && node.props.title === '지금 메인 자리');
    const value = html(section);
    expect(value).toContain('산책 도우미 · 외부 에이전트'); expect(value).toContain('연결됨');
    expect(value).not.toMatch(/Claude|Codex|opus|기본 모델/);
    expect(host.html()).toContain('등록된 외부 에이전트'); expect(runtime.invoke).toHaveBeenCalledWith('agents.list');
    snapshot.seat.unresponsiveSince = '2026-11-10T11:50:00Z'; snapshot.seat.unresponsiveReason = '접근이 철회됐습니다.';
    agents[0].connected = false; await renderSeat();
    expect(host.html()).toContain('응답 없음'); expect(host.html()).toContain('접근이 철회됐습니다.');
    expect(host.html()).not.toContain('돌아오면');
    const banner = new HookHost();
    await banner.render(() => SeatUnresponsive({ snapshot, stop: vi.fn() }));
    expect(banner.html()).toContain('연결과 접근 권한'); expect(banner.html()).not.toContain('돌아오면'); banner.dispose();
  });
  it('S7-main-panel. replaces stale CLI model, effort and pending settings with the current holder', async () => {
    detail.member.ai.kind = 'claude'; detail.member.ai.modelValue = 'OLD-CLI-MODEL'; detail.member.ai.effortValue = 'OLD-EFFORT';
    detail.member.pendingAiChange = { kind: 'codex', model: 'OLD-PENDING', effortTier: 'high', effortOverride: null };
    await renderMember();
    const value = host.html(); const summary = value.slice(value.indexOf('member-hero'), value.indexOf('command-shortcut'));
    expect(summary).toContain('산책 도우미 · 외부 에이전트'); expect(summary).not.toMatch(/Claude|Codex|OLD-|기본 모델/);
    snapshot.seat.holder = null; snapshot.seat.state = 'vacant'; await renderMember();
    expect(html(elements(host.tree).find(node => node.type === MainSeatSummary))).toContain('메인 에이전트 없음');
  });
  it('S7-records. labels mixed session and turn rows independently and hides external bypass details', async () => {
    await renderMember(); const value = host.html();
    expect(value).toContain('<th>실행 주체</th>'); expect(value).toContain('<td>외부 에이전트</td>'); expect(value).toContain('<td>Codex CLI</td>');
    expect(value).toMatch(/<option[^>]*>[^<]*외부 에이전트[^<]*<\/option>/);
    expect(value).toMatch(/<option[^>]*>[^<]*Codex CLI[^<]*<\/option>/);
    const external = html(createElement(TurnDetails, { turn: detail.recentTurns[0], sessions: detail.sessions }));
    expect(external).toContain('외부 에이전트'); expect(external).not.toMatch(/바이패스|Claude|Codex/);
    expect(html(createElement(TurnDetails, { turn: detail.recentTurns[1], sessions: detail.sessions }))).toContain('바이패스 검증됨');
  });
  it.each(['disconnected', 'revoked', 'stopped'])('S7-connection. %s never appears connected and preserves last seen', scenario => {
    const agent = { ...agents[0] };
    if (scenario === 'disconnected') agent.connected = false;
    if (scenario === 'revoked') agent.revokedAt = '2026-11-10T11:59:00Z'; // A stale true must lose to revocation.
    if (scenario === 'stopped') snapshot.seat.state = 'stopped';
    const value = html(createElement(AgentConnection, { agent, seat: snapshot.seat }));
    expect(value).toContain('연결 안 됨'); expect(value).not.toContain('>연결됨<'); expect(value).toContain('마지막 접속:');
    expect(value).toContain(date(agent.lastSeenAt));
    const holder = html(createElement(ExternalHolderConnection, { seat: snapshot.seat, agents: [agent], error: '' }));
    if (scenario !== 'disconnected') {
      expect(holder).toContain('외부 프로그램의 종료 여부는 확인할 수 없습니다.');
      expect(holder).not.toContain('종료를 확인했습니다');
    }
    agent.lastSeenAt = null;
    expect(html(createElement(AgentConnection, { agent, seat: snapshot.seat }))).toContain('접속 기록 없음');
  });
  it('S7-list. presents every field with no managing, editing, clipboard or key control', () => {
    agents = createFakeAgents('several');
    agents[1].seat = 'incoming';
    const value = html(createElement(ExternalAgents, { agents, error: '', seat: snapshot.seat }));
    for (const text of ['산책 도우미', 'X-0001', '등록', '접근 권한', '유효', '철회됨', '마지막 접속', '접속 기록 없음', '메인 자리 보유', '다음 보유자 · 교체 중', '자리 없음', '연결됨', '연결 안 됨']) expect(value).toContain(text);
    expect((value.match(/<li /g) ?? [])).toHaveLength(4);
    expect(value).not.toMatch(/<button|<input|<select|<textarea|<a\s|contenteditable|wsk_|wtt_|key_hash|복사|키 표시/);
  });
  it('S7-empty. distinguishes zero registered from loading, failure and missing holder data', () => {
    const render = (rows: ExternalAgentView[] | null, error = '') => html(createElement(ExternalAgents, { agents: rows, error, seat: snapshot.seat }));
    expect(render([])).toContain('등록된 외부 에이전트가 없습니다.');
    expect(render([])).not.toMatch(/<li |연결됨|자리 비어/);
    expect(render(null)).toContain('불러오는 중'); expect(render(null)).not.toContain('등록된 외부 에이전트가 없습니다.');
    expect(render(null, '조회 실패')).toContain('role="alert"'); expect(render(null, '조회 실패')).not.toContain('등록된 외부 에이전트가 없습니다.');
    for (const rows of [null, []]) {
      const holder = html(createElement(ExternalHolderConnection, { seat: snapshot.seat, agents: rows, error: '' }));
      expect(holder).not.toContain('>연결됨<');
    }
  });
  it('S7-refresh. renews connection while visible, clears stale success on failure and cleans up polling', async () => {
    await renderSeat(); expect(host.html()).toContain('>연결됨<');
    agents[0].connected = false; await vi.advanceTimersByTimeAsync(5000); await renderSeat();
    expect(host.html()).toContain('>연결 안 됨<');
    const reads = () => runtime.invoke.mock.calls.filter(([method]) => method === 'agents.list').length;
    const count = reads(); hidden = true; await vi.advanceTimersByTimeAsync(5000); expect(reads()).toBe(count);
    hidden = false; visibility.forEach(listener => listener()); await renderSeat(); expect(reads()).toBe(count + 1);
    runtime.invoke.mockImplementation(async () => { throw new Error('offline'); });
    await vi.advanceTimersByTimeAsync(5000); await renderSeat();
    expect(host.html()).toContain('연결 상태를 확인할 수 없습니다.'); expect(host.html()).not.toContain('>연결됨<');
    host.dispose(); expect(vi.getTimerCount()).toBe(0); expect(visibility.size).toBe(0);
  });
  it.each(['none', 'connected', 'disconnected', 'incoming', 'revoked', 'several', 'unresponsive'])('S7-fake. reads fakeAgents=%s through the protected bridge with correct records', async scenario => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { search: `?fakeAgents=${scenario}` }, localStorage: { getItem: () => null, setItem: vi.fn() }, setInterval, clearInterval });
    const { fakeBridge } = await import('../api/fake');
    await expect(fakeBridge.invoke('agents.list')).rejects.toMatchObject({ code: 'unauthorized' });
    await fakeBridge.invoke('auth.devLogin');
    const list = await fakeBridge.invoke('agents.list');
    expect(list).toEqual(createFakeAgents(scenario));
    expect(JSON.stringify(list)).not.toMatch(/wsk_|wtt_|key|hash/);
    if (scenario === 'none') { expect(list).toEqual([]); return; }
    expect((await fakeBridge.invoke('seat.get')).holder).toMatchObject({ kind: 'external', agentId: 'X-0001' });
    const member = await fakeBridge.invoke('members.getDetail', 'M-MAIN');
    expect(member.sessions[0].aiKind).toBe('external'); expect(member.recentTurns[0].runner).toBe('external');
    expect(member.sessions[1].aiKind).not.toBe('external'); expect(member.recentTurns[1].runner).toBeUndefined();
    if (scenario === 'connected') {
      const summary = await fakeBridge.invoke('stop.emergency');
      expect(summary.completed).toBe(false); expect(summary.failures[0].detail).toBe(EXTERNAL_ACCESS_ENDED);
      expect((await fakeBridge.invoke('agents.list'))[0].connected).toBe(false);
    }
    list[0].label = 'changed'; expect((await fakeBridge.invoke('agents.list'))[0].label).toBe('산책 도우미');
  });
});
