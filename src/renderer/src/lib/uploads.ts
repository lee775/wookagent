import type { SendCommandInput, WookWebBridge } from '../../../shared/ipc';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
type UploadState = { kind: 'queued'; retry: number } | { kind: 'uploading'; percent: number } |
  { kind: 'error'; message: string } | { kind: 'ready'; uploadId: string };
export type UploadChip = { id: number; name: string; file: Blob; state: UploadState };

/** One queue per composer; removing a chip aborts it and releases its slot only once. */
export class UploadQueue {
  private items: UploadChip[] = [];
  private active = new Map<number, AbortController>();
  private retries = new Map<number, number>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private sequence = 0;
  private disposed = false;
  constructor(private web: WookWebBridge, private changed: (chips: UploadChip[]) => void) {}
  add(files: readonly { file: Blob; name: string }[]) {
    this.items.push(...files.map(({ file, name }) => ({ id: ++this.sequence, file, name,
      state: file.size > MAX_UPLOAD_BYTES
        ? { kind: 'error', message: '파일 하나는 50 MB까지 올릴 수 있습니다.' } as const
        : { kind: 'queued', retry: 0 } as const })));
    this.publish(); this.pump();
  }
  remove(id: number) {
    this.items = this.items.filter(item => item.id !== id); this.active.get(id)?.abort();
    clearTimeout(this.timers.get(id)); this.timers.delete(id); this.retries.delete(id); this.publish();
  }
  retry(id: number) {
    this.retries.delete(id);
    this.items = this.items.map(item => item.id === id && item.state.kind === 'error' && item.file.size <= MAX_UPLOAD_BYTES ? { ...item, state: { kind: 'queued', retry: 0 } } : item);
    this.publish(); this.pump();
  }
  clear() {
    this.items = []; this.active.forEach(controller => controller.abort());
    this.timers.forEach(timer => clearTimeout(timer)); this.timers.clear(); this.retries.clear(); this.publish();
  }
  dispose() { this.disposed = true; this.clear(); }
  private publish() { if (!this.disposed) this.changed([...this.items]); }
  private update(id: number, state: UploadState) {
    this.items = this.items.map(item => item.id === id ? { ...item, state } : item); this.publish();
  }
  private pump() {
    if (this.disposed) return;
    for (const item of this.items.filter(item => item.state.kind === 'queued')) {
      if (this.active.size >= 3) break;
      if (this.timers.has(item.id) || this.active.has(item.id)) continue;
      const controller = new AbortController(); this.active.set(item.id, controller);
      this.update(item.id, { kind: 'uploading', percent: 0 });
      void this.web.upload(item.file, item.name, { signal: controller.signal, onProgress: (sent, total) => {
        this.update(item.id, { kind: 'uploading', percent: total > 0 ? Math.min(100, Math.round(sent / total * 100)) : 0 });
      } }).then(value => this.update(item.id, { kind: 'ready', uploadId: value.uploadId }))
        .catch((error: unknown) => {
          if (this.disposed || !this.items.some(chip => chip.id === item.id)) return;
          if (error && typeof error === 'object' && 'code' in error) {
            if (error.code === 'unauthorized') window.dispatchEvent(new Event('wook:unauthorized'));
            const retry = this.retries.get(item.id) ?? 0;
            if (error.code === 'rate_limited' && retry < 3) {
              const retryAfter = 'retryAfterSec' in error && typeof error.retryAfterSec === 'number' && Number.isFinite(error.retryAfterSec) && error.retryAfterSec >= 0 ? error.retryAfterSec * 1000 : 5000;
              const delay = retry === 0 ? 300 : retry === 1 ? 1000 : retryAfter;
              this.retries.set(item.id, retry + 1);
              this.timers.set(item.id, setTimeout(() => { this.timers.delete(item.id); this.pump(); }, delay));
              this.update(item.id, { kind: 'queued', retry: retry + 1 });
              return;
            }
          }
          this.update(item.id, { kind: 'error', message: error instanceof Error ? error.message : '파일을 올리지 못했습니다. 다시 시도해 주세요.' });
        })
        .finally(() => { this.active.delete(item.id); this.pump(); });
    }
  }
}

/** Construct a fresh wire value: file paths and data URLs cannot leak into web commands. */
export function webCommandAttachments(chips: readonly UploadChip[]): NonNullable<SendCommandInput['attachments']> {
  return chips.map(item => {
    if (item.state.kind !== 'ready') throw new Error('첨부 파일을 모두 올린 뒤 보내 주세요.');
    return { name: item.name, uploadId: item.state.uploadId };
  });
}
