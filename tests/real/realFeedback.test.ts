/**
 * 실제 AI로 지시 → 작업 → 검수 → 병합 → 보고 → 수정 요청 → 다음 회차 → 결과 승인까지 (기획서 3.1 1차-C 완료 기준, FBK-01~04).
 * 사용량이 드는 실행이라 기본 테스트에서는 건너뛴다.
 *   WOOK_REAL_FEEDBACK=1 npx vitest run tests/real/realFeedback.test.ts
 *   서버 모드(리드 결정 S9-10): WOOK_REAL_MODE=server를 더한다 — 프로세스 안 서버를 열고 대표 호출을 운영자 시험 세션(Bearer)의 HTTP로 보낸다(serverMode.ts).
 *   확인은 두 모드가 같다
 * - 메인 에이전트·프로듀서는 실제 Claude(sonnet, 보통), 개발자는 실제 Codex — 팀원 AI는 운영자가 정한다
 * - 확인: 권한 확인 없이 끝까지, 1회차 보고서, 수정 요청은 메인 에이전트에게 가는 명령(지시는 확인 대기 그대로) → 메인이 revise_directive로 회차 2·새 작업 ID
 *   (이전 회차 작업·보고서 유지), 2회차 결과가 main에 반영,
 *   2회차 보고서 승인 뒤 지시 종료, 개인 업무일지 무변경
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Directive } from '@shared/domain';
import { eventsFile } from '../../src/main/orchestrator/paths';
import { bootReal, realMode } from './serverMode';

const ENABLED = process.env.WOOK_REAL_FEEDBACK === '1';
const MODE = realMode();
const WORKLOG = join(homedir(), 'Documents', 'Obsidian Vault', '업무일지');
const NAME = '실제 수정 요청 점검';

/** 업무일지 폴더의 파일별 내용 (다른 세션도 같은 일지를 쓸 수 있어 수정 시각이 아니라 이번 실행의 흔적으로 판정한다) */
function snapshotTexts(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.set(p, readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

function addedLines(before: Map<string, string>, after: Map<string, string>): string[] {
  const added: string[] = [];
  for (const [f, text] of after) {
    const old = new Set((before.get(f) ?? '').split(/\r?\n/));
    for (const line of text.split(/\r?\n/)) if (!old.has(line)) added.push(line);
  }
  return added;
}

describe.skipIf(!ENABLED)(`실제 AI로 수정 요청까지 (WOOK_REAL_FEEDBACK=1, ${MODE} 모드)`, () => {
  it('실제 메인 에이전트·프로듀서(Claude)와 개발자(Codex)가 보고 → 수정 요청 → 2회차 → 승인까지 권한 확인 없이 끝낸다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-real-fb-data-'));
    const projectDir = join(mkdtempSync(join(tmpdir(), 'wook-real-fb-proj-')), NAME);
    const before = snapshotTexts(WORKLOG);
    // 운영 설정(메인 에이전트 실제 Claude sonnet)은 데스크톱이면 개발 모드 로그인 뒤 운영자 내부 API로, 서버면 시작 전에 (serverMode.ts)
    const app = await bootReal({
      mode: MODE,
      dataDir,
      settings: {
        developer: { mainAgentMock: false },
        general: { mainAgent: { kind: 'claude', model: 'sonnet', effortTier: 'normal', effortOverride: null } },
      },
      logger: (level, msg, extra) => {
        if (level !== 'info') console.error(`[${level}] ${msg}`, extra ?? '');
      },
    });
    if ('skip' in app) throw new Error(app.skip);
    const { core, invoke, internal } = app;
    const recent = (n: number) =>
      core.ctx.store.activity.search({ limit: n }).map((a) => `${a.ts.slice(11, 19)} ${a.kind} ${a.text.slice(0, 160)}`).join('\n');

    /**
     * 대표가 할 일을 대표 대신 처리한다: 메인 에이전트는 모호하면 대표에게 묻는다(CMD-05) — 그대로 진행하라고 답한다.
     * 대표 검수는 없다 (v0.6) — 적격 검수 팀원이 없으면 실제 메인 에이전트가 검수 세션에서 검수한다 (REV-06)
     */
    let ownerAnswers = 0;
    const ownerDuties = async () => {
      for (const q of core.ctx.store.questions.list({ state: 'open' })) {
        if (q.to !== 'owner') continue;
        await invoke('questions.answer', q.id, '처음 말한 대로 바로 진행해 주세요.');
        ownerAnswers++;
      }
    };

    /** 지시가 조건을 만족할 때까지 기다린다. 대표 할 일은 대신 처리하고, 작업이 보류되면 바로 실패한다. */
    const waitDirective = async (pick: () => Directive | undefined, done: (d: Directive) => boolean, label: string, minutes: number) => {
      const deadline = Date.now() + minutes * 60_000;
      for (;;) {
        await ownerDuties();
        const d = pick();
        if (d && done(d)) return d;
        const held = core.ctx.store.tasks.list({ state: 'on_hold' });
        if (held.length) throw new Error(`${label}: 작업 보류 ${held.map((t) => `${t.id} ${t.hold.reasons.map((r) => `${r.kind}:${r.note}`).join(', ')}`).join(' / ')}\n${recent(40)}`);
        if (Date.now() > deadline) throw new Error(`${label}: 시간 초과 (지시 ${d?.id ?? '없음'} ${d?.state ?? ''} 회차 ${d?.round ?? ''})\n${recent(40)}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    // 설정·팀 준비는 운영자 내부 API로 (SERVER_DESIGN 10.11 AC-28·50)
    try {
      const p = await internal('projects.create', { mode: 'new', path: projectDir, name: NAME, checkCommands: [] });
      await internal('members.update', p.producerId, { ai: { kind: 'claude', model: 'sonnet', effortTier: 'normal' } });
      const dev = await internal('members.add', { projectId: p.id, roleId: 'developer', ai: { kind: 'codex', model: null, effortTier: 'normal' } });
      // 대표 고정은 없앴다 (v0.6) — 운영자가 정한 AI로 기록되고, 운영자가 넣은 팀원에게는 메인 AI 결정 요청이 가지 않는다
      expect(core.ctx.store.members.require(dev.id).aiDecision?.by).toBe('operator');

      // 1회차
      const known = new Set(core.ctx.store.directives.list().map((d) => d.id));
      await invoke('command.send', {
        target: p.id,
        text: `README.md 파일을 만들어서 프로젝트 이름(${NAME})과 한 줄 소개를 적어 줘. 개발자 한 명이 하는 아주 작은 작업이야. 질문 없이 바로 진행해 줘.`,
      });
      const pickNew = () => core.ctx.store.directives.list().find((x) => !known.has(x.id));
      const d1 = await waitDirective(pickNew, (d) => d.state === 'awaiting_confirmation', '1회차', 25);
      const did = d1.id;
      expect(d1.round).toBe(1);
      const round1Tasks = core.ctx.store.tasks.list({ ref1: did });
      expect(round1Tasks.length).toBeGreaterThan(0);
      expect(round1Tasks.every((t) => t.state === 'done' && t.round === 1)).toBe(true);
      const r1 = core.ctx.store.reports.list({ ref1: did }).find((r) => r.round === 1);
      expect(r1, '1회차 보고서').toBeDefined();
      expect(existsSync(r1!.filePath)).toBe(true);
      const readme1 = execFileSync('git', ['-C', projectDir, 'show', 'main:README.md'], { encoding: 'utf8' });
      expect(readme1).toContain(NAME);

      // 수정 요청 (FBK-02·03 v0.6): 메인 에이전트에게 가는 명령 — 지시는 확인 대기 그대로이고, 메인이 revise_directive로 회차 2를 연다
      await invoke('reports.requestChanges', r1!.id, {
        overall: 'README.md에 "## 사용 방법" 절을 추가하고, 그 아래에 이 저장소를 어떻게 쓰는지 한 줄로 적어 주세요.',
        anchored: [],
      });
      expect(core.ctx.store.directives.require(did)).toMatchObject({ round: 1, state: 'awaiting_confirmation' });
      expect(core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).some((q) => q.kind === 'change_request' && q.directiveId === did)).toBe(true);
      expect(core.ctx.store.reports.require(r1!.id).status).toBe('changes_requested');
      const afterRequest = await waitDirective(() => core.ctx.store.directives.require(did), (d) => d.round === 2, '메인 에이전트가 2회차를 엶', 15);
      expect(afterRequest.round).toBe(2);
      expect(core.ctx.store.transitions.list(did).find((x) => x.event === 'request_changes')).toMatchObject({ from: 'awaiting_confirmation', to: 'planning', actor: MAIN_AGENT_ID });

      const d2 = await waitDirective(() => core.ctx.store.directives.require(did), (d) => d.round === 2 && d.state === 'awaiting_confirmation', '2회차', 25);
      const allTasks = core.ctx.store.tasks.list({ ref1: did });
      const round1Ids = new Set(round1Tasks.map((t) => t.id));
      const round2Tasks = allTasks.filter((t) => t.round === 2);
      expect(round2Tasks.length, '2회차 작업').toBeGreaterThan(0);
      expect(round2Tasks.every((t) => !round1Ids.has(t.id) && t.state === 'done')).toBe(true);
      for (const t of round1Tasks) expect(core.ctx.store.tasks.require(t.id).state).toBe('done');
      const reports = core.ctx.store.reports.list({ ref1: did });
      const r2 = reports.find((r) => r.round === 2);
      expect(r2, '2회차 보고서').toBeDefined();
      expect(r2!.id).not.toBe(r1!.id);
      expect(existsSync(r1!.filePath), '1회차 보고서 파일 유지').toBe(true);
      expect(existsSync(r2!.filePath)).toBe(true);
      expect(d2.rounds.map((r) => r.round)).toEqual([1, 2]);
      const readme2 = execFileSync('git', ['-C', projectDir, 'show', 'main:README.md'], { encoding: 'utf8' });
      expect(readme2).toContain(NAME);
      expect(readme2).toMatch(/사용 방법/);

      // 결과 승인 (FBK-01): 사후 확인 → 지시 종료
      await invoke('reports.approve', r2!.id, '좋습니다.');
      expect(core.ctx.store.reports.require(r2!.id).status).toBe('approved');
      expect(core.ctx.store.directives.require(did).state).toBe('closed');

      // 승인 뒤 메인 에이전트가 대표 선호를 프로젝트 기억에 반영하는 턴(FBK-05) 등이 끝날 때까지 기다린 뒤,
      // 모든 턴이 권한 확인 없이 끝났는지 본다
      const settleBy = Date.now() + 10 * 60_000;
      while (core.ctx.store.turns.list().some((t) => t.endReason === null)) {
        if (Date.now() > settleBy) {
          const live = core.ctx.store.turns.list().filter((t) => t.endReason === null).map((t) => `${t.id} ${t.memberId} ${t.sessionId}`);
          throw new Error(`승인 뒤 턴이 끝나지 않음: ${live.join(', ')}\n${recent(30)}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      const turns = core.ctx.store.turns.list();
      expect(turns.length).toBeGreaterThan(0);
      for (const t of turns) expect(t.endReason === 'completed' || t.endReason === 'user_stop', `턴 ${t.id} ${t.endReason}`).toBe(true);
      const devTurns = turns.filter((t) => t.memberId === dev.id);
      expect(devTurns.length).toBeGreaterThan(0);
      expect(devTurns.every((t) => core.ctx.store.sessions.get(t.sessionId)?.aiKind === 'codex')).toBe(true);
      // 개인 업무일지: 턴 기록에 일지 경로가 없고, 일지에 이번 실행의 흔적이 없다
      for (const t of turns) {
        const file = eventsFile(core.ctx.paths, t.memberId, t.sessionId, t.id);
        const ev = existsSync(file) ? readFileSync(file, 'utf8') : '';
        expect(/Obsidian Vault|[\\/]업무일지[\\/]/i.test(ev), `턴 ${t.id} 기록에 업무일지 경로`).toBe(false);
      }
      const added = addedLines(before, snapshotTexts(WORKLOG));
      expect(added.filter((l) => new RegExp(`${NAME}|wook-real-fb|사용 방법" 절`).test(l))).toEqual([]);
      const mainReviews = core.ctx.store.reviews.list().filter((r) => r.reviewerId === MAIN_AGENT_ID).length;
      console.log(`실제 수정 요청 점검 (${app.mode} 모드): 지시 ${did}, 1회차 작업 ${round1Tasks.length}개, 2회차 작업 ${round2Tasks.length}개, 턴 ${turns.length}개, 보고서 ${r1!.id} → ${r2!.id}, 메인 검수 ${mainReviews}번, 대표 답변 ${ownerAnswers}번`);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(join(projectDir, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60 * 60_000);
});
