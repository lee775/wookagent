/**
 * tests/e2e/mockMain의 대표 흐름을 HTTP와 SSE로 (SERVER_DESIGN 10.2, S2-11): 대표는 명령을 보내고(command.send), 밀어주기로 진행을 보고,
 * 보고서를 읽는다. 결과는 같은 순간의 IPC 길(데스크톱 Backend.invoke)과 같아야 한다.
 * 서버는 하네스 백엔드를 원격 길 게이트로 감싸 프로세스 안에서 연다. 시험 준비(프로젝트·팀원·모의 설정)는 대표가 하지 못하므로 하네스(운영자 내부 API)가 한다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSnapshot } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest } from '../../src/server/admin';
import { startServer, type RunningServer } from '../../src/server/server';
import { invokeHttp, memoryLogger, openSse, remoteBackendOf, removeDir, type SseClient } from './helpers';

let h: Harness;
let server: RunningServer;
let token = '';
let sse: SseClient;
let watched: SseClient;

beforeAll(async () => {
  h = await createHarness({ team: ['developer'] });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test' });
  const reply = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
  if (!reply.ok) throw new Error('시험용 세션을 받지 못했습니다');
  token = (reply.result as { token: string }).token;
  sse = await openSse(server.url, token);
  watched = await openSse(server.url, token, `?members=${h.members.developer}`);
}, 120_000);

afterAll(async () => {
  sse?.close();
  watched?.close();
  await server?.close();
  await h?.close();
});

const ok = async <T>(method: string, ...args: unknown[]): Promise<T> => {
  const r = await invokeHttp(server.url, token, method, args);
  const body = r.json<{ ok: boolean; value: T; error?: { code: string; message: string } }>();
  if (r.status !== 200 || !body.ok) throw new Error(`${method} 실패 ${r.status} ${body.error?.code}: ${body.error?.message}`);
  return body.value;
};
const latestSnapshot = (c: SseClient): AppSnapshot | null => {
  const snaps = c.events.filter((e) => e.event === 'snapshot');
  return snaps.length ? (snaps[snaps.length - 1]!.data.payload as AppSnapshot) : null;
};
/** IPC 길(데스크톱 화면이 쓰는 Backend.invoke)으로 같은 것을 읽는다 — JSON으로 오간 값과 비교 */
const viaIpc = async (method: Parameters<Harness['invoke']>[0], ...args: unknown[]) => JSON.parse(JSON.stringify(await (h.orch.backend.invoke as (m: string, a: unknown[]) => Promise<unknown>)(method, args)));

describe('mockMain 흐름을 HTTP·SSE로', () => {
  it('명령을 보내면 SSE 스냅숏으로 진행이 보이고, 보고서는 HTTP로 IPC 길과 같게 읽힌다', async () => {
    const before = new Set((latestSnapshot(sse)?.directives ?? []).map((d) => d.id));
    const sent = await ok<{ conversationId: string }>('command.send', { target: h.projectId, text: '카페 게임 첫 화면을 만들어 줘. 메뉴판 디자인, 주문 버튼, 기본 테스트까지 포함해서.' });
    expect(typeof sent.conversationId).toBe('string');

    // 지시가 생기고 보고까지 가는 것을 밀어주기(스냅숏)로만 본다
    let did = '';
    await sse.waitFor(() => {
      const d = latestSnapshot(sse)?.directives.find((x) => !before.has(x.id));
      if (d) did = d.id;
      return !!d;
    }, '지시 등록');
    expect(latestSnapshot(sse)!.directives.find((d) => d.id === did)!.title).toBe('카페 게임 첫 화면을 만들어 줘');
    await sse.waitFor(() => latestSnapshot(sse)?.directives.find((d) => d.id === did)?.state === 'awaiting_confirmation', '보고 도착', 180_000);

    const reports = await ok<{ id: string; directiveId?: string }[]>('reports.list', {});
    const report = await ok<Record<string, unknown>>('reports.get', h.core.ctx.store.reports.list({ ref1: did })[0]!.id);
    const text = JSON.stringify(report);
    expect(text).not.toContain('submit_report(');
    expect(text).not.toContain('대표에게 보고하세요');

    // 같은 순간 IPC 길과 같다
    expect(reports).toEqual(await viaIpc('reports.list', {}));
    expect(report).toEqual(await viaIpc('reports.get', report['id']));
    expect(await ok('directives.get', did)).toEqual(await viaIpc('directives.get', did));
    expect(await ok('command.history', h.projectId, {})).toEqual(await viaIpc('command.history', h.projectId, {}));
    expect(await ok('notifications.list', {})).toEqual(await viaIpc('notifications.list', {}));
  }, 240_000);

  it('모든 이벤트에 이 서버의 실행 ID가 붙는다', () => {
    expect(sse.events.length).toBeGreaterThan(1);
    expect(new Set(sse.events.map((e) => e.data.runId))).toEqual(new Set([server.runId]));
  });

  it('CLI 이벤트는 ?members=로 고른 팀원 것만 오고, 고르지 않은 연결에는 오지 않는다', async () => {
    const devEvents = watched.events.filter((e) => e.event === 'cliEvents');
    expect(devEvents.length).toBeGreaterThan(0);
    expect(new Set(devEvents.map((e) => (e.data.payload as { memberId: string }).memberId))).toEqual(new Set([h.members.developer]));
    expect(sse.events.filter((e) => e.event === 'cliEvents')).toEqual([]);
    // 고른 팀원의 CLI 이벤트는 members.getEvents(HTTP)로도 읽힌다 — 다시 연결한 화면이 빠진 것을 채우는 길
    const page = await ok<{ events: unknown[] }>('members.getEvents', h.members.developer, {});
    expect(page.events.length).toBeGreaterThan(0);
  });

  it('밀어준 스냅숏은 snapshot.get(HTTP)과 같은 내용이다 — 차례(version)는 부를 때마다 오른다', async () => {
    const snap = await ok<AppSnapshot>('snapshot.get');
    const pushed = latestSnapshot(sse)!;
    const shape = (s: AppSnapshot) => ({
      projects: s.projects.map((p) => p.id),
      members: s.members.map((m) => m.id).sort(),
      directives: s.directives.map((d) => [d.id, d.state]),
      loggedIn: s.auth.loggedIn,
    });
    expect(shape(pushed)).toEqual(shape(snap));
    expect(pushed.auth.loggedIn).toBe(true);
  });
});
