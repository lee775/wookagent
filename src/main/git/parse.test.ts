import { describe, expect, it } from 'vitest';
import {
  combineDiffStats,
  countLines,
  decodeTruncated,
  hasConflictMarkers,
  isValidRefName,
  looksBinary,
  newFilePatch,
  parseLogZ,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusZ,
  parseWorktreeList,
  unquoteGitPath,
} from './parse';

describe('parseStatusZ', () => {
  it('이름 바뀜 항목의 원래 경로를 건너뛰고 충돌·미추적을 나눈다', () => {
    const out = ['R  새 이름.txt', '옛 이름.txt', ' M a b.txt', 'UU 충돌.txt', '?? 새/파일.txt', '!! 무시.log', ''].join('\0');
    expect(parseStatusZ(out)).toEqual({
      files: [
        { path: '새 이름.txt', code: 'R ' },
        { path: 'a b.txt', code: ' M' },
        { path: '충돌.txt', code: 'UU' },
        { path: '새/파일.txt', code: '??' },
      ],
      untracked: ['새/파일.txt'],
      unmerged: ['충돌.txt'],
    });
    expect(() => parseStatusZ('XYpath\0')).toThrow();
  });
});

describe('parseWorktreeList', () => {
  it('기본 작업 폴더·분리 HEAD·정리 대상·따옴표 경로', () => {
    const out = [
      'worktree C:/프로젝트/앱',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree C:/data/worktrees/T-0001',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/T-0001-로그인',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree "C:/data/review/a\\"b"',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'locked',
      '',
    ].join('\n');
    const list = parseWorktreeList(out);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ path: 'C:/프로젝트/앱', branch: 'refs/heads/main', prunable: false });
    expect(list[1]).toMatchObject({ branch: 'refs/heads/task/T-0001-로그인', prunable: true });
    expect(list[2]).toMatchObject({ path: 'C:/data/review/a"b', detached: true, locked: true, branch: null });
  });

  it('C 스타일 따옴표의 8진수 바이트를 UTF-8로 푼다', () => {
    expect(unquoteGitPath('"\\352\\270\\200 \\t.txt"')).toBe('글 \t.txt');
    expect(unquoteGitPath('plain path')).toBe('plain path');
  });
});

describe('diff 출력', () => {
  it('name-status와 numstat(-z)를 합친다: 이름 바뀜·복사·바이너리', () => {
    const ns = ['M', 'a.txt', 'R087', '옛.txt', '새.txt', 'C100', 'src.txt', 'copy.txt', 'D', 'gone.txt', 'T', 'link', ''].join('\0');
    const num = ['3\t1\ta.txt', '2\t2\t', '옛.txt', '새.txt', '0\t0\t', 'src.txt', 'copy.txt', '0\t4\tgone.txt', '-\t-\tlink', ''].join(
      '\0',
    );
    expect(combineDiffStats(parseNameStatusZ(ns), parseNumstatZ(num))).toEqual([
      { path: 'a.txt', status: 'M', additions: 3, deletions: 1 },
      { path: '새.txt', status: 'R', additions: 2, deletions: 2 },
      { path: 'copy.txt', status: 'A', additions: 0, deletions: 0 },
      { path: 'gone.txt', status: 'D', additions: 0, deletions: 4 },
      { path: 'link', status: 'M', additions: 0, deletions: 0 },
    ]);
  });

  it('log -z 레코드: 본문 끝 공백 제거, 부모 여러 개', () => {
    const out = ['a1\x1fp1 p2\x1f[T-1] 병합\x1f본문\n둘째 줄\n\n', 'p1\x1f\x1f첫 커밋\x1f', ''].join('\0');
    expect(parseLogZ(out)).toEqual([
      { sha: 'a1', parents: ['p1', 'p2'], subject: '[T-1] 병합', body: '본문\n둘째 줄' },
      { sha: 'p1', parents: [], subject: '첫 커밋', body: '' },
    ]);
  });
});

describe('검사 도우미', () => {
  it('ref 이름 규칙 (git check-ref-format)', () => {
    expect(isValidRefName('refs/heads/task/T-0001-로그인')).toBe(true);
    for (const bad of ['refs/heads/a b', 'refs/heads/a..b', 'refs/heads/a.lock', 'refs/heads/.x', 'refs/heads/a/', 'refs/heads/a@{1}', 'refs/heads/a~1', 'refs/heads/a:b', 'refs/heads/a\\b', '@']) {
      expect(isValidRefName(bad)).toBe(false);
    }
  });

  it('충돌 표시는 세 가지가 모두 있어야 한다 (CRLF 포함)', () => {
    expect(hasConflictMarkers('<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> refs/heads/main\r\n')).toBe(true);
    expect(hasConflictMarkers('제목\n=======\n본문\n')).toBe(false);
    expect(hasConflictMarkers('a\n')).toBe(false);
  });

  it('바이너리 판정·줄 수', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(looksBinary(Buffer.from('한글', 'utf8'))).toBe(false);
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });

  it('새 파일 패치 모양', () => {
    expect(newFilePatch('새 파일.txt', '100644', '한 줄')).toBe(
      'diff --git a/새 파일.txt b/새 파일.txt\nnew file mode 100644\n--- /dev/null\n+++ b/새 파일.txt\n@@ -0,0 +1 @@\n+한 줄\n\\ No newline at end of file\n',
    );
    expect(newFilePatch('e.txt', '100644', '')).toBe('diff --git a/e.txt b/e.txt\nnew file mode 100644\n');
    expect(newFilePatch('b.bin', '100644', null)).toContain('Binary files /dev/null and b/b.bin differ');
  });

  it('잘린 출력은 줄 경계, 줄바꿈이 없으면 UTF-8 글자 경계에서 끊는다', () => {
    expect(decodeTruncated(Buffer.from('첫 줄\n둘째', 'utf8'))).toEqual({ text: '첫 줄\n', bytes: Buffer.byteLength('첫 줄\n') });
    const ko = Buffer.from('가나다', 'utf8'); // 9바이트
    expect(decodeTruncated(ko.subarray(0, 7))).toEqual({ text: '가나', bytes: 6 });
    expect(decodeTruncated(ko.subarray(0, 6))).toEqual({ text: '가나', bytes: 6 });
    expect(decodeTruncated(Buffer.from('abc'))).toEqual({ text: 'abc', bytes: 3 });
  });
});
