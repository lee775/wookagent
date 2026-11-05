import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ChevronUp, ChevronDown, Paperclip, Send, X, MessageSquare } from 'lucide-react';
import type { AppSnapshot, ConversationView } from '../../../shared/views';
import { call, toast } from '../api/store';
import { date } from '../lib/ui';

import { subscribeCommand } from '../lib/commands';

type Attachment = { name: string; path?: string; dataUrl?: string };
export function CommandBar({ snapshot, currentProjectId }: { snapshot: AppSnapshot; currentProjectId: string | null }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => subscribeCommand(draft => { setTarget(draft.target); setText(draft.text); setExpanded(true); input.current?.focus(); }), []);
  const [target, setTarget] = useState<string>(currentProjectId ?? 'main');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<ConversationView[]>([]);
  const [sending, setSending] = useState(false);
  useEffect(() => { setTarget(currentProjectId ?? 'main'); }, [currentProjectId]);
  useEffect(() => { if (expanded) void call('command.history', target, { limit: 60 }).then(setHistory).catch(() => undefined); }, [expanded, target, snapshot.version]);
  const send = async () => {
    if (!text.trim() && attachments.length === 0 || sending) return;
    setSending(true);
    try { await call('command.send', { target, text, attachments }); setText(''); setAttachments([]); toast('명령을 보냈습니다', '메인 에이전트가 지시를 확인합니다.', 'info'); }
    catch { /* 오류 토스트는 API에서 표시 */ }
    finally { setSending(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.items].filter(item => item.type.startsWith('image/'));
    for (const image of images) { const file = image.getAsFile(); if (!file) continue; const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') setAttachments(old => [...old, { name: file.name || '붙여넣은 이미지.png', dataUrl: reader.result as string }]); }; reader.readAsDataURL(file); }
    if (images.length) event.preventDefault();
  };
  return <div className={`command-bar ${expanded ? 'command-expanded' : ''}`}>
    {expanded && <div className="conversation"><div className="conversation-title"><MessageSquare size={16} /> 대화 기록 <span>{target === 'main' ? '메인 에이전트 직접' : snapshot.projects.find(p => p.id === target)?.name}</span></div>{history.length ? history.map(item => <div key={item.id} className={`bubble bubble-${item.role}`}><small>{item.role === 'owner' ? '대표' : item.role === 'main_agent' ? '메인 에이전트' : '시스템'} · {date(item.createdAt)}</small><p>{item.text}</p>{item.attachments.map(a => <small key={a.id}>📎 {a.name}</small>)}</div>) : <p className="muted">아직 대화가 없습니다.</p>}</div>}
    <div className="command-compose"><select aria-label="명령 대상" value={target} onChange={event => setTarget(event.target.value)}><option value="main">메인 에이전트 직접</option>{snapshot.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select><div className="command-input"><textarea ref={input} value={text} onChange={event => setText(event.target.value)} onKeyDown={keyDown} onPaste={paste} placeholder="메인 에이전트에게 명령하세요" title="Enter 전송 · Shift+Enter 줄바꿈" aria-label="명령 입력" rows={2} />{attachments.length > 0 && <div className="attachment-chips">{attachments.map((item, index) => <span key={`${item.name}-${index}`}>📎 {item.name}<button onClick={() => setAttachments(old => old.filter((_, i) => i !== index))} aria-label="첨부 제거"><X size={12} /></button></span>)}</div>}</div><button className="icon-button" title="파일 첨부" aria-label="파일 첨부" onClick={() => void call('system.pickFiles').then(files => setAttachments(old => [...old, ...files])).catch(() => undefined)}><Paperclip size={19} /></button><button className="primary-button send-button" onClick={() => void send()} disabled={sending || !text.trim() && attachments.length === 0}><Send size={17} /> 보내기</button><button className="icon-button" onClick={() => setExpanded(value => !value)} aria-label={expanded ? '대화 기록 접기' : '대화 기록 펼치기'}>{expanded ? <ChevronDown size={19} /> : <ChevronUp size={19} />}</button></div>
  </div>;
}
