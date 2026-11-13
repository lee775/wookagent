/**
 * host_exec 실행 위치(cwd) 검사 (SERVER_DESIGN 8.4, 리드 결정 S5-17, 지도 host-exec HX-2):
 * - 데이터 폴더·보관하지 않은 프로젝트 폴더·그 프로젝트의 연결 지점이 닿는 폴더와 같거나(같은 폴더의 다른 철자 — 연결 지점·짧은 이름 포함) 그 안이거나 그 폴더를 품은
 *   위치는 forbidden — 프로세스를 띄우지 않고 실행 기록도 남기지 않는다
 * - 상대 경로·없는 폴더·파일·Windows 로컬 드라이브가 아닌 경로(UNC)는 invalid
 * - cwd를 주지 않으면 메인 작업 폴더에서 돈다. 메인 작업 폴더가 데이터 폴더 안(예전 자리)이면 기본 실행 위치로 쓰지 않는다
 * - 이 검사는 cwd만 본다 — 도구 설명이 그렇게 말한다 (격리가 아니다)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolSpec } from '../../src/main/mcp/catalog';
import { bootOrch, type OrchEnv } from './orchHarness';
import { hostExec, hostRecords, liveMainTurn, okData } from './hostExecRig';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const win = process.platform === 'win32';
const linkKind = win ? 'junction' : 'dir';

/** 8.3 짧은 이름 철자 (Windows). 그 볼륨이 짧은 이름을 만들지 않으면 원래 경로 그대로 */
function shortName(p: string): string {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:WOOK_SHORT_OF).ShortPath'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, WOOK_SHORT_OF: p },
    }).trim();
    return out || p;
  } catch {
    return p;
  }
}

async function refused(e: OrchEnv, turnId: string, cwd: string, code: 'forbidden' | 'invalid', fragment: string): Promise<void> {
  const before = e.hostSpecs.length;
  const r = await hostExec(e, turnId, { command: 'echo hi', cwd });
  expect(r, cwd).toMatchObject({ ok: false, code });
  expect(r.ok ? '' : r.message, cwd).toContain(fragment);
  expect(e.hostSpecs.length, `${cwd}: 띄우지 않는다`).toBe(before);
}

describe('host_exec 실행 위치 검사 (hostExecGuard)', () => {
  it('기본 실행 위치는 데이터 폴더 밖의 메인 작업 폴더다 — cwd를 주지 않으면 거기서 돈다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'echo hi' }));
    expect(d.cwd).toBe(e.mainWorkDir);
    expect(e.hostSpecs.map((s) => s.cwd)).toEqual([e.mainWorkDir]);
    expect(hostRecords(e).map((x) => x.cwd)).toEqual([e.mainWorkDir]);
  });

  it('데이터 폴더와 같은 폴더·그 안·그 폴더를 품은 상위 폴더, 다른 철자(연결 지점)는 forbidden — 띄우지 않고 실행 기록도 없다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    await refused(e, turnId, e.dataDir, 'forbidden', '앱 데이터 폴더');
    await refused(e, turnId, join(e.dataDir, 'worktrees'), 'forbidden', '앱 데이터 폴더');
    // 데이터 폴더를 먼저 본다 — 그 위 폴더는 프로젝트도 품지만 까닭은 데이터 폴더다
    await refused(e, turnId, dirname(e.dataDir), 'forbidden', `앱 데이터 폴더(${e.dataDir})를 품은 상위 폴더`);
    const link = join(dirname(e.mainWorkDir!), 'data-link');
    symlinkSync(e.dataDir, link, linkKind);
    await refused(e, turnId, link, 'forbidden', '앱 데이터 폴더');
    await refused(e, turnId, join(link, 'memory'), 'forbidden', '앱 데이터 폴더');
    expect(hostRecords(e)).toEqual([]);
  });

  it('등록된 프로젝트 폴더·그 안·그 폴더를 품은 상위 폴더, 짧은 이름 철자, 프로젝트의 연결 지점이 닿는 폴더는 forbidden', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    // 연결 지점이 바깥 폴더를 가리키는 둘째 프로젝트 — 등록할 때 그 바깥 폴더를 기록한다 (S8-D2)
    const outside = mkdtempSync(join(tmpdir(), 'wook-test-hx-out-'));
    writeFileSync(join(outside, 'asset.txt'), 'x');
    const second = join(mkdtempSync(join(tmpdir(), 'wook-test-hx-p2-')), 'p2');
    mkdirSync(second);
    writeFileSync(join(second, 'README.md'), '# p2');
    symlinkSync(outside, join(second, 'assets'), linkKind);
    const p2 = await e.internal('projects.create', { mode: 'existing', path: second, name: '둘째' });
    expect(e.core.projects.linkTargets(p2.id).length).toBeGreaterThan(0);
    const { turnId } = await liveMainTurn(e);
    await refused(e, turnId, e.projectDir, 'forbidden', '등록된 프로젝트 폴더');
    mkdirSync(join(e.projectDir, 'src'), { recursive: true });
    await refused(e, turnId, join(e.projectDir, 'src'), 'forbidden', '등록된 프로젝트 폴더');
    await refused(e, turnId, dirname(e.projectDir), 'forbidden', '를 품은 상위 폴더');
    await refused(e, turnId, outside, 'forbidden', '연결 지점으로 닿는 폴더');
    if (win) {
      const short = shortName(e.projectDir);
      // 짧은 이름을 만들지 않는 볼륨이면 철자가 같아 앞의 경우와 같다 — 그래도 거부된다
      await refused(e, turnId, short, 'forbidden', '등록된 프로젝트 폴더');
    }
    expect(hostRecords(e)).toEqual([]);
  });

  it('보관한 프로젝트 폴더는 막지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const p = e.ctx.store.projects.require(e.projectId);
    e.ctx.store.projects.put({ ...p, archivedAt: e.ctx.now() });
    const { turnId } = await liveMainTurn(e);
    expect(okData(await hostExec(e, turnId, { command: 'echo hi', cwd: e.projectDir })).cwd).toBe(e.projectDir);
  });

  it('상대 경로·없는 폴더·파일·네트워크 경로(UNC)는 invalid — 띄우지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    await refused(e, turnId, 'proj', 'invalid', 'cwd는 절대 경로여야 합니다');
    await refused(e, turnId, join(e.mainWorkDir!, 'nope'), 'invalid', 'cwd 폴더가 없습니다');
    const file = join(e.mainWorkDir!, 'f.txt');
    writeFileSync(file, 'x');
    await refused(e, turnId, file, 'invalid', 'cwd 폴더가 없습니다');
    if (win) {
      const unc = `\\\\localhost\\${e.mainWorkDir![0]}$${e.mainWorkDir!.slice(2)}`;
      await refused(e, turnId, unc, 'invalid', '로컬 드라이브 폴더');
    }
    // Linux (리드 결정 S10-6.6): /proc·/sys·/dev와 그 안은 invalid — Linux 예시로 말한다 (네트워크 파일 시스템은 pathGuardLinux.test가 넣은 mountinfo로 본다)
    if (process.platform === 'linux') {
      await refused(e, turnId, '/proc', 'invalid', 'cwd는 이 PC의 로컬 폴더(예: /home/<사용자>/work)여야 합니다 — 가상 파일 시스템(/proc)의 경로는 쓸 수 없습니다');
      await refused(e, turnId, '/sys/kernel', 'invalid', '가상 파일 시스템(/sys)의 경로');
    }
  });

  it('메인 작업 폴더가 데이터 폴더 안(예전 자리)이면 기본 실행 위치로 쓰지 않는다 — cwd를 주면 그 폴더에서 돈다', async () => {
    const e = (env = await bootOrch());
    const { turnId } = await liveMainTurn(e);
    const r = await hostExec(e, turnId, { command: 'echo hi' });
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(r.ok ? '' : r.message).toBe(`기본 실행 위치인 메인 작업 폴더(${e.ctx.paths.mainAgent})가 앱 데이터 폴더(${e.dataDir}) 안이라 쓰지 않습니다 — 실행할 폴더를 cwd로 주세요`);
    const ok = mkdtempSync(join(tmpdir(), 'wook-test-hx-cwd-'));
    expect(okData(await hostExec(e, turnId, { command: 'echo hi', cwd: ok })).cwd).toBe(ok);
  });

  it('도구 설명은 실행 위치만 본다(격리가 아니다)고 말한다', () => {
    expect(toolSpec('host_exec')!.description).toContain('이 검사는 실행 위치(cwd)만 보며 격리가 아닙니다');
  });

  // cwd 철자 (리드 결정 S5-31, 프로브 zz-xs5-exec): 절대 경로인지 본 뒤로는 resolve한 경로로 보고 띄우고 기록한다 — 프로젝트 등록과 같다
  it('.. 조각이 든 허용된 폴더도 받는다 — 띄우는 곳·결과·실행 기록은 resolve한 경로이고, 거부 까닭이 틀리게 말하지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-hx-dots-'));
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    const sep = win ? '\\' : '/';
    const dotted = `${dir}${sep}a${sep}..${sep}b`;
    const r = await hostExec(e, turnId, { command: 'echo hi', cwd: dotted, request_id: 'rq-dots' });
    expect(r.ok ? 'ok' : `${r.code}: ${r.message}`).toBe('ok');
    const want = join(dir, 'b');
    expect(okData(r).cwd).toBe(want);
    expect(e.hostSpecs.at(-1)!.cwd).toBe(want);
    expect(hostRecords(e).find((x) => x.result.toolRequestId === 'rq-dots')!.cwd).toBe(want);
    // 막힌 폴더도 .. 철자로 피하지 못한다
    await refused(e, turnId, `${e.projectDir}${sep}x${sep}..`, 'forbidden', '등록된 프로젝트 폴더');
  });

  it.runIf(win)('C:/… 꼴(앞으로 빗금)의 허용된 폴더도 C:\\… 꼴과 같이 받는다 — Windows만(다른 OS는 빗금이 원래 경로 구분자다)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-hx-slash-'));
    const r = await hostExec(e, turnId, { command: 'echo hi', cwd: dir.replace(/\\/g, '/'), request_id: 'rq-slash' });
    expect(r.ok ? 'ok' : `${r.code}: ${r.message}`).toBe('ok');
    expect(okData(r).cwd).toBe(dir);
    expect(hostRecords(e).find((x) => x.result.toolRequestId === 'rq-slash')!.cwd).toBe(dir);
    await refused(e, turnId, e.dataDir.replace(/\\/g, '/'), 'forbidden', '앱 데이터 폴더');
  });

  it('거부 목록은 host_exec가 실제로 쓰는 셸의 따옴표로 읽는다 — Windows(cmd)는 작은따옴표 안의 & 뒤 명령을 막고 큰따옴표를 쓰라고 일러 주며, 그 밖(sh)은 막지 않는다 (리드 결정 S5-39·S5-46)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const r = await hostExec(e, turnId, { command: "git commit -m 'fix & shutdown /s docs'", request_id: 'rq-shell-quote' });
    if (win) {
      expect(r).toMatchObject({ ok: false, code: 'forbidden' });
      expect(r.ok ? '' : r.message).toContain('(cmd에서는 작은따옴표가 글자로 남아 그 안이 명령으로 읽힙니다 — 메시지·인자에는 큰따옴표를 쓰세요)');
      expect(e.hostSpecs).toEqual([]);
    } else {
      expect(r.ok ? 'ok' : `${r.code}: ${r.message}`).toBe('ok');
      expect(e.hostSpecs).toHaveLength(1);
    }
    // 큰따옴표면 어느 셸에서도 막지 않는다
    expect(okData(await hostExec(e, turnId, { command: 'git commit -m "fix & shutdown /s docs"', request_id: 'rq-shell-dq' })).exit_code).toBe(0);
  });

  it('명령 글자가 이 앱의 데이터 폴더나 관리 파일을 가리키면 cwd와 상관없이 거부 목록이 막는다 (리드 결정 S5-32)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    for (const command of [`dir "${e.dataDir}"`, `type ${e.dataDir.toUpperCase().replace(/\\/g, '/')}/wook.db`, 'type admin.token']) {
      const r = await hostExec(e, turnId, { command });
      expect(r, command).toMatchObject({ ok: false, code: 'forbidden' });
      expect(r.ok ? '' : r.message, command).toContain('앱 데이터 폴더나 그 안의 관리 파일(admin.token·admin.endpoint·setup-code.txt)을 가리키는 명령이라 실행하지 않았습니다');
    }
    expect(e.hostSpecs).toEqual([]);
  });
});
