import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const home = new URL('?officeDemo=busy&capture=home', base).toString();
try {
  await page.goto(home, { waitUntil: 'networkidle' });
  await page.locator('.project-card', { hasText: '동네 산책 기록장' }).click();
  await page.locator('.member-card', { hasText: '담이' }).click();
  const panel = page.locator('.member-panel');
  await panel.getByPlaceholder('담이에게 전달할 내용').fill('검수 의견을 기다립니다.');
  await panel.getByRole('button', { name: '메시지 보내기' }).click();
  await panel.getByRole('status').filter({ hasText: '검수 중이라 메시지를 보관했습니다' }).waitFor();
  await panel.getByText('전달 대기', { exact: false }).first().waitFor();
  await panel.getByText('전달 못 함', { exact: false }).first().waitFor();
  await panel.getByRole('button', { name: '팀원 상세 닫기' }).click();
  await page.locator('.member-card', { hasText: '시안' }).click();
  const deliveredPanel = page.locator('.member-panel');
  await deliveredPanel.getByPlaceholder('시안에게 전달할 내용').fill('진행 상황을 알려 주세요.');
  await deliveredPanel.getByRole('button', { name: '메시지 보내기' }).click();
  await deliveredPanel.getByText('전달됨', { exact: false }).first().waitFor();
  await deliveredPanel.getByRole('button', { name: '팀원 상세 닫기' }).click();

  await page.locator('.task-row', { hasText: '기록 흐름 검수' }).click();
  const task = page.getByRole('dialog').last();
  await task.getByText('따로 확인할 파일').waitFor();
  await task.getByText('assets/preview.png', { exact: false }).waitFor();
  await task.locator('.criterion-form select').first().selectOption('fail');
  await task.getByText('미통과 항목이 있습니다', { exact: false }).waitFor();
  await task.getByRole('button', { name: '검수 등록' }).click();
  await task.getByRole('alert').filter({ hasText: '미통과 항목이 있어' }).waitFor();
  await task.locator('.criterion-form select').first().selectOption('pass');
  await task.getByRole('button', { name: '검수 등록' }).click();
  await task.waitFor({ state: 'hidden' });
  await page.locator('.task-row', { hasText: '기록 흐름 검수' }).click();
  await page.getByRole('dialog').last().getByText('보관된 산출물').waitFor();
  await page.getByRole('dialog').last().getByText('deliverables/archive', { exact: false }).waitFor();

  await page.goto(home, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '프로젝트 추가' }).click();
  const create = page.getByRole('dialog').last();
  await create.getByPlaceholder('예: 동네 산책 기록장').fill('테스트');
  await create.locator('input').nth(1).fill('\\\\server\\share');
  await create.getByRole('button', { name: '프로젝트 추가' }).click();
  await create.getByRole('alert').filter({ hasText: '로컬 드라이브의 폴더만' }).waitFor();
  assert.equal(await create.count(), 1);
  console.log(JSON.stringify({ messageNote: true, messageStates: 3, reviewNotes: true,
    reviewRefusal: true, artifact: true, uncRefusal: true }));
} finally { await browser.close(); }
