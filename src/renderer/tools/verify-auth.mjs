import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto(new URL('?capture=login', base).toString(), { waitUntil: 'networkidle' });
  const form = page.locator('.login-setup');
  await form.waitFor();
  assert.equal(await page.getByRole('button', { name: '개발 모드로 시작하기' }).count(), 1);
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    const real = fakeBridge.invoke.bind(fakeBridge);
    fakeBridge.invoke = async (...args) => {
      if (args[0] === 'settings.setGoogleSecret') throw new Error('보안 비밀 저장에 실패했습니다.');
      return real(...args);
    };
  });
  await form.locator('input').nth(0).fill('test.apps.googleusercontent.com');
  await form.locator('input').nth(1).fill('secret-value');
  await form.getByRole('button', { name: '로그인 설정 저장' }).click();
  await form.getByRole('status').filter({ hasText: '실패' }).waitFor();
  const toastClear = await page.evaluate(() => {
    const input = document.querySelector('.login-setup input[type="password"]')?.getBoundingClientRect();
    const toast = document.querySelector('.toast-stack .toast')?.getBoundingClientRect();
    return !input || !toast || input.right < toast.left || toast.right < input.left || input.bottom < toast.top || toast.bottom < input.top;
  });
  assert.equal(toastClear, true, 'error toast covers the secret input');
  await page.reload({ waitUntil: 'networkidle' });
  await form.waitFor();
  const afterFailedSave = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    return fakeBridge.invoke('auth.getState');
  });
  assert.equal(afterFailedSave.googleConfigured, true);
  assert.equal(afterFailedSave.googleSecretSet, false);
  await form.locator('input').nth(0).fill('test.apps.googleusercontent.com');
  await form.locator('input').nth(1).fill('secret-value');
  await form.getByRole('button', { name: '로그인 설정 저장' }).click();
  await page.getByRole('button', { name: '로그인 설정 다시 입력' }).waitFor();
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    const real = fakeBridge.invoke.bind(fakeBridge);
    fakeBridge.invoke = async (...args) => args[0] === 'auth.login' ? new Promise((_, reject) => setTimeout(() => reject(new Error('Google 로그인이 실패했습니다.')), 400)) : real(...args);
  });
  await page.getByRole('button', { name: /Google 계정으로 로그인/ }).click();
  assert.equal(await page.getByRole('button', { name: /Google 로그인 중/ }).isDisabled(), true);
  await form.waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    await fakeBridge.invoke('auth.login');
    await fakeBridge.invoke('auth.logout');
  });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('button', { name: '로그인 설정 다시 입력' }).count(), 0);
  assert.equal(await form.count(), 0);
  await page.evaluate(() => {
    const key = 'wook-renderer-fake-auth-v1';
    const saved = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...saved, ownerRegistered: true, secretSet: false, setupOpen: true }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await form.waitFor();
  assert.match(await form.textContent(), /등록된 대표 계정으로만 로그인됩니다/);
  await form.locator('input').nth(0).fill('restored.apps.googleusercontent.com');
  await form.locator('input').nth(1).fill('restored-secret');
  await form.getByRole('button', { name: '로그인 설정 저장' }).click();
  await form.waitFor({ state: 'hidden' });
  const recoveredLostSecret = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    return fakeBridge.invoke('auth.login');
  });
  assert.equal(recoveredLostSecret.loggedIn, true);
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    await fakeBridge.invoke('settings.update', { account: { googleClientId: 'changed.apps.googleusercontent.com' } });
    await fakeBridge.invoke('auth.logout');
  });
  await page.reload({ waitUntil: 'networkidle' });
  assert.match(await page.locator('.login-guidance').first().textContent(), /로그인 설정이 바뀌었다면/);
  await page.getByRole('button', { name: '로그인 설정 다시 입력' }).click();
  await form.waitFor();
  assert.match(await form.textContent(), /등록된 대표 계정으로만 로그인됩니다/);
  await form.locator('input').nth(0).fill('corrected.apps.googleusercontent.com');
  await form.locator('input').nth(1).fill('corrected-secret');
  await form.getByRole('button', { name: '로그인 설정 저장' }).click();
  await form.waitFor({ state: 'hidden' });
  const recoveredChangedSettings = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    return fakeBridge.invoke('auth.login');
  });
  assert.equal(recoveredChangedSettings.loggedIn, true);
  const emptyIdRefused = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    try { await fakeBridge.invoke('settings.update', { account: { googleClientId: '' } }); return false; }
    catch (error) { return /클라이언트 ID를 비울 수 없습니다/.test(String(error)); }
  });
  assert.equal(emptyIdRefused, true);
  await page.goto(new URL('?officeDemo=busy&capture=settings', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.settings-nav button', { hasText: '계정' }).first().click();
  await page.locator('label', { hasText: 'OAuth 클라이언트 ID' }).locator('input').fill('');
  assert.equal(await page.getByRole('button', { name: 'ID 저장' }).isDisabled(), true);
  await page.goto(new URL('?capture=login&fakeDevLogin=0', base).toString(), { waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('button', { name: '개발 모드로 시작하기' }).count(), 0);
  const report = { savedIdAfterSecretFailure: afterFailedSave.googleConfigured,
    secretUnsetAfterFailure: !afterFailedSave.googleSecretSet, failedLoginOpensForm: true,
    ownerRegisteredHidesRecovery: true, recoveredLostSecret: recoveredLostSecret.loggedIn,
    recoveredChangedSettings: recoveredChangedSettings.loggedIn, emptyIdRefused,
    devButtonInitial: true, devButtonDisabledWhenDisallowed: true, emptyIdSaveDisabled: true,
    guidanceBeforeForm: true, googlePending: true, toastClear };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
