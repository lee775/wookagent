/**
 * Claude Code `-p --output-format stream-json --verbose` 해석 (2.1.x 실제 출력 기준, __fixtures__/claude-*.jsonl).
 * 줄 형식: {"type":"system","subtype":"init"|...} / {"type":"assistant","message":{content:[...]}} /
 *         {"type":"user","message":{content:[tool_result...]}} / {"type":"rate_limit_event"} / {"type":"result"}
 * 한 줄이 이벤트 여러 개가 되면 모두 같은 원본(raw)을 가진다.
 */
import type { ParsedCliEvent } from '@shared/events';
import type { EventParser } from '../types';
import { isPermissionPromptText } from './classify';
import { ErrorTracker, arr, epochSecondsToIso, firstLine, fmtTokens, isRecord, num, oneLine, parseJsonLine, str, stripAnsi, type ParserOptions } from './util';

type ToolCategory = 'command' | 'file' | 'mcp' | 'other';
interface ToolInfo {
  name: string;
  category: ToolCategory;
  command?: string;
  paths?: string[];
  server?: string;
  tool?: string;
  background?: boolean;
}

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS: Record<string, string> = { Edit: '수정', MultiEdit: '수정', Write: '작성', NotebookEdit: '노트북 수정' };
const LIMIT_NAME: Record<string, string> = {
  five_hour: '5시간 한도',
  seven_day: '주간 한도',
  seven_day_opus: 'Opus 주간 한도',
  seven_day_sonnet: 'Sonnet 주간 한도',
  // CLI가 'Fable limit'이라고 부르는 Fable 모델의 주간 한도 (리드 결정 29)
  seven_day_overage_included: 'Fable 주간 한도',
  overage: '추가 사용 한도',
};
/** 도구 진행 이벤트는 같은 도구에 대해 이 간격(초)마다 한 번만 남긴다 */
const PROGRESS_EVERY_SEC = 60;

export function createClaudeParser(opts: ParserOptions): EventParser {
  const tools = new Map<string, ToolInfo>();
  const progressAt = new Map<string, number>();
  const errors = new ErrorTracker(opts);
  let resultSeen = false;
  let finished = false;
  let rateLimitResetAt: string | undefined;
  /** 거부된 rate_limit_event의 한도 종류 (seven_day_opus 등) — 결과 이벤트의 사용량 한도에도 싣는다 (리드 결정 22) */
  let rateLimitType: string | undefined;
  let thinkingNext = 4000;
  /**
   * 응답 메시지마다 실린 사용량 (메시지 ID → 그 호출의 입력·캐시·출력). Claude는 턴 전체 사용량·비용을 result에만 싣는다 — result 없이 끝난 턴
   * (질문 뒤 끝내지 않아 프로그램이 끊음·비정상 종료)은 이 부분 집계를 남긴다 (CLI-02 사용량 갱신). 같은 메시지가 내용 블록마다 따로 오면 같은
   * 사용량이 되풀이되므로 메시지 ID로 한 번만 센다. 출력 수는 메시지 시작 때의 값이라 실제보다 적을 수 있다(하한)
   */
  const partialUsage = new Map<string, { input: number; cached: number; output: number }>();

  const handlers: Record<string, (o: Record<string, unknown>) => ParsedCliEvent[]> = {
    system: onSystem,
    assistant: onAssistant,
    user: onUser,
    result: onResult,
    rate_limit_event: onRateLimit,
    tool_progress: onToolProgress,
    auth_status: onAuthStatus,
    control_request: onControlRequest,
    // 부분 메시지(--include-partial-messages)는 요청하지 않는다. 와도 완성 메시지가 따로 오므로 버린다
    stream_event: () => [],
    keep_alive: () => [],
  };

  return {
    pushLine(line: string): ParsedCliEvent[] {
      if (line.trim() === '') return [];
      const parsed = parseJsonLine(line);
      if (!parsed.ok) return unparsed(line);
      const obj = parsed.value;
      const type = str(obj.type) ?? '';
      try {
        const h = handlers[type];
        if (h) return h(obj);
        return [{ kind: 'system', text: `알 수 없는 이벤트: ${type || '(type 없음)'}`, raw: obj }];
      } catch (e) {
        return [{ kind: 'system', text: `이벤트 해석 실패 (${type}): ${e instanceof Error ? e.message : String(e)}`, raw: obj }];
      }
    },
    pushStderr(line: string): ParsedCliEvent[] {
      const t = stripAnsi(line).replace(/\r$/, '');
      if (t.trim() === '') return [];
      return [{ kind: 'stderr', text: t, raw: line }, ...errors.ifClassified(t, line, { fallbackResetAt: rateLimitResetAt, dropRepeat: true })];
    },
    finish(exitCode: number | null): ParsedCliEvent[] {
      if (finished) return [];
      finished = true;
      if (resultSeen) return [];
      const out: ParsedCliEvent[] = [];
      // 턴 전체 사용량(result)이 없으면 응답 메시지마다 실린 사용량의 합을 남긴다 — 비용은 알 수 없다. 끝 알림(아래 system)이 마지막 이벤트로 남게 앞에 둔다
      if (partialUsage.size) {
        let input = 0;
        let cached = 0;
        let output = 0;
        for (const u of partialUsage.values()) {
          input += u.input;
          cached += u.cached;
          output += u.output;
        }
        out.push({
          kind: 'usage',
          text: `사용량 (결과 이벤트 없음 — 응답 ${partialUsage.size}개의 부분 집계, 출력은 하한·비용 모름) · 입력 ${fmtTokens(input)} (캐시 ${fmtTokens(cached)}) · 출력 ${fmtTokens(output)}`,
          data: { inputTokens: input, outputTokens: output, cachedInputTokens: cached },
          raw: { type: 'finish', partialUsage: partialUsage.size },
        });
      }
      out.push({
        kind: 'system',
        text: `결과 이벤트 없이 끝났습니다 (종료 코드 ${exitCode ?? '없음'})`,
        data: { exitCode, isError: true },
        raw: { type: 'finish', exitCode },
      });
      return out;
    },
  };

  /** 응답 메시지의 사용량을 그 메시지 ID로 한 번만 적는다 (같은 메시지면 큰 값 — 내용 블록마다 되풀이된다) */
  function notePartialUsage(msg: Record<string, unknown>): void {
    const id = str(msg.id);
    const u = isRecord(msg.usage) ? msg.usage : null;
    if (!id || !u) return;
    const read = num(u.cache_read_input_tokens) ?? 0;
    const next = { input: (num(u.input_tokens) ?? 0) + read + (num(u.cache_creation_input_tokens) ?? 0), cached: read, output: num(u.output_tokens) ?? 0 };
    const prev = partialUsage.get(id);
    partialUsage.set(id, prev ? { input: Math.max(prev.input, next.input), cached: Math.max(prev.cached, next.cached), output: Math.max(prev.output, next.output) } : next);
  }

  function unparsed(line: string): ParsedCliEvent[] {
    const t = stripAnsi(line).trim();
    const classified = errors.ifClassified(t, line, { fallbackResetAt: rateLimitResetAt });
    if (classified.length > 0) return classified;
    return [{ kind: 'system', text: `해석하지 못한 출력: ${oneLine(t, 500)}`, raw: line }];
  }

  function onSystem(o: Record<string, unknown>): ParsedCliEvent[] {
    const subtype = str(o.subtype) ?? '';
    if (subtype === 'init') return onInit(o);
    switch (subtype) {
      case 'permission_denied': {
        // 승인할 사람이 없어 자동 거부된 순간 바로 온다 (result.permission_denials보다 먼저) → 즉시 바이패스 불일치 (CLI-12)
        const tool = str(o.tool_name) ?? '도구';
        const reason = str(o.decision_reason) ?? str(o.message) ?? '';
        return errors.forced(`${tool} 실행 권한 확인이 자동 거부되었습니다${reason ? ` (${oneLine(reason, 200)})` : ''}`, o, { kind: 'permission' });
      }
      case 'thinking_tokens': {
        // 추론 중 토큰 추정치가 자주 온다 → 4천·8천·1만6천…을 넘을 때만 남긴다
        const est = num(o.estimated_tokens) ?? 0;
        if (est < thinkingNext) return [];
        while (thinkingNext <= est) thinkingNext *= 2;
        return [{ kind: 'system', text: `추론 중 (약 ${fmtTokens(est)} 토큰)`, raw: o }];
      }
      case 'api_retry': {
        const attempt = num(o.attempt);
        const max = num(o.max_retries);
        const delay = num(o.retry_delay_ms);
        const status = num(o.error_status) ?? str(o.error_status);
        const err = str(o.error) ?? '';
        return [{ kind: 'system', text: `API 재시도 ${attempt ?? '?'}/${max ?? '?'}${status !== undefined ? ` (${status}${err ? ` ${err}` : ''})` : err ? ` (${err})` : ''}${delay !== undefined ? ` · ${Math.round(delay / 1000)}초 뒤` : ''}`, raw: o }];
      }
      case 'compact_boundary': {
        const meta = isRecord(o.compact_metadata) ? o.compact_metadata : {};
        const trigger = str(meta.trigger);
        const pre = num(meta.pre_tokens);
        return [{ kind: 'system', text: `대화 압축${trigger ? ` (${trigger === 'auto' ? '자동' : trigger === 'manual' ? '수동' : trigger})` : ''}${pre !== undefined ? ` · 이전 ${fmtTokens(pre)} 토큰` : ''}`, raw: o }];
      }
      case 'status':
        return [{ kind: 'system', text: `상태: ${str(o.status) ?? '알 수 없음'}`, raw: o }];
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response': {
        const name = str(o.hook_name) ?? str(o.hook_event) ?? '';
        return [{ kind: 'system', text: `훅 ${name} ${subtype === 'hook_started' ? '시작' : subtype === 'hook_response' ? '완료' : '진행'}`.trim(), raw: o }];
      }
      case 'task_started':
      case 'task_progress':
      case 'task_notification': {
        const desc = str(o.description) ?? str(o.summary) ?? str(o.status) ?? '';
        return [{ kind: 'system', text: `하위 작업 ${subtype === 'task_started' ? '시작' : subtype === 'task_notification' ? '알림' : '진행'}${desc ? `: ${oneLine(desc, 200)}` : ''}`, raw: o }];
      }
      default: {
        const msg = str(o.message) ?? str(o.content) ?? str(o.text);
        return [{ kind: 'system', text: `시스템 이벤트 ${subtype || '(종류 없음)'}${msg ? `: ${oneLine(msg, 300)}` : ''}`, raw: o }];
      }
    }
  }

  function onInit(o: Record<string, unknown>): ParsedCliEvent[] {
    const sessionId = str(o.session_id);
    const mode = str(o.permissionMode);
    const model = str(o.model);
    const servers = arr(o.mcp_servers)
      .filter(isRecord)
      .map((s) => ({ name: str(s.name) ?? '?', status: str(s.status) ?? 'unknown' }));
    const app = servers.find((s) => s.name === opts.serverName);
    const modeText = mode === 'bypassPermissions' ? '바이패스' : `${mode ?? '알 수 없음'} (바이패스 아님)`;
    const appText = app ? `${opts.serverName} ${mcpStatusKo(app.status)}` : `${opts.serverName} 없음`;
    const events: ParsedCliEvent[] = [
      {
        kind: 'session',
        text: `세션 시작${model ? ` · 모델 ${model}` : ''} · 권한 ${modeText} · 앱 도구 ${appText}`,
        data: { ...(sessionId ? { cliSessionId: sessionId } : {}), ...(mode ? { permissionMode: mode } : {}), mcpServers: servers },
        raw: o,
      },
    ];
    if (!app) events.push(...errors.forced(`앱 도구 서버 "${opts.serverName}"가 연결 목록에 없습니다`, o, { kind: 'mcp' }));
    else if (app.status === 'failed' || app.status === 'needs-auth') events.push(...errors.forced(`앱 도구 서버 "${opts.serverName}" 연결 실패 (${app.status})`, o, { kind: 'mcp' }));
    return events;
  }

  function onAssistant(o: Record<string, unknown>): ParsedCliEvent[] {
    const msg = isRecord(o.message) ? o.message : {};
    notePartialUsage(msg);
    const content = arr(msg.content);
    const sub = str(o.parent_tool_use_id) ? '[하위] ' : '';
    const errCode = str(o.error);
    // 2.1.x는 is_api_error_message, SDK 타입은 isApiErrorMessage
    if (errCode || o.is_api_error_message === true || o.isApiErrorMessage === true) {
      const text = content
        .filter(isRecord)
        .map((b) => str(b.text) ?? '')
        .join('\n')
        .trim();
      return errors.event(text || `API 오류 (${errCode ?? '알 수 없음'})`, o, { code: errCode ?? null, fallbackResetAt: rateLimitResetAt });
    }
    const out: ParsedCliEvent[] = [];
    for (const b of content) {
      if (!isRecord(b)) continue;
      const type = str(b.type);
      if (type === 'text') {
        const text = str(b.text) ?? '';
        if (text.trim() !== '') out.push({ kind: 'text', text: sub + text, raw: o });
      } else if (type === 'thinking') {
        const text = str(b.thinking) ?? '';
        out.push({ kind: 'thinking', text: sub + (text.trim() !== '' ? text : '(추론 내용 비공개)'), raw: o });
      } else if (type === 'redacted_thinking') {
        out.push({ kind: 'thinking', text: `${sub}(가려진 추론)`, raw: o });
      } else if (type === 'tool_use') {
        out.push(...onToolUse(b, o, sub));
      } else if (type === 'server_tool_use') {
        const input = isRecord(b.input) ? b.input : {};
        out.push({ kind: 'tool_call', text: `${sub}${str(b.name) ?? '서버 도구'}${str(input.query) ? `: ${oneLine(str(input.query)!, 200)}` : ''}`, data: { tool: str(b.name) ?? 'server_tool', callId: str(b.id) }, raw: o });
      } else if (type && type.endsWith('_tool_result')) {
        out.push({ kind: 'tool_result', text: `${sub}${type} 결과`, data: { tool: type, callId: str(b.tool_use_id), ok: true }, raw: o });
      } else {
        out.push({ kind: 'system', text: `${sub}알 수 없는 응답 내용: ${type ?? '(type 없음)'}`, raw: o });
      }
    }
    return out;
  }

  function onToolUse(b: Record<string, unknown>, raw: Record<string, unknown>, sub: string): ParsedCliEvent[] {
    const id = str(b.id) ?? '';
    const name = str(b.name) ?? '?';
    const input = isRecord(b.input) ? b.input : {};
    const mcp = parseMcpToolName(name, opts.serverName);
    if (mcp) {
      tools.set(id, { name, category: 'mcp', server: mcp.server, tool: mcp.tool });
      const label = mcp.server === opts.serverName ? `앱 도구 호출: ${mcp.tool}` : `MCP 도구 호출: ${mcp.server}/${mcp.tool}`;
      return [{ kind: 'mcp_call', text: sub + label, data: { tool: mcp.tool, server: mcp.server, callId: id }, raw }];
    }
    if (COMMAND_TOOLS.has(name)) {
      const command = str(input.command) ?? '';
      const background = input.run_in_background === true;
      tools.set(id, { name, category: 'command', command, background });
      return [{ kind: 'command_start', text: `${sub}$ ${oneLine(command, 300)}${background ? ' (백그라운드)' : ''}`, data: { tool: name, callId: id, command }, raw }];
    }
    const verb = FILE_TOOLS[name];
    if (verb) {
      const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
      const paths = p ? [p] : [];
      tools.set(id, { name, category: 'file', paths });
      return [{ kind: 'file_change', text: `${sub}파일 ${verb}: ${paths.join(', ') || '(경로 없음)'}`, data: { tool: name, callId: id, paths }, raw }];
    }
    tools.set(id, { name, category: 'other' });
    return [{ kind: 'tool_call', text: sub + toolCallSummary(name, input), data: { tool: name, callId: id }, raw }];
  }

  function onUser(o: Record<string, unknown>): ParsedCliEvent[] {
    const msg = isRecord(o.message) ? o.message : {};
    const content = msg.content;
    const sub = str(o.parent_tool_use_id) ? '[하위] ' : '';
    if (typeof content === 'string') return content.trim() ? [{ kind: 'system', text: `${sub}사용자 메시지: ${oneLine(content, 300)}`, raw: o }] : [];
    const out: ParsedCliEvent[] = [];
    for (const b of arr(content)) {
      if (!isRecord(b)) continue;
      const type = str(b.type);
      if (type === 'tool_result') out.push(...onToolResult(b, o, sub));
      else if (type === 'text') {
        const text = str(b.text) ?? '';
        if (text.trim()) out.push({ kind: 'system', text: `${sub}사용자 메시지: ${oneLine(text, 300)}`, raw: o });
      }
    }
    return out;
  }

  function onToolResult(b: Record<string, unknown>, raw: Record<string, unknown>, sub: string): ParsedCliEvent[] {
    const id = str(b.tool_use_id) ?? '';
    const info = tools.get(id);
    tools.delete(id);
    const isError = b.is_error === true;
    const text = toolResultText(b.content);
    const out: ParsedCliEvent[] = [];
    // 2.1.x는 거부 순간 system/permission_denied를 먼저 보낸다. 그게 없던 버전·경로를 위해 도구 결과 문구로도 확인
    if (isError && !errors.has('permission') && isPermissionPromptText(text)) out.push(...errors.forced(text, raw, { kind: 'permission' }));
    if (info?.category === 'command') {
      const detail = isRecord(raw.tool_use_result) ? raw.tool_use_result : {};
      const interrupted = detail.interrupted === true;
      const m = /^\s*exit code[:\s]+(-?\d+)/im.exec(text);
      let exitCode: number | null = m ? Number(m[1]) : null;
      if (exitCode === null && !isError && !interrupted && !info.background) exitCode = 0;
      const ok = !isError && !interrupted;
      const output = m ? text.replace(m[0], '') : text;
      const label = info.background && ok ? '백그라운드 명령 시작됨' : ok ? `명령 완료 (종료 코드 ${exitCode ?? 0})` : `명령 실패${exitCode !== null ? ` (종료 코드 ${exitCode})` : interrupted ? ' (중단됨)' : ''}${output.trim() ? `: ${firstLine(output, 200)}` : ''}`;
      out.push({ kind: 'command_end', text: sub + label, data: { tool: info.name, callId: id, command: info.command, exitCode, ok }, raw });
      return out;
    }
    const tool = info?.tool ?? info?.name ?? '도구';
    const label = info?.category === 'mcp' ? (info.server === opts.serverName ? `앱 도구 ${tool}` : `MCP ${info.server}/${tool}`) : tool;
    const data: NonNullable<ParsedCliEvent['data']> = { tool, callId: id, ok: !isError };
    if (info?.server) data.server = info.server;
    if (info?.paths) data.paths = info.paths;
    out.push({ kind: 'tool_result', text: `${sub}${label} ${isError ? '실패' : '결과'}${text ? `: ${oneLine(text, 300)}` : ''}`, data, raw });
    return out;
  }

  function onResult(o: Record<string, unknown>): ParsedCliEvent[] {
    resultSeen = true;
    const subtype = str(o.subtype) ?? '';
    const isError = o.is_error === true || (subtype !== '' && subtype !== 'success');
    const numTurns = num(o.num_turns);
    const denials = arr(o.permission_denials).length;
    const resultText = str(o.result) ?? '';
    const errorsList = arr(o.errors)
      .map((e) => (typeof e === 'string' ? e : isRecord(e) ? (str(e.message) ?? '') : ''))
      .filter((e) => e !== '');
    const out: ParsedCliEvent[] = [];

    const usage = usageFromResult(o);
    if (usage) out.push({ kind: 'usage', text: usage.text, data: usage.data, raw: o });

    let text: string;
    const data: NonNullable<ParsedCliEvent['data']> = { isError, permissionDenials: denials };
    if (numTurns !== undefined) data.numTurns = numTurns;
    if (!isError) {
      text = resultText;
    } else if (subtype === 'error_max_turns') {
      // errors: ["Reached maximum number of turns (1)"] — num_turns는 상한보다 1 크게 온다
      const limit = /maximum number of turns \((\d+)\)/i.exec(errorsList.join('\n'))?.[1];
      text = `최대 반복 수${limit ? `(${limit}회)` : ''}에 도달해 멈췄습니다`;
    } else if (subtype === 'error_max_budget_usd') {
      text = '비용 상한에 도달해 멈췄습니다';
    } else {
      text = resultText.trim() || errorsList.join('\n') || `턴 오류 (${subtype || '알 수 없음'})`;
      const cls = errors.classifyLike(text);
      // 문구로 못 가르면 API 상태 코드로 (Claude가 재시도를 마친 뒤의 401·429)
      const status = num(o.api_error_status);
      if (cls.kind === 'other' && !cls.resumeFailed && status === 401) cls.kind = 'auth';
      if (cls.kind === 'other' && !cls.resumeFailed && status === 429) cls.kind = 'usage_limit';
      if (cls.kind === 'usage_limit' && !cls.resetAt && rateLimitResetAt) cls.resetAt = rateLimitResetAt;
      if (cls.kind === 'usage_limit' && !cls.rateLimitType && rateLimitType) cls.rateLimitType = rateLimitType;
      data.errorKind = cls.kind;
      if (cls.resetAt) data.resetAt = cls.resetAt;
      if (cls.rateLimitType) data.rateLimitType = cls.rateLimitType;
      if (cls.resumeFailed) data.resumeFailed = true;
      out.push(...errors.forced(text, o, cls));
    }
    if (denials > 0 && !errors.has('permission')) {
      out.push(...errors.forced(`실행 권한 확인 ${denials}건이 거부되었습니다`, o, { kind: 'permission' }));
    }
    out.push({ kind: 'result', text, data, raw: o });
    return out;
  }

  function onRateLimit(o: Record<string, unknown>): ParsedCliEvent[] {
    const info = isRecord(o.rate_limit_info) ? o.rate_limit_info : {};
    const status = str(info.status) ?? '';
    const type = str(info.rateLimitType);
    const limit = type ? (LIMIT_NAME[type] ?? type) : '사용량 한도';
    const resetAt = epochSecondsToIso(info.resetsAt);
    if (status === 'rejected' && info.isUsingOverage !== true) {
      rateLimitResetAt = resetAt;
      rateLimitType = type;
      // 한도 종류도 싣는다 — 모델별 주간 한도(seven_day_opus·seven_day_sonnet·seven_day_overage_included)는 그 모델 계열의 턴만 막는다 (리드 결정 22·29)
      return errors.forced(`${limit}에 도달했습니다${resetAt ? ` (해제 예정 ${resetAt})` : ''}`, o, {
        kind: 'usage_limit',
        ...(resetAt ? { resetAt } : {}),
        ...(type ? { rateLimitType: type } : {}),
      });
    }
    const statusKo = status === 'allowed' ? '정상' : status === 'allowed_warning' ? '한도 가까움' : status === 'rejected' ? '한도 도달(추가 사용으로 계속)' : status || '알 수 없음';
    return [{ kind: 'system', text: `사용량 상태: ${statusKo} · ${limit}${resetAt ? ` · 초기화 ${resetAt}` : ''}`, raw: o }];
  }

  function onToolProgress(o: Record<string, unknown>): ParsedCliEvent[] {
    const id = str(o.tool_use_id) ?? '';
    const elapsed = num(o.elapsed_time_seconds) ?? 0;
    const last = progressAt.get(id);
    if (last !== undefined && elapsed - last < PROGRESS_EVERY_SEC) return [];
    progressAt.set(id, elapsed);
    return [{ kind: 'system', text: `도구 실행 중: ${str(o.tool_name) ?? '도구'} (${Math.round(elapsed)}초)`, data: { tool: str(o.tool_name), callId: id }, raw: o }];
  }

  function onAuthStatus(o: Record<string, unknown>): ParsedCliEvent[] {
    const err = str(o.error);
    if (err) return errors.event(err, o, { cls: { kind: 'auth' } });
    const output = arr(o.output).filter((x): x is string => typeof x === 'string');
    return [{ kind: 'system', text: `인증 상태: ${o.isAuthenticating === true ? '인증 중' : '확인'}${output.length ? ` · ${oneLine(output.join(' '), 200)}` : ''}`, raw: o }];
  }

  function onControlRequest(o: Record<string, unknown>): ParsedCliEvent[] {
    const req = isRecord(o.request) ? o.request : {};
    const subtype = str(req.subtype) ?? '';
    // 바이패스·--permission-prompts none 이면 오지 않아야 한다. 오면 승인 대기로 바꾸지 않고 불일치로 처리 (CLI-12)
    if (subtype === 'can_use_tool') return errors.forced(`CLI가 실행 권한 확인을 요청했습니다: ${str(req.tool_name) ?? '도구'}`, o, { kind: 'permission' });
    return [{ kind: 'system', text: `제어 요청: ${subtype || '(종류 없음)'}`, raw: o }];
  }
}

export function parseMcpToolName(name: string, serverName: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const own = `mcp__${serverName}__`;
  if (name.startsWith(own)) return { server: serverName, tool: name.slice(own.length) };
  const rest = name.slice('mcp__'.length);
  const i = rest.indexOf('__');
  if (i <= 0) return { server: rest, tool: '' };
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

function mcpStatusKo(status: string): string {
  switch (status) {
    case 'connected':
      return '연결됨';
    case 'failed':
      return '연결 실패';
    case 'pending':
      return '연결 중';
    case 'needs-auth':
      return '인증 필요';
    case 'disabled':
      return '꺼짐';
    default:
      return status;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((b) => {
      if (!isRecord(b)) return '';
      const type = str(b.type);
      if (type === 'image') return '[이미지]';
      // ToolSearch 결과: 지연 로드된 도구(MCP 등)를 불러왔다는 표시
      if (type === 'tool_reference') return `도구 불러옴: ${str(b.tool_name) ?? '?'}`;
      return str(b.text) ?? '';
    })
    .filter((s) => s !== '')
    .join('\n');
}

function toolCallSummary(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => str(input[k]);
  switch (name) {
    case 'Read':
      return `읽기: ${s('file_path') ?? '?'}`;
    case 'Glob':
      return `파일 찾기: ${s('pattern') ?? '?'}${s('path') ? ` (${s('path')})` : ''}`;
    case 'Grep':
      return `내용 검색: ${s('pattern') ?? '?'}${s('path') ? ` (${s('path')})` : ''}`;
    case 'WebFetch':
      return `웹 가져오기: ${s('url') ?? '?'}`;
    case 'WebSearch':
      return `웹 검색: ${s('query') ?? '?'}`;
    case 'Task':
    case 'Agent':
      return `하위 에이전트: ${oneLine(s('description') ?? s('prompt') ?? '', 120)}`;
    case 'TodoWrite': {
      const todos = arr(input.todos).filter(isRecord);
      const done = todos.filter((t) => t.status === 'completed').length;
      return `할 일 목록 ${done}/${todos.length} 완료`;
    }
    case 'Skill':
      return `스킬: ${s('skill') ?? s('name') ?? '?'}`;
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return `${name}: ${s('bash_id') ?? s('shell_id') ?? ''}`.trim();
    default: {
      const firstStr = Object.values(input).find((v): v is string => typeof v === 'string');
      return `도구 ${name}${firstStr ? `: ${oneLine(firstStr, 120)}` : ''}`;
    }
  }
}

function usageFromResult(o: Record<string, unknown>): { text: string; data: NonNullable<ParsedCliEvent['data']> } | null {
  // result.usage는 메인 루프만 센다. modelUsage(모델별 합계)가 있으면 그쪽이 하위 에이전트까지 포함한다
  const mu = isRecord(o.modelUsage) ? Object.values(o.modelUsage).filter(isRecord) : [];
  let input: number | undefined;
  let output: number | undefined;
  let cached: number | undefined;
  if (mu.length > 0) {
    input = 0;
    output = 0;
    cached = 0;
    for (const m of mu) {
      input += (num(m.inputTokens) ?? 0) + (num(m.cacheReadInputTokens) ?? 0) + (num(m.cacheCreationInputTokens) ?? 0);
      output += num(m.outputTokens) ?? 0;
      cached += num(m.cacheReadInputTokens) ?? 0;
    }
  } else if (isRecord(o.usage)) {
    const u = o.usage;
    const base = num(u.input_tokens);
    const read = num(u.cache_read_input_tokens);
    const create = num(u.cache_creation_input_tokens);
    if (base !== undefined || read !== undefined || create !== undefined) input = (base ?? 0) + (read ?? 0) + (create ?? 0);
    output = num(u.output_tokens);
    cached = read;
  }
  const cost = num(o.total_cost_usd);
  if (input === undefined && output === undefined && cost === undefined) return null;
  const data: NonNullable<ParsedCliEvent['data']> = {};
  if (input !== undefined) data.inputTokens = input;
  if (output !== undefined) data.outputTokens = output;
  if (cached !== undefined) data.cachedInputTokens = cached;
  if (cost !== undefined) data.costUsd = cost;
  const text = `사용량 · 입력 ${fmtTokens(input)}${cached !== undefined ? ` (캐시 ${fmtTokens(cached)})` : ''} · 출력 ${fmtTokens(output)}${cost !== undefined ? ` · $${cost.toFixed(4)}` : ''}`;
  return { text, data };
}
