import { describe, expect, it, vi } from 'vitest';
import { snapshot } from '../api/fake/data';
import { officeDemoSnapshot, officeDemoStep } from '../api/fake/officeDemo';
import { behaviourFor, MotionCoordinator, releaseSchedule, renderActorTick, stations, syncReviewStarts, updateActorMotion,
  type ActorMotion, type Behaviour, type Point } from './motion';

interface CycleActor {
  id: string;
  index: number;
  behaviour: Behaviour;
  motion: ActorMotion;
  render: ReturnType<typeof renderActorTick>;
  point: Point;
}
interface CycleFrame { elapsed: number; step: string; actors: CycleActor[] }

function simulateCycle(durationMs: number, intervalMs = 50): CycleFrame[] {
  const traffic = new MotionCoordinator();
  const states = new Map<string, ActorMotion>();
  const poseUntil = new Map<string, number>();
  const previousPose = new Map<string, string>();
  const reviewStarts = new Map<string, number>();
  const frames: CycleFrame[] = [];
  const base = Date.UTC(2026, 9, 28, 1, 0, 0);
  let emittedSecond = -1;
  let emittedSnapshot: ReturnType<typeof officeDemoSnapshot> | null = null;
  let lastEmergency = false;
  vi.useFakeTimers({ now: base, toFake: ['Date'] });
  try {
    for (let elapsed = 0; elapsed <= durationMs; elapsed += intervalMs) {
      const now = base + elapsed;
      // The bridge emits one snapshot per second. Its event stamps use Date.now().
      const second = Math.floor(elapsed / 1000);
      vi.setSystemTime(base + second * 1000);
      const step = officeDemoStep('cycle', elapsed);
      if (!step) throw new Error('Cycle step missing');
      if (second !== emittedSecond) {
        emittedSnapshot = officeDemoSnapshot(snapshot, step, second * 1000);
        emittedSecond = second;
      }
      const demo = emittedSnapshot;
      if (!demo) throw new Error('Snapshot emission missing');
      const members = demo.members.filter(member => member.projectId === 'P-0003' && !member.deleted).slice(0, stations.length);
      const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
      for (const id of states.keys()) if (!seats.has(id)) {
        states.delete(id); poseUntil.delete(id); previousPose.delete(id);
      }
      syncReviewStarts(reviewStarts, demo.tasks, now);
      if (lastEmergency && !demo.stop.global.active)
        releaseSchedule([...states].map(([id, actor]) => ({ id, point: actor.walker.point })), now)
          .forEach(({ id, departAt }) => { const actor = states.get(id); if (actor) actor.departAt = departAt; });
      lastEmergency = demo.stop.global.active;
      const actors = members.map((member, index): CycleActor => {
        const seat = stations[index];
        const review = demo.tasks.find(task => task.state === 'in_review' &&
          (task.assigneeId === member.id || task.reviewerId === member.id));
        const behaviour = behaviourFor({ member, seat, index, now, seconds: elapsed / 1000,
          reviewSeconds: review ? (now - (reviewStarts.get(review.id) ?? now)) / 1000 : undefined,
          tasks: demo.tasks, directives: demo.directives, activity: demo.recentActivity, seats, members,
          emergency: demo.stop.global.active });
        const motion = updateActorMotion(states.get(member.id) ?? {
          walker: { point: behaviour.point, path: [], segment: 0, distance: 0 }, key: behaviour.key,
          phase: behaviour.place === 'desk' || behaviour.place === 'lounge' ? 'seated' : 'standing',
          phaseAt: now, departAt: 0,
        }, behaviour, now, intervalMs / 1000, demo.stop.global.active, false,
        member.status === 'idle' && behaviour.place !== 'visit' ? index * 450 : 0,
        {id:member.id,traffic});
        states.set(member.id, motion);
        const render = renderActorTick({ actor: motion, behaviour, seat, now,
          poseUntil: poseUntil.get(member.id) ?? 0, previousPose: previousPose.get(member.id),
          emergency: demo.stop.global.active, reduced: false, facing: 1 });
        poseUntil.set(member.id, render.poseUntil);
        previousPose.set(member.id, render.pose);
        return { id: member.id, index, behaviour, motion, render, point: { ...motion.walker.point } };
      });
      frames.push({ elapsed, step, actors });
    }
  } finally { vi.useRealTimers(); }
  return frames;
}

describe('fixed-clock office cycle', () => {
  const frames = simulateCycle(120_000);

  it('replays stamped events and the assignment visit', () => {
    const seconds = (step: string, id: string, place: string, pose?: string) =>
      frames.filter(frame => frame.elapsed < 64_000 && frame.step === step && frame.actors.some(actor => actor.id === id &&
        actor.behaviour.place === place && (!pose || actor.behaviour.pose === pose))).length * .05;
    expect(seconds('report', 'M-0013', 'inbox')).toBeGreaterThanOrEqual(9);
    expect(seconds('assignment', 'M-0013', 'visit')).toBeGreaterThanOrEqual(7);
    expect(seconds('passed', 'M-0016', 'desk', 'celebrate')).toBeGreaterThanOrEqual(2);
    const inboxArrival = frames.find(frame => frame.step === 'report' && frame.actors.some(actor => actor.id === 'M-0013' &&
      actor.behaviour.place === 'inbox' && Math.hypot(actor.point.x - actor.behaviour.point.x,
        actor.point.y - actor.behaviour.point.y) <= 2));
    expect(inboxArrival?.elapsed).toBeLessThanOrEqual(45_850);
  });

  it('moves rig height continuously and keeps clipped legs behind the far desk', () => {
    const previous = new Map<string, { y: number; elapsed: number }>();
    const pops: string[] = [];
    const legless: string[] = [];
    for (const frame of frames) for (const actor of frame.actors) {
      const y = actor.point.y + actor.render.seatOffset;
      const before = previous.get(actor.id);
      if (before && frame.elapsed - before.elapsed === 50 && Math.abs(y - before.y) > 6)
        pops.push(`${frame.elapsed}ms ${actor.id}: ${before.y.toFixed(1)} → ${y.toFixed(1)}`);
      previous.set(actor.id, { y, elapsed: frame.elapsed });
      const seat = stations[actor.index];
      if (actor.render.farLegsHidden && (Math.abs(actor.point.x - seat.x) > 43 || actor.point.y > 309))
        legless.push(`${frame.elapsed}ms ${actor.id} at ${actor.point.x},${actor.point.y}`);
    }
    expect(pops, pops.slice(0, 8).join('\n')).toEqual([]);
    expect(legless, legless.slice(0, 8).join('\n')).toEqual([]);
  });

  it('never places walking legs over another seated far-row head', () => {
    const hits: string[] = [];
    for (const frame of frames) {
      const seated = frame.actors.filter(actor => actor.index < 6 && actor.render.seated);
      for (const walker of frame.actors) {
        if (walker.render.pose !== 'walk' && walker.render.pose !== 'stand') continue;
        const legsTop = walker.point.y - 35 + walker.render.seatOffset;
        const legsBottom = walker.point.y + walker.render.seatOffset;
        for (const sitter of seated) {
          if (sitter.id === walker.id) continue;
          if (Math.abs(walker.point.x - sitter.point.x) < 30 && legsBottom > 214 && legsTop < 259 &&
            walker.point.y < sitter.point.y - 10)
            hits.push(`${frame.elapsed}ms ${walker.id} over ${sitter.id}`);
        }
      }
    }
    expect(hits, hits.slice(0, 8).join('\n')).toEqual([]);
  });

  it('keeps paused members near their own seats after the stop', () => {
    const away: string[] = [];
    for (const frame of frames.filter(frame => frame.step === 'release')) for (const actor of frame.actors) {
      if (actor.behaviour.pose !== 'pause') continue;
      const seat = stations[actor.index];
      if (Math.hypot(actor.point.x - seat.x, actor.point.y - seat.y) > 80)
        away.push(`${frame.elapsed}ms ${actor.id} at ${actor.point.x},${actor.point.y}`);
    }
    expect(away, away.slice(0, 8).join('\n')).toEqual([]);
  });
});
