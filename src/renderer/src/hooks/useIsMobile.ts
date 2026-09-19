import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT_PX = 768;

/**
 * Tracks whether the viewport is at or below the app's mobile breakpoint —
 * the same 768px threshold App.tsx already uses to swap Sidebar for
 * MobileTopBar/MobileBottomNav. Shared here so every view can collapse its
 * own toolbar the same way, instead of each reimplementing the same
 * window.innerWidth check (or, more commonly, not checking at all and
 * relying purely on flex-wrap, which is what produced the "half the screen
 * is toolbar" problem on narrow viewports).
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(
    typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT_PX : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT_PX);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isMobile;
}
