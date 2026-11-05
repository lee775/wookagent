/**
 * 프로젝트 폴더 경로 검사 도구 (AC-18·19, 10.2·10.3 앱 금지 정책, GIT-03).
 *
 * 같은 폴더를 가리키는 철자는 여럿이다 — 대소문자·짧은 이름(8.3)·연결 지점(junction)·subst 드라이브·루프백 관리 공유(\\localhost\C$\…)·
 * 장치 경로(\\?\C:\…). 실제 경로 문자열 비교는 이 가운데 UNC를 놓친다(realpath는 \\localhost\C$를 C:\로 바꾸지 않는다). 그래서 폴더가
 * 같은지는 파일 식별자(볼륨 번호·파일 번호, stat bigint의 dev·ino)로 본다 — 어느 철자로 열어도 같다.
 *
 * Node는 경로를 글자 그대로 쓰지만(끝의 점·공백도 이름의 일부) git 같은 Win32 프로그램은 작업 위치의 끝 점·공백을 지운 폴더에서 돈다.
 * 그런 이름은 Node와 git이 서로 다른 폴더를 보게 하므로 등록하지 않는다 (winPathProblem).
 */
import { readdir, realpath as realpathAsync, stat as statAsync } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const isWin = process.platform === 'win32';
const fold = (s: string): string => (isWin ? s.toLowerCase() : s);

/** 폴더(파일) 식별자: 있으면 `볼륨:파일 번호`, 파일 번호를 주지 않는 파일 시스템이면 실제 경로 문자열. 없으면 null */
export function folderKey(p: string): string | null {
  let st;
  try {
    st = statSync(p, { bigint: true });
  } catch {
    return null;
  }
  if (st.ino !== 0n) return `id:${st.dev}:${st.ino}`;
  try {
    return `path:${fold(realpathSync.native(p))}`;
  } catch {
    return `path:${fold(resolve(p))}`;
  }
}

/**
 * p(없으면 가장 가까운 있는 상위 폴더)와 그 위 모든 상위 폴더의 식별자. 적힌 철자 그대로 올라간 것과 실제 경로(연결 지점을 푼 경로)로
 * 올라간 것을 모두 넣는다 — 연결 지점을 지나는 경로는 철자상의 상위 폴더와 실제 상위 폴더가 다르다
 */
export function ancestorKeys(p: string): Set<string> {
  const keys = new Set<string>();
  let cur = resolve(p);
  while (folderKey(cur) === null) {
    const parent = dirname(cur);
    if (parent === cur) return keys;
    cur = parent;
  }
  const climb = (start: string): void => {
    for (let c = start; ; ) {
      const k = folderKey(c);
      if (k) keys.add(k);
      const parent = dirname(c);
      if (parent === c) return;
      c = parent;
    }
  };
  climb(cur);
  try {
    climb(realpathSync.native(cur));
  } catch {
    // 실제 경로를 풀지 못하면 적힌 철자로 올라간 것만
  }
  return keys;
}

/** target이 dir과 같은 폴더이거나 그 안인지 (target은 없어도 된다 — 새 폴더는 가장 가까운 있는 상위 폴더로 본다). dir이 없으면 false */
export function isWithin(target: string, dir: string): boolean {
  const k = folderKey(dir);
  return k !== null && ancestorKeys(target).has(k);
}

/** target과 dir이 같은 (있는) 폴더인지 */
export function sameFolder(a: string, b: string): boolean {
  const k = folderKey(a);
  return k !== null && k === folderKey(b);
}

/** target이 있는 폴더이고 dir을 품는지 (dir이 target과 같거나 그 안) */
export function contains(target: string, dir: string): boolean {
  const k = folderKey(target);
  return k !== null && ancestorKeys(dir).has(k);
}

/**
 * 비교용 실제 경로: 있는 경로는 실제 경로(Windows는 대소문자·짧은 이름·연결 지점까지 푼 경로), 없는 경로(새 폴더)는 가장 가까운
 * 있는 상위 폴더를 풀고 나머지를 붙인다. 프로젝트 등록(team.ts)과 host_exec의 실행 위치 검사가 같은 함수를 쓴다 (리드 결정 S5-17 — team.ts에서 옮김)
 */
export function canonicalPath(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** child가 parent와 같거나 그 안인지 (둘 다 canonicalPath 결과, Windows는 대소문자 무시) */
export function isSameOrInside(child: string, parent: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * target과 dir의 관계: 같은 폴더·그 안·그 폴더를 품은 상위 폴더. 파일 식별자로 보고(같은 폴더의 다른 철자), 실제 경로 글자로도 본다
 * (폴더가 지워져 식별자가 없을 때 등 — 지워진 프로젝트 폴더 경로를 다시 등록하는 것도 같은 폴더로 본다). 프로젝트 등록과 host_exec가 같이 쓴다
 * (리드 결정 S5-17)
 */
export function relation(target: string, dir: string): 'same' | 'inside' | 'contains' | null {
  const a = canonicalPath(target);
  const b = canonicalPath(dir);
  if (sameFolder(target, dir) || (isSameOrInside(a, b) && isSameOrInside(b, a))) return 'same';
  if (isWithin(target, dir) || isSameOrInside(a, b)) return 'inside';
  if (contains(target, dir) || isSameOrInside(b, a)) return 'contains';
  return null;
}

/** 이 PC를 가리키는 UNC 호스트인지 (localhost·127.x·::1·컴퓨터 이름·이 PC의 IP) — 다른 PC면 경로에 손대지 않는다(네트워크 대기) */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0') return true;
  if (h === hostname().toLowerCase() || h === hostname().toLowerCase().split('.')[0]) return true;
  return Object.values(networkInterfaces())
    .flat()
    .some((a) => !!a && a.address.toLowerCase() === h);
}

/** Windows 경로 모양: 드라이브(C:\…)·UNC(\\서버\공유, \\?\UNC\…)·장치(\\?\C:\…, \\.\…) */
function shapeOf(p: string): { kind: 'drive' } | { kind: 'unc'; host: string } | { kind: 'device' } | { kind: 'other' } {
  if (/^[A-Za-z]:\\/.test(p)) return { kind: 'drive' };
  const ns = /^\\\\[?.]\\(.*)$/.exec(p);
  if (ns) {
    const unc = /^UNC\\([^\\]+)/i.exec(ns[1]!);
    return unc ? { kind: 'unc', host: unc[1]! } : { kind: 'device' };
  }
  const unc = /^\\\\([^\\]+)/.exec(p);
  return unc ? { kind: 'unc', host: unc[1]! } : { kind: 'other' };
}

/** 파일 식별자를 읽으려고 이 경로에 손대도 되는지 — 다른 PC의 공유 폴더는 stat이 네트워크를 오래 기다리며 앱을 멈출 수 있다 */
export function isTouchable(p: string): boolean {
  if (!isWin) return true;
  const s = shapeOf(p);
  return s.kind !== 'unc' || isLocalHost(s.host);
}

const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHAR_RE = /[<>:"|?*\u0000-\u001f]/;

/**
 * 프로젝트 폴더로 쓸 수 없는 Windows 경로면 그 까닭 (아니면 null). 로컬 드라이브 폴더(C:\…)만 받는다:
 * 네트워크 경로(\\서버\공유)·장치 경로(\\?\…, \\.\…), 끝이 점·공백인 이름(Win32 프로그램은 그 글자를 지운 다른 폴더를 쓴다),
 * 쓸 수 없는 문자·장치 이름(CON·NUL 등). 다른 OS는 검사하지 않는다
 */
export function winPathProblem(p: string): string | null {
  if (!isWin) return null;
  const s = shapeOf(p);
  if (s.kind === 'unc') return `네트워크 경로(\\\\${s.host}\\…)`;
  if (s.kind === 'device') return '장치 경로(\\\\?\\…, \\\\.\\…)';
  if (s.kind !== 'drive') return '드라이브 문자로 시작하지 않는 경로';
  for (const seg of p.slice(3).split('\\').filter(Boolean)) {
    if (/[. ]$/.test(seg)) return `이름이 점(.)이나 공백으로 끝나는 폴더("${seg}")`;
    if (BAD_CHAR_RE.test(seg)) return `Windows 폴더 이름에 쓸 수 없는 문자가 든 이름("${seg}")`;
    if (RESERVED_NAME_RE.test(seg)) return `Windows 장치 이름과 같은 폴더 이름("${seg}")`;
  }
  return null;
}

/**
 * Win32 프로그램(git 등)이 이 경로를 작업 위치로 받으면 실제로 쓰는 폴더 — 조각 끝의 점·공백을 지운다. 정확한 Win32 규칙보다 넓게 지운다
 * (막을 폴더를 찾는 데만 쓴다). Windows가 아니거나 바뀌지 않으면 null
 */
export function win32Effective(p: string): string | null {
  if (!isWin || shapeOf(p).kind !== 'drive') return null;
  const segs = p
    .slice(3)
    .split('\\')
    .map((x) => x.replace(/[. ]+$/, ''))
    .filter(Boolean);
  const out = join(p.slice(0, 3), ...segs);
  return out === p ? null : out;
}

/** 폴더 안 재분석 지점(연결 지점·심볼릭 링크) 검사 결과. unreadable: 폴더 자체를 읽지 못했다(없음·옮겨짐·권한) — 본 것이 없다 (S9-D3) */
export type LinkScan = { kind: 'clean' } | { kind: 'hit'; link: string; target: string; reason: string } | { kind: 'too_many'; limit: number } | { kind: 'unreadable' };

/** 한 링크를 git이 보는 경로 갈래 상한 — 넘거나 끝이 없으면(링크가 제 상위 폴더를 가리킨다) 무시된다고 보지 않는다 */
const LINK_PATHS_MAX = 1000;

/**
 * 폴더 안의 연결 지점·심볼릭 링크 가운데 막힌 곳(앱 데이터 폴더·다른 프로젝트 등)과 겹치는 것을 찾는다. git(Git for Windows)의 `add -A`는
 * 연결 지점을 폴더처럼 따라 들어가 그 안의 파일을 커밋한다 — 첫 커밋(ensureRepo) 전에 본다. 폴더는 모두 돈다(.git은 git이 커밋하지 않으므로
 * 빼고). 폴더 안을 가리키는 링크는 따라가지 않고(그 폴더는 제 경로로 돈다), 폴더 밖을 가리키는 링크는 git처럼 따라 들어가 그 안도 본다(같은
 * 폴더는 한 번만). git이 따라가지 않는 바깥 링크는 보지 않는다 (S9-D1, S10-D1·D2): 찾은 바깥 링크마다 git이 그 링크를 보는 경로(root 기준 '/'
 * 구분 — 상위 폴더 경로에 이름을 붙인 것과, 그 폴더나 상위 폴더를 가리키는 링크의 경로로 이은 것 모두)를 ignoredOf(GitService.ignoredPaths —
 * 그 경로나 상위 폴더가 무시 규칙에 걸리는 것)에 묻고, 모두 무시될 때만 따라가지도 blocked로 넘기지도 않는다. 새 경로가 보이면 다시 묻는다.
 * blocked(실제 경로)가 막을 까닭(없으면 null)을 준다. limit개 넘게 보면 그때까지 찾은 링크만 보고 끝까지 확인하지 못한 것으로 'too_many'
 */
export async function scanLinks(
  root: string,
  blocked: (realTarget: string) => string | null,
  ignoredOf: (gitPaths: string[]) => Promise<readonly string[]> = async () => [],
  limit = 300_000,
): Promise<LinkScan> {
  const realRoot = await realpathAsync(root).catch(() => resolve(root));
  const key = (p: string): string => fold(p).replace(/[\\/]+$/, '');
  const under = (k: string, top: string): boolean => k.startsWith(`${top}\\`) || k.startsWith(`${top}/`);
  const rootK = key(realRoot);
  const seen = new Set<string>();
  const rootKey = folderKey(realRoot);
  if (rootKey) seen.add(rootKey);
  /** 돈 폴더 묶음의 맨 위(root, 따라 들어간 바깥 폴더) — 그 안의 폴더는 상위 폴더 경로에 이름을 붙인 경로로도 git이 본다 */
  const tops = [rootK];
  /** 링크가 가리키는 실제 경로 → 그 링크가 있는 [폴더, 이름] — 그 아래는 링크 경로로도 git이 본다 */
  const into = new Map<string, [string, string][]>();
  /** git이 dir을 보는 root 기준 경로들 — 끝이 없거나(chain: 지금 거슬러 오르는 폴더들) 너무 많으면 null */
  const gitPaths = (dir: string, chain: Set<string>): string[] | null => {
    const k = key(dir);
    if (chain.has(k)) return null;
    chain.add(k);
    const out = k === rootK ? [''] : [];
    const from = [...(into.get(k) ?? [])];
    if (tops.some((t) => under(k, t))) from.push([dirname(dir), basename(dir)]);
    for (const [d, name] of from) {
      const ps = gitPaths(d, chain);
      if (!ps) return null;
      for (const p of ps) out.push(p ? `${p}/${name}` : name);
      if (out.length > LINK_PATHS_MAX) return null;
    }
    chain.delete(k);
    return out;
  };
  const ignored = new Map<string, boolean>();
  /** git이 따라가는지 아직 정하지 않은 바깥 링크 — 본 git 경로가 모두 무시되면 남겨 두었다가, 새 경로가 보이면 다시 본다 */
  let open: { dir: string; name: string; full: string; real: string }[] = [];
  const walk = [realRoot];
  let entries = 0;
  let over = false;
  for (;;) {
    while (walk.length && !over) {
      const dir = walk.pop()!;
      let list;
      try {
        list = await readdir(dir, { withFileTypes: true });
      } catch {
        if (dir === realRoot) return { kind: 'unreadable' };
        continue; // 읽을 수 없는 폴더는 git도 넣지 못한다
      }
      for (const ent of list) {
        if (++entries > limit) {
          over = true;
          break;
        }
        if (ent.name === '.git') continue;
        const full = join(dir, ent.name);
        if (ent.isSymbolicLink()) {
          const real = await realpathAsync(full).catch(() => null);
          if (real === null) continue; // 끊긴 링크
          const k = key(real);
          const at = into.get(k);
          if (at) at.push([dir, ent.name]);
          else into.set(k, [[dir, ent.name]]);
          // 이 폴더 안을 가리키면 따라가지 않는다 — 그 폴더는 제 경로로 돌고, 이 링크 경로는 그 아래를 보는 git 경로가 된다
          if (k !== rootK && !under(k, rootK)) open.push({ dir, name: ent.name, full, real });
        } else if (ent.isDirectory()) {
          walk.push(full);
        }
      }
    }
    const paths = open.map((l) => gitPaths(l.dir, new Set())?.map((p) => (p ? `${p}/${l.name}` : l.name)) ?? null);
    const ask = [...new Set(paths.flatMap((ps) => ps ?? []))].filter((p) => !ignored.has(p));
    if (ask.length) {
      const yes = new Set(await ignoredOf(ask));
      for (const p of ask) ignored.set(p, yes.has(p));
    }
    const still: typeof open = [];
    for (const [i, l] of open.entries()) {
      const ps = paths[i];
      if (ps?.length && ps.every((p) => ignored.get(p))) {
        still.push(l);
        continue;
      }
      const reason = blocked(l.real);
      if (reason) return { kind: 'hit', link: l.full, target: l.real, reason };
      if (over) continue;
      const st = await statAsync(l.real, { bigint: true }).catch(() => null);
      if (!st?.isDirectory()) continue;
      const k = st.ino !== 0n ? `id:${st.dev}:${st.ino}` : `path:${fold(l.real)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      tops.push(key(l.real));
      walk.push(l.real);
    }
    open = still;
    if (over) return { kind: 'too_many', limit };
    if (!walk.length) return { kind: 'clean' };
  }
}
