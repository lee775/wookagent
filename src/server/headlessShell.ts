/**
 * 화면 없는 셸 서비스 (SERVER_DESIGN 3.2, S2-7): 서버 프로세스가 백엔드에 넘기는 ShellServices.
 * - 서버 PC의 창·브라우저·파일 선택을 여는 기능(openExternal·openPath·pickFiles)은 `unavailable_remote` 오류로 분명히 거부한다 — 성공한 척하지 않는다.
 *   그래서 서버의 `system.pickFiles`는 빈 목록이 아니라 이 오류를 돌려준다
 * - OS 알림과 창 앞으로는 아무것도 하지 않는다 — 알림은 이미 `notification` 토픽으로 화면에 간다
 * 업로드·내려받기는 3단계 이후에 붙는다(SERVER_DESIGN 10.3)
 */
import { BackendError, type ShellServices } from '../main/backend/types';

export const HEADLESS_UNAVAILABLE = {
  openExternal: '서버 모드에서는 서버 PC에서 브라우저를 열 수 없습니다',
  openPath: '서버 모드에서는 서버 PC의 파일이나 폴더를 열 수 없습니다',
  pickFiles: '서버 모드에서는 서버 PC의 파일 선택 창을 열 수 없습니다',
} as const;

export function createHeadlessShell(): ShellServices {
  const unavailable = (what: keyof typeof HEADLESS_UNAVAILABLE) => Promise.reject(new BackendError('unavailable_remote', HEADLESS_UNAVAILABLE[what]));
  return {
    openExternal: () => unavailable('openExternal'),
    openPath: () => unavailable('openPath'),
    pickFiles: () => unavailable('pickFiles'),
    showOsNotification() {
      // 알림은 notification 토픽으로 이미 화면에 간다
    },
    focusWindow() {
      // 서버에는 창이 없다
    },
  };
}
