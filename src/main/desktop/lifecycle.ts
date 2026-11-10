/**
 * 화면 도우미의 정지와 놓기 (SERVER_DESIGN 8.3.5 '정지', 리드 결정 S6-9·S6-21). 순서는 늘 같다: STOP을 먼저 쓰고(도우미가 눌린 키·버튼을 떼고 답한다 — 0.8초까지),
 * 그다음 끝내고, 끝남을 확인한다(STOP을 쓴 때부터 2.8초 — desktopHelper.ts stop). 끝내기부터 하면 주입한 키가 눌린 채 남는다.
 *
 * - 긴급 정지 (stops.ts): stop('긴급 정지')를 턴·서버 명령 종료와 나란히 띄우고 기다린다. 답이 없었거나 끝남을 확인하지 못했으면 실패 줄(메인 에이전트,
 *   '화면 도우미: 키·버튼을 뗐는지 확인하지 못했습니다' / '…끝났는지 확인하지 못했습니다')이고 요약은 완료가 아니다. 정지 값은 DB에만 있다 — 여기 따로 잠금이 없다.
 * - 자리 교체 (seat.ts): 1번(교체를 정한 때)과 4번(토큰 폐기)에서 stopForSwap. 1번의 결과는 교체가 본다 — 끝남을 확인하지 못했으면 교체가 멈춘다(A2b).
 *   교체 중에는 화면 도구가 conflict로 거부된다(service.ts).
 * - 턴 끝 (turns.ts finish, hostExec.settleTurn 뒤): 도우미가 무장해 있으면 RELEASE(도는 입력을 멈추고 키를 떼고 표시·훅을 끈다 — 도우미는
 *   남는다). 답을 1초, 도는 명령의 답을 1초 기다린다. 답이 없으면 STOP하고 끝낸다. 그 뒤 그 턴의 화면 조작을 활동 기록·일지 한 줄로 남긴다.
 * - 정지는 한 번에 하나다 (A3b): 도는 정지가 있으면 뒤에 온 정지(두 번째 긴급 정지, 한 틱 안의 두 번째 교체 정지, 그사이 끝나는 턴)는 같은 결과를 받는다 —
 *   앞 정지가 아직 확인하는 중인데 뒤 정지가 '완료'라고 하지 않는다.
 * - 끝남을 확인하지 못한 정지는 문이 된다 (A1 — kv desktop:unconfirmed {since, cause, turnId}): 어느 정지든(위의 정지, 클라이언트가 명령 시간 초과·긴 줄·쉼으로
 *   스스로 한 정지 — desktopHelper.ts의 'stopped' 알림) 끝남을 확인하지 못하면 건다. 걸려 있는 동안 screen_capture·screen_info·gui_input은 stopped로 거부되고
 *   (service.ts), 클라이언트는 새 도우미를 띄우지 않는다 — 앞 도우미가 살아 있을 수 있다. 그때 도는 메인 턴이 있으면 그 턴에 접고(turns.noteUnconfirmed —
 *   kill_failed로 끝나 메인 에이전트가 일시정지된다), 없으면 메인 에이전트를 곧바로 일시정지한다. 그 뒤에 시작한 턴에는 접지 않는다.
 * - 문을 여는 길은 둘뿐이다 (A2): ① 대표의 정지 해제(stop.release — 메인 에이전트의 일시정지를 푸는 길)가 그 도우미를 한 번 더 끝내 확인한다(3초 안).
 *   확인되면 지우고, 안 되면 그대로 둔다 — 대표의 정지 해제 자체는 된다(메인은 화면 없이 일한다). 자리 화면·사전 점검·거부 글이 까닭과 출구(서버 다시 시작)를
 *   말한다. ② 서버 시작: 앞 실행의 도우미는 서버의 작업 개체와 함께 끝났다 — reconcile이 지운다. 자리 교체·새 턴은 지우지 않는다.
 * - 놓았다는 답을 받지 못한 무장 표시(kv desktop:armed) 위에 무장하지 않는다 (A4): 표시가 남아 있으면(도우미가 무장한 채 죽었거나, 놓기·STOP에 답 없이 끝났다)
 *   다음 무장 앞에서 새 도우미에 RELEASE를 먼저 보내 답을 받는다(releaseOverMark) — 받으면 표시를 지우고 활동 기록에 남기고, 못 받으면 그 호출은 unavailable이다.
 *   답하지 않는 새 도우미는 다시 띄우기 상한에 센다(S6-23 M2). 떠 있는 도우미가 없을 때의 gui_input release도 같은 길로 놓는다(S6-23 M1). 다시 시작 뒤의 한 번
 *   놓기(reconcile)도 같은 길이다 — 못 놓았으면 표시가 남아 다음 무장이 다시 놓는다.
 * - 앱 종료 (orchestrator.stop): 턴·서버 명령 종료와 나란히 stop('앱 종료'), 그 뒤 dispose.
 * - 다시 시작 (reconcile): 답을 받지 못한 채 끊긴 입력 줄('sent')을 '서버 재시작으로 끊김'으로 닫고, 턴 한 줄이 빠진 턴에 남긴다.
 * 서버가 한 놓기·정지는 gui_actions에 by 'server' 줄로 남는다 (떠 있는 도우미가 있었을 때만).
 */
import { MAIN_AGENT_ID, type ProjectId } from '@shared/domain';
import type { GuiAction, GuiResult } from '@shared/views';
import type { Core } from '../orchestrator/core';
import { STOP_UNCONFIRMED_EXIT } from './desktopHelper';
import type { GuiRecords } from './guiRecords';
import type { ScreenSafety } from './safety';
import type { DesktopHelperClient, DesktopHelperEvent, ReleaseResult, StopResult } from './types';

/** 정지의 까닭 (기록에 남는 글) */
export type ScreenStopReason = '긴급 정지' | '메인 자리 교체' | '앱 종료' | '턴 끝 — 놓기(RELEASE)에 답하지 않음' | '놓기(RELEASE)에 답하지 않음';

export interface ScreenStopOutcome {
  /** 끝남을 확인했고 눌린 키·버튼이 남지 않았다 (떠 있는 도우미가 없었으면 true) */
  ok: boolean;
  hadProcess: boolean;
  /** 눌린 키·버튼을 뗐다는 답을 받았는지 */
  acked: boolean;
  /** 끝남을 확인했는지 */
  exited: boolean;
  /** 사실 글 — 실패면 '화면 도우미: …' */
  detail: string;
  durationMs: number;
}

/** 끝남을 확인하지 못한 화면 도우미가 있다는 표시 (kv, 리드 결정 S6-21 A1) */
export const SCREEN_UNCONFIRMED_KEY = 'desktop:unconfirmed';

export interface ScreenUnconfirmed {
  /** 걸린 때 */
  since: string;
  /** 그 정지의 까닭 (긴급 정지·메인 자리 교체·명령 시간 초과 등) */
  cause: string;
  /** 그때 돌던 메인 턴 (그 턴에 접었다) — 없었으면 null (메인 에이전트를 곧바로 일시정지했다) */
  turnId: string | null;
  /** 대표의 정지 해제 때 한 번 더 확인했지만 끝나지 않은 때 */
  retriedAt?: string | null;
}

/** 키를 뗐는지 확인하지 못했을 때의 안내 — 서버 PC 앞에서만 할 수 있는 일이다 */
export const HELD_KEYS_HINT = '서버 PC에서 수정 키(Shift·Ctrl·Alt·Win)나 마우스 버튼이 눌린 채면 서버 PC 앞의 사람이 그 키·버튼을 한 번씩 눌렀다 떼야 합니다';
export const RESTART_CUT_DETAIL = '서버 재시작으로 끊김 — 보냈는지 확인하지 못했습니다';
/** 끝남을 확인하지 못한 동안 화면 도구의 거부 글 (stopped — 리드 결정 S6-21 A1) */
export const UNCONFIRMED_REFUSAL =
  '화면 도우미가 끝났는지 확인하지 못했습니다 — 대표가 메인 에이전트를 다시 시작하면 한 번 더 확인합니다. 그래도 안 되면 서버를 다시 시작하세요';
/** 대표의 정지 해제 때 한 번 더 확인했지만 그대로일 때의 거부 글 (A2) */
export const UNCONFIRMED_RETRIED_REFUSAL =
  '화면 도우미가 끝났는지 확인하지 못했습니다 — 대표가 메인 에이전트를 다시 시작할 때 한 번 더 확인했지만 끝나지 않았습니다. 서버를 다시 시작해야 화면 조작을 다시 쓸 수 있습니다. 그동안 화면 없이 할 수 있는 길(host_exec·네 셸)로 하고, 화면이 꼭 필요하면 ask_owner로 대표에게 알리세요';
/** 끝남을 확인하지 못했을 때 대표에게 하는 안내 */
export const UNCONFIRMED_EXIT_HINT =
  "그 화면 도우미가 아직 살아 있을 수 있어 메인 에이전트의 화면 조작을 막았습니다. '정지 해제'를 누르면 끝났는지 한 번 더 확인합니다 — 그래도 끝나지 않으면 서버 PC 운영자에게 서버를 다시 시작해 달라고 부탁하세요";
/**
 * 놓았다는 답을 받지 못한 표시 위에서 새 도우미도 놓기에 답하지 않았을 때의 거부 글 (unavailable — A4). 캡처·입력의 무장 앞과 gui_input release가 같은 글을
 * 쓴다 (리드 결정 S6-23 M1) — 그래서 '놓지 못했다'가 아니라 '놓았다는 답을 받지 못했다'고 한다 (release는 RELEASE를 보냈다)
 */
export const UNRELEASED_REFUSAL =
  '앞선 화면 조작이 눌린 키·버튼을 놓았는지 확인하지 못했고, 새 화면 도우미로도 놓았다는 답을 받지 못했습니다 — 키·버튼이 눌린 채일 수 있어 캡처·입력을 하지 않습니다. 잠시 뒤 다시 하세요. 되풀이되면 ask_owner로 대표에게 알리세요 (서버 PC 운영자가 서버를 다시 시작해야 할 수 있습니다)';
/** 그 실패를 대표의 자리 화면·사전 점검·알림과 메인 알림 업무에 남길 사실 글 (noteProblem — 리드 결정 S6-23 M2) */
export const UNRELEASED_PROBLEM = '앞선 화면 조작이 눌린 키·버튼을 놓았는지 확인하지 못했고, 새 화면 도우미로도 놓았다는 답을 받지 못했습니다';
/** 떠 있는 도우미도, 놓았다는 답을 받지 못한 표시도 없을 때의 gui_input release (리드 결정 S6-23 M1) */
export const NO_HELPER_RELEASE_TEXT = '화면 도우미가 떠 있지 않습니다 — 화면 도우미가 누른 키는 없습니다';

const NONE: ScreenStopOutcome = { ok: true, hadProcess: false, acked: false, exited: true, detail: '화면 도우미가 떠 있지 않습니다', durationMs: 0 };

/** 표시 위의 놓기 — released: 새 도우미가 뗀 키·버튼 수 (표시가 없어 할 일이 없었으면 null) */
export type MarkRelease = { ok: true; released: number | null } | { ok: false; reason: string };

export interface ScreenLifecycleHost {
  /** 이미 만든 도우미 클라이언트 (만들지 않는다) */
  peek(): DesktopHelperClient | null;
  /** 도우미 클라이언트 (없으면 만든다 — 의존성이 없으면 null) */
  client(): DesktopHelperClient | null;
  hasHelper(): boolean;
  /** 지금 화면 조작을 멈춰 둔 때인지 — 긴급 정지·메인 일시정지·자리 교체·앱 종료·끝남을 확인하지 못한 도우미 (service.haltedNow) */
  haltedNow(): boolean;
  records: GuiRecords;
  safety: ScreenSafety;
}

export class ScreenLifecycle {
  /** 도는 정지 하나 — 뒤에 온 정지와 턴 끝이 이 결과를 받는다. 뒤 호출이 덮어쓰지 않는다 (리드 결정 S6-21 A3b) */
  private inFlight: Promise<ScreenStopOutcome> | null = null;
  /** 끝남을 확인하지 못한 화면 도우미 (kv와 같다) */
  private gate: ScreenUnconfirmed | null = null;
  /** 대표의 정지 해제가 시작한 다시 확인 (도는 동안 화면 도구가 기다린다) */
  private rechecking: Promise<boolean> | null = null;
  /** 놓았다는 답을 받지 못한 표시 위의 놓기 (한 번에 하나) */
  private releasing: Promise<MarkRelease> | null = null;
  /** 다시 시작 뒤의 놓기 (시험이 기다린다) */
  restartRelease: Promise<void> | null = null;

  constructor(
    private readonly core: Core,
    private readonly host: ScreenLifecycleHost,
  ) {
    const saved = core.ctx.store.kv.get<ScreenUnconfirmed>(SCREEN_UNCONFIRMED_KEY);
    if (saved && typeof saved.since === 'string' && typeof saved.cause === 'string') this.gate = saved;
  }

  private get ctx() {
    return this.core.ctx;
  }

  /** 서버가 한 놓기·정지 한 줄 */
  private serverRow(action: Extract<GuiAction, 'release' | 'stop'>, turnId: string | null, result: GuiResult, detail: string): void {
    try {
      const turn = turnId ? this.ctx.store.turns.get(turnId) : null;
      this.host.records.insert({
        at: this.ctx.now(),
        generation: this.core.seat.launchGeneration(),
        turnId,
        projectId: (turn?.workProjectId ?? null) as ProjectId | null,
        by: 'server',
        action,
        requestId: null,
        dispatched: false,
        x: null,
        y: null,
        x2: null,
        y2: null,
        button: null,
        count: null,
        amount: null,
        beforeCaptureId: null,
        afterCaptureId: null,
        capture: null,
        result,
        detail,
      });
    } catch (e) {
      this.ctx.log('warn', '화면 도우미 정지 기록을 남기지 못했습니다', e);
    }
  }

  // ───────────────────────── 끝남을 확인하지 못한 도우미 (A1·A2) ─────────────────────────

  /** 끝남을 확인하지 못한 화면 도우미가 있는지 (kv desktop:unconfirmed) */
  unconfirmed(): ScreenUnconfirmed | null {
    return this.gate;
  }

  /** 그동안 화면 도구의 거부 글 (stopped) — 없으면 null */
  gateRefusal(): string | null {
    const g = this.gate;
    return g ? (g.retriedAt ? UNCONFIRMED_RETRIED_REFUSAL : UNCONFIRMED_REFUSAL) : null;
  }

  /** 대표에게 보일 글 (자리 화면·사전 점검) — 까닭과 출구 */
  ownerView(): { text: string; sinceMs: number } | null {
    const g = this.gate;
    if (!g) return null;
    const head = `화면 도우미가 끝났는지 확인하지 못해 메인 에이전트의 화면 조작을 막아 두었습니다 (${g.cause})`;
    const text = g.retriedAt
      ? `${head} — '정지 해제' 때 한 번 더 확인했지만 끝나지 않았습니다. 메인 에이전트는 화면 없이 일합니다. 화면 조작을 다시 쓰려면 서버 PC 운영자에게 서버를 다시 시작해 달라고 부탁하세요`
      : `${head} — '정지 해제'를 누르면 한 번 더 확인합니다. 그래도 끝나지 않으면 서버 PC 운영자에게 서버를 다시 시작해 달라고 부탁하세요`;
    const sinceMs = Date.parse(g.since);
    return { text, sinceMs: Number.isFinite(sinceMs) ? sinceMs : this.ctx.clock.ms() };
  }

  /** 교체가 볼 사실 글 — 끝남을 확인하지 못한 화면 도우미가 있으면 (seat.ts A2b) */
  swapHold(): string | null {
    const g = this.gate;
    return g ? `${STOP_UNCONFIRMED_EXIT} (${g.cause})` : null;
  }

  /** 도는 다시 확인이 있으면 끝날 때까지 (화면 도구가 정지 해제 직후의 거부를 피한다) */
  async rechecked(): Promise<void> {
    if (this.rechecking) await this.rechecking.catch(() => false);
  }

  /**
   * 어느 정지든 끝남을 확인하지 못했다 — 문을 건다. 이미 걸려 있으면 처음 걸린 때·까닭을 지킨다. 그때 도는 메인 턴이 있으면 그 턴에 접고, 없으면(또는 그 턴이
   * 메인 에이전트를 일시정지하지 않는 검수 턴이면) 메인 에이전트를 곧바로 일시정지한다. 앱 종료 중에는 표시만 남긴다 — 다음 시작이 지운다
   */
  private setGate(cause: string): void {
    if (this.gate) return;
    const ctx = this.ctx;
    const quitting = this.core.stopping;
    const turnId = quitting ? null : (this.core.turns.liveOf(MAIN_AGENT_ID)?.turnId ?? null);
    this.gate = { since: ctx.now(), cause, turnId };
    ctx.store.kv.set(SCREEN_UNCONFIRMED_KEY, this.gate);
    ctx.bus.changed();
    if (quitting) return;
    let pausesAtTurnEnd = false;
    if (turnId) {
      // 그 턴은 kill_failed로 끝난다 — 메인 대화 턴이면 그때 메인 에이전트가 일시정지된다 (turns.blockUnconfirmedRun). 메인 검수 턴은 작업 보류로 가므로 따로 건다
      const kind = ctx.store.turns.get(turnId)?.sessionKind;
      pausesAtTurnEnd = this.core.turns.noteUnconfirmed(turnId, -1, STOP_UNCONFIRMED_EXIT) && kind !== 'task' && kind !== 'review';
    }
    if (!pausesAtTurnEnd) this.pauseMainNow(cause);
  }

  /** 도는 메인 턴이 없다 — 메인 에이전트를 곧바로 일시정지하고 대표에게 알린다 (출구는 대표의 정지 해제) */
  private pauseMainNow(cause: string): void {
    const ctx = this.ctx;
    const why = `화면 도우미가 끝났는지 확인하지 못함 (${cause})`;
    if (!ctx.stop().members[MAIN_AGENT_ID]?.paused) {
      this.core.stops.pauseMember(MAIN_AGENT_ID, 'graceful', 'system', why).catch((e) => ctx.log('error', '화면 도우미: 메인 에이전트 일시정지를 걸지 못했습니다', e));
    }
    ctx.notify({
      level: 'urgent',
      title: '화면 도우미 종료 확인 실패',
      body: `화면 도우미가 끝났는지 확인하지 못했습니다 (${cause}). 그 화면 도우미가 아직 살아 있을 수 있어 메인 에이전트의 화면 조작을 막고 메인 에이전트를 일시정지했습니다. '정지 해제'를 누르면 끝났는지 한 번 더 확인하고 메인 에이전트를 다시 시작합니다 — 그때도 끝나지 않았으면 메인 에이전트는 화면 없이 일하고, 화면 조작은 서버 PC 운영자가 서버를 다시 시작해야 다시 쓸 수 있습니다`,
      link: { tab: 'seat', panel: 'screen' },
      key: 'screen-unconfirmed',
    });
  }

  private clearGate(why: string, tail = ''): void {
    if (!this.gate) return;
    const ctx = this.ctx;
    this.gate = null;
    ctx.store.kv.set(SCREEN_UNCONFIRMED_KEY, null);
    ctx.activity({ kind: 'screen', level: 'info', memberId: MAIN_AGENT_ID, text: `화면 도우미가 끝난 것을 확인함 — ${why}. 메인 에이전트가 화면 조작을 다시 쓸 수 있음${tail}` });
    // 그 일의 알림은 더는 참이 아니다 — 읽지 않았으면 읽음으로 둔다
    const now = ctx.now();
    for (const n of ctx.store.notifications.list({ ref1: 'screen-unconfirmed', state: 'unread' })) ctx.store.notifications.put({ ...n, readAt: now });
    ctx.bus.changed();
  }

  /**
   * 대표의 정지 해제 (StopService.release — 메인 에이전트의 일시정지를 푸는 길, 리드 결정 S6-21 A2): 끝남을 확인하지 못한 화면 도우미를 한 번 더 끝내 확인한다
   * (3초 안). 확인되면 표시를 지운다 — 눌린 채 남았을 수 있는 키는 다음 무장 앞의 놓기(A4)가 맡는다. 안 되면 그대로 둔다. 기다리지 않아도 된다 (정지 해제는 된다)
   */
  ownerReleased(): Promise<boolean> {
    if (!this.gate) return Promise.resolve(true);
    if (this.rechecking) return this.rechecking;
    const ctx = this.ctx;
    const p = (async (): Promise<boolean> => {
      let ok: boolean;
      try {
        // 이 프로세스가 띄운 도우미가 없으면(클라이언트가 없다) 남은 도우미도 없다
        ok = (await this.host.peek()?.confirmExit()) ?? true;
      } catch (e) {
        ctx.log('error', '화면 도우미가 끝났는지 다시 확인하지 못했습니다', e);
        ok = false;
      }
      if (!this.gate) return true;
      if (ok) {
        this.clearGate('대표의 정지 해제 때 한 번 더 확인함');
        return true;
      }
      this.gate = { ...this.gate, retriedAt: ctx.now() };
      ctx.store.kv.set(SCREEN_UNCONFIRMED_KEY, this.gate);
      ctx.activity({
        kind: 'screen',
        level: 'error',
        memberId: MAIN_AGENT_ID,
        text: `정지 해제 때 화면 도우미가 끝났는지 한 번 더 확인했지만 끝나지 않음 (${this.gate.cause}) — 메인 에이전트는 화면 없이 일하고, 화면 조작은 서버를 다시 시작해야 다시 씀`,
      });
      ctx.bus.changed();
      return false;
    })().finally(() => {
      if (this.rechecking === p) this.rechecking = null;
    });
    this.rechecking = p;
    return p;
  }

  // ───────────────────────── 도우미가 알려 주는 것 ─────────────────────────

  /** 도우미 알림 — 정지 한 번이 끝났다 ('stopped'). 다른 알림은 안전장치가 본다 */
  onHelperEvent(e: DesktopHelperEvent): void {
    if (e.type !== 'stopped' || !e.result.hadProcess) return;
    const r = e.result;
    // 끝남을 확인하지 못했다 — 어느 정지든 문을 건다. 이 알림은 그 정지를 기다리던 쪽이 이어 가기 전에 온다 (그사이 새 도우미·새 호출이 끼어들지 않는다)
    if (!r.exited) this.setGate(e.reason);
    // 부른 정지(긴급 정지·교체·턴 끝·앱 종료)는 부른 쪽(stop)이 기록한다. 아래는 클라이언트가 스스로 한 정지 — 그 결과를 버리지 않는다 (리드 결정 S6-21 A3)
    if (e.own === null) return;
    this.afterStop(r);
    // 쉬다 끝낸 도우미는 무장하지 않은 도우미다(놓았다는 답·멈춤 단축키 뒤) — 뗄 키가 없어 STOP OK가 없어도 알릴 것이 없다. 끝남을 확인하지 못했으면 위의 문만
    // 건다 (리드 결정 S6-21 A3)
    if (e.own === 'idle') return;
    const turnId = this.core.stopping ? null : (this.core.turns.liveOf(MAIN_AGENT_ID)?.turnId ?? null);
    this.serverRow('stop', turnId, r.ok ? 'ok' : 'error', `${e.reason}: ${r.detail}`);
    this.ctx.activity({
      kind: 'screen',
      level: r.ok ? 'warn' : 'error',
      memberId: MAIN_AGENT_ID,
      turnId,
      text: r.ok ? `서버가 화면 도우미를 멈춤 — ${e.reason} (${r.detail.replace(/^화면 도우미를 멈췄습니다 \(|\)$/g, '')})` : `서버가 화면 도우미를 멈췄지만(${e.reason}) ${this.failureText(r)}`,
    });
  }

  /** 실패한 정지의 사실과 할 일 */
  private failureText(r: StopResult): string {
    return `${r.detail.replace(/^화면 도우미: /, '')} — ${r.exited ? HELD_KEYS_HINT : UNCONFIRMED_EXIT_HINT}`;
  }

  /**
   * 정지의 결과를 안전장치에 알린다: 조작 중 표시를 끄고, 뗐다는 답을 받았으면 놓기 표시를 지우고, 그 키 올림은 내 입력으로 둔다 (F3). fromWall: STOP을 쓰기 전의
   * 벽시계 — 모르면(클라이언트가 스스로 한 정지) 걸린 시간으로 거슬러 센다
   */
  private afterStop(r: StopResult, fromWall?: number): void {
    const { safety } = this.host;
    safety.disarmed(r.acked);
    if (r.acked && (r.released ?? 0) > 0) {
      const now = Date.now();
      // 도는 정지에 합류했으면 STOP은 fromWall보다 앞에 썼다 — 둘 가운데 이른 쪽부터
      safety.ownKeyUps(Math.min(fromWall ?? Number.POSITIVE_INFINITY, now - r.durationMs), now);
    }
  }

  // ───────────────────────── 정지 ─────────────────────────

  /**
   * STOP을 쓰고 끝내고 끝남을 확인한다 (2.8초 안). 떠 있는 도우미가 없으면 아무것도 하지 않는다. 도는 정지가 있으면 그 결과를 준다 — 새로 하지 않는다.
   * 긴급 정지의 실패는 부르는 쪽(stops.ts)이 요약의 실패 줄로 쓴다 — 그 밖의 정지는 여기서 활동 기록에 남긴다
   */
  stop(reason: ScreenStopReason, o: { turnId?: string | null } = {}): Promise<ScreenStopOutcome> {
    if (this.inFlight) return this.inFlight;
    const h = this.host.peek();
    if (!h) return Promise.resolve(NONE);
    const p = this.runStop(h, reason, o.turnId ?? null).finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async runStop(h: DesktopHelperClient, reason: ScreenStopReason, turnId: string | null): Promise<ScreenStopOutcome> {
    let r: StopResult;
    const fromWall = Date.now();
    try {
      r = await h.stop(reason);
    } catch (e) {
      this.ctx.log('error', '화면 도우미 정지 오류', e);
      r = { ok: false, acked: false, exited: false, released: null, hadProcess: true, detail: STOP_UNCONFIRMED_EXIT, durationMs: 0 };
      this.setGate(reason);
    }
    if (!r.hadProcess) {
      // 떠 있던 도우미가 없다 — 표시는 꺼졌고, 놓았다는 답은 없다 (앞서 뜻밖에 끝났다면 그 표시는 남는다)
      this.host.safety.disarmed(false);
      return NONE;
    }
    // 끝남을 확인하지 못했으면 'stopped' 알림이 이미 문을 걸었다 (onHelperEvent)
    this.afterStop(r, fromWall);
    this.serverRow('stop', turnId, r.ok ? 'ok' : 'error', `${reason}: ${r.detail}`);
    if (!r.ok && reason !== '긴급 정지') {
      this.ctx.activity({ kind: 'screen', level: 'error', memberId: MAIN_AGENT_ID, turnId: null, text: `서버가 화면 도우미를 멈췄지만(${reason}) ${this.failureText(r)}` });
    }
    return { ok: r.ok, hadProcess: true, acked: r.acked, exited: r.exited, detail: r.detail, durationMs: r.durationMs };
  }

  /**
   * 자리 교체의 STOP (1번·4번). 멈출 도우미 프로세스가 없으면 null — 기다릴 것이 없다. 있으면 그 결과의 약속 (던지지 않는다): 1번의 결과는 교체가 본다 —
   * 끝남을 확인하지 못했으면 새 보유자를 앉히지 않는다 (seat.ts, 리드 결정 S6-21 A2b)
   */
  stopForSwap(): Promise<ScreenStopOutcome> | null {
    const h = this.host.peek();
    if (!h) return null;
    if (!this.inFlight && !h.hasProcess()) return null;
    return this.stop('메인 자리 교체').catch((e: unknown) => {
      this.ctx.log('error', '자리 교체의 화면 도우미 정지 오류', e);
      this.setGate('메인 자리 교체');
      return { ok: false, hadProcess: true, acked: false, exited: false, detail: STOP_UNCONFIRMED_EXIT, durationMs: 0 };
    });
  }

  /** 도는 정지 (없으면 null) — 교체가 4~8번 앞에서 기다린다 */
  pendingStop(): Promise<unknown> | null {
    return this.inFlight ?? this.host.peek()?.stopping() ?? null;
  }

  // ───────────────────────── 놓기 ─────────────────────────

  /**
   * RELEASE를 보낸다 (도우미는 남는다). 실제로 뗀 키·버튼이 있으면 그 키 올림은 앱의 입력이다 — 다음 무장의 시작 값(GetLastInputInfo)이 그 시각이어도 사람 입력으로
   * 읽지 않는다 (리드 결정 S6-21 F3). 조작 중 표시는 부르는 쪽이 끈다 (safety.disarmed)
   */
  async releaseKeys(h: DesktopHelperClient, o: { countFailure?: boolean } = {}): Promise<ReleaseResult> {
    const from = Date.now();
    const rel = await h.release(o);
    if (rel.acked && (rel.released ?? 0) > 0) this.host.safety.ownKeyUps(from, Date.now());
    return rel;
  }

  /**
   * 무장한 호출이 놓게 됐다 (턴이 끝난 뒤에 온 ARM 답 등 — service.dropArm, 멈춤 단축키를 등록하지 못한 도우미의 gui_input 거부). 답을 받으면 표시를 끄고,
   * 답이 없으면 그 도우미를 멈추고 끝낸다 — 턴이 끝났는데 무장한 채 남기지 않는다. 세는 놓기다: 답하지 않거나 알아볼 수 없게 답한 도우미는 클라이언트가 멈추고
   * 다시 띄우기 상한에 센다 — 그런 도우미를 호출마다 새로 띄우고 경고·알림 업무를 끝없이 쌓지 않는다(세 번이면 상한). 답한 도우미는 세지 않는다 (S6-25 N2)
   */
  async releaseOrStop(h: DesktopHelperClient, turnId: string | null): Promise<void> {
    const rel = await this.releaseKeys(h, { countFailure: true });
    if (rel.acked) {
      this.host.safety.disarmed(true);
      return;
    }
    // 그 도우미의 정지가 돌고 있으면(답하지 않아 클라이언트가 스스로 센 정지, 또는 그사이 온 다른 정지) 그 정지를 기다린다 — 스스로 한 정지의 서버 정지 줄·활동
    // 기록은 그 'stopped' 알림이 남긴다(onHelperEvent). 도는 정지가 없으면(도우미가 이미 끝났다) 전처럼 정지로 잇는다
    const own = h.stopping();
    if (own) await own.catch(() => null);
    else if (rel.hadProcess) await this.stop('놓기(RELEASE)에 답하지 않음', { turnId });
  }

  /**
   * 놓았다는 답을 받지 못한 무장 표시가 남아 있으면 새 도우미에 RELEASE를 먼저 보내 답을 받는다 (리드 결정 S6-21 A4) — 그 뒤에야 무장한다. 표시가 없으면 바로 ok
   * (released null). 답을 받으면 표시를 지우고 활동 기록에 남긴다. 못 받으면 표시는 남는다(다음 무장이 다시 놓는다). 답하지 않는(또는 알아볼 수 없게 답한) 새
   * 도우미는 클라이언트가 다른 명령의 시간 초과처럼 멈추고 다시 띄우기 상한에 센다 — 호출마다 새 도우미를 끝없이 띄우지 않는다 (리드 결정 S6-23 M2).
   * when 'release': 떠 있는 도우미가 없을 때의 gui_input release (S6-23 M1)
   */
  releaseOverMark(when: 'restart' | 'arm' | 'release'): Promise<MarkRelease> {
    const { safety } = this.host;
    const mark = safety.armedMark();
    if (!mark) return Promise.resolve({ ok: true, released: null });
    if (this.releasing) return this.releasing;
    const ctx = this.ctx;
    const p = (async (): Promise<MarkRelease> => {
      const h = this.host.client();
      if (!h) return { ok: false, reason: '화면 도우미가 없습니다' };
      // 이미 떠 있던 도우미 (없으면 null — 이 놓기를 하려고 띄운다)
      const had = h.state() === 'ready' ? h.pid : null;
      const ready = await h.ready();
      if (!ready.ok) return { ok: false, reason: `화면 도우미를 띄우지 못했습니다 (${ready.text})` };
      // 도우미를 기다리는 사이 화면 조작을 멈췄다(긴급 정지·메인 일시정지·자리 교체·문·앱 종료) — RELEASE를 보내지 않고 표시를 남긴다(다음 무장이 그 앞에서 다시
      // 놓는다). 그사이 뜬 도우미는 끝낸다 — 정지 뒤에 도우미를 남기지 않는다. 부른 쪽의 다시 보기가 그 정지의 글(stopped·conflict)로 거부한다 (리드 결정
      // S6-25 N3). 다시 시작 때의 한 번 놓기는 도구 호출의 다시 보기가 아니다 — 그대로 놓는다
      if (when !== 'restart' && this.host.haltedNow()) {
        if (h.pid !== null && h.pid !== had) {
          // 부른 정지다(세지 않는다). 놓기 표시는 건드리지 않는다 — afterStop을 거치지 않는다. 끝남을 확인하지 못하면 그 'stopped' 알림이 문을 건다
          const why = '화면 조작을 멈춘 사이에 뜬 화면 도우미를 끝냄';
          const r = await h.stop(why).catch((e: unknown) => {
            ctx.log('error', '화면 도우미 정지 오류', e);
            this.setGate(why);
            return null;
          });
          if (r) this.serverRow('stop', null, r.ok ? 'ok' : 'error', `${why}: ${r.detail}`);
        }
        return { ok: false, reason: '화면 조작을 멈춘 사이라 놓지 않았습니다' };
      }
      // 답이 없으면 클라이언트가 그 도우미를 멈추고 센다 (countFailure) — 서버의 정지 줄·활동 기록은 그 정지의 'stopped' 알림이 남긴다 (onHelperEvent)
      const rel = await this.releaseKeys(h, { countFailure: true });
      if (!rel.acked) return { ok: false, reason: rel.detail };
      safety.clearArmedMark();
      const n = rel.released ?? 0;
      ctx.activity({
        kind: 'screen',
        level: 'info',
        memberId: MAIN_AGENT_ID,
        text:
          when === 'restart'
            ? `서버를 다시 시작하며 새 화면 도우미로 눌린 키·버튼을 뗌 (${n}개) — 앞 실행이 화면을 조작하던 중(${mark.at}에 시작) 놓았다는 답을 받지 못하고 끝났습니다`
            : when === 'release'
              ? `메인 에이전트의 놓기(gui_input release)로 새 화면 도우미를 띄워 눌린 키·버튼을 뗌 (${n}개) — 앞선 화면 조작(${mark.at}에 시작)이 놓았다는 답을 받지 못하고 끝났습니다`
              : `새 화면 도우미로 눌린 키·버튼을 먼저 뗌 (${n}개) — 앞선 화면 조작(${mark.at}에 시작)이 놓았다는 답을 받지 못하고 끝났습니다`,
      });
      return { ok: true, released: n };
    })().finally(() => {
      if (this.releasing === p) this.releasing = null;
    });
    this.releasing = p;
    return p;
  }

  // ───────────────────────── 턴 끝 ─────────────────────────

  /**
   * 메인 턴이 끝날 때. 도우미가 무장해 있으면 놓고(RELEASE — 답이 없으면 STOP하고 끝낸다), 그 턴의 화면 조작을 한 줄로 남긴다. 던지지 않는다
   */
  async settleTurn(turnId: string, o: { memberId: string; sessionId: string | null; projectId: string | null; workKey: string; generation: number }): Promise<void> {
    const { safety, records } = this.host;
    try {
      // 도는 정지(긴급 정지·자리 교체·앱 종료, 클라이언트가 스스로 하는 정지)가 있으면 그 결과부터 기다린다 — 끝남을 확인하지 못하면 그 정지가 이 턴에 접는다
      // (setGate — 이 턴은 아직 도는 턴이다). 그래서 턴은 남은 프로세스를 읽기 전에 이것을 기다린다 (turns.finish)
      const pending = this.inFlight;
      if (pending) await pending.catch(() => null);
      const own = this.host.peek()?.stopping();
      if (own) await own.catch(() => null);
      const h = this.host.peek();
      // 무장해 있으면 놓는다 — 이 턴이 화면을 썼는지는 묻지 않는다. 메인 턴은 한 번에 하나라(core/scheduling pickStarts) 무장한 도우미는 이 턴의 것이거나,
      // 앞선 턴이 놓지 못하고 남긴 것이다 — 어느 쪽이든 턴과 턴 사이에 무장한 채 두지 않는다
      if (h?.armed()) {
        const rel = await this.releaseKeys(h);
        if (rel.acked) {
          // 도는 명령의 답(멈췄다는 답)을 받아 그 줄이 닫힐 때까지 — 1초까지
          await h.settled(1000);
          safety.disarmed(true);
          this.serverRow('release', turnId, 'ok', `턴 끝: ${rel.detail}`);
        } else if (rel.hadProcess) {
          this.serverRow('release', turnId, 'error', `턴 끝: ${rel.detail}`);
          // 끝남까지 확인하지 못하면 문이 걸리고 이 턴에 접힌다 — 턴은 kill_failed로 끝나고 메인 에이전트가 일시정지된다 (출구는 대표의 정지 해제)
          await this.stop('턴 끝 — 놓기(RELEASE)에 답하지 않음', { turnId });
        } else safety.disarmed(false);
      }
    } catch (e) {
      this.ctx.log('warn', '턴 끝에 화면 도우미를 놓지 못했습니다', e);
    }
    safety.turnEnded(turnId);
    try {
      records.writeTurnSummary(turnId, { memberId: o.memberId, sessionId: o.sessionId, projectId: o.projectId as ProjectId | null, workKey: o.workKey, generation: o.generation });
    } catch (e) {
      this.ctx.log('warn', '화면 조작 턴 기록을 남기지 못했습니다', e);
    }
  }

  // ───────────────────────── 다시 시작 ─────────────────────────

  /**
   * 다시 시작했을 때 (재시작 복구 뒤, 턴을 띄우기 전): 끊긴 입력 줄을 닫고 빠진 턴 한 줄을 남기고, 앞 실행이 끝남을 확인하지 못한 도우미의 표시를 지우고(그 도우미는
   * 서버와 함께 끝났다), 앞 실행이 놓지 못한 키를 새 도우미로 한 번 놓는다. 놓기는 기다리지 않는다 (restartRelease) — 도우미 준비가 시작을 붙잡지 않게
   */
  reconcile(): void {
    const ctx = this.ctx;
    const { records, safety } = this.host;
    try {
      const cut = records.repo.query({ results: ['sent'], limit: 500, asc: true });
      for (const row of cut) records.finish(row, { result: 'error', detail: RESTART_CUT_DETAIL });
      // 최근 줄의 턴 가운데 끝났는데 한 줄이 없는 턴 (writeTurnSummary는 같은 턴에 두 번 남기지 않는다)
      const generationOf = new Map<string, number>();
      for (const r of records.repo.query({ limit: 300 })) if (r.turnId && !generationOf.has(r.turnId)) generationOf.set(r.turnId, r.generation);
      for (const [turnId, generation] of generationOf) {
        const t = ctx.store.turns.get(turnId);
        if (!t || !t.endedAt) continue;
        records.writeTurnSummary(turnId, {
          memberId: t.memberId,
          sessionId: t.sessionId,
          projectId: (t.workProjectId ?? t.projectId ?? null) as ProjectId | null,
          workKey: ctx.store.sessions.get(t.sessionId)?.workKey ?? null,
          generation,
        });
      }
      if (cut.length) ctx.log('info', `화면 조작: 서버 재시작으로 끊긴 입력 줄 ${cut.length}개를 닫았습니다`);
    } catch (e) {
      ctx.log('warn', '화면 조작 기록을 다시 맞추지 못했습니다', e);
    }
    safety.resetAtStart();
    // 앞 실행이 끝남을 확인하지 못한 도우미는 서버의 작업 개체와 함께 끝났다 — 표시를 지운다 (리드 결정 S6-21 A2 ②). 그 도우미가 키를 누른 채 끝났을 수 있는 것은
    // 놓기 표시(desktop:armed)가 맡는다: 아래의 한 번 놓기와, 그 뒤 모든 무장 앞의 놓기 (A4)
    if (this.gate) this.clearGate('서버를 다시 시작함 (앞 실행의 화면 도우미는 서버와 함께 끝남)', this.heldAfterRestart());
    const mark = safety.armedMark();
    if (mark) this.restartRelease = this.releaseAfterRestart(mark.at).catch((e) => ctx.log('warn', '다시 시작 뒤 화면 도우미로 키를 놓지 못했습니다', e));
  }

  /**
   * 다시 시작하며 문을 열 때 활동 기록에 붙일 말 — 그 문과 함께 건 메인 에이전트의 일시정지와 멈춘 메인 자리 교체는 다시 시작해도 남는다. 대표의 '정지 해제'가
   * 푼다 (리드 결정 S6-23 M 'accepted (a)', CTL-11과 같다). 둘 다 없으면 빈 글
   */
  private heldAfterRestart(): string {
    const ctx = this.ctx;
    const paused = !!ctx.stop().members[MAIN_AGENT_ID]?.paused;
    const seat = ctx.store.seat.get('main');
    const swapHeld = seat?.state === 'switching' && seat.swap?.stage === 'unconfirmed';
    if (!paused && !swapHeld) return '';
    const what = paused && swapHeld ? '메인 에이전트의 일시정지와 멈춘 메인 자리 교체는' : paused ? '메인 에이전트의 일시정지는' : '멈춘 메인 자리 교체는';
    const then = paused && swapHeld ? '일시정지가 풀리고 교체를 이어 갑니다' : paused ? '풀립니다' : '교체를 이어 갑니다';
    return ` — 다만 ${what} 다시 시작해도 그대로입니다. 대표가 '정지 해제'를 누르면 ${then}`;
  }

  /**
   * 앞 실행이 놓았다는 답을 받지 못하고 끝났다 — 새 도우미를 한 번 띄워 놓는다. 이 실행이 화면 도우미를 쓰지 않으면(놓을 길도, 무장할 길도 없다) 표시를 지우고
   * 그 PC 앞에서 할 일을 남긴다. 화면 도우미를 쓰는 실행에서 놓지 못했으면 표시를 남긴다 — 다음 무장이 그 앞에서 다시 놓는다 (리드 결정 S6-21 A4)
   */
  private async releaseAfterRestart(armedAt: string): Promise<void> {
    const ctx = this.ctx;
    const { safety } = this.host;
    const why = `앞 실행이 화면을 조작하던 중(${armedAt}에 시작) 놓았다는 답을 받지 못하고 끝났습니다`;
    const failed = (reason: string, tail: string): void => {
      ctx.activity({ kind: 'screen', level: 'warn', memberId: MAIN_AGENT_ID, text: `서버를 다시 시작했지만 눌린 키·버튼을 떼지 못함 — ${reason}. ${why}. ${tail}${HELD_KEYS_HINT}` });
    };
    if (safety.modeOff() || !this.host.hasHelper()) {
      safety.clearArmedMark();
      return failed('이 실행에서는 화면 도우미를 쓰지 않습니다', '');
    }
    const r = await this.releaseOverMark('restart');
    if (!r.ok) failed(r.reason, '메인 에이전트가 화면 도구를 다시 쓸 때 먼저 놓습니다. ');
  }
}
