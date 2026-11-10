/**
 * `wook-server` 인자 (SERVER_DESIGN 3.2·3.7, S2-4·S2-5): 데이터 폴더 순서(--data-dir → WOOK_DATA_DIR → 기본), 명령 이름, 서버 옵션의 자리,
 * 루프백 밖 --bind 거부, 한국어 출력.
 */
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSeatAssign, formatSeatStatus, formatStatus, formatStop, parseCli, SEAT_ASSIGN_USAGE } from './cli';
import type { SeatAssignReport, SeatOperatorStatus } from '../main/backend/types';
import { SEAT_HOLDER_SHAPE } from '../main/orchestrator/seat';
import { defaultDataDir, resolveDataDir } from './dataDir';
import { isLoopbackBind, startServer, ServerStartError, type AdminStatus } from './server';

const env = { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', XDG_CONFIG_HOME: '/home/a/.cfg' } as NodeJS.ProcessEnv;

describe('데이터 폴더 (3.7, S2-5)', () => {
  it('--data-dir이 먼저, 그다음 WOOK_DATA_DIR, 그다음 기본 위치', () => {
    expect(resolveDataDir('플래그 폴더', { ...env, WOOK_DATA_DIR: '환경 폴더' })).toBe(resolve('플래그 폴더'));
    expect(resolveDataDir(undefined, { ...env, WOOK_DATA_DIR: '환경 폴더' })).toBe(resolve('환경 폴더'));
    expect(resolveDataDir(undefined, env, process.platform)).toBe(resolve(defaultDataDir(env, process.platform)));
    expect(resolveDataDir('  ', { ...env, WOOK_DATA_DIR: '' }, process.platform)).toBe(resolve(defaultDataDir(env, process.platform)));
  });

  it('기본 위치는 데스크톱 앱과 같다: Windows %APPDATA%, macOS Application Support, Linux XDG_CONFIG_HOME 또는 ~/.config', () => {
    expect(defaultDataDir(env, 'win32', 'C:\\Users\\a')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'wookagent'));
    expect(defaultDataDir({}, 'win32', 'C:\\Users\\a')).toBe(join('C:\\Users\\a', 'AppData', 'Roaming', 'wookagent'));
    expect(defaultDataDir(env, 'darwin', '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'wookagent'));
    expect(defaultDataDir(env, 'linux', '/home/a')).toBe(join('/home/a/.cfg', 'wookagent'));
    expect(defaultDataDir({}, 'linux', '/home/a')).toBe(join('/home/a', '.config', 'wookagent'));
  });
});

describe('명령과 옵션', () => {
  it('인자가 없거나 serve면 서버, 기본 127.0.0.1:7317, 시험용 세션 꺼짐', () => {
    for (const argv of [[], ['serve']]) {
      const plan = parseCli([...argv, '--data-dir', 'd'], env);
      expect(plan).toEqual({ kind: 'serve', options: { dataDir: resolve('d'), bind: '127.0.0.1', port: 7317, webDir: null, allowTestSession: false } });
    }
    expect(parseCli(['serve', '--data-dir', 'd', '--port', '0', '--bind', '::1', '--web-dir', 'w', '--allow-test-session'], env)).toEqual({
      kind: 'serve',
      options: { dataDir: resolve('d'), bind: '::1', port: 0, webDir: 'w', allowTestSession: true },
    });
  });

  it('운영자 명령: status·stop·shutdown·session test, --json', () => {
    expect(parseCli(['status', '--data-dir', 'd'], env)).toEqual({ kind: 'client', command: 'status', dataDir: resolve('d'), json: false });
    expect(parseCli(['stop', '--data-dir', 'd', '--json'], env)).toMatchObject({ kind: 'client', command: 'stop', json: true });
    expect(parseCli(['shutdown', '--data-dir', 'd'], env)).toMatchObject({ kind: 'client', command: 'shutdown' });
    expect(parseCli(['session', 'test', '--data-dir', 'd'], env)).toMatchObject({ kind: 'client', command: 'session.test' });
  });

  it('모르는 명령·옵션, 자리가 틀린 옵션, 잘못된 포트는 쓰임새 오류', () => {
    expect(parseCli(['session'], env)).toEqual({ kind: 'error', message: '알 수 없는 명령입니다: session' });
    expect(parseCli(['restart'], env)).toMatchObject({ kind: 'error' });
    expect(parseCli(['--public-origin', 'x'], env)).toMatchObject({ kind: 'error' });
    expect(parseCli(['status', '--port', '1'], env)).toEqual({ kind: 'error', message: '--port는 서버를 띄울 때(serve)만 씁니다' });
    expect(parseCli(['status', '--allow-test-session'], env)).toEqual({ kind: 'error', message: '--allow-test-session는 서버를 띄울 때(serve)만 씁니다' });
    expect(parseCli(['serve', '--json'], env)).toMatchObject({ kind: 'error' });
    expect(parseCli(['--port', '70000'], env)).toEqual({ kind: 'error', message: '포트 번호가 올바르지 않습니다: 70000' });
    expect(parseCli(['--port', 'abc'], env)).toMatchObject({ kind: 'error' });
    expect(parseCli(['-h'], env)).toEqual({ kind: 'help' });
  });
});

describe('루프백에만 연다 (S2-2)', () => {
  it('127.0.0.1·::1·localhost만 루프백이다', () => {
    for (const b of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackBind(b)).toBe(true);
    for (const b of ['0.0.0.0', '::', '192.168.0.10', '127.0.0.2', 'example.com', '']) expect(isLoopbackBind(b)).toBe(false);
  });

  it('루프백 밖 --bind는 무엇도 열기 전에 분명한 글로 거부한다', async () => {
    const backend = {} as Parameters<typeof startServer>[0]['backend'];
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const err = await startServer({ backend, dataDir: 'unused', bind: '0.0.0.0', port: 0, allowTestSession: false, logger, version: '0' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as Error).message).toBe('--bind 0.0.0.0는 받지 않습니다 — 서버는 이 PC 안(127.0.0.1, ::1, localhost)에만 엽니다. 다른 기기에서는 tailscale serve로 들어오게 하세요');
  });
});

describe('한국어 출력', () => {
  const status: AdminStatus = {
    pid: 1234,
    uptimeSec: 200,
    bind: '127.0.0.1',
    port: 7317,
    url: 'http://127.0.0.1:7317',
    dataDir: 'C:\\data',
    runId: 'run-1',
    activeWork: true,
    version: '0.1.0',
    testSessions: { allowed: false, active: 0 },
    emergencyStop: { active: true, since: '2026-10-30T01:00:00.000Z' },
    secretStore: { backend: 'memory', fallbackReason: '모듈 없음' },
  };

  it('status는 pid·실행 시간·주소·데이터 폴더·실행 ID·작업·긴급 정지·비밀 값 저장·시험용 세션·버전을 말한다', () => {
    expect(formatStatus(status)).toBe(
      [
        '욱채 서버 상태',
        '  프로세스      pid 1234, 3분 20초째 실행 중',
        '  주소          http://127.0.0.1:7317 (이 PC 안에서만)',
        '  데이터 폴더   C:\\data',
        '  실행 ID       run-1',
        '  진행 중 작업  있음',
        '  긴급 정지     켜짐 (2026-10-30T01:00:00.000Z부터)',
        '  비밀 값 저장  메모리 (재시작하면 사라집니다 — 모듈 없음)',
        '  시험용 세션   꺼짐 (--allow-test-session 없이 시작)',
        '  버전          0.1.0',
        '',
      ].join('\n'),
    );
  });

  it('status는 화면 조작의 마지막으로 안 상태를 한 줄로 말한다 — 답에 그 칸이 없으면(예전 서버) 줄을 내지 않는다 (S6-11)', () => {
    const locked = formatStatus({ ...status, screen: { ok: false, state: 'locked', detail: '서버 PC 화면이 잠겨 있어 메인 에이전트가 화면을 보거나 조작할 수 없습니다', elevated: null } });
    expect(locked.split('\n')).toContain('  화면 조작     서버 PC 화면이 잠겨 있어 메인 에이전트가 화면을 보거나 조작할 수 없습니다');
    expect(formatStatus(status)).not.toContain('화면 조작');
  });

  it('status는 서버가 실제로 듣는 루프백 주소를 함께 말한다 (S2-14)', () => {
    const line = (addresses: string[]) => formatStatus({ ...status, addresses }).split('\n')[2];
    expect(line(['127.0.0.1', '::1'])).toBe('  주소          http://127.0.0.1:7317 (이 PC 안에서만 — 127.0.0.1과 ::1에서 받습니다)');
    expect(line(['127.0.0.1'])).toBe('  주소          http://127.0.0.1:7317 (이 PC 안에서만 — 127.0.0.1에서 받습니다)');
  });

  it('stop은 멈춘 실행과 보류한 작업 수, 확인하지 못한 실행을 말한다', () => {
    const base = { at: 'x', completed: true, stoppedTurns: [], heldTasks: [], failures: [] };
    expect(formatStop(base)).toBe('긴급 정지를 걸었습니다. 실행 중인 작업은 없었고, 새 실행을 막았습니다.\n');
    expect(
      formatStop({
        ...base,
        stoppedTurns: [{ turnId: 't', memberId: 'M-0001', memberName: '하늘', taskId: null, ok: true, detail: '' }],
        heldTasks: [{ taskId: 'T-0001', title: 'a', previousState: 'in_progress', projectId: 'P-0001' }],
      }),
    ).toBe('긴급 정지를 걸었습니다. 실행 1개를 멈추고 작업 1개를 보류했습니다. 정지 해제는 대표 화면에서 합니다.\n');
    expect(formatStop({ ...base, completed: false, failures: [{ memberId: 'M-0001', memberName: '하늘', detail: 'x', remaining: -1 }] })).toBe(
      '긴급 정지를 걸었지만 종료를 확인하지 못한 실행이 있습니다 (하늘). 새 실행은 막았고, 작업 0개를 보류했습니다.\n',
    );
  });
});

describe('메인 자리 명령 (S4-8)', () => {
  it('seat status·seat assign <보유자> [--force] — --force는 seat assign에만, 보유자 모양이 틀리면 서버에 붙지 않고 그 값을 되풀이하지 않는다', () => {
    expect(parseCli(['seat', 'status', '--data-dir', 'd'], env)).toEqual({ kind: 'client', command: 'seat.status', dataDir: resolve('d'), json: false });
    expect(parseCli(['seat', 'assign', 'launched:codex', '--data-dir', 'd', '--json'], env)).toEqual({ kind: 'client', command: 'seat.assign', dataDir: resolve('d'), json: true, args: ['launched:codex'] });
    expect(parseCli(['seat', 'assign', '--force', 'launched:claude'], env)).toMatchObject({ kind: 'client', command: 'seat.assign', args: ['launched:claude', '--force'] });
    // 외부 표기는 모양이 맞아 서버로 간다 — 서버가 7단계라고 답한다
    expect(parseCli(['seat', 'assign', 'external:X-0001'], env)).toMatchObject({ kind: 'client', command: 'seat.assign', args: ['external:X-0001'] });
    for (const argv of [['status', '--force'], ['seat', 'status', '--force'], ['serve', '--force'], ['--force']]) {
      expect([argv, parseCli(argv, env)]).toEqual([argv, { kind: 'error', message: '--force는 seat assign에만 씁니다' }]);
    }
    const mark = 'gpt-SEAT-MARK-91';
    for (const argv of [['seat', 'assign', mark], ['seat', 'assign', `launched:${mark}`], ['seat', 'assign', 'Launched:Codex']]) {
      expect([argv, parseCli(argv, env)]).toEqual([argv, { kind: 'error', message: SEAT_HOLDER_SHAPE }]);
    }
    for (const argv of [['seat', 'assign'], ['seat', 'assign', 'launched:codex', mark]]) {
      const plan = parseCli(argv, env);
      expect([argv, plan]).toEqual([argv, { kind: 'error', message: SEAT_ASSIGN_USAGE }]);
      expect(JSON.stringify(plan).includes(mark)).toBe(false);
    }
    // 'secret'이 든 낱말은 비밀 값 명령의 꼴로 답한다 (S3-39)
    expect(parseCli(['seat', 'assign', 'launched:codex', 'my-secret'], env)).toMatchObject({ kind: 'error', message: expect.stringContaining('비밀 값 명령은') });
    expect(parseCli(['seat', mark], env)).toEqual({ kind: 'error', message: '알 수 없는 명령입니다: seat … (뒤의 낱말은 값일 수 있어 보이지 않습니다)' });
  });

  it('seat status는 보유자·상태·응답·자리 정책·최근 이력을 말한다 — 응답 없음이면 그 시간과 까닭, 운영자의 길을', () => {
    const v: SeatOperatorStatus = {
      seat: {
        generation: 2,
        state: 'active',
        holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null }, label: 'Codex CLI' },
        since: '2026-11-03T01:00:00.000Z',
        unresponsiveSince: '2026-11-03T01:10:00.000Z',
        unresponsiveReason: '사용량 한도로 메인 턴이 3번 연달아 끝났습니다',
        pendingHolder: null,
        vision: 'unknown',
        screen: { unavailable: null, operatingSince: null, paused: null },
      },
      unresponsiveForMs: 75 * 60_000 + 5000,
      swap: null,
      policy: { holders: ['launched:claude', 'launched:codex', 'external:*'], drainMs: 120_000 },
      history: [
        { generation: 2, holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null }, label: 'Codex CLI' }, startedAt: '2026-11-03T01:00:00.000Z', endedAt: null, endReason: null, changedBy: 'operator', hasHandover: true },
        {
          generation: 1,
          holder: { kind: 'launched', ai: { kind: 'claude', model: null, effortTier: 'high', effortOverride: null }, label: 'Claude CLI' },
          startedAt: '2026-11-02T00:00:00.000Z',
          endedAt: '2026-11-03T01:00:00.000Z',
          endReason: '운영자가 바꿈: 운영자 복구 배정 (wook-server seat assign)',
          changedBy: 'server',
          hasHandover: false,
        },
      ],
    };
    expect(formatSeatStatus(v)).toBe(
      [
        '욱채 메인 자리',
        '  보유자          Codex CLI (세대 2, 2026-11-03T01:00:00.000Z부터)',
        '  상태            앉아 있음',
        '  응답            응답 없음 1시간 15분째 — 사용량 한도로 메인 턴이 3번 연달아 끝났습니다. 서버는 자리를 바꾸지 않습니다 — 바꾸려면 wook-server seat assign <보유자>',
        '  앉을 수 있는 쪽 launched:claude, launched:codex, external:*(7단계 전까지 앉히지 않음)',
        '  마무리 기다림   120초',
        '  최근 이력       세대 2 Codex CLI — 운영자, 2026-11-03T01:00:00.000Z부터',
        '                  세대 1 Claude CLI — 서버, 2026-11-02T00:00:00.000Z부터 2026-11-03T01:00:00.000Z까지 (운영자가 바꿈: 운영자 복구 배정 (wook-server seat assign))',
        '',
      ].join('\n'),
    );
    const switching = formatSeatStatus({
      ...v,
      seat: { ...v.seat, state: 'switching', unresponsiveSince: null, unresponsiveReason: null, pendingHolder: { ...v.history[1]!.holder } },
      unresponsiveForMs: null,
      swap: { from: 2, to: 3, by: 'operator', force: false, stage: 'unconfirmed', requestedAt: 'x' },
    }).split('\n');
    expect(switching[2]).toBe(
      "  상태            교체 중 → Claude CLI (세대 2 → 3, 운영자) — 멈췄습니다 — 나가는 메인 턴의 종료를 확인하지 못해 메인 에이전트를 일시정지해 두었습니다. 이 PC에 남은 프로세스가 모두 사라졌는지 확인한 뒤 대표가 '정지 해제'를 누르면 일시정지가 풀리고 교체를 이어 갑니다. 그동안 seat assign은 받지 않습니다",
    );
    expect(switching[3]).toBe('  응답            응답함');
    // 응답 없는 보유자를 바꾸는 중이면 seat assign의 길을 말하지 않는다 — 교체 중에는 받지 않는다 (리드 결정 S4-28)
    for (const stage of ['draining', 'finishing', 'unconfirmed'] as const) {
      const lines = formatSeatStatus({
        ...v,
        seat: { ...v.seat, state: 'switching', pendingHolder: { ...v.history[1]!.holder } },
        swap: { from: 2, to: 3, by: 'operator', force: false, stage, requestedAt: 'x' },
      }).split('\n');
      expect(lines[3]).toBe('  응답            응답 없음 1시간 15분째 — 사용량 한도로 메인 턴이 3번 연달아 끝났습니다. 서버는 자리를 바꾸지 않습니다');
    }
  });

  it('seat assign의 결과는 넘겼는지·넘기는 중인지·멈췄는지를 말한다', () => {
    const r: SeatAssignReport = { outcome: 'swap', from: 1, generation: 2, previous: 'Claude CLI', holder: 'Codex CLI', force: true, state: 'active', stage: null, drainMs: 120_000 };
    expect(formatSeatAssign(r)).toBe(
      '메인 자리를 Codex CLI에게 넘겼습니다 (세대 1 → 2, 운영자 배정, 강제 — 마무리와 인계 메모 턴을 기다리지 않음). 메인 토큰을 폐기하고 메인 세션을 닫았습니다. 새 보유자는 인계 꾸러미를 받고 쌓인 일을 이어서 처리합니다.\n',
    );
    expect(formatSeatAssign({ ...r, force: false, state: 'switching', stage: 'draining' })).toBe(
      '메인 자리를 Codex CLI에게 넘기는 중입니다 (세대 1 → 2) — 나가는 메인 턴의 마무리를 기다립니다 (최대 120초). 끝나면 넘어갑니다. wook-server seat status로 확인하세요.\n',
    );
    expect(formatSeatAssign({ ...r, force: false, state: 'switching', stage: 'unconfirmed' })).toBe(
      "메인 자리 교체가 멈췄습니다 (세대 1 → 2) — Codex CLI를 아직 앉히지 않았습니다. 나가는 메인 턴의 종료를 확인하지 못해 메인 에이전트를 일시정지해 두었습니다. 이 PC에 남은 프로세스가 모두 사라졌는지 확인한 뒤 대표가 '정지 해제'를 누르면 일시정지가 풀리고 교체를 이어 갑니다. 그동안 seat assign은 받지 않습니다.\n",
    );
    expect(formatSeatAssign({ ...r, outcome: 'seated', from: 0, generation: 1, previous: null })).toBe('빈 메인 자리에 Codex CLI를 앉혔습니다 (세대 1, 운영자 배정).\n');
  });
});
