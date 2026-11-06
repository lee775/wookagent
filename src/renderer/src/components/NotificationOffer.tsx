import { useEffect, useState } from 'react';
import { runtime } from '../api/runtime';
import { NOTIFICATION_UNAVAILABLE, notificationsUnavailable, onNotificationsUnavailable, prepareBrowserNotifications } from '../lib/browserNotifications';

function dismissalKey(viewer: string) { return `wook:notification-unavailable-dismissed:${encodeURIComponent(viewer)}`; }
function wasDismissed(viewer: string) {
  try { return window.localStorage.getItem(dismissalKey(viewer)) === '1'; } catch { return false; }
}
export function NotificationOffer({ viewer = 'local', visible = true }: { viewer?: string; visible?: boolean } = {}) {
  const [dismissed, setDismissed] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(() => wasDismissed(viewer));
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [unavailable, setUnavailable] = useState(() => runtime().web && typeof document !== 'undefined' && notificationsUnavailable());
  useEffect(() => {
    if (!runtime().web) return;
    const off = onNotificationsUnavailable(() => setUnavailable(true));
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') void prepareBrowserNotifications();
    return off;
  }, []);
  if (!runtime().web || !visible) return null;
  if (unavailable || permission === 'unsupported') return noticeDismissed ? null : <div className="notification-offer" role="status" aria-label="브라우저 알림을 표시할 수 없음">
    <span>{NOTIFICATION_UNAVAILABLE}</span>
    <button aria-label="브라우저 알림 불가 안내 닫기" onClick={() => {
      setNoticeDismissed(true);
      try { window.localStorage.setItem(dismissalKey(viewer), '1'); } catch { /* Dismiss for this visit if storage is blocked. */ }
    }}>닫기</button>
  </div>;
  if (dismissed || permission !== 'default') return null;
  return <div className="notification-offer" aria-label="브라우저 알림 안내">
    <span>다른 화면을 보고 있을 때도 새 알림을 받을까요? <small>이 작업실이 열려 있는 동안만 알립니다.</small></span>
    <button onClick={() => { void Notification.requestPermission().then(value => { setPermission(value); if (value === 'granted') void prepareBrowserNotifications(); }).catch(() => setUnavailable(true)); }}>브라우저 알림 켜기</button>
    <button aria-label="브라우저 알림 안내 닫기" onClick={() => setDismissed(true)}>나중에</button>
  </div>;
}
