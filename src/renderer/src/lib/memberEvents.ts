import type { CliEvent } from '../../../shared/events';
import type { CliEventPage } from '../../../shared/views';

export function mergeCliEvents(previous: readonly CliEvent[], incoming: readonly CliEvent[]) {
  const unique = new Map(previous.map(event => [`${event.turnId}:${event.seq}`, event]));
  incoming.forEach(event => unique.set(`${event.turnId}:${event.seq}`, event));
  return [...unique.values()].sort((a, b) => a.turnId.localeCompare(b.turnId) || a.seq - b.seq);
}

/** The server cursor means seq > cursor, never 'older'. Drain forward, then reveal older locally. */
export async function readCliTail(read: (cursor?: string) => Promise<CliEventPage>, cursor?: string) {
  const events: CliEvent[] = [];
  const seen = new Set<string>();
  for (;;) {
    const page = await read(cursor);
    events.push(...page.events);
    if (page.nextCursor === null || seen.has(page.nextCursor)) return mergeCliEvents([], events);
    cursor = page.nextCursor; seen.add(cursor);
  }
}
