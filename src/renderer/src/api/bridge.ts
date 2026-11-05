import type { WookBridge } from '../../../shared/ipc';
import { fakeBridge } from './fake';

declare global {
  interface Window { wook?: WookBridge }
}

export function getBridge(): WookBridge { return window.wook ?? fakeBridge; }
