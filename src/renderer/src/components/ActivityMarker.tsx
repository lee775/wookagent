import { Armchair, NotebookPen, Monitor } from 'lucide-react';
import type { ActivityView } from '../../../shared/views';

export function ActivityMarker({ item }: { item: ActivityView }) {
  if (item.kind === 'seat' || item.kind === 'journal' || item.kind === 'screen') {
    const Icon = item.kind === 'seat' ? Armchair : item.kind === 'screen' ? Monitor : NotebookPen;
    return <span className="activity-seat-icon" role="img" aria-label={item.kind === 'seat' ? '자리' : item.kind === 'screen' ? '화면 조작' : '일지'}><Icon size={17} /></span>;
  }
  return <span className={`activity-marker ${item.level}`} />;
}
