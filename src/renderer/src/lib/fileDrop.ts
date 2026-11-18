import { MAX_UPLOAD_BYTES } from './uploads';

type DropItem = {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null;
};
export type FileTransfer = {
  types: readonly string[];
  items: ArrayLike<DropItem>;
  files: ArrayLike<File>;
};

/** During dragover the browser protects file contents; only inspect the types. */
export function isFileDrag(data: Pick<FileTransfer, 'types'> | null): boolean {
  return data !== null && Array.from(data.types).includes('Files');
}

/** Read synchronously at drop time, before the browser locks the data store again. */
export function readFileDrop(data: FileTransfer, mode: 'web' | 'desktop') {
  const files: File[] = [];
  const refusals: string[] = [];
  const add = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      refusals.push(`${file.name}: 파일 하나는 50 MB까지 첨부할 수 있습니다.`);
      // Web keeps the same removable error chip as the paperclip upload queue.
      if (mode === 'desktop') return;
    }
    files.push(file);
  };
  const items = Array.from(data.items);
  if (items.length) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        refusals.push(`${entry.name}: 폴더는 첨부할 수 없습니다. 폴더 안의 파일을 골라 주세요.`);
        continue;
      }
      const file = item.getAsFile();
      if (file) add(file);
      else refusals.push('파일을 읽을 수 없습니다. 파일 첨부 버튼으로 다시 골라 주세요.');
    }
  } else {
    for (const file of Array.from(data.files)) add(file);
  }
  return { files, refusals };
}
