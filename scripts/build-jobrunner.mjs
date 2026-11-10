// 개발용: resources/jobrunner/JobRunner.cs → resources/jobrunner/bin/WookJobRunner.exe (+ .sha256)
// 실행: npm run jobrunner:build  (해시가 같아도 다시 빌드하려면 -- --force)
//       화면 도우미: npm run jobrunner:build -- --desktop  → resources/desktophelper/bin/WookDesktopHelper.exe (+ .sha256)
//       화면 도우미는 컴파일만 한다 — 확인(--probe)도 띄우지 않는다. 대표가 쓰는 PC의 화면·입력을 건드리지 않게 (리드 결정 S6-15)
// 앱은 실행 중에 <앱데이터>/bin 으로 따로 컴파일한다 — 이 스크립트는 손으로 시험할 때 쓴다.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  console.log('WookJobRunner·WookDesktopHelper는 Windows 전용이라 빌드하지 않습니다.');
  process.exit(0);
}

// compiledTool.ts를 Node 형식 제거로 직접 불러온다. package.json에 "type"이 없어 나오는 안내 경고만 숨긴다.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  for (const listener of defaultWarningListeners) listener(warning);
});

const { DESKTOP_HELPER_TOOL, JOB_RUNNER_TOOL, ensureCompiledTool } = await import('../src/main/process/compiledTool.ts');

const desktop = process.argv.includes('--desktop');
const spec = desktop ? DESKTOP_HELPER_TOOL : JOB_RUNNER_TOOL;
const dir = join(root, 'resources', spec.resourceDir);

const result = await ensureCompiledTool(spec, {
  dataDir: dir,
  sourcePath: join(dir, spec.sourceName),
  force: process.argv.includes('--force'),
  probe: !desktop,
});

if (!result.ok) {
  console.error(`${spec.label} 빌드 실패: ${result.reason}`);
  process.exit(1);
}
console.log(`${result.compiled ? '빌드함' : '변경 없음'}: ${result.exePath} (${result.durationMs}ms) — ${result.detail}`);
