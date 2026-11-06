/**
 * 브라우저 끝까지 시험의 무대 (리드 결정 S8-7, SERVER_DESIGN 10.8 '새 테스트'):
 * - 욱채 서버를 이 프로세스 안에서 띄운다: 서버 모드 하네스(모의 메인 에이전트 — 명령에 답이 온다, 모의 프로젝트 3개) + startServer(publicOrigin, webDir).
 *   웹 화면은 globalSetup이 이번 실행에 한 번 만든 서버용 빌드(npm run build:web과 같은 remote 모드)다
 * - 공개 주소는 https://wook-e2e.test:<프록시 포트> — 시험 안의 TLS 앞단(proxy.ts)이 받아 루프백 서버로 넘긴다. 브라우저는 --host-resolver-rules로 그
 *   이름을 127.0.0.1로 찾는다. 구글은 가짜 구글 서버(기기 코드)다 — 진짜 구글에 묻지 않는다
 * - 브라우저: headless Microsoft Edge 하나(channel msedge). 시험마다 새 브라우저 문맥(쿠키 따로). 프로필·내려받기는 OS 임시 폴더(실행 폴더) 안
 * - 팀원 CLI 이벤트: cliTurn()이 팀원의 실행 중 턴 하나를 만들고, emit()이 턴 실행기(turns.ts onEvents)처럼 이벤트 파일에 줄을 쓰고 cliEvents 토픽을 낸다
 * 실패한 시험의 화면은 WOOK_WEB_SHOTS 폴더가 있으면 거기 저장한다
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { MemberId, Turn } from '@shared/domain';
import type { CliEvent } from '@shared/events';
import type { WookBridge } from '@shared/ipc';
import { createHarness, type Harness } from '../e2e/harness';
import type { BackendOperator } from '../../src/main/backend/types';
import { startServer, type RunningServer } from '../../src/server/server';
import { SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGoogle, type FakeGoogle } from '../server/fakeGoogle';
import { invokeHttp, memoryLogger, remoteBackendOf } from '../server/helpers';
import { E2E_HOST, startProxy, type E2eProxy } from './proxy';

export const OWNER_EMAIL = 'owner@example.com';
/** 데스크톱 화면 크기 — 스튜디오는 대표의 화면 선택 ?studio3d=0으로 2D(WebGL을 돌리지 않는다 — PC를 가볍게) */
export const DESKTOP = { width: 1366, height: 900 } as const;
export const PHONE = { width: 390, height: 844 } as const;
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 조건이 참이 될 때까지 (값을 돌려준다) */
export async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, label: string, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() - start > timeoutMs) throw new Error(`시간 초과 (${timeoutMs}ms): ${label} — 마지막 값 ${JSON.stringify(last)}`.slice(0, 2000));
    await sleep(100);
  }
}

/**
 * 조건이 참이 되거나 시간이 다 될 때까지 읽고 마지막 값을 돌려준다 — 던지지 않는다. 기다린 것이 단언하는 동작일 때 쓴다: 시험은 그 값을 expect로 견주어,
 * 동작이 틀리면 시간 초과가 아니라 무엇이 틀렸는지로 실패한다
 */
export async function poll<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const last = await read();
    if (ok(last) || Date.now() - start > timeoutMs) return last;
    await sleep(100);
  }
}

export interface OpenPage {
  context: BrowserContext;
  page: Page;
  /** 잡지 못한 화면 오류(pageerror)와 CSP 위반 */
  errors: string[];
}

export interface Rig {
  h: Harness;
  g: FakeGoogle;
  op: BackendOperator;
  server: RunningServer;
  proxy: E2eProxy;
  browser: Browser;
  origin: string;
  webDir: string;
  /** 대표 이메일이 없으면 운영자 설정 코드로 정한다 (webLogin이 먼저 화면으로 정한다 — 시험 하나만 돌릴 때를 위해) */
  ensureOwner(): Promise<void>;
  /**
   * 새 브라우저 문맥 — 화면으로 로그인한 적이 있으면 그 쿠키(세션)를 싣고 연다. 서버는 기기 코드 로그인 시작을 1분에 5번까지 받으므로(S3-11) 로그인 화면은
   * webLogin·webPhone390만 거치고, 다른 시험은 그 로그인이 받은 세션 쿠키를 쓴다. fresh면 쿠키 없이
   */
  open(o?: { phone?: boolean; fresh?: boolean }): Promise<OpenPage>;
  /**
   * 로그인한 홈까지: 세션 쿠키가 있으면 그 주소를 열고, 없으면 화면으로 로그인한다(로그인 화면의 'Google 계정으로 로그인' → 기기 코드 → 가짜 구글이 허락 →
   * 홈) — 받은 쿠키는 다음 문맥이 쓴다
   */
  login(page: Page, path?: string): Promise<void>;
  /** 화면으로 로그인한 문맥의 쿠키를 다음 문맥이 쓰게 둔다 */
  remember(context: BrowserContext): Promise<void>;
  /** 실패한 시험의 화면을 남기고 이 시험의 문맥을 닫는다 */
  closePages(failedName: string | null): Promise<void>;
  close(): Promise<void>;
}

export async function startRig(webDir: string): Promise<Rig> {
  const g = await startFakeGoogle();
  const h = await createHarness({ mode: 'server', googleDevice: { endpoints: g.endpoints } });
  // 모의 프로젝트를 둘 더 — P-0003이 있어야 ?officeDemo(가짜 화면은 P-0003을 연다)가 실제 서버에서 아무 일도 하지 않는지 보인다
  for (const name of ['두 번째 프로젝트', '세 번째 프로젝트']) {
    const dir = join(mkdtempSync(join(tmpdir(), 'wook-test-web-proj-')), name);
    const p = await h.internal('projects.create', { mode: 'new', path: dir, name, checkCommands: [] });
    await h.internal('projects.setMock', p.id, { enabled: true, speed: 25, defaultScenario: 'normal' });
  }
  const backend = remoteBackendOf(h);
  const op = backend.operator;
  // 서버 PC 운영자 몫 — 구글 클라이언트(가짜 구글의 것)와 보안 비밀 (server.json·비밀 저장소, S3-8)
  op.applyServerConfig({ googleClientId: FAKE_CLIENT_ID }, 'server.json');
  await op.setGoogleClientSecret(FAKE_CLIENT_SECRET);
  let proxy: E2eProxy | null = null;
  let server: RunningServer | null = null;
  let browser: Browser;
  try {
    proxy = await startProxy();
    server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test', publicOrigin: proxy.origin, webDir });
    proxy.setUpstream(server.port);
    browser = await chromium.launch({
      channel: 'msedge',
      headless: true,
      // 인증서 오류 무시는 브라우저 전체에도 건다 — 문맥의 ignoreHTTPSErrors만으로는 서비스 워커 등록이 'An SSL certificate error occurred when fetching
      // the script'로 거부된다(11-05 확인, webNotifications). 시험 안의 자체 서명 인증서에만 닿는다
      args: [`--host-resolver-rules=MAP ${E2E_HOST} 127.0.0.1`, '--no-proxy-server', '--ignore-certificate-errors'],
    });
  } catch (error) {
    // 반쯤 띄운 것을 닫고 실패를 그대로 알린다 (Edge가 있는데 뜨지 않으면 건너뛰지 않고 실패)
    await server?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    await h.close().catch(() => undefined);
    await g.close().catch(() => undefined);
    throw error;
  }
  return assemble({ h, g, op, server, proxy, browser, webDir });
}

function assemble({ h, g, op, server, proxy, browser, webDir }: { h: Harness; g: FakeGoogle; op: BackendOperator; server: RunningServer; proxy: E2eProxy; browser: Browser; webDir: string }): Rig {
  const opened: OpenPage[] = [];
  const shots = process.env['WOOK_WEB_SHOTS'] ?? null;
  let signedIn: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;

  const rig: Rig = {
    h,
    g,
    op,
    server,
    proxy,
    browser,
    origin: proxy.origin,
    webDir,
    async ensureOwner() {
      if (!h.core.serverLogin.setupRequired()) return;
      const code = op.issueSetupCode()!.code;
      const r = await invokeHttp(server.url, null, 'auth.setupOwner', [code, OWNER_EMAIL]);
      if (r.status !== 200) throw new Error(`대표 이메일을 정하지 못했습니다: ${r.status} ${r.text}`);
    },
    async open(o = {}) {
      const context = await browser.newContext({
        ...(signedIn && !o.fresh ? { storageState: signedIn } : {}),
        ignoreHTTPSErrors: true,
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
        viewport: o.phone ? PHONE : DESKTOP,
        ...(o.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: PHONE_UA } : {}),
      });
      context.setDefaultTimeout(15_000);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // CSP 위반도 오류로 — 서버의 CSP 머리(S8-5)가 화면이 쓰는 것을 막으면 시험이 안다
      page.on('console', (m) => {
        if (m.type() === 'error' && /Content Security Policy|Refused to (load|connect|execute|apply)/.test(m.text())) errors.push(`CSP: ${m.text()}`);
      });
      const item = { context, page, errors };
      opened.push(item);
      return item;
    },
    async login(page, path = '/?studio3d=0') {
      await rig.ensureOwner();
      const hasSession = (await page.context().cookies()).some((c) => c.name === SESSION_COOKIE);
      await page.goto(`${proxy.origin}${path}`);
      if (!hasSession) {
        await page.getByRole('button', { name: 'Google 계정으로 로그인' }).click();
        await page.locator('.device-user-code').waitFor();
        g.answer(g.lastDeviceCode(), { kind: 'ok' });
      }
      await page.getByRole('heading', { name: '프로젝트 현황' }).waitFor({ timeout: 20_000 });
      await connectionOpen(page);
      if (!hasSession && !signedIn) await rig.remember(page.context());
    },
    async remember(context) {
      signedIn = await context.storageState();
    },
    async closePages(failedName) {
      for (const [i, item] of opened.splice(0).entries()) {
        if (failedName && shots) {
          mkdirSync(shots, { recursive: true });
          const base = join(shots, `${failedName.replace(/[^\w가-힣-]+/g, '_').slice(0, 60)}-${i}`);
          await item.page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => undefined);
          writeFileSync(`${base}.txt`, `${item.page.url()}\n${item.errors.join('\n')}\n`);
        }
        await item.context.close().catch(() => undefined);
      }
    },
    async close() {
      await rig.closePages(null);
      await browser.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      await h.close().catch(() => undefined);
      await g.close().catch(() => undefined);
    },
  };
  return rig;
}

type BrowserWindow = { wook: WookBridge };

/** 연결 상태가 open이 될 때까지 (브리지를 보기만 한다) — open의 runId */
export async function connectionOpen(page: Page, timeoutMs = 20_000): Promise<string> {
  return page.evaluate(
    (ms) =>
      new Promise<string>((resolve, reject) => {
        const w = globalThis as unknown as BrowserWindow;
        const timer = setTimeout(() => reject(new Error('연결이 열리지 않았습니다')), ms);
        let off: (() => void) | undefined;
        off = w.wook.web!.onConnection((s) => {
          if (s.status !== 'open') return;
          clearTimeout(timer);
          resolve(s.runId);
          setTimeout(() => off?.(), 0);
        });
      }),
    timeoutMs,
  );
}

/** 지금 연결 상태 (보기만) */
export function connectionStatus(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const w = globalThis as unknown as BrowserWindow;
        let off: (() => void) | undefined;
        off = w.wook.web!.onConnection((s) => {
          resolve(s.status);
          setTimeout(() => off?.(), 0);
        });
      }),
  );
}

/** 명령창의 대상과 글 */
export async function commandDraft(page: Page): Promise<{ target: string; text: string }> {
  return {
    target: await page.getByRole('combobox', { name: '명령 대상' }).inputValue(),
    text: await page.getByRole('textbox', { name: '명령 입력' }).inputValue(),
  };
}

/** 화면 글과 견주려고 공백을 하나로 (말풍선 <p>는 줄바꿈을 빈칸으로 보인다) */
export const norm = (text: string) => text.replace(/\s+/g, ' ').trim();

/** 대화 기록을 펼쳐 말풍선 글을 읽는다 (역할별 class: bubble-owner·bubble-main_agent·bubble-system). 글은 norm으로 */
export async function conversation(page: Page): Promise<{ role: string; text: string }[]> {
  const open = page.getByRole('button', { name: '대화 기록 펼치기' });
  if (await open.count()) await open.click();
  const bubbles = page.locator('.conversation .bubble');
  const out: { role: string; text: string }[] = [];
  for (const b of await bubbles.all()) {
    const cls = (await b.getAttribute('class')) ?? '';
    out.push({ role: /bubble-(\S+)/.exec(cls)?.[1] ?? '', text: norm(await b.locator('p').first().innerText()) });
  }
  return out;
}

/** 대화 기록에 그 대표 글이 보일 때까지 기다린 뒤 몇 번 보이는지 */
export async function ownerBubbles(page: Page, text: string, timeoutMs = 15_000): Promise<number> {
  const want = norm(text);
  const list = await until(() => conversation(page), (b) => b.some((x) => x.role === 'owner' && x.text === want), `대화 기록의 대표 글 '${want.slice(0, 40)}'`, timeoutMs);
  return list.filter((x) => x.role === 'owner' && x.text === want).length;
}

/**
 * 지금 화면(또는 범위)의 접근성 트리에서 조작할 수 있는 것들의 이름 — role과 이름. 누르는 것(button·link·menuitem·tab·switch·checkbox·radio·option)과
 * 고르고 넣는 것(combobox·listbox·textbox·spinbutton·slider — 팀 조작이 드롭다운이나 입력 칸이어도 보이게, 리드 결정 S8-21)
 */
export async function controls(page: Page, scope = 'body'): Promise<{ role: string; name: string }[]> {
  const tree = await page.locator(scope).first().ariaSnapshot();
  const out: { role: string; name: string }[] = [];
  for (const line of tree.split('\n')) {
    const m = /^\s*-\s+(button|link|menuitem|tab|switch|checkbox|radio|option|combobox|listbox|textbox|spinbutton|slider)\s+"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) out.push({ role: m[1]!, name: m[2]!.replace(/\\"/g, '"') });
  }
  return out;
}

export interface CliTurn {
  turnId: string;
  memberId: MemberId;
  /** seq from..to의 글 이벤트를 낸다 — 이벤트 파일에 쓰고(members.getEvents가 읽는 곳) cliEvents 토픽으로 (turns.ts onEvents와 같은 순서) */
  emit(from: number, to: number): CliEvent[];
}

/** 이벤트 글 — 턴과 순번이 글에 들어 있어 화면에서 (turnId, seq)를 읽는다 */
export const eventText = (turnId: string, seq: number) => `${turnId}#${String(seq).padStart(3, '0')}`;

/** 팀원의 실행 중 턴 하나 (모의 CLI를 띄우지 않고 저장소에 둔다 — 이벤트가 나오는 때를 시험이 정한다) */
export function cliTurn(h: Harness, memberId: MemberId): CliTurn {
  const ctx = h.core.ctx;
  const m = ctx.store.members.require(memberId);
  const dir = join(h.dataDir, 'web-e2e-events');
  mkdirSync(dir, { recursive: true });
  const now = ctx.now();
  const turnId = ctx.store.nextId('turn');
  const eventsFile = join(dir, `${turnId}.jsonl`);
  writeFileSync(eventsFile, '');
  const turn: Turn = {
    id: turnId,
    sessionId: 'S-web-e2e',
    memberId,
    projectId: m.projectId,
    taskId: null,
    directiveId: null,
    sessionKind: 'task',
    slotClass: 'general',
    queueEntryIds: [],
    isResume: false,
    aiKind: 'claude',
    mock: true,
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    process: { state: 'running', pid: null, spawnedAt: null, exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
    endReason: null,
    endDetail: '',
    stepsCompleted: 0,
    toolCalls: 0,
    usage: null,
    bypass: 'requested',
    mcp: 'unknown',
    eventsFile,
    eventCount: 0,
    finalText: null,
  };
  ctx.store.turns.insert(turn);
  return {
    turnId,
    memberId,
    emit(from, to) {
      const ts = new Date().toISOString();
      const events: CliEvent[] = [];
      for (let seq = from; seq <= to; seq++) events.push({ kind: 'text', text: eventText(turnId, seq), seq, ts, turnId });
      appendFileSync(eventsFile, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
      ctx.bus.emit('cliEvents', { memberId, turnId, events });
      return events;
    },
  };
}
