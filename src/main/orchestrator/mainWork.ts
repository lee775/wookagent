/**
 * 메인 에이전트 작업 폴더 (SERVER_DESIGN 3.7, 리드 결정 S5-20). 예전에는 `<dataDir>/main-agent`라 DB·기록·관리 토큰·잡 러너 바로 옆이었고, host_exec의 기본 실행
 * 위치로 쓰면 실행 위치 검사(앱 데이터 폴더 안 거부)에 걸렸다. 두 모드 모두 데이터 폴더 밖으로 옮긴다:
 * - 데스크톱: `~/wook-workspace/main`
 * - 서버: `--workspace-root` > server.json `workspaceRoot` > `~/wook-workspace`, 그 아래 `main`
 * 시작할 때만 정한다(config reload는 다시 시작해야 바뀐다고 말한다). 시작 때 확인: 절대 경로, 데이터 폴더·등록된 프로젝트와 같지도 그 안도 그 폴더를 품지도
 * 않음. 서버는 틀리면 시작하지 않고(1), 데스크톱은 예전 폴더를 그대로 쓰며 host_exec는 cwd 없이는 그 까닭으로 거부한다. 새 폴더는 그 사용자만 쓰게 만들고
 * git 저장소로 시작한다. 예전 폴더는 지우지 않고(데이터 폴더 안이라 그대로 보호된다) 옮긴 사실을 활동 기록 한 줄로 남긴다. 메인 세션은 다음 턴에 '실행 위치
 * 변경'으로 새 세션이 된다(turns.resolveSession). 운영체제 수준의 격리는 아니다 — 우회 권한 CLI가 DB나 기록을 실수로 건드릴 확률을 줄일 뿐이다
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { prepareDataDir } from '../../server/dataDir';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import { relation, winPathProblem } from './pathGuard';

/** 작업 폴더 위치의 기본 이름 (홈 아래) */
export const WORKSPACE_DIR_NAME = 'wook-workspace';

/** 기본 작업 폴더 위치 `~/wook-workspace` */
export function defaultWorkspaceRoot(home: string = homedir()): string {
  return join(home, WORKSPACE_DIR_NAME);
}

/** 작업 폴더 위치 아래의 메인 에이전트 작업 폴더 */
export function mainWorkDirOf(root: string): string {
  return join(root, 'main');
}

/** 작업 폴더 위치를 정한 곳 */
export type WorkspaceSource = 'flag' | 'config' | 'default';

export interface WorkspaceChoice {
  root: string;
  source: WorkspaceSource;
}

/** 서버의 작업 폴더 위치: `--workspace-root` > server.json `workspaceRoot` > `~/wook-workspace` (리드 결정 S5-20). 값은 고치지 않는다 — 확인은 workspaceProblem */
export function chooseWorkspaceRoot(flag: string | null | undefined, config: string | null | undefined, home?: string): WorkspaceChoice {
  const f = flag?.trim();
  if (f) return { root: f, source: 'flag' };
  const c = config?.trim();
  if (c) return { root: c, source: 'config' };
  return { root: defaultWorkspaceRoot(home), source: 'default' };
}

/** 글에 쓰는 정한 곳 */
export function workspaceSourceText(source: WorkspaceSource): string {
  return source === 'flag' ? '--workspace-root' : source === 'config' ? 'server.json의 workspaceRoot' : `기본 위치(~/${WORKSPACE_DIR_NAME})`;
}

const RELATION_TEXT = { same: '같은 폴더', inside: '그 안', contains: '그 폴더를 품은 상위 폴더' } as const;

/**
 * 메인 작업 폴더로 쓸 수 없는 까닭 (아니면 null): 절대 경로가 아님, Windows 로컬 드라이브 폴더가 아님, 데이터 폴더와 같거나 그 안이거나 그 폴더를 품음.
 * 서버 시작의 미리 보기(잠금 전, serve.ts)와 백엔드 시작(createOrchestrator)이 같은 확인을 쓴다. where: 글에 쓸 정한 곳
 */
export function mainWorkDirProblem(dir: string, dataDir: string, where = '메인 에이전트 작업 폴더'): string | null {
  if (!isAbsolute(dir)) return `${where}가 절대 경로가 아닙니다: ${dir} — 예: D:\\wook-workspace`;
  const bad = winPathProblem(resolve(dir));
  if (bad) return `${where}는 이 PC의 로컬 드라이브 폴더여야 합니다 — ${bad}는 쓸 수 없습니다: ${dir}`;
  const rel = relation(dir, dataDir);
  if (rel) return `메인 에이전트 작업 폴더(${dir})가 데이터 폴더(${dataDir})와 ${RELATION_TEXT[rel]}입니다 — 데이터 폴더 밖의 다른 위치를 ${where}로 정하세요`;
  return null;
}

/** 서버 작업 폴더 위치 확인 (잠금 전 미리 보기 — 리드 결정 S5-20): 위치가 절대 경로이고 그 아래 main이 데이터 폴더와 겹치지 않는지 */
export function workspaceProblem(choice: WorkspaceChoice, dataDir: string): string | null {
  const where = `메인 에이전트 작업 폴더 위치(${workspaceSourceText(choice.source)})`;
  if (!isAbsolute(choice.root)) return `${where}가 절대 경로가 아닙니다: ${choice.root} — 예: D:\\wook-workspace`;
  return mainWorkDirProblem(mainWorkDirOf(resolve(choice.root)), dataDir, where);
}

/** 등록된 프로젝트(보관하지 않은 것)와 겹치는지 — 겹치면 그 까닭 (메인 CLI가 그 폴더에서 돌면 프로젝트 파일을 정해진 길 밖에서 바꾼다, 8.4) */
export function mainWorkProjectProblem(dir: string, projects: readonly { id: string; name: string; path: string; archivedAt?: string | null }[]): string | null {
  for (const p of projects) {
    if (p.archivedAt) continue;
    const rel = relation(dir, p.path);
    if (rel) return `메인 에이전트 작업 폴더(${dir})가 등록된 프로젝트(${p.id} ${p.name}, ${p.path})와 ${RELATION_TEXT[rel]}입니다 — 프로젝트와 겹치지 않는 위치를 정하세요`;
  }
  return null;
}

/**
 * 메인 작업 폴더를 준비한다: 없으면 그 사용자만 쓰게 만든다(데이터 폴더와 같은 길 — 옆 임시 이름으로 만들어 좁힌 뒤 옮긴다, S2-17·S2-20). 있으면 폴더인지만 본다.
 * 못 쓰면 그 까닭을 돌려준다
 */
export function prepareMainWorkDir(dir: string): string | null {
  try {
    if (existsSync(dir)) return statSync(dir).isDirectory() ? null : `메인 에이전트 작업 폴더 자리에 폴더가 아닌 것이 있습니다: ${dir}`;
    prepareDataDir(dir);
    return null;
  } catch (e) {
    return `메인 에이전트 작업 폴더를 만들지 못했습니다 (${dir}) — ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 마지막으로 쓴 메인 작업 폴더 (kv) — 옮긴 사실을 한 번만 남긴다 */
const LAST_DIR_KEY = 'mainWork.dir';

/**
 * 시작 때 메인 작업 폴더를 정한다 (createOrchestrator — 재시작 복구·첫 턴보다 먼저, 리드 결정 S5-20). 받은 폴더(deps.mainWorkDir)가 확인(절대 경로, 데이터 폴더·
 * 등록된 프로젝트와 겹치지 않음)을 통과하면 그 사용자만 쓰게 만들어 쓴다. 걸리면 서버는 BackendError로 시작하지 않고, 데스크톱은 예전 폴더를 쓰며 그 까닭을
 * core.mainWork.problem에 둔다 — host_exec는 cwd 없이 실행하지 않고 그 까닭을 말한다. 받은 폴더가 없으면(시험 하네스) 예전 폴더 그대로다.
 * 쓰는 폴더가 지난번과 다르면(처음 옮길 때는 예전 폴더가 있을 때) 활동 기록 한 줄 — 예전 폴더는 지우지 않는다
 */
export function settleMainWork(core: Core): void {
  const ctx = core.ctx;
  const legacy = ctx.paths.mainAgent;
  const wanted = ctx.deps.mainWorkDir;
  if (!wanted) {
    core.mainWork = { dir: legacy, problem: null };
  } else {
    const dir = resolve(wanted);
    const problem = mainWorkDirProblem(dir, ctx.paths.root) ?? mainWorkProjectProblem(dir, ctx.store.projects.list()) ?? prepareMainWorkDir(dir);
    if (problem && ctx.deps.mode === 'server') throw new BackendError('invalid', `메인 에이전트 작업 폴더를 쓸 수 없어 시작하지 않았습니다 — ${problem}`);
    if (problem) {
      mkdirSync(legacy, { recursive: true });
      core.mainWork = { dir: legacy, problem };
      ctx.log('warn', `메인 에이전트 작업 폴더를 쓸 수 없어 예전 폴더를 씁니다 — ${problem}`);
      ctx.activity({
        kind: 'system',
        level: 'warn',
        text: `메인 에이전트 작업 폴더(${dir})를 쓸 수 없어 예전 폴더(${legacy})를 씁니다 — ${problem}. 예전 폴더는 앱 데이터 폴더 안이라 host_exec는 cwd를 주지 않으면 실행하지 않습니다`,
      });
    } else core.mainWork = { dir, problem: null };
  }
  const now = core.mainWork.dir;
  const last = ctx.store.kv.get<string>(LAST_DIR_KEY);
  const prev = last ?? (now !== legacy && existsSync(legacy) ? legacy : null);
  if (prev && prev !== now) {
    ctx.activity({ kind: 'system', text: `메인 에이전트 작업 폴더를 옮겼습니다: ${prev} → ${now} — 예전 폴더는 지우지 않고 그대로 둡니다. 메인 에이전트 세션은 다음 턴에 새 세션으로 이어 갑니다` });
  }
  if (last !== now) ctx.store.kv.set(LAST_DIR_KEY, now);
}
