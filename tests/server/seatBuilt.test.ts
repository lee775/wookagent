/**
 * 빌드한 서버의 메인 자리 명령 (SERVER_DESIGN 4.4·10.4, 리드 결정 S4-8): 실제 운영자 명령(`wook-server seat status|assign`)이 서로 증명한 관리 채널(S3-16)로
 * 빌드한 서버에 닿는다.
 * - seat status는 보기만 한다 (--json도)
 * - seat assign은 운영자 배정이다 — 나가는 보유자(모의 메인)의 인계 메모 턴을 거쳐 넘어가고, --force는 기다리지 않는다. 이력에 운영자로 남는다
 * - 등록되지 않은 외부 보유자는 그렇다고(S7-4), 이미 앉은 보유자는 그렇다고 거부한다(끝 코드 1). 모양이 틀린 표기는 서버에 붙지 않고(끝 코드 2) 그 값을
 *   되풀이하지 않는다
 * 데이터 폴더는 하네스(모의 메인 — 개발자 옵션)로 준비한다. 빌드한 서버가 이 PC의 실제 Claude·Codex CLI를 띄우지 않게
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeatOperatorStatus } from '../../src/main/backend/types';
import { SEAT_HOLDER_SHAPE } from '../../src/main/orchestrator/seat';
import { createHarness } from '../e2e/harness';
import { buildServerTo, clientJson, removeDir, runClient, sleep, startBuilt, testBuildDir, type BuiltServer } from './helpers';

let outDir = '';
let entry = '';
const dirs: string[] = [];
const servers: BuiltServer[] = [];

beforeAll(() => {
  outDir = testBuildDir('seat');
  entry = buildServerTo(outDir);
}, 180_000);

afterAll(async () => {
  for (const s of servers) {
    if (s.child.exitCode === null) {
      runClient(entry, ['shutdown', '--data-dir', s.dataDir]);
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 40_000))]);
      if (s.child.exitCode === null) s.child.kill();
    }
  }
  for (const d of dirs) await removeDir(d);
  if (outDir) await removeDir(outDir);
});

/** seat status --json의 자리 (서버의 답) */
function status(dataDir: string): SeatOperatorStatus {
  const { code, reply } = clientJson(entry, ['seat', 'status', '--data-dir', dataDir]);
  if (code !== 0 || !reply.ok) throw new Error(`seat status 실패: ${reply.error?.code}`);
  return reply.result as SeatOperatorStatus;
}

/** 넘기는 중이면 끝날 때까지 seat status로 본다 */
async function settled(dataDir: string, generation: number): Promise<SeatOperatorStatus> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const s = status(dataDir);
    if (s.seat.generation === generation && s.seat.state === 'active') return s;
    if (Date.now() > deadline) throw new Error(`교체가 끝나지 않았습니다: ${JSON.stringify(s.seat)} ${JSON.stringify(s.swap)}`);
    await sleep(500);
  }
}

describe('빌드한 서버의 seat status·seat assign (S4-8)', () => {
  it('운영자 명령으로 자리를 보고 배정한다 — 운영자로 남고, --force는 기다리지 않으며, 거부는 참인 글이고 틀린 표기는 되풀이하지 않는다', async () => {
    // 모의 메인으로 데이터 폴더를 준비한다 (1세대 Claude CLI, 바꾼 쪽 서버)
    const h = await createHarness({ noProject: true });
    const dataDir = h.dataDir;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    const s = await startBuilt({ entry, dataDir });
    servers.push(s);

    const shown = runClient(entry, ['seat', 'status', '--data-dir', dataDir]);
    expect(shown.code).toBe(0);
    const lines = shown.stdout.split('\n');
    expect(lines[0]).toBe('욱채 메인 자리');
    expect(lines[1]).toMatch(/^ {2}보유자 {10}Claude CLI \(세대 1, \d{4}-\d\d-\d\dT[\d:.]+Z부터\)$/);
    expect(lines.slice(2, 6)).toEqual([
      '  상태            앉아 있음',
      '  응답            응답함',
      '  앉을 수 있는 쪽 launched:claude, launched:codex, external:*(등록한 외부 에이전트 모두)',
      '  마무리 기다림   120초',
    ]);
    expect(status(dataDir)).toMatchObject({ seat: { generation: 1, state: 'active', holder: { label: 'Claude CLI' } }, swap: null, unresponsiveForMs: null });

    // 운영자 배정 — 나가는 모의 메인의 인계 메모 턴을 거친다 (끝나기 전에 답하면 넘기는 중이라고 말한다)
    const assigned = runClient(entry, ['seat', 'assign', 'launched:codex', '--data-dir', dataDir]);
    expect([assigned.code, assigned.stderr]).toEqual([0, '']);
    expect(assigned.stdout).toMatch(/^메인 자리를 Codex CLI에게 (넘겼습니다 \(세대 1 → 2, 운영자 배정\)|넘기는 중입니다 \(세대 1 → 2\))/);
    const second = await settled(dataDir, 2);
    expect(second.seat.holder).toMatchObject({ kind: 'launched', label: 'Codex CLI', ai: { kind: 'codex' } });
    expect(second.history.map((x) => [x.generation, x.changedBy, x.endReason])).toEqual([
      [2, 'operator', null],
      [1, 'server', '운영자가 바꿈: 운영자 복구 배정 (wook-server seat assign)'],
    ]);

    // --force — 마무리·인계 메모 턴을 기다리지 않는다
    const forced = clientJson(entry, ['seat', 'assign', 'launched:claude', '--force', '--data-dir', dataDir]);
    expect(forced).toMatchObject({ code: 0, reply: { ok: true, result: { outcome: 'swap', from: 2, generation: 3, holder: 'Claude CLI', force: true, state: 'active', stage: null } } });
    expect(status(dataDir).history.map((x) => [x.generation, x.changedBy])).toEqual([
      [3, 'operator'],
      [2, 'operator'],
      [1, 'server'],
    ]);

    // 거부: 등록되지 않은 외부 보유자(S7-4), 이미 앉은 보유자 — 끝 코드 1, 참인 글
    const external = runClient(entry, ['seat', 'assign', 'external:X-0001', '--data-dir', dataDir]);
    expect([external.code, external.stderr]).toEqual([
      1,
      'X-0001에게 메인 자리를 배정할 수 없습니다 — 등록되지 않은 외부 에이전트입니다 — 서버 PC의 운영자가 wook-server agent add로 등록한 뒤 쓸 수 있습니다\n',
    ]);
    const same = runClient(entry, ['seat', 'assign', 'launched:claude', '--data-dir', dataDir]);
    expect([same.code, same.stderr]).toEqual([1, '메인 자리에는 이미 Claude CLI가 같은 설정으로 앉아 있습니다(세대 3)\n']);
    // 틀린 표기: 서버에 붙지 않고(끝 코드 2) 그 값을 되풀이하지 않는다 (S3-39)
    const mark = 'GOCSPX-built-seat-mark-7';
    const bad = runClient(entry, ['seat', 'assign', mark, '--data-dir', dataDir]);
    expect(bad.code).toBe(2);
    expect(bad.stderr.startsWith(`${SEAT_HOLDER_SHAPE}\n`)).toBe(true);
    expect(`${bad.stdout}${bad.stderr}`.includes(mark)).toBe(false);
    expect(status(dataDir).seat.generation).toBe(3);

    // 끝낸 뒤: 서버 기록에 관리 채널의 seat 명령이 남고, 틀린 표기는 어디에도 없다
    expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
    await s.exited;
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    expect(log).toContain('관리 채널: seat.assign 처리');
    expect(log).toContain('관리 채널: seat.assign 거부 [conflict] X-0001에게 메인 자리를 배정할 수 없습니다');
    expect(log.includes(mark)).toBe(false);
  }, 240_000);
});
