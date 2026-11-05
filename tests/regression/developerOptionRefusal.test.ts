/**
 * 대표 게이트가 개발자 옵션을 거부하는 글은 사실대로 (리드 결정 40, 10-30 — owner-surface 4차 재리뷰 '결함으로 올리지 않은 것' 2):
 * - 데스크톱 대표 세션의 settings.update에 개발자 옵션(모의 실행 끄기 밖, 예: developer.mockSpeed)이 섞이면 게이트가 거부하면서 '운영 설정(…)은 메인 에이전트가
 *   바꿉니다 … 명령창으로 메인 에이전트에게 말하세요'라고 했다. 메인 에이전트도 개발자 옵션은 바꾸지 못한다(update_settings가 거부) — 거짓 안내였다
 * - 이제 개발자 옵션은 대표 화면에서 바꾸지 않는다고 말하고 메인에게 말하라는 안내를 붙이지 않는다. 메인 에이전트 몫 항목이 함께 섞이면 그 항목은 예전처럼
 *   메인 에이전트가 바꾼다고 말한다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ownerRefusal } from '../../src/main/backend/ownerGate';
import type { OrchEnv } from './orchHarness';
import { bootOrch } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const messageOf = (p: Promise<unknown>) => p.then(() => 'ok', (x: Error & { code?: string }) => `${x.code}: ${x.message}`);

describe('개발자 옵션 거부 글은 메인 에이전트가 바꾼다고 하지 않는다 (리드 결정 40)', () => {
  it('개발자 옵션만: 대표 화면에서 바꾸지 않는다고 말하고 메인에게 말하라는 안내가 없다 — 메인 에이전트도 거부된다', async () => {
    const e = (env = await bootOrch());
    const before = e.ctx.settings().developer.mockSpeed;
    expect(await messageOf(e.invoke('settings.update', { developer: { mockSpeed: 5 } }))).toBe(
      'forbidden: 개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다 (settings.update).',
    );
    expect(await messageOf(e.invoke('settings.update', { developer: { mainAgentMock: false, mockSpeed: 5 } }))).toBe(
      'forbidden: 개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다 (settings.update).',
    );
    // 그 안내가 맞는다 — 메인 에이전트의 update_settings도 개발자 옵션을 거부한다
    await expect(e.main('update_settings', { patch: { developer: { mockSpeed: 5 } }, reason: '시험' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(e.ctx.settings().developer.mockSpeed).toBe(before);
    expect(e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부: settings.update', limit: 10 }).map((a) => a.result)).toEqual([
      '개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다',
      '개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다',
    ]);
  });

  it('메인 에이전트 몫 항목이 섞이면 그 항목은 메인 에이전트가 바꾼다고 말하고, 개발자 옵션은 따로 말한다', () => {
    expect(ownerRefusal('settings.update', [{ execution: { maxConcurrent: 4 }, developer: { mockSpeed: 5 } }], 'desktop')).toBe(
      '운영 설정(execution)은 메인 에이전트가 바꿉니다. 개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다',
    );
    expect(ownerRefusal('settings.update', [{ execution: { maxConcurrent: 4 } }], 'desktop')).toBe('운영 설정(execution)은 메인 에이전트가 바꿉니다');
    // 개발자 옵션을 통째로 바꾸려는 요청도 개발자 옵션이다
    expect(ownerRefusal('settings.update', [{ developer: false }], 'desktop')).toBe('개발자 옵션(developer)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다');
  });
});
