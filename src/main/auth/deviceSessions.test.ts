/**
 * 대표의 기기 세션 저장소 (SERVER_DESIGN 3.5, 리드 결정 S3-4): `wos_` + 32바이트 base64url 토큰, 저장소(owner_sessions)에는 SHA-256 해시만,
 * 쉬다가 14일·최대 90일, 지금 등록된 대표의 세션만 살아 있음, 끊으면 듣는 쪽(SSE 닫기)에 알림. 1판 DB를 열면 새 표가 더해진다 (스키마 2판).
 * 2단계 시험용 세션(testSessions.test)의 보장 — 토큰 모양·발급한 토큰만 맞음·만료·끝나면 알림·열쇠는 원문이 아님 — 을 기기 세션으로 옮겼다
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../db/store';
import { cleanDeviceName, createDeviceSessionStore, deviceSessionView, hashSessionToken, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, sessionExpiresAt } from './deviceSessions';

const DAY = 24 * 60 * 60 * 1000;
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function rig(start = Date.parse('2026-10-30T00:00:00.000Z')) {
  const store = openStore(':memory:');
  stores.push(store);
  const clock = { t: start };
  const owner = { sub: 'owner-sub' as string | null };
  const sessions = createDeviceSessionStore({ store, ownerSub: () => owner.sub, now: () => clock.t });
  return { store, sessions, clock, owner };
}

/** 저장소의 owner_sessions 줄 전부 (날것) */
const rawRows = (store: Store): string => JSON.stringify(store.db.prepare('SELECT * FROM owner_sessions').all());

describe('토큰과 저장 (S3-4)', () => {
  it('토큰은 wos_ + 32바이트 base64url이고 매번 다르다 — 저장소에는 SHA-256 해시만 있다', () => {
    const r = rig();
    const a = r.sessions.issue({ deviceName: '휴대폰' });
    const b = r.sessions.issue({ deviceName: '노트북' });
    expect(/^wos_[A-Za-z0-9_-]{43}$/.test(a.token)).toBe(true);
    expect(Buffer.from(a.token.slice('wos_'.length), 'base64url')).toHaveLength(32);
    expect(a.token === b.token).toBe(false);
    expect(a.session.tokenHash).toBe(hashSessionToken(a.token));
    expect(a.session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const raw = rawRows(r.store);
    expect(raw.includes(a.token) || raw.includes(b.token)).toBe(false);
    expect(raw.includes(a.token.slice('wos_'.length))).toBe(false);
    expect(r.store.ownerSessions.byTokenHash(hashSessionToken(a.token))?.id).toBe(a.session.id);
  });

  it('발급한 토큰만 맞는다 — 한 글자 바꾼 토큰, 모양이 틀린 값, 빈 값은 저장소를 보지 않고 null', () => {
    const r = rig();
    const { token, session } = r.sessions.issue({ deviceName: '휴대폰' });
    expect(r.sessions.verify(token)?.id).toBe(session.id);
    expect(r.sessions.verify(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    for (const bad of ['wos_', `wos_test_${'A'.repeat(43)}`, token.slice('wos_'.length), `Bearer ${token}`, null, undefined, 42]) expect(r.sessions.verify(bad)).toBeNull();
  });

  it('세션 ID는 토큰과 상관없는 난수이고, 화면 모양에는 토큰·해시·대표 sub가 없다', () => {
    const r = rig();
    const { token, session } = r.sessions.issue({ deviceName: '휴대폰', tailscaleLogin: 'owner@github' });
    expect(session.id).toMatch(/^ds_[0-9a-f]{16}$/);
    const view = deviceSessionView(session, session.id);
    expect(view).toEqual({
      id: session.id,
      deviceName: '휴대폰',
      tailscaleLogin: 'owner@github',
      createdAt: '2026-10-30T00:00:00.000Z',
      lastUsedAt: '2026-10-30T00:00:00.000Z',
      expiresAt: new Date(Date.parse('2026-10-30T00:00:00.000Z') + SESSION_IDLE_MS).toISOString(),
      current: true,
    });
    expect(deviceSessionView(session, 'ds_other').current).toBe(false);
    const text = JSON.stringify(view);
    expect(text.includes(token) || text.includes(session.tokenHash) || text.includes('owner-sub')).toBe(false);
  });

  it('기기 이름은 제어 문자 없이 한 줄로 60자까지, 비면 이름 없는 기기', () => {
    expect(cleanDeviceName('  내\n휴대폰\u0007  ')).toBe('내 휴대폰');
    expect(cleanDeviceName('가'.repeat(80))).toBe('가'.repeat(60));
    for (const empty of ['', '   ', null, undefined, 3]) expect(cleanDeviceName(empty)).toBe('이름 없는 기기');
  });
});

describe('만료 (S3-4: 쉬다가 14일, 최대 90일)', () => {
  it('쓰지 않고 14일이 지나면 끝난다 — 그 전에 쓰면 쉬는 만료가 늦춰진다', () => {
    expect([SESSION_IDLE_MS, SESSION_ABSOLUTE_MS]).toEqual([14 * DAY, 90 * DAY]);
    const r = rig();
    const { token, session } = r.sessions.issue({ deviceName: '휴대폰' });
    expect(sessionExpiresAt(session)).toBe(r.clock.t + 14 * DAY);
    r.clock.t += 14 * DAY - 1;
    const used = r.sessions.verify(token);
    expect(used).not.toBeNull();
    // 쓴 것으로 적었다 — 마지막 사용과 쉬는 만료가 늦춰졌다
    expect(r.store.ownerSessions.get(session.id)).toMatchObject({ lastUsedAt: new Date(r.clock.t).toISOString(), idleExpiresAt: new Date(r.clock.t + 14 * DAY).toISOString() });
    r.clock.t += 14 * DAY - 1;
    expect(r.sessions.verify(token)).not.toBeNull();
    r.clock.t += 14 * DAY;
    expect(r.sessions.verify(token)).toBeNull();
    expect(r.sessions.live(session.id)).toBeNull();
    expect(r.sessions.list()).toEqual([]);
  });

  it('계속 써도 만든 때부터 90일이 지나면 끝난다', () => {
    const r = rig();
    const created = r.clock.t;
    const { token } = r.sessions.issue({ deviceName: '휴대폰' });
    for (let day = 13; day < 90; day += 13) {
      r.clock.t = created + day * DAY;
      expect(r.sessions.verify(token), `${day}일째`).not.toBeNull();
    }
    r.clock.t = created + 90 * DAY - 1;
    const last = r.sessions.verify(token);
    expect(last).not.toBeNull();
    expect(sessionExpiresAt(last!)).toBe(created + 90 * DAY);
    r.clock.t = created + 90 * DAY;
    expect(r.sessions.verify(token)).toBeNull();
  });

  it('마지막 사용은 1분에 한 번만 적는다 — 요청마다 DB에 쓰지 않는다', () => {
    const r = rig();
    const { token, session } = r.sessions.issue({ deviceName: '휴대폰' });
    r.clock.t += 59_000;
    r.sessions.verify(token);
    expect(r.store.ownerSessions.get(session.id)!.lastUsedAt).toBe(session.lastUsedAt);
    r.clock.t += 1_000;
    r.sessions.verify(token);
    expect(r.store.ownerSessions.get(session.id)!.lastUsedAt).toBe(new Date(r.clock.t).toISOString());
  });
});

describe('대표와 끊기 (S3-3·S3-4)', () => {
  it('지금 등록된 대표의 세션만 살아 있다 — 대표가 바뀌거나 없어지면 옛 세션은 맞지 않는다. 대표가 없으면 발급하지 않는다', () => {
    const r = rig();
    const { token, session } = r.sessions.issue({ deviceName: '휴대폰' });
    r.owner.sub = 'other-owner';
    expect([r.sessions.verify(token), r.sessions.live(session.id), r.sessions.list()]).toEqual([null, null, []]);
    r.owner.sub = null;
    expect(r.sessions.verify(token)).toBeNull();
    expect(() => r.sessions.issue({ deviceName: 'x' })).toThrow(expect.objectContaining({ code: 'conflict', message: '등록된 대표가 없어 기기 세션을 만들 수 없습니다' }));
    r.owner.sub = 'owner-sub';
    expect(r.sessions.verify(token)?.id).toBe(session.id);
  });

  it('끊으면 그 세션 ID로 알리고 다시는 맞지 않는다 — 다른 세션은 그대로, 없거나 이미 끊긴 세션은 null이고 알리지 않는다', () => {
    const r = rig();
    const revoked: string[] = [];
    const off = r.sessions.onRevoke((id) => revoked.push(id));
    const a = r.sessions.issue({ deviceName: '휴대폰' });
    const b = r.sessions.issue({ deviceName: '노트북' });
    const ended = r.sessions.revoke(a.session.id, 'owner');
    expect(ended).toMatchObject({ id: a.session.id, revokedBy: 'owner', revokedAt: new Date(r.clock.t).toISOString() });
    expect(revoked).toEqual([a.session.id]);
    expect(r.sessions.verify(a.token)).toBeNull();
    expect(r.sessions.verify(b.token)?.id).toBe(b.session.id);
    expect(r.store.ownerSessions.get(a.session.id)).toMatchObject({ revokedBy: 'owner' });
    expect(r.sessions.revoke(a.session.id, 'owner')).toBeNull();
    expect(r.sessions.revoke('ds_없음', 'owner')).toBeNull();
    expect(revoked).toEqual([a.session.id]);
    // 알림의 열쇠는 세션 ID — 토큰 원문이 아니다
    expect(revoked.some((k) => k.includes('wos_'))).toBe(false);
    expect(r.sessions.list().map((s) => s.id)).toEqual([b.session.id]);
    off();
    r.sessions.revoke(b.session.id, 'owner');
    expect(revoked).toEqual([a.session.id]);
  });

  it('모두 끊기(revokeAll)는 끊지 않은 세션마다 알리고 수를 돌려준다 — 만료된 세션도 끊어 둔다', () => {
    const r = rig();
    const revoked: string[] = [];
    r.sessions.onRevoke((id) => revoked.push(id));
    const a = r.sessions.issue({ deviceName: 'a' });
    r.clock.t += 15 * DAY;
    const b = r.sessions.issue({ deviceName: 'b' });
    expect(r.sessions.revokeAll('operator')).toBe(2);
    expect(revoked.sort()).toEqual([a.session.id, b.session.id].sort());
    expect(r.store.ownerSessions.listActive()).toEqual([]);
    expect(r.sessions.revokeAll('operator')).toBe(0);
  });

  it('듣는 쪽이 던져도 끊기는 끝까지 된다', () => {
    const r = rig();
    r.sessions.onRevoke(() => {
      throw new Error('SSE 닫기 실패');
    });
    const seen: string[] = [];
    r.sessions.onRevoke((id) => seen.push(id));
    const a = r.sessions.issue({ deviceName: 'a' });
    expect(r.sessions.revoke(a.session.id, 'owner')).not.toBeNull();
    expect(seen).toEqual([a.session.id]);
    expect(r.sessions.verify(a.token)).toBeNull();
  });
});

describe('스키마 이전 (S3-4)', () => {
  it('owner_sessions가 없는 1판 DB를 열면 표가 더해지고 지금 판(5판)이 된다 — 있던 자료는 그대로', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-device-sessions-migrate-'));
    dirs.push(dir);
    const file = join(dir, 'wook.db');
    // 1판 DB: 지금 판으로 만든 뒤 그 뒤에 생긴 표를 지우고 판 번호를 1로 되돌린다 (1판과 지금 판의 차이는 owner_sessions(2판)·request_replies(3판, S3-9)·
    // 메인 자리 seat·seat_history·seat_handover(4판, S4-2)·메인 일지 main_journal(5판, S4-6)·화면 조작 기록 gui_actions(6판, S6-7)다)
    const v1 = openStore(file);
    v1.kv.set('owner', { sub: 'owner-sub', email: 'owner@example.com', name: '대표', registeredAt: 'x', lastLoginAt: null });
    v1.db.exec('DROP TABLE owner_sessions');
    v1.db.exec('DROP TABLE request_replies');
    for (const t of ['seat', 'seat_history', 'seat_handover', 'main_journal', 'gui_actions', 'external_agents']) v1.db.exec(`DROP TABLE ${t}`);
    v1.db.exec(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
    v1.close();
    const check = openStore(file);
    stores.push(check);
    expect((check.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('7');
    expect(check.kv.get('owner')).toMatchObject({ sub: 'owner-sub', email: 'owner@example.com' });
    const sessions = createDeviceSessionStore({ store: check, ownerSub: () => 'owner-sub' });
    const { token, session } = sessions.issue({ deviceName: '휴대폰' });
    expect(sessions.verify(token)?.id).toBe(session.id);
    // 토큰 해시는 겹칠 수 없다
    expect(() => check.ownerSessions.insert({ ...session, id: 'ds_dup' })).toThrow();
  });
});
