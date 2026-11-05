/**
 * 같은 종류의 기록을 창마다 한 줄로 모은다 (S2-16·S2-20): 창의 첫 줄은 바로 쓰고, 그 창에 더 온 것은 창이 끝날 때 수만 한 줄로 쓴다.
 * 계속 오면 창마다 한 줄이다. 닫을 때(flush) 남은 수도 쓴다. 토큰 없이 누구나 여는 쪽이 기록 회전(5MB × 4)을 밀어내지 못하게 —
 * 관리 채널(admin.ts — 인증 없는 연결·시간 초과)과 HTTP(http.ts — 거부한 요청·정적 화면 요청의 접근 줄)가 쓴다
 */

export interface CollapsedLog<K extends string> {
  /** 그 종류의 창이 열려 있지 않으면 text를 쓰고 창을 연다. 열려 있으면 세기만 한다 */
  log(kind: K, text: string): void;
  /** 열린 창을 모두 닫으며 남은 수를 쓴다 (닫을 때) */
  flush(): void;
}

export interface CollapsedLogOptions<K extends string> {
  /** 쓰기 — 종류도 넘긴다 (종류마다 기록 수준이 다를 때) */
  write: (text: string, kind: K) => void;
  windowMs: number;
  /** 창이 끝날 때 쓰는 한 줄. span은 창 길이 글('1분', '2초') */
  summary: (kind: K, extra: number, span: string) => string;
}

export function collapsedLog<K extends string>(o: CollapsedLogOptions<K>): CollapsedLog<K> {
  const span = o.windowMs % 60_000 === 0 ? `${o.windowMs / 60_000}분` : `${o.windowMs / 1000}초`;
  const open = new Map<K, { extra: number; timer: ReturnType<typeof setTimeout> }>();
  const summarize = (kind: K, extra: number): void => {
    if (extra > 0) o.write(o.summary(kind, extra, span), kind);
  };
  const start = (kind: K): void => {
    const timer = setTimeout(() => {
      const w = open.get(kind);
      open.delete(kind);
      if (!w || w.extra === 0) return;
      summarize(kind, w.extra);
      start(kind); // 계속 오면 다음 창도 수만 한 줄로
    }, o.windowMs);
    timer.unref?.();
    open.set(kind, { extra: 0, timer });
  };
  return {
    log(kind, text) {
      const w = open.get(kind);
      if (w) {
        w.extra += 1;
        return;
      }
      o.write(text, kind);
      start(kind);
    },
    flush() {
      for (const [kind, w] of [...open]) {
        clearTimeout(w.timer);
        open.delete(kind);
        summarize(kind, w.extra);
      }
    },
  };
}
