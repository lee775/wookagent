/**
 * 실행 자리 배정 — 기획서 5.7 동시 실행과 대기열, ORG-07·09, TSK-05, CLI-20, AC-35·41.
 */
import { describe, expect, it } from 'vitest';
import type { Priority, SlotClass } from '@shared/domain';
import { compareCandidates, pickStarts, slotCaps, type RunningSlot, type StartCandidate } from '@core/scheduling';
import { lcg } from './fixtures';

const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 0, min)).toISOString();

function cand(memberId: string, slotClass: SlotClass, over: Partial<StartCandidate> = {}): StartCandidate {
  return {
    sessionKey: `${slotClass === 'general' ? 'task' : 'review'}:${memberId}`,
    memberId,
    slotClass,
    priority: 'normal',
    queuedAt: at(0),
    urgent: false,
    ...over,
  };
}
const running = (memberId: string, slotClass: SlotClass, sessionKey = `${slotClass}-run:${memberId}`): RunningSlot => ({ memberId, sessionKey, slotClass });
const gen = (n: number, p = 'G') => Array.from({ length: n }, (_, i) => cand(`${p}${i}`, 'general'));
const mgmt = (n: number, p = 'M') => Array.from({ length: n }, (_, i) => cand(`${p}${i}`, 'management'));
const ids = (xs: readonly StartCandidate[]) => xs.map((x) => x.memberId);

describe('slotCaps — 전체 상한 N과 관리용 예약 1자리 (5.7, ORG-07)', () => {
  it.each([
    { n: 1, total: 1, general: 1 }, // N=1: 예약 자리 없음
    { n: 2, total: 2, general: 1 },
    { n: 3, total: 3, general: 2 },
    { n: 5, total: 5, general: 4 }, // 기본 5 → 일반 작업 최대 4
    { n: 8, total: 8, general: 7 },
  ])('N=$n → 전체 $total, 일반 $general', ({ n, total, general }) => {
    expect(slotCaps(n)).toEqual({ total, general });
  });
});

describe('pickStarts — 5.7 확정 규칙 표', () => {
  const table: { name: string; cap: number; run: RunningSlot[]; cands: StartCandidate[]; picked: string[] }[] = [
    {
      name: 'N=5, 빈 상태 일반 6개 → 일반 4개만 (관리 예약 1자리 비움)',
      cap: 5,
      run: [],
      cands: gen(6),
      picked: ['G0', 'G1', 'G2', 'G3'],
    },
    {
      name: 'AC-41: N=5 일반 4개 실행 중에도 관리 업무 1개 실행 가능, 일반 추가 없음',
      cap: 5,
      run: [0, 1, 2, 3].map((i) => running(`R${i}`, 'general')),
      cands: [...gen(2, 'X'), ...mgmt(2)],
      picked: ['M0'],
    },
    {
      name: '관리 업무가 없더라도 일반 작업이 예약 자리를 차지하지 않음',
      cap: 5,
      run: [0, 1, 2, 3].map((i) => running(`R${i}`, 'general')),
      cands: gen(3, 'X'),
      picked: [],
    },
    {
      name: '관리 업무는 전체 상한 안에서 빈 자리를 더 쓸 수 있다',
      cap: 5,
      run: [],
      cands: mgmt(6),
      picked: ['M0', 'M1', 'M2', 'M3', 'M4'],
    },
    {
      name: '관리 3 + 일반 4 후보 → 관리 먼저 3, 남은 2자리 일반',
      cap: 5,
      run: [],
      cands: [...gen(4), ...mgmt(3)],
      picked: ['M0', 'M1', 'M2', 'G0', 'G1'],
    },
    {
      name: '관리 1 실행 중 + 일반 후보 5 → 일반 4 (전체 5)',
      cap: 5,
      run: [running('R0', 'management')],
      cands: gen(5),
      picked: ['G0', 'G1', 'G2', 'G3'],
    },
    {
      name: '관리 2 실행 중 + 일반 후보 5 → 일반 3 (전체 5)',
      cap: 5,
      run: [running('R0', 'management'), running('R1', 'management')],
      cands: gen(5),
      picked: ['G0', 'G1', 'G2'],
    },
    {
      name: 'N=1: 예약 없이 관리 업무 우선 (일반이 더 급하고 먼저 왔어도)',
      cap: 1,
      run: [],
      cands: [cand('G0', 'general', { priority: 'urgent', queuedAt: at(0) }), cand('M0', 'management', { priority: 'low', queuedAt: at(9) })],
      picked: ['M0'],
    },
    {
      name: 'N=1: 관리 업무가 없으면 일반 1개 (예약 자리 없음)',
      cap: 1,
      run: [],
      cands: gen(2),
      picked: ['G0'],
    },
    {
      name: 'N=1: 이미 실행 중인 일반 턴은 중단하지 않고 관리 업무는 기다림',
      cap: 1,
      run: [running('R0', 'general')],
      cands: mgmt(1),
      picked: [],
    },
    {
      name: 'N=2: 일반 최대 1',
      cap: 2,
      run: [],
      cands: gen(3),
      picked: ['G0'],
    },
    {
      name: 'ORG-09: 실행 중인 팀원의 다른 업무(다른 세션)는 자리가 비어도 시작 안 함',
      cap: 5,
      run: [running('A', 'general', 'task:T-0001')],
      cands: [cand('A', 'management', { sessionKey: 'review:T-0002' })],
      picked: [],
    },
    {
      name: 'ORG-09: 한 팀원의 관리·일반 후보가 함께 있으면 관리 업무 하나만',
      cap: 5,
      run: [],
      cands: [cand('A', 'general', { sessionKey: 'task:T-0001', priority: 'urgent' }), cand('A', 'management', { sessionKey: 'review:T-0002', priority: 'low' })],
      picked: ['A'],
    },
    {
      name: 'CLI-20: 세션당 프로세스 1개 — 실행 중인 세션 키는 다시 시작하지 않음',
      cap: 5,
      run: [running('A', 'management', 'directive:D-0001')],
      cands: [cand('B', 'management', { sessionKey: 'directive:D-0001' })],
      picked: [],
    },
  ];

  it.each(table)('$name', ({ cap, run, cands, picked }) => {
    const out = pickStarts({ cap, running: run, candidates: cands });
    expect(ids(out)).toEqual(picked);
    const all = [...run, ...out];
    expect(all.length).toBeLessThanOrEqual(Math.max(cap, run.length));
  });

  it('ORG-09 묶음: 한 팀원 후보 2개 중 관리 업무가 뽑힌다', () => {
    const out = pickStarts({
      cap: 5,
      running: [],
      candidates: [cand('A', 'general', { sessionKey: 'task:T-0001', priority: 'urgent' }), cand('A', 'management', { sessionKey: 'review:T-0002', priority: 'low' })],
    });
    expect(out.map((c) => c.sessionKey)).toEqual(['review:T-0002']);
  });
});

describe('우선순위 (5.7 / TSK-05): 관리 업무 → 대표 직접 메시지 → 작업 우선순위 → 대기 등록 시각', () => {
  const list: StartCandidate[] = [
    cand('a', 'general', { priority: 'low', queuedAt: at(0) }),
    cand('b', 'general', { priority: 'urgent', queuedAt: at(5) }),
    cand('c', 'general', { priority: 'high', queuedAt: at(1) }),
    cand('d', 'general', { priority: 'high', queuedAt: at(0) }),
    cand('e', 'management', { priority: 'low', queuedAt: at(9) }),
    cand('f', 'general', { priority: 'normal', queuedAt: at(0), urgent: true }),
    cand('g', 'management', { priority: 'normal', queuedAt: at(3) }),
    cand('h', 'management', { priority: 'normal', queuedAt: at(2) }),
  ];
  const expected = ['h', 'g', 'e', 'f', 'b', 'd', 'c', 'a'];

  it('정렬 순서', () => {
    expect(ids([...list].sort(compareCandidates))).toEqual(expected);
    expect(ids([...list].reverse().sort(compareCandidates))).toEqual(expected);
  });

  it('자리가 충분하면 그 순서대로 시작', () => {
    expect(ids(pickStarts({ cap: 32, running: [], candidates: list }))).toEqual(expected);
  });

  it('자리가 부족하면 앞 순위부터 (N=5 → 관리 3 + 일반 2)', () => {
    expect(ids(pickStarts({ cap: 5, running: [], candidates: list }))).toEqual(['h', 'g', 'e', 'f', 'b']);
  });

  it('같은 분류·같은 우선순위는 먼저 대기한 업무부터', () => {
    const xs = [cand('late', 'general', { queuedAt: at(7) }), cand('early', 'general', { queuedAt: at(1) })];
    expect(ids(pickStarts({ cap: 2, running: [], candidates: xs }))).toEqual(['early']);
  });
});

describe('불변식 (무작위 상황 500개)', () => {
  const PRI: Priority[] = ['urgent', 'high', 'normal', 'low'];

  it('전체 ≤ N, 일반 ≤ 일반 상한, 팀원·세션 중복 없음, 놀리는 자리 없음, 관리 업무 우선', () => {
    const rnd = lcg(20261027);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    for (let iter = 0; iter < 500; iter++) {
      const cap = 1 + Math.floor(rnd() * 7);
      const caps = slotCaps(cap);
      const members = Array.from({ length: 2 + Math.floor(rnd() * 8) }, (_, i) => `m${i}`);
      const run: RunningSlot[] = [];
      const busy = new Set<string>();
      const runCount = Math.floor(rnd() * (cap + 1));
      for (let i = 0; i < runCount; i++) {
        const m = pick(members);
        if (busy.has(m)) continue;
        busy.add(m);
        const cls: SlotClass = rnd() < 0.5 ? 'general' : 'management';
        if (cls === 'general' && run.filter((r) => r.slotClass === 'general').length >= caps.general) continue;
        run.push(running(m, cls, `s-run-${m}`));
      }
      const cands: StartCandidate[] = Array.from({ length: Math.floor(rnd() * 10) }, (_, i) =>
        cand(pick(members), rnd() < 0.4 ? 'management' : 'general', {
          sessionKey: `s-${i % 7}`,
          priority: pick(PRI),
          queuedAt: at(Math.floor(rnd() * 30)),
          urgent: rnd() < 0.1,
        }),
      );

      const out = pickStarts({ cap, running: run, candidates: cands });
      const all = [...run, ...out];
      const generalAll = all.filter((x) => x.slotClass === 'general').length;

      expect(all.length).toBeLessThanOrEqual(caps.total);
      expect(generalAll).toBeLessThanOrEqual(caps.general);
      expect(new Set(all.map((x) => x.memberId)).size).toBe(all.length);
      expect(new Set(all.map((x) => x.sessionKey)).size).toBe(all.length);

      // 뽑히지 않은 후보는 반드시 이유가 있다 (자리 놀리지 않음)
      const takenMembers = new Set(all.map((x) => x.memberId));
      const takenSessions = new Set(all.map((x) => x.sessionKey));
      for (const c of cands) {
        if (out.includes(c)) continue;
        const why =
          all.length >= caps.total ||
          takenMembers.has(c.memberId) ||
          takenSessions.has(c.sessionKey) ||
          (c.slotClass === 'general' && generalAll >= caps.general);
        expect(why).toBe(true);
      }
      // 일반이 뽑혔는데 관리 후보가 자리 부족으로 밀리는 일은 없다
      if (out.some((c) => c.slotClass === 'general')) {
        for (const c of cands.filter((x) => x.slotClass === 'management' && !out.includes(x))) {
          expect(takenMembers.has(c.memberId) || takenSessions.has(c.sessionKey)).toBe(true);
        }
      }
    }
  });
});
