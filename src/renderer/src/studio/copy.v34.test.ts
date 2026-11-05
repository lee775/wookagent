import { describe, expect, it } from 'vitest';
const sources = import.meta.glob<string>(['../api/fake/**/*.{ts,tsx}', '../screens/**/*.{ts,tsx}',
  '../components/**/*.{ts,tsx}', '!**/*.test.ts'], { query: '?raw', import: 'default', eager: true });

describe('owner-facing demo copy', () => {
  it('does not repeat the reference example or broken particle placeholders', () => {
    const banned = ['카페', '공방', '작은 게임', '보고가 도착', '을(를)', '이(가)'];
    const hits = Object.entries(sources).flatMap(([file, content]) => banned.filter(word => content.includes(word))
      .map(word => `${file}: ${word}`));
    expect(hits).toEqual([]);
  });
});
