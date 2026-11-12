/**
 * serverPower (리드 결정 S9-5·S9-11, AC-31 서버 모드): 서버의 작업 중 절전 방지 — 판단은 powerGuard(진행 중 작업 && execution.preventSleep), 막는 쪽은
 * 서버 도우미 `power`. 가짜 도우미(tests/fixtures/serverhelper/fakeServerHelper.mjs power — 받은 명령을 로그에 적는다)로 본다.
 * - 처음 막을 때 띄운다(늦게). 작업 → AWAKE, 작업 끝·설정 끔 → RELAX(도우미는 남는다), 설정을 다시 켜면 AWAKE
 * - 상한: 도중에 끝남(AWAKE에 죽음)·READY 없음·OK 없음이 3번 다시 띄운 뒤에도 이어지면 unavailable, 경고 한 줄·운영자 활동 기록 한 줄, 더 띄우지 않음.
 *   준비 실패(csc 없음)는 바로 unavailable. 상한은 잇단 실패만 센다 — READY 뒤 10분 넘게 돈 도우미가 끝나면 처음부터 센다(옮긴 시계로, 리드 결정 S9-22)
 * - status: 작업 중인데 도우미가 아직 막았다고 답하지 않았으면 pending — idle(진행 중 작업이 없음)이라고 하지 않는다 (S9-22 DF-2)
 * - 끝내기: RELAX → 표준 입력 닫기 → (끝나지 않으면) 상한 뒤 끝냄 — dispose가 돌아오면 도우미는 없다. 스스로 끝나는 쪽의 기다림은 넉넉하고, 끝내야 끝나는
 *   쪽만 짧다 (S9-22 TI-2 — 느린 PC에서 스스로 끝나는 도우미를 끝내지 않게)
 * - Windows 밖이면 unsupported (띄우지 않는다)
 * - AC-31 서버 모드: 하네스(서버 모드, 모의 메인 — 시작 전에 켬)의 hang 개발자 턴이 도는 동안 AWAKE, 메인 에이전트가 update_settings로 끄면 off·RELAX,
 *   긴급 정지로 턴이 끝나면 RELAX. 메인 턴은 모두 모의다
 * - 빌드한 서버(Windows, 실제 도우미 — 이 PC에서 잠깐 막는다, S9-13): 일하는 동안 status의 power가 awake, shutdown은 도우미를 끝낸 뒤 서버를 끝낸다
 * 띄운 가짜는 제품이 쥔 ChildProcess로만 끝난다 — 이 시험은 pid로 살았는지 보기만 한다 (리드 결정 S9-18)
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { adminRequest } from '../../src/server/admin';
import { formatStatus, powerText } from '../../src/server/cli';
import { createServerPower, POWER_PENDING_REASON, POWER_STABLE_MS, type ServerPower } from '../../src/server/power';
import { startServer, type AdminStatus, type RunningServer } from '../../src/server/server';
import { stillRunning } from '../acceptance/stops-helpers';
import { createHarness, type Harness } from '../e2e/harness';
import { fakeServerLauncher, type FakeServerLauncher, type FakeServerLauncherOptions } from '../fixtures/serverhelper/fakeServer';
import { pidAlive } from '../setup/runTemp';
import {
  buildServerTo,
  clientJson,
  descendantsOf,
  invokeHttp,
  issueTokenBuilt,
  memoryLogger,
  remoteBackendOf,
  removeDir,
  runClient,
  sleep,
  startBuilt,
  testBuildDir,
  type BuiltServer,
} from './helpers';

/** 와야 하는 답의 창 — 넉넉하게 */
const GENEROUS = 60_000;
/** 오지 않을 답의 창 — 짧게 (리드 결정 S9-18) */
const SHORT = 300;
/** 느린 PC 흉내 (리드 결정 S9-18) — 빌드한 서버 시험의 단계 사이에 이만큼 쉰다 (가짜 도우미의 늦춤은 WOOK_TEST_FAKE_SH_DELAY_MS) */
const PAUSE = Number(process.env['WOOK_TEST_PAUSE_MS'] ?? 0) || 0;
const powers: ServerPower[] = [];
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const p of powers.splice(0)) await p.dispose();
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) await removeDir(d);
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-srvpower-${tag}-`));
  dirs.push(d);
  return d;
};

/** since 전에 생겨 아직 살아 있는 자손 — 넉넉히 기다려 본 뒤의 목록 (보기만 한다, 끝내지 않는다) */
async function leftAfter(pids: number[], since: number, ms = GENEROUS): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = stillRunning(pids, since);
  while (left.length && Date.now() < deadline) {
    await sleep(250);
    left = stillRunning(pids, since);
  }
  return left;
}

async function waitFor(pred: () => boolean, label: string, ms = GENEROUS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`기다리다 시간이 지났습니다: ${label}`);
    await sleep(25);
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

function make(o: {
  fake?: Omit<FakeServerLauncherOptions, 'dir'>;
  dir?: string;
  active?: boolean;
  enabled?: boolean;
  platform?: NodeJS.Platform;
  readyMs?: number;
  ackMs?: number;
  graceMs?: number;
  cap?: number;
  now?: () => number;
}) {
  const dir = o.dir ?? tempDir('p');
  const fake = fakeServerLauncher({ dir, ...o.fake });
  const fb = fakeBackend({ active: o.active ?? false, enabled: o.enabled ?? true });
  const log = memoryLogger();
  const notes: string[] = [];
  const power = createServerPower({
    backend: fb.backend,
    launcher: fake,
    logger: log,
    notify: (t) => notes.push(t),
    platform: o.platform ?? 'win32',
    readyTimeoutMs: o.readyMs ?? GENEROUS,
    ackTimeoutMs: o.ackMs ?? GENEROUS,
    closeGraceMs: o.graceMs,
    syncMs: 0,
    ...(o.cap !== undefined ? { restartCap: o.cap } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  powers.push(power);
  const cmds = (): string[] => fake.log().filter((l) => l.startsWith('cmd ')).map((l) => l.slice(4));
  return { fake, fb, log, notes, power, cmds };
}

const alive = (fake: FakeServerLauncher): number[] => fake.pids('power').filter(pidAlive);

describe('서버 절전 방지 — 가짜 도우미 (리드 결정 S9-5)', () => {
  it('일이 없으면 띄우지 않는다(늦게). 작업 → AWAKE, 끝 → RELAX(도우미는 남는다), 설정을 끄면 작업 중에도 RELAX·off, 다시 켜면 AWAKE', async () => {
    const t = make({});
    expect(t.power.status()).toEqual({ state: 'idle', reason: null });
    // 띄우려 하지도 않았다(준비도 부르지 않음) — 설정을 다시 읽어도 그대로
    t.power.update();
    expect([t.fake.prepareCalls(), t.fake.launches('power')]).toEqual([0, 0]);
    // status는 도우미가 마지막으로 OK한 상태다 — 기다릴 때는 도우미가 받은 명령을 먼저 본다 (늦은 OK 사이의 옛 상태에 속지 않게, 리드 결정 S9-18)
    t.fb.setActive(true);
    await waitFor(() => t.cmds().length === 1 && t.power.status().state === 'awake', 'awake');
    expect(t.cmds()).toEqual(['AWAKE']);
    t.fb.setActive(false);
    await waitFor(() => t.cmds().length === 2 && t.power.status().state === 'idle', 'idle');
    expect(t.cmds()).toEqual(['AWAKE', 'RELAX']);
    expect(alive(t.fake)).toHaveLength(1);
    t.fb.setActive(true);
    await waitFor(() => t.cmds().length === 3 && t.power.status().state === 'awake', 'awake again');
    // 메인 에이전트가 설정을 끈다 — 다음 update()가 푼다
    t.fb.state.enabled = false;
    t.power.update();
    await waitFor(() => t.cmds().length === 4, 'RELAX by setting');
    expect(t.power.status()).toEqual({ state: 'off', reason: '설정 execution.preventSleep이 꺼져 있습니다' });
    t.fb.state.enabled = true;
    t.power.update();
    // RELAX의 OK가 온 뒤에야 AWAKE를 보낸다(한 번에 하나)
    await waitFor(() => t.cmds().length === 5 && t.power.status().state === 'awake', 'awake after enable');
    expect(t.cmds()).toEqual(['AWAKE', 'RELAX', 'AWAKE', 'RELAX', 'AWAKE']);
    expect(t.fake.launches('power')).toBe(1);
    expect(t.notes).toEqual([]);
  }, 120_000);

  const capCases: { name: string; fake: Omit<FakeServerLauncherOptions, 'dir'>; readyMs?: number; ackMs?: number; why: string }[] = [
    { name: 'AWAKE에 끝남', fake: { scenario: 'power-crash' }, why: '끝남 코드 9' },
    { name: 'READY 없음', fake: { scenario: 'power-no-ready' }, readyMs: SHORT, why: '0.3초 안에 READY 없음' },
    { name: 'OK 없음', fake: { scenario: 'power-no-ack' }, ackMs: SHORT, why: '0.3초 안에 OK 없음' },
  ];
  for (const c of capCases) {
    it(`상한: ${c.name} — 3번 다시 띄운 뒤(모두 4번) unavailable, 경고 한 줄·활동 기록 한 줄, 그 뒤로는 띄우지 않는다`, async () => {
      // 시계는 멈춰 둔다(아주 큰 값) — 어느 도우미도 '10분 돌았다'가 되지 않는다. 수를 잘못 처음부터 세면 상한 없이 다시 띄우므로, 그만둠을 기다리되 넷보다 많이
      // 띄우면 바로 멈춰 그 수로 본다 (확인 검토의 R1 — 이름 붙인 기다림이 아니라 단언으로 잡는다)
      const t = make({ fake: c.fake, readyMs: c.readyMs, ackMs: c.ackMs, active: true, now: () => 1e12 });
      await waitFor(() => t.power.status().state === 'unavailable' || t.fake.launches('power') > 4, '그만두거나 다섯째를 띄움');
      expect([t.fake.launches('power'), t.power.status().state]).toEqual([4, 'unavailable']);
      const reason = `절전 방지 도우미가 3번 다시 띄운 뒤에도 실패했습니다 (${c.why})`;
      expect(t.power.status()).toEqual({ state: 'unavailable', reason });
      expect(t.log.lines.filter((l) => l.startsWith('[WARN] 절전 방지를 쓸 수 없습니다'))).toEqual([`[WARN] 절전 방지를 쓸 수 없습니다 — ${reason}. 작업 중에도 PC가 절전에 들어갈 수 있습니다 (전원 설정에서 절전을 끄세요)`]);
      expect(t.log.lines.filter((l) => l.includes('필요하면 다시 띄웁니다'))).toHaveLength(3);
      expect(t.notes).toEqual([`절전 방지를 쓸 수 없습니다 — ${reason}`]);
      t.fb.setActive(false);
      t.fb.setActive(true);
      t.power.update();
      await sleep(200);
      expect(t.fake.launches('power')).toBe(4);
      await waitFor(() => alive(t.fake).length === 0, '가짜가 모두 끝남');
    }, 120_000);
  }

  it('상한은 잇단 실패만 센다: READY 뒤 10분(옮긴 시계) 넘게 돈 도우미가 끝나면 처음부터 센다 — 곧바로 다시 끝나면 그대로 세어 unavailable (S9-22)', async () => {
    let clock = 1_000_000;
    const dir = tempDir('stable');
    const dieFile = join(dir, 'die');
    // 상한 1: 잇단 실패 하나는 다시 띄우고, 둘이면 unavailable
    const t = make({ dir, fake: { scenario: 'power-die-on-file-n', dieFile }, active: true, cap: 1, now: () => clock });
    await waitFor(() => t.cmds().length === 1 && t.power.status().state === 'awake', '첫 도우미가 막음');
    // 1분 돈 첫 도우미가 끝난다 — 잇단 실패 1 (1/1), 다시 띄운다
    clock += 60_000;
    writeFileSync(`${dieFile}-1`, 'x');
    await waitFor(() => t.fake.launches('power') === 2 && t.power.status().state === 'awake', '둘째 도우미가 막음');
    // 둘째는 10분 넘게 돌고 끝난다 — 잇단 실패가 아니라 처음부터 (1/1), 다시 띄운다 (세기를 이어 가면 여기서 unavailable)
    clock += POWER_STABLE_MS;
    writeFileSync(`${dieFile}-2`, 'x');
    await waitFor(() => t.fake.launches('power') === 3 || t.power.status().state === 'unavailable', '셋째를 띄우거나 그만둠');
    expect(t.power.status().state).not.toBe('unavailable');
    await waitFor(() => t.cmds().filter((c) => c === 'AWAKE').length === 3 && t.power.status().state === 'awake', '셋째 도우미가 막음');
    // 셋째가 곧바로 끝난다 — 잇단 실패 2 > 상한 1 → unavailable, 더 띄우지 않는다
    writeFileSync(`${dieFile}-3`, 'x');
    await waitFor(() => t.power.status().state === 'unavailable' || t.fake.launches('power') === 4, '그만두거나 넷째를 띄움');
    expect([t.fake.launches('power'), t.power.status().state]).toEqual([3, 'unavailable']);
    expect(t.log.lines.filter((l) => l.includes('필요하면 다시 띄웁니다'))).toEqual([
      '[WARN] 절전 방지 도우미 실패 (끝남 코드 9) — 필요하면 다시 띄웁니다 (1/1)',
      '[WARN] 절전 방지 도우미 실패 (끝남 코드 9) — 필요하면 다시 띄웁니다 (1/1)',
    ]);
    expect(t.notes).toEqual(['절전 방지를 쓸 수 없습니다 — 절전 방지 도우미가 1번 다시 띄운 뒤에도 실패했습니다 (끝남 코드 9)']);
    await waitFor(() => alive(t.fake).length === 0, '가짜가 모두 끝남');
  }, 120_000);

  it('10분 창은 단조 시계로 잰다(기본 시계) — 벽시계(Date.now)가 11분 뛰어도 곧바로 다시 끝난 도우미는 잇단 실패로 센다 (S9-24)', async () => {
    const dir = tempDir('mono');
    const dieFile = join(dir, 'die');
    // 벽시계(Date.now)를 먼저 갈아 끼운다 — 제품이 Date.now를 쥐어 두어도 이것을 쥔다. 처음에는 실제 시각 그대로
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const jump = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      // 시계를 넣지 않는다 — 제품의 기본 시계
      const t = make({ dir, fake: { scenario: 'power-die-on-file-n', dieFile }, active: true, cap: 1 });
      await waitFor(() => t.cmds().length === 1 && t.power.status().state === 'awake', '첫 도우미가 막음');
      writeFileSync(`${dieFile}-1`, 'x');
      await waitFor(() => t.fake.launches('power') === 2 && t.cmds().length === 2 && t.power.status().state === 'awake', '둘째 도우미가 막음 (1/1)');
      // 벽시계만 11분 앞으로 (절전에서 깨어남·손으로 바꿈) — 단조 시계는 그대로다
      offset = 11 * 60_000;
      writeFileSync(`${dieFile}-2`, 'x');
      await waitFor(() => t.power.status().state === 'unavailable' || t.fake.launches('power') === 3, '그만두거나 셋째를 띄움');
      expect([t.fake.launches('power'), t.power.status().state]).toEqual([2, 'unavailable']);
    } finally {
      jump.mockRestore();
    }
  }, 120_000);

  it('작업 중인데 도우미가 아직 막았다고 답하지 않았으면 pending — 띄우기 전·READY를 기다리는 중·OK를 기다리는 중. idle(진행 중 작업이 없음)이라고 하지 않는다 (S9-22 DF-2)', async () => {
    const pending = { state: 'pending', reason: POWER_PENDING_REASON };
    const t = make({ fake: { scenario: 'power-no-ready' } });
    expect(t.power.status()).toEqual({ state: 'idle', reason: null });
    t.fb.setActive(true);
    // 작업이 생긴 그 자리 — 아직 띄우지도 않았다
    expect(t.power.status()).toEqual(pending);
    await waitFor(() => t.fake.launches('power') === 1, '가짜가 뜸 (READY를 내지 않는다)');
    expect(t.power.status()).toEqual(pending);
    expect(powerText(t.power.status())).toBe(`pending — ${POWER_PENDING_REASON}`);
    // 작업이 끝나면 idle
    t.fb.setActive(false);
    expect(t.power.status()).toEqual({ state: 'idle', reason: null });
    // READY는 오고 OK가 오지 않는 도우미 — AWAKE를 받은 뒤에도 pending
    const u = make({ fake: { scenario: 'power-no-ack' } });
    u.fb.setActive(true);
    await waitFor(() => u.cmds().includes('AWAKE'), '가짜가 AWAKE를 받음');
    expect(u.power.status()).toEqual(pending);
    expect(powerText(u.power.status())).not.toContain('진행 중 작업이 없어');
  }, 120_000);

  it('작업 중에 설정을 켜면 다음 맞추기(update — 30초마다) 전에도 pending — idle(진행 중 작업 없음)이라고 하지 않는다. 설정을 바꾼 턴이 끝나고 다른 턴이 돌아도 그대로 (S9-24 R2S-1)', async () => {
    const pending = { state: 'pending', reason: POWER_PENDING_REASON };
    // 작업이 돌고 설정은 꺼져 있다 — 판단은 막지 않기로 했다
    const t = make({ active: true, enabled: false });
    expect(t.power.status()).toEqual({ state: 'off', reason: '설정 execution.preventSleep이 꺼져 있습니다' });
    // 메인 에이전트의 update_settings가 켠다 — 서버는 아직 update()를 부르지 않았다(판단은 그대로, 도우미도 아직 띄우지 않음)
    t.fb.state.enabled = true;
    expect([t.power.status(), t.fake.prepareCalls()]).toEqual([pending, 0]);
    expect(powerText(t.power.status())).toBe(`pending — ${POWER_PENDING_REASON}`);
    // 설정을 바꾼 턴이 끝나도 다른 턴이 돌고 있으면 작업 바뀜 알림이 없다 — 그래도 pending
    t.fb.state.active = true;
    expect(t.power.status()).toEqual(pending);
    // 다음 맞추기에 막는다 — 도우미가 답하면 awake (보내는 때는 판단이 정한다 — status가 바꾸지 않는다)
    t.power.update();
    await waitFor(() => t.cmds().length === 1 && t.power.status().state === 'awake', 'awake');
    // 작업이 모두 끝나고 풀리면 idle
    t.fb.setActive(false);
    await waitFor(() => t.cmds().length === 2 && t.power.status().state === 'idle', 'idle');
    // 작업이 있는지 읽지 못하면(던짐) 판단이 바란 것을 따른다 — 지금은 막지 않기로 했으니 idle
    t.fb.backend.hasActiveWork = () => {
      throw new Error('읽지 못함');
    };
    expect(t.power.status()).toEqual({ state: 'idle', reason: null });
  }, 120_000);

  it('준비 실패(csc 없음)는 바로 unavailable — 띄우지 않는다', async () => {
    const t = make({ fake: { prepareFails: 'C# 컴파일러(csc.exe, .NET Framework 4.x)를 찾을 수 없습니다' }, active: true });
    await waitFor(() => t.power.status().state === 'unavailable', 'unavailable');
    expect(t.power.status()).toEqual({ state: 'unavailable', reason: 'C# 컴파일러(csc.exe, .NET Framework 4.x)를 찾을 수 없습니다' });
    expect(t.fake.launches('power')).toBe(0);
    expect(t.notes).toHaveLength(1);
  });

  it('끝내기: 막는 중이면 RELAX를 보내고 표준 입력을 닫는다 — dispose가 돌아오면 도우미가 없다', async () => {
    // 스스로 끝나는 도우미를 기다리는 창은 넉넉하게 — 느린 PC에서 끝내 버리지 않게 (리드 결정 S9-22 TI-2)
    const t = make({ active: true, graceMs: GENEROUS });
    await waitFor(() => t.power.status().state === 'awake', 'awake');
    const pids = t.fake.pids('power');
    await t.power.dispose();
    expect(pids.filter(pidAlive)).toEqual([]);
    expect(t.cmds()).toEqual(['AWAKE', 'RELAX']);
    expect(t.fake.log().some((l) => l === 'exit eof relax')).toBe(true);
  }, 120_000);

  it('끝내기: 표준 입력이 닫혀도 남는 도우미는 상한 뒤 쥔 핸들로 끝낸다 — dispose가 돌아오면 없다', async () => {
    const t = make({ fake: { scenario: 'power-ignore-eof' }, active: true, graceMs: SHORT });
    await waitFor(() => t.power.status().state === 'awake', 'awake');
    const pids = t.fake.pids('power');
    await t.power.dispose();
    expect(pids.filter(pidAlive)).toEqual([]);
    // 스스로 끝나지 않았다(끝 줄이 없다) — 쥔 핸들로 끝냈다. 가짜가 입력의 끝을 받아 'eof ignored'를 적었는지는 보지 않는다: 느린 PC에서는 그 전에 끝내는 것이
    // 맞다 (리드 결정 S9-22 TI-2 — 늦춘 시험에서 찾음)
    expect(t.fake.log().some((l) => l.startsWith('exit '))).toBe(false);
  }, 120_000);

  it('Windows 밖이면 unsupported — 작업이 있어도 띄우지 않는다', async () => {
    const t = make({ platform: 'linux', active: true });
    t.fb.setActive(true);
    await sleep(100);
    expect(t.power.status()).toEqual({ state: 'unsupported', reason: '절전 방지 도우미는 Windows 서버에서만 씁니다' });
    expect(t.fake.launches('power')).toBe(0);
  });
});

describe.runIf(process.platform === 'win32' && !!process.env['WOOK_TEST_SERVER_HELPER_BIN'])('빌드한 서버 — 실제 서버 도우미로 절전 방지 (Windows, 잠깐)', () => {
  it('hang 개발자 턴이 도는 동안 status의 power가 awake, shutdown하면 도우미를 풀고 끝낸 뒤 서버가 끝난다 — 남은 자손 없음, 메인 턴은 모두 모의', async () => {
    const buildDir = testBuildDir('srvpower');
    let srv: BuiltServer | null = null;
    let entry = '';
    cleanups.push(async () => {
      if (srv && srv.child.exitCode === null && srv.child.signalCode === null) {
        runClient(entry, ['shutdown', '--data-dir', srv.dataDir]);
        await Promise.race([srv.exited, sleep(40_000)]);
        // 시험이 띄운 서버만, 쥔 핸들로
        if (srv.child.exitCode === null && srv.child.signalCode === null) srv.child.kill();
      }
      await removeDir(buildDir);
    });
    entry = buildServerTo(buildDir);
    // 모의 메인과 hang 개발자로 데이터 폴더를 준비한다 — 빌드한 서버가 이 PC의 실제 Claude·Codex CLI 턴을 띄우지 않게 (리드 결정 S6-19)
    const h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' } });
    const dataDir = h.dataDir;
    const projectId = h.projectId;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    srv = await startBuilt({ entry, dataDir, args: ['--allow-test-session'] });
    const powerNow = (): AdminStatus['power'] => (clientJson(entry, ['status', '--data-dir', dataDir]).reply.result as AdminStatus).power;
    expect(powerNow()).toEqual({ state: 'idle', reason: null });
    const token = issueTokenBuilt(entry, dataDir);
    expect((await invokeHttp(srv.url, token, 'command.send', [{ target: projectId, text: '로그인 화면을 만들어 줘' }])).status).toBe(200);
    const deadline = Date.now() + 120_000;
    while (powerNow()?.state !== 'awake') {
      if (Date.now() > deadline) throw new Error(`절전 방지가 켜지지 않았습니다: ${JSON.stringify(powerNow())}`);
      await sleep(250);
    }
    await sleep(PAUSE);
    const children = descendantsOf(srv.child.pid);
    const stopAt = Date.now();
    const down = runClient(entry, ['shutdown', '--data-dir', dataDir]);
    expect([down.code, down.stdout.trim()]).toEqual([0, '서버를 종료했습니다.']);
    expect((await srv.exited).code).toBe(0);
    // 끝난 도우미의 콘솔 호스트는 조금 늦게 끝날 수 있다 — 끝남은 넉넉한 창으로 본다 (부하 속 이웃 시험 묶음에서 찾음, 리드 결정 S9-18)
    expect(await leftAfter(children, stopAt)).toEqual([]);
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    const relaxed = log.indexOf('절전 방지 도우미를 끝냈습니다 (pid ');
    expect(relaxed).toBeGreaterThan(0);
    expect(relaxed).toBeLessThan(log.indexOf('욱채 서버 종료 (코드 0)'));
    // 끝난 것을 확인했다 — 제품의 1초 기다림 안에 스스로 끝났는지는 보지 않는다(느린 PC에서는 제품이 끝내는 것이 맞다, S9-22 TI-2)
    expect(log).not.toMatch(/절전 방지 도우미를 끝냈습니다 \([^)]*확인하지 못함/);
    const store = openStore(dataPaths(dataDir).db);
    try {
      expect(store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock)).toEqual([]);
    } finally {
      store.close();
    }
  }, 240_000);
});

describe('AC-31 서버 모드 — 개발자 턴이 도는 동안 절전 방지 (리드 결정 S9-5)', () => {
  it('hang 개발자 턴 → AWAKE, 메인 에이전트가 update_settings로 끄면 off·RELAX, 다시 켜면 AWAKE, 긴급 정지로 턴이 끝나면 RELAX — status의 power가 같다', async () => {
    const dir = tempDir('ac31');
    const fake = fakeServerLauncher({ dir });
    const h: Harness = await createHarness({ mode: 'server', team: ['developer'], scenarios: { developer: 'hang' } });
    let server: RunningServer | null = null;
    cleanups.push(async () => {
      await server?.close();
      await h.close();
    });
    const power = createServerPower({ backend: h.orch.backend, launcher: fake, logger: memoryLogger(), platform: 'win32', readyTimeoutMs: GENEROUS, ackTimeoutMs: GENEROUS, syncMs: 0 });
    powers.push(power);
    server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test', powerStatus: () => power.status() });
    const powerOf = async (): Promise<AdminStatus['power']> => ((await adminRequest({ dataDir: h.dataDir, command: 'status' })) as { result: AdminStatus }).result.power;
    expect(await powerOf()).toEqual({ state: 'idle', reason: null });
    const grant = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
    const token = (grant as { result: { token: string } }).result.token;
    const sent = await invokeHttp(server.url, token, 'command.send', [{ target: h.projectId, text: '로그인 화면을 만들어 줘' }]);
    expect(sent.status).toBe(200);
    await h.waitFor(() => h.core.turns.isMemberRunning(h.members.developer!), { timeoutMs: 120_000, label: '개발자 턴 실행' });
    const cmds = (): string[] => fake.log().filter((l) => l.startsWith('cmd ')).map((l) => l.slice(4));
    // status는 도우미가 마지막으로 OK한 상태다 — 받은 명령을 먼저 본다 (리드 결정 S9-18)
    await waitFor(() => cmds().length === 1 && power.status().state === 'awake', 'awake');
    expect(await powerOf()).toEqual({ state: 'awake', reason: null });
    // 운영 설정에서 끄기·켜기 — 메인 에이전트가 update_settings로 한다 (서버는 30초마다 update()로 맞춘다 — 여기서는 바로 부른다)
    await h.main('update_settings', { patch: { execution: { preventSleep: false } } });
    power.update();
    await waitFor(() => cmds().length === 2, 'RELAX by setting');
    expect(await powerOf()).toEqual({ state: 'off', reason: '설정 execution.preventSleep이 꺼져 있습니다' });
    await h.main('update_settings', { patch: { execution: { preventSleep: true } } });
    // 다음 맞추기(update) 전 — 개발자 턴이 돌고 막지는 않은 그 사이: status(--json의 power)는 pending, 사람용 글도 '진행 중 작업 있음'과 함께 pending (S9-24 R2S-1).
    // status는 도우미가 마지막으로 OK한 상태부터 본다 — 앞의 RELAX에 OK가 늦게 오면 그때까지는 awake다(늦춘 시험에서 찾음). 그 OK를 기다린다(이 시험은 자동 맞추기가 없다)
    await waitFor(() => power.status().state !== 'awake', 'RELAX의 OK');
    const between = ((await adminRequest({ dataDir: h.dataDir, command: 'status' })) as { result: AdminStatus }).result;
    expect(between.power).toEqual({ state: 'pending', reason: POWER_PENDING_REASON });
    const text = formatStatus(between).split('\n');
    expect([text.includes('  진행 중 작업  있음'), text.includes(`  절전 방지     pending — ${POWER_PENDING_REASON}`), text.some((l) => l.includes('진행 중 작업이 없어'))]).toEqual([true, true, false]);
    expect(cmds()).toHaveLength(2);
    power.update();
    await waitFor(() => cmds().length === 3 && power.status().state === 'awake', 'awake again');
    // 실행 중인 작업을 모두 멈추면 풀린다
    expect((await invokeHttp(server.url, token, 'stop.emergency')).status).toBe(200);
    await h.waitFor(() => h.core.turns.count() === 0, { timeoutMs: 60_000, label: '턴 종료' });
    await waitFor(() => cmds().length === 4 && power.status().state === 'idle', 'idle after stop');
    expect(cmds()).toEqual(['AWAKE', 'RELAX', 'AWAKE', 'RELAX']);
    // 이 백엔드에서 돈 메인 턴은 모두 모의다
    expect(h.core.ctx.store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock)).toEqual([]);
  }, 240_000);
});
