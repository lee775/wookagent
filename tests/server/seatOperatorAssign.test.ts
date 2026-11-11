/**
 * 운영자의 메인 자리 배정 (SERVER_DESIGN 4.4·10.4 seatOperatorAssign, 리드 결정 S4-8):
 * - `seat assign <보유자> [--force]`는 서로 증명한(S3-16) 관리 채널로만 된다 — 증명하지 못한 연결·대표의 길은 아무것도 바꾸지 않는다
 * - 배정은 SeatService.assign을 거치고 바꾼 쪽 operator로 남는다(이력·활동 기록·메인 일지·인계 꾸러미·대표 알림). 이전 보유자의 응답 없음은 새 세대에
 *   넘기지 않고, 그 사실이 까닭에 남는다
 * - --force는 실행 중인 메인 턴을 바로 멈추고 마무리 기다림(drainMs)과 인계 메모 턴을 건너뛴다
 * - seat status는 보기만 한다. 외부 보유자(이 하네스는 데스크톱 모드 — 서버의 외부 보유자 판정은 seatExternalHolder)·모양이 틀린 표기·이미 앉은 보유자·
 *   멈춘 교체는 참인 글로 거부한다
 * 오케스트레이터는 가짜 CLI 하네스(bootOrch)이고, 서버(관리 채널)는 프로세스 안에서 그 백엔드를 감싸 연다
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAIN_AGENT_ID, OPERATOR } from '@shared/domain';
import { adminRequest, adminTokenPath, ADMIN_UNAUTHORIZED, type AdminReply } from '../../src/server/admin';
import { startServer, type RunningServer, type ServerBackend } from '../../src/server/server';
import { createBackendOperator } from '../../src/main/backend/operator';
import { SEAT_EXTERNAL_DESKTOP, SEAT_HOLDER_SHAPE } from '../../src/main/orchestrator/seat';
import type { SeatAssignReport, SeatOperatorStatus } from '../../src/main/backend/types';
import { bootOrch, notices, waitFor, type OrchEnv } from '../regression/orchHarness';
import { adminHandshake, memoryLogger } from './helpers';

let e: OrchEnv;
let server: RunningServer;
const log = memoryLogger();
const KEY = 'main:general';

/** createBackend와 같은 조립 — 하네스의 백엔드 + 운영자 길 + 기기 세션·파일 */
function serverBackendOf(env: OrchEnv): ServerBackend {
  const b = env.orch.backend;
  return {
    invoke: b.invoke,
    onTopicRaw: b.onTopicRaw,
    topicFor: b.topicFor,
    snapshotFor: b.snapshotFor,
    hasActiveWork: b.hasActiveWork,
    operator: createBackendOperator(() => env.core),
    sessions: env.core.deviceSessions,
    files: env.core.serverFiles,
  };
}

beforeEach(async () => {
  e = await bootOrch();
  server = await startServer({ backend: serverBackendOf(e), dataDir: e.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test' });
}, 120_000);

afterEach(async () => {
  await server?.close();
  await e?.close();
});

const fingerprint = (): string =>
  JSON.stringify({ seat: e.ctx.store.seat.get('main'), history: e.ctx.store.seatHistory.list(), packets: e.ctx.store.seatHandovers.list(), mainAi: e.ctx.store.members.require(MAIN_AGENT_ID).ai });
const seatActivity = () => e.ctx.store.activity.search({ kinds: ['seat'], limit: 100 });
const ok = <T>(r: AdminReply): T => {
  if (!r.ok) throw new Error(`관리 채널 거부 ${r.error.code}: ${r.error.message}`);
  return r.result as T;
};
const assign = (...args: string[]) => adminRequest({ dataDir: e.dataDir, command: 'seat.assign', args });

describe('운영자의 메인 자리 배정 (seatOperatorAssign)', () => {
  it('관리 채널로만 된다 — 증명하지 못한 연결과 대표의 길은 아무것도 바꾸지 않고, 증명한 배정은 바꾼 쪽 operator로 남으며 응답 없음을 넘기지 않는다', async () => {
    // 응답 없는 보유자 (사용량 한도로 메인 턴이 연달아 3번 끝남)
    for (let i = 0; i < 3; i++) e.core.seat.noteMainTurnEnd(1, 'usage_limit');
    expect(e.core.seat.view().unresponsiveReason).toBe('사용량 한도로 메인 턴이 3번 연달아 끝났습니다');
    const before = fingerprint();
    const real = readFileSync(adminTokenPath(e.dataDir), 'utf8');
    const wrong = `${real.slice(0, -2)}${real.endsWith('AA') ? 'BB' : 'AA'}`;
    // 틀린 토큰으로 만든 증명 — 아무것도 하지 않는다 (S3-16)
    expect((await adminHandshake(server.adminEndpoint, { proofToken: wrong, command: 'seat.assign', args: ['launched:codex', '--force'] })).reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    // 대표의 길(데스크톱 IPC 게이트)에는 자리를 바꾸는 이름이 없다
    const ownerInvoke = e.orch.backend.invoke as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    await expect(ownerInvoke('seat.assign', ['launched:codex'])).rejects.toMatchObject({ code: expect.stringMatching(/^(forbidden|not_found)$/) });
    expect(fingerprint()).toBe(before);
    expect(log.text()).toContain('관리 채널: 관리 토큰이 없거나 맞지 않아 연결을 끊었습니다 (명령 seat.assign)');

    // 증명한 운영자 배정: 나가는 모의 Claude 메인의 인계 메모 턴(곧 끝남)을 거쳐 넘어간다
    const r = ok<SeatAssignReport>(await assign('launched:codex'));
    expect(r).toMatchObject({ outcome: 'swap', from: 1, generation: 2, previous: 'Claude CLI', holder: 'Codex CLI', force: false, state: 'active', stage: null });
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI', ai: { kind: 'codex' } }, unresponsiveSince: null, unresponsiveReason: null });
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('codex');
    expect(e.core.seat.history().map((h) => [h.generation, h.changedBy])).toEqual([
      [2, 'operator'],
      [1, 'server'],
    ]);
    const why = '운영자 복구 배정 (wook-server seat assign) — 이전 보유자가 응답하지 않음';
    expect(e.core.seat.history()[1]!.endReason).toBe(`운영자가 바꿈: ${why}`);
    const start = seatActivity().find((x) => x.text.startsWith('메인 자리 교체 시작'))!;
    expect([start.actor, start.text]).toEqual([OPERATOR, `메인 자리 교체 시작: Claude CLI → Codex CLI (세대 1 → 2, 운영자가 바꿈) — ${why}`]);
    expect(seatActivity().find((x) => x.text.startsWith('메인 자리 교체 끝'))!.actor).toBe(OPERATOR);
    expect(e.ctx.store.journal.query({ kinds: ['seat'] }).map((j) => j.text)).toContain(start.text);
    expect(e.core.seat.handover(2)!.sections[0]!.lines.slice(1, 3)).toEqual(['바꾼 쪽: 운영자', `까닭: ${why}`]);
    expect(notices(e, '메인 에이전트가 바뀌었습니다').map((n) => n.body)).toEqual([
      `이제 Codex CLI가 메인 에이전트입니다 (세대 2, 이전 Claude CLI). 운영자가 바꿨습니다 — 까닭: ${why}. 쌓여 있던 명령은 새 메인 에이전트가 이어서 처리합니다`,
    ]);
    // 새 세대의 응답 없음은 처음부터 센다
    expect(e.ctx.store.seat.get('main')).toMatchObject({ unresponsiveStreak: [], unresponsiveNotices: 0 });
    expect(log.text()).toContain('[INFO] 관리 채널: seat.assign 처리');

    // seat status는 보기만 한다
    const printed = fingerprint();
    const st = ok<SeatOperatorStatus>(await adminRequest({ dataDir: e.dataDir, command: 'seat.status' }));
    expect(st).toMatchObject({ seat: { generation: 2, state: 'active', holder: { label: 'Codex CLI' } }, unresponsiveForMs: null, swap: null, policy: { holders: ['launched:claude', 'launched:codex', 'external:*'], drainMs: 120_000 } });
    expect(st.history.map((h) => [h.generation, h.changedBy])).toEqual([
      [2, 'operator'],
      [1, 'server'],
    ]);
    expect(fingerprint()).toBe(printed);
  });

  it('--force: 실행 중인 메인 턴을 바로 멈추고 마무리 기다림과 인계 메모 턴을 건너뛴다', async () => {
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 600_000, initialHolder: null }, '시험');
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '긴 일을 하는 중' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const proc = e.liveProc(KEY, MAIN_AGENT_ID)!;
    const t0 = Date.now();
    const r = ok<SeatAssignReport>(await assign('launched:codex', '--force'));
    // 마무리 시간(10분)을 기다리지 않았다
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r).toMatchObject({ outcome: 'swap', from: 1, generation: 2, holder: 'Codex CLI', force: true, state: 'active', drainMs: 600_000 });
    expect(proc.terminatedByApp).toBe(true);
    const turns = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    // 인계 메모 턴은 없다 — 멈춘 그 턴 하나뿐
    expect(turns.map((t) => [t.aiKind, t.endReason, t.endDetail])).toEqual([['claude', 'user_stop', '메인 자리 교체(세대 2) — 운영자가 바로 멈춤']]);
    expect(seatActivity().map((x) => x.text)).toContain('메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 운영자 강제 교체');
    expect(seatActivity().find((x) => x.text.startsWith('메인 자리 교체 시작'))!.text).toBe(
      '메인 자리 교체 시작: Claude CLI → Codex CLI (세대 1 → 2, 운영자가 바꿈, 강제) — 운영자 복구 배정 (wook-server seat assign --force)',
    );
    expect(e.core.seat.handover(2)!.sections[0]!.lines[1]).toBe('바꾼 쪽: 운영자 (강제 — 마무리를 기다리지 않음)');
    // 멈춘 턴이 실었던 명령은 새 보유자에게 간다
    e.hold.clear();
    await e.drain(1);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).map((t) => [t.aiKind, t.endReason])).toEqual([
      ['claude', 'user_stop'],
      ['codex', 'completed'],
    ]);
  });

  it('외부 보유자·모양이 틀린 표기·이미 앉은 보유자·멈춘 교체는 참인 글로 거부하고 아무것도 바꾸지 않는다 — 틀린 표기는 되풀이하지 않는다', async () => {
    const before = fingerprint();
    const refusals: [string[], string, string][] = [
      // 이 하네스는 데스크톱 모드다 — 데스크톱 앱은 외부 에이전트를 앉히지 않는다 (리드 결정 S7-1)
      [['external:X-0001'], 'forbidden', SEAT_EXTERNAL_DESKTOP],
      [['external:*'], 'invalid_args', 'external:*는 앉을 수 있는 보유자 목록(seat.holders)에 쓰는 표기입니다 — 앉힐 보유자 하나를 적으세요 (launched:claude·launched:codex·external:<ID>)'],
      [['GOCSPX-seat-echo-mark'], 'invalid_args', SEAT_HOLDER_SHAPE],
      [['launched:claude'], 'conflict', '메인 자리에는 이미 Claude CLI가 같은 설정으로 앉아 있습니다(세대 1)'],
      [['launched:codex', 'force'], 'invalid_args', 'seat assign 뒤에는 보유자 하나(launched:claude·launched:codex·external:<ID>)와 --force(고를 때만)를 적습니다'],
      [[], 'invalid_args', 'seat assign 뒤에는 보유자 하나(launched:claude·launched:codex·external:<ID>)와 --force(고를 때만)를 적습니다'],
    ];
    for (const [args, code, message] of refusals) expect([args, await assign(...args)]).toEqual([args, { ok: false, error: { code, message } }]);
    expect(fingerprint()).toBe(before);
    expect(log.text().includes('GOCSPX-seat-echo-mark')).toBe(false);

    // 멈춘 교체(나가는 턴의 종료를 확인하지 못함): 운영자의 강제 배정도 받지 않는다 — 출구는 대표의 정지 해제다
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 50, initialHolder: null }, '시험');
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '명령' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    e.liveProc(KEY, MAIN_AGENT_ID)!.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    const stuck = ok<SeatAssignReport>(await assign('launched:codex'));
    expect(stuck).toMatchObject({ outcome: 'swap', generation: 2, state: 'switching', stage: 'unconfirmed', holder: 'Codex CLI' });
    expect(await assign('launched:claude', '--force')).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: "메인 자리 교체가 멈춰 있습니다(세대 1 → 2, 나가는 메인 턴의 종료를 확인하지 못함) — 남은 프로세스가 모두 사라졌는지 확인한 뒤 대표가 '정지 해제'를 누르면 Codex CLI에게 넘어갑니다",
      },
    });
    const st = ok<SeatOperatorStatus>(await adminRequest({ dataDir: e.dataDir, command: 'seat.status' }));
    expect(st).toMatchObject({ seat: { state: 'switching', pendingHolder: { label: 'Codex CLI' } }, swap: { from: 1, to: 2, by: 'operator', force: false, stage: 'unconfirmed' } });
    await e.invoke('stop.release');
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
  });
});
