import { describe, expect, it } from 'vitest';
import { snapshot } from '../api/fake/data';
import { resolveDisplayText } from '../lib/displayText';

describe('owner-facing backend messages', () => {
  it('resolves ids in the formats emitted by the real backend', () => {
    const messages = [
      'T-0004 진행 중 → 검수 중 · M-0005',
      '보고서 R-0001 제출',
      '작업 생성 T-0005 · 검수 M-0021',
      'D-0001 진행 중 · P-0001',
      '자동 검사 t-0004 실패',
    ];
    for (const message of messages)
      expect(resolveDisplayText(message, snapshot)).not.toMatch(/\b[TDRPM]-\d{4}\b/i);
  });
});
