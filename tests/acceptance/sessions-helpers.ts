/**
 * 세션 그룹 인수 테스트(AC-34·35·36·37·40·41) 도우미.
 * - orchHarness(가짜 CLI)에: 자동 스케줄 다시 켜기, 개발자 추가, 세션 키별 턴 대본, 시스템 지침 기록, 실행 자리 감시
 * - e2e 하네스(실제 모의 에이전트 프로세스)에: 감싸기 실행기 — 턴을 붙잡아 두거나 손자 프로세스(개발 서버 흉내)를 띄운다
 * 제품 코드·기존 하네스는 고치지 않는다. 인스턴스 메서드(launch·prepare)만 감싼다.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskType, Turn } from '@shared/domain';
import type { RunningSlot, StartCandidate } from '@core/scheduling';
import type { PreparedRun, TurnLaunch } from '../../src/main/agents/types';
import type { Core } from '../../src/main/orchestrator/core';
import { bootOrch, sleep, waitFor, type FakeProc, type OrchEnv, type OrchOptions } from '../regression/orchHarness';
import type { Harness } from '../e2e/harness';

export { sleep, waitFor };

// ───────────────────────── 실행 자리 감시 (launch 때마다 검사) ─────────────────────────

export interface LaunchSample {
  sessionKey: string;
  memberId: string;
  slotClass: 'general' | 'management';
  total: number;
  general: number;
  management: number;
  /** 이 턴을 띄운 직후 실행 중인 세션 키 전체 */
  keys: string[];
}

export interface SlotMonitor {
  samples: LaunchSample[];
  violations: string[];
  maxTotal: number;
  maxGeneral: number;
  restore(): void;
}

/**
 * 스케줄러가 턴을 띄울 때마다(launch 직후, 자리가 동기적으로 예약된 뒤) 실행 중 목록을 검사한다:
 * 전체 ≤ cap, 일반 ≤ cap-1(cap≥2), 팀원·세션 키 중복 없음. 표본 추출이 아니라 매번 검사하므로 놓치는 순간이 없다.
 */
export function monitorLaunches(core: Core, cap = 5): SlotMonitor {
  const turns = core.turns as unknown as { launch: (c: StartCandidate, ids: string[]) => void };
  const original = turns.launch;
  const generalCap = cap >= 2 ? cap - 1 : cap;
  const m: SlotMonitor = {
    samples: [],
    violations: [],
    maxTotal: 0,
    maxGeneral: 0,
    restore: () => {
      turns.launch = original;
    },
  };
  turns.launch = function (this: unknown, c: StartCandidate, ids: string[]) {
    original.call(core.turns, c, ids);
    const run: RunningSlot[] = core.turns.running();
    const general = run.filter((r) => r.slotClass === 'general').length;
    const s: LaunchSample = { sessionKey: c.sessionKey, memberId: c.memberId, slotClass: c.slotClass, total: run.length, general, management: run.length - general, keys: run.map((r) => r.sessionKey) };
    m.samples.push(s);
    m.maxTotal = Math.max(m.maxTotal, s.total);
    m.maxGeneral = Math.max(m.maxGeneral, general);
    if (run.length > cap) m.violations.push(`전체 ${run.length} > ${cap} (${c.sessionKey})`);
    if (general > generalCap) m.violations.push(`일반 ${general} > ${generalCap} (${c.sessionKey})`);
    const members = run.map((r) => r.memberId);
    if (new Set(members).size !== members.length) m.violations.push(`같은 팀원 동시 실행: ${members.join(',')} (${c.sessionKey})`);
    const keys = run.map((r) => r.sessionKey);
    if (new Set(keys).size !== keys.length) m.violations.push(`같은 세션 동시 실행: ${keys.join(',')}`);
  };
  return m;
}

// ───────────────────────── orchHarness 확장 ─────────────────────────

export interface SessEnv extends OrchEnv {
  /** 턴 ID → 그 턴에 넣은 시스템 지침 */
  prompts: Map<string, string>;
  /** 개발자 팀원 ID (bootOrch의 devId + 추가분) */
  devs: string[];
  /** 대본 실행 중 난 오류 */
  scriptErrors: string[];
  monitor: SlotMonitor;
}

export async function bootSessions(o: OrchOptions & { autoSchedule?: boolean; developers?: number } = {}): Promise<SessEnv> {
  const env = (await bootOrch(o)) as SessEnv;
  env.prompts = new Map();
  env.scriptErrors = [];
  env.prepareHook = (launch, who) => {
    env.prompts.set(who.turnId, launch.systemPrompt);
  };
  env.devs = [env.devId];
  for (let i = 1; i < (o.developers ?? 1); i++) {
    const m = await env.internal('members.add', { projectId: env.projectId, roleId: 'developer' });
    env.devs.push(m.id);
  }
  env.monitor = monitorLaunches(env.core, env.ctx.settings().execution.maxConcurrent);
  // bootOrch가 끈 자동 실행(tick 신호·2초 주기)을 다시 켠다 — '자동으로 시작'을 테스트가 tick을 부르지 않고 확인하기 위해
  if (o.autoSchedule) env.core.scheduler.start();
  return env;
}

export type TurnScript = (p: FakeProc, n: number) => void | Promise<void>;

/** 세션 키의 n번째 턴(0부터)마다 대본을 돈다. 대본이 모자라면 마지막 대본을 되풀이. 대본 오류는 기록하고 턴을 끝낸다 */
export function scriptTurns(env: SessEnv, key: string, scripts: TurnScript[]): { count: () => number } {
  let n = 0;
  env.script.set(key, (p) => {
    const i = n++;
    const run = scripts[Math.min(i, scripts.length - 1)]!;
    Promise.resolve()
      .then(() => run(p, i))
      .catch((e: unknown) => {
        env.scriptErrors.push(`${key}#${i}: ${e instanceof Error ? e.message : String(e)}`);
        p.finishOk('대본 오류');
      });
  });
  return { count: () => n };
}

/** 앱 도구를 부르고 성공을 확인한다 */
export async function toolOk(env: OrchEnv, turnId: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await env.tool(turnId, name, args);
  if (!r.ok) throw new Error(`${name} 거부 (${r.code}): ${r.message}`);
  return r.data as Record<string, unknown>;
}

export function makeTask(env: OrchEnv, o: { directiveId: string; assignee: string; title?: string; type?: TaskType; outputMode?: 'repo' | 'artifact'; reviewerId?: string | null; priority?: Task['priority'] }): Task {
  return env.core.tasks.create(
    {
      directiveId: o.directiveId,
      title: o.title ?? '인수 작업',
      goal: `${o.title ?? '인수 작업'}의 목표`,
      type: o.type ?? 'development',
      assigneeId: o.assignee,
      reviewerId: o.reviewerId ?? null,
      priority: o.priority,
      acceptanceCriteria: ['동작한다'],
      outputMode: o.outputMode ?? 'repo',
    },
    env.producerId,
  );
}

/** 세션 키(task:T-0001 등)의 턴들 (시작 순) */
export function turnsOfKey(env: OrchEnv, key: string): Turn[] {
  return env.ctx.store.turns.list().filter((t) => env.ctx.store.sessions.get(t.sessionId)?.workKey === key);
}

export function launchesOfKey(env: OrchEnv, key: string) {
  return env.launches.filter((l) => l.workKey === key);
}

export function liveCount(env: OrchEnv, key: string): number {
  return env.procs.filter((p) => p.workKey === key && !p.done).length;
}

export function slots(env: OrchEnv): { total: number; general: number; management: number; keys: string[] } {
  const run = env.core.turns.running();
  const general = run.filter((r) => r.slotClass === 'general').length;
  return { total: run.length, general, management: run.length - general, keys: run.map((r) => r.sessionKey).sort() };
}

/** tick을 n번, 사이사이 잠깐 쉰다 (턴이 뜰 기회를 충분히 준다) */
export async function ticks(env: OrchEnv, n = 5, ms = 30): Promise<void> {
  for (let i = 0; i < n; i++) {
    env.tick();
    await sleep(ms);
  }
}

export function stepsDone(env: OrchEnv, taskId: string): number {
  return env.ctx.store.steps.list(taskId).filter((s) => s.done).length;
}

// ───────────────────────── e2e: 감싸기 실행기 ─────────────────────────

const WRAPPER = `// 인수 테스트용 감싸기: [손자 프로세스] → 모의 에이전트(표준 입출력 그대로) → [해제 파일을 기다림] → 같은 코드로 종료
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, seq, mode, gcFlag, ...rest] = process.argv.slice(2);
const mark = (name, v) => writeFileSync(join(dir, seq + '.' + name), String(v));
if (gcFlag === 'gc') {
  // 개발 서버처럼 CLI가 끝나도 남는 손자 (Windows는 detached여야 node 자체 job에 들지 않는다). 감싸기 폴더에 quit 파일이 생기거나 그 폴더가 지워지면
  // 스스로 끝난다 — 시험의 정리는 손자의 PID로 죽이지 않는다 (S7-20 TI-8). 안전장치: 120초 뒤 스스로 끝남
  const gc = spawn(process.execPath, ['-e', "const f=require('fs');const d=process.argv[1];setInterval(()=>{if(f.existsSync(d+'/quit')||!f.existsSync(d))process.exit(0)},100);setTimeout(()=>process.exit(0),120000)", dir], { detached: process.platform === 'win32', stdio: 'ignore', windowsHide: true });
  gc.unref();
  mark('gc', gc.pid);
}
const child = spawn(process.execPath, rest, { stdio: 'inherit', windowsHide: true });
child.on('exit', (code) => {
  mark('exit', code === null ? 'null' : code);
  const done = () => process.exit(code === null ? 1 : code);
  if (mode !== 'hold') return done();
  const t = setInterval(() => {
    if (existsSync(join(dir, seq + '.release'))) {
      clearInterval(t);
      done();
    }
  }, 20);
});
`;

export interface WrapRecord {
  seq: number;
  workKey: string;
  memberId: string;
  resume: string | null;
  newSessionId: string | null;
  message: string;
  systemPrompt: string;
  hold: boolean;
  grandchild: boolean;
  /** 이 턴을 준비할 때(프로세스를 띄우기 직전) 살아 있던 이전 턴 손자 PID */
  aliveGrandchildrenAtPrepare: number[];
}

export interface WrapControl {
  dir: string;
  records: WrapRecord[];
  release(seq: number): void;
  releaseAll(): void;
  grandchildPid(seq: number): number | null;
  exited(seq: number): boolean;
  restore(): void;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 실제 모의 에이전트 실행을 감싼다. hold → 모의 에이전트가 끝난 뒤에도 release(seq) 전까지 턴(프로세스)이 살아 있다.
 * grandchild → 턴마다 CLI가 끝나도 남는 손자를 띄운다 (러너가 정리해야 턴이 끝난다). before → prepare 직전에 부른다.
 */
export function wrapMockRuns(
  h: Harness,
  o: { hold?: (l: TurnLaunch) => boolean; grandchild?: (l: TurnLaunch) => boolean; before?: (l: TurnLaunch) => void } = {},
): WrapControl {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-acc-wrap-'));
  const script = join(dir, 'wrapper.mjs');
  writeFileSync(script, WRAPPER, 'utf8');
  const adapter = h.core.ctx.deps.adapters.mock;
  const original = adapter.prepare.bind(adapter);
  const records: WrapRecord[] = [];
  let seq = 0;
  const gcPid = (n: number): number | null => {
    try {
      return Number(readFileSync(join(dir, `${n}.gc`), 'utf8'));
    } catch {
      return null;
    }
  };
  adapter.prepare = async (launch: TurnLaunch): Promise<PreparedRun> => {
    o.before?.(launch);
    const n = ++seq;
    const prepared = await original(launch);
    const hold = !!o.hold?.(launch);
    const grandchild = !!o.grandchild?.(launch);
    const alive = records
      .filter((r) => r.grandchild)
      .map((r) => gcPid(r.seq))
      .filter((p): p is number => p !== null && isAlive(p));
    records.push({
      seq: n,
      workKey: launch.mock?.workKey ?? '',
      memberId: launch.mock?.memberId ?? '',
      resume: launch.resumeCliSessionId,
      newSessionId: launch.newSessionId,
      message: launch.message,
      systemPrompt: launch.systemPrompt,
      hold,
      grandchild,
      aliveGrandchildrenAtPrepare: alive,
    });
    return { ...prepared, spec: { ...prepared.spec, args: [script, dir, String(n), hold ? 'hold' : 'go', grandchild ? 'gc' : 'nogc', ...prepared.spec.args] } };
  };
  const ctl: WrapControl = {
    dir,
    records,
    release: (n) => writeFileSync(join(dir, `${n}.release`), '1'),
    releaseAll: () => {
      for (const r of records) writeFileSync(join(dir, `${r.seq}.release`), '1');
    },
    grandchildPid: gcPid,
    exited: (n) => readdirSync(dir).includes(`${n}.exit`),
    restore: () => {
      adapter.prepare = original;
      ctl.releaseAll();
      // 남은 손자는 quit 파일(그리고 아래에서 폴더를 지우면)로 스스로 끝난다 — 기록한 PID로 죽이지 않는다: 러너가 이미 끝낸 손자의 번호는 다른 프로세스가
      // 다시 쓸 수 있다 (S7-20 TI-8)
      try {
        writeFileSync(join(dir, 'quit'), '1');
      } catch {
        // 폴더가 없다 — 손자는 이미 스스로 끝났다
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 다음 정리에 맡긴다
      }
    },
  };
  return ctl;
}

/** 모의 에이전트 상태 폴더에서 그 CLI 세션 기록을 지운다 → 다음 이어하기가 실제 CLI처럼 '세션 없음'으로 실패한다 */
export function forgetMockSession(stateDir: string, cliSessionId: string): number {
  const dir = join(stateDir, 'sessions');
  let n = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of names) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id?: string };
      if (rec.id === cliSessionId) {
        rmSync(join(dir, f), { force: true });
        n++;
      }
    } catch {
      // 다른 파일
    }
  }
  return n;
}

/** 시각 구간이 겹치지 않는지 (같은 팀원·같은 세션의 턴) — 겹치는 쌍을 돌려준다 */
export function overlaps(turns: Turn[]): string[] {
  const sorted = [...turns].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const out: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (!prev.endedAt || cur.startedAt < prev.endedAt) out.push(`${prev.id}(${prev.startedAt}~${prev.endedAt}) ↔ ${cur.id}(${cur.startedAt})`);
  }
  return out;
}
