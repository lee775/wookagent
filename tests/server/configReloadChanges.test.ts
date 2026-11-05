/**
 * 운영자 설정을 다시 읽으면 적용한 것을 모두 말한다 (SERVER_DESIGN 3.7, 리드 결정 S3-19 — 검토 프로브 zz-s3fl-inproc P2를 옮김), 깨진 server.json은 파일
 * 내용을 옮기지 않는다 (S3-26 — 프로브 zz-s3sec-configecho를 옮김). 서버 모드 하네스(실제 백엔드) + 운영자 설정 + 프로세스 안 서버.
 * - 공개 주소(network.publicOrigin)와 받는 Tailscale 사용자(owner.tailscaleLogins)도 앞서 쓰던 값과 견준다: 바뀐 것마다 답의 바뀐 것·활동 기록(operator)·서버
 *   기록 한 줄. Tailscale 사용자는 켬·끔·수만 말하고 주소는 말하지 않는다. 파일을 지우면 파일이 주던 값은 꺼진 것이다. 서버를 다시 시작해도 앞서 쓰던
 *   값과 견준다(kv server.access)
 * - --owner-email·--public-origin이 덮는 파일 값은 쓰지 않는다고 답과 시작 기록에 말한다
 * - 깨진 JSON은 줄·글자 자리만 말한다 — 관리 채널 답, 서버 기록, 서버 시작의 stderr 어디에도 파일 조각이 없다
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest } from '../../src/server/admin';
import { formatConfigResult } from '../../src/server/cli';
import { createOperatorConfig, jsonErrorOffset, readServerConfig, type OperatorConfig, type OperatorConfigResult } from '../../src/server/config';
import { runServe } from '../../src/server/serve';
import { startServer, type RunningServer } from '../../src/server/server';
import { httpCall, memoryLogger, remoteBackendOf, removeDir } from './helpers';

let h: Harness;
let server: RunningServer;
let config: OperatorConfig;
let configPath: string;
const log = memoryLogger();
const dirs: string[] = [];

/** 시험의 Tailscale 사용자 — 주소가 어디에도 남지 않는지 본다 (대표 이메일과 다르게) */
const PHONE = 'phone-user@tailnet-test';
const LAPTOP = 'laptop-user@tailnet-test';
const TABLET = 'tablet-user@tailnet-test';

beforeAll(async () => {
  h = await createHarness({ mode: 'server', noProject: true });
  const backend = remoteBackendOf(h);
  configPath = join(h.dataDir, 'server.json');
  writeFileSync(configPath, '{}');
  config = createOperatorConfig({ path: configPath, ownerEmailFlag: null, operator: backend.operator, logger: log });
  config.reload();
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test', operatorConfig: config });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
  for (const d of dirs) await removeDir(d);
});

const write = (v: unknown) => writeFileSync(configPath, typeof v === 'string' ? v : JSON.stringify(v));
const reload = async (): Promise<OperatorConfigResult> => {
  const r = await adminRequest({ dataDir: h.dataDir, command: 'config.reload' });
  expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
  return (r as { result: OperatorConfigResult }).result;
};
const operatorRows = () =>
  h.core.ctx.store.activity
    .search({ limit: 1000 })
    .filter((e) => e.actor === OPERATOR)
    .map((e) => e.text);
const getState = (headers: Record<string, string>) =>
  httpCall({ url: server.url, path: '/api/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ id: `c-${Math.random()}`, method: 'auth.getState', args: [] }) });

describe('config reload가 접속 허용의 바뀐 것을 말한다 (S3-19)', () => {
  it('받는 Tailscale 사용자를 켜고·늘리고·바꾸고·끄면 그때마다 바뀐 것이다 — 답·운영자 명령의 글·서버 기록·활동 기록, 주소는 어디에도 없다', async () => {
    const before = log.lines.length;
    write({ owner: { tailscaleLogins: [PHONE] } });
    const on = await reload();
    expect(on).toEqual({ changes: [{ item: 'owner.tailscaleLogins', text: '받는 Tailscale 사용자 → 켬 (1명)' }], warnings: [] });
    const shown = formatConfigResult(on, '운영자 설정을 다시 읽었습니다');
    expect(shown).toBe('운영자 설정을 다시 읽었습니다: 바꾼 것 1개\n  - 받는 Tailscale 사용자 → 켬 (1명)\n');
    // 정책이 바뀐 것이 맞다 — 머리 없는 요청은 이제 403
    const refused = await getState({});
    expect([refused.status, (refused.json() as { error: { code: string } }).error.code]).toEqual([403, 'forbidden_tailscale_user']);
    expect((await getState({ 'Tailscale-User-Login': PHONE })).status).toBe(200);
    write({ owner: { tailscaleLogins: [PHONE, LAPTOP] } });
    expect((await reload()).changes).toEqual([{ item: 'owner.tailscaleLogins', text: '받는 Tailscale 사용자 → 2명 (앞 1명)' }]);
    write({ owner: { tailscaleLogins: [PHONE, TABLET] } });
    expect((await reload()).changes).toEqual([{ item: 'owner.tailscaleLogins', text: '받는 Tailscale 사용자 → 목록이 바뀜 (2명)' }]);
    // 차례·대소문자만 다른 것은 같은 목록이다 (HTTP 검사도 대소문자를 가리지 않는다)
    write({ owner: { tailscaleLogins: [TABLET.toUpperCase(), PHONE] } });
    expect(await reload()).toEqual({ changes: [], warnings: [] });
    write({ owner: { tailscaleLogins: [] } });
    expect((await reload()).changes).toEqual([{ item: 'owner.tailscaleLogins', text: '받는 Tailscale 사용자 → 끔 (Tailscale-User-Login 머리를 보지 않습니다)' }]);
    expect((await getState({})).status).toBe(200);
    const lines = log.lines.slice(before);
    expect(lines.filter((l) => l.includes('운영자 설정 바뀜 (owner.tailscaleLogins)'))).toHaveLength(4);
    expect(lines.some((l) => l.includes('운영자 설정(') && l.includes('바꾼 것 1개: owner.tailscaleLogins'))).toBe(true);
    expect(operatorRows().slice(0, 4).reverse()).toEqual([
      'server.json: 받는 Tailscale 사용자 검사를 켬 (1명)',
      'server.json: 받는 Tailscale 사용자 목록을 바꿈 (1명 → 2명)',
      'server.json: 받는 Tailscale 사용자 목록을 바꿈 (2명, 수는 같음)',
      'server.json: 받는 Tailscale 사용자 검사를 끔',
    ]);
    const everywhere = [...lines, ...operatorRows(), JSON.stringify(h.core.ctx.store.kv.get('server.access'))].join('\n').toLowerCase();
    expect([PHONE, LAPTOP, TABLET].filter((u) => everywhere.includes(u))).toEqual([]);
  });

  it('공개 주소를 정하고·바꾸고·없애면 그때마다 바뀐 것이다 — 새 Host를 바로 받는다', async () => {
    const host = (name: string) => getState({ Host: name });
    expect((await host('grok-pc.tailnet-test.ts.net')).status).toBe(403);
    write({ network: { publicOrigin: 'https://grok-pc.tailnet-test.ts.net' } });
    const set = await reload();
    expect(set.changes).toEqual([{ item: 'network.publicOrigin', text: '공개 주소 → https://grok-pc.tailnet-test.ts.net' }]);
    expect(formatConfigResult(set, '운영자 설정을 다시 읽었습니다')).not.toContain('바뀐 것이 없습니다');
    expect((await host('grok-pc.tailnet-test.ts.net')).status).toBe(200);
    write({ network: { publicOrigin: 'https://new-pc.tailnet-test.ts.net' } });
    expect((await reload()).changes).toEqual([{ item: 'network.publicOrigin', text: '공개 주소 → https://new-pc.tailnet-test.ts.net' }]);
    write({});
    expect((await reload()).changes).toEqual([{ item: 'network.publicOrigin', text: '공개 주소 → 없음 (이 PC 안에서만 받습니다)' }]);
    expect((await host('new-pc.tailnet-test.ts.net')).status).toBe(403);
    expect(operatorRows().slice(0, 3).reverse()).toEqual([
      'server.json: 공개 주소를 바꿈 (없음 → https://grok-pc.tailnet-test.ts.net)',
      'server.json: 공개 주소를 바꿈 (https://grok-pc.tailnet-test.ts.net → https://new-pc.tailnet-test.ts.net)',
      'server.json: 공개 주소를 없앰 (https://new-pc.tailnet-test.ts.net) — 이 PC 안(루프백)에서만 받습니다',
    ]);
  });

  it('server.json을 지우면 파일이 주던 값은 모두 꺼진 것으로 말한다 — DB에 들어간 대표 이메일은 그대로라 바뀐 것이 아니다', async () => {
    write({ owner: { email: 'owner@example.com', tailscaleLogins: [PHONE] }, network: { publicOrigin: 'https://grok-pc.tailnet-test.ts.net' } });
    expect((await reload()).changes.map((c) => c.item)).toEqual(['owner.email', 'network.publicOrigin', 'owner.tailscaleLogins']);
    rmSync(configPath);
    const gone = await reload();
    expect(gone).toEqual({
      changes: [
        { item: 'network.publicOrigin', text: '공개 주소 → 없음 (이 PC 안에서만 받습니다)' },
        { item: 'owner.tailscaleLogins', text: '받는 Tailscale 사용자 → 끔 (Tailscale-User-Login 머리를 보지 않습니다)' },
      ],
      warnings: [],
    });
    expect(h.core.serverLogin.ownerEmail()).toBe('owner@example.com');
    expect(operatorRows().slice(0, 2).reverse()).toEqual([
      'server.json(파일 없음): 공개 주소를 없앰 (https://grok-pc.tailnet-test.ts.net) — 이 PC 안(루프백)에서만 받습니다',
      'server.json(파일 없음): 받는 Tailscale 사용자 검사를 끔',
    ]);
    expect(log.lines.some((l) => l.includes('운영자 설정(파일 없음)을 읽었습니다 — 바꾼 것 2개: network.publicOrigin, owner.tailscaleLogins'))).toBe(true);
  });

  it('서버를 다시 시작해도 앞서 쓰던 값과 견준다 — 그대로면 바뀐 것이 없고, 꺼져 있는 동안 고친 것은 시작 때 말한다', async () => {
    write({ owner: { email: 'owner@example.com', tailscaleLogins: [PHONE] } });
    expect((await reload()).changes.map((c) => c.item)).toEqual(['owner.tailscaleLogins']);
    // 다시 시작한 서버의 운영자 설정 (메모리는 새것, 백엔드 DB는 그대로)
    const restarted = () => createOperatorConfig({ path: configPath, ownerEmailFlag: null, operator: remoteBackendOf(h).operator, logger: memoryLogger() });
    expect(restarted().reload()).toEqual({ changes: [], warnings: [] });
    write({ owner: { email: 'owner@example.com', tailscaleLogins: [PHONE, LAPTOP] }, network: { publicOrigin: 'https://grok-pc.tailnet-test.ts.net' } });
    expect(restarted().reload().changes.map((c) => c.text)).toEqual(['공개 주소 → https://grok-pc.tailnet-test.ts.net', '받는 Tailscale 사용자 → 2명 (앞 1명)']);
  });

  it('명령 줄 인자가 덮는 파일 값은 쓰지 않는다고 답과 시작 기록에 말한다 — 파일의 공개 주소를 바꿔도 바뀐 것이 아니다', () => {
    write({ owner: { email: 'file-owner@example.com', tailscaleLogins: [PHONE, LAPTOP] }, network: { publicOrigin: 'https://file-pc.tailnet-test.ts.net' } });
    const startLog = memoryLogger();
    const flagged = createOperatorConfig({
      path: configPath,
      ownerEmailFlag: 'flag-owner@example.com',
      publicOriginFlag: 'https://flag-pc.tailnet-test.ts.net',
      operator: remoteBackendOf(h).operator,
      logger: startLog,
    });
    const IGNORED = [
      'server.json의 owner.email은 쓰지 않습니다 — 서버를 --owner-email로 시작해 그 인자의 대표 이메일이 먼저입니다',
      'server.json의 network.publicOrigin은 쓰지 않습니다 — 서버를 --public-origin으로 시작해 그 인자의 공개 주소가 먼저입니다',
    ];
    const first = flagged.reload();
    expect(first.warnings).toEqual(IGNORED);
    expect(first.changes.map((c) => c.text)).toEqual(['대표 이메일 → flag-owner@example.com', '공개 주소 → https://flag-pc.tailnet-test.ts.net']);
    expect(operatorRows()[0]).toBe('--public-origin: 공개 주소를 바꿈 (https://grok-pc.tailnet-test.ts.net → https://flag-pc.tailnet-test.ts.net)');
    expect(startLog.lines.filter((l) => IGNORED.some((w) => l.includes(w)))).toHaveLength(2);
    write({ owner: { email: 'file-owner@example.com', tailscaleLogins: [PHONE, LAPTOP] }, network: { publicOrigin: 'https://other-pc.tailnet-test.ts.net' } });
    const again = flagged.reload();
    expect(again).toEqual({ changes: [], warnings: IGNORED });
    expect(formatConfigResult(again, '운영자 설정을 다시 읽었습니다')).toBe(`운영자 설정을 다시 읽었습니다: 바뀐 것이 없습니다\n${IGNORED.map((w) => `경고: ${w}`).join('\n')}\n`);
    expect(flagged.show().warnings).toEqual(IGNORED);
  });
});

describe('깨진 server.json은 자리만 말한다 (S3-26)', () => {
  // 비밀 값처럼 생긴 글을 따옴표 없이 붙여 넣은 실수 — 정해진 가리기 규칙이 없는 값
  const SECRET = 'zq7Kp2Wm9Xr4Tn8Vb3Lc';
  const BROKEN = `{\n  "owner": { "email": "owner@example.com" },\n  "google": { "clientSecret": ${SECRET} }\n}\n`;

  it('틀린 자리는 줄과 글자(1부터)로 — 글이 중간에 끝나면 그렇다고, 맞는 JSON에는 자리가 없다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-cfg-pos-'));
    dirs.push(dir);
    const file = join(dir, 'server.json');
    writeFileSync(file, BROKEN);
    const r = readServerConfig(file);
    const column = BROKEN.split('\n')[2]!.indexOf(SECRET) + 1;
    expect(r).toEqual({ ok: false, message: `운영자 설정 파일(${file})이 JSON이 아닙니다: 3번째 줄 ${column}번째 글자 근처를 확인하세요 (글은 따옴표로 감싸야 합니다)` });
    writeFileSync(file, '{ "owner": ');
    expect(readServerConfig(file)).toEqual({ ok: false, message: `운영자 설정 파일(${file})이 JSON이 아닙니다: 1번째 줄 12번째 글자에서 글이 끝났습니다 — 닫는 괄호나 따옴표가 빠졌는지 확인하세요` });
    // JSON.parse와 같은 판단 — 맞는 글을 한 글자씩 망가뜨려 견준다
    const valid = JSON.stringify({ owner: { email: 'a@b.co', tailscaleLogins: ['x', 'y'] }, network: { port: 7317, publicOrigin: null }, n: -1.5e3, t: true, s: 'a\\"é' });
    const disagree: string[] = [];
    for (let i = 0; i < valid.length; i++) {
      for (const c of ['x', '}', ',', '"', ' ', '\\']) {
        const text = valid.slice(0, i) + c + valid.slice(i + 1);
        let parses = true;
        try {
          JSON.parse(text);
        } catch {
          parses = false;
        }
        const at = jsonErrorOffset(text);
        if (parses !== (at === null)) disagree.push(`${i}:${c}`);
      }
    }
    expect(disagree).toEqual([]);
  });

  it('config reload의 관리 채널 답과 서버 기록에 파일 조각이 없다 — 아무것도 바꾸지 않는다', async () => {
    write(BROKEN);
    const before = log.lines.length;
    const reply = await adminRequest({ dataDir: h.dataDir, command: 'config.reload' });
    const fragment = SECRET.slice(0, 6);
    expect({ ok: reply.ok, replyHasFragment: JSON.stringify(reply).includes(fragment), logHasFragment: log.lines.slice(before).join('\n').includes(fragment) }).toEqual({
      ok: false,
      replyHasFragment: false,
      logHasFragment: false,
    });
    expect((reply as { error: { message: string } }).error.message).toMatch(/이 JSON이 아닙니다: 3번째 줄 \d+번째 글자 근처를 확인하세요 .+ — 아무것도 바꾸지 않았습니다$/);
    write({});
  });

  it('서버 시작은 stderr와 server.log에 자리만 남기고 1로 끝난다 — 잠금·저장소를 만들기 전에', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-cfg-serve-'));
    dirs.push(dataDir);
    writeFileSync(join(dataDir, 'server.json'), BROKEN);
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'uncaughtException', 'unhandledRejection'];
    const before = new Map(events.map((e) => [e, process.listeners(e as NodeJS.Signals)]));
    const err: string[] = [];
    let code: number | null;
    try {
      code = await runServe(
        { dataDir, bind: '127.0.0.1', port: 0, webDir: null, allowTestSession: false },
        { out: async () => undefined, err: async (t) => void err.push(t), exit: () => undefined },
      );
    } finally {
      // runServe가 붙인 프로세스 처리기를 뗀다 — 이 시험 프로세스에 남기지 않는다
      for (const e of events) for (const l of process.listeners(e as NodeJS.Signals)) if (!before.get(e)!.includes(l)) process.off(e, l);
    }
    const fragment = SECRET.slice(0, 6);
    const serverLog = await import('node:fs').then((fs) => fs.readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8'));
    expect({ code, stderrHasFragment: err.join('').includes(fragment), logHasFragment: serverLog.includes(fragment) }).toEqual({ code: 1, stderrHasFragment: false, logHasFragment: false });
    expect(err.join('')).toContain(`욱채 서버를 시작하지 못했습니다: 운영자 설정을 적용하지 못했습니다 — 운영자 설정 파일(${join(dataDir, 'server.json')})이 JSON이 아닙니다: 3번째 줄`);
    expect(await import('node:fs').then((fs) => [fs.existsSync(join(dataDir, 'server.lock')), fs.existsSync(join(dataDir, 'wook.db'))])).toEqual([false, false]);
  });
});
