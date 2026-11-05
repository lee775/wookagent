/**
 * 빌드한 서버와 운영자 명령 (SERVER_DESIGN 3.2·3.7, 리드 결정 S3-6·S3-8): 서버 프로세스가 시작할 때 server.json을 읽고(틀리면 시작하지 않음), 대표 이메일이
 * 없으면 설정 코드를 콘솔과 setup-code.txt(그 사용자만)에만 내고, 자동 백업 예약을 켠다. 운영자 명령 `wook-server config …`가 관리 채널로 그 서버를 바꾼다.
 * 비밀 값(secret set)은 OS 보안 저장소를 쓰므로 여기서는 명령 줄 거부만 본다 — 저장 길은 operatorConfig.test(메모리 저장소)가 본다.
 * serve.ts가 낸 설정 코드를 서버 기록의 가리개(issuedCodes)에 넣는지는 살아 있는 코드를 실은 운영자 명령으로 본다 (S3-18·S3-36 — 다른 시험은 가리개를 손수 만든다).
 * 설정 코드는 시험 출력에 내지 않는다 — 참거짓으로만 본다
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { openStore } from '../../src/main/db/store';
import type { ServerConfigView } from '../../src/server/config';
import { SECRET_USAGE } from '../../src/server/cli';
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
