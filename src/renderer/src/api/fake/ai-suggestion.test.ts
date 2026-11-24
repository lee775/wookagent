import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WookBridge } from '../../../../shared/ipc';
import { fakeSuggestionOptions } from './aiSuggestion';
import { members, settings } from './data';

let bridge: WookBridge;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { wook: {}, location: { search: '' } });
  vi.resetModules();
  bridge = (await import('./index')).fakeBridge;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('exposes the ordered catalog for a teammate and excludes main and retired members', async () => {
  expect((await bridge.invoke('members.getDetail', 'M-MAIN')).aiSuggestion).toBeNull();
  expect(fakeSuggestionOptions({ ...members[2], deleted: true }, settings.team)).toBeNull();
  const { aiSuggestion } = await bridge.invoke('members.getDetail', 'M-0002');
  expect(aiSuggestion?.models.map(row => row.kind)).toEqual(['claude', 'claude', 'claude', 'claude', 'codex']);
  expect(aiSuggestion?.models.every(row => row.note)).toBe(true);
  expect(aiSuggestion?.effortTiers.map(row => row.label)).toEqual(['높게', '보통', '낮게']);
  expect(aiSuggestion?.fixed).toBe(true);
});

it('refuses an equivalent suggestion, an unknown model, a wrong project and attachments without adding messages', async () => {
  const input = { target: 'P-0001', text: '', aiSuggestion: { memberId: 'M-0002', model: 'gpt-6-sol' } };
  const history = () => bridge.invoke('command.history', input.target, {});
  const before = await history();
  await expect(bridge.invoke('command.send', input)).rejects.toThrow('현재 AI와 같습니다');
  await expect(bridge.invoke('command.send', { ...input, aiSuggestion: { ...input.aiSuggestion, model: '없는 모델' } })).rejects.toThrow('모델 목록에서 "없는 모델"을 찾을 수 없습니다');
  await expect(bridge.invoke('command.send', { ...input, target: 'main' })).rejects.toThrow('프로젝트로');
  await expect(bridge.invoke('command.send', { ...input, attachments: [{ name: '참고.txt' }] })).rejects.toThrow('첨부');
  expect(await history()).toEqual(before);
});

it.each([
  ['M-0003', 'gpt-6-sol', '반영했습니다', true],
  ['M-0002', 'opus', '유지했습니다', false],
] as const)('records only the owner line immediately, delivers a reasoned decision for %s and announces it', async (memberId, model, verdict, changed) => {
  const target = 'P-0001';
  const member = async () => (await bridge.invoke('members.getDetail', memberId)).member;
  const history = () => bridge.invoke('command.history', target, {});
  const before = await member(), messages = await history();
  const other = await bridge.invoke('command.history', 'main', {});
  const notice = vi.fn(); const off = bridge.subscribe('notification', notice);
  const count = (await bridge.invoke('snapshot.get')).directives.length;
  const { conversationId } = await bridge.invoke('command.send', { target, text: '작업 단계를 검토해 주세요.', aiSuggestion: { memberId, model, effortTier: 'high' } });
  const received = await history();
  expect(received).toHaveLength(messages.length + 1);
  expect(received.at(-1)).toMatchObject({ id: conversationId, role: 'owner', directiveId: null, attachments: [] });
  expect(received.at(-1)?.text).toContain('팀원 AI 변경 건의: ' + before.name);
  expect(received.at(-1)?.text).toContain('까닭: 작업 단계를 검토해 주세요.');
  expect((await member()).ai).toEqual(before.ai); expect(notice).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  const answer = (await history()).at(-1)!;
  expect(answer.role).toBe('main_agent'); expect(answer.text).toContain(verdict);
  expect(answer.text).toContain(before.currentTask?.title ?? before.currentWork!.label);
  expect(notice).toHaveBeenCalledWith(expect.objectContaining({ title: '메인 에이전트의 답', body: answer.text, link: { tab: 'projects', projectId: target } }));
  if (changed) expect((await member()).ai).toMatchObject({ kind: 'codex', model, effortTier: 'high' });
  else expect((await member()).ai).toEqual(before.ai);
  expect((await bridge.invoke('snapshot.get')).directives).toHaveLength(count);
  expect(await bridge.invoke('command.history', 'main', {})).toEqual(other); off();
});
