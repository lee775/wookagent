/**
 * AC-15 포트 단언의 도구 portHeldBy (리드 결정 S3-17, SERVER_DESIGN 10.11 AC-15 행 — 3단계 전 KNOWN_ISSUES 항목 'AC-15의 포트 단언이 병렬 실행에서 가끔 실패함'):
 * 기록한 개발 서버가 그 포트를 아직 들으면 true, 그 프로세스가 끝나 비운 번호를 다른 프로세스가 받았으면 false, 닫혔으면 false. 기록한 pid가 그 포트를 듣더라도
 * 기준 시각 뒤에 생긴 프로세스(번호를 다시 받은 다른 프로세스)면 false. 실제 프로세스와 실제 포트로 본다. 듣는 프로세스를 알아내지 못하는 갈래(조회 null·빈 목록)는
 * 조회를 바꿔 넣어 본다 — 열려 있으면 true (리드 결정 S3-30)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CREATED_AT_RESOLUTION_MS, listeningPids, portHeldBy, portOpen } from '../acceptance/stops-helpers';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
});

/** 127.0.0.1의 port(0이면 빈 포트)를 듣는 node 프로세스 — 들으면 그 포트를 알린다 */
function listener(port = 0): Promise<{ child: ChildProcess & { pid: number }; port: number }> {
  const child = spawn(process.execPath, ['-e', `const s=require('net').createServer();s.listen(${port},'127.0.0.1',()=>console.log('PORT '+s.address().port));setInterval(()=>{},1000)`], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  }) as ChildProcess & { pid: number };
  children.push(child);
  return new Promise((resolveIt, reject) => {
    let out = '';
    child.stdout!.setEncoding('utf8').on('data', (c: string) => {
      out += c;
      const m = /PORT (\d+)/.exec(out);
      if (m) resolveIt({ child, port: Number(m[1]) });
    });
    child.once('exit', (code) => reject(new Error(`듣는 프로세스가 먼저 끝났습니다 (${code})`)));
  });
}

const stop = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null ? r() : (c.once('exit', () => r()), c.kill())));

describe('portHeldBy (S3-17)', () => {
  it('기록한 개발 서버가 그 포트를 들으면 true — 다른 pid로 물으면 false, 끝나면 false', async () => {
    const since = Date.now() + 60_000;
    const a = await listener();
    expect(listeningPids(a.port)).toContain(a.child.pid);
    expect(await portHeldBy(a.port, a.child.pid, since)).toBe(true);
    expect(await portHeldBy(a.port, process.pid, since)).toBe(false);
    await stop(a.child);
    expect(await portOpen(a.port)).toBe(false);
    expect(await portHeldBy(a.port, a.child.pid, since)).toBe(false);
  }, 60_000);

  it('끝난 개발 서버가 비운 번호를 다른 프로세스가 받으면 열려 있어도 false — 예전 portOpen은 true였다 (병렬 실행에서 가끔 실패하던 경우)', async () => {
    const a = await listener();
    await stop(a.child);
    const stopAt = Date.now();
    // 정지 뒤에 생긴 프로세스: 생성 시각 해상도(Linux /proc 10ms 틱, macOS ps 1초)보다 뒤에 띄운다 — 같은 해상도 칸 안이면 보수적으로 남은 것으로 센다
    // Windows(CIM 100ns)는 기다리지 않는다 — 정지 바로 뒤에 띄운 경우도 그대로 본다 (리뷰 TD-10)
    if (CREATED_AT_RESOLUTION_MS > 1) await new Promise((r) => setTimeout(r, CREATED_AT_RESOLUTION_MS + 10));
    const b = await listener(a.port);
    expect(await portOpen(a.port)).toBe(true);
    expect(await portHeldBy(a.port, a.child.pid, stopAt)).toBe(false);
    // 다른 프로세스는 그 포트를 쥐고 있다 — 그 프로세스로 물으면(정지 뒤에 생겼으므로) 남은 것이 아니다, 정지 전 기준이면 남은 것이다
    expect(await portHeldBy(a.port, b.child.pid, stopAt)).toBe(false);
    expect(await portHeldBy(a.port, b.child.pid, Date.now() + 60_000)).toBe(true);
  }, 60_000);

  it('포트가 열려 있는데 듣는 프로세스를 알아내지 못하면(조회 null, 빈 목록) true — 예전 portOpen 단언보다 약해지지 않는다 (S3-30)', async () => {
    // Get-NetTCPConnection·lsof가 없거나 실패하는 PC, 듣는 쪽이 목록에 보이지 않는 경우 — 기록한 개발 서버가 남았을 수 있으니 남은 것으로 본다
    const a = await listener();
    const since = Date.now() + 60_000;
    expect(await portHeldBy(a.port, a.child.pid, since, () => null)).toBe(true);
    expect(await portHeldBy(a.port, a.child.pid, since, () => [])).toBe(true);
    // 다른 pid로 물어도 같다 — 누가 듣는지 모르면 그 pid가 아니라고 말할 수 없다
    expect(await portHeldBy(a.port, process.pid, since, () => null)).toBe(true);
    // 포트가 닫혔으면 조회와 상관없이 false
    await stop(a.child);
    expect(await portHeldBy(a.port, a.child.pid, since, () => null)).toBe(false);
    expect(await portHeldBy(a.port, a.child.pid, since, () => [])).toBe(false);
  }, 60_000);
});
