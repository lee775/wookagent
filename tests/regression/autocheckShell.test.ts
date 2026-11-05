/**
 * 자동 검사 명령은 대표가 cmd에서 친 것과 똑같이 실행된다 (windows:F4·F10, REV-01, ENV-03).
 * 예전에는 cmd /d /s /c 뒤의 명령을 MSVCRT 방식(\")으로 인용해 cmd가 따옴표를 잘못 읽었다:
 * 실패하는 검사(node -e "process.exit(3)")가 통과로, 공백 경로("C:\Program Files\...")가 실패로 기록됐다.
 * cmd 자체 오류 문구(CP949)는 UTF-8로 읽혀 깨졌다. 두 러너 방식(jobobject·taskkill) 모두 실제 프로세스로 확인한다.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessRunner } from '../../src/main/process/processRunner';
import { shellCommand } from '../../src/main/orchestrator/autocheck';
import type { Env } from './helpers';
import { activate, boot, newTask } from './helpers';

const runnerSource = fileURLToPath(new URL('../../resources/jobrunner/JobRunner.cs', import.meta.url));
const NODE = `"${process.execPath}"`;

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

async function bootMode(mode: 'jobobject' | 'taskkill', checkCommands: string[] = []): Promise<Env> {
  env = await boot({ runner: true, checkCommands });
  if (mode === 'jobobject') env.ctx.deps.runner = await createProcessRunner({ dataDir: join(env.dataDir, 'job'), forceMode: 'jobobject', runnerSource, log: () => undefined });
  expect(env.ctx.deps.runner.mode).toBe(mode);
  return env;
}

describe('자동 검사 셸 명령줄 (어느 OS에서나 확인)', () => {
  it('Windows는 cmd /d /s /c "<명령>"을 인용 없이(verbatim)·콘솔 출력으로, POSIX는 /bin/sh -c 그대로', () => {
    const cmd = `"C:\\Program Files\\nodejs\\node.exe" -e "process.exit(3)" && echo %X%`;
    expect(shellCommand(cmd, 'win32')).toMatchObject({ args: ['/d', '/s', '/c', `"${cmd}"`], verbatimArgs: true, consoleOutput: true });
    expect(shellCommand('npm test -- "a b"', 'linux')).toEqual({ command: '/bin/sh', args: ['-c', 'npm test -- "a b"'], verbatimArgs: false, consoleOutput: false });
  });
});

describe.skipIf(process.platform !== 'win32')('자동 검사 명령을 cmd에 그대로 넘긴다 (windows:F4·F10)', () => {
  for (const mode of ['jobobject', 'taskkill'] as const) {
    it(`${mode}: 실패하는 검사는 실패, 공백·따옴표 경로는 실행, %변수%는 펼침, cmd 오류 문구는 읽히게`, async () => {
      const e = await bootMode(mode);
      const t = newTask(e);
      await activate(e, t.id);
      const task = e.ctx.store.tasks.require(t.id);
      const wt = task.workspace!.worktreePath;
      const spaced = join(wt, 'dir with space');
      mkdirSync(spaced);
      writeFileSync(join(spaced, 'ok.cmd'), '@exit /b 0\r\n');
      writeFileSync(join(spaced, 'three.cmd'), '@exit /b 3\r\n');
      const run = (cmd: string) => e.core.checks.run(task, { ...e.project, checkCommands: [cmd] }, wt);

      const cases: [string, 'passed' | 'failed'][] = [
        [`node -e "process.exit(3)"`, 'failed'],
        [`node -e "process.exit(0)" && node -e "process.exit(4)"`, 'failed'],
        [`powershell -NoProfile -Command "exit 3"`, 'failed'],
        [`node -e "process.exit(0)"`, 'passed'],
        [`${NODE} --version`, 'passed'],
        [`${NODE} -e "process.exit(0)"`, 'passed'],
        [`"${join(spaced, 'ok.cmd')}"`, 'passed'],
        [`"${join(spaced, 'three.cmd')}"`, 'failed'],
      ];
      for (const [cmd, want] of cases) {
        const out = await run(cmd);
        expect({ cmd, status: out.status }).toEqual({ cmd, status: want });
      }

      const echoed = await run('echo [%COMPUTERNAME%]');
      expect(echoed.status).toBe('passed');
      expect(echoed.detail).toContain(`[${process.env.COMPUTERNAME}]`);

      // cmd 자체 오류 문구 (한국어 Windows는 CP949): 깨지지 않고 읽혀야 팀원이 원인을 안다 (windows:F10)
      const missing = await run('wook-no-such-command-xyz --check');
      expect(missing.status).toBe('failed');
      expect(missing.detail).toContain('wook-no-such-command-xyz');
      expect(missing.detail).not.toContain('\uFFFD');
    });

    it(`${mode}: 제출 처리 — 실패하는 검사가 통과로 기록되지 않고, 공백 경로 검사는 통과해 검수로 간다 (REV-01)`, async () => {
      const e = await bootMode(mode, [`${NODE} -e "process.exit(Number(require('fs').existsSync('fail.flag')) * 3)"`]);
      const t = newTask(e);
      await activate(e, t.id);
      e.core.tasks.setSteps(t.id, ['단계']);
      const dev = e.ctx.store.members.require(t.assigneeId);
      const wt = e.ctx.store.tasks.require(t.id).workspace!.worktreePath;

      // 1) 검사가 실패해야 하는 버전
      writeFileSync(join(wt, 'fail.flag'), 'x\n');
      await e.core.tasks.completeStep(t.id, 0, '', dev, null);
      e.core.tasks.requestSubmit(t.id, '제출', dev);
      await e.core.tasks.processSubmission(t.id);
      let cur = e.ctx.store.tasks.require(t.id);
      expect(cur.state).toBe('in_progress');
      expect(cur.review.autoCheck.status).toBe('failed');
      expect(cur.review.autoCheck.detail).toContain('종료 코드 3');

      // 2) 원인을 고친 버전(제출 처리가 남은 변경을 커밋) → 통과 → 검수 대상 고정
      rmSync(join(wt, 'fail.flag'));
      e.core.tasks.requestSubmit(t.id, '다시 제출', dev);
      await e.core.tasks.processSubmission(t.id);
      cur = e.ctx.store.tasks.require(t.id);
      expect(cur.review.autoCheck.status).toBe('passed');
      expect(cur.state).toBe('in_review');
    });
  }
});
