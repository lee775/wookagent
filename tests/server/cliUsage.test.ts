/**
 * cliUsage (리드 결정 S9-2·S9-11): 9단계 운영자 명령의 쓰임새 — 사용법 글의 명령은 모두 읽히고, 새 낱말은 쓰임새 오류의 되풀이 규칙(S3-39)을 따른다.
 * - 사용법(USAGE)의 `wook-server …` 줄마다 자리표시(<이메일>·<ID>·<보유자>·<이름>)를 채우면 parseCli가 그 명령으로 읽는다 — 새 명령(install-task·uninstall-task·check)과
 *   새 비밀 값 이름(claude-api-key·codex-api-key)도
 * - 'local' 계획: 실행 중인 서버가 없어도 되는 명령. --dry-run·--json, install-task의 서버 옵션(serve와 같은 확인), 받지 않는 옵션
 * - 알 수 없는 명령·옵션은 새 낱말만 보이고 값은 보이지 않는다. API 키를 말하는 낱말은 비밀 값 명령의 꼴로 답한다
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_EMAIL_FLAG_INVALID } from '../../src/main/orchestrator/serverLogin';
import { parseCli, runCli, SECRET_USAGE, taskDashValueRefusal, TASK_TEST_SESSION_REFUSAL, unknownCommandMessage, USAGE, type CliPlan } from '../../src/server/cli';

const VALUE = 'S9bUsageStandin4q8w2e6r';

/** 사용법 글의 명령 줄 (`  wook-server <명령> …` — 설명 앞까지) */
function usageCommands(): string[] {
  return USAGE.split('\n')
    .map((l) => /^ {2}wook-server (.+?)(?: {2,}|$)/.exec(l)?.[1])
    .filter((c): c is string => !!c && !c.startsWith('[serve]'));
}

/** 자리표시를 채운 낱말 꾸러미들 (`a | b`는 둘로) */
function expand(cmd: string): string[][] {
  const fill: Record<string, string> = { '<이메일>': 'owner@example.com', '<ID>': 'X-0001', '<보유자>': 'launched:codex', '<이름>': '그록봇' };
  const words = cmd
    .replace(/\[--force\]|\[서버 옵션\]/g, '')
    .trim()
    .split(/\s+/);
  const out: string[][] = [[]];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '|') continue;
    if (words[i + 1] === '|') {
      const alts = [w, words[i + 2]!];
      i += 2;
      const next = out.flatMap((ws) => alts.map((a) => [...ws, a]));
      out.splice(0, out.length, ...next);
      continue;
    }
    for (const ws of out) ws.push(fill[w] ?? w);
  }
  return out;
}

describe('사용법의 명령은 모두 읽힌다 (S9-2)', () => {
  it('USAGE의 wook-server 줄마다 — 새 명령과 새 비밀 값 이름이 있고, 각각 그 명령으로 읽힌다', () => {
    const cmds = usageCommands();
    for (const w of ['install-task', 'uninstall-task', 'check', 'secret set claude-api-key | codex-api-key', 'secret clear <이름>']) {
      expect([w, cmds.some((c) => c.startsWith(w))]).toEqual([w, true]);
    }
    expect(USAGE).toContain('  --dry-run');
    const seen: string[] = [];
    for (const cmd of cmds) {
      for (let argv of expand(cmd)) {
        // secret clear <이름>의 이름은 비밀 값 이름이다 · agent add는 --label로
        if (argv[0] === 'secret' && argv[1] === 'clear') argv = ['secret', 'clear', 'claude-api-key'];
        if (argv[0] === 'agent' && argv[1] === 'add') argv = ['agent', 'add', '--label', '그록봇'];
        const plan = parseCli([...argv, '--data-dir', 'd'], {}, 'win32');
        expect([argv.join(' '), plan.kind === 'error' ? plan.message : 'ok']).toEqual([argv.join(' '), 'ok']);
        seen.push(plan.kind === 'local' || plan.kind === 'client' ? plan.command : plan.kind);
      }
    }
    for (const c of ['install-task', 'uninstall-task', 'check', 'secret.set', 'secret.clear', 'status', 'agent.add']) expect([c, seen.includes(c)]).toEqual([c, true]);
  });

  it('--help는 사용법 그대로 (끝 코드 0)', async () => {
    let out = '';
    const code = await runCli(['--help'], { out: async (t) => void (out += t), err: async () => undefined, exit: () => undefined });
    expect([code, out]).toEqual([0, USAGE]);
    // 첫 줄에 단계 이름('4단계: …')이 없다 (리드 결정 S9-21·S9-22)
    expect(USAGE.split('\n')[0]).toBe('욱채 서버 (이 PC의 루프백 — 다른 기기는 tailscale serve로)');
  });
});

describe("이 PC에서만 하는 명령 — 'local' 계획 (S9-2·S9-3)", () => {
  it('install-task·uninstall-task·check는 서버 없이 도는 계획 — --dry-run·--json을 받는다', () => {
    expect(parseCli(['check', '--data-dir', 'd'], {}, 'win32')).toEqual({ kind: 'local', command: 'check', dataDir: resolve('d'), json: false, dryRun: false });
    expect(parseCli(['uninstall-task', '--dry-run', '--json', '--data-dir', 'd'], {}, 'win32')).toEqual({ kind: 'local', command: 'uninstall-task', dataDir: resolve('d'), json: true, dryRun: true });
    expect(parseCli(['install-task', '--data-dir', 'd'], {}, 'win32')).toEqual({ kind: 'local', command: 'install-task', dataDir: resolve('d'), json: false, dryRun: false, task: {} });
  });

  it('install-task는 serve의 옵션을 같은 확인으로 받아 옮긴다 — 포트·공개 주소·대표 이메일이 틀리면 serve와 같은 쓰임새 오류', () => {
    expect(
      parseCli(['install-task', '--port', '7330', '--web-dir', 'out\\web', '--config', 'c.json', '--owner-email', 'owner@example.com', '--public-origin', 'https://grok-pc.tailnet-x.ts.net/', '--workspace-root', 'D:\\ws', '--data-dir', 'd'], {}, 'win32'),
    ).toEqual({
      kind: 'local',
      command: 'install-task',
      dataDir: resolve('d'),
      json: false,
      dryRun: false,
      task: { port: 7330, webDir: 'out\\web', configPath: 'c.json', ownerEmail: 'owner@example.com', publicOrigin: 'https://grok-pc.tailnet-x.ts.net', workspaceRoot: 'D:\\ws' },
    });
    const same = (argv: string[]) => [parseCli(['install-task', ...argv], {}, 'win32'), parseCli(['serve', ...argv], {}, 'win32')];
    for (const argv of [['--port', '70000'], ['--port', VALUE], ['--public-origin', 'http://x.ts.net'], ['--owner-email', 'not-an-email']]) {
      const [task, serve] = same(argv);
      expect([argv[0], task]).toEqual([argv[0], serve]);
      expect(JSON.stringify(task).includes(VALUE)).toBe(false);
    }
    expect(parseCli(['install-task', '--owner-email', 'x'], {}, 'win32')).toEqual({ kind: 'error', message: OWNER_EMAIL_FLAG_INVALID });
  });

  it('받지 않는 것: install-task의 --allow-test-session·--bind, 다른 명령의 --dry-run, uninstall-task·check의 서버 옵션', () => {
    const cases: [string[], string][] = [
      [['install-task', '--allow-test-session'], TASK_TEST_SESSION_REFUSAL],
      [['install-task', '--bind', '::1'], 'install-task는 --bind를 받지 않습니다 — 서버는 늘 이 PC 안(루프백)에 엽니다'],
      [['status', '--dry-run'], '--dry-run은 install-task·uninstall-task·check에만 씁니다'],
      [['serve', '--dry-run'], '--dry-run은 install-task·uninstall-task·check에만 씁니다'],
      [['secret', 'set', 'claude-api-key', '--dry-run'], '--dry-run은 install-task·uninstall-task·check에만 씁니다'],
      [['check', '--port', '1'], '--port는 서버를 띄울 때(serve·install-task)만 씁니다'],
      [['uninstall-task', '--allow-test-session'], '--allow-test-session는 서버를 띄울 때(serve)만 씁니다'],
      [['check', '--force'], '--force는 seat assign에만 씁니다'],
      [['install-task', '--label', 'x'], '--label은 agent add에만 씁니다'],
      // '-'로 시작하는 값은 작업에 넣지 않는다 — 옵션 이름만 말한다 (S9-25 R3-3)
      [['install-task', '--owner-email=-x@example.com'], "install-task는 --owner-email의 값이 '-'로 시작하면 받지 않습니다 — 로그온 때 서버가 그 값을 옵션으로 읽어 뜨지 않습니다 (적은 값은 보이지 않습니다)"],
      [['install-task', '--config=-c.json', '--dry-run'], taskDashValueRefusal('config')],
    ];
    for (const [argv, message] of cases) expect([argv.join(' '), parseCli(argv, {}, 'win32')]).toEqual([argv.join(' '), { kind: 'error', message }]);
  });
});

describe('새 낱말과 되풀이 규칙 (S3-39·S9-2)', () => {
  it('새 명령 낱말은 알 수 없는 명령의 글에 보이고, 그 뒤의 값은 보이지 않는다', () => {
    for (const w of ['install-task', 'uninstall-task', 'check']) {
      const plan = parseCli([w, VALUE], {}, 'win32') as Extract<CliPlan, { kind: 'error' }>;
      expect([w, plan]).toEqual([w, { kind: 'error', message: `알 수 없는 명령입니다: ${w} … (뒤의 낱말은 값일 수 있어 보이지 않습니다)` }]);
    }
    expect(unknownCommandMessage(['check', 'install-task'])).toBe('알 수 없는 명령입니다: check install-task');
    expect(unknownCommandMessage(['config', 'claude-api-key', VALUE])).toBe('알 수 없는 명령입니다: config claude-api-key … (뒤의 낱말은 값일 수 있어 보이지 않습니다)');
  });

  it('API 키를 말하는 낱말·옵션과 모르는 비밀 값 이름은 비밀 값 명령의 꼴(SECRET_USAGE) — 서버에 붙지 않고 값을 되풀이하지 않는다', () => {
    for (const argv of [
      ['secret', 'set', 'claude-api-key', VALUE],
      ['secret', 'set', 'api-key-claude'],
      ['secret', 'clear', 'openai-api-key'],
      ['config', 'claude-api-key', VALUE],
      ['set', 'codex-api-key', VALUE],
      ['status', VALUE, 'my_apikey'],
      [`--api-key=${VALUE}`],
      ['--Codex-API_KEY', VALUE],
    ]) {
      const plan = parseCli(argv, {}, 'win32');
      expect([argv[0], argv[1], plan]).toEqual([argv[0], argv[1], { kind: 'error', message: SECRET_USAGE }]);
      expect(JSON.stringify(plan).includes(VALUE)).toBe(false);
    }
    expect(SECRET_USAGE).toContain('google-client-secret, claude-api-key, codex-api-key');
    expect(parseCli(['secret', 'set', 'codex-api-key'], {}, 'win32')).toMatchObject({ kind: 'client', command: 'secret.set', args: ['codex-api-key'] });
    expect(parseCli(['secret', 'clear', 'google-client-secret'], {}, 'win32')).toMatchObject({ kind: 'client', command: 'secret.clear', args: ['google-client-secret'] });
  });

  it('runCli: 쓰임새 오류는 끝 코드 2이고 stderr에 값이 없다', async () => {
    let err = '';
    let out = '';
    // 인자 읽기가 틀어져도 기본 데이터 폴더(와 그 서버의 보안 저장소)에 닿지 않게 늘 없는 임시 데이터 폴더를 준다 (리드 결정 S9-22 TI-6)
    const nowhere = join(tmpdir(), `wook-test-cliusage-none-${process.pid}-${Date.now()}`);
    const code = await runCli(['secret', 'set', 'claude-api-key', VALUE, '--data-dir', nowhere], { out: async (t) => void (out += t), err: async (t) => void (err += t), exit: () => undefined });
    expect([code, err.startsWith(`${SECRET_USAGE}\n`), (err + out).includes(VALUE), existsSync(nowhere)]).toEqual([2, true, false, false]);
  });
});
