import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { remoteBuildProblems, WEB_BUILD_MARKER, WEB_SCREEN_META_CSP, type BuiltChunk } from './src/server/webScreen';

/**
 * 브라우저 화면 설정 (리드 결정 S8-5).
 * - `npm run build:web` (mode `remote`, `src/renderer/.env.remote`의 VITE_WOOK_REMOTE=1): 서버가 `--web-dir`로 내주는 화면 → `out/web`. 원격 브리지를 쓰고
 *   가짜 브리지가 없다. index.html에 서버용 빌드 표시와 서버용 CSP meta(루프백 주소 없음)를 넣고, 결과를 검사해 어긋나면 빌드를 실패시킨다(src/server/webScreen.ts)
 * - `npm run dev:web`: 가짜 API(src/renderer/src/api/fake)로 화면만 띄워 보는 개발 서버 (5199). 실제 서버의 Origin이 아니라 서버에 붙지 않는다
 * - mode 없이 `vite build`를 하면 가짜 API 화면을 `out/web-demo`에 만든다 — 서버용 `out/web`을 덮지 않는다(서버는 표시가 없어 받지도 않는다)
 */
const FAKE_DIR = resolve('src/renderer/src/api/fake');

/**
 * 서버용 빌드: index.html의 CSP meta를 서버용으로 바꾸고 빌드 표시를 넣은 뒤, 다 묶은 결과를 검사한다. 시험(tests/server/webStatic.test.ts)은 설정 함수를
 * mode `remote`로 불러 이 플러그인을 꺼내 쓴다 — 이름 있는 내보내기를 두면 설정을 묶을 때마다 MIXED_EXPORTS 경고가 난다
 */
function remoteWebBuild(): Plugin {
  return {
    name: 'wook-remote-web-build',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const csp = /<meta http-equiv="Content-Security-Policy" content="[^"]*"\s*\/?>/g;
        const count = html.match(csp)?.length ?? 0;
        if (count !== 1) throw new Error(`src/renderer/index.html에 CSP meta가 하나여야 서버용 정책으로 바꿉니다 (지금 ${count}개)`);
        return html.replace(csp, `<meta http-equiv="Content-Security-Policy" content="${WEB_SCREEN_META_CSP}" />\n    ${WEB_BUILD_MARKER}`);
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const html = bundle['index.html'];
        const chunks: BuiltChunk[] = [];
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk') continue;
          chunks.push({ fileName: item.fileName, code: item.code, moduleIds: item.moduleIds ?? Object.keys(item.modules ?? {}) });
        }
        const problems = remoteBuildProblems({ html: html && html.type === 'asset' ? String(html.source) : null, chunks, fakeDir: FAKE_DIR });
        if (problems.length > 0) this.error(`서버용 웹 화면 빌드 검사 실패:\n- ${problems.join('\n- ')}`);
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const remote = mode === 'remote';
  return {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), ...(remote ? [remoteWebBuild()] : [])],
    server: { host: '127.0.0.1', port: 5199, strictPort: true },
    build: { outDir: resolve(remote ? 'out/web' : 'out/web-demo'), emptyOutDir: true },
  };
});
