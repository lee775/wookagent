/**
 * 누가 어떤 운영 설정을 바꾸는지 (SERVER_DESIGN 2.3·2.5·2.6, SEC-02).
 * - 메인 에이전트(`update_settings`): 실행(상한 N·오류 기준·턴 상한·절전 방지), 팀(노력치 연결·모델 목록), AI 인증 방식(구독·API 키 — 키 값은 운영자),
 *   백업 보관 수만. 계정·구글·API 키 값·데이터 위치·CLI 실행 파일 위치·메인 AI(자리 넘기기로만)·개발자 옵션은 거부한다 — 대표를 잠글 수 있는 설정은
 *   메인도 바꾸지 못한다
 * - 데스크톱 운영자(그 PC의 사람): 계정·구글(AI 인증 방식 포함, 리드 결정 9)·CLI 실행 파일 위치와 운영자 몫(보안 정책·기록 보관 기간·자동 백업 켜기·
 *   로그인 때 실행, 메인 AI general.mainAgent — 리드 결정 8) (@shared/ipc DESKTOP_OPERATOR_SETTINGS).
 *   운영자 몫은 메인 에이전트가 바꾸지 못한다 — 보안 정책을 약하게 하거나 기록을 줄이지 못하게 (리드 결정 2, AC-19, LOG-03)
 * 그 밖의 항목은 운영자 내부 API(createInternalApi)로만 바뀐다
 * 실행 설정은 누가 바꾸든 EXECUTION_LIMITS 범위 안의 값만 받는다 — 메인이 바꾼 설정이 메인 자신을 막지 못하게 (리드 결정 15). 실행 상한의 하한은 2다
 * (관리 업무 자리, 리드 결정 27). 백업 보관 수와 모델 목록 항목도 같은 길에서 형식을 본다 (settingsShapeProblems, 리드 결정 27). AI 인증 방식은
 * subscription·api_key만 받는다 (같은 길, 리드 결정 34)
 * 데스크톱 운영자는 모의 실행을 끄기만 한다(backend/ownerGate.ts). 설치된 앱에서 모의 실행이 켜져 있으면 시작 때 한 번 알린다 (noticeMockOn, 리드 결정 23)
 */
import type { Settings } from '@shared/domain';
import type { Ctx } from './context';
import { defaultSettings } from './defaults';

/** 메인 에이전트가 바꿀 수 있는 설정 항목 (점으로 이은 경로, 그 아래 전부) */
export const MAIN_SETTINGS: readonly string[] = ['execution', 'team.effortMapping', 'team.modelCatalog', 'account.authMode', 'general.backup.keep'];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 부분 갱신(patch)에서 허용 항목 밖의 경로 — 비어 있으면 모두 허용 항목이다. 허용 항목에 닿기 전의 값이 객체가 아니면(통째 바꾸기) 그 경로를 밖으로 본다.
 * 빈 객체는 아무것도 바꾸지 않으므로 세지 않는다
 */
export function settingsOutside(patch: unknown, allowed: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (path && allowed.some((a) => path === a || path.startsWith(`${a}.`))) return;
    const deeper = allowed.some((a) => !path || a.startsWith(`${path}.`));
    if (!deeper || !isPlainObject(value)) {
      out.push(path || '(전체)');
      return;
    }
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  };
  if (!isPlainObject(patch)) return ['(전체)'];
  walk(patch, '');
  return out;
}

/** 부분 갱신의 바뀐 항목 경로 (활동 기록·알림용 — 값은 남기지 않는다) */
export function changedPaths(patch: unknown, prefix = ''): string[] {
  if (!isPlainObject(patch)) return prefix ? [prefix] : [];
  return Object.entries(patch).flatMap(([k, v]) => changedPaths(v, prefix ? `${prefix}.${k}` : k));
}

// ───────────────────────── 실행 설정 범위 (리드 결정 15) ─────────────────────────

type ExecutionKey = keyof Settings['execution'];
type ExecutionNumberKey = Exclude<ExecutionKey, 'preventSleep'>;

export interface ExecutionLimit {
  /** 사람이 읽는 이름 */
  label: string;
  /** 범위 뒤에 붙는 단위 (분·번 등) */
  unit: string;
  min: number;
  max: number;
  integer: boolean;
  /** null이 '제한 없음'인 항목 */
  nullable?: boolean;
}

/**
 * 실행 설정 숫자 항목의 범위. 메인의 update_settings와 운영자·데스크톱의 settings.update가 같은 검사를 쓰고(범위 밖이면 아무것도 저장하지 않음),
 * 시작 때 저장된 값도 이 범위로 맞춘다. 범위 밖 값(예: 턴 시간 상한 0)은 모든 턴을 곧바로 끊거나 시작하지 못하게 해, 메인 에이전트도 그 값을 되돌릴 턴을
 * 얻지 못한다. 절전 방지(preventSleep)는 true·false만 받는다
 */
export const EXECUTION_LIMITS: Readonly<Record<ExecutionNumberKey, ExecutionLimit>> = {
  // 하한 2: 실행 상한이 2 이상이어야 일반 작업이 N-1자리까지만 써서 관리 업무(프로듀서·메인 에이전트) 자리가 늘 남는다 (@core/scheduling, 리드 결정 27)
  maxConcurrent: { label: '전체 CLI 실행 상한', unit: '개', min: 2, max: 32, integer: true },
  turnTimeoutMin: { label: '턴 시간 상한', unit: '분', min: 5, max: 1440, integer: false },
  commandMaxMin: { label: '실행 명령 시간 상한', unit: '분', min: 1, max: 1440, integer: false },
  noOutputMin: { label: '응답 없음 기준', unit: '분', min: 1, max: 1440, integer: false },
  healthCheckMin: { label: '응답 확인 대기', unit: '분', min: 1, max: 60, integer: false },
  spinNoProgressMin: { label: '진척 없음 기준', unit: '분', min: 5, max: 1440, integer: false },
  claudeMaxTurns: { label: 'Claude 최대 반복 수', unit: '번', min: 10, max: 10000, integer: true, nullable: true },
  crashRetryMax: { label: '비정상 종료 재시도', unit: '번', min: 0, max: 10, integer: true },
  spinSameErrorCount: { label: '같은 오류 반복 기준', unit: '번', min: 2, max: 100, integer: true },
  spinNoProgressResumes: { label: '진척 없는 자동 재개', unit: '번', min: 0, max: 20, integer: true },
};

const PREVENT_SLEEP_LABEL = '절전 방지';

/** '제한 없음'을 0으로 이해한 요청에 덧붙이는 안내 */
export const EXECUTION_NO_LIMIT_NOTE =
  "'제한 없음'은 0이 아닙니다. 시간 상한은 없앨 수 없으니 가장 긴 값(턴 시간 상한이면 1440분)을 쓰고, 제한 없음을 null로 두는 항목은 Claude 최대 반복 수(claudeMaxTurns)뿐입니다";

const limitText = (r: ExecutionLimit): string => `${r.min}~${r.max}${r.unit}${r.integer ? ' 정수' : ''}${r.nullable ? ' 또는 null(제한 없음)' : ''}`;

/** update_settings 설명에 넣는 단위와 범위 (위 표에서 만든다) */
export function executionRangesText(): string {
  const rows = (Object.entries(EXECUTION_LIMITS) as [ExecutionNumberKey, ExecutionLimit][]).map(([k, r]) => `${k} ${limitText(r)}`);
  return [...rows, 'preventSleep true·false'].join(', ');
}

/** 거부 글에 넣는 값 — 숫자·참거짓·null과 짧은 문자열만 그대로 쓴다. 긴 문자열은 옮기지 않는다 (비밀 값이 섞여 들어와도 기록에 남지 않게) */
function valueText(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (typeof v === 'string') return v.length > 12 ? '긴 문자열' : `문자열 "${v}"`;
  if (v === undefined) return '값 없음';
  return Array.isArray(v) ? '배열' : '객체';
}

/** 실행 설정 항목 하나의 문제 (없으면 null) */
function executionValueProblem(key: string, v: unknown): string | null {
  if (key === 'preventSleep') return typeof v === 'boolean' ? null : `${PREVENT_SLEEP_LABEL}(preventSleep) ${valueText(v)} — true·false만`;
  if (!Object.hasOwn(EXECUTION_LIMITS, key)) return `모르는 항목 ${key.slice(0, 40)}`;
  const r = EXECUTION_LIMITS[key as ExecutionNumberKey];
  if (v === null && r.nullable) return null;
  const ok = typeof v === 'number' && Number.isFinite(v) && (!r.integer || Number.isInteger(v)) && v >= r.min && v <= r.max;
  return ok ? null : `${r.label}(${key}) ${valueText(v)} — ${limitText(r)}`;
}

/** 부분 갱신의 execution에서 받을 수 없는 값 — 비어 있으면 받는다. 모르는 항목, 형식이 다른 값(문자열 "0" 등), 무한대, 범위 밖 */
export function executionPatchProblems(patch: unknown): string[] {
  if (patch === undefined) return [];
  if (!isPlainObject(patch)) return [`execution은 바꿀 항목과 값을 담은 객체여야 합니다(${valueText(patch)})`];
  return Object.entries(patch)
    .map(([k, v]) => executionValueProblem(k, v))
    .filter((p): p is string => p !== null);
}

// ───────────────────────── 백업 보관 수·모델 목록 형식 (리드 결정 27) ─────────────────────────

/** 백업 보관 수(general.backup.keep)의 범위 — 정수 */
export const BACKUP_KEEP_LIMIT = { min: 1, max: 365 } as const;

const MODEL_CATALOG_KINDS: readonly string[] = ['claude', 'codex'];

/** AI 인증 방식(account.authMode)의 값 — 구독·API 키 (리드 결정 34) */
const AUTH_MODES: readonly Settings['account']['authMode'][keyof Settings['account']['authMode']][] = ['subscription', 'api_key'];

/**
 * 부분 갱신에서 백업 보관 수와 모델 목록 항목의 형식 문제 — 비어 있으면 받는다. 메인 에이전트가 바꿀 수 있는 항목이라 실행 설정처럼 저장 전에 본다:
 * 형식이 틀린 값(객체 등)이 저장되면 대표 화면 운영 설정이 그 값을 그리다 무너진다. 백업 보관 수는 1~365 정수, 모델 목록은 AI 종류(claude·codex)별 배열이고
 * 각 항목은 id·label이 문자열, note는 문자열이거나 생략. null(기본 목록으로 되돌림)은 받는다.
 * AI 인증 방식(account.authMode)은 AI 종류(claude·codex)별로 subscription·api_key만 받는다 — 메인의 update_settings와 데스크톱 운영자가 함께 바꾸는
 * 항목이다. 다른 값은 구독처럼 돌아 결제 방식이 화면과 다르게 되고, 그 값이 활동 기록 글에도 그대로 들어갔다 (리드 결정 34)
 */
export function settingsShapeProblems(patch: unknown): string[] {
  if (!isPlainObject(patch)) return [];
  const out: string[] = [];
  const general = patch['general'];
  const backup = isPlainObject(general) ? general['backup'] : undefined;
  const keep = isPlainObject(backup) ? backup['keep'] : undefined;
  if (keep !== undefined && !(typeof keep === 'number' && Number.isInteger(keep) && keep >= BACKUP_KEEP_LIMIT.min && keep <= BACKUP_KEEP_LIMIT.max)) {
    out.push(`백업 보관 수(general.backup.keep) ${valueText(keep)} — ${BACKUP_KEEP_LIMIT.min}~${BACKUP_KEEP_LIMIT.max}개 정수`);
  }
  const account = patch['account'];
  const authMode = isPlainObject(account) ? account['authMode'] : undefined;
  if (authMode !== undefined) {
    if (!isPlainObject(authMode)) out.push(`AI 인증 방식(account.authMode)은 AI 종류별 값을 담은 객체여야 합니다(${valueText(authMode)})`);
    else {
      for (const [kind, mode] of Object.entries(authMode)) {
        if (!MODEL_CATALOG_KINDS.includes(kind)) out.push(`AI 인증 방식의 AI 종류 ${kind.slice(0, 20)} — claude·codex만`);
        else if (!(AUTH_MODES as readonly unknown[]).includes(mode)) out.push(`AI 인증 방식(account.authMode.${kind}) ${valueText(mode)} — subscription(구독)·api_key(API 키)만`);
      }
    }
  }
  const team = patch['team'];
  const catalog = isPlainObject(team) ? team['modelCatalog'] : undefined;
  if (catalog === undefined || catalog === null) return out;
  if (!isPlainObject(catalog)) return [...out, `모델 목록(team.modelCatalog)은 AI 종류별 목록을 담은 객체여야 합니다(${valueText(catalog)})`];
  for (const [kind, list] of Object.entries(catalog)) {
    const at = `team.modelCatalog.${kind.slice(0, 20)}`;
    if (!MODEL_CATALOG_KINDS.includes(kind)) {
      out.push(`모델 목록의 AI 종류 ${kind.slice(0, 20)} — claude·codex만`);
      continue;
    }
    if (!Array.isArray(list)) {
      out.push(`모델 목록(${at})은 항목 배열이어야 합니다(${valueText(list)})`);
      continue;
    }
    list.forEach((o: unknown, i) => {
      if (!isPlainObject(o)) return void out.push(`모델 목록 항목(${at}[${i}])은 {id, label, note} 객체여야 합니다(${valueText(o)})`);
      if (typeof o['id'] !== 'string') out.push(`모델 목록 항목(${at}[${i}])의 id ${valueText(o['id'])} — 문자열이어야 합니다`);
      if (typeof o['label'] !== 'string') out.push(`모델 목록 항목(${at}[${i}])의 label ${valueText(o['label'])} — 문자열이어야 합니다`);
      if (o['note'] !== undefined && typeof o['note'] !== 'string') out.push(`모델 목록 항목(${at}[${i}])의 note ${valueText(o['note'])} — 문자열이거나 생략해야 합니다`);
    });
  }
  return out;
}

/**
 * 시작 때: 저장된 실행 설정 중 범위 밖 값을 기본값(defaults.ts)으로 되돌린다. 이 검사가 생기기 전에 저장된 값(예: 턴 시간 상한 0)이 남아 있으면
 * 재시작해도 모든 턴이 곧바로 끊긴다. 되돌린 것이 있을 때만 활동 기록 1줄과 정보 알림 1개 — 다시 돌면 할 일이 없다(멱등). 되돌린 항목 이름을 돌려준다
 */
export function resetExecutionOutOfRange(ctx: Ctx): ExecutionKey[] {
  const s = ctx.settings();
  const d = defaultSettings().execution;
  const keys = (Object.keys(d) as ExecutionKey[]).filter((k) => executionValueProblem(k, s.execution[k]) !== null);
  if (!keys.length) return [];
  const label = (k: ExecutionKey): string => (k === 'preventSleep' ? PREVENT_SLEEP_LABEL : EXECUTION_LIMITS[k].label);
  const changes = keys.map((k) => `${label(k)}(${k}) ${valueText(s.execution[k])} → ${String(d[k])}`).join(', ');
  ctx.saveSettings({ ...s, execution: { ...s.execution, ...Object.fromEntries(keys.map((k) => [k, d[k]])) } });
  ctx.activity({ kind: 'settings', level: 'warn', text: `시작 때 확인: 허용 범위 밖의 실행 설정을 기본값으로 되돌림 — ${changes}` });
  ctx.notify({
    level: 'info',
    title: '실행 설정을 기본값으로 되돌림',
    body: `허용 범위 밖이던 실행 설정을 기본값으로 되돌렸습니다: ${changes}. 그 값으로는 턴이 곧바로 끊기거나 시작하지 못합니다. 다른 값이 필요하면 메인 에이전트에게 범위 안의 값으로 바꿔 달라고 명령하세요.`,
    link: { tab: 'settings', section: 'execution' },
    key: 'execution-reset',
  });
  return keys;
}

// ───────────────────────── 켜져 있는 모의 실행 (리드 결정 23) ─────────────────────────

/** 알린 모의 실행 상태 (켜진 대상) — 같은 상태로 다시 시작하면 다시 알리지 않는다 */
const MOCK_ON_NOTICE_KV = 'notice:mock-on';

/**
 * 시작 때(설치된 앱만): 모의 실행(메인 에이전트 모의 모드·프로젝트 모의 실행)이 켜져 있으면 정보 알림 하나(key mock-on)로 설치 설정에서 끌 수 있다고
 * 알린다. 1단계 전 개발자 옵션에서 켠 값이 남으면 메인 에이전트와 그 팀이 실제 CLI 대신 모의 에이전트로 돌아 명령이 실제로 처리되지 않는다.
 * 알린 상태(켜진 대상)를 저장해 두어 같은 상태로 다시 시작하면 아무것도 하지 않는다(멱등) — 켜진 대상이 바뀌거나, 모두 꺼졌다가 다시 켜지면 새로
 * 알린다. 알렸으면 true
 */
export function noticeMockOn(ctx: Ctx): boolean {
  if (!ctx.deps.isPackaged) return false;
  const main = ctx.settings().developer.mainAgentMock === true;
  const projects = ctx.store.projects.list({ state: 'active' }).filter((p) => p.mock.enabled);
  const state = main || projects.length ? JSON.stringify({ main, projects: projects.map((p) => p.id).sort() }) : null;
  if ((ctx.store.kv.get<string | null>(MOCK_ON_NOTICE_KV) ?? null) === state) return false;
  ctx.store.kv.set(MOCK_ON_NOTICE_KV, state);
  if (!state) return false;
  const what = [...(main ? ['메인 에이전트'] : []), ...projects.map((p) => `프로젝트 ${p.name}(${p.id})`)].join(', ');
  ctx.notify({
    level: 'info',
    title: '모의 실행이 켜져 있음',
    body: `모의 실행으로 돌고 있는 대상: ${what}. 모의 실행은 개발·시험용이라 실제 AI CLI를 쓰지 않으므로, 명령을 내려도 실제 작업은 일어나지 않습니다. 운영 설정의 설치 설정에서 끌 수 있습니다.`,
    link: { tab: 'settings', section: 'account' },
    key: 'mock-on',
  });
  ctx.activity({ kind: 'settings', text: `시작 때 확인: 모의 실행이 켜져 있음 — ${what} (설치 설정에서 끌 수 있다고 알림)` });
  return true;
}
