/**
 * 화면이 쓸 브리지를 화면 코드보다 먼저 정한다 (리드 결정 S8-4). main.tsx가 이것을 기다린 뒤에야 App을 동적으로 불러오므로, `window.wook`이나 주소
 * 표시를 읽는 모듈은 모두 정해진 브리지를 본다(정적 import는 끌어올려져 main.tsx 본문보다 먼저 돈다).
 * - 서버용 빌드: 원격 브리지를 `window.wook`에 넣는다. 가짜 브리지는 빌드에 묶이지 않는다(vite.web.config.ts가 검사한다)
 * - 데스크톱: preload가 이미 `window.wook`을 넣었다 — 아무것도 하지 않는다
 * - 그 밖(dev:web, 캡처 도구): 가짜 브리지를 동적으로 불러와 bridge.ts의 대신 쓸 브리지로 둔다
 */
import { setFallbackBridge } from './bridge';
import { createRemoteBridge } from './remote';

export async function prepareBridge(): Promise<void> {
  // env.ts의 REMOTE_BUILD와 같은 식을 이 파일 안에 그대로 쓴다 — 빌드가 여기서 상수로 접어야 아래 가짜 브리지 동적 import를 빌드에서 지운다.
  // REMOTE_BUILD를 불러와 쓰면 다른 모듈의 상수라 접히지 않아 가짜 브리지가 따로 조각으로 남는다(빌드 검사가 잡았다)
  if (import.meta.env.VITE_WOOK_REMOTE === '1') {
    window.wook = createRemoteBridge();
    return;
  }
  if (window.wook) return;
  const { fakeBridge } = await import('./fake');
  setFallbackBridge(fakeBridge);
}
