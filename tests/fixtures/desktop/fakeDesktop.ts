/**
 * 가짜 화면 도우미를 쓰는 시험 도구 (리드 결정 S6-5·S6-13 — 모든 시험의 기본, 실제 도우미는 띄우지 않는다).
 *
 * createFakeDesktop(시나리오)는 이 실행의 임시 폴더 아래에 폴더 하나(화면 폴더·기록·제어 파일)를 만들고, 그 시나리오로 가짜 도우미
 * (./fakeDesktopHelper.mjs, Node)를 띄우는 launcher를 준다. 시나리오는 다음 띄우기부터 set()으로 바꾸고, 떠 있는 가짜에게는 act()로
 * 사람 입력·단축키·잠김 같은 일을 일으킨다. 가짜가 받은 줄은 received()·typed()(TYPE 글자를 풀어서)로 본다.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopHelper, type DesktopHelperOptions } from '../../../src/main/desktop/desktopHelper';
import type {
  DesktopHelperClient,
  DesktopHelperLauncher,
  HelperFocus,
  HelperVerb,
  HelperWindow,
  LockKind,
} from '../../../src/main/desktop/types';

export const FAKE_DESKTOP_HELPER = fileURLToPath(new URL('./fakeDesktopHelper.mjs', import.meta.url));

export interface FakeScreen {
  x: number;
  y: number;
  width: number;
  height: number;
  dpi?: number;
  primary?: boolean;
}

/** 가짜 도우미 시나리오 (모두 고를 수 있다) */
export interface FakeDesktopScenario {
  /** 시작: 준비됨 · FAIL NO_DESKTOP · FAIL INIT · 다른 버전 READY · READY 없음 · 준비 전 끝남(9) · 안내 줄 뒤 READY · 조용히 끝남(0) */
  start: 'ready' | 'no_desktop' | 'init_fail' | 'bad_version' | 'hang' | 'crash' | 'noise' | 'exit_quiet';
  readyDelayMs: number;
  /** 시작할 때 오류 출력에 쓸 한 줄 */
  startStderr: string;
  build: number;
  wda: boolean;
  screens: FakeScreen[];
  /** z 순서 (앞이 위). 마우스 명령은 그 점을 품은 첫 창으로 막는 창·높은 권한을 본다 */
  windows: HelperWindow[];
  /**
   * null = 포커스 없음. password null = 모름 (글자 입력은 FOCUS_UNKNOWN). shell: true면 Alt+F4를 막는다. root: 그 포커스가 든 최상위 창(실제 도우미의 창 핸들
   * 흉내 — 가짜의 답에는 싣지 않는다). 없으면 pid와 제목이 창이다 — TYPE 중에 창이 바뀌면 멈춘다 (리드 결정 S6-25 P2)
   */
  focus: (HelperFocus & { shell?: boolean; root?: string }) | null;
  /** CLICK 뒤의 포커스 (앱을 바꾸는 클릭 흉내) */
  clickFocus: (HelperFocus & { shell?: boolean; root?: string }) | null;
  lock: LockKind | null;
  /** ARM의 seed (epoch ms). 없으면 시작 60초 전 */
  seedMs: number;
  /** 멈춤 단축키를 걸었는지 — false면 ARM이 hotkey=0으로 답한다 (다른 프로그램이 그 단축키를 쓰고 있다). 떠 있는 가짜에게 set으로 바꿀 수 있다 */
  hotkey: boolean;
  /** CAPTURE가 쓴 파일과 다른 sha256을 답한다 (서버가 파일을 다시 해시해 거부하는지 본다) */
  wrongSha256: boolean;
  png:{ mode: 'grey' | 'black' | 'noise' | 'fixed'; base64?: string; padAboveEdge?: { edge: number; bytes: number } };
  /** 그 명령은 늘 이 ERR로 답한다 (예: { TYPE: 'PASSWORD_FIELD', CLICK: 'LOCKED locked' }) */
  errors: Partial<Record<HelperVerb, string>>;
  /** 한 번씩 쓰는 ERR (앞에서부터) */
  errorQueue: { verb: HelperVerb; err: string }[];
  /** 답하지 않는 명령 */
  hang: HelperVerb[];
  /** 이만큼 늦게 답하는 명령 */
  delayMs: Partial<Record<HelperVerb, number>>;
  /** 답하지 않는 STOP·RELEASE */
  noAck: ('STOP' | 'RELEASE')[];
  stopAckDelayMs: number;
  /** STOP OK 뒤 스스로 끝난다 (기본은 끝내 줄 때까지 기다린다) */
  exitOnStop: boolean;
  /** 이 명령을 받으면 바로 끝난다 (종료 코드 1) */
  crashOn: HelperVerb | 'RELEASE';
  /** READY 뒤 이만큼 지나 끝난다 (종료 코드 7) */
  exitAfterReadyMs: number;
  /** TYPE 묶음(글자 4개 — 실제 도우미와 같다, 리드 결정 S6-23 K2) 사이마다 쉬는 시간 (멈춤·사람 입력·포커스 바뀜 시험) */
  typeChunkMs: number;
  /**
   * S6F2b: TYPE이 글자 chars개 이상을 보내면 포커스를 focus로 옮긴다 — 칸을 다 채우면 다음 칸으로 넘어가는 양식 흉내 (리드 결정 S6-23 K2). 가짜는 다음 묶음을
   * 보내기 전에 포커스를 다시 보고, 암호 칸·모르는 포커스면 FOCUS_UNKNOWN sent=n으로 멈춘다. 한 번만 옮긴다
   */
  typeFocusAfter: { chars: number; focus: (HelperFocus & { shell?: boolean; root?: string }) | null } | null;
  /** DRAG 12단계마다 쉬는 시간 */
  dragStepMs: number;
  /** ARM 뒤 이 시각들에 HUMAN */
  humanAfterArmMs: number[];
  /** ARM 뒤 이 시각에 HOTKEY */
  hotkeyAfterArmMs: number;
  /** READY 뒤 이 길이의 줄 하나 (줄 상한 시험) */
  longLineAfterReady: number;
  /** 표준 입력이 닫혀도 끝나지 않는다 */
  ignoreEof: boolean;
  /** 다음 놓기·정지가 뗐다고 셀 키 수 */
  heldKeys: number;
  /** S6F1a: 놓기·정지가 키를 실제로 뗐으면 그 뒤 ARM의 seed가 그 뗀 때다 (실제 도우미의 GetLastInputInfo는 주입한 키 올림도 센다 — 리드 결정 S6-21 F3) */
  seedFromRelease: boolean;
}

export type FakeAction =
  | { do: 'human' }
  | { do: 'hotkey' }
  | { do: 'crash' }
  | { do: 'line'; value: string }
  | { do: 'set'; value: Partial<Pick<FakeDesktopScenario, 'lock' | 'focus' | 'screens' | 'windows' | 'errors' | 'hang' | 'delayMs' | 'noAck' | 'heldKeys' | 'hotkey' | 'wrongSha256' | 'typeFocusAfter'>> };

export interface FakeLogEntry {
  t: number;
  pid: number;
  dir: 'in' | 'out' | 'note';
  line: string;
}

export interface FakeDesktop {
  /** 이 가짜의 폴더 (이 실행의 임시 폴더 아래) */
  readonly dir: string;
  /** 캡처 폴더 (WOOK_DESKTOP_SCREENS) */
  readonly screensDir: string;
  readonly logPath: string;
  readonly controlPath: string;
  readonly launcher: DesktopHelperLauncher;
  /** 다음 띄우기의 시나리오 */
  scenario(): Partial<FakeDesktopScenario>;
  set(patch: Partial<FakeDesktopScenario>): void;
  /** launcher가 띄우기를 거부하게 한다 (해시가 다름 흉내). null이면 다시 띄운다 */
  refuse(text: string | null): void;
  /**
   * 떠 있는 가짜에게 (40ms 안에). set은 그 뒤에 띄운 가짜에도 시작할 때 든다 — 사건(human·hotkey·crash·line)은 그때 떠 있던 가짜만 한다 (S6F2a, 리드 결정
   * S6-23 M5 — 앞 도우미에게 일으킨 crash를 새 도우미가 되풀이하지 않는다)
   */
  act(action: FakeAction): void;
  log(): FakeLogEntry[];
  /** 가짜가 받은 줄 (모든 띄우기) */
  received(): string[];
  /** 받은 TYPE의 글자 (base64를 풀어서) */
  typed(): string[];
  /** 가짜를 띄운 수 (launch가 명세를 준 수) */
  launches(): number;
  /** 시작한 가짜 프로세스의 PID (시작 순서) */
  pids(): number[];
  /** 이 가짜를 쓰는 클라이언트 (화면 폴더·로그는 이 가짜의 것) */
  client(o?: Partial<DesktopHelperOptions>): DesktopHelperClient;
  /** 폴더를 지운다 (fs.rmSync는 Node 24.13·Windows에서 한글 경로면 프로세스가 죽어 비동기 rm을 쓴다) */
  cleanup(): Promise<void>;
}

export function createFakeDesktop(initial: Partial<FakeDesktopScenario> = {}, o: { root?: string } = {}): FakeDesktop {
  const dir = mkdtempSync(join(o.root ?? tmpdir(), 'wook-fakedesk-'));
  const screensDir = join(dir, 'screens');
  mkdirSync(screensDir, { recursive: true });
  const logPath = join(dir, 'fake.jsonl');
  const controlPath = join(dir, 'control.json');
  writeFileSync(logPath, '');
  let scenario: Partial<FakeDesktopScenario> = { ...initial };
  let refusal: string | null = null;
  let launches = 0;
  let acted = 0;
  const actions: (FakeAction & { n: number })[] = [];

  const launcher: DesktopHelperLauncher = {
    launch: () => {
      if (refusal) return { refuse: refusal };
      launches++;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      env.WOOK_FAKE_DESKTOP = JSON.stringify({ ...scenario, logPath, controlPath });
      return { file: process.execPath, args: [FAKE_DESKTOP_HELPER], env };
    },
  };

  const log = (): FakeLogEntry[] => {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FakeLogEntry);
  };

  const pids = (): number[] => [...new Set(log().filter((e) => e.dir === 'note' && e.line.startsWith('start')).map((e) => e.pid))];
  const entry = { dir, pids };
  liveFakes.add(entry);

  return {
    dir,
    screensDir,
    logPath,
    controlPath,
    launcher,
    scenario: () => scenario,
    set: (patch) => {
      scenario = { ...scenario, ...patch };
    },
    refuse: (text) => {
      refusal = text;
    },
    act: (action) => {
      actions.push({ ...action, n: ++acted });
      writeFileSync(controlPath, JSON.stringify({ actions }));
    },
    log,
    received: () => log().filter((e) => e.dir === 'in').map((e) => e.line),
    typed: () =>
      log()
        .filter((e) => e.dir === 'in' && / TYPE /.test(e.line))
        .map((e) => Buffer.from(e.line.split(' ')[2] ?? '', 'base64').toString('utf8')),
    launches: () => launches,
    pids,
    client: (extra = {}) =>
      createDesktopHelper({
        launcher,
        log: () => undefined,
        screensDir: () => screensDir,
        ...extra,
      }),
    // 폴더가 지워지면 떠 있던 가짜도 스스로 끝난다 (fakeDesktopHelper.mjs '그만 파일')
    cleanup: () => {
      liveFakes.delete(entry);
      return rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/**
 * 남은 가짜 프로세스를 끝낸다 (끝나지 않는 도우미 흉내 뒤 · 도우미가 저절로 끝난 것처럼). PID로 죽이지 않는다 — 끝난 프로세스의 PID 번호는 곧 다른
 * 프로세스(다른 시험의 자식·대표의 프로그램)에 다시 쓰여, 기록해 둔 번호로 죽이면 이 시험이 띄우지 않은 프로세스를 죽인다 (리드 결정 S7-20 TI-8). 그 PID를
 * 시작 줄에 남긴 가짜의 폴더에 quit-<PID> 파일을 두면 그 가짜가 40ms 안에 스스로 끝난다(fakeDesktopHelper.mjs '그만 파일'). 이미 정리한(cleanup) 가짜는
 * 폴더가 지워져 스스로 끝났거나 끝난다 — 어느 가짜의 것도 아닌 PID는 건드리지 않는다
 */
export function killFakePids(pids: number[]): void {
  const wanted = new Set(pids);
  for (const fake of liveFakes) {
    for (const pid of fake.pids()) {
      if (!wanted.has(pid)) continue;
      try {
        writeFileSync(join(fake.dir, `quit-${pid}`), '');
      } catch {
        // 폴더가 지워지는 중이다 — 그 가짜는 폴더가 없어져 스스로 끝난다
      }
    }
  }
}

/** 정리(cleanup) 전의 가짜들 — killFakePids가 PID를 그 가짜의 폴더로 찾는다 */
const liveFakes = new Set<{ dir: string; pids: () => number[] }>();

/** 그 PID가 살아 있는지 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 기록에 사건 줄을 하나 더한다 (시험이 순서를 표시할 때) */
export function markLog(fake: Pick<FakeDesktop, 'logPath'>, text: string): void {
  appendFileSync(fake.logPath, `${JSON.stringify({ t: Date.now(), pid: process.pid, dir: 'note', line: `test ${text}` })}\n`);
}
