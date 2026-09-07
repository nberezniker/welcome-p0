import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadPublicProfile } from "../../../lib/public-profile";
import type { PublicContact } from "../../../lib/public-profile";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Карточка",
  robots: { index: false, follow: false },
};

/** Only http(s) values may become link targets — no javascript:/data: URIs. */
function safeHref(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function contactHref(contact: PublicContact): string | null {
  switch (contact.kind) {
    case "phone":
      return `tel:${contact.value.replace(/[^\d+]/g, "")}`;
    case "whatsapp":
      return `https://wa.me/${contact.value.replace(/[^\d]/g, "")}`;
    case "telegram_username":
      return `https://t.me/${contact.value.replace(/^@/, "")}`;
    case "linkedin_url":
    case "website":
      return safeHref(contact.value);
  }
}

const KIND_LABELS: Record<PublicContact["kind"], string> = {
  whatsapp: "WhatsApp",
  telegram_username: "Telegram",
  linkedin_url: "LinkedIn",
  website: "Сайт",
  phone: "Телефон",
};

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  if (!profile) notFound();

  // All user-controlled text is rendered as escaped React text. No HTML injection.
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      <article className="rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">{profile.display_name}</h1>
        {profile.headline && <p className="mt-2 text-lg text-neutral-600">{profile.headline}</p>}
        {profile.company && <p className="mt-1 text-neutral-500">{profile.company}</p>}
        {profile.short_bio && <p className="mt-4 whitespace-pre-line text-neutral-700">{profile.short_bio}</p>}

        {profile.offer_tags.length > 0 && (
          <section className="mt-6">
            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Могу помочь</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {profile.offer_tags.map((t) => (
                <li key={t} className="rounded-full bg-emerald-50 px-3 py-1 text-sm text-emerald-800">
                  {t}
                </li>
              ))}
            </ul>
          </section>
        )}

        {profile.need_tags.length > 0 && (
          <section className="mt-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Ищу</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {profile.need_tags.map((t) => (
                <li key={t} className="rounded-full bg-sky-50 px-3 py-1 text-sm text-sky-800">
                  {t}
                </li>
              ))}
            </ul>
          </section>
        )}

        {profile.languages.length > 0 && (
          <p className="mt-4 text-sm text-neutral-500">Языки: {profile.languages.join(", ")}</p>
        )}

        {profile.contacts.length > 0 && (
          <section className="mt-6 border-t border-neutral-100 pt-6">
            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Контакты</h2>
            <ul className="mt-3 space-y-2">
              {profile.contacts.map((c) => {
                const href = contactHref(c);
                return (
                  <li key={c.kind} className="flex items-baseline gap-3 text-sm">
                    <span className="w-24 shrink-0 text-neutral-500">{KIND_LABELS[c.kind]}</span>
                    {href ? (
                      <a
                        className="break-all font-medium underline hover:text-neutral-800"
                        href={href}
                        rel="noopener noreferrer nofollow"
                      >
                        {c.value}
                      </a>
                    ) : (
                      <span className="break-all font-medium">{c.value}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="mt-8 flex flex-col gap-3 border-t border-neutral-100 pt-6 sm:flex-row">
          <Link
            href={`/api/public/profiles/${profile.slug}/vcard`}
            prefetch={false}
            className="rounded-xl bg-neutral-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-neutral-700"
          >
            Скачать vCard
          </Link>
          <Link
            href={`/api/public/profiles/${profile.slug}/qr.svg`}
            prefetch={false}
            className="rounded-xl border border-neutral-300 px-4 py-2 text-center text-sm font-medium hover:bg-neutral-50"
          >
            QR-код
          </Link>
        </div>
      </article>
    </main>
  );
}
