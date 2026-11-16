import { describe, expect, it } from 'vitest';
import { snapshot } from './data';
import { officeDemoSnapshot } from './officeDemo';
import { officeDepartmentSnapshot, OFFICE_STATES } from './departments';
import { demoNames } from './names';
import { officeDemoStep } from '../../studio/officeDemoStep';
import { officeLabel } from '../../lib/officePeople';

const copiedNames = new Set(['하루', '도윤', '모아', '리듬', '이야', '체크', '소담']);

describe('renderer demo identities', () => {
  it('uses unique personal names in every demo company and preserves them in display labels', () => {
    const steps = ['idle', 'busy', 'assignment', 'step', 'review', 'submit', 'check', 'rejected',
      'passed', 'conflict', 'waiting', 'error', 'paused', 'report', 'emergency', 'release', 'events',
      'hiring', 'team2', 'team20', 'team24', 'team30', 'team50'];
    const sources = [snapshot, ...OFFICE_STATES.map(state => officeDepartmentSnapshot(snapshot, state)),
      ...steps.flatMap(query => [0, 8000, 60000].map(elapsed => {
        const step = officeDemoStep(query, elapsed);
        if (!step) throw new Error(`Missing demo: ${query}`);
        return officeDemoSnapshot(snapshot, step, elapsed);
      }))];
    expect(new Set(demoNames).size).toBe(demoNames.length);
    for (const source of sources) {
      const names = source.members.map(member => member.name);
      expect(new Set(names).size, 'Names must be unique across departments').toBe(names.length);
      for (const member of source.members) {
        expect(member.name, member.id).toMatch(/^[가-힣]{2,4}$/u);
        expect(member.name, member.id).not.toMatch(/코덱스|클로드|제미나이|메인|프로듀서|개발|기획|설계|디자인|디자이너|검수|문서|팀원|아키텍트|자료|품질|운영|조사/u);
        expect(copiedNames.has(member.name), member.id).toBe(false);
        expect(officeLabel(member, source, false).name).toBe(member.name);
      }
    }
  });
  it('never uses names from the rejected reference team', () => {
    for (const source of [snapshot, officeDemoSnapshot(snapshot, 'busy', 0), officeDemoSnapshot(snapshot, 'events', 0)]) {
      source.members.forEach(member => expect(copiedNames.has(member.name), member.id).toBe(false));
    }
  });
});
