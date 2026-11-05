/**
 * 세션 없는 원격 연결은 어느 토픽에서도 업무 내용을 받지 않는다 (SERVER_DESIGN 3.4 밀어주기, 리드 결정 S3-20·S3-21 — 검토 프로브 zz-s3fl-harness의
 * P4·P6을 옮김). 서버의 세션 없는 SSE는 누구나 열 수 있다(로그인 전 화면). 그래서 서버 topicFor·snapshotFor는 데스크톱의 로그아웃 규칙(lockedSnapshot)에
 * 더해 긴급 정지 요약의 멈춘 턴·보류 작업·실패, AI 상태의 버전·문제 글·한도, 실행 수를 뺀다.
 * - 허용 목록: 토픽마다 세션 없는 연결에 보내도 되는 칸과 그 값의 규칙. 모든 토픽(IPC_TOPICS)이 목록에 있어야 하고, 목록에 없는 칸이 오면 실패한다 —
 *   새 토픽이나 칸은 누가 정할 때까지 이 시험을 깨뜨린다. 칸 목록은 타입에서 빠짐없이 적게 했다(satisfies — 타입에 칸이 늘면 컴파일이 막는다)
 * - 실제 오케스트레이터가 낸 토픽(턴·알림·긴급 정지)과, 버스로 내지 않는 칸까지 채운 값(AI 한도, 이동 대상 ID)을 모두 거른다
 * - 로그인한 원격 연결과 데스크톱 화면(onTopic의 viewerTopic·lockedSnapshot)은 예전 그대로다
 * - 메인 자리(스냅숏 seat)의 보유자·이력도 업무 내용이다 — 로그인 전에는 정해진 빈 값 LOCKED_SEAT만 간다 (리드 결정 S4-11, 데스크톱 lockedSnapshot도 같다)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiStatusView, AppSnapshot, AuthState, EmergencySummary, RunningView, SeatView, StopView } from '@shared/views';
import { LOCKED_SEAT } from '@shared/views';
import type { NavTarget } from '@shared/domain';
import { IPC_TOPICS, type WookTopic, type WookTopics } from '@shared/ipc';
import { createHarness, type Harness } from '../e2e/harness';
import { deviceSessionView } from '../../src/main/auth/deviceSessions';
import type { RemoteCaller } from '../../src/main/backend/types';
import { lockedSnapshot, viewerTopic } from '../../src/main/orchestrator/orchestrator';
import { startServer, type RunningServer } from '../../src/server/server';
import { memoryLogger, openSse, remoteBackendOf, sleep, type SseClient } from './helpers';

// ───── 허용 목록 ─────

/** 칸의 규칙: keep(그대로 보내도 된다 — 아래 칸까지), empty(빈 목록), absent(없어야 한다), 또는 그 값이어야 한다(null·0·false, '=글'은 그 글) */
type Rule = 'keep' | 'empty' | 'absent' | null | 0 | false | `=${string}`;
type Shape = Rule | { [key: string]: Shape } | [{ [key: string]: Shape }];
type Rules<T> = { [K in keyof Required<T>]: Shape };
type KeysOfUnion<T> = T extends T ? keyof T : never;

const AUTH = {
  loggedIn: false,
  owner: null,
  // 로그인 화면이 쓰는 로그인 전 상태
  googleConfigured: 'keep',
  googleSecretSet: 'keep',
  ownerRegistered: 'keep',
  devLoginAllowed: 'keep',
  googleSetupOpen: 'keep',
  mode: 'keep',
  setupRequired: 'keep',
} satisfies Rules<AuthState>;

const STOP = {
  // 전역 정지가 걸렸는지·언제부터 — 긴급 정지 토픽이 이미 그만큼 말한다
  global: 'keep',
  pausedProjects: 'empty',
  pausedMembers: 'empty',
  lastEmergency: null,
  heldByEmergency: 0,
} satisfies Rules<StopView>;

/** 로그인 전 system.prereqs(minimalPrereqs)만큼 — 설치 여부만 (S3-21) */
const AI = {
  kind: 'keep',
  installed: 'keep',
  version: null,
  problem: null,
  usageLimitedUntil: null,
  modelLimits: 'absent',
  authRequired: false,
  blocked: false,
} satisfies Rules<AiStatusView>;

const RUNNING = { total: 0, general: 0, management: 0, cap: 0, generalCap: 0, queued: 0 } satisfies Rules<RunningView>;

/** 메인 자리 — 칸마다 LOCKED_SEAT의 값 그대로 (S4-11): 보유자·때·까닭은 없고 세대 0, 빈 자리, 화면 확인 모름 */
const SEAT = {
  generation: 0,
  state: '=vacant',
  holder: null,
  since: null,
  unresponsiveSince: null,
  unresponsiveReason: null,
  pendingHolder: null,
  vision: '=unknown',
} satisfies Rules<SeatView>;

const SNAPSHOT = {
  version: 'keep',
  generatedAt: 'keep',
  auth: AUTH,
  stop: STOP,
  projects: 'empty',
  members: 'empty',
  directives: 'empty',
  tasks: 'empty',
  ownerTodos: 'empty',
  notifications: { unread: 0, urgentUnread: 0 } satisfies Rules<AppSnapshot['notifications']>,
  recentActivity: 'empty',
  ai: [AI],
  running: RUNNING,
  // 트레이 상태는 그대로 (S3-21)
  trayStatus: 'keep',
  roles: 'empty',
  seat: SEAT,
} satisfies Rules<AppSnapshot>;

/** 긴급 정지 요약 — 때와 확인 완료만 (S3-20) */
const EMERGENCY = { at: 'keep', completed: 'keep', stoppedTurns: 'empty', heldTasks: 'empty', failures: 'empty' } satisfies Rules<EmergencySummary>;

/** 이동 — 탭과 설정 칸만, 업무 대상 ID는 없다 */
const NAVIGATE = {
  tab: 'keep',
  section: 'keep',
  projectId: 'absent',
  memberId: 'absent',
  taskId: 'absent',
  directiveId: 'absent',
  reportId: 'absent',
} satisfies { [K in KeysOfUnion<NavTarget>]: Shape };

const NOT_SENT = 'not-sent' as const;

const ALLOW = {
  snapshot: SNAPSHOT,
  emergency: EMERGENCY,
  navigate: NAVIGATE,
  openSettings: { section: 'keep' } satisfies Rules<WookTopics['openSettings']>,
  notification: NOT_SENT,
  cliEvents: NOT_SENT,
} satisfies Record<WookTopic, Shape | typeof NOT_SENT>;

const isRule = (s: Shape): s is Rule => s === null || typeof s !== 'object';

/** 허용 목록을 칸 경로(`stop.global`, `ai[].version`)마다 규칙으로 */
function rulesOf(shape: Shape, prefix = '', out = new Map<string, Rule>()): Map<string, Rule> {
  if (isRule(shape)) out.set(prefix, shape);
  else if (Array.isArray(shape)) rulesOf(shape[0], `${prefix}[]`, out);
  else for (const [k, v] of Object.entries(shape)) rulesOf(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** 보낼 값을 허용 목록으로 본다 — 어긋난 칸 경로와 까닭(값은 내지 않는다) */
function violations(value: unknown, rules: Map<string, Rule>, path = '', out: string[] = []): string[] {
  if (value === undefined) return out;
  const rule = rules.get(path);
  if (rule !== undefined) {
    const ok =
      rule === 'keep' ||
      (rule === 'empty'
        ? Array.isArray(value) && value.length === 0
        : rule === 'absent'
          ? false
          : typeof rule === 'string' && rule.startsWith('=')
            ? value === rule.slice(1)
            : value === rule);
    if (!ok) out.push(`${path}: ${rule === 'absent' ? '없어야 하는 칸' : `규칙 ${String(rule)}과 다름`}`);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) violations(item, rules, `${path}[]`, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) violations(v, rules, path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push(`${path || '(값)'}: 허용 목록에 없는 칸 — 세션 없는 연결에 보낼지 정하세요`);
  return out;
}

// ───── 준비 ─────

let h: Harness;
let server: RunningServer;
const raw = new Map<WookTopic, unknown[]>();
const streams: SseClient[] = [];
const NO_SESSION: RemoteCaller = { surface: 'remote', session: null, clientKey: 'anonymous' };
let ownerCaller: RemoteCaller;

beforeAll(async () => {
  h = await createHarness({ mode: 'server', speed: 1 });
  for (const topic of IPC_TOPICS) {
    raw.set(topic, []);
    h.orch.backend.onTopicRaw(topic, (p) => void raw.get(topic)!.push(structuredClone(p)));
  }
  // 등록된 대표와 그 기기 세션 — 로그인한 원격 연결
  h.core.ctx.store.kv.set('owner', { sub: 'google-owner-sub', email: 'owner@example.com', name: '대표', registeredAt: h.core.ctx.now(), lastLoginAt: null });
  const { session } = h.core.deviceSessions.issue({ deviceName: '휴대폰' });
  ownerCaller = { surface: 'remote', session: deviceSessionView(session, session.id), clientKey: `session:${session.id}` };
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test', sse: { heartbeatMs: 100 } });
  const anon = await openSse(server.url, '', '');
  streams.push(anon);
  await anon.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '세션 없는 연결의 첫 스냅숏', 10_000);
  // 업무 내용이 생기게: 명령 → 턴(CLI 이벤트), 알림, 턴이 도는 중의 긴급 정지
  await h.internal('command.send', { target: h.projectId, text: '출시 계획을 정리해 주세요' });
  await h.waitFor(() => h.core.turns.count() > 0, { label: '턴이 돈다', timeoutMs: 30_000 });
  h.core.ctx.notify({ level: 'normal', title: '보고서가 올라왔습니다', body: '출시 계획 보고서' });
  await h.waitFor(() => raw.get('cliEvents')!.length > 0, { label: 'CLI 이벤트', timeoutMs: 30_000 });
  await h.core.stops.emergency('owner');
  await anon.waitFor((ev) => ev.some((e) => e.event === 'emergency'), '세션 없는 연결의 긴급 정지', 15_000);
  await sleep(300);
}, 120_000);

afterAll(async () => {
  for (const s of streams) s.close();
  await server?.close();
  await h?.close();
});

/** 버스로 내지 않는 칸까지 채운 값 — 실제 값 위에 (AI 한도·문제 글, 실행 수, 이동 대상 ID) */
function filled(topic: WookTopic): unknown[] {
  const snap = raw.get('snapshot')!.at(-1) as AppSnapshot;
  switch (topic) {
    case 'snapshot':
      return [
        {
          ...snap,
          stop: { ...snap.stop, heldByEmergency: 3 },
          ai: snap.ai.map((a) => ({ ...a, version: '9.9.9', problem: '로그인이 필요합니다', usageLimitedUntil: snap.generatedAt, modelLimits: [{ family: 'opus', label: 'Opus', until: snap.generatedAt }], authRequired: true, blocked: true })),
          running: { total: 2, general: 1, management: 1, cap: 4, generalCap: 3, queued: 5 },
        },
      ];
    case 'navigate':
      return [
        { tab: 'projects', projectId: h.projectId, memberId: 'M-0001', taskId: 'T-0001', directiveId: 'D-0001' },
        { tab: 'documents', reportId: 'R-0001', projectId: h.projectId },
        { tab: 'settings', section: 'account' },
        { tab: 'simulation' },
      ];
    case 'openSettings':
      return [{ section: 'account' }];
    default:
      return [];
  }
}

describe('세션 없는 원격 연결의 토픽 허용 목록 (S3-20·S3-21)', () => {
  it('모든 토픽이 허용 목록에 있다 — 새 토픽은 정할 때까지 실패한다', () => {
    expect(IPC_TOPICS.filter((t) => !(t in ALLOW))).toEqual([]);
    expect(Object.keys(ALLOW).sort()).toEqual([...IPC_TOPICS].sort());
  });

  it('오케스트레이터가 낸 토픽과 칸을 채운 값을 거르면 허용 목록 밖의 칸이 없다 — 알림·CLI 이벤트는 보내지 않는다', () => {
    // 시험이 실제로 업무 내용을 거쳤다 (거른 값이 비어 있어서 통과한 것이 아니다)
    const lastRaw = raw.get('snapshot')!.at(-1) as AppSnapshot;
    const em = raw.get('emergency')!.at(-1) as EmergencySummary;
    expect([lastRaw.projects.length > 0, lastRaw.members.length > 0, em.stoppedTurns.length + em.heldTasks.length > 0, raw.get('notification')!.length > 0, raw.get('cliEvents')!.length > 0]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    const found: Record<string, string[]> = {};
    for (const topic of IPC_TOPICS) {
      const allow = ALLOW[topic];
      const payloads = [...raw.get(topic)!, ...filled(topic)];
      expect(payloads.length, `${topic}의 값이 하나 이상`).toBeGreaterThan(0);
      for (const p of payloads) {
        const sent = h.orch.backend.topicFor(topic, p as never, NO_SESSION);
        if (allow === NOT_SENT) {
          if (sent !== undefined) (found[topic] ??= []).push('세션 없는 연결에 보냈다');
          continue;
        }
        expect(sent, `${topic}은(는) 보낸다`).not.toBeUndefined();
        for (const v of violations(sent, rulesOf(allow))) if (!(found[topic] ??= []).includes(v)) found[topic]!.push(v);
      }
    }
    expect(found).toEqual({});
  });

  it('첫 스냅숏(snapshotFor)도 같은 규칙이다', async () => {
    const snap = await h.orch.backend.snapshotFor(NO_SESSION);
    expect(violations(snap, rulesOf(SNAPSHOT))).toEqual([]);
  });

  it('메인 자리는 LOCKED_SEAT 그대로 간다 — 실제 보유자가 앉아 있어도, 첫 스냅숏·밀어주기·데스크톱 로그아웃 화면 모두 (S4-11)', async () => {
    const real = (raw.get('snapshot')!.at(-1) as AppSnapshot).seat;
    // 시험이 실제 보유자를 거쳤다 (빈 자리여서 통과한 것이 아니다)
    expect([real.generation >= 1, real.state, real.holder?.kind, real.since !== null]).toEqual([true, 'active', 'launched', true]);
    expect(h.orch.backend.topicFor('snapshot', raw.get('snapshot')!.at(-1) as AppSnapshot, NO_SESSION)!.seat).toEqual(LOCKED_SEAT);
    expect((await h.orch.backend.snapshotFor(NO_SESSION)).seat).toEqual(LOCKED_SEAT);
    expect(lockedSnapshot(raw.get('snapshot')!.at(-1) as AppSnapshot).seat).toEqual(LOCKED_SEAT);
    expect(viewerTopic('snapshot', raw.get('snapshot')!.at(-1) as AppSnapshot, false)!.seat).toEqual(LOCKED_SEAT);
    // 로그인한 원격 연결은 실제 자리를 받는다
    expect(h.orch.backend.topicFor('snapshot', raw.get('snapshot')!.at(-1) as AppSnapshot, ownerCaller)!.seat).toEqual(real);
    // 세션 없는 연결의 SSE로 간 스냅숏도 모두 빈 값
    const anonSeats = streams[0]!.events.filter((ev) => ev.event === 'snapshot').map((ev) => (ev.data.payload as AppSnapshot).seat);
    expect(anonSeats.length).toBeGreaterThan(0);
    expect(anonSeats).toEqual(anonSeats.map(() => LOCKED_SEAT));
  });

  it('로그인한 원격 연결은 그대로 받는다 — 긴급 정지 요약·AI 상태·실행 수·이동 대상', () => {
    const em = raw.get('emergency')!.at(-1) as EmergencySummary;
    expect(h.orch.backend.topicFor('emergency', em, ownerCaller)).toEqual(em);
    const [full] = filled('snapshot') as AppSnapshot[];
    const sent = h.orch.backend.topicFor('snapshot', full!, ownerCaller)!;
    expect([sent.ai, sent.running, sent.stop.heldByEmergency, sent.projects.length > 0]).toEqual([full!.ai, full!.running, 3, true]);
    const nav = filled('navigate')[0] as NavTarget;
    expect(h.orch.backend.topicFor('navigate', nav, ownerCaller)).toEqual(nav);
  });

  it('데스크톱 화면의 로그아웃 규칙은 그대로다 — 긴급 정지 요약은 그대로, 잠긴 스냅숏의 AI 상태·실행 수도 그대로 (onTopic의 viewerTopic)', () => {
    const em = raw.get('emergency')!.at(-1) as EmergencySummary;
    expect(viewerTopic('emergency', em, false)).toEqual(em);
    const [full] = filled('snapshot') as AppSnapshot[];
    const locked = lockedSnapshot(full!);
    expect([locked.ai, locked.running, locked.stop.heldByEmergency, locked.projects]).toEqual([full!.ai, full!.running, 3, []]);
  });
});

describe('세션 없는 SSE 연결 (프로브 P4·P6)', () => {
  it('긴급 정지 토픽에 팀원 이름·작업 제목이 없고, 스냅숏의 AI 상태는 로그인 전 system.prereqs만큼이다', async () => {
    const anon = streams[0]!;
    const em = anon.events.find((e) => e.event === 'emergency')!.data.payload as EmergencySummary;
    expect({ stoppedTurns: em.stoppedTurns, heldTasks: em.heldTasks, failures: em.failures, at: typeof em.at }).toEqual({ stoppedTurns: [], heldTasks: [], failures: [], at: 'string' });
    const snaps = anon.events.filter((e) => e.event === 'snapshot').map((e) => e.data.payload as AppSnapshot);
    expect(snaps.length).toBeGreaterThan(1);
    for (const s of snaps) expect(violations(s, rulesOf(SNAPSHOT))).toEqual([]);
    const pre = (await (await fetch(`${server.url}/api/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'p-1', method: 'system.prereqs', args: [] }) })).json()) as {
      value: { claude: { version: string | null }; codex: { version: string | null } };
    };
    expect([pre.value.claude.version, pre.value.codex.version, ...snaps.at(-1)!.ai.map((a) => a.version)]).toEqual([null, null, null, null]);
  });
});
