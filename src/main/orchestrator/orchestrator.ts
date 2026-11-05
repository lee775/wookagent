/**
 * 오케스트레이터 시작·종료와 Backend(껍데기 경계) 구현.
 */
import { mkdirSync } from 'node:fs';
import type { AppSnapshot, AuthState, EmergencySummary, TrayStatus } from '@shared/views';
import { LOCKED_SEAT } from '@shared/views';
import type { WookTopic, WookTopics } from '@shared/ipc';
import { OWNER, type AiKind, type NavTarget } from '@shared/domain';
import type { Backend } from '../backend/types';
import { createOwnerInvoke } from '../backend/ownerGate';
import type { ToolCallLog } from '../mcp/types';
import { SECRET_KEYS } from '../auth/types';
import type { OrchestratorDeps } from './context';
import { Core } from './core';
import { defaultRoles } from './defaults';
import { backupNow } from './api';
import { purgeToolCache, safeRequestId } from './tools';
import { backfillRoleCreators, migrateOwnerPowers, migrateOwnerReviewers } from './migrations';
import { noticeMockOn, resetExecutionOutOfRange } from './settingsPolicy';
import { loginStateForAuth } from '../auth/apiKeys';
import { isOwnLoginNotice } from './serverLogin';
import { settleMainWork } from './mainWork';

/**
 * 앱 종료 때 멈춘 턴의 마무리와 진행 중인 프로그램 작업(제출 처리·병합·되돌리기·자동 검사·프로젝트 잠금·작업 취소·완료 마무리·프로젝트 등록)을 기다리는 상한 — 넘기면 남은 작업은
 * 다음 단계에서 멈추고(그때 저장소를 닫는다) 남은 기록은 다음 시작의 복구가 맞춘다. 셸의 종료 상한(30초) 안에 끝나게 잡는다
 */
const SHUTDOWN_DRAIN_MS = 15_000;
const SHUTDOWN_POLL_MS = 25;

export interface Orchestrator {
  core: Core;
  backend: Backend;
  stop(): Promise<void>;
}

export async function createOrchestrator(deps: OrchestratorDeps): Promise<Orchestrator> {
  const core = new Core(deps);
  const ctx = core.ctx;

  // 대표가 등록해 둔 비밀 값(API 키·구글 보안 비밀)을 가리개에 다시 넣는다. 가리개는 시작마다 새로 만들어지므로 넣지 않으면 재시작 뒤
  // 형식 규칙에 없는 등록 값이 CLI 출력·기록·검색·백업·로그에 원문으로 남는다 (SEC-09·10, AC-20). 로그 파일 가리개도 같은 개체다.
  // 복구·앱 도구 서버·첫 턴보다 먼저 한다
  await registerStoredSecrets(ctx);
  // 등록됨으로 적힌 구글 보안 비밀이 OS 보안 저장소에 없으면(저장소가 지워짐) 등록 안 됨으로 맞춘다 — 로그인 화면이 설정을 다시 받게 (AC-01)
  await core.auth.syncSecretFlag();
  // 서버: 서버 구글 로그인 보안 비밀도 같다 (S3-8, serverLogin.ts) — 데스크톱은 이 값을 쓰지 않는다
  if (deps.mode === 'server') await core.serverLogin.syncSecretFlag();
  // v0.6 권한 모델로 저장된 데이터를 옮긴다 (대표 고정 값 지우기 등) — 시작마다 돌고, 이미 옮긴 데이터는 그대로 둔다
  migrateOwnerPowers(ctx);
  // 5단계 전에 저장된 역할에 만든 쪽(createdBy)을 채운다 — 멱등 (리드 결정 S5-12). 빈 DB의 기본 역할은 아래 defaultRoles가 'seed'로 넣는다
  backfillRoleCreators(ctx);

  // ───── 기본 데이터 ─────
  for (const dir of Object.values(ctx.paths)) {
    // 예전 메인 에이전트 폴더(<dataDir>/main-agent)는 새 작업 폴더를 받았으면 만들지 않는다 — 있던 것은 지우지 않는다 (리드 결정 S5-20)
    if (dir.endsWith('.db') || (dir === ctx.paths.mainAgent && deps.mainWorkDir)) continue;
    mkdirSync(dir, { recursive: true });
  }
  if (ctx.store.roles.count() === 0) for (const r of defaultRoles(ctx.now())) ctx.store.roles.insert(r);
  if (!ctx.store.kv.get('settings')) ctx.saveSettings(ctx.settings());
  // 범위 밖의 실행 설정(검사가 생기기 전에 저장된 턴 시간 상한 0 등)은 기본값으로 되돌린다 — 재시작 복구·첫 턴보다 먼저 (리드 결정 15, 멱등)
  resetExecutionOutOfRange(ctx);
  // 설치된 앱에서 모의 실행이 켜져 있으면 설치 설정에서 끌 수 있다고 한 번 알린다 (리드 결정 23, 멱등)
  noticeMockOn(ctx);
  // 메인 자리: 앞 판 DB면 운영 설정의 메인 AI로 1세대를 채우고, 새 DB면 처음 보유자를 앉힌다 (리드 결정 S4-12). M-MAIN의 AI는 자리 보유자를 따른다 —
  // M-MAIN이 있는지로 앞 판 DB를 가리므로 ensureMainAgent보다 먼저
  core.seat.init();
  core.team.ensureMainAgent();
  // 대표 검수 작업을 메인 에이전트 검수로 옮긴다 (M-MAIN이 있어야 한다, 재시작 복구 전) — 이미 옮겼으면 아무것도 하지 않는다
  migrateOwnerReviewers(core);
  core.memory.ensure(null, '일반');
  // 메인 에이전트 작업 폴더 — 데이터 폴더 밖, 시작 때만 정하고 확인한다 (SERVER_DESIGN 3.7, 리드 결정 S5-20). 서버는 확인에 걸리면 시작하지 않는다(1) —
  // 열어 둔 저장소·러너를 닫고 던진다. 데스크톱은 예전 폴더를 쓴다
  try {
    settleMainWork(core);
  } catch (e) {
    try {
      deps.runner.dispose?.();
    } finally {
      ctx.store.close();
    }
    throw e;
  }
  try {
    await deps.git.ensureRepo(core.mainWork.dir, { init: true, identity: { name: '욱채', email: 'wook@wook.local' } });
  } catch (e) {
    ctx.log('warn', '메인 에이전트 폴더 git 초기화 실패', e);
  }

  // ───── 앱 도구 서버 (루프백) ─────
  core.toolServer = deps.createToolServer({
    handler: core.tools.handle,
    onCall: (c: ToolCallLog) => {
      const rejected = !c.result.ok;
      ctx.activity({
        kind: 'app_tool',
        level: rejected ? 'warn' : 'info',
        actor: c.identity?.memberId ?? 'system',
        memberId: c.identity?.memberId ?? null,
        // 메인 에이전트는 팀원 프로젝트가 없다 — 그 턴의 작업 키 프로젝트(main:P → P)로 남겨 프로젝트별 기록 찾기에 나온다 (SERVER_DESIGN 5.4, 리드 결정 S5-5)
        projectId: c.identity?.projectId ?? c.identity?.workProjectId ?? null,
        sessionId: c.identity?.sessionId ?? null,
        turnId: c.identity?.turnId ?? null,
        // 처리기와 같은 저장용 요청 ID (비밀 값이 섞였으면 해시) — 거부된 요청의 원래 인자가 활동 기록에 남지 않게 (SEC-10, AC-20)
        requestId: typeof c.args.request_id === 'string' ? safeRequestId(ctx.redact, c.args.request_id) : null,
        text: `${c.tool}${rejected ? ' 거부' : ''}`,
        result: c.result.ok ? null : c.result.message,
      });
    },
  });
  await core.toolServer.start();

  // ───── 실행 환경 문제 (ENV 사전 조건, CTL-11) ─────
  // taskkill 방식에서 작업 개체 도우미(Windows PowerShell)를 쓸 수 없으면 CLI가 띄운 하위 프로세스의 종료를 확인하지 못해, 턴·자동 검사가
  // 끝날 때마다 그 일을 멈추게 된다 (종료를 확인하지 못한 실행에 새 프로세스를 겹쳐 띄우지 않음). 그 까닭과 할 일을 한 번 알린다 — 같은 key의
  // 읽지 않은 알림은 갱신된다. 설정 화면의 실행 도구 줄(system.prereqs.jobRunner)에도 같은 까닭이 보인다
  // 보류한 작업과 일시정지한 팀원은 메인 에이전트에게 넘어간다(알림 업무·재개 업무 — 리드 결정 26·S5-7). 대표의 길은 모드마다 다르다 (리드 결정 S4-20·S5-9):
  // 데스크톱은 이 PC의 작업 관리자와 앱 다시 시작, 서버는 서버 PC를 보는 운영자의 몫이다
  const server = deps.mode === 'server';
  const runnerProblem = (problem: string): void => {
    ctx.notify({
      level: 'urgent',
      title: '하위 프로세스 종료를 확인할 수 없음',
      body: `작업 개체 도우미를 쓸 수 없습니다: ${problem}. 이 상태에서는 턴·자동 검사가 끝날 때마다 하위 프로세스가 모두 끝났는지 확인하지 못해 그 작업을 보류(관리 업무는 팀원 일시정지)하고 메인 에이전트에게 넘깁니다 — 메인 에이전트가 남은 프로세스를 확인하고 이어 갑니다(자동 검사는 다시 돌리지 않고 그 결과로). 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트 자신이 일시정지됐으면 ${
        server ? '서버 PC에 남은 프로세스가 없는지 확인한 뒤(서버 PC를 직접 볼 수 없으면 서버 PC의 운영자에게 확인을 부탁하세요)' : '작업 관리자 등에서 남은 프로세스가 없는지 확인한 뒤'
      } '정지 해제'를 누르세요. ${
        server
          ? '고치려면 서버 PC의 운영자가 Windows PowerShell을 쓸 수 있게(전체 언어 모드) 하거나 작업 개체 러너(csc.exe 컴파일)를 쓸 수 있게 한 뒤 서버를 다시 시작해야 합니다'
          : 'Windows PowerShell을 쓸 수 있게(전체 언어 모드) 하거나 작업 개체 러너(csc.exe 컴파일)를 쓸 수 있게 한 뒤 앱을 다시 시작하세요'
      }`,
      link: { tab: 'settings', section: 'account' },
      key: 'runner-problem',
    });
    ctx.activity({ kind: 'system', level: 'error', text: `실행 환경 문제: 작업 개체 도우미를 쓸 수 없음 — ${problem}` });
  };
  const offRunnerProblem = deps.runner.onProblem?.(runnerProblem) ?? null;
  const startupProblem = deps.runner.problem?.() ?? null;
  if (startupProblem) runnerProblem(startupProblem);

  // ───── 재시작 복구 → 실행 시작 ─────
  await core.recovery.run();
  // 앞 실행이 끝내지 못한 메인 자리 교체를 이어 간다 — 복구가 남은 턴을 맞춘 뒤, 스케줄러보다 먼저 (4.3)
  core.seat.resumeAfterRestart();
  core.started = true;
  core.turns.start();
  core.scheduler.start();

  // CLI 확인은 시작을 막지 않는다. 로그인 상태도 맞춘다 — 확인되면(true) 재로그인 필요를 풀고, 로그인 필요(false)면 걸되 처음 걸린 때는 그대로 두며,
  // 알 수 없으면(null) 그대로 둔다 (리드 결정 7). 예전에는 재로그인 필요가 재시작으로도 풀리지 않아, 메인 에이전트의 AI 종류에 걸리면 메인이 영영 막혔다.
  // API 키 방식이고 키가 등록돼 있으면 로그인 필요(false)도 알 수 없음으로 본다 — 키가 맞는지는 실제 턴만 안다 (리드 결정 16, loginStateForAuth)
  void (async () => {
    for (const kind of ['claude', 'codex'] as const) {
      try {
        const st = await deps.adapters[kind].detect();
        const loggedIn = await loginStateForAuth(kind, st.loggedIn, ctx.settings().account.authMode[kind], deps.secrets);
        const a = ctx.ai(kind);
        const problem = st.installed ? st.problem : '설치되지 않음';
        const auth =
          loggedIn === true
            ? { authRequired: false, authRequiredSince: null }
            : loggedIn === false
              ? { authRequired: true, authRequiredSince: a.authRequiredSince ?? ctx.now() }
              : { authRequired: a.authRequired, authRequiredSince: a.authRequiredSince };
        ctx.saveAi({ ...a, ...auth, cliInstalled: st.installed, cliVersion: st.version, cliProblem: problem, checkedAt: ctx.now() });
        if (a.authRequired && !auth.authRequired) {
          ctx.activity({ kind: 'auth', text: `${kind} CLI 로그인 확인 (시작 때 확인) — 재로그인 필요를 풂` });
          ctx.bus.signal('tick');
        }
        // 검증된 버전 범위 밖이거나 해석 불가 → 해당 AI 종류의 새 작업을 멈추고 긴급 알림 (CLI-15)
        if (problem) {
          ctx.notify({ level: 'urgent', title: `${kind} CLI 확인 필요`, body: problem, link: { tab: 'settings', section: 'account' }, key: `cli-problem:${kind}` });
        }
      } catch (e) {
        ctx.log('warn', `${kind} CLI 확인 실패`, e);
      }
    }
  })();

  // 활동 기록 보관 기간 정리 (LOG-03)
  const purge = () => {
    const days = ctx.settings().logs.retentionDays;
    const cutoff = new Date(ctx.clock.ms() - days * 24 * 3600_000).toISOString();
    const n = ctx.store.activity.purgeOlderThan(cutoff);
    if (n) ctx.log('info', `활동 기록 ${n}건 정리 (${days}일 경과)`);
    // 도구 중복 캐시는 7일 보관한다 (리드 결정 S4-4)
    const cached = purgeToolCache(ctx);
    if (cached) ctx.log('info', `도구 중복 캐시 ${cached}건 정리 (7일 경과)`);
    // 30일 지난 메인 일지의 서버 기록은 월별 묶음으로 줄인다 (SERVER_DESIGN 6.3, S4b) — 원본은 백업에 남는다
    try {
      const rolled = core.journal.rollup();
      if (rolled) ctx.log('info', `메인 일지 서버 기록 ${rolled}건을 월별 묶음으로 줄임 (30일 경과)`);
    } catch (e) {
      ctx.log('warn', '메인 일지 월별 묶음 실패 — 다음 정리 때 다시 합니다', e);
    }
  };
  purge();
  const purgeTimer = setInterval(purge, 6 * 3600_000);
  purgeTimer.unref?.();

  // ───── 화면 푸시 ─────
  /**
   * 진행 중 작업: CLI 턴, 그리고 턴과 턴 사이에 프로그램이 하는 작업 처리 — 제출 처리(최신 main 반영·자동 검사·대상 고정)·자동 검사
   * 프로세스·병합. 작업은 그동안 진행 상태다 (5.3 "자동 검사도 이 상태에서 수행"). 절전 방지(ENV-11, AC-31)와 완전 종료 확인(ENV-09)이 쓴다.
   * 대기(보류·답변 대기·대표 검수 대기)는 세지 않는다
   */
  const hasActiveWork = (): boolean =>
    core.turns.count() > 0 || core.tasks.hasSubmitting() || core.checks.running.size > 0 || core.merges.hasPending() || core.hostExec.count() > 0;
  let tray: TrayStatus = 'normal';
  let active = false;
  const trayListeners = new Set<(s: TrayStatus) => void>();
  const activeListeners = new Set<(a: boolean) => void>();
  const offChanged = ctx.bus.onChanged(() => {
    try {
      const snap = core.views.snapshot();
      ctx.bus.emit('snapshot', snap);
      if (snap.trayStatus !== tray) {
        tray = snap.trayStatus;
        for (const l of trayListeners) l(tray);
      }
      const nowActive = hasActiveWork();
      if (nowActive !== active) {
        active = nowActive;
        for (const l of activeListeners) l(active);
      }
    } catch (e) {
      ctx.log('error', '스냅샷 생성 실패', e);
    }
  });
  ctx.bus.changed();

  const backend: Backend = {
    // 대표가 부르는 길: 대표 메서드만 받고 나머지는 거부·기록한다 (SERVER_DESIGN 2.5, backend/ownerGate.ts). 그다음 로그인 확인 (AUTH-04).
    // 원격 호출자(서버 HTTP)를 넘기면 그 호출자의 기기 세션으로 본다 (S3-3)
    invoke: createOwnerInvoke(core),
    // AUTH-04: 로그아웃 중에는 업무 내용을 화면으로 보내지 않는다 (invoke 게이트와 같은 경계, SEC-F2). 작업은 계속된다.
    // 스냅샷은 로그인 화면으로 바꾸는 신호라 막지 않고 업무 내용을 뺀 것만 보낸다. 알림·CLI 이벤트는 DB에 남아 로그인 뒤 notifications.list로 보인다
    onTopic: (topic, cb) =>
      ctx.bus.on(topic, (payload) => {
        const value = viewerTopic(topic, payload, core.auth.isLoggedIn());
        if (value !== undefined) cb(value);
      }),
    // 서버: 버스를 거르지 않고 한 번만 구독한 뒤 연결마다 그 호출자로 거른다 — 데스크톱의 로그아웃 규칙 그대로, 스냅숏의 auth는 그 호출자 것 (S3-3)
    onTopicRaw: (topic, cb) => ctx.bus.on(topic, cb),
    // 새 기기 로그인 알림은 다른 기기에 가는 것이다 — 막 로그인한 그 기기의 연결에는 밀어주지 않는다 (S3-5).
    // 세션 없는 원격 연결은 누구나 열 수 있다 — 어느 토픽에도 업무 내용이 없게 한 번 더 줄인다 (S3-20·S3-21, remoteLockedTopic). 데스크톱 onTopic은 그대로
    topicFor: (topic, payload, caller) => {
      if (isOwnLoginNotice(topic, payload, caller)) return undefined;
      const loggedIn = core.auth.isLoggedIn(caller);
      const value = viewerTopic(topic, payload, loggedIn, () => core.auth.state(caller));
      return loggedIn || value === undefined ? value : remoteLockedTopic(topic, value);
    },
    snapshotFor: async (caller) => {
      const loggedIn = core.auth.isLoggedIn(caller);
      const snap = viewerTopic('snapshot', core.views.snapshot(), loggedIn, () => core.auth.state(caller))!;
      return loggedIn ? snap : remoteLockedTopic('snapshot', snap);
    },
    emergencyStop: () => core.stops.emergency(OWNER),
    getTrayStatus: () => tray,
    onTrayStatus: (cb) => {
      trayListeners.add(cb);
      return () => trayListeners.delete(cb);
    },
    hasActiveWork,
    onActiveWorkChange: (cb) => {
      activeListeners.add(cb);
      return () => activeListeners.delete(cb);
    },
    preventSleepEnabled: () => ctx.settings().execution.preventSleep,
    emergencyShortcut: () => ctx.settings().policy.emergencyShortcut,
    shutdown: async () => {
      await stop();
    },
    backupNow: async () => backupNow(core),
    backupEnabled: () => ctx.settings().general.backup.enabled,
  };

  /**
   * 저장소를 쓰는 진행 중인 프로그램 작업 (없으면 null) — 턴 마무리·제출 처리·자동 검사·병합·되돌리기 단계·프로젝트 잠금, 그리고 잠금 밖에서
   * git 단계를 기다리는 작업 취소(중간 결과 보관·작업 폴더 정리)·완료 마무리(산출물 확정, 보류 해제·복구가 부른 병합 완료 처리)·프로젝트 등록 (S7-D2)
   */
  const programWork = (): string | null => {
    const parts: string[] = [];
    if (core.turns.count() > 0) parts.push(`턴 ${core.turns.count()}개`);
    if (core.tasks.hasSubmitting()) parts.push('제출 처리');
    if (core.checks.running.size > 0) parts.push(`자동 검사 ${core.checks.running.size}개`);
    if (core.hostExec.count() > 0) parts.push(`서버 명령 ${core.hostExec.count()}개`);
    if (core.merges.hasPending()) parts.push('병합·되돌리기');
    if (core.locks.busy()) parts.push('프로젝트 잠금 안 처리');
    if (core.tasks.hasCancelling()) parts.push('작업 취소');
    if (core.merges.hasFinishing()) parts.push('완료 마무리(산출물 확정·병합 완료 처리)');
    if (core.projects.isRegistering()) parts.push('프로젝트 등록');
    return parts.length ? parts.join(', ') : null;
  };
  /** 진행 중인 프로그램 작업이 없어질 때까지 (deadline까지). 남은 작업 설명을 돌려준다 (다 끝났으면 null). background: 프로세스를 붙잡지 않는다 */
  const waitProgramIdle = async (deadline: number, background = false): Promise<string | null> => {
    for (;;) {
      const busy = programWork();
      if (!busy || Date.now() >= deadline) return busy;
      await new Promise<void>((r) => {
        const timer = setTimeout(r, SHUTDOWN_POLL_MS);
        if (background) timer.unref?.();
      });
    }
  };

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    // 이 뒤로 새 턴을 띄우지 않고, 진행 중인 프로그램 작업(제출 처리·병합·되돌리기·자동 검사)은 다음 단계에서 멈춘다 (stops.runAllowedForTask) —
    // 제출 요청·통과 기록·실행 기록은 남아 다음 시작의 복구가 이어 간다
    core.stopping = true;
    core.scheduler.stop();
    core.turns.stopTimers();
    clearInterval(purgeTimer);
    offRunnerProblem?.();
    const drainMs = deps.timing?.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS;
    const deadline = Date.now() + drainMs;
    // 체크포인트: 실행 중 턴은 정지 요청으로 끝낸다. 작업 상태는 그대로 두고 다음 시작 때 이어간다 (ENV-09). 메인 에이전트의 서버 명령(host_exec)도 함께 끝낸다 —
    // 앱 도구 서버를 멈추기 전에 (그 처리기가 닫힌 저장소에 쓰지 않게, 리드 결정 S5-18)
    await Promise.all([core.turns.stopAll('앱 종료'), core.hostExec.terminateWhere(() => true, '앱 종료')]);
    // 멈춘 턴의 마무리(종료 판정·대기열 정리)는 done 뒤에도 저장소를 쓴다 → 저장소를 닫기 전에 끝까지 기다린다
    if (!(await core.turns.drain(Math.max(0, deadline - Date.now())))) ctx.log('warn', `앱 종료: 턴 마무리를 ${drainMs / 1000}초 안에 끝내지 못했습니다. 남은 기록은 다음 시작 때 복구합니다`);
    await core.checks.terminateFor(() => true);
    // 턴 사이에 프로그램이 하던 작업(병합 마무리·작업 공간 정리·제출 처리·되돌리기 단계)도 다음 단계에서 멈출 때까지 기다린다 — 그 밑에서 저장소를
    // 닫으면 남은 기록이 닫힌 저장소에 쓰다 실패한다
    const leftover = await waitProgramIdle(deadline);
    // 러너의 보조 프로세스(taskkill 방식의 작업 개체 도우미)도 끝낸다 — 턴·검사는 위에서 이미 끝냈다
    try {
      deps.runner.dispose?.();
    } catch (e) {
      ctx.log('warn', '프로세스 러너 정리 실패', e);
    }
    offChanged();
    await core.toolServer.stop().catch(() => undefined);
    ctx.bus.dispose();
    if (!leftover) {
      ctx.store.close();
      return;
    }
    // 상한을 넘김: 남은 작업은 지금 기다리는 git·검사 단계가 끝나면 다음 단계 확인(앱 종료 중)에서 멈춘다. 그때까지 저장소를 열어 두고 그 뒤에 닫는다 —
    // 닫힌 저장소에 쓰다 실패하거나 끊긴 기록을 남기지 않게. 종료는 기다리지 않는다 (프로세스가 끝나면 함께 닫힌다)
    ctx.log('warn', `앱 종료: 진행 중인 프로그램 작업(${leftover})이 ${drainMs / 1000}초 안에 끝나지 않았습니다. 다음 단계에서 멈춘 뒤 저장소를 닫고, 남은 기록은 다음 시작 때 복구합니다`);
    void waitProgramIdle(Number.POSITIVE_INFINITY, true).then(() => {
      try {
        ctx.store.close();
      } catch (e) {
        ctx.log('warn', '저장소 닫기 실패', e);
      }
    });
  }

  return { core, backend, stop };
}

/**
 * OS 보안 저장소에 있는 대표 등록 값을 가리개에 넣는다. API 키는 상태 확인용 메모리 사본(deps.apiKeys — 어댑터 statusEnv, 리드 결정 16)에도 채운다.
 * 저장소를 읽지 못해도 시작은 막지 않는다 (경고만)
 */
async function registerStoredSecrets(ctx: Core['ctx']): Promise<void> {
  const stored: [key: string, kind: string, ai: AiKind | null][] = [
    [SECRET_KEYS.apiKeyClaude, 'api-key', 'claude'],
    [SECRET_KEYS.apiKeyCodex, 'api-key', 'codex'],
    [SECRET_KEYS.googleClientSecret, 'google-secret', null],
    // 서버의 기기 코드 로그인 클라이언트 보안 비밀 (S3-8) — 서버에서만 읽는다 (데스크톱 시작은 예전 그대로)
    ...(ctx.deps.mode === 'server' ? [[SECRET_KEYS.googleDeviceClientSecret, 'google-secret', null] as [string, string, AiKind | null]] : []),
  ];
  for (const [key, kind, ai] of stored) {
    try {
      const value = (await ctx.deps.secrets.get(key))?.trim();
      if (value) ctx.redact.addSecret(value, kind);
      if (ai) ctx.deps.apiKeys?.set(ai, value ?? null);
    } catch (e) {
      ctx.log('warn', `등록된 비밀 값(${key})을 읽지 못해 가리기에 넣지 못했습니다`, e);
    }
  }
}

/**
 * 화면 하나에 보낼 푸시 값 (보내지 않으면 undefined) — 데스크톱 onTopic과 서버의 연결별 거르기(topicFor, S3-3)가 같은 규칙을 쓴다 (AUTH-04, SEC-F2):
 * 로그인하지 않았으면 스냅숏은 업무 내용을 뺀 것(lockedSnapshot), 알림·CLI 이벤트는 보내지 않고, navigate·emergency·openSettings는 그대로 (화면은
 * 로그인 전 내용을 그리지 않는다). authFor: 스냅숏의 auth를 그 화면의 상태로 바꿀 때 (서버 — 버스 스냅숏은 호출자 없는 상태로 만들어진다)
 */
export function viewerTopic<T extends WookTopic>(topic: T, payload: WookTopics[T], loggedIn: boolean, authFor?: () => AuthState): WookTopics[T] | undefined {
  if (topic === 'snapshot') {
    const snap = authFor ? { ...(payload as AppSnapshot), auth: authFor() } : (payload as AppSnapshot);
    return (loggedIn ? snap : lockedSnapshot(snap)) as WookTopics[T];
  }
  if (!loggedIn && (topic === 'notification' || topic === 'cliEvents')) return undefined;
  return payload;
}

/**
 * 로그아웃 중 화면으로 보내는 스냅샷: 로그인 상태·트레이·AI·실행 수만 남기고 업무 내용(프로젝트·팀원·작업·할 일·활동)은 뺀다. 메인 자리의 보유자와
 * 이력도 업무 내용이라 정해진 빈 값(LOCKED_SEAT)으로 바꾼다 (리드 결정 S4-11) — 서버의 세션 없는 연결(remoteLockedTopic)도 이 값 그대로다
 */
export function lockedSnapshot(s: AppSnapshot): AppSnapshot {
  return {
    ...s,
    seat: LOCKED_SEAT,
    stop: { ...s.stop, pausedProjects: [], pausedMembers: [], lastEmergency: null },
    projects: [],
    members: [],
    directives: [],
    tasks: [],
    ownerTodos: [],
    notifications: { unread: 0, urgentUnread: 0 },
    recentActivity: [],
    roles: [],
  };
}

/**
 * 세션 없는 원격 연결로 보내는 값 (서버 topicFor·snapshotFor, 리드 결정 S3-20·S3-21) — viewerTopic이 거른 값을 한 번 더 줄인다. 데스크톱의 로그아웃
 * 화면은 그 PC 대표의 창이지만 서버의 세션 없는 연결은 누구나 열 수 있어, 어느 토픽에도 업무 내용을 싣지 않는다. 화면 약속의 모양은 그대로다.
 * - 스냅숏: lockedSnapshot에 더해 AI 상태는 로그인 전 system.prereqs(minimalPrereqs)만큼 — 설치 여부만, 버전·문제 글·한도·CLI 로그인 상태 없음.
 *   실행 수와 긴급 정지 뒤 보류 수는 0. 트레이 상태는 그대로(긴급 정지 토픽이 이미 그만큼 말한다)
 * - emergency: 때(at)와 확인 완료(completed)만 — 멈춘 턴·보류한 작업·실패는 빈 목록 (lockedSnapshot이 lastEmergency를 지우는 것과 같은 규칙)
 * - navigate: 탭(과 설정 칸)만 — 프로젝트·팀원·작업·지시·보고서 ID는 뺀다
 * - openSettings: 그대로 (설정 칸 이름뿐). notification·cliEvents는 viewerTopic이 이미 보내지 않는다
 * 새 토픽이나 칸은 tests/server/noSessionTopics.test.ts의 허용 목록에 넣을지 정해야 시험이 통과한다
 */
export function remoteLockedTopic<T extends WookTopic>(topic: T, payload: WookTopics[T]): WookTopics[T] {
  switch (topic) {
    case 'snapshot': {
      const s = payload as AppSnapshot;
      const out: AppSnapshot = {
        ...s,
        stop: { ...s.stop, heldByEmergency: 0 },
        ai: s.ai.map((a) => ({ kind: a.kind, installed: a.installed, version: null, problem: null, usageLimitedUntil: null, authRequired: false, blocked: false })),
        running: { total: 0, general: 0, management: 0, cap: 0, generalCap: 0, queued: 0 },
      };
      return out as WookTopics[T];
    }
    case 'emergency': {
      const e = payload as EmergencySummary;
      const out: EmergencySummary = { at: e.at, completed: e.completed, stoppedTurns: [], heldTasks: [], failures: [] };
      return out as WookTopics[T];
    }
    case 'navigate': {
      const n = payload as NavTarget;
      return (n.tab === 'settings' && n.section ? { tab: n.tab, section: n.section } : { tab: n.tab }) as WookTopics[T];
    }
    default:
      return payload;
  }
}
