import { memo, useEffect, useMemo, useRef } from 'react';
import type { ActivityView, DirectiveView, MemberView, TaskView } from '../../../shared/views';
import { AI_KIND_LABEL, EFFORT_TIER_LABEL } from '../../../shared/labels';
import { PersonRig } from './Person';
import { deskItemsFor, hashId } from './characters';
import { resolveWorkLabel } from '../lib/displayText';
import { behaviourFor, depthOrder, labelPositions, MotionCoordinator, nearDeskWorkMotion, plateStateFor, pruneActorStates, releaseSchedule, renderActorTick, stations, syncReviewStarts, updateActorMotion, type ActorMotion, type Behaviour, type Rectangle, type Seat } from './motion';

const ink = '#394852';
const trim = '#718892';
const surface = '#e9eef0';
const red = '#ad5947';
export const seatOffsetFor = (seat: Seat) => seat.side === 'far' ? 37 : 35;
export const rigOrigin = (seat: Seat) => ({ x: seat.x - 40, y: seat.y - 106 + seatOffsetFor(seat) });
export const chairDepthKey = (seat: Seat) => seat.side === 'far' ? seat.y - 10 : seat.y + 26;
export const deskDepthKey = (seat: Seat) => (seat.side === 'far' ? 309 : 410) + (seat.side === 'far' ? 62 : 42);
export const actorDepthKey = (seat: Seat, feetY: number) => feetY;
export const walkingDepthKey = (feetY: number) => Math.max(feetY, 525);
export const screenPanels = [[90, 190], [260, 355], [440, 540], [610, 705], [790, 890], [960, 1055]] as const;
export const boardTitlesFor = (directives: DirectiveView[], tasks: TaskView[]) => directives
  .filter(directive => directive.state !== 'closed')
  .map(directive => `${directive.title}|${tasks.filter(task => task.directiveId === directive.id)
    .flatMap(task => task.steps).find(step => !step.done)?.title ?? ''}`);
const Room = memo(function Room({ titles, unread, time, printing = false }: { titles: string[]; unread: number; time: string; printing?: boolean }) {
  const [hour, minute] = time.split(':').map(Number);
  const minuteAngle = minute * 6;
  const hourAngle = ((hour % 12) + minute / 60) * 30;
  return <g strokeLinejoin="round" strokeLinecap="round">
    <rect width="1200" height="660" fill="#b3c0c6" />
    <rect width="1200" height="174" fill="#dce4e9" />
    <path d="M0 170 H1200 M0 175 H1200" stroke={ink} strokeWidth="2" />
    <defs><pattern id="office-carpet" width="96" height="96" patternUnits="userSpaceOnUse"><rect width="96" height="96" fill="#aebdc6" /><path d="M1 1 h47 v47 H1z M49 49 h46 v46 H49z" fill="#b5c2c8" /><path d="M48 0 v96 M0 48 h96" stroke="#9eadb5" strokeWidth=".8" /></pattern></defs>
    <rect y="175" width="1200" height="485" fill="url(#office-carpet)" />
    <rect x="688" y="176" width="140" height="100" rx="5" fill="#b5c5cf" stroke="#657d81" strokeWidth="3" />
    <rect x="695" y="183" width="126" height="86" rx="3" fill="#bccbd4" stroke="#7894a3" strokeWidth="1.5" />
    <path d="M30 229 H315 L410 370 H145Z" fill="#e7e9ea" opacity=".74" />
    <path d="M30 229 H180 L265 350 H120Z" fill="#f1f2f2" opacity=".6" />
    <path d="M178 187 L364 415 H405 L251 187Z" fill="#fff6d8" opacity=".25" />
    {screenPanels.map(([left, right]) => <g key={`screen-${left}`}><rect x={left} y="365" width={right - left} height="27" rx="4" fill="#477c8e" stroke={ink} strokeWidth="2" /><path d={`M${left + 6} 372 h${right - left - 12} m-${right - left - 12} 7 h${right - left - 12} m-${right - left - 12} 7 h${right - left - 12}`} stroke="#a8c0c1" strokeWidth="1.3" /></g>)}
    <rect x="27" y="22" width="298" height="118" fill="#f5f8f8" stroke={ink} strokeWidth="3" />
    {[0, 1, 2].map(i => <g key={i}><rect x={38 + i * 92} y="32" width="84" height="108" fill="#96b8c9" stroke={ink} strokeWidth="2" /><path d={`M${80 + i * 92} 32 v108 M${38 + i * 92} 73 h84 M${38 + i * 92} 119 h84`} stroke="#dbeaf0" strokeWidth="4" /></g>)}
    <path d="M28 145 h298" stroke={ink} strokeWidth="5" />
    <rect x="331" y="95" width="52" height="66" rx="2" fill="#986e58" stroke={ink} /><path d="M338 109 h27 m-27 10 h33 m-33 11 h24" stroke="#d7e9ef" strokeWidth="3" /><path d="M338 102 v-8 m20 8 v-8" stroke="#bed2da" strokeWidth="2" />
    <g><title>{time}</title><circle cx="363" cy="65" r="25" fill="#f2eee2" stroke={ink} strokeWidth="3" /><circle cx="363" cy="65" r="2" fill={ink} /><path d="M363 65 V49" transform={`rotate(${minuteAngle} 363 65)`} stroke={ink} strokeWidth="2" /><path d="M363 65 V53" transform={`rotate(${hourAngle} 363 65)`} stroke={ink} strokeWidth="3" /></g>
    <rect x="399" y="25" width="281" height="135" fill="#eaf1f2" stroke={ink} strokeWidth="3" />
    <text x="418" y="50" className="board-title">이번 주 할 일</text>
    <path d="M419 61 h241" stroke="#c2cdd1" strokeWidth="2" />
    {!titles.length && <text id="board-empty-copy" x="432" y="100" fontSize="16" fill="#506169">진행 중인 지시 없음</text>}
    {titles.slice(0, 1).map((entry, i) => { const [title, step] = entry.split('|'); return <g key={`${entry}:${i}`}><rect x="422" y="74" width="235" height="70" fill="#d7e9ef" stroke="#9aadb5" /><text id="board-title-copy" x="432" y="96" fontSize="16" fill={ink}>{title.length > 15 ? `${title.slice(0, 14).replace(/\s+\S*$/, '')}…` : title}</text><text id="board-step-copy" x="432" y="126" fontSize="16" fill={ink}>{step ? `지금: ${step}` : '단계 준비 중'}</text></g>; })}
    <g><rect x="683" y="30" width="130" height="84" fill="#9a7966" stroke={ink} strokeWidth="2" /><rect x="690" y="37" width="116" height="70" fill="#ae927e" />{[0, 1, 2].map(i => <g key={i}><rect x={695 + i * 34} y={44 + i * 7} width="29" height="31" fill={['#e9b770', '#b7d4d2', '#dfb69f'][i]} transform={`rotate(${i * 5 - 5} ${709 + i * 34} ${59 + i * 7})`} /><path d={`M${700 + i * 34} ${53 + i * 7} h18 m-18 6 h15`} stroke="#56636a" /></g>)}</g>
    <g><path d="M711 145 h99 v8 h-99z" fill="#6e5848" stroke={ink} /><path d="M718 118 v27 m82-27 v27" stroke={ink} strokeWidth="3" />{[0, 1, 2, 3, 4, 5].map(i => <rect key={i} x={721 + i * 14} y={124 + i % 2 * 5} width="10" height={21 - i % 2 * 5} fill={['#496a7a', '#b0795e', '#6c815b'][i % 3]} stroke="#394852" />)}</g>
    <path d="M843 85 h225 q14 0 14 14 v62 H829 V99 q0-14 14-14Z" fill="#4a7180" stroke={ink} strokeWidth="3" />
    <path d="M840 143 h231 v37 H840z M849 180 v18 m213-18 v18" fill="#31556c" stroke={ink} strokeWidth="2" />
    <path d="M916 91 v52 M994 91 v52" stroke="#8db1be" strokeWidth="3" />
    <ellipse cx="754" cy="162" rx="42" ry="16" fill="#b88761" stroke={ink} strokeWidth="2" /><path d="M721 173 v25 m66-25 v25" stroke={ink} strokeWidth="3" />
    <g fill="#51778a" stroke={ink} strokeWidth="2"><path d="M695 144 q-4-15 9-15 h15 v8 h-15 v35 h21 v7 h-30z M813 144 q4-15-9-15 h-15 v8 h15 v35 h-21 v7 h30z" /><path d="M700 179 v19 m104-19 v19" /></g>
    <rect x="1074" y="34" width="103" height="150" fill="#c3ced2" stroke={ink} strokeWidth="2" />
    <rect x="1089" y="49" width="73" height="94" rx="4" fill="#4d6671" stroke={ink} strokeWidth="2" />
    <rect x="1099" y="64" width="53" height="42" fill="#a9c3cc" /><path d="M1099 117 h53" stroke="#dbe6e9" strokeWidth="3" />
    <path d="M1112 144 h28 v14 q-14 10-28 0z" fill="#f1f4f5" stroke={ink} strokeWidth="2" />
    <path d="M1081 184 h96 v14 h-96z" fill="#596f76" stroke={ink} strokeWidth="2" />
    <g transform="translate(0 195)"><path d="M42 290 l-14 55 h41 l-13-55Z" fill="#718b96" stroke={ink} strokeWidth="2" />
    <path d="M48 296 q-35-48 0-65 q-1 31 0 65 M49 296 q0-60 31-67 q-2 42-31 67 M49 296 q-20-35-38-22 q4 22 38 22 M50 295 q10-42 43-32 q-9 27-43 32 M50 295 q-9-61 10-70 q11 33-10 70" fill="#356b48" stroke="#254f36" strokeWidth="2" /></g>
    <g transform="translate(1088 342)"><path d="M3 15 h69 v49 H3z" fill="#9aadb5" stroke={ink} strokeWidth="2" /><path d="M12 19 h51 v26 H12z M15 15 h45 v26 H15z M18 11 h39 v26 H18z" fill="#f1f3ed" stroke={ink} strokeWidth="1.3" /><path d="M22 20 h27 m-27 6 h31 m-31 6 h22" stroke="#9dabb0" strokeWidth="1.3" /><path d="M3 44 h15 l6 8 h28 l6-8 h14 v20 H3z" fill="#b8c7ca" stroke={ink} strokeWidth="2" /><text x="59" y="59" fontSize="16" fill={ink} textAnchor="end">{String(unread).padStart(2, '0')}</text></g>
    <g transform="translate(1090 590)"><rect y="-45" width="80" height="60" fill="#e9eff1" stroke={ink} strokeWidth="2" />{printing && <path d="M20 -69 h40 v35 H20z M25 -60 h30 m-30 7 h25 m-25 7 h29" fill="#f7f9f9" stroke={ink} strokeWidth="1.5" />}<path d="M14-52 h52 v18 H14z" fill="#f7f9f9" stroke={ink} /><path d="M13 4 h53" stroke={ink} strokeWidth="2" /></g>
    <path d="M0 653 H1200" stroke={ink} strokeWidth="3" />
  </g>;
}, (before, after) => before.time === after.time && before.unread === after.unread && before.printing === after.printing && before.titles.join('|') === after.titles.join('|'));

const Desk = memo(function Desk({ seat, index, member }: { seat: Seat; index: number; member?: MemberView }) {
  const seed = hashId(member?.id ?? `empty-${index}`);
  const items = deskItemsFor(member?.id ?? `empty-${index}`, index);
  const top = seat.side === 'far' ? 309 : 410;
  const role = member?.roleId ?? 'empty';
  return <g data-desk={`${seat.x}:${seat.y}`} data-base-y={deskDepthKey(seat)} pointerEvents="none">
    <rect x={seat.x - 50} y={top} width="100" height="42" fill={surface} stroke={ink} strokeWidth="2" />
    {index % 2 === 0 && <ellipse cx={seat.x + 42} cy={top + 14} rx="15" ry="6" fill="#f4db9c" opacity=".72" />}
    <path d={`M${seat.x - 46} ${top + 42} v20 M${seat.x + 46} ${top + 42} v20`} stroke={ink} strokeWidth="4" />
    <path d={`M${seat.x - 50} ${top + 23} h100`} stroke="#9fb2ba" strokeWidth="2" />
    {seat.side === 'far' ? <>
      <rect x={seat.x - 32} y={top - 29} width="64" height="54" rx="3" fill="#416f80" stroke={ink} strokeWidth="2" />
      <path d={`M${seat.x} ${top + 25} v7 m-16 0 h32`} stroke={ink} strokeWidth="2" />
      {index % 4 === 1 && <rect x={seat.x + 34} y={top - 22} width="16" height="35" rx="2" fill="#4b626d" stroke={ink} strokeWidth="2" />}
    </> : <g transform={`translate(${seat.x + 5} 0) scale(.55 1) translate(${-seat.x} 0)`}>
      <rect x={seat.x - 39} y={top - 11} width="78" height="37" rx="3" fill="#354e59" stroke={ink} strokeWidth="2" />
      <rect x={seat.x - 35} y={top - 7} width="70" height="29" fill="#deebef" />
      {role === 'developer' ? <g fill="none" strokeWidth="2"><path d={`M${seat.x - 27} ${top + 3} h19 m-19 6 h12 m-8 6 h21 M${seat.x + 5} ${top + 3} h15 m-15 6 h23 m-23 6 h16`} stroke="#477f91" /><path d={`M${seat.x - 27} ${top + 19} h35 M${seat.x + 14} ${top + 19} h14`} stroke={trim} /></g> :
       role === 'ui_designer' ? <g><circle cx={seat.x - 22} cy={top + 7} r="5" fill={red} /><circle cx={seat.x - 7} cy={top + 7} r="5" fill="#7f939b" /><circle cx={seat.x + 8} cy={top + 7} r="5" fill="#c1a388" /><path d={`M${seat.x - 27} ${top + 17} h50`} stroke={trim} strokeWidth="2" /></g> :
       role === 'architect' ? <g fill="none" stroke={trim} strokeWidth="2"><rect x={seat.x - 28} y={top + 2} width="13" height="11" /><circle cx={seat.x + 8} cy={top + 8} r="7" /><path d={`M${seat.x - 15} ${top + 8} h16 M${seat.x + 15} ${top + 8} h13`} /></g> :
       role === 'qa' ? <g fill="none" strokeWidth="2"><path d={`M${seat.x - 25} ${top + 4} l3 3 5-6 m-8 12 l3 3 5-6`} stroke={red} /><path d={`M${seat.x - 12} ${top + 5} h34 m-34 9 h29`} stroke={trim} /></g> :
       role === 'docs' ? <g fill="none" stroke={trim} strokeWidth="2"><path d={`M${seat.x - 24} ${top + 3} h48 m-48 6 h40 m-40 6 h45`} /></g> :
       <g fill="none" stroke={trim} strokeWidth="2"><rect x={seat.x - 28} y={top + 3} width="17" height="15" /><rect x={seat.x - 5} y={top + 3} width="17" height="15" /><rect x={seat.x + 18} y={top + 3} width="11" height="15" /></g>}
    </g>}
    {items.filter((_, itemIndex) => index % 4 !== 1 || itemIndex === 0).map((item, itemIndex) => <g key={`${item}:${itemIndex}`} transform={`translate(${seat.x + (itemIndex ? 48 : -48)} ${top + 11})`} stroke={ink} strokeWidth="1.3">
      {item === 'mug' && <><path d="M-8-5 h15 l-2 14 H-6z" fill={['#a76d62', '#7b96a2', '#b68759'][seed % 3]} /><path d="M7-3 q11 0 5 8 H7" fill="none" /></>}
      {item === 'notebook' && <><rect x="-10" y="-7" width="20" height="16" fill="#d5e8ec" /><path d="M-6-2 h12 m-12 5 h8" stroke={trim} /></>}
      {item === 'plant' && <><path d="M-8 2 h16 l-3 9 H-5z" fill="#b8795c" /><path d="M0 3 q-15-12-7-17 q9 4 7 17 M0 3 q3-20 10-16 q5 9-10 16" fill="#43774e" /></>}
      {item === 'figurine' && <><path d="M-9 9 h18 v3 H-9z" fill="#677b7a" /><path d="M-7 7 v-10 l3-5 4 4 4-4 3 5 V7z" fill="#8db2be" /><circle cx="-3" cy="1" r="1" fill={ink} stroke="none" /><circle cx="3" cy="1" r="1" fill={ink} stroke="none" /></>}
      {item === 'headphones' && <><path d="M-8 6 v-8 q0-9 8-9 q8 0 8 9 v8" fill="none" stroke="#3f555f" strokeWidth="3" /><path d="M-10 1 h4 v8 h-4z M6 1 h4 v8 H6z" fill="#617e8a" /></>}
      {item === 'photo' && <><path d="M-8 9 l1-15 17 2-1 15z" fill="#bd8c65" /><path d="M-5 5 v-8 l12 1 v8z" fill="#e1dfd0" /><circle cx="1" cy="0" r="3" fill="#9c725c" stroke="none" /><path d="M-2 5 q3-3 6 0" fill="#527b73" /><path d="M2 11 l4 3" fill="none" /></>}
      {item === 'pen' && <><path d="M-11 7 h22 l-3 5 H-8z" fill="#93a9ad" /><path d="M-5 6 l5-15 M1 7 l6-13" stroke="#396b80" strokeWidth="2.5" /><path d="M0-9 l1-3 M7-6 l1-3" stroke="#b7754c" strokeWidth="2" /></>}
    </g>)}
    <text x={seat.x - 57} y={top + 38} className="desk-number">{String(index + 1).padStart(2, '0')}</text>
    {index % 2 === 0 && <g><ellipse cx={seat.x + 40} cy={top + 11} rx="8" ry="3" fill="#576a73" /><path d={`M${seat.x + 40} ${top + 8} v-18 l11-11`} fill="none" stroke="#566970" strokeWidth="3" /><path d={`M${seat.x + 48} ${top - 25} h19 l-4 10 h-17z`} fill="#b67d5b" stroke={ink} strokeWidth="1.5" /><circle cx={seat.x + 55} cy={top - 16} r="2" fill="#f8ddb5" stroke="none" /></g>}
  </g>;
}, (before, after) => before.index === after.index && before.member?.id === after.member?.id && before.member?.roleId === after.member?.roleId);

const LoungeFront = memo(function LoungeFront() {
  return <g pointerEvents="none"><path d="M840 158 H1071 V173 H840Z" fill="#31556c" stroke={ink} strokeWidth="2" />
    <path className="office-sofa-exit-front" d="M840 143 H1071 V180 H840Z" fill="#31556c" stroke={ink} strokeWidth="2" display="none" /></g>;
});

function Chair({ seat, moving }: { seat: Seat; moving: boolean }) {
  const offset = moving ? (seat.side === 'far' ? -13 : 13) : 0;
  const y = seat.side === 'far' ? seat.y - 4 : seat.y - 10;
  return <g data-chair={`${seat.x}:${seat.y}`} data-base-y={chairDepthKey(seat)} pointerEvents="none" transform={`translate(${seat.x} ${y + offset})`} stroke={ink} strokeWidth="2" fill={['#48788a', '#9b6853', '#6d8050'][seat.pod % 3]}>
    <path d={seat.side === 'far' ? 'M-17 -13 q0-10 10-10 h14 q10 0 10 10 v28 h-34z' : 'M-20 -1 q0-9 9-9 h22 q9 0 9 9 v16 h-40z'} />
    <path d={seat.side === 'far' ? 'M-18 8 q18 12 36 0 v16 h-36z' : 'M-26 8 q26 12 52 0 v16 h-52z'} fill="#78919a" />
    <path d="M0 24 v12 m-16 0 h32" fill="none" strokeWidth="3" />
  </g>;
}

const ActorFigure = memo(function ActorFigure({ member, index, nodes, onMember }: { member: MemberView; index: number; nodes: Map<string, SVGGElement>; onMember: (id: string) => void }) {
  const seat = stations[index];
  return <g ref={node => { if (node) {
    nodes.set(member.id, node);
    if (node.dataset.hitBound !== 'true') {
      node.classList.add('entering');
      window.setTimeout(() => node.classList.remove('entering'), 500);
      node.addEventListener('click', () => onMember(member.id));
      node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') onMember(member.id); });
      node.dataset.hitBound = 'true';
    }
  } else nodes.delete(member.id); }}
    className={`office-actor role-${member.roleId}`} style={{ transform: `translate(${rigOrigin(seat).x}px, ${rigOrigin(seat).y}px)` }}
    data-pose="type" data-view={seat.side === 'near' ? 'back' : 'front'} data-seated="true" data-feet-y={seat.y}
    data-member-id={member.id} data-seat-x={seat.x} data-seat-y={seat.y} tabIndex={0} role="button" aria-label={`${member.name} 열기`}>
    <g className="actor-direction"><PersonRig member={member} /></g>
    <rect className="actor-hit" x="9" y="1" width="62" height="107" fill="transparent" />
    <g className="actor-signal"><text x="65" y="8">{member.status === 'error' ? '!' : member.status === 'awaiting_answer' ? '?' : ''}</text></g>
    <g className="actor-progress"><rect x="4" y="-6" width="70" height="8" fill="#e5ecef" stroke={ink} /><rect className="actor-progress-fill" x="6" y="-4" width="4" height="4" fill={red} /></g>
  </g>;
}, (before, after) => before.member.id === after.member.id && before.member.roleId === after.member.roleId && before.member.isMain === after.member.isMain && before.index === after.index);

export function OfficeIntro() {
  const samples = [0, 3, 6, 10].map((index, i) => ({ id: `intro-${i}`, roleId: ['producer', 'ui_designer', 'developer', 'docs'][i], isMain: false, seat: stations[index] }));
  return <svg className="office-intro" viewBox="0 0 1200 660" aria-hidden="true"><Room titles={['작업 계획']} unread={1} time="10:24" />{stations.slice(6).map((seat, index) => <Desk key={index + 6} seat={seat} index={index + 6} />)}{stations.slice(0, 6).map((seat, index) => <Chair key={`chair:${index}`} seat={seat} moving={false} />)}{samples.map(person => <g className="office-actor" key={person.id} transform={`translate(${rigOrigin(person.seat).x} ${rigOrigin(person.seat).y})`} data-pose="type" data-view={person.seat.side === 'near' ? 'back' : 'front'} data-seated="true"><PersonRig member={person} /></g>)}{stations.slice(6).map((seat, index) => <Chair key={`chair:${index + 6}`} seat={seat} moving={false} />)}<LoungeFront />{stations.slice(0, 6).map((seat, index) => <Desk key={index} seat={seat} index={index} />)}</svg>;
}

interface ActorState extends ActorMotion { behaviour: Behaviour; displayBehaviour: Behaviour; facing: number; poseUntil: number; lastStyle: string }
const emptyTasks: TaskView[] = [];
const emptyDirectives: DirectiveView[] = [];
const emptyActivity: ActivityView[] = [];
const setAttribute = (node: Element, name: string, value: string) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const setProperty = (node: HTMLElement | SVGElement, name: string, value: string) => { if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value); };

export function Office({ members, tasks = emptyTasks, directives = emptyDirectives, activity = emptyActivity, emergency = false, unread = 0, onMember }: {
  members: MemberView[]; tasks?: TaskView[]; directives?: DirectiveView[]; activity?: ActivityView[]; emergency?: boolean; unread?: number; onMember: (id: string) => void;
}) {
  const visible = members.slice(0, 12);
  const seats = useMemo(() => new Map(visible.map((member, index) => [member.id, stations[index]])), [members]);
  const data = useRef({ visible, seats, tasks, directives, activity, emergency });
  data.current = { visible, seats, tasks, directives, activity, emergency };
  const scene = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, SVGGElement>());
  const plates = useRef(new Map<string, HTMLButtonElement>());
  const actors = useRef(new Map<string, ActorState>());
  const traffic = useRef(new MotionCoordinator());
  const reviewStarted = useRef(new Map<string, number>());
  const handoffReady = useRef(new Map<string, number>());
  const started = useRef(Date.now());
  const lastEmergency = useRef(false);
  const titles = boardTitlesFor(directives, tasks);
  const clock = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const printing = activity.some(item => item.kind === 'report' && Date.now() - Date.parse(item.ts) < 7000);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motion.matches, inView = true, frame = 0, last = 0, lastDraw = 0;
    let sceneWidth = scene.current?.clientWidth ?? 1200;
    let sceneHeight = scene.current?.clientHeight ?? 610;
    const resize = new ResizeObserver(() => { sceneWidth = scene.current?.clientWidth ?? 1200; sceneHeight = scene.current?.clientHeight ?? 610; });
    if (scene.current) resize.observe(scene.current);
    const tick = (time: number) => {
      if (document.hidden || !inView) { frame = 0; return; }
      frame = requestAnimationFrame(tick);
      const drawInterval = lastEmergency.current !== data.current.emergency ? 1 : reduced || data.current.emergency ? 500 :
        [...actors.current.values()].some(actor => actor.phase === 'walking' || actor.phase === 'rising' || actor.phase === 'lowering') ? 50 : 200;
      if (time - lastDraw < drawInterval) return;
      const dt = last ? (time - last) / 1000 : 0;
      last = time; lastDraw = lastDraw ? lastDraw + drawInterval * Math.floor((time - lastDraw) / drawInterval) : time;
      const now = Date.now();
      const current = data.current;
      syncReviewStarts(reviewStarted.current, current.tasks, now);
      if (lastEmergency.current && !current.emergency) {
        releaseSchedule([...actors.current.entries()].map(([id, actor]) => ({ id, point: actor.walker.point })), now)
          .forEach(({ id, departAt }) => { const actor = actors.current.get(id); if (actor) actor.departAt = departAt; });
      }
      lastEmergency.current = current.emergency;
      const visibleIds = new Set(current.visible.map(member => member.id));
      pruneActorStates(actors.current, visibleIds);
      current.visible.forEach((member, index) => {
        const seat = stations[index];
        const node = nodes.current.get(member.id);
        if (!node) return;
        const reviewTask = current.tasks.find(task => task.state === 'in_review' && (task.assigneeId === member.id || task.reviewerId === member.id));
        const behaviour = behaviourFor({ member, seat, index, now, seconds: (now - started.current) / 1000,
          reviewSeconds: reviewTask ? (now - (reviewStarted.current.get(reviewTask.id) ?? now)) / 1000 : undefined,
          tasks: current.tasks, directives: current.directives, activity: current.activity, seats: current.seats, members: current.visible, emergency: current.emergency });
        const previous = actors.current.get(member.id);
        const actor: ActorState = previous ?? { walker: { point: behaviour.point, path: [], segment: 0, distance: 0 }, key: behaviour.key,
          phase: behaviour.place === 'desk' || behaviour.place === 'lounge' ? 'seated' : 'standing', phaseAt: now,
          behaviour, displayBehaviour: behaviour, facing: 1, departAt: 0, poseUntil: 0, lastStyle: '' };
        const motionState = updateActorMotion(actor, behaviour, now, dt, current.emergency, reduced,
          member.status === 'idle' && behaviour.place !== 'visit' ? index * 450 : 0,
          {id:member.id,traffic:traffic.current});
        Object.assign(actor, motionState);
        actor.behaviour = behaviour;
        if (Math.hypot(actor.walker.point.x - behaviour.point.x, actor.walker.point.y - behaviour.point.y) <= 2)
          actor.displayBehaviour = behaviour;
        if (!previous) actors.current.set(member.id, actor);
        const progress = Math.max(0, Math.min(1, (now - actor.phaseAt) / 450));
        const chairTravel = actor.phase === 'rising' ? progress : actor.phase === 'lowering' ? 1 - progress :
          actor.phase === 'walking' || actor.phase === 'standing' ? 1 : 0;
        const chair = scene.current?.querySelector<SVGGElement>(`[data-chair="${seat.x}:${seat.y}"]`);
        if (chair) setAttribute(chair, 'transform', `translate(${seat.x} ${seat.y + (seat.side === 'far' ? -4 : -10) + (seat.side === 'far' ? -13 : 13) * chairTravel})`);
        const p = actor.walker.point;
        const walking = actor.phase === 'walking';
        const otherSeat = reviewTask && current.seats.get(member.id === reviewTask.assigneeId ? reviewTask.reviewerId ?? '' : reviewTask.assigneeId);
        const render = renderActorTick({ actor, behaviour, seat, now, poseUntil: actor.poseUntil, previousPose: node.getAttribute('data-pose') ?? undefined,
          emergency: current.emergency, reduced, facing: actor.facing, faceTargetX: otherSeat?.x });
        const pose = current.emergency ? (node.getAttribute('data-pose') as typeof behaviour.pose ?? 'pause') : render.pose;
        actor.facing = render.facing;
        actor.poseUntil = render.poseUntil;
        setAttribute(node, 'data-feet-y', actorDepthKey(seat, p.y).toFixed(2));
        if (walking) setAttribute(node, 'data-base-y', walkingDepthKey(p.y).toFixed(2));
        else node.removeAttribute('data-base-y');
        const priorSeatOffset = Number(node.dataset.seatOffset);
        const seatOffset = node.dataset.seatOffset === undefined ? render.seatOffset :
          Math.max(priorSeatOffset - 3.5, Math.min(priorSeatOffset + 3.5, render.seatOffset));
        node.dataset.seatOffset = seatOffset.toFixed(2);
        if (current.emergency || reduced) {
          node.classList.remove('pose-changing');
          delete node.dataset.pendingPose;
          setAttribute(node, 'data-pose', pose);
        } else if (node.getAttribute('data-pose') !== pose && node.dataset.pendingPose !== pose) {
          node.classList.add('pose-changing');
          node.dataset.pendingPose = pose;
          requestAnimationFrame(() => {
            if (node.isConnected && node.dataset.pendingPose === pose) {
              setAttribute(node, 'data-pose', pose);
              delete node.dataset.pendingPose;
            }
          });
        } else if (node.getAttribute('data-pose') === pose) node.classList.toggle('pose-changing', now < actor.poseUntil);
        setAttribute(node, 'data-seated', String(render.seated));
        setAttribute(node, 'data-far-seat', String(render.farLegsHidden));
        setAttribute(node, 'data-view', render.view);
        const signal = node.querySelector<SVGTextElement>('.actor-signal text');
        const symbol = actor.displayBehaviour.pose === 'nap' ? 'z' : member.status === 'error' ? '!' : member.status === 'awaiting_answer' ? '?' : '';
        if (signal && signal.textContent !== symbol) signal.textContent = symbol;
        const direction = node.querySelector<SVGGElement>('.actor-direction');
        if (direction) setAttribute(direction, 'transform', actor.facing < 0 ? 'translate(80 0) scale(-1 1)' : '');
        const swing = render.swing;
        const knee = render.knee;
        const kneeBack = render.kneeBack;
        const wave = (period: number, amplitude: number) => Math.round(Math.sin((time + index * 193) * Math.PI * 2 / period) * amplitude);
        let left = 0, right = 0, head = 0, thumb = 0;
        if (walking) { left = Math.round(Math.sin(actor.walker.distance / 18) * 15); right = -left; }
        else if (!reduced && !current.emergency) {
          switch (pose) {
            case 'type': left = Math.floor(time / 320 + index) % 2 ? 6 : -6; right = -left; break;
            case 'draw': right = wave(780, 13); break;
            case 'write': right = wave(920, 9); break;
            case 'plan': right = wave(1800, 22); break;
            case 'diagram': right = wave(1450, 28); break;
            case 'check': right = wave(1150, 14); break;
            case 'inspect': right = wave(2100, 20); break;
            case 'read': right = wave(2200, 16); break;
            case 'point': right = wave(1100, 14); break;
            case 'submit': right = wave(950, 15); break;
            case 'receive': left = wave(780, 14); head = wave(1100, 6); break;
            case 'drink': right = -Math.round(Math.max(0, Math.sin(time * Math.PI * 2 / 3200)) * 58); break;
            case 'phone': thumb = Math.round((Math.sin(time * Math.PI * 2 / 1000) + 1) * 2.5); break;
            case 'water': right = wave(2600, 30); break;
            case 'stretch': left = wave(3500, 20); right = -left; break;
            case 'chat': right = wave(1800, index % 2 ? -23 : 23); break;
            case 'error': head = wave(2400, 5); break;
            case 'wait': right = wave(2300, 8); break;
            case 'sigh': head = wave(2800, 8); break;
            case 'conflict': head = wave(600, 10); break;
            case 'celebrate': left = wave(1700, 17); right = -left; break;
            case 'nap': head = wave(3000, 3); break;
            case 'window': head = wave(4200, 3); break;
          }
        }
        if (!walking && !reduced && !current.emergency && seat.side === 'near' &&
          ['type', 'draw', 'write', 'diagram', 'check', 'check_wait', 'inspect', 'read', 'plan'].includes(pose)) {
          ({ left, right, head } = nearDeskWorkMotion(pose, time, index));
        }
        const motionRamp = render.ramp;
        left = Math.round(left * motionRamp);
        right = Math.round(right * motionRamp);
        head = Math.round(head * motionRamp);
        const elbow = pose === 'type' ? Math.round(left * .65) : 0;
        const stride = render.stride;
        const liftLeft = walking ? -Math.round(Math.max(0, stride) * 10) : 0;
        const liftRight = walking ? -Math.round(Math.max(0, -stride) * 10) : 0;
        const style = `transform:translate(${Math.round(p.x - 40)}px,${Math.round(p.y - 106 + seatOffset)}px);--swing:${swing}deg;--swing-back:${-swing}deg;--knee:${knee}deg;--knee-back:${kneeBack}deg;--lift-left:${liftLeft}px;--lift-right:${liftRight}px;--short-left:${liftLeft ? .78 : 1};--short-right:${liftRight ? .78 : 1};--hip-sway:${Math.round(stride * 2)}px;--arm:${left}deg;--arm-back:${right}deg;--elbow:${elbow}deg;--elbow-back:${-elbow}deg;--head:${head}deg;--thumb:${thumb}px;--prop-x:${Math.round(right / 5)}px;--prop-y:${Math.round(right / 4)}px`;
        if (!current.emergency && actor.lastStyle !== style) { node.style.cssText = style; actor.lastStyle = style; }
        if (pose === 'check_wait') {
          const fill = node.querySelector<SVGRectElement>('.actor-progress-fill');
          if (fill) setAttribute(fill, 'width', String(4 + Math.round(time % 2400 / 2400 * 61)));
        }
        const plate = plates.current.get(member.id);
        if (plate) {
          const state = plate.querySelector('.office-person-state');
          const shortState = plateStateFor(actor.displayBehaviour);
          if (state && state.textContent !== shortState) state.textContent = shortState;
          plate.classList.remove('name-only');
        }
      });
      const folder = scene.current?.querySelector<SVGGElement>('.office-handoff-folder');
      const activeReview = current.tasks.find(task => task.state === 'in_review' && task.reviewerId && task.reviewerId !== task.assigneeId);
      const submitter = activeReview && actors.current.get(activeReview.assigneeId);
      const reviewer = activeReview?.reviewerId && actors.current.get(activeReview.reviewerId);
      const ready = !!activeReview && !!submitter && !!reviewer && submitter.phase === 'standing' && reviewer.phase === 'standing' &&
        Math.hypot(submitter.walker.point.x - submitter.behaviour.point.x, submitter.walker.point.y - submitter.behaviour.point.y) <= 2 &&
        Math.hypot(reviewer.walker.point.x - reviewer.behaviour.point.x, reviewer.walker.point.y - reviewer.behaviour.point.y) <= 2;
      if (ready && activeReview && !handoffReady.current.has(activeReview.id)) handoffReady.current.set(activeReview.id, now);
      if (activeReview && !ready) handoffReady.current.delete(activeReview.id);
      if (!activeReview) handoffReady.current.clear();
      const exchangeTime = ready && activeReview ? now - (handoffReady.current.get(activeReview.id) ?? now) : Infinity;
      for (const [id, node] of nodes.current) setAttribute(node, 'data-handoff', String(exchangeTime < 3000 &&
        (id === activeReview?.assigneeId || id === activeReview?.reviewerId)));
      if (folder) {
        setAttribute(folder, 'display', exchangeTime < 3000 ? 'inline' : 'none');
        if (exchangeTime < 3000 && submitter && reviewer) {
          const from = submitter.walker.point;
          const to = reviewer.walker.point;
          const fraction = Math.min(1, Math.max(0, exchangeTime / 1200));
          const startX = from.x + (to.x < from.x ? -9 : 9);
          const endX = to.x + (from.x < to.x ? -9 : 9);
          const x = startX + (endX - startX) * fraction;
          const y = (from.y + to.y) / 2 - 40 - Math.sin(fraction * Math.PI) * 4;
          setAttribute(folder, 'transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
        }
      }
      const sofaFront = scene.current?.querySelector<SVGPathElement>('.office-sofa-exit-front');
      if (sofaFront) setAttribute(sofaFront, 'display', [...actors.current.values()].some(actor =>
        actor.walker.point.x >= 840 && actor.walker.point.x <= 1000 && actor.walker.point.y <= 200 &&
        ['rising', 'standing', 'walking'].includes(actor.phase)) ? 'inline' : 'none');
      const layer = scene.current?.querySelector<SVGGElement>('.office-depth-layer');
      const sofaLayer = scene.current?.querySelector<SVGGElement>('.office-sofa-layer');
      if (layer && sofaLayer) {
        const behind: SVGGElement[] = [];
        [...actors.current.entries()].forEach(([id, actor]) => {
          const node = nodes.current.get(id);
          const point = actor.walker.point;
          const behindSofa = actor.behaviour.place === 'lounge' && point.x >= 829 && point.x <= 1082 && point.y <= 195 &&
            actor.phase !== 'walking' && actor.phase !== 'standing';
          if (node && behindSofa) behind.push(node);
          else if (node && node.parentNode !== layer) layer.appendChild(node);
        });
        const order = (target: SVGGElement, desired: Element[]) => desired.forEach((node, index) => {
          if (target.children.item(index) !== node) target.insertBefore(node, target.children.item(index));
        });
        order(sofaLayer, behind);
        const sorted = depthOrder([...layer.children], node => Number(node.getAttribute('data-base-y') ?? node.getAttribute('data-feet-y') ?? 0));
        order(layer, sorted);
      }
      {
        const sceneBox = scene.current?.getBoundingClientRect();
        const bodyBoxes = new Map<string, Rectangle>();
        if (sceneBox) actors.current.forEach((_, id) => {
          const node = nodes.current.get(id);
          const head = node?.querySelector('.rig-head')?.getBoundingClientRect();
          const body = node?.querySelector('.rig-body')?.getBoundingClientRect();
          if (!head || !body) return;
          const sx = 1200 / sceneBox.width, sy = 610 / sceneBox.height;
          bodyBoxes.set(id, {
            left: (Math.min(head.left, body.left) - sceneBox.left) * sx - 3,
            right: (Math.max(head.right, body.right) - sceneBox.left) * sx + 3,
            top: (Math.min(head.top, body.top) - sceneBox.top) * sy - 3,
            bottom: (Math.max(head.bottom, body.bottom) - sceneBox.top) * sy + 3,
          });
        });
        const placedPlates: Rectangle[] = [];
        current.visible.map((member, index) => ({ member, index })).sort((a, b) => {
          const atDesk = (entry: { member: MemberView; index: number }) => {
            const actor = actors.current.get(entry.member.id);
            return actor?.phase === 'seated' && actor.behaviour.place === 'desk' ? 0 : 1;
          };
          return atDesk(a) - atDesk(b) || a.index - b.index;
        }).forEach(({ member, index }) => {
          const plate = plates.current.get(member.id);
          const actor = actors.current.get(member.id);
          if (!plate || !actor) return;
          if (current.emergency) return;
          const priorPlacement = plate.dataset.placement;
          const priorSlot = plate.dataset.slot;
          const obstacles: Rectangle[] = [...bodyBoxes].filter(([id]) => id !== member.id).map(([, box]) => box).concat(placedPlates);
          const visual = renderActorTick({ actor, behaviour: actor.behaviour, seat: stations[index], now, poseUntil: actor.poseUntil,
            emergency: current.emergency, reduced, facing: actor.facing, obstacles,
            previousPlateSlot: (plate.dataset.slot as 'left' | 'middle' | 'right' | undefined) ?? 'middle',
            plateHeight: Math.max(31, 32 * 610 / sceneHeight) });
          const { plate: position } = visual;
          const placement = position.placement;
          const atDesk = placement === 'desk';
          plate.dataset.slot = position.slot;
          if (priorPlacement && (priorPlacement !== placement || (!atDesk && priorSlot && priorSlot !== plate.dataset.slot))) {
            plate.classList.add('slot-changing');
            window.setTimeout(() => plate.classList.remove('slot-changing'), 180);
          }
          setProperty(plate, 'left', '0px');
          setProperty(plate, 'top', '0px');
          setProperty(plate, 'transform', `translate3d(${(position.x * sceneWidth / 1200).toFixed(2)}px, ${(position.y * sceneHeight / 610).toFixed(2)}px, 0)`);
          plate.dataset.placement = placement;
          plate.dataset.actorPhase = actor.phase;
          plate.dataset.side = atDesk ? stations[index].side : 'floor';
          plate.dataset.cardLeft = position.x > 660 ? 'true' : 'false';
          plate.dataset.cardUp = position.y > 440 ? 'true' : 'false';
          plate.classList.remove('occluded');
          const width = atDesk ? 116 : 88;
          placedPlates.push({ left: position.x, top: position.y, right: position.x + width,
            bottom: position.y + Math.max(31, 32 * 610 / sceneHeight) });
        });
      }
    };
    const resume = () => { if (!document.hidden && inView && !frame) { last = 0; frame = requestAnimationFrame(tick); } };
    const onMotion = () => { reduced = motion.matches; resume(); };
    const observer = new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? true; resume(); }, { threshold: .02 });
    if (scene.current) observer.observe(scene.current);
    motion.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', resume);
    resume();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); motion.removeEventListener('change', onMotion); document.removeEventListener('visibilitychange', resume); };
  }, []);
  const initialLabels = labelPositions(visible.map((_, index) => stations[index]), visible.map((_, index) => stations[index].side));
  return <div ref={scene} className={`office-scene ${emergency ? 'office-stopped' : ''}`}>
    <svg viewBox="0 0 1200 610" className="office-svg">
      <Room titles={titles} unread={unread} time={clock} printing={printing} />
      <g className="office-sofa-layer" />
      <g className="office-depth-layer">
        {stations.slice(0, 6).map((seat, index) => <Chair key={`chair:${index}`} seat={seat} moving={false} />)}
        {stations.slice(6).map((seat, index) => <Desk key={`desk:${index + 6}`} seat={seat} index={index + 6} member={visible[index + 6]} />)}
        {visible.map((member, index) => <ActorFigure key={member.id} member={member} index={index} nodes={nodes.current} onMember={onMember} />)}
        {stations.slice(6).map((seat, index) => <Chair key={`chair:${index + 6}`} seat={seat} moving={false} />)}
        {stations.slice(0, 6).map((seat, index) => <Desk key={`desk:${index}`} seat={seat} index={index} member={visible[index]} />)}
        <g data-base-y="198"><LoungeFront /></g>
      </g>
      <g className="office-board-foreground"><use href="#board-empty-copy" /><use href="#board-title-copy" /><use href="#board-step-copy" /></g>
      <g className="office-handoff-folder" display="none" pointerEvents="none" stroke={ink} strokeWidth="1.5"><path d="M-12 -7 h12 l3 3 h9 v15 h-24z" fill="#c99d62" /><path d="M-6 1 h12 m-12 4 h10" fill="none" stroke="#75664e" /></g>
      {emergency && <g className="office-stop-overlay"><rect width="1200" height="660" fill="#24333c" opacity=".36" /></g>}
    </svg>
    <div className="office-label-layer">{visible.map((member, index) => <button key={member.id} ref={node => { if (node) plates.current.set(member.id, node); else plates.current.delete(member.id); }} className="office-person-label" style={{ left: `${initialLabels[index].x / 12}%`, top: `${initialLabels[index].y / 6.1}%` }} onClick={() => onMember(member.id)} aria-label={`${member.name} 팀원 상세 열기`}>
      <strong>{member.name}</strong><span className="office-person-state" />
      <span className="office-person-card"><b>{member.name} · {member.roleName}</b><span>{member.currentTask?.title ?? (member.currentWork ? resolveWorkLabel(member.currentWork.label, { tasks, directives }) : '현재 작업 없음')}</span><span>{AI_KIND_LABEL[member.ai.kind]} · {member.ai.modelValue ?? '기본 모델'} · {EFFORT_TIER_LABEL[member.ai.effortTier]} ({member.ai.effortValue})</span></span>
    </button>)}</div>
    {emergency && <div className="office-stop-notice">긴급 정지 · 모든 작업 중단</div>}
    <div className="office-caption"><span className="live-dot" /> 작업실 <span>{visible.filter(member => member.status === 'working').length}명 업무 중 / {visible.length}명</span></div>
  </div>;
}
