export type CommandDraft = { target: string; text: string };
const listeners = new Set<(draft: CommandDraft) => void>();

export function openCommand(target: string | null, text: string) {
  listeners.forEach(listener => listener({ target: target ?? 'main', text }));
}

export function subscribeCommand(listener: (draft: CommandDraft) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
