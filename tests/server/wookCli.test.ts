/**
 * wookCli (SERVER_DESIGN 10.7, 리드 결정 S7-5·S7-7·S7-16): 빌드한 `wook.mjs`(vite.server.config.ts의 둘째 입구)만으로 외부 에이전트가 한 턴을 끝낸다 —
 * 운영자가 등록·배정하면 wook seat claim → wook work next --wait → wook work progress → wook tool → wook screen capture → wook work done, 답은
 * command.history에 남는다. 끝 코드 3(401: 틀린 키·폐기된 키), 4(409: 끝난 턴·긴급 정지), 5(닿지 못함: 서버 없음·끝난 서버를 가리키는 agent-endpoint.json·
 * 닫힌 포트)와 1(배정되지 않음·도구의 거부)을 본다.
 * - 서버는 하네스 백엔드를 감싼 프로세스 안 서버(메인 모의 실행은 시작 전에 켬 — 리드 결정 S6-19), 화면 도우미는 가짜(tests/fixtures/desktop — 화면을
 *   찍거나 입력을 보내지 않는다). wook은 시험이 띄우는 자식 프로세스이고 afterAll에서 남은 것을 끝낸다
 * - 집 폴더(USERPROFILE·HOME)와 데이터 폴더(WOOK_DATA_DIR)는 이 시험의 임시 폴더다 — 실제 ~/.wook는 만들지도 바꾸지도 않는다(끝에 확인)
 * - 키·임대 ID·턴 토큰은 시험 출력에 내지 않는다(참거짓으로만 본다). wook의 어떤 출력·서버 기록에도 없다
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { agentEndpointPath } from '../../src/server/server';
import { createFakeDesktop, type FakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { LOOSE_LIMITS } from '../regression/guiRig';
import { agentCall, bootExternal, cleanupAll, endChildren, situation, until, type ExternalEnv } from './externalRig';
import { buildServerTo, REPO, removeDir, runClient, sleep, testBuildDir, windowsAcl, windowsMe } from './helpers';

const LEASE_MS = 4000;
let outDir = '';
let wookEntry = '';
let x: ExternalEnv;
let fake: FakeDesktop;
let key = '';
let home = '';
const dirs: string[] = [];
const children: ChildProcess[] = [];
/** wook이 낸 모든 글 — 끝에 키·임대·토큰이 없는지 본다 */
const printed: string[] = [];
/** 이 시험에서 쥔 임대 ID·턴 토큰 (state.json에서 읽음 — 출력하지 않는다) */
const held = new Set<string>();
const realWook = join(homedir(), '.wook');
/** 실제 ~/.wook의 모습 — 없으면 null, 있으면 그 안의 모든 항목(상대 경로·크기·수정 시각). 폴더의 수정 시각만으로는 안의 파일을 고쳐 쓴 것을 모른다 */
function wookShape(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const out: string[] = [];
  const walk = (p: string, rel: string): void => {
    const st = statSync(p);
    out.push(`${rel}|${st.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n), `${rel}/${n}`);
  };
  walk(dir, '.');
  return out.join('\n');
}
const realWookBefore = wookShape(realWook);

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-wookcli-${tag}-`));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  outDir = testBuildDir('wookcli');
  buildServerTo(outDir);
  wookEntry = join(outDir, 'wook.mjs');
  fake = createFakeDesktop({});
  x = await bootExternal({ desktop: { launcher: fake.launcher, timeouts: { READY: 5000 }, limits: LOOSE_LIMITS }, timing: { agentLeaseMs: LEASE_MS } });
  // 시작 때 Claude(모의 메인)의 화면 확인 업무가 돈다 — 끝날 때까지
  await until(() => x.h.core.turns.count() === 0 && x.h.core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).length === 0, '시작 때 화면 확인', 60_000);
  home = tempDir('home');
}, 240_000);

afterAll(async () => {
  // 한 단계가 던져도 뒤 단계를 건너뛰지 않는다 — 임시 집 폴더에는 agent.json(키)·state.json(임대·턴 토큰)이 있다 (리드 결정 S7-20 TI-9 — S7F2s)
  await cleanupAll([
    () => endChildren(children),
    () => x?.close(),
    () => fake?.cleanup(),
    ...dirs.map((d) => () => removeDir(d)),
    () => (outDir ? removeDir(outDir) : undefined),
    // 실제 ~/.wook는 만들지도 바꾸지도 않았다 (리드 지시)
    () => expect(wookShape(realWook)).toBe(realWookBefore),
  ]);
});

interface WookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 빌드한 wook을 띄운다 — 집 폴더·데이터 폴더는 이 시험의 것. env 값이 undefined면 그 변수를 지운다 */
function wookChild(args: string[], o: { env?: Record<string, string | undefined>; home?: string } = {}): { child: ChildProcess; done: Promise<WookRun> } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['WOOK_AGENT_KEY', 'WOOK_AGENT_URL', 'WOOK_DATA_DIR']) delete env[k];
  const h = o.home ?? home;
  Object.assign(env, { USERPROFILE: h, HOME: h, WOOK_DATA_DIR: x.h.dataDir });
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = spawn(process.execPath, [wookEntry, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => (stdout += c));
  child.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  const done = new Promise<WookRun>((r) =>
    child.once('close', (code) => {
      printed.push(stdout, stderr);
      r({ code, stdout, stderr });
    }),
  );
  return { child, done };
}

const wook = (args: string[], o: { env?: Record<string, string | undefined>; home?: string } = {}): Promise<WookRun> => wookChild(args, o).done;

/** state.json의 임대와 받은 턴 (값은 출력하지 않는다) */
function state(h = home): { leaseId: string; turn: { turnId: string; token: string } | null } {
  const s = JSON.parse(readFileSync(join(h, '.wook', 'state.json'), 'utf8')) as { leaseId: string; turn: { turnId: string; token: string } | null };
  held.add(s.leaseId);
  if (s.turn) held.add(s.turn.token);
  return s;
}

/**
 * 이 시험이 스스로 보내는 heartbeat (리드 후속 2, 11-11) — 실제 에이전트처럼 명령과 명령 사이에도 임대를 살린다(AGENT_GUIDE 3절 '그 밖의 때는 wook seat heartbeat').
 * 4초 임대에서 한 번씩 뜨는 `wook`(node 시작·ACL 확인·hello)이 부하에 느려지면 임대가 끝나 턴이 비정상 종료로 끝났다. 500ms마다 state.json의 임대로 `seat/heartbeat`를
 * 직접 보낸다(값은 출력하지 않는다). `wook work next --wait`가 스스로 heartbeat를 보내는지 보는 동안은 멈춘다(pause). 시험이 끝나면 멈춘다
 */
function keepLease(h = home): { pause(): Promise<void>; resume(): void } {
  let paused = false;
  let busy: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (paused || busy || !key) return;
    let leaseId: string | null = null;
    try {
      leaseId = (JSON.parse(readFileSync(join(h, '.wook', 'state.json'), 'utf8')) as { leaseId?: string }).leaseId ?? null;
    } catch {
      leaseId = null;
    }
    if (!leaseId) return;
    busy = agentCall(x.api, key, '/seat/heartbeat', { body: { leaseId } })
      .catch(() => null)
      .finally(() => {
        busy = null;
      });
  }, 500);
  onTestFinished(async () => {
    clearInterval(timer);
    await busy;
  });
  return {
    async pause() {
      paused = true;
      await busy;
    },
    resume() {
      paused = false;
    },
  };
}

/** 쌓인 메인 일과 살아 있는 메인 턴이 없게 한다 — 앞 시험이 어떻게 끝났든(다시 넣은 일 포함) 이 에이전트가 받아 마친다. 임대가 있어야 한다 */
async function drainMain(): Promise<void> {
  const busy = (): boolean => x.h.core.turns.count() > 0 || x.h.core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).length > 0;
  for (let i = 0; i < 6 && busy(); i++) {
    const got = await wook(['work', 'next', '--wait']);
    expect([got.code, got.stderr]).toEqual([0, '']);
    const f = join(tempDir('drain'), 'ok.md');
    writeFileSync(f, '정리');
    expect((await wook(['work', 'done', (JSON.parse(got.stdout) as { turnId: string }).turnId, '--file', f])).code).toBe(0);
  }
  await until(() => !busy(), '쌓인 메인 일이 없음', 30_000, () => situation(x));
}

/** 지금 사용자만 읽는 ~/.wook/agent.json (AGENT_GUIDE의 순서: 빈 파일 → 권한 좁히기 → 내용) */
function writeKeyFile(h: string, k: string): void {
  mkdirSync(join(h, '.wook'), { recursive: true });
  const f = join(h, '.wook', 'agent.json');
  if (process.platform === 'win32') {
    closeSync(openSync(f, 'w'));
    execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe'), [f, '/inheritance:r', '/grant:r', `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}:F`], { stdio: 'ignore', windowsHide: true });
    writeFileSync(f, JSON.stringify({ key: k }));
  } else {
    writeFileSync(f, JSON.stringify({ key: k }), { mode: 0o600 });
    chmodSync(f, 0o600);
  }
}

describe('wookCli — 빌드한 wook.mjs만으로 한 턴 (S7-5·S7-7)', () => {
  it('빌드는 두 입구를 낸다: 서버 명령 index.mjs는 그대로 돌고 wook.mjs는 쓰임새를 낸다', async () => {
    expect(existsSync(join(outDir, 'index.mjs'))).toBe(true);
    const server = runClient(join(outDir, 'index.mjs'), ['--help']);
    expect([server.code, server.stdout.startsWith('욱채 서버 (4단계: 이 PC의 루프백')]).toEqual([0, true]);
    const help = await wook(['--help']);
    expect([help.code, help.stdout.startsWith('욱채 에이전트 명령 wook')]).toEqual([0, true]);
    const bad = await wook(['tool', 'get_overview', '--json', '{"secret":"wsk_SECRETX"']);
    expect([bad.code, bad.stderr.split('\n')[0], bad.stderr.includes('SECRETX')]).toEqual([
      2,
      "--json의 글을 JSON으로 읽을 수 없습니다 — 예: --json '{}' (적은 값은 보이지 않습니다). PowerShell 5.1은 따옴표를 지워 넘기므로 --json-file <파일>을 쓰세요",
      false,
    ]);
  });

  it('등록·배정 → claim → 화면 확인 업무 → 대표 명령 한 턴(진행·도구·캡처·마침)을 wook만으로 끝낸다', async () => {
    const ctx = x.h.core.ctx;
    key = x.operator.addExternalAgent('그록봇').key;
    writeKeyFile(home, key);
    await x.operator.assignSeat('external:X-0001', true);
    // 명령과 명령 사이에도 임대를 살린다 (claim 뒤 state.json이 생기면 시작한다)
    const keeper = keepLease();

    // 보기 (임대 없음)
    const st = await wook(['seat', 'status']);
    expect([st.code, st.stdout, st.stderr]).toEqual([0, '메인 자리: 세대 2 · 앉아 있음 · 보유자 그록봇 (외부 에이전트 X-0001)\n  이 에이전트에게 배정됨: 예\n  이 에이전트의 임대: 없음 — wook seat claim으로 잡습니다\n', '']);

    // claim — 임대는 지금 사용자만 읽는 state.json에, 출력에는 없다
    const claim = await wook(['seat', 'claim']);
    expect(claim.code).toBe(0);
    const lines = claim.stdout.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      '메인 자리를 잡았습니다: 그록봇(X-0001), 세대 2',
      '  임대 4초 — 1초마다 wook seat heartbeat를 보내세요. 임대를 싣는 요청(heartbeat·work next·progress·done)만 임대를 늘립니다',
      '  일 받기: wook work next --wait (한 번에 25초까지 기다리고 되풀이합니다)',
    ]);
    // 자리를 이 에이전트에게 옮긴 세대 — 그 세대의 인계 꾸러미가 claim에 온다 (리드 결정 S7-20 TI-5 — S7F2s)
    expect(lines[3]).toBe(`  인계 꾸러미: 있음 (세대 2, ${x.h.core.seat.handover(2)!.chars}자)`);
    expect(lines[4]).toBe(`  임대는 ${join(home, '.wook', 'state.json')}에 두었습니다 (지금 사용자만 읽는 파일)`);
    state();
    if (process.platform === 'win32') {
      const acl = windowsAcl(join(home, '.wook', 'state.json'));
      expect([acl.protected, acl.rules.map((r) => [r.id, r.type])]).toEqual([true, [[windowsMe(), 'Allow']]]);
    } else expect(statSync(join(home, '.wook', 'state.json')).mode & 0o777).toBe(0o600);

    // 첫 일은 이 보유자의 화면 확인 (S7-14) — wook tool로 답한다
    const check = await wook(['work', 'next', '--wait']);
    expect(check.code).toBe(0);
    const checkItem = JSON.parse(check.stdout) as { turnId: string; message: string; mcp: Record<string, unknown>; kind: string };
    expect(checkItem.message).toContain('(화면 확인 g2:external:X-0001)');
    expect(Object.keys(checkItem.mcp)).toEqual(['url']);
    expect(state().turn?.turnId).toBe(checkItem.turnId);
    const shown = await wook(['tool', 'get_screen_check']);
    // REST 도구 길은 이미지를 싣지 않는다 — image는 'file_only'이고 시험 이미지는 file의 PNG다 (리드 결정 S7-17 F6 — S7F1a)
    expect([shown.code, (JSON.parse(shown.stdout) as { image: string }).image]).toEqual([0, 'file_only']);
    const answered = await wook(['tool', 'answer_screen_check', '--json', JSON.stringify({ code: '0000', request_id: 'rq-wook-1' })]);
    expect(answered.code).toBe(0);
    expect(['verified', 'failed']).toContain((JSON.parse(answered.stdout) as { result: string }).result);
    const checkAnswer = join(tempDir('ans'), 'check.md');
    writeFileSync(checkAnswer, '화면 확인에 답했습니다');
    const checkDone = await wook(['work', 'done', checkItem.turnId, '--file', checkAnswer]);
    expect([checkDone.code, checkDone.stdout]).toEqual([0, `턴을 마쳤습니다: ${checkItem.turnId} (끝 까닭 completed)\n`]);
    expect(state().turn).toBeNull();

    // 대표 명령 — wook work next --wait가 일을 기다리는 동안 heartbeat가 임대(4초)를 살린다 (S7-16 3 (d)): 롱폴 한 번(25초)은 시작 때만 임대를 늘린다 — 스케줄러가 2초마다 만료를 본다.
    // 이 동안은 시험의 heartbeat를 멈춘다 — 임대를 살리는 것은 wook 자신뿐이다
    await keeper.pause();
    const waiting = wookChild(['work', 'next', '--wait']);
    await sleep(LEASE_MS + 3500);
    expect(waiting.child.exitCode).toBeNull();
    await x.owner$('command.send', { target: 'main', text: '오늘 할 일을 정리해 줘' });
    const got = await waiting.done;
    keeper.resume();
    expect([got.code, got.stderr]).toEqual([0, '']);
    const item = JSON.parse(got.stdout) as { turnId: string; message: string; kind: string; cwd: string; instructions: string; generation: number };
    // instructions는 서버가 띄우는 CLI의 메인 대화 시스템 프롬프트 그대로 — claim의 rules와 같은 글 (리드 결정 S7-20 TI-5 — S7F2s)
    expect([item.kind, item.generation, item.message.includes('오늘 할 일을 정리해 줘'), item.instructions === x.h.core.turns.mainRules().rules]).toEqual(['main_general', 2, true, true]);
    expect(state().turn?.turnId).toBe(item.turnId);

    const prog = await wook(['work', 'progress', item.turnId, '--text', 'wook으로 정리하는 중']);
    expect([prog.code, prog.stdout]).toEqual([0, `진행 상황을 남겼습니다: ${item.turnId}\n`]);
    const overview = await wook(['tool', 'get_overview', '--json', '{}']);
    expect(overview.code).toBe(0);
    expect(typeof JSON.parse(overview.stdout)).toBe('object');
    // 인자 파일 (PowerShell 5.1은 --json의 따옴표를 지운다 — S7-19 C7): UTF-8 JSON 파일
    const argsFile = join(tempDir('args'), 'args.json');
    writeFileSync(argsFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}', 'utf8')]));
    const viaFile = await wook(['tool', 'get_work_context', '--json-file', argsFile]);
    expect([viaFile.code, typeof JSON.parse(viaFile.stdout)]).toEqual([0, 'object']);
    // 도구의 거부는 1 (200 ok:false — 도구의 코드와 글)
    const refused = await wook(['tool', 'screen_capture', '--json', '{"max_width":5}']);
    expect([refused.code, refused.stdout]).toEqual([1, '']);
    expect(refused.stderr).toMatch(/^도구 거부\(screen_capture\) — invalid: /);
    // 캡처: screen_capture → GET screens/{id} — 서버가 보관한 PNG 그대로
    const png = join(tempDir('cap'), 'a.png');
    const cap = await wook(['screen', 'capture', '--out', png]);
    expect(cap.code).toBe(0);
    const m = /^화면을 찍어 저장했습니다: (.+) \(캡처 (SC-\d+), (\d+)×(\d+), (\d+)바이트, 30초 동안 gui_input에 씁니다\)/.exec(cap.stdout);
    expect(m?.[1]).toBe(png);
    expect(readFileSync(png).equals(x.h.core.desktop.keptPng(m![2]!)!.bytes)).toBe(true);

    // UTF-8이 아닌 답 파일은 보내지 않는다 (S7-19 C2 — 리뷰 P3a·P3b): cp949(이 PC의 ANSI)·UTF-16LE(PowerShell 5.1의 >) → 2, 턴은 그대로 살아 있다
    for (const [what, bytes] of [
      ['cp949', Buffer.from('bec8b3e7c7cfbcbcbfe4', 'hex')],
      ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('답을 정리했습니다', 'utf16le')])],
    ] as const) {
      const f = join(tempDir('ans'), `${what}.md`);
      writeFileSync(f, bytes);
      const refused = await wook(['work', 'done', item.turnId, '--file', f]);
      const sentence = `마지막 답 파일(--file)이 ${what === 'cp949' ? 'UTF-8이 아닙니다' : 'UTF-16입니다'} — UTF-8로 저장하세요 (PowerShell 5.1: Set-Content -Encoding utf8`;
      expect([what, refused.code, refused.stdout, refused.stderr.startsWith(sentence)]).toEqual([what, 2, '', true]);
      expect(ctx.store.turns.get(item.turnId)!.endedAt).toBeNull();
    }
    const replacement = String.fromCharCode(0xfffd);
    expect(ctx.store.conversation.list({ ref1: 'main' }).some((c) => c.role === 'main_agent' && c.text.includes(replacement))).toBe(false);

    const answer = join(tempDir('ans'), 'answer.md');
    writeFileSync(answer, '\uFEFF욱채 wook으로 마친 답: 오늘 할 일을 정리했습니다', 'utf8');
    const fin = await wook(['work', 'done', item.turnId, '--file', answer]);
    expect([fin.code, fin.stdout, fin.stderr]).toEqual([0, `턴을 마쳤습니다: ${item.turnId} (끝 까닭 completed)\n`, '']);
    await until(() => ctx.store.conversation.list({ ref1: 'main' }).some((c) => c.role === 'main_agent' && c.text === '욱채 wook으로 마친 답: 오늘 할 일을 정리했습니다'), '답이 대화에', 30_000, () => situation(x));
    const history = await x.owner$<{ text: string }[]>('command.history', 'main', {});
    expect(JSON.stringify(history)).toContain('욱채 wook으로 마친 답: 오늘 할 일을 정리했습니다');
    const turn = ctx.store.turns.get(item.turnId)!;
    expect({ runner: turn.runner, agent: turn.externalAgentId, mock: turn.mock, pid: turn.process.pid, end: turn.endReason }).toEqual({ runner: 'external', agent: 'X-0001', mock: false, pid: null, end: 'completed' });
    expect(readFileSync(turn.eventsFile, 'utf8')).toContain('wook으로 정리하는 중');
    // 도구 호출 기록은 M-MAIN의 것 — 그 외부 턴의 것
    expect(ctx.store.activity.search({ kinds: ['app_tool'], limit: 200 }).filter((a) => a.turnId === item.turnId && a.text === 'get_overview').map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);

    // 끝난 턴을 다시 마치면 409 → 4 (서버의 글)
    const again = await wook(['work', 'done', item.turnId, '--file', answer]);
    expect(again.code).toBe(4);
    expect(again.stderr.trim()).toMatch(new RegExp(`^turn_ended: 턴 ${item.turnId}은\\(는\\) 이미 끝났습니다 \\(`));
    // 받은 턴이 없으면 도구는 이 PC에서 거부 (1)
    const noTurn = await wook(['tool', 'get_overview']);
    expect([noTurn.code, noTurn.stderr.trim()]).toEqual([1, '받은 턴이 없습니다 — wook work next로 일을 받은 뒤 부르세요 (도구와 화면은 그 턴의 토큰으로 부릅니다)']);
    // heartbeat 한 번
    const beat = await wook(['seat', 'heartbeat']);
    expect(beat.code).toBe(0);
    expect(beat.stdout).toMatch(/^임대를 늘렸습니다: 세대 2 · 일을 받습니다 · 대기 중인 메인 일 \d+개 · 임대 끝 \d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
  }, 180_000);

  it('끝 코드 3: 틀린 키·폐기된 키는 401 — 같은 글, 서버는 아무것도 바꾸지 않는다', async () => {
    const wrong = await wook(['seat', 'status'], { env: { WOOK_AGENT_KEY: `wsk_${randomBytes(32).toString('base64url')}` } });
    expect([wrong.code, wrong.stdout, wrong.stderr]).toEqual([3, '', 'unauthorized: 에이전트 키가 맞지 않거나 폐기됐습니다\n']);
    const other = x.operator.addExternalAgent('남는봇');
    held.add(other.key);
    const otherHome = tempDir('home2');
    // 배정되지 않은 에이전트의 claim은 403 → 1 (키만으로는 자리를 얻지 못한다)
    const unassigned = await wook(['seat', 'claim'], { home: otherHome, env: { WOOK_AGENT_KEY: other.key } });
    expect(unassigned.code).toBe(1);
    expect(unassigned.stderr).toMatch(/^not_assigned: 메인 자리는 이 에이전트\(X-0002\)에게 배정돼 있지 않습니다 — 지금 보유자: 그록봇/);
    expect(existsSync(join(otherHome, '.wook', 'state.json'))).toBe(false);
    x.operator.revokeExternalAgent(other.id);
    const revoked = await wook(['seat', 'status'], { home: otherHome, env: { WOOK_AGENT_KEY: other.key } });
    expect([revoked.code, revoked.stderr]).toEqual([3, 'unauthorized: 에이전트 키가 맞지 않거나 폐기됐습니다\n']);
    // 자리는 그대로 그록봇
    expect(x.h.core.ctx.store.seat.get('main')).toMatchObject({ generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0001' } });
  }, 60_000);

  it('끝 코드 5: 서버가 없는 데이터 폴더·끝난 서버를 가리키는 agent-endpoint.json·닫힌 포트', async () => {
    const empty = tempDir('nodata');
    const none = await wook(['seat', 'status'], { env: { WOOK_DATA_DIR: empty } });
    expect([none.code, none.stderr]).toEqual([5, `이 데이터 폴더(${empty})로 실행 중인 욱채 서버가 없습니다 (agent-endpoint.json 없음) — 서버가 떠 있는지, --data-dir·WOOK_DATA_DIR이 서버와 같은지 보세요\n`]);
    // 끝난 서버가 남긴 파일 (pid가 끝남) — 그 포트로 키를 보내지 않는다
    const stale = tempDir('stale');
    const ep = JSON.parse(readFileSync(agentEndpointPath(x.h.dataDir), 'utf8')) as Record<string, unknown>;
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    writeFileSync(join(stale, 'agent-endpoint.json'), JSON.stringify({ ...ep, pid: dead }));
    const before = x.logger.text().length;
    // --data-dir로 준 폴더는 글에 되풀이하지 않는다 (S7-19 C12)
    const gone = await wook(['seat', 'status', '--data-dir', stale], { env: { WOOK_DATA_DIR: undefined } });
    expect([gone.code, gone.stderr]).toEqual([5, `--data-dir로 준 데이터 폴더의 agent-endpoint.json이(가) 가리키는 서버(pid ${dead})가 끝났습니다 — 서버를 다시 띄우면 새 주소를 씁니다 (키를 그 포트로 보내지 않았습니다)\n`]);
    // 살아 있는 pid지만 포트가 닫힘 (다시 시작해 주소가 바뀐 서버)
    writeFileSync(join(stale, 'agent-endpoint.json'), JSON.stringify({ ...ep, agentApi: 'http://127.0.0.1:1/agent/v1' }));
    const closed = await wook(['seat', 'status'], { env: { WOOK_DATA_DIR: stale } });
    expect([closed.code, closed.stderr]).toEqual([5, '욱채 서버의 에이전트 API(http://127.0.0.1:1/agent/v1)에 닿지 못했습니다 (ECONNREFUSED) — 서버가 떠 있는지, 다시 시작해 주소가 바뀌지 않았는지 보세요\n']);
    expect(x.logger.text().length).toBe(before);
  }, 60_000);

  it('끝난 서버의 포트를 다른 프로그램이 차지했으면(살아 있는 pid·pid 없는 파일) 키도 턴 토큰도 보내지 않는다 — 리뷰 P2a~c (S7-19 C3)', async () => {
    const got: { path: string; auth: boolean; turn: boolean }[] = [];
    const squatter = createServer((req, res) => {
      got.push({ path: req.url ?? '', auth: req.headers.authorization !== undefined, turn: req.headers['x-wook-turn-token'] !== undefined });
      req.resume();
      // hello에는 겉모양만 맞는 답 (그 proof를 모른다), 그 밖은 404
      res.writeHead(req.url?.endsWith('/hello') ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(req.url?.endsWith('/hello') ? JSON.stringify({ ok: true, mac: randomBytes(32).toString('base64url') }) : '{}');
    });
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', () => r()));
    try {
      const at = `http://127.0.0.1:${(squatter.address() as { port: number }).port}`;
      const stale = tempDir('squat');
      const ep = JSON.parse(readFileSync(agentEndpointPath(x.h.dataDir), 'utf8')) as Record<string, unknown>;
      // 뒤에서 heartbeat를 보내는 명령까지 — 받은 턴이 있는 state.json (가짜 값)
      const h = tempDir('home-squat');
      mkdirSync(join(h, '.wook'));
      writeFileSync(join(h, '.wook', 'state.json'), JSON.stringify({ version: 1, api: at, agentId: 'X-0001', label: 'p', generation: 2, leaseId: randomBytes(24).toString('base64url'), leaseMs: 4000, heartbeatMs: 100, pollMaxMs: 25000, claimedAt: new Date().toISOString(), turn: { turnId: 'TN-0001', token: `wtt_${randomBytes(32).toString('base64url')}`, generation: 2, deadlineAt: new Date(Date.now() + 600_000).toISOString() } }));
      const fakeKey = `wsk_${randomBytes(32).toString('base64url')}`;
      // ① 살아 있는 pid(이 시험 프로세스)와 그 서버의 proof — 듣는 쪽은 그 proof를 모른다
      writeFileSync(join(stale, 'agent-endpoint.json'), JSON.stringify({ ...ep, agentApi: `${at}/agent/v1`, mcp: `${at}/mcp`, pid: process.pid }));
      for (const argv of [['seat', 'status'], ['tool', 'get_overview'], ['work', 'next', '--wait'], ['stop']]) {
        const r = await wook(argv, { home: h, env: { WOOK_DATA_DIR: stale, WOOK_AGENT_KEY: fakeKey } });
        expect([argv.join(' '), r.code, r.stdout]).toEqual([argv.join(' '), 5, '']);
        expect(r.stderr).toBe(`그 주소(${at}/agent/v1)에서 듣는 쪽이 agent-endpoint.json을 쓴 욱채 서버임을 증명하지 못했습니다 (확인값이 맞지 않음) — 키를 보내지 않았습니다. 끝난 서버가 남긴 파일의 포트를 다른 프로그램이 쓰고 있을 수 있습니다 (서버를 다시 띄우면 새로 씁니다)\n`);
      }
      // ② pid 없는 파일, proof 없는 파일 — 연결도 하지 않는다
      const n = got.length;
      for (const drop of ['pid', 'proof']) {
        const rest: Record<string, unknown> = { ...ep, agentApi: `${at}/agent/v1`, pid: process.pid };
        delete rest[drop];
        writeFileSync(join(stale, 'agent-endpoint.json'), JSON.stringify(rest));
        const r = await wook(['seat', 'status'], { home: h, env: { WOOK_DATA_DIR: stale, WOOK_AGENT_KEY: fakeKey } });
        expect([drop, r.code, r.stderr.includes('(키를 보내지 않았습니다)')]).toEqual([drop, 5, true]);
      }
      expect(got.length).toBe(n);
      // 듣는 쪽이 받은 것은 hello뿐 — 키·턴 토큰 머리는 한 번도 없다
      expect(got.length).toBeGreaterThanOrEqual(4);
      expect(got.every((g) => g.path === '/agent/v1/hello' && !g.auth && !g.turn)).toBe(true);
    } finally {
      squatter.closeAllConnections();
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  }, 60_000);

  it('끝 코드 4: 긴급 정지(wook stop) 뒤 heartbeat·claim은 409 stopped — 정지 요약은 종료 확인 불가를 말한다', async () => {
    // 앞 시험들 사이에 임대(4초)가 끝났을 수 있다 — 다시 잡아 살아 있는 임대로 정지한다 (그 보유자가 요약의 실패 줄이 된다). 정지할 때까지 시험이 임대를 살린다
    keepLease();
    expect((await wook(['seat', 'claim'])).code).toBe(0);
    state();
    // 앞 시험이 어떻게 끝났든 쌓인 메인 일이 없게 한다 (리드 후속 2 — 이 시험이 스스로 준비한다)
    await drainMain();
    // 같은 임대의 work next --wait 둘 (리뷰 P3e, S7-19 C5): 서로의 롱폴을 곧바로 끝내도 키의 횟수(1분 600번)를 태우지 않는다 — 하나가 몇 초 안에 1로 그만두고,
    // 그 뒤 heartbeat는 429가 아니다. 쌓인 메인 일이 없을 때 (있으면 한쪽이 그 일을 받는다)
    expect(x.h.core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })).toEqual([]);
    const logAt = x.logger.text().length;
    const a = wookChild(['work', 'next', '--wait']);
    await sleep(300);
    const b = wookChild(['work', 'next', '--wait']);
    const first = await Promise.race([a.done, b.done, sleep(20_000).then(() => null)]);
    expect(first).not.toBeNull();
    expect([first!.code, first!.stdout, first!.stderr.split('\n')[0]]).toEqual([1, '', '다른 wook work next가 같은 임대로 기다리고 있습니다 — 한 임대로는 롱폴 하나만 엽니다 (새 롱폴이 앞의 것을 곧바로 끝냅니다). 다른 쪽을 끝내거나 그쪽이 받게 두세요']);
    for (const c of [a.child, b.child]) if (c.exitCode === null) c.kill();
    await Promise.all([a.done, b.done]);
    const afterPolls = await wook(['seat', 'heartbeat']);
    expect([afterPolls.code, afterPolls.stderr]).toEqual([0, '']);
    expect(x.logger.text().slice(logAt)).not.toContain('429로 답함');
    const stop = await wook(['stop']);
    expect(stop.code).toBe(0);
    expect(stop.stdout.split('\n').slice(0, 2)).toEqual([
      expect.stringMatching(/^긴급 정지를 걸었지만 종료를 확인하지 못한 실행이 있습니다\. 새 실행은 막았고, 실행 \d+개를 멈추고 작업 \d+개를 보류했습니다\. 정지 해제는 대표만 합니다\.$/),
      '  - 메인 에이전트(그록봇 — 외부): 외부 메인 에이전트: 턴 토큰과 임대를 폐기함 — 프로세스 종료는 확인할 수 없음 (종료 확인 불가)',
    ]);
    const beat = await wook(['seat', 'heartbeat']);
    expect(beat.code).toBe(4);
    expect(beat.stderr).toMatch(/^stopped: .*대표가 정지를 풀면 다시 claim하세요/);
    const claim = await wook(['seat', 'claim']);
    expect(claim.code).toBe(4);
    expect(claim.stderr).toMatch(/^stopped: /);
    const status = await wook(['seat', 'status']);
    expect(status.stdout.split('\n')[0]).toBe('메인 자리: 세대 2 · 긴급 정지 중 · 보유자 그록봇 (외부 에이전트 X-0001)');
  }, 60_000);

  it('키·임대 ID·턴 토큰·서버 확인값(proof)은 wook의 어떤 출력·서버 기록에도 없다', () => {
    expect(held.size).toBeGreaterThanOrEqual(4);
    const all = printed.join('\n');
    // 이 실행의 proof (S7-19 C3) — agent-endpoint.json에만 있다
    const proof = String((JSON.parse(readFileSync(agentEndpointPath(x.h.dataDir), 'utf8')) as { proof: unknown }).proof);
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const secrets = [key, ...held, proof];
    expect(secrets.map((s) => all.includes(s))).toEqual(secrets.map(() => false));
    expect(all.includes('wtt_')).toBe(false);
    expect(secrets.map((s) => x.logger.text().includes(s))).toEqual(secrets.map(() => false));
  });

  // 마지막에 둔다 — 리스너의 인증 없는 몫(1분 120번)을 다 쓰므로 그 뒤 1분 동안의 401은 429가 된다
  it('서버 확인(hello)은 인증 없는 요청의 몫을 쓰지 않는다 — hello 500번은 모두 200·맞는 mac이고 DB·기록에 아무것도 남기지 않으며, 쓰레기 요청이 몫을 다 써도(429) hello와 wook seat status는 된다 (리드 후속 11-11)', async () => {
    const ep = JSON.parse(readFileSync(agentEndpointPath(x.h.dataDir), 'utf8')) as { agentApi: string; proof: string };
    const ctx = x.h.core.ctx;
    const fingerprint = (): string => JSON.stringify({ activity: ctx.store.activity.search({ limit: 5000 }).length, agents: ctx.store.externalAgents.list(), seat: ctx.store.seat.get('main') });
    const helloOk = async (): Promise<boolean> => {
      const nonce = randomBytes(32);
      const r = await agentCall(ep.agentApi, null, '/hello', { body: { nonce: nonce.toString('base64url') } });
      return r.status === 200 && r.json<{ mac: string }>().mac === createHmac('sha256', Buffer.from(ep.proof, 'base64url')).update(nonce).digest('base64url');
    };
    const before = fingerprint();
    const logAt = x.logger.text().length;
    let good = 0;
    for (let i = 0; i < 500; i++) if (await helloOk()) good += 1;
    expect(good).toBe(500);
    expect(fingerprint()).toBe(before);
    expect(x.logger.text().length).toBe(logAt);
    // 쓰레기 요청이 리스너의 몫을 다 쓴다
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await agentCall(ep.agentApi, null, '/seat')).status;
    expect(last).toBe(429);
    expect(await helloOk()).toBe(true);
    // 맞는 키의 wook은 그대로 — hello부터 하고 키를 실은 요청까지. 자리의 상태는 지금의 것으로 견준다 (앞 시험의 결과에 기대지 않는다 — 리드 후속 2)
    const seat = ctx.store.seat.get('main')!;
    const stateText = ctx.stop().global.active ? '긴급 정지 중' : '앉아 있음';
    const st = await wook(['seat', 'status']);
    expect([st.code, st.stdout.split('\n')[0], st.stderr]).toEqual([0, `메인 자리: 세대 ${seat.generation} · ${stateText} · 보유자 그록봇 (외부 에이전트 X-0001)`, '']);
  }, 120_000);
});
