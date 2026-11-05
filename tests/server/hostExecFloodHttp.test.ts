/**
 * 서버는 바쁜 출력 중에도 답한다 (리드 결정 S5-42) — 서버 모드 하네스와 실제 서버(HTTP)·실제 러너·실제 셸로 돈다:
 * host_exec가 줄바꿈이 촘촘한 빠른 출력을 약 10초 내는 동안, 밖의 프로세스가 0.25초마다 보내는 HTTP 요청에 서버가 1초 안에 답한다(대표의 긴급 정지도 이 길로
 * 온다). 고치기 전에는 출력이 이어지는 동안 보낸 요청이 모두 출력이 끝난 뒤에야 답을 받았다(가장 늦은 답 7.6초 — 지난 검토 프로브 zz-xs5f2-starvehttp)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../e2e/harness';
import { startServer, type RunningServer } from '../../src/server/server';
import { mainOpsIdentity } from '../regression/mainOps';
import { memoryLogger, remoteBackendOf } from './helpers';

const FLOOD_MS = 10_000;

let h: Harness;
let server: RunningServer;
let dir: string;
let client: ChildProcess | null = null;
const log = memoryLogger();

beforeAll(async () => {
  h = await createHarness({ mode: 'server', noProject: true });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test' });
  dir = mkdtempSync(join(tmpdir(), 'wook-test-hxflood-http-'));
}, 120_000);

afterAll(async () => {
  if (client && client.exitCode === null) client.kill();
  // host_exec가 돌린 자식은 host_exec 호출이 끝나며(또는 h.close의 앱 종료 길이 러너 핸들로) 끝난다 — pid.txt로 끝내지 않는다(그 PID를 다른 프로세스가 쓸 수 있다,
  // 리드 결정 S5-52.4)
  await server?.close();
  await h?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** 출력하는 자식: PID 파일, 0.3초 뒤 쏟기 시작한 때(start.txt), 짧은 줄 1MiB 묶음을 FLOOD_MS 동안, 끝난 때(end.txt) — 시각은 epoch ms */
const FLOODER = [
  "const fs = require('node:fs');",
  "const [dir, floodMs] = process.argv.slice(2);",
  "fs.writeFileSync(dir + '/pid.txt', String(process.pid));",
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
  "const b = Buffer.from('build step ok 0123\\n'.repeat(55189));",
  'const all = (buf) => { let off = 0; while (off < buf.length) { try { off += fs.writeSync(1, buf, off); } catch (e) { if (e.code !== "EAGAIN") throw e; } } };',
  "fs.writeFileSync(dir + '/start.txt', String(Date.now()));",
  'const end = Date.now() + Number(floodMs);',
  'while (Date.now() < end) all(b);',
  "fs.writeFileSync(dir + '/end.txt', String(Date.now()));",
].join('\n');

/** 밖의 손님: 0.25초마다 GET 하나(세션 없음 — 서버는 405·429 따위로 곧바로 답한다), 보낸 때(epoch ms)와 걸린 ms. 정해진 때가 지나면 스스로 끝난다 */
const CLIENT = [
  "const http = require('node:http'); const fs = require('node:fs');",
  'const [url, out, runMs] = process.argv.slice(2); const rows = []; let pending = 0; const t0 = Date.now();',
  'const one = () => { const s = Date.now(); pending++; const req = http.get(url + "/api/invoke", { timeout: 15000 }, (res) => { res.resume(); res.on("end", () => { rows.push({ sentAt: s, ms: Date.now() - s, status: res.statusCode }); pending--; }); });',
  '  req.on("timeout", () => { rows.push({ sentAt: s, ms: 15000, status: 0 }); pending--; req.destroy(); }); req.on("error", () => { pending--; }); };',
  'const iv = setInterval(one, 250);',
  'setTimeout(() => { clearInterval(iv); const wait = setInterval(() => { if (pending <= 0 || Date.now() - t0 > Number(runMs) + 20000) { clearInterval(wait); fs.writeFileSync(out, JSON.stringify(rows)); process.exit(0); } }, 100); }, Number(runMs));',
].join('\n');

describe('서버는 바쁜 출력 중에도 답한다 (리드 결정 S5-42)', () => {
  it('host_exec가 줄바꿈이 촘촘한 출력을 약 10초 내는 동안 보낸 HTTP 요청에 모두 1초 안에 답한다', async () => {
    writeFileSync(join(dir, 'flood.cjs'), FLOODER);
    writeFileSync(join(dir, 'client.cjs'), CLIENT);
    const latFile = join(dir, 'lat.json');
    client = spawn(process.execPath, [join(dir, 'client.cjs'), server.url, latFile, String(FLOOD_MS + 3000)], { stdio: 'ignore' });
    const clientDone = new Promise((done) => client!.on('close', done));
    const r = await h.core.tools.handle(mainOpsIdentity('main:general', 'TN-hxflood-http'), 'host_exec', {
      command: `"${process.execPath}" "${join(dir, 'flood.cjs')}" "${dir}" ${FLOOD_MS}`,
      cwd: dir,
      purpose: '바쁜 출력 시험',
      request_id: 'rq-hxflood-http',
      timeout_s: 120,
    });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    await clientDone;
    const start = Number(readFileSync(join(dir, 'start.txt'), 'utf8'));
    const end = Number(readFileSync(join(dir, 'end.txt'), 'utf8'));
    const rows = JSON.parse(readFileSync(latFile, 'utf8')) as { sentAt: number; ms: number; status: number }[];
    const during = rows.filter((x) => x.sentAt >= start && x.sentAt <= end - 250);
    const worst = during.reduce((m, x) => Math.max(m, x.ms), 0);
    expect(during.length, `출력 중에 보낸 요청 ${during.length}개`).toBeGreaterThanOrEqual(20);
    expect(during.every((x) => x.status > 0)).toBe(true);
    expect(worst, `출력 중 가장 늦은 답 ${worst}ms`).toBeLessThan(1000);
  }, 120_000);
});
