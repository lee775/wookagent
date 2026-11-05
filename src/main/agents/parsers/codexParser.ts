/**
 * Codex `exec --json` JSONL 해석 (codex-cli 0.163 실제 출력 기준, __fixtures__/codex-*.jsonl).
 * 줄 형식: thread.started{thread_id} / turn.started / item.started|item.updated|item.completed{item} /
 *         turn.completed{usage} / turn.failed{error} / error{message}
 * Codex는 바이패스 적용 여부를 이벤트로 알리지 않는다 → session 이벤트에 permissionMode를 넣지 않는다 (CLI-21).
 */
import type { ParsedCliEvent } from '@shared/events';
import type { EventParser } from '../types';
import { isPermissionPromptText, isTransientRetryText } from './classify';
import { ErrorTracker, arr, firstLine, fmtTokens, isRecord, num, oneLine, parseJsonLine, str, stripAnsi, type ParserOptions } from './util';

const CHANGE_KIND: Record<string, string> = { add: '추가', delete: '삭제', update: '수정' };
/** codex tracing 로그 줄: "2026-10-27T07:53:21.403257Z ERROR codex_api::endpoint::…" */
const TRACING_LINE = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\b/;

export function createCodexParser(opts: ParserOptions): EventParser {
  const errors = new ErrorTracker(opts);
  const started = new Set<string>();
  const todoText = new Map<string, string>();
  let lastAgentText: string | null = null;
  let declined = 0;
  let resultSeen = false;
  let finished = false;

  return {
    pushLine(line: string): ParsedCliEvent[] {
      if (line.trim() === '') return [];
      const parsed = parseJsonLine(line);
      if (!parsed.ok) return unparsed(line);
      const obj = parsed.value;
      const type = str(obj.type) ?? '';
      try {
        return handle(type, obj);
      } catch (e) {
        return [{ kind: 'system', text: `이벤트 해석 실패 (${type}): ${e instanceof Error ? e.message : String(e)}`, raw: obj }];
      }
    },
    pushStderr(line: string): ParsedCliEvent[] {
      const t = stripAnsi(line).replace(/\r$/, '');
      if (t.trim() === '') return [];
      const ev: ParsedCliEvent = { kind: 'stderr', text: t, raw: line };
      // stderr는 codex 내부 로그다 ("<시각> ERROR codex_api::…: 401 Unauthorized"). 재시도 중 로그라 토큰 갱신으로 회복될 수 있다 →
      // 분류하지 않고, 판정은 JSON의 최상위 error·turn.failed로 한다. JSON 출력 전에 죽을 때의 "Error: …" 줄만 분류한다
      if (TRACING_LINE.test(t) || /^\s*warning:/i.test(t)) return [ev];
      return [ev, ...errors.ifClassified(t, line, { dropRepeat: true })];
    },
    finish(exitCode: number | null): ParsedCliEvent[] {
      if (finished) return [];
      finished = true;
      if (resultSeen) return [];
      return [{ kind: 'system', text: `결과 이벤트 없이 끝났습니다 (종료 코드 ${exitCode ?? '없음'})`, data: { exitCode, isError: true }, raw: { type: 'finish', exitCode } }];
    },
  };

  function unparsed(line: string): ParsedCliEvent[] {
    const t = stripAnsi(line).trim();
    const classified = errors.ifClassified(t, line);
    if (classified.length > 0) return classified;
    return [{ kind: 'system', text: `해석하지 못한 출력: ${oneLine(t, 500)}`, raw: line }];
  }

  function handle(type: string, o: Record<string, unknown>): ParsedCliEvent[] {
    switch (type) {
      case 'thread.started': {
        const id = str(o.thread_id);
        return [{ kind: 'session', text: `세션 시작${id ? ` · thread ${id}` : ''} · 바이패스 옵션 전달 (CLI 확인 없음)`, data: id ? { cliSessionId: id } : {}, raw: o }];
      }
      case 'turn.started':
        return [{ kind: 'system', text: '턴 시작', raw: o }];
      case 'turn.completed':
        return onTurnCompleted(o);
      case 'turn.failed': {
        resultSeen = true;
        const err = isRecord(o.error) ? o.error : {};
        const msg = str(err.message) ?? str(o.message) ?? '턴 실패';
        const cls = errors.classifyLike(msg);
        const out = errors.forced(msg, o, cls);
        const data: NonNullable<ParsedCliEvent['data']> = { isError: true, errorKind: cls.kind, permissionDenials: declined };
        if (cls.resetAt) data.resetAt = cls.resetAt;
        if (cls.resumeFailed) data.resumeFailed = true;
        out.push({ kind: 'result', text: msg, data, raw: o });
        return out;
      }
      case 'error': {
        const msg = str(o.message) ?? '';
        if (isTransientRetryText(msg)) return [{ kind: 'system', text: `재연결 중: ${oneLine(msg, 300)}`, raw: o }];
        return errors.event(msg || '오류 (내용 없음)', o);
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = isRecord(o.item) ? o.item : null;
        if (!item) return [{ kind: 'system', text: `항목 없는 ${type}`, raw: o }];
        return onItem(type.slice('item.'.length) as 'started' | 'updated' | 'completed', item, o);
      }
      default:
        return [{ kind: 'system', text: `알 수 없는 이벤트: ${type || '(type 없음)'}`, raw: o }];
    }
  }

  function onTurnCompleted(o: Record<string, unknown>): ParsedCliEvent[] {
    resultSeen = true;
    const out: ParsedCliEvent[] = [];
    const u = isRecord(o.usage) ? o.usage : null;
    if (u) {
      const input = num(u.input_tokens);
      const cached = num(u.cached_input_tokens);
      const output = num(u.output_tokens);
      const reasoning = num(u.reasoning_output_tokens);
      const data: NonNullable<ParsedCliEvent['data']> = {};
      if (input !== undefined) data.inputTokens = input;
      if (output !== undefined) data.outputTokens = output;
      if (cached !== undefined) data.cachedInputTokens = cached;
      out.push({ kind: 'usage', text: `사용량 · 입력 ${fmtTokens(input)}${cached !== undefined ? ` (캐시 ${fmtTokens(cached)})` : ''} · 출력 ${fmtTokens(output)}${reasoning ? ` (추론 ${fmtTokens(reasoning)})` : ''}`, data, raw: o });
    }
    if (declined > 0 && !errors.has('permission')) out.push(...errors.forced(`실행 권한 확인 ${declined}건이 거부되었습니다`, o, { kind: 'permission' }));
    out.push({ kind: 'result', text: lastAgentText ?? '', data: { isError: false, permissionDenials: declined }, raw: o });
    return out;
  }

  function onItem(phase: 'started' | 'updated' | 'completed', item: Record<string, unknown>, raw: Record<string, unknown>): ParsedCliEvent[] {
    const id = str(item.id) ?? '';
    const type = str(item.type) ?? '';
    const status = str(item.status);
    switch (type) {
      case 'agent_message': {
        if (phase !== 'completed') return [];
        const text = str(item.text) ?? '';
        lastAgentText = text;
        return text.trim() ? [{ kind: 'text', text, raw }] : [];
      }
      case 'reasoning': {
        if (phase !== 'completed') return [];
        const text = str(item.text) ?? '';
        return text.trim() ? [{ kind: 'thinking', text, raw }] : [];
      }
      case 'command_execution': {
        const command = str(item.command) ?? '';
        if (phase === 'started') {
          started.add(id);
          return [{ kind: 'command_start', text: `$ ${oneLine(shellInner(command), 300)}`, data: { tool: 'shell', callId: id, command }, raw }];
        }
        if (phase === 'updated') return [];
        const out: ParsedCliEvent[] = [];
        if (!started.delete(id)) out.push({ kind: 'command_start', text: `$ ${oneLine(shellInner(command), 300)}`, data: { tool: 'shell', callId: id, command }, raw });
        const exitCode = num(item.exit_code) ?? null;
        const output = str(item.aggregated_output) ?? '';
        if (status === 'declined') {
          declined++;
          out.push(...errors.forced(`명령 실행이 승인 단계에서 거부되었습니다: ${oneLine(shellInner(command), 200)}`, raw, { kind: 'permission' }));
        }
        const ok = status === 'completed' && (exitCode === null || exitCode === 0);
        const label = ok ? `명령 완료 (종료 코드 ${exitCode ?? 0})` : `명령 실패${exitCode !== null ? ` (종료 코드 ${exitCode})` : status ? ` (${status})` : ''}${output ? `: ${firstLine(output, 200)}` : ''}`;
        out.push({ kind: 'command_end', text: label, data: { tool: 'shell', callId: id, command, exitCode, ok }, raw });
        return out;
      }
      case 'file_change': {
        if (phase !== 'completed') return [];
        const changes = arr(item.changes).filter(isRecord);
        const paths = changes.map((c) => str(c.path)).filter((p): p is string => !!p);
        const out: ParsedCliEvent[] = [];
        if (status === 'declined') {
          declined++;
          out.push(...errors.forced(`파일 변경이 승인 단계에서 거부되었습니다: ${paths.join(', ')}`, raw, { kind: 'permission' }));
        }
        const list = changes.map((c) => `${str(c.path) ?? '?'} (${CHANGE_KIND[str(c.kind) ?? ''] ?? str(c.kind) ?? '변경'})`).join(', ');
        out.push({ kind: 'file_change', text: `파일 변경: ${list || '(경로 없음)'}${status && status !== 'completed' ? ` — ${status === 'failed' ? '실패' : status}` : ''}`, data: { tool: 'apply_patch', callId: id, paths, ok: status === 'completed' }, raw });
        return out;
      }
      case 'mcp_tool_call': {
        const server = str(item.server) ?? '?';
        const tool = str(item.tool) ?? '?';
        const callLabel = server === opts.serverName ? `앱 도구 호출: ${tool}` : `MCP 도구 호출: ${server}/${tool}`;
        if (phase === 'started') {
          started.add(id);
          return [{ kind: 'mcp_call', text: callLabel, data: { tool, server, callId: id }, raw }];
        }
        if (phase === 'updated') return [];
        const out: ParsedCliEvent[] = [];
        if (!started.delete(id)) out.push({ kind: 'mcp_call', text: callLabel, data: { tool, server, callId: id }, raw });
        const errMsg = isRecord(item.error) ? (str(item.error.message) ?? '') : (str(item.error) ?? '');
        const ok = status === 'completed' && !errMsg;
        if (status === 'declined' || (errMsg && isPermissionPromptText(errMsg))) {
          declined++;
          out.push(...errors.forced(`앱 도구 호출이 승인 단계에서 거부되었습니다: ${tool}${errMsg ? ` (${errMsg})` : ''}`, raw, { kind: 'permission' }));
        }
        const resultText = mcpResultText(item.result);
        const label = server === opts.serverName ? `앱 도구 ${tool}` : `MCP ${server}/${tool}`;
        const detail = errMsg || resultText;
        out.push({ kind: 'tool_result', text: `${label} ${ok ? '결과' : '실패'}${detail ? `: ${oneLine(detail, 300)}` : ''}`, data: { tool, server, callId: id, ok }, raw });
        return out;
      }
      case 'collab_tool_call': {
        const tool = str(item.tool) ?? '하위 에이전트';
        const prompt = str(item.prompt);
        if (phase === 'started') {
          started.add(id);
          return [{ kind: 'tool_call', text: `하위 에이전트 ${tool}${prompt ? `: ${oneLine(prompt, 120)}` : ''}`, data: { tool, callId: id }, raw }];
        }
        if (phase === 'updated') return [];
        const out: ParsedCliEvent[] = [];
        if (!started.delete(id)) out.push({ kind: 'tool_call', text: `하위 에이전트 ${tool}${prompt ? `: ${oneLine(prompt, 120)}` : ''}`, data: { tool, callId: id }, raw });
        out.push({ kind: 'tool_result', text: `하위 에이전트 ${tool} ${status === 'failed' ? '실패' : '완료'}`, data: { tool, callId: id, ok: status !== 'failed' }, raw });
        return out;
      }
      case 'web_search': {
        const query = str(item.query) ?? '';
        if (phase === 'started') {
          started.add(id);
          return [{ kind: 'tool_call', text: `웹 검색${query ? `: ${oneLine(query, 200)}` : ''}`, data: { tool: 'web_search', callId: id }, raw }];
        }
        if (phase === 'updated') return [];
        const out: ParsedCliEvent[] = [];
        if (!started.delete(id)) out.push({ kind: 'tool_call', text: `웹 검색${query ? `: ${oneLine(query, 200)}` : ''}`, data: { tool: 'web_search', callId: id }, raw });
        out.push({ kind: 'tool_result', text: `웹 검색 완료${query ? `: ${oneLine(query, 200)}` : ''}`, data: { tool: 'web_search', callId: id, ok: status !== 'failed' }, raw });
        return out;
      }
      case 'todo_list': {
        const items = arr(item.items).filter(isRecord);
        const done = items.filter((t) => t.completed === true).length;
        const text = `할 일 목록 ${done}/${items.length} 완료${items.length ? `: ${items.map((t) => `${t.completed === true ? '✓' : '·'} ${oneLine(str(t.text) ?? '', 60)}`).join(' / ')}` : ''}`;
        if (todoText.get(id) === text) return [];
        todoText.set(id, text);
        return [{ kind: 'tool_call', text: oneLine(text, 500), data: { tool: 'todo_list', callId: id }, raw }];
      }
      case 'error': {
        // 항목 오류는 턴을 끝내지 않는 경고다 (예: 훅 시간 제한 조정, "Falling back from WebSockets to HTTPS").
        // 매 턴 반복되므로 'error'로 내면 헛돌기(같은 오류 5회)로 잘못 판정된다. 치명 오류는 최상위 error + turn.failed로 온다
        const msg = str(item.message) ?? '(내용 없음)';
        return [{ kind: 'system', text: `경고: ${oneLine(msg, 500)}`, raw }];
      }
      default:
        return [{ kind: 'system', text: `알 수 없는 항목: ${type || '(type 없음)'} (${phase})`, raw }];
    }
  }
}

/**
 * 표시용: Windows codex는 명령을 셸 호출째로 준다
 * ("C:\...\powershell.exe" -Command 'echo hi' → echo hi). data.command에는 원문을 둔다
 */
export function shellInner(command: string): string {
  // 첫 토큰(따옴표로 감싼 경로 포함)이 셸 실행 파일일 때만 벗긴다
  const shell = (names: string) => `^\\s*(?:"[^"]*[\\\\/](?:${names})(?:\\.exe)?"|(?:[^\\s"]*[\\\\/])?(?:${names})(?:\\.exe)?)\\s+`;
  const m =
    new RegExp(`${shell('powershell|pwsh')}(?:-NoProfile\\s+|-NoLogo\\s+|-NonInteractive\\s+)*-Command\\s+([\\s\\S]+)$`, 'i').exec(command) ??
    new RegExp(`${shell('bash|zsh|sh')}-l?c\\s+([\\s\\S]+)$`, 'i').exec(command) ??
    new RegExp(`${shell('cmd')}\\/[cC]\\s+([\\s\\S]+)$`, 'i').exec(command);
  if (!m) return command;
  const body = m[1]!.trim();
  if (body.length >= 2 && ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"')))) return body.slice(1, -1);
  return body;
}

function mcpResultText(result: unknown): string {
  if (!isRecord(result)) return typeof result === 'string' ? result : '';
  const parts = arr(result.content)
    .map((b) => (isRecord(b) ? (str(b.text) ?? '') : ''))
    .filter((s) => s !== '');
  if (parts.length > 0) return parts.join('\n');
  const sc = result.structured_content ?? result.structuredContent;
  if (sc !== undefined && sc !== null) {
    try {
      return JSON.stringify(sc);
    } catch {
      return '';
    }
  }
  return '';
}
