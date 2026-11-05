import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaudeAdapter, type ClaudeAdapterOptions } from './claudeAdapter';
import type { CommandResult, ResolvedCli, RunCommand } from './resolveCli';
import type { TurnLaunch } from './types';

const EXE = 'C:\\Users\\tester\\.local\\bin\\claude.exe';
const RESOLVED: ResolvedCli = { kind: 'claude', path: EXE, source: 'path', npmPackageRoot: null, note: '' };
const SESSION = '0f8e3a52-1b7c-4d1e-9a3f-2b6c8d9e0a1b';
const TOKEN = 'tok-SECRET-123';
const BASE_ENV = {
  Path: 'C:\\Windows\\System32',
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  claude_effort: 'max',
  WOOK_MCP_TOKEN: 'stale-token',
  KEEP_ME: 'yes',
};

let root: string;
let cwd: string;
let addDir: string;
let image: string;
let turn = 0;
const tempDir = () => path.join(root, 'tmp turns', `TN-${String(++turn).padStart(6, '0')}`);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-claude-adapter-'));
  cwd = path.join(root, '작업 폴더 T-0001');
  addDir = path.join(root, '추가 폴더');
  image = path.join(root, '첨부 그림.png');
  await mkdir(cwd, { recursive: true });
  await mkdir(addDir, { recursive: true });
  await writeFile(image, 'png');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapter(opts: ClaudeAdapterOptions = {}) {
  return createClaudeAdapter({ resolveExecutable: async () => RESOLVED, baseEnv: () => BASE_ENV, homeDir: 'C:\\Users\\tester', platform: 'win32', ...opts });
}

function launch(over: Partial<TurnLaunch> = {}): TurnLaunch {
  return {
    format: 'claude',
    cwd,
    message: '작업 카드: README "설치" 절 고치기',
    systemPrompt: '# 욱채 팀원 작업 규칙\n- 작업 폴더 안에서만 파일을 바꾼다',
    resumeCliSessionId: null,
    newSessionId: SESSION,
    model: 'sonnet',
    effort: 'high',
    mcp: { url: 'http://127.0.0.1:53211/mcp', token: TOKEN, serverName: 'wook' },
    maxTurns: 40,
    images: [],
    addDirs: [addDir],
    tempDir: tempDir(),
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    ...over,
  };
}

const files = (dir: string) => ({ mcp: path.join(dir, 'claude-mcp.json'), system: path.join(dir, 'claude-system.md'), settings: path.join(dir, 'claude-settings.json') });

describe('Claude prepare()', () => {
  it('첫 턴: 정확한 인자 (바이패스·권한 질문 없음·MCP·지침·격리 설정·모델·노력치·반복 상한·--session-id)', async () => {
    const l = launch();
    const f = files(l.tempDir);
    const run = await adapter().prepare(l);
    expect(run.spec.command).toBe(EXE);
    expect(run.spec.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--permission-prompts',
      'none',
      '--mcp-config',
      f.mcp,
      '--strict-mcp-config',
      '--append-system-prompt-file',
      f.system,
      '--settings',
      f.settings,
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--max-turns',
      '40',
      '--add-dir',
      addDir,
      '--session-id',
      SESSION,
    ]);
    expect(run.spec.cwd).toBe(cwd);
    expect(run.spec.stdinText).toBe('작업 카드: README "설치" 절 고치기');
    expect(run.expectedCliSessionId).toBe(SESSION);
    expect(run.cleanup).toEqual([f.mcp, f.system, f.settings]);
    expect(run.spec.label).toBe('claude 첫 턴');
  });

  it('임시 파일 내용: MCP(http + Bearer 헤더), 지침(UTF-8 원문), 격리 설정', async () => {
    const l = launch();
    const f = files(l.tempDir);
    await adapter().prepare(l);
    expect(JSON.parse(await readFile(f.mcp, 'utf8'))).toEqual({
      mcpServers: { wook: { type: 'http', url: 'http://127.0.0.1:53211/mcp', headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
    expect(await readFile(f.system, 'utf8')).toBe('# 욱채 팀원 작업 규칙\n- 작업 폴더 안에서만 파일을 바꾼다');
    expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({
      disableAllHooks: true,
      claudeMdExcludes: ['C:/Users/tester/.claude/CLAUDE.md', 'C:/Users/tester/.claude/rules/**'],
    });
  });

  it('이어하기: --resume <id>만 바뀌고 바이패스·MCP·지침·격리 설정은 그대로 다시 넣는다', async () => {
    const first = await adapter().prepare(launch());
    const l = launch({ resumeCliSessionId: 'resume-me-123', newSessionId: SESSION });
    const f = files(l.tempDir);
    const run = await adapter().prepare(l);
    expect(run.spec.args.slice(-2)).toEqual(['--resume', 'resume-me-123']);
    expect(run.spec.args).not.toContain('--session-id');
    expect(run.spec.args).toContain('--dangerously-skip-permissions');
    expect(run.spec.args.slice(0, -2)).toEqual(first.spec.args.slice(0, -2).map((a) => (a.startsWith(path.dirname(first.cleanup[0]!)) ? path.join(l.tempDir, path.basename(a)) : a)));
    expect(run.expectedCliSessionId).toBe('resume-me-123');
    expect(run.spec.label).toBe('claude 이어하기');
    expect(existsSync(f.mcp) && existsSync(f.system) && existsSync(f.settings)).toBe(true);
  });

  it('환경 변수: 부모 CLI 세션 표시 변수는 대소문자 무관하게 지우고, 호출자 값은 더한다. 토큰은 환경에 넣지 않는다', async () => {
    const run = await adapter().prepare(launch());
    const env = run.spec.env;
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.claude_effort).toBeUndefined();
    expect(env.WOOK_MCP_TOKEN).toBeUndefined();
    expect(env.Path).toBe('C:\\Windows\\System32');
    expect(env.KEEP_ME).toBe('yes');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    // 앱 도구 한 번을 기다리는 시간은 메인 대화 턴만 (리드 결정 S5-18) — 이 실행에는 없다
    expect(env.MCP_TOOL_TIMEOUT).toBeUndefined();
  });

  it('메인 대화 턴(mcp.toolTimeoutSec)이면 앱 도구를 기다리는 시간을 MCP_TOOL_TIMEOUT(ms)으로 넣는다 (리드 결정 S5-18)', async () => {
    const l = launch();
    const env = (await adapter().prepare({ ...l, mcp: { ...l.mcp, toolTimeoutSec: 1860 } })).spec.env;
    expect(env.MCP_TOOL_TIMEOUT).toBe('1860000');
  });

  it('표시용 명령에는 토큰이 없다', async () => {
    const run = await adapter().prepare(launch());
    expect(run.display).not.toContain(TOKEN);
    expect(run.display).toContain('--dangerously-skip-permissions');
    expect(run.display).toContain('< 표준 입력(');
  });

  it('이미지: Claude -p는 첨부 옵션이 없어 메시지에 경로를 적는다', async () => {
    const run = await adapter().prepare(launch({ images: [image] }));
    expect(run.spec.stdinText).toBe(`작업 카드: README "설치" 절 고치기\n\n[첨부 이미지]\n- ${image}\n위 이미지 파일은 Read 도구로 열어 볼 수 있습니다.`);
  });

  it('선택 옵션: model·effort·maxTurns·addDirs·newSessionId가 없으면 빠진다, 빈 지침이면 지침 파일 없음', async () => {
    const l = launch({ model: null, effort: null, maxTurns: null, addDirs: [], newSessionId: null, systemPrompt: '  ' });
    const f = files(l.tempDir);
    const run = await adapter().prepare(l);
    expect(run.spec.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--permission-prompts', 'none', '--mcp-config', f.mcp, '--strict-mcp-config', '--settings', f.settings]);
    expect(run.expectedCliSessionId).toBeNull();
    expect(existsSync(f.system)).toBe(false);
    expect(run.cleanup).toEqual([f.mcp, f.settings]);
  });

  it('격리 끄기·스냅샷·진단 인자 옵션', async () => {
    const l = launch();
    const f = files(l.tempDir);
    const run = await adapter({ strictMcpConfig: false, disableHooks: false, excludeUserClaudeMd: false, systemPromptSnapshot: 'off', extraArgs: ['--include-hook-events'] }).prepare(l);
    expect(run.spec.args).not.toContain('--strict-mcp-config');
    expect(run.spec.args).not.toContain('--settings');
    expect(existsSync(f.settings)).toBe(false);
    expect(run.spec.args.slice(-5)).toEqual(['--add-dir', addDir, '--include-hook-events', '--session-id', SESSION]);
    expect(run.spec.args).toContain('--system-prompt-snapshot');
    expect(run.spec.args[run.spec.args.indexOf('--system-prompt-snapshot') + 1]).toBe('off');
  });

  it('CLAUDE_CONFIG_DIR가 있으면 그 폴더의 CLAUDE.md를 뺀다', async () => {
    const l = launch({ env: { CLAUDE_CONFIG_DIR: 'D:\\claude cfg\\' } });
    await adapter().prepare(l);
    expect(JSON.parse(await readFile(files(l.tempDir).settings, 'utf8')).claudeMdExcludes).toEqual(['D:/claude cfg/CLAUDE.md', 'D:/claude cfg/rules/**']);
  });

  it.each<[string, Partial<TurnLaunch>, RegExp]>([
    ['노력치', { effort: 'ultra' }, /노력치 값입니다: "ultra"/],
    ['UUID 아닌 새 세션 ID', { newSessionId: 'abc' }, /UUID여야/],
    ['상대 경로 작업 폴더', { cwd: 'relative\\dir' }, /절대 경로/],
    ['없는 작업 폴더', { cwd: path.join(os.tmpdir(), 'wook-test-없는-폴더-xyz') }, /작업 폴더가 없습니다/],
    ['빈 토큰', { mcp: { url: 'http://127.0.0.1:1/mcp', token: '', serverName: 'wook' } }, /토큰/],
    ['서버 이름', { mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', serverName: 'wook app' } }, /서버 이름/],
    ['주소', { mcp: { url: 'ftp://127.0.0.1/mcp', token: 't', serverName: 'wook' } }, /http/],
    ['반복 상한', { maxTurns: 0 }, /최대 반복 수/],
    ['모델 이름', { model: 'claude opus' }, /모델 이름/],
    ['없는 이미지', { images: [path.join(os.tmpdir(), 'wook-test-none.png')] }, /이미지 파일이 없습니다/],
  ])('잘못된 값은 한국어 오류로 거부: %s', async (_name, over, re) => {
    await expect(adapter().prepare(launch(over))).rejects.toThrow(re);
  });

  it('임시 파일을 쓸 수 없으면 오류, 일부 쓴 파일은 남기지 않는다', async () => {
    const blocker = path.join(root, 'blocker-file');
    await writeFile(blocker, 'x');
    await expect(adapter().prepare(launch({ tempDir: path.join(blocker, 'sub') }))).rejects.toThrow(/임시 파일을 쓰지 못했습니다/);
  });

  it('실행 파일을 찾지 못하면 prepare가 거부된다', async () => {
    const a = createClaudeAdapter({
      resolveExecutable: async () => {
        throw new Error('Claude Code 실행 파일(claude.exe)을 PATH와 기본 설치 위치에서 찾지 못했습니다');
      },
    });
    await expect(a.prepare(launch())).rejects.toThrow(/찾지 못했습니다/);
  });

  it('createParser는 이 턴의 앱 도구 서버 이름으로 구분한다', () => {
    const p = adapter().createParser(launch({ mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', serverName: 'wook2' } }));
    const [e] = p.pushLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__wook2__get_work_context', input: {} }] } }));
    expect(e).toMatchObject({ kind: 'mcp_call', text: '앱 도구 호출: get_work_context' });
  });
});

describe('Claude detect()', () => {
  const ok = (stdout: string, code = 0): CommandResult => ({ code, stdout, stderr: '', timedOut: false, error: null });

  it('버전·로그인 확인 명령과 결과', async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (file, args, o) => {
      calls.push([file, ...args]);
      expect(o.env.CLAUDECODE).toBeUndefined();
      return args[0] === '--version' ? ok('2.1.311 (Claude Code)\n') : ok('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}');
    };
    const st = await adapter({ runCommand: run }).detect();
    expect(calls).toEqual([
      [EXE, '--version'],
      [EXE, 'auth', 'status', '--json'],
    ]);
    expect(st).toMatchObject({ installed: true, path: EXE, version: '2.1.311', loggedIn: true, problem: null });
    expect(st.detail).toContain('로그인됨 (claude.ai)');
  });

  it('검증 범위 밖 버전·로그인 안 됨', async () => {
    const run: RunCommand = async (_f, args) => (args[0] === '--version' ? ok('2.2.0 (Claude Code)') : ok('{"loggedIn":false,"authMethod":"none"}', 1));
    const st = await adapter({ runCommand: run }).detect();
    expect(st.version).toBe('2.2.0');
    expect(st.loggedIn).toBe(false);
    expect(st.problem).toMatch(/검증된 버전 범위\(Claude Code 2\.1\.x\) 밖입니다: 2\.2\.0/);
  });

  it('실행 파일을 못 찾으면 installed=false', async () => {
    const st = await createClaudeAdapter({
      resolveExecutable: async () => {
        throw new Error('찾지 못했습니다');
      },
    }).detect();
    expect(st).toEqual({ installed: false, path: null, version: null, loggedIn: null, problem: '찾지 못했습니다', detail: '찾지 못했습니다' });
  });
});
