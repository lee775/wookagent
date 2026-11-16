import { describe, expect, it } from 'vitest';
import { snapshot } from '../api/fake/data';
import { officeDemoSnapshot, officeDemoStep } from '../api/fake/officeDemo';
import { advanceWalker, behaviourFor, furniture, intersectsRect, LABEL_HEIGHT, LABEL_WIDTH, labelPositions, pathLength, places, placeSlots, progressWalker, releaseSchedule, routeFor, slotPoint, stations, visitPoint, WALK_SPEED, type Context, type Point, type Walker } from './motion';

const worker = snapshot.members.find(member => member.id === 'M-0016');
const reviewer = snapshot.members.find(member => member.id === 'M-0021');
const task = snapshot.tasks[0];
if (!worker || !reviewer || !task) throw new Error('Office test data is missing');
const now = Date.now();
const seats = new Map([[worker.id, stations[0]], [reviewer.id, stations[9]]]);
const base: Context = { member: worker, seat: stations[0], index: 0, now, seconds: 0, tasks: [], directives: [], activity: [], seats, emergency: false };
const shared = Object.keys(places) as Array<keyof typeof places>;

describe('office behaviour', () => {
  it('keeps the destination stable across every desk work pose phase', () => {
    const behaviours = Array.from({ length: 120 }, (_, seconds) => behaviourFor({ ...base, seconds }));
    expect(new Set(behaviours.map(item => item.key)).size).toBe(1);
    expect(new Set(behaviours.map(item => item.pose)).size).toBeGreaterThan(1);
  });

  it('plays distinct desk events before any walk', () => {
    expect(behaviourFor({ ...base, member: { ...worker, status: 'error' } })).toMatchObject({ place: 'desk', pose: 'error' });
    expect(behaviourFor({ ...base, member: { ...worker, status: 'awaiting_answer' } })).toMatchObject({ place: 'desk', pose: 'wait' });
    const active = { ...task, assigneeId: worker.id, state: 'in_progress' as const, hold: null };
    expect(behaviourFor({ ...base, tasks: [{ ...active, conflictFiles: ['a.ts'] }] }).pose).toBe('conflict');
    expect(behaviourFor({ ...base, tasks: [{ ...active, review: { ...active.review, autoCheck: 'running' } }] }).pose).toBe('check_wait');
  });

  it('sequences the handoff, return, and screen review', () => {
    const review = { ...task, id: 'T-TEST', assigneeId: worker.id, reviewerId: reviewer.id, state: 'in_review' as const, hold: null };
    const submitter = (seconds: number) => behaviourFor({ ...base, seconds, tasks: [review] });
    const reviewing = (seconds: number) => behaviourFor({ ...base, member: reviewer, seat: stations[9], index: 9, seconds, tasks: [review] });
    expect(submitter(4).place).toBe('visit');
    expect(reviewing(4).place).toBe('desk');
    expect(reviewing(6).place).toBe('visit');
    expect(submitter(11).place).toBe('visit');
    expect(reviewing(11).place).toBe('visit');
    expect(submitter(17).place).toBe('desk');
    expect(reviewing(17).place).toBe('desk');
  });

  it('keeps the idle seat stable while seated poses change', () => {
    const idle = { ...worker, status: 'idle' as const, lastActivityAt: null };
    const states = Array.from({ length: 68 }, (_, seconds) => behaviourFor({ ...base, member: idle, seconds }));
    expect(states.every(item => item.place === 'desk' || item.place === 'lounge')).toBe(true);
    expect(new Set(states.map(item => item.key)).size).toBe(1);
    expect(new Set(states.map(item => item.pose)).size).toBeGreaterThan(1);
  });
});

describe('office route and labels', () => {
  it('allocates a bounded ring of distinct slots to each place', () => {
    for (const place of shared) {
      const slots = placeSlots[place];
      for (let index = 0; index < slots.length; index++) {
        expect(slots[index].y).toBeGreaterThanOrEqual(145);
        for (let other = 0; other < index; other++)
          expect(Math.hypot(slots[index].x - slots[other].x, slots[index].y - slots[other].y), `${place}:${index}/${other}`).toBeGreaterThanOrEqual(60);
      }
    }
  });
  it('keeps every seat-to-place and seat-to-seat segment clear of furniture', () => {
    for (const from of stations) {
      const visits = stations.map(visitPoint);
      const targets: Point[] = [...stations, ...visits, ...shared.flatMap(place => stations.map((_, index) => slotPoint(place, index)))];
      for (const to of targets) {
        const route = routeFor(from, to);
        if (Math.hypot(to.x - from.x, to.y - from.y) >= 2) expect(route.at(-1), `${from.x},${from.y} → ${to.x},${to.y}`).toMatchObject({ x: to.x, y: to.y });
        let previous: Point = from;
        for (const point of route) {
          for (const rect of furniture) {
            const endpointInRect = (endpoint: Point) => endpoint.x > rect.left && endpoint.x < rect.right && endpoint.y > rect.top && endpoint.y < rect.bottom;
            if (!endpointInRect(from) && !endpointInRect(to))
              expect(intersectsRect(previous, point, rect), `${from.x},${from.y} → ${to.x},${to.y}`).toBe(false);
          }
          previous = point;
        }
      }
    }
    for (const place of shared) for (let index = 0; index < stations.length; index++) {
      const from = slotPoint(place, index);
      for (const to of stations) {
        const route = routeFor(from, to);
        expect(route.at(-1), `${place}:${index} → ${to.x},${to.y}`).toMatchObject({ x: to.x, y: to.y });
        let previous = from;
        for (const point of route) {
          for (const rect of furniture) {
            const endpointInRect = (endpoint: Point) => endpoint.x > rect.left && endpoint.x < rect.right && endpoint.y > rect.top && endpoint.y < rect.bottom;
            if (!endpointInRect(from) && !endpointInRect(to)) expect(intersectsRect(previous, point, rect)).toBe(false);
          }
          previous = point;
        }
      }
    }
  });

  it('sends a worker from any lane to a desk within route length over speed plus one second', () => {
    for (const seat of stations) for (const from of [...stations, ...shared.map(place => slotPoint(place, 0))]) {
      const path = routeFor(from, seat);
      const limit = pathLength(from, path) / WALK_SPEED + 1;
      for (let phase = 0; phase < 1; phase++) {
        expect(behaviourFor({ ...base, seat, seconds: phase * .2 }).key).toBe(`desk:${seat.x}:${seat.y}`);
        let walker: Walker = { point: from, path, segment: 0, distance: 0 };
        let elapsed = 0;
        let previousDistance = 0;
        let previousSegment = 0;
        while (walker.path.length && elapsed < limit) {
          walker = advanceWalker(walker, .04);
          expect(walker.distance).toBeGreaterThanOrEqual(previousDistance);
          if (walker.path.length) expect(walker.segment).toBeGreaterThanOrEqual(previousSegment);
          previousDistance = walker.distance;
          previousSegment = walker.segment;
          elapsed += .04;
        }
        expect(walker.point).toMatchObject({ x: seat.x, y: seat.y });
        expect(elapsed).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('keeps desk work at the desk through every work pose', () => {
    for (const seat of stations) {
      expect(routeFor(seat, seat)).toEqual([]);
      for (let seconds = 0; seconds < 60; seconds += 3) expect(behaviourFor({ ...base, seat, seconds }).point).toEqual(seat);
    }
  });

  it('places twelve HTML plate footprints without intersections', () => {
    const labels = labelPositions(stations, stations.map(item => item.side));
    labels.forEach((label, index) => {
      expect(label.x).toBeGreaterThanOrEqual(8);
      expect(label.x + LABEL_WIDTH).toBeLessThanOrEqual(1192);
      labels.slice(0, index).forEach(other => expect(label.x + LABEL_WIDTH <= other.x || label.x >= other.x + LABEL_WIDTH || label.y + LABEL_HEIGHT <= other.y || label.y >= other.y + LABEL_HEIGHT).toBe(true));
    });
  });

  it('holds emergency positions and staggers departures on release', () => {
    const route = routeFor(stations[0], stations[11]);
    const mid = advanceWalker({ point: stations[0], path: route, segment: 0, distance: 0 }, .08);
    const queue = releaseSchedule(snapshot.members.slice(0, 12).map((member, index) => ({ id: member.id, point: stations[index] })), 0);
    const delays = queue.map(item => item.departAt);
    expect(delays[0]).toBe(350);
    expect(delays.slice(1).every((start, index) => start - delays[index] === 375)).toBe(true);
    for (let tick = 0; tick < 30; tick++) expect(progressWalker(mid, .04, tick * 40, 0, true)).toBe(mid);
    const starts = queue.map(item => item.departAt);
    expect(starts.some(start => progressWalker(mid, .04, start - 1, start, false) === mid)).toBe(true);
    expect(starts.every(start => progressWalker(mid, .04, start, start, false).distance > mid.distance)).toBe(true);
  });

  it('keeps an assignment, review, report, release and rest in the 88-second demo cycle', () => {
    expect(officeDemoStep('cycle', 0)).toBe('busy');
    expect(officeDemoStep('cycle', 5000)).toBe('assignment');
    expect(officeDemoStep('cycle', 8000)).toBe('assignment');
    expect(officeDemoStep('cycle', 16000)).toBe('review');
    expect(officeDemoStep('cycle', 35000)).toBe('report');
    expect(officeDemoStep('cycle', 43000)).toBe('report');
    expect(officeDemoStep('cycle', 59000)).toBe('release');
    expect(officeDemoStep('cycle', 64000)).toBe('idle');
    expect(officeDemoStep('cycle', 87000)).toBe('idle');
    expect(officeDemoStep('cycle', 88000)).toBe('busy');
    expect(officeDemoSnapshot(snapshot, 'idle', 0).members.filter(member => member.projectId === 'P-0003' && !member.deleted)).toHaveLength(13);
    expect(officeDemoSnapshot(snapshot, 'busy', 0).members.filter(member => member.projectId === 'P-0003' && member.status === 'working')).toHaveLength(13);
  });
});
