/**
 * 운영자 길 (SERVER_DESIGN 3.2 관리 채널, S2-2·S2-4): 서버를 띄운 운영자가 관리 채널(src/server/admin.ts)로 하는 일을 백엔드에서 처리한다.
 * - 대표 게이트(ownerGate.ts)를 거치지 않는다. 행위자는 operator — 상태 전이와 활동 기록에 그대로 남는다
 * - 프로세스 안에서만 쓰고 어떤 네트워크(IPC·HTTP·앱 도구 서버)에도 올리지 않는다
 * 명령은 긴급 정지·운영자 시험 세션(실제 기기 세션, S3-4)·상태 보기·운영자 설정 적용(server.json·대표 이메일·서버 구글 클라이언트, S3-8)·서버 구글 보안
 * 비밀·대표 이메일 설정 코드(S3-6)·메인 자리 보기와 운영자 배정(seat status·seat assign, S4-8)이다 (외부 에이전트는 7단계)
 */
import { OPERATOR } from '@shared/domain';
import type { Core } from '../orchestrator/core';
import { holderLabel } from '../orchestrator/seat';
import type { BackendOperator, SeatAssignReport } from './types';

/**
 * 운영자 배정의 답을 기다리는 상한 — 기다릴 것(나가는 메인 턴의 마무리 drainMs, 인계 메모 턴 2분)이 길면 진행 중으로 답하고 seat status로 보게 한다.
 * 강제 배정은 멈춘 턴의 종료 확인(약 3초)과 마무리를 넉넉히 덮는다
 */
const SEAT_ASSIGN_WAIT_MS = 20_000;

/** core는 부를 때 읽는다 — 조립 순서와 상관없이 만들 수 있다 */
export function createBackendOperator(getCore: () => Core): BackendOperator {
  return {
    emergencyStop: () => getCore().stops.emergency(OPERATOR),
    // 등록된 대표의 실제 기기 세션 — 개발 모드 로그인 길(kv auth.session)을 쓰지 않는다 (S3-4)
    openTestSession: () => getCore().auth.openTestSession(),
    note(text) {
      getCore().ctx.activity({ kind: 'system', actor: OPERATOR, text });
    },
    // 서버가 쥔 비밀 값 (관리 토큰 — S5-30) — 백엔드 가리개에만 넣는다
    registerSecret(value, kind) {
      getCore().ctx.redact.addSecret(value, kind);
    },
    status() {
      const ctx = getCore().ctx;
      const global = ctx.stop().global;
      const secrets = ctx.deps.secrets;
      return {
        emergencyStop: { active: global.active, since: global.active ? global.since : null },
        secretStore: { backend: secrets.backend, fallbackReason: secrets.fallbackReason ?? null },
        // 화면 조작의 마지막으로 안 상태 — 여기서는 화면 도우미를 띄우지 않는다 (리드 결정 S6-11)
        screen: getCore().desktop.prereq(),
      };
    },
    // 운영자 설정·서버 구글 보안 비밀·설정 코드 (S3-6·S3-8) — 서버의 대표 로그인(serverLogin.ts)이 처리하고 행위자 operator로 남긴다
    applyServerConfig: (values, origin) => getCore().serverLogin.applyServerConfig(values, origin),
    serverConfigState: () => getCore().serverLogin.status(),
    setGoogleClientSecret: (value) => getCore().serverLogin.setGoogleClientSecret(value),
    issueSetupCode: () => getCore().serverLogin.issueSetupCode(),
    // 메인 자리 (S4-8) — 운영자 배정은 바꾼 쪽 operator로 SeatService.assign을 거친다. 보기는 아무것도 바꾸지 않는다
    seatStatus: () => getCore().seat.operatorStatus(),
    async assignSeat(holder, force): Promise<SeatAssignReport> {
      const seat = getCore().seat;
      const before = seat.view();
      const r = seat.operatorAssign(holder, force);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([r.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, SEAT_ASSIGN_WAIT_MS)))]);
      clearTimeout(timer);
      const after = seat.operatorStatus();
      return {
        outcome: r.outcome,
        from: before.generation,
        generation: r.generation,
        previous: before.holder?.label ?? null,
        holder: (after.seat.state === 'switching' ? after.seat.pendingHolder?.label : after.seat.holder?.label) ?? holderLabel(null),
        force,
        state: after.seat.state,
        stage: after.swap?.stage ?? null,
        drainMs: after.policy.drainMs,
      };
    },
  };
}
