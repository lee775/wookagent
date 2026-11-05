/**
 * 메인이 바꿀 수 있는 설정의 남은 구멍 (리드 결정 27의 설정 부분, 10-30 — owner-surface 2차 재리뷰 K1·S1, 프로브 zz-s1fix2-os-k1-backup-keep·
 * zz-s1fix2-os-s1-single-slot).
 * - 백업 보관 수(general.backup.keep)는 1~365 정수, 모델 목록(team.modelCatalog)의 각 항목은 id·label이 문자열이고 note는 문자열이거나 생략이다. 틀린
 *   값은 invalid이고 아무것도 저장하지 않는다 — 실행 설정(리드 결정 15)과 같은 길(settings.update, 메인의 update_settings도 이 처리기)이다. 예전에는 메인이
 *   객체를 저장할 수 있었고, 대표 화면 운영 설정의 첫 칸이 그 값을 React 자식으로 그리다 무너졌다
 * - 실행 상한(maxConcurrent)의 하한은 2다 — 일반 작업이 N-1자리까지만 써서 관리 업무(프로듀서·메인 에이전트) 자리가 늘 남는다. 예전 DB에 저장된 1은
 *   시작 때 기본값으로 되돌린다(리드 결정 15와 같은 되돌림). N=1이 필요한 시험은 저장된 설정을 바로 쓴다
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { defaultSettings } from '../../src/main/orchestrator/defaults';
import { BACKUP_KEEP_LIMIT, EXECUTION_LIMITS } from '../../src/main/orchestrator/settingsPolicy';
import { directiveKey, enqueue } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';
import { seedStoredSettings } from './mainOps';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { code?: string }) => err.code ?? 'error',
  );

const settingsRows = (e: RestartableEnv, seq0: number) => e.ctx.store.activity.search({ text: '운영 설정 변경', limit: 100 }).filter((r) => r.seq > seq0);

describe('백업 보관 수·모델 목록 형식 (리드 결정 27)', () => {
  it('(K1) 메인이 백업 보관 수·모델 목록 글에 객체 같은 값을 넣으면 invalid이고 아무것도 저장하지 않는다 — 대표 화면이 그리는 값이 그대로 숫자·문자열이다', async () => {
    env = await bootRestartable();
    const e = env;
    const before = e.ctx.settings();
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]!.seq;
    const err = await e.main('update_settings', { patch: { general: { backup: { keep: { count: 10 } } } } }).catch((x: { code: string; message: string }) => x);
    expect(err).toMatchObject({ code: 'invalid' });
    expect((err as { message: string }).message).toContain('백업 보관 수(general.backup.keep) 객체 — 1~365개 정수');
    expect(
      await codeOf(e.main('update_settings', { patch: { team: { modelCatalog: { claude: [], codex: [{ id: 'gpt-5.1', label: { ko: '기본' }, note: '' }] } } } })),
    ).toBe('invalid');
    expect(e.ctx.settings()).toEqual(before);
    expect(settingsRows(e, seq0)).toEqual([]);
    // 대표 화면 운영 설정 첫 칸이 그리는 모양 그대로 (Settings.tsx `{s.general.backup.keep}개`) — 무너지지 않는다
    expect(renderToStaticMarkup(createElement('span', null, e.ctx.settings().general.backup.keep as never, '개'))).toBe(`<span>${before.general.backup.keep}개</span>`);
  });

  it('백업 보관 수는 1~365 정수만, 메인과 운영자 길 모두 같은 검사다 — 섞인 요청은 함께 온 값도 저장하지 않는다', async () => {
    env = await bootRestartable();
    const e = env;
    const keep0 = e.ctx.settings().general.backup.keep;
    for (const bad of [0, -1, 366, 2.5, '7', null, {}, [], Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(await codeOf(e.main('update_settings', { patch: { general: { backup: { keep: bad } } } })), `main ${String(bad)}`).toBe('invalid');
      expect(await codeOf(e.internal('settings.update', { general: { backup: { keep: bad as never } } })), `operator ${String(bad)}`).toBe('invalid');
    }
    expect(await codeOf(e.main('update_settings', { patch: { execution: { maxConcurrent: 6 }, general: { backup: { keep: 0 } } } }))).toBe('invalid');
    expect(e.ctx.settings().execution.maxConcurrent).toBe(defaultSettings().execution.maxConcurrent);
    expect(e.ctx.settings().general.backup.keep).toBe(keep0);
    for (const good of [BACKUP_KEEP_LIMIT.min, BACKUP_KEEP_LIMIT.max, 30]) {
      await e.main('update_settings', { patch: { general: { backup: { keep: good } } } });
      expect(e.ctx.settings().general.backup.keep).toBe(good);
    }
  });

  it('모델 목록 항목은 id·label 문자열, note는 문자열이거나 생략 — 틀리면 invalid, 생략한 note는 빈 글로 저장한다', async () => {
    env = await bootRestartable();
    const e = env;
    const catalog0 = e.ctx.settings().team.modelCatalog;
    const ok = { id: 'sonnet', label: 'Sonnet', note: '균형형' };
    const bad: unknown[] = [
      { claude: [{ ...ok, label: { ko: 'Sonnet' } }] },
      { claude: [{ ...ok, label: 3 }] },
      { claude: [{ id: 'sonnet', note: '' }] },
      { claude: [{ ...ok, note: 5 }] },
      { claude: [{ ...ok, note: null }] },
      { claude: [{ ...ok, id: 7 }] },
      { claude: ['sonnet'] },
      { claude: [null] },
      { claude: { sonnet: ok } },
      { claude: 'sonnet' },
      { gemini: [ok] },
      'claude',
      [ok],
    ];
    for (const modelCatalog of bad) {
      expect(await codeOf(e.main('update_settings', { patch: { team: { modelCatalog } } })), JSON.stringify(modelCatalog)).toBe('invalid');
      expect(await codeOf(e.internal('settings.update', { team: { modelCatalog: modelCatalog as never } })), JSON.stringify(modelCatalog)).toBe('invalid');
    }
    expect(e.ctx.settings().team.modelCatalog).toEqual(catalog0);
    // 맞는 목록은 받는다 — note를 생략하면 빈 글
    await e.main('update_settings', { patch: { team: { modelCatalog: { claude: [{ id: 'sonnet', label: 'Sonnet' }, ok] } } } });
    expect(e.ctx.settings().team.modelCatalog!.claude).toEqual([{ id: 'sonnet', label: 'Sonnet', note: '' }, ok]);
    expect(e.ctx.settings().team.modelCatalog!.codex).toEqual(catalog0!.codex);
  });

  it('update_settings 설명은 백업 보관 수 범위와 모델 목록 항목 모양을 적는다', () => {
    const desc = TOOL_SPECS.find((t) => t.name === 'update_settings')!.description;
    expect(desc).toContain('general.backup.keep은 1~365 정수');
    expect(desc).toContain('{id: 문자열, label: 문자열, note: 문자열(생략 가능)}');
  });
});

describe('실행 상한의 하한 2 — 관리 업무 자리 (리드 결정 27)', () => {
  it('실행 상한 1은 메인과 운영자 길 모두 invalid이고, 2는 받는다. 설명과 범위 표도 2~32다', async () => {
    env = await bootRestartable();
    const e = env;
    expect(EXECUTION_LIMITS.maxConcurrent).toMatchObject({ min: 2, max: 32, integer: true });
    expect(TOOL_SPECS.find((t) => t.name === 'update_settings')!.description).toContain('maxConcurrent 2~32개 정수');
    const err = await e.main('update_settings', { patch: { execution: { maxConcurrent: 1, turnTimeoutMin: 1440 } } }).catch((x: { code: string; message: string }) => x);
    expect(err).toMatchObject({ code: 'invalid' });
    expect((err as { message: string }).message).toContain('전체 CLI 실행 상한(maxConcurrent) 1 — 2~32개 정수');
    expect(await codeOf(e.internal('settings.update', { execution: { maxConcurrent: 1 } }))).toBe('invalid');
    expect(e.ctx.settings().execution).toMatchObject({ maxConcurrent: defaultSettings().execution.maxConcurrent, turnTimeoutMin: defaultSettings().execution.turnTimeoutMin });
    await e.main('update_settings', { patch: { execution: { maxConcurrent: 2 } } });
    expect(e.ctx.settings().execution.maxConcurrent).toBe(2);
  });

  it('예전 DB에 저장된 실행 상한 1은 시작 때 기본값으로 되돌린다 — 기록 1줄·알림 1개, 다시 시작해도 그대로', async () => {
    env = await bootRestartable();
    let e = env;
    seedStoredSettings(e.core, { execution: { maxConcurrent: 1 } });
    expect(e.ctx.settings().execution.maxConcurrent).toBe(1);
    env = await e.stopGracefully();
    e = env;
    expect(e.ctx.settings().execution.maxConcurrent).toBe(defaultSettings().execution.maxConcurrent);
    const rows = () => e.ctx.store.activity.search({ text: '허용 범위 밖의 실행 설정을 기본값으로 되돌림', limit: 10 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.text).toContain(`전체 CLI 실행 상한(maxConcurrent) 1 → ${defaultSettings().execution.maxConcurrent}`);
    expect(e.ctx.store.notifications.list({ ref1: 'execution-reset' })).toHaveLength(1);
    env = await e.stopGracefully();
    e = env;
    expect(rows()).toHaveLength(1);
    expect(e.ctx.store.notifications.list({ ref1: 'execution-reset' })).toHaveLength(1);
  });

  it('(S1) 가장 낮은 상한 2에서 프로듀서 턴이 한 자리를 잡고 프로듀서 업무가 대표 명령보다 먼저 기다려도, 메인 턴은 정지·해제 없이 바로 뜬다', async () => {
    env = await bootRestartable();
    const e = env;
    await e.main('update_settings', { patch: { execution: { maxConcurrent: 2, turnTimeoutMin: 1440 } } });
    e.holdAll = true;
    const d1 = seedDirective(e, '지시 1');
    const d2 = seedDirective(e, '지시 2');
    const put = (d: { id: string }, text: string) =>
      enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, priority: 'high', message: text });
    put(d1, '지시 1 계획');
    e.tick();
    await waitUntil(() => e.launchesOf(directiveKey(d1.id)).length === 1, '프로듀서 턴 1');
    await sleep(15);
    put(d2, '지시 2 계획'); // 대표 명령보다 먼저 들어온 프로듀서 업무
    await sleep(15);
    await e.invoke('command.send', { target: 'main', text: '실행 상한을 5로 올려 줘' });
    e.tick();
    await waitUntil(() => e.launchesOf('main:general').length === 1, '메인 턴');
    expect(e.core.turns.running().map((r) => r.sessionKey).sort()).toEqual([directiveKey(d1.id), 'main:general'].sort());
    // 프로듀서의 다른 업무는 프로듀서 턴이 끝나기를 기다린다 (팀원당 실행 1개)
    expect(e.launchesOf(directiveKey(d2.id))).toHaveLength(0);
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })).toEqual([]);
  });
});
