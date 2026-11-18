import { useEffect, useState, type CSSProperties } from 'react';

interface ChatViewportStyle extends CSSProperties {
  '--chat-viewport-height'?: string;
  '--chat-viewport-top'?: string;
}

/** Follow the visible viewport when a phone keyboard resizes or pans the page. */
export function useChatSurface(open: boolean) {
  const [viewport, setViewport] = useState<ChatViewportStyle>({});
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const visible = window.visualViewport;
    if (!visible) return;
    const update = () => setViewport({
      '--chat-viewport-height': `${visible.height}px`,
      '--chat-viewport-top': `${visible.offsetTop}px`,
    });
    update();
    visible.addEventListener('resize', update);
    visible.addEventListener('scroll', update);
    return () => {
      visible.removeEventListener('resize', update);
      visible.removeEventListener('scroll', update);
    };
  }, [open]);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const update = () => setBlocked(document.querySelector('[aria-modal="true"], dialog[open], .palette-backdrop') !== null ||
      !!window.matchMedia?.('(max-width: 760px)').matches && document.querySelector('.member-panel') !== null);
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    return () => observer.disconnect();
  }, []);
  return { viewport, blocked };
}
