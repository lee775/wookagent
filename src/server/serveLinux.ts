/**
 * Linux에서 서버를 띄우기 전의 확인 (리드 결정 S10-6.4) — serve.ts가 무엇도 만들기 전에 부른다. 순수 함수(넣은 값만 본다)라 어느 OS에서나 시험한다.
 * - root(uid 0)는 띄우지 않는다: 메인 턴은 Claude Code의 권한 확인 건너뛰기로 도는데 Claude Code는 root에서 그것을 거부하고, root의 서버는 그 PC 전체를 쥔다
 * - 관리 소켓 `<데이터 폴더>/admin.sock`의 경로가 107바이트를 넘으면 시작하지 않는다 — 넘는 경로는 Node가 EINVAL로만 끝난다. 그 전에 까닭을 말한다
 * - /proc을 읽을 수 있어야 한다 (프로세스 갈래 S10a의 linuxProcProblem — 실행 잠금·정지 확인이 /proc으로 본다, S10-5.3). 잠금 전에 본다
 * - 비밀 값 폴더(<데이터 폴더>/secrets)의 주인·권한이 틀리면 시작하지 않는다 (S10-6.1 '크게 실패한다')
 * - 출력이 systemd 저널로 가면(JOURNAL_STREAM이 표준 출력·오류와 같은 파일) 설정 코드를 표준 출력에 내지 않는다 — 그 출력은 사용자 저널에 남아 adm·systemd-journal 그룹이 읽는다.
 *   파일(setup-code.txt, 그 사용자만)만 가리킨다
 */
import { fstatSync } from 'node:fs';
import { join } from 'node:path';
import { linuxProcProblem } from '../main/process/procfs';
import { ADMIN_SOCKET_FILE } from './admin';

/**
 * 관리 소켓 경로의 이 제품의 한도 — 107바이트. Linux의 sun_path는 108바이트이고 Node 24는 끝의 NUL 없이 108바이트까지 연다(109바이트부터 EINVAL — WSL에서 잼).
 * 한 바이트를 남겨 두는 이 제품의 한도다 (리드 결정 S10-13 SH-7)
 */
export const SOCKET_PATH_MAX_BYTES = 107;

export const ROOT_REFUSAL =
  'root(uid 0)로는 서버를 띄우지 않습니다 — 로그인한 사용자 계정으로 띄우세요 (메인 에이전트의 Claude Code는 root에서 권한 확인 건너뛰기를 거부하고, root의 서버는 이 PC 전체를 쥡니다)';

/** 관리 소켓 경로가 길면 그 글 (아니면 null) — 바이트로 센다(한글 한 글자는 3바이트) */
export function adminSocketPathProblem(dataDir: string): string | null {
  const path = join(dataDir, ADMIN_SOCKET_FILE);
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes <= SOCKET_PATH_MAX_BYTES) return null;
  const room = SOCKET_PATH_MAX_BYTES - Buffer.byteLength(`/${ADMIN_SOCKET_FILE}`, 'utf8');
  return `데이터 폴더의 경로가 길어 관리 소켓(${path})을 만들 수 없습니다 — ${bytes}바이트로 Linux의 한도 ${SOCKET_PATH_MAX_BYTES}바이트를 넘습니다. ${room}바이트 이하(UTF-8 — 한글 한 글자는 3바이트)의 데이터 폴더를 --data-dir로 주세요`;
}

/**
 * 표준 출력이나 오류가 systemd 저널로 가는지 — systemd가 문서로 정한 대로 JOURNAL_STREAM(`<장치>:<inode>`)을 표준 출력(1)·오류(2)의 fstat과 견준다
 * (리드 결정 S10-13): 변수가 있는 것만으로는 아니다 — 데스크톱 터미널로 새어 든 JOURNAL_STREAM이 설정 코드를 숨기지 않게. 견줄 수 없으면 아니다
 */
export function underSystemd(env: NodeJS.ProcessEnv, fstat: (fd: number) => { dev: bigint; ino: bigint } = (fd) => fstatSync(fd, { bigint: true })): boolean {
  const m = /^(\d+):(\d+)$/.exec(env['JOURNAL_STREAM'] ?? '');
  if (!m) return false;
  const dev = BigInt(m[1]!);
  const ino = BigInt(m[2]!);
  for (const fd of [1, 2]) {
    try {
      const st = fstat(fd);
      if (st.dev === dev && st.ino === ino) return true;
    } catch {
      // 그 출력이 닫혔다 — 저널이 아니다
    }
  }
  return false;
}

/**
 * /proc 확인 — 프로세스 갈래(S10a)의 linuxProcProblem()(src/main/process/procfs.ts, S10-5.3)을 부르는 자리 하나. serve(잠금 전)와 check가 이것을 부른다.
 * 시험은 /proc 뿌리를 넣는다(가짜 /proc 폴더)
 */
export function procProblem(root?: string): string | null {
  return root === undefined ? linuxProcProblem() : linuxProcProblem(root);
}

export interface LinuxStartInput {
  platform: NodeJS.Platform;
  /** process.getuid() (없으면 null) */
  uid: number | null;
  dataDir: string;
}

/** 무엇도 만들기 전의 확인 (root·소켓 경로) — 처음 걸린 것의 글, 없으면 null. Linux가 아니면 늘 null */
export function linuxPreStartProblem(i: LinuxStartInput): string | null {
  if (i.platform !== 'linux') return null;
  if (i.uid === 0) return ROOT_REFUSAL;
  return adminSocketPathProblem(i.dataDir);
}

/** 설정 코드를 콘솔에 낼 때의 글 — systemd 아래에서는 코드 없이 파일만 가리킨다 (S10-6.4) */
export function setupCodeConsoleText(o: { code: string; until: string; file: string; fileWritten: boolean; systemd: boolean }): string {
  const tail = '웹 화면의 서버 설정에 대표 이메일과 함께 넣거나, 운영자가 wook-server config owner-email <이메일>로 정하세요.';
  if (!o.systemd) {
    return `대표 이메일이 아직 정해지지 않았습니다. 설정 코드 ${o.code} (${o.until}까지, 한 번만 — ${o.file}에도 적었습니다)를 ${tail}\n`;
  }
  if (o.fileWritten) {
    return `대표 이메일이 아직 정해지지 않았습니다. 설정 코드는 ${o.file}에 적었습니다 (${o.until}까지, 한 번만 — systemd 아래라 저널에 남지 않게 여기에는 내지 않습니다). 그 코드를 ${tail}\n`;
  }
  return `대표 이메일이 아직 정해지지 않았습니다. 설정 코드 파일(${o.file})을 쓰지 못했고, systemd 아래라 코드를 저널에 내지 않습니다 — 운영자가 wook-server config owner-email <이메일>로 정하세요.\n`;
}
