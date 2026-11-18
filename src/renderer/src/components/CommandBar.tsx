import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ChevronUp, ChevronDown, Paperclip, Send, X, MessageSquare } from 'lucide-react';
import type { AppSnapshot, ConversationView, NotificationView } from '../../../shared/views';
import { call, toast } from '../api/store';
import { date } from '../lib/ui';

import { subscribeCommand, subscribeConversation } from '../lib/commands';
import { getBridge } from '../api/bridge';
import { runtime } from '../api/runtime';
import { UploadQueue, webCommandAttachments, MAX_UPLOAD_BYTES, type UploadChip } from '../lib/uploads';
import { FileDownload } from './FileDownload';
import { mainReplyTarget } from '../lib/notice';
import { readFileDrop } from '../lib/fileDrop';
import { useCommandDrop } from '../lib/useCommandDrop';
import '../styles/command-drop.css';

type Attachment = { name: string; path?: string; dataUrl?: string };
const noNotices:NotificationView[]=[];
export function CommandBar({ snapshot, currentProjectId,notifications=noNotices }: { snapshot: AppSnapshot; currentProjectId: string | null;notifications?:NotificationView[] }) {
  const web = runtime().web;
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadChip[]>([]);
  const queue = useRef<UploadQueue | null>(null);
  useEffect(() => {
    const api = getBridge().web;
    if (api) queue.current = new UploadQueue(api, setUploads);
    return () => { queue.current?.dispose(); queue.current = null; };
  }, []);
  const [feedback, setFeedback] = useState({ sequence: 0, text: '', visible: false });
  const announce = (message: string, visible = false) => setFeedback(old => ({ sequence: old.sequence + 1, text: message, visible }));
  const addFiles = (files: File[]) => {
    queue.current?.add(files.map(file => ({ file, name: file.name || '붙여넣은 이미지.png' })));
    if (files.length) announce(`파일 ${files.length}개를 첨부 목록에 추가했습니다.`);
  };
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => subscribeCommand(draft => { setTarget(draft.target); setText(draft.text); setExpanded(true); input.current?.focus(); }), []);
  useEffect(() => subscribeConversation(target => {
    setTarget(target); setExpanded(true);
  }), []);
  const [target, setTarget] = useState<string>(currentProjectId ?? 'main');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(0);
  const dragging = useCommandDrop(data => {
    const { files, refusals } = readFileDrop(data, web ? 'web' : 'desktop');
    input.current?.focus();
    if (web) {
      addFiles(files);
      if (refusals.length) announce(`${files.length ? `파일 ${files.length}개를 첨부 목록에 추가했습니다. ` : ''}${refusals.join(' ')}`, true);
      return;
    }
    if (refusals.length) announce(refusals.join(' '), true);
    if (!files.length) return;
    setReadingFiles(count => count + files.length);
    void Promise.all(files.map(file => new Promise<Attachment | null>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? { name: file.name, dataUrl: reader.result } : null);
      reader.onerror = reader.onabort = () => resolve(null);
      reader.readAsDataURL(file);
    }))).then(results => {
      const added = results.filter(item => item !== null);
      setAttachments(old => [...old, ...added]);
      setReadingFiles(count => count - files.length);
      const messages = [...refusals];
      if (added.length) messages.unshift(`파일 ${added.length}개를 첨부했습니다.`);
      if (added.length < files.length) messages.push('일부 파일을 읽지 못했습니다. 파일 첨부 버튼으로 다시 골라 주세요.');
      announce(messages.join(' '), refusals.length > 0 || added.length < files.length);
    });
  });
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<ConversationView[]>([]);
  const [historyTarget,setHistoryTarget]=useState<string|null>(null);
  const [seenReplies,setSeenReplies]=useState<Set<string>>(()=>new Set());
  const [pendingReplies,setPendingReplies]=useState<NotificationView[]>([]);
  const conversation=useRef<HTMLDivElement>(null);
  const lastScrolled=useRef<string|null>(null);
  const [visibilityEpoch,setVisibilityEpoch]=useState(0);
  useEffect(()=>{if(typeof document==='undefined')return;const visible=()=>setVisibilityEpoch(value=>value+1);document.addEventListener('visibilitychange',visible);return()=>document.removeEventListener('visibilitychange',visible);},[]);
  const arrivingReplies=notifications.filter(item=>!item.read&&mainReplyTarget(item)!==undefined);
  const unreadReplies=[...new Map([...pendingReplies,...arrivingReplies].map(item=>[item.id,item])).values()].filter(item=>!seenReplies.has(item.id));
  useEffect(()=>{setPendingReplies(old=>{const ids=new Set(old.map(item=>item.id));const added=arrivingReplies.filter(item=>!ids.has(item.id)&&!seenReplies.has(item.id));return added.length?[...old,...added]:old;});},[notifications]);
  const [sending, setSending] = useState(false);
  const uploadBlocked = readingFiles > 0 || web && uploads.some(item => item.state.kind !== 'ready');
  const attachmentCount = web ? uploads.length : attachments.length;
  useEffect(() => { setTarget(currentProjectId ?? 'main'); }, [currentProjectId]);
  useEffect(() => {
    let live=true;
    if(expanded)void call('command.history',target,{limit:60}).then(items=>{if(live){setHistory(items);setHistoryTarget(target);}}).catch(()=>undefined);
    return()=>{live=false;};
  }, [expanded, target, snapshot.version,notifications]);
  useEffect(()=>{
    if(!expanded){lastScrolled.current=null;return;}
    if(historyTarget!==target||typeof document==='undefined')return;
    const newest=`${target}:${history.at(-1)?.id??''}`;
    if(lastScrolled.current!==newest&&conversation.current){conversation.current.scrollTop=conversation.current.scrollHeight;lastScrolled.current=newest;}
    if(document.visibilityState==='hidden')return;
    const visible=unreadReplies.filter(item=>mainReplyTarget(item)===target&&history.some(message=>message.role==='main_agent'&&message.text.replace(/\s+/g,' ').trim().startsWith(item.body.replace(/…$/,'').trim())));
    if(!visible.length)return;
    setSeenReplies(old=>new Set([...old,...visible.map(item=>item.id)]));
    for(const item of visible)void call('notifications.markRead',item.id).catch(()=>undefined);
  },[expanded,target,historyTarget,history,notifications,visibilityEpoch]);
  const send = async () => {
    if (!text.trim() && attachmentCount === 0 || sending || uploadBlocked) return;
    setSending(true);
    try { await call('command.send', { target, text, attachments: web ? webCommandAttachments(uploads) : attachments }); setText(''); setAttachments([]); queue.current?.clear(); toast('명령을 보냈습니다', '메인 에이전트가 지시를 확인합니다.', 'info'); }
    catch { /* 오류 토스트는 API에서 표시 */ }
    finally { setSending(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.items].filter(item => item.type.startsWith('image/'));
    if (web) { addFiles(images.flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; })); if (images.length) event.preventDefault(); return; }
    for (const image of images) { const file = image.getAsFile(); if (!file) continue; const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') setAttachments(old => [...old, { name: file.name || '붙여넣은 이미지.png', dataUrl: reader.result as string }]); }; reader.readAsDataURL(file); }
    if (images.length) event.preventDefault();
  };
  return <div className={`command-bar ${expanded ? 'command-expanded' : ''}`}>
    {expanded && <div className="conversation" ref={conversation}><div className="conversation-title"><MessageSquare size={16} /> 대화 기록 <span>{target === 'main' ? '메인 에이전트 직접' : snapshot.projects.find(p => p.id === target)?.name}</span></div>{historyTarget===target && history.length ? history.map(item => <div key={item.id} className={`bubble bubble-${item.role}`}><small>{item.role === 'owner' ? '대표' : item.role === 'main_agent' ? '메인 에이전트' : '시스템'} · {date(item.createdAt)}</small><p>{item.text}</p>{item.attachments.map(a => <FileDownload key={a.id} target={{ kind: 'attachment', id: a.id }} path={a.path}>📎 {a.name}</FileDownload>)}</div>) : <p className="muted">아직 대화가 없습니다.</p>}</div>}
    <div className={`command-compose ${dragging ? 'command-file-over' : ''}`}><select aria-label="명령 대상" value={target} onChange={event => setTarget(event.target.value)}><option value="main">메인 에이전트 직접</option>{snapshot.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select><div className="command-input">{dragging && <div className="command-drop-hint" aria-hidden="true"><Paperclip size={20} /><strong>창 어디에 놓아도 명령에 첨부됩니다</strong><small>{target === 'main' ? '메인 에이전트에게 보낼 파일' : `${snapshot.projects.find(project => project.id === target)?.name ?? '선택한 프로젝트'}에 보낼 파일`} · 파일당 50 MB</small></div>}<textarea ref={input} value={text} onChange={event => setText(event.target.value)} onKeyDown={keyDown} onPaste={paste} placeholder="메인 에이전트에게 명령하세요" title="Enter 전송 · Shift+Enter 줄바꿈" aria-label="명령 입력" rows={2} />{!web && attachments.length > 0 && <div className="attachment-chips">{attachments.map((item, index) => <span key={`${item.name}-${index}`}>📎 {item.name}<button onClick={() => setAttachments(old => old.filter((_, i) => i !== index))} aria-label="첨부 제거"><X size={12} /></button></span>)}</div>}{web && uploads.length > 0 && <div className="attachment-chips upload-chips" aria-label="첨부 파일 목록">{uploads.map(item => <div className={`upload-chip upload-${item.state.kind}`} key={item.id}>
      <span className="upload-name">📎 {item.name}</span>
      {item.state.kind === 'uploading' && <><progress aria-label={`${item.name} 업로드 진행률`} value={item.state.percent} max={100} /><small>{item.state.percent}%</small></>}
      {item.state.kind === 'queued' && <small role="status" aria-label={`${item.name} 업로드 대기`}>{item.state.retry > 0 ? '업로드 대기 · 잠시 뒤 다시 올립니다' : '업로드 대기'}</small>}
      {item.state.kind === 'ready' && <small>첨부 준비됨</small>}
      {item.state.kind === 'error' && <><small role="alert">{item.state.message}</small>{item.file.size <= MAX_UPLOAD_BYTES && <button aria-label={`${item.name} 다시 올리기`} onClick={() => queue.current?.retry(item.id)}>다시 올리기</button>}</>}
      <button aria-label={`${item.name} 첨부 제거`} onClick={() => queue.current?.remove(item.id)}><X size={14} /></button>
    </div>)}</div>}</div><input ref={fileInput} type="file" multiple hidden aria-label="첨부할 파일 선택" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /><button className="icon-button" title="파일 첨부" aria-label="파일 첨부" onClick={() => web ? fileInput.current?.click() : void call('system.pickFiles').then(files => { setAttachments(old => [...old, ...files]); if (files.length) announce(`파일 ${files.length}개를 첨부했습니다.`); }).catch(() => undefined)}><Paperclip size={19} /></button><button className="primary-button send-button" onClick={() => void send()} disabled={sending || uploadBlocked || !text.trim() && attachmentCount === 0}><Send size={17} /> 보내기</button><button className="icon-button" onClick={() => setExpanded(value => !value)} aria-label={expanded ? '대화 기록 접기' : '대화 기록 펼치기'}>{expanded ? <ChevronDown size={19} /> : <ChevronUp size={19} />}{unreadReplies.length>0&&<span className="conversation-unread" role="status" aria-label={`읽지 않은 메인 답변 ${unreadReplies.length}개`}>{unreadReplies.length}</span>}</button></div>
    {readingFiles > 0 && <p className="command-file-reading" role="status">파일 {readingFiles}개를 읽는 중입니다…</p>}
    <div className={feedback.visible ? 'command-file-feedback' : 'command-file-status'} role="status" aria-live="polite" aria-atomic="true"><span key={feedback.sequence}>{feedback.text}</span></div>
  </div>;
}
