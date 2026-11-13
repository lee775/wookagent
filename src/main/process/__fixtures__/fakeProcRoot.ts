/**
 * 시험용 가짜 /proc 루트 (리드 결정 S10-5): 임시 폴더에 Linux /proc의 파일 모양(boot_id·stat의 btime·<pid>/stat·<pid>/environ·self/stat)을 만든다.
 * procfs.ts의 모든 함수가 루트를 인자로 받으므로 Windows에서도 Linux와 같은 코드가 돈다. 시험이 끝나면 cleanup()으로 지운다
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeProcEntry {
  pid: number;
  comm?: string;
  state?: string;
  ppid?: number;
  pgrp?: number;
  session?: number;
  /** stat 22번째 칸 (부팅 뒤 시작 틱) */
  ticks: number;
  /** environ (없으면 파일을 만들지 않는다 — 읽지 못하는 프로세스) */
  environ?: Record<string, string> | null;
  /** /proc/<pid>/cgroup 내용 (기본: 이 서버와 같은 cgroup `0::${SELF_CGROUP}`, null = 파일 없음 — 읽지 못함) */
  cgroup?: string | null;
  /** /proc/<pid>/status의 실제 uid (기본 1000 — 이 서버와 같은 사용자, null = 파일 없음) */
  uid?: number | null;
}

/** 가짜 루트에서 이 서버(self)가 있는 cgroup (systemd 사용자 유닛 모양) */
export const SELF_CGROUP = '/user.slice/user-1000.slice/user@1000.service/app.slice/wook-server-1234abcd.service';
export const SELF_UID = 1000;

function statusText(uid: number): string {
  return [`Name:\tnode`, `State:\tS (sleeping)`, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`, `Gid:\t${uid}\t${uid}\t${uid}\t${uid}`, ''].join('\n');
}

export const FAKE_BOOT_ID = '0f6c2a3e-5b7d-4c1e-9a8b-112233445566';

/** /proc/<pid>/stat 한 줄 (Linux 커널과 같은 칸 차례 — 22번째가 starttime) */
export function statLine(e: FakeProcEntry): string {
  const ppid = e.ppid ?? 1;
  const pgrp = e.pgrp ?? e.pid;
  const session = e.session ?? pgrp;
  return `${e.pid} (${e.comm ?? 'node'}) ${e.state ?? 'S'} ${ppid} ${pgrp} ${session} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${e.ticks} 12345678 300 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 17 3 0 0 0 0 0\n`;
}

export class FakeProcRoot {
  constructor(readonly root: string) {}

  setBootId(id: string | null): this {
    const dir = join(this.root, 'sys', 'kernel', 'random');
    mkdirSync(dir, { recursive: true });
    if (id === null) rmSync(join(dir, 'boot_id'), { force: true });
    else writeFileSync(join(dir, 'boot_id'), `${id}\n`);
    return this;
  }

  /** /proc/stat의 btime (부팅 시각, epoch 초). 벽시계를 옮기면 커널이 이 값을 함께 옮긴다 — 시험은 이것으로 시계 이동을 흉내 낸다 */
  setBtime(sec: number | null): this {
    const text = sec === null ? 'cpu  1 2 3 4\nctxt 100\n' : `cpu  1 2 3 4\nintr 5\nctxt 100\nbtime ${sec}\nprocesses 42\n`;
    writeFileSync(join(this.root, 'stat'), text);
    return this;
  }

  add(e: FakeProcEntry): this {
    const dir = join(this.root, String(e.pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stat'), statLine(e), 'latin1');
    if (e.environ) {
      const body = Object.entries(e.environ)
        .map(([k, v]) => `${k}=${v}`)
        .join('\0');
      writeFileSync(join(dir, 'environ'), `${body}\0`);
    } else rmSync(join(dir, 'environ'), { force: true });
    const cgroup = e.cgroup === undefined ? `0::${SELF_CGROUP}\n` : e.cgroup;
    if (cgroup === null) rmSync(join(dir, 'cgroup'), { force: true });
    else writeFileSync(join(dir, 'cgroup'), cgroup);
    const uid = e.uid === undefined ? SELF_UID : e.uid;
    if (uid === null) rmSync(join(dir, 'status'), { force: true });
    else writeFileSync(join(dir, 'status'), statusText(uid));
    return this;
  }

  /** self/cgroup (이 서버의 cgroup, null = 파일 없음) */
  setSelfCgroup(text: string | null): this {
    const dir = join(this.root, 'self');
    mkdirSync(dir, { recursive: true });
    if (text === null) rmSync(join(dir, 'cgroup'), { force: true });
    else writeFileSync(join(dir, 'cgroup'), text);
    return this;
  }

  remove(pid: number): this {
    rmSync(join(this.root, String(pid)), { recursive: true, force: true });
    return this;
  }

  /** self/stat (실제 /proc에서는 자기 PID 폴더로 가는 링크) */
  setSelf(e: FakeProcEntry | null): this {
    const dir = join(this.root, 'self');
    if (e === null) {
      rmSync(dir, { recursive: true, force: true });
      return this;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stat'), statLine(e), 'latin1');
    return this;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** boot_id·btime이 있는 빈 가짜 루트 */
export function createFakeProcRoot(o: { bootId?: string; btime?: number } = {}): FakeProcRoot {
  const fake = new FakeProcRoot(mkdtempSync(join(tmpdir(), 'wook-test-proc-')));
  fake.setBootId(o.bootId ?? FAKE_BOOT_ID).setBtime(o.btime ?? 1_762_900_000).setSelfCgroup(`0::${SELF_CGROUP}\n`);
  writeFileSync(join(fake.root, 'self', 'status'), statusText(SELF_UID));
  return fake;
}
