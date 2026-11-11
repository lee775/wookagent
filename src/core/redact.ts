/**
 * 비밀 값 가리기 (SEC-10, RPT-04, AC-20). 순수 로직 — I/O 없음.
 * CLI 이벤트·활동 기록·보고서·diff·대화 기록은 저장 전에 이 모듈로 가린다. 바꾼 결과는 `[가림:<종류>]`.
 *
 * 규칙 적용 순서: 등록 값(정확히 일치) → 알려진 키 형식 → 인증 헤더·Bearer·URL 비밀번호 → 키-값 대입(JSON·환경 변수·설정 파일·명령 옵션).
 * 이미 가린 표시는 다른 규칙이 다시 건드리지 않으므로 여러 번 적용해도 결과가 같다.
 * 가리개(text·value)는 던지지 않는다 — 안에서 오류를 만나면 그 글을 통째로 '[가림:가리기 실패]'로 바꾸고 onFailure로 내용 없이 알린다. 규칙은 되부름이
 * 깊어지지 않게 묶여 있다(값 안의 대입 다시 훑기·value()의 깊이, 리드 결정 S5-83).
 */

export interface Redactor {
  /** 문자열 안의 비밀 값을 가린다. 여러 번 적용해도 결과가 같다. 던지지 않는다 — 가리지 못하면 그 글 전체가 '[가림:가리기 실패]' (리드 결정 S5-83) */
  text(s: string): string;
  /**
   * 깊은 복사하면서 모든 문자열(객체 키 포함)을 가린다. password·secret·token·api_key·authorization·cookie 같은 키
   * 아래의 문자열은 통째로 가린다(숫자·참거짓은 그대로 — 사용량 통계 input_tokens 등이 깨지지 않게).
   * 배열·일반 객체·Map·Set·Date·Error(message·stack·cause 포함)·순환 참조를 다룬다. Buffer 같은 이진 값은 그대로 둔다.
   */
  value<T>(v: T): T;
  /**
   * 정확히 일치하면 가릴 값(대표가 등록한 키, 턴 토큰 등)을 더한다. JSON 이스케이프·URL 인코딩된 모습도 가린다.
   * 앞뒤 공백을 뺀 길이가 4자 미만이면 무시한다(일반 글자를 망가뜨리지 않기 위해). 4–7자는 영숫자 경계에서만 가린다.
   */
  addSecret(secret: string, kind?: string): void;
  /**
   * 정해진 값이지만 여러 꼴로 들어올 수 있는 것(대표 이메일 설정 코드 — 대소문자·줄표·띄어쓰기, 리드 결정 S3-18)을 꼴 하나로 가린다. 등록 값 다음,
   * 알려진 형식 규칙 앞에 적용한다. 정규식은 g 표시로 다시 만들어 쓴다
   */
  addPattern(pattern: RegExp, kind?: string): void;
}

export interface RedactorOptions {
  extraSecrets?: string[];
  /**
   * 가리개가 안에서 오류를 만나(또는 value()의 깊이 상한에 닿아) 글이나 값 하나를 '[가림:가리기 실패]'로 바꿀 때마다 한 번 (리드 결정 S5-83). 글의 내용은
   * 넘기지 않는다 — 어디서(text·value), 오류의 이름, 글 길이만. 앱 조립(buildDeps)이 로그 경고 한 줄로 잇는다. 이 함수가 던지거나 이 함수 안에서 다시
   * 실패해도 가리개는 던지지 않는다(알리는 중의 실패는 알리지 않는다)
   */
  onFailure?: (f: RedactFailure) => void;
}

/** 가리개 안의 실패 하나 (리드 결정 S5-83) — 가리지 못한 글은 담지 않는다 */
export interface RedactFailure {
  where: 'text' | 'value';
  /** 오류의 이름(RangeError 등) — 오류 글은 입력을 되풀이할 수 있어 싣지 않는다. value()의 깊이 상한이면 '깊이 상한' */
  error: string;
  /** 가리지 못한 글의 길이 (value()면 null) */
  length: number | null;
}

/** 가림 표시에 쓰는 종류 이름 */
export const REDACT_KINDS = {
  anthropic: 'Anthropic 키',
  openai: 'OpenAI 키',
  aws: 'AWS 키',
  awsSecret: 'AWS 비밀 키',
  github: 'GitHub 토큰',
  slack: 'Slack 토큰',
  googleApi: 'Google API 키',
  googleOAuth: 'Google 인증 정보',
  gitlab: 'GitLab 토큰',
  npm: 'npm 토큰',
  pypi: 'PyPI 토큰',
  stripe: 'Stripe 키',
  huggingface: 'Hugging Face 토큰',
  sendgrid: 'SendGrid 키',
  jwt: 'JWT',
  /** 욱채 서버의 대표 기기 세션 토큰 (`wos_` + 32바이트 base64url — SERVER_DESIGN 3.5, 리드 결정 S3-4·S3-14) */
  wookSession: '욱채 세션 토큰',
  /** 욱채 서버의 외부 에이전트 키 (`wsk_` + 32바이트 base64url — SERVER_DESIGN 4.5, 리드 결정 S7-3). 등록할 때 한 번만 보이고 DB에는 해시만 둔다 */
  wookAgentKey: '욱채 에이전트 키',
  /** 욱채 앱 도구 서버의 턴 토큰 (`wtt_` + 32바이트 base64url — CLI 턴·외부 턴 모두, 리드 결정 S7-3) */
  wookTurnToken: '욱채 턴 토큰',
  privateKey: '개인 키',
  bearer: 'Bearer 토큰',
  authHeader: '인증 헤더',
  urlPassword: 'URL 비밀번호',
  urlToken: 'URL 토큰',
  secret: '비밀 값',
  registered: '등록 값',
  /** 가리개가 안에서 오류를 만나 글 전체를 대신한 것 (리드 결정 S5-83) */
  failed: '가리기 실패',
} as const;

const MARK_OPEN = '[가림:';
const mark = (kind: string): string => `${MARK_OPEN}${kind}]`;
const SECRET_MARK = mark(REDACT_KINDS.secret);
/**
 * 가리지 못한 글을 통째로 바꾸는 표시 `[가림:가리기 실패]` (리드 결정 S5-83) — 가리개(text·value)는 안에서 어떤 오류를 만나도 던지지 않고 그 글 대신 이
 * 표시를 돌려준다(실패해도 닫힌 쪽 — 원문을 남기지 않는다). host_exec·자동 검사의 출력 모으기도 가리개가 던지면 같은 표시를 쓴다
 */
export const REDACT_FAILED_MARK = mark(REDACT_KINDS.failed);

const MIN_SECRET_LENGTH = 4;
const BOUNDED_SECRET_LENGTH = 8;
const MAX_PASSES = 4;
/**
 * value()가 따라 들어가는 깊이의 상한 (리드 결정 S5-83) — 깊게 중첩된 값(JSON.parse는 수만 단계도 읽는다)을 따라 들어가다 스택을 다 써 던지지 않게, 닿으면
 * 그 아래 값을 통째로 '[가림:가리기 실패]'로 둔다(더 가리기만 한다). 실제 기록·도구 인자·CLI 이벤트는 수십 단계 안이다
 */
const CLONE_MAX_DEPTH = 128;

// ───────────────────────── 값 판별 도우미 ─────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_DIGEST_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const TOKEN_CHARS_RE = /^[A-Za-z0-9+/=_.~:@!#$%^&*-]+$/;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

function longestAlnumRun(s: string): number {
  let best = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    cur = alnum ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

/** 무작위 토큰처럼 보이는가 (숫자+글자 섞임, 또는 길고 대소문자 섞임). 산문 단어·UUID·git SHA는 아님 */
function looksLikeToken(v: string): boolean {
  if (v.length < 8 || v.length > 8192 || !TOKEN_CHARS_RE.test(v)) return false;
  if (UUID_RE.test(v) || HEX_DIGEST_RE.test(v)) return false;
  const digit = /\d/.test(v);
  const lower = /[a-z]/.test(v);
  const upper = /[A-Z]/.test(v);
  if (digit && (lower || upper)) return true;
  if (lower && upper && v.length >= 12) return true;
  return v.length >= 32 && longestAlnumRun(v) >= 16;
}

/** 산문 단어가 아닌 비밀번호 같은 값인가 (명령 옵션·`키: 값` 산문 문맥용) */
function looksLikeSecretValue(v: string): boolean {
  if (v.length < 6 || /\s/.test(v) || HANGUL_RE.test(v)) return false;
  if (v.length >= 12) return true;
  return /\d/.test(v) || /[^A-Za-z0-9]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));
}

/** sk- 뒤의 본문이 실제 키처럼 보이는가 (sk-learn-model 같은 이름 제외) */
function isRandomKeyBody(body: string): boolean {
  if (body.length < 20 || !/\d/.test(body) || !/[A-Za-z]/.test(body)) return false;
  return longestAlnumRun(body) >= 16 || /[A-Z]/.test(body);
}

/** 환경 변수·템플릿 참조 (실제 값이 아님) */
const REFERENCE_RE = /^(?:\$[{(A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%$|\{\{|<%|#\{|@\{)/;
/** 이미 가린 자리표시 (***, xxxx, <YOUR_TOKEN>, ...) */
const PLACEHOLDER_RE = /^(?:[*xX•·.…_-]{3,}|<[^<>\r\n]{1,64}>)$/;
const PATH_LIKE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.\.?[\\/])/;
/** 코드 문맥의 타입·리터럴 이름 (`password: string`, `token = None`) */
const CODE_WORDS = new Set([
  'string', 'number', 'boolean', 'bool', 'str', 'int', 'float', 'double', 'any', 'unknown', 'never', 'object', 'void',
  'bytes', 'char', 'null', 'undefined', 'none', 'nil', 'true', 'false', 'optional', 'record', 'partial', 'array',
  'promise', 'readonly', 'secretstr', 'text', 'varchar', 'required', 'redacted',
]);
const DOTTED_IDENT_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const IDENT_CHARS_RE = /^[a-z_$][A-Za-z0-9_$]*$/;
const CAMEL_HUMP_RE = /[a-z0-9][A-Z]/;
/**
 * 낙타 꼴 식별자(`secretKey`, `tokenValue`)인가 — 소문자·_·$로 시작하는 식별자 글자뿐이고 둘째 글자부터 [a-z0-9] 뒤 대문자가 있다. 예전 정규식
 * (`^[a-z_$][A-Za-z0-9_$]*[a-z0-9][A-Z][A-Za-z0-9_$]*$`)과 같은 판정을 두 번의 선형 훑기로 한다 — 그 정규식은 대소문자가 번갈아 끝에 다른 글자가 붙은
 * 긴 값(`aAaA…!`)에서 되짚기가 제곱이 되어 48KiB 값 하나에 약 0.4초가 걸렸다 (리드 결정 S5-83의 점검)
 */
const isCamelIdent = (s: string): boolean => IDENT_CHARS_RE.test(s) && CAMEL_HUMP_RE.test(s.slice(1));

function isReference(v: string): boolean {
  return REFERENCE_RE.test(v);
}

// ───────────────────────── 키 이름 판별 ─────────────────────────

type KeyClass = 'strong' | 'weak';

/** 어느 위치에 있어도 비밀을 뜻하는 단어 (뒤에 META 단어가 붙으면 제외: passwordLabel 등) */
const STRONG_ANY = new Set(['password', 'passwd', 'passphrase', 'secret', 'secrets', 'credential', 'credentials', 'privatekey']);
/** 마지막 단어일 때만 비밀 (tokenCount·authMode는 제외) */
const STRONG_LAST = new Set([
  'token', 'pwd', 'pass', 'auth', 'authorization', 'cookie', 'cookies', 'apikey', 'accesskey', 'secretkey', 'authtoken',
  'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken', 'clientsecret', 'xapikey', 'pat', 'pin',
]);
/** 이 단어가 마지막이면 비밀 값 자체가 아니라 설정·설명 (passwordLabel, TOKEN_URL, SECRET_NAME ...) */
const META_LAST = new Set([
  'label', 'placeholder', 'hint', 'field', 'input', 'title', 'text', 'message', 'msg', 'policy', 'length', 'len', 'min',
  'max', 'rule', 'rules', 'required', 'enabled', 'disabled', 'visible', 'hidden', 'type', 'format', 'name', 'names', 'id',
  'ids', 'url', 'uri', 'endpoint', 'path', 'file', 'filename', 'dir', 'directory', 'prompt', 'error', 'errors', 'reset',
  'strength', 'expiry', 'expires', 'expiration', 'ttl', 'set', 'count', 'size', 'limit', 'timeout', 'header', 'source',
  'mode', 'kind', 'status', 'version', 'ref', 'arn', 'provider', 'store', 'manager', 'location', 'region', 'scope', 'scopes',
  'issuer', 'audience', 'algorithm', 'alg', 'encoding', 'prefix', 'suffix', 'pattern', 'regex', 'schema', 'stdin', 'env',
  'var', 'cmd', 'command', 'helper', 'icon', 'button', 'link', 'help', 'description', 'desc', 'note', 'notes', 'used',
  'usage', 'changed', 'updated', 'created', 'at', 'date', 'time',
]);
/** 앞 단어가 이것이면 '...key'는 비밀 키 (api key, access key, private key ...) */
const SECRET_KEY_QUALIFIERS = new Set([
  'api', 'access', 'secret', 'private', 'client', 'master', 'encryption', 'signing', 'license', 'licence', 'subscription',
  'service', 'account', 'app', 'deploy', 'ssh', 'auth', 'admin', 'root', 'shared', 'storage', 'webhook', 'write', 'consumer',
  'developer', 'dev', 'prod', 'live', 'test', 'sandbox', 'bot', 'integration', 'merchant', 'partner', 'publisher', 'x',
]);
/** 앞 단어가 이것이면 '...key'는 비밀이 아님 (public key, primary key, sort key ...) */
const PLAIN_KEY_QUALIFIERS = new Set([
  'public', 'primary', 'foreign', 'sort', 'partition', 'cache', 'hot', 'short', 'shortcut', 'idempotency', 'dedupe', 'row',
  'map', 'object', 'group', 'lookup', 'route', 'unique', 'composite', 'natural', 'surrogate', 'i18n', 'translation', 'react',
  'list', 'item', 'index', 'hash', 'table', 'column', 'field', 'menu', 'keyboard', 'music', 'piano', 'registry', 'work',
  'session', 'request', 'query', 'config', 'setting', 'settings', 'local', 'state', 'event', 'message',
]);
const COMPOUND_SECRET_RE = /^(?:api|access|secret|private|client|auth|refresh|id|session|bearer)(?:key|token|secret)$/;
const COMPOUND_PASSWORD_RE = /(?:password|passwd|passphrase)$/;

function splitKeyComponents(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((c) => c.length > 0)
    .map((c) => c.toLowerCase());
}

/** 키 이름이 비밀 값을 담는지: strong = 값을 가린다, weak = 토큰처럼 보일 때만 가린다 (primaryKey 같은 일반 키 대비) */
function classifyKey(rawKey: string): KeyClass | null {
  const key = rawKey.trim();
  if (key.length === 0 || key.length > 128) return null;
  const comps = splitKeyComponents(key);
  if (comps.length === 0) return null;
  const joined = comps.join('');
  // 셸의 현재 폴더 변수(PWD)는 경로다
  if (joined === 'pwd' || joined === 'oldpwd') return null;
  const last = comps[comps.length - 1]!;
  if (META_LAST.has(last)) return null;
  const upper = /[A-Z]/.test(key) && !/[a-z]/.test(key);
  if (comps.some((c) => STRONG_ANY.has(c) || COMPOUND_PASSWORD_RE.test(c) || c.endsWith('secret') || c.startsWith('credential'))) {
    return 'strong';
  }
  if (STRONG_LAST.has(last) || COMPOUND_SECRET_RE.test(last)) return 'strong';
  if (upper && comps.some((c) => c === 'token' || c === 'pwd' || c === 'pass' || c === 'apikey' || COMPOUND_SECRET_RE.test(c))) {
    return 'strong';
  }
  // 환경 변수(API_KEY, STRIPE_KEY)는 비밀로 본다
  if (upper) return comps.includes('key') ? 'strong' : null;
  if (last === 'key') {
    const prev = comps.length > 1 ? comps[comps.length - 2]! : '';
    if (SECRET_KEY_QUALIFIERS.has(prev)) return 'strong';
    if (PLAIN_KEY_QUALIFIERS.has(prev)) return null;
    // 코드 식별자(cacheKey, key)는 값이 토큰처럼 보일 때만
    return 'weak';
  }
  return null;
}

/**
 * 따옴표 안의 값(JSON 등)을 가릴지. 이름에 '[가림:개인 키 조각]'이 든 키는 비밀 키로 본다 — host_exec 출력의 개인 키 창은 남기는 줄의 16자 넘는 이어짐을
 * 조각 표시로 바꾸는데(이름 databasePassword도), 값이 다음 줄에 있으면(`"databasePassword":` 다음 줄에 값) 남길 때의 가리기는 그 값을 보지 못하고 마지막
 * 가리기는 이름을 알아볼 수 없다. 그 표시는 창 안에서만 생기므로 창 밖의 글은 그대로다 (리드 결정 S5-78)
 */
function shouldMaskQuoted(key: string, inner: string): boolean {
  const cls = key.includes(PRIVATE_KEY_PIECE_MARK) ? 'strong' : classifyKey(key);
  if (!cls || inner.length === 0) return false;
  if (isReference(inner) || PLACEHOLDER_RE.test(inner)) return false;
  if (cls === 'weak') return looksLikeToken(inner);
  return true;
}

// ───────────────────────── 규칙 ─────────────────────────

interface Rule {
  /** false면 규칙을 건너뛴다 (선형 시간의 빠른 사전 검사) */
  readonly hint: ((s: string) => boolean) | null;
  readonly run: (s: string) => string;
}

/** 사전 검사용 정규식은 g 플래그 없이, 되돌아가며 다시 훑지 않는 단순한 모양만 쓴다 */
const has = (re: RegExp) => (s: string): boolean => re.test(s);

function fixedRule(re: RegExp, kind: string, hint: RegExp | null, accept?: (m: string) => boolean): Rule {
  const replacement = mark(kind);
  return { hint: hint ? has(hint) : null, run: (s) => s.replace(re, (m: string) => (accept && !accept(m) ? m : replacement)) };
}

const KEYWORD_HINT = has(/key|token|secret|pass|pwd|credential|auth|cookie|pin\b|pat\b/i);

/**
 * 욱채가 내는 비밀 값의 모양 (가리개의 고정 규칙 — 서버 기록 가리개 serve.ts serverRedactor도 redactWookSecretShapes로 같은 규칙을 쓴다, 리드 결정 S7-17 A2). S7F1a
 * - wos_: 서버의 대표 기기 세션 토큰 — 대표가 명령에 붙여 넣거나 CLI 출력에 섞여도 저장·표시 전에 가린다 (AC-20, 리드 결정 S3-14). 뒤에 토큰 글자가 더 붙어도
 *   (`wos_<43자>-x`·`_x`·`x`) 이어진 글자까지 통째로 가린다 — 43자가 넘는, 토큰이 아닌 `wos_…`까지 가려지는 것은 받아들인다 (리드 결정 S8-24)
 * - wsk_·wtt_: 외부 에이전트 키와 턴 토큰 (AC-20, 리드 결정 S7-3) — wos_와 같은 규칙: 32바이트 base64url(43자) 뒤에 토큰 글자가 더 붙어도 이어진 글자까지 통째로
 *   가린다. 서버는 에이전트 키를 처음 인증할 때 등록 값으로도 넣고(orchestrator/externalAgents.ts), 턴 토큰은 낼 때 넣는다(turns.ts) — 이 규칙은 그 전·밖의 글(서버
 *   기록, 앞 실행의 값, 운영자 명령의 쓰임새 오류)을 덮는다
 */
const WOOK_SECRET_SHAPES: readonly { re: RegExp; kind: string; hint: RegExp }[] = [
  { re: /\bwos_[A-Za-z0-9_-]{43,}/g, kind: REDACT_KINDS.wookSession, hint: /wos_/ },
  { re: /\bwsk_[A-Za-z0-9_-]{43,}/g, kind: REDACT_KINDS.wookAgentKey, hint: /wsk_/ },
  { re: /\bwtt_[A-Za-z0-9_-]{43,}/g, kind: REDACT_KINDS.wookTurnToken, hint: /wtt_/ },
];

/** 욱채 비밀 값의 모양 규칙(WOOK_SECRET_SHAPES)만 적용한다 — 가리개의 표시 그대로 (서버 기록 가리개가 쓴다, 리드 결정 S7-17 A2). S7F1a */
export function redactWookSecretShapes(text: string): string {
  let out = text;
  for (const s of WOOK_SECRET_SHAPES) if (s.hint.test(out)) out = out.replace(s.re, mark(s.kind));
  return out;
}

// PEM 개인 키 블록. JSON 문자열 안(이스케이프된 줄바꿈)이어도 블록 끝까지, 끝 표시가 없으면 이어지는 base64 줄까지
const PEM_BEGIN_RE = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----/g;
const PEM_TAIL_RE = /(?:(?:\r?\n|\\r\\n|\\n)?(?:[A-Za-z0-9+/=]{4,}|Proc-Type:[^\r\n"\\]*|DEK-Info:[^\r\n"\\]*))*(?:\r?\n|\\r\\n|\\n)?/y;

/** [from, to) 안에 이스케이프되지 않은 큰따옴표가 있는가 (JSON 문자열 경계를 넘지 않기 위해) */
function hasUnescapedQuote(s: string, from: number, to: number): boolean {
  for (let i = s.indexOf('"', from); i !== -1 && i < to; i = s.indexOf('"', i + 1)) {
    let bs = 0;
    for (let j = i - 1; j >= from && s.charCodeAt(j) === 92; j--) bs++;
    if (bs % 2 === 0) return true;
  }
  return false;
}

/** 정규식 하나로 BEGIN~END를 게으르게 찾으면 END 없는 BEGIN이 많을 때 제곱 시간이 되어 절차적으로 훑는다 */
function redactPem(s: string): string {
  const replacement = mark(REDACT_KINDS.privateKey);
  const endCache = new Map<string, number>();
  let out = '';
  let last = 0;
  PEM_BEGIN_RE.lastIndex = 0;
  for (let m = PEM_BEGIN_RE.exec(s); m !== null; m = PEM_BEGIN_RE.exec(s)) {
    const headerEnd = m.index + m[0].length;
    const endMarker = `-----END ${m[1]}PRIVATE KEY${m[2] ?? ''}-----`;
    let endIdx = endCache.get(endMarker);
    if (endIdx === undefined || (endIdx !== -1 && endIdx < headerEnd)) {
      endIdx = s.indexOf(endMarker, headerEnd);
      endCache.set(endMarker, endIdx);
    }
    let blockEnd: number;
    if (endIdx !== -1 && !hasUnescapedQuote(s, headerEnd, endIdx)) {
      blockEnd = endIdx + endMarker.length;
    } else {
      PEM_TAIL_RE.lastIndex = headerEnd;
      blockEnd = PEM_TAIL_RE.exec(s) ? PEM_TAIL_RE.lastIndex : headerEnd;
      // 줄바꿈은 블록 밖의 글자로 남긴다
      const tail = s.slice(headerEnd, blockEnd);
      const nl = /(?:\r?\n|\\r\\n|\\n)$/.exec(tail);
      if (nl) blockEnd -= nl[0].length;
    }
    out += s.slice(last, m.index) + replacement;
    last = blockEnd;
    PEM_BEGIN_RE.lastIndex = blockEnd;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** 개인 키를 가린 표시 (`[가림:개인 키]`) — 줄 단위로 흘려 받는 출력이 시작 표시와 끝 표시가 한 줄에 다 든 키(JSON 문자열의 \n 등) 자리에 넣는다 */
export const PRIVATE_KEY_MARK = mark(REDACT_KINDS.privateKey);
/** 여러 줄 개인 키의 창(시작 줄부터 끝 줄까지 n줄)을 가린 한 줄 `[가림:개인 키 — n줄]` (리드 결정 S5-35) */
export const privateKeyWindowMark = (lines: number): string => mark(`${REDACT_KINDS.privateKey} — ${lines}줄`);
/** 끝 줄 없이 닫힌 창의 표시 `[가림:개인 키(끝 줄 없음) — n줄 가림]` — n은 버린 줄(시작 줄 포함) 수 (리드 결정 S5-35) */
export const privateKeyUnterminatedMark = (hidden: number): string => mark(`${REDACT_KINDS.privateKey}(끝 줄 없음) — ${hidden}줄 가림`);
/** 담아 두는 상한(400줄·32KiB)에 닿아 흘려 보내기로 바꾼 창의 표시 — 그 뒤 끝 줄까지 키 본문으로 보이는 줄은 버린다 (리드 결정 S5-48) */
export const PRIVATE_KEY_SPILL_MARK = mark(`${REDACT_KINDS.privateKey} — 끝 줄 전까지 본문으로 보이는 줄은 가림`);
/** 흘려 보내던 창이 끝 줄에서 닫힌 표시 `[가림:개인 키 끝 — 본문으로 보이는 n줄 가림]` (리드 결정 S5-48) */
export const privateKeySpillEndMark = (hidden: number): string => mark(`${REDACT_KINDS.privateKey} 끝 — 본문으로 보이는 ${hidden}줄 가림`);
/** 흘려 보내던 창이 끝 줄 없이 출력 끝에서 닫힌 표시 `[가림:개인 키(끝 줄 없음) — 본문으로 보이는 n줄 가림]` (리드 결정 S5-48) */
export const privateKeySpillUnterminatedMark = (hidden: number): string => mark(`${REDACT_KINDS.privateKey}(끝 줄 없음) — 본문으로 보이는 ${hidden}줄 가림`);
/**
 * 개인 키 창 안에서 남기는 글의 base64 이어짐(16자 넘게)을 바꾼 표시 `[가림:개인 키 조각]` (리드 결정 S5-71) — 키 본문인지 가리지 않고 바꾼다(창 안의 해시·ID도).
 * 이어짐마다 하나씩이고 붙은 표시를 합치지 않는다(S5-81 1). 그 글을 가리개로 가린 뒤에 바꾼다(S5-78). base64 글자가 없어 앞뒤 글과 이어 붙어도 새 이어짐을
 * 만들지 않는다. 따옴표 키 이름에 이 표시가 들면 그 값은 비밀 값으로 가린다(shouldMaskQuoted)
 */
export const PRIVATE_KEY_PIECE_MARK = mark(`${REDACT_KINDS.privateKey} 조각`);

/** pemBeginIn이 쓰는 정규식 — 부를 때마다 만들지 않는다(긴 줄의 표시 걷기, 리드 결정 S5-55). 가리기 규칙(redactPem)의 것과 따로 둔다 */
const PEM_BEGIN_FIND = new RegExp(PEM_BEGIN_RE.source, 'g');

/**
 * 줄 안에서 from부터 찾은 첫 PEM 개인 키 시작 표시 — 가리기 규칙(redactPem)과 같은 종류(RSA·EC·OPENSSH·ENCRYPTED·PGP … PRIVATE KEY [BLOCK])다.
 * 그 자리(index), 시작 표시의 길이(length), 짝이 되는 끝 표시(end). 값싼 검사(includes('PRIVATE KEY'))를 먼저 한다 (리드 결정 S5-35)
 */
export function pemBeginIn(line: string, from = 0): { index: number; length: number; end: string } | null {
  if (!line.includes('PRIVATE KEY', from)) return null;
  const re = PEM_BEGIN_FIND;
  re.lastIndex = from;
  const m = re.exec(line);
  return m ? { index: m.index, length: m[0].length, end: `-----END ${m[1]}PRIVATE KEY${m[2] ?? ''}-----` } : null;
}

/** pemBeginAt이 쓰는 정규식 — 그 자리에서만 맞춘다(y). 뒤로 찾아가지 않으므로 긴 줄을 훑지 않는다 */
const PEM_BEGIN_AT = new RegExp(PEM_BEGIN_RE.source, 'y');

/**
 * 줄의 바로 그 자리(at)에서 시작하는 PEM 개인 키 시작 표시 — pemBeginIn과 같은 종류다. 그 자리에 없으면 null이고 뒤로 찾지 않는다. 창을 닫은 끝 표시의 끝
 * '-----'(다섯 자리)에서 시작하는 시작 표시를 찾는 데 쓴다 (리드 결정 S5-85)
 */
export function pemBeginAt(line: string, at: number): { index: number; length: number; end: string } | null {
  if (!line.startsWith('-----BEGIN ', at)) return null;
  const re = PEM_BEGIN_AT;
  re.lastIndex = at;
  const m = re.exec(line);
  return m ? { index: m.index, length: m[0].length, end: `-----END ${m[1]}PRIVATE KEY${m[2] ?? ''}-----` } : null;
}

const PEM_END_RE = /-----END ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----/g;

/**
 * 줄 안에서 from부터 찾은 첫 PEM 개인 키 끝 표시 — pemBeginIn과 같은 종류다. 그 자리(index), 길이(length), 끝 표시 글(end — pemBeginIn의 end와 같은 꼴이라
 * 종류를 맞춰 볼 수 있다). 한 창에 열린 키가 여럿일 때 어느 키의 끝인지 가리는 데 쓴다 (리드 결정 S5-55)
 */
export function pemEndIn(line: string, from = 0): { index: number; length: number; end: string } | null {
  if (!line.includes('PRIVATE KEY', from)) return null;
  const re = PEM_END_RE;
  re.lastIndex = from;
  const m = re.exec(line);
  return m ? { index: m.index, length: m[0].length, end: m[0] } : null;
}

const AWS_SECRET_ASSIGN_RE =
  /(?<![A-Za-z0-9_])((?:aws_?)?secret_?access_?key|aws_?session_?token)(["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{16,})/gi;

const AUTH_HEADER_RE = /(?<![A-Za-z0-9_-])((?:proxy-)?authorization)(\s*[:=][ \t]*)(?!\[가림:)([^\r\n"'\\]+)/gi;
const AUTH_SCHEME_RE = /^([A-Za-z][A-Za-z0-9-]{1,30})[ \t]+(?=\S)/;
const KNOWN_AUTH_SCHEMES = new Set(['bearer', 'basic', 'token', 'digest', 'bot', 'apikey', 'api-key', 'negotiate', 'ntlm', 'aws4-hmac-sha256', 'sso', 'ssws', 'key', 'oauth']);

const BEARER_RE = /(?<![A-Za-z0-9_-])(bearer)([ \t]+)(?!\[가림:)([A-Za-z0-9._~+/=-]{8,})/gi;

const URL_CRED_RE = /\b([a-z][a-z0-9+.-]{1,30}:\/\/)([^\s:@/?#"'\\<>[\]]{0,256}):(?!\[가림:)([^\s@/?#"'\\<>]{1,512})@/gi;
const URL_TOKEN_USER_RE = /\b([a-z][a-z0-9+.-]{1,30}:\/\/)(?!\[가림:)([A-Za-z0-9._~+-]{20,256})@/gi;

// "키": "값" (JSON) / \"키\": \"값\" (JSON 문자열 안의 JSON) / '키': '값' (파이썬 dict 표현)
const JSON_KV_RE = /"([^"\\\r\n]{1,128})"(\s*:\s*)"((?:[^"\\\r\n]|\\.)*)"/g;
const ESCAPED_JSON_KV_RE = /(?<!\\)\\"([^"\\\r\n]{1,128})\\"(\s*:\s*)\\"((?:(?!(?<!\\)\\")[^\r\n])*)\\"/g;
const SINGLE_QUOTED_KV_RE = /'([^'\\\r\n]{1,128})'(\s*:\s*)'((?:[^'\\\r\n]|\\.)*)'/g;
const XML_RE = /<([A-Za-z_][\w.-]{0,64})>([^<\r\n]{1,4096})<\/\1>/g;

const CLI_FLAG_RE = /(?<![A-Za-z0-9_-])(--?[A-Za-z][A-Za-z0-9_-]{0,60})([ \t]+)(?!-)(?!\[가림:)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s"'\\]+)/g;

// 키=값, 키: 값, 키 := 값 (환경 변수·.env·YAML·INI·코드·연결 문자열·URL 쿼리)
const ASSIGN_SOURCE =
  /(?<![A-Za-z0-9_.])(?=[A-Za-z0-9_.-]{0,80}?(?:key|token|secret|pass|pwd|credential|auth|cookie|pin|pat))([A-Za-z_][A-Za-z0-9_.-]{0,100})([ \t]*)(:=|=(?![=>~])|:(?![:/\\=]))([ \t]*)(?!\[가림:)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|\\"(?:(?!\\")[^\r\n])*\\"|[^\s"'`\\,;&|<>(){}[\]]+)/
    .source;
const ASSIGN_RE = new RegExp(ASSIGN_SOURCE, 'gi');
/** 가리지 않은 값 안을 다시 훑을 때 쓰는 별도 인스턴스 */
const ASSIGN_INNER_RE = new RegExp(ASSIGN_SOURCE, 'gi');

// 한국어 키: 비밀번호: 값, API 키: 값 ...
const KO_ASSIGN_RE =
  /(비밀\s?번호|패스워드|암호|비번|토큰|시크릿|(?:API|인증|비밀|액세스|접근|개인)\s?키)([ \t]*[:=：][ \t]*)(?!\[가림:)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s"'`\\,;&|<>(){}[\]]+)/gi;

type Quote = '"' | "'" | '\\"' | '';

function splitQuoted(value: string): { quote: Quote; inner: string } {
  if (value.length >= 4 && value.startsWith('\\"') && value.endsWith('\\"')) return { quote: '\\"', inner: value.slice(2, -2) };
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) return { quote: '"', inner: value.slice(1, -1) };
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) return { quote: "'", inner: value.slice(1, -1) };
  return { quote: '', inner: value };
}

const wrap = (quote: Quote, s: string): string => `${quote}${s}${quote}`;

const LINE_BREAK_RE = /\r?\n|\\r\\n|\\n/;
const CONFIG_LINE_HEAD_RE = /^[ \t]*(?:[-*][ \t]+|export[ \t]+|set[ \t]+|\$env:)?$/i;
const CONFIG_LINE_TAIL_RE = /^[ \t]*(?:#.*)?$/;

/** 대입이 그 줄의 전부인가 (`password: hunter`처럼 설정 파일 한 줄). JSON 문자열 안의 \n 줄바꿈도 줄로 본다 */
function isConfigLine(whole: string, start: number, end: number): boolean {
  const before = whole.slice(Math.max(0, start - 256), start).split(LINE_BREAK_RE).pop()!.split('"').pop()!;
  const after = whole.slice(end, end + 256).split(LINE_BREAK_RE)[0]!.split(/\\?"/)[0]!;
  return CONFIG_LINE_HEAD_RE.test(before) && CONFIG_LINE_TAIL_RE.test(after);
}

const PASSWORDISH_RE = /password|passwd|passphrase|secret/;

/**
 * 가리지 않은 값 안을 다시 훑는 깊이의 상한 (리드 결정 S5-83). 값 안의 대입(`note=password=abc`)은 그 값을 다시 훑어 찾는데, 공백 없이 이어 쓴 대입
 * (`key=key=…`·`key:key:…`·`tokenType=tokenType=…`)은 대입마다 한 단계씩 깊어져 약 1,200~2,000번이면 스택을 다 써 RangeError를 던졌고, 단계마다 남은
 * 값 전체를 다시 훑어 시간도 제곱이었다. 상한에 닿으면 남은 값 전체를 값 하나로 보고 가린다(더 가리기만 한다). 실제 값 안의 대입은 한두 단계다
 */
const ASSIGN_RESCAN_MAX = 16;

/** ASSIGN_RE의 바꾸기 — depth: 가리지 않은 값 안을 다시 훑은 깊이 (맨 바깥 0) */
const assignReplacer = (...args: unknown[]): string => assignReplaceAt(0, args);

function assignReplaceAt(depth: number, args: unknown[]): string {
  const [m, key, sp1, sep, sp2, value, offset, whole] = args as [string, string, string, string, string, string, number, string];
  const head = `${key}${sp1}${sep}${sp2}`;
  const { quote, inner } = splitQuoted(value);
  const keep = (): string => {
    // 가리지 않는 값 안에 또 다른 대입이 있을 수 있다 (예: note=password=abc)
    if (quote !== '' || !/[=:]/.test(inner)) return m;
    // 이어 쓴 대입은 깊이 상한까지만 다시 훑고, 넘으면 남은 값을 값 하나로 보고 가린다 — 스택을 쌓지 않는다 (리드 결정 S5-83)
    if (depth >= ASSIGN_RESCAN_MAX) return head + SECRET_MARK;
    return head + inner.replace(ASSIGN_INNER_RE, (...a: unknown[]) => assignReplaceAt(depth + 1, a));
  };
  const cls = classifyKey(key);
  if (!cls || inner.length === 0 || isReference(inner) || PLACEHOLDER_RE.test(inner)) return keep();
  const comps = splitKeyComponents(key);
  // Authorization 헤더 줄은 인증 헤더 규칙이 맡는다 (방식 이름 Bearer 등은 남김)
  if (comps[comps.length - 1] === 'authorization') return m;
  const passwordish = comps.some((c) => PASSWORDISH_RE.test(c));
  // GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json 처럼 키 파일 위치는 비밀 값이 아니다
  if (!passwordish && PATH_LIKE_RE.test(inner)) return keep();
  if (quote === '') {
    const upperKey = /[A-Z]/.test(key) && !/[a-z]/.test(key);
    const envLine = upperKey && sep === '=' && sp1 === '' && sp2 === '';
    if (!envLine) {
      // 코드 문맥: 타입 이름·참조 식·함수 호출·색인은 실제 값이 아니다
      if (CODE_WORDS.has(inner.toLowerCase()) || DOTTED_IDENT_RE.test(inner)) return keep();
      const next = whole.charAt(offset + m.length);
      if (next === '(' || next === '[') return keep();
      if (!looksLikeToken(inner)) {
        if (isCamelIdent(inner)) return keep();
        // `키: 값` 산문 문맥(콜론 + 공백)은 설정 줄이거나 비밀번호처럼 보이는 값만
        if (sep === ':' && sp2.length > 0 && !looksLikeSecretValue(inner) && !isConfigLine(whole, offset, offset + m.length)) {
          return keep();
        }
      }
    }
  }
  if (cls === 'weak' && !looksLikeToken(inner)) return keep();
  return head + wrap(quote, SECRET_MARK);
}

function quotedKvRule(re: RegExp, open: string, close: string): Rule {
  return {
    // 조각 표시가 이름을 바꾼 키도 본다 (shouldMaskQuoted, 리드 결정 S5-78)
    hint: (s) => KEYWORD_HINT(s) || s.includes(PRIVATE_KEY_PIECE_MARK),
    run: (s) =>
      s.replace(re, (m: string, key: string, sep: string, inner: string) =>
        shouldMaskQuoted(key, inner) ? `${open}${key}${close}${sep}${open}${SECRET_MARK}${close}` : m,
      ),
  };
}

const BUILTIN_RULES: readonly Rule[] = [
  { hint: (s) => s.includes('PRIVATE KEY'), run: redactPem },
  fixedRule(/\bsk-ant-[A-Za-z0-9_-]{16,}/g, REDACT_KINDS.anthropic, /sk-ant-/),
  fixedRule(/\bsk-(?!ant-)(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}/g, REDACT_KINDS.openai, /sk-/, (m) =>
    isRandomKeyBody(m.replace(/^sk-(?:proj-|svcacct-|admin-|None-)?/, '')),
  ),
  fixedRule(/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, REDACT_KINDS.aws, /A(?:KIA|SIA|BIA|CCA)/),
  {
    hint: has(/secret_?access|session_?token/i),
    run: (s) => s.replace(AWS_SECRET_ASSIGN_RE, (_m: string, k: string, sep: string) => `${k}${sep}${mark(REDACT_KINDS.awsSecret)}`),
  },
  fixedRule(/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g, REDACT_KINDS.github, /gh[pousr]_|github_pat_/),
  fixedRule(/\b(?:xox[abeoprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/g, REDACT_KINDS.slack, /xox[abeoprs]-|xapp-/),
  fixedRule(/\bAIza[0-9A-Za-z_-]{30,}/g, REDACT_KINDS.googleApi, /AIza/),
  fixedRule(/\bGOCSPX-[0-9A-Za-z_-]{16,}|\bya29\.[0-9A-Za-z_-]{20,}|(?<![0-9A-Za-z_/])1\/\/0[0-9A-Za-z_-]{30,}/g, REDACT_KINDS.googleOAuth, /GOCSPX-|ya29\.|1\/\/0/),
  fixedRule(/\bgl(?:pat|dt|rt|ptt|ft|cbt|imt|soat|oas|agent)-[0-9A-Za-z_-]{20,}/g, REDACT_KINDS.gitlab, /gl[a-z]{1,5}-/),
  fixedRule(/\bnpm_[A-Za-z0-9]{30,}/g, REDACT_KINDS.npm, /npm_/),
  fixedRule(/\bpypi-AgE[A-Za-z0-9_-]{30,}/g, REDACT_KINDS.pypi, /pypi-/),
  fixedRule(/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|\bwhsec_[0-9A-Za-z]{20,}/g, REDACT_KINDS.stripe, /_(?:live|test)_|whsec_/),
  fixedRule(/\bhf_[A-Za-z0-9]{30,}/g, REDACT_KINDS.huggingface, /hf_/),
  fixedRule(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACT_KINDS.sendgrid, /SG\./),
  fixedRule(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACT_KINDS.jwt, /eyJ/),
  // 욱채가 내는 비밀 값의 모양 wos_·wsk_·wtt_ (WOOK_SECRET_SHAPES — 서버 기록 가리개 serve.ts가 같은 규칙을 쓴다, 리드 결정 S7-17 A2)
  ...WOOK_SECRET_SHAPES.map((s) => fixedRule(s.re, s.kind, s.hint)), // S7F1a

  {
    hint: has(/authorization/i),
    run: (s) =>
      s.replace(AUTH_HEADER_RE, (m: string, name: string, sep: string, value: string) => {
        const scheme = AUTH_SCHEME_RE.exec(value);
        const rest = scheme ? value.slice(scheme[0].length) : value;
        const cred = rest.trim().split(/\s+/)[0] ?? '';
        const knownScheme = scheme !== null && KNOWN_AUTH_SCHEMES.has(scheme[1]!.toLowerCase());
        if (!looksLikeToken(cred) && !(knownScheme && cred.length >= 8)) return m;
        const trailing = /\s*$/.exec(value)?.[0] ?? '';
        return `${name}${sep}${scheme ? scheme[0] : ''}${mark(REDACT_KINDS.authHeader)}${trailing}`;
      }),
  },
  {
    hint: has(/bearer/i),
    run: (s) =>
      s.replace(BEARER_RE, (m: string, word: string, sp: string, tok: string) =>
        looksLikeToken(tok) || tok.length >= 20 ? `${word}${sp}${mark(REDACT_KINDS.bearer)}` : m,
      ),
  },
  {
    hint: (s) => s.includes('://') && s.includes('@'),
    run: (s) =>
      s
        .replace(URL_CRED_RE, (_m: string, scheme: string, user: string) => `${scheme}${user}:${mark(REDACT_KINDS.urlPassword)}@`)
        .replace(URL_TOKEN_USER_RE, (m: string, scheme: string, user: string) =>
          looksLikeToken(user) ? `${scheme}${mark(REDACT_KINDS.urlToken)}@` : m,
        ),
  },
  quotedKvRule(JSON_KV_RE, '"', '"'),
  quotedKvRule(ESCAPED_JSON_KV_RE, '\\"', '\\"'),
  quotedKvRule(SINGLE_QUOTED_KV_RE, "'", "'"),
  {
    hint: KEYWORD_HINT,
    run: (s) =>
      s.replace(XML_RE, (m: string, tag: string, inner: string) =>
        classifyKey(tag) === 'strong' && inner.trim().length > 0 && !isReference(inner.trim()) ? `<${tag}>${SECRET_MARK}</${tag}>` : m,
      ),
  },
  {
    hint: KEYWORD_HINT,
    run: (s) =>
      s.replace(CLI_FLAG_RE, (m: string, flag: string, sp: string, value: string) => {
        if (classifyKey(flag.replace(/^-+/, '')) !== 'strong') return m;
        const { quote, inner } = splitQuoted(value);
        if (inner.length === 0 || isReference(inner) || PLACEHOLDER_RE.test(inner)) return m;
        if (quote === '' && !looksLikeSecretValue(inner)) return m;
        return `${flag}${sp}${wrap(quote, SECRET_MARK)}`;
      }),
  },
  { hint: KEYWORD_HINT, run: (s) => s.replace(ASSIGN_RE, assignReplacer) },
  {
    hint: has(/비밀|패스워드|암호|비번|토큰|시크릿|키/),
    run: (s) =>
      s.replace(KO_ASSIGN_RE, (m: string, key: string, sep: string, value: string) => {
        const { quote, inner } = splitQuoted(value);
        if (inner.length < 4 || HANGUL_RE.test(inner) || isReference(inner) || PLACEHOLDER_RE.test(inner)) return m;
        // '토큰: 6789'는 사용량 숫자다
        if (key === '토큰' && /^[\d,.]+$/.test(inner)) return m;
        return `${key}${sep}${wrap(quote, SECRET_MARK)}`;
      }),
  },
];

// ───────────────────────── 등록 값 ─────────────────────────

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const jsonEscape = (s: string): string => JSON.stringify(s).slice(1, -1);
const asciiJsonEscape = (s: string): string =>
  jsonEscape(s).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** 등록 값이 저장 경로에서 나타날 수 있는 모습: 원문, JSON 이스케이프(1·2단), \u 이스케이프, URL 인코딩 */
function secretVariants(secret: string): string[] {
  const once = jsonEscape(secret);
  const out = new Set<string>([secret, once, jsonEscape(once), asciiJsonEscape(secret)]);
  // 짝 없는 서로게이트는 URL 인코딩할 수 없다(URIError) — 그 경우 원문·JSON 모습으로만 가린다
  if (!LONE_SURROGATE_RE.test(secret)) out.add(encodeURIComponent(secret));
  return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

function sanitizeKind(kind: string | undefined): string {
  const k = (kind ?? '').replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  return k.length > 0 ? k : REDACT_KINDS.registered;
}

interface Literal {
  readonly text: string;
  kind: string;
  /** 짧은 값은 영숫자 경계에서만 */
  readonly bounded: boolean;
}

const isAlnumCode = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** 앞 2글자 → 16비트 (빠른 거르기 비트맵 색인) */
const hash2 = (s: string, i: number): number => (Math.imul(s.charCodeAt(i), 0x9e3779b1) ^ s.charCodeAt(i + 1)) >>> 16;

// 굴림 해시 (mod 2^32): h = Σ c[k]·B^(L-1-k)
const ROLL_BASE = 1_000_003;
function rangeHash(s: string, start: number, len: number): number {
  let h = 0;
  for (let k = 0; k < len; k++) h = (Math.imul(h, ROLL_BASE) + s.charCodeAt(start + k)) | 0;
  return h;
}
function powBase(exp: number): number {
  let p = 1;
  for (let k = 0; k < exp; k++) p = Math.imul(p, ROLL_BASE);
  return p;
}

interface LengthGroup {
  readonly len: number;
  /** B^(len-1) */
  readonly pow: number;
  /** 값 전체의 해시 → 값들 (충돌은 startsWith로 가린다) */
  readonly byHash: Map<number, Literal[]>;
}

/**
 * 등록 값 묶음 (같은 길이끼리 값 전체의 굴림 해시로 찾는다). 오케스트레이터는 턴마다 토큰을 addSecret하므로 값이 계속
 * 늘어난다 — 정규식 하나로 묶으면 추가할 때마다 전체를 다시 만들어야 했다(실측 1000개당 약 4ms). 여기서는 추가가 O(1),
 * 찾기는 글 길이 × 서로 다른 길이 수에 비례하고, 앞부분이 같은 값(sk-ant-api03-…)이 많아도 느려지지 않는다.
 */
class LiteralSet {
  private readonly byText = new Map<string, Literal>();
  private readonly groups = new Map<number, LengthGroup>();
  /** 긴 길이부터 — 같은 자리에서는 가장 긴 값을 고른다 (정규식 대안을 길이순으로 둔 것과 같은 결과) */
  private lengthsDesc: LengthGroup[] = [];
  private readonly pairFilter = new Uint8Array(65536);

  get size(): number {
    return this.byText.size;
  }

  add(text: string, kind: string): void {
    const existing = this.byText.get(text);
    if (existing) {
      existing.kind = kind;
      return;
    }
    const lit: Literal = { text, kind, bounded: text.length < BOUNDED_SECRET_LENGTH };
    this.byText.set(text, lit);
    let group = this.groups.get(text.length);
    if (!group) {
      group = { len: text.length, pow: powBase(text.length - 1), byHash: new Map() };
      this.groups.set(text.length, group);
      this.lengthsDesc = [...this.groups.values()].sort((a, b) => b.len - a.len);
    }
    const h = rangeHash(text, 0, text.length);
    const list = group.byHash.get(h);
    if (list) list.push(lit);
    else group.byHash.set(h, [lit]);
    this.pairFilter[hash2(text, 0)] = 1;
  }

  replace(s: string): string {
    if (this.byText.size === 0 || s.length < MIN_SECRET_LENGTH) return s;
    const n = s.length;
    const groups = this.lengthsDesc.filter((g) => g.len <= n);
    if (groups.length === 0) return s;
    const hashes = groups.map((g) => rangeHash(s, 0, g.len));
    let out = '';
    let last = 0;
    for (let i = 0; i < n; i++) {
      if (i >= last && i + 1 < n && this.pairFilter[hash2(s, i)] === 1) {
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi]!;
          const stop = i + g.len;
          if (stop > n) continue;
          const cands = g.byHash.get(hashes[gi]!);
          if (!cands) continue;
          const lit = cands.find(
            (c) =>
              s.startsWith(c.text, i) &&
              (!c.bounded || ((i === 0 || !isAlnumCode(s.charCodeAt(i - 1))) && (stop === n || !isAlnumCode(s.charCodeAt(stop))))),
          );
          if (!lit) continue;
          out += s.slice(last, i) + mark(lit.kind);
          last = stop;
          break;
        }
      }
      // 다음 자리의 해시로 굴린다 (가린 구간 안에서도 계속 굴려야 뒤 자리 해시가 맞다)
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]!;
        if (i + g.len < n) {
          hashes[gi] = (Math.imul((hashes[gi]! - Math.imul(s.charCodeAt(i), g.pow)) | 0, ROLL_BASE) + s.charCodeAt(i + g.len)) | 0;
        }
      }
    }
    return last === 0 ? s : out + s.slice(last);
  }
}

// ───────────────────────── 가리개 ─────────────────────────

const BUILTIN_KIND_NAMES: readonly string[] = Object.values(REDACT_KINDS);

export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const registered = new LiteralSet();
  /** addPattern으로 더한 꼴 (S3-18) */
  const patterns: { re: RegExp; kind: string }[] = [];
  const kinds = new Set<string>(BUILTIN_KIND_NAMES);
  let markerRe: RegExp | null = null;
  let dirty = true;

  /** 가림 표시 정규식 — 새 종류 이름이 생길 때만 다시 만든다 */
  const rebuild = (): void => {
    dirty = false;
    const kindAlternation = [...kinds].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    markerRe = new RegExp(`\\[가림:(?:${kindAlternation})\\]`, 'g');
  };

  /** 이미 가린 표시는 건드리지 않고, 그 사이 구간에만 fn을 적용한다 */
  const mapUnprotected = (s: string, fn: (seg: string) => string): string => {
    if (!s.includes(MARK_OPEN)) return fn(s);
    const re = markerRe!;
    re.lastIndex = 0;
    let out = '';
    let last = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      if (m.index > last) out += fn(s.slice(last, m.index));
      out += m[0];
      last = m.index + m[0].length;
    }
    if (last < s.length) out += fn(s.slice(last));
    return out;
  };

  const applyRule = (s: string, rule: Rule): string =>
    mapUnprotected(s, (seg) => (seg.length === 0 || (rule.hint !== null && !rule.hint(seg)) ? seg : rule.run(seg)));

  const pass = (input: string): string => {
    let s = input;
    if (registered.size > 0) s = mapUnprotected(s, (seg) => registered.replace(seg));
    for (const p of patterns) s = mapUnprotected(s, (seg) => seg.replace(p.re, mark(p.kind)));
    for (const rule of BUILTIN_RULES) s = applyRule(s, rule);
    return s;
  };

  /** 실패를 알리는 중인지 — 알리는 쪽(로그)이 가리개를 다시 불러 또 실패해도 다시 알리지 않는다 */
  let reporting = false;
  /**
   * 가리개 안의 실패 (리드 결정 S5-83) — 그 글 대신 '[가림:가리기 실패]'를 돌려주고 onFailure로 한 번 알린다(내용 없이: 어디서·오류 이름·길이). 알리는 쪽이
   * 던져도, 알리는 중에 다시 실패해도 던지지 않는다
   */
  const failed = (where: RedactFailure['where'], error: unknown, length: number | null): string => {
    if (opts.onFailure && !reporting) {
      reporting = true;
      try {
        opts.onFailure({ where, error: typeof error === 'string' ? error : error instanceof Error ? error.name : typeof error, length });
      } catch {
        // 알리는 쪽의 오류로 가리개가 던지지 않는다
      } finally {
        reporting = false;
      }
    }
    return REDACT_FAILED_MARK;
  };

  const passes = (s: string): string => {
    if (dirty) rebuild();
    let cur = s;
    // 한 규칙이 가린 자리 옆에서 앞 규칙이 새로 맞을 수 있어, 바뀌지 않을 때까지 되풀이한다 (가린 글자는 줄어들기만 하므로 끝난다)
    for (let i = 0; i < MAX_PASSES; i++) {
      const next = pass(cur);
      if (next === cur) return cur;
      cur = next;
    }
    return cur;
  };

  /** 가리개의 바깥 함수는 던지지 않는다 — 안에서 어떤 오류를 만나도 그 글을 통째로 '[가림:가리기 실패]'로 바꾼다(원문을 남기지 않는다, 리드 결정 S5-83) */
  const text = (s: string): string => {
    if (typeof s !== 'string' || s.length < MIN_SECRET_LENGTH) return s;
    try {
      return passes(s);
    } catch (e) {
      return failed('text', e, s.length);
    }
  };

  const maskString = (s: string, cls: KeyClass): string => {
    if (s.length === 0) return s;
    if (cls === 'weak' && !looksLikeToken(s)) return text(s);
    if (dirty) rebuild();
    markerRe!.lastIndex = 0;
    const whole = markerRe!.exec(s);
    if (whole && whole.index === 0 && whole[0].length === s.length) return s;
    return SECRET_MARK;
  };

  const define = (target: object, key: string, val: unknown, enumerable = true): void => {
    Object.defineProperty(target, key, { value: val, enumerable, writable: true, configurable: true });
  };

  /** depth: 맨 바깥 값에서 들어간 깊이 — CLONE_MAX_DEPTH에 닿으면 그 아래를 통째로 표시로 둔다(스택을 다 써 던지지 않게, 리드 결정 S5-83) */
  const clone = (v: unknown, inherited: KeyClass | null, seen: WeakMap<object, unknown>, depth: number): unknown => {
    if (typeof v === 'string') return inherited ? maskString(v, inherited) : text(v);
    if (v === null || typeof v !== 'object') return v;
    const cached = seen.get(v);
    if (cached !== undefined) return cached;
    if (depth >= CLONE_MAX_DEPTH) return failed('value', '깊이 상한', null);
    const d = depth + 1;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      seen.set(v, out);
      for (let i = 0; i < v.length; i++) out.push(clone(v[i], inherited, seen, d));
      return out;
    }
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof RegExp) return new RegExp(v.source, v.flags);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
    if (v instanceof Map) {
      const out = new Map<unknown, unknown>();
      seen.set(v, out);
      for (const [k, val] of v) {
        const cls = inherited ?? (typeof k === 'string' ? classifyKey(k) : null);
        out.set(typeof k === 'string' ? text(k) : k, clone(val, cls, seen, d));
      }
      return out;
    }
    if (v instanceof Set) {
      const out = new Set<unknown>();
      seen.set(v, out);
      for (const item of v) out.add(clone(item, inherited, seen, d));
      return out;
    }
    const out = Object.create(Object.getPrototypeOf(v) as object | null) as Record<string, unknown>;
    seen.set(v, out);
    if (v instanceof Error) {
      // message·stack·cause는 열거되지 않는 속성이라 따로 복사한다
      for (const name of Object.getOwnPropertyNames(v)) {
        const desc = Object.getOwnPropertyDescriptor(v, name);
        if (!desc || !('value' in desc)) continue;
        const cls = inherited ?? classifyKey(name);
        define(out, name, clone(desc.value, cls, seen, d), desc.enumerable ?? false);
      }
      return out;
    }
    for (const key of Object.keys(v)) {
      const cls = inherited ?? classifyKey(key);
      define(out, text(key), clone((v as Record<string, unknown>)[key], cls, seen, d));
    }
    return out;
  };

  const redactor: Redactor = {
    text,
    value<T>(v: T): T {
      try {
        return clone(v, null, new WeakMap(), 0) as T;
      } catch (e) {
        // 던지지 않는다 — 값 전체를 표시로 (리드 결정 S5-83). 글 하나의 실패는 text가 이미 그 글만 표시로 바꿨다
        return failed('value', e, null) as unknown as T;
      }
    },
    addSecret(secret: string, kind?: string): void {
      if (typeof secret !== 'string') return;
      const s = secret.trim();
      if (s.length < MIN_SECRET_LENGTH) return;
      const k = sanitizeKind(kind);
      if (!kinds.has(k)) {
        kinds.add(k);
        dirty = true;
      }
      for (const v of secretVariants(s)) registered.add(v, k);
    },
    addPattern(pattern: RegExp, kind?: string): void {
      if (!(pattern instanceof RegExp)) return;
      const k = sanitizeKind(kind);
      if (!kinds.has(k)) {
        kinds.add(k);
        dirty = true;
      }
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      if (patterns.some((p) => p.re.source === pattern.source && p.re.flags === flags)) return;
      patterns.push({ re: new RegExp(pattern.source, flags), kind: k });
    },
  };

  for (const s of opts.extraSecrets ?? []) redactor.addSecret(s);
  return redactor;
}
