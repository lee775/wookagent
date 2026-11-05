/**
 * taskkill 대체 러너: 작업 개체에 넣기를 기다리며 입력을 붙잡는 동안 정지하면 (stage-7 리뷰 taskkill7 D2 → S8-C2, stage-7 회귀 — CTL-03·AC-15 '정지 결과는
 * 실제로 일어난 일만', CTL-11 알림 문구).
 * 정지 요청이 오면 입력(검사의 시작 신호·CLI의 프롬프트)을 주지 않는다 — 주면 정지된 실행이 일을 시작한다. 예전에는 넣기(ADD)가 느려(1.5초 < ADD
 * < 정지 + 1초) 입력 상한(INPUT_HOLD_MAX_MS)이 지나면, 실제로는 입력을 주지 않았는데도 '먼저 줬다'고 적어(inputEarly) 정지를 확인 불가(-1)로,
 * '…시작 신호를 먼저 줬습니다'라고 알렸다 — 검사는 아무것도 띄우지 않았고(pause에서 기다림) 작업 개체가 트리 전체를 담아 비었는데도. 이제 넣기 전에
 * 입력을 실제로 썼을 때만 그렇게 적는다. 실제 PowerShell 도우미(넣기만 늦춤)·실제 프로세스 (Windows 전용)
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProcessRunner, INPUT_HOLD_MAX_MS } from '../../src/main/process/processRunner';
import { createJobHelper, type JobHelper } from '../../src/main/process/jobHelper';
import { shellCommand } from '../../src/main/orchestrator/autocheck';
import type { ManagedProcess, ProcessRunner } from '../../src/main/process/types';

const isWin = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 실제 도우미 앞에 넣기 지연 (바쁜 PC·도우미 정체) */
function slowHelper(delayMs: number): JobHelper {
  const real = createJobHelper({ log: () => undefined });
  return {
    ready: (t) => real.ready(t),
    isReady: () => real.isReady(),
    problem: () => real.problem(),
    onProblem: (cb) => real.onProblem(cb),
    dispose: () => real.dispose(),
    async adopt(pid, window) {
      await sleep(delayMs);
      return real.adopt(pid, window);
    },
  };
}

describe.skipIf(!isWin)('taskkill 대체 러너: 입력을 붙잡는 동안 정지하면 주지 않은 입력을 먼저 줬다고 하지 않는다 (S8-C2, CTL-03·11, AC-15)', () => {
  let root: string;
  const runners: ProcessRunner[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-hold-stop-'));
    await mkdir(join(root, 'w'), { recursive: true });
    // CLI 대역: 프롬프트(표준 입력)를 받으면 파일에 적는다
    await writeFile(join(root, 'cli.cjs'), `process.stdin.on('data', () => require('fs').writeFileSync(process.argv[2], 'got')); setTimeout(() => {}, 30000);`);
  });

  afterAll(async () => {
    for (const r of runners) r.dispose?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  async function runner(delayMs: number): Promise<ProcessRunner> {
    const r = await createProcessRunner({ dataDir: join(root, `d${runners.length}`), forceMode: 'taskkill', log: () => undefined, jobHelper: slowHelper(delayMs) });
    runners.push(r);
    return r;
  }

  /** 검사 대역: 시작하면(시작 신호를 받은 뒤) 파일을 남기고 오래 돈다 */
  function startCheck(r: ProcessRunner, marker: string): ManagedProcess {
    const sh = shellCommand(`"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], 'x'); setTimeout(() => {}, 30000)" "${marker}"`);
    return r.start({ command: sh.command, args: sh.args, verbatimArgs: sh.verbatimArgs, consoleOutput: sh.consoleOutput, ...(sh.adoptGate ? { adoptGate: sh.adoptGate } : {}), cwd: join(root, 'w'), env: { ...process.env }, stdinText: null, label: '검사 대역' });
  }

  it('검사: 넣기(1.8초)를 기다리는 1.1초에 정지 — 시작 신호를 주지 않아 검사는 시작하지 않았고 작업 개체가 비었으니 종료 확인(ok, 0) (예전: -1 · 시작 신호를 먼저 줬습니다)', async () => {
    const r = await runner(1800);
    const marker = join(root, 'started-1.txt');
    const proc = startCheck(r, marker);
    await sleep(1100);
    const res = await proc.terminate({ reason: '긴급 정지' });
    const info = await proc.exited;
    await sleep(300);
    expect(existsSync(marker), '시작 신호를 주지 않았으므로 검사는 시작하지 않았다').toBe(false);
    expect(res.detail).not.toContain('먼저 줬습니다');
    expect({ ok: res.ok, remaining: res.remaining }, res.detail).toEqual({ ok: true, remaining: 0 });
    expect({ remaining: info.remaining, terminated: info.terminated }).toEqual({ remaining: 0, terminated: true });
  }, 60_000);

  it('CLI: 같은 때 정지하면 프롬프트를 주지 않았다 — 늦게 넣은 것(시작 단계 상한 100ms)만 까닭으로 적고, 먼저 줬다고 하지 않는다', async () => {
    const r = await runner(1800);
    const got = join(root, 'got.txt');
    const proc = r.start({ command: process.execPath, args: [join(root, 'cli.cjs'), got], cwd: join(root, 'w'), env: { ...process.env }, stdinText: '작업 카드', label: 'claude 대역' });
    await sleep(1100);
    const res = await proc.terminate({ reason: '긴급 정지' });
    await proc.exited;
    await sleep(300);
    expect(existsSync(got), '프롬프트를 주지 않았다').toBe(false);
    expect(res.detail).not.toContain('먼저 줬습니다');
    expect(res.detail).toContain('뒤에야 작업 개체에 넣었습니다 (상한 100ms)');
    expect(res.remaining).toBe(-1);
  }, 60_000);

  it('대조: 입력 상한(1.5초)이 지나 시작 신호를 실제로 먼저 준 뒤에 정지하면 여전히 확인 불가(-1) · 시작 신호를 먼저 줬습니다', async () => {
    const r = await runner(2200);
    const marker = join(root, 'started-3.txt');
    const proc = startCheck(r, marker);
    await sleep(INPUT_HOLD_MAX_MS + 300);
    const res = await proc.terminate({ reason: '긴급 정지' });
    await proc.exited;
    expect(existsSync(marker), '상한이 지나 시작 신호를 줬으므로 검사가 시작했다').toBe(true);
    expect({ ok: res.ok, remaining: res.remaining }, res.detail).toEqual({ ok: false, remaining: -1 });
    expect(res.detail).toContain('시작 신호를 먼저 줬습니다');
  }, 60_000);
});
