import { Monitor, Pause } from 'lucide-react';
import type { AppSnapshot } from '../../../shared/views';
import { date } from '../lib/ui';
import { screenPauseReason } from '../lib/screens';

export function ScreenChip({ snapshot, open }: { snapshot: AppSnapshot; open: () => void }) {
  const { screen } = snapshot.seat;
  if (!snapshot.auth.loggedIn || (!screen.operatingSince && !screen.paused)) return null;
  const label = screen.paused
    ? `화면 조작 멈춤 — ${screenPauseReason(screen.paused.by)} · ${date(screen.paused.until)}까지`
    : '화면 조작 중';
  const Icon = screen.paused ? Pause : Monitor;
  return <button className={`screen-chip ${screen.paused ? 'paused' : 'operating'}`} onClick={open} aria-label={label} title={label}>
    <Icon size={16} aria-hidden="true" /><span>{label}</span>
  </button>;
}
