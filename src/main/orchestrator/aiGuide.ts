/**
 * 직원을 채용할 때 메인 에이전트가 보는 안내 — 모델마다의 장점과 노력치가 왜 중요한지 (대표 지시 2026-11-18: "클로드 지피티 각 모델별 장점이랑 노력치 중요성
 * 적어두고 메인 에이전트 판단하에 노력치랑 모델 알아서 선택해서 직원으로 채용하도록").
 * - 모델의 장점은 운영 설정의 모델 목록(team.modelCatalog)의 note에 적는다 — 대표는 운영 설정 화면에서, 메인 에이전트는 list_ai_options의 models에서 본다.
 *   기본 목록이 아래 DEFAULT_MODEL_CATALOG다. 메인 에이전트가 update_settings로 고칠 수 있다(새 모델이 나오면 더한다)
 * - 노력치 안내와 고르는 차례는 list_ai_options의 guide로 준다 (EFFORT_GUIDE·HIRING_GUIDE)
 * 출처: Claude는 Anthropic의 모델 안내(가장 유능한 Fable, 기본 Opus, 균형의 Sonnet, 빠른 Haiku — 노력치는 생각의 깊이와 사용량을 함께 정한다), GPT는 Codex CLI
 * 0.167이 내려받은 모델 목록의 설명(2026-11-18). 서버 PC의 Codex CLI에 없는 모델을 고르면 그 직원의 턴이 시작하지 못한다 — 그때는 다른 모델의 직원으로 교체한다
 */
import type { Settings } from '@shared/domain';

type ModelCatalog = NonNullable<Settings['team']['modelCatalog']>;

export const DEFAULT_MODEL_CATALOG: ModelCatalog = {
  claude: [
    {
      id: 'fable',
      label: 'Fable',
      note: '가장 유능한 모델. 가장 어려운 추론과 오래 이어지는 자율 작업에 쓴다 — 큰 구조 설계, 원인을 모르는 버그, 여러 단계에 걸친 판단. 가장 느리고 사용량이 가장 크다 — 꼭 필요한 자리에만',
    },
    { id: 'opus', label: 'Opus', note: '깊은 추론. 설계·검수·복잡한 구현과 디버깅의 기본 선택. Fable 다음으로 사용량이 크다' },
    { id: 'sonnet', label: 'Sonnet', note: '속도와 능력의 균형. 일상적인 구현·기획·문서·테스트 작성에 무난하다' },
    { id: 'haiku', label: 'Haiku', note: '가장 빠르고 가볍다. 단순 반복·정리·형식 변환·짧은 조사처럼 판단이 적은 일에 쓴다' },
  ],
  codex: [
    // 첫 항목은 모델을 정하지 않은 Codex 직원이 쓰는 모델이다 (team.defaultModel) — 앞 판의 데이터와 같게 둔다
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', note: '이전 세대 모델(코딩과 일상 작업). 모델을 정하지 않은 Codex 직원이 쓴다 — 새로 채용할 때는 gpt-6.2-sol을 먼저 본다' },
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', note: '빠른 기본 모델. 코딩과 일상 작업의 첫 선택 — 구현·리팩터링·UI' },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', note: '가장 유능한 GPT. 복잡한 코딩과 전문 작업 — 어려운 구현, 큰 리팩터링' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', note: '효율적이고 화면·이미지 이해와 컴퓨터 조작에 강하다 — 화면을 보고 확인할 일이 많은 UI 작업' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: '빠르고 가볍다. 쉬운 작업 — 단순 수정과 반복' },
  ],
};

/** 앞 판의 기본 목록에 있던 설명 — 저장된 설명이 이것 그대로면(고친 적 없음) 새 설명으로 바꾼다 (migrations.migrateModelCatalog) */
export const OLD_DEFAULT_MODEL_NOTES: Readonly<Record<string, { label: string; note: string }>> = {
  fable: { label: 'Fable (최신 최상위)', note: '가장 어려운 설계·추론. 느리고 사용량이 큼' },
  opus: { label: 'Opus', note: '깊은 추론. 설계·검수·복잡한 구현·디버깅' },
  sonnet: { label: 'Sonnet', note: '균형형. 일반 구현·문서·기획' },
  haiku: { label: 'Haiku', note: '빠르고 저렴. 단순 반복·정리 작업' },
  'gpt-6-sol': { label: 'GPT-6 Sol', note: 'Codex 기본 모델. 구현·리팩터링·UI' },
};

/** 노력치가 무엇이고 왜 중요한지 — list_ai_options의 guide.effort */
export const EFFORT_GUIDE = {
  what: '노력치는 같은 모델이 얼마나 깊이 생각하고 얼마나 꼼꼼히 확인하는지를 정한다. 높을수록 결과가 좋아지지만 느려지고 사용량(주간 한도)을 많이 쓴다.',
  why: [
    '노력치는 모델을 바꾸는 것만큼 결과를 바꾼다 — 최신 모델일수록 그 차이가 크다. 모델만 고르고 노력치를 기본값에 두면 고른 값의 절반만 정한 것이다.',
    '어려운 일은 모델을 먼저 올린다 — 높은 모델에 보통 노력치가 낮은 모델에 높은 노력치보다 나은 때가 많다. 쉬운 일은 노력치부터 낮춘다.',
    '비용은 턴 하나가 아니라 일이 끝날 때까지로 본다 — 싼 설정으로 여러 번 반려되면 처음부터 맞는 설정을 쓴 것보다 비싸다.',
    '가장 높은 값(max)은 정확성이 시간·사용량보다 중요한 드문 일에만 쓴다 — 그 아래 값으로 모자란 것을 본 뒤에 올린다.',
  ],
  levels: [
    { value: 'low', use: '답이 정해진 단순한 일 — 반복 수정, 정리, 형식 맞추기, 짧은 조사' },
    { value: 'medium', use: '보통의 구현·문서·기획 — 대부분의 일의 출발점' },
    { value: 'high', use: '틀리면 되돌리기 비싼 판단 — 설계, 검수, 복잡한 구현과 디버깅' },
    { value: 'xhigh', use: '여러 파일에 걸친 어려운 구현, 오래 이어지는 작업 — high로 모자랄 때' },
    { value: 'max', use: '정확성이 가장 중요한 드문 일 — 가장 느리고 사용량이 가장 크다' },
  ],
  // AI 종류마다의 노력치 — Claude는 Anthropic의 모델 안내, Codex(GPT)는 Codex CLI가 값마다 적어 둔 설명(2026-11-18)에서
  byKind: {
    claude: [
      'Fable: high에서 시작한다. 그 위(xhigh·max)는 이득이 고르지 않으니 high로 모자란 것을 본 일에만 올린다.',
      'Opus: 판단이 무거운 일(설계·검수·복잡한 디버깅)은 high, 보통 일은 medium으로 충분하다 — Opus의 기본값이 medium이다.',
      'Sonnet: 보통의 구현과 여러 단계의 도구 작업은 medium에서 시작하고, 판단이 무거우면 high로 올린다.',
      'Haiku: low나 medium으로 쓴다(기본값 medium) — 높은 노력치가 필요한 일이면 모델을 올리는 편이 낫다.',
      '최신 모델은 낮은 노력치로도 앞 세대의 높은 노력치만큼 하는 때가 많다 — 쉬운 일에 노력치를 올려 사용량을 쓰지 않는다.',
    ],
    codex: [
      'GPT(Codex)의 값: low는 가벼운 추론의 빠른 응답, medium은 일상 작업에서 속도와 깊이의 균형, high는 복잡한 문제, xhigh는 그보다 더 깊게, max는 가장 어려운 문제.',
      'GPT-6.2 Sol·GPT-6.2 Astra·GPT-6.1 Terra는 Codex의 기본값이 low다 — 일상적인 구현과 수정은 low나 medium으로 충분하고, 여러 파일에 걸친 구현이나 까다로운 버그에 high 이상을 준다.',
      'GPT-6 Luna·GPT-6 Sol은 기본값이 medium이다. Luna는 쉬운 작업용이라, 높은 노력치가 필요한 일이면 노력치보다 모델을 올린다.',
      '어려운 일은 Astra로 올리고, 쉬운 일은 Sol이나 Luna에 낮은 노력치를 준다 — Astra에 낮은 노력치를 주어 쉬운 일을 시키지 않는다.',
    ],
  },
  howToSet: 'effort_tier(high·normal·low)는 운영 설정의 연결표(effortTierMapping)로 실제 값이 되고, effort에 실제 값(low·medium·high·xhigh·max)을 바로 줄 수도 있다(effort가 우선).',
} as const;

/** 채용할 때 고르는 차례 — list_ai_options의 guide.hiring */
export const HIRING_GUIDE: readonly string[] = [
  '맡길 일을 먼저 본다: 무엇을 만들거나 판단하는가, 틀리면 얼마나 비싼가, 얼마나 오래 이어지는가.',
  'AI 종류를 고른다: 설계·기획·검수·문서처럼 판단과 글이 중심이면 Claude, 구현·리팩터링·UI처럼 코드를 많이 쓰는 일이면 Codex(GPT)가 기본이다 — 역할의 기본값이 이 구분을 따른다.',
  '모델을 고른다: models의 note(모델마다의 장점)를 보고, 그 일을 해낼 가장 가벼운 모델을 고른다. 어려운 일에 가벼운 모델을 쓰지 않는다.',
  '노력치를 고른다: guide.effort의 levels를 본다. 설계·검수·복잡한 디버깅은 high 이상, 보통 구현은 medium, 단순 반복은 low.',
  'usageLimits를 본다: 주간 한도에 걸린 계열의 모델은 기한까지 턴을 시작하지 못한다 — 급한 일이면 다른 계열을 고른다.',
  'add_member에 ai_kind·model·effort_tier(또는 effort)와 reason(왜 그 모델과 노력치인지)을 함께 준다. 한 번 정한 직원의 AI는 바꿀 수 없다 — 다른 모델이나 노력치가 필요해지면 replace_member로 그 직원을 퇴직시키고 새 직원을 채용한다(하던 일은 인수인계된다).',
];
