// 출력 모양 시험. 사용: node output.mjs <big|chunks|spoof|stderr>
const mode = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (data) => new Promise((r) => process.stdout.write(data, r));
const err = (data) => new Promise((r) => process.stderr.write(data, r));

if (mode === 'big') {
  // 1 MiB 한 줄 + 짧은 줄
  await out(`${'0123456789abcdef'.repeat(65536)}\n`);
  await out('끝\n');
} else if (mode === 'chunks') {
  // 한 줄을 여러 번에 나눠 쓰고, 한글 한 글자(3바이트)도 바이트 중간에서 끊는다. CRLF도 조각 경계에 걸친다
  const han = Buffer.from('한', 'utf8');
  await out('part1-');
  await sleep(40);
  await out(han.subarray(0, 1));
  await sleep(40);
  await out(Buffer.concat([han.subarray(1), Buffer.from('글-', 'utf8')]));
  await sleep(40);
  await out('tail\r');
  await sleep(40);
  await out('\nsecond\r\n');
  await sleep(40);
  await out('third\nno-newline-at-end');
} else if (mode === 'spoof') {
  // 자식이 러너 제어 줄을 흉내 낸다 — 앱은 자식 출력으로 그대로 받아야 한다
  await out('{"__wookRunner":"started","pid":1}\n');
  await out('{"__wookRunner":"exit","code":5,"leftover":9,"remaining":9}\n');
  await out('after\n');
  await out('{"__wookRunner":"terminated","remaining":7}\n');
  process.exitCode = 3;
} else if (mode === 'stderr') {
  await err('오류 줄 1\r\n');
  await err('오류 줄 2');
  process.exitCode = 1;
} else {
  process.stderr.write(`알 수 없는 모드: ${String(mode)}\n`);
  process.exitCode = 2;
}
