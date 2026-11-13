/**
 * installTaskCli (리드 결정 S9-3·S9-11·S9-22): `wook-server install-task | uninstall-task [--dry-run] [--json]`.
 * schtasks와 다시 읽기(작업 스케줄러 COM을 읽는 PowerShell)는 주입한 가짜 실행기로만 부른다 — 이 PC에는 작업을 하나도 등록하지 않는다 (S9-13). 서버를 띄우지 않는다.
 * - 거부: Windows 밖(2), SYSTEM·서비스 SID·세션 0(1 — SYSTEM은 세션 0이 아니어도), --allow-test-session(쓰임새 오류 2 — 그 글, 실제 명령 길 runCli로도: 주입한
 *   가짜만 부를 수 있고 부르지 않는다), 진입점 없음(1), "·%가 든 경로(1)
 * - --dry-run은 아무것도 부르지 않는다(가짜에 부름이 0 — SID·세션은 읽기만 하는 identity로), 임시 파일도 만들지 않는다. 다시 읽기 스크립트를 보인다
 * - 등록: schtasks /create /tn <이름> /xml <임시 파일> /f → 다시 읽기(PowerShell — 그 이름의 taskReadScript) 차례, 임시 파일은 /create 동안 있었고(그 사용자만, BOM,
 *   쓴 XML 그대로) 끝나면 없다(실패해도). 다시 읽은 칸이 다르면 1 — RunLevel·동작도. 다른 한글 이름 계정의 작업은 다르고, é·ü·똠이 든 경로는 같다(그대로 읽으므로)
 * - uninstall-task는 되풀이해도 0 — 없으면 '등록된 작업이 없습니다', 지웠는데 남으면 1, 있는지 읽지 못하면 1(지우지 않는다 — S9-22 DF-9). 실행 중인 서버는 끄지
 *   않는다(shutdown을 말한다)
 * - --json은 ASCII JSON 한 줄(운영자 명령과 같은 출력기)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { jsonLine, parseCli, runCli, runLocal, taskDashValueRefusal, TASK_TEST_SESSION_REFUSAL, type CliPlan } from '../../src/server/cli';
import {
  buildTaskXml,
  registerTask,
  SERVICE_ACCOUNT_REFUSAL,
  taskName,
  taskReadScript,
  type ExecResult,
  type Identity,
  type TaskCommandDeps,
  type TaskInputs,
} from '../../src/server/task';
import { removeDir, windowsAcl, windowsMe } from './helpers';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
/** 늦춘 시험 (리드 결정 S9-18 — 한 번): 가짜 schtasks·다시 읽기·identity가 부를 때마다 이만큼 늦게 답한다 */
const DELAY = Number(process.env['WOOK_TEST_FAKE_DELAY_MS'] ?? '0');
const later = (): Promise<void> => (DELAY ? new Promise((r) => setTimeout(r, DELAY)) : Promise.resolve());
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

/** 시험 앱 루트 — out/server/index.mjs가 있고(있게 할 때), out/web은 서버용 빌드 표시가 있다 */
function appRoot(o: { entry?: boolean; web?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'wook-test-installtask-app 한글 & '));
  dirs.push(root);
  if (o.entry !== false) {
    mkdirSync(join(root, 'out', 'server'), { recursive: true });
    writeFileSync(join(root, 'out', 'server', 'index.mjs'), '// 시험\n');
  }
  if (o.web !== false) {
    mkdirSync(join(root, 'out', 'web'), { recursive: true });
    writeFileSync(join(root, 'out', 'web', 'index.html'), '<!doctype html><html><head><meta name="wook-build" content="remote"></head></html>');
  }
  return root;
}

interface Call {
  file: string;
  args: string[];
  /** /create 때 그 임시 파일 */
  xmlFile?: { path: string; bytes: Buffer; acl: ReturnType<typeof windowsAcl> | null };
  /** 다시 읽기 스크립트가 읽는 작업 이름 */
  reads?: string;
}

const ok = (stdout: Buffer = Buffer.alloc(0)): ExecResult => ({ code: 0, stdout, timedOut: false, error: null });
const no = (code = 1): ExecResult => ({ code, stdout: Buffer.alloc(0), timedOut: false, error: null });
/** 다시 읽기 PowerShell의 답 — 실제 스크립트처럼 ASCII JSON 한 줄(ASCII 밖은 \u) */
const readAnswer = (v: unknown): ExecResult => ok(Buffer.from(jsonLine(v), 'latin1'));

/**
 * 가짜 실행기 — 작업 하나의 상태를 흉내 낸다. schtasks(/create·/delete)와 다시 읽기(PowerShell — 스크립트가 taskReadScript(그 이름)인지 본다). 부름을 모두 적는다
 */
function fakeSchtasks(
  o: { exists?: boolean; createCode?: number; readXml?: (written: string) => string; readFails?: ExecResult; deleteLeaves?: boolean; aclDuringCreate?: boolean } = {},
) {
  const calls: Call[] = [];
  let exists = o.exists ?? false;
  let written = '';
  const run = async (file: string, args: readonly string[]): Promise<ExecResult> => {
    const call: Call = { file, args: [...args] };
    calls.push(call);
    await later();
    if (file === 'powershell') {
      const script = args[2] === '-EncodedCommand' ? Buffer.from(args[3] ?? '', 'base64').toString('utf16le') : '';
      const name = /GetTask\('([^']+)'\)/.exec(script)?.[1] ?? '';
      // 제품의 다시 읽기 스크립트 그대로가 아니면 답하지 않는다 (다른 PowerShell을 부르면 시험이 잡는다)
      if (!name || script !== taskReadScript(name)) return no(99);
      call.reads = name;
      if (o.readFails) return o.readFails;
      return readAnswer(exists ? { v: 1, found: true, xml: o.readXml ? o.readXml(written) : written, error: null } : { v: 1, found: false, xml: null, error: null });
    }
    if (file !== 'schtasks') return no(9);
    if (args[0] === '/create') {
      const path = args[args.indexOf('/xml') + 1]!;
      const bytes = readFileSync(path);
      call.xmlFile = { path, bytes, acl: o.aclDuringCreate && process.platform === 'win32' ? windowsAcl(path) : null };
      written = bytes.subarray(2).toString('utf16le');
      if ((o.createCode ?? 0) !== 0) return no(o.createCode);
      exists = true;
      return ok();
    }
    if (args[0] === '/delete') {
      if (!o.deleteLeaves) exists = false;
      return ok();
    }
    return no(9);
  };
  return { run, calls, schtasksCalls: () => calls.filter((c) => c.file === 'schtasks') };
}

function deps(over: Partial<TaskCommandDeps> & { id?: Identity | { error: string } } = {}): TaskCommandDeps & { identityCalls: () => number } {
  let identityCalls = 0;
  const id = over.id ?? { sid: SID, sessionId: 1 };
  const tmpBase = mkdtempSync(join(tmpdir(), 'wook-test-installtask-tmp-'));
  dirs.push(tmpBase);
  return {
    platform: 'win32',
    run: fakeSchtasks().run,
    identity: async () => {
      identityCalls++;
      await later();
      return id;
    },
    appRoot: appRoot(),
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    tmpBase,
    restrict: () => undefined,
    ...over,
    identityCalls: () => identityCalls,
  };
}

/** runLocal을 돌려 끝 코드·stdout·stderr */
async function local(argv: string[], d: Partial<TaskCommandDeps>): Promise<{ code: number; out: string; err: string; plan: CliPlan }> {
  const plan = parseCli(argv, {}, 'win32');
  if (plan.kind !== 'local') return { code: -1, out: '', err: JSON.stringify(plan), plan };
  let out = '';
  let err = '';
  const code = await runLocal(plan, { out: async (t) => void (out += t), err: async (t) => void (err += t), exit: () => undefined }, { task: d as TaskCommandDeps });
  return { code, out, err, plan };
}

const dataDir = (): string => {
  const d = join(mkdtempSync(join(tmpdir(), 'wook-test-installtask-data-')), '데이터 & 폴더');
  dirs.push(resolve(d, '..'));
  return d;
};

/** 보이는 다시 읽기 명령 줄 */
const READBACK_LINE = '  powershell.exe -NoProfile -NonInteractive -EncodedCommand <아래 다시 읽기 스크립트의 UTF-16LE base64>';

describe('거부 (S9-3)', () => {
  it('Windows·Linux 밖(macOS)이면 2 — 아무것도 부르지 않는다 (Linux는 systemd 사용자 유닛 — unitLinux.test, S10-6.2)', async () => {
    const f = fakeSchtasks();
    const d = deps({ platform: 'darwin', run: f.run });
    for (const cmd of ['install-task', 'uninstall-task']) {
      const r = await local([cmd, '--data-dir', dataDir()], d);
      expect([cmd, r.code, r.err.trim()]).toEqual([cmd, 2, `${cmd}는 Windows(작업 스케줄러)와 Linux(systemd 사용자 유닛)에서만 씁니다`]);
    }
    expect([f.calls.length, d.identityCalls()]).toEqual([0, 0]);
  });

  it('LocalSystem·LocalService·NetworkService SID(세션과 상관없이 — SYSTEM이 대화형 세션에서 돌아도), 세션 0이면 1 — 그 글로, 아무것도 부르지 않는다', async () => {
    for (const id of [
      { sid: 'S-1-5-18', sessionId: 0 },
      // psexec -s -i처럼 SYSTEM이 사용자 세션에서 도는 셸 — 세션 검사가 막지 않으므로 SID 검사가 막아야 한다 (S9-22 TI-4)
      { sid: 'S-1-5-18', sessionId: 1 },
      { sid: 'S-1-5-19', sessionId: 2 },
      { sid: 'S-1-5-20', sessionId: 2 },
      { sid: SID, sessionId: 0 },
    ]) {
      const f = fakeSchtasks();
      const r = await local(['install-task', '--data-dir', dataDir()], deps({ id, run: f.run }));
      expect([id, r.code, r.err.trim(), f.calls.length]).toEqual([id, 1, SERVICE_ACCOUNT_REFUSAL, 0]);
    }
    // 세션을 읽지 못하면(null) 막지 않는다 — SID가 이 사용자면 된다
    const f = fakeSchtasks();
    expect((await local(['install-task', '--data-dir', dataDir()], deps({ id: { sid: SID, sessionId: null }, run: f.run }))).code).toBe(0);
  });

  it('--allow-test-session은 쓰임새 오류 2 (그 글), --bind도 받지 않는다 — 실제 명령 길(runCli)도 주입한 가짜만 부를 수 있고 부르지 않으며 데이터 폴더에 아무것도 만들지 않는다', async () => {
    const d = dataDir();
    expect(parseCli(['install-task', '--allow-test-session', '--data-dir', d], {}, 'win32')).toEqual({ kind: 'error', message: TASK_TEST_SESSION_REFUSAL });
    expect(parseCli(['install-task', '--bind', '::1'], {}, 'win32')).toMatchObject({ kind: 'error', message: expect.stringContaining('--bind를 받지 않습니다') });
    // 인자 읽기가 틀어져도 이 시험이 실제 schtasks에 작업을 등록할 수 없게 가짜를 넣는다 (리드 결정 S9-22 TI-6)
    const f = fakeSchtasks();
    const td = deps({ run: f.run });
    let err = '';
    const code = await runCli(['install-task', '--allow-test-session', '--data-dir', d], { out: async () => undefined, err: async (t) => void (err += t), exit: () => undefined }, { task: td });
    expect([code, err.startsWith(`${TASK_TEST_SESSION_REFUSAL}\n`), existsSync(d), f.calls.length, td.identityCalls()]).toEqual([2, true, false, 0, 0]);
  });

  it("작업에 옮기는 옵션의 값이 '-'로 시작하면 쓰임새 오류 2 — 등록·임시 파일·schtasks 없음, --dry-run도 같다. 값은 되풀이하지 않는다 (S9-25 R3-3)", async () => {
    // 로그온 때 서버의 인자 읽기는 `--owner-email -x@…`를 모호한 옵션으로 거부한다 — 그런 작업은 서버를 띄우지 못한다
    for (const [flag, value] of [
      // 값은 사용법 글에 없는 모양으로 — 되풀이하지 않는지 본다
      ['owner-email', '-x7q@example.com'],
      ['config', '-c7q.json'],
      ['web-dir', '-w7q'],
      ['workspace-root', '-r7q'],
      ['public-origin', '-https://p7q.tailnet-x.ts.net'],
      ['port', '-17'],
    ] as const) {
      for (const dry of [false, true]) {
        const f = fakeSchtasks();
        const td = deps({ run: f.run });
        const data = dataDir();
        let err = '';
        let out = '';
        const argv = ['install-task', `--${flag}=${value}`, '--data-dir', data, ...(dry ? ['--dry-run'] : [])];
        expect(parseCli(argv, {}, 'win32')).toEqual({ kind: 'error', message: taskDashValueRefusal(flag) });
        const code = await runCli(argv, { out: async (t) => void (out += t), err: async (t) => void (err += t), exit: () => undefined }, { task: td });
        expect([flag, dry, code, err.startsWith(`${taskDashValueRefusal(flag)}\n`), (err + out).includes(value), f.calls.length, td.identityCalls(), readdirSync(td.tmpBase!), existsSync(data)]).toEqual([
          flag,
          dry,
          2,
          true,
          false,
          0,
          0,
          [],
          false,
        ]);
      }
    }
    // serve는 그대로 — 서버 자신의 인자 읽기는 바꾸지 않았다 (=꼴의 값은 serve가 받는다)
    expect(parseCli(['serve', '--owner-email=-x@example.com', '--data-dir', 'd'], {}, 'win32')).toMatchObject({ kind: 'serve' });
  });

  it('진입점(out/server/index.mjs)이 없으면 1, 서버용이 아닌 --web-dir도 1, "·%가 든 경로도 1 — 아무것도 부르지 않는다', async () => {
    const f = fakeSchtasks();
    const noEntry = await local(['install-task', '--data-dir', dataDir()], deps({ run: f.run, appRoot: appRoot({ entry: false }) }));
    expect([noEntry.code, noEntry.err.includes('서버 진입점이 없습니다'), noEntry.err.includes('npm run build:server')]).toEqual([1, true, true]);
    const notWeb = mkdtempSync(join(tmpdir(), 'wook-test-installtask-devweb-'));
    dirs.push(notWeb);
    writeFileSync(join(notWeb, 'index.html'), '<!doctype html><html></html>');
    const dev = await local(['install-task', '--web-dir', notWeb, '--data-dir', dataDir()], deps({ run: f.run }));
    expect([dev.code, dev.err.includes('서버용 웹 화면이 아닙니다')]).toEqual([1, true]);
    const pct = await local(['install-task', '--data-dir', join(dataDir(), '%USERPROFILE%')], deps({ run: f.run }));
    expect([pct.code, pct.err.includes('퍼센트(%)')]).toEqual([1, true]);
    expect(f.calls).toEqual([]);
  });
});

describe('--dry-run은 아무것도 부르지 않는다 (S9-3)', () => {
  it('install-task --dry-run: XML·실행할 명령·다시 읽기 스크립트를 보이고 부름 0, 임시 파일 없음 — SID·세션은 읽기만', async () => {
    const f = fakeSchtasks();
    const d = deps({ run: f.run });
    const data = dataDir();
    const r = await local(['install-task', '--dry-run', '--port', '7330', '--data-dir', data], d);
    expect(r.code).toBe(0);
    expect(f.calls).toEqual([]);
    expect(readdirSync(d.tmpBase!)).toEqual([]);
    expect(d.identityCalls()).toBe(1);
    const name = taskName(data);
    expect(r.out.split('\n').slice(0, 1)).toEqual([`[시험 실행 — 아무것도 바꾸지 않았습니다] 등록할 작업: ${name}`]);
    expect(r.out).toContain(`  schtasks /create /tn ${name} /xml <임시 파일> /f`);
    expect(r.out).toContain(`${READBACK_LINE}  (등록한 작업을 작업 스케줄러 COM으로 그대로 다시 읽어 견줍니다 — 읽기만)`);
    expect(r.out).toContain(taskReadScript(name).trim());
    const inputs: TaskInputs = { dataDir: resolve(data), nodePath: d.nodePath, entry: join(d.appRoot, 'out', 'server', 'index.mjs'), appRoot: d.appRoot, webDir: join(d.appRoot, 'out', 'web'), port: 7330, sid: SID };
    expect(r.out).toContain(buildTaskXml(inputs).replace(/\r\n/g, '\n'));
  });

  it('uninstall-task --dry-run: 실행할 명령(있는지 읽기·지우기)만 — 부름 0', async () => {
    const f = fakeSchtasks({ exists: true });
    const data = dataDir();
    const r = await local(['uninstall-task', '--dry-run', '--data-dir', data], deps({ run: f.run }));
    expect([r.code, f.calls.length]).toEqual([0, 0]);
    expect(r.out).toContain(`${READBACK_LINE}  (작업이 있는지 작업 스케줄러 COM으로 읽습니다 — 읽기만, 지운 뒤에도 한 번 더)`);
    expect(r.out).toContain(`  schtasks /delete /tn ${taskName(data)} /f`);
  });
});

describe('등록 (S9-3)', () => {
  it.skipIf(process.platform !== 'win32')('argv: /create … /xml <임시 파일> /f 뒤 다시 읽기(그 이름의 COM 읽기 스크립트) — 임시 파일은 그때 있었고(BOM, 쓴 XML), 끝나면 없다. 다음 할 일을 말하고 서버는 띄우지 않는다 (Windows — 임시 파일을 icacls로 그 사용자만 읽게 좁힌다)', async () => {
    const f = fakeSchtasks({ aclDuringCreate: true });
    const d = deps({ run: f.run, restrict: undefined });
    const data = dataDir();
    const name = taskName(data);
    const r = await local(['install-task', '--data-dir', data, '--owner-email', 'owner@example.com', '--public-origin', 'https://grok-pc.tailnet-x.ts.net'], d);
    expect([r.code, r.err]).toEqual([0, '']);
    const calls = f.calls;
    expect(calls.map((c) => [c.file, ...(c.file === 'schtasks' ? c.args.map((a) => (a === calls[0]!.xmlFile?.path ? '<파일>' : a)) : [c.reads])])).toEqual([
      ['schtasks', '/create', '/tn', name, '/xml', '<파일>', '/f'],
      ['powershell', name],
    ]);
    const xf = calls[0]!.xmlFile!;
    expect([xf.bytes[0], xf.bytes[1]]).toEqual([0xff, 0xfe]);
    const inputs: TaskInputs = {
      dataDir: resolve(data),
      nodePath: d.nodePath,
      entry: join(d.appRoot, 'out', 'server', 'index.mjs'),
      appRoot: d.appRoot,
      webDir: join(d.appRoot, 'out', 'web'),
      ownerEmail: 'owner@example.com',
      publicOrigin: 'https://grok-pc.tailnet-x.ts.net',
      sid: SID,
    };
    expect(xf.bytes.subarray(2).toString('utf16le')).toBe(buildTaskXml(inputs));
    // 임시 파일과 그 폴더는 남지 않는다
    expect([existsSync(xf.path), readdirSync(d.tmpBase!)]).toEqual([false, []]);
    if (xf.acl) {
      // 그 사용자만 (상속 끊음, 지금 사용자 하나)
      expect(xf.acl.protected).toBe(true);
      expect(xf.acl.rules.map((x) => x.id)).toEqual([windowsMe()]);
    }
    expect(r.out).toContain(`작업 스케줄러에 등록했습니다: ${name}`);
    expect(r.out).toContain(`  지금 띄우기   schtasks /run /tn ${name}`);
    expect(r.out).toContain('wook-server status --data-dir');
    expect(r.out).toContain('wook-server shutdown --data-dir');
  }, 60_000);

  it('/create가 실패하면 1이고 다시 읽지 않는다 — 임시 파일은 남지 않는다', async () => {
    const f = fakeSchtasks({ createCode: 1 });
    const d = deps({ run: f.run });
    const r = await local(['install-task', '--data-dir', dataDir()], d);
    expect([r.code, r.err.includes('작업을 등록하지 못했습니다 (schtasks /create 끝 코드 1)')]).toEqual([1, true]);
    expect(f.calls.map((c) => [c.file, c.args[0]])).toEqual([['schtasks', '/create']]);
    expect(readdirSync(d.tmpBase!)).toEqual([]);
  });

  it('다시 읽은 칸이 다르면 1 (Command·Arguments·UserId·LogonType·RunLevel·동작), 다시 읽지 못하면 1 — 그대로면 0', async () => {
    const swap = (from: RegExp | string, to: string) => (w: string) => w.replace(from, to);
    const cases: [string, (w: string) => string, number, string | null][] = [
      ['Command', swap(/<Command>[^<]*<\/Command>/, '<Command>C:\\other\\node.exe</Command>'), 1, 'Command(Node)'],
      ['Arguments', swap(/<\/Arguments>/, ' --allow-test-session</Arguments>'), 1, 'Arguments'],
      ['UserId', swap(/<UserId>[^<]*<\/UserId><LogonType>/, '<UserId>S-1-5-18</UserId><LogonType>'), 1, 'UserId'],
      ['LogonType', swap(/InteractiveToken/, 'Password'), 1, 'LogonType'],
      // 관리자 권한으로 바뀐 작업·동작이 더 붙은 작업 (S9-22 DS-1)
      ['RunLevel', swap('<RunLevel>LeastPrivilege</RunLevel>', '<RunLevel>HighestAvailable</RunLevel>'), 1, 'RunLevel'],
      ['Actions', swap('</Exec></Actions>', '</Exec><Exec><Command>C:\\x\\other.exe</Command></Exec></Actions>'), 1, 'Actions'],
      // Exec가 아닌 동작 하나뿐 — 동작이 하나여도 다르다 (확인 검토의 R10)
      ['ComHandler 하나', swap(/<Exec>[\s\S]*<\/Exec>/, '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler>'), 1, 'Command(Node), Arguments, Actions'],
      ['같음', (w) => w, 0, null],
    ];
    for (const [label, readXml, code, diff] of cases) {
      const f = fakeSchtasks({ readXml });
      const r = await local(['install-task', '--data-dir', dataDir()], deps({ run: f.run }));
      expect([label, r.code, diff ? r.err.includes(`등록한 작업이 쓴 것과 다릅니다 (${diff})`) : r.err]).toEqual([label, code, diff ? true : '']);
    }
    for (const [label, readFails, why] of [
      ['끝 코드', no(1), 'Windows PowerShell 끝 코드 1'],
      ['시간 초과', { ...no(1), code: null, timedOut: true }, 'Windows PowerShell 15초 안에 끝나지 않음'],
      ['COM 오류', readAnswer({ v: 1, found: false, xml: null, error: '액세스가 거부되었습니다' }), '작업 스케줄러: 액세스가 거부되었습니다'],
    ] as [string, ExecResult, string][]) {
      const f = fakeSchtasks({ readFails });
      const r = await local(['install-task', '--data-dir', dataDir()], deps({ run: f.run }));
      expect([label, r.code, r.err.includes(`등록한 작업을 다시 읽지 못했습니다 (${why})`)]).toEqual([label, 1, true]);
    }
  });

  describe('다시 읽기는 글자를 그대로 견준다 (S9-22 DS-3·DS-4 — 예전 949 견주기가 놓치거나 틀리게 본 경우)', () => {
    const asName = (i: Omit<TaskInputs, 'sid'>, account: string): string => buildTaskXml({ ...i, sid: 'PLACEHOLDER' }).split('PLACEHOLDER').join(account);
    const register = async (me: TaskInputs, readXml: string, accountNames: string[]) => {
      const tmpBase = mkdtempSync(join(tmpdir(), 'wook-test-installtask-reg-'));
      dirs.push(tmpBase);
      const run = async (file: string, args: readonly string[]): Promise<ExecResult> => {
        await later();
        if (file === 'powershell') return readAnswer({ v: 1, found: true, xml: readXml, error: null });
        return args[0] === '/create' ? ok() : no(9);
      };
      return registerTask('WookServer-0123abcd', me, { run, tmpBase, restrict: () => undefined, accountNames });
    };
    const me: TaskInputs = { dataDir: 'C:\\Users\\홍길동\\wook-data', nodePath: 'C:\\Users\\홍길동\\nodejs\\node.exe', entry: 'C:\\wookagent\\out\\server\\index.mjs', appRoot: 'C:\\wookagent', webDir: null, sid: SID };
    const myNames = ['DESKTOP-X\\홍길동', '홍길동'];

    it('대조: 같은 작업이 계정 이름(DESKTOP-X\\홍길동)으로 돌아오면 0', async () => {
      expect(await register(me, asName(me, 'DESKTOP-X\\홍길동'), myNames)).toEqual({ ok: true });
    });

    it('다른 한글 이름 계정(김철수)의 작업 — 그 계정·그 Node·그 데이터 폴더 — 은 다르다 (1)', async () => {
      const other = { ...me, dataDir: 'C:\\Users\\김철수\\wook-data', nodePath: 'C:\\Users\\김철수\\nodejs\\node.exe' };
      const r = await register(me, asName(other, 'DESKTOP-X\\김철수'), myNames);
      expect(r).toEqual({ ok: false, step: 'compare', message: expect.stringContaining('등록한 작업이 쓴 것과 다릅니다 (Command(Node), Arguments, UserId)') });
      // 계정만 다른 한글 이름이어도 다르다
      expect(await register(me, asName(me, 'DESKTOP-X\\김철수'), myNames)).toMatchObject({ ok: false, message: expect.stringContaining('(UserId)') });
    });

    for (const who of ['똠방', 'Müller', 'José']) {
      it(`949에 없는 글자가 든 경로(${who})의 같은 작업은 같다 (0)`, async () => {
        const mine: TaskInputs = { dataDir: `C:\\Users\\${who}\\wook-data`, nodePath: `C:\\Users\\${who}\\nodejs\\node.exe`, entry: 'C:\\wookagent\\out\\server\\index.mjs', appRoot: 'C:\\wookagent', webDir: null, sid: SID };
        expect(await register(mine, buildTaskXml(mine), [])).toEqual({ ok: true });
      });
    }
  });
});

describe('uninstall-task (S9-3)', () => {
  it('되풀이해도 0 — 있으면 지우고, 없으면 등록된 작업이 없다고. 실행 중인 서버는 끄지 않는다고 말한다', async () => {
    const f = fakeSchtasks({ exists: true });
    const d = deps({ run: f.run });
    const data = dataDir();
    const name = taskName(data);
    const first = await local(['uninstall-task', '--data-dir', data], d);
    expect([first.code, first.out.startsWith(`작업 ${name}을 지웠습니다.`), first.out.includes('wook-server shutdown')]).toEqual([0, true, true]);
    expect(f.calls.map((c) => (c.file === 'powershell' ? ['읽기', c.reads] : c.args))).toEqual([
      ['읽기', name],
      ['/delete', '/tn', name, '/f'],
      ['읽기', name],
    ]);
    const again = await local(['uninstall-task', '--data-dir', data], d);
    expect([again.code, again.out]).toEqual([0, `등록된 작업이 없습니다 (${name}) — 바꾼 것이 없습니다\n`]);
    expect(f.calls).toHaveLength(4);
  });

  it('지웠다는데 남아 있으면 1', async () => {
    const f = fakeSchtasks({ exists: true, deleteLeaves: true });
    const r = await local(['uninstall-task', '--data-dir', dataDir()], deps({ run: f.run }));
    expect([r.code, r.err.includes('아직 있습니다')]).toEqual([1, true]);
  });

  it('작업이 있는지 읽지 못하면(시간 초과·끝 코드·COM 오류) 없다고 하지 않고 1 — 지우지도 않는다 (S9-22 DF-9)', async () => {
    for (const [label, readFails, why] of [
      ['시간 초과', { ...no(1), code: null, timedOut: true }, 'Windows PowerShell 15초 안에 끝나지 않음'],
      ['띄우지 못함', { ...no(1), code: null, error: 'ENOENT' }, 'Windows PowerShell ENOENT'],
      ['COM 오류', readAnswer({ v: 1, found: false, xml: null, error: '액세스가 거부되었습니다' }), '작업 스케줄러: 액세스가 거부되었습니다'],
    ] as [string, ExecResult, string][]) {
      const f = fakeSchtasks({ exists: true, readFails });
      const r = await local(['uninstall-task', '--data-dir', dataDir()], deps({ run: f.run }));
      expect([label, r.code, r.out, r.err.includes(`작업이 있는지 읽지 못해 지우지 않았습니다 (${why})`), f.schtasksCalls()]).toEqual([label, 1, '', true, []]);
    }
  });
});

describe('--json (리드 결정 S9-18 — ASCII JSON 한 줄)', () => {
  it('install-task --dry-run --json·거부·uninstall-task --json: ASCII 한 줄, 949로 읽어도 같은 JSON', async () => {
    const data = dataDir();
    const results: { line: string; code: number }[] = [];
    for (const [argv, over] of [
      [['install-task', '--dry-run', '--json', '--data-dir', data], {}],
      [['install-task', '--json', '--data-dir', data], { id: { sid: 'S-1-5-18', sessionId: 0 } }],
      [['uninstall-task', '--json', '--data-dir', data], {}],
    ] as [string[], Parameters<typeof deps>[0]][]) {
      const r = await local(argv, deps(over));
      results.push({ line: r.out, code: r.code });
      expect(r.err).toBe('');
      expect(/^[\x20-\x7e]*\n$/.test(r.out)).toBe(true);
      expect(JSON.parse(new TextDecoder('euc-kr').decode(Buffer.from(r.out, 'utf8')))).toEqual(JSON.parse(r.out));
    }
    const [dry, refused, un] = results.map((x) => ({ code: x.code, j: JSON.parse(x.line) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } } }));
    expect([dry!.code, dry!.j.ok, dry!.j.result!['dryRun'], dry!.j.result!['name'], typeof dry!.j.result!['xml'], dry!.j.result!['readScript']]).toEqual([0, true, true, taskName(data), 'string', taskReadScript(taskName(data))]);
    expect([refused!.code, refused!.j]).toEqual([1, { ok: false, error: { code: 'service_account', message: SERVICE_ACCOUNT_REFUSAL } }]);
    expect([un!.code, un!.j]).toEqual([0, { ok: true, result: { dryRun: false, name: taskName(data), existed: false, removed: false } }]);
  });
});
