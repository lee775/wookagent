/**
 * 빌드한 서버의 3단계 HTTP 표면 (리드 결정 S3-7·S3-10·S3-11): 서버 프로세스(serve.ts)가 `--public-origin`과 server.json의 공개 주소·Tailscale 사용자를
 * HTTP에 넘기고, 업로드·내려받기와 횟수 제한을 실제로 연다. 모양이 틀린 공개 주소는 무엇도 만들기 전에 거부한다. 토큰은 시험 출력에 내지 않는다
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServerTo, clientJson, httpCall, invokeHttp, issueTokenBuilt, removeDir, runClient, startBuilt, testBuildDir, type BuiltServer } from './helpers';

let outDir = '';
let entry = '';
const dirs: string[] = [];
const servers: BuiltServer[] = [];

beforeAll(() => {
  outDir = testBuildDir('remote');
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

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-remote-${tag}-`));
  dirs.push(d);
  return d;
};

describe('빌드한 서버의 공개 주소·Tailscale 사용자·업로드 (S3-7·S3-10)', () => {
  it('--public-origin의 Host를 받고 server.json의 Tailscale 사용자만 들인다 — config show가 정한 곳을 말한다. 업로드와 내려받기가 열려 있다', async () => {
    const dataDir = tempDir('data');
    writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ owner: { email: 'owner@example.com', tailscaleLogins: ['owner@example.com'] } }));
    const s = await startBuilt({ entry, dataDir, args: ['--public-origin', 'https://grok-pc.tailnet-test.ts.net', '--allow-test-session'] });
    servers.push(s);
    const token = issueTokenBuilt(entry, dataDir);
    const ts = { 'Tailscale-User-Login': 'owner@example.com' };
    const viaTunnel = { Host: 'grok-pc.tailnet-test.ts.net', ...ts };
    expect((await invokeHttp(s.url, token, 'auth.getState', [], { headers: viaTunnel })).json()).toMatchObject({ ok: true, value: { loggedIn: true } });
    const noUser = await invokeHttp(s.url, token, 'auth.getState', [], { headers: { Host: 'grok-pc.tailnet-test.ts.net' } });
    expect([noUser.status, noUser.json<{ error: { code: string } }>().error.code]).toEqual([403, 'forbidden_tailscale_user']);
    const otherHost = await invokeHttp(s.url, token, 'auth.getState', [], { headers: { Host: 'other-pc.tailnet-test.ts.net', ...ts } });
    expect(otherHost.status).toBe(403);
    const shown = clientJson(entry, ['config', 'show', '--data-dir', dataDir]);
    expect(shown.reply).toMatchObject({ ok: true, result: { access: { publicOrigin: 'https://grok-pc.tailnet-test.ts.net', publicOriginSource: 'flag', tailscaleLogins: ['owner@example.com'] } } });
    // 업로드 (S3-10) — 서버 프로세스가 백엔드의 파일 길을 HTTP에 넘긴다
    const up = await httpCall({ url: s.url, path: '/api/uploads?name=memo.txt', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', ...ts }, body: '빌드한 서버에 올린 파일' });
    expect(up.status).toBe(200);
    const id = up.json<{ value: { uploadId: string } }>().value.uploadId;
    expect(existsSync(join(dataDir, 'uploads', id))).toBe(true);
    // 내려받기 길도 열려 있다 (명령은 보내지 않는다 — 빌드한 서버의 메인 에이전트는 실제 CLI다)
    const exported = (await invokeHttp(s.url, token, 'logs.export', [{}], { headers: ts })).json<{ value: { path: string } }>().value.path;
    const name = exported.split(/[\\/]/).pop()!;
    expect((await httpCall({ url: s.url, path: `/api/exports/${encodeURIComponent(name)}`, headers: { Authorization: `Bearer ${token}`, ...ts } })).status).toBe(200);
    expect((await httpCall({ url: s.url, path: '/api/exports/none.jsonl', headers: { Authorization: `Bearer ${token}`, ...ts } })).status).toBe(404);
  }, 120_000);

  it('모양이 틀린 공개 주소는 무엇도 만들기 전에 거부한다 — 서버 인자는 쓰임새 오류(2), server.json은 시작 실패(1)이고 잠금·저장소를 만들지 않는다', async () => {
    const dataDir = tempDir('bad');
    const flag = runClient(entry, ['serve', '--data-dir', dataDir, '--port', '0', '--public-origin', 'http://grok-pc.tailnet-test.ts.net']);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain('--public-origin: 공개 주소는 https여야 합니다');
    writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ network: { publicOrigin: 'https://grok-pc.tailnet-test.ts.net/app' } }));
    const file = runClient(entry, ['serve', '--data-dir', dataDir, '--port', '0']);
    expect(file.code).toBe(1);
    expect(file.stderr).toContain('network.publicOrigin — 공개 주소에는 경로·쿼리·사용자 정보 없이');
    expect([existsSync(join(dataDir, 'server.lock')), existsSync(join(dataDir, 'wook.db'))]).toEqual([false, false]);
  }, 120_000);
});
