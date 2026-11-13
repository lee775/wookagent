/**
 * 비밀 값 저장 (SEC-09): OS 보안 저장소(Windows 자격 증명 관리자, macOS 키체인) — @napi-rs/keyring.
 * 네이티브 모듈을 불러오지 못하면 메모리 저장으로 대신하고 backend='memory'·fallbackReason으로 알린다
 * (메모리 값은 프로그램을 끄면 사라진다).
 * Linux는 키링을 쓰지 않고 데이터 폴더의 파일 저장소(fileSecretStore.ts, backend='file')에 둔다 (리드 결정 S10-6.1) — 부르는 쪽(buildDeps)이 넘긴다.
 * 그 저장소의 fallbackReason은 지금의 권한 문제다(없으면 null)
 *
 * Windows 자격 증명 관리자는 값 하나에 UTF-16 1280자까지만 담는다(실측: 1281자부터 거부). 그보다 긴 값은
 * 여러 항목에 나눠 담고, 본 항목에는 세대·개수·길이·SHA-256을 적은 머리만 둔다. 읽을 때 길이와 해시를 확인한다.
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import type { SecretStore } from './types';

export class SecretStoreError extends Error {
  constructor(
    public readonly code: 'invalid_key' | 'invalid_value' | 'backend' | 'corrupt',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SecretStoreError';
  }
}

export interface SecretStoreOptions {
  /** 보안 저장소의 서비스 이름 (예: 'wookagent') */
  service: string;
  /** 테스트·개발용: 보안 저장소를 쓰지 않고 메모리에 둔다 */
  forceMemory?: boolean;
  /** 값 저장·삭제는 끝났지만 나눠 담은 옛 조각을 지우지 못했을 때 알림. 기본 console.warn */
  onWarning?: (message: string, cause: unknown) => void;
  /** 파일 저장소 (Linux — 리드 결정 S10-6.1). 있으면 키링을 불러오지 않고 이것을 쓴다(forceMemory가 먼저다) */
  file?: FileSecretBackend;
}

/** 파일 저장소 칸 (fileSecretStore.ts) — 폴더와 지금의 권한 문제 */
export interface FileSecretBackend extends RawSecretBackend {
  readonly dir: string;
  problem(): string | null;
}

export interface SecretStoreHandle extends SecretStore {
  /** 보안 저장소를 못 써서 메모리로 대신할 때 그 이유 (forceMemory면 null) */
  readonly fallbackReason: string | null;
}

/** 저장소 한 칸 단위 읽기·쓰기 (계정 이름 = 키 또는 조각 이름) */
export interface RawSecretBackend {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  /** 지웠으면 true, 원래 없었으면 false */
  delete(account: string): Promise<boolean>;
  /** 이 서비스의 모든 계정 이름. 지원하지 않으면 null */
  list: (() => Promise<string[]>) | null;
}

const MAX_KEY_LENGTH = 200;
/** 이 길이까지는 한 칸에 그대로 둔다 (Windows 한도 1280보다 여유 있게) */
const DIRECT_MAX = 1200;
const CHUNK_SIZE = 1000;
const CHUNK_HEADER = 'wook-chunked:v1:';
const CHUNK_HEADER_RE = /^wook-chunked:v1:([0-9a-f]{8}):(\d{1,6}):(\d{1,9}):([0-9a-f]{64})$/;
const CHUNK_MARK = '#';

interface ChunkHeader {
  gen: string;
  count: number;
  length: number;
  hash: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const chunkAccount = (key: string, gen: string, i: number): string => `${key}${CHUNK_MARK}${gen}${CHUNK_MARK}${i}`;

function parseHeader(key: string, raw: string): ChunkHeader | null {
  if (!raw.startsWith(CHUNK_HEADER)) return null;
  const m = CHUNK_HEADER_RE.exec(raw);
  if (!m) throw new SecretStoreError('corrupt', `비밀 값 '${key}'의 저장 형식이 손상되었습니다. 다시 등록하세요.`);
  return { gen: m[1]!, count: Number(m[2]), length: Number(m[3]), hash: m[4]! };
}

/** 서로게이트 쌍(이모지 등)을 가르지 않게 나눈다 — 짝 없는 반쪽은 저장소를 거치며 깨진다 */
function splitChunks(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      const c = s.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end--;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.trim().length === 0) throw new SecretStoreError('invalid_key', '비밀 값 이름이 비어 있습니다');
  if (key.length > MAX_KEY_LENGTH) throw new SecretStoreError('invalid_key', `비밀 값 이름이 너무 깁니다 (${MAX_KEY_LENGTH}자 이하)`);
  if (key.includes(CHUNK_MARK) || /[\p{Cc}]/u.test(key)) {
    throw new SecretStoreError('invalid_key', `비밀 값 이름에 쓸 수 없는 글자가 있습니다 ('${CHUNK_MARK}', 제어 문자): ${key}`);
  }
}

// ───────────────────────── 저장소 구현 ─────────────────────────

function memoryBackend(): RawSecretBackend {
  const map = new Map<string, string>();
  return {
    get: async (a) => map.get(a) ?? null,
    set: async (a, v) => {
      map.set(a, v);
    },
    delete: async (a) => map.delete(a),
    list: async () => [...map.keys()],
  };
}

interface AsyncEntryLike {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => AsyncEntryLike;
  findCredentialsAsync?: (service: string) => Promise<{ account: string; password: string }[]>;
}

let keyringLoad: { ok: true; mod: KeyringModule } | { ok: false; reason: string } | undefined;

/** 네이티브 모듈이 없거나 깨졌으면 불러올 때 던진다 — 정적 import로는 메인 프로세스 전체가 죽으므로 지연해서 불러온다 */
function loadKeyring(): { ok: true; mod: KeyringModule } | { ok: false; reason: string } {
  if (keyringLoad) return keyringLoad;
  try {
    const mod = createRequire(import.meta.url)('@napi-rs/keyring') as Partial<KeyringModule>;
    if (typeof mod.AsyncEntry !== 'function') throw new Error('AsyncEntry를 찾을 수 없습니다');
    keyringLoad = { ok: true, mod: mod as KeyringModule };
  } catch (err) {
    keyringLoad = { ok: false, reason: `OS 보안 저장소 모듈(@napi-rs/keyring)을 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  return keyringLoad;
}

function keyringBackend(mod: KeyringModule, service: string): RawSecretBackend {
  const call = async <T>(what: string, account: string, op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SecretStoreError('backend', `OS 보안 저장소에서 '${account}' ${what}에 실패했습니다: ${detail}`, { cause: err });
    }
  };
  const entry = (account: string): AsyncEntryLike => new mod.AsyncEntry(service, account);
  const find = mod.findCredentialsAsync;
  return {
    get: (a) => call('읽기', a, () => entry(a).getPassword()),
    set: (a, v) => call('저장', a, () => entry(a).setPassword(v)),
    delete: (a) => call('삭제', a, () => entry(a).deletePassword()),
    list: find ? () => call('목록 읽기', service, async () => (await find(service)).map((c) => c.account)) : null,
  };
}

/** @internal 저장 칸 구현을 받아 나눠 담기·키 잠금을 얹는다 (테스트에서 손상 상황을 만들 때도 쓴다) */
export function createSecretStoreOn(
  raw: RawSecretBackend,
  backend: SecretStore['backend'],
  opts: { fallbackReason?: string | null | (() => string | null); onWarning?: (message: string, cause: unknown) => void } = {},
): SecretStoreHandle {
  const reason = opts.fallbackReason;
  const warn = opts.onWarning ?? ((message: string, cause: unknown) => console.warn(`[비밀 값] ${message}`, cause));
  const locks = new Map<string, Promise<unknown>>();

  /** 같은 키의 읽기·쓰기를 한 줄로 세운다 (조각을 쓰는 중에 읽거나 두 쓰기가 섞이지 않게) */
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  };

  const deleteChunks = async (key: string, h: ChunkHeader): Promise<void> => {
    for (let i = 0; i < h.count; i++) await raw.delete(chunkAccount(key, h.gen, i));
  };

  /** 중간에 끊긴 쓰기가 남긴 조각 정리 (지금 세대 것은 남긴다) */
  const sweepOrphans = async (key: string, keepGen: string | null): Promise<void> => {
    if (!raw.list) return;
    const prefix = `${key}${CHUNK_MARK}`;
    for (const account of await raw.list()) {
      if (!account.startsWith(prefix)) continue;
      const gen = account.slice(prefix.length).split(CHUNK_MARK)[0];
      if (gen !== keepGen) await raw.delete(account);
    }
  };

  const cleanup = async (key: string, old: ChunkHeader | null, keepGen: string | null): Promise<void> => {
    try {
      if (old && old.gen !== keepGen) await deleteChunks(key, old);
      await sweepOrphans(key, keepGen);
    } catch (err) {
      warn(`'${key}'의 옛 조각을 지우지 못했습니다 (값은 정상 처리됨)`, err);
    }
  };

  const readOld = async (key: string): Promise<ChunkHeader | null> => {
    const old = await raw.get(key);
    if (old === null) return null;
    try {
      return parseHeader(key, old);
    } catch (err) {
      // 머리가 손상된 옛 값은 덮어쓰거나 지우는 중이므로 조각은 정리 단계(sweepOrphans)가 치운다
      if (err instanceof SecretStoreError && err.code === 'corrupt') return null;
      throw err;
    }
  };

  return {
    backend,
    // 파일 저장소는 읽을 때마다 지금의 권한 문제를 말한다 (관리 status가 보인다)
    get fallbackReason(): string | null {
      if (typeof reason !== 'function') return reason ?? null;
      try {
        return reason();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },

    async get(key: string): Promise<string | null> {
      validateKey(key);
      return withLock(key, async () => {
        const v = await raw.get(key);
        if (v === null) return null;
        const h = parseHeader(key, v);
        if (!h) return v;
        const parts: string[] = [];
        for (let i = 0; i < h.count; i++) {
          const part = await raw.get(chunkAccount(key, h.gen, i));
          if (part === null) throw new SecretStoreError('corrupt', `비밀 값 '${key}'의 일부(${i + 1}/${h.count})가 없어 읽을 수 없습니다. 다시 등록하세요.`);
          parts.push(part);
        }
        const value = parts.join('');
        if (value.length !== h.length || sha256(value) !== h.hash) {
          throw new SecretStoreError('corrupt', `비밀 값 '${key}'이 손상되었습니다 (길이·해시 불일치). 다시 등록하세요.`);
        }
        return value;
      });
    },

    async set(key: string, value: string): Promise<void> {
      validateKey(key);
      if (typeof value !== 'string') throw new SecretStoreError('invalid_value', '비밀 값은 문자열이어야 합니다');
      return withLock(key, async () => {
        const old = await readOld(key);
        let gen: string | null = null;
        // 머리 표시로 시작하는 값은 늘 나눠 담아 원래 값과 머리를 헷갈리지 않게 한다
        if (value.length <= DIRECT_MAX && !value.startsWith(CHUNK_HEADER)) {
          await raw.set(key, value);
        } else {
          gen = randomBytes(4).toString('hex');
          const chunks = splitChunks(value, CHUNK_SIZE);
          for (let i = 0; i < chunks.length; i++) await raw.set(chunkAccount(key, gen, i), chunks[i]!);
          // 조각을 다 쓴 뒤에 머리를 바꿔야 중간에 끊겨도 옛 값이 온전하다
          await raw.set(key, `${CHUNK_HEADER}${gen}:${chunks.length}:${value.length}:${sha256(value)}`);
        }
        await cleanup(key, old, gen);
      });
    },

    async delete(key: string): Promise<void> {
      validateKey(key);
      return withLock(key, async () => {
        const old = await readOld(key);
        await raw.delete(key);
        await cleanup(key, old, null);
      });
    },
  };
}

/** OS 보안 저장소 (불가하면 메모리). 파일 저장소를 넘기면(Linux) 그것 */
export function createSecretStore(opts: SecretStoreOptions): SecretStoreHandle {
  const service = typeof opts.service === 'string' ? opts.service.trim() : '';
  if (service.length === 0) throw new SecretStoreError('invalid_key', '비밀 값 저장소의 서비스 이름이 비어 있습니다');
  if (opts.forceMemory) return createSecretStoreOn(memoryBackend(), 'memory', { fallbackReason: null, onWarning: opts.onWarning });
  // Linux (리드 결정 S10-6.1): 키링을 불러오지 않는다 — Secret Service가 없을 때 keyutils(다시 시작하면 사라짐)로 말없이 떨어지지 않게
  const file = opts.file;
  if (file) return createSecretStoreOn(file, 'file', { fallbackReason: () => file.problem(), onWarning: opts.onWarning });
  const loaded = loadKeyring();
  if (!loaded.ok) {
    (opts.onWarning ?? ((m: string) => console.warn(`[비밀 값] ${m}`)))(`${loaded.reason} — 메모리 저장으로 대신합니다(재시작하면 사라짐)`, null);
    return createSecretStoreOn(memoryBackend(), 'memory', { fallbackReason: loaded.reason, onWarning: opts.onWarning });
  }
  return createSecretStoreOn(keyringBackend(loaded.mod, service), 'keyring', { fallbackReason: null, onWarning: opts.onWarning });
}
