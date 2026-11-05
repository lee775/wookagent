import { describe, expect, it } from 'vitest';
import { intersectsRect, pathLength, placeSlots, routeFor, stations, visitPoint, WALK_SPEED, type Point, type Rectangle } from './motion';
import { screenPanels } from './Office';

// Fabric panels as drawn in Office.tsx. The 22 u expansion is the walking body's half-width.
const panels: Rectangle[] = screenPanels.map(([left, right]) => ({ left: left - 22, right: right + 22, top: 343, bottom: 414 }));
const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 2;

describe('screen and pod routes', () => {
  it('keeps the report trip below the meeting table and sofa', () => {
    const board = { x: 370, y: 205 };
    const inbox = placeSlots.inbox[0];
    const furnitureBodies: Rectangle[] = [
      { left: 688, top: 90, right: 832, bottom: 270 },
      { left: 807, top: 83, right: 1104, bottom: 270 },
    ];
    for (const [from, to] of [[board, inbox], [inbox, board]] as const) {
      const route = routeFor(from, to);
      expect(route.at(-1)).toEqual(to);
      expect(pathLength(from, route)).toBeLessThan(13 * WALK_SPEED - 50);
      let previous: Point = from;
      for (const point of route) {
        for (const body of furnitureBodies) expect(intersectsRect(previous, point, body)).toBe(false);
        previous = point;
      }
    }
  });
  it('completes every seat, rest and visit route without crossing a fabric panel', () => {
    const destinations = [...stations, ...Object.values(placeSlots).flat(), ...stations.map(visitPoint)];
    let seatPairs = 0;
    const crossings: string[] = [];
    for (const from of stations) for (const to of destinations) {
      if (same(from, to)) continue;
      if (stations.includes(to as typeof stations[number])) seatPairs++;
      const path = routeFor(from, to);
      expect(path.at(-1), `${from.x},${from.y} → ${to.x},${to.y}`).toMatchObject({ x: to.x, y: to.y });
      let before: Point = from;
      for (const point of path) {
        for (const panel of panels) if (intersectsRect(before, point, panel))
          crossings.push(`${from.x},${from.y} → ${to.x},${to.y} crosses ${panel.left},${panel.right}`);
        before = point;
      }
    }
    expect(seatPairs).toBe(132);
    expect(crossings, crossings.slice(0, 10).join('\n')).toEqual([]);
  });
  it('keeps walking feet out of seated far heads', () => {
    const destinations = [...stations, ...Object.values(placeSlots).flat(), ...stations.map(visitPoint)];
    const pairs: Array<readonly [Point, Point]> = stations.flatMap(from => destinations.map(to => [from, to] as const));
    pairs.push([{ x: 75, y: 240 }, { x: 1125, y: 240 }]);
    for (const [from, to] of pairs) {
      if (same(from, to)) continue;
      let prior: Point = from;
      const route = routeFor(from, to);
      expect(route.at(-1), `${from.x},${from.y} → ${to.x},${to.y}`).toMatchObject({ x: to.x, y: to.y });
      for (const next of route) {
        const length = Math.hypot(next.x - prior.x, next.y - prior.y);
        for (let distance = 0; distance <= length; distance += 5) {
          const point = { x: prior.x + (next.x - prior.x) * distance / (length || 1),
            y: prior.y + (next.y - prior.y) * distance / (length || 1) };
          for (const sitter of stations.filter(seat => seat.side === 'far' && !same(seat, from) && !same(seat, to))) {
            const leg: Rectangle = { left: point.x - 10, right: point.x + 10, top: point.y - 20, bottom: point.y };
            const head: Rectangle = { left: sitter.x - 22, right: sitter.x + 22, top: sitter.y - 70, bottom: sitter.y - 23 };
            const overlap = Math.min(leg.right, head.right) - Math.max(leg.left, head.left) > 0 &&
              Math.min(leg.bottom, head.bottom) - Math.max(leg.top, head.top) > 0;
            expect(overlap, `${from.x},${from.y} → ${to.x},${to.y} via ${point.x},${point.y} over ${sitter.x}`).toBe(false);
          }
        }
        prior = next;
      }
    }
  });
  it('does not reverse vertical direction more than once', () => {
    const points = [...stations, ...Object.values(placeSlots).flat(), ...stations.map(visitPoint)];
    for (const from of points) for (const to of points) {
      if (same(from, to)) continue;
      let prior: Point = from;
      const directions: number[] = [];
      for (const next of routeFor(from, to)) {
        if (Math.abs(next.y - prior.y) > 1) directions.push(Math.sign(next.y - prior.y));
        prior = next;
      }
      const reversals = directions.slice(1).filter((direction, index) => direction !== directions[index]).length;
      expect(reversals, `${from.x},${from.y} → ${to.x},${to.y}`).toBeLessThanOrEqual(1);
    }
  });
});
