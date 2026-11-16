import { describe, expect, it } from 'vitest';
import { snapshot } from '../api/fake/data';
import { officeDepartmentSnapshot } from '../api/fake/departments';
import { behaviourFor, placeSlots, renderActorTick, stations, updateActorMotion, type ActorMotion } from './motion';
import { OfficeBehaviour } from '../studio3d/behaviour';
import { NavigationGrid, authoredFootprints } from '../studio3d/navigation';
import { homeForAsset, restSlots, snapshotPlacement } from '../studio3d/placement';

const samples = [0, 1, 40, 120, 300, 900];
const fixture = (count: number, busy: boolean) => {
  const view = officeDepartmentSnapshot(snapshot, busy ? 'busy' : 'idle');
  const members = view.members.filter(member => member.projectId === view.projects[0].id).slice(0, count);
  // The mixed office includes ordinary idle workers as well as review/wait/pause/error.
  if (busy && members.at(-1)) members[members.length - 1] = { ...members[members.length - 1], status: 'idle', currentTask: null };
  return { view, members };
};

describe('idle seating', () => {
  for (const count of [2, 6, 12]) for (const busy of [false, true]) for (const reduced of [false, true]) {
    const label = `${count} members, ${busy ? 'mixed' : 'all idle'}, reduced=${reduced}`;
    it(`2D idle seating stays private and seated for fifteen minutes: ${label}`, () => {
      const { view, members } = fixture(count, busy);
      const seats = new Map(members.map((member, index) => [member.id, stations[index]]));
      const actors = new Map<string, ActorMotion>();
      const initial = new Map<string, string>();
      const poses = new Set<string>();
      for (const seconds of samples) {
        const occupied = new Set<string>();
        members.forEach((member, index) => {
          const seat = stations[index];
          const target = behaviourFor({ member, seat, index, now: seconds * 1000, seconds,
            tasks: [], directives: busy ? view.directives : [], activity: [], seats, members, emergency: false });
          const prior = actors.get(member.id) ?? { walker: { point: target.point, path: [], segment: 0, distance: 0 },
            key: target.key, phase: 'seated', phaseAt: 0, departAt: 0 };
          const actor = updateActorMotion(prior, target, seconds * 1000, .1, false, reduced);
          actors.set(member.id, actor);
          if (member.status !== 'idle') return;
          const render = renderActorTick({ actor, behaviour: target, seat, now: seconds * 1000,
            poseUntil: 0, emergency: false, reduced, facing: 1 });
          expect(['desk', 'lounge']).toContain(target.place);
          expect(['read', 'phone', 'stretch', 'doze', 'chat']).toContain(render.pose);
          expect(actor.phase).toBe('seated');
          expect(render.seated).toBe(true);
          expect(actor.walker.point).toEqual(target.point);
          if (target.place === 'desk') expect(target.point).toEqual(seat);
          else {
            expect(placeSlots.lounge).toContainEqual(target.point);
            const key = `${target.point.x}:${target.point.y}`;
            expect(occupied.has(key), '2D sofa seat shared').toBe(false);
            occupied.add(key);
          }
          const key = `${target.place}:${target.point.x}:${target.point.y}`;
          if (!initial.has(member.id)) initial.set(member.id, key);
          expect(key, 'Idle workers must not pace').toBe(initial.get(member.id));
          poses.add(render.pose);
        });
        expect(occupied.size).toBeLessThanOrEqual(placeSlots.lounge.length);
      }
      expect(poses.size).toBeGreaterThan(1);
    });

    it(`3D idle seating stays private and seated for fifteen minutes: ${label}`, () => {
      const { members } = fixture(count, busy);
      const people = snapshotPlacement({ members, tasks: [], directives: [], activity: [], emergency: false, now: 0 });
      for (const person of people.filter(person => person.status === 'idle')) {
        expect(['desk', 'producer', 'sofa']).toContain(person.place);
        expect(['sit_idle', 'sit_think', 'sit_lean_back', 'sofa_sit', 'sofa_talk']).toContain(person.clip);
        if (person.place !== 'sofa') {
          const home = homeForAsset(person.asset);
          expect([person.x, person.z]).toEqual([home.x, home.z]);
        }
      }
      const engine = new OfficeBehaviour(new NavigationGrid(authoredFootprints));
      engine.apply(people, false, null);
      const initial = new Map<string, string>();
      const clips = new Set<string>();
      for (const seconds of samples) {
        while (engine.time + .00001 < seconds) engine.advance(.05, reduced);
        const occupied = new Set<string>();
        for (const frame of engine.snapshot().frames.filter(frame => frame.status === 'idle')) {
          expect(['desk', 'producer', 'sofa']).toContain(frame.place);
          expect(['sit_idle', 'sit_think', 'sit_lean_back', 'sofa_sit', 'sofa_talk']).toContain(frame.clip);
          expect(frame.phase).toBe('seated');
          expect({ x: frame.x, z: frame.z }).toEqual(frame.target);
          if (frame.place === 'sofa') {
            expect(restSlots.some(slot => slot.place === 'sofa' && slot.x === frame.x && slot.z === frame.z)).toBe(true);
            const key = `${frame.x}:${frame.z}`;
            expect(occupied.has(key), '3D sofa seat shared').toBe(false);
            occupied.add(key);
          } else {
            const home = homeForAsset(frame.asset);
            expect([frame.x, frame.z]).toEqual([home.x, home.z]);
          }
          const key = `${frame.place}:${frame.x}:${frame.z}`;
          if (!initial.has(frame.id)) initial.set(frame.id, key);
          expect(key, 'Idle workers must not pace').toBe(initial.get(frame.id));
          clips.add(frame.clip);
        }
        expect(occupied.size).toBeLessThanOrEqual(2);
      }
      expect(clips.size).toBeGreaterThan(1);
    });
  }
});
