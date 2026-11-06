import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedactor, REDACT_KINDS, type RedactFailure } from './redact';

afterEach(() => {
  vi.restoreAllMocks();
});

// 소스에 키 모양 문자열이 그대로 남지 않도록 실행 중에 조립한다 (가짜 값)
const rep = (s: string, n: number): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const ALNUM = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6';
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', rep(ALNUM, 86) + '-AbCdEfAA'].join('-'),
  openaiProj: ['sk', 'proj', rep(ALNUM, 60) + '_-' + rep('Zy9Xw8', 40)].join('-'),
  openaiLegacy: 'sk-' + rep(ALNUM, 48),
  awsId: 'AKIA' + 'IOSFODNN7' + 'EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY',
  github: 'ghp' + '_' + rep(ALNUM, 36),
  githubPat: 'github_pat_' + '11ABCDEFG0' + '_' + rep(ALNUM, 59),
  slack: ['xoxb', '1234567890', '1234567890123', rep(ALNUM, 24)].join('-'),
  google: 'AIza' + 'Sy' + rep(ALNUM, 33),
  googleSecret: 'GOCSPX' + '-' + rep(ALNUM, 28),
  gitlab: 'glpat' + '-' + rep(ALNUM, 20),
  npm: 'npm' + '_' + rep(ALNUM, 36),
  jwt: [
    'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIn0',
    rep('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 43),
  ].join('.'),
  pem: [
    '-----BEGIN RSA PRIVATE KEY-----',
    rep('MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MbqNEk', 64),
    rep('o3fG2z0cZ8Q4Wn3v9rT1yK7uL2pE5sX8aB6dF0hJ4mN1qR3tV5wY7', 64),
    'AbCdEf==',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'),
};
const SECRET_VALUES = Object.values(FAKE);

const r = createRedactor();
const M = (kind: string): string => `[가림:${kind}]`;

describe('알려진 키 형식', () => {
  const cases: [string, string, string, string][] = [
    ['Anthropic 키', `키는 ${FAKE.anthropic} 입니다`, FAKE.anthropic, REDACT_KINDS.anthropic],
    ['OpenAI 프로젝트 키', `OPENAI=${FAKE.openaiProj}`, FAKE.openaiProj, REDACT_KINDS.openai],
    ['OpenAI 예전 키', `key ${FAKE.openaiLegacy} end`, FAKE.openaiLegacy, REDACT_KINDS.openai],
    ['AWS 액세스 키', `id=${FAKE.awsId}`, FAKE.awsId, REDACT_KINDS.aws],
    ['AWS 비밀 키 대입', `aws_secret_access_key = ${FAKE.awsSecret}`, FAKE.awsSecret, REDACT_KINDS.awsSecret],
    ['AWS 비밀 키 JSON', `{"SecretAccessKey": "${FAKE.awsSecret}"}`, FAKE.awsSecret, REDACT_KINDS.awsSecret],
    ['GitHub 토큰', `token ${FAKE.github}`, FAKE.github, REDACT_KINDS.github],
    ['GitHub PAT', `git clone https://${FAKE.githubPat}@github.com/a/b`, FAKE.githubPat, REDACT_KINDS.github],
    ['Slack 토큰', `slack: ${FAKE.slack}`, FAKE.slack, REDACT_KINDS.slack],
    ['Google API 키', `?key=${FAKE.google}&x=1`, FAKE.google, REDACT_KINDS.googleApi],
    ['Google OAuth 비밀', `client secret ${FAKE.googleSecret}`, FAKE.googleSecret, REDACT_KINDS.googleOAuth],
    ['GitLab 토큰', `${FAKE.gitlab}`, FAKE.gitlab, REDACT_KINDS.gitlab],
    ['npm 토큰', `//registry.npmjs.org/:_authToken=${FAKE.npm}`, FAKE.npm, REDACT_KINDS.npm],
    ['JWT', `id_token ${FAKE.jwt} 끝`, FAKE.jwt, REDACT_KINDS.jwt],
    ['PEM 개인 키', `파일 내용:\n${FAKE.pem}\n끝`, 'MIIEowIBAAKCAQEA', REDACT_KINDS.privateKey],
  ];
  it.each(cases)('%s', (_label, input, secret, kind) => {
    const out = r.text(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(M(kind));
  });

  it('PEM 블록은 JSON 문자열 안(이스케이프된 줄바꿈)에서도 통째로 가린다', () => {
    const line = JSON.stringify({ type: 'tool_result', content: `cat id_rsa\n${FAKE.pem}\n` });
    const out = r.text(line);
    expect(out).not.toContain('MIIEow');
    expect(out).not.toContain('AbCdEf==');
    expect(JSON.parse(out).content).toBe(`cat id_rsa\n${M(REDACT_KINDS.privateKey)}\n`);
  });

  it('끝 표시가 잘린 PEM 블록도 가린다', () => {
    const out = r.text(FAKE.pem.split('\n').slice(0, 3).join('\n'));
    expect(out).toBe(M(REDACT_KINDS.privateKey));
  });

  it('공개 키 블록·인증서는 가리지 않는다', () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----';
    expect(r.text(pub)).toBe(pub);
  });
});

describe('인증 헤더·Bearer·URL 비밀번호', () => {
  it('Authorization 헤더는 방식 이름을 남기고 값을 가린다', () => {
    expect(r.text('Authorization: Bearer abcDEF123456ghiJKL')).toBe(`Authorization: Bearer ${M(REDACT_KINDS.authHeader)}`);
    expect(r.text('authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(`authorization: Basic ${M(REDACT_KINDS.authHeader)}`);
    expect(r.text(`curl -H "Authorization: token ${'q'.repeat(10)}" https://api.github.com`)).toBe(
      `curl -H "Authorization: token ${M(REDACT_KINDS.authHeader)}" https://api.github.com`,
    );
  });

  it('Bearer 토큰만 따로 나와도 가린다', () => {
    expect(r.text('send Bearer 9f8e7d6c5b4a3f2e1d0c with request')).toBe(`send Bearer ${M(REDACT_KINDS.bearer)} with request`);
  });

  it('URL 안의 비밀번호를 가리고 사용자 이름·주소는 남긴다', () => {
    expect(r.text('postgres://app:S3cr3t!pass@db.local:5432/main')).toBe(`postgres://app:${M(REDACT_KINDS.urlPassword)}@db.local:5432/main`);
    expect(r.text('https://x-access-token:abc123def456@github.com/o/r.git')).toBe(
      `https://x-access-token:${M(REDACT_KINDS.urlPassword)}@github.com/o/r.git`,
    );
    expect(r.text('https://Zk3mP9qR7tW2xY5vB8nC1@git.example.com/repo')).toBe(`https://${M(REDACT_KINDS.urlToken)}@git.example.com/repo`);
  });

  it('산문 속 Bearer·Authorization 단어는 그대로 둔다', () => {
    for (const s of [
      'Bearer authentication is used',
      'Use a Bearer token for the API',
      'Authorization: required for all endpoints',
      'authorization: 대표만 가능합니다',
      'ssh://git@github.com:22/owner/repo',
      'http://localhost:3000/callback?state=x',
    ]) {
      expect(r.text(s)).toBe(s);
    }
  });
});

describe('키-값 대입', () => {
  const masked: [string, string, string][] = [
    ['.env 줄', 'ANTHROPIC_API_KEY=plainvalue123', `ANTHROPIC_API_KEY=${M(REDACT_KINDS.secret)}`],
    ['따옴표 .env', 'DB_PASSWORD="correct horse battery"', `DB_PASSWORD="${M(REDACT_KINDS.secret)}"`],
    ['export', 'export GITHUB_TOKEN=abcd1234efgh', `export GITHUB_TOKEN=${M(REDACT_KINDS.secret)}`],
    ['PowerShell', '$env:WOOK_MCP_TOKEN = "zxcv-0987-mnbv"', `$env:WOOK_MCP_TOKEN = "${M(REDACT_KINDS.secret)}"`],
    ['YAML 비밀번호', 'database:\n  password: hunter2\n  user: app', `database:\n  password: ${M(REDACT_KINDS.secret)}\n  user: app`],
    ['YAML 설정 줄(글자만)', 'smtp:\n  password: letmein\n', `smtp:\n  password: ${M(REDACT_KINDS.secret)}\n`],
    ['INI', 'client_secret = abc-123-xyz', `client_secret = ${M(REDACT_KINDS.secret)}`],
    ['JSON', '{"api_key": "abc123", "user": "bob"}', `{"api_key": "${M(REDACT_KINDS.secret)}", "user": "bob"}`],
    ['JSON 대문자 키', '{"OPENAI_API_KEY":"zzz-1"}', `{"OPENAI_API_KEY":"${M(REDACT_KINDS.secret)}"}`],
    ['JSON 쿠키', '{"Cookie": "sid=abc; theme=dark"}', `{"Cookie": "${M(REDACT_KINDS.secret)}"}`],
    ['JSON 안 JSON', '{"content":"{\\"password\\": \\"pa55word\\"}"}', `{"content":"{\\"password\\": \\"${M(REDACT_KINDS.secret)}\\"}"}`],
    ['파이썬 dict', "{'secret': 'abcdef', 'n': 1}", `{'secret': '${M(REDACT_KINDS.secret)}', 'n': 1}`],
    ['연결 문자열', 'Server=db;User Id=sa;Password=Secret123;', `Server=db;User Id=sa;Password=${M(REDACT_KINDS.secret)};`],
    ['URL 쿼리', 'https://x.com/cb?access_token=ya1b2c3d4&state=s', `https://x.com/cb?access_token=${M(REDACT_KINDS.secret)}&state=s`],
    ['명령 옵션', 'mytool --password hunter22 --verbose', `mytool --password ${M(REDACT_KINDS.secret)} --verbose`],
    ['명령 옵션 =', 'tool --api-key=abc123xyz', `tool --api-key=${M(REDACT_KINDS.secret)}`],
    ['XML', '<password>p@ss</password>', `<password>${M(REDACT_KINDS.secret)}</password>`],
    ['헤더 x-api-key', 'x-api-key: 0123abcd4567efgh', `x-api-key: ${M(REDACT_KINDS.secret)}`],
    ['Go 대입', 'token := "s3cr3t-value"', `token := "${M(REDACT_KINDS.secret)}"`],
    ['한국어 키', '비밀번호: hunter2', `비밀번호: ${M(REDACT_KINDS.secret)}`],
    ['한국어 API 키', 'API 키 = abcd1234', `API 키 = ${M(REDACT_KINDS.secret)}`],
    ['코드 안 토큰 같은 값', 'apiKey = aB3dE5fG7hJ9kL1m', `apiKey = ${M(REDACT_KINDS.secret)}`],
    ['JSON Authorization', '{"Authorization":"Bearer abc"}', `{"Authorization":"${M(REDACT_KINDS.secret)}"}`],
    ['쿠키 헤더 줄', 'Cookie: sid=abc123; theme=dark', `Cookie: ${M(REDACT_KINDS.secret)}; theme=dark`],
    ['값 안의 대입', 'note=password=abc123', `note=password=${M(REDACT_KINDS.secret)}`],
    // host_exec 개인 키 창이 16자 넘는 이름을 조각 표시로 바꾼 키 — 값이 다음 줄이어도 가린다 (리드 결정 S5-78)
    ['조각 표시 이름의 JSON 값', '"[가림:개인 키 조각]": "hunter2!x"', `"[가림:개인 키 조각]": "${M(REDACT_KINDS.secret)}"`],
    ['조각 표시 이름과 다음 줄 값', '  "[가림:개인 키 조각]":\n      "hunter2!x"', `  "[가림:개인 키 조각]":\n      "${M(REDACT_KINDS.secret)}"`],
    ['조각 표시가 든 이름의 JSON 안 JSON', '{"log":"{\\"spring.[가림:개인 키 조각]\\":\\"qX9#63\\"}"}', `{"log":"{\\"spring.[가림:개인 키 조각]\\":\\"${M(REDACT_KINDS.secret)}\\"}"}`],
    ['조각 표시 이름의 파이썬 dict', "{'[가림:개인 키 조각]': 'Pa$$12*'}", `{'[가림:개인 키 조각]': '${M(REDACT_KINDS.secret)}'}`],
  ];
  it.each(masked)('%s', (_label, input, expected) => {
    expect(r.text(input)).toBe(expected);
  });

  const untouched: [string, string][] = [
    ['TS 타입', 'interface A { password: string; token?: string | null }'],
    ['코드 참조', 'const apiKey = process.env.API_KEY;'],
    ['함수 호출', 'password = getpass()'],
    ['색인', 'api_key = os.environ["OPENAI_API_KEY"]'],
    ['비교', 'if (token === null) return;'],
    ['화살표 함수', 'tokens.map(token => token.trim())'],
    ['변수 참조', 'const token = newToken;'],
    ['셸 변수 참조', 'API_KEY=$OPENAI_API_KEY npm test'],
    ['템플릿', 'token: ${{ secrets.GITHUB_TOKEN }}'],
    ['토큰 수', '"usage":{"input_tokens":123,"output_tokens":45,"cache_read_input_tokens":0}'],
    ['최대 토큰', 'max_tokens=4096'],
    ['토큰 개수 코드', 'const tokenCount = 5;'],
    ['키 출처', '{"apiKeySource":"none","permissionMode":"bypassPermissions"}'],
    ['토큰 종류', '{"token_type":"Bearer","expires_in":3599}'],
    ['바이패스', '{"bypass":"verified","passed":true}'],
    ['라벨', "passwordLabel: '비밀번호'"],
    ['자격 증명 파일 위치', 'GOOGLE_APPLICATION_CREDENTIALS=/home/me/sa.json'],
    ['PWD 경로', 'PWD=/home/user/project'],
    ['키 이름 설정', 'SECRET_NAME=prod-db'],
    ['산문', 'The password: please use the vault'],
    ['산문2', 'token: 다음 단계에서 발급합니다'],
    ['한국어 토큰 수', '토큰: 6789'],
    ['한국어 안내', 'API 키: 설정 화면에서 입력하세요'],
    ['git 원격 주소', 'git@github.com:owner/repo.git'],
    ['명령 옵션 산문', 'run with --password to prompt'],
    ['비밀번호 입력 옵션', 'docker login --password-stdin'],
    ['기본 키', "primaryKey: 'id'"],
    ['캐시 키', "cacheKey = 'user-profile'"],
    ['세션 키', "sessionKey: 'task:T-0001'"],
    ['자리표시', 'API_KEY=<YOUR_API_KEY>'],
    ['가려진 표시', 'password=********'],
    ['빈 값', 'PASSWORD=""'],
    ['조각 표시 없는 긴 이름의 JSON 값', '{"applicationConfiguration": "prod"}'],
  ];
  it.each(untouched)('그대로: %s', (_label, input) => {
    expect(r.text(input)).toBe(input);
  });
});

describe('욱채 세션 토큰 wos_ (리드 결정 S3-14·S8-24)', () => {
  // wos_ + 32바이트 base64url(43자) — 실행 중에 조립한다 (가짜 값)
  const token = 'wos_' + rep('Ab3-dE_f9H', 43);
  const mark = M(REDACT_KINDS.wookSession);

  it('토큰 뒤에 토큰 글자(-·_·글자·숫자)가 더 붙어도 이어진 글자까지 통째로 가린다', () => {
    for (const tail of ['-x', '_x', 'x', '9', '-', '_', 'x-y_z0']) {
      expect(r.text(`세션 ${token}${tail} 끝`), tail).toBe(`세션 ${mark} 끝`);
      expect(r.text(`${token}${tail}`), tail).toBe(mark);
    }
  });

  it('토큰 글자가 아닌 것이 뒤에 오면 토큰만 가리고 그 글자는 둔다', () => {
    for (const tail of ['.', ' ', '"', '/', '한', ':', '\n']) expect(r.text(`(${token}${tail}끝)`), JSON.stringify(tail)).toBe(`(${mark}${tail}끝)`);
  });

  it('43자보다 짧거나 앞에 글자가 붙은 wos_는 토큰이 아니다', () => {
    for (const s of [token.slice(0, -1), `x${token}`, `_${token}`]) expect(r.text(s), s.slice(0, 6)).toBe(s);
  });
});

describe('가리지 않아야 하는 일반 내용', () => {
  const plain = [
    '3f2a9c8e1b7d6a5f4e3c2b1a0f9e8d7c6b5a4f3e',
    'commit 3f2a9c8e1b7d6a5f4e3c2b1a0f9e8d7c6b5a4f3e (HEAD -> task/T-0001-login)',
    'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    '550e8400-e29b-41d4-a716-446655440000',
    'session_id: 550e8400-e29b-41d4-a716-446655440000',
    '{"session_id":"550e8400-e29b-41d4-a716-446655440000","thread_id":"0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"}',
    '기획서 6.2 보고서 양식에 따라 작성합니다. 비밀 값은 저장 전에 가립니다.',
    '로그인 화면에서 비밀번호 재설정 흐름을 구현했습니다.',
    'API 키 관리 화면과 토큰 사용량 표를 추가했습니다.',
    'C:\\Users\\pc_09\\Desktop\\욱채프로그램_기획서_v0.5.md',
    'C:\\Users\\pc_09\\.ssh\\id_rsa',
    '/home/user/project/src/main/auth/googleAuth.ts',
    '/etc/secrets:/run/secrets',
    'docker run -v /run/secrets:/run/secrets app',
    'The token count was 1500 and the password reset flow is implemented.',
    'sk-learn-model-selection-guide',
    'task-runner-sk-planning-roadmap-2026',
    'T-0001 D-0001 RQ-000123 S-000001 TN-000001',
    'git -c core.quotepath=false -c commit.gpgsign=false commit --no-verify',
    'Wook-Task: T-0001\nWook-Request: RQ-000123',
    'npm run build && npx vitest run src/core',
    'mcp_servers.wook.bearer_token_env_var="WOOK_MCP_TOKEN"',
    '[가림:Anthropic 키] 이미 가린 값',
  ];
  it.each(plain)('%s', (s) => {
    expect(r.text(s)).toBe(s);
  });
});

describe('등록 값', () => {
  it('정확히 일치하는 값과 JSON·URL 인코딩된 모습을 모두 가린다', () => {
    const red = createRedactor();
    const secret = 'my"owner\\key/한글-값 #1';
    red.addSecret(secret, '대표 등록 키');
    const once = JSON.stringify(secret).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    const ascii = once.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const inputs = [secret, once, twice, ascii, encodeURIComponent(secret)];
    for (const s of inputs) {
      const out = red.text(`앞 ${s} 뒤`);
      expect(out).toBe('앞 [가림:대표 등록 키] 뒤');
    }
  });

  it('JSON 이벤트 안의 등록 값을 가려도 JSON 구조가 유지된다', () => {
    const red = createRedactor({ extraSecrets: ['turn-token-Zq8Lr3Vb'] });
    const line = JSON.stringify({ type: 'tool_use', input: { command: 'echo turn-token-Zq8Lr3Vb' } });
    const out = red.text(line);
    expect(out).not.toContain('Zq8Lr3Vb');
    expect(JSON.parse(out)).toEqual({ type: 'tool_use', input: { command: `echo ${M(REDACT_KINDS.registered)}` } });
  });

  it('짧은 등록 값(4–7자)은 영숫자 경계에서만, 4자 미만은 무시한다', () => {
    const red = createRedactor({ extraSecrets: ['ab', '', '   ', 'pin42'] });
    expect(red.text('pin42 and xpin42 and pin42x')).toBe(`${M(REDACT_KINDS.registered)} and xpin42 and pin42x`);
    expect(red.text('abc ab cab')).toBe('abc ab cab');
  });

  it('등록 값이 가림 표시 글자와 겹쳐도 결과가 같다', () => {
    const red = createRedactor();
    red.addSecret('가림:등록', '가림');
    const once = red.text('값 가림:등록 끝');
    expect(once).toBe('값 [가림:가림] 끝');
    expect(red.text(once)).toBe(once);
  });

  it('앞부분이 같은 등록 값은 같은 자리에서 가장 긴 것부터 맞춘다', () => {
    const red = createRedactor();
    red.addSecret('abcd-1234', '짧은 값');
    red.addSecret('abcd-1234-efgh-5678', '긴 값');
    expect(red.text('x abcd-1234-efgh-5678 y abcd-1234 z')).toBe('x [가림:긴 값] y [가림:짧은 값] z');
  });

  it('턴마다 토큰을 더해도(수만 개) 추가·가리기가 느려지지 않는다', () => {
    const red = createRedactor();
    const tokens = Array.from({ length: 20_000 }, (_, i) => `tok-${i.toString(36).padStart(6, '0')}-Zq8Lr3Vb${(i * 7919).toString(36)}`);
    const t0 = performance.now();
    for (const t of tokens) red.addSecret(t, 'token');
    const line = `{"type":"user","content":"echo ${tokens[12_345]} done"}`;
    expect(red.text(line)).toBe('{"type":"user","content":"echo [가림:token] done"}');
    red.addSecret('one-more-token-Xy9', 'token');
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) red.text(line);
    const perLine = (performance.now() - t1) / 100;
    // 실측: 2만 개 추가 + 한 줄 ≈ 수십 ms, 줄당 ≈ 0.01ms (예전 정규식 방식은 추가할 때마다 1000개당 약 4ms가 들었다)
    expect(t1 - t0).toBeLessThan(2000);
    expect(perLine).toBeLessThan(5);
  });

  it('나중에 더한 등록 값도 바로 적용된다', () => {
    const red = createRedactor();
    expect(red.text('value Xk29-Lm38-Pq47')).toBe('value Xk29-Lm38-Pq47');
    red.addSecret('Xk29-Lm38-Pq47', '턴 토큰');
    expect(red.text('value Xk29-Lm38-Pq47')).toBe('value [가림:턴 토큰]');
  });
});

describe('value()', () => {
  it('깊은 복사하며 문자열을 가리고 원본은 바꾸지 않는다', () => {
    const src = {
      type: 'result',
      usage: { input_tokens: 1200, output_tokens: 340, total_cost_usd: 0.12 },
      headers: { Authorization: 'Bearer short', 'x-api-key': 'k-1', accept: 'application/json' },
      env: { ANTHROPIC_API_KEY: 'whatever', PATH: 'C:\\bin' },
      nested: [{ password: 'pw', note: `키 ${FAKE.github}` }],
      tokenCount: 5,
      passed: { reviewId: 'RV-0001' },
      bypass: 'verified',
      password: '',
      count: 3,
      ok: true,
      none: null,
    };
    const snapshot = JSON.parse(JSON.stringify(src));
    const out = r.value(src);
    expect(src).toEqual(snapshot);
    expect(out).toEqual({
      type: 'result',
      usage: { input_tokens: 1200, output_tokens: 340, total_cost_usd: 0.12 },
      headers: { Authorization: M(REDACT_KINDS.secret), 'x-api-key': M(REDACT_KINDS.secret), accept: 'application/json' },
      env: { ANTHROPIC_API_KEY: M(REDACT_KINDS.secret), PATH: 'C:\\bin' },
      nested: [{ password: M(REDACT_KINDS.secret), note: `키 ${M(REDACT_KINDS.github)}` }],
      tokenCount: 5,
      passed: { reviewId: 'RV-0001' },
      bypass: 'verified',
      password: '',
      count: 3,
      ok: true,
      none: null,
    });
  });

  it('민감한 키 아래 객체·배열의 문자열은 모두 가리고, 일반 키(primaryKey)는 토큰 모양일 때만 가린다', () => {
    const out = r.value({
      credentials: { username: 'bob', list: ['a1', 'b2'], retries: 2 },
      primaryKey: 'id',
      key: 'Zk3mP9qR7tW2xY5vB8nC1',
    });
    expect(out).toEqual({
      credentials: { username: M(REDACT_KINDS.secret), list: [M(REDACT_KINDS.secret), M(REDACT_KINDS.secret)], retries: 2 },
      primaryKey: 'id',
      key: M(REDACT_KINDS.secret),
    });
  });

  it('Error의 message·stack·cause와 추가 속성을 가린다', () => {
    const cause = new Error(`원인 ${FAKE.anthropic}`);
    const err = Object.assign(new Error(`요청 실패: Authorization: Bearer ${FAKE.openaiLegacy}`, { cause }), { code: 'E_AUTH', token: 'abc' });
    const out = r.value(err);
    expect(out).toBeInstanceOf(Error);
    // 알려진 키 형식이 먼저 맞아 더 구체적인 종류로 표시된다
    expect(out.message).toBe(`요청 실패: Authorization: Bearer ${M(REDACT_KINDS.openai)}`);
    expect(out.stack ?? '').not.toContain(FAKE.openaiLegacy.slice(3, 20));
    expect((out.cause as Error).message).toBe(`원인 ${M(REDACT_KINDS.anthropic)}`);
    expect(out.code).toBe('E_AUTH');
    expect(out.token).toBe(M(REDACT_KINDS.secret));
    expect(err.message).toContain(FAKE.openaiLegacy);
  });

  it('순환 참조·Map·Set·Date·__proto__ 키를 안전하게 다룬다', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const parsed = JSON.parse(`{"__proto__": {"polluted": "${FAKE.github}"}}`) as object;
    const src = {
      a,
      map: new Map<string, unknown>([['secret', 'v'], ['plain', `x ${FAKE.npm}`]]),
      set: new Set([FAKE.slack, 'ok']),
      when: new Date('2026-10-27T00:00:00.000Z'),
      parsed,
    };
    const out = r.value(src);
    expect(out.a.self).toBe(out.a);
    expect(out.map.get('secret')).toBe(M(REDACT_KINDS.secret));
    expect(out.map.get('plain')).toBe(`x ${M(REDACT_KINDS.npm)}`);
    expect([...out.set]).toEqual([M(REDACT_KINDS.slack), 'ok']);
    expect(out.when).toEqual(new Date('2026-10-27T00:00:00.000Z'));
    expect(out.when).not.toBe(src.when);
    expect(Object.getPrototypeOf(out.parsed)).toBe(Object.prototype);
    expect(JSON.stringify(out.parsed)).toBe(`{"__proto__":{"polluted":"${M(REDACT_KINDS.github)}"}}`);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('AC-20: 테스트용 API 키가 저장 결과에 남지 않는다', () => {
  const testKey = FAKE.anthropic;

  it('CLI 출력 JSON (Claude stream-json 이벤트)', () => {
    const red = createRedactor({ extraSecrets: [testKey] });
    const events = [
      { type: 'system', subtype: 'init', session_id: '550e8400-e29b-41d4-a716-446655440000', permissionMode: 'bypassPermissions', apiKeySource: 'none' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `export ANTHROPIC_API_KEY=${testKey} && npm test` } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: `echo: {"apiKey":"${testKey}"}\nANTHROPIC_API_KEY=${testKey}` }] } },
      { type: 'result', subtype: 'success', result: `완료. 키 ${testKey} 를 썼습니다`, usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const lines = events.map((e) => JSON.stringify(e));
    const stored = lines.map((l) => red.text(l)).join('\n');
    expect(stored).not.toContain(testKey);
    expect(stored).not.toContain(testKey.slice(10, 40));
    const parsed = stored.split('\n').map((l) => JSON.parse(l));
    expect(parsed[0]).toEqual(events[0]);
    expect(parsed[3].usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(parsed[1].message.content[0].input.command).toBe(`export ANTHROPIC_API_KEY=${M(REDACT_KINDS.registered)} && npm test`);
  });

  it('보고서 마크다운', () => {
    const md = [
      '# 결제 연동',
      '## 결과',
      `- 환경 변수 \`OPENAI_API_KEY=${FAKE.openaiProj}\` 로 확인`,
      '```bash',
      `curl -H "Authorization: Bearer ${FAKE.openaiProj}" https://api.openai.com/v1/models`,
      '```',
      `- 키: ${FAKE.anthropic}`,
    ].join('\n');
    const out = r.text(md);
    for (const s of [FAKE.openaiProj, FAKE.anthropic]) expect(out).not.toContain(s);
    expect(out).toContain('# 결제 연동');
    expect(out).toContain('```bash');
  });

  it('오류 메시지', () => {
    const msg = `401 Unauthorized: invalid x-api-key ${FAKE.anthropic} (request to https://user:${'p4ssw0rd'}@proxy.local)`;
    const out = r.text(msg);
    expect(out).not.toContain(FAKE.anthropic);
    expect(out).not.toContain('p4ssw0rd');
    expect(out).toContain('401 Unauthorized');
  });
});

describe('멱등성과 JSON 보존', () => {
  const corpus = [
    ...SECRET_VALUES.map((v) => `값 ${v} 끝`),
    ...SECRET_VALUES.map((v) => JSON.stringify({ a: v, nested: { password: v, text: `x=${v}` } })),
    'ANTHROPIC_API_KEY=plainvalue123\nDB_PASSWORD="a b c"\n',
    '{"content":"{\\"password\\": \\"pa55word\\", \\"user\\": \\"bob\\"}"}',
    'Authorization: Bearer abcDEF123456ghiJKL\nBearer 9f8e7d6c5b4a3f2e1d0c',
    'postgres://app:S3cr3t!pass@db.local:5432/main https://Zk3mP9qR7tW2xY5vB8nC1@git.example.com',
    `${FAKE.pem}\n${FAKE.jwt}`,
    'note=password=abc123 token: hunter2',
  ];

  it.each(corpus.map((c, i) => [i, c] as const))('두 번 적용해도 같다 #%d', (_i, input) => {
    const once = r.text(input);
    expect(r.text(once)).toBe(once);
  });

  it('JSON 줄을 가려도 여전히 올바른 JSON이다', () => {
    // AWS 비밀 키는 형식이 없어 대입 문맥(aws_secret_access_key=…)에서만 알아본다
    for (const v of SECRET_VALUES.filter((s) => s !== FAKE.awsSecret)) {
      const line = JSON.stringify({ k: v, list: [v, 'ok'], obj: { api_key: v, n: 1 }, s: `Authorization: Bearer ${v}` });
      const out = r.text(line);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(out).not.toContain(v);
      expect(JSON.parse(out).obj.n).toBe(1);
      expect(JSON.parse(out).list[1]).toBe('ok');
    }
  });
});

describe('성능', () => {
  it('큰 로그(약 2MB)를 빠르게 처리한다', () => {
    const block = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"작업을 진행합니다. src/main/auth/googleAuth.ts 수정"}]}}',
      'commit 3f2a9c8e1b7d6a5f4e3c2b1a0f9e8d7c6b5a4f3e path=C:\\WOOK\\wookagent\\src token_count=5',
      `{"type":"user","message":{"content":[{"type":"tool_result","content":"export API_KEY=${FAKE.github}"}]}}`,
      'The quick brown fox jumps over the lazy dog. 한국어 문장도 섞여 있습니다. key=value password reset',
    ].join('\n');
    const big = Array.from({ length: 5000 }, () => block).join('\n');
    expect(big.length).toBeGreaterThan(1_500_000);
    const t0 = performance.now();
    const out = r.text(big);
    const ms = performance.now() - t0;
    expect(out).not.toContain(FAKE.github);
    expect(ms).toBeLessThan(5000);
  });

  it('병적인 입력에서도 제곱 시간이 걸리지 않는다', () => {
    const inputs = [
      '-----BEGIN PRIVATE KEY-----' + 'A'.repeat(200_000),
      '-----BEGIN PRIVATE KEY-----'.repeat(20_000),
      '-----BEGIN PRIVATE KEY-----\n'.repeat(10_000) + '-----END PRIVATE KEY-----',
      '"a":'.repeat(50_000),
      '{"token":"a",'.repeat(20_000),
      "'a':'".repeat(50_000),
      'password='.repeat(30_000),
      '"' + '\\"'.repeat(60_000),
      '\\"password\\": \\"'.repeat(20_000),
      'Bearer '.repeat(40_000),
      'authorization: '.repeat(30_000),
      'https://'.repeat(30_000) + 'a:b@c',
      'https://'.repeat(60_000),
      'x-api-key: '.repeat(20_000),
      '--password '.repeat(30_000),
      ('a'.repeat(100) + '=').repeat(2_000),
      'a-'.repeat(100_000) + 'token=x',
      '<password>' + 'a'.repeat(100_000),
      '비밀번호: '.repeat(30_000),
    ];
    for (const s of inputs) {
      const t0 = performance.now();
      r.text(s);
      // 실측은 모두 100ms 미만. 제곱 시간이면 수 초가 걸린다
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });
});

describe('가리개는 던지지 않는다 (리드 결정 S5-83)', () => {
  /** 가리지 못한 글을 바꾸는 표시 — 시험은 글 그대로 본다(이 차례 전 코드에서도 같은 단언이 돌게) */
  const FAILED = '[가림:가리기 실패]';
  const SECRET_MARK = M(REDACT_KINDS.secret);
  /** 이어 쓴 대입 끝의 값 (만든 가짜 값 — 숫자와 대소문자가 섞여 토큰처럼 보인다) */
  const TAIL = ['Hq3', 'zV8w', 'Rk5p', 'Ty2'].join('');
  /** 공백 없이 이어 쓴 대입 한 덩이를 48KiB 가까이 (host_exec가 남기는 한 줄의 상한 48KiB 안) */
  const chain = (unit: string): string => unit.repeat(Math.floor((48 * 1024 - 64) / unit.length)) + TAIL;
  const UNITS = ['key=', 'key:', 'tokenType=', 'keyboard=', 'passkey:'];

  // 검토자의 꼴(zz-xs5f8es-redthrow): 값 안의 대입을 다시 훑는 되부름이 대입마다 한 단계씩 깊어져 1,200~2,000번이면 RangeError를 던졌다
  it('48KiB로 이어 쓴 대입(key=·key:·tokenType=·keyboard=·passkey:)은 던지지 않고 깊이 상한(다시 훑기 16번) 뒤의 나머지를 값 하나로 가린다 — 넉넉히 200ms 안', () => {
    const took: Record<string, number> = {};
    for (const unit of UNITS) {
      const line = chain(unit);
      expect(line.length).toBeLessThanOrEqual(48 * 1024);
      const t0 = performance.now();
      const out = r.text(line);
      took[unit] = Math.round(performance.now() - t0);
      // 가리기는 실패하지 않았다 — 맨 바깥 대입부터 17개(다시 훑기 16번)는 그대로, 그 뒤 값 전체가 비밀 값 표시 하나
      expect(out, unit).toBe(`${unit.repeat(17)}${SECRET_MARK}`);
      expect(out.includes(TAIL)).toBe(false);
      // 다시 가려도 같다
      expect(r.text(out)).toBe(out);
    }
    expect(Math.max(...Object.values(took)), JSON.stringify(took)).toBeLessThan(200);
  });

  it('값 안의 대입은 다시 훑기 16번까지 예전 그대로다 — 대입 17개는 바꾸지 않고, 18개부터 나머지를 가린다(더 가리기만 한다)', () => {
    expect(r.text(`${'key='.repeat(17)}value`)).toBe(`${'key='.repeat(17)}value`);
    expect(r.text(`${'key='.repeat(18)}value`)).toBe(`${'key='.repeat(17)}${SECRET_MARK}`);
    expect(r.text('note=password=abc123')).toBe(`note=password=${SECRET_MARK}`);
    expect(r.text(`${'key='.repeat(5)}password=hunter`)).toBe(`${'key='.repeat(5)}password=${SECRET_MARK}`);
  });

  it('낙타 꼴 식별자 판정은 선형이다 — 대소문자가 번갈아 끝에 다른 글자가 붙은 48KiB 값도 넉넉히 150ms 안, 판정은 예전 정규식과 같다', () => {
    const t0 = performance.now();
    expect(r.text(`secretKey=${'aA'.repeat(24_000)}!`)).toBe(`secretKey=${SECRET_MARK}`);
    expect(r.text(`token: ${'aBc1'.repeat(12_000)}!`)).toBe(`token: ${SECRET_MARK}`);
    expect(performance.now() - t0).toBeLessThan(150);
    // 낙타 꼴(소문자·_·$로 시작, 둘째 글자부터 [a-z0-9] 뒤 대문자)이면 코드 이름으로 보고 그대로, 아니면 비밀번호처럼 보이는 값이라 가린다
    expect(r.text('password: abCdefghij')).toBe('password: abCdefghij');
    expect(r.text('password: my_cmlCa$e')).toBe('password: my_cmlCa$e');
    expect(r.text('password: aBcdefghij')).toBe(`password: ${SECRET_MARK}`);
    expect(r.text('password: Mycamelcase')).toBe(`password: ${SECRET_MARK}`);
    expect(r.text('password: myCamelCase!')).toBe(`password: ${SECRET_MARK}`);
    // 대문자로 시작하고 혹이 있는 짧은 값(토큰처럼 보이지 않음)도 코드 이름이 아니다 — 예전 정규식처럼 첫 글자는 소문자·_·$여야 한다 (리드 결정 S5-90 4,
    // 프로브 zz-s5f9ti-camel-upper, 변이 own7:O16-r-camel-upper-start)
    expect(r.text('password: AbCdefghij')).toBe(`password: ${SECRET_MARK}`);
    expect(r.text('password=AbCdefghij')).toBe(`password=${SECRET_MARK}`);
    expect(r.text('password=MyPassWord')).toBe(`password=${SECRET_MARK}`);
  });

  /** 넣은 내부 오류 — 가리개 안의 includes가 이 글을 만나면 던진다(오류 글에 그 글을 싣는다). 다른 글은 그대로다 */
  const SENTINEL = ['sent', 'inel', '7Hq2'].join('-');
  const injectFailure = (): void => {
    const includes = String.prototype.includes;
    vi.spyOn(String.prototype, 'includes').mockImplementation(function (this: string, search: string, position?: number) {
      if (includes.call(this, SENTINEL)) throw new Error(`가짜 내부 오류: ${String(this)}`);
      return includes.call(this, search, position);
    });
  };

  it('안에서 오류가 나면 그 글 전체가 가리기 실패 표시다 — 던지지 않고, onFailure는 한 번(어디서·오류 이름·길이 — 글은 싣지 않는다)', () => {
    const seen: RedactFailure[] = [];
    const red = createRedactor({ onFailure: (f) => seen.push(f) });
    const line = `deploy log ${SENTINEL} password=${TAIL}`;
    injectFailure();
    let out = '';
    let other = '';
    let value: unknown = null;
    try {
      out = red.text(line);
      other = red.text(`API_KEY=${TAIL}`);
      value = red.value({ a: line, b: 'ok', n: 1 });
    } finally {
      vi.restoreAllMocks();
    }
    expect(out).toBe(FAILED);
    expect(other).toBe(`API_KEY=${SECRET_MARK}`);
    expect(value).toEqual({ a: FAILED, b: 'ok', n: 1 });
    expect(seen).toEqual([
      { where: 'text', error: 'Error', length: line.length },
      { where: 'text', error: 'Error', length: line.length },
    ]);
    expect(JSON.stringify(seen).includes(SENTINEL) || JSON.stringify(seen).includes(TAIL)).toBe(false);
  });

  it('onFailure가 던져도, 알리는 중에 가리개를 다시 불러 또 실패해도 가리개는 던지지 않고 한 번만 알린다', () => {
    const line = `x ${SENTINEL} y`;
    const throwing = createRedactor({
      onFailure: () => {
        throw new Error('알리는 쪽 오류');
      },
    });
    let calls = 0;
    const inner: string[] = [];
    const holder: { r: ReturnType<typeof createRedactor> | null } = { r: null };
    holder.r = createRedactor({
      onFailure: () => {
        calls++;
        inner.push(holder.r!.text(line));
      },
    });
    injectFailure();
    let a = '';
    let b = '';
    try {
      a = throwing.text(line);
      b = holder.r.text(line);
    } finally {
      vi.restoreAllMocks();
    }
    expect([a, b]).toEqual([FAILED, FAILED]);
    expect({ calls, inner }).toEqual({ calls: 1, inner: [FAILED] });
  });

  it('value()도 던지지 않는다 — 속성을 읽다 던지면 값 전체가 표시, 128단계보다 깊은 곳은 그 아래가 표시(바깥은 그대로)', () => {
    const seen: RedactFailure[] = [];
    const red = createRedactor({ onFailure: (f) => seen.push(f) });
    const getter = {
      get password(): string {
        throw new Error(`getter ${TAIL}`);
      },
    };
    expect(red.value(getter)).toBe(FAILED);
    // 128단계(배열 128겹)까지는 그대로 — 끝의 글도 가린다
    const nest = (n: number, leaf: unknown): unknown => {
      let v = leaf;
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    expect(red.value(nest(128, `API_KEY=${TAIL}`))).toEqual(nest(128, `API_KEY=${SECRET_MARK}`));
    expect(red.value(nest(129, 'ok'))).toEqual(nest(128, FAILED));
    // JSON.parse는 수만 단계도 읽는다 — 그런 값도 던지지 않는다
    const deep = red.value(JSON.parse(`${'['.repeat(20_000)}"${TAIL}"${']'.repeat(20_000)}`) as unknown);
    let at: unknown = deep;
    for (let i = 0; i < 128; i++) at = (at as unknown[])[0];
    expect(at).toBe(FAILED);
    expect(seen).toEqual([
      { where: 'value', error: 'Error', length: null },
      { where: 'value', error: '깊이 상한', length: null },
      { where: 'value', error: '깊이 상한', length: null },
    ]);
  });

  // 깊이는 배열만이 아니라 보통 객체·Map·Set의 겹마다 센다 — CLI 이벤트·도구 인자·실행 기록의 깊은 값은 보통 객체다. 세지 않으면 2만 단계 객체가 스택을 다 써
  // 값 전체가 표시가 된다(바깥 128단계를 잃는다) (리드 결정 S5-90 4, 프로브 zz-s5f9ti-clone-object-depth, 변이 own7:O16-r-clone-object-no-depth)
  it('value()의 깊이 상한은 보통 객체·Map·Set의 겹도 센다 — 128겹은 그대로(끝 글도 가림), 129겹이면 128단계 아래가 표시, 2만 단계 JSON 객체도 바깥 128단계를 지킨다', () => {
    const seen: RedactFailure[] = [];
    const red = createRedactor({ onFailure: (f) => seen.push(f) });
    const nestObj = (n: number, leaf: unknown): unknown => {
      let v = leaf;
      for (let i = 0; i < n; i++) v = { inner: v };
      return v;
    };
    expect(red.value(nestObj(128, `API_KEY=${TAIL}`))).toEqual(nestObj(128, `API_KEY=${SECRET_MARK}`));
    expect(red.value(nestObj(129, 'ok'))).toEqual(nestObj(128, FAILED));
    const deep = red.value(JSON.parse(`${'{"inner":'.repeat(20_000)}"${TAIL}"${'}'.repeat(20_000)}`) as unknown);
    expect(typeof deep).toBe('object');
    let at: unknown = deep;
    for (let i = 0; i < 128; i++) at = (at as { inner: unknown }).inner;
    expect(at).toBe(FAILED);
    // 겹마다 꼴을 바꿔도(보통 객체·Map·Set·배열) 한 겹은 한 단계다 — 바깥에서 k번째 겹의 꼴은 k % 4로 정한다. 겹친 Map·Set을 toEqual로 견주면 다를 때 견주기가
    // 겹마다 두 갈래로 늘어 끝나지 않는다 — 그래서 겹마다 꼴을 보며 내려가 그 자리의 값을 본다
    const nestMixed = (n: number, leaf: unknown): unknown => {
      let v = leaf;
      for (let k = n - 1; k >= 0; k--) v = k % 4 === 0 ? { inner: v } : k % 4 === 1 ? new Map([['inner', v]]) : k % 4 === 2 ? new Set([v]) : [v];
      return v;
    };
    const downMixed = (v: unknown, n: number): unknown => {
      let at = v;
      for (let k = 0; k < n; k++) {
        if (k % 4 === 0) at = (at as { inner: unknown }).inner;
        else if (k % 4 === 1) at = at instanceof Map ? at.get('inner') : `깊이 ${k}: Map이 아님`;
        else if (k % 4 === 2) at = at instanceof Set ? [...at][0] : `깊이 ${k}: Set이 아님`;
        else at = Array.isArray(at) ? at[0] : `깊이 ${k}: 배열이 아님`;
      }
      return at;
    };
    expect(downMixed(red.value(nestMixed(128, `API_KEY=${TAIL}`)), 128)).toBe(`API_KEY=${SECRET_MARK}`);
    expect(downMixed(red.value(nestMixed(129, 'ok')), 128)).toBe(FAILED);
    expect(seen).toEqual([
      { where: 'value', error: '깊이 상한', length: null },
      { where: 'value', error: '깊이 상한', length: null },
      { where: 'value', error: '깊이 상한', length: null },
    ]);
  });
});
