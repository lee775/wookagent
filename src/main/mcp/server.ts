/**
 * 앱 도구 서버 (MCP Streamable HTTP, 상태 없음) — CLI-07·08, ENV-02, LOG-01.
 *
 * ───────────── 실제로 오가는 내용 (모의 에이전트 작성용, @modelcontextprotocol/sdk 1.32.2에서 확인) ─────────────
 * 주소: http://127.0.0.1:<port>/mcp — POST만 받는다 (GET·DELETE 등 → 405, Allow: POST). 세션(Mcp-Session-Id) 없음.
 * 같은 리스너의 `/agent/v1/*`는 외부 에이전트 API다 (7단계 S7b, 리드 결정 S7-2 — 서버 모드가 mountAgentApi로 붙인다, 아래 Host 검사 뒤. 붙이지 않았으면 404).
 * 요청 헤더 (모든 POST):
 *   Host: 127.0.0.1:<port> 또는 localhost:<port>        그 밖 → 403
 *   Authorization: Bearer <턴 토큰>                      없음·모름·폐기 → 401
 *   Content-Type: application/json                       아니면 → 415 (SDK 영어 문구)
 *   Accept: application/json, text/event-stream          둘 다 있어야 함, 아니면 → 406 (SDK 영어 문구)
 *   MCP-Protocol-Version: 2025-06-18                     선택. 보내면 지원 목록 안이어야 함, 아니면 → 400
 * 본문 4MB까지(→ 413 — 넘친 본문도 버리며 끝까지 받은 뒤에 답한다). 응답은 언제나 Content-Type: application/json 한 덩어리(SSE 없음).
 * 상태가 없어 initialize 없이 tools/call만 보내도 된다. 아래는 실제 바이트 그대로(> 요청 본문, < 응답).
 *
 * ① initialize
 *   > {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"wook-mock","version":"1.0.0"}}}
 *   < 200 {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"wook","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
 *     (모르는 버전을 요청하면 protocolVersion "2025-11-25"로 답한다)
 * ② 알림 (id 없음)
 *   > {"jsonrpc":"2.0","method":"notifications/initialized"}
 *   < 202 (본문 없음)
 * ③ tools/list (선택) — 토큰 주인의 역할(rolesFor)에 맞는 도구만
 *   > {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 *   < 200 {"result":{"tools":[{"name":"get_work_context","description":"지금 맡은 업무의 …","inputSchema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{}},"execution":{"taskSupport":"forbidden"}}, …]},"jsonrpc":"2.0","id":2}
 * ④ tools/call — 성공: text = 처리기 data의 JSON 문자열
 *   > {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"complete_step","arguments":{"step_index":0,"note":"완료","request_id":"rq-1"}}}
 *   < 200 {"result":{"content":[{"type":"text","text":"{\"tool\":\"complete_step\",\"step\":0,\"done\":true}"}]},"jsonrpc":"2.0","id":3}
 *   거부·실패: HTTP는 200, result.isError=true, text = {"error":코드,"message":한국어 사유}
 *   > {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"complete_step","arguments":{"step_index":-1}}}
 *   < 200 {"result":{"content":[{"type":"text","text":"{\"error\":\"invalid\",\"message\":\"입력값이 올바르지 않습니다 — step_index: 0 이상이어야 합니다\"}"}],"isError":true},"jsonrpc":"2.0","id":4}
 *   코드: forbidden(역할 밖 도구) · invalid(입력 검사 실패) · not_found(없는 도구) · error(처리 중 예외) ·
 *         stopped(서버 종료 중) · seat_changed(메인 자리가 바뀐 뒤의 이전 세대 메인 토큰, 리드 결정 S4-4) · 그 밖에 처리기가 돌려준 conflict 등,
 *         화면 조작의 unavailable·stale_capture·rate_limited·human_active·secret_blocked·denied_target (목록 하나: types.ts TOOL_FAILURE_CODES, 리드 결정 S6-3)
 *   화면 도구(screen_capture·gui_input의 then_capture·get_screen_check)는 글 블록 뒤에 이미지 블록을 붙인다 (리드 결정 S6-3·S6-6):
 *   < {"result":{"content":[{"type":"text","text":"{\"capture_id\":\"SC-000001\",…}"},{"type":"image","data":"<PNG base64>","mimeType":"image/png"}]},…}
 *   이미지는 PNG 4MiB까지 두 장까지 — 기록(onCall)에는 넘기지 않는다
 * ⑤ HTTP 단계 거부 — JSON-RPC 오류 본문
 *   < 401 WWW-Authenticate: Bearer realm="wook" {"jsonrpc":"2.0","error":{"code":-32001,"message":"Authorization: Bearer <토큰> 헤더가 없습니다"},"id":null}
 *     (모르는·폐기된 토큰은 error="invalid_token", Bearer 형식이 아니면 error="invalid_request"를 붙이고 사유가 다르다.
 *      인증은 머리만 보고 본문을 읽기 전에 정한다 — 본문은 풀지 않고 읽어 버리므로 id는 늘 null)
 *   < 429 Retry-After: <초> — 인증하지 못한 요청이 이 리스너 전체(/mcp와 /agent/v1)에서 1분에 120번을 넘음 (리드 결정 S7-3·S7-17 A1)
 *   < 403·404·405·413 {"jsonrpc":"2.0","error":{"code":-32000,"message":"…"},"id":null},  JSON 아님 400 → code -32700
 * 묶음(배열) 요청도 받는다: 응답은 같은 순서의 배열. 없는 메서드는 {"jsonrpc":"2.0","id":n,"error":{"code":-32601,"message":"Method not found"}}.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * 기록(onCall): 살아 있는 토큰의 tools/call은 결과와 관계없이 모두 남긴다. 인증하지 못한 요청(401·429)과 Host 거부(403)는 onCall로 넘기지 않는다 — DB(활동
 * 기록)에 한 줄도 쓰지 않고, 종류마다 1분 창에 한 줄(창의 첫 줄과 나머지 수)로 log에 모은다 (리드 결정 S7-3 '요청마다 쓰지 않는다'·S7-17 A1 — 인증 없는 요청
 * 하나가 DB를 채우지 못하게). 다만 이 실행에서 폐기한 토큰(끝난 턴의 것 — 최근 1,024개의 주인을 기억한다)으로 다시 온 요청은 그 턴의 신원으로 요청마다 한 줄을
 * 남긴다(메시지 수와 함께 — 메시지마다가 아니다). 토큰은 32바이트 무작위라 그 턴의 CLI 밖에서는 이 길을 쓰지 못한다. GET·OAuth 탐색 같은 404/405와
 * initialize·tools/list 성공은 남기지 않는다.
 * 외부 에이전트의 턴 토큰은 쓰기 직전에 beforeExternal(임대 만료 보기)을 부르고 다시 찾는다 (리드 결정 S7-17 F4).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AGENT_RATE_UNAUTHENTICATED } from '../../server/agentApiTypes';
import { collapsedLog } from '../../server/logCollapse';
import { TOOL_SPECS, rolesFor, type ToolRole, type ToolSpec } from './catalog';
import {
  TOOL_FAILURE_CODES,
  type AppToolServer,
  type AppToolServerOptions,
  type ListenerHandler,
  type TokenIdentity,
  type ToolCallLog,
  type ToolCallResult,
  type ToolImage,
  type UnauthenticatedBudget,
} from './types';

const MCP_PATH = '/mcp';
/** 에이전트 API의 경로 앞부분 (리드 결정 S7-2) — 같은 리스너에 붙는다 */
const AGENT_PREFIX = '/agent/v1';
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * 4MB를 넘는 본문도 이만큼까지는 버리며 끝까지 받은 뒤 413으로 답한다. 다 받기 전에 답하고 연결을 닫으면 아직 보내는 중인 클라이언트 쪽으로
 * 연결이 끊겨(읽지 않은 본문이 남은 소켓을 닫으면 RST) 클라이언트가 413을 읽지 못하고 ECONNRESET을 받는다. 이보다 크면 받지 않고 끊는다
 */
const DRAIN_MAX_BYTES = 64 * 1024 * 1024;
/** stop()이 진행 중인 처리기 호출(DB 저장 등)을 기다리는 최대 시간 */
const STOP_WAIT_MS = 5_000;
const SERVER_INFO = { name: 'wook', version: '0.1.0' };
const MAX_ISSUES_SHOWN = 8;
/** 도구 결과 이미지 한 장의 상한 (PNG 4MiB — 리드 결정 S6-6). base64 글 길이로 본다 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_B64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGES = 2;
/** 인증하지 못한 요청 몫의 창 (리드 결정 S7-3 — 1분에 AGENT_RATE_UNAUTHENTICATED번, /mcp와 /agent/v1이 함께) */
const UNAUTH_WINDOW_MS = 60_000;
/** 주인을 기억하는 폐기한 토큰 수 (끝난 턴의 토큰으로 다시 온 요청의 거부 기록) */
const REVOKED_KEPT = 1024;
/**
 * 인증 전에 주는 답(Host 거부 403, 404/405, 401, 429, hello의 400/413)이 읽는 본문의 상한 (리드 결정 S7-22 S3) — 이만큼까지만 읽어 버리고, 더 오면 읽기를 멈추고
 * 답을 보낸 뒤 연결을 끊는다. 인증한 요청은 이 상한을 쓰지 않는다
 */
export const PRE_AUTH_READ_MAX_BYTES = 64 * 1024;
/** 인증 전의 답을 보낸 뒤 (읽지 않고) 소켓을 없애기까지 기다리는 시간 — 상대가 답을 읽을 틈 (answerAndClose) */
const PRE_AUTH_LINGER_MS = 2_000;
/**
 * 이 리스너가 요청 하나를 다 받는 시간과 머리를 받는 시간의 상한 (리드 결정 S7-22 S3) — 받는 시간만 잰다: 다 받은 요청의 답이 오래 걸리는 것(롱폴·느린 도구)은
 * 상관없다. 넘으면 Node가 408로 답하고 연결을 닫는다. 시험이 줄인다(AppToolServerOptions.timeouts)
 */
export const LISTENER_REQUEST_TIMEOUT_MS = 30_000;
export const LISTENER_HEADERS_TIMEOUT_MS = 10_000;
/** 위 상한을 보는 간격 — Node 기본(30초)이면 상한보다 30초까지 늦게 끊는다 */
const LISTENER_CHECK_INTERVAL_MS = 1_000;

const RPC_UNAUTHORIZED = -32001;
const RPC_SERVER_ERROR = -32000;
const RPC_PARSE_ERROR = -32700;
const RPC_INTERNAL_ERROR = -32603;
/** 모르거나 폐기된 턴 토큰의 401 사유 */
const INVALID_TOKEN = '토큰이 유효하지 않거나 이미 폐기되었습니다 (턴이 끝났을 수 있습니다)';

type ToolFailure = Extract<ToolCallResult, { ok: false }>;
type ErrorCode = ToolFailure['code'];
type RpcId = string | number;
type ArgsSchema = z.ZodObject<z.ZodRawShape>;

/** 도구 목록 공개(tools/list)와 입력 검사에 같은 스키마 객체를 쓴다 */
const TOOLS: readonly { spec: ToolSpec; schema: ArgsSchema }[] = (TOOL_SPECS as readonly ToolSpec[]).map((spec) => ({
  spec,
  schema: z.object(spec.input),
}));
const SCHEMA_BY_NAME: ReadonlyMap<string, ArgsSchema> = new Map(TOOLS.map((t) => [t.spec.name, t.schema]));

const ROLE_LABELS: Record<ToolRole, string> = {
  main: '메인 에이전트',
  producer: '프로듀서',
  member: '팀원',
  reviewer: '검수 권한',
};

export function createAppToolServer(opts: AppToolServerOptions): AppToolServer {
  /** sha256(토큰) → 주인. 원문 토큰은 키로도 들고 있지 않는다 */
  const tokens = new Map<string, TokenIdentity>();
  /**
   * 이 실행에서 폐기한 토큰의 주인 (sha256 → 주인, 최근 REVOKED_KEPT개 — 리드 결정 S7-17 A1): 끝난 턴의 토큰으로 다시 온 요청은 모르는 토큰과 달리 그 턴의 거부로
   * 요청마다 한 줄(메시지 수와 함께)을 남긴다 — 끝난 턴의 CLI가 아직 부르고 있다는 사실이다. 토큰은 32바이트 무작위라 모르는 쪽이 이 길을 쓸 수 없다
   */
  const revoked = new Map<string, TokenIdentity>();
  const forget = (key: string): void => {
    const identity = tokens.get(key);
    if (!identity) return;
    tokens.delete(key);
    revoked.delete(key);
    revoked.set(key, identity);
    while (revoked.size > REVOKED_KEPT) revoked.delete(revoked.keys().next().value as string);
  };
  const inflight = new Set<Promise<unknown>>();
  let http: HttpServer | null = null;
  let url: string | null = null;
  let port: number | null = null;
  let allowedHosts: ReadonlySet<string> = new Set();
  let startPromise: Promise<{ url: string; port: number }> | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopping = false;
  /** 붙인 에이전트 API 처리기 (서버 모드, 리드 결정 S7-2) — 없으면 그 길은 404 */
  let agentApi: ListenerHandler | null = null;

  /**
   * 이 리스너의 인증하지 못한 요청 몫 (리드 결정 S7-3·S7-17 A1) — /mcp의 401과 붙인 에이전트 API의 401이 함께 센다(처리기에 셋째 인자로 넘긴다).
   * 맞는 키·살아 있는 토큰의 요청은 세지 않는다
   */
  const unauthenticated: UnauthenticatedBudget = (() => {
    let start = 0;
    let count = 0;
    return {
      hit(): number | null {
        const t = Date.now();
        if (t - start >= UNAUTH_WINDOW_MS) {
          start = t;
          count = 0;
        }
        count += 1;
        if (count <= AGENT_RATE_UNAUTHENTICATED) return null;
        return Math.max(1, Math.ceil((start + UNAUTH_WINDOW_MS - t) / 1000));
      },
    };
  })();

  /**
   * 거부 기록 (리드 결정 S7-17 A1): 인증하지 못한 요청·몫을 넘은 요청·Host 거부는 DB에 쓰지 않고, 종류마다 1분 창에 한 줄(첫 줄은 바로, 나머지는 창이 끝날 때 수로)만
   * 기록 파일에 쓴다 — 에이전트 API(agentApi.ts)와 같은 방식
   */
  const refusals = collapsedLog<'unauthorized' | 'rate_limited' | 'host'>({
    windowMs: UNAUTH_WINDOW_MS,
    write: (text) => {
      try {
        opts.log?.(text);
      } catch (err) {
        console.error('[앱 도구 서버] 거부 기록(log)에서 오류가 났습니다', err);
      }
    },
    summary: (kind, extra, span) =>
      kind === 'unauthorized'
        ? `앱 도구 서버(${MCP_PATH}): 인증하지 못한 요청이 지난 ${span} 동안 ${extra}번 더 있었습니다 (모두 401, 본문을 풀지 않고 처리하지 않음)`
        : kind === 'rate_limited'
          ? `앱 도구 서버(${MCP_PATH}): 인증하지 못한 요청의 몫(1분에 ${AGENT_RATE_UNAUTHENTICATED}번)을 넘은 요청이 지난 ${span} 동안 ${extra}번 더 있었습니다 (모두 429)`
          : `앱 도구 서버: 허용되지 않은 Host 헤더의 요청이 지난 ${span} 동안 ${extra}번 더 있었습니다 (모두 403)`,
  });

  /**
   * 토큰의 주인 — 모르거나 폐기됐으면 null. 외부 에이전트의 토큰이면 쓰기 직전에 그 임대의 만료를 보게 하고(beforeExternal — 끝났으면 토큰이 거둬진다) 다시 찾는다
   * (리드 결정 S7-17 F4). beforeExternal이 던지면 그대로 던진다 — 임대를 확인하지 못한 토큰을 받지 않는다(부른 쪽이 500)
   */
  function liveIdentity(token: string | null): TokenIdentity | null {
    if (token === null) return null;
    const key = tokenKey(token);
    const identity = tokens.get(key) ?? null;
    if (identity === null || !identity.externalAgentId || !opts.beforeExternal) return identity;
    opts.beforeExternal(identity);
    return tokens.get(key) ?? null;
  }

  function emit(log: ToolCallLog): void {
    try {
      opts.onCall(log);
    } catch (err) {
      // 기록 실패를 도구 오류로 바꾸면 이미 반영된 처리를 에이전트가 다시 시도한다
      console.error('[앱 도구 서버] 호출 기록(onCall)에서 오류가 났습니다', err);
    }
  }

  // ───────── HTTP 단계 ─────────

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = performance.now();
    const at = new Date().toISOString();

    // 인증 전의 거부(Host 403·404·405)는 본문을 64KB까지만 읽어 버린 뒤 답하고 연결을 끊는다 (리드 결정 S7-22 S3 — 예전에는 Node가 남은 본문을 끝까지 받아 버렸다)
    const refuseNow = async (send: (headers: Record<string, string>) => void): Promise<void> => {
      if ((await readBeforeAuth(req)).kind === 'aborted') return;
      answerAndClose(res, send);
    };

    const host = req.headers.host;
    if (host === undefined || !allowedHosts.has(host.toLowerCase())) {
      // DNS 리바인딩 방지: 루프백 주소로 들어왔어도 Host가 다른 이름이면 받지 않는다. DB에는 쓰지 않는다 — 1분 창에 한 줄 (리드 결정 S7-17 A1)
      const message = `허용되지 않은 Host 헤더입니다 (${clip(host ?? '없음', 120)}). 앱 도구 서버는 이 PC 안(${HOST})에서만 받습니다`;
      refusals.log('host', `앱 도구 서버: 허용되지 않은 Host 헤더(${clip(host ?? '없음', 120)})의 요청을 403으로 거부함 — 같은 1분 동안의 나머지는 한 줄로 모읍니다`);
      await refuseNow((h) => sendJson(res, 403, rpcError(null, RPC_SERVER_ERROR, message), h));
      return;
    }

    const path = (req.url ?? '').split('?')[0]!;
    // 에이전트 API (리드 결정 S7-2·S7-3) — 같은 루프백 리스너, Host 검사 뒤. 서버 모드만 붙인다: 붙이지 않은 리스너(데스크톱 앱)는 404.
    // 인증하지 못한 요청의 몫은 이 리스너 하나다 — 처리기에 넘긴다 (S7-17 A1)
    if (path === AGENT_PREFIX || path.startsWith(`${AGENT_PREFIX}/`)) {
      if (agentApi) {
        await agentApi(req, res, unauthenticated);
        return;
      }
      await refuseNow((h) => sendJson(res, 404, { ok: false, error: { code: 'not_found', message: '에이전트 API는 서버 모드에서만 열립니다 — 이 앱에는 없습니다' } }, h));
      return;
    }
    if (path !== MCP_PATH) {
      await refuseNow((h) => sendJson(res, 404, rpcError(null, RPC_SERVER_ERROR, `알 수 없는 경로입니다 (${clip(path, 120)}). 앱 도구 주소는 ${MCP_PATH} 입니다`), h));
      return;
    }
    if (req.method !== 'POST') {
      // 상태 없는 서버라 SSE(GET)·세션 종료(DELETE)가 없다. SDK 클라이언트는 GET의 405를 "SSE 없음"으로 받아들인다
      await refuseNow((h) => sendJson(res, 405, rpcError(null, RPC_SERVER_ERROR, `이 서버는 POST만 받습니다 (${clip(req.method ?? '', 20)})`), { Allow: 'POST', ...h }));
      return;
    }

    const authorization = req.headers.authorization;
    const token = bearerToken(authorization);
    // 인증은 머리만 보고 본문을 읽기 전에 정한다 (리드 결정 S7-17 A1) — 모르는 토큰의 본문은 풀지도, 메시지마다 적지도 않는다
    const atHeaders = liveIdentity(token);
    if (atHeaders === null) {
      const retry = unauthenticated.hit();
      const known = token === null ? null : (revoked.get(tokenKey(token)) ?? null);
      await refuseUnauthenticated(req, res, token, authorization, retry, known, t0, at);
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body.kind === 'aborted') return; // 본문을 보내는 중 연결이 끊김 — 응답 받을 상대가 없다
    // 본문을 받는 사이 폐기된 토큰도 거부되도록 다 받은 뒤 다시 확인한다 (머리에서 이미 인증한 요청이라 몫은 세지 않는다). 아는 턴이라 그 턴의 거부 한 줄을 남긴다
    const identity = liveIdentity(token);
    if (identity === null) {
      refusals.log('unauthorized', `앱 도구 서버(${MCP_PATH}): 본문을 받는 사이 폐기된 토큰의 요청을 401로 거부함 — 같은 1분 동안의 나머지는 한 줄로 모읍니다`);
      noteRevokedCall(atHeaders, body, `본문이 ${MAX_BODY_BYTES / 1024 / 1024}MB를 넘음`, t0, at);
      sendJson(res, 401, rpcError(null, RPC_UNAUTHORIZED, INVALID_TOKEN), {
        'WWW-Authenticate': 'Bearer realm="wook", error="invalid_token"',
        ...(body.kind === 'too_large' ? { Connection: 'close' } : {}),
      });
      return;
    }

    if (body.kind === 'too_large') {
      sendJson(res, 413, rpcError(null, RPC_SERVER_ERROR, `요청 본문이 너무 큽니다 (최대 ${MAX_BODY_BYTES / 1024 / 1024}MB)`), {
        Connection: 'close',
      });
      return;
    }
    const parsed = tryParseJson(body.text);
    if (parsed === undefined) {
      sendJson(res, 400, rpcError(null, RPC_PARSE_ERROR, '요청 본문을 JSON으로 해석할 수 없습니다'));
      return;
    }
    await serveMcp(identity, req, res, parsed, t0, at);
  }

  /**
   * 인증하지 못한 /mcp 요청의 답 (리드 결정 S7-3·S7-17 A1·S7-22 S3): 몫을 넘었으면(retry) 429와 Retry-After, 아니면 401. 처리기는 부르지 않는다. 모르는 토큰·토큰
   * 없음은 DB에 아무것도 쓰지 않고 1분 창에 한 줄만 기록하며, 본문은 풀지 않는다. 본문은 64KB까지만 읽어 버린 뒤 답하고 연결을 끊는다(Connection: close — 더 오는
   * 본문은 받지 않는다). 이 실행에서 폐기한 토큰(known — 끝난 턴의 것)이면 64KB 안의 본문을 풀어 그 턴의 거부 한 줄을 요청마다 남긴다(메시지 수와 함께). 몫을 넘은
   * 요청은 줄도 남기지 않는다
   */
  async function refuseUnauthenticated(
    req: IncomingMessage,
    res: ServerResponse,
    token: string | null,
    authorization: string | undefined,
    retry: number | null,
    known: TokenIdentity | null,
    t0: number,
    at: string,
  ): Promise<void> {
    const remembered = known !== null && retry === null;
    const drained = await readBeforeAuth(req, remembered ? PRE_AUTH_READ_MAX_BYTES : 0);
    if (drained.kind === 'aborted') return;
    if (retry !== null) {
      refusals.log('rate_limited', `앱 도구 서버(${MCP_PATH}): 인증하지 못한 요청이 1분에 ${AGENT_RATE_UNAUTHENTICATED}번을 넘어 429로 답함 — 같은 창의 나머지는 한 줄로 모읍니다`);
      answerAndClose(res, (h) => sendJson(res, 429, rpcError(null, RPC_SERVER_ERROR, `인증하지 못한 요청이 너무 많습니다 — ${retry}초 뒤에 다시 하세요`), { 'Retry-After': String(retry), ...h }));
      return;
    }
    if (remembered) noteRevokedCall(known, drained, `본문이 ${PRE_AUTH_READ_MAX_BYTES / 1024}KB를 넘어 읽지 않음`, t0, at);
    const [message, challenge, cause] =
      token !== null
        ? [INVALID_TOKEN, 'Bearer realm="wook", error="invalid_token"', '모르거나 폐기된 토큰']
        : authorization === undefined
          ? ['Authorization: Bearer <토큰> 헤더가 없습니다', 'Bearer realm="wook"', 'Authorization 헤더 없음']
          : ['Authorization 헤더가 "Bearer <토큰>" 형식이 아닙니다', 'Bearer realm="wook", error="invalid_request"', 'Bearer 형식이 아님'];
    refusals.log('unauthorized', `앱 도구 서버(${MCP_PATH}): 인증하지 못한 요청을 401로 거부함 (${cause}) — 같은 1분 동안의 나머지는 한 줄로 모읍니다`);
    answerAndClose(res, (h) => sendJson(res, 401, rpcError(null, RPC_UNAUTHORIZED, message), { 'WWW-Authenticate': challenge, ...h }));
  }

  /**
   * 끝난 턴(이 실행에서 폐기한 토큰)으로 다시 온 요청의 거부 한 줄 (리드 결정 S7-17 A1) — 요청마다 한 줄이고, 메시지마다 쓰지 않는다. 하나짜리 tools/call이면 그 도구
   * 이름과 인자, 아니면 JSON-RPC 메서드나 '(메시지 n개)'. 사유에 그 턴과 메시지 수를 넣는다
   */
  function noteRevokedCall(identity: TokenIdentity, body: BodyResult | PreAuthBody, overText: string, t0: number, at: string): void {
    const parsed = body.kind === 'ok' ? tryParseJson(body.text) : undefined;
    const count = parsed === undefined ? null : messagesOf(parsed).length;
    const single = parsed !== undefined && !Array.isArray(parsed) ? toolCallOf(parsed) : null;
    const tool = single?.tool ?? (isRecord(parsed) && typeof parsed.method === 'string' ? clip(parsed.method, 200) : `(메시지 ${count ?? '?'}개)`);
    const what = body.kind === 'too_large' ? overText : count === null ? '본문이 JSON이 아님' : `메시지 ${count}개`;
    emit({
      at,
      identity,
      tool,
      args: single?.args ?? {},
      result: { ok: false, code: 'unauthorized', message: `${INVALID_TOKEN} — 끝난 턴 ${identity.turnId}의 토큰입니다 (${what})` },
      durationMs: since(t0),
    });
  }

  // ───────── MCP 단계: 요청마다 새 McpServer·전송 계층 (토큰 주인별로 공개 도구가 다르다) ─────────

  /** 그 호출자에게 보일 도구 설명 (리드 결정 S6-6) — 설명 함수가 던지면 카탈로그 글 그대로 */
  function describeFor(identity: TokenIdentity, spec: ToolSpec): string {
    if (!opts.describe) return spec.description;
    try {
      return opts.describe(identity, spec);
    } catch (err) {
      console.error('[앱 도구 서버] 도구 설명(describe)에서 오류가 났습니다', err);
      return spec.description;
    }
  }

  async function serveMcp(identity: TokenIdentity, req: IncomingMessage, res: ServerResponse, body: unknown, t0: number, at: string): Promise<void> {
    if (res.destroyed) return;
    const roles = rolesFor(identity);
    const visible = TOOLS.filter((t) => t.spec.roles.some((r) => roles.includes(r)));
    const visibleNames: ReadonlySet<string> = new Set(visible.map((t) => t.spec.name));
    const calls = collectToolCalls(body);
    const handled = new Set<RpcId>();

    const mcp = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
    for (const { spec, schema } of visible) {
      mcp.registerTool(spec.name, { description: describeFor(identity, spec), inputSchema: schema }, (args) =>
        callTool(identity, roles, visibleNames, spec.name, args),
      );
    }
    // tools/call은 직접 처리한다. SDK 기본 처리는 입력 검사 실패·목록 밖 도구를 영어 문구 isError로 돌려줘
    // 계약({error, message} JSON·한국어 사유·forbidden 구분)과 다르다. 위 등록은 tools/list 공개에 쓰인다.
    mcp.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      handled.add(extra.requestId);
      return callTool(identity, roles, visibleNames, request.params.name, request.params.arguments);
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const closed = new Promise<'closed'>((resolve) => res.once('close', () => resolve('closed')));
    try {
      await mcp.connect(transport);
      const handling = transport.handleRequest(req, res, body);
      // 응답 전에 연결이 끊기면 SDK의 JSON 응답 대기가 끝나지 않으므로 연결 종료와 경주시킨다
      const first = await Promise.race([handling.then(() => 'handled' as const), closed]);
      if (first === 'closed') {
        handling.catch((err: unknown) => console.error('[앱 도구 서버] 연결이 끊긴 뒤 MCP 응답 처리 실패', err));
      }
    } finally {
      await mcp.close();
    }

    // SDK가 요청 형식(params) 검사에서 먼저 거부해 처리기까지 오지 않은 tools/call도 기록한다
    for (const [id, call] of calls) {
      if (handled.has(id)) continue;
      emit({
        at,
        identity,
        tool: call.tool,
        args: call.args,
        result: fail('invalid', 'tools/call 요청 형식이 올바르지 않아 처리하지 않았습니다 (params.name·params.arguments 확인)'),
        durationMs: since(t0),
      });
    }
  }

  async function callTool(
    identity: TokenIdentity,
    roles: readonly ToolRole[],
    visibleNames: ReadonlySet<string>,
    name: string,
    rawArgs: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { result, text } = await runCall(identity, roles, visibleNames, name, rawArgs);
    // 기록(onCall)에는 이미지를 넘기지 않는다 — 바이트가 활동 기록·로그에 닿지 않게 (리드 결정 S6-7)
    const images = result.ok ? (result.images ?? []) : [];
    if (result.ok && text !== null) {
      // 글 블록이 먼저, 이미지는 그 뒤 (리드 결정 S6-3) — 이미지를 버리는 클라이언트도 capture_id가 든 글은 받는다
      return { content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))] };
    }
    const failure = result.ok ? fail('error', '도구 결과를 만들지 못했습니다') : result;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure.code, message: failure.message }) }] };
  }

  /**
   * 도구 호출 한 번 — 입력 검사·역할·처리기·기록(onCall)까지. MCP tools/call(callTool)과 에이전트 API의 REST 도구 길(callToolByToken, 리드 결정 S7-2)이 같은
   * 길이다. text: 성공한 결과의 JSON 글 (만들지 못했으면 결과가 error로 바뀐다)
   */
  async function runCall(
    identity: TokenIdentity,
    roles: readonly ToolRole[],
    visibleNames: ReadonlySet<string>,
    name: string,
    rawArgs: Record<string, unknown> | undefined,
  ): Promise<{ result: ToolCallResult; text: string | null }> {
    const t0 = performance.now();
    const at = new Date().toISOString();
    let args: Record<string, unknown> = rawArgs ?? {};
    let result: ToolCallResult;
    let text: string | null = null;

    const schema = SCHEMA_BY_NAME.get(name);
    if (schema === undefined) {
      result = fail('not_found', `'${clip(name, 80)}' 도구는 없습니다`);
    } else if (!visibleNames.has(name)) {
      result = fail('forbidden', `'${name}' 도구는 이 세션의 역할(${roles.map((r) => ROLE_LABELS[r]).join(', ')})로 쓸 수 없습니다`);
    } else if (stopping) {
      result = fail('stopped', '프로그램이 앱 도구 서버를 종료하는 중이라 처리하지 않았습니다. 턴을 마치세요');
    } else {
      const parsed = schema.safeParse(args, { error: koreanIssueMessage });
      if (!parsed.success) {
        result = fail('invalid', formatIssues(parsed.error.issues));
      } else {
        args = parsed.data;
        result = await runHandler(identity, name, args);
        if (result.ok) {
          text = toJsonText(result.data);
          if (text === null) result = fail('error', '도구 결과를 JSON으로 바꿀 수 없습니다 (처리기 결과 형식 오류)');
        }
      }
    }

    // 기록(onCall)에는 이미지를 넘기지 않는다 — 바이트가 활동 기록·로그에 닿지 않게 (리드 결정 S6-7)
    emit({ at, identity, tool: clip(name, 200), args, result: result.ok ? { ok: true, data: result.data } : result, durationMs: since(t0) });
    return { result, text };
  }

  /**
   * 에이전트 API의 REST 도구 길 (`POST /agent/v1/tool/{name}`, 리드 결정 S7-2): 턴 토큰으로 MCP tools/call과 같은 길을 탄다 — 그 토큰 주인의 역할로 보이는
   * 도구만, 같은 입력 검사·처리기·기록. 토큰이 죽었으면 null (부른 쪽이 401). 인자가 객체가 아니면 invalid
   */
  async function callToolByToken(token: string, name: string, args: unknown): Promise<ToolCallResult | null> {
    // 외부 에이전트의 토큰은 그 임대가 끝났는지 먼저 본다 — MCP 길과 같다 (리드 결정 S7-17 F4)
    const identity = typeof token === 'string' ? liveIdentity(token) : null;
    if (identity === null) return null;
    const roles = rolesFor(identity);
    const visibleNames: ReadonlySet<string> = new Set(TOOLS.filter((t) => t.spec.roles.some((r) => roles.includes(r))).map((t) => t.spec.name));
    if (args !== undefined && args !== null && !isRecord(args)) {
      const result = fail('invalid', '도구 인자는 JSON 객체여야 합니다');
      emit({ at: new Date().toISOString(), identity, tool: clip(name, 200), args: {}, result, durationMs: 0 });
      return result;
    }
    const { result, text } = await runCall(identity, roles, visibleNames, name, (args ?? undefined) as Record<string, unknown> | undefined);
    if (result.ok && text === null) return fail('error', '도구 결과를 만들지 못했습니다');
    return result;
  }

  async function runHandler(identity: TokenIdentity, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const run = (async (): Promise<ToolCallResult> => {
      try {
        return normalizeResult(await opts.handler(identity, name, args));
      } catch (err) {
        return fail('error', `도구 처리 중 오류가 발생했습니다: ${clip(errorText(err), 1000)}`);
      }
    })();
    inflight.add(run);
    try {
      return await run;
    } finally {
      inflight.delete(run);
    }
  }

  // ───────── 시작·종료 ─────────

  async function start(): Promise<{ url: string; port: number }> {
    if (stopPromise) await stopPromise;
    if (http !== null && url !== null && port !== null) return { url, port };
    if (startPromise === null) {
      startPromise = listen().finally(() => {
        startPromise = null;
      });
    }
    return startPromise;
  }

  function listen(): Promise<{ url: string; port: number }> {
    const wanted = opts.port ?? 0;
    // 요청 하나를 받는 시간과 머리를 받는 시간의 상한을 정해 둔다 (리드 결정 S7-22 S3 — Node 기본은 300초·60초). 받는 시간만 잰다: 다 받은 요청의 답(롱폴·느린 도구)은
    // 상관없다. 넘으면 Node가 408로 답하고 연결을 닫는다. 머리 상한은 요청 상한보다 길 수 없다
    const requestTimeout = opts.timeouts?.requestMs ?? LISTENER_REQUEST_TIMEOUT_MS;
    const headersTimeout = Math.min(opts.timeouts?.headersMs ?? LISTENER_HEADERS_TIMEOUT_MS, requestTimeout);
    const server = createServer({ requestTimeout, headersTimeout, connectionsCheckingInterval: Math.min(LISTENER_CHECK_INTERVAL_MS, headersTimeout) }, (req, res) => {
      onRequest(req, res).catch((err: unknown) => {
        console.error('[앱 도구 서버] 요청 처리 중 예기치 않은 오류', err);
        if (!res.headersSent) sendJson(res, 500, rpcError(null, RPC_INTERNAL_ERROR, '앱 도구 서버 내부 오류가 발생했습니다'));
        else res.destroy();
      });
    });
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        reject(new Error(`앱 도구 서버를 ${HOST}:${wanted}에서 시작하지 못했습니다 (${err.code ?? err.message})`, { cause: err }));
      };
      const onListening = (): void => {
        server.off('error', onError);
        server.on('error', (err) => console.error('[앱 도구 서버] 서버 오류', err));
        const actual = (server.address() as AddressInfo).port;
        const hosts = new Set([`${HOST}:${actual}`, `localhost:${actual}`]);
        if (actual === 80) hosts.add(HOST).add('localhost');
        http = server;
        port = actual;
        url = `http://${HOST}:${actual}${MCP_PATH}`;
        allowedHosts = hosts;
        resolve({ url, port: actual });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        // 루프백만 (ENV-02). 다른 기기에서 접속할 통로를 열지 않는다
        server.listen({ host: HOST, port: wanted });
      } catch (err) {
        // 잘못된 포트 값은 이벤트가 아니라 즉시 예외로 온다
        server.off('error', onError);
        server.off('listening', onListening);
        reject(new Error(`앱 도구 서버를 ${HOST}:${wanted}에서 시작하지 못했습니다 (${errorText(err)})`, { cause: err }));
      }
    });
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    if (startPromise) {
      // 시작 중이면 끝난 뒤 닫는다. 시작 실패는 start() 호출자가 받는다
      await startPromise.then(
        () => undefined,
        () => undefined,
      );
    }
    const server = http;
    if (server === null) return;
    stopping = true;
    url = null;
    port = null;
    stopPromise = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          // close()의 오류는 이미 닫힌 서버(ERR_SERVER_NOT_RUNNING)일 때뿐이라 아래 정리는 그대로 맞다
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        });
        await waitInflight();
      } finally {
        // 모아 둔 거부 기록의 남은 수를 쓴다 (리드 결정 S7-17 A1)
        refusals.flush();
        http = null;
        allowedHosts = new Set();
        // 다시 열면 새 턴 토큰부터 받는다 — 앞 실행의 폐기 기억도 버린다
        tokens.clear();
        revoked.clear();
      }
    })().finally(() => {
      stopping = false;
      stopPromise = null;
    });
    return stopPromise;
  }

  async function waitInflight(): Promise<void> {
    if (inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_WAIT_MS);
    });
    try {
      await Promise.race([Promise.allSettled([...inflight]).then(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    start,
    stop,
    get url() {
      return url;
    },
    get baseUrl() {
      return port !== null ? `http://${HOST}:${port}` : null;
    },
    identityOf(token: string): TokenIdentity | null {
      return typeof token === 'string' ? (tokens.get(tokenKey(token)) ?? null) : null;
    },
    callTool: callToolByToken,
    mountAgentApi(handler) {
      agentApi = handler;
    },
    issueToken(identity: TokenIdentity): string {
      // 턴 토큰은 CLI 턴·외부 턴 모두 `wtt_` + 32바이트 base64url — 가리개의 모양 규칙이 등록 전·밖의 글에서도 알아본다 (리드 결정 S7-3, AC-20)
      const token = `wtt_${randomBytes(32).toString('base64url')}`;
      tokens.set(tokenKey(token), Object.freeze({ ...identity }));
      return token;
    },
    // 폐기한 토큰의 주인은 잠깐 기억한다 — 끝난 턴의 토큰으로 다시 온 요청의 거부 기록 (forget, 리드 결정 S7-17 A1)
    revokeToken(token: string): void {
      forget(tokenKey(token));
    },
    revokeTurn(turnId: string): void {
      for (const [key, identity] of [...tokens]) {
        if (identity.turnId === turnId) forget(key);
      }
    },
    revokeWhere(pred: (identity: TokenIdentity) => boolean): number {
      let n = 0;
      for (const [key, identity] of [...tokens]) {
        if (!pred(identity)) continue;
        forget(key);
        n += 1;
      }
      return n;
    },
  };
}

// ───────── 도움 함수 ─────────

function tokenKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1] : null;
}

function fail(code: ErrorCode, message: string): ToolFailure {
  return { ok: false, code, message };
}

/** 거부 코드 — 계약 목록 하나(TOOL_FAILURE_CODES, 리드 결정 S6-3). 모르는 코드는 error */
const ERROR_CODES: ReadonlySet<string> = new Set<string>(TOOL_FAILURE_CODES);

/** 이미지 하나가 계약에 맞는지 — PNG base64, 4MiB 안 */
function validImage(v: unknown): v is ToolImage {
  if (!isRecord(v) || v.mimeType !== 'image/png' || typeof v.data !== 'string') return false;
  return v.data.length > 0 && v.data.length <= MAX_IMAGE_B64 && /^[A-Za-z0-9+/]+={0,2}$/.test(v.data);
}

/** 처리기 결과를 계약 모양으로 맞춘다 (JS 쪽 실수가 SDK 결과 검증 오류로 번지지 않게) */
function normalizeResult(value: ToolCallResult): ToolCallResult {
  const v: unknown = value;
  if (isRecord(v)) {
    if (v.ok === true) {
      // 이미지(화면 캡처·시험 이미지)는 계약에 맞는 것만, 두 장까지 — 틀린 것은 버린다(글 블록은 그대로 간다)
      const images = Array.isArray(v.images) ? v.images.filter(validImage).slice(0, MAX_IMAGES) : [];
      return images.length ? { ok: true, data: v.data, images } : { ok: true, data: v.data };
    }
    if (v.ok === false) {
      const code = typeof v.code === 'string' && ERROR_CODES.has(v.code) ? (v.code as ErrorCode) : 'error';
      const message = typeof v.message === 'string' && v.message.length > 0 ? v.message : '처리기가 사유 없이 거부했습니다';
      return { ok: false, code, message };
    }
  }
  return fail('error', '도구 처리기가 올바르지 않은 결과를 돌려주었습니다');
}

function toJsonText(data: unknown): string | null {
  try {
    const text = JSON.stringify(data ?? null);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function since(t0: number): number {
  return Math.round(performance.now() - t0);
}

function rpcError(id: RpcId | null, code: number, message: string): { jsonrpc: '2.0'; error: { code: number; message: string }; id: RpcId | null } {
  return { jsonrpc: '2.0', error: { code, message }, id };
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

type BodyResult = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'aborted' };

/** 인증 전에 읽은 본문 — ok: keep 안에서 끝남, too_large: keep을 넘음(ended: 상한 안에서 끝까지 받았는지 — false면 남은 본문을 받지 않았다), aborted: 받는 중 끊김 */
export type PreAuthBody = { kind: 'ok'; text: string } | { kind: 'too_large'; ended: boolean } | { kind: 'aborted' };

/**
 * 인증 전의 본문 읽기 (리드 결정 S7-22 S3): keep바이트까지 모으고 그 뒤는 버리며, 모두 PRE_AUTH_READ_MAX_BYTES까지만 읽는다 — 넘으면 거기서 읽기를 멈춘다(남은
 * 본문은 받지 않는다 — 부른 쪽이 answerAndClose로 답한 뒤 연결을 끊는다). 선언한 길이가 그 상한을 넘으면 읽지 않는다. 받는 시간은 리스너의 요청 시간 상한이 끊는다
 */
export function readBeforeAuth(req: IncomingMessage, keep = 0): Promise<PreAuthBody> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > PRE_AUTH_READ_MAX_BYTES) {
    // 읽지 않는다 — 답한 뒤 Node이 남은 본문을 받아 버리지 않게 하는 것은 answerAndClose가 한다 (리드 결정 S7-24 W1)
    req.pause();
    return Promise.resolve({ kind: 'too_large', ended: false });
  }
  if (req.readableEnded) return Promise.resolve({ kind: 'ok', text: '' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number.isFinite(declared) && declared > keep;
    let settled = false;
    const finish = (result: PreAuthBody): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
      // 상한을 넘었다 — 더 읽지 않는다 (흘려보내지도 않는다)
      if (result.kind === 'too_large' && !result.ended) req.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > PRE_AUTH_READ_MAX_BYTES) return finish({ kind: 'too_large', ended: false });
      if (size > keep) over = true;
      if (over) chunks.length = 0;
      else chunks.push(chunk);
    };
    const onEnd = (): void => finish(over ? { kind: 'too_large', ended: true } : { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    const onAbort = (): void => finish({ kind: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

/**
 * 인증 전에 주는 답을 보내고 연결을 끊는다 (리드 결정 S7-22 S3): send가 받은 머리(Connection: close)를 실어 답한다. 답이 OS에 넘어가면 쓰기 쪽을 닫고(FIN) 읽지 않은 채
 * PRE_AUTH_LINGER_MS 뒤에 소켓을 없앤다(상대가 먼저 닫으면 그때) — 상한을 넘은 본문은 더 받지 않는다. 곧바로 없애면 읽지 않은 본문이 남은 소켓이 RST를 보내고, Windows의
 * 상대는 이미 받은 답까지 버린다(시험에서 답 없이 끊김만 보였다). 인증하지 못한 연결은 이어 쓰지 않는다. 보내지 못했으면 곧바로 없앤다. 인증한 요청과 맞는 hello는 이
 * 길을 쓰지 않는다(keep-alive 그대로)
 */
export function answerAndClose(res: ServerResponse, send: (headers: Record<string, string>) => void): void {
  const socket = res.socket;
  // 답을 낸 뒤 Node은 끝까지 읽지 않은 요청을 req._dump()로 다시 흐르게 해 남은 본문을 전속력으로 받아 버린다 — 선언한 길이의 본문을 읽지 않고 거부하면 2초 동안
  // 1GB 넘게 받았다(검토 round 3, 리드 결정 S7-24 W1). 이 요청 하나만 그 일을 하지 않게 둔다: 요청은 멈춘 채로 남고, 그 버퍼(16KB)가 차면 Node이 소켓 핸들의 읽기를
  // 멈춘다. 공개된 길로는 막지 못했다 — Node 24에서 재 보니 'data'를 듣고 멈추거나 소켓을 멈춰도 _dump가 다시 흐르게 해 1.6~1.9GB를 받았다. Node 내부 이름이라
  // externalListenerDrain의 반쯤 열린 쪽 시험이 이 약속을 지킨다 (Node을 올려 이 이름이 바뀌면 그 시험이 깨진다)
  const req = res.req as (IncomingMessage & { _dump?: () => void }) | undefined;
  if (req) req._dump = () => undefined;
  if (socket) {
    // Node은 Connection: close 답을 보낸 뒤 destroySoon(쓰기를 마치면 곧바로 없앰)을 부른다 — 쓰기 쪽만 닫게 바꾸고, 없애는 것은 아래 기다림이 한다
    socket.destroySoon = () => {
      if (!socket.destroyed) socket.end();
    };
    res.once('finish', () => {
      const linger = setTimeout(() => socket.destroy(), PRE_AUTH_LINGER_MS);
      linger.unref();
      socket.once('close', () => clearTimeout(linger));
    });
  }
  send({ Connection: 'close' });
  if (!res.headersSent) socket?.destroy();
}

/** 본문을 다 받는다 (인증한 요청). limit을 넘으면 그 뒤로는 버리며 끝까지 받아 too_large (DRAIN_MAX_BYTES를 넘으면 받다 말고 too_large — 응답 뒤 끊긴다) */
function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > DRAIN_MAX_BYTES) return Promise.resolve({ kind: 'too_large' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number.isFinite(declared) && declared > limit;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > DRAIN_MAX_BYTES) return finish({ kind: 'too_large' });
      if (size > limit) over = true;
      if (over) chunks.length = 0;
      else chunks.push(chunk);
    };
    // 여러 조각에 걸친 한글(UTF-8)이 깨지지 않게 다 모은 뒤 한 번에 푼다
    const onEnd = (): void => finish(over ? { kind: 'too_large' } : { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    const onAbort = (): void => finish({ kind: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messagesOf(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

function rpcIdOf(message: unknown): RpcId | null {
  if (!isRecord(message)) return null;
  const id = message.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function toolCallOf(message: unknown): { tool: string; args: Record<string, unknown> } | null {
  if (!isRecord(message) || message.method !== 'tools/call') return null;
  const params = isRecord(message.params) ? message.params : {};
  return {
    tool: typeof params.name === 'string' ? clip(params.name, 200) : '(이름 없음)',
    args: isRecord(params.arguments) ? params.arguments : {},
  };
}

function collectToolCalls(body: unknown): Map<RpcId, { tool: string; args: Record<string, unknown> }> {
  const calls = new Map<RpcId, { tool: string; args: Record<string, unknown> }>();
  for (const m of messagesOf(body)) {
    const call = toolCallOf(m);
    const id = rpcIdOf(m);
    if (call && id !== null) calls.set(id, call);
  }
  return calls;
}

// ───────── 입력 검사 한국어 사유 ─────────

const TYPE_LABELS: Record<string, string> = {
  string: '문자열',
  number: '숫자',
  int: '정수',
  boolean: 'true/false',
  array: '배열',
  object: '객체',
  null: 'null',
  bigint: '정수',
  date: '날짜',
};

function typeLabel(expected: string): string {
  return TYPE_LABELS[expected] ?? expected;
}

function receivedLabel(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return '배열';
  if (typeof input === 'number') return Number.isInteger(input) ? '정수' : '숫자';
  return typeLabel(typeof input);
}

/** 이 검사에만 적용하는 zod 오류 지도 (전역 z.config를 바꾸면 다른 모듈의 문구까지 바뀐다) */
const koreanIssueMessage: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return '필수 항목입니다';
      return `${typeLabel(issue.expected)} 값이어야 합니다 (받은 값: ${receivedLabel(issue.input)})`;
    case 'too_small':
      return sizeMessage(issue.origin, issue.minimum, issue.inclusive, issue.exact, 'min');
    case 'too_big':
      return sizeMessage(issue.origin, issue.maximum, issue.inclusive, issue.exact, 'max');
    case 'invalid_value':
      return `다음 값 중 하나여야 합니다: ${issue.values.map((v) => String(v)).join(', ')}`;
    case 'unrecognized_keys':
      return `알 수 없는 항목입니다: ${issue.keys.join(', ')}`;
    case 'not_multiple_of':
      return `${issue.divisor}의 배수여야 합니다`;
    case 'invalid_format':
      return '형식이 올바르지 않습니다';
    case 'invalid_union':
      return '허용되는 형식과 맞지 않습니다';
    default:
      return '값이 올바르지 않습니다';
  }
};

function sizeMessage(origin: string, limit: number | bigint, inclusive: boolean | undefined, exact: boolean | undefined, side: 'min' | 'max'): string {
  const n = String(limit);
  if (origin === 'string') {
    if (exact) return `정확히 ${n}자여야 합니다`;
    if (side === 'min') return n === '1' && inclusive !== false ? '비어 있으면 안 됩니다' : `${n}자 이상이어야 합니다`;
    return `${n}자 이하여야 합니다`;
  }
  if (origin === 'array' || origin === 'set') {
    if (exact) return `항목이 정확히 ${n}개여야 합니다`;
    return side === 'min' ? `항목이 ${n}개 이상이어야 합니다` : `항목이 ${n}개 이하여야 합니다`;
  }
  if (side === 'min') return inclusive === false ? `${n}보다 커야 합니다` : `${n} 이상이어야 합니다`;
  return inclusive === false ? `${n}보다 작아야 합니다` : `${n} 이하여야 합니다`;
}

function pathLabel(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(입력 전체)';
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length === 0 ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  const parts = issues.slice(0, MAX_ISSUES_SHOWN).map((i) => `${pathLabel(i.path)}: ${i.message}`);
  if (issues.length > MAX_ISSUES_SHOWN) parts.push(`외 ${issues.length - MAX_ISSUES_SHOWN}건`);
  return `입력값이 올바르지 않습니다 — ${parts.join('; ')}`;
}
