'use client';

import { useEffect } from 'react';

/** Sets data-hydrated on <html> once client JS is live. E2E tests wait for it
 * to avoid clicking before event handlers are attached (cold dev server). */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.setAttribute('data-hydrated', 'true');
  }, []);
  return null;
}
