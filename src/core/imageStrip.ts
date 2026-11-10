/**
 * CLI 이벤트에서 이미지 바이트를 뺀다 (리드 결정 S6-7 '새는 곳', S6-21 C1). 화면 캡처·시험 이미지는 가릴 수 없으므로(SEC-10은 글에만 된다) 보관 규칙
 * (24시간·500장, 백업·내보내기 밖)을 지키려면 이벤트 파일·화면 푸시(cliEvents)·도구 결과 기록에 바이트가 남지 않아야 한다.
 *
 * 모양이 아니라 내용으로 뺀다 — CLI는 같은 이미지를 한 줄에 여러 모양으로 싣는다 (Claude Code가 캡처 파일을 Read로 열면 그 줄에 두 번 온다:
 * `message.content[].content[]`의 이미지 블록과 `tool_use_result: {type:'image', file:{base64, …}}`). 아는 모양만 빼면 새 모양이 샌다.
 * - (가) 값 어디에 있든, 이미지 서명으로 시작하는 긴 base64 글: PNG `iVBORw0KGgo`, JPEG `/9j/`, GIF `R0lGOD`, WebP(RIFF) `UklGR`. 글 안에 박혀 있어도
 *   (JSON을 글로 넣은 도구 결과 등) 그 부분만 바꾼다. 서명은 base64 글의 맨 앞에서만 본다 — 다른 base64의 가운데에 우연히 든 같은 글자는 건드리지 않는다.
 * - (나) `type`이 `image`(또는 `input_image`·`image_url`)인 개체의 `data` · `source.data` · `file.base64` · `base64` · `image_url`(주소가 아닌 글).
 * - (다) `data:image/…;base64,…` 꼴의 글 (Codex의 input_image·image_url 등).
 * 그 자리에 `[이미지 n바이트 — 저장하지 않음]`.
 * - 가리기(redact.value)보다 먼저 부른다 — 수 MB의 base64를 가리개에 돌리지 않는다.
 * - 깊은 복사이고 던지지 않는다. 바꿀 것이 없으면 같은 값을 그대로 돌려준다(복사하지 않음).
 */

/** 뺀 자리에 남기는 글 */
export const imageOmitted = (bytes: number): string => `[이미지 ${bytes.toLocaleString('en-US')}바이트 — 저장하지 않음]`;

const DATA_URL_RE = /data:image\/[a-z0-9.+-]{1,40};base64,[A-Za-z0-9+/=\r\n]{16,}/gi;
/**
 * 이미지 서명으로 시작하는 base64 글 (앞 글자가 base64 글자가 아닐 때만 — 글의 맨 앞이거나 따옴표·빈칸 뒤, 또는 JSON을 글로 한 번 더 넣으며 쓴 `\n`·`\r`·`\t`
 * 뒤). JSON을 한 번 더 글로 넣으며 `/`를 `\/`로 쓴 것도 잇는다
 */
const SIGNED_B64_RE = /(?:(?<![A-Za-z0-9+/\\])|(?<=\\[nrt]))(?:iVBORw0KGgo|\\?\/9j\\?\/|R0lGOD|UklGR)(?:[A-Za-z0-9+/]|\\\/)*={0,2}/g;
const SIGNATURE_HINT_RE = /iVBORw0KGgo|\/9j\\?\/|R0lGOD|UklGR/;
/** 이보다 짧은 것은 이미지 바이트로 보지 않는다 (base64 글자 수 — 192바이트. 캡처·시험 이미지는 수 KB부터다) */
const MIN_SIGNED_B64 = 256;
const MAX_DEPTH = 64;
/** 이미지 개체로 보는 type */
const IMAGE_TYPES: ReadonlySet<unknown> = new Set(['image', 'input_image', 'image_url']);

/** base64 글 길이 → 바이트 수 (대략, 줄바꿈 무시) */
function b64Bytes(s: string): number {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  return Math.floor((clean.length * 3) / 4);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stripString(s: string): string {
  if (s.length < 32) return s;
  let out = s;
  if (out.includes('base64,')) out = out.replace(DATA_URL_RE, (m) => imageOmitted(b64Bytes(m.slice(m.indexOf(',') + 1))));
  if (out.length >= MIN_SIGNED_B64 && SIGNATURE_HINT_RE.test(out)) out = out.replace(SIGNED_B64_RE, (m) => (m.length >= MIN_SIGNED_B64 ? imageOmitted(b64Bytes(m)) : m));
  return out;
}

/** 이미지 개체의 바이트 칸 하나 — 빈 글이 아니면 바꾼 글, 아니면 null (바꾸지 않음) */
function omitField(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? imageOmitted(b64Bytes(v)) : null;
}

/** 이미지 개체면 바이트를 뺀 사본, 아니면 null */
function stripBlock(o: Record<string, unknown>): Record<string, unknown> | null {
  if (!IMAGE_TYPES.has(o.type)) return null;
  let changed = false;
  const out: Record<string, unknown> = { ...o };
  for (const k of ['data', 'base64'] as const) {
    const omitted = omitField(o[k]);
    if (omitted === null) continue;
    out[k] = omitted;
    changed = true;
  }
  // image_url: 주소(http·https·file)는 바이트가 아니다 — 그대로 둔다. 그 밖의 글(base64·data: 주소)은 뺀다
  if (typeof o.image_url === 'string' && o.image_url.length > 0 && !/^(https?|file):\/\//i.test(o.image_url)) {
    out.image_url = imageOmitted(b64Bytes(o.image_url.slice(o.image_url.indexOf(',') + 1)));
    changed = true;
  }
  for (const [k, field] of [['source', 'data'], ['file', 'base64']] as const) {
    const inner = o[k];
    if (!isRecord(inner)) continue;
    const omitted = omitField(inner[field]);
    if (omitted === null) continue;
    out[k] = { ...inner, [field]: omitted };
    changed = true;
  }
  return changed ? out : null;
}

function walk(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return stripString(v);
  if (depth >= MAX_DEPTH || typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = walk(x, depth + 1);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  const o = v as Record<string, unknown>;
  const block = stripBlock(o);
  const base = block ?? o;
  let changed = block !== null;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(base)) {
    const y = walk(x, depth + 1);
    if (y !== x) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

/** 값 안의 이미지 바이트를 모두 뺀다 (깊은 복사 — 바꿀 것이 없으면 그대로). 던지지 않는다 */
export function stripImages<T>(v: T): T {
  try {
    return walk(v, 0) as T;
  } catch {
    return v;
  }
}
