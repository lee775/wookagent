/**
 * Linux의 systemd 사용자 유닛 (리드 결정 S10-6.2, src/server/unit.ts): `wook-server install-task | uninstall-task`가 Linux에서 하는 일.
 * systemctl은 주입한 가짜 사용자 관리자로만 부른다 — 이 시험은 어디에도 유닛을 등록하지 않는다(S10-9: WSL 배포판은 주인의 것). 유닛 파일은 시험의 임시 폴더에만 쓴다.
 * - 유닛 글: 리드 결정의 칸 그대로(KillMode=mixed, TimeoutStopSec=45, Restart=on-failure, RestartSec=60, StartLimitBurst=4/600, UMask=0077, 설치한 셸의 PATH,
 *   절대 경로의 --data-dir), systemd 감싸기(`\ " % $`) — 빈칸·%·$·따옴표·역슬래시·한글이 든 값이 다시 읽으면 같은 argv·PATH로 돌아온다
 * - 지킴: root면 1, 사용자 버스(XDG_RUNTIME_DIR·show-environment)가 없으면 1, 제어 문자·앱 폴더의 앞뒤 빈칸·끝 역슬래시면 1 — 모두 아무것도 쓰지 않고 바꾸지 않는다
 * - --dry-run은 show-environment(읽기)만 부르고 파일을 쓰지 않는다
 * - 등록: 파일(0600 — Linux에서) → daemon-reload → enable → show 다시 읽기, start는 부르지 않는다. 다시 읽은 것이 다르면(덧붙인 설정·KillMode·파일 글·ExecStart) 1.
 *   linger가 꺼져 있으면 sudo loginctl enable-linger 줄을 말하고(부르지는 않는다), 켜져 있으면 말하지 않는다
 * - 지우기: 없으면 0(부름은 읽기뿐), 있으면 disable → 파일 지움 → daemon-reload → 다시 읽기. 읽지 못하면 1(지우지 않는다), 다른 자리의 같은 이름이면 1(지우지 않는다)
 * - 유닛 이름은 데이터 폴더마다 하나 — Linux는 대소문자를 가린다 (Windows 작업 이름은 그대로 대소문자를 가리지 않는다)
 * 실제 systemd가 이 글을 같은 값으로 읽는지는 Linux에서 systemd-analyze verify와 systemd --user --test(시험 모드 — 아무 관리자에도 올리지 않는다)로 본다.
 * 실제 등록 → enable → 다시 읽기 → 지우기는 tests/real/realUnit.test.ts(CI의 버리는 러너에서만)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataDirHash } from '../../src/server/admin';
import { jsonLine, parseCli, runLocal } from '../../src/server/cli';
import { chooseWebDir, taskName, type ExecResult, type TaskCommandDeps } from '../../src/server/task';
import {
  compareUnit,
  envAssignments,
  execWords,
  installUnit,
  NO_USER_BUS,
  parseShow,
  parseUnitFile,
  splitSystemdWords,
  systemdEnvAssignment,
  systemdExecWord,
  uninstallUnit,
  unitArgv,
  unitDirOf,
  unitName,
  unitDataPath,
  unitText,
  UNIT_ROOT_REFUSAL,
  type UnitCommandDeps,
  type UnitInputs,
} from '../../src/server/unit';
import { removeDir } from './helpers';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});
const temp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-unit-${tag}-`));
  dirs.push(d);
  return d;
};

/** 셸·systemd가 바꾸는 글자를 모두 담은 값들 */
const NASTY = ['/srv/욱채 서버/데이터 % $HOME ${PATH} "따옴표" \'작은\' \\역슬래시\\', '/opt/a b/c', '/x/100%/$$', '/한글/폴더', '/q"/p\'/b\\', '/end\\x'];

const SAMPLE: UnitInputs = {
  dataDir: '/home/u/.config/wookagent',
  nodePath: '/usr/bin/node',
  entry: '/home/u/wookagent/out/server/index.mjs',
  appRoot: '/home/u/wookagent',
  webDir: '/home/u/wookagent/out/web',
  port: 7400,
  path: '/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin',
};

describe('유닛 글 (리드 결정 S10-6.2)', () => {
  it('정한 칸 그대로 — ExecStart는 낱말마다 큰따옴표, 서버는 절대 경로의 --data-dir로, start 없이 default.target에 건다', () => {
    expect(unitText(SAMPLE)).toBe(
      [
        '# wook-server install-task가 쓴 파일입니다 — 바꾸려면 install-task를 다시 하세요 (손으로 고친 것은 check가 알립니다)',
        '[Unit]',
        'Description=욱채 서버 (/home/u/.config/wookagent)',
        '# 사용자 유닛은 시스템의 network-online.target을 기다릴 수 없습니다 — 서버는 이 PC 안(루프백)만 엽니다',
        'StartLimitIntervalSec=600',
        'StartLimitBurst=4',
        '',
        '[Service]',
        'Type=exec',
        'WorkingDirectory=/home/u/wookagent',
        'ExecStart="/usr/bin/node" "/home/u/wookagent/out/server/index.mjs" "serve" "--data-dir" "/home/u/.config/wookagent" "--web-dir" "/home/u/wookagent/out/web" "--port" "7400"',
        '# install-task를 실행한 셸의 PATH — 사용자 유닛의 기본 PATH에는 ~/.local/bin·nvm이 없습니다 (claude·codex·git·node)',
        'Environment="PATH=/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin"',
        'UMask=0077',
        '# 끌 때 서버에만 SIGTERM — 서버가 턴을 차례로 끝낸 뒤, 남은 프로세스는 systemd가 SIGKILL로 끝냅니다',
        'KillMode=mixed',
        'TimeoutStopSec=45',
        'Restart=on-failure',
        'RestartSec=60',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  it('감싸기: ExecStart는 \\ " % $를, Environment=는 \\ " %를 바꾼다 — 다시 읽으면(systemd 규칙) 같은 값이다', () => {
    expect(systemdExecWord('a"b\\c%d$e 한글')).toBe('"a\\"b\\\\c%%d$$e 한글"');
    expect(systemdEnvAssignment('PATH', '/a b:$X:%h:"q"\\')).toBe('"PATH=/a b:$X:%%h:\\"q\\"\\\\"');
    for (const v of NASTY) {
      const i: UnitInputs = { ...SAMPLE, dataDir: v, webDir: `${v}/web`, configPath: `${v}/server.json`, workspaceRoot: v, path: `${v}:/usr/bin` };
      const file = parseUnitFile(unitText(i));
      expect(file.service['ExecStart']).toHaveLength(1);
      expect(execWords(file.service['ExecStart']![0]!)?.argv).toEqual([i.nodePath, ...unitArgv(i)]);
      expect(envAssignments(file.service['Environment']!)).toEqual({ PATH: i.path });
    }
  });

  it('systemd 낱말 나누기: 따옴표 둘, C 이스케이프, 닫지 않은 따옴표는 null', () => {
    expect(splitSystemdWords(`a "b c" 'd "e' f\\ g "\\x41\\t"`)).toEqual(['a', 'b c', 'd "e', 'f g', 'A\t']);
    expect(splitSystemdWords('"open')).toBeNull();
  });
});

/** 가짜 사용자 관리자 — 유닛 파일은 메모리(files)에 있고, show는 그것을 이 파일의 parseUnitFile·execWords로 읽어 답한다(실제 systemd의 읽기는 아래 Linux 시험이
 * 본다). 부름을 모두 적는다 */
interface ManagerOptions {
  env?: Record<string, string>;
  showEnvCode?: number;
  fail?: Partial<Record<'daemon-reload' | 'enable' | 'disable' | 'show', number>>;
  dropIn?: boolean;
  killMode?: string;
  fragmentElsewhere?: string;
}
const HOME = '/home/wook';
function fakeManager(files: Map<string, string>, o: ManagerOptions = {}) {
  const calls: string[][] = [];
  let enabled = false;
  const unitDir = (): string => posix.join(o.env?.['XDG_CONFIG_HOME'] ?? posix.join(HOME, '.config'), 'systemd', 'user');
  const ok = (text = ''): ExecResult => ({ code: 0, stdout: Buffer.from(text, 'utf8'), timedOut: false, error: null });
  const no = (code: number): ExecResult => ({ code, stdout: Buffer.alloc(0), timedOut: false, error: null });
  const run = async (file: string, args: readonly string[]): Promise<ExecResult> => {
    calls.push([file, ...args]);
    if (file !== 'systemctl' || args[0] !== '--user') return no(97);
    const verb = args[1]!;
    if (verb === 'show-environment') {
      if (o.showEnvCode) return no(o.showEnvCode);
      return ok(Object.entries({ HOME, PATH: '/usr/bin:/bin', ...(o.env ?? {}) }).map(([k, v]) => `${k}=${v}\n`).join(''));
    }
    if (o.fail?.[verb as 'show']) return no(o.fail[verb as 'show']!);
    if (verb === 'daemon-reload') return ok();
    if (verb === 'enable' || verb === 'disable') {
      enabled = verb === 'enable';
      return ok();
    }
    if (verb === 'show') {
      const path = posix.join(unitDir(), args[2]!);
      if (o.fragmentElsewhere) return ok(`LoadState=loaded\nFragmentPath=${o.fragmentElsewhere}\nUnitFileState=enabled\nDropInPaths=\nKillMode=mixed\n`);
      const text = files.get(path);
      if (text === undefined) return ok('WorkingDirectory=\nKillMode=control-group\nLoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\nUnitFileState=\n');
      const u = parseUnitFile(text);
      const argv = execWords(u.service['ExecStart']![0]!)!.argv;
      return ok(
        [
          `ExecStart={ path=${argv[0]} ; argv[]=${argv.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
          `WorkingDirectory=${u.service['WorkingDirectory']![0]!.replace(/%%/g, '%')}`,
          `KillMode=${o.killMode ?? u.service['KillMode']![0]}`,
          'LoadState=loaded',
          'ActiveState=inactive',
          `FragmentPath=${path}`,
          `DropInPaths=${o.dropIn ? `${path}.d/override.conf` : ''}`,
          `UnitFileState=${enabled ? 'enabled' : 'disabled'}`,
          '',
        ].join('\n'),
      );
    }
    return no(98);
  };
  return { run, calls, unitDir, verbs: () => calls.map((c) => c[2] ?? c[0]) };
}

const APP = '/home/wook/욱채 앱 & 폴더';
const ENTRY = posix.join(APP, 'out', 'server', 'index.mjs');

/** 시험 의존 — 경로는 모두 POSIX 꼴(이 OS의 파일 시스템에는 닿지 않는다): 유닛 파일은 메모리, 진입점·linger 파일은 exists로, 웹 화면은 고른 것으로 */
function unitDeps(over: Partial<UnitCommandDeps> & { mgr?: ManagerOptions; lingerOn?: boolean; noEntry?: boolean } = {}) {
  const files = new Map<string, string>();
  const manager = fakeManager(files, over.mgr);
  const written: string[] = [];
  const { mgr: _m, lingerOn, noEntry, ...rest } = over;
  const d: UnitCommandDeps = {
    run: manager.run,
    uid: 1000,
    user: 'wook user',
    home: HOME,
    env: { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/home/u/.local/bin:/usr/bin' },
    appRoot: APP,
    nodePath: '/usr/bin/node',
    exists: (p) => (p.startsWith('/var/lib/systemd/linger/') ? lingerOn === true : p === ENTRY && !noEntry),
    chooseWebDir: (_flag, root) => ({ webDir: posix.join(root, 'out', 'web'), warning: null, refusal: null }),
    fs: {
      write(path, text) {
        files.set(path, text);
        written.push(path);
      },
      read: (path) => files.get(path) ?? null,
      remove: (path) => files.delete(path),
      list: (dir) => [...files.keys()].filter((p) => posix.dirname(p) === dir).map((p) => posix.basename(p)),
    },
    ...rest,
  };
  return { d, manager, written, files };
}

// 이 OS의 임시 폴더를 POSIX 꼴 경로로 쓰면 Windows에서는 드라이브가 빠진다 — 그래서 경로 비교가 드는 시험은 posix.join으로 만든 경로를 그대로 쓴다
const DATA = '/srv/욱채 데이터 % $X';

describe('install-task (Linux) — 지킴', () => {
  it('root면 1 — 그 글, systemctl을 부르지 않고 아무것도 쓰지 않는다', async () => {
    const t = unitDeps({ uid: 0 });
    const r = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, t.d);
    expect([r.code, r.err.trim(), t.manager.calls.length, t.written.length]).toEqual([1, UNIT_ROOT_REFUSAL, 0, 0]);
  });

  it('사용자 버스가 없으면(XDG_RUNTIME_DIR 없음 · show-environment 실패 — sudo -u·su 셸) 1 — 그 글, 쓰지 않는다', async () => {
    const a = unitDeps({ env: { PATH: '/usr/bin' } });
    const ra = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, a.d);
    expect([ra.code, ra.err.trim(), a.manager.calls.length, a.written.length]).toEqual([1, NO_USER_BUS, 0, 0]);
    const b = unitDeps({ mgr: { showEnvCode: 1 } });
    const rb = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, b.d);
    expect([rb.code, rb.err.trim(), b.manager.verbs(), b.written.length]).toEqual([1, NO_USER_BUS, ['show-environment'], 0]);
  });

  it('제어 문자가 든 값·빈칸으로 끝나는 앱 폴더·진입점 없음은 1 — 사용자 관리자에 닿기 전에', async () => {
    const t = unitDeps();
    const nl = await installUnit({ dataDir: '/srv/a\nExecStartPre=/bin/evil', flags: {}, dryRun: false }, t.d);
    expect([nl.code, nl.err.includes('제어 문자'), t.manager.calls.length]).toEqual([1, true, 0]);
    // systemd는 실행 파일 이름의 따옴표·역슬래시를 받지 않는다 — Node 경로에 그런 글자(또는 실행 때 펼치는 $)가 있으면 등록하지 않는다
    for (const node of ['/opt/no"de/node', "/opt/it's/node", '/opt/a\\b/node', '/opt/$HOME/node']) {
      const q = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, { ...t.d, nodePath: node });
      expect([node, q.code, q.err.includes('실행 파일 이름으로 받지 않는 글자')]).toEqual([node, 1, true]);
    }
    const sp = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, { ...t.d, appRoot: `${APP} `, exists: () => true });
    expect([sp.code, sp.err.includes('WorkingDirectory=')]).toEqual([1, true]);
    const noEntry = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, unitDeps({ noEntry: true }).d);
    expect([noEntry.code, noEntry.err.startsWith('서버 진입점이 없습니다')]).toEqual([1, true]);
    expect(t.manager.calls.length).toBe(0);
  });
});

describe('install-task (Linux) — 등록', () => {
  it('--dry-run: 유닛 글과 명령을 보이고 show-environment(읽기)만 부른다 — 파일을 쓰지 않는다', async () => {
    const t = unitDeps();
    const r = await installUnit({ dataDir: DATA, flags: { port: 7400 }, dryRun: true }, t.d);
    expect([r.code, t.manager.verbs(), t.written.length]).toEqual([0, ['show-environment'], 0]);
    const name = unitName(DATA);
    expect(r.out).toContain(`[시험 실행 — 아무것도 바꾸지 않았습니다] 등록할 사용자 유닛: ${name}`);
    expect(r.out).toContain(`  systemctl --user enable ${name}`);
    expect(r.out).toContain('KillMode=mixed');
    expect(r.out).not.toContain('systemctl --user start');
  });

  it('파일 → daemon-reload → enable → show 차례, start는 부르지 않는다 — 다시 읽은 argv·KillMode·WorkingDirectory가 같고, 다음 할 일과 linger 줄을 말한다', async () => {
    const t = unitDeps();
    const r = await installUnit({ dataDir: DATA, flags: { port: 7400, ownerEmail: 'owner@example.com' }, dryRun: false }, t.d);
    expect([r.code, r.err]).toEqual([0, '']);
    const name = unitName(DATA);
    const file = posix.join(t.manager.unitDir(), name);
    expect(t.written).toEqual([file]);
    expect(t.manager.calls.map((c) => c.slice(1, 3).join(' '))).toEqual(['--user show-environment', '--user daemon-reload', `--user enable`, `--user show`]);
    expect(t.manager.calls.flat()).not.toContain('start');
    const text = t.files.get(file)!;
    expect(execWords(parseUnitFile(text).service['ExecStart']![0]!)?.argv).toEqual(['/usr/bin/node', ENTRY, 'serve', '--data-dir', DATA, '--web-dir', posix.join(APP, 'out', 'web'), '--port', '7400', '--owner-email', 'owner@example.com']);
    expect(envAssignments(parseUnitFile(text).service['Environment']!)).toEqual({ PATH: '/home/u/.local/bin:/usr/bin' });
    expect(r.out).toContain(`  지금 띄우기   systemctl --user start ${name}`);
    expect(r.out).toContain(`  확인          wook-server status --data-dir '${DATA}'`);
    expect(r.out).toContain(`  부팅할 때도   sudo loginctl enable-linger 'wook user'`);
    // linger가 켜져 있으면 그 줄이 없다
    const on = unitDeps({ lingerOn: true });
    const r2 = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, on.d);
    expect([r2.code, r2.out.includes('enable-linger')]).toEqual([0, false]);
  });

  it('사용자 관리자의 HOME·XDG_CONFIG_HOME으로 정한다 — 설치한 셸의 값이 아니다', () => {
    expect(unitDirOf({ HOME: '/home/real' }, '/home/shell')).toBe('/home/real/.config/systemd/user');
    expect(unitDirOf({ HOME: '/home/real', XDG_CONFIG_HOME: '/srv/conf' }, '/home/shell')).toBe('/srv/conf/systemd/user');
    expect(unitDirOf({ XDG_CONFIG_HOME: 'relative' }, '/home/shell')).toBe('/home/shell/.config/systemd/user');
    expect(unitDirOf(null, '/home/shell')).toBe('/home/shell/.config/systemd/user');
  });

  it('사용자 관리자의 XDG_CONFIG_HOME이 있으면 그 아래 systemd/user에 쓴다 — 설치한 셸의 값이 아니다', async () => {
    const conf = '/srv/xdg conf';
    const t = unitDeps({ mgr: { env: { XDG_CONFIG_HOME: conf } }, env: { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/bin', XDG_CONFIG_HOME: '/elsewhere' } });
    const r = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, t.d);
    expect([r.code, t.written]).toEqual([0, [posix.join(conf, 'systemd', 'user', unitName(DATA))]]);
  });

  it('다시 읽은 것이 다르면 1 — 덧붙인 설정(drop-in), KillMode, 그 사이 바뀐 파일 글을 말한다', async () => {
    const drop = unitDeps({ mgr: { dropIn: true } });
    const r1 = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, drop.d);
    expect([r1.code, /덧붙인 설정\(drop-in: .*override\.conf\)/.test(r1.err)]).toEqual([1, true]);
    const km = unitDeps({ mgr: { killMode: 'control-group' } });
    const r2 = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, km.d);
    expect([r2.code, r2.err.includes('KillMode(control-group)')]).toEqual([1, true]);
    expect(compareUnit({ file: '/f', text: 'a', argv: ['x'], appRoot: '/r' }, { text: 'b', show: parseShow('LoadState=loaded\nFragmentPath=/f\nDropInPaths=\nUnitFileState=enabled\nKillMode=mixed\nWorkingDirectory=/r\nExecStart={ path=x ; argv[]=x ; ignore_errors=no ; }\n')[0]! })).toEqual(['유닛 파일의 글']);
    // show의 argv는 실행 때 펼치기 전이라 $가 $$로 남을 수 있다 — 같은 값으로 본다. 다른 값은 다르다
    const show = (argv: string): Record<string, string> => parseShow(`LoadState=loaded\nFragmentPath=/f\nDropInPaths=\nUnitFileState=enabled\nKillMode=mixed\nWorkingDirectory=/r\nExecStart={ path=/n ; argv[]=${argv} ; ignore_errors=no ; }\n`)[0]!;
    const want = { file: '/f', text: 't', argv: ['/n', '/d/$HOME/x'], appRoot: '/r' };
    expect([compareUnit(want, { text: 't', show: show('/n /d/$$HOME/x') }), compareUnit(want, { text: 't', show: show('/n /d/$HOME/x') }), compareUnit(want, { text: 't', show: show('/n /d/HOME/x') })]).toEqual([[], [], ['ExecStart']]);
  });

  it('enable이 실패하면 1 — 쓴 파일을 말하고 그 뒤를 부르지 않는다', async () => {
    const t = unitDeps({ mgr: { fail: { enable: 1 } } });
    const r = await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, t.d);
    expect([r.code, r.err.startsWith(`systemctl --user enable ${unitName(DATA)}에 실패했습니다`), t.manager.verbs()]).toEqual([1, true, ['show-environment', 'daemon-reload', 'enable']]);
  });
});

describe('uninstall-task (Linux)', () => {
  it('유닛이 없으면 0 — 읽기만 하고 지우지 않는다. 있으면 disable → 지움 → daemon-reload → 다시 읽기, 실행 중인 서버는 끄지 않는다', async () => {
    const t = unitDeps();
    const none = await uninstallUnit({ dataDir: DATA, dryRun: false }, t.d);
    expect([none.code, none.out, t.manager.verbs()]).toEqual([0, `등록된 유닛이 없습니다 (${unitName(DATA)}) — 바꾼 것이 없습니다\n`, ['show-environment', 'show']]);
    expect((await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, t.d)).code).toBe(0);
    t.manager.calls.length = 0;
    const r = await uninstallUnit({ dataDir: DATA, dryRun: false }, t.d);
    expect([r.code, t.manager.verbs()]).toEqual([0, ['show-environment', 'show', 'disable', 'daemon-reload', 'show']]);
    expect(t.files.has(posix.join(t.manager.unitDir(), unitName(DATA)))).toBe(false);
    expect(r.out).toBe(`사용자 유닛 ${unitName(DATA)}을 지웠습니다. 실행 중인 서버는 끄지 않았습니다 — 끄려면 wook-server shutdown --data-dir '${DATA}'\n`);
    expect(t.manager.calls.flat()).not.toContain('stop');
  });

  it('있는지 읽지 못하면 1 — 지우지 않는다. 다른 자리의 같은 이름(install-task가 쓰지 않은 유닛)도 1 — 지우지 않는다', async () => {
    const t = unitDeps({ mgr: { fail: { show: 1 } } });
    const r = await uninstallUnit({ dataDir: DATA, dryRun: false }, t.d);
    expect([r.code, r.err.startsWith('유닛이 있는지 읽지 못해 지우지 않았습니다'), t.manager.verbs()]).toEqual([1, true, ['show-environment', 'show']]);
    const e = unitDeps({ mgr: { fragmentElsewhere: '/etc/systemd/user/x.service' } });
    const r2 = await uninstallUnit({ dataDir: DATA, dryRun: false }, e.d);
    expect([r2.code, r2.err.includes('/etc/systemd/user/x.service에 있습니다'), e.manager.verbs()]).toEqual([1, true, ['show-environment', 'show']]);
  });

  it('--dry-run은 읽기(show-environment)만 하고 명령을 보인다', async () => {
    const t = unitDeps();
    const r = await uninstallUnit({ dataDir: DATA, dryRun: true }, t.d);
    expect([r.code, t.manager.verbs(), r.out.includes(`systemctl --user disable ${unitName(DATA)}`)]).toEqual([0, ['show-environment'], true]);
  });
});

describe('명령 줄 (cli.ts runLocal) — Linux 의존을 넣으면 유닛, 넣지 않으면 아무것도 부르지 않는다', () => {
  async function local(argv: string[], task: Partial<TaskCommandDeps>): Promise<{ code: number; out: string; err: string }> {
    const plan = parseCli(argv, {}, 'linux');
    if (plan.kind !== 'local') throw new Error(JSON.stringify(plan));
    let out = '';
    let err = '';
    const code = await runLocal(plan, { out: async (x) => void (out += x), err: async (x) => void (err += x), exit: () => undefined }, { task: task as TaskCommandDeps });
    return { code, out, err };
  }

  it('install-task --json — 유닛을 등록하고 ASCII JSON 한 줄', async () => {
    const t = unitDeps();
    const r = await local(['install-task', '--data-dir', DATA, '--json'], { platform: 'linux', run: t.manager.run, unit: t.d });
    expect(r.code).toBe(0);
    expect(/^[\x20-\x7e]*\n$/.test(r.out)).toBe(true);
    expect((JSON.parse(r.out) as { result: { name: string } }).result.name).toMatch(/^wook-server-[0-9a-f]{8}\.service$/);
    expect(r.out).toBe(jsonLine(JSON.parse(r.out)));
  });

  it('platform linux인데 유닛 의존이 없으면 2 — 실제 systemctl을 부르지 않는다 (시험이 실제 유닛을 등록하지 않게). macOS도 2', async () => {
    let calls = 0;
    const run = async (): Promise<ExecResult> => {
      calls++;
      return { code: 0, stdout: Buffer.alloc(0), timedOut: false, error: null };
    };
    for (const platform of ['linux', 'darwin'] as const) {
      for (const cmd of ['install-task', 'uninstall-task']) {
        const r = await local([cmd, '--data-dir', DATA], { platform, run, appRoot: '/x', nodePath: '/n', identity: async () => ({ error: 'x' }) });
        expect([platform, cmd, r.code, r.err.trim()]).toEqual([platform, cmd, 2, `${cmd}는 Windows(작업 스케줄러)와 Linux(systemd 사용자 유닛)에서만 씁니다`]);
      }
    }
    expect(calls).toBe(0);
  });
});

describe('유닛 이름 — 데이터 폴더마다 하나', () => {
  it('Linux는 대소문자를 가린다(다른 폴더) — Windows 작업 이름은 그대로 대소문자를 가리지 않는다', () => {
    expect(unitName('/srv/Data')).not.toBe(unitName('/srv/data'));
    expect(unitName('/srv/data')).toMatch(/^wook-server-[0-9a-f]{8}\.service$/);
    expect(dataDirHash('/srv/Data', 'win32')).toBe(dataDirHash('/srv/data', 'win32'));
    expect(dataDirHash('/srv/Data', 'linux')).not.toBe(dataDirHash('/srv/data', 'linux'));
    if (process.platform === 'win32') expect(taskName('C:\\Data')).toBe(taskName('c:\\data'));
  });

  it('유닛 이름은 가장 가까운 있는 상위 폴더의 실제 경로로 센다 — 데이터 폴더가 생기기 전과 뒤가 같다 (S10-13 SH-2, 넣은 realpath)', () => {
    // ~/wook → /mnt/disk2/wook 링크. 데이터 폴더 ~/wook/wook-data는 처음에 없다
    const before = (p: string): string => {
      if (p === '/home/u/wook') return '/mnt/disk2/wook';
      if (p === '/home/u' || p === '/home' || p === '/') return p;
      throw Object.assign(new Error('없음'), { code: 'ENOENT' });
    };
    const after = (p: string): string => (p === '/home/u/wook/wook-data' ? '/mnt/disk2/wook/wook-data' : before(p));
    expect(unitDataPath('/home/u/wook/wook-data', before)).toBe('/mnt/disk2/wook/wook-data');
    expect(unitName('/home/u/wook/wook-data', 'linux', before)).toBe(unitName('/home/u/wook/wook-data', 'linux', after));
    // 아무것도 풀지 못하면 적힌 절대 경로
    expect(unitDataPath('/x/y', () => { throw new Error('없음'); })).toBe('/x/y');
  });
});

describe('uninstall-task·check는 같은 데이터 폴더의 다른 이름 유닛도 찾는다 (S10-13 SH-2)', () => {
  it('install-task가 다른 이름으로 쓴 유닛 파일(--data-dir이 같은 폴더)도 지운다 — 손으로 쓴 파일·다른 폴더의 유닛은 건드리지 않는다', async () => {
    const t = unitDeps();
    expect((await installUnit({ dataDir: DATA, flags: {}, dryRun: false }, t.d)).code).toBe(0);
    const unitDir = t.manager.unitDir();
    const ours = posix.join(unitDir, unitName(DATA));
    // 예전 이름(폴더가 생기기 전의 해시 등)으로 남은 같은 폴더의 유닛, 다른 폴더의 유닛, 손으로 쓴 같은 폴더의 유닛
    const old = posix.join(unitDir, 'wook-server-3b54ecc2.service');
    t.files.set(old, t.files.get(ours)!);
    const otherDir = posix.join(unitDir, 'wook-server-0000aaaa.service');
    t.files.set(otherDir, t.files.get(ours)!.replace(`"--data-dir" "${DATA.replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`, '"--data-dir" "/srv/other"'));
    const hand = posix.join(unitDir, 'wook-server-1111bbbb.service');
    t.files.set(hand, t.files.get(ours)!.replace(/^#.*\n/, ''));
    const dry = await uninstallUnit({ dataDir: DATA, dryRun: true }, t.d);
    expect(dry.out).toContain(`지울 사용자 유닛: ${unitName(DATA)}, wook-server-3b54ecc2.service (같은 데이터 폴더를 가리키는 다른 이름의 유닛 포함)`);
    const r = await uninstallUnit({ dataDir: DATA, dryRun: false }, t.d);
    expect([r.code, r.out.startsWith(`사용자 유닛 ${unitName(DATA)}, wook-server-3b54ecc2.service을 지웠습니다.`)]).toEqual([0, true]);
    expect([t.files.has(ours), t.files.has(old), t.files.has(otherDir), t.files.has(hand)]).toEqual([false, false, true, true]);
  });
});

/**
 * 리뷰의 P9 (S10-13 SH-2) — 실제 링크: 데이터 폴더의 경로가 링크를 지나고 install-task가 폴더가 생기기 전에 돈다. 서버의 첫 시작이 폴더를 만든 뒤에도 유닛 이름이 같고,
 * uninstall-task가 그 유닛을 지운다. systemd는 메모리의 가짜다(아무것도 등록하지 않는다)
 */
describe.runIf(process.platform === 'linux')('P9: 링크를 지나는 데이터 폴더의 유닛 (Linux — 실제 링크·realpath가 있어야 본다)', () => {
  it('폴더가 생기기 전과 뒤의 유닛 이름이 같고, uninstall-task가 install-task의 유닛을 지운다', async () => {
    const root = temp('p9');
    mkdirSync(join(root, 'disk2', 'wook'), { recursive: true });
    symlinkSync(join(root, 'disk2', 'wook'), join(root, 'home-link'));
    const dataDir = join(root, 'home-link', 'wook-data');
    const t = unitDeps();
    const nameBefore = unitName(dataDir);
    expect((await installUnit({ dataDir, flags: {}, dryRun: false }, t.d)).code).toBe(0);
    // 서버의 첫 시작이 폴더를 만든다
    mkdirSync(dataDir, { mode: 0o700 });
    expect(unitName(dataDir)).toBe(nameBefore);
    const un = await uninstallUnit({ dataDir, dryRun: false }, t.d);
    expect([un.code, un.out.startsWith(`사용자 유닛 ${nameBefore}을 지웠습니다.`)]).toEqual([0, true]);
    expect([...t.files.keys()].filter((p) => p.endsWith('.service'))).toEqual([]);
  });
});

/**
 * 실제 systemd의 읽기 (Linux만 — systemd가 있어야 한다): 이 파일의 유닛 글을 임시 폴더에 쓰고 (1) systemd-analyze --user verify가 통과하고(따옴표·이스케이프가
 * 틀리면 'Invalid syntax'·'Unbalanced'로 실패, 실행 파일 경로를 잘못 풀면 'not executable'), (2) systemd --user --test(시험 모드 — 아무 관리자에도 올리지 않고 무엇도
 * 띄우지 않는다)가 덤프한 Command Line·WorkingDirectory·Environment·Description이 넣은 값 그대로인지 본다. 경로에는 빈칸·%·$·따옴표·역슬래시·한글이 든다
 */
describe.runIf(process.platform === 'linux' && existsSync('/usr/lib/systemd/systemd'))('실제 systemd가 같은 값으로 읽는다 (Linux, /usr/lib/systemd/systemd가 있을 때 — 등록하지 않는다)', () => {
  it('verify 통과, 시험 모드 덤프의 argv·작업 폴더·PATH·설명이 넣은 값 그대로', () => {
    const root = temp('systemd');
    const weird = join(root, `욱채 % $HOME "q" 'a' b\\c`);
    mkdirSync(weird, { recursive: true });
    // 실행 파일 자리 — verify는 그 경로를 풀어 실행할 수 있는지 본다. 실행 파일 이름에는 systemd가 따옴표·역슬래시를 받지 않아(제품도 거부) 빈칸·%·한글만
    const nodeDir = join(root, '노드 100% 폴더');
    mkdirSync(nodeDir);
    const node = join(nodeDir, 'node');
    symlinkSync(process.execPath, node);
    const i: UnitInputs = { ...SAMPLE, nodePath: node, appRoot: weird, entry: join(weird, 'out', 'server', 'index.mjs'), dataDir: join(weird, '데이터 100%'), webDir: null, port: undefined, path: `${weird}:/usr/bin:/bin` };
    const unitDir = join(root, 'units');
    mkdirSync(unitDir);
    const name = unitName(i.dataDir);
    const file = join(unitDir, name);
    // 두 명령은 사용자 런타임 폴더 아래의 경로를 계산만 한다 — 이 시험의 빈 폴더를 준다(XDG_RUNTIME_DIR이 없는 CI 단계에서도 같다, S10-13 TD-2)
    const runtime = join(root, 'runtime');
    mkdirSync(runtime, { mode: 0o700 });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtime };
    delete childEnv['DBUS_SESSION_BUS_ADDRESS'];
    writeFileSync(file, unitText(i));
    const verify = spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8', timeout: 60_000, env: childEnv });
    // 다른(주인의) 유닛에 대한 경고는 보지 않는다 — 이 파일 이름이 든 줄만
    const ours = `${verify.stdout}\n${verify.stderr}`.split('\n').filter((l) => l.includes(name) || /Invalid|Unbalanced|not executable|escape/i.test(l));
    expect([verify.status, ours]).toEqual([0, []]);
    const dump = spawnSync('/usr/lib/systemd/systemd', ['--user', '--test', `--unit=${name}`, '--no-pager'], { encoding: 'utf8', timeout: 60_000, env: { ...childEnv, SYSTEMD_UNIT_PATH: `${unitDir}:` } });
    expect(dump.status).toBe(0);
    const lines = dump.stdout.split('\n');
    const at = lines.findIndex((l) => l.trim() === `-> Unit ${name}:`);
    expect(at).toBeGreaterThanOrEqual(0);
    const block: string[] = [];
    for (let k = at + 1; k < lines.length && !lines[k]!.startsWith('\t-> Unit '); k++) block.push(lines[k]!.trim());
    const field = (key: string): string[] => block.filter((l) => l.startsWith(`${key}: `)).map((l) => l.slice(key.length + 2));
    expect(field('Description')).toEqual([`욱채 서버 (${i.dataDir})`]);
    expect(field('WorkingDirectory')).toEqual([i.appRoot]);
    expect(field('Environment')).toEqual([`PATH=${i.path}`]);
    expect(field('KillMode')).toEqual(['mixed']);
    // 덤프의 Command Line은 셸 꼴로 감싼다(\" \\ \$) — 풀어서 견준다. $는 실행 때 $$ → $로 펼친다(systemd.service: "$$" is a literal "$")
    const cmd = field('Command Line');
    expect(cmd).toHaveLength(1);
    const argv = splitSystemdWords(cmd[0]!)!.map((w) => w.replace(/\$\$/g, '$'));
    expect(argv).toEqual([i.nodePath, ...unitArgv(i)]);
    expect(statSync(file).isFile()).toBe(true);
  }, 120_000);
});
