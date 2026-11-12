/**
 * try-server.mjs의 형 (시험 tests/try/tryKit.test.ts가 불러 쓴다). 실행 파일은 try-server.mjs 하나다 — 고치면 이 선언도 맞춘다
 */
import type { ChildProcess } from 'node:child_process';

export declare const REPO: string;
export declare const TRY_HOST: string;
export declare const PHONE_PORT: number;
export declare const TRY_OWNER_EMAIL: string;
export declare const FRONT_FILE: string;
export declare const FRONT_PROBE_PATH: string;
export declare const SESSION_COOKIE: string;
export declare const MODES: readonly string[];

export interface KitArgs {
  mode: 'local' | 'mock' | 'phone' | 'stop' | 'desktop';
  fresh: boolean;
  headless: boolean;
  smoke: boolean;
  dryRun: boolean;
  ownerEmail: string | null;
  googleClientId: string | null;
  realData: boolean;
}
export type ParsedKitArgs = KitArgs | { help: true } | { error: string };
export declare function parseKitArgs(argv: readonly string[]): ParsedKitArgs;
export declare function usage(paths?: TryPaths): string;

export interface TryPaths {
  root: string;
  rootFromEnv: boolean;
  rootRelative: boolean;
  server: string;
  serverWorkspace: string;
  phone: string;
  phoneWorkspace: string;
  desktop: string;
  /** 실제 욱채 데이터 폴더들 (기본 위치와 WOOK_DATA_DIR) */
  real: string[];
}
export declare function realDataDirs(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];
export declare function tryPaths(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): TryPaths;
export declare function overlaps(a: string, b: string, platform?: NodeJS.Platform): boolean;
export declare function pathsProblem(paths: TryPaths, platform?: NodeJS.Platform): string | null;

/** 이 도구가 만든 체험 폴더의 표시 파일 이름 */
export declare const TRY_MARKER: string;
export declare function hasTryMarker(dir: string): boolean;
/** 체험 폴더를 그 사용자만 쓰게 만든다 (옆 임시 이름 → 좁히기 → 표시 파일 → 제자리). 이미 있으면 그대로 */
export declare function prepareTryDir(dir: string, platform?: NodeJS.Platform, hooks?: { beforeRename?: (staging: string) => void }): { created: boolean };
export declare function freshProblem(paths: TryPaths): string | null;
/** --fresh가 지울 폴더를 옮겨 두는 옆 이름 */
export declare const FRESH_TRASH_RE: RegExp;
/** --fresh의 지우기: 옆 이름으로 다 옮긴 뒤에만 지운다. 다 되면 null, 멈췄으면 끝 코드 */
export declare function freshRemove(
  paths: TryPaths,
  deps: KitDeps,
  stop?: { readonly fired: boolean } | null,
  hooks?: { rename?: (from: string, to: string) => void },
): Promise<number | null>;
export declare function freshLeftovers(paths: TryPaths): string[];
/** --fresh가 되돌리지 못한 옆 이름 폴더의 메모 파일 이름 */
export declare const RESTORE_NOTE: string;
export declare function restoreTarget(sideDir: string): 'server' | 'workspace' | null;
export declare function sideFolders(paths: TryPaths): { stranded: { path: string; to: 'server' | 'workspace'; orig: string }[]; leftovers: string[] };
export declare function strandedProblem(paths: TryPaths): { stop: boolean; text: string } | null;
export declare const CLAUDE_LOGIN_LINE: string;
export declare const MOCK_TEMP_PREFIX: string;
export declare function mockEnv(env: NodeJS.ProcessEnv, o: { runDir: string; webDir: string; headless: boolean; smoke: boolean }): NodeJS.ProcessEnv;

export declare function localServerConfig(paths: TryPaths): Record<string, unknown>;
export declare function phoneServerConfig(
  existing: unknown,
  o: { ownerEmail: string; login: string | null; origin: string; googleClientId: string | null; workspace: string },
): Record<string, unknown> & { google?: { clientId?: string } };

export interface BuildSpec {
  label: string;
  /** 목적격 조사를 붙인 이름 ('서버를', '웹 화면을') */
  labelObj: string;
  npm: string;
  outputs: string[];
  sources: string[];
  command: string[];
  marker?: RegExp;
}
export declare function buildSpecs(repo?: string): { server: BuildSpec; web: BuildSpec; desktop: BuildSpec };
export declare function newestFile(paths: readonly string[]): { path: string; mtimeMs: number } | null;
export declare function staleReason(spec: BuildSpec, repo?: string): string | null;
export declare function edgeCandidates(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];

export interface TailscaleStatus {
  running: boolean;
  state: string;
  dnsName: string | null;
  https: boolean;
  login: string | null;
}
export declare function readTailscaleStatus(json: unknown): TailscaleStatus;
export declare function readServeStatus(json: unknown, port?: number): { entries: string[]; ours: boolean; funnel: boolean };
export declare function quietEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function desktopEnv(env: NodeJS.ProcessEnv, paths: TryPaths, realData: boolean): NodeJS.ProcessEnv;
export declare function frontMac(nonce: string, challenge: string): string;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  inherit?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export interface Front {
  port: number;
  nonce: string;
  setUpstream(port: number): void;
  close(): Promise<void>;
}
export interface BrowserSession {
  closed: Promise<void>;
  check(): Promise<{ ok: true } | { ok: false; detail: string }>;
  close(): Promise<void>;
}
/** runKit의 바깥 — 시험은 가짜를 넣는다 */
export interface KitDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  repo: string;
  out(text: string): void;
  err(text: string): void;
  /** 끝날 때까지 기다리는 명령 (빌드·운영자 명령·tailscale 읽기) */
  run(file: string, args: readonly string[], o?: RunOptions): Promise<RunResult>;
  /** 오래 도는 프로세스 (서버·vitest·데스크톱 앱) — 손잡이를 돌려준다 */
  start(file: string, args: readonly string[], o?: RunOptions): ChildProcess;
  front: { start(port: number): Promise<Front>; probe(port: number, challenge: string): Promise<string | null> };
  openBrowser(o: { origin: string; token: string; headless: boolean; path: string }): Promise<BrowserSession>;
  edgeInstalled(): boolean;
  onInterrupt(handler: () => void): { fired: Promise<void>; dispose(): void };
  ask(question: string): Promise<string>;
  /** 시험: 서버 준비·종료를 기다리는 시간 */
  readyTimeoutMs?: number;
  exitWaitMs?: number;
}
export declare function operator(
  deps: KitDeps,
  entry: string,
  words: readonly string[],
  dataDir: string,
  timeoutMs?: number,
): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }>;
export declare function frontProven(deps: KitDeps, port: number, nonce: string): Promise<boolean>;
export declare function runKit(argv: readonly string[], deps: KitDeps): Promise<number>;
export declare function startFront(port?: number): Promise<Front>;
export declare function probeFront(port: number, challenge: string): Promise<string | null>;
export declare function openBrowser(o: { origin: string; token: string; headless: boolean; path: string }): Promise<BrowserSession>;
export declare function realDeps(): KitDeps;
