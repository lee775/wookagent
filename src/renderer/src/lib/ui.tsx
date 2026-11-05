import type { ReactNode } from 'react';
import { X, CircleCheck, Clock3, CircleHelp, Pause, CircleAlert, FileText } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { MemberStatus, ProgressView, DiffView } from '../../../shared/views';
import { MEMBER_STATUS_LABEL, MEMBER_STATUS_COLOR } from '../../../shared/labels';

export function date(value: string | null) { return value ? new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'; }
export function duration(seconds: number) { const h = Math.floor(seconds / 3600); const m = Math.floor(seconds % 3600 / 60); return h ? `${h}시간 ${m}분` : `${m}분`; }
export function StatusBadge({ status }: { status: MemberStatus }) {
  const Icon = { idle: Clock3, awaiting_answer: CircleHelp, paused: Pause, error: CircleAlert }[status as Exclude<MemberStatus, 'working'>];
  return <span className={`status status-${MEMBER_STATUS_COLOR[status]}`}>{status === 'working' ? <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" rx="2" fill="currentColor" opacity=".28" /><path d="M3 9h8M4 5h2v4M8 3h2v6" stroke="currentColor" strokeWidth="1.5" /></svg> : <Icon size={14} aria-hidden="true" />} {MEMBER_STATUS_LABEL[status]}</span>;
}
export function Progress({ value, compact = false }: { value: ProgressView; compact?: boolean }) {
  return <div className="progress-wrap"><div className="progress-track"><div style={{ width: `${Math.min(100, Math.round(value.ratio * 100))}%` }} /></div><span>{compact ? `${value.done}/${value.total}` : `단계 ${value.done}/${value.total} · ${Math.round(value.ratio * 100)}%`}</span></div>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="닫기"><X size={20} /></button></header><div className="modal-body">{children}</div></section></div>;
}
export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="panel section"><div className="section-head"><h2>{title}</h2>{action}</div>{children}</section>; }
export function Empty({ text }: { text: string }) { return <div className="empty"><FileText size={24} /><p>{text}</p></div>; }
export function Markdown({ source, onSelect }: { source: string; onSelect?: (quote: string) => void }) {
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
  return <article className="markdown" onMouseUp={() => { const quote = window.getSelection()?.toString().trim(); if (quote) onSelect?.(quote); }} dangerouslySetInnerHTML={{ __html: html }} />;
}
export function Diff({ value }: { value: DiffView | null }) {
  if (!value) return <Empty text="변경 내용이 없습니다." />;
  return <div className="diff-view"><div className="file-list">{value.files.map(file => <span key={file.path}><CircleCheck size={13} /> {file.status} {file.path} <small>+{file.additions} −{file.deletions}</small></span>)}</div>{value.truncated && <p className="warning">차이가 길어 일부만 표시했습니다.</p>}<pre>{value.patch.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-meta' : ''}>{line}{'\n'}</span>)}</pre></div>;
}
export function LabelValue({ label, children }: { label: string; children: ReactNode }) { return <div className="label-value"><dt>{label}</dt><dd>{children}</dd></div>; }
