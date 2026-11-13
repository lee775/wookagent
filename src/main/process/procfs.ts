/**
 * Linux /proc 읽기 (리드 결정 S10-5). 읽기만 하고 신호는 보내지 않는다. 모든 함수가 proc 루트를 인자로 받는다 — 시험은 가짜 루트(임시 폴더)로
 * Windows에서도 같은 코드를 돌린다.
 * - 부팅 기준 신원 ProcStart = { bootId, ticks }: /proc/sys/kernel/random/boot_id와 /proc/<pid>/stat의 22번째 칸(부팅 뒤 시작 틱).
 *   벽시계가 움직여도(NTP 보정·VM 재개·손으로 바꾼 시각) 변하지 않는다. 생성 시각(epoch ms)은 부팅 시각(btime)이 시계와 함께 움직여 같이 움직인다 (S2-22)
 * - 생성 시각: procps의 `ps -o lstart`와 같은 식 (btime + ⌊ticks / USER_HZ⌋)초 — 예전 기록과 그대로 견줄 수 있다
 * - 프로세스 그룹 구성원(stat 5번째 칸 pgrp)과, 실행 표시(환경 변수)를 가진 후손·부모 PID로 이어진 후손 찾기 (남은 후손 정리, S10-5.2)
 * - linuxProcProblem: 서버가 시작할 때와 check가 보는 '/proc를 읽을 수 있는지' (S10-5.3)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 프로세스의 부팅 기준 신원 — 같은 부팅에서 PID와 함께 프로세스 하나를 가리킨다 */
export interface ProcStart {
  /** /proc/sys/kernel/random/boot_id (UUID, 소문자) */
  bootId: string;
  /** /proc/<pid>/stat 22번째 칸 starttime — 부팅 뒤 시작 틱 (USER_HZ 단위) */
  ticks: number;
}

/** /proc/<pid>/stat에서 쓰는 칸 */
export interface ProcStat {
  pid: number;
  /** 3번째 칸 (R·S·D·Z·T·…) */
  state: string;
  ppid: number;
  /** 5번째 칸: 프로세스 그룹 */
  pgrp: number;
  session: number;
  /** 22번째 칸: 부팅 뒤 시작 틱 */
  startTicks: number;
}

export const PROC_ROOT = '/proc';
/**
 * /proc가 쓰는 시각 단위(USER_HZ, 초당 틱). 커널 ABI로 고정된 값이라 Node가 도는 모든 Linux 아키텍처(x86·arm·arm64·ppc64·s390x·riscv·loongarch)에서
 * 100이다 — procps의 sysconf(_SC_CLK_TCK)와 같다
 */
export const USER_HZ = 100;
/** 실행마다 붙이는 표시 환경 변수의 이름 (KEY·SECRET·TOKEN을 넣지 않는다 — CLI가 그런 이름은 명령에 넘기지 않는다) */
export const RUN_TAG_ENV = 'WOOK_RUN_TAG';

/** 이 플랫폼에서 /proc로 프로세스를 읽는지 — Linux만. macOS는 /proc가 없어 예전대로 ps를 쓴다 */
export function defaultProcRoot(): string | null {
  return process.platform === 'linux' ? PROC_ROOT : null;
}

const DIGITS = /^\d+$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * /proc/<pid>/stat 한 줄. comm(2번째 칸)은 괄호 안에 공백·괄호·줄바꿈까지 담을 수 있어 **마지막** ')' 뒤부터 칸을 나눈다.
 * 형식이 틀리거나 칸이 모자라면 null
 */
export function parseProcStat(text: string): Omit<ProcStat, 'pid'> | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 1).trim().split(/\s+/);
  // f[0] state(3) · f[1] ppid(4) · f[2] pgrp(5) · f[3] session(6) · … · f[19] starttime(22)
  if (f.length < 20 || !/^[A-Za-z]$/.test(f[0]!)) return null;
  const picked = [f[1]!, f[2]!, f[3]!, f[19]!];
  if (!picked.every((v) => DIGITS.test(v))) return null;
  const [ppid, pgrp, session, startTicks] = picked.map(Number) as [number, number, number, number];
  if (![ppid, pgrp, session, startTicks].every(Number.isSafeInteger)) return null;
  return { state: f[0]!, ppid, pgrp, session, startTicks };
}

/** /proc/<pid>/stat (없거나 읽지 못하면 null — 그사이 끝난 프로세스 포함) */
export function readProcStat(pid: number, root: string): ProcStat | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let text: string;
  try {
    // comm은 아무 바이트나 될 수 있다 — 바이트 그대로 읽는다 (')'는 다른 문자의 일부가 아니다)
    text = readFileSync(join(root, String(pid), 'stat'), 'latin1');
  } catch {
    return null;
  }
  const s = parseProcStat(text);
  return s ? { pid, ...s } : null;
}

/** 실제 /proc의 boot id는 이 부팅 동안 바뀌지 않는다 — 한 번만 읽는다 (가짜 루트는 늘 다시 읽는다) */
let cachedBootId: string | null = null;

/** /proc/sys/kernel/random/boot_id (UUID 모양이 아니거나 읽지 못하면 null) */
export function readBootId(root: string): string | null {
  if (root === PROC_ROOT && cachedBootId) return cachedBootId;
  let id: string;
  try {
    id = readFileSync(join(root, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim().toLowerCase();
  } catch {
    return null;
  }
  if (!BOOT_ID.test(id)) return null;
  if (root === PROC_ROOT) cachedBootId = id;
  return id;
}

/** /proc/stat의 btime(부팅 시각, epoch 초). 벽시계를 옮기면 함께 움직인다 — 그래서 저장하지 않고 늘 다시 읽는다 */
export function readBtime(root: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(root, 'stat'), 'utf8');
  } catch {
    return null;
  }
  const m = /^btime\s+(\d+)\s*$/m.exec(text);
  const v = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(v) ? v : null;
}

/** 시작 틱 → 생성 시각(epoch ms): procps `ps -o lstart`와 같은 식 — (btime + ⌊ticks / USER_HZ⌋)초 */
export function createdAtFromTicks(btime: number, ticks: number): number {
  return (btime + Math.floor(ticks / USER_HZ)) * 1000;
}

/** 그 PID의 부팅 기준 신원 (읽지 못하면 null) */
export function procStartOf(pid: number, root: string): ProcStart | null {
  const bootId = readBootId(root);
  if (!bootId) return null;
  const s = readProcStat(pid, root);
  return s ? { bootId, ticks: s.startTicks } : null;
}

/** 여러 PID의 부팅 기준 신원. 읽지 못한 PID는 빠진다 */
export function procStartsOf(pids: readonly number[], root: string): Map<number, ProcStart> {
  const out = new Map<number, ProcStart>();
  const bootId = readBootId(root);
  if (!bootId) return out;
  for (const pid of pids) {
    const s = readProcStat(pid, root);
    if (s) out.set(pid, { bootId, ticks: s.startTicks });
  }
  return out;
}

/** 여러 PID의 생성 시각(epoch ms, 초 단위로 자름 — ps lstart와 같다). 읽지 못한 PID는 빠진다 */
export function procCreatedAt(pids: readonly number[], root: string): Map<number, number> {
  const out = new Map<number, number>();
  const btime = readBtime(root);
  if (btime === null) return out;
  for (const pid of pids) {
    const s = readProcStat(pid, root);
    if (s) out.set(pid, createdAtFromTicks(btime, s.startTicks));
  }
  return out;
}

/** 기록에서 읽은 값 → ProcStart (모양이 틀리면 null — 그 기록은 예전 규칙으로 판정한다) */
export function parseProcStart(v: unknown): ProcStart | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const bootId = typeof o['bootId'] === 'string' ? o['bootId'].toLowerCase() : '';
  const ticks = o['ticks'];
  if (!BOOT_ID.test(bootId) || typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks < 0) return null;
  return { bootId, ticks };
}

/**
 * 기록한 신원과 지금 그 PID의 신원이 같은 프로세스인지 — 실행 잠금·데이터 주인·재시작 복구가 함께 쓰는 하나의 비교 (리드 결정 S10-5.1).
 * 둘 다 있으면 정확히 견준다: 부팅이 다르거나 시작 틱이 다르면 'different', 같으면 'same' (여유 없음, 벽시계를 보지 않는다).
 * 어느 한쪽이라도 없으면 'unknown' — 호출자는 예전 규칙(생성 시각 ±1초 등)으로 판정한다 (예전 기록·Windows·macOS·/proc를 읽지 못함)
 */
export function compareProcStart(recorded: ProcStart | null | undefined, live: ProcStart | null | undefined): 'same' | 'different' | 'unknown' {
  if (!recorded || !live) return 'unknown';
  if (recorded.bootId !== live.bootId) return 'different';
  return recorded.ticks === live.ticks ? 'same' : 'different';
}

/** /proc의 PID 목록 (읽지 못하면 null) */
export function listProcPids(root: string): number[] | null {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const out: number[] = [];
  for (const n of names) if (DIGITS.test(n)) out.push(Number(n));
  return out;
}

/** 모든 프로세스의 stat (keep으로 거른다). /proc를 읽지 못하면 null. 그사이 끝난 프로세스는 빠진다 */
export function scanProcStats(root: string, keep: (s: ProcStat) => boolean = () => true): ProcStat[] | null {
  const pids = listProcPids(root);
  if (pids === null) return null;
  const out: ProcStat[] = [];
  for (const pid of pids) {
    const s = readProcStat(pid, root);
    if (s && keep(s)) out.push(s);
  }
  return out;
}

/** 프로세스 그룹 구성원 (pgrep -g와 같다 — 좀비도 센다). /proc를 읽지 못하면 null */
export function procGroupMembers(pgid: number, root: string): number[] | null {
  const found = scanProcStats(root, (s) => s.pgrp === pgid);
  return found === null ? null : found.map((s) => s.pid);
}

/** 이 프로세스(욱채 자신)의 프로세스 그룹 (읽지 못하면 null) */
export function ownProcessGroup(root: string): number | null {
  const s = readProcStat(process.pid, root);
  return s ? s.pgrp : null;
}

/** environ(NUL로 나뉜 NAME=값)에 정확히 그 항목이 있는지 */
export function environHas(environ: Buffer, entry: string): boolean {
  const needle = Buffer.from(entry, 'utf8');
  for (let at = environ.indexOf(needle); at >= 0; at = environ.indexOf(needle, at + 1)) {
    const startOk = at === 0 || environ[at - 1] === 0;
    const end = at + needle.length;
    if (startOk && (end === environ.length || environ[end] === 0)) return true;
  }
  return false;
}

/** /proc/<pid>/environ (읽지 못하면 null — 다른 사용자·덤프 불가 프로세스·그사이 끝남) */
function readEnviron(pid: number, root: string): Buffer | null {
  const r = readEnvironResult(pid, root);
  return r.ok ? r.env : null;
}

/**
 * /proc/<pid>/environ — 읽지 못했을 때 그 프로세스가 이미 끝났으면(stat도 없음) gone, 아직 있으면 그 까닭(덤프 불가·다른 사용자의 EACCES 등).
 * 끝남은 오류 코드가 아니라 프로세스가 아직 있는지로 가른다 — 막 끝나는 프로세스의 파일은 ENOENT·ESRCH 어느 쪽으로도 실패한다
 */
function readEnvironResult(pid: number, root: string): { ok: true; env: Buffer } | { ok: false; gone: boolean; code: string } {
  try {
    return { ok: true, env: readFileSync(join(root, String(pid), 'environ')) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'ERR';
    return { ok: false, gone: readProcStat(pid, root) === null, code };
  }
}

/**
 * /proc/<pid>/cgroup(또는 'self')의 cgroup 경로 (리드 결정 S10-13 LP-1). cgroup v2는 `0::/경로` 한 줄이다. v1·혼합 호스트는 여러 줄인데, 통합 계층(`0::`)이
 * 있으면 그것을, 없으면 systemd 계층(`N:name=systemd:/경로`)을 쓴다. 둘 다 없으면 쓸 수 있는 경로가 없다. 그사이 끝났으면 gone
 */
export function readCgroupPath(pid: number | 'self', root: string): { ok: true; path: string } | { ok: false; gone: boolean; why: string } {
  let text: string;
  try {
    text = readFileSync(join(root, String(pid), 'cgroup'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'ERR';
    return { ok: false, gone: pid !== 'self' && readProcStat(pid, root) === null, why: `cgroup을 읽지 못함 (${code})` };
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const unified = lines.find((l) => l.startsWith('0::'));
  const named = lines.find((l) => /^\d+:name=systemd:/.test(l));
  const line = unified ?? named;
  if (!line) return { ok: false, gone: false, why: 'cgroup에 통합 계층(0::)도 systemd 계층도 없음' };
  const path = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
  return path.startsWith('/') ? { ok: true, path } : { ok: false, gone: false, why: `cgroup 경로를 알아볼 수 없음 (${path.slice(0, 80)})` };
}

/** cgroup 경로 inner가 outer와 같거나 그 아래인지 (outer가 루트 '/'면 모두) */
export function cgroupWithin(inner: string, outer: string): boolean {
  if (outer === '/' || inner === outer) return true;
  return inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`);
}

/** /proc/<pid>/status의 실제 uid (Uid: 줄 첫 칸). 읽지 못하면 null */
export function readRealUid(pid: number | 'self', root: string): number | null {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(readFileSync(join(root, String(pid), 'status'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** 실행이 남긴 것으로 찾은 프로세스 */
export interface RunLeftover {
  pid: number;
  /** 신호 직전에 다시 견줄 시작 틱 (PID 재사용 방지) */
  ticks: number;
  /** 찾은 까닭: 실행 표시(환경 변수) · 부모 PID로 이어진 후손 */
  via: 'tag' | 'tree';
}

/** 그 실행의 것인지 확인하지 못한 프로세스 (신호를 보내지 않는다 — 결과는 '확인하지 못함') */
export interface UncheckedProcess {
  pid: number;
  ticks: number;
  why: string;
}

/** 한 번의 찾기 결과 */
export interface LeftoverScan {
  found: RunLeftover[];
  /** 이 실행의 표시가 있는데 cgroup을 알 수 없어 이 실행의 후손인지 가르지 못한 것 — 신호하지 않고, 결과는 '확인하지 못함'(-1) */
  unchecked: UncheckedProcess[];
  /**
   * 이 서버의 cgroup 안에서 실행 뒤에 시작한 이 사용자의 프로세스인데 환경을 읽지 못해(덤프 불가 — ssh-agent 등) 이 실행의 것인지 알 수 없는 것 — 신호하지 않고
   * 결과도 바꾸지 않는다. 결과 글에 이름만 남긴다 (리드 결정 S10-14: 이 실행과 이어 주는 것이 없다 — 같은 cgroup을 다른 실행·프로그램이 나눈다)
   */
  unattributed: UncheckedProcess[];
}

/**
 * 한 실행이 남긴 프로세스 찾기 (리드 결정 S10-5.2·S10-13·S10-16): 그 실행이 시작한 뒤(minTicks 이후)에 시작한 프로세스 가운데
 * - 환경에 그 실행의 표시(tagEntry = `WOOK_RUN_TAG=<값>`)가 있는 것 — 그룹을 떠났어도(setsid·timeout·데몬) 환경을 물려받았으면 찾는다.
 *   다만 **이 서버의 cgroup이나 그 아래**에 있는 것만 (LP-1): 실행이 사용자 관리자(systemd --user·D-Bus)에 환경을 넘기면 그 뒤 그 관리자가 띄운 유닛도
 *   표시를 갖지만, 그 유닛은 다른 cgroup(app.slice 등)에 있어 이 실행의 것이 아니다. 표시는 있는데 cgroup을 알 수 없는 후보는 신호하지 않고 unchecked로
 *   알린다 — 호출자는 '확인하지 못함'(-1)으로 답한다. 이 서버의 cgroup 안에 있는 이 사용자의 후보인데 환경을 읽지 못한 것(덤프 불가 — ssh-agent 등)은
 *   신호하지 않고 unattributed로 이름만 알린다 — 결과는 바꾸지 않는다 (리드 결정 S10-14)
 * - 그 다음, treeFrom(지금 그 실행의 그룹 구성원·이미 찾은 것)과 **이번에 표시로 찾은 것** 모두에서 부모 PID로 이어진 후손 — 새로 이어진 것이 없을
 *   때까지 (FPS-1). 부모로 이어진 것은 이 실행의 것이다: 표시가 보이지 않아도(환경을 지움·프로세스 제목을 덮어씀), 다른 cgroup에 있어도(tmux 창의
 *   scope), 환경을 읽지 못해도 고른다 — 그런 것은 unchecked·unattributed에서 뺀다. 부모가 살아 있는 동안만 이어진다: 호출자는 신호 전에 찾는다
 * exclude(욱채 자신·부모)와 treeFrom 자신은 빼고, 좀비는 이미 끝난 것으로 본다. /proc 목록을 읽지 못하면 null ('확인하지 못함').
 * 시작 틱으로 먼저 거르고, 표시는 이 서버의 cgroup 안의 프로세스에서만 읽는다 — 실행보다 오래된 프로세스나 다른 cgroup(대표의 다른 프로그램)의 환경은
 * 읽지 않는다
 */
export function findRunLeftovers(o: {
  root: string;
  tagEntry: string | null;
  minTicks: number;
  treeFrom?: readonly number[];
  exclude?: ReadonlySet<number>;
}): LeftoverScan | null {
  const exclude = o.exclude ?? new Set<number>();
  const roots = new Set(o.treeFrom ?? []);
  const recent = scanProcStats(o.root, (s) => s.startTicks >= o.minTicks || roots.has(s.pid));
  if (recent === null) return null;
  const out = new Map<number, RunLeftover>();
  const unchecked: UncheckedProcess[] = [];
  const unattributed: UncheckedProcess[] = [];
  const take = (s: ProcStat, via: RunLeftover['via']): void => {
    if (exclude.has(s.pid) || roots.has(s.pid) || s.pid <= 1 || s.state === 'Z' || s.state === 'X' || out.has(s.pid)) return;
    if (s.startTicks < o.minTicks) return;
    out.set(s.pid, { pid: s.pid, ticks: s.startTicks, via });
  };
  if (o.tagEntry) {
    const self = readCgroupPath('self', o.root);
    const uid = readRealUid('self', o.root);
    for (const s of recent) {
      if (out.has(s.pid) || exclude.has(s.pid) || roots.has(s.pid) || s.pid <= 1 || s.startTicks < o.minTicks || s.state === 'Z' || s.state === 'X') continue;
      const cg = readCgroupPath(s.pid, o.root);
      if (!cg.ok && cg.gone) continue;
      // 이 서버의 cgroup 안인지: true·false, 또는 모름(이 서버나 후보의 cgroup을 읽지 못함 — null)
      const inside = self.ok && cg.ok ? cgroupWithin(cg.path, self.path) : null;
      // 다른 cgroup — 이 실행의 후손이 아니다 (사용자 관리자가 띄운 유닛 등). 환경도 읽지 않는다
      if (inside === false) continue;
      const env = readEnvironResult(s.pid, o.root);
      if (env.ok) {
        if (!environHas(env.env, o.tagEntry)) continue;
        if (inside) take(s, 'tag');
        // 표시는 있는데 cgroup을 몰라 이 실행의 후손인지 가르지 못한다 — 신호하지 않고 확인하지 못한 것으로
        else unchecked.push({ pid: s.pid, ticks: s.startTicks, why: !self.ok ? `이 서버의 ${self.why}` : !cg.ok ? cg.why : 'cgroup을 알 수 없음' });
        continue;
      }
      if (env.gone) continue;
      // 이 서버의 cgroup 안, 실행 뒤에 시작한 이 사용자의 프로세스인데 환경을 읽지 못했다 (덤프 불가) — 이 실행의 것인지 모른다
      if (inside && uid !== null && readRealUid(s.pid, o.root) === uid) unattributed.push({ pid: s.pid, ticks: s.startTicks, why: `환경을 읽지 못함 (${env.code})` });
    }
  }
  // 부모 PID로 닫는다: 뿌리와 표시로 찾은 것 모두에서, 새로 이어진 것도 뿌리로 삼아 더 없을 때까지 (FPS-1). 표시로 찾은 감싸개(setsid한 셸·tmux 서버)의
  // 자식은 표시가 보이지 않을 수 있다 — 감싸개가 신호로 끝나기 전에 여기서 고른다. 메모리 안의 일이다 (이미 읽은 stat로)
  const children = new Map<number, ProcStat[]>();
  for (const s of recent) {
    const list = children.get(s.ppid);
    if (list) list.push(s);
    else children.set(s.ppid, [s]);
  }
  const queue = [...roots, ...out.keys()];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const c of children.get(parent) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      take(c, 'tree');
      queue.push(c.pid);
    }
  }
  const tied = (u: UncheckedProcess): boolean => !out.has(u.pid);
  return { found: [...out.values()], unchecked: unchecked.filter(tied), unattributed: unattributed.filter(tied) };
}

/**
 * 그 프로세스가 아직 그 시작 틱의 바로 그 프로세스로 살아 있는지 (좀비는 끝난 것). 신호 직전에 본다 — 끝난 프로세스의 번호를 다른 프로세스가
 * 다시 썼으면 false
 */
export function sameLiveProcess(pid: number, ticks: number, root: string): boolean {
  const s = readProcStat(pid, root);
  return !!s && s.startTicks === ticks && s.state !== 'Z' && s.state !== 'X';
}

/** 실행 표시 값의 모양 (16자리 16진수 — ManagedChild가 만드는 값) */
const RUN_TAG_VALUE = /^[0-9a-f]{16}$/;

/** 기록에서 읽은 실행 표시 값 (모양이 틀리면 null) */
export function parseRunTag(v: unknown): string | null {
  return typeof v === 'string' && RUN_TAG_VALUE.test(v) ? v : null;
}

/** 그룹이 그 실행의 것인지 (리더가 끝난 뒤 남은 그룹, S10-5.4) */
export type GroupOwnership = { verdict: 'ours' } | { verdict: 'other'; why: string } | { verdict: 'unknown'; why: string };

/**
 * 리더(PID = pgid)가 끝났는데 그 프로세스 그룹이 남아 있을 때, 그 그룹이 실행 표시 tag(값)를 가진 그 실행의 것인지 (리드 결정 S10-10.2 — 재시작 복구).
 * Linux는 그룹 번호를 쓰는 동안 그 번호를 새 PID로 주지 않으므로, 남은 그룹은 그 실행의 것이거나 — 그 실행의 그룹이 다 끝난 뒤 같은 번호를 받은 다른
 * 프로세스가 만든 그룹이다. 시작 틱으로는 둘을 가를 수 없어 표시로 가른다: 살아 있는 구성원(좀비 빼고) **모두**의 환경을 읽을 수 있고 모두 그 표시를
 * 가졌을 때만 'ours'. 표시 없는(또는 다른 표시의) 구성원이 하나라도 있으면 'other', 읽지 못한 구성원이 있으면 'unknown'. 리더가 아직 있거나 구성원이 없거나
 * /proc를 읽지 못하면 null — 이 판정을 쓰지 않는다
 */
export function groupRunOwnership(pgid: number, tag: string, root: string): GroupOwnership | null {
  const leader = readProcStat(pgid, root);
  if (leader && leader.state !== 'Z' && leader.state !== 'X') return null;
  const members = scanProcStats(root, (s) => s.pgrp === pgid && s.state !== 'Z' && s.state !== 'X');
  if (members === null || members.length === 0) return null;
  const entry = `${RUN_TAG_ENV}=${tag}`;
  let unreadable = 0;
  for (const m of members) {
    const env = readEnviron(m.pid, root);
    if (env === null) unreadable++;
    else if (!environHas(env, entry)) return { verdict: 'other', why: `그 그룹의 PID ${m.pid}에 그 실행의 표시가 없음` };
  }
  if (unreadable > 0) return { verdict: 'unknown', why: `리더가 끝난 그룹의 구성원 ${unreadable}개의 환경을 읽지 못해 그 실행의 것인지 확인하지 못함` };
  return { verdict: 'ours' };
}

/**
 * Linux 서버가 시작할 때(serve, 잠금 전)와 check가 보는 사실 (리드 결정 S10-5.3): 욱채는 Linux에서 ps·pgrep 없이 /proc로 프로세스의 신원·생성 시각·
 * 그룹 구성원·남은 후손을 확인한다. 그 파일을 읽을 수 없으면 그 까닭(한국어 한 줄), 읽을 수 있으면 null. 읽기만 한다
 */
export function linuxProcProblem(root: string = PROC_ROOT): string | null {
  const pids = listProcPids(root);
  if (pids === null) return `${root}를 읽지 못합니다 — 욱채 서버는 Linux에서 ${root}로 프로세스를 확인합니다 (${root}가 마운트된 환경에서 실행하세요)`;
  let selfStat: string;
  try {
    selfStat = readFileSync(join(root, 'self', 'stat'), 'latin1');
  } catch (err) {
    return `${root}/self/stat을 읽지 못합니다 (${errCode(err)}) — 욱채 서버는 Linux에서 ${root}로 프로세스를 확인합니다`;
  }
  if (!parseProcStat(selfStat)) return `${root}/self/stat의 형식을 알아볼 수 없습니다 — 욱채 서버는 Linux 커널의 ${root} 형식이 필요합니다`;
  if (!readBootId(root)) return `${root}/sys/kernel/random/boot_id를 읽지 못합니다 — 욱채 서버는 재시작 뒤 같은 프로세스인지 이 값으로 확인합니다`;
  if (readBtime(root) === null) return `${root}/stat에서 부팅 시각(btime)을 읽지 못합니다 — 욱채 서버는 프로세스 생성 시각을 이 값으로 계산합니다`;
  if (pids.length === 0) return `${root}에 프로세스가 하나도 보이지 않습니다 — 욱채 서버는 ${root}로 자기 실행의 하위 프로세스를 찾습니다`;
  return null;
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? (err instanceof Error ? err.message : String(err));
}
