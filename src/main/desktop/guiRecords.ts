/**
 * 화면 조작 기록을 쓰는 단 하나의 곳 (gui_actions — SERVER_DESIGN 8.3.5 '기록', 리드 결정 S6-7). 저장 전에 가린다:
 * - 입력 글(text)은 도우미가 포커스를 판정한 칸(암호 칸이 아니라고 본 칸)에 실제로 쳤을 때만 남긴다 (리드 결정 S6-21 C2): 도우미가 받아들인 답(ok), 또는 포커스를
 *   판정한 뒤 일부를 치다 멈춘 중단(sent > 0). 그때도 가리기 규칙이 아무것도 가리지 않을 때(`redact.text(raw) === raw`)만 그대로 두고, 아니면 null과 길이(코드
 *   포인트)만 둔다. 그 밖의 모든 줄은 길이만이다 — 줄을 넣을 때(insert)는 늘 길이만 두고, 답을 받은 뒤 finish의 typedText로만 글을 채운다:
 *   보내기 전의 거부(오래된 캡처·사람 우선·횟수·정지·교체·모양)와 도우미의 거부·실패(잠김, 막는 창·높은 권한 창, 암호 칸·모르는 포커스, 답 없음, 도우미가 끝남)는
 *   그 글이 어느 칸에 갈 것이었는지 아무도 판정하지 않았다 — 잠금 화면·자격 증명 창의 암호 칸에 치려던 비밀번호일 수 있다.
 * - 키 이름·포커스(프로그램·창 제목)·자세히는 가리고 자른다. 이미지 바이트는 없다 — 캡처 ID와 sha256만.
 * - 암호 칸·모르는 포커스라 도우미가 거부한 입력(secret_blocked)은 글도 키 이름도 남기지 않는다(길이만) (리드 결정 S6-8·S6-14 — 6단계 S6c)
 * - 처리기에 닿은 모든 시도마다 한 줄. 활동 기록에는 한 턴을 한 줄로 묶는다(턴 끝 — '화면 조작 23회: 메모장, 브라우저 (캡처 12장, 거부 2회)', 프로그램 이름만,
 *   창 제목은 쓰지 않는다)와 메인 일지 action 한 줄. 비밀 값(secret_blocked)·금지 대상(denied_target) 거부는 그때마다 경고 한 줄을 더 남긴다.
 * - 보관: 활동 기록과 같은 logs.retentionDays (orchestrator.ts의 정리)
 */
import { MAIN_AGENT_ID, type ProjectId } from '@shared/domain';
import type { GuiAction, GuiActionView, GuiResult, ScreenCaptureView } from '@shared/views';
import type { GuiActionInsert, GuiActionRow, GuiCaptureRecord } from '../db/store';
import type { Core } from '../orchestrator/core';

/** 입력 동작 (캡처·서버의 놓기·정지 빼고) */
export const GUI_INPUT_ACTIONS: readonly GuiAction[] = ['move', 'click', 'double_click', 'drag', 'scroll', 'key', 'type', 'release'];
/** 보낸(보냈을 수 있는) 결과 */
const DISPATCHED_RESULTS: ReadonlySet<GuiResult> = new Set<GuiResult>(['sent', 'ok', 'error']);
/** 그때마다 경고 한 줄을 더 남기는 거부 (리드 결정 S6-7) */
const WARN_RESULTS: ReadonlySet<GuiResult> = new Set<GuiResult>(['secret_blocked', 'denied_target']);

const TITLE_MAX = 200;
const DETAIL_MAX = 300;
/** 턴 한 줄에 싣는 프로그램 이름 수 */
const SUMMARY_APPS = 5;

/** 프로그램 이름 → 활동 기록에 쓰는 이름 (창 제목은 쓰지 않는다 — 파일 이름·메일 제목이 들어 있다) */
const APP_LABEL: Readonly<Record<string, string>> = {
  notepad: '메모장',
  chrome: '브라우저',
  msedge: '브라우저',
  firefox: '브라우저',
  whale: '브라우저',
  brave: '브라우저',
  opera: '브라우저',
  iexplore: '브라우저',
  explorer: '파일 탐색기',
  windowsterminal: '터미널',
  cmd: '명령 프롬프트',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  code: 'VS Code',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  mspaint: '그림판',
  calc: '계산기',
  calculatorapp: '계산기',
};

/** 프로그램 이름의 활동 기록 이름 (모르면 프로그램 이름 그대로, 확장자 없이) */
export function guiAppLabel(app: string | null | undefined): string | null {
  const name = (app ?? '').trim().replace(/\.exe$/i, '');
  if (!name) return null;
  return APP_LABEL[name.toLowerCase()] ?? name.slice(0, 60);
}

export const codePoints = (s: string): number => [...s].length;

/** 기록할 한 줄 (가리기 전) — id·seq·holderLabel·updatedAt은 쓰는 곳이 채운다 */
export type GuiRecordInput = Omit<GuiActionInsert, 'holderLabel' | 'updatedAt' | 'text' | 'textLength' | 'focus' | 'keys' | 'detail'> & {
  /** 원래 입력 글 (가리기 전) — 줄을 넣을 때는 길이만 남는다. 글 자체는 도우미가 포커스를 판정한 칸에 쳤을 때만 finish의 typedText로 채운다 (S6-21 C2) */
  rawText?: string | null;
  keys?: string | null;
  focus?: { app: string; title: string; password: boolean | null } | null;
  detail?: string | null;
};

/** 턴 한 줄의 재료 */
export interface GuiTurnSummary {
  /** 보낸 입력 수 */
  inputs: number;
  captures: number;
  refused: number;
  /** 결과마다 거부 수 */
  refusedBy: Partial<Record<GuiResult, number>>;
  apps: string[];
  /** 비밀 값·금지 대상 거부가 있었는지 (경고 줄) */
  warn: boolean;
}

export class GuiRecords {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  get repo() {
    return this.ctx.store.guiActions;
  }

  /** 입력 글을 기록 규칙대로 (가린 것이 없으면 그대로, 있으면 null + 길이) */
  textFields(raw: string | null | undefined): { text: string | null; textLength: number | null } {
    if (typeof raw !== 'string' || raw.length === 0) return { text: null, textLength: null };
    const length = codePoints(raw);
    // 가리기 규칙이 하나라도 가리면 값을 남기지 않는다 — 가리개가 실패해도 다른 글('[가림:가리기 실패]')이 나와 막힌다 (S5-83)
    return this.ctx.redact.text(raw) === raw ? { text: raw, textLength: length } : { text: null, textLength: length };
  }

  /**
   * 한 줄을 남긴다 (저장 전에 가린다). 입력 글은 길이만 남긴다 — 이 줄을 넣는 때(거부, 또는 보낸 직후의 'sent')에는 그 글이 판정된 칸에 쳐졌는지 아직 모른다.
   * 비밀 값·금지 대상 거부면 경고 한 줄을 더 남긴다
   */
  insert(input: GuiRecordInput): GuiActionRow {
    const ctx = this.ctx;
    const { rawText, keys, focus, detail, ...rest } = input;
    const row = this.repo.insert({
      ...rest,
      holderLabel: this.core.journal.holderOf(input.generation),
      text: null,
      textLength: this.textFields(rawText).textLength,
      keys: keys ? clip(ctx.redact.text(keys), 60) : null,
      focus: this.focusOf(focus),
      detail: detail ? clip(ctx.redact.text(detail), DETAIL_MAX) : null,
      capture: input.capture ? this.cleanCapture(input.capture) : null,
      updatedAt: ctx.now(),
    });
    this.warnIfRefused(row);
    return row;
  }

  /**
   * 보낸 입력의 결과 (답을 받은 뒤) — 같은 줄을 고친다. typedText: 도우미가 포커스를 판정한 칸에 친(일부라도) 글 — 부르는 쪽은 받아들인 답과 포커스 판정 뒤의
   * 중단(sent > 0)에만 준다. 주면 규칙대로(가린 것이 없을 때만) 글을 채우고, 주지 않으면 길이만 남은 채다. 결과가 secret_blocked(암호 칸·모르는 포커스)면
   * 주더라도 글과 키 이름을 지운다 — 길이만 남는다. sentChars: secret_blocked인데 글자를 보낸 뒤였다(치는 동안 포커스가 암호 칸·모르는 곳으로 옮겨 감 —
   * S6F2b, 리드 결정 S6-23 K2) — 경고 한 줄이 '치지 않음'이 아니라 보낸 글자 수를 말한다
   */
  finish(
    row: GuiActionRow,
    patch: { result: GuiResult; focus?: GuiRecordInput['focus']; detail?: string | null; afterCaptureId?: string | null; typedText?: string | null; sentChars?: number },
  ): GuiActionRow {
    const ctx = this.ctx;
    const secret = patch.result === 'secret_blocked';
    const next: GuiActionRow = {
      ...row,
      result: patch.result,
      ...(secret ? { text: null, keys: null } : patch.typedText !== undefined ? this.textFields(patch.typedText) : {}),
      ...(patch.focus !== undefined ? { focus: this.focusOf(patch.focus) } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail ? clip(ctx.redact.text(patch.detail), DETAIL_MAX) : null } : {}),
      ...(patch.afterCaptureId !== undefined ? { afterCaptureId: patch.afterCaptureId } : {}),
      updatedAt: ctx.now(),
    };
    this.repo.put(next);
    if (patch.result !== row.result) this.warnIfRefused(next, patch.sentChars);
    return next;
  }

  private focusOf(f: GuiRecordInput['focus']): GuiActionRow['focus'] {
    if (!f) return null;
    const redact = this.ctx.redact;
    return { app: clip(redact.text(f.app ?? ''), 80), title: clip(redact.text(f.title ?? ''), TITLE_MAX), password: f.password ?? null };
  }

  private cleanCapture(c: GuiCaptureRecord): GuiCaptureRecord {
    return { ...c, focusApp: c.focusApp ? clip(this.ctx.redact.text(c.focusApp), 60) : null };
  }

  /** 비밀 값·금지 대상 거부의 경고 한 줄 (값·창 제목 없이). sentChars > 0: 글자를 보낸 뒤 포커스가 암호 칸·모르는 곳으로 옮겨 가 멈춘 type (S6-23 K2) */
  private warnIfRefused(row: GuiActionRow, sentChars?: number): void {
    if (!WARN_RESULTS.has(row.result)) return;
    const moved = row.result === 'secret_blocked' && sentChars !== undefined && sentChars > 0;
    const what = moved
      ? `치는 동안 포커스가 암호 칸이나 알 수 없는 곳으로 옮겨 감 — ${row.textLength ?? sentChars}자 가운데 ${sentChars}자를 보냈고 일부가 그 칸에 들어갔을 수 있음`
      : row.result === 'secret_blocked'
        ? `비밀 값(으로 보이는 글)이나 암호 칸이라 치지 않음${row.textLength ? ` — ${row.textLength}자` : ''}`
        : '금지된 키·창이라 보내지 않음';
    this.ctx.activity({
      kind: 'screen',
      level: 'warn',
      actor: MAIN_AGENT_ID,
      memberId: MAIN_AGENT_ID,
      projectId: row.projectId,
      turnId: row.turnId,
      requestId: row.requestId,
      text: `화면 조작 ${moved ? '멈춤' : '거부'} (${row.action}, ${row.result}): ${what}`,
      result: row.detail,
    });
  }

  // ───── 턴 한 줄 ─────

  turnSummary(turnId: string): GuiTurnSummary {
    const rows = this.repo.query({ turnId, asc: true });
    const s: GuiTurnSummary = { inputs: 0, captures: 0, refused: 0, refusedBy: {}, apps: [], warn: false };
    const seen = new Set<string>();
    const addApp = (app: string | null | undefined): void => {
      const label = guiAppLabel(app);
      if (label && !seen.has(label)) {
        seen.add(label);
        s.apps.push(label);
      }
    };
    for (const r of rows) {
      if (r.by !== 'main') continue;
      if (r.action === 'capture') {
        if (r.result === 'ok') {
          s.captures++;
          addApp(r.capture?.focusApp);
          continue;
        }
      } else if (DISPATCHED_RESULTS.has(r.result)) {
        s.inputs++;
        addApp(r.focus?.app);
        continue;
      }
      if (r.result === 'ok' || DISPATCHED_RESULTS.has(r.result)) continue;
      s.refused++;
      s.refusedBy[r.result] = (s.refusedBy[r.result] ?? 0) + 1;
      if (WARN_RESULTS.has(r.result)) s.warn = true;
    }
    return s;
  }

  /** 턴 한 줄의 글 — '화면 조작 23회: 메모장, 브라우저 (캡처 12장, 거부 2회)' */
  static summaryText(s: GuiTurnSummary): string {
    const apps = s.apps.length ? `: ${s.apps.slice(0, SUMMARY_APPS).join(', ')}${s.apps.length > SUMMARY_APPS ? ` 외 ${s.apps.length - SUMMARY_APPS}곳` : ''}` : '';
    const tail = [`캡처 ${s.captures}장`, ...(s.refused ? [`거부 ${s.refused}회`] : [])].join(', ');
    return `화면 조작 ${s.inputs}회${apps} (${tail})`;
  }

  /**
   * 그 턴의 화면 조작을 활동 기록 한 줄(kind screen)과 메인 일지 action 한 줄로 남긴다 — 그 턴에 기록이 없으면 남기지 않는다. 같은 턴에 두 번 남기지 않는다
   * (턴 끝과 재시작 뒤 맞추기가 모두 부른다). 남겼으면 true
   */
  writeTurnSummary(turnId: string, o: { memberId?: string; sessionId?: string | null; projectId?: ProjectId | null; workKey?: string | null; generation?: number }): boolean {
    const ctx = this.ctx;
    const s = this.turnSummary(turnId);
    if (s.inputs + s.captures + s.refused === 0) return false;
    if (ctx.store.activity.search({ turnId, kinds: ['screen'], limit: 50 }).some((e) => e.text.startsWith('화면 조작 ') && e.level !== 'warn')) return false;
    const text = GuiRecords.summaryText(s);
    ctx.activity({
      kind: 'screen',
      level: 'info',
      actor: o.memberId ?? MAIN_AGENT_ID,
      memberId: o.memberId ?? MAIN_AGENT_ID,
      projectId: o.projectId ?? null,
      sessionId: o.sessionId ?? null,
      turnId,
      text,
    });
    this.core.journal.server('action', text, { projectId: o.projectId ?? null, workKey: o.workKey ?? null, turnId, generation: o.generation });
    return true;
  }

  // ───── 대표 화면 (screens.recent — S6c) ─────

  view(r: GuiActionRow): GuiActionView {
    return {
      id: r.id,
      at: r.at,
      generation: r.generation,
      holderLabel: r.holderLabel,
      turnId: r.turnId,
      projectId: r.projectId as ProjectId | null,
      by: r.by,
      action: r.action,
      x: r.x,
      y: r.y,
      x2: r.x2,
      y2: r.y2,
      button: r.button,
      count: r.count,
      amount: r.amount,
      keys: r.keys,
      text: r.text,
      textLength: r.textLength,
      focus: r.focus,
      result: r.result,
      detail: r.detail,
      beforeCaptureId: r.beforeCaptureId,
      afterCaptureId: r.afterCaptureId,
    };
  }

  /** 캡처 줄 → 화면의 캡처 (kept: 파일이 있고 해시가 맞다 — 부르는 쪽이 본다) */
  captureView(r: GuiActionRow, kept: boolean): ScreenCaptureView | null {
    const c = r.capture;
    if (!c) return null;
    return {
      id: c.id,
      at: r.at,
      generation: r.generation,
      holderLabel: r.holderLabel,
      turnId: r.turnId,
      projectId: r.projectId as ProjectId | null,
      screen: c.screen,
      width: c.width,
      height: c.height,
      scale: c.scale,
      cause: c.cause,
      focus: guiAppLabel(c.focusApp),
      sha256: c.sha256,
      kept,
    };
  }

  /** 보관 기간이 지난 줄을 지운다 — 지운 수 (활동 기록과 같은 기간) */
  purgeOlderThan(iso: string): number {
    return this.repo.purgeOlderThan(iso);
  }
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}
