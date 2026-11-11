import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// 서버 빌드 (npm run build:server, SERVER_DESIGN 3.2·S2-9): src/server/index.ts → out/server/index.mjs (Node ESM 한 파일).
// 둘째 입구 (7단계 S7c, 리드 결정 S7-5): 외부 에이전트의 명령 src/cli/wook.ts → out/server/wook.mjs. 두 입구가 함께 쓰는 모듈은 같은 폴더의 조각(.mjs)으로 나뉜다
// - @shared·@core 별칭을 푼다
// - package.json의 의존성(네이티브 모듈 @napi-rs/keyring 등)과 Node 내장 모듈은 묶지 않는다 — 저장소의 node_modules에서 불러온다
// - import.meta.url을 그대로 둔다: secretStore.ts가 이것으로 @napi-rs/keyring을 찾고(깨지면 조용히 메모리 저장으로 떨어진다),
//   serve.ts가 앱 루트(resources/가 있는 저장소 루트 = out/server의 두 단계 위)를 찾는다
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const packages = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const isExternal = (id: string): boolean => id.startsWith('node:') || builtins.has(id) || packages.some((p) => id === p || id.startsWith(`${p}/`));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core'),
    },
  },
  ssr: { target: 'node', external: packages },
  build: {
    // 입구는 rolldownOptions.input (둘)
    ssr: true,
    outDir: resolve('out/server'),
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    rolldownOptions: {
      input: { index: resolve('src/server/index.ts'), wook: resolve('src/cli/wook.ts') },
      external: isExternal,
      // 서버 본체(serve)는 따로 나뉜다(cli.ts가 serve일 때만 불러온다) — 같은 폴더의 .mjs로
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: '[name].mjs' },
    },
  },
});
