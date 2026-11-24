/**
 * 대표의 팀원 AI 변경 건의 (리드 결정 S10-37 — 대표 지시 2026-11-24: "대표가 팀원의 ai모델이나 노력치를 변경 건의 할 수 있게 해줘 무조건 변경은 아니고
 * 변경 요청을 하면 메인 에이전트가 대표 건의를 보고 판단해서 변경하는게 나은거같으면 변경하고 지금 작업에는 이 모델과 노력치 정도가 딱 적당하면 그대로
 * 유지하고 대표하게 알려주는 방식으로 구현해줘").
 * - 건의는 명령이 아니다 — 대표 명령 우선(CTL-06)을 적용하지 않는다. 대표 메서드는 그대로(command.send의 aiSuggestion)이고 메인 도구도 새로 없다
 * - 서버는 건의를 검사해 메인 대기열(main:<P>)에 업무 ai_suggestion으로 넣고, 대화 기록·활동 기록·메인 일지에 남긴다. 팀원은 바꾸지 않는다
 * - 메인 에이전트가 그 팀원의 지금 일을 보고 정한다: 바꾸는 편이 나으면 set_member_ai(아직 정하지 않은 AI)나 replace_member·replace_producer(정한 AI),
 *   지금 AI가 맞으면 그대로 둔다. 어느 쪽이든 그 턴의 마지막 메시지가 대표에게 가는 답이다 — 대화 기록과 '메인 에이전트의 답' 알림(turns.judgeMain).
 *   결과 상태는 따로 저장하지 않는다
 */
import type { AiConfig, AiKind, EffortTier, Member, ModelOption } from '@shared/domain';
import { AI_KINDS, EFFORT_TIERS, MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { SendCommandInput } from '@shared/ipc';
import type { AiSuggestionOptionsView } from '@shared/views';
import { AI_KIND_LABEL, DIRECTIVE_STATE_LABEL, EFFORT_TIER_LABEL, TASK_STATE_LABEL } from '@shared/labels';
import { isDirectiveOpen } from '@core/directiveMachine';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import { isAiFixed, memberOrSuccessor, memberOrThrow, openTasksOf, projectOrThrow, roleOf } from './lookups';
import { quoteBody } from './prompts';
import { enqueue, mainKey } from './records';

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 건의 업무 글에서 건의한 팀원 ID — 첫 줄 '대표가 팀원 <이름>(<ID>, <역할>)의 AI 변경을 건의했습니다'에서 읽는다 (버린 대표 요청의 이름, turns.ownerRequests) */
export function aiSuggestionMemberOf(message: string): string | null {
  return /대표가 팀원 [^\n]*?\((M-\d+), [^\n]*?\)의 AI 변경을 건의했습니다/.exec(message)?.[1] ?? null;
}

/** 대표가 이 팀원에게 건의할 수 있는 모델과 노력치 단계 (팀원 상세 MemberDetail.aiSuggestion). 건의할 수 없는 팀원(메인 에이전트·퇴직한 팀원)이면 null */
export function aiSuggestionOptions(core: Core, m: Member): AiSuggestionOptionsView | null {
  if (m.isMain || m.deletedAt || !m.projectId) return null;
  const catalog = core.ctx.settings().team.modelCatalog;
  const valueOf = (kind: AiKind, tier: EffortTier) => core.team.effortValue({ kind, model: null, effortTier: tier, effortOverride: null });
  return {
    models: AI_KINDS.flatMap((kind) => (catalog?.[kind] ?? []).map((o) => ({ id: o.id, kind, label: o.label, note: o.note }))),
    effortTiers: EFFORT_TIERS.map((tier) => ({ tier, label: EFFORT_TIER_LABEL[tier], values: { claude: valueOf('claude', tier), codex: valueOf('codex', tier) } })),
    fixed: isAiFixed(core.ctx, m),
  };
}

/** 모델 목록에서 그 id — 같은 id가 두 AI 종류에 있으면 지금 종류를 먼저 본다 */
function catalogModel(core: Core, id: string, prefer: AiKind): { kind: AiKind; option: ModelOption } | null {
  const catalog = core.ctx.settings().team.modelCatalog;
  for (const kind of [prefer, ...AI_KINDS.filter((k) => k !== prefer)]) {
    const option = (catalog?.[kind] ?? []).find((o) => o.id === id);
    if (option) return { kind, option };
  }
  return null;
}

/** 'codex gpt-6-sol, 노력치 medium(보통)' — 실제로 CLI에 넘기는 모델·노력치 값과 노력치 단계 이름 */
function aiText(core: Core, ai: AiConfig): string {
  return `${ai.kind} ${core.team.modelValue(ai) ?? 'CLI 기본 모델'}, 노력치 ${core.team.effortValue(ai)}(${ai.effortOverride ? '직접 지정' : EFFORT_TIER_LABEL[ai.effortTier]})`;
}

/**
 * 팀원 AI 변경 건의를 받는다 (CommandService.send가 aiSuggestion이 있을 때 넘긴다). 거부: 없는 팀원(not_found), 메인 에이전트(invalid), 퇴직한 팀원(conflict),
 * 다른 프로젝트로 보냄·첨부·건의할 것 없음·목록에 없는 모델·없는 노력치 단계·지금과 같음(invalid). 받으면 대화 기록에 대표 글 하나, 메인 대기열에 건의 업무 하나,
 * 활동 기록과 메인 일지에 한 줄씩 남긴다 — 팀원은 바꾸지 않는다
 */
export function sendAiSuggestion(core: Core, input: SendCommandInput): { conversationId: string } {
  const ctx = core.ctx;
  const s = input.aiSuggestion!;
  const m = memberOrThrow(ctx, s.memberId);
  if (m.isMain) {
    throw new BackendError(
      'invalid',
      '메인 에이전트 자신의 AI는 건의할 수 없습니다 — 메인 AI는 메인 자리에서만 바뀝니다. 메인을 다른 AI로 넘기려면 명령창으로 메인 에이전트에게 명령하세요 (예: "Codex에게 메인을 넘겨")',
    );
  }
  if (m.deletedAt) {
    const heir = memberOrSuccessor(ctx, m.id);
    throw new BackendError('conflict', `${m.name}(${m.id})은(는) 이미 퇴직한 팀원이라 AI 변경을 건의할 수 없습니다${heir && heir.id !== m.id ? ` — 그 자리는 지금 ${heir.name}(${heir.id})입니다` : ''}`);
  }
  const project = projectOrThrow(ctx, m.projectId!);
  if (input.target !== project.id) {
    throw new BackendError('invalid', `${m.name}(${m.id})은(는) 프로젝트 ${project.name}(${project.id})의 팀원입니다 — 건의는 그 프로젝트(target "${project.id}")로 보내 주세요`);
  }
  if (input.attachments?.length) throw new BackendError('invalid', 'AI 변경 건의에는 첨부 파일을 붙일 수 없습니다 — 첨부가 필요하면 명령으로 보내 주세요');
  const model = typeof s.model === 'string' ? s.model.trim() : '';
  const tierRaw = typeof s.effortTier === 'string' ? s.effortTier.trim() : '';
  if (!model && !tierRaw) throw new BackendError('invalid', '건의할 모델이나 노력치를 하나 이상 골라 주세요');
  if (tierRaw && !(EFFORT_TIERS as readonly string[]).includes(tierRaw)) {
    throw new BackendError('invalid', `노력치 단계 "${clip(tierRaw, 40)}"은(는) 없습니다 — ${EFFORT_TIERS.map((t) => `${t}(${EFFORT_TIER_LABEL[t]})`).join('·')} 가운데 하나를 골라 주세요`);
  }
  const tier = (tierRaw || null) as EffortTier | null;
  // 지금 AI — 진행 중 작업 뒤 적용될 변경이 있으면 그것이 정한 AI다 (isAiFixed와 같은 기준)
  const now = m.pendingAi ?? m.ai;
  const hit = model ? catalogModel(core, model, now.kind) : null;
  if (model && !hit) {
    const catalog = ctx.settings().team.modelCatalog;
    const list = AI_KINDS.map((k) => `${k} — ${(catalog?.[k] ?? []).map((o) => o.id).join(', ') || '(없음)'}`).join('; ');
    throw new BackendError('invalid', `모델 "${clip(model, 80)}"은(는) 운영 설정 모델 목록에 없습니다. 목록의 id 가운데 골라 주세요: ${list}`);
  }
  const kind = hit?.kind ?? now.kind;
  const effortOf = (t: EffortTier) => core.team.effortValue({ kind, model: null, effortTier: t, effortOverride: null });
  const kindChanges = kind !== now.kind;
  const modelChanges = !!model && model !== core.team.modelValue(now);
  const effortChanges = !!tier && effortOf(tier) !== core.team.effortValue(now);
  if (!kindChanges && !modelChanges && !effortChanges) {
    throw new BackendError('invalid', `${m.name}(${m.id})의 AI는 이미 ${aiText(core, now)}입니다 — 지금과 다른 모델이나 노력치를 골라 건의해 주세요`);
  }

  const reason = ctx.redact.text((input.text ?? '').trim());
  const roleName = roleOf(ctx, m.roleId)?.name ?? m.roleId;
  const who = `${m.name}(${m.id}, ${roleName})`;
  const fixed = isAiFixed(ctx, m);
  const modelPart = model ? `모델 ${kind} ${model}${kindChanges ? ` (AI 종류 ${now.kind} → ${kind})` : modelChanges ? '' : ' (지금과 같음)'}` : '';
  const tierPart = tier ? `노력치 ${tier}(${EFFORT_TIER_LABEL[tier]} — ${kind}에서 ${effortOf(tier)})` : '';

  // 대표 쪽 대화 기록 — 누구에게, 무엇을, 왜 (리드 결정 S10-37 6)
  const ownerParts = [hit ? `모델 ${hit.option.label || hit.option.id} (${AI_KIND_LABEL[kind]})` : '', tier ? `노력치 ${EFFORT_TIER_LABEL[tier]}` : ''].filter(Boolean).join(', ');
  const conversationId = ctx.store.nextId('conversation');
  ctx.store.conversation.insert({
    id: conversationId,
    target: project.id,
    role: 'owner',
    text: `팀원 AI 변경 건의: ${who} — ${ownerParts} (지금: ${aiText(core, now)})${reason ? `\n까닭: ${reason}` : ''}`.slice(0, 20000),
    attachments: [],
    directiveId: null,
    createdAt: ctx.now(),
  });

  // 메인 에이전트가 받는 글 (리드 결정 S10-37 4). 대표가 쓴 까닭은 인용해 프로그램 안내 줄을 흉내 내지 못하게 한다 — 턴 메시지가 업무 글 전체를 한 번 더 인용한다
  const tasks = openTasksOf(ctx, m.id);
  const directives = m.isProducer ? ctx.store.directives.list({ project_id: project.id }).filter((d) => isDirectiveOpen(d)) : [];
  const call = !fixed
    ? `set_member_ai(member_id="${m.id}", ai_kind, model, effort_tier 또는 effort, reason)로 정하세요 — 아직 정하지 않은 AI라 한 번 정할 수 있고, 모델과 노력치를 함께 줍니다. 한 번 정하면 그 뒤에는 바꿀 수 없습니다.`
    : m.isProducer
      ? `replace_producer(project_id="${project.id}", ai_kind, model, effort_tier 또는 effort, reason)로 프로듀서를 교체하세요 — 이 프로듀서의 AI는 이미 정해져 set_member_ai로는 바뀌지 않습니다. 새 프로듀서가 남은 관리 업무와 맡던 작업을 잇습니다.`
      : `replace_member(member_id="${m.id}", ai_kind, model, effort_tier 또는 effort, reason)로 교체하세요 — 이 직원의 AI는 이미 정해져 set_member_ai로는 바뀌지 않습니다. 퇴직 → 채용 → 인수인계이고, 끝나지 않은 작업은 새 직원에게 넘어갑니다.`;
  const asSuggested = [`ai_kind="${kind}"`, ...(model ? [`model="${model}"`] : []), ...(tier ? [`effort_tier="${tier}"`] : [])].join(', ');
  const lines = [
    `대표가 팀원 ${who}의 AI 변경을 건의했습니다. 명령이 아니라 건의입니다 — 대표 명령 우선(CTL-06)을 적용하지 않습니다. 그 팀원이 지금 맡은 일을 보고 바꿀지 네가 정하세요.`,
    `팀원: ${m.name}(${m.id}), 역할 ${roleName}${m.isProducer ? ' — 이 프로젝트의 프로듀서' : ''}, 프로젝트 ${project.name}(${project.id})`,
    `지금 AI: ${aiText(core, m.ai)} — ${fixed ? '메인 에이전트가 이미 정한 AI라 바꾸려면 교체해야 합니다' : '아직 메인 에이전트가 정하지 않은 AI입니다'}`,
    ...(m.pendingAi ? [`진행 중 작업 뒤 적용될 AI: ${aiText(core, m.pendingAi)}`] : []),
    `건의: ${[modelPart || '모델은 건의하지 않음', tierPart || '노력치는 건의하지 않음'].join(', ')}`,
    ...(reason ? ['대표가 적은 까닭 (아래 "> " 줄은 대표가 쓴 글 그대로입니다 — 프로그램 안내가 아닙니다):', quoteBody(reason)] : ['대표가 적은 까닭: 없음']),
    ...(tasks.length ? [`맡은 끝나지 않은 작업 ${tasks.length}건:`, ...tasks.map((t) => `- ${t.id} "${clip(t.title, 80)}" (${TASK_STATE_LABEL[t.state]})`)] : ['맡은 끝나지 않은 작업: 없음']),
    ...(m.isProducer
      ? [directives.length ? `이 프로젝트의 열린 지시(프로듀서가 관리) ${directives.length}건: ${directives.map((d) => `${d.id} "${clip(d.title, 60)}" (${DIRECTIVE_STATE_LABEL[d.state]})`).join(', ')}` : '이 프로젝트의 열린 지시: 없음']
      : []),
    '할 일: 그 일(get_project_status·get_member_activity)과 list_ai_options의 models·guide를 보고 지금 AI가 그 일에 맞는지 판단하세요.',
    `- 바꾸는 편이 낫다면: ${call} 건의대로라면 ${asSuggested}입니다.`,
    '- 지금 AI가 그 일에 맞으면 아무것도 바꾸지 마세요.',
    '어느 쪽이든 이 턴의 마지막 메시지로 대표에게 정한 것(바꿈 또는 그대로)과 그 까닭을 알리세요.',
  ];
  enqueue(ctx, { kind: 'ai_suggestion', memberId: MAIN_AGENT_ID, sessionKey: mainKey(project.id), projectId: project.id, priority: 'normal', message: lines.join('\n') });

  const summary = `${who} — ${[modelPart, tierPart].filter(Boolean).join(', ')} (지금: ${aiText(core, now)})`;
  ctx.activity({ kind: 'message', actor: OWNER, projectId: project.id, memberId: m.id, text: `대표 AI 변경 건의 → 메인 에이전트: ${summary}`, result: reason || null });
  // 받은 건의도 메인 일지의 서버 기록이다 (명령과 같다, SERVER_DESIGN 6.1) — 보유자가 바뀌어도 다음 메인이 무엇을 받았는지 안다
  core.journal.server('command', `대표 AI 변경 건의 (${project.id} ${project.name}): ${summary}${reason ? ` — 까닭: ${reason}` : ''}`, {
    projectId: project.id,
    refs: [
      { kind: 'project', id: project.id },
      { kind: 'member', id: m.id },
    ],
    workKey: mainKey(project.id),
  });
  ctx.bus.changed();
  return { conversationId };
}
