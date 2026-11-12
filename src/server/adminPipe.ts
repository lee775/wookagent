/**
 * 관리 채널의 전송 (SERVER_DESIGN 3.2, 리드 결정 S9-7): 이름 있는 파이프(Windows)·소켓 파일(POSIX)을 열고 연결마다 Duplex 하나를 admin.ts의 처리기에 준다.
 * 처리기와 약속(서로 증명, 한 줄 JSON)은 그대로다 — 이 파일은 바이트가 오가는 길만 정한다.
 * - 'node': Node(libuv)가 연다(예전 그대로). Windows에서는 원격(SMB) 클라이언트를 거부하지 못하고 DACL을 정하지 못한다 → 상태 mode 'node',
 *   rejectsRemote·userOnlyAcl false. POSIX는 데이터 폴더 안의 0600 소켓 파일 → mode 'socket'
 * - 도우미 ({helper}): `WookServerHelper.exe pipe --name …`(resources/serverhelper/ServerHelper.cs)가 PIPE_REJECT_REMOTE_CLIENTS와 지금 사용자만의 DACL로
 *   파이프를 만들고 연결의 바이트를 표준 입출력으로 넘긴다(OPEN·DATA·END / DATA·END·KILL·CLOSE). 자리 파일(admin.endpoint)은 READY 뒤에만 쓴다.
 *   FAIL INUSE면 Node 파이프와 같이 '이미 다른 프로그램이 쓰고 있습니다'로 시작하지 않는다
 * - 물러남 (Q7 — 시작을 막지 않는다): csc 없음·컴파일 실패·해시가 다름·FAIL INIT·10초 안에 READY 없음(리드 결정 S9-19 — 화면 도우미와 같다)·약속 위반(1 MiB 넘는 줄 등)이면 새 이름의 Node 파이프로
 *   연다 — 상태에 까닭, 경고 한 줄('관리 채널이 다른 기기(SMB)의 연결을 거부하지 못합니다 (<까닭>) — Tailscale 쪽 TCP 445를 막아 두세요'), 운영자 활동 기록 한 줄
 * - 도우미가 도중에 끝나면: 그 연결을 모두 버리고, 새 이름으로 다시 띄우고, admin.endpoint를 다시 쓴다. 잇달아 3번 다시 띄운 뒤에도 끝나면 물러난다 — READY 뒤
 *   10분 넘게 돈 도우미가 끝나면 그 수를 처음부터 센다(리드 결정 S9-22 — 몇 달 도는 서버가 띄엄띄엄한 세 번의 끝남으로 Node 파이프에 남지 않게)
 * - 닫기: CLOSE와 표준 입력 닫기 → 1초 안에 끝나지 않으면 끝낸다(쥔 ChildProcess로만) → 끝난 것을 확인한 뒤에 돌아온다
 * 기록에는 연결의 바이트(증명·난수·명령)를 넣지 않는다 — 연결 수·까닭만
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { Logger } from '../main/shell/logger';
import { firstStderrLine, readHelperLines, settles, SERVER_HELPER_PROTOCOL, type ServerHelperLauncher } from './serverHelper';

export type AdminPipeMode = 'helper' | 'node' | 'socket';

/** 관리 status의 adminPipe (리드 결정 S9-2) */
export interface AdminPipeInfo {
  mode: AdminPipeMode;
  /** 다른 기기(SMB)에서 온 연결을 증명 전에 거부하는지 */
  rejectsRemote: boolean;
  /** 파이프·소켓을 지금 사용자만 열 수 있는지 */
  userOnlyAcl: boolean;
  /** 도우미를 쓰지 않는 까닭 (도우미면 null) */
  reason: string | null;
}

export interface AdminHelperTransport {
  helper: ServerHelperLauncher;
  /** READY를 기다리는 상한 (기본 10초 — 리드 결정 S9-19) */
  readyTimeoutMs?: number;
  /** 도중에 끝난 도우미를 다시 띄우는 횟수 상한 (기본 3) */
  restartCap?: number;
  /** 닫을 때 스스로 끝나기를 기다리는 시간 (기본 1초) — 넘으면 끝낸다 */
  closeGraceMs?: number;
  /** 이만큼 돈 도우미가 끝나면 다시 띄우기 수를 처음부터 센다 (기본 10분) · 시계 (기본 단조 시계 performance.now — 시험은 옮긴다) */
  stableMs?: number;
  now?: () => number;
}

/** 'node'(기본 — 프로세스 안 시험 서버), 또는 서버 도우미 (serve.ts가 Windows에서 넘긴다) */
export type AdminTransport = 'node' | AdminHelperTransport;

/**
 * READY를 기다리는 상한 (리드 결정 S9-19 — 5초에서 10초로, 화면 도우미와 같다). 느린 시작이 이 창을 넘기면 그 실행 내내 관리 채널이 SMB로 닿는 Node 파이프로
 * 물러나므로 넉넉히 둔다 — 시작에서 몇 초 더 기다리는 값은 그보다 싸다
 */
export const ADMIN_PIPE_READY_MS = 10_000;
export const ADMIN_PIPE_RESTART_CAP = 3;
export const ADMIN_PIPE_CLOSE_GRACE_MS = 1_000;
/** READY 뒤 이만큼 돈 도우미가 끝나면 잇단 끝남이 아니다 — 다시 띄우기 수를 처음부터 센다 (리드 결정 S9-22) */
export const ADMIN_PIPE_STABLE_MS = 10 * 60_000;
/** 연결 상한 — 도우미의 인스턴스 상한과 같다. 넘으면 그 연결을 KILL한다 */
export const ADMIN_PIPE_MAX_CONNECTIONS = 16;
/** DATA 한 줄에 싣는 바이트 (base64로 약 64KiB) */
const DATA_CHUNK = 48 * 1024;

const HELPER_INFO: AdminPipeInfo = { mode: 'helper', rejectsRemote: true, userOnlyAcl: true, reason: null };

/** 물러날 때의 경고 (리드 결정 S9-7) — 상태·기록·check가 같은 까닭을 말한다 */
export function adminPipeFallbackWarning(reason: string): string {
  return `관리 채널이 다른 기기(SMB)의 연결을 거부하지 못합니다 (${reason}) — Tailscale 쪽 TCP 445를 막아 두세요`;
}

export interface AdminPipeOptions {
  /** 처음 열 자리 */
  endpoint: string;
  platform: NodeJS.Platform;
  transport: AdminTransport;
  /** 연결 하나 — admin.ts의 처리기 */
  onConnection: (socket: Duplex) => void;
  logger: Logger;
  /** 새 자리 이름 (도우미를 다시 띄울 때·물러날 때) */
  newEndpoint: () => string;
  /** 자리를 알린다 (admin.endpoint를 쓴다). 시작 때 던지면 시작 실패 */
  publish: (endpoint: string) => void;
  /** 자리를 거둔다 (admin.endpoint가 아직 그 자리를 가리킬 때만 지운다) */
  withdraw: (endpoint: string) => void;
  /** 운영자 활동 기록 한 줄 (물러날 때) */
  notify?: (text: string) => void;
}

export interface AdminPipe {
  /** 지금 듣는 자리 (도우미를 다시 띄우면 바뀐다) */
  readonly endpoint: string;
  info(): AdminPipeInfo;
  /** 듣는 자리 (파이프·소켓 경로 — 시험이 TCP가 아님을 본다) */
  address(): string | AddressInfo | null;
  /** 새 연결을 받지 않고 닫는다. 도우미는 끝난 것을 확인한 뒤에 돌아온다 */
  close(): Promise<void>;
}

export async function openAdminPipe(o: AdminPipeOptions): Promise<AdminPipe> {
  if (o.transport === 'node') return openNodePipe(o);
  return openHelperPipe(o, o.transport);
}

// ───────────────────────── Node(libuv) 파이프·소켓 ─────────────────────────

function nodeInfo(platform: NodeJS.Platform, reason: string): AdminPipeInfo {
  return platform === 'win32' ? { mode: 'node', rejectsRemote: false, userOnlyAcl: false, reason } : { mode: 'socket', rejectsRemote: true, userOnlyAcl: true, reason: null };
}

/** libuv로 듣는다. 실행 잠금을 잡은 뒤라 POSIX의 남은 소켓은 죽은 서버의 것이다 — 소켓이 아닌 것은 건드리지 않는다 */
async function listenNode(endpoint: string, platform: NodeJS.Platform, onConnection: (socket: Socket) => void, logger: Logger): Promise<Server> {
  const server = createServer(onConnection);
  if (platform !== 'win32') {
    try {
      const st = lstatSync(endpoint);
      if (!st.isSocket()) throw new Error(`관리 채널 자리에 소켓이 아닌 파일이 있습니다: ${endpoint}`);
      unlinkSync(endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  server.on('error', (error) => logger.error('관리 채널 오류', error));
  return server;
}

function removeSocketFile(endpoint: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  try {
    unlinkSync(endpoint);
  } catch {
    // 이미 없다
  }
}

const closeServer = (server: Server): Promise<void> => new Promise<void>((r) => server.close(() => r()));

async function openNodePipe(o: AdminPipeOptions): Promise<AdminPipe> {
  const { endpoint, platform } = o;
  const server = await listenNode(endpoint, platform, o.onConnection, o.logger);
  try {
    if (platform !== 'win32') chmodSync(endpoint, 0o600);
    // 운영자 명령이 찾는 자리 — 연 뒤에 그 사용자만 읽는 파일로 알린다 (S2-20)
    o.publish(endpoint);
  } catch (error) {
    await closeServer(server);
    removeSocketFile(endpoint, platform);
    throw error;
  }
  const info = nodeInfo(platform, '서버 도우미 없이 Node 파이프로 열었습니다');
  let closed: Promise<void> | null = null;
  return {
    endpoint,
    info: () => info,
    address: () => server.address(),
    close() {
      closed ??= new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        o.withdraw(endpoint);
        removeSocketFile(endpoint, platform);
      });
      return closed;
    },
  };
}

// ───────────────────────── 서버 도우미 파이프 ─────────────────────────

interface RunningHelper {
  child: ChildProcessWithoutNullStreams;
  conns: Map<number, HelperConnection>;
  /** 끝났거나 이 쪽이 버린 도우미 — 끝남을 '도중에 끝남'으로 세지 않는다 */
  dead: boolean;
  /** READY를 받은 때 (now()) — 아직이면 null */
  readyAt: number | null;
  exited: Promise<void>;
  send(line: string): void;
  /** 연결 상한을 넘겨 KILL한 것을 이미 경고했는지 (도우미마다 한 번) */
  overCapWarned: boolean;
}

/** 도우미 연결 하나 — admin.ts 처리기가 쓰는 Socket의 부분(data·close·error, write·end·destroy·destroyed) */
class HelperConnection extends Duplex {
  /** 도우미가 END를 알렸다 (클라이언트가 끊었거나 END를 다 처리했다) */
  remoteEnded = false;
  /** 이 쪽이 END를 보냈다 (다 쓰면 닫기) */
  endSent = false;

  constructor(
    readonly id: number,
    private readonly helper: RunningHelper,
  ) {
    super({ allowHalfOpen: false });
  }

  override _read(): void {
    // 도우미가 DATA를 줄 때 push한다
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    for (let at = 0; at < chunk.length; at += DATA_CHUNK) {
      this.helper.send(`DATA ${this.id} ${chunk.subarray(at, at + DATA_CHUNK).toString('base64')}`);
    }
    cb();
  }

  override _final(cb: (error?: Error | null) => void): void {
    if (!this.remoteEnded) {
      this.endSent = true;
      this.helper.send(`END ${this.id}`);
    }
    cb();
  }

  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    // 이 쪽이 끊는다(시간 초과 등) — 아직 열린 연결이면 바로 닫게 한다
    if (!this.remoteEnded && !this.endSent && !this.helper.dead) this.helper.send(`KILL ${this.id}`);
    if (this.helper.conns.get(this.id) === this) this.helper.conns.delete(this.id);
    cb(error);
  }
}

type HelperStart = { kind: 'ready'; helper: RunningHelper } | { kind: 'inuse' } | { kind: 'refused'; reason: string } | { kind: 'failed'; reason: string };

const ID_RE = /^[0-9]{1,9}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function inUseError(endpoint: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`관리 채널 파이프 이름(${endpoint})을 이미 다른 프로그램이 쓰고 있습니다 (서버 도우미 FAIL INUSE)`);
  error.code = 'EADDRINUSE';
  return error;
}

async function openHelperPipe(o: AdminPipeOptions, t: AdminHelperTransport): Promise<AdminPipe> {
  const { logger } = o;
  const readyMs = t.readyTimeoutMs ?? ADMIN_PIPE_READY_MS;
  const cap = t.restartCap ?? ADMIN_PIPE_RESTART_CAP;
  const graceMs = t.closeGraceMs ?? ADMIN_PIPE_CLOSE_GRACE_MS;
  const stableMs = t.stableMs ?? ADMIN_PIPE_STABLE_MS;
  // 단조 시계 — 벽시계가 절전에서 깨어나거나 손으로 바뀌어 뛰어도 '10분 돌았다'를 잘못 재지 않게 (리드 결정 S9-24). 시험은 시계를 넣는다
  const now = t.now ?? (() => performance.now());
  let endpoint = o.endpoint;
  let info: AdminPipeInfo = HELPER_INFO;
  let current: RunningHelper | null = null;
  let nodeServer: Server | null = null;
  let restarts = 0;
  let closing = false;
  let fellBack = false;
  /** 다시 띄우거나 물러나는 중 — 닫기가 기다린다 */
  let recovering: Promise<void> | null = null;

  /** 도우미를 끝낸다 (쥔 ChildProcess로만): CLOSE·표준 입력 닫기 → 상한 뒤 kill → 끝난 것을 확인 */
  const stopHelper = async (h: RunningHelper, gentle: boolean): Promise<void> => {
    h.dead = true;
    for (const c of [...h.conns.values()]) c.destroy();
    h.conns.clear();
    let forced = false;
    if (h.child.exitCode === null && h.child.signalCode === null) {
      let done = false;
      if (gentle) {
        // h.dead가 이미 참이라 send()는 쓰지 않는다 — CLOSE를 직접 쓰고 표준 입력을 닫는다
        if (!h.child.stdin.destroyed && !h.child.stdin.writableEnded) h.child.stdin.end('CLOSE\n');
        done = await settles(h.exited, graceMs);
      }
      if (!done && h.child.exitCode === null && h.child.signalCode === null) {
        forced = true;
        h.child.kill();
      }
    }
    const ended = await settles(h.exited, 10_000);
    if (gentle) logger.info(`관리 채널: 서버 도우미를 끝냈습니다 (pid ${h.child.pid ?? '?'}${forced ? `, ${graceMs}ms 안에 끝나지 않아 끝냄` : ''}${ended ? '' : ' — 끝남을 확인하지 못함'})`);
  };

  /** 도우미 하나를 띄워 READY를 기다린다 */
  const startHelper = async (name: string): Promise<HelperStart> => {
    const spec = t.helper.spec('pipe', ['--name', name]);
    if ('refuse' in spec) return { kind: 'refused', reason: spec.refuse };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.file, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      return { kind: 'failed', reason: `서버 도우미를 띄우지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` };
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 4096) stderr += c;
    });
    child.stdin.on('error', () => undefined);
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    const h: RunningHelper = {
      child,
      conns: new Map(),
      dead: false,
      readyAt: null,
      exited,
      overCapWarned: false,
      send(line) {
        if (this.dead || child.stdin.destroyed || child.stdin.writableEnded) return;
        child.stdin.write(`${line}\n`);
      },
    };
    return new Promise<HelperStart>((resolveStart) => {
      let ready = false;
      let settled = false;
      // 창의 길이는 그대로 말한다 — 시험이 넣는 짧은 창(0.3초)을 '0초'로 반올림하지 않는다
      const timer = setTimeout(() => fail(`${readyMs / 1000}초 안에 READY가 오지 않았습니다`), readyMs);
      const settle = (r: HelperStart): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveStart(r);
      };
      const fail = (reason: string, kind: 'failed' | 'inuse' = 'failed'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void stopHelper(h, false).then(() => resolveStart(kind === 'inuse' ? { kind: 'inuse' } : { kind: 'failed', reason }));
      };
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (!ready) fail(`서버 도우미를 띄우지 못했습니다 (${error.code ?? error.message})`);
      });
      child.once('exit', (code, signal) => {
        if (!ready) {
          const why = firstStderrLine(stderr);
          fail(`서버 도우미가 준비 전에 끝났습니다 (코드 ${code ?? signal}${why ? `, ${why}` : ''})`);
          return;
        }
        if (!h.dead) void onDeath(h, `코드 ${code ?? signal}`);
      });
      readHelperLines(
        child.stdout,
        (line) => {
          if (h.dead) return;
          if (!ready) {
            if (line === `READY ${SERVER_HELPER_PROTOCOL} pipe`) {
              ready = true;
              h.readyAt = now();
              settle({ kind: 'ready', helper: h });
            } else if (line === 'FAIL INUSE') fail('', 'inuse');
            else if (line.startsWith('FAIL INIT')) fail(`서버 도우미가 파이프를 만들지 못했습니다 (${line.slice('FAIL INIT'.length).trim() || '까닭 없음'})`);
            else fail(`서버 도우미의 첫 줄을 알 수 없습니다 (판이 다를 수 있습니다: ${line.slice(0, 40)})`);
            return;
          }
          onLine(h, line);
        },
        () => {
          if (!ready) fail('서버 도우미의 줄이 1 MiB를 넘었습니다');
          else void abandon(h, '서버 도우미의 줄이 1 MiB를 넘었습니다');
        },
      );
    });
  };

  /** READY 뒤의 한 줄 */
  const onLine = (h: RunningHelper, line: string): void => {
    const parts = line.split(' ');
    const [verb, idText] = parts;
    if (!idText || !ID_RE.test(idText)) return void abandon(h, `서버 도우미가 약속에 없는 줄을 보냈습니다 (${verb?.slice(0, 16) ?? ''})`);
    const id = Number(idText);
    if (verb === 'OPEN' && parts.length === 2) {
      if (h.conns.has(id)) return void abandon(h, '서버 도우미가 이미 열린 연결 번호를 다시 열었습니다');
      if (h.conns.size >= ADMIN_PIPE_MAX_CONNECTIONS) {
        h.send(`KILL ${id}`);
        if (!h.overCapWarned) {
          h.overCapWarned = true;
          logger.warn(`관리 채널: 연결이 ${ADMIN_PIPE_MAX_CONNECTIONS}개를 넘어 새 연결을 닫았습니다`);
        }
        return;
      }
      const conn = new HelperConnection(id, h);
      h.conns.set(id, conn);
      o.onConnection(conn);
      return;
    }
    if (verb === 'DATA' && parts.length === 3 && B64_RE.test(parts[2]!)) {
      // 이미 닫은 연결(KILL과 엇갈림)·END 뒤의 DATA는 버린다
      const conn = h.conns.get(id);
      if (conn && !conn.remoteEnded) conn.push(Buffer.from(parts[2]!, 'base64'));
      return;
    }
    if (verb === 'END' && parts.length === 2) {
      const conn = h.conns.get(id);
      if (conn) {
        conn.remoteEnded = true;
        conn.push(null);
      }
      return;
    }
    abandon(h, `서버 도우미가 약속에 없는 줄을 보냈습니다 (${verb?.slice(0, 16) ?? ''})`);
  };

  /** Node 파이프로 물러난다 (한 번만) — 새 이름으로 열고 알린 뒤 경고·활동 기록. 시작 때의 실패는 던진다 */
  const fallBack = async (reason: string, atStart: boolean): Promise<void> => {
    if (fellBack || closing) return;
    fellBack = true;
    const name = o.newEndpoint();
    let server: Server;
    try {
      server = await listenNode(name, o.platform, o.onConnection, logger);
    } catch (error) {
      if (atStart) throw error;
      logger.error(`관리 채널: 서버 도우미 대신 Node 파이프를 열지 못했습니다 — 운영자 명령이 이 서버에 붙지 못합니다 (${reason})`, error);
      return;
    }
    if (closing) {
      await closeServer(server);
      return;
    }
    try {
      o.publish(name);
    } catch (error) {
      if (atStart) {
        await closeServer(server);
        throw error;
      }
      logger.error('관리 채널 자리 파일(admin.endpoint)을 다시 쓰지 못했습니다', error);
    }
    nodeServer = server;
    endpoint = name;
    info = { mode: 'node', rejectsRemote: false, userOnlyAcl: false, reason };
    logger.warn(adminPipeFallbackWarning(reason));
    try {
      o.notify?.(`관리 채널을 서버 도우미 없이 Node 파이프로 열었습니다 — 다른 기기(SMB)의 연결을 거부하지 못합니다 (${reason})`);
    } catch (error) {
      logger.error('관리 채널 물러남을 활동 기록에 남기지 못했습니다', error);
    }
  };

  /** 약속을 어긴 도우미 — 끝내고 바로 물러난다 (다시 띄워도 같다) */
  const abandon = (h: RunningHelper, reason: string): Promise<void> => {
    if (h.dead) return Promise.resolve();
    h.dead = true;
    if (current === h) current = null;
    o.withdraw(endpoint);
    const work = (async () => {
      await stopHelper(h, false);
      await fallBack(reason, false);
    })();
    recovering = work.finally(() => {
      if (recovering === work) recovering = null;
    });
    return work;
  };

  /** 도중에 끝난 도우미 — 연결을 버리고 새 이름으로 다시 띄운다. 상한을 넘으면 물러난다 */
  const onDeath = (h: RunningHelper, why: string): Promise<void> => {
    if (h.dead) return Promise.resolve();
    h.dead = true;
    for (const c of [...h.conns.values()]) c.destroy();
    h.conns.clear();
    if (current === h) current = null;
    o.withdraw(endpoint);
    // 오래(10분) 돈 도우미의 끝남은 잇단 끝남이 아니다 — 다시 띄우기 수를 처음부터 센다 (리드 결정 S9-22)
    if (h.readyAt !== null && now() - h.readyAt >= stableMs) restarts = 0;
    const work = (async () => {
      let reason = `서버 도우미가 끝났습니다 (${why})`;
      for (;;) {
        if (closing) return;
        if (restarts >= cap) {
          await fallBack(`서버 도우미가 ${cap}번 다시 띄운 뒤에도 끝났습니다 — ${reason}`, false);
          return;
        }
        restarts++;
        logger.warn(`관리 채널: ${reason} — 새 이름으로 다시 띄웁니다 (${restarts}/${cap})`);
        const name = o.newEndpoint();
        const r = await startHelper(name);
        if (r.kind === 'ready') {
          if (closing) {
            await stopHelper(r.helper, true);
            return;
          }
          endpoint = name;
          current = r.helper;
          try {
            o.publish(name);
          } catch (error) {
            logger.error('관리 채널 자리 파일(admin.endpoint)을 다시 쓰지 못했습니다', error);
          }
          logger.info(`관리 채널: 서버 도우미를 다시 띄웠습니다 (${name})`);
          return;
        }
        if (r.kind === 'refused') {
          await fallBack(r.reason, false);
          return;
        }
        reason = r.kind === 'inuse' ? '새 이름을 이미 다른 프로그램이 씁니다' : r.reason;
      }
    })();
    recovering = work.finally(() => {
      if (recovering === work) recovering = null;
    });
    return work;
  };

  // ── 시작 ──
  const prepared = await t.helper.prepare();
  if (!prepared.ok) {
    await fallBack(prepared.reason, true);
  } else {
    const first = await startHelper(endpoint);
    if (first.kind === 'inuse') throw inUseError(endpoint);
    if (first.kind === 'ready') {
      // READY 뒤 여기까지 사이에 끝났으면 그 끝남(onDeath)이 새 이름으로 다시 띄우고 알린다
      if (!first.helper.dead) {
        try {
          o.publish(endpoint);
        } catch (error) {
          await stopHelper(first.helper, true);
          throw error;
        }
        current = first.helper;
      }
    } else {
      await fallBack(first.reason, true);
    }
  }

  let closed: Promise<void> | null = null;
  return {
    get endpoint() {
      return endpoint;
    },
    info: () => info,
    address: () => (nodeServer ? nodeServer.address() : endpoint),
    close() {
      closed ??= (async () => {
        closing = true;
        // 자리 파일은 바로 거둔다 (Node 파이프와 같다) — 운영자 명령이 닫히는 도우미에 붙지 않게
        o.withdraw(endpoint);
        if (recovering) await recovering.catch(() => undefined);
        const h = current;
        current = null;
        if (h) await stopHelper(h, true);
        if (nodeServer) await closeServer(nodeServer);
        o.withdraw(endpoint);
      })();
      return closed;
    },
  };
}

