/**
 * 서버의 작업 중 절전 방지 (SERVER_DESIGN 3.2, ENV-11·AC-31, 리드 결정 S9-5): 판단은 데스크톱과 같은 powerGuard.ts(진행 중 작업 && execution.preventSleep),
 * 막는 쪽은 서버 도우미 `WookServerHelper.exe power`(SetThreadExecutionState ES_CONTINUOUS|ES_SYSTEM_REQUIRED — 화면 표시 플래그 없음, 실행 상태는 그
 * 스레드가 살아 있는 동안만이라 도우미가 떠 있어야 한다).
 * - 띄우기는 처음 막을 때 (늦게), 그 뒤 서버가 끝날 때까지 둔다. 약속: READY 1 power → AWAKE/RELAX/PING → OK awake|idle
 * - 다시 띄우기 상한 3번 (도중에 끝남, 10초 안에 READY 없음, 5초 안에 OK 없음 — 리드 결정 S9-19, ERR) — 넘으면 unavailable, 경고 한 줄, 운영자 활동 기록 한 줄.
 *   상한은 잇단 실패를 센다: READY 뒤 10분 넘게 돈 도우미가 끝나면 그 수를 처음부터 다시 센다(리드 결정 S9-22 — 몇 달 도는 서버가 띄엄띄엄한 세 번의
 *   끝남으로 절전 방지를 잃지 않게). csc 없음·컴파일 실패·해시가 다름은 바로 unavailable
 * - status: 작업 중인데 도우미가 아직 막았다고 답하지 않았으면(띄우는 중·READY·OK를 기다리는 중·다시 띄우는 중) pending — idle이라고 하지 않는다 (S9-22 DF-2)
 * - 끝낼 때: RELAX, 표준 입력 닫기, 1초 안에 끝나지 않으면 끝낸다(쥔 ChildProcess로만) — 끝난 것을 확인한 뒤에 돌아온다. 도우미는 표준 입력이 끝나면 풀고
 *   끝나므로 서버가 갑자기 끝나도 PC가 깨어 있는 채로 남지 않는다
 * - Windows 밖이면 unsupported. 켜고 끄는 것은 그대로 execution.preventSleep (메인 에이전트의 update_settings) — 30초마다 다시 읽는다(데스크톱과 같다)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Backend } from '../main/backend/types';
import type { Logger } from '../main/shell/logger';
import { createGuard, type PowerGuard } from '../main/shell/powerGuard';
import { firstStderrLine, readHelperLines, settles, SERVER_HELPER_PROTOCOL, type ServerHelperLauncher } from './serverHelper';

/** idle 진행 중 작업이 없어 막지 않음 · pending 작업 중인데 도우미가 아직 막았다고 답하지 않음 · awake 막고 있음 · unavailable·unsupported·off */
export type ServerPowerState = 'idle' | 'pending' | 'awake' | 'unavailable' | 'unsupported' | 'off';

/** pending의 까닭 (리드 결정 S9-22 DF-2) */
export const POWER_PENDING_REASON = '작업 중 — 절전 방지 도우미의 답을 기다리는 중이라 아직 막지 못했습니다';

/** 관리 status의 power (리드 결정 S9-2) */
export interface ServerPowerStatus {
  state: ServerPowerState;
  reason: string | null;
}

export interface ServerPower {
  status(): ServerPowerStatus;
  /** 설정(execution.preventSleep)을 다시 읽어 맞춘다 */
  update(): void;
  /** 구독을 풀고 도우미를 끝낸다 (RELAX → 표준 입력 닫기 → 1초 뒤 kill) — 끝난 것을 확인한 뒤에 돌아온다 */
  dispose(): Promise<void>;
}

export interface ServerPowerOptions {
  backend: Pick<Backend, 'hasActiveWork' | 'preventSleepEnabled' | 'onActiveWorkChange'>;
  /** 서버 도우미 (null이면 이 OS에서는 쓰지 않는다 — unsupported) */
  launcher: ServerHelperLauncher | null;
  logger: Logger;
  /** 운영자 활동 기록 한 줄 (unavailable이 될 때) */
  notify?: (text: string) => void;
  platform?: NodeJS.Platform;
  /** 시험: READY 상한 (기본 10초) · OK 상한 (기본 5초) · 다시 띄우기 상한 (기본 3) · 끝낼 때 기다림 (기본 1초) · 설정 다시 읽기 주기 (기본 30초, 0이면 없음) */
  readyTimeoutMs?: number;
  ackTimeoutMs?: number;
  restartCap?: number;
  closeGraceMs?: number;
  syncMs?: number;
  /** 시험: 이만큼 돈 도우미가 끝나면 다시 띄우기 수를 처음부터 센다 (기본 10분) · 시계 (기본 단조 시계 performance.now — 시험은 옮긴다) */
  stableMs?: number;
  now?: () => number;
}

/**
 * READY·OK를 기다리는 상한 (리드 결정 S9-19 — 5초·2초에서 10초·5초로). 놓친 창은 실패로 세고 상한을 넘으면 unavailable — 작업 중 PC가 절전에 들 수 있게 되므로
 * 답을 기다리는 창은 넉넉히 둔다
 */
export const POWER_READY_MS = 10_000;
export const POWER_ACK_MS = 5_000;
export const POWER_RESTART_CAP = 3;
export const POWER_CLOSE_GRACE_MS = 1_000;
/** READY 뒤 이만큼 돈 도우미가 끝나면 잇단 실패가 아니다 — 다시 띄우기 수를 처음부터 센다 (리드 결정 S9-22) */
export const POWER_STABLE_MS = 10 * 60_000;
const SETTINGS_SYNC_MS = 30_000;

interface PowerHelper {
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
  /** READY를 받은 때 (now()) — 아직이면 null */
  readyAt: number | null;
  /** 이 쪽이 끝내는 중이거나 이미 실패로 센 도우미 — 끝남을 다시 세지 않는다 */
  dead: boolean;
  exited: Promise<void>;
  stderr: string;
}

export function createServerPower(o: ServerPowerOptions): ServerPower {
  const { logger } = o;
  const platform = o.platform ?? process.platform;
  const supported = platform === 'win32' && o.launcher !== null;
  const readyMs = o.readyTimeoutMs ?? POWER_READY_MS;
  const ackMs = o.ackTimeoutMs ?? POWER_ACK_MS;
  const cap = o.restartCap ?? POWER_RESTART_CAP;
  const graceMs = o.closeGraceMs ?? POWER_CLOSE_GRACE_MS;
  const stableMs = o.stableMs ?? POWER_STABLE_MS;
  // 단조 시계 — 벽시계가 절전에서 깨어나거나 손으로 바뀌어 뛰어도 '10분 돌았다'를 잘못 재지 않게 (리드 결정 S9-24). 시험은 시계를 넣는다
  const now = o.now ?? (() => performance.now());

  /** 막기를 바라는지 (판단이 정한다) */
  let desired = false;
  let helper: PowerHelper | null = null;
  /** 준비(컴파일)·띄우기 중 */
  let preparing = false;
  /** 도우미가 마지막으로 OK한 상태 */
  let confirmed: 'awake' | 'idle' | null = null;
  let inflight: { want: 'awake' | 'idle'; timer: NodeJS.Timeout } | null = null;
  let readyTimer: NodeJS.Timeout | null = null;
  let failures = 0;
  let unavailable: string | null = null;
  let disposed = false;

  const clearTimers = (): void => {
    if (inflight) clearTimeout(inflight.timer);
    inflight = null;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
  };

  /** 쓸 수 없게 됨 — 경고 한 줄과 운영자 활동 기록 한 줄 (한 번만) */
  const giveUp = (reason: string): void => {
    if (unavailable) return;
    unavailable = reason;
    logger.warn(`절전 방지를 쓸 수 없습니다 — ${reason}. 작업 중에도 PC가 절전에 들어갈 수 있습니다 (전원 설정에서 절전을 끄세요)`);
    try {
      o.notify?.(`절전 방지를 쓸 수 없습니다 — ${reason}`);
    } catch (error) {
      logger.error('절전 방지 실패를 활동 기록에 남기지 못했습니다', error);
    }
  };

  /** 쥔 도우미를 끝낸다 (kill은 쥔 ChildProcess로만) */
  const killHelper = (h: PowerHelper): void => {
    h.dead = true;
    if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill();
  };

  /** 실패 하나 (도중에 끝남·READY 없음·OK 없음·ERR) — 세고, 상한을 넘으면 unavailable, 아니면 필요할 때 다시 띄운다 */
  const fail = (h: PowerHelper, reason: string): void => {
    if (h.dead) return;
    killHelper(h);
    if (helper === h) helper = null;
    clearTimers();
    confirmed = null;
    if (disposed) return;
    // 오래(10분) 돈 도우미의 끝남은 잇단 실패가 아니다 — 수를 처음부터 센다 (리드 결정 S9-22)
    if (h.readyAt !== null && now() - h.readyAt >= stableMs) failures = 0;
    failures++;
    if (failures > cap) {
      giveUp(`절전 방지 도우미가 ${cap}번 다시 띄운 뒤에도 실패했습니다 (${reason})`);
      return;
    }
    logger.warn(`절전 방지 도우미 실패 (${reason}) — 필요하면 다시 띄웁니다 (${failures}/${cap})`);
    drive();
  };

  const send = (h: PowerHelper, line: string): void => {
    if (h.dead || h.child.stdin.destroyed || h.child.stdin.writableEnded) return;
    h.child.stdin.write(`${line}\n`);
  };

  const spawnHelper = (): void => {
    if (preparing || helper || !o.launcher) return;
    preparing = true;
    const launcher = o.launcher;
    void launcher
      .prepare()
      .then((prepared) => {
        preparing = false;
        if (disposed || unavailable) return;
        if (!prepared.ok) return giveUp(prepared.reason);
        const spec = launcher.spec('power', []);
        if ('refuse' in spec) return giveUp(spec.refuse);
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(spec.file, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
          failures++;
          if (failures > cap) giveUp(`절전 방지 도우미를 띄우지 못했습니다 (${(error as Error).message})`);
          return;
        }
        const h: PowerHelper = { child, ready: false, readyAt: null, dead: false, exited: new Promise<void>((r) => child.once('exit', () => r())), stderr: '' };
        helper = h;
        child.stdin.on('error', () => undefined);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (c: string) => {
          if (h.stderr.length < 4096) h.stderr += c;
        });
        child.once('error', (error: NodeJS.ErrnoException) => fail(h, `띄우지 못함 ${error.code ?? error.message}`));
        child.once('exit', (code, signal) => {
          const why = firstStderrLine(h.stderr);
          fail(h, `끝남 코드 ${code ?? signal}${why ? `, ${why}` : ''}`);
        });
        // 창의 길이는 그대로 말한다 — 시험이 넣는 짧은 창(0.3초)을 '0초'로 반올림하지 않는다
        readyTimer = setTimeout(() => fail(h, `${readyMs / 1000}초 안에 READY 없음`), readyMs);
        readHelperLines(
          child.stdout,
          (line) => onLine(h, line),
          () => fail(h, '줄이 1 MiB를 넘음'),
        );
      })
      .catch((error: unknown) => {
        preparing = false;
        logger.error('절전 방지 도우미를 띄우는 중 예기치 않은 오류', error);
      });
  };

  const onLine = (h: PowerHelper, line: string): void => {
    if (h.dead || helper !== h) return;
    if (!h.ready) {
      if (line !== `READY ${SERVER_HELPER_PROTOCOL} power`) return fail(h, `첫 줄을 알 수 없음 (${line.slice(0, 40)})`);
      h.ready = true;
      h.readyAt = now();
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
      logger.info(`절전 방지 도우미 준비 (pid ${h.child.pid ?? '?'})`);
      drive();
      return;
    }
    const m = /^OK (awake|idle)$/.exec(line);
    if (!m) return fail(h, `답이 OK가 아님 (${line.slice(0, 40)})`);
    const state = m[1] as 'awake' | 'idle';
    if (inflight && inflight.want === state) {
      clearTimeout(inflight.timer);
      inflight = null;
    }
    if (state === 'awake' && confirmed !== 'awake') logger.info('절전 방지: 서버 도우미가 시스템 절전을 막고 있습니다');
    confirmed = state;
    drive();
  };

  /** 바라는 상태로 맞춘다 — 한 번에 명령 하나, 막을 때만 늦게 띄운다 */
  const drive = (): void => {
    if (disposed || unavailable || !supported) return;
    const want: 'awake' | 'idle' = desired ? 'awake' : 'idle';
    if (!helper) {
      if (desired) spawnHelper();
      return;
    }
    const h = helper;
    if (!h.ready || inflight || confirmed === want) return;
    const timer = setTimeout(() => fail(h, `${ackMs / 1000}초 안에 OK 없음`), ackMs);
    inflight = { want, timer };
    send(h, want === 'awake' ? 'AWAKE' : 'RELAX');
  };

  const guard: PowerGuard = createGuard({
    backend: o.backend,
    logger,
    blocker: {
      start() {
        desired = true;
        drive();
      },
      stop() {
        desired = false;
        drive();
      },
      // 판단이 바란 상태 — 도우미가 다시 뜨면 이 쪽이 다시 맞춘다 (상태는 status()가 말한다)
      isStarted: () => desired,
    },
  });
  const syncMs = o.syncMs ?? SETTINGS_SYNC_MS;
  const sync = syncMs > 0 ? setInterval(() => guard.update(), syncMs) : null;
  sync?.unref();

  let disposing: Promise<void> | null = null;
  return {
    status(): ServerPowerStatus {
      if (!supported) return { state: 'unsupported', reason: '절전 방지 도우미는 Windows 서버에서만 씁니다' };
      if (unavailable) return { state: 'unavailable', reason: unavailable };
      let enabled = true;
      try {
        enabled = o.backend.preventSleepEnabled();
      } catch {
        enabled = true;
      }
      if (!enabled) return { state: 'off', reason: '설정 execution.preventSleep이 꺼져 있습니다' };
      if (confirmed === 'awake') return { state: 'awake', reason: null };
      // 작업 중인데 도우미가 아직 막았다고 답하지 않았다 — 띄우는 중, READY·OK를 기다리는 중, 실패 뒤 다시 띄우는 중 (리드 결정 S9-22 DF-2). 판단(desired)은 작업이
      // 바뀔 때와 30초마다만 다시 하므로, 지금의 작업도 그대로 읽는다 — 작업 중에 설정을 켠 뒤 다음 맞추기까지도 'idle(진행 중 작업 없음)'이라고 하지 않는다
      // (리드 결정 S9-24 R2S-1). 도우미에게 막기·풀기를 보내는 때는 바꾸지 않는다(그것은 판단이 정한다)
      let active = desired;
      try {
        active = desired || o.backend.hasActiveWork();
      } catch {
        active = desired;
      }
      if (active) return { state: 'pending', reason: POWER_PENDING_REASON };
      return { state: 'idle', reason: null };
    },
    update: () => guard.update(),
    dispose() {
      disposing ??= (async () => {
        if (sync) clearInterval(sync);
        // 먼저 막아 둔다 — 판단의 마지막 stop이 RELAX를 따로 보내지 않게(아래에서 한 번 보낸다)
        disposed = true;
        guard.dispose();
        clearTimers();
        const h = helper;
        helper = null;
        if (!h) return;
        h.dead = true;
        let forced = false;
        if (h.child.exitCode === null && h.child.signalCode === null) {
          if (h.ready) h.child.stdin.write('RELAX\n');
          h.child.stdin.end();
          if (!(await settles(h.exited, graceMs)) && h.child.exitCode === null && h.child.signalCode === null) {
            forced = true;
            h.child.kill();
          }
        }
        const ended = await settles(h.exited, 10_000);
        logger.info(`절전 방지 도우미를 끝냈습니다 (pid ${h.child.pid ?? '?'}${forced ? `, ${graceMs}ms 안에 끝나지 않아 끝냄` : ''}${ended ? '' : ' — 끝남을 확인하지 못함'})`);
      })();
      return disposing;
    },
  };
}

