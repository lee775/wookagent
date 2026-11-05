import { PersonRig } from './Person';
import type { Pose } from './motion';
import type { CSSProperties } from 'react';

const poses: Pose[] = [
  'type', 'draw', 'write', 'diagram', 'check', 'check_wait', 'read', 'plan', 'walk',
  'drink', 'stretch', 'nap', 'chat', 'point', 'celebrate', 'sigh', 'receive', 'wait',
  'error', 'pause', 'submit', 'review', 'conflict', 'phone', 'water', 'window', 'inspect',
];
const member = { id: 'M-0016', roleId: 'developer', isMain: false };

export function PoseSheet() {
  return <main style={{ minHeight: '100vh', padding: 14, background: '#e1e8ee', fontFamily: 'Pretendard Variable, sans-serif' }}>
    <h1 style={{ margin: '0 0 10px', fontSize: 22 }}>욱채 v3.4 · 자세 시트 (1:1)</h1>
    <h2 style={{ fontSize: 15, margin: '8px 0' }}>걷기 · 정면, 사선, 뒷모습 · 네 걸음</h2>
    <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
      {(['front', 'quarter', 'back'] as const).flatMap(view => [-1, -.5, .5, 1].map((stride, phase) => {
        const liftLeft = -Math.round(Math.max(0, stride) * 10);
        const liftRight = -Math.round(Math.max(0, -stride) * 10);
        return <div key={`${view}:${phase}`} style={{ width: 124, padding: 2, background: '#f3f7fa', border: '1px solid #afbec4' }}>
          <svg viewBox="-20 -23 120 130" width="120" height="130"><g className="office-actor" data-pose="walk" data-view={view}
            style={{ '--lift-left': `${liftLeft}px`, '--lift-right': `${liftRight}px`, '--short-left': liftLeft ? .78 : 1,
              '--short-right': liftRight ? .78 : 1, '--hip-sway': `${Math.round(stride * 2)}px` } as CSSProperties}>
            <PersonRig member={member} /></g></svg><small>{view} · {phase + 1}</small>
        </div>;
      }))}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 128px)', gap: 5 }}>
      {poses.flatMap(pose => (['front', 'quarter', 'back'] as const).map(view => {
        const seated = ['type', 'draw', 'write', 'diagram', 'check', 'check_wait', 'read', 'plan', 'point', 'celebrate', 'sigh', 'receive', 'wait', 'error', 'pause', 'conflict', 'inspect'].includes(pose);
        const chair = <g fill="#738d98" stroke="#394852" strokeWidth="1.5"><path d="M18 58 q0-7 7-7 h30 q7 0 7 7 v24 H18z" /><path d="M17 76 q23 9 46 0 v10 H17z" fill="#8fa5ab" /></g>;
        return <div key={`${pose}:${view}`} style={{ height: 155, padding: '2px 3px', background: '#f3f7fa', border: '1px solid #afbec4' }}>
        <svg viewBox="-20 -23 120 130" width="120" height="130" style={{ display: 'block', overflow: 'visible' }}>
          {pose === 'nap' && <path d="M0 75 h80 v18 H0z" fill="#4c716d" />}
          {seated && chair}
          <g className="office-actor" data-pose={pose} data-view={view} data-seated={String(seated)}><PersonRig member={member} /></g>
          {seated && view === 'back' && chair}
        </svg>
        <small style={{ fontSize: 11 }}>{pose} · {view}</small>
      </div>;}))}
    </div>
  </main>;
}
