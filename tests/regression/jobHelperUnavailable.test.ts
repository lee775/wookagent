/**
 * 작업 개체 도우미를 쓸 수 없는 환경 (stage-5 process-sleep 결함 5 — CTL-11, ENV 사전 조건, 12장 알림, ARCHITECTURE 13장 대체 방식).
 * taskkill 대체 방식은 작업 개체 러너를 쓸 수 없을 때(대개 WDAC·AppLocker 같은 보안 정책 환경) 돈다. 그런 환경은 PowerShell도 제한 언어 모드로
 * 띄워 도우미가 시작하자마자 끝난다. 그러면 CLI가 띄운 하위 프로세스의 종료를 확인하지 못해 턴마다 그 일을 멈추게 되는데(CTL-11, 막는 것은 맞다),
 * 예전에는 그 까닭이 로그에만 있었고 턴 끝 알림은 '남은 프로세스를 정리한 뒤 재개하세요'라 대표가 무엇을 해야 하는지 알 수 없었다.
 *  - 까닭(제한 언어 모드)을 긴급 알림 한 번과 설정 화면의 실행 도구 줄(system.prereqs.jobRunner)에 알린다
 *  - 턴 끝 알림은 확인하지 못했다고 쓰고(정리하라고 하지 않음) 환경 까닭을 붙인다. 프로그램이 건 팀원 일시정지에는 까닭이 남는다
 * 실제 PowerShell(세션을 제한 언어 모드로 바꾼 도우미 스크립트)·실제 러너·실제 모의 에이전트 (Windows 전용)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createJobHelper } from '../../src/main/process/jobHelper';
import { createHarness, type Harness } from '../e2e/harness';

const CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close().catch(() => undefined);
  h = null;
});

describe.skipIf(process.platform !== 'win32')('작업 개체 도우미를 쓸 수 없는 환경 (PowerShell 제한 언어 모드)', () => {
  it('도우미 자체: 준비되지 않고(ready=false) 까닭이 제한 언어 모드라고 알린다 — 넣기는 null', async () => {
    const helper = createJobHelper({ log: () => undefined, scriptPrefix: CONSTRAINED });
    const problems: string[] = [];
    helper.onProblem((p) => problems.push(p));
    try {
      const t0 = Date.now();
      expect(await helper.ready(15_000)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(10_000); // 시작 상한(30초)을 기다리지 않고 곧바로 실패를 안다
      expect(helper.problem()).toContain('제한 언어 모드(ConstrainedLanguage)');
      expect(problems).toHaveLength(1);
      expect(await helper.adopt(process.pid, { notBefore: Date.now() - 10, notAfter: Date.now() })).toBeNull();
    } finally {
      helper.dispose();
    }
  }, 60_000);

  it('앱: 까닭을 긴급 알림 한 번·설정 화면에 알리고, 턴 끝에는 확인하지 못했다고(정리하라고 하지 않고) 알리며 팀원 일시정지에 까닭을 남긴다', async () => {
    h = await createHarness({ team: ['developer'], runnerMode: 'taskkill', jobHelper: createJobHelper({ log: () => undefined, scriptPrefix: CONSTRAINED }) });
    const store = h.core.ctx.store;
    // 1) 시작 때 긴급 알림 한 번 (같은 까닭은 같은 알림을 갱신)
    const env = store.notifications.list().filter((n) => n.key === 'runner-problem');
    expect(env.map((n) => n.level)).toEqual(['urgent']);
    expect(env[0]!.body).toContain('제한 언어 모드(ConstrainedLanguage)');
    // 대표에게는 재개가 없다 — 보류는 메인 에이전트에게 넘기고(서두를 때 명령창), 메인 자신의 정지는 이 PC의 작업 관리자로 확인한 뒤 '정지 해제'라고 쓴다
    // (리드 결정 32·S5-9 — 데스크톱 글. 서버 글은 holdNoticeTruth가 본다)
    expect(env[0]!.body).not.toContain('재개하면');
    expect(env[0]!.body).toContain('그 작업을 보류(관리 업무는 팀원 일시정지)하고 메인 에이전트에게 넘깁니다 — 메인 에이전트가 남은 프로세스를 확인하고 이어 갑니다');
    expect(env[0]!.body).toContain('서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요');
    expect(env[0]!.body).toContain("메인 에이전트 자신이 일시정지됐으면 작업 관리자 등에서 남은 프로세스가 없는지 확인한 뒤 '정지 해제'를 누르세요");
    // 2) 설정 화면의 실행 도구 줄
    const pre = await h.invoke('system.prereqs');
    expect(pre.jobRunner.ok).toBe(false);
    expect(pre.jobRunner.detail).toContain('작업 개체 도우미를 쓸 수 없습니다');
    expect(pre.jobRunner.detail).toContain('제한 언어 모드');
    // 3) 메인 에이전트 턴(팀원 AI 결정·대표 명령)이 끝나면 남은 후손을 확인하지 못해 그 팀원을 일시정지한다 (CTL-11) — 까닭을 남기고 알림은
    //    '확인하지 못함'. 대표 명령은 버리지 않고 재개 때 전달하려고 남겨 둔다. 팀원 AI 결정 턴은 메인 에이전트가 역할 기본값으로 팀원을 추가하면
    //    생긴다 (v0.6 — 운영자 준비로 넣은 팀원에게는 생기지 않는다)
    await h.main('add_member', { project_id: h.projectId, role_id: 'docs' });
    await h.waitFor(() => h!.core.turns.isMemberRunning(MAIN_AGENT_ID), { label: '메인 에이전트 AI 결정 턴', timeoutMs: 60_000 });
    await h.invoke('command.send', { target: h.projectId, text: '로그인 화면을 만들어 줘' });
    await h.waitFor(() => h!.core.ctx.stop().members[MAIN_AGENT_ID]?.paused === true, { label: '메인 에이전트 일시정지', timeoutMs: 60_000 });
    await h.waitFor(() => h!.core.turns.count() === 0, { label: '턴 종료' });
    expect(store.queue.list({ state: ['queued', 'running'] }).some((q) => q.kind === 'main_command' && q.message.includes('로그인 화면'))).toBe(true);
    const mainTurn = store.turns.list().find((t) => t.memberId === MAIN_AGENT_ID && t.endedAt)!;
    expect(mainTurn.process.state).toBe('kill_failed');
    const killed = store.notifications.list().filter((n) => n.key?.startsWith('kill-failed:') && n.body.startsWith('메인 에이전트'));
    expect(killed.length).toBeGreaterThanOrEqual(1);
    expect(killed[0]!.body).toContain('남은 하위 프로세스를 확인하지 못했습니다');
    expect(killed[0]!.body).toContain('작업 개체 도우미를 쓸 수 없음');
    expect(killed[0]!.body).not.toContain('정리한 뒤');
    const paused = h.snapshot().stop.pausedMembers.find((m) => m.memberId === MAIN_AGENT_ID);
    expect(paused).toMatchObject({ by: 'system' });
    expect(paused?.reason).toContain('프로세스 종료를 확인하지 못함');
    expect(store.notifications.list().filter((n) => n.key === 'runner-problem')).toHaveLength(1);
  }, 120_000);
});
