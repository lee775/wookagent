/**
 * Codex 어댑터 (15.3, 15.5, ARCHITECTURE 12장). codex-cli 0.163 네이티브 실행 파일에서 옵션을 확인했다.
 *
 * 첫 턴:   codex exec [-i 이미지]... --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
 *              --ignore-user-config --disable hooks --disable apps
 *              -C <cwd> [-m M] [-c model_reasoning_effort="E"]
 *              -c mcp_servers.<이름>.url="..." -c mcp_servers.<이름>.bearer_token_env_var="WOOK_MCP_TOKEN"
 *              [-c mcp_servers.<이름>.required=true] [-c developer_instructions="..."] -
 * 이어하기: codex exec resume [-i 이미지]... --json ...(같은 옵션, 단 -C 없음) <thread_id> -
 *
 * - exec resume는 -C/--cd·--add-dir·--sandbox를 받지 않는다 → 작업 폴더는 실행 위치(cwd)로 정한다.
 * - -i는 exec에서 값 여러 개를 받고 쉼표로도 나눈다 → 맨 앞에 두어 뒤의 '-'를 삼키지 않게 하고, 쉼표 경로는 임시 사본으로 바꾼다.
 * - 바이패스 상태에서는 샌드박스가 없으므로 --add-dir가 의미 없다 (넣지 않음).
 * - 대표 개인 설정과 떼어 놓는다 (Claude 어댑터의 --strict-mcp-config·훅 끄기와 같은 목적, windows:F1):
 *   --ignore-user-config = $CODEX_HOME/config.toml(개인 MCP 서버·notify·플러그인·기본 모델·프로필)을 읽지 않음 (로그인은 그대로),
 *   --disable hooks = 개인 훅(hooks.json·플러그인 훅: 업무일지 Stop 훅 등), --disable apps = 내장 연결 서버 codex_apps.
 *   그래서 모델을 정하지 않은 팀원은 턴 실행기가 모델 목록 첫 항목을 넘긴다. ~/.codex/AGENTS.md(개인 전역 지침)는 끌 방법이 없어
 *   앱 작업 규칙(prompts.ts)에서 개인 작업 규칙을 따르지 않게 한다
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAdapter, CliStatus, EventParser, PreparedRun, TurnLaunch } from './types';
import { CODEX_EFFORTS, LaunchError, abbreviateArg, buildChildEnv, displayCommand, validateLaunch } from './common';
import { cliLauncherEnv, detectCli, resolveCli, type ResolvedCli } from './resolveCli';
import { createCodexParser } from './parsers/codexParser';
import type { AdapterBaseOptions } from './claudeAdapter';

export interface CodexAdapterOptions extends AdapterBaseOptions {
  /**
   * 역할 지침 전달 방식.
   * developer_instructions = -c developer_instructions="..." (0.163에서 세션 기록에 그대로 들어가는 것 확인)
   * message = 메시지 앞에 구분 블록으로 붙임
   */
  systemPromptMode?: 'developer_instructions' | 'message';
  /** 앱 도구 서버 연결에 실패하면 턴을 바로 실패시킨다 (mcp_servers.<이름>.required=true). 기본 true */
  requireMcp?: boolean;
  /**
   * 대표 개인 Codex 설정을 팀원 세션에 넣지 않는다 (--ignore-user-config --disable hooks --disable apps). 기본 true.
   * 바이패스에서는 개인 MCP 도구(메신저 전송·배포 등)도 승인 없이 돌고, 개인 Stop 훅이 턴을 이어 가게 해 턴 판정(CLI-18)이 깨진다 (windows:F1)
   */
  isolateUserConfig?: boolean;
}

/** 대표 개인 설정을 떼어 놓는 옵션 (첫 턴·이어하기 모두 받는다) */
export const CODEX_ISOLATION_ARGS: readonly string[] = ['--ignore-user-config', '--disable', 'hooks', '--disable', 'apps'];

/** codex가 앱 도구 토큰을 읽을 환경 변수 */
export const CODEX_TOKEN_ENV = 'WOOK_MCP_TOKEN';
/** Windows 명령줄 한도(32767자)보다 넉넉히 작게 — 넘으면 지침을 메시지로 옮긴다 */
const MAX_COMMAND_LINE = 30_000;

export function createCodexAdapter(opts: CodexAdapterOptions = {}): AgentAdapter {
  const platform = opts.platform ?? process.platform;
  const resolveExe = async (): Promise<ResolvedCli> => {
    if (opts.resolveExecutable) return opts.resolveExecutable();
    const r = await resolveCli('codex', { override: opts.pathOverride?.() ?? null, platform, env: opts.baseEnv?.() ?? process.env });
    if (!r.ok) throw new LaunchError(r.reason, true); // 실행 파일 문제 → AI 종류 단위로 막는다 (CLI-15)
    return r.cli;
  };

  return {
    kind: 'codex',
    async detect(): Promise<CliStatus> {
      if (opts.resolveExecutable) {
        let resolved: ResolvedCli;
        try {
          resolved = await opts.resolveExecutable();
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return { installed: false, path: null, version: null, loggedIn: null, problem: reason, detail: reason };
        }
        return detectCli('codex', { platform, env: opts.baseEnv?.(), statusEnv: opts.statusEnv?.(), run: opts.runCommand, resolved: { ok: true, cli: resolved } });
      }
      return detectCli('codex', { override: opts.pathOverride?.() ?? null, platform, env: opts.baseEnv?.(), statusEnv: opts.statusEnv?.(), run: opts.runCommand });
    },
    async prepare(launch: TurnLaunch): Promise<PreparedRun> {
      const { resume } = await validateLaunch('Codex', launch, CODEX_EFFORTS);
      const cli = await resolveExe();

      // 쉼표가 든 이미지 경로는 codex가 둘로 나누므로 임시 사본으로 바꾼다
      const images: string[] = [];
      const cleanup: string[] = [];
      try {
        for (const [i, img] of launch.images.entries()) {
          if (!img.includes(',')) {
            images.push(img);
            continue;
          }
          await mkdir(launch.tempDir, { recursive: true });
          const copy = path.join(launch.tempDir, `codex-image-${i + 1}${path.extname(img).replace(/,/g, '')}`);
          await copyFile(img, copy);
          cleanup.push(copy);
          images.push(copy);
        }
      } catch (e) {
        await Promise.all(cleanup.map((f) => rm(f, { force: true })));
        throw new LaunchError(`첨부 이미지 사본을 만들지 못했습니다 (${launch.tempDir}): ${e instanceof Error ? e.message : String(e)}`);
      }

      const wantDev = (opts.systemPromptMode ?? 'developer_instructions') === 'developer_instructions' && launch.systemPrompt.trim() !== '';
      const common = { images, requireMcp: opts.requireMcp ?? true, isolateUserConfig: opts.isolateUserConfig ?? true };
      let args = buildCodexArgs(launch, { ...common, developerInstructions: wantDev ? launch.systemPrompt : null });
      let promptInMessage = !wantDev && launch.systemPrompt.trim() !== '';
      if (wantDev && commandLineLength(cli.path, args) > MAX_COMMAND_LINE) {
        args = buildCodexArgs(launch, { ...common, developerInstructions: null });
        promptInMessage = true;
      }
      const stdinText = promptInMessage ? codexMessageWithInstructions(launch.systemPrompt, launch.message) : launch.message;
      const env = buildChildEnv(opts.baseEnv?.() ?? process.env, { ...cliLauncherEnv(cli), ...launch.env, [CODEX_TOKEN_ENV]: launch.mcp.token }, platform);
      const shown = args.map((a) => (a.startsWith('developer_instructions=') ? `developer_instructions=${abbreviateArg(a.slice('developer_instructions='.length))}` : a));
      return {
        spec: { command: cli.path, args, cwd: launch.cwd, env, stdinText, label: resume ? 'codex 이어하기' : 'codex 첫 턴' },
        expectedCliSessionId: resume ? launch.resumeCliSessionId : null,
        cleanup,
        display: displayCommand(cli.path, shown, stdinText.length) + (promptInMessage && wantDev ? ' (지침이 길어 메시지 앞에 붙임)' : ''),
      };
    },
    createParser(launch: TurnLaunch): EventParser {
      return createCodexParser({ serverName: launch.mcp.serverName, now: opts.now, timeZone: opts.timeZone });
    },
  };
}

export function buildCodexArgs(
  launch: TurnLaunch,
  o: { images: string[]; developerInstructions: string | null; requireMcp: boolean; isolateUserConfig?: boolean },
): string[] {
  const resume = launch.resumeCliSessionId !== null;
  const name = launch.mcp.serverName;
  const args = resume ? ['exec', 'resume'] : ['exec'];
  for (const img of o.images) args.push('-i', img);
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
  if (o.isolateUserConfig ?? true) args.push(...CODEX_ISOLATION_ARGS);
  if (!resume) args.push('-C', launch.cwd);
  if (launch.model) args.push('-m', launch.model);
  if (launch.effort) args.push('-c', `model_reasoning_effort=${tomlString(launch.effort)}`);
  args.push('-c', `mcp_servers.${name}.url=${tomlString(launch.mcp.url)}`);
  args.push('-c', `mcp_servers.${name}.bearer_token_env_var=${tomlString(CODEX_TOKEN_ENV)}`);
  // 앱 도구 한 번을 기다리는 시간 — 메인 대화 턴만, host_exec 상한보다 길게 (리드 결정 S5-18)
  if (launch.mcp.toolTimeoutSec) args.push('-c', `mcp_servers.${name}.tool_timeout_sec=${launch.mcp.toolTimeoutSec}`);
  if (o.requireMcp) args.push('-c', `mcp_servers.${name}.required=true`);
  if (o.developerInstructions !== null) args.push('-c', `developer_instructions=${tomlString(o.developerInstructions)}`);
  if (resume) args.push(launch.resumeCliSessionId!);
  args.push('-');
  return args;
}

/**
 * TOML 기본 문자열. -c 값은 TOML로 해석하고 실패하면 원문 그대로 쓰이므로(따옴표가 남는다) 반드시 올바르게 감싼다.
 * 짝 없는 서로게이트는 UTF-8로 쓸 수 없어 U+FFFD로 바꾼다.
 */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (c >= 0xd800 && c <= 0xdfff) out += '\uFFFD';
    else out += ch;
  }
  return `${out}"`;
}

/** developer_instructions를 못 쓸 때: 메시지 앞에 구분 블록으로 붙인다 */
export function codexMessageWithInstructions(systemPrompt: string, message: string): string {
  return `<wook_instructions>\n아래는 욱채 프로그램이 넣는 작업 규칙이다. 이 턴에도 그대로 따른다.\n\n${systemPrompt.trim()}\n</wook_instructions>\n\n${message}`;
}

/** Windows CreateProcess 명령줄 길이 근사 (따옴표·이스케이프 포함 여유) */
function commandLineLength(command: string, args: string[]): number {
  let n = command.length + 3;
  for (const a of args) n += a.length + 3 + (a.match(/["\\]/g)?.length ?? 0);
  return n;
}
