/**
 * 앱 도구 서버 (MCP Streamable HTTP, 상태 없음) — CLI-07·08, ENV-02, LOG-01.
 *
 * ───────────── 실제로 오가는 내용 (모의 에이전트 작성용, @modelcontextprotocol/sdk 1.32.2에서 확인) ─────────────
 * 주소: http://127.0.0.1:<port>/mcp — POST만 받는다 (GET·DELETE 등 → 405, Allow: POST). 세션(Mcp-Session-Id) 없음.
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
 *         stopped(서버 종료 중) · seat_changed(메인 자리가 바뀐 뒤의 이전 세대 메인 토큰, 리드 결정 S4-4) · 그 밖에 처리기가 돌려준 conflict 등
 * ⑤ HTTP 단계 거부 — JSON-RPC 오류 본문
 *   < 401 WWW-Authenticate: Bearer realm="wook" {"jsonrpc":"2.0","error":{"code":-32001,"message":"Authorization: Bearer <토큰> 헤더가 없습니다"},"id":7}
 *     (모르는·폐기된 토큰은 error="invalid_token", Bearer 형식이 아니면 error="invalid_request"를 붙이고 사유가 다르다.
 *      id는 단일 요청이면 그 id, 아니면 null)
 *   < 403·404·405·413 {"jsonrpc":"2.0","error":{"code":-32000,"message":"…"},"id":null},  JSON 아님 400 → code -32700
 * 묶음(배열) 요청도 받는다: 응답은 같은 순서의 배열. 없는 메서드는 {"jsonrpc":"2.0","id":n,"error":{"code":-32601,"message":"Method not found"}}.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * 기록(onCall): tools/call은 결과와 관계없이 모두, 401은 본문의 메시지마다(identity null),
 * Host 거부(403)는 요청마다 남긴다. GET·OAuth 탐색 같은 404/405와 initialize·tools/list 성공은 남기지 않는다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TOOL_SPECS, rolesFor, type ToolRole, type ToolSpec } from './catalog';
import type { AppToolServer, AppToolServerOptions, TokenIdentity, ToolCallLog, ToolCallResult } from './types';

const MCP_PATH = '/mcp';
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

const RPC_UNAUTHORIZED = -32001;
const RPC_SERVER_ERROR = -32000;
const RPC_PARSE_ERROR = -32700;
const RPC_INTERNAL_ERROR = -32603;

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
  const inflight = new Set<Promise<unknown>>();
  let http: HttpServer | null = null;
  let url: string | null = null;
  let port: number | null = null;
  let allowedHosts: ReadonlySet<string> = new Set();
  let startPromise: Promise<{ url: string; port: number }> | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopping = false;

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

    const host = req.headers.host;
    if (host === undefined || !allowedHosts.has(host.toLowerCase())) {
      // DNS 리바인딩 방지: 루프백 주소로 들어왔어도 Host가 다른 이름이면 받지 않는다
      const message = `허용되지 않은 Host 헤더입니다 (${clip(host ?? '없음', 120)}). 앱 도구 서버는 이 PC 안(${HOST})에서만 받습니다`;
      emit({ at, identity: null, tool: '(http)', args: {}, result: fail('forbidden', message), durationMs: since(t0) });
      sendJson(res, 403, rpcError(null, RPC_SERVER_ERROR, message));
      return;
    }

    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) {
      sendJson(res, 404, rpcError(null, RPC_SERVER_ERROR, `알 수 없는 경로입니다 (${clip(path, 120)}). 앱 도구 주소는 ${MCP_PATH} 입니다`));
      return;
    }
    if (req.method !== 'POST') {
      // 상태 없는 서버라 SSE(GET)·세션 종료(DELETE)가 없다. SDK 클라이언트는 GET의 405를 "SSE 없음"으로 받아들인다
      sendJson(res, 405, rpcError(null, RPC_SERVER_ERROR, `이 서버는 POST만 받습니다 (${clip(req.method ?? '', 20)})`), { Allow: 'POST' });
      return;
    }

    const authorization = req.headers.authorization;
    const token = bearerToken(authorization);
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body.kind === 'aborted') return; // 본문을 보내는 중 연결이 끊김 — 응답 받을 상대가 없다
    // 본문을 받는 사이 폐기된 토큰도 거부되도록 다 받은 뒤 확인한다
    const identity = token === null ? null : (tokens.get(tokenKey(token)) ?? null);

    if (identity === null) {
      const [message, challenge] =
        token !== null
          ? ['토큰이 유효하지 않거나 이미 폐기되었습니다 (턴이 끝났을 수 있습니다)', 'Bearer realm="wook", error="invalid_token"']
          : authorization === undefined
            ? ['Authorization: Bearer <토큰> 헤더가 없습니다', 'Bearer realm="wook"']
            : ['Authorization 헤더가 "Bearer <토큰>" 형식이 아닙니다', 'Bearer realm="wook", error="invalid_request"'];
      const parsed = body.kind === 'ok' ? tryParseJson(body.text) : undefined;
      const durationMs = since(t0);
      for (const m of describeMessages(parsed)) {
        emit({ at, identity: null, tool: m.tool, args: m.args, result: { ok: false, code: 'unauthorized', message }, durationMs });
      }
      sendJson(res, 401, rpcError(singleRequestId(parsed), RPC_UNAUTHORIZED, message), {
        'WWW-Authenticate': challenge,
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

  // ───────── MCP 단계: 요청마다 새 McpServer·전송 계층 (토큰 주인별로 공개 도구가 다르다) ─────────

  async function serveMcp(identity: TokenIdentity, req: IncomingMessage, res: ServerResponse, body: unknown, t0: number, at: string): Promise<void> {
    if (res.destroyed) return;
    const roles = rolesFor(identity);
    const visible = TOOLS.filter((t) => t.spec.roles.some((r) => roles.includes(r)));
    const visibleNames: ReadonlySet<string> = new Set(visible.map((t) => t.spec.name));
    const calls = collectToolCalls(body);
    const handled = new Set<RpcId>();

    const mcp = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
    for (const { spec, schema } of visible) {
      mcp.registerTool(spec.name, { description: spec.description, inputSchema: schema }, (args) =>
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

    emit({ at, identity, tool: clip(name, 200), args, result, durationMs: since(t0) });
    if (result.ok && text !== null) return { content: [{ type: 'text', text }] };
    const failure = result.ok ? fail('error', '도구 결과를 만들지 못했습니다') : result;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure.code, message: failure.message }) }] };
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
    const server = createServer((req, res) => {
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
        http = null;
        allowedHosts = new Set();
        // 다시 열면 새 턴 토큰부터 받는다
        tokens.clear();
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
    issueToken(identity: TokenIdentity): string {
      const token = randomBytes(32).toString('base64url');
      tokens.set(tokenKey(token), Object.freeze({ ...identity }));
      return token;
    },
    revokeToken(token: string): void {
      tokens.delete(tokenKey(token));
    },
    revokeTurn(turnId: string): void {
      for (const [key, identity] of tokens) {
        if (identity.turnId === turnId) tokens.delete(key);
      }
    },
    revokeWhere(pred: (identity: TokenIdentity) => boolean): number {
      let n = 0;
      for (const [key, identity] of tokens) {
        if (!pred(identity)) continue;
        tokens.delete(key);
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

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>(['forbidden', 'invalid', 'conflict', 'not_found', 'stopped', 'seat_changed', 'error']);

/** 처리기 결과를 계약 모양으로 맞춘다 (JS 쪽 실수가 SDK 결과 검증 오류로 번지지 않게) */
function normalizeResult(value: ToolCallResult): ToolCallResult {
  const v: unknown = value;
  if (isRecord(v)) {
    if (v.ok === true) return { ok: true, data: v.data };
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

/** 본문을 다 받는다. limit을 넘으면 그 뒤로는 버리며 끝까지 받아 too_large (DRAIN_MAX_BYTES를 넘으면 받다 말고 too_large — 응답 뒤 끊긴다) */
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

function singleRequestId(body: unknown): RpcId | null {
  return Array.isArray(body) ? null : rpcIdOf(body);
}

function toolCallOf(message: unknown): { tool: string; args: Record<string, unknown> } | null {
  if (!isRecord(message) || message.method !== 'tools/call') return null;
  const params = isRecord(message.params) ? message.params : {};
  return {
    tool: typeof params.name === 'string' ? clip(params.name, 200) : '(이름 없음)',
    args: isRecord(params.arguments) ? params.arguments : {},
  };
}

/** 401 기록용: 본문의 메시지마다 도구 이름(tools/call이 아니면 JSON-RPC 메서드)과 인자 */
function describeMessages(body: unknown): { tool: string; args: Record<string, unknown> }[] {
  if (body === undefined) return [{ tool: '(http)', args: {} }];
  const described = messagesOf(body).map((m) => {
    const call = toolCallOf(m);
    if (call) return call;
    if (isRecord(m) && typeof m.method === 'string') return { tool: clip(m.method, 200), args: {} };
    return { tool: '(알 수 없는 요청)', args: {} };
  });
  return described.length > 0 ? described : [{ tool: '(http)', args: {} }];
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
