/**
 * 프로젝트 기억 경로 (security:SEC-F4, SEC-02, 10.2): read_memory·write_memory의 project_id는 DB가 발급한 프로젝트 ID만.
 * 예전에는 '../../reports/x' 같은 값이 그대로 경로가 되어 앱 기록(보고서)을 덮어쓰거나 앱 데이터 밖에 파일을 만들었다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAIN_AGENT_ID } from '@shared/domain';
import { projectMemoryFile } from '../../src/main/orchestrator/paths';
import type { TokenIdentity } from '../../src/main/mcp/types';
import type { Env } from './helpers';
import { boot } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const mainIdentity = (projectId: string): TokenIdentity => ({
  turnId: 'TN-990001',
  sessionId: 'S-990001',
  sessionKey: `main:${projectId}`,
  sessionKind: 'main_project',
  memberId: MAIN_AGENT_ID,
  projectId: null,
  isMain: true,
  isProducer: false,
  canReview: false,
});

describe('기억 도구의 project_id (SEC-F4)', () => {
  it.each([['../../reports/tampered'], ['..\\..\\reports\\tampered'], ['P-0001/../../x'], ['P-9999']])('write_memory %s → not_found, 파일을 만들지 않는다', async (bad) => {
    env = await boot();
    const e = env;
    const before = readdirSync(join(e.dataDir, 'memory', 'projects'));
    const r = await e.core.tools.handle(mainIdentity(e.project.id), 'write_memory', { project_id: bad, content: '# 위조' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
    expect(readdirSync(join(e.dataDir, 'memory', 'projects'))).toEqual(before);
    expect(existsSync(join(e.dataDir, 'reports', 'tampered.md'))).toBe(false);
    expect(existsSync(join(dirname(e.dataDir), 'x.md'))).toBe(false);
  });

  it('read_memory로 없는 프로젝트 기억 파일을 만들지 않는다', async () => {
    env = await boot();
    const e = env;
    const outside = `../../../wook-sec-outside-${process.pid}`;
    for (const bad of ['P-9999', outside]) {
      const r = await e.core.tools.handle(mainIdentity(e.project.id), 'read_memory', { project_id: bad });
      expect(r.ok).toBe(false);
    }
    expect(existsSync(join(e.dataDir, 'memory', 'projects', 'P-9999.md'))).toBe(false);
    expect(existsSync(join(e.dataDir, 'memory', 'projects', `${outside}.md`))).toBe(false);
  });

  it('실제 프로젝트 ID와 일반 기억은 그대로 읽고 쓴다', async () => {
    env = await boot();
    const e = env;
    const id = mainIdentity(e.project.id);
    const w = await e.core.tools.handle(id, 'write_memory', { project_id: e.project.id, content: '# 회귀 기억\n- 대표 선호: 짧게' });
    expect(w.ok).toBe(true);
    const r = await e.core.tools.handle(id, 'read_memory', { project_id: e.project.id });
    expect(r.ok && (r.data as { content: string }).content).toContain('대표 선호: 짧게');
    expect(readFileSync(projectMemoryFile(e.ctx.paths, e.project.id), 'utf8')).toContain('회귀 기억');
    const g = await e.core.tools.handle(id, 'read_memory', {});
    expect(g.ok).toBe(true);
  });

  it('경로 함수는 발급 형식이 아닌 ID를 거부한다 (방어선)', async () => {
    env = await boot();
    expect(() => projectMemoryFile(env!.ctx.paths, '../x')).toThrow();
    expect(projectMemoryFile(env.ctx.paths, null)).toBe(join(env.ctx.paths.memory, 'general.md'));
    expect(projectMemoryFile(env.ctx.paths, 'P-0001')).toBe(join(env.ctx.paths.memory, 'projects', 'P-0001.md'));
  });
});
