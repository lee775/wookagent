/**
 * 데스크톱 길과 HTTP 길의 같은 대표 요청 (리드 결정 S3-13·S2-22, SERVER_DESIGN 3.4 — 리뷰 프로브 zz-lc2-parity를 옮김): 같은 백엔드를 데스크톱 IPC 길
 * (invokeCore 'IPC' → 데스크톱 게이트)과 서버 HTTP 길(원격 게이트, JSON)로 불러 값 자체를 견준다. 실패하는 요청의 오류도 같아야 한다.
 * 호출자 실수(옵션 객체를 빠뜨림, 형식이 다른 ID, 없는 대상)는 두 길 모두 400 invalid_args·404 not_found이고 500이 아니다 — 예전에는 처리기 안에서 터져
 * 500 internal과 스택 있는 ERROR 줄이 남았다. 바뀌는 칸(스냅숏 판 번호·만든 시각)은 숨기지 않고 목록으로 뺀다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSnapshot } from '@shared/views';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { createInvokeCore } from '../../src/main/backend/invokeCore';
import { startServer, type RunningServer } from '../../src/server/server';
import { invokeHttp, memoryLogger, remoteBackendOf } from './helpers';
import { TEST_OWNER_RECORD } from './ownerServer';

let h: Harness;
let server: RunningServer;
let token = '';
const httpLog = memoryLogger();
const ipcLog = memoryLogger();

beforeAll(async () => {
  // 데스크톱 길을 같이 부르려고 데스크톱 모드 하네스(개발 모드로 로그인한 대표) — HTTP 길은 그 대표의 기기 세션으로 원격 게이트를 돈다
  h = await createHarness({ team: ['developer'] });
  // 기기 세션은 등록된 대표(구글 계정)의 것이다 — 데스크톱의 개발 모드 로그인은 그대로 로그인이다
  h.core.ctx.store.kv.set('owner', { ...TEST_OWNER_RECORD, registeredAt: h.core.ctx.now(), lastLoginAt: null });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: httpLog, version: 'test' });
  token = h.core.deviceSessions.issue({ deviceName: '견주기' }).token;
  await sendCommand(h, '카페 게임 첫 화면을 만들어 줘. 메뉴판 디자인, 주문 버튼, 기본 테스트까지 포함해서.');
  // 보고서를 내면(submit_report) 지시는 곧바로 확인 대기가 되지만 그 보고 턴은 조금 더 돌다 끝난다 — 그 사이에 두 길을 차례로 부르면 앞의 길은 메인이 일하는
  // 중, 뒤의 길은 쉬는 중을 보아 스냅숏이 달랐다(전체 시험의 부하에서 — S3F4 보고). 같은 상태를 견주도록 하던 일이 모두 끝날 때까지 기다린다
  await h.waitFor(() => (h.core.views.snapshot() as AppSnapshot).directives.some((d) => d.state === 'awaiting_confirmation') && !h.orch.backend.hasActiveWork(), {
    timeoutMs: 180_000,
    label: '보고와 그 턴의 끝',
  });
}, 240_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
});

/** 두 값의 다른 곳 (경로: 값 vs 값) */
function diff(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (out.length > 20) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  if (typeof a !== 'object' || a === null) {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
  return out;
}

/** 스냅숏 판 번호·만든 시각처럼 부를 때마다 바뀌는 칸 */
const VOLATILE = /^\$\.value\.(version|generatedAt):/;
/**
 * 길마다 다른 것이 맞는 칸 — 로그인 상태는 그 호출자 것이다(S3-3): 원격 호출자는 `mode: 'server'`, 개발 모드 로그인·로그인 전 구글 설정 길이 없다.
 * 숨기지 않고 정확히 이것만 다른지 본다
 */
const PER_SURFACE = [
  'auth.getState: $.value.devLoginAllowed: true vs false',
  'auth.getState: $.value.googleSetupOpen: true vs false',
  'auth.getState: $.value.mode: undefined vs "server"',
  'snapshot.get: $.value.auth.devLoginAllowed: true vs false',
  'snapshot.get: $.value.auth.googleSetupOpen: true vs false',
  'snapshot.get: $.value.auth.mode: undefined vs "server"',
];

describe('데스크톱 길과 HTTP 길의 같은 요청 (S3-13)', () => {
  it('보기 값과 실패 오류가 두 길에서 같다 — 없는 보고서는 404 not_found, 옵션 객체를 빠뜨린 호출은 400 invalid_args (예전 500 internal)', async () => {
    const snap = h.core.views.snapshot() as AppSnapshot;
    const did = snap.directives[0]!.id;
    const task = h.core.ctx.store.tasks.list()[0];
    const report = h.core.ctx.store.reports.list({ ref1: did })[0];
    expect([!!task, !!report]).toEqual([true, true]);
    const dev = h.members.developer!;
    const calls: [string, unknown[]][] = [
      ['auth.getState', []],
      ['snapshot.get', []],
      ['members.getDetail', [dev]],
      ['members.getEvents', [dev, {}]],
      ['command.history', [h.projectId, {}]],
      ['directives.get', [did]],
      ['tasks.get', [task!.id]],
      ['tasks.getDiff', [task!.id]],
      ['reports.list', [{}]],
      ['reports.get', [report!.id]],
      ['notifications.list', [{}]],
      ['recovery.list', []],
      ['settings.get', []],
      ['logs.search', [{}]],
      ['system.info', []],
      ['members.getDetail', ['M-9999']],
      ['tasks.get', ['T-99999']],
      ['reports.get', ['R-99999']],
      ['members.getEvents', [dev]],
    ];
    const invokeIpc = createInvokeCore({ backend: h.orch.backend, logger: ipcLog, channel: 'IPC' });
    const differences: string[] = [];
    const codes: string[] = [];
    for (const [m, args] of calls) {
      const raw = await invokeIpc(m, args);
      // IPC 값은 구조화 복제를 건너온다 — JSON 모양으로 견준다
      const ipc = raw.ok ? { ok: true, value: JSON.parse(JSON.stringify(raw.value) ?? 'null') } : raw;
      const r = await invokeHttp(server.url, token, m, args);
      const http = r.json<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>();
      if (http.ok && !('value' in http)) http.value = null;
      differences.push(...diff(ipc, http).filter((d) => !VOLATILE.test(d)).map((d) => `${m}: ${d}`));
      if (!http.ok) codes.push(`${m} ${JSON.stringify(args)} → ${r.status} ${http.error?.code}`);
    }
    expect(differences).toEqual(PER_SURFACE);
    expect(codes).toEqual([
      'members.getDetail ["M-9999"] → 404 not_found',
      'tasks.get ["T-99999"] → 404 not_found',
      'reports.get ["R-99999"] → 404 not_found',
      `members.getEvents ["${dev}"] → 400 invalid_args`,
    ]);
  }, 120_000);

  it('호출자 실수는 HTTP에서 400·404이고 500이 아니다 — 서버 기록과 데스크톱 기록에 스택 있는 ERROR 줄이 남지 않는다', async () => {
    const dev = h.members.developer!;
    const mistakes: [string, unknown[], number, string][] = [
      ['members.getEvents', [dev], 400, 'invalid_args'],
      ['members.getEvents', [dev, null], 400, 'invalid_args'],
      ['command.history', [h.projectId], 400, 'invalid_args'],
      ['notifications.list', [], 400, 'invalid_args'],
      ['reports.list', [], 400, 'invalid_args'],
      ['logs.search', [], 400, 'invalid_args'],
      ['members.getDetail', [42], 400, 'invalid_args'],
      ['reports.get', ['R-99999'], 404, 'not_found'],
      ['reports.markRead', ['R-99999'], 404, 'not_found'],
      ['directives.get', ['D-99999'], 404, 'not_found'],
      ['tasks.getDiff', ['T-99999'], 404, 'not_found'],
      ['members.getEvents', ['M-9999', {}], 404, 'not_found'],
      ['command.history', ['P-9999', {}], 404, 'not_found'],
      ['notifications.markRead', ['N-999999'], 404, 'not_found'],
    ];
    const got: string[] = [];
    const invokeIpc = createInvokeCore({ backend: h.orch.backend, logger: ipcLog, channel: 'IPC' });
    for (const [m, args] of mistakes) {
      const r = await invokeHttp(server.url, token, m, args);
      const ipc = await invokeIpc(m, args);
      got.push(`${m} ${JSON.stringify(args)} → ${r.status} ${r.json<{ error?: { code: string } }>().error?.code} / IPC ${ipc.ok ? 'ok' : ipc.error.code}`);
    }
    expect(got).toEqual(mistakes.map(([m, args, status, code]) => `${m} ${JSON.stringify(args)} → ${status} ${code} / IPC ${code}`));
    // 없는 보고서의 글은 사람이 읽는 말이다 (저장소의 표 이름이 아니다)
    expect((await invokeHttp(server.url, token, 'reports.get', ['R-99999'])).json()).toEqual({ ok: false, error: { code: 'not_found', message: '보고서 R-99999을(를) 찾을 수 없습니다' } });
    const errorLines = [...httpLog.lines, ...ipcLog.lines].filter((l) => l.startsWith('[ERROR]') || /\n\s+at /.test(l));
    expect(errorLines).toEqual([]);
  });
});
