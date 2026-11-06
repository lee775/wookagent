/**
 * 서버가 내주는 웹 화면 빌드의 약속 (리드 결정 S8-4·S8-5) — 서버(http.ts·server.ts)와 웹 빌드 설정(vite.web.config.ts)이 같이 쓴다. 의존 없이 둔다
 * (Vite 설정 불러오기가 별칭을 모른다).
 * - 빌드 표시: `npm run build:web`(Vite mode `remote`)이 만든 index.html에만 `<meta name="wook-build" content="remote">`가 있다. 서버는 이 표시가 없는
 *   `--web-dir`로 시작하지 않는다 — 가짜 API로 도는 개발용 화면이 실제 서버 주소에서 가짜 자료를 보여 주지 않게 (S2-8의 까닭)
 * - CSP: `--web-dir`의 HTML 응답 머리가 실제 정책이다. 빌드한 index.html의 meta는 같은 정책에서 frame-ancestors만 뺀 것이다(meta에서는 듣지 않는다).
 *   데스크톱 화면의 루프백 주소(`ws://127.0.0.1:*`·`http://127.0.0.1:*`)는 서버용 빌드에 없다
 * - 빌드 검사: 서버용 빌드에는 가짜 브리지(`src/renderer/src/api/fake/`)가 들어가지 않고 index.html에 루프백 주소가 없다 — 어기면 빌드가 실패한다
 */

/** 서버용 빌드의 index.html에 넣는 표시 */
export const WEB_BUILD_MARKER = '<meta name="wook-build" content="remote">';

const MARKER_RE = /<meta\s+name\s*=\s*["']wook-build["']\s+content\s*=\s*["']remote["']\s*\/?>/i;

/** index.html에 서버용 빌드 표시가 있는지 */
export function hasWebBuildMarker(html: string): boolean {
  return MARKER_RE.test(html);
}

/** 서버용 웹 화면의 CSP 지시문 (S8-5). three.js의 GLB 텍스처는 blob: 그림으로 읽힌다(img-src) */
const WEB_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

/** `--web-dir`의 HTML 응답에 붙이는 CSP 머리 */
export const WEB_SCREEN_CSP = [...WEB_CSP_DIRECTIVES, "frame-ancestors 'none'"].join('; ');

/** 서버용 빌드의 index.html meta CSP — 머리와 같은 정책에서 frame-ancestors만 뺀다(meta에서는 듣지 않고 경고만 남는다) */
export const WEB_SCREEN_META_CSP = WEB_CSP_DIRECTIVES.join('; ');

/** 데스크톱 화면의 meta CSP에 있는 루프백 주소 — 서버용 빌드의 index.html에는 없어야 한다 */
const LOOPBACK_RE = /ws:\/\/|127\.0\.0\.1|localhost|\[::1\]/i;

/**
 * 가짜 브리지에만 있는 글자 (api/fake/index.ts·data.ts의 알림 ID — 압축해도 그대로 남는 ASCII). 모듈 목록과 함께 본다 — 빌드가 모듈 목록을 주지 않아도
 * 걸리게. 가짜 자료에서 이 글자를 지우면 webStatic 시험이 알려 준다
 */
export const FAKE_BRIDGE_MARKERS: readonly string[] = ['N-SEAT-CHANGED', 'review-stuck:T-0004:M-MAIN'];

export interface BuiltChunk {
  fileName: string;
  code: string;
  /** 그 조각에 든 모듈의 실제 경로 (빌드가 주면) */
  moduleIds: readonly string[];
}

/**
 * 서버용 빌드 결과에서 어긋난 것들 (없으면 빈 목록). `fakeDir`는 가짜 브리지 폴더의 실제 경로다(구분자는 어느 쪽이든)
 * - index.html에 빌드 표시가 없음, 루프백 주소가 있음, CSP meta가 서버용 정책이 아님
 * - 어느 조각이든 가짜 브리지 폴더의 모듈을 품거나 가짜 브리지에만 있는 글자를 품음
 */
export function remoteBuildProblems(o: { html: string | null; chunks: readonly BuiltChunk[]; fakeDir: string }): string[] {
  const problems: string[] = [];
  if (o.html === null) problems.push('index.html이 빌드 결과에 없습니다');
  else {
    if (!hasWebBuildMarker(o.html)) problems.push(`index.html에 서버용 빌드 표시(${WEB_BUILD_MARKER})가 없습니다`);
    if (LOOPBACK_RE.test(o.html)) problems.push('index.html에 루프백 주소(ws://·127.0.0.1·localhost·[::1])가 남아 있습니다 — 서버용 CSP에는 두지 않습니다');
    if (!o.html.includes(`content="${WEB_SCREEN_META_CSP}"`)) problems.push('index.html의 CSP meta가 서버용 정책과 다릅니다');
  }
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const fake = norm(o.fakeDir).replace(/\/?$/, '/');
  for (const chunk of o.chunks) {
    const ids = chunk.moduleIds.filter((id) => norm(id).startsWith(fake));
    if (ids.length > 0) problems.push(`${chunk.fileName}에 가짜 브리지 모듈이 들어 있습니다: ${ids.map((id) => id.replace(/\\/g, '/').split('/').slice(-2).join('/')).join(', ')}`);
    const found = FAKE_BRIDGE_MARKERS.filter((m) => chunk.code.includes(m));
    if (found.length > 0) problems.push(`${chunk.fileName}에 가짜 브리지의 글자가 들어 있습니다: ${found.join(', ')}`);
  }
  return problems;
}
