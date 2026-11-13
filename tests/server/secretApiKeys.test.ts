/**
 * secretApiKeys (리드 결정 S9-6·S9-11): 운영자 `wook-server secret set|clear claude-api-key|codex-api-key`.
 * 길: 표준 입력 → 관리 채널(서로 증명) → OS 보안 저장소(데스크톱과 같은 계정 api-key-claude·api-key-codex) → 상태 확인용 메모리 사본(ApiKeyCache) → 백엔드 가리개 →
 * 활동 기록(operator) → 그 AI가 API 키 방식이면 CLI 다시 확인. config show는 등록 여부와 인증 방식만 말한다.
 * - 프로세스 안(서버 모드 하네스 — 비밀 값은 메모리): 저장소·사본·가리개·다시 확인(가짜 detect)·지우기·거부, 값은 답·서버 기록·활동 기록 어디에도 없다
 * - 빌드한 서버(가짜 키링 미리 불러오기 — 실제 OS 보안 저장소는 건드리지 않는다): 표준 입력으로 넣고, 다시 시작해도 남고(키링 → 사본), 지우면 없다.
 *   명령 줄에 붙인 값은 되풀이하지 않는다. 메인 턴은 모두 모의다
 * 값은 형식 규칙(sk-ant- 등)에 걸리지 않는 꼴이다 — 가려졌다면 등록 값으로 가린 것이다. 값은 시험 출력에 내지 않는다(참거짓으로만 본다)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest, type AdminReply } from '../../src/server/admin';
import { formatConfig, formatSecretResult, SECRET_USAGE, secretPlace } from '../../src/server/cli';
import { storedSecrets } from './storedSecrets';
import type { ServerConfigView } from '../../src/server/config';
import { startServer, type RunningServer } from '../../src/server/server';
import type { ApiKeyReport } from '../../src/main/backend/types';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { buildServerTo, childEnv, memoryLogger, REPO, remoteBackendOf, removeDir, runClient, sleep, startBuilt, testBuildDir, type BuiltServer } from './helpers';

/** 형식 규칙에 걸리지 않는 시험 값 (진짜 키가 아니다) */
const KEY_CLAUDE = 'S9bClaudeStandin7f3aQ2w9e8r7t6y5u4';
const KEY_CODEX = 'S9bCodexStandin1z2x3c4v5b6n7m8q9w0';
const KEY_ARGV = 'S9bArgvStandin0p9o8i7u6y5t4r3e2w1q';
const KEYS = [KEY_CLAUDE, KEY_CODEX, KEY_ARGV];
/** 늦춘 시험 (리드 결정 S9-18 — 한 번): 가짜 CLI 확인이 이만큼 늦게 답하고, 빌드한 서버 쪽은 단계마다 이만큼 쉰다 */
const DELAY = Number(process.env['WOOK_TEST_FAKE_DELAY_MS'] ?? '0');
const carries = (text: string): boolean => KEYS.some((k) => text.includes(k));

describe('프로세스 안 (서버 모드 하네스)', () => {
  let h: Harness;
  let server: RunningServer;
  const log = memoryLogger();
  const replies: string[] = [];

  beforeAll(async () => {
    h = await createHarness({ mode: 'server', noProject: true });
    server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test' });
    // 시작 때의 CLI 확인(오케스트레이터가 기다리지 않고 돌린다)이 끝난 뒤에 본다 — 다시 확인을 세는 가짜 detect가 그 확인을 함께 세지 않게 (늦춘 시험에서 찾음)
    await h.waitFor(() => h.core.ctx.ai('claude').checkedAt !== null && h.core.ctx.ai('codex').checkedAt !== null, { timeoutMs: 90_000, label: '시작 때의 CLI 확인이 끝남' });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    await h?.close();
  });

  async function admin(command: 'secret.set' | 'secret.clear' | 'config.show', args?: string[], secret?: string): Promise<AdminReply> {
    const r = await adminRequest({ dataDir: h.dataDir, command, ...(args ? { args } : {}), ...(secret !== undefined ? { secret } : {}) });
    replies.push(JSON.stringify(r));
    return r;
  }
  const operatorRows = () => h.core.ctx.store.activity.search({ limit: 500 }).filter((e) => e.actor === OPERATOR).map((e) => e.text);

  it('구독 방식: 저장소 → 메모리 사본 → 가리개 → 활동 기록. 다시 확인은 하지 않는다(그 키는 쓰이지 않는다)', async () => {
    const detect = vi.spyOn(h.core.ctx.deps.adapters.claude, 'detect');
    const r = await admin('secret.set', ['claude-api-key'], `  ${KEY_CLAUDE}\n`);
    expect(r).toEqual({ ok: true, result: { name: 'claude-api-key', stored: true, apiKey: { kind: 'claude', registered: true, authMode: 'subscription', recheck: null } } });
    expect([(await h.core.ctx.deps.secrets.get('api-key-claude')) === KEY_CLAUDE, h.core.ctx.deps.apiKeys!.get('claude') === KEY_CLAUDE]).toEqual([true, true]);
    // 데스크톱 앱과 같은 계정이다 — 다른 AI의 자리는 그대로
    expect(await h.core.ctx.deps.secrets.get('api-key-codex')).toBeNull();
    expect(h.core.ctx.redact.text(`앞 ${KEY_CLAUDE} 뒤`).includes(KEY_CLAUDE)).toBe(false);
    expect(operatorRows()[0]).toBe('claude API 키 등록');
    expect(detect).not.toHaveBeenCalled();
    detect.mockRestore();
    expect(formatSecretResult(true, (r as { result: { apiKey: ApiKeyReport } }).result)).toBe(
      `Claude API 키를 ${secretPlace()}에 넣었습니다 (값은 다시 보여 주지 않습니다 — 데스크톱 앱과 같은 자리입니다). Claude는 지금 구독 방식이라 이 키를 쓰지 않습니다 — 쓰려면 메인 에이전트가 account.authMode를 api_key로 바꿉니다.\n`,
    );
  });

  it('API 키 방식: 넣은 뒤 CLI를 다시 확인한다 — 사본의 키로 재로그인 필요를 푼다', async () => {
    await h.internal('settings.update', { account: { authMode: { claude: 'subscription', codex: 'api_key' } } } as never);
    h.core.ctx.saveAi({ ...h.core.ctx.ai('codex'), authRequired: true, authRequiredSince: h.core.ctx.now() });
    const detect = vi.spyOn(h.core.ctx.deps.adapters.codex, 'detect').mockImplementation(async () => {
      if (DELAY) await sleep(DELAY);
      return { installed: true, path: 'C:\\가짜\\codex.exe', version: '0.163.0', loggedIn: false, problem: null, detail: '가짜 codex 확인' };
    });
    const r = await admin('secret.set', ['codex-api-key'], KEY_CODEX);
    expect(r).toEqual({ ok: true, result: { name: 'codex-api-key', stored: true, apiKey: { kind: 'codex', registered: true, authMode: 'api_key', recheck: { authRequired: false, detail: 'codex CLI 0.163.0' } } } });
    expect(detect).toHaveBeenCalledTimes(1);
    detect.mockRestore();
    expect(h.core.ctx.ai('codex').authRequired).toBe(false);
    expect(operatorRows().slice(0, 3)).toEqual([
      'codex CLI 다시 확인: 가짜 codex 확인 (API 키 방식 — 등록된 키가 맞는지는 다음 턴에서 확인하므로 재로그인 필요로 막지 않음)',
      'codex API 키를 새로 등록해 재로그인 필요를 풂 (API 키 방식 — 키가 맞는지는 다음 턴에서 확인)',
      'codex API 키 등록',
    ]);
    expect(formatSecretResult(true, (r as { result: { apiKey: ApiKeyReport } }).result)).toContain('Codex는 API 키 방식이라 CLI를 다시 확인했습니다: 턴을 띄울 수 있습니다 (codex CLI 0.163.0).');
  });

  it('config show는 등록 여부와 인증 방식만 — 값은 없다', async () => {
    const r = (await admin('config.show')) as { ok: true; result: ServerConfigView };
    expect(r.result.apiKeys).toEqual({ claude: { registered: true, authMode: 'subscription' }, codex: { registered: true, authMode: 'api_key' } });
    const lines = formatConfig(r.result).split('\n');
    expect(lines.filter((l) => l.includes('API 키   ') || l.includes('API 키    '))).toEqual([
      `  Claude API 키   등록됨 (${secretPlace()}) · 구독 방식 — 이 키는 쓰지 않습니다(메인 에이전트가 account.authMode로 바꿉니다)`,
      `  Codex API 키    등록됨 (${secretPlace()}) · API 키 방식 — 턴이 이 키를 씁니다`,
    ]);
  });

  it('clear는 저장소와 사본에서 지운다 — 다시 넣기 전까지 등록 안 됨', async () => {
    const r = await admin('secret.clear', ['claude-api-key']);
    expect(r).toEqual({ ok: true, result: { name: 'claude-api-key', cleared: true, apiKey: { kind: 'claude', registered: false, authMode: 'subscription', recheck: null } } });
    expect([await h.core.ctx.deps.secrets.get('api-key-claude'), h.core.ctx.deps.apiKeys!.get('claude')]).toEqual([null, null]);
    expect(operatorRows()[0]).toBe('claude API 키 삭제');
    expect(((await admin('config.show')) as { result: ServerConfigView }).result.apiKeys!.claude).toEqual({ registered: false, authMode: 'subscription' });
    expect(formatSecretResult(false, (r as { result: { apiKey: ApiKeyReport } }).result)).toBe('Claude API 키를 지웠습니다. Claude는 지금 구독 방식이라 이 키를 쓰지 않습니다 — 쓰려면 메인 에이전트가 account.authMode를 api_key로 바꿉니다.\n');
  });

  it('비었거나 제어 문자가 든 값, 모르는 이름은 거부한다 — 그 글은 값을 되풀이하지 않는다', async () => {
    const empty = await admin('secret.set', ['claude-api-key'], '   ');
    const ctl = await admin('secret.set', ['claude-api-key'], `${KEY_ARGV}\u0001x`);
    const name = await admin('secret.set', ['api-key-claude'], KEY_ARGV);
    expect([empty, ctl, name].map((r) => (r.ok ? 'ok' : r.error.code))).toEqual(['invalid', 'invalid', 'invalid_args']);
    expect(carries(JSON.stringify(ctl))).toBe(false);
    expect(await h.core.ctx.deps.secrets.get('api-key-claude')).toBeNull();
  });

  it('값은 관리 채널의 답·서버 기록·활동 기록 어디에도 없다', () => {
    const texts = [...replies, ...log.lines, ...h.core.ctx.store.activity.search({ limit: 1000 }).map((e) => `${e.text} ${e.result ?? ''}`)].join('\n');
    expect(carries(texts)).toBe(false);
  });
});

// Linux의 서버는 키링을 쓰지 않고 시험의 임시 데이터 폴더 안 파일 저장소에 쓴다 (리드 결정 S10-6.1) — storedSecrets가 어느 쪽이든 읽는다
describe('빌드한 서버 (가짜 키링, Linux는 임시 데이터 폴더의 파일 저장소 — 실제 OS 보안 저장소는 건드리지 않는다)', () => {
  const PRELOAD = join(REPO, 'tests', 'server', 'fakeGooglePreload.cjs');
  let buildDir = '';
  let entry = '';
  let dataDir = '';
  let keyringFile = '';
  let srv: BuiltServer | null = null;
  const dirs: string[] = [];
  const outputs: string[] = [];

  const env = () => ({ WOOK_TEST_KEYRING_FILE: keyringFile, WOOK_TEST_FAKE_GOOGLE_URL: 'http://127.0.0.1:9' });
  const start = async (): Promise<BuiltServer> => (srv = await startBuilt({ entry, dataDir, nodeArgs: ['--require', PRELOAD], env: env() }));
  const stop = async (): Promise<void> => {
    if (!srv || srv.child.exitCode !== null) return;
    const r = runClient(entry, ['shutdown', '--data-dir', dataDir]);
    outputs.push(r.stdout, r.stderr);
    await Promise.race([srv.exited, sleep(45_000)]);
    if (srv.child.exitCode === null && srv.child.signalCode === null) srv.child.kill();
  };
  const keyring = (): Record<string, string> => storedSecrets({ keyringFile, dataDir });
  const cli = (args: string[], input?: string): { code: number | null; out: string; err: string } => {
    // 늦춘 시험: 명령 사이를 비운다 (Atomics.wait — 이 함수는 동기라서)
    if (DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY);
    const r = spawnSync(process.execPath, [entry, ...args, '--data-dir', dataDir], { cwd: REPO, env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 120_000, ...(input !== undefined ? { input } : {}) });
    outputs.push(r.stdout ?? '', r.stderr ?? '');
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  beforeAll(async () => {
    buildDir = testBuildDir('apikeys');
    entry = buildServerTo(buildDir);
    // 모의 메인으로 데이터 폴더를 준비한다 — 빌드한 서버가 이 PC의 실제 Claude·Codex CLI 턴을 띄우지 않게 (리드 결정 S6-19)
    const h = await createHarness({ noProject: true });
    dataDir = h.dataDir;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    const k = mkdtempSync(join(tmpdir(), 'wook-test-apikeys-keyring-'));
    dirs.push(k);
    keyringFile = join(k, 'keyring.json');
    await start();
  }, 300_000);

  afterAll(async () => {
    await stop();
    for (const d of dirs) await removeDir(d);
    if (buildDir) await removeDir(buildDir);
  }, 120_000);

  it('표준 입력 → 키링(데스크톱과 같은 계정) — 답은 값을 되풀이하지 않고, config show는 등록됨', () => {
    const r = cli(['secret', 'set', 'claude-api-key'], `${KEY_CLAUDE}\n`);
    expect([r.code, r.out.startsWith(`Claude API 키를 ${secretPlace()}에 넣었습니다`), carries(r.out + r.err)]).toEqual([0, true, false]);
    expect(keyring()['wookagent\u0000api-key-claude'] === KEY_CLAUDE).toBe(true);
    const shown = cli(['config', 'show']);
    expect(shown.out).toContain(`  Claude API 키   등록됨 (${secretPlace()}) · 구독 방식`);
    const json = cli(['config', 'show', '--json']);
    expect([/^[\x20-\x7e]*\n$/.test(json.out), carries(json.out)]).toEqual([true, false]);
  });

  it('명령 줄에 붙인 값·모르는 이름은 서버에 붙지 않고 쓰임새 오류(2) — 값을 되풀이하지 않는다', () => {
    for (const args of [
      ['secret', 'set', 'claude-api-key', KEY_ARGV],
      ['secret', 'set', 'api-key-claude'],
      ['config', 'claude-api-key', KEY_ARGV],
    ]) {
      const r = cli(args, '');
      expect([args[2], r.code, r.err.startsWith(`${SECRET_USAGE}\n`), carries(r.out + r.err)]).toEqual([args[2], 2, true, false]);
    }
    expect(Object.values(keyring()).some((v) => v === KEY_ARGV)).toBe(false);
  });

  it('서버를 다시 시작해도 남는다 — 시작 때 키링에서 사본을 채운다. clear는 키링에서 지운다', async () => {
    await stop();
    await start();
    expect(cli(['config', 'show']).out).toContain(`  Claude API 키   등록됨 (${secretPlace()})`);
    const r = cli(['secret', 'clear', 'claude-api-key']);
    expect([r.code, r.out]).toEqual([0, 'Claude API 키를 지웠습니다. Claude는 지금 구독 방식이라 이 키를 쓰지 않습니다 — 쓰려면 메인 에이전트가 account.authMode를 api_key로 바꿉니다.\n']);
    expect(Object.hasOwn(keyring(), 'wookagent\u0000api-key-claude')).toBe(false);
    expect(cli(['config', 'show']).out).toContain('  Claude API 키   없음 · 구독 방식');
  }, 240_000);

  it('끝난 뒤: 값은 명령 출력·server.log·DB 어디에도 없고, 운영자 기록이 남았으며, 메인 턴은 모두 모의다', async () => {
    await stop();
    expect(carries(outputs.join('\n'))).toBe(false);
    expect(carries(readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8'))).toBe(false);
    expect(carries(readFileSync(join(dataDir, 'logs', 'backend.log'), 'utf8'))).toBe(false);
    const store = openStore(dataPaths(dataDir).db);
    try {
      const rows = store.activity.search({ limit: 1000 });
      expect(carries(rows.map((e) => `${e.text} ${e.result ?? ''}`).join('\n'))).toBe(false);
      expect(rows.filter((e) => e.actor === OPERATOR && /^claude API 키 (등록|삭제)$/.test(e.text)).map((e) => e.text)).toEqual(['claude API 키 삭제', 'claude API 키 등록']);
      expect(store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock)).toEqual([]);
    } finally {
      store.close();
    }
  }, 120_000);
});
