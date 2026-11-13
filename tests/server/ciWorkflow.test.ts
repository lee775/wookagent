/**
 * Linux CI 작업 파일 (.github/workflows/linux.yml — SERVER_DESIGN 10.10, 리드 결정 S10-0·S10-4·S10-9·S10t). GitHub Actions는 이 PC에서 돌릴 수 없으므로 작업
 * 파일을 글로 읽어, 썩으면 안 되는 것을 못 박는다(YAML 해석기 없이 — 들여쓰기와 줄의 꼴로):
 * - Node 판은 문서(SERVER_SETUP.md의 '나와야 하는 것')와 같다 — package.json에 engines.node가 생기면 그것과도 맞는다
 * - 부르는 명령이 있다: npm run의 이름은 package.json scripts에, node로 부르는 파일은 저장소(또는 devDependencies의 패키지)에 있다
 * - 비밀이 없다: secrets·토큰·GITHUB_TOKEN을 부르지 않고, 권한은 contents: read뿐, checkout은 토큰을 .git에 남기지 않는다
 * - 돈이 드는 자리: 작업 하나·matrix 없음·같은 가지의 앞 실행 취소·시간 상한, push는 그 가지 이름으로, 손으로도 돌린다
 * - 실제 시험 단계는 그 파일이 있을 때만(hashFiles) 돌고, 문을 여는 환경 변수와 호스트 이름이 시험 파일의 문과 같은 이름이다
 * - 실패 요약 스크립트(.github/scripts/vitest-summary.mjs)의 약속: 실패·결과 없음·끝 코드가 0이 아님·(--require-ran) 돌지 않은 시험이면 끝 코드 1과 짧은 목록
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO } from './helpers';

const WORKFLOW = join(REPO, '.github', 'workflows', 'linux.yml');
const SUMMARY = join(REPO, '.github', 'scripts', 'vitest-summary.mjs');
// CRLF로 받은 작업 복사본(Windows의 autocrlf)도 같은 줄로 읽는다
const text = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string>; devDependencies: Record<string, string>; engines?: { node?: string } };
/** 주석을 뺀 줄 (`#`로 시작하는 줄과 줄 끝 주석은 단언 대상이 아니다 — 주석에 쓴 말이 단언을 속이지 않게) */
const code = text
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .map((l) => l.replace(/\s+#\s.*$/, ''))
  .join('\n');
/** `run:` 블록들의 셸 글 (한 줄 run과 `run: |` 블록) */
const runs: string[] = (() => {
  const lines = code.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (m[2] && m[2] !== '|') {
      out.push(m[2]);
      continue;
    }
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() && l.search(/\S/) <= m[1]!.length) break;
      block.push(l);
    }
    out.push(block.join('\n'));
  }
  return out;
})();
/** 단계 하나 (`- name:`에서 다음 `- name:`/`- uses:`까지) */
const steps: string[] = code.split(/\n(?=\s{6}- )/).filter((s) => /^\s{6}- /.test(s));
const stepNamed = (name: string): string => {
  const s = steps.find((x) => x.includes(`- name: ${name}\n`));
  expect(s, `단계 '${name}'`).toBeDefined();
  return s!;
};

describe('Linux CI 작업 파일 (S10t)', () => {
  it('Node 판은 문서의 판과 같다 — 문서나 작업 파일 한쪽만 바꾸면 실패한다', () => {
    const wf = /^\s+node-version:\s*'?([0-9.]+)'?\s*$/m.exec(code)?.[1];
    // SERVER_SETUP.md: 처음 나오는 `node --version` 뒤의 '나와야 하는 것' 블록(```text)의 첫 줄이 node --version의 출력이다
    const setup = readFileSync(join(REPO, 'docs', 'SERVER_SETUP.md'), 'utf8').replace(/\r\n/g, '\n');
    const after = setup.slice(setup.indexOf('node --version'));
    const doc = /^v(\d+\.\d+\.\d+)$/.exec(after.slice(after.indexOf('```text\n') + 8).split('\n')[0] ?? '')?.[1];
    expect([wf, doc]).toEqual(['24.13.0', '24.13.0']);
    if (pkg.engines?.node) expect(pkg.engines.node).toContain(wf!);
    expect(code).not.toMatch(/node-version-file|check-latest:\s*true/);
  });

  it('부르는 명령이 모두 있다 — npm run 이름은 package.json에, node로 부르는 파일은 저장소나 devDependencies 패키지에', () => {
    const npmRuns = [...runs.join('\n').matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]!);
    expect([...new Set(npmRuns)].sort()).toEqual(['build:server', 'build:web']);
    for (const s of npmRuns) expect(pkg.scripts[s], s).toBeDefined();
    const nodeFiles = [...runs.join('\n').matchAll(/(?:^|\s)node\s+([\w./-]+\.(?:m?js|cjs)|node_modules\/[\w./-]+)/gm)].map((m) => m[1]!);
    expect(new Set(nodeFiles)).toEqual(new Set(['node_modules/typescript/bin/tsc', 'src/renderer/tools/check-contract.mjs', 'node_modules/vitest/vitest.mjs', '.github/scripts/vitest-summary.mjs']));
    for (const f of nodeFiles) {
      if (f.startsWith('node_modules/')) expect(pkg.devDependencies[f.split('/')[1]!], f).toBeDefined();
      expect(existsSync(join(REPO, f)), f).toBe(true);
    }
    // 두 tsc 프로젝트와 npm ci
    expect(runs.filter((r) => /tsc --noEmit -p tsconfig\.(node|web)\.json/.test(r))).toHaveLength(2);
    expect(runs.some((r) => /^npm ci\b/m.test(r))).toBe(true);
    expect(code).toMatch(/^\s+ELECTRON_SKIP_BINARY_DOWNLOAD:\s*'1'\s*$/m);
  });

  it('비밀을 부르지 않는다 — secrets·토큰 없음, 권한은 contents: read뿐, checkout은 토큰을 남기지 않는다', () => {
    expect(text).not.toMatch(/secrets\.|secrets\[|GITHUB_TOKEN|github\.token|\btoken:|NODE_AUTH_TOKEN|registry-url/i);
    expect(/^permissions:\n((?:[ \t]+.*\n)+)/m.exec(code)?.[1]?.trim()).toBe('contents: read');
    expect(stepNamed('checkout')).toMatch(/persist-credentials:\s*false/);
    // 바깥에 내보내는 일이 없다 — 배포·릴리스·push·gh 호출
    expect(code).not.toMatch(/\bgit push\b|\bgh\s|deploy|release|ssh /i);
  });

  it('돈이 드는 자리: 작업 하나·matrix 없음·같은 가지의 앞 실행 취소·시간 상한, 그 가지의 push와 손으로 돌리기', () => {
    expect(/^on:\n((?:[ \t]+.*\n)+)/m.exec(code)?.[1]).toBe('  push:\n    branches: [server-redesign-s1-s5]\n  workflow_dispatch:\n');
    // jobs: 아래 둘째 칸의 이름이 작업이다
    expect(code.slice(code.indexOf('\njobs:\n')).match(/^ {2}[\w-]+:\s*$/gm), '작업').toEqual(['  linux:']);
    expect(code).toMatch(/^ {4}runs-on: ubuntu-24\.04$/m);
    expect(code).not.toMatch(/matrix:/);
    expect(Number(/^ {4}timeout-minutes:\s*(\d+)$/m.exec(code)?.[1])).toBeGreaterThan(0);
    expect(/^concurrency:\n((?:[ \t]+.*\n)+)/m.exec(code)?.[1]).toBe('  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n');
    // 쓰는 액션은 GitHub의 것(actions/…)이고 주 판으로 고정한다
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.sort()).toEqual(['actions/checkout@v7', 'actions/setup-node@v7', 'actions/upload-artifact@v7']);
    expect(stepNamed('node')).toMatch(/cache:\s*npm/);
  });

  it('스위트는 JSON 결과를 남기고 실패해도 다음 단계를 가리지 않는다 — 짧은 요약이 실패하는 단계이고, 결과는 끝에 올린다', () => {
    const suite = stepNamed('vitest (whole suite)');
    expect(suite).toMatch(/continue-on-error:\s*true/);
    expect(suite).toMatch(/--reporter=json --outputFile\.json=ci-out\/vitest\.json/);
    expect(suite).toMatch(/echo "\$rc" > ci-out\/suite-exit\.txt/);
    expect(stepNamed('failure summary')).toMatch(/vitest-summary\.mjs ci-out\/vitest\.json --exit-file ci-out\/suite-exit\.txt/);
    // npm ci 뒤의 모든 단계는 앞 단계가 실패해도 돈다(!cancelled()) — 한 실패가 다음 실패를 가리지 않게
    const afterDeps = steps.slice(steps.findIndex((s) => s.includes('- name: npm ci\n')) + 1);
    for (const s of afterDeps) expect(s, s.split('\n')[0]).toMatch(/if: \$\{\{ !cancelled\(\) && steps\.(deps|usermgr)\.outcome == 'success'/);
    expect(steps.at(-1)).toMatch(/uses: actions\/upload-artifact@v7[\s\S]*path: ci-out\//);
  });

  it('실제 시험 단계는 그 파일이 있을 때만 돌고, 문을 여는 이름이 시험 파일의 문과 같다 — 문이 닫혀 모두 건너뛰면 실패한다', () => {
    const desktop = stepNamed('real desktop (Linux, Xvfb)');
    expect(desktop).toMatch(/hashFiles\('tests\/real\/realDesktop\.linux\.test\.ts'\) != ''/);
    expect(desktop).toMatch(/WOOK_REAL_DESKTOP=1 WOOK_REAL_DESKTOP_HOST="\$\(hostname\)"/);
    expect(desktop).toMatch(/vitest\.mjs run [^\n]*tests\/real\/realDesktop\.linux\.test\.ts/);
    const unit = stepNamed('real unit (systemd --user)');
    expect(stepNamed('systemd user manager')).toMatch(/hashFiles\('tests\/real\/realUnit\.test\.ts'\) != ''[\s\S]*sudo loginctl enable-linger "\$\(id -un\)"/);
    expect(unit).toMatch(/WOOK_REAL_UNIT=1 WOOK_REAL_UNIT_HOST="\$\(hostname\)"/);
    expect(unit).toMatch(/XDG_RUNTIME_DIR: \$\{\{ steps\.usermgr\.outputs\.runtime \}\}/);
    for (const s of [desktop, unit]) expect(s).toMatch(/vitest-summary\.mjs ci-out\/real-[\w-]+\.json --exit-file ci-out\/real-[\w-]+-exit\.txt --require-ran/);
    // 두 실제 시험 파일은 있어야 한다 — 지우거나 이름을 바꾸면 hashFiles 문이 단계를 말없이 건너뛰어 일이 초록으로 끝난다 (리드 결정 S10-13 TD-13). 그 문이 같은 이름을 읽는다
    for (const [file, vars] of [
      ['tests/real/realDesktop.linux.test.ts', ['WOOK_REAL_DESKTOP', 'WOOK_REAL_DESKTOP_HOST']],
      ['tests/real/realUnit.test.ts', ['WOOK_REAL_UNIT', 'WOOK_REAL_UNIT_HOST']],
    ] as const) {
      const p = join(REPO, file);
      expect(existsSync(p), `${file}이 있어야 합니다`).toBe(true);
      const src = readFileSync(p, 'utf8');
      for (const v of vars) expect(src, `${file} ${v}`).toContain(v);
    }
    // X11 도구 (화면 도우미가 부르는 것)와 사용자 버스 — 실제 화면 시험 파일의 머리가 적은 꾸러미('필요한 꾸러미 (Ubuntu 24.04):')는 모두 설치한다
    const apt = stepNamed('apt packages');
    const want = new Set(['xvfb', 'openbox', 'xdotool', 'maim', 'x11-utils', 'x11-xserver-utils', 'xinput', 'xprintidle', 'python3-xlib', 'gir1.2-atspi-2.0', 'dbus-user-session', 'fonts-noto-cjk', 'procps']);
    const desktopTest = join(REPO, 'tests', 'real', 'realDesktop.linux.test.ts');
    if (existsSync(desktopTest)) {
      const head = /필요한 꾸러미 \(Ubuntu 24\.04\):([\s\S]*?)\n \*\s*\n/.exec(readFileSync(desktopTest, 'utf8').replace(/\r\n/g, '\n'))?.[1];
      expect(head, '실제 화면 시험 머리의 꾸러미 목록').toBeDefined();
      for (const p of head!.replace(/\n \*/g, ' ').split(/\s+/).filter(Boolean)) want.add(p);
    }
    for (const p of want) expect(apt, p).toMatch(new RegExp(`\\s${p.replace(/[.+]/g, '\\$&')}(\\s|$)`));
  });
});

describe('실패 요약 스크립트 (.github/scripts/vitest-summary.mjs)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-ci-summary-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const report = (o: { passed?: number; failed?: { file: string; title: string; message: string }[]; skipped?: number; loadError?: string }) => ({
    numTotalTestSuites: 2,
    numTotalTests: (o.passed ?? 0) + (o.failed?.length ?? 0) + (o.skipped ?? 0),
    numPassedTests: o.passed ?? 0,
    numFailedTests: o.failed?.length ?? 0,
    numPendingTests: o.skipped ?? 0,
    numTodoTests: 0,
    success: !o.failed?.length && !o.loadError,
    testResults: [
      {
        name: '/home/runner/work/wookagent/wookagent/tests/server/a.test.ts',
        status: o.failed?.length ? 'failed' : 'passed',
        message: '',
        assertionResults: [
          ...Array.from({ length: o.passed ?? 0 }, (_, i) => ({ ancestorTitles: ['묶음'], title: `통과 ${i}`, status: 'passed', failureMessages: [] })),
          ...(o.failed ?? []).map((f) => ({ ancestorTitles: ['묶음'], title: f.title, status: 'failed', failureMessages: [f.message] })),
          ...Array.from({ length: o.skipped ?? 0 }, (_, i) => ({ ancestorTitles: ['묶음'], title: `건너뜀 ${i}`, status: 'skipped', failureMessages: [] })),
        ],
      },
      ...(o.loadError ? [{ name: '/x/tests/server/b.test.ts', status: 'failed', message: o.loadError, assertionResults: [] }] : []),
    ],
  });
  let n = 0;
  const summarize = (r: unknown, exitCode: string | null, extra: string[] = []) => {
    const json = join(dir, `r${++n}.json`);
    if (r !== null) writeFileSync(json, typeof r === 'string' ? r : JSON.stringify(r));
    const exitFile = join(dir, `e${n}.txt`);
    if (exitCode !== null) writeFileSync(exitFile, `${exitCode}\n`);
    const p = spawnSync(process.execPath, [SUMMARY, json, '--exit-file', exitFile, ...extra], { encoding: 'utf8' });
    return { code: p.status, out: p.stdout };
  };

  it('모두 통과하고 끝 코드 0이면 0 — 한 줄 요약과 green', () => {
    const r = summarize(report({ passed: 3 }), '0');
    expect([r.code, r.out.split('\n')[0], r.out.trim().split('\n').at(-1)]).toEqual([0, 'tests: 3 total, 3 passed, 0 failed, 0 skipped, 0 todo; files: 2 suites, 0 files failed', 'RESULT: green']);
  });

  it('실패한 시험은 파일·제목·메시지 첫 줄을 내고 1 — node_modules 안의 스택 줄은 빼고, 저장소 밖 경로는 src/·tests/부터', () => {
    const message = 'AssertionError: expected 500 to be 200\n    at /home/runner/work/wookagent/wookagent/tests/server/a.test.ts:12:3\n    at async file:///w/node_modules/vitest/dist/x.js:1:1\n    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)';
    const r = summarize(report({ passed: 1, failed: [{ file: 'a', title: '긴 이름 첨부', message }] }), '1');
    expect(r.code).toBe(1);
    expect(r.out).toContain('-   1  tests/server/a.test.ts');
    expect(r.out).toContain('- tests/server/a.test.ts :: 묶음 > 긴 이름 첨부\n    AssertionError: expected 500 to be 200\n        at /home/runner/work/wookagent/wookagent/tests/server/a.test.ts:12:3\n');
    expect(r.out).not.toMatch(/node_modules|node:internal/);
    expect(r.out).toMatch(/RESULT: NOT GREEN — vitest exit code 1; 1 failed test\(s\)\n$/);
  });

  it('시험은 모두 통과해도 끝 코드가 0이 아니면(처리되지 않은 오류) 1, 실패한 시험 없는 실패 파일(불러오기 오류)도 1', () => {
    expect(summarize(report({ passed: 2 }), '1')).toMatchObject({ code: 1, out: expect.stringContaining('RESULT: NOT GREEN — vitest exit code 1') });
    const load = summarize(report({ passed: 1, loadError: 'Error: Cannot find module x' }), '1');
    expect([load.code, load.out.includes('## files that failed without a failed test (1)\n- tests/server/b.test.ts\n    Error: Cannot find module x')]).toEqual([1, true]);
  });

  it('결과 파일이 없거나 깨졌거나 끝 코드 파일이 없으면(실행이 끝나지 않음) 1', () => {
    expect(summarize(null, '1')).toMatchObject({ code: 1, out: expect.stringContaining('no JSON result at') });
    expect(summarize('{"testResults": [', '0')).toMatchObject({ code: 1, out: expect.stringContaining('JSON result unreadable') });
    expect(summarize(report({ passed: 1 }), null)).toMatchObject({ code: 1, out: expect.stringContaining('no exit code') });
  });

  it('--require-ran: 문이 닫혀 모두 건너뛰었거나 하나라도 돌지 않았으면 1 — 없으면 건너뜀은 실패가 아니다', () => {
    expect(summarize(report({ skipped: 4 }), '0', ['--require-ran'])).toMatchObject({ code: 1, out: expect.stringContaining('no test passed (was the gate open?)') });
    expect(summarize(report({ passed: 2, skipped: 1 }), '0', ['--require-ran'])).toMatchObject({ code: 1, out: expect.stringContaining('1 test(s) did not run') });
    expect(summarize(report({ passed: 2, skipped: 1 }), '0').code).toBe(0);
  });
});
