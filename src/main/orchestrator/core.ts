/**
 * 오케스트레이터 조립: 서비스들을 만들고 서로 참조할 수 있게 묶는다.
 * 서비스는 생성자에서 Core를 받고, 다른 서비스는 this.core.<이름>으로 부른다.
 */
import type { AppToolServer } from '../mcp/types';
import { Ctx, type OrchestratorDeps } from './context';
import { ProjectLocks } from './execlog';
import { TaskService } from './tasks';
import { MergeService } from './merges';
import { TeamService, ProjectService } from './team';
import { DirectiveService, CommandService, ReportService, MemoryService } from './directives';
import { StopService } from './stops';
import { SeatService } from './seat';
import { ExternalAgents } from './externalAgents';
import { JournalService } from './journal';
import { HandoverService } from './handover';
import { TurnRunner, Scheduler } from './turns';
import { ToolHandlers } from './tools';
import { RecoveryService } from './recovery';
import { ViewBuilder } from './views';
import { OverviewService } from './overview';
import { AuthService } from './auth';
import { AutoChecker } from './autocheck';
import { HostExecService } from './hostExec';
import { createDeviceSessionStore, type DeviceSessionStore } from '../auth/deviceSessions';
import { ServerLoginService } from './serverLogin';
import { createRequestReplies, type RequestReplies } from '../backend/requestReplies';
import { ServerFiles } from './serverFiles';
import { DesktopService } from '../desktop/service';
import { CpuGuard } from './cpuGuard';

export class Core {
  readonly ctx: Ctx;
  readonly locks = new ProjectLocks();
  readonly tasks: TaskService;
  readonly merges: MergeService;
  readonly team: TeamService;
  readonly projects: ProjectService;
  readonly directives: DirectiveService;
  readonly commands: CommandService;
  readonly reports: ReportService;
  readonly memory: MemoryService;
  readonly stops: StopService;
  /** 메인 에이전트 자리 (SERVER_DESIGN 4장, 리드 결정 S4-2) — 자리를 바꾸는 곳은 이것 하나다 */
  readonly seat: SeatService;
  /** 외부 에이전트 (SERVER_DESIGN 4.5, 리드 결정 S7-2·S7-3) — 운영자의 등록·폐기, 대표의 목록, 자리가 보는 '쓸 수 있는 외부 보유자', 에이전트 키 인증 */
  readonly externalAgents: ExternalAgents;
  /** 메인 에이전트 일지 (SERVER_DESIGN 6.1·6.3, 리드 결정 S4-6) — 서버 기록과 에이전트 기록 */
  readonly journal: JournalService;
  /** 인계 꾸러미와 인계 메모 턴 (6.2·4.3 3번) — 자리 교체의 3·6번을 채운다 */
  readonly handover: HandoverService;
  readonly turns: TurnRunner;
  readonly scheduler: Scheduler;
  readonly tools: ToolHandlers;
  readonly recovery: RecoveryService;
  readonly views: ViewBuilder;
  /** 전체 현황과 매 턴 현황 요약 (SERVER_DESIGN 5.1·5.2, 리드 결정 S5-3·S5-4) — get_overview·list_questions·reachesMain이 같은 고르는 함수를 쓴다 */
  readonly overview: OverviewService;
  readonly auth: AuthService;
  /** 대표의 기기 세션 (서버 모드, S3-4) — 살아 있는 세션은 지금 등록된 대표의 것뿐이다 */
  readonly deviceSessions: DeviceSessionStore;
  /** 서버의 대표 로그인 — 대표 이메일·설정 코드·서버 구글 클라이언트·기기 코드 로그인 (서버 모드, S3-5·S3-6·S3-8) */
  readonly serverLogin: ServerLoginService;
  /** 같은 요청 ID를 한 번만 처리한 답 (서버의 원격 호출자, S3-9) — 데스크톱 길은 요청 ID가 없어 쓰지 않는다 */
  readonly requestReplies: RequestReplies;
  /** 서버의 업로드와 내려받기 대상 (원격 화면, S3-10) — 데스크톱은 쓰지 않는다 */
  readonly serverFiles: ServerFiles;
  readonly checks: AutoChecker;
  /** 메인 에이전트의 서버 명령 (host_exec — SERVER_DESIGN 8.2, 리드 결정 S5-16~S5-19) — 한 번에 하나, 정지·턴 끝·앱 종료·재시작이 함께 끝낸다 */
  readonly hostExec: HostExecService;
  /** 메인 에이전트의 화면 조작 (SERVER_DESIGN 8.3, 리드 결정 S6-6·S6-7·S6-10) — 도구 다섯 개, 캡처 보관, 기록, 화면 보기 확인. 도우미가 없으면 쓸 수 없음 */
  readonly desktop: DesktopService;
  /** CPU 상한 (대표 지시 2026-11-18) — 이 PC의 CPU가 95% 이상이면 새 팀 턴과 host_exec를 내려갈 때까지 미룬다 */
  readonly cpu: CpuGuard;
  /**
   * 메인 에이전트 작업 폴더 (SERVER_DESIGN 3.7, 리드 결정 S5-20) — main:* 턴의 실행 위치이자 host_exec의 기본 실행 위치. problem: 시작 때 확인에 걸려 예전 폴더를
   * 쓰는 까닭(데스크톱) — 있으면 host_exec는 cwd 없이 실행하지 않는다. createOrchestrator가 시작 때 확인한 값으로 바꾼다
   */
  mainWork: { dir: string; problem: string | null };
  toolServer!: AppToolServer;
  started = false;
  stopping = false;

  constructor(deps: OrchestratorDeps) {
    this.ctx = new Ctx(deps);
    this.tasks = new TaskService(this);
    this.merges = new MergeService(this);
    this.team = new TeamService(this);
    this.projects = new ProjectService(this);
    this.directives = new DirectiveService(this);
    this.commands = new CommandService(this);
    this.reports = new ReportService(this);
    this.memory = new MemoryService(this);
    this.stops = new StopService(this);
    this.seat = new SeatService(this);
    this.externalAgents = new ExternalAgents(this);
    this.journal = new JournalService(this);
    this.handover = new HandoverService(this);
    this.seat.hooks = this.handover.seatHooks();
    this.turns = new TurnRunner(this);
    this.scheduler = new Scheduler(this);
    this.tools = new ToolHandlers(this);
    this.recovery = new RecoveryService(this);
    this.views = new ViewBuilder(this);
    this.overview = new OverviewService(this);
    this.auth = new AuthService(this);
    this.deviceSessions = createDeviceSessionStore({ store: this.ctx.store, ownerSub: () => this.auth.owner()?.sub ?? null, now: () => this.ctx.clock.ms() });
    this.serverLogin = new ServerLoginService(this);
    this.requestReplies = createRequestReplies({
      store: this.ctx.store,
      now: () => this.ctx.clock.ms(),
      onSaveError: (e) => this.ctx.log('warn', '같은 요청 ID의 답을 저장하지 못했습니다 — 다시 보낸 요청이 한 번 더 처리될 수 있습니다', e),
    });
    this.serverFiles = new ServerFiles(this);
    this.checks = new AutoChecker(this);
    this.hostExec = new HostExecService(this);
    this.desktop = new DesktopService(this);
    this.cpu = new CpuGuard(this);
    this.mainWork = { dir: deps.mainWorkDir ?? this.ctx.paths.mainAgent, problem: null };
    this.ctx.isScreenLocked = () => !this.auth.isLoggedIn();
  }
}
