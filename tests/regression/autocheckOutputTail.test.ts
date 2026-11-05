/**
 * 자동 검사 출력의 끝 (리드 결정 S5-52·S5-54): 자동 검사는 host_exec와 같은 출력 모으기(HostExecOutput — 개인 키 창, 긴 줄의 값싼 개인 키 검사 뒤 버리기,
 * 앞 16KiB + 뒤 48KiB를 줄 단위로)로 표준 출력·오류를 모으고, 백엔드 가리개로 가린 그 글의 끝 4,000자를 검사 결과로 쓴다. 가리기는 끝날 때 남긴 글에 한 번
 * 하고 그 뒤에 자른다. 그래서 줄바꿈 없이 수백 MB를 찍은 검사를 긴급 정지해도 정지 요약이 3초 안에 오고(AC-15·29, 프로브 zz-xs5f3-autochecknonl), 긴 줄
 * 끝에 찍힌 개인 키 시작 표시 뒤의 본문도 실행 기록·작업 기록·활동 기록·알림에 남지 않는다(프로브 zz-xs5f4-autocheckpem). 시작 표시 뒤에 한 줄로 이어 쓴 키
 * 본문이 끝 표시 전에 잘리고 뒤에 다른 글이 붙어도(로거가 자른 값 등) 그 줄은 시작 표시와 함께 남아 마지막 가리기가 가리고, 자동 검사의 결과는 날 출력을
 * 백엔드 가리개로만 가린 것보다 덜 가리지 않는다(리드 결정 S5-61, 프로브 zz-xs5f5-inlinebegin). 창 안에서 남기는 글은 base64 16자 넘는 이어짐을 가리므로
 * 진짜 줄바꿈으로 찍은 키가 끝 표시 전에 잘려도(로거가 자른 필드·미리 보기·'…') 잘린 줄의 본문이 남지 않는다(리드 결정 S5-71, 프로브 zz-xs5f6es-realcut).
 * 창 안에서 남기는 글은 백엔드 가리개로 먼저 가린 뒤 조각을 가리므로, 16자 넘는 이름·URL 사용자 옆의 값도 검사 결과·실행 기록·작업 기록·활동 기록에 남지
 * 않는다(리드 결정 S5-78, 프로브 zz-xs5f7es-ctxloss).
 * 홍수 자식은 정해진 만큼 쓰고 기다리다 정지가 끝낸다. 남으면 afterEach가 러너가 가진 프로세스로 끝낸다(PID 파일로 끝내지 않는다 — S5-52.4). 자식은 넉넉한
 * 벽시계 상한 뒤에 스스로도 끝난다.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { createRedactor } from '@core/redact';
import { CheckOutputTail } from '../../src/main/orchestrator/autocheck';
import { HostExecOutput } from '../../src/main/orchestrator/hostExec';
import { taskKey } from '../../src/main/orchestrator/records';
import type { ManagedProcess, ProcessRunner } from '../../src/main/process/types';
import type { Env } from './helpers';
import { activate, boot, newTask, waitFor } from './helpers';
import { bootOrch, FakeProc, seedDirective, type OrchEnv } from './orchHarness';
import {
  crossCase,
  FUZZ_LAYOUTS,
  fuzzCase,
  INLINE_CUT_SHAPES,
  inlineCutCase,
  inlineCutEnd,
  inlineCutLine,
  leakedPieces,
  longRun,
  OUTSIDE_LAYOUTS,
  REAL_CUT_SHAPES,
  realCutCase,
  realCutEnds,
  secretCase,
  seeded,
  shownPieces,
} from './pemFuzzCases';

let env: Env | null = null;
/** 제출 흐름 시험의 하네스 (orchHarness — 리드 결정 S5-83) */
let orchEnv: OrchEnv | null = null;
let dir: string | null = null;
const started: ManagedProcess[] = [];
afterEach(async () => {
  // 아직 끝나지 않은 자식만 러너가 가진 핸들로 끝낸다 (끝난 PID를 다시 쓰지 않는다 — S5-52.4)
  await Promise.all(started.splice(0).map((p) => p.terminate({ timeoutMs: 3000 }).catch(() => undefined)));
  await env?.close();
  env = null;
  await orchEnv?.close();
  orchEnv = null;
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  dir = null;
});

const collect = (lines: string[], redact: (s: string) => string = (s) => s): string => {
  const t = new CheckOutputTail(redact);
  for (const l of lines) t.push(l);
  return t.text();
};
const omittedMark = (n: number): string => `…(${n}바이트 생략)…`;

describe('자동 검사 출력의 끝은 host_exec와 같은 출력 모으기로 모은다 (리드 결정 S5-52·S5-54)', () => {
  it('끝 4,000자 — 짧은 출력은 그대로, 긴 출력은 마지막 줄까지', () => {
    expect(collect(['a', 'b', 'c'])).toBe('a\nb\nc');
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'.'.repeat(40)}`);
    const out = collect(lines);
    expect(out).toHaveLength(4000);
    expect(lines.join('\n').endsWith(out)).toBe(true);
  });

  // 리드 결정 S5-54가 S5-52의 '4KiB보다 긴 줄은 버려 센다'를 host_exec의 규칙(뒤 상한 48KiB보다 긴 줄을 버려 바이트로 센다)으로 바꿨다
  it('뒤 상한(48KiB)보다 긴 줄은 버려 바이트로 세고 생략 표시는 한 자리 — 그보다 짧은 줄(4KiB 넘는 줄도)은 남긴다 (리드 결정 S5-54)', () => {
    const long = 'z'.repeat(48 * 1024 + 1);
    // 버린 긴 줄들과 그 사이의 뒤 줄('가운데')을 함께 센다 — 생략 표시가 거짓이 되지 않게 (host_exec와 같다)
    const dropped = 4 * (long.length + 1) + Buffer.byteLength('가운데') + 1;
    expect(collect(['앞', long, long, long, '가운데', long, '뒤'])).toBe(['앞', omittedMark(dropped), '뒤'].join('\n'));
    // 16KiB(앞 상한)보다 길고 48KiB보다 짧은 줄과 4KiB 넘는 줄은 남는다 (끝 4,000자만 보인다)
    const edge = 'e'.repeat(40 * 1024);
    expect(collect(['앞', long, edge, '뒤'])).toBe(`${edge}\n뒤`.slice(-4000));
    const mid = 'm'.repeat(4 * 1024 + 1);
    expect(collect(['앞', mid, '뒤'])).toBe(`앞\n${mid}\n뒤`.slice(-4000));
    // 한글 줄은 바이트로 잰다 — 1,400자(4,200바이트)는 남고, 16,400자(49,200바이트)는 길다
    expect(collect(['앞', '가'.repeat(1400), '뒤'])).toBe(`앞\n${'가'.repeat(1400)}\n뒤`.slice(-4000));
    expect(collect(['앞', '가'.repeat(16_400), '뒤'])).toBe(['앞', omittedMark(16_400 * 3 + 1), '뒤'].join('\n'));
  });

  // 리드 결정 S5-59.4가 이 시험을 다시 쓰게 했다 — 예전 꼴은 잘린 첫 줄을 건너뛰고 비밀 값의 앞 20자만 봐서 '자른 뒤 가리기'를 잡지 못했다 (프로브 zz-s5f4ti-tail-kills 1)
  it('가리기는 끝날 때 남긴 글에 한 번, 그 뒤에 끝 4,000자를 자른다 — 자르는 자리가 비밀 값 안이어도 어느 줄(잘린 첫 줄 포함)에도 그 조각(8자 넘게)이 없다', () => {
    const secret = `fake-check-${randomBytes(12).toString('hex')}`;
    const line = (i: number): string => `row ${String(i).padStart(4, '0')} ${'r'.repeat(40)} ${secret}`;
    // 원문의 끝 4,000자 자리가 비밀 값 하나의 가운데에 오도록 채움 길이를 고른다
    let lines: string[] = [];
    for (let pad = 0; pad < 200 && !lines.length; pad++) {
      const ls = [...Array.from({ length: 200 }, (_, i) => line(i)), 'x'.repeat(pad)];
      const raw = ls.join('\n');
      const cut = raw.length - 4000;
      const at = raw.lastIndexOf(secret, cut);
      if (at !== -1 && cut > at + 4 && cut < at + secret.length - 8) lines = ls;
    }
    expect(lines.length).toBeGreaterThan(0);
    const r = createRedactor();
    r.addSecret(secret, 'api-key');
    const seen: number[] = [];
    const t = new CheckOutputTail((s) => {
      seen.push(s.length);
      return r.text(s);
    });
    for (const l of lines) t.push(l);
    const out = t.text();
    // 가리개는 남긴 글(64KiB 안) 전체에 한 번 — 자른 뒤가 아니다
    expect(seen).toHaveLength(1);
    expect(seen[0]!).toBeGreaterThan(4000);
    expect(seen[0]!).toBeLessThanOrEqual(64 * 1024 + 64);
    const pieces: string[] = [];
    for (let i = 0; i + 8 <= secret.length; i++) if (out.includes(secret.slice(i, i + 8))) pieces.push(secret.slice(i, i + 8));
    expect(pieces).toEqual([]);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.endsWith('x'.repeat(lines.at(-1)!.length))).toBe(true);
    expect(out).toContain('[가림:api-key]');
  });

  // 리드 결정 S5-54: 긴 줄의 값싼 개인 키 검사가 버리기 앞에 붙어(S5-43) 긴 줄마다 그 줄을 한 번 훑는다 — 상한은 줄마다 둔다(hostExecRedact의 32MiB 한 줄과 같다)
  it('32MiB 한 줄의 push는 줄마다 바로 돌아오고(넉넉히 250ms 안) text도 그렇다 — 그 줄을 베끼거나 가리지 않는다', () => {
    const r = createRedactor();
    const line = Buffer.alloc(24 * 1024 * 1024, 7).toString('base64').slice(0, 32 * 1024 * 1024);
    const t = new CheckOutputTail((s) => r.text(s));
    t.push('앞');
    const each: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      t.push(line);
      each.push(Math.round(performance.now() - t0));
    }
    t.push('끝');
    const t1 = performance.now();
    const out = t.text();
    const took = performance.now() - t1;
    expect(Math.max(...each), JSON.stringify(each)).toBeLessThan(250);
    expect(took, `${Math.round(took)}ms`).toBeLessThan(250);
    expect(out).toBe(['앞', omittedMark(15 * (line.length + 1)), '끝'].join('\n'));
  });
});

/** 가짜 키 본문 26줄 (프로브 zz-xs5f4-autocheckpem의 모양 — 만든 값) */
const PEM_BODY = Array.from({ length: 26 }, (_, i) => `MIIEowAC${String(i).padStart(2, '0')}${'Kp4Wq8Zr'.repeat(8)}`.slice(0, 64));
const PEM_BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const PEM_END = '-----END RSA PRIVATE KEY-----';
/** '\r'로만 갱신하는 진행 막대 한 줄 */
const bar = (n: number): string => {
  let s = '';
  for (let p = 0; s.length < n; p++) s += `\r[${'#'.repeat(p % 30).padEnd(30, ' ')}] ${p % 100}% `;
  return s.slice(0, n);
};
const bodyShown = (s: string): number => PEM_BODY.filter((b) => s.includes(b)).length;
/** 긴 줄 끝에 시작 표시가 찍힌 검사 출력 (프로브 zz-xs5f4-autocheckpem) — 4KiB 줄은 예전 끝 모으기의 경계(대조) */
const LONG_BEGIN_LAYOUTS: Record<string, string[]> = {
  '진행 막대 4KiB(꼭) 끝에 시작 표시': [`${bar(4096 - PEM_BEGIN.length)}${PEM_BEGIN}`, ...PEM_BODY, PEM_END, 'Tests: 1 failed'],
  '진행 막대 5KiB 끝에 시작 표시': [`${bar(5 * 1024)}${PEM_BEGIN}`, ...PEM_BODY, PEM_END, 'Tests: 1 failed'],
  '진행 막대 60KiB 끝에 시작 표시': [`${bar(60 * 1024)}${PEM_BEGIN}`, ...PEM_BODY, PEM_END, 'Tests: 1 failed'],
  '압축 JSON 20KB 끝에 시작 표시 — 끝 표시 전에 출력이 끊김': [`{"a":"${'x'.repeat(20_000)}"}${PEM_BEGIN}`, ...PEM_BODY.slice(0, 20)],
  '앞말 6KB의 로그 줄 끝에 시작 표시': [`[test] fixture loaded ${'k=v '.repeat(1500)}${PEM_BEGIN}`, ...PEM_BODY, PEM_END, 'done'],
};

describe('자동 검사의 출력도 host_exec의 출력 모으기로 — 긴 줄 끝의 개인 키 시작 표시 (리드 결정 S5-54)', () => {
  it('긴 줄 끝에 시작 표시가 찍혀도 본문 줄이 검사 결과에 남지 않는다 — 진행 막대 5KiB·60KiB, 압축 JSON(끊김), 6KB 앞말, 4KiB 대조 (프로브 zz-xs5f4-autocheckpem)', () => {
    const r = createRedactor();
    const shown: Record<string, number> = {};
    for (const [name, lines] of Object.entries(LONG_BEGIN_LAYOUTS)) {
      const out = collect(lines, (s) => r.text(s));
      shown[name] = bodyShown(out);
      // 가리개 없이도 — 창이 가린다
      expect(bodyShown(collect(lines)), name).toBe(0);
    }
    expect(shown).toEqual(Object.fromEntries(Object.keys(LONG_BEGIN_LAYOUTS).map((k) => [k, 0])));
    // 뒤 상한보다 긴 줄(60KiB)은 생략으로 세고 창이 키를 한 줄로 가린다
    const sixty = LONG_BEGIN_LAYOUTS['진행 막대 60KiB 끝에 시작 표시']!;
    expect(collect(sixty).split('\n')).toEqual([omittedMark(sixty[0]!.length + 1), '[가림:개인 키 — 28줄]', 'Tests: 1 failed']);
  });

  it('CheckOutputTail은 줄을 넘기고 글을 받기만 한다 — 같은 줄이면 결과가 HostExecOutput의 가린 글 끝 4,000자와 같다 (퍼즈 300건)', () => {
    const r = createRedactor();
    const rand = seeded(0x5f54);
    for (let c = 0; c < 300; c++) {
      const { lines } = c % 4 === 3 ? inlineCutCase(rand) : c % 4 === 2 ? crossCase(rand) : fuzzCase(rand);
      const tail = new CheckOutputTail((s) => r.text(s));
      const host = new HostExecOutput((s) => r.text(s));
      for (const l of lines) {
        tail.push(l);
        host.push(l);
      }
      expect(tail.text(), `경우 ${c}`).toBe(host.text().slice(-4000));
    }
  });

  // 리드 결정 S5-61이 한 줄에서 끝 표시 전에 잘린 키(경우 넷에 하나)와 차등 불변식(날 출력을 백엔드 가리개로만 가린 것보다 덜 가리지 않는다)을 더했다.
  // 리드 결정 S5-71이 진짜 줄바꿈으로 잘린 키 50건과 줄 끝 너그러움 밖의 꼴 50건(차례 키·엇갈린 키)을 뒤에 더하고, 검사 결과·실행 기록에 base64 16자 넘는
  // 이어짐이 없다는 불변식 ①을 더했다(앞의 300건은 그대로)
  it('자동 검사 실행(AutoChecker.run)을 거친 퍼즈 400건: 검사 결과와 실행 기록의 출력에 본문 줄의 16자 조각과 base64 16자 넘는 이어짐이 없고, 그 출력은 같은 줄을 넣은 HostExecOutput의 끝 4,000자다 — 가리개로만 가린 것보다 덜 가리지 않는다 (리드 결정 S5-61·S5-71)', async () => {
    const e = (env = await boot());
    const t = newTask(e);
    await activate(e, t.id);
    const task = e.ctx.store.tasks.require(t.id);
    const project = e.ctx.store.projects.require(task.projectId);
    const cwd = task.workspace!.worktreePath;
    let lines: string[] = [];
    // 가짜 러너: 띄우면 이 경우의 줄을 표준 출력·오류로(차례대로 번갈아) 내고 종료 코드 1로 끝난다
    e.ctx.deps.runner = {
      ...e.ctx.deps.runner,
      start: (spec) => {
        const p = new FakeProc('check', '', spec.label);
        const mine = lines;
        setImmediate(() => {
          mine.forEach((l, i) => (i % 5 === 4 ? p.errLine(l) : p.line(l)));
          p.exit(1);
        });
        return p;
      },
    } as ProcessRunner;
    // 백엔드 가리개로 가리는지도 본다 — 경우마다 끝에 등록 값 한 줄 (만든 가짜 값). 값의 base64 이어짐을 16자 밑(16진 12자)으로 둔다 — S5-71 때는 창 안에 들면
    // 창이 16자 넘는 이어짐을 먼저 가려 가리개가 돌았는지 이 줄로 볼 수 없었다. 리드 결정 S5-78부터는 가리개가 먼저지만, 이 줄은 이어짐이 없어 마지막 가리기를
    // 보는 줄로 그대로 둔다
    const secret = `fake-check-secret-${randomBytes(6).toString('hex')}`;
    e.ctx.redact.addSecret(secret, 'api-key');
    const rand = seeded(0x5f541);
    const failures: string[] = [];
    /** 차등 불변식 (리드 결정 S5-61): 남은 본문 조각은 날 출력을 백엔드 가리개로만 가린 글에도 남아 있어야 한다 */
    const lessThanPlain: string[] = [];
    /** 불변식 ① (리드 결정 S5-71): 검사 결과·실행 기록에 base64 16자 넘는 이어짐이 없다 — 만들개들은 창 밖에 그런 글을 쓰지 않는다 */
    const longRuns: string[] = [];
    let cases = 0;
    let inline = 0;
    let realCut = 0;
    let outside = 0;
    const crossOutPool = [...FUZZ_LAYOUTS, ...OUTSIDE_LAYOUTS];
    for (let c = 0; c < 400; c++) {
      // 앞의 300건은 예전 그대로, 뒤의 100건은 진짜 줄바꿈으로 잘린 키 50건·너그러움 밖의 꼴 50건 (리드 결정 S5-71)
      const k =
        c >= 300
          ? c % 2 === 0
            ? { ...realCutCase(rand), windowInline: [] }
            : c % 4 === 1
              ? { ...fuzzCase(rand, OUTSIDE_LAYOUTS), windowInline: [] }
              : crossCase(rand, crossOutPool)
          : c % 4 === 3
            ? { ...inlineCutCase(rand), windowInline: [] }
            : c % 4 === 2
              ? crossCase(rand)
              : { ...fuzzCase(rand), windowInline: [] };
      if (c < 300 && c % 4 === 3) inline++;
      if (c >= 300) {
        if (c % 2 === 0) realCut++;
        else outside++;
      }
      // 줄 끝이 본문으로 보이지 않게(' 끝') — 창 안에 들어가도 남는 보통 줄이다
      k.lines.push(`operator value ${secret} 끝`);
      lines = k.lines;
      const res = await e.core.checks.run(task, { ...project, checkCommands: [`node check-${c}.js`] }, cwd);
      const rec = e.ctx.store.execs.list({ ref1: task.id, ref2: 'auto_check' }).at(-1)!;
      const want = new HostExecOutput((s) => e.ctx.redact.text(s));
      for (const l of k.lines) want.push(l);
      const expected = want.text().slice(-4000);
      expect(res.status, `경우 ${c}`).toBe('failed');
      expect(res.detail, `경우 ${c}`).toBe(`'node check-${c}.js' 실패 (종료 코드 1)\n${expected}`);
      expect(rec.result.output, `경우 ${c}`).toBe(expected);
      // 가리개가 돌았다 (앞의 'operator'는 남긴 시작 표시 뒤의 base64 같은 글로 함께 가려질 수 있다 — 더 가리기만 한다)
      expect(res.detail, `경우 ${c}`).toContain('[가림:api-key] 끝');
      expect(res.detail.includes(secret), `경우 ${c}`).toBe(false);
      const run = longRun(`${res.detail}\n${String(rec.result.output)}`);
      if (run && longRuns.length < 5) longRuns.push(`경우 ${c}: ${run.slice(0, 40)}`);
      const leaked = leakedPieces(`${res.detail}\n${String(rec.result.output)}`, [...k.bodies, ...k.windowInline]);
      if (leaked.length && failures.length < 5) failures.push(`경우 ${c}: ${leaked.length}조각`);
      if (leaked.length) {
        const plain = e.ctx.redact.text(k.lines.join('\n'));
        const worse = leaked.filter((p) => !plain.includes(p));
        if (worse.length && lessThanPlain.length < 5) lessThanPlain.push(`경우 ${c}: 가리개만으로는 가려지는 조각 ${worse.length}개가 남음`);
      }
      cases++;
    }
    // 불변식을 함께 본다 — 하나가 깨져도 다른 쪽 결과가 함께 보인다
    expect({ longRuns, failures, lessThanPlain }).toEqual({ longRuns: [], failures: [], lessThanPlain: [] });
    expect({ cases, inline, realCut, outside }).toEqual({ cases: 400, inline: 75, realCut: 50, outside: 50 });
  }, 120_000);

  it('끝까지: 실제 러너로 돈 실패하는 검사가 긴 줄 끝에 개인 키를 찍어도 실행 기록·작업 기록·활동 기록·알림에 본문 줄이 없다 (프로브 zz-xs5f4-autocheckpem)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wook-test-acpem-'));
    // 꼴 이름을 받아 그 출력을 찍는 검사 — 마지막 꼴만 실패(종료 코드 1)
    const layouts = Object.entries(LONG_BEGIN_LAYOUTS).filter(([name]) => !name.includes('4KiB(꼭)'));
    writeFileSync(join(dir, 'layouts.json'), JSON.stringify(layouts.map(([, lines]) => lines)));
    writeFileSync(
      join(dir, 'check.cjs'),
      [
        "const fs = require('node:fs');",
        "const [file, index, code] = process.argv.slice(2);",
        "for (const l of JSON.parse(fs.readFileSync(file, 'utf8'))[Number(index)]) process.stdout.write(l + '\\n');",
        'process.exitCode = Number(code);',
      ].join('\n'),
    );
    const cmd = (index: number, code: number): string => `"${process.execPath}" "${join(dir!, 'check.cjs')}" "${join(dir!, 'layouts.json')}" ${index} ${code}`;
    env = await boot({ runner: true, checkCommands: layouts.map((_, i) => cmd(i, i === layouts.length - 1 ? 1 : 0)) });
    const e = env;
    const runner = e.ctx.deps.runner;
    const origStart = runner.start.bind(runner);
    runner.start = (spec) => {
      const p = origStart(spec);
      started.push(p);
      return p;
    };
    const id = await readyToSubmit(e);
    await e.core.tasks.processSubmission(id);
    const recs = e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' });
    expect(recs).toHaveLength(layouts.length);
    const task = e.ctx.store.tasks.require(id);
    const res = {
      records: recs.map((r) => bodyShown(JSON.stringify(r))),
      task: bodyShown(JSON.stringify(task)),
      activity: bodyShown(JSON.stringify(e.ctx.store.activity.search({ limit: 500 }))),
      notifications: bodyShown(JSON.stringify(e.ctx.store.notifications.list())),
    };
    expect(res).toEqual({ records: layouts.map(() => 0), task: 0, activity: 0, notifications: 0 });
    // 검사는 돌았다 — 마지막(실패) 꼴의 끝 줄이 실행 기록에 있다
    expect(String(recs.at(-1)!.result.output)).toContain('done');
    expect(recs.at(-1)!.state).toBe('failed');
    expect(String(recs[0]!.result.output)).toContain('[가림:개인 키 — 28줄]');
  }, 180_000);
});

/** 한 줄로 이어 쓴 키 본문 8줄 (프로브 zz-xs5f5-inlinebegin의 모양 — 만든 값) */
const IB = Array.from({ length: 8 }, (_, i) => `MIIEpgAC${String(i).padStart(2, '0')}${'Hw5Rt2Yq'.repeat(8)}`.slice(0, 64));
const ibLogs = (n: number): string[] => Array.from({ length: n }, (_, i) => `[test] case ${i} ok`);
/** 한 줄로 이은 본문 8줄을 남기기 전에 가린 모습 — 저마다 '\n'의 n과 함께 한 이어짐이라 표시 여덟이 '\'로 이어진다 (리드 결정 S5-71) */
const IB_MASKED = '\\[가림:개인 키 조각]'.repeat(IB.length);
/** 잘린 키 꼴 넷 × 출력 끝·담는 중 끝 표시·흘려 보냄(끝 표시 없음·있음) — 출력 끝 꼴을 맨 뒤에 둔다(끝까지 시험에서 실패하는 검사) */
const IB_LAYOUTS: Array<{ name: string; lines: string[] }> = [
  ...Object.entries(INLINE_CUT_SHAPES).flatMap(([s, shape]) => {
    const line = inlineCutLine(shape, IB);
    const end = inlineCutEnd(shape);
    return [
      { name: `${s} · 담는 중 끝 표시`, lines: ['start', line, ...ibLogs(60), end, 'after'] },
      { name: `${s} · 흘려 보냄, 끝 표시 없음`, lines: ['start', line, ...ibLogs(420)] },
      { name: `${s} · 흘려 보냄, 뒤에 끝 표시`, lines: ['start', line, ...ibLogs(420), end, 'after'] },
    ];
  }),
  ...Object.entries(INLINE_CUT_SHAPES).map(([s, shape]) => ({ name: `${s} · 출력 끝`, lines: ['start', inlineCutLine(shape, IB), 'Tests: 1 failed'] })),
];

describe('자동 검사의 출력도 창을 연 줄을 시작 표시와 함께 남긴다 — 그 줄에서 끝 표시 전에 잘린 키 (리드 결정 S5-61)', () => {
  it('잘린 키 꼴 넷 × 네 길: 백엔드 가리개로 모은 검사 결과에 본문 조각이 없다 — 날 출력을 가리개로만 가려도 0 (프로브 zz-xs5f5-inlinebegin)', () => {
    const r = createRedactor();
    const shown: Record<string, { tail: number; plain: number }> = {};
    for (const { name, lines } of IB_LAYOUTS) shown[name] = { tail: leakedPieces(collect(lines, (s) => r.text(s)), IB).length, plain: leakedPieces(r.text(lines.join('\n')), IB).length };
    expect(shown).toEqual(Object.fromEntries(IB_LAYOUTS.map(({ name }) => [name, { tail: 0, plain: 0 }])));
    // 출력 끝 — 시작 줄은 '[가림:개인 키]' 뒤에 가린 본문과 잘린 자리 뒤 글이 남는다. 리드 결정 S5-71이 이 기대를 바꿨다 — 시작 표시 뒤 본문의 base64
    // 이어짐('\n'의 n과 본문 64자)은 남기기 전에 '[가림:개인 키 조각]'으로 가린다(예전에는 날것으로 남기고 마지막 가리기에 맡겼다).
    // 리드 결정 S5-78이 백엔드 가리개 쪽 기대를 다시 바꿨다 — 남길 때 가리개가 먼저 돌아 시작 표시와 이어 쓴 본문(PEM 꼬리)이 '[가림:개인 키]' 하나가 되고
    // 잘린 자리 뒤 글만 남는다. 조각 표시는 가리개 없이 모은 글에서 본다
    const json = INLINE_CUT_SHAPES['JSON 로그 — 로거가 값을 자름']!;
    expect(collect(['start', inlineCutLine(json, IB), 'Tests: 1 failed']).split('\n').slice(-2)).toEqual([`${json.begin}${IB_MASKED}${json.post}`, 'Tests: 1 failed']);
    expect(collect(['start', inlineCutLine(json, IB), 'Tests: 1 failed'], (s) => r.text(s)).split('\n').slice(-2)).toEqual([`[가림:개인 키]${json.post}`, 'Tests: 1 failed']);
  });

  it('끝까지: 실제 러너로 돈 검사가 잘린 키를 찍고 마지막 검사가 실패해도 실행 기록·작업 기록·활동 기록·알림에 본문 조각이 없다 (프로브 zz-xs5f5-inlinebegin)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wook-test-acinl-'));
    writeFileSync(join(dir, 'layouts.json'), JSON.stringify(IB_LAYOUTS.map(({ lines }) => lines)));
    writeFileSync(
      join(dir, 'check.cjs'),
      [
        "const fs = require('node:fs');",
        "const [file, index, code] = process.argv.slice(2);",
        "for (const l of JSON.parse(fs.readFileSync(file, 'utf8'))[Number(index)]) process.stdout.write(l + '\\n');",
        'process.exitCode = Number(code);',
      ].join('\n'),
    );
    const cmd = (index: number, code: number): string => `"${process.execPath}" "${join(dir!, 'check.cjs')}" "${join(dir!, 'layouts.json')}" ${index} ${code}`;
    env = await boot({ runner: true, checkCommands: IB_LAYOUTS.map((_, i) => cmd(i, i === IB_LAYOUTS.length - 1 ? 1 : 0)) });
    const e = env;
    const runner = e.ctx.deps.runner;
    const origStart = runner.start.bind(runner);
    runner.start = (spec) => {
      const p = origStart(spec);
      started.push(p);
      return p;
    };
    const id = await readyToSubmit(e);
    await e.core.tasks.processSubmission(id);
    const recs = e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' });
    expect(recs).toHaveLength(IB_LAYOUTS.length);
    const task = e.ctx.store.tasks.require(id);
    const pieces = (v: unknown): number => leakedPieces(JSON.stringify(v), IB).length;
    const res = {
      records: recs.map((r) => pieces(r)),
      task: pieces(task),
      activity: pieces(e.ctx.store.activity.search({ limit: 500 })),
      notifications: pieces(e.ctx.store.notifications.list()),
    };
    expect(res).toEqual({ records: IB_LAYOUTS.map(() => 0), task: 0, activity: 0, notifications: 0 });
    // 검사는 돌았다 — 마지막(실패) 검사의 끝 줄과 가린 시작 줄이 실행 기록에 있다 (리드 결정 S5-71 — 시작 표시 뒤 본문은 가린 표시로. 리드 결정 S5-78 — 남길
    // 때 백엔드 가리개가 먼저 돌아 시작 표시와 이어 쓴 본문이 '[가림:개인 키]' 하나가 된다)
    expect(recs.at(-1)!.state).toBe('failed');
    expect(String(recs.at(-1)!.result.output)).toContain(`\n[가림:개인 키]${INLINE_CUT_SHAPES['말줄임표로 자른 로그 값']!.post}\nTests: 1 failed`);
  }, 180_000);
});

/** 진짜 줄바꿈으로 찍은 키 본문 — 첫 키 8줄, 둘째 키 8줄 (프로브 zz-xs5f6es-realcut의 모양 — 만든 값) */
const RC = Array.from({ length: 8 }, (_, i) => `MIIEvQAC${String(i).padStart(2, '0')}${'Jt5Mx2Qb'.repeat(8)}`.slice(0, 64));
const RC2 = Array.from({ length: 8 }, (_, i) => `MHcCAQAC${String(i).padStart(2, '0')}${'Ne8Kp3Vw'.repeat(8)}`.slice(0, 64));
const RC_ALL = [...RC, ...RC2];
/** 잘린 꼴 여덟 × 출력 끝·흘려 보냄(420줄)·흘려 보낸 뒤 끝 표시·담는 중 끝 표시 (프로브 zz-xs5f6es-realcut) */
const RC_POSITIONS: Record<string, (cut: string[]) => string[]> = {
  '출력 끝': (cut) => ['start', ...cut, 'Tests: 1 failed'],
  '흘려 보냄': (cut) => ['start', ...cut, ...ibLogs(420)],
  '흘려 보낸 뒤 끝 표시': (cut) => ['start', ...cut, ...ibLogs(420), ...realCutEnds(cut), 'after'],
  '담는 중 끝 표시': (cut) => ['start', ...cut, ...ibLogs(20), ...realCutEnds(cut), 'after'],
};
const RC_LAYOUTS = Object.entries(REAL_CUT_SHAPES).flatMap(([s, make]) =>
  Object.entries(RC_POSITIONS).map(([p, place]) => ({ name: `${s} · ${p}`, position: p, lines: place(make(RC, RC2)) })),
);

describe('자동 검사의 출력도 창 안에서 남기는 글의 base64 이어짐을 가린다 — 진짜 줄바꿈으로 찍은 키가 끝 표시 전에 잘린 꼴 (리드 결정 S5-71)', () => {
  it('잘린 꼴 여덟 × 네 길: 백엔드 가리개로 모은 검사 결과에 본문 조각과 base64 16자 넘는 이어짐이 없고, 가리개로만 가린 것보다 덜 가리지 않는다 (프로브 zz-xs5f6es-realcut)', () => {
    const r = createRedactor();
    const shown: Record<string, { tail: number; run: string | null; worse: number }> = {};
    for (const { name, lines } of RC_LAYOUTS) {
      const tail = collect(lines, (s) => r.text(s));
      const plain = r.text(lines.join('\n'));
      const leaked = leakedPieces(tail, RC_ALL);
      shown[name] = { tail: leaked.length, run: longRun(tail), worse: leaked.filter((x) => !plain.includes(x)).length };
    }
    expect(shown).toEqual(Object.fromEntries(RC_LAYOUTS.map(({ name }) => [name, { tail: 0, run: null, worse: 0 }])));
    // 출력 끝 — 잘린 줄은 남되 그 본문은 가려진다
    const preview = REAL_CUT_SHAPES["미리 보기 content[:N] + '...'"]!(RC, RC2);
    expect(collect(RC_POSITIONS['출력 끝']!(preview), (s) => r.text(s)).split('\n').slice(-2)).toEqual(['[가림:개인 키 조각]...', 'Tests: 1 failed']);
  });

  it('끝까지: 실제 러너로 돈 검사가 잘린 꼴 여덟을 출력 끝·흘려 보냄으로 찍고 마지막 검사가 실패해도 실행 기록·작업 기록·활동 기록·알림에 본문 조각이 없다 (프로브 zz-xs5f6es-realcut)', async () => {
    // 흘려 보냄을 앞에, 출력 끝을 뒤에 — 마지막(실패하는 검사)은 출력 끝 꼴
    const layouts = [...RC_LAYOUTS.filter((l) => l.position === '흘려 보냄'), ...RC_LAYOUTS.filter((l) => l.position === '출력 끝')];
    expect(layouts).toHaveLength(16);
    dir = mkdtempSync(join(tmpdir(), 'wook-test-acrc-'));
    writeFileSync(join(dir, 'layouts.json'), JSON.stringify(layouts.map(({ lines }) => lines)));
    writeFileSync(
      join(dir, 'check.cjs'),
      [
        "const fs = require('node:fs');",
        "const [file, index, code] = process.argv.slice(2);",
        "for (const l of JSON.parse(fs.readFileSync(file, 'utf8'))[Number(index)]) process.stdout.write(l + '\\n');",
        'process.exitCode = Number(code);',
      ].join('\n'),
    );
    const cmd = (index: number, code: number): string => `"${process.execPath}" "${join(dir!, 'check.cjs')}" "${join(dir!, 'layouts.json')}" ${index} ${code}`;
    env = await boot({ runner: true, checkCommands: layouts.map((_, i) => cmd(i, i === layouts.length - 1 ? 1 : 0)) });
    const e = env;
    const runner = e.ctx.deps.runner;
    const origStart = runner.start.bind(runner);
    runner.start = (spec) => {
      const p = origStart(spec);
      started.push(p);
      return p;
    };
    const id = await readyToSubmit(e);
    await e.core.tasks.processSubmission(id);
    const recs = e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' });
    expect(recs).toHaveLength(layouts.length);
    const task = e.ctx.store.tasks.require(id);
    const pieces = (v: unknown): number => leakedPieces(JSON.stringify(v), RC_ALL).length;
    const res = {
      records: recs.map((x) => pieces(x)),
      task: pieces(task),
      activity: pieces(e.ctx.store.activity.search({ limit: 500 })),
      notifications: pieces(e.ctx.store.notifications.list()),
    };
    expect(res).toEqual({ records: layouts.map(() => 0), task: 0, activity: 0, notifications: 0 });
    // 검사는 돌았다 — 마지막(실패) 검사의 출력에 가린 잘린 줄과 끝 줄이 있다 (한 출력에 잘린 키 둘)
    expect(recs.at(-1)!.state).toBe('failed');
    expect(String(recs.at(-1)!.result.output)).toContain('[가림:개인 키 조각]...\nTests: 1 failed');
    // 작업의 검사 결과에도 그 출력이 실렸다
    expect(JSON.stringify(task)).toContain('[가림:개인 키 조각]');
  }, 180_000);
});

/** 창 안에서 남는 줄에 든 비밀 값 (프로브 zz-xs5f7es-ctxloss — 만든 가짜 값) */
const CTX_PW = 'Ch@ngeIt!2026';
const CTX_PW2 = 'hunter2!x';
const CTX_PW3 = 's3cr3t!pw';
const CTX_FLAG = 'qX9#63!';
const CTX_BODY = Array.from({ length: 6 }, (_, i) => `MIIEcy${String(i).padStart(2, '0')}${'Gh5Jk8Lm'.repeat(8)}`.slice(0, 64));
const CTX_PIECE = '[가림:개인 키 조각]';
/** 꼴 이름 → [줄, 숨길 값, 그 값이 든 줄이 남는 모습] — 떠돌이 시작 표시는 키 파일의 첫 줄만 찍은 출력이다 */
const CTX_SHAPES: Record<string, { lines: string[]; secret: string; kept: string }> = {
  '로거가 키 필드를 자르고 이어 쓴 JSON 기록의 keyStorePassword': {
    lines: [`{"level":"info","tls":{"privateKey":"${PEM_BEGIN}\\n${CTX_BODY.join('\\n')}...(truncated)","keyStorePassword":"${CTX_PW}"}}`],
    secret: CTX_PW,
    kept: `[가림:개인 키]...(truncated)","${CTX_PIECE}":"[가림:비밀 값]"}}`,
  },
  '떠돌이 시작 표시 뒤 JSON 설정': { lines: [PEM_BEGIN, '{', `  "databasePassword": "${CTX_PW2}"`, '}'], secret: CTX_PW2, kept: `  "${CTX_PIECE}": "[가림:비밀 값]"` },
  '떠돌이 시작 표시 뒤 YAML': { lines: [PEM_BEGIN, 'ssl:', `    trustStorePassword: ${CTX_PW}`], secret: CTX_PW, kept: `    ${CTX_PIECE}: [가림:비밀 값]` },
  // 시작 표시 바로 다음 줄은 가리개만으로 가릴 때 PEM 꼬리 규칙이 첫 낱말('server')을 먹어 이름 규칙이 맞지 않는다 — 대조가 서게 한 줄을 사이에 둔다
  '떠돌이 시작 표시 뒤 properties': { lines: [PEM_BEGIN, 'server.port=8443', `server.ssl.keyStorePassword=${CTX_PW}`], secret: CTX_PW, kept: `server.ssl.${CTX_PIECE}[가림:비밀 값]` },
  '떠돌이 시작 표시 뒤 XML': { lines: [PEM_BEGIN, `<keystorePassword>${CTX_PW}</keystorePassword>`], secret: CTX_PW, kept: `<${CTX_PIECE}>[가림:비밀 값]<${CTX_PIECE}>` },
  '떠돌이 시작 표시 뒤 연결 URL': { lines: [PEM_BEGIN, `DATABASE_URL=postgres://applicationuser1234:${CTX_PW3}@db:5432/app`], secret: CTX_PW3, kept: `DATABASE_URL=postgres:${CTX_PIECE}:[가림:URL 비밀번호]@db:5432/app` },
  '떠돌이 시작 표시 뒤 명령 옵션': { lines: [PEM_BEGIN, `running: tool --privateKeyPassphrase "${CTX_FLAG}" --verbose`], secret: CTX_FLAG, kept: `running: tool --${CTX_PIECE} "[가림:비밀 값]" --verbose` },
};

describe('자동 검사의 출력도 창 안에서 남기는 글을 가리개로 먼저 가린다 — 16자 넘는 이름·URL 사용자 옆의 값 (리드 결정 S5-78)', () => {
  it('꼴 일곱 × 출력 끝·흘려 보냄: 백엔드 가리개로 모은 검사 결과에 값이 없고 이름은 조각 표시다 — 가리개만으로도 없다 (프로브 zz-xs5f7es-ctxloss)', () => {
    const r = createRedactor();
    const rows: Record<string, { tail: boolean; kept: boolean; alone: boolean }> = {};
    for (const [name, { lines, secret, kept }] of Object.entries(CTX_SHAPES)) {
      // 흘려 보냄 — 창을 연 줄 뒤에 420줄을 넣어 담는 상한을 넘긴다(검사 결과는 끝 4,000자라 값 줄은 그 뒤에 둔다). 한 줄 꼴(잘린 JSON 기록)은 시작 줄이
      // 흘려 보내기 표시 바로 뒤에 남아 끝 4,000자 밖이라 출력 끝만 본다 — 흘려 보내는 시작 줄은 hostExecRedact가 본다
      const places: Array<[string, string[]]> = [['출력 끝', ['start', ...lines, 'Tests: 1 failed']]];
      if (lines.length > 1) places.push(['흘려 보냄', ['start', lines[0]!, ...ibLogs(420), ...lines.slice(1), 'Tests: 1 failed']]);
      for (const [where, ls] of places) {
        const tail = collect([...ls], (s) => r.text(s));
        rows[`${name} · ${where}`] = { tail: shownPieces(tail, secret, 8), kept: tail.split('\n').includes(kept), alone: shownPieces(r.text(ls.join('\n')), secret, 8) };
      }
    }
    expect(rows).toEqual(Object.fromEntries(Object.keys(rows).map((k) => [k, { tail: false, kept: true, alone: false }])));
  });

  it('비밀 값 줄 퍼즈 400건(꼴 12 × 자리 7): 가리개만으로 가려지는 값은 검사 결과(끝 4,000자)에서도 가려진다 (리드 결정 S5-78의 차등 불변식)', () => {
    const rand = seeded(0x5f781);
    const worse: string[] = [];
    let checked = 0;
    for (let c = 0; c < 400; c++) {
      const k = secretCase(rand);
      const r = createRedactor();
      for (const v of k.register) r.addSecret(v, 'db');
      const tail = collect(k.lines, (s) => r.text(s));
      const alone = r.text(k.lines.join('\n'));
      for (const s of k.secrets) {
        if (shownPieces(alone, s.value, s.piece)) continue;
        checked++;
        if (shownPieces(tail, s.value, s.piece) && worse.length < 5) worse.push(`경우 ${c}(${k.position}·${k.format})`);
      }
    }
    expect(worse).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });

  it('끝까지: 실제 러너로 돈 검사가 그 꼴 일곱을 찍고 실패해도 실행 기록·작업 기록·활동 기록·알림에 값이 없다 — 검사 결과에는 가린 줄이 남는다 (프로브 zz-xs5f7es-ctxloss)', async () => {
    const shapes = Object.values(CTX_SHAPES);
    dir = mkdtempSync(join(tmpdir(), 'wook-test-acctx-'));
    // 한 검사가 꼴 일곱을 차례로 찍는다 — 첫 꼴(잘린 JSON 기록)의 시작 표시가 연 창은 출력 끝까지 열려 있어 그 뒤 꼴의 줄은 모두 창 안이다(떠돌이 시작 표시
    // 줄은 빼고 찍는다 — 창 안에서 남은 시작 표시 줄은 마지막 가리기의 PEM 꼬리 규칙이 다음 줄 첫 낱말을 함께 가려 모습이 바뀐다)
    writeFileSync(join(dir, 'lines.json'), JSON.stringify(['start', ...shapes.flatMap(({ lines }, i) => (i === 0 ? lines : lines.slice(1))), 'Tests: 1 failed']));
    writeFileSync(
      join(dir, 'check.cjs'),
      [
        "const fs = require('node:fs');",
        "for (const l of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) process.stdout.write(l + '\\n');",
        'process.exitCode = 1;',
      ].join('\n'),
    );
    env = await boot({ runner: true, checkCommands: [`"${process.execPath}" "${join(dir, 'check.cjs')}" "${join(dir, 'lines.json')}"`] });
    const e = env;
    const runner = e.ctx.deps.runner;
    const origStart = runner.start.bind(runner);
    runner.start = (spec) => {
      const p = origStart(spec);
      started.push(p);
      return p;
    };
    const id = await readyToSubmit(e);
    await e.core.tasks.processSubmission(id);
    const rec = e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' }).at(-1)!;
    const task = e.ctx.store.tasks.require(id);
    expect(rec.state).toBe('failed');
    // 검사는 돌았다 — 가린 줄이 실행 기록의 출력과 작업 기록에 있다
    const output = String(rec.result.output).split('\n');
    expect(shapes.filter(({ kept }) => !output.includes(kept)).map(({ kept }) => kept)).toEqual([]);
    expect(output.at(-1)).toBe('Tests: 1 failed');
    expect(JSON.stringify(task)).toContain(JSON.stringify(CTX_SHAPES['떠돌이 시작 표시 뒤 YAML']!.kept).slice(1, -1));
    const secrets = shapes.map(({ secret }) => secret);
    const shown = (v: unknown): string[] => secrets.filter((s) => shownPieces(JSON.stringify(v), s, 8));
    const res = {
      record: shown(rec),
      task: shown(task),
      activity: shown(e.ctx.store.activity.search({ limit: 500 })),
      notifications: shown(e.ctx.store.notifications.list()),
    };
    expect(res).toEqual({ record: [], task: [], activity: [], notifications: [] });
  }, 180_000);
});

const MIB32 = 32 * 1024 * 1024;
/** 줄바꿈 없이 K × 32MiB(+1MiB)를 쓰고 기다리는 검사 — 넉넉한 벽시계 상한(90초) 뒤에는 스스로 끝난다 */
const FLOODER = String.raw`
const fs = require('node:fs');
const [dir, k] = process.argv.slice(2);
const all = (fd, buf) => { let off = 0; while (off < buf.length) { try { off += fs.writeSync(fd, buf, off); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } };
const unit = '\r[#####     ] 45% eta 00:01 ';
const block = Buffer.from(unit.repeat(Math.ceil((1 << 20) / unit.length)));
const want = Number(k) * ${MIB32} + (1 << 20);
for (let n = 0; n < want; n += block.length) all(1, block);
fs.writeFileSync(dir + '/done.txt', String(Date.now()));
setTimeout(() => process.exit(0), 90000);
`;

async function readyToSubmit(e: Env): Promise<string> {
  const t = newTask(e);
  await activate(e, t.id);
  e.core.tasks.setSteps(t.id, ['단계']);
  const ws = e.ctx.store.tasks.require(t.id).workspace!;
  writeFileSync(join(ws.worktreePath, `${t.id}.txt`), 'x\n');
  const dev = e.ctx.store.members.require(t.assigneeId);
  await e.core.tasks.completeStep(t.id, 0, '', dev, null);
  e.core.tasks.requestSubmit(t.id, '제출', dev);
  return t.id;
}

describe('줄바꿈 없이 큰 출력을 낸 자동 검사의 긴급 정지 (리드 결정 S5-52, 프로브 zz-xs5f3-autochecknonl)', () => {
  it('15 × 32MiB를 줄바꿈 없이 찍은 검사: 정지 요약이 3초 안에 오고 이벤트 루프가 1초 넘게 막히지 않는다 — 실행 기록의 출력은 생략 표시', async () => {
    const K = 15;
    dir = mkdtempSync(join(tmpdir(), 'wook-test-acnonl-'));
    writeFileSync(join(dir, 'flood.cjs'), FLOODER);
    env = await boot({ runner: true, checkCommands: [`"${process.execPath}" "${join(dir, 'flood.cjs')}" "${dir}" ${K}`] });
    const e = env;
    const runner = e.ctx.deps.runner;
    const origStart = runner.start.bind(runner);
    let lines = 0;
    runner.start = (spec) => {
      const p = origStart(spec);
      started.push(p);
      p.onStdoutLine(() => lines++);
      return p;
    };
    const id = await readyToSubmit(e);
    const sub = e.core.tasks.processSubmission(id);
    await waitFor(() => existsSync(join(dir!, 'done.txt')), '홍수 다 씀', 180_000);
    // 자식이 쓴 것을 러너가 다 읽을 때까지 (줄 수 = 32MiB 줄 K개)
    await waitFor(() => lines >= K, '긴 줄을 다 읽음', 60_000);
    let worst = 0;
    let last = performance.now();
    const iv = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 20);
    const t0 = performance.now();
    const summary = await e.core.stops.emergency(OWNER);
    const summaryMs = Math.round(performance.now() - t0);
    await sub;
    clearInterval(iv);
    worst = Math.round(Math.max(worst, performance.now() - last));
    const rec = e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' }).at(-1)!;
    const info = JSON.stringify({ summaryMs, worst, completed: summary.completed, lines });
    expect(summaryMs, info).toBeLessThan(3000);
    expect(worst, info).toBeLessThan(1000);
    expect(summary.completed, info).toBe(true);
    // 32MiB 줄 K개와, 정지로 끝날 때 낸 줄바꿈 없는 마지막 조각(1MiB) — 리드 결정 S5-54로 생략 표시는 host_exec와 같은 바이트 수다
    const skipped = /…\((\d+)바이트 생략\)…/.exec(String(rec.result.output));
    expect(Number(skipped?.[1]), String(rec.result.output).slice(0, 200)).toBeGreaterThanOrEqual(K * MIB32);
  }, 300_000);
});

describe('가리기가 실패해도 자동 검사는 던지지 않는다 — 남은 프로세스의 보류와 알림이 그대로 (리드 결정 S5-83, 프로브 zz-xs5f8es-redthrow)', () => {
  /** 가리지 못한 글을 바꾸는 표시 — 시험은 글 그대로 본다(이 차례 전 코드에서도 같은 단언이 돌게) */
  const FAILED = '[가림:가리기 실패]';
  const SECRET_MARK = '[가림:비밀 값]';
  /** 이어 쓴 대입 끝의 값 (만든 가짜 값) */
  const TAIL = ['Jt6', 'mR2x', 'Qa9v', 'Pz4'].join('');
  /** 공백 없이 이어 쓴 대입 48KiB 가까이 — 남기는 한 줄의 상한 안 */
  const CHAIN = 'key:'.repeat(Math.floor((48 * 1024 - 64) / 4)) + TAIL;
  /** 넣은 내부 오류의 표지 — 이 글이 든 글을 가리면 던지는 가리개 */
  const SENTINEL = ['ac', 'sentinel', '5f83'].join('-');

  /** 제출 흐름으로 자동 검사를 돌린다 — 검사는 lines를 찍고 종료 코드 1로 끝나며 하위 프로세스 2개가 남는다. 작업 ID */
  async function submitWithLeftover(e: OrchEnv, lines: string[]): Promise<string> {
    e.check = (c) => {
      for (const l of lines) c.line(l);
      c.exit(1, { remaining: 2 });
    };
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => !!e.liveProc(key), '작업 턴');
    const p = e.liveProc(key)!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['구현'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'feature.txt'), '기능\n', 'utf8');
    expect((await e.tool(p.turnId, 'complete_step', { step_index: 0, note: '완료' })).ok).toBe(true);
    expect((await e.tool(p.turnId, 'submit_for_review', { note: '제출' })).ok).toBe(true);
    p.finishOk();
    await waitFor(() => e.checkProcs.length === 1 && !e.core.tasks.isSubmitting(t.id) && e.core.turns.count() === 0, '제출 처리 끝', 30_000);
    return t.id;
  }

  /** 남은 프로세스의 보류(오류 사유 '자동 검사 종료 뒤 하위 프로세스 2개가 남았습니다')와 kill-failed 알림 — 제출 실패 보류가 아니다 */
  function expectLeftoverHold(e: OrchEnv, id: string): void {
    const task = e.ctx.store.tasks.require(id);
    expect(task.state).toBe('on_hold');
    expect(task.hold.reasons.map((r) => r.note.split(' (')[0])).toEqual(['자동 검사 종료 뒤 하위 프로세스 2개가 남았습니다']);
    expect(task.review.autoCheck?.status).toBe('not_run');
    const alerts = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert').map((q) => q.alertKey);
    expect(alerts).toEqual([`alert:kill-failed:${id}`]);
    expect(e.ctx.store.notifications.list().filter((n) => n.title.startsWith('프로세스 종료 확인 실패'))).toHaveLength(1);
  }

  it('CheckOutputTail: 48KiB로 이어 쓴 대입 한 줄을 던지지 않고 가린다 — 맨 바깥부터 17개 뒤의 값은 비밀 값 표시', () => {
    expect(collect(['FAIL test 1', CHAIN, 'done'], (s) => createRedactor().text(s))).toBe(`FAIL test 1\n${'key:'.repeat(17)}${SECRET_MARK}\ndone`);
  });

  it('끝까지: 48KiB로 이어 쓴 대입을 찍고 하위 프로세스를 남긴 검사 — 제출 실패 보류가 아니라 남은 프로세스 보류와 kill-failed 알림이고, 실행 기록의 출력에 값이 없다', async () => {
    const e = (orchEnv = await bootOrch({ checkCommands: ['npm test'] }));
    const id = await submitWithLeftover(e, ['FAIL test 1', CHAIN]);
    expectLeftoverHold(e, id);
    const rec = e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' }).at(-1)!;
    expect(rec).toMatchObject({ state: 'failed', result: { exitCode: 1, remaining: 2, output: `FAIL test 1\n${'key:'.repeat(17)}${SECRET_MARK}` } });
    expect(JSON.stringify([rec, e.ctx.store.tasks.require(id), e.ctx.store.activity.search({ limit: 500 })]).includes(TAIL)).toBe(false);
  });

  it('끝까지: 가리개가 던져도(넣은 오류) 검사 결과는 가리기 실패 표시이고 남은 프로세스 보류·kill-failed 알림·실행 기록·활동 기록이 그대로다', async () => {
    const e = (orchEnv = await bootOrch({ checkCommands: ['npm test'] }));
    const red = e.ctx.deps.redactor;
    const original = red.text.bind(red);
    red.text = (s: string): string => {
      if (s.includes(SENTINEL)) throw new RangeError('Maximum call stack size exceeded');
      return original(s);
    };
    const id = await submitWithLeftover(e, ['FAIL test 1', `log ${SENTINEL}`]);
    expectLeftoverHold(e, id);
    const rec = e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' }).at(-1)!;
    expect(rec).toMatchObject({ state: 'failed', result: { exitCode: 1, remaining: 2, output: FAILED } });
    const rows = e.ctx.store.activity.search({ limit: 500 }).map((a) => a.text);
    expect(rows.filter((t) => t.includes('자동 검사 종료 뒤 하위 프로세스 2개가 남았습니다')).length).toBeGreaterThan(0);
    expect(JSON.stringify([rec, e.ctx.store.tasks.require(id), rows, e.ctx.store.notifications.list()]).includes(SENTINEL)).toBe(false);
  });

  it('검사 출력을 셈하다 던져도(CheckOutputTail.text를 던지게 함) AutoChecker.run은 결과 자리에 표시를 두고 남은 프로세스 보류로 간다 — 실행 기록에 남은 수와 출력 표시', async () => {
    const e = (env = await boot());
    const t = newTask(e);
    await activate(e, t.id);
    const task = e.ctx.store.tasks.require(t.id);
    const project = e.ctx.store.projects.require(task.projectId);
    e.ctx.deps.runner = {
      ...e.ctx.deps.runner,
      start: (spec) => {
        const p = new FakeProc('check', '', spec.label);
        setImmediate(() => {
          p.line('FAIL test 1');
          p.exit(1, { remaining: 2 });
        });
        return p;
      },
    } as ProcessRunner;
    vi.spyOn(CheckOutputTail.prototype, 'text').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    const res = await e.core.checks.run(task, { ...project, checkCommands: ['npm test'] }, task.workspace!.worktreePath);
    expect(res).toMatchObject({ status: 'failed', stopped: true });
    expect(res.detail.endsWith(`\n${FAILED}`)).toBe(true);
    expect(res.detail).toContain('검사 프로세스의 종료를 확인하지 못함');
    const rec = e.ctx.store.execs.list({ ref1: t.id, ref2: 'auto_check' }).at(-1)!;
    expect(rec).toMatchObject({ state: 'failed', result: { exitCode: 1, remaining: 2, output: FAILED } });
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.kind)).toEqual(['error']);
  });
});
