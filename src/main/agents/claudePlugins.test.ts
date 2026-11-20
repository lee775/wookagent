import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_PLUGINS_DIR, findClaudePlugins } from './claudePlugins';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-claude-plugins-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function plugin(appRoot: string, name: string, withManifest = true): Promise<string> {
  const dir = path.join(appRoot, CLAUDE_PLUGINS_DIR, name);
  await mkdir(path.join(dir, 'skills'), { recursive: true });
  if (withManifest) {
    await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  }
  return dir;
}

describe('findClaudePlugins', () => {
  it('claude-plugins 폴더가 없으면 빈 목록 — 플러그인 없이 도는 것이 기본이다', () => {
    expect(findClaudePlugins(path.join(root, '없는 앱 폴더'))).toEqual([]);
    expect(findClaudePlugins(root)).toEqual([]);
  });

  it('.claude-plugin/plugin.json이 있는 폴더만, 이름순으로, 절대 경로로 낸다 — 파일과 설명 파일 없는 폴더는 건너뛴다', async () => {
    const app = path.join(root, '앱 폴더');
    const b = await plugin(app, 'b-kit');
    const a = await plugin(app, 'a-kit');
    await plugin(app, 'not-a-plugin', false);
    await writeFile(path.join(app, CLAUDE_PLUGINS_DIR, 'README.md'), '플러그인 폴더');
    expect(findClaudePlugins(app)).toEqual([a, b]);
  });
});
