import { describe, expect, it } from 'vitest';
// @ts-expect-error Test-only Node import; the web tsconfig excludes Node types.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { snapshot } from '../api/fake/data';
import { officeDemoSnapshot, officeDemoStep } from '../api/fake/officeDemo';
import { appearanceFor, deskItemsFor } from './characters';
import { PersonRig } from './Person';
import { rigOrigin } from './Office';
import { actorView, behaviourFor, floorLabelPosition, furniture, intersectsRect, labelPositions, LABEL_WIDTH, pathLength, placeSlots, pruneActorStates, releaseSchedule, routeFor, stations, syncReviewStarts, updateActorMotion, visitPoint, WALK_SPEED, type ActorMotion, type Point, type Rectangle } from './motion';

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const rectDistance = (p: Point, r: Rectangle) => Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));
const objects: Record<keyof typeof placeSlots, Rectangle> = {
  lounge: { left: 829, top: 83, right: 1082, bottom: 161 },
  coffee: { left: 1074, top: 34, right: 1177, bottom: 184 },
  board: { left: 399, top: 25, right: 680, bottom: 167 },
  window: { left: 27, top: 22, right: 325, bottom: 186 },
  plant: { left: 24, top: 426, right: 73, bottom: 540 },
  inbox: { left: 1088, top: 342, right: 1163, bottom: 412 },
};

describe('v3.2 scene invariants', () => {
  it('puts far hips inside the chair seat and near rigs at chair centres', () => {
    for (const seat of stations) {
      const origin = rigOrigin(seat);
      expect(origin.x + 40).toBe(seat.x);
      if (seat.side === 'far') {
        expect(origin.y + 76).toBeGreaterThanOrEqual(286);
        expect(origin.y + 76).toBeLessThanOrEqual(302);
      }
    }
  });

  it('gives sequential IDs varied, unique combinations of traits', () => {
    for (const start of [1, 13]) {
      const looks = Array.from({ length: 12 }, (_, i) => appearanceFor({ id: `M-${String(start + i).padStart(4, '0')}`, roleId: 'developer', isMain: false }));
      expect(new Set(looks.map(look => look.hairStyle)).size).toBeGreaterThanOrEqual(6);
      expect(new Set(looks.map(look => `${look.skin}:${look.hair}:${look.hairStyle}:${look.glasses}`)).size).toBe(12);
      expect(new Set(looks.map(look => `${look.skin}:${look.hair}:${look.hairStyle}:${look.shirt}`)).size).toBe(12);
    }
  });

  it('renders open eye shapes and distinct question, error and sigh brow paths', () => {
    const markup = renderToStaticMarkup(createElement(PersonRig, { member: { id: 'M-0016', roleId: 'developer', isMain: false } }));
    expect(markup).toMatch(/class="eyes-open"[^>]*><ellipse/);
    const browPaths = ['brow-default', 'brow-question', 'brow-error', 'brow-sigh'].map(name => {
      const match = markup.match(new RegExp(`<g class="${name}"[^>]*><path[^>]*d="([^"]+)"`));
      expect(match, name).not.toBeNull();
      return match![1];
    });
    expect(new Set(browPaths).size).toBe(4);
    const css = readFileSync(new URL('../styles/identity.css', import.meta.url), 'utf8');
    const closed = [...css.matchAll(/\.office-actor\[data-pose='([^']+)'\] \.eyes-open/g)].map(match => match[1]);
    expect(new Set(closed)).toEqual(new Set(['nap', 'sigh', 'celebrate', 'doze']));
    expect(css).toContain(".office-actor[data-pose='celebrate'] .eyes-open { display: block; }");
  });

  it('gives each of twelve desks a distinct set of visible objects', () => {
    const sets = Array.from({ length: 12 }, (_, index) => deskItemsFor(`M-${String(index + 13).padStart(4, '0')}`, index));
    expect(sets.every(items => items.length >= 1 && items.length <= 3)).toBe(true);
    expect(new Set(sets.map(items => [...items].sort().join(':'))).size).toBe(12);
  });

  it('keeps furniture, visits and rest slots clear of every seat', () => {
    expect(placeSlots.lounge).toHaveLength(4);
    for (const [place, slots] of Object.entries(placeSlots) as Array<[keyof typeof placeSlots, Point[]]>) {
      for (const [index, slot] of slots.entries()) {
        expect(rectDistance(slot, objects[place]), place).toBeLessThanOrEqual(60);
        for (const seat of stations) expect(distance(slot, seat), `${place} and ${seat.x},${seat.y}`).toBeGreaterThanOrEqual(60);
        for (const other of slots.slice(0, index)) expect(distance(slot, other)).toBeGreaterThanOrEqual(60);
      }
    }
    for (const seat of stations) {
      expect(rectDistance(seat, objects.lounge)).toBeGreaterThanOrEqual(60);
      for (const other of stations) expect(distance(visitPoint(seat), other)).toBeGreaterThanOrEqual(60);
    }
  });

  it('allocates idle places by occupancy and respects every capacity', () => {
    const members = officeDemoSnapshot(snapshot, 'busy', 0).members.filter(member => member.projectId === 'P-0003' && !member.deleted).slice(0, stations.length)
      .map(member => ({ ...member, status: 'idle' as const }));
    const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
    for (let seconds = 0; seconds < 120; seconds += 3) {
      const assigned = members.map((member, index) => behaviourFor({ member, seat: stations[index], index, now: Date.now(), seconds,
        tasks: [], directives: [], activity: [], seats, members, emergency: false }));
      for (const place of Object.keys(placeSlots) as Array<keyof typeof placeSlots>) {
        const chosen = assigned.filter(item => item.place === place);
        expect(chosen.length).toBeLessThanOrEqual(placeSlots[place].length);
        expect(new Set(chosen.map(item => `${item.point.x}:${item.point.y}`)).size).toBe(chosen.length);
      }
    }
  });

  it('ties desk plates to their own pitch', () => {
    const plates = labelPositions(stations, stations.map(seat => seat.side));
    expect(LABEL_WIDTH).toBeLessThan(150);
    plates.forEach((plate, index) => {
      expect(plate.x + LABEL_WIDTH / 2).toBe(stations[index].x);
      expect(distance({ x: plate.x + LABEL_WIDTH / 2, y: plate.y }, stations[index])).toBeLessThan(60);
    });
  });

  it('keeps a walking plate with its owner without covering a seated head', () => {
    const seatedHeadAndBody = { left: 823, right: 877, top: 217, bottom: 290 };
    const plate = floorLabelPosition({ x: 800, y: 205 }, { left: 773, right: 827, top: 105, bottom: 175 }, [seatedHeadAndBody]);
    const plateRect = { left: plate.x, right: plate.x + 90, top: plate.y, bottom: plate.y + 31 };
    const overlap = Math.max(0, Math.min(plateRect.right, seatedHeadAndBody.right) - Math.max(plateRect.left, seatedHeadAndBody.left)) *
      Math.max(0, Math.min(plateRect.bottom, seatedHeadAndBody.bottom) - Math.max(plateRect.top, seatedHeadAndBody.top));
    expect(overlap).toBe(0);
    expect(distance({ x: plate.x + 45, y: plate.y + 15 }, { x: 800, y: 205 })).toBeLessThan(78);
  });

  it('routes around furniture and occupied seats', () => {
    expect(WALK_SPEED).toBeGreaterThanOrEqual(90);
    expect(WALK_SPEED).toBeLessThanOrEqual(120);
    const targets = [...Object.values(placeSlots).flat(), ...stations.map(visitPoint)];
    for (const from of stations) for (const to of targets) {
      const route = routeFor(from, to);
      expect(route.at(-1), `${from.x},${from.y} to ${to.x},${to.y}`).toEqual(to);
      let prior: Point = from;
      for (const next of route) {
        for (const rect of furniture) {
          const endpointInRect = (endpoint: Point) => endpoint.x > rect.left && endpoint.x < rect.right && endpoint.y > rect.top && endpoint.y < rect.bottom;
          if (!endpointInRect(from) && !endpointInRect(to)) expect(intersectsRect(prior, next, rect)).toBe(false);
        }
        const length = distance(prior, next);
        for (let d = 0; length > 0 && d <= length; d += 8) {
          const p = { x: prior.x + (next.x - prior.x) * d / length, y: prior.y + (next.y - prior.y) * d / length };
          for (const seat of stations.filter(seat => distance(from, seat) > 2 && distance(to, seat) > 2))
            expect(distance(p, seat), `${from.x},${from.y} → ${to.x},${to.y} via ${JSON.stringify(route)} near ${seat.x},${seat.y}`).toBeGreaterThanOrEqual(30);
        }
        prior = next;
      }
    }
  });

  it('returns a working member to their own seat within route time plus one second', () => {
    const from = placeSlots.board[0];
    const seat = stations[0];
    const target = { key: `desk:${seat.x}:${seat.y}`, pose: 'type' as const, place: 'desk' as const, point: seat, label: 'working' };
    const route = routeFor(from, seat);
    expect(route.at(-1)).toEqual(seat);
    const deadline = Math.ceil((pathLength(from, route) / WALK_SPEED + 1) * 1000);
    let actor: ActorMotion = { walker: { point: from, path: [], segment: 0, distance: 0 }, key: 'board', phase: 'standing', phaseAt: 0, departAt: 0 };
    for (let now = 0; now <= deadline && actor.phase !== 'seated'; now += 30)
      actor = updateActorMotion(actor, target, now, .03, false, false);
    expect(actor.phase).toBe('seated');
    expect(distance(actor.walker.point, seat)).toBeLessThan(2);
  });

  it('rises before walking and lowers only on a seat', () => {
    const seat = stations[0];
    const board = { key: 'board', pose: 'plan' as const, place: 'board' as const, point: placeSlots.board[0], label: 'plan' };
    const desk = { key: 'desk', pose: 'type' as const, place: 'desk' as const, point: seat, label: 'work' };
    let actor: ActorMotion = { walker: { point: seat, path: [], segment: 0, distance: 0 }, key: 'desk', phase: 'seated', phaseAt: 0, departAt: 0 };
    actor = updateActorMotion(actor, board, 0, .04, false, false);
    expect(actor.phase).toBe('rising');
    actor = updateActorMotion(actor, board, 450, .04, false, false);
    expect(actor.phase).toBe('walking');
    for (let now = 490; now < 10000 && actor.phase === 'walking'; now += 40) actor = updateActorMotion(actor, board, now, .04, false, false);
    expect(actor.phase).toBe('standing');
    actor = updateActorMotion(actor, desk, 10000, .04, false, false);
    for (let now = 10040; now < 20000 && actor.phase !== 'lowering'; now += 40) actor = updateActorMotion(actor, desk, now, .04, false, false);
    expect(actor.phase).toBe('lowering');
    expect(distance(actor.walker.point, seat)).toBeLessThan(2);
    expect(updateActorMotion(actor, desk, 20400, .04, false, false).phase).toBe('seated');
  });

  it('holds a released sitter until their aisle turn, then rises for 450 ms', () => {
    const seat = stations[0];
    const board = { key: 'board', pose: 'plan' as const, place: 'board' as const, point: placeSlots.board[0], label: 'plan' };
    let actor: ActorMotion = { walker: { point: seat, path: [], segment: 0, distance: 0 }, key: 'desk', phase: 'seated', phaseAt: 0, departAt: 1100 };
    actor = updateActorMotion(actor, board, 0, .04, false, false);
    expect(actor.phase).toBe('queued');
    actor = updateActorMotion(actor, board, 600, .04, false, false);
    expect(actor.phase).toBe('queued');
    expect(actor.walker.point).toEqual(seat);
    actor = updateActorMotion(actor, board, 650, .04, false, false);
    expect(actor.phase).toBe('rising');
    actor = updateActorMotion(actor, board, 1100, .04, false, false);
    expect(actor.phase).toBe('walking');
    expect(actor.walker.distance).toBe(0);
    actor = updateActorMotion(actor, board, 1140, .04, false, false);
    expect(actor.walker.distance).toBeGreaterThan(0);
  });

  it('does not animate a frozen walker walking before its release turn', () => {
    const start = placeSlots.board[0];
    const target = { key: 'coffee', pose: 'drink' as const, place: 'coffee' as const, point: placeSlots.coffee[0], label: 'coffee' };
    let actor: ActorMotion = { walker: { point: start, path: routeFor(start, target.point), segment: 0, distance: 20 },
      key: target.key, phase: 'walking', phaseAt: 0, departAt: 5000 };
    actor = updateActorMotion(actor, target, 3000, .04, false, false);
    expect(actor.phase).toBe('standing');
    expect(actor.walker.point).toEqual(start);
    actor = updateActorMotion(actor, target, 5000, .04, false, false);
    expect(actor.phase).toBe('walking');
    expect(actor.walker.distance).toBeGreaterThan(20);
  });

  it('releases aisle-near workers in queue order 375 ms apart', () => {
    const members = stations.map((point, index) => ({ id: String(index), point }));
    const queue = releaseSchedule(members, 5000);
    const aisleDistance = (point: Point) => Math.min(...[75, 420, 750, 1175].map(x => Math.abs(point.x - x)));
    expect(queue.map(item => aisleDistance(members[Number(item.id)].point))).toEqual(
      [...members].map(item => aisleDistance(item.point)).sort((a, b) => a - b));
    expect(queue.slice(1).every((item, index) => item.departAt - queue[index].departAt === 375)).toBe(true);
  });

  it('keeps the rear view through the rise and forgets departed members', () => {
    const seat = stations[6];
    const route = { x: seat.x, y: 580 };
    expect(actorView(seat, seat, 'seated', undefined, 'desk')).toBe('back');
    expect(actorView(seat, seat, 'rising', route, 'coffee')).toBe('back');
    expect(actorView(seat, seat, 'walking', route, 'coffee')).toBe('front');
    const states = new Map([['M-0019', { key: 'old' }]]);
    pruneActorStates(states, new Set());
    expect(states.has('M-0019')).toBe(false);
    states.set('M-0019', { key: 'new' });
    expect(states.get('M-0019')?.key).toBe('new');
  });

  it('keeps both hand-off partners together while the folder changes hands', () => {
    const demo = officeDemoSnapshot(snapshot, 'review', 0);
    const members = demo.members.filter(member => member.projectId === 'P-0003' && !member.deleted);
    const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
    const task = demo.tasks.find(item => item.state === 'in_review')!;
    const submitter = members.find(member => member.id === task.assigneeId)!;
    const reviewer = members.find(member => member.id === task.reviewerId)!;
    const pose = (member: typeof submitter, seconds: number) => behaviourFor({ member, seat: seats.get(member.id)!, index: members.indexOf(member), now: Date.now(), seconds, reviewSeconds: seconds, tasks: demo.tasks, directives: demo.directives, activity: demo.recentActivity, seats, members, emergency: false });
    for (let seconds = 8; seconds < 15; seconds += .5) {
      expect(pose(submitter, seconds)).toMatchObject({ place: 'visit', pose: 'receive' });
      expect(pose(reviewer, seconds)).toMatchObject({ place: 'visit', pose: 'submit' });
      expect(distance(pose(submitter, seconds).point, pose(reviewer, seconds).point)).toBe(70);
    }
  });

  it('starts the same review again after it leaves and re-enters review', () => {
    const review = officeDemoSnapshot(snapshot, 'review', 0).tasks.find(task => task.state === 'in_review')!;
    const starts = new Map<string, number>();
    syncReviewStarts(starts, [review], 1000);
    expect(starts.get(review.id)).toBe(1000);
    syncReviewStarts(starts, [{ ...review, state: 'in_progress' }], 3000);
    expect(starts.has(review.id)).toBe(false);
    syncReviewStarts(starts, [review], 5000);
    expect(starts.get(review.id)).toBe(5000);
  });

  it('simulates 120 seconds of demo steps without seated actors drifting', () => {
    const states = new Map<string, ActorMotion>();
    const priorVectors = new Map<string, { key: string; dx: number; dy: number }>();
    const base = Date.now();
    let maxReleaseWalkers = 0;
    for (let tick = 0; tick < 1200; tick++) {
      const elapsed = tick * 100;
      const demo = officeDemoSnapshot(snapshot, officeDemoStep('cycle', elapsed)!, elapsed);
      const members = demo.members.filter(member => member.projectId === 'P-0003' && !member.deleted).slice(0, stations.length);
      const live = new Set(members.map(member => member.id));
      for (const id of states.keys()) if (!live.has(id)) states.delete(id);
      const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
      members.forEach((member, index) => {
        const seat = stations[index];
        const reviewSeconds = officeDemoStep('cycle', elapsed) === 'review' ? (elapsed % 58000 - 16000) / 1000 : undefined;
        const target = behaviourFor({ member, seat, index, now: base + elapsed, seconds: elapsed / 1000, reviewSeconds, tasks: demo.tasks, directives: demo.directives, activity: demo.recentActivity, seats, members, emergency: demo.stop.global.active });
        if (member.status === 'working' && target.place === 'desk') expect(target.key).toBe(`desk:${seat.x}:${seat.y}`);
        const before = states.get(member.id) ?? { walker: { point: seat, path: [], segment: 0, distance: 0 }, key: '', phase: 'seated', phaseAt: base, departAt: 0 };
        const next = updateActorMotion(before, target, base + elapsed, .1, demo.stop.global.active, false);
        if (next.phase === 'walking') expect(next.walker.path.length, `${member.id} has no route at ${elapsed} ms`).toBeGreaterThan(0);
        expect(next.walker.distance).toBeGreaterThanOrEqual(before.walker.distance);
        const dx = next.walker.point.x - before.walker.point.x;
        const dy = next.walker.point.y - before.walker.point.y;
        const prior = priorVectors.get(member.id);
        if (prior && prior.key === target.key && dx * dx + dy * dy > .01 && prior.dx * prior.dx + prior.dy * prior.dy > .01)
          expect(next.walker.distance, `${member.id} moved backward while heading to ${target.key}`).toBeGreaterThanOrEqual(before.walker.distance);
        if (dx * dx + dy * dy > .01) priorVectors.set(member.id, { key: target.key, dx, dy });
        if (next.phase === 'seated' || next.phase === 'queued' || next.phase === 'lowering') expect([...stations, ...placeSlots.lounge,
          { x: (placeSlots.lounge[0].x + placeSlots.lounge[1].x) / 2, y: placeSlots.lounge[0].y }]
          .some(point => distance(point, next.walker.point) <= 2), `${member.id} ${next.phase} at ${JSON.stringify(next.walker.point)} to ${JSON.stringify(target.point)}`).toBe(true);
        states.set(member.id, next);
      });
      if (elapsed >= 53_000 && elapsed < 58_000) maxReleaseWalkers = Math.max(maxReleaseWalkers,
        [...states.values()].filter(actor => actor.phase === 'walking').length);
    }
    expect(states.size).toBeGreaterThan(0);
    expect(maxReleaseWalkers).toBeLessThanOrEqual(4);
  });
});
