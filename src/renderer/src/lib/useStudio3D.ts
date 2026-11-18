import { runtime } from '../api/runtime';

let webgl2Available: boolean | null = null;

/** The company and department offices use the same capability and layout rule. */
export function useStudio3D() {
  if (typeof window === 'undefined' || typeof document === 'undefined' ||
      new URLSearchParams(window.location.search).get('studio3d') === '0') return false;
  if (runtime().web && window.matchMedia?.('(max-width: 760px)').matches &&
      new URLSearchParams(window.location.search).get('studio3d') !== '1') return false;
  if (webgl2Available === null) {
    const context = document.createElement('canvas').getContext('webgl2');
    webgl2Available = !!context;
    context?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return webgl2Available;
}
