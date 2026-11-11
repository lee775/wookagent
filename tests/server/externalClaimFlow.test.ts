/**
 * externalClaimFlow (SERVER_DESIGN 10.7, 리드 결정 S7-7): 운영자가 외부 에이전트를 등록하고(agent add) 메인 자리를 배정하면(seat assign external:X-0001)
 * 모의 외부 에이전트가 claim → 롱폴 → 진행 → 도구(MCP와 REST 둘 다) → finish로 대표 명령을 처리한다.
 * - 답은 command.history에 남고, 도구 호출 기록(app_tool)은 M-MAIN의 것이며, 턴·세션의 실행 주체는 외부(runner external, pid 없음)다
 * - 보고서 요청(main_report)을 싣고 끝난 외부 턴 뒤에도 judgeMain이 그대로 다시 요청한다
 * - agent-endpoint.json은 주소와 서버 확인값(proof — hello로만 쓴다, S7-19 C3)만 담고(키 없음) 대표용 포트에는 /agent/v1이 없다
 * 서버는 하네스 백엔드를 감싼 프로세스 안 서버, 모의 외부 에이전트는 자식 프로세스 (리드 결정 S7-7)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAIN_AGENT_ID, type Directive } from '@shared/domain';
import { agentEndpointPath } from '../../src/server/server';
import { enqueue } from '../../src/main/orchestrator/records';
import { EXTERNAL_STOP } from '../../src/main/orchestrator/externalAgents';
import { agentCall, bootExternal, situation, until, type ExternalEnv } from './externalRig';
import { httpCall } from './helpers';

let x: ExternalEnv;
let key = '';

beforeAll(async () => {
  x = await bootExternal({ noProject: false, team: [] });
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const seedReportingDirective = (): Directive => {
  const ctx = x.h.core.ctx;
  const now = ctx.now();
  const d: Directive = {
    id: ctx.store.nextId('directive'),
    projectId: x.h.projectId,
    title: '보고 대기 지시',
    text: '보고 대기 지시',
    attachments: [],
    round: 1,
    state: 'reporting',
    rounds: [{ round: 1, requestedAt: now, text: '보고 대기 지시', anchored: [], reportId: null }],
    finalResult: null,
    planApprovalRequired: false,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    cancelledAt: null,
  };
  ctx.store.directives.insert(d);
  return d;
};

describe('externalClaimFlow — 등록·배정 → claim → 롱폴 → 도구 → finish → 보고 (S7-7)', () => {
  it('agent-endpoint.json은 루프백 주소만 담고, 대표용 포트에는 에이전트 API가 없다', async () => {
    const file = JSON.parse(readFileSync(agentEndpointPath(x.h.dataDir), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(['agentApi', 'mcp', 'pid', 'proof', 'runId', 'startedAt', 'version']);
    expect(file).toMatchObject({ version: 1, runId: x.server.runId, pid: process.pid });
    // 서버 확인값 (S7-19 C3): 32바이트 base64url — 이 파일에만 있다. hello가 그것으로 만든 HMAC을 답하고, 실행 ID·proof는 내지 않으며, 서버 기록에도 없다
    const proof = String(file.proof);
    expect([proof.length, Buffer.from(proof, 'base64url').length, proof === x.server.runId]).toEqual([43, 32, false]);
    const nonce = randomBytes(32);
    const hello = await agentCall(String(file.agentApi), null, '/hello', { body: { nonce: nonce.toString('base64url') } });
    expect([hello.status, Object.keys(hello.json()), hello.json<{ mac: string }>().mac === createHmac('sha256', Buffer.from(proof, 'base64url')).update(nonce).digest('base64url')]).toEqual([200, ['ok', 'mac'], true]);
    expect([hello.body.toString('utf8').includes(proof), hello.body.toString('utf8').includes(x.server.runId)]).toEqual([false, false]);
    expect(x.logger.text().includes(proof)).toBe(false);
    // 메인 CLI가 그 파일을 찍어도 도구 결과·기록에 원문이 남지 않게 백엔드 가리개가 안다
    expect(x.h.core.ctx.redact.text(`파일 내용: ${proof} 끝`).includes(proof)).toBe(false);
    expect(String(file.agentApi)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent\/v1$/);
    expect(String(file.mcp)).toBe(String(file.agentApi).replace(/\/agent\/v1$/, '/mcp'));
    expect(new URL(String(file.agentApi)).port).not.toBe(String(x.server.port));
    // 대표용 포트(tailscale serve가 넘겨 주는 곳)에는 /agent/v1이 없다
    const owner = await httpCall({ url: x.server.url, path: '/agent/v1/seat', headers: { Authorization: 'Bearer wsk_x' } });
    expect(owner.status).not.toBe(200);
    expect(owner.text).not.toContain('assigned');
    // 에이전트 API는 그 리스너의 Host 검사 뒤에 붙는다 — 루프백 이름이 아닌 Host는 키를 보기 전에 403 (DNS 리바인딩 방지)
    const rebound = await agentCall(String(file.agentApi), 'wsk_x', '/seat', { headers: { Host: 'evil.example' } });
    expect(rebound.status).toBe(403);
  });

  it('대표 명령이 모의 외부 에이전트에게 가고, 도구를 MCP·REST로 부른 뒤 마친 답이 command.history에 남는다', async () => {
    const grant = x.operator.addExternalAgent('그록봇');
    key = grant.key;
    expect(grant.id).toBe('X-0001');
    const assigned = await x.operator.assignSeat('external:X-0001', true);
    expect(assigned).toMatchObject({ holder: '그록봇', state: 'active' });
    // 보고서를 기다리는 지시 — 외부 턴이 보고서 요청을 싣고 끝나면 judgeMain이 다시 요청한다
    const d = seedReportingDirective();
    enqueue(x.h.core.ctx, { kind: 'main_report', memberId: MAIN_AGENT_ID, sessionKey: 'main:general', projectId: d.projectId, directiveId: d.id, priority: 'high', message: `지시 ${d.id}의 보고서를 내세요` });

    const mock = x.spawnMock(key, ['--tools', 'both', '--heartbeat-ms', '300']);
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'claim' && e.status === 200), 'claim');
    // 본보기 클라이언트는 키를 보내기 전에 서버를 확인했다 (S7-19 C3 — --endpoint로 받은 파일의 proof로)
    expect(x.mockLog(mock.log)[0]).toMatchObject({ ev: 'hello', status: 200, ok: true });
    expect(x.mockLog(mock.log).find((e) => e.ev === 'claim')).toMatchObject({ generation: 2, agentId: 'X-0001', hasRules: true });
    await x.owner$('command.send', { target: 'main', text: '오늘 할 일을 정리해 줘' });

    const ctx = x.h.core.ctx;
    await until(() => ctx.store.conversation.list({ ref1: 'main' }).some((m) => m.role === 'main_agent' && m.text === '모의 외부 에이전트: 오늘 할 일을 정리해 줘'), '외부 에이전트의 답', 60_000, () => situation(x, mock.log));
    const history = await x.owner$<{ role: string; text: string }[]>('command.history', 'main', {});
    expect(JSON.stringify(history)).toContain('모의 외부 에이전트: 오늘 할 일을 정리해 줘');

    // 보고서 요청은 그대로 다시 들어간다 (전달 횟수 1부터) — 두 번 다시 요청한 뒤에는 대표에게 알린다
    await until(() => ctx.store.notifications.list().some((n) => n.title === '보고서 작성 지연'), '보고서 재촉 상한 알림');
    expect(ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_report').map((q) => q.deliveries ?? 0).sort()).toEqual([0, 1, 2]);

    // 턴·세션은 외부 실행 주체 — pid 없이, 끝남은 exited, 정상 종료
    await until(() => x.h.core.turns.count() === 0, '턴 정리');
    const turns = ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => (t.seatGeneration ?? 0) === 2);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    for (const t of turns) {
      expect({ runner: t.runner, agent: t.externalAgentId, aiKind: t.aiKind, mock: t.mock, pid: t.process.pid, state: t.process.state, end: t.endReason }).toEqual({
        runner: 'external',
        agent: 'X-0001',
        aiKind: 'external',
        mock: false,
        pid: null,
        state: 'exited',
        end: 'completed',
      });
      expect(t.process.killDetail).not.toBe(EXTERNAL_STOP);
    }
    const sessions = ctx.store.sessions.list({ ref1: MAIN_AGENT_ID }).filter((s) => !s.closedAt);
    expect(sessions.map((s) => [s.aiKind, s.runner, s.externalAgentId])).toEqual([['external', 'external', 'X-0001']]);
    // 다음 턴은 같은 세션을 이어 간다 (첫 턴만 처음)
    expect(turns.filter((t) => !t.isResume)).toHaveLength(1);

    // 도구 호출 기록은 M-MAIN의 것 — MCP와 REST 둘 다, 그 외부 턴의 것
    const replyTurn = turns.find((t) => t.finalText === '모의 외부 에이전트: 오늘 할 일을 정리해 줘')!;
    const rows = ctx.store.activity.search({ kinds: ['app_tool'], limit: 200 }).filter((a) => a.turnId === replyTurn.id && a.text === 'get_overview');
    expect(rows.map((a) => [a.memberId, a.actor, a.level])).toEqual([
      [MAIN_AGENT_ID, MAIN_AGENT_ID, 'info'],
      [MAIN_AGENT_ID, MAIN_AGENT_ID, 'info'],
    ]);
    const tools = x.mockLog(mock.log).filter((e) => e.ev === 'tool' && e.name === 'get_overview');
    expect(new Set(tools.filter((e) => e.ok).map((e) => e.via))).toEqual(new Set(['mcp', 'rest']));
    // 대표 화면의 팀원 상세가 외부 턴을 그대로 보인다 (TurnView.runner)
    const detail = await x.owner$<{ recentTurns: { id: string; runner?: string }[] }>('members.getDetail', MAIN_AGENT_ID);
    expect(detail.recentTurns.find((t) => t.id === replyTurn.id)?.runner).toBe('external');
    // 진행 글이 이벤트 파일에 남는다
    expect(readFileSync(replyTurn.eventsFile, 'utf8')).toContain('모의 외부 에이전트: 일을 시작합니다');

    // 키는 모의 에이전트 기록·서버 기록 어디에도 없다 (기록에는 턴 토큰도 없다)
    const mockText = readFileSync(mock.log, 'utf8');
    expect([mockText.includes(key), mockText.includes('wtt_'), x.logger.text().includes(key)]).toEqual([false, false, false]);
    // 목록의 연결됨·마지막 접속
    expect((await x.owner$<{ id: string; connected: boolean; seat: string | null; lastSeenAt: string | null }[]>('agents.list')).map((a) => [a.id, a.connected, a.seat, !!a.lastSeenAt])).toEqual([['X-0001', true, 'seated', true]]);
    // GET seat (보기)
    const seat = await agentCall(x.api, key, '/seat');
    expect(seat.json()).toMatchObject({ ok: true, assigned: true, generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0001', label: '그록봇' } });
  }, 180_000);

  it('대표용 포트는 등록된(폐기되지 않은) 키에도 에이전트 API를 주지 않는다 — 대표 쪽의 답 그대로, 긴급 정지도 걸리지 않는다 (리드 결정 S7-3·S7-20 TI-3)', async () => {
    // 같은 키가 루프백 리스너에서는 받아진다 — 아래의 거부가 키 때문이 아니다
    expect((await agentCall(x.api, key, '/seat')).status).toBe(200);
    // 대표용 포트(tailscale serve가 넘겨 주는 곳): 웹 화면 없이 띄운 서버의 '없는 쪽' 404 — 에이전트 API의 JSON(assigned)이 아니다
    const owner = await httpCall({ url: x.server.url, path: '/agent/v1/seat', headers: { Authorization: `Bearer ${key}` } });
    expect([owner.status, owner.text]).toEqual([404, '없는 쪽입니다. 이 서버는 웹 화면 없이(--web-dir 없이) 띄웠습니다.']);
    const stop = await httpCall({ url: x.server.url, path: '/agent/v1/stop', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(stop.status).not.toBe(200);
    expect(stop.text).not.toContain('stoppedTurns');
    expect(x.h.core.ctx.stop().global.active).toBe(false);
  });
});
