/**
 * 저장소 트랜잭션 깊이 (concurrency:CONC-10, ERR-02).
 * COMMIT이 한 번 실패하면 깊이를 두 번 줄여(-1) 이후 모든 중첩 트랜잭션(enqueue → nextId 등)이
 * 'cannot start a transaction within a transaction'으로 재시작 전까지 실패했다. 실제 SQLite COMMIT 실패(지연 외래 키)로 확인한다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../src/main/db/store';

let dir: string | null = null;
let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function open(): Store {
  dir = mkdtempSync(join(tmpdir(), 'wook-test-store-'));
  store = openStore(join(dir, 'wook.db'));
  store.db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
  return store;
}

describe('COMMIT 실패 뒤 트랜잭션 (CONC-10)', () => {
  it('COMMIT이 실패해도 다음 트랜잭션·중첩 트랜잭션이 정상 동작한다', () => {
    const s = open();
    expect(() => s.tx(() => s.db.exec('INSERT INTO c VALUES (999)'))).toThrow(/FOREIGN KEY/);
    expect(s.db.isTransaction).toBe(false);
    expect(s.tx(() => s.nextId('task'))).toBe('T-0001'); // tx 안의 nextId(tx) — 중첩
    expect(s.nextId('task')).toBe('T-0002');
    s.tx(() => s.kv.set('k', 1));
    expect(s.kv.get('k')).toBe(1);
  });

  it('실패한 트랜잭션의 쓰기는 남지 않는다', () => {
    const s = open();
    expect(() =>
      s.tx(() => {
        s.kv.set('half', 1);
        s.db.exec('INSERT INTO c VALUES (999)');
      }),
    ).toThrow();
    expect(s.kv.get('half')).toBeNull();
  });

  it('롤백까지 실패해 열린 채 남은 트랜잭션은 다음 트랜잭션이 정리한다', () => {
    const s = open();
    s.db.exec('BEGIN'); // 이전 실패가 남긴 상태 흉내
    s.db.exec('INSERT INTO p VALUES (1)');
    expect(s.tx(() => s.nextId('task'))).toBe('T-0001');
    expect(s.db.isTransaction).toBe(false);
  });
});
