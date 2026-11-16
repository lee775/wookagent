import type { ActivityView, DirectiveView, MemberView, TaskView } from '../../../shared/views';

export type StudioClip =
  | 'sit_type' | 'sit_idle' | 'stand_up' | 'sit_down' | 'walk' | 'walk_folder' | 'stand_drink'
  | 'sofa_sit' | 'sofa_talk' | 'sit_draw' | 'sit_check' | 'sit_write' | 'sit_plan'
  | 'sit_think' | 'sit_lean_back' | 'head_in_hands' | 'hand_raise'
  | 'sit_celebrate' | 'stand_idle' | 'stand_talk' | 'window_gaze'
  | 'hold_folder' | 'hand_over' | 'receive' | 'turn_left' | 'turn_right';

export type StudioPlace = 'desk' | 'producer' | 'coffee' | 'sofa' | 'window' | 'meeting';
export const entryDoor={x:5.25,z:-3.90} as const;
export const entryApron={x:4.4,z:-1.95} as const;
export interface StudioPosition {
  memberId: string;
  asset: number;
  role: string;
  status: MemberView['status'];
  x: number;
  z: number;
  yaw: number;
  clip: StudioClip;
  place: StudioPlace;
  seat: number | null;
}

type Slot = Pick<StudioPosition, 'x' | 'z' | 'yaw' | 'place'>;
const deskRows: Array<[number, number, number]> = [
  [-2.45,-1.09,0],[-.95,-1.09,0],[-2.45,1.09,Math.PI],[-.95,1.09,Math.PI],
  [-7.4,-2.30,0],[-5.9,-2.30,0],[-7.4,-.10,Math.PI],[-5.9,-.10,Math.PI],
  [-7.2,1.20,0],[-5.7,1.20,0],[-7.0,3.15,-Math.PI/2],[-7.0,4.45,-Math.PI/2],
];
export const deskSeats: readonly Slot[] = deskRows.map(([x,z,yaw]) => ({ x,z,yaw,place:'desk' }));
export const producerSeat: Slot = { x:.05,z:-3.35,yaw:0,place:'producer' };
// Extra pods continue past the west edge. Each band has its own small offsets,
// so the growth reads as added work areas rather than a uniform seating grid.
export function deskSeat(index:number):Slot {
  if(index<deskSeats.length)return deskSeats[index];
  const extra=index-deskSeats.length,band=Math.floor(extra/8),within=extra%8;
  const column=within%2,row=Math.floor(within/2);
  if(row===3)return {x:-11.5-band*3.25,z:column?4.4:3.1,yaw:-Math.PI/2,place:'desk'};
  const x=-10.35-band*3.25-column*1.48+(row===2?.13:row===3?-.11:0);
  const z=[-2.30,-.08,1.30,3.42][row]+(column?.08:-.07);
  const yaw=row%2===0?0:Math.PI;
  return {x,z,yaw,place:'desk'};
}
export function workstationSeats(count:number):Slot[] {
  return count===0?[]:[producerSeat,...Array.from({length:Math.max(0,count-1)},(_,index)=>deskSeat(index))];
}
export const homeForAsset=(asset:number):Slot=>asset===13?producerSeat:deskSeat(asset<13?asset-1:asset-2);

// Reservations live until the departing actor reaches the door. Removing one
// colleague never shifts the workstations of everybody after them in the array.
export class MemberSlots {
  private readonly slots=new Map<string,number>();
  assign(members:readonly Pick<MemberView,'id'|'isProducer'>[]):ReadonlyMap<string,number> {
    const occupied=new Set(this.slots.values());
    for(const member of members)if(!this.slots.has(member.id)){
      let asset=member.isProducer?13:1;
      while(!member.isProducer&&(asset===13||occupied.has(asset)))asset++;
      this.slots.set(member.id,asset);occupied.add(asset);
    }
    return this.slots;
  }
  release(id:string):void {this.slots.delete(id);}
  assets():number[] {return [...this.slots.values()];}
}
// Two physical sofa cushions. Every other resting place is a private desk.
export const restSlots: readonly Slot[] = [
  { x:2.13,z:1.60,yaw:.65,place:'sofa' },
  { x:3.03,z:1.60,yaw:-.65,place:'sofa' },
];
export const restCapacity: Readonly<Record<Exclude<StudioPlace,'desk'|'producer'>, number>> = {
  coffee:2, sofa:2, window:2, meeting:3,
};
export function idleSeat(asset:number):Slot {
  const index=asset<13?asset-1:asset-2;
  return asset===13?producerSeat:restSlots[index]??homeForAsset(asset);
}
export function idleClip(asset:number,seconds:number,sofa:boolean):StudioClip {
  const phase=(Math.floor(seconds/40)+asset)%3;
  return sofa?(phase===0?'sofa_talk':'sofa_sit'):
    phase===0?'sit_idle':phase===1?'sit_think':'sit_lean_back';
}

export function workClip(roleId: string): StudioClip {
  switch (roleId) {
    case 'ui_designer': return 'sit_draw';
    case 'qa': return 'sit_check';
    case 'docs': return 'sit_write';
    case 'planner':
    case 'architect':
    case 'producer': return 'sit_plan';
    default: return 'sit_type';
  }
}

export function snapshotPlacement(input: {
  members: MemberView[]; tasks: TaskView[]; directives: DirectiveView[];
  activity: ActivityView[]; emergency: boolean; now?: number;
}): StudioPosition[] {
  const { members, tasks, emergency } = input;
  const now = input.now ?? Date.now();
  const team = members.filter(member => !member.isProducer && !member.deleted);
  const positioned = team.map((member,index): StudioPosition => {
    const seat = deskSeat(index);
    const asset=index<12?index+1:index+2;
    let slot = seat;
    let clip: StudioClip;
    const ownTask=tasks.find(task=>task.assigneeId===member.id&&task.state!=='cancelled');
    if (member.status === 'error') clip = 'head_in_hands';
    else if (member.status === 'awaiting_answer') clip = 'hand_raise';
    else if (member.status === 'paused' || emergency) clip = 'sit_lean_back';
    else if (ownTask?.conflictFiles.length||ownTask?.hold?.reasons.some(reason=>reason.kind==='merge_blocked')) clip='sit_think';
    else if (ownTask?.state==='done'&&ownTask.completedAt&&now-Date.parse(ownTask.completedAt)<5000) clip='sit_celebrate';
    else if (member.status === 'idle') {
      slot = idleSeat(asset);
      clip = idleClip(asset,0,slot.place==='sofa');
    } else clip = workClip(member.roleId);
    return { memberId:member.id,asset,role:member.roleId,status:member.status,
      x:slot.x,z:slot.z,yaw:slot.yaw,clip,place:slot.place,seat:asset };
  });
  const producer = members.find(member => member.isProducer && !member.deleted);
  if (producer) positioned.push({ memberId:producer.id,asset:13,role:producer.roleId,status:producer.status,
    ...producerSeat, clip:producer.status === 'error' ? 'head_in_hands' : producer.status === 'awaiting_answer' ? 'hand_raise' :
      producer.status === 'paused' || emergency ? 'sit_lean_back' : producer.status === 'idle' ? 'sit_think' : 'sit_plan', seat:13 });
  return positioned;
}

export function placementProblems(people: StudioPosition[]): string[] {
  const problems: string[] = [];
  const counts = new Map<StudioPlace,number>();
  people.forEach((person,i) => {
    counts.set(person.place,(counts.get(person.place) ?? 0)+1);
    for (const other of people.slice(i+1)) {
      if (Math.hypot(person.x-other.x,person.z-other.z) < .5)
        problems.push(`${person.memberId} overlaps ${other.memberId}`);
    }
    if (person.place === 'coffee' && (person.z < -2.25 || person.z > -1.3))
      problems.push(`${person.memberId} is inside coffee counter`);
    if (person.place === 'meeting' && Math.abs(person.x+.35) < .75 && person.z > 2.9 && person.z < 3.7)
      problems.push(`${person.memberId} is inside meeting table`);
  });
  for (const [place,capacity] of Object.entries(restCapacity))
    if ((counts.get(place as StudioPlace) ?? 0) > capacity) problems.push(`${place} over capacity`);
  return problems;
}
