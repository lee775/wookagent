import type { WebDownloadTarget } from '../../../shared/ipc';
import { getBridge } from '../api/bridge';
import { runtime } from '../api/runtime';
import { call } from '../api/store';

export function FileDownload({ target, path, children }: { target: WebDownloadTarget; path?: string; children: React.ReactNode }) {
  if (runtime().web) {
    const url = getBridge().web?.downloadUrl(target);
    return url ? <a className="file-download" href={url} download>{children}</a> : <span className="muted">내려받을 파일이 없습니다.</span>;
  }
  return path ? <button onClick={() => void call('system.openPath', path).catch(() => undefined)}>{children}</button> : null;
}
