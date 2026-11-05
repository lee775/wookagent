/**
 * 시험 실행마다 임시 폴더 하나 (리드 결정 S4-24, tests/setup/runTemp.ts — 주 설정의 globalSetup):
 * - 시험 일꾼과 그 일꾼이 띄운 프로세스의 임시 폴더는 이 실행의 폴더(wook-vitest-<vitest 프로세스 pid>-<난수>)다 — TEMP·TMP·TMPDIR 모두
 * - 끝나면 그 폴더를 지우고 환경 변수를 되돌린다. 안에 바깥 폴더로 가는 연결 지점이 있어도 따라가지 않는다
 * - 시작할 때 지우는 것은 이 이름 꼴의 진짜 폴더 가운데 pid가 살아 있지 않고 6시간 넘게 바뀌지 않은 것뿐이다 — 동시에 도는 다른 실행의 폴더, 그 밖의
 *   이름(예전 wook-test-*), 파일·연결 지점은 건드리지 않는다
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setup, { openRunDir, pidAlive, removeTree, RUN_DIR_RE, RUN_DIR_STALE_MS, TEMP_VARS } from '../setup/runTemp';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) removeTree(d);
});

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-runtemp-'));
  cleanup.push(d);
  return d;
}

/** 바깥 폴더(지우면 안 되는 파일 하나)와 그리로 가는 연결 지점 — Windows는 junction, POSIX는 심볼릭 링크 */
function linkOut(root: string, at: string): string {
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), '지우면 안 되는 파일');
  symlinkSync(outside, at, 'junction');
  return join(outside, 'keep.txt');
}

const ageBy = (path: string, ms: number) => {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
};

describe('시험 실행의 임시 폴더 (runTemp)', () => {
  it('시험 일꾼과 그 자식 프로세스의 임시 폴더는 이 실행의 폴더다 — TEMP·TMP·TMPDIR 모두', () => {
    const dir = tmpdir();
    const m = RUN_DIR_RE.exec(basename(dir));
    expect(m, `임시 폴더 ${basename(dir)}가 실행 폴더 이름 꼴이 아닙니다`).not.toBeNull();
    // 이름의 pid는 vitest 본 프로세스 — 일꾼(forks)의 부모
    expect(Number(m![1])).toBe(process.ppid);
    expect(existsSync(dir)).toBe(true);
    expect(TEMP_VARS.map((k) => process.env[k])).toEqual(TEMP_VARS.map(() => dir));
    const child = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:os').tmpdir())"], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(dir);
  });

  it('setup은 실행 폴더를 만들어 환경 변수를 돌리고, teardown은 지우고 되돌린다 — 안의 연결 지점은 따라가지 않는다', () => {
    const root = tmpdir();
    const before = TEMP_VARS.map((k) => process.env[k]);
    const teardown = setup();
    let dir = '';
    let kept = '';
    try {
      dir = process.env.TEMP!;
      expect(basename(dir)).toMatch(RUN_DIR_RE);
      expect(dirname(dir)).toBe(root);
      expect(TEMP_VARS.map((k) => process.env[k])).toEqual(TEMP_VARS.map(() => dir));
      expect(tmpdir()).toBe(dir);
      // 시험이 남긴 것처럼: 폴더·파일, 그리고 바깥으로 가는 연결 지점
      mkdirSync(join(dir, 'wook-test-left', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'wook-test-left', 'deep', 'data.db'), 'x');
      const outRoot = sandboxIn(root);
      kept = linkOut(outRoot, join(dir, 'wook-test-left', 'link'));
    } finally {
      teardown();
    }
    expect(existsSync(dir)).toBe(false);
    expect(TEMP_VARS.map((k) => process.env[k])).toEqual(before);
    expect(existsSync(kept)).toBe(true);
  });

  it('시작할 때 지우는 것은 pid가 살아 있지 않고 6시간 넘게 바뀌지 않은 실행 폴더뿐이다 — 다른 실행·다른 이름·파일·연결 지점은 그대로', () => {
    const root = sandbox();
    const OLD = RUN_DIR_STALE_MS + 3_600_000;
    const make = (name: string, ageMs: number) => {
      const p = join(root, name);
      mkdirSync(p);
      writeFileSync(join(p, 'f.txt'), name);
      ageBy(p, ageMs);
      return p;
    };
    const dead = 111_111;
    const live = 222_222;
    const staleDead = make(`wook-vitest-${dead}-aaaaaa`, OLD);
    const youngDead = make(`wook-vitest-${dead}-bbbbbb`, 5 * 3_600_000);
    const otherRun = make(`wook-vitest-${live}-cccccc`, OLD);
    const ownPid = make(`wook-vitest-${process.pid}-dddddd`, OLD);
    const oldTests = make('wook-test-orch-data-zzzzzz', OLD);
    const badName = make(`wook-vitest-${dead}-toolongname`, OLD);
    const file = join(root, `wook-vitest-${dead}-ffffff`);
    writeFileSync(file, '파일');
    ageBy(file, OLD);
    // 이름 꼴이 맞는 연결 지점 — 따라가면 6시간 넘은 폴더로 보이게 그 바깥 폴더를 낡게 둔다
    const link = join(root, `wook-vitest-${dead}-gggggg`);
    const kept = linkOut(join(root, 'elsewhere'), link);
    ageBy(link, OLD);

    const run = openRunDir(root, { alive: (pid) => pid === live });
    expect(run.removed).toEqual([staleDead]);
    expect(run.left).toEqual([]);
    expect(existsSync(staleDead)).toBe(false);
    for (const p of [youngDead, otherRun, ownPid, oldTests, badName, file, link, kept]) expect(existsSync(p), p).toBe(true);
    // 이 실행의 폴더: 이 프로세스의 pid와 난수, 비어 있다
    expect(dirname(run.dir)).toBe(root);
    expect(RUN_DIR_RE.exec(basename(run.dir))?.[1]).toBe(String(process.pid));
    expect(existsSync(run.dir)).toBe(true);
    // 같은 때 두 실행이 열어도 서로 다른 폴더다
    const second = openRunDir(root, { alive: (pid) => pid === live || pid === process.pid });
    expect(second.dir).not.toBe(run.dir);
    expect(existsSync(run.dir)).toBe(true);
  });

  it('pid가 살아 있는지 — 이 프로세스는 살아 있고, 없는 pid는 아니다', () => {
    expect(pidAlive(process.pid)).toBe(true);
    // Windows의 pid는 4의 배수라 홀수는 없고, Linux의 pid 상한(2^22)보다 크다
    expect(pidAlive(2_147_483_647)).toBe(false);
  });
});

function sandboxIn(root: string): string {
  const d = mkdtempSync(join(root, 'wook-test-runtemp-out-'));
  cleanup.push(d);
  return d;
}
