/**
 * 실제 작업 스케줄러에 install-task의 XML을 등록해 본다 (리드 결정 S9-3·S9-10 — SERVER_DESIGN 10.9). 이 PC의 작업 스케줄러를 바꾸는 시험이라 기본 테스트에서는
 * 건너뛴다. 에이전트는 돌리지 않는다 — 대표가 허락한 실행만 (리드 결정 S9-13·S9-16 1·S9-17)
 *   WOOK_REAL_TASK=1 WOOK_REAL_TASK_HOST=<이 PC 이름> npx vitest run tests/real/realTask.test.ts
 * - 꺼 둔(<Enabled>false</Enabled>) 작업 하나를 시험 데이터 폴더의 이름(WookServer-<해시>)으로 등록하고(install-task와 같은 registerTask — 임시 파일·/create·COM
 *   다시 읽기·견주기), 작업 스케줄러 COM으로 다시 읽어 S9-3의 칸(관리자 권한 없이 — RunLevel LeastPrivilege, 동작은 Exec 하나 — S9-22 DS-1)을 보고, finally와
 *   afterAll에서 지운 뒤 없어진 것을 본다. 서버는 띄우지 않는다(꺼 둔 작업)
 * - 함께 보는 것 (verify): 관리자 권한 없는 사용자도 등록할 수 있는지(이 실행이 관리자 권한인지 적는다), 다시 읽은 UserId의 꼴(SID·계정 이름)
 */
import { hostname, tmpdir } from 'node:os';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { currentAccountNames, parseTaskXml, readIdentity, readRegisteredTask, realRunner, registerTask, sameAccount, taskName, unregisterTask, type TaskInputs } from '../../src/server/task';

const ENABLED = process.platform === 'win32' && process.env['WOOK_REAL_TASK'] === '1' && !!process.env['WOOK_REAL_TASK_HOST'] && process.env['WOOK_REAL_TASK_HOST'] === hostname();

describe.skipIf(!ENABLED)('실제 작업 스케줄러 (WOOK_REAL_TASK=1, 꺼 둔 작업을 등록하고 지운다)', () => {
  const dataDir = ENABLED ? mkdtempSync(join(tmpdir(), 'wook-real-task-')) : '';
  const name = ENABLED ? taskName(dataDir) : '';

  afterAll(async () => {
    if (!ENABLED) return;
    // 어느 길로 끝나든 작업을 남기지 않는다
    await unregisterTask(name, realRunner);
    expect(await readRegisteredTask(name, realRunner)).toEqual({ found: false });
    try {
      rmdirSync(dataDir);
    } catch {
      // 비었으면 지웠다
    }
  }, 120_000);

  it('꺼 둔 작업을 등록하고 다시 읽으면 S9-3의 칸 그대로다 — 지우면 없다', async () => {
    const id = await readIdentity(realRunner);
    if ('error' in id) throw new Error(id.error);
    // 시험은 저장소 폴더에서 돈다 — install-task가 쓰는 앱 루트와 같다
    const appRoot = process.cwd();
    const inputs: TaskInputs = { dataDir, nodePath: process.execPath, entry: join(appRoot, 'out', 'server', 'index.mjs'), appRoot, webDir: null, sid: id.sid, enabled: false };
    const elevated = (await realRunner('whoami', ['/groups', '/fo', 'csv', '/nh'])).stdout.toString('latin1').includes('S-1-16-12288');
    console.log(`[WOOK_REAL_TASK] ${name} — 이 실행은 ${elevated ? '관리자 권한(높은 무결성)' : '보통 사용자 권한'}입니다`);
    try {
      const r = await registerTask(name, inputs, { run: realRunner });
      expect(r).toEqual({ ok: true });
      const read = await readRegisteredTask(name, realRunner);
      if (!('found' in read) || !read.found) throw new Error(`등록한 작업을 다시 읽지 못했습니다: ${JSON.stringify(read)}`);
      const f = parseTaskXml(read.xml);
      console.log(`[WOOK_REAL_TASK] 다시 읽은 UserId의 꼴: ${f.userId?.startsWith('S-1-') ? 'SID' : '계정 이름'}, RunLevel 칸: ${f.runLevel ?? '없음(기본 LeastPrivilege)'}`);
      expect(sameAccount(f.userId, id.sid, currentAccountNames())).toBe(true);
      expect({
        logon: f.logonType,
        runLevel: f.runLevel ?? 'LeastPrivilege',
        actions: f.actions,
        limit: f.executionTimeLimit,
        disallow: f.disallowStartIfOnBatteries,
        stop: f.stopIfGoingOnBatteries,
        priority: f.priority,
        enabled: f.enabled,
      }).toEqual({
        logon: 'InteractiveToken',
        runLevel: 'LeastPrivilege',
        actions: ['Exec'],
        limit: 'PT0S',
        disallow: 'false',
        stop: 'false',
        priority: '6',
        enabled: 'false',
      });
    } finally {
      const gone = await unregisterTask(name, realRunner);
      expect(gone.ok).toBe(true);
    }
    expect(await readRegisteredTask(name, realRunner)).toEqual({ found: false });
  }, 120_000);
});
