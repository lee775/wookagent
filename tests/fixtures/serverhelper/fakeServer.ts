/**
 * 가짜 서버 도우미를 띄우는 이음매 (리드 결정 S9-11) — 제품의 ServerHelperLauncher와 같은 모양. 실제 WookServerHelper.exe 대신 Node로 도는
 * fakeServerHelper.mjs를 띄운다. 로그 파일(바이트 없이 start·cmd·exit 줄)로 몇 번 띄웠는지, 무엇을 받았는지 본다.
 * 느린 PC 흉내: WOOK_TEST_FAKE_SH_DELAY_MS(또는 delayMs)가 있으면 가짜의 표준 출력 줄마다 늦추고, WOOK_TEST_FAKE_SH_IN_DELAY_MS가 있으면 받은 줄과 입력의 끝을
 * 늦게 처리한다 (리드 결정 S9-18·S9-22 TI-2 — 지연을 넣어 한 번 돌려 본다)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverHelperEnv, type ServerHelperLauncher } from '../../../src/server/serverHelper';

export const FAKE_SERVER_HELPER = fileURLToPath(new URL('./fakeServerHelper.mjs', import.meta.url));

export interface FakeServerLauncher extends ServerHelperLauncher {
  readonly logFile: string;
  /** 로그 줄 */
  log(): string[];
  /** 그 mode로 띄운 수 */
  launches(mode: 'pipe' | 'power'): number;
  /** 띄운 가짜의 pid (로그의 start 줄 — 확인용, 끝내는 데 쓰지 않는다) */
  pids(mode: 'pipe' | 'power'): number[];
  /** prepare()가 불린 수 — 띄우려 했는지를 동기로 본다 (가짜가 뜨기를 기다리지 않고) */
  prepareCalls(): number;
}

export interface FakeServerLauncherOptions {
  /** 로그를 둘 폴더 (시험의 임시 폴더) */
  dir: string;
  /** 쉼표로 띄우기마다의 시나리오 (fakeServerHelper.mjs 머리말) */
  scenario?: string;
  delayMs?: number;
  dieFile?: string;
  /** 준비 실패를 흉내 낸다 (csc 없음 등) */
  prepareFails?: string;
  /** 띄우기 거부를 흉내 낸다 (해시가 다름 등) */
  refuse?: string;
}

let seq = 0;

export function fakeServerLauncher(o: FakeServerLauncherOptions): FakeServerLauncher {
  const logFile = join(o.dir, `fake-server-helper-${process.pid}-${++seq}.log`);
  const delay = o.delayMs ?? (Number(process.env.WOOK_TEST_FAKE_SH_DELAY_MS ?? 0) || 0);
  const inDelay = Number(process.env.WOOK_TEST_FAKE_SH_IN_DELAY_MS ?? 0) || 0;
  const lines = (): string[] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
  const starts = (mode: string): string[][] => lines().map((l) => l.split(' ')).filter((p) => p[0] === 'start' && p[2] === mode);
  let prepares = 0;
  return {
    logFile,
    log: lines,
    launches: (mode) => starts(mode).length,
    pids: (mode) => starts(mode).map((p) => Number(p[1])),
    prepareCalls: () => prepares,
    prepare() {
      prepares++;
      return Promise.resolve(o.prepareFails ? { ok: false as const, reason: o.prepareFails } : { ok: true as const });
    },
    spec(mode, args) {
      if (o.refuse) return { refuse: o.refuse };
      return {
        file: process.execPath,
        args: [FAKE_SERVER_HELPER, mode, ...args],
        env: {
          ...serverHelperEnv(),
          FAKE_SH_LOG: logFile,
          FAKE_SH_SCENARIO: o.scenario ?? 'ok',
          ...(delay ? { FAKE_SH_DELAY_MS: String(delay) } : {}),
          // 느린 도우미 흉내 — 받은 줄을 늦게 처리한다 (리드 결정 S9-22 TI-2: 표준 출력만 늦추면 닫기·끝내기의 창을 보지 못한다)
          ...(inDelay ? { FAKE_SH_IN_DELAY_MS: String(inDelay) } : {}),
          ...(o.dieFile ? { FAKE_SH_DIE_FILE: o.dieFile } : {}),
        },
      };
    },
  };
}
