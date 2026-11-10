/**
 * binaryPin (리드 결정 S5-21·S6-5, SERVER_DESIGN 8.4 '잡 러너와 도우미 실행 파일'): 앱 데이터 폴더의 실행 파일 두 개(작업 개체 러너·화면 도우미)는
 * 준비할 때 바이트 해시를 적어 두고 띄울 때마다 다시 견준다. 다르면 띄우지 않고 실행 환경 문제(binary_changed)로 알리며, 원본에서 한 번만 다시
 * 컴파일한다 — 그 뒤 또 다르면 다시 시작할 때까지 띄우지 않는다. .sha256은 두 줄(source·exe)이고, 실행 파일이 바뀌면 다음 준비가 다시 컴파일한다.
 * 화면 도우미 실행 파일은 이 시험에서 띄우지 않는다 (S6-15) — 실제 도우미 이음매는 시험 중 컴파일도 하지 않고, 해시 확인은 아무 파일로 본다.
 */
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkPinned, pinFile } from '../../src/main/process/pinnedFile';
import { DESKTOP_HELPER_TOOL, formatToolHashFile, parseToolHashFile, realDesktopGateOpen, toolLaunchRefusal, type CompiledToolOutcome } from '../../src/main/process/compiledTool';
import { ensureJobRunner, runnerPaths } from '../../src/main/process/compileRunner';
import { createProcessRunner, RUNNER_BINARY_CHANGED } from '../../src/main/process/processRunner';
import { unconfirmedEnvProblem, type ProcessRunner, type RunnerProblem } from '../../src/main/process/types';
import { createRealDesktopLauncher, DESKTOP_BINARY_CHANGED, probeRealDesktopHelper, realDesktopRefusal } from '../../src/main/desktop/realHelper';
import { bootOrch, type OrchEnv } from './orchHarness';

const isWin = process.platform === 'win32';
const runnerSource = fileURLToPath(new URL('../../resources/jobrunner/JobRunner.cs', import.meta.url));
const roots: string[] = [];

function tempDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `wook-test-pin-${name}-`));
  roots.push(d);
  return d;
}

// fs.rmSync는 Node 24.13(Windows)에서 한글 경로면 프로세스가 죽는다 (0xC0000409) — 비동기 rm·unlinkSync를 쓴다
afterAll(async () => {
  for (const d of roots) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function waitFor(cond: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`기다리다 시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('pinnedFile: 띄울 때마다 바이트 해시를 다시 본다', () => {
  it('같으면 ok, 한 바이트라도 다르면 그 까닭과 지금 해시, 없으면 읽지 못했다고', () => {
    const dir = tempDir('file');
    const file = join(dir, 'tool.exe');
    writeFileSync(file, 'MZ 실행 파일 흉내');
    const pin = pinFile(file);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checkPinned(pin)).toEqual({ ok: true });
    appendFileSync(file, '\0');
    const changed = checkPinned(pin);
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.reason).toContain('실행 파일의 해시가 준비할 때와 다릅니다');
      expect(changed.actual).toMatch(/^[0-9a-f]{64}$/);
      expect(changed.actual).not.toBe(pin.sha256);
    }
    unlinkSync(file);
    expect(checkPinned(pin)).toMatchObject({ ok: false, actual: null, reason: '실행 파일을 읽지 못했습니다 (ENOENT)' });
  });

  it('종료를 확인하지 못한 실행의 실행 환경 까닭은 작업 개체 도우미를 쓸 수 없을 때만 — 러너 파일이 바뀐 것은 그 까닭이 아니다', () => {
    expect(unconfirmedEnvProblem({ problem: () => ({ kind: 'helper_unavailable', text: '제한 언어 모드' }) })).toBe('제한 언어 모드');
    expect(unconfirmedEnvProblem({ problem: () => ({ kind: 'binary_changed', text: '러너 파일이 다름' }) })).toBeNull();
    expect(unconfirmedEnvProblem({ problem: () => null })).toBeNull();
    expect(unconfirmedEnvProblem({})).toBeNull();
  });

  it('.sha256은 두 줄(source·exe) — 옛 한 줄(원본 해시만)은 실행 파일 해시가 없는 것으로 읽는다', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(formatToolHashFile(a, b)).toBe(`source ${a}\nexe ${b}\n`);
    expect(parseToolHashFile(formatToolHashFile(a, b))).toEqual({ source: a, exe: b });
    expect(parseToolHashFile(`${a}\n`)).toEqual({ source: a, exe: null });
    expect(parseToolHashFile(`source ${a}\n`)).toBeNull();
    expect(parseToolHashFile('아무 글')).toBeNull();
  });
});

describe('실제 화면 도우미 이음매: 시험 중에는 띄우지도 컴파일하지도 않는다 (S6-13·S6-15)', () => {
  it('시험 문이 닫혀 있으면 prepare는 컴파일하지 않고 launch·확인은 거부한다', async () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(realDesktopGateOpen()).toBe(false);
    const dataDir = tempDir('real');
    const launcher = createRealDesktopLauncher({ dataDir, log: () => undefined });
    await launcher.prepare?.();
    const spec = launcher.launch();
    expect(spec).toEqual({ refuse: expect.stringContaining(isWin ? '시험 중에는 실제 화면 도우미를 띄우지 않습니다' : 'Windows 서버에서만') });
    expect(existsSync(join(dataDir, 'bin'))).toBe(false);
    expect(await probeRealDesktopHelper({ launcher })).toMatchObject({ ok: false }); // S6F1b: 사전 점검은 이음매의 준비를 쓴다 (S6-21 H3)
    expect(existsSync(join(dataDir, 'bin'))).toBe(false);
    if (isWin) expect(toolLaunchRefusal(DESKTOP_HELPER_TOOL)).toContain('시험 중에는');
  });

  it('문은 Windows + WOOK_REAL_DESKTOP=1 + 이 PC 이름일 때만 열린다 (값을 넘겨 보기만 — 환경은 바꾸지 않는다)', () => {
    expect(realDesktopGateOpen({ WOOK_REAL_DESKTOP: '1' })).toBe(false);
    expect(realDesktopGateOpen({ WOOK_REAL_DESKTOP: '1', WOOK_REAL_DESKTOP_HOST: `${hostname()}-다른 PC` })).toBe(false);
    expect(realDesktopGateOpen({ WOOK_REAL_DESKTOP: 'true', WOOK_REAL_DESKTOP_HOST: hostname() })).toBe(false);
    expect(realDesktopGateOpen({ WOOK_REAL_DESKTOP: '1', WOOK_REAL_DESKTOP_HOST: hostname() })).toBe(isWin);
    expect(realDesktopRefusal({ VITEST: '1' })).not.toBeNull();
  });

  it.skipIf(!isWin)('해시가 다르면 띄우지 않고 알린 뒤 한 번 다시 준비한다 — 또 다르면 다시 시작할 때까지 거부 (명세는 띄우지 않는다)', async () => {
    const dir = tempDir('realpin');
    const file = join(dir, 'not-a-helper.bin');
    writeFileSync(file, '도우미 실행 파일이 아니다');
    const ensures: boolean[] = [];
    const outcome = (): CompiledToolOutcome => ({
      ok: true,
      exePath: file,
      compiled: false,
      sourcePath: file,
      sourceHash: '0'.repeat(64),
      exeSha256: pinFile(file).sha256,
      pin: pinFile(file),
      cscPath: null,
      detail: '시험',
      durationMs: 0,
    });
    const problems: RunnerProblem[] = [];
    // 문을 연 환경 값은 이 이음매의 판정에만 넘긴다 (process.env는 그대로) — 띄우는 일은 없다
    const launcher = createRealDesktopLauncher({
      dataDir: dir,
      log: () => undefined,
      env: { WOOK_REAL_DESKTOP: '1', WOOK_REAL_DESKTOP_HOST: hostname(), SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WOOK_MCP_TOKEN: '토큰은 넘기지 않는다' },
      onProblem: (p) => problems.push(p),
      ensure: async (force) => {
        ensures.push(force);
        return outcome();
      },
    });
    await launcher.prepare?.();
    const first = launcher.launch();
    expect(first).toEqual({ file, args: [], env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } });
    // 바꿔치기 → 거부 + 알림 + 다시 준비 (한 번)
    writeFileSync(file, '바꿔 넣은 파일');
    const refused = launcher.launch();
    expect(refused).toEqual({ refuse: expect.stringContaining(`${DESKTOP_BINARY_CHANGED} (실행 파일의 해시가 준비할 때와 다릅니다`) });
    expect(problems).toEqual([{ kind: 'binary_changed', text: expect.stringContaining('원본에서 한 번 다시 컴파일합니다') }]);
    await waitFor(() => ensures.length === 2, '다시 준비');
    expect(ensures).toEqual([false, true]);
    await new Promise((r) => setTimeout(r, 20));
    expect(launcher.launch()).toMatchObject({ file });
    // 그 한 번을 썼다 — 또 바뀌면 다시 시작할 때까지 거부 (원래대로 돌려놔도)
    const before = readFileSync(file);
    writeFileSync(file, '또 바꾼 파일');
    expect(launcher.launch()).toEqual({ refuse: expect.stringContaining('다시 시작할 때까지 화면 도우미를 띄우지 않습니다') });
    writeFileSync(file, before);
    expect(launcher.launch()).toEqual({ refuse: expect.stringContaining('다시 시작할 때까지') });
    expect(ensures).toEqual([false, true]);
    expect(problems.at(-1)).toMatchObject({ kind: 'binary_changed', text: expect.stringContaining('한 번 다시 컴파일한 뒤에도 또 달라') });
  });

  // S6F1b (리드 결정 S6-21 H3): 사전 점검이 따로 준비하면 첫 시작에 두 준비가 함께 컴파일해 한쪽의 해시가 덮인 파일의 것이 된다
  it.skipIf(!isWin)('사전 점검은 띄우는 이음매가 준비한 실행 파일을 쓴다 — 따로 준비하지 않고, 해시가 다르면 확인하지 않은 채 까닭만 준다 (알림·다시 컴파일은 띄우기의 몫)', async () => {
    const dir = tempDir('realprobe');
    const file = join(dir, 'not-a-helper.bin');
    writeFileSync(file, '도우미 실행 파일이 아니다');
    const ensures: boolean[] = [];
    const problems: RunnerProblem[] = [];
    // 문을 연 환경 값은 이 이음매의 판정에만 넘긴다 (process.env는 그대로 — 아래 확인 실행은 시험 중이라 실행 직전에 거부된다)
    const env = { WOOK_REAL_DESKTOP: '1', WOOK_REAL_DESKTOP_HOST: hostname(), SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };
    const launcher = createRealDesktopLauncher({
      dataDir: dir,
      log: () => undefined,
      env,
      onProblem: (p) => problems.push(p),
      ensure: async (force) => {
        ensures.push(force);
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true, exePath: file, compiled: true, sourcePath: file, sourceHash: '0'.repeat(64), exeSha256: pinFile(file).sha256, pin: pinFile(file), cscPath: null, detail: '시험', durationMs: 0 };
      },
    });
    // 사전 점검이 띄우기의 준비보다 먼저 와도 그 준비 하나를 함께 기다린다
    const [first] = await Promise.all([probeRealDesktopHelper({ launcher, env }), launcher.prepare?.()]);
    // 준비한 그 파일로 확인 실행까지 갔다 — 시험 중이라 띄우기 직전에 거부된다 (이 PC에서는 띄우지 않는다)
    expect(first).toEqual({ ok: false, reason: expect.stringContaining('시험 중에는 실제 화면 도우미를 띄우지 않습니다') });
    expect(ensures).toEqual([false]);
    writeFileSync(file, '바꿔 넣은 파일');
    expect(await probeRealDesktopHelper({ launcher, env })).toEqual({ ok: false, reason: expect.stringContaining(`${DESKTOP_BINARY_CHANGED} (실행 파일의 해시가 준비할 때와 다릅니다`) });
    // 사전 점검은 한 번뿐인 다시 컴파일을 쓰지 않고 알리지도 않는다
    expect([ensures, problems]).toEqual([[false], []]);
  });
});

describe.skipIf(!isWin)('작업 개체 러너: 띄울 때마다 해시 (S5-21을 닫음)', () => {
  let dataDir: string;
  let runner: ProcessRunner;
  const problems: RunnerProblem[] = [];
  const logs: string[] = [];

  beforeAll(async () => {
    dataDir = join(tempDir('runner'), '앱 데이터');
    runner = await createProcessRunner({ dataDir, forceMode: 'jobobject', runnerSource, log: (_l, m) => logs.push(m) });
    runner.onProblem?.((p) => problems.push(p));
  }, 120_000);

  function runNode(): Promise<{ code: number | null; stderr: string[] }> {
    const p = runner.start({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dataDir, env: { ...process.env }, stdinText: null, label: '시험' });
    const stderr: string[] = [];
    p.onStderrLine((l) => stderr.push(l));
    return p.exited.then((x) => ({ code: x.code, stderr }));
  }

  it('같은 파일이면 띄우고, 바뀌면 거부·알림·한 번 다시 컴파일 — 또 바뀌면 다시 시작할 때까지 거부', async () => {
    expect(runner.mode).toBe('jobobject');
    expect(await runNode()).toMatchObject({ code: 0 });
    expect(runner.problem?.()).toBeNull();
    const exe = runnerPaths(dataDir).exePath;
    // 바꿔치기 (한 바이트 덧붙임 — 그래도 실행은 되는 파일)
    appendFileSync(exe, Buffer.from([0]));
    const refused = await runNode();
    expect(refused.code).toBe(-1);
    expect(refused.stderr.join('\n')).toContain(`${RUNNER_BINARY_CHANGED} (실행 파일의 해시가 준비할 때와 다릅니다`);
    expect(problems).toEqual([{ kind: 'binary_changed', text: expect.stringContaining('원본에서 한 번 다시 컴파일합니다') }]);
    expect(runner.detail).toContain('지금은 러너로 아무것도 띄우지 않습니다');
    // 원본에서 다시 컴파일하면 문제가 풀리고 다시 띄운다
    await waitFor(() => runner.problem?.() === null, '러너 다시 컴파일');
    expect(await runNode()).toMatchObject({ code: 0 });
    // 한 번을 썼다 — 또 바뀌면 거부하고, 원래대로 돌려놔도 다시 시작할 때까지 거부
    copyFileSync(exe, `${exe}.keep`);
    appendFileSync(exe, Buffer.from([1]));
    expect((await runNode()).stderr.join('\n')).toContain(RUNNER_BINARY_CHANGED);
    expect(runner.problem?.()).toMatchObject({ kind: 'binary_changed', text: expect.stringContaining('한 번 다시 컴파일한 뒤에도 또 달라') });
    copyFileSync(`${exe}.keep`, exe);
    unlinkSync(`${exe}.keep`);
    const still = await runNode();
    expect(still.code).toBe(-1);
    expect(still.stderr.join('\n')).toContain('이 러너로는 띄우지 않았습니다');
    expect(problems.map((p) => p.kind)).toEqual(['binary_changed', 'binary_changed']);
    expect(logs.some((m) => m.includes('작업 개체 러너를 원본에서 다시 컴파일해 다시 씁니다'))).toBe(true);
  }, 120_000);

  it('다음 준비: 실행 파일이 적어 둔 해시와 다르면 다시 컴파일한다 (시작 때 재사용 구멍을 닫음) — 옛 한 줄 해시 파일도', async () => {
    const dir = join(tempDir('reuse'), '데이터');
    const first = await ensureJobRunner({ dataDir: dir, sourcePath: runnerSource });
    if (!first.ok) throw new Error(first.reason);
    const { exePath, hashPath } = runnerPaths(dir);
    expect(parseToolHashFile(readFileSync(hashPath, 'utf8'))).toEqual({ source: first.sourceHash, exe: first.exeSha256 });
    expect(first.pin).toEqual({ path: exePath, sha256: first.exeSha256 });
    // 같은 파일이면 재사용
    const reuse = await ensureJobRunner({ dataDir: dir, sourcePath: runnerSource });
    expect(reuse).toMatchObject({ ok: true, compiled: false });
    // 바꿔 넣은 실행 파일(확인 --probe에는 답하는 진짜 러너 + 덧붙인 바이트) → 다시 컴파일
    appendFileSync(exePath, Buffer.from([0]));
    const swapped = await ensureJobRunner({ dataDir: dir, sourcePath: runnerSource });
    expect(swapped).toMatchObject({ ok: true, compiled: true, detail: expect.stringContaining('실행 파일이 적어 둔 해시와 달라 다시 컴파일') });
    // 옛 한 줄 형식 (원본 해시만) → 한 번 다시 컴파일
    writeFileSync(hashPath, `${first.sourceHash}\n`);
    const legacy = await ensureJobRunner({ dataDir: dir, sourcePath: runnerSource });
    expect(legacy).toMatchObject({ ok: true, compiled: true, detail: expect.stringContaining('옛 해시 파일에 실행 파일 해시가 없어 다시 컴파일') });
  }, 120_000);
});

describe('실행 환경 문제의 종류마다 맞는 글 (orchestrator 알림 · system.prereqs.jobRunner)', () => {
  let env: OrchEnv | null = null;
  afterEach(async () => {
    await env?.close();
    env = null;
  });

  it('binary_changed: 러너 파일이 바뀌었다는 긴급 알림, 설정 화면의 실행 도구 줄은 쓸 수 없음 — helper_unavailable은 예전 글 그대로', async () => {
    let current: RunnerProblem | null = null;
    const listeners = new Set<(p: RunnerProblem) => void>();
    env = await bootOrch({
      runnerPatch: {
        problem: () => current,
        onProblem: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    });
    const pre0 = await env.invoke('system.prereqs');
    expect(pre0.jobRunner.ok).toBe(true);
    current = { kind: 'binary_changed', text: `${RUNNER_BINARY_CHANGED} (시험)` };
    for (const cb of listeners) cb(current);
    const notice = env.ctx.store.notifications.list().filter((n) => n.key === 'runner-problem');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ level: 'urgent', title: '작업 개체 러너 파일이 바뀜' });
    expect(notice[0]!.body).toContain(`${RUNNER_BINARY_CHANGED} (시험). 바뀐 파일로는 CLI·자동 검사·서버 명령을 띄우지 않습니다`);
    expect(notice[0]!.body).toContain('앱 데이터 폴더(bin)');
    expect(notice[0]!.body).not.toContain('작업 개체 도우미를 쓸 수 없습니다');
    const pre = await env.invoke('system.prereqs');
    expect(pre.jobRunner.ok).toBe(false);
    // 도우미를 쓸 수 없음은 예전 글 (같은 key를 갱신)
    current = { kind: 'helper_unavailable', text: '제한 언어 모드 (시험)' };
    for (const cb of listeners) cb(current);
    const again = env.ctx.store.notifications.list().filter((n) => n.key === 'runner-problem');
    expect(again.at(-1)).toMatchObject({ title: '하위 프로세스 종료를 확인할 수 없음' });
    expect(again.at(-1)!.body.startsWith('작업 개체 도우미를 쓸 수 없습니다: 제한 언어 모드 (시험). ')).toBe(true);
    const activity = env.ctx.store.activity.search({ limit: 50 }).map((a) => a.text);
    expect(activity).toContain(`실행 환경 문제: 작업 개체 러너 파일이 바뀜 — ${RUNNER_BINARY_CHANGED} (시험)`);
    expect(activity).toContain('실행 환경 문제: 작업 개체 도우미를 쓸 수 없음 — 제한 언어 모드 (시험)');
  });
});

