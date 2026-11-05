import { useEffect, useState } from 'react';
import type { AppSnapshot } from '../../../shared/views';
import type { WookMethod, WookParams, WookResult } from '../../../shared/ipc';
import { getBridge } from './bridge';
type Toast = {
  id: number;
  title: string;
  body: string;
  level: 'urgent' | 'normal' | 'info';
};
let toastSequence = 0;
const toastListeners = new Set<(toast: Toast) => void>();
export function toast(title: string, body = '', level: Toast['level'] = 'normal') {
  const item = {
    id: ++toastSequence,
    title,
    body,
    level,
  };
  toastListeners.forEach((listener) => listener(item));
}
export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const listener = (item: Toast) => {
      setItems((old) => [...old.slice(-3), item]);
      window.setTimeout(() => setItems((old) => old.filter((value) => value.id !== item.id)), 5200);
    };
    toastListeners.add(listener);
    return () => {
      toastListeners.delete(listener);
    };
  }, []);
  return {
    items,
    dismiss: (id: number) => setItems((old) => old.filter((item) => item.id !== id)),
  };
}
export async function call<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>> {
  try {
    const result = await getBridge().invoke(method, ...args);
    if (method === 'auth.login' || method === 'auth.devLogin') {
      window.dispatchEvent(new Event('wook:authorized'));
    }
    return result;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'unauthorized') {
      window.dispatchEvent(new Event('wook:unauthorized'));
      throw error;
    }
    toast('요청을 처리하지 못했습니다', error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '알 수 없는 오류가 발생했습니다.', 'urgent');
    throw error;
  }
}
export function useInvoke() {
  return call;
}
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  useEffect(() => {
    const unsubscribe = getBridge().subscribe('snapshot', setSnapshot);
    const refresh = () => { void call('snapshot.get').then(setSnapshot).catch(() => undefined); };
    window.addEventListener('wook:authorized', refresh);
    void call('snapshot.get')
      .then(setSnapshot)
      .catch(() => undefined);
    return () => { unsubscribe(); window.removeEventListener('wook:authorized', refresh); };
  }, []);
  return snapshot;
}
