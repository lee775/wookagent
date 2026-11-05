import { describe, expect, it, vi } from 'vitest';
import { snapshot } from './data';

vi.stubGlobal('window', { wook: {}, location: { search: '' } });

describe('fake bridge exercises real backend text shapes', () => {
  it('keeps raw formats at the boundary for the display filter', async () => {
    expect(snapshot.ownerTodos.some(todo => todo.kind === 'error' && /\bT-\d{4}\b/.test(todo.message))).toBe(true);
    expect(snapshot.members.some(member => member.statusReasons.some(reason => /\bT-\d{4}\b/.test(reason)))).toBe(true);
    expect(snapshot.recentActivity.some(item => /\bT-\d{4}\b.*→/.test(item.text))).toBe(true);
    const { fakeBridge } = await import('./index');
    const detail = await fakeBridge.invoke('members.getDetail', 'M-0005');
    expect(detail.messages.every(message => message.from.startsWith('메인 에이전트'))).toBe(true);
    expect(detail.messages.some(message => /D-\d{4}이\(가\)/.test(message.undelivered ?? ''))).toBe(true);
    const emergency = await fakeBridge.invoke('stop.emergency');
    expect(emergency.stoppedTurns.some(turn => /자동 검사 T-\d{4}:/.test(turn.detail))).toBe(true);
  });
});
