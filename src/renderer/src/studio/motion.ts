import type { ActivityView, DirectiveView, MemberView, TaskView } from '../../../shared/views';
import { hashId } from './characters';

export interface Point { x: number; y: number }
export interface Seat extends Point { side: 'far' | 'near'; pod: number }
export type Pose = 'type' | 'draw' | 'write' | 'diagram' | 'check' | 'check_wait' | 'read' | 'plan' | 'walk' | 'drink' | 'stretch' | 'nap' | 'chat' | 'point' | 'celebrate' | 'sigh' | 'receive' | 'wait' | 'error' | 'pause' | 'submit' | 'review' | 'conflict' | 'phone' | 'water' | 'window' | 'inspect';
export type Place = 'desk' | 'coffee' | 'lounge' | 'board' | 'window' | 'plant' | 'inbox' | 'visit';
export interface Behaviour { key: string; pose: Pose; place: Place; point: Point; label: string }
const plateStates: Record<Pose, string> = {
  type: '화면 구현', draw: '화면 설계', write: '문서 작성', diagram: '구조 설계', check: '품질 검수',
  check_wait: '자동 검사', read: '자료 확인', plan: '작업 계획', walk: '이동 중', drink: '커피 휴식',
  stretch: '몸 풀기', nap: '낮잠', chat: '대화 중', point: '단계 완료', celebrate: '검수 통과',
  sigh: '수정 중', receive: '검수 확인', wait: '답변 대기', error: '오류 확인', pause: '일시정지',
  submit: '검수 전달', review: '검수 중', conflict: '충돌 해결', phone: '전화 확인', water: '화분 돌봄',
  window: '창가 휴식', inspect: '화면 확인',
};
export function plateStateFor(behaviour: Behaviour): string {
  if (behaviour.place === 'board') return behaviour.label === '작업 조율' ? '작업 조율' : '계획 확인';
  if (behaviour.place === 'visit') return behaviour.label;
  if (behaviour.place === 'inbox') return behaviour.label === '보고 전달' ? '보고 전달' : '자료 전달';
  if (behaviour.place === 'coffee') return '커피 휴식';
  if (behaviour.place === 'lounge') return behaviour.label === '동료와 대화' ? '대화 중' : behaviour.label;
  if (behaviour.place === 'window') return behaviour.pose === 'pause' ? '일시정지' : '창가 휴식';
  if (behaviour.place === 'plant') return '화분 돌봄';
  if (behaviour.label === '자리에서 쉬는 중') return '자리에서 휴식';
  if (['단계 완료', '검수 통과', '병합 완료', '완료', '업무 배정', '오류 확인', '충돌 해결',
    '반려 · 수정 중', '자동 검사 중', '답변 대기', '일시정지', '긴급 정지'].includes(behaviour.label)) return behaviour.label;
  if (behaviour.pose === 'point') return '구조 확인';
  if (behaviour.pose === 'drink') return '업무 중';
  if (behaviour.pose === 'submit' || behaviour.pose === 'receive') return behaviour.label;
  return plateStates[behaviour.pose];
}
export interface Context { member: MemberView; seat: Seat; index: number; now: number; seconds: number; reviewSeconds?: number; tasks: TaskView[]; directives: DirectiveView[]; activity: ActivityView[]; seats: Map<string, Seat>; members?: MemberView[]; emergency: boolean }

export interface Rectangle { left: number; top: number; right: number; bottom: number }
const deskXs = [150, 300, 500, 650, 850, 1000];
export const stations: Seat[] = [
  ...deskXs.map((x, index) => ({ x, y: 282, side: 'far' as const, pod: Math.floor(index / 2) })),
  ...deskXs.map((x, index) => ({ x, y: 460, side: 'near' as const, pod: Math.floor(index / 2) })),
];
export const deskRects: Rectangle[] = stations.map(seat => ({ left: seat.x - 50, right: seat.x + 50,
  top: seat.side === 'far' ? 309 : 410, bottom: seat.side === 'far' ? 350 : 453 }));
export const furniture: Rectangle[] = [
  ...deskRects.map(rect => ({ left: rect.left - 22, right: rect.right + 22, top: rect.top - 22, bottom: rect.bottom + 22 })),
  ...[[90, 190], [260, 355], [440, 540], [610, 705], [790, 890], [960, 1055]].map(([left, right]) =>
    ({ left: left - 22, top: 365 - 22, right: right + 22, bottom: 392 + 22 })),
  { left: 710, top: 90, right: 810, bottom: 156 },
  { left: 829, top: 83, right: 1082, bottom: 161 },
  { left: 1074, top: 34, right: 1177, bottom: 168 },
  { left: 1090, top: 550, right: 1170, bottom: 610 },
  { left: 2, top: 403, right: 95, bottom: 562 },
  { left: 1090, top: 336, right: 1160, bottom: 390 },
];

export const places: Record<Exclude<Place, 'desk' | 'visit'>, Point> = {
  coffee: { x: 1130, y: 166 }, lounge: { x: 965, y: 155 }, board: { x: 600, y: 166 },
  window: { x: 163, y: 175 }, plant: { x: 48, y: 525 }, inbox: { x: 1124, y: 390 },
};
export const placeSlots: Record<Exclude<Place, 'desk' | 'visit'>, Point[]> = {
  lounge: [{ x: 845, y: 150 }, { x: 915, y: 150 }, { x: 985, y: 150 }, { x: 1055, y: 150 }],
  coffee: [{ x: 1100, y: 150 }, { x: 1170, y: 150 }, { x: 1130, y: 240 }],
  window: [{ x: 84, y: 150 }, { x: 166, y: 150 }, { x: 248, y: 150 }, { x: 310, y: 150 }],
  board: [{ x: 470, y: 150 }, { x: 540, y: 150 }, { x: 700, y: 150 }],
  plant: [{ x: 20, y: 575 }],
  inbox: [{ x: 1125, y: 423 }],
};
export const placeCapacity = (place: keyof typeof placeSlots) => placeSlots[place].length;

const workPose: Record<string, Pose[]> = {
  developer: ['type', 'type', 'type', 'inspect', 'drink'], ui_designer: ['draw', 'draw', 'inspect'],
  planner: ['write', 'plan', 'write'], architect: ['diagram', 'point', 'diagram'],
  qa: ['check', 'inspect', 'check'], docs: ['write', 'read', 'write'], producer: ['plan', 'read', 'point'],
};
const restOptions: Array<[Exclude<Place, 'desk' | 'visit'>, Pose, string]> = [
  ['coffee', 'drink', '커피 한 잔'], ['lounge', 'nap', '잠깐 낮잠'],
  ['window', 'window', '창밖 보기'], ['plant', 'water', '화분 돌보기'], ['lounge', 'stretch', '몸 풀기'],
  ['lounge', 'phone', '휴대전화 확인'], ['lounge', 'read', '책 읽기'],
];
function idleChoice(member: MemberView, index: number, seconds: number, members?: MemberView[]): typeof restOptions[number] | null {
  if (member.status !== 'idle') return null;
  const partner = members?.[index % 2 === 0 ? index + 1 : index - 1];
  const restClock = seconds + (hashId(member.id) % 29) * 1.7;
  const phase = restClock % 68;
  const trip = Math.floor(restClock / 68);
  if (index < 6 && partner?.status === 'idle' && phase >= 24 && phase < 43) return ['lounge', 'chat', '동료와 대화'];
  if (phase < 24 || phase > 64) return null;
  const available = index < 6 ? restOptions : restOptions.filter(([place]) => place !== 'lounge');
  return available[(hashId(member.id) + trip + index) % available.length];
}
type RestAssignment = { place: keyof typeof placeSlots; rank: number; pose: Pose; label: string };
const restAssignments = new Map<string, RestAssignment[]>();
function assignedRest(members: MemberView[], index: number): RestAssignment | null {
  const roster = members.map(member => member.id).join('|');
  let assignments = restAssignments.get(roster);
  if (!assignments) {
    const taken = new Set<string>();
    let napAssigned = false;
    assignments = members.map((member, cursor) => {
      const seat = stations[cursor];
      const options = (Object.entries(placeSlots) as Array<[keyof typeof placeSlots, Point[]]>)
        .filter(([place]) => cursor >= 3 && cursor < 6 ? place === 'lounge' : place !== 'board' && place !== 'lounge')
        .flatMap(([place, slots]) => slots.map((point, rank) => ({ place, point, rank })))
        .filter(slot => !taken.has(`${slot.place}:${slot.rank}`))
        .sort((a, b) => Math.hypot(a.point.x - seat.x, a.point.y - seat.y) - Math.hypot(b.point.x - seat.x, b.point.y - seat.y) ||
          hashId(`${member.id}:${a.place}:${a.rank}`) - hashId(`${member.id}:${b.place}:${b.rank}`));
      const chosen = options[0];
      if (!chosen) return { place: 'window', rank: 0, pose: 'window' as const, label: '창가 휴식' };
      let rank = chosen.rank;
      if (chosen.place === 'lounge' && !napAssigned) {
        rank = 0;
        taken.add('lounge:0'); taken.add('lounge:1');
        napAssigned = true;
      } else taken.add(`${chosen.place}:${rank}`);
      const poses: Record<keyof typeof placeSlots, [Pose, string]> = {
        lounge: napAssigned && rank === 0 ? ['nap', '낮잠'] : ['chat', '대화 중'],
        coffee: ['drink', '커피 휴식'], window: ['window', '창가 휴식'], board: ['point', '계획 확인'],
        plant: ['water', '화분 돌봄'], inbox: ['submit', '자료 전달'],
      };
      const [pose, label] = poses[chosen.place];
      return { place: chosen.place, rank, pose, label };
    });
    restAssignments.set(roster, assignments);
  }
  return assignments[index] ?? null;
}
function allocateRest(member: MemberView, index: number, seconds: number, members?: MemberView[]) {
  if (!idleChoice(member, index, seconds, members)) return null;
  if (!members) {
    const choice = idleChoice(member, index, seconds);
    return choice && { choice, rank: index % placeCapacity(choice[0]) };
  }
  const assignment = assignedRest(members, index);
  return assignment && { choice: [assignment.place, assignment.pose, assignment.label] as typeof restOptions[number], rank: assignment.rank };
}

function recent(item: ActivityView | { ts: string }, now: number, span = 7000): boolean {
  const age = now - Date.parse(item.ts);
  return age >= 0 && age < span;
}

export function slotPoint(place: Exclude<Place, 'desk' | 'visit'>, index: number): Point {
  return placeSlots[place][index % placeSlots[place].length];
}

export function visitPoint(seat: Seat): Point {
  const side = seat.x === 650 ? -1 : 1;
  return { x: seat.x + side * (seat.side === 'far' ? 80 : 55), y: seat.side === 'far' ? 285 : 585 };
}

export function behaviourFor({ member, seat, index, now, seconds, reviewSeconds, tasks, directives, activity, seats, members, emergency }: Context): Behaviour {
  const desk = (pose: Pose, label: string): Behaviour => ({ key: `desk:${seat.x}:${seat.y}`, pose, place: 'desk', point: seat, label });
  const at = (place: Exclude<Place, 'desk' | 'visit'>, pose: Pose, label: string): Behaviour => {
    const point = slotPoint(place, index);
    return { key: `${place}:${point.x}:${point.y}`, pose, place, point, label };
  };
  if (emergency) return desk('pause', '긴급 정지');
  const assigned = tasks.find(task => task.assigneeId === member.id && task.state !== 'cancelled');
  const current = tasks.find(task => task.id === member.currentTask?.id) ?? assigned;
  const event = activity.find(item => item.memberId === member.id && recent(item, now));
  if (member.status === 'error' || current?.hold?.reasons.some(reason => reason.kind === 'error') || event?.kind === 'error') return desk('error', '오류 확인');
  if (current?.conflictFiles.length || current?.hold?.reasons.some(reason => reason.kind === 'merge_blocked') || member.currentWork?.kind === 'conflict_fix' || (event?.kind === 'merge' && event.level === 'warn')) return desk('conflict', '충돌 해결');
  if (event?.kind === 'review' && event.level === 'warn') return desk('sigh', '반려 · 수정 중');
  if (event && (event.kind === 'merge' || event.kind === 'review') && event.level === 'info') return desk('celebrate', '검수 통과');
  if (current?.review.autoCheck === 'running') return desk('check_wait', '자동 검사 중');
  if (member.status === 'awaiting_answer' || current?.hold?.reasons.some(reason => reason.kind === 'answer_wait')) return desk('wait', '답변 대기');
  if (member.status === 'paused' || current?.hold?.reasons.some(reason => reason.kind === 'paused')) {
    return desk('pause', '일시정지');
  }
  const reviewTask = tasks.find(task => task.state === 'in_review' && (task.assigneeId === member.id || task.reviewerId === member.id) && task.reviewerId !== task.assigneeId);
  if (reviewTask) {
    const submitter = seats.get(reviewTask.assigneeId);
    const reviewer = reviewTask.reviewerId && seats.get(reviewTask.reviewerId);
    const phase = Math.min(reviewSeconds ?? seconds, 25.99);
    if (member.id === reviewTask.assigneeId) {
      if (reviewer && phase < 15) {
        const anchor = visitPoint(reviewer);
        const side = seat.x >= reviewer.x ? 1 : -1;
        const point = { x: anchor.x + side * 70, y: anchor.y };
        return { key: `visit:${point.x}:${point.y}`, pose: phase < 8 ? 'submit' : 'receive', place: 'visit', point, label: '검수 전달' };
      }
      return desk('type', member.currentTask?.currentStep ?? '수정 사항 확인');
    }
    if (submitter && phase >= 5 && phase < 15) {
      const point = visitPoint(seat);
      return { key: `visit:${point.x}:${point.y}`, pose: phase < 8 ? 'receive' : 'submit', place: 'visit', point, label: '검수 확인' };
    }
    return desk('check', '검수 대기');
  }
  const finishedStep = current?.steps.find(step => step.done && step.doneAt && recent({ ts: step.doneAt }, now));
  if (finishedStep) return desk('point', '단계 완료');
  if (event?.kind === 'file_change') return desk('point', '단계 완료');
  if (event?.kind === 'report' && (member.isProducer || member.isMain)) return at('inbox', 'submit', '보고 전달');
  if (member.isProducer) {
    if (tasks.some(task => task.projectId === member.projectId && task.state === 'in_review')) return desk('plan', '작업 조율');
    const newTask = tasks.find(task => task.activatedAt && now - Date.parse(task.activatedAt) >= 0 && now - Date.parse(task.activatedAt) < 9000);
    const destination = newTask && seats.get(newTask.assigneeId);
    if (newTask && destination) {
      const point = visitPoint(destination);
      return { key: `visit:${point.x}:${point.y}`, pose: 'submit', place: 'visit', point, label: '작업 전달' };
    }
    if (directives.some(item => item.state === 'planning')) return { key: 'board:370:205', pose: 'point', place: 'board', point: { x: 370, y: 205 }, label: '작업 계획' };
    if (member.status === 'working') return { key: 'board:370:205', pose: 'point', place: 'board', point: { x: 370, y: 205 }, label: '작업 조율' };
  }
  if (current?.merge?.mergedAt && recent({ ts: current.merge.mergedAt }, now)) return desk('celebrate', '병합 완료');
  if (current?.state === 'done' && current.completedAt && recent({ ts: current.completedAt }, now)) return desk('celebrate', '완료');
  if (current?.activatedAt && current.assigneeId === member.id && recent({ ts: current.activatedAt }, now, 9000)) return desk('receive', '업무 배정');
  if (member.status === 'working') {
    const poses = workPose[member.roleId] ?? ['type', 'inspect'];
    const phase = Math.floor((seconds + (hashId(member.id) % 7)) / 3.8) % poses.length;
    return desk(poses[phase], member.currentTask?.currentStep ?? member.currentWork?.label ?? '업무 중');
  }
  const rest = allocateRest(member, index, seconds, members);
  if (!rest) return desk('read', '자리에서 쉬는 중');
  const { rank, choice: [place, pose, label] } = rest;
  const point = place === 'lounge' && pose === 'nap'
    ? { x: (placeSlots.lounge[0].x + placeSlots.lounge[1].x) / 2, y: placeSlots.lounge[0].y }
    : slotPoint(place, rank);
  return { key: `${place}:${rank}`, place, pose, label, point };
}

export function intersectsRect(a: Point, b: Point, rect: Rectangle): boolean {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  if (Math.abs(a.x - b.x) < .01) return a.x > rect.left && a.x < rect.right && bottom > rect.top && top < rect.bottom;
  if (Math.abs(a.y - b.y) < .01) return a.y > rect.top && a.y < rect.bottom && right > rect.left && left < rect.right;
  return true;
}
const segmentDistance = (point: Point, a: Point, b: Point) => {
  const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared)) : 0;
  return Math.hypot(point.x - a.x - (b.x - a.x) * t, point.y - a.y - (b.y - a.y) * t);
};
const wallRestPoints = Object.values(placeSlots).flat().filter(point => point.y <= 175);
const clear = (a: Point, b: Point, from: Point, to: Point) => {
  if (furniture.some(rect => {
    const endpointInside = (point: Point) => point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
    return !endpointInside(from) && !endpointInside(to) && intersectsRect(a, b, rect);
  })) return false;
  return !stations.some(seat => Math.hypot(from.x - seat.x, from.y - seat.y) > 2 &&
    Math.hypot(to.x - seat.x, to.y - seat.y) > 2 && segmentDistance(seat, a, b) <
      (seat.side === 'far' ? 66 : a.y === b.y && a.y === 525 ? 80 : 32)) &&
    !(a.y === b.y && a.y <= 175 && wallRestPoints.some(slot =>
      Math.hypot(from.x - slot.x, from.y - slot.y) > 2 && Math.hypot(to.x - slot.x, to.y - slot.y) > 2 &&
      segmentDistance(slot, a, b) < 35));
};
function routeCore(from: Point, to: Point): Point[] {
  if (Math.hypot(to.x - from.x, to.y - from.y) < 2) return [];
  if ((from.x === to.x || from.y === to.y) && clear(from, to, from, to)) return [to];
  const rightward = to.x > from.x;
  const nearLane = rightward ? 575 : 525;
  const lane = (point: Point) => point.y >= 575 ? point.y : point.y > 350 ? nearLane : 195;
  const startLane = lane(from);
  const endLane = lane(to);
  const connectors = startLane === endLane ? [to.x, 225, 395, 575, 745, 925, 1080] : [225, 395, 575, 745, 925, 1080];
  const candidates = [
    [{ x: to.x, y: from.y }, to],
    [{ x: from.x, y: to.y }, to],
    ...[195, 525, 575, 585].map(y => [{ x: from.x, y }, { x: to.x, y }, to]),
    ...connectors.flatMap(x => [
    [{ x: from.x, y: startLane }, { x, y: startLane }, { x, y: endLane }, { x: to.x, y: endLane }, to],
    [{ x: from.x, y: startLane }, { x, y: startLane }, { x, y: to.y }, to],
    [{ x, y: from.y }, { x, y: endLane }, { x: to.x, y: endLane }, to],
    [{ x, y: from.y }, { x, y: to.y }, to],
    ]),
  ].map(points => points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y));
  const routes = candidates.filter(path => {
    let previous = from;
    for (const point of path) {
      if (!clear(previous, point, from, to)) return false;
      previous = point;
    }
    return true;
  });
  const routeCost = (path: Point[]) => {
    let previous = from;
    let extra = 0;
    for (const point of path) {
      if (previous.y === point.y && ((to.y >= 400 && point.y === 195) || (to.y <= 300 && (point.y === 525 || point.y === 575))))
        extra += Math.abs(point.x - previous.x) * 1.5;
      if (previous.y === point.y && ((rightward && point.y === 525) || (!rightward && point.y === 575)))
        extra += Math.abs(point.x - previous.x) * 5;
      previous = point;
    }
    return pathLength(from, path) + extra;
  };
  routes.sort((a, b) => routeCost(a) - routeCost(b));
  const route = routes[0] ?? [];
  const compact = route.filter((point, index) => index === route.length - 1 || !(index > 0 &&
    ((route[index - 1].x === point.x && point.x === route[index + 1].x) ||
     (route[index - 1].y === point.y && point.y === route[index + 1].y))));
  return compact;
}
const farGaps = [75, 225, 420, 575, 750, 925, 1080, 1175];
export function routeFor(from: Point, to: Point): Point[] {
  const compact = (path: Point[]) => path.filter((point, index) => index === 0 || point.x !== path[index - 1].x || point.y !== path[index - 1].y);
  const board = { x: 370, y: 205 };
  const inbox = placeSlots.inbox[0];
  const nearDestination = stations.find(seat => seat.side === 'near' &&
    Math.hypot(to.x-seat.x,to.y-seat.y)<2);
  if(Math.hypot(from.x-inbox.x,from.y-inbox.y)<2&&nearDestination)
    return [{x:1080,y:423},{x:1080,y:590},{x:to.x,y:590},to];
  if (Math.hypot(from.x - board.x, from.y - board.y) < 2 && Math.hypot(to.x - inbox.x, to.y - inbox.y) < 2)
    return [{ x: 395, y: 205 }, { x: 395, y: 590 }, { x: 1080, y: 590 }, { x: 1080, y: 423 }, to];
  if (Math.hypot(from.x - inbox.x, from.y - inbox.y) < 2 && Math.hypot(to.x - board.x, to.y - board.y) < 2)
    return [{ x: 1080, y: 423 }, { x: 1080, y: 590 }, { x: 395, y: 590 }, { x: 395, y: 205 }, to];
  const origin = stations.find(seat => seat.side === 'far' && Math.hypot(from.x - seat.x, from.y - seat.y) < 2);
  const destination = stations.find(seat => seat.side === 'far' && Math.hypot(to.x - seat.x, to.y - seat.y) < 2);
  if (origin && destination && (origin.x !== destination.x || origin.y !== destination.y)) {
    const exits = farGaps.map(x => ({ x, y: origin.y })).filter(exit => clear(from, exit, from, to));
    const entries = farGaps.map(x => ({ x, y: destination.y })).filter(entry => clear(entry, to, from, to));
    const routes = exits.flatMap(exit => entries.map(entry => {
      const middle = routeCore(exit, entry);
      return middle.length || Math.hypot(exit.x - entry.x, exit.y - entry.y) < 2 ? compact([exit, ...middle, to]) : [];
    })).filter(path => path.length);
    if (clear(from, to, from, to) && from.y === to.y) routes.push([to]);
    return routes.sort((a, b) => pathLength(from, a) - pathLength(from, b))[0] ?? [];
  }
  if (origin && (origin.x !== to.x || origin.y !== to.y)) {
    const routes = farGaps.map(x => ({ x, y: origin.y })).filter(exit => clear(from, exit, from, to))
      .map(exit => compact([exit, ...routeCore(exit, to)]))
      .filter(path => path.at(-1)?.x === to.x && path.at(-1)?.y === to.y);
    const direct = compact(routeCore(from, to));
    if (direct.length && direct[0].y === origin.y) routes.push(direct);
    return routes.sort((a, b) => pathLength(from, a) - pathLength(from, b))[0] ?? [];
  }
  if (destination && (destination.x !== from.x || destination.y !== from.y)) {
    const routes = farGaps.map(x => ({ x, y: destination.y })).filter(entry => clear(entry, to, from, to))
      .map(entry => compact([...routeCore(from, entry), to]))
      .filter(path => path.length > 1 && path.at(-1)?.x === to.x && path.at(-1)?.y === to.y);
    const direct = compact(routeCore(from, to));
    if (direct.length && direct.at(-2)?.y === destination.y) routes.push(direct);
    return routes.sort((a, b) => pathLength(from, a) - pathLength(from, b))[0] ?? [];
  }
  return compact(routeCore(from, to));
}

export function pathLength(from: Point, path: Point[]): number {
  let length = 0;
  let previous = from;
  for (const point of path) { length += Math.hypot(point.x - previous.x, point.y - previous.y); previous = point; }
  return length;
}

export interface Walker { point: Point; path: Point[]; segment: number; distance: number }
export type ActorPhase = 'seated' | 'queued' | 'rising' | 'walking' | 'lowering' | 'standing';
export interface ActorMotion { walker: Walker; key: string; phase: ActorPhase; phaseAt: number; departAt: number }
export function actorView(seat: Seat, point: Point, phase: ActorPhase, next: Point | undefined, place: Place): 'front' | 'back' | 'quarter' {
  if (phase === 'walking' && next) return Math.abs(next.y - point.y) > Math.abs(next.x - point.x)
    ? next.y < point.y ? 'back' : 'front' : 'quarter';
  if (place === 'window' && phase === 'standing' && point.y <= 175) return 'back';
  if (place === 'visit' && phase === 'standing') return 'quarter';
  const atSeat = Math.hypot(point.x - seat.x, point.y - seat.y) <= 2;
  return seat.side === 'near' && atSeat && (phase === 'seated' || phase === 'queued' || phase === 'rising' || phase === 'lowering') ? 'back' : 'front';
}
const deskWorkPoses = new Set<Pose>(['type', 'draw', 'write', 'diagram', 'check', 'check_wait', 'inspect', 'read', 'plan']);
export interface RenderTickInput {
  actor: ActorMotion;
  behaviour: Behaviour;
  seat: Seat;
  now: number;
  poseUntil: number;
  previousPose?: string;
  emergency: boolean;
  reduced: boolean;
  facing: number;
  faceTargetX?: number;
  obstacles?: Rectangle[];
  previousPlateSlot?: 'left' | 'middle' | 'right';
  plateHeight?: number;
}
export function renderActorTick({ actor, behaviour, seat, now, poseUntil, previousPose, emergency, reduced, facing, faceTargetX, obstacles = [], previousPlateSlot, plateHeight }: RenderTickInput) {
  const point = actor.walker.point;
  const next = actor.walker.path[actor.walker.segment];
  const walking = actor.phase === 'walking';
  const nearSeat = Math.hypot(point.x - seat.x, point.y - seat.y) <= 2;
  const atDestination = Math.hypot(point.x - behaviour.point.x, point.y - behaviour.point.y) <= 2;
  const atSofa = point.x >= 840 && point.x <= 1060 && point.y <= 200;
  const deskWorkAway = deskWorkPoses.has(behaviour.pose) && behaviour.place === 'desk' && !nearSeat;
  const pose: Pose | 'stand' | 'sit' = walking ? 'walk' : actor.phase === 'rising' || actor.phase === 'standing' && !!actor.walker.path.length ? 'stand' :
    actor.phase === 'lowering' ? 'sit' : actor.phase === 'queued' ? atSofa ? 'nap' : 'read' : !atDestination || deskWorkAway ? 'stand' : behaviour.pose;
  const view = actorView(seat, point, actor.phase, next, behaviour.place);
  let direction = facing;
  if (walking && next && Math.abs(next.x - point.x) > 1) direction = next.x < point.x ? -1 : 1;
  if (!walking && behaviour.place === 'visit' && faceTargetX !== undefined) direction = faceTargetX < point.x ? -1 : 1;
  const progress = Math.max(0, Math.min(1, (now - actor.phaseAt) / 450));
  const offset = seat.side === 'far' ? 37 : 35;
  const farDistance = Math.abs(point.x - seat.x);
  const seatOffset = behaviour.place === 'lounge' && atDestination && actor.phase === 'seated' ? -8 :
    atSofa && (actor.phase === 'queued' || actor.phase === 'rising') ? -8 * (actor.phase === 'rising' ? 1 - progress : 1) :
    behaviour.place === 'lounge' && actor.phase === 'lowering' ? -8 * progress :
    actor.phase === 'seated' || actor.phase === 'queued' ? offset : actor.phase === 'rising' ? offset * (1 - progress) :
    actor.phase === 'lowering' ? offset * progress : 0;
  const farLegsHidden = seat.side === 'far' && farDistance <= 43 && point.y >= seat.y - 35 && point.y <= 309;
  const seated = (actor.phase === 'seated' || actor.phase === 'queued' || actor.phase === 'lowering') && (nearSeat || atSofa || behaviour.place === 'lounge');
  const nextPoseUntil = previousPose && previousPose !== pose ? now + 350 : poseUntil;
  const ramp = emergency || reduced || walking ? 1 : Math.max(0, Math.min(1, (now - nextPoseUntil) / 350));
  const stride = walking ? Math.sin(actor.walker.distance / 18) : 0;
  const swing = Math.round(stride * 25 * ramp);
  const knee = Math.round(Math.max(0, stride) * 22 * ramp);
  const kneeBack = Math.round(Math.min(0, stride) * 22 * ramp);
  const atDesk = actor.phase === 'seated' && behaviour.place === 'desk' && nearSeat;
  const owner: Rectangle = { left: point.x - 27, right: point.x + 27, top: point.y - 100, bottom: point.y + 10 };
  const plate = atDesk ? { ...clearDeskLabel(labelPositions([seat], [seat.side])[0], obstacles, plateHeight ?? LABEL_HEIGHT), slot: 'middle' as const } :
    floorLabelPosition(point, owner, obstacles, previousPlateSlot, plateHeight,
      behaviour.place === 'visit' && behaviour.label === '검수 전달' ? 'middle' :
        behaviour.place === 'visit' && behaviour.label === '검수 확인' ? 'left' : undefined);
  if (behaviour.pose === 'nap' && atDestination) plate.y = point.y + 35;
  const width = atDesk ? LABEL_WIDTH : FLOOR_LABEL_WIDTH;
  const height = plateHeight ?? LABEL_HEIGHT;
  const hiddenArea = obstacles.reduce((area, obstacle) => area +
    Math.max(0, Math.min(plate.x + width, obstacle.right) - Math.max(plate.x, obstacle.left)) *
    Math.max(0, Math.min(plate.y + height, obstacle.bottom) - Math.max(plate.y, obstacle.top)), 0);
  return { pose, view, facing: direction, seatOffset, seated, farLegsHidden, ramp, poseUntil: nextPoseUntil, stride, swing, knee, kneeBack,
    feetY: point.y, layer: behaviour.place === 'lounge' && seated ? 'sofa' as const : 'depth' as const,
    plate: { ...plate, visible: hiddenArea < width * height * .5, placement: atDesk ? 'desk' as const : 'floor' as const }, deskWorkAway };
}
export function pruneActorStates<T>(states: Map<string, T>, visibleIds: Set<string>): void {
  for (const id of states.keys()) if (!visibleIds.has(id)) states.delete(id);
}
export function syncReviewStarts(starts: Map<string, number>, tasks: TaskView[], now: number): void {
  const active = new Set(tasks.filter(task => task.state === 'in_review').map(task => task.id));
  for (const id of starts.keys()) if (!active.has(id)) starts.delete(id);
  for (const id of active) if (!starts.has(id)) starts.set(id, now);
}
export class MotionCoordinator {
  private positions=new Map<string,{point:Point;next:Point|null}>();
  private lastNow=-Infinity;
  accept(id:string,from:Point,to:Point,next:Point|null,now:number):boolean {
    if(now<this.lastNow)this.positions.clear();
    this.lastNow=now;
    let allowed=true;
    for(const [otherId,other] of this.positions){
      if(otherId===id)continue;
      if(Math.abs(to.x-other.point.x)<40&&Math.abs(to.y-other.point.y)<96){allowed=false;break;}
      if(!next||!other.next)continue;
      const dx=next.x-from.x,dy=next.y-from.y,ex=other.next.x-other.point.x,ey=other.next.y-other.point.y;
      const divisor=dx*ey-dy*ex;
      if(Math.abs(divisor)<.001)continue;
      const ox=other.point.x-from.x,oy=other.point.y-from.y;
      const own=(ox*ey-oy*ex)/divisor,peer=(ox*dy-oy*dx)/divisor;
      if(own<0||own>1||peer<0||peer>1)continue;
      const cross={x:from.x+dx*own,y:from.y+dy*own};
      const ownDistance=Math.hypot(from.x-cross.x,from.y-cross.y);
      const peerDistance=Math.hypot(other.point.x-cross.x,other.point.y-cross.y);
      if(ownDistance<115&&peerDistance<115&&
        (ownDistance>peerDistance+5||Math.abs(ownDistance-peerDistance)<=5&&id>otherId)&&
        Math.hypot(to.x-cross.x,to.y-cross.y)<57){allowed=false;break;}
    }
    this.positions.set(id,{point:allowed?to:from,next});
    return allowed;
  }
}
export function updateActorMotion(actor: ActorMotion, target: Behaviour, now: number, dt: number, stopped: boolean, reduced: boolean, staggerMs = 0,
  coordination?:{id:string;traffic:MotionCoordinator}): ActorMotion {
  if (stopped) {coordination?.traffic.accept(coordination.id,actor.walker.point,actor.walker.point,null,now);return actor;}
  if (reduced) return { walker: { point: target.point, path: [], segment: 0, distance: actor.walker.distance }, key: target.key, phase: target.place === 'desk' || target.place === 'lounge' ? 'seated' : 'standing', phaseAt: now, departAt: now };
  let next = actor;
  if (target.key !== actor.key) {
    const path = routeFor(actor.walker.point, target.point);
    const atSeat = actor.phase === 'seated' || stations.some(seat => Math.hypot(actor.walker.point.x - seat.x, actor.walker.point.y - seat.y) < 2);
    next = { ...actor, key: target.key, walker: { ...actor.walker, path, segment: 0 },
      phase: path.length ? atSeat && actor.phase === 'seated' ? 'queued' : 'walking' :
        Math.hypot(actor.walker.point.x - target.point.x, actor.walker.point.y - target.point.y) < 2 &&
        (target.place === 'desk' || target.place === 'lounge') ? 'seated' : 'standing',
      phaseAt: now, departAt: Math.max(actor.departAt, now + (path.length && atSeat ? 450 : 0) +
        (actor.departAt > now ? 0 : staggerMs)) };
  }
  if (next.phase === 'queued' && now >= next.departAt - 450) next = { ...next, phase: 'rising', phaseAt: now };
  if (next.phase === 'rising' && now - next.phaseAt >= 450 && now >= next.departAt) next = { ...next, phase: 'walking', phaseAt: now };
  if (next.phase === 'walking' && now < next.departAt) next = { ...next, phase: 'standing', phaseAt: now };
  if (next.phase === 'standing' && next.walker.path.length && now >= next.departAt) next = { ...next, phase: 'walking', phaseAt: now };
  if (next.phase === 'walking' && actor.phase !== 'rising' && next.walker.path.length && now >= next.departAt) {
    const walker = advanceWalker(next.walker, actor.phase === 'walking' ? dt : Math.min(dt, .05),
      target.place === 'inbox' ? 112 : WALK_SPEED);
    next = { ...next, walker };
    if (!walker.path.length) next = { ...next, phase: target.place === 'desk' || target.place === 'lounge' ? 'lowering' : 'standing', phaseAt: now };
  }
  if (next.phase === 'lowering' && now - next.phaseAt >= 450) next = { ...next, phase: 'seated', phaseAt: now };
  if (next.phase === 'seated' && !next.walker.path.length && next.departAt > now) next = { ...next, departAt: 0 };
  if(coordination){const before=actor.walker.point,after=next.walker.point;
    if(!coordination.traffic.accept(coordination.id,before,after,next.walker.path[next.walker.segment]??null,now)&&
      Math.hypot(after.x-before.x,after.y-before.y)>.01)
      return {...next,walker:actor.walker,phase:'standing',phaseAt:now};
  }
  return next;
}
export const LABEL_WIDTH = 116;
export const LABEL_HEIGHT = 31;
export const FLOOR_LABEL_WIDTH = 88;
function clearDeskLabel(point: Point, obstacles: Rectangle[], height: number): Point {
  const cover = (x: number) => Math.max(0, ...obstacles.map(obstacle => {
    const area = Math.max(0, Math.min(x + LABEL_WIDTH, obstacle.right) - Math.max(x, obstacle.left)) *
      Math.max(0, Math.min(point.y + height, obstacle.bottom) - Math.max(point.y, obstacle.top));
    return area / Math.max(1, (obstacle.right - obstacle.left) * (obstacle.bottom - obstacle.top));
  }));
  const choices = [0, -16, 16, -32, 32].map(offset => ({ x: Math.max(4, Math.min(1196 - LABEL_WIDTH, point.x + offset)), offset }));
  const clear = choices.find(choice => cover(choice.x) <= .08);
  return { x: (clear ?? choices.sort((a, b) => cover(a.x) - cover(b.x))[0]).x, y: point.y };
}
export function depthOrder<T>(items: T[], baseY: (item: T) => number): T[] {
  return [...items].sort((a, b) => baseY(a) - baseY(b));
}
export function nearDeskWorkMotion(pose: Pose | 'stand' | 'sit', time: number, index: number) {
  if (!deskWorkPoses.has(pose as Pose) && pose !== 'point') return { left: 0, right: 0, head: 0 };
  const pulse = pose === 'point' ? Math.max(0, Math.sin((time + index * 137) * Math.PI * 2 / 2600)) : 1;
  const left = Math.round(Math.sin((time + index * 137) * Math.PI * 2 / 710) * 13 * pulse);
  const right = Math.round(Math.sin((time + index * 211 + 155) * Math.PI * 2 / 860) * 12 * pulse);
  return { left, right, head: Math.round(Math.sin((time + index * 241) * Math.PI * 2 / 1650) * 6) };
}
export function floorLabelPosition(point: Point, owner: Rectangle, obstacles: Rectangle[], previous: 'left' | 'middle' | 'right' = 'middle', height = LABEL_HEIGHT, onlySlot?: 'left' | 'middle' | 'right') {
  const slots = [
    { slot: 'left' as const, x: point.x - FLOOR_LABEL_WIDTH - 27 },
    { slot: 'middle' as const, x: point.x - FLOOR_LABEL_WIDTH / 2 },
    { slot: 'right' as const, x: point.x + 27 },
  ];
  const candidates = slots.filter(candidate => !onlySlot || candidate.slot === onlySlot)
    .flatMap(candidate => [0, 18, 32, 38, 50, 60, 76, 84, -48, -55, -60, -68, -76, -84].map(offset => ({ ...candidate, offset }))).map(candidate => {
    const x = Math.max(4, Math.min(1196 - FLOOR_LABEL_WIDTH, candidate.x));
    const y = Math.max(4, Math.min(610 - height, point.y + candidate.offset));
    const covered = obstacles.reduce((total, obstacle) => total +
      Math.max(0, Math.min(x + FLOOR_LABEL_WIDTH, obstacle.right) - Math.max(x, obstacle.left)) *
      Math.max(0, Math.min(y + height, obstacle.bottom) - Math.max(y, obstacle.top)), 0);
    const centre = { x: x + FLOOR_LABEL_WIDTH / 2, y: y + height / 2 };
    const rectDistance = (rect: Rectangle) => Math.hypot(Math.max(rect.left - centre.x, 0, centre.x - rect.right),
      Math.max(rect.top - centre.y, 0, centre.y - rect.bottom));
    const ownerDistance = rectDistance(owner);
    const ownerCover = Math.max(0, Math.min(x + FLOOR_LABEL_WIDTH, owner.right) - Math.max(x, owner.left)) *
      Math.max(0, Math.min(y + height, owner.bottom) - Math.max(y, owner.top));
    const closestOther = Math.min(Infinity, ...obstacles.map(rectDistance));
    const wrongOwner = closestOther + 1 < ownerDistance;
    const feetDistance = Math.hypot(centre.x - point.x, centre.y - point.y);
    return { slot: candidate.slot, x, y, score: (feetDistance > 100 ? 100000 : 0) + covered * 100 + ownerCover * 32 + (wrongOwner ? 10000 + (ownerDistance - closestOther) * 100 : 0) +
      Math.max(0, feetDistance - 53) * 100 + (candidate.slot === previous ? 0 : 60) + Math.abs(candidate.offset) * .2 +
      Math.abs(x + FLOOR_LABEL_WIDTH / 2 - point.x) * .1 };
  });
  return candidates.sort((a, b) => a.score - b.score)[0];
}
export function labelPositions(points: Point[], sides: Seat['side'][] = [], widths: number[] = []): Point[] {
  return points.map((point, index) => ({
    x: Math.max(4, Math.min(1196 - (widths[index] ?? LABEL_WIDTH), point.x - LABEL_WIDTH / 2)),
    y: sides[index] === 'near' ? point.y + 4 : point.y + 20,
  }));
}

export const WALK_SPEED = 108;
export function releaseSchedule(actors: Array<{ id: string; point: Point }>, now: number) {
  const aisles = [75, 420, 750, 1175];
  const distanceToAisle = (point: Point) => Math.min(...aisles.map(x => Math.abs(point.x - x)));
  const laneFirst = (point: Point) => Math.min(Math.abs(point.y - 240), Math.abs(point.y - 525)) < 2 ? 0 : 1;
  return [...actors].sort((a, b) => laneFirst(a.point) - laneFirst(b.point) ||
    distanceToAisle(a.point) - distanceToAisle(b.point) || a.point.y - b.point.y)
    .map((actor, rank) => ({ id: actor.id, departAt: now + 350 + rank * 375 }));
}
export function progressWalker(walker: Walker, dt: number, now: number, departAt: number, stopped: boolean): Walker {
  return stopped || now < departAt ? walker : advanceWalker(walker, dt);
}
export function advanceWalker(walker: Walker, dt: number, speed = WALK_SPEED): Walker {
  if (!walker.path.length) return walker;
  let budget = Math.max(0, Math.min(dt, .15)) * speed;
  let { point, segment, distance } = walker;
  while (budget > 0 && segment < walker.path.length) {
    const target = walker.path[segment];
    const length = Math.hypot(target.x - point.x, target.y - point.y);
    if (length <= budget) { point = target; budget -= length; distance += length; segment++; }
    else { point = { x: point.x + (target.x - point.x) * budget / length, y: point.y + (target.y - point.y) * budget / length }; distance += budget; budget = 0; }
  }
  return { point, segment: segment >= walker.path.length ? 0 : segment, path: segment >= walker.path.length ? [] : walker.path, distance };
}
