import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Mail, NotebookPen, Send, X } from 'lucide-react';
import { AI_KINDS, type EffortTier } from '../../../shared/domain';
import { AI_KIND_LABEL, EFFORT_TIER_LABEL } from '../../../shared/labels';
import type { AiSuggestionOptionsView, MemberDetail, MemberView } from '../../../shared/views';
import { getBridge } from '../api/bridge';
import { toast } from '../api/store';
import { openConversation } from '../lib/commands';
import { suggestionBaseline, suggestionChoice } from '../lib/aiSuggestion';
import '../styles/ai-suggestion.css';

export function AiSuggestion({ detail, closePanel }: { detail: MemberDetail; closePanel: () => void }) {
  const [opened, setOpened] = useState<AiSuggestionOptionsView | null>(null);
  const { aiSuggestion, member } = detail;
  if (!member.projectId) return null;
  return <>
    {aiSuggestion && <button className="ai-suggestion-entry" aria-haspopup="dialog" onClick={() => setOpened(aiSuggestion)}>
      <NotebookPen size={17} aria-hidden="true" /> AI 건의
    </button>}
    {opened && <SuggestionLetter member={member} options={opened} projectId={member.projectId}
      fixed={aiSuggestion?.fixed ?? opened.fixed} dismiss={() => setOpened(null)} sent={closePanel} />}
  </>;
}

type LetterProps = {
  member: MemberView; options: AiSuggestionOptionsView; projectId: string; fixed: boolean;
  dismiss: () => void; sent: () => void;
};
export function SuggestionLetter({ member, options, projectId, fixed, dismiss, sent }: LetterProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [modelId, setModelId] = useState('');
  const [tier, setTier] = useState<EffortTier | ''>('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const baseline = suggestionBaseline(member, options);
  const choice = suggestionChoice(member, options, modelId, tier);
  const models = options.models.filter(row => row.kind === baseline.kind ||
    !options.models.some(other => other.kind === baseline.kind && other.id === row.id));
  useEffect(() => {
    const sheet = dialog.current;
    sheet?.showModal();
    return () => sheet?.close();
  }, []);
  function closeLetter() {
    dialog.current?.close();
    dismiss();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!choice.differs || sending) return;
    setSending(true);
    setError('');
    try {
      await getBridge().invoke('command.send', {
        target: projectId, text: reason,
        aiSuggestion: { memberId: member.id, ...(modelId && { model: modelId }), ...(tier && { effortTier: tier }) },
      });
    } catch (failure) {
      if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'unauthorized') {
        window.dispatchEvent(new Event('wook:unauthorized'));
      }
      setError(failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string'
        ? failure.message : typeof failure === 'string' ? failure : '건의를 보내지 못했습니다. 다시 시도해 주세요.');
      setSending(false);
      return;
    }
    toast('건의를 보냈습니다', '메인 에이전트가 이 프로젝트 대화에서 답합니다.');
    dialog.current?.close();
    sent();
    openConversation(projectId);
  }
  const currentModel = member.ai.modelValue ?? member.ai.model ??
    (member.ai.kind === 'codex' ? options.models.find(row => row.kind === 'codex')?.id : null);

  return <dialog ref={dialog} className="ai-suggestion-sheet" aria-labelledby="suggestion-heading"
    onCancel={event => { event.preventDefault(); if (!sending) closeLetter(); }}>
    <form onSubmit={submit} aria-busy={sending}>
      <header className="suggestion-head">
        <div><span className="suggestion-route"><Mail size={14} aria-hidden="true" /> 대표 <ArrowRight size={12} aria-hidden="true" /> 메인 에이전트</span>
          <h2 id="suggestion-heading">팀원 AI 건의서</h2></div>
        <button type="button" className="icon-button" aria-label="건의서 닫기" disabled={sending} onClick={closeLetter}><X size={19} /></button>
      </header>
      <div className="suggestion-body">
        <section className="suggestion-current" aria-label="현재 AI">
          <div><strong>{member.name}</strong> <span>{member.roleName}</span></div>
          <p><b>현재 AI</b> {AI_KIND_LABEL[member.ai.kind]} · {currentModel ?? '기본 모델'} · 노력치 {member.ai.effortOverride ? '직접 지정' : EFFORT_TIER_LABEL[member.ai.effortTier]} ({member.ai.effortValue})</p>
          {member.pendingAiChange && <p><b>다음 작업부터</b> {AI_KIND_LABEL[baseline.kind]} · {baseline.model ?? '기본 모델'} · {baseline.effort} (이 값과 비교합니다)</p>}
        </section>
        <label htmlFor="suggestion-model">건의할 모델</label>
        <select id="suggestion-model" value={modelId} disabled={sending} aria-describedby={choice.model ? 'suggestion-model-note' : undefined}
          onChange={event => setModelId(event.target.value)}>
          <option value="">모델 건의 없음</option>
          {AI_KINDS.map(kind => <optgroup key={kind} label={AI_KIND_LABEL[kind]}>
            {models.filter(row => row.kind === kind).map(row => <option key={row.id} value={row.id}>{row.label || row.id}</option>)}
          </optgroup>)}
        </select>
        {choice.model && <p id="suggestion-model-note" className="suggestion-model-note">{AI_KIND_LABEL[choice.kind]} · {choice.model.note}</p>}
        <details className="suggestion-catalog"><summary><BookOpen size={14} aria-hidden="true" /> 모델별 설명</summary>
          <dl>{models.map(row => <div key={row.id}><dt>{AI_KIND_LABEL[row.kind]} · {row.label || row.id}</dt><dd>{row.note}</dd></div>)}</dl>
        </details>
        <fieldset className="suggestion-effort" role="radiogroup" aria-labelledby="suggestion-effort-label" disabled={sending}>
          <legend id="suggestion-effort-label">건의할 노력치</legend>
          <div><label><input type="radio" name="suggestion-effort" checked={!tier} onChange={() => setTier('')} />
            <span>건의 없음</span></label>
            {options.effortTiers.map(row => <label key={row.tier}>
              <input type="radio" name="suggestion-effort" value={row.tier} aria-label={row.label}
                aria-describedby={`suggestion-tier-${row.tier}`} checked={tier === row.tier} onChange={() => setTier(row.tier)} />
              <span>{row.label}<small id={`suggestion-tier-${row.tier}`}>{row.values[choice.kind]}</small></span>
            </label>)}
          </div>
        </fieldset>
        <label htmlFor="suggestion-reason">건의하는 까닭 <small aria-hidden="true">선택</small></label>
        <textarea id="suggestion-reason" aria-label="건의하는 까닭" rows={2} value={reason} disabled={sending}
          placeholder="지금 맡은 일에서 어떤 점이 달라지면 좋을까요?" onChange={event => setReason(event.target.value)} />
      </div>
      <footer className="suggestion-footer">
        <p>메인 에이전트가 지금 맡은 일을 살펴보고 AI를 바꿀지 유지할지 정합니다. 그 까닭은 프로젝트 대화에서 알려드립니다.</p>
        {fixed && <p className="suggestion-fixed"><strong>팀원 교체 안내</strong> 메인 에이전트가 이미 이 팀원의 AI를 정했습니다. 건의를 받아들이면 이 팀원은 퇴직하고, 새로 채용한 팀원이 하던 일을 넘겨받습니다.</p>}
        {error && <p className="suggestion-error" role="alert">{error}</p>}
        <div className="suggestion-dispatch">
          <span role="status">{sending ? '보내는 중…' : ''}</span>
          <button className="suggestion-send" type="submit" disabled={!choice.differs || sending}><Send size={15} aria-hidden="true" /> 건의 보내기</button>
        </div>
      </footer>
    </form>
  </dialog>;
}
