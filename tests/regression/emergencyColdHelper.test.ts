/**
 * 긴급 정지와 작업 개체 도우미가 다시 뜨는 순간 (stage-5 process-sleep 결함 1 — AC-29 '긴급 정지 후 CLI가 띄운 하위 프로세스가 하나도 남지 않는다',
 * AC-15·CTL-03 '남은 프로세스가 있으면 정지 완료로 표시하지 않는다').
 * taskkill 대체 방식에서 작업 턴을 띄우는 순간 도우미가 (다시) 뜨는 중이면(앱 시작 뒤 첫 실행·도우미가 죽은 뒤), 예전에는 CLI를 먼저 띄우고 도우미가
 * 뜰 때까지(약 0.3초) 작업 개체에 넣지 못했다 — 그 사이 중간 프로세스가 분리된 개발 서버(고아)를 띄우고 끝나면 고아는 작업 개체 밖에 남는데,
 * 긴급 정지 요약은 '종료 확인'·완료였다. 이제 턴은 CLI를 띄우기 전에 도우미 준비를 기다린다(runner.ready).
 * AC-29 taskkill 완료 기준 시험과 같은 장치이고, 다른 점은 두 가지: 작업 턴을 띄우기 직전 러너의 도우미를 내린다(다시 뜨는 경로), 중간 프로세스가 30ms 뒤 끝난다
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { createProcRig, markedProcesses, sleep } from '../acceptance/stops-helpers';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      // 정리
    }
  }
});

const FAST_LAUNCHER = `const { spawn } = require('child_process');
const [, , server, out, marker] = process.argv;
const c = spawn(process.execPath, [server, out, marker], { detached: true, stdio: 'ignore', windowsHide: true });
c.unref();
setTimeout(() => process.exit(0), 30);
`;

const liveTaskTurns = (h: Harness) => h.core.turns.running().filter((r) => r.sessionKey.startsWith('task:'));

describe.skipIf(process.platform !== 'win32')('긴급 정지: 작업 턴을 띄울 때 작업 개체 도우미가 다시 뜨는 중이었어도 (AC-29, CTL-03)', () => {
  it('도우미를 막 다시 띄운 작업 턴의 고아 개발 서버까지 긴급 정지로 끝나고, 남은 것이 있는데 완료라고 하지 않는다', async () => {
    const rig = createProcRig();
    cleanups.push(() => rig.cleanup());
    writeFileSync(join(rig.dir, 'launcher.cjs'), FAST_LAUNCHER);
    const h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' }, runnerMode: 'taskkill' });
    cleanups.push(() => h.close());
    const adapter = h.core.ctx.deps.adapters.mock;
    const orig = adapter.prepare.bind(adapter);
    adapter.prepare = async (launch) => {
      const r = await orig(launch);
      if (!launch.mock || !launch.mock.workKey.startsWith('task:')) return r;
      // 도우미 재시작과 같은 경로: 이 턴의 CLI는 새로 뜨는 도우미가 받는다
      h.core.ctx.deps.runner.dispose?.();
      return { ...r, spec: { ...r.spec, args: [join(rig.dir, 'cli-wrapper.mjs'), rig.dir, rig.marker, ...r.spec.args] } };
    };
    await sendCommand(h, '로그인 화면을 만들어 줘');
    await h.waitFor(() => liveTaskTurns(h).length === 1 && rig.records('turn-').filter((r) => r.port).length === 3, { timeoutMs: 90_000, label: '개발 서버 3개' });
    await sleep(700); // 고아를 만든 중간 프로세스가 먼저 끝날 때까지

    const summary = await h.invoke('stop.emergency');
    await sleep(300);
    const left = markedProcesses(rig.marker);
    expect(summary.completed && left.length > 0, `남은 프로세스 ${left.length}개가 있는데 긴급 정지 요약이 '완료'`).toBe(false);
    expect(left.map((p) => p.cmd)).toEqual([]);
    expect(summary.completed).toBe(true);
  }, 180_000);
});
