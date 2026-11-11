/**
 * 시험의 정리는 기록해 둔 PID로 죽이지 않는다 (리드 결정 S7-20 TI-8 — 대표가 쓰는 PC에서 시험이 돈다).
 * 끝난 프로세스의 PID 번호는 Windows가 곧 다른 프로세스(다른 시험의 자식·대표의 프로그램)에 다시 준다. 예전 정리 도구는 기록한 번호를 그대로 죽였다 —
 * 가짜 화면 도우미의 killFakePids는 띄운 적 있는 모든 PID를, 실제 프로세스 묶음의 killMarked는 기록 파일의 PID를 트리째(taskkill /T) 끝냈다.
 * 이제: 가짜 화면 도우미는 그 폴더의 그만 파일(quit-<PID>)이나 폴더가 지워지면 스스로 끝나고, killMarked는 지금 명령줄에 표식이 든 프로세스만 하나씩 끝낸다.
 * 여기서는 '남의 프로세스' 대역(이 시험이 핸들로 띄운 자식 — 끝은 그 핸들로)을 그 정리 도구에 넘겨도 살아 있는지, 그리고 정리 도구가 제 프로세스는 끝내는지 본다.
 * 가짜 화면 도우미만 쓴다 (화면을 찍거나 입력을 보내지 않는다)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDesktop, killFakePids, pidAlive, type FakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { createProcRig, killMarked, markedProcesses, sleep, type ProcRig } from '../acceptance/stops-helpers';
import type { DesktopHelperClient } from '../../src/main/desktop/types';

const fakes: FakeDesktop[] = [];
const clients: DesktopHelperClient[] = [];
/** '남의 프로세스' 대역 — 이 시험이 띄웠으므로 그 핸들로 끝낸다 */
const strangers: ChildProcess[] = [];
const rigs: ProcRig[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.dispose().catch(() => undefined);
  for (const f of fakes.splice(0)) await f.cleanup();
  for (const s of strangers.splice(0)) if (s.exitCode === null && s.signalCode === null) s.kill();
  for (const r of rigs.splice(0)) r.cleanup();
});

/** 정리 도구가 건드리면 안 되는 프로세스 (이 시험의 자식이지만 정리 도구에는 '모르는 PID'다) */
function stranger(): ChildProcess {
  const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000)'], { stdio: 'ignore', windowsHide: true });
  strangers.push(s);
  return s;
}

async function gone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < until) await sleep(25);
  return !pidAlive(pid);
}

describe('시험 정리 도구는 기록한 PID로 죽이지 않는다 (S7-20 TI-8)', () => {
  it('killFakePids: 어느 가짜 화면 도우미의 것도 아닌 PID는 건드리지 않고, 끝나지 않는 가짜는 그만 파일로 스스로 끝난다', async () => {
    const other = stranger();
    // 끝나지 않는 가짜: STOP에 답하지 않고 표준 입력이 닫혀도 끝나지 않으며, 클라이언트도 끝내지 않는다
    const f = createFakeDesktop({ noAck: ['STOP'], ignoreEof: true });
    fakes.push(f);
    const c = f.client({ kill: () => undefined, timeouts: { READY: 5000 } });
    clients.push(c);
    expect((await c.ready()).ok).toBe(true);
    const pid = f.pids()[0]!;
    // 예전에는 이 번호를 그대로 죽였다 — 그 번호를 남이 쓰고 있었다면 남이 죽는다
    killFakePids([other.pid!, pid]);
    await sleep(300);
    expect([other.exitCode, other.signalCode], '남의 프로세스 대역은 살아 있다').toEqual([null, null]);
    expect(await gone(pid, 3000), '가짜는 그만 파일로 끝났다').toBe(true);
    expect(f.log().some((e) => e.pid === pid && e.dir === 'note' && e.line === 'quit')).toBe(true);
  });

  it('가짜 화면 도우미는 제 폴더가 지워지면(cleanup) 스스로 끝난다 — 정리가 그 PID를 몰라도 남지 않는다', async () => {
    const f = createFakeDesktop({ noAck: ['STOP'], ignoreEof: true });
    const c = f.client({ kill: () => undefined, timeouts: { READY: 5000 } });
    clients.push(c);
    expect((await c.ready()).ok).toBe(true);
    const pid = f.pids()[0]!;
    await f.cleanup();
    expect(await gone(pid, 3000)).toBe(true);
  });

  it('killMarked: 지금 명령줄에 표식이 든 프로세스만 끝낸다 — 기록 파일의 PID가 남의 것이 돼 있어도 건드리지 않는다', async () => {
    const rig = createProcRig();
    rigs.push(rig);
    const other = stranger();
    // 표식이 든 우리 프로세스 (개발 서버 대역)
    const ours = spawn(process.execPath, [`${rig.dir}/devserver.cjs`, `${rig.dir}/killmarked-direct.json`, rig.marker], { stdio: 'ignore', windowsHide: true });
    strangers.push(ours);
    const until = Date.now() + 10_000;
    while (!rig.records().some((r) => r.file === 'killmarked-direct.json') && Date.now() < until) await sleep(50);
    expect(markedProcesses(rig.marker).map((p) => p.pid)).toEqual([ours.pid]);
    // 기록 파일에 남의 PID가 적힌 것처럼 (끝난 우리 프로세스의 번호를 남이 받은 경우)
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${rig.dir}/reused.json`, JSON.stringify({ pid: other.pid }));
    rig.cleanup();
    expect(await gone(ours.pid!, 5000), '표식이 든 우리 프로세스는 끝났다').toBe(true);
    await sleep(200);
    expect([other.exitCode, other.signalCode], '기록 파일에 적힌 남의 프로세스 대역은 살아 있다').toEqual([null, null]);
    // killMarked를 따로 불러도 같다
    killMarked(rig.marker);
    expect([other.exitCode, other.signalCode]).toEqual([null, null]);
  }, 60_000);
});
