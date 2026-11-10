import { request as httpRequest } from 'node:http';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAppToolServer } from './server';
import { TOOL_SPECS, toolSpec, type ToolRole, type ToolSpec } from './catalog';
import type { AppToolServer, TokenIdentity, ToolCallLog, ToolCallResult, ToolHandler } from './types';

// ───────── 준비 ─────────

/** 카탈로그의 역할 표시로 기대 목록을 만든다 (역할 → 도구 역할 연결은 15.3 표대로 테스트에 따로 적는다) */
function namesFor(roles: ToolRole[]): string[] {
  return (TOOL_SPECS as readonly ToolSpec[])
    .filter((s) => s.roles.some((r) => roles.includes(r)))
    .map((s) => s.name)
    .sort();
}
const MAIN_TOOLS = namesFor(['main']);
const PRODUCER_TOOLS = namesFor(['member', 'producer', 'reviewer']);
const MEMBER_TOOLS = namesFor(['member']);
const QA_TOOLS = namesFor(['member', 'reviewer']);

function identity(over: Partial<TokenIdentity> = {}): TokenIdentity {
  return {
    turnId: 'TN-000001',
    sessionId: 'S-000001',
    sessionKey: 'task:T-0001',
    sessionKind: 'task',
    memberId: 'M-0002',
    projectId: 'P-0001',
    isMain: false,
    isProducer: false,
    canReview: false,
    ...over,
  };
}

const MAIN = identity({ memberId: 'M-MAIN', projectId: 'P-0001', sessionKind: 'main_project', sessionKey: 'main:P-0001', isMain: true });
const PRODUCER = identity({ memberId: 'M-0001', sessionKind: 'directive', sessionKey: 'directive:D-0001', isProducer: true, canReview: true });
const MEMBER = identity({ memberId: 'M-0002' });
const QA = identity({ memberId: 'M-0003', sessionKind: 'review', sessionKey: 'review:T-0001', canReview: true });

interface Harness {
  server: AppToolServer;
  url: string;
  port: number;
  logs: ToolCallLog[];
  handler: ReturnType<typeof vi.fn<ToolHandler>>;
}

const servers: AppToolServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await Promise.allSettled(servers.splice(0).map((s) => s.stop()));
});

async function startHarness(impl?: ToolHandler, port?: number): Promise<Harness> {
  const logs: ToolCallLog[] = [];
  const handler = vi.fn<ToolHandler>(impl ?? (async (who, tool) => ({ ok: true, data: { tool, memberId: who.memberId } })));
  const server = createAppToolServer({ handler, onCall: (log) => logs.push(log), port });
  servers.push(server);
  const started = await server.start();
  return { server, url: started.url, port: started.port, logs, handler };
}

async function connect(url: string, token: string | null): Promise<Client> {
  const client = new Client({ name: 'wook-test', version: '1.0.0' });
  const headers: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` };
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  clients.push(client);
  await client.connect(transport);
  return client;
}

type CallResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: CallResult): string {
  const content = result.content as { type: string; text?: string }[];
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return content[0].text ?? '';
}

function errorOf(result: CallResult): { error: string; message: string } {
  expect(result.isError).toBe(true);
  return JSON.parse(textOf(result)) as { error: string; message: string };
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

function rawPost(url: string, token: string | null, payload: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...extra },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

/** fetch는 Host 헤더를 바꿀 수 없어 node:http로 보낸다 */
function httpRaw(
  port: number,
  opts: { method: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: opts.method, path: opts.path ?? '/mcp', headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ───────── 도구 목록 (역할별 공개) ─────────

describe('tools/list — 역할별 공개 (15.3 표, CLI-08)', () => {
  it('메인 에이전트는 메인 도구와 get_work_context·send_message만 본다', async () => {
    const h = await startHarness();
    const client = await connect(h.url, h.server.issueToken(MAIN));
    const names = await toolNames(client);
    expect(names).toEqual(MAIN_TOOLS);
    expect(names).toEqual(expect.arrayContaining(['get_work_context', 'send_message', 'register_directive', 'ask_owner', 'submit_report', 'write_memory']));
    // 대표에게서 옮겨 온 운영 도구 (SERVER_DESIGN 2.6)
    expect(names).toEqual(expect.arrayContaining(['update_project', 'pause_project', 'resume_project', 'update_member', 'replace_producer', 'pause_member', 'resume_member']));
    expect(names).toEqual(expect.arrayContaining(['interrupt_member', 'interrupt_task', 'resume_task', 'cancel_directive', 'resolve_recovery', 'update_settings', 'set_skill_mode']));
    expect(names).toEqual(expect.arrayContaining(['list_roles', 'create_role', 'update_role', 'delete_role', 'recheck_ai', 'backup_now', 'search_activity']));
    // 메인 전용이 아닌 도구는 공통 두 개와, 프로듀서 도구를 메인에게도 연 작업 취소·검수자 정하기뿐 (2.6 cancel_task·assign_reviewer — 리드 결정 48·S5-11)
    expect(names.filter((n) => toolSpec(n)?.roles.join() !== 'main')).toEqual(['assign_reviewer', 'cancel_task', 'get_work_context', 'send_message']);
    for (const other of ['create_task', 'request_merge', 'complete_step', 'submit_for_review', 'submit_review', 'get_review_target']) {
      expect(names).not.toContain(other);
    }
  });

  it('프로듀서는 프로듀서·팀원·검수 도구를 모두 본다', async () => {
    const h = await startHarness();
    const client = await connect(h.url, h.server.issueToken(PRODUCER));
    const names = await toolNames(client);
    expect(names).toEqual(PRODUCER_TOOLS);
    expect(names).toEqual(
      expect.arrayContaining(['create_task', 'assign_reviewer', 'request_merge', 'submit_final_result', 'complete_step', 'submit_review', 'get_review_target', 'send_message']),
    );
    for (const mainOnly of ['register_directive', 'create_project', 'submit_report', 'write_memory']) expect(names).not.toContain(mainOnly);
  });

  it('검수 권한 없는 팀원은 submit_review·get_review_target을 보지 못하고, 권한 있는 팀원은 본다', async () => {
    const h = await startHarness();
    const member = await connect(h.url, h.server.issueToken(MEMBER));
    const memberNames = await toolNames(member);
    expect(memberNames).toEqual(MEMBER_TOOLS);
    expect(memberNames).toEqual(expect.arrayContaining(['get_work_context', 'send_message', 'set_steps', 'complete_step', 'submit_for_review', 'ask_producer']));
    for (const hidden of ['submit_review', 'get_review_target', 'create_task', 'register_directive']) expect(memberNames).not.toContain(hidden);

    const qa = await connect(h.url, h.server.issueToken(QA));
    const qaNames = await toolNames(qa);
    expect(qaNames).toEqual(QA_TOOLS);
    expect(qaNames).toEqual(expect.arrayContaining(['submit_review', 'get_review_target', 'complete_step']));
    expect(qaNames).not.toContain('create_task');
  });

  it('카탈로그 설명과 zod 입력 형식이 JSON Schema로 공개된다 (zod v4)', async () => {
    const h = await startHarness();
    const client = await connect(h.url, h.server.issueToken(QA));
    const { tools } = await client.listTools();
    const review = tools.find((t) => t.name === 'submit_review');
    expect(review?.description).toContain('검수 결과를 등록합니다');
    const schema = review?.inputSchema as { type: string; properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required.sort()).toEqual(['criteria', 'task_id', 'verdict']);
    expect(schema.properties.verdict).toMatchObject({ type: 'string', enum: ['pass', 'reject'] });
    expect(schema.properties.criteria).toMatchObject({ type: 'array', minItems: 1, items: { type: 'object', required: ['criterion', 'pass'] } });
    expect(schema.properties.request_id).toMatchObject({ type: 'string', maxLength: 120 });
    // 인자 없는 도구도 객체 스키마로 공개
    expect(tools.find((t) => t.name === 'get_work_context')?.inputSchema).toMatchObject({ type: 'object', properties: {} });
  });
});

// ───────── 도구 호출 ─────────

describe('tools/call — 처리기 연결과 결과 모양', () => {
  it('get_work_context가 토큰 주인 신원 그대로 처리기에 도달하고, data가 JSON 문자열로 돌아온다', async () => {
    const data = { instructions: '지금 할 일: 단계 등록', task: { id: 'T-0001', title: '로그인 화면 — 한글 경로 C:\\작업 폴더' } };
    const h = await startHarness(async () => ({ ok: true, data }));
    const client = await connect(h.url, h.server.issueToken(MEMBER));
    const result = await client.callTool({ name: 'get_work_context', arguments: {} });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(JSON.stringify(data));
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler).toHaveBeenCalledWith(MEMBER, 'get_work_context', {});

    expect(h.logs).toHaveLength(1);
    const log = h.logs[0];
    expect(log.identity).toEqual(MEMBER);
    expect(log.tool).toBe('get_work_context');
    expect(log.args).toEqual({});
    expect(log.result).toEqual({ ok: true, data });
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(log.at).toISOString()).toBe(log.at);
  });

  it('zod로 검사·기본값이 채워진 인자가 처리기로 간다', async () => {
    const h = await startHarness(async () => ({ ok: true, data: { reportId: 'R-0001' } }));
    const client = await connect(h.url, h.server.issueToken(MAIN));
    await client.callTool({ name: 'submit_report', arguments: { summary: '요약', results: '결과', how_to_verify: '확인 방법', 모름: 1 } });
    expect(h.handler).toHaveBeenCalledWith(MAIN, 'submit_report', {
      summary: '요약',
      results: '결과',
      how_to_verify: '확인 방법',
      changed_files: [],
      issues: '',
      next_steps: '',
    });
  });

  it('입력 검사 실패 → isError invalid + 한국어 사유, 처리기는 부르지 않는다', async () => {
    const h = await startHarness();
    const client = await connect(h.url, h.server.issueToken(PRODUCER));
    const result = await client.callTool({
      name: 'create_task',
      arguments: { directive_id: 'D-0001', title: '', type: 'unknown', assignee_id: 7, acceptance_criteria: [], output_mode: 'repo' },
    });
    const err = errorOf(result);
    expect(err.error).toBe('invalid');
    expect(err.message).toMatch(/^입력값이 올바르지 않습니다/);
    expect(err.message).toContain('goal: 필수 항목입니다');
    expect(err.message).toContain('title: 비어 있으면 안 됩니다');
    expect(err.message).toContain('type: 다음 값 중 하나여야 합니다: plan, spec');
    expect(err.message).toContain('assignee_id: 문자열 값이어야 합니다 (받은 값: 정수)');
    expect(err.message).toContain('acceptance_criteria: 항목이 1개 이상이어야 합니다');
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ identity: PRODUCER, tool: 'create_task', result: { ok: false, code: 'invalid' } });
    // 기록에는 에이전트가 보낸 인자 원문
    expect(h.logs[0].args).toMatchObject({ title: '', assignee_id: 7 });
  });

  it('중첩 항목의 경로·정수·최대 길이 사유도 한국어로 나온다', async () => {
    const h = await startHarness();
    const qa = await connect(h.url, h.server.issueToken(QA));
    const review = errorOf(
      await qa.callTool({ name: 'submit_review', arguments: { task_id: 'T-0001', verdict: 'pass', criteria: [{ criterion: '동작', pass: 'yes' }] } }),
    );
    expect(review.error).toBe('invalid');
    expect(review.message).toContain('criteria[0].pass: true/false 값이어야 합니다 (받은 값: 문자열)');

    const step = errorOf(await qa.callTool({ name: 'complete_step', arguments: { step_index: 1.5, note: 'x'.repeat(2001) } }));
    expect(step.message).toContain('step_index: 정수 값이어야 합니다 (받은 값: 숫자)');
    expect(step.message).toContain('note: 2000자 이하여야 합니다');
    expect(h.handler).not.toHaveBeenCalled();
  });

  it('처리기 예외 → isError error + 한국어 사유, 서버는 계속 동작한다', async () => {
    let fail = true;
    const h = await startHarness(async () => {
      if (fail) throw new Error('database is locked');
      return { ok: true, data: { fine: true } };
    });
    const client = await connect(h.url, h.server.issueToken(MEMBER));
    const err = errorOf(await client.callTool({ name: 'get_work_context', arguments: {} }));
    expect(err).toEqual({ error: 'error', message: '도구 처리 중 오류가 발생했습니다: database is locked' });
    expect(h.logs[0].result).toEqual({ ok: false, code: 'error', message: '도구 처리 중 오류가 발생했습니다: database is locked' });

    fail = false;
    const ok = await client.callTool({ name: 'get_work_context', arguments: {} });
    expect(textOf(ok)).toBe('{"fine":true}');
  });

  it('처리기가 거부(ok:false)하면 그 코드와 사유를 그대로 돌려준다', async () => {
    const h = await startHarness(async () => ({ ok: false, code: 'conflict', message: '이미 다른 팀원이 검수 중입니다' }));
    const client = await connect(h.url, h.server.issueToken(QA));
    const err = errorOf(await client.callTool({ name: 'get_review_target', arguments: { task_id: 'T-0001' } }));
    expect(err).toEqual({ error: 'conflict', message: '이미 다른 팀원이 검수 중입니다' });
    expect(h.logs[0].result).toEqual({ ok: false, code: 'conflict', message: '이미 다른 팀원이 검수 중입니다' });
  });

  it('메인 자리가 바뀐 뒤의 이전 세대 메인 토큰 거부(seat_changed)도 그 코드 그대로 돌려준다 (리드 결정 S4-4)', async () => {
    const message = '메인 자리가 바뀌었습니다 (이 턴은 세대 1, 지금은 세대 2) — 이 요청(read_memory)은 처리하지 않았습니다. 지금 턴을 마치세요';
    const h = await startHarness(async () => ({ ok: false, code: 'seat_changed', message }));
    const client = await connect(h.url, h.server.issueToken({ ...MAIN, seatGeneration: 1 }));
    expect(errorOf(await client.callTool({ name: 'read_memory', arguments: {} }))).toEqual({ error: 'seat_changed', message });
    expect(h.logs[0]!.result).toEqual({ ok: false, code: 'seat_changed', message });
    // 처리기가 받은 신원에 세대가 그대로 있다
    expect(h.handler.mock.calls[0]![0].seatGeneration).toBe(1);
  });

  it('JSON으로 바꿀 수 없는 처리기 결과는 isError error로 돌려준다', async () => {
    const h = await startHarness(async () => ({ ok: true, data: { big: BigInt(1) } }));
    const client = await connect(h.url, h.server.issueToken(MEMBER));
    const err = errorOf(await client.callTool({ name: 'get_work_context', arguments: {} }));
    expect(err.error).toBe('error');
    expect(err.message).toContain('JSON');
  });

  it('역할 밖 도구 호출 → isError forbidden, 처리기는 부르지 않고 기록한다', async () => {
    const h = await startHarness();
    const member = await connect(h.url, h.server.issueToken(MEMBER));
    const err = errorOf(
      await member.callTool({ name: 'submit_review', arguments: { task_id: 'T-0001', verdict: 'pass', criteria: [{ criterion: 'a', pass: true }] } }),
    );
    expect(err.error).toBe('forbidden');
    expect(err.message).toContain('submit_review');
    expect(err.message).toContain('팀원');

    const main = await connect(h.url, h.server.issueToken(MAIN));
    expect(errorOf(await main.callTool({ name: 'complete_step', arguments: { step_index: 0 } })).error).toBe('forbidden');

    expect(h.handler).not.toHaveBeenCalled();
    expect(h.logs.map((l) => [l.identity?.memberId, l.tool, l.result.ok ? 'ok' : l.result.code])).toEqual([
      ['M-0002', 'submit_review', 'forbidden'],
      ['M-MAIN', 'complete_step', 'forbidden'],
    ]);
  });

  it('없는 도구 → isError not_found', async () => {
    const h = await startHarness();
    const client = await connect(h.url, h.server.issueToken(PRODUCER));
    const err = errorOf(await client.callTool({ name: 'delete_everything', arguments: {} }));
    expect(err.error).toBe('not_found');
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.logs[0]).toMatchObject({ tool: 'delete_everything', result: { ok: false, code: 'not_found' } });
  });

  it('여러 조각으로 나뉘어 오는 큰 한글 본문도 깨지지 않는다', async () => {
    const h = await startHarness(async (_who, _tool, args) => ({ ok: true, data: { length: String(args.content).length } }));
    const client = await connect(h.url, h.server.issueToken(MAIN));
    const content = '대표 선호: 한글 경로 C:\\내 문서\\욱채 프로젝트 — '.repeat(2500).slice(0, 59_999);
    expect(content).toHaveLength(59_999);
    const result = await client.callTool({ name: 'write_memory', arguments: { project_id: 'P-0001', content } });
    expect(JSON.parse(textOf(result))).toEqual({ length: 59_999 });
    expect(h.handler.mock.calls[0][2].content).toBe(content);
  });

  it('두 토큰의 동시 호출이 섞이지 않는다', async () => {
    const h = await startHarness(async (who, _tool, args) => {
      await new Promise((r) => setTimeout(r, Number(args.delay ?? 0)));
      return { ok: true, data: { memberId: who.memberId, turnId: who.turnId, seq: args.text } };
    });
    const a = identity({ memberId: 'M-0010', turnId: 'TN-000010', sessionId: 'S-000010' });
    const b = identity({ memberId: 'M-0020', turnId: 'TN-000020', sessionId: 'S-000020' });
    const clientA = await connect(h.url, h.server.issueToken(a));
    const clientB = await connect(h.url, h.server.issueToken(b));

    const jobs: Promise<{ who: string; data: { memberId: string; turnId: string; seq: string } }>[] = [];
    for (let i = 0; i < 15; i++) {
      for (const [who, client] of [
        ['M-0010', clientA],
        ['M-0020', clientB],
      ] as const) {
        jobs.push(
          client
            .callTool({ name: 'send_message', arguments: { to: 'producer', text: `${who}-${i}`, delay: (i * 7) % 11 } })
            .then((r) => ({ who, data: JSON.parse(textOf(r)) as { memberId: string; turnId: string; seq: string } })),
        );
      }
    }
    const results = await Promise.all(jobs);
    for (const { who, data } of results) {
      expect(data.memberId).toBe(who);
      expect(data.seq.startsWith(`${who}-`)).toBe(true);
      expect(data.turnId).toBe(who === 'M-0010' ? 'TN-000010' : 'TN-000020');
    }
    for (const [who, , args] of h.handler.mock.calls) {
      expect(String(args.text).startsWith(`${who.memberId}-`)).toBe(true);
    }
    expect(h.logs).toHaveLength(30);
    for (const log of h.logs) expect(String(log.args.text).startsWith(`${log.identity?.memberId}-`)).toBe(true);
  });
});

// ───────── 인증·접속 제한 ─────────

describe('인증과 접속 제한 (ENV-02, AC-32)', () => {
  it('토큰은 32바이트 base64url이고 매번 다르며, 발급 뒤 원본을 바꿔도 주인 정보는 그대로다', async () => {
    const h = await startHarness();
    const original = identity({ memberId: 'M-0042', turnId: 'TN-000042' });
    const token = h.server.issueToken(original);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.server.issueToken(original)).not.toBe(token);

    original.memberId = 'M-HACKED';
    original.isMain = true;
    const client = await connect(h.url, token);
    expect(await toolNames(client)).toEqual(MEMBER_TOOLS);
    await client.callTool({ name: 'get_work_context', arguments: {} });
    expect(h.handler.mock.calls[0][0]).toMatchObject({ memberId: 'M-0042', turnId: 'TN-000042', isMain: false });
  });

  it('폐기된 토큰 → 401, identity null로 기록', async () => {
    const h = await startHarness();
    const token = h.server.issueToken(MEMBER);
    const client = await connect(h.url, token);
    await client.callTool({ name: 'get_work_context', arguments: {} });

    h.server.revokeToken(token);
    await expect(client.callTool({ name: 'complete_step', arguments: { step_index: 0 } })).rejects.toMatchObject({ code: 401 });
    expect(h.handler).toHaveBeenCalledTimes(1);
    const denied = h.logs.at(-1);
    expect(denied).toMatchObject({
      identity: null,
      tool: 'complete_step',
      args: { step_index: 0 },
      result: { ok: false, code: 'unauthorized' },
    });
    expect(denied?.result.ok === false && denied.result.message).toContain('폐기');

    // 새 연결(initialize)도 401
    await expect(connect(h.url, token)).rejects.toMatchObject({ code: 401 });
  });

  it('revokeTurn은 그 턴의 토큰만 폐기한다', async () => {
    const h = await startHarness();
    const t1a = h.server.issueToken(identity({ turnId: 'TN-1', memberId: 'M-0001' }));
    const t1b = h.server.issueToken(identity({ turnId: 'TN-1', memberId: 'M-0002' }));
    const t2 = h.server.issueToken(identity({ turnId: 'TN-2', memberId: 'M-0003' }));
    h.server.revokeTurn('TN-1');
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_work_context', arguments: {} } };
    expect((await rawPost(h.url, t1a, call)).status).toBe(401);
    expect((await rawPost(h.url, t1b, call)).status).toBe(401);
    expect((await rawPost(h.url, t2, call)).status).toBe(200);
  });

  it('revokeWhere는 조건에 맞는 토큰만 폐기하고 지운 수를 돌려준다 — 메인 자리 교체의 revokeWhere(isMain) (SERVER_DESIGN 4.3 4번, S4-3)', async () => {
    const h = await startHarness();
    const mainA = h.server.issueToken({ ...MAIN, turnId: 'TN-1', seatGeneration: 1 });
    const mainB = h.server.issueToken({ ...MAIN, turnId: 'TN-2', sessionKey: 'review:T-0001', sessionKind: 'review', seatGeneration: 1 });
    const member = h.server.issueToken(identity({ turnId: 'TN-3' }));
    const producer = h.server.issueToken(identity({ turnId: 'TN-4', memberId: 'M-0001', isProducer: true }));
    expect(h.server.revokeWhere!((who) => who.isMain)).toBe(2);
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_work_context', arguments: {} } };
    expect((await rawPost(h.url, mainA, call)).status).toBe(401);
    expect((await rawPost(h.url, mainB, call)).status).toBe(401);
    expect((await rawPost(h.url, member, call)).status).toBe(200);
    expect((await rawPost(h.url, producer, call)).status).toBe(200);
    // 남은 메인 토큰이 없으면 0
    expect(h.server.revokeWhere!((who) => who.isMain)).toBe(0);
  });

  it('토큰 없음·모르는 토큰 → 401 + JSON-RPC 오류 본문 + WWW-Authenticate', async () => {
    const h = await startHarness();
    const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask_producer', arguments: { question: '질문' } } };

    const missing = await rawPost(h.url, null, call);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="wook"');
    expect(await missing.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'Authorization: Bearer <토큰> 헤더가 없습니다' }, id: 7 });

    const unknown = await rawPost(h.url, 'not-a-real-token', call);
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get('www-authenticate')).toBe('Bearer realm="wook", error="invalid_token"');
    const body = (await unknown.json()) as { error: { code: number; message: string }; id: number };
    expect(body.error.code).toBe(-32001);
    expect(body.id).toBe(7);

    const wrongScheme = await rawPost(h.url, null, call, { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` });
    expect(wrongScheme.status).toBe(401);
    expect(wrongScheme.headers.get('www-authenticate')).toBe('Bearer realm="wook", error="invalid_request"');
    expect(((await wrongScheme.json()) as { error: { message: string } }).error.message).toBe('Authorization 헤더가 "Bearer <토큰>" 형식이 아닙니다');

    expect(h.handler).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(3);
    for (const log of h.logs) {
      expect(log).toMatchObject({ identity: null, tool: 'ask_producer', args: { question: '질문' }, result: { ok: false, code: 'unauthorized' } });
    }
  });

  it('SDK 클라이언트도 토큰 없이는 연결(initialize)하지 못한다', async () => {
    const h = await startHarness();
    await expect(connect(h.url, null)).rejects.toMatchObject({ code: 401 });
    expect(h.logs).toEqual([expect.objectContaining({ identity: null, tool: 'initialize', result: expect.objectContaining({ code: 'unauthorized' }) })]);
  });

  it('Host 헤더가 루프백 주소가 아니면 403 (DNS 리바인딩 방지)', async () => {
    const h = await startHarness();
    const token = h.server.issueToken(MEMBER);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_work_context', arguments: {} } });
    const headers = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };

    const evil = await httpRaw(h.port, { method: 'POST', headers: { ...headers, Host: `evil.example:${h.port}` }, body });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
    const wrongPort = await httpRaw(h.port, { method: 'POST', headers: { ...headers, Host: `127.0.0.1:${h.port + 1}` }, body });
    expect(wrongPort.status).toBe(403);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.logs.map((l) => [l.identity, l.result.ok ? 'ok' : l.result.code])).toEqual([
      [null, 'forbidden'],
      [null, 'forbidden'],
    ]);

    const local = await httpRaw(h.port, { method: 'POST', headers: { ...headers, Host: `localhost:${h.port}` }, body });
    expect(local.status).toBe(200);
    const loopback = await httpRaw(h.port, { method: 'POST', headers: { ...headers, Host: `127.0.0.1:${h.port}` }, body });
    expect(loopback.status).toBe(200);
    expect(h.handler).toHaveBeenCalledTimes(2);
  });

  it('127.0.0.1에만 열리고 다른 네트워크 주소로는 접속되지 않는다', async () => {
    const h = await startHarness();
    expect(h.server.url).toBe(h.url);
    const parsed = new URL(h.url);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(parsed.pathname).toBe('/mcp');
    expect(Number(parsed.port)).toBe(h.port);

    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal);
    if (lan === undefined) return; // 루프백 말고 주소가 없는 PC
    const reached = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host: lan.address, port: h.port });
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    expect(reached).toBe(false);
  });

  it('GET·DELETE → 405, 다른 경로 → 404, 4MB 초과 → 413, JSON 아님 → 400', async () => {
    const h = await startHarness();
    const token = h.server.issueToken(MEMBER);
    const auth = { Authorization: `Bearer ${token}` };

    const get = await fetch(h.url, { method: 'GET', headers: { ...auth, Accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(((await get.json()) as { error: { code: number } }).error.code).toBe(-32000);
    expect((await fetch(h.url, { method: 'DELETE', headers: auth })).status).toBe(405);

    const other = await fetch(new URL('/.well-known/oauth-protected-resource', h.url), { headers: auth });
    expect(other.status).toBe(404);

    const huge = await rawPost(h.url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { to: 'producer', text: 'x'.repeat(4 * 1024 * 1024) } },
    });
    expect(huge.status).toBe(413);

    const notJson = await rawPost(h.url, token, '{"jsonrpc": "2.0", ');
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: { code: number } }).error.code).toBe(-32700);

    expect(h.handler).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(0);
  });

  it('형식이 잘못된 tools/call(arguments가 객체 아님)도 invalid로 기록된다', async () => {
    const h = await startHarness();
    const token = h.server.issueToken(MEMBER);
    const res = await rawPost(h.url, token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'complete_step', arguments: 'step 0' } });
    expect(res.status).toBe(200);
    // SDK가 요청 형식 검사(zod)에서 거부: JSON-RPC 오류(-32603) 응답, 도구 결과(result)는 없다
    const body = (await res.json()) as { error?: { code: number }; result?: unknown; id: number };
    expect(body.id).toBe(9);
    expect(typeof body.error?.code).toBe('number');
    expect(body.result).toBeUndefined();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.logs).toEqual([
      expect.objectContaining({ identity: MEMBER, tool: 'complete_step', args: {}, result: expect.objectContaining({ ok: false, code: 'invalid' }) }),
    ]);
  });
});

// ───────── 날것의 HTTP (SDK 없이) — 모의 에이전트가 따를 형식 고정 ─────────

describe('날것의 HTTP 교환 (모의 에이전트용 형식)', () => {
  it('initialize → notifications/initialized → tools/list → tools/call', async () => {
    const h = await startHarness(async () => ({ ok: true, data: { step: 0, done: true, 메모: '완료' } }));
    const token = h.server.issueToken(MEMBER);

    const init = await rawPost(h.url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wook-mock', version: '1.0.0' } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toBe('application/json');
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect(await init.text()).toBe(
      '{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"wook","version":"0.1.0"}},"jsonrpc":"2.0","id":1}',
    );

    const initialized = await rawPost(h.url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Protocol-Version': '2025-06-18' });
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe('');

    const list = await rawPost(h.url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-06-18' });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { result: { tools: Record<string, unknown>[] }; jsonrpc: string; id: number };
    expect(listed.id).toBe(2);
    expect(listed.result.tools.map((t) => t.name).sort()).toEqual(MEMBER_TOOLS);
    expect(listed.result.tools.find((t) => t.name === 'get_work_context')).toEqual({
      name: 'get_work_context',
      description: toolSpec('get_work_context')?.description,
      inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} },
      execution: { taskSupport: 'forbidden' },
    });

    const call = await rawPost(
      h.url,
      token,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'complete_step', arguments: { step_index: 0, note: '완료', request_id: 'rq-1' } } },
      { 'MCP-Protocol-Version': '2025-06-18' },
    );
    expect(call.status).toBe(200);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(await call.text()).toBe('{"result":{"content":[{"type":"text","text":"{\\"step\\":0,\\"done\\":true,\\"메모\\":\\"완료\\"}"}]},"jsonrpc":"2.0","id":3}');
    expect(h.handler).toHaveBeenCalledWith(MEMBER, 'complete_step', { step_index: 0, note: '완료', request_id: 'rq-1' });

    const denied = await rawPost(h.url, token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'request_merge', arguments: { task_id: 'T-0001' } },
    });
    expect(denied.status).toBe(200);
    const deniedBody = await denied.text();
    expect(JSON.parse(deniedBody)).toEqual({
      result: {
        content: [{ type: 'text', text: expect.stringMatching(/^\{"error":"forbidden","message":".+"\}$/) as unknown }],
        isError: true,
      },
      jsonrpc: '2.0',
      id: 4,
    });
  });

  it('상태가 없어 initialize 없이 tools/call만 보내도 처리된다', async () => {
    const h = await startHarness();
    const token = h.server.issueToken(PRODUCER);
    const res = await rawPost(h.url, token, { jsonrpc: '2.0', id: 'a-1', method: 'tools/call', params: { name: 'get_work_context' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: { text: string }[] }; id: string };
    expect(body.id).toBe('a-1');
    expect(JSON.parse(body.result.content[0].text)).toEqual({ tool: 'get_work_context', memberId: 'M-0001' });
  });

  it('Accept에 text/event-stream이 없으면 406 (SDK 규칙)', async () => {
    const h = await startHarness();
    const token = h.server.issueToken(MEMBER);
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(406);
  });
});

// ───────── 시작·종료 ─────────

describe('시작·종료', () => {
  it('stop() 뒤에는 url이 null이고 접속이 끊기며, 다시 시작하면 이전 토큰은 쓸 수 없다', async () => {
    const h = await startHarness();
    const token = h.server.issueToken(MEMBER);
    const client = await connect(h.url, token);
    await client.callTool({ name: 'get_work_context', arguments: {} });

    await h.server.stop();
    expect(h.server.url).toBeNull();
    await expect(fetch(h.url, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).rejects.toThrow();
    await h.server.stop(); // 두 번 불러도 괜찮다

    const again = await h.server.start();
    expect(h.server.url).toBe(again.url);
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_work_context', arguments: {} } };
    expect((await rawPost(again.url, token, call)).status).toBe(401);
    expect((await rawPost(again.url, h.server.issueToken(MEMBER), call)).status).toBe(200);
  });

  it('start()를 겹쳐 불러도 서버는 하나다', async () => {
    const server = createAppToolServer({ handler: async () => ({ ok: true, data: null }), onCall: () => {} });
    servers.push(server);
    const [a, b] = await Promise.all([server.start(), server.start()]);
    expect(a).toEqual(b);
    expect(await server.start()).toEqual(a);
  });

  it('지정한 포트로 열고, 이미 쓰는 포트면 한국어 오류로 실패한다', async () => {
    const free = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer();
      probe.once('error', reject);
      probe.listen({ host: '127.0.0.1', port: 0 }, () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    const h = await startHarness(undefined, free);
    expect(h.port).toBe(free);
    expect(h.url).toBe(`http://127.0.0.1:${free}/mcp`);

    const second = createAppToolServer({ handler: async () => ({ ok: true, data: null }), onCall: () => {}, port: free });
    servers.push(second);
    await expect(second.start()).rejects.toThrow(/앱 도구 서버를 127\.0\.0\.1:\d+에서 시작하지 못했습니다 \(EADDRINUSE\)/);
    expect(second.url).toBeNull();

    const badPort = createAppToolServer({ handler: async () => ({ ok: true, data: null }), onCall: () => {}, port: 70_000 });
    servers.push(badPort);
    await expect(badPort.start()).rejects.toThrow(/앱 도구 서버를 127\.0\.0\.1:70000에서 시작하지 못했습니다/);
  });

  it('stop()은 진행 중인 처리기 호출이 끝날 때까지 기다리고, 종료 중 새 호출은 처리하지 않는다', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    let finished = false;
    const h = await startHarness(async () => {
      entered.resolve();
      await gate.promise;
      finished = true;
      return { ok: true, data: { saved: true } };
    });
    const token = h.server.issueToken(MEMBER);
    const pending = rawPost(h.url, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'complete_step', arguments: { step_index: 0 } } });
    pending.catch(() => undefined); // 연결이 끊겨 실패하는 것이 정상
    await entered.promise;

    let stopped = false;
    const stopping = h.server.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
    await expect(pending).rejects.toThrow();
    // 처리기는 끝까지 실행됐고 기록도 남았다
    expect(h.logs).toEqual([expect.objectContaining({ tool: 'complete_step', result: { ok: true, data: { saved: true } } })]);
  });

  it('onCall이 예외를 던져도 응답은 정상으로 나간다', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const server = createAppToolServer({
        handler: async () => ({ ok: true, data: { ok: 1 } }) satisfies ToolCallResult,
        onCall: () => {
          throw new Error('기록 저장 실패');
        },
      });
      servers.push(server);
      const { url } = await server.start();
      const client = await connect(url, server.issueToken(MEMBER));
      expect(textOf(await client.callTool({ name: 'get_work_context', arguments: {} }))).toBe('{"ok":1}');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('화면 도구의 이미지 결과·거부 코드·호출자별 설명 (리드 결정 S6-3·S6-6)', () => {
  /** 작은 PNG (서명 + 아무 바이트) */
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64');

  it('이미지는 글 블록 뒤에 MCP image 블록으로 간다 — PNG가 아니거나 base64가 아니거나 4MiB를 넘거나 셋째 장부터는 버리고, 기록(onCall)에는 이미지가 없다', async () => {
    const h = await startHarness(async () => ({
      ok: true,
      data: { capture_id: 'SC-000001' },
      images: [
        { mimeType: 'image/png', data: PNG },
        { mimeType: 'image/jpeg', data: PNG } as never,
        { mimeType: 'image/png', data: '%%%not base64%%%' },
        { mimeType: 'image/png', data: 'A'.repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4) },
        { mimeType: 'image/png', data: PNG },
        { mimeType: 'image/png', data: PNG },
      ],
    }));
    const client = await connect(h.url, h.server.issueToken(MAIN));
    const r = await client.callTool({ name: 'screen_capture', arguments: {} });
    const content = r.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(content.map((b) => [b.type, b.mimeType ?? null])).toEqual([
      ['text', null],
      ['image', 'image/png'],
      ['image', 'image/png'],
    ]);
    expect(JSON.parse(content[0]!.text!)).toEqual({ capture_id: 'SC-000001' });
    expect(content.slice(1).map((b) => b.data)).toEqual([PNG, PNG]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.result).toEqual({ ok: true, data: { capture_id: 'SC-000001' } });
    expect(JSON.stringify(h.logs)).not.toContain(PNG.slice(0, 20));
  });

  it('화면 조작의 거부 코드가 그대로 가고(TOOL_FAILURE_CODES 하나), 모르는 코드는 error다', async () => {
    const codes = ['unavailable', 'stale_capture', 'rate_limited', 'human_active', 'secret_blocked', 'denied_target', 'no_such_code'];
    let i = 0;
    const h = await startHarness(async () => ({ ok: false, code: codes[i++] as never, message: '거부' }));
    const client = await connect(h.url, h.server.issueToken(MAIN));
    const got: string[] = [];
    for (let k = 0; k < codes.length; k++) got.push(errorOf(await client.callTool({ name: 'gui_input', arguments: { action: 'release', request_id: `rq-${k}` } })).error);
    expect(got).toEqual(['unavailable', 'stale_capture', 'rate_limited', 'human_active', 'secret_blocked', 'denied_target', 'error']);
  });

  it('도구 설명은 호출자마다 describe가 정한다 — 던지면 카탈로그 글 그대로', async () => {
    const note = '이 보유자는 화면 이미지를 볼 수 없다고 확인됨';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const server = createAppToolServer({
        handler: async () => ({ ok: true, data: {} }),
        onCall: () => undefined,
        describe: (who, spec) => {
          if (who.memberId === 'M-0001') throw new Error('설명 오류');
          return spec.name === 'screen_capture' && who.isMain ? `${spec.description} ${note}` : spec.description;
        },
      });
      servers.push(server);
      const { url } = await server.start();
      const main = await connect(url, server.issueToken(MAIN));
      const tools = (await main.listTools()).tools;
      expect(tools.find((t) => t.name === 'screen_capture')?.description).toContain(note);
      expect(tools.find((t) => t.name === 'screen_info')?.description).toBe(toolSpec('screen_info')!.description);
      const producer = await connect(url, server.issueToken(PRODUCER));
      expect((await producer.listTools()).tools.find((t) => t.name === 'create_task')?.description).toBe(toolSpec('create_task')!.description);
    } finally {
      errors.mockRestore();
    }
  });
});
