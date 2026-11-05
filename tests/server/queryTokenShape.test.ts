/**
 * 주소의 토큰 거부는 토큰 모양만 본다 (SERVER_DESIGN 3.4, 리드 결정 S3-24 — 검토 프로브 zz-s3sec-uploadname을 옮김). 업로드는 파일 이름을 쿼리(?name=)로
 * 받으므로, `wos_`로 시작하는 이름의 파일을 올렸을 때 '토큰을 주소에 넣지 마세요' 401이 나면 안 된다. 세션 토큰 모양의 값과 토큰 이름의 쿼리는 그대로
 * 거부한다. 토큰은 시험 출력에 내지 않는다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpCall } from './helpers';
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

describe('주소의 토큰 거부와 파일 이름 (S3-24)', () => {
  it('살아 있는 세션은 wos_notes.txt도 다른 파일처럼 올린다', async () => {
    const control = await upload('?name=notes.txt');
    const named = await upload(`?name=${encodeURIComponent('wos_notes.txt')}`);
    expect({ control: status(control), named: status(named) }).toEqual({ control: [200, 'ok'], named: [200, 'ok'] });
    expect((named.json() as { value: { name: string } }).value.name).toBe('wos_notes.txt');
  });

  it('세션 토큰 모양의 값과 토큰 이름의 쿼리는 그대로 401이다 — 맞는 토큰이라도', async () => {
    expect([status(await upload(`?name=${o.token}`)), status(await upload(`?name=a.txt&token=x`)), status(await upload(`?name=a.txt&access_token=${o.token}`))]).toEqual([
      [401, 'unauthorized'],
      [401, 'unauthorized'],
      [401, 'unauthorized'],
    ]);
  });
});
