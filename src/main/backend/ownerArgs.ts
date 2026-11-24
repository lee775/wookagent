/**
 * 대표 길의 인자 모양 (리드 결정 S3-13·S2-22, SERVER_DESIGN 3.4·10.3): 대표 게이트(ownerGate.ts)가 처리기를 부르기 전에 본다 — 데스크톱 IPC와 서버
 * HTTP가 같은 규칙이다. 모양이 틀리면 BackendError('invalid_args')(HTTP 400)이고 처리기를 부르지 않는다. 예전에는 배열인지만 봐서 옵션 객체를 빠뜨린
 * 호출(members.getEvents에 팀원 ID만 등)이 처리기 안에서 터져 500 internal과 스택 있는 ERROR 줄이 됐다(리뷰 프로브 zz-lc2-parity)
 * - 대표 메서드(OWNER_METHODS)와 데스크톱 운영자 메서드(DESKTOP_OPERATOR_METHODS)마다 하나씩 — 빠지면 컴파일이 막는다(OWNER_ARG_SHAPES의 satisfies)
 * - 인자 수: 앞의 꼭 있어야 하는 인자는 다 있어야 하고, 뒤의 선택 인자는 빠지거나 null이어도 된다(JSON으로 오면 undefined가 null이 된다). 그 뒤에 남는
 *   인자는 보지 않는다 — 처리기가 쓰지 않는다(예전 그대로, 원격의 auth.login처럼 인자와 상관없이 거부하는 처리기의 답을 바꾸지 않게)
 * - 객체 인자: 칸의 형식만 본다. 모르는 칸은 거부하지 않는다 — 화면이 붙여 보내는 칸(첨부의 id·size 등)은 처리기가 쓰지 않는다. 선택 칸은 null도 받는다
 *   (처리기가 없음으로 다룬다)
 * - ID는 비지 않은 글이면 모양이 맞다 — 그런 대상이 없는지는 처리기와 게이트가 본다(not_found, HTTP 404). 길이는 HTTP 본문 상한(1MB)이 막는다
 * - 거부 글에는 넘긴 값을 되풀이하지 않는다 — 몇 번째 인자의 어느 칸인지만 말한다
 */
import { z } from 'zod';
import { AI_KINDS, MOCK_SCENARIOS, type AiKind } from '@shared/domain';
import type { DESKTOP_OPERATOR_METHODS, OwnerMethod } from '@shared/ipc';

type DesktopOperatorMethod = (typeof DESKTOP_OPERATOR_METHODS)[number];

/** 인자 배열 → 맞으면 null, 틀리면 사람이 읽는 까닭 (값은 넣지 않는다) */
export type ArgShape = (args: readonly unknown[]) => string | null;

const id = z.string().min(1);
const text = z.string();
/** 선택 칸 — 없음·null 모두 받는다 */
const opt = <T extends z.ZodType>(t: T) => t.nullish();
const plain = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
/** AI 종류 ('claude' | 'codex') */
const aiKind = z.custom<AiKind>((v) => (AI_KINDS as readonly unknown[]).includes(v));

/** zod 경로 → '칸 이름' 글 (배열 자리는 [n]) */
function pathText(path: readonly PropertyKey[]): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${String(p)}`)).join('');
}

/** 인자 모양: required는 꼭 있어야 하는 인자, optional은 그 뒤의 선택 인자 */
function shape(required: readonly z.ZodType[], optional: readonly z.ZodType[] = []): ArgShape {
  const all = [...required, ...optional];
  return (args) => {
    if (args.length < required.length) return `인자가 ${required.length}개 있어야 하는데 ${args.length}개입니다`;
    for (let i = 0; i < Math.min(args.length, all.length); i++) {
      const v = args[i];
      if (i >= required.length && (v === undefined || v === null)) continue;
      const r = all[i]!.safeParse(v);
      if (!r.success) {
        const where = pathText(r.error.issues[0]?.path ?? []);
        return `${i + 1}번째 인자${where ? `의 ${where}` : ''} 모양이 맞지 않습니다`;
      }
    }
    return null;
  };
}

const none = shape([]);

/** 활동 기록 검색·내보내기 조건 (LogFilter) */
const logFilter = plain({
  text: opt(text),
  projectId: opt(text),
  memberId: opt(text),
  taskId: opt(text),
  kinds: opt(z.array(text)),
  level: opt(z.enum(['info', 'warn', 'error'])),
  from: opt(text),
  to: opt(text),
  limit: opt(z.number()),
  beforeSeq: opt(z.number()),
});

/** 메인 자리 세대 (seat.handover) — 1 이상의 정수 (리드 결정 S4-13) */
const generation = z.number().int().positive();

/** 메인 일지 쪽 조건 (JournalFilter, S4-7) — 칸은 타입 그대로, 쪽 크기는 1~200, 다음 쪽 표시는 200자까지 */
const journalFilter = plain({
  projectId: opt(id),
  kinds: opt(z.array(z.enum(['command', 'action', 'report', 'seat', 'stop', 'decision', 'promise', 'note', 'rollup']))),
  author: opt(z.enum(['server', 'agent'])),
  generation: opt(generation),
  openPromisesOnly: opt(z.boolean()),
  cursor: opt(z.string().max(200)),
  limit: opt(z.number().int().min(1).max(200)),
});

/** AI 설정 (AiConfig) — 종류·모델(null이면 CLI 기본)·노력치 단계·직접 지정한 노력치 */
const aiConfig = plain({ kind: aiKind, model: opt(text), effortTier: z.enum(['high', 'normal', 'low']), effortOverride: opt(text) });

/**
 * settings.update의 둘째 인자 (리드 결정 S4-25) — 화면이 불러 둔 메인 AI(expected.mainAgent). 이 칸 하나만 받는다: 다른 칸이 있으면 거부한다
 * (처리기는 이 값과 저장된 값이 다르면 아무것도 저장하지 않는다)
 */
const settingsExpected = z.object({ mainAgent: opt(aiConfig) }).strict();

/** 명령 첨부 하나 — 서버 PC의 파일 경로(데스크톱 화면이 고른 파일), 붙여 넣은 그림(dataUrl), 서버에 올린 파일(uploadId, 원격 — S3-10) */
const attachment = plain({ name: text, path: opt(text), dataUrl: opt(text), uploadId: opt(id) });

/**
 * 팀원 AI 변경 건의 (리드 결정 S10-37) — 칸의 형식만 본다. 모델이 목록에 있는지, 노력치 단계가 있는 단계인지는 처리기(aiSuggestion.ts)가 까닭을 적어
 * 거부한다 — 여기서 막으면 '모양이 맞지 않습니다'만 남는다
 */
const aiSuggestion = plain({ memberId: id, model: opt(text), effortTier: opt(text) });

/**
 * 메서드별 인자 모양. 게이트는 여기 있는 메서드만 부른다 — 대표 메서드 44개와 데스크톱 운영자 메서드 5개 (리드 결정 S3-13·S4-13·S6-2·S7-2)
 */
export const OWNER_ARG_SHAPES = {
  'auth.getState': none,
  'auth.login': none,
  'auth.logout': none,
  'auth.deviceLogin': shape([], [text]),
  'auth.deviceLoginPoll': shape([id]),
  'auth.setupOwner': shape([text, text]),
  'auth.listDevices': none,
  'auth.revokeDevice': shape([id]),
  'snapshot.get': none,
  'members.getDetail': shape([id]),
  'members.getEvents': shape([id, plain({ turnId: opt(text), cursor: opt(text), limit: opt(z.number()) })]),
  'command.send': shape([plain({ target: id, text, attachments: opt(z.array(attachment)), aiSuggestion: opt(aiSuggestion) })]),
  'command.history': shape([id, plain({ before: opt(text), limit: opt(z.number()) })]),
  'directives.get': shape([id]),
  'tasks.get': shape([id]),
  'tasks.getDiff': shape([id]),
  'questions.answer': shape([id, text]),
  'reports.list': shape([plain({ text: opt(text), projectId: opt(text), status: opt(z.enum(['new', 'read', 'approved', 'changes_requested'])), from: opt(text), to: opt(text) })]),
  'reports.get': shape([id]),
  'reports.markRead': shape([id]),
  'reports.approve': shape([id, text]),
  'reports.requestChanges': shape([id, plain({ overall: text, anchored: z.array(plain({ quote: text, comment: text })) })]),
  'notifications.list': shape([plain({ limit: opt(z.number()) })]),
  'notifications.markRead': shape([id]),
  'stop.emergency': none,
  'stop.release': none,
  // 메인 자리·일지 보기 (S4-7) — 세대를 주지 않으면 지금 세대, 조건을 주지 않으면 전체 첫 쪽
  'seat.get': none,
  'seat.history': none,
  'seat.handover': shape([], [generation]),
  'journal.list': shape([], [journalFilter]),
  // 화면 조작 보기 (S6-2) — 동작 쪽 크기 1~500(기본 100), before는 앞 쪽의 마지막 동작 ID. 이미지는 캡처 ID 하나
  'screens.recent': shape([], [plain({ limit: opt(z.number().int().min(1).max(500)), before: opt(z.string().max(40)) })]),
  'screens.image': shape([id]),
  // 외부 에이전트 보기 (S7-2) — 인자 없음
  'agents.list': none,
  'recovery.list': none,
  'settings.get': none,
  'roles.list': none,
  'skills.list': none,
  'logs.search': shape([logFilter]),
  'logs.export': shape([logFilter]),
  'system.prereqs': none,
  'system.info': none,
  'system.recheckAi': shape([aiKind]),
  'system.pickFiles': none,
  'system.openPath': shape([text]),
  // 데스크톱 운영자 메서드 — 값까지 보는 판정(모의 실행은 끄기만, settings.update는 운영자 항목만)은 게이트의 ownerRefusal이 먼저 한다
  'auth.devLogin': none,
  'settings.setGoogleSecret': shape([text]),
  // 키가 null이면 지운다 (화면의 '삭제')
  'settings.setApiKey': shape([aiKind, text.nullable()]),
  // 둘째 인자는 고를 수 있다 — 메인 AI 칸을 보내는 화면이 그 화면이 불러 둔 메인 AI를 함께 보낸다 (S4-25)
  'settings.update': shape([z.record(z.string(), z.unknown())], [settingsExpected]),
  'projects.setMock': shape([id, plain({ enabled: z.boolean(), speed: opt(z.number()), defaultScenario: opt(z.enum(MOCK_SCENARIOS)) })]),
} satisfies Record<OwnerMethod | DesktopOperatorMethod, ArgShape>;

/** 그 메서드의 인자가 맞지 않는 까닭 (맞거나 모양을 정하지 않은 메서드면 null) */
export function ownerArgProblem(method: string, args: readonly unknown[]): string | null {
  const check = Object.hasOwn(OWNER_ARG_SHAPES, method) ? (OWNER_ARG_SHAPES as Record<string, ArgShape>)[method]! : null;
  return check ? check(args) : null;
}
