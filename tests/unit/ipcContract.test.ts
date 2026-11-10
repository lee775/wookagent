/**
 * 화면 약속 계약 시험 (SERVER_DESIGN 10.2, 리드 결정 S2-10): 컴파일 때(tsc -p tsconfig.node.json)와 실행 때 모두 본다.
 * - IPC_METHODS는 `WookApiMethods`의 키와 정확히 같다 (빠짐·남음·겹침 없음)
 * - IPC_TOPICS는 `WookTopics`의 키와 정확히 같다
 * - OWNER_METHODS(대표 메서드)는 IPC_METHODS 안에 있다
 * 실행 때의 기준 목록(ALL_METHODS·ALL_TOPICS)은 `Record<키, true>` 글자 그대로라, 인터페이스와 어긋나면 이 파일이 컴파일되지 않는다
 */
import { describe, expect, it } from 'vitest';
import { IPC_METHODS, IPC_TOPICS, OWNER_METHODS, type OwnerMethod, type WookApiMethods, type WookMethod, type WookTopic, type WookTopics } from '@shared/ipc';

// ───── 컴파일 때 (어긋나면 'Type false does not satisfy the constraint true') ─────
type Assert<T extends true> = T;
/** 두 타입이 정확히 같은지 (한쪽이 다른 쪽의 일부이기만 해도 false) */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type MethodsMatchContract = Assert<Equals<(typeof IPC_METHODS)[number], keyof WookApiMethods>>;
export type TopicsMatchContract = Assert<Equals<(typeof IPC_TOPICS)[number], keyof WookTopics>>;
export type OwnerMethodsInContract = Assert<[Exclude<OwnerMethod, (typeof IPC_METHODS)[number]>] extends [never] ? true : false>;

// ───── 실행 때의 기준 목록 — 인터페이스 키 전부, 그리고 그것뿐 (빠지거나 남으면 컴파일 오류) ─────
const ALL_METHODS: Record<WookMethod, true> = {
  'auth.getState': true,
  'auth.login': true,
  'auth.devLogin': true,
  'auth.logout': true,
  'auth.deviceLogin': true,
  'auth.deviceLoginPoll': true,
  'auth.setupOwner': true,
  'auth.listDevices': true,
  'auth.revokeDevice': true,
  'snapshot.get': true,
  'projects.create': true,
  'projects.update': true,
  'projects.pause': true,
  'projects.resume': true,
  'projects.setMock': true,
  'members.add': true,
  'members.update': true,
  'members.remove': true,
  'members.replaceProducer': true,
  'members.pause': true,
  'members.resume': true,
  'members.interrupt': true,
  'members.getDetail': true,
  'members.getEvents': true,
  'command.send': true,
  'command.history': true,
  'directives.get': true,
  'directives.cancel': true,
  'tasks.get': true,
  'tasks.getDiff': true,
  'tasks.resume': true,
  'tasks.cancel': true,
  'tasks.interrupt': true,
  'questions.answer': true,
  'reports.list': true,
  'reports.get': true,
  'reports.markRead': true,
  'reports.approve': true,
  'reports.requestChanges': true,
  'notifications.list': true,
  'notifications.markRead': true,
  'stop.emergency': true,
  'stop.release': true,
  'seat.get': true,
  'seat.history': true,
  'seat.handover': true,
  'journal.list': true,
  'screens.recent': true,
  'screens.image': true,
  'recovery.list': true,
  'recovery.resolve': true,
  'settings.get': true,
  'settings.update': true,
  'settings.setGoogleSecret': true,
  'settings.setApiKey': true,
  'roles.list': true,
  'roles.create': true,
  'roles.update': true,
  'roles.delete': true,
  'skills.list': true,
  'skills.setMode': true,
  'skills.setRoleSkills': true,
  'logs.search': true,
  'logs.export': true,
  'system.prereqs': true,
  'system.info': true,
  'system.recheckAi': true,
  'system.pickFiles': true,
  'system.openPath': true,
  'system.backupNow': true,
};
const ALL_TOPICS: Record<WookTopic, true> = { snapshot: true, cliEvents: true, notification: true, navigate: true, emergency: true, openSettings: true };

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('화면 약속 계약 (S2-10)', () => {
  it('IPC_METHODS는 WookApiMethods의 키와 정확히 같다 — 빠짐·남음·겹침이 없다', () => {
    expect(sorted(IPC_METHODS)).toEqual(sorted(Object.keys(ALL_METHODS)));
    expect(new Set(IPC_METHODS).size).toBe(IPC_METHODS.length);
  });

  it('IPC_TOPICS는 WookTopics의 키와 정확히 같다', () => {
    expect(sorted(IPC_TOPICS)).toEqual(sorted(Object.keys(ALL_TOPICS)));
    expect(new Set(IPC_TOPICS).size).toBe(IPC_TOPICS.length);
  });

  it('OWNER_METHODS는 IPC_METHODS 안에 있고 겹치지 않는다', () => {
    const all = new Set<string>(IPC_METHODS);
    expect(OWNER_METHODS.filter((m) => !all.has(m))).toEqual([]);
    expect(new Set(OWNER_METHODS).size).toBe(OWNER_METHODS.length);
  });
});
