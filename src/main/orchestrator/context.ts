/**
 * 오케스트레이터 공용 문맥: 의존성, 저장소, 설정·정지 상태 접근, 변경 알림(bus), 활동 기록, 알림.
 * 서비스들은 모두 이 Ctx를 받아 동작한다.
 */
import { EventEmitter } from 'node:events';
import type {
  ActivityEntry,
  AiAvailability,
  AiKind,
  AppNotification,
  NavTarget,
  NotificationLevel,
  Settings,
  SkillEntry,
  StopState,
} from '@shared/domain';
import type { WookTopic, WookTopics } from '@shared/ipc';
import type { Clock } from '@core/time';
import type { Store } from '../db/store';
import type { GitService } from '../git/types';
import type { ProcessRunner } from '../process/types';
import type { AgentAdapter } from '../agents/types';
import type { AppToolServer, AppToolServerOptions } from '../mcp/types';
import type { GoogleLoginOptions, GoogleProfile, SecretStore } from '../auth/types';
import type { GoogleDeviceOptions } from '../auth/googleDevice';
import type { ApiKeyCache } from '../auth/apiKeys';
import type { SeatConfigValues, ShellServices } from '../backend/types';
import { normalizeSettings } from './defaults';
import { dataPaths, type DataPaths } from './paths';

/** core/redact.ts 의 Redactor와 같은 모양 */
export interface RedactorLike {
  text(s: string): string;
  value<T>(v: T): T;
  addSecret(secret: string, kind?: string): void;
  /** 여러 꼴로 들어오는 정해진 값(설정 코드, 리드 결정 S3-18)을 꼴 하나로 가린다 */
  addPattern(pattern: RegExp, kind?: string): void;
}

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface OrchestratorDeps {
  dataDir: string;
  /** resources/ 폴더가 있는 앱 루트 */
  appRoot: string;
  isPackaged: boolean;
  /**
   * 개발 모드 로그인을 받는지 (SERVER_DESIGN 3.5, S2-2) — auth.ts가 isPackaged 대신 이것을 본다. 데스크톱은 !isPackaged, 서버는
   * --allow-test-session일 때만. 앱 조립(buildDeps)이 늘 채운다
   */
  allowDevLogin: boolean;
  /**
   * 로그인 방식 (리드 결정 S3-2, BackendDeps.mode): 'server'면 kv `auth.session`을 읽지도 쓰지도 않고 개발 모드 로그인을 늘 끈다 — 누가 부르는지는
   * 원격 호출자의 기기 세션으로 정한다(auth.ts). 없으면 'desktop'(예전 그대로 — 손으로 의존성을 만든 시험 하네스)
   */
  mode?: 'desktop' | 'server';
  appVersion?: string;
  /**
   * 메인 자리의 운영자 설정 (서버 server.json의 seat, 리드 결정 S4-12) — 시작할 때 SeatService.init이 쓴다: 앉을 수 있는 보유자·마무리 기다림은 자리 정책으로,
   * 처음 보유자는 새 DB의 빈 자리에만. 데스크톱은 넘기지 않는다(기본 정책, 처음 보유자는 운영 설정의 메인 AI)
   */
  seat?: SeatConfigValues;
  /**
   * 메인 에이전트 작업 폴더 (SERVER_DESIGN 3.7, 리드 결정 S5-20) — 데스크톱은 `~/wook-workspace/main`, 서버는 `--workspace-root`·server.json `workspaceRoot`·기본 위치 아래
   * `main`. 앱 조립(buildDeps)이 껍데기가 정한 작업 폴더 위치로 채운다. 시작 때 확인에 걸리면 서버는 시작하지 않고 데스크톱은 예전 폴더를 쓴다(createOrchestrator).
   * 없으면(손으로 의존성을 만든 시험 하네스) 예전 자리 `<dataDir>/main-agent`
   */
  mainWorkDir?: string;
  store: Store;
  clock: Clock;
  git: GitService;
  runner: ProcessRunner;
  adapters: { claude: AgentAdapter; codex: AgentAdapter; mock: AgentAdapter };
  createToolServer: (opts: AppToolServerOptions) => AppToolServer;
  secrets: SecretStore;
  /**
   * 등록된 API 키의 메모리 사본 — 앱 조립(buildDeps)이 어댑터의 상태 확인 환경(statusEnv)에 쓴다. 시작 때 registerStoredSecrets가 채우고
   * settings.setApiKey가 바꾼다 (리드 결정 16). 없으면(시험 하네스 등) 건너뛴다
   */
  apiKeys?: ApiKeyCache;
  redactor: RedactorLike;
  shell: ShellServices | null;
  googleLogin?: (opts: GoogleLoginOptions) => Promise<GoogleProfile>;
  /** 기기 코드 로그인의 구글 주소·fetch (서버 모드, S3-5) — 시험이 가짜 구글 서버로 바꾼다. 없으면 실제 구글 */
  googleDevice?: Pick<GoogleDeviceOptions, 'endpoints' | 'fetchImpl'>;
  scanSkills?: (opts: { home: string; projectPaths: string[] }) => Promise<SkillEntry[]>;
  logger?: LogFn;
  /**
   * 테스트에서 주기 단축. questionEndGraceMs: 질문·막힘 보고 뒤 CLI가 턴을 스스로 끝내기를 기다리는 시간 — 출력이 이만큼 멈추면
   * 프로그램이 그 턴을 끝낸다 (15.4 "팀원 프로세스 종료", AC-37, 기본 8초). questionEndCapMs: 그 뒤 계속 출력하며 끝내지 않아도 끝내는 상한 (기본 30초).
   * shutdownDrainMs: 앱 종료가 턴 마무리와 진행 중인 프로그램 작업(제출 처리·병합·되돌리기·자동 검사)을 기다리는 상한 (기본 15초).
   * memoTurnMs: 메인 자리 교체의 인계 메모 턴 상한 (SERVER_DESIGN 4.3 3번, 기본 2분 — handover.ts)
   */
  timing?: {
    watchdogMs?: number;
    snapshotThrottleMs?: number;
    mergeRetryMs?: number;
    questionEndGraceMs?: number;
    questionEndCapMs?: number;
    shutdownDrainMs?: number;
    memoTurnMs?: number;
  };
}

export class Bus {
  private readonly ee = new EventEmitter();
  private changeTimer: NodeJS.Timeout | null = null;
  constructor(private readonly throttleMs: number) {
    this.ee.setMaxListeners(100);
  }
  /** 상태가 바뀌었음을 알린다 (스냅샷 재계산 예약) */
  changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.ee.emit('changed');
    }, this.throttleMs);
  }
  onChanged(cb: () => void): () => void {
    this.ee.on('changed', cb);
    return () => this.ee.off('changed', cb);
  }
  emit<T extends WookTopic>(topic: T, payload: WookTopics[T]): void {
    this.ee.emit(`topic:${topic}`, payload);
  }
  on<T extends WookTopic>(topic: T, cb: (p: WookTopics[T]) => void): () => void {
    const h = cb as (p: unknown) => void;
    this.ee.on(`topic:${topic}`, h);
    return () => this.ee.off(`topic:${topic}`, h);
  }
  /**
   * 내부 이벤트 (스케줄러 깨우기 등). 호출자의 DB 트랜잭션 안에서 스케줄러가 돌지 않도록
   * 항상 다음 이벤트 루프 차례에 전달한다
   */
  signal(name: string, payload?: unknown): void {
    setImmediate(() => this.ee.emit(`sig:${name}`, payload));
  }
  onSignal(name: string, cb: (payload: unknown) => void): () => void {
    this.ee.on(`sig:${name}`, cb);
    return () => this.ee.off(`sig:${name}`, cb);
  }
  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.ee.removeAllListeners();
  }
}

export type ActivityInput = Partial<Omit<ActivityEntry, 'seq' | 'ts' | 'kind' | 'text'>> & Pick<ActivityEntry, 'kind' | 'text'>;

export interface NotifyInput {
  level: NotificationLevel;
  title: string;
  body: string;
  link?: NavTarget | null;
  /** 같은 key의 읽지 않은 알림이 있으면 갱신 */
  key?: string | null;
}

const STOP_KEY = 'stop';
const SETTINGS_KEY = 'settings';
const AI_KEY = (k: AiKind) => `ai.${k}`;

export function emptyStop(): StopState {
  return { global: { active: false, since: null, by: null, releasedAt: null }, projects: {}, members: {} };
}

export function emptyAi(kind: AiKind): AiAvailability {
  return {
    kind,
    usageLimitedUntil: null,
    authRequired: false,
    authRequiredSince: null,
    cliInstalled: true,
    cliVersion: null,
    cliProblem: null,
    checkedAt: null,
  };
}

/** 로그아웃 중 OS 알림 본문 (업무 내용은 로그인 뒤 알림 목록에서) */
export const LOCKED_TOAST_BODY = '로그인하면 내용을 확인할 수 있습니다';

export class Ctx {
  readonly store: Store;
  readonly clock: Clock;
  readonly paths: DataPaths;
  readonly bus: Bus;
  /** 대표가 로그아웃해 화면 접근이 막혀 있는지 (AUTH-04). Core가 로그인 상태로 채운다 */
  isScreenLocked: () => boolean = () => false;
  private settingsCache: Settings | null = null;

  constructor(readonly deps: OrchestratorDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.paths = dataPaths(deps.dataDir);
    this.bus = new Bus(deps.timing?.snapshotThrottleMs ?? 150);
  }

  get redact(): RedactorLike {
    return this.deps.redactor;
  }

  now(): string {
    return this.clock.iso();
  }

  log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
    this.deps.logger?.(level, msg, extra);
  }

  // ───── 설정 ─────
  settings(): Settings {
    if (!this.settingsCache) this.settingsCache = normalizeSettings(this.store.kv.get<Settings>(SETTINGS_KEY));
    return this.settingsCache;
  }
  saveSettings(s: Settings): void {
    this.store.kv.set(SETTINGS_KEY, s);
    this.settingsCache = s;
    this.bus.changed();
  }

  // ───── 정지 상태 (CTL-08: 즉시 영속화) ─────
  stop(): StopState {
    return this.store.kv.get<StopState>(STOP_KEY) ?? emptyStop();
  }
  saveStop(s: StopState): void {
    this.store.kv.set(STOP_KEY, s);
    this.bus.changed();
  }

  // ───── AI 가용성 ─────
  ai(kind: AiKind): AiAvailability {
    return { ...emptyAi(kind), ...(this.store.kv.get<AiAvailability>(AI_KEY(kind)) ?? {}) };
  }
  saveAi(a: AiAvailability): void {
    this.store.kv.set(AI_KEY(a.kind), a);
    this.bus.changed();
  }

  // ───── 활동 기록 (LOG-01·02) ─────
  activity(input: ActivityInput): ActivityEntry {
    const e = this.store.activity.append({
      ts: this.now(),
      actor: input.actor ?? 'system',
      projectId: input.projectId ?? null,
      directiveId: input.directiveId ?? null,
      taskId: input.taskId ?? null,
      memberId: input.memberId ?? null,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      // 요청 ID도 저장 전에 가린다 (앱 도구 경계에서 이미 safeRequestId로 바꿨으면 그대로) — SEC-10
      requestId: input.requestId == null ? null : this.redact.text(input.requestId),
      kind: input.kind,
      level: input.level ?? 'info',
      text: this.redact.text(input.text),
      result: input.result == null ? null : this.redact.text(input.result),
    });
    this.bus.changed();
    return e;
  }

  // ───── 알림 (12장) ─────
  notify(n: NotifyInput): AppNotification {
    const now = this.now();
    const key = n.key ?? null;
    if (key) {
      const existing = this.store.notifications.list({ ref1: key, state: 'unread' })[0];
      if (existing) {
        const updated = { ...existing, title: n.title, body: this.redact.text(n.body), level: n.level, link: n.link ?? null, createdAt: now };
        this.store.notifications.put(updated);
        this.bus.changed();
        return updated;
      }
    }
    const rec: AppNotification = {
      id: this.store.nextId('notification'),
      level: n.level,
      title: n.title,
      body: this.redact.text(n.body),
      link: n.link ?? null,
      key,
      createdAt: now,
      readAt: null,
    };
    this.store.notifications.insert(rec);
    // 알림 종류 key도 함께 — 화면은 key 앞부분으로 종류를 가려 바탕화면 알림 제목을 정한다 (NotificationView.key, 리드 결정 41)
    this.bus.emit('notification', { id: rec.id, level: rec.level, title: rec.title, body: rec.body, link: rec.link, key: rec.key, createdAt: rec.createdAt, read: false });
    if (rec.level !== 'info' && this.deps.shell) {
      const link = rec.link;
      try {
        this.deps.shell.showOsNotification({
          level: rec.level === 'urgent' ? 'urgent' : 'normal',
          title: rec.title,
          // 로그아웃 중에는 알림이 왔다는 것만 알리고 업무 내용(질문·보고·작업 이름)은 바탕화면에 띄우지 않는다 (AUTH-04, SEC-F2)
          body: this.isScreenLocked() ? LOCKED_TOAST_BODY : rec.body,
          onClick: () => {
            this.deps.shell?.focusWindow();
            if (link) this.bus.emit('navigate', link);
          },
        });
      } catch (e) {
        this.log('warn', 'OS 알림 실패', e);
      }
    }
    this.bus.changed();
    return rec;
  }
}
