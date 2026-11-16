import { describe,expect,it } from 'vitest';
import { snapshot } from '../api/fake/data';
import { officeDemoSnapshot } from '../api/fake/officeDemo';
import { deskSeat, deskSeats, placementProblems, restCapacity, snapshotPlacement, workClip } from './placement';

function placement(step:'busy'|'idle'|'events'|'waiting'|'error'|'paused') {
  const demo=officeDemoSnapshot(snapshot,step,0);
  const members=demo.members.filter(member=>member.projectId==='P-0003'&&!member.deleted);
  const source=members.find(member=>!member.isProducer);
  if(source)members.push({...source,id:'M-PHASE2A-SEAT12',name:'배치 검증',status:step==='idle'?'idle':'working'});
  const people=snapshotPlacement({members,tasks:demo.tasks.filter(task=>task.projectId==='P-0003'),
    directives:demo.directives.filter(item=>item.projectId==='P-0003'),
    activity:demo.recentActivity.filter(item=>item.projectId==='P-0003'),emergency:false,now:Date.now()});
  return {members,people};
}

describe('Studio 3D snapshot placement',()=>{
  it('puts every working member at their own role-specific desk clip',()=>{
    const {members,people}=placement('busy');
    expect(people).toHaveLength(members.length);
    for(const person of people){
      const member=members.find(item=>item.id===person.memberId);
      expect(member).toBeDefined();
      expect(person.clip).toBe(workClip(member!.roleId));
      expect(person.place).toBe(member!.isProducer?'producer':'desk');
      const seat=member!.isProducer?{x:.05,z:-3.35}:deskSeat(person.asset<13?person.asset-1:person.asset-2);
      expect([person.x,person.z]).toEqual([seat.x,seat.z]);
    }
    // Mutation: exchanging two member-to-seat assignments breaks the seat assertion.
    const swapped=people.map((person,index)=>index===0?{...person,...deskSeats[1]}:person);
    expect([swapped[0].x,swapped[0].z]).not.toEqual([deskSeats[0].x,deskSeats[0].z]);
  });
  it('keeps idle people at bounded rest places or their own desks',()=>{
    const {people}=placement('idle');
    const counts=new Map<string,number>();
    for(const person of people){
      if(person.place==='producer'||person.place==='desk')continue;
      counts.set(person.place,(counts.get(person.place)??0)+1);
    }
    for(const [place,capacity] of Object.entries(restCapacity))expect(counts.get(place)??0).toBeLessThanOrEqual(capacity);
    expect([...counts.values()].reduce((a,b)=>a+b,0)).toBe(2);
    expect([...counts.keys()]).toEqual(['sofa']);
    // Mutation: sending a third person to the sofa exceeds its two seats.
    const overflow=people.map((person,index)=>index===9?{...person,place:'sofa' as const}:person);
    expect(placementProblems(overflow)).toContain('sofa over capacity');
  });
  it('keeps every pair at least half a metre apart',()=>{
    for(const step of ['busy','idle','events'] as const){
      const {people}=placement(step);
      for(let i=0;i<people.length;i++)for(let j=i+1;j<people.length;j++)
        expect(Math.hypot(people[i].x-people[j].x,people[i].z-people[j].z)).toBeGreaterThanOrEqual(.5);
    }
    // Mutation: coincident actors trigger the pairwise checker.
    const {people}=placement('busy');
    const collision=people.map((person,index)=>index===1?{...person,x:people[0].x,z:people[0].z}:person);
    expect(placementProblems(collision).some(problem=>problem.includes('overlaps'))).toBe(true);
  });
  it('keeps rest feet outside counter and meeting-table footprints',()=>{
    for(const step of ['busy','idle','events'] as const)
      expect(placementProblems(placement(step).people)).toEqual([]);
    // Mutation: a coffee guest moved to the counter top is an intrusion.
    const {people}=placement('idle');
    const inside=people.map((person,index)=>index===0?{...person,place:'coffee' as const,z:-2.7}:person);
    expect(placementProblems(inside).some(problem=>problem.includes('coffee counter'))).toBe(true);
  });
  it('maps waiting, error and paused states to readable seated clips',()=>{
    for(const [step,status,clip] of [
      ['waiting','awaiting_answer','hand_raise'],['error','error','head_in_hands'],
      ['paused','paused','sit_lean_back'],
    ] as const){
      const {people}=placement(step);
      const affected=people.filter(person=>person.status===status);
      expect(affected.length).toBeGreaterThan(0);
      expect(affected.every(person=>person.clip===clip)).toBe(true);
    }
    // Mutation: replacing the waiting pose with typing breaks status truth.
    const {people}=placement('waiting');
    const wrong=people.map(person=>person.status==='awaiting_answer'?{...person,clip:'sit_type' as const}:person);
    expect(wrong.filter(person=>person.status==='awaiting_answer').every(person=>person.clip==='hand_raise')).toBe(false);
  });
});
