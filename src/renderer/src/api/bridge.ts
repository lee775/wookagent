import type { WookBridge } from '../../../shared/ipc';

declare global {
  interface Window { wook?: WookBridge }
}

/**
 * 화면이 쓰는 브리지 (리드 결정 S8-4). 데스크톱은 preload가, 서버가 내준 웹 화면은 install.ts가 원격 브리지를 `window.wook`에 넣는다.
 * 그 밖(dev:web·캡처 도구)에는 install.ts가 가짜 브리지를 동적으로 불러와 여기에 둔다 — `window.wook`에는 넣지 않는다(가짜 브리지와 화면 일부가
 * `!window.wook`을 '개발용 가짜 화면'으로 읽는다). 이 파일은 가짜 브리지를 불러오지 않는다 — 서버용 빌드에 가짜 자료가 묶이지 않게
 */
let fallback: WookBridge | null = null;

export function setFallbackBridge(bridge: WookBridge): void {
  fallback = bridge;
}

export function getBridge(): WookBridge {
  const bridge = window.wook ?? fallback;
  if (!bridge) throw new Error('욱채 브리지가 아직 준비되지 않았습니다 — main.tsx가 화면을 그리기 전에 install.ts의 prepareBridge를 불러야 합니다');
  return bridge;
}
