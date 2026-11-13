import type { officeLabel } from '../lib/officePeople';

export function OfficeLabel({ label }: { label: ReturnType<typeof officeLabel> }) {
  return <strong className="staff-name">{label.name}</strong>;
}
