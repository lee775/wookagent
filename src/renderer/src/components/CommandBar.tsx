import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Maximize2, Minimize2, Paperclip, Send, X, NotebookPen } from 'lucide-react';
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
import { useChatSurface } from '../lib/useChatSurface';
import '../styles/command-drop.css';
import '../styles/agent-chat.css';

type Attachment = { name: string; path?: string; dataUrl?: string };
const noNotices:NotificationView[]=[];
export function CommandBar({ snapshot, currentProjectId,notifications=noNotices }: { snapshot: AppSnapshot; currentProjectId: string | null;notifications?:NotificationView[] }) {
  const [view, setView] = useState<'closed' | 'compact' | 'expanded'>('closed');
  const open = view !== 'closed';
  const launcher = useRef<HTMLButtonElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const { viewport, blocked } = useChatSurface(open);
  const openPanel = () => { setView(value => value === 'closed' ? 'compact' : value); setFocusRequest(value => value + 1); };
  const closePanel = () => { setView('closed'); launcher.current?.focus({ preventScroll: true }); };
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
  useEffect(() => subscribeCommand(draft => { setTarget(draft.target); setText(draft.text); openPanel(); }), []);
  useEffect(() => subscribeConversation(target => {
    setTarget(target); openPanel();
  }), []);
  useEffect(() => { if (open && !blocked) input.current?.focus({ preventScroll: true }); }, [open, focusRequest, blocked]);
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented || blocked) return;
      if (typeof Element !== 'undefined' && event.target instanceof Element && event.target.closest('.member-panel')) return;
      event.preventDefault(); closePanel();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, blocked]);
  const [target, setTarget] = useState<string>(currentProjectId ?? 'main');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(0);
  const readDesktopFiles = (files: File[], refusals: string[] = []) => {
    if (refusals.length) announce(refusals.join(' '), true);
    if (!files.length) return;
    setReadingFiles(count => count + files.length);
    void Promise.all(files.map(file => new Promise<Attachment | null>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? { name: file.name || '붙여넣은 이미지.png', dataUrl: reader.result } : null);
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
  };
  const dragging = useCommandDrop(data => {
    const { files, refusals } = readFileDrop(data, web ? 'web' : 'desktop');
    openPanel();
    if (web) {
      addFiles(files);
      if (refusals.length) announce(`${files.length ? `파일 ${files.length}개를 첨부 목록에 추가했습니다. ` : ''}${refusals.join(' ')}`, true);
      return;
    }
    readDesktopFiles(files, refusals);
  });
  const [history, setHistory] = useState<ConversationView[]>([]);
  const [historyTarget,setHistoryTarget]=useState<string|null>(null);
  const [seenReplies,setSeenReplies]=useState<Set<string>>(()=>new Set());
  const [pendingReplies,setPendingReplies]=useState<NotificationView[]>([]);
  const conversation=useRef<HTMLDivElement>(null);
  const lastScrolled=useRef<string|null>(null);
  const followLatest=useRef(true);
  useEffect(()=>{lastScrolled.current=null;followLatest.current=true;},[target]);
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
    if(open)void call('command.history',target,{limit:60}).then(items=>{if(live){setHistory(items);setHistoryTarget(target);}}).catch(()=>undefined);
    return()=>{live=false;};
  }, [open, target, snapshot.version,notifications]);
  useEffect(()=>{
    if(!open){lastScrolled.current=null;followLatest.current=true;return;}
    if(historyTarget!==target||typeof document==='undefined')return;
    const newest=`${target}:${history.at(-1)?.id??''}`;
    if(lastScrolled.current!==newest&&conversation.current){
      if(lastScrolled.current===null||followLatest.current)conversation.current.scrollTop=conversation.current.scrollHeight;
      lastScrolled.current=newest;
    }
    if(document.visibilityState==='hidden'||blocked)return;
    const visible=unreadReplies.filter(item=>mainReplyTarget(item)===target&&history.some(message=>{
      if(message.role!=='main_agent'||!message.text.replace(/\s+/g,' ').trim().startsWith(item.body.replace(/…$/,'').trim()))return false;
      const list=conversation.current;
      const bubble=Array.from(list?.querySelectorAll<HTMLElement>('[data-message-id]')??[]).find(node=>node.dataset.messageId===message.id);
      if(!list||!bubble)return true;
      const frame=list.getBoundingClientRect(),rect=bubble.getBoundingClientRect();
      return rect.bottom>frame.top&&rect.top<frame.bottom&&rect.height>0;
    }));
    if(!visible.length)return;
    setSeenReplies(old=>new Set([...old,...visible.map(item=>item.id)]));
    for(const item of visible)void call('notifications.markRead',item.id).catch(()=>undefined);
  },[open,target,historyTarget,history,notifications,visibilityEpoch,blocked]);
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
    const pasted = images.flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; });
    if (web) addFiles(pasted);
    else readDesktopFiles(pasted.filter(file => file.size <= MAX_UPLOAD_BYTES), pasted.filter(file => file.size > MAX_UPLOAD_BYTES).map(file => `${file.name}: 파일 하나는 50 MB까지 첨부할 수 있습니다.`));
    if (images.length) event.preventDefault();
  };
  return <div className="agent-chat-widget" style={viewport}>
    <button ref={launcher} className="chat-launcher" aria-label="메인 에이전트 대화" aria-controls="main-agent-chat" aria-expanded={open} inert={blocked} onClick={() => open ? closePanel() : openPanel()}>
      <span className="chat-launcher-mark" aria-hidden="true"><NotebookPen size={21} /></span>
      <span>메인과 대화<small>{open ? '대화창 닫기' : '업무를 이야기하세요'}</small></span>
      {unreadReplies.length > 0 && <span className="conversation-unread" role="status" aria-label={`읽지 않은 메인 답변 ${unreadReplies.length}개`}>{unreadReplies.length}</span>}
    </button>
    <section id="main-agent-chat" className={`agent-chat agent-chat-${view}`} role="dialog" aria-modal="false" aria-label="메인 에이전트 대화창" hidden={!open} inert={blocked}>
      <header className="chat-header">
        <div><span className="chat-eyebrow">업무 대화</span><h2>메인 에이전트</h2></div>
        <div className="chat-window-controls">
          <button className="icon-button" aria-label={view === 'expanded' ? '대화 작게 보기' : '대화 넓게 보기'} title={view === 'expanded' ? '작게 보기' : '넓게 보기'} onClick={() => setView(value => value === 'expanded' ? 'compact' : 'expanded')}>{view === 'expanded' ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
          <button className="icon-button" aria-label="대화 닫기" title="대화 닫기 (Esc)" onClick={closePanel}><X size={20} /></button>
        </div>
      </header>
      <label className="chat-target"><span>대화 대상</span><select aria-label="명령 대상" value={target} onChange={event => setTarget(event.target.value)}><option value="main">메인 에이전트 직접</option>{snapshot.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
      <div className="conversation" ref={conversation} role="log" aria-label="주고받은 대화" aria-live="polite" aria-relevant="additions text" onScroll={() => {
        const list=conversation.current;
        if(list)followLatest.current=list.scrollHeight-list.scrollTop-list.clientHeight<36;
        setVisibilityEpoch(value => value + 1);
      }}>
        {historyTarget === target && history.length ? history.map(item => <div key={item.id} data-message-id={item.id} className={`bubble bubble-${item.role}`}>
          <small>{item.role === 'owner' ? '대표' : item.role === 'main_agent' ? '메인 에이전트' : '시스템'} <time dateTime={item.createdAt}>{date(item.createdAt)}</time></small>
          <p>{item.text}</p>{item.attachments.map(a => <FileDownload key={a.id} target={{ kind: 'attachment', id: a.id }} path={a.path}>📎 {a.name}</FileDownload>)}
        </div>) : <div className="chat-empty"><NotebookPen size={28} aria-hidden="true" /><strong>이야기는 여기서 시작합니다</strong><p>맡길 일이나 궁금한 내용을 남겨 주세요.<br />파일도 함께 보낼 수 있습니다.</p></div>}
      </div>
      <div className="command-compose">
        <div className="command-input"><textarea ref={input} value={text} onChange={event => setText(event.target.value)} onKeyDown={keyDown} onPaste={paste} placeholder="맡길 일이나 궁금한 내용을 적어 주세요" title="Enter 전송 · Shift+Enter 줄바꿈" aria-label="명령 입력" rows={2} /></div>
        {!web && attachments.length > 0 && <div className="attachment-chips" aria-label="첨부 파일 목록">{attachments.map((item, index) => <span key={`${item.name}-${index}`}>📎 {item.name}<button onClick={() => setAttachments(old => old.filter((_, i) => i !== index))} aria-label={`${item.name} 첨부 제거`}><X size={14} /></button></span>)}</div>}
        {web && uploads.length > 0 && <div className="attachment-chips upload-chips" aria-label="첨부 파일 목록">{uploads.map(item => <div className={`upload-chip upload-${item.state.kind}`} key={item.id}>
      <span className="upload-name">📎 {item.name}</span>
      {item.state.kind === 'uploading' && <><progress aria-label={`${item.name} 업로드 진행률`} value={item.state.percent} max={100} /><small>{item.state.percent}%</small></>}
      {item.state.kind === 'queued' && <small role="status" aria-label={`${item.name} 업로드 대기`}>{item.state.retry > 0 ? '업로드 대기 · 잠시 뒤 다시 올립니다' : '업로드 대기'}</small>}
      {item.state.kind === 'ready' && <small>첨부 준비됨</small>}
      {item.state.kind === 'error' && <><small role="alert">{item.state.message}</small>{item.file.size <= MAX_UPLOAD_BYTES && <button aria-label={`${item.name} 다시 올리기`} onClick={() => queue.current?.retry(item.id)}>다시 올리기</button>}</>}
      <button aria-label={`${item.name} 첨부 제거`} onClick={() => queue.current?.remove(item.id)}><X size={14} /></button>
        </div>)}</div>}
        <input ref={fileInput} type="file" multiple hidden aria-label="첨부할 파일 선택" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <div className="chat-compose-actions"><button className="icon-button" title="파일 첨부" aria-label="파일 첨부" onClick={() => web ? fileInput.current?.click() : void call('system.pickFiles').then(files => { setAttachments(old => [...old, ...files]); if (files.length) announce(`파일 ${files.length}개를 첨부했습니다.`); }).catch(() => undefined)}><Paperclip size={19} /></button><small>Enter 보내기 · Shift+Enter 줄바꿈</small><button className="primary-button send-button" onClick={() => void send()} disabled={sending || uploadBlocked || !text.trim() && attachmentCount === 0} aria-busy={sending}><Send size={17} /> {sending ? '보내는 중…' : '보내기'}</button></div>
        {readingFiles > 0 && <p className="command-file-reading" role="status">파일 {readingFiles}개를 읽는 중입니다…</p>}
        <div className={feedback.visible ? 'command-file-feedback' : 'command-file-status'} role="status" aria-live="polite" aria-atomic="true"><span key={feedback.sequence}>{feedback.text}</span></div>
      </div>
    </section>
    {dragging && <div className="command-drop-hint command-file-over" aria-hidden="true"><Paperclip size={20} /><strong>창 어디에 놓아도 명령에 첨부됩니다</strong><small>{target === 'main' ? '메인 에이전트에게 보낼 파일' : `${snapshot.projects.find(project => project.id === target)?.name ?? '선택한 프로젝트'}에 보낼 파일`} · 파일당 50 MB</small></div>}
  </div>;
}
