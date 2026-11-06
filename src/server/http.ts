/**
 * 대표용 HTTP (SERVER_DESIGN 3.4·3.6, S2-3·S2-8). 서버는 루프백에만 열고, 원격 접속은 늘 앞에 둔 `tailscale serve`로 들어온다.
 * - Host 검사: `127.0.0.1:<포트>`, `localhost:<포트>`, `[::1]:<포트>`와 공개 주소(--public-origin·server.json network.publicOrigin, S3-7)의 Host가 아니면
 *   403 — 같은 PC의 웹 페이지가 DNS 재바인딩으로 붙지 못하게 (S2-3). 받는 Tailscale 사용자 목록(owner.tailscaleLogins)이 있으면 그 밖의 요청도 로그인
 *   전에 403 (S3-7 — 추가 방어)
 * - 횟수 제한 (S3-11): 기기 세션마다, 세션 없는 요청은 Tailscale 사용자마다와 모두 합쳐 1분 창의 상한 — 넘으면 429. 세션 없는 SSE 연결도 상한까지
 * - 업로드·내려받기 (S3-10): `POST /api/uploads`(50MB까지, `<dataDir>/uploads/`, 그 기기 세션의 uploadId), `GET /api/attachments/:id`·
 *   `/api/reports/:id/file`·`/api/exports/:name`·`/api/screens/:id`(살아 있는 기기 세션만, 실제 경로가 그 폴더 안일 때만, 늘 내려받기)
 * - 누가 부르는지는 기기 세션으로 정한다 (리드 결정 S3-3·S3-4, sessions.ts): 쿠키 `__Host-wos_session` 또는 `Authorization: Bearer <토큰>`. 주소에 든
 *   토큰과 틀린 Authorization 머리는 401. 아무것도 싣지 않았거나 끝난 쿠키면 세션 없는 호출자다 — 그래도 invoke(로그인 전 메서드만, 백엔드 게이트가 고른다)와
 *   SSE(업무 내용을 뺀 스냅숏과 navigate·emergency·openSettings만)는 열린다. 쿠키를 실은 상태 변경 요청은 `X-Wook-Client: 1`과 허용 Origin이 없으면 403.
 *   같은 이름의 쿠키가 여럿 오면 값을 모두 본다 — 살아 있는 첫 값을 쓰고, 살아 있는 값이 하나도 없을 때만 지운다 (S3-38: 한 tailnet의 형제 기계가 던진 쿠키가
 *   앞에 와도 대표를 로그아웃시키지 못하게)
 *   기기 코드 로그인(S3-5)은 시작 응답에 로그인 전 쿠키 `__Host-wos_login`을 싣고(RemoteCaller.newLoginKey), 대표가 확인된 묻기 응답에 세션 쿠키를 싣는다(grantSession)
 *   — 공개 주소의 Host로 온 요청만이다. 루프백 Host로 온 요청에는 두 쿠키를 싣지 않고 기기 코드 로그인을 받지 않는다(RemoteCaller.loginRefusal, S3-31 —
 *   쿠키는 포트로 나뉘지 않는다). 쿠키 지우기와 Bearer는 어디서나 된다
 * - `POST /api/invoke`: 본문 JSON `{id, method, args}`(1MB까지, Content-Type application/json). 처리는 데스크톱 IPC와 같은 공용 부분(invokeCore.ts)이 하고,
 *   백엔드의 invoke는 그 호출자(RemoteCaller)로 원격 길 게이트를 돈다. 응답 본문은 늘 InvokeResponse이고 상태 코드만 결과에 맞춘다 (httpStatusFor).
 *   요청 ID를 호출자에 실어 넘긴다 — 상태를 바꾸는 요청은 같은 기기 세션의 같은 ID를 한 번만 처리한다(S3-9, 백엔드 게이트).
 *   호출자의 세션이 그 요청으로 끝났으면(그 기기 로그아웃·이 기기 끊기) 세션 쿠키를 지운다
 * - `GET /api/events`(SSE): 연결하자마자 지금 스냅숏, 그 뒤 토픽마다 `event: <토픽>` + `data: {"runId", "payload"}`. 20초마다 살아 있음 신호.
 *   토픽은 서버가 거르지 않고 한 번만 구독하고(onTopicRaw) 연결마다 그 호출자로 거른다(topicFor, S3-3). `cliEvents`는 `?members=`로 고른 팀원 것만.
 *   느린 연결은 스냅숏을 가장 최근 것 하나만 두고, 다른 토픽은 상한까지 쌓다가 넘으면 끊는다 — 연결을 둔 채 알림을 조용히 버리지 않는다.
 *   그 연결을 연 기기 세션이 끊기거나(로그아웃·기기 끊기·대표 바뀜) 끝나거나 서버가 끝나면 닫는다. 만료는 세션과 같은 벽시계로 본다 — 보낼 때와
 *   살아 있음 신호마다 (S2-20)
 * - 정적 화면: `--web-dir`이면 그 폴더를 경로 탈출 없이 준다(없는 경로는 index.html). 서버용 빌드 표시가 없는 폴더는 시작 때 거부한다(server.ts —
 *   가짜 API로 도는 개발용 화면을 실제 서버 주소에서 주지 않게, S8-5). HTML에는 전체 CSP 머리(webScreen.ts), 해시 이름의 `assets/`는 1년 immutable,
 *   그 밖은 no-cache와 강한 ETag(내용 해시 — (크기·바뀐 때)마다 한 번 셈, GET·HEAD의 If-None-Match가 맞으면 304), 글·GLB는 `Accept-Encoding: gzip`이면
 *   파일마다 한 번 줄여 둔 것을 준다.
 *   `--web-dir`이 없으면 `/`에 안내 쪽만
 * 기록에는 메서드 이름·상태 코드·걸린 시간만 남긴다. 요청 본문·인자·요청 ID·토큰·헤더는 남기지 않는다 — 실패도 아는 메서드 이름과 오류 code만이고,
 * 인자를 되풀이하는 오류 메시지와 모르는 메서드 이름은 남기지 않는다 (S2-13). 토큰 없이 누구나 보낼 수 있는 요청(Host 거부, 401, 정적 화면·안내 쪽)의
 * 접근 줄은 종류마다 1분에 한 줄과 수 한 줄로 모은다 — 기록 회전을 밀어내지 못하게. 토큰이 맞는 /api 요청은 요청마다 한 줄이다 (S2-20)
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { IPC_METHODS, IPC_TOPICS, type WookErrorPayload, type WookTopic } from '@shared/ipc';
import type { AppSnapshot } from '@shared/views';
import type { Backend, RemoteCaller, ServerFileAccess } from '../main/backend/types';
import { createInvokeCore, failResponse, INVOKE_ERRORS, type InvokeResponse } from '../main/backend/invokeCore';
import { deviceSessionView, sessionExpiresAt, type DeviceSessionRecord, type DeviceSessionStore } from '../main/auth/deviceSessions';
import { UPLOAD_KEEP_MS, UPLOAD_MAX_BYTES, type DownloadFile, type DownloadKind } from '../main/orchestrator/serverFiles';
import { formatDetail, type Logger } from '../main/shell/logger';
import { createBoundedCache } from './boundedCache';
import { collapsedLog } from './logCollapse';
import { WEB_SCREEN_CSP } from './webScreen';
import {
  allowedOrigins,
  appendSetCookie,
  carriesWookCookie,
  CLEAR_SESSION_COOKIE,
  clientKeyOf,
  cookieHostAllowed,
  fromWookScreen,
  isStateChange,
  issueLoginCookie,
  loginKeysOf,
  loopbackLoginRefusal,
  publicHosts,
  queryCarriesToken,
  readCredential,
  setSessionCookie,
  tailscaleLoginAllowed,
  tailscaleLoginOf,
  tailscaleUserAllowed,
  UPLOAD_NAME_QUERY,
} from './sessions';

export const MAX_INVOKE_BODY_BYTES = 1024 * 1024;
export const SSE_HEARTBEAT_MS = 20_000;
/** 느린 SSE 연결에 쌓아 둘 스냅숏 밖 이벤트 상한 — 넘으면 끊어 화면이 다시 맞추게 한다 */
export const SSE_QUEUE_LIMIT = 1000;
/** 토큰 없이 누구나 보낼 수 있는 요청의 접근 줄을 모으는 창 — 종류마다 창의 첫 줄 하나, 나머지는 창이 끝날 때 수만 한 줄 (S2-20) */
export const HTTP_ACCESS_WINDOW_MS = 60_000;

/**
 * HTTP 시간 상한 (리드 결정 S3-32) — 여기 한 곳에서 정한다. Node의 requestTimeout(기본 300초)은 본문까지 재서 50MB 업로드를 느린 연결에서 끊으므로 끄고(0),
 * 머리를 다 받는 시간만 서버에 건다(headersTimeout). 본문은 길마다 따로 본다: /api/invoke 본문은 통째로 30초 안에, /api/uploads는 60초 동안 데이터가 오지
 * 않으면(쉼) 멈추고 통째로 60분 안에 끝나야 한다(50MB면 약 120kbit/s). 넘으면 408과 InvokeResponse 본문 — 받다 만 업로드 파일은 지운다. 본문을 읽지 않고
 * 답한 길은 응답 뒤 10초 안에 본문이 끝나지 않으면 연결을 끊는다(requestTimeout을 끈 자리를 메운다)
 */
export interface HttpTimeouts {
  /** 요청 머리를 다 받는 시간 (Node headersTimeout) */
  headersMs: number;
  /** /api/invoke 본문을 다 받는 시간 */
  invokeBodyMs: number;
  /** 업로드가 데이터 없이 기다리는 시간 */
  uploadIdleMs: number;
  /** 업로드 하나를 다 받는 시간 */
  uploadTotalMs: number;
  /**
   * 본문을 읽지 않는 길(거부·정적 화면·내려받기 등)이 응답을 다 보낸 뒤에도 본문이 오면 연결을 끊기까지의 시간 — requestTimeout을 껐으므로 끝없이 흘려 보내는
   * 본문이 연결을 붙잡지 못하게 한다
   */
  unreadBodyMs: number;
}

export const DEFAULT_HTTP_TIMEOUTS: HttpTimeouts = { headersMs: 60_000, invokeBodyMs: 30_000, uploadIdleMs: 60_000, uploadTotalMs: 60 * 60_000, unreadBodyMs: 10_000 };

/** 시간 상한을 사람이 읽는 글로 — 10분 넘게 나뉘어 떨어지면 분(60분), 아니면 초(60초·0.5초) */
const spanText = (ms: number): string => (ms >= 10 * 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}분` : `${Number((ms / 1000).toFixed(1))}초`);

/** 본문 시간 상한으로 끝낸 요청의 답 (S3-32) — 상한을 넣어 사실대로 */
function bodyTimeoutError(kind: 'invoke' | 'uploadIdle' | 'uploadTotal', ms: number): WookErrorPayload {
  const message =
    kind === 'invoke'
      ? `요청 본문이 ${spanText(ms)} 안에 다 오지 않아 멈췄습니다. 연결을 확인하고 다시 해 주세요.`
      : kind === 'uploadIdle'
        ? `올리는 중 ${spanText(ms)} 동안 데이터가 오지 않아 멈췄습니다. 연결을 확인하고 다시 올려 주세요.`
        : `올리는 데 ${spanText(ms)} 넘게 걸려 멈췄습니다. 더 빠른 연결에서 다시 올리거나 파일을 나눠 올려 주세요.`;
  return { code: 'timeout', message };
}

/**
 * 횟수 제한 (리드 결정 S3-11): 창(1분)마다 호출자 열쇠별 요청 수. 넘으면 429 `rate_limited`이고 처리하지 않는다. 세션 없는 요청의 열쇠는 Tailscale 사용자
 * (없으면 이름 없는 쪽 하나)다 — 로그인 전 쿠키(__Host-wos_login)는 아무 값이나 지어 보낼 수 있어 열쇠로 쓰지 않는다(S3b와 같다). 세션 없는 요청은 모두 합친
 * 상한도 있다(Tailscale 머리를 바꿔 가며 보내도)
 */
export interface RateLimits {
  windowMs: number;
  /** 세션 없는 요청 — 열쇠(Tailscale 사용자, 없으면 이름 없는 쪽 하나)마다 */
  anonymousPerKey: number;
  /** 세션 없는 요청 모두 합쳐 */
  anonymousTotal: number;
  /** 기기 세션마다 */
  perSession: number;
  /** 세션 없는 SSE 연결 (모두 합쳐 동시에) */
  anonymousStreams: number;
  /** 한 기기 세션이 동시에 올리는 파일 */
  uploadsPerSession: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { windowMs: 60_000, anonymousPerKey: 120, anonymousTotal: 600, perSession: 1200, anonymousStreams: 20, uploadsPerSession: 3 };
/** 횟수를 세는 열쇠 수 상한 — 넘으면 끝난 창의 열쇠부터 버린다 (Tailscale 머리를 바꿔 가며 보내 메모리를 채우지 못하게) */
const MAX_RATE_KEYS = 10_000;

/**
 * 모아 쓰는 접근 줄 종류 — Host 거부(403), Tailscale 사용자 거부(403, S3-7), 토큰이 맞지 않음(401: 틀린 Authorization 머리·주소에 든 토큰), 세션 없이
 * 온 API 요청(로그인 전 — S3-3), 횟수 제한(429, S3-11), API 밖 경로(정적 화면·안내 쪽과 그 404·405·400)
 */
type OpenAccess = 'host' | 'tailscale' | 'unauthorized' | 'anonymous' | 'limited' | 'static';
const OPEN_ACCESS_SUMMARY: Record<OpenAccess, string> = {
  host: 'Host 검사에서 거부한 요청',
  tailscale: 'Tailscale 사용자 검사에서 거부한 요청',
  unauthorized: '토큰이 없거나 맞지 않아 거부한 API 요청',
  anonymous: '세션 없이 온 API 요청',
  limited: '횟수 제한으로 거부한 요청',
  static: 'API 밖 경로(정적 화면·안내 쪽) 요청',
};
/** `?members=`에 넣을 수 있는 팀원 수 */
const MAX_MEMBERS_FILTER = 50;
const MEMBER_ID_RE = /^M-(?:\d{4,9}|MAIN)$/;

const KNOWN_METHODS: ReadonlySet<string> = new Set<string>(IPC_METHODS);

export const HTTP_ERRORS = {
  forbiddenHost: { code: 'forbidden_host', message: '허용되지 않은 Host 헤더입니다 — 이 서버는 127.0.0.1·localhost·[::1]와 정해 둔 공개 주소로 온 요청만 받습니다' },
  forbiddenTailscale: { code: 'forbidden_tailscale_user', message: '이 서버가 받는 Tailscale 사용자의 요청이 아닙니다 (Tailscale-User-Login)' },
  rateLimited: { code: 'rate_limited', message: '요청이 너무 잦습니다 — 잠시 뒤에 다시 해 주세요' },
  uploadTooLarge: { code: 'too_large', message: '올리는 파일이 너무 큽니다 (50MB까지)' },
  uploadBusy: { code: 'rate_limited', message: '이 기기에서 올리는 파일이 이미 여러 개입니다 — 끝난 뒤에 올려 주세요' },
  uploadFailed: { code: 'internal', message: '파일을 받지 못했습니다 — 다시 올려 주세요' },
  fileNotFound: { code: 'not_found', message: '없는 파일입니다' },
  unauthorized: { code: 'unauthorized', message: '세션 토큰이 맞지 않거나 끝났습니다 — 다시 로그인하세요' },
  queryToken: { code: 'unauthorized', message: '토큰을 주소에 넣지 마세요 — 쿠키나 Authorization: Bearer 머리로만 받습니다' },
  noSession: { code: 'unauthorized', message: '로그인이 필요합니다' },
  forbiddenOrigin: { code: 'forbidden_origin', message: '욱채 화면에서 보낸 요청이 아니어서 받지 않습니다 (Origin·X-Wook-Client 확인)' },
  notFound: { code: 'not_found', message: '없는 API 경로입니다' },
  methodNotAllowed: { code: 'method_not_allowed', message: '이 경로에서 받지 않는 HTTP 메서드입니다' },
  contentType: { code: 'invalid_body', message: '요청 본문은 JSON이어야 합니다 (Content-Type: application/json)' },
  badBody: { code: 'invalid_body', message: '요청 본문은 {id, method, args} 모양의 JSON이어야 합니다' },
  tooLarge: { code: 'too_large', message: '요청 본문이 너무 큽니다 (1MB까지)' },
  badMembers: { code: 'invalid_args', message: '?members=에는 쉼표로 나눈 팀원 ID(예: M-0016)만 넣을 수 있습니다' },
  shuttingDown: { code: 'shutting_down', message: '서버를 끝내는 중입니다' },
  // Node가 요청을 읽다 멈춘 것 (clientError, S3-32) — 머리를 제시간에 다 받지 못함(408), HTTP 요청 모양이 아님(400)
  requestTimeout: { code: 'timeout', message: '요청이 제시간에 다 오지 않아 끊었습니다. 연결을 확인하고 다시 해 주세요.' },
  badRequest: { code: 'bad_request', message: 'HTTP 요청을 읽지 못했습니다 — 요청 모양이 맞지 않습니다' },
  // 머리가 Node의 상한(16KB)을 넘음(431, S3-38) — 같은 tailnet의 다른 기계가 이 이름의 쿠키 단지를 다른 이름의 쿠키로 채웠을 수 있다. 되는 길을 말한다
  headersTooLarge: {
    code: 'headers_too_large',
    message: '요청 머리글이 너무 커서 읽지 못했습니다. 이 주소에 쿠키가 너무 많이 쌓였을 수 있습니다. 브라우저에서 이 사이트의 쿠키를 지운 뒤 다시 여세요.',
  },
} as const satisfies Record<string, WookErrorPayload>;

/**
 * InvokeResponse → HTTP 상태 (S2-8). 본문은 그대로 InvokeResponse다.
 * 200 성공 · 400 본문·인자 오류 · 401 로그인 필요 · 403 권한 밖 · 404 없는 메서드·대상 · 429 횟수 제한 · 500 내부 오류 · 409 그 밖에 지금 상태로는 처리하지 못한 요청(충돌·정지 중·서버 모드에서 못 하는 일 등)
 */
export function httpStatusFor(r: InvokeResponse): number {
  if (r.ok) return 200;
  switch (r.error.code) {
    case 'invalid_args':
    case 'invalid_body':
    case 'invalid':
    case 'invalid_url':
    case 'invalid_path':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'unknown_method':
    case 'not_found':
      return 404;
    // 횟수 제한 (기기 코드 로그인 시작·설정 코드, S3-5·S3-6)
    case 'rate_limited':
      return 429;
    case 'internal':
    case 'backend_unavailable':
    case 'db_failed':
      return 500;
    default:
      return 409;
  }
}

/** 모든 응답에 붙이는 보안 머리 (S2-8) */
function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** `--web-dir` 없이 띄웠을 때 `/`에 보이는 쪽 (S2-8) — 웹 화면을 붙이는 길을 운영자에게 알린다 (S8-5) */
export const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>욱채 서버</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6">
<h1>욱채 서버</h1>
<p>서버는 돌고 있습니다. 웹 화면 없이 띄워 API(<code>/api/invoke</code>, <code>/api/events</code>)만 열려 있습니다.</p>
<p>운영자가 서버 PC의 저장소 폴더에서 <code>npm run build:web</code>으로 웹 화면을 만들고 서버를 <code>--web-dir out/web</code>으로 다시 띄우면 이 주소에서 욱채 화면이 열립니다.</p>
</body>
</html>
`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 정적 화면을 gzip으로 줄여 보낼 형식 (리드 결정 S8-5) — 글과 GLB. 빌드한 화면에서 재어 보니 JS·CSS는 70% 남짓, studio3d의 GLB는 75% 남짓 준다.
 * 이미 눌린 그림·글꼴(png·jpg·webp·gif·woff2)은 줄지 않아 그대로 보낸다
 */
const COMPRESSIBLE_EXT: ReadonlySet<string> = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.txt', '.svg', '.ico', '.glb', '.gltf', '.wasm']);
/** 이보다 작은 파일은 줄이지 않는다 */
const GZIP_MIN_BYTES = 1024;
/** 파일 하나를 줄이는 상한 — 넘으면 그대로 보낸다 */
const GZIP_MAX_FILE_BYTES = 32 * 1024 * 1024;
const gzipAsync = promisify(gzip);

/**
 * 정적 화면 캐시의 상한 (리드 결정 S8-26 c) — 넘으면 가장 오래 쓰지 않은 것부터 뺀다. 열쇠는 디스크의 실제 경로(대소문자까지)라 같은 파일을 다르게 적은
 * 요청이 자리를 늘리지 않는다. 빌드한 화면은 줄일 파일이 9MB 남짓이라 다 담긴다
 */
export interface StaticCacheLimits {
  /** gzip으로 줄인 것을 모아 두는 파일 수 */
  gzipFiles: number;
  /** 그 원본 크기의 합 */
  gzipBytes: number;
  /** 내용 태그(ETag)를 모아 두는 파일 수 (태그 하나는 수십 바이트) */
  tagFiles: number;
}
export const DEFAULT_STATIC_CACHE_LIMITS: StaticCacheLimits = { gzipFiles: 1024, gzipBytes: 128 * 1024 * 1024, tagFiles: 4096 };

/**
 * 디스크의 실제 경로 (S8-26 c) — 링크를 따라가고 Windows에서는 대소문자·짧은 이름(8.3)까지 디스크에 적힌 대로다(realpathSync.native). JS의 realpathSync는
 * 요청에 적은 대소문자를 그대로 두어, /NOTIFY-SW.JS가 워커의 CSP 머리 없이 나가고 캐시 자리가 철자마다 늘었다. native가 실패하는 드라이브는 JS 쪽으로
 */
export function diskPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return realpathSync(p);
  }
}
/** 화면의 알림 서비스 워커 (`--web-dir` 맨 위, S8-19) — 화면과 같은 CSP 머리를 단다 (S8-23 2) */
export const NOTIFY_WORKER_FILE = 'notify-sw.js';

/** 빌드가 이름에 내용 해시를 붙인 파일 (`assets/index-8aYcPvDU.js`) — `assets/` 아래이고 이름 끝이 `-<해시 8자 이상>.<확장자>` */
export function isHashedAsset(webRoot: string, file: string): boolean {
  const rel = relative(webRoot, file).split(sep);
  return rel.length >= 2 && rel[0] === 'assets' && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(rel[rel.length - 1]!);
}

/** If-None-Match가 이 ETag와 맞는지 — GET·HEAD는 약한 비교다(RFC 9110 13.1.2: `W/`를 떼고 견준다). `*`는 늘 맞다 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const text = Array.isArray(header) ? header.join(',') : (header ?? '');
  if (text.trim() === '') return false;
  if (text.trim() === '*') return true;
  return text.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

/** Accept-Encoding이 gzip을 받는지 (`gzip`·`x-gzip`, 없으면 `*`, q=0은 받지 않음) */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const text = Array.isArray(header) ? header.join(',') : (header ?? '');
  let gz: number | null = null;
  let star: number | null = null;
  for (const part of text.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (name === 'gzip' || name === 'x-gzip') gz = weight;
    else if (name === '*') star = weight;
  }
  const weight = gz ?? star ?? 0;
  return Number.isFinite(weight) && weight > 0;
}

/**
 * 요청 경로 → `webDir` 안의 파일 경로. 폴더 밖을 가리키거나 이상한 경로면 null — `..`·역슬래시·드라이브 표시(`:`)·NUL·잘못된 % 인코딩을 받지 않고,
 * 심볼릭 링크로 밖을 가리키는 것도 실제 경로로 다시 본다(serveStatic)
 */
export function webPathFor(webRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || /[\0\\:]/.test(decoded)) return null;
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  const full = resolve(webRoot, ...segments);
  return full === webRoot || full.startsWith(webRoot + sep) ? full : null;
}

interface Stream {
  res: ServerResponse;
  /** 연결을 연 호출자 — 토픽을 이 호출자로 거른다 (S3-3) */
  caller: RemoteCaller;
  /** 연결을 연 기기 세션 (세션 없는 연결이면 null) — 그 세션이 끊기면 닫는다 (S3-4) */
  sessionId: string | null;
  /** 그 세션의 만료 시각 (벽시계, epoch ms. 세션 없는 연결은 Infinity) — 보낼 때와 살아 있음 신호마다 본다 (S2-20) */
  expiresAt: number;
  members: ReadonlySet<string>;
  /** write가 false를 돌려 drain을 기다리는 중 */
  blocked: boolean;
  /** 막힌 동안의 가장 최근 스냅숏 (하나만) */
  pendingSnapshot: string | null;
  /** 막힌 동안의 다른 토픽 (상한까지) */
  queue: string[];
  lastSnapshotVersion: number;
  timers: ReturnType<typeof setTimeout>[];
  /** 세션 연결의 만료 타이머 — 세션이 늦춰지면 다시 건다 (S3-27) */
  expiry: ReturnType<typeof setTimeout> | null;
  /** 연결을 연 요청의 Host와 Tailscale 사용자 — 운영자 설정이 바뀌면 지금 접속 허용으로 다시 본다 (S3-34) */
  host: string | undefined;
  tailscaleLogin: string | null;
  closed: boolean;
}

export interface HttpSurfaceOptions {
  /** invoke는 호출자를 받아 원격 길 게이트로 돈다 (S3-3). 토픽은 거르지 않고 받고(onTopicRaw) 연결마다 topicFor로 거른다 */
  backend: Pick<Backend, 'invoke' | 'onTopicRaw' | 'topicFor' | 'snapshotFor'>;
  /** 기기 세션 저장소 (백엔드, S3-4) — 토큰 확인과 끊긴 세션의 SSE 닫기 */
  sessions: Pick<DeviceSessionStore, 'verify' | 'live' | 'onRevoke'>;
  /** 공개 주소 (--public-origin, S3-7) — 받는 Host와 상태 변경 요청에 받는 Origin에 더한다. 없으면 루프백 주소만. access가 있으면 그쪽이 먼저다 */
  publicOrigin?: string | null;
  /**
   * 요청마다 읽는 접속 허용 (S3-7): 공개 주소와 받는 Tailscale 사용자(server.json — config reload가 바로 바꾼다). 없으면 publicOrigin 칸과 사용자 검사 없음
   */
  access?: () => { publicOrigin: string | null; tailscaleLogins: readonly string[] | null };
  /** 업로드·내려받기 (S3-10) — 없으면 그 경로는 없는 API 경로다 */
  files?: ServerFileAccess;
  /** 횟수 제한 (S3-11, 기본 DEFAULT_RATE_LIMITS) — 시험이 줄인다 */
  rateLimits?: Partial<RateLimits>;
  /** 본문 시간 상한 (S3-32, 기본 DEFAULT_HTTP_TIMEOUTS) — 시험이 줄인다. 머리 시간은 서버(createSurfaceServer)가 쓴다 */
  timeouts?: Partial<HttpTimeouts>;
  logger: Logger;
  runId: string;
  /** 실제로 듣는 포트 (Host 검사) — listen 뒤에 정해진다 */
  port: () => number;
  /** 빌드한 웹 화면 폴더 (없으면 안내 쪽만). 서버용 빌드 표시는 startServer가 시작 때 본다 (S8-5) */
  webDir: string | null;
  now?: () => number;
  heartbeatMs?: number;
  sseQueueLimit?: number;
  /** 시험: 접근 줄을 모으는 창 (기본 HTTP_ACCESS_WINDOW_MS) */
  accessLogWindowMs?: number;
  /** 시험: 정적 화면 캐시의 상한 (S8-26 c, 기본 DEFAULT_STATIC_CACHE_LIMITS) */
  staticCache?: Partial<StaticCacheLimits>;
}

export interface HttpSurface {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** 종료 시작: 새 요청을 503으로 받는다 (열린 SSE는 closeStreams까지 둔다) */
  beginShutdown(): void;
  /** 열린 SSE를 모두 닫는다 */
  closeStreams(): void;
  /**
   * 운영자 설정을 적용한 뒤(config reload·config 명령) 열린 SSE마다 연 때의 Host·Tailscale 사용자를 지금 접속 허용(공개 주소·받는 Tailscale 사용자)으로 다시
   * 본다 — 이제 받지 않는 연결은 더 보내지 않고 닫는다 (리드 결정 S3-34). 닫은 수를 돌려준다
   */
  recheckAccess(): number;
  /** 토픽 구독을 풀고, 모은 접근 줄의 남은 수를 쓴다 */
  dispose(): void;
  streamCount(): number;
  /** 시험: 정적 화면 캐시에 담긴 파일 수와 gzip의 원본 크기 합 (S8-26 c) */
  staticCacheStats(): { gzipFiles: number; gzipBytes: number; tagFiles: number };
}

export function createHttpSurface(o: HttpSurfaceOptions): HttpSurface {
  const { logger, runId } = o;
  const now = o.now ?? Date.now;
  const heartbeatMs = o.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const queueLimit = o.sseQueueLimit ?? SSE_QUEUE_LIMIT;
  // 원격 호출자 — 기록에는 아는 메서드 이름과 오류 code만 (S2-13)
  const invoke = createInvokeCore({ backend: o.backend, logger, channel: 'HTTP', omitCallerText: true });
  // 세션 없이 온 요청의 처리 기록('HTTP 요청 실패: snapshot.get [unauthorized]' 등)도 종류마다 1분에 한 줄과 수 한 줄로 모은다 — 로그인 전 길은 누구나
  // 보낼 수 있어, 요청마다 쓰면 기록 회전을 밀어낸다 (S2-20·S3-3)
  const anonymousNotes = collapsedLog<'info' | 'warn' | 'error'>({
    write: (text, level) => logger[level](text),
    windowMs: o.accessLogWindowMs ?? HTTP_ACCESS_WINDOW_MS,
    summary: (level, extra, span) => `HTTP: 세션 없이 온 요청의 ${level === 'error' ? '오류' : '처리'} 기록이 지난 ${span} 동안 ${extra}번 더 있었습니다`,
  });
  const note =
    (level: 'info' | 'warn' | 'error') =>
    (message: string, ...details: unknown[]): void =>
      anonymousNotes.log(level, details.length ? `${message} ${details.map(formatDetail).join(' ')}` : message);
  const invokeAnonymous = createInvokeCore({ backend: o.backend, logger: { info: note('info'), warn: note('warn'), error: note('error') }, channel: 'HTTP', omitCallerText: true });
  // 화면 폴더도 디스크의 실제 경로로 — 파일의 실제 경로와 같은 철자로 견준다 (S8-26 c)
  const webRoot = o.webDir ? diskPath(o.webDir) : null;
  const cacheLimits: StaticCacheLimits = { ...DEFAULT_STATIC_CACHE_LIMITS, ...o.staticCache };
  const streams = new Set<Stream>();
  let shuttingDown = false;
  // 토큰 없이 누구나 보낼 수 있는 요청의 접근 줄은 모은다 — 같은 PC의 아무 계정(또는 DNS 재바인딩 페이지)이 요청만으로 기록 회전을 밀어내지 못하게 (S2-20)
  const openAccess = collapsedLog<OpenAccess>({
    write: (text) => logger.info(text),
    windowMs: o.accessLogWindowMs ?? HTTP_ACCESS_WINDOW_MS,
    summary: (kind, extra, span) => `HTTP: ${OPEN_ACCESS_SUMMARY[kind]}이 지난 ${span} 동안 ${extra}번 더 있었습니다`,
  });

  // 접속 허용 (S3-7): 공개 주소·받는 Tailscale 사용자 — 운영자 설정이 바뀌면(config reload) 다음 요청부터 따른다
  const access = (): { publicOrigin: string | null; tailscaleLogins: readonly string[] | null } => o.access?.() ?? { publicOrigin: o.publicOrigin ?? null, tailscaleLogins: null };
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...o.rateLimits };
  const timeouts: HttpTimeouts = { ...DEFAULT_HTTP_TIMEOUTS, ...o.timeouts };

  const hostAllowed = (host: string | undefined, publicOrigin: string | null): boolean => {
    if (!host) return false;
    const port = o.port();
    const h = host.toLowerCase();
    // 루프백 셋과 공개 주소(tailscale serve가 넘기는 Host)를 통째로 견준다 — 앞부분만 맞는 다른 이름은 받지 않는다 (S2-17·S3-7)
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}` || publicHosts(publicOrigin).includes(h);
  };

  /**
   * 쿠키로 온 세션 값들 가운데 살아 있는 첫 것 (리드 결정 S3-38) — 같은 이름이 여럿 오면(형제 기계가 Domain·Path를 달리해 던진 쿠키가 앞에) 값을 차례로
   * 본다. 토큰 모양이 아닌 값은 저장소에 묻지도 않는다(verify). 하나도 살아 있지 않으면 null
   */
  const firstLiveSession = (tokens: readonly string[]): DeviceSessionRecord | null => {
    for (const token of tokens) {
      const session = o.sessions.verify(token);
      if (session) return session;
    }
    return null;
  };

  // ───── 횟수 제한 (S3-11) ─────

  const counters = new Map<string, { start: number; count: number }>();
  /** 이 열쇠의 이번 창 요청 하나를 센다 — 상한을 넘었으면 창이 끝날 때까지 남은 초, 아니면 null */
  const spend = (key: string, max: number): number | null => {
    const t = now();
    let c = counters.get(key);
    if (!c || t - c.start >= limits.windowMs) {
      if (!c && counters.size >= MAX_RATE_KEYS) {
        for (const [k, v] of counters) if (t - v.start >= limits.windowMs) counters.delete(k);
        if (counters.size >= MAX_RATE_KEYS) counters.clear();
      }
      c = { start: t, count: 0 };
      counters.set(key, c);
    }
    c.count++;
    return c.count > max ? Math.max(1, Math.ceil((c.start + limits.windowMs - t) / 1000)) : null;
  };
  /** 요청 하나의 횟수 제한 — 넘었으면 다시 해도 되는 때까지 남은 초 */
  const rateLimited = (req: IncomingMessage, session: DeviceSessionRecord | null): number | null => {
    if (session) return spend(`session:${session.id}`, limits.perSession);
    const ts = tailscaleLoginOf(req);
    const own = spend(ts ? `tailscale:${ts.toLowerCase()}` : 'anonymous', limits.anonymousPerKey);
    const all = spend('anonymous:*', limits.anonymousTotal);
    return own ?? all;
  };
  /** 올리는 중인 파일 수 (기기 세션마다) */
  const uploading = new Map<string, number>();

  // ───── SSE ─────

  const closeStream = (s: Stream, reason: 'overflow' | 'expired' | 'revoked' | 'access' | 'shutdown' | 'client'): void => {
    if (s.closed) return;
    s.closed = true;
    streams.delete(s);
    for (const t of s.timers) clearTimeout(t);
    if (s.expiry) clearTimeout(s.expiry);
    s.expiry = null;
    s.queue.length = 0;
    s.pendingSnapshot = null;
    if (reason === 'overflow') {
      // 이벤트를 조용히 버리지 않는다 — 끊어서 화면이 다시 연결해 스냅숏부터 받게 한다
      logger.warn(`느린 SSE 연결의 대기열이 ${queueLimit}개를 넘어 끊었습니다 (다시 연결하면 스냅숏부터 받습니다)`);
      s.res.destroy();
      return;
    }
    if (reason !== 'client') {
      const why = reason === 'expired' ? '기기 세션 만료' : reason === 'revoked' ? '기기 세션이 끝남' : reason === 'access' ? '접속 허용이 바뀜 — 공개 주소·받는 Tailscale 사용자' : '서버 종료';
      logger.info(`SSE 연결 닫음 (${why})`);
    }
    if (!s.res.writableEnded) s.res.end();
  };

  const write = (s: Stream, frame: string): void => {
    if (s.closed) return;
    if (!s.res.write(frame)) {
      s.blocked = true;
      s.res.once('drain', () => flush(s));
    }
  };

  const flush = (s: Stream): void => {
    if (s.closed) return;
    s.blocked = false;
    while (!s.blocked && s.queue.length > 0) write(s, s.queue.shift()!);
    if (!s.blocked && s.pendingSnapshot !== null) {
      const frame = s.pendingSnapshot;
      s.pendingSnapshot = null;
      write(s, frame);
    }
  };

  const frameOf = (topic: WookTopic, payload: unknown): string => `event: ${topic}\ndata: ${JSON.stringify({ runId, payload })}\n\n`;

  /**
   * 세션이 만료됐으면 닫는다 (S2-20). 세션 만료(DeviceSessionStore.verify)는 벽시계로 본다 — 연결 때 건 만료 타이머는 단조 시계라 벽시계가 앞으로 뛰면
   * (Linux 절전에서 깨어남, NTP 보정) 늦게 울려, 그동안 만료된 세션의 연결이 이벤트를 받는다. 그래서 보낼 때와 살아 있음 신호마다 벽시계로도 본다.
   * 알고 있던 만료가 지났어도 그사이 다른 요청이 세션을 늦췄으면 산 연결이다 — 저장소의 지금 세션을 벽시계로 다시 보고, 늦춰졌으면 만료 타이머를 다시
   * 건다 (리드 결정 S3-27)
   */
  const expired = (s: Stream): boolean => {
    if (now() < s.expiresAt) return false;
    const live = s.sessionId ? o.sessions.live(s.sessionId) : null;
    if (live && now() < sessionExpiresAt(live)) {
      s.expiresAt = sessionExpiresAt(live);
      armExpiry(s);
      return false;
    }
    closeStream(s, 'expired');
    return true;
  };

  /** 세션 연결의 만료 타이머를 지금 알고 있는 만료에 건다 — 울리면 닫기 전에 세션을 다시 본다(expired) (S3-27) */
  const armExpiry = (s: Stream): void => {
    if (s.closed || !s.sessionId) return;
    if (s.expiry) clearTimeout(s.expiry);
    s.expiry = setTimeout(() => {
      s.expiry = null;
      if (!expired(s)) armExpiry(s);
    }, Math.min(Math.max(0, s.expiresAt - now()), 2 ** 31 - 1));
    s.expiry.unref();
  };

  /** 버스에서 온 토픽 — 그 연결의 호출자로 거른 뒤 보낸다 (S3-3) */
  const deliver = (s: Stream, topic: WookTopic, payload: unknown): void => {
    if (s.closed || expired(s)) return;
    if (topic === 'cliEvents' && !s.members.has((payload as { memberId?: unknown } | null)?.memberId as string)) return;
    const value = o.backend.topicFor(topic, payload as never, s.caller);
    if (value !== undefined) send(s, topic, value);
  };

  /** 이미 그 호출자로 거른 값을 보낸다 */
  const send = (s: Stream, topic: WookTopic, payload: unknown): void => {
    if (s.closed || expired(s)) return;
    if (topic === 'snapshot') {
      const version = (payload as AppSnapshot | null)?.version;
      if (typeof version === 'number') {
        // 연결 때 읽은 스냅숏보다 버스 스냅숏이 먼저 갔으면 옛것을 다시 보내지 않는다
        if (version < s.lastSnapshotVersion) return;
        s.lastSnapshotVersion = version;
      }
    }
    const frame = frameOf(topic, payload);
    if (!s.blocked) return write(s, frame);
    if (topic === 'snapshot') {
      s.pendingSnapshot = frame;
      return;
    }
    s.queue.push(frame);
    if (s.queue.length > queueLimit) closeStream(s, 'overflow');
  };

  // 토픽은 서버가 거르지 않고 한 번만 구독하고 연결마다 그 호출자로 거른다 (S3-3)
  const unsubscribers = IPC_TOPICS.map((topic) =>
    o.backend.onTopicRaw(topic, (payload) => {
      for (const s of [...streams]) deliver(s, topic, payload);
    }),
  );
  // 기기 세션이 끊기면(그 기기 로그아웃·기기 끊기·모두 끊기) 그 세션으로 연 연결을 닫는다 — 끊긴 세션이 SSE로 계속 받지 않게 (S3-4)
  unsubscribers.push(
    o.sessions.onRevoke((id) => {
      for (const s of [...streams]) if (s.sessionId === id) closeStream(s, 'revoked');
    }),
  );

  const openEvents = (req: IncomingMessage, res: ServerResponse, url: URL, caller: RemoteCaller, session: DeviceSessionRecord | null): void => {
    const expiresAt = session ? sessionExpiresAt(session) : Number.POSITIVE_INFINITY;
    const raw = url.searchParams.getAll('members').flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v.length > 0);
    if (raw.length > MAX_MEMBERS_FILTER || raw.some((id) => !MEMBER_ID_RE.test(id))) {
      sendJson(res, 400, failResponse(HTTP_ERRORS.badMembers));
      return;
    }
    // 세션 없는 연결은 모두 합쳐 상한까지 (S3-11) — 로그인 전에도 열리는 길이라 누구나 연결을 쌓을 수 있다
    if (!session && [...streams].filter((x) => x.sessionId === null).length >= limits.anonymousStreams) {
      sendJson(res, 429, failResponse(HTTP_ERRORS.rateLimited), { 'Retry-After': '30' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const sessionId = session?.id ?? null;
    const s: Stream = {
      res,
      caller,
      sessionId,
      expiresAt,
      members: new Set(raw),
      blocked: false,
      pendingSnapshot: null,
      queue: [],
      lastSnapshotVersion: -1,
      timers: [],
      expiry: null,
      host: req.headers.host,
      tailscaleLogin: tailscaleLoginOf(req),
      closed: false,
    };
    streams.add(s);
    const heartbeat = setInterval(() => {
      if (expired(s)) return;
      if (sessionId) {
        // 세션의 지금 만료를 다시 읽는다 — 다른 요청이 쓴 것으로 늦춰졌거나, 대표가 바뀌어 죽었을 수 있다 (S3-4). 늦춰졌으면 만료 타이머도 다시 건다 (S3-27)
        const live = o.sessions.live(sessionId);
        if (!live) return closeStream(s, 'revoked');
        const at = sessionExpiresAt(live);
        if (at !== s.expiresAt) {
          s.expiresAt = at;
          armExpiry(s);
        }
      }
      if (!s.blocked) write(s, ': ping\n\n');
    }, heartbeatMs);
    heartbeat.unref();
    s.timers.push(heartbeat);
    armExpiry(s);
    res.on('close', () => closeStream(s, 'client'));
    req.on('error', () => closeStream(s, 'client'));
    write(s, ': connected\n\n');
    // 연결하자마자 지금 스냅숏 — 그 호출자로 거른 것 (세션이 없으면 업무 내용을 뺀 것, S3-3)
    void o.backend.snapshotFor(caller).then(
      (snap) => send(s, 'snapshot', snap),
      (error: unknown) => logger.warn(`SSE 첫 스냅숏을 만들지 못했습니다: ${error instanceof Error ? error.name : typeof error}`),
    );
  };

  // ───── invoke ─────

  const readBody = (req: IncomingMessage, res: ServerResponse): Promise<string | null> =>
    new Promise((resolveBody) => {
      const declared = Number(req.headers['content-length'] ?? '0');
      const tooLarge = (): void => {
        sendJson(res, 413, failResponse(HTTP_ERRORS.tooLarge), { Connection: 'close' });
        res.once('finish', () => req.destroy());
        resolveBody(null);
      };
      if (Number.isFinite(declared) && declared > MAX_INVOKE_BODY_BYTES) {
        req.resume();
        return tooLarge();
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      // 본문은 통째로 시간 상한 안에 다 와야 한다 (S3-32) — Node의 requestTimeout은 끄고 여기서 본다. 넘으면 408과 InvokeResponse
      const timer = setTimeout(() => {
        if (over) return;
        over = true;
        chunks.length = 0;
        sendJson(res, 408, failResponse(bodyTimeoutError('invoke', timeouts.invokeBodyMs)), { Connection: 'close' });
        res.once('finish', () => req.destroy());
        resolveBody(null);
      }, timeouts.invokeBodyMs);
      timer.unref();
      req.on('data', (chunk: Buffer) => {
        if (over) return;
        size += chunk.length;
        if (size > MAX_INVOKE_BODY_BYTES) {
          over = true;
          clearTimeout(timer);
          chunks.length = 0;
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        clearTimeout(timer);
        if (!over) resolveBody(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', () => {
        clearTimeout(timer);
        if (!over) resolveBody(null);
      });
    });

  const handleInvoke = async (req: IncomingMessage, res: ServerResponse, done: (label: string) => void, caller: RemoteCaller): Promise<void> => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      sendJson(res, 400, failResponse(HTTP_ERRORS.contentType));
      return done('/api/invoke');
    }
    const text = await readBody(req, res);
    if (text === null) return done('/api/invoke');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const id = b?.['id'];
    const idOk = (typeof id === 'string' && id.length > 0 && id.length <= 200) || (typeof id === 'number' && Number.isFinite(id));
    if (!b || !idOk || typeof b['method'] !== 'string') {
      sendJson(res, 400, failResponse(HTTP_ERRORS.badBody));
      return done('/api/invoke');
    }
    const method = b['method'];
    // 기록에는 아는 메서드 이름만 남긴다 (모르는 이름은 invokeCore도 '(알 수 없는 메서드)'로만 남긴다, S2-13)
    const label = `/api/invoke ${KNOWN_METHODS.has(method) ? method : '(알 수 없는 메서드)'}`;
    // 요청 ID를 넘긴다 — 상태를 바꾸는 요청은 같은 기기 세션의 같은 ID를 한 번만 처리하고 저장한 답을 준다 (S3-9, 백엔드 게이트)
    const response = await (caller.session ? invoke : invokeAnonymous)(method, b['args'], { ...caller, requestId: String(id) });
    // 그 요청으로 이 기기의 세션이 끝났으면(그 기기 로그아웃·이 기기 끊기) 세션 쿠키를 지운다 (S3-4)
    if (caller.session && !o.sessions.live(caller.session.id) && !res.headersSent) appendSetCookie(res, CLEAR_SESSION_COOKIE);
    if (!res.writableEnded) sendJson(res, httpStatusFor(response), response);
    done(label);
  };

  // ───── 업로드·내려받기 (S3-10) ─────

  /**
   * `POST /api/uploads?name=<파일 이름>`: 본문(파일 바이트 그대로)을 `<dataDir>/uploads/`에 흘려 쓴다 — 50MB까지(머리의 크기로 먼저, 받으면서 다시 센다).
   * 답 `{ ok: true, value: { uploadId, name, size, expiresAt } }` — 명령 첨부에 `{ name, uploadId }`로 붙인다. 그 기기 세션만 그 업로드를 쓴다
   */
  const handleUpload = (req: IncomingMessage, res: ServerResponse, url: URL, session: DeviceSessionRecord, files: ServerFileAccess): void => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    const tooLarge = (): void => {
      if (!res.headersSent) sendJson(res, 413, failResponse(HTTP_ERRORS.uploadTooLarge), { Connection: 'close' });
      res.once('finish', () => req.destroy());
    };
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
      req.resume();
      return tooLarge();
    }
    const busy = uploading.get(session.id) ?? 0;
    if (busy >= limits.uploadsPerSession) {
      req.resume();
      return sendJson(res, 429, failResponse(HTTP_ERRORS.uploadBusy), { 'Retry-After': '5' });
    }
    uploading.set(session.id, busy + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const n = (uploading.get(session.id) ?? 1) - 1;
      if (n > 0) uploading.set(session.id, n);
      else uploading.delete(session.id);
    };
    let place: { id: string; tmpPath: string };
    try {
      place = files.beginUpload();
    } catch (error) {
      release();
      req.resume();
      logger.error('업로드 자리를 만들지 못했습니다', error);
      return sendJson(res, 500, failResponse(HTTP_ERRORS.uploadFailed));
    }
    const out = createWriteStream(place.tmpPath, { flags: 'wx' });
    let size = 0;
    let ended = false;
    // 시간 상한 (S3-32): 데이터 없이 uploadIdleMs가 지나거나(쉼) 통째로 uploadTotalMs가 지나면 멈추고 408 — Node의 requestTimeout은 껐다
    const idle = setTimeout(() => fail('idle'), timeouts.uploadIdleMs);
    const total = setTimeout(() => fail('total'), timeouts.uploadTotalMs);
    idle.unref();
    total.unref();
    const fail = (status: 'large' | 'error' | 'aborted' | 'idle' | 'total', error?: unknown): void => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      clearTimeout(total);
      release();
      req.unpipe(out);
      out.destroy();
      // 받다 만 파일을 지운다 — 쓰기 흐름이 닫힌 뒤에도 한 번 더(아직 열리는 중이던 파일이 뒤에 생기지 않게)
      files.abortUpload(place.id);
      out.once('close', () => files.abortUpload(place.id));
      if (status === 'large') return tooLarge();
      if (status === 'idle' || status === 'total') {
        logger.warn(`업로드를 멈췄습니다 (${status === 'idle' ? `${spanText(timeouts.uploadIdleMs)} 동안 데이터 없음` : `${spanText(timeouts.uploadTotalMs)} 넘게 걸림`})`);
        if (!res.headersSent) sendJson(res, 408, failResponse(bodyTimeoutError(status === 'idle' ? 'uploadIdle' : 'uploadTotal', status === 'idle' ? timeouts.uploadIdleMs : timeouts.uploadTotalMs)), { Connection: 'close' });
        res.once('finish', () => req.destroy());
        return;
      }
      if (status === 'error') {
        logger.error('올린 파일을 쓰지 못했습니다', error);
        if (!res.headersSent) sendJson(res, 500, failResponse(HTTP_ERRORS.uploadFailed));
      }
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > UPLOAD_MAX_BYTES) return fail('large');
      if (!ended) idle.refresh();
    });
    req.on('aborted', () => fail('aborted'));
    req.on('error', () => fail('aborted'));
    out.on('error', (error) => fail('error', error));
    out.on('finish', () => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      clearTimeout(total);
      release();
      try {
        const record = files.finishUpload({ id: place.id, sessionId: session.id, name: url.searchParams.get('name') ?? '', size });
        sendJson(res, 200, { ok: true, value: { uploadId: record.id, name: record.name, size: record.size, expiresAt: new Date(Date.parse(record.createdAt) + UPLOAD_KEEP_MS).toISOString() } });
      } catch (error) {
        files.abortUpload(place.id);
        logger.error('올린 파일을 제자리에 두지 못했습니다', error);
        if (!res.headersSent) sendJson(res, 500, failResponse(HTTP_ERRORS.uploadFailed));
      }
    });
    req.pipe(out);
  };

  /** 내려받을 때 그대로 보여 줘도 되는 형식 — 그림만. 그 밖(HTML·SVG·스크립트 등)은 이 주소의 쿠키로 돌 수 있어 늘 바이트로 내려받게 한다 */
  const DOWNLOAD_INLINE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

  /**
   * `GET /api/attachments/:id`·`/api/reports/:id/file`·`/api/exports/:name`·`/api/screens/:id` (S3-10): 살아 있는 기기 세션만. 백엔드가 정한 파일을 실제
   * 경로로 다시 보고(심볼릭 링크·접합 포함) 그 폴더 밖이거나 파일이 아니면 404. 늘 내려받기(Content-Disposition: attachment)이고 샌드박스 CSP를 붙인다
   */
  const serveDownload = (req: IncomingMessage, res: ServerResponse, file: DownloadFile | null): void => {
    let real: string | null = null;
    if (file) {
      try {
        const root = realpathSync(file.root);
        const target = realpathSync(file.path);
        if (target.startsWith(root + sep) && statSync(target).isFile()) real = target;
      } catch {
        real = null;
      }
    }
    if (!file || !real) return sendJson(res, 404, failResponse(HTTP_ERRORS.fileNotFound));
    let size: number;
    try {
      size = statSync(real).size;
    } catch {
      return sendJson(res, 404, failResponse(HTTP_ERRORS.fileNotFound));
    }
    const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.writeHead(200, {
      'Content-Type': DOWNLOAD_INLINE_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(real)
      .on('error', (error) => {
        logger.error('내려받을 파일을 읽지 못했습니다', error);
        res.destroy();
      })
      .pipe(res);
  };

  /** 내려받기 경로 → 대상 (아니면 null). 경로 조각의 % 인코딩을 풀지 못하면 대상 없음(''로) */
  const downloadRoute = (pathname: string): { kind: DownloadKind; id: string; label: string } | null => {
    const m = /^\/api\/(?:(attachments)\/([^/]+)|(reports)\/([^/]+)\/file|(exports)\/([^/]+)|(screens)\/([^/]+))$/.exec(pathname);
    if (!m) return null;
    const raw = m[2] ?? m[4] ?? m[6] ?? m[8] ?? '';
    let id = '';
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = '';
    }
    if (m[1]) return { kind: 'attachment', id, label: '/api/attachments/:id' };
    if (m[3]) return { kind: 'report', id, label: '/api/reports/:id/file' };
    if (m[5]) return { kind: 'export', id, label: '/api/exports/:name' };
    return { kind: 'screen', id, label: '/api/screens/:id' };
  };

  // ───── 정적 화면 ─────

  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    const head = req.method === 'HEAD';
    if (!webRoot) {
      if (pathname === '/' || pathname === '/index.html') {
        if (head) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(PLACEHOLDER_PAGE) });
          res.end();
          return;
        }
        return sendText(res, 200, PLACEHOLDER_PAGE, 'text/html; charset=utf-8');
      }
      return sendText(res, 404, '없는 쪽입니다. 이 서버는 웹 화면 없이(--web-dir 없이) 띄웠습니다.');
    }
    const candidate = webPathFor(webRoot, pathname);
    if (!candidate) return sendText(res, 404, '없는 쪽입니다.');
    let file: string | null = null;
    for (const p of [candidate, join(candidate, 'index.html')]) {
      try {
        // 디스크에 적힌 철자로 — 머리(CSP·캐시·형식)와 캐시 열쇠가 요청의 철자를 따르지 않게 (S8-26 c)
        const real = diskPath(p);
        if ((real === webRoot || real.startsWith(webRoot + sep)) && statSync(real).isFile()) {
          file = real;
          break;
        }
      } catch {
        // 없는 경로
      }
    }
    // 화면 안의 주소(확장자 없는 경로)는 index.html로 — 화면이 경로를 읽는다. 없는 파일(확장자 있음)은 404
    if (!file && !extname(pathname)) file = join(webRoot, 'index.html');
    if (!file) return sendText(res, 404, '없는 쪽입니다.');
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(file));
    } catch {
      return sendText(res, 404, '없는 쪽입니다.');
    }
    const found = file;
    const type = contentTypeFor(found);
    const compressible = size >= GZIP_MIN_BYTES && COMPRESSIBLE_EXT.has(extname(found).toLowerCase());
    const send = (tag: string, gz: Buffer | null): void => {
      // 강한 ETag (내용 해시 — S8-21 d) — gzip으로 보낸 것은 다른 표현이라 다른 태그다. 조건부 요청(If-None-Match)이 맞으면 본문 없이 304 (S8-5)
      const etag = `"${tag}${gz ? '-gz' : ''}"`;
      const headers: Record<string, string | number> = {
        // 빌드가 이름에 내용 해시를 붙인 assets/의 파일은 바뀌지 않는다 — 1년 동안 다시 묻지 않는다. 그 밖(index.html, studio3d의 GLB, favicon)은 늘 다시 묻는다
        'Cache-Control': isHashedAsset(webRoot, found) ? 'public, max-age=31536000, immutable' : 'no-cache',
        ETag: etag,
      };
      if (compressible) headers['Vary'] = 'Accept-Encoding';
      // 화면(HTML)에는 전체 CSP — 서버용 빌드의 meta와 같은 정책에 frame-ancestors를 더한 것이 실제 정책이다 (S8-5). 알림 서비스 워커도 같은 정책이다 —
      // 워커의 정책은 그 스크립트 응답의 머리에서 오므로, 워커가 다른 출처에 묻거나 스크립트를 불러오지 못하게 (S8-23 2)
      if (type.startsWith('text/html') || found === join(webRoot, NOTIFY_WORKER_FILE)) headers['Content-Security-Policy'] = WEB_SCREEN_CSP;
      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      headers['Content-Type'] = type;
      headers['Content-Length'] = gz ? gz.length : size;
      if (gz) headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      if (head) {
        res.end();
        return;
      }
      if (gz) {
        res.end(gz);
        return;
      }
      createReadStream(found)
        .on('error', (error) => {
          logger.error('정적 파일을 읽지 못했습니다', error);
          res.destroy();
        })
        .pipe(res);
    };
    const gz = compressible && acceptsGzip(req.headers['accept-encoding']) ? gzipped(found, size, mtimeMs) : Promise.resolve(null);
    Promise.all([contentTag(found, size, mtimeMs), gz]).then(
      ([tag, data]) => send(tag, data),
      (error: unknown) => {
        // 읽는 사이에 파일이 없어졌을 수 있다(다시 빌드하는 중) — 없는 쪽으로 답한다
        logger.warn(`정적 파일을 읽지 못해 보내지 않았습니다: ${error instanceof Error ? error.name : typeof error}`);
        if (!res.headersSent) sendText(res, 404, '없는 쪽입니다.');
        else res.destroy();
      },
    );
  };

  /**
   * 파일 하나의 내용 태그 (S8-21 d): `<크기 36진>-<sha256 앞 32자>` — (크기·바뀐 때)마다 한 번 읽어 해시하고 다시 쓴다. 같은 내용으로 다시 빌드하면(바뀐 때만
   * 다름) 태그가 같아 브라우저가 받아 둔 것을 그대로 쓰고, 크기가 같아도 내용이 다르면 태그가 다르다. 읽지 못하면 그 약속은 거부하고 남기지 않는다
   */
  // 다시 빌드할 때마다 이름이 바뀌는 assets/ 파일의 옛 자리가 쌓이지 않게 — 상한을 넘으면 가장 오래 쓰지 않은 것부터 뺀다 (S8-26 c)
  const tagCache = createBoundedCache<{ key: string; tag: Promise<string> }>({ maxEntries: cacheLimits.tagFiles, maxBytes: Number.POSITIVE_INFINITY });
  const contentTag = (file: string, size: number, mtimeMs: number): Promise<string> => {
    const key = `${size}:${mtimeMs}`;
    const hit = tagCache.get(file);
    if (hit && hit.key === key) return hit.tag;
    const tag = new Promise<string>((done, fail) => {
      const hash = createHash('sha256');
      createReadStream(file)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', fail)
        .on('end', () => done(`${size.toString(36)}-${hash.digest('hex').slice(0, 32)}`));
    });
    tagCache.set(file, { key, tag });
    tag.catch(() => {
      if (tagCache.get(file)?.tag === tag) tagCache.delete(file);
    });
    return tag;
  };

  /**
   * 파일 하나의 gzip (S8-5) — 파일마다 한 번만 줄이고 (크기·바뀐 때)가 같으면 다시 쓴다. 요청마다 줄이지 않는다. 너무 크면, 또는 줄여도 작아지지 않으면
   * null(그대로 보낸다). 모아 둔 것이 상한(수·원본 크기 합)을 넘으면 가장 오래 쓰지 않은 것부터 뺀다 — 상한이 찼다고 새 파일을 줄이지 않는 일이 없다 (S8-26 c)
   */
  const gzipCache = createBoundedCache<{ key: string; data: Promise<Buffer | null> }>({ maxEntries: cacheLimits.gzipFiles, maxBytes: cacheLimits.gzipBytes });
  const gzipped = (file: string, size: number, mtimeMs: number): Promise<Buffer | null> => {
    const key = `${size}:${mtimeMs}`;
    const hit = gzipCache.get(file);
    if (hit && hit.key === key) return hit.data;
    if (size > GZIP_MAX_FILE_BYTES || !gzipCache.fits(size)) {
      gzipCache.delete(file);
      return Promise.resolve(null);
    }
    const data = readFile(file)
      .then((raw) => (raw.length === size ? gzipAsync(raw) : null))
      .then(
        (gz) => (gz && gz.length < size ? gz : null),
        (error: unknown) => {
          logger.warn(`정적 파일을 gzip으로 줄이지 못해 그대로 보냅니다: ${error instanceof Error ? error.name : typeof error}`);
          return null;
        },
      );
    gzipCache.set(file, { key, data }, size);
    return data;
  };

  // ───── 요청 나누기 ─────

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const started = now();
    const verb = typeof req.method === 'string' ? req.method.slice(0, 10) : '?';
    let label = 'static';
    // 토큰 없이 누구나 보낼 수 있는 요청이면 그 종류 — 접근 줄을 모은다. 토큰이 맞는 /api 요청(null)만 요청마다 한 줄이다 (S2-20)
    let open: OpenAccess | null = 'static';
    let logged = false;
    const done = (l?: string): void => {
      if (l) label = l;
    };
    res.once('close', () => {
      if (logged) return;
      logged = true;
      const line = `HTTP ${verb} ${label} → ${res.statusCode} (${now() - started}ms)`;
      if (open) openAccess.log(open, line);
      else logger.info(line);
    });
    securityHeaders(res);
    const allow = access();
    const apiPath = /^\/api(?:[/?]|$)/.test(req.url ?? '');
    // Host 검사가 먼저다 — 어떤 경로든 (S2-3). 공개 주소(S3-7)의 Host도 받는다
    if (!hostAllowed(req.headers.host, allow.publicOrigin)) {
      req.resume();
      open = 'host';
      label = 'Host 거부';
      return apiPath ? sendJson(res, 403, failResponse(HTTP_ERRORS.forbiddenHost)) : sendText(res, 403, HTTP_ERRORS.forbiddenHost.message);
    }
    // 받는 Tailscale 사용자 목록이 있으면 로그인 전에 거른다 — 어떤 경로든 (S3-7·3.6). 인증이 아니라 추가 방어다
    if (!tailscaleUserAllowed(req, allow.tailscaleLogins)) {
      req.resume();
      open = 'tailscale';
      label = 'Tailscale 사용자 거부';
      return apiPath ? sendJson(res, 403, failResponse(HTTP_ERRORS.forbiddenTailscale)) : sendText(res, 403, HTTP_ERRORS.forbiddenTailscale.message);
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      req.resume();
      return sendText(res, 400, '잘못된 요청 주소입니다.');
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const download = isApi ? downloadRoute(url.pathname) : null;
    // 기록에는 경로의 모양만 — 첨부·보고서 ID와 파일 이름은 남기지 않는다 (S2-13)
    if (isApi) label = url.pathname === '/api/invoke' || url.pathname === '/api/events' || url.pathname === '/api/uploads' ? url.pathname : (download?.label ?? '/api/(없는 경로)');
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.resume();
        return sendText(res, 405, HTTP_ERRORS.methodNotAllowed.message);
      }
      return serveStatic(req, res, url.pathname);
    }
    // 주소에 든 토큰은 늘 거부한다 — 방문 기록·앞단 접근 기록·복사한 링크에 남는다 (S3-4). 업로드의 파일 이름(POST /api/uploads의 name)만 값의 모양을
    // 보지 않는다 — 세션 토큰 모양의 이름을 가진 파일도 올라가게 (S8-21 b). 토큰 이름의 쿼리는 그 길에서도 401이다
    if (queryCarriesToken(url, req.method === 'POST' && url.pathname === '/api/uploads' ? UPLOAD_NAME_QUERY : undefined)) {
      req.resume();
      open = 'unauthorized';
      return sendJson(res, 401, failResponse(HTTP_ERRORS.queryToken));
    }
    // 누가 부르는지 (S3-3·S3-4): Authorization 머리를 실었으면 맞는 Bearer 세션이어야 하고(아니면 401), 쿠키는 끝났으면 세션 없는 호출자로 받고 지운다
    const credential = readCredential(req);
    // 쿠키를 실은(또는 브라우저가 Origin을 붙인) 상태 변경 요청은 욱채 화면에서 온 것이어야 한다 — X-Wook-Client: 1과 허용 Origin (S3-4·S3-7, CSRF 막기).
    // 세션을 보기(쓴 것으로 적기) 전에 거른다. Bearer로 인증한 요청은 브라우저가 저절로 싣는 값이 아니어서 보지 않는다
    if (isStateChange(req.method) && credential.kind !== 'bearer' && (carriesWookCookie(req) || req.headers.origin !== undefined) && !fromWookScreen(req, allowedOrigins(o.port(), allow.publicOrigin))) {
      req.resume();
      open = 'anonymous';
      return sendJson(res, 403, failResponse(HTTP_ERRORS.forbiddenOrigin));
    }
    const session = credential.kind === 'bearer' ? o.sessions.verify(credential.token) : credential.kind === 'cookie' ? firstLiveSession(credential.tokens) : null;
    if (credential.kind === 'bearer' && !session) {
      req.resume();
      open = 'unauthorized';
      return sendJson(res, 401, failResponse(HTTP_ERRORS.unauthorized), { 'WWW-Authenticate': 'Bearer' });
    }
    // 실은 세션 쿠키 값이 하나도 살아 있지 않을 때만 지운다 (S3-38) — 살아 있는 값이 있는데 지우면 브라우저는 대표의 쿠키를 지우고 던져진 쿠키를 남긴다
    if (credential.kind === 'cookie' && !session) appendSetCookie(res, CLEAR_SESSION_COOKIE);
    // 세션 없이 온 요청의 접근 줄은 모은다 — 로그인 전에도 열린 길이라 누구나 보낼 수 있다 (S2-20)
    open = session ? null : 'anonymous';
    if (shuttingDown) {
      req.resume();
      return sendJson(res, 503, failResponse(HTTP_ERRORS.shuttingDown));
    }
    // 횟수 제한 (S3-11) — 기기 세션마다, 세션 없는 요청은 Tailscale 사용자마다와 모두 합쳐. 넘은 요청은 처리하지 않고 접근 줄도 모은다
    const retryAfter = rateLimited(req, session);
    if (retryAfter !== null) {
      req.resume();
      open = 'limited';
      return sendJson(res, 429, failResponse(HTTP_ERRORS.rateLimited), { 'Retry-After': String(retryAfter) });
    }
    const caller: RemoteCaller = {
      surface: 'remote',
      session: session ? deviceSessionView(session, session.id) : null,
      clientKey: clientKeyOf(req, session),
      // 로그인 전 쿠키가 여럿이면 그 값들의 열쇠 — 결과 묻기는 그 가운데 어느 값으로 시작한 로그인이든 찾는다 (S3-38)
      loginKeys: loginKeysOf(req),
      tailscaleLogin: tailscaleLoginOf(req),
    };
    // 쿠키를 싣는 로그인은 공개 주소의 Host로 온 요청만 (S3-31) — 쿠키는 포트로 나뉘지 않아, 루프백 Host에 실은 쿠키는 같은 PC에서 다른 포트로 듣는
    // 프로그램에도 간다. 루프백 Host면 로그인 전 쿠키·세션 쿠키를 싣는 길을 주지 않고 기기 코드 로그인을 받지 않는 까닭을 싣는다. Bearer는 그대로다
    if (cookieHostAllowed(req.headers.host, allow.publicOrigin)) {
      // 대표 확인을 마친 로그인이 이 응답에 세션 쿠키를 싣는다 (S3-5) — 토큰은 본문에 넣지 않는다
      caller.grantSession = (grant) => {
        if (!res.headersSent) setSessionCookie(res, grant, now());
      };
      // 기기 코드 로그인을 시작한 이 브라우저만 그 결과를 묻게 — 로그인 전 쿠키 __Host-wos_login을 이 응답에 싣는다 (S3-5)
      caller.newLoginKey = () => issueLoginCookie(res);
    } else caller.loginRefusal = loopbackLoginRefusal(allow.publicOrigin);
    if (url.pathname === '/api/invoke') {
      if (req.method !== 'POST') {
        req.resume();
        return sendJson(res, 405, failResponse(HTTP_ERRORS.methodNotAllowed), { Allow: 'POST' });
      }
      handleInvoke(req, res, done, caller).catch((error: unknown) => {
        logger.error('HTTP 요청 처리 중 예기치 않은 오류', error);
        if (!res.headersSent) sendJson(res, 500, failResponse(INVOKE_ERRORS.internal));
        else res.destroy();
      });
      return;
    }
    if (url.pathname === '/api/events') {
      if (req.method !== 'GET') {
        req.resume();
        return sendJson(res, 405, failResponse(HTTP_ERRORS.methodNotAllowed), { Allow: 'GET' });
      }
      return openEvents(req, res, url, caller, session);
    }
    // 업로드·내려받기 (S3-10) — 살아 있는 기기 세션만. 세션이 없으면 그 밖의 경로처럼 401 (경로가 있는지 말하지 않는다)
    if (session && o.files && url.pathname === '/api/uploads') {
      if (req.method !== 'POST') {
        req.resume();
        return sendJson(res, 405, failResponse(HTTP_ERRORS.methodNotAllowed), { Allow: 'POST' });
      }
      return handleUpload(req, res, url, session, o.files);
    }
    if (session && o.files && download) {
      req.resume();
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, failResponse(HTTP_ERRORS.methodNotAllowed), { Allow: 'GET, HEAD' });
      let target: DownloadFile | null = null;
      try {
        target = o.files.download(download.kind, download.id);
      } catch (error) {
        logger.error('내려받을 파일을 찾지 못했습니다', error);
      }
      return serveDownload(req, res, target);
    }
    req.resume();
    // 없는 API 경로 — 세션이 없으면 경로가 있는지도 말하지 않는다
    if (!session) return sendJson(res, 401, failResponse(HTTP_ERRORS.noSession));
    sendJson(res, 404, failResponse(HTTP_ERRORS.notFound));
  };

  return {
    handle,
    beginShutdown() {
      shuttingDown = true;
    },
    closeStreams() {
      for (const s of [...streams]) closeStream(s, 'shutdown');
    },
    // 열린 SSE도 요청마다의 Host·Tailscale 사용자 검사를 따른다 (S3-34) — 연 때 통과했어도 지금 받지 않는 연결은 더 보내지 않고 닫는다
    recheckAccess() {
      const allow = access();
      let closed = 0;
      for (const s of [...streams]) {
        if (hostAllowed(s.host, allow.publicOrigin) && tailscaleLoginAllowed(s.tailscaleLogin, allow.tailscaleLogins)) continue;
        closeStream(s, 'access');
        closed++;
      }
      return closed;
    },
    dispose() {
      for (const off of unsubscribers.splice(0)) {
        try {
          off();
        } catch (error) {
          logger.error('토픽 구독 해제 실패', error);
        }
      }
      // 모은 접근 줄의 남은 수를 쓴다
      openAccess.flush();
      anonymousNotes.flush();
    },
    streamCount: () => streams.size,
    staticCacheStats: () => ({ gzipFiles: gzipCache.size, gzipBytes: gzipCache.bytes, tagFiles: tagCache.size }),
  };
}

/**
 * 대표용 HTTP 서버 하나 (리드 결정 S3-32): Node의 requestTimeout은 끄고(0 — 본문 시간은 HttpSurface가 길마다 본다) headersTimeout을 정해 둔다. Node가 요청을
 * 읽지 못하거나 머리 시간을 넘기면(clientError) 그 연결에 아직 응답을 쓰지 않았을 때만 408(시간 넘김)·431(머리가 너무 큼 — S3-38)·400(그 밖)과
 * InvokeResponse 본문을 쓰고 닫는다. 쓸 수 없는 연결은 바로 닫는다
 */
export function createSurfaceServer(surface: Pick<HttpSurface, 'handle'>, timeouts: Partial<HttpTimeouts> = {}): Server {
  const t: HttpTimeouts = { ...DEFAULT_HTTP_TIMEOUTS, ...timeouts };
  // 연결마다 지금 응답 — clientError가 응답을 쓰기 시작한 연결에 다른 응답을 끼워 넣지 않게
  const inFlight = new WeakMap<object, ServerResponse>();
  const server = createServer({ requestTimeout: 0, headersTimeout: t.headersMs, connectionsCheckingInterval: Math.min(30_000, t.headersMs) }, (req, res) => {
    inFlight.set(req.socket, res);
    res.once('close', () => {
      if (inFlight.get(req.socket) === res) inFlight.delete(req.socket);
    });
    // 응답을 다 보냈는데 본문이 아직 오는 요청(본문을 읽지 않고 답한 길)은 unreadBodyMs 뒤 끊는다 — Node의 requestTimeout이 하던 일을 그 길에만 한다.
    // 본문을 읽는 길(invoke·업로드)은 제 상한으로 끝낸다
    res.once('finish', () => {
      if (req.complete) return;
      const cut = setTimeout(() => {
        if (!req.complete) req.destroy();
      }, t.unreadBodyMs);
      cut.unref();
      req.once('end', () => clearTimeout(cut));
      req.once('close', () => clearTimeout(cut));
    });
    surface.handle(req, res);
  });
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (!socket.writable || inFlight.get(socket)?.headersSent) {
      socket.destroy();
      return;
    }
    const timedOut = error.code === 'ERR_HTTP_REQUEST_TIMEOUT' || error.code === 'ERR_HTTP_HEADERS_TIMEOUT';
    // 머리가 너무 크면 431 (S3-38) — 쿠키 단지가 차서 그럴 수 있어 사이트 쿠키를 지우라고 말한다
    const [status, payload] = timedOut
      ? (['408 Request Timeout', HTTP_ERRORS.requestTimeout] as const)
      : error.code === 'HPE_HEADER_OVERFLOW'
        ? (['431 Request Header Fields Too Large', HTTP_ERRORS.headersTooLarge] as const)
        : (['400 Bad Request', HTTP_ERRORS.badRequest] as const);
    const text = JSON.stringify(failResponse(payload));
    const head = [
      `HTTP/1.1 ${status}`,
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(text)}`,
      'Cache-Control: no-store',
      'X-Content-Type-Options: nosniff',
      'Connection: close',
    ].join('\r\n');
    socket.end(`${head}\r\n\r\n${text}`, () => socket.destroy());
  });
  return server;
}
