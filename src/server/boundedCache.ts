/**
 * 수와 크기에 상한이 있는 캐시 (리드 결정 S8-26 c) — 정적 화면의 gzip과 내용 태그(ETag)를 모아 둔다. 넘으면 가장 오래 쓰지 않은 것부터 뺀다.
 * 상한이 찼다고 새 것을 받지 않는 일이 없다: 다시 빌드해 옛 파일의 자리가 쌓이거나 누가 요청을 많이 보내도 메모리는 상한 안이고, 새 파일도 다시 모은다
 */
export interface BoundedCacheLimits {
  /** 담는 수 */
  maxEntries: number;
  /** 담는 크기의 합 (set에 준 bytes의 합) */
  maxBytes: number;
}

export interface BoundedCache<V> {
  /** 있으면 돌려주고, 가장 최근에 쓴 것으로 친다 */
  get(key: string): V | undefined;
  /** 넣는다 (같은 열쇠는 바꾼다). 자리가 모자라면 가장 오래 쓰지 않은 것부터 뺀다. 하나가 상한보다 크면 넣지 않고 false */
  set(key: string, value: V, bytes?: number): boolean;
  delete(key: string): void;
  /** 이 크기 하나를 담을 수 있는가 */
  fits(bytes: number): boolean;
  readonly size: number;
  readonly bytes: number;
}

export function createBoundedCache<V>(limits: BoundedCacheLimits): BoundedCache<V> {
  const items = new Map<string, { value: V; bytes: number }>();
  let total = 0;
  const remove = (key: string): void => {
    const item = items.get(key);
    if (!item) return;
    items.delete(key);
    total -= item.bytes;
  };
  const fits = (bytes: number): boolean => limits.maxEntries >= 1 && bytes <= limits.maxBytes;
  return {
    get(key) {
      const item = items.get(key);
      if (!item) return undefined;
      // Map은 넣은 차례를 지킨다 — 다시 넣어 맨 뒤(가장 최근)로 옮긴다
      items.delete(key);
      items.set(key, item);
      return item.value;
    },
    set(key, value, bytes = 0) {
      remove(key);
      if (!fits(bytes)) return false;
      while (items.size >= limits.maxEntries || total + bytes > limits.maxBytes) remove(items.keys().next().value as string);
      items.set(key, { value, bytes });
      total += bytes;
      return true;
    },
    delete: remove,
    fits,
    get size() {
      return items.size;
    },
    get bytes() {
      return total;
    },
  };
}
