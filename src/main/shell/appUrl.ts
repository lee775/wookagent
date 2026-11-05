/** 화면(renderer) 주소 판정 — 이동 차단과 IPC 발신자 확인에 같은 규칙을 쓴다 */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type RendererTarget = { kind: 'url'; url: string; origin: string } | { kind: 'file'; path: string };

/** 개발 서버 주소는 패키징되지 않은 실행에서만 따른다 (환경 변수로 외부 주소를 띄우지 못하게) */
export function resolveRendererTarget(opts: { isPackaged: boolean; devUrl: string | undefined; rendererFile: string }): RendererTarget {
  if (!opts.isPackaged && opts.devUrl) {
    const parsed = new URL(opts.devUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`개발 서버 주소 형식이 올바르지 않습니다: ${opts.devUrl}`);
    }
    return { kind: 'url', url: parsed.href, origin: parsed.origin };
  }
  return { kind: 'file', path: resolve(opts.rendererFile) };
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function createAppUrlMatcher(target: RendererTarget): (url: string) => boolean {
  if (target.kind === 'url') {
    return (url) => {
      try {
        return new URL(url).origin === target.origin;
      } catch {
        return false;
      }
    };
  }
  const expected = fileURLToPath(pathToFileURL(target.path));
  return (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
      return samePath(fileURLToPath(parsed), expected);
    } catch {
      return false;
    }
  };
}
