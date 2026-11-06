import { openCommand } from '../lib/commands';
import { useEffect, useRef, useState } from 'react';
import { Armchair, FileText, NotebookPen, ShieldCheck, StickyNote, ArrowLeft } from 'lucide-react';
import type { AppSnapshot, JournalFilter, JournalKind, JournalPage, SeatHandoverView, SeatHistoryEntry, SeatView } from '../../../shared/views';
import { call } from '../api/store';
import { date, Section } from '../lib/ui';
import { journalLabels, journalTarget, type RendererTarget } from '../lib/seat';

const stateLabels = { active: '활동 중', switching: '교체 중', vacant: '자리 비어 있음', stopped: '정지됨' } satisfies Record<SeatView['state'], string>;
const changedLabels = { main: '메인이 넘김', operator: '운영자 배정', server: '서버' } satisfies Record<SeatHistoryEntry['changedBy'], string>;
const visionLabels = { verified: '확인됨', failed: '실패', unknown: '아직 확인 안 함' } satisfies Record<SeatView['vision'], string>;
const unverifiedSentence = '이전 메인 에이전트가 남긴 메모입니다. 서버가 확인한 사실이 아닙니다.';

export function RecordSource({ unverified }: { unverified: boolean }) {
  return unverified ? <span className="record-source unverified"><StickyNote size={14} aria-hidden="true" />확인되지 않은 메모</span> :
    <span className="record-source fact"><ShieldCheck size={14} aria-hidden="true" />서버 기록</span>;
}

export function Handover({ generation }: { generation: number }) {
  const [result, setResult] = useState<{ value: SeatHandoverView | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setResult(null); setError('');
    void call('seat.handover', generation).then(value => { if (active) setResult({ value }); })
      .catch(() => { if (active) setError('인계 꾸러미를 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, [generation]);
  if (error) return <p role="alert">{error}</p>;
  if (!result) return <p role="status">인계 꾸러미를 불러오는 중…</p>;
  const packet = result.value;
  if (!packet) return <p className="empty">이 세대에는 인계 꾸러미가 없습니다</p>;
  return <article className="handover-view">
    <header className="handover-heading"><span className="eyebrow">인계 꾸러미</span><h2>세대 {packet.generation}의 인계</h2>
      <dl className="seat-metadata"><div><dt>만든 시각</dt><dd>{date(packet.createdAt)}</dd></div>
        <div><dt>받은 보유자</dt><dd>{packet.holder.label}</dd></div><div><dt>이전 보유자</dt><dd>{packet.previous?.label ?? '첫 세대'}</dd></div>
        <div><dt>분량</dt><dd>{packet.chars.toLocaleString('ko-KR')}자</dd></div></dl>
    </header>
    {packet.sections.map(section => <section key={section.key} className={`handover-section ${section.unverified ? 'unverified-section' : 'verified-section'}`}>
      <div className="record-heading"><h3>{section.title}</h3><RecordSource unverified={section.unverified} /></div>
      {section.unverified && <p className="unverified-explanation">{unverifiedSentence}</p>}
      <ul>{section.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
      {section.omitted > 0 && <p className="muted">외 {section.omitted}건</p>}
    </section>)}
  </article>;
}

export function Journal({ snapshot, navigate }: { snapshot: AppSnapshot; navigate: (target: RendererTarget) => void }) {
  const [filter, setFilter] = useState<JournalFilter>({ limit: 50 });
  const [page, setPage] = useState<JournalPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A page from a previous filter must never append to the current one.
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    setPage(null); setLoading(true); setError('');
    void call('journal.list', filter).then(value => { if (request.current === id) setPage(value); })
      .catch(() => { if (request.current === id) setError('일지를 불러오지 못했습니다.'); })
      .finally(() => { if (request.current === id) setLoading(false); });
    return () => { request.current++; };
  }, [filter, snapshot.seat.generation]);
  const more = async () => {
    if (!page?.nextCursor || loading) return;
    const id = ++request.current;
    setLoading(true); setError('');
    try {
      const next = await call('journal.list', { ...filter, cursor: page.nextCursor });
      if (request.current === id) setPage({ entries: [...page.entries, ...next.entries], nextCursor: next.nextCursor });
    } catch { if (request.current === id) setError('다음 기록을 불러오지 못했습니다.'); }
    finally { if (request.current === id) setLoading(false); }
  };
  return <div className="journal-view">
    <div className="journal-filters">
      <label>프로젝트<select aria-label="일지 프로젝트" value={filter.projectId === null ? '__general' : filter.projectId ?? ''}
        onChange={e => setFilter({ ...filter, projectId: e.target.value === '__general' ? null : e.target.value || undefined })}>
        <option value="">모든 프로젝트</option><option value="__general">전체 (프로젝트 없음)</option>
        {snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label>종류<select aria-label="일지 종류" value={filter.kinds?.[0] ?? ''} onChange={e => {
        const kinds = Object.keys(journalLabels).filter((key): key is JournalKind => key === e.target.value);
        setFilter({ ...filter, kinds: kinds.length ? kinds : undefined });
      }}><option value="">모든 종류</option>{Object.entries(journalLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>작성자<select aria-label="일지 작성자" value={filter.author ?? ''} onChange={e => setFilter({ ...filter, author: e.target.value === 'agent' || e.target.value === 'server' ? e.target.value : undefined })}>
        <option value="">모든 작성자</option><option value="server">서버</option><option value="agent">에이전트</option>
      </select></label>
      <label className="journal-open"><input type="checkbox" checked={filter.openPromisesOnly ?? false} onChange={e => setFilter({ ...filter, openPromisesOnly: e.target.checked })} />열린 약속만</label>
    </div>
    <p className="muted journal-source-help"><StickyNote size={15} aria-hidden="true" />에이전트가 쓴 기록은 확인되지 않은 메모로 표시합니다.</p>
    {error && <p role="alert">{error}</p>}
    <ol className="journal-list">{page?.entries.map(entry => <li key={entry.id} className={`journal-entry ${entry.author === 'agent' ? 'unverified-section' : 'verified-section'}`}>
      <div className="record-heading"><span className="journal-kind">{journalLabels[entry.kind]}</span><RecordSource unverified={entry.author === 'agent'} /></div>
      <div className="journal-meta"><time dateTime={entry.at}>{date(entry.at)}</time><span>{entry.holderLabel} · 세대 {entry.generation}</span><span>{entry.projectName ?? '전체'}</span></div>
      <p className="journal-text">{entry.text}</p>
      {entry.promise && <div className="promise-state"><span className={`promise-${entry.promise.state}`}>{entry.promise.state === 'open' ? '열림' : '닫힘'}</span>
        {entry.promise.stale && <span>오래됨</span>}{entry.promise.needsCheck && <span>확인 필요</span>}
        {entry.promise.state === 'closed' && entry.promise.resolution && <p>마무리: {entry.promise.resolution}</p>}</div>}
      <div className="journal-refs">{entry.refs.map((ref, i) => {
        const target = journalTarget(ref, snapshot);
        return target ? <a key={i} href={`#${ref.kind}-${encodeURIComponent(ref.id)}`} onClick={event => { event.preventDefault(); navigate(target); }}>{ref.label}</a> : <span key={i}>{ref.label}</span>;
      })}</div>
    </li>)}</ol>
    {loading && <p role="status">일지를 불러오는 중…</p>}
    {!loading && page?.entries.length === 0 && <p className="empty">조건에 맞는 기록이 없습니다.</p>}
    {page?.nextCursor && <button className="journal-more" disabled={loading} onClick={() => void more()}>{loading ? '불러오는 중…' : '더 보기'}</button>}
  </div>;
}

export function SeatScreen({ snapshot, navigate }: { snapshot: AppSnapshot; navigate: (target: RendererTarget) => void }) {
  const [seat, setSeat] = useState(snapshot.seat);
  const [history, setHistory] = useState<SeatHistoryEntry[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'seat' | 'journal'>('seat');
  const [generation, setGeneration] = useState<number | null>(null);
  // Keep the displayed model and holder current without re-reading history for every snapshot.
  useEffect(() => { setSeat(snapshot.seat); }, [snapshot.seat]);
  useEffect(() => {
    let active = true;
    setSeat(snapshot.seat); setError('');
    void call('seat.get').then(value => { if (active) setSeat(value); }).catch(() => { if (active) setError('현재 자리 정보를 불러오지 못했습니다.'); });
    void call('seat.history').then(value => { if (active) setHistory(value); }).catch(() => { if (active) setError('자리 이력을 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, [snapshot.seat.generation, snapshot.seat.state, snapshot.seat.unresponsiveSince]);
  return <div className="screen seat-screen">
    <div className="page-heading"><div><span className="eyebrow">메인 에이전트</span><h1>자리와 인계</h1><p>지금 일하는 메인과 그동안 이어 온 기록을 확인합니다.</p></div><Armchair size={30} aria-hidden="true" /></div>
    <div className="seat-tabs" role="tablist" aria-label="자리와 일지">
      <button role="tab" id="seat-tab" aria-controls="seat-panel" aria-selected={tab === 'seat'} onClick={() => { setTab('seat'); setGeneration(null); }}><Armchair size={17} />자리와 인계</button>
      <button role="tab" id="journal-tab" aria-controls="journal-panel" aria-selected={tab === 'journal'} onClick={() => { setTab('journal'); setGeneration(null); }}><NotebookPen size={17} />메인 일지</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {tab === 'seat' && <div role="tabpanel" id="seat-panel" aria-labelledby="seat-tab">
      {generation !== null ? <><button className="handover-back" onClick={() => setGeneration(null)}><ArrowLeft size={16} />자리 이력으로</button><Handover key={generation} generation={generation} /></> : <>
        <Section title="지금 메인 자리" action={<span className={`seat-state seat-${seat.state}`}>{stateLabels[seat.state]}</span>}>
          <strong className="seat-holder">{seat.holder?.label ?? '메인 에이전트 없음'}</strong>
          {seat.holder?.kind === 'launched' && <p className="muted">{seat.holder.ai.model ?? '기본 모델'}</p>}
          {seat.pendingHolder && <p>다음 보유자: {seat.pendingHolder.label}</p>}
          <dl className="seat-metadata"><div><dt>세대</dt><dd>세대 {seat.generation}</dd></div><div><dt>시작</dt><dd>{date(seat.since)}</dd></div></dl>
          {snapshot.seat.unresponsiveSince && <div className="seat-response-state" role="status"><strong>응답 없음</strong><p>시작: {date(snapshot.seat.unresponsiveSince)}</p>{snapshot.seat.unresponsiveReason && <p>{snapshot.seat.unresponsiveReason}</p>}<p>명령은 계속 보낼 수 있습니다. 메인 에이전트가 돌아오면 이어서 확인합니다.</p></div>}
          <button onClick={() => openCommand(null, '메인 에이전트의 현재 상태에 대해: ')}>메인 에이전트에게 말하기</button>
          <p className="seat-vision">화면 보기: {visionLabels[seat.vision]}</p>
        </Section>
        <Section title="자리 이력"><ol className="seat-history">{history?.map(row => <li key={row.generation}>
          <div className="history-heading"><strong>세대 {row.generation}</strong><span>{changedLabels[row.changedBy]}</span></div>
          <h3>{row.holder.label}</h3><p className="muted">{date(row.startedAt)} ~ {row.endedAt ? date(row.endedAt) : '현재'}</p>
          <p>{row.endReason ?? (row.endedAt ? '종료 사유 없음' : '현재 메인 자리를 맡고 있습니다.')}</p>
          {row.hasHandover && <a className="handover-link" href={`#handover-${row.generation}`} onClick={event => { event.preventDefault(); setGeneration(row.generation); }}><FileText size={16} />인계 꾸러미 보기<span className="sr-only"> · 세대 {row.generation}</span></a>}
        </li>)}</ol>{history === null && !error && <p role="status">자리 이력을 불러오는 중…</p>}{history?.length === 0 && <p className="empty">아직 자리 이력이 없습니다.</p>}</Section>
      </>}
    </div>}
    {tab === 'journal' && <div role="tabpanel" id="journal-panel" aria-labelledby="journal-tab"><Journal snapshot={snapshot} navigate={navigate} /></div>}
    <p className="muted seat-owner-hint">메인 에이전트를 바꾸려면 명령창에서 메인 에이전트에게 말하세요.</p>
  </div>;
}
