/**
 * Linux 서버의 작업 중 절전 방지 (리드 결정 S10-6.5, src/server/powerLinux.ts): 판단은 powerGuard(진행 중 작업 && execution.preventSleep), 막는 쪽은
 * `systemd-inhibit --what=sleep --mode=block`을 쥔 자식. 가짜 systemd-inhibit(tests/fixtures/power/fakeInhibit.mjs — Node 스크립트, 받은 일을 로그에 적는다)으로
 * Windows와 Linux 어디서나 본다:
 * - 작업이 있으면 띄우고 READY까지 pending, READY 뒤 awake. 작업이 끝나면 표준 입력을 닫아 놓는다(가짜가 released를 적고 끝남) — idle은 자식이 없다는 뜻
 * - 'Access denied'(polkit)·버스에 닿지 못함·도구 없음은 바로 unavailable — 그 까닭으로, 다시 띄우지 않는다(띄우기 1번), 경고·운영자 기록 한 줄
 * - 그 밖의 실패(READY 전 끝남)는 상한 3번 뒤 unavailable. 상한은 잇단 실패만 센다 — READY 뒤 10분(옮긴 시계) 돈 것이 끝나면 처음부터
 * - 작업 중 설정을 켜면 다음 맞추기 전에도 pending (S9-24 R2S-1과 같다). 끝내기: 표준 입력을 닫아 놓고, 끝나지 않는 것은 상한 뒤 쥔 핸들로 끝낸다
 * - Linux에서만: 실제 systemd-inhibit — 이 WSL처럼 활성 세션 밖이면 'Access denied'가 바로 unavailable(띄우기 1번)이 된다. 잠금을 준 환경(CI 등)이면 awake 뒤
 *   놓는다
 * 띄운 가짜는 제품이 쥔 ChildProcess로만 끝난다 — 이 시험은 pid로 살았는지 보기만 한다
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POWER_STABLE_MS, type ServerPower } from '../../src/server/power';
import { createLinuxServerPower, INHIBIT_ARGS } from '../../src/server/powerLinux';
import { whichOnPath } from '../../src/server/deployCheckLinux';
import { pidAlive } from '../setup/runTemp';
import { memoryLogger, REPO, removeDir, sleep } from './helpers';

const FAKE = join(REPO, 'tests', 'fixtures', 'power', 'fakeInhibit.mjs');
const GENEROUS = 60_000;
const SHORT = 300;
const powers: ServerPower[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const p of powers.splice(0)) await p.dispose();
  for (const d of dirs.splice(0)) await removeDir(d);
});

async function waitFor(pred: () => boolean, label: string, ms = GENEROUS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`기다리다 시간이 지났습니다: ${label}`);
    await sleep(20);
  }
}

function fakeBackend(initial: { active: boolean; enabled: boolean }) {
  const state = { ...initial };
  let onChange: ((active: boolean) => void) | null = null;
  return {
    state,
    backend: {
      hasActiveWork: () => state.active,
      preventSleepEnabled: () => state.enabled,
      onActiveWorkChange: (cb: (active: boolean) => void) => {
        onChange = cb;
        return () => {
          onChange = null;
        };
      },
    },
    setActive(active: boolean) {
      state.active = active;
      onChange?.(active);
    },
  };
}

function make(o: { scenario?: string; active?: boolean; enabled?: boolean; readyMs?: number; cap?: number; graceMs?: number; now?: () => number; command?: { file: string; args: string[] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-inhibit-'));
  dirs.push(dir);
  const logFile = join(dir, 'log.txt');
  const fb = fakeBackend({ active: o.active ?? false, enabled: o.enabled ?? true });
  const logger = memoryLogger();
  const notes: string[] = [];
  const power = createLinuxServerPower({
    backend: fb.backend,
    logger,
    notify: (t) => notes.push(t),
    command: o.command ?? {
      file: process.execPath,
      args: [FAKE],
      env: { ...process.env, FAKE_INHIBIT_LOG: logFile, FAKE_INHIBIT_SCENARIO: o.scenario ?? 'ok', FAKE_INHIBIT_DIE_FILE: join(dir, 'die'), FAKE_INHIBIT_GATE_FILE: join(dir, 'gate') },
    } as { file: string; args: string[] },
    syncMs: 0,
    ...(o.readyMs !== undefined ? { readyTimeoutMs: o.readyMs } : {}),
    ...(o.cap !== undefined ? { restartCap: o.cap } : {}),
    ...(o.graceMs !== undefined ? { closeGraceMs: o.graceMs } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  powers.push(power);
  const log = (): string[] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
  return {
    power,
    fb,
    logger,
    notes,
    dir,
    log,
    launches: () => log().filter((l) => l.startsWith('start ')).length,
    pids: () => log().filter((l) => l.startsWith('start ')).map((l) => Number(l.split(' ')[1])),
    gate: () => writeFileSync(join(dir, 'gate'), ''),
    die: (n: number) => writeFileSync(join(dir, `die-${n}`), ''),
  };
}

describe('Linux 절전 방지 — 가짜 systemd-inhibit (모든 OS)', () => {
  it('작업이 없으면 띄우지 않고 idle — 작업이 생기면 READY까지 pending, 그 뒤 awake. 작업이 끝나면 놓고(표준 입력 끝) 자식이 없다, 다시 작업이면 새로 띄운다', async () => {
    const t = make({ scenario: 'slow,ok' });
    expect([t.power.status(), t.launches()]).toEqual([{ state: 'idle', reason: null }, 0]);
    t.fb.setActive(true);
    await waitFor(() => t.launches() === 1, '띄움');
    expect(t.power.status().state).toBe('pending');
    expect(t.power.status().reason).toContain('systemd-inhibit의 READY');
    t.gate();
    await waitFor(() => t.power.status().state === 'awake', 'awake');
    const [pid] = t.pids();
    t.fb.setActive(false);
    await waitFor(() => t.log().includes('released'), 'released');
    await waitFor(() => !pidAlive(pid!), '끝남');
    expect(t.power.status()).toEqual({ state: 'idle', reason: null });
    t.fb.setActive(true);
    await waitFor(() => t.power.status().state === 'awake', '두 번째 awake');
    expect(t.launches()).toBe(2);
  }, 120_000);

  it("'Access denied'(polkit)·버스에 닿지 못함은 바로 unavailable — 그 까닭, 띄우기 1번, 경고·운영자 기록 한 줄", async () => {
    for (const [scenario, text] of [
      ['denied', 'systemd-inhibit: Failed to inhibit: Access denied'],
      ['no-bus', 'systemd-inhibit: Failed to connect to bus: No medium found'],
    ] as const) {
      const t = make({ scenario, active: true });
      await waitFor(() => t.power.status().state === 'unavailable', `${scenario} unavailable`);
      await sleep(SHORT);
      expect([scenario, t.power.status(), t.launches(), t.notes]).toEqual([scenario, { state: 'unavailable', reason: text }, 1, [`절전 방지를 쓸 수 없습니다 — ${text}`]]);
      expect(t.logger.lines.filter((l) => l.startsWith('[WARN] 절전 방지를 쓸 수 없습니다'))).toHaveLength(1);
    }
  }, 120_000);

  it('도구가 없으면(ENOENT) 바로 unavailable — systemd-inhibit이 없습니다', async () => {
    const t = make({ active: true, command: { file: join(tmpdir(), 'wook-no-such-systemd-inhibit'), args: [] } });
    await waitFor(() => t.power.status().state === 'unavailable', 'unavailable');
    expect(t.power.status()).toEqual({ state: 'unavailable', reason: 'systemd-inhibit이 없습니다' });
  });

  it('그 밖의 실패(READY 전 말없이 끝남)는 상한 3번 다시 띄운 뒤 unavailable — 띄우기 4번, 운영자 기록 한 줄', async () => {
    const t = make({ scenario: 'crash', active: true });
    await waitFor(() => t.power.status().state === 'unavailable', 'unavailable');
    await sleep(SHORT);
    expect(t.launches()).toBe(4);
    expect(t.power.status().reason).toMatch(/^절전 방지\(systemd-inhibit\)가 3번 다시 띄운 뒤에도 실패했습니다 \(READY 전에 끝남 \(코드 3\)\)$/);
    expect(t.notes).toHaveLength(1);
  }, 120_000);

  it('READY가 오지 않으면 상한 창 뒤 실패로 센다 (상한 0이면 바로 unavailable)', async () => {
    const t = make({ scenario: 'no-ready', active: true, readyMs: SHORT, cap: 0 });
    await waitFor(() => t.power.status().state === 'unavailable', 'unavailable');
    expect(t.power.status().reason).toContain(`${SHORT / 1000}초 안에 READY 없음`);
    const [pid] = t.pids();
    await waitFor(() => !pidAlive(pid!), '놓은 가짜가 끝남');
  }, 120_000);

  it('상한은 잇단 실패만 센다 — READY 뒤 10분(옮긴 시계) 돈 것이 끝나면 처음부터, 곧바로 다시 끝나면 상한을 넘는다', async () => {
    let clock = 1_000;
    const t = make({ scenario: 'die-after-ready', active: true, cap: 1, now: () => clock });
    await waitFor(() => t.power.status().state === 'awake', '첫 awake');
    clock += POWER_STABLE_MS;
    t.die(1);
    await waitFor(() => t.launches() === 2 && t.power.status().state === 'awake', '둘째 awake (수를 처음부터)');
    t.die(2);
    await waitFor(() => t.power.status().state === 'unavailable', '곧바로 다시 끝남 → unavailable');
    expect(t.launches()).toBe(2);
  }, 120_000);

  it('작업 중에 설정을 켜면 다음 맞추기 전에도 pending — off에서 바로 idle이라고 하지 않는다', async () => {
    const t = make({ active: true, enabled: false });
    expect(t.power.status().state).toBe('off');
    t.fb.state.enabled = true;
    expect(t.power.status().state).toBe('pending');
    expect(t.launches()).toBe(0);
  });

  it('끝내기: 표준 입력을 닫아 놓는다 — 놓지 않는 것은 상한 뒤 쥔 핸들로 끝내고, dispose가 돌아오면 자식이 없다', async () => {
    const t = make({ scenario: 'ignore-eof', active: true, graceMs: SHORT });
    await waitFor(() => t.power.status().state === 'awake', 'awake');
    const [pid] = t.pids();
    await t.power.dispose();
    // 스스로 끝나지 않았다(끝 줄이 없다) — 쥔 핸들로 끝냈다
    expect([pidAlive(pid!), t.log().some((l) => l.startsWith('exit '))]).toEqual([false, false]);
    const ok = make({ active: true });
    await waitFor(() => ok.power.status().state === 'awake', 'awake');
    const [pid2] = ok.pids();
    await ok.power.dispose();
    expect([pidAlive(pid2!), ok.log().includes('released')]).toEqual([false, true]);
  }, 120_000);

  it('실제 명령은 systemd-inhibit --what=sleep --mode=block — 안쪽 sh가 잠금을 잡은 뒤 READY를 내고 표준 입력 끝까지 쥔다', () => {
    expect(INHIBIT_ARGS).toEqual(['--what=sleep', '--who=욱채 서버', '--why=작업 진행 중 — 끝나면 풉니다', '--mode=block', '/bin/sh', '-c', 'echo "READY 1 power"; exec cat >/dev/null']);
  });
});

describe.runIf(process.platform === 'linux' && !!whichOnPath('systemd-inhibit', process.env['PATH']))('Linux 절전 방지 — 실제 systemd-inhibit (Linux, systemd-inhibit이 PATH에 있을 때)', () => {
  it("활성 세션 밖이면 'Access denied'가 바로 unavailable(띄우기 1번) — 잠금을 주는 환경이면 awake 뒤 놓는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-inhibit-real-'));
    dirs.push(dir);
    const count = join(dir, 'launches');
    // 띄울 때마다 한 줄을 적고 실제 systemd-inhibit으로 바뀐다 (exec — 쥔 핸들이 곧 systemd-inhibit이다)
    const command = { file: '/bin/sh', args: ['-c', `echo x >> '${count}'; exec systemd-inhibit "$@"`, 'sh', ...INHIBIT_ARGS] };
    const fb = fakeBackend({ active: true, enabled: true });
    const logger = memoryLogger();
    const power = createLinuxServerPower({ backend: fb.backend, logger, command, syncMs: 0 });
    powers.push(power);
    await waitFor(() => ['unavailable', 'awake'].includes(power.status().state), 'unavailable 또는 awake', 15_000);
    await sleep(SHORT);
    const s = power.status();
    const launches = readFileSync(count, 'utf8').split('\n').filter(Boolean).length;
    console.log(`[실제 systemd-inhibit] ${JSON.stringify(s)} — 띄우기 ${launches}번`);
    if (s.state === 'unavailable') {
      expect([s.reason, launches]).toEqual(['systemd-inhibit: Failed to inhibit: Access denied', 1]);
    } else {
      expect(s.state).toBe('awake');
      fb.setActive(false);
      await waitFor(() => power.status().state === 'idle', 'idle');
    }
  }, 60_000);
});
