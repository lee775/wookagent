/**
 * 프로젝트 등록 (HOME-05, GIT-01, MEM-01·02, ORG-04)과 팀 구성 (ORG-03·08, ROLE-04, MBR-06, 19.1 AI 설정 결정).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Actor, AiConfig, AiKind, EffortTier, Member, MockScenario, Project, Role, SessionKind, Task } from '@shared/domain';
import { AI_KINDS, EFFORT_LEVELS, MAIN_AGENT_ID, OPERATOR, OWNER } from '@shared/domain';
import type { AiConfigInput } from '@shared/views';
import { TASK_STATE_LABEL } from '@shared/labels';
import { canBeReviewer } from '@core/reviewRules';
import { isTerminal } from '@core/taskMachine';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import type { Ctx } from './context';
import { memberIdentity, recordedExec } from './execlog';
import { activeTaskOf, isAiFixed, liveMemberOrThrow, memberName, memberOrThrow, openTasksOf, projectMembers, projectOrThrow, roleOf, taskOrThrow } from './lookups';
import { normalizeEffort } from './defaults';
import { isPersonName, pickPersonName } from './names';
import { isDirEmpty, isDir, writeFileAtomic } from './fsutil';
import { projectMemoryFile } from './paths';
import { canonicalPath, isTouchable, projectPathRefusal, relation, scanLinks, win32Effective, winPathProblem } from './pathGuard';
import { cancelQueued, directiveKey, enqueue, mainKey, parseKey, taskKey } from './records';
import { alertKey, askOwnerToCheck } from './alerts';
import type { StopResult } from './turns';

/**
 * 프로듀서 교체가 남은 프로세스로 멈출 때 그 턴의 마무리(일시정지·재개 업무)를 기다리는 상한 — 마무리는 정지 확인(최대 2.8초) 뒤 곧 끝난다. 넘으면 기다리지 않고
 * 지금 상태로 거부 글을 쓴다 (리드 결정 S5-62)
 */
const PRODUCER_STOP_SETTLE_MS = 5_000;

/** 노력치 단계 (설정 team.effortMapping의 키, 앱 도구의 effort_tier) */
const EFFORT_TIERS: readonly EffortTier[] = ['high', 'normal', 'low'];
/** AI 인자가 하나라도 실제로 주어졌는지 (도구 처리기는 인자가 없어도 값이 모두 undefined인 객체를 만든다, F10) */
const hasExplicitAi = (ai?: AiConfigInput): boolean => !!ai && Object.values(ai).some((v) => v !== undefined);

/** 한 작업이 한 직원에게서 다음 직원으로 넘어간 내역 (직원 교체 — team.replaceMember) */
export interface TaskHandover {
  fromId: string;
  fromName: string;
  /** 앞 담당의 AI (예: 'claude opus, 노력치 high') */
  fromAi: string;
  toId: string;
  toName: string;
  at: string;
  /** 넘길 때의 작업 상태 */
  state: Task['state'];
  /** 앞 담당이 남긴 인수인계 메모 — 남기지 않았으면 null */
  memo: string | null;
}

/** 작업마다의 인수인계 기록 (kv `handover:<작업 ID>`) */
export interface HandoverState {
  /** 메모를 요청한 담당 (교체가 메모를 기다리는 중) */
  asked?: { memberId: string; at: string };
  /** 지금 담당이 남긴 메모 — 넘길 때 history로 옮긴다 */
  memo?: { memberId: string; memberName: string; text: string; at: string };
  history: TaskHandover[];
}

const handoverKey = (taskId: string): string => `handover:${taskId}`;

export interface ReplaceMemberResult {
  retired: Member;
  hired: Member;
  tasks: { taskId: string; memo: boolean }[];
}
/** undefined 값인 키를 뺀다 — 기존 설정 위에 펼칠 때 생략한 항목이 기존 값(AI 종류·모델)을 지우지 않게 */
const definedOnly = (ai: AiConfigInput): AiConfigInput => Object.fromEntries(Object.entries(ai).filter(([, v]) => v !== undefined)) as AiConfigInput;
/** CLI가 받지 못하는 모델 이름 (agents/common.ts validateLaunch와 같은 기준) */
// eslint-disable-next-line no-control-regex
const BAD_MODEL_RE = /[\s\u0000-\u001f\u007f]/;
/** CLI에 넘길 수 있는 모델 이름인지 (앞뒤 공백은 저장 전에 뗀다) */
export const isValidModelName = (model: string): boolean => model.trim() !== '' && !BAD_MODEL_RE.test(model.trim());

export { NAME_POOL } from './names';

const AGENTS_TEMPLATE = (name: string) => `# ${name} 공통 지침 (AGENTS.md)

Claude·Codex 팀원이 함께 따르는 프로젝트 공통 지침입니다. 변경은 프로듀서 담당 작업으로 검수 후 병합합니다 (MEM-05).

## 프로젝트 목적
- (작성 필요)

## 기술 구성
- (작성 필요)

## 폴더 구조
- (작성 필요)

## 코딩 규칙
- 기존 코드의 스타일과 구조를 따른다.

## 빌드·테스트 방법
- (작성 필요)

## 금지 사항
- 비밀 값(API 키·토큰)을 저장소에 넣지 않는다.
`;

export interface CreateProjectInput {
  mode: 'existing' | 'new';
  path: string;
  name: string;
  checkCommands?: string[];
}

/** 지금 등록 중인 폴더 하나 (ProjectService.registering) — 같은 경로 글자의 두 등록도 따로 뺄 수 있게 개체로 둔다 */
interface Registering {
  path: string;
  /** 연결 지점 검사가 지금까지 따라간 바깥 폴더 — 등록 중에도 다른 등록이 견주고, 등록되면 그 프로젝트의 연결 지점 기록이 된다 (S8-D2) */
  targets: string[];
  /** 연결 지점 검사를 끝까지 마쳤는지 (첫 커밋이 있는 큰 저장소는 끝까지 보지 못해도 예전처럼 등록한다) */
  complete: boolean;
}

/**
 * 프로젝트 폴더 안의 연결 지점(junction)·심볼릭 링크가 닿는 바깥 폴더 기록 (S8-D2, AC-18). git은 연결 지점을 따라 들어가 첫 커밋(add -A)에 그
 * 파일을 담고, 병합·작업 트리 맞추기도 연결 지점을 따라 그 폴더에 쓴다 — 그 폴더는 그 프로젝트가 바꾸는 파일이다. 등록할 때 기록하고, 기록이 없는
 * 프로젝트(이전 버전에서 등록한 것)는 다음 등록 때 다시 본다 (recordMissingLinks)
 */
interface LinkRecord {
  targets: string[];
  complete: boolean;
  at: string;
}
const linkRecordKey = (projectId: string): string => `project.links:${projectId}`;
/** 기록할 바깥 폴더 수 상한 — 넘으면 끝까지 기록하지 못한 것으로 둔다 */
const LINK_RECORD_MAX = 500;

function addLinkTarget(reg: Registering, real: string): void {
  if (reg.targets.includes(real)) return;
  if (reg.targets.length < LINK_RECORD_MAX) reg.targets.push(real);
  else reg.complete = false;
}

export class ProjectService {
  /**
   * 지금 등록 중인 폴더 (S7-D1). 등록은 경로 검사부터 저장까지 git 초기화·첫 커밋·연결 지점 검사를 기다리므로, 겹친 두 요청(대표 화면과 메인
   * 에이전트의 create_project, 한 턴의 도구 두 번 호출, 시간 초과 뒤 다시 보낸 요청)이 서로를 보지 못해 한 폴더를 두 프로젝트로 등록했다.
   * 경로 검사와 같은 동기 구간에서 넣고, 등록이 끝나거나 실패하면 뺀다. 앱 종료도 이 등록이 끝나기를 기다린다 (orchestrator programWork)
   */
  private readonly registering = new Set<Registering>();

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 등록 중인 프로젝트가 있는지 — 앱 종료가 저장소를 닫기 전에 기다린다 */
  isRegistering(): boolean {
    return this.registering.size > 0;
  }

  /**
   * o.recheck: 메인 에이전트의 create_project가 넘긴다 — 폴더를 만들거나 git을 건드리기 전, 기다림(연결 지점 기록·저장소 확인·연결 지점 검사) 뒤마다 부른 메인 턴·
   * 자리 세대를 다시 본다. 그사이 그 턴이 끝났거나 자리가 바뀌었으면 거기서 거부해 등록하지 않는다 (리드 결정 S5-63)
   */
  async create(input: CreateProjectInput, actor: Actor, o: { recheck?: () => void } = {}): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new BackendError('invalid', '프로젝트 이름을 입력하세요');
    if (!input.path || !isAbsolute(input.path)) throw new BackendError('invalid', '폴더는 절대 경로여야 합니다');
    const path = resolve(input.path);
    // 폴더를 만들거나 git·지침 파일을 건드리기 전에 경로부터 검사한다 (AC-18·19)
    this.assertRegistrablePath(path, actor);
    // 같은(또는 겹치는) 폴더를 지금 등록하는 중이면 거부하고, 아니면 이 폴더를 등록 중으로 둔다 — 검사와 같은 동기 구간 (S7-D1)
    const self = this.reserveFolder(path);
    try {
      return await this.register(input, actor, name, path, self, o.recheck);
    } finally {
      this.registering.delete(self);
    }
  }

  /** 경로 검사를 마치고 등록 중으로 둔 폴더를 등록한다 (create). recheck: 기다림 뒤 부른 메인 턴 다시 보기 (리드 결정 S5-63) */
  private async register(input: CreateProjectInput, actor: Actor, name: string, path: string, self: Registering, recheck?: () => void): Promise<Project> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    // 연결 지점 기록이 없는 프로젝트부터 기록하고, 그 프로젝트가 연결 지점으로 닿는 폴더와 겹치면 폴더를 건드리기 전에 거부한다 (S8-D2)
    await this.recordMissingLinks(recheck);
    recheck?.();
    this.assertNoRegisteredOverlap(path, this.spellingsOf(path));
    if (input.mode === 'new') {
      if (existsSync(path) && !isDirEmpty(path)) throw new BackendError('conflict', '새 폴더 경로에 이미 파일이 있습니다. 기존 폴더 연결을 고르세요');
      mkdirSync(path, { recursive: true });
    } else if (!isDir(path)) {
      throw new BackendError('not_found', '연결할 폴더가 없습니다');
    } else {
      // 폴더 안의 연결 지점을 본다 — 첫 커밋(ensureRepo의 git add -A)도, 첫 커밋이 있는 저장소의 병합·작업 트리 맞추기도 연결 지점을 따라
      // 들어간다. 닿는 바깥 폴더는 이 프로젝트의 연결 지점 기록이 된다 (S8-D2)
      const committed = await this.hasCommittedRepo(path);
      recheck?.();
      await this.assertNoBlockedLinks(path, actor, self, !committed);
      recheck?.();
    }
    const projectId = ctx.store.nextId('project');
    const repo = await recordedExec(
      ctx,
      { kind: 'git_init', projectId, taskId: null, cwd: path, command: 'git init (없을 때) + 첫 커밋', target: path },
      async () => {
        const r = await git.ensureRepo(path, { init: true, identity: memberIdentity(null) });
        return { value: r, result: { initialized: r.initialized, baseBranch: r.baseBranch, headSha: r.headSha } };
      },
    );
    await this.setupGuidelines(projectId, path, name, repo.baseBranch);
    const now = ctx.now();
    const producerId = ctx.store.nextId('member');
    const project: Project = {
      id: projectId,
      name,
      path,
      baseBranch: repo.baseBranch,
      checkCommands: (input.checkCommands ?? []).map((c) => c.trim()).filter(Boolean),
      networkPolicy: 'allow',
      deploy: { pushRemote: null, deployCommand: null },
      mock: { enabled: false, speed: ctx.settings().developer.mockSpeed, defaultScenario: 'normal' },
      producerId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    ctx.store.tx(() => {
      // 기다리는 사이(git 초기화·지침 커밋) 겹치는 폴더가 등록됐으면 넣지 않는다 — 넣기와 같은 트랜잭션에서 다시 본다 (S7-D1)
      this.assertNoRegisteredOverlap(path, this.spellingsOf(path), self.targets);
      ctx.store.projects.insert(project);
      this.saveLinks(projectId, self);
      // 프로듀서 자동 배치 (ORG-03·04) — 이름은 프로그램이 짓는다: 다른 프로젝트에서 쓰지 않는 사람 이름 (names.ts)
      this.core.team.insertMember({ id: producerId, projectId, roleId: 'producer', isProducer: true }, actor);
    });
    this.core.memory.ensure(projectId, name);
    // 운영자(시험·복구 준비)가 만든 프로젝트의 프로듀서는 운영자가 정한 구성 그대로 둔다 (TeamService.add와 같다)
    if (actor !== OPERATOR) this.core.team.requestAiDecision(ctx.store.members.require(producerId));
    const links = self.targets.length || !self.complete ? `, 연결 지점이 닿는 바깥 폴더 ${self.targets.length}곳${self.complete ? '' : ' (끝까지 확인하지 못함)'}` : '';
    ctx.activity({ kind: 'system', actor, projectId, text: `프로젝트 등록 ${projectId} ${name} (${input.mode === 'new' ? '새 폴더' : '기존 폴더 연결'}, 기준 브랜치 ${repo.baseBranch}${repo.initialized ? ', git 초기화' : ''}${links})` });
    ctx.notify({ level: 'info', title: '프로젝트 등록', body: `${name} — 프로듀서가 배치됐습니다`, link: { tab: 'projects', projectId } });
    return project;
  }

  /**
   * 프로젝트로 등록할 수 없는 폴더를 거부한다 (AC-18·19, 10.2·10.3 앱 금지 정책, GIT-03, SEC-02). 등록하면 git 초기화·첫 커밋(`git add -A`)·
   * 지침 파일 커밋이 그 폴더를 바꾸고, 그 뒤 작업 병합이 그 폴더의 브랜치를 옮기므로 그 전에 막는다.
   * - 앱 데이터 폴더와 그 안: 팀원 작업 폴더(앱이 관리하는 worktree — 등록하면 그 팀원의 작업 브랜치·파일이 바뀐다)·검수 사본·산출물·
   *   메인 에이전트 폴더·기억·기록·DB. 앱 설정·기록을 바꾸는 길이므로 앱 금지 정책 위반이다
   * - 앱 데이터 폴더를 품은 상위 폴더(사용자 폴더 등): 첫 커밋이 앱 DB·기록을 그 저장소에 담는다 — 같은 위반
   * - 이미 등록된 다른 프로젝트 폴더: 같은 폴더는 conflict('이미 등록된 폴더'), 그 안이나 그 폴더를 품은 상위 폴더는 forbidden — 두 프로젝트가
   *   같은 파일을 서로 다른 작업 흐름으로 바꾸게 된다
   * - 이 PC의 로컬 드라이브 폴더(C:\…)가 아닌 경로: invalid (네트워크·장치 경로, 끝이 점·공백인 이름 등 — pathGuard.winPathProblem)
   * 같은 폴더인지는 경로 글자가 아니라 파일 식별자로 본다(pathGuard) — \\localhost\C$\…·연결 지점·짧은 이름처럼 철자가 달라도 같은 폴더다.
   * Win32 프로그램이 끝의 점·공백을 지워 읽는 철자는 지운 폴더로도 본다(git이 그 폴더에서 돈다). 앱 데이터 경로(ctx.paths.root)가 기준이라
   * 설정을 비워도 꺼지지 않는다. 에이전트가 요청한 앱 금지 정책 위반은 기록하고 긴급 알림한다(12장). 거부는 앱 도구 처리기가 '<도구> 거부'로도 남긴다
   */
  private assertRegistrablePath(path: string, actor: Actor): void {
    const spellings = this.spellingsOf(path);
    const policy = this.appPolicyArea(spellings);
    if (policy) this.refusePolicy(`앱 금지 정책: ${policy}는 프로젝트로 등록할 수 없습니다 — ${path}`, policy, path, actor);
    this.assertNoRegisteredOverlap(path, spellings);
    const bad = winPathProblem(path);
    // 글은 OS마다 예시가 다르다 — Windows는 예전 글 그대로 (pathGuard.projectPathRefusal, 리드 결정 S10-6.6)
    if (bad) throw new BackendError('invalid', projectPathRefusal(path, bad));
  }

  /** 같은 폴더를 가리키는 철자들 — 다른 PC의 공유 폴더는 건드리지 않는다(네트워크 대기). 그런 경로는 로컬 폴더 검사(winPathProblem)가 거부한다 */
  private spellingsOf(path: string): string[] {
    return [path, win32Effective(path)].filter((p): p is string => !!p && isTouchable(p));
  }

  /**
   * 이미 등록된 다른 프로젝트 폴더와 겹치면 거부한다: 같은 폴더는 conflict, 그 안이나 그 폴더를 품은 상위 폴더는 forbidden (assertRegistrablePath).
   * 그 프로젝트가 폴더 안의 연결 지점으로 닿는 바깥 폴더(연결 지점 기록)와 같거나 그 안이거나 그 폴더를 품어도 forbidden이다 (S8-D2).
   * 등록을 저장하기 바로 앞(같은 트랜잭션)에서도 다시 본다 — 그 사이 다른 등록이 끝났을 수 있다 (S7-D1). 그때는 이 폴더의 연결 지점이 닿는
   * 바깥 폴더(targets)도 견준다
   */
  private assertNoRegisteredOverlap(path: string, spellings: string[], targets: readonly string[] = []): void {
    for (const p of this.ctx.store.projects.list()) {
      if (p.archivedAt) continue;
      for (const s of spellings) {
        const rel = relation(s, p.path);
        if (rel === 'same') throw new BackendError('conflict', `이미 등록된 폴더입니다 (${p.id} ${p.name})`);
        if (rel === 'inside') throw new BackendError('forbidden', `다른 프로젝트(${p.id} ${p.name})의 폴더 안은 프로젝트로 등록할 수 없습니다 — ${path}`);
        if (rel === 'contains') {
          throw new BackendError('forbidden', `다른 프로젝트(${p.id} ${p.name})의 폴더를 품은 상위 폴더는 프로젝트로 등록할 수 없습니다 (첫 커밋·병합이 그 프로젝트의 파일까지 바꾼다) — ${path}`);
        }
      }
      const linked = this.linkTargetsOf(p.id);
      const hit = linked.find((t) => spellings.some((s) => relation(s, t) !== null));
      if (hit) {
        throw new BackendError(
          'forbidden',
          `다른 프로젝트(${p.id} ${p.name})가 폴더 안의 연결 지점으로 닿는 폴더(${hit})와 겹치는 폴더는 프로젝트로 등록할 수 없습니다 (그 프로젝트의 커밋·병합이 연결 지점을 따라 이 폴더의 파일을 바꾼다) — ${path}`,
        );
      }
      const via = targets.find((t) => relation(t, p.path) !== null || linked.some((x) => relation(t, x) !== null));
      if (via) throw new BackendError('forbidden', `폴더 안의 연결 지점이 닿는 폴더(${via})가 다른 프로젝트(${p.id} ${p.name})의 파일과 겹쳐 이 폴더는 프로젝트로 등록할 수 없습니다 — ${path}`);
    }
  }

  /** 등록된 프로젝트의 연결 지점 기록 — host_exec의 실행 위치 검사도 이 폴더를 막는다 (리드 결정 S5-17) */
  linkTargets(projectId: string): string[] {
    return this.linkTargetsOf(projectId);
  }

  /** 등록된 프로젝트의 연결 지점 기록 — 폴더 안의 연결 지점이 닿는 바깥 폴더 (S8-D2). 기록이 없으면 빈 목록 */
  private linkTargetsOf(projectId: string): string[] {
    return this.ctx.store.kv.get<LinkRecord>(linkRecordKey(projectId))?.targets ?? [];
  }

  private saveLinks(projectId: string, found: Registering): void {
    const record: LinkRecord = { targets: found.targets, complete: found.complete, at: this.ctx.now() };
    this.ctx.store.kv.set(linkRecordKey(projectId), record);
  }

  /**
   * 연결 지점 기록이 없는 등록된 프로젝트(이전 버전에서 등록한 것)의 폴더를 본다 — 기록만 하고 거부하지 않는다 (S8-D2). 같은 검사(scanLinks,
   * git이 무시하는 경로는 빼고, 항목 수 상한)로 보고, 기록은 프로젝트마다 한 번이다. 기록하기 전에 멈추거나 그 폴더를 지금 읽지 못하면(드라이브를
   * 뗐거나 폴더를 옮김 등 — 빈 기록을 남기면 다시 보지 않는다) 기록하지 않아 다음 등록이 다시 본다 (S9-D3)
   */
  private async recordMissingLinks(recheck?: () => void): Promise<void> {
    const ctx = this.ctx;
    for (const p of ctx.store.projects.list()) {
      if (p.archivedAt || ctx.store.kv.get<LinkRecord>(linkRecordKey(p.id))) continue;
      const found: Registering = { path: p.path, targets: [], complete: true };
      // git이 그 폴더에서 돌지 못해도(폴더가 그사이 없어짐) 읽지 못한 것으로 둔다
      const r = await scanLinks(p.path, (real) => (addLinkTarget(found, real), null), (paths) => ctx.deps.git.ignoredPaths(p.path, paths)).catch(
        () => ({ kind: 'unreadable' }) as const,
      );
      // 기록하기 전에 — 메인의 create_project가 기다리는 사이 그 턴이 끝났으면 여기서 멈춘다 (리드 결정 S5-63)
      recheck?.();
      if (r.kind === 'unreadable') continue;
      if (r.kind === 'too_many') found.complete = false;
      if (ctx.store.kv.get<LinkRecord>(linkRecordKey(p.id))) continue; // 겹친 다른 등록이 먼저 기록했다
      this.saveLinks(p.id, found);
      if (found.targets.length || !found.complete) {
        ctx.activity({
          kind: 'system',
          projectId: p.id,
          text: `프로젝트 ${p.id} ${p.name} 연결 지점 기록: 폴더 안의 연결 지점이 닿는 바깥 폴더 ${found.targets.length}곳${found.complete ? '' : ' (끝까지 확인하지 못함)'} — 그 폴더와 겹치는 폴더는 다른 프로젝트로 등록하지 않습니다`,
        });
      }
    }
  }

  /**
   * 이 폴더를 등록 중으로 둔다 (S7-D1). 지금 등록 중인 다른 폴더와 같거나(파일 식별자·실제 경로 — relation) 그 안이거나 그 폴더를 품으면 conflict로
   * 거부한다 — 그 등록이 끝나면 같은 폴더는 '이미 등록된 폴더', 겹치는 폴더는 등록할 수 없는 폴더다. 그 등록이 실패하면 다시 시도할 수 있으므로
   * 영구 거부(forbidden)로 답하지 않는다. 경로 검사와 같은 동기 구간에서 부른다 — 사이에 기다림이 있으면 두 등록이 서로를 보지 못한다
   */
  private reserveFolder(path: string): Registering {
    const spellings = this.spellingsOf(path);
    for (const other of this.registering) {
      for (const s of spellings) {
        const rel = relation(s, other.path);
        if (rel === 'same') throw new BackendError('conflict', `같은 폴더를 지금 프로젝트로 등록하는 중입니다 (${other.path}). 등록이 끝나면 프로젝트 목록에서 확인하세요`);
        if (rel) {
          throw new BackendError(
            'conflict',
            `${rel === 'inside' ? '이 폴더를 품은' : '이 폴더 안의'} 폴더(${other.path})를 지금 프로젝트로 등록하는 중입니다 — 등록되면 겹치는 폴더는 등록할 수 없습니다. 그 등록이 끝난 뒤 다시 확인하세요: ${path}`,
          );
        }
        // 그 등록의 연결 지점 검사가 이미 지난, 연결 지점이 닿는 바깥 폴더와 겹쳐도 (S8-D2)
        const linked = other.targets.find((t) => relation(s, t) !== null);
        if (linked) {
          throw new BackendError(
            'conflict',
            `지금 프로젝트로 등록하는 중인 폴더(${other.path})가 연결 지점으로 닿는 폴더(${linked})와 겹칩니다 — 등록되면 겹치는 폴더는 등록할 수 없습니다. 그 등록이 끝난 뒤 다시 확인하세요: ${path}`,
          );
        }
      }
    }
    const self: Registering = { path, targets: [], complete: true };
    this.registering.add(self);
    return self;
  }

  /** 이 철자들 가운데 앱 데이터 폴더(또는 그 안)이거나 앱 데이터 폴더를 품은 상위 폴더가 있으면 그 영역 이름 (relation — 파일 식별자로, 실제 경로 글자로도) */
  private appPolicyArea(spellings: string[]): string | null {
    const ctx = this.ctx;
    for (const s of spellings) {
      const rel = relation(s, ctx.paths.root);
      if (rel === 'same' || rel === 'inside') {
        const area = (dir: string, label: string) => {
          const r = relation(s, dir);
          return r === 'same' || r === 'inside' ? label : null;
        };
        return (
          area(ctx.paths.worktrees, '다른 팀원의 작업 폴더(앱이 관리하는 작업 폴더)') ??
          area(ctx.paths.review, '검수 사본(앱이 관리하는 폴더)') ??
          area(ctx.paths.artifacts, '산출물 폴더(앱이 관리하는 폴더)') ??
          area(ctx.paths.mainAgent, '메인 에이전트 작업 폴더(앱이 관리하는 폴더)') ??
          '앱 데이터 폴더(앱 설정·기록)'
        );
      }
      if (rel === 'contains') return '앱 데이터 폴더를 품은 상위 폴더(앱 DB·기록이 저장소에 들어간다)';
    }
    // 데이터 폴더 밖의 메인 에이전트 작업 폴더(리드 결정 S5-20): 그 폴더·그 안·그 폴더를 품은 상위 폴더도 등록하지 않는다 — 우회 권한으로 도는 메인 CLI가 그 폴더에서
    // 프로젝트 파일을 정해진 길(지시 → 프로듀서 → 작업 폴더 → 검수 → 병합) 밖에서 바꾸게 된다
    const main = this.core.mainWork.dir;
    for (const s of spellings) {
      const rel = relation(s, main);
      if (rel === 'same' || rel === 'inside') return '메인 에이전트 작업 폴더(앱이 관리하는 폴더)';
      if (rel === 'contains') return '메인 에이전트 작업 폴더를 품은 상위 폴더(메인 에이전트가 우회 권한으로 일하는 폴더가 저장소에 들어간다)';
    }
    return null;
  }

  /** 앱 금지 정책 위반 거부: 활동 기록, 에이전트 요청이면 긴급 알림(12장 '앱 금지 정책 위반') */
  private refusePolicy(message: string, policy: string, path: string, actor: Actor): never {
    const ctx = this.ctx;
    const agent = actor !== OWNER && actor !== OPERATOR && actor !== 'system';
    ctx.activity({ kind: 'system', level: agent ? 'error' : 'warn', actor, text: `프로젝트 등록 거부 (${agent ? '앱 금지 정책 위반' : '앱 금지 정책'}): ${policy} — ${path}` });
    if (agent) {
      ctx.notify({
        level: 'urgent',
        title: '앱 금지 정책 위반',
        body: `${memberName(ctx, actor)}의 프로젝트 등록 요청을 거부했습니다: ${policy} — ${path}`,
        link: { tab: 'settings', section: 'policy' },
        key: `app-policy:create_project:${canonicalPath(path).toLowerCase()}`,
      });
    }
    throw new BackendError('forbidden', message);
  }

  /** 첫 커밋이 이미 있는 저장소의 최상위 폴더인지 — 아니면 ensureRepo가 폴더 전체를 첫 커밋(git add -A)에 담는다 */
  private async hasCommittedRepo(path: string): Promise<boolean> {
    const git = this.ctx.deps.git;
    try {
      return (await git.isRepo(path)) && !!(await git.revParse(path, 'HEAD'));
    } catch {
      return false;
    }
  }

  /**
   * 폴더 안의 연결 지점(junction)·심볼릭 링크를 본다 (AC-18·19). Git for Windows의 `git add -A`는 연결 지점을 폴더처럼 따라 들어가 그 안의 파일을
   * 커밋하고, 병합·작업 트리 맞추기도 연결 지점을 따라 그 폴더에 쓴다 — 앱 데이터 폴더(DB·기록)나 그것을 품은 상위 폴더를 가리키면 앱 금지 정책
   * 위반, 다른 프로젝트 폴더나 그 프로젝트가 연결 지점으로 닿는 폴더와 겹치면 거부 (S8-D2). 따라간 바깥 폴더는 self.targets에 모은다(연결 지점 기록).
   * firstCommit(첫 커밋이 폴더 전체를 담는다)이면 끝까지 확인하지 못할 만큼 클 때 등록하지 않는다. 첫 커밋이 있는 저장소는 예전처럼 등록하고
   * 기록을 '끝까지 확인하지 못함'으로 둔다. 지금 등록 중인 다른 폴더(self 밖)나 그 등록의 연결 지점이 닿는 곳과 겹쳐도 거부한다 (S7-D1)
   */
  private async assertNoBlockedLinks(path: string, actor: Actor, self: Registering, firstCommit: boolean): Promise<void> {
    const ctx = this.ctx;
    let policy = false;
    /** 겹친 곳이 등록 중인 다른 폴더 — 그 등록이 실패할 수 있으니 reserveFolder처럼 conflict */
    let inFlight = false;
    // git이 무시하는 경로(node_modules 등)의 연결 지점은 git이 따라가지 않는다 — 커밋·병합이 그 폴더를 바꾸지 않으므로 보지 않는다. 그 링크를
    // 보는 git 경로가 모두 무시될 때만이다 (S9-D1, S10-D1·D2)
    const r = await scanLinks(path, (real) => {
      addLinkTarget(self, real);
      const area = this.appPolicyArea([real]);
      if (area) {
        policy = true;
        return area;
      }
      const p = ctx.store.projects.list().find((x) => !x.archivedAt && relation(real, x.path) !== null);
      if (p) return `다른 프로젝트(${p.id} ${p.name})의 폴더`;
      for (const x of ctx.store.projects.list()) {
        const t = x.archivedAt ? undefined : this.linkTargetsOf(x.id).find((t) => relation(real, t) !== null);
        if (t) return `다른 프로젝트(${x.id} ${x.name})가 연결 지점으로 닿는 폴더(${t})`;
      }
      const other = [...this.registering].find((x) => x !== self && relation(real, x.path) !== null);
      const linked = other ? undefined : [...this.registering].find((x) => x !== self && x.targets.some((t) => relation(real, t) !== null));
      if (!other && !linked) return null;
      inFlight = true;
      return other ? `지금 프로젝트로 등록 중인 다른 폴더(${other.path})` : `지금 프로젝트로 등록 중인 다른 폴더(${linked!.path})가 연결 지점으로 닿는 폴더`;
    }, (paths) => ctx.deps.git.ignoredPaths(path, paths));
    // 폴더를 읽지 못했다(그사이 옮겨짐·열 수 없음) — 본 것이 없으니 등록하지 않는다. 빈 기록을 남기지 않고, 폴더도 건드리지 않는다 (S9-D3)
    if (r.kind === 'unreadable') throw new BackendError('not_found', `연결할 폴더를 읽지 못해 연결 지점을 확인하지 못했습니다 (그사이 옮겨졌거나 열 수 없음) — ${path}`);
    if (r.kind === 'too_many') {
      if (!firstCommit) {
        self.complete = false;
        return;
      }
      throw new BackendError(
        'invalid',
        `폴더 안 항목이 너무 많아(${r.limit.toLocaleString('ko-KR')}개 넘음) 연결 지점 검사를 마치지 못해 등록하지 않았습니다. 이 폴더를 먼저 git 저장소로 만들고 첫 커밋을 한 뒤 연결하세요 — ${path}`,
      );
    }
    if (r.kind !== 'hit') return;
    const what = `폴더 안의 연결 지점 ${r.link}(→ ${r.target})이 가리키는 ${r.reason}`;
    const why = firstCommit ? '첫 커밋(git add -A)이 연결 지점을 따라 들어가 그 파일을 저장소에 넣습니다' : '병합·작업 트리 맞추기가 연결 지점을 따라 들어가 그 파일을 바꿉니다';
    if (policy) this.refusePolicy(`앱 금지 정책: ${what} 때문에 이 폴더는 프로젝트로 등록할 수 없습니다 (${why}) — ${path}`, what, path, actor);
    throw new BackendError(inFlight ? 'conflict' : 'forbidden', `${what} 때문에 이 폴더는 프로젝트로 등록할 수 없습니다 (${why}) — ${path}`);
  }

  /** AGENTS.md 원본 + CLAUDE.md 첫 줄 @AGENTS.md (MEM-01·02). 해당 파일만 커밋해 대표의 다른 변경은 건드리지 않는다 */
  private async setupGuidelines(projectId: string, path: string, name: string, baseBranch: string): Promise<void> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    const agents = join(path, 'AGENTS.md');
    const claude = join(path, 'CLAUDE.md');
    const changed: string[] = [];
    if (!existsSync(agents)) {
      writeFileSync(agents, AGENTS_TEMPLATE(name), 'utf8');
      changed.push('AGENTS.md');
    }
    if (!existsSync(claude)) {
      writeFileSync(claude, '@AGENTS.md\n', 'utf8');
      changed.push('CLAUDE.md');
    } else {
      const text = readFileSync(claude, 'utf8');
      if (!text.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md')) {
        writeFileSync(claude, `@AGENTS.md\n${text}`, 'utf8');
        changed.push('CLAUDE.md');
      }
    }
    if (!changed.length) return;
    if ((await git.currentBranch(path)) !== baseBranch) {
      ctx.activity({ kind: 'git', level: 'warn', projectId, text: `공통 지침 파일을 만들었지만 ${baseBranch}가 체크아웃돼 있지 않아 커밋하지 않았습니다: ${changed.join(', ')}` });
      return;
    }
    await recordedExec(
      ctx,
      { kind: 'project_setup', projectId, taskId: null, cwd: path, command: `git commit ${changed.join(' ')}`, target: baseBranch },
      async () => {
        const sha = await git.commitPaths(path, changed, '[욱채] 공통 지침 연결 (AGENTS.md, CLAUDE.md)', memberIdentity(null));
        return { value: sha, result: { sha, files: changed } };
      },
    );
    ctx.activity({ kind: 'git', projectId, text: `공통 지침 자동 설정: ${changed.join(', ')} (MEM-02)` });
  }

  update(id: string, patch: { name?: string; checkCommands?: string[]; networkPolicy?: 'allow' | 'restricted'; deploy?: { pushRemote: string | null; deployCommand: string | null } }, actor: Actor): Project {
    const ctx = this.ctx;
    const p = projectOrThrow(ctx, id);
    const next: Project = {
      ...p,
      name: patch.name?.trim() || p.name,
      checkCommands: patch.checkCommands ? patch.checkCommands.map((c) => c.trim()).filter(Boolean) : p.checkCommands,
      networkPolicy: patch.networkPolicy ?? p.networkPolicy,
      deploy: patch.deploy ?? p.deploy,
      updatedAt: ctx.now(),
    };
    ctx.store.projects.put(next);
    ctx.activity({ kind: 'settings', actor, projectId: id, text: `프로젝트 설정 변경 ${id}` });
    return next;
  }

  setMock(id: string, mock: { enabled: boolean; speed?: number; defaultScenario?: MockScenario }, actor: Actor): Project {
    const ctx = this.ctx;
    const p = projectOrThrow(ctx, id);
    const next: Project = {
      ...p,
      mock: {
        enabled: mock.enabled,
        speed: Math.max(0.1, Math.min(1000, mock.speed ?? p.mock.speed)),
        defaultScenario: mock.defaultScenario ?? p.mock.defaultScenario,
      },
      updatedAt: ctx.now(),
    };
    ctx.store.projects.put(next);
    ctx.activity({ kind: 'settings', actor, projectId: id, text: `모의 에이전트 모드 ${mock.enabled ? '켬' : '끔'} (${id})` });
    return next;
  }
}

export class TeamService {
  /** 프로듀서 ID → 그 프로듀서를 바꾸는 중인 교체 호출들 (replaceProducer, 리드 결정 S5-90 1) */
  private readonly replacing = new Map<string, ReplaceRun>();

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /**
   * 메인 에이전트 개체 보장 (앱 시작 시). M-MAIN의 AI는 메인 자리 보유자가 정한다 (SERVER_DESIGN 4.3, 리드 결정 S4-2) — 예전에는 운영 설정이 바뀔 때마다
   * 실행 중에도 member.ai를 바로 덮어썼다. 이제는 실행 중인 메인 턴이 없을 때 자리 보유자에 맞추기만 하고, 바꾸는 것은 자리(seat.ts)가 한다.
   * AI 종류가 바뀌면 교체(새 세대)다
   */
  ensureMainAgent(): Member {
    const ctx = this.ctx;
    const existing = ctx.store.members.get(MAIN_AGENT_ID);
    const cfg = this.core.seat.launchedAi() ?? ctx.settings().general.mainAgent;
    if (existing) {
      if (JSON.stringify(existing.ai) !== JSON.stringify(cfg) && !this.core.turns.isMemberRunning(MAIN_AGENT_ID)) return ctx.store.members.patch(MAIN_AGENT_ID, { ai: cfg, updatedAt: ctx.now() });
      return existing;
    }
    const now = ctx.now();
    const m: Member = {
      id: MAIN_AGENT_ID,
      projectId: null,
      name: '메인 에이전트',
      roleId: 'main',
      isProducer: false,
      isMain: true,
      ai: cfg,
      pendingAi: null,
      // 메인 에이전트의 AI는 운영 설정(처음 보유자, 운영자)으로 정해진다 (AGT-08). 대표 고정은 없다 (v0.6)
      aiDecision: { by: OPERATOR, reason: '운영 설정 (AGT-08)', at: now },
      mockScenario: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      replacedById: null,
      runSeconds: 0,
    };
    ctx.store.members.insert(m);
    return m;
  }

  /** 지금 있는 역할의 이름 — 역할 이름은 사람 이름으로 받지 않는다 (names.isPersonName) */
  private roleNames(): string[] {
    return this.ctx.store.roles.list().map((r) => r.name);
  }

  /** 사람 이름인지 (한글 2~4자, AI·직함·역할을 가리키는 말이 아님) */
  isPersonName(name: string): boolean {
    return isPersonName(name, this.roleNames());
  }

  /** 프로그램이 짓는 이름 — 어느 프로젝트에서도 쓰지 않는 사람 이름을 먼저 (사무실에서 부서마다 같은 이름이 보이지 않게). skip: 이름을 다시 지을 팀원 자신 */
  private freshName(projectId: string, skip?: string): string {
    const live = this.ctx.store.members.list({ state: 'active' }).filter((m) => !m.isMain && m.id !== skip);
    const here = new Set(live.filter((m) => m.projectId === projectId).map((m) => m.name));
    return pickPersonName(here, new Set(live.map((m) => m.name)), this.roleNames()) ?? `팀원${here.size + 1}`;
  }

  /**
   * 새 팀원의 이름. 모든 팀원은 사람 이름을 가진다 (대표 지시 2026-11-16).
   * - 이름을 주지 않으면 프로그램이 짓는다 (freshName).
   * - 메인 에이전트가 준 이름은 사람 이름이고 이 프로젝트에 없을 때만 쓴다 — '코덱스 개발1'처럼 AI 종류·역할·번호로 만든 이름이면 프로그램이 짓는다.
   * - 운영자(내부 API: 시험·복구 준비)가 준 이름은 그대로 쓰고, 겹치면 번호를 붙인다.
   */
  private uniqueName(projectId: string, wanted: string | undefined, actor: Actor): string {
    const used = new Set(projectMembers(this.ctx, projectId).map((m) => m.name));
    const base = wanted?.trim();
    if (base && actor === MAIN_AGENT_ID) {
      if (this.isPersonName(base) && !used.has(base)) return base;
    } else if (base) {
      if (!used.has(base)) return base;
      for (let i = 2; i < 100; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
    }
    return this.freshName(projectId);
  }

  /**
   * 팀원의 새 이름 (update_member). 메인 에이전트가 바꾸는 이름은 사람 이름이어야 하고 그 프로젝트에 없어야 한다 — 아니면 거부하고 쓸 수 있는 이름을 하나
   * 알려 준다 (대표 지시 2026-11-16). 운영자(내부 API)가 준 이름은 그대로, 겹치면 번호를 붙인다
   */
  private renamed(m: Member, name: string, actor: Actor): string {
    if (!m.projectId) return name;
    if (actor !== MAIN_AGENT_ID) return this.uniqueName(m.projectId, name, actor);
    const example = this.freshName(m.projectId, m.id);
    if (!this.isPersonName(name)) {
      throw new BackendError('invalid', `"${name}"은(는) 사람 이름이 아닙니다 — 팀원 이름은 한글 2~4자의 사람 이름으로 짓습니다 (예: ${example}). AI 종류·역할·번호는 이름에 넣지 않습니다`);
    }
    const taken = projectMembers(this.ctx, m.projectId).find((o) => o.id !== m.id && o.name === name);
    if (taken) throw new BackendError('conflict', `이 프로젝트에 이미 ${name}(${taken.id})이(가) 있습니다 — 다른 이름을 주세요 (예: ${example})`);
    return name;
  }

  /**
   * 사람 이름이 아닌 팀원 이름을 사람 이름으로 바꾼다 — 이 규칙이 생기기 전에 메인 에이전트가 지은 이름('코덱스 개발1' 등). 데이터 폴더마다 한 번만
   * 부른다 (migrations.migratePersonNames). 지운 팀원과 메인 에이전트는 그대로 둔다. 바꾼 것은 프로젝트마다 활동 기록 한 줄로 남긴다
   */
  renameLabelNames(): { memberId: string; projectId: string; from: string; to: string }[] {
    const ctx = this.ctx;
    const renamed: { memberId: string; projectId: string; from: string; to: string }[] = [];
    ctx.store.tx(() => {
      for (const m of ctx.store.members.list({ state: 'active' })) {
        if (m.isMain || !m.projectId || this.isPersonName(m.name)) continue;
        const to = this.freshName(m.projectId, m.id);
        if (!this.isPersonName(to)) continue; // 지을 이름이 남지 않았다 — 그대로 둔다
        ctx.store.members.put({ ...m, name: to, updatedAt: ctx.now() });
        renamed.push({ memberId: m.id, projectId: m.projectId, from: m.name, to });
      }
    });
    for (const projectId of new Set(renamed.map((r) => r.projectId))) {
      const list = renamed.filter((r) => r.projectId === projectId);
      ctx.activity({ kind: 'system', projectId, text: `팀원 이름을 사람 이름으로 바꿈: ${list.map((r) => `${r.from}(${r.memberId}) → ${r.to}`).join(', ')}` });
    }
    return renamed;
  }

  resolveAi(role: Role, input?: AiConfigInput): AiConfig {
    const kind = input?.kind ?? role.defaultAi.kind;
    // 앱 도구는 인자 모양(zod)이 AI 종류·노력치 단계를 막지만 운영자 내부 API는 아니다 — 모든 경로가 저장 전에 같은 판정을 받는다 (리드 결정 S5-80 1)
    if (!AI_KINDS.includes(kind)) throw new BackendError('invalid', `AI 종류는 ${AI_KINDS.join('|')} 중 하나여야 합니다`);
    if (input?.effortTier != null && !EFFORT_TIERS.includes(input.effortTier)) throw new BackendError('invalid', `노력치 단계는 ${EFFORT_TIERS.join('|')} 중 하나여야 합니다`);
    const raw = input?.model !== undefined ? input.model : kind === role.defaultAi.kind ? role.defaultAi.model : null;
    const model = raw?.trim() || null;
    // CLI가 받지 못하는 이름은 저장 전에 거부한다 — 저장하면 그 팀원의 턴이 시작마다 실패한다 (F1, CONC-01). 모든 경로 공통
    if (model && BAD_MODEL_RE.test(model)) {
      const hint = this.catalogHint(model);
      throw new BackendError(
        'invalid',
        `${kind} 모델 이름에 공백·제어 문자를 쓸 수 없습니다: "${model}"${hint ? ` — 모델 목록의 표시 이름입니다. id "${hint.id}"(${hint.kind})을(를) 쓰세요` : ' (list_ai_options의 models에 있는 id를 쓰세요)'}`,
      );
    }
    const ai: AiConfig = {
      kind,
      model,
      effortTier: input?.effortTier ?? role.defaultAi.effortTier,
      effortOverride: input?.effortOverride !== undefined ? input.effortOverride || null : null,
    };
    if (ai.effortOverride && !EFFORT_LEVELS[kind].includes(ai.effortOverride)) {
      throw new BackendError('invalid', `${kind} 노력치 값은 ${EFFORT_LEVELS[kind].join('|')} 중 하나여야 합니다`);
    }
    return ai;
  }

  /** 모델 목록의 표시 이름(또는 대소문자만 다른 id)이면 그 항목 — 오류 안내에 id를 알려 주려고 */
  private catalogHint(model: string): { kind: AiKind; id: string } | null {
    const catalog = this.ctx.settings().team.modelCatalog;
    const key = model.trim().toLowerCase();
    for (const kind of AI_KINDS) {
      const hit = (catalog?.[kind] ?? []).find((o) => o.label.trim().toLowerCase() === key || o.id.toLowerCase() === key);
      if (hit && hit.id !== model.trim()) return { kind, id: hit.id };
    }
    return null;
  }

  /**
   * 메인 에이전트가 직접 고른 모델은 대표가 관리하는 목록(team.modelCatalog) 안에서만 (19.1, F8). 목록이 비면 CLI 기본 모델(null)만.
   * 실제로 넘긴 값만 본다 — 노력치만 바꾸는 호출은 이전에 대표가 넣은 목록 밖 모델 때문에 거부되지 않는다. 대표 경로는 자유 입력
   */
  private assertCatalogModel(kind: AiKind, model: string | null | undefined, nullOk = false): void {
    const m = model?.trim();
    if (!m) return; // 생략·null·'' = 바꾸지 않음 / CLI 기본 모델 (팀원은 assertModelDecided가 이어서 본다)
    const ids = (this.ctx.settings().team.modelCatalog?.[kind] ?? []).map((o) => o.id);
    if (ids.includes(m)) return;
    const hint = this.catalogHint(m);
    // 메인 자리(hand_off_seat)는 null(CLI 기본 모델)을 고를 수 있다. 팀원은 목록이 있으면 모델을 꼭 정하므로 그 길을 권하지 않는다
    const orNull = nullOk || !ids.length ? ' — 또는 null(CLI 기본 모델)' : '';
    throw new BackendError(
      'invalid',
      `${kind} 모델 "${m}"은(는) 운영 설정 모델 목록에 없습니다${hint ? ` (목록의 id는 "${hint.id}", AI 종류 ${hint.kind})` : ''}. list_ai_options의 models.${kind} id 중에서 고르세요: ${ids.join(', ') || '(목록 비어 있음 — CLI 기본 모델만)'}${orNull}`,
    );
  }

  /**
   * 메인 에이전트가 팀원의 AI를 정할 때는 모델도 정한다 (대표 지시 2026-11-18 "ai랑 노력치말고 모델도 정할 수 있게"). 정한 결과에 모델이 없으면
   * 거부하고 그 AI 종류의 모델 목록을 알려 준다 — 그 전에는 모델을 비워도 받아서 팀원이 'CLI 기본 모델'로 남았다. 목록이 빈 AI 종류는 고를 것이
   * 없으므로 그대로 둔다 (CLI 기본 모델만 — assertCatalogModel과 같은 기준)
   */
  private assertModelDecided(ai: AiConfig): void {
    if (ai.model) return;
    const options = this.ctx.settings().team.modelCatalog?.[ai.kind] ?? [];
    if (!options.length) return;
    throw new BackendError(
      'invalid',
      `모델을 정하지 않았습니다 — 팀원의 AI를 정할 때는 모델도 함께 정합니다(model). ${ai.kind} 모델: ${options.map((o) => (o.note ? `${o.id}(${o.note})` : o.id)).join(', ')}`,
    );
  }

  /** 메인 에이전트가 직원의 AI를 정할 때는 노력치도 정한다 — 단계(effort_tier)나 실제 값(effort) 가운데 하나를 직접 준다 (대표 지시 2026-11-18) */
  private assertEffortDecided(input: AiConfigInput | undefined): void {
    if (input?.effortTier !== undefined || input?.effortOverride) return;
    throw new BackendError(
      'invalid',
      '노력치를 정하지 않았습니다 — 직원의 AI를 정할 때는 모델과 노력치를 함께 정합니다(effort_tier: high·normal·low, 또는 effort에 실제 값). 무엇을 고를지는 list_ai_options의 guide.effort를 보세요',
    );
  }

  /**
   * 메인 에이전트가 이미 정한 직원인지 — 한 번 정한 직원의 AI(종류·모델·노력치)는 바꿀 수 없다 (대표 지시 2026-11-18 "한번 정해진 직원은 바꿀 수 없어 대신 퇴직시키고
   * 다른 직원 채용하는쪽으론 가능해"). 보류해 둔 변경도 정한 것이다. 이 규칙 전에 메인이 정했지만 모델이 빈 직원은 아직 정해지지 않은 것으로 본다(모델을 한 번 채울
   * 수 있다). 운영자·역할 기본값의 설정은 정한 것이 아니다
   */
  aiFixed(m: Member): boolean {
    return isAiFixed(this.ctx, m);
  }

  /**
   * 모델이 정해지지 않은 살아 있는 팀원의 모델을 메인 에이전트가 정하도록 프로젝트마다 한 번 요청한다 (migrations.migrateModelDecisions — 모델을 꼭
   * 정하는 규칙이 생기기 전의 팀원). 보류해 둔 AI 변경이 있으면 그 설정으로 본다. 요청한 팀원을 돌려준다
   */
  requestMissingModels(): Member[] {
    const ctx = this.ctx;
    const catalog = ctx.settings().team.modelCatalog;
    const missing = ctx.store.members.list({ state: 'active' }).filter((m) => {
      if (m.isMain || !m.projectId || !ctx.store.projects.get(m.projectId)) return false;
      const ai = m.pendingAi ?? m.ai;
      return !ai.model && (catalog?.[ai.kind] ?? []).length > 0;
    });
    for (const projectId of new Set(missing.map((m) => m.projectId!))) {
      const list = missing.filter((m) => m.projectId === projectId);
      enqueue(ctx, {
        kind: 'message',
        memberId: MAIN_AGENT_ID,
        sessionKey: mainKey(projectId),
        projectId,
        priority: 'low',
        dedupeKind: true,
        message: `프로젝트 ${projectId}의 팀원 ${list.length}명은 모델이 정해져 있지 않습니다: ${list.map((m) => `${m.name}(${m.id}, ${roleOf(ctx, m.roleId)?.name ?? m.roleId}, ${(m.pendingAi ?? m.ai).kind})`).join(', ')}. list_ai_options로 모델마다의 장점(models)과 안내(guide)를 보고, 맡은 일에 맞게 set_member_ai(member_id, model, effort_tier, reason)로 한 명씩 모델과 노력치를 정하세요 — 한 번 정하면 그 직원의 AI는 바꿀 수 없습니다(바꾸려면 replace_member).`,
      });
    }
    return missing;
  }

  /** 열린 세션 중 이 AI 설정을 쓰지 않고 첫 턴에 고정한 모델·노력치를 끝까지 쓰는 것 (19.1 진행 중 세션은 바꾸지 않음, F9) */
  sessionsKeepingPrevious(member: Member, ai: AiConfig): string[] {
    if (member.isMain) return [];
    const model = this.modelValue(ai);
    const effort = this.effortValue(ai);
    return this.ctx.store.sessions
      .list({ ref1: member.id, state: 'open' })
      .filter((s) => s.aiKind === ai.kind && s.model !== undefined && (this.modelFor(s.aiKind, s.model) !== model || this.effortFor(s.aiKind, s.effort ?? null) !== effort))
      .map((s) => s.workKey);
  }

  /** CLI 실제 노력치 값 (ROLE-03). 예전 목록에만 있던 값은 지금 목록 값으로 (windows:F7) */
  effortValue(ai: AiConfig): string {
    return normalizeEffort(ai.kind, ai.effortOverride ?? this.ctx.settings().team.effortMapping[ai.kind][ai.effortTier]);
  }

  /** 세션에 고정된 노력치 값을 실행 값으로 (예전 값은 지금 목록 값으로) */
  effortFor(kind: AiKind, effort: string | null): string | null {
    return effort === null ? null : normalizeEffort(kind, effort);
  }

  /**
   * CLI에 넘길 모델 (19.1). 정하지 않은 Codex 팀원은 모델 목록 첫 항목 — Codex는 대표 개인 설정(config.toml)을 읽지 않고 실행하므로
   * 정하지 않으면 CLI 내장 기본 모델로 바뀐다 (windows:F1). Claude는 null(CLI 기본)
   */
  modelValue(ai: Pick<AiConfig, 'kind' | 'model'>): string | null {
    return this.modelFor(ai.kind, ai.model);
  }

  /** 세션에 고정된 모델 등 — null이면 그 AI 종류의 기본 모델 */
  modelFor(kind: AiKind, model: string | null | undefined): string | null {
    return model ?? this.defaultModel(kind);
  }

  /** 모델을 정하지 않았을 때 쓰는 모델: Codex = 운영 설정 모델 목록 첫 항목(없으면 null), Claude = null(CLI 기본) */
  defaultModel(kind: AiKind): string | null {
    return kind === 'codex' ? (this.ctx.settings().team.modelCatalog?.codex?.[0]?.id ?? null) : null;
  }

  /**
   * 새 팀원의 역할과 AI 설정 — 저장 전 검사(역할, AI 종류·노력치, 모델 이름, 메인이 고른 모델은 운영 설정 목록 안). 팀원 추가(insertMember)와, 프로듀서 교체가
   * 그 프로듀서를 멈추기 전에 같은 검사를 한다 (리드 결정 S5-80 1)
   */
  private memberAi(roleId: string, input: AiConfigInput | undefined, actor: Actor): { role: Role; ai: AiConfig } {
    const role = roleOf(this.ctx, roleId);
    if (!role) throw new BackendError('invalid', `역할 ${roleId}을(를) 찾을 수 없습니다`);
    const ai = this.resolveAi(role, input);
    if (actor === MAIN_AGENT_ID) {
      this.assertCatalogModel(ai.kind, input?.model);
      // AI를 직접 정해 추가하면 그것이 메인의 결정이다(결정 요청이 가지 않는다) — 모델도 정해야 한다. 아무것도 정하지 않은 추가는 역할 기본값이고,
      // 모델은 이어지는 결정 요청(requestAiDecision → set_member_ai)에서 정한다
      if (hasExplicitAi(input)) {
        this.assertModelDecided(ai);
        this.assertEffortDecided(input);
      }
    }
    return { role, ai };
  }

  insertMember(
    input: { id?: string; projectId: string; roleId: string; name?: string; isProducer?: boolean; ai?: AiConfigInput; reason?: string },
    actor: Actor,
  ): Member {
    const ctx = this.ctx;
    const { role, ai } = this.memberAi(input.roleId, input.ai, actor);
    const now = ctx.now();
    const explicitAi = hasExplicitAi(input.ai);
    const m: Member = {
      id: input.id ?? ctx.store.nextId('member'),
      projectId: input.projectId,
      name: this.uniqueName(input.projectId, input.name, actor),
      roleId: role.id,
      isProducer: !!input.isProducer,
      isMain: false,
      ai,
      pendingAi: null,
      aiDecision: explicitAi ? { by: actor, reason: input.reason ?? (actor === OWNER ? '대표 지정' : actor === OPERATOR ? '운영자 지정' : '메인 에이전트 판단'), at: now } : { by: 'system', reason: '역할 기본값', at: now },
      mockScenario: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      replacedById: null,
      runSeconds: 0,
    };
    ctx.store.members.insert(m);
    ctx.activity({
      kind: 'system',
      actor,
      projectId: m.projectId,
      memberId: m.id,
      text: `팀원 추가 ${m.id} ${m.name} (${role.name}, ${m.ai.kind}${m.ai.model ? ` ${m.ai.model}` : ''}, 노력치 ${this.effortValue(m.ai)})${input.reason ? ` — ${input.reason}` : ''}`,
    });
    return m;
  }

  add(input: { projectId: string; roleId: string; name?: string; ai?: AiConfigInput; reason?: string }, actor: Actor): Member {
    const ctx = this.ctx;
    projectOrThrow(ctx, input.projectId);
    if (input.roleId === 'producer') throw new BackendError('invalid', '프로듀서는 프로젝트마다 1명입니다. 교체를 이용하세요');
    const m = this.insertMember(input, actor);
    // 운영자(시험·복구 준비, 내부 API)가 넣은 팀원은 운영자가 정한 구성 그대로 둔다 — 메인 에이전트는 필요하면 스스로 set_member_ai로 바꾼다
    if (actor !== OPERATOR) this.requestAiDecision(m);
    ctx.bus.signal('tick');
    return m;
  }

  /**
   * AI 설정을 메인 에이전트가 정하도록 요청 (19.1). 메인 에이전트가 이미 정한 팀원은 제외. 같은 세션의 요청은 한 턴으로 묶인다.
   * 팀원 AI는 늘 메인 에이전트가 정한다 — 대표 고정·결정 끄기 설정은 없다 (v0.6, SERVER_DESIGN 2.7)
   */
  requestAiDecision(m: Member): void {
    const ctx = this.ctx;
    if (m.isMain || !m.projectId) return;
    if (m.aiDecision?.by === MAIN_AGENT_ID) return;
    const role = roleOf(ctx, m.roleId);
    enqueue(ctx, {
      kind: 'message',
      memberId: MAIN_AGENT_ID,
      sessionKey: mainKey(m.projectId),
      projectId: m.projectId,
      priority: 'low',
      dedupeKind: true,
      message: `프로젝트 ${m.projectId}에 팀원 ${m.name}(${m.id}, ${role?.name ?? m.roleId})이(가) 추가됐습니다. 지금은 역할 기본값(${m.ai.kind}, 모델 ${m.ai.model ?? '정하지 않음'}, 노력치 ${this.effortValue(m.ai)})입니다. list_ai_options로 선택지를 보고, 맡을 일에 맞게 set_member_ai로 AI 종류·모델·노력치를 정하세요(사유 필수). 모델과 노력치를 함께 정합니다(model, effort_tier 또는 effort) — 빠지면 거부됩니다. 무엇을 고를지는 list_ai_options의 models(모델마다의 장점)와 guide를 보세요. 한 번 정하면 그 직원의 AI는 바꿀 수 없습니다 — 바꾸려면 퇴직시키고 새로 채용합니다(replace_member·replace_producer).`,
    });
  }

  /** 팀원 설정 변경 (MBR-06) — 메인 에이전트(update_member: 이름·역할), 운영자(내부 API: 시험 준비의 모의 시나리오 등) */
  update(id: string, patch: { name?: string; roleId?: string; ai?: AiConfigInput; mockScenario?: MockScenario | null }, actor: Actor): Member {
    const ctx = this.ctx;
    // 삭제된 팀원은 바꾸지 않는다 — 교체된 프로듀서면 지금 프로듀서도 알린다 (리드 결정 S5-74)
    const m = liveMemberOrThrow(ctx, id);
    let next: Member = { ...m, updatedAt: ctx.now() };
    if (patch.name?.trim() && patch.name.trim() !== m.name) next.name = this.renamed(m, patch.name.trim(), actor);
    if (patch.roleId && patch.roleId !== m.roleId) {
      if (m.isProducer || m.isMain || patch.roleId === 'producer') throw new BackendError('invalid', '프로듀서·메인 에이전트의 역할은 바꿀 수 없습니다');
      if (!roleOf(ctx, patch.roleId)) throw new BackendError('invalid', `역할 ${patch.roleId}을(를) 찾을 수 없습니다`);
      next.roleId = patch.roleId;
    }
    if (patch.mockScenario !== undefined) next.mockScenario = patch.mockScenario;
    // 메인 에이전트의 AI는 메인 자리에서만 바뀐다 (리드 결정 S4-2 — 자리를 바꾸는 곳은 SeatService.assign 하나)
    if (m.isMain && patch.ai) {
      throw new BackendError('forbidden', '메인 에이전트의 AI는 메인 자리에서만 바뀝니다 — 운영 설정의 메인 AI(general.mainAgent)나 메인 에이전트의 자리 넘기기(hand_off_seat)로 바꾸세요');
    }
    let kept: string[] = [];
    if (patch.ai) {
      const role = roleOf(ctx, next.roleId) ?? roleOf(ctx, 'developer')!;
      const base: AiConfigInput = { kind: next.ai.kind, model: next.ai.model, effortTier: next.ai.effortTier, effortOverride: next.ai.effortOverride, ...definedOnly(patch.ai) };
      const ai = this.resolveAi(role, base);
      kept = this.sessionsKeepingPrevious(m, ai);
      next = this.stageAi(next, ai);
      next.aiDecision = { by: actor, reason: actor === OWNER ? '대표 지정' : actor === OPERATOR ? '운영자 지정' : '변경', at: ctx.now() };
    }
    ctx.store.members.put(next);
    ctx.activity({
      kind: 'settings',
      actor,
      projectId: m.projectId,
      memberId: id,
      text: `팀원 설정 변경 ${id}${next.pendingAi ? ' (진행 중 작업 뒤 적용)' : ''}${kept.length ? ` — 진행 중 세션은 이전 AI 설정 유지: ${kept.join(', ')}` : ''}`,
    });
    // 검수자를 검수 권한이 없는 역할로 옮겼으면 그 팀원이 맡은 검수를 지금 다시 정한다 (리드 결정 S5-13)
    if (next.roleId !== m.roleId) this.repickIneligibleReviewers([id], `검수자 ${id}의 역할 변경`);
    return next;
  }

  /**
   * 검수 자격을 잃은 팀원이 맡은 검수를 지금 다시 정한다 (리드 결정 S5-13): 역할의 검수 권한을 끄거나(update_role) 검수자를 검수 권한이 없는 역할로
   * 옮기면(update_member) 끝나지 않은 작업 가운데 그 팀원이 더는 검수할 수 없는 것의 검수자를 기본 규칙으로 다시 고른다. 그대로 두면 대기·실행 중인 그
   * 검수는 submit_review가 거부된 뒤에야 재배정 길로 간다. 팀원 삭제(remove)와 같은 길(tasks.changeReviewer)이다
   */
  repickIneligibleReviewers(memberIds: readonly string[], reason: string): void {
    const ctx = this.ctx;
    for (const id of memberIds) {
      const m = ctx.store.members.get(id);
      if (!m?.projectId || m.deletedAt) continue;
      for (const t of ctx.store.tasks.list({ project_id: m.projectId, state: ['waiting', 'in_progress', 'in_review', 'on_hold'] })) {
        if (t.reviewerId !== id || canBeReviewer(m, roleOf(ctx, m.roleId), t).ok) continue;
        this.core.tasks.changeReviewer(t.id, this.core.tasks.resolveReviewer(taskOrThrow(ctx, t.id), null), reason);
      }
    }
  }

  /** 메인 에이전트의 AI 설정 결정 (19.1) — 팀원 AI는 늘 메인 에이전트가 정한다. 대표 고정은 없다 (v0.6, CTL-06의 새 뜻) */
  setAiByMain(memberId: string, input: AiConfigInput, reason: string): Member {
    const ctx = this.ctx;
    const m = memberOrThrow(ctx, memberId);
    if (m.isMain) throw new BackendError('forbidden', '메인 에이전트 자신의 AI는 운영 설정(처음 보유자)으로 정해집니다 (AGT-08)');
    // 삭제된 팀원은 정하지 않는다 — 교체된 프로듀서면 지금 프로듀서도 알린다 (리드 결정 S5-74)
    liveMemberOrThrow(ctx, memberId);
    // 한 번 정한 직원의 AI는 바꾸지 않는다 — 다른 모델·노력치가 필요하면 퇴직시키고 새로 채용한다 (대표 지시 2026-11-18)
    if (this.aiFixed(m)) {
      const fixed = m.pendingAi ?? m.ai;
      throw new BackendError(
        'forbidden',
        `${m.name}(${m.id})의 AI는 이미 정해졌습니다(${fixed.kind} ${this.modelValue(fixed) ?? 'CLI 기본 모델'}, 노력치 ${this.effortValue(fixed)}) — 한 번 정한 직원의 AI는 바꿀 수 없습니다. 다른 모델이나 노력치가 필요하면 ${
          m.isProducer ? `replace_producer(project_id="${m.projectId}", …)` : `replace_member(member_id="${m.id}", …)`
        }로 이 직원을 퇴직시키고 새 직원을 채용하세요 — 하던 일은 새 직원에게 넘어갑니다`,
      );
    }
    // 메인이 이 직원을 처음 정하는가 — 그때는 모델과 노력치를 함께 정한다. 이 규칙 전에 메인이 정했지만 모델이 빈 직원은 모델만 채워도 된다
    const firstByMain = m.aiDecision?.by !== MAIN_AGENT_ID;
    const role = roleOf(ctx, m.roleId) ?? roleOf(ctx, 'developer')!;
    // 생략한 항목(undefined)은 지금 값을 유지한다 — 펼친 undefined가 AI 종류를 역할 기본값으로 되돌리지 않게
    const given = definedOnly(input);
    const base: AiConfigInput = { kind: m.ai.kind, model: m.ai.model, effortTier: m.ai.effortTier, effortOverride: m.ai.effortOverride, ...given };
    if (given.kind && given.kind !== m.ai.kind && given.model === undefined) base.model = null;
    if (given.kind && given.kind !== m.ai.kind && given.effortOverride === undefined) base.effortOverride = null;
    const ai = this.resolveAi(role, base);
    // 저장 전에 검사 — 거부되면 아무것도 바뀌지 않는다. 실제로 돌 AI 종류의 목록으로 본다
    this.assertCatalogModel(ai.kind, input.model);
    this.assertModelDecided(ai);
    if (firstByMain) this.assertEffortDecided(given);
    const kept = this.sessionsKeepingPrevious(m, ai);
    let next = this.stageAi({ ...m, updatedAt: ctx.now() }, ai);
    next = { ...next, aiDecision: { by: MAIN_AGENT_ID, reason, at: ctx.now() } };
    ctx.store.members.put(next);
    ctx.activity({
      kind: 'settings',
      actor: MAIN_AGENT_ID,
      projectId: m.projectId,
      memberId,
      text: `메인 에이전트가 ${m.name} AI 설정 결정: ${ai.kind}${ai.model ? ` ${ai.model}` : ''}, 노력치 ${this.effortValue(ai)}${next.pendingAi ? ' (진행 중 작업 뒤 적용)' : ''}${kept.length ? ` — 진행 중 세션은 이전 설정 유지: ${kept.join(', ')}` : ''}`,
      result: reason,
    });
    return next;
  }

  /**
   * 메인 자리에 앉힐 AI 설정 (hand_off_seat, 리드 결정 S4-3) — set_member_ai와 같은 검사다. 생략한 칸은 base를 따른다(같은 종류면 지금 값, 다른 종류면
   * 모델·노력치 값 없이 단계만). 모델은 그 종류의 모델 목록 id나 null(CLI 기본 모델)만, 노력치 값은 그 종류의 값만 받는다
   */
  mainSeatAi(base: AiConfig, given: AiConfigInput): AiConfig {
    const input = { ...base, ...definedOnly(given) };
    const model = input.model?.trim() || null;
    if (model && BAD_MODEL_RE.test(model)) throw new BackendError('invalid', `${input.kind} 모델 이름에 공백·제어 문자를 쓸 수 없습니다: "${model}" (list_ai_options의 models에 있는 id를 쓰세요)`);
    this.assertCatalogModel(input.kind, given.model, true);
    const effortOverride = input.effortOverride || null;
    if (effortOverride && !EFFORT_LEVELS[input.kind].includes(effortOverride)) {
      throw new BackendError('invalid', `${input.kind} 노력치 값은 ${EFFORT_LEVELS[input.kind].join('|')} 중 하나여야 합니다`);
    }
    return { kind: input.kind, model, effortTier: input.effortTier ?? base.effortTier, effortOverride };
  }

  /** 활성 작업·실행 중 턴이 있으면 보류해 두고, 없으면 바로 적용 */
  private stageAi(m: Member, ai: AiConfig): Member {
    const busy = !!activeTaskOf(this.ctx, m.id) || this.core.turns.isMemberRunning(m.id);
    return busy ? { ...m, pendingAi: ai } : { ...m, ai, pendingAi: null };
  }

  /**
   * 활성 작업·실행 중 턴이 없으면 보류해 둔 AI 설정을 적용한다.
   * ignore: 지금 막 시작하는 턴과 그 턴이 활성화한 작업은 세지 않는다 — 턴 시작(begin)에서 부르면 그 턴 자신 때문에 늘 적용되지 않았다 (CONC-12)
   */
  applyPendingAiIfIdle(memberId: string, ignore: { turnId?: string; taskId?: string | null } = {}): void {
    const ctx = this.ctx;
    const m = ctx.store.members.get(memberId);
    if (!m?.pendingAi) return;
    const active = activeTaskOf(ctx, memberId);
    if ((active && active.id !== ignore.taskId) || this.core.turns.isMemberRunning(memberId, ignore.turnId)) return;
    ctx.store.members.put({ ...m, ai: m.pendingAi, pendingAi: null, updatedAt: ctx.now() });
    ctx.activity({ kind: 'settings', projectId: m.projectId, memberId, text: `${m.name} AI 설정 변경 적용 (${m.pendingAi.kind}, 노력치 ${this.effortValue(m.pendingAi)})` });
  }

  remove(id: string, actor: Actor): void {
    const ctx = this.ctx;
    const m = memberOrThrow(ctx, id);
    if (m.isMain) throw new BackendError('forbidden', '메인 에이전트는 삭제할 수 없습니다');
    if (m.isProducer) throw new BackendError('forbidden', '프로듀서는 삭제할 수 없고 교체만 할 수 있습니다 (ORG-04)');
    if (m.deletedAt) return;
    const open = openTasksOf(ctx, id);
    if (open.length) throw new BackendError('conflict', `진행 중인 작업이 있습니다 (${open.map((t) => t.id).join(', ')}). 먼저 재배정하거나 취소하세요`);
    const reviewing = ctx.store.tasks.list({ project_id: m.projectId!, state: ['waiting', 'in_progress', 'in_review', 'on_hold'] }).filter((t) => t.reviewerId === id);
    cancelQueued(ctx, (q) => q.memberId === id, `${m.name} 팀원이 삭제됨`);
    ctx.store.tx(() => {
      ctx.store.members.put({ ...m, deletedAt: ctx.now(), updatedAt: ctx.now() });
      this.forgetMemberStop(m, actor, '팀원 삭제');
    });
    // 실행 중인 턴(검수 등)을 끝낸다. 정지 표시는 바로 남으므로 끝난 턴이 삭제된 팀원 몫으로 다시 넣지 않는다 (F5, CONC-11). 그 턴의 마무리가 남은 프로세스를
    // 찾으면 삭제된 팀원은 일시정지하지 않고 메인에게 넘긴다 — 검수 턴은 그 작업 보류, 관리 턴은 그 세션의 알림 (blockUnconfirmedRun, 리드 결정 S5-62)
    void this.core.turns.stopMember(id, '팀원 삭제', true);
    this.core.turns.closeMemberSessions(id, '팀원 삭제');
    // 맡던 검수는 삭제 표시 뒤에 다시 정한다 — 삭제된 팀원이 적격 목록에서 빠진 채 고르고, 대기·실행 중이던 검수를 새 검수자에게 넘긴다.
    // 대기 항목을 지운 뒤라야 새 검수 항목이 삭제된 팀원의 항목에 합쳐졌다가 함께 지워지지 않는다
    for (const t of reviewing) this.core.tasks.changeReviewer(t.id, this.core.tasks.resolveReviewer(taskOrThrow(ctx, t.id), null), '검수자 삭제');
    ctx.activity({ kind: 'system', actor, projectId: m.projectId, memberId: id, text: `팀원 삭제 ${id} ${m.name}` });
  }

  // ───────────────────────── 직원 교체: 퇴직 → 채용 → 인수인계 (대표 지시 2026-11-18) ─────────────────────────

  /** 작업마다의 인수인계 기록 (kv) — 요청(asked), 지금 담당이 남긴 메모(memo), 넘긴 내역(history) */
  handoverState(taskId: string): HandoverState {
    return this.ctx.store.kv.get<HandoverState>(handoverKey(taskId)) ?? { history: [] };
  }

  /** 작업 카드에 싣는 인수인계 — 이 작업이 넘어온 내역(최근 3건)과 앞 담당의 메모 */
  handoversFor(taskId: string): TaskHandover[] {
    return this.handoverState(taskId).history.slice(-3);
  }

  /**
   * 퇴직하는 담당이 남기는 인수인계 메모 (팀원 도구 write_handover) — 그 작업의 지금 담당만 남긴다. 교체가 메모를 기다리는 중이면(asked) 메인 에이전트에게
   * 메모가 왔다고 알린다
   */
  writeHandover(member: Member, task: Task, memo: string): { taskId: string; saved: true; note: string } {
    const ctx = this.ctx;
    const text = memo.trim();
    if (!text) throw new BackendError('invalid', 'memo(인수인계 메모)를 적으세요 — 지금까지 한 일, 남은 일, 주의할 점');
    if (task.assigneeId !== member.id) throw new BackendError('forbidden', `${task.id}의 담당만 인수인계 메모를 남깁니다`);
    const st = this.handoverState(task.id);
    const asked = st.asked?.memberId === member.id;
    ctx.store.kv.set(handoverKey(task.id), { ...st, memo: { memberId: member.id, memberName: member.name, text: ctx.redact.text(text), at: ctx.now() } });
    ctx.activity({ kind: 'task', actor: member.id, projectId: task.projectId, taskId: task.id, memberId: member.id, text: `${member.name} 인수인계 메모 남김 (${task.id})` });
    if (asked) {
      enqueue(ctx, {
        kind: 'message',
        memberId: MAIN_AGENT_ID,
        sessionKey: mainKey(task.projectId),
        projectId: task.projectId,
        dedupeKind: true,
        message: `${member.name}(${member.id})이(가) 작업 ${task.id}의 인수인계 메모를 남겼습니다. replace_member(member_id="${member.id}", …)를 같은 인자로 다시 부르면 새 직원을 채용해 그 작업을 넘기고 ${member.name}을(를) 퇴직시킵니다.`,
      });
      ctx.bus.signal('tick');
    }
    return { taskId: task.id, saved: true, note: '인수인계 메모를 남겼습니다. 이 작업을 더 진행하지 말고 턴을 마치세요 — 프로그램이 후임에게 넘깁니다.' };
  }

  /**
   * 직원 교체 — 지금 직원을 퇴직시키고 새 직원을 채용한다. 한 번 정한 직원의 AI는 바꿀 수 없으므로 다른 모델·노력치가 필요할 때의 길이다. 프로듀서는
   * replaceProducer로 바꾼다.
   * - 새 직원의 AI(종류·모델·노력치)는 메인 에이전트가 채용할 때 정한다 — 빠지면 거부
   * - 퇴직하는 직원의 끝나지 않은 작업은 모두 새 직원에게 넘긴다(재배정 — 작업 폴더와 끝낸 단계는 작업에 남는다). 검수하던 작업은 기본 규칙으로 다시 정한다
   * - 인수인계(handover 'ask'): 지금 하고 있는 작업(진행 중)이 있으면 그 직원에게 인수인계 메모를 먼저 요청하고 바꾸지 않은 채 conflict로 거부한다 — 메모가 오면 메인에게 알리고,
   *   메인이 다시 부르면 바꾼다. 하고 있는 작업이 없거나 메모가 이미 있으면 바로 바꾼다. 'skip'이면 메모 없이 바로 바꾼다(그 직원이 답할 수 없을 때)
   * - 어느 작업이든 지금 담당을 바꿀 수 없으면(병합 처리 중 등) 아무것도 바꾸지 않고 거부한다
   */
  replaceMember(id: string, input: { name?: string; roleId?: string; ai?: AiConfigInput; reason: string; handover: 'ask' | 'skip' }): ReplaceMemberResult {
    const ctx = this.ctx;
    const old = liveMemberOrThrow(ctx, id);
    if (old.isMain) throw new BackendError('forbidden', '메인 에이전트는 교체할 수 없습니다 — 메인 자리는 hand_off_seat로 넘깁니다');
    if (old.isProducer) throw new BackendError('invalid', `${old.name}(${old.id})은(는) 프로듀서입니다 — replace_producer(project_id="${old.projectId}", …)로 교체하세요`);
    const roleId = input.roleId ?? old.roleId;
    if (roleId === 'producer') throw new BackendError('invalid', '프로듀서는 프로젝트마다 1명입니다 — 프로듀서 역할로는 채용할 수 없습니다');
    if (!hasExplicitAi(input.ai)) {
      throw new BackendError(
        'invalid',
        '새 직원의 AI를 정하지 않았습니다 — 채용할 때 ai_kind·model·effort_tier(또는 effort)를 함께 정합니다. 무엇을 고를지는 list_ai_options의 models(모델마다의 장점)와 guide를 보세요',
      );
    }
    // 저장 전 검사 — 거부되면 아무것도 바뀌지 않는다
    this.memberAi(roleId, input.ai, MAIN_AGENT_ID);
    const open = openTasksOf(ctx, id);
    for (const t of open) {
      const why = this.core.tasks.reassignBlocker(t);
      if (why) throw new BackendError('conflict', `${old.name}(${old.id})이(가) 맡은 작업을 지금 넘길 수 없어 교체하지 않았습니다 — ${why}`);
    }
    if (input.handover === 'ask') {
      const waiting = open.filter((t) => t.state === 'in_progress' && this.handoverState(t.id).memo?.memberId !== id);
      if (waiting.length) {
        for (const t of waiting) this.askHandover(old, t);
        // 결과가 아니라 거부로 돌려준다 — 성공한 결과는 request_id로 저장돼, 같은 request_id로 다시 부르면 그 결과만 되돌아오고 교체가 끝나지 않는다.
        // 프로듀서 교체가 '한 번 거부하고 다시 부르면 바꾼다'로 하는 것과 같은 꼴이다
        throw new BackendError(
          'conflict',
          `인수인계 대기: ${old.name}(${id})이(가) 하고 있는 작업 ${waiting.map((t) => t.id).join(', ')}의 인수인계 메모를 요청했습니다 — 아직 아무것도 바꾸지 않았습니다. 메모가 오면 알려 드리니 그때 같은 인자로 replace_member를 다시 부르세요. 그 직원이 답할 수 없으면(사용량 한도·시작 실패 등) handover: "skip"으로 부르면 메모 없이 바로 바꿉니다.`,
        );
      }
    }
    const fromAi = `${old.ai.kind} ${this.modelValue(old.ai) ?? 'CLI 기본 모델'}, 노력치 ${this.effortValue(old.ai)}`;
    const hired = this.insertMember({ projectId: old.projectId!, roleId, name: input.name, ai: input.ai, reason: input.reason }, MAIN_AGENT_ID);
    const tasks: { taskId: string; memo: boolean }[] = [];
    for (const t of open) {
      const st = this.handoverState(t.id);
      const memo = st.memo?.memberId === id ? st.memo.text : null;
      this.core.tasks.reassign(t.id, hired.id, MAIN_AGENT_ID);
      ctx.store.kv.set(handoverKey(t.id), {
        history: [...st.history, { fromId: id, fromName: old.name, fromAi, toId: hired.id, toName: hired.name, at: ctx.now(), state: t.state, memo }],
      } satisfies HandoverState);
      tasks.push({ taskId: t.id, memo: memo !== null });
    }
    this.remove(id, MAIN_AGENT_ID);
    ctx.activity({
      kind: 'system',
      actor: MAIN_AGENT_ID,
      projectId: old.projectId,
      memberId: hired.id,
      text: `직원 교체: ${old.name}(${id}, ${fromAi}) 퇴직 → ${hired.name}(${hired.id}, ${hired.ai.kind} ${this.modelValue(hired.ai) ?? 'CLI 기본 모델'}, 노력치 ${this.effortValue(hired.ai)}) 채용${
        tasks.length ? ` — 넘긴 작업 ${tasks.map((x) => `${x.taskId}(${x.memo ? '인수인계 메모 있음' : '메모 없음'})`).join(', ')}` : ' — 넘긴 작업 없음'
      }`,
      result: input.reason,
    });
    ctx.bus.signal('tick');
    return { retired: old, hired: ctx.store.members.require(hired.id), tasks };
  }

  /** 퇴직하는 담당에게 그 작업의 인수인계 메모를 요청한다 — 그 작업 세션의 다음 턴에 전달된다. 이미 요청했으면 다시 보내지 않는다 */
  private askHandover(old: Member, task: Task): void {
    const ctx = this.ctx;
    const st = this.handoverState(task.id);
    if (st.asked?.memberId === old.id) return;
    ctx.store.kv.set(handoverKey(task.id), { ...st, asked: { memberId: old.id, at: ctx.now() } });
    enqueue(ctx, {
      kind: 'message',
      memberId: old.id,
      sessionKey: taskKey(task.id),
      projectId: task.projectId,
      taskId: task.id,
      directiveId: task.directiveId,
      message: `퇴직 인수인계 요청 (메인 에이전트): 너는 이 작업(${task.id})을 후임에게 넘기고 퇴직한다. 이 작업을 더 진행하지 말고 write_handover(memo)로 인수인계 메모를 남겨라 — 지금까지 한 일, 남은 일과 다음에 할 것, 주의할 점, 확인하지 못한 것. 커밋하지 않은 변경이 작업 폴더에 있으면 그것도 적는다. 메모를 남긴 뒤 턴을 마쳐라.`,
    });
    ctx.activity({ kind: 'message', actor: MAIN_AGENT_ID, projectId: task.projectId, taskId: task.id, memberId: old.id, text: `${old.name}에게 인수인계 메모 요청 (${task.id}) — 직원 교체 전` });
    ctx.bus.signal('tick');
  }

  /**
   * 프로듀서 교체 (ORG-04). 지금 프로듀서의 턴을 먼저 멈추고, 멈춘 턴의 마무리·종료 판정이 끝날 때까지 (상한까지) 기다린 뒤 턴마다 결과를 센다 — 그동안 그 프로듀서의
   * 새 턴은 띄우지 않는다 (리드 결정 S5-73 1). 그다음 거부하거나 바꾼다:
   * - 기다린 뒤에는 부른 메인 턴·자리 세대를 다시 본다(o.recheck — 리드 결정 S5-63). 그사이 자리가 바뀌었거나 그 턴이 끝났으면 바꾸지 않는다
   * - 그 정지가 남은 프로세스를 남기면(정지 결과의 종료 확인 실패, 또는 그 턴의 마무리가 적은 kill_failed — CTL-11) 바꾸지 않고 conflict (리드 결정 S5-62 1).
   *   메인이 확인한 뒤 다시 부르면 바꾼다 — 일시정지된 프로듀서도 바꾼다
   * - 바꾸는 트랜잭션이 거부하면(기다리는 사이 다른 교체가 먼저 끝남, 그사이 운영 설정의 모델 목록이 바뀜 등) 바꾸지 않는다
   * 멈추지 않고도 알 수 있는 거부(새 프로듀서의 역할·AI 인자)는 멈추기 전에 한다 — 그 거부는 어느 턴도 건드리지 않는다 (리드 결정 S5-80 1).
   * 멈춘 뒤에 거부하면(어느 거부든) 멈춘 일은 남기지 않는다 — 정지가 확인된 작업 턴은 같은 프로듀서에게 다시 맡기고(resumeStopped), 관리·검수 턴은 그 판정이 이미
   * 다시 넣었고, 남은 프로세스는 그 마무리가 CTL-11대로 막아 메인에게 넘겼다. 거부 글과 그 활동 기록은 한 곳(stoppedTurnsText)이 그 결과로 쓴다 (리드 결정 S5-73 2·3·S5-80 2).
   * 같은 프로듀서를 바꾸는 다른 호출이 아직 끝나지 않았으면 그 호출이 바꿀 수 있다 — 거부하는 호출은 멈춘 일을 맡기지 않고 남겨 두고(마지막 호출이 바꾸지 않고 끝나면
   * 그때 맡긴다), 글은 다른 교체 요청이 진행 중이라는 것만 쓰고 결과를 말하지 않는다 (리드 결정 S5-90 1).
   * 지운 프로듀서의 정지 기록은 지우는 트랜잭션에서 함께 지운다 (리드 결정 S5-64)
   */
  async replaceProducer(projectId: string, input: { name?: string; ai?: AiConfigInput }, actor: Actor, o: { recheck?: (already?: () => string) => void } = {}): Promise<Member> {
    const ctx = this.ctx;
    const project = projectOrThrow(ctx, projectId);
    const old = memberOrThrow(ctx, project.producerId);
    // 멈추기 전에 본다 — 새 프로듀서의 역할과 AI 인자(종류·모델·노력치, 메인이 고른 모델은 운영 설정 목록 안). 바꾸는 트랜잭션이 같은 검사를 다시 한다(그사이 설정이
    // 바뀔 수 있다). 프로젝트·지금 프로듀서는 위에서, 사유·권한·메인이 아직 받지 않은 알림은 부르는 쪽(도구 처리기, 대표 게이트)이 이미 봤다. 이름은 거부할 것이 없다 —
    // 겹치면 바꿔 붙인다(uniqueName) (리드 결정 S5-80 1)
    this.memberAi('producer', input.ai, actor);
    // 정지와 그 마무리를 기다리는 동안 그 프로듀서의 새 턴은 띄우지 않는다 — 멈춘 턴의 판정이 다시 넣은 일로 곧바로 새 턴이 뜨면 결과를 셀 수 없고, 바꾸면 지운
    // 팀원의 턴이 살아 남는다. 거부하든 바꾸든 끝나면 푼다 (리드 결정 S5-73 1)
    const release = this.core.turns.holdLaunches(old.id);
    // 이 프로듀서를 바꾸는 중인 호출로 센다 — 다른 호출이 거부할 때 이 호출이 아직 바꿀 수 있는지 본다 (리드 결정 S5-90 1)
    const run = this.replacing.get(old.id) ?? { calls: 0, deferred: new Map<string, StoppedTurn>() };
    this.replacing.set(old.id, run);
    run.calls += 1;
    try {
      const stopped = await this.core.turns.stopMember(old.id, '프로듀서 교체', true);
      const settled = stopped.length ? await this.core.turns.settleTurns(stopped.map((s) => s.turnId), PRODUCER_STOP_SETTLE_MS) : new Set<string>();
      // 남은 프로세스: 정지 결과가 종료 확인 실패이거나, 결과는 확인됐어도 그 턴의 마무리가 남은 프로세스를 적었다(kill_failed — 프로세스가 끝나며 남은 수를 알림).
      // 상한 안에 마무리가 끝나지 않은 확인된 정지는 지운 뒤에 그 마무리가 지운 팀원의 세션 알림으로 메인에게 넘긴다 (blockUnconfirmedRun, 리드 결정 S5-62 2·S5-76 5)
      const turns: StoppedTurn[] = stopped.map((s) => ({
        stop: s,
        kind: parseKey(s.sessionKey).kind,
        leftover: !s.ok || ctx.store.turns.get(s.turnId)?.process.state === 'kill_failed',
        settled: settled.has(s.turnId),
      }));
      // 거부할 때만 한 번: 멈춘 일을 같은 프로듀서 앞에 다시 두고(리드 결정 S5-73 2) 그 뒤의 사실을 적는다. 같은 프로듀서를 바꾸는 다른 호출이 아직 끝나지 않았으면
      // 그 호출이 바꿀 수 있다 — 멈춘 일은 맡기지 않고 남겨 두고(마지막 호출이 정한다), 글은 누가 이을지 말하지 않는다 (리드 결정 S5-90 1)
      let said: StoppedTurnsText | null = null;
      const refusing = (): StoppedTurnsText => {
        if (!said) {
          const others = run.calls > 1;
          if (others) for (const t of turns) run.deferred.set(t.stop.turnId, t);
          else {
            // 마지막 호출이다 — 제 턴을 맡긴다. 같은 턴은 이 호출의 것으로 한 번만, 앞서 거부한 호출이 남긴 다른 턴은 이 호출이 끝날 때(finally) 맡긴다
            for (const t of turns) run.deferred.delete(t.stop.turnId);
            this.resumeStopped(old, turns);
          }
          said = stoppedTurnsText(ctx, old, turns, others);
        }
        return said;
      };
      // 멈춘 뒤의 거부가 다는 글 — 그 턴을 멈췄다는 사실과 그 결과. 다시 보기(o.recheck)·남은 프로세스·바꾸는 트랜잭션의 거부가 모두 이 길로 간다 (리드 결정 S5-80 2)
      const already = (): string => `프로듀서 ${old.name}(${old.id})의 턴은 이미 멈췄습니다 — ${refusing().already}`;
      o.recheck?.(turns.length ? already : undefined);
      if (turns.some((t) => t.leftover)) throw new BackendError('conflict', leftoverRefusal(ctx, old, refusing()));
      return this.replaceNow(projectId, old, input, actor, turns.length ? already : undefined);
    } finally {
      run.calls -= 1;
      if (run.calls === 0) {
        this.replacing.delete(old.id);
        // 다른 호출이 기다리는 사이 거부한 호출이 남겨 둔 멈춘 일 — 마지막 호출이 바꿨으면 그 일은 교체와 함께 옮겨 갔다. 바꾸지 않았으면(거부했으면 제 턴 말고 남은 것,
        // 거부 아닌 오류로 끝났으면 모두) 여기서 같은 프로듀서에게 맡긴다. 맡길 일이 이미 대기·실행 중이면 resumeStoppedTask가 겹쳐 맡기지 않는다 (리드 결정 S5-90 1·S5-73 2)
        if (run.deferred.size && !ctx.store.members.get(old.id)?.deletedAt) this.resumeStopped(old, [...run.deferred.values()]);
      }
      release();
    }
  }

  /**
   * 프로듀서를 지금 바꾼다 (replaceProducer — 그 프로듀서의 턴을 멈추고 결과를 본 뒤). already: 멈춘 턴이 있을 때 — 바꾸는 트랜잭션이 거부하면 그 글을 달고, 그 글을
   * 만들며 멈춘 일을 다시 맡긴다 (리드 결정 S5-80 2)
   */
  private replaceNow(projectId: string, old: Member, input: { name?: string; ai?: AiConfigInput }, actor: Actor, already?: () => string): Member {
    const ctx = this.ctx;
    let fresh: Member;
    try {
      fresh = ctx.store.tx(() => {
        // 기다리는 사이 다른 교체가 먼저 끝났으면 겹쳐 바꾸지 않는다 — 프로젝트·이전 프로듀서는 지금 저장된 값으로
        const cur = projectOrThrow(ctx, projectId);
        if (cur.producerId !== old.id) throw new BackendError('conflict', `프로젝트 ${projectId}의 프로듀서가 그사이 이미 바뀌었습니다 (${memberName(ctx, cur.producerId)}(${cur.producerId})) — 지금 프로듀서를 확인하세요`);
        const nm = this.insertMember({ projectId, roleId: 'producer', name: input.name, ai: input.ai, isProducer: true }, actor);
        ctx.store.members.put({ ...memberOrThrow(ctx, old.id), isProducer: false, deletedAt: ctx.now(), replacedById: nm.id, updatedAt: ctx.now() });
        this.forgetMemberStop(old, actor, '프로듀서 교체');
        ctx.store.projects.put({ ...cur, producerId: nm.id, updatedAt: ctx.now() });
        // 대기 중 관리 업무는 새 프로듀서에게
        for (const q of ctx.store.queue.list({ ref1: old.id, state: 'queued' })) ctx.store.queue.put({ ...q, memberId: nm.id });
        return nm;
      });
    } catch (e) {
      // 트랜잭션이 되돌려져 바뀐 것은 없다 — 다른 교체가 먼저 끝났거나 그사이 운영 설정의 모델 목록이 바뀌었다. 멈춘 턴이 있으면 그 일을 남기지 않고 그 결과를 단다
      if (!already) throw e;
      const done = already();
      if (e instanceof BackendError) throw new BackendError(e.code, `${e.message} (${done})`);
      throw new Error(`${e instanceof Error ? e.message : String(e)} (${done})`);
    }
    this.core.turns.closeMemberSessions(old.id, '프로듀서 교체');
    for (const t of openTasksOf(ctx, old.id)) {
      try {
        this.core.tasks.reassign(t.id, fresh.id, actor);
      } catch (e) {
        // 병합 중·병합 반영됨·취소 중인 작업은 재배정을 받지 않는다 — 그대로 완료·취소된다. 하나 때문에 교체를 멈추지 않는다
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log('warn', `프로듀서 교체 중 재배정하지 않음 ${t.id}`, e);
        ctx.activity({ kind: 'system', level: 'warn', actor, projectId, taskId: t.id, text: `${t.id} 재배정하지 않음 (프로듀서 교체)`, result: msg });
      }
    }
    // 이전 프로듀서가 맡던 검수는 새 검수자에게 넘긴다 — 대기·실행 중이던 검수 업무까지 (F5, CONC-11)
    for (const t of ctx.store.tasks.list({ project_id: projectId, state: ['waiting', 'in_progress', 'in_review', 'on_hold'] })) {
      if (t.reviewerId === old.id) this.core.tasks.changeReviewer(t.id, this.core.tasks.resolveReviewer(taskOrThrow(ctx, t.id), null), '프로듀서 교체');
    }
    ctx.activity({ kind: 'system', actor, projectId, memberId: fresh.id, text: `프로듀서 교체 ${old.name} → ${fresh.name}` });
    ctx.bus.signal('tick');
    return fresh;
  }

  /**
   * 프로듀서 교체를 거부할 때 멈춘 일을 남기지 않는다 (리드 결정 S5-73 2). 정지가 확인된 작업 세션 턴은 그 판정(user_stop)이 다시 넣지 않는다 — 보류 해제가 이어 가기를
   * 기다리는데 이 정지에는 보류가 없다. 그 작업을 남는 프로듀서에게 다시 맡긴다(resumeStoppedTask). 그 턴의 마무리가 상한 안에 끝나지 않았으면 끝난 뒤에 본다.
   * 관리·검수 세션은 그 판정이 이미 다시 넣는다(관리 업무는 늘, 판정 전인 검수는 검수 중일 때). 남은 프로세스가 있는 정지는 그 마무리가 CTL-11대로 막고 메인에게
   * 넘긴다(작업·검수 세션은 작업 보류와 kill-failed:<작업> 알림, 관리 세션은 프로듀서 일시정지와 재개 업무)
   */
  private resumeStopped(old: Member, turns: readonly StoppedTurn[]): void {
    for (const t of turns) {
      const taskId = t.stop.taskId;
      // 정지가 오기 전에 실행을 마친 턴(마무리 중이던 것 — '이미 마친 턴')은 이 정지가 멈춘 턴이 아니다: 그 끝 까닭대로 판정이 다음 일을 정했다. 다시 맡기지 않는다
      // (리드 결정 S7-17 F1·S7-19 R1)
      if (t.kind !== 'task' || t.leftover || !taskId || t.stop.alreadyEnded) continue;
      if (t.settled) {
        // 다시 맡기다 실패해도 거부는 나간다 — 거부 글은 그때의 실제 상태(다시 이어 갈 일이 없음)를 쓴다
        try {
          t.resumed = this.resumeStoppedTask(old, taskId) ?? undefined;
        } catch (e) {
          this.ctx.log('error', `프로듀서 교체 거부 뒤 멈춘 작업 다시 맡기기 실패 ${taskId}`, e);
        }
      } else
        void this.core.turns
          .turnFlow(t.stop.turnId)
          .then(() => this.resumeStoppedTask(old, taskId))
          .catch((e: unknown) => this.ctx.log('error', `프로듀서 교체 거부 뒤 멈춘 작업 다시 맡기기 실패 ${taskId}`, e));
    }
  }

  /**
   * 프로듀서 교체가 멈췄다가 바꾸지 않은 작업 턴의 작업을 같은 프로듀서에게 다시 맡긴다 (리드 결정 S5-73 2) — 진행 중이고 담당이 그대로이며 그 작업의 일(메시지 말고)이
   * 대기·실행 중이 아닐 때만. 보류된 작업은 그 보류의 해제가, 검수·종료된 작업은 그 단계가 이어 간다. 되돌리기·제출 처리·병합 충돌이 남은 작업은 보류 해제와 같은
   * 갈래(afterRelease)로, 그 밖에는 이어서 진행하라는 일(continueWork)로. 무엇으로 이었는지 돌려준다 — 거부 글이 그대로 쓴다(제출 처리·되돌리기 단계는 프로그램이
   * 잇는다). 잇지 않았으면 null
   */
  private resumeStoppedTask(old: Member, taskId: string): ResumedAs | null {
    const ctx = this.ctx;
    if (this.core.stopping) return null;
    const t = ctx.store.tasks.get(taskId);
    if (!t || t.state !== 'in_progress' || t.assigneeId !== old.id || ctx.store.members.get(old.id)?.deletedAt) return null;
    const key = taskKey(t.id);
    if (this.core.turns.hasLiveSession(key) || ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).some((q) => q.kind !== 'message')) return null;
    const how: ResumedAs = this.core.merges.revertPending(t) ? 'revert' : t.pendingSubmit ? 'submit' : t.conflict ? 'conflict' : 'work';
    if (how !== 'work') this.core.tasks.afterRelease(t, '프로그램이 멈췄던 작업 턴을 이어 감');
    else this.core.tasks.continueWork(t.id, '프로그램이 이 작업 턴을 멈췄다가 다시 맡깁니다. get_work_context로 상태와 마지막 커밋을 확인하고 이어서 진행하세요.');
    const what = how === 'submit' ? '작업의 제출 처리를 프로그램이 이어 감' : how === 'revert' ? '되돌리기 작업의 되돌리기 단계를 프로그램이 이어 감' : `작업 턴을 ${old.name}(${old.id})에게 다시 맡김`;
    ctx.activity({ kind: 'task', projectId: t.projectId, taskId: t.id, memberId: old.id, text: `${t.id} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 ${what}` });
    return how;
  }

  /**
   * 지우는 팀원의 정지 기록을 지운다 — 지우는 트랜잭션 안에서 부른다 (리드 결정 S5-64). 남겨 두면 삭제된 팀원이 현황·요약·화면에 일시정지로 남고 아무도 풀지 않는다.
   * 그 팀원의 작업에 걸린 팀원 정지 보류는 따로 풀 것이 없다 — 지울 수 있는 팀원은 맡은 작업이 없고(remove), 프로듀서 교체는 재배정이 이전 담당의 정지 보류를 함께 푼다
   */
  private forgetMemberStop(m: Member, actor: Actor, why: string): void {
    const ctx = this.ctx;
    const s = ctx.stop();
    const was = s.members[m.id];
    if (!was) return;
    delete s.members[m.id];
    ctx.saveStop(s);
    ctx.activity({ kind: 'stop', actor, projectId: m.projectId, memberId: m.id, text: `${why}로 ${m.name}(${m.id})의 일시정지 기록을 지움 — ${memberName(ctx, was.by)}이(가) ${was.since}에 건 정지${was.reason ? ` (${was.reason})` : ''}` });
  }

  memoryPath(projectId: string | null): string {
    return projectMemoryFile(this.ctx.paths, projectId);
  }
}

/**
 * 프로듀서 교체가 멈춘 그 프로듀서의 턴 하나 (리드 결정 S5-73) — 정지 결과, 업무 세션 종류, 남은 프로세스(정지 결과의 종료 확인 실패, 또는 결과는 확인됐어도 그 턴의
 * 마무리가 적은 kill_failed), 그 턴의 마무리·종료 판정이 기다리는 상한 안에 끝났는지
 */
interface StoppedTurn {
  stop: StopResult;
  kind: SessionKind;
  leftover: boolean;
  settled: boolean;
  /** 거부한 뒤 그 작업 턴의 일을 무엇으로 이었는지 (resumeStopped — 마무리가 상한 안에 끝난 작업 세션 턴만) */
  resumed?: ResumedAs;
}

/** 거부된 교체가 멈춘 작업 턴의 일을 이은 길 — 이어서 진행하라는 일, 병합 충돌 해결 일(conflict_fix), 프로그램의 제출 처리, 프로그램의 되돌리기 단계 */
type ResumedAs = 'work' | 'conflict' | 'submit' | 'revert';

/**
 * 한 프로듀서를 바꾸는 중인 교체 호출들 (리드 결정 S5-90 1) — calls: 정지를 기다리거나 바꾸는 중인 호출 수. deferred: 다른 호출이 아직 끝나지 않은 사이 거부한 호출이
 * 맡기지 않고 남겨 둔 멈춘 턴(턴 ID별). 마지막 호출이 거부하면 그 거부가, 바꾸지도 거부하지도 않고 끝나면 그 끝이 같은 프로듀서에게 맡긴다
 */
interface ReplaceRun {
  calls: number;
  deferred: Map<string, StoppedTurn>;
}

/** 멈춘 턴들의 지금 결과 글 (stoppedTurnsText) */
interface StoppedTurnsText {
  /** 남은 프로세스 — '<세션> 턴의 하위 프로세스 n개가 남았습니다(종료 확인 실패)' 등. 남은 것이 없으면 빈 글 */
  what: string;
  /** 관리 세션이 프로세스를 남겼다 — 새 프로듀서가 그 프로세스 위에서 같은 관리 업무를 바로 이어 받는다는 까닭은 이때만 쓴다 */
  onTop: boolean;
  /** 턴마다 지금 상태 — 보류·일시정지와 메인에게 간 일, 다시 넣은 일 */
  states: string[];
  /** 메인이 할 일 — 정확한 호출 */
  exits: string[];
  /** 기다림 뒤 다시 보기 거부(stopped·seat_changed)가 이미 한 일로 적는 사실 — 출구 없이 */
  already: string;
}

/** 남은 프로세스를 남긴 정지 하나의 사실 — 정지 결과의 남은 수, 또는 결과는 확인됐는데 그 턴이 끝나며 남은 프로세스를 알린 것(턴 기록의 그 사실) */
function leftoverWhat(ctx: Ctx, s: StopResult): string {
  if (s.ok) {
    const detail = ctx.store.turns.get(s.turnId)?.process.killDetail;
    return `${s.sessionKey} 턴이 끝나며 하위 프로세스가 남았습니다${detail ? `(${detail.length > 120 ? `${detail.slice(0, 119)}…` : detail})` : ''}`;
  }
  return s.remaining !== undefined && s.remaining > 0 ? `${s.sessionKey} 턴의 하위 프로세스 ${s.remaining}개가 남았습니다(종료 확인 실패)` : `${s.sessionKey} 턴이 띄운 하위 프로세스가 모두 끝났는지 확인하지 못했습니다`;
}

/**
 * 프로듀서 교체가 멈춘 턴들의 결과를 지금 상태에서 읽어 쓴다 (리드 결정 S5-73 3) — 남은 프로세스 거부(leftoverRefusal)와 기다림 뒤 다시 보기 거부(already — 그 거부의
 * 활동 기록도 같은 글)가 모두 이것 하나로 쓴다. 세션 종류와 실제 결과마다:
 * - 작업·검수 세션이 프로세스를 남김: 작업 T의 보류, 메인에게 간 알림, 확인한 뒤 resume_task로 푸는 길. 그 보류가 새 턴을 막으므로 교체는 다시 부르면 된다
 * - 관리 세션이 프로세스를 남김: 프로듀서 일시정지, 메인에게 간 재개 업무(또는 알림), resume_member로 푸는 길. 새 프로듀서가 그 프로세스 위에서 같은 관리 업무를 바로
 *   이어 받는다는 까닭은 이때만 (onTop)
 * - 정지 확인: 그 일이 같은 프로듀서 앞 대기열에 다시 있는지 — 판정이 다시 넣었거나 resumeStopped가 맡겼다. 제출 처리·되돌리기 단계는 프로그램이 잇는다(resumed).
 *   기다리는 사이 다른 교체가 먼저 바꿨으면 그 교체가 넘긴 곳(재배정, 새 검수자, 새 프로듀서)을 쓴다 (리드 결정 S5-80 2)
 * 그 턴의 마무리가 상한 안에 끝나지 않았으면: 남은 프로세스를 이미 안 정지는 그 마무리가 할 일(보류·일시정지와 메인에게 가는 일)을 앞으로 할 일로 쓰고, 정지가 확인된
 * 턴은 지금 확실한 것과 끝나면 할 수 있는 일을 모두 쓴다 — 어느 하나를 약속하지 않는다 (unsettledText, 리드 결정 S5-84)
 * others: 같은 프로듀서를 바꾸는 다른 호출이 아직 끝나지 않았다 — 아직 아무도 바꾸지 않았으면 그 호출이 바꿀 수 있으니, 정지가 확인된 턴의 일은 다른 교체 요청이
 * 진행 중이라는 것만 쓰고 누가 이을지(같은 프로듀서·'프로듀서는 그대로') 말하지 않는다 (리드 결정 S5-90 1)
 */
function stoppedTurnsText(ctx: Ctx, old: Member, turns: readonly StoppedTurn[], others = false): StoppedTurnsText {
  const main = ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] });
  // 기다리는 사이 다른 교체가 먼저 끝났으면 그 새 프로듀서 — 그때는 '프로듀서는 그대로'가 아니다 (리드 결정 S5-80 2)
  const project = old.projectId ? ctx.store.projects.get(old.projectId) : undefined;
  const heir = project && project.producerId !== old.id ? project.producerId : null;
  // 다른 교체 요청이 아직 바꿀 수 있는 멈춘 일 (리드 결정 S5-90 1)
  const undecided = others && !heir ? turns.filter((t) => !t.leftover) : [];
  const states: string[] = [];
  const exits: string[] = [];
  const left = turns.filter((t) => t.leftover);
  const managed = left.filter((t) => t.kind !== 'task' && t.kind !== 'review');
  const taskLeft = left.filter((t) => t.kind === 'task' || t.kind === 'review');
  if (managed.length) {
    const paused = !!ctx.stop().members[old.id]?.paused;
    const item = paused ? (main.find((q) => q.pausedMemberId === old.id) ?? main.find((q) => q.alertKey === alertKey('kill-failed', old.id))) : undefined;
    const pending = managed.some((t) => !t.settled);
    states.push(
      item
        ? `이 프로듀서는 일시정지돼 있고, 남은 프로세스를 확인하라는 ${item.pausedMemberId ? `업무(${item.id})가` : `알림(${item.id})이`} 메인 에이전트에게 가 있습니다`
        : pending
          ? paused
            ? '이 프로듀서는 일시정지돼 있고, 그 턴의 마무리가 끝나면 남은 프로세스를 확인하라는 알림을 메인 에이전트에게 넣습니다'
            : '그 턴의 마무리가 끝나면 프로그램이 이 프로듀서를 일시정지하고, 남은 프로세스를 확인하라는 업무를 메인 에이전트에게 넣습니다'
          : paused
            ? '이 프로듀서는 일시정지돼 있지만, 남은 프로세스를 확인하라는 업무는 메인 에이전트에게 가지 않았습니다'
            : '그 턴의 마무리가 이 프로듀서를 일시정지하지 못했고, 메인 에이전트에게 간 업무도 없습니다',
    );
    exits.push(
      paused || pending
        ? `남은 프로세스가 모두 사라졌는지 확인한 뒤 replace_producer를 다시 부르면 바꿉니다(일시정지된 채로 불러도 됩니다). 바꾸지 않고 이어 쓰려면 확인한 뒤 resume_member(member_id="${old.id}", reason="…")로 푸세요.`
        : '남은 프로세스가 모두 사라졌는지 확인한 뒤 replace_producer를 다시 부르면 바꿉니다.',
    );
  }
  let taskPending = false;
  let taskHeld = false;
  for (const t of taskLeft) {
    const task = t.stop.taskId ? ctx.store.tasks.get(t.stop.taskId) : null;
    if (!task) continue;
    const alert = main.find((q) => q.alertKey === alertKey('kill-failed', task.id));
    if (task.state === 'on_hold') {
      taskHeld = true;
      states.push(alert ? `작업 ${task.id}을(를) 보류했고, 남은 프로세스를 확인하라는 알림(${alert.id})이 메인 에이전트에게 가 있습니다` : `작업 ${task.id}은(는) 보류돼 있습니다`);
      exits.push(`남은 프로세스가 모두 사라졌는지 확인한 뒤 resume_task(task_id="${task.id}", reason="…")로 그 보류를 푸세요.`);
    } else if (!t.settled) {
      taskPending = true;
      states.push(`그 턴의 마무리가 끝나면 프로그램이 작업 ${task.id}을(를) 보류하고, 남은 프로세스를 확인하라는 알림을 메인 에이전트에게 넣습니다`);
      exits.push(`그 뒤 남은 프로세스가 모두 사라졌는지 확인하고 resume_task(task_id="${task.id}", reason="…")로 그 보류를 푸세요.`);
    } else states.push(`작업 ${task.id}은(는) ${TASK_STATE_LABEL[task.state]} 상태라 보류하지 않았습니다`);
  }
  if (taskLeft.length && !managed.length) {
    exits.push(
      taskPending
        ? '그 턴의 마무리가 끝난 뒤 replace_producer를 다시 부르면 바꿉니다.'
        : taskHeld
          ? 'replace_producer는 다시 부르면 바꿉니다 — 그 작업의 보류는 바꾼 뒤에도 그대로 남아, 남은 프로세스 위에서 새 턴이 뜨지 않습니다.'
          : 'replace_producer는 다시 부르면 바꿉니다.',
    );
  }
  if (undecided.length) {
    // 그 호출이 바꾸면 멈춘 일은 교체와 함께 새 프로듀서에게 가고, 바꾸지 않으면 같은 프로듀서가 잇는다 — 지금은 정해지지 않았다 (리드 결정 S5-90 1)
    const open = undecided.filter((t) => !t.settled).map((t) => `${t.stop.sessionKey} 턴`);
    states.push(
      `이 프로듀서를 바꾸는 다른 교체 요청이 아직 진행 중이라, 멈춘 ${undecided.map((t) => `${t.stop.sessionKey} 턴`).join('·')}의 일을 누가 이을지는 그 요청이 끝나야 정해집니다` +
        `${open.length ? ` (${open.join('·')}은 마무리도 아직 끝나지 않았습니다)` : ''} — 지금 프로듀서와 그 일은 get_overview로 확인하세요`,
    );
  }
  for (const t of turns) {
    if (t.leftover || undecided.length) continue;
    const key = t.stop.sessionKey;
    const task = t.stop.taskId ? ctx.store.tasks.get(t.stop.taskId) : null;
    if (!t.settled) {
      // 마무리가 아직이면 지금 확실한 것과 끝나면 할 수 있는 일을 모두 쓴다 — 어느 하나를 약속하지 않는다 (리드 결정 S5-84)
      states.push(unsettledText(ctx, old, t, task ?? null, heir));
      continue;
    }
    // 판정이 다시 넣었거나(관리 업무, 판정 전인 검수) resumeStopped가 맡긴(작업) 일 — 작업 세션은 메시지만 있으면 이어 가는 일이 아니다
    const again = ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).some((q) => q.memberId === old.id && (t.kind !== 'task' || q.kind !== 'message'));
    // 이미 통과 판정을 낸 저장소 변경형 검수 — 판정이 그 다음 단계인 병합 판단을 그 지시의 관리 세션에 넣었다. 마무리가 아직일 때의 글('이미 낸 통과 판정의 다음
    // 단계')과 같은 결과를 말한다 (리드 결정 S5-90 2)
    const merge =
      t.kind === 'review' && task?.state === 'in_review' && task.review.passed && task.outputMode === 'repo'
        ? ctx.store.queue.list({ ref2: directiveKey(task.directiveId), state: ['queued', 'running'] }).find((q) => q.kind === 'merge_decision' && q.taskId === task.id)
        : undefined;
    if (again && t.kind === 'task') states.push(`멈춘 작업 ${task?.id ?? key}은(는) 다시 대기열에 들어가 그 프로듀서가 잇습니다`);
    else if (again && t.kind === 'review') states.push(`멈춘 검수(작업 ${task?.id ?? key})는 다시 대기열에 들어가 그 프로듀서가 잇습니다`);
    else if (again) states.push('멈춘 관리 업무는 다시 대기열에 들어가 그 프로듀서가 잇습니다');
    else if (merge && task) {
      const who = merge.memberId === old.id ? '그 프로듀서가' : `${merge.memberId === heir ? '새 프로듀서 ' : ''}${memberName(ctx, merge.memberId)}(${merge.memberId})이(가)`;
      states.push(`멈춘 검수(작업 ${task.id})는 이미 통과 판정을 냈고, 그 다음 단계인 병합 판단이 대기열에 들어가 ${who} 잇습니다`);
    }
    // 거부하며 프로그램 단계로 이은 작업 (resumeStopped — 보류 해제와 같은 갈래)
    else if (t.resumed === 'submit') states.push(`멈춘 작업 ${task?.id ?? key}은(는) 제출(submit_for_review)이 남아 있어 프로그램이 그 제출 처리를 이어 갑니다`);
    else if (t.resumed === 'revert') states.push(`멈춘 되돌리기 작업 ${task?.id ?? key}은(는) 프로그램이 되돌리기 단계를 이어 갑니다`);
    // 기다리는 사이 다른 교체가 먼저 바꿨으면 그 교체가 넘긴 곳 — 재배정된 작업, 새 검수자, 새 프로듀서 앞으로 옮긴 관리 업무 (리드 결정 S5-80 2)
    else if (task && t.kind === 'task' && task.assigneeId !== old.id) states.push(`멈춘 작업 ${task.id}은(는) ${memberName(ctx, task.assigneeId)}(${task.assigneeId})에게 재배정됐습니다 (작업 상태: ${TASK_STATE_LABEL[task.state]})`);
    else if (task && t.kind === 'review' && task.reviewerId && task.reviewerId !== old.id) states.push(`멈춘 검수(작업 ${task.id})는 검수자 ${memberName(ctx, task.reviewerId)}(${task.reviewerId})에게 넘어갔습니다`);
    else if (heir && t.kind !== 'task' && t.kind !== 'review' && ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).some((q) => q.memberId === heir)) {
      states.push(`멈춘 관리 업무는 다시 대기열에 들어가 새 프로듀서 ${memberName(ctx, heir)}(${heir})이(가) 잇습니다`);
    } else if (task?.state === 'on_hold') states.push(`작업 ${task.id}은(는) 보류돼 있어 그 보류가 풀리면 이어 갑니다`);
    else states.push(`${key}에는 다시 이어 갈 일이 남지 않았습니다${task ? ` (작업 ${task.id}: ${TASK_STATE_LABEL[task.state]})` : ''}`);
  }
  const what = left.map((t) => leftoverWhat(ctx, t.stop)).join(', ');
  const body = states.join('. ');
  const kept = heir ? `프로듀서는 그사이 ${memberName(ctx, heir)}(${heir})(으)로 바뀌었고, ${body}` : undecided.length ? body : `프로듀서는 그대로이고, ${body}`;
  return { what, onTop: managed.length > 0, states, exits, already: left.length ? `${what}. ${body}` : kept };
}

/**
 * 정지는 확인됐지만 그 턴의 마무리(정리·종료 판정)가 기다리는 상한 안에 끝나지 않은 턴 하나의 글 (리드 결정 S5-84). 그 마무리가 남은 프로세스를 찾을지, 멈춘 일을
 * 무엇으로 이을지(resumeStoppedTask의 갈래, 판정의 다시 넣기)는 끝나야 정해진다 — 그래서 지금 확실한 것만 쓰고, 끝나면 프로그램이 할 수 있는 일을 모두 적으며 어느
 * 하나를 약속하지 않는다:
 * - 작업 세션, 같은 프로듀서가 맡은 진행 중 작업: 셋 중 하나 — 같은 프로듀서에게 다시 맡김(이어서 진행·충돌 해결), 남은 제출 처리·되돌리기 단계를 이어 감, 하위
 *   프로세스가 남았으면 작업 보류와 메인에게 가는 알림
 * - 검수 세션, 같은 프로듀서가 검수자인 검수 중 작업: 셋 중 하나 — 멈춘 검수를 같은 프로듀서 앞에 다시 넣음(다시 판정 업무 포함), 이미 낸 통과 판정의 다음 단계,
 *   작업 보류와 알림
 * - 그 밖의 작업·검수(다른 교체가 재배정함·검수자가 바뀜·보류·다른 상태): 그 사실과, 하위 프로세스가 남았을 때의 작업 보류와 알림 — 같은 프로듀서가 이을 일은 없다
 * - 관리 세션: 멈춘 관리 업무를 다시 넣고(다른 교체가 바꿨으면 새 프로듀서 앞), 하위 프로세스가 남았으면 그 위에 일시정지와 메인에게 가는 업무(교체됐으면 그
 *   세션의 알림, 이미 일시정지면 그대로 두고 메인에게) — 둘 다 일어날 수 있다(판정은 남은 프로세스를 막은 뒤에도 관리 업무를 다시 넣는다)
 */
function unsettledText(ctx: Ctx, old: Member, t: StoppedTurn, task: Task | null, heir: string | null): string {
  const key = t.stop.sessionKey;
  const head = `${key} 턴은 마무리가 아직 끝나지 않았습니다`;
  const which = '어느 쪽이 될지는 그 마무리가 끝나야 정해집니다';
  if (t.kind === 'task' || t.kind === 'review') {
    if (!task) return head;
    const hold = `${task.state === 'on_hold' ? '그 보류에 남은 프로세스 사유를 더하고' : `작업 ${task.id}을(를) 보류하고`} 확인하라는 알림을 메인 에이전트에게 넣습니다`;
    if (!heir && t.kind === 'task' && task.state === 'in_progress' && task.assigneeId === old.id) {
      return `${head} — 끝나면 프로그램이 셋 중 하나를 합니다: 멈춘 작업 ${task.id}을(를) 같은 프로듀서에게 다시 맡기거나, 남은 제출(submit_for_review) 처리나 되돌리기 단계를 이어 가거나, 하위 프로세스가 남았으면 ${hold} (${which})`;
    }
    if (!heir && t.kind === 'review' && task.state === 'in_review' && task.reviewerId === old.id) {
      return `${head} — 끝나면 프로그램이 셋 중 하나를 합니다: 멈춘 검수(작업 ${task.id})를 같은 프로듀서 앞 대기열에 다시 넣거나, 이미 낸 통과 판정의 다음 단계(병합 판단·산출물 확정)를 이어 가거나, 하위 프로세스가 남았으면 ${hold} (${which})`;
    }
    // 같은 프로듀서가 이을 일이 없는 작업 — 지금의 사실, 그리고 남은 프로세스가 있을 때만 프로그램이 더 하는 일
    const now =
      t.kind === 'task' && task.assigneeId !== old.id
        ? `멈춘 작업 ${task.id}은(는) ${memberName(ctx, task.assigneeId)}(${task.assigneeId})에게 재배정됐습니다 (작업 상태: ${TASK_STATE_LABEL[task.state]})`
        : t.kind === 'review' && task.reviewerId && task.reviewerId !== old.id
          ? `멈춘 검수(작업 ${task.id})는 검수자 ${memberName(ctx, task.reviewerId)}(${task.reviewerId})에게 넘어갔습니다`
          : task.state === 'on_hold'
            ? `작업 ${task.id}은(는) 보류돼 있어 그 보류가 풀리면 이어 갑니다`
            : `작업 ${task.id}은(는) 지금 ${TASK_STATE_LABEL[task.state]} 상태입니다`;
    return isTerminal(task.state) ? `${now} — ${key} 턴의 마무리는 아직 끝나지 않았습니다` : `${now} — ${key} 턴의 마무리는 아직 끝나지 않았고, 끝나서 하위 프로세스가 남았으면 프로그램이 ${hold}`;
  }
  // 관리 세션 — 판정이 관리 업무를 다시 넣는 것은 남은 프로세스와 함께 일어날 수 있다. 다시 넣는 곳은 지금 프로듀서(교체됐으면 그 후임, requeue의 memberOrSuccessor)
  const who = heir ? `새 프로듀서 ${memberName(ctx, heir)}(${heir})` : '같은 프로듀서';
  const left = heir
    ? '삭제된 팀원이라 일시정지하지 않고 그 세션의 남은 프로세스를 확인하라는 알림을 메인 에이전트에게 넣습니다'
    : ctx.stop().members[old.id]?.paused
      ? '이미 일시정지된 이 프로듀서는 그대로 두고 그 확인을 메인 에이전트에게 맡깁니다'
      : '이 프로듀서를 일시정지하고 확인하라는 업무를 메인 에이전트에게 넣습니다';
  return `${head} — 끝나면 프로그램이 멈춘 관리 업무를 ${who} 앞 대기열에 다시 넣고(그 지시가 아직 열려 있으면), 하위 프로세스가 남았으면 ${left}`;
}

/**
 * 남은 프로세스 때문에 프로듀서를 바꾸지 않은 거부 글 (리드 결정 S5-62 1·S5-73 3) — 그 세션과 남은 수, 관리 세션이면 새 프로듀서가 그 프로세스 위에서 이어 받는다는
 * 까닭, 지금 상태와 할 일(stoppedTurnsText)
 */
function leftoverRefusal(ctx: Ctx, old: Member, x: StoppedTurnsText): string {
  return [
    `프로듀서 ${old.name}(${old.id})을(를) 바꾸지 않았습니다 — 그 턴을 멈췄지만 ${x.what}.${x.onTop ? ' 지금 바꾸면 새 프로듀서가 같은 관리 업무를 그 프로세스 위에서 바로 이어 받습니다.' : ''}`,
    `${x.states.join('. ')}.`,
    ...x.exits,
    `직접 확인할 길이 없으면 ${askOwnerToCheck(ctx)}.`,
  ].join(' ');
}

export { writeFileAtomic };
