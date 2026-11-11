/**
 * `wook-server` 명령 (SERVER_DESIGN 3.2, S2-4·S2-5·S3-8): 한 진입점이 서버(`serve`, 기본)도 되고 운영자 명령도 된다.
 *   node out/server/index.mjs [serve] [--data-dir <폴더>] [--bind 127.0.0.1] [--port 7317] [--web-dir <폴더>] [--config <파일>] [--owner-email <이메일>]
 *                             [--public-origin https://<이름>] [--workspace-root <폴더>] [--allow-test-session]
 *   node out/server/index.mjs status | stop | shutdown | session test | config show|reload | config owner-email <이메일> | config google-client-id <ID>
 *                             | secret set|clear google-client-secret | seat status | seat assign <보유자> [--force]
 *                             | agent add --label <이름> | agent revoke <ID> | agent list  [--data-dir <폴더>] [--json]
 * 운영자 명령은 `--data-dir` → `WOOK_DATA_DIR` → 기본 데이터 폴더에서 실행 잠금(server.lock — 살아 있는 서버인지 먼저 본다, S3-16), 관리 토큰
 * (admin.token)과 서버가 적은 관리 채널 자리(admin.endpoint — 계산하지 않는다, S2-20)를 읽는다. 관리 채널은 서로 증명한 뒤에만 명령을 보낸다(S3-16).
 * 비밀 값은 표준 입력으로만 받는다 — 명령 줄에 쓰지 않는다. 쓰임새 오류는 적은 낱말을 되풀이하지 않는다(알 수 없는 명령은 명령·묶음 이름만, 리드 결정
 * S3-39). 출력은 한국어, `--json`이면 JSON 한 줄.
 * 메인 자리(S4-8): `seat status`는 보기만 하고, `seat assign`은 운영자 배정이다(바꾼 쪽 operator — 대표 화면에는 없는 길). 보유자 모양이 틀리면 그 값을
 * 되풀이하지 않고 서버에 붙지 않는다
 * 외부 에이전트(S7-2): `agent add --label <이름>`은 ID와 키를 표준 출력에 한 번만 낸다(키는 서버가 해시만 두어 다시 볼 수 없다). `agent revoke <ID>`는 되풀이해도
 * 0이고 모르는 ID는 1, ID 모양이 틀리면 서버에 붙지 않는 쓰임새 오류(2 — 값을 되풀이하지 않는다). `agent list`는 키 없이 목록만
 */
import { parseArgs } from 'node:util';
import { createRedactor } from '@core/redact';
import type { EmergencySummary, ExternalAgentView } from '@shared/views';
import type { ServerConfigChange } from '../main/backend/types';
import { normalizeOwnerEmail, OWNER_EMAIL_FLAG_INVALID } from '../main/orchestrator/serverLogin';
import { parseHolderSpec, SEAT_HOLDER_SHAPE, seatDurationText } from '../main/orchestrator/seat';
import { AGENT_ID_RE, AGENT_ID_SHAPE } from '../main/orchestrator/externalAgents';
import { workspaceSourceText } from '../main/orchestrator/mainWork';
import type { ExternalAgentGrant, ExternalAgentRevokeReport, SeatAssignReport, SeatOperatorStatus } from '../main/backend/types';
import { operatorRequest, AdminClientError, type AdminCommand, type AdminReply } from './admin';
import type { OperatorConfigResult, ServerConfigView } from './config';
import { resolveDataDir } from './dataDir';
import { DEFAULT_PORT, type AdminStatus, type TestSessionGrant } from './server';
import type { ServeIo, ServeOptions } from './serve';
import { parsePublicOrigin } from './sessions';

export const USAGE = `욱채 서버 (4단계: 이 PC의 루프백 — 다른 기기는 tailscale serve로)

사용법
  wook-server [serve] [옵션]          서버를 띄웁니다
  wook-server status                  실행 중인 서버의 상태를 봅니다
  wook-server stop                    긴급 정지 (대표의 긴급 정지와 같습니다)
  wook-server shutdown                서버를 정상 종료합니다
  wook-server session test            운영자 시험 세션(대표의 기기 세션)을 발급합니다 (--allow-test-session으로 띄운 서버만)
  wook-server config show             운영자 설정(대표 이메일·구글 클라이언트·CLI 위치)을 봅니다 — 비밀 값은 등록 여부만
  wook-server config reload           운영자 설정 파일(server.json)을 다시 읽어 적용합니다
  wook-server config owner-email <이메일>
                                      대표 이메일을 바꿉니다 (server.json에 쓰고 적용 — 등록된 대표 계정과 모든 기기 세션이 끊깁니다)
  wook-server config google-client-id <ID>
                                      서버의 구글 로그인 클라이언트 ID('TV 및 입력 제한 기기' 종류)를 바꿉니다 (server.json에 쓰고 적용)
  wook-server secret set google-client-secret
                                      구글 로그인 보안 비밀을 표준 입력으로 받아 OS 보안 저장소에 넣습니다 (명령 줄에 쓰지 않습니다)
  wook-server secret clear google-client-secret
                                      그 보안 비밀을 지웁니다
  wook-server seat status             메인 자리(보유자·세대·응답 없음·교체 중인지)와 자리 정책을 봅니다 — 아무것도 바꾸지 않습니다
  wook-server seat assign <보유자> [--force]
                                      메인 자리를 그 보유자(launched:claude·launched:codex·external:<ID>)에게 넘깁니다 (운영자 배정 — 대표 화면에는
                                      없습니다). 나가는 메인 턴의 마무리를 기다리고, --force면 실행 중인 메인 턴을 바로 멈춥니다
  wook-server agent add --label <이름>
                                      외부 에이전트를 등록합니다 — ID(X-0001)와 키(wsk_…)를 내고, 키는 이때 한 번만 보입니다
  wook-server agent revoke <ID>       외부 에이전트의 키를 폐기합니다 (이미 폐기됐어도 0으로 끝납니다)
  wook-server agent list              등록한 외부 에이전트(이름·등록·폐기·마지막 접속·메인 자리)를 봅니다 — 키는 보이지 않습니다

서버 옵션
  --data-dir <폴더>       데이터 폴더 (없으면 WOOK_DATA_DIR, 그다음 기본 위치)
  --bind <주소>           127.0.0.1(기본), ::1, localhost 가운데 하나 — 어느 것이든 같은 포트의 127.0.0.1과 ::1을 함께 엽니다
  --port <번호>           HTTP 포트 (기본 ${DEFAULT_PORT}, 0이면 빈 포트)
  --web-dir <폴더>        npm run build:web으로 만든 웹 화면 폴더(out/web — 서버용 빌드만 받습니다. 없으면 안내 쪽만 보입니다)
  --config <파일>         운영자 설정 파일 (기본 <데이터 폴더>/server.json)
  --owner-email <이메일>  대표 이메일 (server.json의 owner.email보다 먼저입니다)
  --public-origin <주소>  tailscale serve가 만든 공개 주소 (예: https://grok-pc.tailnet.ts.net — server.json의 network.publicOrigin보다 먼저입니다)
  --workspace-root <폴더> 작업 폴더 위치 — 메인 에이전트는 그 아래 main에서 일합니다 (기본 ~/wook-workspace, server.json의 workspaceRoot보다 먼저입니다)
  --allow-test-session    관리 채널의 운영자 시험 세션 발급을 켭니다 (시험용 — 등록된 대표가 없으면 시험용 대표를 만듭니다)

명령 옵션
  --data-dir <폴더>       서버를 띄운 데이터 폴더
  --json                  결과를 JSON 한 줄로 냅니다
  --force                 seat assign만: 실행 중인 메인 턴을 바로 멈추고 마무리·인계 메모 턴을 기다리지 않습니다
  --label <이름>          agent add만: 외부 에이전트의 이름 (1~40자, 폐기하지 않은 에이전트끼리 겹치지 않게)
`;

export type CliPlan =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'serve'; options: ServeOptions }
  | { kind: 'client'; command: AdminCommand; dataDir: string; json: boolean; args?: string[] };

const SERVE_ONLY = ['bind', 'port', 'web-dir', 'config', 'owner-email', 'public-origin', 'workspace-root', 'allow-test-session'] as const;

/** 모양이 틀린 secret 명령의 글 — 적은 낱말(값일 수 있다)을 되풀이하지 않는다 */
export const SECRET_USAGE =
  '비밀 값 명령은 secret set google-client-secret, secret clear google-client-secret 꼴로만 씁니다 — 값은 명령 줄에 쓰지 말고 표준 입력으로 넣으세요 (명령 줄에 적은 값은 쓰지 않았습니다)';

/**
 * 명령·묶음 이름 — 알 수 없는 명령의 글에는 이 낱말만 보인다 (리드 결정 S3-39). `config google-client-id <ID>`처럼 값을 명령 줄에 받는 명령이 있어
 * `config google-client-secret GOCSPX-…` 같은 실수가 나기 쉽다 — 적은 낱말을 그대로 되풀이하면 비밀 값이 stderr(와 그것을 받아 적는 기록)에 남는다
 */
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  'serve',
  'status',
  'stop',
  'shutdown',
  'session',
  'test',
  'config',
  'show',
  'reload',
  'owner-email',
  'google-client-id',
  'secret',
  'set',
  'clear',
  'seat',
  'assign',
  'agent',
  'add',
  'revoke',
  'list',
]);

/** 'secret'이 든 낱말(대소문자 무관)이 있는지 — 비밀 값을 명령 줄에 붙였을 수 있어 SECRET_USAGE로 답한다 (S3-39) */
const mentionsSecret = (words: readonly string[]): boolean => words.some((w) => /secret/i.test(w));

/**
 * 알 수 없는 명령의 글 (S3-39): 앞에서부터 이어지는 명령·묶음 이름만 보이고, 그 뒤 낱말은 값일 수 있어 보이지 않는다고 말한다. 첫 낱말부터 모르는
 * 것이면 아무 낱말도 보이지 않는다
 */
export function unknownCommandMessage(words: readonly string[]): string {
  const shown: string[] = [];
  for (const w of words) {
    if (!COMMAND_WORDS.has(w)) break;
    shown.push(w);
  }
  if (shown.length === 0) return '알 수 없는 명령입니다 (적은 낱말은 값일 수 있어 보이지 않습니다)';
  return shown.length === words.length ? `알 수 없는 명령입니다: ${shown.join(' ')}` : `알 수 없는 명령입니다: ${shown.join(' ')} … (뒤의 낱말은 값일 수 있어 보이지 않습니다)`;
}

/**
 * parseArgs가 받지 않은 인자의 글 (S3-39). 모르는 옵션은 그 이름도 보이지 않는다 — 아는 이름이 아니고, `--GOCSPX-…`처럼 값을 옵션 자리에 붙였을 수 있다.
 * 'secret'이 든 옵션(`--client-secret=…`)이면 SECRET_USAGE. 아는 옵션에 값이 없거나 받지 않는 값을 붙인 것은 Node의 글 그대로다 — 그 글은 아는 옵션
 * 이름만 말하고 적은 값을 되풀이하지 않는다
 */
function parseArgsMessage(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const name = /^Unknown option '([^']*)'/.exec(e.message)?.[1] ?? '';
    return /secret/i.test(name) ? SECRET_USAGE : '모르는 옵션이 있습니다 (적은 옵션은 값일 수 있어 보이지 않습니다)';
  }
  return `인자를 알 수 없습니다: ${e.message}`;
}

/** 공용 가리개 (S3-14 — 세션 토큰·구글 보안 비밀 등의 모양) */
const usageRedactor = createRedactor();

/**
 * 쓰임새 오류 (끝 코드 2). 글은 값을 되풀이하지 않게 짰고(S3-39 — 되풀이해도 되는 것은 숫자 같은 알려진 모양뿐), 그래도 공용 가리개를 한 번 더 거친다
 */
export function usageError(message: string): Extract<CliPlan, { kind: 'error' }> {
  return { kind: 'error', message: usageRedactor.text(message) };
}

/** 명령 낱말 → 관리 채널 명령과 그 뒤의 낱말 (모르면 null) */
function commandOf(words: readonly string[]): { command: AdminCommand | 'serve'; args?: string[] } | null {
  const [a, b, ...rest] = words;
  if (words.length === 0 || (a === 'serve' && words.length === 1)) return { command: 'serve' };
  if ((a === 'status' || a === 'stop' || a === 'shutdown') && words.length === 1) return { command: a };
  if (a === 'session' && b === 'test' && rest.length === 0) return { command: 'session.test' };
  if (a === 'config' && (b === 'show' || b === 'reload') && rest.length === 0) return { command: `config.${b}` };
  if (a === 'config' && (b === 'owner-email' || b === 'google-client-id') && rest.length === 1) return { command: `config.${b}`, args: rest };
  // 비밀 값은 명령 줄에 받지 않는다 — 이름 하나만 (값은 표준 입력)
  if (a === 'secret' && (b === 'set' || b === 'clear') && rest.length === 1) return { command: `secret.${b}`, args: rest };
  // 메인 자리 (S4-8) — 보유자 모양은 parseCli가 본다
  if (a === 'seat' && b === 'status' && rest.length === 0) return { command: 'seat.status' };
  if (a === 'seat' && b === 'assign' && rest.length === 1) return { command: 'seat.assign', args: rest };
  // 외부 에이전트 (S7-2) — 이름은 --label로(parseCli가 붙인다), ID 모양은 parseCli가 본다
  if (a === 'agent' && b === 'add' && rest.length === 0) return { command: 'agent.add' };
  if (a === 'agent' && b === 'revoke' && rest.length === 1) return { command: 'agent.revoke', args: rest };
  if (a === 'agent' && b === 'list' && rest.length === 0) return { command: 'agent.list' };
  return null;
}

/** seat assign의 쓰임새 (보유자가 없거나 낱말이 많을 때) — 적은 낱말은 되풀이하지 않는다 (S3-39) */
export const SEAT_ASSIGN_USAGE = 'seat assign 뒤에는 보유자 하나를 적습니다 — 예: wook-server seat assign launched:codex (실행 중인 메인 턴을 바로 멈추려면 --force)';

/** agent add의 쓰임새 (--label이 없거나 비었거나 낱말이 더 붙음) — 적은 낱말은 되풀이하지 않는다 (S3-39) */
export const AGENT_ADD_USAGE = 'agent add에는 --label <이름> 하나를 붙입니다 — 예: wook-server agent add --label 그록봇 (적은 낱말은 보이지 않습니다)';
/** agent revoke의 쓰임새 (ID가 없거나 낱말이 많음) */
export const AGENT_REVOKE_USAGE = 'agent revoke 뒤에는 외부 에이전트 ID 하나를 적습니다 — 예: wook-server agent revoke X-0001 (적은 낱말은 보이지 않습니다)';

/** 인자 → 할 일. 던지지 않는다 */
export function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CliPlan {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        'data-dir': { type: 'string' },
        bind: { type: 'string' },
        port: { type: 'string' },
        'web-dir': { type: 'string' },
        config: { type: 'string' },
        'owner-email': { type: 'string' },
        'public-origin': { type: 'string' },
        'workspace-root': { type: 'string' },
        'allow-test-session': { type: 'boolean' },
        json: { type: 'boolean' },
        force: { type: 'boolean' },
        label: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return usageError(parseArgsMessage(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  const dataDir = resolveDataDir(values['data-dir'], env, platform);
  const plan = commandOf(positionals);
  // seat assign의 낱말 수가 틀리면 그 쓰임새를 말한다 — 적은 낱말(값일 수 있다)은 보이지 않는다 (S4-8, S3-39)
  if (plan === null && positionals[0] === 'seat' && positionals[1] === 'assign' && !mentionsSecret(positionals)) return usageError(SEAT_ASSIGN_USAGE);
  // agent add·revoke의 낱말 수가 틀리면 그 쓰임새를 말한다 — 적은 낱말은 보이지 않는다 (S7-2, S3-39)
  if (plan === null && positionals[0] === 'agent' && positionals[1] === 'add' && !mentionsSecret(positionals)) return usageError(AGENT_ADD_USAGE);
  if (plan === null && positionals[0] === 'agent' && positionals[1] === 'revoke' && !mentionsSecret(positionals)) return usageError(AGENT_REVOKE_USAGE);
  // 알 수 없는 명령은 적은 낱말을 되풀이하지 않는다 — 명령 줄에 붙인 값(구글 보안 비밀 등)이 화면(stderr)에 다시 찍히지 않게 (S3-8·S3-39).
  // 'secret'이 든 낱말이 있으면 비밀 값 명령의 꼴을, 아니면 앞의 명령·묶음 이름만 보인다
  if (plan === null && mentionsSecret(positionals)) return usageError(SECRET_USAGE);
  if (plan === null) return usageError(unknownCommandMessage(positionals));
  const { command } = plan;
  if (values.force !== undefined && command !== 'seat.assign') return usageError('--force는 seat assign에만 씁니다');
  if (values.label !== undefined && command !== 'agent.add') return usageError('--label은 agent add에만 씁니다');
  if (command !== 'serve') {
    const misplaced = SERVE_ONLY.filter((k) => values[k] !== undefined);
    if (misplaced.length) return usageError(`${misplaced.map((k) => `--${k}`).join(', ')}는 서버를 띄울 때(serve)만 씁니다`);
    // 보유자 표기 (S4-8) — 모양이 틀리면 서버에 붙지 않고 쓰임새 오류다. 그 값은 되풀이하지 않는다 (S3-39). external:<ID>는 서버가 등록 기록으로 본다 (S7-4)
    if (command === 'seat.assign' && !parseHolderSpec(plan.args![0]!)) return usageError(SEAT_HOLDER_SHAPE);
    // 외부 에이전트 (S7-2): 이름은 --label 하나(비면 쓰임새 오류 — 길이·글자는 서버가 본다), 폐기할 ID는 X-0001 꼴 — 틀리면 서버에 붙지 않고 되풀이하지 않는다
    if (command === 'agent.add' && !values.label?.trim()) return usageError(AGENT_ADD_USAGE);
    if (command === 'agent.revoke' && !AGENT_ID_RE.test(plan.args![0]!.trim())) return usageError(AGENT_ID_SHAPE);
    const args =
      command === 'seat.assign' && values.force === true
        ? [...plan.args!, '--force']
        : command === 'agent.add'
          ? [values.label!]
          : command === 'agent.revoke'
            ? [plan.args![0]!.trim()]
            : plan.args;
    return { kind: 'client', command, dataDir, json: values.json === true, ...(args ? { args } : {}) };
  }
  if (values.json) return usageError('--json은 운영자 명령(status 등)에만 씁니다');
  const portText = values.port ?? String(DEFAULT_PORT);
  // 포트 값은 숫자일 때만 되풀이한다 — 숫자가 아니면 값(비밀 값 등)을 잘못 붙였을 수 있다 (S3-39)
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) {
    return usageError(/^\d{1,10}$/.test(portText) ? `포트 번호가 올바르지 않습니다: ${portText}` : '포트 번호가 올바르지 않습니다 — 0부터 65535까지의 숫자를 넣으세요 (숫자가 아닌 값은 보이지 않습니다)');
  }
  // 공개 주소 (S3-7) — 모양이 틀리면 무엇도 만들기 전에 거부한다. 그 글은 적은 값을 되풀이하지 않는다
  const origin = values['public-origin'] !== undefined ? parsePublicOrigin(values['public-origin']) : null;
  if (origin && !origin.ok) return usageError(`--public-origin: ${origin.message}`);
  // 대표 이메일 (S3-6) — 모양이 틀리면 그 인자를 말하는 사용법 오류다. server.json의 잘못으로 보이지 않게 (S3-35)
  if (values['owner-email'] !== undefined && !normalizeOwnerEmail(values['owner-email'])) return usageError(OWNER_EMAIL_FLAG_INVALID);
  return {
    kind: 'serve',
    options: {
      dataDir,
      bind: values.bind ?? '127.0.0.1',
      port: Number(portText),
      webDir: values['web-dir'] ? values['web-dir'] : null,
      allowTestSession: values['allow-test-session'] === true,
      ...(values.config ? { configPath: values.config } : {}),
      ...(values['owner-email'] ? { ownerEmail: values['owner-email'] } : {}),
      ...(origin?.ok ? { publicOrigin: origin.origin } : {}),
      // 작업 폴더 위치 (리드 결정 S5-20) — 확인(절대 경로·데이터 폴더와 겹치지 않음)은 서버가 잠금 전에 한다(serve.ts, 시작 실패 1)
      ...(values['workspace-root'] ? { workspaceRoot: values['workspace-root'] } : {}),
    },
  };
}

function duration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}시간 ${m}분` : m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

export function formatStatus(s: AdminStatus): string {
  const stop = s.emergencyStop.active ? `켜짐${s.emergencyStop.since ? ` (${s.emergencyStop.since}부터)` : ''}` : '꺼짐';
  const secrets =
    s.secretStore.backend === 'keyring' ? 'OS 보안 저장소' : `메모리 (재시작하면 사라집니다${s.secretStore.fallbackReason ? ` — ${s.secretStore.fallbackReason}` : ''})`;
  const sessions = s.testSessions.allowed ? `발급 가능 (살아 있는 기기 세션 ${s.testSessions.active}개)` : '꺼짐 (--allow-test-session 없이 시작)';
  // 듣는 루프백 주소 (S2-14) — 예전 서버의 답에는 없다
  const where = s.addresses ? `이 PC 안에서만 — ${s.addresses.join('과 ')}에서 받습니다` : '이 PC 안에서만';
  // 화면 조작의 마지막으로 안 상태 (S6-11) — 예전 서버의 답에는 없다
  const screen = s.screen ? [`  화면 조작     ${s.screen.detail}`] : [];
  return [
    '욱채 서버 상태',
    `  프로세스      pid ${s.pid}, ${duration(s.uptimeSec)}째 실행 중`,
    `  주소          ${s.url} (${where})`,
    `  데이터 폴더   ${s.dataDir}`,
    `  실행 ID       ${s.runId}`,
    `  진행 중 작업  ${s.activeWork ? '있음' : '없음'}`,
    `  긴급 정지     ${stop}`,
    `  비밀 값 저장  ${secrets}`,
    ...screen,
    `  시험용 세션   ${sessions}`,
    `  버전          ${s.version}`,
    '',
  ].join('\n');
}

export function formatStop(summary: EmergencySummary): string {
  const turns = summary.stoppedTurns.length;
  const held = summary.heldTasks.length;
  if (!summary.completed) {
    const names = [...new Set(summary.failures.map((f) => f.memberName).filter(Boolean))];
    return `긴급 정지를 걸었지만 종료를 확인하지 못한 실행이 있습니다${names.length ? ` (${names.join(', ')})` : ''}. 새 실행은 막았고, 작업 ${held}개를 보류했습니다.\n`;
  }
  if (turns === 0 && held === 0) return '긴급 정지를 걸었습니다. 실행 중인 작업은 없었고, 새 실행을 막았습니다.\n';
  return `긴급 정지를 걸었습니다. 실행 ${turns}개를 멈추고 작업 ${held}개를 보류했습니다. 정지 해제는 대표 화면에서 합니다.\n`;
}

export function formatSession(g: TestSessionGrant): string {
  return [
    `운영자 시험 세션(대표의 기기 세션)을 발급했습니다.${g.ownerCreated ? ' 등록된 대표가 없어 시험용 대표를 만들었습니다.' : ''}`,
    `토큰: ${g.token}`,
    '요청마다 Authorization: Bearer <토큰> 머리로 보내세요. 이 토큰은 다시 보여 주지 않습니다.',
    '서버를 다시 시작해도 남습니다. 쓰지 않고 14일이 지나거나 만든 지 90일이 지나면 끝나고, 대표 화면의 기기 목록에서 끊을 수 있습니다.',
    '',
  ].join('\n');
}

const SOURCE_TEXT: Record<'config' | 'flag' | 'setup', string> = { config: 'server.json', flag: '--owner-email', setup: '설정 코드' };

/** config show — 비밀 값은 등록 여부만 */
export function formatConfig(v: ServerConfigView): string {
  const email = v.ownerEmail
    ? `${v.ownerEmail} (${SOURCE_TEXT[v.ownerEmailSource ?? 'config']}에서)`
    : `정해지지 않음${v.setupCodeExpiresAt ? ` — 설정 코드를 기다립니다 (${v.setupCodeExpiresAt}까지, 서버 콘솔·setup-code.txt)` : ' — 서버를 다시 시작하면 설정 코드가 나옵니다'}`;
  const cli = [v.cli.claudePath ? `Claude ${v.cli.claudePath}` : null, v.cli.codexPath ? `Codex ${v.cli.codexPath}` : null].filter(Boolean).join(', ') || '자동으로 찾음';
  const n = v.pending.network;
  const pending = [n.bind || n.port !== null ? `network(${[n.bind && `bind ${n.bind}`, n.port !== null && `port ${n.port}`].filter(Boolean).join(', ')})` : null].filter(Boolean);
  // 메인 자리 정책 (S4-12) — 처음 보유자는 자리가 비었을 때만 쓴다
  const seat = v.seat
    ? `앉을 수 있는 보유자 ${v.seat.holders.join(', ')} · 교체 때 마무리 기다림 ${v.seat.drainMs / 1000}초${v.initialHolder ? ` · 처음 보유자 ${v.initialHolder}(빈 자리일 때만)` : ''}`
    : null;
  return [
    '욱채 서버 운영자 설정',
    `  설정 파일       ${v.path} (${v.exists ? '있음' : '없음 — 기본값'}${v.loadedAt ? `, ${v.loadedAt}에 읽음` : ''})`,
    `  대표 이메일     ${email}`,
    `  대표 계정       ${v.ownerRegistered ? '구글 계정 등록됨' : '아직 등록 전 — 대표 이메일의 구글 계정으로 처음 로그인하면 등록됩니다'}`,
    `  구글 클라이언트 ${v.google.clientId ?? '없음 — wook-server config google-client-id로 넣습니다'}`,
    `  구글 보안 비밀  ${v.google.secretSet ? '등록됨 (OS 보안 저장소)' : '없음 — wook-server secret set google-client-secret으로 넣습니다'}`,
    `  CLI 위치        ${cli}`,
    `  기기 세션       살아 있는 것 ${v.deviceSessions}개`,
    `  공개 주소       ${v.access.publicOrigin ? `${v.access.publicOrigin} (${v.access.publicOriginSource === 'flag' ? '--public-origin' : 'server.json'}에서 — 이 주소의 Host·Origin도 받습니다)` : '없음 — 이 PC 안(루프백)에서만 받습니다'}`,
    `  Tailscale 사용자 ${v.access.tailscaleLogins ? `${v.access.tailscaleLogins.join(', ')}의 요청만 받습니다` : '검사하지 않음 (owner.tailscaleLogins가 비었습니다)'}`,
    ...(pending.length ? [`  아직 쓰지 않음  ${pending.join(', ')} — 이 단계에서는 읽기만 합니다`] : []),
    ...(seat ? [`  메인 자리       ${seat}`] : []),
    // 메인 에이전트 작업 폴더 (리드 결정 S5-20) — 서버를 시작할 때만 정한다
    ...(v.workspace ? [`  메인 작업 폴더  ${v.workspace.mainDir} (${workspaceSourceText(v.workspace.source)}에서 — 서버를 시작할 때만 정합니다)`] : []),
    ...v.warnings.map((w) => `  경고            ${w}`),
    '',
  ].join('\n');
}

/** config reload·owner-email·google-client-id의 결과 */
export function formatConfigResult(r: OperatorConfigResult, what: string): string {
  const lines = r.changes.length ? [`${what}: 바꾼 것 ${r.changes.length}개`, ...r.changes.map((c: ServerConfigChange) => `  - ${c.text}`)] : [`${what}: 바뀐 것이 없습니다`];
  return [...lines, ...r.warnings.map((w) => `경고: ${w}`), ''].join('\n');
}

const CHANGED_BY: Record<'main' | 'operator' | 'server', string> = { main: '메인 에이전트', operator: '운영자', server: '서버' };

/** 진행 중인 교체의 단계 글 (seat status·seat assign) */
function swapStageText(stage: 'draining' | 'finishing' | 'unconfirmed', drainMs: number): string {
  if (stage === 'draining') return `나가는 메인 턴의 마무리를 기다립니다 (최대 ${drainMs / 1000}초)`;
  if (stage === 'finishing') return '나가는 보유자의 인계 메모 턴(최대 2분)과 마무리를 하고 있습니다';
  // 멈춘 동안 메인 에이전트는 일시정지돼 있고(대표 화면의 '정지 해제'가 출구), 운영자의 seat assign은 받지 않는다 (리드 결정 S4-18)
  return "멈췄습니다 — 나가는 메인 턴의 종료를 확인하지 못해 메인 에이전트를 일시정지해 두었습니다. 이 PC에 남은 프로세스가 모두 사라졌는지 확인한 뒤 대표가 '정지 해제'를 누르면 일시정지가 풀리고 교체를 이어 갑니다. 그동안 seat assign은 받지 않습니다";
}

/** seat status (S4-8) — 보기만 한다 */
export function formatSeatStatus(v: SeatOperatorStatus): string {
  const s = v.seat;
  const holder = s.holder ? `${s.holder.label} (세대 ${s.generation}${s.since ? `, ${s.since}부터` : ''})` : `없음 (마지막 세대 ${s.generation})`;
  const state =
    s.state === 'active'
      ? '앉아 있음'
      : s.state === 'switching'
        ? `교체 중 → ${s.pendingHolder?.label ?? '?'}${v.swap ? ` (세대 ${v.swap.from} → ${v.swap.to}, ${CHANGED_BY[v.swap.by]}${v.swap.force ? ' · 강제' : ''}) — ${swapStageText(v.swap.stage, v.policy.drainMs)}` : ''}`
        : s.state === 'vacant'
          ? '비어 있음'
          : '멈춤';
  const silent = v.unresponsiveForMs === null ? null : seatDurationText(v.unresponsiveForMs);
  // 교체 중에는 seat assign을 받지 않으므로 그 길을 말하지 않는다 (리드 결정 S4-28)
  const answer = s.unresponsiveSince
    ? `응답 없음 ${silent ? `${silent}째` : '(방금부터)'} — ${s.unresponsiveReason ?? '까닭을 알 수 없습니다'}. 서버는 자리를 바꾸지 않습니다${s.state === 'switching' ? '' : ' — 바꾸려면 wook-server seat assign <보유자>'}`
    : '응답함';
  // external:*는 등록하고 폐기하지 않은 외부 에이전트 모두다 (리드 결정 S7-4)
  const holders = v.policy.holders.map((h) => (h.trim() === 'external:*' ? `${h}(등록한 외부 에이전트 모두)` : h)).join(', ');
  const history = v.history.map(
    (h) => `세대 ${h.generation} ${h.holder.label} — ${CHANGED_BY[h.changedBy]}, ${h.startedAt}부터${h.endedAt ? ` ${h.endedAt}까지${h.endReason ? ` (${h.endReason})` : ''}` : ''}`,
  );
  return [
    '욱채 메인 자리',
    `  보유자          ${holder}`,
    `  상태            ${state}`,
    `  응답            ${answer}`,
    `  앉을 수 있는 쪽 ${holders}`,
    `  마무리 기다림   ${v.policy.drainMs / 1000}초`,
    ...history.map((line, i) => `  ${i === 0 ? '최근 이력      ' : '               '} ${line}`),
    '',
  ].join('\n');
}

/** seat assign (S4-8)의 결과 — 끝났는지, 넘기는 중인지, 멈췄는지 */
export function formatSeatAssign(r: SeatAssignReport): string {
  if (r.outcome === 'seated') return `빈 메인 자리에 ${r.holder}${objectJosaOf(r.holder)} 앉혔습니다 (세대 ${r.generation}, 운영자 배정).\n`;
  if (r.outcome === 'same') return `보유자는 그대로 ${r.holder}이고 모델·노력치만 바꿨습니다 (세대 ${r.generation} 그대로, 다음 턴부터 적용).\n`;
  const span = `세대 ${r.from} → ${r.generation}`;
  if (r.state === 'active') {
    return `메인 자리를 ${r.holder}에게 넘겼습니다 (${span}, 운영자 배정${r.force ? ', 강제 — 마무리와 인계 메모 턴을 기다리지 않음' : ''}). 메인 토큰을 폐기하고 메인 세션을 닫았습니다. 새 보유자는 인계 꾸러미를 받고 쌓인 일을 이어서 처리합니다.\n`;
  }
  if (r.stage === 'unconfirmed') return `메인 자리 교체가 멈췄습니다 (${span}) — ${r.holder}${objectJosaOf(r.holder)} 아직 앉히지 않았습니다. ${swapStageText('unconfirmed', r.drainMs).replace(/^멈췄습니다 — /, '')}.\n`;
  return `메인 자리를 ${r.holder}에게 넘기는 중입니다 (${span}) — ${swapStageText(r.stage ?? 'draining', r.drainMs)}. 끝나면 넘어갑니다. wook-server seat status로 확인하세요.\n`;
}

/**
 * agent add (S7-2) — 키는 이 한 번만 보인다(표준 출력). 서버는 해시만 두어 다시 보여 줄 수 없다. 뒤에 메인 자리에 앉히는 길(seat assign external:<ID>)을 붙인다
 */
export function formatAgentAdd(g: ExternalAgentGrant): string {
  return [
    `외부 에이전트를 등록했습니다: ${g.id} (${g.label})`,
    '에이전트 키 — 지금 한 번만 보입니다. 서버는 해시만 저장해 다시 보여 줄 수 없습니다 (잃어버리면 agent revoke로 폐기하고 agent add로 새로 받습니다):',
    `  ${g.key}`,
    '이 키는 에이전트에게 환경 변수 WOOK_AGENT_KEY나 그 사용자만 읽는 ~/.wook/agent.json으로 넘기세요 — 명령 줄 인자로는 넘기지 마세요(다른 프로그램이 볼 수 있습니다).',
    `메인 자리에 앉히려면: wook-server seat assign external:${g.id}`,
    '',
  ].join('\n');
}

/** agent revoke (S7-2) — 이미 폐기됐어도 같은 끝(0). 메인 자리에 앉은 에이전트면 자리는 그대로이고 응답 없음이 된다고 덧붙인다 */
export function formatAgentRevoke(r: ExternalAgentRevokeReport): string {
  const head = r.already
    ? `외부 에이전트 ${r.id} (${r.label})의 키는 이미 폐기돼 있습니다 (${r.revokedAt} 폐기) — 바꾼 것이 없습니다.`
    : `외부 에이전트 ${r.id} (${r.label})의 키를 폐기했습니다 (${r.revokedAt}). 이 키로는 더 접속할 수 없습니다.`;
  const seat = r.seated
    ? ' 이 에이전트는 메인 자리에 앉아 있거나 들어올 차례입니다 — 서버는 자리를 바꾸지 않으므로 자리는 그대로 두고 응답 없음이 됩니다. 다른 보유자에게 넘기려면 wook-server seat assign <보유자>.'
    : '';
  return `${head}${seat}\n`;
}

/** agent list (S7-2) — 키·해시는 없다 */
export function formatAgentList(list: readonly ExternalAgentView[]): string {
  if (!list.length) return '등록된 외부 에이전트가 없습니다 — wook-server agent add --label <이름>으로 등록합니다.\n';
  const seatText = (a: ExternalAgentView): string => (a.seat === 'seated' ? '메인 자리에 앉아 있음' : a.seat === 'incoming' ? '메인 자리에 들어올 차례(교체 중)' : '메인 자리 아님');
  const lines = list.map((a) =>
    a.revokedAt
      ? `  ${a.id} ${a.label} — 폐기됨 (${a.revokedAt}), 등록 ${a.createdAt}, 마지막 접속 ${a.lastSeenAt ?? '없음'}${a.seat ? `, ${seatText(a)}` : ''}`
      : `  ${a.id} ${a.label} — 등록 ${a.createdAt}, 마지막 접속 ${a.lastSeenAt ?? '없음'}, ${seatText(a)}, ${a.connected ? '연결됨(임대 있음)' : '연결 안 됨'}`,
  );
  return [`욱채 외부 에이전트 (${list.length}개 — 폐기한 것 포함)`, ...lines, ''].join('\n');
}

/** 받침이 있으면 '을', 없으면 '를' — 보유자 이름은 'Claude CLI'처럼 영문으로 끝나 읽는 소리로 본다 */
function objectJosaOf(word: string): string {
  const last = word.trim().slice(-1);
  const c = last.charCodeAt(0) - 0xac00;
  if (c >= 0 && c <= 11171) return c % 28 !== 0 ? '을' : '를';
  return /[013678lmnrLMNR]/.test(last) ? '을' : '를';
}

/**
 * 비밀 값을 표준 입력에서 읽는다 (secret set, S3-8) — 명령 줄에는 받지 않는다. 파이프로 넘기면 끝까지 읽고 끝의 줄바꿈을 뗀다. 터미널이면 화면에 보이지
 * 않게 한 줄을 받는다(Ctrl+C로 그만둔다)
 */
export async function readSecretInput(input: NodeJS.ReadStream, out: (text: string) => Promise<void>): Promise<string> {
  const limit = 64 * 1024;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
      size += b.length;
      if (size > limit) throw new Error('표준 입력이 너무 깁니다');
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  await out('보안 비밀을 붙여 넣고 Enter를 누르세요 (화면에 보이지 않습니다): ');
  return new Promise<string>((resolveSecret, reject) => {
    let value = '';
    const done = (): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      void out('\n');
    };
    const onData = (text: string): void => {
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolveSecret(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new Error('보안 비밀 입력을 그만두었습니다'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (value.length < limit) value += ch;
      }
    };
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `--json`의 한 줄 — ASCII만 낸다 (리드 결정 S7-19 C1): JSON.stringify 뒤 ASCII 밖의 글자를 모두 `\uXXXX`로 적는다. Windows PowerShell 5.1은 다른 프로그램의
 * 출력을 콘솔 코드 페이지(이 PC는 949)로 읽어, UTF-8 한글이 섞이면 따옴표가 깨져 ConvertFrom-Json이 실패하고 그 오류 글에 답 전체(키 포함)를 싣는다.
 * ASCII는 어느 코드 페이지로 읽어도 같다
 */
export function jsonLine(value: unknown): string {
  // [^ -~]: 빈칸~물결표 밖 — JSON.stringify는 제어 글자를 이미 \u로 적으므로 남는 것은 ASCII 밖의 글자(와 DEL)뿐이다. 서로게이트 쌍은 반쪽씩 적는다(JSON에서 맞는 꼴)
  return `${JSON.stringify(value).replace(/[^ -~]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

/** 운영자 명령 하나 → 끝낼 코드 */
async function runClient(plan: Extract<CliPlan, { kind: 'client' }>, io: ServeIo): Promise<number> {
  const print = (reply: AdminReply, text: () => string): Promise<void> => (plan.json ? io.out(jsonLine(reply)) : io.out(text()));
  const failWith = async (e: AdminClientError): Promise<number> => {
    if (plan.json) await io.out(jsonLine({ ok: false, error: { code: e.code, message: e.message } }));
    else await io.err(`${e.message}\n`);
    return 1;
  };
  // 비밀 값은 표준 입력으로만 받는다 — 서버를 확인한 뒤에 관리 채널로 보낸다 (S3-16)
  let secret: string | undefined;
  if (plan.command === 'secret.set') {
    if (!io.readSecret) return failWith(new AdminClientError('closed', '이 실행에서는 표준 입력을 읽을 수 없습니다'));
    try {
      secret = (await io.readSecret()).trim();
    } catch (error) {
      return failWith(new AdminClientError('closed', (error as Error).message));
    }
    if (!secret) return failWith(new AdminClientError('closed', '표준 입력으로 받은 보안 비밀이 비었습니다 — 값을 파이프로 넘기거나 붙여 넣으세요'));
  }
  let reply: AdminReply;
  try {
    reply = await operatorRequest({ dataDir: plan.dataDir, command: plan.command, args: plan.args, ...(secret !== undefined ? { secret } : {}) });
  } catch (error) {
    return failWith(error instanceof AdminClientError ? error : new AdminClientError('closed', (error as Error).message));
  }
  if (!reply.ok) {
    if (plan.json) await io.out(jsonLine(reply));
    else await io.err(`${reply.error.message}\n`);
    return 1;
  }
  const result = reply.result;
  switch (plan.command) {
    case 'status':
      await print(reply, () => formatStatus(result as AdminStatus));
      return 0;
    case 'stop':
      await print(reply, () => formatStop(result as EmergencySummary));
      return 0;
    case 'session.test':
      await print(reply, () => formatSession(result as TestSessionGrant));
      return 0;
    case 'config.show':
      await print(reply, () => formatConfig(result as ServerConfigView));
      return 0;
    case 'config.reload':
      await print(reply, () => formatConfigResult(result as OperatorConfigResult, '운영자 설정을 다시 읽었습니다'));
      return 0;
    case 'config.owner-email':
      await print(reply, () => formatConfigResult(result as OperatorConfigResult, '대표 이메일을 server.json에 쓰고 적용했습니다'));
      return 0;
    case 'config.google-client-id':
      await print(reply, () => formatConfigResult(result as OperatorConfigResult, '구글 클라이언트 ID를 server.json에 쓰고 적용했습니다'));
      return 0;
    case 'secret.set':
      await print(reply, () => '구글 로그인 보안 비밀을 OS 보안 저장소에 넣었습니다 (값은 다시 보여 주지 않습니다).\n');
      return 0;
    case 'secret.clear':
      await print(reply, () => '구글 로그인 보안 비밀을 지웠습니다. 다시 넣기 전까지 기기 코드 로그인을 시작할 수 없습니다.\n');
      return 0;
    case 'seat.status':
      await print(reply, () => formatSeatStatus(result as SeatOperatorStatus));
      return 0;
    case 'seat.assign': {
      // 멈춘 교체(나가는 턴의 종료를 확인하지 못함)는 끝나지 않았으므로 1로 끝낸다 — 넘기는 중은 0 (seat status로 본다)
      const r = result as SeatAssignReport;
      await print(reply, () => formatSeatAssign(r));
      return r.stage === 'unconfirmed' ? 1 : 0;
    }
    // 외부 에이전트 (S7-2) — add의 키는 표준 출력에 한 번만(--json이면 그 답 그대로). 폐기는 이미 폐기됐어도 0
    case 'agent.add':
      await print(reply, () => formatAgentAdd(result as ExternalAgentGrant));
      return 0;
    case 'agent.revoke':
      await print(reply, () => formatAgentRevoke(result as ExternalAgentRevokeReport));
      return 0;
    case 'agent.list':
      await print(reply, () => formatAgentList(result as ExternalAgentView[]));
      return 0;
    case 'shutdown': {
      // 응답 뒤 서버가 끝날 때까지 기다린다 (관리 채널이 닫히거나 실행 잠금이 풀리면 끝난 것) — 종료 흐름의 상한(30초)보다 조금 길게
      const deadline = Date.now() + 40_000;
      let gone = false;
      while (Date.now() < deadline) {
        await sleep(250);
        try {
          await operatorRequest({ dataDir: plan.dataDir, command: 'status', timeoutMs: 2000 });
        } catch (error) {
          if (error instanceof AdminClientError && (error.code === 'not_running' || error.code === 'closed')) {
            gone = true;
            break;
          }
        }
      }
      const done = { shuttingDown: true, stopped: gone };
      if (plan.json) await io.out(jsonLine({ ok: true, result: done }));
      else await io.out(gone ? '서버를 종료했습니다.\n' : '종료를 요청했지만 40초 안에 끝나지 않았습니다. 서버 기록(logs/server.log)을 확인해 주세요.\n');
      return gone ? 0 : 1;
    }
  }
}

/** 진입점: 서버면 준비된 뒤 null(종료 흐름이 끝낸다), 그 밖에는 끝낼 코드 */
export async function runCli(argv: readonly string[], io: ServeIo): Promise<number | null> {
  const plan = parseCli(argv);
  switch (plan.kind) {
    case 'help':
      await io.out(USAGE);
      return 0;
    case 'error':
      await io.err(`${plan.message}\n\n${USAGE}`);
      return 2;
    case 'client':
      return runClient(plan, io);
    case 'serve': {
      // 서버 쪽(백엔드·저장소)은 서버를 띄울 때만 불러온다 — 운영자 명령은 가볍게 끝난다
      const { runServe } = await import('./serve');
      return runServe(plan.options, io);
    }
  }
}
