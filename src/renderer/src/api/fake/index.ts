import { devParam } from '../env';
import { createFakeWeb } from './web';
import { DESKTOP_METHODS, DESKTOP_OPERATOR_SETTINGS } from '../../../../shared/ipc';
import type { WookApiMethods, WookBridge, WookTopics, WookTopic } from '../../../../shared/ipc';
import type { AppSnapshot, SystemInfo } from '../../../../shared/views';
import { LOCKED_SEAT } from '../../../../shared/views';
import { createFakeSeat } from './seat';
import { createFakeScreens } from './screens';
import { holderLabel, EXTERNAL_ACCESS_ENDED } from '../../lib/agents';
import type { CliEvent } from '../../../../shared/events';
import type { Settings } from '../../../../shared/domain';
import { officeDemoSnapshot, officeDemoStep } from './officeDemo';
import { officeDepartmentSnapshot, mainReplyFixture, mainReplyHistory } from './departments';
import { createServerAuth } from './serverAuth';
import {
  snapshot,
  settings,
  roles,
  reports,
  notifications,
  activity,
  recovery,
  conversations,
  skills,
  now,
  ago,
  progress,
  counts,
} from './data';
type Listener<T extends WookTopic> = (payload: WookTopics[T]) => void;
const listeners: { [K in WookTopic]: Set<Listener<K>> } = {
  snapshot: new Set(),
  cliEvents: new Set(),
  notification: new Set(),
  navigate: new Set(),
  emergency: new Set(),
  openSettings: new Set(),
};
function fakeParams() {
  const query = new URLSearchParams();
  for (const name of ['fakeSeat', 'fakeScreen', 'fakeAgents', 'fakeMode', 'fakeSetup', 'fakeLogin']) { const value = devParam(name); if (value !== null) query.set(name, value); }
  return query;
}
const fakeWeb = createFakeWeb();
const officeDemoQuery = devParam('officeDemo');
const officeState = devParam('officeState');
const emergencyPreview = devParam('capture') === 'emergency';
const officeDemoStart = Date.now();
const seatFixture = createFakeSeat(fakeParams());
const screenFixture = createFakeScreens();
snapshot.seat = seatFixture.seat;
if (snapshot.seat.screen.unavailable) notifications.unshift({ id: 'N-SCREEN', key: `screen:${snapshot.seat.screen.unavailable.code}`, level: 'info', title: '화면 도구를 쓸 수 없습니다', body: snapshot.seat.screen.unavailable.text, createdAt: now(), read: false, link: { tab: 'seat', panel: 'screen' } });
activity.unshift({ ...activity[0], seq: 1003, kind: 'screen', actor: 'M-MAIN', actorName: '메인 에이전트', memberId: 'M-MAIN', projectId: 'P-0001', text: '화면 조작 3회: 메모장 (캡처 2장, 거부 1회)', ts: ago(1) });
let stateBeforeStop = snapshot.seat.state;
notifications.unshift({ id: 'N-SEAT-CHANGED', key: `seat:${snapshot.seat.generation}`, level: 'info', title: '메인 에이전트가 바뀌었습니다', body: `운영자가 서버 PC에서 메인 자리를 ${holderLabel(snapshot.seat.holder)}에 배정했습니다.`, createdAt: ago(90), read: false, link: { tab: 'seat' } });
if (snapshot.seat.state === 'switching') notifications.unshift({ id: 'N-SEAT-SWITCH', key: `seat-switch:${snapshot.seat.generation}`, level: 'urgent', title: '메인 자리 교체가 멈췄습니다', body: `${holderLabel(snapshot.seat.pendingHolder)}로 교체를 마치지 못했습니다. 서버 PC의 운영자가 확인해야 합니다.`, createdAt: now(), read: false, link: { tab: 'seat' } });
if (snapshot.seat.unresponsiveSince) notifications.unshift({ id: 'N-SEAT-UNRESPONSIVE', key: `seat-unresponsive:${snapshot.seat.generation}`, level: 'urgent', title: '메인 에이전트 응답 없음', body: `${snapshot.seat.holder?.label}의 응답을 기다리고 있습니다. 명령을 보내거나 긴급 정지할 수 있습니다.`, createdAt: now(), read: false, link: { tab: 'seat' } });
activity.unshift(...(['seat', 'journal'] as const).map((kind, i) => ({ ...activity[0], seq: 1002 - i, kind, actorName: kind === 'seat' ? '운영자' : '메인 에이전트', actor: kind === 'seat' ? 'operator' : 'M-MAIN', memberId: 'M-MAIN', projectId: null, text: kind === 'seat' ? `운영자가 메인 자리를 ${holderLabel(snapshot.seat.holder)}에 배정했습니다.` : '메인이 모바일 화면 점검 약속을 남겼습니다.', ts: ago(i + 1) })));
snapshot.recentActivity = activity.slice(0, 30);
const fakeAuthKey = 'wook-renderer-fake-auth-v1';
function persistFakeAuth() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(fakeAuthKey, JSON.stringify({ clientId: settings.account.googleClientId,
    secretSet: snapshot.auth.googleSecretSet, ownerRegistered: snapshot.auth.ownerRegistered,
    setupOpen: snapshot.auth.googleSetupOpen }));
}
if (typeof window !== 'undefined') {
  try {
    const saved = JSON.parse(window.localStorage.getItem(fakeAuthKey) ?? 'null') as
      { clientId?: string; secretSet?: boolean; ownerRegistered?: boolean; setupOpen?: boolean } | null;
    if (saved) {
      settings.account.googleClientId = saved.clientId ?? '';
      settings.account.googleClientSecretSet = !!saved.secretSet;
      snapshot.auth.googleConfigured = Boolean(saved.clientId);
      snapshot.auth.googleSecretSet = !!saved.secretSet;
      snapshot.auth.ownerRegistered = !!saved.ownerRegistered;
      snapshot.auth.googleSetupOpen = saved.setupOpen ?? !saved.ownerRegistered;
    }
  } catch { /* Keep the seeded fake state when local storage is unavailable. */ }
  if (devParam('fakeDevLogin') === '0') snapshot.auth.devLoginAllowed = false;
}
function previewSnapshot(): AppSnapshot {
  const elapsed = Date.now() - officeDemoStart;
  const step = officeDemoStep(officeDemoQuery, elapsed);
  const view = officeDepartmentSnapshot(step ? officeDemoSnapshot(snapshot, step, elapsed) : structuredClone(snapshot),officeState);
  if (!view.auth.loggedIn) view.seat = structuredClone(LOCKED_SEAT);
  return view;
}
function emit<K extends WookTopic>(topic: K, payload: WookTopics[K]) {
  listeners[topic].forEach((listener) => listener(payload));
}
// Development only; devParam is inert in the remote build. Replies use the real topic and history path.
if(devParam('fakeReply')) {
  window.setTimeout(()=>{
    const choice=devParam('fakeReply');
    for(const target of choice==='both'?[null,'P-8001']:choice==='project'?['P-8001']:[null]){
      const fixture=mainReplyFixture(target,now());
      conversations[target??'main']=[...(conversations[target??'main']??[]),...mainReplyHistory(fixture.message.createdAt),fixture.message];
      notifications.unshift(fixture.notice);
      snapshot.notifications.unread=notifications.filter(item=>!item.read).length;
      emit('notification',fixture.notice);
    }
    emit('snapshot',previewSnapshot());
  },1800);
}
function changed() {
  const cap = Math.max(1, Math.floor(settings.execution.maxConcurrent) || 1);
  const generalCap = cap >= 2 ? cap - 1 : cap;
  settings.execution.maxConcurrent = cap;
  let management = 0;
  let general = 0;
  for (const member of snapshot.members) {
    if (member.deleted) continue;
    if (member.currentTask) {
      const task = snapshot.tasks.find((value) => value.id === member.currentTask?.id);
      if (task) {
        member.currentTask.state = task.state;
        member.currentTask.inReview = task.state === 'in_review';
        if (task.state === 'done' || task.state === 'cancelled') {
          member.currentTask = null;
          member.currentWork = null;
          if (member.status === 'working') member.status = 'idle';
        }
      }
    }
  }
  const working = snapshot.members.filter((member) => !member.deleted && member.status === 'working');
  const ordered = [
    ...working.filter((member) => member.isMain || member.isProducer),
    ...working.filter((member) => !member.isMain && !member.isProducer),
  ];
  for (const member of ordered) {
    const isManagement = member.isMain || member.isProducer;
    if (management + general < cap && (isManagement || general < generalCap)) {
      if (isManagement) management += 1;
      else general += 1;
      continue;
    }
    member.status = 'idle';
    member.statusReasons = ['실행 자리가 날 때까지 기다립니다.'];
    member.currentWork = null;
    member.currentSessionId = null;
    member.queuedCount += 1;
  }
  for (const member of snapshot.members) {
    if (member.status !== 'working') {
      member.currentWork = null;
      member.currentSessionId = null;
      if (member.pendingAiChange) {
        const next = member.pendingAiChange;
        member.ai = {
          ...member.ai,
          ...next,
          effortValue: next.effortOverride ?? settings.team.effortMapping[next.kind][next.effortTier],
        };
        member.pendingAiChange = null;
      }
    }
  }
  snapshot.version += 1;
  snapshot.generatedAt = now();
  snapshot.notifications.unread = notifications.filter((item) => !item.read).length;
  snapshot.notifications.urgentUnread = notifications.filter((item) => !item.read && item.level === 'urgent').length;
  snapshot.projects.forEach((project) => {
    const team = snapshot.members.filter((member) => member.projectId === project.id && !member.deleted);
    project.memberStatusCounts = counts();
    team.forEach((member) => {
      project.memberStatusCounts[member.status] += 1;
    });
    project.activeDirectiveCount = snapshot.directives.filter(
      (directive) => directive.projectId === project.id && !['closed', 'cancelled'].includes(directive.state),
    ).length;
    const report = reports.find((item) => item.projectId === project.id);
    project.latestReport = report
      ? {
          id: report.id,
          title: report.title,
          createdAt: report.createdAt,
          status: report.status,
        }
      : null;
  });
  snapshot.running.total = management + general;
  snapshot.running.management = management;
  snapshot.running.general = general;
  snapshot.running.cap = cap;
  snapshot.running.generalCap = generalCap;
  emit('snapshot', previewSnapshot());
}
function findProject(id: string) {
  const result = (officeState||officeDemoQuery?previewSnapshot():snapshot).projects.find((value) => value.id === id);
  if (!result) throw new Error('프로젝트를 찾을 수 없습니다.');
  return result;
}
function findMember(id: string) {
  const result = (officeState||officeDemoQuery?previewSnapshot():snapshot).members.find((value) => value.id === id && !value.deleted);
  if (!result) throw new Error('팀원을 찾을 수 없습니다.');
  return result;
}
function findTask(id: string) {
  const result = (officeState||officeDemoQuery?previewSnapshot():snapshot).tasks.find((value) => value.id === id);
  if (!result) throw new Error('작업을 찾을 수 없습니다.');
  return result;
}
function findDirective(id: string) {
  const result = (officeState||officeDemoQuery?previewSnapshot():snapshot).directives.find((value) => value.id === id);
  if (!result) throw new Error('지시를 찾을 수 없습니다.');
  return result;
}
function findReport(id: string) {
  const result = reports.find((value) => value.id === id);
  if (!result) throw new Error('보고서를 찾을 수 없습니다.');
  return result;
}
function announce(title: string, body: string, level: 'urgent' | 'normal' | 'info' = 'normal') {
  const item = {
    id: `N-${Date.now()}`,
    title,
    body,
    level,
    link: null,
    createdAt: now(),
    read: false,
  };
  notifications.unshift(item);
  emit('notification', item);
  changed();
}
function log(text: string, projectId: string | null = null) {
  activity.unshift({
    seq: (activity[0]?.seq ?? 100) + 1,
    ts: now(),
    actor: 'owner',
    actorName: '대표',
    projectId,
    taskId: null,
    memberId: null,
    kind: 'system',
    level: 'info',
    text,
    result: null,
    requestId: null,
    sessionId: null,
    turnId: null,
  });
  snapshot.recentActivity = activity.slice(0, 30);
}
function mergeSettings(base: object, patch: object): void {
  for (const key of Object.keys(patch)) {
    const value: unknown = Reflect.get(patch, key);
    if (value === undefined) continue;
    const current: unknown = Reflect.get(base, key);
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      mergeSettings(current, value);
    } else {
      Reflect.set(base, key, value);
    }
  }
}
const diff = (id: string) => ({
  taskId: id,
  base: 'main',
  head: `work/${id.toLowerCase()}`,
  files: [
    {
      path: 'src/ui/WalkLog.tsx',
      status: 'M' as const,
      additions: 17,
      deletions: 3,
    },
    {
      path: 'docs/walk-log-flow.md',
      status: 'A' as const,
      additions: 22,
      deletions: 0,
    },
  ],
  patch:
    'diff --git a/src/ui/WalkLog.tsx b/src/ui/WalkLog.tsx\n--- a/src/ui/WalkLog.tsx\n+++ b/src/ui/WalkLog.tsx\n@@ -12,3 +12,4 @@\n-<button>장소 선택</button>\n+<button className="primary">장소 저장</button>\n+<p>기록 카드에 방문 날짜를 표시합니다.</p>\n',
  truncated: false,
});
const eventStore: Record<string, CliEvent[]> = {};
const event = (memberId: string, kind: CliEvent['kind'], text: string, data?: CliEvent['data']): CliEvent => {
  const turnId = `TN-${memberId}`;
  const list = eventStore[memberId] ?? (eventStore[memberId] = []);
  const item = {
    seq: list.length + 1,
    ts: now(),
    turnId,
    kind,
    text,
    data,
    raw: {
      type: kind,
      message: text,
      data: data ?? {},
    },
  };
  list.push(item);
  emit('cliEvents', {
    memberId,
    turnId,
    events: [item],
  });
  return item;
};
for (const member of snapshot.members) {
  event(member.id, 'session', '세션을 시작했습니다.', {
    ...(member.isMain && snapshot.seat.holder?.kind === 'external' ? {} : { permissionMode: 'bypassPermissions' }),
    mcpServers: [
      {
        name: 'wook',
        status: 'connected',
      },
    ],
  });
  event(member.id, 'text', member.lastLine ?? '다음 업무를 확인하고 있습니다.');
  if (member.currentTask) {
    event(member.id, 'command_start', '자동 검사를 실행합니다.', {
      command: 'npm test',
    });
    event(member.id, 'command_end', '명령이 완료됐습니다.', {
      command: 'npm test',
      exitCode: 0,
    });
    event(member.id, 'file_change', '파일 2개를 변경했습니다.', {
      paths: ['src/ui/WalkLog.tsx', 'docs/walk-log-flow.md'],
    });
    event(member.id, 'mcp_call', '작업 단계를 보고했습니다.', {
      server: 'wook',
      tool: 'task_step_complete',
    });
  }
  if (member.status === 'error')
    event(member.id, 'error', 'CLI 연결이 끊어졌습니다.', {
      errorKind: 'other',
    });
}
for (let index = 0; index < 48; index++) event('M-0002', 'text', `장소 데이터 검토 ${index + 1}단계를 기록했습니다.`);
eventStore['M-0002'].push({
  seq: 1,
  ts: ago(800),
  turnId: 'TN-OLD-M-0002',
  kind: 'result',
  text: '이전 턴이 완료됐습니다.',
  raw: {
    type: 'result',
    message: '이전 턴이 완료됐습니다.',
  },
});
if (typeof window !== 'undefined' && !window.wook)
  window.setInterval(() => {
    snapshot.members
      .filter((member) => member.status === 'working')
      .forEach((member) =>
        event(
          member.id,
          'text',
          ['코드를 살펴보고 있습니다.', '검사 결과를 정리하고 있습니다.', '다음 단계를 진행합니다.'][Math.floor(Math.random() * 3)],
        ),
      );
  }, 2000);
export const FORBIDDEN_MESSAGE = '대표 화면에서 하는 일이 아닙니다. 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — 명령창으로 메인 에이전트에게 말하세요.';
function forbidden() { return Object.assign(new Error(FORBIDDEN_MESSAGE), { code: 'forbidden' }); }
function authModesAllowed(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([kind, mode]) => (kind === 'claude' || kind === 'codex') &&
      (mode === 'subscription' || mode === 'api_key'));
}
function installationPatchAllowed(value: unknown, path = ''): boolean {
  if (!path && value && typeof value === 'object' && 'developer' in value) {
    const dev = value.developer;
    return Object.keys(value).length === 1 && !!dev && typeof dev === 'object' &&
      Object.keys(dev).length === 1 && 'mainAgentMock' in dev && dev.mainAgentMock === false;
  }
  const allowed = [...DESKTOP_OPERATOR_SETTINGS, 'general.mainAgent'];
  if (allowed.some(key => path === key || path.startsWith(`${key}.`))) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) => installationPatchAllowed(entry, path ? `${path}.${key}` : key));
}
function reportCanApprove(id: string): boolean {
  const report = findReport(id);
  if (report.status === 'approved') return false;
  if (!report.directiveId) return report.status !== 'changes_requested';
  const directive = findDirective(report.directiveId);
  return directive.state === 'awaiting_confirmation' && directive.round === report.round && directive.latestReportId === id;
}
function requestChangesRefusal(id: string): string | null {
  const report = findReport(id);
  if (report.status === 'approved' || report.status === 'changes_requested') return '현재 수정 요청할 수 없는 보고서입니다.';
  if (report.directiveId) {
    const directive = findDirective(report.directiveId);
    if (directive.state === 'closed' || directive.state === 'cancelled') return '지시가 이미 끝나 이 보고서에는 수정 요청을 할 수 없습니다. 바꿀 것이 있으면 명령창으로 메인 에이전트에게 말해 주세요.';
    if (directive.round > report.round) return '이미 새 회차가 열려 이 보고서에는 수정 요청을 할 수 없습니다.';
  }
  return null;
}
const serverAuth = createServerAuth({ snapshot, query: fakeParams(), changed,
  notify: item => notifications.unshift(item) });
const handlers: Partial<WookApiMethods> = {
  'projects.setMock': (id, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || input.enabled !== false) throw forbidden();
    const project = findProject(id);
    project.mock.enabled = false;
    changed();
    return structuredClone(project);
  },
  'auth.getState': () => structuredClone(snapshot.auth),
  'auth.deviceLogin': deviceName => serverAuth.start(deviceName),
  'auth.deviceLoginPoll': loginId => serverAuth.poll(loginId),
  'auth.setupOwner': (code, email) => serverAuth.setup(code, email),
  'auth.listDevices': () => serverAuth.list(),
  'auth.revokeDevice': sessionId => serverAuth.revoke(sessionId),
  'auth.login': () => {
    if (snapshot.auth.mode === 'server') throw new Error('서버에서는 기기 코드로 로그인해 주세요.');
    if (!snapshot.auth.googleConfigured || !(snapshot.auth.googleSecretSet || snapshot.auth.googleSetupOpen === false)) throw new Error('구글 로그인 설정을 먼저 완료해 주세요.');
    snapshot.auth = {
      ...snapshot.auth,
      ownerRegistered: true,
      googleSetupOpen: false,
      loggedIn: true,
      owner: {
        email: 'owner@example.com',
        name: '대표',
      },
    };
    persistFakeAuth();
    changed();
    return structuredClone(snapshot.auth);
  },
  'auth.devLogin': () => {
    if (snapshot.auth.mode === 'server') throw new Error('서버에서는 기기 코드로 로그인해 주세요.');
    snapshot.auth = {
      ...snapshot.auth,
      loggedIn: true,
      owner: {
        email: 'dev@wook.local',
        name: '대표',
      },
    };
    changed();
    return structuredClone(snapshot.auth);
  },
  'auth.logout': () => {
    if (snapshot.auth.mode === 'server') return serverAuth.logout();
    snapshot.auth = {
      ...snapshot.auth,
      loggedIn: false,
      owner: null,
    };
    changed();
    return structuredClone(snapshot.auth);
  },
  'snapshot.get': () => previewSnapshot(),
  'seat.get': () => structuredClone(snapshot.seat),
  'seat.history': () => structuredClone(seatFixture.history),
  'seat.handover': generation => seatFixture.handover(generation),
  'journal.list': filter => seatFixture.list(filter),
  'screens.recent': filter => screenFixture.recent(filter),
  'screens.image': id => screenFixture.image(id),
  'agents.list': () => structuredClone(seatFixture.agents),
  'members.getDetail': (id) => {
    const view = officeDemoQuery || officeState ? previewSnapshot() : snapshot;
    const member = view.members.find((item) => item.id === id) ?? findMember(id);
    const role = roles.find((r) => r.id === member.roleId) ?? roles[0];
    const owned = view.tasks.filter((t) => t.assigneeId === id);
    const external = member.isMain && view.seat.holder?.kind === 'external';
    return {
      member: structuredClone(member),
      role: structuredClone(role),
      sessions: [
        {
          id: `S-${id}`,
          kind: member.isMain ? ('main_general' as const) : ('task' as const),
          workKey: member.currentTask?.id ?? id,
          label: member.currentTask?.title ?? '스튜디오 관리',
          cliSessionId: external ? null : member.currentSessionId,
          aiKind: external ? 'external' : member.ai.kind,
          mock: external ? false : member.ai.mock,
          createdAt: ago(400),
          closedAt: null,
          previousSessionId: `S-OLD-${id}`,
          replaceReason: '새 작업 시작',
          turnCount: 2,
          current: true,
        },
        {
          id: `S-OLD-${id}`,
          kind: 'task' as const,
          workKey: '지난 작업',
          label: '지난 작업',
          cliSessionId: null,
          aiKind: member.ai.kind,
          mock: member.ai.mock,
          createdAt: ago(2000),
          closedAt: ago(1000),
          previousSessionId: null,
          replaceReason: null,
          turnCount: 3,
          current: false,
        },
      ],
      recentTurns: [
        {
          id: `TN-${id}`,
          runner: external ? 'external' : 'cli',
          sessionId: `S-${id}`,
          startedAt: ago(13),
          endedAt: null,
          endReason: null,
          endDetail: '',
          bypass: member.status === 'error' ? ('mismatch' as const) : ('verified' as const),
          mcp: 'connected' as const,
          eventCount: eventStore[id]?.length ?? 0,
          usage: external ? null : {
            inputTokens: 2840,
            outputTokens: 640,
            costUsd: null,
          },
          running: member.status === 'working',
        },
        {
          id: `TN-OLD-${id}`,
          sessionId: `S-OLD-${id}`,
          startedAt: ago(820),
          endedAt: ago(800),
          endReason: 'completed' as const,
          endDetail: '작업을 정리했습니다.',
          bypass: 'requested' as const,
          mcp: 'unknown' as const,
          eventCount: id === 'M-0002' ? 1 : 0,
          usage: {
            inputTokens: 1600,
            outputTokens: 430,
            costUsd: null,
          },
          running: false,
        },
      ],
      currentTask: owned.find((t) => t.id === member.currentTask?.id) ?? null,
      queuedTasks: owned.filter((t) => t.state === 'waiting'),
      history: owned.map((t) => ({
        taskId: t.id,
        title: t.title,
        state: t.state,
        completedAt: t.completedAt,
        durationSec: 1400,
        rejects: t.review.rejectsTotal,
      })),
      messages: [
        { id: `MSG-SHARED-${id}`, from: '메인 에이전트 지시 → 하늘 (공유)', text: '장소 저장 흐름을 함께 확인해 주세요.', createdAt: ago(50), delivered: true },
        { id: `MSG-REDELIVER-${id}`, from: '메인 에이전트 긴급 지시', text: '(다시 전달 — 이전 턴이 끊겼습니다) 지난 작업의 결과를 확인해 주세요.',
          createdAt: ago(60), delivered: false, undelivered: null },
        { id: `MSG-DEMO-${id}`, from: '메인 에이전트 지시', text: '지난 작업의 결과를 확인해 주세요.',
          createdAt: ago(85), delivered: false, undelivered: `지시 D-0001이${'(가)'} 취소됨` }],
    };
  },
  'members.getEvents': (id, opts) => {
    findMember(id);
    const list = (eventStore[id] ?? []).filter((item) => !opts.turnId || item.turnId === opts.turnId);
    const after = list.filter(event => event.seq > Number(opts.cursor ?? 0));
    const page = after.slice(0, opts.limit ?? 40);
    return {
      events: page,
      nextCursor: after.length > page.length ? String(page[page.length - 1].seq) : null,
      turnId: opts.turnId ?? `TN-${id}`,
    };
  },
  'command.send': (input) => {
    if (!input.text.trim() && !input.attachments?.length) throw new Error('명령을 입력하거나 파일을 첨부해 주세요.');
    const id = `D-${String(snapshot.directives.length + 1).padStart(4, '0')}`;
    const list = conversations[input.target] ?? (conversations[input.target] = []);
    list.push({
      id: `C-${Date.now()}`,
      role: 'owner',
      text: input.text,
      attachments: (input.attachments ?? []).map((a, i) => ({
        id: `A-${i}`,
        name: a.name,
        path: a.path ?? a.dataUrl ?? (a.uploadId ? `uploads/${a.uploadId}/${a.name}` : ''),
        size: a.uploadId ? fakeWeb.uploaded.get(a.uploadId)?.size ?? 0 : 0,
        mime: a.dataUrl ? /^data:([^;,]*)/.exec(a.dataUrl)?.[1] ?? '' : a.uploadId ? fakeWeb.uploaded.get(a.uploadId)?.mime ?? '' : '',
      })),
      directiveId: id,
      createdAt: now(),
    });
    snapshot.directives.unshift({
      id,
      projectId: input.target === 'main' ? null : input.target,
      title: input.text.slice(0, 28) || '첨부 파일 검토',
      text: input.text,
      round: 1,
      state: 'received',
      createdAt: now(),
      updatedAt: now(),
      progress: progress(0, 1),
      taskIds: [],
      latestReportId: null,
      attachments: [],
    });
    list.push({
      id: `C-${Date.now()}-reply`,
      role: 'main_agent',
      text: '지시를 받았습니다. 내용을 확인하고 계획을 세우겠습니다.',
      attachments: [],
      directiveId: id,
      createdAt: now(),
    });
    log('새 지시를 보냈습니다.', input.target === 'main' ? null : input.target);
    announce('지시가 접수됐습니다', input.text.slice(0, 80), 'info');
    return {
      conversationId: id,
    };
  },
  'command.history': (target, opts) => {
    const list = conversations[target] ?? [];
    const end = opts.before
      ? Math.max(
          0,
          list.findIndex((item) => item.id === opts.before),
        )
      : list.length;
    return structuredClone(list.slice(Math.max(0, end - (opts.limit ?? 50)), end));
  },
  'directives.get': (id) => {
    const view = previewSnapshot();
    const directive = view.directives.find(value => value.id === id) ?? findDirective(id);
    return {
      directive: structuredClone(directive),
      tasks: structuredClone(view.tasks.filter((t) => t.directiveId === id)),
      rounds: Array.from(
        {
          length: directive.round,
        },
        (_, i) => ({
          round: i + 1,
          requestedAt: ago(2000 - i * 500),
          text: i === 0 ? directive.text : '버튼 문구를 조금 더 분명하게 수정해 주세요.',
          anchored:
            i === 0
              ? []
              : [
                  {
                    quote: '기록 저장',
                    comment: '표현을 더 구체적으로 바꿔 주세요.',
                  },
                ],
          reportId: reports.find((r) => r.directiveId === id && r.round === i + 1)?.id ?? null,
        }),
      ),
      reports: structuredClone(
        reports.filter((r) => r.directiveId === id).map(({ markdown, sections, stats, comments, otherRounds, filePath, ...item }) => item),
      ),
    };
  },
  'tasks.get': (id) => {
    const task = findTask(id);
    return {
      task: structuredClone(task),
      reviews: [
        {
          id: 'RV-0001',
          reviewRound: 1,
          reviewerId: task.reviewerId ?? 'M-MAIN',
          reviewerName: task.reviewerId === 'M-MAIN' ? '메인 에이전트' : (snapshot.members.find((m) => m.id === task.reviewerId)?.name ?? '검수자'),
          verdict: 'reject' as const,
          criteria: task.acceptanceCriteria.map((criterion) => ({
            criterion,
            pass: false,
            note: '표현 확인 필요',
          })),
          reason: '문구를 더 분명하게 해 주세요.',
          createdAt: ago(250),
        },
      ],
      transitions: [
        {
          from: '-',
          event: 'create',
          to: 'waiting',
          reason: '담당자 배정',
          actor: '프로듀서',
          at: ago(400),
        },
        {
          from: 'in_progress',
          event: 'submit',
          to: 'in_review',
          reason: '단계 완료',
          actor: '담당자',
          at: ago(80),
        },
      ],
      diff: task.outputMode === 'artifact' ? null : diff(id),
      ...(id === 'T-0009' ? { checkRuns: [
        { requestId: 'RQ-CHECK-0', command: 'npm test', state: 'succeeded', startedAt: ago(40), endedAt: ago(39),
          exitCode: 0, timedOut: false, remaining: null, ownerConfirmedAt: ago(30), leftFiles: [] },
        { requestId: 'RQ-CHECK-1', command: 'npm test', state: 'unknown', startedAt: ago(20), endedAt: ago(19),
          exitCode: null, timedOut: true, remaining: -1, ownerConfirmedAt: null, leftFiles: ['dist/index.js', 'build/report.json'] },
      ] } : {}),
      reviewNotes: task.state === 'in_review' ? { uncheckedConflictFiles: ['assets/preview.png'],
        deliverables: { dir: 'deliverables/round-1', files: ['overview.pdf'] } } : undefined,
      artifact: task.outputMode === 'artifact' && task.state === 'done' ? { version: 1, dir: 'deliverables/archive', files: task.type === 'asset' ? ['wiki-guide.wav', 'waveform.png', 'sound-notes.md'] : ['overview.pdf'], finalizedAt: task.completedAt ?? now() } : null,
    };
  },
  'tasks.getDiff': (id) => {
    findTask(id);
    return diff(id);
  },
  'questions.answer': (id, answer) => {
    if (!answer.trim()) throw new Error('답변을 입력해 주세요.');
    snapshot.ownerTodos = snapshot.ownerTodos.filter((todo) => !(todo.kind === 'question' && todo.questionId === id));
    const item = snapshot.members.find((m) => m.status === 'awaiting_answer');
    if (item) {
      item.status = 'idle';
      item.statusReasons = ['답변을 받았습니다.'];
    }
    log('팀원 질문에 답변했습니다.');
    changed();
  },
  'reports.list': (filter) =>
    reports
      .filter(
        (r) =>
          (!filter.text || `${r.title} ${r.markdown}`.toLowerCase().includes(filter.text.toLowerCase())) &&
          (!filter.projectId || (filter.projectId === 'general' ? r.projectId === null : r.projectId === filter.projectId)) &&
          (!filter.status || r.status === filter.status) &&
          (!filter.from || r.createdAt.slice(0, 10) >= filter.from) &&
          (!filter.to || r.createdAt.slice(0, 10) <= filter.to),
      )
      .map(({ markdown, sections, stats, comments, otherRounds, filePath, ...item }) => structuredClone(item)),
  'reports.get': (id) => {
    const item = findReport(id);
    return {
      canApprove: reportCanApprove(id),
      ...structuredClone(item),
      canRequestChanges: !requestChangesRefusal(id),
      otherRounds: reports
        .filter((r) => r.directiveId && r.directiveId === item.directiveId && r.id !== id)
        .map((r) => ({
          id: r.id,
          round: r.round,
        })),
    };
  },
  'reports.markRead': (id) => {
    const item = findReport(id);
    if (item.status === 'new') item.status = 'read';
    snapshot.ownerTodos = snapshot.ownerTodos.filter((todo) => !(todo.kind === 'unread_report' && todo.reportId === id));
    changed();
  },
  'reports.approve': (id, comment) => {
    const item = findReport(id);
    if (!reportCanApprove(id)) throw Object.assign(new Error('현재 승인할 수 없는 보고서입니다.'), { code: 'conflict' });
    if (item.directiveId) findDirective(item.directiveId).state = 'closed';
    item.status = 'approved';
    if (comment.trim())
      item.comments.push({
        id: `RC-${Date.now()}`,
        kind: 'overall',
        quote: null,
        text: comment,
        createdAt: now(),
      });
    log(`${item.title} 결과를 승인했습니다.`, item.projectId);
    changed();
  },
  'reports.requestChanges': (id, input) => {
    const item = findReport(id);
    if (item.status === 'changes_requested') return;
    const refusal = requestChangesRefusal(id);
    if (refusal) throw Object.assign(new Error(refusal), { code: 'conflict' });
    if (!input.overall.trim() && !input.anchored.length) throw new Error('수정 요청 내용을 입력해 주세요.');
    item.status = 'changes_requested';
    item.comments.push(
      {
        id: `RC-${Date.now()}`,
        kind: 'overall',
        quote: null,
        text: input.overall,
        createdAt: now(),
      },
      ...input.anchored.map((a, i) => ({
        id: `RC-${Date.now()}-${i}`,
        kind: 'anchored' as const,
        quote: a.quote,
        text: a.comment,
        createdAt: now(),
      })),
    );
    const detail = [input.overall.trim(), ...input.anchored.map(a => `- "${a.quote}" → ${a.comment}`)].filter(Boolean).join('\n');
    const target = item.projectId ?? 'main';
    const conversation = conversations[target] ?? (conversations[target] = []);
    conversation.push({ id: `C-changes-${id}-${Date.now()}`, role: 'owner',
      text: `보고서 ${id} "${item.title}" 수정 요청:\n${detail}`.slice(0, 20000),
      attachments: [], directiveId: item.directiveId, createdAt: now() });
    log(`${item.title} 수정 요청을 남겼습니다.`, item.projectId);
    changed();
  },
  'notifications.list': (opts) => structuredClone(notifications.slice(0, opts.limit ?? 50)),
  'notifications.markRead': (id) => {
    notifications
      .filter((value) => id === 'all' || value.id === id)
      .forEach((value) => {
        value.read = true;
      });
    changed();
  },
  'stop.emergency': () => {
    const external = snapshot.seat.holder?.kind === 'external';
    seatFixture.agents.forEach(agent => { agent.connected = false; });
    snapshot.seat.screen.operatingSince = null;
    if (!snapshot.stop.global.active) stateBeforeStop = snapshot.seat.state;
    snapshot.seat.state = 'stopped';
    const heldTasks = snapshot.tasks
      .filter((t) => t.state === 'in_progress' || t.state === 'in_review')
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        previousState: t.state,
        projectId: t.projectId,
      }));
    const stoppedTurns = snapshot.members
      .filter((m) => m.status === 'working')
      .map((m) => ({
        turnId: m.currentWork?.turnId ?? `TN-${m.id}`,
        memberId: m.id,
        memberName: m.name,
        taskId: m.currentTask?.id ?? null,
        ok: true,
        detail: m.isMain && external ? EXTERNAL_ACCESS_ENDED : m.currentTask ? `자동 검사 ${m.currentTask.id}: 종료를 확인했습니다.` : '종료를 확인했습니다.',
      }));
    const summary = {
      at: now(),
      completed: !emergencyPreview && !external,
      stoppedTurns,
      heldTasks,
      failures: emergencyPreview ? [
        { memberId: 'M-0004', memberName: '서진(B 프로젝트)(C 프로젝트, M-0005)', detail: '작업 개체 상태를 읽지 못했습니다.', remaining: -1 },
        { memberId: 'M-0004', memberName: '서진(B 프로젝트)(C 프로젝트, M-0005)', detail: '자동 검사에서 남은 프로세스 2개를 확인했습니다.', remaining: 2 },
      ] : external ? [{ memberId: 'M-MAIN', memberName: '메인 에이전트', detail: EXTERNAL_ACCESS_ENDED, remaining: -1 }] : [],
    };
    snapshot.stop.global = {
      active: true,
      since: snapshot.stop.global.since ?? now(),
    };
    snapshot.stop.lastEmergency = summary;
    snapshot.stop.heldByEmergency += heldTasks.length;
    heldTasks.forEach((h) => {
      const task = findTask(h.taskId);
      task.state = 'on_hold';
      task.hold = {
        returnState: h.previousState,
        reasons: [
          {
            kind: 'emergency_stop',
            label: '긴급 정지',
            note: '전역 긴급 정지로 보류됐습니다.',
            since: now(),
          },
        ],
      };
    });
    snapshot.members
      .filter((m) => m.status === 'working')
      .forEach((m) => {
        m.status = 'paused';
        m.currentWork = null;
        m.statusReasons = ['긴급 정지 중입니다.'];
      });
    snapshot.ownerTodos = snapshot.ownerTodos.filter((t) => t.kind !== 'emergency_held');
    snapshot.ownerTodos.unshift({
      kind: 'emergency_held',
      id: 'todo-held-now',
      count: snapshot.stop.heldByEmergency,
      since: now(),
    });
    log('긴급 정지를 실행했습니다.');
    changed();
    emit('emergency', summary);
    return summary;
  },
  'stop.release': () => {
    if (snapshot.stop.global.active) {
      if (snapshot.seat.unresponsiveSince && snapshot.stop.global.since) {
        snapshot.seat.unresponsiveSince = new Date(Date.parse(snapshot.seat.unresponsiveSince) + Date.now() - Date.parse(snapshot.stop.global.since)).toISOString();
      }
      snapshot.seat.state = stateBeforeStop;
    }
    snapshot.stop.global = {
      active: false,
      since: null,
    };
    snapshot.stop.pausedMembers = snapshot.stop.pausedMembers.filter(item => item.memberId !== 'M-MAIN');
    const main = snapshot.members.find(item => item.isMain);
    if (main?.status === 'paused') { main.status = 'idle'; main.statusReasons = ['새 명령을 기다립니다.']; }
    log('정지를 해제했습니다. 보류 작업은 메인 에이전트가 확인합니다.');
    changed();
  },
  'recovery.list': () => structuredClone(recovery),
  'settings.get': () => structuredClone(settings),
  'settings.update': (patch, expected) => {
    if (!installationPatchAllowed(patch)) throw forbidden();
    const loaded = patch.general?.mainAgent !== undefined ? expected?.mainAgent : undefined;
    const current = settings.general.mainAgent;
    if (loaded && (loaded.kind !== current.kind || (loaded.model ?? null) !== (current.model ?? null) || loaded.effortTier !== current.effortTier || (loaded.effortOverride ?? null) !== (current.effortOverride ?? null))) {
      const model = current.model ?? (current.kind === 'codex' ? settings.team.modelCatalog?.codex?.[0]?.id ?? null : null);
      const effort = current.effortOverride ?? settings.team.effortMapping[current.kind][current.effortTier];
      const label = `${current.kind === 'claude' ? 'Claude CLI' : 'Codex CLI'}(${model ? `모델 ${model}` : 'CLI 기본 모델'}, 노력치 ${effort})`;
      throw Object.assign(new Error(`메인 AI가 그사이 ${label}로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요`), { code: 'conflict' });
    }
    if (patch.account && 'authMode' in patch.account && !authModesAllowed(patch.account.authMode)) {
      throw Object.assign(new Error('AI 인증 방식은 구독(subscription)과 API 키(api_key)만 사용할 수 있습니다. 아무것도 저장하지 않았습니다.'), { code: 'invalid' });
    }
    if (patch.account?.googleClientId !== undefined) {
      if (!snapshot.auth.loggedIn && !snapshot.auth.googleSetupOpen) throw new Error('로그인 설정을 지금 바꿀 수 없습니다.');
      if (snapshot.auth.ownerRegistered && !patch.account.googleClientId.trim()) throw new Error('대표가 등록된 동안 클라이언트 ID를 비울 수 없습니다.');
      if (patch.account.googleClientId !== settings.account.googleClientId) snapshot.auth.googleSetupOpen = true;
    }
    mergeSettings(settings, patch);
    snapshot.auth.googleConfigured = Boolean(settings.account.googleClientId);
    persistFakeAuth();
    log('운영 설정을 변경했습니다.');
    changed();
    return structuredClone(settings);
  },
  'settings.setGoogleSecret': (secret) => {
    if (!snapshot.auth.loggedIn && !snapshot.auth.googleSetupOpen) throw new Error('로그인 설정을 지금 바꿀 수 없습니다.');
    if (snapshot.auth.ownerRegistered && !secret.trim()) throw new Error('대표가 등록된 동안 보안 비밀을 비울 수 없습니다.');
    if (secret !== '') snapshot.auth.googleSetupOpen = true;
    settings.account.googleClientSecretSet = Boolean(secret);
    snapshot.auth.googleSecretSet = Boolean(secret);
    snapshot.auth.googleConfigured = Boolean(settings.account.googleClientId);
    persistFakeAuth();
    changed();
    emit('openSettings', {
      section: 'account',
    });
  },
  'settings.setApiKey': (kind, key) => {
    settings.account.authMode[kind] = key ? 'api_key' : 'subscription';
    changed();
  },
  'roles.list': () => structuredClone(roles),
  'skills.list': () => structuredClone(skills),
  'logs.search': (filter) =>
    activity
      .filter(
        (item) =>
          (!filter.text || item.text.includes(filter.text)) &&
          (!filter.projectId || item.projectId === filter.projectId) &&
          (!filter.memberId || item.memberId === filter.memberId) &&
          (!filter.taskId || item.taskId === filter.taskId) &&
          (!filter.level || item.level === filter.level) &&
          (!filter.kinds?.length || filter.kinds.includes(item.kind)) &&
          (!filter.from || item.ts.slice(0, 10) >= filter.from) &&
          (!filter.to || item.ts.slice(0, 10) <= filter.to),
      )
      .slice(0, filter.limit ?? 100),
  'logs.export': () => ({
    path: 'C:\\Users\\owner\\Downloads\\욱채-활동기록.csv',
  }),
  'system.prereqs': () => ({
    git: {
      ok: true,
      version: '2.49.0',
    },
    claude: {
      ok: true,
      version: '2.1.0',
      loggedIn: true,
      detail: '로그인됨',
    },
    codex: {
      ok: true,
      version: '0.113.0',
      loggedIn: false,
      detail: '다시 로그인이 필요합니다.',
    },
    google: {
      configured: snapshot.auth.googleConfigured,
    },
    jobRunner: {
      ok: true,
      detail: '준비됨',
    },
    screen: {
      ok: snapshot.seat.screen.unavailable === null,
      state: snapshot.seat.screen.unavailable?.code ?? 'available',
      detail: snapshot.seat.screen.unavailable?.text ?? '화면 도구를 쓸 수 있습니다.',
      elevated: false,
    },
  }),
  'system.info': (): SystemInfo => ({
    dataDir: 'C:\\Users\\owner\\AppData\\Roaming\\Wook',
    appVersion: '0.5.0-dev',
    isPackaged: false,
    platform: 'win32',
    processRunner: {
      mode: 'jobobject',
      detail: '하위 프로세스를 함께 종료합니다.',
    },
    toolServerUrl: 'http://127.0.0.1:43210',
  }),
  'system.recheckAi': (kind) => {
    const ai = snapshot.ai.find((a) => a.kind === kind);
    if (ai) {
      ai.authRequired = false;
      ai.blocked = false;
      ai.problem = null;
    }
    snapshot.ownerTodos = snapshot.ownerTodos.filter((todo) => !(todo.kind === 'auth_required' && todo.aiKind === kind));
    announce(`${kind === 'claude' ? 'Claude' : 'Codex'} 상태를 다시 확인했습니다.`, '인증 상태 확인이 완료됐습니다.', 'info');
  },
  'system.pickFiles': () => [
    {
      path: 'C:\\Projects\\brief.pdf',
      name: 'brief.pdf',
    },
  ],
  'system.openPath': (path) => {
    if (!path) throw new Error('열 파일 경로가 없습니다.');
  },
};
if (typeof window !== 'undefined' && devParam('capture') === 'main-paused') {
  const main = findMember('M-MAIN');
  main.status = 'paused'; main.currentWork = null;
  main.statusReasons = ['프로세스 종료를 확인하지 못했습니다.'];
  snapshot.stop.pausedMembers.push({ memberId: main.id, since: ago(2), mode: 'graceful', by: 'system', reason: '이전 실행의 프로세스 종료를 확인하지 못했습니다.' });
  notifications.unshift({ id: 'N-MAIN-PAUSE', level: 'urgent', title: '메인 에이전트가 정지했습니다.', body: '이전 실행의 프로세스 종료를 확인하지 못했습니다. 남아 있는 프로세스가 없는지 확인한 뒤 정지를 해제해 주세요.', link: { tab: 'projects', memberId: main.id }, createdAt: now(), read: false });
}
changed();
if (typeof window !== 'undefined' && officeDemoQuery && !window.wook) {
  window.setInterval(() => emit('snapshot', previewSnapshot()), 1000);
}
export const fakeBridge: WookBridge = {
  platform: devParam('fakeDesktop') === '1' ? 'win32' : 'web',
  ...(devParam('fakeDesktop') === '1' ? {} : { web: fakeWeb }),
  async invoke(method, ...args) {
    if (['seat.get', 'seat.history', 'seat.handover', 'journal.list', 'screens.recent', 'screens.image', 'agents.list'].includes(method) && !snapshot.auth.loggedIn) throw Object.assign(new Error('로그인이 필요합니다.'), { code: 'unauthorized' });
    if (!(DESKTOP_METHODS.includes(method) || method === 'system.recheckAi')) throw forbidden();
    if (method === 'projects.setMock' && args.length !== 2) throw forbidden();
    const handler = handlers[method] as (...params: typeof args) => ReturnType<WookApiMethods[typeof method]>;
    if (!handler) throw forbidden();
    return handler(...args);
  },
  subscribe(topic, cb) {
    const set = listeners[topic] as Set<typeof cb>;
    set.add(cb);
    // Same filter as the real event stream.
    if (topic === 'cliEvents') { set.delete(cb); const filtered = ((payload: WookTopics['cliEvents']) => { if (fakeWeb.watched.has(payload.memberId)) (cb as (value: WookTopics['cliEvents']) => void)(payload); }) as typeof cb; set.add(filtered); return () => { set.delete(filtered); }; }
    return () => {
      set.delete(cb);
    };
  },
};
