/**
 * 화면 캡처 보관 (SERVER_DESIGN 8.3.5 '캡처 보관', 리드 결정 S6-7). 화면 그림은 가릴 수 없다 — 그래서 바이트는 이 폴더에만, 짧게 둔다.
 *
 * - 폴더: `<메인 작업 폴더>/screens/` (메인 CLI의 cwd 안 — Claude Read·Codex view_image가 연다). 만들 때 `<메인 작업 폴더>/.git/info/exclude`에
 *   `screens/`를 더한다 — 메인이 git add -A를 해도 캡처가 git 기록에 들어가지 않게.
 * - 이름: TS가 정한 ID(`SC-000001.png`, IdKind 'capture'). 도우미가 `.tmp`에 쓰고 이름을 바꾼 뒤 TS가 파일을 다시 해시한다. 시험 이미지는 `check-<8hex>.png`.
 * - 정리(sweep): 이 폴더만, 하위 폴더 없이, 이름이 맞는 파일만 — 24시간(파일 mtime) 지난 캡처·시험 이미지, 그다음 최근 500장보다 오래된 캡처(작은 ID부터),
 *   1시간 지난 `.tmp`. 쓸 때마다·시작 때·한 시간마다 돈다. 지우는 것은 unlinkSync 하나씩 (fs.rmSync는 Node 24.13·Windows에서 한글 경로면 프로세스가 죽는다 — S6a).
 * - 백업·내보내기는 허용 목록이라(DB·보고서·기억, 활동 기록) 이 폴더는 들어가지 않는다. 기록(gui_actions)에는 ID와 해시만 남는다.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { pngChunks } from './testImage';

/** 캡처를 두는 시간 (파일 mtime으로 센다) */
export const SCREEN_KEEP_MS = 24 * 3600_000;
/** 남기는 캡처 수 (최근 것) */
export const SCREEN_KEEP_COUNT = 500;
/** 쓰다 남은 .tmp를 지우는 나이 */
export const SCREEN_TMP_KEEP_MS = 3600_000;

export const CAPTURE_ID_RE = /^SC-\d{6,12}$/;
const CAPTURE_FILE_RE = /^(SC-\d{6,12})\.png$/;
const CHECK_FILE_RE = /^check-[0-9a-f]{8}\.png$/;
const TMP_FILE_RE = /^(?:SC-\d{6,12}|check-[0-9a-f]{8})\.png\.tmp$/;

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export class ScreenStore {
  constructor(
    /** 메인 작업 폴더 (시작 때 정한 뒤 바뀌지 않는다 — 부를 때마다 묻는다) */
    private readonly mainWorkDir: () => string,
    private readonly now: () => number,
    private readonly log: Log,
  ) {}

  dir(): string {
    return join(this.mainWorkDir(), 'screens');
  }

  /** 폴더를 만들고(있으면 그대로) git 제외 줄을 넣는다. 만든 폴더 */
  ensure(): string {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    this.excludeFromGit();
    return dir;
  }

  /** `<메인 작업 폴더>/.git/info/exclude`에 `screens/` (git 저장소일 때만, 한 번) */
  private excludeFromGit(): void {
    const git = join(this.mainWorkDir(), '.git');
    try {
      if (!existsSync(git) || !statSync(git).isDirectory()) return;
      const file = join(git, 'info', 'exclude');
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (text.split(/\r?\n/).some((l) => l.trim() === 'screens/' || l.trim() === '/screens/')) return;
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# 욱채: 화면 캡처는 24시간만 두고 git에 넣지 않는다\n/screens/\n`);
    } catch (e) {
      this.log('warn', '메인 작업 폴더의 git 제외 목록에 screens/를 넣지 못했습니다', e);
    }
  }

  /** 캡처 파일의 절대 경로 (ID가 틀리면 던진다) */
  capturePath(id: string): string {
    if (!CAPTURE_ID_RE.test(id)) throw new Error('캡처 ID가 올바르지 않습니다');
    return join(this.dir(), `${id}.png`);
  }

  /** 파일 바이트 (없으면 null) */
  read(id: string): Buffer | null {
    try {
      return readFileSync(this.capturePath(id));
    } catch {
      return null;
    }
  }

  /** 보관 중이고 해시가 맞으면 그 바이트, 아니면 null (화면 보기·screens.image) */
  readKept(id: string, sha256: string): Buffer | null {
    const buf = this.read(id);
    if (!buf) return null;
    return sha256Of(buf) === sha256 ? buf : null;
  }

  /** 보관 중이고 해시가 맞는지 */
  kept(id: string, sha256: string): boolean {
    return this.readKept(id, sha256) !== null;
  }

  /**
   * 목록(screens.recent)의 '보관 중' 표시 — 같은 파일(크기·mtime이 그대로)은 다시 읽어 해시하지 않는다. 화면이 5초마다 최근 100장을 묻기 때문이다. 바이트를 주는 길
   * (screens.image·/api/screens/:id)은 이 값을 쓰지 않고 늘 readKept로 다시 해시한다 — 크기·mtime을 맞춰 바꿔치기한 파일은 목록에만 보관 중으로 남고 열리지 않는다
   */
  keptQuick(id: string, sha256: string): boolean {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(this.capturePath(id));
      if (!st.isFile()) throw new Error('파일이 아니다');
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      this.keptSeen.delete(id);
      return false;
    }
    const seen = this.keptSeen.get(id);
    if (seen && seen.size === size && seen.mtimeMs === mtimeMs && seen.sha256 === sha256) return seen.ok;
    const ok = this.kept(id, sha256);
    if (this.keptSeen.size >= SCREEN_KEEP_COUNT * 2) this.keptSeen.clear();
    this.keptSeen.set(id, { size, mtimeMs, sha256, ok });
    return ok;
  }

  private readonly keptSeen = new Map<string, { size: number; mtimeMs: number; sha256: string; ok: boolean }>();

  remove(id: string): void {
    try {
      unlinkSync(this.capturePath(id));
    } catch {
      // 없다
    }
  }

  /** 시험 이미지를 쓴다 (.tmp 뒤 이름 바꾸기) — 그 절대 경로 */
  writeCheck(name: string, png: Buffer): string {
    if (!CHECK_FILE_RE.test(name)) throw new Error('시험 이미지 이름이 올바르지 않습니다');
    const dir = this.ensure();
    const file = join(dir, name);
    writeFileSync(`${file}.tmp`, png);
    renameSync(`${file}.tmp`, file);
    return file;
  }

  removeCheck(file: string): void {
    try {
      if (CHECK_FILE_RE.test(file.split(/[\\/]/).pop() ?? '')) unlinkSync(file);
    } catch {
      // 없다
    }
  }

  /**
   * 정리 — 지운 수. 이 폴더의 이름이 맞는 파일만 본다(하위 폴더 없이). 24시간(mtime) 지난 캡처·시험 이미지 → 최근 500장만 남기고 오래된 캡처(작은 ID) →
   * 1시간 지난 .tmp
   */
  sweep(): number {
    const dir = this.dir();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    const now = this.now();
    let removed = 0;
    const gone = (name: string): void => {
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {
        // 이미 없거나 잠김 — 다음 정리에 맡긴다
      }
    };
    const mtime = (name: string): number | null => {
      try {
        const st = statSync(join(dir, name));
        return st.isFile() ? st.mtimeMs : null;
      } catch {
        return null;
      }
    };
    const captures: { name: string; n: number }[] = [];
    for (const name of names) {
      const cap = CAPTURE_FILE_RE.exec(name);
      if (cap || CHECK_FILE_RE.test(name)) {
        const m = mtime(name);
        if (m === null) continue;
        if (m < now - SCREEN_KEEP_MS) {
          gone(name);
          continue;
        }
        if (cap) captures.push({ name, n: Number(cap[1]!.slice(3)) });
        continue;
      }
      if (TMP_FILE_RE.test(name)) {
        const m = mtime(name);
        if (m !== null && m < now - SCREEN_TMP_KEEP_MS) gone(name);
      }
    }
    if (captures.length > SCREEN_KEEP_COUNT) {
      captures.sort((a, b) => a.n - b.n);
      for (const c of captures.slice(0, captures.length - SCREEN_KEEP_COUNT)) gone(c.name);
    }
    if (removed) this.log('info', `화면 캡처 ${removed}개를 정리했습니다 (24시간·최근 ${SCREEN_KEEP_COUNT}장)`);
    return removed;
  }
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 모두 검은 화면인지 (잠긴 화면·꺼진 모니터 — 거부하지 않고 결과에 알린다). 8비트 회색·RGB(24bpp)이고 겹침(interlace)이 없는 PNG만 본다 — 나머지는 false.
 * 거르기 바이트를 뺀 IDAT가 모두 0이면 검다 (어떤 거르기든 0에서 시작한 예측은 0이다)
 */
export function isAllBlackPng(png: Buffer): boolean {
  const chunks = pngChunks(png);
  const ihdr = chunks?.find((c) => c.type === 'IHDR')?.data;
  if (!chunks || !ihdr || ihdr.length < 13) return false;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!;
  const type = ihdr[9]!;
  if (depth !== 8 || (type !== 0 && type !== 2) || ihdr[12] !== 0) return false;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  } catch {
    return false;
  }
  const row = w * (type === 2 ? 3 : 1) + 1;
  if (raw.length < row * h) return false;
  for (let y = 0; y < h; y++) {
    const base = y * row + 1;
    for (let i = 0; i < row - 1; i++) if (raw[base + i] !== 0) return false;
  }
  return true;
}
