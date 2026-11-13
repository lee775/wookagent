/**
 * Linux `wook-server check`의 화면 조작 항목과 사전 점검 줄 (S10c, 리드 결정 S10-7.12) — 순수 함수. 사실(도구가 있는지, 화면 세션, 도우미의 --probe 답, 세션 버스,
 * 운영자 설정)은 부르는 쪽(deployCheck — S10b의 목록)이 모아 넘긴다. 이 함수는 아무것도 띄우지 않는다.
 * 줄: 도구 · 화면(붙는지) · Xvfb인지 실제 화면인지 · Wayland · 접근성 버스(암호 칸 판정) · typeWithoutA11y 경고. 고칠 줄은 POSIX 셸에 그대로 붙여 넣을 수 있게.
 */
import { noDesktopText } from './desktopHelper';
import type { ScreenSession } from './screenSession';
import { missingToolsText } from './x11Launcher';

export type X11CheckLevel = 'ok' | 'warn' | 'fail' | 'skip';

export interface X11CheckFacts {
  /** server.json screen.enabled */
  enabled: boolean | null;
  session: ScreenSession;
  /** 정해진 시스템 폴더에 없는 X 도구와 python3 (resolveX11Tools().missing — python3는 화면의 주인 확인에 꼭 쓴다, 리드 결정 S10-13 SC-1) */
  missingTools: readonly string[];
  /** 곁 도우미를 띄울 python3가 있는지 (missingTools에도 든다 — 옛 사실 모으기와의 짝) */
  python3: boolean;
  /** 점검한 사용자의 홈 폴더 (절대 경로) — 고칠 줄에 쿠키 파일의 절대 경로를 쓴다 (SC-5). 모르면 null — '/home/<사용자>'로 적는다 */
  home?: string | null;
  /** 도우미의 --probe 답 (서버가 돌지 않거나 보지 않았으면 null) */
  probe: { ok: true; reply: Record<string, unknown> } | { ok: false; reason: string } | null;
  /** 서버 환경에 세션 버스 주소(DBUS_SESSION_BUS_ADDRESS)가 있는지 — AT-SPI가 쓴다 */
  dbusSession: boolean;
  /** server.json screen.typeWithoutA11y */
  typeWithoutA11y: boolean;
  /**
   * 돌고 있는 서버가 말한 화면 조작 상태 (status의 사전 점검 칸 — 그 서버 프로세스가 본 사실). 있으면 화면 세션·붙기는 이것이 정한다(점검을 돌린 셸의 환경은 서버의 것과
   * 다를 수 있다). 서버가 돌지 않으면 null — 그때 도구·설정에 문제가 없으면 skip이다
   */
  server?: { ok: boolean; detail: string } | null;
}

export interface X11CheckResult {
  level: X11CheckLevel;
  /** 한 줄 요약 */
  text: string;
  /** 사전 점검 줄 (사실마다 하나) */
  lines: string[];
  /** 고칠 줄 (POSIX 셸·server.json) — ok·skip이면 null */
  fix: string | null;
}

const RANK: Record<X11CheckLevel, number> = { skip: 0, ok: 1, warn: 2, fail: 3 };
/**
 * 화면이 없을 때의 고칠 줄 (SC-5·TD-3, 리드 결정 S10-13): server.json은 $HOME을 풀지 않으므로 쿠키 파일을 절대 경로로 적는다 — 그대로 붙여 넣어도 서버가 받는다
 * (시험이 이 줄의 조각을 server.json 읽기로 읽어 본다)
 */
export function xvfbFixText(home: string | null | undefined): string {
  const h = home && home.startsWith('/') ? home.replace(/\/+$/, '') : '/home/<사용자>';
  return `Xvfb를 사용자 단위로 띄우고(SERVER_SETUP의 Linux 화면 절 — -auth와 -nolisten tcp, -nolisten local은 쓰지 않음) server.json에 "screen": { "display": ":99", "xauthority": ${JSON.stringify(`${h}/.wook-xvfb.auth`)} } 를 적은 뒤 서버를 다시 시작`;
}

export function x11ScreenCheck(f: X11CheckFacts): X11CheckResult {
  if (f.enabled === false) return { level: 'ok', text: '화면 조작을 꺼 두었습니다 (server.json screen.enabled false)', lines: [], fix: null };
  const lines: string[] = [];
  let level: X11CheckLevel = 'ok';
  const fixes: string[] = [];
  const raise = (l: X11CheckLevel, line: string, fix?: string): void => {
    if (RANK[l] > RANK[level]) level = l;
    lines.push(line);
    if (fix && !fixes.includes(fix)) fixes.push(fix);
  };
  const XVFB_FIX = xvfbFixText(f.home);
  // 도구 — 운영자가 screen.enabled true로 켰을 때만 실패, 아니면 경고 (화면 조작은 고르는 기능이다 — Windows 목록과 같다, SC-7)
  const missing = [...new Set([...f.missingTools, ...(f.python3 ? [] : ['python3'])])];
  if (missing.length > 0) {
    const t = missingToolsText(missing);
    raise(f.enabled === true ? 'fail' : 'warn', t, t.slice(t.indexOf('sudo apt install')).replace(/\)$/, ''));
  } else lines.push('X 도구: 모두 있음 (xdotool·maim·x11-utils·x11-xserver-utils·xinput·xprintidle·python3)');
  // 화면 세션 — 돌고 있는 서버가 말한 상태가 먼저다
  const server = f.server ?? null;
  if (server) {
    if (server.ok) lines.push(`화면(서버): ${server.detail}`);
    else raise('warn', `화면(서버): ${server.detail}`, f.session.kind === 'off' ? XVFB_FIX : undefined);
  } else if (f.session.kind === 'off') {
    raise('warn', f.session.text, XVFB_FIX);
  } else if (f.session.kind === 'x11') {
    lines.push(`화면: ${f.session.display} (${f.session.source === 'config' ? 'server.json screen.display' : '서버의 DISPLAY'})${f.session.xauthority ? '' : ' — 쿠키 파일(xauthority) 없음'}`);
    if (f.session.source === 'env' && !server) raise('warn', '서버의 환경(DISPLAY)으로 화면을 정했습니다 — systemd로 띄우면 DISPLAY가 없습니다. server.json의 screen.display에 적기를 권합니다', XVFB_FIX);
  }
  // 붙어 본 결과 (서버의 --probe)
  let virtual: boolean | null = null;
  if (f.session.kind === 'x11' && !server) {
    if (!f.probe) lines.push('화면에 붙어 보지 않았습니다 — 서버가 돌 때 wook-server status의 화면 조작 줄로 봅니다');
    else if (!f.probe.ok) raise('warn', `화면 도우미를 확인하지 못했습니다: ${f.probe.reason}`);
    else if (f.probe.reply.lock === 'no_desktop') {
      const detail = typeof f.probe.reply.detail === 'string' ? f.probe.reply.detail : null;
      raise('warn', noDesktopText(detail), detail === 'wayland' ? XVFB_FIX : '그 화면(Xvfb)이 떠 있는지, screen.xauthority가 그 화면의 쿠키 파일인지 확인');
    } else {
      virtual = f.probe.reply.virtual === true;
      lines.push(virtual ? '화면 종류: Xvfb (가상 화면 — 지원·시험한 모양. 멈춤 단축키를 누를 키보드가 없어 대표의 멈춤은 긴급 정지)' : '화면 종류: 실제 X 화면 (최선 노력 — 곁 도우미가 단축키·조작 중 표시를 맡아야 입력을 받습니다)');
    }
  }
  // 곁 도우미 · 접근성
  if (!f.dbusSession) {
    raise(
      f.typeWithoutA11y ? 'ok' : 'warn',
      '세션 버스(DBUS_SESSION_BUS_ADDRESS)가 없어 AT-SPI로 암호 칸을 가를 수 없습니다 — 글자 입력(type)은 막힙니다' + (f.typeWithoutA11y ? ' (typeWithoutA11y로 칩니다)' : ''),
      'dbus-user-session을 설치하고 서버를 사용자 세션(systemd --user)에서 띄우기 — 앱은 접근성을 켜야 합니다(Qt: QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1)',
    );
  } else lines.push('세션 버스: 있음 (AT-SPI로 암호 칸을 가릅니다 — 앱이 접근성을 내놓을 때만)');
  if (f.typeWithoutA11y) {
    raise('warn', 'server.json screen.typeWithoutA11y가 켜져 있습니다 — 암호 칸인지 가르지 못해도 메인 에이전트의 글자를 칩니다', '쓰지 않으려면 server.json에서 "typeWithoutA11y"를 지우고 서버를 다시 시작');
  }
  // 서버가 돌지 않고 도구·설정에 문제가 없다 — 붙어 보지 않았으니 skip (Windows 목록과 같다)
  if (!server && !f.probe && level === 'ok') {
    return { level: 'skip', text: `서버가 돌지 않아 화면에 붙어 보지 않았습니다 — 도구·설정은 맞습니다 (${lines.filter((l) => l.startsWith('화면')).join(' · ') || 'X11'})`, lines, fix: null };
  }
  const text = level === 'ok' ? `화면 조작을 쓸 수 있습니다 (${lines.filter((l) => l.startsWith('화면')).join(' · ') || 'X11'})` : lines.filter((l) => !l.startsWith('X 도구: 모두') && !l.startsWith('세션 버스: 있음')).join(' · ');
  return { level, text, lines, fix: level === 'ok' || level === 'skip' ? null : fixes.join(' · ') || null };
}
