/**
 * Linux 시험 (리드 결정 S10-13 LP-2, S10-14)의 안쪽 스크립트 — 덧없는 systemd 사용자 scope 안에서 혼자 돈다(시험이 rolldown으로 묶어
 * `systemd-run --user --scope`로 띄운다). 그래서 여기서 만드는 덤프 불가 프로세스는 이 scope(이 '서버'의 cgroup) 안에만 있고, 같은 cgroup을 나누는
 * 다른 시험 파일들(WSL은 /non-systemd)의 정지 결과 글에 이름이 끼지 않는다.
 * 하는 일: 러너를 만들고, 덤프 불가 후손(daemonize.py nodump)을 남기는 실행을 (1) 정지하고 (2) 스스로 끝나게 둔 뒤, (3) 표시를 가진 고아 감싸개와 그
 * 덤프 불가 자식(daemonize.py wrap-nodump — 부모로 이어진 것, S10-16)을 남기는 실행을 정지하고, 결과와 러너의 경고를 JSON 한 줄로 쓴다.
 * 후손은 그만 파일로 스스로 끝나게 하고, 끝날 때까지(최대 5초) 기다린다 — 기록한 PID로 죽이지 않는다
 * 인자: <데이터 폴더> <작업 폴더> <daemonize.py> <그만 파일> <표시를 적을 폴더>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProcessRunner } from '../processRunner';
import { readProcStat } from '../procfs';
import type { ManagedProcess, ProcessRunner } from '../types';

const [, , dataDir, workDir, daemonize, quit, tagDir] = process.argv as [string, string, string, string, string, string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function leaverRun(
  runner: ProcessRunner,
  then: 'stay' | 'exit',
  mode: 'nodump' | 'wrap-nodump' = 'nodump',
): Promise<{ proc: ManagedProcess; leaver: number; child: number; tag: string }> {
  const tagFile = join(tagDir, `tag-${then}-${mode}`);
  const proc = runner.start({
    command: '/bin/sh',
    args: ['-c', `python3 -I "$1" "$2" "$4" "$3"; ${then === 'stay' ? 'exec sleep 30' : 'exit 0'}`, 'sh', daemonize, quit, tagFile, mode],
    cwd: workDir,
    env: { ...process.env },
    stdinText: null,
    label: `scope ${then}`,
  });
  const { leaver, child } = await new Promise<{ leaver: number; child: number }>((resolve) =>
    proc.onStdoutLine((l) => l.startsWith('{"leaver"') && resolve(JSON.parse(l) as { leaver: number; child: number })),
  );
  for (let i = 0; i < 60 && !existsSync(tagFile); i++) await sleep(50);
  await sleep(100);
  return { proc, leaver, child, tag: readFileSync(tagFile, 'utf8') };
}

function environErrorOf(pid: number): string {
  try {
    readFileSync(`/proc/${pid}/environ`);
    return '';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? 'ERR';
  }
}

const warnings: string[] = [];
const runner = await createProcessRunner({ dataDir, log: (level, msg) => void (level === 'warn' && warnings.push(msg)) });
const a = await leaverRun(runner, 'stay');
const environError = environErrorOf(a.leaver);
const stopped = await a.proc.terminate({ timeoutMs: 2800 });
const stayAlive = alive(a.leaver);
const b = await leaverRun(runner, 'exit');
const info = await b.proc.exited;
const exitAlive = alive(b.leaver);
// (3) 부모로 이어진 덤프 불가 자식: 감싸개(표시로 찾음)의 자식이니 이 실행의 것이다 — 끝낸다 (S10-16)
const c = await leaverRun(runner, 'stay', 'wrap-nodump');
for (let i = 0; i < 60 && environErrorOf(c.child) !== 'EACCES'; i++) await sleep(50);
const wrapChildEnvironError = environErrorOf(c.child);
const wrapChildParent = readProcStat(c.child, '/proc')?.ppid ?? 0;
const wrapStopped = await c.proc.terminate({ timeoutMs: 2800 });
for (let i = 0; i < 20 && (alive(c.child) || alive(c.leaver)); i++) await sleep(50);
const wrapChildAlive = alive(c.child);
const wrapWrapperAlive = alive(c.leaver);
writeFileSync(quit, '');
for (let i = 0; i < 100 && (alive(a.leaver) || alive(b.leaver)); i++) await sleep(50);
process.stdout.write(
  `${JSON.stringify({
    cgroup: readFileSync('/proc/self/cgroup', 'utf8').trim(),
    stay: { result: stopped, leaver: a.leaver, aliveAfter: stayAlive, tagMatches: a.tag === a.proc.runTag, environError },
    exit: { info, leaver: b.leaver, aliveAfter: exitAlive, tagMatches: b.tag === b.proc.runTag },
    wrap: {
      result: wrapStopped,
      wrapper: c.leaver,
      child: c.child,
      childParent: wrapChildParent,
      childEnvironError: wrapChildEnvironError,
      tagMatches: c.tag === c.proc.runTag,
      childAliveAfter: wrapChildAlive,
      wrapperAliveAfter: wrapWrapperAlive,
    },
    leftAlive: alive(a.leaver) || alive(b.leaver),
    warnings,
  })}\n`,
);
runner.dispose?.();
process.exit(0);
