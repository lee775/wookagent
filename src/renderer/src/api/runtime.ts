import type { AppSnapshot } from '../../../shared/views';
import { getBridge } from './bridge';

/** 화면과 운영 권한의 실행 환경 판정은 이곳에서만 한다. */
export function runtime(snapshot?: Pick<AppSnapshot, 'auth'>) {
  const bridge = getBridge();
  const web = !!bridge.web || bridge.platform === 'web';
  const server = snapshot?.auth.mode === 'server';
  return { web, server, desktop: !web && !server };
}
