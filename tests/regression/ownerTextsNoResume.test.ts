/**
 * 대표에게 가는 글은 대표에게 재개하라고 하지 않는다 (리드 결정 32, 10-30 — flows-guarantees 3차 재리뷰 [1], tests-integrity [2]).
 * v0.6에서 대표에게는 재개가 없다(SERVER_DESIGN 2.4 — 작업·팀원 재개는 메인 에이전트의 resume_task·resume_member). 그런데 병합 보류·실패
 * 알림('…정리한 뒤 작업을 재개하세요')과 몇몇 알림·보류 글이 대표에게 재개하라고 했다. 메인 에이전트에게 가는 업무가 없는 보류는 메인이 저절로
 * 이어 간다고 쓰지도 않는다 — 5단계 alertsToMain까지는 대표가 명령창으로 메인 에이전트에게 알린다.
 * - grep 확인: src/main(시험 파일 제외)의 문자열(주석 제외 — TypeScript 해석기로 문자열·템플릿만 모은다)에 '재개하세요', '재개해 주세요',
 *   '작업을 재개'가 없다. 메인 에이전트에게 가는 글(업무 글·도구 결과·안내)은 파일과 까닭을 적어 허용 목록에 둔다
 * - 결정 26의 팀원 일시정지 글('메인 에이전트가 다시 이어 갑니다')은 메인 에이전트가 재개 업무를 받는 그 한 곳에만 있다
 * - 허용 목록의 항목은 모두 아직 쓰인다 (지운 글이 목록에 남지 않게)
 * - 상한·재촉 상한 알림('자동 복구 실패'·'업무 시작 실패'·'헛돌기'·'계획 지연'·'보고서 작성 지연'·'프로듀서 처리 지연')은 본문의 모든 갈래(조건식마다)에
 *   '명령창으로 메인 에이전트에게'가 있다. 버린 대표 요청·보류 넘김 문장을 넣는 갈래는 그 문장을 만드는 함수가 늘 그 길을 적는지 따로 본다 (리드 결정 45) —
 *   그 함수의 모든 return(안쪽 블록의 이른 return 포함)을 본다 (리드 결정 48)
 * 5단계 S5b부터 그 보류·실패는 메인 에이전트에게 알림 업무로 간다(alert, 리드 결정 S5-7). 글의 규칙도 그 사실에 맞춘다 (리드 결정 S5-9):
 * - 메인에게 넘긴 갈래는 '…메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요'
 *   (alerts.ts OWNER_HANDED), 넘기지 못한 갈래는 결정 32의 문장(OWNER_TELL_MAIN) — 해석기가 그 상수와 ownerExit의 두 갈래를 그대로 펼쳐 본다
 * - 대표 알림은 '처리 중'이라고 하지 않는다 — 넘긴 일이 상한에서 버려지면 거짓이 되므로 지금 상태는 화면의 reachesMain이 말한다
 * - '작업 관리자'는 데스크톱 갈래(서버 모드를 묻는 조건식의 거짓 갈래)에만 있다 — 서버의 대표는 서버 PC를 볼 수 없다 (리드 결정 S4-20·S5-9)
 * - 보류 사유 글은 사실만 — 출구 문장('명령창으로 …', '…넘겼습니다')을 담지 않는다
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SRC_MAIN = join(ROOT, 'src', 'main');

/** 대표에게 재개하라고 하는 말 */
const RESUME_PATTERNS = ['재개하세요', '재개해 주세요', '작업을 재개'];
/** 메인 에이전트가 저절로 이어 간다는 말 — 메인 에이전트가 업무를 받는 곳에만 (리드 결정 26·32) */
const CONTINUES_PATTERN = '메인 에이전트가 다시 이어 갑니다';

interface Allowed {
  file: string;
  /** 그 파일의 문자열에 들어 있는 글 조각 */
  snippet: string;
  /** 대표에게 가는 글이 아닌 까닭 */
  reason: string;
}

/** 메인 에이전트(또는 팀원)에게 가는 글 — 재개는 메인 에이전트의 도구다 */
const ALLOWED_RESUME: Allowed[] = [
  { file: 'src/main/orchestrator/turns.ts', snippet: '")로 재개하세요. 직접 확인할 길이 없으면 ask_owner로', reason: '메인 에이전트의 팀원 재개 업무 글 (handPauseToMain, 리드 결정 26)' },
  { file: 'src/main/orchestrator/turns.ts', snippet: '남은 프로세스가 사라졌는지 확인한 뒤 resume_member로 재개하세요', reason: '메인 에이전트에게 다시 넣는 팀원 재개 업무의 머리말 (리드 결정 26)' },
  { file: 'src/main/orchestrator/tasks.ts', snippet: '")로 재개하세요 — 재개하면 검수 등록부터 다시 합니다', reason: "메인 에이전트의 '검수자 없음' 업무 글 (no_reviewer)" },
  { file: 'src/main/orchestrator/stops.ts', snippet: 'resume_task(task_id, reason)로 재개하세요', reason: "메인 에이전트의 '정지 해제' 업무 글 (stop_released)" },
  { file: 'src/main/orchestrator/tools.ts', snippet: '이어 가도 되는 것만 resume_task로 재개하세요', reason: "메인 에이전트 턴 메시지의 업무 종류 안내 ('정지 해제')" },
  { file: 'src/main/orchestrator/tools.ts', snippet: 'assign_reviewer를 지시한 뒤 resume_task로 재개하세요', reason: "메인 에이전트 턴 메시지의 업무 종류 안내 ('검수자 없음')" },
  { file: 'src/main/orchestrator/urgent.ts', snippet: '정지가 해제된 뒤 재개하세요', reason: 'instruct_member 결과의 안내 — 메인 에이전트에게 돌려준다' },
];

const ALLOWED_CONTINUES: Allowed[] = [
  { file: 'src/main/orchestrator/turns.ts', snippet: '메인 에이전트가 다시 이어 갑니다. 직접 정리했거나 서둘러야 하면', reason: "unconfirmedNote 'member_pause' — 팀원 일시정지는 메인 에이전트가 재개 업무를 받는다 (리드 결정 26)" },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

interface Literal {
  file: string;
  line: number;
  text: string;
}

/** 파일의 문자열·템플릿 글 (주석은 빼고, 템플릿의 ${…} 자리는 '…'로 잇는다) */
function literals(path: string): Literal[] {
  const source = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const file = relative(ROOT, path).split(sep).join('/');
  const out: Literal[] = [];
  const add = (node: ts.Node, text: string): void => {
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('…'));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const ALL = sourceFiles(SRC_MAIN).flatMap(literals);

/** 대표 알림 하나 — ctx.notify({ title: '…', body: … })의 제목과 본문 글 (본문 템플릿의 ${…}는 '…', 조건식은 '(참|거짓)'으로 두 갈래를 다 적는다) */
interface Notice {
  file: string;
  line: number;
  title: string;
  body: string;
}

function exprText(e: ts.Expression): string {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => exprText(s.expression) + s.literal.text).join('');
  if (ts.isConditionalExpression(e)) return `(${exprText(e.whenTrue)}|${exprText(e.whenFalse)})`;
  if (ts.isParenthesizedExpression(e)) return exprText(e.expression);
  return '…';
}

function noticesIn(rel: string): Notice[] {
  const path = join(ROOT, rel);
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Notice[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'notify' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      const prop = (name: string) =>
        node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])
          ? node.arguments[0].properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name)
          : undefined;
      const title = prop('title');
      const body = prop('body');
      if (title && body && ts.isStringLiteral(title.initializer)) {
        out.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, title: title.initializer.text, body: exprText(body.initializer) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 결정 32의 문장 — 메인 에이전트에게 넘기지 못한 보류·실패의 대표 알림 끝에 둔다 (alerts.ts OWNER_TELL_MAIN) */
const TELL_MAIN = '명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';
/** 메인 에이전트에게 알림 업무를 넣은 갈래의 끝 문장 (alerts.ts OWNER_HANDED, 리드 결정 S5-9) */
const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
/** 출구를 담는 함수(버린 대표 요청·보류 넘김 문장)의 값을 넣은 갈래 — 그 함수의 return은 아래 시험이 따로 본다 */
const CARRIED = /«[A-Za-z]+: 명령창으로 메인 에이전트에게»/;

/** merges.ts의 '…실패'·'…보류' 알림 가운데 결정 32의 문장이 필요 없는 것 — 처리할 수 있는 쪽의 업무가 있거나 막힌 일이 없다 */
const MERGE_NOTICE_EXEMPT: { title: string; reason: string }[] = [
  { title: '되돌리기 보류', reason: '프로듀서에게 [replan] 업무가 간다 (holdRevert) — 처리할 수 있는 쪽의 업무가 있다' },
  { title: '원격 올리기 실패', reason: '병합은 끝났고 보류한 작업이 없다 — 원격 저장소 쪽 정보 알림' },
];

/** 리드 결정 40: 출구를 말하지 않던 대표 알림 (S1F8 알아 둘 것 2) — 파일과 제목. 작업의 '자동 복구 실패'는 같은 제목의 다른 알림이 있어 noticeExits가 본다 */
const NO_EXIT_BEFORE: { file: string; title: string; count: number }[] = [
  { file: 'src/main/orchestrator/turns.ts', title: '업무 시작 실패', count: 1 },
  { file: 'src/main/orchestrator/turns.ts', title: '병합 충돌 해결 실패', count: 1 },
  { file: 'src/main/orchestrator/recovery.ts', title: '복구 확인 필요', count: 2 },
  { file: 'src/main/orchestrator/tasks.ts', title: '작업 공간 생성 실패', count: 1 },
  { file: 'src/main/orchestrator/tasks.ts', title: '검수 제출 처리 실패', count: 1 },
  { file: 'src/main/orchestrator/tasks.ts', title: '작업 취소 실패', count: 1 },
  { file: 'src/main/orchestrator/merges.ts', title: '작업 공간 생성 실패', count: 1 },
];

function check(patterns: string[], allowed: Allowed[]): { offending: string[]; unused: Allowed[] } {
  const hits = ALL.filter((l) => patterns.some((p) => l.text.includes(p)));
  const used = new Set<Allowed>();
  const offending: string[] = [];
  for (const h of hits) {
    const a = allowed.find((x) => x.file === h.file && h.text.includes(x.snippet));
    if (a) used.add(a);
    else offending.push(`${h.file}:${h.line}: ${h.text.slice(0, 160)}`);
  }
  return { offending, unused: allowed.filter((a) => !used.has(a)) };
}

describe('대표에게 가는 글은 재개하라고 하지 않는다 (리드 결정 32)', () => {
  it('src/main의 문자열을 모았다 (해석기가 글을 찾는지 먼저 본다)', () => {
    expect(ALL.length).toBeGreaterThan(1000);
    expect(ALL.some((l) => l.file === 'src/main/orchestrator/merges.ts' && l.text.includes('폴더에 커밋되지 않은 변경이 있어'))).toBe(true);
  });

  it("'재개하세요'·'재개해 주세요'·'작업을 재개'는 메인 에이전트에게 가는 글에만 있다", () => {
    const { offending, unused } = check(RESUME_PATTERNS, ALLOWED_RESUME);
    expect(offending).toEqual([]);
    expect(unused.map((a) => `${a.file}: ${a.snippet}`)).toEqual([]);
  });

  it("'메인 에이전트가 다시 이어 갑니다'는 메인 에이전트가 업무를 받는 팀원 일시정지 글에만 있다", () => {
    const { offending, unused } = check([CONTINUES_PATTERN], ALLOWED_CONTINUES);
    expect(offending).toEqual([]);
    expect(unused.map((a) => `${a.file}: ${a.snippet}`)).toEqual([]);
  });
});

describe('메인 업무가 없는 보류·실패의 대표 알림은 명령창으로 메인 에이전트에게 알리는 길을 적는다 (리드 결정 32·40)', () => {
  it("merges.ts의 '…실패'·'…보류' 알림은 모든 갈래에 명령창 길을 담는다 — 메인에게 넘겼으면 넘긴 사실과 서두를 때의 길, 아니면 결정 32의 문장. 메인이 저절로 이어 간다고만 하거나 대표에게 재개를 시키지 않는다 (tests-integrity 변이 N4-merge-fail-self·N4-artifact-keep-self·N4-merge-fail-resume-words, 리드 결정 S5-9)", () => {
    const merges = branchNotices().filter((n) => n.file === 'src/main/orchestrator/merges.ts');
    // 해석기가 알림을 찾는지 먼저 본다
    expect(merges.map((n) => n.titles[0])).toEqual(expect.arrayContaining(['병합 실패', '병합 보류', '산출물 보관 실패', '산출물 확정 실패', '되돌리기 실패', '작업 공간 생성 실패']));
    const held = merges.filter((n) => n.titles.some((t) => /(실패|보류)$/.test(t)) && !MERGE_NOTICE_EXEMPT.some((x) => n.titles.includes(x.title)));
    expect(held.flatMap((n) => n.bodies.filter((b) => !b.includes('명령창으로 메인 에이전트에게 알려 주세요')).map((b) => `${n.file}:${n.line} ${n.titles[0]}: ${b}`))).toEqual([]);
    expect(held.flatMap((n) => n.bodies.filter((b) => RESUME_PATTERNS.some((p) => b.includes(p)) || /재개하면/.test(b)).map(() => `${n.file}:${n.line} ${n.titles[0]}`))).toEqual([]);
    // 넘긴 갈래와 넘기지 못한 갈래가 둘 다 있다 — 넘긴 사실은 보류를 넘긴 뒤에만 쓴다(alertsToMain이 실제로 본다)
    for (const title of ['병합 실패', '병합 보류', '산출물 보관 실패', '산출물 확정 실패', '되돌리기 실패', '작업 공간 생성 실패']) {
      const bodies = held.filter((n) => n.titles.includes(title)).flatMap((n) => n.bodies);
      expect(bodies.some((b) => b.includes(HANDED)), `${title} 넘긴 갈래`).toBe(true);
      expect(bodies.some((b) => b.includes(TELL_MAIN)), `${title} 넘기지 못한 갈래`).toBe(true);
    }
    // 예외 목록의 제목은 아직 쓰인다
    expect(MERGE_NOTICE_EXEMPT.filter((x) => !merges.some((n) => n.titles.includes(x.title))).map((x) => x.title)).toEqual([]);
  });

  it('출구를 말하지 않던 알림(업무 시작 실패·병합 충돌 해결 실패·복구 확인 필요·작업 공간 생성 실패·검수 제출 처리 실패·작업 취소 실패)은 모든 갈래가 출구로 끝난다 — 메인에게 넘겼으면 넘긴 사실(OWNER_HANDED), 아니면 결정 32의 문장 (리드 결정 40·S5-9)', () => {
    const all = branchNotices();
    for (const { file, title, count } of NO_EXIT_BEFORE) {
      const found = all.filter((n) => n.file === file && n.titles.includes(title));
      expect(found.length, `${file} ${title}`).toBe(count);
      for (const n of found) {
        for (const b of n.bodies) expect(b.includes(HANDED) || b.includes(TELL_MAIN) || CARRIED.test(b), `${file}:${n.line} ${title}: ${b}`).toBe(true);
        // 넘긴 갈래가 있다 — 이 보류·실패는 메인 에이전트에게 알림 업무로 간다 (리드 결정 S5-7)
        expect(n.bodies.some((b) => b.includes(HANDED)), `${file}:${n.line} ${title} 넘긴 갈래`).toBe(true);
      }
    }
  });

  it("'대표 판단이 필요합니다'는 대표에게 가는 글에 없다 — 대표는 메인 에이전트에게 명령만 한다", () => {
    expect(ALL.filter((l) => l.text.includes('대표 판단이 필요')).map((l) => `${l.file}:${l.line}`)).toEqual([]);
  });
});

// ───────────────────────── 리드 결정 45: 상한·재촉 상한 알림은 모든 갈래에서 출구를 적는다 ─────────────────────────

/** 출구 — 대표가 명령창으로 메인 에이전트에게 알리는 길 (결정 32의 문장과 '…다시 말해 주세요'·'…서둘러야 하면 …알려 주세요'의 공통 부분) */
const EXIT_PHRASE = '명령창으로 메인 에이전트에게';

/**
 * 리드 결정 45: 이 제목의 대표 알림은 본문의 모든 갈래에 출구가 있어야 한다 — 비정상 종료·재시작 상한('자동 복구 실패'), 시작 실패 상한, 헛돌기, 재촉 상한
 * (계획·보고서 작성·프로듀서). 버린 일은 다시 가지 않으므로 대표가 명령창으로 메인 에이전트에게 알리는 길이 그 일의 출구다. 값은 그 제목의 알림 수 — 해석기가
 * 알림을 다 찾는지 본다(새 알림이 생기면 그 알림도 이 확인을 받으므로 수만 고치면 된다)
 */
const EXIT_TITLES: Record<string, number> = { '자동 복구 실패': 3, '업무 시작 실패': 1, 헛돌기: 1, '계획 지연': 1, '보고서 작성 지연': 1, '프로듀서 처리 지연': 2 };

/**
 * 비어 있지 않으면 늘 출구를 담는 글을 돌려주는 함수 (turns.ts) — 버린 대표 요청 문장(ownerRequestsText), 버린 보류 넘김 문장(heldHandOversText), 그 둘을 잇는
 * lostText. 본문이 `lost ? `. ${lost}` : '…'`처럼 이 함수의 값이 있을 때만 그 값을 넣으면 그 갈래는 출구를 담는다. 아래 시험이 함수마다 그런지 해석기로 본다
 */
const EXIT_CARRIERS = ['ownerRequestsText', 'heldHandOversText', 'lostText'] as const;

interface BranchNotice {
  file: string;
  line: number;
  titles: string[];
  bodies: string[];
}

/** 갈래 글을 모을 때 이름이 가리키는 값 — 출구를 담는 함수(EXIT_CARRIERS)의 값인 지역 변수가 참인 갈래에서는 그 값을 출구 표시로 둔다 */
type Known = Map<string, string>;

/** 조건식 갈래의 조건이 그 이름 하나인지 (`lost ? … : …`) */
function guardName(e: ts.Expression): string | null {
  const x = ts.isParenthesizedExpression(e) ? e.expression : e;
  return ts.isIdentifier(x) ? x.text : null;
}

/** 이 자리에서 보이는 지역 변수 선언 (감싼 블록을 거슬러 올라가며 그 블록에 바로 든 const 선언만) */
function declarationOf(at: ts.Node, name: string): ts.VariableDeclaration | null {
  for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
    if (!ts.isBlock(n) && !ts.isSourceFile(n)) continue;
    for (const s of n.statements) {
      if (!ts.isVariableStatement(s)) continue;
      const d = s.declarationList.declarations.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
      if (d) return d;
    }
  }
  return null;
}

/** 그 이름이 출구를 담는 함수의 값인 지역 변수면 그 함수 이름 */
function carrierOf(at: ts.Node, name: string): string | null {
  const init = declarationOf(at, name)?.initializer;
  return init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && (EXIT_CARRIERS as readonly string[]).includes(init.expression.text) ? init.expression.text : null;
}

/** 파일 맨 위의 글 상수 (`const X = '…'`, export 포함) — 알림 본문이 상수로 쓰는 출구 문장을 해석기가 펼쳐 본다 (리드 결정 S5-9) */
function fileConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s) || !(s.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isStringLiteral(d.initializer) || ts.isNoSubstitutionTemplateLiteral(d.initializer))) out.set(d.name.text, d.initializer.text);
    }
  }
  return out;
}

/** 메인에게 넘긴 사실·결정 32의 문장 (alerts.ts OWNER_HANDED·OWNER_TELL_MAIN) — 어느 파일에서 가져다 써도 그 글로 본다 */
let alertsSf: ts.SourceFile | null = null;
const ALERTS = (): ts.SourceFile => (alertsSf ??= parse('src/main/orchestrator/alerts.ts'));
let alertConsts: Map<string, string> | null = null;
const ALERT_CONSTS = (): Map<string, string> => (alertConsts ??= fileConsts(ALERTS()));
/** 늘 출구를 담는 글을 돌려주는 함수 (alerts.ts) — 부른 자리에서 그 함수의 모든 return 갈래로 펼친다. 아래 시험이 그 return이 모두 출구를 담는지 본다 */
const CALL_CARRIERS = ['ownerExit'] as const;

/** 식이 낼 수 있는 글을 갈래마다 (조건식은 갈래를 나누고, 템플릿은 갈래를 곱한다. 모르는 값은 '…') */
function branchTexts(e: ts.Expression, known: Known = new Map()): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isParenthesizedExpression(e)) return branchTexts(e.expression, known);
  if (ts.isIdentifier(e)) return [known.get(e.text) ?? ALERT_CONSTS().get(e.text) ?? '…'];
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && (CALL_CARRIERS as readonly string[]).includes(e.expression.text)) {
    return returnsOf(ALERTS(), e.expression.text).flatMap((r) => branchTexts(r));
  }
  if (ts.isConditionalExpression(e)) {
    const name = guardName(e.condition);
    const carrier = name ? carrierOf(e, name) : null;
    const whenTrue = carrier ? new Map(known).set(name!, `«${carrier}: ${EXIT_PHRASE}»`) : known;
    const whenFalse = carrier ? new Map(known).set(name!, '') : known;
    return [...branchTexts(e.whenTrue, whenTrue), ...branchTexts(e.whenFalse, whenFalse)];
  }
  if (ts.isTemplateExpression(e)) {
    let acc = [e.head.text];
    for (const span of e.templateSpans) {
      const parts = branchTexts(span.expression, known);
      acc = acc.flatMap((a) => parts.map((p) => a + p + span.literal.text));
    }
    return acc;
  }
  return ['…'];
}

function parse(rel: string): ts.SourceFile {
  const path = join(ROOT, rel);
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** src/main의 ctx.notify({ title, body }) — 제목·본문을 갈래마다 (제목이 조건식이면 갈래 제목 모두) */
function branchNotices(): BranchNotice[] {
  const out: BranchNotice[] = [];
  for (const path of sourceFiles(SRC_MAIN)) {
    const file = relative(ROOT, path).split(sep).join('/');
    const sf = parse(file);
    const consts = fileConsts(sf);
    const visit = (node: ts.Node): void => {
      const arg = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'notify' ? node.arguments[0] : undefined;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const prop = (name: string) => arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
        const title = prop('title');
        const body = prop('body');
        if (title && body) out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, titles: branchTexts(title.initializer), bodies: branchTexts(body.initializer, new Map(consts)) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * turns.ts 함수의 return 식 모두 — 맨 위 return뿐 아니라 if 등 안쪽 블록의 이른 return까지 (그 함수 안에서 정의한 함수의 return은 빼다). 첫 return만 보면
 * 안쪽 블록의 이른 return이 출구 없는 글을 돌려줘도 시험이 몰랐다 (리드 결정 48, tests-integrity 변이 N6-carrier-early-return). 식이 없는 return은 '…'로 둔다
 */
function returnsOf(sf: ts.SourceFile, name: string): ts.Expression[] {
  const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!fn?.body) throw new Error(`${name} 함수를 찾지 못함`);
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) out.push(node.expression ?? ts.factory.createIdentifier('undefined'));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  if (!out.length) throw new Error(`${name}의 return 식을 찾지 못함`);
  return out;
}

describe('상한·재촉 상한의 대표 알림은 본문의 모든 갈래에서 명령창 길을 적는다 (리드 결정 45)', () => {
  it('출구를 담는 함수(ownerRequestsText·heldHandOversText·lostText)는 비어 있지 않으면 늘 그 길을 적는다 — 모든 return에서 (이른 return 포함, 리드 결정 48)', () => {
    const sf = parse('src/main/orchestrator/turns.ts');
    for (const name of ['ownerRequestsText', 'heldHandOversText']) {
      for (const e of returnsOf(sf, name)) {
        // `items.length ? '…명령창으로 메인 에이전트에게…' : ''` — 참 갈래는 모두 그 길을 담고, 거짓 갈래는 빈 글뿐이다
        expect(ts.isConditionalExpression(e), `${name}: ${e.pos >= 0 ? e.getText(sf) : 'return;'}`).toBe(true);
        const c = e as ts.ConditionalExpression;
        expect(branchTexts(c.whenTrue).filter((b) => !b.includes(EXIT_PHRASE)), name).toEqual([]);
        expect(branchTexts(c.whenFalse), name).toEqual(['']);
      }
    }
    // lostText는 그 둘의 값만 잇는다: [ownerRequestsText(…), heldHandOversText(…)].filter(Boolean).join(…)
    for (const lost of returnsOf(sf, 'lostText')) {
      const join = ts.isCallExpression(lost) && ts.isPropertyAccessExpression(lost.expression) && lost.expression.name.text === 'join' ? lost.expression.expression : null;
      const filter = join && ts.isCallExpression(join) && ts.isPropertyAccessExpression(join.expression) && join.expression.name.text === 'filter' ? join : null;
      const arr = filter && ts.isPropertyAccessExpression(filter.expression) ? filter.expression.expression : null;
      expect(!!arr && ts.isArrayLiteralExpression(arr)).toBe(true);
      expect(filter!.arguments.map((a) => a.getText(sf))).toEqual(['Boolean']);
      const called = (arr as ts.ArrayLiteralExpression).elements.map((x) => (ts.isCallExpression(x) && ts.isIdentifier(x.expression) ? x.expression.text : x.getText(sf)));
      expect(called).toEqual(['ownerRequestsText', 'heldHandOversText']);
    }
  });

  it("'자동 복구 실패'·'업무 시작 실패'·'헛돌기'·'계획 지연'·'보고서 작성 지연'·'프로듀서 처리 지연' 알림은 모든 갈래에 '명령창으로 메인 에이전트에게'가 있다 (프로브 zz-s1fix5-os-nx-no-exit-notices)", () => {
    const all = branchNotices();
    // 해석기가 알림을 찾는지 먼저 본다 — 제목마다 알림 수
    const found: Record<string, number> = {};
    for (const n of all) for (const t of new Set(n.titles)) if (t in EXIT_TITLES) found[t] = (found[t] ?? 0) + 1;
    expect(found).toEqual(EXIT_TITLES);
    const missing = all
      .filter((n) => n.titles.some((t) => t in EXIT_TITLES))
      .flatMap((n) => n.bodies.filter((b) => !b.includes(EXIT_PHRASE)).map((b) => `${n.file}:${n.line} ${n.titles.join('|')}: ${b}`));
    expect(missing).toEqual([]);
  });

  it("되돌리기는 프로듀서 도구라 대표에게 '되돌리기를 요청하세요'라고 하지 않는다 — 명령창으로 메인 에이전트에게 말하게 한다", () => {
    const merges = branchNotices().filter((n) => n.file === 'src/main/orchestrator/merges.ts' && n.bodies.some((b) => b.includes('되돌리기')) && !n.titles.some((t) => t.startsWith('되돌리기')));
    expect(merges.map((n) => n.titles[0])).toEqual(['병합 기록 확인 필요']);
    for (const n of merges) for (const b of n.bodies) expect(b).toContain('필요하면 명령창으로 메인 에이전트에게 되돌리기를 말해 주세요');
    expect(branchNotices().flatMap((n) => n.bodies.filter((b) => b.includes('되돌리기를 요청하세요')).map((b) => `${n.file}:${n.line} ${b}`))).toEqual([]);
  });
});

// ───────────────────────── 리드 결정 S5-9: 메인에게 넘긴 뒤의 대표 글 ─────────────────────────

/**
 * 메인 에이전트에게 알림 업무로 넘기는 보류·실패의 대표 알림 (alertsToMain 목록, 리드 결정 S5-7·S5-8) — 파일·제목·알림 수. 모든 갈래가 출구(넘긴 사실 OWNER_HANDED
 * 또는 결정 32의 문장)로 끝나고, 넘긴 갈래가 하나는 있다. '자동 복구 실패'·'업무 시작 실패'·'계획 지연'·'프로듀서 처리 지연'은 EXIT_TITLES가 함께 본다
 */
const HANDED_TITLES: { file: string; title: string; count: number }[] = [
  { file: 'src/main/orchestrator/merges.ts', title: '병합 실패', count: 1 },
  { file: 'src/main/orchestrator/merges.ts', title: '병합 보류', count: 1 },
  { file: 'src/main/orchestrator/merges.ts', title: '산출물 보관 실패', count: 1 },
  { file: 'src/main/orchestrator/merges.ts', title: '산출물 확정 실패', count: 1 },
  { file: 'src/main/orchestrator/merges.ts', title: '되돌리기 실패', count: 1 },
  { file: 'src/main/orchestrator/merges.ts', title: '작업 공간 생성 실패', count: 1 },
  { file: 'src/main/orchestrator/tasks.ts', title: '작업 공간 생성 실패', count: 1 },
  { file: 'src/main/orchestrator/tasks.ts', title: '검수 제출 처리 실패', count: 1 },
  { file: 'src/main/orchestrator/tasks.ts', title: '작업 취소 실패', count: 1 },
  { file: 'src/main/orchestrator/tasks.ts', title: '다시 판정 실패', count: 1 },
  { file: 'src/main/orchestrator/recovery.ts', title: '복구 확인 필요', count: 2 },
  { file: 'src/main/orchestrator/turns.ts', title: '병합 충돌 해결 실패', count: 1 },
  { file: 'src/main/orchestrator/turns.ts', title: '업무 시작 실패', count: 1 },
  { file: 'src/main/orchestrator/turns.ts', title: '자동 복구 실패', count: 3 },
  { file: 'src/main/orchestrator/turns.ts', title: '프로듀서 처리 지연', count: 2 },
  { file: 'src/main/orchestrator/directives.ts', title: '계획 지연', count: 1 },
  { file: 'src/main/orchestrator/records.ts', title: '긴급 지시 전달 못 함', count: 1 },
];

/** 그 노드가 서버 모드를 묻는 조건식(`… 'server' ? 서버 : 데스크톱`, `server ? …`)의 거짓(데스크톱) 갈래 안에 있는지 */
function inDesktopBranch(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isConditionalExpression(p) && p.whenFalse === n && /server/.test(p.condition.getText(sf))) return true;
  }
  return false;
}

describe('메인에게 넘긴 보류·실패의 대표 글은 사실대로 (리드 결정 S5-9)', () => {
  it('ownerExit(넘긴 갈래·넘기지 못한 갈래)는 모든 return에서 명령창 길을 적고, 두 갈래가 OWNER_HANDED와 결정 32의 문장이다', () => {
    expect(ALERT_CONSTS().get('OWNER_HANDED')).toBe(HANDED);
    expect(ALERT_CONSTS().get('OWNER_TELL_MAIN')).toBe(TELL_MAIN);
    const texts = returnsOf(ALERTS(), 'ownerExit').flatMap((r) => branchTexts(r));
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts.filter((t) => !t.includes(EXIT_PHRASE))).toEqual([]);
    expect(texts.some((t) => t === HANDED)).toBe(true);
    expect(texts.some((t) => t.endsWith(TELL_MAIN))).toBe(true);
  });

  it('메인에게 넘기는 보류·실패의 알림은 모든 갈래가 출구로 끝나고 넘긴 갈래가 있다 — 넘긴 갈래는 OWNER_HANDED 그대로다 (프로브 적응: alertsToMain 목록)', () => {
    const all = branchNotices();
    for (const { file, title, count } of HANDED_TITLES) {
      const found = all.filter((n) => n.file === file && n.titles.includes(title));
      expect(found.length, `${file} ${title}`).toBe(count);
      const bodies = found.flatMap((n) => n.bodies);
      expect(bodies.filter((b) => !b.includes(HANDED) && !b.includes(TELL_MAIN) && !b.includes(EXIT_PHRASE)).map((b) => `${file} ${title}: ${b}`)).toEqual([]);
      expect(bodies.some((b) => b.includes(HANDED)), `${file} ${title} 넘긴 갈래`).toBe(true);
      // '넘겼습니다'는 OWNER_HANDED로만 — 서두를 때의 길(명령창)이 떨어지지 않는다
      expect(bodies.filter((b) => b.includes('메인 에이전트에게 넘겼습니다') && !b.includes(HANDED)).map((b) => `${file} ${title}: ${b}`)).toEqual([]);
    }
  });

  it("대표 알림은 '처리 중'이라고 하지 않는다 — 넘긴 일이 상한에서 버려지면 거짓이 되므로 지금 상태는 화면의 reachesMain이 말한다 (변이 s5b-owner-processing)", () => {
    const all = branchNotices();
    expect(all.length).toBeGreaterThan(50);
    expect(all.flatMap((n) => n.bodies.filter((b) => b.includes('처리 중')).map((b) => `${n.file}:${n.line} ${n.titles[0]}: ${b}`))).toEqual([]);
  });

  it("'병합 기록 확인 필요'는 모든 갈래에 대표의 출구가 있다 — 다음 시작·보류 해제가 마무리하고, 서두를 때는 명령창 (리드 결정 S5-8)", () => {
    const found = branchNotices().filter((n) => n.file === 'src/main/orchestrator/merges.ts' && n.titles.includes('병합 기록 확인 필요'));
    expect(found.length).toBe(3);
    expect(found.flatMap((n) => n.bodies.filter((b) => !b.includes(EXIT_PHRASE)).map((b) => `${n.line}: ${b}`))).toEqual([]);
  });

  it("'작업 관리자'는 데스크톱 갈래에만 있다 — 서버의 대표는 서버 PC를 볼 수 없어 운영자에게 부탁한다 (리드 결정 S4-20·S5-9, 변이 s5b-server-taskmgr)", () => {
    const offending: string[] = [];
    let seen = 0;
    for (const path of sourceFiles(SRC_MAIN)) {
      const file = relative(ROOT, path).split(sep).join('/');
      const sf = parse(file);
      const visit = (node: ts.Node): void => {
        const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((x) => x.literal.text)].join('…') : null;
        if (text?.includes('작업 관리자')) {
          seen++;
          if (!inDesktopBranch(node, sf)) offending.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${text.slice(0, 120)}`);
        }
        if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
        else for (const span of node.templateSpans) visit(span.expression);
      };
      visit(sf);
    }
    // 해석기가 그 글을 찾는지 먼저 본다 (종료 확인 실패·메인 일시정지·실행 환경 문제·메인에게 가는 확인 부탁)
    expect(seen).toBeGreaterThanOrEqual(4);
    expect(offending).toEqual([]);
  });

  it('보류 사유 글은 사실만 담는다 — 출구 문장(명령창으로…, …넘겼습니다)은 대표 알림에만 (리드 결정 S5-9)', () => {
    const offending: string[] = [];
    for (const path of sourceFiles(SRC_MAIN)) {
      const file = relative(ROOT, path).split(sep).join('/');
      const sf = parse(file);
      const visit = (node: ts.Node): void => {
        // tasks.hold(taskId, kind, scope, note, …) — 넷째 인자가 보류 사유 글
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'hold' && node.arguments.length >= 4) {
          for (const b of branchTexts(node.arguments[3]!)) if (b.includes('명령창으로') || b.includes('넘겼습니다')) offending.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${b}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offending).toEqual([]);
    // 종료를 확인하지 못한 실행의 보류 사유 글(unconfirmedFacts)도 사실만
    const facts = returnsOf(parse('src/main/orchestrator/turns.ts'), 'unconfirmedFacts').flatMap((r) => branchTexts(r));
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts.filter((t) => t.includes('명령창으로') || t.includes('넘겼습니다') || t.includes('정지 해제'))).toEqual([]);
  });
});
