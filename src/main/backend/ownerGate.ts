/**
 * 대표 세션 게이트 (SERVER_DESIGN 2.5, OWN-05, AC-51, G12): Backend.invoke는 대표가 부르는 길이다 — 데스크톱 화면(preload → IPC)이 이 길로만 온다.
 * - 대표 메서드(OWNER_METHODS)만 받는다. 뺀 메서드(팀·프로젝트·작업 운영, 역할·설정, 복구 확인 등)는 `forbidden`으로 거부하고 활동 기록과 로그에 남긴다.
 *   그 일은 메인 에이전트가 앱 도구로 한다 (orchestrator/tools.ts) — 대표는 명령창으로 메인 에이전트에게 말한다
 * - 데스크톱 앱은 그 PC의 사람이 대표이자 운영자라 운영자 로컬 메서드(DESKTOP_OPERATOR_METHODS)를 더 받는다. `settings.update`는 운영자 항목
 *   (DESKTOP_OPERATOR_SETTINGS — 계정·구글·CLI 실행 파일 위치·운영자 몫·메인 AI)만 — 다른 항목이 하나라도 섞이면 거부한다. 모의 실행(메인 에이전트
 *   모의 모드 developer.mainAgentMock, 프로젝트 모의 실행 projects.setMock)은 값까지 보고 끄기(false)만 받는다 (리드 결정 23)
 * - 시험과 운영자의 프로세스 안 준비는 이 게이트를 거치지 않는 내부 API(createInternalApi)로 한다. 어떤 네트워크에도 올리지 않는다
 * - 통과한 요청은 인자 모양을 본다 (ownerArgs.ts, 리드 결정 S3-13) — 틀리면 invalid_args, 그런 대상이 없으면 not_found. 데스크톱 IPC와 서버 HTTP가 같다
 * - 원격 호출자의 상태를 바꾸는 요청(REPLAY_METHODS)은 같은 (기기 세션, 요청 ID)를 한 번만 처리하고 그 답을 24시간 남긴다 (requestReplies.ts, S3-9)
 * 거부할 때 인자는 남기지 않는다 — API 키 같은 비밀 값을 담을 수 있다 (SEC-10)
 */
import { OWNER } from '@shared/domain';
import {
  DESKTOP_OPERATOR_METHODS,
  DESKTOP_OPERATOR_OFF_ONLY_SETTINGS,
  DESKTOP_OPERATOR_SETTINGS,
  OWNER_METHODS,
  type WookMethod,
  type WookParams,
  type WookResult,
} from '@shared/ipc';
import type { Core } from '../orchestrator/core';
import { createApi, createCallerApi, isGoogleSetupCall, isPublicMethod, isRemotePublicMethod } from '../orchestrator/api';
import { SERVER_DEV_LOGIN } from '../orchestrator/auth';
import { DEFAULT_SEAT_POLICY } from '../orchestrator/seat';
import { changedPaths, settingsOutside } from '../orchestrator/settingsPolicy';
import { MissingRowError } from '../db/store';
import { INVOKE_ERRORS, isBackendError } from './invokeCore';
import { ownerArgProblem } from './ownerArgs';
import { argsDigest, isReplayMethod, type ReplyOutcome } from './requestReplies';
import { BackendError, type RemoteCaller } from './types';

/**
 * 대표가 들어오는 길. 원격(서버의 POST /api/invoke)은 호출자(RemoteCaller)를 넘겨 이 게이트를 'remote'로 쓴다 (리드 결정 S3-3) — 그 길에는 운영자 로컬
 * 메서드가 없다. 원격 길에서 운영자 몫을 거부하는 글은 메인 에이전트에게 말하라고 하지 않는다 (리드 결정 47·S3-12)
 */
export type OwnerSurface = 'desktop' | 'remote';

/** 서버 모드에서 호출자 없이 온 요청 — 세션 없는 원격 호출자로 본다 (S3-2) */
const NO_SESSION: RemoteCaller = { surface: 'remote', session: null, clientKey: 'internal' };

const OWNER_SET: ReadonlySet<string> = new Set<string>(OWNER_METHODS);
const DESKTOP_OPERATOR_SET: ReadonlySet<string> = new Set<string>(DESKTOP_OPERATOR_METHODS);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 점으로 이은 경로의 값 (없으면 undefined) */
function valueAt(patch: unknown, path: string): unknown {
  let cur: unknown = patch;
  for (const k of path.split('.')) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const MOCK_OFF_ONLY = '모의 실행은 이 PC에서 끄기만 할 수 있습니다 — 켜는 것은 개발·시험 전용입니다';
/** 개발자 옵션(모의 실행 끄기 밖)은 메인 에이전트도 바꾸지 못한다(update_settings 거부) — 메인에게 말하라고 하지 않는다 (리드 결정 40) */
const DEVELOPER_OPTIONS = '개발자 옵션';
/**
 * 메인 자리 정책(seat.* — 앉을 수 있는 보유자·교체 때 마무리를 기다리는 시간)은 운영자 설정이라 메인 에이전트의 update_settings도 거부한다 (S4-12). 데스크톱은
 * 4단계에서 바꾸지 않고 기본값을 쓰고(S4-23), 서버는 운영자가 server.json에서 바꾼다 — 메인에게 말하라고 하지 않는다 (리드 결정 S4-33)
 */
const SEAT_POLICY = '메인 자리 정책';
const isSeatPath = (p: string): boolean => p === 'seat' || p.startsWith('seat.');
const SEAT_POLICY_DESKTOP = `${SEAT_POLICY}(seat: 앉을 수 있는 보유자, 교체 때 마무리를 기다리는 시간)은 데스크톱에서 바꾸지 않습니다 — 이 PC는 기본값(마무리 ${DEFAULT_SEAT_POLICY.drainMs / 1000}초)을 씁니다`;
const SEAT_POLICY_REMOTE = `${SEAT_POLICY}(seat)은 서버 PC의 운영자가 server.json에서 바꿉니다`;

/** settings.update에서 데스크톱 운영자 항목 밖의 경로를 거부하는 글 — 개발자 옵션·메인 자리 정책과 메인 에이전트 몫을 나눠 사실대로 말한다 */
function outsideRefusal(outside: readonly string[]): string {
  const dev = outside.filter((p) => p === 'developer' || p.startsWith('developer.'));
  const seat = outside.filter(isSeatPath);
  const rest = outside.filter((p) => !dev.includes(p) && !seat.includes(p));
  return [
    rest.length ? `운영 설정(${rest.join(', ')})은 메인 에이전트가 바꿉니다` : null,
    seat.length ? SEAT_POLICY_DESKTOP : null,
    dev.length ? `${DEVELOPER_OPTIONS}(${dev.join(', ')})은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다` : null,
  ]
    .filter(Boolean)
    .join('. ');
}

/**
 * 원격 길에서 운영자 몫을 거부하는 글 (리드 결정 47·S3-12) — 메인 에이전트도 하지 못하는 일이라 메인에게 말하라고 하지 않는다. 서버에서는 대표 화면이
 * 이 PC의 운영자 화면이 아니다
 */
export const OPERATOR_ONLY_REMOTE = '설치·운영자 설정은 서버 PC의 운영자가 바꿉니다';
const MOCK_REMOTE = '모의 실행은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다';

/** 거부 글과 메인 에이전트 안내를 붙일지 — 메인 몫의 일이 섞였을 때만 붙인다 (리드 결정 23·40·47) */
interface Refusal {
  text: string;
  tellMain: boolean;
}

/** 원격 길(서버 HTTP)의 데스크톱 운영자 메서드 거부 (S3-12): 운영자 몫·개발자 옵션은 사실만, 메인 몫(운영 설정)이 섞이면 그 항목에만 메인 안내 */
function remoteOperatorRefusal(method: string, args: readonly unknown[]): Refusal {
  if (method === 'auth.devLogin') return { text: SERVER_DEV_LOGIN, tellMain: false };
  if (method === 'projects.setMock') return { text: MOCK_REMOTE, tellMain: false };
  if (method !== 'settings.update') return { text: OPERATOR_ONLY_REMOTE, tellMain: false };
  const patch = args[0];
  // 운영자 항목·개발자 옵션 밖은 메인 에이전트 몫(운영 설정)으로 본다 — 메인 자리 정책(seat.*)만 따로 서버 PC 운영자의 몫이다. 데스크톱 글과 같은 나눔 (outsideRefusal)
  const outside = settingsOutside(patch, [...DESKTOP_OPERATOR_SETTINGS, 'developer']);
  const seat = outside.filter(isSeatPath);
  const rest = outside.filter((p) => !isSeatPath(p));
  const dev = changedPaths(patch).filter((p) => p === 'developer' || p.startsWith('developer.'));
  const operator = isPlainObject(patch) && settingsOutside(patch, [...outside, 'developer']).length > 0;
  const parts = [
    operator ? OPERATOR_ONLY_REMOTE : null,
    rest.length ? `운영 설정(${rest.join(', ')})은 메인 에이전트가 바꿉니다` : null,
    seat.length ? SEAT_POLICY_REMOTE : null,
    dev.length ? `${DEVELOPER_OPTIONS}(${dev.join(', ')})은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다` : null,
  ].filter((p): p is string => p !== null);
  return { text: parts.length ? parts.join('. ') : OPERATOR_ONLY_REMOTE, tellMain: rest.length > 0 };
}

/** 대표 세션으로 부를 수 없는 까닭 (부를 수 있으면 null) */
export function ownerRefusal(method: string, args: readonly unknown[], surface: OwnerSurface): string | null {
  return refusalOf(method, args, surface)?.text ?? null;
}

function refusalOf(method: string, args: readonly unknown[], surface: OwnerSurface): Refusal | null {
  const text = desktopRefusal(method, args, surface);
  if (text === null) return null;
  // 원격 길의 운영자 몫은 따로 (S3-12). 데스크톱 길은 예전 그대로 — 모의 실행 켜기·개발자 옵션·메인 자리 정책만 메인 안내 없이 (리드 결정 23·40·S4-33).
  // 메인 몫 항목이 섞이면 글이 '운영 설정(…)'으로 시작해 예전처럼 메인 안내가 붙는다
  if (surface === 'remote' && DESKTOP_OPERATOR_SET.has(method)) return remoteOperatorRefusal(method, args);
  return { text, tellMain: !(text.startsWith(MOCK_OFF_ONLY) || text.startsWith(DEVELOPER_OPTIONS) || text.startsWith(SEAT_POLICY)) };
}

function desktopRefusal(method: string, args: readonly unknown[], surface: OwnerSurface): string | null {
  if (OWNER_SET.has(method)) return null;
  if (surface === 'desktop' && DESKTOP_OPERATOR_SET.has(method)) {
    // 프로젝트 모의 실행은 끄기만: 프로젝트 ID와 { enabled: false } 하나만 받는다 — 값까지 본다 (리드 결정 23)
    if (method === 'projects.setMock') {
      const mock = args[1];
      const offOnly = args.length === 2 && typeof args[0] === 'string' && isPlainObject(mock) && Object.keys(mock).length === 1 && mock['enabled'] === false;
      return offOnly ? null : MOCK_OFF_ONLY;
    }
    if (method !== 'settings.update') return null;
    const outside = settingsOutside(args[0], [...DESKTOP_OPERATOR_SETTINGS, ...DESKTOP_OPERATOR_OFF_ONLY_SETTINGS]);
    if (outside.length) return outsideRefusal(outside);
    // 끄기만 받는 항목(메인 에이전트 모의 모드)은 false일 때만 (리드 결정 23)
    const turnsOn = DESKTOP_OPERATOR_OFF_ONLY_SETTINGS.filter((p) => {
      const v = valueAt(args[0], p);
      return v !== undefined && v !== false;
    });
    return turnsOn.length ? MOCK_OFF_ONLY : null;
  }
  return '대표 화면에서 하는 일이 아닙니다';
}

/** 찾지 못한 행의 표 → not_found 글의 대상 이름 (S3-13) */
const ROW_LABEL: Readonly<Record<string, string>> = {
  projects: '프로젝트',
  members: '팀원',
  roles: '역할',
  directives: '지시',
  tasks: '작업',
  questions: '질문',
  reports: '보고서',
  report_comments: '보고서 코멘트',
  notifications: '알림',
  turns: '턴',
};

/** 글에 넣는 대상 ID — 제어 문자 없이 60자까지 */
const shownId = (id: string): string => [...id.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')].slice(0, 60).join('');

const notFound = (label: string, id: string): BackendError => new BackendError('not_found', `${label} ${shownId(id)}을(를) 찾을 수 없습니다`);

/**
 * 가리킨 대상이 없을 때 빈 답을 내던 대표 메서드 — 처리기 앞에서 not_found로 (S3-13). 다른 메서드는 처리기가 not_found를 던지거나, 저장소의 require가
 * 던진 MissingRowError를 게이트가 not_found로 바꾼다
 */
function missingTarget(core: Core, method: string, args: readonly unknown[]): BackendError | null {
  const id = args[0];
  if (typeof id !== 'string') return null;
  if (method === 'members.getEvents') return core.ctx.store.members.get(id) ? null : notFound('팀원', id);
  if (method === 'command.history') return id === 'main' || core.ctx.store.projects.get(id) ? null : notFound('프로젝트', id);
  return null;
}

/** 처리기 실패의 저장할 결과 — BackendError는 code·글 그대로, 그 밖은 internal (invokeCore가 답하는 것과 같다) */
function outcomeOfError(error: unknown): ReplyOutcome {
  if (isBackendError(error)) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: INVOKE_ERRORS.internal.code, message: INVOKE_ERRORS.internal.message };
}

/**
 * 대표가 부르는 Backend.invoke — 게이트 → 로그인 확인 → 인자 모양(S3-13) → (원격의 상태 바꾸는 요청이면 같은 요청 ID 한 번만, S3-9) → 처리.
 * caller(원격 호출자, S3-3)가 있으면 surface와 상관없이 원격 길이다: 로그인은 그 호출자의 기기 세션으로 보고(auth.isLoggedIn(caller)), 로그인 전에는
 * 원격 공개 메서드만(S3-11), 게이트는 'remote', 호출자에 따라 답이 다른 메서드는 그 호출자로 처리한다(createCallerApi). 서버 모드에서 호출자 없이 온
 * 요청은 세션 없는 원격 호출자다 (S3-2). 호출자가 없으면 surface의 데스크톱 길 그대로다 ('remote'는 원격 게이트 판정만 보는 시험이 쓴다)
 */
export function createOwnerInvoke(core: Core, surface: OwnerSurface = 'desktop') {
  const ctx = core.ctx;
  const api = createApi(core);
  const callerApi = createCallerApi(core);
  return async <M extends WookMethod>(method: M, args: WookParams<M>, caller?: RemoteCaller): Promise<WookResult<M>> => {
    const viewer = caller ?? (ctx.deps.mode === 'server' ? NO_SESSION : undefined);
    const on: OwnerSurface = viewer ? 'remote' : surface;
    const name = typeof method === 'string' ? method.slice(0, 80) : `(${typeof method})`;
    const fn = Object.hasOwn(api, method) ? (api[method] as unknown as (...a: unknown[]) => unknown) : null;
    if (!fn) throw new BackendError('not_found', `알 수 없는 요청: ${name}`);
    // 로그인 전: 공개 메서드와, 구글 로그인 설정 입력이 열려 있을 때의 구글 설정만 (AUTH-01·04, ENV-04, AC-01) — 대표 등록 전, 또는 대표가
    // 있어도 설정이 빠졌거나 마지막 대표 로그인 뒤 바뀌어 확인되지 않았을 때 (auth.googleSetupOpen). 그 밖에는 설정을 로그인한 대표만 바꾼다.
    // 로그인하지 않은 쪽에는 권한을 말하지 않는다 — 대표 권한 검사는 로그인한 대표 세션에만. 원격 호출자는 원격 공개 메서드만이고 구글 설정 길은 없다
    // (운영자가 서버에서 넣는다) — 세션 없는 원격 호출자가 거부 기록을 쌓지 못한다 (S3-3·S3-11)
    const open = viewer
      ? isRemotePublicMethod(method) || core.auth.isLoggedIn(viewer)
      : isPublicMethod(method) || core.auth.isLoggedIn() || (isGoogleSetupCall(method, args) && core.auth.googleSetupOpen());
    if (!open) throw new BackendError('unauthorized', '로그인이 필요합니다');
    const list: readonly unknown[] = Array.isArray(args) ? args : [];
    const refused = refusalOf(name, list, on);
    if (refused) {
      ctx.log('warn', `대표 권한 밖 요청 거부: ${name} — ${refused.text}`);
      ctx.activity({ kind: 'auth', level: 'warn', actor: OWNER, text: `대표 권한 밖 요청 거부: ${name}`, result: refused.text });
      // 메인 에이전트도 하지 않는 일(모의 실행 켜기·개발자 옵션, 원격의 운영자 몫)에는 메인에게 말하라는 안내를 붙이지 않는다 (리드 결정 23·40·47, S3-12)
      const tail = refused.tellMain ? ' 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — 명령창으로 메인 에이전트에게 말하세요' : '';
      throw new BackendError('forbidden', `${refused.text} (${name}).${tail}`);
    }
    // 인자 모양 (S3-13) — 틀리면 처리기를 부르지 않는다. 글에는 넘긴 값을 넣지 않는다
    const badArgs = ownerArgProblem(name, list);
    if (badArgs) throw new BackendError('invalid_args', `요청 형식이 올바르지 않습니다 — ${name}: ${badArgs}`);
    const missing = missingTarget(core, name, list);
    if (missing) throw missing;
    const forCaller = viewer && Object.hasOwn(callerApi, method) ? (callerApi[method] as unknown as (c: RemoteCaller, ...a: unknown[]) => unknown) : null;
    const run = async (): Promise<unknown> => {
      try {
        return forCaller && viewer ? await forCaller(viewer, ...list) : await fn(...list);
      } catch (error) {
        // 저장소의 require가 찾지 못한 대상은 not_found로 답한다 — 예전에는 500 internal과 스택 있는 ERROR 줄이었다 (S3-13)
        if (error instanceof MissingRowError) throw notFound(ROW_LABEL[error.table] ?? '요청한 대상', error.id);
        throw error;
      }
    };
    // 휴대폰이 네트워크가 끊겨 같은 요청을 다시 보내도 한 번만 처리한다 — 같은 기기 세션의 같은 요청 ID는 저장한 답을 준다 (S3-9). 데스크톱 길은 요청 ID가 없다
    if (viewer?.session && viewer.requestId !== undefined && isReplayMethod(name)) {
      return (await core.requestReplies.once({ sessionId: viewer.session.id, requestId: viewer.requestId, method: name, digest: argsDigest(list), run, outcomeOfError })) as WookResult<M>;
    }
    return (await run()) as WookResult<M>;
  };
}
