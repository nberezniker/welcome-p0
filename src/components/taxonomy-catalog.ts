'use client';

import { useEffect, useState } from 'react';
import { parseCatalog, type TaxonomyCatalog } from '../domain/picker';

/**
 * Page-scoped taxonomy catalogue.
 *
 * GET /api/taxonomy is public and cacheable (`public, max-age=3600`), and one
 * page can hold several pickers — so the fetch is deduped through a module-level
 * promise: the first picker mounts it, every other picker on the page (and any
 * later remount) reuses the same in-flight/settled result instead of firing a
 * second request. A failed fetch clears the cache so a retry can happen.
 */
let cached: Promise<TaxonomyCatalog> | null = null;

export function loadTaxonomyCatalog(): Promise<TaxonomyCatalog> {
  if (!cached) {
    cached = fetch('/api/taxonomy', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`taxonomy ${res.status}`);
        const catalog = parseCatalog(await res.json().catch(() => null));
        if (!catalog) throw new Error('taxonomy payload unusable');
        return catalog;
      })
      .catch((err: unknown) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

/** Test/browser-only escape hatch (also used by the "retry" affordance). */
export function resetTaxonomyCatalogCache(): void {
  cached = null;
}

export function useTaxonomyCatalog(): {
  catalog: TaxonomyCatalog | null;
  failed: boolean;
} {
  const [catalog, setCatalog] = useState<TaxonomyCatalog | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTaxonomyCatalog()
      .then((value) => {
        if (!cancelled) setCatalog(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { catalog, failed };
}
