#!/usr/bin/env node
/**
 * 모의 외부 에이전트 (SERVER_DESIGN 4.5, 리드 결정 S7-6) — 시험이 띄운다. 실제 에이전트(그록봇 등)처럼 에이전트 API로 자리를 잡고(claim), heartbeat를 보내고,
 * 롱폴(work/next)로 일을 받아 진행을 알리고 도구를 부른 뒤 마친다. Node 24, 의존성 없음.
 *
 * 입력:
 *   키      WOOK_AGENT_KEY (환경 변수로만 — 명령 줄의 값은 다른 프로세스가 볼 수 있다)
 *   주소    --endpoint <agent-endpoint.json> 또는 WOOK_AGENT_URL (http://127.0.0.1:<port>/agent/v1)
 * 옵션:
 *   --scenario normal|silent|hold|handoff|reclaim   (기본 normal)
 *     normal  : 받은 일마다 진행 → get_overview → '모의 외부 에이전트: <첫 줄>'로 마침
 *     silent  : claim하고 일을 받으러 한 번 온 뒤(--wait-ms, 기본 0) 모든 요청을 멈춘다 — 받은 턴도 마치지 않는다 (프로세스는 살아 있다)
 *     hold    : 일 하나를 받아 진행만 알리고 마치지 않는다 — heartbeat는 계속 보내고, heartbeat마다 work/next를 한 번 해 본다(같은 일이 온다)
 *     handoff : 메시지에 [mock:handoff codex]가 있으면 hand_off_seat(launched:codex)를 부르고 마친다 (그 밖은 normal)
 *     reclaim : 첫 일을 받은 뒤 다시 claim한다(앞 임대는 lease_superseded) — 그 뒤는 normal
 *   --heartbeat-ms n   heartbeat 간격 (기본: claim의 답)
 *   --wait-ms n        롱폴 기다림 (기본: claim의 pollMaxMs)
 *   --turns n          n개 턴을 마치면 끝낸다 (기본 끝없음)
 *   --tools mcp|rest|both   도구를 부르는 길 (기본 mcp)
 *   --log <file>       JSONL 기록 (키·턴 토큰·임대 값은 쓰지 않는다)
 * 오류: lease_expired·stopped·lease_superseded·seat_changed를 받으면 다시 claim한다(정지 중·배정 전이면 기다렸다 다시). 401이면 3으로 끝난다. 서버에 닿지 못하면 5.
 * 서버 확인 (리드 결정 S7-19 C3·S7-23): --endpoint로 주소를 받았으면 시작할 때 한 번만 POST hello로 그 파일의 proof를 아는 서버인지 본다. 맞지 않거나 파일에
 * proof가 없으면 키를 보내지 않고 5로 끝난다. WOOK_AGENT_URL이면 하지 않는다. proof·nonce·mac은 기록에 쓰지 않는다.
 * 이것은 시험용 클라이언트다 — 실제 에이전트의 본보기가 아니다. 시작한 뒤의 요청은 연결마다 확인하지 않으므로, 서버가 다시 시작한 뒤 그 포트를 다른 프로그램이
 * 차지하면 키와 임대가 그쪽으로 갈 수 있다. 실제 에이전트는 wook(src/cli/agentCli.ts — 키·임대 ID·턴 토큰을 쓰는 연결마다 먼저 확인한다)을 쓰거나, 직접 붙으면
 * docs/AGENT_GUIDE.md 2절 '키를 보내기 전에 서버를 확인합니다 — 연결마다'를 따른다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const scenario = opt('scenario', 'normal');
const toolsVia = opt('tools', 'mcp');
const logFile = opt('log');
const maxTurns = opt('turns') ? Number(opt('turns')) : Infinity;
const KEY = process.env.WOOK_AGENT_KEY ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(ev, extra = {}) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), scenario, ev, ...extra })}\n`);
  } catch {
    // 기록하지 못해도 계속한다
  }
}

function endpoint() {
  const file = opt('endpoint');
  if (file) {
    const e = JSON.parse(readFileSync(file, 'utf8'));
    return { api: e.agentApi, mcp: e.mcp, proof: typeof e.proof === 'string' ? e.proof : '', fromFile: true };
  }
  if (process.env.WOOK_AGENT_URL) return { api: process.env.WOOK_AGENT_URL.replace(/\/+$/, ''), mcp: null, proof: '', fromFile: false };
  throw new Error('주소가 없습니다 — --endpoint <agent-endpoint.json> 또는 WOOK_AGENT_URL');
}

function exit(code, why) {
  log('exit', { code, why });
  process.exit(code);
}

/** HTTP 한 번 (연결 재사용 없음) */
function request(url, { method = 'POST', headers = {}, body = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = http.request(new URL(url), { method, agent: false, headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), Connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = buf.length ? JSON.parse(buf.toString('utf8')) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json, buf });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('시간 초과'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

const ep = endpoint();
const auth = { Authorization: `Bearer ${KEY}` };
let lease = null; // { leaseId, heartbeatMs, pollMaxMs, generation }
let needClaim = true;
let heartbeatTimer = null;
let turnsDone = 0;
let reclaimed = false;
let holding = false;

async function api(path, body, method = 'POST', timeoutMs) {
  let r;
  try {
    r = await request(`${ep.api}${path}`, { method, headers: auth, body: method === 'POST' ? (body ?? {}) : null, timeoutMs });
  } catch (e) {
    if (e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET') exit(5, `서버에 닿지 못함 (${e.code})`);
    throw e;
  }
  if (r.status === 401) exit(3, '401');
  return r;
}

/** 키를 보내기 전에 한 번(시작할 때만 — 시험용. wook은 연결마다 한다) — 듣는 쪽이 agent-endpoint.json의 proof를 아는지 (HMAC-SHA256(proof, nonce)). 키 머리는 싣지 않는다 */
async function proveServer() {
  if (!ep.fromFile) return;
  const proof = Buffer.from(ep.proof, 'base64url');
  if (proof.length !== 32) exit(5, '서버 확인값(proof)이 없는 주소 파일 — 키를 보내지 않음');
  const nonce = randomBytes(32);
  let r;
  try {
    r = await request(`${ep.api}/hello`, { body: { nonce: nonce.toString('base64url') }, timeoutMs: 5000 });
  } catch (e) {
    exit(5, `서버 확인(hello)에 닿지 못함 (${e?.code ?? '오류'}) — 키를 보내지 않음`);
  }
  const want = createHmac('sha256', proof).update(nonce).digest();
  const got = typeof r.json?.mac === 'string' ? Buffer.from(r.json.mac, 'base64url') : Buffer.alloc(0);
  const ok = r.status === 200 && r.json?.ok === true && got.length === want.length && timingSafeEqual(got, want);
  log('hello', { status: r.status, ok });
  if (!ok) exit(5, '서버 확인(hello)이 맞지 않음 — 키를 보내지 않음');
}

const RECLAIM = new Set(['lease_expired', 'stopped', 'lease_superseded', 'seat_changed']);

async function claim() {
  for (;;) {
    const r = await api('/seat/claim', { label: '모의 외부 에이전트' });
    if (r.status === 200 && r.json?.ok) {
      lease = { leaseId: r.json.leaseId, heartbeatMs: Number(opt('heartbeat-ms')) || r.json.heartbeatMs, pollMaxMs: r.json.pollMaxMs, generation: r.json.generation };
      needClaim = false;
      log('claim', { status: 200, generation: lease.generation, agentId: r.json.agentId, hasRules: typeof r.json.rules === 'string' && r.json.rules.length > 0 });
      startHeartbeat();
      return;
    }
    log('claim', { status: r.status, code: r.json?.error?.code ?? null });
    await sleep(Number(opt('heartbeat-ms')) || 500);
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (scenario === 'silent') return;
  heartbeatTimer = setInterval(async () => {
    if (!lease || needClaim) return;
    try {
      const r = await api('/seat/heartbeat', { leaseId: lease.leaseId });
      log('heartbeat', { status: r.status, code: r.json?.error?.code ?? null, state: r.json?.state ?? null });
      if (r.status === 409 && RECLAIM.has(r.json?.error?.code)) needClaim = true;
    } catch (e) {
      log('heartbeat-error', { error: String(e?.message ?? e) });
    }
  }, lease.heartbeatMs);
}

/** 도구 하나 — MCP 또는 REST */
async function callTool(item, name, args, via) {
  if (via === 'mcp') {
    const r = await request(item.mcp.url, {
      headers: { Authorization: `Bearer ${item.mcp.token}`, Accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    const text = r.json?.result?.content?.[0]?.text ?? null;
    const isError = !!r.json?.result?.isError;
    log('tool', { via, name, status: r.status, ok: r.status === 200 && !isError, error: isError ? (JSON.parse(text ?? '{}').error ?? null) : null });
    return { status: r.status, ok: r.status === 200 && !isError };
  }
  const r = await request(`${ep.api}/tool/${name}`, { headers: { ...auth, 'X-Wook-Turn-Token': item.mcp.token }, body: args });
  log('tool', { via, name, status: r.status, ok: r.status === 200 && r.json?.ok === true, error: r.json?.error?.code ?? null });
  return { status: r.status, ok: r.status === 200 && r.json?.ok === true };
}

/** 메시지에서 이 턴의 일 첫 줄 (첫 업무 절의 인용 줄 가운데 머리말('대표 명령 (…):'처럼 ':'로 끝나는 줄)이 아닌 첫 줄, 없으면 첫 줄) */
function firstWorkLine(message) {
  const lines = String(message ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^### \d+\./.test(l));
  if (at >= 0) {
    const quoted = [];
    for (const l of lines.slice(at + 1)) {
      if (!l.startsWith('>')) break;
      if (l.slice(1).trim()) quoted.push(l.slice(1).trim());
    }
    // 다시 넣은 일은 앞에 까닭 한 줄과 '(다시 전달) '이 붙는다 — 그 뒤의 원래 글로 본다
    const again = quoted.findIndex((l) => l.startsWith('(다시 전달) '));
    const body = again >= 0 ? [quoted[again].slice('(다시 전달) '.length), ...quoted.slice(again + 1)] : quoted;
    const q = body.find((l) => !l.endsWith(':')) ?? body[0];
    if (q) return q;
  }
  return (lines.find((l) => l.trim()) ?? '').trim();
}

async function work(item) {
  const turnId = item.turnId;
  log('work', { turnId, kind: item.kind, workKey: item.workKey, generation: item.generation, hasInstructions: !!item.instructions, hasToken: typeof item.mcp?.token === 'string' });
  const progress = await api(`/work/${turnId}/progress`, { leaseId: lease.leaseId, text: '모의 외부 에이전트: 일을 시작합니다' });
  log('progress', { turnId, status: progress.status, code: progress.json?.error?.code ?? null });
  if (scenario === 'hold') {
    holding = true;
    log('hold', { turnId });
    // 마치지 않는다. heartbeat는 계속, 일 받기(work/next)도 heartbeat마다 한 번 — 턴이 살아 있으면 같은 일이 곧바로 온다
    const held = lease.leaseId;
    setInterval(async () => {
      // 받은 임대로 계속 해 본다 (정지·교체 뒤의 거부도 기록한다)
      const n = await api('/work/next', { leaseId: held, waitMs: 0 }, 'POST', 30_000).catch(() => null);
      if (n) log('next-while-holding', { status: n.status, code: n.json?.error?.code ?? null, sameTurn: n.json?.turnId === turnId });
    }, lease.heartbeatMs);
    return;
  }
  if (scenario === 'reclaim' && !reclaimed) {
    reclaimed = true;
    const old = lease.leaseId;
    await claim();
    // 앞 임대로 그 턴을 마치려 하면 lease_superseded
    const r = await api(`/work/${turnId}/finish`, { leaseId: old, finalText: '앞 임대로 마침', outcome: 'completed' });
    log('finish-old-lease', { turnId, status: r.status, code: r.json?.error?.code ?? null });
    return;
  }
  let finalText = `모의 외부 에이전트: ${firstWorkLine(item.message)}`;
  if (scenario === 'handoff' && String(item.message).includes('[mock:handoff codex]')) {
    const vias = toolsVia === 'both' ? ['mcp'] : [toolsVia];
    for (const via of vias) await callTool(item, 'hand_off_seat', { to: 'launched:codex', reason: '대표 명령: Codex에게 메인 자리를 넘김', note: '모의 외부 에이전트가 넘깁니다' }, via);
    finalText = '모의 외부 에이전트: Codex에게 메인 자리를 넘깁니다';
  } else {
    const vias = toolsVia === 'both' ? ['mcp', 'rest'] : [toolsVia];
    for (const via of vias) await callTool(item, 'get_overview', {}, via);
  }
  const r = await api(`/work/${turnId}/finish`, { leaseId: lease.leaseId, finalText, outcome: 'completed' });
  log('finish', { turnId, status: r.status, code: r.json?.error?.code ?? null, endReason: r.json?.endReason ?? null });
  if (r.status === 409 && RECLAIM.has(r.json?.error?.code)) needClaim = true;
  turnsDone += 1;
  if (turnsDone >= maxTurns) exit(0, `${turnsDone}개 턴을 마침`);
}

async function main() {
  if (!KEY) exit(2, '키 없음 (WOOK_AGENT_KEY)');
  await proveServer();
  await claim();
  if (scenario === 'silent') {
    // 일을 받으러 한 번만 온다(--wait-ms, 기본 0 — 기다리는 일이 있으면 그 턴을 받는다). 그 뒤로는 어떤 요청도 보내지 않는다(턴을 마치지도 heartbeat도 없다)
    const waitMs = Number(opt('wait-ms')) || 0;
    const r = await api('/work/next', { leaseId: lease.leaseId, waitMs }, 'POST', waitMs + 30_000);
    log('silent', { status: r.status, turnId: r.json?.turnId ?? null });
    setInterval(() => undefined, 60_000);
    return;
  }
  for (;;) {
    if (needClaim) await claim();
    if (holding) {
      await sleep(200);
      continue;
    }
    const waitMs = Number(opt('wait-ms')) || lease.pollMaxMs;
    const r = await api('/work/next', { leaseId: lease.leaseId, waitMs }, 'POST', waitMs + 30_000);
    if (r.status === 204) continue;
    if (r.status === 200 && r.json?.ok) {
      await work(r.json);
      continue;
    }
    log('next', { status: r.status, code: r.json?.error?.code ?? null });
    if (r.status === 409 && RECLAIM.has(r.json?.error?.code)) needClaim = true;
    else await sleep(200);
  }
}

main().catch((e) => {
  log('crash', { error: String(e?.message ?? e) });
  process.exit(1);
});
