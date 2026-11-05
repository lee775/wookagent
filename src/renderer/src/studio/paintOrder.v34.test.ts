import { describe, expect, it } from 'vitest';
import { actorDepthKey, chairDepthKey, deskDepthKey, rigOrigin, walkingDepthKey } from './Office';
import { renderActorTick, stations, type ActorMotion, type Behaviour } from './motion';

describe('the real office paint keys', () => {
  it('keeps a walker in front of the desk edges through a complete aisle crossing', () => {
    const farDesk = deskDepthKey(stations[0]);
    const nearDesk = deskDepthKey(stations[6]);
    for (const y of [195, 282, 371, 452, 525]) {
      expect(walkingDepthKey(y)).toBeGreaterThan(farDesk);
      expect(walkingDepthKey(y)).toBeGreaterThan(nearDesk);
    }
  });
  for (const seat of stations) {
    it(`${seat.side} seat ${seat.x} places the sitter between their own chair and desk`, () => {
      const behaviour: Behaviour = { key: 'desk', place: 'desk', pose: 'type', point: seat, label: '작업 중' };
      for (const phase of ['seated', 'rising', 'lowering'] as const) {
        const actor: ActorMotion = {
          key: 'desk', phase, phaseAt: 0, departAt: 0,
          walker: { point: seat, path: [], segment: 0, distance: 0 },
        };
        const render = renderActorTick({ actor, behaviour, seat, now: 175, poseUntil: 0,
          emergency: false, reduced: false, facing: 1 });
        const sitterKey = actorDepthKey(seat, render.feetY);
        if (seat.side === 'far') {
          expect(chairDepthKey(seat)).toBeLessThan(sitterKey);
          expect(sitterKey).toBeLessThan(deskDepthKey(seat));
        } else {
          expect(deskDepthKey(seat)).toBeLessThan(sitterKey);
          expect(sitterKey).toBeLessThan(chairDepthKey(seat));
        }
      }
      const initial = rigOrigin(seat).y;
      const tick = renderActorTick({ actor: { key: 'desk', phase: 'seated', phaseAt: 0, departAt: 0,
        walker: { point: seat, path: [], segment: 0, distance: 0 } }, behaviour, seat, now: 50,
        poseUntil: 0, emergency: false, reduced: false, facing: 1 });
      expect(Math.abs(initial - (seat.y - 106 + tick.seatOffset))).toBeLessThan(1);
    });
  }
});
