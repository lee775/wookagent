import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const durationSeconds = Number(process.argv[3] ?? 15);
const stopOnFailure = process.argv[4] === 'early';
let report;
try {
  await page.goto('http://127.0.0.1:5198/?officeDemo=cycle', { waitUntil: 'networkidle' });
  report = await page.evaluate(({ durationSeconds, stopOnFailure }) => new Promise(resolve => {
    const last = new Map();
    let maxTurn = 0;
    let worst = null;
    const failures = [];
    let frames = 0;
    const start = performance.now();
    const sample = now => {
      frames++;
      document.querySelectorAll('.office-actor').forEach(actor => {
        const name = actor.getAttribute('aria-label');
        actor.querySelectorAll('.person-rig,.rig-arm-left,.rig-arm-right,.rig-leg-left,.rig-leg-right,.rig-head').forEach(joint => {
          const transform = getComputedStyle(joint).transform;
          const values = transform.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number);
          if (!values) return;
          const angle = Math.atan2(values[1], values[0]) * 180 / Math.PI;
          const key = `${name}:${joint.getAttribute('class')}`;
          const prior = last.get(key);
          if (prior !== undefined) {
            const turn = Math.abs(((angle - prior.angle + 540) % 360) - 180);
            if (turn > maxTurn) { maxTurn = turn; worst = { name, joint: joint.getAttribute('class'), pose: actor.dataset.pose, turn: +turn.toFixed(2),
              from: +prior.angle.toFixed(2), to: +angle.toFixed(2), transition: getComputedStyle(joint).transition, changing: actor.classList.contains('pose-changing'), pending: actor.dataset.pendingPose, seconds: +((now - start) / 1000).toFixed(2) }; }
            if (turn > 30) failures.push({ ...worst, previous: prior, armVariable: actor.style.getPropertyValue('--arm-back'), currentPose: actor.dataset.pose });
          }
          last.set(key, { angle, pose: actor.dataset.pose, changing: actor.classList.contains('pose-changing'), pending: actor.dataset.pendingPose,
            armVariable: actor.style.getPropertyValue('--arm-back'), seconds: +((now - start) / 1000).toFixed(2) });
        });
      });
      if (now - start < durationSeconds * 1000 && !(stopOnFailure && failures.length)) requestAnimationFrame(sample);
      else resolve({ durationSeconds: +((now - start) / 1000).toFixed(2), frames, maxJointTurn: +maxTurn.toFixed(2), worst,
        failures: failures.slice(0, 8), pass: maxTurn <= 30 });
    };
    requestAnimationFrame(sample);
  }), { durationSeconds, stopOnFailure });
} finally { await browser.close(); }
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
