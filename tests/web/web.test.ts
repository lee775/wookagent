/**
 * 웹 화면 끝까지 시험 (SERVER_DESIGN 10.8 '새 테스트', 리드 결정 S8-7): 실제 서버(프로세스 안, 서버 모드, 모의 메인 에이전트) + 서버용 웹 빌드를
 * https 공개 주소(시험 안의 TLS 앞단)로 headless Edge에서 연다. 조작은 화면의 접근성 이름으로 한다 — 브리지는 page.evaluate로 보기만 한다(연결 상태).
 * 시험 이름 앞의 낱말이 10.8의 시험 이름이다 (`npm run test:web -- -t webLogin`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { MAIN_AGENT_ID, type ConversationMessage } from '@shared/domain';
import { OWNER_METHODS } from '@shared/ipc';
import { FAKE_BRIDGE_MARKERS, WEB_SCREEN_CSP } from '../../src/server/webScreen';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID } from '../server/fakeGoogle';
import { cliTurn, commandDraft, connectionOpen, controls, conversation, eventText, ownerBubbles, OWNER_EMAIL, PHONE, poll, sleep, startRig, until, type Rig } from './rig';

const e2e = inject('webE2e');
const SECTIONS = { summary: '웹에서 수정 요청할 보고서입니다', results: '결과 표', changedFiles: [], howToVerify: '화면을 엽니다', issues: '', nextSteps: '' };
const rand = () => Math.random().toString(36).slice(2, 8);

/**
 * 대표 화면에 없어야 할 조작 — 팀 운영(G3: 팀원 추가·삭제·AI 조정, 역할 정의, 작업·지시 취소·중단·재개, 검수 대체, 일시정지, 복구 확인, 운영 설정,
 * 프로젝트 만들기·설정)과 자리 교체(4.4 '교체 버튼은 없다'). 이름은 버튼·링크·메뉴·탭과 고르기·입력 칸(combobox·listbox·textbox·spinbutton·slider —
 * S8-21)의 접근성 이름에 견준다. 고르기의 항목(option)은 값이라 견주지 않는다. '…요청'(명령 초안을 채우는 것)과
 * '메인 에이전트에게 말하기', 첨부 칩의 '첨부 제거', 대화상자의 '취소'는 조작이 아니다
 */
const TEAM_OPS: readonly RegExp[] = [
  /팀원\s*(추가|삭제|해고|제거|교체|바꾸기|배정|내보내기)/,
  /역할\s*(추가|만들기|정의|수정|삭제|변경|저장)/,
  /(AI|모델|노력|추론)\s*(변경|조정|바꾸기|고르기|저장)/,
  /(작업|지시)\s*(취소|중단|중지|재개|다시 시작|재배정|배정|삭제)/,
  /재배정|검수(자)?\s*(대체|바꾸기|교체|배정)/,
  /^(일시\s*정지|재개|다시 시작|중단)$/,
  /(팀원|프로젝트|작업)\s*(일시\s*정지|재개)/,
  /복구\s*(확인|처리)\s*(완료|하기)?$/,
  /자리\s*(교체|바꾸기|넘기기|배정|옮기기)|보유자\s*(바꾸기|변경|교체|배정)|교체$/,
  /프로젝트\s*(만들기|추가|삭제|등록)(?!\s*요청)/,
  /설정\s*저장|^저장$|^적용$/,
  /모의 실행\s*(켜기|끄기)/,
];
const teamOps = (list: { role: string; name: string }[]) => list.filter((c) => c.role !== 'option' && TEAM_OPS.some((re) => re.test(c.name)));

/**
 * webNotifications의 페이지 준비 (페이지의 스크립트보다 먼저 돈다): headless Edge는 다른 탭을 앞에 두거나 창을 줄여도 visibilityState가 'visible'이라
 * (11-05 확인) 문서의 숨김 상태를 바꿔 끼우고 visibilitychange를 낸다. 알림 길은 바꾸지 않고 적기만 한다 — 워커의 showNotification과 Notification 생성자
 * 모두 원래 것을 부른다
 */
const NOTIFY_RECORDER = `(() => {
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
  const made = [];
  const record = (via, title, options) => made.push({ via, title, body: options && options.body, tag: options && options.tag, link: options && options.data && options.data.link });
  const proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
  if (proto) {
    const original = proto.showNotification;
    proto.showNotification = function (title, options) { record('worker', title, options); return original.call(this, title, options); };
  }
  const Original = window.Notification;
  if (Original) {
    window.Notification = class extends Original { constructor(title, options) { record('constructor', title, options); super(title, options); } };
  }
  window.__wookTest = { setVisibility(v) { visibility = v; document.dispatchEvent(new Event('visibilitychange')); }, made: () => made.slice() };
})();`;

if (e2e.skipReason) {
  describe('웹 화면 끝까지 시험', () => {
    it.skip(`건너뜀 — ${e2e.skipReason}`, () => undefined);
  });
} else {
  let rig: Rig;
  const store = () => rig.h.core.ctx.store;
  const ownerMessages = (target: string): ConversationMessage[] => store().conversation.list({ ref1: target }).filter((m) => m.role === 'owner');

  beforeAll(async () => {
    rig = await startRig(e2e.webDir!);
  }, 180_000);

  afterEach(async ({ task }) => {
    await rig?.closePages(task.result?.state === 'fail' ? task.name : null);
  });

  afterAll(async () => {
    await rig?.close();
  });

  describe('웹 화면 끝까지 시험 (10.8)', () => {
    it('webLogin — 처음 연 서버는 설정 코드·대표 이메일을 받고, Google 기기 코드 로그인(가짜 구글)으로 https 공개 주소에 __Host- 세션 쿠키를 받아 작업실로 간다. 새로 고쳐도 로그인돼 있고 실시간 갱신이 온다', async () => {
      const { page, context, errors } = await rig.open({ fresh: true });
      expect(rig.h.core.serverLogin.setupRequired()).toBe(true);
      const code = rig.op.issueSetupCode()!.code;
      await page.goto(`${rig.origin}/?studio3d=0`);
      await page.getByRole('heading', { name: '서버 설정이 끝나지 않았습니다' }).waitFor();
      await page.getByRole('textbox', { name: '설정 코드' }).fill(code);
      await page.getByRole('textbox', { name: '대표 이메일' }).fill(OWNER_EMAIL);
      await page.getByRole('button', { name: '대표 이메일 등록' }).click();
      const start = page.getByRole('button', { name: 'Google 계정으로 로그인' });
      await start.waitFor();
      expect(rig.h.core.serverLogin.setupRequired()).toBe(false);

      const asked = rig.g.codeRequests.length;
      await start.click();
      const userCode = (await page.locator('.device-user-code').innerText()).trim();
      expect(userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      expect(await page.getByRole('link', { name: /google\.com\/device 열기/ }).getAttribute('href')).toBe('https://www.google.com/device');
      expect([rig.g.codeRequests.length - asked, rig.g.codeRequests.at(-1)?.get('client_id')]).toEqual([1, FAKE_CLIENT_ID]);
      // 로그인 전 쿠키가 이 브라우저에 묶였다
      expect((await context.cookies()).map((c) => c.name)).toContain(LOGIN_COOKIE);
      const sessions = rig.h.core.deviceSessions.list().length;
      rig.g.answer(rig.g.lastDeviceCode(), { kind: 'ok' });
      await page.getByRole('heading', { name: '프로젝트 현황' }).waitFor({ timeout: 20_000 });
      const runId = await connectionOpen(page);
      expect(runId).toBe(rig.server.runId);

      const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
      expect(cookie && { domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite }).toEqual({
        domain: 'wook-e2e.test',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
      });
      const list = rig.h.core.deviceSessions.list();
      expect(list.length).toBe(sessions + 1);
      expect(list.at(-1)?.deviceName).toMatch(/^PC \((Windows|Mac|Linux)\)$/);
      expect(await page.getByRole('status', { name: '서버 연결 상태' }).innerText()).toContain('서버 연결됨');

      // 로그인한 연결로 실시간 갱신이 온다 — 다시 연 이벤트 연결이 세션을 가진다 (로그인 전 연결에는 알림을 보내지 않는다)
      rig.h.core.ctx.notify({ level: 'normal', title: `로그인 뒤 알림 ${rand()}`, body: '실시간 확인', key: `e2e:login:${rand()}` });
      await page.locator('.toast').filter({ hasText: '로그인 뒤 알림' }).waitFor();

      await page.reload();
      await page.getByRole('heading', { name: '프로젝트 현황' }).waitFor();
      expect(await page.getByRole('button', { name: 'Google 계정으로 로그인' }).count()).toBe(0);
      expect(errors).toEqual([]);
      // 다음 시험들은 이 로그인이 받은 세션 쿠키로 연다 (로그인 시작은 1분에 5번까지)
      await rig.remember(context);
    });

    it('webLiveSnapshot — 새로 고치지 않아도 서버의 바뀐 상태(새 프로젝트, 알림)가 이벤트 연결로 화면에 온다 — snapshot.get을 다시 부르지 않는다', async () => {
      const { page, errors } = await rig.open();
      await rig.login(page);
      let navigations = 0;
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) navigations++;
      });
      const reads = rig.proxy.invokes('snapshot.get').length;
      const name = `실시간 프로젝트 ${rand()}`;
      await rig.h.internal('projects.create', { mode: 'new', path: join(rig.h.projectDir, '..', name), name, checkCommands: [] });
      await page.locator('.project-card').filter({ hasText: name }).waitFor();
      const title = `실시간 알림 ${rand()}`;
      rig.h.core.ctx.notify({ level: 'normal', title, body: '이벤트 연결로 왔습니다', key: `e2e:live:${rand()}` });
      await page.locator('.toast').filter({ hasText: title }).waitFor();
      expect(await page.getByRole('button', { name: '알림함' }).innerText()).toMatch(/\d+/);
      expect([navigations, rig.proxy.invokes('snapshot.get').length - reads]).toEqual([0, 0]);
      expect(errors).toEqual([]);
    });

    it('webNotifications — 알림을 허락한 브라우저: 실제 서버 화면이 알림 서비스 워커(/notify-sw.js — 화면과 같은 CSP 머리)를 등록하고, 화면이 숨었을 때 온 알림은 registration.showNotification으로 고정 제목·짧은 고정 본문과 그 알림의 tag만 띄운다 — 알림의 제목·본문은 싣지 않는다. 보이는 동안에는 띄우지 않는다 (S8-19)', async () => {
      const { page, context, errors } = await rig.open();
      await context.grantPermissions(['notifications'], { origin: rig.origin });
      // 숨김 바꾸기와 알림 적기 (NOTIFY_RECORDER 설명)
      await context.addInitScript(NOTIFY_RECORDER);
      type Made = { via: string; title: string; body: unknown; tag: unknown; link: unknown };
      const made = () => page.evaluate('window.__wookTest.made()') as Promise<Made[]>;
      await rig.login(page);
      // 허락된 화면은 열 때 워커를 등록한다 (scope /)
      const registration = await poll(
        () =>
          page.evaluate(
            "navigator.serviceWorker.getRegistration('/').then((r) => (r ? { scope: r.scope, active: r.active ? r.active.scriptURL : null } : null))",
          ) as Promise<{ scope: string; active: string | null } | null>,
        (v) => !!v?.active,
      );
      expect(registration).toEqual({ scope: `${rig.origin}/`, active: `${rig.origin}/notify-sw.js` });
      // 서버가 준 워커: JavaScript, no-cache, 화면과 같은 전체 CSP (S8-23 2)
      const head = await page.evaluate(async () => {
        const r = await fetch('/notify-sw.js', { cache: 'no-store' });
        return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), csp: r.headers.get('content-security-policy') };
      });
      expect(head).toEqual({ status: 200, type: 'text/javascript; charset=utf-8', cache: 'no-cache', csp: WEB_SCREEN_CSP });
      // 알림 제안은 없다 (이미 허락함)
      expect(await page.getByRole('button', { name: '브라우저 알림 켜기' }).count()).toBe(0);

      // 보이는 동안: 화면 안 토스트만, 브라우저 알림은 없다
      const visibleTitle = `보이는 동안 알림 ${rand()}`;
      rig.h.core.ctx.notify({ level: 'normal', title: visibleTitle, body: '보이는 화면', key: `e2e:visible:${rand()}` });
      await page.locator('.toast').filter({ hasText: visibleTitle }).waitFor();
      await sleep(300);
      expect(await made()).toEqual([]);

      // 숨김: 알림 하나 — 워커 길로 고정 글만
      await page.evaluate("window.__wookTest.setVisibility('hidden')");
      const secretTitle = `비밀 보고서 제목 ${rand()}`;
      const secretBody = `내부 경로 D:\\work\\${rand()} 와 긴 본문 ${'가'.repeat(200)}`;
      const item = rig.h.core.ctx.notify({ level: 'normal', title: secretTitle, body: secretBody, key: `e2e:hidden:${rand()}`, link: { tab: 'documents' } });
      const shown = await poll(made, (list) => list.length >= 1);
      await sleep(500);
      const final = await made();
      expect(final.map((n) => n.via)).toEqual(['worker']);
      expect(final[0]).toEqual({ via: 'worker', title: '욱채 알림', body: '작업실에 확인할 새 알림이 있습니다.', tag: `wook-${item.id}`, link: expect.stringMatching(/^\/(#wook-notify=[^ ]*)?$/) });
      expect(shown.length).toBe(1);
      const wire = JSON.stringify(final);
      expect([wire.includes(secretTitle), wire.includes(secretBody.slice(0, 20)), wire.includes('D:')]).toEqual([false, false, false]);
      expect(errors).toEqual([]);
    });

    it('webAttachCommand — 파일 첨부 버튼으로 고른 파일이 업로드되어 {name, uploadId}로 명령에 실리고(경로 없음), 서버의 대화·메인 대기열에 그 파일이 붙고, 대화에서 내려받으면 같은 내용이다. 모의 메인이 답한다', async () => {
      const { page, errors } = await rig.open();
      await rig.login(page);
      const content = `첨부 내용 ${rand()} — 한국어 줄\n둘째 줄`;
      const fileName = '현장 메모.txt';
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '파일 첨부' }).click();
      await (await chooser).setFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from(content, 'utf8') });
      await page.locator('.upload-chip').filter({ hasText: '첨부 준비됨' }).waitFor();
      const text = `첨부한 메모를 확인해 줘 ${rand()}`;
      await page.getByRole('textbox', { name: '명령 입력' }).fill(text);
      await page.getByRole('button', { name: '보내기' }).click();
      await page.locator('.toast').filter({ hasText: '명령을 보냈습니다' }).waitFor();

      const sent = rig.proxy.invokes('command.send').filter((i) => (i.args as [{ text: string }])[0].text === text);
      expect(sent).toHaveLength(1);
      const wire = (sent[0]!.args as [{ target: string; attachments: Record<string, unknown>[] }])[0];
      expect(wire.attachments.map((a) => Object.keys(a).sort())).toEqual([['name', 'uploadId']]);
      expect(wire.attachments[0]!['name']).toBe(fileName);
      expect(rig.proxy.log.some((r) => r.method === 'POST' && r.url.startsWith(`/api/uploads?name=${encodeURIComponent(fileName)}`) && r.status === 200)).toBe(true);

      const msg = ownerMessages('main').find((m) => m.text === text)!;
      expect(msg.attachments.map((a) => [a.name, a.size])).toEqual([[fileName, Buffer.byteLength(content)]]);
      expect(readFileSync(msg.attachments[0]!.path, 'utf8')).toBe(content);
      const work = store().queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_command' && q.message.includes(text));
      expect(work).toHaveLength(1);
      expect(work[0]!.message).toContain(`${msg.attachments[0]!.id} ${fileName}`);

      expect(await ownerBubbles(page, text)).toBe(1);
      const link = page.locator('.conversation .bubble-owner').filter({ hasText: text }).getByRole('link', { name: fileName });
      expect(await link.getAttribute('href')).toBe(`/api/attachments/${msg.attachments[0]!.id}`);
      const download = page.waitForEvent('download');
      await link.click();
      const file = await (await download).path();
      expect(readFileSync(file, 'utf8')).toBe(content);
      // 명령에 답이 온다 (모의 메인 에이전트) — 대화 기록에 메인 에이전트 말풍선
      await until(() => conversation(page), (b) => b.some((x) => x.role === 'main_agent'), '메인 에이전트의 답', 30_000);
      expect(errors).toEqual([]);
    });

    it('webDropCommand — 컴퓨터에서 끌어온 파일을 화면 가운데(명령창 밖)에 놓아도 명령에 첨부된다: 브라우저가 그 파일을 열어 화면을 떠나지 않고, 업로드되어 {name, uploadId}로 실리고, 서버의 대화·메인 대기열에 그 파일이 붙는다. 놓은 뒤 바로 명령을 칠 수 있다 (대표 지시 2026-11-18)', async () => {
      const { page, errors } = await rig.open();
      await rig.login(page);
      const content = `끌어다 놓은 내용 ${rand()} — 한국어 줄\n둘째 줄`;
      const fileName = '끌어다 놓은 메모.txt';
      const before = page.url();
      // 브라우저가 파일 끌기에 주는 것과 같은 DataTransfer로 dragenter → dragover → drop을 화면 가운데의 요소에 보낸다
      const dropped = (await page.evaluate(`(async () => {
        const data = new DataTransfer();
        data.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(fileName)}, { type: 'text/plain' }));
        const target = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 3)) || document.body;
        const fire = (type) => !target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: data }));
        fire('dragenter');
        const overPrevented = fire('dragover');
        // 화면이 끄는 중 표시를 그릴 때까지 (다음 두 프레임)
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        const hint = !!document.querySelector('.command-drop-hint');
        return { inCommandBar: !!target.closest('.command-bar'), overPrevented, hint, dropPrevented: fire('drop') };
      })()`)) as { inCommandBar: boolean; overPrevented: boolean; hint: boolean; dropPrevented: boolean };
      // 놓은 자리는 명령창 밖이다. 끄는 동안 명령창이 받을 자리를 보여 주고, 놓아도 브라우저의 기본 동작(그 파일 열기)이 막힌다
      expect(dropped).toEqual({ inCommandBar: false, overPrevented: true, hint: true, dropPrevented: true });
      expect(page.url()).toBe(before);
      await page.locator('.upload-chip').filter({ hasText: fileName }).filter({ hasText: '첨부 준비됨' }).waitFor();
      expect(await page.locator('.command-drop-hint').count()).toBe(0);
      expect(await page.evaluate("document.activeElement ? document.activeElement.getAttribute('aria-label') : null")).toBe('명령 입력');
      const text = `끌어다 놓은 메모를 확인해 줘 ${rand()}`;
      await page.keyboard.insertText(text);
      await page.keyboard.press('Enter');
      await page.locator('.toast').filter({ hasText: '명령을 보냈습니다' }).waitFor();

      const sent = rig.proxy.invokes('command.send').filter((i) => (i.args as [{ text: string }])[0].text === text);
      expect(sent).toHaveLength(1);
      const wire = (sent[0]!.args as [{ target: string; attachments: Record<string, unknown>[] }])[0];
      expect(wire.attachments.map((a) => Object.keys(a).sort())).toEqual([['name', 'uploadId']]);
      expect(wire.attachments[0]!['name']).toBe(fileName);
      const msg = ownerMessages('main').find((m) => m.text === text)!;
      expect(msg.attachments.map((a) => [a.name, a.size])).toEqual([[fileName, Buffer.byteLength(content)]]);
      expect(readFileSync(msg.attachments[0]!.path, 'utf8')).toBe(content);
      const work = store().queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_command' && q.message.includes(text));
      expect(work).toHaveLength(1);
      expect(work[0]!.message).toContain(`${msg.attachments[0]!.id} ${fileName}`);
      expect(errors).toEqual([]);
    });

    it('webAttachCommand — 올리는 중인 첨부를 지우면 그 자리가 비어 줄 서 있던 넷째 파일이 올라간다: 서버가 아직 지운 업로드를 세어 429를 줘도 다시 대기했다가 올라가고 오류는 보이지 않는다. 명령에는 남은 세 파일만 실린다 (S8-18)', async () => {
      const { page, errors } = await rig.open();
      await rig.login(page);
      const tag = rand();
      const names = ['가', '나', '다', '라'].map((x) => `올리는 중 ${x} ${tag}.txt`);
      const bodies = names.map((n, i) => `${n}\n${'내용 '.repeat(500 + i)}`);
      const uploadsOf = (name: string) => rig.proxy.log.filter((r) => r.method === 'POST' && r.url === `/api/uploads?name=${encodeURIComponent(name)}`);
      // 처음 셋은 본문을 앞단에서 붙잡는다 — 서버는 머리를 받아 그 기기의 업로드 셋으로 센다. 브라우저가 지운 업로드를 끊으면 앞단은 0.6초 뒤에야 서버 쪽을 끊는다
      const stall = rig.proxy.stallUploads((url) => names.slice(0, 3).some((n) => url === `/api/uploads?name=${encodeURIComponent(n)}`), 600);
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '파일 첨부' }).click();
      await (await chooser).setFiles(names.map((name, i) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(bodies[i]!, 'utf8') })));
      await until(() => names.slice(0, 3).every((n) => uploadsOf(n).length === 1), (v) => v, '처음 세 업로드가 서버에 닿음');
      // 넷째는 셋이 올라가는 동안 줄 서 있다 (한 번에 셋)
      await page.getByRole('status', { name: `${names[3]} 업로드 대기` }).waitFor();
      expect(uploadsOf(names[3]!)).toHaveLength(0);
      const chipState = async (name: string) => /upload-(queued|uploading|ready|error)/.exec((await page.locator('.upload-chip').filter({ hasText: name }).getAttribute('class')) ?? '')?.[1] ?? 'none';

      await page.getByRole('button', { name: `${names[0]} 첨부 제거` }).click();
      expect(await page.locator('.upload-chip').filter({ hasText: names[0]! }).count()).toBe(0);
      // 넷째가 올라간다 — 붙잡힌 둘이 아직 올라가는 동안에 (지운 첨부가 자리를 비웠다)
      const fourth = await poll(() => chipState(names[3]!), (v) => v === 'ready' || v === 'error');
      expect(fourth).toBe('ready');
      expect([await chipState(names[1]!), await chipState(names[2]!)]).toEqual(['uploading', 'uploading']);
      // 서버는 지운 업로드가 끊긴 것을 아직 몰라 처음에는 429를 줬고, 화면은 다시 대기했다가 올렸다
      const statuses = uploadsOf(names[3]!).map((r) => r.status);
      expect(statuses[0]).toBe(429);
      expect(statuses.at(-1)).toBe(200);
      expect(await page.locator('.upload-chip [role=alert]').count()).toBe(0);

      stall.release();
      expect(await poll(async () => [await chipState(names[1]!), await chipState(names[2]!)], (v) => v.every((x) => x === 'ready'))).toEqual(['ready', 'ready']);
      expect(await page.getByRole('button', { name: /다시 올리기/ }).count()).toBe(0);
      const text = `남은 세 파일을 봐 줘 ${tag}`;
      await page.getByRole('textbox', { name: '명령 입력' }).fill(text);
      await page.getByRole('button', { name: '보내기' }).click();
      await page.locator('.toast').filter({ hasText: '명령을 보냈습니다' }).waitFor();
      const sent = rig.proxy.invokes('command.send').filter((i) => (i.args as [{ text: string }])[0].text === text);
      expect(sent).toHaveLength(1);
      expect((sent[0]!.args as [{ attachments: { name: string }[] }])[0].attachments.map((a) => a.name)).toEqual(names.slice(1));
      const msg = ownerMessages('main').find((m) => m.text === text)!;
      expect(msg.attachments.map((a) => [a.name, a.size])).toEqual(names.slice(1).map((n, i) => [n, Buffer.byteLength(bodies[i + 1]!)]));
      // 지운 파일은 서버에 남지 않았다 (받다 만 .part도, 업로드 기록도)
      const uploads = join(rig.h.dataDir, 'uploads');
      const files = existsSync(uploads) ? readdirSync(uploads) : [];
      expect(files.filter((f) => f.endsWith('.part'))).toEqual([]);
      const records = files.filter((f) => f.endsWith('.json')).map((f) => (JSON.parse(readFileSync(join(uploads, f), 'utf8')) as { name: string }).name);
      expect(records.filter((n) => n === names[0])).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('webRetryOnce — 서버가 처리한 command.send의 응답이 길에서 사라지면 브리지가 같은 요청 ID로 한 번 더 보내고, 서버는 저장한 답을 준다: 대화와 메인 대기열에 한 번만, 화면은 성공', async () => {
      const { page, errors } = await rig.open();
      await rig.login(page);
      const text = `응답을 잃은 명령 ${rand()}`;
      const dropped = rig.proxy.dropResponseOnce((i) => i.method === 'command.send');
      await page.getByRole('textbox', { name: '명령 입력' }).fill(text);
      await page.getByRole('button', { name: '보내기' }).click();
      const first = await dropped;
      await page.locator('.toast').filter({ hasText: '명령을 보냈습니다' }).waitFor();
      await until(() => page.getByRole('textbox', { name: '명령 입력' }).inputValue(), (v) => v === '', '보낸 뒤 명령창이 비워짐');

      const sends = rig.proxy.log.filter((r) => r.invoke?.method === 'command.send' && (r.invoke.args as [{ text: string }])[0].text === text);
      expect(sends.map((r) => [r.invoke!.id, r.dropped, r.status])).toEqual([
        [first.id, true, 200],
        [first.id, false, 200],
      ]);
      expect(String(first.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(ownerMessages('main').filter((m) => m.text === text)).toHaveLength(1);
      expect(store().queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_command' && q.message.includes(text))).toHaveLength(1);
      expect(await page.locator('.toast').filter({ hasText: '요청을 처리하지 못했습니다' }).count()).toBe(0);
      expect(await ownerBubbles(page, text)).toBe(1);
      expect(errors).toEqual([]);
    });

    it('webReportChanges — 문서함에서 보낸 보고서 수정 요청이 메인 에이전트에게 가는 명령(change_request)으로 들어가고, 화면의 대화 기록에 대표 글로 보인다 — 화면은 command.send를 따로 보내지 않는다', async () => {
      const title = `웹 수정 요청 보고 ${rand()}`;
      const report = await rig.h.core.reports.submit({ directiveId: null, title, sections: SECTIONS }, MAIN_AGENT_ID, null);
      const { page, errors } = await rig.open();
      await rig.login(page);
      const sendsBefore = rig.proxy.invokes('command.send').length;
      await page.locator('.sidebar').getByRole('button', { name: '문서함' }).click();
      await page.locator('.report-list-item').filter({ hasText: title }).click();
      await page.getByRole('heading', { name: title }).waitFor();
      await page.locator('.report-footer').getByRole('button', { name: '수정 요청' }).click();
      const comment = `표를 그래프로 바꿔 주세요 ${rand()}`;
      await page.getByRole('textbox', { name: '전체 코멘트' }).fill(comment);
      await page.getByRole('button', { name: '수정 요청 보내기' }).click();
      await page.getByRole('status').filter({ hasText: '수정 요청을 메인 에이전트에게 보냈습니다' }).waitFor();

      expect(store().reports.require(report.id).status).toBe('changes_requested');
      expect(store().queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request' && q.reportId === report.id)).toHaveLength(1);
      const expected = `보고서 ${report.id} "${title}" 수정 요청:\n${comment}`;
      expect(ownerMessages('main').filter((m) => m.text === expected)).toHaveLength(1);
      expect(rig.proxy.invokes('reports.requestChanges').filter((i) => (i.args as [string])[0] === report.id)).toHaveLength(1);
      expect(rig.proxy.invokes('command.send').length).toBe(sendsBefore);
      // 화면의 대화 기록(메인 에이전트 직접)에 그 글이 한 번 — 새로 고치지 않고
      expect(await ownerBubbles(page, expected)).toBe(1);
      expect(errors).toEqual([]);
    });

    it('webReconnectEvents — 팀원 패널을 연 채 연결이 끊긴 동안에도 CLI 이벤트가 이어지고, 다시 연결되면 패널에 모든 이벤트가 (turnId, seq) 순서로 한 번씩 있다 — 다시 맞추기 읽기와 실시간이 겹쳐도', async () => {
      const devId = rig.h.members.developer!;
      const dev = store().members.require(devId);
      const turn = cliTurn(rig.h, devId);
      const { page, errors } = await rig.open();
      await rig.login(page);
      await page.locator('.project-card').filter({ hasText: '테스트 프로젝트' }).click();
      await page.locator('.member-card').filter({ hasText: dev.name }).click();
      const panel = page.getByRole('complementary', { name: '팀원 상세' });
      await panel.getByRole('heading', { name: dev.name }).waitFor();
      const shown = async () => (await panel.locator('.cli-event p').allInnerTexts()).map((t) => t.trim());
      const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => eventText(turn.turnId, from + i));
      // 이벤트 연결이 그 팀원을 보고 있을 때까지 (?members=)
      await until(() => rig.proxy.log.some((r) => r.url.startsWith('/api/events') && r.url.includes(devId)), (v) => v, '팀원을 보는 이벤트 연결');
      await sleep(300);

      turn.emit(1, 10);
      await until(shown, (s) => s.length === 10, '실시간 이벤트 1–10');

      // 끊김: 브라우저 쪽 소켓을 모두 부수고 2초 동안 새 연결을 받지 않는다 — 그동안 팀원은 계속 일한다
      rig.proxy.refuseFor(2_000);
      rig.proxy.dropAll();
      await until(() => page.getByRole('status', { name: '서버 연결 상태' }).innerText(), (t) => t.includes('연결 끊김'), '재연결 표시');
      turn.emit(11, 20);
      // 다시 연결된 뒤 화면이 빠진 이벤트를 읽는 요청(cursor = 마지막 seq)을 잠깐 붙잡고, 그사이 실시간 이벤트를 더 낸다 — 다시 읽기와 실시간이 겹친다
      const hold = rig.proxy.holdNext((i) => i.method === 'members.getEvents' && (i.args as [string, { turnId?: string; cursor?: string }])[1]?.cursor === '10');
      await hold.arrived;
      await connectionOpen(page);
      turn.emit(21, 25);
      const live = await until(shown, (s) => s.includes(eventText(turn.turnId, 25)), '다시 연결된 실시간 이벤트 21–25');
      expect(live).toEqual([...seqs(1, 10), ...seqs(21, 25)]);
      hold.release();
      await until(shown, (s) => s.length >= 25 && s.includes(eventText(turn.turnId, 11)), '빠진 이벤트 11–20을 채움');
      turn.emit(26, 30);
      await until(shown, (s) => s.includes(eventText(turn.turnId, 30)), '이벤트 26–30');
      await sleep(500);
      expect(await shown()).toEqual(seqs(1, 30));
      expect(await page.getByRole('status', { name: '서버 연결 상태' }).innerText()).toMatch(/다시 연결됐습니다|서버 연결됨/);
      expect(errors).toEqual([]);
    });

    it('webPanelOpenEvents — 팀원 패널을 여는 사이(첫 읽기와 그 팀원을 싣는 이벤트 연결 사이)에 나온 CLI 이벤트도 패널에 순서대로 한 번씩 있다 — 앞단이 그 연결을 붙잡아 틈을 넓혀도 (S8-17)', async () => {
      const qaId = rig.h.members.qa!;
      const qa = store().members.require(qaId);
      const turn = cliTurn(rig.h, qaId);
      const { page, errors } = await rig.open();
      await rig.login(page);
      await page.locator('.project-card').filter({ hasText: '테스트 프로젝트' }).click();
      await page.getByRole('heading', { name: /테스트 프로젝트/ }).waitFor();
      const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => eventText(turn.turnId, from + i));
      turn.emit(1, 5);
      // 패널이 그 팀원을 보려고 여는 이벤트 연결(?members=)을 앞단에서 붙잡는다 — 그동안 옛 연결은 이 팀원의 이벤트를 싣지 않는다
      const hold = rig.proxy.holdRequest((url) => url.startsWith('/api/events') && url.includes(qaId));
      await page.locator('.member-card').filter({ hasText: qa.name }).click();
      const panel = page.getByRole('complementary', { name: '팀원 상세' });
      await panel.getByRole('heading', { name: qa.name }).waitFor();
      const shown = async () => (await panel.locator('.cli-event p').allInnerTexts()).map((t) => t.trim());
      await until(shown, (s) => s.length === 5, '첫 읽기 1–5');
      await hold.arrived;
      turn.emit(6, 10);
      await sleep(700);
      // 붙잡힌 동안 6–10은 화면에 오지 않는다 — 틈이 실제로 있다
      expect(await shown()).toEqual(seqs(1, 5));
      hold.release();
      // 그 연결이 받기 시작하면(watchMembers가 풀림) 화면이 한 번 더 읽어 6–10을 채운다
      expect(await poll(shown, (s) => s.length >= 10)).toEqual(seqs(1, 10));
      turn.emit(11, 15);
      await until(shown, (s) => s.includes(eventText(turn.turnId, 15)), '실시간 11–15');
      await sleep(300);
      expect(await shown()).toEqual(seqs(1, 15));
      expect(errors).toEqual([]);
    });

    it('webNoTeamControls — 홈·스튜디오·팀원 패널·문서함·자리·운영 설정 어디에도 팀 조작·자리 교체 버튼이 없고, "메인 에이전트에게 말하기"는 명령창의 대상과 초안을 채운다. 화면은 대표 메서드만 부른다', async () => {
      const { page, errors } = await rig.open();
      await rig.login(page);
      const seen: { screen: string; role: string; name: string }[] = [];
      const scan = async (screen: string) => {
        for (const c of await controls(page)) seen.push({ screen, ...c });
      };
      await scan('홈');
      await page.getByRole('button', { name: '알림함' }).click();
      await scan('알림함');
      await page.getByRole('button', { name: '알림함' }).click();
      await page.getByRole('button', { name: /이동/ }).click();
      await page.getByRole('dialog', { name: '빠른 이동' }).waitFor();
      await scan('빠른 이동');
      await page.locator('.palette-backdrop').click({ position: { x: 5, y: 5 } });
      await page.getByRole('dialog', { name: '빠른 이동' }).waitFor({ state: 'detached' });

      // 메인 에이전트 패널
      await page.locator('.main-agent-banner').click();
      const panel = page.getByRole('complementary', { name: '팀원 상세' });
      await panel.getByRole('button', { name: '메인 에이전트에게 말하기' }).waitFor();
      await scan('메인 에이전트 패널');
      const main = store().members.require(MAIN_AGENT_ID);
      const mainRole = (await panel.locator('.member-hero-copy .eyebrow').innerText()).trim();
      await panel.getByRole('button', { name: '메인 에이전트에게 말하기' }).click();
      expect(await commandDraft(page)).toEqual({ target: 'main', text: `${main.id} ${main.name}(${mainRole})에 대해: ` });
      expect(await panel.count()).toBe(0);

      // 프로젝트 스튜디오 · 프로젝트 설정 · 팀원 패널
      await page.locator('.project-card').filter({ hasText: '테스트 프로젝트' }).click();
      await page.getByRole('heading', { name: /테스트 프로젝트/ }).waitFor();
      await scan('스튜디오');
      await page.locator('.studio-heading').getByRole('button', { name: '메인 에이전트에게 말하기' }).click();
      expect(await commandDraft(page)).toEqual({ target: rig.h.projectId, text: '테스트 프로젝트에 대해: ' });
      await page.getByRole('button', { name: '프로젝트 설정' }).click();
      const settingsDialog = page.getByRole('dialog');
      await settingsDialog.waitFor();
      await scan('프로젝트 설정');
      await settingsDialog.getByRole('button', { name: '닫기' }).click();
      const devId = rig.h.members.developer!;
      const dev = store().members.require(devId);
      await page.locator('.member-card').filter({ hasText: dev.name }).click();
      await panel.getByRole('heading', { name: dev.name }).waitFor();
      await scan('팀원 패널');
      const role = (await panel.locator('.member-hero-copy .eyebrow').innerText()).trim();
      await panel.getByRole('button', { name: '메인 에이전트에게 말하기' }).click();
      expect(await commandDraft(page)).toEqual({ target: rig.h.projectId, text: `${dev.id} ${dev.name}(${role})에 대해: ` });
      expect(await panel.count()).toBe(0);

      // 문서함
      await page.locator('.sidebar').getByRole('button', { name: '문서함' }).click();
      await page.getByRole('heading', { name: '보고서', exact: true }).waitFor();
      await scan('문서함');

      // 자리와 인계 (두 탭)
      await page.locator('.sidebar').getByRole('button', { name: '자리와 인계' }).click();
      const seat = page.locator('.seat-screen');
      await seat.waitFor();
      await scan('자리와 인계');
      await seat.getByRole('button', { name: '메인 에이전트에게 말하기' }).first().click();
      expect(await commandDraft(page)).toEqual({ target: 'main', text: '메인 에이전트의 현재 상태에 대해: ' });
      await page.getByRole('tab', { name: '메인 일지' }).click();
      await scan('메인 일지');

      // 운영 설정 — 분류마다
      await page.locator('.sidebar').getByRole('button', { name: '운영 설정' }).click();
      const nav = page.getByRole('navigation', { name: '설정 분류' });
      await nav.waitFor();
      for (const label of (await nav.getByRole('button').allInnerTexts()).map((t) => t.trim())) {
        await nav.getByRole('button', { name: label, exact: true }).click();
        await sleep(200);
        await scan(`운영 설정 · ${label}`);
      }
      await page.getByRole('button', { name: '메인 에이전트에게 말하기' }).first().click();
      expect((await commandDraft(page)).target).toBe('main');

      expect(seen.filter((c) => c.name === '메인 에이전트에게 말하기').length).toBeGreaterThan(3);
      // 고르기·입력 칸도 모았다 (명령창의 대상·입력, 일지의 고르기)
      expect(seen.some((c) => c.role === 'combobox' && c.name === '명령 대상')).toBe(true);
      expect(seen.some((c) => c.role === 'textbox' && c.name === '명령 입력')).toBe(true);
      expect(seen.some((c) => c.screen === '메인 일지' && c.role === 'combobox')).toBe(true);
      expect(teamOps(seen)).toEqual([]);
      // 화면이 부른 것은 모두 대표 메서드다 — 숨긴 조작의 메서드를 부르지 않았다
      const methods = [...new Set(rig.proxy.invokes().map((i) => i.method))];
      expect(methods.filter((m) => !(OWNER_METHODS as readonly string[]).includes(m))).toEqual([]);
      expect(rig.proxy.log.filter((r) => r.invoke && r.status === 403)).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('webPhone390 — 390×844 휴대폰: 로그인·홈·스튜디오·팀원 패널·문서함·자리·설정에 가로 넘침이 없고, 연결 상태와 명령창이 화면 안에 있어 명령을 보낼 수 있다(입력 중 화면이 줄어도). 홈과 팀원 패널은 3D(three.js·GLB)를 받지 않는다', async () => {
      const { page, errors } = await rig.open({ phone: true, fresh: true });
      const from = rig.proxy.log.length;
      await rig.login(page, '/');
      expect(rig.h.core.deviceSessions.list().at(-1)?.deviceName).toBe('휴대폰 (Android)');
      const overflow = () => page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as Promise<number>;
      const inView = async (name: string, loc = page.getByRole('textbox', { name: '명령 입력' })) => {
        const box = await loc.boundingBox();
        const vp = page.viewportSize()!;
        return { name, inside: !!box && box.y >= 0 && box.y + box.height <= vp.height + 1 && box.x >= 0 && box.x + box.width <= vp.width + 1 };
      };
      const checks: { screen: string; overflow: number; inside: Record<string, boolean> }[] = [];
      const check = async (screen: string) => {
        checks.push({
          screen,
          overflow: await overflow(),
          inside: {
            composer: (await inView('명령 입력')).inside,
            send: (await inView('보내기', page.getByRole('button', { name: '보내기' }))).inside,
            status: (await inView('연결', page.getByRole('status', { name: '서버 연결 상태' }))).inside,
          },
        });
      };
      await check('홈');
      await page.locator('.project-card').filter({ hasText: '테스트 프로젝트' }).click();
      await page.getByRole('heading', { name: /테스트 프로젝트/ }).waitFor();
      await check('스튜디오');
      const dev = store().members.require(rig.h.members.developer!);
      await page.locator('.member-card').filter({ hasText: dev.name }).click();
      const panel = page.getByRole('complementary', { name: '팀원 상세' });
      await panel.getByRole('heading', { name: dev.name }).waitFor();
      // 팀원 패널은 휴대폰에서 명령창 위를 덮는다 — 패널에서는 패널의 닫기와 '메인 에이전트에게 말하기'(명령창을 채우고 닫는다)가 닿는지 잰다
      const talk = panel.getByRole('button', { name: '메인 에이전트에게 말하기' });
      await talk.scrollIntoViewIfNeeded();
      checks.push({
        screen: '팀원 패널',
        overflow: await overflow(),
        inside: {
          close: (await inView('팀원 패널 닫기', panel.getByRole('button', { name: '팀원 상세 닫기' }))).inside,
          talk: (await inView('메인 에이전트에게 말하기', talk)).inside,
        },
      });
      await panel.getByRole('button', { name: '팀원 상세 닫기' }).click();
      for (const [nav, heading] of [['문서함', '보고서'], ['자리와 인계', '자리와 인계'], ['운영 설정', '운영 설정']] as const) {
        await page.locator('.sidebar').getByRole('button', { name: nav }).click();
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        await check(nav);
      }
      expect(checks.filter((c) => c.overflow > 0 || Object.values(c.inside).some((v) => !v))).toEqual([]);

      // 입력 중 — 화상 키보드가 화면을 줄인 것처럼 높이를 줄여도 명령창과 보내기가 화면 안에 있고 보낼 수 있다
      await page.locator('.sidebar').getByRole('button', { name: '프로젝트' }).click();
      const box = page.getByRole('textbox', { name: '명령 입력' });
      await box.click();
      await page.setViewportSize({ width: PHONE.width, height: 500 });
      // 화면이 다시 배치될 때까지 기다리되, 끝내 밖이면 무엇이 밖인지로 실패한다
      const shrunk = await poll(
        async () => [await inView('명령 입력'), await inView('보내기', page.getByRole('button', { name: '보내기' }))].map((v) => v.inside),
        (v) => v.every(Boolean),
        5_000,
      );
      expect(shrunk).toEqual([true, true]);
      const text = `휴대폰에서 보낸 명령 ${rand()}`;
      await box.fill(text);
      await page.getByRole('button', { name: '보내기' }).click();
      await page.locator('.toast').filter({ hasText: '명령을 보냈습니다' }).waitFor();
      expect(ownerMessages('main').filter((m) => m.text === text)).toHaveLength(1);

      const heavy = rig.proxy.log.slice(from).filter((r) => /\/assets\/(Studio3D|characterKit|portrait)-|\.glb(\?|$)/.test(r.url)).map((r) => r.url);
      expect(heavy).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('webDemoFlagsInert — 실제 서버 화면에 ?officeDemo=cycle&fakeMode=server&capture=emergency&fakeConn=reconnecting&fakeUpload=fail을 붙여도 실제 자료 그대로이고 가짜·데모 동작이 없다. 내준 JS에는 가짜 브리지 코드가 없다', async () => {
      const { page, errors } = await rig.open();
      await rig.login(page);
      await page.goto(`${rig.origin}/?officeDemo=cycle&fakeMode=server&capture=emergency&fakeConn=reconnecting&fakeUpload=fail`);
      // 홈이나 데모가 여는 P-0003 스튜디오 가운데 먼저 나온 것을 기다리고, 어느 쪽인지 단언한다 (시간 초과가 아니라 무엇이 열렸는지로 실패)
      const home = page.getByRole('heading', { name: '프로젝트 현황' });
      // 스튜디오 화면의 머리(.studio-heading)로 가린다 — 홈의 부서 화면에도 프로젝트 이름이 든 제목이 있다(2026-11-13, 홈에 부서별 직원 화면)
      const demoStudio = page.locator('.studio-heading').getByRole('heading', { name: /세 번째 프로젝트/ });
      await home.or(demoStudio).first().waitFor();
      await connectionOpen(page);
      expect({ home: await home.count(), demoStudio: await demoStudio.count() }).toEqual({ home: 1, demoStudio: 0 });
      // 홈 그대로(데모가 여는 P-0003 스튜디오가 아니다), 실제 프로젝트 이름, 긴급 정지 결과 창 없음, 연결됨
      const cards = (await page.locator('.project-card .project-card-top strong').allInnerTexts()).map((t) => t.trim());
      expect(cards.slice(0, 3)).toEqual(['테스트 프로젝트', '두 번째 프로젝트', '세 번째 프로젝트']);
      expect(cards).toEqual(store().projects.list({ state: 'active' }).map((p) => p.name));
      expect(await page.locator('.studio-heading').count()).toBe(0);
      expect(await page.getByRole('dialog', { name: '긴급 정지 결과' }).count()).toBe(0);
      expect(await page.getByText('긴급 정지 결과').count()).toBe(0);
      expect(await page.getByRole('status', { name: '서버 연결 상태' }).innerText()).toContain('서버 연결됨');
      expect(await page.evaluate('window.wook.platform')).toBe('web');
      // 업로드도 실제로 된다 (fakeUpload=fail 무시)
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '파일 첨부' }).click();
      await (await chooser).setFiles({ name: 'flag.txt', mimeType: 'text/plain', buffer: Buffer.from('flag') });
      await page.locator('.upload-chip').filter({ hasText: '첨부 준비됨' }).waitFor();
      expect(await page.locator('.upload-chip [role=alert]').count()).toBe(0);
      await page.getByRole('button', { name: 'flag.txt 첨부 제거' }).click();

      // 내준 JS 전부(처음 불러온 것과 나중에 불러올 조각)에 가짜 브리지 표시가 없다
      const served = readdirSync(join(rig.webDir, 'assets')).filter((f) => f.endsWith('.js'));
      expect(served.length).toBeGreaterThan(2);
      for (const f of served) {
        // 그 화면이 같은 주소에서 받는 그대로 — 브라우저 안에서 받아 본다
        const res = await page.evaluate(async (path) => {
          const r = await fetch(path);
          return { status: r.status, body: await r.text() };
        }, `/assets/${f}`);
        expect(res.status, f).toBe(200);
        const body = res.body;
        expect(FAKE_BRIDGE_MARKERS.filter((m) => body.includes(m)), f).toEqual([]);
      }
      expect(errors).toEqual([]);
    });
  });
}
