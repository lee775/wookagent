import { describe, expect, it } from 'vitest';
import { snapshot } from '../api/fake/data';
import { officeDemoSnapshot, officeDemoStep } from '../api/fake/officeDemo';
import { appearanceFor, colourDistance } from './characters';
import { actorView, behaviourFor, depthOrder, deskRects, furniture, intersectsRect, MotionCoordinator, nearDeskWorkMotion, pathLength, placeSlots, releaseSchedule, renderActorTick, routeFor, stations,
  syncReviewStarts, updateActorMotion, visitPoint, type ActorMotion, type Behaviour, type Point, type Rectangle } from './motion';

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const segmentDistance = (point: Point, a: Point, b: Point) => {
  const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length)) : 0;
  return distance(point, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
};
const overlap = (a: Rectangle, b: Rectangle) => {
  const area = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return area / Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
};

describe('v3.3 owner-visible motion', () => {
  it('paints heads after shallower furniture and moves both near-row sleeves through a work loop', () => {
    const layers = [
      { type: 'near chair', y: 486 }, { type: 'actor in front', y: 510 },
      { type: 'far desk front', y: 371 }, { type: 'actor behind desk', y: 319 },
    ];
    expect(depthOrder(layers, layer => layer.y).map(layer => layer.type))
      .toEqual(['actor behind desk', 'far desk front', 'near chair', 'actor in front']);
    const motions = Array.from({ length: 20 }, (_, frame) => nearDeskWorkMotion('type', frame * 100, 7));
    expect(new Set(motions.map(motion => motion.left)).size).toBeGreaterThan(8);
    expect(new Set(motions.map(motion => motion.right)).size).toBeGreaterThan(8);
    expect(motions.some(motion => motion.right !== -motion.left)).toBe(true);
    expect(new Set(motions.map(motion => motion.head)).size).toBeGreaterThan(5);
  });
  it('keeps every resting and visit point away from circulation and desk fronts', () => {
    const laneSegments: Array<[Point, Point]> = [
      [{ x: 0, y: 195 }, { x: 1200, y: 195 }], [{ x: 0, y: 525 }, { x: 1200, y: 525 }],
      ...[225, 395, 575, 745, 925, 1080].map(x => [{ x, y: 195 }, { x, y: 525 }] as [Point, Point]),
    ];
    const slots = Object.values(placeSlots).flat();
    for (const slot of slots) {
      expect(Math.min(...laneSegments.map(([a, b]) => segmentDistance(slot, a, b))), `${slot.x},${slot.y} beside a walking lane`).toBeGreaterThanOrEqual(45);
      for (const desk of deskRects) {
        const dx = Math.max(desk.left - slot.x, 0, slot.x - desk.right);
        const dy = Math.max(desk.top - slot.y, 0, slot.y - desk.bottom);
        expect(Math.hypot(dx, dy), `${slot.x},${slot.y} inside a desk`).toBeGreaterThanOrEqual(20);
      }
    }
    for (const board of placeSlots.board) for (const corner of [{ x: 420, y: 240 }, { x: 750, y: 240 }])
      expect(distance(board, corner)).toBeGreaterThanOrEqual(45);
  });

  it('releases a walker on the lane before a nearby far-row sitter rises', () => {
    const schedule = releaseSchedule([
      { id: 'sitter', point: stations[2] }, { id: 'walker', point: { x: 508, y: 240 } },
    ], 1000);
    expect(schedule.map(item => item.id)).toEqual(['walker', 'sitter']);
    expect(schedule[1].departAt - schedule[0].departAt).toBeGreaterThanOrEqual(300);
  });

  it('bounds route lengths and uses the real connector gap', () => {
    const targets = [...stations, ...Object.values(placeSlots).flat(), ...stations.map(visitPoint)];
    const long: string[] = [];
    const connectors = new Map<number, number>();
    for (const from of stations) for (const to of targets) {
      if (distance(from, to) < 2) continue;
      const route = routeFor(from, to);
      expect(route.at(-1), `${from.x},${from.y} → ${to.x},${to.y}`).toEqual(to);
      const manhattan = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
      if (pathLength(from, route) > 1.6 * manhattan + 100)
        long.push(`${from.x},${from.y} → ${to.x},${to.y}: ${Math.round(pathLength(from, route))}/${Math.round(1.6 * manhattan + 100)}`);
      expect(route.every(point => point.x !== 800)).toBe(true);
      let previous: Point = from;
      for (const point of route) {
        expect(furniture.some(rect => {
          const contains = (p: Point) => p.x > rect.left && p.x < rect.right && p.y > rect.top && p.y < rect.bottom;
          return !contains(from) && !contains(to) && intersectsRect(previous, point, rect);
        }), `route through furniture ${from.x},${from.y} → ${to.x},${to.y}`).toBe(false);
        if (Math.abs(previous.x - point.x) < 1 && Math.min(previous.y, point.y) < 350 && Math.max(previous.y, point.y) > 350 &&
          stations.some(seat => seat.x === to.x && seat.y === to.y)) connectors.set(point.x, (connectors.get(point.x) ?? 0) + 1);
        previous = point;
      }
      if (from.side === 'far') expect(route[0].y, `far desk exit ${from.x}`).toBe(from.y);
      const destination = stations.find(seat => seat.x === to.x && seat.y === to.y);
      if (destination?.side === 'far') expect((route.at(-2) ?? from).y, `far desk entry ${to.x}`).toBe(to.y);
    }
    expect(long.slice(0, 20), `${long.length} long routes`).toEqual([]);
    const crossTraffic = [...connectors.values()].reduce((sum, count) => sum + count, 0);
    expect(Math.max(...connectors.values()) / crossTraffic, JSON.stringify(Object.fromEntries(connectors))).toBeLessThanOrEqual(.4);
    expect(routeFor(placeSlots.board[0], stations[0]).at(-1)).toEqual(stations[0]);
    const napCentre = { x: (placeSlots.lounge[0].x + placeSlots.lounge[1].x) / 2, y: placeSlots.lounge[0].y };
    for (const seat of stations) expect(routeFor(napCentre, seat).at(-1), `nap exit to ${seat.x},${seat.y}`).toEqual(seat);
  });

  it('routes around colleagues resting between two window places', () => {
    const [from, firstColleague, secondColleague, to] = placeSlots.window;
    const route = routeFor(from, to);
    expect(route.at(-1)).toEqual(to);
    let previous = from;
    for (const point of route) {
      for (const colleague of [firstColleague, secondColleague])
        expect(segmentDistance(colleague, previous, point)).toBeGreaterThanOrEqual(35);
      previous = point;
    }
  });

  it('keeps appearance collisions out of every consecutive twelve-member team', () => {
    for (let start = 1; start <= 200; start++) {
      const looks = Array.from({ length: 12 }, (_, i) => appearanceFor({ id: `M-${String(start + i).padStart(4, '0')}`, roleId: 'developer', isMain: false }));
      for (const [index, look] of looks.entries()) {
        expect(looks.filter(other => other.shirt === look.shirt).length, `shirt ${look.shirt} in window ${start}`).toBeLessThanOrEqual(2);
        expect(looks.filter(other => other.hairStyle === look.hairStyle).length, `hair style ${look.hairStyle} in window ${start}`).toBeLessThanOrEqual(3);
        for (const other of looks.slice(0, index))
          expect(look.skin !== other.skin || colourDistance(look.hair, other.hair) >= 12, `look collision in window ${start}`).toBe(true);
        for (const other of looks.slice(0, index))
          expect(other.hairStyle !== look.hairStyle || colourDistance(other.hair, look.hair) >= 15 ||
            colourDistance(other.skin, look.skin) >= 10, `face collision in window ${start}`).toBe(true);
      }
    }
  });

  it('keeps a resting member in one slot for 300 seconds with one cushion per person', () => {
    const members = officeDemoSnapshot(snapshot, 'busy', 0).members.filter(member => member.projectId === 'P-0003' && !member.deleted).slice(0, stations.length)
      .map(member => ({ ...member, status: 'idle' as const }));
    const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
    const last = new Map<string, Behaviour>();
    let slotChanges = 0;
    for (let tick = 0; tick < 3000; tick++) {
      const seconds = tick / 10;
      const states = members.map((member, index) => behaviourFor({ member, seat: stations[index], index, now: 0, seconds,
        tasks: [], directives: [], activity: [], seats, members, emergency: false }));
      states.forEach((state, index) => {
        const prior = last.get(members[index].id);
        if (prior) expect(state.point, 'Rest seat moved with time').toEqual(prior.point);
        if (prior?.place === state.place && prior.place !== 'desk' && prior.key !== state.key) slotChanges++;
        last.set(members[index].id, state);
      });
      const sofa = states.filter(state => state.place === 'lounge');
      expect(sofa.every(state => state.pose !== 'nap')).toBe(true);
      expect(new Set(sofa.map(state => `${state.point.x}:${state.point.y}`)).size).toBe(sofa.length);
    }
    expect(slotChanges).toBe(0);
  });

  it('keeps a twelve-person idle office clear for 300 seconds while they walk to their stable places', () => {
    const traffic = new MotionCoordinator();
    const members = officeDemoSnapshot(snapshot, 'busy', 0).members.filter(member => member.projectId === 'P-0003' && !member.deleted).slice(0, stations.length)
      .map(member => ({ ...member, status: 'idle' as const }));
    const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
    const states = new Map<string, ActorMotion>();
    let maxOverlap = 0;
    let where = '';
    for (let tick = 0; tick < 3000; tick++) {
      const now = tick * 100;
      const frames: Array<{ id: string; box: Rectangle; point: Point; pose: string }> = [];
      members.forEach((member, index) => {
        const seat = stations[index];
        const behaviour = behaviourFor({ member, seat, index, now, seconds: now / 1000, tasks: [], directives: [], activity: [], seats, members, emergency: false });
        const actor = updateActorMotion(states.get(member.id) ?? { walker: { point: seat, path: [], segment: 0, distance: 0 },
          key: '', phase: 'seated', phaseAt: now, departAt: 0 }, behaviour, now, .1, false, false,
        member.status === 'idle' && behaviour.place !== 'visit' ? index * 450 : 0,
        {id:member.id,traffic});
        states.set(member.id, actor);
        const render = renderActorTick({ actor, behaviour, seat, now, poseUntil: 0, emergency: false, reduced: false, facing: 1 });
        if (behaviour.place !== 'desk' && !['walk', 'stand', 'sit', 'wait', 'read', 'nap'].includes(render.pose))
          expect(distance(actor.walker.point, behaviour.point), `${member.id} ${render.pose} away from rest`).toBeLessThanOrEqual(2);
        const y = actor.walker.point.y - 106 + render.seatOffset;
        frames.push({ id: member.id, point: actor.walker.point, pose: render.pose, box: { left: actor.walker.point.x - 22, right: actor.walker.point.x + 22,
          top: y + 4, bottom: y + (render.seated || render.farLegsHidden ? 76 : 108) } });
      });
      for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
        const area = overlap(frames[i].box, frames[j].box);
        if (area > maxOverlap) { maxOverlap = area; where = `${(now / 1000).toFixed(1)}s ${frames[i].id}+${frames[j].id} ${frames[i].pose}/${frames[j].pose} ${JSON.stringify(frames[i].point)} ${JSON.stringify(frames[j].point)} ${JSON.stringify(states.get(frames[i].id))} ${JSON.stringify(states.get(frames[j].id))}`; }
      }
    }
    expect(maxOverlap, where).toBeLessThanOrEqual(.15);
  });

  it('renders a first walking step, neutral travel, hidden far legs and owned visible plates', () => {
    const seat = stations[0];
    const away: ActorMotion = { walker: { point: { x: seat.x + 72, y: seat.y }, path: [{ x: 225, y: 240 }], segment: 0, distance: 5 },
      key: 'desk', phase: 'walking', phaseAt: 0, departAt: 0 };
    const desk: Behaviour = { key: 'desk', pose: 'type', place: 'desk', point: seat, label: '일합니다.' };
    const first = renderActorTick({ actor: away, behaviour: desk, seat, now: 40, poseUntil: 390,
      previousPose: 'type', emergency: false, reduced: false, facing: 1 });
    expect(first.pose).toBe('walk');
    expect(Math.abs(first.swing)).toBeGreaterThan(0);
    expect(first.plate.visible).toBe(true);
    expect(distance({ x: first.plate.x + 45, y: first.plate.y + 15 }, away.walker.point)).toBeLessThan(60);
    const retarget = renderActorTick({ actor: { ...away, phase: 'standing' }, behaviour: desk, seat, now: 80, poseUntil: 390,
      previousPose: 'walk', emergency: false, reduced: false, facing: 1 });
    expect(retarget.pose).toBe('stand');
    const stranded = renderActorTick({ actor: { ...away, phase: 'standing', walker: { ...away.walker, path: [] } },
      behaviour: desk, seat, now: 80, poseUntil: 390, previousPose: 'walk', emergency: false, reduced: false, facing: 1 });
    expect(stranded.pose).toBe('stand');
    const atMonitor = renderActorTick({ actor: { ...away, walker: { ...away.walker, point: seat } }, behaviour: desk,
      seat, now: 100, poseUntil: 0, emergency: false, reduced: false, facing: 1 });
    expect(atMonitor.farLegsHidden).toBe(true);
    expect(atMonitor.plate.visible).toBe(true);
  });
  it('limits the first walking draw after an idle frame to 6 u', () => {
    const start = placeSlots.window[0];
    const actor: ActorMotion = { walker: { point: start, path: [], segment: 0, distance: 0 },
      key: 'window:0', phase: 'standing', phaseAt: 0, departAt: 0 };
    const target: Behaviour = { key: 'desk:150:282', place: 'desk', pose: 'type', point: stations[0], label: '화면 구현' };
    const next = updateActorMotion(actor, target, 200, .2, false, false);
    expect(next.phase).toBe('walking');
    expect(distance(next.walker.point, start)).toBeLessThanOrEqual(6);
  });
  it('faces the window while resting there', () => {
    expect(actorView(stations[0], placeSlots.window[0], 'standing', undefined, 'window')).toBe('back');
  });

  it('places a floor plate clear of a seated colleague at narrow scene scale', () => {
    const point = { x: 300, y: 240 };
    const colleague: Rectangle = { left: 266, right: 312, top: 165, bottom: 241 };
    const actor: ActorMotion = { walker: { point, path: [{ x: 420, y: 240 }], segment: 0, distance: 20 },
      key: 'visit', phase: 'walking', phaseAt: 0, departAt: 0 };
    const behaviour: Behaviour = { key: 'visit', place: 'visit', pose: 'wait', point: { x: 420, y: 240 }, label: '동료에게 갑니다.' };
    const render = renderActorTick({ actor, behaviour, seat: stations[0], now: 100, poseUntil: 0,
      emergency: false, reduced: false, facing: 1, obstacles: [colleague], plateHeight: 45 });
    const plate: Rectangle = { left: render.plate.x, right: render.plate.x + 90, top: render.plate.y, bottom: render.plate.y + 45 };
    expect(overlap(plate, colleague)).toBeLessThanOrEqual(.1);
    expect(distance({ x: render.plate.x + 45, y: render.plate.y + 22.5 }, point)).toBeLessThanOrEqual(60);
  });
  it('marks a geometrically covered plate as invisible', () => {
    const seat = stations[0];
    const actor: ActorMotion = { walker: { point: seat, path: [], segment: 0, distance: 0 },
      key: 'desk:150:282', phase: 'seated', phaseAt: 0, departAt: 0 };
    const behaviour: Behaviour = { key: actor.key, place: 'desk', pose: 'type', point: seat, label: '화면 구현' };
    const cover: Rectangle = { left: 0, top: 0, right: 1200, bottom: 610 };
    expect(renderActorTick({ actor, behaviour, seat, now: 0, poseUntil: 0, emergency: false,
      reduced: false, facing: 1, obstacles: [cover] }).plate.visible).toBe(false);
  });

  it('rises from the sofa before the first walking step', () => {
    const seat = stations[1];
    const actor: ActorMotion = { walker: { point: placeSlots.lounge[1], path: [], segment: 0, distance: 0 },
      key: 'lounge:1', phase: 'seated', phaseAt: 0, departAt: 0 };
    const target: Behaviour = { key: 'desk', place: 'desk', pose: 'type', point: seat, label: '자료를 작성합니다.' };
    const next = updateActorMotion(actor, target, 1000, .016, false, false);
    expect(next.phase).toBe('rising');
    expect(next.walker.point).toEqual(placeSlots.lounge[1]);
    const render = renderActorTick({ actor: next, behaviour: target, seat, now: 1000, poseUntil: 0,
      emergency: false, reduced: false, facing: 1 });
    expect(render.pose).toBe('stand');
    expect(render.seatOffset).toBe(-8);
  });

  it('plays a complete hand-off in two 64-second cycles with no merged head and torso boxes', () => {
    const traffic = new MotionCoordinator();
    const states = new Map<string, ActorMotion>();
    const poseUntil = new Map<string, number>();
    const previousPose = new Map<string, string>();
    const reviews = new Map<string, number>();
    let lastEmergency = false;
    let facingSeconds = 0;
    let maxOverlap = 0;
    let maxOverlapAt = '';
    let visiblePlates = 0;
    const releaseStarts = new Map<string, number>();
    const handoffArrivals = new Map<string, number>();
    const base = Date.now();
    for (let tick = 0; tick < 1200; tick++) {
      const elapsed = tick * 100;
      const now = base + elapsed;
      const step = officeDemoStep('cycle', elapsed);
      if (!step) throw new Error('Demo step missing');
      const demo = officeDemoSnapshot(snapshot, step, elapsed);
      const members = demo.members.filter(member => member.projectId === 'P-0003' && !member.deleted).slice(0, stations.length);
      const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
      for (const id of states.keys()) if (!seats.has(id)) { states.delete(id); poseUntil.delete(id); previousPose.delete(id); }
      syncReviewStarts(reviews, demo.tasks, now);
      if (lastEmergency && !demo.stop.global.active)
        releaseSchedule([...states.entries()].map(([id, actor]) => ({ id, point: actor.walker.point })), now)
          .forEach(({ id, departAt }) => { const actor = states.get(id); if (actor) actor.departAt = departAt; });
      lastEmergency = demo.stop.global.active;
      const frames: Array<{ id: string; point: Point; box: Rectangle; render: ReturnType<typeof renderActorTick> }> = [];
      members.forEach((member, index) => {
        const seat = stations[index];
        const reviewTask = demo.tasks.find(task => task.state === 'in_review' && (task.assigneeId === member.id || task.reviewerId === member.id));
        const target = behaviourFor({ member, seat, index, now, seconds: elapsed / 1000,
          reviewSeconds: reviewTask ? (now - (reviews.get(reviewTask.id) ?? now)) / 1000 : undefined,
          tasks: demo.tasks, directives: demo.directives, activity: demo.recentActivity, seats, members, emergency: demo.stop.global.active });
        const actor = updateActorMotion(states.get(member.id) ?? { walker: { point: target.point, path: [], segment: 0, distance: 0 },
          key: target.key, phase: target.place === 'desk' || target.place === 'lounge' ? 'seated' : 'standing', phaseAt: now, departAt: 0 },
        target, now, .1, demo.stop.global.active, false, member.status === 'idle' && target.place !== 'visit' ? index * 450 : 0,
        {id:member.id,traffic});
        states.set(member.id, actor);
        const render = renderActorTick({ actor, behaviour: target, seat, now, poseUntil: poseUntil.get(member.id) ?? 0,
          previousPose: previousPose.get(member.id), emergency: demo.stop.global.active, reduced: false, facing: 1,
          faceTargetX: reviewTask ? seats.get(member.id === reviewTask.assigneeId ? reviewTask.reviewerId ?? '' : reviewTask.assigneeId)?.x : undefined });
        poseUntil.set(member.id, render.poseUntil);
        previousPose.set(member.id, render.pose);
        if (elapsed >= 60000 && elapsed < 64000 && ['M-0013', 'M-0015', 'M-0019'].includes(member.id) &&
          render.pose === 'walk' && !releaseStarts.has(member.id)) releaseStarts.set(member.id, elapsed);
        expect(render.deskWorkAway && render.pose !== 'stand' && render.pose !== 'walk').toBe(false);
        expect(render.plate.visible).toBe(true);
        visiblePlates++;
        const point = actor.walker.point;
        if (step === 'review' && target.place === 'visit' && distance(point, target.point) <= 2 &&
          actor.phase === 'standing' && !handoffArrivals.has(member.id)) handoffArrivals.set(member.id, elapsed);
        expect(distance({ x: render.plate.x + (render.plate.placement === 'desk' ? 58 : 45), y: render.plate.y + 15 }, point), `${elapsed}ms ${member.id} ${target.place} ${actor.phase} ${JSON.stringify(point)} ${JSON.stringify(render.plate)}`).toBeLessThanOrEqual(78);
        const originY = point.y - 106 + render.seatOffset;
        frames.push({ id: member.id, point, render, box: { left: point.x - 22, right: point.x + 22,
          top: originY + 4, bottom: originY + (render.seated || render.farLegsHidden ? 76 : 108) } });
      });
      for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
        const area = overlap(frames[i].box, frames[j].box);
        if (area > maxOverlap) { maxOverlap = area; maxOverlapAt = `${(elapsed / 1000).toFixed(1)}s ${frames[i].id}+${frames[j].id} ${frames[i].render.pose}/${frames[j].render.pose} ${JSON.stringify(frames[i].point)} ${JSON.stringify(frames[j].point)}`; }
      }
      const submitter = frames.find(frame => frame.id === 'M-0016');
      const reviewer = frames.find(frame => frame.id === 'M-0021');
      if (step === 'review' && submitter && reviewer && distance(submitter.point, reviewer.point) >= 50 &&
        distance(submitter.point, reviewer.point) <= 90 && submitter.render.pose === 'receive' && reviewer.render.pose === 'submit' &&
        submitter.render.facing === -1 && reviewer.render.facing === 1) facingSeconds += .1;
    }
    expect(maxOverlap, maxOverlapAt).toBeLessThanOrEqual(.15);
    expect(facingSeconds).toBeGreaterThanOrEqual(1.5);
    expect(pathLength(stations[3], routeFor(stations[3], { x: 625, y: 585 }))).toBeLessThanOrEqual(650);
    expect(pathLength(stations[8], routeFor(stations[8], visitPoint(stations[8])))).toBeLessThanOrEqual(650);
    expect((handoffArrivals.get('M-0016') ?? Infinity) - (handoffArrivals.get('M-0021') ?? -Infinity)).toBeLessThanOrEqual(1000);
    expect(visiblePlates).toBeGreaterThan(10000);
    const departures = [...releaseStarts.values()].sort((a, b) => a - b);
    expect(departures.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < departures.length; i++) expect(departures[i] - departures[i - 1]).toBeGreaterThanOrEqual(300);
    for (let i = 1; i < departures.length; i++) expect(departures[i] - departures[i - 1]).toBeLessThanOrEqual(800);
  });
});
