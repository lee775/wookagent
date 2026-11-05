/** 트레이·전역 단축키의 긴급 정지 (CTL-02·03·04). 확인 창 없이 바로 실행한다 */
import type { EmergencySummary } from '@shared/views';
import { BackendError, type Backend } from '../backend/types';
import type { Logger } from './logger';
import type { OsNotificationInput } from './notifications';

export type EmergencySource = 'tray' | 'shortcut';

/** OS 알림에 넣을 요약 (CTL-04). 종료를 확인하지 못했으면 완료로 쓰지 않는다 (CTL-03) */
export function describeEmergency(summary: EmergencySummary): { title: string; body: string } {
  const turns = summary.stoppedTurns.length;
  const held = summary.heldTasks.length;
  const heldText = held > 0 ? ` 작업 ${held}개를 보류했습니다.` : '';
  if (!summary.completed) {
    const names = [...new Set(summary.failures.map((f) => f.memberName).filter((n) => n.length > 0))];
    const who = names.length > 0 ? ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}명` : ''})` : '';
    const count = summary.failures.length > 0 ? `${summary.failures.length}건` : '일부';
    return {
      title: '긴급 정지 — 종료 확인 실패',
      body: `새 실행은 막았지만 종료를 확인하지 못한 실행이 ${count} 있습니다${who}.${heldText} 창에서 남은 프로세스를 확인해 주세요.`,
    };
  }
  if (turns === 0 && held === 0) {
    return { title: '긴급 정지 완료', body: '실행 중인 작업이 없었습니다. 새 실행을 막았습니다.' };
  }
  const turnText = turns > 0 ? `실행 중이던 ${turns}개를 모두 멈췄습니다.` : '실행 중인 AI가 없었습니다.';
  // 대표에게는 항목별 재개가 없다 — 해제하면 보류 목록이 메인 에이전트에게 가고 메인이 항목별로 재개한다 (CTL-10 v0.6, 리드 결정 32)
  const next = held > 0 ? ' [정지 해제]를 누르면 보류된 작업은 메인 에이전트가 확인해 항목별로 재개합니다.' : ' [정지 해제]를 누르면 새 실행을 다시 시작할 수 있습니다.';
  return { title: '긴급 정지 완료', body: `${turnText}${heldText}${next}` };
}

export interface EmergencyTrigger {
  /** 실패해도 거부하지 않는다 (알림·기록으로 처리). 이미 실행 중이면 그 결과를 같이 기다린다 */
  trigger(source: EmergencySource): Promise<EmergencySummary | null>;
}

export function createEmergencyTrigger(deps: {
  backend: Pick<Backend, 'emergencyStop'>;
  pushEmergency: (summary: EmergencySummary) => void;
  notify: (n: OsNotificationInput) => void;
  logger: Logger;
}): EmergencyTrigger {
  let running: Promise<EmergencySummary | null> | null = null;

  const notify = (n: OsNotificationInput): void => {
    try {
      deps.notify(n);
    } catch (error) {
      deps.logger.error(`긴급 정지 알림 표시 실패: ${n.title}`, error);
    }
  };

  const run = async (source: EmergencySource): Promise<EmergencySummary | null> => {
    deps.logger.warn(`긴급 정지 요청 (${source === 'tray' ? '트레이' : '전역 단축키'})`);
    let summary: EmergencySummary;
    try {
      summary = await deps.backend.emergencyStop();
    } catch (error) {
      deps.logger.error('긴급 정지 실행 실패', error);
      const reason = error instanceof BackendError ? error.message : '예기치 않은 오류가 발생했습니다.';
      notify({ level: 'urgent', title: '긴급 정지를 실행하지 못했습니다', body: `${reason} 창 상단의 긴급 정지 버튼을 다시 눌러 주세요.` });
      return null;
    }
    deps.logger.warn(
      `긴급 정지 결과: 완료=${summary.completed} 종료 ${summary.stoppedTurns.length}건, 보류 ${summary.heldTasks.length}건, 실패 ${summary.failures.length}건`,
    );
    try {
      deps.pushEmergency(summary);
    } catch (error) {
      deps.logger.error('긴급 정지 요약을 화면에 보내지 못했습니다', error);
    }
    const { title, body } = describeEmergency(summary);
    notify({ level: 'urgent', title, body });
    return summary;
  };

  return {
    trigger(source) {
      if (running) return running;
      const current = run(source).finally(() => {
        if (running === current) running = null;
      });
      running = current;
      return current;
    },
  };
}
