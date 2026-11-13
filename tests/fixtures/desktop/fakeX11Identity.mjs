// 가짜 화면의 주인 확인 (S10c, 리드 결정 S10-13 SC-1) — x11Sidecar.py --identity <n>과 같은 한 줄 JSON을 낸다. 장면(WOOK_FAKE_X11)의 identity 칸이 답을 정한다:
// { ok: true, pid } 또는 { ok: false, detail: 'noabstract' | 'foreign' | 'otheruser' | 'nodisplay' }. 부를 때마다 장면을 다시 읽고 WOOK_FAKE_X11_LOG에 남긴다
// ({tool: 'identity', args: [n]}). X에는 붙지 않는다.
import { appendFileSync, readFileSync } from 'node:fs';

const n = process.argv[2];
const scenePath = process.env.WOOK_FAKE_X11;
const logPath = process.env.WOOK_FAKE_X11_LOG;
if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), tool: 'identity', args: [n] })}\n`);
const id = JSON.parse(readFileSync(scenePath, 'utf8')).identity ?? { ok: true, pid: 4000 };
process.stdout.write(`${JSON.stringify(id)}\n`);
