/**
 * 대표의 모의 체험 (리드 결정 S9-9 — `scripts\try-server.cmd mock`이 vitest.try.config.ts로 WOOK_TRY=1을 주고 부른다). 시험이 아니라 체험 무대다:
 * - 웹 시험의 무대(tests/web/rig.ts startRig)를 그대로 쓴다: 프로세스 안 서버(서버 모드 하네스 — 모의 메인 에이전트를 시작 전에 켠다, 모의 프로젝트 3개),
 *   가짜 구글(로그인을 이 무대가 대신 승인한다), https 중계, Edge. AI를 부르지 않고 비밀 값은 메모리에만 둔다
 * - 사람이 쓰는 창(headless 아님)은 Edge 창을 닫을 때까지 기다린 뒤 모두 닫는다. 점검(WOOK_TRY_SMOKE=1)은 로그인한 홈과 연결을 보고 바로 닫는다
 * - 끝에 메인 에이전트의 턴이 모두 모의였는지 본다 (리드 결정 S6-19). 점검은 턴이 하나도 없어야 한다
 * WOOK_TRY가 없으면 아무것도 하지 않는다 (도구 밖에서 이 설정을 돌려도 창이 뜨지 않게)
 */
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { connectionOpen, startRig, type Rig } from '../web/rig';

const ON = process.env['WOOK_TRY'] === '1';
const HEADLESS = process.env['WOOK_TRY_HEADLESS'] === '1';
const SMOKE = process.env['WOOK_TRY_SMOKE'] === '1';
/** 대표에게 보이는 한 줄 — vitest의 console 가로채기를 거치지 않고 이 창에 바로 쓴다 */
const say = (text: string): void => void process.stdout.write(`[모의 체험] ${text}\n`);

describe.skipIf(!ON)('모의 체험 (try-server.cmd mock)', () => {
  it(SMOKE ? '점검: 모의 무대의 로그인한 홈이 열리고 시작된 턴이 없다' : '모의 체험 — Edge 창을 닫을 때까지', async () => {
    const webDir = process.env['WOOK_TRY_WEB_DIR'];
    if (!webDir) throw new Error('WOOK_TRY_WEB_DIR가 없습니다 — scripts\\try-server.cmd mock으로 실행하세요');
    let rig: Rig | null = null;
    try {
      rig = await startRig(webDir, { headless: HEADLESS, keepOpen: !HEADLESS });
      const { page, context } = await rig.open();
      await rig.login(page, SMOKE ? '/?studio3d=0' : '/');
      if (SMOKE) {
        expect(await page.getByRole('heading', { name: '프로젝트 현황' }).isVisible()).toBe(true);
        expect(await connectionOpen(page)).toBeTruthy();
        expect(rig.h.core.ctx.store.turns.list().map((t) => t.id)).toEqual([]);
        say('모의 무대: 로그인한 홈(프로젝트 현황)이 열렸고 실시간 연결이 열렸습니다. 시작된 턴은 없습니다');
        return;
      }
      say('모의 무대가 열렸습니다 — 가짜 구글 로그인을 마친 홈입니다. Edge 창을 닫으면 끝납니다');
      await new Promise<void>((resolve) => {
        const done = (): void => {
          if (context.pages().length === 0) resolve();
        };
        page.on('close', done);
        context.on('page', (p) => p.on('close', done));
        rig!.browser.on('disconnected', () => resolve());
      });
      say('Edge 창을 닫았습니다 — 모의 무대를 닫습니다');
    } finally {
      const mainTurns = rig?.h.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }) ?? [];
      await rig?.close();
      // 메인 에이전트의 턴은 모두 모의여야 한다 (실제 CLI가 뜨지 않았다)
      expect(mainTurns.filter((t) => !t.mock).map((t) => t.id)).toEqual([]);
    }
  });
});
