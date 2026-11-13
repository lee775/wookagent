/**
 * 서버의 화면 세션 사실 (S10c, 리드 결정 S10-7.7) — 순수 함수. 어느 화면에 화면 도우미를 붙일지, 붙일 수 없으면 그 까닭.
 *
 * - Windows: 예전 그대로 (도우미가 세션을 스스로 본다 — FAIL NO_DESKTOP session0·noninteractive)
 * - Linux: server.json의 screen.display(·screen.xauthority)가 먼저다 — 운영자가 따로 띄운 Xvfb(설치 안내)를 적는다. 없으면 서버 프로세스의 환경이 정한다:
 *   Wayland 표시(WAYLAND_DISPLAY 또는 XDG_SESSION_TYPE=wayland)면 쓸 수 없음(wayland — DISPLAY가 Xwayland를 가리켜도), DISPLAY가 있으면 X11, 없으면 화면 없음.
 *   systemd 사용자 단위로 뜬 서버에는 보통 DISPLAY가 없다 — 그래서 screen.display를 적는다
 * - 그 밖의 OS: 쓸 수 없음 (unsupported_os)
 * 이 함수는 화면에 붙어 보지 않는다 — 실제로 붙는지는 도우미가 시작할 때 본다 (FAIL NO_DESKTOP nodisplay·wayland)
 */

export interface ScreenSessionConfig {
  /** server.json screen.display (예: ':99') — 없으면 null */
  display?: string | null;
  /** server.json screen.xauthority (그 화면의 쿠키 파일, 절대 경로) — 없으면 null */
  xauthority?: string | null;
}

export type ScreenSession =
  | { kind: 'windows' }
  | {
      kind: 'x11';
      display: string;
      /** 쿠키 파일 (없으면 null — X 서버가 쿠키 없이 받는 경우) */
      xauthority: string | null;
      /** 화면을 정한 곳: server.json 또는 서버의 환경 */
      source: 'config' | 'env';
    }
  | { kind: 'off'; code: 'wayland' | 'no_desktop' | 'unsupported_os'; text: string };

/** 화면 세션의 쓸 수 없음 글 (대표·운영자에게 보인다 — 운영자가 할 일을 적는다) */
export const SCREEN_SESSION_TEXT = {
  wayland:
    'Wayland: X11 세션이나 Xvfb가 필요합니다 — 이 서버는 Wayland 세션에서 돌고 있어 화면 조작을 쓸 수 없습니다. 서버 PC의 운영자가 Xvfb 화면을 띄우고 server.json의 screen.display에 그 화면(예: ":99")을 적은 뒤 서버를 다시 시작해야 합니다',
  no_desktop:
    '화면 없음 — 서버에 X 화면이 없습니다(DISPLAY 없음, server.json의 screen.display 없음). 서버 PC의 운영자가 Xvfb 화면을 띄우고 server.json의 screen.display에 그 화면(예: ":99")을 적은 뒤 서버를 다시 시작해야 합니다',
  unsupported_os: '이 서버의 운영체제에서는 화면 조작을 쓸 수 없습니다 — Windows 서버와 Linux(X11) 서버에서만 씁니다',
  remote:
    '화면 없음 — 서버의 DISPLAY가 다른 기계의 화면을 가리킵니다(ssh -X 등). 이 기계의 화면만 씁니다 — 서버 PC의 운영자가 Xvfb 화면을 띄우고 server.json의 screen.display에 그 화면(예: ":99")을 적은 뒤 서버를 다시 시작해야 합니다',
} as const;

/**
 * 이 기계의 X 화면 이름 (':99' · ':99.0' · 'unix:99') — 다른 기계(호스트 이름 — 'localhost:10.0', ssh -X)는 쓰지 않는다 (리드 결정 S10-13). 화면의 주인 확인(SC-1)도
 * 이 기계의 소켓만 볼 수 있다
 */
export const X_DISPLAY_RE = /^(?:unix)?:\d{1,5}(?:\.\d{1,3})?$/;

const nonEmpty = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function screenSession(o: { platform: string; env: Readonly<Record<string, string | undefined>>; config?: ScreenSessionConfig | null }): ScreenSession {
  if (o.platform === 'win32') return { kind: 'windows' };
  if (o.platform !== 'linux') return { kind: 'off', code: 'unsupported_os', text: SCREEN_SESSION_TEXT.unsupported_os };
  const configured = nonEmpty(o.config?.display);
  if (configured) {
    return { kind: 'x11', display: configured, xauthority: nonEmpty(o.config?.xauthority) ?? nonEmpty(o.env.XAUTHORITY), source: 'config' };
  }
  // Wayland 표시가 있으면 DISPLAY(Xwayland)가 있어도 쓰지 않는다 — Xwayland로는 다른 Wayland 창을 보거나 조작할 수 없다 (SERVER_DESIGN 8.3.6)
  if (nonEmpty(o.env.WAYLAND_DISPLAY) || nonEmpty(o.env.XDG_SESSION_TYPE)?.toLowerCase() === 'wayland') {
    return { kind: 'off', code: 'wayland', text: SCREEN_SESSION_TEXT.wayland };
  }
  const display = nonEmpty(o.env.DISPLAY);
  // 다른 기계의 화면(ssh -X로 들어온 DISPLAY=localhost:10.0 등)은 쓰지 않는다 — 운영자의 노트북 화면을 움직이지 않게. 이 기계의 화면은 server.json으로만 정한다
  if (display && !X_DISPLAY_RE.test(display)) return { kind: 'off', code: 'no_desktop', text: SCREEN_SESSION_TEXT.remote };
  if (display) return { kind: 'x11', display, xauthority: nonEmpty(o.env.XAUTHORITY), source: 'env' };
  return { kind: 'off', code: 'no_desktop', text: SCREEN_SESSION_TEXT.no_desktop };
}
