/**
 * 실제 systemd 사용자 관리자에 install-task의 유닛을 등록하고 지워 본다 (리드 결정 S10-6.2·S10-9 — SERVER_DESIGN 10.10). 그 사용자의 ~/.config/systemd/user를
 * 바꾸는 시험이라 기본 테스트에서는 건너뛴다. 이 PC의 WSL 배포판(주인의 것)에서는 돌리지 않는다 — CI의 버리는 러너(lane S10t의 linux.yml)에서만:
 *   WOOK_REAL_UNIT=1 WOOK_REAL_UNIT_HOST=<그 러너의 호스트 이름> npx vitest run tests/real/realUnit.test.ts   (npm run build:server 뒤)
 * - 임시 데이터 폴더(빈칸·%·$·따옴표·한글이 든 이름)의 유닛을 제품의 installUnit 그대로(실제 systemctl — daemon-reload·enable·show 다시 읽기) 등록하고, 따로 다시
 *   읽는다: systemctl --user cat이 쓴 글 그대로, show의 UnitFileState enabled·KillMode mixed·DropInPaths 없음·ActiveState inactive(띄우지 않았다), default.target.wants의
 *   링크, systemd-analyze --user verify 통과. 그 뒤 uninstallUnit 그대로 지우고 없어진 것(LoadState not-found, 파일·링크 없음)을 본다
 * - 서버는 띄우지 않는다(start를 부르지 않는다 — 부름을 적어 본다). 어느 길로 끝나든 afterAll이 disable·파일 지우기·daemon-reload로 남기지 않는다
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { chooseWebDir, realRunner, type TaskRunner } from '../../src/server/task';
import { defaultUnitDeps, installUnit, parseShow, readManagerEnv, uninstallUnit, unitDirOf, unitName, showArgs } from '../../src/server/unit';

const ENABLED = process.platform === 'linux' && process.env['WOOK_REAL_UNIT'] === '1' && !!process.env['WOOK_REAL_UNIT_HOST'] && process.env['WOOK_REAL_UNIT_HOST'] === hostname();

describe.skipIf(!ENABLED)('실제 systemd 사용자 유닛 (WOOK_REAL_UNIT=1 — 등록하고 지운다, 띄우지 않는다)', () => {
  const base = ENABLED ? mkdtempSync(join(tmpdir(), 'wook-real-unit-')) : '';
  const dataDir = ENABLED ? join(base, `욱채 데이터 100% $HOME "q" 'a'`) : '';
  const name = ENABLED ? unitName(dataDir) : '';
  const calls: string[][] = [];
  const run: TaskRunner = async (file, args) => {
    calls.push([file, ...args]);
    return realRunner(file, args);
  };
  let unitFile = '';

  afterAll(async () => {
    if (!ENABLED) return;
    // 어느 길로 끝나든 유닛과 임시 폴더를 남기지 않는다 — 치우기를 먼저 다 하고(finally), 그다음에 단언한다 (리드 결정 S10-13 TD-13)
    let after: Record<string, string> = {};
    try {
      await realRunner('systemctl', ['--user', 'disable', name]);
      if (unitFile && existsSync(unitFile)) unlinkSync(unitFile);
      await realRunner('systemctl', ['--user', 'daemon-reload']);
      after = parseShow((await realRunner('systemctl', showArgs(name))).stdout.toString('utf8'))[0] ?? {};
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    expect(after['LoadState']).toBe('not-found');
  }, 120_000);

  it('등록 → 다시 읽기(cat·show·링크·verify) → 지우기 — 리드 결정의 칸 그대로이고, 서버는 띄우지 않았다', async () => {
    // 시험은 저장소 폴더에서 돈다 — install-task가 쓰는 앱 루트와 같다. 진입점이 있어야 한다(npm run build:server)
    const appRoot = process.cwd();
    expect(existsSync(join(appRoot, 'out', 'server', 'index.mjs'))).toBe(true);
    const deps = defaultUnitDeps({ appRoot, nodePath: process.execPath, run, chooseWebDir });
    const managerEnv = await readManagerEnv(realRunner, process.env);
    expect(managerEnv).not.toBeNull();
    unitFile = posix.join(unitDirOf(managerEnv, deps.home), name);

    const r = await installUnit({ dataDir, flags: { port: 7399 }, dryRun: false }, deps);
    console.log(`[WOOK_REAL_UNIT] install-task: ${r.code}\n${r.out}${r.err}`);
    expect([r.code, r.err]).toEqual([0, '']);
    const cat = spawnSync('systemctl', ['--user', 'cat', name], { encoding: 'utf8' });
    expect(cat.status).toBe(0);
    // cat은 앞에 '# <경로>' 줄을 붙인다 — 그 뒤가 쓴 글 그대로
    expect(cat.stdout.split('\n').slice(1).join('\n').trimEnd()).toBe(readFileSync(unitFile, 'utf8').trimEnd());
    const show = parseShow((await realRunner('systemctl', showArgs(name))).stdout.toString('utf8'))[0] ?? {};
    console.log(`[WOOK_REAL_UNIT] show: ${JSON.stringify(show)}`);
    expect({ load: show['LoadState'], file: show['FragmentPath'], dropIns: show['DropInPaths'], state: show['UnitFileState'], kill: show['KillMode'], active: show['ActiveState'] }).toEqual({
      load: 'loaded',
      file: unitFile,
      dropIns: '',
      state: 'enabled',
      kill: 'mixed',
      active: 'inactive',
    });
    expect(existsSync(posix.join(posix.dirname(unitFile), 'default.target.wants', name))).toBe(true);
    const verify = spawnSync('systemd-analyze', ['--user', 'verify', unitFile], { encoding: 'utf8' });
    console.log(`[WOOK_REAL_UNIT] verify: ${verify.status} ${verify.stdout}${verify.stderr}`);
    expect(verify.status).toBe(0);

    const u = await uninstallUnit({ dataDir, dryRun: false }, deps);
    expect([u.code, u.err]).toEqual([0, '']);
    const gone = parseShow((await realRunner('systemctl', showArgs(name))).stdout.toString('utf8'))[0] ?? {};
    expect([gone['LoadState'], existsSync(unitFile), existsSync(posix.join(posix.dirname(unitFile), 'default.target.wants', name))]).toEqual(['not-found', false, false]);
    // 서버는 띄우지 않았다 — start·restart를 부르지 않았다
    expect(calls.filter((c) => c.includes('start') || c.includes('restart'))).toEqual([]);
  }, 120_000);
});
