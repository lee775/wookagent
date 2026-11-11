/**
 * 대표 길의 인자 모양 (리드 결정 S3-13·S2-22): 대표 메서드와 데스크톱 운영자 메서드마다 모양이 하나씩 있고, 화면이 실제로 보내는 모양은 받고, 옵션 객체를
 * 빠뜨린 호출 같은 실수는 거부한다. 거부 글에는 넘긴 값이 들어가지 않는다. 같은 규칙을 게이트(ownerGate.ts)가 데스크톱 IPC와 서버 HTTP에 함께 쓴다 —
 * 그 길의 시험은 tests/server/argParity.test.ts
 */
import { describe, expect, it } from 'vitest';
import { DESKTOP_OPERATOR_METHODS, OWNER_METHODS } from '@shared/ipc';
import { OWNER_ARG_SHAPES, ownerArgProblem } from './ownerArgs';

describe('인자 모양 (S3-13)', () => {
  it('대표 메서드 44개와 데스크톱 운영자 메서드 5개에 모양이 하나씩 있고, 그 밖의 메서드에는 없다', () => {
    expect(Object.keys(OWNER_ARG_SHAPES).sort()).toEqual([...OWNER_METHODS, ...DESKTOP_OPERATOR_METHODS].sort());
    expect(Object.keys(OWNER_ARG_SHAPES)).toHaveLength(49);
    // 대표 세션이 부르지 못하는 메서드(게이트가 먼저 거부한다)는 모양을 보지 않는다
    expect(ownerArgProblem('members.add', [])).toBeNull();
  });

  it('화면이 실제로 보내는 모양은 받는다 — 선택 칸·선택 인자는 빠지거나 null이어도 된다 (JSON으로 오면 undefined가 null이 된다)', () => {
    const ok: [string, unknown[]][] = [
      ['auth.getState', []],
      ['auth.deviceLogin', []],
      ['auth.deviceLogin', [null]],
      ['auth.deviceLogin', ['Chrome · Windows']],
      ['auth.deviceLoginPoll', ['dl_1']],
      ['auth.setupOwner', ['ABCD-EFGH', 'owner@example.com']],
      ['auth.revokeDevice', ['ds_1']],
      ['members.getDetail', ['M-0001']],
      ['members.getEvents', ['M-0001', { turnId: 'TN-000001', limit: 40 }]],
      ['members.getEvents', ['M-0001', { turnId: undefined, cursor: null, limit: 40 }]],
      ['command.send', [{ target: 'main', text: '해 줘' }]],
      ['command.send', [{ target: 'P-0001', text: '해 줘', attachments: [{ path: 'C:/a.png', name: 'a.png' }, { name: '붙여 넣은 그림.png', dataUrl: 'data:image/png;base64,AA==', id: 'x', size: 1 }] }]],
      ['command.send', [{ target: 'main', text: '해 줘', attachments: [{ name: '사진.jpg', uploadId: 'up_0123456789abcdef0123456789abcdef' }] }]],
      ['command.history', ['main', { limit: 60 }]],
      ['questions.answer', ['Q-0001', '']],
      ['reports.list', [{ text: undefined, projectId: 'general', status: undefined }]],
      ['reports.list', [{ projectId: null }]],
      ['reports.approve', ['R-0001', '좋습니다']],
      ['reports.requestChanges', ['R-0001', { overall: '고쳐 주세요', anchored: [{ quote: '첫 줄', comment: '바꿔 주세요' }] }]],
      ['notifications.list', [{ limit: 50 }]],
      ['notifications.markRead', ['all']],
      ['logs.search', [{ limit: 100, text: '', from: '', to: '', projectId: undefined, level: undefined }]],
      ['logs.export', [{}]],
      ['system.recheckAi', ['codex']],
      ['system.openPath', ['C:/data']],
      ['settings.setApiKey', ['claude', null]],
      ['settings.setApiKey', ['codex', 'sk-key']],
      ['settings.setGoogleSecret', ['secret']],
      ['settings.update', [{ account: { googleClientId: 'x.apps.googleusercontent.com' } }]],
      ['projects.setMock', ['P-0001', { enabled: false }]],
      // 외부 에이전트 보기 (리드 결정 S7-2) — 인자 없음
      ['agents.list', []],
      // 남는 인자는 보지 않는다 — 처리기가 쓰지 않는다
      ['auth.getState', ['남는 인자']],
    ];
    expect(ok.map(([m, a]) => [m, ownerArgProblem(m, a)]).filter(([, p]) => p !== null)).toEqual([]);
  });

  it('옵션 객체를 빠뜨리거나 형식이 다른 인자는 거부한다 — 리뷰 프로브 zz-lc2-parity의 실수들', () => {
    const bad: [string, unknown[]][] = [
      ['members.getEvents', ['M-0001']],
      ['members.getEvents', ['M-0001', null]],
      ['command.history', ['P-0001']],
      ['notifications.list', []],
      ['reports.list', []],
      ['logs.search', []],
      ['logs.export', []],
      ['members.getDetail', [42]],
      ['members.getDetail', ['']],
      ['command.send', [{ text: '대상 없음' }]],
      ['command.send', [{ target: 'main', text: '첨부 이름 없음', attachments: [{ path: 'C:/a' }] }]],
      ['reports.requestChanges', ['R-0001', { overall: '코멘트 목록이 없음' }]],
      ['reports.approve', ['R-0001']],
      ['questions.answer', ['Q-0001', 3]],
      ['settings.setApiKey', ['gpt', 'k']],
      ['settings.setApiKey', ['claude']],
      ['system.recheckAi', ['x']],
      ['settings.update', ['patch']],
      ['settings.update', [[]]],
      ['projects.setMock', ['P-0001', {}]],
      ['logs.search', [{ level: 'debug' }]],
      ['auth.deviceLogin', [5]],
      ['auth.setupOwner', ['ABCD-EFGH']],
    ];
    expect(bad.filter(([m, a]) => ownerArgProblem(m, a) === null).map(([m, a]) => `${m} ${JSON.stringify(a)}`)).toEqual([]);
    expect(ownerArgProblem('members.getEvents', ['M-0001'])).toBe('인자가 2개 있어야 하는데 1개입니다');
    expect(ownerArgProblem('command.send', [{ target: 'main', text: 'x', attachments: [{ path: 'C:/a' }] }])).toBe('1번째 인자의 attachments[0].name 모양이 맞지 않습니다');
  });

  it('거부 글에는 넘긴 값이 들어가지 않는다 — 어느 인자의 어느 칸인지만', () => {
    const SECRET = 'sk-ant-api03-ArgShapeSecretValue77';
    const problems = [
      ownerArgProblem('members.getEvents', ['M-0001', { turnId: 7, cursor: SECRET, limit: SECRET }]),
      ownerArgProblem('questions.answer', [{ value: SECRET }, SECRET]),
      ownerArgProblem('settings.setApiKey', [SECRET, SECRET]),
    ];
    expect(problems.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
    expect(problems.join('\n').includes(SECRET)).toBe(false);
  });

  it('메인 자리·일지 보기 4개 (S4-13): 세대는 1 이상의 정수, 조건 칸은 타입 그대로, 쪽 크기 1~200, 다음 쪽 표시 200자까지 — 빠뜨린 선택 인자는 받는다', () => {
    const ok: [string, unknown[]][] = [
      ['seat.get', []],
      ['seat.history', []],
      ['seat.handover', []],
      ['seat.handover', [null]],
      ['seat.handover', [3]],
      ['journal.list', []],
      ['journal.list', [null]],
      ['journal.list', [{}]],
      ['journal.list', [{ projectId: null }]],
      [
        'journal.list',
        [{ projectId: 'P-0001', kinds: ['command', 'promise', 'rollup'], author: 'agent', generation: 2, openPromisesOnly: true, cursor: 'c'.repeat(200), limit: 200 }],
      ],
      ['journal.list', [{ limit: 1, cursor: undefined, kinds: [] }]],
    ];
    expect(ok.map(([m, a]) => [m, ownerArgProblem(m, a)]).filter(([, p]) => p !== null)).toEqual([]);
    const bad: [string, unknown[]][] = [
      ['seat.handover', [0]],
      ['seat.handover', [-1]],
      ['seat.handover', [1.5]],
      ['seat.handover', ['2']],
      ['journal.list', ['P-0001']],
      ['journal.list', [{ limit: 0 }]],
      ['journal.list', [{ limit: 201 }]],
      ['journal.list', [{ limit: 2.5 }]],
      ['journal.list', [{ cursor: 'c'.repeat(201) }]],
      ['journal.list', [{ kinds: ['secret'] }]],
      ['journal.list', [{ kinds: 'note' }]],
      ['journal.list', [{ author: 'owner' }]],
      ['journal.list', [{ generation: 0 }]],
      ['journal.list', [{ openPromisesOnly: 'yes' }]],
      ['journal.list', [{ projectId: '' }]],
      ['journal.list', [{ projectId: 7 }]],
    ];
    expect(bad.filter(([m, a]) => ownerArgProblem(m, a) === null).map(([m, a]) => `${m} ${JSON.stringify(a).slice(0, 60)}`)).toEqual([]);
    expect(ownerArgProblem('journal.list', [{ limit: 201 }])).toBe('1번째 인자의 limit 모양이 맞지 않습니다');
    expect(ownerArgProblem('seat.handover', [0])).toBe('1번째 인자 모양이 맞지 않습니다');
  });

  it('화면 조작 보기 2개 (S6-2): 쪽 크기 1~500의 정수, before는 40자까지, 이미지는 비지 않은 캡처 ID 하나 — 빠뜨린 선택 인자는 받는다', () => {
    const ok: [string, unknown[]][] = [
      ['screens.recent', []],
      ['screens.recent', [null]],
      ['screens.recent', [{}]],
      ['screens.recent', [{ limit: 1 }]],
      ['screens.recent', [{ limit: 500, before: 'b'.repeat(40) }]],
      ['screens.recent', [{ limit: null, before: undefined }]],
      ['screens.image', ['SC-000001']],
    ];
    expect(ok.map(([m, a]) => [m, ownerArgProblem(m, a)]).filter(([, p]) => p !== null)).toEqual([]);
    const bad: [string, unknown[]][] = [
      ['screens.recent', ['GA-000001']],
      ['screens.recent', [{ limit: 0 }]],
      ['screens.recent', [{ limit: 501 }]],
      ['screens.recent', [{ limit: 2.5 }]],
      ['screens.recent', [{ limit: '100' }]],
      ['screens.recent', [{ before: 'b'.repeat(41) }]],
      ['screens.recent', [{ before: 7 }]],
      ['screens.image', []],
      ['screens.image', ['']],
      ['screens.image', [7]],
    ];
    expect(bad.filter(([m, a]) => ownerArgProblem(m, a) === null).map(([m, a]) => `${m} ${JSON.stringify(a).slice(0, 60)}`)).toEqual([]);
    expect(ownerArgProblem('screens.recent', [{ limit: 501 }])).toBe('1번째 인자의 limit 모양이 맞지 않습니다');
    expect(ownerArgProblem('screens.image', [])).toBe('인자가 1개 있어야 하는데 0개입니다');
  });

  it('settings.update의 둘째 인자 (S4-25): 빠지거나 null이어도 되고, 있으면 { mainAgent?: AiConfig } 하나만 — 다른 칸·모양은 거부한다', () => {
    const main = { kind: 'claude', model: null, effortTier: 'high', effortOverride: null };
    const patch = { general: { mainAgent: { ...main, kind: 'codex' } } };
    const ok: unknown[][] = [
      [patch],
      [patch, null],
      [patch, undefined],
      [patch, {}],
      [patch, { mainAgent: main }],
      [patch, { mainAgent: null }],
      [patch, { mainAgent: { ...main, model: 'gpt-6-sol', effortTier: 'low', effortOverride: 'xhigh' } }],
    ];
    expect(ok.map((a) => ownerArgProblem('settings.update', a)).filter((p) => p !== null)).toEqual([]);
    const bad: unknown[][] = [
      [patch, { mainAgent: main, base: main }],
      [patch, { other: 1 }],
      [patch, 'claude'],
      [patch, [main]],
      [patch, { mainAgent: 'claude' }],
      [patch, { mainAgent: { ...main, kind: 'gpt' } }],
      [patch, { mainAgent: { ...main, effortTier: 'max' } }],
      [patch, { mainAgent: { ...main, model: 5 } }],
      [patch, { mainAgent: { model: null, effortTier: 'high' } }],
      // 따로 정한 노력치는 글자다 (리드 결정 S4-35 3번, 탐침 G5)
      [patch, { mainAgent: { ...main, effortOverride: 5 } }],
      [patch, { mainAgent: { ...main, effortOverride: { level: 'max' } } }],
    ];
    expect(bad.filter((a) => ownerArgProblem('settings.update', a) === null).map((a) => JSON.stringify(a[1]))).toEqual([]);
    expect(ownerArgProblem('settings.update', [patch, { mainAgent: main, base: main }])).toBe('2번째 인자 모양이 맞지 않습니다');
    expect(ownerArgProblem('settings.update', [patch, { mainAgent: { ...main, effortTier: 'max' } }])).toBe('2번째 인자의 mainAgent.effortTier 모양이 맞지 않습니다');
    expect(ownerArgProblem('settings.update', [patch, { mainAgent: { ...main, effortOverride: 5 } }])).toBe('2번째 인자의 mainAgent.effortOverride 모양이 맞지 않습니다');
  });
});
