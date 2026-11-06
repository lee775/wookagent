/**
 * 서버가 내주는 웹 화면 (리드 결정 S8-5, SERVER_DESIGN 3.4 '화면 파일'):
 * - 서버용 빌드 표시(`<meta name="wook-build" content="remote">`)가 없는 `--web-dir`은 시작하지 않는다 — 가짜 API로 도는 개발용 화면을 실제 주소에서 주지 않게
 * - HTML 응답에는 전체 CSP 머리, 해시 이름의 `assets/`는 1년 immutable, 그 밖은 no-cache와 강한 ETag + 304(GET·HEAD). ETag는 내용 해시다(S8-21 d) —
 *   크기가 같은 다시 빌드도, 바뀐 때가 같은 크기 바뀜도 새 태그이고, 같은 내용으로 다시 쓰면 태그가 그대로다
 * - 알림 서비스 워커 `/notify-sw.js`(S8-19): JavaScript, no-cache와 ETag, 페이지 CSP의 worker-src 'self' 아래. 없으면 index.html이 아니라 404
 * - 글·GLB는 Accept-Encoding: gzip이면 줄여 보낸다(다른 ETag, Vary). 이미 눌린 글꼴·작은 파일은 그대로. 파일이 바뀌면 새로 줄인다
 * - 서버용 빌드 검사(vite.web.config.ts의 remoteWebBuild): index.html 바꾸기와 결과 검사 — 가짜 브리지 모듈·글자, 루프백 CSP, 빌드 표시
 * - 디스크의 실제 경로(S8-26 c): 철자(대소문자)만 다른 요청도 그 파일과 같은 머리이고 캐시 자리를 늘리지 않는다. gzip·내용 태그 캐시는 수·크기 상한을 넘지
 *   않고, 차면 가장 오래 쓰지 않은 것을 빼서 새 파일도 줄여 보낸다
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptsGzip, createHttpSurface, etagMatches, isHashedAsset, type HttpSurface, type StaticCacheLimits } from '../../src/server/http';
import { startServer, ServerStartError, webDirNotRemoteMessage, type RunningServer } from '../../src/server/server';
import { FAKE_BRIDGE_MARKERS, hasWebBuildMarker, remoteBuildProblems, WEB_BUILD_MARKER, WEB_SCREEN_CSP, WEB_SCREEN_META_CSP } from '../../src/server/webScreen';
import type { ConfigEnv, Plugin, UserConfig } from 'vite';
import webConfig from '../../vite.web.config';
import { fakeServerBackend, fakeTopicBackend, memoryLogger, memorySessions, removeDir } from './helpers';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function get(url: string, path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const base = new URL(url);
  return new Promise((done, fail) => {
    const req = request({ host: base.hostname, port: Number(base.port), path, method: o.method ?? 'GET', headers: o.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

const INDEX = `<!doctype html><html><head>${WEB_BUILD_MARKER}<title>욱채</title></head><body><div id="root"></div>${'<!-- 채움 -->'.repeat(100)}</body></html>`;
const JS = `export const a = ${JSON.stringify('욱채 화면 '.repeat(600))};\n`;
const GLB = Buffer.concat(Array.from({ length: 400 }, (_, i) => Buffer.from(`glTF-vertex-${i % 7}-`)));
const FONT = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919 + 13) % 251));
/** 손으로 만든 알림 서비스 워커 (S8-19 — 화면 쪽이 src/renderer/public/notify-sw.js를 넣기 전까지). fetch 처리기·캐시·importScripts가 없다 */
const SW = `// 욱채 알림 서비스 워커 (시험용)\nself.addEventListener('notificationclick', (event) => {\n  event.notification.close();\n});\n`;

let base = '';
let web = '';
let server: RunningServer;
let fake: ReturnType<typeof fakeServerBackend>;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'wook-test-webstatic-'));
  web = join(base, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  mkdirSync(join(web, 'studio3d'));
  mkdirSync(join(base, 'data'));
  writeFileSync(join(web, 'index.html'), INDEX);
  writeFileSync(join(web, 'assets', 'index-AbCd12_-.js'), JS);
  writeFileSync(join(web, 'assets', 'plain.js'), JS);
  writeFileSync(join(web, 'assets', 'tiny-Qw3rTy12.js'), 'console.log(1)\n');
  writeFileSync(join(web, 'assets', 'Pretendard.subset.1-Zx9kLm2Q.woff2'), FONT);
  writeFileSync(join(web, 'studio3d', 'room.glb'), GLB);
  writeFileSync(join(web, 'notify-sw.js'), SW);
  fake = fakeServerBackend();
  server = await startServer({ backend: fake.backend, dataDir: join(base, 'data'), port: 0, webDir: web, allowTestSession: false, logger: memoryLogger(), version: 'test' });
}, 60_000);

afterAll(async () => {
  await server?.close();
  fake?.close();
  await removeDir(base);
});

describe('서버용 빌드 표시 (S8-5)', () => {
  it('표시가 없는 --web-dir은 운영자에게 까닭을 말하고 시작하지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-webdir-fake-'));
    try {
      // 가짜 API로 도는 예전 빌드의 index.html 모양 — 표시가 없다
      writeFileSync(
        join(dir, 'index.html'),
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*" /><script type="module" src="/assets/index-x.js"></script></head></html>`,
      );
      const started = startServer({ backend: fake.backend, dataDir: join(dir, 'data'), port: 0, webDir: dir, allowTestSession: false, logger: memoryLogger(), version: 'test' });
      await expect(started).rejects.toThrow(ServerStartError);
      await expect(started).rejects.toThrow(webDirNotRemoteMessage(dir));
      expect(webDirNotRemoteMessage(dir)).toBe(
        `--web-dir 폴더가 서버용 웹 화면이 아닙니다: ${dir} — index.html에 서버용 빌드 표시가 없어, 가짜 자료로 도는 개발용 화면일 수 있습니다. npm run build:web으로 다시 만든 out/web을 넘기세요`,
      );
    } finally {
      await removeDir(dir);
    }
  });

  it('표시는 빌드가 넣은 모양 그대로 찾는다 (따옴표·닫는 빗금은 어느 쪽이든)', () => {
    for (const ok of [WEB_BUILD_MARKER, `<meta name='wook-build' content='remote' />`, `<META NAME="wook-build"  CONTENT="remote"/>`]) expect(hasWebBuildMarker(`<head>${ok}</head>`), ok).toBe(true);
    for (const bad of ['', '<meta name="wook-build" content="demo">', '<meta name="wook-build">', '<!-- wook-build remote -->', '<meta content="remote" name="other">']) {
      expect(hasWebBuildMarker(`<head>${bad}</head>`), bad).toBe(false);
    }
  });
});

describe('HTML의 CSP 머리 (S8-5)', () => {
  it('화면(HTML)에는 전체 정책, 다른 파일은 예전 머리 그대로', async () => {
    for (const [path, method] of [
      ['/', 'GET'],
      ['/index.html', 'GET'],
      ['/settings', 'GET'],
      ['/projects/P-0001', 'HEAD'],
    ] as const) {
      const r = await get(server.url, path, { method });
      expect([r.status, r.headers['content-security-policy']], path).toEqual([200, WEB_SCREEN_CSP]);
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
    for (const path of ['/assets/index-AbCd12_-.js', '/studio3d/room.glb']) {
      expect((await get(server.url, path)).headers['content-security-policy'], path).toBe("frame-ancestors 'none'");
    }
  });

  it('정책: 같은 출처만, 루프백 주소 없음, 틀에 넣기·플러그인·base 막기. meta는 frame-ancestors만 뺀 같은 정책', () => {
    expect(WEB_SCREEN_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    expect(WEB_SCREEN_META_CSP).toBe(WEB_SCREEN_CSP.replace("; frame-ancestors 'none'", ''));
  });
});

describe('캐시 (S8-5)', () => {
  it('해시 이름의 assets/는 1년 immutable, 그 밖(index.html·해시 없는 파일·studio3d GLB)은 no-cache와 강한 ETag', async () => {
    const immutable = await get(server.url, '/assets/index-AbCd12_-.js');
    expect(immutable.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    for (const path of ['/', '/index.html', '/assets/plain.js', '/studio3d/room.glb']) {
      const r = await get(server.url, path);
      expect([r.status, r.headers['cache-control']], path).toEqual([200, 'no-cache']);
      expect(r.headers['etag'], path).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
    }
    expect(isHashedAsset(web, join(web, 'assets', 'index-AbCd12_-.js'))).toBe(true);
    expect(isHashedAsset(web, join(web, 'assets', 'Pretendard.subset.1-Zx9kLm2Q.woff2'))).toBe(true);
    for (const p of [join(web, 'assets', 'plain.js'), join(web, 'assets', 'a-short.js'), join(web, 'index.html'), join(web, 'studio3d', 'room-AbCd1234.glb')]) expect(isHashedAsset(web, p), p).toBe(false);
  });

  it('If-None-Match가 맞으면 GET·HEAD 모두 본문 없이 304 — 약한 표시(W/)·목록·*도 맞다. 파일이 바뀌면 ETag도 바뀐다', async () => {
    const first = await get(server.url, '/studio3d/room.glb');
    const etag = String(first.headers['etag']);
    expect(first.body.equals(GLB)).toBe(true);
    for (const [method, inm] of [
      ['GET', etag],
      ['HEAD', etag],
      ['GET', `W/${etag}`],
      ['GET', `"other", ${etag}`],
      ['GET', '*'],
    ] as const) {
      const r = await get(server.url, '/studio3d/room.glb', { method, headers: { 'If-None-Match': inm } });
      expect([r.status, r.body.length, r.headers['etag'], r.headers['cache-control']], `${method} ${inm}`).toEqual([304, 0, etag, 'no-cache']);
    }
    const miss = await get(server.url, '/studio3d/room.glb', { headers: { 'If-None-Match': '"nope"' } });
    expect([miss.status, miss.body.equals(GLB)]).toEqual([200, true]);
    // 화면 경로(index.html로 가는 것)도 index.html의 ETag로 304
    const page = await get(server.url, '/');
    expect((await get(server.url, '/projects/P-0001', { headers: { 'If-None-Match': String(page.headers['etag']) } })).status).toBe(304);
    // 바뀐 파일은 옛 ETag로 304가 아니다
    const file = join(web, 'studio3d', 'room.glb');
    const changed = Buffer.concat([GLB, Buffer.from('more')]);
    writeFileSync(file, changed);
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const after = await get(server.url, '/studio3d/room.glb', { headers: { 'If-None-Match': etag } });
    expect([after.status, after.body.equals(changed)]).toEqual([200, true]);
    expect(after.headers['etag']).not.toBe(etag);
    writeFileSync(file, GLB);
  });

  it('ETag는 내용 해시 — 크기가 같은 다시 빌드는 새 태그와 새 내용(그대로·gzip 모두), 같은 내용으로 다시 쓰면 태그가 그대로다 (S8-21 d)', async () => {
    const file = join(web, 'same-size.json');
    const one = JSON.stringify({ build: 'A', fill: 'a'.repeat(3000) });
    const two = JSON.stringify({ build: 'B', fill: 'b'.repeat(3000) });
    expect(two.length).toBe(one.length);
    writeFileSync(file, one);
    utimesSync(file, new Date(), new Date(Date.now() - 60_000));
    const plain1 = await get(server.url, '/same-size.json');
    const gz1 = await get(server.url, '/same-size.json', { headers: { 'Accept-Encoding': 'gzip' } });
    expect([plain1.body.toString(), gunzipSync(gz1.body).toString()]).toEqual([one, one]);
    // 다시 빌드 — 같은 크기, 다른 내용, 뒤의 바뀐 때
    writeFileSync(file, two);
    utimesSync(file, new Date(), new Date(Date.now() + 60_000));
    const plain2 = await get(server.url, '/same-size.json', { headers: { 'If-None-Match': String(plain1.headers['etag']) } });
    expect([plain2.status, plain2.body.toString()]).toEqual([200, two]);
    expect(plain2.headers['etag']).not.toBe(plain1.headers['etag']);
    const gz2 = await get(server.url, '/same-size.json', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': String(gz1.headers['etag']) } });
    expect([gz2.status, gz2.headers['content-encoding']]).toEqual([200, 'gzip']);
    expect(gunzipSync(gz2.body).toString()).toBe(two);
    expect(gz2.headers['etag']).not.toBe(gz1.headers['etag']);
    // 같은 내용으로 다시 쓰면(바뀐 때만 다름) 태그가 같다 — 브라우저가 받아 둔 것을 그대로 쓴다
    writeFileSync(file, two);
    utimesSync(file, new Date(), new Date(Date.now() + 120_000));
    expect((await get(server.url, '/same-size.json', { headers: { 'If-None-Match': String(plain2.headers['etag']) } })).status).toBe(304);
    expect((await get(server.url, '/same-size.json', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': String(gz2.headers['etag']) } })).status).toBe(304);
  });

  it('바뀐 때가 같아도 크기가 바뀌면 새 태그와 새 내용이다 (그대로·gzip 모두)', async () => {
    const file = join(web, 'same-mtime.json');
    const at = new Date(Date.now() - 3_600_000);
    const one = JSON.stringify({ build: 'A', fill: 'a'.repeat(3000) });
    const two = JSON.stringify({ build: 'B', fill: 'b'.repeat(4000) });
    writeFileSync(file, one);
    utimesSync(file, at, at);
    const mtime1 = statSync(file).mtimeMs;
    const plain1 = await get(server.url, '/same-mtime.json');
    const gz1 = await get(server.url, '/same-mtime.json', { headers: { 'Accept-Encoding': 'gzip' } });
    expect([plain1.body.toString(), gunzipSync(gz1.body).toString()]).toEqual([one, one]);
    writeFileSync(file, two);
    utimesSync(file, at, at);
    expect(statSync(file).mtimeMs).toBe(mtime1);
    const plain2 = await get(server.url, '/same-mtime.json', { headers: { 'If-None-Match': String(plain1.headers['etag']) } });
    expect([plain2.status, plain2.body.toString()]).toEqual([200, two]);
    expect(plain2.headers['etag']).not.toBe(plain1.headers['etag']);
    const gz2 = await get(server.url, '/same-mtime.json', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': String(gz1.headers['etag']) } });
    expect(gz2.status).toBe(200);
    expect(gunzipSync(gz2.body).toString()).toBe(two);
    expect(gz2.headers['etag']).not.toBe(gz1.headers['etag']);
  });

  it('etagMatches: GET·HEAD의 약한 비교', () => {
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches(' "x" , W/"a" ', '"a"')).toBe(true);
    expect(etagMatches('*', '"a"')).toBe(true);
    for (const h of [undefined, '', '"b"', '"a-gz"', 'a']) expect(etagMatches(h, '"a"'), String(h)).toBe(false);
  });
});

describe('gzip (S8-5 — 재어 보고 정함)', () => {
  it('글·GLB는 gzip을 받는 요청에 줄여 보내고 다른 ETag·Vary를 단다 — 받지 않으면 그대로', async () => {
    for (const [path, raw] of [
      ['/assets/index-AbCd12_-.js', Buffer.from(JS)],
      ['/studio3d/room.glb', GLB],
      ['/', Buffer.from(INDEX)],
    ] as const) {
      const gz = await get(server.url, path, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
      expect([gz.status, gz.headers['content-encoding'], gz.headers['vary']], path).toEqual([200, 'gzip', 'Accept-Encoding']);
      expect(Number(gz.headers['content-length']), path).toBe(gz.body.length);
      expect(gz.body.length, path).toBeLessThan(raw.length * 0.6);
      expect(gunzipSync(gz.body).equals(raw), path).toBe(true);
      expect(String(gz.headers['etag']), path).toMatch(/-gz"$/);
      const plain = await get(server.url, path);
      expect([plain.headers['content-encoding'], plain.headers['vary'], plain.body.equals(raw)], path).toEqual([undefined, 'Accept-Encoding', true]);
      expect(plain.headers['etag']).not.toBe(gz.headers['etag']);
      // 줄인 표현의 ETag로 묻으면 304
      expect((await get(server.url, path, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': String(gz.headers['etag']) } })).status, path).toBe(304);
    }
  });

  it('HEAD는 줄인 크기를 알리고 본문이 없다', async () => {
    const gz = await get(server.url, '/assets/index-AbCd12_-.js', { headers: { 'Accept-Encoding': 'gzip' } });
    const head = await get(server.url, '/assets/index-AbCd12_-.js', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
    expect([head.status, head.headers['content-encoding'], Number(head.headers['content-length']), head.body.length]).toEqual([200, 'gzip', gz.body.length, 0]);
  });

  it('이미 눌린 글꼴·1KB보다 작은 파일·gzip을 거절한 요청은 그대로', async () => {
    const font = await get(server.url, '/assets/Pretendard.subset.1-Zx9kLm2Q.woff2', { headers: { 'Accept-Encoding': 'gzip' } });
    expect([font.headers['content-encoding'], font.headers['vary'], font.body.equals(FONT)]).toEqual([undefined, undefined, true]);
    const tiny = await get(server.url, '/assets/tiny-Qw3rTy12.js', { headers: { 'Accept-Encoding': 'gzip' } });
    expect([tiny.headers['content-encoding'], tiny.body.toString()]).toEqual([undefined, 'console.log(1)\n']);
    for (const ae of ['gzip;q=0', 'br', 'identity', 'identity;q=1, *;q=0']) {
      const r = await get(server.url, '/assets/index-AbCd12_-.js', { headers: { 'Accept-Encoding': ae } });
      expect([r.headers['content-encoding'], r.body.toString()], ae).toEqual([undefined, JS]);
    }
  });

  it('acceptsGzip: gzip·x-gzip·*의 q를 본다', () => {
    for (const yes of ['gzip', 'GZIP', 'deflate, gzip;q=0.5', 'x-gzip', '*', 'br;q=1, *;q=0.1']) expect(acceptsGzip(yes), yes).toBe(true);
    for (const no of [undefined, '', 'br', 'gzip;q=0', 'gzip;q=0.0, *', '*;q=0', 'identity', 'gzip;q=abc']) expect(acceptsGzip(no), String(no)).toBe(false);
  });

  it('파일이 바뀌면 새로 줄인다 — 옛 내용을 주지 않는다', async () => {
    const file = join(web, 'assets', 'plain.js');
    const first = await get(server.url, '/assets/plain.js', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(gunzipSync(first.body).toString()).toBe(JS);
    const next = `${JS}// 바뀜 ${'x'.repeat(50)}\n`;
    writeFileSync(file, next);
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    const second = await get(server.url, '/assets/plain.js', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(gunzipSync(second.body).toString()).toBe(next);
    expect(second.headers['etag']).not.toBe(first.headers['etag']);
  });
});

describe('알림 서비스 워커 /notify-sw.js (S8-19)', () => {
  it('JavaScript로, no-cache와 강한 ETag, 화면과 같은 전체 CSP 머리로 준다(S8-23 2) — 304도 된다. 페이지 CSP가 같은 출처의 워커를 허락한다', async () => {
    const r = await get(server.url, '/notify-sw.js');
    expect([r.status, r.headers['content-type'], r.headers['cache-control'], r.body.toString()]).toEqual([200, 'text/javascript; charset=utf-8', 'no-cache', SW]);
    expect(String(r.headers['etag'])).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    // 워커의 정책은 그 스크립트 응답 머리에서 온다 — 다른 출처에 묻거나 스크립트를 불러오지 못한다. 다른 JS는 예전 머리 그대로다
    expect(r.headers['content-security-policy']).toBe(WEB_SCREEN_CSP);
    expect((await get(server.url, '/assets/plain.js')).headers['content-security-policy']).toBe("frame-ancestors 'none'");
    const again = await get(server.url, '/notify-sw.js', { headers: { 'If-None-Match': String(r.headers['etag']) } });
    expect([again.status, again.body.length, again.headers['content-security-policy']]).toEqual([304, 0, WEB_SCREEN_CSP]);
    const head = await get(server.url, '/notify-sw.js', { method: 'HEAD' });
    expect([head.status, Number(head.headers['content-length']), head.body.length]).toEqual([200, Buffer.byteLength(SW), 0]);
    // 등록하는 화면(HTML)의 CSP: worker-src 'self' — 같은 출처의 이 파일을 워커로 쓴다
    const page = await get(server.url, '/');
    expect(String(page.headers['content-security-policy']).split('; ')).toContain("worker-src 'self' blob:");
  });

  it('없는 워커 파일은 index.html이 아니라 404다 — 화면 HTML을 워커로 등록하지 않게', async () => {
    const r = await get(server.url, '/missing-sw.js');
    expect([r.status, String(r.headers['content-type'])]).toEqual([404, 'text/plain; charset=utf-8']);
    expect(r.body.toString()).not.toContain('<html');
  });
});

/** 화면 폴더 하나를 내주는 HTTP 표면 — 캐시에 담긴 수를 본다 (S8-26 c) */
async function surfaceRig(webDir: string, staticCache?: Partial<StaticCacheLimits>): Promise<{ url: string; surface: HttpSurface; close(): Promise<void> }> {
  const fakeTopics = fakeTopicBackend();
  const mem = memorySessions();
  let port = 0;
  const surface = createHttpSurface({ backend: fakeTopics.backend, sessions: mem.sessions, logger: memoryLogger(), runId: 'run-시험', port: () => port, webDir, ...(staticCache ? { staticCache } : {}) });
  const http = createServer((req, res) => surface.handle(req, res));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  port = (http.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    surface,
    close: async () => {
      surface.dispose();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      mem.close();
    },
  };
}

/** 경로의 글자 대소문자를 바꾼 것들 (원래 철자는 빼고, 앞에서부터 n개) */
function caseVariants(path: string, n: number): string[] {
  const letters = [...path].map((c, i) => (c.toLowerCase() !== c.toUpperCase() ? i : -1)).filter((i) => i >= 0);
  const out: string[] = [];
  for (let mask = 1; out.length < n && mask < 1 << Math.min(letters.length, 20); mask++) {
    const chars = [...path];
    letters.forEach((at, bit) => {
      if (mask & (1 << bit)) chars[at] = chars[at] === chars[at]!.toLowerCase() ? chars[at]!.toUpperCase() : chars[at]!.toLowerCase();
    });
    const v = chars.join('');
    if (v !== path && !out.includes(v)) out.push(v);
  }
  return out;
}

describe('디스크의 실제 경로와 캐시 상한 (S8-26 c)', () => {
  const pick = (r: Reply) => ({
    status: r.status,
    type: r.headers['content-type'],
    csp: r.headers['content-security-policy'],
    cache: r.headers['cache-control'],
    etag: r.headers['etag'],
    enc: r.headers['content-encoding'],
    nosniff: r.headers['x-content-type-options'],
  });

  it('철자(대소문자)만 다른 요청도 디스크의 그 파일과 같은 머리(CSP·캐시·형식·ETag)다 — 대소문자를 가리는 파일 시스템이면 404', async () => {
    // 이 PC(Windows)는 대소문자를 가리지 않는다 — 같은 파일이 열린다
    const insensitive = existsSync(join(web, 'NOTIFY-SW.JS'));
    if (process.platform === 'win32') expect(insensitive).toBe(true);
    const rows: [string, string[]][] = [
      ['/notify-sw.js', ['/NOTIFY-SW.JS', '/Notify-Sw.js', '/notify-sw.JS']],
      ['/index.html', ['/INDEX.HTML', '/Index.html']],
      ['/assets/index-AbCd12_-.js', ['/ASSETS/index-AbCd12_-.js', '/assets/INDEX-ABCD12_-.JS']],
      ['/studio3d/room.glb', ['/STUDIO3D/ROOM.GLB', '/Studio3d/room.glb']],
    ];
    for (const [path, variants] of rows) {
      for (const enc of [{}, { 'Accept-Encoding': 'gzip' }] as Record<string, string>[]) {
        const want = pick(await get(server.url, path, { headers: enc }));
        expect(want.status, path).toBe(200);
        for (const v of variants) {
          const got = await get(server.url, v, { method: 'HEAD', headers: enc });
          if (insensitive) expect(pick(got), `${v} ${JSON.stringify(enc)}`).toEqual(want);
          else expect(got.status, v).toBe(404);
        }
      }
    }
    // 워커는 철자가 달라도 페이지 CSP다 (S8-23 2)
    if (insensitive) expect((await get(server.url, '/NOTIFY-SW.JS')).headers['content-security-policy']).toBe(WEB_SCREEN_CSP);
  });

  it.runIf(process.platform === 'win32')('--web-dir을 다른 대소문자로 적어도(Windows) 화면 파일을 그 머리 그대로 준다 — 폴더도 디스크의 철자로 푼다', async () => {
    const r = await surfaceRig(web.toUpperCase());
    try {
      const sw = await get(r.url, '/notify-sw.js');
      expect([sw.status, sw.headers['content-security-policy'], sw.body.toString()]).toEqual([200, WEB_SCREEN_CSP, SW]);
      const asset = await get(r.url, '/assets/index-AbCd12_-.js');
      expect([asset.status, asset.headers['cache-control']]).toEqual([200, 'public, max-age=31536000, immutable']);
      expect((await get(r.url, '/')).status).toBe(200);
    } finally {
      await r.close();
    }
  });

  it('철자만 다른 요청을 많이 보내도(세션 없는 HEAD) gzip·태그 캐시는 파일마다 한 자리다', async () => {
    const r = await surfaceRig(web);
    try {
      const glb = '/studio3d/room.glb';
      await get(r.url, glb, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
      const one = r.surface.staticCacheStats();
      expect(one).toEqual({ gzipFiles: 1, gzipBytes: statSync(join(web, 'studio3d', 'room.glb')).size, tagFiles: 1 });
      const variants = caseVariants(glb, 24);
      expect(variants).toHaveLength(24);
      for (const v of variants) {
        const h = await get(r.url, v, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
        expect(h.status === 200 || h.status === 404, v).toBe(true);
      }
      expect(r.surface.staticCacheStats()).toEqual(one);
    } finally {
      await r.close();
    }
  });

  it('gzip·태그 캐시는 수와 크기 상한을 넘지 않고, 차면 가장 오래 쓰지 않은 것을 빼서 새 파일도 줄여 보낸다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-webcache-'));
    try {
      writeFileSync(join(dir, 'index.html'), INDEX);
      const big = Array.from({ length: 4 }, (_, i) => [`big-${i}.json`, JSON.stringify({ i, fill: String(i).repeat(20_000) })] as const);
      const small = Array.from({ length: 5 }, (_, i) => [`small-${i}.json`, JSON.stringify({ i, fill: 's'.repeat(2_000) })] as const);
      for (const [name, text] of [...big, ...small]) writeFileSync(join(dir, name), text);
      const bigSize = Buffer.byteLength(big[0]![1]);
      const smallSize = Buffer.byteLength(small[0]![1]);
      const limits: StaticCacheLimits = { gzipFiles: 3, gzipBytes: 50_000, tagFiles: 4 };
      const r = await surfaceRig(dir, limits);
      try {
        const fetchGz = async (name: string, text: string) => {
          const g = await get(r.url, `/${name}`, { headers: { 'Accept-Encoding': 'gzip' } });
          // 상한이 찼다고 그대로(줄이지 않고) 보내지 않는다
          expect([g.status, g.headers['content-encoding']], name).toEqual([200, 'gzip']);
          expect(gunzipSync(g.body).toString(), name).toBe(text);
          const s = r.surface.staticCacheStats();
          expect(s.gzipFiles <= limits.gzipFiles && s.gzipBytes <= limits.gzipBytes && s.tagFiles <= limits.tagFiles, `${name} ${JSON.stringify(s)}`).toBe(true);
          return s;
        };
        for (const [name, text] of big) await fetchGz(name, text);
        // 크기가 묶는다 — 20KB 둘까지 (셋이면 50KB를 넘는다). 태그는 넷
        expect(r.surface.staticCacheStats()).toEqual({ gzipFiles: 2, gzipBytes: 2 * bigSize, tagFiles: 4 });
        for (const [name, text] of small) await fetchGz(name, text);
        // 수가 묶는다 — 작은 것 셋
        expect(r.surface.staticCacheStats()).toEqual({ gzipFiles: 3, gzipBytes: 3 * smallSize, tagFiles: 4 });
        // 빠졌던 파일도 다시 줄여 보낸다
        expect(await fetchGz(big[0]![0], big[0]![1])).toEqual({ gzipFiles: 3, gzipBytes: bigSize + 2 * smallSize, tagFiles: 4 });
      } finally {
        await r.close();
      }
    } finally {
      await removeDir(dir);
    }
  });
});

/** 웹 빌드 설정을 그 mode로 부른 결과 */
const configFor = (mode: string): UserConfig => (webConfig as unknown as (env: ConfigEnv) => UserConfig)({ mode, command: 'build', isSsrBuild: false, isPreview: false });
const remotePlugin = (config: UserConfig): Plugin | undefined => (config.plugins ?? []).flat().find((p): p is Plugin => !!p && typeof p === 'object' && 'name' in p && p.name === 'wook-remote-web-build');

describe('웹 빌드 설정 (S8-5)', () => {
  it('mode remote(npm run build:web)만 서버용 검사를 걸고 out/web에 만든다 — 그 밖의 빌드는 out/web-demo', () => {
    const remote = configFor('remote');
    expect(remotePlugin(remote)).toBeDefined();
    expect(remote.build?.outDir).toBe(resolve('out/web'));
    for (const mode of ['production', 'development']) {
      const other = configFor(mode);
      expect(remotePlugin(other), mode).toBeUndefined();
      expect(other.build?.outDir, mode).toBe(resolve('out/web-demo'));
    }
    expect(readFileSync(resolve('src/renderer/.env.remote'), 'utf8')).toMatch(/^VITE_WOOK_REMOTE=1$/m);
    expect(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts['build:web']).toBe('vite build --config vite.web.config.ts --mode remote');
  });
});

describe('서버용 빌드 검사 (vite.web.config.ts remoteWebBuild — S8-4·S8-5)', () => {
  const plugin = remotePlugin(configFor('remote'))!;
  const transform = (html: string): string => (plugin.transformIndexHtml as { handler: (html: string) => string }).handler(html);
  type Bundle = Record<string, { type: 'chunk'; fileName: string; code: string; moduleIds: string[] } | { type: 'asset'; fileName: string; source: string }>;
  const check = (bundle: Bundle): void => {
    const hook = plugin.generateBundle as { handler: (this: { error(m: string): never }, options: unknown, bundle: Bundle) => void };
    hook.handler.call(
      {
        error(m: string): never {
          throw new Error(m);
        },
      },
      {},
      bundle,
    );
  };
  const fakeDir = resolve('src/renderer/src/api/fake');
  const srcHtml = readFileSync(resolve('src/renderer/index.html'), 'utf8');

  it('index.html: 데스크톱의 루프백 CSP를 서버용 정책으로 바꾸고 빌드 표시를 넣는다 — 원본(데스크톱)은 그대로다', () => {
    expect(srcHtml).toContain('ws://127.0.0.1:*');
    const out = transform(srcHtml);
    expect(hasWebBuildMarker(out)).toBe(true);
    expect(out).toContain(`content="${WEB_SCREEN_META_CSP}"`);
    expect(out).not.toMatch(/127\.0\.0\.1|ws:\/\//);
    expect(remoteBuildProblems({ html: out, chunks: [], fakeDir })).toEqual([]);
    expect(() => transform('<html><head></head></html>')).toThrow('CSP meta가 하나여야');
  });

  it('결과에 가짜 브리지 모듈이나 그 글자가 있거나 index.html이 어긋나면 빌드를 실패시킨다', () => {
    const html = { type: 'asset' as const, fileName: 'index.html', source: transform(srcHtml) };
    const clean = { type: 'chunk' as const, fileName: 'assets/index-a.js', code: 'console.log("화면")', moduleIds: [resolve('src/renderer/src/main.tsx')] };
    expect(() => check({ 'index.html': html, [clean.fileName]: clean })).not.toThrow();
    const withModule = { ...clean, fileName: 'assets/fake-b.js', moduleIds: [join(fakeDir, 'index.ts')] };
    expect(() => check({ 'index.html': html, [withModule.fileName]: withModule })).toThrow(/가짜 브리지 모듈.*fake\/index\.ts/);
    for (const marker of FAKE_BRIDGE_MARKERS) {
      const withText = { ...clean, fileName: 'assets/app-c.js', code: `const n = ${JSON.stringify(marker)};` };
      expect(() => check({ 'index.html': html, [withText.fileName]: withText }), marker).toThrow('가짜 브리지의 글자');
    }
    expect(() => check({ 'index.html': { ...html, source: srcHtml }, [clean.fileName]: clean })).toThrow(/빌드 표시.*루프백|루프백/s);
    expect(() => check({ [clean.fileName]: clean })).toThrow('index.html이 빌드 결과에 없습니다');
  });

  it('빌드 표시 검사는 따로 선다 — 서버용 CSP meta는 맞는데 표시만 없어도 그 까닭으로 실패한다', () => {
    const noMarker = transform(srcHtml).replace(WEB_BUILD_MARKER, '');
    expect(noMarker).toContain(`content="${WEB_SCREEN_META_CSP}"`);
    expect(hasWebBuildMarker(noMarker)).toBe(false);
    expect(remoteBuildProblems({ html: noMarker, chunks: [], fakeDir })).toEqual([`index.html에 서버용 빌드 표시(${WEB_BUILD_MARKER})가 없습니다`]);
    const clean = { type: 'chunk' as const, fileName: 'assets/index-a.js', code: 'console.log("화면")', moduleIds: [resolve('src/renderer/src/main.tsx')] };
    expect(() => check({ 'index.html': { type: 'asset', fileName: 'index.html', source: noMarker }, [clean.fileName]: clean })).toThrow(`index.html에 서버용 빌드 표시(${WEB_BUILD_MARKER})가 없습니다`);
  });

  it('public의 알림 서비스 워커(notify-sw.js)는 검사에 걸리지 않는다 (S8-19)', () => {
    const html = { type: 'asset' as const, fileName: 'index.html', source: transform(srcHtml) };
    const sw = { type: 'asset' as const, fileName: 'notify-sw.js', source: SW };
    expect(() => check({ 'index.html': html, 'notify-sw.js': sw })).not.toThrow();
  });

  const realSw = resolve('src/renderer/public/notify-sw.js');
  it.skipIf(!existsSync(realSw))('화면 쪽의 notify-sw.js: 가짜 브리지 글자·fetch 처리기·캐시·importScripts가 없다 (S8-19)', () => {
    const text = readFileSync(realSw, 'utf8');
    expect(remoteBuildProblems({ html: transform(srcHtml), chunks: [{ fileName: 'notify-sw.js', code: text, moduleIds: [] }], fakeDir })).toEqual([]);
    expect(text).not.toMatch(/addEventListener\(\s*['"]fetch['"]|\bonfetch\b|importScripts|\bcaches\./);
  });

  it('가짜 브리지에만 있는 글자는 지금 가짜 브리지 소스에 있다 — 지우면 이 검사를 고쳐야 한다', () => {
    const source = ['index.ts', 'data.ts'].map((f) => readFileSync(join(fakeDir, f), 'utf8')).join('\n');
    for (const marker of FAKE_BRIDGE_MARKERS) expect(source, marker).toContain(marker);
  });
});
