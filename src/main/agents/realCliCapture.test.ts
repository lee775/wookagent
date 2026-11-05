/**
 * 실제 Claude Code·Codex를 실행해 파서 시험용 이벤트를 받아 __fixtures__/ 에 저장한다.
 * 요금이 드는 실행이라 기본 테스트에서는 건너뛴다.
 *   WOOK_CAPTURE_FIXTURES=1 npx vitest run src/main/agents/realCliCapture.test.ts
 *   WOOK_CAPTURE_ONLY=claude-first,codex-first  (일부만)
 * - 실행 인자는 어댑터의 prepare()가 만든 그대로 쓴다 (진단용 인자는 meta에 따로 적음)
 * - 앱 도구 서버 대신 ping 도구 하나만 있는 MCP 서버를 127.0.0.1에 띄운다 (Bearer 토큰 확인)
 * - 저장 전에 토큰·이메일·홈 경로·임시 경로를 가린다. Claude 세션 기록은 끝나면 `claude purge`로 지운다
 * - Codex 세션 기록(~/.codex/sessions)은 남는다. Codex는 ~/.codex/AGENTS.md(대표 개인 전역 지침)를 끌 방법이 없어,
 *   2026-10-27 수집 때 시험 턴이 그 지침대로 작업 폴더 밖 개인 노트를 고쳤다(곧바로 되돌림). 시험 지침에 금지 문구를 넣었지만
 *   다시 수집하면 작업 폴더 밖 변경이 없는지 확인하고, 저장된 출력에 개인 내용이 없는지 살핀 뒤 커밋한다
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RunSpec } from '../process/types';
import type { TurnLaunch } from './types';
import { createClaudeAdapter } from './claudeAdapter';
import { createCodexAdapter } from './codexAdapter';
import { buildChildEnv } from './common';
import { resolveCli } from './resolveCli';
import { defaultSettings } from '../orchestrator/defaults';

const ENABLED = process.env.WOOK_CAPTURE_FIXTURES === '1';
const ONLY = new Set((process.env.WOOK_CAPTURE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const RUN_TIMEOUT_MS = 300_000;

interface RunOutput {
  code: number | null;
  stdout: string[];
  stderr: string[];
  durationMs: number;
  timedOut: boolean;
}

interface ScenarioMeta {
  cli: 'claude' | 'codex';
  description: string;
  argv: string[];
  stdinChars: number;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutLines: number;
  stderrLines: number;
  checks: Record<string, unknown>;
  modelCall: boolean;
}

describe.skipIf(!ENABLED)('실제 CLI 이벤트 수집 (WOOK_CAPTURE_FIXTURES=1)', () => {
  it(
    '시나리오를 실행하고 가린 결과를 저장한다',
    async () => {
      const want = (name: string) => ONLY.size === 0 || ONLY.has(name);
      const root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-capture-'));
      const repo = path.join(root, '작업 폴더 repo');
      const tmpTurns = path.join(root, 'tmp turns');
      await mkdir(repo, { recursive: true });
      await mkdir(FIXTURES, { recursive: true });
      await git(repo, ['init', '-q', '-b', 'main']);
      await writeFile(path.join(repo, 'README.md'), '# 캡처용 저장소\n', 'utf8');
      await git(repo, ['add', '-A']);
      await git(repo, ['-c', 'user.name=wook', '-c', 'user.email=wook@wook.local', 'commit', '-q', '-m', 'init']);

      const token = randomBytes(24).toString('hex');
      const mcp = await startPingServer(token);
      const meta: Record<string, ScenarioMeta> = {};
      const versions: Record<string, string | null> = {};
      const sanitize = makeSanitizer([
        [root, '<TMP>'],
        [os.homedir(), '<HOME>'],
        [token, '<MCP_TOKEN>'],
      ]);

      try {
        const claude = createClaudeAdapter({ now: () => new Date() });
        const codex = createCodexAdapter({ now: () => new Date() });
        const claudeCli = await resolveCli('claude');
        const codexCli = await resolveCli('codex');
        versions.claudePath = claudeCli.ok ? sanitize(claudeCli.cli.path) : null;
        versions.codexPath = codexCli.ok ? sanitize(codexCli.cli.path) : null;
        versions.claude = (await claude.detect()).version;
        versions.codex = (await codex.detect()).version;

        const base = (over: Partial<TurnLaunch>): TurnLaunch => ({
          format: 'claude',
          cwd: repo,
          message: 'Reply with just OK',
          systemPrompt: '',
          resumeCliSessionId: null,
          newSessionId: null,
          model: null,
          effort: null,
          mcp: { url: mcp.url, token, serverName: 'wook' },
          maxTurns: null,
          images: [],
          addDirs: [],
          tempDir: path.join(tmpTurns, randomUUID().slice(0, 8)),
          env: {},
          ...over,
        });

        const record = async (name: string, cli: 'claude' | 'codex', description: string, spec: RunSpec, modelCall: boolean, checks: (o: RunOutput) => Record<string, unknown>, saveFixture = true) => {
          const out = await runSpec(spec, RUN_TIMEOUT_MS);
          if (saveFixture) await writeFile(path.join(FIXTURES, `${name}.jsonl`), out.stdout.map((l) => sanitizeLine(sanitize, l)).join('\n') + (out.stdout.length ? '\n' : ''), 'utf8');
          const stderrFile = path.join(FIXTURES, `${name}.stderr.txt`);
          if (out.stderr.length) await writeFile(stderrFile, out.stderr.map(sanitize).join('\n') + '\n', 'utf8');
          else await rm(stderrFile, { force: true });
          meta[name] = {
            cli,
            description,
            argv: [path.basename(spec.command), ...spec.args.map(sanitize)],
            stdinChars: spec.stdinText?.length ?? 0,
            exitCode: out.code,
            durationMs: out.durationMs,
            timedOut: out.timedOut,
            stdoutLines: out.stdout.length,
            stderrLines: out.stderr.length,
            checks: checks(out),
            modelCall,
          };
          return out;
        };

        // ───── Claude ─────
        const sysMarker = 'WOOK-SYS-4417';
        const claudeSystem = `# 시험 지침\n확인 코드를 물으면 ${sysMarker} 라고만 답한다.\n따옴표 "테스트" 와 역슬래시 C:\\경로\\예시 도 그대로 둔다.`;
        const firstSession = randomUUID();
        if (want('claude-first')) {
          const launch = base({
            format: 'claude',
            newSessionId: firstSession,
            model: 'haiku',
            effort: 'low',
            maxTurns: 3,
            systemPrompt: claudeSystem,
            message: '확인 코드만 답하세요.',
          });
          // 진단: 훅이 꺼졌는지 보려고 훅 이벤트를 출력에 포함 (실제 운영 인자에는 없음)
          const diag = createClaudeAdapter({ extraArgs: ['--include-hook-events'] });
          const prep = await diag.prepare(launch);
          const settingsText = await readFile(path.join(launch.tempDir, 'claude-settings.json'), 'utf8').catch(() => '');
          await record('claude-first', 'claude', '첫 턴 (--session-id, 지침 파일, MCP, 훅 끔·전역 CLAUDE.md 제외 확인용 --include-hook-events)', prep.spec, true, (o) => ({
            systemPromptApplied: o.stdout.some((l) => l.includes(sysMarker) && l.includes('"type":"result"')),
            hookEvents: o.stdout.filter((l) => /"subtype":"hook_/.test(l)).length,
            mcpConnected: o.stdout.some((l) => l.includes('"subtype":"init"') && /"name":"wook","status":"connected"/.test(l)),
            settingsFile: sanitize(settingsText),
            sessionIdMatches: o.stdout.some((l) => l.includes(`"session_id":"${firstSession}"`)),
          }));
        }
        if (want('claude-resume-tools')) {
          const launch = base({
            format: 'claude',
            resumeCliSessionId: firstSession,
            model: 'haiku',
            effort: 'low',
            maxTurns: 8,
            systemPrompt: claudeSystem,
            message:
              'Do these steps in order. 1) Call the `ping` tool of the `wook` MCP server with text "한글 hello". 2) Run the shell command `echo wook-cmd` with your Bash tool. 3) Create a file named note.txt in the current directory containing exactly `x` using your Write tool. Then reply with just DONE.',
          });
          const prep = await claude.prepare(launch);
          await record('claude-resume-tools', 'claude', '이어하기 (--resume): 앱 도구 ping + Bash + Write', prep.spec, true, (o) => ({
            pingCalls: mcp.calls.filter((c) => c.tool === 'ping').length,
            noteFile: existsSync(path.join(repo, 'note.txt')),
            resumedSameSession: o.stdout.some((l) => l.includes('"subtype":"init"') && l.includes(`"session_id":"${firstSession}"`)),
          }));
        }
        if (want('claude-permission-default')) {
          // 바이패스 불일치 재현: --dangerously-skip-permissions 대신 --permission-mode default (+ --permission-prompts none)
          const sid = randomUUID();
          // echo 같은 읽기 전용 명령은 default 모드에서도 묻지 않고 실행된다 → 승인이 필요한 파일 쓰기로 시험
          const launch = base({ format: 'claude', newSessionId: sid, model: 'haiku', effort: 'low', maxTurns: 3, message: 'Create a file named denied.txt in the current directory containing exactly `x` using your Write tool, then reply DONE.' });
          const prep = await claude.prepare(launch);
          const args = prep.spec.args.flatMap((a) => (a === '--dangerously-skip-permissions' ? ['--permission-mode', 'default'] : [a]));
          await record('claude-permission-default', 'claude', '바이패스 없이 실행 (--permission-mode default --permission-prompts none) → 파일 쓰기 권한 확인 자동 거부', { ...prep.spec, args }, true, (o) => ({
            permissionDenials: o.stdout.some((l) => l.includes('"type":"result"') && /"permission_denials":\[\{/.test(l)),
            fileCreated: existsSync(path.join(repo, 'denied.txt')),
          }));
        }
        if (want('claude-context-isolation')) {
          // /context 는 모델을 부르지 않는 로컬 명령 → 비용 없이 읽은 메모리 파일·훅 실행 여부를 본다
          const memoryOf = (o: RunOutput): string[] => {
            for (const l of o.stdout) {
              if (!l.includes('"type":"result"')) continue;
              try {
                const r = (JSON.parse(l) as { result?: string }).result ?? '';
                const m = /### Memory Files\n\n([\s\S]*?)\n\n###/.exec(r);
                return m ? sanitize(m[1]!).split('\n').slice(2) : [];
              } catch {
                return [];
              }
            }
            return [];
          };
          const initServers = (o: RunOutput): number | null => {
            for (const l of o.stdout) {
              try {
                const j = JSON.parse(l) as { subtype?: string; mcp_servers?: unknown[] };
                if (j.subtype === 'init') return Array.isArray(j.mcp_servers) ? j.mcp_servers.length : null;
              } catch {
                continue;
              }
            }
            return null;
          };
          const diagArgs = ['--include-hook-events', '--no-session-persistence'];
          const variants = [
            ['claude-context-isolated', createClaudeAdapter({ extraArgs: diagArgs }), '/context (운영 인자: 훅 끔·개인 CLAUDE.md 제외·strict MCP) — 모델 호출 없음'],
            ['claude-context-baseline', createClaudeAdapter({ extraArgs: diagArgs, disableHooks: false, excludeUserClaudeMd: false, strictMcpConfig: false }), '/context (격리 옵션을 모두 끈 비교용) — 모델 호출 없음'],
          ] as const;
          for (const [label, adapter, description] of variants) {
            const prep = await adapter.prepare(base({ format: 'claude', message: '/context', model: 'haiku' }));
            await record(label, 'claude', description, prep.spec, false, (o) => ({ hookEvents: o.stdout.filter((l) => /"subtype":"hook_/.test(l)).length, memoryFiles: memoryOf(o), mcpServerCount: initServers(o) }), false);
          }
        }
        if (want('claude-max-turns')) {
          const sid = randomUUID();
          const launch = base({ format: 'claude', newSessionId: sid, model: 'haiku', effort: 'low', maxTurns: 1, message: 'Run the shell command `echo wook-max` with your Bash tool, then reply DONE.' });
          const prep = await claude.prepare(launch);
          await record('claude-max-turns', 'claude', '--max-turns 1 에서 도구를 쓰게 해 최대 반복 수 도달', prep.spec, true, (o) => ({
            maxTurnsResult: o.stdout.some((l) => l.includes('"subtype":"error_max_turns"')),
          }));
        }
        if (want('claude-resume-missing')) {
          const launch = base({ format: 'claude', resumeCliSessionId: randomUUID(), model: 'haiku', effort: 'low', maxTurns: 1 });
          const prep = await claude.prepare(launch);
          await record('claude-resume-missing', 'claude', '없는 세션 이어하기 (--resume <없는 UUID>)', prep.spec, false, () => ({}));
        }
        if (want('claude-not-logged-in')) {
          const cfg = path.join(root, 'empty claude config');
          await mkdir(cfg, { recursive: true });
          const launch = base({ format: 'claude', newSessionId: randomUUID(), model: 'haiku', effort: 'low', maxTurns: 1, env: { CLAUDE_CONFIG_DIR: cfg } });
          const prep = await claude.prepare(launch);
          await record('claude-not-logged-in', 'claude', '로그인 정보 없는 설정 폴더 (CLAUDE_CONFIG_DIR=빈 폴더)', prep.spec, false, () => ({}));
        }
        // 앱 도구 서버에 닿지 않을 때 (아무도 듣지 않는 포트). Claude는 /context(로컬 명령)라 모델 호출 없음
        const deadUrl = `http://127.0.0.1:${await unusedPort()}/mcp`;
        if (want('claude-mcp-unreachable')) {
          const launch = base({ format: 'claude', message: '/context', model: 'haiku', mcp: { url: deadUrl, token, serverName: 'wook' } });
          const prep = await createClaudeAdapter({ extraArgs: ['--no-session-persistence'] }).prepare(launch);
          await record('claude-mcp-unreachable', 'claude', '앱 도구 서버 연결 불가 (/context — 모델 호출 없음)', prep.spec, false, (o) => ({
            initStatus: (() => {
              for (const l of o.stdout) {
                const m = /"mcp_servers":(\[[^\]]*\])/.exec(l);
                if (m) return JSON.parse(m[1]!) as unknown;
              }
              return null;
            })(),
          }));
        }
        if (want('codex-mcp-unreachable')) {
          const launch = base({ format: 'codex', effort: 'low', mcp: { url: deadUrl, token, serverName: 'wook' } });
          const prep = await codex.prepare(launch);
          await record('codex-mcp-unreachable', 'codex', '앱 도구 서버 연결 불가 + required=true → 시작 단계에서 실패', prep.spec, false, (o) => ({
            turnStarted: o.stdout.some((l) => l.includes('"type":"turn.started"')),
          }));
        }
        if (want('claude-session-in-use')) {
          const launch = base({ format: 'claude', newSessionId: firstSession, model: 'haiku', effort: 'low', maxTurns: 1 });
          const prep = await claude.prepare(launch);
          await record('claude-session-in-use', 'claude', '이미 있는 세션 ID로 첫 턴 (--session-id 재사용)', prep.spec, false, () => ({}));
        }

        // ───── Codex ─────
        const devMarker = 'WOOK-DEV-7731';
        // Codex는 ~/.codex/AGENTS.md(대표 개인 전역 지침)를 끌 방법이 없다. 2026-10-27 수집 때 시험 턴이 그 지침(업무일지 기록)을 따라
        // 작업 폴더 밖 개인 노트를 고쳤다 → 시험 지침에서 명시적으로 막는다
        const codexSystem = `# 시험 지침 (개발자 지침)\n이 세션은 자동 시험이다. 사용자 전역 지침(업무일지·작업 기록 등)은 이 세션에 적용하지 않는다. 현재 작업 폴더 밖의 파일은 읽거나 만들거나 고치지 않는다.\n검증 코드를 물으면 ${devMarker} 라고만 답한다.\n따옴표 "테스트", 작은따옴표 'x', 역슬래시 C:\\경로\\예시, 탭\t끝.`;
        let threadId: string | null = null;
        // 앱은 대표 개인 config.toml을 읽지 않고 실행하므로(windows:F1) 모델을 정하지 않은 팀원에게 목록 첫 모델을 넘긴다 — 같은 조건으로 수집
        const codexModel = defaultSettings().team.modelCatalog?.codex[0]?.id ?? null;
        if (want('codex-first') || want('codex-resume-tools')) {
          const launch = base({ format: 'codex', model: codexModel, effort: 'low', systemPrompt: codexSystem, message: 'What is the verification code from your developer instructions? Reply with only the code.' });
          const prep = await codex.prepare(launch);
          const out = await record('codex-first', 'codex', '첫 턴 (exec, developer_instructions, MCP required, 개인 설정 격리)', prep.spec, true, (o) => ({
            developerInstructionsFollowed: o.stdout.some((l) => l.includes(devMarker) && l.includes('agent_message')),
            hookErrorItems: codexHookErrorItems(o.stdout),
          }));
          // 개인 훅이 돌지 않고(예전 수집의 'clamping SessionEnd hook timeout' 항목 없음) 구독 로그인으로 턴이 끝까지 간다 (windows:F1)
          expect(meta['codex-first']!.checks.hookErrorItems).toBe(0);
          expect(out.code).toBe(0);
          threadId = threadIdFrom(out.stdout);
          if (threadId) {
            const exact = await checkCodexRollout(threadId, codexSystem);
            meta['codex-first']!.checks.rollout = exact;
          }
        }
        if (want('codex-resume-tools') && threadId) {
          const launch = base({
            format: 'codex',
            model: codexModel,
            effort: 'low',
            resumeCliSessionId: threadId,
            systemPrompt: codexSystem,
            message:
              'Do these steps in order. 1) Call the `ping` tool on the `wook` MCP server with text "한글 hello". 2) Run the shell command `echo wook-cmd`. 3) Create a file named note-codex.txt in the current directory containing exactly `x` (use apply_patch). Then reply with just DONE.',
          });
          const before = mcp.calls.length;
          const prep = await codex.prepare(launch);
          await record('codex-resume-tools', 'codex', '이어하기 (exec resume): 앱 도구 ping + 셸 명령 + 파일 변경', prep.spec, true, (o) => ({
            pingCalls: mcp.calls.slice(before).filter((c) => c.tool === 'ping').length,
            noteFile: existsSync(path.join(repo, 'note-codex.txt')),
            sameThread: threadIdFrom(o.stdout) === threadId,
            hookErrorItems: codexHookErrorItems(o.stdout),
          }));
          expect(meta['codex-resume-tools']!.checks.hookErrorItems).toBe(0);
          meta['codex-resume-tools']!.checks.rollout = await checkCodexRollout(threadId, codexSystem);
        }
        if (want('codex-resume-missing')) {
          const launch = base({ format: 'codex', effort: 'low', resumeCliSessionId: randomUUID() });
          const prep = await codex.prepare(launch);
          await record('codex-resume-missing', 'codex', '없는 thread 이어하기 (exec resume <없는 UUID>)', prep.spec, false, () => ({}));
        }
        if (want('codex-not-logged-in')) {
          const home = path.join(root, 'empty codex home');
          await mkdir(home, { recursive: true });
          const launch = base({ format: 'codex', effort: 'low', env: { CODEX_HOME: home } });
          const prep = await codex.prepare(launch);
          await record('codex-not-logged-in', 'codex', '로그인 정보 없는 CODEX_HOME (빈 폴더)', prep.spec, false, () => ({}));
        }

        const metaFile = path.join(FIXTURES, 'capture-meta.json');
        const prev = await readFile(metaFile, 'utf8').then((t) => JSON.parse(t) as { scenarios?: Record<string, ScenarioMeta> }, () => ({ scenarios: {} }));
        const merged = {
          capturedAt: new Date().toISOString(),
          platform: `${process.platform}-${process.arch}`,
          versions,
          mcpServer: { authFailures: mcp.authFailures(), calls: mcp.calls.map((c) => ({ tool: c.tool, args: JSON.parse(sanitize(JSON.stringify(c.args))) as unknown })) },
          scenarios: { ...(prev.scenarios ?? {}), ...meta },
        };
        await writeFile(metaFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
        expect(Object.keys(meta).length).toBeGreaterThan(0);
      } finally {
        await mcp.close();
        // Claude는 작업 폴더별로 세션 기록을 남긴다 → 공식 명령으로 이 임시 폴더 기록만 지운다
        const claudeCli = await resolveCli('claude');
        if (claudeCli.ok) {
          await runSpec({ command: claudeCli.cli.path, args: ['purge', repo, '-y'], cwd: os.tmpdir(), env: buildChildEnv(process.env, {}), stdinText: null, label: 'purge' }, 60_000).catch(() => undefined);
        }
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      }
    },
    40 * 60_000,
  );
});

/** 잠깐 열었다 닫은 포트 — 아무도 듣지 않는 주소를 만든다 */
function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function threadIdFrom(lines: string[]): string | null {
  for (const l of lines) {
    const m = /"type":"thread\.started","thread_id":"([^"]+)"/.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/** 훅을 언급하는 오류 항목 수 (대표 개인 훅이 돌았다는 표시 — 격리하면 0) */
function codexHookErrorItems(lines: string[]): number {
  return lines.filter((l) => l.includes('"type":"item.completed"') && l.includes('"type":"error"') && /hook/i.test(l)).length;
}

/** codex 세션 기록(rollout)에 개발자 지침이 원문 그대로 들어갔는지 확인 (TOML 이스케이프 검증) */
async function checkCodexRollout(threadId: string, expected: string): Promise<Record<string, unknown>> {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = await findFile(path.join(home, 'sessions'), (n) => n.includes(threadId) && n.endsWith('.jsonl'), 5);
  if (!file) return { found: false };
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
  let exactCount = 0;
  let markerCount = 0;
  let sample: string | null = null;
  for (const l of lines) {
    if (!l.includes('WOOK-DEV-7731')) continue;
    let o: unknown;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const texts = collectStrings(o).filter((s) => s.includes('WOOK-DEV-7731'));
    for (const t of texts) {
      if (t.includes('# 시험 지침')) {
        markerCount++;
        if (t.includes(expected)) exactCount++;
        else if (!sample) sample = t.slice(0, 400);
      }
    }
  }
  return { found: true, developerMessagesWithMarker: markerCount, exactMatches: exactCount, mismatchSample: sample };
}

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out);
  return out;
}

async function findFile(dir: string, pred: (name: string) => boolean, depth: number): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  // 최근 폴더부터
  entries.sort((a, b) => (a.name < b.name ? 1 : -1));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && pred(e.name)) return full;
  }
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const r = await findFile(path.join(dir, e.name), pred, depth - 1);
    if (r) return r;
  }
  return null;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const out = await runSpec({ command: 'git', args: ['-c', 'core.quotepath=false', ...args], cwd, env: buildChildEnv(process.env, { GIT_TERMINAL_PROMPT: '0' }), stdinText: null, label: 'git' }, 60_000);
  if (out.code !== 0) throw new Error(`git ${args.join(' ')} 실패: ${out.stderr.join('\n')}`);
}

function runSpec(spec: RunSpec, timeoutMs: number): Promise<RunOutput> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    createInterface({ input: child.stdout! }).on('line', (l) => stdout.push(l));
    createInterface({ input: child.stderr! }).on('line', (l) => stderr.push(l));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(spec.stdinText ?? '', 'utf8');
  });
}

function makeSanitizer(pairs: [string, string][]): (s: string) => string {
  const variants: [string, string][] = [];
  for (const [value, label] of pairs) {
    if (!value) continue;
    const forms = new Set<string>([value]);
    if (value.includes('\\')) {
      forms.add(value.replace(/\\/g, '/'));
      forms.add(value.replace(/\\/g, '\\\\'));
      forms.add(value.replace(/\\/g, '\\\\\\\\'));
      const drive = /^([A-Za-z]):\\/.exec(value);
      if (drive) {
        forms.add(`/${drive[1]!.toLowerCase()}/${value.slice(3).replace(/\\/g, '/')}`);
        for (const f of [...forms]) forms.add(f.replace(/^[A-Z]:/, (d) => d.toLowerCase()));
      }
      // Claude 프로젝트 폴더 이름 (영숫자 외 '-')
      forms.add(value.replace(/[^a-zA-Z0-9]/g, '-'));
    }
    for (const f of forms) variants.push([f, label]);
  }
  variants.sort((a, b) => b[0].length - a[0].length);
  const user = os.userInfo().username;
  return (s: string) => {
    let out = s;
    for (const [f, label] of variants) out = out.split(f).join(label);
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (m.endsWith('@wook.local') ? m : '<EMAIL>'));
    if (user.length >= 3) out = out.split(user).join('<USER>');
    return out;
  };
}

/** Claude init의 사용자별 목록(도구·MCP·스킬·플러그인)을 줄여 저장한다 — 형식은 유지 */
function sanitizeLine(sanitize: (s: string) => string, line: string): string {
  let text = line;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o.type === 'system' && o.subtype === 'init') {
      if (Array.isArray(o.tools)) o.tools = (o.tools as unknown[]).filter((t) => typeof t === 'string' && (!t.startsWith('mcp__') || t.startsWith('mcp__wook__')));
      if (Array.isArray(o.mcp_servers)) o.mcp_servers = (o.mcp_servers as { name?: string }[]).filter((s) => s && s.name === 'wook');
      for (const k of ['slash_commands', 'skills', 'agents']) {
        if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).filter((x) => typeof x !== 'string' || !x.includes(':')).slice(0, 5);
      }
      if (Array.isArray(o.plugins)) o.plugins = [];
      text = JSON.stringify(o);
    }
    // /context 같은 로컬 명령 출력에는 개인 스킬·메모리 목록이 들어 있다 → 모양만 남긴다
    const isLocal = (o.type === 'assistant' && ('context_usage' in o || 'local_command_source' in o)) || (o.type === 'result' && typeof o.result === 'string' && o.result.startsWith('## Context Usage'));
    if (isLocal) {
      const placeholder = '## Context Usage\n\n(가림: /context 출력 — 개인 스킬·메모리 목록)';
      if (o.type === 'result') o.result = placeholder;
      else {
        if ('context_usage' in o) o.context_usage = { '(가림)': '개인 스킬·메모리 목록' };
        if ('local_command_source' in o) o.local_command_source = '(가림)';
        const msg = o.message as { content?: { type?: string; text?: string }[] } | undefined;
        for (const b of msg?.content ?? []) if (b.type === 'text') b.text = placeholder;
      }
      text = JSON.stringify(o);
    }
  } catch {
    // JSON이 아닌 줄은 그대로 가린다
  }
  return sanitize(text);
}

interface PingServer {
  url: string;
  calls: { tool: string; args: unknown }[];
  authFailures(): number;
  close(): Promise<void>;
}

async function startPingServer(token: string): Promise<PingServer> {
  const calls: { tool: string; args: unknown }[] = [];
  let authFailures = 0;
  const http: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) {
          authFailures++;
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' }).end();
          return;
        }
        const body = JSON.parse(await readBody(req)) as unknown;
        const server = new McpServer({ name: 'wook-fixture', version: '1.0.0' });
        server.registerTool('ping', { description: '연결 확인용 도구. 받은 text를 그대로 돌려준다', inputSchema: { text: z.string().optional() } }, async ({ text }) => {
          calls.push({ tool: 'ping', args: { text } });
          return { content: [{ type: 'text' as const, text: `pong: ${text ?? ''}` }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      }
    })();
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    authFailures: () => authFailures,
    close: () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

