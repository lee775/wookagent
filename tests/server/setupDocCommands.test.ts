/**
 * 설치 문서의 명령 줄 (리드 결정 S9-11 setupDocCommands, S9-20): 운영자·에이전트·대표가 문서에서 그대로 옮겨 치는 명령이 지금의 해석기에서 쓰임새 오류 없이
 * 읽히는지 본다. 출력은 보지 않는다(문서의 출력은 실제 실행에서 옮겼다 — 리드 결정 S9-18).
 * - `wook-server …`(`scripts\wook-server.cmd …`, `node out\server\index.mjs …` 포함): SERVER_SETUP·TRY_IT·SERVER_INSTALL·README → parseCli
 * - `wook …`(`node out\server\wook.mjs …` 포함): AGENT_GUIDE·SERVER_INSTALL → parseWook
 * - 체험 도구 `scripts\try-server.cmd …`·`scripts\try-desktop.cmd …`: TRY_IT·SERVER_SETUP → parseKitArgs (try-desktop.cmd가 붙이는 낱말은 그 파일에서 읽는다)
 * 명령은 코드 블록의 줄과 글 안의 코드(`…`)에서 찾는다 — 줄 머리, 파이프·대입·`;`·`(`·`{` 뒤에 오는 것만(안내 글 속의 명령 이름은 빼고). 문서의 자리 표시
 * (`<이메일>`, `[--force]`, `set|clear`, `--data-dir …`, `$env:USERPROFILE`)는 아래 정한 예시 값으로 바꾸고, 모르는 자리 표시가 남으면 그 줄로 실패한다 —
 * 문서에 새 꼴을 쓰면 여기에 더한다. 일부러 틀린 예(비밀 값을 명령 줄에 붙인 꼴)는 쓰임새 오류여야 하고 그 값을 되풀이하지 않아야 한다(S3-39)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCli } from '../../src/server/cli';
import { parseWook } from '../../src/cli/agentCli';
import { parseKitArgs } from '../../scripts/try-server.mjs';
import { REPO } from './helpers';

type Tool = 'server' | 'wook' | 'kit';

/** 문서에서 찾은 명령 하나 */
interface DocCommand {
  doc: string;
  line: number;
  tool: Tool;
  /** 문서에 적힌 그대로 (명령 이름 뒤) */
  raw: string;
  /** 자리 표시를 바꾼 인자들 (`a|b`는 갈래마다 하나씩) */
  variants: string[][];
}

const DOCS = ['docs/SERVER_SETUP.md', 'docs/TRY_IT.md', 'docs/SERVER_INSTALL.md', 'docs/AGENT_GUIDE.md', 'README.md'] as const;

/** scripts\try-desktop.cmd가 try-server.mjs 앞에 붙이는 낱말 — 파일에서 읽는다 (`@node "%~dp0try-server.mjs" desktop %*`) */
function cmdPrefix(file: string): string[] {
  const text = readFileSync(join(REPO, 'scripts', file), 'utf8').trim();
  const m = /^@node "%~dp0try-server\.mjs"((?: [a-z-]+)*) %\*$/.exec(text);
  if (!m) throw new Error(`${file}의 모양이 바뀌었습니다: ${text}`);
  return m[1]!.trim() ? m[1]!.trim().split(' ') : [];
}

/**
 * 명령 이름이 오는 자리 (리드 결정 S9-22 TI-3):
 * - 코드 블록의 줄: 줄 어디서든 — 줄 머리, 빈칸·파이프·대입·`;`·`(`·`{`·`&` 뒤 (안내 글 뒤의 `필요하면 wook work progress …`, PowerShell의 `& scripts\…`도).
 *   한 줄에서 가장 앞의 명령 하나를 읽는다. 명령 이름이 나오는데 읽지 못한 줄은 실패다 — 명령이 아니라 출력·안내 글 속의 이름이면 PROSE_LINES에 그 줄을 적는다
 * - 글 속의 코드(`…`): 줄 머리나 파이프·대입·`;`·`{`·`&` 뒤, 또는 `(` 바로 뒤의 `scripts\`·`node `일 때만 (`(wook-server check로 …)` 같은 글은 빼고
 *   `$task = (scripts\wook-server.cmd install-task … | ConvertFrom-Json)` 같은 줄은 본다)
 */
const LEAD_FENCED = String.raw`(?:^|(?<=[\s|=;{(&]))`;
const LEAD_INLINE = String.raw`(?:^\s*|[|=;{&]\s*|\((?=scripts\\|node\s))`;
const invokers = (lead: string): { tool: Tool; re: RegExp; cmd?: string }[] => [
  { tool: 'server', re: new RegExp(`${lead}(?:wook-server|scripts\\\\wook-server\\.cmd|node\\s+out[\\\\/]server[\\\\/]index\\.mjs)(?=\\s|$)`) },
  { tool: 'wook', re: new RegExp(`${lead}(?:wook|node\\s+out[\\\\/]server[\\\\/]wook\\.mjs)(?=\\s)`) },
  { tool: 'kit', re: new RegExp(`${lead}scripts\\\\try-server\\.cmd(?=\\s|$)`), cmd: 'try-server.cmd' },
  { tool: 'kit', re: new RegExp(`${lead}scripts\\\\try-desktop\\.cmd(?=\\s|$)`), cmd: 'try-desktop.cmd' },
];
const INVOKE_FENCED = invokers(LEAD_FENCED);
const INVOKE_INLINE = invokers(LEAD_INLINE);
/** 코드 블록의 줄이 명령 이름(wook·wook-server·try-*.cmd, node out\server\*.mjs)을 말하는지 — 읽지 못했으면 PROSE_LINES에 있어야 한다 */
const NAMED = /(?:^|[^\w.-])(?:wook-server|wook(?=\s+[a-z])|try-server\.cmd|try-desktop\.cmd)|node\s+out[\\/]server[\\/](?:index|wook)\.mjs/;

/**
 * 코드 블록 안이지만 명령 줄이 아닌 것 — 출력 보기, 안내 글·오류 글 속의 명령 이름 (그 문서에 꼭 한 번 있는 줄을 앞뒤 빈칸을 뺀 그대로). 읽지 않는다.
 * 명령으로 쓴 줄은 여기에 넣지 않는다 (읽혀야 한다). 문서의 그 줄이 바뀌면 여기도 바꾼다 — 없는 줄이 남으면 실패한다
 */
const PROSE_LINES: Readonly<Record<string, readonly string[]>> = {
  'docs/SERVER_SETUP.md': [
    // 4단계 status 출력
    '배포 점검     <시각>에 — 통과 9 · 경고 4 (autologon, lock, task, tailscale) · 실패 0 · 건너뜀 0 (wook-server check로 자세히)',
    // 8단계 install-task 출력 (7단계 check의 할 일·8단계의 확인·끄기 줄은 명령으로 읽는다 — 점검한 데이터 폴더가 붙은 그대로 칠 수 있는 명령이다)
    "서버가 뜨면 '욱채 서버 (pid …)' 콘솔 창이 보입니다 — 그 창을 닫지 말고 wook-server shutdown으로 끄세요 (창을 닫으면 정리가 5초쯤에서 잘릴 수 있습니다)",
    // 9단계 seat status 출력
    '세대 1 Claude CLI — 서버, <시각>부터 <시각>까지 (운영자가 바꿈: 운영자 복구 배정 (wook-server seat assign))',
  ],
  'docs/SERVER_INSTALL.md': [
    // 10절 2 블록의 오류 글
    "catch { while ($Error.Count -gt $n) { $Error.RemoveAt(0) }; Remove-Item $f; throw '운영자 명령을 실행하지 못했거나 그 답을 읽지 못했습니다 — wook-server agent list로 등록됐는지 보고, 됐으면 agent revoke로 폐기한 뒤 다시 하세요' }",
    'if ($LASTEXITCODE -ne 0) { throw "키는 썼지만 wook seat status가 끝 코드 $LASTEXITCODE(으)로 끝났습니다 — 바로 위의 글이 까닭입니다" }',
  ],
  'docs/AGENT_GUIDE.md': [
    // 3절 seat claim 출력
    '임대 60초 — 15초마다 wook seat heartbeat를 보내세요. 임대를 싣는 요청(heartbeat·work next·progress·done)만 임대를 늘립니다',
  ],
};

/** 따옴표와 선택 칸(`[…]`) 밖에서 처음 나오는 것의 자리 (없으면 -1) */
function unquotedIndex(s: string, test: (rest: string) => boolean): number {
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && test(s.slice(i))) return i;
  }
  return -1;
}

/**
 * 명령 이름 뒤의 글에서 명령의 끝까지 — 설명 칸(빈칸 둘 이상 뒤의 글 — 칸을 맞춘 옵션 `status       --data-dir …`은 그대로), 주석, 파이프, `;`, 블록의 `}`,
 * 화살표 앞에서 자른다
 */
function cutTail(rest: string): string {
  // 한글이 든 괄호 안 설명(`wook seat heartbeat (임대 60초)`)과 출력의 항목 나눔(` · ` — check의 할 일)도 명령 뒤의 글이다
  const at = unquotedIndex(rest, (r) => /^(?:\s{2,}(?=[^\s-])|\s#|\s\|\s|\s*;|\s\}|\s→|\s·\s|\s\((?=[^)]*[가-힣]))/.test(r));
  return (at < 0 ? rest : rest.slice(0, at)).trim();
}

/** 문서의 자리 표시 → 예시 값 (글 단계 — `<클라이언트 ID>`처럼 빈칸이 든 것도 있다) */
const PLACEHOLDERS: [RegExp, string][] = [
  [/'\{…\}'/g, "'{}'"],
  [/\{…, /g, '{'],
  [/"…"/g, '"메모"'],
  [/<네 자리 숫자>/g, '1234'],
  [/<새 값>/g, 'rq-1'],
  [/google-client-id <(?:ID|클라이언트 ID)>/g, 'google-client-id 1234567890-abc.apps.googleusercontent.com'],
  [/--google-client-id <클라이언트 ID>/g, '--google-client-id 1234567890-abc.apps.googleusercontent.com'],
  [/agent revoke <ID>/g, 'agent revoke X-0001'],
  [/external:<ID>/g, 'external:X-0001'],
  [/--label <이름>/g, '--label 그록봇'],
  [/secret clear <이름>/g, 'secret clear google-client-secret'],
  [/<보유자>/g, 'launched:codex'],
  [/<(?:이메일|메일|대표 이메일|대표의 구글 메일)>/g, 'owner@example.com'],
  [/<폴더>/g, 'D:\\wook-data'],
  [/<파일\.png>/g, 'a.png'],
  [/<파일>/g, 'answer.md'],
  [/<턴 ID>/g, 'TN-0042'],
  [/<도구(?: 이름)?>/g, 'get_overview'],
  [/<인자 JSON 객체>/g, '{}'],
  [/<글>/g, '메모'],
  [/<번호>/g, '7317'],
  [/--data-dir …/g, '--data-dir D:\\wook-data'],
  [/\$env:USERPROFILE/g, 'C:\\Users\\owner'],
  // 출력 보기의 사용자 이름 (`C:\Users\<사용자>\wook-data`)
  [/<사용자>/g, 'owner'],
  [/\$env:LOCALAPPDATA/g, 'C:\\Users\\owner\\AppData\\Local'],
];

/** 선택 칸 `[…]`: `[서버 옵션]`처럼 이름만 있는 칸은 빼고, `[--a x | --b y]`는 갈래마다 한 줄씩 (리드 결정 S9-22 TI-3 — 뒤 갈래도 읽는다) */
function expandBrackets(s: string): string[] {
  const m = /\[([^[\]]*)\]/.exec(s);
  if (!m) return [s];
  const inner = m[1]!;
  const branches = /^[가-힣 ]+$/.test(inner) ? [''] : inner.split(' | ');
  return branches.flatMap((b) => expandBrackets(`${s.slice(0, m.index)}${b}${s.slice(m.index + m[0].length)}`));
}

/** 따옴표를 아는 낱말 나누기 (PowerShell·sh에서 같게 읽히는 꼴만 — 따옴표는 벗긴다) */
function tokens(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | null = null;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (q) throw new Error('닫히지 않은 따옴표');
  if (has || cur) out.push(cur);
  return out;
}

/** 낱말 안의 갈래 `a|b` → 갈래마다 인자 줄 하나 (JSON처럼 `{`로 시작하는 값은 나누지 않는다) */
function alternatives(args: string[]): string[][] {
  let rows: string[][] = [[]];
  for (const a of args) {
    const alts = a.startsWith('{') || !a.includes('|') ? [a] : a.split('|');
    rows = rows.flatMap((r) => alts.map((x) => [...r, x]));
  }
  return rows;
}

/**
 * 글 속의 코드 가운데 명령이 아니라 명령의 이름만 말하는 것 (예: '`wook tool`이 씁니다') — 그 꼴 그대로일 때만 뺀다. 코드 블록의 줄은 빼지 않는다.
 * 새 이름 말하기를 문서에 쓰면 여기에 더한다 (명령 줄로 쓰려면 인자를 다 적는다)
 */
const MENTIONS: Record<Tool, readonly string[]> = {
  server: ['agent revoke', 'seat assign'],
  wook: ['tool', 'screen capture', 'work done', 'work progress', 'seat release'],
  kit: [],
};

/** 코드 블록 안에서 명령 이름이 나오는데 명령으로 읽지 않은 줄 (PROSE_LINES에 없는 것) — 실패할 줄 */
interface Unread {
  doc: string;
  line: number;
  text: string;
}

/** 한 조각(코드 블록의 줄이나 글 속의 코드)에서 가장 앞의 명령 하나 — 없으면 null */
function firstInvocation(piece: string, fenced: boolean): { inv: { tool: Tool; cmd?: string }; raw: string } | null {
  let best: { inv: { tool: Tool; cmd?: string }; index: number; end: number } | null = null;
  for (const inv of fenced ? INVOKE_FENCED : INVOKE_INLINE) {
    const m = inv.re.exec(piece);
    if (m && (!best || m.index < best.index)) best = { inv, index: m.index, end: m.index + m[0].length };
  }
  return best ? { inv: best.inv, raw: cutTail(piece.slice(best.end)) } : null;
}

/** 문서 하나의 명령들 — 코드 블록의 줄과 글 속의 코드. 코드 블록에서 명령 이름이 나오는데 읽지 못한 줄은 unread로 */
function commandsIn(doc: string): { found: DocCommand[]; unread: Unread[]; proseSeen: string[] } {
  const lines = readFileSync(join(REPO, doc), 'utf8').split(/\r?\n/);
  const prose = PROSE_LINES[doc] ?? [];
  const found: DocCommand[] = [];
  const unread: Unread[] = [];
  const proseSeen: string[] = [];
  let fenced = false;
  lines.forEach((text, i) => {
    if (/^\s*```/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced && prose.includes(text.trim())) {
      proseSeen.push(text.trim());
      return;
    }
    // 글 속의 코드는 표 칸 안에서 `|`를 `\|`로 적는다 (GFM)
    const pieces = fenced ? [text] : [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/\\\|/g, '|'));
    let read = false;
    for (const piece0 of pieces) {
      // 보기의 프롬프트 (`$ wook …`, `PS> …`)
      const piece = piece0.replace(/^\s*(?:\$|PS>|>)\s+/, '');
      const hit = firstInvocation(piece, fenced);
      if (!hit) continue;
      const { inv, raw } = hit;
      // 명령 이름만 말하는 곳 (`wook-server …`, `wook … --data-dir D:\wook-data`)
      if (raw === '…' || raw.startsWith('… ')) {
        read = true;
        continue;
      }
      if (!fenced && MENTIONS[inv.tool].includes(raw)) continue;
      const prefix = inv.cmd ? cmdPrefix(inv.cmd) : [];
      const variants: string[][] = [];
      for (const branch of expandBrackets(raw)) {
        let s = branch;
        for (const [re, v] of PLACEHOLDERS) s = s.replace(re, v);
        try {
          variants.push(...alternatives(tokens(s)).map((v) => [...prefix, ...v]));
        } catch (error) {
          throw new Error(`${doc}:${i + 1} 명령을 낱말로 나누지 못했습니다 (${(error as Error).message}): ${raw}`);
        }
      }
      found.push({ doc, line: i + 1, tool: inv.tool, raw, variants });
      read = true;
    }
    if (fenced && !read && NAMED.test(text)) unread.push({ doc, line: i + 1, text: text.trim() });
  });
  return { found, unread, proseSeen };
}

const SCANS = DOCS.map((doc) => ({ doc, ...commandsIn(doc) }));
const ALL = SCANS.flatMap((s) => s.found);

/** 일부러 틀린 꼴로 적은 예 — 쓰임새 오류여야 하고 적은 값을 되풀이하지 않는다 (SERVER_INSTALL 2절: 비밀 값을 명령 줄에 붙인 실수) */
const WRONG_ON_PURPOSE = [{ doc: 'docs/SERVER_INSTALL.md', raw: /^config google-client-secret GOCSPX-/, secretLike: 'GOCSPX' }];

const wrongOnPurpose = (c: DocCommand) => WRONG_ON_PURPOSE.find((w) => w.doc === c.doc && w.raw.test(c.raw));

function parse(c: DocCommand, args: string[]): { error: string | null } {
  if (c.tool === 'server') {
    const p = parseCli(args, {}, 'win32');
    return { error: p.kind === 'error' ? p.message : null };
  }
  if (c.tool === 'wook') {
    const p = parseWook(args);
    return { error: p.kind === 'error' ? p.message : null };
  }
  const p = parseKitArgs(args);
  return { error: 'error' in p ? p.error : null };
}

const where = (c: DocCommand): string => `${c.doc}:${c.line} ${c.raw}`;

describe('설치 문서의 명령 줄 (setupDocCommands)', () => {
  it('자리 표시를 모두 바꿨다 — 바꾸지 못한 <…>·[…]·…·$변수가 남은 줄이 없다', () => {
    const left = ALL.flatMap((c) => c.variants.map((v) => ({ c, v }))).filter(({ v }) => v.some((a) => /[<>[\]]|^…$|^\$|\s\$/.test(a)));
    expect(left.map(({ c, v }) => `${where(c)} → ${JSON.stringify(v)}`)).toEqual([]);
  });

  it('wook-server·wook·체험 도구 줄이 모두 쓰임새 오류 없이 읽힌다 (일부러 틀린 예는 빼고)', () => {
    const bad: string[] = [];
    for (const c of ALL) {
      if (wrongOnPurpose(c)) continue;
      for (const v of c.variants) {
        const r = parse(c, v);
        if (r.error) bad.push(`${where(c)} → ${JSON.stringify(v)}: ${r.error}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('일부러 틀린 예는 쓰임새 오류이고, 적은 값을 되풀이하지 않는다', () => {
    const wrong = ALL.filter(wrongOnPurpose);
    expect(wrong.length).toBe(WRONG_ON_PURPOSE.length);
    for (const c of wrong) {
      for (const v of c.variants) {
        const r = parse(c, v);
        expect(r.error, where(c)).not.toBeNull();
        expect(r.error).not.toContain(wrongOnPurpose(c)!.secretLike);
      }
    }
  });

  it('코드 블록에서 명령 이름(wook·wook-server·try-*.cmd)이 나오는 줄은 모두 명령으로 읽었거나, 명령이 아닌 줄로 적어 두었다 (리드 결정 S9-22 TI-3)', () => {
    expect(SCANS.flatMap((s) => s.unread).map((u) => `${u.doc}:${u.line} ${u.text}`)).toEqual([]);
  });

  it('명령이 아닌 줄로 적어 둔 것(PROSE_LINES)은 그 문서의 코드 블록에 꼭 한 번씩 있다 — 문서가 바뀌어 남은 것이 없다', () => {
    for (const [doc, list] of Object.entries(PROSE_LINES)) {
      expect(DOCS as readonly string[], doc).toContain(doc);
      const seen = SCANS.find((s) => s.doc === doc)!.proseSeen;
      expect([...seen].sort(), doc).toEqual([...list].sort());
      expect(new Set(list).size, doc).toBe(list.length);
    }
  });

  it('찾는 규칙: 코드 블록에서는 안내 글 뒤·& 뒤의 명령도 읽고, [a | b]는 갈래마다 읽는다', () => {
    const cmd = (piece: string) => firstInvocation(piece, true)?.raw ?? null;
    expect(cmd('답을 UTF-8 파일에 쓰고 wook work done <턴 ID> --file answer.md')).toBe('work done <턴 ID> --file answer.md');
    expect(cmd('& scripts\\wook-server.cmd config reload --data-dir "$env:USERPROFILE\\wook-data"')).toBe('config reload --data-dir "$env:USERPROFILE\\wook-data"');
    expect(cmd('처리하는 동안 15초마다 wook seat heartbeat (임대 60초)')).toBe('seat heartbeat');
    expect(cmd('Get-Content .\\a.txt | scripts\\wook-server.cmd secret set google-client-secret')).toBe('secret set google-client-secret');
    expect(cmd('$dir = Join-Path $HOME \'.wook\'')).toBeNull();
    expect(expandBrackets('tool x [--json … | --json-file <파일>] [서버 옵션]')).toEqual(['tool x --json … ', 'tool x --json-file <파일> ']);
    // 글 속의 코드는 줄 머리 등에서만 (안내 글 속의 이름은 명령이 아니다)
    expect(firstInvocation('(wook-server check로 자세히)', false)).toBeNull();
    expect(firstInvocation('& scripts\\wook-server.cmd status', false)?.raw).toBe('status');
  });

  it('문서마다 명령을 찾았다 — 찾는 규칙이 망가져 아무것도 보지 않고 통과하지 않게', () => {
    const count = (doc: string, tool: Tool) => ALL.filter((c) => c.doc === doc && c.tool === tool).length;
    expect({
      setupServer: count('docs/SERVER_SETUP.md', 'server') >= 25,
      tryServer: count('docs/TRY_IT.md', 'server') >= 2,
      tryKit: count('docs/TRY_IT.md', 'kit') >= 8,
      installServer: count('docs/SERVER_INSTALL.md', 'server') >= 30,
      installWook: count('docs/SERVER_INSTALL.md', 'wook') >= 1,
      guideWook: count('docs/AGENT_GUIDE.md', 'wook') >= 20,
      readmeServer: count('README.md', 'server') >= 8,
    }).toEqual({ setupServer: true, tryServer: true, tryKit: true, installServer: true, installWook: true, guideWook: true, readmeServer: true });
  });

  it('9단계에 생긴 줄이 문서에 있고 읽힌다 — SERVER_INSTALL의 표(install-task·uninstall-task·check·API 키), SERVER_SETUP의 차례, TRY_IT의 구글 보안 비밀 (S9-20)', () => {
    const lines = (doc: string): string[] => ALL.filter((c) => c.doc === doc && c.tool === 'server' && !wrongOnPurpose(c)).flatMap((c) => c.variants.map((v) => v.join(' ')));
    const install = lines('docs/SERVER_INSTALL.md');
    const setup = lines('docs/SERVER_SETUP.md');
    const tryIt = lines('docs/TRY_IT.md');
    const has = (list: string[], re: RegExp) => list.some((l) => re.test(l));
    expect({
      installTask: has(install, /^install-task$/),
      uninstallTask: has(install, /^uninstall-task$/),
      check: has(install, /^check$/),
      claudeKey: has(install, /^secret set claude-api-key$/),
      codexKey: has(install, /^secret (set|clear) codex-api-key$/),
      setupInstallTask: has(setup, /^install-task --data-dir /),
      setupInstallDry: has(setup, /^install-task --dry-run --data-dir /),
      setupTaskName: has(setup, /^install-task --dry-run --json --data-dir /),
      setupUninstall: has(setup, /^uninstall-task --data-dir /),
      setupCheck: has(setup, /^check --data-dir /),
      setupSecret: has(setup, /^secret set google-client-secret --data-dir /),
      // 13단계: 서버를 끄기 전에 구글 보안 비밀을 지우는 줄 (리드 결정 S9-22 DF-12)
      setupSecretClear: has(setup, /^secret clear google-client-secret --data-dir /),
      setupSeatAssign: has(setup, /^seat assign external:X-0001 --data-dir /),
      trySecretSet: has(tryIt, /^secret set google-client-secret --data-dir C:\\Users\\owner\\AppData\\Local\\wookagent-try\\phone$/),
      trySecretClear: has(tryIt, /^secret clear google-client-secret --data-dir C:\\Users\\owner\\AppData\\Local\\wookagent-try\\phone$/),
    }).toEqual({
      installTask: true,
      uninstallTask: true,
      check: true,
      claudeKey: true,
      codexKey: true,
      setupInstallTask: true,
      setupInstallDry: true,
      setupTaskName: true,
      setupUninstall: true,
      setupCheck: true,
      setupSecret: true,
      setupSecretClear: true,
      setupSeatAssign: true,
      trySecretSet: true,
      trySecretClear: true,
    });
  });

  it('폴더를 손으로 만드는 줄(New-Item -ItemType Directory) 바로 다음 줄은 그 폴더를 이 사용자만 쓰게 좁히는 icacls다 — 데이터 폴더·키 폴더 (리드 결정 S9-22 DS-5)', () => {
    const found: string[] = [];
    const bad: string[] = [];
    for (const doc of ['docs/SERVER_SETUP.md', 'docs/SERVER_INSTALL.md', 'docs/TRY_IT.md', 'README.md']) {
      const lines = readFileSync(join(REPO, doc), 'utf8').split(/\r?\n/);
      let fenced = false;
      lines.forEach((text, i) => {
        if (/^\s*```/.test(text)) fenced = !fenced;
        const m = fenced ? /^\s*New-Item -ItemType Directory -Force (\S+) \| Out-Null$/.exec(text) : null;
        if (!m) return;
        found.push(`${doc}:${i + 1}`);
        const next = lines[i + 1]?.trim() ?? '';
        const target = m[1]!.replace(/[$\\^.()]/g, (c) => `\\${c}`);
        if (!new RegExp(`^icacls ${target} /inheritance:r /grant:r "[^"]+:\\(OI\\)\\(CI\\)F"`).test(next)) bad.push(`${doc}:${i + 2} ${next}`);
      });
    }
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(bad).toEqual([]);
  });

  it('scripts\\wook-server.cmd는 out\\server\\index.mjs에 인자를 그대로 넘긴다 — 문서의 scripts\\wook-server.cmd 줄과 wook-server 줄이 같은 해석기를 거친다', () => {
    expect(readFileSync(join(REPO, 'scripts', 'wook-server.cmd'), 'utf8').trim()).toBe('@node "%~dp0..\\out\\server\\index.mjs" %*');
    expect(cmdPrefix('try-server.cmd')).toEqual([]);
    expect(cmdPrefix('try-desktop.cmd')).toEqual(['desktop']);
  });
});
