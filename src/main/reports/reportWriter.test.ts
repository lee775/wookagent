import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRedactor } from '@core/redact';
import type { ReportSections, ReportStats } from '@shared/domain';
import {
  ReportFileError,
  formatDuration,
  formatKst,
  formatUsd,
  renderReportMarkdown,
  reportRelativePath,
  writeReportFile,
} from './reportWriter';

const sections = (over: Partial<ReportSections> = {}): ReportSections => ({
  summary: '로그인 화면을 만들었습니다.\n구글 계정으로 들어갈 수 있습니다.',
  results: '- 로그인 버튼 추가\n- 대표 등록 처리',
  changedFiles: ['src/main/auth/googleAuth.ts', 'src/renderer/src/Login.tsx'],
  howToVerify: '1. 프로그램을 켭니다.\n2. [구글로 로그인]을 누릅니다.',
  issues: '',
  nextSteps: '로그아웃 화면 정리',
  ...over,
});
const stats = (over: Partial<ReportStats> = {}): ReportStats => ({
  taskCount: 3,
  rejectCount: 1,
  durationSec: 3725,
  inputTokens: 12345,
  outputTokens: 6789,
  costUsd: 0.42,
  ...over,
});
// 소스에 키 모양 문자열이 남지 않도록 조립한다 (가짜 값)
const FAKE_KEY = ['sk', 'ant', 'api03', 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7Zx9Yw8Vu7'].join('-');

describe('renderReportMarkdown', () => {
  it('기획서 6.2 양식대로 만든다', () => {
    const md = renderReportMarkdown({
      title: '로그인 화면',
      projectName: '욱채 프로그램',
      directiveId: 'D-0001',
      round: 2,
      createdAt: '2026-10-27T15:30:00.000Z',
      sections: sections(),
      stats: stats(),
    });
    expect(md).toBe(
      [
        '# 로그인 화면',
        '',
        '- 프로젝트: 욱채 프로그램',
        '- 지시 ID: D-0001',
        '- 회차: 2회차',
        '- 작성 시각: 2026-10-28 00:30 (KST)',
        '',
        '## 요약',
        '',
        '로그인 화면을 만들었습니다.',
        '구글 계정으로 들어갈 수 있습니다.',
        '',
        '## 결과',
        '',
        '- 로그인 버튼 추가',
        '- 대표 등록 처리',
        '',
        '### 변경 파일',
        '',
        '- `src/main/auth/googleAuth.ts`',
        '- `src/renderer/src/Login.tsx`',
        '',
        '## 확인 방법',
        '',
        '1. 프로그램을 켭니다.',
        '2. [구글로 로그인]을 누릅니다.',
        '',
        '## 이슈·리스크',
        '',
        '없음',
        '',
        '## 다음 할 일',
        '',
        '로그아웃 화면 정리',
        '',
        '## 작업 통계',
        '',
        '| 항목 | 값 |',
        '| --- | --- |',
        '| 작업 수 | 3개 |',
        '| 반려 횟수 | 1회 |',
        '| 소요 시간 | 1시간 2분 |',
        '| 사용량 | 입력 12,345 토큰 · 출력 6,789 토큰 · 비용 $0.42 |',
        '',
      ].join('\n'),
    );
  });

  it('직접 명령·빈 항목·비용 없음·변경 파일 없음', () => {
    const md = renderReportMarkdown({
      title: '  PC 정리\n결과  ',
      projectName: '',
      directiveId: null,
      round: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      sections: sections({ summary: '   ', results: '', changedFiles: [], howToVerify: '', nextSteps: '' }),
      stats: stats({ costUsd: null, durationSec: 0, taskCount: 0, rejectCount: 0, inputTokens: 0, outputTokens: 0 }),
    });
    expect(md).toContain('# PC 정리 결과\n');
    expect(md).toContain('- 프로젝트: 일반\n');
    expect(md).toContain('- 지시 ID: 없음 (메인 에이전트 직접 명령)\n');
    expect(md).toContain('## 요약\n\n내용 없음\n');
    expect(md).toContain('### 변경 파일\n\n- 없음\n');
    expect(md).toContain('## 다음 할 일\n\n없음\n');
    expect(md).toContain('| 소요 시간 | 0초 |');
    expect(md).toContain('| 사용량 | 입력 0 토큰 · 출력 0 토큰 |');
    expect(md).not.toContain('비용');
  });

  it('항목 안의 제목은 두 단계 낮추고, 닫히지 않은 코드 블록은 닫고, CRLF는 LF로 바꾼다', () => {
    const md = renderReportMarkdown({
      title: 't',
      projectName: 'p',
      directiveId: 'D-0002',
      round: 1,
      createdAt: '2026-10-27T00:00:00.000Z',
      sections: sections({
        results: '# 큰 제목\r\n## 작은 제목\r\n밑줄 제목\r\n---\r\n```ts\r\n# 코드 안 주석\r\nconst a = 1;',
      }),
      stats: stats(),
    });
    expect(md).not.toContain('\r');
    expect(md).toContain('### 큰 제목\n#### 작은 제목\n#### 밑줄 제목\n```ts\n# 코드 안 주석\nconst a = 1;\n```\n\n### 변경 파일');
  });

  it('변경 파일 목록은 중복을 빼고 백틱이 있는 이름도 깨지지 않게 감싼다', () => {
    const md = renderReportMarkdown({
      title: 't',
      projectName: 'p',
      directiveId: 'D-1',
      round: 1,
      createdAt: '2026-10-27T00:00:00.000Z',
      sections: sections({ changedFiles: ['a.ts', 'a.ts', 'we`ird.md', '', '폴더 이름/파일.md'] }),
      stats: stats(),
    });
    expect(md).toContain('### 변경 파일\n\n- `a.ts`\n- `` we`ird.md ``\n- `폴더 이름/파일.md`\n\n');
  });

  it('AC-20: 보고서 안의 테스트용 API 키를 가린다 (기본 가리개 + 등록 값 가리개)', () => {
    const base = {
      title: `키 ${FAKE_KEY} 점검`,
      projectName: 'p',
      directiveId: 'D-1',
      round: 1,
      createdAt: '2026-10-27T00:00:00.000Z',
      sections: sections({
        results: `환경 변수 ANTHROPIC_API_KEY=${FAKE_KEY} 로 실행했습니다.`,
        howToVerify: `curl -H "x-api-key: ${FAKE_KEY}" https://api.anthropic.com/v1/models`,
        changedFiles: [`.env (${FAKE_KEY})`],
      }),
      stats: stats(),
    };
    const md = renderReportMarkdown(base);
    expect(md).not.toContain(FAKE_KEY);
    expect(md).not.toContain(FAKE_KEY.slice(15, 45));
    expect(md).toContain('[가림:Anthropic 키]');

    const red = createRedactor({ extraSecrets: ['owner-only-value-77'] });
    const md2 = renderReportMarkdown({ ...base, sections: sections({ issues: '등록 값 owner-only-value-77 노출 주의' }), redactor: red });
    expect(md2).not.toContain('owner-only-value-77');
    expect(md2).toContain('등록 값 [가림:등록 값] 노출 주의');
  });

  it('회차가 1 이상의 정수가 아니거나 시각이 잘못되면 거부한다', () => {
    const input = { title: 't', projectName: 'p', directiveId: null, round: 1, createdAt: '2026-10-27T00:00:00.000Z', sections: sections(), stats: stats() };
    expect(() => renderReportMarkdown({ ...input, round: 0 })).toThrow(ReportFileError);
    expect(() => renderReportMarkdown({ ...input, round: 1.5 })).toThrow('회차');
    expect(() => renderReportMarkdown({ ...input, createdAt: 'not-a-date' })).toThrow('작성 시각');
  });
});

describe('표기 도우미', () => {
  it.each([
    [0, '0초'],
    [45, '45초'],
    [59.6, '1분'],
    [60, '1분'],
    [330, '5분 30초'],
    [3600, '1시간'],
    [3725, '1시간 2분'],
    [90061, '1일 1시간 1분'],
    [172800, '2일'],
    [-1, '알 수 없음'],
    [Number.NaN, '알 수 없음'],
  ])('formatDuration(%s) = %s', (sec, expected) => {
    expect(formatDuration(sec)).toBe(expected);
  });

  it.each([
    [0, '$0.00'],
    [0.42, '$0.42'],
    [0.0042, '$0.0042'],
    [12.3456, '$12.35'],
    [1234.5, '$1,234.50'],
  ])('formatUsd(%s) = %s', (cost, expected) => {
    expect(formatUsd(cost)).toBe(expected);
  });

  it('formatKst는 한국 시각으로 바꾼다', () => {
    expect(formatKst('2026-12-31T15:00:00.000Z')).toBe('2027-01-01 00:00 (KST)');
    expect(formatKst('2026-10-27T03:04:59.999Z')).toBe('2026-10-27 12:04 (KST)');
  });
});

describe('reportRelativePath', () => {
  const base = { projectName: '욱채 프로그램', directiveId: 'D-0001', title: '로그인 화면 개선', round: 2, createdAt: '2026-10-27T01:00:00.000Z' };

  it('프로젝트/연-월/날짜_지시ID_제목_v회차.md', () => {
    expect(reportRelativePath(base)).toBe('욱채 프로그램/2026-10/2026-10-27_D-0001_로그인-화면-개선_v2.md');
  });

  it('직접 명령은 일반 폴더와 "직접"을 쓴다', () => {
    expect(reportRelativePath({ ...base, projectName: null, directiveId: null, round: 1 })).toBe('일반/2026-10/2026-10-27_직접_로그인-화면-개선_v1.md');
  });

  it('날짜는 한국 날짜 기준이고 시간대를 바꿀 수 있다', () => {
    const at = { ...base, createdAt: '2026-10-31T15:30:00.000Z' };
    expect(reportRelativePath(at)).toBe('욱채 프로그램/2026-11/2026-11-01_D-0001_로그인-화면-개선_v2.md');
    expect(reportRelativePath({ ...at, timeZone: 'UTC' })).toBe('욱채 프로그램/2026-10/2026-10-31_D-0001_로그인-화면-개선_v2.md');
  });

  it('Windows에서 못 쓰는 글자·끝의 점과 공백·예약 이름을 정리한다', () => {
    const p = reportRelativePath({ ...base, projectName: ' CON ', title: 'a<b>c:d"e/f\\g|h?i*j\u0001k\u200b.  ...' });
    expect(p).toBe('_CON/2026-10/2026-10-27_D-0001_a-b-c-d-e-f-g-h-i-j-k_v2.md');
    expect(reportRelativePath({ ...base, projectName: 'com1.backup' }).split('/')[0]).toBe('_com1.backup');
    expect(reportRelativePath({ ...base, projectName: 'LPT9' }).split('/')[0]).toBe('_LPT9');
    expect(reportRelativePath({ ...base, projectName: '..\\..\\밖' }).split('/')[0]).toBe('밖');
    expect(reportRelativePath({ ...base, projectName: '???' }).split('/')[0]).toBe('프로젝트');
    expect(reportRelativePath({ ...base, title: '...' })).toContain('_D-0001_보고서_v2.md');
  });

  it('제목은 60자(코드 포인트)까지, 이모지·한국어가 깨지지 않는다', () => {
    const title = '가'.repeat(59) + '😀😀😀';
    const p = reportRelativePath({ ...base, title });
    const titlePart = p.split('_').slice(2, -1).join('_');
    expect(Array.from(titlePart)).toHaveLength(60);
    expect(titlePart.endsWith('가😀')).toBe(true);
    expect(p).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('제목 속 비밀 값도 가린다', () => {
    expect(reportRelativePath({ ...base, title: `점검 ${FAKE_KEY}` })).toBe('욱채 프로그램/2026-10/2026-10-27_D-0001_점검-[가림-Anthropic-키]_v2.md');
  });

  it('잘못된 회차·시각·시간대는 거부한다', () => {
    expect(() => reportRelativePath({ ...base, round: 0 })).toThrow(ReportFileError);
    expect(() => reportRelativePath({ ...base, createdAt: '' })).toThrow('작성 시각');
    expect(() => reportRelativePath({ ...base, timeZone: 'Mars/Olympus' })).toThrow('시간대');
  });
});

describe('writeReportFile', () => {
  let root: string;
  let reports: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-보고서 폴더 '));
    reports = path.join(root, 'app data', 'reports');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const listAll = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) out.push(path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/'));
    }
    return out.sort();
  };

  it('폴더를 만들고 UTF-8·LF로 저장해 절대 경로를 돌려준다', async () => {
    const rel = reportRelativePath({ projectName: '욱채 프로그램', directiveId: 'D-0001', title: '첫 보고', round: 1, createdAt: '2026-10-27T01:00:00.000Z' });
    const out = await writeReportFile(reports, rel, '# 제목\r\n\r\n본문 한글\r\n끝');
    expect(out).toBe(path.join(reports, '욱채 프로그램', '2026-10', '2026-10-27_D-0001_첫-보고_v1.md'));
    const bytes = await readFile(out);
    expect(bytes[0]).not.toBe(0xef); // BOM 없음
    expect(bytes.toString('utf8')).toBe('# 제목\n\n본문 한글\n끝\n');
    expect(await listAll(reports)).toEqual(['욱채 프로그램/2026-10/2026-10-27_D-0001_첫-보고_v1.md']);
  });

  it('기본은 기존 보고서를 덮어쓰지 않고 -2, -3을 붙인다', async () => {
    const rel = '일반/2026-10/2026-10-27_직접_답변_v1.md';
    const a = await writeReportFile(reports, rel, 'A');
    const b = await writeReportFile(reports, rel, 'B');
    const c = await writeReportFile(reports, rel, 'C');
    expect(path.basename(a)).toBe('2026-10-27_직접_답변_v1.md');
    expect(path.basename(b)).toBe('2026-10-27_직접_답변_v1-2.md');
    expect(path.basename(c)).toBe('2026-10-27_직접_답변_v1-3.md');
    expect([await readFile(a, 'utf8'), await readFile(b, 'utf8'), await readFile(c, 'utf8')]).toEqual(['A\n', 'B\n', 'C\n']);
    expect((await listAll(reports)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('동시에 같은 경로로 저장해도 서로 덮어쓰지 않는다', async () => {
    const rel = 'p/2026-10/2026-10-27_D-1_t_v1.md';
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => writeReportFile(reports, rel, `내용 ${i}`)));
    expect(new Set(outs).size).toBe(6);
    const contents = await Promise.all(outs.map((o) => readFile(o, 'utf8')));
    expect(contents.sort()).toEqual(Array.from({ length: 6 }, (_, i) => `내용 ${i}\n`).sort());
    expect((await listAll(reports)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('overwrite: true면 같은 파일을 원자적으로 교체한다', async () => {
    const rel = 'p/2026-10/2026-10-27_D-1_t_v1.md';
    const a = await writeReportFile(reports, rel, '처음');
    const b = await writeReportFile(reports, rel, '다시', { overwrite: true });
    expect(b).toBe(a);
    expect(await readFile(a, 'utf8')).toBe('다시\n');
    expect(await listAll(reports)).toEqual(['p/2026-10/2026-10-27_D-1_t_v1.md']);
  });

  it.each([
    ['../밖.md'],
    ['p/../../밖.md'],
    ['C:\\Windows\\x.md'],
    ['C:x.md'],
    ['\\\\server\\share\\x.md'],
    ['/etc/x.md'],
    [''],
    ['   '],
    ['p/CON/x.md'],
    ['p/nul.md'],
    ['p/a:b.md'],
    ['p/끝점./x.md'],
    ['p/x.md\0'],
  ])('보고서 폴더 밖·잘못된 경로는 거부한다: %j', async (rel) => {
    await expect(writeReportFile(reports, rel, 'x')).rejects.toBeInstanceOf(ReportFileError);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('폴더 연결(정션·심볼릭 링크)로 밖을 가리키면 거부한다', async () => {
    const outside = path.join(root, '밖 폴더');
    await mkdir(outside, { recursive: true });
    await mkdir(reports, { recursive: true });
    await symlink(outside, path.join(reports, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeReportFile(reports, 'link/x.md', 'x')).rejects.toMatchObject({ code: 'outside_base' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('저장 경로에 파일이 있어 폴더를 못 만들면 io 오류', async () => {
    await mkdir(reports, { recursive: true });
    await writeFile(path.join(reports, 'p'), 'file');
    await expect(writeReportFile(reports, 'p/x.md', 'x')).rejects.toMatchObject({ code: 'io' });
  });
});
