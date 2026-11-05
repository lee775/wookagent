import { describe, expect, it } from 'vitest';
import type { ParsedCliEvent } from '@shared/events';
import { fixtureLines, ofKind, replay } from '../__fixtures__/replay';
import { createCodexParser, shellInner } from './codexParser';

const NOW = new Date('2026-10-27T03:00:00.000Z'); // 12:00 KST
const newParser = () => createCodexParser({ serverName: 'wook', now: () => NOW, timeZone: 'Asia/Seoul' });
const j = (o: unknown) => JSON.stringify(o);
const item = (phase: 'started' | 'updated' | 'completed', it: Record<string, unknown>) => j({ type: `item.${phase}`, item: it });

function feed(lines: string[]): ParsedCliEvent[] {
  const p = newParser();
  return lines.flatMap((l) => p.pushLine(l));
}

describe('Codex 실제 출력 (codex-cli 0.163)', () => {
  it('첫 턴: thread.started의 thread_id, 개발자 지침이 적용된 답, turn.completed 사용량', () => {
    const ev = replay(newParser(), 'codex-first');
    expect(ofKind(ev, 'session')[0]!.data).toEqual({ cliSessionId: '01a17c5f-3171-75a0-b0c0-ef0b38838ec1' });
    // 바이패스 적용은 보고하지 않는다 → permissionMode 없음 (bypass='requested')
    expect(ofKind(ev, 'session')[0]!.data?.permissionMode).toBeUndefined();
    // 훅 설정 경고(item.type=error)는 경고일 뿐 오류가 아니다
    expect(ofKind(ev, 'error')).toEqual([]);
    expect(ev.some((e) => e.kind === 'system' && e.text.startsWith('경고: clamping SessionEnd hook timeout'))).toBe(true);
    expect(ofKind(ev, 'result')[0]).toMatchObject({ text: 'WOOK-DEV-7731', data: { isError: false, permissionDenials: 0 } });
    expect(ofKind(ev, 'usage')[0]!.data).toEqual({ inputTokens: 20543, outputTokens: 11, cachedInputTokens: 12928 });
    expect(ev.every((e) => e.raw !== undefined)).toBe(true);
  });

  it('이어하기: 같은 thread, 앱 도구(mcp_tool_call)·명령(command_execution)·파일 변경(file_change)', () => {
    const ev = replay(newParser(), 'codex-resume-tools');
    expect(ofKind(ev, 'session')[0]!.data?.cliSessionId).toBe('01a17c5f-3171-75a0-b0c0-ef0b38838ec1');

    const [mcp] = ofKind(ev, 'mcp_call');
    expect(mcp!.data).toEqual({ tool: 'ping', server: 'wook', callId: 'item_2' });
    const mcpResult = ev.find((e) => e.kind === 'tool_result' && e.data?.callId === 'item_2');
    expect(mcpResult!.data).toEqual({ tool: 'ping', server: 'wook', callId: 'item_2', ok: true });
    expect(mcpResult!.text).toBe('앱 도구 ping 결과: pong: 한글 hello');

    const starts = ofKind(ev, 'command_start');
    const ends = ofKind(ev, 'command_end');
    // Windows codex는 명령을 powershell 호출째로 준다 → 표시는 안쪽 명령, data.command는 원문
    expect(starts[0]!.text).toBe('$ echo wook-cmd');
    expect(starts[0]!.data?.command).toContain('powershell.exe" -Command');
    expect(ends[0]!.data).toMatchObject({ callId: 'item_3', exitCode: 0, ok: true });
    expect(starts).toHaveLength(ends.length);
    const failed = ends.find((e) => e.data?.callId === 'item_7');
    expect(failed!.data).toMatchObject({ exitCode: 1, ok: false });

    const [file] = ofKind(ev, 'file_change');
    expect(file!.data).toEqual({ tool: 'apply_patch', callId: 'item_4', paths: ['<TMP>\\작업 폴더 repo\\note-codex.txt'], ok: true });
    expect(file!.text).toBe('파일 변경: <TMP>\\작업 폴더 repo\\note-codex.txt (추가)');

    expect(ofKind(ev, 'result')[0]).toMatchObject({ text: 'DONE', data: { isError: false } });
    expect(ofKind(ev, 'error')).toEqual([]);
  });

  it('로그인 없음: 재연결 안내·WebSocket 전환 경고·stderr 로그는 오류로 세지 않고, 마지막 오류만 인증 오류 1회', () => {
    const ev = replay(newParser(), 'codex-not-logged-in');
    const errors = ofKind(ev, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data).toEqual({ errorKind: 'auth' });
    expect(errors[0]!.text).toMatch(/^인증 필요: unexpected status 401 Unauthorized/);
    const reconnects = fixtureLines('codex-not-logged-in').stdout.filter((l) => l.includes('"message":"Reconnecting...')).length;
    expect(reconnects).toBe(9);
    expect(ev.filter((e) => e.kind === 'system' && e.text.startsWith('재연결 중'))).toHaveLength(reconnects);
    expect(ofKind(ev, 'result')[0]!.data).toMatchObject({ isError: true, errorKind: 'auth' });
    // stderr의 tracing 로그(… ERROR codex_api … 401)는 원문만 남긴다
    expect(ofKind(ev, 'stderr').length).toBe(fixtureLines('codex-not-logged-in').stderr.length);
  });

  it('없는 thread 이어하기: stdout 없이 stderr "no rollout found" → resumeFailed, 결과 없음 안내', () => {
    const ev = replay(newParser(), 'codex-resume-missing');
    expect(ofKind(ev, 'error')[0]!.data).toEqual({ errorKind: 'other', resumeFailed: true });
    expect(ev.at(-1)).toMatchObject({ kind: 'system', data: { exitCode: 1, isError: true } });
  });

  it('필수 앱 도구 서버에 닿지 않으면 시작 단계에서 실패: stderr "Error: thread/start …" → mcp 오류 1회', () => {
    const ev = replay(newParser(), 'codex-mcp-unreachable');
    expect(ofKind(ev, 'session')).toEqual([]);
    const errors = ofKind(ev, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data).toEqual({ errorKind: 'mcp' });
    expect(errors[0]!.text).toContain('required MCP servers failed to initialize: wook');
    expect(ev.at(-1)).toMatchObject({ kind: 'system', data: { exitCode: 1, isError: true } });
  });

  it('어떤 줄을 반쯤 잘라도 던지지 않고 원문을 보존한다', () => {
    for (const name of ['codex-first', 'codex-resume-tools', 'codex-not-logged-in']) {
      const p = newParser();
      for (const l of fixtureLines(name).stdout) {
        const ev = p.pushLine(l.slice(0, Math.floor(l.length / 2)));
        expect(ev.length).toBeGreaterThan(0);
        expect(ev.every((e) => e.raw !== undefined)).toBe(true);
      }
    }
  });
});

/**
 * 같은 시험을 격리 옵션(--ignore-user-config --disable hooks --disable apps)으로 다시 받은 출력 (2026-10-27 저녁, windows:F1).
 * 격리 전 출력(위 codex-first·codex-resume-tools)과 달리 대표의 훅 경고가 없고, 개인 전역 지침을 따라 작업 폴더 밖 파일을 다루는 명령도 없다.
 */
describe('Codex 격리 실행 (codex-cli 0.163, 개인 설정·훅·연결 서버 끔)', () => {
  const hookWarning = (ev: ParsedCliEvent[]) => ev.filter((e) => /hook/i.test(e.text));
  const outsideMarker = '<가림: 시험 턴이 개인 전역 지침을 따라 작업 폴더 밖 파일을 다룬 명령>';

  it('첫 턴: 훅 경고 없이 지침대로 답하고 끝난다 (격리 전에는 훅 경고가 있었다)', () => {
    const before = replay(newParser(), 'codex-first');
    expect(hookWarning(before).length).toBeGreaterThan(0);
    const ev = replay(newParser(), 'codex-first-isolated');
    expect(hookWarning(ev)).toEqual([]);
    expect(ofKind(ev, 'error')).toEqual([]);
    expect(ofKind(ev, 'session')[0]!.data?.cliSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ofKind(ev, 'result')[0]).toMatchObject({ text: 'WOOK-DEV-7731', data: { isError: false } });
  });

  it('이어하기: 앱 도구는 wook만, 명령·파일 변경은 작업 폴더 안에서만 (격리 전에는 작업 폴더 밖 명령 4개가 있었다)', () => {
    const before = fixtureLines('codex-resume-tools').stdout;
    expect(before.filter((l) => l.includes(outsideMarker)).length).toBeGreaterThan(0);
    const lines = fixtureLines('codex-resume-tools-isolated').stdout;
    expect(lines.some((l) => l.includes('<가림'))).toBe(false);
    const ev = replay(newParser(), 'codex-resume-tools-isolated');
    expect(hookWarning(ev)).toEqual([]);
    expect(ofKind(ev, 'error')).toEqual([]);
    const servers = new Set(ofKind(ev, 'mcp_call').map((e) => e.data?.server));
    expect([...servers]).toEqual(['wook']);
    const ends = ofKind(ev, 'command_end');
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.every((e) => e.data?.ok === true)).toBe(true);
    const files = ofKind(ev, 'file_change').flatMap((e) => (e.data?.paths as string[] | undefined) ?? []);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((p) => p.startsWith('<TMP>\\작업 폴더 repo\\'))).toBe(true);
    expect(ofKind(ev, 'result')[0]).toMatchObject({ text: 'DONE', data: { isError: false } });
  });
});

describe('Codex 합성 경계 사례', () => {
  it('사용량 한도: error + turn.failed → 해제 시각이 든 오류 1회, 결과에도 errorKind·resetAt', () => {
    const msg = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:15 PM.';
    const ev = feed([j({ type: 'thread.started', thread_id: 't1' }), j({ type: 'turn.started' }), j({ type: 'error', message: msg }), j({ type: 'turn.failed', error: { message: msg } })]);
    const errors = ofKind(ev, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data).toEqual({ errorKind: 'usage_limit', resetAt: '2026-10-27T06:15:00.000Z' });
    expect(ofKind(ev, 'result')[0]!.data).toEqual({ isError: true, errorKind: 'usage_limit', resetAt: '2026-10-27T06:15:00.000Z', permissionDenials: 0 });
  });

  it('401·Unauthorized는 인증 만료', () => {
    const ev = feed([j({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Provided authentication token is expired. Please try signing in again.' } })]);
    expect(ofKind(ev, 'error')[0]!.data).toEqual({ errorKind: 'auth' });
  });

  it('필수 앱 도구 서버(required=true) 연결 실패는 mcp 오류', () => {
    const ev = feed([j({ type: 'error', message: 'required MCP servers failed to initialize: wook: handshaking with MCP server failed: 401 Unauthorized' })]);
    expect(ofKind(ev, 'error')[0]!.data).toEqual({ errorKind: 'mcp' });
  });

  it('명령·파일 변경이 승인 단계에서 거부(declined)되면 즉시 권한 오류 + 결과의 거부 건수', () => {
    const ev = feed([
      item('started', { id: 'c1', type: 'command_execution', command: 'rm -rf build', aggregated_output: '', exit_code: null, status: 'in_progress' }),
      item('completed', { id: 'c1', type: 'command_execution', command: 'rm -rf build', aggregated_output: '', exit_code: null, status: 'declined' }),
      item('completed', { id: 'f1', type: 'file_change', changes: [{ path: 'a.txt', kind: 'update' }], status: 'declined' }),
      j({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }),
    ]);
    expect(ofKind(ev, 'error').map((e) => e.data?.errorKind)).toEqual(['permission']);
    expect(ofKind(ev, 'command_end')[0]!.data).toMatchObject({ ok: false, exitCode: null });
    expect(ofKind(ev, 'result')[0]!.data).toEqual({ isError: false, permissionDenials: 2 });
  });

  it('item.started 없이 completed만 와도 시작·끝을 모두 낸다', () => {
    const ev = feed([item('completed', { id: 'c9', type: 'command_execution', command: 'git status', aggregated_output: 'clean', exit_code: 0, status: 'completed' })]);
    expect(ev.map((e) => e.kind)).toEqual(['command_start', 'command_end']);
    const ev2 = feed([item('completed', { id: 'm9', type: 'mcp_tool_call', server: 'wook', tool: 'complete_step', arguments: {}, result: null, error: { message: '작업 상태가 맞지 않습니다' }, status: 'failed' })]);
    expect(ev2.map((e) => [e.kind, e.data?.ok])).toEqual([
      ['mcp_call', undefined],
      ['tool_result', false],
    ]);
    expect(ev2[1]!.text).toBe('앱 도구 complete_step 실패: 작업 상태가 맞지 않습니다');
  });

  it('명령 실패 요약은 종료 코드와 출력 첫 줄', () => {
    const [, end] = feed([
      item('started', { id: 'c2', type: 'command_execution', command: '/bin/bash -lc "npm test"', status: 'in_progress' }),
      item('completed', { id: 'c2', type: 'command_execution', command: '/bin/bash -lc "npm test"', aggregated_output: '\nFAIL src/a.test.ts\n2 failed', exit_code: 1, status: 'failed' }),
    ]);
    expect(end).toMatchObject({ kind: 'command_end', text: '명령 실패 (종료 코드 1): FAIL src/a.test.ts', data: { exitCode: 1, ok: false } });
  });

  it('할 일 목록은 바뀔 때만, 웹 검색은 호출·결과, 하위 에이전트는 tool_call', () => {
    const todo = (done: boolean) => ({ id: 'td', type: 'todo_list', items: [{ text: '분석', completed: true }, { text: '구현', completed: done }] });
    const ev = feed([
      item('started', todo(false)),
      item('updated', todo(false)),
      item('updated', todo(true)),
      item('completed', todo(true)),
      item('started', { id: 'w', type: 'web_search', query: 'codex exec json' }),
      item('completed', { id: 'w', type: 'web_search', query: 'codex exec json' }),
      item('started', { id: 'k', type: 'collab_tool_call', tool: 'spawn_agent', prompt: '테스트 작성', status: 'in_progress' }),
      item('completed', { id: 'k', type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed' }),
    ]);
    expect(ev.map((e) => e.text)).toEqual([
      '할 일 목록 1/2 완료: ✓ 분석 / · 구현',
      '할 일 목록 2/2 완료: ✓ 분석 / ✓ 구현',
      '웹 검색: codex exec json',
      '웹 검색 완료: codex exec json',
      '하위 에이전트 spawn_agent: 테스트 작성',
      '하위 에이전트 spawn_agent 완료',
    ]);
  });

  it('agent_message·reasoning은 completed에서만, 결과 문구는 마지막 agent_message', () => {
    const ev = feed([
      item('started', { id: 'a', type: 'agent_message', text: '' }),
      item('completed', { id: 'r', type: 'reasoning', text: '**계획**' }),
      item('completed', { id: 'a', type: 'agent_message', text: '첫 답' }),
      item('completed', { id: 'b', type: 'agent_message', text: '최종 답' }),
      j({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 } }),
    ]);
    expect(ev.map((e) => e.kind)).toEqual(['thinking', 'text', 'text', 'usage', 'result']);
    expect(ofKind(ev, 'result')[0]!.text).toBe('최종 답');
    expect(ofKind(ev, 'usage')[0]!.text).toBe('사용량 · 입력 5 (캐시 1) · 출력 2 (추론 1)');
  });

  it('알 수 없는 이벤트·항목·깨진 줄은 system으로 원문 보존', () => {
    const ev = feed(['{"type":"thread.archived"}', item('completed', { id: 'x', type: 'hologram' }), 'garbage', '{"type":"item.completed"}']);
    expect(ev.map((e) => e.kind)).toEqual(['system', 'system', 'system', 'system']);
    expect(ev[2]!.raw).toBe('garbage');
  });

  it('stderr: tracing 로그·WARNING은 분류하지 않고, "Error:" 줄은 분류', () => {
    const p = newParser();
    expect(p.pushStderr('2026-10-27T07:53:21.403257Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized').map((e) => e.kind)).toEqual(['stderr']);
    expect(p.pushStderr('WARNING: proceeding, even though we could not create PATH aliases').map((e) => e.kind)).toEqual(['stderr']);
    expect(p.pushStderr('Error: Not logged in').map((e) => e.kind)).toEqual(['stderr', 'error']);
  });

  it('finish: turn.completed가 있으면 아무것도 내지 않는다', () => {
    const p = newParser();
    p.pushLine(j({ type: 'turn.completed', usage: {} }));
    expect(p.finish(0)).toEqual([]);
  });

  it.each([
    [`"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command 'echo wook-cmd'`, 'echo wook-cmd'],
    ['"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem -Force"', 'Get-ChildItem -Force'],
    ['pwsh -NoProfile -Command Get-Date', 'Get-Date'],
    ["/bin/bash -lc 'ls -la'", 'ls -la'],
    ['bash -lc "npm test"', 'npm test'],
    ['cmd.exe /c dir', 'dir'],
    ['echo powershell -Command x', 'echo powershell -Command x'],
    ['git status', 'git status'],
  ])('shellInner(%s)', (input, expected) => {
    expect(shellInner(input)).toBe(expected);
  });
});
