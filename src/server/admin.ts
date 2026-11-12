/**
 * 관리 채널 (SERVER_DESIGN 3.2, S2-4): 운영자 명령 `wook-server <명령>`이 실행 중인 서버에 붙는 길. TCP 포트가 아니라 `tailscale serve`로는 올라가지 않는다.
 * - 자리: Windows는 이름 있는 파이프 `\\.\pipe\wook-admin-<사용자>-<시작마다 새 난수>-<sha256(데이터 폴더의 실제 경로) 앞 8자>`, Linux·macOS는
 *   `<데이터 폴더>/admin.sock`(0600). 누구나 계산할 수 있는 이름이면 다른 계정이 먼저 만들어 서버를 막거나 운영자 명령의 토큰을 받으므로 Windows는
 *   난수를 넣는다. 서버는 연 자리를 그 사용자만 읽는 `<데이터 폴더>/admin.endpoint`에 적고, 운영자 명령은 자리를 계산하지 않고 이 파일에서 읽는다 —
 *   같은 폴더의 다른 이름(접합·subst 드라이브·8.3 이름)으로 적어도 같은 파일에 닿는다 (S2-20)
 * - 다른 기기(SMB)와 전송 (리드 결정 S9-7, adminPipe.ts): 이름 있는 파이프는 SMB(`\\<PC>\pipe\…`)로도 열리고, Node(libuv)가 만든 파이프는 원격
 *   클라이언트를 거부하지 못하며 기본 권한이 Everyone·Anonymous에게 읽기 연결을 허용한다. 그래서 서버 프로세스(serve.ts)는 Windows에서 파이프를 서버
 *   도우미(`WookServerHelper.exe pipe`)가 만들게 한다 — PIPE_REJECT_REMOTE_CLIENTS와 지금 사용자만의 DACL. 도우미를 쓸 수 없으면(csc 없음 등)
 *   Node 파이프로 물러나고 경고한다(그때는 Tailscale 쪽 TCP 445를 막는 설치 안내가 남은 방어다). 프로세스 안 시험 서버는 Node 파이프 그대로다.
 *   어느 전송이든 처리기와 약속은 같고, 토큰과 비밀 값은 아래의 서로 증명이 지킨다
 * - 인증: Node 파이프는 DACL을 정하지 못한다. 그래서 모든 연결은 `<데이터 폴더>/admin.token`의 관리 토큰으로 서로 증명한다 (리드 결정
 *   S3-16 — 토큰 원문은 보내지 않는다). 서버가 시작마다 새 토큰을 쓴다(POSIX 0600, Windows는 상속을 끊고 지금 사용자만).
 *   1) 운영자 명령이 난수를 보낸다(`{"hello", "nonce"}`) → 2) 서버가 제 난수와 두 난수 위의 HMAC-SHA256(관리 토큰)을 보낸다 → 3) 운영자 명령은 그 증명을
 *   확인한 뒤에야 제 증명과 명령(과 표준 입력으로 받은 비밀 값)을 보낸다. 서버를 흉내 낸 쪽(비정상 종료한 서버의 파이프 이름을 차지한 쪽)은 난수 말고는
 *   아무것도 받지 못하고 답을 꾸미지 못한다. 쪽 이름이 증명에 들어가 한쪽의 증명을 다른 쪽 것으로 되돌려 쓰지 못한다.
 *   증명이 틀리면 아무것도 하지 않고 연결을 끊고, 토큰 값 없이 기록한다. 인증 없는 연결·시간 초과 경고는 1분에 한 줄로 모은다 — 파이프를 여는 쪽이
 *   기록을 채우지 못하게 (S2-16). 운영자 명령(operatorRequest)은 붙기 전에 server.lock이 살아 있는 서버 프로세스를 가리키는지도 본다
 * - 약속: 한 줄에 JSON 하나씩. 크기 상한이 있고, 연결마다 받은 때부터 명령 줄을 다 받을 때까지 한 번의 시간 상한이 있다
 *   (조금씩 보내도 늘어나지 않는다, S2-16)
 * - 명령: status, stop(긴급 정지), shutdown(정상 종료 — 신호를 보낼 수 없는 Windows 백그라운드 실행용), session.test(운영자 시험 세션),
 *   config.show·config.reload·config.owner-email·config.google-client-id(운영자 설정, S3-8), secret.set·secret.clear(서버 구글 보안 비밀 — 값은
 *   운영자 명령이 표준 입력으로만 받는다), seat.status·seat.assign(메인 자리 보기와 운영자 배정, S4-8 — 자리를 바꾸는 운영자의 길은 이것 하나다),
 *   agent.add·agent.revoke·agent.list(외부 에이전트 등록·폐기·목록, S7-2 — 키는 agent.add의 답으로 한 번만 나간다)
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { isBackendError } from '../main/backend/invokeCore';
import { holderAlive, lockFilePath, toRecord, type LockLiveness } from '../main/backend/instanceLock';
import type { Logger } from '../main/shell/logger';
import { openAdminPipe, type AdminPipeInfo, type AdminTransport } from './adminPipe';
import { restrictToCurrentUser } from './dataDir';
import { collapsedLog } from './logCollapse';

export const ADMIN_TOKEN_FILE = 'admin.token';
export const ADMIN_SOCKET_FILE = 'admin.sock';
/** 서버가 연 관리 채널 자리를 적는 파일 — 운영자 명령이 읽는다 (S2-20) */
export const ADMIN_ENDPOINT_FILE = 'admin.endpoint';
/** 요청 한 줄의 상한 */
export const ADMIN_MAX_LINE_BYTES = 64 * 1024;
/** 연결을 받은 때부터 요청 한 줄을 다 받기까지의 상한 — 쉬는 시간 상한이 아니다 (S2-16) */
export const ADMIN_REQUEST_TIMEOUT_MS = 10_000;
/** 인증 없는 연결·시간 초과 경고를 모으는 창 — 창마다 첫 경고 한 줄, 나머지는 창이 끝날 때 수만 한 줄 (S2-16) */
export const ADMIN_WARN_WINDOW_MS = 60_000;

/** 2단계 명령 — 관리 채널을 여는 쪽은 늘 이 처리기를 준다 */
const BASE_COMMANDS = ['status', 'stop', 'shutdown', 'session.test'] as const;
/** 운영자 설정·비밀 값 명령 (S3-8) — 처리기를 주지 않은 관리 채널(시험)에서는 모르는 명령이다 */
const CONFIG_COMMANDS = ['config.show', 'config.reload', 'config.owner-email', 'config.google-client-id', 'secret.set', 'secret.clear'] as const;
/** 메인 자리 (S4-8) — 보기(seat.status)와 운영자 배정(seat.assign <보유자> [--force]). 처리기를 주지 않은 관리 채널(시험)에서는 모르는 명령이다 */
const SEAT_COMMANDS = ['seat.status', 'seat.assign'] as const;
/**
 * 외부 에이전트 (리드 결정 S7-2) — 등록(agent.add <이름> — 답에 키가 한 번만 실린다), 폐기(agent.revoke <ID>), 목록(agent.list). 처리기를 주지 않은 관리
 * 채널(시험)에서는 모르는 명령이다. 이 채널은 명령 이름만 기록한다 — 낱말(이름)·답(키)은 서버 기록에 남지 않는다
 */
const AGENT_COMMANDS = ['agent.add', 'agent.revoke', 'agent.list'] as const;
export const ADMIN_COMMANDS = [...BASE_COMMANDS, ...CONFIG_COMMANDS, ...SEAT_COMMANDS, ...AGENT_COMMANDS] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

export type AdminReply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
/** 명령 하나의 처리 — args: 명령 뒤의 낱말(이메일·클라이언트 ID·비밀 값 이름), secret: 표준 입력으로 받은 비밀 값(secret.set) */
export interface AdminRequestBody {
  args: readonly string[];
  secret: string | null;
}
export type AdminHandler = (req: AdminRequestBody) => Promise<unknown>;
export type AdminHandlers = Record<(typeof BASE_COMMANDS)[number], AdminHandler> &
  Partial<Record<(typeof CONFIG_COMMANDS)[number] | (typeof SEAT_COMMANDS)[number] | (typeof AGENT_COMMANDS)[number], AdminHandler>>;

const isCommand = (v: unknown): v is AdminCommand => typeof v === 'string' && (ADMIN_COMMANDS as readonly string[]).includes(v);

/** 관리 채널 약속 이름 (S3-16 서로 증명) — 인사 줄에 싣는다 */
export const ADMIN_PROTOCOL = 'wook-admin/1';
/** 명령 뒤 낱말의 상한 */
const MAX_ARGS = 8;
const MAX_ARG_LENGTH = 1024;
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
export const ADMIN_UNAUTHORIZED = { code: 'unauthorized', message: '관리 채널 인증에 실패했습니다 — 이 서버가 이번에 시작하며 데이터 폴더에 쓴 admin.token으로 서로 증명해야 합니다' };

/**
 * 관리 채널 증명 (S3-16): HMAC-SHA256(관리 토큰, 약속 이름 + 쪽 + 두 난수). 서버 쪽과 운영자 명령 쪽의 이름이 달라 한쪽의 증명을 다른 쪽 것으로
 * 되돌려 쓰지 못하고, 서버 난수가 연결마다 새로워 지난 연결의 증명을 다시 쓰지 못한다
 */
export function adminProof(token: string, side: 'server' | 'client', clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', token).update(`${ADMIN_PROTOCOL} ${side}\n${clientNonce}\n${serverNonce}`, 'utf8').digest('base64url');
}

function sameProof(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 파이프 이름에 넣는 사용자 이름 — 파이프 이름에 쓸 수 있는 글자만 */
function pipeUser(user: string): string {
  return user.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'user';
}

/** 데이터 폴더의 실제 경로 (접합·심볼릭 링크·subst 드라이브·8.3 이름을 푼 것). 풀 수 없으면(아직 없음 등) resolve한 경로 */
function realDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * 데이터 폴더의 해시 8자: 실제 경로를 소문자로 바꿔 sha256(Windows는 경로 대소문자를 가리지 않는다). 파이프 이름과 작업 스케줄러 작업 이름
 * (`WookServer-<8자>`, task.ts — 데이터 폴더마다 작업 하나, 리드 결정 S9-3)이 같은 값을 쓴다
 */
export function dataDirHash(dataDir: string): string {
  return createHash('sha256').update(realDir(resolve(dataDir)).toLowerCase(), 'utf8').digest('hex').slice(0, 8);
}

/** Windows 파이프 이름 — 데이터 폴더의 해시(dataDirHash). nonce가 있으면 해시 앞에 넣는다 */
function pipeName(dir: string, user: string, nonce: string | null): string {
  return `\\\\.\\pipe\\wook-admin-${pipeUser(user)}-${nonce ? `${nonce}-` : ''}${dataDirHash(dir)}`;
}

/**
 * 관리 채널 자리의 고정 부분: Windows는 난수를 뺀 파이프 이름(사용자 + 데이터 폴더의 실제 경로 해시 — 같은 폴더의 다른 이름도 같은 값, S2-16),
 * POSIX는 `<데이터 폴더>/admin.sock`. 누구나 계산할 수 있는 이름이라 Windows 서버는 이 이름으로 열지 않고 난수를 넣는다(newAdminEndpoint, S2-20)
 */
export function adminEndpoint(dataDir: string, platform: NodeJS.Platform = process.platform, user: string = userInfo().username): string {
  const dir = resolve(dataDir);
  if (platform !== 'win32') return join(dir, ADMIN_SOCKET_FILE);
  return pipeName(dir, user, null);
}

/**
 * 이번 시작의 관리 채널 자리 (S2-20). Windows는 시작마다 16바이트 난수를 넣는다 — 이름 있는 파이프는 아무 계정이나 새 이름으로 만들 수 있어,
 * 미리 알 수 있는 이름이면 다른 계정이 먼저 만들어 서버를 막거나(첫 인스턴스만 만들 수 있다) 운영자 명령의 토큰을 받는다.
 * POSIX는 그 사용자만 여는 데이터 폴더 안의 admin.sock 그대로다
 */
export function newAdminEndpoint(dataDir: string, platform: NodeJS.Platform = process.platform, user: string = userInfo().username): string {
  if (platform !== 'win32') return adminEndpoint(dataDir, platform, user);
  return pipeName(resolve(dataDir), user, randomBytes(16).toString('hex'));
}

/** 관리 채널 자리를 이미 남이 쓸 때 시작하지 않는 글 (S2-20) */
export function adminEndpointInUseMessage(endpoint: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `관리 채널 파이프 이름(${endpoint})을 이미 다른 프로그램이 쓰고 있습니다 — 다시 시작하면 새 이름을 고릅니다`
    : `관리 채널 소켓(${endpoint})을 이미 다른 프로그램이 쓰고 있습니다`;
}

export function adminTokenPath(dataDir: string): string {
  return join(dataDir, ADMIN_TOKEN_FILE);
}

export function adminEndpointPath(dataDir: string): string {
  return join(dataDir, ADMIN_ENDPOINT_FILE);
}

/**
 * 그 사용자만 읽는 파일을 쓴다(관리 토큰·관리 채널 자리). 임시 파일을 만들어 권한부터 좁힌 뒤 내용을 쓰고 제자리로 옮긴다 — 넓은 권한으로 내용이
 * 놓이는 순간이 없게. Windows의 권한 좁히기(icacls)에 실패하면 기록만 하고 계속한다 — 데이터 폴더 자체가 그 사용자 것이라는 바탕 위의 한 겹이다
 */
export function writePrivateFile(target: string, content: string, label: string, logger: Logger, platform: NodeJS.Platform = process.platform): void {
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    if (platform === 'win32') {
      closeSync(openSync(tmp, 'wx'));
      try {
        restrictToCurrentUser(tmp, 'file');
      } catch (error) {
        logger.warn(`${label}의 권한을 지금 사용자만으로 좁히지 못했습니다 (데이터 폴더의 권한을 따릅니다)`, error);
      }
      writeFileSync(tmp, content, { encoding: 'utf8' });
    } else {
      writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
    }
    renameSync(tmp, target);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 임시 파일 정리 실패는 시작 실패 안내에 묻힌다
    }
    throw error;
  }
}

/** 새 관리 토큰을 그 사용자만 읽는 파일에 쓰고 돌려준다 — 시작마다 새로 (S2-4) */
export function writeAdminToken(dataDir: string, logger: Logger, platform: NodeJS.Platform = process.platform): string {
  const token = randomBytes(32).toString('base64url');
  writePrivateFile(adminTokenPath(dataDir), token, '관리 토큰 파일', logger, platform);
  return token;
}

/**
 * 서버가 적은 관리 채널 자리 (운영자 명령, S2-20). 자리는 계산하지 않는다 — Windows 파이프 이름에는 시작마다 난수가 들어간다.
 * 파일이 없으면 실행 중인 서버가 없다. 모양이 틀리면(파이프·절대 경로가 아님) 쓰지 않는다
 */
export function readAdminEndpoint(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  let text: string;
  try {
    text = readFileSync(adminEndpointPath(dataDir), 'utf8').trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AdminClientError('not_running', `이 데이터 폴더(${dataDir})로 실행 중인 욱채 서버가 없습니다 (admin.endpoint 없음)`);
    throw new AdminClientError('no_access', `관리 채널 자리 파일(admin.endpoint)을 읽지 못했습니다: ${code ?? String(error)}`);
  }
  const ok = text.length <= 1024 && (platform === 'win32' ? /^\\\\\.\\pipe\\wook-admin-[A-Za-z0-9._-]+$/.test(text) : isAbsolute(text) && !/[\0\r\n]/.test(text));
  if (!ok) throw new AdminClientError('no_access', '관리 채널 자리 파일(admin.endpoint)의 내용을 알 수 없습니다 — 서버를 다시 시작해 주세요');
  return text;
}

export interface AdminChannel {
  /** 지금 듣는 자리 — 서버 도우미를 다시 띄우거나 Node 파이프로 물러나면 바뀐다 (S9-7) */
  readonly endpoint: string;
  /** 듣는 자리 (파이프·소켓 경로 — 시험이 TCP가 아님을 확인한다) */
  address(): string | AddressInfo | null;
  /** 전송 — 관리 status의 adminPipe (S9-2) */
  info(): AdminPipeInfo;
  /** 지금 열린 연결 수 (진단·시험 — 서버 도우미의 연결 상한 16을 본다) */
  connections(): number;
  /** 새 연결을 받지 않고 닫는다. 소켓 파일과 자리 파일(admin.endpoint)은 지운다. 서버 도우미는 끝난 것을 확인한 뒤에 돌아온다 */
  close(): Promise<void>;
}

export interface AdminChannelOptions {
  dataDir: string;
  token: string;
  handlers: AdminHandlers;
  logger: Logger;
  /** 응답을 보낸 뒤 (shutdown이 응답을 먼저 보내고 종료를 시작하게) */
  afterReply?: (command: AdminCommand) => void;
  requestTimeoutMs?: number;
  /** 시험: 경고를 모으는 창 (기본 ADMIN_WARN_WINDOW_MS) */
  warnWindowMs?: number;
  /** 열 자리 (기본 newAdminEndpoint — Windows는 시작마다 새 난수 이름, S2-20) */
  endpoint?: string;
  platform?: NodeJS.Platform;
  /** 전송 (리드 결정 S9-7, adminPipe.ts) — 기본 'node'(Node 파이프·소켓). 서버 프로세스는 Windows에서 서버 도우미를 넘긴다 */
  transport?: AdminTransport;
  /** 운영자 활동 기록 한 줄 (서버 도우미에서 Node 파이프로 물러날 때) */
  notify?: (text: string) => void;
}

/**
 * 모아 쓰는 경고 종류 — 인증 없는 연결(토큰 없음·틀림·깨진 줄, 너무 큰 줄)과 시간 초과. 종류마다 창의 첫 경고는 바로 쓰고, 그 창에 더 온 것은
 * 창이 끝날 때 수만 한 줄로 쓴다(logCollapse.ts, S2-16)
 */
type NoisyKind = 'unauthorized' | 'too_large' | 'timeout';
const NOISY_SUMMARY: Record<NoisyKind, string> = {
  unauthorized: '관리 토큰이 없거나 맞지 않아 끊은 연결',
  too_large: '요청이 너무 커서 끊은 연결',
  timeout: '요청이 시간 안에 오지 않아 끊은 연결',
};

export async function startAdminChannel(o: AdminChannelOptions): Promise<AdminChannel> {
  const platform = o.platform ?? process.platform;
  const endpoint = o.endpoint ?? newAdminEndpoint(o.dataDir, platform);
  const endpointFile = adminEndpointPath(o.dataDir);
  const { logger } = o;
  const timeoutMs = o.requestTimeoutMs ?? ADMIN_REQUEST_TIMEOUT_MS;
  const noisy = collapsedLog<NoisyKind>({
    write: (text) => logger.warn(text),
    windowMs: o.warnWindowMs ?? ADMIN_WARN_WINDOW_MS,
    summary: (kind, extra, span) => `관리 채널: ${NOISY_SUMMARY[kind]}이 지난 ${span} 동안 ${extra}번 더 있었습니다`,
  });

  const reply = (socket: Duplex, body: AdminReply): void => {
    if (!socket.destroyed) socket.end(`${JSON.stringify(body)}\n`);
  };

  /** 증명하지 못한 연결 — 아무것도 하지 않고 끊는다. 토큰·증명 값은 기록하지 않는다 */
  const refuse = (socket: Duplex, command: AdminCommand | null): void => {
    noisy.log('unauthorized', `관리 채널: 관리 토큰이 없거나 맞지 않아 연결을 끊었습니다${command ? ` (명령 ${command})` : ''}`);
    reply(socket, { ok: false, error: ADMIN_UNAUTHORIZED });
  };

  /** 둘째 줄: 운영자 명령의 증명과 명령 — 증명부터 본다. 틀리면 무엇도 하지 않는다 */
  const handle = async (socket: Duplex, line: string, clientNonce: string, serverNonce: string): Promise<void> => {
    const req = parseObject(line);
    const command = req && isCommand(req['command']) ? req['command'] : null;
    if (!req || !sameProof(req['proof'], adminProof(o.token, 'client', clientNonce, serverNonce))) return refuse(socket, command);
    const handler = command ? o.handlers[command] : undefined;
    if (!command || !handler) {
      logger.warn('관리 채널: 알 수 없는 명령을 거부했습니다');
      reply(socket, { ok: false, error: { code: 'unknown_command', message: `알 수 없는 명령입니다 (가능한 명령: ${ADMIN_COMMANDS.join(', ')})` } });
      return;
    }
    const rawArgs = req['args'] ?? [];
    const rawSecret = req['secret'] ?? null;
    if (
      !Array.isArray(rawArgs) ||
      rawArgs.length > MAX_ARGS ||
      rawArgs.some((a) => typeof a !== 'string' || a.length > MAX_ARG_LENGTH) ||
      (rawSecret !== null && typeof rawSecret !== 'string')
    ) {
      logger.warn(`관리 채널: ${command}의 인자 모양이 틀려 거부했습니다`);
      reply(socket, { ok: false, error: { code: 'invalid_args', message: '명령 뒤의 낱말 모양이 올바르지 않습니다' } });
      return;
    }
    let body: AdminReply;
    try {
      body = { ok: true, result: await handler({ args: rawArgs as string[], secret: rawSecret as string | null }) };
      logger.info(`관리 채널: ${command} 처리`);
    } catch (error) {
      if (isBackendError(error)) {
        logger.warn(`관리 채널: ${command} 거부 [${error.code}] ${error.message}`);
        body = { ok: false, error: { code: error.code, message: error.message } };
      } else {
        logger.error(`관리 채널: ${command} 처리 중 예기치 않은 오류`, error);
        body = { ok: false, error: { code: 'internal', message: '명령을 처리하는 중 문제가 생겼습니다. 서버 기록(logs/server.log)을 확인해 주세요.' } };
      }
    }
    reply(socket, body);
    if (body.ok) o.afterReply?.(command);
  };

  /** 지금 열린 연결 수 */
  let live = 0;
  /** 연결 하나 — Node 파이프·소켓이든 서버 도우미가 넘긴 연결이든 같은 처리 (adminPipe.ts, S9-7) */
  const onConnection = (socket: Duplex): void => {
    let buffer = Buffer.alloc(0);
    /** hello: 운영자 명령의 난수를 기다림 → request: 서버 증명을 보냈고 운영자 명령의 증명과 명령을 기다림 → done */
    let stage: 'hello' | 'request' | 'done' = 'hello';
    let clientNonce = '';
    let serverNonce = '';
    // 받은 때부터 명령 줄을 다 받을 때까지 한 번의 상한 — 조금씩 보내도 늘어나지 않는다 (S2-16. 쉬는 시간 상한 setTimeout으로는 부족하다)
    const deadline = setTimeout(() => {
      if (stage === 'done') return;
      stage = 'done';
      noisy.log('timeout', '관리 채널: 요청이 시간 안에 오지 않아 연결을 끊었습니다');
      socket.destroy();
    }, timeoutMs);
    deadline.unref?.();
    live++;
    socket.on('close', () => {
      live--;
      clearTimeout(deadline);
    });
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      if (stage === 'done') return;
      buffer = Buffer.concat([buffer, chunk]);
      while (stage !== 'done') {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0 && buffer.length <= ADMIN_MAX_LINE_BYTES) return;
        if (nl < 0 || nl > ADMIN_MAX_LINE_BYTES) {
          stage = 'done';
          clearTimeout(deadline);
          noisy.log('too_large', '관리 채널: 요청이 너무 커서 연결을 끊었습니다');
          reply(socket, { ok: false, error: { code: 'too_large', message: '요청이 너무 큽니다' } });
          return;
        }
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 1);
        if (stage === 'hello') {
          // 첫 줄: 운영자 명령의 난수 (S3-16). 다른 것(옛 운영자 명령의 {token, command} 등)이면 무엇도 하지 않고 끊는다
          const hello = parseObject(line);
          const nonce = hello?.['hello'] === ADMIN_PROTOCOL ? hello['nonce'] : undefined;
          if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
            stage = 'done';
            clearTimeout(deadline);
            refuse(socket, hello && isCommand(hello['command']) ? hello['command'] : null);
            return;
          }
          clientNonce = nonce;
          serverNonce = randomBytes(32).toString('base64url');
          // 서버가 먼저 증명한다 — 운영자 명령은 이 증명을 확인한 뒤에야 명령과 비밀 값을 보낸다
          if (!socket.destroyed) socket.write(`${JSON.stringify({ nonce: serverNonce, proof: adminProof(o.token, 'server', clientNonce, serverNonce) })}\n`);
          stage = 'request';
          continue;
        }
        stage = 'done';
        clearTimeout(deadline);
        void handle(socket, line, clientNonce, serverNonce);
      }
    });
  };

  // 전송을 연다 (adminPipe.ts) — Node 파이프·소켓, 또는 서버 도우미(물러나면 Node 파이프). 자리 파일은 듣기 시작한 뒤에만 쓴다
  const pipe = await openAdminPipe({
    endpoint,
    platform,
    transport: o.transport ?? 'node',
    onConnection,
    logger,
    newEndpoint: () => newAdminEndpoint(o.dataDir, platform),
    // 운영자 명령이 찾는 자리 — 연 뒤에 그 사용자만 읽는 파일로 알린다. 운영자 명령은 이름을 계산하지 않는다 (S2-20)
    publish: (at) => writePrivateFile(endpointFile, at, '관리 채널 자리 파일', logger, platform),
    withdraw: (at) => {
      try {
        // 아직 그 자리를 가리킬 때만 지운다
        if (readFileSync(endpointFile, 'utf8') === at) unlinkSync(endpointFile);
      } catch {
        // 이미 없다
      }
    },
    ...(o.notify ? { notify: o.notify } : {}),
  });

  let closed: Promise<void> | null = null;
  return {
    get endpoint() {
      return pipe.endpoint;
    },
    address: () => pipe.address(),
    info: () => pipe.info(),
    connections: () => live,
    close() {
      closed ??= (() => {
        noisy.flush();
        return pipe.close();
      })();
      return closed;
    },
  };
}

// ───────────────────────── 운영자 명령 쪽 (wook-server <명령>) ─────────────────────────

export class AdminClientError extends Error {
  constructor(
    /** bad_server: 관리 채널에서 답한 쪽이 관리 토큰을 증명하지 못했다 — 명령·비밀 값을 보내지 않았다 (S3-16) */
    public readonly code: 'not_running' | 'no_access' | 'closed' | 'timeout' | 'bad_reply' | 'bad_server',
    message: string,
  ) {
    super(message);
    this.name = 'AdminClientError';
  }
}

export interface AdminRequestOptions {
  dataDir: string;
  command: AdminCommand;
  /** 명령 뒤의 낱말 (config owner-email <이메일> 등) */
  args?: readonly string[];
  /** 표준 입력으로 받은 비밀 값 (secret set) — 서버를 확인한 뒤에만 보낸다 */
  secret?: string;
  /** 응답을 기다리는 상한 (긴급 정지는 실행을 끝내기까지 걸린다). 기본 120초 */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  /** 시험: 파일 대신 이 토큰으로 증명한다 */
  token?: string;
}

/** 서버가 관리 토큰을 증명하지 못했을 때 (S3-16) */
export const ADMIN_BAD_SERVER =
  '관리 채널에서 답한 쪽이 이 데이터 폴더의 관리 토큰(admin.token)을 증명하지 못했습니다 — 명령과 비밀 값을 보내지 않았습니다. 서버가 다시 시작했다면 명령을 다시 실행하세요';

/**
 * 실행 중인 서버에 명령 하나를 보내고 응답을 받는다 (S3-16 서로 증명 — 토큰 원문은 보내지 않는다). 서버의 증명을 확인하기 전에는 난수 말고 아무것도
 * 보내지 않고, 그 전에 온 어떤 답도 믿지 않는다. 서버가 없거나 연결이 끊기거나 서버가 증명하지 못하면 AdminClientError.
 * 운영자 명령은 server.lock을 먼저 보는 operatorRequest를 쓴다 — 이 함수는 그 확인 없이 붙는다(프로세스 안 시험 서버는 잠금 파일이 없다)
 */
export async function adminRequest(o: AdminRequestOptions): Promise<AdminReply> {
  const dataDir = resolve(o.dataDir);
  let token = o.token;
  if (token === undefined) {
    try {
      token = readFileSync(adminTokenPath(dataDir), 'utf8').trim();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new AdminClientError('not_running', `이 데이터 폴더(${dataDir})로 실행 중인 욱채 서버가 없습니다 (admin.token 없음)`);
      throw new AdminClientError('no_access', `관리 토큰(admin.token)을 읽지 못했습니다: ${code ?? String(error)}`);
    }
  }
  const key = token;
  // 자리는 서버가 적은 파일에서 읽는다 — 계산하지 않는다 (S2-20). 토큰을 먼저 읽었다: 서버는 시작 때 옛 자리 파일을 지운 뒤 새 토큰을 쓰므로
  // 새 토큰이 옛 자리(비정상 종료한 서버의 이름 — 그사이 남이 차지했을 수 있다)와 짝이 되지 않는다
  const endpoint = readAdminEndpoint(dataDir, o.platform ?? process.platform);
  const timeoutMs = o.timeoutMs ?? 120_000;
  return new Promise<AdminReply>((resolveReply, reject) => {
    const socket = createConnection(endpoint);
    const clientNonce = randomBytes(32).toString('base64url');
    /** challenge: 서버의 증명을 기다림 → reply: 명령을 보냈고 답을 기다림 */
    let stage: 'challenge' | 'reply' = 'challenge';
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new AdminClientError('timeout', `서버가 ${Math.round(timeoutMs / 1000)}초 안에 답하지 않았습니다`))), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ hello: ADMIN_PROTOCOL, nonce: clientNonce })}\n`));
    socket.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0 && !settled; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (stage === 'challenge') {
          // 서버의 증명부터 — 맞지 않으면(토큰을 모르는 쪽, 꾸민 답) 명령·비밀 값을 보내지 않고 끝낸다
          const c = parseObject(line);
          const nonce = c?.['nonce'];
          if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || !sameProof(c?.['proof'], adminProof(key, 'server', clientNonce, nonce))) {
            finish(() => reject(new AdminClientError('bad_server', ADMIN_BAD_SERVER)));
            return;
          }
          stage = 'reply';
          const request = {
            proof: adminProof(key, 'client', clientNonce, nonce),
            command: o.command,
            ...(o.args && o.args.length ? { args: [...o.args] } : {}),
            ...(o.secret !== undefined ? { secret: o.secret } : {}),
          };
          socket.write(`${JSON.stringify(request)}\n`);
          continue;
        }
        finish(() => {
          const parsed = parseObject(line) as AdminReply | null;
          if (parsed && typeof parsed.ok === 'boolean') resolveReply(parsed);
          else reject(new AdminClientError('bad_reply', '서버의 응답 형식을 알 수 없습니다'));
        });
      }
      if (!settled && buffer.length > ADMIN_MAX_LINE_BYTES) finish(() => reject(new AdminClientError('bad_reply', '서버의 응답이 너무 깁니다')));
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
      finish(() =>
        reject(
          missing
            ? new AdminClientError('not_running', `이 데이터 폴더(${dataDir})로 실행 중인 욱채 서버가 없습니다`)
            : new AdminClientError('closed', `관리 채널에 연결하지 못했습니다: ${error.code ?? error.message}`),
        ),
      );
    });
    socket.on('close', () => finish(() => reject(new AdminClientError('closed', '서버가 응답 없이 연결을 끊었습니다'))));
  });
}

/**
 * 이 데이터 폴더의 server.lock이 살아 있는 욱채 서버를 가리키는지 (S3-16 — 운영자 명령은 붙기 전에 본다). 실행 잠금과 같은 판정(pid가 살아 있고 생성 시각이
 * 같음)이다. 없거나 끝난 프로세스·데스크톱 앱이면 AdminClientError('not_running') — 비정상 종료한 서버의 파이프 이름을 남이 차지했어도 붙지 않는다
 */
export async function assertServerRunning(dataDir: string, liveness?: LockLiveness): Promise<void> {
  const dir = resolve(dataDir);
  let raw: string;
  try {
    raw = readFileSync(lockFilePath(dir), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AdminClientError('not_running', `이 데이터 폴더(${dir})로 실행 중인 욱채 서버가 없습니다 (server.lock 없음)`);
    throw new AdminClientError('no_access', `실행 잠금(server.lock)을 읽지 못했습니다: ${code ?? String(error)}`);
  }
  const rec = toRecord(parseObject(raw));
  if (!rec) throw new AdminClientError('not_running', '실행 잠금(server.lock)의 내용을 읽지 못했습니다 — 서버가 막 시작하는 중이면 잠시 뒤 다시 실행하세요');
  if (rec.kind === 'desktop') throw new AdminClientError('not_running', `이 데이터 폴더는 데스크톱 앱(pid ${rec.pid})이 쓰고 있습니다 — 운영자 명령은 욱채 서버에만 씁니다`);
  if (!(await holderAlive(rec, liveness))) {
    throw new AdminClientError('not_running', `이 데이터 폴더(${dir})로 실행 중인 욱채 서버가 없습니다 (server.lock의 서버 pid ${rec.pid}는 끝났습니다)`);
  }
}

/** 운영자 명령이 부르는 길 (cli.ts): server.lock을 본 뒤(assertServerRunning) 서로 증명하고 명령을 보낸다 (S3-16) */
export async function operatorRequest(o: AdminRequestOptions & { liveness?: LockLiveness }): Promise<AdminReply> {
  await assertServerRunning(o.dataDir, o.liveness);
  return adminRequest(o);
}
