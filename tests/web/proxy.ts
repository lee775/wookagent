/**
 * 브라우저 시험의 https 앞단 (리드 결정 S8-7): `tailscale serve`처럼 공개 주소(https://wook-e2e.test:<포트>)의 TLS를 받아 루프백의 욱채 서버(http)로
 * 그대로 넘긴다. Host·Origin·쿠키 머리는 바꾸지 않는다.
 * - 인증서는 실행할 때 만든 자체 서명 인증서다 (playwright-core의 생성기 — 저장소에 개인 키를 두지 않는다). 브라우저는 ignoreHTTPSErrors로 받는다
 * - 네트워크 끊김: dropAll()이 브라우저 쪽 소켓을 모두 부수고(서버 쪽 요청도 끊는다), refuseFor(ms) 동안 새 연결을 받자마자 끊는다
 * - holdNext(pred): 맞는 /api/invoke 하나를 서버에 넘기지 않고 붙잡는다 — 시험이 release()할 때 넘긴다
 * - dropResponseOnce(pred): 맞는 /api/invoke 하나는 서버에 넘겨 처리시키고, 응답 머리만 보낸 뒤 연결을 부순다(본문이 오지 않는다). 머리를 먼저 보내는 까닭:
 *   응답이 한 바이트도 오지 않은 채 다시 쓴 연결이 끊기면 Chromium이 POST를 스스로 다시 보낸다 — 그러면 브리지의 다시 보내기를 시험하지 못한다
 * - holdRequest(pred): 맞는 invoke 밖의 요청(이벤트 연결 GET 등) 하나를 서버에 넘기지 않고 붙잡는다 — release()할 때 넘긴다 (S8-17: 보는 팀원을 바꾼 연결)
 * - stallUploads(pred, abortDelayMs): 맞는 업로드(POST /api/uploads)는 머리만 서버에 넘기고(서버가 그 기기의 업로드로 센다) 본문은 release()까지 붙잡는다.
 *   브라우저가 그 업로드를 끊으면 abortDelayMs 뒤에야 서버 쪽을 끊는다 — 끊김이 서버에 늦게 닿는 길 흉내 (S8-18)
 * - 받은 요청을 적어 둔다 (경로, invoke의 id·method·args, 상태)
 */
import { createRequire } from 'node:module';
import { createServer, type Server as HttpsServer } from 'node:https';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export const E2E_HOST = 'wook-e2e.test';

export interface InvokeRecord {
  id: unknown;
  method: string;
  args: unknown;
}

export interface ProxyRecord {
  method: string;
  url: string;
  invoke: InvokeRecord | null;
  status: number | null;
  /** dropResponseOnce가 응답 본문을 버린 요청 */
  dropped: boolean;
}

export interface Hold {
  /** 붙잡힌 요청이 들어올 때 */
  arrived: Promise<InvokeRecord>;
  /** 붙잡은 요청을 서버로 넘긴다 */
  release(): void;
}

export interface RequestHold {
  /** 붙잡힌 요청이 들어올 때 (그 주소) */
  arrived: Promise<string>;
  /** 붙잡은 요청을 서버로 넘긴다 */
  release(): void;
}

export interface UploadStall {
  /** 붙잡은 업로드 본문을 모두 서버로 흘려 보내고, 그 뒤의 업로드는 붙잡지 않는다 */
  release(): void;
}

export interface E2eProxy {
  port: number;
  origin: string;
  log: ProxyRecord[];
  setUpstream(port: number): void;
  dropAll(): void;
  refuseFor(ms: number): void;
  holdNext(pred: (inv: InvokeRecord) => boolean): Hold;
  dropResponseOnce(pred: (inv: InvokeRecord) => boolean): Promise<InvokeRecord>;
  holdRequest(pred: (url: string) => boolean): RequestHold;
  stallUploads(pred: (url: string) => boolean, abortDelayMs: number): UploadStall;
  invokes(method?: string): InvokeRecord[];
  close(): Promise<void>;
}

/** playwright-core 안의 자체 서명 인증서 생성기 (1.64.1에 있음 — 리드 탐색 S8 'Lead probe'). 내부 API라 없으면 분명히 실패한다 */
function selfSignedCertificate(): { cert: string; key: string } {
  const req = createRequire(import.meta.url);
  const bundle = req('playwright-core/lib/coreBundle') as { utils?: { generateSelfSignedCertificate?: () => { cert: string; key: string } } };
  const make = bundle.utils?.generateSelfSignedCertificate;
  if (typeof make !== 'function') throw new Error('playwright-core에 자체 서명 인증서 생성기가 없습니다 — tests/web/proxy.ts의 인증서 만들기를 고치세요');
  return make();
}

export async function startProxy(): Promise<E2eProxy> {
  const { cert, key } = selfSignedCertificate();
  const sockets = new Set<Socket>();
  const log: ProxyRecord[] = [];
  let upstream = 0;
  let refuseUntil = 0;
  const holds: { pred: (inv: InvokeRecord) => boolean; arrived: (inv: InvokeRecord) => void; released: Promise<void> }[] = [];
  const drops: { pred: (inv: InvokeRecord) => boolean; done: (inv: InvokeRecord) => void }[] = [];
  const requestHolds: { pred: (url: string) => boolean; arrived: (url: string) => void; released: Promise<void> }[] = [];
  const stalls: { pred: (url: string) => boolean; released: Promise<void>; abortDelayMs: number }[] = [];

  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    rec: ProxyRecord,
    body: Buffer | null,
    dropBody: boolean,
    stall?: { released: Promise<void>; abortDelayMs: number },
  ): void => {
    // 붙잡은 동안 브라우저가 떠났으면 넘기지 않는다
    if (req.socket.destroyed) return;
    const up = request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers: req.headers, agent: false }, (upRes) => {
      rec.status = upRes.statusCode ?? 0;
      if (dropBody) {
        // 서버는 처리를 마쳤다 — 응답을 다 받은 뒤 머리만 보내고 연결을 부순다
        upRes.resume();
        upRes.on('end', () => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          res.flushHeaders();
          setTimeout(() => res.socket?.destroy(), 100);
        });
        return;
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => res.socket?.destroy());
    // 브라우저 쪽이 끊기면(끊김 흉내 포함) 서버 쪽 요청도 끊는다 — 서버가 이벤트 연결이 끊긴 것을 바로 안다. 붙잡은 업로드는 늦게 끊는다
    res.on('close', () => {
      if (stall) setTimeout(() => up.destroy(), stall.abortDelayMs);
      else up.destroy();
    });
    if (body) up.end(body);
    else if (stall) {
      // 머리는 바로 보낸다 (Node는 첫 쓰기 전까지 머리를 보내지 않는다) — 서버가 그 업로드를 센다
      up.flushHeaders();
      void stall.released.then(() => {
        if (!up.destroyed) req.pipe(up);
      });
    } else req.pipe(up);
  };

  const server: HttpsServer = createServer({ cert, key }, (req, res) => {
    const rec: ProxyRecord = { method: req.method ?? '', url: req.url ?? '', invoke: null, status: null, dropped: false };
    log.push(rec);
    if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/api/invoke') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          const parsed = JSON.parse(body.toString('utf8')) as { id?: unknown; method?: unknown; args?: unknown };
          rec.invoke = { id: parsed.id, method: String(parsed.method), args: parsed.args };
        } catch {
          rec.invoke = null;
        }
        const inv = rec.invoke;
        const hold = inv ? holds.find((x) => x.pred(inv)) : undefined;
        const drop = inv ? drops.find((x) => x.pred(inv)) : undefined;
        if (hold && inv) {
          holds.splice(holds.indexOf(hold), 1);
          hold.arrived(inv);
          void hold.released.then(() => forward(req, res, rec, body, false));
          return;
        }
        if (drop && inv) {
          drops.splice(drops.indexOf(drop), 1);
          rec.dropped = true;
          drop.done(inv);
          forward(req, res, rec, body, true);
          return;
        }
        forward(req, res, rec, body, false);
      });
      return;
    }
    const url = req.url ?? '';
    const held = requestHolds.find((x) => x.pred(url));
    if (held) {
      requestHolds.splice(requestHolds.indexOf(held), 1);
      held.arrived(url);
      void held.released.then(() => forward(req, res, rec, null, false));
      return;
    }
    const stall = req.method === 'POST' && url.split('?')[0] === '/api/uploads' ? stalls.find((x) => x.pred(url)) : undefined;
    forward(req, res, rec, null, false, stall);
  });
  server.on('connection', (socket: Socket) => {
    if (Date.now() < refuseUntil) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // TLS 오류(부순 소켓 등)로 서버가 죽지 않게
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    origin: `https://${E2E_HOST}:${port}`,
    log,
    setUpstream: (p) => {
      upstream = p;
    },
    dropAll: () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    refuseFor: (ms) => {
      refuseUntil = Date.now() + ms;
    },
    holdNext: (pred) => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let arrived!: (inv: InvokeRecord) => void;
      const arrivedP = new Promise<InvokeRecord>((r) => (arrived = r));
      holds.push({ pred, arrived, released });
      return { arrived: arrivedP, release };
    },
    dropResponseOnce: (pred) => new Promise<InvokeRecord>((done) => drops.push({ pred, done })),
    holdRequest: (pred) => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let arrived!: (url: string) => void;
      const arrivedP = new Promise<string>((r) => (arrived = r));
      requestHolds.push({ pred, arrived, released });
      return { arrived: arrivedP, release };
    },
    stallUploads: (pred, abortDelayMs) => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const entry = { pred, released, abortDelayMs };
      stalls.push(entry);
      return {
        release: () => {
          const i = stalls.indexOf(entry);
          if (i >= 0) stalls.splice(i, 1);
          release();
        },
      };
    },
    invokes: (method) => log.flatMap((r) => (r.invoke && (!method || r.invoke.method === method) ? [r.invoke] : [])),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
