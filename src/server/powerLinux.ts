/**
 * Linux 서버의 작업 중 절전 방지 (리드 결정 S10-6.5, SERVER_DESIGN 3.2·10.10): 판단은 Windows·데스크톱과 같은 powerGuard.ts(진행 중 작업 &&
 * execution.preventSleep), 막는 쪽은 `systemd-inhibit --what=sleep --mode=block`을 쥔 자식 하나. logind의 잠금은 그 프로세스가 사는 동안만 있다 —
 * 그래서 Windows 도우미처럼 늘 띄워 두고 켜고 끄지 않고, 막을 때 띄우고 풀 때 끝낸다(idle = 자식 없음).
 * - 명령: `systemd-inhibit --what=sleep --who=욱채 서버 --why=… --mode=block /bin/sh -c 'echo "READY 1 power"; exec cat >/dev/null'`. systemd-inhibit은 잠금을
 *   잡은 뒤에야 명령을 띄우므로 READY 줄이 곧 '막고 있다'이다 — 그 전까지는 pending
 * - 풀기: 표준 입력을 닫는다 → cat이 끝 → systemd-inhibit이 끝나며 잠금을 놓는다. 1초 안에 끝나지 않으면 쥔 ChildProcess로 끝낸다. 서버가 갑자기 끝나도
 *   파이프가 닫혀 같은 길로 풀린다 — PC가 깨어 있는 채로 남지 않는다
 * - 'Access denied'(polkit — 활성 로컬 세션 밖, 예: linger로 뜬 사용자 유닛·SSH)·'Failed to …'(버스에 닿지 못함)나 도구가 없음(ENOENT)은 READY 전에 끝나면
 *   바로 unavailable — 그 까닭으로, 다시 띄우지 않는다. 그 밖의 실패(READY 없음 10초, READY 전·뒤의 다른 끝남)는 Windows와 같은 상한 3번(잇단 실패만 —
 *   READY 뒤 10분 돈 것은 처음부터 센다, 단조 시계)
 * - status 단어는 Windows와 같다 (idle·pending·awake·unavailable·off). 시험은 명령을 가짜 systemd-inhibit(Node 스크립트)로 바꾼다
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Backend } from '../main/backend/types';
import type { Logger } from '../main/shell/logger';
import { createGuard, type PowerGuard } from '../main/shell/powerGuard';
import { POWER_PENDING_REASON, POWER_READY_MS, POWER_RESTART_CAP, POWER_STABLE_MS, POWER_CLOSE_GRACE_MS, type ServerPower, type ServerPowerStatus } from './power';
import { firstStderrLine, readHelperLines, settles } from './serverHelper';

/** READY 줄 (안쪽 sh가 낸다 — 잠금을 잡은 뒤) */
export const INHIBIT_READY = 'READY 1 power';
/** systemd-inhibit 인자 (리드 결정 S10-6.5) */
export const INHIBIT_ARGS: readonly string[] = [
  '--what=sleep',
  '--who=욱채 서버',
  '--why=작업 진행 중 — 끝나면 풉니다',
  '--mode=block',
  '/bin/sh',
  '-c',
  `echo "${INHIBIT_READY}"; exec cat >/dev/null`,
];
/** 바로 unavailable로 보는 실패 — 권한(polkit)·버스·도구 없음은 다시 띄워도 같다 */
const FINAL_FAILURE_RE = /access denied|failed to|not found|permission denied|interactive authentication required/i;

export interface LinuxPowerOptions {
  backend: Pick<Backend, 'hasActiveWork' | 'preventSleepEnabled' | 'onActiveWorkChange'>;
  logger: Logger;
  /** 운영자 활동 기록 한 줄 (unavailable이 될 때) */
  notify?: (text: string) => void;
  /** 막는 명령 (기본 systemd-inhibit + INHIBIT_ARGS) — 시험은 가짜를 넣는다 */
  command?: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv };
  /** 시험: READY 상한 · 다시 띄우기 상한 · 풀 때 기다림 · 설정 다시 읽기 주기(0이면 없음) · 안정 창 · 시계 */
  readyTimeoutMs?: number;
  restartCap?: number;
  closeGraceMs?: number;
  syncMs?: number;
  stableMs?: number;
  now?: () => number;
}

interface Inhibitor {
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
  readyAt: number | null;
  /** 이 쪽이 풀거나 이미 실패로 센 것 — 끝남을 다시 세지 않는다 */
  released: boolean;
  exited: Promise<void>;
  stderr: string;
  readyTimer: NodeJS.Timeout | null;
}

export function createLinuxServerPower(o: LinuxPowerOptions): ServerPower {
  const { logger } = o;
  const command = o.command ?? { file: 'systemd-inhibit', args: INHIBIT_ARGS };
  const readyMs = o.readyTimeoutMs ?? POWER_READY_MS;
  const cap = o.restartCap ?? POWER_RESTART_CAP;
  const graceMs = o.closeGraceMs ?? POWER_CLOSE_GRACE_MS;
  const stableMs = o.stableMs ?? POWER_STABLE_MS;
  const now = o.now ?? (() => performance.now());

  let desired = false;
  let current: Inhibitor | null = null;
  /** 풀고 있는 것들 — dispose가 끝남을 기다린다 */
  const releasing = new Set<Inhibitor>();
  let failures = 0;
  let unavailable: string | null = null;
  let disposed = false;

  const giveUp = (reason: string): void => {
    if (unavailable) return;
    unavailable = reason;
    logger.warn(`절전 방지를 쓸 수 없습니다 — ${reason}. 작업 중에도 PC가 절전에 들어갈 수 있습니다 (서버에서는 절전 대상을 막아 두세요: sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target)`);
    try {
      o.notify?.(`절전 방지를 쓸 수 없습니다 — ${reason}`);
    } catch (error) {
      logger.error('절전 방지 실패를 활동 기록에 남기지 못했습니다', error);
    }
  };

  /** 잠금을 놓는다 — 표준 입력을 닫고, 상한 안에 끝나지 않으면 쥔 ChildProcess로 끝낸다 */
  const release = (h: Inhibitor): void => {
    if (h.released) return;
    h.released = true;
    if (h.readyTimer) clearTimeout(h.readyTimer);
    if (current === h) current = null;
    if (h.child.exitCode !== null || h.child.signalCode !== null) return;
    releasing.add(h);
    void h.exited.then(() => releasing.delete(h));
    h.child.stdin.end();
    void settles(h.exited, graceMs).then((ended) => {
      if (!ended && h.child.exitCode === null && h.child.signalCode === null) {
        logger.warn(`절전 방지(systemd-inhibit)가 ${graceMs}ms 안에 끝나지 않아 끝냅니다 (pid ${h.child.pid ?? '?'})`);
        h.child.kill('SIGKILL');
      }
    });
  };

  /** 실패 하나 — 바로 그만둘 실패면 unavailable, 아니면 세고 상한을 넘으면 unavailable, 아니면 필요할 때 다시 띄운다 */
  const fail = (h: Inhibitor, reason: string, final: boolean): void => {
    if (h.released) return;
    release(h);
    if (disposed) return;
    if (final) return giveUp(reason);
    if (h.readyAt !== null && now() - h.readyAt >= stableMs) failures = 0;
    failures++;
    if (failures > cap) return giveUp(`절전 방지(systemd-inhibit)가 ${cap}번 다시 띄운 뒤에도 실패했습니다 (${reason})`);
    logger.warn(`절전 방지(systemd-inhibit) 실패 (${reason}) — 필요하면 다시 띄웁니다 (${failures}/${cap})`);
    drive();
  };

  const start = (): void => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.file, [...command.args], { env: command.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      giveUp(`systemd-inhibit을 띄우지 못했습니다 (${(error as Error).message})`);
      return;
    }
    // 띄우지 못한 자식(ENOENT)은 'exit' 없이 'error'만 낼 수 있다 — 끝남을 기다리는 쪽이 걸리지 않게 둘 다 끝남으로 본다
    const exited = new Promise<void>((r) => {
      child.once('exit', () => r());
      child.once('error', () => r());
    });
    const h: Inhibitor = { child, ready: false, readyAt: null, released: false, exited, stderr: '', readyTimer: null };
    current = h;
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      if (h.stderr.length < 4096) h.stderr += c;
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      // 도구가 없음(ENOENT)·실행할 수 없음 — 다시 띄워도 같다
      fail(h, error.code === 'ENOENT' ? 'systemd-inhibit이 없습니다' : `systemd-inhibit을 띄우지 못했습니다 (${error.code ?? error.message})`, true);
    });
    child.once('exit', (code, signal) => {
      // stderr가 다 들어온 뒤에 까닭을 읽는다 — exit가 마지막 stderr보다 먼저 올 수 있다
      setImmediate(() => {
        const why = firstStderrLine(h.stderr);
        if (!h.ready) {
          // READY 전에 끝남: 권한(polkit 'Access denied')·버스·없는 명령은 바로 unavailable — 그 까닭 그대로
          const final = !!why && FINAL_FAILURE_RE.test(why);
          fail(h, why ? `systemd-inhibit: ${why}` : `READY 전에 끝남 (코드 ${code ?? signal})`, final);
        } else fail(h, `도중에 끝남 코드 ${code ?? signal}${why ? `, ${why}` : ''}`, false);
      });
    });
    h.readyTimer = setTimeout(() => fail(h, `${readyMs / 1000}초 안에 READY 없음`, false), readyMs);
    readHelperLines(
      child.stdout,
      (line) => {
        if (h.released || h.ready) return;
        if (line !== INHIBIT_READY) return fail(h, `첫 줄을 알 수 없음 (${line.slice(0, 40)})`, false);
        h.ready = true;
        h.readyAt = now();
        if (h.readyTimer) clearTimeout(h.readyTimer);
        h.readyTimer = null;
        logger.info(`절전 방지: systemd-inhibit이 시스템 절전을 막고 있습니다 (pid ${child.pid ?? '?'})`);
        // 그사이 작업이 끝났으면 바로 놓는다
        if (!desired) release(h);
      },
      () => fail(h, '줄이 1 MiB를 넘음', false),
    );
  };

  const drive = (): void => {
    if (disposed || unavailable) return;
    if (desired && !current) start();
    else if (!desired && current) release(current);
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
      isStarted: () => desired,
    },
  });
  const syncMs = o.syncMs ?? 30_000;
  const sync = syncMs > 0 ? setInterval(() => guard.update(), syncMs) : null;
  sync?.unref();

  let disposing: Promise<void> | null = null;
  return {
    status(): ServerPowerStatus {
      if (unavailable) return { state: 'unavailable', reason: unavailable };
      let enabled = true;
      try {
        enabled = o.backend.preventSleepEnabled();
      } catch {
        enabled = true;
      }
      if (!enabled) return { state: 'off', reason: '설정 execution.preventSleep이 꺼져 있습니다' };
      if (current?.ready && !current.released) return { state: 'awake', reason: null };
      // 작업 중인데 아직 잠금을 잡았다고(READY) 듣지 못했다 — 띄우는 중·다시 띄우는 중 (S9-22 DF-2, S9-24 R2S-1과 같다)
      let active = desired;
      try {
        active = desired || o.backend.hasActiveWork();
      } catch {
        active = desired;
      }
      if (active) return { state: 'pending', reason: POWER_PENDING_REASON.replace('절전 방지 도우미의 답', 'systemd-inhibit의 READY') };
      return { state: 'idle', reason: null };
    },
    update: () => guard.update(),
    dispose() {
      disposing ??= (async () => {
        if (sync) clearInterval(sync);
        disposed = true;
        guard.dispose();
        if (current) release(current);
        const all = [...releasing];
        await Promise.all(all.map((h) => settles(h.exited, 10_000)));
        if (all.length) logger.info(`절전 방지(systemd-inhibit)를 끝냈습니다 (${all.map((h) => h.child.pid ?? '?').join(', ')})`);
      })();
      return disposing;
    },
  };
}
