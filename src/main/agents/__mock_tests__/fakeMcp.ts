/**
 * 시험용 앱 도구 서버: @modelcontextprotocol/sdk로 카탈로그의 도구 이름·입력 형식을 그대로 공개하고 FakeWork로 처리한다.
 * - style 'sse': 세션 있는 서버(Mcp-Session-Id), 응답은 SSE — 모의 에이전트의 SSE 해석·세션 헤더 되돌려 보내기를 시험
 * - style 'json': 세션 없는 서버, 응답은 JSON 한 덩어리 — 실제 앱 도구 서버(mcp/server.ts)와 같은 방식
 * Bearer 토큰 = FakeWork에 등록한 에이전트 이름.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TOOL_SPECS, type ToolSpec } from '../../mcp/catalog';
import type { FakeResult, FakeWork } from './fakeWork';

export interface HttpLogEntry {
  agent: string | null;
  rpcMethod: string | null;
  status: number;
  sessionIdHeader: string | null;
  protocolVersionHeader: string | null;
  contentType: string | null;
}

export interface FakeMcpServer {
  url: string;
  httpLog: HttpLogEntry[];
  stop(): Promise<void>;
}

const SCHEMAS: ReadonlyMap<string, z.ZodObject<z.ZodRawShape>> = new Map((TOOL_SPECS as readonly ToolSpec[]).map((s) => [s.name, z.object(s.input)]));

function toCallResult(r: FakeResult): CallToolResult {
  if (r.ok) return { content: [{ type: 'text', text: JSON.stringify(r.data) }] };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: r.code, message: r.message }) }] };
}

function buildServer(work: FakeWork, agent: string): McpServer {
  const mcp = new McpServer({ name: 'wook-fake', version: '0.0.1' }, { capabilities: { tools: {} } });
  for (const spec of TOOL_SPECS as readonly ToolSpec[]) {
    mcp.registerTool(spec.name, { description: spec.description, inputSchema: SCHEMAS.get(spec.name)! }, () => ({ content: [] }));
  }
  // 실제 서버처럼 tools/call을 직접 처리한다: 카탈로그 형식으로 입력을 검사하고 거부도 기록한다
  mcp.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const schema = SCHEMAS.get(name);
    if (!schema) return toCallResult(work.reject(agent, name, args, 'not_found', `'${name}' 도구는 없습니다`));
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return toCallResult(work.reject(agent, name, args, 'invalid', `입력값이 올바르지 않습니다 — ${detail}`));
    }
    return toCallResult(work.handle(agent, name, parsed.data as Record<string, unknown>));
  });
  return mcp;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rpcMethodOf(body: unknown): string | null {
  if (Array.isArray(body)) return body.map((b) => (b as { method?: string })?.method ?? '?').join(',');
  return typeof body === 'object' && body !== null && typeof (body as { method?: unknown }).method === 'string' ? (body as { method: string }).method : null;
}

export async function startFakeMcp(work: FakeWork, o: { style: 'sse' | 'json' }): Promise<FakeMcpServer> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; agent: string }>();
  const httpLog: HttpLogEntry[] = [];

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? '';
    const agent = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : null;
    const pv = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : null;
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'JSON이 아닙니다' }, id: null });
      return;
    }
    // SDK(hono)는 writeHead(상태, 헤더)로 바로 보내 getHeader로 읽을 수 없다 → writeHead에서 Content-Type을 잡는다
    let contentType: string | null = null;
    const target = res as unknown as { writeHead: (...a: unknown[]) => unknown };
    const writeHead = target.writeHead.bind(res);
    target.writeHead = (...a: unknown[]) => {
      for (const h of a.slice(1)) {
        if (Array.isArray(h)) {
          for (let i = 0; i + 1 < h.length; i += 2) if (String(h[i]).toLowerCase() === 'content-type') contentType = String(h[i + 1]);
        } else if (typeof h === 'object' && h !== null) {
          for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === 'content-type') contentType = String(v);
        }
      }
      return writeHead(...a);
    };
    res.on('finish', () => {
      const ct = contentType ?? (res.getHeader('content-type') !== undefined ? String(res.getHeader('content-type')) : null);
      httpLog.push({ agent, rpcMethod: rpcMethodOf(body), status: res.statusCode, sessionIdHeader: sid, protocolVersionHeader: pv, contentType: ct });
    });
    if (req.method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'POST만 받습니다' }, id: null });
      return;
    }
    if (!agent || !work.has(agent)) {
      sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: '토큰이 유효하지 않습니다' }, id: null });
      return;
    }

    if (o.style === 'json') {
      const server = buildServer(work, agent);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await server.close();
      }
      return;
    }

    let entry = sid ? sessions.get(sid) : undefined;
    if (sid && !entry) {
      sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: '세션이 없습니다' }, id: null });
      return;
    }
    if (!entry) {
      if (!isInitializeRequest(body)) {
        sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: '세션 없이 initialize 외 요청을 받았습니다' }, id: null });
        return;
      }
      const server = buildServer(work, agent);
      const created: { transport: StreamableHTTPServerTransport; server: McpServer; agent: string } = {
        server,
        agent,
        transport: new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        }),
      };
      await server.connect(created.transport);
      entry = created;
    } else if (entry.agent !== agent) {
      sendJson(res, 403, { jsonrpc: '2.0', error: { code: -32000, message: '다른 토큰의 세션입니다' }, id: null });
      return;
    }
    await entry.transport.handleRequest(req, res, body);
  }

  const http: Server = createServer((req, res) => {
    onRequest(req, res).catch((err: unknown) => {
      console.error('[시험 MCP 서버] 요청 처리 실패', err);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen({ host: '127.0.0.1', port: 0 }, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    httpLog,
    async stop() {
      for (const s of sessions.values()) await s.server.close();
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
