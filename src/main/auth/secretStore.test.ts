import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SECRET_KEYS } from './types';
import { SecretStoreError, createSecretStore, createSecretStoreOn, type RawSecretBackend } from './secretStore';

/** 테스트에서 저장 칸을 직접 들여다보고 망가뜨리기 위한 메모리 칸 */
function inspectableBackend(): RawSecretBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (a) => map.get(a) ?? null,
    set: async (a, v) => {
      map.set(a, v);
    },
    delete: async (a) => map.delete(a),
    list: async () => [...map.keys()],
  };
}

const LONG = ('가나다라마바사😀abc' + '0123456789').repeat(300); // 약 6000 UTF-16 글자, 이모지 포함

describe('메모리 저장소', () => {
  it('저장·읽기·덮어쓰기·삭제', async () => {
    const s = createSecretStore({ service: 'wookagent-test', forceMemory: true });
    expect(s.backend).toBe('memory');
    expect(s.fallbackReason).toBeNull();
    expect(await s.get(SECRET_KEYS.apiKeyClaude)).toBeNull();
    await s.set(SECRET_KEYS.apiKeyClaude, 'v1');
    await s.set(SECRET_KEYS.apiKeyClaude, 'v2');
    expect(await s.get(SECRET_KEYS.apiKeyClaude)).toBe('v2');
    await s.delete(SECRET_KEYS.apiKeyClaude);
    expect(await s.get(SECRET_KEYS.apiKeyClaude)).toBeNull();
    await expect(s.delete(SECRET_KEYS.apiKeyClaude)).resolves.toBeUndefined();
    await s.set('empty', '');
    expect(await s.get('empty')).toBe('');
  });

  it('긴 값(한도 초과)과 머리 표시로 시작하는 값도 그대로 돌려준다', async () => {
    const s = createSecretStore({ service: 'wookagent-test', forceMemory: true });
    await s.set('long', LONG);
    expect(await s.get('long')).toBe(LONG);
    await s.set('tricky', 'wook-chunked:v1:short');
    expect(await s.get('tricky')).toBe('wook-chunked:v1:short');
  });

  it('잘못된 이름·값은 거부한다 (Promise 거부로)', async () => {
    const s = createSecretStore({ service: 'wookagent-test', forceMemory: true });
    for (const key of ['', '   ', 'a#b', 'a\nb', 'x'.repeat(201)]) {
      await expect(s.get(key)).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(s.set(key, 'v')).rejects.toBeInstanceOf(SecretStoreError);
    }
    await expect(s.set('k', 42 as unknown as string)).rejects.toMatchObject({ code: 'invalid_value' });
    expect(() => createSecretStore({ service: ' ' })).toThrow(SecretStoreError);
  });

  it('같은 키의 동시 저장은 한 줄로 처리되어 섞이지 않는다', async () => {
    const raw = inspectableBackend();
    const s = createSecretStoreOn(raw, 'memory');
    const values = Array.from({ length: 8 }, (_, i) => `${i}:`.repeat(800 + i * 100));
    await Promise.all(values.map((v) => s.set('k', v)));
    expect(await s.get('k')).toBe(values[values.length - 1]);
    // 마지막 값의 조각만 남는다
    const header = raw.map.get('k')!;
    const gen = header.split(':')[2];
    const chunkAccounts = [...raw.map.keys()].filter((a) => a.startsWith('k#'));
    expect(chunkAccounts.length).toBeGreaterThan(1);
    expect(chunkAccounts.every((a) => a.startsWith(`k#${gen}#`))).toBe(true);
  });
});

describe('나눠 담기', () => {
  it('짧은 값은 한 칸, 긴 값은 1000자 조각 + 머리, 짧게 바꾸면 조각을 지운다', async () => {
    const raw = inspectableBackend();
    const s = createSecretStoreOn(raw, 'memory');
    await s.set('k', 'short');
    expect([...raw.map.keys()]).toEqual(['k']);
    await s.set('k', LONG);
    const header = /^wook-chunked:v1:([0-9a-f]{8}):(\d+):(\d+):[0-9a-f]{64}$/.exec(raw.map.get('k')!);
    expect(header).not.toBeNull();
    const [, gen, count, length] = header!;
    const parts = Array.from({ length: Number(count) }, (_, i) => raw.map.get(`k#${gen}#${i}`));
    expect(parts.every((p) => p !== undefined && p.length <= 1000)).toBe(true);
    expect(parts.join('')).toBe(LONG);
    expect(Number(length)).toBe(LONG.length);
    expect([...raw.map.keys()].filter((a) => a.startsWith('k#'))).toHaveLength(Number(count));
    await s.set('k', 'short again');
    expect([...raw.map.keys()]).toEqual(['k']);
    await s.set('k', LONG);
    await s.delete('k');
    expect(raw.map.size).toBe(0);
  });

  it('조각이 없거나 바뀌면 틀린 값을 주지 않고 corrupt 오류를 낸다', async () => {
    const raw = inspectableBackend();
    const s = createSecretStoreOn(raw, 'memory');
    await s.set('k', LONG);
    const first = [...raw.map.keys()].find((a) => a.endsWith('#0'))!;
    const saved = raw.map.get(first)!;
    raw.map.set(first, saved.replace(/^./, 'X'));
    await expect(s.get('k')).rejects.toMatchObject({ code: 'corrupt' });
    raw.map.delete(first);
    await expect(s.get('k')).rejects.toMatchObject({ code: 'corrupt' });
    raw.map.set('k', 'wook-chunked:v1:broken');
    await expect(s.get('k')).rejects.toMatchObject({ code: 'corrupt' });
    // 손상된 값도 새로 저장하면 정상으로 돌아오고 남은 조각은 치운다
    await s.set('k', 'fresh');
    expect(await s.get('k')).toBe('fresh');
    expect([...raw.map.keys()]).toEqual(['k']);
  });

  it('중간에 끊긴 쓰기가 남긴 조각은 다음 저장 때 치운다', async () => {
    const raw = inspectableBackend();
    raw.map.set('k#deadbeef#0', 'orphan');
    raw.map.set('k#deadbeef#1', 'orphan');
    raw.map.set('other#deadbeef#0', 'keep');
    const s = createSecretStoreOn(raw, 'memory');
    await s.set('k', 'v');
    expect([...raw.map.keys()].sort()).toEqual(['k', 'other#deadbeef#0']);
  });

  it('조각 정리가 실패해도 저장은 성공하고 경고로 알린다', async () => {
    const raw = inspectableBackend();
    const warnings: string[] = [];
    const s = createSecretStoreOn(raw, 'memory', { onWarning: (m) => warnings.push(m) });
    await s.set('k', LONG);
    const realDelete = raw.delete;
    raw.delete = async (a) => {
      if (a.includes('#')) throw new Error('locked');
      return realDelete(a);
    };
    await s.set('k', 'short');
    expect(await s.get('k')).toBe('short');
    expect(warnings.some((w) => w.includes('옛 조각'))).toBe(true);
  });

  it('저장소 쓰기가 실패하면 그 오류를 그대로 알린다', async () => {
    const raw = inspectableBackend();
    raw.set = async () => {
      throw new SecretStoreError('backend', 'OS 보안 저장소에서 저장에 실패했습니다');
    };
    const s = createSecretStoreOn(raw, 'memory');
    await expect(s.set('k', 'v')).rejects.toMatchObject({ code: 'backend' });
  });
});

describe('OS 보안 저장소 (실제)', () => {
  // Linux의 욱채는 키링을 쓰지 않는다 — 데이터 폴더의 파일 저장소다 (리드 결정 S10-6.1, fileSecretStore.test.ts). 화면 없는 Linux에는 Secret Service가 없고, 있어도
  // 이 시험은 그 사용자의 실제 키링에 쓴다
  it.skipIf(process.platform === 'linux')('임의 키로 저장·읽기·삭제를 왕복하고 항상 지운다 (Windows·macOS — Linux는 키링을 쓰지 않는다, S10-6.1)', async (ctx) => {
    const service = `wook-test-${randomBytes(6).toString('hex')}`;
    const key = `wook-test-${randomBytes(6).toString('hex')}`;
    const store = createSecretStore({ service, onWarning: () => undefined });
    if (store.backend !== 'keyring') ctx.skip();
    const keyring = createRequire(import.meta.url)('@napi-rs/keyring') as {
      findCredentials: (service: string) => { account: string }[];
      Entry: new (s: string, a: string) => { deletePassword(): boolean };
    };
    try {
      expect(await store.get(key)).toBeNull();
      await store.set(key, '테스트 값 ✓');
      expect(await store.get(key)).toBe('테스트 값 ✓');
      // Windows 한도(UTF-16 1280자)를 넘는 값
      await store.set(key, LONG);
      expect(await store.get(key)).toBe(LONG);
      expect(keyring.findCredentials(service).length).toBeGreaterThan(1);
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
      expect(keyring.findCredentials(service)).toEqual([]);
    } finally {
      for (const c of keyring.findCredentials(service)) new keyring.Entry(service, c.account).deletePassword();
    }
  });
});
