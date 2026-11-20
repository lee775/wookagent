/**
 * 앱과 함께 실린 Claude 플러그인 폴더 — <앱 폴더>/claude-plugins/<이름>/.claude-plugin/plugin.json
 *
 * Claude 세션(팀원·메인)을 띄울 때 폴더마다 `--plugin-dir`로 넘긴다. 그 세션은 플러그인의 스킬·명령·에이전트를 쓸 수 있다.
 * 세션은 대표 개인 설정과 떼어 놓고 띄우므로(claudeAdapter의 격리 설정) 플러그인의 훅은 돌지 않는다.
 * Linux 묶음에는 `pack-linux.mjs --claude-plugin <폴더>`로 싣는다. 폴더가 없으면 아무것도 넘기지 않는다.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CLAUDE_PLUGINS_DIR = 'claude-plugins';

/** 플러그인 폴더들의 절대 경로 (이름순). 폴더가 없거나 읽지 못하면 빈 목록 */
export function findClaudePlugins(appRoot: string): string[] {
  const base = join(appRoot, CLAUDE_PLUGINS_DIR);
  let names: string[];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .filter((name) => existsSync(join(base, name, '.claude-plugin', 'plugin.json')))
    .sort()
    .map((name) => join(base, name));
}
