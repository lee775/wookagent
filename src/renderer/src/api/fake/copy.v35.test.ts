import { describe, expect, it } from 'vitest';
import { activity, members, reports, roles, snapshot } from './data';

const sources = import.meta.glob<string>([
  './**/*.{ts,tsx}', '../screens/**/*.{ts,tsx}', '../components/**/*.{ts,tsx}',
  '!**/*.test.ts',
], { query: '?raw', import: 'default', eager: true });

describe('demo copy stays within the walk journal', () => {
  it('contains no reference ordering vocabulary', () => {
    const banned = /메뉴|주문|손님|음료|합계|\border\b|\bcafe\b|OrderScreen|order-flow/i;
    const hits = Object.entries(sources).filter(([, source]) => banned.test(source)).map(([file]) => file);
    expect(hits).toEqual([]);
  });
  it('keeps names, role descriptions, reports, and directory AI summaries distinct', () => {
    for (const item of activity) {
      const member = members.find(person => person.id === item.memberId);
      if (member) expect(item.actorName).toBe(member.name);
    }
    for (const todo of snapshot.ownerTodos) {
      if (todo.kind === 'error' && todo.memberId)
        expect(todo.message).toContain(members.find(person => person.id === todo.memberId)?.name);
    }
    expect(new Set(roles.map(role => role.instructions)).size).toBe(roles.length);
    expect(new Set(reports.map(report => report.sections.summary)).size).toBe(reports.length);
    const summaries = members.filter(member => member.projectId === 'P-0003').map(member =>
      `${member.ai.kind}:${member.ai.modelValue ?? member.ai.model ?? 'default'}:${member.ai.effortTier}:${member.ai.effortValue}:${member.ai.mock}`);
    const frequency = summaries.map(summary => summaries.filter(other => other === summary).length);
    expect(Math.max(...frequency)).toBeLessThanOrEqual(2);
  });
});
