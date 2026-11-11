/**
 * 빌드한 서버와 운영자 명령 (SERVER_DESIGN 3.2·3.7, 리드 결정 S3-6·S3-8): 서버 프로세스가 시작할 때 server.json을 읽고(틀리면 시작하지 않음), 대표 이메일이
 * 없으면 설정 코드를 콘솔과 setup-code.txt(그 사용자만)에만 내고, 자동 백업 예약을 켠다. 운영자 명령 `wook-server config …`가 관리 채널로 그 서버를 바꾼다.
 * 비밀 값(secret set)은 OS 보안 저장소를 쓰므로 여기서는 명령 줄 거부만 본다 — 저장 길은 operatorConfig.test(메모리 저장소)가 본다.
 * serve.ts가 낸 설정 코드를 서버 기록의 가리개(issuedCodes)에 넣는지는 살아 있는 코드를 실은 운영자 명령으로 본다 (S3-18·S3-36 — 다른 시험은 가리개를 손수 만든다).
 * 설정 코드는 시험 출력에 내지 않는다 — 참거짓으로만 본다.
 * 외부 에이전트(리드 결정 S7-2·S7-3): `agent add`의 키는 표준 출력에 한 번만 나오고 서버 기록·DB·데이터 폴더에는 없다. 키도 시험 출력에 내지 않는다
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { openStore } from '../../src/main/db/store';
import type { ServerConfigView } from '../../src/server/config';
import { SECRET_USAGE } from '../../src/server/cli';
import { createHarness } from '../e2e/harness';
import { buildServerTo, clientJson, invokeHttp, REPO, removeDir, runClient, sleep, startBuilt, testBuildDir, workspaceArgs, windowsAcl, windowsMe, type BuiltServer } from './helpers';

const CLIENT_ID = '424242-tvclient.apps.googleusercontent.com';
let outDir = '';
let entry = '';
const dirs: string[] = [];
const servers: BuiltServer[] = [];

beforeAll(() => {
  outDir = testBuildDir('opcli');
  entry = buildServerTo(outDir);
}, 180_000);

afterAll(async () => {
  for (const s of servers) {
    if (s.child.exitCode === null) {
      runClient(entry, ['shutdown', '--data-dir', s.dataDir]);
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 40_000))]);
      if (s.child.exitCode === null) s.child.kill();
    }
  }
  for (const d of dirs) await removeDir(d);
  if (outDir) await removeDir(outDir);
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-opcli-${tag}-`));
  dirs.push(d);
  return d;
};

async function start(dataDir: string, args: string[] = []): Promise<BuiltServer> {
  const s = await startBuilt({ entry, dataDir, args });
  servers.push(s);
  return s;
}

async function shutdown(s: BuiltServer): Promise<void> {
  const r = runClient(entry, ['shutdown', '--data-dir', s.dataDir]);
  expect([r.code, r.stdout.trim()]).toEqual([0, '서버를 종료했습니다.']);
  expect((await s.exited).code).toBe(0);
}

/** 데이터 폴더의 모든 파일 내용 (설정 코드가 남지 않았는지) */
function allBytes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p).toString('latin1') + readFileSync(p).toString('utf8'));
    }
  };
  walk(dir);
  return out;
}

describe('대표 이메일이 없는 서버 — 설정 코드와 운영자 명령 (S3-6·S3-8)', () => {
  let dataDir = '';
  let srv: BuiltServer;
  let code = '';

  beforeAll(async () => {
    dataDir = tempDir('setup');
    srv = await start(dataDir);
    // 설정 코드 줄은 준비 줄 바로 뒤에 온다
    const until = Date.now() + 10_000;
    while (!srv.stdout().includes('대표 이메일이 아직 정해지지 않았습니다') && Date.now() < until) await sleep(50);
    code = /설정 코드 ([A-Z0-9]{4})-([A-Z0-9]{4}) \(/.exec(srv.stdout())?.slice(1).join('') ?? '';
  }, 120_000);

  it('준비 줄 뒤에 설정 코드를 콘솔에 내고 setup-code.txt(그 사용자만)에도 적는다 — 서버 기록에는 코드 없이', async () => {
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    const lines = srv.stdout().trim().split('\n');
    expect(lines[0]!.startsWith('욱채 서버 준비 완료: 주소 ')).toBe(true);
    expect(lines[1]!.startsWith('대표 이메일이 아직 정해지지 않았습니다. 설정 코드 ')).toBe(true);
    expect(lines[1]!.endsWith(`${join(dataDir, 'setup-code.txt')}에도 적었습니다)를 웹 화면의 서버 설정에 대표 이메일과 함께 넣거나, 운영자가 wook-server config owner-email <이메일>로 정하세요.`)).toBe(true);
    const file = join(dataDir, 'setup-code.txt');
    expect(readFileSync(file, 'utf8').includes(`코드: ${code.slice(0, 4)}-${code.slice(4)}`)).toBe(true);
    if (process.platform === 'win32') {
      const acl = windowsAcl(file);
      expect(acl.protected).toBe(true);
      expect(acl.rules.map((r) => [r.id, r.inherited, r.rights, r.type])).toEqual([[windowsMe(), false, 'FullControl', 'Allow']]);
    } else {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    expect(log).toContain('대표 이메일이 정해지지 않아 설정 코드를 냈습니다 (setup-code.txt, 1시간, 한 번만)');
    expect(log).toContain('운영자 설정(파일 없음)을 읽었습니다 — 바꾼 것 0개');
    // 하루 1회 자동 백업 예약을 켠다 (S3-8)
    expect(log).toContain('자동 백업 예약 시작 (하루 1회 — 설정 general.backup.enabled, 데스크톱 앱과 같은 backup-state.json)');
    expect({ raw: log.includes(code), shown: log.includes(`${code.slice(0, 4)}-${code.slice(4)}`) }).toEqual({ raw: false, shown: false });
    expect((await invokeHttp(srv.url, null, 'auth.getState')).json()).toMatchObject({ value: { setupRequired: true, mode: 'server' } });
  });

  it('config show는 대표 이메일이 없고 설정 코드를 기다린다고 말한다 (--json도)', () => {
    const { code: exit, reply } = clientJson(entry, ['config', 'show', '--data-dir', dataDir]);
    expect(exit).toBe(0);
    const v = reply.result as ServerConfigView;
    expect(v).toMatchObject({ path: join(dataDir, 'server.json'), exists: false, ownerEmail: null, ownerEmailSource: null, ownerEmailFlag: false, google: { clientId: null, secretSet: false } });
    expect(typeof v.setupCodeExpiresAt).toBe('string');
    const text = runClient(entry, ['config', 'show', '--data-dir', dataDir]);
    expect(text.code).toBe(0);
    expect(text.stdout.split('\n')[2]).toBe(`  대표 이메일     정해지지 않음 — 설정 코드를 기다립니다 (${v.setupCodeExpiresAt}까지, 서버 콘솔·setup-code.txt)`);
  });

  it('config owner-email은 server.json에 쓰고 적용한다 — 설정 코드 파일이 지워지고 로그인 화면은 설정을 더 받지 않는다', async () => {
    const r = runClient(entry, ['config', 'owner-email', 'owner@example.com', '--data-dir', dataDir]);
    expect([r.code, r.stdout]).toEqual([0, '대표 이메일을 server.json에 쓰고 적용했습니다: 바꾼 것 1개\n  - 대표 이메일 → owner@example.com\n']);
    expect(JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8'))).toEqual({ owner: { email: 'owner@example.com' } });
    expect(existsSync(join(dataDir, 'setup-code.txt'))).toBe(false);
    expect((await invokeHttp(srv.url, null, 'auth.getState')).json()).toMatchObject({ value: { setupRequired: false } });
    // 쓴 설정 코드는 더 쓸 수 없다 — 대표 이메일이 정해졌다
    const late = await invokeHttp(srv.url, null, 'auth.setupOwner', [code, 'someone@example.com']);
    expect([late.status, late.json<{ error: { code: string } }>().error.code]).toEqual([409, 'conflict']);
  });

  it('config google-client-id는 모양을 보고 쓴다, config reload는 손으로 고친 파일을 적용한다', () => {
    const bad = runClient(entry, ['config', 'google-client-id', 'GOCSPX-붙여넣은-비밀', '--data-dir', dataDir]);
    expect([bad.code, bad.stderr]).toEqual([1, "구글 OAuth 클라이언트 ID 모양(…apps.googleusercontent.com)이 아닙니다 — 구글 클라우드 콘솔의 'TV 및 입력 제한 기기' 클라이언트 ID를 넣으세요\n"]);
    expect(runClient(entry, ['config', 'google-client-id', CLIENT_ID, '--data-dir', dataDir]).code).toBe(0);
    const file = JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ ...file, cli: { codexPath: 'C:/tools/codex.cmd' } }));
    const r = runClient(entry, ['config', 'reload', '--data-dir', dataDir]);
    expect([r.code, r.stdout]).toEqual([0, '운영자 설정을 다시 읽었습니다: 바꾼 것 1개\n  - Codex CLI 위치 → C:/tools/codex.cmd\n']);
  });

  it('보안 비밀은 명령 줄로 받지 않는다 — 값을 붙이면 쓰임새 오류(2)이고 서버에 붙지 않는다', () => {
    const r = runClient(entry, ['secret', 'set', 'google-client-secret', 'GOCSPX-명령줄-비밀', '--data-dir', dataDir]);
    expect(r.code).toBe(2);
    expect(r.stderr.startsWith(`${SECRET_USAGE}\n`)).toBe(true);
    expect(r.stderr.includes('명령줄-비밀') || r.stdout.includes('명령줄-비밀')).toBe(false);
  });

  it('끝나면 설정 코드 파일이 없고, 덮어쓴 것은 행위자 operator로 남았으며, 데이터 폴더 어디에도 설정 코드가 없다', async () => {
    await shutdown(srv);
    expect(existsSync(join(dataDir, 'setup-code.txt'))).toBe(false);
    const store = openStore(join(dataDir, 'wook.db'));
    try {
      const rows = store.activity.search({ limit: 200 }).filter((e) => e.actor === OPERATOR).map((e) => e.text);
      expect(rows).toEqual(
        expect.arrayContaining([
          '대표 이메일 설정 코드를 냄 (서버 콘솔과 setup-code.txt — 1시간, 한 번만)',
          '대표 이메일 정함: owner@example.com (운영자 설정)',
          `server.json: 서버 구글 클라이언트 ID를 바꿈 (${CLIENT_ID})`,
          'server.json: Codex CLI 실행 파일 위치를 바꿈 (C:/tools/codex.cmd)',
        ]),
      );
    } finally {
      store.close();
    }
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    expect(allBytes(dataDir).some((t) => t.includes(code) || t.includes(shown))).toBe(false);
  });
});

describe('설정 코드는 그 실행에만 (S3-6)', () => {
  it('대표 이메일을 정하지 않고 끝나도 setup-code.txt를 남기지 않는다 — 다음 시작은 새 코드를 낸다', async () => {
    const dataDir = tempDir('exit');
    const srv = await start(dataDir);
    const until = Date.now() + 10_000;
    while (!existsSync(join(dataDir, 'setup-code.txt')) && Date.now() < until) await sleep(50);
    expect(existsSync(join(dataDir, 'setup-code.txt'))).toBe(true);
    await shutdown(srv);
    expect(existsSync(join(dataDir, 'setup-code.txt'))).toBe(false);
  });
});

describe('서버 기록은 이 실행이 낸 설정 코드를 가린다 — serve.ts의 배선 (S3-18·S3-36, 검토 프로브 zz-s3fti-serve-code-wiring)', () => {
  it('살아 있는 설정 코드를 실은 운영자 명령이 server.log에 남아도 날 꼴·보이는 꼴(ABCD-EFGH)·소문자 꼴 모두 가려진다', async () => {
    const dataDir = tempDir('wiring');
    const srv = await start(dataDir);
    const file = join(dataDir, 'setup-code.txt');
    // 설정 코드는 준비 줄을 낸 뒤 내고 이 파일에 적는다
    const until = Date.now() + 10_000;
    while (!(existsSync(file) && readFileSync(file, 'utf8').includes('코드: ')) && Date.now() < until) await sleep(50);
    const m = /코드: ([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(existsSync(file) ? readFileSync(file, 'utf8') : '');
    expect(m !== null, 'setup-code.txt의 코드 줄').toBe(true);
    const code = `${m![1]}${m![2]}`;
    const shown = `${m![1]}-${m![2]}`;
    // 구글 클라이언트 ID 모양이라 받는 값에 세 꼴을 싣는다 — 서버 기록에 '운영자 설정 바뀜 (google.clientId): …'로 남는 값이다
    const r = runClient(entry, ['config', 'google-client-id', `${code}-${shown}-${shown.toLowerCase()}.apps.googleusercontent.com`, '--data-dir', dataDir]);
    // 대표 이메일이 아직 없으니 코드는 살아 있다 (쓰고 버린 코드가 아니다)
    const live = existsSync(file);
    await shutdown(srv);
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    expect({
      exit: r.code,
      live,
      changeLine: log.includes('운영자 설정 바뀜 (google.clientId)'),
      // 서버 기록의 가리개(serverRedactor)가 가린 자리 — 백엔드 가리개의 표시와 다르다
      masked: log.includes('[가림:설정코드]'),
      raw: log.includes(code),
      shown: log.includes(shown),
      lowerShown: log.includes(shown.toLowerCase()),
      anyCase: log.toLowerCase().includes(code.toLowerCase()),
    }).toEqual({ exit: 0, live: true, changeLine: true, masked: true, raw: false, shown: false, lowerShown: false, anyCase: false });
  });
});

describe('외부 에이전트 운영자 명령 (리드 결정 S7-2·S7-3)', () => {
  it('agent add는 키를 표준 출력에 한 번만 낸다 — 서버 기록·DB·데이터 폴더 어디에도 없다. list는 키 없이, revoke는 되풀이해도 0, 모르는 ID는 1, 틀린 쓰임새는 2', async () => {
    // 모의 메인으로 데이터 폴더를 준비한다 (seatBuilt와 같다) — 빌드한 서버가 이 PC의 실제 Claude·Codex CLI 턴을 띄우지 않게 (리드 결정 S6-19)
    const h = await createHarness({ noProject: true });
    const dataDir = h.dataDir;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    const srv = await start(dataDir);

    const add = runClient(entry, ['agent', 'add', '--label', '그록봇', '--data-dir', dataDir]);
    const key = /^ {2}(wsk_[A-Za-z0-9_-]{43})$/m.exec(add.stdout)?.[1] ?? '';
    // 키는 시험 출력에 내지 않는다 — 참거짓으로만 본다
    const lines = add.stdout.split('\n');
    expect({ code: add.code, stderr: add.stderr, keyShown: key.length === 47, keyLines: lines.filter((l) => key && l.includes(key)).length }).toEqual({ code: 0, stderr: '', keyShown: true, keyLines: 1 });
    expect(lines[0]).toBe('외부 에이전트를 등록했습니다: X-0001 (그록봇)');
    expect(lines[1]!.startsWith('에이전트 키 — 지금 한 번만 보입니다.')).toBe(true);
    expect(lines.at(-2)).toBe('메인 자리에 앉히려면: wook-server seat assign external:X-0001');
    // --json도 표준 출력의 답 한 줄에만 싣는다
    const second = clientJson(entry, ['agent', 'add', '--label', '테스트봇', '--data-dir', dataDir]);
    const key2 = (second.reply.result as { key?: string } | undefined)?.key ?? '';
    expect({ code: second.code, ok: second.reply.ok, id: (second.reply.result as { id?: string }).id, shape: /^wsk_[A-Za-z0-9_-]{43}$/.test(key2), differs: key2 !== key }).toEqual({ code: 0, ok: true, id: 'X-0002', shape: true, differs: true });

    // 거부: 겹치는 이름(1), --label 없음·자리가 틀린 --label·모양이 틀린 ID(2 — 서버에 붙지 않고 되풀이하지 않는다)
    const dup = runClient(entry, ['agent', 'add', '--label', '그록봇', '--data-dir', dataDir]);
    expect([dup.code, dup.stdout, dup.stderr]).toEqual([1, '', '같은 이름의 외부 에이전트(X-0001)가 이미 있습니다 — 다른 이름을 쓰거나, 그 에이전트를 wook-server agent revoke X-0001로 폐기한 뒤 등록하세요\n']);
    const mark = 'GOCSPX-agent-echo-mark';
    for (const argv of [['agent', 'add'], ['agent', 'add', '--label', '  '], ['agent', 'list', '--label', mark], ['agent', 'revoke', mark], ['agent', 'revoke']]) {
      const r = runClient(entry, [...argv, '--data-dir', dataDir]);
      expect([argv.join(' '), r.code, `${r.stdout}${r.stderr}`.includes(mark)]).toEqual([argv.join(' '), 2, false]);
    }

    // 목록: 키·해시 없이
    const list = runClient(entry, ['agent', 'list', '--data-dir', dataDir]);
    expect([list.code, list.stdout.split('\n')[0], list.stdout.includes('wsk_')]).toEqual([0, '욱채 외부 에이전트 (2개 — 폐기한 것 포함)', false]);
    expect(list.stdout).toContain('  X-0001 그록봇 — 등록 ');
    const listed = clientJson(entry, ['agent', 'list', '--data-dir', dataDir]).reply.result as Record<string, unknown>[];
    expect(listed.map((a) => Object.keys(a).sort())).toEqual([
      ['connected', 'createdAt', 'id', 'label', 'lastSeenAt', 'revokedAt', 'seat'],
      ['connected', 'createdAt', 'id', 'label', 'lastSeenAt', 'revokedAt', 'seat'],
    ]);

    // 등록한 에이전트에게 메인 자리를 배정한다 — 이름은 등록 기록에서 (S7-4). 나가는 보유자는 모의 메인이다
    const seat = runClient(entry, ['seat', 'assign', 'external:X-0002', '--data-dir', dataDir]);
    expect([seat.code, seat.stderr]).toEqual([0, '']);
    expect(seat.stdout).toMatch(/^메인 자리를 테스트봇에게 (넘겼습니다|넘기는 중입니다) \(세대 1 → 2/);

    // 폐기: 처음은 바꾸고, 다시 해도 0(이미 폐기됨), 모르는 ID는 1. 앉은 에이전트면 자리는 그대로라고 덧붙인다
    const r1 = runClient(entry, ['agent', 'revoke', 'X-0001', '--data-dir', dataDir]);
    expect([r1.code, r1.stdout]).toEqual([0, expect.stringMatching(/^외부 에이전트 X-0001 \(그록봇\)의 키를 폐기했습니다 \(.+\)\. 이 키로는 더 접속할 수 없습니다\.\n$/)]);
    const r2 = runClient(entry, ['agent', 'revoke', 'X-0001', '--data-dir', dataDir]);
    expect([r2.code, r2.stdout]).toEqual([0, expect.stringMatching(/^외부 에이전트 X-0001 \(그록봇\)의 키는 이미 폐기돼 있습니다 \(.+ 폐기\) — 바꾼 것이 없습니다\.\n$/)]);
    const r3 = runClient(entry, ['agent', 'revoke', 'X-0099', '--data-dir', dataDir]);
    expect([r3.code, r3.stderr]).toEqual([1, '등록된 외부 에이전트 X-0099이(가) 없습니다 — wook-server agent list로 ID를 확인하세요\n']);
    // 넘기는 중이었으면 끝날 때까지 본다 (나가는 모의 메인의 인계 메모 턴)
    const until = Date.now() + 60_000;
    while ((clientJson(entry, ['seat', 'status', '--data-dir', dataDir]).reply.result as { seat: { state: string } }).seat.state !== 'active' && Date.now() < until) await sleep(500);
    const r4 = runClient(entry, ['agent', 'revoke', 'X-0002', '--data-dir', dataDir]);
    expect([r4.code, r4.stdout.includes('이 에이전트는 메인 자리에 앉아 있거나 들어올 차례입니다 — 서버는 자리를 바꾸지 않으므로 자리는 그대로 두고 응답 없음이 됩니다')]).toEqual([0, true]);

    await shutdown(srv);
    // 서버 기록에는 명령 이름만 — 키와 그 몸통이 없다. 데이터 폴더(DB·WAL·기록·자리 파일) 어디에도 두 키가 없다
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    expect([log.includes('관리 채널: agent.add 처리'), log.includes('관리 채널: agent.revoke 처리'), log.includes('관리 채널: agent.list 처리')]).toEqual([true, true, true]);
    expect([key, key2, key.slice(4, 24), key2.slice(4, 24)].map((k) => allBytes(dataDir).some((t) => t.includes(k)))).toEqual([false, false, false, false]);
    const store = openStore(join(dataDir, 'wook.db'));
    try {
      expect(store.externalAgents.list().map((a) => [a.id, a.label, a.keyHash === createHash('sha256').update(a.id === 'X-0001' ? key : key2).digest('hex'), a.revokedBy])).toEqual([
        ['X-0001', '그록봇', true, 'operator'],
        ['X-0002', '테스트봇', true, 'operator'],
      ]);
      const rows = store.activity.search({ kinds: ['auth'], limit: 50 }).filter((e) => e.actor === OPERATOR).map((e) => e.text);
      expect(rows.filter((t) => t.startsWith('외부 에이전트를 등록함') || t.startsWith('외부 에이전트 키를 폐기함'))).toHaveLength(4);
      // 이 서버에서 돈 메인 턴은 모두 모의 실행이다 (나가는 보유자의 인계 메모 턴)
      expect(store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock)).toEqual([]);
      expect(store.seat.get('main')).toMatchObject({ holder: { kind: 'external', agentId: 'X-0002', label: '테스트봇' } });
    } finally {
      store.close();
    }
  }, 240_000);
});

describe('운영자 명령의 --json은 ASCII만 낸다 (리드 결정 S7-19 C1 — 리뷰 P1)', () => {
  it('agent add --label 그록봇 --json의 출력은 ASCII 한 줄이라 cp949(이 PC의 PowerShell 5.1)로 읽어도 JSON이고 이름·키가 그대로다 — 거부 답도', async () => {
    const h = await createHarness({ noProject: true });
    const dataDir = h.dataDir;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    const srv = await start(dataDir);
    const ascii = (b: Buffer): boolean => [...b].every((x) => x < 0x80);
    const cp949 = (b: Buffer): unknown => JSON.parse(new TextDecoder('euc-kr').decode(b));
    const raw = (args: string[]) => spawnSync(process.execPath, [entry, ...args, '--data-dir', dataDir], { cwd: REPO, windowsHide: true, timeout: 120_000 });

    const add = raw(['agent', 'add', '--label', '그록봇', '--json']);
    expect([add.status, add.stdout.length > 0, ascii(add.stdout), add.stderr.length]).toEqual([0, true, true, 0]);
    const reply = cp949(add.stdout) as { ok: boolean; result: { id: string; label: string; key: string } };
    // 키는 ASCII라 바뀌지 않는다 — UTF-8로 읽은 것과 같고 꼴도 같다 (키는 시험 출력에 내지 않는다)
    const asUtf8 = JSON.parse(add.stdout.toString('utf8')) as typeof reply;
    expect({ ok: reply.ok, id: reply.result.id, label: reply.result.label, shape: /^wsk_[A-Za-z0-9_-]{43}$/.test(reply.result.key), same: reply.result.key === asUtf8.result.key }).toEqual({ ok: true, id: 'X-0001', label: '그록봇', shape: true, same: true });
    // 서버의 거부(같은 이름)도 ASCII JSON 한 줄 — 한국어 글이 그대로 돌아온다
    const dup = raw(['agent', 'add', '--label', '그록봇', '--json']);
    expect([dup.status, ascii(dup.stdout)]).toEqual([1, true]);
    expect(cp949(dup.stdout)).toEqual({ ok: false, error: { code: expect.any(String), message: '같은 이름의 외부 에이전트(X-0001)가 이미 있습니다 — 다른 이름을 쓰거나, 그 에이전트를 wook-server agent revoke X-0001로 폐기한 뒤 등록하세요' } });
    // 목록도
    const list = raw(['agent', 'list', '--json']);
    expect([list.status, ascii(list.stdout), (cp949(list.stdout) as { result: { label: string }[] }).result.map((a) => a.label)]).toEqual([0, true, ['그록봇']]);
    await shutdown(srv);
  }, 240_000);
});

describe('server.json으로 띄우기 (S3-8)', () => {
  it('모양이 틀린 server.json이면 시작하지 않는다 — 1로 끝나고, 잠금·저장소를 만들기 전에 그만둔다', () => {
    const dataDir = tempDir('broken');
    writeFileSync(join(dataDir, 'server.json'), '{ "owner": ');
    const r = spawnSync(process.execPath, [entry, 'serve', '--data-dir', dataDir, '--port', '0', ...workspaceArgs(dataDir)], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr.includes(`욱채 서버를 시작하지 못했습니다: 운영자 설정을 적용하지 못했습니다 — 운영자 설정 파일(${join(dataDir, 'server.json')})이 JSON이 아닙니다: `)).toBe(true);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    // 잠금·백엔드를 만들기 전에 그만둔다 — 저장소도 만들지 않았다
    expect(existsSync(join(dataDir, 'wook.db'))).toBe(false);
  });

  it('--config의 파일을 읽고, --owner-email이 파일보다 먼저다 — 대표 이메일이 있으면 설정 코드를 내지 않고, config owner-email은 거부한다', async () => {
    const dataDir = tempDir('flag');
    const conf = join(tempDir('conf'), '운영자 설정.json');
    writeFileSync(conf, JSON.stringify({ owner: { email: 'file-owner@example.com' }, google: { clientId: CLIENT_ID } }));
    const srv = await start(dataDir, ['--config', conf, '--owner-email', 'flag-owner@example.com']);
    expect(srv.stdout().includes('설정 코드')).toBe(false);
    expect(existsSync(join(dataDir, 'setup-code.txt'))).toBe(false);
    const v = clientJson(entry, ['config', 'show', '--data-dir', dataDir]).reply.result as ServerConfigView;
    expect(v).toMatchObject({ path: conf, exists: true, ownerEmail: 'flag-owner@example.com', ownerEmailSource: 'flag', ownerEmailFlag: true, google: { clientId: CLIENT_ID } });
    const r = runClient(entry, ['config', 'owner-email', 'other@example.com', '--data-dir', dataDir]);
    expect([r.code, r.stderr]).toEqual([1, '이 서버는 --owner-email로 시작해 대표 이메일을 그 인자로 정합니다 — 바꾸려면 그 인자를 빼거나 바꿔 서버를 다시 시작하세요\n']);
    await shutdown(srv);
  });
});
