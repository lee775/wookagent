/**
 * 수와 크기에 상한이 있는 캐시 (리드 결정 S8-26 c) — 넘으면 가장 오래 쓰지 않은 것부터 빼고, 상한이 찼다고 새 것을 받지 않는 일이 없다
 */
import { describe, expect, it } from 'vitest';
import { createBoundedCache } from './boundedCache';

describe('createBoundedCache (S8-26 c)', () => {
  it('수 상한: 넘으면 가장 오래 쓰지 않은 것부터 뺀다 — get은 가장 최근에 쓴 것으로 친다', () => {
    const c = createBoundedCache<string>({ maxEntries: 3, maxBytes: Number.POSITIVE_INFINITY });
    for (const k of ['a', 'b', 'c']) expect(c.set(k, k.toUpperCase())).toBe(true);
    expect(c.get('a')).toBe('A');
    expect(c.set('d', 'D')).toBe(true);
    // b가 가장 오래 쓰지 않은 것 (a는 방금 읽었다)
    expect([c.get('b'), c.get('a'), c.get('c'), c.get('d'), c.size]).toEqual([undefined, 'A', 'C', 'D', 3]);
    expect(c.set('e', 'E')).toBe(true);
    expect([c.get('a'), c.get('e'), c.size]).toEqual([undefined, 'E', 3]);
  });

  it('크기 상한: 합이 넘으면 오래된 것부터 빼서 새 것을 담는다 — 상한보다 큰 하나는 담지 않는다', () => {
    const c = createBoundedCache<number>({ maxEntries: 100, maxBytes: 100 });
    expect([c.set('a', 1, 40), c.set('b', 2, 40), c.bytes]).toEqual([true, true, 80]);
    expect(c.set('c', 3, 40)).toBe(true);
    expect([c.get('a'), c.get('b'), c.get('c'), c.bytes, c.size]).toEqual([undefined, 2, 3, 80, 2]);
    expect(c.set('d', 4, 100)).toBe(true);
    expect([c.get('b'), c.get('c'), c.get('d'), c.bytes, c.size]).toEqual([undefined, undefined, 4, 100, 1]);
    // 하나가 상한보다 크면 담지 않고, 있던 것도 그대로다
    expect([c.fits(100), c.fits(101)]).toEqual([true, false]);
    expect(c.set('big', 9, 101)).toBe(false);
    expect([c.get('big'), c.get('d'), c.bytes]).toEqual([undefined, 4, 100]);
  });

  it('같은 열쇠는 바꾸고 크기 합도 그만큼 바뀐다 — delete도 크기를 돌려준다. 바꾸는 열쇠가 상한보다 커지면 그 열쇠는 빠진다', () => {
    const c = createBoundedCache<string>({ maxEntries: 10, maxBytes: 50 });
    c.set('a', 'v1', 30);
    c.set('b', 'x', 10);
    c.set('a', 'v2', 20);
    expect([c.get('a'), c.bytes, c.size]).toEqual(['v2', 30, 2]);
    c.delete('b');
    c.delete('없음');
    expect([c.get('b'), c.bytes, c.size]).toEqual([undefined, 20, 1]);
    expect(c.set('a', 'v3', 60)).toBe(false);
    expect([c.get('a'), c.bytes, c.size]).toEqual([undefined, 0, 0]);
  });

  it('수가 0이면 아무것도 담지 않는다', () => {
    const c = createBoundedCache<string>({ maxEntries: 0, maxBytes: 100 });
    expect([c.fits(1), c.set('a', 'A', 1), c.size]).toEqual([false, false, 0]);
  });
});
