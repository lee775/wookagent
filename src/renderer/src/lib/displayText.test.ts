import { describe, expect, it } from 'vitest';
import { snapshot } from '../api/fake/data';
import { resolveDisplayText } from './displayText';

const cases = [
  ['T-0002 산책 장소 데이터 연결: 연결 오류', '산책 장소 데이터 연결: 연결 오류'],
  ['merge: T-0002 병합 보류', '병합: 산책 장소 데이터 연결 병합 보류'],
  ['T-0004 검수 결과 대기', '기록 흐름 검수 검수 결과 대기'],
  ['자동 검사 T-0004: 실패', '자동 검사 기록 흐름 검수: 실패'],
  ['T-0004이(가) 검수 중이라 메시지만 저장했습니다.', '기록 흐름 검수가 검수 중이라 메시지만 저장했습니다.'],
  ['지시 D-0001이(가) 취소됨', '지시 산책 기록 화면 만들기가 취소됨'],
  ['작업 T-0004은(는) 검수 상태가 아닙니다 (in_progress)', '작업 기록 흐름 검수는 검수 상태가 아닙니다 (진행 중)'],
  ['보고서 R-0001 제출: 산책 기록 화면 · 2회차 보고', '보고서 산책 기록 화면 · 2회차 보고 제출'],
  ['T-0002 진행 중 → 검수 중', '산책 장소 데이터 연결 진행 중 → 검수 중'],
  ['T-0002 → main 병합 완료', '산책 장소 데이터 연결 → 기본 브랜치 병합 완료'],
  ['T-0004을(를) 다시 확인', '기록 흐름 검수를 다시 확인'],
  ['파일 변경: C:\\worktrees\\P-0001\\T-0002\\step.md (추가)', '파일 변경: C:\\worktrees\\P-0001\\T-0002\\step.md (추가)'],
] as const;

describe('backend text on owner screens', () => {
  it.each(['파일 변경', '파일 작성', '파일 수정', '파일 노트북 수정', '읽기', '파일 찾기', '내용 검색'])(
    'S4-followup-path. preserves %s paths from CLI parsers', prefix => {
      for (const path of [String.raw`C:\wook-mock\T-0001\main\done.md`, '/wook-mock/T-0001/main/done.md', 'wook-mock/T-0001/main/done.md', String.raw`\\server\wook-mock\T-0001\done.md`]) {
        for (const sub of ['', '[하위] ']) {
          const body = prefix === '파일 찾기' ? `**/*.md (${path})` : prefix === '내용 검색' ? `done (${path})` : path;
          const line = `${sub}${prefix}: ${body}`;
          expect(resolveDisplayText(line, snapshot)).toBe(line);
        }
      }
    },
  );
  it('S4-followup-multiline. preserves path lines while resolving surrounding prose', () => {
    const path = String.raw`파일 작성: C:\wook-mock\T-0001\main\done.md`;
    expect(resolveDisplayText(`T-0002 진행 중\r\n${path}\r\nT-0004 완료`, snapshot))
      .toBe(`산책 장소 데이터 연결 진행 중\r\n${path}\r\n기록 흐름 검수 완료`);
  });
  it.each(['실행 권한 확인 발생 (바이패스 불일치): ', '(같은 오류 반복) '])(
    'S4-followup-permission. preserves Codex rejected paths after %s', prefix => {
      const line = `${prefix}파일 변경이 승인 단계에서 거부되었습니다: C:\\wook-mock\\T-0001\\main\\done.md`;
      expect(resolveDisplayText(line, snapshot)).toBe(line);
    },
  );
  for (const [backend, expected] of cases) {
    it(backend, () => {
      const visible = resolveDisplayText(backend, snapshot);
      expect(visible).toBe(expected);
      if (!backend.startsWith('파일 변경:'))
        expect(visible).not.toMatch(/\b[TDRM]-\d{4}\b|이\(가\)|은\(는\)|을\(를\)|\b(in_progress|in_review|merge:)\b/i);
    });
  }
});
