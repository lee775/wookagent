import { memo } from 'react';
import type { MemberView } from '../../../shared/views';
import { appearanceFor } from './characters';

type Identity = Pick<MemberView, 'id' | 'roleId' | 'isMain'>;

export const PersonRig = memo(function PersonRig({ member }: { member: Identity }) {
  const a = appearanceFor(member);
  const width = [17, 20, 23][a.build];
  const role = member.isMain ? 'producer' : member.roleId;
  const backHair = [
    'M24 17 Q23 3 40 4 Q57 3 57 18 L56 39 Q40 46 24 39Z',
    'M25 18 Q26 4 42 5 Q57 6 56 20 L53 32 Q39 38 27 32Z',
    'M22 20 Q18 5 39 4 Q61 4 60 21 L54 35 Q39 41 23 34Z',
    'M24 18 Q22 2 40 4 Q60 1 58 20 L55 48 Q39 54 23 42Z',
    'M24 17 Q31 1 49 6 L59 20 L54 34 Q39 39 26 34Z',
    'M21 21 Q19 1 40 1 Q61 2 60 22 L56 48 Q40 55 22 47Z',
    'M25 19 Q25 4 39 5 Q56 2 57 20 L53 35 Q40 42 26 35Z',
    'M23 18 Q29 1 47 5 L58 20 L56 43 Q39 49 24 39Z',
  ];
  return <g className="person-rig" stroke="#292e2a" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
    <ellipse cx="40" cy="107" rx="24" ry="4" fill="#322f2633" stroke="none" />
    <g className="rig-leg rig-leg-left"><path className="rig-upper-leg" d="M32 75 L28 91" fill="none" stroke={a.trouser} strokeWidth="10" /><g className="rig-lower-leg rig-lower-leg-left"><path d="M28 91 L28 102" fill="none" stroke={a.trouser} strokeWidth="10" /><g className="rig-foot"><path d="M27 101 q-12 2-12 6 h19 v-5" fill="#292f30" /></g></g></g>
    <g className="rig-leg rig-leg-right"><path className="rig-upper-leg" d="M48 75 L52 91" fill="none" stroke={a.trouser} strokeWidth="10" /><g className="rig-lower-leg rig-lower-leg-right"><path d="M52 91 L51 102" fill="none" stroke={a.trouser} strokeWidth="10" /><g className="rig-foot"><path d="M50 101 q11 1 14 6 H45 v-5" fill="#292f30" /></g></g></g>
    <g className="rig-seated-legs"><path d="M31 76 h-13 M49 76 h13" fill="none" stroke={a.trouser} strokeWidth="9" /></g>
    <g className="rig-body">
      <path d={`M35 40 L35 44 Q${40-width} 42 ${40-width-3} 50 Q${40-width-5} 55 ${40-width-2} 63 L${40-width+1} 76 Q40 79 ${40+width-1} 76 L${40+width+2} 63 Q${40+width+5} 55 ${40+width+3} 50 Q${40+width} 42 45 44 L45 40Z`} fill={a.shirt} />
      <path className="rig-front-detail" d="M35 43 l5 7 5-7" fill="none" stroke="#f3e9d8" strokeWidth="2" />
      <path d="M22 46 q-4 3-2 11 M58 46 q4 3 2 11" fill="none" stroke={a.accent} strokeWidth="2" />
      <path d="M26 68 Q40 73 54 68" fill="none" stroke="#292e2a88" strokeWidth="1" />
      <g className="rig-front-detail">
        {a.accessory === 0 && <><path d="M45 49 v19" stroke="#e8d7b6" strokeWidth="1" /><circle cx="45" cy="55" r="2" fill={a.accent} /></>}
        {a.accessory === 1 && <path d="M29 51 h7 l-2 7 h-7z" fill={a.accent} strokeWidth="1" />}
        {a.accessory === 2 && <><path d="M34 45 l4 8 4-8 M45 45 l-3 8" fill="none" stroke="#dce5e7" strokeWidth="2" /><rect x="36" y="57" width="10" height="8" fill="#f2f5f6" stroke={a.accent} strokeWidth="1" /></>}
        {a.accessory === 3 && <><path d="M31 50 v14 M48 50 v14" stroke="#dce5e7" strokeWidth="1.6" /><path d="M21 57 h8 M53 57 h8" stroke={a.accent} strokeWidth="2" /></>}
      </g>
    </g>
    <g className="rig-arm rig-arm-left"><path className="rig-upper-arm" d="M22 48 Q17 52 16 62" fill="none" stroke={a.shirt} strokeWidth="11" /><g className="rig-lower-arm rig-lower-arm-left"><path d="M16 62 Q17 67 24 72" fill="none" stroke={a.shirt} strokeWidth="9" /><path d="M20 69 l5-3" stroke={a.accent} /><g className="rig-hand"><path d="M21 70 q-4 1-3 5 l4 3 5-2 1-4-3-2-2 2z" fill={a.skin} /></g></g></g>
    <g className="rig-arm rig-arm-right"><path className="rig-upper-arm" d="M58 48 Q63 52 64 62" fill="none" stroke={a.shirt} strokeWidth="11" /><g className="rig-lower-arm rig-lower-arm-right"><path d="M64 62 Q63 67 56 72" fill="none" stroke={a.shirt} strokeWidth="9" /><path d="M55 66 l5 3" stroke={a.accent} /><g className="rig-hand"><path d="M59 70 q4 1 3 5 l-4 3-5-2-1-4 3-2 2 2z" fill={a.skin} /></g></g></g>
    <g className="rig-head">
      <path d="M35 37 v9 q5 5 10 0 v-9" fill={a.skin} />
      <ellipse cx="40" cy="25" rx={[16, 17, 15][a.headShape]} ry={[19, 18, 21][a.headShape]} fill={a.skin} />
      <g className="rig-hair"><path d="M24 26 Q18 4 37 5 Q58 1 57 24 L53 19 Q47 19 44 13 Q36 23 25 19Z" fill={a.hair} />
      {a.hairStyle === 0 && <path d="M25 18 Q20 28 25 37 l5 1 -1-18 M55 17 q5 10 0 20 l-5 1 1-19" fill={a.hair} />}
      {a.hairStyle === 1 && <path d="M28 12 q8-13 17-4 q9-4 13 11 q-9-4-15-2 q-8-6-15-5" fill={a.hair} />}
      {a.hairStyle === 2 && <path d="M24 24 Q15 9 29 7 L28 26 M55 23 Q65 4 49 6 L52 27" fill={a.hair} />}
      {a.hairStyle === 3 && <><path d="M51 13 q16 15 2 32 l-6-1 5-24" fill={a.hair} /><path d="M24 18 q2-14 18-13" fill="none" stroke={a.hair} strokeWidth="5" /></>}
      {a.hairStyle === 4 && <path d="M25 14 q10-16 24-7 q9-5 10 10 q-9-3-13-8 q-10 11-21 5" fill={a.hair} />}
      {a.hairStyle === 5 && <path d="M21 22 q-4-24 19-22 q23 1 20 22 l-7-9 q-17-12-32 9" fill={a.hair} />}
      {a.hairStyle === 6 && <><path d="M25 13 q4-13 13-9 q13-8 20 10" fill={a.hair} /><circle cx="57" cy="5" r="7" fill={a.hair} /></>}
      {a.hairStyle === 7 && <><path d="M25 16 q8-15 24-10 l8 13 q-14-2-21-8 l-11 11" fill={a.hair} /><path d="M26 19 v19 M55 20 v18" stroke={a.hair} strokeWidth="5" /></>}</g>
      <g className="rig-face" fill="none" stroke="#292e2a">
        <g className="brow-default" strokeWidth="1.6"><path className="far-brow" d={['M30 22 h6', 'M30 22 q3-3 6 0', 'M30 23 l6-2', 'M30 22 q3 2 6 0'][a.brow]} /><path d={['M44 22 h6', 'M44 22 q3-3 6 0', 'M44 21 l6 2', 'M44 22 q3 2 6 0'][a.brow]} /></g>
        <g className="brow-question" strokeWidth="1.7"><path className="far-brow" d="M29 19 q4-5 8-1" /><path d="M44 18 q4-5 8 0" /></g>
        <g className="brow-error" strokeWidth="1.9"><path className="far-brow" d="M29 20 l8 4" /><path d="M43 24 l8-4" /></g>
        <g className="brow-sigh" strokeWidth="1.6"><path className="far-brow" d="M29 25 q4 2 8 0" /><path d="M43 25 q4 2 8 0" /></g>
        <g className="eyes-open" stroke="none" fill="#273239"><ellipse cx={33 + a.eyes % 2} cy="27" rx={1.6 + a.eyes * .15} ry={2.2 + a.eyes * .12} /><ellipse cx={47 - a.eyes % 2} cy="27" rx={1.6 + a.eyes * .15} ry={2.2 + a.eyes * .12} /><g fill="#fff"><circle cx="33" cy="26" r=".65" /><circle cx="46" cy="26" r=".65" /></g></g>
        <path className="front-nose" d={['M40 27 v4 l2 1', 'M39 28 q-1 3 2 4', 'M41 28 l-1 4'][a.nose]} strokeWidth=".8" />
        <path className="mouth-smile" d="M36 36 q4 3 8 0" strokeWidth="1.3" />
        <path className="mouth-neutral" d="M37 37 h6" strokeWidth="1.3" />
        <path className="mouth-frown" d="M36 38 q4-3 8 0" strokeWidth="1.3" />
        <ellipse className="mouth-open" cx="40" cy="37" rx="3" ry="2.5" fill="#653d38" strokeWidth="1" />
        <path className="eyes-closed" d="M31 27 q3 2 6 0 M43 27 q3 2 6 0" strokeWidth="1.3" />
        {a.freckles && <g fill="#985e4c" stroke="none"><circle cx="29" cy="32" r=".7" /><circle cx="33" cy="33" r=".7" /><circle cx="48" cy="32" r=".7" /><circle cx="51" cy="33" r=".7" /></g>}
        {a.ageLines && <path d="M26 32 l-2 2 M54 32 l2 2" strokeWidth=".8" />}
        {a.beard && <path d="M31 37 q9 9 18 0" stroke={a.hair} strokeWidth="3" />}
        {a.glasses && <g stroke="#343b39" strokeWidth="1.8"><circle cx="33" cy="27" r="5" /><circle cx="47" cy="27" r="5" /><path d="M38 27 h4 M28 26 l-4-2 M52 26 l4-2" /></g>}
      </g>
      <g className="rig-quarter-profile" fill="none" stroke="#594536" strokeWidth="1"><path d="M53 27 q6-2 7 2 l-4 2" fill={a.skin} /><path d="M50 32 q3 3 5 1" /></g>
      <g className="rig-back-hair"><path d={backHair[a.hairStyle]} fill={a.hair} />{a.hairStyle === 6 && <circle cx="58" cy="6" r="8" fill={a.hair} />}<path d="M28 22 q12-8 24 0" fill="none" stroke="#ffffff33" strokeWidth="1" /><path d="M26 27 q-5-1-4 5 q2 5 6 3 M54 27 q5-1 4 5 q-2 5-6 3" fill={a.skin} /><path d="M54 30 q4 2 5 5 l-4 1" fill="none" stroke="#624d3b" strokeWidth=".8" /></g>
      {role === 'developer' && <g className="rig-worn"><path d="M24 24 q0-21 16-21 q17 0 17 21" fill="none" stroke="#313937" strokeWidth="4" /><rect x="19" y="23" width="7" height="13" rx="3" fill={a.accent} /><rect x="54" y="23" width="7" height="13" rx="3" fill={a.accent} /></g>}
      <g className="gesture-hands" fill={a.skin} stroke="#6c4e3f" strokeWidth="1.2"><g fill="none" stroke={a.shirt} strokeWidth="6"><path className="gesture-hand-error" d="M22 49 L26 10 M58 49 L54 10" /><path className="gesture-hand-conflict" d="M20 53 L24 28 M60 53 L56 28" /></g><ellipse className="gesture-hand-error" cx="26" cy="10" rx="5" ry="6" /><ellipse className="gesture-hand-error" cx="54" cy="10" rx="5" ry="6" /><ellipse className="gesture-hand-conflict" cx="24" cy="28" rx="5" ry="6" /><ellipse className="gesture-hand-conflict" cx="56" cy="28" rx="5" ry="6" /></g>
    </g>
    <g className="gesture-celebrate" strokeLinecap="round" strokeLinejoin="round"><path d="M22 48 L17 14 L15 -10 M58 48 L63 14 L65 -10" fill="none" stroke={a.shirt} strokeWidth="10" /><ellipse cx="15" cy="-11" rx="5" ry="6" fill={a.skin} /><ellipse cx="65" cy="-11" rx="5" ry="6" fill={a.skin} /></g>
    <g className="rig-prop" strokeWidth="1.2">
      {role === 'ui_designer' && <><path d="M52 67 l13-8 2 3-14 9z" fill="#e7d9ad" /><path d="M65 59 l4-3" /></>}
      {role === 'planner' && <><path d="M26 63 h12 v10 H26z" fill="#e7bf66" /><path d="M30 66 h5 M30 69 h4" /></>}
      {role === 'architect' && <><path d="M48 64 l15-3 2 13-17 2z" fill="#dce5dc" /><path d="M52 70 l4-5 5 5 M53 73 h9" fill="none" stroke={a.accent} /></>}
      {role === 'qa' && <><circle cx="58" cy="68" r="7" fill="none" stroke={a.accent} strokeWidth="2.5" /><path d="M63 73 l6 7" strokeWidth="3" /></>}
      {role === 'docs' && <><path d="M48 63 q7-3 13 1 v13 q-7-3-13 0z" fill="#e9d6ac" /><path d="M48 63 q-6-3-12 1 v13 q7-3 12 0z" fill="#e9d6ac" /></>}
      {role === 'producer' && <><rect x="50" y="59" width="17" height="23" rx="2" fill="#ddd2af" /><path d="M55 65 h8 M55 69 h8 M55 73 h5" /><path d="M55 57 h7" strokeWidth="3" /></>}
    </g>
    <g className="pose-prop pose-folder"><path d="M48 61 h12 l3 3 h10 v17 H48z" fill="#c99d62" /><path d="M53 69 h14 M53 73 h11" fill="none" stroke="#807352" /></g>
    <g className="pose-prop pose-cup"><path d="M50 50 h15 l-2 16 H52z" fill="#d7e7eb" /><path d="M65 53 q10 0 4 9 h-5" fill="none" strokeWidth="2" /><path d="M54 45 q-3-4 1-8 M61 45 q-3-4 1-8" fill="none" stroke="#8f9684" /></g>
    <g className="pose-prop pose-phone"><rect x="52" y="51" width="9" height="17" rx="2" fill="#30506d" /><path d="M54 55 h5" stroke="#d7e6d7" /><path className="phone-thumb" d="M58 57 v3" stroke={a.skin} strokeWidth="3" /></g>
    <g className="pose-prop pose-water"><path d="M53 57 h15 v12 H53z" fill="#92b3ad" /><path d="M66 54 q12-4 12 6 M55 60 h9" fill="none" strokeWidth="2" /></g>
  </g>;
}, (before, after) => before.member.id === after.member.id && before.member.roleId === after.member.roleId && before.member.isMain === after.member.isMain);

export function PersonPortrait({ member, className = '' }: { member: Identity; className?: string }) {
  return <svg className={`person-portrait ${className}`} viewBox="6 0 68 79" aria-hidden="true"><PersonRig member={member} /></svg>;
}
