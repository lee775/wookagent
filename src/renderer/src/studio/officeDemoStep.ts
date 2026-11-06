const steps = ['idle', 'busy', 'assignment', 'step', 'review', 'submit', 'check', 'rejected', 'passed', 'conflict', 'waiting', 'error', 'paused', 'report', 'emergency', 'release', 'events',
  'hiring', 'team2', 'team20', 'team24', 'team30', 'team50'] as const;
export type DemoStep = typeof steps[number];
export function officeDemoStep(query: string | null, elapsedMs: number): DemoStep | null {
  if (query === 'cycle') {
    const second = ((Math.max(0, elapsedMs) / 1000) % 88 + 88) % 88;
    const schedule: Array<[number, DemoStep]> = [[4, 'busy'], [11, 'assignment'], [30, 'review'],
      [32, 'passed'], [34, 'conflict'], [47, 'report'], [49, 'waiting'], [53, 'error'],
      [57, 'emergency'], [61, 'release'], [64, 'busy'], [88, 'idle']];
    return schedule.find(([until]) => second < until)?.[1] ?? 'busy';
  }
  if (query === 'working') return 'busy';
  return steps.find(step => step === query) ?? null;
}

