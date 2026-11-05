import type { AppSnapshot } from '../../../shared/views';
import { AI_KIND_LABEL } from '../../../shared/labels';
import { date } from '../lib/ui';

export function hasAiWarning(ai: AppSnapshot['ai'][number]): boolean {
  return !!(ai.blocked || ai.problem || ai.usageLimitedUntil || ai.modelLimits?.length);
}

export function AiStatusSummary({ ai }: { ai: AppSnapshot['ai'][number] }) {
  return <div className="ai-status-summary">
    {(ai.blocked || ai.problem || ai.usageLimitedUntil || !ai.modelLimits?.length) && <p><strong>{AI_KIND_LABEL[ai.kind]}</strong> · {ai.authRequired ? '인증이 필요합니다.' : ai.usageLimitedUntil ? `${date(ai.usageLimitedUntil)}까지 사용량 한도` : ai.problem ?? (ai.blocked ? '새 턴 실행이 막혔습니다.' : '새 턴을 실행할 수 있습니다.')}</p>}
    {ai.modelLimits?.map(limit => <p key={limit.family}>{AI_KIND_LABEL[ai.kind]} · {limit.label} 주간 한도: {date(limit.until)}까지 — {limit.label} 모델의 턴만 쉽니다</p>)}
    {!!ai.modelLimits?.length && <p className="muted">메인 에이전트도 쉬고 있다면 설치 설정에서 메인 AI 모델을 다른 모델로 정하면 이어서 일합니다.</p>}
  </div>;
}
