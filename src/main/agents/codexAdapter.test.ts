import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexMessageWithInstructions, createCodexAdapter, tomlString, type CodexAdapterOptions } from './codexAdapter';
import { codexScreenFeatures, parseCodexFeatureNames, type CommandResult, type ResolvedCli, type RunCommand } from './resolveCli';
import type { TurnLaunch } from './types';

const ROOT_PKG = 'C:\\npm\\node_modules\\@openai\\codex';
const EXE = `${ROOT_PKG}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const RESOLVED: ResolvedCli = { kind: 'codex', path: EXE, source: 'path', npmPackageRoot: ROOT_PKG, note: '' };
const TOKEN = 'tok-CODEX-SECRET';
const SYSTEM = '# 규칙\n- "따옴표"와 \'작은따옴표\'\n- 경로 C:\\work\\a\tb\r\n끝 \u0001';
const BASE_ENV = { PATH: 'C:\\Windows', CLAUDECODE: '1', WOOK_MCP_TOKEN: 'stale', CODEX_MANAGED_BY_BUN: '1', KEEP: 'yes' };

/** TOML 기본 문자열 해석 (시험용): tomlString 결과가 원문으로 되돌아오는지 확인 */
function decodeTomlBasic(s: string): string {
  expect(s.startsWith('"') && s.endsWith('"')).toBe(true);
  const body = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"') throw new Error('따옴표가 이스케이프되지 않음');
    if (c.charCodeAt(0) < 0x20 && c !== '\t') throw new Error('제어 문자가 이스케이프되지 않음');
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i]!;
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (n in simple) out += simple[n];
    else if (n === 'u') {
      out += String.fromCodePoint(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else throw new Error(`알 수 없는 이스케이프 \\${n}`);
  }
  return out;
}

let root: string;
let cwd: string;
let img: string;
let imgComma: string;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-codex-adapter-'));
  cwd = path.join(root, '작업 폴더 T-0002');
  await mkdir(cwd, { recursive: true });
  img = path.join(root, '화면 1.png');
  imgComma = path.join(root, 'a,b 화면.png');
  await writeFile(img, 'png1');
  await writeFile(imgComma, 'png2');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapter(opts: CodexAdapterOptions = {}) {
  return createCodexAdapter({ resolveExecutable: async () => RESOLVED, baseEnv: () => BASE_ENV, platform: 'win32', ...opts });
}

function launch(over: Partial<TurnLaunch> = {}): TurnLaunch {
  return {
    format: 'codex',
    cwd,
    message: '작업 카드: 로그인 화면 수정',
    systemPrompt: SYSTEM,
    resumeCliSessionId: null,
    newSessionId: null,
    model: 'gpt-5-codex',
    effort: 'low',
    mcp: { url: 'http://127.0.0.1:53211/mcp', token: TOKEN, serverName: 'wook' },
    maxTurns: 30,
    images: [],
    addDirs: [path.join(root, 'ignored')],
    tempDir: path.join(root, 'tmp turns', `TN-${++n}`),
    env: { CODEX_API_KEY: 'sk-codex' },
    ...over,
  };
}

describe('Codex prepare()', () => {
  it('첫 턴: exec + 바이패스 + -C + 모델·노력치 + MCP(url·토큰 환경 변수·필수) + developer_instructions + 표준 입력(-)', async () => {
    const run = await adapter().prepare(launch());
    expect(run.spec.command).toBe(EXE);
    expect(run.spec.args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--disable',
      'hooks',
      '--disable',
      'apps',
      '--disable',
      'computer_use',
      '--disable',
      'browser_use',
      '-C',
      cwd,
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      'mcp_servers.wook.url="http://127.0.0.1:53211/mcp"',
      '-c',
      'mcp_servers.wook.bearer_token_env_var="WOOK_MCP_TOKEN"',
      '-c',
      'mcp_servers.wook.required=true',
      '-c',
      `developer_instructions=${tomlString(SYSTEM)}`,
      '-',
    ]);
    expect(run.spec.cwd).toBe(cwd);
    expect(run.spec.stdinText).toBe('작업 카드: 로그인 화면 수정');
    expect(run.expectedCliSessionId).toBeNull();
    expect(run.cleanup).toEqual([]);
    expect(run.spec.label).toBe('codex 첫 턴');
  });

  it('메인 대화 턴(mcp.toolTimeoutSec)만 앱 도구를 기다리는 시간을 넣는다 — bearer 토큰 바로 뒤, 없으면 넣지 않는다 (리드 결정 S5-18)', async () => {
    const l = launch();
    const run = await adapter().prepare({ ...l, mcp: { ...l.mcp, toolTimeoutSec: 1860 } });
    const i = run.spec.args.indexOf('mcp_servers.wook.bearer_token_env_var="WOOK_MCP_TOKEN"');
    expect(run.spec.args.slice(i + 1, i + 3)).toEqual(['-c', 'mcp_servers.wook.tool_timeout_sec=1860']);
    expect((await adapter().prepare(launch())).spec.args.some((a) => a.includes('tool_timeout_sec'))).toBe(false);
  });

  it('developer_instructions 값은 TOML 기본 문자열로 원문이 그대로 되돌아온다 (줄바꿈·따옴표·역슬래시·탭·제어 문자·한글)', async () => {
    const run = await adapter().prepare(launch());
    const arg = run.spec.args.find((a) => a.startsWith('developer_instructions='))!;
    expect(arg).not.toMatch(/[\n\r]/);
    expect(decodeTomlBasic(arg.slice('developer_instructions='.length))).toBe(SYSTEM);
  });

  it('이어하기: exec resume <thread_id> - , -C 없음, 바이패스·MCP·지침은 매번', async () => {
    const run = await adapter().prepare(launch({ resumeCliSessionId: '01a17c5f-3171-75a0-b0c0-ef0b38838ec1' }));
    expect(run.spec.args).toEqual([
      'exec',
      'resume',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--disable',
      'hooks',
      '--disable',
      'apps',
      '--disable',
      'computer_use',
      '--disable',
      'browser_use',
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      'mcp_servers.wook.url="http://127.0.0.1:53211/mcp"',
      '-c',
      'mcp_servers.wook.bearer_token_env_var="WOOK_MCP_TOKEN"',
      '-c',
      'mcp_servers.wook.required=true',
      '-c',
      `developer_instructions=${tomlString(SYSTEM)}`,
      '01a17c5f-3171-75a0-b0c0-ef0b38838ec1',
      '-',
    ]);
    expect(run.spec.cwd).toBe(cwd);
    expect(run.expectedCliSessionId).toBe('01a17c5f-3171-75a0-b0c0-ef0b38838ec1');
    expect(run.spec.label).toBe('codex 이어하기');
  });

  it('환경 변수: 토큰은 WOOK_MCP_TOKEN(묵은 값 대체), npm 런처 표시 재현, 부모 세션 변수 제거, 호출자 값 추가', async () => {
    const env = (await adapter().prepare(launch())).spec.env;
    expect(env.WOOK_MCP_TOKEN).toBe(TOKEN);
    expect(env.CODEX_MANAGED_BY_NPM).toBe('1');
    expect(env.CODEX_MANAGED_PACKAGE_ROOT).toBe(ROOT_PKG);
    expect(env.CODEX_MANAGED_BY_BUN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CODEX_API_KEY).toBe('sk-codex');
    expect(env.KEEP).toBe('yes');
  });

  it('npm 설치본이 아니면 CODEX_MANAGED_* 를 넣지 않는다', async () => {
    const env = (await createCodexAdapter({ resolveExecutable: async () => ({ ...RESOLVED, path: 'C:\\bin\\codex.exe', npmPackageRoot: null }), baseEnv: () => ({}), platform: 'win32' }).prepare(launch())).spec.env;
    expect(env.CODEX_MANAGED_BY_NPM).toBeUndefined();
  });

  it('이미지: -i를 맨 앞에 두어 뒤의 "-"를 이미지로 먹지 않게, 쉼표 경로는 임시 사본(정리 목록)', async () => {
    const l = launch({ images: [img, imgComma] });
    const run = await adapter().prepare(l);
    const copy = path.join(l.tempDir, 'codex-image-2.png');
    expect(run.spec.args.slice(0, 6)).toEqual(['exec', '-i', img, '-i', copy, '--json']);
    expect(run.spec.args.at(-1)).toBe('-');
    expect(run.cleanup).toEqual([copy]);
    expect(await readFile(copy, 'utf8')).toBe('png2');
    const resumed = await adapter().prepare(launch({ images: [img], resumeCliSessionId: 'th' }));
    expect(resumed.spec.args.slice(0, 5)).toEqual(['exec', 'resume', '-i', img, '--json']);
  });

  it('지침 전달 방식 message: 메시지 앞에 구분 블록, developer_instructions 없음', async () => {
    const run = await adapter({ systemPromptMode: 'message' }).prepare(launch());
    expect(run.spec.args.some((a) => a.startsWith('developer_instructions='))).toBe(false);
    expect(run.spec.stdinText).toBe(codexMessageWithInstructions(SYSTEM, '작업 카드: 로그인 화면 수정'));
    expect(run.spec.stdinText!.startsWith('<wook_instructions>\n')).toBe(true);
    expect(run.spec.stdinText!.endsWith('</wook_instructions>\n\n작업 카드: 로그인 화면 수정')).toBe(true);
  });

  it('지침이 Windows 명령줄 한도에 가까우면 메시지로 옮기고 표시에 남긴다', async () => {
    const long = '규칙 '.repeat(12_000);
    const run = await adapter().prepare(launch({ systemPrompt: long }));
    expect(run.spec.args.some((a) => a.startsWith('developer_instructions='))).toBe(false);
    expect(run.spec.stdinText).toContain(long.trim());
    expect(run.display).toContain('지침이 길어 메시지 앞에 붙임');
  });

  it('requireMcp=false, 빈 지침, 모델·노력치 없음', async () => {
    const run = await adapter({ requireMcp: false }).prepare(launch({ systemPrompt: '', model: null, effort: null }));
    expect(run.spec.args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--disable',
      'hooks',
      '--disable',
      'apps',
      '--disable',
      'computer_use',
      '--disable',
      'browser_use',
      '-C',
      cwd,
      '-c',
      'mcp_servers.wook.url="http://127.0.0.1:53211/mcp"',
      '-c',
      'mcp_servers.wook.bearer_token_env_var="WOOK_MCP_TOKEN"',
      '-',
    ]);
    expect(run.spec.stdinText).toBe('작업 카드: 로그인 화면 수정');
  });

  it('표시용 명령: 토큰 없음, 긴 지침은 줄여서', async () => {
    const run = await adapter().prepare(launch({ systemPrompt: 'x'.repeat(500) }));
    expect(run.display).not.toContain(TOKEN);
    expect(run.display).toContain('…(502자)');
  });

  it('노력치: 설치된 모델 목록이 받는 값만 (none·minimal·ultra 거부, max는 그대로 넘김 — windows:F7)', async () => {
    for (const bad of ['none', 'minimal', 'ultra', 'turbo']) {
      await expect(adapter().prepare(launch({ effort: bad }))).rejects.toThrow(/Codex에서 쓸 수 없는 노력치/);
    }
    for (const ok of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const run = await adapter().prepare(launch({ effort: ok }));
      expect(run.spec.args).toContain(`model_reasoning_effort="${ok}"`);
    }
  });

  it('대표 개인 설정 격리 (windows:F1): 첫 턴·이어하기 모두 사용자 config·훅·내장 연결 서버를 끄고 thread_id·- 앞에 둔다', async () => {
    // Codex 내장 화면·브라우저 조작도 끈다 (리드 결정 S6-7)
    const isolation = ['--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'computer_use', '--disable', 'browser_use'];
    const at = (args: string[]) => args.indexOf('--ignore-user-config');
    for (const l of [launch(), launch({ resumeCliSessionId: '01a17c5f-3171-75a0-b0c0-ef0b38838ec1' })]) {
      const args = (await adapter().prepare(l)).spec.args;
      const i = at(args);
      expect(i).toBeGreaterThan(0);
      expect(args.slice(i, i + isolation.length)).toEqual(isolation);
      // 앱 도구 서버(wook)는 -c로 따로 넣는다 — 개인 MCP 서버 없이 이것 하나만 남는다
      expect(args.filter((a) => a.startsWith('mcp_servers.')).every((a) => a.startsWith('mcp_servers.wook.'))).toBe(true);
      expect(i).toBeLessThan(args.length - 2);
    }
    // 진단용(실제 CLI 수집 기준선)으로만 끈다
    const raw = (await adapter({ isolateUserConfig: false }).prepare(launch())).spec.args;
    expect(raw).not.toContain('--ignore-user-config');
    expect(raw).not.toContain('--disable');
  });

  it('createParser는 codex 형식', () => {
    const p = adapter().createParser(launch());
    expect(p.pushLine('{"type":"thread.started","thread_id":"t-1"}')[0]).toMatchObject({ kind: 'session', data: { cliSessionId: 't-1' } });
  });
});

describe('tomlString', () => {
  it.each([
    ['plain', '"plain"'],
    ['a"b', '"a\\"b"'],
    ['C:\\x', '"C:\\\\x"'],
    ['줄1\n줄2', '"줄1\\n줄2"'],
    ['\u0001\u007f', '"\\u0001\\u007f"'],
    ['\ud800', '"\ufffd"'],
  ])('%j → %s', (input, expected) => {
    expect(tomlString(input)).toBe(expected);
  });
});

/** `codex features list`의 출력 흉내 (실제 0.163.0·0.167.0의 줄 모양: 이름 · 단계 · true|false) */
const featureLines = (rows: [string, string, boolean][]): string => rows.map(([name, stage, on]) => `${name.padEnd(40)} ${stage.padEnd(18)} ${on}`).join('\n') + '\n';
const FEATURES_0163 = featureLines([
  ['apps', 'stable', true],
  ['browser_use', 'stable', true],
  ['computer_use', 'stable', true],
  ['hooks', 'stable', true],
  ['image_detail_original', 'removed', false],
]);
/** 0.167.0: browser_use_external·browser_use_full_cdp_access가 더 있다. 앞머리가 다른 이웃(in_app_browser·browser_annotation_api)은 끄지 않는다 */
const FEATURES_0167 = featureLines([
  ['agent_message_board', 'under development', false],
  ['apps', 'stable', true],
  ['browser_annotation_api', 'stable', true],
  ['browser_use', 'stable', true],
  ['browser_use_external', 'stable', true],
  ['browser_use_full_cdp_access', 'stable', true],
  ['computer_use', 'stable', true],
  ['guardianv2.thread_context', 'removed', false],
  ['hooks', 'stable', true],
  ['in_app_browser', 'stable', true],
  ['in_app_local_automation', 'stable', true],
]);

describe('Codex 내장 화면·브라우저 조작 끄기 — 설치된 버전의 기능 목록에서 (S6-21 E4)', () => {
  const r = (stdout: string, code = 0, stderr = ''): CommandResult => ({ code, stdout, stderr, timedOut: false, error: null });
  /** 그 기능 목록을 내놓는 가짜 CLI */
  const cliWith = (features: () => CommandResult | Promise<CommandResult>): { run: RunCommand; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_file, args) => {
        calls.push(args);
        if (args[0] === '--version') return r('codex-cli 0.167.0\n');
        return args[0] === 'features' ? features() : r('', 0, 'Logged in using ChatGPT\n');
      },
    };
  };
  /** --disable 뒤의 이름들 (나온 순서) */
  const disabled = (args: string[]): string[] => args.flatMap((a, i) => (a === '--disable' ? [args[i + 1]!] : []));

  it('기능 목록을 읽는다 — 이름·단계·값의 줄만, 화면·브라우저 조작은 앞머리 computer_use·browser_use', () => {
    expect(parseCodexFeatureNames(FEATURES_0167)).toEqual(['agent_message_board', 'apps', 'browser_annotation_api', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'guardianv2.thread_context', 'hooks', 'in_app_browser', 'in_app_local_automation']);
    expect(codexScreenFeatures(parseCodexFeatureNames(FEATURES_0167))).toEqual(['browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use']);
    expect(parseCodexFeatureNames('error: unrecognized subcommand\n\nUsage: codex [OPTIONS]\n')).toEqual([]);
    expect(parseCodexFeatureNames('')).toEqual([]);
  });

  it('0.167의 목록이면 네 이름을 모두 끄고, 0.163의 목록이면 둘만 — 그 버전이 내놓지 않는 이름은 넘기지 않는다. 첫 턴·이어하기 모두', async () => {
    const new167 = cliWith(() => r(FEATURES_0167));
    for (const l of [launch(), launch({ resumeCliSessionId: '01a17c5f-3171-75a0-b0c0-ef0b38838ec1' })]) {
      const args = (await adapter({ runCommand: new167.run }).prepare(l)).spec.args;
      expect(disabled(args)).toEqual(['hooks', 'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use']);
      // 격리 옵션 바로 뒤, thread_id·- 앞
      expect(args.indexOf('computer_use')).toBeLessThan(args.length - 2);
    }
    const old163 = cliWith(() => r(FEATURES_0163));
    expect(disabled((await adapter({ runCommand: old163.run }).prepare(launch())).spec.args)).toEqual(['hooks', 'apps', 'browser_use', 'computer_use']);
    // 그런 기능이 없는 버전이면 아무 이름도 더하지 않는다 (모르는 이름을 넘기면 CLI가 실행을 거부한다)
    const none = cliWith(() => r(featureLines([['apps', 'stable', true], ['hooks', 'stable', true]])));
    expect(disabled((await adapter({ runCommand: none.run }).prepare(launch())).spec.args)).toEqual(['hooks', 'apps']);
    const onlyComputer = cliWith(() => r(featureLines([['apps', 'stable', true], ['computer_use', 'experimental', false], ['hooks', 'stable', true]])));
    expect(disabled((await adapter({ runCommand: onlyComputer.run }).prepare(launch())).spec.args)).toEqual(['hooks', 'apps', 'computer_use']);
  });

  it('기능 목록은 실행 파일마다 한 번 읽는다 — 턴마다 다시 읽지 않고, 함께 온 요청은 같은 읽기를 기다린다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = cliWith(async () => {
      await gate;
      return r(FEATURES_0167);
    });
    const a = adapter({ runCommand: slow.run });
    const both = Promise.all([a.prepare(launch()), a.prepare(launch())]);
    release();
    const [x, y] = await both;
    await a.prepare(launch());
    expect(slow.calls.filter((c) => c[0] === 'features')).toHaveLength(1);
    expect(disabled(x.spec.args)).toEqual(disabled(y.spec.args));
    expect(disabled(x.spec.args)).toContain('browser_use_full_cdp_access');
  });

  it('기능 목록을 읽지 못하면(명령 실패·알아볼 줄 없음·시간 초과) 확인된 두 이름으로 끈다 — 끄지 않은 채 띄우지 않는다', async () => {
    for (const bad of [
      (): CommandResult => r('', 2, "error: unrecognized subcommand 'features'\n"),
      (): CommandResult => r('아무 줄\n'),
      (): CommandResult => ({ code: null, stdout: '', stderr: '', timedOut: true, error: null }),
      (): CommandResult => ({ code: null, stdout: '', stderr: '', timedOut: false, error: 'ENOENT: spawn codex.exe ENOENT' }),
    ]) {
      const cli = cliWith(bad);
      const a = adapter({ runCommand: cli.run });
      expect(disabled((await a.prepare(launch())).spec.args)).toEqual(['hooks', 'apps', 'computer_use', 'browser_use']);
      // 읽지 못한 것도 한동안 기억한다 — 턴마다 실패하는 명령을 다시 돌리지 않는다
      await a.prepare(launch());
      expect(cli.calls.filter((c) => c[0] === 'features')).toHaveLength(1);
    }
    const st = await adapter({ runCommand: cliWith(() => r('', 2, 'error: unrecognized subcommand\n')).run }).detect();
    expect(st.detail).toContain('기능 목록(features list)을 읽지 못해 computer_use·browser_use만 끕니다');
    expect(st.problem).toBeNull();
  });

  it('개인 설정 격리를 끈 실행에는 --disable을 붙이지 않고 기능 목록도 읽지 않는다', async () => {
    const cli = cliWith(() => r(FEATURES_0167));
    const args = (await adapter({ runCommand: cli.run, isolateUserConfig: false }).prepare(launch())).spec.args;
    expect(args).not.toContain('--disable');
    expect(cli.calls).toEqual([]);
  });
});

describe('Codex detect()', () => {
  const r = (stdout: string, code = 0, stderr = ''): CommandResult => ({ code, stdout, stderr, timedOut: false, error: null });

  it('codex --version · codex login status · codex features list (기능 목록은 실행 파일마다 한 번 — S6-21 E4)', async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === '--version') return r('codex-cli 0.163.0\n');
      return args[0] === 'features' ? r(FEATURES_0163) : r('', 0, 'Logged in using ChatGPT\n');
    };
    const a = adapter({ runCommand: run });
    const st = await a.detect();
    expect(calls).toEqual([
      [EXE, '--version'],
      [EXE, 'login', 'status'],
      [EXE, 'features', 'list'],
    ]);
    expect(st).toMatchObject({ installed: true, version: '0.163.0', loggedIn: true, problem: null });
    expect(st.detail).toContain('내장 화면·브라우저 조작 끔 (browser_use, computer_use)');
    // 다시 확인해도, 턴을 띄워도 기능 목록은 다시 읽지 않는다
    await a.detect();
    await a.prepare(launch());
    expect(calls.filter((c) => c[1] === 'features')).toHaveLength(1);
  });

  it('기능 목록은 로그인 확인과 함께 읽는다 — CLI 확인을 늦추지 않고, 읽기가 시간 초과로 끝나도 확인 결과(problem·로그인)는 그대로다 (S6-21 E4)', async () => {
    let featuresAsked = false;
    let loginSawFeatures: boolean | null = null;
    const run: RunCommand = async (_f, args) => {
      if (args[0] === '--version') return r('codex-cli 0.167.0\n');
      if (args[0] === 'features') {
        featuresAsked = true;
        return { code: null, stdout: '', stderr: '', timedOut: true, error: null };
      }
      // 로그인 확인은 기능 목록을 묻기 전에는 끝나지 않는다 — 차례로 돌면 1초를 기다린 뒤 묻지 않은 채 끝난다
      for (let i = 0; i < 100 && !featuresAsked; i++) await new Promise((res) => setTimeout(res, 10));
      loginSawFeatures = featuresAsked;
      return r('', 0, 'Logged in using ChatGPT\n');
    };
    const st = await adapter({ runCommand: run }).detect();
    expect(loginSawFeatures).toBe(true);
    expect(st).toMatchObject({ installed: true, version: '0.167.0', loggedIn: true, problem: null });
    expect(st.detail).toContain('기능 목록(features list)을 읽지 못해 computer_use·browser_use만 끕니다 (20초 안에 끝나지 않음)');
  });

  it('로그인 안 됨 / 실행 실패', async () => {
    const notLogged: RunCommand = async (_f, args) => (args[0] === '--version' ? r('codex-cli 0.163.0') : r('Not logged in\n', 1));
    expect((await adapter({ runCommand: notLogged }).detect()).loggedIn).toBe(false);
    const broken: RunCommand = async () => ({ code: null, stdout: '', stderr: '', timedOut: false, error: 'ENOENT: spawn codex.exe ENOENT' });
    const st = await adapter({ runCommand: broken }).detect();
    expect(st.problem).toMatch(/실행하지 못했습니다: ENOENT/);
    expect(st.loggedIn).toBeNull();
  });
});

describe('정리', () => {
  it('임시 사본이 실제로 생겼다가 정리 목록에 있다', async () => {
    const l = launch({ images: [imgComma] });
    const run = await adapter().prepare(l);
    expect(run.cleanup.every((f) => existsSync(f))).toBe(true);
  });
});
