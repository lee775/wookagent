import type { AppSnapshot, NotificationView } from '../../../shared/views';
import type { NavTarget } from '../../../shared/domain';
import { NOTIFICATION_LEVEL_LABEL } from '../../../shared/labels';
import { date } from '../lib/ui';
import { openCommand } from '../lib/commands';
import { noticePresentation, mainReplyTarget, openMainReply } from '../lib/notice';

export function noticeCommand(item: NotificationView, snapshot: AppSnapshot) {
  return noticePresentation(item, snapshot).command;
}

export function ServerNotice({ item, snapshot, navigate, markRead, close, showDevices }: {
  item: NotificationView; snapshot: AppSnapshot; navigate: (target: NavTarget) => void;
  markRead: () => void; close: () => void;
  showDevices?: () => void;
}) {
  const { title, link, command } = noticePresentation(item, snapshot);
  const reply=mainReplyTarget(item)!==undefined;
  if(reply)return <div className={`notification-item ${item.read?'read':''}`}>
    <span className={`notification-level level-${item.level}`}>{NOTIFICATION_LEVEL_LABEL[item.level]}</span>
    <div className="notice-content"><button className="main-reply-preview" aria-label="답변 대화 열기" onClick={()=>{close();openMainReply(item);}}><strong>{title}</strong><p className="main-reply-body">{item.body}</p><span>답변 대화 열기 →</span></button><small>{date(item.createdAt)} · {item.read?'읽음':'읽지 않음'}</small></div>
  </div>;
  const deviceLogin = item.key?.startsWith('device-login:') && link?.tab !== 'seat';
  return <div className={`notification-item ${item.read ? 'read' : ''}`}>
    <span className={`notification-level level-${item.level}`}>{NOTIFICATION_LEVEL_LABEL[item.level]}</span>
    <div className="notice-content"><strong>{title}</strong>
      <details className="notice-body"><summary><span className="notice-line">{item.body}</span><span className="notice-toggle"><span className="notice-expand">본문 펼치기</span><span className="notice-collapse">본문 접기</span></span></summary></details>
      <small>{date(item.createdAt)} · {item.read ? '읽음' : '읽지 않음'}</small>
      <div className="notice-actions"><button onClick={() => { close(); markRead(); if (deviceLogin && showDevices) showDevices(); else if (link) navigate(link); }}>{deviceLogin ? '로그인한 기기 보기' : link ? '관련 화면 보기' : '읽음으로 표시'}</button>
      {command && <button onClick={() => { markRead(); close(); openCommand(command.projectId, command.text); }}>메인 에이전트에게 말하기</button>}</div>
    </div>
  </div>;
}
