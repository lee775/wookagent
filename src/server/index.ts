/**
 * 서버 진입점 (SERVER_DESIGN 3.2, S2-5·S2-9): `npm run build:server`가 이 파일을 out/server/index.mjs로 묶는다 (vite.server.config.ts).
 * 인자를 cli.ts에 넘긴다 — 서버(serve)면 준비된 뒤에도 프로세스가 남고 종료 흐름이 끝낸다. 운영자 명령은 결과 코드로 끝낸다.
 */
import { readSecretInput, runCli } from './cli';

/** 운영체제에 넘긴 뒤에 돌아온다 — 바로 끝내도 출력이 잘리지 않게 */
const writeTo = (stream: NodeJS.WriteStream) => (text: string) =>
  new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
  });

const err = writeTo(process.stderr);
const io = {
  out: writeTo(process.stdout),
  err,
  exit: (code: number) => process.exit(code),
  // 운영자 명령 secret set의 비밀 값 — 표준 입력으로만 받는다 (S3-8). 묻는 글은 stderr로 — stdout에는 결과(--json이면 JSON 한 줄)만 나간다
  readSecret: () => readSecretInput(process.stdin, err),
};

void runCli(process.argv.slice(2), io).then(
  (code) => {
    if (code !== null) io.exit(code);
  },
  (error: unknown) => {
    void io.err(`욱채 서버 명령을 처리하지 못했습니다: ${error instanceof Error ? error.message : String(error)}\n`).then(() => io.exit(1));
  },
);
