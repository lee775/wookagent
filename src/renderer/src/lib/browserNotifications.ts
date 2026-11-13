import type { NavTarget } from '../../../shared/domain';
import type { NotificationView } from '../../../shared/views';
import { mainReplyTarget, openMainReply } from './notice';
import { openConversation } from './commands';

export const NOTIFICATION_TITLE = '욱채 알림';
export const NOTIFICATION_BODY = '작업실에 확인할 새 알림이 있습니다.';
export const NOTIFICATION_UNAVAILABLE = '이 브라우저에서는 알림을 표시할 수 없습니다. 작업실의 알림함을 확인해 주세요.';
const unavailableEvent = 'wook:notifications-unavailable';
const linkPrefix = '/#wook-notify=';
const replyPrefix='/#wook-reply=';

export function browserNotificationContent(item:NotificationView,count=1) {
  const target=mainReplyTarget(item);
  return target===undefined?{title:NOTIFICATION_TITLE,body:count>1?`작업실에 확인할 새 알림이 ${count}개 있습니다.`:NOTIFICATION_BODY,link:notificationLink(item.link)}:
    {title:item.title,body:item.body,link:`${replyPrefix}${encodeURIComponent(target)}`};
}
export function browserReplyTarget(link:unknown):string|undefined {
  if(typeof link!=='string'||!link.startsWith(replyPrefix)||link.length>1000)return;
  try{const target=decodeURIComponent(link.slice(replyPrefix.length));if(/^[a-zA-Z0-9_-]{1,120}$/.test(target))return target;}catch{/* Ignore malformed browser input. */}
}
type State = { seen: Set<string>; listed: boolean; shown: Set<string>; pending: Set<string>; unavailable: boolean; registration?: Promise<ServiceWorkerRegistration | null> };
const documents = new WeakMap<Document, State>();
function state(): State {
  let value = documents.get(document);
  if (!value) { value = { seen: new Set(), listed: false, shown: new Set(), pending: new Set(), unavailable: false }; documents.set(document, value); }
  return value;
}
export function notificationsUnavailable() { return state().unavailable; }
function cannotShow() {
  if (state().unavailable) return;
  state().unavailable = true;
  window.dispatchEvent(new Event(unavailableEvent));
}
export function onNotificationsUnavailable(listener: () => void) {
  window.addEventListener(unavailableEvent, listener);
  return () => window.removeEventListener(unavailableEvent, listener);
}
export function prepareBrowserNotifications(): Promise<ServiceWorkerRegistration | null> {
  const current = state();
  if (!current.registration) current.registration = (async () => {
    if (!navigator.serviceWorker) return null;
    try {
      const registration = await navigator.serviceWorker.register('/notify-sw.js', { scope: '/' });
      if (registration.active) return registration;
      const worker = registration.installing ?? registration.waiting;
      if (!worker || worker.state === 'redundant') return null;
      // Unlike ready, this settles even if this worker's installation fails.
      return await new Promise<ServiceWorkerRegistration | null>(resolve => {
        const changed = () => {
          if (worker.state !== 'activated' && worker.state !== 'redundant') return;
          worker.removeEventListener('statechange', changed);
          resolve(worker.state === 'activated' ? registration : null);
        };
        worker.addEventListener('statechange', changed); changed();
      });
    } catch { return null; }
  })();
  return current.registration;
}

function notificationLink(target: NavTarget | null) { return target ? `${linkPrefix}${encodeURIComponent(JSON.stringify(target))}` : '/'; }
/** Accept only routes created here: worker messages and cold-start URLs are external input. */
export function notificationTarget(link: unknown): NavTarget | null {
  if (typeof link !== 'string' || !link.startsWith(linkPrefix)) return null;
  let value: unknown;
  try { value = JSON.parse(decodeURIComponent(link.slice(linkPrefix.length))); } catch { return null; }
  if (!value || typeof value !== 'object' || !('tab' in value)) return null;
  const id = (key: string) => key in value && typeof Reflect.get(value, key) === 'string' ? String(Reflect.get(value, key)) : undefined;
  switch (value.tab) {
    case 'projects': return { tab: 'projects', projectId: id('projectId'), memberId: id('memberId'), taskId: id('taskId'), directiveId: id('directiveId') };
    case 'documents': return { tab: 'documents', reportId: id('reportId'), projectId: id('projectId') };
    case 'seat': return { tab: 'seat' };
    case 'settings': {
      const section = id('section');
      if (section === undefined) return { tab: 'settings' };
      if (section === 'general' || section === 'account' || section === 'team' || section === 'execution' || section === 'policy' || section === 'skills' || section === 'logs' || section === 'developer') return { tab: 'settings', section };
      return null;
    }
    default: return null;
  }
}
export function listenNotificationNavigation(navigate: (target: NavTarget) => void) {
  const open = (link: unknown) => { const reply=browserReplyTarget(link);if(reply!==undefined){openConversation(reply);return;}const target = notificationTarget(link); if (target) navigate(target); };
  const receive = (event: MessageEvent<unknown>) => {
    if (event.origin && event.origin !== window.location.origin) return;
    const value = event.data;
    if (value && typeof value === 'object' && 'type' in value && value.type === 'wook:navigate' && 'link' in value) open(value.link);
  };
  navigator.serviceWorker?.addEventListener('message', receive);
  if (window.location.hash?.startsWith('#wook-notify=')||window.location.hash?.startsWith('#wook-reply=')) {
    open(`/${window.location.hash}`);
    const page = new URL(window.location.href); page.hash = '';
    window.history.replaceState(null, '', page.pathname + page.search);
  }
  return () => navigator.serviceWorker?.removeEventListener('message', receive);
}

async function show(items: NotificationView[], navigate: (target: NavTarget) => void) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState !== 'hidden' || state().unavailable) return;
  const current = state();
  const fresh = items.filter(item => !current.shown.has(item.id) && !current.pending.has(item.id));
  if (!fresh.length) return;
  if(fresh.length>1&&fresh.some(item=>mainReplyTarget(item)!==undefined)){
    for(const item of fresh.filter(item=>mainReplyTarget(item)!==undefined))await show([item],navigate);
    await show(fresh.filter(item=>mainReplyTarget(item)===undefined),navigate);return;
  }
  fresh.forEach(item => current.pending.add(item.id));
  const item = fresh[0];
  const {title,body,link}=browserNotificationContent(item,fresh.length);
  const tag = `wook-${item.id}`;
  try {
    const registration = await prepareBrowserNotifications();
    if (Notification.permission !== 'granted' || document.visibilityState !== 'hidden') return;
    let delivered = false;
    if (registration) {
      try { await registration.showNotification(title, { body, tag, data: { link } }); delivered = true; }
      catch { /* Try the constructor below. */ }
    }
    if (!delivered) {
      const notification = new Notification(title, { body, tag, data: { link } });
      notification.onclick = () => { window.focus(); if(!openMainReply(item)&&item.link)navigate(item.link); notification.close(); };
    }
    fresh.forEach(item => current.shown.add(item.id));
  } catch { cannotShow(); }
  finally { fresh.forEach(item => current.pending.delete(item.id)); }
}
export function showBrowserNotification(item: NotificationView, navigate: (target: NavTarget) => void) {
  state().seen.add(item.id);
  return show([item], navigate);
}
export function showMissedNotifications(items: NotificationView[], navigate: (target: NavTarget) => void) {
  const current = state();
  // The first list is the baseline. Later reads recover unseen ids, even before a loss is detected.
  const missed = current.listed ? items.filter(item => !item.read && !current.seen.has(item.id)) : [];
  items.forEach(item => current.seen.add(item.id));
  current.listed = true;
  return show(missed, navigate);
}
