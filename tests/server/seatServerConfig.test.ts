/**
 * server.json의 메인 자리 (SERVER_DESIGN 3.7·4.1, 리드 결정 S4-1·S4-12):
 * - seat.holders(앉을 수 있는 보유자)·seat.drainMs(교체 때 마무리를 기다리는 시간)는 시작과 config reload 때 자리 정책으로 적용한다 — 바뀐 것마다 답의 바뀐
 *   것과 활동 기록(행위자 operator). 칸이 없으면 지금 값 그대로
 * - seat.initialHolder는 새 DB의 빈 자리에만 쓴다 — 서버를 띄우면 그 보유자가 앉는다 (serve.ts가 백엔드에 넘긴다)
 * - 외부 보유자는 처음 보유자로 둘 수 없다: 시작은 실행 잠금·저장소를 만들기 전에, reload는 아무것도 바꾸지 않고 거부한다 — '외부 에이전트 접속은
 *   7단계에서 붙습니다'
 * - 칸 모양이 틀리면 그 칸을 말하며 거부하고, 모르는 칸은 경고한다
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { SEAT_EXTERNAL_LATER } from '../../src/main/orchestrator/seat';
import { adminRequest } from '../../src/server/admin';
import { formatConfig } from '../../src/server/cli';
import { createOperatorConfig, parseServerConfig, precheckServerConfig, type OperatorConfig, type ServerConfigView } from '../../src/server/config';
import { runServe } from '../../src/server/serve';
import { startServer, type RunningServer } from '../../src/server/server';
import { memoryLogger, remoteBackendOf, removeDir } from './helpers';

const dirs: string[] = [];
let h: Harness;
let server: RunningServer;
let config: OperatorConfig;
let configPath = '';
const log = memoryLogger();

beforeAll(async () => {
  h = await createHarness({ mode: 'server', noProject: true });
  configPath = join(h.dataDir, 'server.json');
  writeFileSync(configPath, '{}');
  const backend = remoteBackendOf(h);
  config = createOperatorConfig({ path: configPath, ownerEmailFlag: null, operator: backend.operator, logger: log });
  config.reload();
  // 관리 채널(config reload·show)은 서버가 연다
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test', operatorConfig: config });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
  for (const d of dirs) await removeDir(d);
});

const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-seatcfg-'));
  dirs.push(d);
  return d;
};
const operatorRows = () =>
  h.core.ctx.store.activity
    .search({ limit: 200 })
    .filter((e) => e.actor === OPERATOR)
    .map((e) => e.text);

/** 프로세스 안에서 서버를 띄운다 — 준비되면 관리 채널 shutdown으로 끝낸다. runServe가 붙인 프로세스 처리기는 뗀다 */
async function serveOnce(dataDir: string): Promise<{ code: number | null; stderr: string }> {
  const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'uncaughtException', 'unhandledRejection'];
  const before = new Map(events.map((e) => [e, process.listeners(e as NodeJS.Signals)]));
  const err: string[] = [];
  let exited!: (code: number) => void;
  const exit = new Promise<number>((r) => (exited = r));
  try {
    const code = await runServe(
      // 작업 폴더 위치는 데이터 폴더 옆 — 기본값(실제 사용자 폴더의 ~/wook-workspace)을 쓰지 않는다 (리드 결정 S5-20)
      { dataDir, bind: '127.0.0.1', port: 0, webDir: null, allowTestSession: false, workspaceRoot: `${dataDir}-ws` },
      { out: async () => undefined, err: async (t) => void err.push(t), exit: (c) => exited(c) },
    );
    if (code !== null) return { code, stderr: err.join('') };
    expect((await adminRequest({ dataDir, command: 'shutdown' })).ok).toBe(true);
    return { code: await exit, stderr: err.join('') };
  } finally {
    for (const e of events) for (const l of process.listeners(e as NodeJS.Signals)) if (!before.get(e)!.includes(l)) process.off(e, l);
  }
}

describe('server.json의 seat 읽기 (S4-12)', () => {
  it('칸마다 읽고, 모르는 칸은 경고하고, 모양이 틀리면 그 칸을 말하며 거부한다', () => {
    expect(parseServerConfig({ seat: { initialHolder: ' launched:codex ', holders: ['launched:claude', ' launched:codex'], drainMs: 5000, fallback: ['launched:claude'] } })).toMatchObject({
      config: { seat: { initialHolder: 'launched:codex', holders: ['launched:claude', 'launched:codex'], drainMs: 5000 } },
      warnings: ['모르는 칸 seat.fallback은(는) 쓰지 않습니다'],
    });
    expect(parseServerConfig({}).config.seat).toBeNull();
    for (const [bad, message] of [
      [{ seat: 'launched:codex' }, 'server.json의 seat은(는) 객체여야 합니다'],
      [{ seat: { holders: 'launched:codex' } }, 'server.json의 seat.holders는 글의 목록이어야 합니다'],
      [{ seat: { holders: [1] } }, 'server.json의 seat.holders는 글의 목록이어야 합니다'],
      [{ seat: { drainMs: '120000' } }, 'server.json의 seat.drainMs는 숫자(밀리초)여야 합니다'],
      [{ seat: { initialHolder: 3 } }, 'server.json의 seat.initialHolder은(는) 글이어야 합니다'],
    ] as const) {
      expect(() => parseServerConfig(bad), message).toThrow(message);
    }
  });

  it('외부 보유자를 처음 보유자로 둔 server.json은 시작 전에 거부한다 — 실행 잠금·저장소를 만들지 않는다 (S4-1)', async () => {
    const dir = newDir();
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ seat: { initialHolder: 'external:X-0001' } }));
    expect(precheckServerConfig(join(dir, 'server.json'), { ownerEmail: null })).toEqual({
      ok: false,
      message: `server.json의 seat.initialHolder(external:X-0001) — ${SEAT_EXTERNAL_LATER}. 지금은 launched:claude나 launched:codex를 넣으세요`,
    });
    const r = await serveOnce(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(SEAT_EXTERNAL_LATER);
    expect([existsSync(join(dir, 'server.lock')), existsSync(join(dir, 'wook.db'))]).toEqual([false, false]);
  });

  it('새 DB로 서버를 띄우면 server.json의 처음 보유자가 앉고 자리 정책도 그 값이다', async () => {
    const dir = newDir();
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ seat: { initialHolder: 'launched:codex', holders: ['launched:claude', 'launched:codex'], drainMs: 45_000 } }));
    const r = await serveOnce(dir);
    expect(r.code, r.stderr).toBe(0);
    const store = openStore(dataPaths(dir).db);
    try {
      const seat = store.seat.get('main')!;
      expect([seat.generation, seat.state, seat.holder]).toEqual([1, 'active', { kind: 'launched', ai: expect.objectContaining({ kind: 'codex' }) }]);
      expect(store.seatHistory.list().map((x) => [x.changedBy, x.startReason])).toEqual([['server', '처음 보유자 — 운영자 설정 seat.initialHolder(launched:codex)']]);
      expect(store.kv.get('seat.policy')).toEqual({ holders: ['launched:claude', 'launched:codex'], drainMs: 45_000 });
    } finally {
      store.close();
    }
  }, 120_000);
});

describe('config reload의 메인 자리 정책 (S4-12)', () => {
  it('보유자·마무리 시간이 바뀌면 바뀐 것과 활동 기록(operator)으로 말하고, 같으면 아무것도 바꾸지 않는다 — 처음 보유자는 앉은 자리를 바꾸지 않는다', async () => {
    writeFileSync(configPath, JSON.stringify({ seat: { holders: ['launched:claude'], drainMs: 30_000, initialHolder: 'launched:claude' } }));
    const r = await adminRequest({ dataDir: h.dataDir, command: 'config.reload' });
    expect(r).toEqual({
      ok: true,
      result: {
        changes: [
          { item: 'seat.holders', text: '메인 자리에 앉을 수 있는 보유자 → launched:claude' },
          { item: 'seat.drainMs', text: '교체 때 마무리를 기다리는 시간 → 30초' },
        ],
        warnings: [],
      },
    });
    expect(operatorRows().slice(0, 2).reverse()).toEqual([
      'server.json: 메인 자리에 앉을 수 있는 보유자를 바꿈 (launched:claude, launched:codex, external:* → launched:claude)',
      'server.json: 메인 자리 교체 때 마무리를 기다리는 시간을 바꿈 (120초 → 30초)',
    ]);
    expect(h.core.seat.policy()).toEqual({ holders: ['launched:claude'], drainMs: 30_000 });
    expect(h.core.seat.view()).toMatchObject({ generation: 1, holder: { label: 'Claude CLI' } });
    // 같은 값이면 바꾼 것이 없다
    expect(await adminRequest({ dataDir: h.dataDir, command: 'config.reload' })).toEqual({ ok: true, result: { changes: [], warnings: [] } });
    // config show가 지금 정책과 파일의 처음 보유자를 말한다
    const shown = (await adminRequest({ dataDir: h.dataDir, command: 'config.show' })) as { ok: true; result: ServerConfigView };
    expect([shown.result.seat, shown.result.initialHolder]).toEqual([{ holders: ['launched:claude'], drainMs: 30_000 }, 'launched:claude']);
    expect(formatConfig(shown.result)).toContain('  메인 자리       앉을 수 있는 보유자 launched:claude · 교체 때 마무리 기다림 30초 · 처음 보유자 launched:claude(빈 자리일 때만)');
  });

  it('틀린 seat 값은 아무것도 바꾸지 않고 거부한다 — 외부 처음 보유자·모르는 보유자·범위 밖 마무리 시간', async () => {
    const before = operatorRows().length;
    for (const [seat, message] of [
      [{ initialHolder: 'external:X-0001' }, `server.json의 seat.initialHolder(external:X-0001) — ${SEAT_EXTERNAL_LATER}. 지금은 launched:claude나 launched:codex를 넣으세요`],
      [{ holders: ['launched:gpt'] }, 'server.json의 seat.holders에 모르는 보유자가 있습니다 — launched:claude·launched:codex·external:*·external:<ID>만 씁니다'],
      [{ drainMs: -5 }, 'server.json의 seat.drainMs는 0~3600000의 정수(밀리초)여야 합니다'],
    ] as const) {
      writeFileSync(configPath, JSON.stringify({ seat }));
      expect(await adminRequest({ dataDir: h.dataDir, command: 'config.reload' })).toEqual({ ok: false, error: { code: 'invalid', message } });
    }
    expect(operatorRows()).toHaveLength(before);
    expect(h.core.seat.policy()).toEqual({ holders: ['launched:claude'], drainMs: 30_000 });
    expect(config.show().warnings).toEqual([]);
  });
});
