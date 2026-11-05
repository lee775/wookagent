import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureJobRunner, findCsc, runnerPaths } from './compileRunner';

const isWin = process.platform === 'win32';
const runnerSource = fileURLToPath(new URL('../../../resources/jobrunner/JobRunner.cs', import.meta.url));

describe.skipIf(!isWin)('ensureJobRunner (csc.exe 컴파일)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-러너 컴파일 '));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function copySource(name: string): Promise<string> {
    const dir = join(root, name, '소스 폴더');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'JobRunner.cs');
    await copyFile(runnerSource, file);
    return file;
  }

  it('csc.exe를 Framework64에서 먼저 찾는다', () => {
    const found = findCsc();
    expect(found.path).not.toBeNull();
    expect(found.checked[0]).toContain('Framework64');
  });

  it('처음엔 컴파일, 같은 소스면 재사용, 소스가 바뀌면 다시 컴파일', async () => {
    const dataDir = join(root, '기본', '데이터');
    const src = await copySource('기본');
    const first = await ensureJobRunner({ dataDir, sourcePath: src });
    if (!first.ok) throw new Error(first.reason);
    expect(first.compiled).toBe(true);
    expect(first.exePath).toBe(runnerPaths(dataDir).exePath);
    console.log(`[러너 컴파일 ms] 새로 컴파일+확인 ${first.durationMs}`);

    const second = await ensureJobRunner({ dataDir, sourcePath: src });
    if (!second.ok) throw new Error(second.reason);
    expect(second.compiled).toBe(false);
    expect(second.sourceHash).toBe(first.sourceHash);
    console.log(`[러너 컴파일 ms] 재사용(확인만) ${second.durationMs}`);

    await appendFile(src, '\n// 내용이 바뀌면 해시가 바뀐다\n');
    const third = await ensureJobRunner({ dataDir, sourcePath: src });
    if (!third.ok) throw new Error(third.reason);
    expect(third.compiled).toBe(true);
    expect(third.sourceHash).not.toBe(first.sourceHash);
    expect((await readFile(runnerPaths(dataDir).hashPath, 'utf8')).trim()).toBe(third.sourceHash);
    // 빌드 임시 파일이 남지 않는다
    expect((await readdir(runnerPaths(dataDir).binDir)).sort()).toEqual(['WookJobRunner.exe', 'WookJobRunner.sha256']);
  });

  it('기존 러너가 실행 중이어도 새 러너로 바꿔 넣는다', async () => {
    const dataDir = join(root, '실행 중', '데이터');
    const src = await copySource('실행 중');
    const first = await ensureJobRunner({ dataDir, sourcePath: src });
    if (!first.ok) throw new Error(first.reason);
    // 실행 중인 exe는 지울 수 없다
    const running = spawn(first.exePath, ['--', process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { windowsHide: true });
    running.stdout.resume();
    running.stderr.resume();
    const closed = new Promise((r) => running.on('close', r));
    try {
      await new Promise((r) => running.stdout.once('data', r));
      await appendFile(src, '\n// 변경\n');
      const replaced = await ensureJobRunner({ dataDir, sourcePath: src });
      if (!replaced.ok) throw new Error(replaced.reason);
      expect(replaced.compiled).toBe(true);
      const names = await readdir(runnerPaths(dataDir).binDir);
      expect(names.some((n) => /^WookJobRunner\..+\.old\.exe$/.test(n))).toBe(true);
    } finally {
      running.stdin.end('KILL\n');
      await closed;
    }
    // 다음 컴파일 때 비켜 둔 옛 파일을 지운다
    await appendFile(src, '\n// 한 번 더\n');
    const again = await ensureJobRunner({ dataDir, sourcePath: src });
    if (!again.ok) throw new Error(again.reason);
    expect((await readdir(runnerPaths(dataDir).binDir)).sort()).toEqual(['WookJobRunner.exe', 'WookJobRunner.sha256']);
  });

  it('손상된 기존 러너는 확인에 실패하면 다시 컴파일한다', async () => {
    const dataDir = join(root, '손상', '데이터');
    const src = await copySource('손상');
    const first = await ensureJobRunner({ dataDir, sourcePath: src });
    if (!first.ok) throw new Error(first.reason);
    await writeFile(first.exePath, '손상된 파일');
    const repaired = await ensureJobRunner({ dataDir, sourcePath: src });
    if (!repaired.ok) throw new Error(repaired.reason);
    expect(repaired.compiled).toBe(true);
    expect(repaired.detail).toContain('기존 러너 확인 실패로 다시 컴파일');
  });

  it('프로토콜 버전이 다른 러너(옛 소스 — --verbatim-args 모름)는 확인에서 거부한다 (windows:F4)', async () => {
    const dir = join(root, '옛 프로토콜');
    await mkdir(dir, { recursive: true });
    const src = join(dir, 'JobRunner.cs');
    const current = await readFile(runnerSource, 'utf8');
    expect(current).toContain('private const int ProtocolVersion = 2;');
    await writeFile(src, current.replace('private const int ProtocolVersion = 2;', 'private const int ProtocolVersion = 1;'));
    const result = await ensureJobRunner({ dataDir: join(dir, '데이터'), sourcePath: src });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('러너 프로토콜 버전이 다릅니다 (1 ≠ 2)');
  });

  it('컴파일 오류는 csc 오류 줄을 담은 한국어 사유로 돌려준다', async () => {
    const dir = join(root, '오류');
    await mkdir(dir, { recursive: true });
    const src = join(dir, 'JobRunner.cs');
    await writeFile(src, 'class Broken { static void Main( }');
    const result = await ensureJobRunner({ dataDir: join(dir, '데이터'), sourcePath: src });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^러너 컴파일 실패 \(csc 종료 코드 1\): .*error CS\d+/);
  });

  it('소스·컴파일러가 없으면 실패 사유를 돌려준다', async () => {
    const noSource = await ensureJobRunner({ dataDir: join(root, '없음'), sourcePath: join(root, '없는 폴더', 'JobRunner.cs') });
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(noSource.reason).toContain('러너 소스를 읽지 못했습니다');

    const src = await copySource('컴파일러 없음');
    const noCsc = await ensureJobRunner({ dataDir: join(root, '컴파일러 없음', '데이터'), sourcePath: src, cscPath: join(root, 'csc.exe') });
    expect(noCsc.ok).toBe(false);
    if (!noCsc.ok) expect(noCsc.reason).toContain('C# 컴파일러(csc.exe');
  });
});
