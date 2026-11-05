export interface FootContact { side:'L'|'R'; weight:number; measuring:boolean }

// One authored walk stride pair is one second at the 1.1 m/s path speed.
export function walkFootContact(actionTime:number):FootContact|null {
  // The contact centres are t=0 for L and t=.5 for R. The quarter-second
  // offset aligns the window with the backwards-moving part of the GLB stride.
  const phase=(((actionTime+.25)%1)+1)%1,local=phase%.5;
  if(local<.07||local>.43)return null;
  return {side:phase<.5?'L':'R',
    weight:Math.min(1,(local-.07)/.05,(.43-local)/.05),
    measuring:local>=.12&&local<=.38};
}
