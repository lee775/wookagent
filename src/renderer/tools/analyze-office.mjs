import fs from 'node:fs';
const file = process.argv[2] ?? 'probe-cycle.json';
const { rows } = JSON.parse(fs.readFileSync(file, 'utf8'));
// rows: [t, now, list, labels, stopped]; list item: [name, pose, pending, view, seated, tx, ty, swing, chg, layer, order, facing, arm]
const names = [...new Set(rows.flatMap(r => r[2].map(a => a[0])))];
// 1. glides at walk start
const glides = [];
for (const n of names) {
  let inWalk = false, glide = 0, start = 0, last = null, total = 0, maxSw = 0;
  for (const [t, , list] of rows) {
    const a = list.find(x => x[0] === n); if (!a) { inWalk = false; last = null; continue; }
    const p = [a[5], a[6]];
    const walking = a[1] === 'walk' || a[2] === 'walk';
    if (walking && !inWalk) { inWalk = true; glide = 0; total = 0; start = t; maxSw = 0; }
    if (inWalk && last) {
      const d = Math.hypot(p[0] - last[0], p[1] - last[1]);
      total += d; if (Math.abs(a[7] ?? 0) <= 3 && maxSw < 10) glide += d; maxSw = Math.max(maxSw, Math.abs(a[7] ?? 0));
    }
    if (!walking && inWalk) { inWalk = false; if (total > 15) glides.push({ n, start, glide: Math.round(glide), total: Math.round(total) }); }
    last = p;
  }
}
console.log('walks:', glides.length, 'glide before legs move (|swing|<=3):', glides.map(g => `${g.n}@${(g.start/1000).toFixed(1)}s ${g.glide}/${g.total}u`).join('; '));
console.log('mean glide', (glides.reduce((s, g) => s + g.glide, 0) / glides.length).toFixed(1), 'units');
// 2. standing away from seat in a desk-work pose: pose in desk set and not seated and position not changing
const deskPoses = new Set(['type','draw','write','diagram','check','check_wait','inspect','read','plan','point','error','conflict','sigh','celebrate','wait']);
const away = {};
for (const [t, , list] of rows) for (const a of list) if (!a[2] && deskPoses.has(a[1]) && a[4] === 'false') {
  // exclude producer at board (plan/point/read at board is legit) by checking location near board slot (385,190) -> translate (345,84)
  const atBoard = Math.hypot(a[5] - 430, a[6] - 64) < 4;
  if (atBoard) continue;
  (away[a[0]] ??= []).push([t, a[1], a[5] + 40, a[6] + 106]);
}
for (const [n, list] of Object.entries(away)) {
  // group into episodes
  const eps = []; let cur = null;
  for (const [t, pose, x, y] of list) { if (cur && t - cur.end < 100) { cur.end = t; } else { cur = { start: t, end: t, pose, x, y }; eps.push(cur); } }
  console.log('desk pose while standing away from seat:', n, eps.map(e => `${(e.start/1000).toFixed(2)}-${(e.end/1000).toFixed(2)}s ${e.pose} at ${e.x},${e.y}`).join('; '));
}
// 3. overlaps (head+torso boxes from translate)
const box = a => ({ l: a[5] + 18, r: a[5] + 62, t: a[6] + 4, b: a[6] + 76 });
const inter = (p, q) => Math.max(0, Math.min(p.r, q.r) - Math.max(p.l, q.l)) * Math.max(0, Math.min(p.b, q.b) - Math.max(p.t, q.t));
const area = p => (p.r - p.l) * (p.b - p.t);
const pairs = new Map();
for (const [t, , list] of rows) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j]; const A = box(a), B = box(b);
    const f = inter(A, B) / Math.min(area(A), area(B));
    if (f > 0.15) {
      const kind = x => (x[1] === 'walk' ? 'walk' : x[4] === 'true' ? 'seated' : 'stand');
      const key = [a[0], b[0]].sort().join('+');
      let e = pairs.get(key);
      if (!e || t - e.last > 400) { e = { key, first: t, last: t, max: 0, kinds: new Set(), at: `${a[5]+40},${a[6]+106}` }; pairs.set(key + ':' + t, e); pairs.set(key, e); }
      e.last = t; e.max = Math.max(e.max, f); e.kinds.add(`${a[0]}:${kind(a)}/${b[0]}:${kind(b)}`);
    }
  }
}
const eps = [...new Set([...pairs.entries()].filter(([k]) => k.includes(':')).map(([, v]) => v))].sort((a, b) => a.first - b.first);
console.log('overlap episodes (head+torso >15% of smaller):');
for (const e of eps) console.log(`  ${(e.first/1000).toFixed(2)}-${(e.last/1000).toFixed(2)}s ${e.key} max ${(e.max*100).toFixed(0)}% ${[...e.kinds].join(' ')} near ${e.at}`);
// 4. walker draw cadence
const gaps = [];
for (const n of names) { let lastT = null, lastP = null; for (const [t, , list] of rows) { const a = list.find(x => x[0] === n); if (!a) continue; if (a[1] === 'walk') { const key = `${a[5]},${a[6]}`; if (lastP !== null && key !== lastP) { if (lastT !== null) gaps.push(t - lastT); lastT = t; } lastP = key; } else { lastT = null; lastP = null; } } }
gaps.sort((a, b) => a - b);
console.log('walker redraw interval ms: median', gaps[Math.floor(gaps.length/2)], 'p90', gaps[Math.floor(gaps.length*.9)], 'max', gaps.at(-1));
