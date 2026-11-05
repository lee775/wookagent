import { describe, expect, it } from 'vitest';
import { createClaudeAdapter, createCodexAdapter, createParserFor, DEFAULT_APP_SERVER_NAME } from './index';

describe('공개 진입점', () => {
  it('createParserFor(format): 서버 이름을 안 주면 앱 도구 서버 "wook"', () => {
    expect(DEFAULT_APP_SERVER_NAME).toBe('wook');
    const claude = createParserFor('claude');
    expect(claude.pushLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__wook__set_steps', input: {} }] } }))[0]).toMatchObject({
      kind: 'mcp_call',
      text: '앱 도구 호출: set_steps',
    });
    const codex = createParserFor('codex', { serverName: 'wook' });
    expect(codex.pushLine(JSON.stringify({ type: 'item.started', item: { id: 'i', type: 'mcp_tool_call', server: 'wook', tool: 'set_steps', arguments: {}, status: 'in_progress' } }))[0]).toMatchObject({
      kind: 'mcp_call',
      text: '앱 도구 호출: set_steps',
    });
  });

  it('어댑터 종류', () => {
    expect(createClaudeAdapter().kind).toBe('claude');
    expect(createCodexAdapter().kind).toBe('codex');
  });
});
