import { useEffect, useRef, useState } from 'react';
import { isFileDrag } from './fileDrop';

/** One page guard; it never cancels text/link drags or changes the command target. */
export function useCommandDrop(receive: (data: DataTransfer) => void) {
  const [dragging, setDragging] = useState(false);
  const receiver = useRef(receive);
  receiver.current = receive;
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(expiry); setDragging(false); };
    const inside = (target: EventTarget | null) => target instanceof Node && document.documentElement.contains(target);
    // Mounted modal dialogs block the composer as well as the rest of the page.
    const blocked = () => document.querySelector('[aria-modal="true"], dialog[open]') !== null;
    const over = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      const active = !blocked();
      setDragging(active);
      if (event.dataTransfer) event.dataTransfer.dropEffect = active ? 'copy' : 'none';
      clearTimeout(expiry);
      // OS drags can swallow Esc without sending dragend or keydown to the page.
      expiry = setTimeout(clear, 700);
    };
    const leave = (event: DragEvent) => { if (!inside(event.relatedTarget)) clear(); };
    const drop = (event: DragEvent) => {
      clear();
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer && !blocked()) receiver.current(event.dataTransfer);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    const visibility = () => { if (document.visibilityState === 'hidden') clear(); };
    window.addEventListener('dragenter', over, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('dragend', clear, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', clear);
    window.addEventListener('pagehide', clear);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearTimeout(expiry);
      window.removeEventListener('dragenter', over, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('dragend', clear, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', clear);
      window.removeEventListener('pagehide', clear);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return dragging;
}
