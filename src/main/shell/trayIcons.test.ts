import { describe, expect, it } from 'vitest';
import type { TrayStatus } from '@shared/views';
import { renderTrayIcon, TRAY_STATUS_COLOR, trayIconSet } from './trayIcons';

const STATUSES: TrayStatus[] = ['normal', 'awaiting', 'paused', 'error', 'emergency'];

function pixel(buf: Buffer, size: number, x: number, y: number): [number, number, number, number] {
  const o = (y * size + x) * 4;
  return [buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!];
}

describe('trayIcons', () => {
  it('상태마다 16×16(배율 1)과 32×32(배율 2) 비트맵을 만든다', () => {
    for (const status of STATUSES) {
      const [x1, x2] = trayIconSet(status);
      expect(x1).toMatchObject({ width: 16, height: 16, scaleFactor: 1 });
      expect(x1!.buffer.length).toBe(16 * 16 * 4);
      expect(x2).toMatchObject({ width: 32, height: 32, scaleFactor: 2 });
      expect(x2!.buffer.length).toBe(32 * 32 * 4);
    }
  });

  it('바이트 순서는 BGRA다 (가운데 픽셀이 상태 색)', () => {
    for (const status of ['normal', 'awaiting', 'paused', 'error'] as const) {
      const [r, g, b] = TRAY_STATUS_COLOR[status];
      expect(pixel(renderTrayIcon(status, 16), 16, 8, 8)).toEqual([b, g, r, 255]);
      expect(pixel(renderTrayIcon(status, 32), 32, 16, 16)).toEqual([b, g, r, 255]);
    }
    // 초록은 G가 가장 크고 R이 가장 작다 → BGRA라면 [1]이 최대, [2]가 최소
    const [b, g, r] = pixel(renderTrayIcon('normal', 16), 16, 8, 8);
    expect(g).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(r);
  });

  it('긴급 정지는 빨간 원 가운데 흰 정지 사각형이 있다', () => {
    const buf = renderTrayIcon('emergency', 32);
    expect(pixel(buf, 32, 16, 16)).toEqual([255, 255, 255, 255]);
    const [r, g, b] = TRAY_STATUS_COLOR.emergency;
    // 사각형(10~21) 바깥, 원 안쪽
    expect(pixel(buf, 32, 16, 7)).toEqual([b, g, r, 255]);
    // 오류 아이콘 가운데에는 흰 사각형이 없다
    expect(pixel(renderTrayIcon('error', 32), 32, 16, 16)).not.toEqual([255, 255, 255, 255]);
  });

  it('모서리는 투명하고 원 가장자리는 부드럽게(중간 알파) 그린다', () => {
    for (const size of [16, 32]) {
      const buf = renderTrayIcon('normal', size);
      expect(pixel(buf, size, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(pixel(buf, size, size - 1, size - 1)).toEqual([0, 0, 0, 0]);
      let partial = 0;
      for (let i = 3; i < buf.length; i += 4) if (buf[i]! > 0 && buf[i]! < 255) partial++;
      expect(partial).toBeGreaterThan(4);
    }
  });

  it('premultiplied alpha: 색 성분이 알파를 넘지 않는다', () => {
    for (const status of STATUSES) {
      for (const size of [16, 32]) {
        const buf = renderTrayIcon(status, size);
        for (let i = 0; i < buf.length; i += 4) {
          const a = buf[i + 3]!;
          expect(buf[i]!).toBeLessThanOrEqual(a);
          expect(buf[i + 1]!).toBeLessThanOrEqual(a);
          expect(buf[i + 2]!).toBeLessThanOrEqual(a);
        }
      }
    }
  });

  it('상태마다 서로 다른 아이콘이다', () => {
    for (const size of [16, 32]) {
      const seen = new Set(STATUSES.map((s) => renderTrayIcon(s, size).toString('hex')));
      expect(seen.size).toBe(STATUSES.length);
    }
  });

  it('잘못된 크기는 거부한다', () => {
    expect(() => renderTrayIcon('normal', 0)).toThrow(RangeError);
    expect(() => renderTrayIcon('normal', 15.5)).toThrow(RangeError);
  });
});
