import { describe, expect, it } from 'vitest';
import { snapshot } from './data';
import { officeDemoSnapshot } from './officeDemo';

const copiedNames = new Set(['하루', '도윤', '모아', '리듬', '이야', '체크', '소담']);

describe('renderer demo identities', () => {
  it('never uses names from the rejected reference team', () => {
    for (const source of [snapshot, officeDemoSnapshot(snapshot, 'busy', 0), officeDemoSnapshot(snapshot, 'events', 0)]) {
      source.members.forEach(member => expect(copiedNames.has(member.name), member.id).toBe(false));
    }
  });
});
