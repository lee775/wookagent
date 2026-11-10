import type { GuiActionView, SeatView } from '../../../shared/views';

export function screenPauseReason(by: 'human' | 'local'): string {
  return by === 'human' ? '서버 PC 앞 사람 입력' : '서버 PC의 멈춤 단축키';
}

export function screenVision(seat: SeatView): string {
  if (seat.vision === 'verified') return '화면 보기: 확인됨 — 시험 이미지를 읽었습니다.';
  if (seat.vision === 'failed') return '화면 보기: 실패 — 메인 에이전트는 화면 이미지 대신 창과 좌표의 글 정보만 받습니다.';
  return `화면 보기: 아직 확인 안 함 — ${seat.screen.unavailable?.text ?? '시험 이미지 읽기를 아직 마치지 않았습니다.'}`;
}

export function screenTypedText(row: GuiActionView): string {
  if (row.text !== null && row.result !== 'secret_blocked' && row.focus?.password === false) return row.text;
  return `가림 · ${row.textLength ?? 0}자`;
}
