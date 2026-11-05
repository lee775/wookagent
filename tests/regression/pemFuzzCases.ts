/**
 * host_exec 출력 모으기(HostExecOutput)의 개인 키 퍼즈 경우 (리드 결정 S5-48·S5-55) — hostExecRedact와 autocheckOutputTail(S5-54: 자동 검사도 같은 출력
 * 모으기로)이 함께 쓴다. 키는 만든 가짜 값뿐이다(무작위 base64).
 * - fuzzCase: 키 1~3개를 차례로 찍는다 — 가리개가 아는 모든 종류, 줄 앞말·꼬리 꼴(줄 끝 너그러움 꼴 포함), 끼어든 짧은·긴 줄, 긴 줄 끝의 시작 표시, 끝
 *   표시와 다음 시작 표시가 한 줄, 끝 표시 뒤 글, 창 안에서 끝나는 출력, 창 안의 다른 종류 끝 표시
 * - crossCase: 쓰는 쪽 1~3개가 키 2~3개를 엇갈려 찍는다 (S5-55). 시작 표시 줄 앞에 한 줄에 다 든 키가 붙기도 한다 (S5-67.3)
 * - inlineCutCase: 시작 표시 뒤에 한 줄로 이어 쓴 키 본문이 끝 표시 전에 잘리고 뒤에 다른 글이 붙는 줄 — 담는 중 끝 표시·흘려 보냄·출력 끝 (S5-61). 두 번
 *   이스케이프한 JSON(`\\n`)도 섞는다 (S5-71)
 * - realCutCase: 진짜 줄바꿈으로 찍은 키를 찍는 쪽이 끝 표시 전에 자르고 잘린 줄(본문 16~63자) 뒤에 글을 붙인 꼴 — 줄마다 compose 앞말이 붙기도 한다 (S5-71)
 * - OUTSIDE_LAYOUTS: 줄 끝 너그러움 밖의 꼴(grep --color의 ESC[K, sed -n l의 나눔, 표 테두리, 줄 이음 \, 끝의 마침표, 두 번 이스케이프한 JSON) — fuzzCase·
 *   crossCase에 꼴 모음으로 준다 (S5-71)
 * - secretCase: 창 안(떠돌이 시작 표시 뒤·잘린 키 뒤·담는 중·흘려 보냄·시작 줄)과 창 밖에 비밀 값이 든 줄 — 이름 붙은 값(JSON·YAML·XML·properties·
 *   명령 옵션 …), URL 비밀번호, 등록 값, wos_ 토큰, 한 줄 키 (S5-78). shownPieces: 그 값의 조각이 보이는지
 * - dashJoinCase: 끝 표시와 시작 표시가 대시 5~10개로 이어진 줄 — 짧은 줄·긴 줄·생략된 가운데, 아무 키도 닫지 않는 끝 표시와 키를 닫는 끝 표시(S5-79). 닫는
 *   끝 표시는 키 하나·겹친 두 키의 바깥·엇갈린 두 키의 나중·따옴표 든 줄이 낀 블록의 것 (S5-85)
 * - leakedPieces: 출력에 남은 본문 줄의 16자 조각. longRun: base64 16자 넘는 이어짐 (S5-71의 불변식 ①)
 */
import { HOST_EXEC_TAIL_BYTES } from '../../src/main/orchestrator/hostExec';

/** 씨앗을 주는 의사 난수 (mulberry32) — 같은 씨앗이면 같은 경우들 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** 무작위 base64 n자 — 글자마다 rand를 한 번씩 차례로 부른다 (같은 씨앗이면 같은 글) */
function randomB64(n: number, rand: () => number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += B64_CHARS[Math.floor(rand() * 64)];
  return s;
}
/** 가리개가 아는 PEM 개인 키 종류 — [시작 표시, 끝 표시] */
export const PEM_KINDS: Array<[string, string]> = ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED '].map((k) => [`-----BEGIN ${k}PRIVATE KEY-----`, `-----END ${k}PRIVATE KEY-----`] as [string, string]);
PEM_KINDS.push(['-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----END PGP PRIVATE KEY BLOCK-----']);
/** 줄의 꼴 — 앞말·꼬리 (n: 줄 번호) */
export const FUZZ_LAYOUTS: Array<(l: string, n: number) => string> = [
  (l) => l,
  (l, n) => `${String(n).padStart(6, ' ')}\t${l}`, // cat -n
  (l, n) => `${n}:${l}`, // findstr /n
  (l, n) => `deploy/keys/id_ed.pem:${n}:${l}`, // grep -n 경로
  (l) => `-${l}`, // git diff 지운 줄
  (l) => `    ${l}`, // YAML 들여쓰기
  (l) => `${l}$`, // cat -A
  (l) => `${l}\r`, // CRLF
  (l) => `${l}^M$`, // CRLF를 cat -A로
  (l) => l.padEnd(120, ' '), // 콘솔 폭(120칸)까지 공백으로 채운 줄 — 줄 끝 너그러움(24자)보다 긴 공백 (리드 결정 S5-67.1)
  // 줄 끝 너그러움 (리드 결정 S5-55) — Node util.inspect, JSON 배열, 색 입힌 출력, CRLF 키의 util.inspect (S5-67.2)
  (l) => `  '${l}\\n' +`,
  (l) => `  "${l}",`,
  (l) => `\x1b[32m${l}\x1b[0m`,
  (l) => `  '${l}\\r\\n' +`,
];
/** 줄 끝 너그러움이 쓰이는 꼴의 수 (FUZZ_LAYOUTS 끝의 넷) */
export const TOLERANT_LAYOUTS = 4;
/**
 * 줄 끝 너그러움(S5-55.6) 밖의 꼴 (리드 결정 S5-71) — 본문으로 보이지 않아 창 안에서도 남는 줄이 된다. 그래도 남기기 전에 base64 이어짐을 가리므로 본문
 * 조각이 남지 않아야 한다. sed -n l은 48자 넘는 본문 줄을 40자에서 '\'로 나눠 두 줄로 낸다(꼴이 '\n'을 돌려주면 만들개가 줄로 나눈다) — 개인 키 표시가 든
 * 줄은 나누지 않는다: 표시가 반으로 갈리면 출력에 그 키의 시작 표시가 없어 어느 가리기도 키로 알아볼 수 없다(창 밖의 글이다)
 */
export const OUTSIDE_LAYOUTS: Array<(l: string, n: number) => string> = [
  (l) => `\x1b[01;31m\x1b[K${l}\x1b[m\x1b[K`, // grep --color=always
  (l) => (l.length > 48 && !l.includes('PRIVATE KEY') ? `${l.slice(0, 40)}\\\n${l.slice(40)}$` : `${l}$`), // sed -n l
  (l) => `| ${l} |`, // 표 테두리
  (l) => `${l} \\`, // 줄 이음
  (l) => `${l}.`, // 끝의 마침표
  (l) => `  "${l}\\\\n",`, // 두 번 이스케이프한 JSON (JSON 안의 JSON)
];
/** base64 글자가 없는 채움 (진행 막대·구분선) — 크기만큼 자른다 */
export const PLAIN = `\r[${'#'.repeat(17)}${' '.repeat(13)}] ··· 진행 ··· `.repeat(3000);
export const WORDS = ['npm WARN deprecated left-pad@1.0.0', '(node:4242) Warning: something on stderr', '경고: 설정 파일을 읽지 못함 — 기본값 사용', ''];

/**
 * 퍼즈 경우 하나: 출력 줄과 그 안에 찍힌 키 본문 줄 (리드 결정 S5-48). 창 안에 다른 종류(열리지 않은 종류)의 끝 표시 줄도 넣는다 (S5-59.3). 줄 꼴은
 * layouts에서 고른다 — 기본은 FUZZ_LAYOUTS, 너그러움 밖의 꼴은 OUTSIDE_LAYOUTS (S5-71)
 */
export function fuzzCase(rand: () => number, layouts: ReadonlyArray<(l: string, n: number) => string> = FUZZ_LAYOUTS): { lines: string[]; bodies: string[]; otherEnds: number } {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const b64 = (n: number): string => randomB64(n, rand);
  const sizeOf = (): number => {
    const r = rand();
    if (r < 0.55) return int(0, 200);
    if (r < 0.75) return int(1024, 31 * 1024);
    if (r < 0.9) return int(31 * 1024, HOST_EXEC_TAIL_BYTES);
    if (r < 0.95) return HOST_EXEC_TAIL_BYTES + int(-2, 2);
    return int(HOST_EXEC_TAIL_BYTES + 1, 60 * 1024);
  };
  /** 지금 찍는 키의 끝 표시 — 창 안에 넣는 다른 종류의 끝 표시는 이것이 아니다 (열린 종류의 떠돌이 끝 표시는 받아들인 한계 — S5-55) */
  let openEnd = '';
  let otherEnds = 0;
  const filler = (): string => {
    const r = rand();
    if (openEnd && r < 0.04) {
      otherEnds++;
      return layout(pick(PEM_KINDS.filter(([, e]) => e !== openEnd))[1], lines.length + 1);
    }
    return r < 0.3 ? pick(WORDS) : PLAIN.slice(0, sizeOf());
  };
  const lines: string[] = [];
  const bodies: string[] = [];
  for (let i = int(0, 800); i > 0; i--) lines.push(`L${String(i).padStart(4, '0')} ${'.'.repeat(94)}`);
  const interleave = rand() < 0.25 ? 0 : pick([0.05, 0.2, 0.5]);
  const layout = pick(layouts);
  const keys = int(1, 3);
  let carry = ''; // 앞 키의 끝 표시 줄에 붙일 다음 키의 시작 표시
  for (let k = 0; k < keys; k++) {
    const [begin, end] = pick(PEM_KINDS);
    openEnd = end;
    const body = Array.from({ length: int(20, 60) }, () => b64(64));
    const lastLen = int(1, 64);
    body.push(rand() < 0.5 ? b64(lastLen) : `${b64(Math.max(2, lastLen - 2))}${pick(['=', '=='])}`);
    const last = k === keys - 1;
    const cutInside = last && rand() < 0.2; // 출력이 창 안에서 끝남
    const shown = cutInside ? int(0, body.length) : body.length;
    // 시작 표시 줄: 보통, 긴 줄 끝, 중간 크기 줄 끝, 앞 키 끝 표시와 한 줄
    let beginLine = layout(begin, lines.length + 1);
    const r = rand();
    if (carry) {
      lines[lines.length - 1] = `${lines.at(-1)}${begin}`;
      beginLine = '';
    } else if (r < 0.1) beginLine = `${PLAIN.slice(0, int(HOST_EXEC_TAIL_BYTES + 1, 60 * 1024))}${begin}`;
    else if (r < 0.2) beginLine = `${PLAIN.slice(0, int(1000, 40 * 1024))}${begin}`;
    else if (r < 0.25) beginLine = `${layout(begin, lines.length + 1)}${PLAIN.slice(0, int(1000, 40 * 1024))}`;
    if (beginLine) lines.push(beginLine);
    for (let i = 0; i < shown; i++) {
      while (rand() < interleave) lines.push(filler());
      // sed -n l 꼴은 한 본문 줄을 두 줄로 낸다
      lines.push(...layout(body[i]!, lines.length + 1).split('\n'));
      bodies.push(body[i]!);
    }
    if (cutInside) break;
    while (rand() < interleave) lines.push(filler());
    const after = rand();
    let endLine = layout(end, lines.length + 1);
    if (after < 0.15) endLine = `${endLine} # 끝 뒤 글`;
    else if (after < 0.2) endLine = `${PLAIN.slice(0, int(1000, 60 * 1024))}${end}`;
    lines.push(endLine);
    carry = !last && rand() < 0.2 ? 'yes' : '';
    for (let i = carry ? 0 : int(0, 3); i > 0; i--) lines.push(filler());
  }
  for (let i = int(0, 600); i > 0; i--) lines.push(`T${String(i).padStart(4, '0')} ${'~'.repeat(94)}`);
  return { lines, bodies, otherEnds };
}

/** 쓰는 쪽마다 줄 앞에 붙는 말 — docker compose logs의 서비스 이름, 표준 오류 표시, 시각 (리드 결정 S5-55) */
export const WRITER_PREFIXES = ['', 'svc-a  | ', 'svc-b  | ', 'web_1   | ', '[stderr] ', '2026-11-04T05:06:07Z '];

/**
 * 엇갈린 키의 퍼즈 경우 하나 (리드 결정 S5-55): 쓰는 쪽 1~3개(앞말이 서로 다름)가 저마다 키를 찍고, 그 줄들이 무작위로 섞인다 — 표준 출력과 표준 오류,
 * 한 파이프에 쓰는 두 프로세스, compose logs. 키는 2~3개(같은 종류·다른 종류), 줄 끝 꼴(util.inspect·JSON 배열·색 포함), 끼어든 짧은·긴 줄, 열리지 않은
 * 종류의 끝 표시 줄, 시작·끝 표시 줄 둘이 한 줄로 붙는 경우, 출력이 창 안에서 끝나는 경우. crossing: 두 키의 시작~끝 구간이 겹쳤는지.
 * 시작 표시 줄 앞에 붙인 한 줄에 다 든 키의 본문(S5-67.3)은 그 줄이 창 밖이면 bodies에(창이 그 자리만 가린다), 다른 키가 열려 있어 창 안의 보통 줄이면
 * windowInline에 든다 — 창 안의 보통 줄은 담거나 남기고 그 안의 한 줄 키는 마지막 가리기(redactPem)가 가렸다(S5-55.4). S5-71부터는 창 안에서 남기는 글의
 * base64 이어짐을 가리므로 그 본문도 창이 가린다 — 가리개 없이 봐도 된다. 쓰는 쪽마다의 줄 꼴은 layoutPool에서 고른다(기본 FUZZ_LAYOUTS)
 */
export function crossCase(
  rand: () => number,
  layoutPool: ReadonlyArray<(l: string, n: number) => string> = FUZZ_LAYOUTS,
): { lines: string[]; bodies: string[]; windowInline: string[]; crossing: boolean; tolerant: boolean; otherEnds: number } {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const b64 = (n: number): string => randomB64(n, rand);
  // 쓰는 쪽이 하나면 엇갈리지 않는다 — 대부분 둘·셋
  const writers = rand() < 0.1 ? 1 : int(2, 3);
  const prefixes = [...WRITER_PREFIXES].sort(() => rand() - 0.5).slice(0, writers);
  const layouts = prefixes.map(() => pick(layoutPool));
  const tolerant = layouts.some((l) => FUZZ_LAYOUTS.indexOf(l) >= FUZZ_LAYOUTS.length - TOLERANT_LAYOUTS);
  const keyCount = int(2, 3);
  const same = rand() < 0.3 ? pick(PEM_KINDS) : null;
  const kinds = Array.from({ length: keyCount }, () => same ?? pick(PEM_KINDS));
  const unused = PEM_KINDS.filter(([b]) => !kinds.some(([kb]) => kb === b));
  /** inline: 시작 표시 줄 앞에 붙은 한 줄에 다 든 키의 본문 (S5-67.3) */
  type Item = { text: string; key: number; role: 'begin' | 'body' | 'end' | 'fill'; w: number; inline?: string };
  const seqs: Item[][] = prefixes.map(() => []);
  let otherEnds = 0;
  const sizeOf = (): number => {
    const r = rand();
    if (r < 0.6) return int(0, 200);
    if (r < 0.85) return int(1024, 31 * 1024);
    if (r < 0.95) return int(31 * 1024, HOST_EXEC_TAIL_BYTES);
    return int(HOST_EXEC_TAIL_BYTES + 1, 60 * 1024);
  };
  const fill = (w: number): Item => {
    const r = rand();
    if (unused.length && r < 0.05) {
      otherEnds++;
      return { text: pick(unused)[1], key: -1, role: 'fill', w };
    }
    return { text: r < 0.35 ? pick(WORDS) : PLAIN.slice(0, sizeOf()), key: -1, role: 'fill', w };
  };
  const interleave = pick([0, 0.05, 0.2, 0.4]);
  const manyShort = rand() < 0.12;
  for (let k = 0; k < keyCount; k++) {
    const w = k % writers;
    const [begin, end] = kinds[k]!;
    const s = seqs[w]!;
    for (let i = int(0, 3); i > 0; i--) s.push(fill(w));
    const br = rand();
    if (br < 0.06) s.push({ text: `${PLAIN.slice(0, int(1000, 60 * 1024))}${begin}`, key: k, role: 'begin', w });
    else if (br < 0.16) {
      // 한 줄에 다 든 키(JSON 문자열의 \n) 뒤에 이 키의 시작 표시 — 창은 아직 열린 구간의 시작 표시부터다 (리드 결정 S5-55.2·S5-67.3)
      const [ib, ie] = pick(PEM_KINDS);
      const inline = b64(64);
      s.push({ text: `{"k":"${ib}\\n${inline}\\n${ie}\\n"} ${begin}`, key: k, role: 'begin', w, inline });
    } else s.push({ text: begin, key: k, role: 'begin', w });
    const body = Array.from({ length: int(3, 50) }, () => b64(64));
    const lastLen = int(1, 64);
    body.push(rand() < 0.5 ? b64(lastLen) : `${b64(Math.max(2, lastLen - 2))}${pick(['=', '=='])}`);
    body.forEach((b, i) => {
      while (rand() < interleave) s.push(fill(w));
      if (manyShort && i === 2) for (let j = int(380, 420); j > 0; j--) s.push({ text: `warn ${j}`, key: -1, role: 'fill', w });
      s.push({ text: b, key: k, role: 'body', w });
    });
    while (rand() < interleave) s.push(fill(w));
    s.push({ text: rand() < 0.05 ? `${PLAIN.slice(0, int(1000, 60 * 1024))}${end}` : end, key: k, role: 'end', w });
  }
  // 섞기 — 쓰는 쪽마다 차례는 지킨다
  const merged: Item[] = [];
  const at = seqs.map(() => 0);
  for (;;) {
    const live = seqs.map((s, i) => (at[i]! < s.length ? i : -1)).filter((i) => i >= 0);
    if (!live.length) break;
    const w = pick(live);
    merged.push(seqs[w]![at[w]!++]!);
  }
  const cut = rand() < 0.25 ? int(1, merged.length) : merged.length;
  const shown = merged.slice(0, cut);
  const lines: string[] = [];
  const begins = new Map<number, number>();
  const ends = new Map<number, number>();
  const bodies: string[] = [];
  const windowInline: string[] = [];
  /** 지금까지 찍은 줄에서 열려 있는 키 — 한 줄에 다 든 키가 창 밖인지 본다 */
  const open = new Set<number>();
  const mark = (x: Item): void => {
    if (x.inline) (open.size ? windowInline : bodies).push(x.inline);
    if (x.role === 'begin') open.add(x.key);
    if (x.role === 'end') open.delete(x.key);
  };
  for (let i = 0; i < shown.length; i++) {
    const it = shown[i]!;
    const keyLine = it.role !== 'fill';
    const text = `${prefixes[it.w]}${keyLine ? layouts[it.w]!(it.text, lines.length + 1) : it.text}`;
    const next = shown[i + 1];
    // 서로 다른 쓰는 쪽의 표시 줄 둘이 한 줄로 붙는다 (줄바꿈 없이 섞인 쓰기 — 한 줄에서 엇갈림)
    if (next && (it.role === 'begin' || it.role === 'end') && (next.role === 'begin' || next.role === 'end') && next.w !== it.w && rand() < 0.3) {
      const joined = `${text}${prefixes[next.w]}${layouts[next.w]!(next.text, lines.length + 1)}`;
      for (const x of [it, next]) {
        (x.role === 'begin' ? begins : ends).set(x.key, lines.length);
        mark(x);
      }
      lines.push(joined);
      i++;
      continue;
    }
    if (it.role === 'begin') begins.set(it.key, lines.length);
    if (it.role === 'end') ends.set(it.key, lines.length);
    if (it.role === 'body') bodies.push(it.text);
    mark(it);
    // sed -n l 꼴은 한 본문 줄을 두 줄로 낸다 (S5-71)
    lines.push(...text.split('\n'));
  }
  let crossing = false;
  for (const [a, ba] of begins) {
    for (const [b, bb] of begins) {
      if (a !== b && ba <= bb && bb < (ends.get(a) ?? Infinity) && (ends.get(a) ?? Infinity) < (ends.get(b) ?? Infinity)) crossing = true;
    }
  }
  // 잘린 경우는 거기서 출력이 끝난다(창이 열린 채) — 아니면 뒤에 보통 줄
  if (cut === merged.length) for (let i = int(0, 300); i > 0; i--) lines.push(`T${String(i).padStart(4, '0')} ${'~'.repeat(94)}`);
  return { lines, bodies, windowInline, crossing, tolerant, otherEnds };
}

/**
 * 시작 표시 뒤에 한 줄로 이어 쓴 키 본문이 끝 표시 전에 잘리고 그 뒤에 다른 글이 붙는 줄의 꼴 (리드 결정 S5-61, 프로브 zz-xs5f5-inlinebegin) — 시작 표시 앞
 * 글, 키 종류, 잘린 자리 뒤에 붙는 글. 로거가 자른 JSON 값, 파이썬 '%.400r'로 잘린 뒤 다른 필드, head -c가 이스케이프 안에서 끊은 서비스 계정 JSON, 말줄임표로
 * 자른 값
 */
export const INLINE_CUT_SHAPES: Record<string, { pre: string; begin: string; post: string }> = {
  'JSON 로그 — 로거가 값을 자름': { pre: '{"level":"debug","msg":"loaded config","key":"', begin: '-----BEGIN RSA PRIVATE KEY-----', post: '...(truncated)","user":"bob"}' },
  "파이썬 '%.400r' — 잘린 뒤 다른 필드": { pre: "cfg key='", begin: '-----BEGIN PRIVATE KEY-----', post: ' user=bob' },
  'head -c — 서비스 계정 JSON이 이스케이프 안에서 끊김': { pre: '{"type": "service_account", "project_id": "demo", "private_key": "', begin: '-----BEGIN PRIVATE KEY-----', post: '\\' },
  '말줄임표로 자른 로그 값': { pre: '2026-11-04 INFO key=', begin: '-----BEGIN EC PRIVATE KEY-----', post: '…' },
};
/** 그 꼴의 줄 — 본문 줄을 sep(글자 그대로의 \n 등)으로 이어 시작 표시 뒤에 쓰고, 잘린 자리 뒤 글을 붙인다 */
export const inlineCutLine = (shape: { pre: string; begin: string; post: string }, body: readonly string[], sep = '\\n'): string =>
  `${shape.pre}${shape.begin}${sep}${body.join(sep)}${shape.post}`;
/** 그 꼴의 끝 표시 */
export const inlineCutEnd = (shape: { begin: string }): string => shape.begin.replace('-----BEGIN ', '-----END ');

/** inlineCutCase에서 잘린 줄 뒤에 출력이 가는 길 — 출력 끝(창 안에서 끝남), 담는 중 끝 표시, 흘려 보냄(끝 표시 없음), 흘려 보낸 뒤 끝 표시 */
export type InlineCutPosition = 'end' | 'buffered' | 'spill' | 'spill-end';

/**
 * 한 줄에서 끝 표시 전에 잘린 키의 퍼즈 경우 하나 (리드 결정 S5-61): 앞 채움(가끔 뒤 상한보다 긴 줄 — 앞·뒤 자르기에 걸리게) 뒤에 시작 표시 앞 글 + 시작 표시 +
 * 한 줄로 이은 본문(글자 그대로의 \n·\r\n, 아무 자리에서 자름) + 잘린 뒤 글의 줄, 그다음 네 길 가운데 하나. 흘려 보내는 창에는 가끔 같은 꼴의 줄이 하나 더
 * 든다(창 안의 안쪽 시작 표시 줄). 줄 꼴(앞말·꼬리)은 FUZZ_LAYOUTS에서 고른다. bodies는 그 줄들에 쓴 본문 줄 전부다
 */
export function inlineCutCase(rand: () => number): { lines: string[]; bodies: string[]; position: InlineCutPosition } {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const b64 = (n: number): string => randomB64(n, rand);
  const shapes = Object.values(INLINE_CUT_SHAPES);
  const layout = pick(FUZZ_LAYOUTS);
  const lines: string[] = [];
  const bodies: string[] = [];
  let firstBegin = '';
  const cutLine = (): string => {
    const shape = { ...pick(shapes), begin: pick(PEM_KINDS)[0] };
    firstBegin ||= shape.begin;
    // 가끔 시작 줄만으로 담는 상한(32KiB)을 넘는 긴 본문
    const body = Array.from({ length: rand() < 0.08 ? int(500, 560) : int(1, 24) }, () => b64(64));
    bodies.push(...body);
    // 글자 그대로의 \r\n·\n, 그리고 두 번 이스케이프한 JSON의 \\n — PEM 꼬리 규칙이 모르는 꼴 (리드 결정 S5-71, 프로브 zz-xs5f6es-spilldiff (c))
    const s = rand();
    const sep = s < 0.3 ? '\\r\\n' : s < 0.45 ? '\\\\n' : '\\n';
    const whole = inlineCutLine({ ...shape, post: '' }, body, sep);
    // 끝 표시 전의 아무 자리에서 자른다 — 시작 표시 뒤 본문을 16자 넘게 남긴다
    const at = shape.pre.length + shape.begin.length + sep.length;
    return layout(`${whole.slice(0, int(at + 16, whole.length))}${shape.post}`, lines.length + 1);
  };
  for (let i = int(0, 600); i > 0; i--) lines.push(`L${String(i).padStart(4, '0')} ${'.'.repeat(94)}`);
  if (rand() < 0.15) lines.push(PLAIN.slice(0, int(HOST_EXEC_TAIL_BYTES + 1, 60 * 1024)));
  const first = cutLine();
  lines.push(first);
  const end = layout(inlineCutEnd({ begin: firstBegin }), lines.length + 1);
  const position = pick(['end', 'buffered', 'spill', 'spill-end'] as const);
  const words = (n: number): void => {
    for (let i = n; i > 0; i--) lines.push(rand() < 0.5 ? pick(WORDS) : `[test] case ${i} ok`);
  };
  if (position === 'end') words(int(0, 3));
  else if (position === 'buffered') {
    words(int(0, 30));
    lines.push(end);
  } else {
    words(int(400, 460));
    if (rand() < 0.3) {
      lines.push(cutLine());
      words(int(0, 20));
    }
    if (position === 'spill-end') lines.push(end);
  }
  if (position === 'buffered' || position === 'spill-end') for (let i = int(0, 300); i > 0; i--) lines.push(`T${String(i).padStart(4, '0')} ${'~'.repeat(94)}`);
  return { lines, bodies, position };
}

/**
 * 진짜 줄바꿈으로 찍은 키를 찍는 쪽이 끝 표시 전에 자른 꼴 여덟 (리드 결정 S5-71, 프로브 zz-xs5f6es-realcut) — 시작 표시만 든 줄, 온전한 본문 줄, 잘린 본문
 * 뒤에 글이 붙은 줄. 로거가 자른 필드('%.400s' 뒤 다른 필드, '...(truncated)'), 미리 보기 `content[:N] + '...'`, '…'로 자른 값, 색 입힌 로그 줄, 줄마다의
 * compose 앞말, 한 출력의 잘린 키 둘. body는 본문 줄 8개 이상, body2는 둘째 키의 본문 줄 4개 이상
 */
export const REAL_CUT_SHAPES: Record<string, (body: readonly string[], body2: readonly string[]) => string[]> = {
  "로거 '%.400s' 뒤 다른 필드": (b) => ['2026-11-04 DEBUG key=-----BEGIN RSA PRIVATE KEY-----', ...b.slice(0, 5), `${b[5]!.slice(0, 40)} user=bob`],
  "미리 보기 content[:N] + '...'": (b) => ['-----BEGIN PRIVATE KEY-----', ...b.slice(0, 6), `${b[6]!.slice(0, 37)}...`],
  "로거 '...(truncated)' 뒤 글": (b) => ['key="-----BEGIN RSA PRIVATE KEY-----', ...b.slice(0, 3), `${b[3]!.slice(0, 50)}...(truncated)" user=bob`],
  "'…'로 자른 값": (b) => ['2026-11-04 INFO key=-----BEGIN EC PRIVATE KEY-----', ...b.slice(0, 2), `${b[2]!.slice(0, 30)}…`],
  '첫 본문 줄에서 잘림': (b) => ['key=-----BEGIN EC PRIVATE KEY-----', `${b[0]!.slice(0, 45)}...(truncated) user=bob`],
  '색 입힌 로그 줄': (b) => ['\x1b[2m2026-11-04\x1b[0m DEBUG key=-----BEGIN RSA PRIVATE KEY-----', ...b.slice(0, 4), `${b[4]!.slice(0, 33)}\x1b[0m [truncated 1203 bytes]`],
  '줄마다 compose 앞말': (b) => ['svc-a  | key=-----BEGIN RSA PRIVATE KEY-----', ...b.slice(0, 4).map((l) => `svc-a  | ${l}`), `svc-a  | ${b[4]!.slice(0, 41)}... user=bob`],
  '한 출력에 잘린 키 둘': (b, b2) => ['k1=-----BEGIN RSA PRIVATE KEY-----', ...b.slice(0, 3), `${b[3]!.slice(0, 44)}...`, 'next record', 'k2=-----BEGIN EC PRIVATE KEY-----', ...b2.slice(0, 3), `${b2[3]!.slice(0, 44)}...`],
};
/** REAL_CUT_SHAPES 꼴의 키를 모두 닫는 끝 표시 줄 (둘째 키가 있으면 둘 다) */
export const realCutEnds = (lines: readonly string[]): string[] =>
  lines.filter((l) => l.includes('-----BEGIN ')).map((l) => l.slice(l.indexOf('-----BEGIN ')).replace('-----BEGIN ', '-----END ')).reverse();

/** 잘린 줄 뒤에 붙는 글과 시작 표시 앞 글 (리드 결정 S5-71) — base64 16자 넘는 이어짐이 없다 */
export const REAL_CUT_TRAILERS = [' user=bob', '...', '…', '...(truncated)" user=bob', '\x1b[0m [truncated 1203 bytes]', '... user=bob', ' (잘림)'];
export const REAL_CUT_PRES = ['', '2026-11-04 DEBUG key=', 'key="', '\x1b[2m2026-11-04\x1b[0m DEBUG key=', 'k1='];
/** realCutCase의 잘린 줄 뒤에 출력이 가는 길 — inlineCutCase와 같다 */
export type RealCutPosition = InlineCutPosition;

/**
 * 진짜 줄바꿈으로 찍은 키가 끝 표시 전에 잘린 퍼즈 경우 하나 (리드 결정 S5-71): 앞 채움(가끔 뒤 상한보다 긴 줄) 뒤에 시작 표시 줄(앞 글 + 시작 표시), 온전한
 * 본문 줄 0~30개, 본문 16~63자 + 뒤 글인 잘린 줄. 가끔 '다음 기록' 줄 뒤에 같은 꼴의 키가 하나 더(창 안의 안쪽 시작 표시). 절반은 줄마다 compose 앞말이
 * 붙는다. 그다음 네 길(출력 끝·담는 중 끝 표시·흘려 보냄·흘려 보낸 뒤 끝 표시) 가운데 하나 — 흘려 보내는 창에는 가끔 잘린 키가 하나 더 든다. bodies는 온전한
 * 본문 줄과 잘린 본문
 */
export function realCutCase(rand: () => number): { lines: string[]; bodies: string[]; position: RealCutPosition; prefixed: boolean } {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const b64 = (n: number): string => randomB64(n, rand);
  const lines: string[] = [];
  const bodies: string[] = [];
  const ends: string[] = [];
  for (let i = int(0, 600); i > 0; i--) lines.push(`L${String(i).padStart(4, '0')} ${'.'.repeat(94)}`);
  if (rand() < 0.15) lines.push(PLAIN.slice(0, int(HOST_EXEC_TAIL_BYTES + 1, 60 * 1024)));
  const prefix = rand() < 0.5 ? pick(WRITER_PREFIXES.slice(1)) : '';
  const cutKey = (): void => {
    const [begin, end] = pick(PEM_KINDS);
    ends.push(end);
    lines.push(`${prefix}${pick(REAL_CUT_PRES)}${begin}`);
    const full = Array.from({ length: int(0, 30) }, () => b64(64));
    for (const b of full) lines.push(`${prefix}${b}`);
    const cut = b64(int(16, 63));
    bodies.push(...full, cut);
    lines.push(`${prefix}${cut}${pick(REAL_CUT_TRAILERS)}`);
  };
  const words = (n: number): void => {
    for (let i = n; i > 0; i--) lines.push(`${prefix}${rand() < 0.5 ? pick(WORDS) : `[test] case ${i} ok`}`);
  };
  const closeAll = (): void => {
    for (const e of [...ends].reverse()) lines.push(`${prefix}${e}`);
  };
  cutKey();
  if (rand() < 0.25) {
    lines.push(`${prefix}next record`);
    cutKey();
  }
  const position = pick(['end', 'buffered', 'spill', 'spill-end'] as const);
  if (position === 'end') words(int(0, 3));
  else if (position === 'buffered') {
    words(int(0, 30));
    closeAll();
  } else {
    words(int(400, 460));
    if (rand() < 0.3) {
      cutKey();
      words(int(0, 20));
    }
    if (position === 'spill-end') closeAll();
  }
  if (position === 'buffered' || position === 'spill-end') for (let i = int(0, 300); i > 0; i--) lines.push(`T${String(i).padStart(4, '0')} ${'~'.repeat(94)}`);
  return { lines, bodies, position, prefixed: prefix !== '' };
}

/** base64 글자가 16자 넘게 이어진 곳이 있는가 — 창 안에서 남긴 글의 불변식 ① (리드 결정 S5-71). 만들개들은 창 밖에 그런 글을 쓰지 않는다 */
export const longRun = (s: string): string | null => /[A-Za-z0-9+/=]{16,}/.exec(s)?.[0] ?? null;

/** 본문 줄의 16자 조각 모두 — 한 경우에서 여러 번 찾을 때 한 번만 만든다 */
export function bodyPieces(bodies: readonly string[]): Set<string> {
  const pieces = new Set<string>();
  for (const b of bodies) for (let i = 0; i + 16 <= b.length; i++) pieces.add(b.slice(i, i + 16));
  return pieces;
}

/** 출력에 남은 본문 줄의 16자 조각 — 출력의 base64 16자 넘는 이어짐만 본다 */
export function leakedPieces(text: string, bodies: readonly string[], pieces: Set<string> = bodyPieces(bodies)): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/=]{16,}/g)) {
    for (let i = 0; i + 16 <= m[0].length; i++) if (pieces.has(m[0].slice(i, i + 16))) found.push(m[0].slice(i, i + 16));
  }
  return found;
}

/**
 * 창 안의 줄에 드는 비밀 값 꼴 (리드 결정 S5-78, 프로브 zz-xs5f7es-ctxloss·zz-xs5f7es-fuzz B): 이름 붙은 값(JSON·YAML·XML·properties·두 번 이스케이프한
 * JSON·파이썬 dict·명령 옵션, 이름과 값이 두 줄로 갈린 JSON), URL 비밀번호, 등록 값, wos_ 세션 토큰, 한 줄에 다 든 개인 키(JSON 문자열의 \n)
 */
export const SECRET_FORMATS = ['json', 'yaml', 'xml', 'properties', 'escaped-json', 'python-dict', 'cli', 'json-split', 'url', 'registered', 'wos', 'inline-key'] as const;
export type SecretFormat = (typeof SECRET_FORMATS)[number];
/** 이름 — 16자 밑과 16자 넘는 것(조각 가리기가 이름째 바꾼다)을 섞는다 */
export const SECRET_NAMES = ['pass', 'secret', 'dbPassword', 'apiToken', 'clientSecret', 'databasePassword', 'keyStorePassword', 'trustStorePassword', 'githubAccessToken', 'privateKeyPassphrase', 'oauthClientSecretValue', 'smtpRelayPassword'];
/** URL 사용자 — '//'와 함께 16자 넘는 것이 이어짐이 된다 */
export const URL_USERS = ['app', 'deploy', 'serviceuser', 'applicationuser1234', 'svcaccountreadonly01'];
/** secretCase에서 비밀 값 줄이 놓이는 자리 */
export const SECRET_POSITIONS = ['outside', 'stray', 'cut', 'buffered-end', 'spill', 'spill-end', 'opening'] as const;
export type SecretPosition = (typeof SECRET_POSITIONS)[number];

/** 그 값의 조각(길이 piece)이 글에 보이는가 — 값이 piece보다 짧으면 값 전체 */
export function shownPieces(text: string, value: string, piece: number): boolean {
  const n = Math.min(piece, value.length);
  for (let i = 0; i + n <= value.length; i++) if (text.includes(value.slice(i, i + n))) return true;
  return false;
}

/**
 * 비밀 값이 든 줄의 퍼즈 경우 하나 (리드 결정 S5-78): 앞 채움(앞·뒤 자르기에 걸리게) 뒤에 자리 하나 — 창 밖(대조), 떠돌이 시작 표시 뒤 출력 끝, 끝 표시 전에
 * 잘린 키 뒤 출력 끝, 담는 중 끝 표시(창 전체가 한 줄 — 대조), 흘려 보냄(끝 표시 없음·있음), 창을 연 줄의 시작 표시 뒤(로거가 자른 JSON 기록 포함). 줄마다
 * 앞말(compose·cat -n)이 붙기도 한다. secrets는 가려져야 할 값과 그 조각 길이(값은 8자, 한 줄 키의 본문은 16자), register는 쓰기 전에 가리개에 등록할 값
 */
export function secretCase(rand: () => number): {
  lines: string[];
  secrets: Array<{ value: string; piece: number }>;
  register: string[];
  position: SecretPosition;
  format: SecretFormat;
  longName: boolean;
} {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const b64 = (n: number): string => randomB64(n, rand);
  const format = pick(SECRET_FORMATS);
  const position = pick(SECRET_POSITIONS);
  const prefix = pick(['', '', 'svc-a  | ', `${String(int(1, 999)).padStart(6, ' ')}\t`]);
  // 값 — 구두점이 든 16자 밑의 값, 또는 base64 16자 넘는 이어짐이 든 값. URL 값은 그 규칙이 받는 글자만('@'·'/'·'#'·'?' 없이)
  const value = (url = false): string =>
    rand() < 0.6
      ? `${pick(url ? ['Ch4nge', 'hunt3r', 'Pa$$', 'S3cr!t', 'Zz%1'] : ['Ch@nge', 'hunt3r', 'Pa$$', 'S3cr!t', 'qX9#', 'Zz%1'])}${int(10, 99)}${pick(url ? ['!', '%z', '!!', '*'] : ['!', '#x', '%z', '!!', '*'])}`
      : `${pick(['Pr0d-', 'k9!', ''])}${b64(int(16, 30))}${pick(['!x', '-db!pass', '%9', ''])}`;
  const name = pick(SECRET_NAMES);
  let longName = name.length >= 16;
  const secrets: Array<{ value: string; piece: number }> = [];
  const register: string[] = [];
  /** 비밀 값 줄 (json-split은 두 줄) */
  let body: string[];
  /** 창을 연 줄의 시작 표시 뒤에 붙일 글 (한 줄) */
  let inline: string;
  const v = value(format === 'url');
  switch (format) {
    case 'json':
      body = [`  "${name}": "${v}",`];
      inline = `{"${name}":"${v}"}`;
      break;
    case 'yaml':
      body = [`    ${name}: ${v}`];
      inline = `${name}: ${v}`;
      break;
    case 'xml':
      body = [`<${name}>${v}</${name}>`];
      inline = body[0]!;
      break;
    case 'properties':
      body = [`app.ssl.${name}=${v}`];
      inline = body[0]!;
      break;
    case 'escaped-json':
      body = [`{"log":"{\\"${name}\\":\\"${v}\\"}"}`];
      inline = body[0]!;
      break;
    case 'python-dict':
      body = [`cfg={'${name}': '${v}'}`];
      inline = body[0]!;
      break;
    case 'cli':
      body = [`running: tool --${name} "${v}" --verbose`];
      inline = body[0]!;
      break;
    case 'json-split':
      body = [`  "${name}":`, `      "${v}"`];
      inline = `{"${name}":"${v}"}`;
      break;
    case 'url': {
      const u = pick(URL_USERS);
      longName = u.length + 2 >= 16;
      body = [`DATABASE_URL=postgres://${u}:${v}@db:5432/app`];
      inline = body[0]!;
      break;
    }
    case 'registered': {
      const reg = `${pick(['Pr0d-', 'op-'])}${b64(int(8, 26))}-${pick(['db!pass', 'k8#s', 'x'])}${int(10, 99)}`;
      register.push(reg);
      secrets.push({ value: reg, piece: 8 });
      body = [`DB_SETTING=${reg}`];
      inline = body[0]!;
      break;
    }
    case 'wos': {
      // wos_ + base64url 43자 — '-'·'_'가 이어짐을 끊어 조각 가리기만으로는 16자 밑 조각이 남는다
      let t = '';
      while (t.length < 43) t += rand() < 0.12 ? pick(['-', '_']) : b64(1).replace(/[+/]/, 'q');
      const tok = `wos_${t.slice(0, 43)}`;
      secrets.push({ value: tok, piece: 8 });
      body = [`session ${tok} restored`];
      inline = body[0]!;
      break;
    }
    default: {
      // 한 줄에 다 든 개인 키 (JSON 문자열의 \n) — 본문의 16자 조각
      const [ib, ie] = pick(PEM_KINDS);
      const kb = [b64(64), b64(int(16, 64))];
      for (const k of kb) secrets.push({ value: k, piece: 16 });
      body = [`{"tls":"${ib}\\n${kb.join('\\n')}\\n${ie}\\n"}`];
      inline = body[0]!;
    }
  }
  if (format !== 'registered' && format !== 'wos' && format !== 'inline-key') secrets.push({ value: v, piece: 8 });
  const [begin, end] = pick(PEM_KINDS);
  const lines: string[] = [];
  const push = (...ls: string[]): void => {
    for (const l of ls) lines.push(`${prefix}${l}`);
  };
  const words = (n: number): void => {
    for (let i = n; i > 0; i--) push(rand() < 0.5 ? pick(WORDS) : `[test] case ${i} ok`);
  };
  for (let i = int(0, 500); i > 0; i--) lines.push(`L${String(i).padStart(4, '0')} ${'.'.repeat(94)}`);
  /** 흘려 보내는 창의 줄 400~430개 — 본문 줄과 짧은 줄을 섞고 아무 자리에 비밀 값 줄을 넣는다 */
  const spillLines = (): string[] => {
    const n = int(400, 430);
    const at = int(0, n);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i === at) out.push(...body);
      out.push(rand() < 0.5 ? b64(64) : `[test] case ${i} ok`);
    }
    return out;
  };
  switch (position) {
    case 'outside':
      words(int(0, 3));
      push(...body);
      words(int(0, 3));
      break;
    case 'stray':
      // 시작 표시를 글로 인용한 출력 (findstr /s /n "BEGIN password" …) — 그 뒤 줄은 출력 끝까지 창 안이다
      push(`deploy/id.pem:1:${begin}`);
      words(int(0, 3));
      push(...body);
      words(int(0, 3));
      break;
    case 'cut':
      push(begin, b64(64), `${b64(int(16, 50))}${pick(['...(truncated)', '…', ' [cut]'])}`);
      push(...body);
      push('done');
      break;
    case 'buffered-end':
      push(begin, b64(64), ...body, b64(int(16, 64)), end, 'after');
      break;
    case 'spill':
      push(begin, ...spillLines());
      break;
    case 'spill-end':
      push(begin, ...spillLines(), end, 'after');
      break;
    default:
      // 창을 연 줄의 시작 표시 뒤 — 그 뒤 글, 또는 로거가 키 필드를 자르고 기록을 이어 쓴 JSON (S5-61의 꼴)
      if (format === 'json' || format === 'json-split') push(`{"tls":{"privateKey":"${begin}\\n${b64(64)}\\n${b64(int(10, 60))}...(truncated)",${inline.slice(1, -1)}}}`);
      else push(`${begin} ${inline}`);
      if (rand() < 0.3) push(...spillLines());
      else words(int(0, 3));
  }
  return { lines, secrets, register, position, format, longName };
}

/** dashJoinCase에서 이은 줄이 놓이는 자리 — 남는 짧은 줄, 버리는 긴 줄(48KiB 넘게)의 끝, 앞·뒤 사이에서 생략되는 가운데 */
export type DashJoinPlace = 'short' | 'long' | 'middle';

/**
 * 창을 닫는 끝 표시의 꼴 (리드 결정 S5-85, 프로브 zz-xs5f8es-overlap) — single: 키 X 하나를 그 끝 표시가 닫는다. nested: 같은 종류 X 둘이 겹치고 바깥 끝
 * 표시가 닫는다. crossing: X와 다른 종류 Z가 엇갈리고 Z의 끝 표시가 마지막으로 닫는다. quote: X 블록 안에 따옴표 든 줄이 있다(redactPem은 그 블록을 끝 표시가
 * 아니라 base64 꼬리에서 끝낸다). 뒤의 셋은 redactPem에게 그 끝 표시가 보통 글이라 그 대시의 시작 표시를 찾는다
 */
export type DashJoinClose = 'single' | 'nested' | 'crossing' | 'quote';

/**
 * 끝 표시와 다음 시작 표시가 대시 5~10개로 이어진 줄의 퍼즈 경우 하나 (리드 결정 S5-79, 프로브 zz-xs5f7es-fuzz C): `-----END X PRIVATE KEY` + 대시 d개 +
 * `BEGIN Y PRIVATE KEY-----`. d가 10이면 두 표시가 대시를 함께 쓰지 않는다(cat a.pem b.pem). plain이면 X는 열려 있지 않고(떠돌이 끝 표시), 아니면 앞에 찍은
 * 키를 그 끝 표시가 닫는다 — 닫는 꼴은 close(리드 결정 S5-85: 하나·겹침·엇갈림·따옴표 든 줄). 그 뒤에 Y의 본문(가운데 자리면 뒤 48KiB를 넘는 900줄)과,
 * 가끔 Y의 끝 표시
 */
export function dashJoinCase(rand: () => number): {
  lines: string[];
  bodies: string[];
  yBodies: string[];
  place: DashJoinPlace;
  dashes: number;
  plain: boolean;
  close: DashJoinClose | null;
} {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const b64 = (n: number): string => randomB64(n, rand);
  const [bx, ex] = pick(PEM_KINDS);
  const [by, ey] = pick(PEM_KINDS);
  const dashes = int(5, 10);
  const join = (end: string): string => `${end.slice(0, -5)}${'-'.repeat(dashes)}${by.slice(5)}`;
  let joined = join(ex);
  const plain = rand() < 0.6;
  const place = pick(['short', 'long', 'middle'] as const);
  const lines: string[] = [];
  const bodies: string[] = [];
  for (let i = int(0, 30); i > 0; i--) lines.push(rand() < 0.3 ? pick(WORDS) : `[log] step ${i}`);
  let close: DashJoinClose | null = null;
  if (!plain) {
    const xb = Array.from({ length: int(3, 12) }, () => b64(64));
    bodies.push(...xb);
    close = pick(['single', 'nested', 'crossing', 'quote'] as const);
    if (close === 'single') lines.push(bx, ...xb);
    else if (close === 'quote') lines.push(bx, `Comment: "${pick(WORDS)} key"`, ...xb);
    else if (close === 'nested') {
      // 안쪽 X를 먼저 닫고 바깥 X를 이은 줄의 끝 표시가 닫는다
      const inner = Array.from({ length: int(2, 6) }, () => b64(64));
      bodies.push(...inner);
      lines.push(bx, bx, ...inner, ex, ...xb);
    } else {
      // X와 다른 종류 Z — X를 먼저 닫고 Z의 끝 표시가 마지막으로 닫는다(그 끝 표시가 Y의 시작 표시와 이어진다)
      const [bz, ez] = pick(PEM_KINDS.filter(([b]) => b !== bx));
      const zb = Array.from({ length: int(2, 6) }, () => b64(64));
      bodies.push(...zb);
      lines.push(bx, xb[0]!, bz, zb[0]!, ...xb.slice(1), ex, ...zb.slice(1));
      joined = join(ez);
    }
  }
  if (place === 'middle') for (let i = 0; i < 40; i++) lines.push(`${'.'.repeat(500)} head ${i}`);
  lines.push(place === 'long' ? `${PLAIN.slice(0, int(HOST_EXEC_TAIL_BYTES + 1, 60 * 1024))}${joined}` : rand() < 0.5 ? joined : `${pick(['cat: ', 'key.pem:3:', '    '])}${joined}`);
  // 가운데 자리는 다른 본문 줄 8개를 되풀이해 900줄(뒤 48KiB 넘게) — 조각 집합을 작게 둔다
  const yBodies = Array.from({ length: place === 'middle' ? 8 : int(4, 30) }, () => b64(64));
  bodies.push(...yBodies);
  lines.push(...(place === 'middle' ? Array.from({ length: 900 }, (_, i) => yBodies[i % 8]!) : yBodies));
  if (rand() < 0.6) lines.push(ey, ...Array.from({ length: int(0, 5) }, (_, i) => `[log] after ${i}`));
  return { lines, bodies, yBodies, place, dashes, plain, close };
}
