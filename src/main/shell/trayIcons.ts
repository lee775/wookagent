/**
 * 트레이 아이콘 (ENV-10) — 이미지 파일 없이 코드로 그린다. electron에 의존하지 않는 순수 함수.
 * nativeImage.createFromBitmap 은 Skia N32 형식(Windows·macOS·Linux 모두 BGRA 순서, premultiplied alpha)을 받는다.
 */
import type { TrayStatus } from '@shared/views';

export interface IconBitmap {
  width: number;
  height: number;
  scaleFactor: number;
  /** width × height × 4 바이트, BGRA, premultiplied */
  buffer: Buffer;
}

type Rgb = readonly [r: number, g: number, b: number];

export const TRAY_STATUS_COLOR: Readonly<Record<TrayStatus, Rgb>> = {
  normal: [0x22, 0xa3, 0x5a],
  awaiting: [0xf2, 0xb0, 0x1e],
  paused: [0x3b, 0x82, 0xf6],
  error: [0xe5, 0x48, 0x4d],
  emergency: [0xc8, 0x10, 0x2e],
};

const WHITE: Rgb = [0xff, 0xff, 0xff];
/** 픽셀당 4×4 표본 — 원 가장자리를 부드럽게 */
const SUBSAMPLES = 4;
/** 밝은·어두운 작업 표시줄 모두에서 보이도록 가장자리를 조금 어둡게 */
const RING_SHADE = 0.72;

function shade([r, g, b]: Rgb, factor: number): Rgb {
  return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)];
}

/** 정사각형 size×size 아이콘 한 장 */
export function renderTrayIcon(status: TrayStatus, size: number): Buffer {
  if (!Number.isInteger(size) || size < 8 || size > 256) {
    throw new RangeError(`트레이 아이콘 크기가 올바르지 않습니다: ${size}`);
  }
  const fill = TRAY_STATUS_COLOR[status];
  const ring = shade(fill, RING_SHADE);
  const center = size / 2;
  const radius = size * (7 / 16);
  const ringWidth = size / 16;
  const inner = radius - ringWidth;
  // 정지 표시(흰 사각형)는 픽셀 격자에 맞춰 선명하게
  const side = Math.round(size * 0.375);
  const sq0 = (size - side) / 2;
  const sq1 = sq0 + side;
  const stopMark = status === 'emergency';

  const colorAt = (px: number, py: number): Rgb | null => {
    const d2 = (px - center) ** 2 + (py - center) ** 2;
    if (d2 > radius * radius) return null;
    if (stopMark && px >= sq0 && px < sq1 && py >= sq0 && py < sq1) return WHITE;
    return d2 > inner * inner ? ring : fill;
  };

  const samples = SUBSAMPLES * SUBSAMPLES;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const c = colorAt(x + (sx + 0.5) / SUBSAMPLES, y + (sy + 0.5) / SUBSAMPLES);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
      if (covered === 0) continue;
      // 투명 표본이 0으로 더해지므로 평균이 곧 premultiplied 값이다
      const o = (y * size + x) * 4;
      out[o] = Math.round(b / samples);
      out[o + 1] = Math.round(g / samples);
      out[o + 2] = Math.round(r / samples);
      out[o + 3] = Math.round((255 * covered) / samples);
    }
  }
  return out;
}

const cache = new Map<TrayStatus, readonly IconBitmap[]>();

/** 100% 배율 16×16 + 200% 배율 32×32 */
export function trayIconSet(status: TrayStatus): readonly IconBitmap[] {
  const hit = cache.get(status);
  if (hit) return hit;
  const set: readonly IconBitmap[] = [
    { width: 16, height: 16, scaleFactor: 1, buffer: renderTrayIcon(status, 16) },
    { width: 32, height: 32, scaleFactor: 2, buffer: renderTrayIcon(status, 32) },
  ];
  cache.set(status, set);
  return set;
}
