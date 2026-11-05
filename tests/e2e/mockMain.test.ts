/** 모의 메인 에이전트: 팀원 AI 설정 결정, 대표용 보고서 본문 (실제 앱 점검에서 찾은 빈틈의 회귀 테스트) */
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createHarness, sendCommand } from './harness';

describe('모의 메인 에이전트', () => {
  it('메인 에이전트가 역할 기본값으로 추가한 팀원의 AI 설정을 메인 에이전트가 정하고 사유를 남긴다', async () => {
    // v0.6: 팀원은 메인 에이전트가 추가한다 (add_member, SERVER_DESIGN 2.3). 운영자 준비(내부 API)로 넣은 팀원에게는 AI 결정 요청이 가지 않는다
    const h = await createHarness({ team: [] });
    try {
      const ids: string[] = [];
      for (const role of ['developer', 'docs']) ids.push(String((await h.main('add_member', { project_id: h.projectId, role_id: role, reason: '시험 팀 구성' })).memberId));
      h.members.developer = ids[0]!;
      h.members.docs = ids[1]!;
      await h.waitFor(() => ids.every((id) => h.core.ctx.store.members.require(id).aiDecision?.by === MAIN_AGENT_ID), {
        timeoutMs: 60_000,
        label: '메인 에이전트의 AI 설정 결정',
      });
      const docs = h.core.ctx.store.members.require(h.members.docs!);
      expect(docs.ai.effortTier).toBe('low');
      expect(docs.aiDecision?.reason).toContain('문서');
      const dev = h.core.ctx.store.members.require(h.members.developer!);
      expect(dev.ai.effortTier).toBe('normal');
    } finally {
      await h.close();
    }
  }, 90_000);

  it('보고서 본문에 앱이 메인 에이전트에게 준 지시 문장이 섞이지 않는다', async () => {
    const h = await createHarness({ team: ['developer'] });
    try {
      const did = await sendCommand(h, '카페 게임 첫 화면을 만들어 줘. 메뉴판 디자인, 주문 버튼, 기본 테스트까지 포함해서.');
      // 지시 제목은 첫 문장으로, 단어 중간에서 잘리지 않는다
      expect(h.core.ctx.store.directives.get(did)?.title).toBe('카페 게임 첫 화면을 만들어 줘');
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 180_000, label: '보고 도착' });
      const [report] = h.core.ctx.store.reports.list({ ref1: did });
      expect(report).toBeDefined();
      const text = JSON.stringify(report);
      expect(text).not.toContain('submit_report(');
      expect(text).not.toContain('대표에게 보고하세요');
    } finally {
      await h.close();
    }
  }, 240_000);
});
