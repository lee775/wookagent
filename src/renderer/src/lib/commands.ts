export type CommandDraft = { target: string; text: string };
const listeners = new Set<(draft: CommandDraft) => void>();
const conversationListeners = new Set<(target: string) => void>();

export function openConversation(target: string | null) {
  conversationListeners.forEach(listener => listener(target ?? 'main'));
}
export function subscribeConversation(listener: (target: string) => void) {
  conversationListeners.add(listener);
  return () => { conversationListeners.delete(listener); };
}

export function openCommand(target: string | null, text: string) {
  listeners.forEach(listener => listener({ target: target ?? 'main', text }));
}

export function subscribeCommand(listener: (draft: CommandDraft) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
