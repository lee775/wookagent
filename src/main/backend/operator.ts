/**
 * 운영자 길 (SERVER_DESIGN 3.2 관리 채널, S2-2·S2-4): 서버를 띄운 운영자가 관리 채널(src/server/admin.ts)로 하는 일을 백엔드에서 처리한다.
 * - 대표 게이트(ownerGate.ts)를 거치지 않는다. 행위자는 operator — 상태 전이와 활동 기록에 그대로 남는다
 * - 프로세스 안에서만 쓰고 어떤 네트워크(IPC·HTTP·앱 도구 서버)에도 올리지 않는다
 * 명령은 긴급 정지·운영자 시험 세션(실제 기기 세션, S3-4)·상태 보기·운영자 설정 적용(server.json·대표 이메일·서버 구글 클라이언트, S3-8)·서버 구글 보안
 * 비밀·대표 이메일 설정 코드(S3-6)·메인 자리 보기와 운영자 배정(seat status·seat assign, S4-8)·외부 에이전트 등록·폐기·목록(agent add|revoke|list, S7-2)·
 * AI의 API 키 넣기·지우기(secret set|clear claude-api-key|codex-api-key, S9-6 — 데스크톱의 settings.setApiKey와 같은 처리기를 행위자 operator로)다
 */
import { OPERATOR, type AiKind } from '@shared/domain';
import { createInternalApi } from '../orchestrator/api';
import type { Core } from '../orchestrator/core';
import { holderLabel } from '../orchestrator/seat';
import { BackendError, type ApiKeyReport, type ApiKeyState, type BackendOperator, type SeatAssignReport } from './types';

/** API 키로 받는 값의 모양 (S9-6) — 비었거나 너무 길거나 제어 문자가 있으면 넣지 않는다. 값은 되풀이하지 않는다 */
const API_KEY_MAX = 4096;

/** AI 하나의 API 키 상태 — 상태 확인용 메모리 사본(시작 때 OS 보안 저장소에서 채움, 넣고 지울 때 바꿈)으로 본다. 값은 내지 않는다 */
function apiKeyState(core: Core, kind: AiKind): ApiKeyState {
  return { registered: !!core.ctx.deps.apiKeys?.get(kind), authMode: core.ctx.settings().account.authMode[kind] };
}

/**
 * 운영자 배정의 답을 기다리는 상한 — 기다릴 것(나가는 메인 턴의 마무리 drainMs, 인계 메모 턴 2분)이 길면 진행 중으로 답하고 seat status로 보게 한다.
 * 강제 배정은 멈춘 턴의 종료 확인(약 3초)과 마무리를 넉넉히 덮는다
 */
const SEAT_ASSIGN_WAIT_MS = 20_000;

/** core는 부를 때 읽는다 — 조립 순서와 상관없이 만들 수 있다 */
export function createBackendOperator(getCore: () => Core): BackendOperator {
  // 운영자 내부 API (행위자 operator) — API 키는 데스크톱의 settings.setApiKey와 같은 처리기를 쓴다(저장소·사본·가리개·활동 기록이 한 곳에서). 처음 쓸 때 만든다
  let internal: ReturnType<typeof createInternalApi> | null = null;
  const api = (): ReturnType<typeof createInternalApi> => (internal ??= createInternalApi(getCore()));
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
    // config show의 API 키는 등록 여부와 인증 방식만 (S9-6)
    serverConfigState: () => ({ ...getCore().serverLogin.status(), apiKeys: { claude: apiKeyState(getCore(), 'claude'), codex: apiKeyState(getCore(), 'codex') } }),
    setGoogleClientSecret: (value) => getCore().serverLogin.setGoogleClientSecret(value),
    /**
     * AI의 API 키 (S9-6): 저장소 → 메모리 사본 → 가리개 → 활동 기록(settings.setApiKey — API 키 방식이면 재로그인 필요도 푼다) → API 키 방식이면 CLI 다시 확인.
     * 구독 방식이면 다시 확인하지 않는다 — 그 키는 턴에도 상태 확인에도 쓰이지 않는다(메인 에이전트가 account.authMode를 바꾸면 쓰인다)
     */
    async setApiKey(kind, value): Promise<ApiKeyReport> {
      if (kind !== 'claude' && kind !== 'codex') throw new BackendError('invalid_args', 'API 키는 claude·codex 가운데 하나에만 넣습니다');
      if (value !== null) {
        const v = value.trim();
        if (!v || v.length > API_KEY_MAX || /[\u0000-\u001f\u007f]/.test(v)) throw new BackendError('invalid', 'API 키가 비었거나 쓸 수 없는 글자가 있습니다 (값은 보이지 않습니다)');
      }
      const core = getCore();
      await api()['settings.setApiKey'](kind, value === null ? null : value.trim());
      const state = apiKeyState(core, kind);
      let recheck: ApiKeyReport['recheck'] = null;
      if (state.authMode === 'api_key') {
        await api()['system.recheckAi'](kind);
        const a = core.ctx.ai(kind);
        recheck = { authRequired: a.authRequired, detail: a.cliInstalled ? (a.cliProblem ?? `${kind} CLI${a.cliVersion ? ` ${a.cliVersion}` : ''}`) : '설치되지 않음' };
      }
      return { kind, ...state, recheck };
    },
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
    // 외부 에이전트 (S7-2·S7-3) — 등록·폐기는 이 길(관리 채널)뿐이다. 키 원문은 addExternalAgent의 반환값으로만 나간다
    addExternalAgent: (label) => getCore().externalAgents.add(label),
    revokeExternalAgent: (id) => getCore().externalAgents.revoke(id),
    listExternalAgents: () => getCore().externalAgents.list(),
  };
}
