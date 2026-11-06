/**
 * SSE 글 읽기 (리드 결정 S8-4) — `GET /api/events`의 바이트를 fetch 흐름으로 받아 줄로 나누고 `event:`·`data:` 칸을 모아 빈 줄에서 한 이벤트로 낸다.
 * EventSource 대신 쓰는 까닭: 살아 있음 신호(`: ping` 주석 줄)를 보고 감시하고, 200이 아닌 답 뒤에도 스스로 다시 잇기 위해서다.
 * 규칙은 HTML의 SSE 해석과 같다: 줄 끝은 \n·\r\n·\r(조각 사이에 갈라져도), `:`로 시작하는 줄은 주석, 칸 이름 뒤 `:` 다음의 공백 하나는 뺀다,
 * data 줄이 여럿이면 \n으로 잇는다, data 없이 끝난 이벤트는 내지 않는다. id·retry 칸은 서버가 보내지 않아 쓰지 않는다
 */

/** 한 줄의 상한 — 넘으면 흐름이 망가진 것으로 보고 끊는다(다시 잇는다). 스냅숏 한 장도 이보다 훨씬 작다 */
export const MAX_SSE_LINE_CHARS = 16 * 1024 * 1024;

export interface SseHandlers {
  onEvent(event: string, data: string): void;
  onComment?(text: string): void;
}

export interface SseParser {
  /** 디코드한 글 조각 하나를 넣는다 (조각 경계는 어디든 된다) */
  feed(text: string): void;
}

export function createSseParser(h: SseHandlers): SseParser {
  let partial = '';
  // 앞 조각이 \r로 끝났으면 이 조각 첫 \n은 같은 줄 끝이다
  let skipLF = false;
  let event = '';
  let data: string[] = [];

  const line = (text: string): void => {
    if (text === '') {
      if (data.length > 0) h.onEvent(event === '' ? 'message' : event, data.join('\n'));
      event = '';
      data = [];
      return;
    }
    if (text.charCodeAt(0) === 58 /* : */) {
      h.onComment?.(text.slice(1));
      return;
    }
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.charCodeAt(0) === 32 /* 공백 */) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return {
    feed(text: string): void {
      let start = 0;
      let i = 0;
      if (skipLF) {
        skipLF = false;
        if (text.charCodeAt(0) === 10) start = i = 1;
      }
      for (; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        const piece = partial + text.slice(start, i);
        partial = '';
        if (c === 13) {
          if (i + 1 < text.length) {
            if (text.charCodeAt(i + 1) === 10) i++;
          } else skipLF = true;
        }
        start = i + 1;
        line(piece);
      }
      partial += text.slice(start);
      if (partial.length > MAX_SSE_LINE_CHARS) throw new Error('SSE 한 줄이 너무 깁니다');
    },
  };
}
