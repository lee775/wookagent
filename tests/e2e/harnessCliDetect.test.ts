/**
 * 하네스(createHarness)의 시작 때 CLI 확인은 고정 결과다 (리드 결정 S10-10.2): 이 PC에 어떤 CLI가 깔렸는지에 시험이 기대지 않는다. CLI가 없는 PC(Linux
 * 복사본·CI)에서는 시작 0.5초쯤 뒤 'claude CLI 확인 필요'·'codex CLI 확인 필요' 긴급 알림이 시험의 셈에 끼었다(S10t 원인 B). 시험이 자기 확인을 주면 그것을 쓴다.
 * 잡는 결함: 하네스가 다시 이 PC의 실제 확인을 씀 — CLI 없는 PC에서 알림·AI 상태가 달라진다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function checked(x: Harness): Promise<void> {
  await x.waitFor(() => x.core.ctx.ai('claude').checkedAt !== null && x.core.ctx.ai('codex').checkedAt !== null, { timeoutMs: 30_000, label: '시작 때 CLI 확인' });
}

describe('createHarness의 시작 때 CLI 확인 (S10-10.2)', () => {
  it('기본은 두 CLI 모두 설치됨·로그인됨의 고정 결과 — 알림이 없다', async () => {
    const x = (h = await createHarness({ noProject: true }));
    await checked(x);
    for (const kind of ['claude', 'codex'] as const) {
      expect(x.core.ctx.ai(kind)).toMatchObject({ cliInstalled: true, cliVersion: '9.9.9', cliProblem: null, authRequired: false });
    }
    expect(x.core.ctx.store.notifications.list().filter((n) => n.title.endsWith('CLI 확인 필요'))).toEqual([]);
  });

  it('시험이 준 확인은 그 AI 종류에만 쓰인다 — 설치되지 않은 claude는 알림 하나, codex는 고정 결과', async () => {
    const x = (h = await createHarness({
      noProject: true,
      cliDetect: { claude: async () => ({ installed: false, path: null, version: null, loggedIn: null, problem: null, detail: '시험: 없음' }) },
    }));
    await checked(x);
    expect(x.core.ctx.ai('claude')).toMatchObject({ cliInstalled: false, cliProblem: '설치되지 않음' });
    expect(x.core.ctx.ai('codex')).toMatchObject({ cliInstalled: true, cliVersion: '9.9.9' });
    expect(x.core.ctx.store.notifications.list().filter((n) => n.title.endsWith('CLI 확인 필요')).map((n) => n.title)).toEqual(['claude CLI 확인 필요']);
  });
});
