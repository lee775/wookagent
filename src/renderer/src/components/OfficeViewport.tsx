import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

function pageVisible() {
  return typeof document === 'undefined' || !document.hidden;
}
function subscribeVisibility(update: () => void) {
  document.addEventListener('visibilitychange', update);
  return () => document.removeEventListener('visibilitychange', update);
}

/** Unmount the renderer itself, including WebGL resources, when nobody can see it. */
export function OfficeViewport({ label, children, suspended = false }: { label: string; children: ReactNode; suspended?: boolean }) {
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, pageVisible);
  const host = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setInView(entries[0]?.isIntersecting ?? false));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={host} className="office-viewport" role="region" aria-label={label}>
    {visible && inView && !suspended ? children : <div className="office-scene" data-office-sleeping="true" />}
  </div>;
}
