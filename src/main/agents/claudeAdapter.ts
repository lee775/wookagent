/**
 * Claude Code 어댑터 (15.3, 15.5, ARCHITECTURE 12장). 2.1.x 실행 파일에서 옵션을 확인했다.
 *
 * claude -p --output-format stream-json --verbose
 *        --dangerously-skip-permissions --permission-prompts none
 *        --mcp-config <tmp>/claude-mcp.json --strict-mcp-config
 *        --append-system-prompt-file <tmp>/claude-system.md
 *        --settings <tmp>/claude-settings.json   (훅 끄기 + 대표 개인 CLAUDE.md 제외)
 *        [--model M] [--effort E] [--max-turns N] [--add-dir D]...
 *        (--session-id <uuid> | --resume <session_id>)
 *        < 메시지(표준 입력)
 *
 * --mcp-config·--add-dir는 값 여러 개를 받는 옵션이라 바로 뒤에 다른 옵션이 와야 한다 (위치 인자를 쓰지 않으므로 안전).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, CliStatus, EventParser, PreparedRun, TurnLaunch } from './types';
import { CLAUDE_EFFORTS, LaunchError, buildChildEnv, displayCommand, isUuid, validateLaunch } from './common';
import { detectCli, resolveCli, type ResolvedCli, type RunCommand } from './resolveCli';
import { createClaudeParser } from './parsers/claudeParser';

export interface AdapterBaseOptions {
  /** 운영 설정의 실행 파일 경로. 부를 때마다 읽는다 (설정 변경 즉시 반영) */
  pathOverride?: () => string | null | undefined;
  /** 자식 환경의 바탕 (기본 process.env). 앱 세션 표시 변수는 지운다 */
  baseEnv?: () => NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** 상태 확인(detect)에만 더할 환경 변수 — API 키 방식이면 키를 넣어야 로그인 상태가 맞게 나온다 */
  statusEnv?: () => Record<string, string>;
  /** 사용량 한도 해제 시각 계산용 시계 */
  now?: () => Date;
  /** 해제 시각 문구("resets 3pm")를 해석할 시간대. 기본: 이 PC의 시간대 */
  timeZone?: string;
  platform?: NodeJS.Platform;
  /** 테스트: 실행 파일 해석 대체 */
  resolveExecutable?: () => Promise<ResolvedCli>;
  /** 테스트: detect의 명령 실행 대체 */
  runCommand?: RunCommand;
}

export interface ClaudeAdapterOptions extends AdapterBaseOptions {
  /**
   * 사용자 MCP 설정을 빼고 앱 도구 서버만 연결 (--strict-mcp-config). 기본 true.
   * 바이패스에서는 MCP 도구도 승인 없이 실행되므로 대표 개인 연동(메신저 전송·배포 등)을 팀원 세션에 열지 않는다
   */
  strictMcpConfig?: boolean;
  /**
   * 사용자·프로젝트 훅을 끈다 (--settings 의 disableAllHooks). 기본 true.
   * 대표 PC의 Stop 훅(업무일지 강제 등)이 턴 종료를 막고 작업 폴더 밖 파일 쓰기를 지시하면 턴 판정(CLI-18)이 깨진다
   */
  disableHooks?: boolean;
  /**
   * 대표 개인용 전역 지침(~/.claude/CLAUDE.md, rules/)을 읽지 않는다 (--settings 의 claudeMdExcludes). 기본 true.
   * 프로젝트 CLAUDE.md·AGENTS.md(MEM-01·02)는 그대로 읽는다
   */
  excludeUserClaudeMd?: boolean;
  /**
   * --system-prompt-snapshot. 2.1.x 기본은 on: 첫 요청의 지침을 기록해 이어하기에서도 그대로 쓰고,
   * 나중 턴에 다른 지침 파일을 줘도 압축 전까지 반영하지 않는다. null이면 옵션을 넣지 않는다
   */
  systemPromptSnapshot?: 'on' | 'off' | null;
  /** 진단용 추가 인자 (예: --include-hook-events). 맨 끝 세션 인자 앞에 넣는다 */
  extraArgs?: string[];
  /** 사용자 전역 지침 위치를 정할 홈 폴더 (기본 os.homedir()) */
  homeDir?: string;
}

export const CLAUDE_MCP_FILE = 'claude-mcp.json';
export const CLAUDE_SYSTEM_FILE = 'claude-system.md';
export const CLAUDE_SETTINGS_FILE = 'claude-settings.json';

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): AgentAdapter {
  const platform = opts.platform ?? process.platform;
  const resolveExe = async (): Promise<ResolvedCli> => {
    if (opts.resolveExecutable) return opts.resolveExecutable();
    const r = await resolveCli('claude', { override: opts.pathOverride?.() ?? null, platform, env: opts.baseEnv?.() ?? process.env });
    if (!r.ok) throw new LaunchError(r.reason, true); // 실행 파일 문제 → AI 종류 단위로 막는다 (CLI-15)
    return r.cli;
  };

  return {
    kind: 'claude',
    async detect(): Promise<CliStatus> {
      if (opts.resolveExecutable) {
        let resolved: ResolvedCli;
        try {
          resolved = await opts.resolveExecutable();
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return { installed: false, path: null, version: null, loggedIn: null, problem: reason, detail: reason };
        }
        return detectCli('claude', { platform, env: opts.baseEnv?.(), statusEnv: opts.statusEnv?.(), run: opts.runCommand, resolved: { ok: true, cli: resolved } });
      }
      return detectCli('claude', {
        override: opts.pathOverride?.() ?? null,
        platform,
        env: opts.baseEnv?.(),
        statusEnv: opts.statusEnv?.(),
        run: opts.runCommand,
      });
    },
    async prepare(launch: TurnLaunch): Promise<PreparedRun> {
      const { resume } = await validateLaunch('Claude Code', launch, CLAUDE_EFFORTS);
      if (!resume && launch.newSessionId !== null && !isUuid(launch.newSessionId)) {
        throw new LaunchError(`Claude Code 새 세션 ID는 UUID여야 합니다: "${launch.newSessionId}"`);
      }
      const cli = await resolveExe();

      const mcpFile = path.join(launch.tempDir, CLAUDE_MCP_FILE);
      const systemFile = path.join(launch.tempDir, CLAUDE_SYSTEM_FILE);
      const settingsFile = path.join(launch.tempDir, CLAUDE_SETTINGS_FILE);
      const hasSystem = launch.systemPrompt.trim() !== '';
      // 앱 도구 한 번을 기다리는 시간(ms) — 메인 대화 턴만, host_exec 상한보다 길게 (리드 결정 S5-18)
      const toolTimeout: Record<string, string> = launch.mcp.toolTimeoutSec ? { MCP_TOOL_TIMEOUT: String(launch.mcp.toolTimeoutSec * 1000) } : {};
      const env = buildChildEnv(opts.baseEnv?.() ?? process.env, { ...toolTimeout, ...launch.env }, platform);
      const settings = claudeIsolationSettings({
        disableHooks: opts.disableHooks ?? true,
        excludeUserClaudeMd: opts.excludeUserClaudeMd ?? true,
        configDir: claudeConfigDir(env, platform, opts.homeDir ?? os.homedir()),
      });
      const written: string[] = [];
      try {
        await mkdir(launch.tempDir, { recursive: true });
        await writeFile(mcpFile, claudeMcpConfigJson(launch.mcp), { encoding: 'utf8', mode: 0o600 });
        written.push(mcpFile);
        if (hasSystem) {
          await writeFile(systemFile, launch.systemPrompt, { encoding: 'utf8', mode: 0o600 });
          written.push(systemFile);
        }
        if (settings) {
          await writeFile(settingsFile, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
          written.push(settingsFile);
        }
      } catch (e) {
        await Promise.all(written.map((f) => rm(f, { force: true })));
        throw new LaunchError(`Claude Code 임시 파일을 쓰지 못했습니다 (${launch.tempDir}): ${e instanceof Error ? e.message : String(e)}`);
      }

      const args = buildClaudeArgs(launch, {
        mcpFile,
        systemFile: hasSystem ? systemFile : null,
        settingsFile: settings ? settingsFile : null,
        strictMcpConfig: opts.strictMcpConfig ?? true,
        systemPromptSnapshot: opts.systemPromptSnapshot ?? null,
        extraArgs: opts.extraArgs ?? [],
      });
      const stdinText = claudeMessage(launch);
      return {
        spec: { command: cli.path, args, cwd: launch.cwd, env, stdinText, label: resume ? 'claude 이어하기' : 'claude 첫 턴' },
        expectedCliSessionId: resume ? launch.resumeCliSessionId : launch.newSessionId,
        cleanup: written,
        display: displayCommand(cli.path, args, stdinText.length),
      };
    },
    createParser(launch: TurnLaunch): EventParser {
      return createClaudeParser({ serverName: launch.mcp.serverName, now: opts.now, timeZone: opts.timeZone });
    },
  };
}

/** {"mcpServers":{"wook":{"type":"http","url":...,"headers":{"Authorization":"Bearer <token>"}}}} */
export function claudeMcpConfigJson(mcp: TurnLaunch['mcp']): string {
  return JSON.stringify({ mcpServers: { [mcp.serverName]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }, null, 2);
}

export function buildClaudeArgs(
  launch: TurnLaunch,
  o: {
    mcpFile: string;
    systemFile: string | null;
    settingsFile?: string | null;
    strictMcpConfig: boolean;
    systemPromptSnapshot: 'on' | 'off' | null;
    extraArgs?: string[];
  },
): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--permission-prompts', 'none', '--mcp-config', o.mcpFile];
  if (o.strictMcpConfig) args.push('--strict-mcp-config');
  if (o.systemFile) args.push('--append-system-prompt-file', o.systemFile);
  if (o.settingsFile) args.push('--settings', o.settingsFile);
  if (o.systemPromptSnapshot) args.push('--system-prompt-snapshot', o.systemPromptSnapshot);
  if (launch.model) args.push('--model', launch.model);
  if (launch.effort) args.push('--effort', launch.effort);
  if (launch.maxTurns !== null) args.push('--max-turns', String(launch.maxTurns));
  for (const d of launch.addDirs) args.push('--add-dir', d);
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  if (launch.resumeCliSessionId !== null) args.push('--resume', launch.resumeCliSessionId);
  else if (launch.newSessionId !== null) args.push('--session-id', launch.newSessionId);
  return args;
}

/** 팀원 세션을 대표 개인 설정에서 떼어 놓는 설정 (--settings 파일). 둘 다 끄면 null */
export function claudeIsolationSettings(o: { disableHooks: boolean; excludeUserClaudeMd: boolean; configDir: string }): Record<string, unknown> | null {
  if (!o.disableHooks && !o.excludeUserClaudeMd) return null;
  const s: Record<string, unknown> = {};
  if (o.disableHooks) s.disableAllHooks = true;
  if (o.excludeUserClaudeMd) {
    // picomatch 패턴이라 역슬래시는 이스케이프로 읽힌다 → 슬래시로 바꾼다
    const dir = o.configDir.replace(/\\/g, '/').replace(/\/+$/, '');
    s.claudeMdExcludes = [`${dir}/CLAUDE.md`, `${dir}/rules/**`];
  }
  return s;
}

/** Claude 사용자 설정 폴더: CLAUDE_CONFIG_DIR 또는 ~/.claude */
export function claudeConfigDir(env: Record<string, string | undefined>, platform: NodeJS.Platform, home: string): string {
  const key = Object.keys(env).find((k) => (platform === 'win32' ? k.toUpperCase() === 'CLAUDE_CONFIG_DIR' : k === 'CLAUDE_CONFIG_DIR'));
  const v = key ? env[key]?.trim() : undefined;
  if (v) return v;
  return (platform === 'win32' ? path.win32 : path.posix).join(home, '.claude');
}

/** Claude -p는 이미지 첨부 옵션이 없다 → 경로를 알려 Read 도구로 보게 한다 */
export function claudeMessage(launch: Pick<TurnLaunch, 'message' | 'images'>): string {
  if (launch.images.length === 0) return launch.message;
  const list = launch.images.map((p) => `- ${p}`).join('\n');
  return `${launch.message}\n\n[첨부 이미지]\n${list}\n위 이미지 파일은 Read 도구로 열어 볼 수 있습니다.`;
}
