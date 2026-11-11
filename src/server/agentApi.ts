/**
 * 외부 에이전트 API (SERVER_DESIGN 4.5, 리드 결정 S7-2·S7-3·S7-4) — `/agent/v1/*`.
 *
 * 붙는 곳: 앱 도구 서버(MCP)의 루프백 리스너 — 127.0.0.1, 시작마다 새 포트, 그 리스너의 Host 검사 뒤 (mcp/server.ts mountAgentApi). 대표용 포트에는 없다:
 * `tailscale serve`가 대표용 포트로 넘겨 주므로 거기 둔 길은 tailnet에서 닿는다. tailnet 리스너는 열지 않는다(다른 PC의 에이전트는 범위 밖). 서버 모드만 붙인다 —
 * 데스크톱 앱의 그 길은 404다.
 *
 * 인증 (S7-3, AC-32): hello 밖의 모든 요청은 `Authorization: Bearer wsk_…`. 머리가 없거나, Bearer가 아니거나, 모르거나 폐기된 키거나, 키·턴 토큰을 주소(쿼리)에 넣으면 401 —
 * 처리기를 부르지 않고 아무것도 바꾸지 않는다(본문은 64KB까지만 읽어 버리고, 답한 뒤 연결을 끊는다 — Connection: close, 리드 결정 S7-22 S3. hello의 거부 400·413도
 * 같다. 인증한 요청과 맞는 hello는 연결을 이어 쓴다). 틀린 키와 폐기된 키는 같은 글이다. 401은 서버 기록에 1분 창마다 한 줄로 모은다(요청마다 쓰지 않는다
 * — DB에는 쓰지 않는다, 4.5의 DB 부하 경고). 도구·화면 길은 키와 함께 `X-Wook-Turn-Token: wtt_…`가 있어야 하고 둘이 같은 에이전트여야 한다.
 *
 * 서버 확인 (리드 결정 S7-19 C3): 인증 없는 길은 `POST hello` 하나다 — `{ nonce }`에 이 실행의 확인값(agent-endpoint.json의 proof)으로 만든 HMAC을 답한다.
 * 에이전트는 키를 보내기 전에 이것으로 그 주소의 서버가 그 파일을 쓴 서버인지 본다. 키 머리를 보지 않고(마지막 접속도 바뀌지 않는다) 아무것도 바꾸지 않으며, 인증 없는
 * 요청의 몫으로 세지 않고 제 횟수 상한도 없다(본문 1KB까지 — 값싼 길). 실행 ID·확인값은 어떤 답에도 넣지 않는다.
 *
 * 횟수 (1분 창): 키마다 600번, 인증하지 못한 요청(hello 밖)은 모두 합쳐 120번 — 넘으면 429와 Retry-After. 인증 없는 몫은 붙은 리스너의 것 하나다: 같은 리스너의 `/mcp`
 * 401과 함께 센다(리스너가 요청마다 넘긴다, 리드 결정 S7-17 A1 — 넘기지 않으면 이 API의 몫). 열린 work/next는 에이전트마다 하나 — 새 것이 옛 것에 204를 준다.
 * 본문: JSON 1MB까지, 도구 인자는 4MB까지(넘으면 413 — 넘친 본문도 읽어 버린 뒤 답한다). 오류는 `{ ok: false, error: { code, message } }`.
 * 접근 기록에는 머리·본문·주소의 쿼리를 쓰지 않는다.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BackendError, type AgentBackend } from '../main/backend/types';
import { answerAndClose, readBeforeAuth } from '../main/mcp/server';
import type { UnauthenticatedBudget } from '../main/mcp/types';
import type { Logger } from '../main/shell/logger';
import { collapsedLog } from './logCollapse';
import {
  AGENT_API_PREFIX,
  AGENT_BODY_MAX_BYTES,
  AGENT_ERROR_STATUS,
  AGENT_FINAL_MAX,
  AGENT_HELLO_BODY_MAX_BYTES,
  AGENT_HELLO_NONCE_MAX_BYTES,
  AGENT_HELLO_NONCE_MIN_BYTES,
  AGENT_PROGRESS_MAX,
  AGENT_PROOF_BYTES,
  AGENT_RATE_PER_KEY,
  AGENT_RATE_UNAUTHENTICATED,
  AGENT_TOOL_BODY_MAX_BYTES,
  TURN_TOKEN_HEADER,
  type AgentErrorCode,
} from './agentApiTypes';

/** 이보다 큰 본문은 받지 않고 끊는다 (넘친 본문을 읽어 버리는 상한 — mcp/server.ts와 같다) */
const DRAIN_MAX_BYTES = 64 * 1024 * 1024;
const WINDOW_MS = 60_000;
/** 틀린 키와 폐기된 키의 같은 글 (리드 결정 S7-3) */
export const AGENT_KEY_REFUSAL = '에이전트 키가 맞지 않거나 폐기됐습니다';
const NO_HEADER = 'Authorization: Bearer <에이전트 키> 머리가 없습니다';
const NOT_BEARER = 'Authorization 머리가 "Bearer <에이전트 키>" 꼴이 아닙니다';
const QUERY_SECRET = '에이전트 키나 턴 토큰은 주소(쿼리)에 넣지 않습니다 — Authorization 머리와 X-Wook-Turn-Token 머리로 보내세요';
/** 키·토큰을 담았을 수 있는 쿼리 이름 */
const SECRET_PARAM = /^(?:key|api[_-]?key|token|access[_-]?token|auth|authorization|bearer|turn[_-]?token|wsk|wtt)$/i;
const CAPTURE_ID_RE = /^SC-\d{6,12}$/;
const TURN_ID_RE = /^TN-\d{4,12}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface AgentApiLimits {
  perKey: number;
  unauthenticated: number;
  windowMs: number;
}

export interface AgentApiOptions {
  agents: AgentBackend;
  logger: Logger;
  /** 시험: 시계 */
  now?: () => number;
  /** 시험: 횟수 상한·창 (기본 600·120·1분) — 서버 시작 길은 넘기지 않는다 */
  limits?: Partial<AgentApiLimits>;
  /**
   * 이 실행의 확인값 (리드 결정 S7-19 C3) — agent-endpoint.json의 proof(32바이트 base64url). hello가 이것으로 HMAC을 만든다. 없으면 이 API가 스스로 만든
   * 난수(아무도 모르는 값 — hello의 꼴은 같다). 이 값은 어떤 답·기록에도 넣지 않는다
   */
  proof?: string;
}

export interface AgentApi {
  /** budget: 붙은 리스너의 인증 없는 요청 몫 (`/mcp`와 함께 쓴다 — 리드 결정 S7-17 A1). 없으면 이 API의 몫(limits.unauthenticated) */
  handle(req: IncomingMessage, res: ServerResponse, budget?: UnauthenticatedBudget): Promise<void>;
  /** 모은 기록 줄의 남은 수를 쓴다 (닫을 때) */
  flush(): void;
}

type Route =
  | { kind: 'hello' }
  | { kind: 'claim' }
  | { kind: 'heartbeat' }
  | { kind: 'release' }
  | { kind: 'seat' }
  | { kind: 'next' }
  | { kind: 'progress'; turnId: string }
  | { kind: 'finish'; turnId: string }
  | { kind: 'tool'; name: string }
  | { kind: 'screen'; id: string }
  | { kind: 'stop' };

/** 길 찾기 — 메서드까지 맞아야 한다. 모르면 null(404) */
function routeOf(method: string, rest: string): Route | null {
  const post = method === 'POST';
  const get = method === 'GET';
  if (post && rest === '/hello') return { kind: 'hello' };
  if (post && rest === '/seat/claim') return { kind: 'claim' };
  if (post && rest === '/seat/heartbeat') return { kind: 'heartbeat' };
  if (post && rest === '/seat/release') return { kind: 'release' };
  if (get && rest === '/seat') return { kind: 'seat' };
  if (post && rest === '/work/next') return { kind: 'next' };
  if (post && rest === '/stop') return { kind: 'stop' };
  let m = /^\/work\/([^/]+)\/(progress|finish)$/.exec(rest);
  if (post && m) return m[2] === 'progress' ? { kind: 'progress', turnId: decodeSafe(m[1]!) } : { kind: 'finish', turnId: decodeSafe(m[1]!) };
  m = /^\/tool\/([^/]+)$/.exec(rest);
  if (post && m) return { kind: 'tool', name: decodeSafe(m[1]!) };
  m = /^\/screens\/([^/]+)$/.exec(rest);
  if (get && m) return { kind: 'screen', id: decodeSafe(m[1]!) };
  return null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 기록에 쓰는 길 이름 (값은 넣지 않는다) */
const ROUTE_LABEL: Readonly<Record<Route['kind'], string>> = {
  hello: 'POST hello',
  claim: 'POST seat/claim',
  heartbeat: 'POST seat/heartbeat',
  release: 'POST seat/release',
  seat: 'GET seat',
  next: 'POST work/next',
  progress: 'POST work/{turnId}/progress',
  finish: 'POST work/{turnId}/finish',
  tool: 'POST tool/{name}',
  screen: 'GET screens/{id}',
  stop: 'POST stop',
};

/** 에이전트 API의 모든 길 ('<메서드> <길>') — AC-32 시험이 그 목록과 견준다. 인증 없는 길은 AGENT_UNAUTHENTICATED_ROUTES뿐이다 */
export const AGENT_API_ROUTES: readonly string[] = Object.values(ROUTE_LABEL);
export const AGENT_UNAUTHENTICATED_ROUTES: readonly string[] = [ROUTE_LABEL.hello];

/** hello의 nonce — '=' 없는 base64url로 16~64바이트, 다시 적으면 같은 글(정규 꼴)이어야 한다. 아니면 null */
function helloNonce(body: unknown): Buffer | null {
  if (!isRecord(body) || typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.nonce)) return null;
  const bytes = Buffer.from(body.nonce, 'base64url');
  if (bytes.length < AGENT_HELLO_NONCE_MIN_BYTES || bytes.length > AGENT_HELLO_NONCE_MAX_BYTES || bytes.toString('base64url') !== body.nonce) return null;
  return bytes;
}

type BodyResult = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'aborted' };

/** 본문을 다 받는다. limit을 넘으면 그 뒤로는 버리며 끝까지 받아 too_large (DRAIN_MAX_BYTES를 넘으면 받다 말고 too_large) */
function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > DRAIN_MAX_BYTES) return Promise.resolve({ kind: 'too_large' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number.isFinite(declared) && declared > limit;
    let settled = false;
    const finish = (r: BodyResult): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
      resolve(r);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > DRAIN_MAX_BYTES) return finish({ kind: 'too_large' });
      if (size > limit) over = true;
      if (over) chunks.length = 0;
      else chunks.push(chunk);
    };
    const onEnd = (): void => finish(over ? { kind: 'too_large' } : { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    const onAbort = (): void => finish({ kind: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, code: AgentErrorCode, message: string, headers: Record<string, string> = {}, status = AGENT_ERROR_STATUS[code]): void {
  sendJson(res, status, { ok: false, error: { code, message } }, headers);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * REST 도구 길의 결과 (리드 결정 S7-17 F6): 이 길은 이미지를 싣지 않는다(MCP 길만 이미지 블록을 붙인다). 결과가 이미지를 붙였다고(image: 'attached') 말하면 참이 되게
 * 'file_only'로 고친다 — 그 PNG는 file 칸의 파일이고, 캡처는 `GET screens/{capture_id}`로도 받는다. screen_capture·get_screen_check의 image와 gui_input이 이어 찍은
 * 캡처(after.image)
 */
export function restToolData(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const out: Record<string, unknown> = { ...data };
  if (out.image === 'attached') out.image = 'file_only';
  if (isRecord(out.after) && out.after.image === 'attached') out.after = { ...out.after, image: 'file_only' };
  return out;
}

/** 쿼리에 키·토큰이 있는지 (값의 모양이나 이름으로) — 있으면 401 (S7-3) */
function querySecret(rawQuery: string): boolean {
  if (!rawQuery) return false;
  if (/w(?:sk|tt)_/i.test(rawQuery) || /w(?:sk|tt)%5f/i.test(rawQuery)) return true;
  try {
    for (const [name] of new URLSearchParams(rawQuery)) if (SECRET_PARAM.test(name)) return true;
  } catch {
    return true;
  }
  return false;
}

/** 'Bearer <키>'에서 키 — 머리가 없으면 undefined, 꼴이 틀리면 null */
function bearerOf(header: string | string[] | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m ? m[1]! : null;
}

/** 1분 창의 셈 */
class WindowCounter {
  private start = 0;
  private count = 0;
  constructor(
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  /** 한 번 세고, 상한을 넘었으면 다시 해도 되는 때까지의 초 (넘지 않았으면 null) */
  hit(limit: number): number | null {
    const t = this.now();
    if (t - this.start >= this.windowMs) {
      this.start = t;
      this.count = 0;
    }
    this.count += 1;
    if (this.count <= limit) return null;
    return Math.max(1, Math.ceil((this.start + this.windowMs - t) / 1000));
  }
}

export function createAgentApi(o: AgentApiOptions): AgentApi {
  const now = o.now ?? Date.now;
  const limits: AgentApiLimits = { perKey: o.limits?.perKey ?? AGENT_RATE_PER_KEY, unauthenticated: o.limits?.unauthenticated ?? AGENT_RATE_UNAUTHENTICATED, windowMs: o.limits?.windowMs ?? WINDOW_MS };
  const anonymous = new WindowCounter(limits.windowMs, now);
  const perKey = new Map<string, WindowCounter>();
  // 거부는 1분 창마다 한 줄로 모은다 — 인증 없는 쪽이 기록을 채우지 못하게 (4.5, S2-16과 같은 방식). DB(활동 기록)에는 쓰지 않는다
  const refusals = collapsedLog<'unauthorized' | 'rate_limited'>({
    windowMs: limits.windowMs,
    write: (text) => o.logger.warn(text),
    summary: (kind, extra, span) =>
      kind === 'unauthorized' ? `에이전트 API: 인증하지 못한 요청이 지난 ${span} 동안 ${extra}번 더 있었습니다 (모두 401, 처리하지 않음)` : `에이전트 API: 횟수 상한을 넘은 요청이 지난 ${span} 동안 ${extra}번 더 있었습니다 (모두 429)`,
  });

  /** 리스너가 몫을 넘기지 않았을 때(단위 시험)의 이 API 몫 */
  const ownBudget: UnauthenticatedBudget = { hit: () => anonymous.hit(limits.unauthenticated) };
  /** 이 실행의 확인값 (S7-19 C3) — HMAC의 키. 어떤 답·기록에도 넣지 않는다 */
  const proofKey = o.proof !== undefined ? Buffer.from(o.proof, 'base64url') : randomBytes(AGENT_PROOF_BYTES);
  if (proofKey.length !== AGENT_PROOF_BYTES) throw new Error(`에이전트 API의 확인값은 ${AGENT_PROOF_BYTES}바이트여야 합니다`);

  /**
   * POST hello (리드 결정 S7-19 C3, 몫은 리드 후속 11-11) — 인증 없는 길은 이것 하나다. 키·턴 토큰 머리가 있어도 보지 않는다(키를 확인하지 않으니 마지막 접속도 바뀌지
   * 않는다). 임대·DB·처리기·기록에 닿지 않는다. **인증 없는 요청의 몫으로 세지 않고, 그 몫이 다 써졌어도 거부하지 않으며, 제 횟수 상한도 없다** — 맞는 키를 가진
   * 에이전트는 이 확인부터 하므로, 다른 프로그램이 그 몫을 다 써서 모든 `wook`이 1분 동안 멈추는 일이 없게. 그래서 값싸게 둔다: 본문 1KB까지(넘으면 413), 꼴이 틀린
   * 본문은 400, 맞는 nonce면 어떤 nonce에도 `{ ok, mac }` 꼴 하나로 답한다
   */
  async function hello(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 인증 전의 읽기 (리드 결정 S7-22 S3): 1KB까지 모으고 64KB까지만 읽는다. 거부(413·400)는 답한 뒤 연결을 끊고, 맞는 hello만 연결을 이어 쓴다(keep-alive)
    const b = await readBeforeAuth(req, AGENT_HELLO_BODY_MAX_BYTES);
    if (b.kind === 'aborted') return;
    if (b.kind === 'too_large') {
      answerAndClose(res, (h) => sendError(res, 'too_large', `hello 본문이 너무 큽니다 (${AGENT_HELLO_BODY_MAX_BYTES}바이트까지)`, h));
      return;
    }
    let body: unknown = null;
    try {
      body = JSON.parse(b.text) as unknown;
    } catch {
      body = null;
    }
    const nonce = helloNonce(body);
    if (!nonce) {
      answerAndClose(res, (h) =>
        sendError(res, 'invalid', `hello 본문은 {"nonce": "<${AGENT_HELLO_NONCE_MIN_BYTES}~${AGENT_HELLO_NONCE_MAX_BYTES}바이트를 '=' 없는 base64url로 적은 글>"}이어야 합니다`, h),
      );
      return;
    }
    sendJson(res, 200, { ok: true, mac: createHmac('sha256', proofKey).update(nonce).digest('base64url') });
  }

  /**
   * 인증하지 못한 요청의 답 — 처리기를 부르지 않는다. 본문은 64KB까지만 읽어 버린 뒤 답하고 연결을 끊는다(Connection: close — 더 오는 본문은 받지 않는다, 리드 결정
   * S7-22 S3)
   */
  async function unauthorized(req: IncomingMessage, res: ServerResponse, budget: UnauthenticatedBudget, label: string, cause: string, message: string): Promise<void> {
    const retry = budget.hit();
    const body = await readBeforeAuth(req);
    if (body.kind === 'aborted') return;
    if (retry !== null) {
      refusals.log('rate_limited', `에이전트 API: 인증하지 못한 요청이 1분에 ${limits.unauthenticated}번을 넘어 429로 답함 (${label}) — 같은 창의 나머지는 한 줄로 모읍니다`);
      answerAndClose(res, (h) => sendError(res, 'rate_limited', `인증하지 못한 요청이 너무 많습니다 — ${retry}초 뒤에 다시 하세요`, { 'Retry-After': String(retry), ...h }));
      return;
    }
    refusals.log('unauthorized', `에이전트 API: 인증하지 못한 요청을 거부함 (${label}, ${cause}) — 같은 1분 동안의 나머지는 한 줄로 모읍니다`);
    answerAndClose(res, (h) => sendError(res, 'unauthorized', message, { 'WWW-Authenticate': 'Bearer realm="wook-agent"', ...h }));
  }

  async function handle(req: IncomingMessage, res: ServerResponse, listenerBudget?: UnauthenticatedBudget): Promise<void> {
    const budget = listenerBudget ?? ownBudget;
    const raw = req.url ?? '';
    const q = raw.indexOf('?');
    const path = q < 0 ? raw : raw.slice(0, q);
    const query = q < 0 ? '' : raw.slice(q + 1);
    const rest = path.slice(AGENT_API_PREFIX.length) || '/';
    const route = routeOf(req.method ?? '', rest);
    const label = route ? ROUTE_LABEL[route.kind] : `${(req.method ?? '').slice(0, 10)} (모르는 길)`;

    // ① 주소에 키·토큰 — 머리를 보기 전에 거부한다(그 값이 맞든 틀리든) (S7-3)
    if (querySecret(query)) return unauthorized(req, res, budget, label, '키·토큰을 주소에 넣음', QUERY_SECRET);
    // 인증 없는 길 하나 — 서버 확인(hello). 키 머리는 보지 않는다 (S7-19 C3)
    if (route?.kind === 'hello') return hello(req, res);
    // ② 에이전트 키
    const key = bearerOf(req.headers.authorization);
    if (key === undefined) return unauthorized(req, res, budget, label, '머리 없음', NO_HEADER);
    if (key === null) return unauthorized(req, res, budget, label, 'Bearer 꼴이 아님', NOT_BEARER);
    const agent = o.agents.authenticate(key);
    if (!agent) return unauthorized(req, res, budget, label, '모르거나 폐기된 키', AGENT_KEY_REFUSAL);
    // ③ 키마다 횟수
    let counter = perKey.get(agent.id);
    if (!counter) perKey.set(agent.id, (counter = new WindowCounter(limits.windowMs, now)));
    const retry = counter.hit(limits.perKey);
    if (retry !== null) {
      const body = await readBody(req, 0);
      if (body.kind === 'aborted') return;
      refusals.log('rate_limited', `에이전트 API: ${agent.label}(${agent.id})의 요청이 1분에 ${limits.perKey}번을 넘어 429로 답함 — 같은 창의 나머지는 한 줄로 모읍니다`);
      sendError(res, 'rate_limited', `요청이 너무 많습니다 (1분에 ${limits.perKey}번까지) — ${retry}초 뒤에 다시 하세요`, { 'Retry-After': String(retry), ...(body.kind === 'too_large' ? { Connection: 'close' } : {}) });
      return;
    }
    if (!route) {
      req.resume();
      sendError(res, 'not_found', `에이전트 API에 없는 길입니다 (${label}) — AGENT_GUIDE.md의 길 목록을 보세요`);
      return;
    }
    // ④ 본문 (GET은 없다)
    let body: unknown = {};
    if (req.method === 'POST') {
      const limit = route.kind === 'tool' ? AGENT_TOOL_BODY_MAX_BYTES : AGENT_BODY_MAX_BYTES;
      const b = await readBody(req, limit);
      if (b.kind === 'aborted') return;
      if (b.kind === 'too_large') {
        sendError(res, 'too_large', `요청 본문이 너무 큽니다 (${route.kind === 'tool' ? '도구 인자는 4MB' : '1MB'}까지)`, { Connection: 'close' });
        return;
      }
      if (b.text.trim()) {
        try {
          body = JSON.parse(b.text) as unknown;
        } catch {
          sendError(res, 'invalid', '요청 본문을 JSON으로 읽을 수 없습니다');
          return;
        }
      }
      if (route.kind !== 'tool' && !isRecord(body)) {
        sendError(res, 'invalid', '요청 본문은 JSON 객체여야 합니다');
        return;
      }
    } else req.resume();
    try {
      await dispatch(route, agent.id, body, req, res);
    } catch (e) {
      if (e instanceof BackendError) {
        const code = (AGENT_ERROR_STATUS as Record<string, number>)[e.code] !== undefined ? (e.code as AgentErrorCode) : e.code === 'invalid_args' ? 'invalid' : null;
        if (code) {
          // 화면 길의 세대 거부는 403 (계약: 403 seat_changed)
          sendError(res, code, e.message, code === 'unauthorized' ? { 'WWW-Authenticate': 'Bearer realm="wook-agent"' } : {}, route.kind === 'screen' && code === 'seat_changed' ? 403 : AGENT_ERROR_STATUS[code]);
          return;
        }
      }
      o.logger.error(`에이전트 API 처리 오류 (${label})`, e);
      sendError(res, 'internal', '에이전트 API를 처리하다 서버 오류가 났습니다 — 서버 기록을 확인하세요');
    }
  }

  const text = (v: unknown, what: string, max: number, required = true): string => {
    if (v === undefined && !required) return '';
    if (typeof v !== 'string') throw new BackendError('invalid', `${what}은(는) 글이어야 합니다`);
    if (v.length > max) throw new BackendError('invalid', `${what}은(는) ${max.toLocaleString('ko-KR')}자까지입니다 (${v.length.toLocaleString('ko-KR')}자)`);
    return v;
  };

  async function dispatch(route: Route, agentId: string, body: unknown, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = (isRecord(body) ? body : {}) as Record<string, unknown>;
    const a = o.agents;
    switch (route.kind) {
      case 'claim':
        sendJson(res, 200, { ok: true, ...a.claim(agentId) });
        return;
      case 'heartbeat':
        sendJson(res, 200, { ok: true, ...a.heartbeat(agentId, b.leaseId as string) });
        return;
      case 'release':
        a.release(agentId, b.leaseId as string, b.note === undefined || b.note === null ? null : text(b.note, 'note', 2000));
        sendJson(res, 200, { ok: true });
        return;
      case 'seat':
        sendJson(res, 200, { ok: true, ...a.seat(agentId) });
        return;
      case 'next': {
        const waitMs = b.waitMs === undefined ? 0 : typeof b.waitMs === 'number' && Number.isFinite(b.waitMs) && b.waitMs >= 0 ? b.waitMs : NaN;
        if (Number.isNaN(waitMs)) throw new BackendError('invalid', 'waitMs는 0 이상의 숫자(밀리초)여야 합니다');
        const closed = new Promise<void>((r) => {
          res.once('close', () => r());
          req.once('aborted', () => r());
        });
        const item = await a.next(agentId, b.leaseId as string, waitMs, closed);
        if (res.destroyed || res.writableEnded) return;
        if (!item) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        sendJson(res, 200, { ok: true, ...item });
        return;
      }
      case 'progress':
        if (!TURN_ID_RE.test(route.turnId)) throw new BackendError('not_found', '턴 ID 꼴이 아닙니다 (TN-…)');
        a.progress(agentId, b.leaseId as string, route.turnId, text(b.text, 'text', AGENT_PROGRESS_MAX));
        sendJson(res, 200, { ok: true });
        return;
      case 'finish': {
        if (!TURN_ID_RE.test(route.turnId)) throw new BackendError('not_found', '턴 ID 꼴이 아닙니다 (TN-…)');
        const outcome = b.outcome === undefined ? 'completed' : b.outcome;
        if (outcome !== 'completed' && outcome !== 'failed') throw new BackendError('invalid', "outcome은 'completed' 또는 'failed'입니다");
        const r = await a.finish(agentId, b.leaseId as string, route.turnId, text(b.finalText, 'finalText', AGENT_FINAL_MAX), outcome);
        sendJson(res, 200, { ok: true, ...r });
        return;
      }
      case 'tool': {
        if (!TOOL_NAME_RE.test(route.name)) throw new BackendError('not_found', '도구 이름 꼴이 아닙니다');
        const token = turnToken(req);
        const r = await a.tool(agentId, token, route.name, body);
        sendJson(res, 200, r.ok ? { ok: true, data: restToolData(r.data) } : { ok: false, error: { code: r.code, message: r.message } });
        return;
      }
      case 'screen': {
        const token = turnToken(req);
        if (!CAPTURE_ID_RE.test(route.id)) throw new BackendError('not_found', '캡처 ID 꼴이 아닙니다 (SC-…)');
        const png = a.screen(agentId, token, route.id);
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(png);
        return;
      }
      case 'stop': {
        const summary = await a.stop(agentId);
        sendJson(res, 200, { ok: true, ...summary });
        return;
      }
    }
  }

  /** X-Wook-Turn-Token — 없으면 401 (키와 토큰이 함께 있어야 한다, S7-3) */
  function turnToken(req: IncomingMessage): string {
    const v = req.headers[TURN_TOKEN_HEADER];
    const t = Array.isArray(v) ? v[0] : v;
    if (typeof t !== 'string' || !t.trim()) throw new BackendError('unauthorized', '턴 토큰 머리(X-Wook-Turn-Token)가 없습니다 — work/next가 준 mcp.token을 보내세요');
    return t.trim();
  }

  return { handle, flush: () => refusals.flush() };
}
