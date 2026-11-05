/** 스모크: 대표 명령 → 지시 → 계획 → 작업 → 자동 검사 → 검수 → 병합 → 최종 결과 → 보고 → 결과 승인 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createHarness, sendCommand } from './harness';

describe('스모크', () => {
  it('모의 팀이 지시를 끝까지 처리하고 보고서를 올린다', async () => {
    const h = await createHarness({ team: ['developer', 'qa'] });
    try {
      const did = await sendCommand(h, '로그인 화면을 만들어 줘');
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 180_000, label: '보고 도착' });
      const tasks = h.core.ctx.store.tasks.list({ ref1: did });
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((t) => t.state === 'done')).toBe(true);
      // 저장소 변경형 작업은 main에 병합 커밋으로 남는다 (GIT-14)
      const repoTasks = tasks.filter((t) => t.outputMode === 'repo');
      for (const t of repoTasks) expect(t.merge?.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
      const log = execFileSync('git', ['-C', h.projectDir, 'log', '--merges', '--format=%s', 'main'], { encoding: 'utf8' });
      for (const t of repoTasks) expect(log).toContain(`[${t.id}] 병합`);
      const reports = h.core.ctx.store.reports.list({ ref1: did });
      expect(reports).toHaveLength(1);
      await h.invoke('reports.approve', reports[0]!.id, '좋습니다');
      expect(h.core.ctx.store.directives.get(did)?.state).toBe('closed');
    } finally {
      await h.close();
    }
  }, 240_000);
});
