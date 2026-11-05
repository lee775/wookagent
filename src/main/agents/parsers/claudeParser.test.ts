import { describe, expect, it } from 'vitest';
import type { ParsedCliEvent } from '@shared/events';
import { fixtureLines, ofKind, replay } from '../__fixtures__/replay';
import { createClaudeParser, parseMcpToolName } from './claudeParser';

const NOW = new Date('2026-10-27T03:00:00.000Z'); // 12:00 KST
const newParser = () => createClaudeParser({ serverName: 'wook', now: () => NOW, timeZone: 'Asia/Seoul' });

const SID = '11111111-2222-4333-8444-555555555555';
const j = (o: unknown) => JSON.stringify(o);
const init = (over: Record<string, unknown> = {}) =>
  j({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5', permissionMode: 'bypassPermissions', mcp_servers: [{ name: 'wook', status: 'connected' }], tools: ['Bash'], ...over });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => j({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content }, parent_tool_use_id: null, session_id: SID, ...extra });
const user = (content: unknown[], extra: Record<string, unknown> = {}) => j({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: SID, ...extra });
const result = (over: Record<string, unknown> = {}) =>
  j({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'OK', session_id: SID, total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 5 }, permission_denials: [], ...over });

function feed(lines: string[]): ParsedCliEvent[] {
  const p = newParser();
  return lines.flatMap((l) => p.pushLine(l));
}

describe('Claude 실제 출력 (2.1.311)', () => {
  it('첫 턴: init의 session_id·바이패스·MCP 연결, 지침 적용 결과, 사용량', () => {
    const ev = replay(newParser(), 'claude-first');
    const [session] = ofKind(ev, 'session');
    expect(session!.data).toEqual({
      cliSessionId: '09103c54-7b9c-4740-8d7d-b79c12ab5bfe',
      permissionMode: 'bypassPermissions',
      mcpServers: [{ name: 'wook', status: 'connected' }],
    });
    expect(ofKind(ev, 'error')).toEqual([]);
    expect(ofKind(ev, 'thinking')[0]!.text).toBe('(추론 내용 비공개)');
    const [res] = ofKind(ev, 'result');
    expect(res!.text.startsWith('WOOK-SYS-4417')).toBe(true);
    expect(res!.data).toMatchObject({ isError: false, numTurns: 1, permissionDenials: 0 });
    const [usage] = ofKind(ev, 'usage');
    // modelUsage 합계: 입력 2 + 캐시 읽기 16834 + 캐시 쓰기 20608
    expect(usage!.data).toEqual({ inputTokens: 37444, outputTokens: 322, cachedInputTokens: 16834, costUsd: 0.00445114 });
    expect(ev.every((e) => e.raw !== undefined)).toBe(true);
  });

  it('이어하기: 앱 도구(ping)·Bash·Write가 각각 mcp_call·command·file_change로 짝지어진다', () => {
    const ev = replay(newParser(), 'claude-resume-tools');
    expect(ofKind(ev, 'session')[0]!.data?.cliSessionId).toBe('09103c54-7b9c-4740-8d7d-b79c12ab5bfe');
    // 2.1.x는 MCP 도구를 지연 로드한다: ToolSearch로 불러온 뒤 호출
    const search = ev.find((e) => e.kind === 'tool_result' && e.data?.tool === 'ToolSearch');
    expect(search!.text).toContain('도구 불러옴: mcp__wook__ping');

    const [mcp] = ofKind(ev, 'mcp_call');
    expect(mcp!.data).toEqual({ tool: 'ping', server: 'wook', callId: 'toolu_01MocBSaUtY695C59ibG4ZyG' });
    const mcpResult = ev.find((e) => e.kind === 'tool_result' && e.data?.callId === 'toolu_01MocBSaUtY695C59ibG4ZyG');
    expect(mcpResult!.data).toMatchObject({ tool: 'ping', server: 'wook', ok: true });
    expect(mcpResult!.text).toContain('pong: 한글 hello');

    const [start] = ofKind(ev, 'command_start');
    const [end] = ofKind(ev, 'command_end');
    expect(start!.data).toEqual({ tool: 'Bash', callId: 'toolu_01DfFXQXMGpnpbUtnhRtWAp2', command: 'echo wook-cmd' });
    expect(start!.text).toBe('$ echo wook-cmd');
    expect(end!.data).toEqual({ tool: 'Bash', callId: 'toolu_01DfFXQXMGpnpbUtnhRtWAp2', command: 'echo wook-cmd', exitCode: 0, ok: true });

    const [file] = ofKind(ev, 'file_change');
    expect(file!.data).toEqual({ tool: 'Write', callId: 'toolu_01HLHM1pXzkn6e7iajsn1Xt7', paths: ['<TMP>\\작업 폴더 repo\\note.txt'] });
    const [res] = ofKind(ev, 'result');
    expect(res!.text).toBe('DONE');
    expect(res!.data).toMatchObject({ isError: false, numTurns: 5, permissionDenials: 0 });
    expect(ofKind(ev, 'error')).toEqual([]);
  });

  it('바이패스 없이 실행: init permissionMode default + 거부 순간 권한 오류 1회 + result 거부 1건', () => {
    const ev = replay(newParser(), 'claude-permission-default');
    expect(ofKind(ev, 'session')[0]!.data?.permissionMode).toBe('default');
    expect(ofKind(ev, 'session')[0]!.text).toContain('바이패스 아님');
    const errors = ofKind(ev, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data).toEqual({ errorKind: 'permission' });
    // 거부 이벤트가 도구 결과보다 먼저 온다 → 오케스트레이터가 바로 턴을 끝낼 수 있다
    const errorAt = ev.indexOf(errors[0]!);
    const toolResultAt = ev.findIndex((e) => e.kind === 'tool_result' && e.data?.tool === 'Write');
    expect(errorAt).toBeLessThan(toolResultAt);
    expect(ev[toolResultAt]!.data?.ok).toBe(false);
    expect(ofKind(ev, 'result')[0]!.data).toMatchObject({ isError: false, permissionDenials: 1 });
  });

  it('--max-turns 도달: error_max_turns → isError 결과, 오류 이벤트 없음', () => {
    const ev = replay(newParser(), 'claude-max-turns');
    const [res] = ofKind(ev, 'result');
    expect(res!.text).toBe('최대 반복 수(1회)에 도달해 멈췄습니다');
    expect(res!.data).toMatchObject({ isError: true, numTurns: 2 });
    expect(res!.data?.errorKind).toBeUndefined();
    expect(ofKind(ev, 'error')).toEqual([]);
  });

  it('로그인 없음: 합성 오류 메시지(error=authentication_failed) → 인증 오류 1회, 결과에도 errorKind', () => {
    const ev = replay(newParser(), 'claude-not-logged-in');
    const errors = ofKind(ev, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.text).toBe('인증 필요: Not logged in · Please run /login');
    expect(errors[0]!.data).toEqual({ errorKind: 'auth' });
    expect(ofKind(ev, 'result')[0]!.data).toMatchObject({ isError: true, errorKind: 'auth' });
    expect(ofKind(ev, 'text')).toEqual([]);
  });

  it('없는 세션 이어하기: init 없이 result(error_during_execution, errors[]) + stderr → resumeFailed 1회', () => {
    const ev = replay(newParser(), 'claude-resume-missing');
    expect(ofKind(ev, 'session')).toEqual([]);
    const errors = ofKind(ev, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data).toEqual({ errorKind: 'other', resumeFailed: true });
    expect(ofKind(ev, 'result')[0]!.data).toMatchObject({ isError: true, resumeFailed: true, numTurns: 0 });
    expect(ofKind(ev, 'stderr')).toHaveLength(1);
  });

  it('앱 도구 서버에 닿지 않으면 init의 mcp_servers가 failed → mcp 오류 (턴은 계속되므로 오케스트레이터가 끊는다)', () => {
    const ev = replay(newParser(), 'claude-mcp-unreachable');
    expect(ofKind(ev, 'session')[0]!.data?.mcpServers).toEqual([{ name: 'wook', status: 'failed' }]);
    expect(ofKind(ev, 'error').map((e) => e.data)).toEqual([{ errorKind: 'mcp' }]);
    expect(ofKind(ev, 'result')[0]!.data?.isError).toBe(false);
  });

  it('이미 있는 --session-id: stdout 없이 stderr만 → 결과 없음 안내 (종료 코드 1)', () => {
    const ev = replay(newParser(), 'claude-session-in-use');
    expect(ofKind(ev, 'stderr')[0]!.text).toMatch(/^Error: Session ID [0-9a-f-]{36} is already in use\.$/);
    expect(ev.at(-1)).toMatchObject({ kind: 'system', data: { exitCode: 1, isError: true } });
  });

  it('어떤 줄을 반쯤 잘라도 던지지 않고 원문을 보존한다', () => {
    for (const name of ['claude-first', 'claude-resume-tools', 'claude-permission-default', 'claude-not-logged-in']) {
      const p = newParser();
      for (const l of fixtureLines(name).stdout) {
        const cut = l.slice(0, Math.floor(l.length / 2));
        const ev = p.pushLine(cut);
        expect(ev.length).toBeGreaterThan(0);
        expect(ev.every((e) => e.raw !== undefined)).toBe(true);
      }
    }
  });
});

describe('Claude 합성 경계 사례', () => {
  it('JSON이 아닌 줄·배열·type 없는 객체는 system으로 원문 보존', () => {
    const ev = feed(['not json {', '[1,2,3]', '{"foo":1}']);
    expect(ev.map((e) => e.kind)).toEqual(['system', 'system', 'system']);
    expect(ev[0]!.raw).toBe('not json {');
    expect(ev[2]!.text).toContain('알 수 없는 이벤트');
  });

  it('빈 줄은 무시', () => {
    expect(feed(['', '   '])).toEqual([]);
  });

  it('init permissionMode default → session에 그대로 (오케스트레이터가 바이패스 불일치 판정)', () => {
    const [s] = feed([init({ permissionMode: 'default' })]);
    expect(s!.data?.permissionMode).toBe('default');
  });

  it('앱 도구 서버 연결 실패·누락 → mcp 오류', () => {
    expect(feed([init({ mcp_servers: [{ name: 'wook', status: 'failed' }] })]).filter((e) => e.kind === 'error')[0]!.data).toEqual({ errorKind: 'mcp' });
    expect(feed([init({ mcp_servers: [{ name: 'other', status: 'connected' }] })]).some((e) => e.kind === 'error' && e.data?.errorKind === 'mcp')).toBe(true);
  });

  it('사용량 한도: rate_limit_event(rejected) → 해제 시각 포함 오류 1회, 이후 같은 분류는 system으로 낮춤, 결과에 resetAt', () => {
    const ev = feed([
      init(),
      j({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793091600, rateLimitType: 'five_hour', isUsingOverage: false }, session_id: SID }),
      assistant([{ type: 'text', text: "You've hit your session limit · resets 6pm" }], { error: 'rate_limit', is_api_error_message: true }),
      result({ is_error: true, result: "You've hit your session limit · resets 6pm" }),
    ]);
    const errors = ofKind(ev, 'error');
    expect(errors).toHaveLength(1);
    // 한도 종류도 싣는다 — 종류 전체 한도(five_hour)와 모델별 주간 한도를 가른다 (리드 결정 22)
    expect(errors[0]!.data).toEqual({ errorKind: 'usage_limit', resetAt: '2026-10-27T09:00:00.000Z', rateLimitType: 'five_hour' });
    expect(errors[0]!.text).toContain('5시간 한도');
    expect(ofKind(ev, 'result')[0]!.data).toMatchObject({ isError: true, errorKind: 'usage_limit', rateLimitType: 'five_hour' });
  });

  it('추가 사용(overage)으로 계속되는 rejected는 한도가 아니다', () => {
    const ev = feed([j({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793091600, isUsingOverage: true } })]);
    expect(ev.map((e) => e.kind)).toEqual(['system']);
  });

  it.each([
    ['Claude AI usage limit reached|1761580800', { errorKind: 'usage_limit', resetAt: '2025-10-27T16:00:00.000Z' }],
    ['5-hour limit reached ∙ resets 3pm', { errorKind: 'usage_limit', resetAt: '2026-10-27T06:00:00.000Z' }],
    ['Invalid API key · Please run /login', { errorKind: 'auth' }],
    ['Not logged in', { errorKind: 'auth' }],
  ])('결과 문구 "%s" 분류', (text, data) => {
    const ev = feed([result({ is_error: true, result: text })]);
    expect(ofKind(ev, 'error')[0]!.data).toEqual(data);
    expect(ofKind(ev, 'result')[0]!.data).toMatchObject(data);
  });

  it('result.permission_denials가 비어 있지 않으면 거부 건수 + 권한 오류 (앞선 이벤트가 없었던 경우)', () => {
    const ev = feed([result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }, { tool_name: 'Write', tool_use_id: 't2', tool_input: {} }] })]);
    expect(ofKind(ev, 'error')[0]!.data).toEqual({ errorKind: 'permission' });
    expect(ofKind(ev, 'result')[0]!.data?.permissionDenials).toBe(2);
  });

  it('도구 결과의 권한 확인 문구도 즉시 권한 오류 (permission_denied 이벤트가 없는 경로)', () => {
    const ev = feed([
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." }]),
    ]);
    expect(ev.map((e) => e.kind)).toEqual(['command_start', 'error', 'command_end']);
    expect(ev[1]!.data?.errorKind).toBe('permission');
  });

  it('Bash 실패: "Exit code N" → 종료 코드, 백그라운드 실행은 종료 코드 없음', () => {
    const ev = feed([
      assistant([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }]),
      user([{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Exit code 2\nboom' }]),
      assistant([{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }]),
      user([{ type: 'tool_result', tool_use_id: 'b', content: 'Command running in background with ID: bash_1' }]),
    ]);
    const ends = ofKind(ev, 'command_end');
    expect(ends[0]!.data).toMatchObject({ exitCode: 2, ok: false, command: 'npm test' });
    expect(ends[0]!.text).toContain('boom');
    expect(ends[1]!.data).toMatchObject({ exitCode: null, ok: true });
    expect(ofKind(ev, 'command_start')[1]!.text).toContain('백그라운드');
  });

  it('파일 도구 경로: Edit·MultiEdit·Write(file_path), NotebookEdit(notebook_path)', () => {
    const ev = feed([
      assistant([
        { type: 'tool_use', id: '1', name: 'Edit', input: { file_path: 'C:\\w\\a.ts' } },
        { type: 'tool_use', id: '2', name: 'MultiEdit', input: { file_path: 'C:\\w\\b.ts' } },
        { type: 'tool_use', id: '3', name: 'NotebookEdit', input: { notebook_path: 'C:\\w\\c.ipynb' } },
      ]),
    ]);
    expect(ev.map((e) => [e.kind, e.data?.paths])).toEqual([
      ['file_change', ['C:\\w\\a.ts']],
      ['file_change', ['C:\\w\\b.ts']],
      ['file_change', ['C:\\w\\c.ipynb']],
    ]);
  });

  it('앱 도구가 아닌 MCP 도구도 mcp_call (서버 구분)', () => {
    const [e] = feed([assistant([{ type: 'tool_use', id: 'm', name: 'mcp__context7__query-docs', input: {} }])]);
    expect(e).toMatchObject({ kind: 'mcp_call', data: { server: 'context7', tool: 'query-docs' } });
    expect(parseMcpToolName('mcp__wook__get_work_context', 'wook')).toEqual({ server: 'wook', tool: 'get_work_context' });
    expect(parseMcpToolName('Bash', 'wook')).toBeNull();
  });

  it('하위 에이전트 출력은 [하위] 표시', () => {
    const [e] = feed([assistant([{ type: 'text', text: '조사 결과' }], { parent_tool_use_id: 'toolu_x' })]);
    expect(e!.text).toBe('[하위] 조사 결과');
  });

  it('추론 토큰 추정치는 4천·8천…을 넘을 때만 남긴다', () => {
    const t = (n: number) => j({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n });
    expect(feed([t(50), t(3999), t(4200), t(6000), t(9000)]).map((e) => e.text)).toEqual(['추론 중 (약 4,200 토큰)', '추론 중 (약 9,000 토큰)']);
  });

  it('도구 진행 이벤트는 같은 도구에 60초마다 한 번', () => {
    const tp = (s: number) => j({ type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', elapsed_time_seconds: s });
    expect(feed([tp(1), tp(30), tp(61), tp(100), tp(125)])).toHaveLength(3);
  });

  it('승인 요청(control_request can_use_tool)이 오면 승인 대기로 바꾸지 않고 권한 오류', () => {
    const [e] = feed([j({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })]);
    expect(e).toMatchObject({ kind: 'error', data: { errorKind: 'permission' } });
  });

  it('API 재시도·대화 압축은 system', () => {
    const ev = feed([
      j({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' }),
      j({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } }),
    ]);
    expect(ev.map((e) => e.text)).toEqual(['API 재시도 1/10 (529 overloaded) · 2초 뒤', '대화 압축 (자동) · 이전 150,000 토큰']);
  });

  it('결과 없이 끝나면 finish가 알리고, 두 번 불러도 한 번만', () => {
    const p = newParser();
    p.pushLine(init());
    const first = p.finish(null);
    expect(first).toEqual([{ kind: 'system', text: '결과 이벤트 없이 끝났습니다 (종료 코드 없음)', data: { exitCode: null, isError: true }, raw: { type: 'finish', exitCode: null } }]);
    expect(p.finish(null)).toEqual([]);
  });

  it('stderr: 원문은 stderr로, 분류되는 문구는 오류도 하나 더', () => {
    const p = newParser();
    expect(p.pushStderr('')).toEqual([]);
    expect(p.pushStderr('some debug line').map((e) => e.kind)).toEqual(['stderr']);
    const ev = p.pushStderr('\u001b[31mNo conversation found with session ID: abc\u001b[0m');
    expect(ev.map((e) => e.kind)).toEqual(['stderr', 'error']);
    expect(ev[0]!.text).toBe('No conversation found with session ID: abc');
    expect(ev[1]!.data?.resumeFailed).toBe(true);
    // 같은 분류의 stderr가 또 와도 오류를 다시 내지 않는다
    expect(p.pushStderr('No conversation found with session ID: abc').map((e) => e.kind)).toEqual(['stderr']);
  });

  it('결과의 errorKind는 앞선 오류 메시지의 코드 기반 분류를 따른다 (문구만으로는 못 가르는 경우)', () => {
    const ev = feed([assistant([{ type: 'text', text: 'API Error: Request rejected' }], { error: 'rate_limit', is_api_error_message: true }), result({ is_error: true, result: 'API Error: Request rejected' })]);
    expect(ofKind(ev, 'error').map((e) => e.data?.errorKind)).toEqual(['usage_limit']);
    expect(ofKind(ev, 'result')[0]!.data?.errorKind).toBe('usage_limit');
  });

  it('문구로 못 가르는 결과 오류는 api_error_status 401→인증, 429→사용량 한도', () => {
    expect(ofKind(feed([result({ is_error: true, result: 'API Error', api_error_status: 401 })]), 'result')[0]!.data?.errorKind).toBe('auth');
    expect(ofKind(feed([result({ is_error: true, result: 'API Error', api_error_status: 429 })]), 'result')[0]!.data?.errorKind).toBe('usage_limit');
  });

  it('같은 미분류 오류가 연달아 두 번 알려지면 한 번만 오류로 센다', () => {
    const ev = feed([assistant([{ type: 'text', text: 'API Error: 500 Internal server error' }], { error: 'server_error' }), result({ is_error: true, result: 'API Error: 500 Internal server error' })]);
    expect(ofKind(ev, 'error')).toHaveLength(1);
    expect(ofKind(ev, 'result')[0]!.data).toMatchObject({ isError: true, errorKind: 'other' });
  });
});
