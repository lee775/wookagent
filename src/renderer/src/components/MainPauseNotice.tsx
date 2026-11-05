import type { AppSnapshot } from '../../../shared/views';
import { call, toast } from '../api/store';
import { resolveDisplayText } from '../lib/displayText';
import { getBridge } from '../api/bridge';

export function mainPauseReason(snapshot: AppSnapshot): string | null {
  const main = snapshot.members?.find(member => member.isMain);
  const pause = snapshot.stop?.pausedMembers.find(item => item.memberId === main?.id || item.memberId === 'M-MAIN');
  if (!pause && main?.status !== 'paused') return null;
  return pause?.reason || main?.statusReasons[0] || '프로그램이 메인 에이전트의 실행을 멈췄습니다.';
}

export function releaseNotice(count: number) {
  return `새 실행을 시작할 수 있습니다. 보류된 작업 ${count}건은 메인 에이전트가 확인해 항목별로 재개합니다`;
}

export async function releaseStop(snapshot: AppSnapshot) {
  if (!window.confirm('남아 있는 프로세스가 없는지 확인하셨나요? 정지를 해제하면 새 실행을 시작할 수 있고, 보류된 작업은 메인 에이전트가 확인합니다.')) return;
  try {
    await call('stop.release');
    toast('정지를 해제했습니다', releaseNotice(snapshot.stop?.heldByEmergency ?? 0), 'info');
  } catch { /* 공통 오류 안내 */ }
}

export function MainPauseNotice({ snapshot, openMember }: { snapshot: AppSnapshot; openMember?: (id: string) => void }) {
  const reason = mainPauseReason(snapshot);
  const desktop = snapshot.auth.mode !== 'server' && (!window.wook || getBridge().platform !== 'web');
  if (!reason) return null;
  return <div className="main-pause-notice" role="status">
    <strong>메인 에이전트가 정지했습니다.</strong>
    <p>{resolveDisplayText(reason, snapshot)}</p>
    <p>{desktop ? '작업 관리자에서 남아 있는 프로세스가 없는지 먼저 확인한 뒤 정지를 해제해 주세요.' : '서버 PC에 남은 프로세스가 없는지 운영자에게 확인을 부탁한 뒤 정지를 해제해 주세요.'}</p>
    <div className="heading-actions">
      {openMember && <button onClick={() => openMember('M-MAIN')}>메인 에이전트 상태 보기</button>}
      <button onClick={() => void releaseStop(snapshot)}>정지 해제</button>
    </div>
  </div>;
}
