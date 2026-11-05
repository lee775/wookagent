/**
 * 원격 대표 길의 거부 글은 사실대로 (리드 결정 47·S3-12 — owner-surface 5차 재리뷰 프로브 zz-s1fix5-os-rr-remote-refusal-text를 옮김):
 * - 원격 길(서버 HTTP — OwnerSurface 'remote')은 데스크톱 운영자 메서드를 받지 않는다. 예전에는 그 거부에 '팀 운영·설정·작업 조작은 메인 에이전트가
 *   맡습니다 — 명령창으로 메인 에이전트에게 말하세요'를 붙였다. 모의 실행 끄기·API 키·구글 보안 비밀·메인 AI(general.mainAgent)·개발자 옵션은 메인
 *   에이전트도 하지 못한다(2.3·2.5·2.6) — 거짓 안내였다
 * - 이제 운영자 몫은 '설치·운영자 설정은 서버 PC의 운영자가 바꿉니다', 개발자 옵션·모의 실행은 개발·시험 전용이라고만 말한다. 메인 에이전트 몫 항목(운영
 *   설정)이 섞였을 때만 그 항목에 메인 안내를 붙인다
 * - 데스크톱 길의 글은 예전 그대로다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerInvoke, OPERATOR_ONLY_REMOTE, ownerRefusal } from '../../src/main/backend/ownerGate';
import type { OrchEnv } from './orchHarness';
import { bootOrch } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const TELL_MAIN = '명령창으로 메인 에이전트에게 말하세요';
const messageOf = (p: Promise<unknown>) => p.then(() => 'ok', (x: Error & { code?: string }) => `${x.code}: ${x.message}`);

describe('원격 길의 거부 글 (S3-12)', () => {
  it('메인 에이전트도 못 하는 운영자 몫을 거부할 때 메인에게 말하라고 하지 않는다 — 운영자 몫은 서버 PC의 운영자가 바꾼다고 말한다', async () => {
    const e = (env = await bootOrch());
    const remote = createOwnerInvoke(e.core, 'remote') as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    const calls: [string, unknown[], string][] = [
      ['projects.setMock', [e.projectId, { enabled: false }], '모의 실행은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다 (projects.setMock).'],
      ['settings.update', [{ developer: { mainAgentMock: false } }], '개발자 옵션(developer.mainAgentMock)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다 (settings.update).'],
      ['settings.update', [{ general: { mainAgent: { kind: 'codex' } } }], `${OPERATOR_ONLY_REMOTE} (settings.update).`],
      ['settings.update', [{ account: { googleClientId: 'x.apps.googleusercontent.com' } }], `${OPERATOR_ONLY_REMOTE} (settings.update).`],
      ['settings.setApiKey', ['claude', 'sk-test'], `${OPERATOR_ONLY_REMOTE} (settings.setApiKey).`],
      ['settings.setGoogleSecret', ['secret'], `${OPERATOR_ONLY_REMOTE} (settings.setGoogleSecret).`],
      ['auth.devLogin', [], '서버에는 개발 모드 로그인이 없습니다 — 기기 코드로 로그인합니다 (auth.devLogin).'],
    ];
    const got: string[] = [];
    for (const [m, args] of calls) got.push(await messageOf(remote(m, args)));
    expect(got).toEqual(calls.map(([, , text]) => `forbidden: ${text}`));
    for (const t of got) expect(t).not.toContain(TELL_MAIN);
    // 거부는 활동 기록에 남는다 (2.5) — 그 글도 같다 (인자는 남기지 않는다)
    const rows = e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부: settings.setApiKey', limit: 5 });
    expect(rows.map((r) => r.result)).toEqual([OPERATOR_ONLY_REMOTE]);
    expect(JSON.stringify(rows).includes('sk-test')).toBe(false);
  });

  it('메인 에이전트 몫 항목이 섞이면 그 항목만 메인 에이전트가 바꾼다고 말하고 메인 안내를 붙인다 — 대표 권한 밖의 팀 운영도 예전처럼 메인 안내', async () => {
    const e = (env = await bootOrch());
    const remote = createOwnerInvoke(e.core, 'remote') as unknown as (m: string, a: unknown[]) => Promise<unknown>;
    expect(await messageOf(remote('settings.update', [{ general: { mainAgent: { kind: 'codex' } }, execution: { maxConcurrent: 3 }, developer: { mockSpeed: 2 } }]))).toBe(
      `forbidden: ${OPERATOR_ONLY_REMOTE}. 운영 설정(execution)은 메인 에이전트가 바꿉니다. 개발자 옵션(developer.mockSpeed)은 대표 화면에서 바꾸지 않습니다 — 개발·시험 전용입니다 (settings.update). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    expect(await messageOf(remote('settings.update', [{ execution: { maxConcurrent: 3 } }]))).toBe(
      `forbidden: 운영 설정(execution)은 메인 에이전트가 바꿉니다 (settings.update). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    expect(await messageOf(remote('members.add', [{ projectId: e.projectId, roleId: 'developer' }]))).toBe(
      `forbidden: 대표 화면에서 하는 일이 아닙니다 (members.add). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    expect(ownerRefusal('settings.setApiKey', ['claude', 'k'], 'remote')).toBe(OPERATOR_ONLY_REMOTE);
  });

  it('데스크톱 길의 글은 예전 그대로다 — 운영자 몫은 받고, 메인 몫·팀 운영에는 메인 안내, 모의 실행 켜기·개발자 옵션에는 안내 없음', async () => {
    const e = (env = await bootOrch());
    expect(await messageOf(e.invoke('settings.update', { execution: { maxConcurrent: 3 } }))).toBe(
      `forbidden: 운영 설정(execution)은 메인 에이전트가 바꿉니다 (settings.update). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    expect(await messageOf(e.invoke('projects.setMock', e.projectId, { enabled: true }))).toBe(
      'forbidden: 모의 실행은 이 PC에서 끄기만 할 수 있습니다 — 켜는 것은 개발·시험 전용입니다 (projects.setMock).',
    );
    expect(await messageOf(e.invoke('members.add', { projectId: e.projectId, roleId: 'developer' }))).toBe(
      `forbidden: 대표 화면에서 하는 일이 아닙니다 (members.add). 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — ${TELL_MAIN}`,
    );
    expect(ownerRefusal('settings.setApiKey', ['claude', 'k'], 'desktop')).toBeNull();
    await expect(e.invoke('settings.update', { general: { mainAgent: { kind: 'codex' } } })).resolves.toBeDefined();
  });
});
