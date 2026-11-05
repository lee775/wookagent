import { describe, expect, it } from 'vitest';
import { plateStateFor, type Behaviour, type Place, type Pose } from './motion';

const example = (place: Place, pose: Pose, label: string): Behaviour =>
  ({ key: `${place}:${label}`, place, pose, label, point: { x: 0, y: 0 } });

describe('state plates describe the task, not a cosmetic pose', () => {
  it.each([
    [example('board', 'point', '작업 조율'), '작업 조율'],
    [example('board', 'point', '작업 계획'), '계획 확인'],
    [example('desk', 'point', '구성도를 살핍니다.'), '구조 확인'],
    [example('visit', 'submit', '작업 전달'), '작업 전달'],
    [example('visit', 'submit', '검수 전달'), '검수 전달'],
    [example('visit', 'receive', '검수 확인'), '검수 확인'],
    [example('inbox', 'submit', '보고 전달'), '보고 전달'],
    [example('inbox', 'submit', '자료 전달'), '자료 전달'],
    [example('desk', 'drink', '코드를 확인합니다.'), '업무 중'],
    [example('desk', 'read', '자리에서 쉬는 중'), '자리에서 휴식'],
    [example('desk', 'point', '단계 완료'), '단계 완료'],
    [example('desk', 'celebrate', '검수 통과'), '검수 통과'],
  ] as const)('%j → %s', (behaviour, expected) => {
    expect(plateStateFor(behaviour)).toBe(expected);
  });
});
