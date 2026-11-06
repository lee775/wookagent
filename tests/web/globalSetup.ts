/**
 * 브라우저 시험의 준비 (vitest.web.config.ts의 globalSetup — tests/setup/runTemp.ts 다음에 돈다):
 * - Microsoft Edge가 있는지 본다. 없으면 빌드도 하지 않고, 시험은 그 까닭을 이름에 단 채 건너뛴다(조용히 건너뛰지 않는다 — 여기서도 경고를 낸다)
 * - 서버용 웹 화면을 이번 실행에 한 번 만든다: `npm run build:web`과 같은 remote 모드 빌드를 실행 폴더(OS 임시 폴더) 안에 — 저장소의 out/web을 덮지 않는다.
 *   빌드는 서버용 빌드 검사(vite.web.config.ts remoteWebBuild — 가짜 브리지·루프백 CSP가 들어가면 실패)를 거친다. 실패하면 실행 전체가 실패한다
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

export interface WebE2eContext {
  /** 만든 서버용 웹 화면 폴더 (건너뛸 때 null) */
  webDir: string | null;
  /** 건너뛰는 까닭 (돌 때 null) */
  skipReason: string | null;
}

declare module 'vitest' {
  export interface ProvidedContext {
    webE2e: WebE2eContext;
  }
}

/** Playwright의 msedge 채널이 찾는 자리 (playwright-core 1.64 registry와 같은 곳) */
export function edgeCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const roots = [env['LOCALAPPDATA'], env['PROGRAMFILES'], env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)']].filter((x): x is string => !!x);
    return roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/opt/microsoft/msedge/msedge'];
}

export default function setup(project: TestProject): void {
  const candidates = edgeCandidates();
  if (!candidates.some((p) => existsSync(p))) {
    const skipReason = `Microsoft Edge가 이 PC에 없어 브라우저 시험을 건너뜁니다 (찾은 자리: ${candidates.join(', ') || '없음'}). Edge를 설치한 뒤 npm run test:web을 다시 실행하세요`;
    console.warn(`[웹 시험] ${skipReason}`);
    project.provide('webE2e', { webDir: null, skipReason });
    return;
  }
  const webDir = mkdtempSync(join(tmpdir(), 'wook-web-e2e-'));
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.web.config.ts', '--mode', 'remote', '--outDir', webDir, '--emptyOutDir', '--logLevel', 'error'],
    { stdio: 'inherit', env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' } },
  );
  if (r.status !== 0) throw new Error(`서버용 웹 화면을 만들지 못했습니다 (vite build --mode remote, 종료 코드 ${r.status ?? r.signal})`);
  console.info(`[웹 시험] 서버용 웹 화면 빌드 ${((Date.now() - started) / 1000).toFixed(1)}초 → ${webDir}`);
  project.provide('webE2e', { webDir, skipReason: null });
}
