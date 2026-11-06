/**
 * 주소의 토큰 거부는 토큰 모양만 본다 (SERVER_DESIGN 3.4, 리드 결정 S3-24 — 검토 프로브 zz-s3sec-uploadname을 옮김). 업로드는 파일 이름을 쿼리(?name=)로
 * 받으므로, `wos_`로 시작하는 이름의 파일을 올렸을 때 '토큰을 주소에 넣지 마세요' 401이 나면 안 된다. 세션 토큰과 꼭 같은 모양의 파일 이름도
 * `POST /api/uploads`의 name에서는 받는다(리드 결정 S8-21 b — 업로드 주소는 XHR이라 방문 기록에 남지 않고, 접근 기록에는 쿼리를 쓰지 않는다). 토큰 이름의
 * 쿼리, 업로드의 다른 쿼리, 다른 길의 토큰 모양 값은 그대로 거부한다. 토큰은 시험 출력에 내지 않는다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { httpCall, invokeHttp, sleep } from './helpers';
import { ownerServer, type OwnerServer } from './ownerServer';

let o: OwnerServer;
beforeAll(async () => {
  o = await ownerServer();
}, 120_000);
afterAll(async () => {
  await o?.close();
});

const upload = (query: string) =>
  httpCall({ url: o.server.url, path: `/api/uploads${query}`, method: 'POST', headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('hello') });
const status = (r: Awaited<ReturnType<typeof upload>>): [number, string] => [r.status, (r.json() as { error?: { code: string } }).error?.code ?? 'ok'];
/** 세션 토큰과 꼭 같은 모양의 파일 이름 (wos_ + base64url 43자) — 실제 세션 토큰은 아니다 */
const TOKEN_SHAPED = `wos_${'Ab3-_'.repeat(8)}xyz`;

describe('주소의 토큰 거부와 파일 이름 (S3-24·S8-21 b)', () => {
  it('살아 있는 세션은 wos_notes.txt도 다른 파일처럼 올린다', async () => {
    const control = await upload('?name=notes.txt');
    const named = await upload(`?name=${encodeURIComponent('wos_notes.txt')}`);
    expect({ control: status(control), named: status(named) }).toEqual({ control: [200, 'ok'], named: [200, 'ok'] });
    expect((named.json() as { value: { name: string } }).value.name).toBe('wos_notes.txt');
  });

  it('세션 토큰 모양(wos_ + 43자)의 파일 이름도 올린다 — 저장한 이름은 가리개를 거치고(S8-23 3), 접근 기록에는 쿼리가 없다', async () => {
    expect(TOKEN_SHAPED).toMatch(/^wos_[A-Za-z0-9_-]{43}$/);
    const before = o.log.lines.length;
    const r = await upload(`?name=${encodeURIComponent(TOKEN_SHAPED)}`);
    expect(status(r)).toEqual([200, 'ok']);
    const name = (r.json() as { value: { name: string } }).value.name;
    expect(name).not.toContain('wos_');
    expect(name).toContain('[가림_');
    // 접근 줄은 응답을 닫은 뒤에 쓴다 — 나올 때까지 잠깐 기다린다
    for (let i = 0; i < 100 && !o.log.lines.slice(before).some((l) => l.includes('/api/uploads')); i++) await sleep(20);
    const lines = o.log.lines.slice(before);
    expect(lines.some((l) => l.includes('/api/uploads'))).toBe(true);
    expect(lines.filter((l) => l.includes('wos_') || l.includes('?'))).toEqual([]);
  });

  it('토큰 이름의 쿼리, 업로드의 다른 쿼리·대소문자가 다른 이름에 실은 토큰 모양, 다른 길의 토큰 모양은 그대로 401이다 — 맞는 토큰이라도', async () => {
    expect([
      status(await upload(`?name=a.txt&token=x`)),
      status(await upload(`?name=a.txt&access_token=${o.token}`)),
      status(await upload(`?name=a.txt&x=${o.token}`)),
      status(await upload(`?Name=${TOKEN_SHAPED}`)),
    ]).toEqual([
      [401, 'unauthorized'],
      [401, 'unauthorized'],
      [401, 'unauthorized'],
      [401, 'unauthorized'],
    ]);
    // 업로드가 아닌 길(내려받기 — 거부하지 않으면 없는 첨부라 404다)의 토큰 모양 값 — name이라도 거부한다
    const other = await httpCall({ url: o.server.url, path: `/api/attachments/A-999999?name=${TOKEN_SHAPED}`, method: 'GET', headers: { Authorization: `Bearer ${o.token}` } });
    expect(status(other)).toEqual([401, 'unauthorized']);
    // 같은 길의 POST가 아닌 메서드도 거부한다 (값을 보지 않는 것은 POST /api/uploads의 name뿐)
    const put = await httpCall({ url: o.server.url, path: `/api/uploads?name=${TOKEN_SHAPED}`, method: 'PUT', headers: { Authorization: `Bearer ${o.token}` }, body: Buffer.from('x') });
    expect(status(put)).toEqual([401, 'unauthorized']);
  });
});

/** 데이터 폴더의 모든 파일(이름과 내용 — DB·WAL·업로드 기록·첨부·기록 파일)에서 그 글자가 든 곳 */
function foundIn(root: string, needle: string): string[] {
  const hits: string[] = [];
  const bytes = Buffer.from(needle, 'utf8');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name.includes(needle)) hits.push(`이름: ${relative(root, full)}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && readFileSync(full).includes(bytes)) hits.push(`내용: ${relative(root, full)}`);
    }
  };
  walk(root);
  return hits;
}

describe('살아 있는 세션 토큰을 파일 이름으로 올려도 어디에도 남지 않는다 (리드 결정 S8-23 3)', () => {
  it('업로드 기록·답, 화면처럼 원래 이름으로 붙인 명령의 대화 첨부와 첨부 파일, 붙여 넣은 그림 이름, 대기열·활동·일지(DB 전체)에 토큰이 없다', async () => {
    const name = `${o.token}.pdf`;
    const r = await upload(`?name=${encodeURIComponent(name)}`);
    expect(status(r)).toEqual([200, 'ok']);
    const value = (r.json() as { value: { uploadId: string; name: string } }).value;
    expect(value.name.includes(o.token)).toBe(false);
    expect(value.name.endsWith('.pdf')).toBe(true);
    const text = `토큰 이름 첨부 ${Math.random().toString(36).slice(2, 8)}`;
    const pasted = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    const sent = await invokeHttp(o.server.url, o.token, 'command.send', [
      { target: 'main', text, attachments: [{ name, uploadId: value.uploadId }, { name: `${o.token}-붙임.png`, dataUrl: pasted }] },
    ]);
    expect(sent.status).toBe(200);
    const msg = o.h.core.ctx.store.conversation.list({ ref1: 'main' }).find((m) => m.text === text)!;
    expect(msg.attachments).toHaveLength(2);
    expect(msg.attachments.map((a) => a.name.includes(o.token) || a.path.includes(o.token))).toEqual([false, false]);
    // 화면이 읽는 대화 기록에도 없다
    const history = await invokeHttp(o.server.url, o.token, 'command.history', ['main', { limit: 20 }]);
    expect(history.status).toBe(200);
    expect(history.text.includes(text)).toBe(true);
    expect(history.text.includes(o.token)).toBe(false);
    // 데이터 폴더 어디에도 (DB의 대화·첨부·대기열·활동·일지, 업로드 기록, 첨부 파일 이름)
    expect(foundIn(o.h.dataDir, o.token)).toEqual([]);
  });
});
