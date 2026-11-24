import type { AiSuggestionOptionsView, MemberView } from '../../../shared/views';
import type { EffortTier } from '../../../shared/domain';

export function suggestionBaseline(member: MemberView, options: AiSuggestionOptionsView) {
  const next = member.pendingAiChange;
  const ai = next ?? member.ai;
  const defaultModel = ai.kind === 'codex' ? options.models.find(model => model.kind === 'codex')?.id : null;
  const model = (next ? next.model : member.ai.modelValue ?? member.ai.model) ?? defaultModel ?? null;
  const effort = next
    ? next.effortOverride ?? options.effortTiers.find(row => row.tier === next.effortTier)?.values[next.kind]
    : member.ai.effortValue;
  return { kind: ai.kind, model, effort };
}

export function suggestionChoice(member: MemberView, options: AiSuggestionOptionsView, modelId: string, tier: EffortTier | '') {
  const baseline = suggestionBaseline(member, options);
  // The wire format identifies a model by ID. For duplicate IDs the server prefers the member's kind.
  const model = options.models.find(row => row.id === modelId && row.kind === baseline.kind)
    ?? options.models.find(row => row.id === modelId);
  const kind = model?.kind ?? baseline.kind;
  const effort = options.effortTiers.find(row => row.tier === tier);
  const differs = Boolean((model && (model.id !== baseline.model || kind !== baseline.kind))
    || (effort && effort.values[kind] !== baseline.effort));
  return { model, kind, effort, differs };
}
