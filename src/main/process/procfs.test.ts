/**
 * Linux /proc 읽기 (리드 결정 S10-5) — 가짜 /proc 루트로 Windows에서도 돈다. 실제 /proc로 보는 시험은 processRunner.test.ts의 pgroup 묶음(Linux만).
 * 잡는 결함: comm 속 괄호·공백·줄바꿈에 칸을 잘못 나눔(엉뚱한 시작 틱 → 남의 프로세스를 우리 것으로), ps lstart와 다른 생성 시각 식(예전 기록과 1초
 * 넘게 어긋남), 부팅·틱을 느슨하게 견줌(재부팅·PID 재사용 뒤 남의 프로세스를 같은 것으로), 표시 환경 변수를 이름 일부로 맞춤(다른 실행의 후손을 끝냄),
 * 실행보다 오래된 프로세스까지 고름, 좀비·욱채 자신을 고름, /proc를 읽지 못했는데 '없음'으로 답함
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeProcRoot, FAKE_BOOT_ID, SELF_CGROUP, statLine, type FakeProcRoot } from './__fixtures__/fakeProcRoot';
import { sweepSnapshot } from './processRunner';
import {
  compareProcStart,
  createdAtFromTicks,
  environHas,
  cgroupWithin,
  findRunLeftovers,
  groupRunOwnership,
  linuxProcProblem,
  ownProcessGroup,
  parseProcStart,
  parseProcStat,
  parseRunTag,
  procCreatedAt,
  procGroupMembers,
  procStartOf,
  procStartsOf,
  readBootId,
  readCgroupPath,
  readBtime,
  sameLiveProcess,
  USER_HZ,
} from './procfs';

const roots: FakeProcRoot[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.cleanup();
});
function fake(o: { bootId?: string; btime?: number } = {}): FakeProcRoot {
  const r = createFakeProcRoot(o);
  roots.push(r);
  return r;
}

const TAG = 'WOOK_RUN_TAG=abc123';

describe('stat 한 줄 읽기 — comm은 마지막 ) 뒤부터 나눈다', () => {
  it('comm에 공백·괄호·줄바꿈이 있어도 칸(상태·부모·그룹·세션·22번째 시작 틱)을 맞게 읽는다', () => {
    for (const comm of ['node', 'a) b (c', 'x y', ') )', 'line\nbreak', '(sd-pam)']) {
      const line = statLine({ pid: 42, comm, state: 'R', ppid: 7, pgrp: 40, session: 39, ticks: 987_654 });
      expect(parseProcStat(line), JSON.stringify(comm)).toEqual({ state: 'R', ppid: 7, pgrp: 40, session: 39, startTicks: 987_654 });
    }
  });

  it('칸이 모자라거나 숫자가 아니거나 괄호가 없으면 null — 엉뚱한 값을 쓰지 않는다', () => {
    const good = statLine({ pid: 42, ticks: 5 });
    expect(parseProcStat(good.slice(0, good.indexOf(' 5 12345678')))).toBeNull(); // 22번째 칸 전에 잘림
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('42 node S 1 42 42 0')).toBeNull();
    expect(parseProcStat(good.replace(' 5 12345678', ' x5 12345678'))).toBeNull();
    expect(parseProcStat(good.replace(') S ', ') ?? '))).toBeNull();
  });
});

describe('부팅 기준 신원·생성 시각 (가짜 루트)', () => {
  it('boot id + 22번째 칸 = 신원, 없는 PID·모양이 틀린 boot id는 없음', () => {
    const r = fake().add({ pid: 100, ticks: 12_345 }).add({ pid: 101, ticks: 99 });
    expect(procStartOf(100, r.root)).toEqual({ bootId: FAKE_BOOT_ID, ticks: 12_345 });
    expect(procStartsOf([100, 101, 555], r.root)).toEqual(new Map([[100, { bootId: FAKE_BOOT_ID, ticks: 12_345 }], [101, { bootId: FAKE_BOOT_ID, ticks: 99 }]]));
    expect(procStartOf(555, r.root)).toBeNull();
    r.setBootId('not-a-uuid');
    expect(readBootId(r.root)).toBeNull();
    expect(procStartOf(100, r.root)).toBeNull();
    expect(procStartsOf([100], r.root).size).toBe(0);
  });

  it('생성 시각은 ps lstart와 같은 식 (btime + ⌊틱/100⌋)초 — 99·100·101틱 경계, btime을 옮기면(시계 이동) 함께 움직인다', () => {
    expect(USER_HZ).toBe(100);
    const btime = 1_762_900_000;
    const r = fake({ btime }).add({ pid: 10, ticks: 99 }).add({ pid: 11, ticks: 100 }).add({ pid: 12, ticks: 101 }).add({ pid: 13, ticks: 0 });
    expect(procCreatedAt([10, 11, 12, 13, 99], r.root)).toEqual(
      new Map([
        [10, btime * 1000],
        [11, (btime + 1) * 1000],
        [12, (btime + 1) * 1000],
        [13, btime * 1000],
      ]),
    );
    expect(createdAtFromTicks(btime, 12_345)).toBe((btime + 123) * 1000);
    r.setBtime(btime + 5);
    expect(procCreatedAt([11], r.root).get(11)).toBe((btime + 6) * 1000);
    expect(procStartOf(11, r.root)).toEqual({ bootId: FAKE_BOOT_ID, ticks: 100 }); // 신원은 시계와 상관없다
    r.setBtime(null);
    expect(readBtime(r.root)).toBeNull();
    expect(procCreatedAt([11], r.root).size).toBe(0);
  });
});

describe('신원 비교 — 실행 잠금·데이터 주인·재시작 복구가 함께 쓴다', () => {
  const s = (ticks: number, bootId = FAKE_BOOT_ID) => ({ bootId, ticks });
  it('둘 다 있으면 정확히: 같은 부팅·같은 틱만 same, 틱이 1만 달라도·부팅이 다르면 different, 한쪽이라도 없으면 unknown', () => {
    expect(compareProcStart(s(500), s(500))).toBe('same');
    expect(compareProcStart(s(500), s(501))).toBe('different');
    expect(compareProcStart(s(500), s(500, '11111111-2222-4333-8444-555555555555'))).toBe('different');
    expect(compareProcStart(s(500), null)).toBe('unknown');
    expect(compareProcStart(undefined, s(500))).toBe('unknown');
    expect(compareProcStart(null, undefined)).toBe('unknown');
  });

  it('기록에서 읽은 값: 모양이 틀리면 없는 것(예전 규칙으로) — boot id 대소문자는 맞춘다', () => {
    expect(parseProcStart({ bootId: FAKE_BOOT_ID.toUpperCase(), ticks: 7 })).toEqual({ bootId: FAKE_BOOT_ID, ticks: 7 });
    for (const bad of [null, 'x', 5, {}, { bootId: FAKE_BOOT_ID }, { ticks: 5 }, { bootId: 'nope', ticks: 5 }, { bootId: FAKE_BOOT_ID, ticks: -1 }, { bootId: FAKE_BOOT_ID, ticks: 1.5 }, { bootId: FAKE_BOOT_ID, ticks: '5' }]) {
      expect(parseProcStart(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('그룹 구성원·자기 그룹 (ps·pgrep 대신 /proc)', () => {
  it('stat 5번째 칸이 그 그룹인 프로세스만 (좀비 포함 — pgrep -g와 같다), /proc를 읽지 못하면 null', () => {
    const r = fake()
      .add({ pid: 300, pgrp: 300, ticks: 10 })
      .add({ pid: 301, pgrp: 300, ppid: 300, ticks: 11 })
      .add({ pid: 302, pgrp: 300, ppid: 1, state: 'Z', ticks: 12 })
      .add({ pid: 303, pgrp: 303, ppid: 301, ticks: 13 });
    expect(procGroupMembers(300, r.root)?.sort()).toEqual([300, 301, 302]);
    expect(procGroupMembers(999, r.root)).toEqual([]);
    expect(procGroupMembers(300, `${r.root}-없음`)).toBeNull();
    r.add({ pid: process.pid, pgrp: 4242, ticks: 1 });
    expect(ownProcessGroup(r.root)).toBe(4242);
  });
});

describe('한 실행이 남긴 프로세스 찾기 (S10-5.2)', () => {
  it('표시가 있는 프로세스(그룹을 떠났어도)·그룹 구성원에서 부모로 이어진 후손(환경을 지웠어도)을 찾고, 실행보다 오래된 것·좀비·욱채 자신·표시가 비슷한 이름은 고르지 않는다', () => {
    const r = fake()
      // 실행 전부터 있던 대표의 프로그램 — 같은 표시를 가졌어도(그럴 리 없지만) 시작 틱으로 거른다
      .add({ pid: 50, ticks: 100, environ: { WOOK_RUN_TAG: 'abc123' } })
      // 그룹 리더(실행)와 그룹 안 자식
      .add({ pid: 1000, pgrp: 1000, ticks: 1000, environ: { WOOK_RUN_TAG: 'abc123' } })
      .add({ pid: 1001, pgrp: 1000, ppid: 1000, ticks: 1001, environ: { WOOK_RUN_TAG: 'abc123' } })
      // setsid로 그룹을 떠난 후손 (부모가 먼저 끝나 init에 붙음) — 표시로 찾는다
      .add({ pid: 1002, pgrp: 1002, ppid: 1, ticks: 1002, environ: { PATH: '/bin', WOOK_RUN_TAG: 'abc123', HOME: '/h' } })
      // 환경을 지우고 setsid한 후손: 부모(1001)가 살아 있다 — 부모로 찾는다
      .add({ pid: 1003, pgrp: 1003, ppid: 1001, ticks: 1003, environ: { PATH: '/bin' } })
      // 그 후손의 자식도
      .add({ pid: 1004, pgrp: 1003, ppid: 1003, ticks: 1004, environ: {} })
      // 환경을 지우고 부모가 먼저 끝난 후손 — 찾을 수 없다 (문서의 한계)
      .add({ pid: 1005, pgrp: 1005, ppid: 1, ticks: 1005, environ: { PATH: '/bin' } })
      // 다른 실행의 표시 (이름만 비슷함) · 좀비 · 환경을 읽지 못하는 프로세스
      .add({ pid: 1006, pgrp: 1006, ppid: 1, ticks: 1006, environ: { WOOK_RUN_TAG: 'abc1234', XWOOK_RUN_TAG: 'abc123' } })
      .add({ pid: 1007, pgrp: 1007, ppid: 1, ticks: 1007, state: 'Z', environ: { WOOK_RUN_TAG: 'abc123' } })
      .add({ pid: 1008, pgrp: 1008, ppid: 1, ticks: 1008, environ: null })
      // 욱채 자신 (그럴 리 없지만 표시가 있어도 고르지 않는다)
      .add({ pid: 1009, pgrp: 1009, ppid: 1, ticks: 1009, environ: { WOOK_RUN_TAG: 'abc123' } });
    const sorted = (x: { found: { pid: number; via: string }[] } | null) => x?.found.map((p) => `${p.pid}:${p.via}`).sort();
    // 정지 전 (그룹이 살아 있음): 부모로 이어진 그룹 밖 후손만 — 표시는 보지 않는다
    expect(sorted(findRunLeftovers({ root: r.root, tagEntry: null, minTicks: 1000, treeFrom: [1000, 1001], exclude: new Set([1009]) }))).toEqual(['1003:tree', '1004:tree']);
    // 그룹이 사라진 뒤: 표시로, 그리고 표시로 찾은 것(1001)에서 부모로 이어진 후손(1003·1004 — 표시가 없어도, S10-16 FPS-1). 환경을 읽지 못한 같은
    // 사용자의 프로세스(1008)는 아무것에도 이어지지 않으니 찾은 것이 아니라 이름만 남기는 것 — 확인하지 못한 것도 아니다 (S10-14)
    const after = findRunLeftovers({ root: r.root, tagEntry: TAG, minTicks: 1000, exclude: new Set([1009]) });
    expect(sorted(after)).toEqual(['1000:tag', '1001:tag', '1002:tag', '1003:tree', '1004:tree']);
    expect(after!.unattributed.map((u) => u.pid)).toEqual([1008]);
    expect(after!.unchecked).toEqual([]);
    expect(findRunLeftovers({ root: `${r.root}-없음`, tagEntry: TAG, minTicks: 1000 })).toBeNull();
  });

  it('표시는 이 서버의 cgroup이나 그 아래에서만 센다 — 사용자 관리자가 띄운 유닛(다른 cgroup)에 넘어간 표시는 이 실행의 것이 아니다 (S10-13 LP-1, cgroup v2)', () => {
    const r = fake()
      .add({ pid: 2001, ticks: 2001, environ: { WOOK_RUN_TAG: 'abc123' } })
      .add({ pid: 2002, ticks: 2002, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: `0::${SELF_CGROUP}/sub.scope\n` })
      .add({ pid: 2003, ticks: 2003, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u7.service\n' })
      .add({ pid: 2004, ticks: 2004, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: `0::${SELF_CGROUP}-other.service\n` })
      // 다른 cgroup의 덤프 불가 프로세스: 이 실행의 것이 아니니 확인하지 못한 것도 아니다
      .add({ pid: 2005, ticks: 2005, environ: null, cgroup: '0::/user.slice/user-1000.slice/session-3.scope\n' });
    const scan = findRunLeftovers({ root: r.root, tagEntry: TAG, minTicks: 2000 })!;
    expect(scan.found.map((p) => p.pid).sort()).toEqual([2001, 2002]);
    expect(scan.unchecked).toEqual([]);
    expect(scan.unattributed).toEqual([]);
  });

  it('표시가 있는데 cgroup을 읽지 못한 후보는 확인하지 못한 것(-1)으로, 이 서버의 cgroup 안 같은 사용자의 환경을 읽지 못한 후보는 이름만 — 둘 다 신호하지 않는다. 다른 사용자는 어느 쪽도 아니다 (S10-13 LP-1, S10-14)', () => {
    const r = fake()
      .add({ pid: 3001, ticks: 3001, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: null })
      .add({ pid: 3002, ticks: 3002, environ: null })
      .add({ pid: 3003, ticks: 3003, environ: null, uid: 0 })
      .add({ pid: 3004, ticks: 3004, environ: { PATH: '/bin' } })
      // cgroup을 모르는데 표시가 없거나 환경도 읽지 못하는 것은 이 실행과 이어 줄 것이 없다 — 확인하지 못한 것으로 세지 않는다
      .add({ pid: 3005, ticks: 3005, environ: { PATH: '/bin' }, cgroup: null })
      .add({ pid: 3006, ticks: 3006, environ: null, cgroup: null });
    const scan = findRunLeftovers({ root: r.root, tagEntry: TAG, minTicks: 3000 })!;
    expect(scan.found).toEqual([]);
    expect(scan.unchecked.map((u) => `${u.pid}:${u.why}`)).toEqual([expect.stringMatching(/^3001:cgroup을 읽지 못함/)]);
    expect(scan.unattributed.map((u) => `${u.pid}:${u.why}`)).toEqual([expect.stringMatching(/^3002:환경을 읽지 못함/)]);
  });

  it('같은 cgroup을 나누는 다른 실행·다른 프로그램의 프로세스는 이 실행의 결과를 "확인하지 못함"으로 만들지 않는다 (S10-14, WSL의 /non-systemd 같은 공유 cgroup)', () => {
    const r = fake()
      // 같은 cgroup의 다른 실행 (다른 표시) — cgroup을 읽을 때도, 읽지 못할 때도
      .add({ pid: 7001, ticks: 7001, environ: { WOOK_RUN_TAG: 'fff999' } })
      .add({ pid: 7002, ticks: 7002, environ: { WOOK_RUN_TAG: 'fff999' }, cgroup: null })
      // 같은 cgroup의 다른 프로그램 — 표시 없음, 환경을 읽지 못함 (덤프 불가), 실행 전에 시작한 덤프 불가
      .add({ pid: 7003, ticks: 7003, environ: { PATH: '/bin' } })
      .add({ pid: 7004, ticks: 7004, environ: null })
      .add({ pid: 6999, ticks: 6999, environ: null });
    const scan = findRunLeftovers({ root: r.root, tagEntry: TAG, minTicks: 7000 })!;
    expect(scan.found).toEqual([]);
    expect(scan.unchecked).toEqual([]);
    // 이 실행 뒤에 시작한 덤프 불가 프로세스는 이름만 남는다 — 실행 전의 것은 이름도 남기지 않는다
    expect(scan.unattributed.map((u) => u.pid)).toEqual([7004]);
  });

  it('부모로 닫는다: 표시로 찾은 것과 뿌리 모두에서 부모 PID로 이어진 후손은 표시·cgroup·환경을 읽을 수 있는지와 상관없이 고른다 — 이어지지 않은 덤프 불가 프로세스만 이름으로 (S10-16 FPS-1)', () => {
    const r = fake()
      // 표시로 찾는 고아 감싸개 (부모는 init)
      .add({ pid: 8001, ppid: 1, ticks: 8001, environ: { WOOK_RUN_TAG: 'abc123' } })
      // 그 자식들: 빈 환경(env -i), 제목을 덮어씀, 덤프 불가, tmux 창처럼 다른 cgroup, 표시는 있는데 cgroup을 읽지 못함
      .add({ pid: 8002, ppid: 8001, ticks: 8002, environ: {} })
      .add({ pid: 8003, ppid: 8001, ticks: 8003, environ: { 'myworker: master': '' } })
      .add({ pid: 8004, ppid: 8001, ticks: 8004, environ: null })
      .add({ pid: 8005, ppid: 8001, ticks: 8005, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.slice/tmux-spawn-1.scope\n' })
      .add({ pid: 8006, ppid: 8001, ticks: 8006, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: null })
      // 손자 (빈 환경의 자식)
      .add({ pid: 8007, ppid: 8002, ticks: 8007, environ: {} })
      // 신호 전 스냅숏에서 온 뿌리와 그 자식 (표시 없음)
      .add({ pid: 8100, ppid: 1, ticks: 8100, environ: {} })
      .add({ pid: 8101, ppid: 8100, ticks: 8101, environ: {} })
      // 아무것에도 이어지지 않은 것: 덤프 불가(이름만), 표시 없음(무시), 다른 cgroup의 표시(무시)
      .add({ pid: 8200, ppid: 1, ticks: 8200, environ: null })
      .add({ pid: 8201, ppid: 1, ticks: 8201, environ: { PATH: '/bin' } })
      .add({ pid: 8202, ppid: 1, ticks: 8202, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u7.service\n' })
      // 감싸개를 부모로 적었지만 실행보다 먼저 시작한 것 (PID 재사용 — 고르지 않는다)
      .add({ pid: 7999, ppid: 8001, ticks: 7000, environ: {} });
    const scan = findRunLeftovers({ root: r.root, tagEntry: TAG, minTicks: 8000, treeFrom: [8100] })!;
    expect(scan.found.map((p) => `${p.pid}:${p.via}`).sort()).toEqual(['8001:tag', '8002:tree', '8003:tree', '8004:tree', '8005:tree', '8006:tree', '8007:tree', '8101:tree']);
    expect(scan.unchecked).toEqual([]);
    expect(scan.unattributed.map((u) => u.pid)).toEqual([8200]);
  });

  it('서버가 루트 cgroup(/)에 있으면 모든 cgroup이 그 아래다 — 표시만으로 센다 (cgroup으로 가르지 못함)', () => {
    const r = fake().setSelfCgroup('0::/\n').add({ pid: 4001, ticks: 4001, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: '0::/user.slice/app.slice/run-u9.service\n' });
    expect(findRunLeftovers({ root: r.root, tagEntry: TAG, minTicks: 4000 })!.found.map((p) => p.pid)).toEqual([4001]);
  });

  it('cgroup v1·혼합 호스트: 통합 계층(0::)이 없으면 systemd 계층(name=systemd)으로 가른다. 둘 다 없으면 표시가 있어도 확인하지 못한 것', () => {
    const v1 = (path: string) => `12:memory:/x\n4:cpu,cpuacct:/y\n1:name=systemd:${path}\n`;
    const r = fake()
      .setSelfCgroup(v1('/system.slice/wook-server.service'))
      .add({ pid: 5001, ticks: 5001, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: v1('/system.slice/wook-server.service') })
      .add({ pid: 5002, ticks: 5002, environ: { WOOK_RUN_TAG: 'abc123' }, cgroup: v1('/user.slice/user-1000.slice/session-2.scope') });
    expect(findRunLeftovers({ root: r.root, tagEntry: TAG, minTicks: 5000 })).toEqual({ found: [{ pid: 5001, ticks: 5001, via: 'tag' }], unchecked: [], unattributed: [] });
    // 혼합: 0::가 있으면 그것이 먼저다
    expect(readCgroupPath('self', fake().setSelfCgroup(`${v1('/a')}0::/b\n`).root)).toEqual({ ok: true, path: '/b' });
    const bare = fake().setSelfCgroup('12:memory:/x\n4:cpu:/y\n').add({ pid: 5003, ticks: 5003, environ: { WOOK_RUN_TAG: 'abc123' } });
    const scan = findRunLeftovers({ root: bare.root, tagEntry: TAG, minTicks: 5000 })!;
    expect(scan.found).toEqual([]);
    expect(scan.unchecked.map((u) => u.pid)).toEqual([5003]);
    expect(scan.unchecked[0]!.why).toContain('이 서버의 cgroup에 통합 계층');
  });

  it('정지 전 스냅숏은 그룹 번호를 지금 구성원일 때만 뿌리로 쓴다 — 리더가 끝난 뒤 같은 번호를 받은 다른 프로세스의 자식을 고르지 않는다 (S10-13 LP-1)', () => {
    const r = fake()
      // 그룹 600의 구성원은 없다. PID 600은 다른 그룹(700)의 프로세스가 다시 받았고 그 자식 601이 있다
      .add({ pid: 600, pgrp: 700, ppid: 1, ticks: 6000 })
      .add({ pid: 601, pgrp: 700, ppid: 600, ticks: 6001 });
    expect(sweepSnapshot({ root: r.root, tagEntry: TAG, minTicks: 5000 }, 600)).toEqual([]);
    // 리더가 구성원이면 그 자식(그룹을 떠난 것)은 고른다
    const live = fake().add({ pid: 800, pgrp: 800, ppid: 1, ticks: 8000 }).add({ pid: 801, pgrp: 801, ppid: 800, ticks: 8001 });
    expect(sweepSnapshot({ root: live.root, tagEntry: TAG, minTicks: 8000 }, 800).map((p) => p.pid)).toEqual([801]);
  });

  it('cgroup 경로 비교는 경계에서 자른다', () => {
    expect(cgroupWithin('/a/b', '/a')).toBe(true);
    expect(cgroupWithin('/a', '/a')).toBe(true);
    expect(cgroupWithin('/ab', '/a')).toBe(false);
    expect(cgroupWithin('/x', '/')).toBe(true);
    expect(cgroupWithin('/a', '/a/b')).toBe(false);
  });

  it('신호 직전 확인: 같은 시작 틱의 살아 있는 프로세스만 — 번호를 다른 프로세스가 다시 썼거나 좀비면 false', () => {
    const r = fake().add({ pid: 77, ticks: 500 });
    expect(sameLiveProcess(77, 500, r.root)).toBe(true);
    expect(sameLiveProcess(77, 499, r.root)).toBe(false);
    r.add({ pid: 77, ticks: 500, state: 'Z' });
    expect(sameLiveProcess(77, 500, r.root)).toBe(false);
    r.remove(77);
    expect(sameLiveProcess(77, 500, r.root)).toBe(false);
  });

  it('environ 항목은 정확히 맞춘다 — 앞뒤가 NUL이나 끝이어야', () => {
    const env = (s: string) => Buffer.from(s, 'utf8');
    expect(environHas(env('WOOK_RUN_TAG=abc123\0'), TAG)).toBe(true);
    expect(environHas(env('A=1\0WOOK_RUN_TAG=abc123'), TAG)).toBe(true);
    expect(environHas(env('A=1\0WOOK_RUN_TAG=abc1234\0'), TAG)).toBe(false);
    expect(environHas(env('XWOOK_RUN_TAG=abc123\0'), TAG)).toBe(false);
    expect(environHas(env('A=WOOK_RUN_TAG=abc123\0'), TAG)).toBe(false);
    expect(environHas(env('A=1\0XWOOK_RUN_TAG=abc123\0WOOK_RUN_TAG=abc123\0'), TAG)).toBe(true);
  });
});

describe('리더가 끝난 뒤 남은 그룹이 그 실행의 것인지 (S10-10.2 — 재시작 복구)', () => {
  const TAGV = 'a1b2c3d4e5f60718';
  const mine = { WOOK_RUN_TAG: TAGV, PATH: '/bin' };
  it('살아 있는 구성원 모두가 그 표시를 가졌을 때만 ours — 좀비는 보지 않는다', () => {
    const r = fake().add({ pid: 501, pgrp: 500, ppid: 1, ticks: 10, environ: mine }).add({ pid: 502, pgrp: 500, ppid: 501, ticks: 11, environ: mine }).add({ pid: 503, pgrp: 500, ppid: 1, ticks: 12, state: 'Z', environ: null });
    expect(groupRunOwnership(500, TAGV, r.root)).toEqual({ verdict: 'ours' });
  });
  it('표시가 없거나 다른 표시인 구성원이 하나라도 있으면 other (같은 번호를 받은 다른 그룹), 읽지 못한 구성원이 있으면 unknown', () => {
    const other = fake().add({ pid: 501, pgrp: 500, ticks: 10, environ: mine }).add({ pid: 502, pgrp: 500, ticks: 11, environ: { WOOK_RUN_TAG: 'ffffffffffffffff' } });
    expect(groupRunOwnership(500, TAGV, other.root)).toMatchObject({ verdict: 'other' });
    const bare = fake().add({ pid: 501, pgrp: 500, ticks: 10, environ: { PATH: '/bin' } });
    expect(groupRunOwnership(500, TAGV, bare.root)).toMatchObject({ verdict: 'other' });
    const unreadable = fake().add({ pid: 501, pgrp: 500, ticks: 10, environ: mine }).add({ pid: 502, pgrp: 500, ticks: 11, environ: null });
    expect(groupRunOwnership(500, TAGV, unreadable.root)).toMatchObject({ verdict: 'unknown', why: expect.stringContaining('환경을 읽지 못해') });
  });
  it('리더가 아직 있거나(좀비가 아닌) 구성원이 없거나 /proc를 읽지 못하면 판정하지 않는다 (null — 예전 규칙)', () => {
    const leader = fake().add({ pid: 500, pgrp: 500, ticks: 9, environ: mine }).add({ pid: 501, pgrp: 500, ticks: 10, environ: mine });
    expect(groupRunOwnership(500, TAGV, leader.root)).toBeNull();
    const zombieLeader = fake().add({ pid: 500, pgrp: 500, ticks: 9, state: 'Z', environ: null }).add({ pid: 501, pgrp: 500, ticks: 10, environ: mine });
    expect(groupRunOwnership(500, TAGV, zombieLeader.root)).toEqual({ verdict: 'ours' });
    expect(groupRunOwnership(500, TAGV, fake().add({ pid: 501, pgrp: 777, ticks: 10, environ: mine }).root)).toBeNull();
    expect(groupRunOwnership(500, TAGV, `${fake().root}-없음`)).toBeNull();
  });
  it('기록의 표시 값은 16자리 16진수만', () => {
    expect(parseRunTag(TAGV)).toBe(TAGV);
    for (const bad of [null, 5, '', 'A1B2C3D4E5F60718', 'a1b2c3d4e5f6071', 'a1b2c3d4e5f607189', 'xyz']) expect(parseRunTag(bad), String(bad)).toBeNull();
  });
});

describe('linuxProcProblem — 서버 시작(serve)·check가 보는 /proc 읽기 (S10-5.3)', () => {
  const complete = () => fake().add({ pid: 1, ticks: 1 }).setSelf({ pid: 4321, ticks: 900 });
  it('다 읽히면 null', () => {
    expect(linuxProcProblem(complete().root)).toBeNull();
  });
  it('루트가 없음·self/stat 없음·형식이 다름·boot_id 없음·btime 없음·프로세스가 하나도 없음은 그 까닭 한 줄', () => {
    const missing = `${complete().root}-없음`;
    expect(linuxProcProblem(missing)).toContain('를 읽지 못합니다');
    expect(linuxProcProblem(complete().setSelf(null).root)).toContain('self/stat을 읽지 못합니다');
    const odd = complete();
    odd.setSelf({ pid: 1, ticks: 1 });
    // 형식이 다른 커널(칸이 모자람)
    writeFileSync(join(odd.root, 'self', 'stat'), '1 (x) S 0');
    expect(linuxProcProblem(odd.root)).toContain('형식을 알아볼 수 없습니다');
    expect(linuxProcProblem(complete().setBootId(null).root)).toContain('boot_id를 읽지 못합니다');
    expect(linuxProcProblem(complete().setBtime(null).root)).toContain('btime');
    expect(linuxProcProblem(fake().setSelf({ pid: 5, ticks: 5 }).root)).toContain('프로세스가 하나도 보이지 않습니다');
  });
});
