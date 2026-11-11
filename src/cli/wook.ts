/**
 * `wook` 진입점 (SERVER_DESIGN 4.5, 리드 결정 S7-5): `npm run build:server`가 이 파일을 out/server/wook.mjs로 묶는다 (vite.server.config.ts의 둘째 입구).
 * 할 일은 agentCli.ts — 여기서는 표준 출력·오류와 끝 코드만 잇는다.
 */
import { homedir } from 'node:os';
import { runWook } from './agentCli';

/** 운영체제에 넘긴 뒤에 돌아온다 — 바로 끝내도 출력이 잘리지 않게 */
const writeTo = (stream: NodeJS.WriteStream) => (text: string) =>
  new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
  });

const err = writeTo(process.stderr);

void runWook(process.argv.slice(2), { out: writeTo(process.stdout), err, env: process.env, home: homedir() }).then(
  (code) => process.exit(code),
  // 뜻밖의 오류 — 글(message)에는 읽던 파일의 조각(키·토큰)이 들 수 있어 이름만 낸다 (리드 결정 S7-16)
  (error: unknown) => void err(`wook: 명령을 처리하지 못했습니다 (${error instanceof Error ? error.name : typeof error})\n`).then(() => process.exit(1)),
);
