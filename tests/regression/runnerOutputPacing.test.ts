/**
 * 자식 출력 읽기가 이벤트 루프를 붙잡지 않는다 — 실제 러너 (리드 결정 S5-42, 지난 검토 exec-security 프로브 zz-xs5f2-starve):
 * - 줄바꿈이 촘촘한 빠른 출력(큰 로그의 type·git log -p·출력 반복)에도 20ms 타이머의 가장 긴 틈이 500ms 안이다. 고치기 전에는 콘솔 코드 페이지 줄 나누기에서
 *   출력이 이어지는 동안(8초) 타이머가 거의 돌지 않았다(가장 긴 틈 8,022ms)
 * - 앱이 띄우듯 직접 띄운 실행(taskkill 방식·프로세스 그룹 — CLI 턴의 꼴)에도, 작업 개체 러너에도, UTF-8·콘솔 코드 페이지 줄 나누기에도, 표준 출력·오류 모두에
 * - 줄의 차례와 내용은 그대로다 — 번호 붙은 줄이 갈래마다 하나도 빠지거나 바뀌지 않고 차례대로 온다
 * 출력하는 자식은 벽시계로 스스로 끝나고(막히는 쓰기라 읽지 않으면 멈춘다), 시험이 끝나면 남은 것을 끝낸다
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessRunner } from '../../src/main/process/processRunner';
import type { ManagedProcess, ProcessRunner } from '../../src/main/process/types';

const win = process.platform === 'win32';
const runnerSource = join(process.cwd(), 'resources', 'jobrunner', 'JobRunner.cs');

let dir: string | null = null;
const runners: ProcessRunner[] = [];
const procs: ManagedProcess[] = [];
afterEach(async () => {
  // 시험이 실패해도 출력하는 자식을 남기지 않는다 — 러너가 가진 핸들로만 끝낸다. pid.txt로 끝내지 않는다: 그 자식이 이미 끝났으면 그 PID를 다른 프로세스가 쓸 수
  // 있다(Windows는 PID를 되쓴다 — 리드 결정 S5-52.4)
  await Promise.all(procs.splice(0).map((p) => p.terminate({ timeoutMs: 3000 }).catch(() => undefined)));
  for (const r of runners.splice(0)) r.dispose?.();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  dir = null;
});

/**
 * 출력하는 자식: <pid 파일> <먼저 기다릴 ms> <출력할 ms> <plain|numbered>. plain은 짧은 줄(19바이트) 1MiB 묶음을 표준 출력으로, numbered는 번호 붙은 줄 2만 개
 * 묶음을 표준 출력('o n')·오류('e n')에 번갈아. 끝나면 갈래마다 'flood end <줄 수>'
 */
const FLOODER = [
  "const fs = require('node:fs');",
  'const [pidFile, preWait, floodMs, kind] = process.argv.slice(2);',
  'fs.writeFileSync(pidFile, String(process.pid));',
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(preWait));',
  'const all = (fd, buf) => { let off = 0; while (off < buf.length) { try { off += fs.writeSync(fd, buf, off); } catch (e) { if (e.code !== "EAGAIN") throw e; } } };',
  'const end = Date.now() + Number(floodMs);',
  "if (kind === 'numbered') {",
  '  const seq = [0, 0];',
  '  for (let turn = 0; Date.now() < end; turn++) {',
  '    const s = turn % 2;',
  "    let text = '';",
  "    for (let i = 0; i < 20000; i++) text += (s === 0 ? 'o ' : 'e ') + seq[s]++ + '\\n';",
  '    all(s === 0 ? 1 : 2, Buffer.from(text));',
  '  }',
  "  all(1, Buffer.from('flood end ' + seq[0] + '\\n'));",
  "  all(2, Buffer.from('flood end ' + seq[1] + '\\n'));",
  "} else if (kind === 'estderr') {",
  // 표준 오류에만 쏟는다 — stderr 읽기도 한 차례에 정해진 만큼만 하는지 본다 (리드 결정 S5-42·S5-52.3)
  "  const b = Buffer.from('warn: build step ok 0123\\n'.repeat(40000));",
  '  let lines = 0;',
  '  while (Date.now() < end) { all(2, b); lines += 40000; }',
  "  all(2, Buffer.from('flood end ' + lines + '\\n'));",
  '} else {',
  '  const per = 55189;',
  "  const b = Buffer.from('build step ok 0123\\n'.repeat(per));",
  '  let lines = 0;',
  '  while (Date.now() < end) { all(1, b); lines += per; }',
  "  all(1, Buffer.from('flood end ' + lines + '\\n'));",
  '}',
].join('\n');

function setup(): { flood: string; pidFile: string; cwd: string } {
  dir = mkdtempSync(join(tmpdir(), 'wook-test-pacing-'));
  writeFileSync(join(dir, 'flood.cjs'), FLOODER);
  return { flood: join(dir, 'flood.cjs'), pidFile: join(dir, 'pid.txt'), cwd: dir };
}

/** 20ms 타이머의 가장 긴 틈 */
function gapWatch(): () => { worstGapMs: number; ticks: number } {
  let worst = 0;
  let ticks = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    ticks++;
  }, 20);
  return () => {
    clearInterval(iv);
    return { worstGapMs: Math.round(Math.max(worst, performance.now() - last)), ticks };
  };
}

async function runnerOf(mode: 'jobobject' | 'taskkill' | 'pgroup', dataDir: string): Promise<ProcessRunner> {
  // taskkill 방식은 작업 개체 도우미 없이 — CLI를 직접 띄우는 길만 본다(종료 확인은 이 시험이 보는 것이 아니다)
  const r = await createProcessRunner({ dataDir, forceMode: mode, runnerSource, log: () => undefined, ...(mode === 'taskkill' ? { jobHelper: null } : {}) });
  runners.push(r);
  return r;
}

describe('자식 출력 읽기가 이벤트 루프를 붙잡지 않는다 — 실제 러너 (리드 결정 S5-42)', () => {
  it('앱이 직접 띄운 실행(CLI 턴의 꼴 — UTF-8 줄 나누기, Windows는 taskkill 방식·그 밖은 프로세스 그룹): 약 10초 동안 줄바꿈이 촘촘한 출력에도 20ms 타이머의 가장 긴 틈이 500ms 안이고 줄이 하나도 빠지지 않는다', async () => {
    const { flood, pidFile, cwd } = setup();
    const runner = await runnerOf(win ? 'taskkill' : 'pgroup', join(cwd, 'data'));
    let lines = 0;
    let last = '';
    let wrong = 0;
    const proc = runner.start({ command: process.execPath, args: [flood, pidFile, '0', '10000', 'plain'], cwd, env: { ...process.env }, stdinText: null, label: '시험 출력' });
    procs.push(proc);
    const gap = gapWatch();
    proc.onStdoutLine((l) => {
      lines++;
      if (l !== 'build step ok 0123') wrong++;
      last = l;
    });
    await proc.exited;
    const g = gap();
    expect(g.worstGapMs, `가장 긴 틈 ${g.worstGapMs}ms, 타이머 ${g.ticks}번, ${lines}줄`).toBeLessThan(500);
    expect(last).toBe(`flood end ${lines - 1}`);
    expect(wrong).toBe(1); // 마지막 'flood end' 줄만 다르다
    expect(lines).toBeGreaterThan(1_000_000);
  }, 120_000);

  it.runIf(win)('표준 오류에만 쏟아지는 콘솔 코드 페이지 출력(taskkill 방식)에도 20ms 타이머의 가장 긴 틈이 500ms 안이고 줄이 하나도 빠지지 않는다 (프로브 zz-s5f3ti-reader-kills)', async () => {
    const { flood, pidFile, cwd } = setup();
    const runner = await runnerOf('taskkill', join(cwd, 'data'));
    let lines = 0;
    let last = '';
    const proc = runner.start({ command: process.execPath, args: [flood, pidFile, '0', '4000', 'estderr'], cwd, env: { ...process.env }, stdinText: null, label: '시험 오류 출력', consoleOutput: true });
    procs.push(proc);
    const gap = gapWatch();
    proc.onStderrLine((l) => {
      lines++;
      last = l;
    });
    await proc.exited;
    const g = gap();
    expect(g.worstGapMs, `가장 긴 틈 ${g.worstGapMs}ms, ${lines}줄`).toBeLessThan(500);
    expect(last).toBe(`flood end ${lines - 1}`);
    expect(lines).toBeGreaterThan(100_000);
  }, 120_000);

  const MODES: Array<['jobobject' | 'taskkill' | 'pgroup', boolean]> = win
    ? [
        ['jobobject', true],
        ['jobobject', false],
        ['taskkill', true],
      ]
    : [['pgroup', false]];
  for (const [mode, consoleOutput] of MODES) {
    it(`${mode}·${consoleOutput ? '콘솔 코드 페이지' : 'UTF-8'} 줄 나누기: 표준 출력·오류에 번갈아 쏟아지는 번호 줄이 갈래마다 차례대로 하나도 빠지지 않고 오고, 타이머의 가장 긴 틈은 500ms 안이다`, async () => {
      const { flood, pidFile, cwd } = setup();
      const runner = await runnerOf(mode, join(cwd, 'data'));
      const seen = { o: 0, e: 0 };
      const bad: string[] = [];
      const ends: Record<'o' | 'e', string | null> = { o: null, e: null };
      const take = (s: 'o' | 'e') => (l: string) => {
        if (ends[s] !== null) bad.push(`${s}: 끝 줄 뒤 ${l}`);
        else if (l.startsWith('flood end ')) ends[s] = l;
        else if (l !== `${s} ${seen[s]}`) bad.push(`${s}: ${seen[s]}번째에 ${l.slice(0, 40)}`);
        else seen[s]++;
      };
      const proc = runner.start({ command: process.execPath, args: [flood, pidFile, '0', '2500', 'numbered'], cwd, env: { ...process.env }, stdinText: null, label: '시험 번호 출력', consoleOutput });
      procs.push(proc);
      const gap = gapWatch();
      proc.onStdoutLine(take('o'));
      proc.onStderrLine(take('e'));
      await proc.exited;
      const g = gap();
      expect(bad.slice(0, 5)).toEqual([]);
      expect(ends).toEqual({ o: `flood end ${seen.o}`, e: `flood end ${seen.e}` });
      expect(Math.min(seen.o, seen.e)).toBeGreaterThan(100_000);
      expect(g.worstGapMs, `가장 긴 틈 ${g.worstGapMs}ms`).toBeLessThan(500);
    }, 120_000);
  }
});
