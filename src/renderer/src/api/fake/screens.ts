import type { GuiActionView, GuiResult, ScreenCaptureView, ScreenFilter, ScreenImageView, ScreenRecentView, SeatScreenView } from '../../../../shared/views';
import { SCREEN_PREVIEW_PNG, SCREEN_PREVIEW_SHA256 } from './screenPng';

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
export function fakeScreenState(scenario: string | null): SeatScreenView {
  const state: SeatScreenView = { unavailable: null, operatingSince: null, paused: null };
  if (scenario === 'operating' || scenario === 'human' || scenario === 'local') state.operatingSince = ago(120);
  if (scenario === 'human' || scenario === 'local') state.paused = { by: scenario, since: ago(5), until: new Date(Date.now() + (scenario === 'human' ? 25 : 295) * 1000).toISOString() };
  if (scenario === 'locked') state.unavailable = { code: 'locked', text: '서버 PC의 화면이 잠겼습니다. 서버 PC 운영자에게 잠금 해제를 부탁하세요.', since: ago(60) };
  if (scenario === 'desktop') state.unavailable = { code: 'desktop_mode', text: '데스크톱 앱에서는 화면 조작을 쓰지 않습니다. 서버 모드의 서버 PC에서만 씁니다.', since: ago(60) };
  return state;
}

export function createFakeScreens() {
  const captures: ScreenCaptureView[] = [0, 1, 2].map(index => ({
    id: `SC-00000${3 - index}`, at: ago(30 + index * 60), generation: index === 2 ? 2 : 3, holderLabel: index === 2 ? 'Codex CLI' : 'Claude CLI',
    turnId: `TN-screen-${index}`, projectId: 'P-0001', screen: index === 2 ? 'all' : 1, width: 640, height: 360, scale: 0.5,
    cause: index === 0 ? 'after_input' : 'capture', focus: '메모장 · 산책 기록', sha256: SCREEN_PREVIEW_SHA256, kept: index !== 2,
  }));
  const results = ['ok', 'secret_blocked', 'human_active', 'sent', 'error', 'invalid', 'conflict', 'stopped', 'seat_changed', 'stale_capture', 'rate_limited', 'denied_target', 'unavailable'] satisfies GuiResult[];
  const actions: GuiActionView[] = results.map((result, index) => ({
    id: `GA-${String(100 - index).padStart(6, '0')}`, at: ago(40 + index * 15), generation: index < 9 ? 3 : 2,
    holderLabel: index < 9 ? 'Claude CLI' : 'Codex CLI', turnId: 'TN-screen-0', projectId: 'P-0001', by: index === 7 ? 'server' : 'main',
    action: index < 2 ? 'type' : index === 7 ? 'stop' : index === 3 ? 'key' : index === 4 ? 'drag' : 'click',
    x: index < 2 ? null : 480, y: index < 2 ? null : 312, x2: index === 4 ? 640 : null, y2: index === 4 ? 400 : null,
    button: index < 2 ? null : 'left', count: index < 2 ? null : 1, amount: null, keys: index === 3 ? 'Ctrl+S' : null,
    text: index === 0 ? '산책 기록을 저장했습니다.' : null, textLength: index === 0 ? 14 : index === 1 ? 24 : null,
    focus: { app: '메모장', title: '산책 기록', password: index === 1 ? null : false }, result,
    detail: result === 'secret_blocked' ? '비밀 값이 포함되어 입력을 막았습니다.' : result === 'sent' ? '입력은 보냈으며 결과를 기다리고 있습니다.' : result === 'human_active' ? '서버 PC 앞 사람의 입력이 끝나기를 기다립니다.' : null,
    beforeCaptureId: index < 9 ? captures[1].id : captures[2].id, afterCaptureId: index === 0 ? captures[0].id : null,
  }));
  return {
    captures, actions,
    recent(filter: ScreenFilter = {}): ScreenRecentView {
      const start = filter.before ? actions.findIndex(row => row.id === filter.before) + 1 : 0;
      const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
      const page = actions.slice(start, start + limit);
      return structuredClone({ captures, actions: page, nextCursor: start + limit < actions.length ? page.at(-1)?.id ?? null : null });
    },
    image(id: string): ScreenImageView | null {
      const capture = captures.find(row => row.id === id);
      return capture?.kept ? { id, mime: 'image/png', dataUrl: SCREEN_PREVIEW_PNG, width: capture.width, height: capture.height } : null;
    },
  };
}
