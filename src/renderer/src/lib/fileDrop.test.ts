import { describe, expect, it } from 'vitest';
import { isFileDrag, readFileDrop, type FileTransfer } from './fileDrop';
import { MAX_UPLOAD_BYTES } from './uploads';

const file = (name = 'brief.txt') => new File(['hello'], name);
const item = (value: File) => ({ kind: 'file', getAsFile: () => value });
const text = { kind: 'string', getAsFile: () => null };
const folder = { kind: 'file', getAsFile: () => file('folder'), webkitGetAsEntry: () => ({ isDirectory: true, name: '자료' }) };
const data = (items: FileTransfer['items'] = [], files: File[] = []): FileTransfer => ({ types: ['Files'], items, files });

describe('readFileDrop', () => {
  it('reads files only in their original order', () => {
    const files = [file('a'), file('b')];
    expect(readFileDrop(data(files.map(item)), 'web')).toEqual({ files, refusals: [] });
  });
  it('ignores text only, even when a files fallback is supplied', () => {
    expect(readFileDrop(data([text], [file()]), 'web')).toEqual({ files: [], refusals: [] });
  });
  it('reads files mixed with text without duplicating the files fallback', () => {
    const value = file();
    expect(readFileDrop(data([text, item(value)], [value]), 'web')).toEqual({ files: [value], refusals: [] });
  });
  it('refuses a folder without traversing it or attaching its placeholder File', () => {
    const result = readFileDrop(data([folder], [file('folder')]), 'web');
    expect(result.files).toEqual([]);
    expect(result.refusals.join()).toContain('자료: 폴더는 첨부할 수 없습니다');
  });
  it('keeps files alongside a refused folder in both modes', () => {
    const value = file();
    for (const mode of ['web', 'desktop'] as const) {
      const result = readFileDrop(data([folder, item(value)]), mode);
      expect(result.files).toEqual([value]);
      expect(result.refusals).toHaveLength(1);
    }
  });
  it('handles an empty drop', () => {
    expect(readFileDrop(data(), 'web')).toEqual({ files: [], refusals: [] });
  });
  it('keeps many files without imposing a new count limit', () => {
    const files = Array.from({ length: 120 }, (_, i) => file(String(i)));
    expect(readFileDrop(data(files.map(item)), 'web').files).toEqual(files);
  });
  it('uses the files fallback when the browser has no items', () => {
    const value = file();
    expect(readFileDrop(data([], [value]), 'desktop').files).toEqual([value]);
  });
  it('reports an unreadable file', () => {
    expect(readFileDrop(data([{ kind: 'file', getAsFile: () => null }]), 'desktop').refusals.join()).toContain('읽을 수 없습니다');
  });
  for (const mode of ['web', 'desktop'] as const) {
    it(`keeps exactly 50 MB and handles one byte over the limit in ${mode}`, () => {
      const boundary = file('boundary'); Object.defineProperty(boundary, 'size', { value: MAX_UPLOAD_BYTES });
      const large = file('large'); Object.defineProperty(large, 'size', { value: MAX_UPLOAD_BYTES + 1 });
      const result = readFileDrop(data([item(boundary), item(large)]), mode);
      expect(result.files).toEqual(mode === 'web' ? [boundary, large] : [boundary]);
      expect(result.refusals).toEqual(['large: 파일 하나는 50 MB까지 첨부할 수 있습니다.']);
    });
  }
});
it('only Files triggers the page guard and highlight', () => {
  expect(isFileDrag(null)).toBe(false);
  expect(isFileDrag({ types: [] })).toBe(false);
  expect(isFileDrag({ types: ['text/plain', 'text/uri-list'] })).toBe(false);
  expect(isFileDrag({ types: ['Files', 'text/plain'] })).toBe(true);
});
it('recognizes protected file drags anywhere without reading the locked file store', () => {
  const protectedData = {
    types: ['text/uri-list', 'Files'],
    get items(): FileTransfer['items'] { throw new Error('Protected until drop'); },
    get files(): FileTransfer['files'] { throw new Error('Protected until drop'); },
  };
  expect(isFileDrag(protectedData)).toBe(true);
});
