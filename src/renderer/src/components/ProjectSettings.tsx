import type { ProjectView } from '../../../shared/views';
import { openCommand } from '../lib/commands';
import { LabelValue, Modal } from '../lib/ui';

export function ProjectSettings({ project, close }: { project: ProjectView; close: () => void }) {
  return <Modal title="프로젝트 설정" onClose={close}>
    <p className="muted">프로젝트 설정은 메인 에이전트가 관리합니다.</p>
    <LabelValue label="프로젝트 이름">{project.name}</LabelValue>
    <LabelValue label="자동 검사 명령"><pre>{project.checkCommands.join('\n') || '없음'}</pre></LabelValue>
    <LabelValue label="네트워크 사용 방침">{project.networkPolicy === 'allow' ? '허용' : '제한'}</LabelValue>
    <LabelValue label="원격 저장소">{project.deploy.pushRemote ?? '없음'}</LabelValue>
    <LabelValue label="배포 명령">{project.deploy.deployCommand ?? '없음'}</LabelValue>
    <button onClick={() => { close(); openCommand(project.id, `${project.name}에 대해: `); }}>메인 에이전트에게 말하기</button>
  </Modal>;
}
