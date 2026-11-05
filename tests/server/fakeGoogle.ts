/**
 * 가짜 구글 서버 (SERVER_DESIGN 3.5, 리드 결정 S3-5 시험): 기기 코드(`/device/code`), 토큰(`/token`), 공개 키(`/certs`)를 루프백 HTTP로 흉내 낸다.
 * - 시험이 기기 코드마다 다음 토큰 답(기다림·slow_down·거부·만료·허락·오류·장애)을 정하고, 받은 요청 본문을 모은다
 * - id_token은 이 서버의 RSA 키로 서명한다(다른 키로 서명하게 할 수도 있다). 허락한 기기 코드는 한 번만 토큰을 준다 — 그 뒤는 invalid_grant(구글과 같다)
 * - 클라이언트 ID·보안 비밀이 맞지 않으면 invalid_client
 * 받은 본문(보안 비밀·device_code가 들어 있다)은 시험 출력에 내지 않는다 — 수와 칸 이름·참거짓으로만 본다
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { GoogleDeviceEndpoints } from '../../src/main/auth/googleDevice';

export const FAKE_CLIENT_ID = '1234567890-tvdevice.apps.googleusercontent.com';
export const FAKE_CLIENT_SECRET = 'GOCSPX-fake-device-secret-0000';
export const OWNER_SUB = '109876543210';
const KID = 'fake-kid-1';

export type TokenAnswer =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'ok'; claims?: Record<string, unknown>; otherKey?: boolean }
  | { kind: 'error'; status: number; error: string }
  /** 구글 장애 (500, 오류 이름 없음) */
  | { kind: 'down' };

export interface FakeGoogle {
  url: string;
  endpoints: GoogleDeviceEndpoints;
  codeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  /** 다음에 낼 기기 코드의 간격·만료(초)와 verification_url */
  next: { interval: number; expiresIn: number; verificationUrl: string };
  /** 기기 코드 요청에 줄 답 (없으면 정상) */
  codeAnswer: { status: number; body: unknown } | null;
  answer(deviceCode: string, a: TokenAnswer): void;
  lastDeviceCode(): string;
  /** 그 기기 코드로 온 토큰 요청 수 */
  tokenCalls(deviceCode: string): number;
  /** id_token 기본 내용 (sub·email 등 — answer의 claims가 덮는다) */
  claims(over?: Record<string, unknown>): Record<string, unknown>;
  close(): Promise<void>;
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other: KeyObject = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, alg: 'RS256', use: 'sig' };
  const answers = new Map<string, TokenAnswer>();
  const used = new Set<string>();
  const calls = new Map<string, number>();
  const codes: string[] = [];
  const codeRequests: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const signToken = (claims: Record<string, unknown>, key: KeyObject): string => {
    const data = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64(claims)}`;
    return `${data}.${sign('sha256', Buffer.from(data), key).toString('base64url')}`;
  };
  const baseClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: 'https://accounts.google.com', aud: FAKE_CLIENT_ID, azp: FAKE_CLIENT_ID, sub: OWNER_SUB, email: 'owner@example.com', email_verified: true, name: '김대표', iat: now, exp: now + 3600, ...over };
  };

  const fake: FakeGoogle = {
    url: '',
    endpoints: { deviceCode: '', token: '', jwks: '' },
    codeRequests,
    tokenRequests,
    next: { interval: 1, expiresIn: 1800, verificationUrl: 'https://www.google.com/device' },
    codeAnswer: null,
    answer: (code, a) => void answers.set(code, a),
    lastDeviceCode: () => codes.at(-1) ?? '',
    tokenCalls: (code) => calls.get(code) ?? 0,
    claims: baseClaims,
    close: async () => undefined,
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
        res.end(text);
      };
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (req.method === 'GET' && req.url === '/certs') return send(200, { keys: [jwk] });
      if (req.method === 'POST' && req.url === '/device/code') {
        codeRequests.push(form);
        if (fake.codeAnswer) return send(fake.codeAnswer.status, fake.codeAnswer.body);
        if (form.get('client_id') !== FAKE_CLIENT_ID) return send(401, { error: 'invalid_client' });
        const deviceCode = `fake-device-code-${randomBytes(12).toString('hex')}`;
        codes.push(deviceCode);
        const user = randomBytes(4).toString('hex').toUpperCase().replace(/[^A-Z]/g, 'X');
        return send(200, {
          device_code: deviceCode,
          user_code: `${user.slice(0, 4)}-${user.slice(4, 8).padEnd(4, 'Q')}`,
          verification_url: fake.next.verificationUrl,
          expires_in: fake.next.expiresIn,
          interval: fake.next.interval,
        });
      }
      if (req.method === 'POST' && req.url === '/token') {
        tokenRequests.push(form);
        const code = form.get('device_code') ?? '';
        calls.set(code, (calls.get(code) ?? 0) + 1);
        if (form.get('client_id') !== FAKE_CLIENT_ID || form.get('client_secret') !== FAKE_CLIENT_SECRET) return send(401, { error: 'invalid_client' });
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code') return send(400, { error: 'unsupported_grant_type' });
        if (!codes.includes(code) || used.has(code)) return send(400, { error: 'invalid_grant' });
        const a = answers.get(code) ?? { kind: 'pending' };
        switch (a.kind) {
          case 'pending':
            return send(428, { error: 'authorization_pending', error_description: 'Precondition Required' });
          case 'slow_down':
            return send(403, { error: 'slow_down', error_description: 'Forbidden' });
          case 'denied':
            return send(403, { error: 'access_denied', error_description: 'Forbidden' });
          case 'expired':
            return send(400, { error: 'expired_token', error_description: 'Bad Request' });
          case 'error':
            return send(a.status, { error: a.error });
          case 'down':
            return send(500, 'Internal Server Error');
          case 'ok':
            used.add(code);
            return send(200, { access_token: 'ya29.fake-access', expires_in: 3599, token_type: 'Bearer', scope: 'openid email profile', id_token: signToken(baseClaims(a.claims), a.otherKey ? other : pair.privateKey) });
        }
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${port}`;
  fake.endpoints = { deviceCode: `${fake.url}/device/code`, token: `${fake.url}/token`, jwks: `${fake.url}/certs` };
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}
