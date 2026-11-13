export type CommandDraft = { target: string; text: string };
const listeners = new Set<(draft: CommandDraft) => void>();
const conversationListeners = new Map<(target: string) => void,boolean>();
let pendingConversation:string|undefined;

export function openConversation(target: string | null) {
  if(![...conversationListeners.values()].some(Boolean))pendingConversation=target??'main';
  conversationListeners.forEach((_,listener) => listener(target ?? 'main'));
}
export function subscribeConversation(listener: (target: string) => void,consumePending=true) {
  conversationListeners.set(listener,consumePending);
  if(consumePending&&pendingConversation!==undefined){const target=pendingConversation;pendingConversation=undefined;queueMicrotask(()=>{if(conversationListeners.has(listener))listener(target);});}
  return () => { conversationListeners.delete(listener); };
}

export function openCommand(target: string | null, text: string) {
  listeners.forEach(listener => listener({ target: target ?? 'main', text }));
}

export function subscribeCommand(listener: (draft: CommandDraft) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
