'use client';

/** Footer locale links (cookie-based locale: POST then reload server tree). */
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
          href={`/?locale=${l.locale}`}
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
