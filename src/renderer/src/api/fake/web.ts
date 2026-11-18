import type { WebConnectionState, WebResyncInfo, WookWebBridge } from '../../../../shared/ipc';
import { devParam } from '../env';
import { MAX_UPLOAD_BYTES } from '../../lib/uploads';

export function createFakeWeb(): WookWebBridge & { uploaded: Map<string, { name: string; size: number; mime: string }>; watched: Set<string>; setConnection: (state: WebConnectionState) => void; resync: (runChanged?: boolean) => void } {
  const connections = new Set<(state: WebConnectionState) => void>();
  const resyncs = new Set<(info: WebResyncInfo) => void>();
  const watched = new Set<string>();
  const start = Date.now();
  let sequence = 0;
  let uploadsStarted = 0;
  const uploaded = new Map<string, { name: string; size: number; mime: string }>();
  const failures = new Set<string>();
  const uploadAttempts = new Map<string, number>();
  let state: WebConnectionState = devParam('fakeConn') === 'reconnecting'
    ? { status: 'reconnecting', lostAt: start - 8000, attempt: 2, retryAt: start + 30000 }
    : devParam('fakeConn') === 'connecting' ? { status: 'connecting' } : { status: 'open', runId: 'fake-run', since: start };
  return {
    uploaded,
    watched,
    setConnection(next) { state = next; connections.forEach(cb => cb(state)); },
    resync(runChanged = false) { resyncs.forEach(cb => cb({ runId: 'fake-run', runChanged })); },
    onConnection(cb) { connections.add(cb); cb(state); return () => { connections.delete(cb); }; },
    async watchMembers(ids) { watched.clear(); for (const id of ids) { if (watched.size >= 50) break; watched.add(id); } await Promise.resolve(); },
    onResync(cb) { resyncs.add(cb); return () => { resyncs.delete(cb); }; },
    upload(file, name, options) {
      return new Promise((resolve, reject) => {
        if (file.size > MAX_UPLOAD_BYTES) { reject(Object.assign(new Error('파일 하나는 50 MB까지 올릴 수 있습니다.'), { code: 'too_large' })); return; }
        let sent = 0;
        const attempt = (uploadAttempts.get(name) ?? 0) + 1; uploadAttempts.set(name, attempt);
        const ordinal = ++uploadsStarted;
        const fail = (devParam('fakeUpload') === 'fail' || devParam('fakeUpload') === 'mixed' && ordinal % 2 === 0) && !failures.has(name);
        const limited = devParam('fakeUpload') === 'rate_limited' && attempt <= 3;
        const delay = devParam('fakeUpload') === 'slow' ? 2500 : 160;
        const finish = (error?: Error) => {
          clearInterval(timer); options?.signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else {
            const uploadId = `U-fake-${++sequence}`;
            uploaded.set(uploadId, { name, size: file.size, mime: file.type });
            resolve({ uploadId, name, size: file.size, expiresAt: new Date(Date.now() + 86400000).toISOString() });
          }
        };
        const abort = () => finish(Object.assign(new Error('업로드를 취소했습니다.'), { code: 'aborted' }));
        const timer = setInterval(() => {
          sent = Math.min(file.size, sent + Math.max(1, Math.ceil(file.size / 5)));
          options?.onProgress?.(sent, file.size);
          if (limited) finish(Object.assign(new Error('다른 파일을 올리는 중입니다. 잠시 뒤 다시 올려 주세요.'), { code: 'rate_limited', retryAfterSec: 5 }));
          else if (fail) { failures.add(name); finish(Object.assign(new Error('연결이 끊겨 파일을 올리지 못했습니다. 다시 올려 주세요.'), { code: 'network' })); }
          else if (sent >= file.size) finish();
        }, delay);
        options?.signal?.addEventListener('abort', abort, { once: true });
        if (options?.signal?.aborted) abort();
      });
    },
    downloadUrl(target) {
      if (target.kind === 'attachment' && target.id === 'A-9001') return 'data:text/plain;charset=utf-8,' + encodeURIComponent('모바일 화면 확인\n버튼 간격, 긴 제목, 파일 첨부를 확인해 주세요.');
      if (target.kind === 'attachment') return /^A-\d+$/.test(target.id) ? `/api/attachments/${target.id}` : null;
      if (target.kind === 'reportFile') return /^R-\d+$/.test(target.reportId) ? `/api/reports/${target.reportId}/file` : null;
      const name = target.path.split(/[\\/]/).pop();
      return name && !name.includes('..') ? `/api/exports/${encodeURIComponent(name)}` : null;
    },
  };
}
