import { describe, expect, it, vi } from 'vitest';
import type { EmergencySummary } from '@shared/views';
import { BackendError } from '../backend/types';
import { createEmergencyTrigger, describeEmergency } from './emergency';
import type { Logger } from './logger';

const base: EmergencySummary = { at: '2026-10-27T01:00:00.000Z', completed: true, stoppedTurns: [], heldTasks: [], failures: [] };

function summary(over: Partial<EmergencySummary>): EmergencySummary {
  return { ...base, ...over };
}

const turn = (memberName: string) => ({ turnId: `U-${memberName}`, memberId: `M-${memberName}`, memberName, taskId: null, ok: true, detail: '' });
const held = (n: number) => ({ taskId: `T-000${n}`, title: `작업 ${n}`, previousState: 'in_progress' as const, projectId: 'P-0001' });

describe('긴급 정지 요약 문구 (CTL-04)', () => {
  it('완료: 멈춘 실행·보류 작업 수를 알려 준다', () => {
    const d = describeEmergency(summary({ stoppedTurns: [turn('가'), turn('나')], heldTasks: [held(1)] }));
    expect(d.title).toBe('긴급 정지 완료');
    expect(d.body).toContain('실행 중이던 2개를 모두 멈췄습니다.');
    expect(d.body).toContain('작업 1개를 보류했습니다.');
  });

  it('실행 중인 것이 없었으면 그렇게 말한다', () => {
    expect(describeEmergency(base).body).toBe('실행 중인 작업이 없었습니다. 새 실행을 막았습니다.');
  });

  it('종료를 확인하지 못했으면 완료라고 쓰지 않는다 (CTL-03)', () => {
    const d = describeEmergency(
      summary({
        completed: false,
        failures: [
          { memberId: 'M-1', memberName: '박설계', detail: '남은 프로세스 2개' },
          { memberId: 'M-2', memberName: '박설계', detail: '' },
        ],
      }),
    );
    expect(d.title).toBe('긴급 정지 — 종료 확인 실패');
    expect(d.title).not.toContain('완료');
    expect(d.body).toContain('2건');
    expect(d.body).toContain('(박설계)');
  });
});

describe('긴급 정지 실행', () => {
  const logger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('백엔드 정지 → 화면에 요약 푸시 → 긴급 OS 알림', async () => {
    const result = summary({ stoppedTurns: [turn('가')] });
    const backend = { emergencyStop: vi.fn(async () => result) };
    const pushEmergency = vi.fn();
    const notify = vi.fn();
    const trigger = createEmergencyTrigger({ backend, pushEmergency, notify, logger: logger() });
    await expect(trigger.trigger('tray')).resolves.toBe(result);
    expect(pushEmergency).toHaveBeenCalledWith(result);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'urgent', title: '긴급 정지 완료' }));
  });

  it('겹친 요청(단축키 연타)은 한 번만 실행한다', async () => {
    let release!: (s: EmergencySummary) => void;
    const backend = { emergencyStop: vi.fn(() => new Promise<EmergencySummary>((r) => (release = r))) };
    const trigger = createEmergencyTrigger({ backend, pushEmergency: vi.fn(), notify: vi.fn(), logger: logger() });
    const a = trigger.trigger('shortcut');
    const b = trigger.trigger('shortcut');
    release(base);
    await Promise.all([a, b]);
    expect(backend.emergencyStop).toHaveBeenCalledTimes(1);
    // 끝난 뒤의 새 요청은 다시 실행한다
    const c = trigger.trigger('tray');
    release(base);
    await expect(c).resolves.toBe(base);
    expect(backend.emergencyStop).toHaveBeenCalledTimes(2);
  });

  it('실패하면 거부하지 않고 긴급 알림·기록을 남긴다', async () => {
    const backend = {
      emergencyStop: vi.fn(async () => {
        throw new BackendError('db_failed', '정지 상태를 저장하지 못했습니다.');
      }),
    };
    const notify = vi.fn();
    const log = logger();
    const trigger = createEmergencyTrigger({ backend, pushEmergency: vi.fn(), notify, logger: log });
    await expect(trigger.trigger('tray')).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'urgent', title: '긴급 정지를 실행하지 못했습니다', body: expect.stringContaining('정지 상태를 저장하지 못했습니다.') }),
    );
    expect(log.error).toHaveBeenCalled();
  });
});
