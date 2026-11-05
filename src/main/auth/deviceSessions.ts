/**
 * 대표의 기기 세션 (SERVER_DESIGN 3.5, 리드 결정 S3-4): 서버에 접속한 기기마다 세션 하나. 데스크톱 앱은 쓰지 않는다 — 데스크톱은 예전 그대로
 * kv `auth.session` 하나다 (S3-2).
 * - 토큰: `wos_` + 32바이트 난수(base64url). 원문은 발급할 때 한 번만 돌려주고, 저장소(owner_sessions)에는 SHA-256 해시만 둔다
 * - 만료: 마지막 사용에서 14일(쉬다가)과 만든 때에서 90일(최대) 가운데 이른 쪽. 쓸 때마다 쉬는 만료를 늦춘다 — 요청마다 DB에 쓰지 않게 1분에 한 번만 적는다
 * - 살아 있는 세션 = 끊지 않았고 만료 전이고 지금 등록된 대표의 것(ownerSub). 대표가 바뀌면 그 앞의 세션은 저절로 죽는다
 * - 끊으면(그 기기 로그아웃·기기 끊기·모두 끊기) 듣는 쪽에 알린다 — 서버가 그 세션으로 연 SSE를 닫는다
 * 쿠키·Bearer로 토큰을 읽는 일과 쿠키 만들기는 HTTP 쪽(src/server/sessions.ts)이 한다
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DeviceSessionView } from '@shared/views';
import type { OwnerSessionRow, Store } from '../db/store';
import { BackendError } from '../backend/types';

export const SESSION_TOKEN_PREFIX = 'wos_';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 쓰지 않고 지나면 끝나는 시간 (14일) */
export const SESSION_IDLE_MS = 14 * DAY_MS;
/** 만든 때부터 최대 (90일) */
export const SESSION_ABSOLUTE_MS = 90 * DAY_MS;
/** 마지막 사용 시각을 다시 적는 간격 */
const TOUCH_EVERY_MS = 60_000;
/** 접두어 + 32바이트 base64url(43자) — HTTP 층이 주소에 실린 토큰을 알아볼 때도 쓴다 (sessions.ts queryCarriesToken, S3-24) */
export const SESSION_TOKEN_RE = /^wos_[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = SESSION_TOKEN_RE;
/** 기기 이름 상한 (화면에 보이는 이름) */
const MAX_DEVICE_NAME = 60;

export type DeviceSessionRecord = OwnerSessionRow;

export interface DeviceSessionStore {
  /** 지금 등록된 대표의 새 세션. 토큰 원문은 여기서만 나간다. 등록된 대표가 없으면 BackendError('conflict') */
  issue(o: { deviceName: string; tailscaleLogin?: string | null }): { token: string; session: DeviceSessionRecord };
  /** 맞고 살아 있는 토큰이면 그 세션(쓴 것으로 적는다), 아니면 null. 토큰 모양이 아니면 저장소를 보지 않는다 */
  verify(token: unknown): DeviceSessionRecord | null;
  /** 살아 있는 세션 (쓴 것으로 적지 않는다) */
  live(id: string): DeviceSessionRecord | null;
  /** 살아 있는 세션 모두 (만든 차례) */
  list(): DeviceSessionRecord[];
  /** 살아 있는 세션 하나를 끊는다 — 끊은 세션, 없거나 이미 끝났으면 null */
  revoke(id: string, by: string): DeviceSessionRecord | null;
  /** 끊지 않은 세션을 모두 끊는다 (대표가 바뀔 때 등) — 끊은 수 */
  revokeAll(by: string): number;
  /** 세션을 끊을 때마다 그 ID로 부른다. 푸는 함수를 돌려준다 */
  onRevoke(listener: (id: string) => void): () => void;
}

export interface DeviceSessionStoreOptions {
  store: Pick<Store, 'ownerSessions'>;
  /** 지금 등록된 대표의 sub (없으면 null — 그때는 살아 있는 세션이 없다) */
  ownerSub(): string | null;
  /** 벽시계 (epoch ms) */
  now?: () => number;
  /** 시험: 만료 시간 */
  idleMs?: number;
  absoluteMs?: number;
}

export const hashSessionToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** 세션이 끝나는 때 (epoch ms) — 쉬는 만료와 최대 만료 가운데 이른 쪽 */
export function sessionExpiresAt(r: Pick<DeviceSessionRecord, 'idleExpiresAt' | 'absoluteExpiresAt'>): number {
  return Math.min(Date.parse(r.idleExpiresAt), Date.parse(r.absoluteExpiresAt));
}

/** 화면에 보내는 모양 — 토큰·해시·대표 sub는 넣지 않는다 */
export function deviceSessionView(r: DeviceSessionRecord, currentId: string | null): DeviceSessionView {
  return {
    id: r.id,
    deviceName: r.deviceName,
    tailscaleLogin: r.tailscaleLogin,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: new Date(sessionExpiresAt(r)).toISOString(),
    current: r.id === currentId,
  };
}

/** 기기 이름: 제어 문자를 빼고 한 줄로, 60자까지. 비면 '이름 없는 기기' */
export function cleanDeviceName(name: unknown): string {
  const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text ? [...text].slice(0, MAX_DEVICE_NAME).join('') : '이름 없는 기기';
}

export function createDeviceSessionStore(o: DeviceSessionStoreOptions): DeviceSessionStore {
  const repo = o.store.ownerSessions;
  const now = o.now ?? Date.now;
  const idleMs = o.idleMs ?? SESSION_IDLE_MS;
  const absoluteMs = o.absoluteMs ?? SESSION_ABSOLUTE_MS;
  const listeners = new Set<(id: string) => void>();
  const iso = (ms: number): string => new Date(ms).toISOString();

  const alive = (r: DeviceSessionRecord | null, t: number): r is DeviceSessionRecord => {
    if (!r || r.revokedAt) return false;
    if (t >= sessionExpiresAt(r)) return false;
    const owner = o.ownerSub();
    return owner !== null && r.ownerSub === owner;
  };

  const announce = (id: string): void => {
    for (const l of [...listeners]) {
      try {
        l(id);
      } catch {
        // 듣는 쪽(SSE 닫기)의 실패는 그쪽 일이다 — 세션 끊기를 막지 않는다
      }
    }
  };

  return {
    issue({ deviceName, tailscaleLogin }) {
      const ownerSub = o.ownerSub();
      if (!ownerSub) throw new BackendError('conflict', '등록된 대표가 없어 기기 세션을 만들 수 없습니다');
      const t = now();
      const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const absolute = t + absoluteMs;
      const session: DeviceSessionRecord = {
        id: `ds_${randomBytes(8).toString('hex')}`,
        tokenHash: hashSessionToken(token),
        deviceName: cleanDeviceName(deviceName),
        tailscaleLogin: typeof tailscaleLogin === 'string' && tailscaleLogin.trim() ? tailscaleLogin.trim().slice(0, 200) : null,
        ownerSub,
        createdAt: iso(t),
        lastUsedAt: iso(t),
        idleExpiresAt: iso(Math.min(t + idleMs, absolute)),
        absoluteExpiresAt: iso(absolute),
        revokedAt: null,
        revokedBy: null,
      };
      repo.insert(session);
      return { token, session };
    },
    verify(token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const r = repo.byTokenHash(hashSessionToken(token));
      const t = now();
      if (!alive(r, t)) return null;
      if (t - Date.parse(r.lastUsedAt) < TOUCH_EVERY_MS) return r;
      const touched = { ...r, lastUsedAt: iso(t), idleExpiresAt: iso(Math.min(t + idleMs, Date.parse(r.absoluteExpiresAt))) };
      repo.touch(r.id, touched.lastUsedAt, touched.idleExpiresAt);
      return touched;
    },
    live(id) {
      const r = typeof id === 'string' ? repo.get(id) : null;
      return alive(r, now()) ? r : null;
    },
    list() {
      const t = now();
      return repo.listActive().filter((r) => alive(r, t));
    },
    revoke(id, by) {
      const r = typeof id === 'string' ? repo.get(id) : null;
      const t = now();
      if (!alive(r, t) || !repo.revoke(r.id, iso(t), by)) return null;
      announce(r.id);
      return { ...r, revokedAt: iso(t), revokedBy: by };
    },
    revokeAll(by) {
      const at = iso(now());
      let n = 0;
      for (const r of repo.listActive()) {
        if (!repo.revoke(r.id, at, by)) continue;
        n++;
        announce(r.id);
      }
      return n;
    },
    onRevoke(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
