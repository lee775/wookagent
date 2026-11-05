import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAppUrlMatcher, resolveRendererTarget } from './appUrl';

describe('화면 주소 판정', () => {
  it('개발 서버 주소는 패키징되지 않은 실행에서만 쓴다', () => {
    const file = join(tmpdir(), 'renderer', 'index.html');
    expect(resolveRendererTarget({ isPackaged: false, devUrl: 'http://localhost:5173', rendererFile: file })).toEqual({
      kind: 'url',
      url: 'http://localhost:5173/',
      origin: 'http://localhost:5173',
    });
    expect(resolveRendererTarget({ isPackaged: true, devUrl: 'http://localhost:5173', rendererFile: file })).toEqual({
      kind: 'file',
      path: resolve(file),
    });
    expect(resolveRendererTarget({ isPackaged: false, devUrl: undefined, rendererFile: file }).kind).toBe('file');
    expect(() => resolveRendererTarget({ isPackaged: false, devUrl: 'javascript:alert(1)', rendererFile: file })).toThrow();
  });

  it('개발 서버: 같은 origin만 앱 주소다', () => {
    const isApp = createAppUrlMatcher({ kind: 'url', url: 'http://localhost:5173/', origin: 'http://localhost:5173' });
    expect(isApp('http://localhost:5173/')).toBe(true);
    expect(isApp('http://localhost:5173/src/main.tsx?t=1#x')).toBe(true);
    expect(isApp('http://localhost:5174/')).toBe(false);
    expect(isApp('https://localhost:5173/')).toBe(false);
    expect(isApp('https://evil.example/')).toBe(false);
    expect(isApp('not a url')).toBe(false);
  });

  it('파일: 화면 index.html만 앱 주소다 (공백·한글 경로 포함)', () => {
    const file = join(tmpdir(), 'wook-test-앱 폴더', 'out', 'renderer', 'index.html');
    const isApp = createAppUrlMatcher({ kind: 'file', path: file });
    const url = pathToFileURL(file);
    expect(isApp(url.href)).toBe(true);
    expect(isApp(`${url.href}#/settings`)).toBe(true);
    expect(isApp(pathToFileURL(join(tmpdir(), 'wook-test-앱 폴더', 'out', 'renderer', 'other.html')).href)).toBe(false);
    expect(isApp(pathToFileURL(join(tmpdir(), 'dropped.pdf')).href)).toBe(false);
    expect(isApp('file://server/share/index.html')).toBe(false);
    expect(isApp('https://example.com/index.html')).toBe(false);
    expect(isApp('data:text/html,hi')).toBe(false);
  });
});
