import { AI_KINDS, EFFORT_TIERS, type Settings } from '../../../../shared/domain';
import type { AiSuggestionInput, SendCommandInput } from '../../../../shared/ipc';
import { AI_KIND_LABEL, EFFORT_TIER_LABEL } from '../../../../shared/labels';
import type { AiSuggestionOptionsView, MemberView } from '../../../../shared/views';
import { suggestionBaseline, suggestionChoice } from '../../lib/aiSuggestion';

export function fakeSuggestionOptions(member: MemberView, team: Settings['team']): AiSuggestionOptionsView | null {
  if (!member.projectId || member.isMain || member.deleted) return null;
  const ai = member.pendingAiChange ?? member.ai;
  return {
    models: AI_KINDS.flatMap(kind => (team.modelCatalog?.[kind] ?? []).map(row => ({ ...row, kind }))),
    effortTiers: EFFORT_TIERS.map(tier => ({ tier, label: EFFORT_TIER_LABEL[tier],
      values: { claude: team.effortMapping.claude[tier], codex: team.effortMapping.codex[tier] } })),
    fixed: Boolean(member.aiDecision && !member.aiDecision.byOwner && (ai.model || !team.modelCatalog?.[ai.kind]?.length)),
  };
}

export function suggestionOwnerLine(member: MemberView, options: AiSuggestionOptionsView | null, input: SendCommandInput, draft: AiSuggestionInput) {
  if (member.deleted) throw new Error(`${member.name} 님은 이미 퇴직한 팀원입니다.`);
  if (!options) throw new Error('이 팀원의 AI는 건의할 수 없습니다.');
  if (input.target !== member.projectId) throw new Error('팀원이 속한 프로젝트로 건의를 보내 주세요.');
  if (input.attachments?.length) throw new Error('AI 건의에는 파일을 첨부할 수 없습니다.');
  const { model, effort, differs } = suggestionChoice(member, options, draft.model ?? '', draft.effortTier ?? '');
  if (draft.model && !model) throw new Error(`운영 설정의 모델 목록에서 "${draft.model}"을 찾을 수 없습니다.`);
  if (draft.effortTier && !effort) throw new Error('목록에 있는 노력치 단계를 선택해 주세요.');
  if (!model && !effort) throw new Error('건의할 모델이나 노력치를 하나 이상 선택해 주세요.');
  if (!differs) throw new Error(`${member.name} 님의 현재 AI와 같습니다. 다른 모델이나 노력치를 건의해 주세요.`);
  const before = suggestionBaseline(member, options);
  const requested = [model && `모델 ${model.label || model.id} (${AI_KIND_LABEL[model.kind]})`, effort && `노력치 ${effort.label}`].filter(Boolean).join(', ');
  return `팀원 AI 변경 건의: ${member.name}(${member.id}, ${member.roleName}) — ${requested} (지금: ${AI_KIND_LABEL[before.kind]} ${before.model ?? '기본 모델'}, 노력치 ${before.effort})${input.text.trim() ? '\n까닭: ' + input.text.trim() : ''}`;
}

/** A repeatable demo judgment. Only an unfixed member with work that benefits from the suggestion changes. */
export function judgeFakeSuggestion(member: MemberView, options: AiSuggestionOptionsView | null, draft: AiSuggestionInput) {
  if (!options) return { text: '팀원이 퇴직해 건의를 반영할 수 없었습니다.' };
  const work = member.currentTask?.title ?? member.currentWork?.label;
  const choice = suggestionChoice(member, options, draft.model ?? '', draft.effortTier ?? '');
  if (!choice.differs) return { text: '다시 살펴보니 건의하신 구성과 같아 현재 AI를 유지했습니다.' };
  if (!work) return { text: `${member.name} 님이 새로 맡은 일이 없어 현재 AI를 유지했습니다. 다음 업무를 맡을 때 다시 살펴보겠습니다.` };
  if (options.fixed) return { text: `‘${work}’ 작업은 현재 AI로 마칠 수 있어 그대로 유지했습니다. 지금 팀원을 교체하면 인수인계로 작업이 늦어집니다.` };
  if (choice.effort?.tier !== 'high' && !(choice.model?.kind === 'codex' && member.roleId === 'developer')) {
    return { text: `‘${work}’의 남은 단계는 지금 모델과 노력치로 충분해서 현재 AI를 유지했습니다.` };
  }
  const current = member.pendingAiChange ?? member.ai;
  const kind = choice.kind;
  const tier = choice.effort?.tier ?? current.effortTier;
  const model = choice.model?.id ?? current.model;
  const override = choice.effort ? null : current.effortOverride;
  const effortValue = override ?? options.effortTiers.find(row => row.tier === tier)?.values[kind] ?? member.ai.effortValue;
  const modelValue = choice.model?.id ?? suggestionBaseline(member, options).model;
  const ai = { ...member.ai, kind, model, modelValue, effortTier: tier, effortOverride: override, effortValue };
  const reason = choice.effort?.tier === 'high' ? '남은 단계를 더 꼼꼼히 검토하도록' : '코드 구현과 검토에 맞춰';
  return { ai, text: `‘${work}’ 작업의 ${reason} 건의를 반영했습니다. ${member.name} 님은 ${AI_KIND_LABEL[kind]} · ${modelValue ?? '기본 모델'} · 노력치 ${EFFORT_TIER_LABEL[tier]}로 일합니다.` };
}
