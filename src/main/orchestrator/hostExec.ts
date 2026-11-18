/**
 * 메인 에이전트의 서버 명령 `host_exec` (SERVER_DESIGN 8.2·8.4, 리드 결정 S5-16~S5-19, 지도 host-exec §3~§6).
 * - 앱 통제 안에서 서버 PC 명령(설치 포함)을 돌린다: 프로세스 러너(Windows 작업 개체·taskkill 대체, Linux 프로세스 그룹)로 띄워 긴급 정지·턴 끝·자리 교체·앱
 *   종료가 함께 끝낸다. 실행 승인 흐름은 없다(SEC-03). 한 번에 하나(메인 턴은 한 번에 하나라 ORG-07 N에 세지 않는다)
 * - 띄우기 전에 거부한다: 백그라운드(6단계), 비밀 값이 든 명령·cwd(가린 글과 원문이 다르면 — 가린 글은 실행하지 않는다. 그 둘을 되풀이할 수 있는 검사보다
 *   먼저 본다, S5-31), 실행 위치(cwd) 검사, 거부 목록
 *   (core/hostCommandGuard), 종료를 확인할 수 없는 실행 환경(runner.problem), 자리 교체 중, 다른 host_exec가 도는 중, 이 턴의 앞선 host_exec가 종료를
 *   확인하지 못함. 정지·메인 일시정지·턴의 정지 요청·자리·앱 종료는 러너 준비 뒤 같은 동기 구간에서 다시 보고 실행을 등록한다 — 뒤에 오는 정지는 반드시 찾는다
 * - 실행 위치 검사는 cwd만 본다(격리가 아니다): 데이터 폴더·보관하지 않은 프로젝트 폴더·그 연결 지점이 닿는 폴더와 같거나 그 안이거나 그 폴더를 품은 위치는
 *   거부한다. 명령은 cd로 옮기거나 절대 경로를 쓸 수 있다
 * - 출력: 표준 출력·오류를 줄 차례로 모아(여러 줄 개인 키는 시작 줄부터 끝 줄까지를 창에 담아 가림 표시 한 줄로 — S5-35, 창은 열린 키가 모두 닫히는 끝
 *   줄이나 출력 끝에서만 닫히고(S5-55) 담는 상한을 넘으면 본문으로 보이는 줄을 버리며 흘려 보낸다 — S5-48. 창 안에서 남기는 글은 가리개로 먼저 가린 뒤
 *   base64 16자 넘는 이어짐을 모두 가린다 — S5-71·S5-78) 앞 16KiB + 뒤 48KiB(줄 단위로만
 *   자른다, '…(n바이트 생략)…', 뒤 상한보다 긴 한 줄은 바로 버림 — S5-36, 그 전에 그 줄의 개인 키 표시는 본다 — S5-43), 남긴 글을 한 번 가린다. 실행 기록
 *   (ExecRecord, 지우지 않는다)에는 가린 글의 뒤 4,000자만 둔다. 가리기가 실패하면 그 글은 '[가림:가리기 실패]'이고 기록·남은 프로세스 접기는 그대로
 *   이어진다(S5-83)
 * - 남은 하위 프로세스: 스스로 끝났는데 남았거나(remaining≠0) 정지의 종료 확인이 실패하면 부른 턴에 접는다(TurnRunner.noteUnconfirmed) — 그 턴이 kill_failed로
 *   끝나 M-MAIN이 일시정지되고(CTL-11) 출구는 대표의 정지 해제다. 그 턴에는 host_exec를 더 받지 않는다
 * - 기록: 시작·끝 활동 기록(exec, 행위자 M-MAIN), 끝에 메인 일지 action 한 줄. 호출마다 대표 알림은 없다. 거부는 앱 도구 서버의 '<도구> 거부' 줄만 남는다
 */
import { basename, isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { MAIN_AGENT_ID, type ExecRecord, type Member } from '@shared/domain';
import { hostCommandDenied, hostCommandRefusal } from '@core/hostCommandGuard';
import {
  PRIVATE_KEY_MARK,
  PRIVATE_KEY_PIECE_MARK,
  PRIVATE_KEY_SPILL_MARK,
  REDACT_FAILED_MARK,
  pemBeginAt,
  pemBeginIn,
  pemEndIn,
  privateKeySpillEndMark,
  privateKeySpillUnterminatedMark,
  privateKeyUnterminatedMark,
  privateKeyWindowMark,
} from '@core/redact';
import { BackendError } from '../backend/types';
import type { TokenIdentity } from '../mcp/types';
import type { HostExecResult } from '../mcp/catalog';
import { unconfirmedEnvProblem, type ManagedProcess, type TerminateResult } from '../process/types';
import { buildHostExecEnv, HOST_EXEC_MAX_TIMEOUT_S } from '../agents/common';
import type { Core } from './core';
import { CPU_LIMIT_PERCENT } from './cpuGuard';
import { shellCommand } from './autocheck';
import { recordedExec } from './execlog';
import { localFolderWords, relation, winPathProblem } from './pathGuard';
import { workProjectOf } from './records';
import { STOP_CONFIRM_MS } from './turns';

/** 러너 실행 이름의 앞말 — 시험 하네스가 이 이름으로 가려 받는다 (리드 결정 S5-18) */
export const HOST_EXEC_LABEL_PREFIX = '서버 명령 ';
export const HOST_EXEC_DEFAULT_TIMEOUT_S = 300;
/** 명령 길이 상한 (cmd.exe 명령줄 8,191자 안) */
export const HOST_EXEC_COMMAND_MAX = 8000;
export const HOST_EXEC_PURPOSE_MAX = 300;
/** 도구 결과의 출력 상한: 앞 16KiB + 뒤 48KiB (리드 결정 S5-16) */
export const HOST_EXEC_HEAD_BYTES = 16 * 1024;
export const HOST_EXEC_TAIL_BYTES = 48 * 1024;
/** 실행 기록에 남기는 출력 끝 (지우지 않는 기록이라 64KiB를 두지 않는다) */
export const HOST_EXEC_RECORD_TAIL = 4000;
/** 턴 시간 상한까지 남겨 두는 여유 — 명령이 끝난 뒤 CLI가 턴을 마무리할 시간 */
const TURN_MARGIN_MS = 30_000;
/** CPU가 내려가기를 기다리는 동안 부른 턴에 두는 '명령 실행 중' 표시의 이름 (turns.noteHostCommand — 턴 감시가 응답 없음으로 끊지 않게) */
const CPU_WAIT_KEY = 'cpu-wait';

/** 명령에 비밀 값이 들어 있을 때의 거부 글 (리드 결정 S5-17) */
export const HOST_EXEC_SECRET_REFUSAL = '명령에 비밀 값(으로 보이는 글)이 들어 있어 실행하지 않았습니다 — 비밀 값은 서버 PC 운영자가 넣습니다';
/** 실행 위치(cwd)에 비밀 값이 들어 있을 때의 거부 글 (리드 결정 S5-31) — 경로를 되풀이하지 않는다 */
export const HOST_EXEC_CWD_SECRET_REFUSAL = '작업 폴더 경로에 비밀 값(으로 보이는 글)이 들어 있어 실행하지 않았습니다';

/** 결과의 stopped — 무엇이 끝냈는지 (시간 초과는 timed_out) */
export type HostExecStop = NonNullable<HostExecResult['stopped']>;

interface Running {
  execId: string;
  toolRequestId: string;
  turnId: string;
  proc: ManagedProcess;
  stopReason: HostExecStop | null;
  timedOut: boolean;
  stopPromise: Promise<TerminateResult> | null;
  finished: Promise<void>;
}

type Args = Record<string, unknown>;
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** '…폴더(…)라'·'…폴더 안이라' — 받침 있는 '안' 뒤에는 '이라' */
const withRa = (s: string): string => `${s}${s.endsWith('안') ? '이라' : '라'}`;
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}초`;

/**
 * 여러 줄 개인 키 창에 줄을 담아 두는 상한 — 줄 수와 바이트 가운데 먼저 닿는 것 (리드 결정 S5-35). 닿아도 창은 닫히지 않는다 — 그때부터 흘려 보낸다
 * (리드 결정 S5-48)
 */
export const HOST_EXEC_PEM_WINDOW_LINES = 400;
export const HOST_EXEC_PEM_WINDOW_BYTES = 32 * 1024;
/** 창 안에서 버린 긴 줄 하나를 담는 상한(32KiB)에 세는 크기 — 줄의 크기가 아니라 자리표만 센다 (리드 결정 S5-43) */
const LONG_IN_WINDOW_BYTES = 1;
/** 키 본문으로 볼 줄 끝의 base64 글자 수 (리드 결정 S5-48) */
const KEY_BODY_RUN = 16;

/** base64 글자 (A-Z a-z 0-9 + /, pad가 참이면 = 도) */
const isBase64 = (c: number, pad: boolean): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || (pad && c === 61);
/** 공백·탭·\r 등 (줄 끝에서 뗀다) */
const isBlank = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);
/** 줄 끝 너그러움으로 떼어 보는 글자의 상한 (리드 결정 S5-55) */
const KEY_BODY_TAIL_MAX = 24;
/** 줄 끝에서 떼어 보는 글자 ' " , ; + ) ] } — util.inspect의 `'…\n' +`, JSON 배열의 `"…",` (리드 결정 S5-55) */
const isTailMark = (c: number): boolean => c === 39 || c === 34 || c === 44 || c === 59 || c === 43 || c === 41 || c === 93 || c === 125;

/** S5-48의 본문 판정 — end 앞의 줄 끝이 base64 16자 넘게 이어지거나, base64 2자 넘게 뒤에 = 이나 == (채운 마지막 줄) */
function bodyEndsAt(line: string, end: number): boolean {
  let run = 0;
  for (let i = end - 1; i >= 0 && run < KEY_BODY_RUN && isBase64(line.charCodeAt(i), true); i--) run++;
  if (run >= KEY_BODY_RUN) return true;
  let pad = 0;
  while (pad < 2 && end - 1 - pad >= 0 && line.charCodeAt(end - 1 - pad) === 61) pad++;
  if (pad === 0) return false;
  let before = 0;
  for (let i = end - 1 - pad; i >= 0 && before < 2 && isBase64(line.charCodeAt(i), false); i--) before++;
  return before >= 2;
}

/** end 앞의 줄 끝에서 하나 떼어 볼 것(공백, ' " , ; + ) ] }, 글자 그대로의 \n·\r, ANSI 색 ESC[…m)을 뗀 자리 — 떼어 볼 것이 없거나 floor를 넘으면 -1 */
function tailMarkStart(line: string, end: number, floor: number): number {
  const c = line.charCodeAt(end - 1);
  let at = -1;
  if (isBlank(c) || isTailMark(c)) at = end - 1;
  else if ((c === 110 || c === 114) && end >= 2 && line.charCodeAt(end - 2) === 92) at = end - 2;
  else if (c === 109) {
    let i = end - 2;
    while (i >= floor && ((line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) || line.charCodeAt(i) === 59)) i--;
    if (i >= floor + 1 && line.charCodeAt(i) === 91 && line.charCodeAt(i - 1) === 27) at = i - 1;
  }
  return at >= floor ? at : -1;
}

/**
 * 키 본문으로 보이는 줄 (리드 결정 S5-48·S5-55): 끝의 공백·\r, 끝의 '$'(cat -A), 그 앞의 '^M'(cat -A가 보이는 CRLF의 \r)을 뗀 뒤 줄이 base64 글자(=
 * 포함) 16자 넘게 이어지며 끝나거나, base64 글자 2자 넘게 뒤에 = 이나 == 로 끝난다(채운 마지막 줄). 그렇지 않으면 줄 끝에서 ANSI 색(ESC[…m), 글자 그대로의
 * \n·\r, ' " , ; + ) ] }와 공백을 어떤 차례로든 모두 합쳐 24자까지 하나씩 떼며 뗄 때마다 같은 판정을 한다(S5-55 — Node util.inspect의 `'MIIE…\n' +`, JSON
 * 배열의 `"MIIE…",`, 색 입힌 출력). 떼기 전 모습도 보므로 떼어서 본문이 아니게 되는 일은 없다. 줄 끝만 보므로 앞말(cat -n·findstr /n·경로:번호:·diff의
 * -/+·들여쓰기)은 상관없다. 줄 끝에서 몇십 글자만 본다 — 줄 길이에 비례하는 일이 없다
 */
export function looksLikeKeyBody(line: string): boolean {
  let end = line.length;
  const trim = (): void => {
    while (end > 0 && isBlank(line.charCodeAt(end - 1))) end--;
  };
  trim();
  if (end > 0 && line.charCodeAt(end - 1) === 36) {
    end--;
    trim();
  }
  if (end >= 2 && line.charCodeAt(end - 1) === 77 && line.charCodeAt(end - 2) === 94) {
    end -= 2;
    trim();
  }
  if (bodyEndsAt(line, end)) return true;
  // 줄 끝 너그러움 (리드 결정 S5-55) — 모두 합쳐 24자까지
  const floor = Math.max(0, end - KEY_BODY_TAIL_MAX);
  for (let at = end > 0 ? tailMarkStart(line, end, floor) : -1; at !== -1; at = end > floor ? tailMarkStart(line, end, floor) : -1) {
    end = at;
    if (bodyEndsAt(line, end)) return true;
  }
  return false;
}

/** 한 창에 동시에 열려 있을 수 있는 키의 종류 수와 열린 키 수 — 넘으면 창은 출력 끝까지 닫히지 않는다(sticky) (리드 결정 S5-55) */
export const HOST_EXEC_PEM_OPEN_KINDS = 8;
export const HOST_EXEC_PEM_OPEN_KEYS = 64;
/**
 * 뒤 상한보다 긴 한 줄에서 걷는 시작·끝 표시의 상한 — 넘으면 그 줄의 나머지는 걷지 않고 창을 출력 끝까지 연다(sticky, 열린 창이 없으면 그 자리에서 연다).
 * 표시만으로 가득 찬 32MiB 한 줄(표시 약 110만 개)을 다 걸으면 0.5~1초가 걸려 이벤트 루프를 막았다 (리드 결정 S5-65)
 */
export const HOST_EXEC_PEM_LONG_MARKERS = 1024;

/**
 * 줄에서 떼어 낸 조각의 따로 된 사본 (리드 결정 S5-66) — V8은 잘라 낸 글(13자 넘게)이 원래 줄 전체를 붙잡아 두어, 남긴 짧은 조각 하나가 그 줄(긴 줄은
 * 32MiB까지)을 출력이 끝날 때까지 살려 둔다. 개인 키 표시가 든 줄에서 떼어 남기거나 창의 첫 줄로 두는 조각은 베낀다(조각 크기만큼만 든다)
 */
const own = (s: string): string => Buffer.from(s, 'utf8').toString('utf8');

/** 창 안에서 남기는 글에서 가리는 이어짐 — base64 글자([A-Za-z0-9+/=])가 16자 넘게 (리드 결정 S5-71) */
const WINDOW_RUN_RE = /[A-Za-z0-9+/=]{16,}/g;
/** 그런 이어짐이 있는지만 보는 것 (g 없음 — lastIndex를 쓰지 않는다) */
const HAS_WINDOW_RUN = /[A-Za-z0-9+/=]{16}/;
/**
 * 창 안에서 남기는 글 (리드 결정 S5-71) — base64 글자가 16자 넘게 이어진 곳을 모두 '[가림:개인 키 조각]'으로 바꾼다. 창의 보장은 이것에 기댄다: 줄이 키
 * 본문으로 보이는지(looksLikeKeyBody·줄 끝 너그러움)는 버려 셀지, 가려 남길지만 정한다 — 그 짐작이 틀리는 꼴(잘린 본문 뒤에 글이 붙은 줄, 너그러움 밖의 줄
 * 끝, 두 번 이스케이프한 값)에도 남긴 글에 16자 넘는 이어짐이 없다. 보통 글(낱말·짧은 숫자)은 그대로 읽힌다. 바꾼 글은 replace가 새로 만든 글이라 원래
 * 줄을 붙잡지 않는다 (S5-66). 이 가리기는 가리개를 거친 글에만 한다(HostExecOutput.keepWindow, 리드 결정 S5-78) — 16자 넘는 이름(databasePassword·
 * keyStorePassword)과 URL 사용자(//applicationuser1234)도 이어짐이라, 먼저 바꾸면 가리개 규칙이 기대는 이름이 사라져 그 옆 값(구두점이 든·16자보다 짧은
 * 비밀번호)이 남는다
 */
const maskWindowText = (s: string): string => s.replace(WINDOW_RUN_RE, PRIVATE_KEY_PIECE_MARK);

/**
 * 창에 열려 있는 키 (리드 결정 S5-55) — 끝 표시(종류)마다 열린 수. 시작 표시는 그 종류를 하나 더하고, 열린 종류의 끝 표시는 하나 뺀다. 열린 수가 모두 0이
 * 되면 창이 닫힌다. 종류가 8개나 열린 키가 64개를 넘으면 세기를 그만두고 sticky — 출력 끝에서만 닫힌다(더 가리기만 한다)
 */
interface OpenKeys {
  byEnd: Map<string, number>;
  total: number;
  sticky: boolean;
}

const noKeys = (): OpenKeys => ({ byEnd: new Map(), total: 0, sticky: false });
const isOpen = (k: OpenKeys): boolean => k.sticky || k.total > 0;
/** 세기를 그만두고 출력 끝까지 연다 — 열린 키 상한(S5-55)이나 긴 줄의 걷기 상한(S5-65) */
function stick(k: OpenKeys): void {
  k.sticky = true;
  k.byEnd.clear();
}

function openKey(k: OpenKeys, end: string): void {
  if (k.sticky) return;
  const n = k.byEnd.get(end) ?? 0;
  if ((n === 0 && k.byEnd.size >= HOST_EXEC_PEM_OPEN_KINDS) || k.total >= HOST_EXEC_PEM_OPEN_KEYS) {
    stick(k);
    return;
  }
  k.byEnd.set(end, n + 1);
  k.total++;
}

/** 열린 종류의 끝 표시면 하나 빼고 참. 열리지 않은 종류의 끝 표시(보통 글)나 sticky면 거짓 */
function closeKey(k: OpenKeys, end: string): boolean {
  const n = k.sticky ? 0 : (k.byEnd.get(end) ?? 0);
  if (n === 0) return false;
  if (n === 1) k.byEnd.delete(end);
  else k.byEnd.set(end, n - 1);
  k.total--;
  return true;
}

/** 줄 안의 시작·끝 표시 하나 */
interface PemMarker {
  begin: boolean;
  index: number;
  length: number;
  /** 그 종류의 끝 표시 글 (시작 표시든 끝 표시든 같은 꼴 — 종류의 이름) */
  end: string;
}

/**
 * 줄의 시작·끝 표시를 자리 차례로 하나씩 (리드 결정 S5-55). 다음 시작 표시와 다음 끝 표시를 하나씩 기억해 두고 쓴 쪽만 다시 찾는다 — 표시가 많은 긴 줄도
 * 줄 길이에 비례한다. 긴 줄은 그 자리에서 정규식으로만 찾는다(베끼지 않는다). 시작 표시 끝의 -----에 붙은 END …는 건너뛴다 — 가리개의 redactPem과 같다.
 * 끝 표시 뒤의 시작 표시는 키를 닫든 닫지 않든 그 끝 표시의 끝 '-----'부터 찾는다 — 그 대시를 함께 쓰는 시작 표시도 센다. redactPem은 블록을 그 종류의
 * 첫 끝 표시에서 끝내므로(따옴표가 끼면 base64 꼬리에서), 창을 닫은 끝 표시가 redactPem에는 보통 글일 수 있다 — 겹친 두 키의 바깥 끝 표시, 엇갈린 두 키의
 * 나중 끝 표시, 따옴표 든 줄이 낀 블록의 끝 표시. 그때 redactPem은 그 대시의 시작 표시를 찾아 다음 키를 가린다 (리드 결정 S5-79·S5-85 — 키 하나를 닫는 끝
 * 표시에서는 redactPem보다 더 가리기만 한다). limit개를 돌려준 뒤 표시가 더 있으면 돌려주지 않고 capped를 켠다 — 긴 줄의 걷기 상한 (리드 결정 S5-65)
 */
class PemMarkers {
  private nextBegin: PemMarker | null | undefined;
  private nextEnd: PemMarker | null | undefined;
  /** 다음 시작 표시를 찾는 자리 — 시작 표시 바로 뒤에서는 pos, 끝 표시 바로 뒤에서는 그 끝 표시의 끝 '-----' 자리 (리드 결정 S5-79·S5-85) */
  private beginFrom: number;
  /** 돌려준 표시 수 */
  count = 0;
  /** 상한에 닿아 남은 표시를 돌려주지 않았다 */
  capped = false;
  constructor(
    private readonly line: string,
    private pos = 0,
    private readonly limit = Infinity,
  ) {
    this.beginFrom = pos;
  }

  /**
   * 걷기가 멈춘 자리 — 마지막으로 돌려준 표시 바로 뒤. 다만 마지막 끝 표시의 끝 '-----'에서 시작하는 시작 표시가 걷지 않고 남았으면 그 시작 표시
   * 자리다(그 표시를 창의 첫 줄에 온전히 둔다). 걷지 않은 다음 시작 표시가 그 뒤에 있으면 멈춘 자리 그대로다. 상한에 닿았을 때 읽는다 — 그때 next()가
   * 다음 시작 표시를 이미 찾아 두었다 (리드 결정 S5-72·S5-79·S5-81 2·S5-85)
   */
  get stopAt(): number {
    const b = this.nextBegin;
    return b && b.index < this.pos ? b.index : this.pos;
  }

  next(): PemMarker | null {
    if (this.nextBegin === undefined || (this.nextBegin && this.nextBegin.index < this.beginFrom)) {
      const b = pemBeginIn(this.line, this.beginFrom);
      this.nextBegin = b ? { begin: true, ...b } : null;
    }
    if (this.nextEnd === undefined || (this.nextEnd && this.nextEnd.index < this.pos)) {
      const e = pemEndIn(this.line, this.pos);
      this.nextEnd = e ? { begin: false, ...e } : null;
    }
    const b = this.nextBegin;
    const e = this.nextEnd;
    const m = b && (!e || b.index < e.index) ? b : e;
    if (!m) return null;
    if (this.count >= this.limit) {
      this.capped = true;
      return null;
    }
    this.count++;
    if (m === b) this.nextBegin = undefined;
    else this.nextEnd = undefined;
    this.pos = m.index + m.length;
    // 끝 표시 뒤의 시작 표시는 키를 닫든 닫지 않든 그 끝 표시의 끝 '-----'부터 찾는다 — 그 대시를 함께 쓰는 시작 표시도 센다 (리드 결정 S5-79·S5-85)
    this.beginFrom = m.begin ? this.pos : this.pos - 5;
    return m;
  }
}

/**
 * 창을 닫은 끝 표시(at에서 끝남) 뒤 글을 다시 볼 자리 — 그 끝 표시의 끝 '-----'(다섯 자리)에서 시작 표시가 시작하면 그 자리, 아니면 at (리드 결정 S5-85).
 * 그 시작 표시를 다시 보는 글에 온전히 넣어 다음 키의 창을 연다. 다섯 자리만 그 자리에서 보므로 긴 줄을 훑지 않는다
 */
function rescanFrom(line: string, at: number): number {
  for (let b = Math.max(0, at - 5); b < at; b++) if (pemBeginAt(line, b)) return b;
  return at;
}

/**
 * 열린 창 안의 줄 하나를 걷는다 (리드 결정 S5-55): 시작 표시는 더하고, 열린 종류의 끝 표시는 뺀다. 열린 키가 0이 되는 표시에서 멈춰 그 뒤 글을 다시 볼
 * 자리를 돌려준다(창이 거기서 닫힌다) — 그 표시 바로 뒤, 그 표시의 끝 '-----'에서 시작 표시가 시작하면 그 시작 표시 자리(rescanFrom, 리드 결정 S5-85).
 * 닫히지 않으면 -1 — 그 줄은 창의 보통 줄이다. 값싼 검사(includes('PRIVATE KEY'))를 먼저 한다. 긴 줄은 걷기 상한을 둔 walk를 받는다 — 상한에 닿으면 그
 * 줄의 나머지를 걷지 않으므로 창을 출력 끝까지 연다 (리드 결정 S5-65). 끝 표시 뒤의 시작 표시는 그 끝 표시의 끝 '-----'부터 찾는다 (리드 결정 S5-79·S5-85)
 */
function closeAtIn(k: OpenKeys, line: string, limited?: PemMarkers): number {
  if (k.sticky || !line.includes('PRIVATE KEY')) return -1;
  const walk = limited ?? new PemMarkers(line);
  for (let m = walk.next(); m; m = walk.next()) {
    if (m.begin) openKey(k, m.end);
    else if (closeKey(k, m.end) && k.total === 0) return rescanFrom(line, m.index + m.length);
    if (k.sticky) return -1;
  }
  if (walk.capped) stick(k);
  return -1;
}

/**
 * 열린 개인 키 창 (리드 결정 S5-35·S5-43·S5-48·S5-55). lines가 있으면 담는 중(첫 줄은 시작 표시부터의 글, null은 창 안에서 버린 긴 줄의 자리표), null이면
 * 담는 상한에 닿아 흘려 보내는 중이다 — 그때는 아무것도 담지 않는다
 */
interface PemWindow {
  /** 창에 열려 있는 키 — 모두 닫히는 끝 표시에서 창이 닫힌다 (리드 결정 S5-55) */
  keys: OpenKeys;
  lines: (string | null)[] | null;
  bytes: number;
  /** 첫 줄에서 시작 표시의 길이 — 흘려 보낼 때 그 뒤 글만 본다 */
  markerLength: number;
  /** 흘려 보내며 버린 본문으로 보이는 줄 수 */
  hidden: number;
}

/**
 * 창 밖의 긴 줄을 그 자리에서 걷는다 (리드 결정 S5-43·S5-55) — 줄이 끝날 때 열린 키가 남으면 그 키들과, 마지막으로 열린 구간의 첫 시작 표시 글(표시만
 * 따로 베낀다 — 긴 줄을 붙잡지 않게, S5-66). 남지 않으면 null. 표시를 limit개 걸은 뒤에도 표시가 더 있으면 그 줄의 나머지는 걷지 않고 출력 끝까지 여는 창을
 * 돌려준다 — 그때 열린 키가 없었으면 첫 줄은 빈 글이다 (리드 결정 S5-65). 끝 표시 뒤의 시작 표시는 키를 닫든 닫지 않든 그 끝 표시의 끝 '-----'부터
 * 찾는다 (리드 결정 S5-79·S5-85)
 */
function openAtLineEnd(line: string, limit: number): { keys: OpenKeys; marker: string } | null {
  if (!line.includes('PRIVATE KEY')) return null;
  const keys = noKeys();
  const walk = new PemMarkers(line, 0, limit);
  let first: PemMarker | null = null;
  for (let m = walk.next(); m && !keys.sticky; m = walk.next()) {
    if (m.begin) {
      if (!isOpen(keys)) first = m;
      openKey(keys, m.end);
    } else closeKey(keys, m.end);
  }
  const marker = isOpen(keys) && first ? own(line.slice(first.index, first.index + first.length)) : null;
  if (walk.capped) {
    stick(keys);
    return { keys, marker: marker ?? '' };
  }
  return marker !== null ? { keys, marker } : null;
}

/**
 * 출력 모으기 (리드 결정 S5-16·S5-35·S5-36): 받은 줄은 가리지 않고 그대로 앞 16KiB를 채우고 나머지는 뒤 48KiB로 굴린다 — 줄 단위로만 버리고 버린 바이트를
 * 센다. 앞에 다 들어가지 않는 한 줄은 뒤로 간다. 뒤 상한(48KiB)보다 긴 한 줄은 베끼지도 가리지도 않고 바로 버려 센다 — 아주 긴 한 줄(러너는 줄바꿈 없는 출력을
 * 32MiB마다 한 줄로 낸다)이 이벤트 루프를 막지 않게(긴급 정지 3초). 줄 단위로만 자르므로 한 줄 안의 비밀 값이 반으로 잘리지 않는다. 가리기는 text()에서 남긴
 * 글(64KiB 안)에 한 번 한다 — 그 사이에 가리개가 알게 된 값도 가린다. 창 안에서 남기는 글만은 남길 때 그 줄을 먼저 가린다(아래, 리드 결정 S5-78 — 줄마다
 * 뒤 상한 48KiB 안).
 * 여러 줄 개인 키는 창으로 가린다: 시작 표시(`-----BEGIN … PRIVATE KEY-----`)가 든 줄이 창을 열고(그 줄의 시작 표시 앞 글은 보통 줄), 한 창에는 열린 키가
 * 여럿일 수 있다(리드 결정 S5-55 — 표준 출력과 오류, 한 파이프의 두 프로세스, compose logs처럼 두 키의 줄이 섞인다). 창 안의 줄마다 값싼 검사를 하고, 걸린
 * 줄은 시작·끝 표시를 자리 차례로 걸어(PemMarkers) 끝 표시 종류마다 열린 키를 센다 — 열리지 않은 종류의 끝 표시는 보통 글이다. 창은 열린 키가 모두 닫히는
 * 끝 표시나 출력의 끝(스스로 끝남·시간 초과·정지)에서만 닫힌다 (리드 결정 S5-48·S5-55). 같은 걷기를 창 밖의 줄(scan)과 창을 여는 줄에도 해서 한 줄에서
 * 엇갈린 키도 창을 연다. 끝 표시 뒤의 시작 표시는 키를 닫든 닫지 않든 그 끝 표시의 끝 '-----'부터 찾는다 — 대시를 함께 쓰는 시작 표시도 센다(창을 닫은
 * 끝 표시 뒤라도. redactPem이 그 끝 표시를 보통 글로 보면 다음 키를 가리기 때문이다, 리드 결정 S5-79·S5-85). 종류 8개·열린 키 64개를 넘으면 세기를
 * 그만두고 출력 끝까지 연다(OpenKeys.sticky). 창이 열린 동안의 줄은 표준 출력·오류 가리지
 * 않고, 앞말(줄 번호·diff의 '-'·들여쓰기)이 붙어도 창에 담아 아직 남기지 않는다(담는 중). 담는 중에 창이 닫히면 창 전체가 '[가림:개인 키 — n줄]' 한 줄이
 * 된다. 담은 것이 400줄이나 32KiB에 닿으면 '[가림:개인 키 — 끝 줄 전까지 본문으로 보이는 줄은 가림]'을 남기고 흘려 보낸다: 담은 줄과 그 뒤 창이 닫힐
 * 때까지의 줄을 하나씩 보아 키 본문으로 보이는 줄(looksLikeKeyBody — 줄 끝이 base64 16자 넘게, 또는 채운 마지막 줄. 줄 끝의 색·따옴표·쉼표 등은 떼어
 * 본다)은 버려 세고 나머지는 남긴다. 창이 닫히면 '[가림:개인 키 끝 — 본문으로 보이는 n줄 가림]'. 어느 쪽이든 닫은 끝 표시 뒤 글은 처음부터 다시
 * 본다(이어 붙은 다음 키). 끝 표시 없이 출력이 끝나면 담은 줄을 같은 규칙으로 보고 '[가림:개인 키(끝 줄 없음) — n줄 가림]'(흘려 보내던 중이면 '…— 본문으로
 * 보이는 n줄 가림]')을 남긴다. 창을 연 줄(시작 줄)의 시작 표시 뒤 글을 흘려 보낼 때나 출력 끝에서 남기면 시작 표시와 함께 남긴다 — 보통 글이면 '[가림:개인
 * 키] …'로 남는다. 시작 표시 뒤가 비었거나 본문으로 보이면 남기지 않는다 (리드 결정 S5-61). 창 안에서 남기는 글(흘려 보내며 남기는 줄, 출력 끝에서 남기는
 * 줄과 시작 줄, 안쪽 시작 표시·닫지 않는 끝 표시가 든 줄, 걷기 상한에서 연 창의 첫 줄)은 남길 때 먼저 이 모으기의 가리개(백엔드 가리개)로 가리고, 그다음
 * base64 글자가 16자 넘게 이어진 곳을 모두 '[가림:개인 키 조각]'으로 바꾼다 (keepWindow — 리드 결정 S5-71·S5-78). 가리개가 먼저인 까닭: 16자 넘는 키
 * 이름(databasePassword)이나 URL 사용자(//applicationuser1234)도 이어짐이라, 조각 가리기가 먼저 돌면 가리개 규칙이 기대는 이름이 사라져 그 옆 값이 남는다.
 * 그래서 본문으로 보이는지의 짐작은 보여 주는 모양(버려 셀지, 가려 남길지)만 정하고, 두 불변식은 그 짐작에 기대지 않는다: ① 창 안에서 남긴 글에는 base64
 * 글자가 16자 넘게 이어진 곳이 없다 ② 날 출력 전체를 백엔드 가리개로만 가렸을 때 가려지는 비밀(개인 키 본문, 등록 값, JSON·YAML·XML·properties의 이름
 * 붙은 값, 명령 옵션, URL 비밀번호, wos_ 토큰)은 text()에서도 가려진다(S5-78) — 가리개의 규칙이 그 비밀이 찍힌 줄에서 알아보는 비밀이다: 흘려 보내는
 * 창의 줄은 저마다 따로 가리므로 창 안의 다른 줄에 기대는 규칙(창 안에서 두 줄로 갈린 값 등)은 그 줄에서 알아보지 못한다 — 담는 중이면 창 전체가 한
 * 표시라 괜찮다 (리드 결정 S5-86). 창 밖의 글과, 시작 표시 앞·창을 닫은 끝 표시 뒤의 같은 줄 글은 그대로다. 받아들인 예외는 흘려 보내는 중이나 출력 끝의
 * 16자보다 짧은 채우지 않은 마지막 줄(키를 다시 만들 수 없다), 열린 종류의 떠돌이 끝 표시(그 키를 일찍 닫는다 — 그 뒤 줄은 창 밖이다), UTF-16·NUL 출력,
 * 흘려 보내는 창에서 다른 줄의 문맥이 필요한 비밀(S5-86), 흘려 보내며 이미 남긴 줄에 든 값을 가리개가 그 뒤에야 알게 된 경우의 남은 조각이다(S5-87 1,
 * SERVER_DESIGN 8.2). 가리개가 던지면(이 모으기에 넘긴 가리개 — 백엔드 가리개는 던지지 않는다) 그 글을 '[가림:가리기 실패]'로 바꾼다: 남길 때는 그 줄,
 * text()에서는 모은 글 전체 (리드 결정 S5-83). 창에 담는 것은 많아야 32KiB와 긴 줄 자리표 400개이고, 개인 키 표시가 든 줄에서 떼어 남기는 조각(끝 표시 뒤 글,
 * 시작 표시 앞 글, 창의 첫 줄, 긴 줄 끝의 시작 표시)은 따로 베껴 그 줄을 붙잡지 않는다 (리드 결정 S5-66). 시작과 끝 표시가 한 줄에 다 든 키(JSON 문자열의
 * \n 등)는 그 자리를 '[가림:개인 키]'로 바꾼다.
 * 값싼 개인 키 검사는 긴 줄을 버리기 전에 모든 줄에 한다 (리드 결정 S5-43·S5-55): 창 밖의 긴 줄을 그 자리에서 걸어 줄 끝에 열린 키가 남으면(줄바꿈 없는
 * 압축 JSON 바로 뒤에 찍힌 키 파일) 시작 표시만 담은 창을 열고 줄은 버린다. 창 안의 긴 줄은 버리되 열린 키를 모두 닫는 끝 표시가 없으면 창을 닫지 않는다
 * (담는 중이면 자리표 한 줄로 센다). 긴 줄 하나에서는 표시를 1,024개(HOST_EXEC_PEM_LONG_MARKERS)까지만 걷고 — 닫은 끝 표시 뒤 글은 짧아도 길어도 그 줄에
 * 남은 수로 걷는다(리드 결정 S5-72) — 더 있으면 그 줄의 나머지는 걷지 않고 창을 출력 끝까지 연다(열린 창이 없으면 그 자리에서 연다 — 더 가리기만 한다,
 * 리드 결정 S5-65). 자동 검사도 이 출력 모으기를 쓴다 (리드 결정 S5-54)
 */
export class HostExecOutput {
  private readonly head: string[] = [];
  private headBytes = 0;
  private headFull = false;
  private readonly tail: string[] = [];
  private tailBytes = 0;
  /** 열린 개인 키 창 (없으면 null) */
  private window: PemWindow | null = null;
  omitted = 0;
  total = 0;

  constructor(private readonly redact: (s: string) => string) {}

  push(line: string): void {
    const n = bytes(line) + 1;
    this.total += n;
    if (n - 1 > HOST_EXEC_TAIL_BYTES) {
      this.pushLong(line, n);
      return;
    }
    const w = this.window;
    if (!w) {
      this.scan(line);
      return;
    }
    // 열린 키가 모두 닫히는 끝 표시에서만 창이 닫힌다 — 다른 시작 표시·열리지 않은 종류의 끝 표시가 든 줄은 창의 보통 줄이다 (리드 결정 S5-55)
    const at = closeAtIn(w.keys, line);
    if (at !== -1) {
      this.closeAtEnd(w);
      // 끝 표시 뒤 글(그 끝 '-----'에서 시작한 시작 표시부터 — S5-85)은 따로 베껴 다시 본다 — 남긴 조각이 그 줄을 붙잡지 않게 (리드 결정 S5-66)
      const after = line.slice(at);
      if (after) this.scan(own(after));
      return;
    }
    if (!w.lines) {
      this.judge(w, line);
      return;
    }
    w.lines.push(line);
    w.bytes += n;
    if (w.lines.length >= HOST_EXEC_PEM_WINDOW_LINES || w.bytes >= HOST_EXEC_PEM_WINDOW_BYTES) this.spill(w);
  }

  /**
   * 뒤 상한보다 긴 줄 (리드 결정 S5-36·S5-43·S5-55) — 베끼지도 가리지도 않고 버려 센다. 값싼 개인 키 검사(includes('PRIVATE KEY'), 그다음 표시 걷기 — 그
   * 자리에서 정규식으로)는 먼저 한다. 창 안: 열린 키가 모두 닫히는 끝 표시가 있으면 창을 닫고(그 줄은 창의 한 줄이다) 그 표시 뒤 글을 다시 본다. 없으면 줄을
   * 버리되 창은 닫지 않는다 — 담는 중이면 자리표 한 줄(LONG_IN_WINDOW_BYTES)로 센다. 창 밖: longOutside. 표시는 그 줄 전체에서 HOST_EXEC_PEM_LONG_MARKERS개까지만
   * 걷는다 — 상한에 닿으면 창은 출력 끝까지 열린다 (리드 결정 S5-65)
   */
  private pushLong(line: string, n: number): void {
    const w = this.window;
    if (!w) {
      this.longOutside(line, n, HOST_EXEC_PEM_LONG_MARKERS);
      return;
    }
    const walk = new PemMarkers(line, 0, HOST_EXEC_PEM_LONG_MARKERS);
    const at = closeAtIn(w.keys, line, walk);
    if (at === -1) {
      this.dropLong(n);
      if (w.lines) {
        w.lines.push(null);
        w.bytes += LONG_IN_WINDOW_BYTES;
        if (w.lines.length >= HOST_EXEC_PEM_WINDOW_LINES || w.bytes >= HOST_EXEC_PEM_WINDOW_BYTES) this.spill(w);
      }
      return;
    }
    this.closeAtEnd(w);
    // 닫은 표시 뒤 글(그 끝 '-----'에서 시작한 시작 표시부터 — S5-85) — 그 줄에 남은 걷기 상한으로 본다(짧아도 길어도 한 줄에서 1,024개, 리드 결정
    // S5-65·S5-72). 짧으면 따로 베껴(남긴 조각이 긴 줄을 붙잡지 않게, S5-66) 보통 줄처럼 다시 보고, 그것도 길면 창 밖의 긴 줄로 다룬다 (slice는 긴 글을
    // 베끼지 않는다)
    const after = line.slice(at);
    if (!after) return;
    const rest = bytes(after) + 1;
    const left = HOST_EXEC_PEM_LONG_MARKERS - walk.count;
    if (rest - 1 > HOST_EXEC_TAIL_BYTES) this.longOutside(after, rest, left);
    else this.scan(own(after), left);
  }

  /**
   * 창 밖의 긴 줄: 버린다. 줄 끝에서 열린 키가 남으면(끝 표시가 뒤따르지 않는 시작 표시, 한 줄 안의 엇갈린 키) 그 키들로 창을 연다 — 첫 줄은 마지막으로 열린
   * 구간의 시작 표시 글만이다. 그 뒤 줄의 본문을 창에 담는다 (리드 결정 S5-43·S5-55). 표시를 limit개 걸은 뒤에도 더 있으면 그 줄의 나머지는 걷지 않고 출력
   * 끝까지 여는 창을 연다(열린 키가 없었으면 첫 줄은 빈 글) (리드 결정 S5-65)
   */
  private longOutside(line: string, n: number, limit: number): void {
    const open = openAtLineEnd(line, limit);
    this.dropLong(n);
    if (open) this.window = { keys: open.keys, lines: [open.marker], bytes: bytes(open.marker) + 1, markerLength: open.marker.length, hidden: 0 };
  }

  /**
   * 창 밖의 줄 하나 (리드 결정 S5-55) — 시작·끝 표시를 자리 차례로 걸으며 열린 키를 센다. 열린 키가 없던 데서 열려 다시 0이 되는 구간(한 줄에 다 든 키 —
   * JSON 문자열의 \n 등)은 그 자리를 '[가림:개인 키]'로 바꾼다. 열린 키가 없을 때의 끝 표시는 보통 글이다. 줄이 끝날 때 열린 키가 남으면(끝 표시가 그 줄에
   * 없는 시작 표시, `BEGIN A … BEGIN B … END A`처럼 한 줄에서 엇갈린 키) 그 구간의 첫 시작 표시 앞 글을 남기고 그 키들로 창을 연다. 남기는 글과 창의 첫 줄은
   * 따로 베낀다 — 그 줄에서 떼어 낸 조각이 줄을 붙잡지 않게 (리드 결정 S5-66). limit은 긴 줄의 닫은 표시 뒤 짧은 글이 받는 그 줄의 남은 걷기 상한이다 —
   * 거기에 닿으면 그 자리에서 창을 출력 끝까지 연다: 열린 키가 있으면 그 구간의 첫 시작 표시부터, 없으면 걷기가 멈춘 자리부터가 창의 첫 줄이다
   * (리드 결정 S5-65·S5-72). 끝 표시 뒤의 시작 표시는 키를 닫든 닫지 않든 그 끝 표시의 끝 '-----'부터 찾는다 — 그 대시를 함께 쓰는 시작 표시도 창을
   * 연다 (리드 결정 S5-79·S5-85)
   */
  private scan(line: string, limit = Infinity): void {
    if (!line.includes('PRIVATE KEY')) {
      this.keep(line);
      return;
    }
    const keys = noKeys();
    const walk = new PemMarkers(line, 0, limit);
    let kept = '';
    let from = 0;
    let first: PemMarker | null = null;
    for (let m = walk.next(); m && !keys.sticky; m = walk.next()) {
      if (m.begin) {
        if (!isOpen(keys)) {
          kept += line.slice(from, m.index);
          first = m;
        }
        openKey(keys, m.end);
      } else if (closeKey(keys, m.end) && keys.total === 0) {
        // 그 끝 표시의 끝 '-----'에서 시작하는 시작 표시는 다음 걸음에 온다(그 자리가 from 앞이라 남기는 글에 대시를 더하지 않는다, 리드 결정 S5-85)
        kept += PRIVATE_KEY_MARK;
        from = m.index + m.length;
        first = null;
      }
    }
    // 그 줄에 남은 걷기 상한에 닿았다 — 나머지는 걷지 않고 창을 출력 끝까지 연다 (리드 결정 S5-72)
    if (walk.capped) stick(keys);
    if (!isOpen(keys)) {
      // 가린 자리가 없으면 줄 그대로다 — 베낄 조각이 없다
      this.keep(from === 0 && !kept ? line : own(kept + line.slice(from)));
      return;
    }
    // 창을 여는 자리 — 열린 키가 있으면 그 구간의 첫 시작 표시, 없으면(상한에 닿음) 걷기가 멈춘 자리. 그 앞 글은 보통 줄이다 — 들여쓰기뿐이면 남기지 않는다
    const at = first ? first.index : walk.stopAt;
    if (!first) kept += line.slice(from, at);
    if (kept.trim()) this.keep(own(kept));
    const open = own(line.slice(at));
    const w: PemWindow = { keys, lines: [open], bytes: bytes(open) + 1, markerLength: first ? first.length : 0, hidden: 0 };
    this.window = w;
    // 시작 줄의 시작 표시 뒤 글만으로 담는 상한에 닿으면 바로 흘려 보낸다 (리드 결정 S5-48)
    if (w.bytes >= HOST_EXEC_PEM_WINDOW_BYTES) this.spill(w);
  }

  /**
   * 흘려 보내는 창의 줄 하나 — 키 본문으로 보이면 버려 세고, 아니면 가리개로 가린 뒤 base64 이어짐을 가려 남긴다 (리드 결정 S5-48·S5-71·S5-78). 안쪽 시작
   * 표시나 닫지 않는 끝 표시가 든 줄도 여기로 온다
   */
  private judge(w: PemWindow, line: string): void {
    if (looksLikeKeyBody(line)) w.hidden++;
    else this.keepWindow(line);
  }

  /**
   * 담는 상한(400줄·32KiB)에 닿은 창 — 닫지 않고 흘려 보내기로 바꾼다 (리드 결정 S5-48): 표시 한 줄, 그다음 담은 줄을 차례로 judge한다. 시작 줄은 시작 표시 뒤
   * 글로 판정하고(비었으면 건너뛴다), 남길 때는 시작 표시와 함께(리드 결정 S5-61) 가리개로 가린 뒤 base64 이어짐을 가려 남긴다(리드 결정 S5-71·S5-78).
   * 긴 줄의 자리표는 남기지 않는다 — 그 줄은 이미 생략으로 셌다
   */
  private spill(w: PemWindow): void {
    const lines = w.lines;
    if (!lines) return;
    w.lines = null;
    this.keep(PRIVATE_KEY_SPILL_MARK);
    lines.forEach((l, i) => {
      if (l === null) return;
      if (i > 0) {
        this.judge(w, l);
        return;
      }
      const after = l.slice(w.markerLength);
      if (!after.trim()) return;
      if (looksLikeKeyBody(after)) w.hidden++;
      else this.keepWindow(l);
    });
  }

  /** 끝 표시가 창을 닫는다 — 담는 중이면 창 전체가 한 줄(끝 줄 포함 n줄), 흘려 보내던 중이면 끝 표시 (끝 표시가 든 줄은 창의 줄이다) */
  private closeAtEnd(w: PemWindow): void {
    this.window = null;
    this.keep(w.lines ? privateKeyWindowMark(w.lines.length + 1) : privateKeySpillEndMark(w.hidden));
  }

  /**
   * 출력이 끝날 때 열려 있던 창 (리드 결정 S5-48 — 시간 초과·정지도 같다). 담는 중이면 표시 한 줄, 그다음 담은 줄을 judge와 같은 규칙으로 보아 키 본문으로
   * 보이지 않는 줄만 가리개로 가린 뒤 base64 이어짐을 가려 남긴다(리드 결정 S5-71·S5-78) — 표시의 n은 남기지 않은 창의 줄(시작 줄·본문으로 보이는 줄·긴
   * 줄의 자리표) 수. 시작 줄은 시작 표시 뒤 글이 비지 않고 본문으로 보이지 않으면 시작 표시와 함께(리드 결정 S5-61) 가려 남긴다 — 보통 글은 '[가림:개인 키]
   * …'로 남는다. 흘려 보내던 중이면 버린 줄 수를 적은 표시만
   */
  private closeAtOutputEnd(): void {
    const w = this.window;
    if (!w) return;
    this.window = null;
    if (!w.lines) {
      this.keep(privateKeySpillUnterminatedMark(w.hidden));
      return;
    }
    const first = w.lines[0]!;
    const after = first.slice(w.markerLength);
    const rest = w.lines.slice(1);
    const kept = rest.filter((l): l is string => l !== null && !looksLikeKeyBody(l));
    this.keep(privateKeyUnterminatedMark(1 + rest.length - kept.length));
    if (after.trim() && !looksLikeKeyBody(after)) this.keepWindow(first);
    for (const l of kept) this.keepWindow(l);
  }

  /** 뒤 상한보다 긴 줄을 버린다 — 생략 표시가 거짓이 되지 않게 앞을 닫고 그 앞의 뒤 줄도 함께 버린다(뒤는 늘 출력의 이어진 끝이다) */
  private dropLong(n: number): void {
    this.headFull = true;
    while (this.tail.length) this.dropTail();
    this.omitted += n;
  }

  /**
   * 창 안에서 남기는 글 하나 (리드 결정 S5-71·S5-78) — 이 모으기의 가리개(백엔드 가리개)로 먼저 가리고, 그다음 base64 16자 넘는 이어짐을 '[가림:개인 키
   * 조각]'으로 바꿔 남긴다. 가리개가 먼저라 키 이름·URL 사용자에 기대는 규칙이 그 옆 값을 가린 뒤에 이름이 조각 표시로 바뀐다. text()의 마지막 가리기는
   * 그대로 한 번 더 한다 — 남긴 뒤에 가리개가 알게 된 값도 가린다. 16자 넘는 이어짐이 없는 글은 조각 가리기가 바꿀 것이 없어 그대로 남긴다 — 마지막
   * 가리기 한 번이 남길 때의 가리기와 같은 일을 앞뒤 줄까지 보며 하고(같은 값을 가린다), 창 안의 짧은 줄이 쏟아질 때 줄마다 가리개를 돌리지 않는다.
   * 남기는 글은 뒤 상한(48KiB)보다 짧은 줄이다(긴 줄은 버린다). 가리개가 던지면 그 줄은 '[가림:가리기 실패]'로 남긴다 (리드 결정 S5-83)
   */
  private keepWindow(text: string): void {
    this.keep(HAS_WINDOW_RUN.test(text) ? maskWindowText(this.redactOrMark(text)) : text);
  }

  /**
   * 이 모으기의 가리개로 가린 글 — 가리개가 던지면 그 글 전체 대신 '[가림:가리기 실패]' (리드 결정 S5-83). 실패해도 닫힌 쪽이다: 가리지 못한 글은 남기지
   * 않고, 모으기와 그 뒤의 기록(실행 기록·남은 프로세스 접기·활동 기록·일지)은 이어진다. 백엔드 가리개는 스스로 던지지 않으므로 이 갈래는 그 밖의 가리개를
   * 넘겼을 때의 마지막 방어다
   */
  private redactOrMark(s: string): string {
    try {
      return this.redact(s);
    } catch {
      return REDACT_FAILED_MARK;
    }
  }

  /** 줄 하나를 앞·뒤에 넣는다 (가리기는 text()에서 — 창 안의 글은 keepWindow가 남기기 전에도) */
  private keep(line: string): void {
    const n = bytes(line) + 1;
    if (!this.headFull && this.headBytes + n <= HOST_EXEC_HEAD_BYTES) {
      this.head.push(line);
      this.headBytes += n;
      return;
    }
    this.headFull = true;
    this.tail.push(line);
    this.tailBytes += n;
    while (this.tailBytes > HOST_EXEC_TAIL_BYTES && this.tail.length) this.dropTail();
  }

  private dropTail(): number {
    const d = bytes(this.tail.shift()!) + 1;
    this.tailBytes -= d;
    this.omitted += d;
    return d;
  }

  /**
   * 모은 글을 가린 것 — 버린 줄이 있으면 그 자리에 '…(n바이트 생략)…'. 출력이 끝날 때 열려 있던 창은 끝 줄 없는 창으로 닫는다(시간 초과·정지도 같다).
   * 가린 표시가 원문보다 길어 상한을 넘으면(아주 짧은 등록 값) 뒤의 앞줄을 넘친 만큼, 다시 넘치면 그 두 배씩 더 버린다 — 64KiB 가리기를 줄 수만큼 되풀이하지
   * 않게 (리드 결정 S5-36). 가리개가 던지면 모은 글 전체가 '[가림:가리기 실패]'다 — 이 함수는 던지지 않는다 (리드 결정 S5-83)
   */
  text(): string {
    this.closeAtOutputEnd();
    let step = 0;
    for (;;) {
      const parts = this.omitted > 0 ? [...this.head, `…(${this.omitted}바이트 생략)…`, ...this.tail] : [...this.head, ...this.tail];
      const out = this.redactOrMark(parts.join('\n'));
      const over = bytes(out) - (HOST_EXEC_HEAD_BYTES + HOST_EXEC_TAIL_BYTES + 64);
      if (over <= 0 || !this.tail.length) return out;
      step = Math.max(over, step * 2);
      for (let dropped = 0; dropped < step && this.tail.length; ) dropped += this.dropTail();
    }
  }
}

export class HostExecService {
  /** 실행 중인 서버 명령 (실행 기록 ID →) */
  private readonly running = new Map<string, Running>();
  /** 앞선 host_exec가 종료를 확인하지 못한 턴 — 그 턴에는 더 받지 않는다 (리드 결정 S5-17) */
  private readonly unconfirmedTurns = new Set<string>();

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 실행 중인 서버 명령 수 — 진행 중 작업(절전 방지·종료 확인, hasActiveWork)에 센다 */
  count(): number {
    return this.running.size;
  }

  /**
   * 실행 위치 (리드 결정 S5-17·S5-31): 주지 않으면(null) 메인 작업 폴더. 상대 경로·없는 폴더·Windows 로컬 드라이브가 아닌 경로는 invalid, 데이터 폴더·보관하지 않은
   * 프로젝트 폴더·그 연결 지점이 닿는 폴더와 같거나 그 안이거나 그 폴더를 품으면 forbidden. 이 검사는 cwd만 본다 — 격리가 아니다.
   * 절대 경로인지 본 뒤로는 resolve한 경로(C:/…·C:\a\..\b를 C:\…로 — 프로젝트 등록과 같다)로 보고, 띄우고, 기록하고, 돌려준다. given은 다듬은 글이고
   * 비밀 값 검사를 이미 거쳤다(run)
   */
  private resolveCwd(given: string | null): string {
    if (given === null) {
      const main = this.core.mainWork;
      if (main.problem) {
        throw new BackendError('forbidden', `메인 작업 폴더를 쓸 수 없어 기본 실행 위치가 없습니다 — ${main.problem}. 실행할 폴더를 cwd로 주세요`);
      }
      const why = this.guardProblem(main.dir);
      if (why) throw new BackendError('forbidden', `기본 실행 위치인 메인 작업 폴더(${main.dir})가 ${withRa(why)} 쓰지 않습니다 — 실행할 폴더를 cwd로 주세요`);
      return main.dir;
    }
    if (!isAbsolute(given)) throw new BackendError('invalid', `cwd는 절대 경로여야 합니다: ${clip(given, 200)}`);
    const cwd = resolve(given);
    // resolve가 바꾼 철자도 비밀 값 꼴이면 받지 않는다 — 실행 기록·결과·중복 캐시에 남는 것은 이 경로다
    if (this.ctx.redact.text(cwd) !== cwd) throw new BackendError('forbidden', HOST_EXEC_CWD_SECRET_REFUSAL);
    const bad = winPathProblem(cwd);
    // 글의 '로컬 폴더'와 예시는 OS마다 — Windows는 예전 글 그대로 (리드 결정 S10-6.6)
    const local = localFolderWords();
    if (bad) throw new BackendError('invalid', `cwd는 ${local.folder}(예: ${local.example})여야 합니다 — ${bad}는 쓸 수 없습니다: ${clip(cwd, 200)}`);
    let isDir = false;
    try {
      isDir = existsSync(cwd) && statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new BackendError('invalid', `cwd 폴더가 없습니다: ${clip(cwd, 200)}`);
    const why = this.guardProblem(cwd);
    if (why) throw new BackendError('forbidden', `cwd가 ${withRa(why)} 실행하지 않았습니다 — 프로젝트 파일은 지시 → 프로듀서 → 팀원 작업 폴더 → 검수 → 병합으로만 바꿉니다. 이 검사는 실행 위치만 봅니다`);
    return cwd;
  }

  /** cwd가 막힌 폴더와 겹치면 그 까닭 (같음·그 안·그 폴더를 품은 상위 폴더 — relation) */
  private guardProblem(cwd: string): string | null {
    const ctx = this.ctx;
    const what = { same: '', inside: ' 안', contains: '를 품은 상위 폴더' } as const;
    const data = relation(cwd, ctx.paths.root);
    if (data) return `앱 데이터 폴더(${ctx.paths.root})${what[data]}`;
    for (const p of ctx.store.projects.list()) {
      if (p.archivedAt) continue;
      const rel = relation(cwd, p.path);
      if (rel) return `등록된 프로젝트 폴더(${p.id} ${p.name})${what[rel]}`;
      for (const t of this.core.projects.linkTargets(p.id)) {
        const r = relation(cwd, t);
        if (r) return `프로젝트(${p.id} ${p.name})가 연결 지점으로 닿는 폴더(${t})${what[r]}`;
      }
    }
    return null;
  }

  /**
   * host_exec 처리 (도구 처리기 — tools.run이 원래 인자(raw)와 가린 인자(safe)를 함께 넘긴다). seatRecheck: 러너 준비를 기다린 뒤 이 호출을 받은 자리 세대를 다시
   * 본다 — 그사이 자리가 바뀌었으면 seat_changed로 띄우지 않는다. 부른 턴은 아래에서 제 글로 다시 본다 (리드 결정 S5-63)
   */
  async run(identity: TokenIdentity, member: Member, raw: Args, safe: Args, requestId: string | null, seatRecheck?: () => void): Promise<HostExecResult> {
    const ctx = this.ctx;
    if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
    if (raw.background !== undefined && raw.background !== false) {
      throw new BackendError('invalid', '백그라운드 실행(background)은 6단계에서 붙습니다 — 지금은 명령이 끝날 때까지 기다리는 실행만 됩니다');
    }
    const command = typeof raw.command === 'string' ? raw.command : '';
    if (!command.trim()) throw new BackendError('invalid', 'command(실행할 명령)를 주세요');
    if (command.length > HOST_EXEC_COMMAND_MAX) throw new BackendError('invalid', `command는 ${HOST_EXEC_COMMAND_MAX.toLocaleString('ko-KR')}자까지입니다 (지금 ${command.length}자)`);
    const purpose = (typeof safe.purpose === 'string' ? safe.purpose : '').trim();
    if (!purpose) throw new BackendError('invalid', 'purpose(이 명령을 돌리는 까닭)를 적으세요 — 활동 기록과 메인 일지에 남습니다');
    if (purpose.length > HOST_EXEC_PURPOSE_MAX) throw new BackendError('invalid', `purpose는 ${HOST_EXEC_PURPOSE_MAX}자까지입니다`);
    if (!requestId) throw new BackendError('invalid', 'request_id를 주세요 — 같은 호출을 다시 보내도 명령(설치 등)이 두 번 돌지 않게 합니다');
    const timeoutS = raw.timeout_s === undefined ? HOST_EXEC_DEFAULT_TIMEOUT_S : raw.timeout_s;
    if (typeof timeoutS !== 'number' || !Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > HOST_EXEC_MAX_TIMEOUT_S) {
      throw new BackendError('invalid', `timeout_s는 1~${HOST_EXEC_MAX_TIMEOUT_S} 사이의 정수(초)입니다`);
    }
    if (raw.cwd !== undefined && raw.cwd !== null && typeof raw.cwd !== 'string') throw new BackendError('invalid', 'cwd는 폴더의 절대 경로 글이어야 합니다');
    // 여기까지는 인자 모양만 본다 — 명령과 cwd를 되풀이하는 글이 없다. 그다음 비밀 값: 명령과 다듬은 cwd를, 그 둘을 되풀이할 수 있는 검사(cwd 모양·있는지·실행
    // 위치·거부 목록의 걸린 조각)보다 먼저 본다 (리드 결정 S5-31). 비밀 값이 든 명령은 돌리지 않는다 — 가린 글을 돌리면 다른 명령이 되고, 원문을 돌리면 기록과
    // 다른 명령이 돈다 (S5-17)
    if (ctx.redact.text(command) !== command) throw new BackendError('forbidden', HOST_EXEC_SECRET_REFUSAL);
    const given = raw.cwd === undefined || raw.cwd === null || raw.cwd === '' ? null : (raw.cwd as string).trim();
    if (given !== null && ctx.redact.text(given) !== given) throw new BackendError('forbidden', HOST_EXEC_CWD_SECRET_REFUSAL);
    const cwd = this.resolveCwd(given);
    const shell = process.platform === 'win32' ? 'cmd' : 'posix';
    const denied = hostCommandDenied(command, { serverPid: process.pid, serverImage: basename(process.execPath), dataDir: ctx.paths.root, shell });
    if (denied) throw new BackendError('forbidden', hostCommandRefusal(denied, shell));
    // 같은 request_id는 한 번만 돈다 (AC-45): 끝난 호출은 도구 중복 캐시(7일)가 답하고, 캐시가 없는 경우(서버 재시작으로 끊긴 호출, 7일이 지난 호출)도 실행 기록으로
    // 보고 다시 돌리지 않는다 — 같은 세대 안에서 (리드 결정 S4-4, S5-16). 띄우지도 못한 호출(러너가 던짐 — PID 칸이 없다)은 돈 적이 없어 다시 받는다
    const generation = identity.isMain ? (identity.seatGeneration ?? this.core.seat.generation()) : null;
    const ran = (x: ExecRecord): boolean => x.state === 'started' || 'pid' in x.result || x.result.recovered === 'interrupted_by_restart';
    const earlier = ctx.store.execs.list({ ref2: 'host_exec' }).find((x) => x.result.toolRequestId === requestId && (x.result.generation ?? null) === generation && ran(x));
    if (earlier) {
      const cut = earlier.result.recovered === 'interrupted_by_restart';
      throw new BackendError(
        'conflict',
        `이 request_id(${requestId})의 서버 명령은 이미 ${earlier.state === 'started' ? '돌고 있습니다' : cut ? '돌다가 서버 재시작으로 끊겼습니다' : '한 번 돌았습니다'} (${earlier.requestId}) — 같은 명령을 다시 돌리려면 새 request_id를 쓰세요`,
      );
    }
    // 띄우기 전 거부 (리드 결정 S5-17) — 실행 환경 문제의 종류마다 맞는 사실 (S6-5)
    const problem = ctx.deps.runner.problem?.() ?? null;
    if (problem?.kind === 'binary_changed') {
      throw new BackendError(
        'conflict',
        `작업 개체 러너 파일이 준비할 때와 달라 이 명령을 띄우지 않았습니다 — ${problem.text}. 서버가 원본에서 다시 컴파일해 다시 쓸 수 있게 되면 다시 하세요`,
      );
    }
    if (problem) {
      throw new BackendError(
        'conflict',
        `이 실행 환경에서는 명령이 띄운 하위 프로세스가 모두 끝났는지 확인할 수 없어 실행하지 않았습니다 — 작업 개체 도우미를 쓸 수 없음: ${problem.text}. 실행 환경이 고쳐진 뒤 다시 하세요`,
      );
    }
    this.assertCanStart(identity);
    // 이 PC의 CPU가 상한(95%) 이상이면 명령을 띄우지 않고 내려갈 때까지 미룬다 — 높다고 돌려보내지 않는다 (대표 지시 2026-11-18, cpuGuard.ts). 턴의 남은
    // 시간은 기다린 뒤에 잰다. 기다리는 사이의 정지·자리 교체·턴 끝은 아래 검사가 그 까닭으로 거부한다
    const cpuDelayedMs = await this.delayForCpu(identity, purpose);
    const s = ctx.settings().execution;
    const live = this.core.turns.hostExecTurn(identity.turnId);
    const turnLeftMs = live ? s.turnTimeoutMin * 60_000 - (ctx.clock.ms() - live.startedMs) - TURN_MARGIN_MS : Number.POSITIVE_INFINITY;
    const timeoutMs = Math.min(timeoutS * 1000, s.commandMaxMin * 60_000, turnLeftMs);
    if (timeoutMs < 1000) throw new BackendError('conflict', `이 턴의 시간 상한(${s.turnTimeoutMin}분)까지 30초도 남지 않아 실행하지 않았습니다 — 다음 턴에서 하세요`);
    // 러너가 띄우자마자 하위 프로세스를 추적할 수 있을 때까지 (taskkill 방식의 작업 개체 도우미) — 정지 확인보다 먼저
    await ctx.deps.runner.ready?.();
    // 여기부터 실행 등록까지 await가 없다 — 뒤에 오는 정지(긴급 정지·턴 끝·자리 교체·앱 종료)는 실행 중 목록에서 반드시 찾는다 (리드 결정 S5-18).
    // 기다리는 사이 자리가 바뀌었으면(세대가 넘어감) 교체 중 거부보다 먼저 seat_changed (리드 결정 S5-63)
    seatRecheck?.();
    this.assertCanStart(identity);
    const stop = ctx.stop();
    if (stop.global.active) throw new BackendError('stopped', '긴급 정지 중에는 이 도구를 쓸 수 없습니다. 턴을 마치세요');
    if (stop.members[MAIN_AGENT_ID]?.paused) throw new BackendError('stopped', '팀원 일시정지 중에는 이 도구를 쓸 수 없습니다. 턴을 마치세요');
    // 부른 턴이 그사이 끝나기 시작했으면(마무리가 실행 중 목록을 이미 거뒀을 수 있다) 띄우지 않는다. 턴 기록이 없는 신원(프로세스 안 시험)은 턴을 보지 않는다
    const turn = ctx.store.turns.get(identity.turnId);
    const liveNow = this.core.turns.hostExecTurn(identity.turnId);
    if (turn && (turn.endedAt || turn.process.stopMode === 'immediate' || !liveNow || liveNow.stopping)) {
      throw new BackendError('stopped', '이 턴의 종료 요청 뒤에는 서버 명령을 시작하지 않습니다. 지금 턴을 마치세요');
    }
    if (this.core.stopping) throw new BackendError('stopped', '앱을 끝내는 중이라 서버 명령을 시작하지 않았습니다');
    const projectId = identity.workProjectId ?? workProjectOf(ctx, identity.sessionKey);
    const t0 = ctx.clock.ms();
    const out = new HostExecOutput((t) => ctx.redact.text(t));
    const pre = { toolRequestId: requestId, turnId: identity.turnId, sessionKey: identity.sessionKey, generation, timeoutS };
    // 기록(실행 기록·활동 기록·일지)과 남은 프로세스 접기까지 끝나면 풀린다 — 턴 마무리(settleTurn)가 이것을 기다린다
    let markFinished!: () => void;
    const finished = new Promise<void>((done) => (markFinished = done));
    const slot: { run: Running | null } = { run: null };
    try {
      const result = await recordedExec(
        ctx,
        { kind: 'host_exec', projectId, taskId: null, cwd, command, target: clip(purpose, 200), pre },
        async (rid) => {
          const sh = shellCommand(command);
          const proc = ctx.deps.runner.start({
            command: sh.command,
            args: sh.args,
            verbatimArgs: sh.verbatimArgs,
            consoleOutput: sh.consoleOutput,
            ...(sh.adoptGate ? { adoptGate: sh.adoptGate } : {}),
            cwd,
            env: buildHostExecEnv(process.env),
            stdinText: null,
            label: `${HOST_EXEC_LABEL_PREFIX}${rid}: ${clip(command, 80)}`,
          });
          const run: Running = { execId: rid, toolRequestId: requestId, turnId: identity.turnId, proc, stopReason: null, timedOut: false, stopPromise: null, finished };
          slot.run = run;
          this.running.set(rid, run);
          // 턴 감시가 응답 없음(10분) 대신 명령 상한을 쓰게 한다 — 앱 도구 호출 동안 CLI는 출력이 없다 (리드 결정 S5-18)
          this.core.turns.noteHostCommand(identity.turnId, rid, true);
          // 재시작 복구가 이 프로세스 트리를 찾게 PID와 OS 시계의 시작 시각을 바로 남긴다
          // Linux는 부팅 기준 신원(start)도 남긴다 — 복구가 벽시계와 상관없이 정확히 대조한다 (S10-5.1)
          const spawned = { pid: proc.pid, spawnedAt: proc.pid !== null ? new Date().toISOString() : null, ...(proc.start ? { start: proc.start } : {}), ...(proc.runTag ? { runTag: proc.runTag } : {}) };
          const rec = ctx.store.execs.get(rid);
          if (rec) ctx.store.execs.put({ ...rec, result: { ...rec.result, ...spawned } });
          ctx.bus.changed();
          ctx.activity({
            kind: 'exec',
            actor: MAIN_AGENT_ID,
            memberId: MAIN_AGENT_ID,
            projectId,
            sessionId: identity.sessionId,
            turnId: identity.turnId,
            requestId: rid,
            text: `메인 에이전트 서버 명령 시작 (host_exec ${rid}) — 목적: ${clip(purpose, 300)} — ${cwd}: ${clip(command, 300)}`,
          });
          proc.onStdoutLine((l) => out.push(l));
          proc.onStderrLine((l) => out.push(l));
          const timer = setTimeout(() => {
            // 정지(긴급 정지·턴 끝·자리 교체·앱 종료)가 이미 끝내는 중이면 그 까닭을 지킨다 — 시간 초과로 적지 않는다 (리드 결정 S5-33)
            if (run.stopPromise) return;
            run.timedOut = true;
            void this.kill(run, null);
          }, timeoutMs);
          try {
            const exit = await proc.exited;
            // 프로그램이 끝낸 실행이면 그 종료 확인 결과 — 프로세스는 같은 약속을 돌려준다
            const stopRes = exit.terminated ? await proc.terminate() : null;
            const leftover = exit.remaining !== 0 ? exit.remaining : stopRes && !stopRes.ok ? (stopRes.remaining > 0 ? stopRes.remaining : -1) : 0;
            const leftoverDetail = leftover === 0 ? null : stopRes && !stopRes.ok ? stopRes.detail : (exit.detail ?? null);
            // 출력은 try 안에서 — 가리기가 실패해도 그 글만 표시가 되고 실행 기록(PID 포함)·남은 프로세스 접기·끝 활동 기록·일지는 이어진다 (리드 결정 S5-83)
            let output: string;
            try {
              output = out.text();
            } catch {
              output = REDACT_FAILED_MARK;
            }
            const durationMs = ctx.clock.ms() - t0;
            const stopped: HostExecStop | null = exit.terminated && !run.timedOut ? (run.stopReason ?? '턴 종료') : null;
            const ok = exit.code === 0 && !run.timedOut && !exit.terminated && leftover === 0;
            return {
              value: { execId: rid, code: exit.code, leftover, leftoverDetail, output, durationMs, stopped, timedOut: run.timedOut },
              result: {
                ...spawned,
                exitCode: exit.code,
                timedOut: run.timedOut,
                terminated: exit.terminated,
                ...(stopped ? { stopReason: stopped } : {}),
                ...(leftover !== 0 ? { remaining: leftover, leftoverDetail } : {}),
                durationMs,
                outputBytes: out.total,
                // 가린 글에서 자른다 — 원문을 자르면 한 줄에 다 든 키의 시작 표시가 잘려 나가 본문이 남을 수 있다 (리드 결정 S5-29·S5-35)
                outputTail: output.slice(-HOST_EXEC_RECORD_TAIL),
              },
              failed: !ok,
            };
          } finally {
            clearTimeout(timer);
          }
        },
      ).catch((e: unknown) => {
        if (e instanceof BackendError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        // 실행 기록은 recordedExec이 저장된 기록(PID·띄운 시각 포함)에서 실패로 남겼다. '띄우지 못했습니다'는 러너가 던져 띄우지도 못했을 때만 — 띄운 뒤의
        // 오류는 그 명령이 돌았을 수 있다고 말한다 (리드 결정 S5-83)
        if (!slot.run) throw new BackendError('error', `서버 명령을 띄우지 못했습니다: ${msg}`);
        throw new BackendError(
          'error',
          `서버 명령을 띄운 뒤 처리하다 오류가 났습니다: ${msg} — 명령은 돌았을 수 있습니다. 실행 기록 ${slot.run.execId}을 보고, 같은 명령을 다시 돌리려면 새 request_id를 쓰세요`,
        );
      });
      if (slot.run) this.forget(slot.run);
      const execId = result.execId;
      if (result.leftover !== 0) {
        // 남은 하위 프로세스는 부른 턴에 접는다 — 그 턴이 kill_failed로 끝나 M-MAIN이 일시정지되고, 출구는 대표의 정지 해제다 (리드 결정 S5-18, CTL-11)
        this.unconfirmedTurns.add(identity.turnId);
        const detail = `서버 명령 ${execId}: ${result.leftoverDetail ?? (result.leftover > 0 ? `남은 프로세스 ${result.leftover}개` : '남은 하위 프로세스를 확인하지 못함')}`;
        if (!this.core.turns.noteUnconfirmed(identity.turnId, result.leftover, detail)) {
          // 부른 턴이 없다(프로세스 안 시험 신원 등) — 그 실행을 바로 막는다
          await this.core.turns.blockUnconfirmedRun(
            { label: `메인 에이전트 서버 명령 ${execId}`, sessionKind: identity.sessionKind, sessionKey: identity.sessionKey, memberId: MAIN_AGENT_ID, projectId: null, taskId: null, turnId: null },
            { envProblem: unconfirmedEnvProblem(ctx.deps.runner), remaining: result.leftover, cause: detail, what: '서버 명령' },
          );
        }
      }
      const outcome = this.outcomeText(result);
      ctx.activity({
        kind: 'exec',
        level: result.leftover !== 0 ? 'error' : result.code === 0 && !result.timedOut && !result.stopped ? 'info' : 'warn',
        actor: MAIN_AGENT_ID,
        memberId: MAIN_AGENT_ID,
        projectId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        requestId: execId,
        text: `메인 에이전트 서버 명령 끝 (host_exec ${execId}): ${outcome} — 목적: ${clip(purpose, 300)}`,
      });
      // 메인이 상태를 바꾼 도구 호출 — 메인 일지 서버 기록(action) (SERVER_DESIGN 6.1, 리드 결정 S5-16)
      this.core.journal.server('action', `서버 명령 실행 (host_exec ${execId}): "${clip(command, 200)}" — 목적: ${clip(purpose, 300)} → ${outcome}`, {
        projectId,
        refs: projectId ? [{ kind: 'project', id: projectId }] : [],
        workKey: identity.sessionKey,
        turnId: identity.turnId,
        generation: identity.seatGeneration,
      });
      return {
        request_id: requestId,
        exit_code: result.code,
        timed_out: result.timedOut,
        stopped: result.stopped,
        duration_ms: result.durationMs,
        cwd,
        output: result.output,
        output_truncated: out.omitted > 0,
        output_omitted_bytes: out.omitted,
        leftover: result.leftover,
        message: this.messageOf(result, timeoutMs),
        ...(cpuDelayedMs > 0 ? { cpu_delayed_ms: cpuDelayedMs } : {}),
      };
    } finally {
      if (slot.run) this.forget(slot.run);
      markFinished();
    }
  }

  /**
   * CPU가 상한 이상이면 내려갈 때까지 기다린다 — 기다린 시간(ms, 기다리지 않았으면 0). 기다리기 시작할 때 활동 기록 한 줄. 기다리는 동안 부른 턴을 '명령 실행
   * 중'으로 둔다 — CLI는 앱 도구 호출 동안 출력이 없어, 그대로 두면 턴 감시가 응답 없음(noOutputMin)으로 끊는다. 부른 턴이 끝나거나 정지·자리 교체·앱
   * 종료가 오면 그만 기다린다 (그 뒤의 검사가 거부한다)
   */
  private async delayForCpu(identity: TokenIdentity, purpose: string): Promise<number> {
    const ctx = this.ctx;
    const first = this.core.cpu.view();
    if (!first.holding) return 0;
    ctx.activity({
      kind: 'exec',
      level: 'warn',
      actor: MAIN_AGENT_ID,
      memberId: MAIN_AGENT_ID,
      projectId: identity.workProjectId ?? workProjectOf(ctx, identity.sessionKey),
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      text: `메인 에이전트 서버 명령을 미룸 — 서버 PC의 CPU 사용률이 ${first.percent}%입니다(상한 ${CPU_LIMIT_PERCENT}%). 내려가면 실행합니다 — 목적: ${clip(purpose, 300)}`,
    });
    const giveUp = (): boolean => {
      if (this.core.stopping) return true;
      const stop = ctx.stop();
      if (stop.global.active || stop.members[MAIN_AGENT_ID]?.paused) return true;
      const turn = ctx.store.turns.get(identity.turnId);
      const live = this.core.turns.hostExecTurn(identity.turnId);
      if (turn && (turn.endedAt || turn.process.stopMode === 'immediate' || !live || live.stopping)) return true;
      try {
        this.assertCanStart(identity);
      } catch {
        return true;
      }
      return false;
    };
    try {
      const { waitedMs } = await this.core.cpu.waitBelow({ giveUp, tick: () => this.core.turns.noteHostCommand(identity.turnId, CPU_WAIT_KEY, true) });
      return waitedMs;
    } finally {
      this.core.turns.noteHostCommand(identity.turnId, CPU_WAIT_KEY, false);
    }
  }

  /** 띄우기 전에 거부할 상태 — 자리 교체 중, 다른 host_exec, 이 턴의 앞선 종료 확인 실패 (리드 결정 S5-17) */
  private assertCanStart(identity: TokenIdentity): void {
    if (this.core.seat.view().state === 'switching') throw new BackendError('conflict', '메인 자리가 넘어가는 중이라 서버 명령을 실행하지 않았습니다 — 턴을 마치세요');
    const other = [...this.running.values()][0];
    if (other) throw new BackendError('conflict', `다른 서버 명령(request_id ${other.toolRequestId})이 아직 돌고 있습니다 — host_exec는 한 번에 하나만 돕니다. 그 명령이 끝난 뒤 다시 하세요`);
    if (this.unconfirmedTurns.has(identity.turnId)) {
      throw new BackendError(
        'conflict',
        '이 턴의 앞선 서버 명령이 남긴 하위 프로세스의 종료를 확인하지 못해 이 턴에는 서버 명령을 더 실행하지 않습니다 — 턴을 마치세요. 턴이 끝나면 메인 에이전트가 일시정지되고, 남은 프로세스가 정리된 뒤 대표의 정지 해제로 풀립니다',
      );
    }
  }

  private forget(r: Running): void {
    if (this.running.get(r.execId) !== r) return;
    this.running.delete(r.execId);
    this.core.turns.noteHostCommand(r.turnId, r.execId, false);
    this.ctx.bus.changed();
  }

  /** 끝낸다 — 처음 끝낸 까닭을 지킨다(뒤의 정지는 같은 약속을 받는다). reason null: 시간 초과 */
  private kill(r: Running, reason: HostExecStop | null): Promise<TerminateResult> {
    if (!r.stopPromise) {
      r.stopReason = reason;
      r.stopPromise = r.proc
        .terminate({ timeoutMs: STOP_CONFIRM_MS, reason: `서버 명령 ${reason ?? '시간 초과'}` })
        .catch((e: unknown): TerminateResult => ({ ok: false, remaining: -1, detail: e instanceof Error ? e.message : String(e), durationMs: 0 }));
    } else if (reason && !r.stopReason && !r.timedOut) r.stopReason = reason;
    return r.stopPromise;
  }

  /**
   * 실행 중인 서버 명령을 끝낸다 — 긴급 정지(턴 종료·자동 검사와 함께, 3초 안 — AC-15·29)와 앱 종료가 부른다. 결과를 돌려줘 정지 요약이 남은 프로세스를 안다
   * (CTL-03: 남으면 완료로 표시하지 않는다)
   */
  terminateWhere(pred: (r: { execId: string; turnId: string }) => boolean, reason: HostExecStop): Promise<{ execId: string; turnId: string; toolRequestId: string; result: TerminateResult }[]> {
    return Promise.all(
      [...this.running.values()]
        .filter((r) => pred(r))
        .map(async (r) => ({ execId: r.execId, turnId: r.turnId, toolRequestId: r.toolRequestId, result: await this.kill(r, reason) })),
    );
  }

  /**
   * 턴이 끝날 때(정상 종료·감시·종료 요청·자리 교체의 정지 — TurnRunner.finish가 남은 프로세스를 세기 전에) 그 턴의 서버 명령을 끝내고 기록까지 마칠 때까지 기다린다.
   * CLI가 끝나도 처리기는 뒤에서 계속 돌기 때문이다 (지도 §1.11). 남은 프로세스는 그 처리(run)가 noteUnconfirmed로 그 턴에 접는다
   */
  async settleTurn(turnId: string, reason: HostExecStop): Promise<void> {
    const mine = [...this.running.values()].filter((r) => r.turnId === turnId);
    if (mine.length) {
      await Promise.all(mine.map((r) => this.kill(r, reason)));
      // 기록(실행 기록·활동 기록·일지)과 남은 프로세스 접기는 run이 마친다 — 그 뒤에 턴을 마무리한다
      await Promise.all(mine.map((r) => r.finished.then(() => new Promise<void>((done) => setImmediate(done)))));
    }
    // 끝나는 턴이다 — 그 턴의 '더 받지 않음' 표시는 더 쓰지 않는다 (오래 도는 서버에서 쌓이지 않게). 접은 것은 턴에 남았다
    this.unconfirmedTurns.delete(turnId);
  }

  /** 끝난 뒤 한마디 — 활동 기록·일지 (종료 코드와 걸린 시간, 시간 초과, 정지, 남은 프로세스) */
  private outcomeText(r: { code: number | null; timedOut: boolean; stopped: HostExecStop | null; durationMs: number; leftover: number }): string {
    const head = r.timedOut ? `시간 초과로 끝냄 (${seconds(r.durationMs)})` : r.stopped ? `${r.stopped}로 끝냄 (${seconds(r.durationMs)})` : `종료 코드 ${String(r.code)} (${seconds(r.durationMs)})`;
    const left = r.leftover > 0 ? ` — 남은 하위 프로세스 ${r.leftover}개(종료 확인 실패)` : r.leftover < 0 ? ' — 남은 하위 프로세스를 확인하지 못함' : '';
    return `${head}${left}`;
  }

  /** 도구 결과의 안내 (메인 에이전트가 읽는다) */
  private messageOf(r: { code: number | null; timedOut: boolean; stopped: HostExecStop | null; leftover: number }, timeoutMs: number): string {
    const base = r.timedOut
      ? `시간 상한(${Math.round(timeoutMs / 1000)}초)이 지나 명령을 끝냈습니다 — 출력은 그때까지의 것입니다`
      : r.stopped
        ? `${r.stopped}로 명령을 끝냈습니다 — 출력은 그때까지의 것입니다. 지금 턴을 마치세요`
        : r.code === 0
          ? '명령이 끝났습니다 (종료 코드 0)'
          : `명령이 종료 코드 ${String(r.code)}로 끝났습니다`;
    if (r.leftover === 0) return base;
    return `${base}. 명령이 띄운 하위 프로세스${r.leftover > 0 ? ` ${r.leftover}개가 남았습니다` : '가 모두 끝났는지 확인하지 못했습니다'} (종료 확인 실패) — 이 턴에는 서버 명령을 더 실행하지 않고, 턴이 끝나면 메인 에이전트가 일시정지됩니다. 남은 프로세스가 정리된 뒤 대표의 정지 해제로 풀립니다`;
  }
}
