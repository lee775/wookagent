/**
 * 서버 열기 (SERVER_DESIGN 3.2·3.4, S2-2~S2-4·S2-8): 이미 만든 백엔드를 감싸 대표용 HTTP와 관리 채널을 연다.
 * 서버 프로세스(serve.ts)가 createBackend 뒤에 부르고, 시험은 하네스 백엔드를 감싸 프로세스 안에서 부른다.
 * - HTTP는 루프백에만 연다. 그 밖의 --bind는 시작 때 거부한다 (S2-2) — 원격 접속은 늘 `tailscale serve`로 (3.6).
 *   --bind 127.0.0.1·::1·localhost는 모두 '루프백'이라는 뜻이고, 같은 포트의 127.0.0.1과 ::1을 둘 다 잡는다 — 하나라도 이미 쓰이면 시작하지 않는다 (S2-14)
 * - 관리 채널을 열기 전에 새 관리 토큰을 쓴다 (S2-4). 그보다 먼저 죽은 서버가 남긴 자리 파일(admin.endpoint)을 지운다 — 관리 채널 자리는 시작마다
 *   새로 정하고(Windows 파이프 이름의 난수), 연 뒤에 자리 파일로 알린다 (S2-20)
 * - 관리 채널 명령: status·stop·shutdown·session test, 운영자 설정 config show|reload|owner-email|google-client-id(server.json — config.ts),
 *   비밀 값 secret set|clear google-client-secret (S3-8)·claude-api-key·codex-api-key (S9-6 — 값은 표준 입력으로만, 답에는 등록 여부만), 메인 자리
 *   seat status·seat assign <보유자> [--force] (S4-8). status는 9단계부터 관리 채널 전송(adminPipe)·절전 방지(power)·배포 점검(deploy)도 싣는다 (S9-2)
 * - 접속 허용(공개 주소·받는 Tailscale 사용자, S3-7)은 운영자 설정에서 요청마다 읽는다 — config reload가 바로 바꾸고, 열린 SSE도 적용한 뒤 다시 봐 이제
 *   받지 않는 것은 닫는다 (S3-34). 올린 파일은 시작 때와 1시간마다 24시간 지난 것을 지운다 (S3-10)
 * - HTTP 서버는 Node의 requestTimeout을 끄고 머리 시간(60초)만 건다 — 본문 시간은 HTTP 표면이 길마다 본다(invoke 30초, 업로드 쉼 60초·전체 60분, S3-32)
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { BackendError, type AgentBackend, type Backend, type BackendOperator, type BackendOperatorStatus, type ServerFileAccess, type TestSessionGrant } from '../main/backend/types';
import type { DeviceSessionStore } from '../main/auth/deviceSessions';
import type { Logger } from '../main/shell/logger';
import {
  adminEndpointInUseMessage,
  adminEndpointPath,
  adminTokenPath,
  newAdminEndpoint,
  startAdminChannel,
  writeAdminToken,
  writePrivateFile,
  type AdminChannel,
  type AdminHandlers,
} from './admin';
import type { AdminPipeInfo, AdminTransport } from './adminPipe';
import type { ServerPowerStatus } from './power';
import type { DeployReport } from './deployCheck';
import { createHttpSurface, createSurfaceServer, type HttpSurface, type HttpTimeouts, type RateLimits, type StaticCacheLimits } from './http';
import { createOperatorConfig, serverConfigPath, type OperatorConfig } from './config';
import { parsePublicOrigin } from './sessions';
import { hasWebBuildMarker } from './webScreen';
import { createAgentApi, type AgentApi } from './agentApi';
import { AGENT_API_PREFIX, AGENT_ENDPOINT_VERSION, AGENT_PROOF_BYTES, type AgentEndpointFile } from './agentApiTypes';

/** 에이전트 API 주소 파일 (리드 결정 S7-2) — 주소만, 키는 없다. 그 사용자만 읽는다 */
export const AGENT_ENDPOINT_FILE = 'agent-endpoint.json';
export function agentEndpointPath(dataDir: string): string {
  return join(dataDir, AGENT_ENDPOINT_FILE);
}

export const LOOPBACK_BINDS = ['127.0.0.1', '::1', 'localhost'] as const;
export const DEFAULT_PORT = 7317;
/** 올린 파일 정리 주기 (S3-10 — 24시간 지난 것을 지운다) */
const UPLOAD_SWEEP_MS = 60 * 60 * 1000;

/** 시작을 막는 잘못 — 메시지를 그대로 보여 준다 */
export class ServerStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ServerStartError';
  }
}

export function isLoopbackBind(bind: string): boolean {
  return (LOOPBACK_BINDS as readonly string[]).includes(bind);
}

/** 서버용 빌드 표시가 없는 --web-dir를 거부하는 글 (리드 결정 S8-5) */
export function webDirNotRemoteMessage(webDir: string): string {
  return `--web-dir 폴더가 서버용 웹 화면이 아닙니다: ${webDir} — index.html에 서버용 빌드 표시가 없어, 가짜 자료로 도는 개발용 화면일 수 있습니다. npm run build:web으로 다시 만든 out/web을 넘기세요`;
}

/** 루프백 밖 --bind를 거부하는 글 (S2-2) */
export function nonLoopbackBindMessage(bind: string): string {
  return `--bind ${bind}는 받지 않습니다 — 서버는 이 PC 안(127.0.0.1, ::1, localhost)에만 엽니다. 다른 기기에서는 tailscale serve로 들어오게 하세요`;
}

/**
 * 서버가 감싸는 백엔드 (createBackend mode 'server'): 호출자를 받는 invoke(원격 길 게이트, S3-3), 거르지 않은 토픽과 호출자별 거르기, 운영자 길,
 * 기기 세션 저장소(S3-4), 업로드·내려받기(S3-10 — 없으면 그 경로가 없다. 가짜 백엔드 시험)
 */
export type ServerBackend = Pick<Backend, 'invoke' | 'onTopicRaw' | 'topicFor' | 'snapshotFor' | 'hasActiveWork'> & {
  readonly operator: BackendOperator;
  readonly sessions: Pick<DeviceSessionStore, 'verify' | 'live' | 'list' | 'onRevoke'>;
  readonly files?: ServerFileAccess;
  /**
   * 외부 에이전트 API의 백엔드 쪽 (리드 결정 S7-2) — 있으면 `/agent/v1/*`를 앱 도구 서버의 루프백 리스너에 붙이고(대표용 포트에는 붙이지 않는다) 그 주소를
   * `<dataDir>/agent-endpoint.json`에 적는다. 없으면(가짜 백엔드) 붙이지 않는다
   */
  readonly agents?: AgentBackend;
};

export interface StartServerOptions {
  backend: ServerBackend;
  dataDir: string;
  bind?: string;
  port?: number;
  webDir?: string | null;
  /** 관리 채널 `session test`(운영자 시험 세션 — 실제 기기 세션, S3-4)를 받는지 (--allow-test-session) */
  allowTestSession: boolean;
  /**
   * 공개 주소 (S3-7) — 받는 Host와 상태 변경 요청에 받는 Origin에 더한다. 없으면 운영자 설정(--public-origin → server.json network.publicOrigin)을
   * 요청마다 읽는다. 모양이 틀리면 시작하지 않는다
   */
  publicOrigin?: string | null;
  /** 받는 Tailscale 사용자 (S3-7) — 없으면 운영자 설정(server.json owner.tailscaleLogins)을 요청마다 읽는다. 비면 검사하지 않는다 */
  tailscaleLogins?: readonly string[] | null;
  /** 시험: 횟수 제한 (S3-11) */
  rateLimits?: Partial<RateLimits>;
  /** 시험: HTTP 시간 상한 (S3-32, 기본 DEFAULT_HTTP_TIMEOUTS — 머리 60초, invoke 본문 30초, 업로드 쉼 60초·전체 60분) */
  timeouts?: Partial<HttpTimeouts>;
  logger: Logger;
  version: string;
  runId?: string;
  /** 관리 채널 `shutdown` — 응답을 보낸 뒤 부른다. 받는 쪽이 종료 흐름(createQuitFlow)을 시작한다 */
  onShutdownRequest?: () => void;
  /** 시험: 시계·SSE 주기 */
  now?: () => number;
  sse?: { heartbeatMs?: number; queueLimit?: number };
  /** 시험: HTTP 접근 줄을 모으는 창 (기본 HTTP_ACCESS_WINDOW_MS) */
  accessLogWindowMs?: number;
  /** 시험: 정적 화면 캐시의 상한 (S8-26 c, 기본 DEFAULT_STATIC_CACHE_LIMITS) */
  staticCache?: Partial<StaticCacheLimits>;
  /** 시험: 관리 채널 자리 (기본은 시작마다 새로 — newAdminEndpoint). 남이 먼저 연 이름을 흉내 낼 때 */
  adminEndpoint?: string;
  /**
   * 관리 채널의 전송 (리드 결정 S9-7, adminPipe.ts) — 기본 'node'(Node 파이프·소켓 — 프로세스 안 시험 서버는 그대로다). 서버 프로세스(serve.ts)는 Windows에서
   * 서버 도우미를 넘긴다. 도우미를 쓸 수 없으면 Node 파이프로 물러나고 경고·운영자 활동 기록을 남긴다
   */
  adminTransport?: AdminTransport;
  /** 관리 status의 절전 방지 (리드 결정 S9-2·S9-5) — 서버 프로세스가 준다. null이면 status에 넣지 않는다 */
  powerStatus?: () => ServerPowerStatus | null;
  /**
   * 관리 status의 배포 점검 (리드 결정 S9-2·S9-4) — 서버 프로세스가 준다(시작 뒤 한 번 돈 점검의 결과, 아직 없으면 null). 주지 않으면(프로세스 안 시험 서버) status에
   * 그 칸이 없다
   */
  deployStatus?: () => DeployReport | null;
  /**
   * 운영자 설정 (server.json, S3-8) — 관리 채널 config.* 명령이 쓴다. 서버 프로세스(serve.ts)가 시작 때 읽고 적용한 것을 넘긴다. 없으면
   * `<dataDir>/server.json`을 쓰는 것을 만든다(아직 읽지 않은 채 — 프로세스 안 시험 서버)
   */
  operatorConfig?: OperatorConfig;
}

export interface AdminStatus extends BackendOperatorStatus {
  pid: number;
  uptimeSec: number;
  /** --bind로 고른 루프백 이름 (어느 것이든 두 루프백을 다 잡는다, S2-14) */
  bind: string;
  port: number;
  url: string;
  /** 실제로 듣는 루프백 주소 — 127.0.0.1과 ::1(이 PC에 IPv6 루프백이 없으면 127.0.0.1만). 예전 서버의 답에는 없다 */
  addresses?: string[];
  dataDir: string;
  runId: string;
  activeWork: boolean;
  version: string;
  /** 운영자 시험 세션을 발급하는지(allowed)와 살아 있는 기기 세션 수(active) */
  testSessions: { allowed: boolean; active: number };
  /** 관리 채널의 전송 — 서버 도우미인지, 다른 기기(SMB)를 거부하는지, 지금 사용자만 여는지, 도우미가 아닌 까닭 (리드 결정 S9-2·S9-7). 예전 서버의 답에는 없다 */
  adminPipe?: AdminPipeInfo;
  /** 절전 방지 (리드 결정 S9-2·S9-5) — 서버 프로세스만 준다. 예전 서버·프로세스 안 시험 서버의 답에는 없다 */
  power?: ServerPowerStatus;
  /**
   * 배포 점검 (리드 결정 S9-2·S9-4) — 서버 프로세스가 시작 뒤 한 번 돌린 `check`의 결과. 아직 끝나지 않았거나 돌리지 않으면(시험 중·Windows 밖) null.
   * 예전 서버·프로세스 안 시험 서버의 답에는 없다
   */
  deploy?: DeployReport | null;
}

/** 관리 채널 `session test`의 답 — 토큰 원문은 여기서 한 번만 나간다 */
export type { TestSessionGrant };

export interface RunningServer {
  url: string;
  bind: string;
  port: number;
  /** 실제로 듣는 루프백 주소 (S2-14) */
  addresses: string[];
  runId: string;
  /** 지금 듣는 관리 채널 자리 — 서버 도우미를 다시 띄우거나 Node 파이프로 물러나면 바뀐다 (S9-7) */
  readonly adminEndpoint: string;
  /** 시험: 관리 채널이 TCP가 아님을 확인한다 */
  adminAddress(): ReturnType<AdminChannel['address']>;
  /** 관리 status와 같은 답 (프로세스 안 — 서버 프로세스의 배포 점검이 관리 채널 전송·화면 조작·포트를 읽는다, S9-4) */
  status(): Promise<AdminStatus>;
  /** 종료 시작 — 새 요청은 503 (종료 흐름의 beforeShutdown) */
  beginShutdown(): void;
  /** SSE·HTTP·관리 채널을 닫고 관리 토큰을 지운다. 끝나기를 기다리지 않는다 (종료 흐름의 cleanup) */
  closeNow(): void;
  /** closeNow + 모두 닫힐 때까지 */
  close(): Promise<void>;
  /** 서버 기록 가리기: 관리 토큰 값을 지운다 (기록에 넣지 않지만 한 겹 더) */
  redactAdminToken(text: string): string;
}

const urlFor = (bind: string, port: number): string => `http://${bind.includes(':') ? `[${bind}]` : bind}:${port}`;

/** 관리 채널 명령 뒤의 낱말 하나 (config owner-email <이메일> 등) */
function oneArg(args: readonly string[], what: string): string {
  if (args.length !== 1 || !args[0]!.trim()) throw new BackendError('invalid_args', `${what} 하나를 명령 뒤에 적으세요`);
  return args[0]!.trim();
}

/**
 * seat assign 뒤의 낱말 (S4-8): 보유자 하나와, 강제면 '--force'. 보유자 모양은 백엔드(SeatService.operatorAssign)가 본다 — 틀린 값은 어느 쪽도 되풀이하지
 * 않는다 (S3-39)
 */
function seatAssignArgs(args: readonly string[]): { holder: string; force: boolean } {
  const ok = (args.length === 1 || (args.length === 2 && args[1] === '--force')) && !!args[0]?.trim();
  if (!ok) throw new BackendError('invalid_args', 'seat assign 뒤에는 보유자 하나(launched:claude·launched:codex·external:<ID>)와 --force(고를 때만)를 적습니다');
  return { holder: args[0]!.trim(), force: args.length === 2 };
}

/**
 * 운영자가 넣는 비밀 값의 이름 — 서버의 구글 로그인 보안 비밀(S3-8)과 AI의 API 키 둘(리드 결정 S9-6 — 데스크톱 앱과 같은 OS 보안 저장소 계정 api-key-claude·
 * api-key-codex. 같은 PC의 데이터 폴더가 모두 함께 쓴다)
 */
export const SECRET_NAMES = ['google-client-secret', 'claude-api-key', 'codex-api-key'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** API 키 이름 → AI 종류 (구글 보안 비밀이면 null) */
export function apiKeyKindOf(name: SecretName): 'claude' | 'codex' | null {
  return name === 'claude-api-key' ? 'claude' : name === 'codex-api-key' ? 'codex' : null;
}

function secretName(args: readonly string[]): SecretName {
  const name = args.length === 1 ? args[0] : undefined;
  if (!(SECRET_NAMES as readonly (string | undefined)[]).includes(name)) throw new BackendError('invalid_args', `비밀 값 이름은 ${SECRET_NAMES.join(', ')}만 받습니다`);
  return name as SecretName;
}

/** 두 루프백 주소 (S2-14) */
export const LOOPBACK_V4 = '127.0.0.1';
export const LOOPBACK_V6 = '::1';
/** 빈 포트(0)를 고를 때 ::1의 같은 번호가 이미 쓰이면 새 번호로 다시 해 보는 횟수 */
const PORT_PICK_ATTEMPTS = 5;

export interface LoopbackListen {
  /** 듣는 서버 — 127.0.0.1 것이 먼저, IPv6 루프백이 있으면 ::1 것 */
  servers: Server[];
  port: number;
  /** ::1도 잡았는지 (false = 이 PC에 IPv6 루프백이 없음) */
  v6: boolean;
}

const listenOn = (server: Server, host: string, port: number): Promise<void> =>
  new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', reject);
      resolveListen();
    });
  });

const closeQuietly = (server: Server): Promise<void> => new Promise<void>((r) => server.close(() => r()));

/**
 * 같은 포트로 두 루프백(127.0.0.1과 ::1)을 모두 잡는다 (S2-14). Host 검사(S2-3)는 localhost·[::1]도 이 서버로 받는데, Windows에서 localhost는
 * ::1이 먼저다 — 한쪽을 비워 두면 같은 PC의 다른 계정이 그 자리에서 듣다가 localhost로 보낸 Bearer 토큰을 받는다. 그래서 둘 중 하나라도 이미
 * 쓰이면 시작하지 않는다. 이 PC에 IPv6 루프백이 없으면(::1에서 EADDRNOTAVAIL·EAFNOSUPPORT) 127.0.0.1만 연다 — 그때는 localhost도 127.0.0.1로만 간다.
 * 포트 0이면 127.0.0.1에서 먼저 번호를 받고 ::1에 같은 번호를 잡는다. ::1의 그 번호가 이미 쓰이면 새 번호로 몇 번 다시 한다
 */
export async function listenLoopback(o: { make: () => Server; port: number; logger: Logger; attempts?: number }): Promise<LoopbackListen> {
  const attempts = o.port === 0 ? (o.attempts ?? PORT_PICK_ATTEMPTS) : 1;
  for (let attempt = 1; ; attempt++) {
    const v4 = o.make();
    try {
      await listenOn(v4, LOOPBACK_V4, o.port);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') throw new ServerStartError(`포트 ${o.port}을 이미 다른 프로그램이 쓰고 있습니다 — --port로 다른 포트를 고르세요`, { cause: error });
      throw new ServerStartError(`HTTP를 열지 못했습니다 (${LOOPBACK_V4}:${o.port}): ${code ?? (error as Error).message}`, { cause: error });
    }
    const address = v4.address();
    const port = typeof address === 'object' && address ? address.port : o.port;
    const v6 = o.make();
    try {
      await listenOn(v6, LOOPBACK_V6, port);
      return { servers: [v4, v6], port, v6: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
        o.logger.info(`이 PC에는 IPv6 루프백(::1)이 없어 127.0.0.1에서만 받습니다 — localhost도 127.0.0.1로만 갑니다 (${code})`);
        return { servers: [v4], port, v6: false };
      }
      await closeQuietly(v4);
      if (code === 'EADDRINUSE' && attempt < attempts) continue;
      if (code === 'EADDRINUSE') {
        throw new ServerStartError(
          `포트 ${port}의 IPv6 루프백 자리([::1]:${port})를 이미 다른 프로그램이 쓰고 있습니다 — localhost로 온 요청이 그쪽으로 갈 수 있어 시작하지 않습니다. --port로 다른 포트를 고르세요`,
          { cause: error },
        );
      }
      throw new ServerStartError(`HTTP를 열지 못했습니다 ([${LOOPBACK_V6}]:${port}): ${code ?? (error as Error).message}`, { cause: error });
    }
  }
}

export async function startServer(o: StartServerOptions): Promise<RunningServer> {
  const { logger, backend } = o;
  const bind = o.bind ?? '127.0.0.1';
  const requestedPort = o.port ?? DEFAULT_PORT;
  const runId = o.runId ?? randomUUID();
  const now = o.now ?? Date.now;
  const startedAt = now();
  if (!isLoopbackBind(bind)) throw new ServerStartError(nonLoopbackBindMessage(bind));
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new ServerStartError(`포트 번호가 올바르지 않습니다: ${requestedPort}`);
  // 공개 주소의 모양 (S3-7) — 틀린 값으로 받는 Host·Origin을 넓히지 않는다
  let fixedOrigin: string | null | undefined = o.publicOrigin === undefined ? undefined : null;
  if (o.publicOrigin) {
    const parsed = parsePublicOrigin(o.publicOrigin);
    if (!parsed.ok) throw new ServerStartError(`--public-origin: ${parsed.message}`);
    fixedOrigin = parsed.origin;
  }
  const webDir = o.webDir ?? null;
  if (webDir) {
    let html: string | null = null;
    try {
      if (statSync(webDir).isDirectory() && statSync(join(webDir, 'index.html')).isFile()) html = readFileSync(join(webDir, 'index.html'), 'utf8');
    } catch {
      html = null;
    }
    if (html === null) throw new ServerStartError(`--web-dir 폴더에 index.html이 없습니다: ${webDir} (npm run build:web으로 만든 폴더를 넘기세요)`);
    // 서버용 빌드 표시가 없으면 가짜 API로 도는 개발용 화면일 수 있다 — 실제 서버 주소에서 가짜 자료를 보여 주지 않게 시작하지 않는다 (리드 결정 S8-5)
    if (!hasWebBuildMarker(html)) throw new ServerStartError(webDirNotRemoteMessage(webDir));
  }

  const operatorConfig =
    o.operatorConfig ?? createOperatorConfig({ path: serverConfigPath(o.dataDir), ownerEmailFlag: null, operator: backend.operator, logger, now });
  let port = 0;
  const surface: HttpSurface = createHttpSurface({
    backend,
    sessions: backend.sessions,
    // 접속 허용은 요청마다 읽는다 — 운영자가 server.json을 고치고 config reload하면 다음 요청부터 따른다 (S3-7)
    access: () => ({
      publicOrigin: fixedOrigin !== undefined ? fixedOrigin : operatorConfig.publicOrigin(),
      tailscaleLogins: o.tailscaleLogins !== undefined ? o.tailscaleLogins : operatorConfig.tailscaleLogins(),
    }),
    ...(backend.files ? { files: backend.files } : {}),
    ...(o.rateLimits ? { rateLimits: o.rateLimits } : {}),
    ...(o.timeouts ? { timeouts: o.timeouts } : {}),
    logger,
    runId,
    port: () => port,
    webDir,
    now,
    heartbeatMs: o.sse?.heartbeatMs,
    sseQueueLimit: o.sse?.queueLimit,
    accessLogWindowMs: o.accessLogWindowMs,
    ...(o.staticCache ? { staticCache: o.staticCache } : {}),
  });
  // Node의 requestTimeout은 끄고 머리 시간만 건다 — 본문 시간은 HTTP 표면이 길마다 본다. 읽지 못한 요청은 408·400과 JSON 본문 (S3-32)
  const makeHttp = (): Server => createSurfaceServer(surface, o.timeouts);

  let admin: AdminChannel | null = null;
  const tokenFile = adminTokenPath(o.dataDir);
  const removeToken = (): void => {
    try {
      unlinkSync(tokenFile);
    } catch {
      // 이미 없다
    }
  };
  // --bind는 '루프백'이라는 뜻만 남았다 — 127.0.0.1·::1·localhost 어느 것이든 두 루프백을 같은 포트로 잡는다 (S2-14)
  let listening: LoopbackListen;
  try {
    listening = await listenLoopback({ make: makeHttp, port: requestedPort, logger });
  } catch (error) {
    surface.dispose();
    throw error;
  }
  const httpServers = listening.servers;
  port = listening.port;
  for (const s of httpServers) s.on('error', (error) => logger.error('HTTP 서버 오류', error));
  // 주소는 고른 이름 그대로 (::1을 골랐는데 이 PC에 IPv6 루프백이 없으면 127.0.0.1)
  const url = urlFor(bind === LOOPBACK_V6 && !listening.v6 ? LOOPBACK_V4 : bind, port);
  const addresses = listening.v6 ? [LOOPBACK_V4, LOOPBACK_V6] : [LOOPBACK_V4];
  const closeHttp = (): Promise<void> => {
    const closed = Promise.all(httpServers.map(closeQuietly)).then(() => undefined);
    for (const s of httpServers) s.closeAllConnections();
    return closed;
  };

  /**
   * 운영자 설정을 적용한 뒤 (S3-34): 공개 주소를 없애거나 받는 Tailscale 사용자 목록을 켜면 새 요청은 그 자리에서 403이다 — 이미 열린 SSE도 연 때의 Host·
   * Tailscale 사용자로 다시 보고 이제 받지 않는 것은 닫는다(더 보내지 않는다). 설정이 바꾼 스냅숏을 보내기(버스의 늦춘 changed) 전에 닫힌다
   */
  const afterConfig = <T>(result: T): T => {
    const closed = surface.recheckAccess();
    if (closed) logger.info(`접속 허용이 바뀌어 열린 SSE 연결 ${closed}개를 닫았습니다`);
    return result;
  };
  // 종료가 시작되면 상태 보기 밖의 관리 명령은 받지 않는다 — 두 번째 shutdown·stop이 닫히는 백엔드를 건드리지 않게
  let shuttingDown = false;
  const refuseWhileShuttingDown = (): void => {
    if (shuttingDown) throw new BackendError('shutting_down', '서버를 끝내는 중입니다');
  };
  const handlers: AdminHandlers = {
    status: async (): Promise<AdminStatus> => {
      const power = o.powerStatus?.() ?? null;
      // 배포 점검 (S9-4) — 서버 프로세스가 줄 때만 칸이 있다(아직 끝나지 않았으면 null)
      const deploy = o.deployStatus ? { deploy: o.deployStatus() } : {};
      return {
        pid: process.pid,
        uptimeSec: Math.max(0, Math.round((now() - startedAt) / 1000)),
        bind,
        port,
        url,
        addresses,
        dataDir: o.dataDir,
        runId,
        activeWork: backend.hasActiveWork(),
        version: o.version,
        testSessions: { allowed: o.allowTestSession, active: backend.sessions.list().length },
        ...(admin ? { adminPipe: admin.info() } : {}),
        ...(power ? { power } : {}),
        ...deploy,
        ...backend.operator.status(),
      };
    },
    stop: async () => {
      refuseWhileShuttingDown();
      return backend.operator.emergencyStop();
    },
    shutdown: async () => {
      refuseWhileShuttingDown();
      shuttingDown = true;
      backend.operator.note('운영자가 관리 채널로 서버 종료를 요청함');
      return { shuttingDown: true };
    },
    'session.test': async (): Promise<TestSessionGrant> => {
      refuseWhileShuttingDown();
      if (!o.allowTestSession) {
        throw new BackendError('forbidden', '이 서버는 --allow-test-session 없이 시작해서 운영자 시험 세션을 발급하지 않습니다');
      }
      // 등록된 대표의 실제 기기 세션 '운영자 시험 세션' (S3-4) — 대표가 없으면 시험용 대표를 만든다. 활동 기록은 행위자 operator
      return backend.operator.openTestSession();
    },
    // 운영자 설정 (S3-8) — 보기는 종료 중에도, 바꾸는 명령은 종료가 시작되면 받지 않는다. 적용한 뒤에는 열린 SSE도 지금 접속 허용으로 다시 본다 (S3-34)
    'config.show': async () => operatorConfig.show(),
    'config.reload': async () => {
      refuseWhileShuttingDown();
      return afterConfig(operatorConfig.reload());
    },
    'config.owner-email': async ({ args }) => {
      refuseWhileShuttingDown();
      return afterConfig(operatorConfig.setOwnerEmail(oneArg(args, '대표 이메일')));
    },
    'config.google-client-id': async ({ args }) => {
      refuseWhileShuttingDown();
      return afterConfig(operatorConfig.setGoogleClientId(oneArg(args, '구글 클라이언트 ID')));
    },
    // 서버의 구글 로그인 보안 비밀 (S3-8)과 AI의 API 키 (리드 결정 S9-6) — 값은 운영자 명령이 표준 입력으로만 받아, 서버를 확인한 뒤에 보낸다(S3-16).
    // 답에 값을 넣지 않는다. API 키는 저장소 → 메모리 사본 → 가리개 → (API 키 방식이면) CLI 다시 확인 — 답은 등록 여부·인증 방식·다시 확인의 결과
    'secret.set': async ({ args, secret }) => {
      refuseWhileShuttingDown();
      const name = secretName(args);
      if (!secret?.trim()) throw new BackendError('invalid', '표준 입력으로 받은 보안 비밀이 비었습니다');
      const kind = apiKeyKindOf(name);
      if (kind) return { name, stored: true, apiKey: await backend.operator.setApiKey(kind, secret) };
      await backend.operator.setGoogleClientSecret(secret);
      return { name, stored: true };
    },
    'secret.clear': async ({ args }) => {
      refuseWhileShuttingDown();
      const name = secretName(args);
      const kind = apiKeyKindOf(name);
      if (kind) return { name, cleared: true, apiKey: await backend.operator.setApiKey(kind, null) };
      await backend.operator.setGoogleClientSecret(null);
      return { name, cleared: true };
    },
    // 메인 자리 (S4-8) — 보기는 종료 중에도 받는다. 운영자 배정은 바꾼 쪽 operator로 SeatService.assign을 거치고, 종료가 시작되면 받지 않는다.
    // 대표의 길(HTTP·화면)에는 자리를 바꾸는 것이 없다 — 서로 증명한(S3-16) 이 채널이 운영자의 유일한 길이다
    'seat.status': async () => backend.operator.seatStatus(),
    'seat.assign': async ({ args }) => {
      refuseWhileShuttingDown();
      const { holder, force } = seatAssignArgs(args);
      return backend.operator.assignSeat(holder, force);
    },
    // 외부 에이전트 (리드 결정 S7-2) — 등록·폐기는 종료가 시작되면 받지 않고, 목록은 받는다. 등록의 답에만 키가 실린다 — 이 채널은 답을 기록하지 않는다
    'agent.add': async ({ args }) => {
      refuseWhileShuttingDown();
      return backend.operator.addExternalAgent(oneArg(args, '외부 에이전트 이름(--label)'));
    },
    'agent.revoke': async ({ args }) => {
      refuseWhileShuttingDown();
      return backend.operator.revokeExternalAgent(oneArg(args, '외부 에이전트 ID'));
    },
    'agent.list': async () => backend.operator.listExternalAgents(),
  };

  let token = '';
  const adminAt = o.adminEndpoint ?? newAdminEndpoint(o.dataDir);
  const removeAgentEndpoint = (): void => {
    try {
      unlinkSync(agentEndpointPath(o.dataDir));
    } catch {
      // 없다
    }
  };
  try {
    // 남은 자리 파일은 죽은 서버의 것이다(실행 잠금을 잡았다) — 새 토큰을 쓰기 전에 지운다. 그래야 운영자 명령이 새 토큰을 옛 자리(그사이 남이 차지했을
    // 수 있는 이름)로 보내지 않는다. 새 자리는 관리 채널이 연 뒤에 적는다 (S2-20)
    try {
      unlinkSync(adminEndpointPath(o.dataDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // 에이전트 API 주소 파일도 죽은 서버의 것이면 지운다 — 새 주소는 붙인 뒤에 적는다 (admin.endpoint와 같다, S7-2)
    removeAgentEndpoint();
    token = writeAdminToken(o.dataDir, logger);
    // 백엔드 가리개도 관리 토큰을 안다 — host_exec나 메인 CLI의 셸이 admin.token을 찍어도 도구 결과·실행 기록·CLI 기록·중복 캐시에 원문이 남지 않게. 서버 기록은
    // redactAdminToken이 따로 가린다 (리드 결정 S5-30, 설정 코드는 serverLogin.issueSetupCode가 넣는다)
    backend.operator.registerSecret(token, 'admin-token');
    admin = await startAdminChannel({
      dataDir: o.dataDir,
      token,
      handlers,
      logger,
      endpoint: adminAt,
      afterReply: (command) => {
        if (command === 'shutdown') setImmediate(() => o.onShutdownRequest?.());
      },
      // 서버 도우미 (S9-7) — 쓸 수 없으면 Node 파이프로 물러나고 운영자 활동 기록 한 줄
      ...(o.adminTransport ? { transport: o.adminTransport } : {}),
      notify: (text) => backend.operator.note(text),
    });
  } catch (error) {
    surface.dispose();
    void closeHttp();
    removeToken();
    const code = (error as NodeJS.ErrnoException).code;
    // 관리 채널 자리를 남이 먼저 열었으면 그렇다고 말한다 — 'EADDRINUSE'만으로는 운영자가 까닭을 모른다 (S2-20)
    throw new ServerStartError(code === 'EADDRINUSE' ? adminEndpointInUseMessage(adminAt) : `관리 채널을 열지 못했습니다: ${code ?? (error as Error).message}`, { cause: error });
  }
  const adminChannel = admin;

  // 외부 에이전트 API (리드 결정 S7-2·S7-3): 앱 도구 서버의 루프백 리스너(127.0.0.1, 시작마다 새 포트)에 붙인다 — 대표용 포트에는 붙이지 않는다(tailscale serve가 그쪽으로
  // 넘겨 주므로). 붙인 뒤 주소를 그 사용자만 읽는 agent-endpoint.json에 적는다 (키는 적지 않는다)
  let agentApi: AgentApi | null = null;
  if (backend.agents) {
    const agents = backend.agents;
    // 이 실행의 확인값 (리드 결정 S7-19 C3) — agent-endpoint.json(그 사용자만 읽음)에만 적는다. 에이전트는 키를 보내기 전에 hello로 듣는 쪽이 이 서버인지 본다.
    // 기록하지 않고 어떤 길도 돌려주지 않는다. 메인 CLI가 그 파일을 찍어도 도구 결과·기록에 원문이 남지 않게 백엔드 가리개에 넣는다(관리 토큰과 같다)
    const proof = randomBytes(AGENT_PROOF_BYTES).toString('base64url');
    backend.operator.registerSecret(proof, 'agent-proof');
    agentApi = createAgentApi({ agents, logger, proof });
    agents.mount(agentApi.handle);
    const base = agents.baseUrl();
    if (base) {
      const endpoint: AgentEndpointFile = {
        version: AGENT_ENDPOINT_VERSION,
        agentApi: `${base}${AGENT_API_PREFIX}`,
        mcp: agents.mcpUrl() ?? `${base}/mcp`,
        runId,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
        proof,
      };
      try {
        writePrivateFile(agentEndpointPath(o.dataDir), `${JSON.stringify(endpoint, null, 2)}\n`, '에이전트 API 주소 파일(agent-endpoint.json)', logger);
      } catch (error) {
        logger.warn('에이전트 API 주소 파일(agent-endpoint.json)을 쓰지 못했습니다 — 에이전트는 WOOK_AGENT_URL로 주소를 받아야 합니다', error);
      }
      logger.info(`에이전트 API ${endpoint.agentApi} (앱 도구 서버와 같은 루프백 리스너 — 주소 파일 ${agentEndpointPath(o.dataDir)})`);
    }
  }

  // 올린 파일 정리 (S3-10): 시작 때 한 번, 그 뒤 1시간마다 24시간 지난 것을 지운다
  const sweepUploads = (): void => {
    try {
      const n = backend.files?.sweep() ?? 0;
      if (n) logger.info(`올린 파일 ${n}개를 지웠습니다 (24시간 지남)`);
    } catch (error) {
      logger.warn('올린 파일을 정리하지 못했습니다', error);
    }
  };
  sweepUploads();
  const uploadSweep = setInterval(sweepUploads, UPLOAD_SWEEP_MS);
  uploadSweep.unref();

  let closing: Promise<void> | null = null;
  const closeAll = (): Promise<void> => {
    closing ??= (() => {
      clearInterval(uploadSweep);
      shuttingDown = true;
      // 에이전트 API를 떼고 주소 파일을 지운다 — 닫히는 서버의 주소가 남지 않게 (S7-2)
      if (agentApi) {
        backend.agents?.mount(null);
        agentApi.flush();
      }
      removeAgentEndpoint();
      surface.beginShutdown();
      surface.closeStreams();
      surface.dispose();
      const httpClosed = closeHttp();
      const adminClosed = adminChannel.close();
      removeToken();
      return Promise.all([httpClosed, adminClosed]).then(() => undefined);
    })();
    return closing;
  };

  const startOrigin = fixedOrigin !== undefined ? fixedOrigin : operatorConfig.publicOrigin();
  const pipeInfo = adminChannel.info();
  const pipeMode = pipeInfo.mode === 'helper' ? '서버 도우미' : pipeInfo.mode === 'node' ? 'Node 파이프' : '소켓 파일';
  logger.info(
    `HTTP ${url} (듣는 곳 ${addresses.map((a) => urlFor(a, port)).join(', ')}), 관리 채널 ${adminChannel.endpoint} (${pipeMode}), 실행 ID ${runId}, 운영자 시험 세션 발급 ${o.allowTestSession ? '켬' : '끔'}${webDir ? `, 웹 화면 ${webDir}` : ''}${startOrigin ? `, 공개 주소 ${startOrigin}` : ''}`,
  );
  return {
    url,
    bind,
    port,
    addresses,
    runId,
    // 서버 도우미를 다시 띄우거나 물러나면 바뀐다 (S9-7)
    get adminEndpoint() {
      return adminChannel.endpoint;
    },
    adminAddress: () => adminChannel.address(),
    status: () => handlers.status({ args: [], secret: null }) as Promise<AdminStatus>,
    beginShutdown: () => {
      shuttingDown = true;
      surface.beginShutdown();
    },
    closeNow: () => {
      void closeAll();
    },
    close: closeAll,
    redactAdminToken: (text) => (token ? text.split(token).join('[가림:관리토큰]') : text),
  };
}
