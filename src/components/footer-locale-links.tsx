'use client';

/** Footer locale links: the href is a working no-JS fallback (`?lang=`, resolved
 * and persisted by the locale middleware), while the click handler keeps the
 * in-place switch on a hydrated page (POST /api/locale + refresh). */
export function FooterLocaleLinks({
  current,
  links,
  label,
}: {
  current: string;
  links: { locale: string; label: string }[];
  label: string;
}) {
  return (
    <div className="mt-1 flex gap-2" aria-label={label}>
      {links.map((l) => (
        <a
          key={l.locale}
          href={`/?lang=${l.locale}`}
          lang={l.locale}
          className="underline underline-offset-2 hover:text-ink"
          aria-current={current === l.locale ? 'true' : undefined}
          onClick={(e) => {
            e.preventDefault();
            void fetch('/api/locale', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ locale: l.locale }),
            }).then((res) => {
              if (res.ok) window.location.reload();
            });
          }}
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}
