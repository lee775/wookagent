/**
 * Linux 운영자 명령 래퍼 `scripts/wook-server` (리드 결정 S10-6.8): sh, LF, 이 파일의 실제 자리(링크를 푼 것)에서 ../out/server/index.mjs를 PATH의 node로 띄우고
 * 인자를 그대로 넘긴다. `.gitattributes`가 LF를 정한다(Windows에서 체크아웃해도 sh가 읽는다). 실행 비트는 커밋할 때 리드가 붙인다.
 * - 모든 OS: 파일이 #!/bin/sh로 시작하고 CR이 없다, .gitattributes에 그 줄이 있다
 * - POSIX에서만: 래퍼를 임시 앱 폴더(scripts/·out/server/index.mjs — 받은 인자를 JSON으로 내는 작은 스크립트)에 두고, 빈칸·$·따옴표·한글이 든 인자가 그대로 닿는지,
 *   다른 폴더의 심볼릭 링크로 불러도 제 자리의 out/server를 찾는지, 끝 코드를 그대로 돌려주는지
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO, removeDir } from './helpers';

const SCRIPT = join(REPO, 'scripts', 'wook-server');
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

describe('scripts/wook-server (S10-6.8)', () => {
  it('sh 스크립트이고 LF뿐이다 — .gitattributes가 LF를 정한다', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
    expect(readFileSync(join(REPO, '.gitattributes'), 'utf8').split('\n')).toContain('scripts/wook-server text eol=lf');
  });

  // 커밋된 파일에 실행 비트가 있어야 `scripts/wook-server …`가 새 클론에서 돈다 — CI는 커밋된 모드로 체크아웃하고, 리드의 wsl-sync.sh도 Linux 복사본에 그 비트를 준다
  // (리드 결정 S10-13 SH-9). Windows의 파일 시스템에는 실행 비트가 없다
  it.skipIf(process.platform === 'win32')('저장소의 scripts/wook-server에 실행 비트가 있다 (POSIX — Windows에는 실행 비트가 없다)', () => {
    expect((statSync(SCRIPT).mode & 0o111) !== 0).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('인자를 그대로 넘기고, 링크로 불러도 제 자리의 out/server를 찾으며, 끝 코드를 돌려준다 (POSIX)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wook-test-wrapper-'));
    dirs.push(root);
    const app = join(root, '욱채 앱');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    mkdirSync(join(app, 'out', 'server'), { recursive: true });
    const wrapper = join(app, 'scripts', 'wook-server');
    copyFileSync(SCRIPT, wrapper);
    chmodSync(wrapper, 0o755);
    writeFileSync(join(app, 'out', 'server', 'index.mjs'), "process.stdout.write(JSON.stringify({ here: import.meta.url, argv: process.argv.slice(2) }));\nprocess.exitCode = process.argv.includes('--fail') ? 3 : 0;\n");
    const args = ['status', '--data-dir', '/srv/a b/$HOME "q" \'s\' 한글', '--json'];
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env['PATH'] ?? ''}` };
    const direct = spawnSync(wrapper, args, { encoding: 'utf8', env });
    expect([direct.status, JSON.parse(direct.stdout).argv]).toEqual([0, args]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(wrapper, join(bin, 'wook-server'));
    const viaLink = spawnSync(join(bin, 'wook-server'), ['check', '--fail'], { encoding: 'utf8', env });
    const out = JSON.parse(viaLink.stdout) as { here: string; argv: string[] };
    expect([viaLink.status, out.argv, decodeURIComponent(out.here).endsWith('/욱채 앱/out/server/index.mjs')]).toEqual([3, ['check', '--fail'], true]);
  });
});
