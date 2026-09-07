'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

export interface MeNavItem {
  href: string;
  label: string;
}

/** App nav for the authenticated shell; highlights the active section. */
export function MeNav({ items, ariaLabel }: { items: MeNavItem[]; ariaLabel: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={ariaLabel} className="flex flex-wrap gap-1" data-testid="me-nav">
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== '/me' && pathname.startsWith(item.href));
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={
              'rounded-lg px-3 py-2 text-sm font-semibold underline-offset-4 ' +
              (active ? 'bg-ink text-white' : 'text-muted hover:bg-white hover:text-ink hover:underline')
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn-light btn-small"
      data-testid="sign-out"
      onClick={async () => {
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } finally {
          router.replace('/');
          router.refresh();
        }
      }}
    >
      {label}
    </button>
  );
}
