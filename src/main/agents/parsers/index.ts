/** 이벤트 형식별 파서 (모의 에이전트도 같은 형식으로 출력하므로 같은 파서를 쓴다, MOCK-06) */
import type { AiKind } from '@shared/domain';
import type { EventParser } from '../types';
import { createClaudeParser } from './claudeParser';
import { createCodexParser } from './codexParser';
import type { ParserOptions } from './util';

/** 앱 도구 서버 기본 이름 (orchestrator/prompts.ts의 '앱 도구 서버 "wook"'과 같아야 한다) */
export const DEFAULT_APP_SERVER_NAME = 'wook';

export function createParserFor(format: AiKind, opts: Partial<ParserOptions> = {}): EventParser {
  const full: ParserOptions = { ...opts, serverName: opts.serverName ?? DEFAULT_APP_SERVER_NAME };
  return format === 'claude' ? createClaudeParser(full) : createCodexParser(full);
}

export { createClaudeParser, parseMcpToolName } from './claudeParser';
export { createCodexParser, shellInner } from './codexParser';
export { classifyErrorText, isPermissionPromptText, isTransientRetryText, parseResetAt, wallTimeToUtc, type ClassifyOptions, type ErrorClass } from './classify';
export type { ParserOptions } from './util';
