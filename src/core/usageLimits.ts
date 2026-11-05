/**
 * 사용량 한도 판정 (CTL-09, 리드 결정 22).
 * - 종류 전체 한도(5시간·주간 등): 그 AI 종류의 모든 턴을 기한까지 막는다 (`AiAvailability.usageLimitedUntil`)
 * - 모델별 주간 한도(Claude seven_day_opus·seven_day_sonnet, 그리고 CLI가 'Fable limit'이라 부르는 seven_day_overage_included): 그 모델 계열의 턴만
 *   막는다 (`AiAvailability.modelUsageLimits`). 모델을 정하지 않은 턴은 CLI 기본 모델을 알 수 없으므로 그 계열로 본다 — 메인 에이전트가 막히면
 *   설치 설정에서 메인 AI 모델을 다른 계열로 정하는 것이 출구다 (리드 결정 22·29)
 * - 앱이 모르는 한도 종류(앞으로 CLI가 더하는 모델별 종류 포함)는 종류 전체 한도로 다룬다 — 어느 모델의 한도인지 모르면 그 종류의 모든 턴을 막는다
 */
import type { AiAvailability, IsoTime, ModelLimitFamily } from '@shared/domain';

export const MODEL_LIMIT_FAMILIES: readonly ModelLimitFamily[] = ['opus', 'sonnet', 'fable'];

/** 사람이 읽는 계열 이름 */
export const MODEL_FAMILY_LABEL: Readonly<Record<ModelLimitFamily, string>> = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable' };

/**
 * CLI가 알려 준 한도 종류(rateLimitType) → 모델 계열. 종류 전체 한도(five_hour·seven_day·overage(추가 사용 한도) 등)와 모르는 종류는 null.
 * seven_day_overage_included는 Claude CLI가 'Fable limit'이라고 부르는 Fable 주간 한도다 (리드 결정 29)
 */
export function modelLimitFamily(rateLimitType: string | null | undefined): ModelLimitFamily | null {
  if (rateLimitType === 'seven_day_opus') return 'opus';
  if (rateLimitType === 'seven_day_sonnet') return 'sonnet';
  if (rateLimitType === 'seven_day_overage_included') return 'fable';
  return null;
}

/** 이 모델이 그 계열인지. 정하지 않은 모델(null·빈 값)은 CLI 기본 모델을 알 수 없으므로 계열에 든다 */
export function modelInFamily(model: string | null | undefined, family: ModelLimitFamily): boolean {
  const m = model?.trim().toLowerCase();
  return !m || m.includes(family);
}

export interface ActiveUsageLimit {
  until: IsoTime;
  /** null이면 종류 전체 한도 */
  family: ModelLimitFamily | null;
}

/** 지금 이 모델의 턴을 막는 사용량 한도 (없으면 null). 종류 전체 한도를 먼저 본다 */
export function activeUsageLimit(ai: AiAvailability, model: string | null | undefined, nowMs: number): ActiveUsageLimit | null {
  if (ai.usageLimitedUntil && Date.parse(ai.usageLimitedUntil) > nowMs) return { until: ai.usageLimitedUntil, family: null };
  for (const family of MODEL_LIMIT_FAMILIES) {
    const until = ai.modelUsageLimits?.[family];
    if (until && Date.parse(until) > nowMs && modelInFamily(model, family)) return { until, family };
  }
  return null;
}

/** 아직 끝나지 않은 모델별 한도 (보기용) */
export function activeModelLimits(ai: AiAvailability, nowMs: number): { family: ModelLimitFamily; until: IsoTime }[] {
  return MODEL_LIMIT_FAMILIES.flatMap((family) => {
    const until = ai.modelUsageLimits?.[family];
    return until && Date.parse(until) > nowMs ? [{ family, until }] : [];
  });
}

/** 걸려 있는(기한이 남은) 사용량 한도가 하나라도 있는지 — 종류 전체·모델별 모두 */
export function hasActiveUsageLimit(ai: AiAvailability, nowMs: number): boolean {
  return (!!ai.usageLimitedUntil && Date.parse(ai.usageLimitedUntil) > nowMs) || activeModelLimits(ai, nowMs).length > 0;
}
