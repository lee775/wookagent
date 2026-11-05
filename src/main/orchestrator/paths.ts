/** 앱 데이터 폴더 구조 (ARCHITECTURE.md 4장) */
import { join } from 'node:path';

export interface DataPaths {
  root: string;
  db: string;
  reports: string;
  events: string;
  worktrees: string;
  review: string;
  artifacts: string;
  mainAgent: string;
  memory: string;
  attachments: string;
  tmp: string;
  mock: string;
  backups: string;
  bin: string;
  exports: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    db: join(root, 'wook.db'),
    reports: join(root, 'reports'),
    events: join(root, 'events'),
    worktrees: join(root, 'worktrees'),
    review: join(root, 'review'),
    artifacts: join(root, 'artifacts'),
    mainAgent: join(root, 'main-agent'),
    memory: join(root, 'memory'),
    attachments: join(root, 'attachments'),
    tmp: join(root, 'tmp'),
    mock: join(root, 'mock'),
    backups: join(root, 'backups'),
    bin: join(root, 'bin'),
    exports: join(root, 'exports'),
  };
}

export function taskWorktreePath(p: DataPaths, projectId: string, taskId: string): string {
  return join(p.worktrees, projectId, taskId);
}

export function artifactWorkDir(p: DataPaths, projectId: string, taskId: string): string {
  return join(p.artifacts, projectId, taskId, 'work');
}

export function artifactVersionDir(p: DataPaths, projectId: string, taskId: string, version: number): string {
  return join(p.artifacts, projectId, taskId, `v${version}`);
}

export function reviewCopyPath(p: DataPaths, projectId: string, taskId: string, round: number, tag: string): string {
  return join(p.review, projectId, `${taskId}-r${round}-${tag}`);
}

export function turnTmpDir(p: DataPaths, turnId: string): string {
  return join(p.tmp, 'turns', turnId);
}

export function eventsFile(p: DataPaths, memberId: string, sessionId: string, turnId: string): string {
  return join(p.events, memberId, sessionId, `${turnId}.jsonl`);
}

export function projectMemoryFile(p: DataPaths, projectId: string | null): string {
  if (!projectId) return join(p.memory, 'general.md');
  // 프로그램이 발급한 ID 형식(P-0001)만 경로에 넣는다 — '..'·구분자로 앱 데이터 밖을 가리키지 못하게 (SEC-02)
  if (!/^P-\d+$/.test(projectId)) throw new Error(`프로젝트 ID 형식이 아닙니다: ${JSON.stringify(projectId.slice(0, 80))}`);
  return join(p.memory, 'projects', `${projectId}.md`);
}
