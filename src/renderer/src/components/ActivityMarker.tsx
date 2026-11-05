import { Armchair, NotebookPen } from 'lucide-react';
import type { ActivityView } from '../../../shared/views';

export function ActivityMarker({ item }: { item: ActivityView }) {
  if (item.kind === 'seat' || item.kind === 'journal') {
    const Icon = item.kind === 'seat' ? Armchair : NotebookPen;
    return <span className="activity-seat-icon" role="img" aria-label={item.kind === 'seat' ? '자리' : '일지'}><Icon size={17} /></span>;
  }
  return <span className={`activity-marker ${item.level}`} />;
}
