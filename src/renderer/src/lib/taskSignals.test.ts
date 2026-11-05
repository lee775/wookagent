import { describe, expect, it } from 'vitest';
import { fakeBridge } from '../api/fake';
import { snapshot } from '../api/fake/data';
import {
  changedCriteriaOf, checkResumeHint, checkRunDetails, checkRunsOf, emergencyFailureKey, emergencyHeadline,
  holdNeedsMainCommand, holdReasonHint, isRejudgeHold, messageDeliveryStatus, noticeLines, pauseRelease, unverifiableConflictFiles,
} from './taskSignals';

const task = (id: string) => {
  const found = snapshot.tasks.find(item => item.id === id);
  if (!found) throw new Error(`Missing preview task ${id}`);
  return found;
};

describe('stage 7–9 renderer signals', () => {
  it('1. finds the rejudge hold and shows the reviewer message destination from the reply', async () => {
    expect(isRejudgeHold(task('T-0008'))).toBe(true);
    const typedRejudge = { ...task('T-0008'), hold: { ...task('T-0008').hold!, reasons: [
      { ...task('T-0008').hold!.reasons[0]!, label: '보류', note: '검수 세션을 확인해 주세요.', refId: 'rejudge' },
    ] } };
    expect(isRejudgeHold(typedRejudge)).toBe(true);
    expect(isRejudgeHold({ ...typedRejudge, hold: { ...typedRejudge.hold, reasons: [
      { ...typedRejudge.hold.reasons[0], refId: null },
    ] } })).toBe(false);
    expect(isRejudgeHold(task('T-0001'))).toBe(false);

  });

  it('2. detects an unconfirmed check by kind, scope, and its execution request ID, regardless of copy', async () => {
    const detail = await fakeBridge.invoke('tasks.get', 'T-0009');
    const runs = checkRunsOf(detail);
    const original = task('T-0009');
    const hold = { returnState: 'in_progress' as const, reasons: [{ kind: 'error' as const, scope: 'task' as const, refId: 'RQ-CHECK-1', label: '오류', note: '백엔드가 완전히 바꾼 안내 문장', since: '2026-10-28T00:00:00.000Z' }] };
    expect(checkResumeHint({ ...original, hold }, runs)).toContain('검사에서 남긴 파일');
    expect(checkResumeHint({ ...original, hold }, runs.map(run => ({ ...run, leftFiles: [] })))).toContain('기록된 검사 결과');
    for (const reachesMain of [true, false, undefined]) {
      const reason = { ...hold.reasons[0], reachesMain };
      const current = { ...original, hold: { ...hold, reasons: [reason] } };
      expect(holdNeedsMainCommand(current)).toBe(reachesMain !== true);
      const hint = checkResumeHint(current, runs);
      if (reachesMain === true) expect(hint).toBe('메인 에이전트가 처리 중');
      else {
        expect(hint).toContain('명령창으로 메인 에이전트에게 알려 주세요');
        expect(hint).not.toContain('처리 중');
      }
    }
    for (const reason of [{ ...hold.reasons[0], scope: 'member' as const }, { ...hold.reasons[0], kind: 'paused' as const }, { ...hold.reasons[0], refId: 'rejudge' }, { ...hold.reasons[0], refId: null }]) {
      expect(checkResumeHint({ ...original, hold: { ...hold, reasons: [reason] } }, runs)).toBeNull();
    }
    expect(checkResumeHint(original, [])).toBeNull();
  });

  it('S5-signals. each reason respects explicit delivery and preserves the no-reviewer legacy fallback', () => {
    const general = '이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 원인이 정리되면 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다.';
    for (const kind of ['error', 'merge_blocked', 'recovery_check'] as const) {
      const reason = { kind, refId: 'no_reviewer', label: '새 설명', note: '명령창으로 메인 에이전트에게 알려 주세요.', since: snapshot.generatedAt };
      expect(holdReasonHint({ ...reason, reachesMain: true }, [])).toBe('메인 에이전트가 처리 중');
      expect(holdReasonHint({ ...reason, reachesMain: false }, [])).toBe(general);
      expect(holdReasonHint(reason, [])).toBe(kind === 'error'
        ? '메인 에이전트가 보류 사유를 확인하고 필요한 조치를 마친 뒤 작업을 재개합니다.' : general);
    }
  });

  it('3. distinguishes unconfirmed shutdowns, mixed failures, and duplicate member rows', () => {
    expect(emergencyHeadline({ completed: false, failures: [{ remaining: -1 }, { remaining: -1 }] })).toBe('종료를 확인하지 못했습니다 — 작업 관리자에서 남은 프로세스를 확인하세요');
    expect(emergencyHeadline({ completed: false, failures: [{ remaining: -1 }, { remaining: 2 }] })).toBe('종료 실패 — 남은 프로세스가 있습니다 (일부는 확인하지 못함)');
    expect(emergencyHeadline({ completed: false, failures: [{ remaining: 2 }] })).toBe('종료 실패 — 남은 프로세스가 있습니다');
    expect(emergencyFailureKey('M-0004', 0)).not.toBe(emergencyFailureKey('M-0004', 1));
  });

  it('4. offers the member release path for a merged task of a cancelled directive', () => {
    expect(snapshot.directives.find(item => item.id === 'D-0005')?.state).toBe('cancelled');
    expect(task('T-0010').merge).not.toBeNull();
    expect(pauseRelease(task('T-0010'), snapshot)).toBe('member');
    expect(task('T-0010').hold?.reasons[0]?.note).toContain('팀원 서아 재개로 풀림');
    const projectPaused = { ...snapshot, stop: { ...snapshot.stop, pausedProjects: [
      { projectId: 'P-0001', since: '2026-10-28T00:00:00.000Z', mode: 'graceful' as const, by: 'owner' as const },
    ] } };
    expect(pauseRelease(task('T-0010'), projectPaused)).toBe('member');
    const typedMemberHold = { ...task('T-0010'), hold: { ...task('T-0010').hold!, reasons: [
      { ...task('T-0010').hold!.reasons[0]!, note: '프로젝트 재개로 풀림', scope: 'member' as const },
    ] } };
    expect(pauseRelease(typedMemberHold, projectPaused)).toBe('member');
    const typedProjectHold = { ...task('T-0010'), hold: { ...task('T-0010').hold!, reasons: [
      { ...task('T-0010').hold!.reasons[0]!, scope: 'project' as const },
    ] } };
    expect(pauseRelease(typedProjectHold, projectPaused)).toBe('project');
    const projectHold = { ...task('T-0010'), hold: { ...task('T-0010').hold!, reasons: [
      { kind: 'paused' as const, label: '일시정지', note: '일시정지 — 프로젝트 재개로 풀림', since: '2026-10-28T00:00:00.000Z' },
    ] } };
    expect(pauseRelease(projectHold, projectPaused)).toBe('project');
  });

  it('5. keeps the unverifiable files with the open conflict', () => {
    expect(task('T-0011').conflictFiles).toContain('assets/wiki-map.bin');
    expect(unverifiableConflictFiles(task('T-0011'))).toEqual(['assets/wiki-map.bin']);
  });

  it('6. marks exact changed criteria and an previously confirmed auto check', async () => {
    expect(changedCriteriaOf(task('T-0004'))).toEqual(['자동 검사가 통과한다']);
    const detail = await fakeBridge.invoke('tasks.get', 'T-0009');
    const runs = checkRunsOf(detail);
    expect(runs).toHaveLength(2);
    expect(runs[0].ownerConfirmedAt).not.toBeNull();
    expect(runs[1].ownerConfirmedAt).toBeNull();
    expect(checkRunDetails(runs[1])).toEqual(['종료 확인 못 함', '남은 파일: dist/index.js, build/report.json']);
  });

  it('7. treats a redelivered pending message as waiting, not failed', () => {
    expect(messageDeliveryStatus({ text: '(다시 전달 — 이전 턴이 끊겼습니다) 확인해 주세요.', delivered: false, undelivered: null })).toBe('다시 전달 대기');
    expect(messageDeliveryStatus({ text: '확인해 주세요.', delivered: false, undelivered: '취소됨' })).toBe('전달 못 함');
  });

  it('8. preserves each sync notice group and sync notice groups', async () => {
    const notice = snapshot.recentActivity.find(item => item.text.includes('병합 변경이 들어 있는지 확인 못 함:'))?.text ?? '';
    expect(notice).toContain('병합 변경이 들어 있는지 확인 못 함:');
    const body = '아직 병합 전 내용: a / 병합 전 내용에 대표 변경이 더해짐: b / 병합 변경이 들어 있는지 확인 못 함: c';
    expect(noticeLines('프로젝트 폴더 동기화 필요', body)).toHaveLength(3);

  });
});
