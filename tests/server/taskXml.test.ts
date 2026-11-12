/**
 * taskXml (리드 결정 S9-3·S9-11): install-task가 쓰는 작업 스케줄러 XML.
 * - 이스케이프: 띄어쓰기·&·<·한글·끝의 역슬래시 — XML 글은 이스케이프하고, 인자는 Windows 명령 줄 규칙(닫는 따옴표 앞 역슬래시 두 배)으로 감싼다.
 *   인자는 실제 Node가 그 명령 줄을 읽게 해서 본다(작업 스케줄러는 `"<Command>" <Arguments>`로 띄운다)
 * - `"`·`%`가 든 경로는 받지 않는다(작업 스케줄러가 %…%를 펼친다), BOM이 있는 UTF-16LE
 * - S9-3의 칸 모두 — 글로 보고, Windows에서는 작업 스케줄러 COM의 새 정의(NewTask — 등록하지 않는다)에 XML을 넣어 스케줄러가 읽은 값으로도 본다
 * - 다시 읽기(S9-22 DS-3·DS-4): 작업 스케줄러 COM을 읽기만 하는 PowerShell 하나(ASCII JSON) — 가짜 실행기로 답의 꼴마다, Windows에서는 없는 작업을 실제로 읽어 본다.
 *   견주기는 모든 글자를 그대로(한글·é·ü·똠), RunLevel과 동작도 (DS-1)
 * - 작업 인자를 Node처럼 나누기(S9-22 DS-2): 정한 답과, Windows에서는 실제 Node가 같은 명령 줄을 읽은 인자와 견준다
 * 작업은 하나도 등록하지 않는다 (리드 결정 S9-13)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataDirHash } from '../../src/server/admin';
import { jsonLine } from '../../src/server/cli';
import {
  argsHoldTestSession,
  buildTaskXml,
  compareTask,
  parseTaskXml,
  parseTasklistSession,
  parseWhoamiSid,
  readIdentity,
  readRegisteredTask,
  realRunner,
  currentAccountNames,
  sameAccount,
  splitWindowsArgs,
  system32,
  taskArgvProblems,
  taskArguments,
  taskName,
  taskPathProblem,
  taskPortOf,
  taskReadScript,
  taskXmlBytes,
  winQuote,
  type ExecResult,
  type TaskInputs,
  type TaskRunner,
} from '../../src/server/task';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const temp: string[] = [];
afterAll(() => {
  for (const f of temp.reverse()) {
    try {
      if (f.endsWith('.cjs') || f.endsWith('.xml')) unlinkSync(f);
      else rmdirSync(f);
    } catch {
      // 이미 없다
    }
  }
});

/** 띄어쓰기·&·한글·끝의 역슬래시가 든 입력 (Windows 경로에는 <가 올 수 없어 이메일·주소 쪽에 둔다) */
function tricky(over: Partial<TaskInputs> = {}): TaskInputs {
  return {
    dataDir: 'C:\\',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    entry: 'D:\\욱채 & 저장소\\out\\server\\index.mjs',
    appRoot: 'D:\\욱채 & 저장소',
    webDir: 'D:\\욱채 & 저장소\\out\\web\\',
    port: 7330,
    configPath: 'E:\\설정 폴더\\server.json',
    ownerEmail: 'owner+a&b@example.com',
    publicOrigin: 'https://grok-pc.tailnet-x.ts.net',
    workspaceRoot: 'F:\\작업 공간\\',
    sid: SID,
    ...over,
  };
}

describe('이스케이프 (S9-3)', () => {
  it('XML 글은 이스케이프한다 — &·<·>·따옴표, 한글은 그대로. 읽으면 원래 값이다', () => {
    const i = tricky({ dataDir: 'C:\\데이터 <a> & "b" \'c\'' });
    const xml = buildTaskXml(i);
    expect(xml).toContain('<Description>욱채 서버 — C:\\데이터 &lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;</Description>');
    // 글 안에 날것의 & · < 가 없다 (요소의 <와 이스케이프만)
    const texts = [...xml.matchAll(/>([^<]*)</g)].map((m) => m[1]!);
    for (const t of texts) expect([t, /&(?!amp;|lt;|gt;|quot;|apos;)/.test(t)]).toEqual([t, false]);
    const f = parseTaskXml(xml);
    expect(f.arguments).toBe(taskArguments(i));
    expect(f.command).toBe(i.nodePath);
    expect(f.workingDirectory).toBe(i.appRoot);
  });

  it('인자: 경로마다 큰따옴표, 닫는 따옴표 앞의 역슬래시는 두 배 — 실제 Node가 그 명령 줄을 같은 값으로 읽는다', () => {
    expect(winQuote('C:\\')).toBe('"C:\\\\"');
    expect(winQuote('D:\\a b\\웹\\\\')).toBe('"D:\\a b\\웹\\\\\\\\"');
    expect(winQuote('D:\\a\\b')).toBe('"D:\\a\\b"');
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-taskargs-한글 & '));
    const entry = join(dir, 'echo.cjs');
    writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    temp.push(dir, entry);
    const i = tricky({ entry });
    // 작업 스케줄러처럼 `"<Command>" <Arguments>` — 인자를 손대지 않고 넘긴다
    const r = spawnSync(process.execPath, [taskArguments(i)], { windowsVerbatimArguments: true, argv0: `"${process.execPath}"`, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect([r.status, JSON.parse(r.stdout) as string[]]).toEqual([
      0,
      ['serve', '--data-dir', 'C:\\', '--web-dir', i.webDir, '--port', '7330', '--config', i.configPath, '--owner-email', i.ownerEmail, '--public-origin', i.publicOrigin, '--workspace-root', i.workspaceRoot],
    ]);
  });

  it('없는 옵션은 넣지 않는다 — 진입점·serve·--data-dir만', () => {
    const i: TaskInputs = { dataDir: 'C:\\data', nodePath: 'node.exe', entry: 'C:\\app\\out\\server\\index.mjs', appRoot: 'C:\\app', webDir: null, sid: SID };
    expect(taskArguments(i)).toBe('"C:\\app\\out\\server\\index.mjs" serve --data-dir "C:\\data"');
  });

  it('"·%·제어 문자가 든 값은 받지 않는다 — 어느 칸이든 (작업 스케줄러가 %…%를 펼친다)', () => {
    const base = tricky();
    expect(taskPathProblem(base)).toBeNull();
    const fields: (keyof TaskInputs)[] = ['nodePath', 'entry', 'appRoot', 'dataDir', 'webDir', 'configPath', 'workspaceRoot', 'ownerEmail', 'publicOrigin'];
    for (const field of fields) {
      for (const bad of ['%USERPROFILE%', 'a"b', 'a\nb']) {
        const msg = taskPathProblem({ ...base, [field]: `C:\\x${bad}` });
        expect([field, bad, msg?.includes('퍼센트(%)')]).toEqual([field, bad, true]);
      }
    }
  });
});

describe('UTF-16과 BOM (S9-3)', () => {
  it('BOM(FF FE) 뒤 UTF-16LE — 머리는 encoding="UTF-16"', () => {
    const xml = buildTaskXml(tricky());
    const bytes = taskXmlBytes(xml);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe(xml);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">')).toBe(true);
  });
});

describe('S9-3의 칸 모두', () => {
  it('글로: 로그온 트리거(그 SID, 30초 뒤), InteractiveToken·LeastPrivilege, IgnoreNew, 배터리 둘 false, PT0S, Priority 6, 실패하면 1분마다 3번, Actions Context Author', () => {
    const i = tricky();
    const xml = buildTaskXml(i);
    const one = (re: RegExp): string | undefined => re.exec(xml)?.[1];
    expect({
      author: one(/<Author>([^<]*)<\/Author>/),
      trigger: one(/<LogonTrigger><UserId>([^<]*)<\/UserId><Delay>PT30S<\/Delay><\/LogonTrigger>/),
      principal: one(/<Principal id="Author"><UserId>([^<]*)<\/UserId><LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel><\/Principal>/),
      multiple: one(/<MultipleInstancesPolicy>([^<]*)</),
      disallow: one(/<DisallowStartIfOnBatteries>([^<]*)</),
      stop: one(/<StopIfGoingOnBatteries>([^<]*)</),
      limit: one(/<ExecutionTimeLimit>([^<]*)</),
      priority: one(/<Priority>([^<]*)</),
      restart: one(/<RestartOnFailure>(<Interval>PT1M<\/Interval><Count>3<\/Count>)<\/RestartOnFailure>/),
      context: one(/<Actions Context="(Author)"><Exec>/),
      enabled: one(/<Enabled>([^<]*)</),
    }).toEqual({
      author: 'wook-server install-task',
      trigger: SID,
      principal: SID,
      multiple: 'IgnoreNew',
      disallow: 'false',
      stop: 'false',
      limit: 'PT0S',
      priority: '6',
      restart: '<Interval>PT1M</Interval><Count>3</Count>',
      context: 'Author',
      enabled: undefined,
    });
    // 꺼 둔 작업은 realTask 시험만 쓴다
    expect(parseTaskXml(buildTaskXml({ ...i, enabled: false })).enabled).toBe('false');
  });

  it.runIf(process.platform === 'win32')('Windows: 작업 스케줄러가 그 XML을 받고 같은 값으로 읽는다 (COM NewTask에 넣기만 — 등록하지 않는다)', async () => {
    const id = await readIdentity(realRunner);
    expect('sid' in id).toBe(true);
    const sid = (id as { sid: string }).sid;
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-taskxml-'));
    const file = join(dir, 'task.xml');
    temp.push(dir, file);
    // 한글과 949에 없는 글자(é·ü)·UHC 확장 글자(똠) — JSON의 \u 적기로 그대로 돌아온다 (등록한 작업을 다시 읽는 스크립트와 같은 적기, S9-22 DS-4)
    const i = tricky({ sid, dataDir: join(dir, '데이터 & 폴더 José Müller 똠방'), enabled: false });
    writeFileSync(file, taskXmlBytes(buildTaskXml(i)));
    const script = [
      '$x = [IO.File]::ReadAllText($env:WOOK_TASK_XML, [Text.Encoding]::Unicode)',
      '$s = New-Object -ComObject Schedule.Service; $s.Connect(); $d = $s.NewTask(0); $d.XmlText = $x',
      '$t = $d.Triggers.Item(1); $a = $d.Actions.Item(1)',
      '$o = [ordered]@{ priority = $d.Settings.Priority; limit = $d.Settings.ExecutionTimeLimit; disallow = $d.Settings.DisallowStartIfOnBatteries; stop = $d.Settings.StopIfGoingOnBatteries; multiple = $d.Settings.MultipleInstances; enabled = $d.Settings.Enabled; restartInterval = $d.Settings.RestartInterval; restartCount = $d.Settings.RestartCount; logonType = $d.Principal.LogonType; runLevel = $d.Principal.RunLevel; userId = $d.Principal.UserId; triggerType = $t.Type; triggerUser = $t.UserId; delay = $t.Delay; path = $a.Path; args = $a.Arguments; wd = $a.WorkingDirectory; description = $d.RegistrationInfo.Description }',
      "$j = $o | ConvertTo-Json -Compress; [regex]::Replace($j, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })",
    ].join('\n');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'latin1', windowsHide: true, timeout: 60_000, env: { ...process.env, WOOK_TASK_XML: file } });
    const got = JSON.parse(out) as Record<string, unknown>;
    // 작업 스케줄러는 SID로 쓴 UserId를 계정 이름으로 돌려줄 수 있다 — 같은 계정이면 된다 (install-task의 다시 읽기도 그렇게 본다: compareTask)
    for (const k of ['userId', 'triggerUser'] as const) {
      expect([k, sameAccount(String(got[k]), sid, currentAccountNames())]).toEqual([k, true]);
      got[k] = sid;
    }
    expect(got).toEqual({
      priority: 6,
      limit: 'PT0S',
      disallow: false,
      stop: false,
      // TASK_INSTANCES_IGNORE_NEW = 2, TASK_LOGON_INTERACTIVE_TOKEN = 3, TASK_RUNLEVEL_LUA = 0, TASK_TRIGGER_LOGON = 9
      multiple: 2,
      enabled: false,
      restartInterval: 'PT1M',
      restartCount: 3,
      logonType: 3,
      runLevel: 0,
      userId: sid,
      triggerType: 9,
      triggerUser: sid,
      delay: 'PT30S',
      path: i.nodePath,
      args: taskArguments(i),
      wd: i.appRoot,
      description: `욱채 서버 — ${i.dataDir}`,
    });
  }, 120_000);
});

describe('이름·누구로·다시 읽기', () => {
  it('작업 이름은 WookServer-<데이터 폴더 해시 8자> — 관리 채널 파이프 이름과 같은 해시, 대소문자를 가리지 않는다', () => {
    const d = join(tmpdir(), 'wook-test-taskname');
    expect(taskName(d)).toBe(`WookServer-${dataDirHash(d)}`);
    expect(taskName(d)).toMatch(/^WookServer-[0-9a-f]{8}$/);
    expect(taskName(d.toUpperCase())).toBe(taskName(d.toLowerCase()));
    expect(taskName(`${d}-다른`)).not.toBe(taskName(d));
  });

  it('whoami·tasklist의 CSV에서 SID와 세션 번호만 읽는다 (지역화된 세션 이름은 보지 않는다)', () => {
    expect(parseWhoamiSid('"desktop-ab\\pc_09","S-1-5-21-1-2-3-1001"\r\n')).toBe('S-1-5-21-1-2-3-1001');
    expect(parseWhoamiSid('"nt authority\\system","S-1-5-18"\r\n')).toBe('S-1-5-18');
    expect(parseWhoamiSid('정보: 없음')).toBeNull();
    // 세션 이름은 지역화된 글(깨진 바이트)일 수 있다
    expect(parseTasklistSession('"node.exe","4242","\u00bc\u00ad\u00ba\u00f1\u00bd\u00ba","0","45,000 K"\r\n', 4242)).toBe(0);
    expect(parseTasklistSession('"node.exe","4242","Console","1","45,000 K"\r\n', 4242)).toBe(1);
    expect(parseTasklistSession('"node.exe","1","Console","1","45,000 K"\r\n', 4242)).toBeNull();
  });

  it('다시 읽기의 견주기: 모든 글자를 그대로 — 한글·é·ü·똠이 든 같은 작업은 같고, 다른 Command·Arguments·UserId·LogonType·RunLevel·동작은 다르다 (S9-22 DS-1·DS-3·DS-4)', () => {
    const i = tricky({ dataDir: 'C:\\Users\\홍길동 José Müller 똠방\\데이터' });
    const xml = buildTaskXml(i);
    expect(compareTask(i, parseTaskXml(xml))).toEqual([]);
    // 한 글자만 다른 한글 경로도 다르다 (예전의 949 견주기는 ASCII 밖 글자를 빼고 견줘 이것을 놓쳤다)
    expect(compareTask(i, parseTaskXml(xml.replace(/홍길동/g, '김철수')))).toEqual(['Arguments']);
    expect(compareTask(i, parseTaskXml(xml.replace('node.exe', 'node24.exe')))).toEqual(['Command(Node)']);
    expect(compareTask(i, { ...parseTaskXml(xml), logonType: 'Password', userId: 'S-1-5-18' })).toEqual(['UserId', 'LogonType']);
    // 관리자 권한으로 돌게 바뀐 작업, 동작이 둘이거나 Exec가 아닌 작업 (S9-22 DS-1). RunLevel 칸이 없으면 작업 스케줄러의 기본(LeastPrivilege)이다
    expect(compareTask(i, parseTaskXml(xml.replace('<RunLevel>LeastPrivilege</RunLevel>', '<RunLevel>HighestAvailable</RunLevel>')))).toEqual(['RunLevel']);
    expect(compareTask(i, parseTaskXml(xml.replace('<RunLevel>LeastPrivilege</RunLevel>', '')))).toEqual([]);
    expect(compareTask(i, parseTaskXml(xml.replace('</Exec></Actions>', '</Exec><Exec><Command>calc.exe</Command></Exec></Actions>')))).toEqual(['Actions']);
    const com = parseTaskXml(xml.replace(/<Exec>[\s\S]*<\/Exec>/, '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler>'));
    expect([com.actions, com.execs]).toEqual([['ComHandler'], []]);
    // Exec가 아닌 동작 하나뿐이어도 다르다 (확인 검토의 R10)
    expect(compareTask(i, com)).toEqual(['Command(Node)', 'Arguments', 'Actions']);
    // 작업 스케줄러가 SID 대신 계정 이름을 돌려주면 같은 계정 — 다른 계정(한글 이름도)·서비스 계정은 아니다
    const names = ['PC-1\\me', 'me', 'PC-1\\홍길동'];
    expect(compareTask(i, { ...parseTaskXml(xml), userId: 'pc-1\\ME' }, names)).toEqual([]);
    expect(compareTask(i, { ...parseTaskXml(xml), userId: 'PC-1\\홍길동' }, names)).toEqual([]);
    expect(compareTask(i, { ...parseTaskXml(xml), userId: 'PC-1\\김철수' }, names)).toEqual(['UserId']);
    expect(compareTask(i, { ...parseTaskXml(xml), userId: 'PC-1\\other' }, names)).toEqual(['UserId']);
    expect(compareTask(i, { ...parseTaskXml(xml), userId: 'S-1-5-18' }, ['S-1-5-18'])).toEqual(['UserId']);
    expect(compareTask(i, { ...parseTaskXml(xml), arguments: `${taskArguments(i)} --allow-test-session` })).toEqual(['Arguments']);
  });
});

describe('등록된 작업 읽기 — 작업 스케줄러 COM (S9-22 DS-3·DS-4·DF-9)', () => {
  const NAME = 'WookServer-0123abcd';
  const answer = (o: Partial<ExecResult> & { json?: unknown }): TaskRunner => async () => ({ code: 0, stdout: Buffer.from(o.json === undefined ? '' : jsonLine(o.json), 'latin1'), timedOut: false, error: null, ...o });

  it('읽기만 하는 Windows PowerShell 하나: -NoProfile -NonInteractive -EncodedCommand, COM의 Connect·GetFolder·GetTask만, ASCII JSON — 이름 모양이 아니면 스크립트를 만들지 않는다', async () => {
    const script = taskReadScript(NAME);
    expect([...script.matchAll(/\$svc\.(\w+)|\.(GetTask|GetFolder|RegisterTask\w*|DeleteTask|NewTask)\(/g)].map((m) => m[1] ?? m[2])).toEqual(['Connect', 'GetFolder', 'GetTask']);
    expect(script).not.toMatch(/\b(Set|Remove|Register|Unregister|Enable|Disable|Stop|Start|Restart|Rename|Clear|Add)-[A-Z]\w*/);
    expect(script).not.toMatch(/New-Item|schtasks|\[Console\]::OutputEncoding|chcp/i);
    expect(script).toContain(`GetTask('${NAME}')`);
    expect(script).toContain("[regex]::Replace($json, '[^\\x00-\\x7F]'");
    expect(() => taskReadScript("WookServer-0123abcd'); Remove-Item x; ('")).toThrow();
    const calls: { file: string; args: readonly string[] }[] = [];
    await readRegisteredTask(NAME, async (file, args) => (calls.push({ file, args }), { code: 0, stdout: Buffer.from('{"v":1,"found":false}'), timedOut: false, error: null }));
    expect(calls.map((c) => [c.file, ...c.args.slice(0, 3)])).toEqual([['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand']]);
    expect(Buffer.from(calls[0]!.args[3]!, 'base64').toString('utf16le')).toBe(script);
    expect(system32('powershell', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('답: 있으면 그 XML 그대로(\\u로 적힌 한글·é·ü·똠도), 없으면 found false, 오류·끝 코드·시간 초과·JSON 아님은 error — 있는지 모르면 없다고 하지 않는다', async () => {
    const xml = buildTaskXml(tricky({ dataDir: 'C:\\Users\\똠방 José Müller\\데이터' }));
    expect(await readRegisteredTask(NAME, answer({ json: { v: 1, found: true, xml, error: null } }))).toEqual({ found: true, xml });
    expect(await readRegisteredTask(NAME, answer({ json: { v: 1, found: false, xml: null, error: null } }))).toEqual({ found: false });
    expect(await readRegisteredTask(NAME, answer({ json: { v: 1, found: false, xml: null, error: '액세스가 거부되었습니다' } }))).toEqual({ error: '작업 스케줄러: 액세스가 거부되었습니다' });
    expect(await readRegisteredTask(NAME, answer({ code: 1 }))).toEqual({ error: 'Windows PowerShell 끝 코드 1' });
    expect(await readRegisteredTask(NAME, answer({ code: null, timedOut: true }))).toEqual({ error: 'Windows PowerShell 15초 안에 끝나지 않음' });
    expect(await readRegisteredTask(NAME, answer({ code: null, error: 'ENOENT' }))).toEqual({ error: 'Windows PowerShell ENOENT' });
    expect(await readRegisteredTask(NAME, answer({ stdout: Buffer.from('<Task/>') }))).toEqual({ error: '작업을 읽는 PowerShell의 출력이 JSON이 아닙니다' });
    expect(await readRegisteredTask(NAME, answer({ json: { v: 2, found: false } }))).toEqual({ error: '작업을 읽는 PowerShell의 출력 판이 다릅니다' });
  });

  it.runIf(process.platform === 'win32')('Windows: 그 스크립트 그대로 \'찾을 수 없음\'이 아닌 COM 오류는 error다 — Connect를 빼 연결하지 않은 채 읽으면(읽기만) error, found false가 아니다 (S9-24 R2S-6 R11)', async () => {
    const name = taskName(join(tmpdir(), `wook-test-notconnected-${process.pid}`));
    const script = taskReadScript(name);
    // 제품의 스크립트에서 연결 한 줄만 뺀다 — GetFolder가 '연결되지 않음'으로 던진다(작업 스케줄러에 아무것도 하지 않는다)
    const notConnected = script.replace('\n  $svc.Connect()\n', '\n');
    expect(notConnected).not.toBe(script);
    const out = execFileSync(system32('powershell'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(notConnected, 'utf16le').toString('base64')], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const read = await readRegisteredTask(name, async () => ({ code: 0, stdout: out, timedOut: false, error: null }));
    expect(['error' in read, 'error' in read && read.error.startsWith('작업 스케줄러: ')]).toEqual([true, true]);
  }, 60_000);

  it.runIf(process.platform === 'win32')('Windows: 없는 작업을 실제 COM으로 읽으면 found false (읽기만 — 등록하지 않는다)', async () => {
    const name = taskName(join(tmpdir(), `wook-test-nosuchtask-${process.pid}-${Date.now()}`));
    expect(await readRegisteredTask(name, realRunner)).toEqual({ found: false });
  }, 60_000);
});

/**
 * Node가 Windows에서 명령 줄을 나누는 규칙 (S9-22 DS-2): [작업의 Arguments 글, Node가 받는 인자]. Windows에서는 실제 Node가 그 명령 줄을 같은 인자로 읽는지도 본다
 * (작업 스케줄러처럼 `"<node>" <Arguments>`로 띄운다)
 */
const SPLIT_CASES: [string, string[]][] = [
  ['', []],
  ['a b c', ['a', 'b', 'c']],
  ['  a   b  ', ['a', 'b']],
  ['a\tb', ['a', 'b']],
  ['"a b" c', ['a b', 'c']],
  ['"--allow-test-session"', ['--allow-test-session']],
  ['--al"low-test-sess"ion', ['--allow-test-session']],
  ['a"b c"d', ['ab cd']],
  ['\\"a', ['"a']],
  ['a\\\\"b c"', ['a\\b c']],
  ['a\\\\\\"b', ['a\\"b']],
  ['a\\\\\\\\"b c"', ['a\\\\b c']],
  ['a\\\\b c\\', ['a\\\\b', 'c\\']],
  ['""', ['']],
  ['a "" b', ['a', '', 'b']],
  ['"a""b"', ['a"b']],
  ['""""', ['"']],
  ['"C:\\\\"', ['C:\\']],
  ['"C:\\" x', ['C:" x']],
  ['"a b', ['a b']],
  ['"a"b"c d"', ['abc d']],
  ['"D:\\욱채 & 저장소\\out\\web\\\\" --port 7330', ['D:\\욱채 & 저장소\\out\\web\\', '--port', '7330']],
  // 빈칸·탭만 나눈다 — 유니코드 빈칸(전각 U+3000, NBSP)은 인자의 글자다 (확인 검토의 R2)
  ['a\u3000b c', ['a\u3000b', 'c']],
  ['a\u00a0b\u2003c', ['a\u00a0b\u2003c']],
];

describe('작업 인자를 Node처럼 나누기 — splitWindowsArgs (S9-22 DS-2)', () => {
  it('따옴표·\\"·따옴표 앞 역슬래시 줄·빈 인자·따옴표 안의 "" — 정한 답과 같다', () => {
    for (const [line, want] of SPLIT_CASES) expect([line, splitWindowsArgs(line)]).toEqual([line, want]);
  });

  it.runIf(process.platform === 'win32')('Windows: 실제 Node가 같은 명령 줄을 같은 인자로 읽는다 (경우마다 node를 한 번 띄운다)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-splitargs-'));
    const script = join(dir, 'argv.cjs');
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    temp.push(dir, script);
    for (const [line] of SPLIT_CASES) {
      const r = spawnSync(process.execPath, [`"${script}" ${line}`], { windowsVerbatimArguments: true, argv0: `"${process.execPath}"`, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      expect([line, r.status, JSON.parse(r.stdout) as string[]]).toEqual([line, 0, splitWindowsArgs(line)]);
    }
  }, 120_000);

  it('taskArgvProblems: install-task가 쓴 인자는 문제 없음, 따옴표로 감싼 --allow-test-session·--allow-test-session=…은 시험용 세션, 그 밖에 다른 것은 문제 — 옵션은 옮길 수 있게 돌려준다', () => {
    const i = tricky();
    const want = { entry: i.entry, dataDir: i.dataDir };
    const ok = taskArgvProblems(taskArguments(i), want);
    expect([ok.testSession, ok.problems]).toEqual([false, []]);
    expect(ok.options).toEqual([
      ['--web-dir', i.webDir],
      ['--port', '7330'],
      ['--config', i.configPath],
      ['--owner-email', i.ownerEmail],
      ['--public-origin', i.publicOrigin],
      ['--workspace-root', i.workspaceRoot],
    ]);
    // 진입점·데이터 폴더는 대소문자를 가리지 않는다
    expect(taskArgvProblems(taskArguments(i).toUpperCase().replace(' SERVE ', ' serve ').replace(/--([A-Z-]+)/g, (m) => m.toLowerCase()), want).problems).toEqual([]);
    for (const extra of [' --allow-test-session', ' "--allow-test-session"', ' --allow-test-session=true', ' "--allow-test-session=1"']) {
      const v = taskArgvProblems(`${taskArguments(i)}${extra}`, want);
      expect([extra, v.testSession, v.problems]).toEqual([extra, true, []]);
    }
    const cases: [string, string][] = [
      [`${taskArguments(i)} --bind ::1`, 'install-task가 쓰지 않는 인자가 있습니다 (--bind (이름 없는 인자))'],
      [`${taskArguments(i)} --config=x.json`, 'install-task가 쓰지 않는 인자가 있습니다 (--config=…)'],
      [`${taskArguments(i)} --port 7331`, 'install-task가 쓰지 않는 인자가 있습니다 (--port (이름 없는 인자))'],
      [`${taskArguments(i)} --owner-email`, 'install-task가 쓰지 않는 인자가 있습니다 (--owner-email)'],
      [taskArguments({ ...i, entry: 'E:\\old\\out\\server\\index.mjs' }), '서버 진입점이 지금 것과 다릅니다 (E:\\old\\out\\server\\index.mjs)'],
      [taskArguments({ ...i, dataDir: 'D:\\다른 데이터' }), '데이터 폴더가 지금 것과 다릅니다 (D:\\다른 데이터)'],
      [taskArguments(i).replace(' serve ', ' status '), 'serve로 띄우지 않습니다'],
    ];
    for (const [args, problem] of cases) expect([args, taskArgvProblems(args, want).problems]).toEqual([args, [problem]]);
    // '-'로 시작하는 값은 Node의 parseArgs가 받지 않는다 — 서버가 뜨지 않으므로 install-task가 쓰는 꼴이 아니다 (확인 검토의 노트 2)
    const { configPath: _c, ...noConfig } = i;
    for (const v of ['-x', '-']) {
      expect([v, taskArgvProblems(`${taskArguments(noConfig)} --config ${v}`, want).problems]).toEqual([v, ['install-task가 쓰지 않는 인자가 있습니다 (--config (이름 없는 인자))']]);
    }
    // 동작마다의 인자 — 시험용 세션이 어느 꼴로든 있는지 (S9-24 R2S-3)
    for (const [args, held] of [
      ['"x" serve --data-dir "d" --port 7318 --allow-test-session', true],
      ['"x" serve --data-dir "d" "--allow-test-session=1"', true],
      ['"x" serve --data-dir "d" --port 7318', false],
      [null, false],
    ] as const) {
      expect([args, argsHoldTestSession(args)]).toEqual([args, held]);
    }
    // XML의 Exec 동작 모두 — 둘째의 인자도 읽는다
    const two = parseTaskXml(buildTaskXml(i).replace('</Exec></Actions>', '</Exec><Exec><Command>C:\\n\\node.exe</Command><Arguments>"e" serve --allow-test-session</Arguments></Exec></Actions>'));
    expect(two.execs.map((e) => [e.command, e.arguments])).toEqual([
      [i.nodePath, taskArguments(i)],
      ['C:\\n\\node.exe', '"e" serve --allow-test-session'],
    ]);
    expect([two.command, two.arguments]).toEqual([i.nodePath, taskArguments(i)]);
    expect(taskPortOf(taskArguments(i))).toBe(7330);
    expect(taskPortOf('"x" serve --data-dir "d" "--port" "7340"')).toBe(7340);
    expect(taskPortOf('"x" serve --data-dir "d" --port=7341')).toBe(7341);
    expect(taskPortOf('"x" serve --data-dir "d"')).toBeNull();
  });
});
