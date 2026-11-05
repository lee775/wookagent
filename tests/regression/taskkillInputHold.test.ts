/**
 * taskkill 대체 러너: 작업 개체에 넣을 때까지 프롬프트를 붙잡는 시간의 상한 (stage-6 리뷰 process-shutdown D5 → S7-C3 — CLI-10·AC-36 '턴의 메시지가
 * CLI에 전달된다', S6-E1 '표준 입력(프롬프트)은 넣은 뒤에 준다').
 * Claude CLI(-p, 프롬프트는 표준 입력으로만)는 표준 입력을 3초 기다리고 오지 않으면 입력 없이 진행한다("no stdin data received in 3s, proceeding
 * without it"). 예전에는 넣기(ADD)가 끝날 때까지 프롬프트를 무조건 붙잡아, 도우미가 느리면(바쁜 PC·백신 검사로 PowerShell 준비가 늦음·ADD 정체)
 * 그 턴은 메시지 없이 돌았다. 이제 넣기를 1.5초(INPUT_HOLD_MAX_MS)까지만 기다리고 프롬프트를 주며, 그 실행은 넣기 전에 일이 시작됐으므로
 * 종료 확인 불가(-1)로 알린다. 자동 검사의 시작 신호도 같은 상한을 쓴다. 실제 PowerShell 도우미(넣기만 늦춤)·실제 프로세스 (Windows 전용)
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProcessRunner, INPUT_HOLD_MAX_MS } from '../../src/main/process/processRunner';
import { createJobHelper, type JobHelper } from '../../src/main/process/jobHelper';
import { shellCommand } from '../../src/main/orchestrator/autocheck';
import type { ProcessRunner } from '../../src/main/process/types';

const isWin = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Claude CLI 대역: 표준 입력을 3초 기다리고, 그 안에 아무것도 오지 않으면 입력 없이 진행한다(프롬프트를 잃음). 받았으면 끝까지 읽는다
const CLI = `const t0 = Date.now(); let got = ''; let done = false;
const say = (o) => { if (done) return; done = true; process.stdout.write(JSON.stringify({ ...o, ms: Date.now() - t0 }) + '\\n'); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (got += d));
process.stdin.on('end', () => say(got ? { got } : { lost: true, why: 'eof' }));
setTimeout(() => { if (!got) say({ lost: true, why: 'no stdin data received in 3s, proceeding without it' }); }, 3000);`;

/** 실제 도우미 앞에 넣기 지연 (도우미 준비가 늦거나 ADD가 정체된 경우) */
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

describe.skipIf(!isWin)('taskkill 대체 러너: 넣기를 기다리며 입력을 붙잡는 시간에는 상한이 있다 (S7-C3, CLI-10·AC-36)', () => {
  let root: string;
  const runners: ProcessRunner[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-input-hold-'));
    await mkdir(join(root, 'w'), { recursive: true });
    await writeFile(join(root, 'cli.cjs'), CLI);
  });

  afterAll(async () => {
    for (const r of runners) r.dispose?.();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function runner(delayMs: number): Promise<ProcessRunner> {
    const r = await createProcessRunner({ dataDir: join(root, `d${runners.length}`), forceMode: 'taskkill', log: () => undefined, jobHelper: slowHelper(delayMs) });
    runners.push(r);
    return r;
  }

  it('도우미가 4초 늦게 넣어도 CLI는 3초 안에 프롬프트를 받는다 — 그 턴은 넣기 전에 시작됐으므로 종료 확인 불가(-1)로 알린다 (예전: 프롬프트를 잃음)', async () => {
    const r = await runner(4000);
    const lines: string[] = [];
    const proc = r.start({ command: process.execPath, args: [join(root, 'cli.cjs')], cwd: join(root, 'w'), env: { ...process.env }, stdinText: '작업 카드: 로그인 화면', label: 'claude 대역' });
    proc.onStdoutLine((l) => lines.push(l));
    const info = await proc.exited;
    const reply = JSON.parse(lines[0] ?? '{}') as { got?: string; lost?: boolean; ms?: number };
    expect(reply, JSON.stringify(lines)).toMatchObject({ got: '작업 카드: 로그인 화면' });
    expect(reply.ms!).toBeLessThan(3000);
    expect(reply.ms!).toBeGreaterThanOrEqual(INPUT_HOLD_MAX_MS - 300); // 넣기를 기다리긴 했다 (바로 준 것이 아니다)
    expect(info.remaining, info.detail).toBe(-1);
    expect(info.detail).toContain('먼저 줬습니다');
  }, 60_000);

  it('넣기가 입력 상한(1.5초) 안에 끝나면 상한을 기다리지 않고 넣은 뒤에 프롬프트를 준다 (0.4초 넣기는 프롬프트 CLI의 시작 단계 상한 100ms를 넘어 확인 불가)', async () => {
    const r = await runner(400);
    const lines: string[] = [];
    const proc = r.start({ command: process.execPath, args: [join(root, 'cli.cjs')], cwd: join(root, 'w'), env: { ...process.env }, stdinText: '작업 카드', label: 'claude 대역' });
    proc.onStdoutLine((l) => lines.push(l));
    const info = await proc.exited;
    const reply = JSON.parse(lines[0] ?? '{}') as { got?: string; ms?: number };
    expect(reply).toMatchObject({ got: '작업 카드' });
    expect(reply.ms!).toBeGreaterThanOrEqual(250); // 넣기(약 0.4초)가 끝난 뒤에 받았다
    expect(reply.ms!).toBeLessThan(INPUT_HOLD_MAX_MS - 300); // 상한까지 기다리지 않았다
    expect(info.remaining).toBe(-1);
    expect(info.detail).toContain('뒤에야 작업 개체에 넣었습니다 (상한 100ms)');
    expect(info.detail).not.toContain('먼저 줬습니다');
  }, 60_000);

  it('자동 검사의 시작 신호도 같은 상한으로 준다 — 도우미가 4초 늦어도 검사는 1.5초쯤 시작하고, 넣기 전에 시작했으므로 확인 불가(-1)', async () => {
    const r = await runner(4000);
    const out = join(root, 'started.txt');
    const sh = shellCommand(`"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(Date.now()))" "${out}"`);
    const t0 = Date.now();
    const proc = r.start({ command: sh.command, args: sh.args, verbatimArgs: sh.verbatimArgs, consoleOutput: sh.consoleOutput, ...(sh.adoptGate ? { adoptGate: sh.adoptGate } : {}), cwd: join(root, 'w'), env: { ...process.env }, stdinText: null, label: '검사 대역' });
    const info = await proc.exited;
    expect(info.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const startedAfter = Number(readFileSync(out, 'utf8')) - t0;
    expect(startedAfter).toBeGreaterThanOrEqual(INPUT_HOLD_MAX_MS - 300);
    expect(startedAfter).toBeLessThan(3500);
    expect(info.remaining, info.detail).toBe(-1);
    expect(info.detail).toContain('시작 신호를 먼저 줬습니다');
  }, 60_000);
});
