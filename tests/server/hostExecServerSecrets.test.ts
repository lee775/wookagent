/**
 * 서버가 쥔 비밀 값과 host_exec (리드 결정 S5-30·S5-32, SERVER_DESIGN 3.2·8.2) — 서버 모드 하네스와 실제 러너·실제 셸(cmd.exe·/bin/sh)로 돈다:
 * - 관리 토큰(admin.token)은 서버 기록 가리개뿐 아니라 백엔드 가리개도 안다 — host_exec가 그 값을 찍어도 도구 결과·실행 기록·도구 중복 캐시에 원문이 없다
 *   (리뷰 exec-security 프로브 zz-xs5-admintoken). 데이터 폴더의 admin.token을 이름으로 찍는 명령은 거부 목록('서버 데이터 폴더')이 먼저 막는다
 * - 운영자 비밀 값 저장소의 값(secret set google-client-secret — 형식 규칙에 없는 값)과 이번 설정 코드도 가린다
 * - 운영자가 서버를 띄운 셸에서 내보낸 AI 키(형식 규칙이 없는 xAI 등)도 서버 모드에서만 가린다 — 데스크톱은 예전 그대로
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';
import { startServer, type RunningServer } from '../../src/server/server';
import { registerEnvAiKeys } from '../../src/main/backend/buildDeps';
import { toolCacheKey } from '../../src/main/orchestrator/tools';
import { mainOpsIdentity } from '../regression/mainOps';
import { memoryLogger, remoteBackendOf } from './helpers';

const XAI_KEY = `xai-${'Qz7Lm2Np9Rt4'.repeat(6)}`;
const OPERATOR_SECRET = 'operator-store-Value-9x8y7z6w5v';
const win = process.platform === 'win32';
const printCmd = (file: string): string => (win ? `type ${file}` : `cat ${file}`);

let h: Harness;
let server: RunningServer;
let cwd: string;
const log = memoryLogger();
let savedXai: string | undefined;
let seq = 0;

beforeAll(async () => {
  savedXai = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = XAI_KEY;
  h = await createHarness({ mode: 'server', noProject: true });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test' });
  cwd = mkdtempSync(join(tmpdir(), 'wook-test-hxs-cwd-'));
}, 120_000);

afterAll(async () => {
  if (savedXai === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = savedXai;
  await server?.close();
  await h?.close();
});

/** 그 파일을 찍는 host_exec — 결과와, 결과·실행 기록·중복 캐시를 이은 글 */
async function printFile(file: string) {
  const requestId = `rq-hxs-${++seq}`;
  const r = await h.core.tools.handle(mainOpsIdentity('main:general', `TN-hxs-${seq}`), 'host_exec', { command: printCmd(file), cwd, purpose: '서버 상태 확인', request_id: requestId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const data = (r as { ok: true; data: { output: string; exit_code: number } }).data;
  expect(data.exit_code).toBe(0);
  const rec = h.core.ctx.store.execs.list({ ref2: 'host_exec' }).filter((x) => x.result.toolRequestId === requestId);
  const cache = h.core.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, h.core.seat.generation(), 'host_exec', requestId));
  return { output: data.output, all: [data.output, JSON.stringify(rec), JSON.stringify(cache ?? null)].join('\n') };
}

describe('서버가 쥔 비밀 값과 host_exec (S5-30)', () => {
  it('관리 토큰은 백엔드 가리개도 안다 — 그 값을 찍은 host_exec의 출력·실행 기록·중복 캐시에 원문이 없다', async () => {
    const token = readFileSync(join(h.dataDir, 'admin.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(30);
    expect(h.core.ctx.redact.text(token)).not.toBe(token);
    // 데이터 폴더 밖으로 옮긴 사본을 찍는다 — 거부 목록은 명령 글자만 보므로 이런 길에서 출력을 지키는 것은 가리개다
    copyFileSync(join(h.dataDir, 'admin.token'), join(cwd, 'token-copy.txt'));
    const { output, all } = await printFile('token-copy.txt');
    expect(output).toContain('[가림:admin-token]');
    expect(all.includes(token)).toBe(false);
  });

  it('데이터 폴더의 admin.token을 찍는 명령은 거부 목록이 막는다 — 띄우지 않는다', async () => {
    const before = h.core.ctx.store.execs.list({ ref2: 'host_exec' }).length;
    const r = await h.core.tools.handle(mainOpsIdentity('main:general', 'TN-hxs-deny'), 'host_exec', {
      command: printCmd(`"${join(h.dataDir, 'admin.token')}"`),
      cwd,
      purpose: '서버 상태 확인',
      request_id: 'rq-hxs-deny',
    });
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(r.ok ? '' : r.message).toContain('앱 데이터 폴더나 그 안의 관리 파일(admin.token·admin.endpoint·setup-code.txt)을 가리키는 명령이라 실행하지 않았습니다');
    expect(h.core.ctx.store.execs.list({ ref2: 'host_exec' })).toHaveLength(before);
  });

  it('운영자 비밀 값 저장소의 값(secret set)과 이번 설정 코드도 가린다', async () => {
    const op = remoteBackendOf(h).operator;
    await op.setGoogleClientSecret(OPERATOR_SECRET);
    writeFileSync(join(cwd, 'secret-copy.txt'), `${OPERATOR_SECRET}\n`);
    const { all } = await printFile('secret-copy.txt');
    expect(all.includes(OPERATOR_SECRET)).toBe(false);
    const grant = op.issueSetupCode();
    expect(grant).not.toBeNull();
    expect(h.core.ctx.redact.text(`코드 ${grant!.code}`)).not.toContain(grant!.code);
  });

  it('운영자가 내보낸 AI 키(형식 규칙이 없는 xAI 키)도 서버 모드에서는 가린다', async () => {
    expect(h.core.ctx.redact.text(XAI_KEY)).not.toBe(XAI_KEY);
    writeFileSync(join(cwd, 'env-copy.txt'), `${XAI_KEY}\n`);
    const { all } = await printFile('env-copy.txt');
    expect(all.includes(XAI_KEY)).toBe(false);
  });
});

describe('운영자가 내보낸 AI 키 넣기 (registerEnvAiKeys)', () => {
  it('알려진 AI 키 이름만(대소문자 무시), 8자 이상인 값만 넣는다', () => {
    const added: string[] = [];
    const n = registerEnvAiKeys({ addSecret: (v) => void added.push(v) }, { xai_api_key: XAI_KEY, AZURE_OPENAI_API_KEY: '0123456789abcdef0123456789abcdef', OPENAI_API_KEY: 'short', GITHUB_TOKEN: 'ghp_not_this_list_1234', PATH: '/usr/bin' });
    expect(n).toBe(2);
    expect(added).toEqual([XAI_KEY, '0123456789abcdef0123456789abcdef']);
  });

  it('데스크톱 모드는 예전 그대로 — 내보낸 AI 키를 값으로 넣지 않는다', async () => {
    const desk = await createHarness({ noProject: true });
    try {
      expect(desk.core.ctx.redact.text(XAI_KEY)).toBe(XAI_KEY);
    } finally {
      await desk.close();
    }
  }, 120_000);
});
