/**
 * `wook-server check`의 Linux 쪽 (리드 결정 S10-6.3, src/server/deployCheckLinux.ts): 순수 항목 함수(linuxDeployItems)와 작은 모으기(gatherLinuxDeploy).
 * 모으기는 넣은 가짜 실행기·파일 읽기로만 본다 — 이 시험은 systemctl·tailscale·CLI를 부르지 않는다.
 * - 목록과 차례: user, proc, procps, node, unit, linger, dataDir, secrets, sleep, power, cli.claude, cli.codex, path, apikey-env, (screen — S10c의 자리), adminSocket, tailscale
 * - 항목 규칙: root는 실패, /proc을 읽지 못하면 실패, procps 없음은 경고, Node 24 밖은 실패, 유닛 없음·꺼짐·drop-in·KillMode·다른 진입점은 경고, --allow-test-session은
 *   실패, linger 꺼짐은 경고(sudo loginctl 줄), 넓은 데이터 폴더는 경고(chmod 700), 비밀 값 폴더 문제는 실패, 절전 대상이 막혀 있지 않으면 경고, 절전 막기가 안 되면
 *   경고(막아 두었으면 통과), 유닛 PATH 밖의 도구는 경고, API 키 환경 변수는 경고, 소켓이 아니면 경고, Tailscale은 Windows와 같은 판단
 * - 고칠 줄은 POSIX 작은따옴표 — 빈칸·$·따옴표·한글이 든 데이터 폴더도 그대로 붙여 넣을 수 있다(셸이 바꾸지 않는다)
 * - 모으기: 셸 없이 짧은 상한, 사용자 관리자에 닿지 못하면 유닛은 경고(보지 못함), tailscale status가 상한에 걸리면 serve status를 부르지 않는다, CLI는 유닛의 PATH로
 * - 명령: --dry-run은 아무것도 부르지 않는다, --json은 ASCII 한 줄, 실패가 있으면 1. Windows 의존만 넘긴 check는 Linux 점검을 돌리지 않는다
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonLine, parseCli, runLocal } from '../../src/server/cli';
import { formatCheck, type CliProbe, type DeployItem } from '../../src/server/deployCheck';
import {
  defaultLinuxGatherDeps,
  gatherLinuxDeploy,
  linuxDeployItems,
  runLinuxCheck,
  SLEEP_TARGETS,
  wookServerCommandPosix,
  type LinuxCheckDeps,
  type LinuxExec,
  type LinuxFacts,
  type LinuxGatherDeps,
} from '../../src/server/deployCheckLinux';
import { shQuote, unitText, unitName, type UnitInputs } from '../../src/server/unit';
import { fileStoreText, secretsDirOf } from '../../src/main/auth/fileSecretStore';

const DATA = "/home/u/욱채 데이터 $HOME 'q'";
const NODE = '/usr/bin/node';
const APP = '/home/u/wookagent';
const ENTRY = `${APP}/out/server/index.mjs`;
const UNIT_INPUTS: UnitInputs = { dataDir: DATA, nodePath: NODE, entry: ENTRY, appRoot: APP, webDir: null, port: 7400, path: '/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin' };
const goodCli = (path: string): CliProbe => ({ found: true, path, loggedIn: true, detail: '' });

function goodFacts(over: Partial<LinuxFacts> = {}): LinuxFacts {
  const name = unitName(DATA);
  const file = `/home/u/.config/systemd/user/${name}`;
  return {
    dataDir: DATA,
    uid: 1000,
    user: 'u',
    proc: null,
    tools: { ps: '/usr/bin/ps', pgrep: '/usr/bin/pgrep', inhibit: '/usr/bin/systemd-inhibit', tailscale: '/usr/bin/tailscale' },
    nodeVersion: '24.13.0',
    expected: { name, file, nodePath: NODE, entry: ENTRY },
    unit: { text: unitText(UNIT_INPUTS), show: { LoadState: 'loaded', FragmentPath: file, DropInPaths: '', UnitFileState: 'enabled', KillMode: 'mixed' }, error: null },
    linger: true,
    dataDirStat: { uid: 1000, mode: 0o40700, isDirectory: true },
    secretsProblem: null,
    sleep: SLEEP_TARGETS.map((id) => ({ id, load: 'masked' })),
    cli: { claude: goodCli('/home/u/.local/bin/claude'), codex: goodCli('/usr/local/bin/codex') },
    apiKeys: { claude: { authMode: 'subscription', registered: false }, codex: { authMode: 'subscription', registered: false } },
    envNames: { process: ['PATH', 'HOME'], manager: ['PATH', 'HOME'] },
    found: { claude: '/home/u/.local/bin/claude', codex: '/usr/local/bin/codex', git: '/usr/bin/git', node: NODE },
    tailscale: {
      status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'srv.tailnet.ts.net.' }, CertDomains: ['srv.tailnet.ts.net'] }),
      serve: JSON.stringify({ Web: { 'srv.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7400' } } } }, TCP: { '443': { HTTPS: true } } }),
      timedOut: false,
    },
    server: { adminPipe: { mode: 'socket', rejectsRemote: true, userOnlyAcl: true, reason: null }, power: { state: 'idle', reason: null }, secretStore: { backend: 'file', fallbackReason: null }, screen: { ok: true, detail: '화면 조작을 쓸 수 있습니다 (모니터 1개)' }, port: 7400 },
    ...over,
  };
}
const byId = (items: DeployItem[]): Record<string, DeployItem> => Object.fromEntries(items.map((i) => [i.id, i]));
const levels = (items: DeployItem[]): Record<string, string> => Object.fromEntries(items.map((i) => [i.id, i.level]));

describe('Linux check 항목 (S10-6.3) — 순수 함수', () => {
  it('목록과 차례 — 모두 통과하는 서버', () => {
    const items = linuxDeployItems(goodFacts());
    expect(items.map((i) => i.id)).toEqual(['user', 'proc', 'procps', 'node', 'unit', 'linger', 'dataDir', 'secrets', 'sleep', 'power', 'cli.claude', 'cli.codex', 'path', 'apikey-env', 'screen', 'adminSocket', 'tailscale']);
    expect(items.filter((i) => i.level !== 'ok').map((i) => `${i.id}: ${i.text}`)).toEqual([]);
    expect(byId(items)['secrets']!.text).toBe(fileStoreText(secretsDirOf(DATA)));
    expect(fileStoreText('/d/secrets')).toBe('파일 (/d/secrets — 이 사용자만, 암호화하지 않음)');
  });

  it('실행 사용자·/proc·procps·Node', () => {
    expect(levels(linuxDeployItems(goodFacts({ uid: 0 })))['user']).toBe('fail');
    expect(levels(linuxDeployItems(goodFacts({ uid: 998 })))['user']).toBe('warn');
    expect(byId(linuxDeployItems(goodFacts({ proc: '/proc/self/stat을 읽지 못했습니다 (EACCES)' })))['proc']).toMatchObject({ level: 'fail' });
    expect(byId(linuxDeployItems(goodFacts({ tools: { ps: null, pgrep: null, inhibit: '/x', tailscale: '/y' } })))['procps']).toEqual({ id: 'procps', level: 'warn', text: expect.stringContaining('ps·pgrep이 PATH에 없습니다'), fix: 'sudo apt install procps' });
    expect(byId(linuxDeployItems(goodFacts({ nodeVersion: '22.11.0' })))['node']).toMatchObject({ level: 'fail', fix: expect.stringContaining(`wook-server install-task --data-dir '/home/u/욱채 데이터 $HOME '\\''q'\\'''`) });
  });

  it('유닛: 없음·꺼짐·drop-in·KillMode·다른 진입점은 경고, --allow-test-session은 실패 — 다시 등록하는 줄은 지금 유닛의 옵션(--port)을 옮긴다', () => {
    const f = goodFacts();
    const none = byId(linuxDeployItems(goodFacts({ unit: { text: null, show: { LoadState: 'not-found' }, error: null } })))['unit']!;
    expect(none).toMatchObject({ level: 'warn', text: expect.stringContaining('등록된 유닛이 없습니다'), fix: wookServerCommandPosix('install-task', DATA) });
    const off = byId(linuxDeployItems(goodFacts({ unit: { ...f.unit, show: { ...f.unit.show!, UnitFileState: 'disabled', DropInPaths: '/x.d/o.conf', KillMode: 'control-group' } } })))['unit']!;
    expect(off.level).toBe('warn');
    for (const s of ['켜져(enable) 있지 않습니다', '덧붙인 설정(drop-in)', 'KillMode가 control-group']) expect(off.text).toContain(s);
    expect(off.fix).toBe(`다시 등록하세요 (같은 이름을 바꿔 넣습니다): ${wookServerCommandPosix('install-task', DATA, ['--port', '7400'])}`);
    const test = byId(linuxDeployItems(goodFacts({ unit: { ...f.unit, text: unitText(UNIT_INPUTS).replace('"--port"', '"--allow-test-session" "--port"') } })))['unit']!;
    expect([test.level, test.text.includes('--allow-test-session으로 띄웁니다')]).toEqual(['fail', true]);
    const other = byId(linuxDeployItems(goodFacts({ unit: { ...f.unit, text: unitText({ ...UNIT_INPUTS, entry: '/old/out/server/index.mjs' }) } })))['unit']!;
    expect([other.level, other.text.includes('서버 진입점이 지금 것과 다릅니다 (/old/out/server/index.mjs)')]).toEqual(['warn', true]);
    const noBus = byId(linuxDeployItems(goodFacts({ unit: { text: null, show: null, error: 'XDG_RUNTIME_DIR이 없습니다' } })))['unit']!;
    expect([noBus.level, noBus.fix?.includes('sudo -u·su 셸에는 사용자 버스가 없습니다')]).toEqual(['warn', true]);
  });

  it('linger·데이터 폴더·비밀 값 — 고칠 줄은 POSIX 작은따옴표', () => {
    expect(byId(linuxDeployItems(goodFacts({ linger: false })))['linger']).toMatchObject({ level: 'warn', fix: 'sudo loginctl enable-linger u  (관리자 권한이 드는 한 번)' });
    const wide = byId(linuxDeployItems(goodFacts({ dataDirStat: { uid: 1000, mode: 0o40755, isDirectory: true } })))['dataDir']!;
    expect(wide).toMatchObject({ level: 'warn', fix: `chmod 700 '/home/u/욱채 데이터 $HOME '\\''q'\\'''` });
    expect(levels(linuxDeployItems(goodFacts({ dataDirStat: null })))['dataDir']).toBe('skip');
    expect(byId(linuxDeployItems(goodFacts({ server: { ...goodFacts().server!, secretStore: { backend: 'file', fallbackReason: '비밀 값 폴더(…)의 권한이 넓습니다 (755)' } } })))['secrets']).toMatchObject({ level: 'fail' });
    expect(levels(linuxDeployItems(goodFacts({ server: { ...goodFacts().server!, secretStore: { backend: 'memory', fallbackReason: null } } })))['secrets']).toBe('fail');
    expect(levels(linuxDeployItems(goodFacts({ server: null, secretsProblem: '비밀 값 폴더(…)의 주인이 이 사용자(uid 1000)가 아닙니다 (uid 0)' })))['secrets']).toBe('fail');
  });

  it('절전: 막혀 있지 않으면 경고(mask 줄) — 절전 막기가 안 돼도 막아 두었으면 통과, 아니면 경고', () => {
    const open = goodFacts({ sleep: SLEEP_TARGETS.map((id) => ({ id, load: 'loaded' })) });
    expect(byId(linuxDeployItems(open))['sleep']).toMatchObject({ level: 'warn', fix: 'sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target' });
    const denied = { state: 'unavailable' as const, reason: 'systemd-inhibit: Failed to inhibit: Access denied' };
    expect(levels(linuxDeployItems(goodFacts({ server: { ...goodFacts().server!, power: denied } })))['power']).toBe('ok');
    expect(byId(linuxDeployItems({ ...open, server: { ...goodFacts().server!, power: denied } }))['power']).toMatchObject({ level: 'warn', text: expect.stringContaining('Access denied') });
  });

  it('유닛의 PATH 밖에서만 찾은 도구는 경고 — API 키 환경 변수(이 셸·사용자 관리자·유닛)는 경고, 이름만', () => {
    const f = goodFacts({ found: { claude: '/home/u/.nvm/versions/node/v24/bin/claude', codex: null, git: '/usr/bin/git', node: NODE } });
    expect(byId(linuxDeployItems(f))['path']).toMatchObject({ level: 'warn', text: expect.stringContaining('claude(/home/u/.nvm/versions/node/v24/bin/claude)') });
    const env = byId(linuxDeployItems(goodFacts({ envNames: { process: ['ANTHROPIC_API_KEY'], manager: ['OPENAI_API_KEY'] } })))['apikey-env']!;
    expect(env.level).toBe('warn');
    expect(env.text).toContain('ANTHROPIC_API_KEY(이 셸), OPENAI_API_KEY(사용자 관리자)');
    expect(env.fix).toContain('systemctl --user unset-environment ANTHROPIC_API_KEY OPENAI_API_KEY');
  });

  it('관리 채널·Tailscale — 서버가 없으면 건너뜀, funnel은 실패, serve 항목이 없으면 경고(operator 줄)', () => {
    const noServer = levels(linuxDeployItems(goodFacts({ server: null, sleep: SLEEP_TARGETS.map((id) => ({ id, load: 'loaded' })) })));
    expect([noServer['adminSocket'], noServer['power']]).toEqual(['skip', 'skip']);
    const ts = goodFacts().tailscale;
    expect(byId(linuxDeployItems(goodFacts({ tailscale: { ...ts, serve: JSON.stringify({ AllowFunnel: { 'srv.tailnet.ts.net:443': true } }) } })))['tailscale']!.level).toBe('fail');
    expect(byId(linuxDeployItems(goodFacts({ tailscale: { ...ts, serve: '{}' } })))['tailscale']).toMatchObject({ level: 'warn', fix: expect.stringContaining('sudo tailscale set --operator=u') });
    expect(byId(linuxDeployItems(goodFacts({ tools: { ...goodFacts().tools, tailscale: null } })))['tailscale']!.fix).toContain('curl -fsSL https://tailscale.com/install.sh | sh');
  });

  const POSIX_LINE = (): string => wookServerCommandPosix('install-task', DATA, ['--port', '7400', '--config', { value: "/etc/욱채 $x/`q`/'s'.json" }]);
  it('고칠 줄은 wook-server <명령> 뒤에 옵션과 감싼 값, 끝에 --data-dir (모든 OS)', () => {
    expect(POSIX_LINE().startsWith('wook-server install-task --port 7400 --config ')).toBe(true);
    expect(POSIX_LINE().endsWith(` --data-dir '/home/u/욱채 데이터 $HOME '\\''q'\\'''`)).toBe(true);
  });

  // TD-11: 셸로 읽어 보는 것은 POSIX에만 sh가 있다 — Windows에서는 건너뛴다(이른 return으로 통과하지 않게)
  it.skipIf(process.platform === 'win32')('고칠 줄의 POSIX 감싸기는 셸이 바꾸지 않는다 — 실제 sh가 같은 인자로 읽는다 (POSIX — /bin/sh가 있어야 본다)', () => {
    const line = POSIX_LINE();
    // wook-server 대신 printf로 — sh가 나눈 인자를 한 줄에 하나씩
    const r = spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${line.slice('wook-server '.length)}`], { encoding: 'utf8' });
    expect(r.stdout.split('\n').slice(0, -1)).toEqual(['install-task', '--port', '7400', '--config', "/etc/욱채 $x/`q`/'s'.json", '--data-dir', DATA]);
  });
});

describe('Linux check — 리뷰 고침 (S10-13 SH-1·SH-2·SH-8)', () => {
  it('SH-1: 링크인 데이터 폴더는 서버처럼 따라간 폴더를 보고 링크라고 적는다 — 이 사용자만이면 통과, 넓으면 경고(실패 아님)', () => {
    const link = { uid: 1000, mode: 0o40700, isDirectory: true, link: '/mnt/ssd/wook' };
    expect(byId(linuxDeployItems(goodFacts({ dataDirStat: link })))['dataDir']).toMatchObject({ level: 'ok', text: `${DATA} (링크 → /mnt/ssd/wook) — 이 사용자만 열 수 있습니다 (700)` });
    expect(byId(linuxDeployItems(goodFacts({ dataDirStat: { ...link, mode: 0o40755 } })))['dataDir']).toMatchObject({ level: 'warn', text: expect.stringContaining('(링크 → /mnt/ssd/wook)') });
  });

  it('SH-2: 같은 데이터 폴더의 유닛이 다른 이름으로만 있으면 그 이름을 말하고, 둘 다 있으면 서버 둘이 뜬다고 경고 — 고칠 줄은 지운 뒤 다시 등록', () => {
    const f = goodFacts();
    const onlyOther = byId(linuxDeployItems(goodFacts({ unit: { text: null, show: { LoadState: 'not-found' }, error: null, others: ['wook-server-3b54ecc2.service'] } })))['unit']!;
    expect(onlyOther).toMatchObject({ level: 'warn', text: expect.stringContaining('다른 이름으로 등록돼 있습니다 (wook-server-3b54ecc2.service)') });
    expect(onlyOther.fix).toBe(`지우고 다시 등록하세요: ${wookServerCommandPosix('uninstall-task', DATA)} 뒤 ${wookServerCommandPosix('install-task', DATA)}`);
    const both = byId(linuxDeployItems(goodFacts({ unit: { ...f.unit, others: ['wook-server-3b54ecc2.service'] } })))['unit']!;
    expect([both.level, both.text.includes('부팅하면 서버 둘이'), both.fix?.startsWith('지우고 다시 등록하세요: wook-server uninstall-task')]).toEqual(['warn', true, true]);
  });

  it('SH-8: 절전 대상을 막아 두었으면 절전 방지는 통과 — systemd-inhibit이 없어도, 서버가 없어도, 쓸 수 없어도', () => {
    const masked = SLEEP_TARGETS.map((id) => ({ id, load: 'masked' }));
    for (const [label, over] of [
      ['도구 없음·서버 없음', { server: null, tools: { ...goodFacts().tools, inhibit: null } }],
      ['도구 있음·서버 없음', { server: null }],
      ['쓸 수 없음', { server: { ...goodFacts().server!, power: { state: 'unavailable' as const, reason: 'systemd-inhibit: Failed to inhibit: Access denied' } } }],
    ] as const) {
      expect([label, byId(linuxDeployItems(goodFacts({ sleep: masked, ...over })))['power']!.level]).toEqual([label, 'ok']);
    }
    // 막아 두지 않았으면 도구가 없을 때 경고
    expect(byId(linuxDeployItems(goodFacts({ server: null, tools: { ...goodFacts().tools, inhibit: null }, sleep: SLEEP_TARGETS.map((id) => ({ id, load: 'loaded' })) })))['power']!.level).toBe('warn');
  });

  it.skipIf(process.platform !== 'linux')('SH-1 실제: 0700 폴더를 가리키는 링크를 데이터 폴더로 — 모으기의 stat이 따라가 통과, 실패가 아니다 (Linux — 링크와 POSIX 권한이 있어야 본다)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wook-test-checklink-'));
    try {
      const real = join(root, 'disk', 'wook');
      mkdirSync(real, { recursive: true, mode: 0o700 });
      chmodSync(real, 0o700);
      const link = join(root, 'wook-data');
      symlinkSync(real, link);
      const st = defaultLinuxGatherDeps().statDir(link);
      expect(st).toMatchObject({ isDirectory: true, link: real });
      // 실제 stat의 주인은 시험을 돌리는 사용자다 — 사실의 uid도 그 사용자로 둔다. 고정값(1000)으로 두면 uid가 다른 곳(GitHub 러너는 1001)에서
      // '주인이 이 사용자가 아닙니다' 경고가 나와 실패했다 (CI 첫 실행에서 드러남, S10-20)
      const item = byId(linuxDeployItems(goodFacts({ dataDir: link, dataDirStat: st, uid: process.getuid!() })))['dataDir']!;
      expect([item.level, item.text]).toEqual(['ok', `${link} (링크 → ${real}) — 이 사용자만 열 수 있습니다 (700)`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** 이 사용자가 들어 있는, 로그인 그룹이 아닌 그룹 하나 (Linux) — 없으면 undefined */
const OTHER_GID = process.platform === 'linux' ? process.getgroups?.().find((g) => g !== process.getgid?.()) : undefined;

describe('Linux check — 고침 2회차 (S10-16 FPS-2·FPS-3)', () => {
  it('FPS-2: 링크인 데이터 폴더의 고칠 줄(chown·chmod)은 따라간 폴더를 적는다 — 링크가 아닌 폴더는 그 경로 그대로', () => {
    const foreign = { uid: 0, mode: 0o40755, isDirectory: true, link: '/mnt/ssd/wook' };
    const item = byId(linuxDeployItems(goodFacts({ dataDirStat: foreign })))['dataDir']!;
    expect([item.level, item.fix]).toEqual(['warn', 'sudo chown -R u: /mnt/ssd/wook · chmod 700 /mnt/ssd/wook']);
    expect(item.text.startsWith(`${DATA} (링크 → /mnt/ssd/wook): 주인이 이 사용자가 아닙니다 (uid 0)`)).toBe(true);
    const plain = byId(linuxDeployItems(goodFacts({ dataDirStat: { uid: 0, mode: 0o40755, isDirectory: true } })))['dataDir']!;
    expect(plain.fix).toBe(`sudo chown -R u: ${shQuote(DATA)} · chmod 700 ${shQuote(DATA)}`);
  });

  it('FPS-3: 가리키는 곳이 없는 링크·고리인 링크는 실패 — 링크에 적힌 곳과 할 일을 말한다. 링크가 아닌 읽기 오류는 예전처럼 건너뜀', () => {
    const dangling = byId(linuxDeployItems(goodFacts({ dataDirStat: { error: 'ENOENT', pathProblem: { kind: 'link', path: DATA, target: '/mnt/ssd/wook', code: 'ENOENT' } } })))['dataDir']!;
    expect(dangling).toMatchObject({
      level: 'fail',
      text: `${DATA}: 데이터 폴더가 링크인데 가리키는 곳이 없습니다 (링크 → /mnt/ssd/wook) — 서버는 그 자리에 폴더를 만들 수 없습니다`,
      fix: '가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요',
    });
    const loop = byId(linuxDeployItems(goodFacts({ dataDirStat: { error: 'ELOOP', pathProblem: { kind: 'link', path: DATA, target: 'b', code: 'ELOOP' } } })))['dataDir']!;
    expect([loop.level, loop.text.includes('고리를 이뤄 폴더에 닿지 않습니다 (링크 → b)'), loop.fix]).toEqual(['fail', true, '링크를 고치거나 지우세요']);
    expect(byId(linuxDeployItems(goodFacts({ dataDirStat: { error: 'EACCES' } })))['dataDir']!.level).toBe('skip');
  });

  it('S10-16b: 위 폴더가 닿지 않는 링크이거나 위 폴더 자리에 파일이 있으면 실패 — 그 자리를 적고, 서버가 만든다고 하지 않는다', () => {
    const parent = byId(linuxDeployItems(goodFacts({ dataDirStat: { error: 'ENOENT', pathProblem: { kind: 'link', path: '/home/u/wook', target: '/mnt/disk2/wook', code: 'ENOENT' } } })))['dataDir']!;
    expect(parent).toMatchObject({
      level: 'fail',
      text: `${DATA}: 데이터 폴더 경로의 위 폴더(/home/u/wook)가 링크인데 가리키는 곳이 없습니다 (링크 → /mnt/disk2/wook) — 서버는 데이터 폴더를 만들 수 없습니다`,
      fix: '가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요',
    });
    const file = byId(linuxDeployItems(goodFacts({ dataDirStat: { error: 'ENOTDIR', pathProblem: { kind: 'notDir', path: '/home/u/notes.txt' } } })))['dataDir']!;
    expect(file).toMatchObject({
      level: 'fail',
      text: `${DATA}: 데이터 폴더 경로의 위 폴더 자리(/home/u/notes.txt)에 폴더가 아닌 것이 있습니다 — 서버는 그 아래에 데이터 폴더를 만들 수 없습니다`,
      fix: '그 자리의 파일을 옮기거나 지우세요, 아니면 다른 --data-dir을 쓰세요',
    });
    for (const x of [parent, file]) expect(x.text.includes('서버가 처음 시작할 때')).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('S10-16b 실제: 가리키는 곳이 없는 위 폴더 링크·경로 가운데의 파일·고리인 위 폴더는 실패, 링크를 지나는 보통의 아직 없는 폴더는 예전처럼 건너뜀 (Linux — 링크가 있어야 본다)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wook-test-checkparent-'));
    try {
      symlinkSync(join(root, 'not-mounted'), join(root, 'wook'));
      writeFileSync(join(root, 'notes.txt'), 'x');
      symlinkSync(join(root, 'q'), join(root, 'p'));
      symlinkSync(join(root, 'p'), join(root, 'q'));
      mkdirSync(join(root, 'disk'));
      symlinkSync(join(root, 'disk'), join(root, 'good'));
      const deps = defaultLinuxGatherDeps();
      const cases: Array<[string, unknown]> = [
        [join(root, 'wook', 'wook-data'), { error: 'ENOENT', pathProblem: { kind: 'link', path: join(root, 'wook'), target: join(root, 'not-mounted'), code: 'ENOENT' } }],
        [join(root, 'notes.txt', 'sub', 'wook-data'), { error: 'ENOTDIR', pathProblem: { kind: 'notDir', path: join(root, 'notes.txt') } }],
        [join(root, 'p', 'wook-data'), { error: 'ELOOP', pathProblem: { kind: 'link', path: join(root, 'p'), target: join(root, 'q'), code: 'ELOOP' } }],
      ];
      for (const [dir, want] of cases) {
        const st = deps.statDir(dir);
        expect([dir, st]).toEqual([dir, want]);
        expect([dir, byId(linuxDeployItems(goodFacts({ dataDir: dir, dataDirStat: st })))['dataDir']!.level]).toEqual([dir, 'fail']);
      }
      // 링크(폴더에 닿는다)를 지나는 아직 없는 폴더 사슬은 서버가 만든다
      const fresh = join(root, 'good', 'a', 'wook-data');
      expect(deps.statDir(fresh)).toBeNull();
      expect(byId(linuxDeployItems(goodFacts({ dataDir: fresh, dataDirStat: null })))['dataDir']!.level).toBe('skip');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('FPS-3 실제: 가리키는 곳이 없는 링크와 고리인 링크를 모으기의 stat이 실패로 넘긴다 — 아직 없음(건너뜀)이 아니다 (Linux — 링크가 있어야 본다)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wook-test-checkbroken-'));
    try {
      const dangling = join(root, 'wook-data');
      symlinkSync(join(root, 'not-mounted', 'wook'), dangling);
      const a = join(root, 'a');
      const b = join(root, 'b');
      symlinkSync(b, a);
      symlinkSync(a, b);
      const deps = defaultLinuxGatherDeps();
      expect(deps.statDir(dangling)).toEqual({ error: 'ENOENT', pathProblem: { kind: 'link', path: dangling, target: join(root, 'not-mounted', 'wook'), code: 'ENOENT' } });
      expect(deps.statDir(a)).toEqual({ error: 'ELOOP', pathProblem: { kind: 'link', path: a, target: b, code: 'ELOOP' } });
      // 정말 없는 경로는 예전처럼 '아직 없음'
      expect(deps.statDir(join(root, 'none'))).toBeNull();
      for (const p of [dangling, a]) {
        expect([p, byId(linuxDeployItems(goodFacts({ dataDir: p, dataDirStat: deps.statDir(p) })))['dataDir']!.level]).toEqual([p, 'fail']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 리뷰의 증명 그대로: coreutils `chown -R`은 명령줄의 링크를 따라가지 않는다(-P가 기본). 루트 없이 보려고 이 사용자의 폴더를 이 사용자의 다른 그룹으로 바꿔 두고,
  // 고칠 줄을 sudo만 빼고 셸로 그대로 돌린다 — 따라간 폴더의 그룹이 로그인 그룹으로 돌아와야 한다
  it.skipIf(process.platform !== 'linux' || OTHER_GID === undefined)('FPS-2 실제: 붙여 넣은 고칠 줄이 링크가 가리키는 폴더를 바꾼다 (Linux, 이 사용자가 다른 그룹에도 들어 있을 때 — 그 그룹으로 바꿔 본다)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wook-test-checkchown-'));
    try {
      const real = join(root, 'disk', 'wook');
      mkdirSync(join(real, 'sub'), { recursive: true });
      chmodSync(real, 0o755);
      const link = join(root, 'wook-data');
      symlinkSync(real, link);
      for (const p of [real, join(real, 'sub')]) chownSync(p, process.getuid!(), OTHER_GID!);
      const st = defaultLinuxGatherDeps().statDir(link);
      expect(st).toMatchObject({ isDirectory: true, link: real });
      // 다른 주인(sudo mkdir 뒤처럼)이라고 적힌 stat — 고칠 줄에 chown이 든다
      const item = byId(linuxDeployItems(goodFacts({ dataDir: link, dataDirStat: { ...(st as { uid: number; mode: number; isDirectory: boolean; link: string }), uid: 0 }, user: userInfo().username })))['dataDir']!;
      const lines = (item.fix ?? '').split(' · ');
      expect(lines.length).toBe(2);
      for (const line of lines) {
        const r = spawnSync('/bin/sh', ['-c', line.replace(/^sudo /, '')], { encoding: 'utf8' });
        expect([line, r.status, r.stderr]).toEqual([line, 0, '']);
      }
      expect([statSync(real).gid, statSync(join(real, 'sub')).gid, statSync(real).mode & 0o777]).toEqual([process.getgid!(), process.getgid!(), 0o700]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** 가짜 실행기 — 부름을 적고, 명령마다 정한 답 */
function fakeExec(answers: Record<string, { code?: number; stdout?: string; timedOut?: boolean }>) {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const exec: LinuxExec = async (file, args, o) => {
    calls.push({ file, args: [...args], timeoutMs: o.timeoutMs });
    const key = [file, ...args].join(' ');
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k))?.[1] ?? { code: 1 };
    return { code: hit.timedOut ? null : (hit.code ?? 0), stdout: hit.stdout ?? '', timedOut: hit.timedOut ?? false, error: null };
  };
  return { exec, calls };
}

function gatherDeps(exec: LinuxExec, over: Partial<LinuxGatherDeps> = {}): LinuxGatherDeps & { cliEnvs: NodeJS.ProcessEnv[] } {
  const cliEnvs: NodeJS.ProcessEnv[] = [];
  return {
    exec,
    uid: 1000,
    user: 'u',
    home: '/home/u',
    env: { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'x' },
    nodeVersion: '24.13.0',
    nodePath: NODE,
    appRoot: APP,
    proc: () => null,
    which: (name) => (name === 'tailscale' ? '/usr/bin/tailscale' : name === 'claude' ? '/home/u/.local/bin/claude' : `/usr/bin/${name}`),
    exists: () => false,
    readText: (p) => (p === `/home/u/.config/systemd/user/${unitName(DATA)}` ? unitText(UNIT_INPUTS) : null),
    statDir: () => ({ uid: 1000, mode: 0o40700, isDirectory: true }),
    secretsProblem: () => null,
    cli: async (kind, _o, env) => {
      cliEnvs.push(env);
      return goodCli(`/x/${kind}`);
    },
    now: () => new Date('2026-11-12T00:00:00Z'),
    cliEnvs,
    ...over,
  };
}

describe('Linux check 모으기 — 셸 없이 짧은 상한 (가짜 실행기)', () => {
  it('읽기 명령만, 4초 상한 — 사용자 관리자·유닛 show·절전 대상·tailscale 둘. CLI는 유닛의 PATH로 찾는다', async () => {
    const name = unitName(DATA);
    const f = fakeExec({
      'systemctl --user show-environment': { stdout: 'HOME=/home/u\nPATH=/usr/bin\nOPENAI_API_KEY=x\n' },
      [`systemctl --user show ${name}`]: { stdout: `LoadState=loaded\nFragmentPath=/home/u/.config/systemd/user/${name}\nDropInPaths=\nUnitFileState=enabled\nKillMode=mixed\n` },
      'systemctl show': { stdout: SLEEP_TARGETS.map((id) => `Id=${id}\nLoadState=masked\n`).join('\n') },
      '/usr/bin/tailscale status': { stdout: goodFacts().tailscale.status! },
      '/usr/bin/tailscale serve': { stdout: goodFacts().tailscale.serve! },
    });
    const d = gatherDeps(f.exec);
    const r = await gatherLinuxDeploy({ dataDir: DATA, cliPaths: { claudePath: null, codexPath: null }, apiKeys: null, server: goodFacts().server }, d);
    expect(f.calls.map((c) => [c.file, ...c.args.slice(0, 3)].join(' '))).toEqual([
      'systemctl --user show-environment',
      `systemctl --user show ${name}`,
      'systemctl show -p Id',
      '/usr/bin/tailscale status --json',
      '/usr/bin/tailscale serve status --json',
    ]);
    expect(f.calls.every((c) => c.timeoutMs === 4_000)).toBe(true);
    expect(d.cliEnvs.map((e) => e['PATH'])).toEqual([UNIT_INPUTS.path, UNIT_INPUTS.path]);
    const l = levels(r.items);
    expect([l['unit'], l['sleep'], l['tailscale'], l['apikey-env'], l['linger']]).toEqual(['ok', 'ok', 'ok', 'warn', 'warn']);
    expect(byId(r.items)['apikey-env']!.text).toContain('ANTHROPIC_API_KEY(이 셸), OPENAI_API_KEY(사용자 관리자)');
  });

  it('사용자 관리자에 닿지 못하면(XDG_RUNTIME_DIR 없음) systemctl --user를 부르지 않고 유닛은 경고 — tailscale status가 상한에 걸리면 serve status를 부르지 않는다', async () => {
    const f = fakeExec({ '/usr/bin/tailscale status': { timedOut: true }, 'systemctl show': { stdout: '' } });
    const d = gatherDeps(f.exec, { env: { PATH: '/usr/bin' } });
    const r = await gatherLinuxDeploy({ dataDir: DATA, cliPaths: { claudePath: null, codexPath: null }, apiKeys: null, server: null }, d);
    expect(f.calls.map((c) => [c.file, ...c.args.slice(0, 2)].join(' '))).toEqual(['systemctl show -p', '/usr/bin/tailscale status --json']);
    expect(byId(r.items)['unit']).toMatchObject({ level: 'warn', text: expect.stringContaining('XDG_RUNTIME_DIR이 없습니다') });
    expect(byId(r.items)['tailscale']).toMatchObject({ level: 'warn', text: expect.stringContaining('4초 안에 끝나지 않았습니다') });
  });
});

describe('운영자 명령 check (Linux)', () => {
  const deps = (exec: LinuxExec): LinuxCheckDeps & { serverCalls: string[] } => {
    const serverCalls: string[] = [];
    return {
      gather: gatherDeps(exec),
      server: async (d) => (serverCalls.push(d), null),
      config: () => null,
      serverCalls,
    };
  };

  it('--dry-run은 아무것도 부르지 않고 돌릴 것과 읽을 파일만 보인다', async () => {
    const f = fakeExec({});
    const d = deps(f.exec);
    const r = await runLinuxCheck({ dataDir: DATA, dryRun: true }, d);
    expect([r.code, f.calls.length, d.serverCalls.length]).toEqual([0, 0, 0]);
    expect(r.out).toContain(`  systemctl --user show ${unitName(DATA)}`);
    expect(r.out).toContain('  /var/lib/systemd/linger/<사용자>');
  });

  it('runLocal: checkLinux 의존이면 Linux 점검 — 실패가 있으면 1, --json은 ASCII 한 줄. Windows 의존만 넘기면 Linux 점검을 돌리지 않는다', async () => {
    const f = fakeExec({ 'systemctl show': { stdout: '' } });
    const plan = parseCli(['check', '--data-dir', DATA, '--json'], {}, 'linux');
    if (plan.kind !== 'local') throw new Error('local이 아님');
    let out = '';
    const io = { out: async (t: string) => void (out += t), err: async () => undefined, exit: () => undefined };
    const code = await runLocal(plan, io, { checkLinux: { ...deps(f.exec), gather: gatherDeps(f.exec, { uid: 0 }) } });
    expect(code).toBe(1);
    expect(/^[\x20-\x7e]*\n$/.test(out)).toBe(true);
    const parsed = JSON.parse(out) as { ok: boolean; result: { items: DeployItem[]; counts: Record<string, number> } };
    expect(parsed.result.items[0]).toMatchObject({ id: 'user', level: 'fail' });
    expect(out).toBe(jsonLine(parsed));
    // 사람이 읽는 표는 Windows와 같은 꼴
    expect(formatCheck({ checkedAt: 'x', items: parsed.result.items }).split('\n')[0]).toBe('욱채 서버 배포 점검 (x — 바꾼 것은 없습니다)');
  });
});
