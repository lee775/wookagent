/** CLI 어댑터 모음 (ARCHITECTURE 12장). 모의 어댑터는 ./mockAdapter.ts */
export {
  createClaudeAdapter,
  buildClaudeArgs,
  claudeMcpConfigJson,
  claudeMessage,
  claudeIsolationSettings,
  claudeConfigDir,
  CLAUDE_MCP_FILE,
  CLAUDE_SYSTEM_FILE,
  CLAUDE_SETTINGS_FILE,
  type AdapterBaseOptions,
  type ClaudeAdapterOptions,
} from './claudeAdapter';
export {
  createCodexAdapter,
  buildCodexArgs,
  codexMessageWithInstructions,
  tomlString,
  CODEX_TOKEN_ENV,
  CODEX_ISOLATION_ARGS,
  type CodexAdapterOptions,
} from './codexAdapter';
export {
  resolveCli,
  detectCli,
  parseCliVersion,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  codexNativeFromPackageRoot,
  cliLauncherEnv,
  runCommand,
  VERIFIED_VERSIONS,
  type ResolvedCli,
  type ResolveResult,
  type ResolveOptions,
  type DetectOptions,
  type CommandResult,
  type RunCommand,
} from './resolveCli';
export { buildChildEnv, INHERITED_SESSION_VARS, LaunchError, CLAUDE_EFFORTS, CODEX_EFFORTS } from './common';
export {
  createParserFor,
  createClaudeParser,
  createCodexParser,
  classifyErrorText,
  parseResetAt,
  isPermissionPromptText,
  DEFAULT_APP_SERVER_NAME,
  type ParserOptions,
  type ErrorClass,
} from './parsers';
