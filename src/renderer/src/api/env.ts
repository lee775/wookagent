/**
 * 빌드 구분과 개발용 주소 표시 (리드 결정 S8-4).
 * - REMOTE_BUILD: 서버가 내주는 웹 화면 빌드(VITE_WOOK_REMOTE=1). 이 빌드에는 가짜 브리지가 들어가지 않고, 개발·데모용 주소 표시(?officeDemo, ?capture,
 *   ?fakeMode·?fakeSeat 같은 ?fake…, ?perfWalk 등)가 아무 일도 하지 않는다 — 실제 서버 주소에 표시를 붙여도 화면이 데모로 바뀌지 않는다.
 * - devParam: 개발용 주소 표시는 모두 이 함수로 읽는다. 서버 빌드에서는 늘 null이다. ?studio3d=0처럼 대표가 쓰는 화면 선택은 개발용 표시가 아니다.
 */
export const REMOTE_BUILD: boolean = import.meta.env.VITE_WOOK_REMOTE === '1';

export function devParam(name: string): string | null {
  if (REMOTE_BUILD) return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

export function hasDevParam(name: string): boolean {
  return devParam(name) !== null;
}
