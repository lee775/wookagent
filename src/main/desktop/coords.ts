/**
 * 캡처 좌표 ↔ 실제 좌표 (SERVER_DESIGN 8.3.3·8.3.4, 리드 결정 S6-6). 메인은 캡처 이미지의 픽셀로 말하고, 도우미는 늘 실제 픽셀(가상 화면 좌표 — 왼쪽·위
 * 모니터는 음수)로 받는다. 줄인 캡처의 한 픽셀은 실제 픽셀 여러 개를 덮으므로 그 가운데를 고른다:
 *
 *   real = origin + min(size − 1, floor((p + 0.5) · size ÷ imageSize))     (축마다)
 *
 * 그래서 이미지의 첫 픽셀은 찍은 영역 안의 첫 칸 근처, 마지막 픽셀은 영역 안의 마지막 칸이다 — 영역 밖(옆 모니터)으로 나가지 않는다. DPI는 따로 보지 않는다:
 * 도우미가 PER_MONITOR_AWARE_V2라 모니터 위치·크기가 이미 실제 픽셀이다(S6-4).
 */

/** 캡처 한 장의 좌표 틀 (gui_actions의 캡처 기록과 같은 칸) */
export interface CaptureFrame {
  /** 이미지 크기 */
  width: number;
  height: number;
  /** 찍은 영역의 왼쪽 위 (실제 픽셀, 음수 가능) */
  originX: number;
  originY: number;
  /** 찍은 영역의 실제 크기 */
  realWidth: number;
  realHeight: number;
}

/** 한 축: 이미지 좌표 p(0 ≤ p < imageSize) → 실제 좌표 */
export function toRealAxis(p: number, imageSize: number, origin: number, size: number): number {
  return origin + Math.min(size - 1, Math.floor(((p + 0.5) * size) / imageSize));
}

/** 이미지 좌표가 그 캡처 안인지 (정수, 0 ≤ x < 폭, 0 ≤ y < 높이) */
export function insideCapture(f: CaptureFrame, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < f.width && y < f.height;
}

/** 이미지 좌표 → 실제 좌표 (안인지는 insideCapture로 먼저 본다) */
export function toReal(f: CaptureFrame, x: number, y: number): { x: number; y: number } {
  return { x: toRealAxis(x, f.width, f.originX, f.realWidth), y: toRealAxis(y, f.height, f.originY, f.realHeight) };
}

/** 실제 좌표 → 그 캡처의 이미지 좌표 (글 정보만 받는 보유자의 창 위치 — 영역 밖이면 이미지 끝으로 붙인다) */
export function toImage(f: CaptureFrame, x: number, y: number): { x: number; y: number } {
  const ax = Math.floor(((x - f.originX) * f.width) / f.realWidth);
  const ay = Math.floor(((y - f.originY) * f.height) / f.realHeight);
  return { x: Math.max(0, Math.min(f.width, ax)), y: Math.max(0, Math.min(f.height, ay)) };
}

/** 실제 사각형 → 이미지 사각형 (잘라서). 캡처와 겹치지 않으면 null */
export function rectToImage(f: CaptureFrame, r: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
  const a = toImage(f, r.x, r.y);
  const b = toImage(f, r.x + r.width, r.y + r.height);
  const w = b.x - a.x;
  const h = b.y - a.y;
  return w > 0 && h > 0 ? { x: a.x, y: a.y, width: w, height: h } : null;
}

/** 이미지 픽셀 하나가 덮는 실제 픽셀 수 (실제 폭 ÷ 이미지 폭, 소수 셋째 자리까지) — 1이면 줄이지 않았다 */
export function captureScale(f: CaptureFrame): number {
  return Math.round((f.realWidth / f.width) * 1000) / 1000;
}
