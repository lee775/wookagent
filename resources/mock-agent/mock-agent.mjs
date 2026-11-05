#!/usr/bin/env node
/**
 * 욱채 모의 에이전트 — 기획서 16장(MOCK-01~07), ARCHITECTURE 14장.
 *
 * 실제 CLI처럼 턴 1번만 실행하고 끝난다.
 *   node mock-agent.mjs --format claude|codex (--session-id <id> | --resume <id>)  < 메시지(표준 입력)
 *
 * 출력: Claude Code `-p --output-format stream-json --verbose` 또는 Codex `exec --json`과 같은 모양의 JSON 줄.
 *       앱의 실제 파서(src/main/agents/parsers)가 그대로 해석한다 (MOCK-06). 모양은 __fixtures__의 실제 출력을 따른다.
 * 앱 도구: MCP Streamable HTTP를 직접 호출한다 (initialize → notifications/initialized → tools/list → tools/call).
 * 환경 변수: WOOK_MCP_URL, WOOK_MCP_TOKEN, (선택) WOOK_MCP_SERVER(기본 wook),
 *           WOOK_MOCK_SCENARIO, WOOK_MOCK_SPEED, WOOK_MOCK_ROLE, WOOK_MOCK_MEMBER, WOOK_MOCK_WORKKEY,
 *           WOOK_MOCK_TURN, WOOK_MOCK_STATE_DIR
 * 시나리오 상태(첫 턴 여부·질문·되돌리기 등)는 WOOK_MOCK_STATE_DIR에 키별 JSON 파일로 원자적으로 저장한다.
 * 외부 의존성 없음. git은 실행하지 않는다 (커밋은 complete_step으로 프로그램이 한다, CLI-09).
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const MOCK_VERSION = '1.0.0';
const MOCK_MODEL = 'mock';
/** 단계당 기본 대기 (MOCK-03: WOOK_MOCK_SPEED 배수만큼 줄인다) */
const BASE_STEP_MS = 1000;
const MIN_STEP_MS = 20;
const SLOW_FACTOR = 5;
const PROTOCOL_VERSION = '2025-06-18';
const MCP_TIMEOUT_MS = 120_000;
const SPIN_REPEAT = 5;
const USAGE_RESET_MIN = 30;
/** 같은 작업 재계획 상한 — spin 팀원처럼 매번 다시 보류되는 작업으로 계획·보류가 끝없이 돌지 않게 대표 판단에 맡긴다 */
const MAX_REPLANS_PER_TASK = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** src/shared/domain.ts MOCK_SCENARIOS와 같아야 한다 */
const SCENARIOS = new Set([
  'normal',
  'slow',
  'crash',
  'crash_loop',
  'hang',
  'spin',
  'bypass_mismatch',
  'answer_wait',
  'usage_limit',
  'review_violation',
  'triple_reject',
  'merge_conflict',
  'revert',
  'duplicate_tool',
]);

/** src/shared/labels.ts WORK_KIND_LABEL의 역방향 — 턴 메시지의 "### n. 이름" 구간을 업무 종류로 나눈다 */
const KIND_BY_LABEL = {
  작업: 'task_work',
  '충돌 해결': 'conflict_fix',
  검수: 'review',
  계획: 'plan',
  재계획: 'replan',
  '질문 응답': 'answer',
  '병합 판단': 'merge_decision',
  '최종 결과 정리': 'final_result',
  '검수자 배정': 'reviewer_assign',
  '명령 처리': 'main_command',
  '보고서 작성': 'main_report',
  '기억 갱신': 'memory_update',
  '수정 요청': 'change_request',
  '정지 해제': 'stop_released',
  '검수자 없음': 'no_reviewer',
  '보류·실패 처리': 'alert',
  '메시지 확인': 'message',
};
const LABEL_BY_KIND = Object.fromEntries(Object.entries(KIND_BY_LABEL).map(([label, kind]) => [kind, label]));

/** 한 턴에 여러 업무가 묶여 오면 이 순서로 처리한다 (최종 결과는 병합 요청 뒤, 충돌 해결은 작업 계속보다 먼저) */
const KIND_ORDER = [
  'conflict_fix',
  'task_work',
  'review',
  'answer',
  'replan',
  'reviewer_assign',
  'merge_decision',
  'plan',
  'final_result',
  'main_command',
  'main_report',
  'change_request',
  'stop_released',
  'no_reviewer',
  'alert',
  'memory_update',
  'message',
];

const TYPE_INFO = {
  development: { label: '개발', steps: ['요구사항과 기존 코드 확인', '기능 구현', '자체 점검과 정리'], criteria: ['요구한 기능이 작업 폴더에 구현되어 있다', '단계별 작업 기록(wook-mock)이 남아 있다'] },
  bugfix: { label: '버그 수정', steps: ['문제 재현', '원인 수정', '회귀 확인'], criteria: ['보고된 문제가 다시 나타나지 않는다', '수정 내용이 기록되어 있다'] },
  test: { label: '테스트', steps: ['테스트 범위 정리', '테스트 작성과 실행', '결과 정리'], criteria: ['핵심 흐름을 확인한 테스트 결과가 정리되어 있다', '발견한 문제가 기록되어 있다'] },
  docs: { label: '문서', steps: ['문서 구조 잡기', '본문 작성', '검토와 다듬기'], criteria: ['요청한 내용을 담은 문서가 있다', '문서가 읽기 쉽게 정리되어 있다'] },
  spec: { label: '기획', steps: ['요구사항 수집', '기획서 작성', '검토 정리'], criteria: ['요구사항과 범위가 기획서에 정리되어 있다', '열린 질문이 따로 표시되어 있다'] },
  research: { label: '조사', steps: ['조사 범위 정하기', '자료 조사', '조사 결과 정리'], criteria: ['조사 결과와 근거가 정리되어 있다', '추천안이 있다'] },
  architecture: { label: '설계', steps: ['현재 구조 파악', '설계안 작성', '설계 검토'], criteria: ['설계안과 선택 근거가 정리되어 있다', '영향 범위가 적혀 있다'] },
  design: { label: '디자인', steps: ['화면 흐름 정리', '디자인 작성', '디자인 검토'], criteria: ['화면 흐름과 디자인 결과가 있다', '상태별 화면이 빠지지 않았다'] },
  plan: { label: '계획', steps: ['목표 정리', '계획 작성', '계획 검토'], criteria: ['실행 계획이 정리되어 있다'] },
  simulation: { label: '시뮬레이션', steps: ['조건 정리', '시뮬레이션 실행', '결과 정리'], criteria: ['시뮬레이션 결과가 정리되어 있다'] },
  asset: { label: '에셋', steps: ['에셋 요구사항 정리', '에셋 제작', '결과 확인과 정리'], criteria: ['요청한 에셋 산출물이 있다', '에셋의 사양과 쓰임새가 정리되어 있다'] },
  revert: { label: '되돌리기', steps: ['되돌릴 변경 확인', '영향 점검', '결과 정리'], criteria: ['되돌린 변경이 정리되어 있다'] },
};
/** 기본 역할 → 작업 종류 (src/shared/domain.ts BuiltinRoleId). 사용자 정의 역할은 역할이 맡는 작업 유형(team[].taskTypes)의 첫 번째 (리드 결정 S5-15) */
const ROLE_TYPE = { planner: 'spec', architect: 'architecture', developer: 'development', ui_designer: 'design', qa: 'test', docs: 'docs', producer: 'development' };
/** ARCHITECTURE 14장: spec·research·asset은 산출물형, 나머지는 저장소 변경형. asset은 출력 방식을 정하지 않아도 산출물형이다 (리드 결정 S5-15) */
const ARTIFACT_TYPES = new Set(['spec', 'research', 'asset']);
/** 출력 방식을 정하지 않고 만드는 작업 유형 — 서버의 기본값(asset → 산출물형)을 쓴다 */
const DEFAULT_OUTPUT_TYPES = new Set(['asset']);
const CLAUDE_BUILTIN_TOOLS = ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'ToolSearch', 'TodoWrite', 'WebFetch', 'WebSearch'];

// ───────────────────────── 공용 ─────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);
const nowIso = () => new Date().toISOString();
const hex = (n) => randomUUID().replace(/-/g, '').slice(0, n);

function oneLine(s, max = 200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
function firstLine(s) {
  return (String(s ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
}
/** 명령에서 지시 제목 만들기: 첫 문장을 쓰고, 길면 단어 경계에서 자르고 말줄임표를 붙인다 */
function shortTitle(s, max = 40) {
  const line = firstLine(s).replace(/\s+/g, ' ');
  const sentence = (line.split(/(?<=[.?!。])\s/)[0] ?? line).replace(/[.。]$/, '').trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[,\s]+$/, '')}…`;
}
/** 앱 도구 입력 상한에 맞춘 자르기 (말줄임표 없이) */
function clip(s, max) {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max) : t;
}

// ───────────────────────── 출력 ─────────────────────────

let lastOut = Promise.resolve();
let lastErr = Promise.resolve();
// 앱이 출력을 닫았으면(EPIPE) 더 알릴 곳이 없다 — 실제 CLI처럼 바로 끝낸다
process.stdout.on('error', () => process.exit(1));
process.stderr.on('error', () => process.exit(1));

/** 결과 이벤트 없이 바로 끝낼 때 던진다 (비정상 종료 재현) — main에서 받아 종료 코드만 남긴다 */
class TurnExit extends Error {
  constructor(code) {
    super(`종료 코드 ${code}`);
    this.name = 'TurnExit';
    this.code = code;
  }
}

function emit(obj) {
  const line = `${JSON.stringify(obj)}\n`;
  lastOut = new Promise((resolve) => process.stdout.write(line, () => resolve()));
}
function warn(text) {
  const line = `${text}\n`;
  lastErr = new Promise((resolve) => process.stderr.write(line, () => resolve()));
}
/** 쓰기는 순서대로 끝나므로 마지막 쓰기의 완료가 곧 전체 완료다 */
function flush() {
  return Promise.all([lastOut, lastErr]);
}
/**
 * 종료 코드만 정하고 이벤트 루프가 비면 끝난다. Windows Node는 HTTP 요청 직후 process.exit()을 부르면
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"로 비정상 종료(0xC0000409)할 때가 있어 직접 부르지 않는다.
 * 무엇이 루프를 붙잡고 있으면 3초 뒤에만 강제로 끝낸다.
 */
async function exitWith(code) {
  process.exitCode = code;
  await flush();
  setTimeout(() => process.exit(code), 3000).unref();
}

// ───────────────────────── 상태 저장 (WOOK_MOCK_STATE_DIR) ─────────────────────────

function safeName(key) {
  const base = key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `${base}-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${hex(8)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows: 다른 모의 에이전트가 같은 파일을 읽는 순간에는 바꾸기가 잠깐 거부된다
      if (attempt < 8 && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) {
        sleepSync(15 * (attempt + 1));
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch (e2) {
        warn(`모의 에이전트: 임시 파일을 지우지 못했습니다 (${tmp}): ${e2.message}`);
      }
      throw e;
    }
  }
}

/**
 * 키 하나 = 파일 하나. 여러 모의 에이전트가 같은 폴더를 함께 쓰므로 큰 파일 하나를 고쳐 쓰지 않는다.
 * 폴더가 없으면(직접 실행) 이 프로세스 안에서만 기억하고, 첫 턴 판정은 WOOK_MOCK_TURN으로 한다.
 */
class StateStore {
  constructor(dir) {
    this.dir = dir && path.isAbsolute(dir) ? dir : null;
    this.mem = new Map();
  }
  get persistent() {
    return this.dir !== null;
  }
  file(bucket, key) {
    return path.join(this.dir, bucket, `${safeName(key)}.json`);
  }
  read(bucket, key, fallback) {
    if (!this.dir) return this.mem.has(`${bucket}/${key}`) ? structuredClone(this.mem.get(`${bucket}/${key}`)) : fallback;
    const file = this.file(bucket, key);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      warn(`모의 에이전트: 상태 파일을 읽지 못했습니다 (${file}): ${e.message}`);
      return fallback;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      warn(`모의 에이전트: 상태 파일이 손상되어 무시합니다 (${file}): ${e.message}`);
      return fallback;
    }
  }
  /** 저장에 실패하면 false — 첫 턴만 실패하는 시나리오는 기록을 못 남기면 실패를 재현하지 않는다(무한 반복 방지) */
  write(bucket, key, value) {
    if (!this.dir) {
      this.mem.set(`${bucket}/${key}`, structuredClone(value));
      return true;
    }
    const file = this.file(bucket, key);
    try {
      writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
      return true;
    } catch (e) {
      warn(`모의 에이전트: 상태 파일을 쓰지 못했습니다 (${file}): ${e.message}`);
      return false;
    }
  }
  list(bucket) {
    if (!this.dir) {
      return [...this.mem.entries()].filter(([k]) => k.startsWith(`${bucket}/`)).map(([, v]) => structuredClone(v));
    }
    const dir = path.join(this.dir, bucket);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      warn(`모의 에이전트: 상태 폴더를 읽지 못했습니다 (${dir}): ${e.message}`);
      return [];
    }
    const out = [];
    for (const n of names.sort()) {
      const file = path.join(dir, n);
      try {
        out.push(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (e) {
        // 다른 프로세스가 막 바꾸는 중일 수 있다 — 이번 목록에서만 뺀다
        warn(`모의 에이전트: 상태 파일을 건너뜁니다 (${file}): ${e.message}`);
      }
    }
    return out;
  }
}

// ───────────────────────── 앱 도구 (MCP Streamable HTTP) ─────────────────────────

class McpError extends Error {
  constructor(message, { status = null, rpcCode = null, transport = false } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.rpcCode = rpcCode;
    this.transport = transport;
  }
}

function describeHttpError(e) {
  const code = e?.code;
  const msg = e?.message ?? String(e);
  return code && !msg.includes(code) ? `${code} ${msg}` : msg;
}

/**
 * POST 한 번 (연결 재사용 없음). fetch 대신 node:http를 쓰는 까닭: 연결 유지 소켓·내부 핸들이 남지 않아
 * 턴이 끝나면 프로세스가 곧바로 스스로 끝난다 (exitWith 참고).
 */
function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const data = Buffer.from(body, 'utf8');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', agent: false, headers: { ...headers, 'Content-Length': data.length, Connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(MCP_TIMEOUT_MS, () => req.destroy(Object.assign(new Error(`${Math.round(MCP_TIMEOUT_MS / 1000)}초 안에 응답이 없습니다`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
}

function headerValue(h) {
  return Array.isArray(h) ? h[0] : typeof h === 'string' ? h : null;
}

function rpcErrorMessage(text) {
  try {
    const v = JSON.parse(text);
    if (isRec(v) && isRec(v.error) && typeof v.error.message === 'string') return v.error.message;
  } catch {
    // JSON-RPC 오류 본문이 아니면 원문을 그대로 쓴다 (호출자가 처리)
  }
  return null;
}

function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data.trim() === '') continue;
    let v;
    try {
      v = JSON.parse(data);
    } catch {
      throw new McpError(`앱 도구 서버의 SSE 이벤트를 해석하지 못했습니다: ${oneLine(data, 200)}`, { transport: true });
    }
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

function parseBody(contentType, text) {
  if (contentType.includes('text/event-stream')) return parseSse(text);
  const t = text.trim();
  if (t === '') return [];
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    throw new McpError(`앱 도구 서버 응답이 JSON이 아닙니다: ${oneLine(t, 200)}`, { transport: true });
  }
  return Array.isArray(v) ? v : [v];
}

class McpClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.sessionId = null;
    this.protocolVersion = null;
    this.nextId = 1;
    this.toolNames = [];
  }

  headers() {
    const h = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async post(payload) {
    let res;
    try {
      res = await httpPost(this.url, this.headers(), JSON.stringify(payload));
    } catch (e) {
      throw new McpError(`앱 도구 서버에 연결하지 못했습니다 (${this.url}): ${describeHttpError(e)}`, { transport: true });
    }
    const sid = headerValue(res.headers['mcp-session-id']);
    if (sid) this.sessionId = sid;
    if (res.status === 202) return [];
    if (res.status < 200 || res.status >= 300) {
      const detail = rpcErrorMessage(res.text) ?? (oneLine(res.text, 300) || '(내용 없음)');
      throw new McpError(`앱 도구 서버가 요청을 거부했습니다 (HTTP ${res.status}): ${detail}`, { status: res.status, transport: true });
    }
    return parseBody(headerValue(res.headers['content-type']) ?? '', res.text);
  }

  async request(method, params) {
    const id = this.nextId++;
    const msgs = await this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    const msg = msgs.find((m) => isRec(m) && m.id === id && ('result' in m || 'error' in m));
    if (!msg) throw new McpError(`앱 도구 서버가 ${method} 요청(id ${id})에 답하지 않았습니다`, { transport: true });
    if (isRec(msg.error)) throw new McpError(`앱 도구 서버 오류 (${msg.error.code}): ${str(msg.error.message, '내용 없음')}`, { rpcCode: msg.error.code });
    return msg.result;
  }

  async notify(method) {
    await this.post({ jsonrpc: '2.0', method });
  }

  async connect() {
    const r = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'wook-mock-agent', version: MOCK_VERSION },
    });
    this.protocolVersion = isRec(r) && typeof r.protocolVersion === 'string' ? r.protocolVersion : PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    const names = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const list = await this.request('tools/list', cursor ? { cursor } : {});
      for (const t of arr(list?.tools)) if (isRec(t) && typeof t.name === 'string') names.push(t.name);
      cursor = isRec(list) && typeof list.nextCursor === 'string' && list.nextCursor !== '' ? list.nextCursor : undefined;
      if (!cursor) break;
    }
    this.toolNames = names;
  }

  /** → { ok, data, text, code, message, transport }. 도구 거부(isError)는 예외가 아니라 결과로 돌려준다 */
  async callTool(name, args) {
    let r;
    try {
      r = await this.request('tools/call', { name, arguments: args });
    } catch (e) {
      if (!(e instanceof McpError)) throw e;
      return { ok: false, code: e.transport ? 'transport' : 'rpc', message: e.message, text: e.message, transport: e.transport };
    }
    const text = arr(r?.content)
      .filter((b) => isRec(b) && b.type === 'text')
      .map((b) => str(b.text))
      .join('\n');
    let data;
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = text; // 결과가 JSON 문자열이 아니면 글 그대로 쓴다
      }
    } else data = r?.structuredContent ?? null;
    if (r?.isError === true) {
      const code = isRec(data) && typeof data.error === 'string' ? data.error : 'error';
      const message = isRec(data) && typeof data.message === 'string' ? data.message : text || '도구가 오류를 돌려주었습니다';
      return { ok: false, code, message, text, transport: false };
    }
    return { ok: true, data, text, code: null, message: null, transport: false };
  }
}

// ───────────────────────── 이벤트 형식: Claude Code stream-json ─────────────────────────

function claudeResetText(d) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const minute = parts.minute && parts.minute !== '00' ? `:${parts.minute}` : '';
  return `${parts.hour}${minute}${str(parts.dayPeriod, 'am').toLowerCase()} (${tz})`;
}

class ClaudeOut {
  constructor({ sessionId, server, cwd, stdinChars }) {
    this.format = 'claude';
    this.sid = sessionId;
    this.server = server;
    this.cwd = cwd;
    this.started = Date.now();
    this.loaded = new Set();
    this.lastText = '';
    this.turns = 0;
    this.denials = [];
    this.inChars = stdinChars;
    this.outChars = 0;
  }
  base() {
    return { parent_tool_use_id: null, session_id: this.sid, uuid: randomUUID() };
  }
  start({ permissionMode = 'bypassPermissions', mcpStatus = 'connected', toolNames = [] } = {}) {
    emit({
      type: 'system',
      subtype: 'init',
      cwd: this.cwd,
      session_id: this.sid,
      tools: [...CLAUDE_BUILTIN_TOOLS, ...(mcpStatus === 'connected' ? toolNames.map((n) => `mcp__${this.server}__${n}`) : [])],
      mcp_servers: [{ name: this.server, status: mcpStatus, source: 'dynamic' }],
      model: MOCK_MODEL,
      permissionMode,
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: `mock-${MOCK_VERSION}`,
      output_style: 'default',
      agents: [],
      skills: [],
      plugins: [],
      uuid: randomUUID(),
    });
  }
  assistant(content) {
    this.turns += 1;
    emit({
      type: 'assistant',
      message: {
        model: MOCK_MODEL,
        id: `msg_mock_${hex(20)}`,
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      ...this.base(),
      timestamp: nowIso(),
    });
  }
  user(block, toolUseResult) {
    emit({ type: 'user', message: { role: 'user', content: [block] }, ...this.base(), timestamp: nowIso(), tool_use_result: toolUseResult });
  }
  say(text) {
    this.assistant([{ type: 'text', text }]);
    this.lastText = text;
    this.outChars += text.length;
  }
  toolUse(name, input) {
    const id = `toolu_mock_${hex(20)}`;
    this.assistant([{ type: 'tool_use', id, name, input }]);
    this.outChars += JSON.stringify(input).length;
    return id;
  }
  toolResult(id, content, { isError = false, toolUseResult } = {}) {
    this.user({ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }, toolUseResult ?? content);
    this.inChars += typeof content === 'string' ? content.length : JSON.stringify(content).length;
  }
  /** 2.1.x는 MCP 도구를 지연 로드한다 — 처음 쓰는 도구는 ToolSearch로 불러온 뒤 호출 (__fixtures__/claude-resume-tools.jsonl) */
  ensureLoaded(tool) {
    if (this.loaded.has(tool)) return;
    this.loaded.add(tool);
    const full = `mcp__${this.server}__${tool}`;
    const query = `select:${full}`;
    const id = this.toolUse('ToolSearch', { query, max_results: 1 });
    this.toolResult(id, [{ type: 'tool_reference', tool_name: full }], { toolUseResult: { matches: [full], query, total_deferred_tools: this.loaded.size } });
  }
  async mcp(tool, args, call) {
    this.ensureLoaded(tool);
    const id = this.toolUse(`mcp__${this.server}__${tool}`, args);
    const r = await call();
    const text = r.text || r.message || '';
    this.toolResult(id, [{ type: 'text', text }], { isError: !r.ok });
    return r;
  }
  writeFile(abs, content) {
    const existed = fs.existsSync(abs);
    const id = this.toolUse('Write', { file_path: abs, content });
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    } catch (e) {
      const msg = `Error writing file: ${e.message}`;
      this.toolResult(id, msg, { isError: true, toolUseResult: `Error: ${msg}` });
      return { ok: false, message: e.message };
    }
    this.toolResult(id, existed ? `The file ${abs} has been updated successfully.` : `File created successfully at: ${abs}`, {
      toolUseResult: { type: existed ? 'update' : 'create', filePath: abs, content, structuredPatch: [], originalFile: null },
    });
    return { ok: true };
  }
  failedCommand(command, output, exitCode) {
    const id = this.toolUse('Bash', { command, description: '빌드 실행' });
    const text = `Exit code ${exitCode}\n${output}`;
    this.toolResult(id, text, { isError: true, toolUseResult: `Error: ${text}` });
  }
  /** 바이패스가 적용되지 않은 세션: 승인할 사람이 없어 자동 거부 (__fixtures__/claude-permission-default.jsonl) */
  deniedWrite(abs, content) {
    const input = { file_path: abs, content };
    const id = this.toolUse('Write', input);
    const message =
      'Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here — so it was denied automatically. ' +
      `The action was NOT performed. What required approval: Claude requested permissions to write to ${abs}, but you haven't granted it yet.`;
    emit({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Write',
      tool_use_id: id,
      decision_reason_type: 'asyncAgent',
      decision_reason: 'no approval surface in this session; permission request denied automatically',
      message,
      uuid: randomUUID(),
      session_id: this.sid,
    });
    this.toolResult(id, message, { isError: true, toolUseResult: `Error: ${message}` });
    this.denials.push({ tool_name: 'Write', tool_use_id: id, tool_input: input });
  }
  rateLimit(info) {
    emit({ type: 'rate_limit_event', rate_limit_info: info, uuid: randomUUID(), session_id: this.sid });
  }
  /** API 오류는 합성 assistant 메시지로 온다 (__fixtures__/claude-not-logged-in.jsonl) */
  apiError(text, code) {
    this.turns += 1;
    emit({
      type: 'assistant',
      message: {
        id: randomUUID(),
        container: null,
        model: '<synthetic>',
        role: 'assistant',
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        type: 'message',
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: 'text', text }],
      },
      ...this.base(),
      timestamp: nowIso(),
      error: code,
      is_api_error_message: true,
    });
    this.lastText = text;
  }
  usage() {
    return { input: 1500 + Math.ceil(this.inChars / 3), output: 10 + Math.ceil(this.outChars / 3) };
  }
  end({ isError = false, text = this.lastText, subtype = 'success', terminalReason = 'completed', apiErrorStatus = null } = {}) {
    if (!isError && text && text !== this.lastText) this.say(text);
    const u = isError ? { input: 0, output: 0 } : this.usage();
    const ms = Date.now() - this.started;
    emit({
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: ms,
      duration_api_ms: Math.round(ms * 0.8),
      num_turns: Math.max(1, this.turns),
      result: text,
      stop_reason: isError ? 'stop_sequence' : 'end_turn',
      session_id: this.sid,
      total_cost_usd: 0,
      usage: { input_tokens: u.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: u.output },
      modelUsage: isError ? {} : { [MOCK_MODEL]: { inputTokens: u.input, outputTokens: u.output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } },
      permission_denials: this.denials,
      terminal_reason: terminalReason,
      api_error_status: apiErrorStatus,
      uuid: randomUUID(),
    });
  }
}

/** 실제 CLI가 없는 세션을 이어하려 할 때와 같은 출력 (__fixtures__/claude-resume-missing.*) */
function claudeResumeMissing(id) {
  const msg = `No conversation found with session ID: ${id}`;
  emit({
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    session_id: id,
    total_cost_usd: 0,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    errors: [msg],
  });
  warn(msg);
}

// ───────────────────────── 이벤트 형식: Codex exec --json ─────────────────────────

function codexResetText(d) {
  const now = new Date();
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  if (d.toDateString() === now.toDateString()) return time;
  const day = d.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${month} ${day}${suffix}, ${d.getFullYear()} ${time}`;
}

/** Windows codex는 명령을 PowerShell 호출째로 알린다 (__fixtures__/codex-resume-tools.jsonl) */
function codexShellCommand(command) {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    return `"${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${command.replace(/'/g, "''")}'`;
  }
  return `/bin/bash -lc '${command.replace(/'/g, `'\\''`)}'`;
}

class CodexOut {
  constructor({ sessionId, server, stdinChars }) {
    this.format = 'codex';
    this.sid = sessionId;
    this.server = server;
    this.items = 0;
    this.lastText = '';
    this.inChars = stdinChars;
    this.outChars = 0;
  }
  nextId() {
    return `item_${this.items++}`;
  }
  start() {
    emit({ type: 'thread.started', thread_id: this.sid });
    emit({ type: 'turn.started' });
  }
  say(text) {
    emit({ type: 'item.completed', item: { id: this.nextId(), type: 'agent_message', text } });
    this.lastText = text;
    this.outChars += text.length;
  }
  async mcp(tool, args, call) {
    const base = { id: this.nextId(), type: 'mcp_tool_call', server: this.server, tool, arguments: args };
    emit({ type: 'item.started', item: { ...base, result: null, error: null, status: 'in_progress' } });
    const r = await call();
    // codex: 도구가 isError를 돌려주면 status failed + result, 호출 자체가 실패하면 status failed + error
    if (r.transport) emit({ type: 'item.completed', item: { ...base, result: null, error: { message: r.message }, status: 'failed' } });
    else emit({ type: 'item.completed', item: { ...base, result: { content: [{ type: 'text', text: r.text }], structured_content: null }, error: null, status: r.ok ? 'completed' : 'failed' } });
    this.outChars += JSON.stringify(args).length;
    this.inChars += (r.text ?? '').length;
    return r;
  }
  writeFile(abs, content) {
    const kind = fs.existsSync(abs) ? 'update' : 'add';
    const base = { id: this.nextId(), type: 'file_change', changes: [{ path: abs, kind }] };
    emit({ type: 'item.started', item: { ...base, status: 'in_progress' } });
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    } catch (e) {
      emit({ type: 'item.completed', item: { ...base, status: 'failed' } });
      return { ok: false, message: e.message };
    }
    emit({ type: 'item.completed', item: { ...base, status: 'completed' } });
    this.outChars += content.length;
    return { ok: true };
  }
  failedCommand(command, output, exitCode) {
    const base = { id: this.nextId(), type: 'command_execution', command: codexShellCommand(command) };
    emit({ type: 'item.started', item: { ...base, aggregated_output: '', exit_code: null, status: 'in_progress' } });
    emit({ type: 'item.completed', item: { ...base, aggregated_output: `${output}\n`, exit_code: exitCode, status: 'failed' } });
  }
  declinedCommand(command) {
    const base = { id: this.nextId(), type: 'command_execution', command: codexShellCommand(command) };
    emit({ type: 'item.started', item: { ...base, aggregated_output: '', exit_code: null, status: 'in_progress' } });
    emit({ type: 'item.completed', item: { ...base, aggregated_output: '', exit_code: null, status: 'declined' } });
  }
  error(message) {
    emit({ type: 'error', message });
  }
  end({ isError = false, text = this.lastText } = {}) {
    if (isError) {
      emit({ type: 'turn.failed', error: { message: text } });
      return;
    }
    if (text && text !== this.lastText) this.say(text);
    emit({
      type: 'turn.completed',
      usage: {
        input_tokens: 1500 + Math.ceil(this.inChars / 3),
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 10 + Math.ceil(this.outChars / 3),
        reasoning_output_tokens: 0,
      },
    });
  }
}

// ───────────────────────── 턴 메시지 ─────────────────────────

/**
 * 턴 메시지(orchestrator/prompts.ts buildTurnMessage)의 "### n. 업무 이름" 구간 → [{kind, text}].
 * 한 턴에 여러 업무가 묶여 오면 업무별 원문(대표 명령 글, 보고할 지시 ID 등)을 여기서 가른다.
 */
function parseSections(message) {
  const body = message.replace(/<wook_instructions>[\s\S]*?<\/wook_instructions>\s*/g, '');
  // 우선 전달 표시는 메인 에이전트의 긴급 지시(옛 대표 직접 메시지 포함), 공유 표시는 그 공유 사본 — 업무 이름에서 떼어 낸다
  const re = /^###\s+(\d+)\.\s+(.+?)(\s+\((?:긴급 지시 우선 전달|대표 우선 전달)\))?(\s+\((?:긴급 지시 공유|대표 직접 메시지 공유)\))?\s*$/;
  const out = [];
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      cur = { label: m[2], kind: KIND_BY_LABEL[m[2]] ?? null, urgent: !!m[3], lines: [] };
      out.push(cur);
      continue;
    }
    // 앱은 업무 본문의 각 줄을 '> '로 인용해 보낸다 (본문이 머리줄을 흉내 내지 못하게, SEC-F3)
    if (cur) cur.lines.push(line.startsWith('> ') ? line.slice(2) : line === '>' ? '' : line);
  }
  return out.map((s) => ({
    kind: s.kind,
    label: s.label,
    urgent: s.urgent,
    // 마지막 구간 뒤에 붙는 공통 안내는 떼어 낸다
    text: s.lines.join('\n').replace(/\n*먼저 get_work_context를 호출해[\s\S]*$/, '').trim(),
  }));
}

/** main_command 원문 → 대표 명령 글 (머리줄 "대표 명령 (...):"과 끝의 안내 문단 제외) */
function extractCommand(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines.length && /^대표 명령/.test(lines[0].trim())) lines.shift();
  const text = lines.join('\n').split(/\n\s*\n(?=첨부:|먼저 read_memory|프로젝트와 무관한 직접 명령)/)[0];
  return text.trim() || raw.trim();
}

function kindOfKey(key) {
  const prefix = String(key).split(':')[0];
  if (prefix === 'task') return 'task';
  if (prefix === 'review') return 'review';
  if (prefix === 'directive') return 'directive';
  if (prefix === 'main') return key === 'main:general' ? 'main_general' : 'main_project';
  return 'unknown';
}

// ───────────────────────── 충돌 표시 정리 ─────────────────────────

/**
 * git 충돌 표시를 지우고 두 쪽 내용을 모두 남긴다 (ours 다음 theirs, 양쪽에 같은 줄은 한 번만).
 * diff3 형식의 기준(|||||||) 구간은 버린다. 충돌 표시가 없거나 짝이 맞지 않으면 null.
 */
function resolveConflictText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const trailing = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  const out = [];
  let state = 'normal';
  let ours = [];
  let theirs = [];
  let found = false;
  for (const line of lines) {
    if (state === 'normal' && line.startsWith('<<<<<<<')) {
      state = 'ours';
      found = true;
      continue;
    }
    if (state === 'ours' && line.startsWith('|||||||')) {
      state = 'base';
      continue;
    }
    if ((state === 'ours' || state === 'base') && line.startsWith('=======')) {
      state = 'theirs';
      continue;
    }
    if (state === 'theirs' && line.startsWith('>>>>>>>')) {
      out.push(...ours, ...theirs.filter((l) => !ours.includes(l)));
      ours = [];
      theirs = [];
      state = 'normal';
      continue;
    }
    if (state === 'ours') ours.push(line);
    else if (state === 'theirs') theirs.push(line);
    else if (state === 'normal') out.push(line);
  }
  if (!found || state !== 'normal') return null;
  return out.join(eol) + (trailing || out.length ? eol : '');
}

function countFiles(dir) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    warn(`모의 에이전트: 폴더를 읽지 못했습니다 (${dir}): ${e.message}`);
    return 0;
  }
  for (const e of entries) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

function insertUnderHeading(content, heading, line) {
  const lines = content.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return `${content.replace(/\s*$/, '')}\n\n${heading}\n${line}\n`;
  let end = at + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
  // 구간 끝의 빈 줄 앞에 넣는다
  let insert = end;
  while (insert > at + 1 && lines[insert - 1].trim() === '') insert--;
  lines.splice(insert, 0, line);
  return lines.join('\n');
}

// ───────────────────────── 에이전트 동작 ─────────────────────────

class Agent {
  constructor({ out, mcp, env, store, message, cwd }) {
    this.out = out;
    this.mcp = mcp;
    this.env = env;
    this.store = store;
    this.message = message;
    this.sections = parseSections(message);
    this.cwd = cwd;
    this.notes = [];
    this.stopTurn = false;
    this.ctx = null;
    this.didTaskWork = false;
    this.didReview = false;
  }

  get scenario() {
    return this.env.scenario;
  }
  note(text) {
    this.notes.push(text);
  }
  rid() {
    return `mock-${randomUUID()}`;
  }
  async pause(units = 1) {
    await sleep(stepMs(this.env, units));
  }

  memberId() {
    return this.env.member || this.ctx?.you?.memberId || 'unknown';
  }
  sessionKey() {
    return this.env.workKey || this.ctx?.session?.sessionKey || 'unknown';
  }
  sessionKind() {
    return str(this.ctx?.session?.kind) || kindOfKey(this.sessionKey());
  }
  projectIdOfSession() {
    const key = this.sessionKey();
    if (key.startsWith('main:') && key !== 'main:general') return key.slice('main:'.length);
    return this.ctx?.project?.id ?? null;
  }

  // 세션(팀원 + 업무 키)별 시나리오 기록 — 세션당 프로세스는 하나라 이 파일의 쓰는 쪽도 하나다 (CLI-20)
  workId() {
    return `${this.memberId()}|${this.sessionKey()}`;
  }
  flags() {
    return this.store.read('work', this.workId(), {});
  }
  setFlag(name, value = nowIso()) {
    const f = this.flags();
    f[name] = value;
    return this.store.write('work', this.workId(), f);
  }
  firstTime(name) {
    if (this.flags()[name]) return false;
    return this.store.persistent ? true : this.env.turn <= 1;
  }
  /** 첫 번째만 일어나는 시나리오: 기록을 남긴 경우에만 true */
  claimFirst(name) {
    return this.firstTime(name) && this.setFlag(name);
  }

  registerTask(taskId, info) {
    const cur = this.store.read('tasks', taskId, {});
    const next = { ...cur, taskId, updatedAt: nowIso() };
    for (const [k, v] of Object.entries(info)) if (v !== undefined) next[k] = v;
    this.store.write('tasks', taskId, next);
  }
  registry() {
    return this.store.list('tasks').filter((r) => isRec(r) && typeof r.taskId === 'string');
  }
  directiveKey() {
    return this.ctx?.directive?.id ?? this.sessionKey();
  }
  directiveState() {
    return this.store.read('directives', this.directiveKey(), { mergeRequested: [], revertRequested: null });
  }
  saveDirectiveState(s) {
    this.store.write('directives', this.directiveKey(), s);
  }

  /** 업무 종류별 원문. 구간을 못 찾으면 업무가 하나일 때만 get_work_context의 messages를 쓴다 */
  textsFor(kind) {
    const secs = this.sections.filter((s) => s.kind === kind).map((s) => s.text);
    if (secs.length) return secs;
    const kinds = arr(this.ctx?.workKinds);
    if (kinds.length > 1) return [];
    return arr(this.ctx?.messages)
      .map((m) => str(m?.text))
      .filter((t) => t.trim() !== '');
  }

  async tool(name, args) {
    const r = await this.out.mcp(name, args, () => this.mcp.callTool(name, args));
    if (!r.ok && (r.code === 'stopped' || r.transport) && !this.stopTurn) {
      this.stopTurn = true;
      this.note(`앱 도구 ${name}을(를) 더 쓸 수 없어 턴을 마칩니다: ${r.message}`);
    }
    return r;
  }

  /** 결과 문구가 "턴을 마치세요"면 그 자리에서 끝낸다 (질문·제출·정지 요청, 15.4) */
  endIfAsked(r) {
    const msg = isRec(r?.data) ? str(r.data.message) : '';
    if (msg.includes('턴을 마치세요')) {
      this.stopTurn = true;
      return true;
    }
    return false;
  }

  async runTurn() {
    const s = this.scenario;
    if (s === 'bypass_mismatch') return this.bypassMismatch();
    this.out.start({ toolNames: this.mcp.toolNames });
    if (s === 'usage_limit' && this.claimFirst('usageLimit')) return this.usageLimit();
    if (s === 'hang' && this.claimFirst('hang')) return this.hang();

    const ctxRes = await this.tool('get_work_context', {});
    if (!ctxRes.ok || !isRec(ctxRes.data)) {
      this.note(`업무 정보를 받지 못했습니다: ${ctxRes.message ?? '결과 형식이 올바르지 않습니다'}`);
      return this.finish();
    }
    this.ctx = ctxRes.data;
    if (s === 'crash_loop') {
      this.out.say('업무 정보를 확인했습니다. 진행합니다.');
      return this.crash('crash_loop');
    }
    // 작업 세션은 단계 1개를 마친 뒤 끊긴다 (taskWork 안)
    if (s === 'crash' && this.sessionKind() !== 'task' && this.claimFirst('crash')) {
      this.out.say('업무 정보를 확인했습니다. 진행합니다.');
      return this.crash('crash');
    }

    const kinds = this.kinds();
    if (!kinds.length) {
      this.note(str(this.ctx.instructions) || '전달된 일이 없어 상태만 확인했습니다.');
      return this.finish();
    }
    this.out.say(`업무를 확인했습니다 (${this.sessionKey()}): ${kinds.map((k) => LABEL_BY_KIND[k] ?? k).join(', ')}`);
    for (const k of kinds) {
      await this.handle(k);
      if (this.stopTurn) break;
    }
    return this.finish();
  }

  kinds() {
    let ks = arr(this.ctx.workKinds).filter((k) => typeof k === 'string');
    if (!ks.length) ks = [...new Set(this.sections.map((x) => x.kind).filter(Boolean))];
    const rank = (k) => {
      const i = KIND_ORDER.indexOf(k);
      return i < 0 ? KIND_ORDER.length : i;
    };
    return [...new Set(ks)].sort((a, b) => rank(a) - rank(b));
  }

  async handle(kind) {
    switch (kind) {
      case 'task_work':
        return this.taskWork();
      case 'conflict_fix':
        return this.conflictFix();
      case 'review':
        return this.review();
      case 'plan':
        return this.plan();
      case 'replan':
        return this.replan();
      case 'answer':
        return this.answer();
      case 'merge_decision':
        return this.mergeDecision();
      case 'final_result':
        return this.finalResult();
      case 'reviewer_assign':
        return this.reviewerAssign();
      case 'main_command':
        return this.mainCommand();
      case 'main_report':
        return this.mainReport();
      case 'change_request':
        return this.changeRequest();
      case 'stop_released':
        return this.stopReleased();
      case 'no_reviewer':
        return this.noReviewer();
      case 'alert':
        return this.alertKind();
      case 'memory_update':
        return this.memoryUpdate();
      case 'message':
        return this.messageKind();
      default:
        this.note(`처리할 수 없는 업무 종류입니다: ${kind}`);
    }
  }

  finish() {
    const text = this.notes.length ? this.notes.join('\n') : '이번 턴에 할 일을 마쳤습니다.';
    this.out.end({ text });
    return exitWith(0);
  }

  crash(kind) {
    warn(`모의 시나리오(${kind}): 결과 이벤트 없이 비정상 종료합니다`);
    throw new TurnExit(1);
  }

  // ───── 시나리오: 실행 전 실패 ─────

  bypassMismatch() {
    if (this.out.format === 'claude') {
      // 권한 모드가 bypassPermissions가 아니고, 파일 쓰기가 승인 단계에서 거부된다
      this.out.start({ permissionMode: 'default', toolNames: this.mcp.toolNames });
      this.out.deniedWrite(path.join(this.cwd, 'wook-mock', 'permission-check.md'), '실행 권한 확인\n');
      this.out.say('파일 쓰기가 실행 권한 확인 단계에서 거부되었습니다. 이 세션에서는 권한을 승인받을 수 없어 작업을 진행하지 못했습니다.');
    } else {
      // codex는 바이패스 적용 여부를 알리지 않는다 → 명령이 승인 단계에서 거부되는 모습으로 재현
      this.out.start();
      this.out.declinedCommand('New-Item -ItemType File -Force wook-mock/permission-check.md');
      this.out.say('명령 실행이 승인 단계에서 거부되었습니다. 실행 권한 바이패스 설정이 적용되지 않았습니다.');
    }
    this.out.end({});
    return exitWith(0);
  }

  usageLimit() {
    const reset = new Date(Math.ceil((Date.now() + USAGE_RESET_MIN * 60_000) / 60_000) * 60_000);
    if (this.out.format === 'claude') {
      const text = `You've hit your session limit · resets ${claudeResetText(reset)}`;
      this.out.rateLimit({
        status: 'rejected',
        resetsAt: Math.floor(reset.getTime() / 1000),
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
      });
      this.out.apiError(text, 'rate_limit');
      this.out.end({ isError: true, text, terminalReason: 'api_error', apiErrorStatus: 429 });
    } else {
      const text = `You've hit your usage limit. Try again at ${codexResetText(reset)}.`;
      this.out.error(text);
      this.out.end({ isError: true, text });
    }
    return exitWith(1);
  }

  async hang() {
    this.out.say('업무를 시작합니다. 필요한 정보를 확인하는 중입니다…');
    await flush();
    // 응답 없음 재현: 출력 없이 끝나지 않는다 (앱의 감시가 종료시킨다)
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
  }

  // ───── 작업 세션 ─────

  baseDirFor(task) {
    return task.outputMode === 'artifact' && str(task.artifactDir) ? task.artifactDir : this.cwd;
  }

  writeWorkFile(abs, content) {
    const r = this.out.writeFile(abs, content);
    if (!r.ok) this.note(`파일을 쓰지 못했습니다 (${abs}): ${r.message}`);
    return r.ok;
  }

  stepContent(task, step, total) {
    const you = this.ctx.you ?? {};
    return [
      `# ${task.id} · ${step.title}`,
      '',
      `- 작업: ${task.title}`,
      `- 단계: ${step.idx + 1}/${total}`,
      `- 담당: ${str(you.name, this.memberId())} (${this.memberId()})`,
      `- 기록: 모의 에이전트 (${this.out.format} 형식, ${this.env.turn}번째 턴, 시나리오 ${this.scenario})`,
      `- 시각: ${nowIso()}`,
      '',
      `이 파일은 욱채 모의 에이전트가 "${step.title}" 단계를 진행하며 남긴 작업 기록입니다.`,
      '',
      `목표: ${oneLine(task.goal, 500)}`,
      '',
    ].join('\n');
  }

  async taskWork() {
    if (this.didTaskWork) return;
    this.didTaskWork = true;
    const t = this.ctx.task;
    if (!isRec(t)) {
      this.note('작업 카드가 없어 진행하지 못했습니다.');
      return;
    }
    if (t.state !== 'in_progress') {
      this.note(`작업 ${t.id}이(가) 진행 상태가 아니어서(${t.state}) 이번 턴에는 진행하지 않았습니다.`);
      return;
    }
    this.registerTask(t.id, { assigneeId: this.ctx.you?.memberId ?? this.memberId(), type: t.type, outputMode: t.outputMode, prerequisiteIds: arr(t.prerequisiteIds) });

    if (this.scenario === 'review_violation' && this.claimFirst('violation')) {
      await this.reviewViolations({ ownTaskId: t.id, exclude: [] });
      if (this.stopTurn) return;
    }
    if (this.scenario === 'answer_wait' && !this.ctx.you?.isProducer && this.claimFirst('askProducer')) {
      await this.pause(0.5);
      const r = await this.tool('ask_producer', {
        question: `${t.id} "${t.title}" 진행 방식을 확인하고 싶습니다. 완료 조건 중 어느 쪽을 먼저 맞출까요? (모의 질문)`,
        request_id: this.rid(),
      });
      this.note(r.ok ? `프로듀서에게 질문했습니다 (${str(r.data?.questionId, '질문')}). 답변을 기다립니다.` : `질문하지 못했습니다: ${r.message}`);
      if (r.ok) this.stopTurn = true;
      if (this.stopTurn) return;
    }

    let steps = arr(t.steps);
    if (!steps.length) {
      const titles = (TYPE_INFO[t.type] ?? TYPE_INFO.development).steps;
      this.out.say(`작업 ${t.id}을(를) 단계 ${titles.length}개로 나눠 진행합니다.`);
      const r = await this.tool('set_steps', { steps: titles, request_id: this.rid() });
      if (!r.ok) {
        this.note(`단계를 만들지 못했습니다: ${r.message}`);
        return;
      }
      steps = arr(r.data?.steps);
    }

    if (this.scenario === 'spin') return this.spin();

    // 반려·재계획 뒤에는 바뀐 내용이 있어야 새 대상 버전으로 다시 검수받는다 (REV-07)
    if (steps.length && steps.every((x) => x.done) && str(t.lastRejectReason)) {
      const key = `${t.reviewRound}:${t.rejectsInRound}`;
      if (this.flags().fixedFor !== key) {
        const title = t.rejectsInRound > 0 ? `검수 반려 반영 (${t.reviewRound}차 ${t.rejectsInRound}회)` : `재계획 반영 (${t.reviewRound}차)`;
        const r = await this.tool('add_steps', { steps: [title], request_id: this.rid() });
        if (!r.ok) {
          this.note(`반려 반영 단계를 추가하지 못했습니다: ${r.message}`);
          return;
        }
        steps = arr(r.data?.steps);
        this.setFlag('fixedFor', key);
      }
    }

    const base = this.baseDirFor(t);
    const pending = steps.filter((x) => !x.done);
    for (const [i, step] of pending.entries()) {
      await this.pause();
      const rel = path.join('wook-mock', t.id, `step-${step.idx + 1}.md`);
      let content = this.stepContent(t, step, steps.length);
      if (str(t.lastRejectReason) && step.idx >= (TYPE_INFO[t.type] ?? TYPE_INFO.development).steps.length) {
        content += `\n## 반영한 검수 의견\n\n${t.lastRejectReason}\n`;
      }
      if (!this.writeWorkFile(path.join(base, rel), content)) return;
      if (this.scenario === 'merge_conflict' && i === 0 && t.outputMode !== 'artifact') {
        const you = this.ctx.you ?? {};
        const zone = `# 충돌 시험 영역\n작성: ${str(you.name, this.memberId())} (${this.memberId()})\n작업: ${t.id}\n이 줄은 ${this.memberId()}의 변경입니다.\n`;
        if (!this.writeWorkFile(path.join(this.cwd, 'conflict-zone.txt'), zone)) return;
      }
      const args = { step_index: step.idx, note: `모의 작업: ${step.title} 완료 (${rel.replace(/\\/g, '/')})`, request_id: this.rid() };
      const r = await this.tool('complete_step', args);
      if (this.scenario === 'duplicate_tool') await this.tool('complete_step', args);
      if (!r.ok) {
        this.note(`단계 ${step.idx + 1}을(를) 완료로 기록하지 못했습니다: ${r.message}`);
        return;
      }
      if (this.endIfAsked(r)) {
        this.note(`${step.title} 단계를 마쳤고 정지 요청에 따라 턴을 마칩니다.`);
        return;
      }
      if (this.scenario === 'crash' && this.claimFirst('crash')) this.crash('crash');
    }

    const args = { note: '모의 에이전트: 모든 단계를 마치고 완료 조건을 확인했습니다.', request_id: this.rid() };
    const r = await this.tool('submit_for_review', args);
    if (this.scenario === 'duplicate_tool') await this.tool('submit_for_review', args);
    this.note(r.ok ? `작업 ${t.id}의 단계 ${steps.length}개를 마치고 검수를 요청했습니다.` : `검수를 요청하지 못했습니다: ${r.message}`);
    // "호출 후 턴을 마치세요" (catalog submit_for_review)
    this.stopTurn = true;
  }

  async spin() {
    const command = 'npm run build';
    const output = "> build\n모의 빌드 오류: src/wook-mock.ts(1,1): error TS2307: Cannot find module './missing'.";
    for (let i = 0; i < SPIN_REPEAT; i++) {
      await this.pause(0.25);
      this.out.failedCommand(command, output, 1);
    }
    this.note(`같은 빌드 오류가 ${SPIN_REPEAT}번 반복되어 단계를 진행하지 못했습니다.`);
  }

  async conflictFix() {
    this.didTaskWork = true;
    const t = this.ctx.task;
    if (!isRec(t)) {
      this.note('작업 카드가 없어 충돌을 해결하지 못했습니다.');
      return;
    }
    const files = arr(t.conflictFiles).filter((f) => typeof f === 'string');
    let fixed = 0;
    for (const rel of files) {
      const abs = path.resolve(this.cwd, rel);
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        this.note(`충돌 파일을 읽지 못했습니다 (${rel}): ${e.message}`);
        continue;
      }
      const merged = resolveConflictText(text);
      if (merged === null) {
        this.note(`충돌 표시가 없거나 짝이 맞지 않아 그대로 두었습니다: ${rel}`);
        continue;
      }
      await this.pause();
      if (!this.writeWorkFile(abs, merged)) return;
      fixed++;
    }
    const r = await this.tool('report_conflict_resolved', { note: `모의 에이전트: 충돌 파일 ${fixed}/${files.length}개의 두 변경을 합쳤습니다.`, request_id: this.rid() });
    this.note(r.ok ? `충돌 파일 ${fixed}개를 정리하고 해결을 알렸습니다.` : `충돌 해결을 알리지 못했습니다: ${r.message}`);
    // 프로그램이 병합 커밋 후 검사·검수를 다시 진행한다 — 제출을 또 하지 않는다
    this.stopTurn = true;
  }

  // ───── 검수 ─────

  /** review_violation: 본인 작업·검수자로 배정되지 않은 작업에 submit_review를 시도한다 (모두 거부되어야 정상, AC-32·38) */
  async reviewViolations({ ownTaskId, exclude }) {
    const me = this.ctx.you?.memberId ?? this.memberId();
    const reg = this.registry().filter((x) => !exclude.includes(x.taskId));
    const own = ownTaskId ?? reg.find((x) => x.assigneeId === me)?.taskId ?? null;
    const other =
      reg.find((x) => x.taskId !== own && x.assigneeId !== me && x.reviewerId && x.reviewerId !== me)?.taskId ??
      reg.find((x) => x.taskId !== own && x.assigneeId !== me)?.taskId ??
      null;
    const attempts = [
      ['본인 작업', own],
      ['검수자로 배정되지 않은 작업', other],
    ];
    for (const [label, taskId] of attempts) {
      if (!taskId) {
        this.note(`권한 위반 시험: ${label}을(를) 찾지 못해 건너뜁니다.`);
        continue;
      }
      const r = await this.tool('submit_review', {
        task_id: taskId,
        verdict: 'pass',
        criteria: [{ criterion: '권한 위반 시험', pass: true, note: `모의 시나리오(review_violation): ${label}` }],
        reason: '',
        request_id: this.rid(),
      });
      this.note(r.ok ? `경고: ${label}(${taskId}) 검수 등록이 거부되지 않았습니다.` : `권한 위반 시험: ${label}(${taskId}) 검수 등록이 거부되었습니다 (${r.code}).`);
      if (this.stopTurn) return;
    }
  }

  async review() {
    if (this.didReview) return;
    this.didReview = true;
    const targets = arr(this.ctx.reviewTasks).filter(isRec);
    if (!targets.length) {
      this.note('검수할 작업이 없습니다.');
      return;
    }
    if (this.scenario === 'review_violation' && this.claimFirst('violation')) {
      await this.reviewViolations({ ownTaskId: null, exclude: targets.map((x) => x.taskId) });
      if (this.stopTurn) return;
    }
    for (const rt of targets) {
      await this.pause();
      const info = await this.tool('get_review_target', { task_id: rt.taskId });
      if (!info.ok) {
        this.note(`${rt.taskId} 검수 대상을 받지 못했습니다: ${info.message}`);
        if (this.stopTurn) return;
        continue;
      }
      const d = isRec(info.data) ? info.data : {};
      const round = typeof d.reviewRound === 'number' ? d.reviewRound : (rt.reviewRound ?? 1);
      const rejects = typeof d.rejectsInRound === 'number' ? d.rejectsInRound : 0;
      let criteria = arr(d.acceptanceCriteria).filter((c) => typeof c === 'string' && c.trim() !== '');
      if (!criteria.length) criteria = arr(rt.acceptanceCriteria).filter((c) => typeof c === 'string' && c.trim() !== '');
      if (!criteria.length) criteria = ['작업 목표를 달성했다'];
      const copy = str(d.reviewCopyPath) || str(rt.reviewCopyPath) || this.cwd;
      const files = countFiles(path.join(copy, 'wook-mock', rt.taskId));
      const reject = this.scenario === 'triple_reject' && round === 1;
      const r = await this.tool('submit_review', {
        task_id: rt.taskId,
        verdict: reject ? 'reject' : 'pass',
        criteria: criteria.map((c, i) => ({
          criterion: c,
          pass: reject ? i !== 0 : true,
          note: reject && i === 0 ? `모의 검수: ${round}차 검수에서는 이 조건을 통과로 보지 않습니다` : `모의 검수: 확인함 (작업 기록 ${files}개)`,
        })),
        reason: reject ? `모의 시나리오(triple_reject): ${round}차 검수에서는 반려합니다 (이번 차수 ${rejects + 1}번째 반려).` : '',
        request_id: this.rid(),
      });
      this.note(r.ok ? `${rt.taskId} 검수를 ${reject ? '반려' : '통과'}로 등록했습니다 (${round}차).` : `${rt.taskId} 검수 결과를 등록하지 못했습니다: ${r.message}`);
      if (this.stopTurn) return;
    }
  }

  // ───── 프로듀서 ─────

  async plan() {
    const d = this.ctx.directive;
    if (!isRec(d)) {
      this.note('지시 정보가 없어 계획하지 못했습니다.');
      return;
    }
    await this.pause();
    const you = this.ctx.you ?? {};
    const others = arr(this.ctx.team).filter((m) => isRec(m) && m.memberId !== you.memberId);
    // 팀원이 없으면 프로듀서 자신이 맡는다
    const assignees = others.length ? others : [{ memberId: you.memberId, name: you.name, roleId: 'producer', roleName: you.roleName }];
    const round = typeof d.round === 'number' ? d.round : 1;
    const roundText = str(arr(d.rounds).find((r) => isRec(r) && r.round === round)?.text) || str(d.text);
    const isQa = (m) => m.roleId === 'qa';
    const ordered = [...assignees.filter((m) => !isQa(m)), ...assignees.filter(isQa)];
    const devIds = [];
    const made = [];
    for (const m of ordered) {
      // 기본 역할은 고정 표, 사용자 정의 역할은 역할이 맡는 첫 작업 유형 — 작업 유형을 보내지 않는 예전 서버면 이름으로 고른다
      const roleType = arr(m.taskTypes).find((t) => typeof t === 'string' && t !== 'revert' && Object.hasOwn(TYPE_INFO, t));
      const type = ROLE_TYPE[m.roleId] ?? roleType ?? (/조사|research/i.test(`${m.roleId} ${str(m.roleName)}`) ? 'research' : 'development');
      const info = TYPE_INFO[type];
      const output = ARTIFACT_TYPES.has(type) ? 'artifact' : 'repo';
      const prereq = isQa(m) ? [...devIds] : [];
      const title = clip(`${oneLine(d.title, 80)} — ${info.label}${round > 1 ? ` (${round}회차 수정)` : ''}`, 120);
      const r = await this.tool('create_task', {
        directive_id: d.id,
        title,
        goal: clip(`${roundText || d.title}\n\n(모의 계획: ${str(m.name, m.memberId)}(${str(m.roleName, m.roleId)}) 담당 ${info.label} 작업)`, 8000),
        type,
        assignee_id: m.memberId,
        priority: 'normal',
        prerequisite_ids: prereq,
        acceptance_criteria: info.criteria,
        planned_areas: ['wook-mock/'],
        // 에셋은 출력 방식을 정하지 않는다 — 서버가 산출물형으로 만든다 (리드 결정 S5-15)
        ...(DEFAULT_OUTPUT_TYPES.has(type) ? {} : { output_mode: output }),
        // 같은 회차 계획을 다시 받아도(복구 등) 작업이 두 번 생기지 않게 요청 ID를 고정한다 (AC-45)
        request_id: `mock-plan-${d.id}-r${round}-${m.memberId}`,
      });
      if (!r.ok) {
        this.note(`${str(m.name, m.memberId)}에게 작업을 만들지 못했습니다: ${r.message}`);
        if (this.stopTurn) return;
        continue;
      }
      const taskId = str(r.data?.taskId);
      if (taskId) {
        this.registerTask(taskId, { assigneeId: m.memberId, reviewerId: str(r.data?.reviewerId) || null, type, outputMode: output, prerequisiteIds: prereq, directiveId: d.id });
        if (type === 'development') devIds.push(taskId);
        made.push(`${taskId}(${str(m.name, m.memberId)} ${info.label})`);
      }
    }
    this.note(made.length ? `지시 ${d.id}을(를) 작업 ${made.length}개로 나눠 배정했습니다: ${made.join(', ')}` : `지시 ${d.id}의 작업을 만들지 못했습니다.`);
  }

  async replan() {
    await this.pause();
    const tasks = arr(this.ctx.tasks).filter(isRec);
    const cancelled = new Set(tasks.filter((t) => t.state === 'cancelled').map((t) => t.id));
    const ds = this.directiveState();
    const replans = isRec(ds.replans) ? ds.replans : {};
    let acted = 0;
    for (const t of tasks.filter((x) => x.state === 'on_hold')) {
      const kinds = arr(t.holdReasons).map((r) => str(r).split(':')[0].trim());
      let r = null;
      if (kinds.includes('replan')) {
        const done = typeof replans[t.id] === 'number' ? replans[t.id] : 0;
        if (done >= MAX_REPLANS_PER_TASK) {
          acted++;
          this.note(`${t.id}을(를) 이미 ${done}번 재계획했지만 다시 보류되어 더 진행하지 않습니다. 대표 판단이 필요합니다.`);
          continue;
        }
        r = await this.tool('replan_task', { task_id: t.id, note: `모의 재계획 ${done + 1}회: 반려·헛돌기 사유를 반영해 방법을 바꿔 다시 진행합니다.`, request_id: this.rid() });
        if (r.ok) {
          replans[t.id] = done + 1;
          this.saveDirectiveState({ ...ds, replans });
        }
      } else if (kinds.includes('blocked')) {
        r = await this.tool('resolve_hold', { task_id: t.id, kind: 'blocked', note: '모의 조치: 막힘 원인을 정리했습니다. 이어서 진행하세요.', request_id: this.rid() });
      } else if (kinds.includes('prereq_cancelled')) {
        const known = this.store.read('tasks', t.id, null);
        const prereq = arr(known?.prerequisiteIds).filter((p) => !cancelled.has(p));
        const u = await this.tool('update_task', { task_id: t.id, prerequisite_ids: prereq, request_id: this.rid() });
        if (!u.ok) {
          this.note(`${t.id} 선행 작업을 다시 정하지 못했습니다: ${u.message}`);
          if (this.stopTurn) return;
          continue;
        }
        r = await this.tool('resolve_hold', { task_id: t.id, kind: 'prereq_cancelled', note: '모의 조치: 취소된 선행 작업을 빼고 다시 정했습니다.', request_id: this.rid() });
      } else continue;
      acted++;
      this.note(r.ok ? `${t.id} 보류를 조치했습니다.` : `${t.id} 보류를 조치하지 못했습니다: ${r.message}`);
      if (this.stopTurn) return;
    }
    if (!acted) this.note('조치할 재계획·막힘 보류 작업이 없습니다.');
  }

  async answer() {
    const qs = arr(this.ctx.questions).filter(isRec);
    if (!qs.length) {
      this.note('답할 질문이 없습니다.');
      return;
    }
    for (const q of qs) {
      await this.pause(0.5);
      const r = await this.tool('answer_question', {
        question_id: q.questionId,
        answer: clip(`모의 프로듀서 답변: "${oneLine(q.text, 200)}" — 작업 카드의 완료 조건 순서대로 진행하세요. 더 판단이 필요하면 다시 질문하세요.`, 8000),
        request_id: this.rid(),
      });
      this.note(r.ok ? `${q.questionId} 질문에 답했습니다.` : `${q.questionId} 질문에 답하지 못했습니다: ${r.message}`);
      if (this.stopTurn) return;
    }
  }

  async mergeDecision() {
    const cands = arr(this.ctx.mergeCandidates).filter(isRec);
    if (!cands.length) {
      this.note('병합할 작업이 없습니다.');
      return;
    }
    await this.pause(0.5);
    const ds = this.directiveState();
    for (const c of cands) {
      const r = await this.tool('request_merge', { task_id: c.taskId, request_id: this.rid() });
      if (r.ok) {
        ds.mergeRequested = [...new Set([...arr(ds.mergeRequested), c.taskId])];
        this.note(`${c.taskId} 병합을 요청했습니다 (${str(r.data?.status, '접수')}).`);
      } else this.note(`${c.taskId} 병합을 요청하지 못했습니다: ${r.message}`);
      if (this.stopTurn) break;
    }
    this.saveDirectiveState(ds);
  }

  /** revert: 이 지시에서 처음 병합된 작업을 한 번만 되돌린다 (7.1, AC-12) */
  async maybeRevert() {
    const ds = this.directiveState();
    if (ds.revertRequested) return false;
    const tasks = arr(this.ctx.tasks).filter(isRec);
    const isTarget = (id) => tasks.find((t) => t.id === id && t.state === 'done' && !str(t.title).startsWith('[되돌리기]'));
    let target = null;
    for (const id of arr(ds.mergeRequested)) {
      target = isTarget(id);
      if (target) break;
    }
    if (!target) {
      // 상태 기록이 없으면 최종 결과 안내의 "(병합 xxxxxxxx)" 표시로 찾는다
      const merged = this.textsFor('final_result').join('\n').match(/^- (T-\d+) .*\(병합 [0-9a-f]+\)/gm) ?? [];
      for (const line of merged) {
        target = isTarget(line.slice(2).split(' ')[0]);
        if (target) break;
      }
    }
    if (!target) return false;
    const r = await this.tool('request_revert', { task_id: target.id, reason: '모의 시나리오(revert): 병합 후 선택 되돌리기를 시험합니다.', request_id: this.rid() });
    ds.revertRequested = { taskId: target.id, at: nowIso(), ok: r.ok, detail: r.ok ? r.data : r.message };
    this.saveDirectiveState(ds);
    this.note(
      r.ok
        ? `${target.id} 되돌리기를 요청했습니다${str(r.data?.revertTaskId) ? ` (되돌리기 작업 ${r.data.revertTaskId})` : ''}. 되돌리기가 끝난 뒤 결과를 정리합니다.`
        : `${target.id} 되돌리기를 요청하지 못했습니다: ${r.message}`,
    );
    return r.ok;
  }

  async finalResult() {
    const d = this.ctx.directive;
    if (!isRec(d)) {
      this.note('지시 정보가 없어 결과를 정리하지 못했습니다.');
      return;
    }
    if (this.scenario === 'revert' && (await this.maybeRevert())) return;
    if (this.stopTurn) return;
    await this.pause(0.5);
    const tasks = arr(this.ctx.tasks).filter(isRec);
    const done = tasks.filter((t) => t.state === 'done');
    const cancelled = tasks.filter((t) => t.state === 'cancelled');
    const summary = `"${oneLine(d.title, 100)}" ${d.round ?? 1}회차 결과: 작업 ${done.length}개 완료${cancelled.length ? `, ${cancelled.length}개 취소` : ''} (모의 프로듀서 정리)`;
    const r = await this.tool('submit_final_result', {
      directive_id: d.id,
      summary: clip(summary, 4000),
      outputs: done.map((t) => clip(`${t.id} ${t.title}`, 300)),
      changed_files: done.map((t) => `wook-mock/${t.id}/`),
      issues: cancelled.map((t) => clip(`${t.id} ${t.title} 취소됨`, 300)),
      next_steps: [],
      request_id: this.rid(),
    });
    this.note(r.ok ? `지시 ${d.id} 결과를 정리해 제출했습니다.` : `지시 ${d.id} 결과를 제출하지 못했습니다: ${r.message}`);
  }

  async reviewerAssign() {
    const tasks = arr(this.ctx.tasks).filter(isRec);
    const ids = [...new Set(this.textsFor('reviewer_assign').join('\n').match(/T-\d+/g) ?? [])];
    const targets = ids.length ? tasks.filter((t) => ids.includes(t.id)) : tasks.filter((t) => t.state === 'in_review');
    if (!targets.length) {
      this.note('검수자를 다시 정할 작업이 없습니다.');
      return;
    }
    await this.pause(0.5);
    const team = arr(this.ctx.team).filter(isRec);
    for (const t of targets) {
      const pick = team.find((m) => m.canReview && m.memberId !== t.assigneeId && m.memberId !== t.reviewerId);
      // 적격 팀원이 없으면 메인 에이전트에게 맡긴다 (REV-06 v0.6 — 대표 검수는 없다)
      let reviewer = pick?.memberId ?? 'main';
      let r = await this.tool('assign_reviewer', { task_id: t.id, reviewer_id: reviewer, request_id: this.rid() });
      if (!r.ok && reviewer !== 'main' && !this.stopTurn) {
        reviewer = 'main';
        r = await this.tool('assign_reviewer', { task_id: t.id, reviewer_id: reviewer, request_id: this.rid() });
      }
      this.note(r.ok ? `${t.id} 검수자를 ${reviewer === 'main' ? '메인 에이전트' : reviewer}(으)로 정했습니다.` : `${t.id} 검수자를 정하지 못했습니다: ${r.message}`);
      if (this.stopTurn) return;
    }
  }

  // ───── 메인 에이전트 ─────

  async mainCommand() {
    const texts = this.textsFor('main_command');
    if (!texts.length) {
      this.note('처리할 명령이 없습니다.');
      return;
    }
    const projectId = this.projectIdOfSession();
    for (const raw of texts) {
      await this.pause(0.5);
      const cmd = extractCommand(raw);
      if (cmd.includes('[질문]')) {
        const r = await this.tool('ask_owner', {
          question: clip(`명령을 진행하기 전에 확인하고 싶습니다: "${oneLine(cmd.replace(/\[질문\]/g, ''), 120)}" — 범위와 우선순위를 알려 주세요.`, 4000),
          request_id: this.rid(),
        });
        if (r.ok) this.setFlag('pendingCommand', cmd);
        this.note(r.ok ? '명령이 모호해 대표에게 먼저 질문했습니다. 답변을 받으면 진행하겠습니다.' : `대표에게 질문하지 못했습니다: ${r.message}`);
        // "호출 후 턴을 마치세요" (catalog ask_owner)
        this.stopTurn = true;
        return;
      }
      if (!projectId) {
        await this.generalCommand(cmd);
        if (this.stopTurn) return;
        continue;
      }
      // 질문에 대한 답이면 원래 명령과 합쳐 지시로 등록한다
      const pending = str(this.flags().pendingCommand);
      const isAnswer = /질문 Q-\d+에 대한 답변/.test(raw);
      const basis = pending && isAnswer ? pending.replace(/\[질문\]/g, '').trim() : cmd;
      const text = pending && isAnswer ? `${basis}\n\n${cmd}` : cmd;
      const title = shortTitle(basis) || '대표 명령';
      const r = await this.tool('register_directive', { project_id: projectId, title, text: clip(text, 20000), request_id: this.rid() });
      if (r.ok && pending && isAnswer) this.setFlag('pendingCommand', '');
      this.note(r.ok ? `지시 ${str(r.data?.directiveId, '')}을(를) 등록해 프로듀서에게 전달했습니다: ${title}` : `지시를 등록하지 못했습니다: ${r.message}`);
      if (this.stopTurn) return;
    }
  }

  async generalCommand(cmd) {
    // "Codex에게 메인을 넘겨" 같은 자리 넘기기 명령 (SERVER_DESIGN 4.3, 10.4 seatHandoffByMain) — 남길 말을 일지에 적고 hand_off_seat로 넘긴다
    const handTo = /메인.*넘겨|넘겨.*메인/.test(cmd) ? /\b(codex|claude)\b/i.exec(cmd)?.[1]?.toLowerCase() : undefined;
    if (handTo) return this.handOffSeat(handTo, cmd);
    const title = firstLine(cmd).slice(0, 40) || '직접 명령';
    this.out.say(`직접 명령을 처리했습니다: ${oneLine(cmd, 200)}`);
    const r = await this.tool('submit_report', {
      title,
      summary: clip(`모의 메인 에이전트가 직접 명령 "${oneLine(cmd, 100)}"을(를) 처리했습니다.`, 1200),
      results: clip(`명령 원문:\n${cmd}\n\n모의 실행이라 실제 변경은 없습니다.`, 20000),
      changed_files: [],
      how_to_verify: '이 보고서와 대화 기록을 확인하세요.',
      issues: '',
      next_steps: '',
      request_id: this.rid(),
    });
    this.note(r.ok ? `직접 명령 "${title}"을(를) 처리하고 보고서를 올렸습니다.` : `보고서를 올리지 못했습니다: ${r.message}`);
  }

  /** 메인 자리를 넘긴다 — 다음 메인이 이어받을 약속을 일지에 남기고(journal_write), hand_off_seat를 부른 뒤 턴을 마친다 (이 턴을 마치면 넘어간다) */
  async handOffSeat(to, cmd) {
    const label = to === 'codex' ? 'Codex' : 'Claude';
    const promise = await this.tool('journal_write', {
      kind: 'promise',
      text: clip(`대표 명령 "${oneLine(cmd, 80)}"에 따라 메인 자리를 ${label}에게 넘깁니다. 넘긴 뒤 새 메인이 대표에게 바뀐 것을 알려야 합니다.`, 1000),
      reason: '새 메인 에이전트가 대표에게 자리 교체를 알리면 닫습니다',
      request_id: this.rid(),
    });
    if (!promise.ok) this.note(`일지에 남기지 못했습니다: ${promise.message}`);
    const r = await this.tool('hand_off_seat', { to, reason: clip(`대표 명령: ${oneLine(cmd, 120)}`, 2000), note: '모의 메인 에이전트가 넘깁니다 — 진행 중인 일은 인계 꾸러미를 보세요', request_id: this.rid() });
    this.note(r.ok ? `메인 자리를 ${label}에게 넘깁니다. ${str(r.data?.message, '')}` : `메인 자리를 넘기지 못했습니다: ${r.message}`);
    this.stopTurn = true;
  }

  async mainReport() {
    const texts = this.textsFor('main_report');
    const joined = texts.join('\n');
    let ids = [...new Set([...joined.matchAll(/directive_id="(D-\d+)"/g)].map((m) => m[1]))];
    if (!ids.length) ids = [...new Set(joined.match(/D-\d+/g) ?? [])];
    if (!ids.length && isRec(this.ctx.directive)) ids = [this.ctx.directive.id];
    if (!ids.length) {
      this.note('보고할 지시가 없습니다.');
      return;
    }
    for (const id of ids) {
      await this.pause(0.5);
      const raw = texts.find((t) => t.includes(id)) ?? texts[0] ?? '';
      const d = isRec(this.ctx.directive) && this.ctx.directive.id === id ? this.ctx.directive : null;
      const summaryLine = /요약:\s*(.+)/.exec(raw)?.[1];
      const listAfter = (label) => {
        const m = new RegExp(`${label}:\\n((?:- .+\\n?)+)`).exec(raw);
        return m ? m[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()) : [];
      };
      const changed = listAfter('변경 파일');
      const issues = listAfter('이슈');
      const nextSteps = listAfter('다음 할 일 제안');
      // 첫 줄(앱이 메인 에이전트에게 준 지시)과 요약 줄은 보고서 본문에 넣지 않는다
      const body = raw
        .split('\n')
        .filter((l) => !l.includes('submit_report(') && !l.startsWith('요약:'))
        .join('\n')
        .trim();
      const r = await this.tool('submit_report', {
        directive_id: id,
        title: clip(d ? `${oneLine(d.title, 80)} — ${d.round ?? 1}회차 결과` : `지시 ${id} 결과`, 120),
        summary: clip(summaryLine ? oneLine(summaryLine, 300) : `지시 ${id}의 작업을 마쳤습니다.`, 1200),
        results: clip(body || `지시 ${id}의 결과를 정리했습니다.`, 20000),
        changed_files: changed,
        how_to_verify: '문서함의 이 보고서와 프로젝트 폴더의 wook-mock 폴더(모의 작업 기록)를 확인하세요.',
        issues: issues.map((l) => `- ${l}`).join('\n'),
        next_steps: nextSteps.map((l) => `- ${l}`).join('\n'),
        request_id: this.rid(),
      });
      this.note(r.ok ? `지시 ${id} 보고서를 올렸습니다.` : `지시 ${id} 보고서를 올리지 못했습니다: ${r.message}`);
      if (this.stopTurn) return;
    }
  }

  /** 대표의 보고서 수정 요청 → 그 지시의 다음 회차를 연다 (revise_directive, FBK-03 v0.6). 지시 없는 보고서면 확인만 */
  async changeRequest() {
    const texts = this.textsFor('change_request');
    if (!texts.length) {
      this.note('처리할 수정 요청이 없습니다.');
      return;
    }
    for (const raw of texts) {
      await this.pause(0.5);
      const directiveId = /directive_id="(D-\d+)"/.exec(raw)?.[1];
      const reportId = /report_id="(R-\d+)"/.exec(raw)?.[1];
      if (!directiveId || !reportId) {
        this.note(`수정 요청을 확인했습니다 (다음 회차를 열 지시가 없음): ${oneLine(raw, 120)}`);
        continue;
      }
      const r = await this.tool('revise_directive', {
        directive_id: directiveId,
        report_id: reportId,
        instructions: '모의 메인 에이전트: 대표 수정 요청대로 다음 회차를 진행하세요.',
        request_id: `mock-revise-${directiveId}-${reportId}`,
      });
      this.note(r.ok ? `지시 ${directiveId}의 다음 회차를 열었습니다 (수정 요청 ${reportId}).` : `지시 ${directiveId}의 다음 회차를 열지 못했습니다: ${r.message}`);
      if (this.stopTurn) return;
    }
  }

  /** 긴급 정지 해제 뒤 보류 목록 — 모의 메인은 저절로 재개하지 않는다 (항목별 재개는 시험이 resume_task로, CTL-10 v0.6) */
  async stopReleased() {
    const ids = [...new Set(this.textsFor('stop_released').join('\n').match(/T-\d+/g) ?? [])];
    this.note(ids.length ? `정지 해제 — 보류된 작업 ${ids.length}건(${ids.join(', ')})을 확인했습니다. 모의 메인 에이전트는 저절로 재개하지 않습니다.` : '정지 해제를 확인했습니다.');
  }

  /** 검수자 없음 — 모의 메인은 확인만 한다 (팀원 추가·재개는 시험이) */
  async noReviewer() {
    const ids = [...new Set(this.textsFor('no_reviewer').join('\n').match(/T-\d+/g) ?? [])];
    this.note(`검수자 없음을 확인했습니다${ids.length ? ` (${ids.join(', ')})` : ''}. 검수 권한 팀원을 더한 뒤 재개해야 합니다.`);
  }

  /** 대표에게만 가던 보류·실패를 넘겨받은 일 (SERVER_DESIGN 5.3) — 모의 메인은 확인만 한다 (재개·복구 확인은 시험이 도구로) */
  async alertKind() {
    const texts = this.textsFor('alert');
    const heads = texts.map((t) => oneLine(t.split('\n')[0] ?? '', 80));
    this.note(heads.length ? `보류·실패 ${heads.length}건을 넘겨받았습니다: ${heads.join(' / ')}. 모의 메인 에이전트는 저절로 처리하지 않습니다.` : '보류·실패 처리를 확인했습니다.');
  }

  async memoryUpdate() {
    await this.pause(0.5);
    const projectId = this.projectIdOfSession();
    const scope = projectId ? { project_id: projectId } : {};
    const r = await this.tool('read_memory', scope);
    if (!r.ok) {
      this.note(`기억 문서를 읽지 못했습니다: ${r.message}`);
      return;
    }
    const content = str(r.data?.content);
    const feedback = oneLine(this.textsFor('memory_update').join(' ').replace(/드러난 선호[^.]*\.?/g, ''), 160) || '대표 피드백 확인';
    const line = `- ${nowIso().slice(0, 10)} 모의 기록: ${feedback}`;
    const w = await this.tool('write_memory', { ...scope, content: clip(insertUnderHeading(content, '## 대표 선호', line), 60000), request_id: this.rid() });
    this.note(w.ok ? '프로젝트 기억에 대표 선호를 한 줄 추가했습니다.' : `기억 문서를 저장하지 못했습니다: ${w.message}`);
  }

  async messageKind() {
    const kind = this.sessionKind();
    if (kind === 'task') return this.taskWork();
    if (kind === 'review') return this.review();
    const texts = this.textsFor('message');
    if ((kind === 'main_project' || kind === 'main_general') && texts.some((t) => t.includes('set_member_ai'))) return this.decideMemberAi(texts);
    this.note(texts.length ? `메시지 ${texts.length}건을 확인했습니다: ${oneLine(texts[0], 120)}` : '메시지를 확인했습니다.');
  }

  /** 팀원 추가·프로듀서 배치 뒤 오는 'AI 설정을 정하세요' 요청을 실제 메인 에이전트처럼 처리한다 */
  async decideMemberAi(texts) {
    const asked = texts.filter((t) => t.includes('set_member_ai')).join('\n');
    const ids = [...new Set([...asked.matchAll(/\((M-\d+)[,)]/g)].map((m) => m[1]))];
    if (!ids.length) {
      this.note('AI 설정을 정할 팀원을 찾지 못했습니다.');
      return;
    }
    await this.pause(0.5);
    const projectId = this.projectIdOfSession();
    const opts = await this.tool('list_ai_options', projectId ? { project_id: projectId } : {});
    if (!opts.ok) {
      this.note(`AI 선택지를 읽지 못했습니다: ${opts.message}`);
      return;
    }
    for (const id of ids) {
      if (this.stopTurn) return;
      const m = arr(opts.data?.members).find((x) => x?.memberId === id);
      if (!m) {
        this.note(`${id} 팀원을 찾지 못했습니다.`);
        continue;
      }
      const deep = ['producer', 'architect', 'qa'].includes(m.roleId);
      const light = m.roleId === 'docs';
      const tier = deep ? 'high' : light ? 'low' : 'normal';
      const aiKind = m.ai?.kind === 'codex' ? 'codex' : 'claude';
      const models = arr(opts.data?.models?.[aiKind]).filter((o) => isRec(o) && typeof o.id === 'string');
      const model = models.length ? models[deep ? 0 : Math.min(1, models.length - 1)].id : null;
      const why = deep ? '설계·검수처럼 깊은 판단이 필요해' : light ? '정리·기록 위주라' : '구현 중심이라';
      await this.pause(0.3);
      const r = await this.tool('set_member_ai', {
        member_id: id,
        ai_kind: aiKind,
        model,
        effort_tier: tier,
        reason: `모의 판단: ${m.roleName ?? m.roleId} 역할은 ${why} 노력치 단계를 ${tier}로, 모델은 ${model ?? 'CLI 기본값'}으로 정함`,
        request_id: this.rid(),
      });
      this.note(r.ok ? `${m.name}(${id}) AI 설정: ${aiKind}${model ? ` ${model}` : ''}, 노력치 단계 ${tier}` : `${m.name}(${id}) AI 설정 실패: ${r.message}`);
    }
  }
}

function stepMs(env, units = 1) {
  const factor = env.scenario === 'slow' ? SLOW_FACTOR : 1;
  return Math.max(MIN_STEP_MS, Math.round((BASE_STEP_MS * units * factor) / env.speed));
}

// ───────────────────────── 시작 ─────────────────────────

function parseArgs(argv) {
  const o = { format: null, sessionId: null, resume: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== '--format' && a !== '--session-id' && a !== '--resume') return { error: `알 수 없는 인자입니다: ${a}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${a} 값이 없습니다` };
    i++;
    if (a === '--format') o.format = v;
    else if (a === '--session-id') o.sessionId = v;
    else o.resume = v;
  }
  if (o.format !== 'claude' && o.format !== 'codex') return { error: '--format claude|codex가 필요합니다' };
  if (o.sessionId && o.resume) return { error: '--session-id와 --resume은 함께 쓸 수 없습니다' };
  return o;
}

function readEnv() {
  const e = process.env;
  const raw = (e.WOOK_MOCK_SCENARIO ?? '').trim();
  let scenario = raw || 'normal';
  if (!SCENARIOS.has(scenario)) {
    warn(`모의 에이전트: 알 수 없는 시나리오 '${raw}' — normal로 진행합니다`);
    scenario = 'normal';
  }
  let speed = Number(e.WOOK_MOCK_SPEED ?? '1');
  if (!Number.isFinite(speed) || speed <= 0) {
    warn(`모의 에이전트: 속도 값이 올바르지 않습니다 ('${e.WOOK_MOCK_SPEED}') — 1배로 진행합니다`);
    speed = 1;
  }
  const turn = Number.parseInt(e.WOOK_MOCK_TURN ?? '1', 10);
  return {
    mcpUrl: (e.WOOK_MCP_URL ?? '').trim(),
    mcpToken: (e.WOOK_MCP_TOKEN ?? '').trim(),
    server: (e.WOOK_MCP_SERVER ?? '').trim() || 'wook',
    scenario,
    speed,
    role: (e.WOOK_MOCK_ROLE ?? '').trim(),
    member: (e.WOOK_MOCK_MEMBER ?? '').trim(),
    workKey: (e.WOOK_MOCK_WORKKEY ?? '').trim(),
    turn: Number.isFinite(turn) && turn > 0 ? turn : 1,
    stateDir: (e.WOOK_MOCK_STATE_DIR ?? '').trim(),
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.replace(/^\uFEFF/, '');
}

/** 실제 CLI와 같은 세션 규칙: 이어하기 대상이 없으면 실패, Claude --session-id는 UUID이고 다시 쓸 수 없다 */
function resolveSession(format, args, store) {
  if (args.resume) {
    if (store.persistent && !store.read('sessions', `${format}-${args.resume}`, null)) return { ok: false, reason: 'missing', id: args.resume };
    return { ok: true, id: args.resume, isNew: false };
  }
  const id = args.sessionId ?? randomUUID();
  if (format === 'claude' && !UUID_RE.test(id)) return { ok: false, reason: 'invalid', id };
  if (format === 'claude' && store.persistent && store.read('sessions', `claude-${id}`, null)) return { ok: false, reason: 'in_use', id };
  return { ok: true, id, isNew: true };
}

/** 새 세션을 이어하기 가능한 것으로 기록 */
function registerSession(format, session, store, env) {
  if (!session.isNew) return;
  store.write('sessions', `${format}-${session.id}`, { id: session.id, format, createdAt: nowIso(), memberId: env.member, workKey: env.workKey });
}

function failSession(format, s) {
  if (format === 'claude') {
    if (s.reason === 'missing') claudeResumeMissing(s.id);
    else if (s.reason === 'invalid') warn('Error: Invalid session ID. Must be a valid UUID.');
    else warn(`Error: Session ID ${s.id} is already in use.`);
  } else {
    warn(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${s.id} (code -32600)`);
  }
  return exitWith(1);
}

function mcpUnavailable(format, out, err, resume, server) {
  if (format === 'claude') {
    // Claude는 연결 실패를 init에 failed로 알리고 턴은 계속한다 (__fixtures__/claude-mcp-unreachable.jsonl)
    out.start({ mcpStatus: 'failed' });
    out.say(`앱 도구 서버(${server})에 연결하지 못해 업무를 진행하지 못했습니다. (${err.message})`);
    out.end({});
    return exitWith(0);
  }
  // codex는 required=true인 서버의 연결 실패로 시작하지 못한다 (__fixtures__/codex-mcp-unreachable.stderr.txt)
  const phase = resume ? 'thread/resume' : 'thread/start';
  warn(`Error: ${phase}: ${phase} failed: error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: ${server}: handshaking with MCP server failed: ${err.message} (code -32603)`);
  return exitWith(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    warn(`Error: ${args.error}`);
    return exitWith(2);
  }
  const env = readEnv();
  const message = await readStdin();
  const store = new StateStore(env.stateDir);
  if (env.stateDir && !store.persistent) warn(`모의 에이전트: 상태 폴더는 절대 경로여야 합니다 (${env.stateDir}) — 이번 실행 안에서만 기억합니다`);
  const session = resolveSession(args.format, args, store);
  if (!session.ok) return failSession(args.format, session);
  // Claude는 앱 도구 연결에 실패해도 턴을 진행해 세션이 남는다. Codex는 thread/start가 성공해야 스레드가 생긴다 (아래)
  if (args.format === 'claude') registerSession(args.format, session, store, env);

  const cwd = process.cwd();
  const out =
    args.format === 'claude'
      ? new ClaudeOut({ sessionId: session.id, server: env.server, cwd, stdinChars: message.length })
      : new CodexOut({ sessionId: session.id, server: env.server, stdinChars: message.length });
  const mcp = new McpClient(env.mcpUrl, env.mcpToken);
  let mcpError = null;
  if (!env.mcpUrl || !env.mcpToken) mcpError = new McpError('WOOK_MCP_URL·WOOK_MCP_TOKEN 환경 변수가 없습니다', { transport: true });
  else {
    try {
      await mcp.connect();
    } catch (e) {
      if (!(e instanceof McpError)) throw e;
      mcpError = e;
    }
  }
  if (mcpError) return mcpUnavailable(args.format, out, mcpError, !!args.resume, env.server);
  if (args.format === 'codex') registerSession(args.format, session, store, env);

  const agent = new Agent({ out, mcp, env, store, message, cwd });
  try {
    await agent.runTurn();
  } catch (e) {
    if (!(e instanceof TurnExit)) throw e;
    await exitWith(e.code);
  }
}

main().catch(async (e) => {
  warn(`모의 에이전트 내부 오류: ${e?.stack ?? e}`);
  await exitWith(70);
});
