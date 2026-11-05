/**
 * 업로드와 내려받기 (리드 결정 S3-10, SERVER_DESIGN 3.4 '파일'·3.7·9.2): 서버 모드 백엔드를 연 프로세스 안 서버.
 * - `POST /api/uploads`: 50MB까지(머리의 크기로 먼저, 흘려 받으면서 다시 센다), `<dataDir>/uploads/`, 그 기기 세션의 uploadId. 넘으면 413이고 남는 파일이 없다
 * - 원격 명령의 첨부는 uploadId만 — 서버 PC의 파일 경로(path)는 400 invalid이고 아무것도 만들지 않는다. 다른 기기가 올렸거나 24시간이 지난 업로드는 404
 * - `GET /api/attachments/:id`·`/api/reports/:id/file`·`/api/exports/:name`·`/api/screens/:id`: 살아 있는 기기 세션만, 실제 경로가 그 폴더 안일 때만
 *   (경로 탈출·심볼릭 링크·접합, 그 폴더 이름으로 시작하는 옆 폴더, 보고서 폴더 밖의 데이터 폴더 파일은 404 — S3-30), 늘 내려받기(Content-Disposition attachment,
 *   샌드박스 CSP) — HTML은 바이트로만. 업로드 ID는 모양 전체를 본다('../'를 붙인 ID는 없는 업로드 — S3-30)
 * - 올린 파일은 24시간 뒤 지운다(sweep — 서버가 시작 때와 1시간마다). 데스크톱의 경로 첨부는 그대로다
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment } from '@shared/domain';
import { createHarness } from '../e2e/harness';
import { REMOTE_PATH_REFUSED, UPLOAD_GONE, UPLOAD_MAX_BYTES } from '../../src/main/orchestrator/serverFiles';
import { startServer } from '../../src/server/server';
import { SESSION_COOKIE } from '../../src/server/sessions';
import { fakeServerBackend, httpCall, invokeHttp, memoryLogger, removeDir, sleep, type HttpResult } from './helpers';
import { ownerServer, type OwnerServer } from './ownerServer';

let s: OwnerServer;
const dirs: string[] = [];

beforeAll(async () => {
  s = await ownerServer();
}, 120_000);

afterAll(async () => {
  await s?.close();
  for (const d of dirs) await removeDir(d);
});

const bearer = (token = s.token) => ({ Authorization: `Bearer ${token}` });
const upload = (body: Buffer | string, name: string, headers: Record<string, string> = bearer()) =>
  httpCall({ url: s.server.url, path: `/api/uploads?name=${encodeURIComponent(name)}`, method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body });
const uploadId = (r: HttpResult) => r.json<{ value: { uploadId: string } }>().value.uploadId;
const uploadsDir = () => join(s.h.dataDir, 'uploads');
const ownerCommands = () => s.h.core.ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'owner');
const get = (path: string, headers: Record<string, string> = bearer()) => httpCall({ url: s.server.url, path, headers });
const code = (r: HttpResult) => r.json<{ error?: { code: string } }>().error?.code;

describe('업로드와 원격 명령의 첨부 (S3-10)', () => {
  it('올린 파일을 uploadId로 명령에 붙이면 그 내용이 첨부로 저장되고 내려받을 수 있다', async () => {
    const bytes = Buffer.from('첨부 내용 — 서버로 올린 파일 3e1f\n', 'utf8');
    const r = await upload(bytes, '회의 메모.txt');
    expect(r.status).toBe(200);
    const value = r.json<{ ok: true; value: { uploadId: string; name: string; size: number; expiresAt: string } }>().value;
    expect(value).toMatchObject({ uploadId: expect.stringMatching(/^up_[0-9a-f]{32}$/), name: '회의 메모.txt', size: bytes.length });
    expect(Date.parse(value.expiresAt) - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(readFileSync(join(uploadsDir(), value.uploadId))).toEqual(bytes);
    const sent = await invokeHttp(s.server.url, s.token, 'command.send', [{ target: 'main', text: '메모를 보고 정리해 줘', attachments: [{ name: '회의 메모.txt', uploadId: value.uploadId }] }]);
    expect(sent.status).toBe(200);
    const att = ownerCommands().find((m) => m.text === '메모를 보고 정리해 줘')!.attachments[0] as Attachment;
    expect(att).toMatchObject({ name: '회의 메모.txt', size: bytes.length });
    expect(readFileSync(att.path)).toEqual(bytes);
    const down = await get(`/api/attachments/${att.id}`);
    expect(down.status).toBe(200);
    expect(down.text).toBe(bytes.toString('utf8'));
    expect(down.headers['content-disposition']).toBe(`attachment; filename="__ __.txt"; filename*=UTF-8''${encodeURIComponent('회의 메모.txt')}`);
    expect([down.headers['content-type'], down.headers['x-content-type-options'], down.headers['content-security-policy']]).toEqual([
      'application/octet-stream',
      'nosniff',
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    ]);
  });

  it('원격 명령에 서버 PC의 파일 경로를 붙이면 400 invalid이고 아무것도 만들지 않는다 — 데스크톱의 경로 첨부는 그대로', async () => {
    const before = ownerCommands().length;
    const attachmentsBefore = readdirSync(s.h.core.ctx.paths.attachments).length;
    const r = await invokeHttp(s.server.url, s.token, 'command.send', [{ target: 'main', text: 'DB를 붙여 보냄', attachments: [{ name: 'wook.db', path: s.h.core.ctx.paths.db }] }]);
    expect([r.status, r.json()]).toEqual([400, { ok: false, error: { code: 'invalid', message: REMOTE_PATH_REFUSED } }]);
    expect(ownerCommands().length).toBe(before);
    expect(readdirSync(s.h.core.ctx.paths.attachments).length).toBe(attachmentsBefore);
    // 데스크톱 앱(호출자 없는 데스크톱 길)은 이 PC의 화면이 고른 파일을 경로로 붙인다 — 예전 그대로
    const desk = await createHarness({ noProject: true });
    try {
      const file = join(desk.dataDir, '붙일 파일.txt');
      writeFileSync(file, '데스크톱 첨부');
      await desk.invoke('command.send', { target: 'main', text: '데스크톱 첨부 명령', attachments: [{ name: '붙일 파일.txt', path: file }] });
      const msg = desk.core.ctx.store.conversation.list({ ref1: 'main' }).find((m) => m.text === '데스크톱 첨부 명령')!;
      expect(readFileSync((msg.attachments[0] as Attachment).path, 'utf8')).toBe('데스크톱 첨부');
    } finally {
      await desk.close();
    }
  });

  it('다른 기기가 올린 업로드·없는 업로드·24시간이 지난 업로드는 404이고 명령이 들어가지 않는다', async () => {
    const tablet = s.issue('태블릿');
    const mine = uploadId(await upload('내 파일', 'a.txt'));
    const before = ownerCommands().length;
    const send = (token: string, id: string) => invokeHttp(s.server.url, token, 'command.send', [{ target: 'main', text: '남의 업로드', attachments: [{ name: 'a.txt', uploadId: id }] }]);
    for (const [token, id] of [
      [tablet.token, mine],
      [s.token, 'up_00000000000000000000000000000000'],
    ] as const) {
      const r = await send(token, id);
      expect([r.status, r.json()]).toEqual([404, { ok: false, error: { code: 'not_found', message: UPLOAD_GONE } }]);
    }
    const old = uploadId(await upload('오래된 파일', 'old.txt'));
    const meta = join(uploadsDir(), `${old}.json`);
    writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    expect((await send(s.token, old)).status).toBe(404);
    expect(ownerCommands().length).toBe(before);
  });

  it('50MB를 넘으면 413 — 머리의 크기로 먼저 거부하고, 흘려 보낸 본문도 받으면서 세어 끊는다. 남는 파일이 없다', async () => {
    const files = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []);
    const before = files().length;
    const declared = await new Promise<number>((resolveIt, reject) => {
      const req = request({ host: '127.0.0.1', port: s.server.port, path: '/api/uploads?name=big.bin', method: 'POST', headers: { ...bearer(), 'Content-Length': String(UPLOAD_MAX_BYTES + 1) } }, (res) => {
        res.resume();
        resolveIt(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('x');
    });
    expect(declared).toBe(413);
    // 길이를 알리지 않고(chunked) 50MB + 1바이트를 흘려 보낸다
    const streamed = await new Promise<number>((resolveIt) => {
      const req = request({ host: '127.0.0.1', port: s.server.port, path: '/api/uploads?name=big.bin', method: 'POST', headers: { ...bearer(), 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolveIt(res.statusCode ?? 0);
      });
      req.on('error', () => resolveIt(-1));
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const pump = (): void => {
        while (sent <= UPLOAD_MAX_BYTES) {
          const piece = sent + chunk.length > UPLOAD_MAX_BYTES + 1 ? chunk.subarray(0, UPLOAD_MAX_BYTES + 1 - sent) : chunk;
          sent += piece.length;
          if (!req.write(piece)) return void req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    expect(streamed).toBe(413);
    await sleep(200);
    expect(files().length).toBe(before);
    expect(files().filter((f) => f.endsWith('.part'))).toEqual([]);
  }, 60_000);

  it('세션 없이는 401, 쿠키로 올리면 X-Wook-Client와 허용 Origin이 있어야 한다, 한 기기가 동시에 올리는 파일은 3개까지', async () => {
    expect((await upload('x', 'a.txt', {})).status).toBe(401);
    const cookie = { Cookie: `${SESSION_COOKIE}=${s.token}` };
    expect(code(await upload('x', 'a.txt', cookie))).toBe('forbidden_origin');
    expect((await upload('x', 'a.txt', { ...cookie, 'X-Wook-Client': '1', Origin: `http://127.0.0.1:${s.server.port}` })).status).toBe(200);
    // 끝내지 않은 업로드 셋을 열어 둔다
    const open = Array.from({ length: 3 }, () => {
      const req = request({ host: '127.0.0.1', port: s.server.port, path: '/api/uploads?name=slow.bin', method: 'POST', headers: { ...bearer(), 'Transfer-Encoding': 'chunked' } });
      req.on('error', () => undefined);
      req.write('조금');
      return req;
    });
    await sleep(200);
    const fourth = await upload('x', 'b.txt');
    expect([fourth.status, code(fourth)]).toEqual([429, 'rate_limited']);
    expect((await upload('x', 'c.txt', bearer(s.issue('다른 기기').token))).status).toBe(200);
    for (const req of open) req.destroy();
    await sleep(200);
    expect((await upload('x', 'd.txt')).status).toBe(200);
  });
});

describe('내려받기 (S3-10)', () => {
  it('보고서 파일과 내보내기를 내려받는다 — 화면 캡처는 아직 없다(404). 세션 없이는 401', async () => {
    await s.h.main('submit_report', { title: '내려받기 시험 보고', summary: '요약', results: '결과', changed_files: [], how_to_verify: '확인', issues: '', next_steps: '' });
    const report = s.h.core.ctx.store.reports.list().find((r) => r.title === '내려받기 시험 보고')!;
    const file = await get(`/api/reports/${report.id}/file`);
    expect(file.status).toBe(200);
    expect(file.text).toBe(readFileSync(report.filePath, 'utf8'));
    const exported = (await invokeHttp(s.server.url, s.token, 'logs.export', [{}])).json<{ value: { path: string } }>().value.path;
    const down = await get(`/api/exports/${encodeURIComponent(basename(exported))}`);
    expect([down.status, down.text]).toEqual([200, readFileSync(exported, 'utf8')]);
    expect((await get('/api/screens/S-1')).status).toBe(404);
    for (const path of [`/api/reports/${report.id}/file`, `/api/exports/${basename(exported)}`, '/api/attachments/A-000001', '/api/screens/S-1']) {
      expect([(await get(path, {})).status, path]).toEqual([401, path]);
    }
  });

  it('폴더 밖은 주지 않는다 — 경로 탈출, 저장소가 가리킨 폴더 밖 파일, 폴더 밖을 가리키는 접합·링크는 404', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wook-test-files-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), '밖의 비밀');
    const store = s.h.core.ctx.store;
    const paths = s.h.core.ctx.paths;
    // 저장소의 첨부 기록이 첨부 폴더 밖을 가리킨다
    store.kv.set('attachment:A-900001', { id: 'A-900001', name: 'db', path: paths.db, size: 1, mime: 'application/octet-stream' });
    // 첨부 폴더 안의 접합이 밖을 가리킨다
    mkdirSync(paths.attachments, { recursive: true });
    const link = join(paths.attachments, 'A-900002');
    symlinkSync(outside, link, 'junction');
    store.kv.set('attachment:A-900002', { id: 'A-900002', name: 'secret.txt', path: join(link, 'secret.txt'), size: 1, mime: 'text/plain' });
    const attempts = [
      '/api/attachments/A-900001',
      '/api/attachments/A-900002',
      '/api/exports/..%2Fwook.db',
      '/api/exports/%2E%2E',
      '/api/exports/..%5Cwook.db',
      '/api/exports/C%3A%5CWindows%5Cwin.ini',
      '/api/reports/..%2F..%2Fwook.db/file',
      '/api/attachments/..%2F..%2Fwook.db',
      '/api/exports/%E0%A4%A',
    ];
    for (const path of attempts) {
      const r = await get(path);
      expect([r.status, r.text.includes('밖의 비밀') || r.text.includes('SQLite')], path).toEqual([404, false]);
    }
  });

  it('그 폴더 이름으로 시작하는 옆 폴더도, 데이터 폴더의 다른 파일도 밖이다 — 첨부 기록이 attachments-old를, 보고서 기록이 DB를 가리켜도 404 (S3-30)', async () => {
    const store = s.h.core.ctx.store;
    const paths = s.h.core.ctx.paths;
    // 첨부 폴더와 이름 앞부분이 같은 옆 폴더 (`<dataDir>/attachments-old`) — 구분자 없이 앞부분만 견주면 안으로 보인다
    const sibling = `${paths.attachments}-old`;
    mkdirSync(sibling, { recursive: true });
    dirs.push(sibling);
    writeFileSync(join(sibling, 'old.txt'), '옆 폴더의 비밀');
    store.kv.set('attachment:A-900003', { id: 'A-900003', name: 'old.txt', path: join(sibling, 'old.txt'), size: 1, mime: 'text/plain' });
    const side = await get('/api/attachments/A-900003');
    expect([side.status, side.text.includes('옆 폴더의 비밀')]).toEqual([404, false]);
    // 보고서 기록의 파일이 보고서 폴더 밖, 데이터 폴더 안의 DB를 가리킨다 — 보고서는 보고서 폴더 안이어야 한다(데이터 폴더 전체가 아니다)
    await s.h.main('submit_report', { title: 'DB를 가리키는 보고', summary: '요약', results: '결과', changed_files: [], how_to_verify: '확인', issues: '', next_steps: '' });
    const report = store.reports.list().find((r) => r.title === 'DB를 가리키는 보고')!;
    store.reports.patch(report.id, { filePath: paths.db });
    const db = await get(`/api/reports/${report.id}/file`);
    expect([db.status, db.text.includes('SQLite')]).toEqual([404, false]);
  });

  it("업로드 ID에 '../'를 붙여 업로드 폴더 밖을 가리키면 없는 업로드다 — 밖에 그 ID의 기록과 파일이 있어도 명령에 붙지 않는다 (S3-30)", async () => {
    // 업로드 폴더 밖(데이터 폴더의 DB 옆)에 그 ID의 정보 파일을 심어 둔다 — ID 모양을 앞부분만 보면 그 기록을 읽고 DB를 첨부로 붙인다
    const id = `up_${'0'.repeat(32)}/../../wook.db`;
    const planted = `${s.h.core.ctx.paths.db}.json`;
    writeFileSync(planted, JSON.stringify({ id, name: 'wook.db', size: 1, sessionId: s.sessionId, createdAt: new Date().toISOString() }));
    try {
      expect(s.h.core.serverFiles.upload(id, s.sessionId)).toBeNull();
      const before = ownerCommands().length;
      const r = await invokeHttp(s.server.url, s.token, 'command.send', [{ target: 'main', text: '업로드 ID로 밖을 붙임', attachments: [{ name: 'wook.db', uploadId: id }] }]);
      expect([r.status, r.json()]).toEqual([404, { ok: false, error: { code: 'not_found', message: UPLOAD_GONE } }]);
      expect(ownerCommands().length).toBe(before);
    } finally {
      rmSync(planted, { force: true });
    }
  });

  it('HTML·SVG를 올려도 바이트로만 내려받는다 — 그림은 그림 형식, 늘 attachment', async () => {
    const html = uploadId(await upload('<script>alert(1)</script>', 'page.html'));
    const png = uploadId(await upload(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'pic.png'));
    await invokeHttp(s.server.url, s.token, 'command.send', [{ target: 'main', text: '형식 시험', attachments: [{ name: 'page.html', uploadId: html }, { name: 'pic.png', uploadId: png }] }]);
    const atts = ownerCommands().find((m) => m.text === '형식 시험')!.attachments as Attachment[];
    const [h, p] = await Promise.all(atts.map((a) => get(`/api/attachments/${a.id}`)));
    expect([h!.headers['content-type'], p!.headers['content-type']]).toEqual(['application/octet-stream', 'image/png']);
    expect([String(h!.headers['content-disposition']).startsWith('attachment;'), String(p!.headers['content-disposition']).startsWith('attachment;')]).toEqual([true, true]);
  });
});

describe('올린 파일 정리 (S3-10)', () => {
  it('24시간이 지난 업로드는 지운다 — 서버는 시작할 때 한 번 정리한다', async () => {
    const id = uploadId(await upload('지울 파일', 'old.txt'));
    const fresh = uploadId(await upload('남길 파일', 'new.txt'));
    const old = new Date(Date.now() - 25 * 3600_000);
    for (const f of [id, `${id}.json`]) utimesSync(join(uploadsDir(), f), old, old);
    expect(s.h.core.serverFiles.sweep()).toBe(2);
    expect([existsSync(join(uploadsDir(), id)), existsSync(join(uploadsDir(), fresh))]).toEqual([false, true]);
    // 시작 때의 정리 (백엔드의 files.sweep)
    const fake = fakeServerBackend();
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-files-sweep-'));
    dirs.push(dir);
    let sweeps = 0;
    const server = await startServer({
      backend: {
        ...fake.backend,
        files: {
          sweep: () => (sweeps++, 0),
          beginUpload: () => s.h.core.serverFiles.beginUpload(),
          finishUpload: (o) => s.h.core.serverFiles.finishUpload(o),
          abortUpload: (x) => s.h.core.serverFiles.abortUpload(x),
          download: (k, x) => s.h.core.serverFiles.download(k, x),
        },
      },
      dataDir: dir,
      port: 0,
      allowTestSession: false,
      logger: memoryLogger(),
      version: 'test',
    });
    await server.close();
    fake.close();
    expect(sweeps).toBe(1);
  });
});
