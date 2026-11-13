/**
 * 열린 SSE도 접속 허용이 바뀌면 따른다 (SERVER_DESIGN 3.4·3.6, 리드 결정 S3-34 — 둘째 검토 flows-lifecycle의 프로브 zz-s3fx-life N1·N2를 옮김).
 * 프로브는 빌드한 서버에서 운영자가 공개 주소를 없애고(N1) 받는 Tailscale 사용자 목록을 켰을 때(N2) 새 요청은 403인데 이미 열린 SSE는 닫히지 않고 계속
 * 스냅숏·긴급 정지를 받는 것을 보였다. 서버 모드 하네스(실제 백엔드) + 운영자 설정(server.json) + 프로세스 안 서버 + 관리 채널.
 * - 연결마다 연 때의 Host와 Tailscale-User-Login을 적어 두고, 운영자 설정을 적용한 뒤(config reload, config 명령) 지금 허용으로 다시 본다 — 이제 받지 않는
 *   연결은 닫고, 닫은 뒤에는 이벤트가 하나도 가지 않는다. 아직 받는 연결은 그대로 받는다
 * - config 명령은 google-client-id와 owner-email 둘 다 본다 — 둘 다 파일에 쓰고 통째로 다시 읽는다 (S3-40, 셋째 검토 tests-integrity의 프로브
 *   zz-s3f2ti-owner-email-recheck)
 * 토큰은 시험 출력에 내지 않는다
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSnapshot } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest, type AdminCommand } from '../../src/server/admin';
import { createOperatorConfig, type OperatorConfigResult } from '../../src/server/config';
import { startServer, type RunningServer } from '../../src/server/server';
import { httpCall, memoryLogger, openSse, remoteBackendOf, sleep, startupCliCheckDone, type SseClient } from './helpers';
import { TEST_OWNER_RECORD } from './ownerServer';

const PUBLIC = 'https://grok-pc.tailnet-test.ts.net';
const PUBLIC_HOST = 'grok-pc.tailnet-test.ts.net';
const OWNER_TS = 'owner@example.com';
const COUSIN_TS = 'cousin@example.com';

let h: Harness;
let server: RunningServer;
let configPath = '';
let token = '';
const log = memoryLogger();
const streams: SseClient[] = [];

beforeAll(async () => {
  h = await createHarness({ mode: 'server', noProject: true });
  // 시작 때의 CLI 확인이 남긴 알림(CLI가 없는 PC)이 열린 연결의 이벤트 수에 끼지 않게 먼저 끝낸다 (리드 결정 S10t)
  await startupCliCheckDone(h);
  h.core.ctx.store.kv.set('owner', { ...TEST_OWNER_RECORD, registeredAt: h.core.ctx.now(), lastLoginAt: null });
  const backend = remoteBackendOf(h);
  configPath = join(h.dataDir, 'server.json');
  writeFileSync(configPath, JSON.stringify({ network: { publicOrigin: PUBLIC } }));
  const config = createOperatorConfig({ path: configPath, ownerEmailFlag: null, operator: backend.operator, logger: log });
  config.reload();
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test', operatorConfig: config, sse: { heartbeatMs: 100 } });
  token = h.core.deviceSessions.issue({ deviceName: '휴대폰', tailscaleLogin: OWNER_TS }).token;
}, 120_000);

afterAll(async () => {
  for (const s of streams) s.close();
  await server?.close();
  await h?.close();
});

const write = (v: unknown) => writeFileSync(configPath, JSON.stringify(v));
const admin = async (command: AdminCommand, args?: string[]): Promise<OperatorConfigResult> => {
  const r = await adminRequest({ dataDir: h.dataDir, command, ...(args ? { args } : {}) });
  expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
  return (r as { result: OperatorConfigResult }).result;
};
/** SSE 하나를 열고 첫 스냅숏까지 기다린다 */
async function stream(o: { bearer?: string; host?: string; tailscale?: string }): Promise<SseClient> {
  const s = await openSse(server.url, o.bearer ?? '', '', { ...(o.host ? { Host: o.host } : {}), ...(o.tailscale ? { 'Tailscale-User-Login': o.tailscale } : {}) });
  streams.push(s);
  expect(s.status).toBe(200);
  await s.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
  return s;
}
const firstSnap = (s: SseClient) => s.events.find((e) => e.event === 'snapshot')!.data.payload as AppSnapshot;
/**
 * 세기 전에 버스를 조용하게 한다: 예약된 바뀜(늦춘 스냅숏 — 하네스 20ms)을 지금 울리고, 열린 연결마다 그 스냅숏을 받을 때까지 기다린다. 앞 단계(config
 * reload 등)가 예약한 스냅숏이 센 뒤에 닿으면 '닫힌 연결에 더 갔다'로 잘못 실패했다 — Windows 전체 실행에서 한 번(KNOWN_ISSUES, 리드 결정 S5-90 5), Linux
 * 실행에서 한 번('snapshot v11', 리드 결정 S10t). 단언은 그대로다
 */
async function settle(...open: SseClient[]): Promise<void> {
  const marks = open.map((s) => s.events.length);
  const bus = h.core.ctx.bus;
  await new Promise<void>((done) => {
    const off = bus.onChanged(() => {
      off();
      done();
    });
    bus.changed();
  });
  await Promise.all(open.map((s, i) => s.waitFor((ev) => ev.slice(marks[i]).some((e) => e.event === 'snapshot'), '세기 전 스냅숏', 10_000)));
}

describe('열린 SSE도 접속 허용이 바뀌면 따른다 (S3-34)', () => {
  it('config reload로 공개 주소를 없애고 받는 Tailscale 사용자 목록을 켜면, 공개 주소로 연 대표의 연결과 목록 밖 사용자의 연결이 닫히고 그 뒤로 아무것도 받지 않는다', async () => {
    const phone = await stream({ bearer: token, host: PUBLIC_HOST, tailscale: OWNER_TS });
    // 목록 밖 사용자의 연결은 바뀐 뒤에도 받는 루프백 Host로 연다 — Tailscale 사용자 검사만으로 닫혀야 한다
    const cousin = await stream({ tailscale: COUSIN_TS });
    // 대조: 이 PC의 루프백 주소로 목록 안의 사용자가 연 연결은 바뀐 뒤에도 받는다
    const local = await stream({ bearer: token, tailscale: OWNER_TS });
    expect([firstSnap(phone).auth.loggedIn, firstSnap(cousin).auth.loggedIn, firstSnap(local).auth.loggedIn]).toEqual([true, false, true]);
    await settle(phone, cousin, local);
    const counts = [phone.events.length, cousin.events.length];
    write({ owner: { tailscaleLogins: [OWNER_TS] } });
    const result = await admin('config.reload');
    expect(result.changes.map((c) => c.text)).toEqual(['공개 주소 → 없음 (이 PC 안에서만 받습니다)', '받는 Tailscale 사용자 → 켬 (1명)']);
    await sleep(300);
    expect([phone.ended(), cousin.ended(), local.ended()]).toEqual([true, true, false]);
    // 바뀐 뒤의 이벤트: 설정이 바꾼 스냅숏, 알림, 화면 이동 — 닫힌 연결에는 하나도 가지 않고, 아직 받는 연결에는 간다
    const mark = local.events.length;
    h.core.ctx.notify({ level: 'normal', title: '바뀐 뒤의 알림', body: '본문' });
    h.core.ctx.bus.emit('navigate', { tab: 'home' } as never);
    await local.waitFor((ev) => ev.slice(mark).some((e) => e.event === 'navigate') && ev.slice(mark).some((e) => e.event === 'notification'), '받는 연결의 이벤트', 10_000);
    await sleep(200);
    expect([phone.events.length, cousin.events.length]).toEqual(counts);
    expect(log.lines.filter((l) => l.includes('SSE 연결 닫음 (접속 허용이 바뀜 — 공개 주소·받는 Tailscale 사용자)'))).toHaveLength(2);
    expect(log.text()).toContain('접속 허용이 바뀌어 열린 SSE 연결 2개를 닫았습니다');
    // 새 요청도 그 자리에서 거부된다 (요청마다의 검사 — 그대로)
    expect((await httpCall({ url: server.url, path: '/api/events', headers: { Host: PUBLIC_HOST, 'Tailscale-User-Login': OWNER_TS } })).status).toBe(403);
    expect((await httpCall({ url: server.url, path: '/api/events', headers: { 'Tailscale-User-Login': COUSIN_TS } })).status).toBe(403);
  });

  it('config 명령(google-client-id)이 파일을 다시 읽어 공개 주소가 없어져도 열린 연결을 다시 본다 — 바뀌지 않는 연결은 그대로', async () => {
    write({ network: { publicOrigin: PUBLIC } });
    await admin('config.reload');
    const viaPublic = await stream({ host: PUBLIC_HOST, tailscale: COUSIN_TS });
    const viaLoopback = await stream({ tailscale: COUSIN_TS });
    await settle(viaPublic, viaLoopback);
    const count = viaPublic.events.length;
    // 운영자가 파일에서 공개 주소를 지우고, 다시 읽기 전에 config 명령을 낸다 — 그 명령도 파일을 다시 읽어 적용한다
    write({});
    const result = await admin('config.google-client-id', ['123-tv.apps.googleusercontent.com']);
    expect(result.changes.map((c) => c.item)).toEqual(['google.clientId', 'network.publicOrigin']);
    await sleep(300);
    expect([viaPublic.ended(), viaLoopback.ended()]).toEqual([true, false]);
    h.core.ctx.bus.emit('navigate', { tab: 'home' } as never);
    const mark = viaLoopback.events.length;
    h.core.ctx.bus.emit('openSettings', { section: 'account' });
    await viaLoopback.waitFor((ev) => ev.slice(mark).some((e) => e.event === 'openSettings'), '루프백 연결의 이벤트', 10_000);
    // 센 뒤에 더 받은 것이 없다 — 이벤트는 늘기만 하므로 '센 수 그대로'와 같은 단언이고, 실패하면 무엇이 끼었는지(이름·스냅숏 판)를 보인다. 전체 실행 부하 중에
    // 한 번 'expected 2 to be 1'로 실패했다 (KNOWN_ISSUES, 리드 결정 S5-90 5)
    expect(
      viaPublic.events.slice(count).map((e) => (e.event === 'snapshot' ? `snapshot v${(e.data.payload as AppSnapshot).version}` : e.event)),
      `센 수 ${count}, 첫 스냅숏 v${firstSnap(viaPublic).version}`,
    ).toEqual([]);
  });

  it('config owner-email도 파일을 다시 읽는다 — 그사이 공개 주소를 지웠으면 공개 주소로 연 연결이 닫히고, 루프백으로 연 연결은 그대로 받는다 (S3-40)', async () => {
    // 셋째 검토 tests-integrity의 프로브 zz-s3f2ti-owner-email-recheck: 이 명령에서 afterConfig를 빼도(변이 Z-SA7) 다른 시험이 모두 통과했다
    const google = { clientId: '123-tv.apps.googleusercontent.com' };
    const closedLines = () => log.lines.filter((l) => l.includes('접속 허용이 바뀌어 열린 SSE 연결 1개를 닫았습니다')).length;
    const before = closedLines();
    write({ network: { publicOrigin: PUBLIC }, google });
    await admin('config.reload');
    const viaPublic = await stream({ host: PUBLIC_HOST, tailscale: COUSIN_TS });
    const viaLoopback = await stream({ tailscale: COUSIN_TS });
    await settle(viaPublic, viaLoopback);
    const count = viaPublic.events.length;
    // 운영자가 파일에서 공개 주소를 지우고, 다시 읽기 전에 대표 이메일을 정한다 — 그 명령이 파일에 쓰고 통째로 다시 읽어 적용한다
    write({ google });
    const result = await admin('config.owner-email', ['owner@example.com']);
    expect(result.changes.map((c) => c.item)).toEqual(['owner.email', 'network.publicOrigin']);
    await sleep(300);
    expect([viaPublic.ended(), viaLoopback.ended()]).toEqual([true, false]);
    const mark = viaLoopback.events.length;
    h.core.ctx.bus.emit('navigate', { tab: 'home' } as never);
    h.core.ctx.bus.emit('openSettings', { section: 'account' });
    await viaLoopback.waitFor((ev) => ev.slice(mark).some((e) => e.event === 'navigate') && ev.slice(mark).some((e) => e.event === 'openSettings'), '루프백 연결의 이벤트', 10_000);
    await sleep(200);
    expect([viaPublic.events.length, viaLoopback.ended()]).toEqual([count, false]);
    expect(closedLines()).toBe(before + 1);
  });
});
