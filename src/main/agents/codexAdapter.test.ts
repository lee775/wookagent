import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexMessageWithInstructions, createCodexAdapter, tomlString, type CodexAdapterOptions } from './codexAdapter';
import type { CommandResult, ResolvedCli, RunCommand } from './resolveCli';
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
    const isolation = ['--ignore-user-config', '--disable', 'hooks', '--disable', 'apps'];
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

describe('Codex detect()', () => {
  const r = (stdout: string, code = 0, stderr = ''): CommandResult => ({ code, stdout, stderr, timedOut: false, error: null });

  it('codex --version · codex login status', async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (file, args) => {
      calls.push([file, ...args]);
      return args[0] === '--version' ? r('codex-cli 0.163.0\n') : r('', 0, 'Logged in using ChatGPT\n');
    };
    const st = await adapter({ runCommand: run }).detect();
    expect(calls).toEqual([
      [EXE, '--version'],
      [EXE, 'login', 'status'],
    ]);
    expect(st).toMatchObject({ installed: true, version: '0.163.0', loggedIn: true, problem: null });
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
