// 표준 입력을 끝까지 읽어 JSON 한 줄로 돌려준다. 종료 코드 = WOOK_FIXTURE_EXIT (기본 0)
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
});
process.stdin.on('end', () => {
  const reply = {
    stdin: input,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env.WOOK_FIXTURE_VALUE ?? null,
    pid: process.pid,
  };
  process.stdout.write(`${JSON.stringify(reply)}\n`);
  process.exitCode = Number(process.env.WOOK_FIXTURE_EXIT ?? '0');
});
