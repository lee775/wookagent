import { describe, expect, it } from 'vitest';
import { abbreviateArg, buildChildEnv, displayCommand, INHERITED_SESSION_VARS, isUuid } from './common';

describe('buildChildEnv', () => {
  it('Windows: 부모 CLI 세션 표시 변수를 대소문자 무관하게 지우고, 같은 이름(다른 대소문자)의 값은 하나로 덮어쓴다', () => {
    const env = buildChildEnv({ Path: 'C:\\A', claudecode: '1', Claude_Code_Child_Session: '1', CODEX_SANDBOX: 'seatbelt', KEEP: 'x', EMPTY: undefined }, { PATH: 'C:\\B', NEW: 'y' }, 'win32');
    expect(env).toEqual({ KEEP: 'x', PATH: 'C:\\B', NEW: 'y' });
  });

  it('POSIX: 이름은 대소문자를 구분한다', () => {
    const env = buildChildEnv({ PATH: '/bin', claudecode: '1', CLAUDECODE: '1' }, {}, 'darwin');
    expect(env).toEqual({ PATH: '/bin', claudecode: '1' });
  });

  it('지우는 목록에 Claude 자식 세션 표시와 앱 토큰이 들어 있다', () => {
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'WOOK_MCP_TOKEN']) expect(INHERITED_SESSION_VARS).toContain(k);
  });
});

describe('표시용 명령', () => {
  it('공백·따옴표가 있는 인자만 감싼다', () => {
    expect(displayCommand('C:\\Program Files\\x.exe', ['-p', 'a b', 'say "hi"', ''], 12)).toBe('"C:\\Program Files\\x.exe" -p "a b" "say \\"hi\\"" "" < 표준 입력(12자)');
    expect(displayCommand('codex', ['exec', '-'], null)).toBe('codex exec -');
  });
  it('긴 값 줄이기', () => {
    expect(abbreviateArg('abc', 5)).toBe('abc');
    expect(abbreviateArg('abcdefgh', 5)).toBe('abcde…(8자)');
  });
  it('UUID 확인', () => {
    expect(isUuid('0f8e3a52-1b7c-4d1e-9a3f-2b6c8d9e0a1b')).toBe(true);
    expect(isUuid('01a17c5f-3171-75a0-b0c0-ef0b38838ec1')).toBe(true);
    expect(isUuid('abc')).toBe(false);
  });
});
