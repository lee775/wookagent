/**
 * 메인 운영 조작 알림은 대상마다 따로 (리드 결정 S5-13): 역할·스킬·설정 조작에는 작업·팀원·지시·프로젝트 ID가 없어 예전에는 그 도구의 알림이 모두 한 키
 * (`main-op:<도구>:`)를 나눠 썼다 — 같은 키의 읽지 않은 알림은 새 내용으로 덮이므로 앞의 조작이 대표에게 닿지 않았다. 이제 키에 대상(역할 ID·스킬 이름·
 * 바뀐 설정 항목)이 붙어 만들기·고치기·지우기가 모두 대표에게 닿는다. 같은 대상을 다시 고치면 그 알림이 새 내용으로 갱신된다(예전 규칙 그대로)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bootOrch, notices, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const role = (name: string) => ({ name, instructions: `${name} 일을 한다`, task_types: ['asset'], default_ai: { kind: 'claude', effort_tier: 'normal' }, can_review: false });
const unread = (e: OrchEnv) => notices(e, '메인 에이전트 조작').filter((n) => !n.readAt);
const keyed = (e: OrchEnv) => unread(e).map((n) => [n.key, n.body]);

describe('메인 운영 조작 알림의 키 (S5-13)', () => {
  it('역할을 만들고·고치고·지우면 역할마다 조작마다 알림이 따로 남는다 — 같은 역할을 다시 고치면 그 알림만 갱신된다', async () => {
    const e = (env = await bootOrch());
    const a = String((await e.main('create_role', { ...role('사운드'), reason: '대표 명령: 사운드' })).roleId);
    const b = String((await e.main('create_role', { ...role('3D 모델'), reason: '대표 명령: 3D' })).roleId);
    await e.main('update_role', { role_id: a, instructions: '배경음도 만든다', reason: '배경음 추가' });
    await e.main('update_role', { role_id: 'docs', instructions: '짧게', reason: '문서 짧게' });
    await e.main('delete_role', { role_id: b, reason: '3D는 하지 않음' });
    expect(keyed(e)).toEqual(
      expect.arrayContaining([
        [`main-op:create_role:${a}`, '역할 추가 사운드 — 사유: 대표 명령: 사운드'],
        [`main-op:create_role:${b}`, '역할 추가 3D 모델 — 사유: 대표 명령: 3D'],
        [`main-op:update_role:${a}`, `역할 수정 ${a} 사운드 — 사유: 배경음 추가`],
        ['main-op:update_role:docs', '역할 수정 docs 문서 담당 — 사유: 문서 짧게'],
        [`main-op:delete_role:${b}`, `역할 삭제 ${b} 3D 모델 — 사유: 3D는 하지 않음`],
      ]),
    );
    expect(unread(e)).toHaveLength(5);
    // 같은 역할을 다시 고치면 그 역할의 고치기 알림이 새 내용으로 (새 알림을 쌓지 않는다)
    await e.main('update_role', { role_id: a, can_review: true, reason: '검수도 맡김' });
    expect(unread(e)).toHaveLength(5);
    expect(unread(e).find((n) => n.key === `main-op:update_role:${a}`)!.body).toBe(`역할 수정 ${a} 사운드 (검수 권한 부여) — 사유: 검수도 맡김`);
  });

  it('운영 설정은 바뀐 항목마다, 스킬 구분은 스킬마다 알림이 따로 남는다', async () => {
    const e = (env = await bootOrch());
    await e.main('update_settings', { patch: { execution: { maxConcurrent: 4 } }, reason: '동시 실행 4' });
    await e.main('update_settings', { patch: { general: { backup: { keep: 5 } } }, reason: '백업 5개' });
    await e.main('update_settings', { patch: { general: { backup: { keep: 5 } }, execution: { maxConcurrent: 3 } }, reason: '둘 다' });
    await e.main('set_skill_mode', { name: 'some-skill', mode: 'manual', reason: '수동으로' });
    await e.main('set_skill_mode', { name: 'sound-gen', mode: 'auto', reason: '자동으로' });
    expect(keyed(e)).toEqual(
      expect.arrayContaining([
        ['main-op:update_settings:execution.maxConcurrent', '운영 설정 변경 (execution.maxConcurrent) — 사유: 동시 실행 4'],
        ['main-op:update_settings:general.backup.keep', '운영 설정 변경 (general.backup.keep) — 사유: 백업 5개'],
        ['main-op:update_settings:execution.maxConcurrent,general.backup.keep', '운영 설정 변경 (general.backup.keep, execution.maxConcurrent) — 사유: 둘 다'],
        ['main-op:set_skill_mode:some-skill', '스킬 some-skill → 수동 — 사유: 수동으로'],
        ['main-op:set_skill_mode:sound-gen', '스킬 sound-gen → 자동 — 사유: 자동으로'],
      ]),
    );
    expect(unread(e)).toHaveLength(5);
    // 같은 항목을 다시 바꾸면 그 알림이 갱신된다
    await e.main('update_settings', { patch: { execution: { maxConcurrent: 5 } }, reason: '동시 실행 5' });
    expect(unread(e)).toHaveLength(5);
    expect(unread(e).find((n) => n.key === 'main-op:update_settings:execution.maxConcurrent')!.body).toBe('운영 설정 변경 (execution.maxConcurrent) — 사유: 동시 실행 5');
  });
});
