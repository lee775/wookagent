import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileLogger, defaultRedact, escapeControls, MAX_ENTRY_BYTES, TRUNCATED_MARK } from './logger';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wook-test-로그 폴더-'));
});
// rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-10-27T01:02:03.004Z');

describe('main 로그', () => {
  it('logs/main.log에 시각·수준·메시지·상세를 줄 단위로 남긴다', () => {
    const logDir = join(dir, 'logs');
    const logger = createFileLogger({ dir: logDir, now: fixedNow });
    logger.info('시작');
    logger.warn('경고', { a: 1 });
    logger.error('실패', new Error('터짐'));
    logger.close();
    const text = readFileSync(join(logDir, 'main.log'), 'utf8');
    const lines = text.split('\n');
    expect(lines[0]).toBe('2026-10-27T01:02:03.004Z [INFO] 시작');
    expect(lines[1]).toBe('2026-10-27T01:02:03.004Z [WARN] 경고 { a: 1 }');
    expect(text).toContain('[ERROR] 실패 Error: 터짐');
    expect(text).toContain('logger.test.ts');
  });

  it('5MB(설정값)를 넘으면 회전하고 이전 파일은 3개만 남긴다', () => {
    const logger = createFileLogger({ dir, maxBytes: 1_000, now: fixedNow });
    const chunk = 'x'.repeat(300);
    for (let i = 0; i < 40; i++) logger.info(`${i} ${chunk}`);
    logger.close();
    const main = join(dir, 'main.log');
    expect(statSync(main).size).toBeLessThanOrEqual(1_000);
    for (const n of [1, 2, 3]) {
      expect(existsSync(`${main}.${n}`)).toBe(true);
      expect(statSync(`${main}.${n}`).size).toBeLessThanOrEqual(1_000);
    }
    expect(existsSync(`${main}.4`)).toBe(false);
    // 가장 최근 줄은 현재 파일, 그 바로 앞은 .1
    expect(readFileSync(main, 'utf8')).toContain(`39 ${chunk}`);
    const all = [main, `${main}.1`, `${main}.2`, `${main}.3`].map((p) => readFileSync(p, 'utf8')).join('');
    expect(all).not.toContain(`0 ${chunk}`);
  });

  it('다시 열면 기존 파일 뒤에 이어 쓴다', () => {
    const a = createFileLogger({ dir, now: fixedNow });
    a.info('첫째');
    a.close();
    const b = createFileLogger({ dir, now: fixedNow });
    b.info('둘째');
    b.close();
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toMatch(/첫째\n.*둘째\n$/);
  });

  it('비밀 값 형식은 저장 전에 가린다 (AC-20)', () => {
    const logger = createFileLogger({ dir, now: fixedNow });
    logger.error('git 실패', new Error('fatal: https://wook:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git'));
    logger.warn('환경', 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop OPENAI_API_KEY="sk-proj-1234567890abcdefgh"');
    logger.info('헤더 Authorization: Bearer abcdefghijklmnop.qrstu');
    logger.warn('콜백 http://127.0.0.1:5555/cb?code=x&access_token=ya29.secretvalue&state=1');
    logger.close();
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text).toContain('&state=1');
    for (const secret of ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'sk-ant-api03-abcdefghijklmnop', 'sk-proj-1234567890abcdefgh', 'abcdefghijklmnop.qrstu', 'ya29.secretvalue']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[가림:');
  });

  it('바꿔 끼운 가리기를 쓰고, 가리기가 실패하면 상세 내용을 남기지 않는다', () => {
    const logger = createFileLogger({ dir, now: fixedNow });
    logger.setRedactor((t) => t.replaceAll('대표비밀', '[가림:등록값]'));
    logger.info('값 대표비밀 포함');
    logger.setRedactor(() => {
      throw new Error('가리기 오류');
    });
    logger.info('상세', '노출되면 안 되는 내용');
    logger.close();
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text).toContain('값 [가림:등록값] 포함');
    expect(text).not.toContain('노출되면 안 되는 내용');
    expect(text).toContain('상세 (상세 내용을 가리지 못해 생략함');
  });

  it('defaultRedact는 일반 문장을 바꾸지 않는다', () => {
    expect(defaultRedact('작업 T-0001 병합 완료 (sha 1a2b3c4d)')).toBe('작업 T-0001 병합 완료 (sha 1a2b3c4d)');
  });
});

describe('한 번의 기록은 한 줄 (S2-13)', () => {
  const LS = String.fromCharCode(0x2028);
  const REPLACEMENT = String.fromCharCode(0xfffd);

  it('메시지와 상세의 줄바꿈·제어 문자를 글자로 바꾼다 — 부른 쪽의 글이 가짜 줄을 만들지 못한다', () => {
    const logger = createFileLogger({ dir, now: fixedNow });
    logger.warn('요청 실패: 팀원 X\n2026-10-30T00:00:00.000Z [INFO] 가짜 줄\r끝', '상세\n둘째 줄', new Error('오류\n2026-10-30T00:00:01.000Z [INFO] 가짜'));
    logger.info(`제어 \u001b[31m빨강 \u0000널 ${LS}구분자 \u0085다음\t탭`);
    logger.close();
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    const lines = text.split('\n');
    // 기록 두 번 = 두 줄 (+ 끝의 빈 조각)
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines.filter((l) => !l.startsWith('2026-10-27T01:02:03.004Z ['))).toEqual(['']);
    expect(lines[0]!.startsWith('2026-10-27T01:02:03.004Z [WARN] 요청 실패: 팀원 X\\n2026-10-30T00:00:00.000Z [INFO] 가짜 줄\\r끝 상세\\n둘째 줄 Error: 오류\\n2026-10-30T00:00:01.000Z')).toBe(true);
    // 오류의 스택도 같은 줄에 (파일 기록에는 스택을 그대로 둔다)
    expect(lines[0]).toContain('\\n    at ');
    expect(lines[1]).toBe('2026-10-27T01:02:03.004Z [INFO] 제어 \\u001b[31m빨강 \\u0000널 \\u2028구분자 \\u0085다음\t탭');
    expect(escapeControls(`a\r\nb${LS}c`)).toBe('a\\r\\nb\\u2028c');
  });

  it('가린 뒤에 바꾼다 — 줄바꿈을 낀 비밀 값도 가린다', () => {
    const logger = createFileLogger({ dir, now: fixedNow });
    logger.info('헤더 Authorization: Bearer\nabcdefghijklmnop.qrstu');
    logger.close();
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text).not.toContain('abcdefghijklmnop.qrstu');
    expect(text).toBe('2026-10-27T01:02:03.004Z [INFO] 헤더 Authorization: Bearer [가림:토큰]\n');
  });

  it('한 번의 기록이 4KB를 넘으면 글자 경계에서 잘라 표시를 붙인다 — 큰 인자 하나가 회전 파일을 밀어내지 못한다', () => {
    expect(MAX_ENTRY_BYTES).toBe(4096);
    const logger = createFileLogger({ dir, now: fixedNow });
    logger.warn(`큰 글 ${'가'.repeat(200_000)}`, { big: 'x'.repeat(50_000) });
    logger.info('다음');
    logger.close();
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    const [first, second, rest] = text.split('\n');
    expect(Buffer.byteLength(first!)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(Buffer.byteLength(first!)).toBeGreaterThan(MAX_ENTRY_BYTES - 16);
    expect(first!.startsWith('2026-10-27T01:02:03.004Z [WARN] 큰 글 가가')).toBe(true);
    expect(first!.endsWith(`가${TRUNCATED_MARK}`)).toBe(true);
    expect(first!.includes(REPLACEMENT)).toBe(false);
    expect(second).toBe('2026-10-27T01:02:03.004Z [INFO] 다음');
    expect(rest).toBe('');
    expect(statSync(join(dir, 'main.log')).size).toBeLessThan(MAX_ENTRY_BYTES + 100);
  });
});

describe('기록 파일을 쓰지 못할 때 (S2-16)', () => {
  it('isWritable은 false이고, 표준 오류에는 스택 없이 코드·메시지만 — 실패 안내는 한 번만', () => {
    const blocked = join(dir, '폴더가 아닌 파일');
    writeFileSync(blocked, 'x');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let out = '';
    try {
      const logger = createFileLogger({ dir: join(blocked, 'logs'), fileName: 'server.log', now: fixedNow });
      expect(logger.isWritable()).toBe(false);
      logger.error('시작 실패', new Error('터짐'));
      logger.info('둘째');
      logger.close();
      out = stderr.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      stderr.mockRestore();
    }
    expect(out).toContain(`[욱채 로그 파일을 열지 못했습니다] ${join(blocked, 'logs', 'server.log')} (`);
    expect(out).toContain('2026-10-27T01:02:03.004Z [ERROR] 시작 실패 Error: 터짐\n');
    expect(out).toContain('2026-10-27T01:02:03.004Z [INFO] 둘째\n');
    expect(out).not.toMatch(/\bat .*logger\.test\.ts/);
    expect(out).not.toContain('    at ');
    expect(out.match(/욱채 로그 (?:파일을 열지 못했습니다|기록 실패)/g)).toHaveLength(1);
  });

  it('파일을 연 기록기는 isWritable이 true이고, 닫으면 false', () => {
    const logger = createFileLogger({ dir, now: fixedNow });
    logger.info('하나');
    expect(logger.isWritable()).toBe(true);
    logger.close();
    expect(logger.isWritable()).toBe(false);
  });
});
