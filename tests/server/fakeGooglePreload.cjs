/**
 * 빌드한 서버의 시험용 미리 불러오기 (리드 결정 S3-30 — 첫 검토 flows-lifecycle 프로브 s3fl-preload.cjs를 옮김). 시험이
 * `node --require <이 파일> out/…/index.mjs serve …`로 띄운다. 제품 코드에는 시험 스위치를 두지 않는다 — 바꾸는 것은 이 프로세스 안에서만이다.
 * - @napi-rs/keyring → 파일 하나에 쓰는 가짜(WOOK_TEST_KEYRING_FILE) — `secret set`이 실제 OS 보안 저장소를 건드리지 않는다
 * - 구글의 기기 코드·토큰·공개 키 주소로 가는 fetch → 시험의 가짜 구글 서버(WOOK_TEST_FAKE_GOOGLE_URL). 그 밖의 구글 주소는 거부한다(실제 구글에 닿지 않게)
 */
'use strict';
const Module = require('node:module');
const fs = require('node:fs');

const file = process.env.WOOK_TEST_KEYRING_FILE;
const fakeGoogle = process.env.WOOK_TEST_FAKE_GOOGLE_URL;
if (!file || !fakeGoogle) throw new Error('fakeGooglePreload: WOOK_TEST_KEYRING_FILE과 WOOK_TEST_FAKE_GOOGLE_URL이 있어야 합니다');

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const save = (m) => fs.writeFileSync(file, JSON.stringify(m));
class AsyncEntry {
  constructor(service, account) {
    this.k = `${service}\u0000${account}`;
  }
  async getPassword() {
    const m = load();
    return Object.hasOwn(m, this.k) ? m[this.k] : null;
  }
  async setPassword(p) {
    const m = load();
    m[this.k] = p;
    save(m);
  }
  async deletePassword() {
    const m = load();
    const had = Object.hasOwn(m, this.k);
    delete m[this.k];
    save(m);
    return had;
  }
}
async function findCredentialsAsync(service) {
  const m = load();
  return Object.entries(m)
    .filter(([k]) => k.startsWith(`${service}\u0000`))
    .map(([k, v]) => ({ account: k.slice(service.length + 1), password: v }));
}
const fakeKeyring = { AsyncEntry, findCredentialsAsync };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@napi-rs/keyring') return fakeKeyring;
  return origLoad.apply(this, arguments);
};

const realFetch = globalThis.fetch;
const GOOGLE = {
  'https://oauth2.googleapis.com/device/code': '/device/code',
  'https://oauth2.googleapis.com/token': '/token',
  'https://www.googleapis.com/oauth2/v3/certs': '/certs',
};
globalThis.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (Object.hasOwn(GOOGLE, url)) return realFetch.call(this, `${fakeGoogle}${GOOGLE[url]}`, init);
  if (/^https?:\/\/[^/]*google/i.test(url)) return Promise.reject(new Error('fakeGooglePreload: 실제 구글 주소는 막았습니다'));
  return realFetch.call(this, input, init);
};
