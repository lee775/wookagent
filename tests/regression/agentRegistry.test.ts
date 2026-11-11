/**
 * 외부 에이전트 등록 기록 (SERVER_DESIGN 4.1·4.5, 리드 결정 S7-2·S7-3 — orchestrator/externalAgents.ts):
 * - 등록은 ID(X-0001)와 키 `wsk_` + 32바이트 base64url을 낸다. 키 원문은 그 반환값에만 있다 — DB에는 sha256만, 활동 기록(auth, 행위자 operator)에도 키가 없다
 * - 이름은 1~40자, 제어·서식 문자 없이, 폐기하지 않은 에이전트끼리 겹치지 않는다(NFC·대소문자 무시). 비밀 값처럼 보이는 이름은 받지 않는다. 거부 글은 이름을
 *   되풀이하지 않고 아무것도 바꾸지 않는다
 * - 폐기는 되풀이해도 된다(already). 모르는 ID는 not_found, 모양이 틀린 ID는 invalid_args(값을 되풀이하지 않음). 폐기 뒤 정리(S7b의 이음매)는 한 번만 부른다
 * - 대표의 agents.list는 보기만 한다 — 키·해시 칸이 없다
 * - 인증(authenticate, S7b가 쓴다): 맞는 키만 그 에이전트. 모르는·폐기된·모양이 틀린 키는 null이고 무엇도 바꾸지 않는다. 이 실행에서 처음 인증할 때 키를 백엔드
 *   가리개에 넣고, 마지막 접속은 간격을 두고 DB에 적는다(그 사이 값은 목록이 보인다)
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { REDACT_KINDS } from '@core/redact';
import { AGENT_ID_SHAPE, AGENT_KEY_RE, AGENT_SEEN_WRITE_MS } from '../../src/main/orchestrator/externalAgents';
import type { Clock } from '@core/time';
import { bootOrch, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 실제 시계 + 차이 (마지막 접속의 쓰기 간격을 넘긴다) */
function offsetClock(): Clock & { advance(ms: number): void } {
  let off = 0;
  return {
    now: () => new Date(Date.now() + off),
    iso: () => new Date(Date.now() + off).toISOString(),
    ms: () => Date.now() + off,
    advance(ms: number) {
      off += ms;
    },
  };
}

/** DB의 모든 표의 모든 칸 (키 원문이 어디에도 없는지) */
function dbText(e: OrchEnv): string {
  const db = e.ctx.store.db;
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

/** 운영자의 auth 활동 기록 (새 것부터) — 시작 때의 개발 모드 로그인 등 다른 auth 줄은 빼고 본다 */
const authRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['auth'], limit: 200 }).filter((x) => x.actor === OPERATOR);

const errorOf = (fn: () => unknown): { code: string; message: string } => {
  try {
    fn();
  } catch (err) {
    return { code: (err as { code: string }).code, message: (err as Error).message };
  }
  throw new Error('거부되지 않았습니다');
};

describe('외부 에이전트 등록·폐기·목록 (S7-2)', () => {
  it('등록은 ID와 키를 한 번 낸다 — DB에는 해시만, 활동 기록은 auth·operator로 키 없이, 대표의 agents.list에는 키·해시 칸이 없다', async () => {
    const e = (env = await bootOrch());
    const a = e.core.externalAgents.add('  그록봇 ');
    const b = e.core.externalAgents.add('테스트봇');
    expect([a.id, a.label, b.id]).toEqual(['X-0001', '그록봇', 'X-0002']);
    expect(AGENT_KEY_RE.test(a.key) && AGENT_KEY_RE.test(b.key) && a.key !== b.key).toBe(true);
    const row = e.ctx.store.externalAgents.get('X-0001')!;
    expect(row).toEqual({ id: 'X-0001', label: '그록봇', keyHash: createHash('sha256').update(a.key).digest('hex'), createdAt: a.createdAt, revokedAt: null, revokedBy: null, lastSeenAt: null });
    // 키 원문(과 그 몸통)은 DB 어디에도 없다
    const all = dbText(e);
    expect([a.key, b.key, a.key.slice(4, 30)].map((k) => all.includes(k))).toEqual([false, false, false]);
    expect(authRows(e).map((x) => [x.actor, x.level, x.text]).reverse()).toEqual([
      [OPERATOR, 'info', '외부 에이전트를 등록함: X-0001 (그록봇) — 키는 운영자 명령에 한 번만 보였고 해시만 저장함'],
      [OPERATOR, 'info', '외부 에이전트를 등록함: X-0002 (테스트봇) — 키는 운영자 명령에 한 번만 보였고 해시만 저장함'],
    ]);
    // 등록한 실행에서는 키가 도구 인자·CLI 출력에 찍혀도 가린다 — 모양 규칙이 닿지 않는 꼴(앞에 글자가 붙음)도 등록 값으로
    expect(e.ctx.redact.text(`_${a.key}`)).toBe(`_[가림:${REDACT_KINDS.wookAgentKey}]`);

    const views = await e.invoke('agents.list');
    expect(views).toEqual([
      { id: 'X-0001', label: '그록봇', createdAt: a.createdAt, revokedAt: null, lastSeenAt: null, seat: null, connected: false },
      { id: 'X-0002', label: '테스트봇', createdAt: b.createdAt, revokedAt: null, lastSeenAt: null, seat: null, connected: false },
    ]);
    expect(JSON.stringify(views).includes(row.keyHash)).toBe(false);
  });

  it('이름: 비었거나 40자를 넘거나 제어·서식 문자가 있거나 비밀 값처럼 보이거나 폐기하지 않은 에이전트와 겹치면 거부한다 — 이름을 되풀이하지 않고 아무것도 바꾸지 않는다', async () => {
    const e = (env = await bootOrch());
    e.core.externalAgents.add('Grok Bot');
    const before = { rows: e.ctx.store.externalAgents.list(), activity: authRows(e).length };
    // GitHub 토큰 모양 (40자 안) — 실행 중에 조립한다
    const secretish = ['gh', 'p_', 'Q1w2E3r4T5y6U7i8O9p0A1s2'].join('');
    const bad: [string, string, string][] = [
      ['', 'invalid', '외부 에이전트 이름이 비었습니다 — --label 뒤에 1~40자의 이름을 적으세요'],
      ['   ', 'invalid', '외부 에이전트 이름이 비었습니다 — --label 뒤에 1~40자의 이름을 적으세요'],
      ['가'.repeat(41), 'invalid', '외부 에이전트 이름은 40자까지입니다 (41자) — 적은 이름은 보이지 않습니다'],
      ['줄\n바꿈', 'invalid', '외부 에이전트 이름에 제어 문자(줄바꿈·탭·보이지 않는 서식 글자 등)를 넣을 수 없습니다 — 적은 이름은 보이지 않습니다'],
      ['탭\t이름', 'invalid', '외부 에이전트 이름에 제어 문자(줄바꿈·탭·보이지 않는 서식 글자 등)를 넣을 수 없습니다 — 적은 이름은 보이지 않습니다'],
      ['방향\u202e바꿈', 'invalid', '외부 에이전트 이름에 제어 문자(줄바꿈·탭·보이지 않는 서식 글자 등)를 넣을 수 없습니다 — 적은 이름은 보이지 않습니다'],
      ['폭없는\u200b글자', 'invalid', '외부 에이전트 이름에 제어 문자(줄바꿈·탭·보이지 않는 서식 글자 등)를 넣을 수 없습니다 — 적은 이름은 보이지 않습니다'],
      [secretish, 'invalid', '외부 에이전트 이름에 비밀 값처럼 보이는 글이 있어 받지 않습니다 — 다른 이름을 쓰세요 (적은 이름은 보이지 않습니다)'],
      ['grok bot', 'conflict', '같은 이름의 외부 에이전트(X-0001)가 이미 있습니다 — 다른 이름을 쓰거나, 그 에이전트를 wook-server agent revoke X-0001로 폐기한 뒤 등록하세요'],
    ];
    for (const [label, code, message] of bad) expect([JSON.stringify(label), errorOf(() => e.core.externalAgents.add(label))]).toEqual([JSON.stringify(label), { code, message }]);
    // 40자(코드 포인트)는 받는다 — 한글·이모지도 한 글자
    expect(e.core.externalAgents.add('봇'.repeat(39) + '🤖').id).toBe('X-0002');
    expect({ rows: e.ctx.store.externalAgents.list().slice(0, 1), activity: authRows(e).length - 1 }).toEqual(before);
    // NFC로 맞춰 견준다 — 조합형 '그록'과 완성형 '그록'은 같은 이름이다
    e.core.externalAgents.add('그록');
    expect(errorOf(() => e.core.externalAgents.add('그록'.normalize('NFD'))).code).toBe('conflict');
    // 폐기한 에이전트의 이름은 다시 쓸 수 있다 — 새 ID
    e.core.externalAgents.revoke('X-0001');
    expect(e.core.externalAgents.add('Grok Bot').id).toBe('X-0004');
  });

  it('폐기는 되풀이해도 된다 — 처음만 바꾸고 기록하며 정리 이음매를 한 번 부른다. 모르는 ID는 not_found, 모양이 틀린 ID는 되풀이하지 않는 invalid_args', async () => {
    const e = (env = await bootOrch());
    const a = e.core.externalAgents.add('그록봇');
    const revoked = vi.fn();
    e.core.externalAgents.hooks.onRevoked = revoked;
    const first = e.core.externalAgents.revoke('X-0001');
    expect(first).toEqual({ id: 'X-0001', label: '그록봇', revokedAt: expect.any(String), already: false, seated: false });
    const second = e.core.externalAgents.revoke(' X-0001 ');
    expect(second).toEqual({ ...first, already: true });
    expect(revoked.mock.calls.map((c) => [c[0].id, c[0].revokedBy])).toEqual([['X-0001', 'operator']]);
    expect(e.ctx.store.externalAgents.get('X-0001')).toMatchObject({ revokedAt: first.revokedAt, revokedBy: 'operator' });
    expect(authRows(e).map((x) => x.text)).toEqual(['외부 에이전트 키를 폐기함: X-0001 (그록봇)', expect.stringMatching(/^외부 에이전트를 등록함: X-0001/)]);
    expect(errorOf(() => e.core.externalAgents.revoke('X-0099'))).toEqual({ code: 'not_found', message: '등록된 외부 에이전트 X-0099이(가) 없습니다 — wook-server agent list로 ID를 확인하세요' });
    const mark = 'GOCSPX-revoke-echo-mark';
    expect(errorOf(() => e.core.externalAgents.revoke(mark))).toEqual({ code: 'invalid_args', message: AGENT_ID_SHAPE });
    // 정리 이음매가 던져도 폐기는 그대로다
    e.core.externalAgents.add('둘째');
    e.core.externalAgents.hooks.onRevoked = () => {
      throw new Error('정리 실패');
    };
    expect(e.core.externalAgents.revoke('X-0002').already).toBe(false);
    expect(e.core.externalAgents.authenticate(a.key)).toBeNull();
    expect((await e.invoke('agents.list')).map((v) => [v.id, !!v.revokedAt])).toEqual([
      ['X-0001', true],
      ['X-0002', true],
    ]);
  });
});

describe('에이전트 키 인증 (S7-3 — 에이전트 API의 이음매)', () => {
  it('맞는 키만 그 에이전트다 — 모르는·폐기된·모양이 틀린 키는 null이고 무엇도 바꾸지 않는다', async () => {
    const e = (env = await bootOrch());
    const a = e.core.externalAgents.add('그록봇');
    const forged = `wsk_${'A'.repeat(43)}`;
    const before = JSON.stringify(e.ctx.store.externalAgents.list());
    for (const k of [forged, a.key.slice(0, -1), `${a.key}x`, a.key.toUpperCase(), ` ${a.key}`, '', null, 42, a.key.slice(4)]) {
      expect(e.core.externalAgents.authenticate(k)).toBeNull();
    }
    expect(JSON.stringify(e.ctx.store.externalAgents.list())).toBe(before);
    expect(e.core.externalAgents.authenticate(a.key)).toMatchObject({ id: 'X-0001', label: '그록봇' });
    e.core.externalAgents.revoke('X-0001');
    expect(e.core.externalAgents.authenticate(a.key)).toBeNull();
  });

  it('다시 시작한 서버(해시만 있음)는 처음 인증할 때 키를 백엔드 가리개에 한 번 넣는다', async () => {
    const e = (env = await bootOrch());
    // 앞 실행이 등록한 것처럼 — 이 실행의 가리개는 키를 모른다
    const key = `wsk_${'Pq7_'.repeat(10)}abc`;
    e.ctx.store.externalAgents.insert({ id: 'X-0001', label: '그록봇', keyHash: createHash('sha256').update(key).digest('hex'), createdAt: e.ctx.now(), revokedAt: null, revokedBy: null, lastSeenAt: null });
    // 모양 규칙이 닿지 않는 꼴(앞에 글자가 붙음)은 등록 전에는 가려지지 않는다
    expect(e.ctx.redact.text(`_${key}`)).toBe(`_${key}`);
    const add = vi.spyOn(e.ctx.redact, 'addSecret');
    expect(e.core.externalAgents.authenticate(key)?.id).toBe('X-0001');
    expect(e.core.externalAgents.authenticate(key)?.id).toBe('X-0001');
    expect(add.mock.calls.filter((c) => c[0] === key)).toHaveLength(1);
    expect(e.ctx.redact.text(`_${key}`)).toBe(`_[가림:${REDACT_KINDS.wookAgentKey}]`);
  });

  it('마지막 접속은 인증마다 목록에 보이지만 DB에는 간격(30초)을 두고 적는다', async () => {
    const clock = offsetClock();
    const e = (env = await bootOrch({ clock }));
    const a = e.core.externalAgents.add('그록봇');
    const t1 = e.core.externalAgents.authenticate(a.key)!.lastSeenAt!;
    expect(e.ctx.store.externalAgents.get('X-0001')!.lastSeenAt).toBe(t1);
    clock.advance(10_000);
    e.core.externalAgents.authenticate(a.key);
    const seen = (await e.invoke('agents.list'))[0]!.lastSeenAt!;
    expect([e.ctx.store.externalAgents.get('X-0001')!.lastSeenAt, Date.parse(seen) - Date.parse(t1) >= 10_000]).toEqual([t1, true]);
    clock.advance(AGENT_SEEN_WRITE_MS);
    e.core.externalAgents.authenticate(a.key);
    expect(Date.parse(e.ctx.store.externalAgents.get('X-0001')!.lastSeenAt!) - Date.parse(t1)).toBeGreaterThanOrEqual(10_000 + AGENT_SEEN_WRITE_MS);
  });
});
