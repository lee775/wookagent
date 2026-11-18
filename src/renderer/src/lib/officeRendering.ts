import type { MemberView } from '../../../shared/views';

export function officeIsStill(members: MemberView[], emergency: boolean, reduced: boolean) {
  return reduced || emergency || members.every(member => member.status === 'idle');
}
