/**
 * deployCheck (리드 결정 S9-4·S9-11): `wook-server check`와 서버의 시작 뒤 한 번의 점검.
 * - 항목마다 사실(점검 JSON·CLI·서버)의 모양 하나씩 → 수준·글·고칠 길 (S9-4의 표). 실패가 있으면 끝 코드 1
 * - 점검 스크립트는 DefaultPassword의 값을 읽지 않는다(이름만) — 그리고 읽기만 한다. 점검이 낸 모르는 칸(값처럼 보이는 것)은 어느 글에도 옮기지 않는다
 * - powercfg는 지역화된 글이 아니라 16진 색인으로 읽는다 (이 PC의 한국어 출력 그대로)
 * - 서버의 시작 뒤 한 번: 시험(VITEST) 중에는 돌지 않고, 한 번만 돌고, 준비를 늦추지 않는다 — 빌드한 서버를 VITEST 없이 띄우되 점검과 CLI는 미리 불러오기
 *   (fakeProbePreload.cjs)가 가짜로 답한다. 점검이 답하지 않는 동안 준비 줄이 나오고 status의 deploy는 null, 답한 뒤에야 deploy가 찬다
 * - 9단계 고침(리드 결정 S9-22): 작업의 RunLevel·동작(DS-1), Node처럼 나눈 인자(DS-2), 데이터 폴더 권한 항목(DS-5), 고칠 길의 --data-dir(DF-1), 화면 보호기를
 *   고른 때만 잠금 경고(DF-10), Utf8Out의 4초 상한(DF-8)
 * 실제 점검 스크립트 전체는 여기서 돌리지 않는다 (리드 결정 S9-13 — 레인이 한 번 손으로 돌려 봤다). Windows에서는 그 조각 둘(Utf8Out, 데이터 폴더 권한 읽기)만
 * 시험이 만든 임시 폴더·자식으로 돌린다 — 읽기만 한다
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { jsonLine, deployText } from '../../src/server/cli';
import { adminPipeFallbackWarning } from '../../src/server/adminPipe';
import { restrictToCurrentUser } from '../../src/server/dataDir';
import {
  deployItems,
  deploySummary,
  formatCheck,
  parseProbeOutput,
  powercfgAcDc,
  powershellPath,
  wookServerCommand,
  type CommandWord,
  PROBE_TIMEOUT_MS,
  PROBE_VALUE_NAMES,
  probeArgs,
  probeScript,
  readTailscale,
  runCheck,
  runProbe,
  startDeployCheck,
  type CheckCommandDeps,
  type DeployFacts,
  type DeployItem,
  type DeployReport,
  type ProbeData,
  type ProbeExec,
} from '../../src/server/deployCheck';
import { buildTaskXml, type TaskInputs } from '../../src/server/task';
import type { AdminStatus } from '../../src/server/server';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { createHarness } from '../e2e/harness';
import { pidAlive } from '../setup/runTemp';
import { buildServerTo, clientJson, removeDir, REPO, runClient, sleep, startBuilt, testBuildDir, workspaceArgs, type BuiltServer } from './helpers';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
/** 늦춘 시험 (리드 결정 S9-18 — 한 번): 가짜 점검·CLI·서버·시작 뒤 점검이 이만큼 늦게 답한다. 빌드한 서버 쪽은 WOOK_TEST_PAUSE_MS */
const DELAY = Number(process.env['WOOK_TEST_FAKE_DELAY_MS'] ?? '0');
const later = (): Promise<void> => (DELAY ? new Promise((r) => setTimeout(r, DELAY)) : Promise.resolve());
const DATA = 'D:\\욱채 데이터';
const APP = 'C:\\WOOK\\wookagent';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const ENTRY = `${APP}\\out\\server\\index.mjs`;
const DNS = 'marker-dns-7f3a.tailnet-test.ts.net';

/** 이 PC(한국어 Windows)의 powercfg /qh 출력 — 글은 지역화돼 있고 색인은 16진이다 */
const ko = (alias: string, ac: number, dc: number, range = true): string =>
  [
    '전원 구성표 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (균형 조정)',
    '  GUID 별칭: SCHEME_BALANCED',
    `      GUID 별칭: ${alias}`,
    ...(range ? ['      가능한 최소 설정: 0x00000000', '      가능한 최대 설정: 0xffffffff', '      가능한 설정 증가: 0x00000001', '      가능한 설정 단위: 초'] : ['      가능한 설정 색인: 000', '      가능한 설정 이름: 아니요', '      가능한 설정 색인: 001', '      가능한 설정 이름: 예']),
    `    현재 AC 전원 설정 색인: 0x${ac.toString(16).padStart(8, '0')}`,
    `    현재 DC 전원 설정 색인: 0x${dc.toString(16).padStart(8, '0')}`,
  ].join('\n');

const taskInputs: TaskInputs = { dataDir: DATA, nodePath: NODE, entry: ENTRY, appRoot: APP, webDir: `${APP}\\out\\web`, sid: SID };
const tsStatus = (o: { state?: string; cert?: string[] | null } = {}) =>
  JSON.stringify({ BackendState: o.state ?? 'Running', CertDomains: o.cert === undefined ? [DNS] : o.cert, Self: { DNSName: `${DNS}.` } });
const tsServe = (o: { proxy?: string; extra?: Record<string, unknown>; funnel?: boolean } = {}) =>
  JSON.stringify({
    TCP: { '443': { HTTPS: true }, ...(o.extra ?? {}) },
    Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: o.proxy ?? 'http://127.0.0.1:7317' } } } },
    ...(o.funnel ? { AllowFunnel: { [`${DNS}:443`]: true } } : {}),
  });

function goodProbe(): ProbeData {
  return {
    sessionId: 1,
    sessionName: 'Console',
    user: { name: 'pc_09', domain: 'DESKTOP-X', sid: SID },
    winlogon: { autoAdminLogon: '1', defaultUserName: 'pc_09', defaultDomainName: 'DESKTOP-X', hasDefaultPassword: false },
    screenSaver: { active: '0', secure: '0', saver: null, policyActive: null, policySecure: null, policySaver: null },
    dynamicLock: null,
    inactivityTimeoutSecs: null,
    powercfg: { consoleLock: ko('CONSOLELOCK', 0, 1, false), standby: ko('STANDBYIDLE', 0, 900), hibernate: ko('HIBERNATEIDLE', 0, 0) },
    task: { found: true, xml: buildTaskXml(taskInputs), error: null },
    // 프로필 아래에 손으로 만든 폴더의 흔한 모양 — 이 사용자·SYSTEM·Administrators, 상속 전용 CREATOR OWNER
    dataDir: {
      found: true,
      protected: false,
      rules: [
        { sid: SID, name: 'DESKTOP-X\\pc_09', type: 'Allow', inheritOnly: false },
        { sid: 'S-1-5-18', name: 'NT AUTHORITY\\SYSTEM', type: 'Allow', inheritOnly: false },
        { sid: 'S-1-5-32-544', name: 'BUILTIN\\Administrators', type: 'Allow', inheritOnly: false },
        { sid: 'S-1-3-0', name: 'CREATOR OWNER', type: 'Allow', inheritOnly: true },
      ],
      error: null,
    },
    lanman: 'Running',
    smbBlockRules: 1,
    tailscale: { found: true, status: tsStatus(), serve: tsServe() },
    envNames: { user: ['Path', 'TEMP', 'CLAUDE_CODE_OAUTH_TOKEN'], machine: ['Path', 'windir'] },
  };
}

function goodFacts(): DeployFacts {
  return {
    nodeVersion: '24.13.0',
    probe: goodProbe(),
    expectedTask: { name: 'WookServer-0123abcd', nodePath: NODE, entry: ENTRY, dataDir: DATA },
    cli: { claude: { found: true, path: 'C:\\cli\\claude.exe', loggedIn: true, detail: 'claude.ai' }, codex: { found: true, path: 'C:\\cli\\codex.exe', loggedIn: true, detail: 'ChatGPT' } },
    apiKeys: { claude: { registered: false, authMode: 'subscription' }, codex: { registered: false, authMode: 'subscription' } },
    processEnvNames: ['PATH', 'TEMP'],
    server: { adminPipe: { mode: 'helper', rejectsRemote: true, userOnlyAcl: true, reason: null }, screen: { ok: true, detail: '화면 조작을 쓸 수 있습니다' }, port: 7317 },
    screenEnabled: null,
  };
}

const byId = (items: DeployItem[], id: DeployItem['id']): DeployItem => items.find((i) => i.id === id)!;
const withProbe = (f: (p: ProbeData) => void) => (facts: DeployFacts) => f(facts.probe as ProbeData);
/**
 * 고칠 길의 붙여 넣을 줄 (S9-24 R2S-5 — 확인 검토의 줄들): 보통의 폴더와 그 줄의 따옴표 꼴. Windows에서는 PowerShell 5.1과 cmd에 그대로 붙여 넣어 Node가 같은
 * 폴더를 받는지도 본다. 드라이브 뿌리는 닫는 따옴표 앞 역슬래시를 두 배로(확인 검토의 R17)
 */
const SAFE_FIX_DIRS: [string, string][] = [
  ['C:\\Users\\홍 길동\\wook data', '"C:\\Users\\홍 길동\\wook data"'],
  ["C:\\Users\\owner\\it's mine", '"C:\\Users\\owner\\it\'s mine"'],
  ["C:\\Users\\owner\\it's", '"C:\\Users\\owner\\it\'s"'],
  ['C:\\', '"C:\\\\"'],
  ['D:\\', '"D:\\\\"'],
  ['C:\\Users\\owner\\a(b)', '"C:\\Users\\owner\\a(b)"'],
];
/** 셸이 바꾸는 글자가 든 폴더 — 붙여 넣을 줄을 내지 않는다 (확인 검토가 PowerShell 5.1에서 다른 폴더로 간 것을 본 줄들과 그 밖의 글자) */
const UNSAFE_FIX_DIRS: string[] = [
  'C:\\Users\\owner\\a$HOME b',
  'C:\\Users\\owner\\R&D',
  'C:\\Users\\owner\\R&D x',
  'C:\\Users\\owner\\a\u201cb c',
  'C:\\Users\\owner\\a\u2018b',
  'C:\\Users\\owner\\a`b',
  'C:\\Users\\owner\\a^b',
  'C:\\Users\\owner\\50%',
  'C:\\Users\\owner\\wow!',
];

/** 화면 보호기 값이 하나도 없는 바탕 */
const ss: ProbeData['screenSaver'] = { active: null, secure: null, saver: null, policyActive: null, policySecure: null, policySaver: null };

describe('powercfg는 16진 색인으로 읽는다 (S9-4 verify)', () => {
  it('한국어 출력의 마지막 두 0x 값이 AC·DC — 범위 설정의 가능한 값 줄은 앞에 있다. 숨은 설정이 /query에 안 나와 색인이 없으면 null', () => {
    expect(powercfgAcDc(ko('STANDBYIDLE', 0, 900))).toEqual({ ac: 0, dc: 900 });
    expect(powercfgAcDc(ko('CONSOLELOCK', 1, 1, false))).toEqual({ ac: 1, dc: 1 });
    expect(powercfgAcDc('Power Setting GUID: x\n  Minimum Possible Setting: 0x00000000\n  Current AC Power Setting Index: 0x00000708\n  Current DC Power Setting Index: 0x0000012c')).toEqual({ ac: 1800, dc: 300 });
    // /query로 숨은 CONSOLELOCK을 물으면 머리만 나온다 — 그래서 점검은 /qh를 쓴다
    expect(powercfgAcDc('전원 구성표 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (균형 조정)\n  GUID 별칭: SCHEME_BALANCED')).toBeNull();
    expect(powercfgAcDc(null)).toBeNull();
    expect(probeScript('WookServer-0123abcd', DATA)).toContain('powercfg /qh SCHEME_CURRENT SUB_NONE CONSOLELOCK');
  });
});

describe('항목마다 (S9-4의 표)', () => {
  it('모두 맞으면 모두 통과 — 차례는 점검의 표 그대로', () => {
    const items = deployItems(goodFacts());
    expect(items.map((i) => [i.id, i.level, i.fix])).toEqual(
      ['session', 'autologon', 'lock', 'sleep', 'task', 'dataDir', 'node', 'cli.claude', 'cli.codex', 'apikey-env', 'screen', 'smb', 'tailscale'].map((id) => [id, 'ok', null]),
    );
    expect(byId(items, 'tailscale').text).toBe(`https://${DNS} → 127.0.0.1:7317`);
  });

  type Case = [string, (f: DeployFacts) => void, DeployItem['id'], DeployItem['level'], string, string | null];
  const cases: Case[] = [
    ['세션 0', withProbe((p) => (p.sessionId = 0)), 'session', 'fail', '세션 0(서비스)', 'install-task'],
    ['RDP', withProbe((p) => (p.sessionName = 'RDP-Tcp#3')), 'session', 'warn', '원격 데스크톱(RDP)', 'tscon ((Get-Process -Id $PID).SessionId) /dest:console'],
    ['자동 로그온 꺼짐', withProbe((p) => (p.winlogon.autoAdminLogon = '0')), 'autologon', 'warn', '자동 로그온이 꺼져 있습니다', 'Sysinternals Autologon'],
    ['다른 계정의 자동 로그온', withProbe((p) => (p.winlogon.defaultUserName = 'other')), 'autologon', 'warn', '이 사용자가 아닙니다 (other)', 'Autologon'],
    ['DefaultPassword가 있음', withProbe((p) => (p.winlogon.hasDefaultPassword = true)), 'autologon', 'warn', 'DefaultPassword 값이 있습니다', 'DefaultPassword 값을 지우세요'],
    ['암호 화면 보호기', withProbe((p) => (p.screenSaver = { ...ss, active: '1', secure: '1', saver: 'C:\\Windows\\system32\\scrnsave.scr' })), 'lock', 'warn', '화면 보호기가 암호로 잠급니다', '화면 보호기'],
    // 화면 보호기를 '없음'으로 되돌려도 Windows는 켜짐·암호 두 값을 1로 둘 수 있다 — 고른 화면 보호기가 없으면 아무것도 잠그지 않는다 (S9-22 DF-10)
    ['화면 보호기 없음(값만 1)', withProbe((p) => (p.screenSaver = { ...ss, active: '1', secure: '1', saver: null })), 'lock', 'ok', '스스로 잠그지 않습니다', null],
    ['화면 보호기 빈 이름', withProbe((p) => (p.screenSaver = { ...ss, active: '1', secure: '1', saver: '' })), 'lock', 'ok', '스스로 잠그지 않습니다', null],
    ['정책 화면 보호기', withProbe((p) => (p.screenSaver = { ...ss, active: '0', secure: '0', policyActive: '1', policySecure: '1', policySaver: 'scrnsave.scr' })), 'lock', 'warn', '(정책)', '그룹 정책'],
    ['정책 암호·사용자 화면 보호기', withProbe((p) => (p.screenSaver = { ...ss, active: '1', saver: 'ssText3d.scr', policySecure: '1' })), 'lock', 'warn', '(정책)', '그룹 정책'],
    ['정책 암호뿐(화면 보호기 없음)', withProbe((p) => (p.screenSaver = { ...ss, policyActive: '1', policySecure: '1' })), 'lock', 'ok', '스스로 잠그지 않습니다', null],
    ['정책이 화면 보호기를 끔', withProbe((p) => (p.screenSaver = { ...ss, active: '1', secure: '1', saver: 'scrnsave.scr', policyActive: '0' })), 'lock', 'ok', '스스로 잠그지 않습니다', null],
    ['CONSOLELOCK', withProbe((p) => (p.powercfg.consoleLock = ko('CONSOLELOCK', 1, 1, false))), 'lock', 'warn', 'CONSOLELOCK', 'powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 그다음 powercfg /setactive SCHEME_CURRENT'],
    ['InactivityTimeoutSecs', withProbe((p) => (p.inactivityTimeoutSecs = '900')), 'lock', 'warn', '비활성 15분 뒤 잠급니다', '비활성 한도'],
    ['동적 잠금', withProbe((p) => (p.dynamicLock = '1')), 'lock', 'warn', '동적 잠금', '동적 잠금을 끄세요'],
    ['절전', withProbe((p) => (p.powercfg.standby = ko('STANDBYIDLE', 1800, 900))), 'sleep', 'warn', '30분 쉬면 절전에 듭니다', 'powercfg /change standby-timeout-ac 0'],
    ['최대 절전', withProbe((p) => (p.powercfg.hibernate = ko('HIBERNATEIDLE', 10800, 0))), 'sleep', 'warn', '180분 쉬면 최대 절전', 'powercfg /change hibernate-timeout-ac 0'],
    ['절전을 읽지 못함', withProbe((p) => (p.powercfg = { consoleLock: null, standby: null, hibernate: null })), 'sleep', 'skip', '읽지 못했습니다', null],
    ['작업 없음', withProbe((p) => (p.task = { found: false, xml: null, error: null })), 'task', 'warn', '등록된 작업이 없습니다 (WookServer-0123abcd)', `wook-server install-task --data-dir "${DATA}"`],
    ['작업을 읽지 못함', withProbe((p) => (p.task = { found: false, xml: null, error: '액세스 거부' })), 'task', 'skip', '읽지 못했습니다 (액세스 거부)', null],
    ['서비스 계정 작업', withProbe((p) => (p.task.xml = buildTaskXml({ ...taskInputs, sid: 'S-1-5-18' }))), 'task', 'fail', '서비스 계정으로 돕니다', '다시 등록하세요 (같은 이름을 바꿔 넣습니다): wook-server install-task'],
    ['다른 계정 작업', withProbe((p) => (p.task.xml = buildTaskXml({ ...taskInputs, sid: 'S-1-5-21-9-9-9-1002' }))), 'task', 'fail', '다른 계정으로 돕니다', 'install-task'],
    ['LogonType Password', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('InteractiveToken', 'Password'))), 'task', 'fail', "'사용자가 로그온한 경우에만 실행'이 아닙니다", 'install-task'],
    // 관리자 권한(가장 높은 수준)으로 돌게 바뀐 작업 — 서버·AI가 모두 관리자 토큰을 가진다 (S9-22 DS-1)
    ['RunLevel HighestAvailable', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('<RunLevel>LeastPrivilege</RunLevel>', '<RunLevel>HighestAvailable</RunLevel>'))), 'task', 'fail', '관리자 권한(가장 높은 수준)으로 돕니다 (RunLevel HighestAvailable)', 'install-task'],
    ['RunLevel 칸 없음(기본)', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('<RunLevel>LeastPrivilege</RunLevel>', ''))), 'task', 'ok', '로그온할 때 이 사용자로', null],
    ['동작 둘', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Exec></Actions>', '</Exec><Exec><Command>C:\\x\\other.exe</Command></Exec></Actions>'))), 'task', 'warn', '동작이 2개입니다 (Exec, Exec)', 'install-task'],
    ['Exec 아닌 동작', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace(/<Exec>[\s\S]*<\/Exec>/, '<ShowMessage><Title>t</Title><Body>b</Body></ShowMessage>'))), 'task', 'warn', '프로그램 실행(Exec) 동작이 아닙니다 (ShowMessage)', 'install-task'],
    ['시험용 세션 작업', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Arguments>', ' --allow-test-session</Arguments>'))), 'task', 'fail', '--allow-test-session', 'install-task'],
    // Node는 따옴표를 떼고 읽는다 — "--allow-test-session"도 그 옵션이다, =값을 붙여도 (S9-22 DS-2)
    ['따옴표 친 시험용 세션', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Arguments>', ' &quot;--allow-test-session&quot;</Arguments>'))), 'task', 'fail', '--allow-test-session으로 띄웁니다', 'install-task'],
    ['--allow-test-session=값', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Arguments>', ' --allow-test-session=true</Arguments>'))), 'task', 'fail', '--allow-test-session으로 띄웁니다', 'install-task'],
    ['install-task가 쓰지 않는 인자', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Arguments>', ' --bind ::1 --web-dir C:\\x</Arguments>'))), 'task', 'warn', 'install-task가 쓰지 않는 인자가 있습니다 (--bind (이름 없는 인자) --web-dir (이름 없는 인자))', 'install-task'],
    ['다른 Node', withProbe((p) => (p.task.xml = buildTaskXml({ ...taskInputs, nodePath: 'C:\\nvm\\node.exe' }))), 'task', 'warn', 'Node가 지금 것과 다릅니다 (C:\\nvm\\node.exe)', 'install-task'],
    ['다른 저장소', withProbe((p) => (p.task.xml = buildTaskXml({ ...taskInputs, entry: 'E:\\old\\out\\server\\index.mjs' }))), 'task', 'warn', '서버 진입점이 지금 것과 다릅니다 (E:\\old\\out\\server\\index.mjs)', 'install-task'],
    ['다른 데이터 폴더', withProbe((p) => (p.task.xml = buildTaskXml({ ...taskInputs, dataDir: 'D:\\다른 폴더' }))), 'task', 'warn', '데이터 폴더가 지금 것과 다릅니다 (D:\\다른 폴더)', 'install-task'],
    // %…%는 작업 스케줄러가 펼친다 — 펼친 값이 무엇을 싣는지 check는 모른다: 자리를 말하는 경고 (S9-24 R2S-2)
    ['Arguments의 %', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Arguments>', ' --config %WOOK_CFG%</Arguments>'))), 'task', 'warn', '작업의 Arguments에 %가 있습니다', 'install-task'],
    ['Command의 %', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace(/<Command>[^<]*<\/Command>/, '<Command>%ProgramFiles%\\nodejs\\node.exe</Command>'))), 'task', 'warn', '작업의 Command에 %가 있습니다', 'install-task'],
    ['WorkingDirectory의 %', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace(/<WorkingDirectory>[^<]*<\/WorkingDirectory>/, '<WorkingDirectory>%USERPROFILE%</WorkingDirectory>'))), 'task', 'warn', '작업의 WorkingDirectory에 %가 있습니다', 'install-task'],
    // 둘째 Exec 동작이 시험용 세션으로 서버를 하나 더 띄운다 — 실패 (동작이 둘이라는 경고도 남는다, S9-24 R2S-3)
    [
      '둘째 동작의 시험용 세션',
      withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Exec></Actions>', `</Exec><Exec><Command>${NODE}</Command><Arguments>"${ENTRY}" serve --data-dir "${DATA}" --port 7318 --allow-test-session</Arguments></Exec></Actions>`))),
      'task',
      'fail',
      '--allow-test-session으로 띄웁니다 (2번째 동작) — 시험용 세션 발급이 켜집니다 · 동작이 2개입니다 (Exec, Exec)',
      'install-task',
    ],
    // '-'로 시작하는 값 — Node의 parseArgs가 받지 않아 서버가 뜨지 않는다 (확인 검토의 노트 2)
    ['-로 시작하는 값', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('</Arguments>', ' --config -x</Arguments>'))), 'task', 'warn', 'install-task가 쓰지 않는 인자가 있습니다 (--config (이름 없는 인자))', 'install-task'],
    ['72시간 상한', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('PT0S', 'PT72H'))), 'task', 'warn', '실행 시간 상한이 있습니다 (PT72H)', 'install-task'],
    ['배터리', withProbe((p) => (p.task.xml = buildTaskXml(taskInputs).replace('<StopIfGoingOnBatteries>false', '<StopIfGoingOnBatteries>true'))), 'task', 'warn', '배터리로 돌 때', 'install-task'],
    ['꺼 둔 작업', withProbe((p) => (p.task.xml = buildTaskXml({ ...taskInputs, enabled: false }))), 'task', 'warn', '작업이 꺼져 있습니다', 'install-task'],
    // 데이터 폴더를 다른 계정도 열 수 있다 (S9-22 DS-5) — 이 PC의 CodexSandboxUsers 같은 상속 ACE. 견주기는 SID로
    ['데이터 폴더를 다른 계정도', withProbe((p) => p.dataDir.rules.push({ sid: 'S-1-5-21-3131009607-1-2-1003', name: 'DESKTOP-X\\CodexSandboxUsers', type: 'Allow', inheritOnly: false })), 'dataDir', 'warn', '다른 계정도 데이터 폴더를 열 수 있습니다 (DESKTOP-X\\CodexSandboxUsers)', `icacls "${DATA}" /inheritance:r /grant:r "DESKTOP-X\\pc_09:(OI)(CI)F"`],
    // Everyone·Authenticated Users도 이 사용자 밖이다 — D:\ 아래 폴더가 물려받는 흔한 꼴 (확인 검토의 R7)
    ['Everyone', withProbe((p) => p.dataDir.rules.push({ sid: 'S-1-1-0', name: 'Everyone', type: 'Allow', inheritOnly: false })), 'dataDir', 'warn', '(Everyone)', 'icacls'],
    ['Authenticated Users', withProbe((p) => p.dataDir.rules.push({ sid: 'S-1-5-11', name: 'NT AUTHORITY\\Authenticated Users', type: 'Allow', inheritOnly: false })), 'dataDir', 'warn', '(NT AUTHORITY\\Authenticated Users)', 'icacls'],
    ['상속 전용 Users(속 파일에 간다)', withProbe((p) => p.dataDir.rules.push({ sid: 'S-1-5-32-545', name: null, type: 'Allow', inheritOnly: true })), 'dataDir', 'warn', '(S-1-5-32-545)', 'icacls'],
    ['상속 전용 아닌 CREATOR OWNER', withProbe((p) => p.dataDir.rules.push({ sid: 'S-1-3-0', name: 'CREATOR OWNER', type: 'Allow', inheritOnly: false })), 'dataDir', 'warn', '(CREATOR OWNER)', 'icacls'],
    ['다른 계정의 거부 규칙만', withProbe((p) => p.dataDir.rules.push({ sid: 'S-1-1-0', name: 'Everyone', type: 'Deny', inheritOnly: false })), 'dataDir', 'ok', '이 사용자·SYSTEM·Administrators만 열 수 있습니다', null],
    ['이 사용자만(서버가 만든 폴더)', withProbe((p) => (p.dataDir = { found: true, protected: true, rules: [{ sid: SID, name: null, type: 'Allow', inheritOnly: false }], error: null })), 'dataDir', 'ok', `${DATA} — 이 사용자·SYSTEM·Administrators만`, null],
    ['데이터 폴더 없음', withProbe((p) => (p.dataDir = { found: false, protected: null, rules: [], error: null })), 'dataDir', 'skip', '데이터 폴더가 아직 없습니다', null],
    ['데이터 폴더 권한을 읽지 못함', withProbe((p) => (p.dataDir = { found: true, protected: null, rules: [], error: '액세스 거부' })), 'dataDir', 'skip', '권한을 읽지 못했습니다 (액세스 거부)', null],
    ['Node 22', (f) => (f.nodeVersion = '22.11.0'), 'node', 'fail', 'Node 22.11.0 — 24 이상', 'OpenJS.NodeJS.LTS'],
    ['Claude 없음', (f) => (f.cli.claude = { found: false, path: null, loggedIn: null, detail: 'PATH에 없음' }), 'cli.claude', 'warn', '찾지 못했습니다', 'npm i -g @anthropic-ai/claude-code 뒤 claude auth login'],
    ['Codex 로그아웃', (f) => (f.cli.codex = { found: true, path: 'C:\\cli\\codex.exe', loggedIn: false, detail: '' }), 'cli.codex', 'warn', '로그인돼 있지 않습니다', 'codex login'],
    ['API 키 방식·키 없음', (f) => ((f.cli.claude = { found: true, path: 'c.exe', loggedIn: false, detail: '' }), (f.apiKeys!.claude = { registered: false, authMode: 'api_key' })), 'cli.claude', 'warn', '로그인돼 있지 않습니다', `wook-server secret set claude-api-key --data-dir "${DATA}"`],
    ['로그인을 모름', (f) => (f.cli.claude = { found: true, path: 'c.exe', loggedIn: null, detail: '상태 확인 시간 초과' }), 'cli.claude', 'warn', '확인하지 못했습니다 (상태 확인 시간 초과)', `claude auth login 뒤 다시 점검하세요: wook-server check --data-dir "${DATA}"`],
    ['사용자 환경의 API 키', withProbe((p) => p.envNames.user.push('ANTHROPIC_API_KEY')), 'apikey-env', 'warn', 'ANTHROPIC_API_KEY(사용자 환경)', "SetEnvironmentVariable('<이름>', $null, 'User')"],
    ['이 프로세스의 API 키', (f) => f.processEnvNames.push('OPENAI_API_KEY'), 'apikey-env', 'warn', 'OPENAI_API_KEY(이 프로세스)', `secret set <AI>-api-key --data-dir "${DATA}"`],
    ['방식을 모름', (f) => ((f.apiKeys = null), (f.processEnvNames = ['ANTHROPIC_API_KEY'])), 'apikey-env', 'warn', '서버가 돌지 않아 방식을 보지 못했습니다', '구독으로 쓰려면'],
    ['화면 잠김', (f) => (f.server!.screen = { ok: false, detail: '서버 PC 화면이 잠겨 있어 메인 에이전트가 화면을 보거나 조작할 수 없습니다' }), 'screen', 'warn', '화면이 잠겨 있어', 'tscon'],
    ['화면 조작 끔', (f) => ((f.screenEnabled = false), (f.server!.screen = { ok: false, detail: 'x' })), 'screen', 'ok', 'screen.enabled false', null],
    ['서버 없음(화면)', (f) => (f.server = null), 'screen', 'skip', '서버가 돌지 않아', null],
    ['Node 파이프로 물러남', (f) => ((f.server!.adminPipe = { mode: 'node', rejectsRemote: false, userOnlyAcl: false, reason: '10초 안에 READY가 오지 않았습니다' }), ((f.probe as ProbeData).smbBlockRules = 0)), 'smb', 'warn', adminPipeFallbackWarning('10초 안에 READY가 오지 않았습니다'), 'New-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기"'],
    ['도우미·445 규칙 없음', withProbe((p) => (p.smbBlockRules = 0)), 'smb', 'ok', '(정보 — 겹 방어로 막아 두기를 권합니다)', null],
    ['서버 없음(SMB)', (f) => (f.server = null), 'smb', 'skip', '서버가 돌지 않아 관리 채널을 보지 못했습니다 · Tailscale 쪽 TCP 445 막기 규칙 1개', null],
    ['Tailscale 없음', withProbe((p) => (p.tailscale = { found: false, status: null, serve: null })), 'tailscale', 'warn', 'Tailscale이 없습니다', 'Tailscale.Tailscale'],
    ['Tailscale 멈춤', withProbe((p) => (p.tailscale.status = tsStatus({ state: 'Stopped' }))), 'tailscale', 'warn', '(Stopped)', 'tailscale up'],
    ['HTTPS 꺼짐', withProbe((p) => (p.tailscale.status = tsStatus({ cert: null }))), 'tailscale', 'warn', 'HTTPS 인증서가 꺼져 있습니다', 'HTTPS 인증서를 켜세요'],
    ['serve 없음', withProbe((p) => (p.tailscale.serve = '{}')), 'tailscale', 'warn', '이 서버(포트 7317)로 넘기는 tailscale serve 항목이 없습니다', `tailscale serve --bg 7317 뒤 그 https 주소를 server.json network.publicOrigin에 넣고 wook-server config reload --data-dir "${DATA}"`],
    ['다른 항목', withProbe((p) => (p.tailscale.serve = tsServe({ extra: { '7878': { TCPForward: '127.0.0.1:7878' } } }))), 'tailscale', 'warn', 'TCP 7878 → 127.0.0.1:7878', '다른 Tailscale 기기 이름'],
    ['funnel', withProbe((p) => (p.tailscale.serve = tsServe({ funnel: true }))), 'tailscale', 'fail', 'funnel이 켜져 있습니다', 'funnel'],
  ];
  for (const [label, mutate, id, level, text, fix] of cases) {
    it(`${label} → ${id} ${level}`, () => {
      const facts = goodFacts();
      mutate(facts);
      const it2 = byId(deployItems(facts), id);
      expect([it2.level, it2.text.includes(text), fix === null ? it2.fix : it2.fix?.includes(fix)], `${it2.text} / ${it2.fix}`).toEqual([level, true, fix === null ? null : true]);
    });
  }

  it('고칠 길이 wook-server 명령이면 늘 점검한 데이터 폴더를 붙인다 — 그대로 치면 그 폴더에 닿는다 (S9-22 DF-1)', () => {
    const DIR = 'C:\\Users\\owner\\wook-data';
    // 고칠 길로 wook-server 명령을 내는 모든 경우
    const mutations: ((f: DeployFacts) => void)[] = [
      withProbe((p) => (p.sessionId = 0)),
      withProbe((p) => (p.task = { found: false, xml: null, error: null })),
      withProbe((p) => (p.task.xml = buildTaskXml({ ...taskInputs, dataDir: DIR, sid: 'S-1-5-18' }))),
      (f) => (f.nodeVersion = '22.1.0'),
      (f) => ((f.cli.claude = { found: true, path: 'c.exe', loggedIn: false, detail: '' }), (f.apiKeys!.claude = { registered: false, authMode: 'api_key' })),
      (f) => (f.cli.codex = { found: true, path: 'x.exe', loggedIn: null, detail: '' }),
      (f) => f.processEnvNames.push('OPENAI_API_KEY'),
      withProbe((p) => (p.tailscale.serve = '{}')),
      (f) => (f.probe = { error: '10초 안에 끝나지 않았습니다' }),
    ];
    const seen = new Set<string>();
    for (const m of mutations) {
      const facts = goodFacts();
      facts.expectedTask = { ...facts.expectedTask, dataDir: DIR };
      m(facts);
      for (const it2 of deployItems(facts)) {
        for (const at of [...(it2.fix ?? '').matchAll(/wook-server ([a-z-]+(?: (?:reload|set))?)((?: [^ ]+)*?) --data-dir "([^"]*)"/g)]) seen.add(`${at[1]} ${at[3]}`);
        // wook-server가 나오는 만큼 --data-dir "<점검한 폴더>"가 따른다
        const named = [...(it2.fix ?? '').matchAll(/wook-server /g)].length;
        expect([it2.id, [...(it2.fix ?? '').matchAll(new RegExp(`--data-dir "${DIR.replace(/\\/g, '\\\\')}"`, 'g'))].length]).toEqual([it2.id, named]);
      }
    }
    expect([...seen].sort()).toEqual([`check ${DIR}`, `config reload ${DIR}`, `install-task ${DIR}`, `secret set ${DIR}`]);
  });

  it('데이터 폴더 항목의 icacls 줄도 같은 규칙: 보통의 폴더는 그 줄 그대로, 폴더나 계정 이름에 셸이 바꾸는 글자가 있으면 줄 대신 명령과 손으로 넣을 것 (S9-25 R3-2)', () => {
    const warnFix = (dir: string, user = { name: 'pc_09', domain: 'DESKTOP-X' }): string => {
      const facts = goodFacts();
      const p = facts.probe as ProbeData;
      p.user = { ...p.user, ...user };
      p.dataDir.rules.push({ sid: 'S-1-1-0', name: 'Everyone', type: 'Allow', inheritOnly: false });
      facts.expectedTask = { ...facts.expectedTask, dataDir: dir };
      const it2 = byId(deployItems(facts), 'dataDir');
      expect(it2.level).toBe('warn');
      return it2.fix!;
    };
    // 보통의 폴더 — 오늘의 줄 그대로 (확인 검토의 줄들)
    for (const [dir, quoted] of [
      ['C:\\Users\\홍 길동\\wook data', '"C:\\Users\\홍 길동\\wook data"'],
      ["C:\\Users\\owner\\it's", '"C:\\Users\\owner\\it\'s"'],
      ['D:\\', '"D:\\\\"'],
    ]) {
      expect([dir, warnFix(dir!)]).toEqual([dir, `그 사용자만 열게 좁히세요: icacls ${quoted} /inheritance:r /grant:r "DESKTOP-X\\pc_09:(OI)(CI)F"`]);
    }
    // 셸이 바꾸는 글자가 든 폴더 — PowerShell 5.1은 $·백틱을 펼치고 굽은 따옴표에서 끊고, cmd는 %…%를 펼친다 (다른 폴더의 권한을 좁힌다)
    for (const dir of ['C:\\Users\\owner\\wook$old data', 'C:\\Users\\owner\\a`tb', 'C:\\Users\\owner\\a\u201cb c', 'C:\\Users\\owner\\100%USERNAME%x']) {
      expect([dir, warnFix(dir)]).toEqual([
        dir,
        `그 사용자만 열게 좁히세요: icacls <데이터 폴더> /inheritance:r /grant:r "DESKTOP-X\\pc_09:(OI)(CI)F" — 데이터 폴더 이름에 셸이 바꾸는 글자($ \` & ^ % ! " 굽은 따옴표)가 있어 그대로 붙여 넣을 줄을 내지 않습니다. 이 명령을 손으로 치면서 <데이터 폴더>에는 이 데이터 폴더(${dir})를 넣으세요`,
      ]);
    }
    // 계정 이름에 그런 글자가 있어도 같다 (폴더는 보통이면 그대로 둔다)
    expect(warnFix('D:\\data', { name: 'svc$', domain: 'DESKTOP-X' })).toBe(
      '그 사용자만 열게 좁히세요: icacls "D:\\data" /inheritance:r /grant:r "<계정>:(OI)(CI)F" — 계정 이름에 셸이 바꾸는 글자($ ` & ^ % ! " 굽은 따옴표)가 있어 그대로 붙여 넣을 줄을 내지 않습니다. 이 명령을 손으로 치면서 <계정>에는 DESKTOP-X\\svc$를 넣으세요',
    );
  });

  it('붙여 넣을 줄: 보통의 폴더(빈칸·한글·작은따옴표·드라이브 뿌리·괄호)는 그 줄 그대로, 셸이 바꾸는 글자($ ` “ ‘ & ^ % ! ")가 든 폴더·옮길 값이면 줄 대신 명령 이름과 할 일 (S9-24 R2S-5)', () => {
    for (const [dir, quoted] of SAFE_FIX_DIRS) {
      expect(wookServerCommand('install-task', dir)).toBe(`wook-server install-task --data-dir ${quoted}`);
      expect(wookServerCommand('secret set', dir, ['claude-api-key'])).toBe(`wook-server secret set claude-api-key --data-dir ${quoted}`);
      expect(wookServerCommand('install-task', dir, ['--port', '7330', '--public-origin', { value: 'https://pc.tailnet.ts.net' }])).toBe(
        `wook-server install-task --port 7330 --public-origin "https://pc.tailnet.ts.net" --data-dir ${quoted}`,
      );
    }
    for (const dir of UNSAFE_FIX_DIRS) {
      const line = wookServerCommand('install-task', dir);
      expect([dir, line.includes('--data-dir "'), line]).toEqual([
        dir,
        false,
        `wook-server install-task --data-dir <데이터 폴더> — 데이터 폴더 이름에 셸이 바꾸는 글자($ \` & ^ % ! " 굽은 따옴표)가 있어 그대로 붙여 넣을 줄을 내지 않습니다. 이 명령을 손으로 치면서 --data-dir에는 이 데이터 폴더(${dir})를 넣으세요`,
      ]);
    }
    // 작업에서 옮길 값에 큰따옴표·%가 있으면(손으로 고친 작업) 그 값을 다시 감싸 붙여 넣지 않는다 — 다른 낱말은 그대로 보인다
    expect(wookServerCommand('install-task', 'D:\\data', ['--port', '7330', '--config', { value: 'C:\\cfg\\a"b.json' }])).toBe(
      'wook-server install-task --port 7330 --config <값> --data-dir <데이터 폴더> — 지금 작업에서 옮길 값에 셸이 바꾸는 글자($ ` & ^ % ! " 굽은 따옴표)가 있어 그대로 붙여 넣을 줄을 내지 않습니다. 이 명령을 손으로 치면서 --data-dir에는 이 데이터 폴더(D:\\data)를, <값>에는 지금 작업의 그 값을 넣으세요',
    );
    // check의 항목으로: 손으로 고친 작업의 --config 값(따옴표가 든) → 다시 등록하는 고칠 길은 붙여 넣을 줄이 아니다
    const facts = goodFacts();
    (facts.probe as ProbeData).task.xml = buildTaskXml(taskInputs).replace('</Arguments>', ' --config &quot;C:\\cfg\\a\\&quot;b.json&quot;</Arguments>').replace('PT0S', 'PT72H');
    const fix = byId(deployItems(facts), 'task').fix!;
    expect([fix.includes('--config <값>'), fix.includes('--data-dir "')]).toEqual([true, false]);
  });

  it('다시 등록하는 고칠 길은 지금 작업의 install-task 옵션(--port·--public-origin 등)을 옮긴다 — 그대로 치면 포트·주소가 바뀌지 않는다', () => {
    const facts = goodFacts();
    (facts.probe as ProbeData).task.xml = buildTaskXml({ ...taskInputs, port: 7330, publicOrigin: 'https://grok-pc.tailnet-x.ts.net' }).replace('PT0S', 'PT72H');
    expect(byId(deployItems(facts), 'task').fix).toBe(
      `다시 등록하세요 (같은 이름을 바꿔 넣습니다): wook-server install-task --web-dir "${APP}\\out\\web" --port 7330 --public-origin "https://grok-pc.tailnet-x.ts.net" --data-dir "${DATA}"`,
    );
  });

  it('작업의 UserId가 계정 이름으로 와도(작업 스케줄러가 SID 대신 돌려줌) 같은 계정이면 통과', () => {
    const facts = goodFacts();
    (facts.probe as ProbeData).task.xml = buildTaskXml(taskInputs).replace(new RegExp(SID, 'g'), 'DESKTOP-X\\pc_09');
    expect(byId(deployItems(facts), 'task').level).toBe('ok');
  });

  it('API 키 방식이고 키가 등록돼 있으면 구독 로그인이 없어도 통과, 그 AI의 키 환경 변수는 경고하지 않는다. CLAUDE_CODE_OAUTH_TOKEN은 구독의 토큰이라 보지 않는다', () => {
    const facts = goodFacts();
    facts.cli.claude = { found: true, path: 'c.exe', loggedIn: false, detail: '' };
    facts.apiKeys!.claude = { registered: true, authMode: 'api_key' };
    facts.processEnvNames.push('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN');
    const items = deployItems(facts);
    expect([byId(items, 'cli.claude').level, byId(items, 'apikey-env').level]).toEqual(['ok', 'ok']);
  });

  it('서버가 없으면 작업 인자의 --port로 Tailscale을 견준다', () => {
    const facts = goodFacts();
    facts.server = null;
    (facts.probe as ProbeData).task.xml = buildTaskXml({ ...taskInputs, port: 7330 });
    (facts.probe as ProbeData).tailscale.serve = tsServe({ proxy: 'http://127.0.0.1:7330' });
    expect(byId(deployItems(facts), 'tailscale')).toMatchObject({ level: 'ok', text: `https://${DNS} → 127.0.0.1:7330` });
  });

  it('점검이 돌지 못하면 점검 스크립트 항목이 실패하고 그것이 보던 항목은 건너뛴다 — 나머지는 본다', () => {
    const facts = goodFacts();
    facts.probe = { error: '10초 안에 끝나지 않았습니다' };
    const items = deployItems(facts);
    expect(items.map((i) => [i.id, i.level])).toEqual([
      ['probe', 'fail'],
      ['session', 'skip'],
      ['autologon', 'skip'],
      ['lock', 'skip'],
      ['sleep', 'skip'],
      ['task', 'skip'],
      ['dataDir', 'skip'],
      ['node', 'ok'],
      ['cli.claude', 'ok'],
      ['cli.codex', 'ok'],
      ['apikey-env', 'ok'],
      ['screen', 'ok'],
      // SMB는 서버의 관리 채널(status.adminPipe)로 본다 — 445 규칙만 점검에서 온다
      ['smb', 'ok'],
      ['tailscale', 'skip'],
    ]);
    expect(items[0]!.text).toContain('10초 안에 끝나지 않았습니다');
  });

  it('표: 수준·항목·글, 고칠 길은 그 밑 줄 — 요약은 수와 항목 이름만', () => {
    const facts = goodFacts();
    (facts.probe as ProbeData).winlogon.autoAdminLogon = '0';
    facts.nodeVersion = '22.1.0';
    const report: DeployReport = { checkedAt: '2026-11-11T00:00:00.000Z', items: deployItems(facts) };
    const lines = formatCheck(report).split('\n');
    expect(lines[0]).toBe('욱채 서버 배포 점검 (2026-11-11T00:00:00.000Z — 바꾼 것은 없습니다)');
    expect(lines[1]).toBe('  통과   세션              Console (세션 1)');
    expect(lines[2]).toMatch(/^ {2}경고 {3}자동 로그온 {7}자동 로그온이 꺼져 있습니다/);
    expect(lines[3]).toMatch(/^ {27}할 일: Sysinternals Autologon/);
    expect(lines.at(-2)).toBe('결과: 통과 11 · 경고 1 (autologon) · 실패 1 (node) · 건너뜀 0 — 실패가 있어 끝 코드 1입니다');
    expect(deploySummary(report.items)).toBe('통과 11 · 경고 1 (autologon) · 실패 1 (node) · 건너뜀 0');
    expect(deployText(report)).toBe('2026-11-11T00:00:00.000Z에 — 통과 11 · 경고 1 (autologon) · 실패 1 (node) · 건너뜀 0 (wook-server check로 자세히)');
    // 새 항목 데이터 폴더의 줄 (S9-22 DS-5) — 항목 이름 칸의 폭은 그대로다
    expect(lines.find((l) => l.includes('데이터 폴더'))).toBe(`  통과   데이터 폴더       ${DATA} — 이 사용자·SYSTEM·Administrators만 열 수 있습니다`);
  });
});

describe('점검 스크립트는 DefaultPassword의 값을 읽지 않고, 읽기만 한다 (S9-4·S9-13)', () => {
  const script = probeScript('WookServer-0123abcd', DATA);

  it('값을 읽는 길은 RegValue 하나 — 정해 둔 이름만 넘기고, Password가 든 이름은 RegValue가 늘 거부한다. Get-ItemProperty·reg query는 없다', () => {
    expect(script).not.toMatch(/Get-ItemProperty|\breg(\.exe)?\s+query|Get-ItemPropertyValue/i);
    expect([...script.matchAll(/\.GetValue\(/g)]).toHaveLength(1);
    expect(script).toContain("if ($name -like '*Password*') { return $null }");
    const names = [...script.matchAll(/RegValue\s+(?:\$\w+|'[^']*')\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(new Set(names)).toEqual(new Set(PROBE_VALUE_NAMES));
    // DefaultPassword는 이름 목록에 있는지만 본다
    expect([...script.matchAll(/'DefaultPassword'/g)]).toHaveLength(1);
    expect(script).toContain("hasDefaultPassword = ((RegNames $wl) -contains 'DefaultPassword')");
  });

  it('바꾸는 명령이 없다 — Set-·Remove-·Register-·reg add·powercfg 바꾸기·schtasks·tailscale serve 바꾸기·콘솔 코드 페이지 바꾸기', () => {
    expect(script).not.toMatch(/\b(Set|Remove|Register|Unregister|Enable|Disable|Stop|Start|Restart|Rename|Clear|Add)-[A-Z]\w*/);
    expect(script).not.toMatch(/New-Item|New-NetFirewallRule|\breg(\.exe)?\s+(add|delete)|setx|schtasks/i);
    expect([...script.matchAll(/powercfg\s+(\/\w+)/g)].map((m) => m[1])).toEqual(['/qh', '/qh', '/qh']);
    expect([...script.matchAll(/\bpowercfg\b/g)]).toHaveLength(4);
    expect([...script.matchAll(/Utf8Out \$ts '([^']*)'/g)].map((m) => m[1])).toEqual(['status --json', 'serve status --json']);
    // tailscale을 부르는 길은 그 둘뿐이다 ($ts는 찾기 셋·있는지 하나·부르기 둘)
    expect([...script.matchAll(/\$ts\b/g)]).toHaveLength(6);
    // 콘솔의 코드 페이지는 바꾸지 않는다 (자식의 StandardOutputEncoding은 그 자식의 파이프를 읽는 꼴일 뿐이다)
    expect(script).not.toMatch(/\[Console\]::(Output|Input)Encoding|\$OutputEncoding|chcp|SetConsole/i);
    // 작업 스케줄러는 COM의 읽기(Connect·GetFolder·GetTask)만
    expect([...script.matchAll(/\$svc\.(\w+)|\.(GetTask|GetFolder|RegisterTask\w*|DeleteTask)\(/g)].map((m) => m[1] ?? m[2])).toEqual(['Connect', 'GetFolder', 'GetTask']);
    // 데이터 폴더의 권한은 Get-Acl로 읽기만 (S9-22 DS-5) — 바꾸는 icacls·Set-Acl·SetAccessRule 없음
    expect([...script.matchAll(/Get-Acl -LiteralPath/g)]).toHaveLength(1);
    expect(script).not.toMatch(/icacls|Set-Acl|SetAccessRule|AddAccessRule|RemoveAccessRule|SetOwner/i);
  });

  it('데이터 폴더 경로는 UTF-16LE base64로 넣는다 — 경로의 따옴표(\'·‘·’)가 스크립트를 바꾸지 못한다 (S9-22 DS-5)', () => {
    const odd = "D:\\a'b‘c’d\"; Remove-Item x; '\\욱채";
    const s = probeScript('WookServer-0123abcd', odd);
    expect(s.includes("a'b")).toBe(false);
    const b64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(s)![1]!;
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe(odd);
  });

  it('점검이 낸 모르는 칸(값처럼 보이는 것)은 항목·표·JSON 어디에도 가지 않는다', () => {
    const MARK = 'Pw-MARK-91c3-not-a-real-value';
    const raw = { v: 1, ...goodProbe(), winlogon: { ...goodProbe().winlogon, DefaultPassword: MARK }, extra: MARK };
    const parsed = parseProbeOutput(JSON.stringify(raw));
    expect('error' in parsed).toBe(false);
    const facts = { ...goodFacts(), probe: parsed };
    const items = deployItems(facts);
    const report: DeployReport = { checkedAt: 'x', items };
    expect([JSON.stringify(parsed).includes(MARK), formatCheck(report).includes(MARK), jsonLine({ ok: true, result: report }).includes(MARK)]).toEqual([false, false, false]);
  });

  it('-NoProfile -NonInteractive -EncodedCommand(UTF-16LE base64), 10초 — 이름 모양이 아니면 스크립트를 만들지 않는다', async () => {
    const args = probeArgs('WookServer-0123abcd', DATA);
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[3]!, 'base64').toString('utf16le')).toBe(script);
    expect(() => probeScript("WookServer-0123abcd'; Remove-Item x; '", DATA)).toThrow();
    const seen: { file: string; args: readonly string[]; timeoutMs: number }[] = [];
    const exec: ProbeExec = async (file, a, o) => {
      seen.push({ file, args: a, timeoutMs: o.timeoutMs });
      return { code: 0, stdout: JSON.stringify({ v: 1, ...goodProbe() }), timedOut: false, error: null };
    };
    const r = await runProbe('WookServer-0123abcd', DATA, exec, { env: { SystemRoot: 'C:\\Windows' } });
    expect('error' in r).toBe(false);
    expect(seen.map((s) => [s.file, s.timeoutMs])).toEqual([['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', PROBE_TIMEOUT_MS]]);
    const fails: [Partial<Awaited<ReturnType<ProbeExec>>>, string][] = [
      [{ timedOut: true, code: null }, '10초 안에 끝나지 않았습니다'],
      [{ error: 'ENOENT', code: null }, 'Windows PowerShell을 띄우지 못했습니다 (ENOENT)'],
      [{ code: 1 }, '끝 코드 1'],
      [{ stdout: '이건 JSON이 아님' }, '점검 스크립트의 출력이 JSON이 아닙니다'],
      [{ stdout: '{"v":2}' }, '점검 스크립트의 출력 판이 다릅니다'],
      [{ error: 'aborted', code: null }, '서버가 끝나 점검을 그만두었습니다'],
    ];
    for (const [over, error] of fails) {
      const bad: ProbeExec = async () => (await later(), { code: 0, stdout: '', timedOut: false, error: null, ...over });
      expect(await runProbe('WookServer-0123abcd', DATA, bad)).toEqual({ error });
    }
  });

  it('점검 출력의 데이터 폴더 칸: 규칙이 하나면 PowerShell이 배열 대신 그 하나를 내도 읽는다 — 칸이 없으면 보지 못한 것으로(없는 폴더라고 하지 않는다)', () => {
    const one = parseProbeOutput(JSON.stringify({ v: 1, ...goodProbe(), dataDir: { found: true, protected: true, rules: { sid: SID, name: null, type: 'Allow', inheritOnly: false }, error: null } })) as ProbeData;
    expect(one.dataDir).toEqual({ found: true, protected: true, rules: [{ sid: SID, name: null, type: 'Allow', inheritOnly: false }], error: null });
    const { dataDir: _gone, ...noDataDir } = goodProbe();
    const none = parseProbeOutput(JSON.stringify({ v: 1, ...noDataDir })) as ProbeData;
    expect(none.dataDir.error).toBe('점검 출력에 데이터 폴더 칸이 없습니다');
    expect(byId(deployItems({ ...goodFacts(), probe: none }), 'dataDir').level).toBe('skip');
  });
});

describe.runIf(process.platform === 'win32')('점검 스크립트의 조각을 실제 Windows PowerShell 5.1로 (읽기만)', () => {
  const script = probeScript('WookServer-0123abcd', DATA);
  // 점검 스크립트처럼 진행 표시를 끈다(모듈을 처음 불러올 때의 CLIXML 진행 글이 stderr에 나오지 않게)
  const ps = (body: string, env: NodeJS.ProcessEnv, cwd?: string): string =>
    execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${body}`, 'utf16le').toString('base64')], {
      encoding: 'latin1',
      windowsHide: true,
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
    });
  const temps: string[] = [];
  afterAll(async () => {
    for (const d of temps) await removeDir(d);
  });

  it('붙여 넣을 줄을 PowerShell 5.1과 cmd에 그대로 — 보통의 폴더는 Node가 같은 폴더를 받는다 (wook-server.cmd 꼴의 감싸개, Node는 인자만 찍는다 — S9-24 R2S-5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-fixline-'));
    temps.push(dir);
    writeFileSync(join(dir, 'argv.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    // scripts\wook-server.cmd와 같은 꼴 — 여기서는 인자만 찍는 스크립트를 띄운다(아무 폴더도 만들거나 건드리지 않는다)
    const wrapper = join(dir, 'wook-server.cmd');
    writeFileSync(wrapper, `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
    const viaCmd = (line: string): string =>
      spawnSync(process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true, timeout: 90_000 }).stdout ?? '';
    const argvOf = (out: string): string[] | null => {
      try {
        return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)) as string[];
      } catch {
        return null;
      }
    };
    for (const [d] of SAFE_FIX_DIRS) {
      for (const [words, want] of [
        [['install-task'], ['install-task']],
        [['install-task', '--port', '7330', '--public-origin', { value: 'https://pc.tailnet.ts.net' }], ['install-task', '--port', '7330', '--public-origin', 'https://pc.tailnet.ts.net']],
        [['secret set', 'claude-api-key'], ['secret', 'set', 'claude-api-key']],
      ] as [CommandWord[], string[]][]) {
        // 대표가 치는 꼴 그대로(scripts\wook-server.cmd 자리에 감싸개의 경로 — 빈칸 없는 임시 폴더라 따옴표 없이)
        expect(/\s/.test(wrapper)).toBe(false);
        const line = wookServerCommand(words[0] as string, d, words.slice(1)).replace(/^wook-server /, `${wrapper} `);
        // PowerShell은 Node의 출력을 바이트 그대로 넘긴다 — latin1로 받은 것을 UTF-8로 다시 읽는다. 데이터 폴더는 서버처럼 resolve해서 견준다
        // (PowerShell 5.1은 드라이브 뿌리 "C:\\"를 C:\\로 넘긴다 — 같은 폴더다)
        const same = (got: string[] | null): unknown => (got ? [...got.slice(0, -1), win32.resolve(got.at(-1)!).toLowerCase()] : got);
        const viaPs = argvOf(Buffer.from(ps(line, {}), 'latin1').toString('utf8'));
        expect([d, 'ps5.1', same(viaPs)]).toEqual([d, 'ps5.1', [...want, '--data-dir', win32.resolve(d).toLowerCase()]]);
        expect([d, 'cmd', same(argvOf(viaCmd(line)))]).toEqual([d, 'cmd', [...want, '--data-dir', win32.resolve(d).toLowerCase()]]);
      }
    }
  }, 300_000);

  it('멈춘 tailscale: 점검의 tailscale 부분 그대로 — status가 4초 창에 걸리면 끝내고(쥔 프로세스를 Kill) serve status는 부르지 않는다. 5초 안에 돌아오고 멈춘 자식은 제 끝보다 훨씬 먼저 없다 (S9-22 DF-8, S9-24 R2S-4·R12)', async () => {
    const fn = script.slice(script.indexOf('function Utf8Out'), script.indexOf('$r = [ordered]@{ v = 1 }'));
    const tsBlock = script.slice(script.indexOf('# 멈춘 tailscale은'), script.indexOf('$r.envNames'));
    expect(tsBlock).toContain("Utf8Out $ts 'serve status --json'");
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-tshung-'));
    temps.push(dir);
    // 멈춘 tailscale 흉내: $ts = node.exe — Utf8Out이 넘기는 'status --json'으로 node가 이 폴더의 status.js를 돌린다. 30초 뒤에야 한 줄을 내고 스스로 끝난다
    // (남지 않게 — 4초 창은 답하지 않을 창이다). serve.js는 불렸다는 표시만 남기고 끝난다
    writeFileSync(join(dir, 'status.js'), "require('fs').writeFileSync(require('path').join(__dirname, 'status.pid'), String(process.pid));\nsetTimeout(() => process.stdout.write('{\"late\":true}'), 30000);\n");
    writeFileSync(join(dir, 'serve.js'), "require('fs').writeFileSync(require('path').join(__dirname, 'serve-ran'), 'x');\n");
    const t0 = Date.now();
    const out = ps(
      `${fn}\n$r = [ordered]@{ v = 1 }\n$ts = $env:WOOK_T_NODE\n$sw = [Diagnostics.Stopwatch]::StartNew()\n${tsBlock}\n'MS=' + $sw.ElapsedMilliseconds + ' status=' + ($null -eq $r.tailscale.status) + ' serve=' + ($null -eq $r.tailscale.serve)\n`,
      { WOOK_T_NODE: process.execPath },
      dir,
    );
    const m = /MS=(\d+) status=(\w+) serve=(\w+)/.exec(out);
    expect(m && [m[2], m[3], existsSync(join(dir, 'serve-ran'))]).toEqual(['True', 'True', false]);
    // tailscale 부분은 4초 창 하나로 끝난다 — 두 창(8초)보다 짧다. 한 창에 붙인 여유는 이 PC의 빠르기(프로세스 띄우기)에 기대지 않게 넉넉히 둔다
    // (리드 결정 S9-25 R3-4: '창 하나, 둘이 아님' — serve가 돌지 않은 것은 위에서 본다)
    expect(Number(m![1])).toBeLessThan(7_500);
    // 멈춘 자식은 쥔 쪽(Utf8Out)이 끝냈다 — 30초 뒤의 제 끝을 기다리지 않는다
    const pid = Number(readFileSync(join(dir, 'status.pid'), 'utf8'));
    while (pidAlive(pid) && Date.now() - t0 < 20_000) await sleep(100);
    expect([pidAlive(pid), Date.now() - t0 < 20_000]).toEqual([false, true]);
  }, 120_000);

  it('데이터 폴더 권한 읽기: 이 사용자만인 폴더는 통과, 다른 계정(Users)에 준 폴더는 경고, 없는 폴더는 건너뜀 — SID로 견준다 (S9-22 DS-5)', () => {
    const frag = script.slice(script.indexOf('# 데이터 폴더의 권한'), script.indexOf('$lan = Get-Service'));
    const sids: string[] = [];
    /** 그 조각만 돌려(경로만 바꿔 넣고) 점검 출력처럼 읽는다 */
    const run = (dir: string): ProbeData['dataDir'] => {
      const body = frag.replace(/FromBase64String\('[^']*'\)/, `FromBase64String('${Buffer.from(dir, 'utf16le').toString('base64')}')`);
      const out = ps(
        `$r = [ordered]@{ v = 1 }\n$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()\n${body}\n$r.sid = $me.User.Value\n$json = $r | ConvertTo-Json -Compress -Depth 6\n[regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })\n`,
        {},
      );
      expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
      const raw = JSON.parse(out.slice(out.indexOf('{'))) as { sid: string; dataDir: unknown };
      sids.push(raw.sid);
      return (parseProbeOutput(JSON.stringify({ ...goodProbe(), v: 1, dataDir: raw.dataDir })) as ProbeData).dataDir;
    };
    const base = mkdtempSync(join(tmpdir(), 'wook-test-ddacl-'));
    temps.push(base);
    const mine = join(base, '이 사용자만');
    mkdirSync(mine);
    restrictToCurrentUser(mine, 'dir');
    const shared = join(base, '함께 씀');
    mkdirSync(shared);
    restrictToCurrentUser(shared, 'dir');
    // 시험이 만든 임시 폴더에만 — Users(S-1-5-32-545)에 읽기를 준다
    execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe'), [shared, '/grant', '*S-1-5-32-545:(OI)(CI)R'], { stdio: 'ignore', windowsHide: true });
    const item = (dd: ProbeData['dataDir'], dataDir: string): DeployItem => {
      const facts = goodFacts();
      const p = facts.probe as ProbeData;
      p.user.sid = sids[0]!;
      p.dataDir = dd;
      facts.expectedTask = { ...facts.expectedTask, dataDir };
      return byId(deployItems(facts), 'dataDir');
    };
    const a = run(mine);
    expect([a.found, a.protected, a.rules.map((r) => r.sid)]).toEqual([true, true, [sids[0]]]);
    expect(item(a, mine)).toMatchObject({ level: 'ok' });
    const b = run(shared);
    expect(b.rules.map((r) => [r.sid, r.type])).toContainEqual(['S-1-5-32-545', 'Allow']);
    expect(item(b, shared)).toMatchObject({ level: 'warn', fix: `그 사용자만 열게 좁히세요: icacls "${shared}" /inheritance:r /grant:r "DESKTOP-X\\pc_09:(OI)(CI)F"` });
    const c = run(join(base, '없는 폴더'));
    expect([c.found, item(c, join(base, '없는 폴더')).level]).toEqual([false, 'skip']);
  }, 120_000);
});

describe('Tailscale 읽기', () => {
  it('serve status: 이 포트로 넘기는 / 항목, 같은 이름의 다른 항목, funnel — 우리 https 항목의 443 HTTPS 표시는 다른 항목이 아니다', () => {
    expect(readTailscale(tsStatus(), tsServe(), 7317)).toEqual({ running: true, state: 'Running', dnsName: DNS, https: true, ours: true, others: [], funnel: false });
    // 이 PC의 지금 모양 — HTTPS 꺼짐, TCP 80·7878 넘김만
    const pc = readTailscale(tsStatus({ cert: null }), JSON.stringify({ TCP: { '80': { TCPForward: '127.0.0.1:7878' }, '7878': { TCPForward: '127.0.0.1:7878' } } }), 7317)!;
    expect([pc.https, pc.ours, pc.others]).toEqual([false, false, ['TCP 80 → 127.0.0.1:7878', 'TCP 7878 → 127.0.0.1:7878']]);
    expect(readTailscale('JSON 아님', null, 7317)).toBeNull();
    expect(readTailscale(tsStatus(), tsServe({ proxy: 'http://127.0.0.1:73170' }), 7317)!.ours).toBe(false);
  });
});

describe('운영자 명령 check (S9-4)', () => {
  const report = (over: (f: DeployFacts) => void = () => undefined): CheckCommandDeps & { calls: string[] } => {
    const calls: string[] = [];
    const facts = goodFacts();
    over(facts);
    return {
      platform: 'win32',
      gather: {
        probe: async (name, dataDir) => {
          calls.push(`probe ${name} ${dataDir}`);
          await later();
          return facts.probe;
        },
        cli: async (kind) => {
          calls.push(`cli ${kind}`);
          await later();
          return facts.cli[kind];
        },
        nodeVersion: facts.nodeVersion,
        processEnvNames: facts.processEnvNames,
        now: () => new Date('2026-11-11T00:00:00.000Z'),
      },
      server: async () => {
        calls.push('server');
        await later();
        return facts.server ? { ...facts.server, apiKeys: facts.apiKeys, cliPaths: { claudePath: null, codexPath: null } } : null;
      },
      config: () => ({ screenEnabled: facts.screenEnabled, cliPaths: { claudePath: null, codexPath: null } }),
      taskName: () => 'WookServer-0123abcd',
      appRoot: APP,
      nodePath: NODE,
      calls,
    };
  };

  it('--dry-run: 돌릴 것(점검 스크립트·CLI 상태 명령)만 보인다 — 점검·CLI·서버를 하나도 부르지 않는다', async () => {
    const d = report();
    const r = await runCheck({ dataDir: DATA, dryRun: true }, d);
    expect([r.code, d.calls]).toEqual([0, []]);
    expect(r.out).toContain('[시험 실행 — 아무것도 띄우지 않았습니다]');
    expect(r.out).toContain(probeScript('WookServer-0123abcd', DATA).trim());
  });

  it('실패가 있으면 1, 없으면 0 — 서버(status·config show)와 점검(그 데이터 폴더로)·CLI를 한 번씩', async () => {
    const ok = report();
    const r0 = await runCheck({ dataDir: DATA, dryRun: false }, ok);
    expect([r0.code, [...ok.calls].sort()]).toEqual([0, ['cli claude', 'cli codex', `probe WookServer-0123abcd ${DATA}`, 'server']]);
    expect(r0.out.split('\n').at(-2)).toBe('결과: 통과 13 · 경고 0 · 실패 0 · 건너뜀 0 — 실패가 없습니다');
    const bad = await runCheck({ dataDir: DATA, dryRun: false }, report((f) => ((f.probe as ProbeData).sessionId = 0)));
    expect(bad.code).toBe(1);
    expect((bad.json as { ok: boolean; result: { counts: Record<string, number> } }).result.counts).toEqual({ ok: 12, warn: 0, fail: 1, skip: 0 });
    // --json은 ASCII 한 줄 (cli.ts jsonLine — 운영자 명령과 같은 출력기)
    const line = jsonLine(bad.json);
    expect(/^[\x20-\x7e]*\n$/.test(line)).toBe(true);
    expect(JSON.parse(new TextDecoder('euc-kr').decode(Buffer.from(line, 'utf8')))).toEqual(JSON.parse(line));
    const linux = await runCheck({ dataDir: DATA, dryRun: false }, { ...report(), platform: 'linux' });
    expect(linux.code).toBe(2);
  });
});

describe('서버의 시작 뒤 한 번 (S9-4)', () => {
  const quiet = () => {
    const lines: string[] = [];
    return { lines, info: (m: string) => void lines.push(`[INFO] ${m}`), warn: (m: string) => void lines.push(`[WARN] ${m}`) };
  };
  const sample: DeployReport = { checkedAt: 'x', items: deployItems(goodFacts()) };

  it('시험(VITEST) 중·Windows 밖에서는 돌리지 않는다 — run을 부르지 않는다', () => {
    let runs = 0;
    for (const [env, platform] of [
      [{ VITEST: 'true' }, 'win32'],
      [{}, 'linux'],
    ] as [NodeJS.ProcessEnv, NodeJS.Platform][]) {
      const log = quiet();
      const s = startDeployCheck({ env, platform, logger: log, run: async () => (runs++, sample), report: () => undefined });
      expect([s, log.lines]).toEqual([null, []]);
    }
    expect(runs).toBe(0);
  });

  it('한 번 돌고 결과를 넘기며, 기록에는 요약 한 줄만(항목 글 없음). 그만두게 하면 넘기지도 쓰지도 않는다', async () => {
    let runs = 0;
    const log = quiet();
    const got: DeployReport[] = [];
    const s = startDeployCheck({ env: {}, platform: 'win32', logger: log, run: async () => (runs++, await later(), sample), report: (r) => got.push(r) })!;
    await s.done;
    expect([runs, got]).toEqual([1, [sample]]);
    expect(log.lines).toEqual([`[INFO] 배포 점검: ${deploySummary(sample.items)} — wook-server check(또는 status)로 자세히 봅니다`]);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const log2 = quiet();
    const got2: DeployReport[] = [];
    let aborted = false;
    const s2 = startDeployCheck({
      env: {},
      platform: 'win32',
      logger: log2,
      run: async (signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        await hold;
        return sample;
      },
      report: (r) => got2.push(r),
    })!;
    s2.stop();
    release();
    await s2.done;
    expect([aborted, got2, log2.lines]).toEqual([true, [], []]);
    const log3 = quiet();
    await startDeployCheck({ env: {}, platform: 'win32', logger: log3, run: async () => Promise.reject(new Error('점검 실패')), report: () => undefined })!.done;
    expect(log3.lines).toEqual(['[WARN] 배포 점검을 하지 못했습니다 — wook-server check로 다시 해 보세요 (점검 실패)']);
  });
});

describe('시험 도우미의 정리 (S9-22 TI-1)', () => {
  it('데이터 폴더를 removeDir로 지우면 workspaceArgs가 정한 그 옆의 작업 폴더(<dataDir>-ws)도 지운다 — 빌드한 서버 시험이 따로 적지 않아도 남지 않게', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wook-test-wsclean-'));
    const args = workspaceArgs(d);
    expect(args).toEqual(['--workspace-root', `${d}-ws`]);
    // 서버가 만드는 것처럼 그 아래 main
    mkdirSync(join(`${d}-ws`, 'main'), { recursive: true });
    writeFileSync(join(`${d}-ws`, 'main', 'AGENTS.md'), '시험');
    await removeDir(d);
    expect([existsSync(d), existsSync(`${d}-ws`)]).toEqual([false, false]);
    // 시험이 --workspace-root를 직접 주면 그 폴더는 시험의 것이다 — 정하지 않고 지우지도 않는다
    expect(workspaceArgs(d, ['--workspace-root', 'x'])).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('빌드한 서버: 시작 뒤 한 번, 준비를 늦추지 않고, 시험 중에는 돌지 않는다 (S9-4)', () => {
  const PRELOAD = join(REPO, 'tests', 'server', 'fakeProbePreload.cjs');
  const dirs: string[] = [];
  let buildDir = '';
  let entry = '';
  const servers: BuiltServer[] = [];
  /** 이 시험의 늦춤 (늦춘 시험 한 번 — 리드 결정 S9-18) */
  const PAUSE = Number(process.env['WOOK_TEST_PAUSE_MS'] ?? '0');

  afterAll(async () => {
    for (const s of servers) {
      if (s.child.exitCode === null && s.child.signalCode === null) {
        runClient(entry, ['shutdown', '--data-dir', s.dataDir]);
        await Promise.race([s.exited, sleep(45_000)]);
        if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill();
      }
    }
    for (const d of dirs) await removeDir(d);
    if (buildDir) await removeDir(buildDir);
  }, 120_000);

  /** 이름 붙인 넉넉한 기다림 (답이 올 것을 기다린다) */
  async function waitFor(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
    const until = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > until) throw new Error(`기다림 끝남: ${what}`);
      await sleep(100);
    }
  }

  async function prepare(tag: string): Promise<{ dataDir: string; log: string; release: string; answer: string }> {
    if (!entry) {
      buildDir = testBuildDir('deploy');
      entry = buildServerTo(buildDir);
    }
    // 모의 메인으로 데이터 폴더를 준비한다 — 빌드한 서버가 이 PC의 실제 Claude·Codex CLI 턴을 띄우지 않게 (리드 결정 S6-19). 화면 조작은 끈다(화면 도우미를 띄우지 않는다)
    const h = await createHarness({ noProject: true });
    const dataDir = h.dataDir;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ screen: { enabled: false } }));
    const side = mkdtempSync(join(tmpdir(), `wook-test-deploy-${tag}-`));
    dirs.push(side);
    const answer = join(side, 'answer.json');
    writeFileSync(answer, jsonLine({ v: 1, ...goodProbe() }));
    return { dataDir, log: join(side, 'calls.log'), release: join(side, 'release'), answer };
  }

  const probeCalls = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('powershell ')) : []);
  const status = (dataDir: string): AdminStatus => {
    const { code, reply } = clientJson(entry, ['status', '--data-dir', dataDir]);
    expect(code).toBe(0);
    return reply.result as AdminStatus;
  };
  const mainTurnsMock = (dataDir: string): unknown[] => {
    const store = openStore(dataPaths(dataDir).db);
    try {
      return store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock);
    } finally {
      store.close();
    }
  };

  it('VITEST 없이: 준비 줄은 점검이 답하기 전에 나오고(그동안 deploy는 null), 점검은 한 번 — 답한 뒤 deploy가 차고 기록에는 요약 한 줄', async () => {
    const p = await prepare('run');
    const srv = await startBuilt({
      entry,
      dataDir: p.dataDir,
      nodeArgs: ['--require', PRELOAD],
      env: { VITEST: undefined, WOOK_TEST_PROBE_LOG: p.log, WOOK_TEST_PROBE_RELEASE: p.release, WOOK_TEST_PROBE_ANSWER: p.answer, WOOK_TEST_PROBE_DELAY_MS: String(PAUSE) },
    });
    servers.push(srv);
    // 준비 줄이 나왔다(startBuilt) — 점검은 아직 답하지 않았다(풀어 주는 파일이 없다)
    await waitFor('점검 스크립트를 한 번 띄움', () => probeCalls(p.log).length === 1);
    if (PAUSE) await sleep(PAUSE);
    const before = status(p.dataDir);
    expect([before.deploy, existsSync(p.release)]).toEqual([null, false]);
    writeFileSync(p.release, 'go');
    await waitFor('status의 deploy가 참', () => status(p.dataDir).deploy != null);
    const after = status(p.dataDir);
    const d = after.deploy!;
    expect(d.items.map((i) => i.id)).toEqual(['session', 'autologon', 'lock', 'sleep', 'task', 'dataDir', 'node', 'cli.claude', 'cli.codex', 'apikey-env', 'screen', 'smb', 'tailscale']);
    // 서버 자신의 관리 채널(도우미)·화면 조작 꺼 둠을 본다 — 점검 JSON의 가짜 Tailscale 이름이 그 항목 글에 있다
    expect(d.items.find((i) => i.id === 'smb')!.text).toContain('관리 채널이 다른 기기(SMB)의 연결을 거부합니다 (서버 도우미)');
    expect(d.items.find((i) => i.id === 'screen')).toMatchObject({ level: 'ok', text: expect.stringContaining('screen.enabled false') });
    const text = JSON.stringify(d);
    expect(text).toContain(DNS);
    // 한 번만 — status를 더 물어도 다시 돌지 않는다
    status(p.dataDir);
    expect(probeCalls(p.log)).toHaveLength(1);
    const human = runClient(entry, ['status', '--data-dir', p.dataDir]);
    expect(human.stdout).toContain(`  배포 점검     ${deployText(d)}`);
    const down = runClient(entry, ['shutdown', '--data-dir', p.dataDir]);
    expect([down.code, (await srv.exited).code]).toEqual([0, 0]);
    const log = readFileSync(join(p.dataDir, 'logs', 'server.log'), 'utf8');
    expect(log.split('\n').filter((l) => l.includes('배포 점검'))).toEqual([expect.stringContaining(`배포 점검: ${deploySummary(d.items)} — wook-server check(또는 status)로 자세히 봅니다`)]);
    // 항목 글(가짜 Tailscale 이름 등)은 기록에 없다
    expect(log.includes(DNS)).toBe(false);
    expect(probeCalls(p.log)).toHaveLength(1);
    expect(mainTurnsMock(p.dataDir)).toEqual([]);
  }, 300_000);

  it('점검이 답하기 전에 서버를 끄면 종료 흐름이 그 점검을 그만두게 한다(쥔 자식만 — AbortSignal) — 결과도 실패 줄도 기록하지 않고 0으로 끝난다', async () => {
    const p = await prepare('stop');
    const srv = await startBuilt({
      entry,
      dataDir: p.dataDir,
      nodeArgs: ['--require', PRELOAD],
      env: { VITEST: undefined, WOOK_TEST_PROBE_LOG: p.log, WOOK_TEST_PROBE_RELEASE: p.release, WOOK_TEST_PROBE_ANSWER: p.answer },
    });
    servers.push(srv);
    await waitFor('점검 스크립트를 한 번 띄움', () => probeCalls(p.log).length === 1);
    if (PAUSE) await sleep(PAUSE);
    const down = runClient(entry, ['shutdown', '--data-dir', p.dataDir]);
    expect([down.code, (await srv.exited).code]).toEqual([0, 0]);
    expect(readFileSync(p.log, 'utf8').split('\n').filter((l) => l === 'powershell aborted')).toHaveLength(1);
    expect(readFileSync(join(p.dataDir, 'logs', 'server.log'), 'utf8')).not.toContain('배포 점검');
    expect(mainTurnsMock(p.dataDir)).toEqual([]);
  }, 300_000);

  it('점검은 준비 줄의 쓰기가 끝나기를 기다리지 않고 건다 — 그 사이에 시작된 종료가 점검을 놓치지 않게 (S9-22 DF-11)', async () => {
    const p = await prepare('hold');
    // 점검은 바로 답한다. 미리 불러오기가 준비 줄 쓰기의 끝을 점검이 불릴 때까지(30초까지만) 붙잡는다
    writeFileSync(p.release, 'go');
    const srv = await startBuilt({
      entry,
      dataDir: p.dataDir,
      nodeArgs: ['--require', PRELOAD],
      env: { VITEST: undefined, WOOK_TEST_PROBE_LOG: p.log, WOOK_TEST_PROBE_RELEASE: p.release, WOOK_TEST_PROBE_ANSWER: p.answer, WOOK_TEST_HOLD_READY_MS: '30000' },
    });
    servers.push(srv);
    const marks = (): string[] => (existsSync(p.log) ? readFileSync(p.log, 'utf8').split('\n') : []).filter((l) => l.startsWith('powershell ') || l.startsWith('ready-written '));
    // 답이 올 기다림 — 점검이 불리면 바로 놓아 준다(안 불리면 30초 뒤 timeout으로 놓아 준다)
    await waitFor('준비 줄 쓰기를 놓아 줌', () => marks().some((l) => l.startsWith('ready-written ')));
    expect(marks().map((l) => (l.startsWith('powershell ') ? '점검' : l))).toEqual(['점검', 'ready-written after-probe']);
    await waitFor('status의 deploy가 참', () => status(p.dataDir).deploy != null);
    const down = runClient(entry, ['shutdown', '--data-dir', p.dataDir]);
    expect([down.code, (await srv.exited).code]).toEqual([0, 0]);
    expect(marks().filter((l) => l.startsWith('powershell '))).toHaveLength(1);
    expect(mainTurnsMock(p.dataDir)).toEqual([]);
  }, 300_000);

  it('VITEST가 있으면 점검을 띄우지 않는다 — deploy는 null, 기록에 배포 점검 줄 없음', async () => {
    const p = await prepare('vitest');
    const srv = await startBuilt({
      entry,
      dataDir: p.dataDir,
      nodeArgs: ['--require', PRELOAD],
      env: { VITEST: 'true', WOOK_TEST_PROBE_LOG: p.log, WOOK_TEST_PROBE_RELEASE: p.release, WOOK_TEST_PROBE_ANSWER: p.answer },
    });
    servers.push(srv);
    writeFileSync(p.release, 'go');
    if (PAUSE) await sleep(PAUSE);
    const st = status(p.dataDir);
    expect(st.deploy).toBeNull();
    expect(runClient(entry, ['status', '--data-dir', p.dataDir]).stdout).toContain('  배포 점검     아직 없음');
    const down = runClient(entry, ['shutdown', '--data-dir', p.dataDir]);
    expect([down.code, (await srv.exited).code]).toEqual([0, 0]);
    expect(probeCalls(p.log)).toEqual([]);
    expect(readFileSync(join(p.dataDir, 'logs', 'server.log'), 'utf8')).not.toContain('배포 점검');
    expect(mainTurnsMock(p.dataDir)).toEqual([]);
  }, 300_000);
});
