/**
 * 실제 Claude·Codex 메인이 화면 이미지를 보는지 (SERVER_DESIGN 8.3.4·10.6 '실제 보유자', 리드 결정 S6-10·S6-13). 사용량이 드는 실행이라 기본 테스트에서는 건너뛴다.
 *   WOOK_REAL_GUI=1 npx vitest run tests/real/realGui.test.ts
 * - 메인 에이전트만 실제 CLI로 띄운다(다른 팀원 없음). 시작하면 서버가 화면 확인 업무를 넣고, 그 턴이 get_screen_check의 시험 이미지(서버가 그린 네 자리 숫자 —
 *   화면 캡처가 아니다)를 받아 answer_screen_check로 답한다. 결과(verified·failed)가 그 CLI 버전의 '본다' 표시의 근거다 — 이 시험은 결과를 적는다
 * - 화면 도우미는 가짜이고 잠긴 화면이다: 실제 메인이 screen_capture·gui_input을 불러도 unavailable이라 이 PC의 화면을 찍거나 입력을 보내지 않는다
 * - 이벤트 파일에 시험 이미지의 바이트가 남지 않는다 (core/imageStrip.ts)
 * 에이전트는 이 시험을 돌리지 않는다 (리드 결정 S6-15). 이 파일은 불러올 때 아무것도 하지 않는다
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiKind } from '@shared/domain';
import { createFakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import { createOrchestrator } from '../../src/main/orchestrator/orchestrator';
import { eventsFile } from '../../src/main/orchestrator/paths';

const ENABLED = process.env.WOOK_REAL_GUI === '1';
const WAIT_MS = 8 * 60_000;

describe.skipIf(!ENABLED)('실제 메인의 화면 보기 확인 (WOOK_REAL_GUI=1)', () => {
  for (const kind of ['claude', 'codex'] as AiKind[]) {
    it(`${kind} 메인이 시험 이미지의 숫자를 답한다 — 결과를 적고, 이벤트 파일에 이미지 바이트가 없다`, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'wook-real-gui-data-'));
      const workRoot = mkdtempSync(join(tmpdir(), 'wook-real-gui-work-'));
      // 가짜 화면 도우미, 잠긴 화면 — 캡처·입력은 unavailable이다 (이 PC의 화면을 건드리지 않는다)
      const fake = createFakeDesktop({ lock: 'locked' });
      const deps = await buildOrchestratorDeps({
        dataDir,
        appRoot: process.cwd(),
        isPackaged: false,
        nodeExecPath: process.execPath,
        nodeExecEnv: {},
        shell: null,
        memorySecrets: true,
        workspaceRoot: workRoot,
        desktop: { launcher: fake.launcher },
        logger: (level, msg, extra) => {
          if (level !== 'info') console.error(`[${level}] ${msg}`, extra ?? '');
        },
      });
      const status = await deps.adapters[kind].detect();
      if (!status.installed || status.loggedIn === false) {
        deps.store.close();
        deps.runner.dispose?.();
        console.log(`[WOOK_REAL_GUI] ${kind}: 건너뜀 — ${status.detail}`);
        await fake.cleanup();
        return;
      }
      // 시작 전에 메인 자리의 처음 보유자를 이 CLI로 — 모의 실행은 끈다 (이 시험만 실제 메인을 띄운다)
      deps.store.kv.set('settings', { general: { mainAgent: { kind, model: null, effortTier: 'normal', effortOverride: null } }, developer: { mainAgentMock: false } });
      const orch = await createOrchestrator(deps);
      const core = orch.core;
      try {
        const deadline = Date.now() + WAIT_MS;
        while (core.ctx.store.seat.get('main')?.vision === 'unknown') {
          if (Date.now() > deadline) {
            const acts = core.ctx.store.activity.search({ limit: 30 }).map((a) => `${a.ts.slice(11, 19)} ${a.kind} ${a.text.slice(0, 160)}`);
            throw new Error(`시간 초과 — 화면 확인이 끝나지 않았습니다\n${acts.join('\n')}`);
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        const seat = core.ctx.store.seat.get('main')!;
        console.log(`[WOOK_REAL_GUI] ${kind} ${status.version ?? '버전 모름'}: vision ${seat.vision}`);
        expect(['verified', 'failed']).toContain(seat.vision);
        // 확인 턴은 실제 CLI였다
        const turns = core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
        expect(turns.length).toBeGreaterThan(0);
        expect(turns.every((t) => !t.mock && t.aiKind === kind)).toBe(true);
        // 이벤트 파일에 PNG의 base64가 없다 (시험 이미지는 저장하지 않는다)
        for (const t of turns) {
          const file = eventsFile(core.ctx.paths, t.memberId, t.sessionId, t.id);
          const ev = existsSync(file) ? readFileSync(file, 'utf8') : '';
          expect(ev.includes('iVBORw0KGgo'), `턴 ${t.id} 이벤트 파일에 이미지 바이트`).toBe(false);
        }
        // 잠긴 화면이라 캡처도 입력도 된 것이 없다 — 메인이 화면 도구를 불렀어도 unavailable이었다
        expect(core.ctx.store.guiActions.query({ results: ['ok', 'sent'], limit: 50 }).map((r) => r.action)).toEqual([]);
      } finally {
        await orch.stop().catch(() => undefined);
        await fake.cleanup();
        for (const d of [dataDir, workRoot]) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      }
    }, WAIT_MS + 60_000);
  }
});
