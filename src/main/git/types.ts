/**
 * git 서비스 계약 (7장, CLI-09).
 * 앱이 관리하는 git 변경은 모두 이 서비스로만 한다. 에이전트는 셸에서 직접 git 변경을 하지 않는다.
 * 구현: ./gitService.ts 의 createGitService()
 */

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitFileStatus {
  path: string;
  /** porcelain v1 XY 코드 (예: ' M', 'A ', '??', 'UU') */
  code: string;
}

export interface WorktreeStatus {
  /** 추적 파일 변경·스테이징·미추적 파일·충돌이 모두 없음 */
  clean: boolean;
  /** 추적 파일에 커밋되지 않은 변경이 있음 (미추적 파일 제외) */
  trackedDirty: boolean;
  files: GitFileStatus[];
  untracked: string[];
  /** 충돌 미해결 파일 */
  unmerged: string[];
  mergeInProgress: boolean;
}

export interface DiffFileStat {
  path: string;
  /** A·M·D·R·U·? */
  status: 'A' | 'M' | 'D' | 'R' | 'U' | '?';
  additions: number;
  deletions: number;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
}

export type MergeIntoBaseResult =
  | { ok: true; mergeSha: string; preSha: string }
  | { ok: false; reason: 'base_moved' | 'not_up_to_date' | 'error'; detail: string };

export type UpdateFromBaseResult =
  | { ok: true; sha: string; upToDate: boolean }
  | { ok: false; conflicts: string[]; detail: string };

export type RevertResult = { ok: true; sha: string } | { ok: false; conflicts: string[]; detail: string };

/** 병합 진행 중인 작업 폴더의 충돌 파일을 내용으로 본 결과 (GIT-07, CLI-09) */
export interface ConflictCheck {
  /** 인덱스에 충돌로 남은 파일 (git add 전이면 해결했어도 남는다) */
  unmerged: string[];
  /** 충돌 표시(<<<<<<< ======= >>>>>>>)가 아직 남은 텍스트 파일 — 미해결 */
  withMarkers: string[];
  /** 내용으로 해결 여부를 확인할 수 없는 충돌 파일 (바이너리·큰 파일·일반 파일 아님·한쪽이 지운 파일). 작업 폴더에 있는 그대로가 해결이다 */
  unverifiable: string[];
}

/**
 * 체크아웃된 기준 브랜치 폴더와 한 병합의 관계 (baseCheckoutState). 그 병합이 바꾼 경로의 인덱스 항목만 본다 — 그 밖의 경로에 스테이징된
 * 변경은 대표 작업이라 판단에 넣지 않는다:
 * - not_checked_out: 기준 브랜치가 체크아웃돼 있지 않다 — 맞출 것이 없다
 * - moved: 기준 브랜치 끝이 그 병합 커밋이 아니다 (그 뒤로 더 움직임 등) — 이 병합의 맞춤이 아니다
 * - synced: 병합이 바꾼 경로마다 그 병합의 변경이 들어 있다 — 병합 결과이거나 그 위에 대표가 고친 내용, 병합이 더한 경로의 대표 내용,
 *   대표가 지운 경로 (맞출 것이 없다 — 그대로 커밋해도 병합이 되돌려지지 않는다)
 * - behind: 병합이 바꾼 경로가 모두 아직 병합 전 내용이다 — 병합 뒤 폴더를 맞추지 못했다 (맞춘다 — 다른 경로의 스테이징은 그대로 남는다)
 * - diverged: 그 밖 — 병합 변경이 빠진 경로(병합 전 내용, 병합 전 내용에 대표 변경이 더해짐)나 내용으로 확인하지 못한 경로가 있는데 모두
 *   병합 전 내용은 아니다 — 맞추지 않은 폴더에 대표 변경이 섞였다 (건드리지 않고 알린다)
 */
export type BaseCheckoutState = 'not_checked_out' | 'moved' | 'synced' | 'behind' | 'diverged';

export interface BaseCheckout {
  state: BaseCheckoutState;
  /** 병합이 바꾼 경로 중 인덱스가 아직 병합 전 내용인 것 — 그대로 커밋하면 그 경로의 병합 변경이 되돌려진다 (diverged 안내에 적는다) */
  preMerge: string[];
  /** 병합이 바꾼 경로 중 인덱스가 병합 전 내용에 대표 변경이 더해진 것 — 그 병합의 변경이 빠져 그대로 커밋하면 되돌려진다. 없으면 없음 */
  preMergeEdited?: string[];
  /** 병합이 바꾼 경로 중 대표 변경에 그 병합의 변경이 들어 있는지 내용으로 확인하지 못한 것 (바이너리·일반 파일 아님·변경이 겹침). 없으면 없음 */
  unverified?: string[];
}

export interface GitService {
  /** 'git version x.y.z' 의 버전 문자열. git 없으면 null */
  version(): Promise<string | null>;
  isRepo(dir: string): Promise<boolean>;
  /**
   * paths(dir 기준 '/' 구분 상대 경로) 가운데 git이 무시하는 것 (`check-ignore`) — 그 경로나 상위 폴더가 무시 규칙에 걸리고, 그 아래 추적하는
   * 파일이 없는 것. 안에 든 파일이 모두 무시될 뿐인 폴더는 무시하는 경로가 아니다. git은 무시하는 경로에 들어가지 않는다(`add -A`도 연결 지점을
   * 따라가지 않는다). dir이 저장소 최상위가 아니면(git 없음, 다른 저장소의 하위 폴더) ensureRepo가 dir에 새로 만들 저장소가 보는 규칙으로 본다 —
   * 빈 임시 저장소에 dir을 작업 트리로 붙여 본다. dir은 바꾸지 않는다. 연결 지점 검사가 git이 따라가지 않는 링크를 빼는 데 쓴다 (S9-D1, S10-D1, AC-18)
   */
  ignoredPaths(dir: string, paths: readonly string[]): Promise<string[]>;
  /**
   * 저장소 확인·초기화 (GIT-01).
   * - git이 없고 init=true면 `git init -b main` 후, 파일이 있든 없든 첫 커밋을 만든다(빈 폴더면 --allow-empty).
   * - 이미 저장소인데 커밋이 하나도 없으면 첫 커밋을 만든다 (worktree 생성에 필요).
   * - baseBranch: 현재 체크아웃된 브랜치 (분리 HEAD면 'main'이 있으면 main, 없으면 오류)
   */
  ensureRepo(dir: string, opts: { init: boolean; identity: GitIdentity }): Promise<{ initialized: boolean; baseBranch: string; headSha: string }>;
  /** ref → 커밋 SHA. 없으면 null */
  revParse(dir: string, ref: string): Promise<string | null>;
  /** 체크아웃된 브랜치 이름. 분리 HEAD면 null */
  currentBranch(dir: string): Promise<string | null>;
  status(dir: string): Promise<WorktreeStatus>;
  /**
   * 작업 브랜치 + 작업 폴더 생성 (GIT-02). 멱등:
   * - 같은 경로에 같은 브랜치 worktree가 이미 있으면 created=false로 반환
   * - 브랜치만 있으면 그 브랜치로 worktree를 만든다
   */
  addWorktree(repoDir: string, opts: { path: string; branch: string; base: string }): Promise<{ created: boolean; headSha: string }>;
  /** 검수용 읽기 사본: 특정 커밋을 분리 HEAD로 체크아웃한 작업 폴더 (REV-08) */
  addDetachedWorktree(repoDir: string, opts: { path: string; commit: string }): Promise<void>;
  /** worktree 제거 (--force). 이미 없으면 조용히 성공 + prune */
  removeWorktree(repoDir: string, path: string): Promise<void>;
  /** 추적·미추적 변경을 모두 커밋 (GIT-05). 변경이 없으면 커밋하지 않고 null */
  commitAll(dir: string, message: string, identity: GitIdentity): Promise<string | null>;
  /**
   * 지정한 파일만 커밋 (프로젝트 등록 시 AGENTS.md·CLAUDE.md 자동 설정, MEM-02).
   * 대표가 프로젝트 폴더에 둔 다른 변경·스테이징은 건드리지 않는다 (git commit --only -- <paths>, 새 파일은 먼저 add).
   * 해당 파일에 변경이 없으면 null
   */
  commitPaths(dir: string, paths: string[], message: string, identity: GitIdentity): Promise<string | null>;
  /**
   * 최신 기준 브랜치를 작업 브랜치에 병합 (GIT-06 첫 단계).
   * 충돌이 나면 병합 진행 상태를 그대로 남기고(conflict 마커) 충돌 파일을 돌려준다 → 팀원이 해결 (GIT-07)
   */
  mergeBaseInto(dir: string, baseRef: string, message: string, identity: GitIdentity): Promise<UpdateFromBaseResult>;
  /**
   * 충돌 해결 확인 (GIT-07): 팀원은 git 없이 파일만 고치므로(CLI-09) 인덱스의 충돌 표시(UU·AA 등)는 해결해도 그대로 남는다 —
   * 해결 여부는 작업 폴더 내용으로 본다 (concludeMerge가 스테이징하면 인덱스 표시는 풀린다). 아무것도 바꾸지 않는다.
   * recorded: 기록된 충돌 파일 — 인덱스에서 이미 충돌이 풀린 파일(팀원이 직접 스테이징·커밋한 파일)도 내용으로 본다
   */
  conflictCheck(dir: string, recorded?: readonly string[]): Promise<ConflictCheck>;
  /** 충돌 해결 후 병합 커밋 완료: 충돌 표시가 남은 파일이 있으면 오류, 없으면 모두 스테이징(git add -A)해 커밋 */
  concludeMerge(dir: string, message: string, identity: GitIdentity): Promise<string>;
  abortMerge(dir: string): Promise<void>;
  isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean>;
  /** 두 커밋이 갈라진 지점(공통 조상, `git merge-base`). 공통 이력이 없으면 null */
  mergeBase(dir: string, a: string, b: string): Promise<string | null>;
  /**
   * main 병합 (GIT-06·13·14). 작업 트리를 쓰지 않는다:
   * 1) refs/heads/<base> == expectedBaseSha 확인 (아니면 base_moved)
   * 2) expectedBaseSha가 taskSha의 조상인지 확인 (아니면 not_up_to_date)
   * 3) tree = taskSha^{tree}, commit-tree로 parents [expectedBaseSha, taskSha] 병합 커밋 생성
   * 4) update-ref refs/heads/<base> <merge> <expectedBaseSha> (비교 후 교체)
   */
  mergeIntoBase(
    repoDir: string,
    opts: { baseBranch: string; taskSha: string; expectedBaseSha: string; message: string; identity: GitIdentity },
  ): Promise<MergeIntoBaseResult>;
  /**
   * 기준 브랜치가 repoDir에 체크아웃돼 있으면 인덱스·작업 트리를 oldSha→newSha로 맞춘다 (read-tree -m -u).
   * 체크아웃돼 있지 않으면 아무것도 안 하고 ok
   */
  syncCheckedOutBase(repoDir: string, baseBranch: string, oldSha: string, newSha: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * 체크아웃된 기준 브랜치 폴더가 한 병합(oldSha → newSha)에 비해 어떤 상태인지 — 그 병합이 바꾼 경로의 인덱스 항목을 병합 전 트리와 대조한다
   * (아무것도 바꾸지 않는다). 병합 뒤 폴더 맞춤(syncCheckedOutBase)을 할지 정하는 데 쓴다 (GIT-15, AC-45)
   */
  baseCheckoutState(repoDir: string, baseBranch: string, oldSha: string, newSha: string): Promise<BaseCheckout>;
  /** 추적 파일에 커밋되지 않은 변경이 있는지 (미추적 파일 무시) */
  hasTrackedChanges(dir: string): Promise<boolean>;
  /** 복구 확인 (GIT-15): <base>의 preSha 이후 이력에서 parents가 정확히 [preSha, taskSha]인 병합 커밋 */
  findMergeCommit(repoDir: string, baseBranch: string, preSha: string, taskSha: string): Promise<string | null>;
  /**
   * 선택 되돌리기 (GIT-10, 7.1): dir(작업 폴더)에서 `git revert -m 1 <mergeSha>` 와 같은 효과의 새 커밋.
   * 충돌 시 revert를 중단(abort)하고 충돌 파일을 돌려준다
   */
  revertMerge(dir: string, mergeSha: string, message: string, identity: GitIdentity): Promise<RevertResult>;
  /** 브랜치 끝을 refs/wook/archive/<archiveName>에 보관. 브랜치가 없으면 null */
  archiveBranch(repoDir: string, branch: string, archiveName: string): Promise<string | null>;
  /** 브랜치 삭제 (-D). 없으면 무시 */
  deleteBranch(repoDir: string, branch: string): Promise<void>;
  diffStat(dir: string, from: string, to: string): Promise<DiffFileStat[]>;
  diffPatch(dir: string, from: string, to: string, maxBytes: number): Promise<{ patch: string; truncated: boolean }>;
  /** 작업 폴더의 커밋되지 않은 변경까지 포함한 base 대비 diff */
  workingDiff(dir: string, base: string, maxBytes: number): Promise<{ files: DiffFileStat[]; patch: string; truncated: boolean }>;
  log(dir: string, ref: string, limit: number): Promise<CommitInfo[]>;
  /** 원격 올리기 (GIT-12) */
  push(dir: string, remote: string, branch: string): Promise<{ ok: boolean; output: string }>;
}
