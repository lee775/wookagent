/**
 * `wook` — 외부 에이전트의 명령 (SERVER_DESIGN 4.5, 리드 결정 S7-5·S7-16·S7-19). 운영자가 등록한(wook-server agent add) 에이전트가 같은 PC의 에이전트 API
 * (`/agent/v1/*`, 루프백)로 메인 자리를 잡고, 일을 받고, 도구를 부르고, 턴을 마친다. 진입점은 wook.ts — 빌드하면 out/server/wook.mjs.
 *
 * 설정 (리드 결정 S7-5):
 * - 키: `WOOK_AGENT_KEY`, 없으면 `~/.wook/agent.json`의 `{"key": "wsk_…"}`. 그 파일은 지금 사용자만 읽어야 한다 — POSIX는 0600(그룹·다른 사용자 권한이 있으면
 *   쓰지 않는다), Windows는 ACL(지금 사용자·SYSTEM·Administrators 밖의 계정에 허용 항목이 있으면 쓰지 않는다 — 그 계정과 지우는 명령을 말한다, S7-19 C8).
 *   키를 받는 옵션은 없다(명령 줄은 다른 프로세스가 본다)
 * - 주소: `WOOK_AGENT_URL`(`http://127.0.0.1:<포트>/agent/v1` — 루프백만), 없으면 `<데이터 폴더>/agent-endpoint.json`. 데이터 폴더는 wook-server와 같이
 *   `--data-dir` → `WOOK_DATA_DIR` → 기본 위치. 파일이 가리키는 서버 프로세스가 끝났으면 연결하지 않는다(키를 그 포트로 보내지 않는다)
 * - 서버 확인 (S7-19 C3, 연결마다 — S7-22 K1): 그 파일에서 주소를 읽었으면, 키·임대 ID·턴 토큰은 그 TCP 연결에서 먼저 `POST hello`에 파일의 proof로 맞게 답한
 *   연결에만 쓴다 — 새 연결이면 그 연결에서 hello부터(기다리는 동안의 heartbeat, `work next --wait`의 다음 롱폴도). 200에 맞는 mac이 아니거나·없거나·5초 안에 끝나지
 *   않는 답이면 아무것도 보내지 않고 5. `work next --wait`는 기다리는 사이 그 파일이 없어지거나 runId·proof가 바뀌면 5로 멈춘다. pid나 proof가 없는 파일도 5.
 *   `WOOK_AGENT_URL`이면 `WOOK_AGENT_PROOF`를 함께 줄 때만 같은 확인을 한다(없으면 듣는 쪽을 확인하지 않는다)
 * - 상태: `~/.wook/state.json` — 임대(leaseId)와 받은 턴의 토큰(`wtt_…`). 그 사용자만 읽는 파일로 쓴다(POSIX 0600, Windows는 상속을 끊고 지금 사용자만).
 *   고치기 직전에 다시 읽고, 읽은 임대·턴이 그대로일 때만 바꾼다(다른 wook이 그사이 잡은 임대를 지우지 않게, S7-19 C6)
 *
 * 키·턴 토큰·임대 ID·proof는 어떤 출력(표준 출력·오류·기록)에도 내지 않는다 (리드 결정 S7-16 4). `work next`의 출력에서도 토큰을 뺀다 — 도구는 `wook tool`로 부른다.
 * 쓰임새 오류는 적은 값을 되풀이하지 않는다 (S3-39) — `--file`·`--json-file`·`--data-dir`로 받은 경로도 (S7-19 C12).
 *
 * 끝 코드 (S7-5): 0 됨 · 1 거부(403·404·400·413·429·500)·도구의 거부(200 ok:false)·이 PC에서의 거부(임대·턴 없음) · 2 쓰임새·설정 · 3 401 · 4 409(서버의 글) ·
 * 5 서버에 닿지 못함(끝난 서버를 가리키는 agent-endpoint.json, 서버임을 증명하지 못한 듣는 쪽, 닫힌 포트, 에이전트 API가 아닌 답 포함).
 *
 * 임대 (S7-16 3 (d)): 임대를 싣는 요청(heartbeat·work next·progress·done)만 임대를 늘린다. 그래서 오래 기다리는 `wook tool`·`wook screen capture`·
 * `wook work next --wait`는 state.json에 임대가 있으면 기다리는 동안 heartbeatMs마다 heartbeat를 보낸다. heartbeat가 실패해도 명령은 제 결과를 내고, 그 실패
 * (409 등)는 명령의 글 뒤에 `(heartbeat) …` 줄로 붙인다(명령이 성공했으면 표준 오류의 그 한 줄). `work done`은 서버가 턴의 마무리를 10초까지 기다리므로 요청
 * 상한을 60초로 둔다 (S7-16 6). 요청마다 전체 상한(조금씩 흘려 보내는 답도 끝낸다)과 답 크기 상한(화면 64MB, 그 밖 8MB)이 있다 (S7-19 C4).
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SeatHolderView } from '@shared/views';
import { prepareDataDir, resolveDataDir, restrictToCurrentUser } from '../server/dataDir';
import {
  AGENT_API_PREFIX,
  AGENT_ENDPOINT_VERSION,
  AGENT_PROOF_BYTES,
  TURN_TOKEN_HEADER,
  type ClaimReply,
  type FinishReply,
  type HeartbeatReply,
  type SeatReply,
  type StopReply,
  type WorkItem,
} from '../server/agentApiTypes';

/** 끝 코드 (리드 결정 S7-5) */
export const WOOK_EXIT = { ok: 0, refused: 1, usage: 2, unauthorized: 3, conflict: 4, unreachable: 5 } as const;

/** 일반 요청의 상한 */
const REQUEST_TIMEOUT_MS = 30_000;
/** work done (finish는 턴의 마무리를 10초까지 기다린다 — S7-16 6) */
export const DONE_TIMEOUT_MS = 60_000;
/** 롱폴 한 번의 상한 = 기다림 + 이만큼 */
const POLL_SLACK_MS = 30_000;
/** 긴급 정지 (종료 확인에 몇 초 걸린다) */
const STOP_TIMEOUT_MS = 60_000;
/** 서버 확인(hello) — 전체 상한·nonce·답 크기 (리드 결정 S7-19 C3) */
export const HELLO_TIMEOUT_MS = 5_000;
const HELLO_NONCE_BYTES = 32;
const HELLO_REPLY_MAX_BYTES = 4096;
/** 답 본문 상한 (리드 결정 S7-19 C4) — 화면 PNG는 64MB, 그 밖은 8MB. 넘으면 5 */
export const REPLY_MAX_BYTES = 8 * 1024 * 1024;
export const SCREEN_REPLY_MAX_BYTES = 64 * 1024 * 1024;
/** 롱폴이 기다림의 절반도 안 돼 204로 돌아오면 1초 쉰다 — 세 번 잇따르면 다른 wook이 같은 임대로 기다리는 것이다 (리드 결정 S7-19 C5) */
const EARLY_POLL_PAUSE_MS = 1000;
const EARLY_POLLS_MAX = 3;
/** 이보다 오래된 state.json 임시 파일은 끊긴 쓰기가 남긴 것이다 — 시작할 때 지운다 (리드 결정 S7-19 C6) */
const STALE_TMP_MS = 60_000;
const TURN_ID_RE = /^TN-\d{4,12}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const AGENT_KEY_FILE = 'agent.json';
export const STATE_FILE = 'state.json';
export const WOOK_HOME_DIR = '.wook';
export const AGENT_ENDPOINT_FILE = 'agent-endpoint.json';

export const WOOK_USAGE = `욱채 에이전트 명령 wook — 운영자가 등록한 외부 에이전트가 이 PC의 욱채 서버에서 메인 자리를 잡고 일을 받습니다

사용법
  wook seat claim                         메인 자리를 잡습니다 (운영자가 이 에이전트에게 배정했을 때만) — 임대를 ~/.wook/state.json에 둡니다
  wook seat status                        메인 자리와 이 에이전트의 임대를 봅니다 (임대를 늘리지 않습니다)
  wook seat heartbeat                     임대를 늘립니다 — 임대 시간 안에 되풀이하세요
  wook seat release [--note <글>]         메인 자리에서 스스로 물러납니다 (서버는 다른 보유자를 앉히지 않습니다)
  wook work next [--wait]                 일 하나를 받아 JSON으로 냅니다 — --wait면 일이 올 때까지 기다립니다
  wook work progress <턴 ID> --text <글>  진행 상황을 남깁니다
  wook work done <턴 ID> --file <파일> [--outcome completed|failed]
                                          턴을 마칩니다 — 그 파일의 글(UTF-8)이 마지막 답입니다
  wook tool <도구 이름> [--json '<인자 JSON 객체>' | --json-file <파일>]
                                          받은 턴의 토큰으로 도구를 부르고 결과를 JSON으로 냅니다 (--json-file은 UTF-8 JSON 파일)
  wook screen capture --out <파일.png>    서버 PC의 화면을 찍어(screen_capture) PNG로 저장합니다
  wook stop                               긴급 정지 (대표의 긴급 정지와 같습니다 — 풀기는 대표만)

설정
  키      환경 변수 WOOK_AGENT_KEY, 없으면 ~/.wook/agent.json의 {"key": "wsk_…"} — 지금 사용자만 읽는 파일이어야 합니다. 명령 줄로는 받지 않습니다
  주소    환경 변수 WOOK_AGENT_URL(http://127.0.0.1:<포트>/agent/v1), 없으면 <데이터 폴더>/agent-endpoint.json
          데이터 폴더는 --data-dir <폴더> → WOOK_DATA_DIR → 기본 위치 (wook-server와 같습니다)
          키를 보내기 전에 그 파일의 확인값(proof)으로 듣는 쪽이 그 서버인지 봅니다. WOOK_AGENT_URL이면 WOOK_AGENT_PROOF를 함께 줄 때만 봅니다
  상태    ~/.wook/state.json — 임대와 받은 턴의 토큰 (지금 사용자만 읽는 파일)

끝 코드  0 됨 · 1 거부·도구의 거부 · 2 쓰임새·설정 · 3 인증 실패(401) · 4 충돌(409 — 서버의 글) · 5 서버에 닿지 못함
`;

export interface WookIo {
  out(text: string): Promise<void>;
  err(text: string): Promise<void>;
  env: NodeJS.ProcessEnv;
  /** 홈 폴더 (~/.wook의 자리) */
  home: string;
  platform?: NodeJS.Platform;
  /** 시험: 파일 권한 좁히기 (기본 restrictToCurrentUser — Windows만 부른다) */
  restrictFile?: (path: string) => void;
  /** 시험: 일반 요청의 상한 (기본 30초) */
  requestTimeoutMs?: number;
}

type Cmd =
  | { kind: 'claim' }
  | { kind: 'status' }
  | { kind: 'heartbeat' }
  | { kind: 'release'; note: string | null }
  | { kind: 'next'; wait: boolean }
  | { kind: 'progress'; turnId: string; text: string }
  | { kind: 'done'; turnId: string; file: string; outcome: 'completed' | 'failed' }
  | { kind: 'tool'; name: string; args: Record<string, unknown> | null; argsFile: string | null }
  | { kind: 'capture'; out: string }
  | { kind: 'stop' };

export type WookPlan = { kind: 'help' } | { kind: 'error'; message: string } | { kind: 'run'; cmd: Cmd; dataDir: string | undefined };

// ───────────────────────── 인자 ─────────────────────────

const COMMAND_WORDS: ReadonlySet<string> = new Set(['seat', 'claim', 'status', 'heartbeat', 'release', 'work', 'next', 'progress', 'done', 'tool', 'screen', 'capture', 'stop', 'help']);

/** 옵션 → 쓰는 명령 (그 밖의 명령에 붙으면 쓰임새 오류) */
const OPTION_HOME: Readonly<Record<string, { kinds: readonly Cmd['kind'][]; where: string }>> = {
  wait: { kinds: ['next'], where: 'work next' },
  note: { kinds: ['release'], where: 'seat release' },
  text: { kinds: ['progress'], where: 'work progress' },
  file: { kinds: ['done'], where: 'work done' },
  outcome: { kinds: ['done'], where: 'work done' },
  json: { kinds: ['tool'], where: 'tool' },
  'json-file': { kinds: ['tool'], where: 'tool' },
  out: { kinds: ['capture'], where: 'screen capture' },
};

const usage = (message: string): WookPlan => ({ kind: 'error', message });

/** 알 수 없는 명령 — 앞에서부터 이어지는 명령 이름만 보이고 그 뒤는 값일 수 있어 보이지 않는다 (S3-39) */
function unknownCommand(words: readonly string[]): string {
  const shown: string[] = [];
  for (const w of words) {
    if (!COMMAND_WORDS.has(w)) break;
    shown.push(w);
  }
  if (shown.length === 0) return '알 수 없는 명령입니다 (적은 낱말은 값일 수 있어 보이지 않습니다)';
  return shown.length === words.length ? `알 수 없는 명령입니다: ${shown.join(' ')}` : `알 수 없는 명령입니다: ${shown.join(' ')} … (뒤의 낱말은 값일 수 있어 보이지 않습니다)`;
}

/** parseArgs의 거부 — 적은 옵션·값은 보이지 않는다 */
function optionError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return '모르는 옵션이 있습니다 (적은 옵션은 값일 수 있어 보이지 않습니다)';
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return '옵션의 값이 맞지 않습니다 — --note·--text·--file·--outcome·--json·--json-file·--out·--data-dir에는 값을 붙이고, --wait에는 값을 붙이지 않습니다 (적은 값은 보이지 않습니다)';
  return '인자를 알 수 없습니다 (적은 값은 보이지 않습니다)';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 인자 → 할 일. 던지지 않는다. 적은 값은 어떤 글에도 되풀이하지 않는다 */
export function parseWook(argv: readonly string[]): WookPlan {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        wait: { type: 'boolean' },
        note: { type: 'string' },
        text: { type: 'string' },
        file: { type: 'string' },
        outcome: { type: 'string' },
        json: { type: 'string' },
        'json-file': { type: 'string' },
        out: { type: 'string' },
        'data-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return usage(optionError(error));
  }
  const { values: v, positionals: p } = parsed;
  if (v.help || (p.length === 1 && p[0] === 'help')) return { kind: 'help' };
  const [a, b, c] = p;
  let cmd: Cmd | null = null;
  if (a === 'seat' && p.length === 2 && (b === 'claim' || b === 'status' || b === 'heartbeat')) cmd = { kind: b };
  else if (a === 'seat' && b === 'release' && p.length === 2) cmd = { kind: 'release', note: v.note?.trim() ? v.note.trim() : null };
  else if (a === 'work' && b === 'next' && p.length === 2) cmd = { kind: 'next', wait: v.wait === true };
  else if (a === 'work' && (b === 'progress' || b === 'done')) {
    if (p.length !== 3) return usage(`work ${b} 뒤에는 턴 ID 하나를 적습니다 — 예: wook work ${b === 'done' ? 'done TN-0001 --file answer.md' : 'progress TN-0001 --text "확인 중"'} (적은 낱말은 보이지 않습니다)`);
    const turnId = c!.trim();
    if (!TURN_ID_RE.test(turnId)) return usage('턴 ID는 TN-0001 꼴입니다 — wook work next가 낸 turnId를 적으세요 (적은 값은 보이지 않습니다)');
    if (b === 'progress') {
      if (!v.text?.trim()) return usage('work progress에는 --text <글>을 붙입니다');
      cmd = { kind: 'progress', turnId, text: v.text };
    } else {
      if (!v.file?.trim()) return usage('work done에는 --file <파일>을 붙입니다 — 그 파일의 글(UTF-8)이 이 턴의 마지막 답입니다');
      const outcome = v.outcome ?? 'completed';
      if (outcome !== 'completed' && outcome !== 'failed') return usage('--outcome은 completed 또는 failed입니다 (적은 값은 보이지 않습니다)');
      cmd = { kind: 'done', turnId, file: v.file, outcome };
    }
  } else if (a === 'tool') {
    if (p.length !== 2) return usage("tool 뒤에는 도구 이름 하나를 적습니다 — 예: wook tool get_overview --json '{}' (적은 낱말은 보이지 않습니다)");
    if (!TOOL_NAME_RE.test(b!)) return usage('도구 이름은 영문 소문자로 시작하는 소문자·숫자·밑줄입니다 — 예: get_overview (적은 이름은 보이지 않습니다)');
    if (v.json !== undefined && v['json-file'] !== undefined) return usage('--json과 --json-file은 함께 쓰지 않습니다 — 인자는 둘 가운데 하나로 줍니다');
    let args: unknown = {};
    if (v.json !== undefined) {
      try {
        args = JSON.parse(v.json) as unknown;
      } catch {
        return usage("--json의 글을 JSON으로 읽을 수 없습니다 — 예: --json '{}' (적은 값은 보이지 않습니다). PowerShell 5.1은 따옴표를 지워 넘기므로 --json-file <파일>을 쓰세요");
      }
      if (!isRecord(args)) return usage("--json은 JSON 객체여야 합니다 — 예: --json '{}' (적은 값은 보이지 않습니다)");
    }
    const argsFile = v['json-file'];
    if (argsFile !== undefined && !argsFile.trim()) return usage('--json-file에는 도구 인자 JSON 파일을 붙입니다');
    cmd = argsFile !== undefined ? { kind: 'tool', name: b!, args: null, argsFile } : { kind: 'tool', name: b!, args: args as Record<string, unknown>, argsFile: null };
  } else if (a === 'screen' && b === 'capture' && p.length === 2) {
    if (!v.out?.trim()) return usage('screen capture에는 --out <파일.png>를 붙입니다');
    cmd = { kind: 'capture', out: v.out };
  } else if (a === 'stop' && p.length === 1) cmd = { kind: 'stop' };
  if (!cmd) return usage(p.length === 0 ? '명령이 없습니다' : unknownCommand(p));
  for (const [name, home] of Object.entries(OPTION_HOME)) {
    if ((v as Record<string, unknown>)[name] !== undefined && !home.kinds.includes(cmd.kind)) return usage(`--${name} 옵션은 ${home.where}에만 씁니다`);
  }
  return { kind: 'run', cmd, dataDir: v['data-dir'] };
}

// ───────────────────────── 설정: 키·주소 ─────────────────────────

/** 이 PC에서 막은 일 — 끝 코드와 글 (값은 넣지 않는다) */
class Halt extends Error {
  constructor(
    readonly exit: number,
    message: string,
  ) {
    super(message);
  }
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const UTF8_HINT = 'UTF-8로 저장하세요 (PowerShell 5.1: Set-Content -Encoding utf8 — 그 셸의 > 와 Out-File은 UTF-16으로 씁니다, Python: open(…, "w", encoding="utf-8"))';

/**
 * 파일의 글을 UTF-8로만 읽는다 (리드 결정 S7-19 C2·C7): 앞의 UTF-8 BOM은 빼고, UTF-16 BOM이거나 UTF-8이 아니면 2(보내지 않는다 — U+FFFD로 바꿔 보내지 않는다).
 * 경로는 명령 줄에서 받은 값이라 글에 넣지 않는다 (S7-19 C12). what: '마지막 답 파일(--file)' 꼴 — 받침 있는 말로 끝난다(을·이)
 */
function readUtf8File(file: string, what: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(file));
  } catch (error) {
    throw new Halt(WOOK_EXIT.usage, `${what}을 읽지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? '알 수 없는 오류'}) — 경로를 확인하세요 (적은 값은 보이지 않습니다)`);
  }
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    throw new Halt(WOOK_EXIT.usage, `${what}이 UTF-16입니다 — ${UTF8_HINT}. 아무것도 보내지 않았습니다`);
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new Halt(WOOK_EXIT.usage, `${what}이 UTF-8이 아닙니다 — ${UTF8_HINT}. 아무것도 보내지 않았습니다`);
  }
  // NUL(U+0000)이 든 글은 답도 인자도 아니다 — BOM 없는 UTF-16(ASCII만 든)은 UTF-8로도 읽혀 글자마다 NUL이 끼므로 이것으로 잡는다 (S7-22 K2)
  if (text.includes(String.fromCharCode(0))) {
    throw new Halt(WOOK_EXIT.usage, `${what}에 NUL 글자(U+0000)가 있습니다 — BOM 없는 UTF-16일 수 있습니다. ${UTF8_HINT}. 아무것도 보내지 않았습니다`);
  }
  return text;
}

/** Windows의 시스템 명령 (PATH의 같은 이름 — Git의 whoami 등 — 이 아니라) */
const system32 = (env: NodeJS.ProcessEnv, exe: string): string => join(env['SystemRoot'] || env['windir'] || 'C:\\Windows', 'System32', exe);

/** SDDL의 허용 항목 하나 (계정과, 물려받은 항목인지) */
export interface SddlGrant {
  /** 'S-1-…' 또는 SDDL 줄임말('BU' 등) */
  sid: string;
  inherited: boolean;
}

/**
 * 그 SDDL의 허용 항목 가운데 지금 사용자·SYSTEM·Administrators 밖의 계정 (DACL의 차례대로, 상속만 하는 IO 항목은 파일에 듣지 않아 뺀다). DACL이 없거나
 * NULL DACL이면 null — 누구에게나 열려 있다
 */
export function sddlOthers(sddl: string, me: string): SddlGrant[] | null {
  const dacl = /D:([^\r\n]*)/.exec(sddl)?.[1];
  if (dacl === undefined || /^NO_ACCESS_CONTROL/.test(dacl)) return null;
  const allowed = new Set([me.toUpperCase(), 'SY', 'BA', 'S-1-5-18', 'S-1-5-32-544']);
  const out: SddlGrant[] = [];
  for (const m of dacl.matchAll(/\(([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*)\)/g)) {
    const [, type, flags, , , , sid] = m;
    if (type !== 'A' && type !== 'OA') continue;
    if (/IO/.test(flags!)) continue;
    if (!allowed.has(sid!.toUpperCase())) out.push({ sid: sid!, inherited: /ID/.test(flags!) });
  }
  return out;
}

/** 그 SDDL이 지금 사용자·SYSTEM·Administrators 밖의 계정에도 열려 있는지 */
export function sddlOpenToOthers(sddl: string, me: string): boolean {
  const others = sddlOthers(sddl, me);
  return others === null || others.length > 0;
}

/** SDDL 줄임말 → SID와 이름 (icacls가 받는 꼴로 지우는 명령을 만들 때) */
const SDDL_ALIAS: Readonly<Record<string, readonly [string, string]>> = {
  WD: ['S-1-1-0', 'Everyone'],
  AU: ['S-1-5-11', 'NT AUTHORITY\\Authenticated Users'],
  BU: ['S-1-5-32-545', 'BUILTIN\\Users'],
  BG: ['S-1-5-32-546', 'BUILTIN\\Guests'],
  PU: ['S-1-5-32-547', 'BUILTIN\\Power Users'],
  RD: ['S-1-5-32-555', 'BUILTIN\\Remote Desktop Users'],
  IU: ['S-1-5-4', 'NT AUTHORITY\\INTERACTIVE'],
  NU: ['S-1-5-2', 'NT AUTHORITY\\NETWORK'],
  AN: ['S-1-5-7', 'NT AUTHORITY\\ANONYMOUS LOGON'],
  LS: ['S-1-5-19', 'NT AUTHORITY\\LOCAL SERVICE'],
  NS: ['S-1-5-20', 'NT AUTHORITY\\NETWORK SERVICE'],
  CO: ['S-1-3-0', 'CREATOR OWNER'],
  OW: ['S-1-3-4', 'OWNER RIGHTS'],
  AC: ['S-1-15-2-1', 'ALL APPLICATION PACKAGES'],
};

/**
 * `icacls <이름>`(파일이 있는 폴더에서 이름만 넘긴 것)의 보통 출력 → DACL의 차례대로 항목마다 계정 이름 하나. 첫 줄은 '<이름> <계정>:(…)', 다음 줄들은
 * 들여 쓴 '<계정>:(…)'이다. 첫 줄이 그 이름으로 시작하지 않으면 빈 목록(맞춰 볼 수 없다)
 */
export function icaclsNames(listing: string, shown: string): string[] {
  const lines = listing.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0 || !lines[first]!.startsWith(`${shown} `)) return [];
  const names: string[] = [];
  for (let i = first; i < lines.length; i++) {
    const line = i === first ? lines[i]!.slice(shown.length) : lines[i]!;
    if (!line.trim()) break;
    const at = line.indexOf(':(');
    if (at < 0) return [];
    names.push(line.slice(0, at).trim());
  }
  return names;
}

const isSid = (s: string): boolean => /^S-1-[0-9-]+$/i.test(s);

/**
 * Windows의 거부 글 (리드 결정 S7-19 C8): 열린 계정마다 이름(아는 것만)과 SID, 물려받은 권한인지 따로 준 권한인지 말하고, 물려받은 권한이 있으면 상속을 끊는
 * 명령을, 따로 준 권한마다 그것을 지우는 명령을 낸다 — 그 명령들을 차례로 하면 지금 사용자만 남는다
 */
export function aclFixText(file: string, others: SddlGrant[] | null, names: ReadonlyMap<string, string>, principal: string): string {
  const cut = `icacls "${file}" /inheritance:r /grant:r "${principal}:F"`;
  if (others === null) return `권한(ACL) 목록이 없어 누구에게나 열려 있습니다. 지금 사용자만 읽게 좁히세요:\n  ${cut}`;
  const accounts: string[] = [];
  const removes: string[] = [];
  let inherited = false;
  for (const g of others) {
    const alias = SDDL_ALIAS[g.sid.toUpperCase()];
    const sid = alias ? alias[0] : g.sid;
    const name = names.get(g.sid.toUpperCase()) ?? alias?.[1] ?? null;
    const account = `${name ? `${name} (${sid})` : sid} — ${g.inherited ? '물려받은 권한' : '따로 준 권한'}`;
    if (!accounts.includes(account)) accounts.push(account);
    if (g.inherited) {
      inherited = true;
      continue;
    }
    const remove = isSid(sid) ? `icacls "${file}" /remove:g "*${sid}"` : `icacls "${file}"로 그 계정(${sid})의 이름을 보고 icacls "${file}" /remove:g "<그 이름>"`;
    if (!removes.includes(remove)) removes.push(remove);
  }
  const steps = [...(inherited ? [cut] : []), ...removes];
  return `열린 계정: ${accounts.join(', ')}. 지금 사용자만 읽게 좁히세요:\n${steps.map((s) => `  ${s}`).join('\n')}`;
}

/** 키 파일을 지금 사용자만 읽는지 — 아니면 그 까닭 (고치는 법 포함). 확인하지 못해도 쓰지 않는다 */
function keyFileProblem(file: string, io: WookIo): string | null {
  const platform = io.platform ?? process.platform;
  if (platform !== 'win32') {
    const mode = statSync(file).mode;
    return mode & 0o077 ? `${file}을(를) 다른 사용자도 읽을 수 있어 키를 쓰지 않습니다 — chmod 600 "${file}"로 지금 사용자만 읽게 하세요` : null;
  }
  const principal = `${io.env['USERDOMAIN'] ? `${io.env['USERDOMAIN']}\\` : ''}${io.env['USERNAME'] ?? '<사용자>'}`;
  const cut = `icacls "${file}" /inheritance:r /grant:r "${principal}:F"`;
  const out = join(tmpdir(), `wook-acl-${process.pid}-${randomBytes(4).toString('hex')}.txt`);
  let sddl: string;
  let me: string | undefined;
  try {
    execFileSync(system32(io.env, 'icacls.exe'), [file, '/save', out], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    sddl = readFileSync(out).toString('utf16le');
    me = /"(S-1-[0-9-]+)"/.exec(execFileSync(system32(io.env, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 15_000 }).toString('latin1'))?.[1];
  } catch {
    return `${file}의 권한(ACL)을 확인하지 못해 키를 쓰지 않습니다 — WOOK_AGENT_KEY를 쓰거나, 지금 사용자만 읽게 좁힌 뒤 다시 하세요: ${cut} (다른 계정에 따로 준 권한이 있으면 /remove:g로 지웁니다)`;
  } finally {
    try {
      if (existsSync(out)) unlinkSync(out);
    } catch {
      // 임시 파일 (권한 정보만 있다)
    }
  }
  if (!me) return `${file}의 권한(ACL)을 확인하지 못해 키를 쓰지 않습니다 (지금 사용자를 알 수 없음) — WOOK_AGENT_KEY를 쓰세요`;
  const others = sddlOthers(sddl, me);
  if (others !== null && others.length === 0) return null;
  // 계정 이름 — icacls의 보통 출력(DACL의 차례)과 SDDL의 항목을 차례로 맞춘다. 수가 다르거나 ASCII가 아닌 이름(콘솔 코드 페이지)이면 SID만
  const names = new Map<string, string>();
  try {
    const listing = execFileSync(system32(io.env, 'icacls.exe'), [basename(file)], { cwd: dirname(file), windowsHide: true, timeout: 15_000 }).toString('latin1');
    const found = icaclsNames(listing, basename(file));
    const aces = [...(/D:([^\r\n]*)/.exec(sddl)?.[1] ?? '').matchAll(/\(([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*)\)/g)];
    if (found.length === aces.length) {
      aces.forEach((m, i) => {
        const sid = m[6]!.toUpperCase();
        if (/^[\x20-\x7e]+$/.test(found[i]!) && !names.has(sid)) names.set(sid, found[i]!);
      });
    }
  } catch {
    // 이름 없이 SID만
  }
  return `${file}의 권한(ACL)이 지금 사용자 밖의 계정에도 열려 있어 키를 쓰지 않습니다 — ${aclFixText(file, others, names, principal)}`;
}

/** 키: WOOK_AGENT_KEY → ~/.wook/agent.json (리드 결정 S7-5). 글에는 키를 넣지 않는다 */
function readKey(io: WookIo): string {
  const fromEnv = io.env['WOOK_AGENT_KEY']?.trim();
  if (fromEnv) return fromEnv;
  const file = join(io.home, WOOK_HOME_DIR, AGENT_KEY_FILE);
  if (!existsSync(file)) {
    throw new Halt(
      WOOK_EXIT.usage,
      `에이전트 키가 없습니다 — 환경 변수 WOOK_AGENT_KEY나 지금 사용자만 읽는 ${file}({"key": "wsk_…"})에 두세요. 키는 서버 PC의 운영자가 wook-server agent add로 받습니다 (명령 줄로는 받지 않습니다)`,
    );
  }
  const problem = keyFileProblem(file, io);
  if (problem) throw new Halt(WOOK_EXIT.usage, problem);
  let key: unknown;
  try {
    key = (JSON.parse(stripBom(readFileSync(file, 'utf8'))) as { key?: unknown }).key;
  } catch {
    key = undefined;
  }
  if (typeof key !== 'string' || !key.trim()) throw new Halt(WOOK_EXIT.usage, `${file}을(를) 읽을 수 없습니다 — {"key": "wsk_…"} 꼴의 JSON이어야 합니다 (내용은 보이지 않습니다)`);
  return key.trim();
}

/** 에이전트 API 주소 — 이 PC의 루프백 `http://<루프백>:<포트>/agent/v1`만 (아니면 null) */
export function loopbackApi(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !u.port) return null;
  if (u.pathname.replace(/\/+$/, '') !== AGENT_API_PREFIX) return null;
  return `${u.protocol}//${u.host}${AGENT_API_PREFIX}`;
}

/** 확인값 — '=' 없는 base64url로 32바이트(정규 꼴). 아니면 null */
function proofBytes(v: unknown): Buffer | null {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  const b = Buffer.from(v, 'base64url');
  return b.length === AGENT_PROOF_BYTES && b.toString('base64url') === v ? b : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 주소와 서버 확인값 — proof가 null이면 듣는 쪽을 확인하지 않는다(WOOK_AGENT_URL만 준 때) */
interface Endpoint {
  api: string;
  proof: Buffer | null;
  source: 'file' | 'env';
  /** 파일에서 읽었으면 그 파일과 읽은 때의 runId·proof (next --wait의 둘째 지킴 — S7-22 K1) */
  file: { path: string; where: string; runId: string; proof: string } | null;
}

/** 주소: WOOK_AGENT_URL(+ WOOK_AGENT_PROOF) → <데이터 폴더>/agent-endpoint.json (리드 결정 S7-5·S7-19 C3) */
function resolveApi(dataDirFlag: string | undefined, io: WookIo): Endpoint {
  const url = io.env['WOOK_AGENT_URL']?.trim();
  if (url) {
    const api = loopbackApi(url);
    if (!api) throw new Halt(WOOK_EXIT.usage, 'WOOK_AGENT_URL은 이 PC의 루프백 주소 http://127.0.0.1:<포트>/agent/v1 꼴이어야 합니다 — 키를 다른 곳으로 보내지 않습니다 (적은 값은 보이지 않습니다)');
    const given = io.env['WOOK_AGENT_PROOF']?.trim();
    if (!given) return { api, proof: null, source: 'env', file: null };
    const proof = proofBytes(given);
    if (!proof) throw new Halt(WOOK_EXIT.usage, 'WOOK_AGENT_PROOF는 agent-endpoint.json의 proof 값(43자 base64url)이어야 합니다 (적은 값은 보이지 않습니다)');
    return { api, proof, source: 'env', file: null };
  }
  const dataDir = resolveDataDir(dataDirFlag, io.env, io.platform ?? process.platform);
  const file = join(dataDir, AGENT_ENDPOINT_FILE);
  // --data-dir로 받은 폴더는 글에 넣지 않는다 — 명령 줄의 값이다 (S7-19 C12). WOOK_DATA_DIR·기본 위치면 그 폴더를 말한다
  const fromFlag = !!dataDirFlag?.trim();
  const folder = fromFlag ? '--data-dir로 준 데이터 폴더' : `이 데이터 폴더(${dataDir})`;
  const where = fromFlag ? `--data-dir로 준 데이터 폴더의 ${AGENT_ENDPOINT_FILE}` : file;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Halt(WOOK_EXIT.unreachable, `${folder}로 실행 중인 욱채 서버가 없습니다 (${AGENT_ENDPOINT_FILE} 없음) — 서버가 떠 있는지, --data-dir·WOOK_DATA_DIR이 서버와 같은지 보세요`);
    }
    throw new Halt(WOOK_EXIT.unreachable, `${where}을(를) 읽지 못했습니다 (${code ?? '알 수 없는 오류'})`);
  }
  let e: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(stripBom(text)) as unknown;
    e = isRecord(j) ? j : null;
  } catch {
    e = null;
  }
  const api = e && e['version'] === AGENT_ENDPOINT_VERSION && typeof e['agentApi'] === 'string' ? loopbackApi(e['agentApi']) : null;
  if (!api) throw new Halt(WOOK_EXIT.unreachable, `${where}의 내용을 알 수 없습니다 — 서버를 다시 시작하면 새로 씁니다`);
  // 먼저 값싼 확인 — 그 파일을 쓴 서버의 pid가 살아 있는지 (S7-18 2). 그 다음 첫 키 요청 전에 hello로 듣는 쪽을 확인한다 (S7-19 C3)
  const pid = e!['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Halt(WOOK_EXIT.unreachable, `${where}에 서버 pid가 없습니다 — 지금 판의 욱채 서버가 쓴 파일이 아닙니다. 서버를 다시 시작하면 새로 씁니다 (키를 보내지 않았습니다)`);
  }
  const proof = proofBytes(e!['proof']);
  if (!proof) throw new Halt(WOOK_EXIT.unreachable, `${where}에 서버 확인값(proof)이 없거나 꼴이 틀립니다 — 지금 판의 욱채 서버가 쓴 파일이 아닙니다. 서버를 다시 시작하면 새로 씁니다 (키를 보내지 않았습니다)`);
  if (!processAlive(pid)) {
    throw new Halt(WOOK_EXIT.unreachable, `${where}이(가) 가리키는 서버(pid ${pid})가 끝났습니다 — 서버를 다시 띄우면 새 주소를 씁니다 (키를 그 포트로 보내지 않았습니다)`);
  }
  return { api, proof, source: 'file', file: { path: file, where, runId: typeof e!['runId'] === 'string' ? e!['runId'] : '', proof: String(e!['proof']) } };
}

/**
 * next --wait의 둘째 지킴 (리드 결정 S7-22 K1): 기다리는 사이 agent-endpoint.json이 없어졌거나 그 runId·proof가 바뀌었으면(서버가 끝났거나 다시 시작했다) 5로 멈춘다 —
 * 다음 롱폴을 보내지 않는다. 주소를 그 파일에서 읽었을 때만 본다
 */
function endpointStill(ctx: Ctx): void {
  const f = ctx.endpointFile;
  if (!f) return;
  let e: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(stripBom(readFileSync(f.path, 'utf8'))) as unknown;
    e = isRecord(j) ? j : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Halt(WOOK_EXIT.unreachable, `서버가 끝났습니다 (${f.where} 없음) — 기다리기를 멈췄습니다. 키를 보내지 않았습니다 — 서버가 다시 뜨면 wook seat claim부터 하세요`);
    }
    e = null;
  }
  if (!e || e['runId'] !== f.runId || e['proof'] !== f.proof) {
    throw new Halt(WOOK_EXIT.unreachable, `서버가 다시 시작했거나 바뀌었습니다 (${f.where}의 runId·proof가 바뀜) — 기다리기를 멈췄습니다. 키를 보내지 않았습니다 — wook seat claim부터 다시 하세요`);
  }
}

// ───────────────────────── 상태 파일 (~/.wook/state.json) ─────────────────────────

interface WookState {
  version: 1;
  /** 임대를 받은 에이전트 API 주소 */
  api: string;
  agentId: string;
  label: string;
  generation: number;
  leaseId: string;
  leaseMs: number;
  heartbeatMs: number;
  pollMaxMs: number;
  claimedAt: string;
  /** 받은 턴 (토큰은 그 턴의 도구·화면에 쓴다) */
  turn: { turnId: string; token: string; generation: number; deadlineAt: string } | null;
}

function readState(path: string): WookState | null {
  try {
    const j = JSON.parse(stripBom(readFileSync(path, 'utf8'))) as unknown;
    if (!isRecord(j) || j['version'] !== 1 || typeof j['leaseId'] !== 'string' || !j['leaseId']) return null;
    const s = j as unknown as WookState;
    const t = s.turn;
    return { ...s, heartbeatMs: Number(s.heartbeatMs) || 15_000, turn: isRecord(t) && typeof t['turnId'] === 'string' && typeof t['token'] === 'string' ? t : null };
  } catch {
    return null;
  }
}

/** 끊긴 쓰기가 남긴 state.json 임시 파일(임대·토큰이 들었을 수 있다)을 지운다 — 1분 넘은 것만(다른 wook이 막 쓰는 것은 두고) (S7-19 C6) */
function sweepStaleTmp(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(`${STATE_FILE}.tmp-`)) continue;
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > STALE_TMP_MS) unlinkSync(p);
    } catch {
      // 그사이 없어졌거나 지우지 못함 — 다음에
    }
  }
}

/**
 * 그 사용자만 읽는 파일로 쓴다 — 임시 파일의 권한부터 좁힌 뒤 내용을 쓰고 제자리로 옮긴다 (서버의 writePrivateFile과 같은 순서). 좁혔으면 true —
 * 좁히지 못했으면(Windows) 경고를 내고 false
 */
async function writePrivate(target: string, content: string | Buffer, io: WookIo): Promise<boolean> {
  const platform = io.platform ?? process.platform;
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  let restricted = true;
  try {
    if (platform === 'win32') {
      closeSync(openSync(tmp, 'wx'));
      try {
        (io.restrictFile ?? ((p: string) => restrictToCurrentUser(p, 'file')))(tmp);
      } catch {
        restricted = false;
        await io.err(`경고: ${target}의 권한을 지금 사용자만으로 좁히지 못했습니다 (그 폴더의 권한을 따릅니다)\n`);
      }
      writeFileSync(tmp, content);
    } else {
      writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
    }
    renameSync(tmp, target);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 임시 파일 정리 실패
    }
    throw error;
  }
  return restricted;
}

/** state.json을 쓴다(null이면 지운다) — 지금 사용자만으로 좁혔으면 true */
async function saveState(ctx: Ctx, s: WookState | null): Promise<boolean> {
  if (s === null) {
    if (existsSync(ctx.statePath)) unlinkSync(ctx.statePath);
    return true;
  }
  // ~/.wook가 없으면 그 사용자만 쓰게 만든다 (데이터 폴더와 같은 방식 — POSIX 0700, Windows ACL)
  prepareDataDir(dirname(ctx.statePath), ctx.io.platform ?? process.platform);
  return writePrivate(ctx.statePath, `${JSON.stringify(s, null, 2)}\n`, ctx.io);
}

const BACKSLASH = String.fromCharCode(92);

/**
 * 표준 출력의 JSON (`work next`·`tool`) — 사람이 읽게 들여 쓰고, ASCII만 낸다 (리드 후속 11-11 — 운영자 명령 `--json`과 같다, S7-19 C1): ASCII 밖의 글자는 모두
 * 유니코드 이스케이프(백슬래시 u와 네 자리)로 적는다. Windows PowerShell 5.1은 다른 프로그램의 출력을 콘솔 코드 페이지(949)로 읽어 UTF-8 한글이 섞이면 JSON이 깨지지만,
 * ASCII는 어느 코드 페이지로 읽어도 같고 어떤 JSON 파서든 원래 글로 읽는다. 들여쓰기의 줄바꿈은 그대로 둔다(JSON.stringify는 글 안의 제어 글자를 이미 적어 둔다)
 */
export function asciiJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2).replace(/[^ -~]/g, (c) => (c === '\n' ? c : `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return `${text}\n`;
}

const sameTurn = (a: WookState['turn'], b: WookState['turn']): boolean => (a?.turnId ?? null) === (b?.turnId ?? null);

// ───────────────────────── HTTP ─────────────────────────

interface Ctx {
  io: WookIo;
  api: string;
  key: string;
  statePath: string;
  /** 서버 확인값 — null이면 듣는 쪽을 확인하지 않는다 */
  proof: Buffer | null;
  source: Endpoint['source'];
  /** 주소를 파일에서 읽었으면 그 파일 (next --wait의 둘째 지킴) */
  endpointFile: Endpoint['file'];
  /** 에이전트 API로 가는 연결 */
  link: Link;
  /** 어느 연결에서든 확인이 한 번은 끝났다(또는 할 것이 없다) — 그 전에는 heartbeat 시계가 아무것도 하지 않는다 */
  proven: boolean;
}

/**
 * 에이전트 API로 가는 연결 (리드 결정 S7-22 K1 — 확인은 프로세스마다가 아니라 연결마다): keep-alive Agent 하나로 연결을 다시 쓰고, 그 연결에서 먼저 hello에 맞게 답한
 * 소켓만 기억한다. 키·임대 ID·턴 토큰은 그 소켓에만 쓴다 — 새 연결이면 그 연결에서 hello부터 한다. 주 요청과 기다리는 동안의 heartbeat가 함께 갈 수 있게 연결은 넷까지
 */
interface Link {
  agent: Agent;
  proved: WeakSet<Socket>;
}

const newLink = (): Link => ({ agent: new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 }), proved: new WeakSet<Socket>() });

/** 키를 싣는 요청이 증명한 연결을 얻으려 해 보는 횟수 (그 사이 서버가 쉬던 연결을 닫으면 새 연결을 증명한다) */
const KEYED_ATTEMPTS = 4;

interface Reply {
  status: number;
  type: string;
  body: Buffer;
  json: unknown;
}

/** network: reused = 쉬던 연결을 다시 썼다, answered = 답 머리를 받았다 (둘이 참·거짓이면 서버가 쉬던 연결을 막 닫은 것 — 다시 해도 된다) */
type SendFail = { kind: 'network'; code: string; reused: boolean; answered: boolean } | { kind: 'timeout'; ms: number } | { kind: 'too_large'; max: number };

class SendError extends Error {
  constructor(readonly fail: SendFail) {
    super('send');
  }
}

/** HTTP 한 번의 그 길 — gate: 받은 소켓에 머리·본문을 써도 되는지(아니면 아무것도 쓰지 않고 'unproved'), vouch: 답을 다 받았을 때 그 소켓을 증명한 것으로 적을지 */
interface SendOpts {
  agent: Agent;
  gate?: (socket: Socket) => boolean;
  vouch?: (status: number, body: Buffer, socket: Socket) => void;
}

/**
 * HTTP 한 번. 상한 둘: 쉬는 시간(idle)과 전체 시간(조금씩 흘려 보내는 상대도 끝낸다, S7-19 C4), 그리고 답 본문의 크기. 넘거나 닿지 못하면 SendError — 머리·본문은
 * 넣지 않는다. 요청을 만든 뒤 소켓을 받을 때까지(socket 이벤트) end()를 부르지 않는다 — Node는 end()·write()·flushHeaders() 전에는 그 소켓에 아무것도 쓰지 않으므로,
 * gate가 그 소켓을 거부하면 아무것도 쓰지 않은 채 요청(과 새 연결)을 버린다 (S7-22 K1)
 */
function send(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, data: Buffer | null, timeoutMs: number, maxBytes: number, o: SendOpts): Promise<Omit<Reply, 'json'> | 'unproved'> {
  return new Promise((resolveReply, reject) => {
    let settled = false;
    let answered = false;
    let sock: Socket | null = null;
    let deadline: NodeJS.Timeout | null = null;
    const settle = (f: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      f();
    };
    const fail = (why: SendFail): void => settle(() => reject(new SendError(why)));
    const req = request(url, { method, agent: o.agent, headers }, (res) => {
      answered = true;
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        fail({ kind: 'too_large', max: maxBytes });
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) {
          fail({ kind: 'too_large', max: maxBytes });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('error', () => fail({ kind: 'network', code: '답을 받다 끊김', reused: req.reusedSocket, answered: true }));
      res.on('close', () => {
        if (!res.complete) fail({ kind: 'network', code: '답을 받다 끊김', reused: req.reusedSocket, answered: true });
      });
      res.on('end', () => {
        if (settled) return;
        const body = Buffer.concat(chunks);
        // 증명한 소켓은 Node가 그 소켓을 다음 요청에 내주기 전에(같은 틱에) 적는다
        if (o.vouch && sock) o.vouch(res.statusCode ?? 0, body, sock);
        settle(() => resolveReply({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
      });
    });
    deadline = setTimeout(() => {
      fail({ kind: 'timeout', ms: timeoutMs });
      req.destroy();
    }, timeoutMs);
    req.setTimeout(timeoutMs, () => {
      fail({ kind: 'timeout', ms: timeoutMs });
      req.destroy();
    });
    req.on('error', (error) => fail({ kind: 'network', code: (error as NodeJS.ErrnoException).code ?? '연결 오류', reused: req.reusedSocket, answered }));
    req.once('socket', (socket: Socket) => {
      if (settled) return;
      sock = socket;
      if (o.gate && !o.gate(socket)) {
        // 증명하지 않은 연결 — 머리도 본문도 쓰지 않고 버린다
        settle(() => resolveReply('unproved'));
        req.destroy();
        return;
      }
      req.end(data ?? undefined);
    });
  });
}

const parseJson = (body: Buffer): unknown => {
  try {
    return body.length ? (JSON.parse(body.toString('utf8')) as unknown) : null;
  } catch {
    return null;
  }
};

const unreachable = (api: string, why: string): Halt => new Halt(WOOK_EXIT.unreachable, `욱채 서버의 에이전트 API(${api})에 닿지 못했습니다 (${why}) — 서버가 떠 있는지, 다시 시작해 주소가 바뀌지 않았는지 보세요`);

/** 키를 실은 요청에 에이전트 API가 아닌 답이 왔다 — 키가 그 프로그램에 갔을 수 있다 (리드 결정 S7-19 C3) */
const notApi = (detail: string): string =>
  `그 주소에서 답한 쪽이 욱채 에이전트 API가 아닙니다 (${detail}) — 키를 그 프로그램에 보냈을 수 있습니다: 운영자에게 이 에이전트를 폐기(wook-server agent revoke)하고 새로 등록(agent add)해 달라고 하세요. 서버가 끝났거나 다시 시작해 주소가 바뀌었을 수도 있습니다`;

/** 듣는 쪽이 그 서버임을 증명하지 못했다 — 키는 보내지 않았다 */
function unproven(ctx: Pick<Ctx, 'api' | 'source'>, why: string): Halt {
  return new Halt(
    WOOK_EXIT.unreachable,
    ctx.source === 'file'
      ? `그 주소(${ctx.api})에서 듣는 쪽이 agent-endpoint.json을 쓴 욱채 서버임을 증명하지 못했습니다 (${why}) — 키를 보내지 않았습니다. 끝난 서버가 남긴 파일의 포트를 다른 프로그램이 쓰고 있을 수 있습니다 (서버를 다시 띄우면 새로 씁니다)`
      : `그 주소(${ctx.api})에서 듣는 쪽이 WOOK_AGENT_PROOF를 아는 욱채 서버임을 증명하지 못했습니다 (${why}) — 키를 보내지 않았습니다. 서버가 다시 시작했으면 WOOK_AGENT_URL과 WOOK_AGENT_PROOF를 새 agent-endpoint.json의 agentApi·proof로 바꾸세요`,
  );
}

/** hello의 답이 그 nonce에 맞는 증명인지 — 맞으면 null, 아니면 그 까닭. 200에 맞는 mac이 아니면 모두 '증명하지 못함'이다(429도 — 이 서버는 hello에 429로 답하지 않는다, S7-22 K3) */
function helloProblem(status: number, body: Buffer, proof: Buffer, nonce: Buffer): string | null {
  const j = parseJson(body);
  if (status !== 200 || !isRecord(j) || j['ok'] !== true || typeof j['mac'] !== 'string') return status === 200 ? '답의 모양이 다름' : `HTTP ${status}`;
  const got = Buffer.from(j['mac'], 'base64url');
  const want = createHmac('sha256', proof).update(nonce).digest();
  return got.length === want.length && timingSafeEqual(got, want) ? null : '확인값이 맞지 않음';
}

/**
 * 서버 확인 한 번 — 연결 하나를 증명한다 (리드 결정 S7-19 C3, S7-22 K1): 새 32바이트 nonce를 hello로 보내고 답의 mac을 HMAC-SHA256(proof, nonce)과 timingSafeEqual로
 * 견준다. 맞으면 그 답이 온 소켓을 증명한 것으로 적는다(그 소켓이 다음 요청에 쓰이기 전에). 키·임대 ID·턴 토큰은 싣지 않는다. 전체 5초. 200에 맞는 mac이 아니면 5
 */
async function prove(ctx: Ctx): Promise<void> {
  const proof = ctx.proof!;
  const nonce = randomBytes(HELLO_NONCE_BYTES);
  const data = Buffer.from(JSON.stringify({ nonce: nonce.toString('base64url') }), 'utf8');
  let raw: Omit<Reply, 'json'> | 'unproved';
  try {
    raw = await send(new URL(`${ctx.api}/hello`), 'POST', { 'Content-Type': 'application/json', 'Content-Length': String(data.length) }, data, HELLO_TIMEOUT_MS, HELLO_REPLY_MAX_BYTES, {
      agent: ctx.link.agent,
      vouch: (status, body, socket) => {
        if (helloProblem(status, body, proof, nonce) === null) ctx.link.proved.add(socket);
      },
    });
  } catch (error) {
    if (!(error instanceof SendError)) throw error;
    if (error.fail.kind === 'network') throw unreachable(ctx.api, error.fail.code);
    throw unproven(ctx, error.fail.kind === 'timeout' ? `${HELLO_TIMEOUT_MS / 1000}초 안에 답이 끝나지 않음` : '답이 너무 큼');
  }
  if (raw === 'unproved') throw unproven(ctx, '연결을 얻지 못함');
  const problem = helloProblem(raw.status, raw.body, proof, nonce);
  if (problem) throw unproven(ctx, problem);
  ctx.proven = true;
}

/** 쉬고 있는 증명한 연결이 있는지 (있으면 Agent가 그것을 내준다) */
function freeProved(ctx: Ctx): boolean {
  return Object.values(ctx.link.agent.freeSockets).some((list) => (list ?? []).some((s) => ctx.link.proved.has(s) && !s.destroyed));
}

/**
 * 키(와 임대 ID·턴 토큰)를 싣는 HTTP 한 번 (리드 결정 S7-22 K1): 쉬는 증명한 연결이 없으면 먼저 새 연결을 증명하고, 요청이 받은 소켓이 증명한 소켓일 때만 쓴다 — 아니면
 * 아무것도 쓰지 않고 다시 증명한다. 쉬던 연결을 서버가 막 닫아 답 전에 끊기면(keep-alive 재사용의 ECONNRESET) 그 연결은 증명한 연결이었으므로 키는 그쪽으로만 갔고,
 * 새 연결을 증명한 뒤 다시 보낸다. Node의 http는 스스로 다시 보내지 않는다 — 다시 보내는 것은 이 고리뿐이고, 늘 gate를 지난다. 시간 차(hello와 요청 사이)에는 기대지 않는다
 */
async function keyed(ctx: Ctx, url: URL, method: 'GET' | 'POST', headers: Record<string, string>, data: Buffer | null, timeoutMs: number, maxBytes: number): Promise<Omit<Reply, 'json'>> {
  if (!ctx.proof) {
    // WOOK_AGENT_URL만 — 듣는 쪽을 확인하지 않는다 (안내서가 그렇게 말한다)
    return (await send(url, method, headers, data, timeoutMs, maxBytes, { agent: ctx.link.agent })) as Omit<Reply, 'json'>;
  }
  for (let attempt = 0; attempt < KEYED_ATTEMPTS; attempt++) {
    if (!freeProved(ctx)) await prove(ctx);
    let r: Omit<Reply, 'json'> | 'unproved';
    try {
      r = await send(url, method, headers, data, timeoutMs, maxBytes, { agent: ctx.link.agent, gate: (s) => ctx.link.proved.has(s) });
    } catch (error) {
      if (error instanceof SendError && error.fail.kind === 'network' && error.fail.reused && !error.fail.answered) continue;
      throw error;
    }
    if (r !== 'unproved') return r;
  }
  throw unproven(ctx, '증명한 연결을 이어 쓰지 못함');
}

/** 에이전트 API 한 번 — 키(와 턴 토큰)를 싣는다. 그 연결이 증명한 연결일 때만 (keyed). 닿지 못하면 Halt(5) — 글에는 머리·본문을 넣지 않는다 */
async function call(ctx: Ctx, method: 'GET' | 'POST', path: string, o: { body?: unknown; token?: string; timeoutMs: number; maxBytes?: number }): Promise<Reply> {
  const data = method === 'POST' ? Buffer.from(JSON.stringify(o.body ?? {}), 'utf8') : null;
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.key}` };
  if (o.token) headers[TURN_TOKEN_HEADER] = o.token;
  if (data) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(data.length);
  }
  const max = o.maxBytes ?? REPLY_MAX_BYTES;
  try {
    const raw = await keyed(ctx, new URL(`${ctx.api}${path}`), method, headers, data, o.timeoutMs, max);
    return { ...raw, json: parseJson(raw.body) };
  } catch (error) {
    if (!(error instanceof SendError)) throw error;
    if (error.fail.kind === 'too_large') throw new Halt(WOOK_EXIT.unreachable, notApi(`답이 ${Math.round(max / 1024 / 1024)}MB를 넘음`));
    throw unreachable(ctx.api, error.fail.kind === 'timeout' ? `${Math.round(error.fail.ms / 1000)}초 안에 답이 끝나지 않음` : error.fail.code);
  }
}

/** 일반 요청의 상한 (쉬는 시간과 전체 시간) */
const requestMs = (ctx: Ctx): number => ctx.io.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

/** 거부한 답 → 끝 코드와 글 (401 → 3, 409 → 4, 그 밖 → 1). 에이전트 API의 답이 아니면 5 */
function refusal(r: Reply): { exit: number; text: string } {
  const e = isRecord(r.json) && r.json['ok'] === false && isRecord(r.json['error']) ? (r.json['error'] as Record<string, unknown>) : null;
  if (!e || typeof e['code'] !== 'string' || typeof e['message'] !== 'string') return { exit: WOOK_EXIT.unreachable, text: notApi(`HTTP ${r.status}`) };
  return { exit: r.status === 401 ? WOOK_EXIT.unauthorized : r.status === 409 ? WOOK_EXIT.conflict : WOOK_EXIT.refused, text: `${e['code']}: ${e['message']}` };
}

/** 200 { ok: true, … }이면 그 답, 아니면 Halt */
function okJson<T>(r: Reply): T {
  if (r.status === 200 && isRecord(r.json) && r.json['ok'] === true) return r.json as T;
  const f = refusal(r);
  throw new Halt(f.exit, f.text);
}

/**
 * 기다리는 동안의 heartbeat (리드 결정 S7-16 3 (d)) — 도구 호출·화면 받기·롱폴 사이에도 임대가 끝나지 않게. 서버 확인이 끝나기 전에는 보내지 않는다(S7-19 C3).
 * 실패하면 그만 보내고 그 글을 기억한다 (명령은 제 결과를 낸 뒤 그 글을 `(heartbeat) …` 줄로 붙인다)
 */
function heartbeatWhile(ctx: Ctx, s: WookState | null): { stop(): string | null } {
  if (!s) return { stop: () => null };
  let failed: string | null = null;
  let busy = false;
  const timer = setInterval(() => {
    if (busy || failed !== null || !ctx.proven) return;
    busy = true;
    call(ctx, 'POST', '/seat/heartbeat', { body: { leaseId: s.leaseId }, timeoutMs: requestMs(ctx) })
      .then((r) => {
        if (r.status === 200 && isRecord(r.json) && r.json['ok'] === true) return;
        failed = `(heartbeat) ${refusal(r).text}`;
        clearInterval(timer);
      })
      .catch((error: unknown) => {
        failed = `(heartbeat) ${error instanceof Halt ? error.message : '보내지 못함'}`;
        clearInterval(timer);
      })
      .finally(() => {
        busy = false;
      });
  }, Math.max(50, s.heartbeatMs));
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      return failed;
    },
  };
}

// ───────────────────────── 명령 ─────────────────────────

/** 명령의 결과 — out은 표준 출력, err는 표준 오류의 글, after는 heartbeat 실패(그 뒤 줄) */
interface Outcome {
  exit: number;
  out?: string;
  err?: string;
  after?: string | null;
}

const NO_LEASE = (path: string): string => `임대가 없습니다 — wook seat claim으로 메인 자리를 먼저 잡으세요 (${path}에 임대가 없음)`;
const NO_TURN = '받은 턴이 없습니다 — wook work next로 일을 받은 뒤 부르세요 (도구와 화면은 그 턴의 토큰으로 부릅니다)';
export const OTHER_POLLER = '다른 wook work next가 같은 임대로 기다리고 있습니다 — 한 임대로는 롱폴 하나만 엽니다 (새 롱폴이 앞의 것을 곧바로 끝냅니다). 다른 쪽을 끝내거나 그쪽이 받게 두세요';

function needLease(ctx: Ctx): WookState {
  const s = readState(ctx.statePath);
  if (!s) throw new Halt(WOOK_EXIT.refused, NO_LEASE(ctx.statePath));
  return s;
}

function needTurn(ctx: Ctx): WookState & { turn: NonNullable<WookState['turn']> } {
  const s = readState(ctx.statePath);
  if (!s?.turn) throw new Halt(WOOK_EXIT.refused, NO_TURN);
  return s as WookState & { turn: NonNullable<WookState['turn']> };
}

/** 그 턴의 도구 호출 상한 — 턴 시간 상한(deadlineAt) 뒤 1분까지, 적어도 1분 */
function toolTimeout(s: { turn: { deadlineAt: string } }): number {
  const end = Date.parse(s.turn.deadlineAt);
  return Number.isFinite(end) ? Math.min(6 * 3600_000, Math.max(60_000, end - Date.now() + 60_000)) : 30 * 60_000;
}

const holderText = (h: SeatHolderView | null): string => (!h ? '없음' : h.kind === 'external' ? `${h.label} (외부 에이전트 ${h.agentId})` : h.label);
const SEAT_STATE_TEXT: Record<SeatReply['state'], string> = { active: '앉아 있음', switching: '교체 중', vacant: '비어 있음', stopped: '긴급 정지 중' };
const BEAT_STATE_TEXT: Record<HeartbeatReply['state'], string> = {
  active: '일을 받습니다',
  switching: '메인 자리를 넘기는 중입니다 — 돌던 턴을 마치세요',
  stopped: '메인 에이전트가 일시정지돼 일이 오지 않습니다',
};
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}초`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function claim(ctx: Ctx): Promise<Outcome> {
  const r = okJson<ClaimReply>(await call(ctx, 'POST', '/seat/claim', { body: {}, timeoutMs: requestMs(ctx) }));
  const restricted = await saveState(ctx, {
    version: 1,
    api: ctx.api,
    agentId: r.agentId,
    label: r.label,
    generation: r.generation,
    leaseId: r.leaseId,
    leaseMs: r.leaseMs,
    heartbeatMs: r.heartbeatMs,
    pollMaxMs: r.pollMaxMs,
    claimedAt: new Date().toISOString(),
    turn: null,
  });
  return {
    exit: WOOK_EXIT.ok,
    out: [
      `메인 자리를 잡았습니다: ${r.label}(${r.agentId}), 세대 ${r.generation}`,
      `  임대 ${seconds(r.leaseMs)} — ${seconds(r.heartbeatMs)}마다 wook seat heartbeat를 보내세요. 임대를 싣는 요청(heartbeat·work next·progress·done)만 임대를 늘립니다`,
      `  일 받기: wook work next --wait (한 번에 ${seconds(r.pollMaxMs)}까지 기다리고 되풀이합니다)`,
      `  인계 꾸러미: ${r.handover ? `있음 (세대 ${r.handover.generation}, ${r.handover.chars}자)` : '없음'}`,
      // 좁히지 못했으면 '지금 사용자만 읽는 파일'이라고 말하지 않는다 (S7-19 C6)
      `  임대는 ${ctx.statePath}에 두었습니다 ${restricted ? '(지금 사용자만 읽는 파일)' : '(권한을 좁히지 못해 그 폴더의 권한을 따릅니다 — 위 경고를 보세요)'}`,
      '',
    ].join('\n'),
  };
}

async function status(ctx: Ctx): Promise<Outcome> {
  const r = okJson<SeatReply>(await call(ctx, 'GET', '/seat', { timeoutMs: requestMs(ctx) }));
  return {
    exit: WOOK_EXIT.ok,
    out: [
      `메인 자리: 세대 ${r.generation} · ${SEAT_STATE_TEXT[r.state] ?? r.state} · 보유자 ${holderText(r.holder)}`,
      `  이 에이전트에게 배정됨: ${r.assigned ? '예' : '아니요'}`,
      `  이 에이전트의 임대: ${r.leaseExpiresAt ? `${r.leaseExpiresAt}까지` : '없음 — wook seat claim으로 잡습니다'}`,
      '',
    ].join('\n'),
  };
}

async function heartbeat(ctx: Ctx): Promise<Outcome> {
  const s = needLease(ctx);
  const r = okJson<HeartbeatReply>(await call(ctx, 'POST', '/seat/heartbeat', { body: { leaseId: s.leaseId }, timeoutMs: requestMs(ctx) }));
  return { exit: WOOK_EXIT.ok, out: `임대를 늘렸습니다: 세대 ${r.generation} · ${BEAT_STATE_TEXT[r.state] ?? r.state} · 대기 중인 메인 일 ${r.queued}개 · 임대 끝 ${r.leaseExpiresAt}\n` };
}

async function release(ctx: Ctx, note: string | null): Promise<Outcome> {
  const s = needLease(ctx);
  okJson(await call(ctx, 'POST', '/seat/release', { body: { leaseId: s.leaseId, ...(note ? { note } : {}) }, timeoutMs: requestMs(ctx) }));
  await saveState(ctx, null);
  return {
    exit: WOOK_EXIT.ok,
    out: `메인 자리에서 물러났습니다 (세대 ${s.generation}). 서버는 다른 보유자를 앉히지 않습니다 — 자리는 응답 없음으로 남고 운영자가 배정합니다. 다시 잡으려면 wook seat claim\n`,
  };
}

async function next(ctx: Ctx, wait: boolean): Promise<Outcome> {
  const s = needLease(ctx);
  const waitMs = wait ? Math.max(1000, s.pollMaxMs || 25_000) : 0;
  // 서버는 기다림을 pollMaxMs로 줄인다 — '일찍 돌아온 204'는 그 절반 안에 온 것 (S7-19 C5)
  const serverWait = Math.min(waitMs, s.pollMaxMs || waitMs);
  const hb = wait ? heartbeatWhile(ctx, s) : { stop: () => null };
  let item: WorkItem | null = null;
  try {
    let early = 0;
    let polls = 0;
    for (;;) {
      // 다음 롱폴 전에: 기다리는 사이 서버가 끝났거나 다시 시작했으면 멈춘다 (S7-22 K1의 둘째 지킴 — 첫째는 연결마다의 확인)
      if (polls++ > 0) endpointStill(ctx);
      const t0 = Date.now();
      const r = await call(ctx, 'POST', '/work/next', { body: { leaseId: s.leaseId, waitMs }, timeoutMs: waitMs + POLL_SLACK_MS });
      if (r.status === 204) {
        if (!wait) break;
        // 다른 롱폴이 이 롱폴을 곧바로 끝냈다 — 둘이 서로를 끝내며 키의 횟수(1분 600번)를 태우지 않게 1초 쉬고, 세 번 잇따르면 그만둔다
        if (Date.now() - t0 < serverWait / 2) {
          early += 1;
          if (early >= EARLY_POLLS_MAX) throw new Halt(WOOK_EXIT.refused, OTHER_POLLER);
          await sleep(EARLY_POLL_PAUSE_MS);
        } else early = 0;
        continue;
      }
      item = okJson<WorkItem>(r);
      if (typeof item.turnId !== 'string' || !isRecord(item.mcp) || typeof item.mcp.token !== 'string') throw new Halt(WOOK_EXIT.unreachable, notApi('일의 모양이 다름'));
      break;
    }
  } catch (error) {
    const after = hb.stop();
    if (error instanceof Halt) return { exit: error.exit, err: error.message, after };
    throw error;
  }
  const after = hb.stop();
  if (!item) return { exit: WOOK_EXIT.ok, err: '지금은 받을 일이 없습니다 (다시 하거나 --wait로 기다리세요)', after };
  // 쓰기 직전에 다시 읽는다 — 그사이 다른 wook이 임대를 새로 잡았거나 다른 턴을 두었으면 덮어쓰지 않는다 (S7-19 C6)
  const cur = readState(ctx.statePath);
  if (!cur || cur.leaseId !== s.leaseId || !(sameTurn(cur.turn, s.turn) || cur.turn?.turnId === item.turnId)) {
    return {
      exit: WOOK_EXIT.refused,
      err: `받은 일(${item.turnId})을 state.json에 두지 않았습니다 — 기다리는 사이 다른 wook이 state.json의 임대나 턴을 바꿨습니다 (한 계정의 ~/.wook는 에이전트 하나가 씁니다). wook seat status로 본 뒤 다시 하세요`,
      after,
    };
  }
  await saveState(ctx, { ...cur, turn: { turnId: item.turnId, token: item.mcp.token, generation: item.generation, deadlineAt: item.deadlineAt } });
  // 턴 토큰은 내지 않는다 (리드 결정 S7-16) — 도구는 wook tool이 state.json의 토큰으로 부른다
  const { ok: _ok, mcp, ...rest } = item;
  return { exit: WOOK_EXIT.ok, out: asciiJson({ ...rest, mcp: { url: mcp.url } }), after };
}

async function progress(ctx: Ctx, turnId: string, text: string): Promise<Outcome> {
  const s = needLease(ctx);
  okJson(await call(ctx, 'POST', `/work/${turnId}/progress`, { body: { leaseId: s.leaseId, text }, timeoutMs: requestMs(ctx) }));
  return { exit: WOOK_EXIT.ok, out: `진행 상황을 남겼습니다: ${turnId}\n` };
}

async function done(ctx: Ctx, turnId: string, file: string, outcome: 'completed' | 'failed'): Promise<Outcome> {
  const s = needLease(ctx);
  // UTF-8만 (S7-19 C2) — 빈 답은 '해내지 못함'(--outcome failed)일 때만
  const finalText = readUtf8File(file, '마지막 답 파일(--file)');
  if (!finalText.trim() && outcome !== 'failed') {
    throw new Halt(WOOK_EXIT.usage, '마지막 답 파일(--file)이 비었습니다 — 답을 쓰거나, 해내지 못한 턴이면 --outcome failed를 붙이세요. 아무것도 보내지 않았습니다');
  }
  const r = okJson<FinishReply>(await call(ctx, 'POST', `/work/${turnId}/finish`, { body: { leaseId: s.leaseId, finalText, outcome }, timeoutMs: DONE_TIMEOUT_MS }));
  // 쓰기 직전에 다시 읽는다 — 그사이 다른 wook이 잡은 임대·받은 턴은 그대로 둔다 (S7-19 C6)
  const cur = readState(ctx.statePath);
  if (cur && cur.leaseId === s.leaseId && cur.turn?.turnId === turnId) await saveState(ctx, { ...cur, turn: null });
  return { exit: WOOK_EXIT.ok, out: `턴을 마쳤습니다: ${turnId} (끝 까닭 ${r.endReason})\n` };
}

/** --json-file의 도구 인자 — UTF-8 JSON 객체 (S7-19 C7). 내용·경로는 글에 넣지 않는다 */
function readArgsFile(file: string): Record<string, unknown> {
  const what = '도구 인자 파일(--json-file)';
  const text = readUtf8File(file, what);
  let args: unknown;
  try {
    args = JSON.parse(text) as unknown;
  } catch {
    throw new Halt(WOOK_EXIT.usage, `${what}의 글을 JSON으로 읽을 수 없습니다 — 예: {"project_id": "general"} (내용은 보이지 않습니다)`);
  }
  if (!isRecord(args)) throw new Halt(WOOK_EXIT.usage, `${what}의 JSON은 객체여야 합니다 — 예: {"project_id": "general"} (내용은 보이지 않습니다)`);
  return args;
}

/** 도구 한 번 — 받은 턴의 토큰과 키를 함께. 도구의 거부는 200 ok:false (S7-16 3 (h)) → 1 */
async function toolCall(ctx: Ctx, s: WookState & { turn: NonNullable<WookState['turn']> }, name: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | Outcome> {
  const r = await call(ctx, 'POST', `/tool/${name}`, { body: args, token: s.turn.token, timeoutMs: toolTimeout(s) });
  if (r.status === 200 && isRecord(r.json) && r.json['ok'] === true) return { ok: true, data: r.json['data'] };
  if (r.status === 200 && isRecord(r.json) && r.json['ok'] === false && isRecord(r.json['error'])) {
    const e = r.json['error'];
    return { exit: WOOK_EXIT.refused, err: `도구 거부(${name}) — ${String(e['code'])}: ${String(e['message'])}` };
  }
  const f = refusal(r);
  return { exit: f.exit, err: f.text };
}

async function tool(ctx: Ctx, name: string, inline: Record<string, unknown> | null, argsFile: string | null): Promise<Outcome> {
  const args = argsFile !== null ? readArgsFile(argsFile) : (inline ?? {});
  const s = needTurn(ctx);
  const hb = heartbeatWhile(ctx, s);
  let r: { ok: true; data: unknown } | Outcome;
  try {
    r = await toolCall(ctx, s, name, args);
  } catch (error) {
    const after = hb.stop();
    if (error instanceof Halt) return { exit: error.exit, err: error.message, after };
    throw error;
  }
  const after = hb.stop();
  if ('ok' in r) return { exit: WOOK_EXIT.ok, out: asciiJson(r.data ?? null), after };
  return { ...r, after };
}

async function capture(ctx: Ctx, out: string): Promise<Outcome> {
  const s = needTurn(ctx);
  const hb = heartbeatWhile(ctx, s);
  const target = resolve(out);
  try {
    const shot = await toolCall(ctx, s, 'screen_capture', {});
    if (!('ok' in shot)) return { ...shot, after: hb.stop() };
    const data = isRecord(shot.data) ? shot.data : {};
    const id = data['capture_id'];
    if (typeof id !== 'string' || !/^SC-\d{6,12}$/.test(id)) return { exit: WOOK_EXIT.refused, err: 'screen_capture의 결과에 capture_id가 없습니다', after: hb.stop() };
    const r = await call(ctx, 'GET', `/screens/${id}`, { token: s.turn.token, timeoutMs: toolTimeout(s), maxBytes: SCREEN_REPLY_MAX_BYTES });
    if (r.status !== 200 || !r.type.startsWith('image/png')) {
      const f = refusal(r);
      return { exit: f.exit, err: f.text, after: hb.stop() };
    }
    try {
      writeFileSync(target, r.body, { mode: 0o600 });
    } catch (error) {
      // --out으로 받은 경로는 글에 넣지 않는다 (S7-19 C12·S7-22 K4)
      return { exit: WOOK_EXIT.refused, err: `캡처를 --out의 파일에 쓰지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? '알 수 없는 오류'}) — 경로를 확인하세요 (적은 값은 보이지 않습니다)`, after: hb.stop() };
    }
    const note = typeof data['note'] === 'string' && data['note'] ? `\n  알림: ${data['note']}` : '';
    return {
      exit: WOOK_EXIT.ok,
      out: `화면을 찍어 저장했습니다: ${target} (캡처 ${id}, ${String(data['width'] ?? '?')}×${String(data['height'] ?? '?')}, ${r.body.length}바이트, 30초 동안 gui_input에 씁니다)${note}\n`,
      after: hb.stop(),
    };
  } catch (error) {
    const after = hb.stop();
    if (error instanceof Halt) return { exit: error.exit, err: error.message, after };
    throw error;
  }
}

function stopText(s: StopReply): string {
  const turns = s.stoppedTurns.length;
  const held = s.heldTasks.length;
  if (!s.completed) {
    const lines = s.failures.map((f) => `  - ${f.memberName}: ${f.detail}`);
    return [`긴급 정지를 걸었지만 종료를 확인하지 못한 실행이 있습니다. 새 실행은 막았고, 실행 ${turns}개를 멈추고 작업 ${held}개를 보류했습니다. 정지 해제는 대표만 합니다.`, ...lines, ''].join('\n');
  }
  if (turns === 0 && held === 0) return '긴급 정지를 걸었습니다. 실행 중인 작업은 없었고, 새 실행을 막았습니다. 정지 해제는 대표만 합니다.\n';
  return `긴급 정지를 걸었습니다. 실행 ${turns}개를 멈추고 작업 ${held}개를 보류했습니다. 정지 해제는 대표만 합니다.\n`;
}

async function stop(ctx: Ctx): Promise<Outcome> {
  const r = okJson<StopReply>(await call(ctx, 'POST', '/stop', { body: {}, timeoutMs: STOP_TIMEOUT_MS }));
  return { exit: WOOK_EXIT.ok, out: stopText(r) };
}

async function runCmd(ctx: Ctx, cmd: Cmd): Promise<Outcome> {
  switch (cmd.kind) {
    case 'claim':
      return claim(ctx);
    case 'status':
      return status(ctx);
    case 'heartbeat':
      return heartbeat(ctx);
    case 'release':
      return release(ctx, cmd.note);
    case 'next':
      return next(ctx, cmd.wait);
    case 'progress':
      return progress(ctx, cmd.turnId, cmd.text);
    case 'done':
      return done(ctx, cmd.turnId, cmd.file, cmd.outcome);
    case 'tool':
      return tool(ctx, cmd.name, cmd.args, cmd.argsFile);
    case 'capture':
      return capture(ctx, cmd.out);
    case 'stop':
      return stop(ctx);
  }
}

/** 진입점 — 끝 코드를 돌려준다 */
export async function runWook(argv: readonly string[], io: WookIo): Promise<number> {
  const plan = parseWook(argv);
  if (plan.kind === 'help') {
    await io.out(WOOK_USAGE);
    return WOOK_EXIT.ok;
  }
  if (plan.kind === 'error') {
    await io.err(`${plan.message}\n\n${WOOK_USAGE}`);
    return WOOK_EXIT.usage;
  }
  let o: Outcome;
  const link = newLink();
  try {
    sweepStaleTmp(join(io.home, WOOK_HOME_DIR));
    const key = readKey(io);
    const ep = resolveApi(plan.dataDir, io);
    o = await runCmd({ io, api: ep.api, key, statePath: join(io.home, WOOK_HOME_DIR, STATE_FILE), proof: ep.proof, source: ep.source, endpointFile: ep.file, link, proven: ep.proof === null }, plan.cmd);
  } catch (error) {
    if (!(error instanceof Halt)) throw error;
    o = { exit: error.exit, err: error.message };
  } finally {
    // 쉬는 keep-alive 연결을 닫는다 (프로세스 안에서 부를 때도 연결이 남지 않게)
    link.agent.destroy();
  }
  if (o.out) await io.out(o.out);
  if (o.err) await io.err(`${o.err}\n`);
  if (o.after) await io.err(`${o.after}\n`);
  return o.exit;
}
