import { useEffect, useState } from 'react';
import { Search, Folder, FileText, ChevronRight, MessageSquareText, Check, GitCompare, MapPin } from 'lucide-react';
import { diffLines } from 'diff';
import type { AppSnapshot, ReportDetail, ReportListItem } from '../../../shared/views';
import type { AnchoredComment, ReportStatus } from '../../../shared/domain';
import { REPORT_STATUS_LABEL } from '../../../shared/labels';
import { call, toast } from '../api/store';
import { date, Empty, Markdown, Modal } from '../lib/ui';
import { openCommand } from '../lib/commands';

export function canRequestChanges(report: ReportDetail): boolean {
  return report.canRequestChanges ?? (report.status !== 'approved' && report.status !== 'changes_requested');
}
export const ENDED_REPORT_NOTE = '지시가 이미 끝나 이 보고서에는 수정 요청을 할 수 없습니다. 바꿀 것이 있으면 명령창으로 메인 에이전트에게 말해 주세요.';

export function isEndedReport(report: ReportDetail, snapshot: AppSnapshot): boolean {
  if (report.canRequestChanges !== false || !report.directiveId) return false;
  const directive = snapshot.directives.find(d => d.id === report.directiveId);
  if (directive) return directive.state === 'closed' || directive.state === 'cancelled';
  // 오래전에 끝난 지시는 스냅샷에서 빠집니다. 새 회차나 이미 보낸 수정 요청은 따로 제외합니다.
  return report.status !== 'changes_requested' && !report.otherRounds.some(round => round.round > report.round);
}

export function canApproveReport(report: ReportDetail): boolean {
  return report.canApprove ?? (report.status !== 'approved' && report.status !== 'changes_requested');
}

export function Documents({ snapshot, selectedId, setSelectedId, initialProject }: { snapshot: AppSnapshot; selectedId: string | null; setSelectedId: (id: string | null) => void; initialProject?: string | null }) {
  const [filterProject, setFilterProject] = useState<string>(initialProject ?? '');
  const [filterStatus, setFilterStatus] = useState<ReportStatus | ''>('');
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [list, setList] = useState<ReportListItem[]>([]);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [feedback, setFeedback] = useState('');
  const [comment, setComment] = useState('');
  const [anchored, setAnchored] = useState<AnchoredComment[]>([]);
  const [quote, setQuote] = useState('');
  const [quoteComment, setQuoteComment] = useState('');
  const [changesOpen, setChangesOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [compareId, setCompareId] = useState('');
  const [comparison, setComparison] = useState<ReportDetail | null>(null);
  useEffect(() => { setFilterProject(initialProject ?? ''); }, [initialProject]);
  useEffect(() => { void call('reports.list', { text: text || undefined, projectId: filterProject === 'general' ? 'general' : filterProject || undefined, status: filterStatus || undefined, from: from || undefined, to: to || undefined }).then(setList).catch(() => undefined); }, [text, filterProject, filterStatus, from, to, snapshot.version]);
  useEffect(() => { let active = true; setFeedback(''); setDetail(null); setCompareId(''); setQuote(''); setQuoteComment(''); setAnchored([]); setComment(''); setChangesOpen(false); if (selectedId) void call('reports.get', selectedId).then(value => { if (!active) return; setDetail(value); if (value.status === 'new') void call('reports.markRead', selectedId).then(() => { if (active) setDetail(old => old && old.id === selectedId ? { ...old, status: 'read' } : old); }).catch(() => undefined); }).catch(() => undefined); return () => { active = false; }; }, [selectedId]);
  useEffect(() => { if (!compareId) { setComparison(null); return; } void call('reports.get', compareId).then(setComparison).catch(() => undefined); }, [compareId]);
  useEffect(() => {
    let active = true;
    if (selectedId) void call('reports.get', selectedId).then(value => { if (active) setDetail(old => old?.id === value.id ? value : old); }).catch(() => undefined);
    return () => { active = false; };
  }, [selectedId, snapshot.version]);
  const approve = async () => { if (!detail || !canApproveReport(detail)) return; try { await call('reports.approve', detail.id, comment); toast('결과를 승인했습니다', '이미 반영된 결과에 대한 확인을 기록했습니다.', 'info'); setApproveOpen(false); setComment(''); setQuote(''); setDetail(old => old && old.id === detail.id ? { ...old, status: 'approved', canApprove: false, canRequestChanges: false } : old); setList(old => old.map(item => item.id === detail.id ? { ...item, status: 'approved' } : item)); } catch { /* API 토스트 */ } };
  const requestChanges = async () => { if (!detail || !canRequestChanges(detail)) return; try { await call('reports.requestChanges', detail.id, { overall: comment, anchored }); setFeedback('수정 요청을 메인 에이전트에게 보냈습니다. 다음 회차는 메인 에이전트가 엽니다.'); toast('수정 요청을 메인 에이전트에게 보냈습니다.', '다음 회차는 메인 에이전트가 엽니다.', 'info'); setChangesOpen(false); setComment(''); setQuote(''); setAnchored([]); setDetail(old => old && old.id === detail.id ? { ...old, status: 'changes_requested', canRequestChanges: false } : old); setList(old => old.map(item => item.id === detail.id ? { ...item, status: 'changes_requested' } : item)); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'conflict' && 'message' in error && typeof error.message === 'string') setFeedback(error.message); } };
  const closeChanges = () => { setChangesOpen(false); setQuote(''); setQuoteComment(''); setAnchored([]); setComment(''); };
  const reportBody = detail?.markdown.replace(/^#\s+[^\r\n]+\r?\n(?:\r?\n)?/, '') ?? '';
  const treeReportTitle = (title: string, round: number) => title.replace(new RegExp(`\\s*·\\s*${round}회차\\s*보고$`), '');
  const directiveTitle = (id: string | null) => id ? snapshot.directives.find(item => item.id === id)?.title ?? '지시' : '직접 명령';
  const tree = (projectId: string | null) => { const reports = list.filter(r => r.projectId === projectId); const directiveIds = [...new Set(reports.map(r => r.directiveId))]; return directiveIds.map(id => <div className="tree-group" key={id ?? 'none'}><span className="tree-directive">{directiveTitle(id)}</span>{reports.filter(r => r.directiveId === id).sort((a, b) => a.round - b.round).map(report => <button key={report.id} className={selectedId === report.id ? 'active' : ''} onClick={() => setSelectedId(report.id)}>{report.round}회차 · {treeReportTitle(report.title, report.round)}</button>)}</div>); };
  return <div className="screen documents"><div className="page-heading"><div><span className="eyebrow">문서함</span><h1>보고서</h1><p>프로젝트, 지시, 회차별 결과와 의견을 확인합니다.</p></div></div><div className="doc-layout"><aside className="doc-tree panel"><h3>폴더</h3>{snapshot.projects.map(p => <div key={p.id}><button className="tree-project" onClick={() => setFilterProject(p.id)}><Folder size={16} /> {p.name}</button>{tree(p.id)}</div>)}<button className="tree-project" onClick={() => setFilterProject('general')}><Folder size={16} /> 일반</button>{tree(null)}</aside><div className="doc-list panel"><div className="filter-stack"><label className="search-field"><Search size={17} /><input value={text} onChange={e => setText(e.target.value)} placeholder="제목·본문 검색" /></label><div className="filter-row"><select value={filterProject} onChange={e => setFilterProject(e.target.value)} aria-label="프로젝트 필터"><option value="">모든 프로젝트</option><option value="general">일반</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><select value={filterStatus} onChange={e => setFilterStatus(e.target.value as ReportStatus | '')} aria-label="상태 필터"><option value="">모든 상태</option>{(['new', 'read', 'approved', 'changes_requested'] as const).map(s => <option key={s} value={s}>{REPORT_STATUS_LABEL[s]}</option>)}</select></div><div className="filter-row"><label>시작일<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>종료일<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div></div><div className="report-list">{list.length ? list.map(report => <button key={report.id} className={`report-list-item ${selectedId === report.id ? 'active' : ''}`} onClick={() => setSelectedId(report.id)}><FileText size={18} /><span><strong>{report.title}</strong><small>{report.projectName} · {directiveTitle(report.directiveId)} · {report.round}회차 · {date(report.createdAt)}</small></span><span className={`report-status report-${report.status}`}>{REPORT_STATUS_LABEL[report.status]}</span><ChevronRight size={15} /></button>) : <Empty text="조건에 맞는 보고서가 없습니다." />}</div></div><div className="doc-viewer panel">{detail && detail.id === selectedId ? <><div className="report-head"><span className="eyebrow">{detail.projectName} · {directiveTitle(detail.directiveId)} · {detail.round}회차</span><h2>{detail.title}</h2><div className="report-meta"><span className={`report-status report-${detail.status}`}>{REPORT_STATUS_LABEL[detail.status]}</span><span>{date(detail.createdAt)}</span></div></div><div className="report-body"><Markdown source={reportBody} onSelect={canRequestChanges(detail) ? setQuote : () => undefined} />{quote && canRequestChanges(detail) && <div className="quote-popover"><span>“{quote.slice(0, 80)}”</span><button onClick={() => { setChangesOpen(true); setQuoteComment(''); }}>코멘트 달기 <MessageSquareText size={14} /></button><button onClick={() => setQuote('')} aria-label="선택 취소">×</button></div>}</div>{detail.comments.length > 0 && <div className="report-comments"><h3>남긴 의견</h3>{detail.comments.map(c => <blockquote key={c.id}>{c.quote && <small>“{c.quote}”</small>}{c.text}</blockquote>)}</div>}{feedback && <p className="hint" role="status">{feedback}</p>}{isEndedReport(detail, snapshot) && <div className="hint report-refusal"><p>{ENDED_REPORT_NOTE}</p><button onClick={() => openCommand(detail.projectId, `${detail.id} "${detail.title}"에 대해: `)}>메인 에이전트에게 말하기</button></div>}<div className="report-footer"><button onClick={() => void call('system.openPath', detail.filePath).catch(() => undefined)}><MapPin size={15} /> 파일 위치 열기</button>{detail.status === 'approved' && <span className="approved-note"><Check size={15} /> 결과 승인됨</span>}{detail.status === 'changes_requested' && <span className="approved-note">수정 요청됨</span>}{canApproveReport(detail) && <button title="이미 반영·확정된 결과의 사후 확인입니다" onClick={() => { setComment(''); setApproveOpen(true); }}><Check size={15} /> 결과 승인</button>}{canRequestChanges(detail) && <button className="primary-button" onClick={() => { setComment(''); setChangesOpen(true); }}><MessageSquareText size={15} /> 수정 요청</button>}</div>{detail.otherRounds.length > 0 && <div className="compare-box"><h3><GitCompare size={17} /> 다른 회차와 비교</h3><select value={compareId} onChange={e => setCompareId(e.target.value)}><option value="">회차 선택</option>{detail.otherRounds.map(r => <option key={r.id} value={r.id}>{r.round}회차</option>)}</select>{comparison && <div className="comparison">{diffLines(comparison.markdown.replace(/^#\s+[^\r\n]+\r?\n(?:\r?\n)?/, ''), reportBody).map((part, i) => <div key={i} className={part.added ? 'diff-add' : part.removed ? 'diff-remove' : ''}><Markdown source={part.value} /></div>)}</div>}</div>}</> : <div className="doc-empty"><FileText size={32} /><h3>{selectedId ? '보고서를 여는 중입니다' : '보고서를 선택하세요'}</h3></div>}</div></div>
  {approveOpen && detail && canApproveReport(detail) && <Modal title="결과 승인" onClose={() => setApproveOpen(false)}><p>이미 반영·확정된 결과를 사후 확인합니다. 실행 허가가 아닙니다.</p><label>의견 <small>선택</small><textarea value={comment} onChange={e => setComment(e.target.value)} /></label><div className="modal-actions"><button onClick={() => setApproveOpen(false)}>취소</button><button className="primary-button" onClick={() => void approve()}>결과 승인</button></div></Modal>}
  {changesOpen && detail && canRequestChanges(detail) && <Modal title="수정 요청" onClose={closeChanges}><label>전체 코멘트<textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="수정할 방향을 적어 주세요" /></label>{quote && <div className="anchor-editor"><strong>선택한 부분</strong><blockquote>“{quote}”</blockquote><textarea value={quoteComment} onChange={e => setQuoteComment(e.target.value)} placeholder="이 부분에 대한 의견" /><button disabled={!quoteComment.trim()} onClick={() => { setAnchored(old => [...old, { quote, comment: quoteComment }]); setQuote(''); setQuoteComment(''); }}>부분 코멘트 추가</button></div>}{anchored.map((a, i) => <blockquote key={i}>“{a.quote}” → {a.comment}</blockquote>)}<div className="modal-actions"><button onClick={closeChanges}>취소</button><button className="primary-button" disabled={!comment.trim() && !anchored.length} onClick={() => void requestChanges()}>수정 요청 보내기</button></div></Modal>}
  </div>;
}
