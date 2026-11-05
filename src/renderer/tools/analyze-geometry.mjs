import { readFileSync, writeFileSync } from 'node:fs';

const [input, output = 'geometry-summary.json'] = process.argv.slice(2);
const { rows, errors } = JSON.parse(readFileSync(input, 'utf8'));
const workPoses = new Set(['type', 'draw', 'write', 'diagram', 'check', 'check_wait', 'inspect', 'read', 'plan']);
const area = b => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
const intersection = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const previous = new Map(), walks = [], activeWalks = new Map(), offDesk = [], farLegs = [], overlaps = [];
let maxOverlap = 0, handoffSeconds = 0;
for (const [time, , actors] of rows) {
  for (const actor of actors) {
    const name = actor[0];
    const position = [actor[5] + 40, actor[15]];
    const seat = actor[14];
    if (workPoses.has(actor[1]) && dist(position, seat) > 2)
      offDesk.push({ time, name, pose: actor[1], distance: +dist(position, seat).toFixed(1) });
    if (seat[1] < 300 && Math.abs(position[0] - seat[0]) <= 40 && Math.abs(position[1] - seat[1]) <= 35 &&
      actor[4] === 'false' && !actor[16]) farLegs.push({ time, name, position });
    const walking = actor[1] === 'walk' || actor[2] === 'walk';
    let episode = activeWalks.get(name);
    if (walking && !episode) {
      episode = { name, start: time, last: previous.get(name) ?? position, distance: 0,
        firstMove: null, firstSwing: null };
      activeWalks.set(name, episode);
    }
    if (episode) {
      const moved = dist(position, episode.last);
      episode.distance += moved;
      if (moved > .4 && !episode.firstMove) episode.firstMove = { time, distance: episode.distance };
      if (Math.abs(actor[7] ?? 0) > 1 && !episode.firstSwing) episode.firstSwing = { time, distance: episode.distance };
      episode.last = position;
      if (!walking) {
        if (episode.distance > 15) walks.push({ name, start: episode.start, length: +episode.distance.toFixed(1),
          delayMs: episode.firstMove && episode.firstSwing ? episode.firstSwing.time - episode.firstMove.time : null,
          legDistance: episode.firstMove && episode.firstSwing ? +(episode.firstSwing.distance - episode.firstMove.distance).toFixed(1) : null });
        activeWalks.delete(name);
      }
    }
    previous.set(name, position);
  }
  for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
    const a = actors[i], b = actors[j];
    const fraction = intersection(a[13], b[13]) / Math.min(area(a[13]), area(b[13]));
    maxOverlap = Math.max(maxOverlap, fraction);
    const partner = ['submit', 'receive'].includes(a[1]) && ['submit', 'receive'].includes(b[1]);
    if (fraction > .15 && !partner && overlaps.length < 100)
      overlaps.push({ time, names: [a[0], b[0]], poses: [a[1], b[1]], fraction: +fraction.toFixed(3) });
    if (partner && dist([a[5], a[15]], [b[5], b[15]]) >= 50 &&
      dist([a[5], a[15]], [b[5], b[15]]) <= 90 && a[11] !== b[11]) handoffSeconds += rows.length > 1 ? (rows[1][0] - rows[0][0]) / 1000 : 0;
  }
}
const maxLegDelayMs = Math.max(0, ...walks.map(w => w.delayMs ?? Infinity));
const maxLegDistance = Math.max(0, ...walks.map(w => w.legDistance ?? Infinity));
const result = { samples: rows.length, errors, maxOverlap: +maxOverlap.toFixed(3), overlapViolations: overlaps,
  walks: walks.length, maxLegDelayMs, maxLegDistance, walkFailures: walks.filter(w => w.delayMs === null || w.delayMs > 150 || w.legDistance > 15),
  offDesk, farLegs, handoffSeconds: +handoffSeconds.toFixed(2) };
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ samples: result.samples, errors: errors.length, maxOverlap: result.maxOverlap,
  overlapViolations: overlaps.length, walks: walks.length, maxLegDelayMs, maxLegDistance,
  walkFailures: result.walkFailures.length, offDesk: offDesk.length, farLegs: farLegs.length,
  handoffSeconds: result.handoffSeconds }));
if (errors.length || overlaps.length || result.walkFailures.length || offDesk.length || farLegs.length || handoffSeconds < 1.5) process.exitCode = 1;
