/**
 * 실제 Claude·Codex 팀으로 작은 지시를 끝까지 (기획서 1차-B, AC-28·AC-50). 사용량이 드는 실행이라 기본 테스트에서는 건너뛴다.
 *   WOOK_REAL_TEAM=1 npx vitest run tests/real/realTeam.test.ts
 *   서버 모드(리드 결정 S9-10): WOOK_REAL_MODE=server를 더한다 — 프로세스 안 서버를 열고 대표 호출을 운영자 시험 세션(Bearer)의 HTTP로 보낸다(serverMode.ts).
 *   확인은 두 모드가 같다. 서버 모드는 모의 메인 에이전트를 시작 전에 켠다
 * - 메인 에이전트는 모의(지시 등록만), 프로듀서는 실제 Claude(sonnet), 개발자는 실제 Codex — 둘 다 운영자가 정한 AI (대표 고정은 v0.6에서 없앰)
 * - 확인: 권한 확인 없이 첫 턴·이어하기, 앱 도구로 단계·제출·검수·병합, main에 결과, 개인 업무일지 무변경, Codex 훅 경고 없음
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { eventsFile } from '../../src/main/orchestrator/paths';
import { bootReal, realMode } from './serverMode';

const ENABLED = process.env.WOOK_REAL_TEAM === '1';
const MODE = realMode();
const WORKLOG = join(homedir(), 'Documents', 'Obsidian Vault', '업무일지');

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

/** 실행 전후로 새로 생긴 줄 */
function addedLines(before: Map<string, string>, after: Map<string, string>): string[] {
  const added: string[] = [];
  for (const [f, text] of after) {
    const old = new Set((before.get(f) ?? '').split(/\r?\n/));
    for (const line of text.split(/\r?\n/)) if (!old.has(line)) added.push(line);
  }
  return added;
}

describe.skipIf(!ENABLED)(`실제 Claude·Codex 팀 (WOOK_REAL_TEAM=1, ${MODE} 모드)`, () => {
  it('Claude 프로듀서 + Codex 개발자가 작은 지시를 권한 확인 없이 끝내고, 개인 업무일지는 건드리지 않는다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-real-data-'));
    const projectDir = join(mkdtempSync(join(tmpdir(), 'wook-real-proj-')), '실제 Codex 점검');
    const before = snapshotTexts(WORKLOG);
    // 모의 메인 에이전트 — 데스크톱이면 개발 모드 로그인 뒤 운영자 내부 API로, 서버면 시작 전에 (serverMode.ts)
    const app = await bootReal({
      mode: MODE,
      dataDir,
      settings: { developer: { mainAgentMock: true, mockSpeed: 5 } },
      logger: (level, msg, extra) => {
        if (level !== 'info') console.error(`[${level}] ${msg}`, extra ?? '');
      },
    });
    if ('skip' in app) throw new Error(app.skip);
    const { core, invoke, internal } = app;
    // 설정·팀 준비는 운영자 내부 API로 (SERVER_DESIGN 10.11 AC-28·50)
    try {
      const p = await internal('projects.create', { mode: 'new', path: projectDir, name: '실제 Codex 점검', checkCommands: [] });
      await internal('members.update', p.producerId, { ai: { kind: 'claude', model: 'sonnet', effortTier: 'normal' } });
      const dev = await internal('members.add', { projectId: p.id, roleId: 'developer', ai: { kind: 'codex', model: null, effortTier: 'normal' } });
      // 대표 고정은 없앴다 (v0.6) — 운영자가 정한 AI로 기록되고, 운영자가 넣은 팀원에게는 메인 AI 결정 요청이 가지 않는다
      expect(core.ctx.store.members.require(dev.id).aiDecision?.by).toBe('operator');

      const known = new Set(core.ctx.store.directives.list().map((d) => d.id));
      await invoke('command.send', { target: p.id, text: 'README.md 파일을 만들어서 프로젝트 이름(실제 Codex 점검)과 한 줄 소개를 적어 줘. 개발자 한 명이 하는 아주 작은 작업이야.' });
      const deadline = Date.now() + 18 * 60_000;
      let did = '';
      for (;;) {
        const d = core.ctx.store.directives.list().find((x) => !known.has(x.id));
        if (d) did = d.id;
        const state = d?.state;
        if (state === 'awaiting_confirmation') break;
        const held = core.ctx.store.tasks.list({ state: 'on_hold' });
        if (held.length) throw new Error(`작업 보류: ${held.map((t) => `${t.id} ${t.hold.reasons.map((r) => `${r.kind}:${r.note}`).join(', ')}`).join(' / ')}`);
        if (Date.now() > deadline) {
          const acts = core.ctx.store.activity.search({ limit: 40 }).map((a) => `${a.ts.slice(11, 19)} ${a.kind} ${a.text.slice(0, 160)}`);
          throw new Error(`시간 초과 (지시 ${did} ${state ?? '없음'})\n${acts.join('\n')}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      const tasks = core.ctx.store.tasks.list({ ref1: did });
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((t) => t.state === 'done')).toBe(true);
      // 개발자 작업은 Codex 턴으로 실행됐고, 권한 확인 거부 없이 끝났다
      const devTurns = core.ctx.store.turns.list().filter((t) => t.memberId === dev.id);
      expect(devTurns.length).toBeGreaterThan(0);
      const sessions = devTurns.map((t) => core.ctx.store.sessions.get(t.sessionId)!);
      expect(sessions.every((s) => s.aiKind === 'codex')).toBe(true);
      for (const t of devTurns) expect(t.endReason === 'completed' || t.endReason === 'user_stop').toBe(true);
      // main에 README가 들어갔다
      const readme = execFileSync('git', ['-C', projectDir, 'show', 'main:README.md'], { encoding: 'utf8' });
      expect(readme).toContain('실제 Codex 점검');
      // 개인 업무일지: 팀원 턴의 명령·파일 변경 기록에 일지(Obsidian) 경로가 없고, 일지에 이번 실행의 흔적이 없다
      const allTurns = core.ctx.store.turns.list();
      for (const t of allTurns) {
        const file = eventsFile(core.ctx.paths, t.memberId, t.sessionId, t.id);
        const ev = existsSync(file) ? readFileSync(file, 'utf8') : '';
        expect(/Obsidian Vault|[\\/]업무일지[\\/]/i.test(ev), `턴 ${t.id} 기록에 업무일지 경로`).toBe(false);
      }
      const added = addedLines(before, snapshotTexts(WORKLOG));
      expect(added.filter((l) => /실제 Codex 점검|wook-real|README\.md 파일을 만들어/.test(l))).toEqual([]);
      // Codex 이벤트에 훅 경고가 없다
      for (const t of devTurns) {
        const file = eventsFile(core.ctx.paths, t.memberId, t.sessionId, t.id);
        const ev = existsSync(file) ? readFileSync(file, 'utf8') : '';
        expect(/clamping .*hook/i.test(ev)).toBe(false);
      }
      const report = core.ctx.store.reports.list({ ref1: did })[0];
      expect(report).toBeDefined();
      // 메인 에이전트는 모의다 — 실제 메인 CLI가 뜨지 않았다 (리드 결정 S6-19)
      expect(allTurns.filter((t) => t.memberId === MAIN_AGENT_ID && !t.mock).map((t) => t.id)).toEqual([]);
      console.log(`실제 팀 점검 (${app.mode} 모드): 지시 ${did}, 작업 ${tasks.length}개, 개발자 턴 ${devTurns.length}개, 보고서 ${report!.id}`);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(join(projectDir, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 20 * 60_000);
});
