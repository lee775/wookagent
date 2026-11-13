/**
 * host_exec 출력과 기록의 비밀 값 (SERVER_DESIGN 8.2·8.4, 리드 결정 S5-16·S5-17·S5-19·S5-29·S5-31·S5-35·S5-36):
 * - 명령 출력에 든 등록 값·턴 토큰·형식으로 아는 비밀(GitHub·Anthropic 키)·여러 줄 개인 키는 도구 결과·실행 기록·활동 기록·메인 일지·도구 중복 캐시 어디에도 원문으로 없다
 * - 여러 줄 개인 키는 앞뒤를 자르기 전에 창으로 가린다 — 시작 줄이 버린 자리에 들어가도, 앞·뒤·그 둘에 걸쳐도, 끝 줄 없이 출력이 끝나도, 줄마다 앞말(줄 번호·
 *   파일 이름·diff의 '-')이나 꼬리('$')가 붙어도, 들여 써도, 표준 오류 줄이 끼어도, 끝 줄과 다음 키의 시작이 한 줄이어도 본문 줄이 하나도 남지 않는다 (S5-29·S5-35)
 * - 한 창에는 열린 키가 여럿일 수 있다 — 두 키의 줄이 섞여도(표준 출력·오류, 한 파이프의 두 프로세스, compose logs) 마지막 열린 키가 닫힐 때까지 창이 열려
 *   있고, util.inspect·JSON 배열·색 입힌 줄의 본문도 흘려 보낼 때 버린다 (S5-55)
 * - 창을 연 줄의 시작 표시 뒤 글을 남기면 시작 표시와 함께 남긴다. 출력 모으기는 같은 날 출력을 가리개로만 가린 것보다 덜 가리지 않는다(차등 불변식) (S5-61)
 * - 창 안에서 남기는 글은 base64 16자 넘는 이어짐을 '[가림:개인 키 조각]'으로 가린다 — 본문으로 보이는지의 짐작이 틀려도(진짜 줄바꿈으로 찍은 키가 끝 표시
 *   전에 잘리고 뒤에 글이 붙은 줄, 줄 끝 너그러움 밖의 꼴, 두 번 이스케이프한 값) 창 안에서 남긴 글에 16자 넘는 이어짐이 없다. 창 밖의 글은 그대로다 (S5-71)
 * - 그 글은 남길 때 백엔드 가리개로 먼저 가린다 — 16자 넘는 이름(databasePassword)·URL 사용자 옆의 값, 등록 값, wos_ 토큰이 남지 않는다. 날 출력을 가리개로만
 *   가려 가려지는 비밀은 text()에서도 가려진다(넓힌 차등 불변식, 씨앗 퍼즈) (S5-78)
 * - 아무 키도 닫지 않은 끝 표시의 대시를 함께 쓰는 시작 표시도 창을 연다 — 짧은 줄·버린 긴 줄·생략된 가운데·창 안·걷기 상한 (S5-79). 창을 닫은 끝 표시의
 *   대시로 시작한 시작 표시도 연다 — 겹친 키의 바깥·엇갈린 키의 나중·따옴표 든 줄이 낀 블록의 끝 표시, 흘려 보낸 창, 긴 줄 (S5-85). 방금 걸은 시작 표시의
 *   끝 대시로 시작한 끝 표시는 그 키를 닫지 않는다 (S5-90 4)
 * - 가리기가 실패해도 던지지 않는다 — 48KiB로 이어 쓴 대입은 가리개가 깊이 상한까지만 다시 훑고, 받은 가리개가 던지면 그 글이 '[가림:가리기 실패]'이며
 *   host_exec의 실행 기록(PID·띄운 시각)·남은 프로세스 접기·끝 활동 기록·일지는 그대로 이어진다. 띄운 뒤의 오류는 '띄우지 못했습니다'가 아니다 (S5-83)
 * - 긴 줄 하나의 표시 걷기는 닫은 표시 뒤 글까지 1,024개 — 넘으면 창을 출력 끝까지 연다(셈하는 키가 열린 채여도). 표시가 촘촘한 32MiB 한 줄도 바로
 *   돌아온다 (S5-65·S5-72·S5-77.1). 줄에서 떼어 남긴 조각은 그 줄을
 *   붙잡지 않는다 (S5-66)
 * - 가리기는 남긴 글에 한 번 한다 — 명령이 도는 사이 가리개가 알게 된 값도 가린다. 아주 긴 한 줄은 가리지 않고 바로 버린다 (S5-35·S5-36)
 * - 명령이나 cwd에 비밀 값이 들어 있으면 실행하지 않는다 — 가린 글을 실행하지도, 기록과 다른 원문을 실행하지도 않는다. 비밀 값 검사는 그 둘을 되풀이할 수 있는
 *   검사(cwd 모양·있는지·거부 목록)보다 먼저다. 처리기의 거부·오류 글은 CLI로 가기 전에 가린다 (S5-31)
 * - 출력은 앞 16KiB + 뒤 48KiB를 줄 단위로만 자르고 '…(n바이트 생략)…'을 넣는다. 실행 기록에는 가린 글의 끝 4,000자만 남긴다
 * - 띄운 셸의 환경에는 앱 도구 토큰·WOOK_*·AI 키·토큰 이름의 변수가 없다
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createRedactor } from '@core/redact';
import { BackendError } from '../../src/main/backend/types';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import { CheckOutputTail } from '../../src/main/orchestrator/autocheck';
import { toolCacheKey } from '../../src/main/orchestrator/tools';
import {
  HOST_EXEC_CWD_SECRET_REFUSAL,
  HOST_EXEC_HEAD_BYTES,
  HOST_EXEC_PEM_LONG_MARKERS,
  HOST_EXEC_PEM_OPEN_KEYS,
  HOST_EXEC_PEM_OPEN_KINDS,
  HOST_EXEC_PEM_WINDOW_BYTES,
  HOST_EXEC_RECORD_TAIL,
  HOST_EXEC_SECRET_REFUSAL,
  HOST_EXEC_TAIL_BYTES,
  HostExecOutput,
  looksLikeKeyBody,
} from '../../src/main/orchestrator/hostExec';
import { bootOrch, sleep, waitFor, type OrchEnv } from './orchHarness';
import { hostExec, hostRecords, liveMainTurn, okData, scriptedHost } from './hostExecRig';
import {
  B64_CHARS,
  bodyPieces,
  crossCase,
  dashJoinCase,
  FUZZ_LAYOUTS,
  fuzzCase,
  INLINE_CUT_SHAPES,
  inlineCutCase,
  inlineCutEnd,
  inlineCutLine,
  leakedPieces,
  longRun,
  OUTSIDE_LAYOUTS,
  REAL_CUT_SHAPES,
  realCutCase,
  realCutEnds,
  SECRET_FORMATS,
  SECRET_POSITIONS,
  secretCase,
  seeded,
  shownPieces,
} from './pemFuzzCases';

/**
 * 씨앗 퍼즈의 시간 예산. 경우 수는 개발 PC에서 30초 안에 들게 맞췄다(리드 결정 S5-71 — 6,200건이 약 20초). 공용 CI 러너는 같은 계산이 실행마다 다르게 걸린다:
 * GitHub ubuntu-24.04의 첫 두 실행에서 6,200건이 22.5초와 31.9초였고(둘째에서 30초를 넘겨 실패), 계산만 하는 다른 시험도 함께 40~65% 느렸다. 그래서 CI에서는
 * 예산을 두 배로 준다 — 몇 배씩 느려지는 되돌림은 그대로 잡는다. 시험의 시간 상한은 예산의 두 배 (리드 결정 S10-20)
 */
const FUZZ_BUDGET_MS = process.env.CI ? 60_000 : 30_000;

let env: OrchEnv | null = null;
const savedEnv: Record<string, string | undefined> = {};
const dirs: string[] = [];
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  vi.restoreAllMocks();
  await env?.close();
  env = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-hxr-'));
  dirs.push(d);
  return d;
};

/** 100바이트(줄바꿈 포함) 채움 줄 n개 */
const filler = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(4, '0')} ${'.'.repeat(94)}`);
/** 개인 키 본문 줄 25개 — 저마다 다른 base64 모양(64자) */
const KEY_BODY = Array.from({ length: 25 }, (_, i) => `MIIEow${String(i).padStart(2, '0')}IBAAKCAQEA${'q7Z9x2Lm'.repeat(6)}`.slice(0, 64));
const KEY = ['-----BEGIN RSA PRIVATE KEY-----', ...KEY_BODY, '-----END RSA PRIVATE KEY-----'];
/** 시작과 끝 표시가 한 줄에 다 든 키의 표시 */
const KEY_MARK = '[가림:개인 키]';
/** 시작 줄부터 끝 줄까지 n줄 창의 표시 (리드 결정 S5-35) */
const WIN_MARK = (n: number): string => `[가림:개인 키 — ${n}줄]`;
/** 끝 줄 없이 닫힌 창의 표시 — 버린 줄(시작 줄 포함) n줄 (리드 결정 S5-35) */
const CUT_MARK = (n: number): string => `[가림:개인 키(끝 줄 없음) — ${n}줄 가림]`;
/** 담는 상한에 닿아 흘려 보내기로 바꾼 창의 표시와, 끝 표시·출력 끝에서 닫힌 표시 — 본문으로 보여 버린 줄 n줄 (리드 결정 S5-48) */
const SPILL_MARK = '[가림:개인 키 — 끝 줄 전까지 본문으로 보이는 줄은 가림]';
const SPILL_END = (n: number): string => `[가림:개인 키 끝 — 본문으로 보이는 ${n}줄 가림]`;
const SPILL_CUT = (n: number): string => `[가림:개인 키(끝 줄 없음) — 본문으로 보이는 ${n}줄 가림]`;
/** 창 안에서 남기는 글의 base64 16자 넘는 이어짐을 바꾼 표시 (리드 결정 S5-71) */
const PIECE = '[가림:개인 키 조각]';

/** 줄들을 내는 서버 명령을 돌려 결과와, 결과·실행 기록·중복 캐시를 이은 글 */
async function runLines(e: OrchEnv, turnId: string, lines: string[], requestId: string) {
  scriptedHost(e, { lines });
  const d = okData(await hostExec(e, turnId, { command: 'node dump.js', request_id: requestId, purpose: '개인 키 출력 시험' }));
  const rec = hostRecords(e).find((x) => x.result.toolRequestId === requestId)!;
  const cache = JSON.stringify(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', requestId)) ?? null);
  return { d, rec, all: [d.output, JSON.stringify(rec), cache].join('\n') };
}

/** 원문으로 남은 개인 키 본문 줄 수 */
const bodyLinesIn = (s: string): number => KEY_BODY.filter((b) => s.includes(b)).length;

const REGISTERED = 'operator-registered-value-7Q2';
const GITHUB = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;
const ANTHROPIC = `sk-ant-api03-${'x9Y8'.repeat(20)}-AA`;
const PEM_BODY = 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu';

/** 기록 어디에나 원문이 없는지 — 도구 결과·실행 기록·활동 기록·메인 일지·도구 중복 캐시 */
function everywhere(e: OrchEnv, data: unknown, cacheKey: string): string {
  return [
    JSON.stringify(data),
    JSON.stringify(hostRecords(e)),
    JSON.stringify(e.ctx.store.activity.search({ limit: 500 })),
    JSON.stringify(e.ctx.store.journal.query({ limit: 200 })),
    JSON.stringify(e.ctx.store.kv.get(cacheKey)),
  ].join('\n');
}

describe('host_exec 출력의 비밀 값 (hostExecRedact)', () => {
  it('출력에 든 등록 값·턴 토큰·형식 비밀·여러 줄 개인 키는 결과·실행 기록·활동 기록·일지·중복 캐시에 원문으로 없다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.ctx.redact.addSecret(REGISTERED, 'api-key');
    const { turnId } = await liveMainTurn(e);
    const token = `tok-${turnId}`;
    scriptedHost(e, {
      lines: [
        `registered=${REGISTERED}`,
        `token ${token}`,
        `GITHUB ${GITHUB}`,
        `ANTHROPIC ${ANTHROPIC}`,
        '-----BEGIN RSA PRIVATE KEY-----',
        PEM_BODY,
        '-----END RSA PRIVATE KEY-----',
        '끝',
      ],
    });
    const r = await hostExec(e, turnId, { command: 'node print-secrets.js', request_id: 'rq-redact-1', purpose: '출력 가림 시험' });
    const d = okData(r);
    expect(d.exit_code).toBe(0);
    expect(d.output).toContain('[가림:');
    expect(d.output.endsWith('끝')).toBe(true);
    const all = everywhere(e, r, toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', 'rq-redact-1'));
    expect(all).toContain('rq-redact-1'); // 중복 캐시를 실제로 봤다
    for (const raw of [REGISTERED, token, GITHUB, ANTHROPIC, PEM_BODY]) expect(all.includes(raw), raw.slice(0, 12)).toBe(false);
    const rec = hostRecords(e)[0]!;
    expect(rec.state).toBe('succeeded');
    expect(String(rec.result.outputTail)).toContain('[가림:');
  });

  it('명령에 비밀 값이 들어 있으면 실행하지 않는다 — 정해진 글, 띄우지 않고 실행 기록도 없다 (가린 글도 원문도 돌지 않는다)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.ctx.redact.addSecret(REGISTERED, 'api-key');
    const { turnId } = await liveMainTurn(e);
    for (const command of [`curl -H "Authorization: Bearer ${GITHUB}" https://api.github.com`, `set KEY=${REGISTERED} && npm publish`, `echo tok-${turnId}`]) {
      const r = await hostExec(e, turnId, { command });
      expect(r).toEqual({ ok: false, code: 'forbidden', message: HOST_EXEC_SECRET_REFUSAL });
    }
    expect(HOST_EXEC_SECRET_REFUSAL).toBe('명령에 비밀 값(으로 보이는 글)이 들어 있어 실행하지 않았습니다 — 비밀 값은 서버 PC 운영자가 넣습니다');
    expect(e.hostSpecs).toEqual([]);
    expect(hostRecords(e)).toEqual([]);
  });

  it('출력은 앞 16KiB + 뒤 48KiB를 줄 단위로만 자르고 생략 표시를 넣는다 — 실행 기록은 끝 4,000자만', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const lines = Array.from({ length: 1200 }, (_, i) => `line-${String(i).padStart(5, '0')}-${'x'.repeat(90)}`);
    scriptedHost(e, { lines });
    const d = okData(await hostExec(e, turnId, { command: 'node big.js' }));
    const out = d.output.split('\n');
    const marker = out.findIndex((l) => /^…\(\d+바이트 생략\)…$/.test(l));
    expect(marker).toBeGreaterThan(0);
    expect(d.output_truncated).toBe(true);
    expect(out[marker]).toBe(`…(${d.output_omitted_bytes}바이트 생략)…`);
    // 줄 단위로만 — 생략 표시 말고는 모두 원래 줄 그대로이고, 앞은 처음부터·뒤는 마지막 줄까지 이어진다
    const kept = out.filter((_, i) => i !== marker);
    for (const l of kept) expect(lines).toContain(l);
    expect(out[0]).toBe(lines[0]);
    expect(out.at(-1)).toBe(lines.at(-1));
    const head = out.slice(0, marker).join('\n');
    const tail = out.slice(marker + 1).join('\n');
    expect(Buffer.byteLength(head) + 1).toBeLessThanOrEqual(HOST_EXEC_HEAD_BYTES);
    expect(Buffer.byteLength(tail) + 1).toBeLessThanOrEqual(HOST_EXEC_TAIL_BYTES);
    // 버린 바이트 + 남긴 바이트 = 전체 (줄마다 줄바꿈 1바이트)
    const total = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    expect(d.output_omitted_bytes + Buffer.byteLength(head) + 1 + Buffer.byteLength(tail) + 1).toBe(total);
    const rec = hostRecords(e)[0]!;
    expect(String(rec.result.outputTail).length).toBeLessThanOrEqual(HOST_EXEC_RECORD_TAIL);
    expect(d.output.endsWith(String(rec.result.outputTail))).toBe(true);
    expect(rec.result.outputBytes).toBe(total);
  });

  it('띄운 셸의 환경에는 앱 도구 토큰·WOOK_*·AI 키·토큰 이름의 변수가 없고 CI=1이 있다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    for (const [k, v] of Object.entries({ WOOK_MCP_TOKEN: 'leak-1', WOOK_DATA_DIR: 'C:/x', GITHUB_TOKEN: 'leak-2', ANTHROPIC_API_KEY: 'leak-3', MY_DB_PASSWORD: 'leak-4', KEEP_ME_HX: 'yes' })) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const { turnId } = await liveMainTurn(e);
    okData(await hostExec(e, turnId, { command: 'set' }));
    const spec = e.hostSpecs[0]!;
    const names = Object.keys(spec.env).map((k) => k.toUpperCase());
    for (const k of ['WOOK_MCP_TOKEN', 'WOOK_DATA_DIR', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'MY_DB_PASSWORD']) expect(names, k).not.toContain(k);
    expect(spec.env.KEEP_ME_HX).toBe('yes');
    expect(spec.env.CI).toBe('1');
    expect(spec.stdinText).toBeNull();
  });
});

describe('host_exec 출력의 여러 줄 개인 키 — 자르기 전에 가린다 (리드 결정 S5-29, 표시는 S5-35의 창)', () => {
  it('시작 줄이 버린 자리(앞과 뒤 사이)에 들어가도 뒤에 남은 본문 줄·끝 줄은 결과·실행 기록·중복 캐시에 없다 (프로브 zz-xs5-exec)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    // 앞 16KiB를 넘기고, 버려질 가운데, 키, 뒤 48KiB 대부분 — 원문만 모으면 뒤가 키 가운데에서 시작한다
    const { d, all } = await runLines(e, turnId, [...filler('H', 170), ...filler('M', 50), ...KEY, ...filler('T', 479)], 'rq-pem-middle');
    expect(d.output_truncated).toBe(true);
    expect({ body: bodyLinesIn(all), begin: all.includes('BEGIN RSA'), end: all.includes('END RSA PRIVATE KEY') }).toEqual({ body: 0, begin: false, end: false });
    expect(d.output.split('\n').at(-1)).toBe(filler('T', 479).at(-1));
  });

  it('키가 앞에 다 들어도, 뒤에 다 들어도, 앞과 뒤에 걸쳐도 본문은 없고 가림 표시 한 줄만 남는다 — 실행 기록 끝 4,000자는 가린 글에서 자른다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const head = await runLines(e, turnId, [...KEY, ...filler('A', 700)], 'rq-pem-head');
    expect(head.d.output_truncated).toBe(true);
    expect(head.d.output.split('\n')[0]).toBe(WIN_MARK(27));
    expect(bodyLinesIn(head.all)).toBe(0);
    const tail = await runLines(e, turnId, [...filler('B', 700), ...KEY, '끝'], 'rq-pem-tail');
    expect(tail.d.output.split('\n').slice(-2)).toEqual([WIN_MARK(27), '끝']);
    expect(bodyLinesIn(tail.all)).toBe(0);
    // 키가 출력 끝 가까이 있다 — 실행 기록의 끝 4,000자에도 가림 표시만
    expect(String(tail.rec.result.outputTail)).toContain(WIN_MARK(27));
    expect(bodyLinesIn(String(tail.rec.result.outputTail))).toBe(0);
    // 시작 줄은 앞의 마지막 자리에 들어가고, 원문이면 본문 몇 줄이 앞에·나머지가 뒤로 간다
    const span = await runLines(e, turnId, [...filler('C', 160), ...KEY, ...filler('D', 600)], 'rq-pem-span');
    expect(span.d.output_truncated).toBe(true);
    expect(span.d.output.split('\n')[160]).toBe(WIN_MARK(27));
    expect(bodyLinesIn(span.all)).toBe(0);
  });

  // 리드 결정 S5-35가 S5-29의 '본문이 아닌 줄에서 블록이 끝난다'를 바꿨다 — 끝 줄이 없으면 창의 줄 가운데 키 본문으로 보이는 줄(base64 40자 넘게)만 버린다
  it('끝 줄 없이 출력이 끝나도 시작 줄 뒤의 본문은 없다 — 끝 줄 없는 표시 한 줄 뒤에 창의 줄 가운데 키 본문으로 보이지 않는 줄만 차례대로 남는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const cut = await runLines(e, turnId, [...filler('E', 700), KEY[0]!, ...KEY_BODY], 'rq-pem-unterminated');
    expect(cut.d.output.split('\n').at(-1)).toBe(CUT_MARK(26));
    expect(bodyLinesIn(cut.all)).toBe(0);
    // 본문 사이·뒤의 보통 줄은 base64처럼 보여도(done — 줄 끝 16자 안, 리드 결정 S5-48) 남는다. 본문 뒤에 다시 본문이 와도 본문은 버린다
    const stop = await runLines(
      e,
      turnId,
      ['설치 시작', KEY[0]!, ...KEY_BODY.slice(0, 3), 'npm WARN deprecated left-pad@1.0.0', ...KEY_BODY.slice(3, 6), 'done', '끝'],
      'rq-pem-stop',
    );
    expect(stop.d.output.split('\n')).toEqual(['설치 시작', CUT_MARK(7), 'npm WARN deprecated left-pad@1.0.0', 'done', '끝']);
    expect(bodyLinesIn(stop.all)).toBe(0);
  });

  it('PGP 개인 키(머리 줄·빈 줄·검사 줄)와 암호화한 PEM(Proc-Type·DEK-Info)도 끝 줄까지 가린다. 끝 표시까지 한 줄에 든 키(JSON)는 그 줄만 가린다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const pgp = await runLines(
      e,
      turnId,
      ['앞', '-----BEGIN PGP PRIVATE KEY BLOCK-----', 'Version: GnuPG v2', 'Comment: test key', '', ...KEY_BODY.slice(0, 5), '=Ab3d', '-----END PGP PRIVATE KEY BLOCK-----', '끝'],
      'rq-pem-pgp',
    );
    // 창은 시작 줄·머리 둘·빈 줄·본문 다섯·검사 줄·끝 줄 — 11줄
    expect(pgp.d.output.split('\n')).toEqual(['앞', WIN_MARK(11), '끝']);
    const enc = await runLines(
      e,
      turnId,
      ['-----BEGIN RSA PRIVATE KEY-----', 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF', '', ...KEY_BODY.slice(5, 10), '-----END RSA PRIVATE KEY-----', '끝'],
      'rq-pem-enc',
    );
    expect(enc.d.output.split('\n')).toEqual([WIN_MARK(10), '끝']);
    const json = await runLines(e, turnId, [`{"private_key":"-----BEGIN PRIVATE KEY-----\\n${KEY_BODY[0]}\\n-----END PRIVATE KEY-----\\n","x":1}`, '끝'], 'rq-pem-json');
    expect(json.d.output.split('\n')).toEqual([`{"private_key":"${KEY_MARK}\\n","x":1}`, '끝']);
  });
});

/** 출력 모으기만 — 받은 줄을 넣고 가린 글을 줄로 (가리개는 앱과 같은 것) */
function collect(lines: string[], redact = createRedactor()): string[] {
  const out = new HostExecOutput((t) => redact.text(t));
  for (const l of lines) out.push(l);
  return out.text().split('\n');
}

const KEY_END = KEY.at(-1)!;
/** 끝 줄 바로 뒤에 다음 키가 붙은 둘째 키의 본문 (끝 줄바꿈 없는 PEM 파일 둘을 이어 찍음 — cat a.pem b.pem) */
const KEY_BODY2 = KEY_BODY.map((b) => b.replace('MIIEow', 'MIIEpQ'));

/** 줄마다 앞말·꼬리가 붙거나 줄이 끼어든 개인 키 (프로브 zz-xs5f1-pem·zz-s5f1ti-pem-prefixed·zz-s5f1ti-pem-indented) — [꼴, 줄, 기대 출력('끝' 앞)] */
const PEM_FORMS: Array<[string, string[], string[]]> = [
  ['cat -n (줄 번호와 탭)', KEY.map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`), ['     1\t', WIN_MARK(27)]],
  ['findstr /n (번호:줄)', KEY.map((l, i) => `${i + 1}:${l}`), ['1:', WIN_MARK(27)]],
  ['grep -A (파일:줄, 그 뒤는 파일-줄)', KEY.map((l, i) => `./keys/id_rsa${i === 0 ? ':' : '-'}${l}`), ['./keys/id_rsa:', WIN_MARK(27)]],
  ['Select-String (파일:번호:줄)', KEY.map((l, i) => `key.pem:${i + 1}:${l}`), ['key.pem:1:', WIN_MARK(27)]],
  [
    'git diff — 지운 키 (- 앞말)',
    ['diff --git a/key.pem b/key.pem', 'deleted file mode 100644', '--- a/key.pem', '+++ /dev/null', '@@ -1,27 +0,0 @@', ...KEY.map((l) => `-${l}`)],
    ['diff --git a/key.pem b/key.pem', 'deleted file mode 100644', '--- a/key.pem', '+++ /dev/null', '@@ -1,27 +0,0 @@', '-', WIN_MARK(27)],
  ],
  ['cat -A ($ 꼬리 — 끝 표시 뒤 글은 다시 본다)', KEY.map((l) => `${l}$`), [WIN_MARK(27), '$']],
  ['본문 가운데 표준 오류 한 줄 (npm WARN)', [KEY[0]!, ...KEY_BODY.slice(0, 10), 'npm WARN deprecated inflight@1.0.6', ...KEY_BODY.slice(10), KEY_END], [WIN_MARK(28)]],
  ['끝 줄과 다음 키의 시작이 한 줄 (cat a.pem b.pem)', [KEY[0]!, ...KEY_BODY, `${KEY_END}${KEY[0]}`, ...KEY_BODY2, KEY_END], [WIN_MARK(27), WIN_MARK(27)]],
  [
    '들여 쓴 YAML 블록 (Kubernetes 비밀)',
    ['apiVersion: v1', 'kind: Secret', 'stringData:', '  tls.key: |', ...KEY.map((l) => `    ${l}`)],
    ['apiVersion: v1', 'kind: Secret', 'stringData:', '  tls.key: |', WIN_MARK(27)],
  ],
];

const bothBodiesIn = (s: string): number => bodyLinesIn(s) + KEY_BODY2.filter((b) => s.includes(b)).length;

describe('host_exec 출력의 개인 키 창 — 시작 줄부터 끝 줄까지를 담았다가 한 줄로 (리드 결정 S5-35)', () => {
  for (const [name, lines, expected] of PEM_FORMS) {
    it(`${name}: 본문 줄이 하나도 남지 않고 창이 표시 한 줄이 된다 — 시작 표시 앞 글은 보통 줄, 그 뒤 줄은 그대로`, () => {
      const out = collect([...lines, '끝']);
      expect(bothBodiesIn(out.join('\n'))).toBe(0);
      expect(out).toEqual([...expected, '끝']);
    });
  }

  it('host_exec 끝까지: 줄 번호 앞말(findstr /n)·들여 쓴 YAML 키 — 결과·실행 기록 끝·중복 캐시에 본문이 없다 (프로브 zz-xs5f1-pem·zz-s5f1ti-pem-indented)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    for (const [name, requestId] of [
      ['findstr /n (번호:줄)', 'rq-pem-findstr'],
      ['들여 쓴 YAML 블록 (Kubernetes 비밀)', 'rq-pem-yaml'],
    ] as const) {
      const [, lines, expected] = PEM_FORMS.find(([n]) => n === name)!;
      const { d, rec, all } = await runLines(e, turnId, [...lines, '끝'], requestId);
      expect(d.output.split('\n'), name).toEqual([...expected, '끝']);
      expect(all).toContain(requestId); // 중복 캐시를 실제로 봤다
      expect({ all: bodyLinesIn(all), tail: bodyLinesIn(String(rec.result.outputTail)) }, name).toEqual({ all: 0, tail: 0 });
      expect(String(rec.result.outputTail)).toContain(WIN_MARK(27));
    }
  });

  it('host_exec 끝까지: 표준 오류 줄이 키 줄 사이에 끼어도 같은 창에 담긴다 — 표준 출력과 표준 오류는 한 차례로 모인다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    scriptedHost(e, {
      exitAfterMs: 50,
      onStart: (p) =>
        setTimeout(() => {
          p.line('설치 시작');
          for (const l of [KEY[0]!, ...KEY_BODY.slice(0, 10)]) p.line(l);
          p.errLine('(node:4242) Warning: something on stderr');
          for (const l of [...KEY_BODY.slice(10), KEY_END, '끝']) p.line(l);
        }, 1),
    });
    const d = okData(await hostExec(e, turnId, { command: 'node print-key.js', request_id: 'rq-pem-stderr', purpose: '키 출력 시험' }));
    expect(d.output.split('\n')).toEqual(['설치 시작', WIN_MARK(28), '끝']);
    const rec = hostRecords(e).find((x) => x.result.toolRequestId === 'rq-pem-stderr')!;
    const cache = JSON.stringify(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', 'rq-pem-stderr')) ?? null);
    expect({ record: bodyLinesIn(JSON.stringify(rec)), cache: bodyLinesIn(cache) }).toEqual({ record: 0, cache: 0 });
  });

  // 리드 결정 S5-48이 S5-35의 '상한에 닿으면 끝 줄 없는 창으로 닫는다'를 바꿨다 — 닫으면 그 뒤의 본문 줄이 창 밖에 남았다(프로브 zz-xs5f3-pemmid)
  it('400줄에 닿아도 창은 닫히지 않고 흘려 보낸다 — 담은 본문 줄은 버리고 보통 줄은 남기며, 끝 표시가 창을 닫는다 (리드 결정 S5-48)', () => {
    // 시작 줄 + 본문 398줄 + 보통 줄 하나 = 400줄에 닿는다 (32KiB보다 먼저)
    const body = Array.from({ length: 398 }, (_, i) => `${'QUJD'.repeat(12)}${String(i).padStart(3, '0')}`);
    const out = collect([KEY[0]!, ...body, '메모: 끝 표시 앞', KEY_END, '끝']);
    expect(out).toEqual([SPILL_MARK, '메모: 끝 표시 앞', SPILL_END(398), '끝']);
    expect(body.filter((b) => out.join('\n').includes(b))).toEqual([]);
    // 흘려 보내는 중에 온 본문 줄도 버린다 — 끝 표시까지
    const more = collect([KEY[0]!, ...body, ...KEY_BODY, 'npm WARN 끼어든 줄', KEY_END, '끝']);
    expect(more).toEqual([SPILL_MARK, 'npm WARN 끼어든 줄', SPILL_END(398 + KEY_BODY.length), '끝']);
    expect(bodyLinesIn(more.join('\n'))).toBe(0);
  });

  it('32KiB에 닿아도 창은 닫히지 않는다 — 줄 수가 적어도 흘려 보내고, 본문으로 보이지 않는 줄은 그대로 남는다 (리드 결정 S5-48)', () => {
    // 줄마다 1,001바이트(줄바꿈 포함) — 시작 줄 32바이트와 함께 33줄째에 32KiB(32,768바이트)에 닿는다
    const wide = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, '0')} ${'x '.repeat(498)}x`);
    expect(Buffer.byteLength(wide[0]!) + 1).toBe(1001);
    const out = collect([KEY[0]!, ...wide, KEY_END, '끝']);
    // 33줄째에 흘려 보내기로 바뀐다 — 넓은 줄은 줄 끝이 'x' 한 글자라 본문으로 보이지 않아 모두 남고, 끝 표시가 창을 닫는다(가린 본문 0줄)
    expect(out).toEqual([SPILL_MARK, ...wide, SPILL_END(0), '끝']);
    const w = new HostExecOutput((t) => t);
    for (const l of [KEY[0]!, ...wide.slice(0, 32), KEY_END]) w.push(l);
    // 32줄이면 아직 닫히지 않아 끝 표시가 창을 닫는다
    expect(w.text().split('\n')).toEqual([WIN_MARK(34)]);
  });

  // 리드 결정 S5-43이 S5-36의 '창 안의 긴 줄은 끝 줄 없는 창으로 닫는다'를 바꿨다 — 닫으면 그 뒤의 본문 줄이 창 밖에 남았다(프로브 zz-s5f2ti-pem-longline-inwindow)
  it('창 안에 뒤 상한(48KiB)보다 긴 줄이 와도 창을 닫지 않는다 — 그 줄은 생략으로 세고 창에는 한 줄로 세며, 끝 표시가 창을 닫는다 (리드 결정 S5-43)', () => {
    const long = 'QUJD'.repeat(13_000);
    const out = new HostExecOutput((t) => createRedactor().text(t));
    for (const l of [KEY[0]!, ...KEY_BODY.slice(0, 3), long, KEY_END, '끝']) out.push(l);
    // 창: 시작 줄 + 본문 3 + 긴 줄의 자리 + 끝 줄 = 6줄. 긴 줄을 버리며 앞을 닫아 생략 표시가 먼저다
    expect(out.text().split('\n')).toEqual([`…(${long.length + 1}바이트 생략)…`, WIN_MARK(6), '끝']);
    expect(out.omitted).toBe(long.length + 1);
    // 긴 줄 뒤의 본문 줄도 창에 담긴다 — 키 가운데 끼어든 긴 표준 오류 줄(진행 막대)
    const progress = `progress ${'#'.repeat(60_000)}`;
    const text = collect([KEY[0]!, ...KEY_BODY.slice(0, 5), progress, ...KEY_BODY.slice(5), KEY_END, '끝']);
    expect(bodyLinesIn(text.join('\n'))).toBe(0);
    expect(text).toEqual([`…(${progress.length + 1}바이트 생략)…`, WIN_MARK(28), '끝']);
  });

  it('출력이 끝날 때(시간 초과·정지 포함) 열린 창은 끝 줄 없는 창으로 닫는다 — 시작 줄만 있어도 표시가 남는다', () => {
    expect(collect(['앞', KEY[0]!])).toEqual(['앞', CUT_MARK(1)]);
    expect(collect([`  key: "${KEY[0]}`, KEY_BODY[0]!])).toEqual(['  key: "', CUT_MARK(2)]);
  });

  it('명령이 도는 사이 가리개가 알게 된 값도 결과·실행 기록 끝에서 가린다 — 가리기는 남긴 글에 한 번 (프로브 zz-s5f1ti-final-pass)', async () => {
    const LATE = 'late-registered-Value-4Kq9Zt7Wm2';
    // 출력 모으기만: 줄을 넣은 뒤 등록한 값
    const r = createRedactor();
    const out = new HostExecOutput((t) => r.text(t));
    out.push(`printed ${LATE}`);
    r.addSecret(LATE, 'api-key');
    expect(out.text()).toBe('printed [가림:api-key]');
    // host_exec 끝까지
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    scriptedHost(e, { lines: [`printed ${LATE}`, '끝'], exitAfterMs: 400 });
    const pending = hostExec(e, turnId, { command: 'node print.js', request_id: 'rq-late' });
    await waitFor(() => e.hostProcs.length > 0, '서버 명령 시작');
    await sleep(150);
    e.ctx.redact.addSecret(LATE, 'api-key');
    const d = okData(await pending);
    expect(d.output.split('\n')).toEqual(['printed [가림:api-key]', '끝']);
    const tail = String(hostRecords(e).find((x) => x.result.toolRequestId === 'rq-late')!.result.outputTail);
    expect(tail.includes(LATE)).toBe(false);
    expect(tail).toContain('[가림:api-key]');
  });
});

describe('host_exec 출력 모으기는 줄 크기에 비례하는 일을 하지 않는다 (리드 결정 S5-36)', () => {
  it('받는 줄은 가리지 않는다 — 가리기는 text()에서 남긴 글(64KiB 안)에 한 번', () => {
    const seen: number[] = [];
    const r = createRedactor();
    const out = new HostExecOutput((t) => {
      seen.push(t.length);
      return r.text(t);
    });
    for (let i = 0; i < 2000; i++) out.push(`line-${i} ${'y'.repeat(60)}`);
    out.push('Q'.repeat(HOST_EXEC_TAIL_BYTES + 1));
    expect(seen).toEqual([]);
    out.text();
    expect(seen).toHaveLength(1);
    expect(seen[0]!).toBeLessThanOrEqual(HOST_EXEC_HEAD_BYTES + HOST_EXEC_TAIL_BYTES + 64);
  });

  it('32MiB 한 줄의 push는 바로 돌아오고(넉넉히 1초 안) 생략 바이트를 바르게 센다 — 베끼지도 가리지도 않는다', () => {
    const r = createRedactor();
    for (let i = 0; i < 2000; i++) r.addSecret(`turn-token-${i}-${'x'.repeat(20)}`, 'token');
    const out = new HostExecOutput((t) => r.text(t));
    out.push('앞 줄');
    const line = Buffer.alloc(24 * 1024 * 1024, 7).toString('base64').slice(0, 32 * 1024 * 1024);
    const t0 = performance.now();
    out.push(line);
    const took = performance.now() - t0;
    // 넉넉하지만 작은 상한 — 그 줄을 가리면(고치기 전·변이) 수백 ms가 걸린다 (리드 결정 S5-36)
    expect(took, `push ${Math.round(took)}ms`).toBeLessThan(250);
    expect(out.omitted).toBe(line.length + 1);
    expect(out.total).toBe(Buffer.byteLength('앞 줄') + 1 + line.length + 1);
    out.push('뒤 줄');
    expect(out.text().split('\n')).toEqual(['앞 줄', `…(${line.length + 1}바이트 생략)…`, '뒤 줄']);
  });

  it('가린 표시가 원문보다 길어 상한을 넘어도 다시 가리기는 몇 번에 그친다 (넘친 만큼, 그다음엔 두 배씩 버림)', () => {
    const SHORT = 'q7Zx2Lm9';
    const r = createRedactor();
    r.addSecret(SHORT, 'api-key');
    let calls = 0;
    const out = new HostExecOutput((t) => {
      calls++;
      return r.text(t);
    });
    // 뒤 48KiB를 짧은 등록 값 줄로 채운다 — 가리면 줄마다 길어져 상한을 넘는다
    for (let i = 0; i < 12_000; i++) out.push(SHORT);
    const text = out.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(HOST_EXEC_HEAD_BYTES + HOST_EXEC_TAIL_BYTES + 64);
    expect(text).not.toContain(SHORT);
    expect(calls).toBeLessThanOrEqual(20);
  });
});

/** 줄바꿈 없는 압축 JSON 본문(약 72KB) — 그 바로 뒤에 키 파일이 찍히면 시작 표시가 이 긴 줄의 끝에 붙는다 (프로브 zz-s5f2ti-pem-longline) */
const MINIFIED = `{"items":[${Array.from({ length: 2500 }, (_, i) => `{"id":${i},"name":"pkg-${i}"}`).join(',')}]}`;
const omittedMark = (n: number): string => `…(${n}바이트 생략)…`;

describe('긴 줄과 개인 키 — 값싼 개인 키 검사는 긴 줄을 버리기 전에 한다 (리드 결정 S5-43)', () => {
  it('창 밖의 긴 줄 끝에 시작 표시가 있으면 그 표시만 담은 창을 연다 — 뒤의 본문 줄은 창에 담기고 긴 줄은 생략으로 센다 (프로브 zz-xs5f2-longbegin·zz-s5f2ti-pem-longline)', () => {
    const LONG = 'x'.repeat(60 * 1024);
    expect(LONG.length).toBeGreaterThan(HOST_EXEC_TAIL_BYTES);
    const a = collect(['first line', `${LONG}${KEY[0]}`, ...KEY_BODY, KEY_END, 'last line']);
    expect(a).toEqual(['first line', omittedMark(LONG.length + KEY[0]!.length + 1), WIN_MARK(27), 'last line']);
    expect(MINIFIED.length).toBeGreaterThan(HOST_EXEC_TAIL_BYTES);
    const b = new HostExecOutput((t) => createRedactor().text(t));
    for (const l of [`${MINIFIED}${KEY[0]}`, ...KEY_BODY, KEY_END, '끝']) b.push(l);
    expect(b.text().split('\n')).toEqual([omittedMark(MINIFIED.length + KEY[0]!.length + 1), WIN_MARK(27), '끝']);
    expect(b.omitted).toBe(MINIFIED.length + KEY[0]!.length + 1);
  });

  it('host_exec 끝까지: 긴 줄 끝의 시작 표시 — 결과·실행 기록 끝·중복 캐시에 본문 줄이 없다 (프로브 zz-xs5f2-longbegin·zz-s5f2ti-pem-longline)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    for (const [lines, requestId] of [
      [['first line', `${'x'.repeat(60 * 1024)}${KEY[0]}`, ...KEY_BODY, KEY_END, 'last line'], 'rq-pem-longbegin'],
      [[`${MINIFIED}${KEY[0]}`, ...KEY_BODY, KEY_END, '끝'], 'rq-pem-minified'],
    ] as const) {
      const { d, rec, all } = await runLines(e, turnId, [...lines], requestId);
      expect(all).toContain(requestId); // 중복 캐시를 실제로 봤다
      expect({ all: bodyLinesIn(all), output: bodyLinesIn(d.output), tail: bodyLinesIn(String(rec.result.outputTail)) }, requestId).toEqual({ all: 0, output: 0, tail: 0 });
      expect(d.output.split('\n').slice(-2)).toEqual([WIN_MARK(27), lines.at(-1)]);
      expect(d.output_truncated).toBe(true);
    }
  });

  it('긴 줄에 시작·끝 표시가 다 들고 그 뒤에 둘째 시작 표시가 있으면 둘째에서 창을 연다 — 끝 표시만 뒤따르는 긴 줄은 그냥 버린다', () => {
    const tail = 'x'.repeat(60 * 1024);
    const two = `${KEY[0]}${KEY_BODY[0]}${KEY_END}${tail}${KEY[0]}`;
    expect(collect([two, ...KEY_BODY2, KEY_END, '끝'])).toEqual([omittedMark(two.length + 1), WIN_MARK(27), '끝']);
    // 끝 표시가 뒤따르는 시작 표시뿐인 긴 줄 — 창을 열지 않는다: 다음 줄은 보통 줄
    const closed = `${KEY[0]}${KEY_BODY[0]}${KEY_END}${tail}`;
    expect(collect([closed, '다음 줄', '끝'])).toEqual([omittedMark(closed.length + 1), '다음 줄', '끝']);
    expect(collect([tail, '다음 줄'])).toEqual([omittedMark(tail.length + 1), '다음 줄']);
  });

  it('창 안의 긴 줄에 그 창의 끝 표시가 있으면 창을 닫고(그 줄은 창의 한 줄) 끝 표시 뒤 글을 다시 본다 — 그 글도 길면 그 끝의 시작 표시가 새 창을 연다', () => {
    const long = 'x'.repeat(60 * 1024);
    const rest = `${'y'.repeat(60 * 1024)}${KEY[0]}`;
    const a = collect([KEY[0]!, ...KEY_BODY.slice(0, 3), `${long}${KEY_END}${rest}`, ...KEY_BODY2, KEY_END, '끝']);
    // 첫 창: 시작 줄 + 본문 3 + 끝 표시가 든 긴 줄 = 5줄. 끝 표시 뒤의 긴 글은 생략으로 세고 그 끝의 시작 표시가 둘째 창을 연다
    expect(a).toEqual([WIN_MARK(5), omittedMark(rest.length + 1), WIN_MARK(27), '끝']);
    expect(bothBodiesIn(a.join('\n'))).toBe(0);
    // 끝 표시 뒤 글이 짧으면 보통 줄 — 긴 줄은 창에 가려져 생략으로 세지 않는다
    const out = new HostExecOutput((t) => t);
    for (const l of [KEY[0]!, ...KEY_BODY.slice(0, 3), `${long}${KEY_END} 뒤 메모`, '끝']) out.push(l);
    expect(out.text().split('\n')).toEqual([WIN_MARK(5), ' 뒤 메모', '끝']);
    expect(out.omitted).toBe(0);
    // 끝 표시 뒤의 짧은 글에 다음 키의 시작 표시가 있으면 그 표시가 둘째 창을 연다 (프로브 zz-s5f3ti-hx-kills — 리드 결정 S5-52.3) — 가리개 없이 본다
    const next = new HostExecOutput((t) => t);
    for (const l of [KEY[0]!, ...KEY_BODY.slice(0, 3), `${long}${KEY_END} ${KEY[0]}`, ...KEY_BODY2, KEY_END, '끝']) next.push(l);
    expect(next.text().split('\n')).toEqual([WIN_MARK(5), WIN_MARK(27), '끝']);
  });

  // 리드 결정 S5-48: 400줄에 닿으면 닫지 않고 흘려 보낸다 — 이 시험은 그 상한에 긴 줄이 한 줄로 세어지는지를 본다
  it('창 안의 긴 줄은 400줄 상한에 한 줄로 센다 — 32KiB 상한에는 그 줄의 크기가 아니라 자리표만 센다', () => {
    const body = Array.from({ length: 398 }, (_, i) => `${'QUJD'.repeat(12)}${String(i).padStart(3, '0')}`);
    const long = 'Z'.repeat(50_000);
    // 시작 줄 + 본문 398 + 긴 줄의 자리 = 400줄에 닿아 흘려 보내기로 바뀐다. 자리표는 보통 줄로 남지 않고 본문 수에도 들지 않는다
    expect(collect([KEY[0]!, ...body, long, '메모', KEY_END, '끝'])).toEqual([omittedMark(long.length + 1), SPILL_MARK, '메모', SPILL_END(398), '끝']);
    // 시작 줄 + 본문 396 + 긴 줄의 자리 + '메모' = 399줄이면 아직 담는 중이라 끝 표시가 창 전체(끝 줄 포함 400줄)를 한 줄로 만든다
    expect(collect([KEY[0]!, ...body.slice(2), long, '메모', KEY_END, '끝'])).toEqual([omittedMark(long.length + 1), WIN_MARK(400), '끝']);
    // 32KiB 가까이 찬 창에 긴 줄이 와도(줄 크기를 세면 넘친다) 창은 열려 있어 끝 표시가 닫는다
    const wide = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')} ${'x '.repeat(498)}x`);
    expect(collect([KEY[0]!, ...wide, long, KEY_END, '끝'])).toEqual([omittedMark(long.length + 1), WIN_MARK(33), '끝']);
  });

  it('개인 키 표시가 든 32MiB 한 줄의 push도 바로 돌아온다(넉넉히 250ms 안) — 값싼 검사는 그 줄을 베끼지도 가리지도 않는다', () => {
    const r = createRedactor();
    const out = new HostExecOutput((t) => r.text(t));
    const line = `${Buffer.alloc(24 * 1024 * 1024, 7).toString('base64').slice(0, 32 * 1024 * 1024 - 64)} PRIVATE KEY ${KEY[0]}`;
    const t0 = performance.now();
    out.push(line);
    const took = performance.now() - t0;
    expect(took, `push ${Math.round(took)}ms`).toBeLessThan(250);
    for (const l of [...KEY_BODY, KEY_END, '끝']) out.push(l);
    expect(out.text().split('\n')).toEqual([omittedMark(line.length + 1), WIN_MARK(27), '끝']);
  });
});

describe('출력 모으기의 경계 (리드 결정 S5-46 — 시험이 닿지 않던 갈래, 프로브 zz-s5f2ti-hx-kills)', () => {
  // 리드 결정 S5-48이 S5-35의 '끝 줄 없는 창은 base64가 40자 넘게 이어진 줄을 버린다'를 줄 끝 규칙으로 바꿨다 — 줄 끝만 본다.
  // 리드 결정 S5-71이 남기는 줄의 기대를 바꿨다 — 줄 가운데의 40자는 줄을 버리게 하지 않지만(보여 주는 모양), 남기기 전에 '[가림:개인 키 조각]'으로 가린다
  it('키 본문으로 보이는 줄: 줄 끝이 base64 16자 넘게(15자면 아님), 또는 2자 넘게 뒤에 = 이나 == — 줄 가운데의 긴 base64로는 줄을 버리지 않는다(남길 때 가린다) (리드 결정 S5-48·S5-71)', () => {
    const run40 = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo';
    expect(run40).toHaveLength(40);
    // 줄 끝이 40자 → 버림. 40자가 줄 가운데에 있고 끝이 ' end'면 남기되 그 40자는 가린다
    expect(collect([KEY[0]!, `  ${run40}`, `note ${run40} end`])).toEqual([CUT_MARK(2), `note ${PIECE} end`]);
    // 16자와 15자 — 앞말(번호:)은 상관없다
    expect(collect([KEY[0]!, `12:x ${run40.slice(0, 16)}`, `13:x ${run40.slice(0, 15)}`])).toEqual([CUT_MARK(2), `13:x ${run40.slice(0, 15)}`]);
    // 채운 마지막 줄 — 2자 + == 와 3자 + = 는 버리고, 1자 + == 와 = 없는 짧은 줄은 남긴다(받아들인 것 — 키를 다시 만들 수 없다)
    expect(collect([KEY[0]!, 'Zg==', 'Zm8=', 'Z==', 'Zm9v'])).toEqual([CUT_MARK(3), 'Z==', 'Zm9v']);
    // 꼬리: 끝의 공백·\r, cat -A의 '$'와 CRLF의 '^M$'를 뗀 뒤에 본다
    expect(collect([KEY[0]!, `${run40}  `, `${run40}\r`, `${run40}$`, `${run40}^M$`, 'done$'])).toEqual([CUT_MARK(5), 'done$']);
    // 본문 줄의 영숫자는 + / 로 끊기면 16자에 못 미칠 수 있다 — + / 까지 base64로 봐야 버린다
    const slashy = 'MIIEowIBAAKCAQEAq7Z9x2Lm/Qw3Er5Ty7+Ui9Op1As3Df5Gh7Jk9Lz2Xc4Vb/m8Q+w0'.slice(0, 64);
    expect(slashy.slice(-16).split(/[+/]/).every((p) => p.length < 16)).toBe(true);
    expect(collect([KEY[0]!, slashy])).toEqual([CUT_MARK(2)]);
    expect(looksLikeKeyBody(`-${slashy}`)).toBe(true);
    expect(looksLikeKeyBody('npm WARN deprecated left-pad@1.0.0')).toBe(false);
  });

  // 리드 결정 S5-48이 S5-46의 '창은 32KiB에 꼭 닿으면 끝 줄 없는 창으로 닫힌다'를 바꿨다 — 닿으면 닫지 않고 흘려 보낸다
  it('32KiB에 꼭 닿으면 흘려 보내기로 바뀌고 1바이트 모자라면 아직 담는다 — 시작 줄이 이미 32KiB를 넘으면 바로 흘려 보낸다 (리드 결정 S5-48)', () => {
    const filler = Array.from({ length: 31 }, (_, i) => `${String(i).padStart(2, '0')} ${'x '.repeat(509)}x`);
    const used = Buffer.byteLength(KEY[0]!) + 1 + filler.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    const exact = 'y'.repeat(HOST_EXEC_PEM_WINDOW_BYTES - used - 1);
    expect(used + exact.length + 1).toBe(HOST_EXEC_PEM_WINDOW_BYTES);
    // 32KiB에 닿는다 — 보통 줄(채움)은 남고 'yyyy…'(줄 끝이 base64 16자 넘게)는 버린다. 끝 표시가 창을 닫는다
    expect(collect([KEY[0]!, ...filler, exact, KEY_END, '끝'])).toEqual([SPILL_MARK, ...filler, SPILL_END(1), '끝']);
    expect(collect([KEY[0]!, ...filler, exact.slice(1), KEY_END, '끝'])).toEqual([WIN_MARK(34), '끝']);
    // 시작 줄의 시작 표시 뒤 글이 32KiB를 넘는다 — 그 글도 줄 끝 규칙으로 본다
    expect(collect([`${KEY[0]}${'A'.repeat(33_000)}`, KEY_END, '끝'])).toEqual([SPILL_MARK, SPILL_END(1), '끝']);
    // 리드 결정 S5-61이 이 줄의 기대를 바꿨다 — 남기는 시작 줄은 시작 표시와 함께 남고, 마지막 가리기가 그 표시를 '[가림:개인 키]'로 바꾼다(그 뒤 보통 글은 그대로)
    const note = `${KEY[0]} 예시 ${'#'.repeat(33_000)} 끝`;
    expect(collect([note, KEY_END, '끝'])).toEqual([SPILL_MARK, `${KEY_MARK} 예시 ${'#'.repeat(33_000)} 끝`, SPILL_END(0), '끝']);
    // 흘려 보내다 끝 표시 없이 출력이 끝난다
    expect(collect([KEY[0]!, ...filler, exact, ...KEY_BODY, '마지막'])).toEqual([SPILL_MARK, ...filler, '마지막', SPILL_CUT(1 + KEY_BODY.length)]);
  });

  it('앞 상한(16KiB)보다 길고 뒤 상한(48KiB)보다 짧은 줄은 버리지 않는다 — 생략 표시는 긴 줄이 버려진 자리(그 앞의 뒤 줄과 함께)에 선다', () => {
    const mid = `{"bundle":"${'m'.repeat(20 * 1024)}"}`;
    const big = 'b'.repeat(40 * 1024);
    expect(collect(['시작', mid, '끝'])).toEqual(['시작', mid, '끝']);
    expect(collect(['시작', big])).toEqual(['시작', big]);
    const out = new HostExecOutput((t) => t);
    const head = Array.from({ length: 200 }, (_, i) => `head-${String(i).padStart(3, '0')} ${'h'.repeat(80)}`);
    for (const l of head) out.push(l);
    for (const l of ['tail-1', 'tail-2', 'L'.repeat(60_000), 'after']) out.push(l);
    const lines = out.text().split('\n');
    const mark = lines.findIndex((l) => l.startsWith('…('));
    expect(lines.slice(mark + 1)).toEqual(['after']);
    expect(lines.slice(0, mark).every((l) => l.startsWith('head-'))).toBe(true);
    expect(lines[mark]).toBe(omittedMark(out.omitted));
  });
});

/** 진행 막대 한 줄 — '\r'로 이은 갱신, base64 16자 이어짐 없음 (프로브 zz-xs5f3-pemmid) */
const progressBar = (size: number): string => {
  let s = '';
  for (let p = 0; s.length < size; p++) s += `\r[${'#'.repeat(p % 30).padEnd(30, ' ')}] ${p % 100}% `;
  return s.slice(0, size);
};
/** 본문 줄 26개 (프로브 zz-xs5f3-pemmid의 모양) */
const MID_BODY = Array.from({ length: 26 }, (_, i) => `MIIEow${String(i).padStart(2, '0')}IBAAKCAQEA${'q7Z9x2Lm'.repeat(7)}`.slice(0, 64));
const midShown = (s: string): number => MID_BODY.filter((b) => s.includes(b)).length;
const midLayout = (size: number): string[] => ['before', KEY[0]!, ...MID_BODY.slice(0, 10), progressBar(size), ...MID_BODY.slice(10), KEY_END, 'after'];

/** 긴 줄과 창의 꼴 12개 (프로브 zz-xs5f3-pemlong) — 줄 크기 s */
const lbody = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `MII${tag}${String(i).padStart(2, '0')}AAKCAQEA${'q7Z9x2Lm'.repeat(7)}`.slice(0, 64));
const LB = (k = 'RSA '): string => `-----BEGIN ${k}PRIVATE KEY-----`;
const LE = (k = 'RSA '): string => `-----END ${k}PRIVATE KEY-----`;
const LA1 = lbody('Aa', 8);
const LA2 = lbody('Ab', 8);
const LC1 = lbody('Ca', 8);
const sized = (size: number, head: string, tail: string): string => `${head}${'x'.repeat(Math.max(0, size - head.length - tail.length))}${tail}`;
const LONG_LAYOUTS: Record<string, (s: number) => string[]> = {
  '긴 줄 끝에 시작 표시, 본문, 끝 표시': (s) => ['a', sized(s, '', LB()), ...LA1, ...LA2, LE(), 'z'],
  '시작 표시, 본문, 긴 채움, 본문, 끝 표시': (s) => ['a', LB(), ...LA1, sized(s, '', ''), ...LA2, LE(), 'z'],
  '시작 표시, 본문, 끝 표시로 끝나는 긴 줄': (s) => ['a', LB(), ...LA1, ...LA2, sized(s, '', LE()), 'z'],
  '시작 표시, 본문, 끝 표시와 다음 시작 표시가 든 긴 줄, 본문, 끝 표시': (s) => ['a', LB(), ...LA1, sized(s, '', `${LE()} ${LB()}`), ...LA2, LE(), 'z'],
  '시작 표시, 본문, 끝 표시 + 긴 채움 + 시작 표시, 본문, 끝 표시': (s) => ['a', LB(), ...LA1, `${LE()}${'x'.repeat(s)}${LB()}`, ...LA2, LE(), 'z'],
  '키가 한 줄에 다 든 긴 줄, 그다음 보통 키': (s) => ['a', sized(s, '', `${LB()}\\n${LA1.join('\\n')}\\n${LE()}`), 'mid', LB(), ...LA2, LE(), 'z'],
  '시작 표시로 시작하는 긴 줄, 본문, 끝 표시': (s) => ['a', sized(s, LB(), ''), ...LA1, ...LA2, LE(), 'z'],
  '긴 줄: RSA 키 한 줄 + EC 시작 표시, EC 본문, EC 끝 표시': (s) => ['a', sized(s, '', `${LB()}${LE()} ${'x'.repeat(100)} ${LB('EC ')}`), ...LC1, LE('EC '), 'z'],
  '긴 줄 끝에 시작 표시, 긴 채움 둘, 본문, 끝 표시': (s) => ['a', sized(s, '', LB()), sized(s, '', ''), sized(s, '', ''), ...LA1, ...LA2, LE(), 'z'],
  '시작 표시, 본문, 다른 종류의 끝·시작 표시가 든 긴 줄, 본문, 끝 표시': (s) => ['a', LB(), ...LA1, sized(s, '', `${LE('EC ')} ${LB('EC ')}`), ...LA2, LE(), 'z'],
  '긴 줄 끝에 시작 표시, 본문, 끝 표시가 든 긴 줄, 보통 키': (s) => ['a', sized(s, '', LB()), ...LA1, sized(s, '', LE()), LB(), ...LA2, LE(), 'z'],
  '본문 줄 사이의 짧은 줄과 긴 줄': (s) => ['a', LB(), ...LA1.flatMap((l) => [l, 'npm WARN x']), sized(s, '', ''), ...LA2.flatMap((l) => [l, 'npm WARN y']), LE(), 'z'],
};

describe('개인 키 창은 끝 표시나 출력 끝에서만 닫힌다 (리드 결정 S5-48)', () => {
  it('창 안의 31·33·40·47·48KiB, 48KiB + 1, 60KiB 줄과 2.3KB 줄 20개: 본문 줄이 하나도 남지 않는다 (프로브 zz-xs5f3-pemmid)', () => {
    const shown: Record<string, number> = {};
    for (const [name, size] of [
      ['31KiB', 31 * 1024],
      ['33KiB', 33 * 1024],
      ['40KiB', 40 * 1024],
      ['47KiB', 47 * 1024],
      ['48KiB', HOST_EXEC_TAIL_BYTES],
      ['48KiB+1', HOST_EXEC_TAIL_BYTES + 1],
      ['60KiB', 60 * 1024],
    ] as const) {
      const out = collect(midLayout(size));
      shown[name] = midShown(out.join('\n'));
      expect(out[0], name).toBe('before');
      expect(out.at(-1), name).toBe('after');
    }
    const inter: string[] = ['before', KEY[0]!];
    MID_BODY.forEach((b, i) => {
      inter.push(b);
      if (i < 20) inter.push(`npm WARN deprecated ${'progress '.repeat(250)}`);
    });
    inter.push(KEY_END, 'after');
    const outInter = collect(inter);
    shown.interleaved = midShown(outInter.join('\n'));
    expect(shown).toEqual({ '31KiB': 0, '33KiB': 0, '40KiB': 0, '47KiB': 0, '48KiB': 0, '48KiB+1': 0, '60KiB': 0, interleaved: 0 });
    // 40KiB: 담는 상한에 닿아 흘려 보낸다 — 진행 막대는 남고 본문 26줄을 가린다
    const forty = collect(midLayout(40 * 1024));
    expect([forty[0], forty[1], forty.slice(-2)]).toEqual(['before', SPILL_MARK, [SPILL_END(26), 'after']]);
    expect(forty).toContain(progressBar(40 * 1024));
    // 끼어든 줄 20개: 경고 줄은 남고 본문 26줄을 가린다
    expect(outInter.filter((l) => l.startsWith('npm WARN'))).toHaveLength(20);
    expect(outInter.at(-2)).toBe(SPILL_END(26));
  });

  it('긴 줄과 창의 꼴 12개 × 48KiB·48KiB + 1·60KiB·1MiB: 본문 줄이 하나도 남지 않는다 (프로브 zz-xs5f3-pemlong)', () => {
    const all = [...LA1, ...LA2, ...LC1];
    const leaks: string[] = [];
    for (const [name, make] of Object.entries(LONG_LAYOUTS)) {
      for (const [sz, s] of Object.entries({ '48KiB': HOST_EXEC_TAIL_BYTES, '48KiB+1': HOST_EXEC_TAIL_BYTES + 1, '60KiB': 60 * 1024, '1MiB': 1 << 20 })) {
        const out = collect(make(s)).join('\n');
        const n = all.filter((b) => out.includes(b)).length;
        if (n > 0) leaks.push(`${name} @ ${sz}: ${n}`);
        // 가리개 없이도 — 마지막 가리기(시작~끝 표시)에 기대지 않는다
        const raw = new HostExecOutput((t) => t);
        for (const l of make(s)) raw.push(l);
        const m = leakedPieces(raw.text(), all).length;
        if (m > 0) leaks.push(`${name} @ ${sz} (가리개 없이): 조각 ${m}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('host_exec 끝까지: 창 안의 40KiB 진행 막대 — 결과·실행 기록 끝·중복 캐시에 본문 줄이 없다 (프로브 zz-xs5f3-pemmid)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const { d, rec, all } = await runLines(e, turnId, midLayout(40 * 1024), 'rq-pem-progress40');
    expect(all).toContain('rq-pem-progress40'); // 중복 캐시를 실제로 봤다
    const cache = JSON.stringify(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', 'rq-pem-progress40')) ?? null);
    expect({ output: midShown(d.output), cache: midShown(cache), record: midShown(JSON.stringify(rec)), tail: midShown(String(rec.result.outputTail)) }).toEqual({ output: 0, cache: 0, record: 0, tail: 0 });
    expect(d.output.split('\n').slice(-2)).toEqual([SPILL_END(26), 'after']);
    expect(String(rec.result.outputTail)).toContain(SPILL_END(26));
  });

  // 리드 결정 S5-59.2 (프로브 zz-s5f4ti-long-bound) — S5F8의 S48-long-in-window-closes는 돌지 않았다(닻 0)
  it('창을 400줄에 닿게 하는 긴 줄은 그 자리에서 흘려 보내기를 연다 — 끝 표시가 바로 뒤에 와도 담은 창 표시가 아니다. 긴 줄만 오는 창도 자리표를 400개 넘게 담지 않는다', () => {
    const body = Array.from({ length: 398 }, (_, i) => `${'QUJD'.repeat(12)}${String(i).padStart(3, '0')}`);
    const long = 'Z'.repeat(50_000);
    // 시작 줄 + 본문 398 + 긴 줄의 자리 = 400줄 — 그 긴 줄이 흘려 보내기를 연다(끝 표시가 바로 다음 줄)
    expect(collect([KEY[0]!, ...body, long, KEY_END, '끝'])).toEqual([omittedMark(long.length + 1), SPILL_MARK, SPILL_END(398), '끝']);
    // 긴 줄만 450개 — 400줄에서 흘려 보내기로 바뀌고(그 표시는 뒤의 긴 줄이 버리는 뒤 줄과 함께 버려진다) 끝 표시는 흘려 보낸 창의 표시다
    const wide = 'Z'.repeat(49_200);
    const out = collect([KEY[0]!, ...KEY_BODY.slice(0, 10), ...Array.from({ length: 450 }, () => wide), KEY_END, '끝']);
    expect(out.slice(1)).toEqual([SPILL_END(10), '끝']);
    expect(out[0]).toMatch(/^…\(\d+바이트 생략\)…$/);
  });

  // 리드 결정 S5-59.3 (프로브 zz-s5f4ti-end-kind) — S5-55에서도 열리지 않은 종류의 끝 표시는 보통 글이다
  it('창 안의 보통 줄에 든 다른 종류의 끝 표시는 창을 닫지 않는다 — 담는 중에도, 흘려 보내는 중에도 (가리개 없이)', () => {
    const a = lbody('Ra', 8);
    const b = lbody('Rb', 8);
    const raw = (lines: string[]): string => {
      const o = new HostExecOutput((t) => t);
      for (const l of lines) o.push(l);
      return o.text();
    };
    const buffered = raw(['a', LB(), ...a, `# see ${LE('EC ')} in the other file`, ...b, LE(), 'z']);
    expect([...a, ...b].filter((l) => buffered.includes(l))).toEqual([]);
    expect(buffered.split('\n')).toEqual(['a', WIN_MARK(19), 'z']);
    const pad = Array.from({ length: 400 }, (_, i) => `npm WARN line ${i}`);
    const spilled = raw(['a', LB(), ...a, ...pad, LE('EC '), ...b, LE(), 'z']);
    expect([...a, ...b].filter((l) => spilled.includes(l))).toEqual([]);
    expect(spilled.split('\n').slice(-3)).toEqual([LE('EC '), SPILL_END(16), 'z']);
  });

  // 리드 결정 S5-59.3 (프로브 zz-s5f4ti-tail-kills 2·3) — S5-48 규칙 4: 시작 줄의 시작 표시 뒤 글도 같은 규칙으로 본다.
  // 리드 결정 S5-61이 보통 글의 기대를 바꿨다 — 시작 표시와 함께 남고(가리개 없이 보면 표시가 그대로), 가리개를 거치면 '[가림:개인 키] …'다
  it('출력이 끝날 때 담던 창: 시작 표시 뒤의 본문 같은 글은 남기지 않고, 보통 글은 시작 표시와 함께 남긴다 (리드 결정 S5-61)', () => {
    const inline = `MIIEowIBAAKCAQEA${'q7Z9x2Lm'.repeat(6)}`.slice(0, 64);
    const body = KEY_BODY.slice(0, 3);
    const o = new HostExecOutput((t) => t);
    for (const l of ['a', `${KEY[0]}${inline}`, ...body]) o.push(l);
    const a = o.text();
    expect([inline, ...body].filter((x) => a.includes(x))).toEqual([]);
    expect(a.split('\n')).toEqual(['a', CUT_MARK(4)]);
    const b = new HostExecOutput((t) => t);
    for (const l of ['a', `${KEY[0]} (deploy.sh 예시)`, ...body]) b.push(l);
    expect(b.text().split('\n')).toEqual(['a', CUT_MARK(4), `${KEY[0]} (deploy.sh 예시)`]);
    expect(collect(['a', `${KEY[0]} (deploy.sh 예시)`, ...body])).toEqual(['a', CUT_MARK(4), `${KEY_MARK} (deploy.sh 예시)`]);
    // 시작 표시 뒤가 비면(공백뿐이어도) 남기지 않는다
    expect(rawLines(['a', `${KEY[0]}   `, ...body])).toEqual(['a', CUT_MARK(4)]);
  });

  // 리드 결정 S5-59.5 (프로브 zz-s5f4ti-mark-count) — 끝 줄 없는 표시의 n은 시작 줄·본문으로 보이는 줄·긴 줄의 자리표를 센다
  it('출력이 끝날 때 담던 창의 긴 줄 자리표도 끝 줄 없는 표시의 줄 수에 든다', () => {
    const long = 'Z'.repeat(50_000);
    const out = new HostExecOutput((t) => t);
    for (const l of [KEY[0]!, ...KEY_BODY.slice(0, 3), long, '메모']) out.push(l);
    expect(out.text().split('\n')).toEqual([omittedMark(long.length + 1), CUT_MARK(5), '메모']);
  });

  // 리드 결정 S5-55가 S5-48의 퍼즈를 넓혔다 — 엇갈린 키(쓰는 쪽 1~3개)의 경우 2,400건, 줄 끝 꼴(util.inspect·JSON 배열·색), 창 안의 다른 종류 끝 표시.
  // 리드 결정 S5-61이 한 줄에서 끝 표시 전에 잘린 키 1,200건(담는 중 끝 표시·흘려 보냄·출력 끝)과 차등 불변식을 더했다. S5-67이 꼴에 콘솔 폭 공백 채움과
  // CRLF 키의 util.inspect를, 엇갈린 키에 시작 표시 줄 앞의 한 줄에 다 든 키를 더했다.
  // 리드 결정 S5-71이 이 퍼즈를 다시 짰다 — 창 안에서 남기는 글은 base64 이어짐을 가리므로 모든 경우를 가리개 없이도 보고, 불변식 ①(가리개 없이 모은 글에 base64
  // 16자 넘는 이어짐이 없다 — 만들개들은 창 밖에 그런 글을 쓰지 않는다)을 더했다. 새 만들개: 진짜 줄바꿈으로 찍은 키가 끝 표시 전에 잘린 꼴 1,000건(본문
  // 16~63자 + 뒤 글, 절반은 줄마다 compose 앞말, 네 길), 줄 끝 너그러움 밖의 꼴(ESC[K·sed -n l·표 테두리·줄 이음 \·끝의 마침표·두 번 이스케이프한 JSON)로
  // 찍은 차례 키 600건과 엇갈린 키 600건, 한 줄에서 잘린 키의 두 번 이스케이프한 \\n. 30초 안에 들게 갈래 수를 맞췄다(차례 2,000·엇갈림 2,200·한 줄 1,000·
  // 진짜 줄바꿈 1,000 = 6,200건, 엇갈림 1,000건 넘게).
  // 리드 결정 S5-78이 백엔드 가리개 쪽을 경우마다 따로 만든 모으기로 바꿨다(아래) — 창 안의 글을 남길 때 가리므로 가리개를 바꿔 text()를 다시 부르면 그
  // 모으기가 아니다. 키 본문 밖의 비밀(이름 붙은 값·URL·등록 값·wos_)의 차등 불변식은 'S5-78' 퍼즈가 본다
  it('씨앗 퍼즈 6,200건(엇갈린 키 1,000건 넘게, 한 줄에서 잘린 키 1,000건, 진짜 줄바꿈으로 잘린 키 1,000건, 너그러움 밖의 꼴 1,200건): 가리개 없이 모은 글에 base64 16자 넘는 이어짐과 본문 조각이 없고, 날 출력을 가리개로만 가린 것보다 덜 가리지 않는다 (리드 결정 S5-48·S5-55·S5-61·S5-71)', () => {
    const rand = seeded(0x5f48);
    const red = createRedactor();
    const t0 = performance.now();
    const failures: string[] = [];
    /** 불변식 ① (리드 결정 S5-71): 가리개 없이 모은 글에 base64 16자 넘는 이어짐이 없다 */
    const longRuns: string[] = [];
    /** 차등 불변식 (리드 결정 S5-61): 백엔드 가리개로 모은 글에 남은 본문 조각은 날 출력 전체를 그 가리개로만 가린 글에도 남아 있어야 한다 */
    const lessThanPlain: string[] = [];
    let spilled = 0;
    let unterminated = 0;
    let truncated = 0;
    let crossing = 0;
    let tolerantSpilled = 0;
    let otherEnds = 0;
    let inlineBefore = 0;
    const positions: Record<string, number> = { end: 0, buffered: 0, spill: 0, 'spill-end': 0 };
    let inlineKept = 0;
    let doubleEscaped = 0;
    const realPositions: Record<string, number> = { end: 0, buffered: 0, spill: 0, 'spill-end': 0 };
    let realPrefixed = 0;
    let realMasked = 0;
    let outsideMasked = 0;
    const crossOutPool = [...FUZZ_LAYOUTS, ...OUTSIDE_LAYOUTS];
    const cases = [
      ...Array.from({ length: 1400 }, () => 'seq' as const),
      ...Array.from({ length: 600 }, () => 'seq-out' as const),
      ...Array.from({ length: 1600 }, () => 'cross' as const),
      ...Array.from({ length: 600 }, () => 'cross-out' as const),
      ...Array.from({ length: 1000 }, () => 'inline' as const),
      ...Array.from({ length: 1000 }, () => 'realcut' as const),
    ];
    cases.forEach((kind, c) => {
      const none = { windowInline: [] as string[], crossing: false, tolerant: false, otherEnds: 0, position: null as string | null, prefixed: false };
      const k =
        kind === 'seq' || kind === 'seq-out'
          ? { ...none, ...fuzzCase(rand, kind === 'seq' ? FUZZ_LAYOUTS : OUTSIDE_LAYOUTS) }
          : kind === 'cross' || kind === 'cross-out'
            ? { ...none, ...crossCase(rand, kind === 'cross' ? FUZZ_LAYOUTS : crossOutPool) }
            : kind === 'inline'
              ? { ...none, ...inlineCutCase(rand) }
              : { ...none, ...realCutCase(rand) };
      // 같은 줄을 두 모으기에 넣는다 — 가리개 없이, 백엔드 가리개로. 리드 결정 S5-78부터 창 안에서 남기는 글은 남길 때 그 모으기의 가리개로 먼저 가리므로,
      // 한 모으기의 text()를 가리개를 바꿔 두 번 부르던 예전 방식(두 번째 text()를 경우 100개마다 새 백엔드 가리개 모으기와 견줌 — notSame)은 더 이상 백엔드
      // 가리개 모으기가 내는 글이 아니다. 그래서 경우마다 백엔드 가리개 모으기를 따로 만든다(모든 경우가 진짜 백엔드 가리개 모으기다)
      const out = new HostExecOutput((t) => t);
      const backend = new HostExecOutput((t) => red.text(t));
      for (const l of k.lines) {
        out.push(l);
        backend.push(l);
      }
      const bare = out.text();
      // 본문 조각은 경우마다 한 번만 만든다 — 창 안 보통 줄의 한 줄 키(windowInline)도 이제 창이 가린다(S5-71)
      const pieces = bodyPieces([...k.bodies, ...k.windowInline]);
      // 가리개 없이 — 창만으로 base64 이어짐도 본문도 남지 않는다
      const run = longRun(bare);
      if (run && longRuns.length < 5) longRuns.push(`경우 ${c}(${kind}${k.position ? `·${k.position}` : ''}): ${run.slice(0, 40)}`);
      const leakedBare = leakedPieces(bare, [], pieces);
      if (leakedBare.length && failures.length < 5) failures.push(`경우 ${c}(${kind}): ${leakedBare.length}조각 (${leakedBare[0]})`);
      if (kind !== 'inline' && kind !== 'realcut') {
        if (bare.includes(SPILL_MARK)) spilled++;
        if (bare.includes('(끝 줄 없음)')) unterminated++;
        if (out.omitted > 0) truncated++;
        if (k.crossing) crossing++;
        if (k.tolerant && /본문으로 보이는 [1-9]/.test(bare)) tolerantSpilled++;
        // 창 밖의 줄에서 열린 시작 표시 앞에 한 줄 키가 붙은 경우 (S5-67.3)
        if (k.lines.reduce((m, l) => m + (l.includes('{"k":"-----BEGIN') ? l.split('{"k":"-----BEGIN').length - 1 : 0), 0) > k.windowInline.length) inlineBefore++;
        otherEnds += k.otherEnds;
        // 너그러움 밖의 꼴로 남긴 줄을 가린 경우
        if ((kind === 'seq-out' || kind === 'cross-out') && bare.includes(PIECE)) outsideMasked++;
      }
      // 백엔드 가리개로 — 본문 조각이 없고, 어느 경우든 가리개로만 가린 것보다 덜 가리지 않는다
      const text = backend.text();
      const leaked = leakedPieces(text, [], pieces);
      if (kind === 'inline') {
        positions[k.position!]!++;
        // 남긴 시작 줄 — 남길 때의 가리기가 시작 표시와 그 뒤 PEM 꼬리(이스케이프한 줄바꿈으로 이은 본문)를 '[가림:개인 키]'로 바꾼다. 예전에는 그 뒤에 '\'로
        // 이은 조각 표시가 남아 `${KEY_MARK}\\`로 셌다 — 이제 남긴 시작 줄은 그 표시로 시작하는 줄이다 (리드 결정 S5-78)
        if (text.split('\n').some((l) => l.startsWith(KEY_MARK))) inlineKept++;
        if (k.lines.some((l) => l.includes('-----\\\\n'))) doubleEscaped++;
      }
      if (kind === 'realcut') {
        realPositions[k.position!]!++;
        if (k.prefixed) realPrefixed++;
        if (bare.includes(PIECE)) realMasked++;
      }
      if (leaked.length && failures.length < 5) failures.push(`경우 ${c}(${kind}${k.position ? `·${k.position}` : ''}, 백엔드 가리개): ${leaked.length}조각 (${leaked[0]})`);
      if (leaked.length) {
        const plain = red.text(k.lines.join('\n'));
        const worse = leaked.filter((p) => !plain.includes(p));
        if (worse.length && lessThanPlain.length < 5) lessThanPlain.push(`경우 ${c}(${kind}): 가리개만으로는 가려지는 조각 ${worse.length}개가 남음 (${worse[0]})`);
      }
    });
    const took = performance.now() - t0;
    // 불변식을 함께 본다 — 하나가 깨져도 다른 쪽 결과가 함께 보인다
    expect({ longRuns, failures, lessThanPlain }).toEqual({ longRuns: [], failures: [], lessThanPlain: [] });
    // 경우들이 갈래에 고루 닿았는지 — 흘려 보내기·끝 줄 없음·잘림, 엇갈림 1,000건 넘게, 줄 끝 꼴로 본문을 버린 흘려 보내기, 창 안의 다른 종류 끝 표시,
    // 시작 표시 줄 앞의 한 줄에 다 든 키, 한 줄에서 잘린 키의 네 길과 시작 표시와 함께 남은 시작 줄·두 번 이스케이프한 꼴, 진짜 줄바꿈으로 잘린 키의 네 길과
    // compose 앞말·가려 남긴 잘린 줄, 너그러움 밖의 꼴로 가려 남긴 줄
    const seen = { spilled, unterminated, truncated, crossing, tolerantSpilled, otherEnds, inlineBefore, positions, inlineKept, doubleEscaped, realPositions, realPrefixed, realMasked, outsideMasked };
    expect(
      {
        spilled: spilled > 300,
        unterminated: unterminated > 150,
        truncated: truncated > 800,
        crossing: crossing >= 1000,
        tolerantSpilled: tolerantSpilled > 50,
        otherEnds: otherEnds > 100,
        inlineBefore: inlineBefore > 150,
        positions: Object.values(positions).every((n) => n > 200),
        inlineKept: inlineKept > 300,
        doubleEscaped: doubleEscaped > 50,
        realPositions: Object.values(realPositions).every((n) => n > 150),
        realPrefixed: realPrefixed > 300,
        realMasked: realMasked > 300,
        outsideMasked: outsideMasked > 100,
      },
      JSON.stringify(seen),
    ).toEqual({
      spilled: true,
      unterminated: true,
      truncated: true,
      crossing: true,
      tolerantSpilled: true,
      otherEnds: true,
      inlineBefore: true,
      positions: true,
      inlineKept: true,
      doubleEscaped: true,
      realPositions: true,
      realPrefixed: true,
      realMasked: true,
      outsideMasked: true,
    });
    expect(took, `${Math.round(took)}ms`).toBeLessThan(FUZZ_BUDGET_MS);
  }, FUZZ_BUDGET_MS * 2);
});

/** 두 키를 엇갈려 찍는 꼴 셋 (프로브 zz-xs5f4-pemfuzz) — A는 RSA 본문 26줄, B는 둘째 키 본문 8줄 */
const CA = Array.from({ length: 26 }, (_, i) => `MIIEowAA${String(i).padStart(2, '0')}${'Qw3rTy7u'.repeat(8)}`.slice(0, 64));
const CB = Array.from({ length: 8 }, (_, i) => `MHcCAQBB${String(i).padStart(2, '0')}${'Zx9cVb2n'.repeat(8)}`.slice(0, 64));
const crossShown = (s: string): number => [...CA, ...CB].filter((b) => s.includes(b)).length;
const CROSS_LAYOUTS: Record<string, string[]> = {
  'RSA는 표준 출력, EC는 표준 오류 — 섞여 찍힘': [
    'start',
    LB(),
    ...CA.slice(0, 10),
    LB('EC '),
    ...CA.slice(10, 20).flatMap((a, i) => (i < 4 ? [a, CB[i]!] : [a])),
    ...CA.slice(20),
    LE(),
    ...CB.slice(4),
    LE('EC '),
    'done',
  ],
  '한 파이프에 쓰는 두 프로세스의 RSA 키 둘': ['start', LB(), ...CA.slice(0, 6), LB(), ...CA.slice(6, 12).flatMap((a, i) => [a, CB[i]!]), ...CA.slice(12), LE(), ...CB.slice(6), LE(), 'done'],
  'docker compose logs — 두 서비스': [
    'svc-a  | -----BEGIN PRIVATE KEY-----',
    ...CA.slice(0, 4).map((a) => `svc-a  | ${a}`),
    'svc-b  | -----BEGIN PRIVATE KEY-----',
    ...CA.slice(4, 26).flatMap((a, i) => [`svc-a  | ${a}`, ...(i < 4 ? [`svc-b  | ${CB[i]}`] : [])]),
    'svc-a  | -----END PRIVATE KEY-----',
    ...CB.slice(4).map((b) => `svc-b  | ${b}`),
    'svc-b  | -----END PRIVATE KEY-----',
  ],
};
const rawLines = (lines: string[]): string[] => {
  const o = new HostExecOutput((t) => t);
  for (const l of lines) o.push(l);
  return o.text().split('\n');
};

describe('개인 키 창에는 열린 키가 여럿일 수 있다 — 모두 닫혀야 창이 닫힌다 (리드 결정 S5-55)', () => {
  it('엇갈린 키 꼴 셋(표준 출력·오류, 한 파이프의 두 프로세스, compose logs): 본문 줄이 하나도 남지 않고 창 전체가 한 줄이 된다 (프로브 zz-xs5f4-pemfuzz)', () => {
    const expected: Record<string, string[]> = {
      'RSA는 표준 출력, EC는 표준 오류 — 섞여 찍힘': ['start', WIN_MARK(38), 'done'],
      '한 파이프에 쓰는 두 프로세스의 RSA 키 둘': ['start', WIN_MARK(38), 'done'],
      'docker compose logs — 두 서비스': ['svc-a  | ', WIN_MARK(38)],
    };
    for (const [name, lines] of Object.entries(CROSS_LAYOUTS)) {
      const out = collect(lines);
      expect(crossShown(out.join('\n')), name).toBe(0);
      expect(out, name).toEqual(expected[name]);
      // 가리개 없이도
      expect(rawLines(lines), name).toEqual(expected[name]);
    }
  });

  it('host_exec 끝까지: 엇갈린 키 꼴 셋 — 표준 출력과 표준 오류로 찍어도 결과·실행 기록 끝·중복 캐시에 본문 줄이 없다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    let n = 0;
    for (const [name, lines] of Object.entries(CROSS_LAYOUTS)) {
      const requestId = `rq-cross-${++n}`;
      // 첫 꼴은 EC 키(시작 표시와 그 본문·끝 표시)를 표준 오류로 낸다 — 표준 출력·오류는 한 차례로 모인다
      const toErr = (l: string): boolean => n === 1 && (l.includes('EC PRIVATE') || CB.includes(l));
      scriptedHost(e, {
        exitAfterMs: 30,
        onStart: (p) =>
          setTimeout(() => {
            for (const l of lines) (toErr(l) ? p.errLine(l) : p.line(l));
          }, 1),
      });
      const d = okData(await hostExec(e, turnId, { command: 'node keys.js', request_id: requestId, purpose: '엇갈린 키 시험' }));
      const rec = hostRecords(e).find((x) => x.result.toolRequestId === requestId)!;
      const cache = JSON.stringify(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', requestId)) ?? null);
      expect(cache, name).toContain(requestId); // 중복 캐시를 실제로 봤다
      expect({ output: crossShown(d.output), tail: crossShown(String(rec.result.outputTail)), cache: crossShown(cache), record: crossShown(JSON.stringify(rec)) }, name).toEqual({ output: 0, tail: 0, cache: 0, record: 0 });
      expect(d.output, name).toContain(WIN_MARK(38));
    }
  });

  it('키 셋이 겹치고 엇갈려도(같은 종류·다른 종류) 마지막으로 열린 키가 닫힐 때까지 창이 열려 있다 — 담는 중에도, 흘려 보내는 중에도', () => {
    const a = lbody('Na', 6);
    const b = lbody('Nb', 6);
    const c = lbody('Nc', 6);
    const all = [...a, ...b, ...c];
    // 겹침: RSA 안에 EC, 그 안에 RSA 하나 더 — 안쪽 RSA의 끝 표시는 RSA를 하나만 닫는다
    const nested = [LB(), a[0]!, LB('EC '), b[0]!, LB(), c[0]!, LE(), b[1]!, ...b.slice(2), LE('EC '), ...a.slice(1), ...c.slice(1), LE(), '뒤'];
    expect(rawLines(nested)).toEqual([WIN_MARK(nested.length - 1), '뒤']);
    // 엇갈림: 셋이 차례로 열리고 열린 차례대로 닫힌다 — 첫 둘의 끝 표시 뒤에도 남은 키의 본문이 온다
    const crossed = [LB(), LB('EC '), a[0]!, b[0]!, LB('DSA '), c[0]!, LE(), ...b.slice(1), ...c.slice(1, 3), LE('EC '), ...c.slice(3), LE('DSA '), '뒤'];
    expect(rawLines(crossed)).toEqual([WIN_MARK(crossed.length - 1), '뒤']);
    // 같은 종류 셋
    const same = [LB(), a[0]!, LB(), b[0]!, LB(), c[0]!, ...a.slice(1), LE(), ...b.slice(1), LE(), ...c.slice(1), LE(), '뒤'];
    expect(rawLines(same)).toEqual([WIN_MARK(same.length - 1), '뒤']);
    // 흘려 보내는 중에도 — 400줄을 넘긴 뒤 첫 끝 표시들은 창을 닫지 않고, 그 뒤 본문 줄도 버린다
    const pad = Array.from({ length: 420 }, (_, i) => `npm WARN ${i}`);
    const spilled = rawLines([LB(), LB('EC '), a[0]!, ...pad, LE(), ...b, LB('DSA '), LE('EC '), ...c, LE('DSA '), '뒤']);
    expect(all.filter((x) => spilled.join('\n').includes(x))).toEqual([]);
    // 닫지 않은 끝 표시·안쪽 시작 표시는 흘려 보내는 창의 보통 줄로 남는다(본문으로 보이지 않음)
    expect(spilled.slice(-5)).toEqual([LE(), LB('DSA '), LE('EC '), SPILL_END(1 + b.length + c.length), '뒤']);
  });

  it('한 줄에서 엇갈린 키 — BEGIN A … BEGIN B … END A 뒤에 오는 B의 본문은 창에 담긴다. 한 줄에 다 든 키는 그 자리만 가리고, 열린 키가 없을 때의 끝 표시는 보통 글이다', () => {
    const b = lbody('Ob', 8);
    // 시작 표시 앞 글은 남고, 창은 첫 시작 표시부터
    const out = rawLines([`log: ${LB()} x ${LB('EC ')} y ${LE()} z`, ...b, LE('EC '), '뒤']);
    expect(out).toEqual(['log: ', WIN_MARK(10), '뒤']);
    expect(b.filter((x) => out.join('\n').includes(x))).toEqual([]);
    // 긴 줄에서 엇갈림 — 그 줄은 버리고 열린 키로 창을 연다
    const long = `${'x'.repeat(60 * 1024)}${LB()} ${LB('EC ')} ${LE()}`;
    const fromLong = rawLines(['앞', long, ...b, LE('EC '), '뒤']);
    expect(fromLong).toEqual(['앞', omittedMark(long.length + 1), WIN_MARK(10), '뒤']);
    // 한 줄에 다 든 키 둘(겹쳐도)과 열린 키 없는 끝 표시
    expect(rawLines([`a ${LB()}k1${LB('EC ')}k2${LE('EC ')}k3${LE()} b ${LE('DSA ')} c`])).toEqual([`a ${KEY_MARK} b ${LE('DSA ')} c`]);
    expect(rawLines([LE(), '다음'])).toEqual([LE(), '다음']);
  });

  it('창 안의 긴 줄도 같은 걷기를 한다 — 열린 키 하나만 닫는 끝 표시가 든 긴 줄은 창을 닫지 않는다', () => {
    const a = lbody('Pa', 4);
    const b = lbody('Pb', 6);
    const long = `${'y'.repeat(60 * 1024)}${LE()}`;
    const out = rawLines([LB(), LB('EC '), ...a, long, ...b, LE('EC '), '뒤']);
    expect(out).toEqual([omittedMark(long.length + 1), WIN_MARK(2 + a.length + 1 + b.length + 1), '뒤']);
    expect([...a, ...b].filter((x) => out.join('\n').includes(x))).toEqual([]);
  });

  it(`열린 키는 종류 ${HOST_EXEC_PEM_OPEN_KINDS}개·모두 ${HOST_EXEC_PEM_OPEN_KEYS}개까지 센다 — 넘으면 창은 출력 끝까지 닫히지 않는다(더 가리기만 한다)`, () => {
    expect([HOST_EXEC_PEM_OPEN_KINDS, HOST_EXEC_PEM_OPEN_KEYS]).toEqual([8, 64]);
    const kinds = Array.from({ length: 9 }, (_, i) => `K${i} `);
    const body = lbody('Qs', 3);
    // 종류 8개: 모두 닫히면 창이 닫히고 그 뒤 줄은 창 밖이다
    const eight = rawLines([...kinds.slice(0, 8).map((k) => LB(k)), ...kinds.slice(0, 8).map((k) => LE(k)), '뒤 메모']);
    expect(eight).toEqual([WIN_MARK(16), '뒤 메모']);
    // 종류 9개: 세기를 그만두고 끝 표시로 닫지 않는다 — 그 뒤 본문 줄도 버리고, 출력 끝에 끝 줄 없는 창으로 닫는다
    const nine = rawLines([...kinds.map((k) => LB(k)), ...kinds.map((k) => LE(k)), '뒤 메모', ...body]);
    expect(body.filter((x) => nine.join('\n').includes(x))).toEqual([]);
    expect(nine[0]).toBe(CUT_MARK(1 + body.length));
    expect(nine).toContain('뒤 메모');
    // 열린 키 64개(한 줄)는 세고, 65개는 sticky
    const k64 = rawLines([LB().repeat(64), ...Array.from({ length: 64 }, () => LE()), '뒤']);
    expect(k64).toEqual([WIN_MARK(65), '뒤']);
    const k65 = rawLines([LB().repeat(65), ...Array.from({ length: 65 }, () => LE()), '뒤', ...body]);
    expect(k65[0]).toBe(CUT_MARK(1 + body.length));
    expect(body.filter((x) => k65.join('\n').includes(x))).toEqual([]);
  });

  it('줄 끝 너그러움: util.inspect·JSON 배열·색 입힌 줄의 본문도 흘려 보낼 때와 출력 끝에서 버린다 — 떼는 글자는 모두 합쳐 24자까지', () => {
    const b = KEY_BODY.slice(0, 6);
    const forms: Record<string, (l: string) => string> = {
      'util.inspect': (l) => `  '${l}\\n' +`,
      'JSON 배열': (l) => `    "${l}",`,
      '색(ANSI)': (l) => `\x1b[32m${l}\x1b[0m`,
      '색 + JSON': (l) => `\x1b[2m  "${l}"\x1b[22m,`,
      // 리드 결정 S5-67.2 (프로브 zz-s5f5ti-escape-r) — Windows에서 읽은 CRLF 키를 util.inspect·JSON 배열로 찍으면 줄 끝이 글자 그대로의 \r\n
      'util.inspect (CRLF 키)': (l) => `  '${l}\\r\\n' +`,
      'JSON 배열 (CRLF 키)': (l) => `    "${l}\\r\\n",`,
    };
    for (const [name, f] of Object.entries(forms)) {
      expect(looksLikeKeyBody(f(b[0]!)), name).toBe(true);
      // 출력 끝(끝 줄 없음)
      const cut = rawLines(['앞', KEY[0]!, ...b.map(f)]);
      expect(cut, name).toEqual(['앞', CUT_MARK(1 + b.length)]);
      // 흘려 보내는 중 (400줄을 넘긴 뒤)
      const pad = Array.from({ length: 400 }, (_, i) => `progress ${i}`);
      const sp = rawLines([KEY[0]!, ...pad, ...b.map(f), KEY_END, '끝']);
      expect(b.filter((x) => sp.join('\n').includes(x)), name).toEqual([]);
      expect(sp.slice(-2), name).toEqual([SPILL_END(b.length), '끝']);
    }
    // 상한: 떼는 글자가 24자면 보고, 25자면 보지 않는다. 본문 아닌 줄은 떼어도 아니다. 떼기 전 모습도 본다(끝의 + 가 base64의 일부인 16자 줄)
    expect(looksLikeKeyBody(`${b[0]}${'"'.repeat(24)}`)).toBe(true);
    expect(looksLikeKeyBody(`${b[0]}${'"'.repeat(25)}`)).toBe(false);
    expect(looksLikeKeyBody(`${b[0]}\x1b[38;5;196m${')'.repeat(13)}`)).toBe(true);
    expect(looksLikeKeyBody(`${b[0]}\x1b[38;5;196m${')'.repeat(14)}`)).toBe(false);
    expect(looksLikeKeyBody('  "npm WARN deprecated",')).toBe(false);
    expect(looksLikeKeyBody("  'done\\n' +")).toBe(false);
    expect(looksLikeKeyBody('abcdefghijklmno+')).toBe(true);
    expect(looksLikeKeyBody('"Zg==",')).toBe(true);
  });

  // 리드 결정 S5-67.1 (프로브 zz-s5f5ti-trailing-pad) — 줄 끝의 공백·\r은 줄 끝 너그러움(모두 합쳐 24자)과 따로, 몇 자든 먼저 떼고 본다
  it('줄 끝의 공백·\\r은 몇 자든 떼고 본다 — 콘솔 폭(120칸)까지 공백으로 채운 줄과 cat -A의 `…$` 뒤 \\r: 출력 끝과 흘려 보내는 중에 본문 줄이 남지 않는다', () => {
    const b = KEY_BODY.slice(0, 6);
    const forms: Record<string, (l: string) => string> = {
      '120칸까지 공백 채움': (l) => l.padEnd(120, ' '),
      'cat -A 뒤 \\r': (l) => `${l}$\r`,
    };
    for (const [name, f] of Object.entries(forms)) {
      expect(looksLikeKeyBody(f(b[0]!)), name).toBe(true);
      // 출력 끝(끝 줄 없음)
      const cut = rawLines(['앞', f(KEY[0]!), ...b.map(f)]);
      expect(b.filter((x) => cut.join('\n').includes(x)), name).toEqual([]);
      expect(cut.slice(0, 2), name).toEqual(['앞', CUT_MARK(1 + b.length)]);
      // 흘려 보내는 중 (400줄을 넘긴 뒤)
      const pad = Array.from({ length: 400 }, (_, i) => `progress ${i}`);
      const sp = rawLines([f(KEY[0]!), ...pad, ...b.map(f), f(KEY_END), '끝']);
      expect(b.filter((x) => sp.join('\n').includes(x)), name).toEqual([]);
      expect(sp, name).toContain(SPILL_END(b.length));
    }
  });

  // 리드 결정 S5-67.3 (프로브 zz-s5f5ti-inline-then-open) — 창은 아직 열린 구간의 첫 시작 표시부터 연다(S5-55.2): 그 앞의 한 줄에 다 든 키는 그 자리만 가린다
  it('한 줄에 다 든 키 뒤에 열린 시작 표시가 있는 줄 — 출력이 창 안에서 끝나도, 흘려 보내도, 끝 표시로 닫혀도 두 키의 본문 조각이 없다 (가리개 없이·백엔드 가리개로)', () => {
    const a = `MIIEpQIBAAKCAQEA${'Tz8Kq3Vw'.repeat(6)}`.slice(0, 64);
    const ec = Array.from({ length: 5 }, (_, i) => `MHcCAQEE${String(i).padStart(2, '0')}${'Nb6Yd2Xs'.repeat(8)}`.slice(0, 64));
    const line = `{"a":"${LB()}\\n${a}\\n${LE()}\\n"} ${LB('EC ')}`;
    const pad = Array.from({ length: 400 }, (_, i) => `progress ${i}`);
    const before = `{"a":"${KEY_MARK}\\n"} `;
    const backend = createRedactor();
    for (const [name, redact] of [
      ['가리개 없이', (s: string) => s],
      ['백엔드 가리개', (s: string) => backend.text(s)],
    ] as const) {
      const run = (lines: string[]): string[] => {
        const o = new HostExecOutput(redact);
        for (const l of lines) o.push(l);
        return o.text().split('\n');
      };
      const outEnd = run(['앞', line, ...ec]);
      const spill = run(['앞', line, ...pad, ...ec, LE('EC '), '끝']);
      const closed = run(['앞', line, ...ec, LE('EC '), '끝']);
      const pieces = (o: string[]): string[] => leakedPieces(o.join('\n'), [a, ...ec]);
      expect({ outEnd: pieces(outEnd), spill: pieces(spill), closed: pieces(closed) }, name).toEqual({ outEnd: [], spill: [], closed: [] });
      expect(outEnd, name).toEqual(['앞', before, CUT_MARK(1 + ec.length)]);
      expect(closed, name).toEqual(['앞', before, WIN_MARK(ec.length + 2), '끝']);
      expect([spill[2], spill.at(-2), spill.at(-1)], name).toEqual([SPILL_MARK, SPILL_END(ec.length), '끝']);
    }
  });
});

/** 한 줄로 이어 쓴 키 본문 8줄 (프로브 zz-xs5f5-inlinebegin의 모양 — 만든 값) */
const IB = Array.from({ length: 8 }, (_, i) => `MIIEpgIB${String(i).padStart(2, '0')}${'Vb7Nm3Kx'.repeat(8)}`.slice(0, 64));
const ibLogs = (n: number): string[] => Array.from({ length: n }, (_, i) => `[test] case ${i} ok`);
/** 잘린 줄 뒤에 출력이 가는 길 넷 (프로브 zz-xs5f5-inlinebegin) — 출력 끝(창 안에서 끝남), 담는 중의 끝 표시, 흘려 보냄(420줄)에 끝 표시 없음·뒤에 끝 표시 */
const IB_POSITIONS: Record<string, (line: string, end: string) => string[]> = {
  '출력 끝': (line) => ['start', line, 'done'],
  '담는 중 끝 표시': (line, end) => ['start', line, ...ibLogs(60), end, 'after'],
  '흘려 보냄, 끝 표시 없음': (line) => ['start', line, ...ibLogs(420)],
  '흘려 보냄, 뒤에 끝 표시': (line, end) => ['start', line, ...ibLogs(420), end, 'after'],
};
/** 잘린 키 꼴 넷 × 길 넷 = 16가지 */
const IB_LAYOUTS = Object.entries(INLINE_CUT_SHAPES).flatMap(([s, shape]) =>
  Object.entries(IB_POSITIONS).map(([p, make]) => ({ name: `${s} · ${p}`, lines: make(inlineCutLine(shape, IB), inlineCutEnd(shape)) })),
);

describe('창을 연 줄의 시작 표시 뒤 글은 시작 표시와 함께 남긴다 — 그 줄에서 끝 표시 전에 잘린 키 (리드 결정 S5-61)', () => {
  it('잘린 키 꼴 넷 × 출력 끝·담는 중 끝 표시·흘려 보냄(끝 표시 없음·있음): 백엔드 가리개로 모은 글에 본문 조각이 없다 — 날 출력을 가리개로만 가려도 0 (프로브 zz-xs5f5-inlinebegin)', () => {
    const red = createRedactor();
    const shown: Record<string, { output: number; plain: number }> = {};
    for (const { name, lines } of IB_LAYOUTS) {
      shown[name] = { output: leakedPieces(collect(lines, red).join('\n'), IB).length, plain: leakedPieces(red.text(lines.join('\n')), IB).length };
    }
    expect(shown).toEqual(Object.fromEntries(IB_LAYOUTS.map(({ name }) => [name, { output: 0, plain: 0 }])));
  });

  // 리드 결정 S5-71이 이 시험의 기대를 바꿨다 — 남기는 시작 줄은 시작 표시와 함께지만 그 뒤의 base64 이어짐('\n' 뒤의 n과 본문 64자)은 남기기 전에 가린다.
  // 예전 기대(시작 표시 뒤 본문을 날것으로 남기고 마지막 가리기에 맡김)는 진짜 줄바꿈·두 번 이스케이프한 꼴에서 본문을 남겼다.
  // 리드 결정 S5-78이 백엔드 가리개 쪽 기대를 다시 바꿨다 — 남길 때 가리개가 먼저 돌아 시작 표시와 그 뒤 PEM 꼬리(이스케이프한 줄바꿈으로 이은 본문)를
  // '[가림:개인 키]' 하나로 바꾸므로, 그 뒤에 '\'로 이은 조각 표시가 남지 않는다(가리개 없이 모은 글은 그대로 조각 표시다)
  it("남기는 시작 줄은 시작 표시와 함께다 — 가리개 없이는 시작 표시 뒤 본문이 '[가림:개인 키 조각]'으로 가려 남고, 백엔드 가리개로는 남길 때 시작 표시와 이어 쓴 본문이 '[가림:개인 키]' 하나가 된다(출력 끝·흘려 보냄) (리드 결정 S5-61·S5-71·S5-78)", () => {
    const red = createRedactor();
    // 한 줄로 이은 본문 8줄 — 저마다 '\n'의 n과 함께 한 이어짐이라 표시 여덟이 '\'로 이어진다
    const masked = `\\${PIECE}`.repeat(IB.length);
    for (const [s, shape] of Object.entries(INLINE_CUT_SHAPES)) {
      const line = inlineCutLine(shape, IB);
      const end = IB_POSITIONS['출력 끝']!(line, '');
      // 시작 표시 앞 글은 보통 줄로 남고, 창 안의 'done'은 본문으로 보이지 않아 남는다 — 표시의 n은 시작 줄 하나
      expect(rawLines(end), s).toEqual(['start', shape.pre, CUT_MARK(1), `${shape.begin}${masked}${shape.post}`, 'done']);
      expect(collect(end), s).toEqual(['start', red.text(shape.pre), CUT_MARK(1), `${KEY_MARK}${shape.post}`, 'done']);
      // 흘려 보냄 — 시작 줄은 흘려 보내기 표시 바로 뒤, 끝 표시가 닫으면 본문으로 보여 버린 줄은 없다
      const spill = collect(IB_POSITIONS['흘려 보냄, 뒤에 끝 표시']!(line, inlineCutEnd(shape)));
      expect(spill.slice(0, 4), s).toEqual(['start', red.text(shape.pre), SPILL_MARK, `${KEY_MARK}${shape.post}`]);
      expect(spill.slice(-2), s).toEqual([SPILL_END(0), 'after']);
    }
  });

  it('대조: 담는 중의 끝 표시는 창 전체를 한 줄로, 한 줄에 다 든 키는 그 자리만, 줄 끝까지 본문인 시작 줄은 남기지 않는다 (가리개 없이)', () => {
    const json = INLINE_CUT_SHAPES['JSON 로그 — 로거가 값을 자름']!;
    const line = inlineCutLine(json, IB);
    expect(rawLines(IB_POSITIONS['담는 중 끝 표시']!(line, inlineCutEnd(json)))).toEqual(['start', json.pre, WIN_MARK(62), 'after']);
    const whole = `{"key":"${json.begin}\\n${IB.join('\\n')}\\n${inlineCutEnd(json)}\\n","user":"bob"}`;
    expect(rawLines(['start', whole, 'done'])).toEqual(['start', `{"key":"${KEY_MARK}\\n","user":"bob"}`, 'done']);
    expect(rawLines(['start', `key=${json.begin}\\n${IB.join('\\n')}`, 'done'])).toEqual(['start', 'key=', CUT_MARK(1), 'done']);
  });

  it('host_exec 끝까지: 잘린 키 16가지 — 결과·실행 기록 끝·중복 캐시에 본문 조각이 없다 (프로브 zz-xs5f5-inlinebegin)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const shown: Record<string, { output: number; tail: number; cache: number }> = {};
    let n = 0;
    for (const { name, lines } of IB_LAYOUTS) {
      const requestId = `rq-inline-${++n}`;
      const { d, rec } = await runLines(e, turnId, lines, requestId);
      const cache = JSON.stringify(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', requestId)) ?? null);
      expect(cache, name).toContain(requestId); // 중복 캐시를 실제로 봤다
      shown[name] = { output: leakedPieces(d.output, IB).length, tail: leakedPieces(String(rec.result.outputTail), IB).length, cache: leakedPieces(cache, IB).length };
    }
    expect(shown).toEqual(Object.fromEntries(IB_LAYOUTS.map(({ name }) => [name, { output: 0, tail: 0, cache: 0 }])));
  });
});

/** 진짜 줄바꿈으로 찍은 키 본문 — 첫 키 8줄, 둘째 키 8줄 (프로브 zz-xs5f6es-realcut의 모양 — 만든 값) */
const RC = Array.from({ length: 8 }, (_, i) => `MIIEvQIB${String(i).padStart(2, '0')}${'Hq3Wz8Pd'.repeat(8)}`.slice(0, 64));
const RC2 = Array.from({ length: 8 }, (_, i) => `MHcCAQEE${String(i).padStart(2, '0')}${'Lr6Tg1Ys'.repeat(8)}`.slice(0, 64));
const RC_ALL = [...RC, ...RC2];
const rcLogs = (n: number): string[] => Array.from({ length: n }, (_, i) => `[test] case ${i} ok`);
/** 잘린 줄 뒤에 출력이 가는 길 넷 (프로브 zz-xs5f6es-realcut) — 출력 끝(창 안에서 끝남), 흘려 보냄(420줄), 흘려 보낸 뒤 끝 표시, 담는 중 끝 표시 */
const RC_POSITIONS: Record<string, (cut: string[]) => string[]> = {
  '출력 끝': (cut) => ['start', ...cut, 'done'],
  '흘려 보냄': (cut) => ['start', ...cut, ...rcLogs(420)],
  '흘려 보낸 뒤 끝 표시': (cut) => ['start', ...cut, ...rcLogs(420), ...realCutEnds(cut), 'after'],
  '담는 중 끝 표시': (cut) => ['start', ...cut, ...rcLogs(20), ...realCutEnds(cut), 'after'],
};
/** 잘린 꼴 여덟 × 길 넷 = 32가지 */
const RC_LAYOUTS = Object.entries(REAL_CUT_SHAPES).flatMap(([s, make]) =>
  Object.entries(RC_POSITIONS).map(([p, place]) => ({ name: `${s} · ${p}`, lines: place(make(RC, RC2)) })),
);
/** base64 20자와 16자·15자 (만든 값) */
const R20 = 'QmFzZTY0UnVuMjBjaGFy';
const R16 = R20.slice(0, 16);
const R15 = R20.slice(0, 15);

describe('창 안에서 남기는 글은 base64 이어짐을 가린다 — 본문으로 보이는지의 짐작에 기대지 않는다 (리드 결정 S5-71)', () => {
  it("남기는 곳마다 가린다 — 흘려 보내며 남기는 줄, 출력 끝에서 남기는 줄과 시작 줄, 흘려 보낼 때의 시작 줄, 안쪽 시작 표시·닫지 않는 끝 표시가 든 줄: base64 16자 넘는 이어짐은 '[가림:개인 키 조각]'", () => {
    // 흘려 보내며 남기는 줄 (judge)
    const spilled = rawLines([KEY[0]!, ...rcLogs(400), `hash ${R20} ok`, KEY_END, '끝']);
    expect(spilled.slice(0, 2)).toEqual([SPILL_MARK, '[test] case 0 ok']);
    expect(spilled.slice(-4)).toEqual(['[test] case 399 ok', `hash ${PIECE} ok`, SPILL_END(0), '끝']);
    // 출력 끝에서 남기는 줄과 시작 줄 (closeAtOutputEnd)
    expect(rawLines(['앞', `key=${KEY[0]} id ${R20} note`, `hash ${R20} ok`, 'done'])).toEqual(['앞', 'key=', CUT_MARK(1), `${KEY[0]} id ${PIECE} note`, `hash ${PIECE} ok`, 'done']);
    // 흘려 보낼 때의 시작 줄 (spill)
    const opening = rawLines([`${KEY[0]} id ${R20} note`, ...rcLogs(400), 'z']);
    expect(opening.slice(0, 3)).toEqual([SPILL_MARK, `${KEY[0]} id ${PIECE} note`, '[test] case 0 ok']);
    expect(opening.slice(-2)).toEqual(['z', SPILL_CUT(0)]);
    // 안쪽 시작 표시·닫지 않는 끝 표시가 든 줄 — 담는 중 출력 끝, 흘려 보내는 중
    const inner = [`x ${R20} ${LB('EC ')}`, `${LE('DSA ')} ${R20} y`];
    expect(rawLines([KEY[0]!, ...inner, 'done'])).toEqual([CUT_MARK(1), `x ${PIECE} ${LB('EC ')}`, `${LE('DSA ')} ${PIECE} y`, 'done']);
    expect(rawLines([KEY[0]!, ...rcLogs(400), ...inner, LE('EC '), KEY_END, '끝']).slice(-6)).toEqual([
      '[test] case 399 ok',
      `x ${PIECE} ${LB('EC ')}`,
      `${LE('DSA ')} ${PIECE} y`,
      LE('EC '),
      SPILL_END(0),
      '끝',
    ]);
  });

  it("16자부터 가린다(15자는 그대로) — '=' '+' '/'도 base64 글자로 센다. 창 밖의 글과, 시작 표시 앞·창을 닫은 끝 표시 뒤의 같은 줄 글은 그대로다", () => {
    const pad = `${R20.slice(0, 10)}==xxxx`; // '='를 넣어 16자
    const slashy = 'Ab+/'.repeat(4); // '+' '/'를 넣어 16자
    expect([pad.length, slashy.length]).toEqual([16, 16]);
    expect(rawLines([KEY[0]!, `a ${R15} b`, `a ${R16} b`, `a ${pad} b`, `a ${slashy} b`, 'done'])).toEqual([CUT_MARK(1), `a ${R15} b`, `a ${PIECE} b`, `a ${PIECE} b`, `a ${PIECE} b`, 'done']);
    // 창 밖 — 앞 글, 끝 표시 뒤 글, 그 뒤 줄은 그대로 (담는 중에 닫힘·흘려 보내다 닫힘 모두)
    expect(rawLines([`${R20} 앞 ${KEY[0]}`, ...KEY_BODY, `${KEY_END} 뒤 ${R20}`, `${R20} 밖`])).toEqual([`${R20} 앞 `, WIN_MARK(27), ` 뒤 ${R20}`, `${R20} 밖`]);
    const spillClosed = rawLines([`${R20} 앞 ${KEY[0]}`, ...rcLogs(400), `${KEY_END} 뒤 ${R20}`, `${R20} 밖`]);
    expect(spillClosed.slice(0, 2)).toEqual([`${R20} 앞 `, SPILL_MARK]);
    expect(spillClosed.slice(-3)).toEqual([SPILL_END(0), ` 뒤 ${R20}`, `${R20} 밖`]);
    // 창이 없으면 아무것도 바꾸지 않는다
    expect(rawLines([`hash ${R20} ok`, `${R20}`])).toEqual([`hash ${R20} ok`, R20]);
    // 표시는 base64 글자가 없어 앞뒤 글과 이어도 새 이어짐을 만들지 않는다
    expect(longRun(`${R15}${PIECE}${R15}`)).toBeNull();
  });

  it('떠돌이 시작 표시 뒤의 보통 글은 읽히는 그대로 남는다 — 긴 해시만 가린다(출력 끝까지 흘려 보내는 중에도)', () => {
    const prose = [
      '설치 안내: 키 파일 첫 줄은 위처럼 시작합니다',
      'Run `npm install` and then `npm run build` to finish.',
      'v1.2.3 released on 2026-11-04 (commit 3f2a9bc)',
      'See https://example.com/docs/keys for the details.',
      '경고: 설정 파일을 읽지 못함 — 기본값 사용',
    ];
    // sha256sum 꼴 — 줄 끝이 파일 이름이라 본문으로 보이지 않아 남되 해시는 가린다
    const hash = `${'ab12'.repeat(16)}  keys/id.pem`;
    const lines = ['예시 출력:', `  예: ${KEY[0]} 로 시작하는 파일`, ...prose, hash, '끝'];
    // 담는 중 출력 끝 — 표시의 n은 시작 줄 하나(남겨도 센다)
    expect(rawLines(lines)).toEqual(['예시 출력:', '  예: ', CUT_MARK(1), `${KEY[0]} 로 시작하는 파일`, ...prose, `${PIECE}  keys/id.pem`, '끝']);
    // 흘려 보내며 출력 끝까지 — 보통 글은 그대로, 해시만 가린다
    const long = rawLines(['예시 출력:', `  예: ${KEY[0]} 로 시작하는 파일`, ...Array.from({ length: 90 }, () => prose).flat(), hash, '끝']);
    expect(long.filter((l) => !prose.includes(l))).toEqual(['예시 출력:', '  예: ', SPILL_MARK, `${KEY[0]} 로 시작하는 파일`, `${PIECE}  keys/id.pem`, '끝', SPILL_CUT(0)]);
    expect(long.filter((l) => prose.includes(l))).toHaveLength(450);
  });

  it('진짜 줄바꿈으로 찍은 키가 끝 표시 전에 잘린 꼴 여덟 × 출력 끝·흘려 보냄·흘려 보낸 뒤 끝 표시·담는 중 끝 표시: 가리개 없이도 백엔드 가리개로도 본문 조각과 base64 16자 넘는 이어짐이 없다 (프로브 zz-xs5f6es-realcut)', () => {
    const red = createRedactor();
    const shown: Record<string, { bare: number; run: string | null; backend: number; worse: number }> = {};
    for (const { name, lines } of RC_LAYOUTS) {
      const bare = rawLines(lines).join('\n');
      const backend = collect(lines, red).join('\n');
      const plain = red.text(lines.join('\n'));
      const leaked = leakedPieces(backend, RC_ALL);
      shown[name] = { bare: leakedPieces(bare, RC_ALL).length, run: longRun(bare), backend: leaked.length, worse: leaked.filter((p) => !plain.includes(p)).length };
    }
    expect(shown).toEqual(Object.fromEntries(RC_LAYOUTS.map(({ name }) => [name, { bare: 0, run: null, backend: 0, worse: 0 }])));
    // 잘린 줄은 보통 줄로 남되 그 본문은 가려진다 — 온전한 본문 줄은 버려 센다
    const preview = REAL_CUT_SHAPES["미리 보기 content[:N] + '...'"]!(RC, RC2);
    expect(rawLines(RC_POSITIONS['출력 끝']!(preview))).toEqual(['start', CUT_MARK(7), `${PIECE}...`, 'done']);
    const compose = REAL_CUT_SHAPES['줄마다 compose 앞말']!(RC, RC2);
    expect(rawLines(RC_POSITIONS['출력 끝']!(compose))).toEqual(['start', 'svc-a  | key=', CUT_MARK(5), `svc-a  | ${PIECE}... user=bob`, 'done']);
  });

  it('흘려 보내다 끝 표시로 닫히는 창의 꼴 셋 — grep --color의 PGP 블록, sed -n l, 두 번 이스케이프한 JSON 값: 가리개로만 가린 것보다 덜 가리지 않는다 (프로브 zz-xs5f6es-spilldiff)', () => {
    const red = createRedactor();
    const rand = seeded(0x5f6e5d1);
    const b64 = (n: number): string => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[Math.floor(rand() * 64)]).join('');
    const pgp = Array.from({ length: 430 }, () => b64(64));
    const grep = (l: string): string => `\x1b[01;31m\x1b[K${l}\x1b[m\x1b[K`;
    const wide = Array.from({ length: 420 }, () => b64(76));
    const inner = Array.from({ length: 8 }, () => b64(64));
    const shapes: Record<string, { lines: string[]; bodies: string[] }> = {
      "(a) grep --color=always -E '.*' secret.asc": {
        lines: ['$ grep', grep('-----BEGIN PGP PRIVATE KEY BLOCK-----'), grep(''), ...pgp.map(grep), grep('=Ab3x'), grep('-----END PGP PRIVATE KEY BLOCK-----'), 'done'],
        bodies: pgp,
      },
      '(b) 76칸 키 파일의 sed -n l': {
        lines: ['-----BEGIN PRIVATE KEY-----$', ...wide.flatMap((l) => [`${l.slice(0, 69)}\\`, `${l.slice(69)}$`]), '-----END PRIVATE KEY-----$', 'done'],
        bodies: wide,
      },
      '(c) 끝 표시 전에 잘린 두 번 이스케이프한 JSON 값, 420줄 뒤 끝 표시': {
        lines: ['start', `{"log":"{\\"key\\":\\"-----BEGIN RSA PRIVATE KEY-----\\\\n${inner.join('\\\\n')}... [truncated]`, ...rcLogs(420), '-----END RSA PRIVATE KEY-----', 'after'],
        bodies: inner,
      },
    };
    const rows: Record<string, { bare: number; run: string | null; backend: number; redactorAlone: number; spill: boolean }> = {};
    for (const [name, { lines, bodies }] of Object.entries(shapes)) {
      const bare = rawLines(lines).join('\n');
      const backend = collect(lines, red).join('\n');
      rows[name] = { bare: leakedPieces(bare, bodies).length, run: longRun(bare), backend: leakedPieces(backend, bodies).length, redactorAlone: leakedPieces(red.text(lines.join('\n')), bodies).length, spill: bare.includes(SPILL_MARK) };
    }
    expect(rows).toEqual(Object.fromEntries(Object.keys(shapes).map((k) => [k, { bare: 0, run: null, backend: 0, redactorAlone: 0, spill: true }])));
  });

  it('host_exec 끝까지: 진짜 줄바꿈으로 잘린 꼴 — 스스로 끝남(여덟 꼴)·시간 초과·긴급 정지에서 결과·실행 기록 끝·중복 캐시에 본문 조각이 없다 (프로브 zz-xs5f6es-realcut)', async () => {
    const pieces = (s: string): number => leakedPieces(s, RC_ALL).length;
    const shown: Record<string, { output: number; tail: number; cache: number; run: string | null }> = {};
    const record = (e: OrchEnv, turnId: string, name: string, d: { output: string }, requestId: string): void => {
      const rec = hostRecords(e).find((x) => x.result.toolRequestId === requestId)!;
      const cache = JSON.stringify(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', requestId)) ?? null);
      expect(cache, name).toContain(requestId); // 중복 캐시를 실제로 봤다
      shown[name] = { output: pieces(d.output), tail: pieces(String(rec.result.outputTail)), cache: pieces(cache), run: longRun(d.output) };
    };
    // 스스로 끝남 — 여덟 꼴, 그리고 시간 초과 둘 (같은 메인 턴)
    let e = (env = await bootOrch({ workspace: true }));
    let { turnId } = await liveMainTurn(e);
    let n = 0;
    for (const [s, make] of Object.entries(REAL_CUT_SHAPES)) {
      const requestId = `rq-realcut-${++n}`;
      const { d } = await runLines(e, turnId, RC_POSITIONS['출력 끝']!(make(RC, RC2)), requestId);
      record(e, turnId, `${s} · 스스로 끝남`, d, requestId);
    }
    for (const s of ["로거 '%.400s' 뒤 다른 필드", '줄마다 compose 앞말']) {
      const requestId = `rq-realcut-timeout-${++n}`;
      scriptedHost(e, { lines: ['start', ...REAL_CUT_SHAPES[s]!(RC, RC2), ...rcLogs(3)], exitAfterMs: null });
      const d = okData(await hostExec(e, turnId, { command: 'python show.py', request_id: requestId, timeout_s: 1 }));
      expect(d.timed_out, s).toBe(true);
      record(e, turnId, `${s} · 시간 초과`, d, requestId);
    }
    await e.close();
    env = null;
    // 긴급 정지 — 꼴마다 새 오케스트레이터
    for (const s of ["로거 '...(truncated)' 뒤 글", '한 출력에 잘린 키 둘']) {
      e = env = await bootOrch({ workspace: true });
      ({ turnId } = await liveMainTurn(e));
      const requestId = `rq-realcut-stop-${++n}`;
      scriptedHost(e, { lines: ['start', ...REAL_CUT_SHAPES[s]!(RC, RC2), ...rcLogs(3)], exitAfterMs: null });
      const pending = hostExec(e, turnId, { command: 'python show.py', request_id: requestId });
      await waitFor(() => e.hostProcs.length > 0, '서버 명령 시작');
      await sleep(300);
      await e.invoke('stop.emergency');
      const d = okData(await pending);
      expect(d.stopped, s).toBe('긴급 정지');
      record(e, turnId, `${s} · 긴급 정지`, d, requestId);
      await e.invoke('stop.release').catch(() => undefined);
      await e.close();
      env = null;
    }
    expect(Object.keys(shown)).toHaveLength(12);
    expect(shown).toEqual(Object.fromEntries(Object.keys(shown).map((k) => [k, { output: 0, tail: 0, cache: 0, run: null }])));
  }, 120_000);
});

/** 창 안에서 남는 줄에 든 비밀 값 (프로브 zz-xs5f7es-ctxloss — 만든 가짜 값). 16자 넘는 이름과 '//' + URL 사용자는 base64 이어짐이다 */
const CTX_PW = 'Ch@ngeIt!2026';
const CTX_PW2 = 'hunter2!x';
const CTX_PW3 = 's3cr3t!pw';
const CTX_FLAG = 'qX9#63!';
const CTX_BODY = Array.from({ length: 6 }, (_, i) => `MIIEcx${String(i).padStart(2, '0')}${'Pq4Rs7Tv'.repeat(8)}`.slice(0, 64));
const SECRET_MARK = '[가림:비밀 값]';
/**
 * 창 안의 줄에 비밀 값이 든 꼴 (리드 결정 S5-78, 프로브 zz-xs5f7es-ctxloss) — 줄, 숨길 값, 백엔드 가리개로 모은 글에 남는 그 줄(가리개가 값을 먼저 가리고 조각
 * 가리기가 이름을 바꾼 모습). 떠돌이 시작 표시는 키 파일의 첫 줄만 찍은 출력(head -1)이다
 */
const CTX_SHAPES: Record<string, { lines: string[]; secret: string; kept: string[] }> = {
  "S5-61의 꼴 — 로거가 키 필드를 자르고 이어 쓴 JSON 기록의 keyStorePassword (출력 끝)": {
    lines: ['start', `{"level":"info","msg":"tls config","tls":{"privateKey":"${LB()}\\n${CTX_BODY.join('\\n')}...(truncated)","keyStorePassword":"${CTX_PW}"}}`, 'done'],
    secret: CTX_PW,
    kept: [`${KEY_MARK}...(truncated)","${PIECE}":"${SECRET_MARK}"}}`],
  },
  '떠돌이 시작 표시 뒤 application.properties (keyStorePassword=)': {
    lines: [LB(), 'server.port=8443', `server.ssl.keyStorePassword=${CTX_PW}`, 'server.ssl.keyAlias=tomcat'],
    secret: CTX_PW,
    // '='도 base64 글자라 이름과 함께 조각 표시가 된다 — 값은 그 전에 가렸다
    kept: [`server.ssl.${PIECE}${SECRET_MARK}`],
  },
  '떠돌이 시작 표시 뒤 application.yml (trustStorePassword:)': {
    lines: [LB(), 'server:', '  ssl:', `    trustStorePassword: ${CTX_PW}`],
    secret: CTX_PW,
    kept: [`    ${PIECE}: ${SECRET_MARK}`],
  },
  '떠돌이 시작 표시 뒤 JSON 설정 ("databasePassword":)': {
    lines: [LB(), '{', '  "databaseHost": "db",', `  "databasePassword": "${CTX_PW2}"`, '}'],
    secret: CTX_PW2,
    kept: [`  "${PIECE}": "${SECRET_MARK}"`],
  },
  '떠돌이 시작 표시 뒤 연결 URL (긴 사용자 이름)': {
    lines: [LB(), `DATABASE_URL=postgres://applicationuser1234:${CTX_PW3}@db:5432/app`],
    secret: CTX_PW3,
    kept: [`DATABASE_URL=postgres:${PIECE}:[가림:URL 비밀번호]@db:5432/app`],
  },
  '떠돌이 시작 표시 뒤 XML (keystorePassword)': {
    lines: [LB(), `<keystorePassword>${CTX_PW}</keystorePassword>`],
    secret: CTX_PW,
    // 닫는 태그의 '/'도 base64 글자다
    kept: [`<${PIECE}>${SECRET_MARK}<${PIECE}>`],
  },
  '떠돌이 시작 표시 뒤 명령 옵션 (--privateKeyPassphrase)': {
    lines: [LB(), `running: tool --privateKeyPassphrase "${CTX_FLAG}" --verbose`],
    secret: CTX_FLAG,
    kept: [`running: tool --${PIECE} "${SECRET_MARK}" --verbose`],
  },
  '떠돌이 시작 표시 뒤 이름과 값이 두 줄로 갈린 JSON': {
    lines: [LB(), '{', '  "databasePassword":', `      "${CTX_PW2}"`, '}'],
    secret: CTX_PW2,
    // 값 줄에는 남길 때 가릴 것이 없고, 마지막 가리기는 조각 표시가 든 이름을 비밀 키로 본다 (shouldMaskQuoted)
    kept: [`  "${PIECE}":`, `      "${SECRET_MARK}"`],
  },
  '흘려 보냄 — compose logs의 430줄 PGP 키 사이에 다른 서비스의 설정 줄, 그 뒤 끝 표시': {
    lines: [
      'app-1  | -----BEGIN PGP PRIVATE KEY BLOCK-----',
      ...Array.from({ length: 430 }, (_, i) => (i === 200 ? `db-1   | {"databasePassword":"${CTX_PW2}","port":5432}` : `app-1  | ${CTX_BODY[i % 6]}`)),
      'app-1  | -----END PGP PRIVATE KEY BLOCK-----',
      'done',
    ],
    secret: CTX_PW2,
    kept: [`db-1   | {"${PIECE}":"${SECRET_MARK}","port":5432}`],
  },
};
/** 등록 값과 wos_ 세션 토큰 — 조각 가리기가 일부만 덮으면 등록 값·형식 규칙에 맞지 않아 남은 조각이 보였다 (프로브 zz-xs5f7es-ctxloss 2) */
const CTX_REG = 'Pr0d-AbCdEfGhIjKlMnOpQrStUv-db!pass';
const CTX_WOS = 'wos_Ab3dEf9h-JkLmNoPqRsTuVwXyZ012_3456789abcdef';

describe('창 안에서 남기는 글은 가리개로 먼저 가린 뒤 조각을 가린다 (리드 결정 S5-78)', () => {
  it('이름(16자 넘게)·URL 사용자에 기대는 비밀 값 꼴 아홉: 백엔드 가리개로 모은 글에 값이 없다 — 가리개만으로도 없고, 가리개 없이 모으면 조각 가리기가 이름만 바꾼 채 값이 남는다(가리개가 먼저여야 하는 까닭) (프로브 zz-xs5f7es-ctxloss)', () => {
    const red = createRedactor();
    const rows: Record<string, { backend: boolean; kept: boolean; alone: boolean; bareShowsValue: boolean }> = {};
    for (const [name, { lines, secret, kept }] of Object.entries(CTX_SHAPES)) {
      const backend = collect(lines, red);
      const bare = rawLines(lines).join('\n');
      // 값의 8자 조각까지 본다 — properties 꼴은 조각 가리기가 '=' 뒤 두 글자까지 삼켜 '@ngeIt!2026'만 남았다
      rows[name] = {
        backend: shownPieces(backend.join('\n'), secret, 8),
        kept: kept.every((l) => backend.includes(l)),
        alone: shownPieces(red.text(lines.join('\n')), secret, 8),
        // 가리개 없이 모은 글 — 창 안에서 남은 줄이고 조각 가리기가 이름(또는 '//' + 사용자)을 바꿨다
        bareShowsValue: shownPieces(bare, secret, 8) && bare.includes(PIECE),
      };
    }
    expect(rows).toEqual(Object.fromEntries(Object.keys(CTX_SHAPES).map((k) => [k, { backend: false, kept: true, alone: false, bareShowsValue: true }])));
  });

  it('등록 값과 wos_ 세션 토큰도 창 안에서 통째로 가린다 — 조각 가리기가 일부만 덮어 남던 조각(-db!pass·Ab3dEf9h·3456789abcd)이 없다 (프로브 zz-xs5f7es-ctxloss 2)', () => {
    const red = createRedactor();
    red.addSecret(CTX_REG, 'db');
    expect(CTX_WOS).toHaveLength(47);
    const lines = [LB(), `DB_PASSWORD=${CTX_REG}`, `session ${CTX_WOS} restored`];
    const frag = (t: string): boolean[] => ['-db!pass', 'Ab3dEf9h', '3456789abcd'].map((f) => t.includes(f));
    const out = collect(lines, red);
    expect(out).toEqual([CUT_MARK(1), 'DB_PASSWORD=[가림:db]', 'session [가림:욱채 세션 토큰] restored']);
    expect(frag(out.join('\n'))).toEqual([false, false, false]);
    expect(frag(red.text(lines.join('\n')))).toEqual([false, false, false]);
    // 흘려 보내는 중에도
    const spill = collect([LB(), ...rcLogs(400), ...lines.slice(1), LE(), '끝'], red);
    expect(spill.slice(-4)).toEqual(['DB_PASSWORD=[가림:db]', 'session [가림:욱채 세션 토큰] restored', SPILL_END(0), '끝']);
  });

  it('남길 때의 가리기는 창 안에서 남기는 글 가운데 base64 16자 넘는 이어짐이 든 것만 한 번씩 — 창 밖의 줄과 이어짐이 없는 창 안의 줄은 마지막 가리기만 받는다 (리드 결정 S5-36·S5-78)', () => {
    const r = createRedactor();
    const seen: string[] = [];
    const out = new HostExecOutput((t) => {
      seen.push(t);
      return r.text(t);
    });
    const named = `  "databasePassword": "${CTX_PW2}"`;
    for (const l of ['밖의 줄 password=hunter2x', LB(), '창 안의 짧은 줄', named, 'x '.repeat(10)]) out.push(l);
    // 담는 중 — 아직 남기지 않았다
    expect(seen).toEqual([]);
    const text = out.text();
    // 출력 끝에서 창을 닫으며 남기는 줄 가운데 이어짐이 든 줄 하나만, 그다음 마지막 가리기 한 번
    expect(seen.slice(0, -1)).toEqual([named]);
    expect(seen).toHaveLength(2);
    expect(text.split('\n')).toEqual(['밖의 줄 password=[가림:비밀 값]', CUT_MARK(1), '창 안의 짧은 줄', `  "${PIECE}": "${SECRET_MARK}"`, 'x '.repeat(10)]);
    // 흘려 보내는 중 — 남기는 그때 가린다
    seen.length = 0;
    const spill = new HostExecOutput((t) => {
      seen.push(t);
      return r.text(t);
    });
    for (const l of [LB(), ...rcLogs(400)]) spill.push(l);
    expect(seen).toEqual([]);
    spill.push(named);
    expect(seen).toEqual([named]);
  });

  it('남긴 뒤 가리개가 알게 된 값: 담는 중이던 창의 줄은 출력 끝에서 남길 때 가리고, 흘려 보내며 이미 남긴 줄은 마지막 가리기가 가린다 (리드 결정 S5-78 1)', () => {
    const late = 'late-Value-AbCdEfGhIjKlMnOp!9';
    const late2 = 'late-pass-9!q';
    // 담는 중 — 출력 끝에서 창을 닫을 때 남기므로 16자 넘는 이어짐이 든 값도 통째로 가린다
    const r = createRedactor();
    const out = new HostExecOutput((t) => r.text(t));
    for (const l of [LB(), `printed ${late} x`]) out.push(l);
    r.addSecret(late, 'api-key');
    expect(out.text().split('\n')).toEqual([CUT_MARK(1), 'printed [가림:api-key] x']);
    // 흘려 보내는 중 이미 남긴 줄 — 마지막 가리기가 가린다
    const r2 = createRedactor();
    const spill = new HostExecOutput((t) => r2.text(t));
    for (const l of [LB(), ...rcLogs(400), `printed ${late2} x`]) spill.push(l);
    r2.addSecret(late2, 'api-key');
    expect(spill.text().split('\n').slice(-2)).toEqual(['printed [가림:api-key] x', SPILL_CUT(0)]);
  });

  it('host_exec 끝까지 — 스스로 끝남(잘린 JSON 기록·두 줄로 갈린 JSON)·긴급 정지(JSON 설정)·시간 초과(YAML): 결과·실행 기록 끝·중복 캐시에 값이 없다 (프로브 zz-xs5f7es-ctxloss)', async () => {
    const cases: Array<{ name: string; how: 'natural' | 'stop' | 'timeout' }> = [
      { name: "S5-61의 꼴 — 로거가 키 필드를 자르고 이어 쓴 JSON 기록의 keyStorePassword (출력 끝)", how: 'natural' },
      { name: '떠돌이 시작 표시 뒤 이름과 값이 두 줄로 갈린 JSON', how: 'natural' },
      { name: '떠돌이 시작 표시 뒤 JSON 설정 ("databasePassword":)', how: 'stop' },
      { name: '떠돌이 시작 표시 뒤 application.yml (trustStorePassword:)', how: 'timeout' },
    ];
    const rows: Record<string, { output: boolean; tail: boolean; cache: boolean; kept: boolean; stopped: string | null; timedOut: boolean }> = {};
    let n = 0;
    for (const { name, how } of cases) {
      const e = (env = await bootOrch({ workspace: true }));
      const { turnId } = await liveMainTurn(e);
      const { lines, secret, kept } = CTX_SHAPES[name]!;
      const requestId = `rq-ctx-${++n}`;
      scriptedHost(e, { lines: how === 'natural' ? lines : [...lines, ...rcLogs(2)], exitAfterMs: how === 'natural' ? 0 : null });
      const pending = hostExec(e, turnId, { command: 'type config.txt', request_id: requestId, ...(how === 'timeout' ? { timeout_s: 1 } : {}) });
      if (how === 'stop') {
        await waitFor(() => e.hostProcs.length > 0, '서버 명령 시작');
        await sleep(300);
        await e.invoke('stop.emergency');
      }
      const d = okData(await pending);
      const rec = hostRecords(e).find((x) => x.result.toolRequestId === requestId)!;
      const cache = JSON.stringify(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', requestId)) ?? null);
      expect(cache, name).toContain(requestId); // 중복 캐시를 실제로 봤다
      rows[`${name} · ${how}`] = {
        output: d.output.includes(secret),
        tail: String(rec.result.outputTail).includes(secret),
        cache: cache.includes(secret),
        kept: kept.every((l) => d.output.split('\n').includes(l)),
        stopped: d.stopped,
        timedOut: d.timed_out,
      };
      if (how === 'stop') await e.invoke('stop.release').catch(() => undefined);
      await e.close();
      env = null;
    }
    expect(rows).toEqual(
      Object.fromEntries(
        cases.map(({ name, how }) => [`${name} · ${how}`, { output: false, tail: false, cache: false, kept: true, stopped: how === 'stop' ? '긴급 정지' : null, timedOut: how === 'timeout' }]),
      ),
    );
  }, 120_000);

  it('씨앗 퍼즈 3,000건 — 비밀 값 줄(이름 붙은 값 여덟 꼴, 두 줄로 갈린 JSON, URL, 등록 값, wos_, 한 줄 키) × 자리 일곱(창 밖, 떠돌이 시작 표시 뒤, 잘린 키 뒤, 담는 중 끝 표시, 흘려 보냄의 끝 표시 없음·있음, 시작 줄): 날 출력을 백엔드 가리개로만 가려 가려지는 값은 text()에서도 가려진다 (리드 결정 S5-78의 차등 불변식)', () => {
    const rand = seeded(0x5f78);
    const t0 = performance.now();
    const worse: string[] = [];
    let worseCount = 0;
    /** 조각 가리기를 먼저 하고 마지막에만 가리던 예전 길(S5-71)로는 보였을 값 — 이 퍼즈가 그 결함의 꼴에 닿는지 */
    let oldWayShown = 0;
    const visited: Record<string, number> = {};
    const N = 3000;
    for (let c = 0; c < N; c++) {
      const k = secretCase(rand);
      // 경우마다 새 가리개 — 등록 값이 쌓이면 가리기가 등록 값 길이 수만큼 느려진다
      const red = createRedactor();
      for (const v of k.register) red.addSecret(v, 'db');
      const out = new HostExecOutput((t) => red.text(t));
      const bare = new HostExecOutput((t) => t);
      for (const l of k.lines) {
        out.push(l);
        bare.push(l);
      }
      const text = out.text();
      const alone = red.text(k.lines.join('\n'));
      const oldWay = red.text(bare.text());
      for (const s of k.secrets) {
        if (shownPieces(alone, s.value, s.piece)) continue;
        visited[`${k.position}|${k.format}`] = (visited[`${k.position}|${k.format}`] ?? 0) + 1;
        if (shownPieces(oldWay, s.value, s.piece)) oldWayShown++;
        if (shownPieces(text, s.value, s.piece)) {
          worseCount++;
          if (worse.length < 5) worse.push(`경우 ${c}(${k.position}·${k.format}): ${s.value}`);
        }
      }
    }
    const took = performance.now() - t0;
    expect({ worseCount, worse }).toEqual({ worseCount: 0, worse: [] });
    // 자리와 꼴마다 가리개만으로 가려지는 값이 고루 들었고, 예전 길이면 보였을 경우가 많다(결함의 꼴에 닿는다)
    const pairs = SECRET_POSITIONS.flatMap((p) => SECRET_FORMATS.map((f) => `${p}|${f}`));
    expect(pairs.filter((p) => (visited[p] ?? 0) < 5), JSON.stringify(visited)).toEqual([]);
    expect(oldWayShown, `${oldWayShown}`).toBeGreaterThan(300);
    expect(took, `${Math.round(took)}ms`).toBeLessThan(FUZZ_BUDGET_MS);
  }, FUZZ_BUDGET_MS * 2);
});

describe('조각 표시는 이어짐마다 하나 — 붙은 표시를 합치지 않는다 (리드 결정 S5-81 1)', () => {
  it("창 안에서 남기는 글의 base64 16자 넘는 이어짐은 저마다 '[가림:개인 키 조각]' 하나가 된다 — 공백·마침표·줄표·'\\'로 갈린 이어짐은 표시도 그만큼, 하나로 이어진 긴 이어짐은 하나", () => {
    const lines = [LB(), `a ${R20} ${R20} b`, `${R20}.${R20}-${R20} x`, `${R20}\\n${R20} y`, `long ${R20.repeat(5)} end`, 'done'];
    expect(rawLines(lines)).toEqual([CUT_MARK(1), `a ${PIECE} ${PIECE} b`, `${PIECE}.${PIECE}-${PIECE} x`, `${PIECE}\\${PIECE} y`, `long ${PIECE} end`, 'done']);
  });
});

/** 시작·끝 표시가 붙은 짝 (본문 없는 한 줄 키) */
const PAIR = `${LB()}${LE()}`;
const EC_PAIR = `${LB('EC ')}${LE('EC ')}`;

describe(`긴 줄 하나의 표시 걷기는 ${HOST_EXEC_PEM_LONG_MARKERS}개까지 — 넘으면 창을 출력 끝까지 연다 (리드 결정 S5-65)`, () => {
  it('표시 1,024개까지는 다 걷고, 하나라도 더 있으면 그 줄의 나머지는 걷지 않고 창을 출력 끝까지 연다 — 열린 창이 없으면 그 자리에서 연다(더 가리기만 한다)', () => {
    expect(HOST_EXEC_PEM_LONG_MARKERS).toBe(1024);
    const pad = 'x'.repeat(50_000);
    const looks = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo'; // 본문으로 보이는 줄 (base64 40자)
    // 창 밖 — 짝 512개(표시 1,024개): 모두 닫혀 창이 없고 다음 줄은 보통 줄
    const at = `${PAIR.repeat(512)}${pad}`;
    expect(rawLines([at, looks, '뒤'])).toEqual([omittedMark(at.length + 1), looks, '뒤']);
    // 1,025개(열리지 않은 종류의 끝 표시 하나 더 — 보통 글): 그 자리에서 출력 끝까지 여는 창 — 본문으로 보이는 줄은 버린다
    const over = `${PAIR.repeat(512)}${LE('EC ')}${pad}`;
    expect(rawLines([over, looks, '뒤'])).toEqual([omittedMark(over.length + 1), CUT_MARK(2), '뒤']);
    // 창 안 — 1,023번째 표시가 RSA 창을 닫으면 닫히고 뒤 글은 다시 본다. 그 끝 표시가 1,025번째면 보지 않고 창은 출력 끝까지 열린다
    const a = lbody('Sa', 3);
    const closes = `${pad}${EC_PAIR.repeat(511)}${LE()} 뒤 메모`;
    expect(rawLines(['앞', LB(), ...a, closes, 'z'])).toEqual(['앞', WIN_MARK(5), ' 뒤 메모', 'z']);
    const capped = `${pad}${EC_PAIR.repeat(512)}${LE()} 뒤 메모`;
    expect(rawLines(['앞', LB(), ...a, capped, 'z'])).toEqual(['앞', omittedMark(Buffer.byteLength(capped) + 1), CUT_MARK(5), 'z']);
    // 닫은 표시 뒤의 긴 글은 그 줄에서 걸은 수를 이어 센다 — 1,023번째에서 닫고 뒤에 표시가 둘이면 1,025번째에서 상한이라 그 자리에서 창이 열린다
    const rest = `${pad}${EC_PAIR.repeat(511)}${LE()}${pad}${LE('EC ')}${LE('EC ')}`;
    expect(rawLines(['앞', LB(), ...a, rest, looks, 'z'])).toEqual(['앞', WIN_MARK(5), omittedMark(Buffer.byteLength(rest) - Buffer.byteLength(`${pad}${EC_PAIR.repeat(511)}${LE()}`) + 1), CUT_MARK(2), 'z']);
  });

  it('상한 뒤의 시작 표시는 보지 않지만 창이 출력 끝까지 열려 있어 그 키의 본문도 버린다 — 끝 표시로 닫지 않는다(창 밖·창 안)', () => {
    // 창 밖: 짝 900개(뒤 상한보다 긴 줄) 뒤 그 줄 끝의 시작 표시 — 창은 상한에 닿은 자리에서 열리고 RSA 끝 표시도 닫지 않는다
    const b = lbody('Ta', 8);
    const outside = `${PAIR.repeat(900)}${LB()}`;
    expect(outside.length).toBeGreaterThan(HOST_EXEC_TAIL_BYTES);
    const out = rawLines([outside, ...b, LE(), '뒤']);
    expect(b.filter((x) => out.join('\n').includes(x))).toEqual([]);
    expect(out).toEqual([omittedMark(outside.length + 1), CUT_MARK(1 + b.length), LE(), '뒤']);
    // 창 안: RSA 창에서 EC 짝 900개 뒤 DSA 시작 표시 — 그 뒤 RSA 끝 표시가 창을 닫지 않아 DSA 본문은 끝까지 창 안이다
    const a = lbody('Tb', 4);
    const d = lbody('Tc', 8);
    const inside = `${EC_PAIR.repeat(900)} ${LB('DSA ')}`;
    expect(inside.length).toBeGreaterThan(HOST_EXEC_TAIL_BYTES);
    const inner = rawLines(['앞', LB(), ...a, inside, ...d.slice(0, 4), LE(), ...d.slice(4), LE('DSA '), '뒤']);
    expect([...a, ...d].filter((x) => inner.join('\n').includes(x))).toEqual([]);
    expect(inner).toEqual(['앞', omittedMark(inside.length + 1), CUT_MARK(1 + a.length + 1 + d.length), LE(), LE('DSA '), '뒤']);
  });

  it('표시가 촘촘한 32MiB 한 줄의 push도 바로 돌아온다(넉넉히 250ms 안) — 창 밖의 짝, RSA 창 안의 EC 끝 표시만, RSA 창 안의 EC 짝 (프로브 zz-xs5f5-perfpre)', () => {
    const dense = (unit: string): string => unit.repeat(Math.floor((32 * 1024 * 1024) / unit.length));
    const took: Record<string, number> = {};
    for (const [name, unit, inWindow] of [
      ['창 밖의 짝', PAIR, false],
      ['RSA 창 안의 EC 끝 표시만', LE('EC '), true],
      ['RSA 창 안의 EC 짝', EC_PAIR, true],
    ] as const) {
      const line = dense(unit);
      expect(line.includes('§')).toBe(false); // 줄을 미리 한 덩이로 만든다(러너가 넘기는 줄처럼) — 그 비용은 재지 않는다
      const out = new HostExecOutput((t) => t);
      if (inWindow) out.push(LB());
      const t0 = performance.now();
      out.push(line);
      took[name] = Math.round(performance.now() - t0);
      // 상한에 닿아 창이 출력 끝까지 열렸다 — 본문으로 보이는 줄은 버리고, RSA 끝 표시로 닫지 않는다
      for (const l of [...KEY_BODY.slice(0, 3), LE(), '뒤']) out.push(l);
      expect(out.text().split('\n'), name).toEqual([omittedMark(line.length + 1), CUT_MARK(inWindow ? 5 : 4), LE(), '뒤']);
    }
    expect(Math.max(...Object.values(took)), JSON.stringify(took)).toBeLessThan(250);
  });

  // 리드 결정 S5-72 (프로브 zz-xs5f6es-cap 4). 프로브의 마지막 단언(출력의 마지막 줄이 끝 줄 없는 표시)은 출력 끝에서 창에 남는 보통 줄('after')이 그 표시
  // 뒤에 오는 규칙(S5-48.4)과 맞지 않아, 마지막 창 표시가 끝 줄 없는 표시인지로 본다(프로브 1의 방식) — 정확한 출력도 함께 본다
  it('닫은 표시 뒤 짧은 글(48KiB 안)도 그 줄에서 걸은 수를 이어 센다 — 1,024개를 넘으면 그 자리에서 창을 출력 끝까지 연다: 열린 키가 있으면 그 구간의 시작 표시부터, 없으면 걷기가 멈춘 자리부터 (리드 결정 S5-72)', () => {
    const fill = 'x'.repeat(60_000);
    // 프로브 4: RSA 창, 60KiB 줄 — 채움, RSA 끝 표시(첫 표시, 창을 닫음), EC 짝 800개(표시 1,600개)의 46,400바이트 나머지
    const rest = EC_PAIR.repeat(800);
    expect(Buffer.byteLength(rest)).toBeLessThanOrEqual(HOST_EXEC_TAIL_BYTES);
    const probe = rawLines([LB(), `${fill}${LE()}${rest}`, 'after']);
    expect(probe.filter((l) => l.startsWith('[가림:개인 키') && !l.startsWith(KEY_MARK)).at(-1)).toMatch(/끝 줄 없음/);
    // 나머지에서 1,023개(짝 511개 + EC 시작 표시)를 걷고 멈춘다 — EC가 열린 채라 그 시작 표시부터가 창의 첫 줄이고 창은 출력 끝까지 열린다
    expect(probe).toEqual([WIN_MARK(2), KEY_MARK.repeat(511), CUT_MARK(1), EC_PAIR.repeat(289), 'after']);
    // 출력 끝까지 열린 창 — 뒤의 EC 끝 표시가 닫지 않아 그 뒤 본문 줄도 버린다
    const b = lbody('Ua', 4);
    const sticky = rawLines([LB(), `${fill}${LE()}${rest}`, ...b.slice(0, 2), LE('EC '), ...b.slice(2), '끝']);
    expect(b.filter((x) => sticky.join('\n').includes(x))).toEqual([]);
    expect(sticky.slice(-4)).toEqual([CUT_MARK(5), EC_PAIR.repeat(289), LE('EC '), '끝']);
    // 경계 — RSA 끝 표시와 나머지를 합쳐 1,024개(EC 짝 511개 + 열리지 않은 종류의 끝 표시)는 다 걷고 창이 없다
    expect(rawLines([LB(), `${fill}${LE()}${EC_PAIR.repeat(511)}${LE('DSA ')} 뒤`, 'after'])).toEqual([WIN_MARK(2), `${KEY_MARK.repeat(511)}${LE('DSA ')} 뒤`, 'after']);
    // 1,025개 — 열린 키 없이 상한에 닿아 걷기가 멈춘 자리(1,024번째 표시 뒤)에서 창을 연다: 앞 글은 보통 줄, 그 뒤는 창의 첫 줄. 창은 출력 끝까지 열려
    // 뒤의 DSA 시작·끝 표시로도 닫히지 않는다
    const c = lbody('Ub', 3);
    const over = `${fill}${LE()}${EC_PAIR.repeat(511)}${LE('DSA ')}${LE('DSA ')} 뒤`;
    const capped = rawLines([LB(), over, ...c, LB('DSA '), ...c, LE('DSA '), 'z']);
    expect(c.filter((x) => capped.join('\n').includes(x))).toEqual([]);
    expect(capped).toEqual([WIN_MARK(2), `${KEY_MARK.repeat(511)}${LE('DSA ')}`, CUT_MARK(7), `${LE('DSA ')} 뒤`, LB('DSA '), LE('DSA '), 'z']);
  });

  // 리드 결정 S5-88 1 (프로브 zz-s5f8ti-stopat-later, 변이 own6:O15-h-stopat-later-begin) — 걷지 않은 시작 표시가 멈춘 자리보다 뒤에 있으면 그 자리가 아니라
  // 멈춘 자리에서 창을 연다(S5-81 2). 그 사이 글은 창의 첫 줄이다
  it('걷기 상한이 아무 키도 닫지 않은 끝 표시에서 끝나고 걷지 않은 시작 표시가 그 뒤에 있어도 창은 걷기가 멈춘 자리에서 열린다 — 그 사이 글의 base64 이어짐은 창의 첫 줄에서 조각 표시다 (리드 결정 S5-81 2·S5-88 1)', () => {
    const fill = 'x'.repeat(60_000);
    const run = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo'; // base64 40자 (만든 글)
    // RSA 창, 60KB 줄: RSA 끝 표시(1번째, 창을 닫음), EC 짝 511개, DSA 끝 표시(1,024번째 — 아무 키도 닫지 않음), DSA 끝 표시(1,025번째, 걷지 않음), 글, 나중의 DSA 시작 표시
    const line = `${fill}${LE()}${EC_PAIR.repeat(511)}${LE('DSA ')}${LE('DSA ')} 뒤 ${run} ${LB('DSA ')} 메모`;
    const out = rawLines([LB(), line, 'z']);
    expect(out[1]).toBe(`${KEY_MARK.repeat(511)}${LE('DSA ')}`);
    expect(out.join('\n').includes(run)).toBe(false);
    expect(out.filter((l) => l.includes(PIECE))).toEqual([`${LE('DSA ')} 뒤 ${PIECE} ${LB('DSA ')} 메모`]);
    expect(out).toEqual([WIN_MARK(2), `${KEY_MARK.repeat(511)}${LE('DSA ')}`, CUT_MARK(1), `${LE('DSA ')} 뒤 ${PIECE} ${LB('DSA ')} 메모`, 'z']);
  });

  // 리드 결정 S5-77.1 (프로브 zz-s5f6ti-capped-open, 변이 own3:O12-h-outside-capped-no-stick)
  it('창 밖 긴 줄에서 셈하는 키가 열린 채 상한에 닿아도 창은 출력 끝까지 열려 있다 — 그 키의 끝 표시가 닫지 않아 걷지 않은 나머지의 키 본문이 남지 않는다 (가리개 없이·백엔드 가리개로)', () => {
    // 표시 1~1,022: 닫힌 짝 511개, 1,023: EC 시작 표시(셈하는 키), 1,024: 열리지 않은 DSA 끝 표시(보통 글), 1,025: 걷지 않은 RSA 시작 표시
    const line = `${PAIR.repeat(511)}${LB('EC ')}${LE('DSA ')}${'x'.repeat(50_000)}${LB()}`;
    expect(line.length).toBeGreaterThan(HOST_EXEC_TAIL_BYTES);
    const a = lbody('Va', 4); // EC 끝 표시 앞의 RSA 본문
    const b = lbody('Vb', 6); // EC 끝 표시 뒤의 RSA 본문 — 시작 표시는 버린 긴 줄에 있어 마지막 가리기가 기댈 데가 없다
    const lines = [line, ...a, LE('EC '), ...b, LE(), '뒤'];
    const outs = { '가리개 없이': rawLines(lines), '백엔드 가리개': collect(lines) };
    // 둘을 한 단언으로 — 하나가 깨지면 다른 쪽의 남은 줄 수도 함께 보인다
    expect(Object.fromEntries(Object.entries(outs).map(([name, out]) => [name, [...a, ...b].filter((x) => out.join('\n').includes(x)).length]))).toEqual({ '가리개 없이': 0, '백엔드 가리개': 0 });
    for (const [name, out] of Object.entries(outs)) expect(out, name).toEqual([omittedMark(line.length + 1), CUT_MARK(11), LE('EC '), LE(), '뒤']);
    // 대조: 상한 전에 키가 모두 닫혀 셈하는 키가 없을 때도 창은 출력 끝까지 열려 있다
    const closed = `${PAIR.repeat(512)}${LE('DSA ')}${'x'.repeat(50_000)}${LB()}`;
    const d = lbody('Vc', 6);
    const out = rawLines([closed, ...d, LE('EC '), ...d, LE(), '뒤']);
    expect(d.filter((x) => out.join('\n').includes(x))).toEqual([]);
    expect(out).toEqual([omittedMark(closed.length + 1), CUT_MARK(13), LE('EC '), LE(), '뒤']);
  });
});

/** 끝 표시와 다음 시작 표시가 대시를 함께 쓰는 줄 (프로브 zz-xs5f7es-fuzz C) — 대시 d개로 잇는다(10이면 함께 쓰지 않는다) */
const joinDashes = (end: string, begin: string, d: number): string => `${end.slice(0, -5)}${'-'.repeat(d)}${begin.slice(5)}`;
const OVERLAP = joinDashes(LE(), LB('EC '), 5);
/** 출력 줄에 남은 본문 줄의 16자 조각 수 */
const bodyLinesOf = (out: readonly string[], body: readonly string[]): number => leakedPieces(out.join('\n'), body).length;

describe('아무 키도 닫지 않은 끝 표시는 그 대시를 함께 쓰는 시작 표시를 가리지 않는다 (리드 결정 S5-79)', () => {
  it('검토자의 여섯 꼴 — 짧은 줄(대조), 버린 긴 줄 끝(끝 표시 있음·없음), 대시 여섯, 대시 열(대조), 생략된 가운데의 짧은 줄 뒤 900줄 키: 키 본문이 남지 않는다 — 가리개 없이도, 백엔드 가리개로도 (프로브 zz-xs5f7es-fuzz C)', () => {
    expect(OVERLAP).toBe('-----END RSA PRIVATE KEY-----BEGIN EC PRIVATE KEY-----');
    const red = createRedactor();
    const body = lbody('Wd', 8);
    const pad = '#'.repeat(50_000);
    const cases: Record<string, string[]> = {
      '짧은 줄 (대조 — 남은 줄을 마지막 가리기가 본다)': ['start', OVERLAP, ...body, LE('EC '), 'done'],
      '버린 긴 줄 끝': ['start', `${pad}${OVERLAP}`, ...body, LE('EC '), 'done'],
      '버린 긴 줄 끝, 끝 표시 없음 (출력 끝)': ['start', `${pad}${OVERLAP}`, ...body],
      '대시 여섯': ['start', `${pad}${joinDashes(LE(), LB('EC '), 6)}`, ...body, LE('EC '), 'done'],
      '대시 열 (cat a.pem b.pem — 함께 쓰지 않는다, 대조)': ['start', `${pad}${joinDashes(LE(), LB('EC '), 10)}`, ...body, LE('EC '), 'done'],
      '생략된 가운데의 짧은 줄, 그 뒤 900줄 키': ['start', ...Array.from({ length: 40 }, (_, i) => `${'.'.repeat(500)} head ${i}`), OVERLAP, ...Array.from({ length: 900 }, (_, i) => body[i % 8]!), LE('EC '), 'done'],
    };
    const rows: Record<string, { bare: number; backend: number; alone: number }> = {};
    for (const [name, lines] of Object.entries(cases)) {
      rows[name] = { bare: bodyLinesOf(rawLines(lines), body), backend: bodyLinesOf(collect(lines, red), body), alone: bodyLinesOf(red.text(lines.join('\n')).split('\n'), body) };
    }
    expect(rows).toEqual(Object.fromEntries(Object.keys(cases).map((k) => [k, { bare: 0, backend: 0, alone: 0 }])));
    // 모습 — 짧은 줄은 끝 표시 '-----'가 시작 표시의 것이 되어 그 앞 글이 보통 줄, 시작 표시부터 창이다. 긴 줄은 버리고 그 끝의 시작 표시로 창을 연다
    expect(rawLines(cases['짧은 줄 (대조 — 남은 줄을 마지막 가리기가 본다)']!)).toEqual(['start', '-----END RSA PRIVATE KEY', WIN_MARK(10), 'done']);
    expect(rawLines(cases['버린 긴 줄 끝']!)).toEqual(['start', omittedMark(pad.length + OVERLAP.length + 1), WIN_MARK(10), 'done']);
    expect(rawLines(cases['버린 긴 줄 끝, 끝 표시 없음 (출력 끝)']!)).toEqual(['start', omittedMark(pad.length + OVERLAP.length + 1), CUT_MARK(9)]);
    // 키를 닫은 끝 표시에 겹친 시작 표시도 창을 연다 (리드 결정 S5-85 — S5-79 때는 redactPem처럼 건너뛰어 'BEGIN EC …'가 보통 글로 남았다). 한 줄에 다 든 키
    // 뒤의 그 꼴은 가리개만 쓰면 시작 표시를 보지 못하지만, 창은 그 시작 표시에서 열어 뒤 EC 본문도 가리개 없이 남기지 않는다 — 더 가리기만 한다
    const closing = `${LB()}\\n${body[0]}\\n${OVERLAP}`;
    expect(red.text(closing)).toBe(`${KEY_MARK}BEGIN EC PRIVATE KEY-----`);
    expect(rawLines(['start', closing, 'done'])).toEqual(['start', KEY_MARK, CUT_MARK(1), 'done']);
    expect(rawLines(['start', closing, ...body, LE('EC '), 'done'])).toEqual(['start', KEY_MARK, WIN_MARK(10), 'done']);
  });

  it('창 안의 걷기도 같다 — RSA 창 안에서 아무 키도 닫지 않은 EC 끝 표시의 대시로 시작한 DSA 키는 RSA 끝 표시가 창을 닫지 못하게 한다: 그 뒤 DSA 본문이 남지 않는다(담는 중·흘려 보냄)', () => {
    const red = createRedactor();
    const a = lbody('Xa', 3);
    const d = lbody('Xd', 5);
    const inside = joinDashes(LE('EC '), LB('DSA '), 7);
    const buffered = ['start', LB(), ...a, `note ${inside}`, ...d.slice(0, 2), LE(), ...d.slice(2), LE('DSA '), 'done'];
    expect(rawLines(buffered)).toEqual(['start', WIN_MARK(12), 'done']);
    const spilled = ['start', LB(), ...a, `note ${inside}`, ...rcLogs(400), LE(), ...d, LE('DSA '), 'done'];
    const outs = { '담는 중 — 가리개 없이': rawLines(buffered), '담는 중 — 백엔드 가리개': collect(buffered, red), '흘려 보냄 — 가리개 없이': rawLines(spilled), '흘려 보냄 — 백엔드 가리개': collect(spilled, red) };
    expect(Object.fromEntries(Object.entries(outs).map(([k, v]) => [k, bodyLinesOf(v, [...a, ...d])]))).toEqual(Object.fromEntries(Object.keys(outs).map((k) => [k, 0])));
    // 흘려 보내는 창은 DSA 끝 표시에서 닫힌다 — RSA 끝 표시는 창의 보통 줄이다
    expect(outs['흘려 보냄 — 가리개 없이']!.slice(-4)).toEqual(['[test] case 399 ok', LE(), SPILL_END(8), 'done']);
  });

  it('긴 줄의 걷기 상한(1,024번째)이 아무 키도 닫지 않은 끝 표시에서 끝나고 그 대시로 시작 표시가 이어지면, 창은 그 시작 표시에서 열린다 — 앞 글은 보통 줄 (리드 결정 S5-72·S5-79·S5-81 2)', () => {
    const fill = 'x'.repeat(60_000);
    const e = lbody('Xe', 4);
    // RSA 창, 60KiB 줄: RSA 끝 표시(1번째, 창을 닫음), EC 짝 511개(1,022개), DSA 끝 표시(1,024번째 — 아무 키도 닫지 않음)의 대시로 시작하는 EC 시작 표시(걷지 않음)
    const capped = `${fill}${LE()}${EC_PAIR.repeat(511)}${joinDashes(LE('DSA '), LB('EC '), 5)} 메모`;
    const out = rawLines([LB(), capped, ...e, LE('EC '), ...e, '끝']);
    expect(e.filter((x) => out.join('\n').includes(x))).toEqual([]);
    expect(out).toEqual([WIN_MARK(2), `${KEY_MARK.repeat(511)}-----END DSA PRIVATE KEY`, CUT_MARK(9), `${LB('EC ')} 메모`, LE('EC '), '끝']);
  });

  it('씨앗 퍼즈 900건 — 끝 표시와 시작 표시를 대시 5~10개로 이은 줄 × 짧은 줄·버린 긴 줄·생략된 가운데 × 아무 키도 닫지 않는 끝 표시·키를 닫는 끝 표시(키 하나·겹침·엇갈림·따옴표 든 줄): 날 출력을 가리개로만 가린 것보다 덜 가리지 않고, 끝 표시 뒤 키의 본문은 가리개 없이도 남지 않는다 (리드 결정 S5-79·S5-85)', () => {
    const red = createRedactor();
    const rand = seeded(0x5f79);
    const t0 = performance.now();
    const worse: string[] = [];
    const bareLeaks: string[] = [];
    const seen: Record<string, number> = {};
    const closes: Record<string, number> = {};
    for (let c = 0; c < 900; c++) {
      const k = dashJoinCase(rand);
      seen[`${k.place}|${k.plain ? '닫지 않음' : '닫음'}|${k.dashes === 10 ? '10' : '5-9'}`] = (seen[`${k.place}|${k.plain ? '닫지 않음' : '닫음'}|${k.dashes === 10 ? '10' : '5-9'}`] ?? 0) + 1;
      if (k.close && k.dashes < 10) closes[k.close] = (closes[k.close] ?? 0) + 1;
      const pieces = bodyPieces(k.bodies);
      const text = new HostExecOutput((t) => red.text(t));
      const bare = new HostExecOutput((t) => t);
      for (const l of k.lines) {
        text.push(l);
        bare.push(l);
      }
      const leaked = leakedPieces(text.text(), [], pieces);
      if (leaked.length) {
        const plain = red.text(k.lines.join('\n'));
        const less = leaked.filter((p) => !plain.includes(p));
        if (less.length && worse.length < 5) worse.push(`경우 ${c}(${k.place}·대시 ${k.dashes}·${k.plain ? '닫지 않음' : '닫음'}): ${less.length}조각`);
      }
      // 끝 표시 뒤의 키는 그 끝 표시가 키를 닫든 닫지 않든(대시를 함께 써도 안 써도) 창이 연다 — 가리개 없이도 본문이 없다 (리드 결정 S5-79·S5-85)
      if (leakedPieces(bare.text(), k.yBodies).length && bareLeaks.length < 5) bareLeaks.push(`경우 ${c}(${k.place}·대시 ${k.dashes}·${k.close ?? '닫지 않음'})`);
    }
    expect({ worse, bareLeaks }).toEqual({ worse: [], bareLeaks: [] });
    // 자리 셋 × 끝 표시 둘 × 대시(함께 씀·안 씀)가 모두 들었다
    expect(Object.keys(seen).length, JSON.stringify(seen)).toBe(12);
    expect(Object.values(seen).every((n) => n >= 5), JSON.stringify(seen)).toBe(true);
    // 대시를 함께 쓰며 닫는 끝 표시의 꼴 넷(키 하나·겹침·엇갈림·따옴표 든 줄 — 리드 결정 S5-85)이 저마다 넉넉히 들었다
    expect(Object.keys(closes).sort(), JSON.stringify(closes)).toEqual(['crossing', 'nested', 'quote', 'single']);
    expect(Object.values(closes).every((n) => n >= 30), JSON.stringify(closes)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(FUZZ_BUDGET_MS);
  }, FUZZ_BUDGET_MS * 2);
});

/** 시드로 만든 64자 base64 본문 줄 n개 (가짜 값 — 줄마다 다르다, 조각이 겹치지 않게) */
const seededBody = (seed: number, n: number): string[] => {
  const rand = seeded(seed);
  return Array.from({ length: n }, () => Array.from({ length: 64 }, () => B64_CHARS[Math.floor(rand() * 64)]).join(''));
};

describe('창을 닫은 끝 표시의 끝 대시로 시작하는 시작 표시도 창을 연다 — redactPem이 그 끝 표시를 보통 글로 보는 꼴 (리드 결정 S5-85, 프로브 zz-xs5f8es-overlap)', () => {
  /** 끝 표시 a의 끝 '-----'에서 시작 표시 b가 시작하는 줄 (대시 다섯을 함께 쓴다) */
  const JOIN = (a: string, b: string): string => joinDashes(LE(a), LB(b), 5);
  const A = seededBody(0x5f8501, 4);
  const B = seededBody(0x5f8502, 4);
  /** 셋째 키(EC)의 본문 — 이것이 남는지 본다 */
  const C = seededBody(0x5f8503, 8);
  const filler = (n: number): string[] => Array.from({ length: n }, (_, i) => `[app] request ${i} ok`);
  const CASES: Record<string, string[]> = {
    '겹친 두 RSA 키, 바깥 끝 표시에 EC 시작 표시': ['start', LB(), LB(), ...A, LE(), ...B, JOIN('RSA ', 'EC '), ...C, LE('EC '), 'done'],
    '엇갈린 RSA·DSA(두 출력), DSA 끝 표시에 EC 시작 표시': ['start', LB(), ...A.slice(0, 2), LB('DSA '), ...B.slice(0, 2), ...A.slice(2), LE(), ...B.slice(2), JOIN('DSA ', 'EC '), ...C, LE('EC '), 'done'],
    '따옴표 든 줄이 낀 RSA 블록, 그 끝 표시에 EC 시작 표시': ['start', LB(), 'Comment: "deploy key"', ...A, JOIN('RSA ', 'EC '), ...C, LE('EC '), 'done'],
    '겹친 두 키, 흘려 보낸 창(사이에 430줄)': ['start', LB(), LB(), ...filler(430), LE(), ...B, JOIN('RSA ', 'EC '), ...C, LE('EC '), 'done'],
    '겹친 두 키, EC 키는 끝 표시 없이 출력 끝': ['start', LB(), LB(), ...A, LE(), ...B, JOIN('RSA ', 'EC '), ...C],
    '겹친 두 키, 대시 여섯': ['start', LB(), LB(), ...A, LE(), ...B, joinDashes(LE(), LB('EC '), 6), ...C, LE('EC '), 'done'],
  };
  /** 자동 검사의 출력 모으기로 모은 글 */
  const checked = (lines: string[], red: ReturnType<typeof createRedactor>): string[] => {
    const t = new CheckOutputTail((s) => red.text(s));
    for (const l of lines) t.push(l);
    return t.text().split('\n');
  };

  it('겹친 키의 바깥 끝 표시·엇갈린 키의 나중 끝 표시·따옴표 든 줄이 낀 블록·흘려 보낸 창·끝 줄 없는 다음 키·대시 여섯: 다음 키의 본문 조각이 없다 — 가리개 없이, 백엔드 가리개로, 자동 검사의 모으기로(가리개만으로도 0)', () => {
    const red = createRedactor();
    const rows: Record<string, { bare: number; backend: number; check: number; alone: number }> = {};
    for (const [name, lines] of Object.entries(CASES)) {
      rows[name] = { bare: bodyLinesOf(rawLines(lines), C), backend: bodyLinesOf(collect(lines, red), C), check: bodyLinesOf(checked(lines, red), C), alone: bodyLinesOf(red.text(lines.join('\n')).split('\n'), C) };
    }
    expect(rows).toEqual(Object.fromEntries(Object.keys(CASES).map((k) => [k, { bare: 0, backend: 0, check: 0, alone: 0 }])));
    // 모습 — 창은 바깥(나중) 끝 표시에서 닫히고, 그 끝 '-----'에서 시작한 EC 시작 표시부터 새 창이 열린다
    expect(rawLines(CASES['겹친 두 RSA 키, 바깥 끝 표시에 EC 시작 표시']!)).toEqual(['start', WIN_MARK(12), WIN_MARK(10), 'done']);
    expect(rawLines(CASES['엇갈린 RSA·DSA(두 출력), DSA 끝 표시에 EC 시작 표시']!)).toEqual(['start', WIN_MARK(12), WIN_MARK(10), 'done']);
    expect(rawLines(CASES['따옴표 든 줄이 낀 RSA 블록, 그 끝 표시에 EC 시작 표시']!)).toEqual(['start', WIN_MARK(7), WIN_MARK(10), 'done']);
    expect(rawLines(CASES['겹친 두 키, EC 키는 끝 표시 없이 출력 끝']!)).toEqual(['start', WIN_MARK(12), CUT_MARK(9)]);
    expect(rawLines(CASES['겹친 두 키, 대시 여섯']!)).toEqual(['start', WIN_MARK(12), WIN_MARK(10), 'done']);
    expect(rawLines(CASES['겹친 두 키, 흘려 보낸 창(사이에 430줄)']!).slice(-4)).toEqual([LE(), SPILL_END(4), WIN_MARK(10), 'done']);
  });

  it('대조 — 키 하나를 닫는 끝 표시: 가리개만으로는 그 대시의 시작 표시를 건너뛰어 다음 키가 남지만(redactPem의 블록이 그 끝 표시에서 끝난다) 창은 연다 — 더 가리기만 한다', () => {
    const red = createRedactor();
    const lines = ['start', LB(), ...A, JOIN('RSA ', 'EC '), ...C, LE('EC '), 'done'];
    expect(bodyLinesOf(red.text(lines.join('\n')).split('\n'), C)).toBeGreaterThan(0);
    expect({ bare: bodyLinesOf(rawLines(lines), C), backend: bodyLinesOf(collect(lines, red), C), check: bodyLinesOf(checked(lines, red), C) }).toEqual({ bare: 0, backend: 0, check: 0 });
    expect(rawLines(lines)).toEqual(['start', WIN_MARK(6), WIN_MARK(10), 'done']);
    // 대시 열(cat a.pem b.pem)은 함께 쓰지 않는다 — 끝 표시 바로 뒤의 시작 표시다. 끝 표시 뒤 글은 예전처럼 그대로 다시 본다
    expect(rawLines(['start', LB(), ...A, joinDashes(LE(), LB('EC '), 10), ...C, LE('EC '), 'done'])).toEqual(['start', WIN_MARK(6), WIN_MARK(10), 'done']);
    expect(rawLines(['start', LB(), ...A, `${LE()} ----- 끝`, 'done'])).toEqual(['start', WIN_MARK(6), ' ----- 끝', 'done']);
  });

  it('긴 줄도 같다 — 창 안의 긴 줄에서 바깥 끝 표시가 닫고 그 끝 대시로 시작 표시가 이어지면, 뒤 글이 짧아도(다시 본다) 길어도(창 밖의 긴 줄) 다음 키의 창이 열린다', () => {
    const pad = '#'.repeat(50_000);
    const short = ['start', LB(), LB(), ...A, LE(), ...B, `${pad}${JOIN('RSA ', 'EC ')}`, ...C, LE('EC '), 'done'];
    expect(rawLines(short)).toEqual(['start', WIN_MARK(12), WIN_MARK(10), 'done']);
    const rest = `${LB('EC ')}${pad}`;
    const long = ['start', LB(), LB(), ...A, LE(), ...B, `${pad}${JOIN('RSA ', 'EC ')}${pad}`, ...C, LE('EC '), 'done'];
    expect(rawLines(long)).toEqual(['start', WIN_MARK(12), omittedMark(Buffer.byteLength(rest) + 1), WIN_MARK(10), 'done']);
    // 창 밖의 긴 줄: 한 줄에 다 든 키를 닫는 끝 표시의 대시로 시작한 키도 줄 끝에서 열린 채라 창을 연다
    const outside = ['start', `${pad}${LB()}\\n${A[0]}\\n${JOIN('RSA ', 'EC ')}`, ...C, LE('EC '), 'done'];
    expect(bodyLinesOf(rawLines(outside), C)).toBe(0);
  });

  it('반대쪽 — 방금 걸은 시작 표시의 끝 대시로 시작한 끝 표시는 그 키를 닫지 않는다(redactPem도 그 끝 표시를 보지 않는다): 뒤 본문과 진짜 끝 표시까지 한 창 (리드 결정 S5-90 4, 프로브 zz-s5f9ti-begin-end-overlap, 변이 rea8:R8-O10-h-markers-no-overlap-skip·own8:O17-h-end-overlap-used)', () => {
    const red = createRedactor();
    const body = seededBody(0x5f9e, 8);
    const shared = `${LB()}END RSA PRIVATE KEY-----`;
    expect(shared).toBe('-----BEGIN RSA PRIVATE KEY-----END RSA PRIVATE KEY-----');
    const lines = ['start', shared, ...body, LE(), 'done'];
    // 가리개 없이 — 그 줄부터 진짜 끝 표시까지 10줄이 한 창이다(그 줄에서 키가 닫혔다고 보면 본문 8줄이 창 밖에 남는다)
    expect(rawLines(lines)).toEqual(['start', WIN_MARK(10), 'done']);
    // 백엔드 가리개로 모아도, 가리개만으로도 본문 조각이 없다 (리드 결정 S5-78 불변식 ②)
    expect({ backend: bodyLinesOf(collect(lines, red), body), alone: bodyLinesOf(red.text(lines.join('\n')).split('\n'), body) }).toEqual({ backend: 0, alone: 0 });
    expect(collect(lines, red)).toEqual(['start', WIN_MARK(10), 'done']);
  });

  it('host_exec 끝까지: 겹친 두 키의 바깥 끝 표시에 이은 키 — 결과·실행 기록 끝·중복 캐시에 본문 조각이 없다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    for (const [i, name] of ['겹친 두 RSA 키, 바깥 끝 표시에 EC 시작 표시', '엇갈린 RSA·DSA(두 출력), DSA 끝 표시에 EC 시작 표시'].entries()) {
      const r = await runLines(e, turnId, CASES[name]!, `rq-s585-${i}`);
      expect(leakedPieces(r.all, C), name).toEqual([]);
      expect(r.d.output, name).toBe(['start', WIN_MARK(12), WIN_MARK(10), 'done'].join('\n'));
    }
  });
});

describe('가리기가 실패해도 host_exec와 자동 검사의 출력 모으기는 던지지 않는다 (리드 결정 S5-83, 프로브 zz-xs5f8es-redthrow)', () => {
  /** 가리지 못한 글을 바꾸는 표시 — 시험은 글 그대로 본다(이 차례 전 코드에서도 같은 단언이 돌게) */
  const FAILED = '[가림:가리기 실패]';
  const SECRET_MARK = '[가림:비밀 값]';
  /** 이어 쓴 대입 끝의 값 (만든 가짜 값) */
  const TAIL = ['Wd4', 'pQ7z', 'Lk2m', 'Vx9'].join('');
  /** 공백 없이 이어 쓴 대입 한 덩이를 48KiB 가까이 — 남기는 한 줄의 상한 안 */
  const chainLine = (unit: string): string => unit.repeat(Math.floor((48 * 1024 - 64) / unit.length)) + TAIL;
  /** 넣은 내부 오류의 표지 — 이 글이 든 글을 가리면 던지는 가리개(백엔드 가리개는 스스로 던지지 않는다) */
  const SENTINEL = ['hx', 'sentinel', '5f83'].join('-');
  const throwingOn =
    (text: (s: string) => string) =>
    (s: string): string => {
      if (s.includes(SENTINEL)) throw new RangeError('Maximum call stack size exceeded');
      return text(s);
    };

  it('48KiB로 이어 쓴 대입 한 줄(key=·key:·tokenType=) — 창 밖·담는 중 창의 출력 끝·흘려 보내는 창에서 던지지 않고 값을 가린다. 자동 검사의 모으기도 같다', () => {
    const red = createRedactor();
    for (const unit of ['key=', 'key:', 'tokenType=']) {
      const line = chainLine(unit);
      const hidden = `${unit.repeat(17)}${SECRET_MARK}`;
      expect(collect(['start', line, 'done'], red), unit).toEqual(['start', hidden, 'done']);
      for (const lines of [[LB(), line], [LB(), ...rcLogs(400), line, 'done']]) {
        const out = collect(lines, red).join('\n');
        expect(out.includes(TAIL) || out.includes(FAILED), unit).toBe(false);
      }
      const t = new CheckOutputTail((s) => red.text(s));
      for (const l of ['start', line, 'done']) t.push(l);
      expect(t.text(), unit).toBe(`start\n${hidden}\ndone`);
    }
  });

  it('출력 모으기는 받은 가리개가 던져도 던지지 않는다 — 마지막 가리기에서면 모은 글 전체, 창 안에서 남길 때면 그 줄만 가리기 실패 표시', () => {
    const red = createRedactor();
    const redact = throwingOn((s) => red.text(s));
    const plain = new HostExecOutput(redact);
    for (const l of ['start', `log ${SENTINEL} API_KEY=${TAIL}`, 'done']) plain.push(l);
    expect(plain.text()).toBe(FAILED);
    // 흘려 보내는 창: 남길 때 가리는 줄(16자 넘는 base64 이어짐)이 던지면 그 줄만 표시 — 다른 줄은 남길 때와 마지막 가리기를 그대로 받는다
    const piece = 'QUJDREVGR0hJSktMTU5PUFFS';
    const spill = new HostExecOutput(redact);
    for (const l of [LB(), ...rcLogs(400), `${SENTINEL} ${piece} 끝`, `token=${TAIL} 끝`, `${piece} 끝`, 'done']) spill.push(l);
    const out = spill.text().split('\n');
    expect(out.slice(0, 2)).toEqual([SPILL_MARK, '[test] case 0 ok']);
    expect(out.slice(-5)).toEqual([FAILED, `token=${SECRET_MARK} 끝`, `${PIECE} 끝`, 'done', SPILL_CUT(0)]);
    expect(out.join('\n').includes(SENTINEL) || out.join('\n').includes(TAIL)).toBe(false);
    // 자동 검사의 모으기도 던지지 않는다
    const t = new CheckOutputTail(redact);
    for (const l of ['start', `log ${SENTINEL}`, 'done']) t.push(l);
    expect(t.text()).toBe(FAILED);
  });

  it('백엔드 가리개(앱 조립)는 가리지 못한 글을 표시로 바꾸고 로그 경고 한 줄을 남긴다 — 글의 내용은 적지 않는다', async () => {
    const logs: [string, string][] = [];
    const deps = await buildOrchestratorDeps({
      dataDir: newDir(),
      appRoot: process.cwd(),
      isPackaged: true,
      nodeExecPath: process.execPath,
      nodeExecEnv: {},
      shell: null,
      memorySecrets: true,
      runnerMode: process.platform === 'win32' ? 'taskkill' : 'pgroup',
      jobHelper: null,
      logger: (level, msg) => logs.push([level, msg]),
    });
    try {
      const line = `log ${SENTINEL} password=${TAIL}`;
      const includes = String.prototype.includes;
      vi.spyOn(String.prototype, 'includes').mockImplementation(function (this: string, search: string, position?: number) {
        if (includes.call(this, SENTINEL)) throw new Error(`가짜 내부 오류: ${String(this)}`);
        return includes.call(this, search, position);
      });
      let out = '';
      try {
        out = deps.redactor.text(line);
      } finally {
        vi.restoreAllMocks();
      }
      expect(out).toBe(FAILED);
      const warned = logs.filter(([, m]) => m.includes('가리기 실패'));
      expect(warned).toEqual([['warn', `가리개가 글 하나를 가리지 못해 '${FAILED}'로 바꿨습니다 (Error, ${line.length.toLocaleString('ko-KR')}자) — 원문은 남기지 않았습니다`]]);
      expect(JSON.stringify(logs).includes(SENTINEL) || JSON.stringify(logs).includes(TAIL)).toBe(false);
    } finally {
      deps.store.close();
      deps.runner.dispose?.();
    }
  });

  it('host_exec 끝까지: 이어 쓴 대입 한 줄을 낸 명령 — 결과는 ok이고 값이 없다, 실행 기록에 PID·띄운 시각, 끝 활동 기록·일지 한 줄, 같은 request_id는 다시 돌지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const made = scriptedHost(e, { lines: ['start', chainLine('key='), 'done'], code: 0 });
    const { turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'type build.log', request_id: 'rq-s583-chain' }));
    expect(d).toMatchObject({ exit_code: 0, stopped: null, leftover: 0, output: `start\n${'key='.repeat(17)}${SECRET_MARK}\ndone` });
    const rec = hostRecords(e).find((x) => x.result.toolRequestId === 'rq-s583-chain')!;
    expect(rec).toMatchObject({ state: 'succeeded', result: { pid: expect.any(Number), spawnedAt: expect.any(String), outputTail: d.output } });
    const again = await hostExec(e, turnId, { command: 'type build.log', request_id: 'rq-s583-chain' });
    expect(again).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    expect(made).toHaveLength(1);
    const ends = e.ctx.store.activity.search({ kinds: ['exec'], limit: 50 }).filter((x) => x.text.startsWith(`메인 에이전트 서버 명령 끝 (host_exec ${rec.requestId})`));
    expect(ends).toHaveLength(1);
    expect(e.ctx.store.journal.query({ kinds: ['action'], limit: 20 }).filter((j) => j.text.startsWith(`서버 명령 실행 (host_exec ${rec.requestId})`))).toHaveLength(1);
  });

  it('host_exec 끝까지: 하위 프로세스를 남긴 명령(remaining 1)이 이어 쓴 대입 한 줄을 냈어도 부른 턴에 접는다 — 그 턴의 다음 host_exec는 거부', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { lines: ['start', chainLine('key:'), 'done'], code: 0, remaining: 1 });
    const { turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'start-server.cmd', request_id: 'rq-s583-left' }));
    expect(d).toMatchObject({ leftover: 1, output: `start\n${'key:'.repeat(17)}${SECRET_MARK}\ndone` });
    const again = await hostExec(e, turnId, { command: 'echo hi', request_id: 'rq-s583-left-2' });
    expect(again).toMatchObject({ ok: false, code: 'conflict' });
    expect(e.hostSpecs).toHaveLength(1);
  });

  it('가리개가 던져도(넣은 오류) host_exec 결과는 ok이고 출력은 가리기 실패 표시 — 실행 기록(PID·띄운 시각·끝)·남은 프로세스 접기·시작과 끝 활동 기록·일지가 그대로', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const red = e.ctx.deps.redactor;
    const original = red.text.bind(red);
    red.text = throwingOn(original);
    scriptedHost(e, { lines: ['start', `log ${SENTINEL} ok`, 'done'], code: 0, remaining: 2 });
    const { proc, turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'start-dev.cmd', request_id: 'rq-s583-inject' }));
    expect(d).toMatchObject({ exit_code: 0, stopped: null, leftover: 2, output: FAILED });
    const rec = hostRecords(e).find((x) => x.result.toolRequestId === 'rq-s583-inject')!;
    expect(rec).toMatchObject({ state: 'failed', result: { pid: expect.any(Number), spawnedAt: expect.any(String), outputTail: FAILED, remaining: 2, exitCode: 0 } });
    const rows = e.ctx.store.activity.search({ kinds: ['exec'], limit: 50 }).filter((x) => x.text.includes(`host_exec ${rec.requestId}`));
    expect(rows.map((x) => x.text.split(' (')[0])).toEqual(['메인 에이전트 서버 명령 끝', '메인 에이전트 서버 명령 시작']);
    expect(rows[0]!.text).toContain('남은 하위 프로세스 2개(종료 확인 실패)');
    expect(e.ctx.store.journal.query({ kinds: ['action'], limit: 20 }).filter((j) => j.text.startsWith(`서버 명령 실행 (host_exec ${rec.requestId})`))).toHaveLength(1);
    // 남은 프로세스는 부른 턴에 접혔다 — 그 턴에는 더 실행하지 않고, 턴이 끝나면 kill_failed와 메인 에이전트 일시정지
    expect(await hostExec(e, turnId, { command: 'echo again' })).toMatchObject({ ok: false, code: 'conflict' });
    e.hold.clear();
    proc.finishOk();
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    expect(e.ctx.store.turns.require(turnId).process).toMatchObject({ state: 'kill_failed', killDetail: `서버 명령 ${rec.requestId}: 남은 프로세스 2개` });
    await waitFor(() => !!e.ctx.stop().members[MAIN_AGENT_ID]?.paused, '메인 에이전트 일시정지');
    expect(everywhere(e, d, toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', 'rq-s583-inject')).includes(SENTINEL)).toBe(false);
  });

  it('출력을 셈하다 던져도(HostExecOutput.text를 던지게 함) run은 출력 자리에 가리기 실패 표시를 두고 실행 기록·남은 프로세스 접기·끝 활동 기록·일지를 마친다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    vi.spyOn(HostExecOutput.prototype, 'text').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    scriptedHost(e, { lines: ['start', 'done'], code: 0, remaining: 1 });
    const { turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'start-dev.cmd', request_id: 'rq-s583-text' }));
    expect(d).toMatchObject({ leftover: 1, output: FAILED });
    const rec = hostRecords(e).find((x) => x.result.toolRequestId === 'rq-s583-text')!;
    expect(rec).toMatchObject({ state: 'failed', result: { pid: expect.any(Number), spawnedAt: expect.any(String), outputTail: FAILED, remaining: 1 } });
    expect(e.ctx.store.activity.search({ kinds: ['exec'], limit: 50 }).filter((x) => x.text.startsWith(`메인 에이전트 서버 명령 끝 (host_exec ${rec.requestId})`))).toHaveLength(1);
    expect(e.ctx.store.journal.query({ kinds: ['action'], limit: 20 }).filter((j) => j.text.startsWith(`서버 명령 실행 (host_exec ${rec.requestId})`))).toHaveLength(1);
    expect(await hostExec(e, turnId, { command: 'echo again' })).toMatchObject({ ok: false, code: 'conflict' });
  });

  it("띄운 뒤 처리하다 난 오류: 실행 기록은 PID·띄운 시각을 지킨 채 실패로 남고, 결과는 '띄운 뒤 처리하다 오류'다 — 같은 request_id는 다시 돌지 않는다", async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const made = scriptedHost(e, {
      lines: ['start'],
      code: 0,
      onStart: (p) => {
        const broken = Promise.reject(new Error('가짜 러너 오류 — 끝을 받지 못함'));
        broken.catch(() => undefined);
        Object.defineProperty(p, 'exited', { value: broken });
      },
    });
    const { turnId } = await liveMainTurn(e);
    const first = await hostExec(e, turnId, { command: 'npm ci', request_id: 'rq-s583-after' });
    const rec = hostRecords(e).find((x) => x.result.toolRequestId === 'rq-s583-after')!;
    expect(first).toEqual({
      ok: false,
      code: 'error',
      message: `서버 명령을 띄운 뒤 처리하다 오류가 났습니다: 가짜 러너 오류 — 끝을 받지 못함 — 명령은 돌았을 수 있습니다. 실행 기록 ${rec.requestId}을 보고, 같은 명령을 다시 돌리려면 새 request_id를 쓰세요`,
    });
    expect(rec).toMatchObject({ state: 'failed', result: { pid: expect.any(Number), spawnedAt: expect.any(String), error: '가짜 러너 오류 — 끝을 받지 못함' } });
    const again = await hostExec(e, turnId, { command: 'npm ci', request_id: 'rq-s583-after' });
    expect(again).toMatchObject({ ok: false, code: 'conflict' });
    expect(again.ok ? '' : again.message).toContain('한 번 돌았습니다');
    expect(made).toHaveLength(1);
  });
});

describe('줄에서 떼어 남긴 조각은 그 줄을 붙잡지 않는다 (리드 결정 S5-66, 프로브 zz-xs5f5-sliceretain)', () => {
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const heapMiB = (): number => {
    // V8은 마지막으로 맞춘 정규식의 대상 글 하나를 다음 맞춤까지 쥐고 있다(RegExp.lastMatch) — 쌓이지 않는 한 글이라 재기 전에 작은 글로 바꿔 둔다
    /./.exec('a');
    gc();
    gc();
    return process.memoryUsage().heapUsed / 1048576;
  };
  /** rounds번 make(i)의 줄을 넣는 동안 붙잡힌 메모리(MiB) — 모으기가 살아 있을 때 잰다. 줄은 그때그때 만들어 넣는다(러너가 넘기는 줄처럼) */
  const held = (rounds: number, make: (i: number) => string[]): number => {
    const before = heapMiB();
    const o = new HostExecOutput((t) => t);
    for (let i = 0; i < rounds; i++) for (const l of make(i)) o.push(l);
    const mib = heapMiB() - before;
    expect(o.text()).toContain('[가림:개인 키');
    return Math.round(mib * 10) / 10;
  };
  const n6 = (i: number): string => String(i).padStart(6, '0');

  it('끝 표시 뒤 짧은 글(긴 줄 1MiB × 100번, 40KiB 줄 × 1,500번), 한 줄에 다 든 키 뒤 짧은 글, 시작 표시 앞 짧은 글(40KiB 줄 × 1,500번): 붙잡힌 메모리가 10MiB 안이다', () => {
    const mib = {
      longAfterEnd: held(100, (i) => [LB(), `${'#'.repeat(1 << 20)}${n6(i)}${LE()} (key rotated) ok`]),
      shortAfterEnd: held(1500, (i) => [LB(), `${'#'.repeat(40 * 1024)}${n6(i)}${LE()} (key rotated) ok`]),
      afterInlineKey: held(1500, (i) => [`${LB()}${'A'.repeat(40 * 1024)}${n6(i)}${LE()} (key rotated) ok`]),
      beforeBegin: held(1500, (i) => [`note before key ${n6(i)}: ${LB()}${'A'.repeat(40 * 1024)}`, LE()]),
    };
    expect(Object.fromEntries(Object.entries(mib).map(([k, v]) => [k, v < 10])), JSON.stringify(mib)).toEqual({ longAfterEnd: true, shortAfterEnd: true, afterInlineKey: true, beforeBegin: true });
  });

  it('긴 줄 끝의 시작 표시로 연 창은 그 긴 줄(32MiB)을 붙잡지 않는다 — 창의 첫 줄은 표시만 베낀 것', () => {
    const before = heapMiB();
    const o = new HostExecOutput((t) => t);
    // 긴 줄은 따로 된 함수 안에서 만들어 넣는다 — 이 함수의 임시 칸이 그 줄을 쥐고 있지 않게
    const pushLong = (): void => o.push(`${'#'.repeat(32 << 20)}${LB()}`);
    pushLong();
    const mib = heapMiB() - before;
    for (const l of [...KEY_BODY.slice(0, 3), LE(), '뒤']) o.push(l);
    expect(o.text().split('\n').slice(1)).toEqual([WIN_MARK(5), '뒤']);
    expect(mib, `${Math.round(mib)}MiB`).toBeLessThan(4);
  });
});

describe('host_exec 인자의 비밀 값과 거부 글 (리드 결정 S5-31)', () => {
  const SECRET = 'zebraorchard4471quartzplum';

  it('비밀 값과 거부 목록에 함께 걸리는 명령은 비밀 값 거부다 — 거부 글의 걸린 조각에 비밀 값이 실리지 않는다 (프로브 zz-s5ti-hostexec-secret-order)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.ctx.redact.addSecret(SECRET, 'api-key');
    scriptedHost(e, {});
    const { turnId } = await liveMainTurn(e);
    const r = await hostExec(e, turnId, { command: `shutdown /s /c ${SECRET}` });
    expect(r).toEqual({ ok: false, code: 'forbidden', message: HOST_EXEC_SECRET_REFUSAL });
    expect(e.hostSpecs).toHaveLength(0);
  });

  it('cwd 경로에 비밀 값(형식으로 아는 GitHub 토큰)이 있으면 실행하지 않는다 — 결과·실행 기록·중복 캐시·활동 기록·일지에 원문이 없다 (프로브 zz-xs5-exec)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const secret = `ghp_${'Z9y8X7w6V5'.repeat(3)}abcdef`;
    const cwd = join(newDir(), secret);
    mkdirSync(cwd);
    scriptedHost(e, { lines: ['ok'] });
    const r = await hostExec(e, turnId, { command: 'dir', cwd, request_id: 'rq-cwd-secret', purpose: 'cwd 비밀 값' });
    expect(r).toEqual({ ok: false, code: 'forbidden', message: HOST_EXEC_CWD_SECRET_REFUSAL });
    expect(HOST_EXEC_CWD_SECRET_REFUSAL).toBe('작업 폴더 경로에 비밀 값(으로 보이는 글)이 들어 있어 실행하지 않았습니다');
    const cacheKey = toolCacheKey(MAIN_AGENT_ID, e.identity(turnId).seatGeneration ?? null, 'host_exec', 'rq-cwd-secret');
    const where = {
      result: JSON.stringify(r).includes(secret),
      execRecord: JSON.stringify(hostRecords(e)).includes(secret),
      toolCache: JSON.stringify(e.ctx.store.kv.get(cacheKey) ?? null).includes(secret),
      activity: JSON.stringify(e.ctx.store.activity.search({ limit: 500 })).includes(secret),
      journal: JSON.stringify(e.ctx.store.journal.query({ limit: 200 })).includes(secret),
    };
    expect(where).toEqual({ result: false, execRecord: false, toolCache: false, activity: false, journal: false });
    expect(e.hostSpecs).toEqual([]);
    expect(hostRecords(e)).toEqual([]);
  });

  it('cwd의 비밀 값 검사는 cwd 모양·있는지 검사보다 먼저다 — 상대 경로·없는 폴더여도 비밀 값 거부로 답하고 경로를 되풀이하지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.ctx.redact.addSecret(SECRET, 'api-key');
    const { turnId } = await liveMainTurn(e);
    for (const cwd of [`work\\${SECRET}`, join(newDir(), SECRET, 'nope'), `  ${join(newDir(), SECRET)}  `]) {
      expect(await hostExec(e, turnId, { command: 'dir', cwd })).toEqual({ ok: false, code: 'forbidden', message: HOST_EXEC_CWD_SECRET_REFUSAL });
    }
    expect(e.hostSpecs).toEqual([]);
  });

  it('처리기의 거부·오류 글은 CLI로 돌려주기 전에 가린다 — 원래 인자나 바깥 오류를 되풀이해도 비밀 값이 나가지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.ctx.redact.addSecret(SECRET, 'api-key');
    const { turnId } = await liveMainTurn(e);
    const spy = vi.spyOn(e.core.hostExec, 'run');
    spy.mockRejectedValueOnce(new BackendError('invalid', `cwd는 절대 경로여야 합니다: ${SECRET}`));
    const refused = await hostExec(e, turnId, { command: 'dir' });
    expect(refused).toEqual({ ok: false, code: 'invalid', message: 'cwd는 절대 경로여야 합니다: [가림:api-key]' });
    spy.mockRejectedValueOnce(new Error(`spawn failed: ${SECRET}`));
    const failed = await hostExec(e, turnId, { command: 'dir' });
    expect(failed).toEqual({ ok: false, code: 'error', message: '처리 중 오류: spawn failed: [가림:api-key]' });
    // 활동 기록에도 원문이 없다
    expect(JSON.stringify(e.ctx.store.activity.search({ limit: 500 }))).not.toContain(SECRET);
  });
});
