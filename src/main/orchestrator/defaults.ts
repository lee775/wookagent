/** 기본 역할 (기획서 4.2)·운영 설정 기본값 (13.7) */
import type { Actor, AiConfig, AiKind, BuiltinRoleId, EffortTier, Role, RoleCreator, Settings, TaskType } from '@shared/domain';
import { DEFAULT_MODEL_CATALOG } from './aiGuide';
import { AI_KINDS, LEGACY_EFFORT_ALIASES, MAIN_AGENT_ID, OPERATOR } from '@shared/domain';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 예전 노력치 목록에만 있던 값(codex none·minimal — 설치된 모델이 받지 않음)을 지금 목록의 값으로 읽는다 (windows:F7).
 * 목록에 있는 값·모르는 값은 그대로 둔다 — 모르는 값은 저장 전 검사·실행 전 검사가 거부한다
 */
export function normalizeEffort(kind: AiKind, value: string): string {
  const aliases = LEGACY_EFFORT_ALIASES[kind];
  return Object.hasOwn(aliases, value) ? aliases[value]! : value;
}

function ai(kind: AiConfig['kind'], effortTier: AiConfig['effortTier']): AiConfig {
  return { kind, model: null, effortTier, effortOverride: null };
}

/** 프로듀서 기본 지침의 자기 작업 검수 문장 — 대표 검수는 없다 (REV-06 v0.6). 예전 문장은 시작 때 migrations.ts가 이것으로 바꾼다 */
export const PRODUCER_SELF_REVIEW_LINE = '네가 직접 한 작업은 다른 팀원이나 메인 에이전트("main")가 검수한다.';

interface RoleSeed {
  id: BuiltinRoleId;
  name: string;
  taskTypes: TaskType[];
  canReview: boolean;
  defaultAi: AiConfig;
  instructions: string;
}

const ROLE_SEEDS: RoleSeed[] = [
  {
    id: 'producer',
    name: '프로듀서',
    taskTypes: ['plan'],
    canReview: true,
    defaultAi: ai('claude', 'high'),
    instructions: [
      '너는 이 프로젝트의 프로듀서(PM·PD)다. 팀을 지휘하지만 직접 구현하는 것보다 계획·배정·판단이 본업이다.',
      '- 지시를 한 명이 한 번에 끝낼 크기(단계 3~10개)의 작업으로 쪼개 팀원 역할에 맞게 배정한다.',
      '- 작업마다 완료 조건을 구체적으로 쓰고, 수정 예정 영역이 겹치면 선행 작업으로 순서를 정한다. 의존성 목록·DB 구조·공통 설정은 한 번에 한 작업만 고치게 한다.',
      `- 검수자는 작업자가 아닌 검수 권한 팀원(QA·설계자)이나 너 자신으로 정한다. ${PRODUCER_SELF_REVIEW_LINE}`,
      '- 팀원 질문에는 빠르고 분명하게 답하고, 검수를 통과한 저장소 변경 작업은 request_merge로 병합을 요청한다.',
      '- 지시의 작업이 모두 끝나면 submit_final_result로 결과를 정리해 메인 에이전트에게 넘긴다.',
    ].join('\n'),
  },
  {
    id: 'planner',
    name: '기획자',
    taskTypes: ['spec', 'research'],
    canReview: false,
    defaultAi: ai('claude', 'normal'),
    instructions: '너는 기획자다. 요구사항을 정리하고 기능 명세와 화면 흐름을 문서로 만든다. 모호한 점은 가정과 근거를 함께 적고, 필요하면 프로듀서에게 질문한다.',
  },
  {
    id: 'architect',
    name: '설계자',
    taskTypes: ['architecture'],
    canReview: true,
    defaultAi: ai('claude', 'high'),
    instructions: '너는 설계자다. 구조를 설계하고 기술 결정을 내리며 코드 리뷰를 한다. 결정에는 대안과 근거를 남기고, 검수할 때는 완료 조건을 하나씩 확인해 근거와 함께 판정한다.',
  },
  {
    id: 'developer',
    name: '개발자',
    taskTypes: ['development', 'bugfix'],
    canReview: false,
    defaultAi: ai('codex', 'normal'),
    instructions: '너는 개발자다. 기능을 구현하고 버그를 고치며 단위 테스트를 함께 작성한다. 프로젝트의 기존 구조·규칙(AGENTS.md)을 따르고, 단계마다 동작을 확인한 뒤 complete_step을 호출한다.',
  },
  {
    id: 'ui_designer',
    name: 'UI 디자이너',
    taskTypes: ['design'],
    canReview: false,
    defaultAi: ai('codex', 'normal'),
    instructions: '너는 UI 디자이너다. 화면 구성·스타일·UI 컴포넌트를 만든다. 접근성(키보드·대비·색 외 표시)을 지키고 기존 디자인 규칙을 따른다.',
  },
  {
    id: 'qa',
    name: 'QA',
    taskTypes: ['test'],
    canReview: true,
    defaultAi: ai('claude', 'normal'),
    instructions: '너는 QA다. 테스트를 작성·실행하고 버그를 보고한다. 검수자로 배정되면 완료 조건마다 직접 확인한 근거를 남기고, 확인하지 못한 것은 통과로 처리하지 않는다.',
  },
  {
    id: 'docs',
    name: '문서 담당',
    taskTypes: ['docs'],
    canReview: false,
    defaultAi: ai('claude', 'low'),
    instructions: '너는 문서 담당이다. 사용 설명·변경 기록·문서를 정리한다. 실제 동작과 다른 내용을 쓰지 않도록 코드와 결과를 확인하고 쓴다.',
  },
];

/**
 * 역할을 만든 쪽 — 기록으로만 둔다 (SERVER_DESIGN 7장, 리드 결정 S5-12). 새 역할은 처리기 묶음의 행위자로 정하고(메인 에이전트 → main, 운영자 내부 API →
 * operator), 시작 때 옮김(migrations.ts)도 '역할 추가' 활동 기록의 행위자로 같은 함수를 쓴다. 그 밖(대표)은 owner — 대표가 역할을 만들던 v0.6 전의 역할이다
 */
export function roleCreatorOf(actor: Actor): RoleCreator {
  if (actor === MAIN_AGENT_ID) return 'main';
  if (actor === OPERATOR) return 'operator';
  return 'owner';
}

export function defaultRoles(nowIso: string): Role[] {
  return ROLE_SEEDS.map((s) => ({
    id: s.id,
    name: s.name,
    instructions: s.instructions,
    taskTypes: s.taskTypes,
    allowedSkills: [],
    defaultAi: s.defaultAi,
    canReview: s.canReview,
    builtin: true,
    // 기본 역할은 'seed' — 예전 DB의 기본 역할은 시작 때 옮김(migrations.ts backfillRoleCreators)이 채운다 (리드 결정 S5-12)
    createdBy: 'seed',
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
}

export function defaultSettings(): Settings {
  const home = homedir();
  return {
    general: {
      mainAgent: { kind: 'claude', model: null, effortTier: 'high', effortOverride: null },
      backup: { enabled: true, keep: 7 },
      launchAtLogin: false,
    },
    account: {
      googleClientId: '',
      googleClientSecretSet: false,
      authMode: { claude: 'subscription', codex: 'subscription' },
    },
    team: {
      effortMapping: {
        claude: { high: 'high', normal: 'medium', low: 'low' },
        codex: { high: 'high', normal: 'medium', low: 'low' },
      },
      // 모델마다의 장점을 적은 기본 목록 (aiGuide.ts — 대표 지시 2026-11-18)
      modelCatalog: structuredClone(DEFAULT_MODEL_CATALOG),
    },
    execution: {
      maxConcurrent: 5,
      turnTimeoutMin: 60,
      claudeMaxTurns: 200,
      noOutputMin: 10,
      commandMaxMin: 30,
      healthCheckMin: 3,
      crashRetryMax: 2,
      spinSameErrorCount: 5,
      spinNoProgressMin: 30,
      spinNoProgressResumes: 3,
      preventSleep: true,
    },
    policy: {
      emergencyShortcut: 'CommandOrControl+Alt+Shift+S',
      sensitiveAreas: [
        { kind: 'system', paths: ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', '/System', '/Library', '/usr'] },
        { kind: 'personal', paths: [join(home, 'Documents'), join(home, 'Pictures'), join(home, 'Downloads'), join(home, 'Desktop')] },
        { kind: 'secret', paths: ['.env', join(home, '.ssh'), join(home, '.aws'), join(home, '.config', 'gcloud'), join(home, 'AppData', 'Local', 'Google', 'Chrome')] },
        { kind: 'app', paths: [] },
      ],
    },
    skills: { overrides: {} },
    logs: { retentionDays: 90 },
    developer: { mainAgentMock: false, mockSpeed: 1 },
    cli: { claudePath: null, codexPath: null },
  };
}

/** v0.6 전에 저장된 팀 설정 모양 — '메인 에이전트가 AI를 정함' 켜기·끄기가 있었다 (읽을 때 버린다) */
type LegacyTeamSettings = Settings['team'] & { mainAgentDecidesAi?: unknown };

/** 저장된 설정에 빠진 항목을 기본값으로 채운다 (버전이 올라도 깨지지 않게) */
export function normalizeSettings(saved: Partial<Settings> | null): Settings {
  const d = defaultSettings();
  if (!saved) return d;
  const merge = <T>(base: T, over: unknown): T => {
    if (over === undefined || over === null) return base;
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as T;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = k in out ? merge(out[k], v) : v;
    }
    return out as T;
  };
  const s = merge(d, saved);
  // 없앤 항목 (v0.6, SERVER_DESIGN 2.7): 팀원 AI는 늘 메인 에이전트가 정한다 — 예전에 저장된 값은 읽을 때 버리고, 다음 저장에서 빠진다.
  // 타입에서는 지웠으므로(리드 결정 21) 예전 모양을 여기서만 적는다
  delete (s.team as LegacyTeamSettings).mainAgentDecidesAi;
  // 예전 노력치 값은 읽을 때 바꾼다 — 그대로 두면 그 단계의 Codex 턴이 시작마다 실패하고, 다른 설정 저장도 검사에서 막힌다 (windows:F7)
  for (const kind of AI_KINDS) {
    const mapping = s.team.effortMapping[kind];
    for (const tier of Object.keys(mapping) as EffortTier[]) mapping[tier] = normalizeEffort(kind, mapping[tier]);
  }
  const main = s.general.mainAgent;
  if (main.effortOverride) s.general.mainAgent = { ...main, effortOverride: normalizeEffort(main.kind, main.effortOverride) };
  // Claude 최대 반복 수의 null은 '제한 없음'(--max-turns를 넘기지 않음)이다 — 빠진 값만 기본값으로 채우고 null은 그대로 둔다 (리드 결정 15)
  if (saved.execution?.claudeMaxTurns === null) s.execution.claudeMaxTurns = null;
  return s;
}
