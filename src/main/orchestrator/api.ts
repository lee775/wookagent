/**
 * 화면 IPC 메서드 구현 (src/shared/ipc.ts WookApiMethods). 같은 처리기를 세 길이 함께 쓰고, 길마다 행위자만 다르다 (SERVER_DESIGN 2.5):
 * - 대표: createApi(core) — Backend.invoke가 대표 메서드(OWNER_METHODS)만 통과시킨다 (backend/ownerGate.ts). 로그인 전에는 auth.*·system.prereqs만
 *   허용한다 (AUTH-04). 예외: 대표 등록 전의 구글 로그인 설정 (isGoogleSetupCall)
 * - 운영자: createInternalApi(core) — 시험 준비와 운영자의 프로세스 안 조작. 게이트가 없고 어떤 네트워크에도 올리지 않는다
 * - 메인 에이전트: 앱 도구 처리기(tools.ts)가 createApi(core, MAIN_AGENT_ID)의 처리기를 부른다 — 옛 대표 메서드와 같은 상태 전이·기록, 행위자만 M-MAIN
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Actor, AiConfig, AiKind, Role, Settings, SkillEntry } from '@shared/domain';
import { AI_KINDS, EFFORT_LEVELS, MAIN_AGENT_ID, OPERATOR, OWNER } from '@shared/domain';
import type { DeepPartial, WookApiMethods, WookMethod, WookParams, WookResult } from '@shared/ipc';
import type { ConversationView, PrereqStatus, SkillView } from '@shared/views';
import { BackendError, type RemoteCaller } from '../backend/types';
import { SERVER_BROWSER_LOGIN } from './auth';
import { SECRET_KEYS } from '../auth/types';
import { API_KEY_SECRET, loginStateForAuth } from '../auth/apiKeys';
import type { Core } from './core';
import { memberName } from './lookups';
import { normalizeSettings, roleCreatorOf } from './defaults';
import { EXECUTION_NO_LIMIT_NOTE, executionPatchProblems, settingsShapeProblems } from './settingsPolicy';
import { hasActiveUsageLimit } from '@core/usageLimits';
import { copyTree, removeTree } from './fsutil';
import { isValidModelName } from './team';
import { holderLabel, sameAiConfig } from './seat';

export type ApiHandlers = { [M in WookMethod]: (...args: WookParams<M>) => WookResult<M> | Promise<WookResult<M>> };

const PUBLIC = new Set<WookMethod>(['auth.getState', 'auth.login', 'auth.devLogin', 'auth.logout', 'auth.deviceLogin', 'auth.deviceLoginPoll', 'auth.setupOwner', 'system.prereqs']);

export function isPublicMethod(m: WookMethod): boolean {
  return PUBLIC.has(m);
}

/**
 * 원격 호출자(서버 HTTP)가 로그인 전에 부를 수 있는 메서드 (리드 결정 S3-11): 로그인 상태, 기기 코드 로그인·결과 묻기, 대표 이메일 첫 설정, 준비 상태.
 * 데스크톱 길의 공개 메서드 가운데 브라우저 로그인·개발 모드 로그인·로그아웃은 없다 — 원격에는 그 길이 없거나(S3-2) 끊을 세션이 없다
 */
const REMOTE_PUBLIC = new Set<WookMethod>(['auth.getState', 'auth.deviceLogin', 'auth.deviceLoginPoll', 'auth.setupOwner', 'system.prereqs']);

export function isRemotePublicMethod(m: WookMethod): boolean {
  return REMOTE_PUBLIC.has(m);
}

const hasOnlyKey = (v: unknown, key: string): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && Object.keys(v)[0] === key;

/**
 * 구글 로그인 설정 요청인지: 클라이언트 ID(`settings.update`에 account.googleClientId 하나만)와 보안 비밀(`settings.setGoogleSecret`).
 * 대표 등록 전에는 로그인 없이 받는다 (AUTH-01, ENV-04) — 패키징된 실행에는 개발 모드 로그인이 없어 이 길이 없으면 첫 로그인을 못 한다.
 * 대표가 없으면 처음 로그인한 구글 계정이 대표가 되므로(AUTH-03) 먼저 받아도 막을 대상이 없다. 대표가 등록되면 로그인한 대표만 바꾸되,
 * 설정이 빠졌거나 마지막 대표 로그인 뒤 바뀌어 아직 확인되지 않았으면 로그인 없이도 받는다 — 대표가 갇히지 않게 (auth.googleSetupOpen,
 * 게이트: orchestrator.ts invoke). 로그인은 그래도 등록된 대표 계정으로만 된다
 */
export function isGoogleSetupCall(method: WookMethod, args: readonly unknown[]): boolean {
  if (method === 'settings.setGoogleSecret') return true;
  if (method !== 'settings.update') return false;
  const patch = args[0];
  return hasOnlyKey(patch, 'account') && hasOnlyKey(patch['account'], 'googleClientId');
}

/** AI 인증 방식(결제 방식) 이름 — 활동 기록용 */
const AUTH_MODE_LABEL: Readonly<Record<Settings['account']['authMode'][AiKind], string>> = { subscription: '구독', api_key: 'API 키' };

/** 구글 OAuth 클라이언트 ID 모양 (예: 1234567890-abc123.apps.googleusercontent.com) — 보안 비밀을 잘못 붙여 넣은 것 등을 저장 전에 거른다 */
const GOOGLE_CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out as T;
}

/** 역할 기본 AI도 CLI가 받을 수 있는 값만 저장한다 — 팀원 추가 때 그대로 들어간다 (F1) */
function assertRoleAi(ai: Role['defaultAi']): void {
  if (ai.model !== null && !isValidModelName(ai.model)) throw new BackendError('invalid', `역할 기본 모델 이름이 올바르지 않습니다: "${ai.model}" (공백·제어 문자 불가)`);
  if (ai.effortOverride && !EFFORT_LEVELS[ai.kind].includes(ai.effortOverride)) {
    throw new BackendError('invalid', `${ai.kind} 노력치 값은 ${EFFORT_LEVELS[ai.kind].join('|')} 중 하나여야 합니다`);
  }
}

/** 찾은 스킬 캐시를 쓰는 시간 */
const SKILL_SCAN_TTL_MS = 60_000;
/** 거부 글에 보여 주는 찾은 스킬 이름 수 */
const SKILL_NAMES_SHOWN = 40;

/**
 * 찾은 스킬(scanSkills) 캐시 — 코어마다 하나다. 대표 화면의 skills.list와 메인 에이전트 도구(create_role·update_role의 허용 스킬, set_skill_mode)가
 * 처리기 묶음(createApi)이 달라도 같은 목록을 본다. 60초 동안 쓰고, 역할을 쓰면 지운다 (리드 결정 S5-14)
 */
const skillScans = new WeakMap<Core['ctx'], { at: number; found: SkillEntry[] }>();

async function foundSkills(core: Core, fresh = false): Promise<SkillEntry[]> {
  const ctx = core.ctx;
  const hit = skillScans.get(ctx);
  if (!fresh && hit && Date.now() - hit.at < SKILL_SCAN_TTL_MS) return hit.found;
  // scanSkills가 없으면(시험 하네스 등) 찾은 스킬이 없다 — 그러면 새로 넣는 이름은 모두 거부된다. 아무것도 찾지 못한 이름은 받지 않는다 (리드 결정 S5-14)
  const found = ctx.deps.scanSkills ? await ctx.deps.scanSkills({ home: homedir(), projectPaths: ctx.store.projects.list().map((p) => p.path) }) : [];
  skillScans.set(ctx, { at: Date.now(), found });
  return found;
}

/** 새로 넣는 이름 가운데 찾은 스킬에 없는 것 — 이미 저장된 이름(stored)은 지금 찾지 못해도 그대로 둔다 (리드 결정 S5-14) */
const unknownSkills = (names: readonly string[], stored: readonly string[], found: ReadonlySet<string>): string[] =>
  [...new Set(names)].filter((n) => !stored.includes(n) && !found.has(n));

/**
 * 새로 넣는 이름을 볼 찾은 스킬 이름 — 새 이름이 없으면 찾지 않는다. 캐시에 없는 새 이름이 있으면 한 번 새로 찾는다(방금 설치한 스킬).
 * 기다리는 동안 저장된 값이 바뀔 수 있으므로 부르는 쪽은 기다린 뒤 지금 저장된 값으로 assertKnownSkills를 부른다
 */
async function skillNamesFor(core: Core, names: readonly string[], stored: readonly string[]): Promise<ReadonlySet<string>> {
  const none = new Set<string>();
  if (!unknownSkills(names, stored, none).length) return none;
  let found = new Set((await foundSkills(core)).map((s) => s.name));
  if (unknownSkills(names, stored, found).length) found = new Set((await foundSkills(core, true)).map((s) => s.name));
  return found;
}

/** 허용 스킬은 scanSkills로 찾은 것 중에서만 고른다 (SERVER_DESIGN 7장, 리드 결정 S5-14). lead: 거부 글 첫머리 */
function assertKnownSkills(names: readonly string[], stored: readonly string[], found: ReadonlySet<string>, lead: string): void {
  const missing = unknownSkills(names, stored, found);
  if (!missing.length) return;
  const all = [...found].sort();
  const shown = all.length > SKILL_NAMES_SHOWN ? `${all.slice(0, SKILL_NAMES_SHOWN).join(', ')} 외 ${all.length - SKILL_NAMES_SHOWN}개` : all.join(', ');
  throw new BackendError(
    'invalid',
    `${lead} — 찾은 스킬에 없는 이름입니다: ${missing.join(', ')}. ${all.length ? `찾은 스킬: ${shown}` : '지금 찾은 스킬이 하나도 없습니다 (Claude·Codex 스킬 폴더)'}`,
  );
}

/**
 * actor: 이 처리기 묶음으로 한 일의 행위자 — 대표(기본), 운영자(createInternalApi), 메인 에이전트(앱 도구 처리기).
 * o.recheck: 메인 도구 한 번의 호출을 위해 만든 묶음이면 그 호출의 '기다림 뒤 다시 보기' — 처음 상태를 바꾸기 전의 기다림(스킬 찾기·CLI 확인) 뒤마다 부른다.
 * 그사이 부른 메인 턴이 끝났거나 자리 세대가 바뀌었으면 던지고 아무것도 바꾸지 않는다 (리드 결정 S5-63). 대표·운영자의 묶음에는 없다
 */
export function createApi(core: Core, actor: Actor = OWNER, o: { recheck?: () => void } = {}): ApiHandlers {
  const ctx = core.ctx;
  const who = memberName(ctx, actor);

  const prereqs = async (): Promise<PrereqStatus> => {
    const [gitV, claude, codex] = await Promise.all([ctx.deps.git.version().catch(() => null), ctx.deps.adapters.claude.detect(), ctx.deps.adapters.codex.detect()]);
    for (const [k, st] of [['claude', claude], ['codex', codex]] as const) {
      const a = ctx.ai(k);
      ctx.saveAi({ ...a, cliInstalled: st.installed, cliVersion: st.version, checkedAt: ctx.now(), cliProblem: st.installed ? (st.problem ?? a.cliProblem) : '설치되지 않음' });
    }
    return {
      git: { ok: !!gitV, version: gitV },
      claude: { ok: claude.installed && !claude.problem, version: claude.version, loggedIn: claude.loggedIn, detail: claude.detail },
      codex: { ok: codex.installed && !codex.problem, version: codex.version, loggedIn: codex.loggedIn, detail: codex.detail },
      // 서버의 구글 로그인은 서버의 기기 코드 로그인 클라이언트다 (S3-8, serverLogin.ts) — 데스크톱은 예전 그대로
      google: { configured: ctx.deps.mode === 'server' ? core.serverLogin.googleConfigured() : !!ctx.settings().account.googleClientId.trim() },
      // taskkill 대체 방식이거나 러너 파일이 준비할 때와 달라졌으면(binary_changed — 띄우지 않는다, 리드 결정 S6-5) 쓸 수 없는 것으로 보인다
      jobRunner: { ok: ctx.deps.runner.mode !== 'taskkill' && ctx.deps.runner.problem?.()?.kind !== 'binary_changed', detail: ctx.deps.runner.detail },
      // 화면 조작 (리드 결정 S6-11) — 마지막으로 안 상태다. 여기서는 화면 도우미를 띄우지 않는다 (사전 점검은 시작 뒤 한 번 — desktop/safety.ts probe)
      screen: core.desktop.prereq(),
    };
  };

  /**
   * 그 AI 종류의 사용량 한도 기록(종류 전체·모델별)을 지운다 — 결제 방식을 바꾸거나 API 키 방식에서 키를 새로 등록하면 쿼터가 바뀌므로 한 번 다시
   * 시도한다. 한도가 그대로면 다음 턴이 다시 건다. 걸려 있던 한도가 있었을 때만 기록한다. CLI 다시 확인(system.recheckAi)은 지우지 않는다 — 한도는
   * CLI가 끝나는 때와 함께 알려 준 사실이다 (리드 결정 22)
   */
  const clearUsageLimits = (kind: AiKind, why: string): void => {
    const a = ctx.ai(kind);
    if (!a.usageLimitedUntil && !Object.keys(a.modelUsageLimits ?? {}).length) return;
    const active = hasActiveUsageLimit(a, ctx.clock.ms());
    ctx.saveAi({ ...a, usageLimitedUntil: null, modelUsageLimits: {} });
    if (!active) return;
    ctx.activity({ kind: 'auth', actor, text: `${kind} ${why} — 사용량 한도 기록을 지우고 한 번 다시 시도함 (한도가 그대로면 다음 턴이 다시 건다)` });
    ctx.bus.signal('tick');
  };

  const allowedOpen = (p: string): boolean => {
    const target = resolve(p).toLowerCase();
    const roots = [ctx.paths.root, ...ctx.store.projects.list().map((x) => x.path)].map((r) => resolve(r).toLowerCase());
    return roots.some((r) => target === r || target.startsWith(r + '\\') || target.startsWith(r + '/'));
  };

  const api: ApiHandlers = {
    'auth.getState': () => core.auth.state(),
    'auth.login': () => core.auth.login(),
    'auth.devLogin': () => core.auth.devLogin(),
    'auth.logout': () => core.auth.logout(),
    // 기기 코드 로그인·대표 이메일 첫 설정·기기 세션은 서버 모드의 일이다 (SERVER_DESIGN 3.5, S3-4~6). 데스크톱은 이 PC의 브라우저로 로그인하고
    // 기기 세션이 없다 — 원격 호출자(서버)의 처리는 createCallerApi가 맡는다 (S3-3)
    'auth.deviceLogin': () => {
      throw new BackendError('unavailable', '데스크톱 앱은 이 PC의 브라우저로 구글 로그인합니다 — 기기 코드 로그인은 서버 접속에서만 씁니다');
    },
    'auth.deviceLoginPoll': () => {
      throw new BackendError('unavailable', '데스크톱 앱은 이 PC의 브라우저로 구글 로그인합니다 — 기기 코드 로그인은 서버 접속에서만 씁니다');
    },
    'auth.setupOwner': () => {
      throw new BackendError('unavailable', '대표 이메일 설정 코드는 서버에서만 씁니다 — 데스크톱 앱은 처음 로그인한 구글 계정이 대표가 됩니다');
    },
    'auth.listDevices': () => [],
    'auth.revokeDevice': () => {
      throw new BackendError('not_found', '그런 기기 세션이 없습니다 — 데스크톱 앱에는 기기 세션이 없습니다');
    },
    'snapshot.get': () => core.views.snapshot(),

    'projects.create': async (input) => core.views.projectView(await core.projects.create(input, actor)),
    'projects.update': (id, patch) => core.views.projectView(core.projects.update(id, patch, actor)),
    'projects.pause': (id, mode) => core.stops.pauseProject(id, mode, actor),
    'projects.resume': (id) => core.stops.resumeProject(id, actor),
    'projects.setMock': (id, mock) => core.views.projectView(core.projects.setMock(id, mock, actor)),

    'members.add': (input) => core.views.memberView(core.team.add(input, actor)),
    // 대표 고정 값은 없앴다 — 받는 칸만 골라 넘기므로 예전 값이 들어와도 무시된다 (v0.6, SERVER_DESIGN 2.7)
    'members.update': (id, patch) => core.views.memberView(core.team.update(id, { name: patch.name, roleId: patch.roleId, ai: patch.ai, mockScenario: patch.mockScenario }, actor)),
    'members.remove': (id) => core.team.remove(id, actor),
    'members.replaceProducer': async (projectId, input) => core.views.memberView(await core.team.replaceProducer(projectId, input, actor)),
    'members.pause': (id, mode) => core.stops.pauseMember(id, mode, actor),
    'members.resume': (id) => core.stops.resumeMember(id, actor),
    // 중단은 작업 단위다 (9장: 작업·검수 턴 종료 후 고른 보류·취소) — tasks.interruptMember
    'members.interrupt': (id, then) => core.tasks.interruptMember(id, then, actor),
    'members.getDetail': (id) => {
      const d = core.views.memberDetail(id);
      // 메인 에이전트의 직접·긴급 지시는 프로듀서에게도 보인다 (CMD-06, AC-17). 옛 대표 직접 메시지는 메인·프로듀서에게 보인다 (이력).
      // 메인 에이전트의 상세에는 메인이 보낸 지시도 보인다 — 대표가 메인이 팀원에게 무엇을 전했는지 본다 (v0.6)
      const sent = (m: { fromActor: string; toMemberId: string }) => id === MAIN_AGENT_ID && m.fromActor === MAIN_AGENT_ID && m.toMemberId !== id;
      const shared = ctx.store.messages.list().filter((m) => m.sharedWith.includes(id) || sent(m)).slice(-20);
      d.messages = [
        ...d.messages,
        ...shared.map((m) => ({
          id: m.id,
          from: `${core.views.messageFrom(m)} → ${ctx.store.members.get(m.toMemberId)?.name ?? m.toMemberId}${sent(m) ? '' : ' (공유)'}`,
          text: m.text,
          createdAt: m.createdAt,
          delivered: !!m.deliveredAt,
          undelivered: m.deliveredAt ? null : (m.undeliveredReason ?? null),
        })),
      ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return d;
    },
    'members.getEvents': (id, opts) => core.views.memberEvents(id, opts),

    'command.send': (input) => core.commands.send(input),
    'command.history': (target, opts) =>
      core.commands.history(target, opts.before, Math.min(Math.max(opts.limit ?? 50, 1), 500)).map(
        (m): ConversationView => ({ id: m.id, role: m.role, text: m.text, attachments: m.attachments, directiveId: m.directiveId, createdAt: m.createdAt }),
      ),

    'directives.get': (id) => core.views.directiveDetail(id),
    'directives.cancel': (id) => core.directives.cancel(id, actor),
    'tasks.get': (id) => core.views.taskDetail(id),
    'tasks.getDiff': (id) => core.views.taskDiff(id),
    'tasks.resume': (id) => {
      core.tasks.resumeByOwner(id, actor);
    },
    'tasks.cancel': (id) => core.tasks.cancel(id, `${who} 취소`, actor),
    'tasks.interrupt': (id, then) => core.tasks.interrupt(id, then, actor),

    'questions.answer': (id, answer) => {
      const q = ctx.store.questions.get(id);
      if (!q) throw new BackendError('not_found', '질문을 찾을 수 없습니다');
      if (q.to !== 'owner') throw new BackendError('forbidden', '대표에게 온 질문이 아닙니다');
      core.tasks.answer(id, answer, actor);
      for (const n of ctx.store.notifications.list({ ref1: `question:${id}`, state: 'unread' })) ctx.store.notifications.put({ ...n, readAt: ctx.now() });
      core.commands.appendSystem(q.projectId ?? 'main', `${who} 답변 (${q.id}): ${answer}`);
    },

    'reports.list': (filter) => core.views.reportList(filter),
    'reports.get': (id) => core.views.reportDetail(id),
    'reports.markRead': (id) => core.reports.markRead(id),
    'reports.approve': (id, comment) => core.reports.approve(id, comment),
    'reports.requestChanges': (id, input) => core.reports.requestChanges(id, input),

    'notifications.list': (opts) => core.views.notifications(opts.limit ?? 100),
    'notifications.markRead': (id) => {
      const now = ctx.now();
      const list = id === 'all' ? ctx.store.notifications.list({ state: 'unread' }) : [ctx.store.notifications.require(id)];
      for (const n of list) if (!n.readAt) ctx.store.notifications.put({ ...n, readAt: now });
      ctx.bus.changed();
    },

    'stop.emergency': () => core.stops.emergency(actor),
    'stop.release': () => core.stops.release(actor),
    // 메인 자리와 인계는 보기만 한다 (리드 결정 S4-7) — 자리를 바꾸는 대표 메서드는 없다 (S4-2). 일지는 새 것부터, 조건과 다음 쪽 표시로 (S4b, journal.ts)
    'seat.get': () => core.seat.view(),
    'seat.history': () => core.seat.history(),
    'seat.handover': (generation) => core.seat.handover(generation ?? null),
    'journal.list': (filter) => core.journal.list(filter ?? {}),
    // 화면 조작 보기 (리드 결정 S6-2) — 보기만: 최근 캡처(이미지 없이)와 동작 기록, 그리고 캡처 한 장. 이미지는 보관 중이고 기록의 해시와 맞을 때만 준다
    // (지워졌거나 바뀐 파일은 null). 화면 조작을 시작·멈춤·조절하는 대표 메서드는 없다 — 화면 도구를 쓸 수 없는 실행에서도 남은 기록은 보인다
    'screens.recent': (filter) => core.desktop.recent(filter ?? {}),
    'screens.image': (captureId) => core.desktop.image(captureId),
    // 외부 에이전트 보기 (리드 결정 S7-2) — 보기만, 키·해시는 없다. 등록·폐기는 서버 PC의 운영자만 한다(관리 채널 agent.add|revoke) — 대표 메서드에는 없다
    'agents.list': () => core.externalAgents.list(),
    'recovery.list': () => core.recovery.items(),
    'recovery.resolve': (requestId, action) => core.recovery.resolve(requestId, action, actor),

    'settings.get': () => ctx.settings(),
    'settings.update': (patch: DeepPartial<Settings>, expected?: { mainAgent?: AiConfig } | null) => {
      // 새로 들어온 노력치 값은 지금 목록 값만 받는다 (windows:F7). 저장돼 있던 예전 값(none·minimal)은 normalizeSettings가 읽을 때 바꾸므로
      // 합친 뒤 검사로는 새 입력을 가려낼 수 없다 — 입력에서 먼저 본다
      for (const kind of AI_KINDS) {
        for (const [tier, v] of Object.entries(patch.team?.effortMapping?.[kind] ?? {})) {
          if (typeof v === 'string' && !EFFORT_LEVELS[kind].includes(v)) throw new BackendError('invalid', `${kind} 노력치 연결(${tier}) 값은 ${EFFORT_LEVELS[kind].join('|')} 중 하나여야 합니다: "${v}"`);
        }
      }
      const clientIdPatch: unknown = patch.account?.googleClientId;
      if (clientIdPatch !== undefined) {
        if (typeof clientIdPatch !== 'string') throw new BackendError('invalid', '구글 OAuth 클라이언트 ID는 문자열이어야 합니다');
        const id = clientIdPatch.trim();
        if (id && !GOOGLE_CLIENT_ID_RE.test(id)) {
          throw new BackendError('invalid', '구글 OAuth 클라이언트 ID 형식이 아닙니다. 구글 클라우드 콘솔의 "클라이언트 ID"(…apps.googleusercontent.com)를 넣으세요');
        }
        // 대표가 등록된 뒤에는 비우지 않는다 — 비우면 로그아웃한 뒤 패키징 실행에서 다시 들어올 길이 없다 (AC-01, AUTH-01)
        if (!id && core.auth.owner() && ctx.settings().account.googleClientId.trim()) {
          throw new BackendError(
            'conflict',
            '대표가 등록된 뒤에는 구글 로그인 클라이언트 ID를 비울 수 없습니다 — 비우면 로그아웃한 뒤 다시 로그인하지 못합니다. 바꾸려면 새 클라이언트 ID를 넣으세요',
          );
        }
      }
      const mainPatch = patch.general?.mainAgent;
      if (typeof mainPatch?.effortOverride === 'string' && mainPatch.effortOverride) {
        const kind = mainPatch.kind ?? ctx.settings().general.mainAgent.kind;
        if (!EFFORT_LEVELS[kind].includes(mainPatch.effortOverride)) {
          throw new BackendError('invalid', `메인 에이전트 노력치 값은 ${EFFORT_LEVELS[kind].join('|')} 중 하나여야 합니다`);
        }
      }
      // 실행 설정은 범위 안의 값만 받는다 (리드 결정 15, settingsPolicy EXECUTION_LIMITS). 범위 밖·형식이 다른 값(문자열 "0" 등)·무한대면 아무것도
      // 저장하지 않는다. 메인의 update_settings도 이 처리기를 부른다 — 그런 값은 모든 턴을 곧바로 끊거나 시작하지 못하게 해 메인도 되돌릴 턴을 얻지 못한다
      const execProblems = executionPatchProblems(patch.execution);
      if (execProblems.length) throw new BackendError('invalid', `실행 설정 값을 받을 수 없습니다: ${execProblems.join('; ')}. ${EXECUTION_NO_LIMIT_NOTE}`);
      // 백업 보관 수·모델 목록 항목도 형식을 먼저 본다 — 메인이 바꿀 수 있는 항목이라, 객체 같은 값이 저장되면 대표 화면 운영 설정이 무너진다 (리드 결정 27)
      const shapeProblems = settingsShapeProblems(patch);
      if (shapeProblems.length) throw new BackendError('invalid', `설정 값을 받을 수 없습니다: ${shapeProblems.join('; ')}. 아무것도 저장하지 않았습니다`);
      const prev = ctx.settings();
      const next = normalizeSettings(deepMerge(ctx.settings(), patch));
      // CLI가 받지 못하는 AI 값은 저장 전에 거부한다 — 저장하면 해당 턴이 시작마다 실패한다 (F1)
      for (const kind of AI_KINDS) {
        for (const [tier, v] of Object.entries(next.team.effortMapping[kind])) {
          if (!EFFORT_LEVELS[kind].includes(v)) throw new BackendError('invalid', `${kind} 노력치 연결(${tier}) 값은 ${EFFORT_LEVELS[kind].join('|')} 중 하나여야 합니다: "${v}"`);
        }
        for (const o of next.team.modelCatalog?.[kind] ?? []) {
          if (!isValidModelName(o.id)) throw new BackendError('invalid', `${kind} 모델 목록의 id에는 공백·제어 문자를 쓸 수 없습니다: "${o.id}" (표시 이름은 label에)`);
        }
        // 생략한 용도 설명(note)은 빈 글로 채운다 (ModelOption.note)
        if (next.team.modelCatalog?.[kind]) next.team.modelCatalog[kind] = next.team.modelCatalog[kind].map((o) => ({ ...o, note: o.note ?? '' }));
      }
      const mainAi = { ...next.general.mainAgent, model: next.general.mainAgent.model?.trim() || null };
      next.general.mainAgent = mainAi;
      if (mainAi.model !== null && !isValidModelName(mainAi.model)) throw new BackendError('invalid', `메인 에이전트 모델 이름이 올바르지 않습니다: "${mainAi.model}"`);
      if (mainAi.effortOverride && !EFFORT_LEVELS[mainAi.kind].includes(mainAi.effortOverride)) {
        throw new BackendError('invalid', `메인 에이전트 노력치 값은 ${EFFORT_LEVELS[mainAi.kind].join('|')} 중 하나여야 합니다`);
      }
      next.account.googleClientSecretSet = ctx.settings().account.googleClientSecretSet;
      if (typeof clientIdPatch === 'string') next.account.googleClientId = clientIdPatch.trim();
      // 메인 AI(general.mainAgent)를 바꾸는 것은 운영자의 자리 배정이다 (리드 결정 S4-9 — 데스크톱 운영자 몫, 대표 게이트는 원격·메인을 그대로 거부한다).
      // 자리가 받아야(교체 중이 아니고, 보유자 목록 안이고, 종류를 바꾸면 그 CLI를 쓸 수 있어야) 설정을 저장한다 — 거부되면 아무것도 바꾸지 않는다. AI 종류가
      // 바뀌면 새 세대로 교체하고, 모델·노력치만 바뀌면 같은 세대에서 다음 턴부터.
      // 바뀌었는지는 저장된 값(prev.general.mainAgent)과 견준다 — 교체 중에는 저장된 값이 넘어갈 보유자라, 나가는 보유자로 되돌리는 요청도 자리에 가서
      // '넘기는 중'으로 거부되고(아무것도 저장하지 않음), 저장된 값을 그대로 다시 보내는 설치 설정 저장(기록 보관 등 다른 칸)은 지나간다 (리드 결정 S4-16)
      // 화면이 불러 둔 메인 AI(expected.mainAgent)를 함께 보내면 그 값이 지금 저장된 값과 같을 때만 바꾼다 — 메인의 hand_off_seat도 이 값을 쓰므로, 그사이
      // 바뀌었으면 먼저 연 화면이 메인의 변경을 되돌리지 않게 아무것도 저장하지 않고 거부한다. 보내지 않으면 예전 그대로다 (리드 결정 S4-25)
      const expectedMain = expected?.mainAgent;
      if (mainPatch !== undefined && expectedMain && !sameAiConfig(prev.general.mainAgent, { ...expectedMain, model: expectedMain.model?.trim() || null })) {
        const now = prev.general.mainAgent;
        const model = core.team.modelValue(now);
        throw new BackendError(
          'conflict',
          `메인 AI가 그사이 ${holderLabel({ kind: 'launched', ai: now })}(${model ? `모델 ${model}` : 'CLI 기본 모델'}, 노력치 ${core.team.effortValue(now)})로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요`,
        );
      }
      if (mainPatch !== undefined && !sameAiConfig(prev.general.mainAgent, mainAi)) {
        // 같은 요청이 메인 모의 실행을 끄면 끈 뒤의 값으로 쓸 수 있는지 본다 (리드 결정 S4-28)
        core.seat.assign({ holder: { kind: 'launched', ai: mainAi }, by: 'operator', reason: `운영 설정의 메인 AI 변경${actor === OWNER ? ' (데스크톱 운영자)' : ''}`, mainMock: next.developer.mainAgentMock });
      }
      // 바뀐 클라이언트 ID는 대표 로그인으로 확인될 때까지 로그인 화면에서 다시 넣을 수 있다 — 저장보다 먼저 표시한다 (auth.googleSetupOpen)
      if (next.account.googleClientId !== ctx.settings().account.googleClientId) core.auth.markGoogleChanged();
      ctx.saveSettings(next);
      // 로그인 없이 온 대표 요청은 게이트가 구글 설정 입력이 열려 있을 때(대표 등록 전, 또는 설정이 빠졌거나 확인되지 않음) 구글 설정만 통과시킨다
      const text =
        actor !== OWNER || core.auth.isLoggedIn()
          ? '운영 설정 변경'
          : `구글 로그인 설정: 클라이언트 ID ${next.account.googleClientId || '비움'} (${core.auth.owner() ? '대표 등록 뒤 설정이 빠졌거나 확인되지 않음' : '대표 등록 전'} — 로그인 없이)`;
      ctx.activity({ kind: 'settings', actor, text });
      // 결제 방식(AI 인증 방식)을 바꾸면 쿼터가 바뀌므로 그 종류의 사용량 한도 기록을 지우고 한 번 다시 시도한다 (리드 결정 22)
      for (const kind of AI_KINDS) {
        if (next.account.authMode[kind] !== prev.account.authMode[kind]) {
          const label = (m: unknown): string => AUTH_MODE_LABEL[m as keyof typeof AUTH_MODE_LABEL] ?? String(m).slice(0, 20);
          clearUsageLimits(kind, `AI 인증 방식 변경(${label(prev.account.authMode[kind])} → ${label(next.account.authMode[kind])})`);
        }
      }
      ctx.bus.signal('tick');
      return next;
    },
    'settings.setGoogleSecret': async (secret) => {
      if (typeof secret !== 'string') throw new BackendError('invalid', '보안 비밀은 문자열이어야 합니다');
      const value = secret.trim();
      // 대표가 등록된 뒤에는 지우지 않는다 — 지우면 로그아웃한 뒤 패키징 실행에서 다시 들어올 길이 없다 (AC-01). 바꾸려면 새 값을 넣는다
      if (!value && core.auth.owner()) {
        throw new BackendError('conflict', '대표가 등록된 뒤에는 구글 로그인 보안 비밀을 지울 수 없습니다 — 지우면 로그아웃한 뒤 다시 로그인하지 못합니다. 바꾸려면 새 보안 비밀을 넣으세요');
      }
      // SEC-09: 값은 OS 보안 저장소에만, 설정에는 등록 여부만
      if (value) {
        // 바뀐 보안 비밀은 대표 로그인으로 확인될 때까지 로그인 화면에서 다시 넣을 수 있다 — 저장보다 먼저 표시한다 (auth.googleSetupOpen)
        const prev = await ctx.deps.secrets.get(SECRET_KEYS.googleClientSecret).catch(() => null);
        if (prev !== value) core.auth.markGoogleChanged();
        await ctx.deps.secrets.set(SECRET_KEYS.googleClientSecret, value);
        // 형식 규칙(GOCSPX-)에 없는 값도 가린다 — 시작 때도 저장소에서 다시 넣는다 (SEC-10, AC-20)
        ctx.redact.addSecret(value, 'google-secret');
      } else await ctx.deps.secrets.delete(SECRET_KEYS.googleClientSecret);
      const s = ctx.settings();
      ctx.saveSettings({ ...s, account: { ...s.account, googleClientSecretSet: !!value } });
      const how = actor !== OWNER || core.auth.isLoggedIn() ? '' : ` (${core.auth.owner() ? '대표 등록 뒤 설정이 빠졌거나 확인되지 않음' : '대표 등록 전'} — 로그인 없이)`;
      ctx.activity({ kind: 'settings', actor, text: `구글 로그인 보안 비밀 ${value ? '등록' : '삭제'}${how}` });
    },
    'settings.setApiKey': async (kind: AiKind, key) => {
      const ai: AiKind = kind === 'claude' ? 'claude' : 'codex';
      const k = API_KEY_SECRET[ai];
      const value = typeof key === 'string' ? key.trim() : '';
      if (value) {
        await ctx.deps.secrets.set(k, value);
        ctx.redact.addSecret(value, 'api-key');
      } else await ctx.deps.secrets.delete(k);
      // 상태 확인용 메모리 사본도 바꾼다 (어댑터 statusEnv, 리드 결정 16)
      ctx.deps.apiKeys?.set(ai, value || null);
      ctx.activity({ kind: 'settings', actor, text: `${kind} API 키 ${value ? '등록' : '삭제'}` });
      // API 키 방식에서 키를 새로 넣으면 재로그인 필요를 푼다 — 틀린 키로 막힌 메인을 데스크톱 운영자가 풀 길이다. 키가 맞는지는 다음 턴이 확인한다
      // (틀리면 그 턴이 다시 건다) (리드 결정 16)
      if (value && ctx.settings().account.authMode[ai] === 'api_key') {
        const a = ctx.ai(ai);
        if (a.authRequired) {
          ctx.saveAi({ ...a, authRequired: false, authRequiredSince: null });
          ctx.activity({ kind: 'auth', actor, text: `${ai} API 키를 새로 등록해 재로그인 필요를 풂 (API 키 방식 — 키가 맞는지는 다음 턴에서 확인)` });
          ctx.bus.signal('tick');
        }
        // 키를 새로 넣으면 쿼터도 바뀐다 — 사용량 한도 기록을 지우고 한 번 다시 시도한다 (리드 결정 22)
        clearUsageLimits(ai, 'API 키를 새로 등록함(API 키 방식)');
      }
    },

    'roles.list': () => ctx.store.roles.list().map((r) => core.views.roleView(r)),
    'roles.create': async (input) => {
      const name = input.name.trim();
      if (!name) throw new BackendError('invalid', '역할 이름을 입력하세요');
      assertRoleAi(input.defaultAi);
      const skills = await skillNamesFor(core, input.allowedSkills, []);
      o.recheck?.();
      assertKnownSkills(input.allowedSkills, [], skills, '허용 스킬은 찾은 스킬 중에서만 고를 수 있습니다');
      // 찾는 동안 다른 호출이 같은 이름을 넣었을 수 있다 — 이름은 기다린 뒤에 보고, 여기서부터 넣을 때까지는 기다리지 않는다
      if (ctx.store.roles.list().some((r) => r.name === name)) throw new BackendError('conflict', '같은 이름의 역할이 있습니다');
      const now = ctx.now();
      const r: Role = {
        id: ctx.store.nextId('role'),
        name,
        instructions: input.instructions,
        taskTypes: input.taskTypes,
        allowedSkills: input.allowedSkills,
        defaultAi: input.defaultAi,
        canReview: input.canReview,
        builtin: false,
        // 만든 쪽은 이 처리기 묶음의 행위자 — 기록으로만 둔다(잠금 없음, 리드 결정 S5-12)
        createdBy: roleCreatorOf(actor),
        createdAt: now,
        updatedAt: now,
      };
      ctx.store.roles.insert(r);
      skillScans.delete(ctx);
      ctx.activity({ kind: 'settings', actor, text: `역할 추가 ${r.id} ${name}` });
      return core.views.roleView(r);
    },
    'roles.update': async (id, input) => {
      const before = ctx.store.roles.require(id);
      assertRoleAi(input.defaultAi);
      const skills = await skillNamesFor(core, input.allowedSkills, before.allowedSkills);
      o.recheck?.();
      // 기다린 뒤 지금 저장된 값으로 본다 — 찾지 못해도 그대로 두는 이름은 지금 저장된 이름이다 (리드 결정 S5-14)
      const r = ctx.store.roles.require(id);
      assertKnownSkills(input.allowedSkills, r.allowedSkills, skills, '허용 스킬은 찾은 스킬 중에서만 고를 수 있습니다');
      const name = input.name.trim() || r.name;
      // 이름을 바꿀 때도 다른 역할과 겹치지 않게 — 만들 때와 같은 규칙 (리드 결정 S5-13)
      if (name !== r.name && ctx.store.roles.list().some((x) => x.id !== id && x.name === name)) throw new BackendError('conflict', '같은 이름의 역할이 있습니다');
      const next: Role = {
        ...r,
        name,
        instructions: input.instructions,
        taskTypes: input.taskTypes,
        allowedSkills: input.allowedSkills,
        defaultAi: input.defaultAi,
        canReview: r.id === 'producer' ? true : input.canReview,
        updatedAt: ctx.now(),
      };
      ctx.store.roles.put(next);
      skillScans.delete(ctx);
      ctx.activity({ kind: 'settings', actor, text: `역할 수정 ${id}` });
      // 검수 권한을 껐으면 이 역할 팀원이 맡은 검수를 지금 다시 정한다 — 그대로 두면 그 검수는 submit_review가 거부된 뒤에야 재배정된다 (리드 결정 S5-13)
      if (r.canReview && !next.canReview) {
        core.team.repickIneligibleReviewers(
          ctx.store.members.list({ ref1: id, state: 'active' }).map((m) => m.id),
          `역할 ${id}의 검수 권한 해제`,
        );
      }
      return core.views.roleView(next);
    },
    'roles.delete': (id) => {
      const r = ctx.store.roles.require(id);
      if (r.builtin) throw new BackendError('forbidden', '기본 역할은 삭제할 수 없습니다');
      if (ctx.store.members.list({ ref1: id, state: 'active' }).length) throw new BackendError('conflict', '이 역할을 쓰는 팀원이 있습니다');
      ctx.store.roles.delete(id);
      skillScans.delete(ctx);
      // 만들기·고치기처럼 지우기도 활동 기록에 남는다 (리드 결정 S5-13)
      ctx.activity({ kind: 'settings', actor, text: `역할 삭제 ${id} ${r.name}` });
    },
    'skills.list': async () => {
      const found = await foundSkills(core);
      // 모드·허용 역할은 부를 때 저장된 값으로 — 캐시는 찾은 스킬만 담는다
      const overrides = ctx.settings().skills.overrides;
      const roles = ctx.store.roles.list();
      return found.map(
        (s): SkillView => ({
          name: s.name,
          description: s.description,
          source: s.source,
          path: s.path,
          mode: overrides[s.name] ?? s.mode,
          allowedRoles: roles.filter((r) => r.allowedSkills.includes(s.name)).map((r) => r.id),
        }),
      );
    },
    'skills.setMode': async (name, mode) => {
      // 스킬 구분도 찾은 스킬에만 — 이미 구분을 정해 둔 이름은 지금 찾지 못해도 바꿀 수 있다 (리드 결정 S5-14)
      const skills = await skillNamesFor(core, [name], Object.keys(ctx.settings().skills.overrides));
      o.recheck?.();
      const s = ctx.settings();
      assertKnownSkills([name], Object.keys(s.skills.overrides), skills, '스킬 구분은 찾은 스킬에만 정할 수 있습니다');
      ctx.saveSettings({ ...s, skills: { overrides: { ...s.skills.overrides, [name]: mode } } });
    },
    'skills.setRoleSkills': async (roleId, skills) => {
      const found = await skillNamesFor(core, skills, ctx.store.roles.require(roleId).allowedSkills);
      const r = ctx.store.roles.require(roleId);
      assertKnownSkills(skills, r.allowedSkills, found, '허용 스킬은 찾은 스킬 중에서만 고를 수 있습니다');
      ctx.store.roles.put({ ...r, allowedSkills: [...new Set(skills)], updatedAt: ctx.now() });
      skillScans.delete(ctx);
    },
    'logs.search': (f) => ctx.store.activity.search({ ...f, projectId: f.projectId ?? undefined }).map((e) => core.views.activityView(e)),
    'logs.export': (f) => {
      const rows = ctx.store.activity.search({ ...f, projectId: f.projectId ?? undefined, limit: 5000 });
      mkdirSync(ctx.paths.exports, { recursive: true });
      const file = join(ctx.paths.exports, `activity-${ctx.now().replace(/[:.]/g, '-')}.jsonl`);
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      ctx.activity({ kind: 'system', actor, text: `활동 기록 내보내기 ${rows.length}건 → ${file}` });
      return { path: file };
    },

    'system.prereqs': () => prereqs(),
    'system.info': () => ({
      dataDir: ctx.paths.root,
      appVersion: ctx.deps.appVersion ?? '0.1.0',
      isPackaged: ctx.deps.isPackaged,
      platform: process.platform,
      processRunner: { mode: ctx.deps.runner.mode, detail: ctx.deps.runner.detail },
      toolServerUrl: core.toolServer?.url ?? null,
    }),
    'system.recheckAi': async (kind) => {
      const st = await ctx.deps.adapters[kind].detect();
      o.recheck?.();
      // API 키 방식이고 키가 등록돼 있으면 로그인 필요(false)는 알 수 없음으로 본다 — 재로그인 필요를 풀어 한 번 더 시도한다. 틀린 키면 다음 턴이
      // 다시 건다 (리드 결정 16)
      const loggedIn = await loginStateForAuth(kind, st.loggedIn, ctx.settings().account.authMode[kind], ctx.deps.secrets);
      o.recheck?.();
      const a = ctx.ai(kind);
      ctx.saveAi({
        ...a,
        cliInstalled: st.installed,
        cliVersion: st.version,
        cliProblem: st.installed ? st.problem : '설치되지 않음',
        authRequired: loggedIn === false,
        authRequiredSince: loggedIn === false ? (a.authRequiredSince ?? ctx.now()) : null,
        checkedAt: ctx.now(),
      });
      const keyNote = loggedIn !== st.loggedIn ? ' (API 키 방식 — 등록된 키가 맞는지는 다음 턴에서 확인하므로 재로그인 필요로 막지 않음)' : '';
      ctx.activity({ kind: 'auth', actor, text: `${kind} CLI 다시 확인: ${st.detail}${keyNote}` });
      ctx.bus.signal('tick');
    },
    'system.pickFiles': async () => (ctx.deps.shell ? ctx.deps.shell.pickFiles() : []),
    'system.openPath': async (p) => {
      if (!allowedOpen(p)) throw new BackendError('forbidden', '앱 데이터·프로젝트 폴더 안의 경로만 열 수 있습니다');
      await ctx.deps.shell?.openPath(p);
    },
    'system.backupNow': () => backupNow(core),
  };
  return api;
}

/**
 * 운영자·시험용 내부 API (SERVER_DESIGN 2.5): 대표 게이트를 거치지 않고 모든 처리기를 운영자(OPERATOR) 행위자로 부른다. 시험 준비(프로젝트·팀원·모의
 * 설정)와 운영자의 프로세스 안 조작에 쓴다. 프로세스 안에서만 쓰고 어떤 네트워크(IPC·HTTP·앱 도구 서버)에도 올리지 않는다
 */
/** 원격 호출자에 따라 답이 다른 대표 메서드의 처리기 — 첫 인자가 호출자다 */
export type CallerHandlers = { [M in WookMethod]?: (caller: RemoteCaller, ...args: WookParams<M>) => WookResult<M> | Promise<WookResult<M>> };

/**
 * 원격 호출자(서버 HTTP, S3-3·S3-4)가 부를 때 쓰는 처리기: 로그인 상태·로그아웃·기기 목록·끊기와 스냅숏의 auth는 그 호출자 것이다. 여기 없는 메서드는
 * createApi의 처리기를 그대로 쓴다. 기기 코드 로그인(deviceLogin·deviceLoginPoll)과 대표 이메일 첫 설정(setupOwner)은 서버의 대표 로그인(serverLogin.ts,
 * S3-5·S3-6)이 그 호출자로 처리한다 — 결과는 그 로그인을 시작한 호출자에게만, 성공한 응답에 세션 쿠키.
 * 명령(command.send)의 첨부는 그 기기가 올린 파일만 받고(S3-10), 로그인 전의 준비 상태(system.prereqs)는 60초 캐시한 최소 정보다(S3-11)
 */
export function createCallerApi(core: Core): CallerHandlers {
  const base = createApi(core);
  // 로그인 전 원격 호출자의 준비 상태: 60초에 한 번만 다시 읽고 최소 정보만 (S3-11) — 다시 읽을 때마다 CLI·git 확인 프로세스를 띄운다
  let publicPrereqs: { at: number; value: Promise<PrereqStatus> } | null = null;
  return {
    'auth.getState': (caller) => core.auth.state(caller),
    'auth.login': () => {
      throw new BackendError('forbidden', SERVER_BROWSER_LOGIN);
    },
    'auth.logout': (caller) => core.auth.logoutDevice(caller),
    'auth.deviceLogin': (caller, deviceName) => core.serverLogin.startDeviceLogin(caller, deviceName),
    'auth.deviceLoginPoll': (caller, loginId) => core.serverLogin.pollDeviceLogin(caller, loginId),
    'auth.setupOwner': (caller, code, email) => core.serverLogin.setupOwner(caller, code, email),
    'auth.listDevices': (caller) => core.auth.listDevices(caller),
    'auth.revokeDevice': (caller, sessionId) => core.auth.revokeDevice(caller, sessionId),
    // 스냅숏의 로그인 상태는 그 호출자 것 — 서버의 버스 스냅숏은 호출자 없는(세션 없는) 상태로 만들어진다 (S3-3)
    'snapshot.get': (caller) => ({ ...core.views.snapshot(), auth: core.auth.state(caller) }),
    // 원격 명령의 첨부는 그 기기가 올린 파일(uploadId)만 — 서버 PC의 파일 경로는 받지 않는다 (S3-10)
    'command.send': (caller, input) => base['command.send'](core.serverFiles.remoteCommand(caller, input)),
    // 로그인 전에는 60초 캐시한 최소 정보만 (S3-11) — 로그인한 대표는 예전 그대로 그때 확인한 전체 상태
    'system.prereqs': (caller) => {
      if (core.auth.isLoggedIn(caller)) return base['system.prereqs']();
      const now = core.ctx.clock.ms();
      if (!publicPrereqs || now - publicPrereqs.at >= PUBLIC_PREREQS_TTL_MS) publicPrereqs = { at: now, value: Promise.resolve(base['system.prereqs']()).then(minimalPrereqs) };
      return publicPrereqs.value;
    },
  };
}

/** 로그인 전 원격 호출자에게 주는 준비 상태를 다시 읽는 간격 (S3-11) */
export const PUBLIC_PREREQS_TTL_MS = 60_000;

/** 로그인 전 원격 호출자에게 주는 준비 상태 — 되는지 여부만, 버전·설명·CLI 로그인 상태는 빼고 (S3-11: 로그인 전에 서버의 설치 내용을 보여 주지 않는다) */
export function minimalPrereqs(p: PrereqStatus): PrereqStatus {
  return {
    git: { ok: p.git.ok, version: null },
    claude: { ok: p.claude.ok, version: null, loggedIn: null, detail: '' },
    codex: { ok: p.codex.ok, version: null, loggedIn: null, detail: '' },
    google: { configured: p.google.configured },
    jobRunner: { ok: p.jobRunner.ok, detail: '' },
    // 로그인 전에는 되는지 여부만 — 잠김·연결 끊김 같은 서버 PC의 상태도 보이지 않는다
    screen: { ok: p.screen.ok, state: 'unknown', detail: '', elevated: null },
  };
}

export function createInternalApi(core: Core): ApiHandlers {
  return createApi(core, OPERATOR);
}

/** 앱 데이터 백업 (ENV-07): DB 온라인 백업 + 보고서·기억 복사, 최근 N개 보관 */
export function backupNow(core: Core): { path: string } {
  const ctx = core.ctx;
  const stamp = ctx.now().replace(/[:.]/g, '-');
  const dir = join(ctx.paths.backups, stamp);
  mkdirSync(dir, { recursive: true });
  ctx.store.backupTo(join(dir, 'wook.db'));
  copyTree(ctx.paths.reports, join(dir, 'reports'));
  copyTree(ctx.paths.memory, join(dir, 'memory'));
  const keep = Math.max(1, ctx.settings().general.backup.keep);
  const all = readdirSync(ctx.paths.backups).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) removeTree(join(ctx.paths.backups, old));
  ctx.activity({ kind: 'system', text: `백업 완료 → ${dir}` });
  return { path: dir };
}
