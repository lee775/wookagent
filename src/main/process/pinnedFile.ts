/**
 * 띄울 때마다 보는 실행 파일 해시 (SERVER_DESIGN 8.4 '잡 러너와 도우미 실행 파일', 리드 결정 S5-21·S6-5).
 *
 * 작업 개체 러너(WookJobRunner.exe)와 화면 도우미(WookDesktopHelper.exe)는 에이전트가 쓸 수 있는 앱 데이터 폴더(<dataDir>/bin)에 있다.
 * 준비할 때(컴파일 또는 재사용 확인 뒤) 실행 파일 바이트의 SHA-256을 적어 두고(pinFile), 띄우기 바로 전에 다시 읽어 견준다(checkPinned).
 * 다르면 그 실행을 거부한다 — 호출자가 실행 환경 문제로 알린다.
 *
 * - 동기 함수다: 띄우는 코드와 같은 동기 구간 안에서 부른다(await 없이 — 리드 결정 S5-18). 23KB 러너 한 번 읽고 해시하는 데 약 43µs.
 * - 같은 사용자가 확인과 실행 사이에 파일을 바꾸는 것(TOCTOU)은 막지 못한다: Node는 쓰기 거부 공유 잠금을 쥘 수 없고(fs.constants에
 *   UV_FS_O_EXLOCK이 없다), 공유 없음 잠금은 CreateProcess도 막는다. .sha256 파일도 같은 사용자가 바꿀 수 있다 — 경계가 아니라 실수·
 *   단순한 바꿔치기를 잡는 장치다 (KNOWN_ISSUES).
 *
 * compiledTool.ts(빌드 스크립트가 Node 형식 제거로 불러온다)는 이 파일을 형식(FilePin)으로만 쓰고 해시는 스스로 계산한다. 이 파일도 같은 규칙을
 * 지킨다: 런타임 import는 node: 모듈만, 지울 수 있는 TS 문법만.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface FilePin {
  /** 띄울 실행 파일의 절대 경로 */
  readonly path: string;
  /** 준비할 때 적어 둔 바이트의 SHA-256 (소문자 16진수 64자) */
  readonly sha256: string;
}

export type PinCheck = { ok: true } | { ok: false; reason: string; actual: string | null };

/** 파일 바이트의 SHA-256. 읽지 못하면 던진다 */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 지금 그 파일의 해시를 적어 둔다 (읽지 못하면 던진다) */
export function pinFile(path: string): FilePin {
  return { path, sha256: sha256File(path) };
}

/**
 * 띄우기 바로 전에: 파일을 다시 읽어 적어 둔 해시와 견준다. 같으면 ok. 다르거나 읽지 못하면 그 까닭(한국어)과 지금 해시(못 읽었으면 null).
 * 던지지 않는다
 */
export function checkPinned(pin: FilePin): PinCheck {
  let actual: string;
  try {
    actual = sha256File(pin.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { ok: false, reason: `실행 파일을 읽지 못했습니다 (${code ?? (err instanceof Error ? err.message : String(err))})`, actual: null };
  }
  if (actual === pin.sha256) return { ok: true };
  return { ok: false, reason: `실행 파일의 해시가 준비할 때와 다릅니다 (${pin.sha256.slice(0, 12)}… → ${actual.slice(0, 12)}…)`, actual };
}
