/**
 * host_exec 셸의 환경 (리드 결정 S5-19·S5-33·S5-40.3, SERVER_DESIGN 8.4): buildChildEnv에서 부모 CLI 세션 변수, WOOK_* 전부, 알려진 AI 키, 비밀 값 이름 규칙
 * `(^|_)(API_?KEY|ACCESS_?KEY|SECRET(_?ACCESS)?_?KEY|PRIVATE_?KEY|SIGNING_?KEY|SECRET|TOKEN|CREDENTIALS?)$|AUTH_?TOKEN$|PASS(WORD|WD)$|_PWD$|^DATABASE_URL$`
 * (대소문자 무시 — PGPASSWORD·MYSQL_PWD·npm의 _authToken·JWT_PRIVATE_KEY·DATABASE_URL까지, 셸의 현재 폴더 PWD는 남김)을 뺀다. CI=1을 넣는다
 */
import { describe, expect, it } from 'vitest';
import { buildHostExecEnv, HOST_EXEC_AI_KEYS, HOST_EXEC_SECRET_NAME_RE, hostExecDropsVar, INHERITED_SESSION_VARS, MCP_TOOL_TIMEOUT_SEC, HOST_EXEC_MAX_TIMEOUT_S } from './common';

const BASE = {
  Path: 'C:\\Windows\\System32',
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  NODE_OPTIONS: '--max-old-space-size=4096',
  // 부모 CLI 세션 변수
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'x',
  codex_sandbox: 'seatbelt',
  // 앱 변수
  WOOK_MCP_TOKEN: 'turn-token',
  WOOK_DATA_DIR: 'D:\\data',
  wook_anything: 'y',
  // 알려진 AI 키
  ANTHROPIC_API_KEY: 'sk-ant-1',
  ANTHROPIC_AUTH_TOKEN: 'a',
  CLAUDE_CODE_OAUTH_TOKEN: 'b',
  OPENAI_API_KEY: 'sk-2',
  CODEX_API_KEY: 'c',
  AZURE_OPENAI_API_KEY: 'd',
  GEMINI_API_KEY: 'e',
  GOOGLE_API_KEY: 'f',
  XAI_API_KEY: 'g',
  // 이름 규칙
  GITHUB_TOKEN: 'ghp',
  NPM_TOKEN: 'npm',
  AWS_SECRET_ACCESS_KEY: 'aws',
  AWS_SESSION_TOKEN: 'aws-s',
  STRIPE_SECRET_KEY: 'sk',
  MY_SECRET: 'm',
  DB_PASSWORD: 'p',
  FTP_PASSWD: 'p2',
  GOOGLE_APPLICATION_CREDENTIALS: 'C:\\keys\\sa.json',
  SERVICE_CREDENTIAL: 'c1',
  SENTRY_ACCESS_KEY: 'k',
  stripe_apikey: 'k2',
  // 남는 것 — 이름 끝이 규칙과 다르다
  AWS_ACCESS_KEY_ID: 'AKIA',
  TOKENIZERS_PARALLELISM: 'false',
  PASSWORD_STORE_DIR: 'C:\\pass',
  SECRETARIAL: 'no',
  KEYBOARD_LAYOUT: 'ko',
};

describe('host_exec 환경 (buildHostExecEnv)', () => {
  it('세션 변수·WOOK_*·AI 키·비밀 값 이름을 빼고 나머지는 그대로, CI=1을 넣는다 (Windows는 대소문자 무시)', () => {
    const env = buildHostExecEnv(BASE, 'win32');
    expect(Object.keys(env).sort()).toEqual(
      ['APPDATA', 'AWS_ACCESS_KEY_ID', 'CI', 'KEYBOARD_LAYOUT', 'NODE_OPTIONS', 'PASSWORD_STORE_DIR', 'Path', 'SECRETARIAL', 'TOKENIZERS_PARALLELISM', 'USERPROFILE'].sort(),
    );
    expect(env.CI).toBe('1');
    expect(env.Path).toBe(BASE.Path);
  });

  it('POSIX에서도 같은 이름을 뺀다 — 이름 규칙·WOOK_*는 대소문자를 가리지 않는다', () => {
    const env = buildHostExecEnv({ PATH: '/usr/bin', HOME: '/home/me', wook_x: '1', github_token: 't', CLAUDECODE: '1', LANG: 'ko_KR.UTF-8' }, 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', LANG: 'ko_KR.UTF-8', CI: '1' });
  });

  it('목록과 규칙: 세션 변수는 모두 빠지고, 알려진 AI 키는 이름으로도 빠진다', () => {
    for (const k of INHERITED_SESSION_VARS) expect(hostExecDropsVar(k), k).toBe(true);
    for (const k of HOST_EXEC_AI_KEYS) expect(hostExecDropsVar(k), k).toBe(true);
    // 리드 결정 S5-40.3이 고친 규칙 (S5-19의 규칙은 PGPASSWORD·MYSQL_PWD·_authToken을, S5-33의 규칙은 PRIVATE_KEY·SIGNING_KEY·DATABASE_URL을 남겼다)
    expect(HOST_EXEC_SECRET_NAME_RE.source).toBe(
      '(^|_)(API_?KEY|ACCESS_?KEY|SECRET(_?ACCESS)?_?KEY|PRIVATE_?KEY|SIGNING_?KEY|SECRET|TOKEN|CREDENTIALS?)$|AUTH_?TOKEN$|PASS(WORD|WD)$|_PWD$|^DATABASE_URL$',
    );
    expect(HOST_EXEC_SECRET_NAME_RE.flags).toBe('i');
    for (const k of ['TOKEN', 'APIKEY', 'SECRET', 'X_ACCESSKEY', 'X_SECRETKEY', 'X_SECRET_ACCESS_KEY', 'PASSWORD', 'DB_PASSWD']) expect(hostExecDropsVar(k), k).toBe(true);
    for (const k of ['MYTOKEN', 'TOKEN_FILE', 'KEY', 'PASS', 'PWD', 'OLDPWD', 'PASSWORD_STORE_DIR', 'SSHPASS_PROMPT']) expect(hostExecDropsVar(k), k).toBe(false);
  });

  it('밑줄 없이 붙여 쓰는 비밀 값 이름도 뺀다 — PGPASSWORD·MYSQL_PWD·npm의 _authToken (리드 결정 S5-33). 셸의 현재 폴더 PWD는 남긴다', () => {
    for (const k of ['PGPASSWORD', 'MYSQL_PWD', 'npm_config__authToken', 'NPM_CONFIG__AUTH_TOKEN', '_authToken', 'GH_AUTHTOKEN', 'REDISPASSWORD', 'FTPPASSWD']) {
      expect(hostExecDropsVar(k), k).toBe(true);
    }
    const env = buildHostExecEnv({ PATH: '/usr/bin', PWD: '/home/me/work', OLDPWD: '/home/me', PGPASSWORD: 'p', MYSQL_PWD: 'm', npm_config__authToken: 'n' }, 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', PWD: '/home/me/work', OLDPWD: '/home/me', CI: '1' });
  });

  it('개인 키·서명 열쇠 이름과 이름이 꼭 DATABASE_URL인 변수도 뺀다 — 비슷한 이름은 남긴다 (리드 결정 S5-40.3)', () => {
    for (const k of ['PRIVATE_KEY', 'JWT_PRIVATE_KEY', 'GITHUB_APP_PRIVATEKEY', 'PRIVATEKEY', 'SIGNING_KEY', 'COOKIE_SIGNING_KEY', 'JWT_SIGNINGKEY', 'DATABASE_URL', 'database_url']) {
      expect(hostExecDropsVar(k), k).toBe(true);
    }
    // 앞뒤에 다른 말이 붙은 DATABASE_URL, 경로를 담는 이름, 이름 끝이 규칙과 다른 것은 남는다
    for (const k of ['DATABASE_URL_FILE', 'TEST_DATABASE_URL', 'PRIVATE_KEY_PATH', 'SIGNING_KEY_ID', 'MYPRIVATE_KEY', 'DATABASE_HOST']) expect(hostExecDropsVar(k), k).toBe(false);
    const env = buildHostExecEnv({ PATH: '/usr/bin', JWT_PRIVATE_KEY: 'k', COOKIE_SIGNING_KEY: 's', DATABASE_URL: 'postgres://u:p@h/db', DATABASE_HOST: 'h' }, 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', DATABASE_HOST: 'h', CI: '1' });
  });

  it('CLI가 앱 도구를 기다리는 시간은 host_exec 상한보다 60초 길다 (리드 결정 S5-18)', () => {
    expect(HOST_EXEC_MAX_TIMEOUT_S).toBe(1800);
    expect(MCP_TOOL_TIMEOUT_SEC).toBe(1860);
  });
});
