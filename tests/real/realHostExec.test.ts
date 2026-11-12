/**
 * 실제 CLI 메인 에이전트가 오래 도는 host_exec의 결과를 받는지 (KNOWN_ISSUES 'host_exec: CLI가 앱 도구를 기다리는 시간의 기본값은 실제 CLI로 재 보지 않음',
 * 리드 결정 S9-10 — SERVER_DESIGN 10.9). 사용량이 드는 실행이라 기본 테스트에서는 건너뛴다. 에이전트는 돌리지 않는다 (리드 결정 S9-13·S9-17)
 *   WOOK_REAL_HOSTEXEC=1 npx vitest run tests/real/realHostExec.test.ts
 *   (기본은 서버 모드. WOOK_REAL_MODE=desktop이면 데스크톱 모드)
 * - Claude 메인과 Codex 메인이 각각 2분짜리와 6분짜리 host_exec를 한 번씩 돌린다: 명령은 기다린 뒤 새 GUID 한 줄을 찍는다 — 메인은 그 GUID를 결과로
 *   받아야만 답할 수 있다(명령 글에 없다)
 * - 확인: host_exec 실행 기록이 성공(종료 코드 0, 시간 초과 아님)이고 그만큼 돌았다, 그 실행 기록 출력의 GUID가 메인 에이전트의 답에 있다(결과가 CLI까지
 *   갔다), 메인 턴은 실제 그 CLI였고 완료로 끝났다
 * - 결과(걸린 시간·턴)를 적는다 — 10.9의 기록에 옮긴다
 * 설치·로그인이 안 된 CLI는 그 까닭을 적고 건너뛴다
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiKind, type ExecRecord } from '@shared/domain';
import { bootReal, realMode } from './serverMode';

const ENABLED = process.env['WOOK_REAL_HOSTEXEC'] === '1';
const MODE = realMode(process.env, 'server');
const MINUTES = [2, 6] as const;
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** 메인에게 보내는 명령 — 기다린 뒤 새 GUID를 찍는 명령 하나를 host_exec로 돌리고 그 GUID를 답하게 한다 */
function commandText(minutes: number): string {
  const seconds = minutes * 60;
  return [
    `host_exec 도구로 다음 명령을 한 번만 실행해 줘 (timeout_s ${seconds + 600}, purpose '실제 시험: ${minutes}분짜리 host_exec', request_id 'real-hx-${minutes}m'):`,
    `powershell -NoProfile -Command "Start-Sleep -Seconds ${seconds}; [guid]::NewGuid().ToString()"`,
    '명령이 끝나면 출력에 나온 GUID 한 줄을 그대로 답해 줘. 다른 도구는 쓰지 말고, 질문 없이 바로 해 줘.',
  ].join('\n');
}

describe.skipIf(!ENABLED)(`실제 CLI 메인의 긴 host_exec (WOOK_REAL_HOSTEXEC=1, ${MODE} 모드)`, () => {
  for (const kind of ['claude', 'codex'] as AiKind[]) {
    it(`${kind} 메인이 2분·6분짜리 host_exec의 결과(GUID)를 받아 답한다`, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'wook-real-hx-data-'));
      const app = await bootReal({
        mode: MODE,
        dataDir,
        requireCli: [kind],
        settings: { developer: { mainAgentMock: false }, general: { mainAgent: { kind, model: null, effortTier: 'normal', effortOverride: null } } },
        logger: (level, msg, extra) => {
          if (level !== 'info') console.error(`[${level}] ${msg}`, extra ?? '');
        },
      });
      if ('skip' in app) {
        console.log(`[WOOK_REAL_HOSTEXEC] ${kind}: 건너뜀 — ${app.skip}`);
        await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
        return;
      }
      const { core, invoke } = app;
      const store = core.ctx.store;
      const recent = (n: number) => store.activity.search({ limit: n }).map((a) => `${a.ts.slice(11, 19)} ${a.kind} ${a.text.slice(0, 160)}`).join('\n');
      try {
        for (const minutes of MINUTES) {
          const t0 = new Date().toISOString();
          const knownExecs = new Set(store.execs.list({ ref2: 'host_exec' }).map((e) => e.requestId));
          const knownReplies = new Set(store.conversation.list({ ref1: 'main' }).map((m) => m.id));
          await invoke('command.send', { target: 'main', text: commandText(minutes) });
          const deadline = Date.now() + (minutes + 15) * 60_000;
          let exec: ExecRecord | undefined;
          let reply = '';
          for (;;) {
            exec = store.execs.list({ ref2: 'host_exec' }).find((e) => !knownExecs.has(e.requestId) && e.endedAt !== null);
            const replies = store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent' && !knownReplies.has(m.id));
            reply = replies.map((m) => m.text).join('\n');
            const mainIdle = !store.turns.list({ ref1: MAIN_AGENT_ID }).some((t) => t.endedAt === null);
            if (exec && reply && mainIdle) break;
            if (Date.now() > deadline) throw new Error(`${kind} ${minutes}분: 시간 초과 (실행 기록 ${exec?.requestId ?? '없음'}, 답 ${reply ? '있음' : '없음'})\n${recent(40)}`);
            await new Promise((r) => setTimeout(r, 5000));
          }
          const result = exec.result as { exitCode?: number | null; timedOut?: boolean; durationMs?: number; outputTail?: string };
          expect(result.exitCode, `${kind} ${minutes}분 종료 코드`).toBe(0);
          expect(result.timedOut).toBe(false);
          expect(result.durationMs ?? 0).toBeGreaterThanOrEqual(minutes * 60_000 - 5_000);
          const printed = (result.outputTail ?? '').match(GUID_RE) ?? [];
          expect(printed.length, '명령이 찍은 GUID').toBe(1);
          // 결과가 CLI까지 갔다 — 메인의 답에 명령이 찍은 GUID가 있다 (명령 글에는 없는 값)
          expect(reply.toLowerCase()).toContain(printed[0]!.toLowerCase());
          const turns = store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => t.startedAt >= t0);
          expect(turns.length).toBeGreaterThan(0);
          expect(turns.every((t) => !t.mock && t.aiKind === kind)).toBe(true);
          expect(turns.map((t) => t.endReason)).toContain('completed');
          console.log(
            `[WOOK_REAL_HOSTEXEC] ${kind} ${minutes}분 (${app.mode} 모드): host_exec ${Math.round((result.durationMs ?? 0) / 1000)}초, 메인 턴 ${turns.length}개 (${turns.map((t) => t.endReason).join(', ')}) — 결과가 CLI에 닿음`,
          );
        }
      } finally {
        await app.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      }
    }, (MINUTES[0] + MINUTES[1] + 40) * 60_000);
  }
});
