/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1'이면 서버가 내주는 웹 화면 빌드 (리드 결정 S8-4, api/env.ts) */
  readonly VITE_WOOK_REMOTE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
