import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadPublicProfile } from "../../../lib/public-profile";
import type { PublicContact } from "../../../lib/public-profile";
import { getT } from "../../../i18n";

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

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { t } = await getT();
  const profile = await loadPublicProfile(slug);
  if (!profile) notFound();

  const kindLabels: Record<PublicContact["kind"], string> = {
    whatsapp: "WhatsApp",
    telegram_username: "Telegram",
    linkedin_url: "LinkedIn",
    website: t("contacts.kind.website"),
    phone: t("contacts.kind.phone"),
  };

  // All user-controlled text is rendered as escaped React text. No HTML injection.
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      <article className="card">
        <h1 className="text-3xl font-extrabold tracking-tight">{profile.display_name}</h1>
        {profile.headline && <p className="mt-2 text-lg text-muted">{profile.headline}</p>}
        {profile.company && <p className="mt-1 text-muted">{profile.company}</p>}
        {profile.short_bio && <p className="mt-4 whitespace-pre-line text-ink">{profile.short_bio}</p>}

        {profile.offer_tags.length > 0 && (
          <section className="mt-6">
            <h2 className="eyebrow">{t("pubcard.offering")}</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {profile.offer_tags.map((tag) => (
                <li key={tag} className="chip-offer">
                  {tag}
                </li>
              ))}
            </ul>
          </section>
        )}

        {profile.need_tags.length > 0 && (
          <section className="mt-4">
            <h2 className="eyebrow">{t("pubcard.lookingFor")}</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {profile.need_tags.map((tag) => (
                <li key={tag} className="chip-need">
                  {tag}
                </li>
              ))}
            </ul>
          </section>
        )}

        {profile.languages.length > 0 && (
          <p className="mt-4 text-sm text-muted">
            {t("pubcard.languages")}: {profile.languages.join(", ")}
          </p>
        )}

        {profile.contacts.length > 0 ? (
          <section className="mt-6 border-t border-line pt-6">
            <h2 className="eyebrow">{t("pubcard.contacts")}</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {profile.contacts.map((c) => {
                const href = contactHref(c);
                return (
                  <li key={c.kind} className="flex items-baseline gap-3 text-sm">
                    <span className="w-24 shrink-0 text-muted">{kindLabels[c.kind]}</span>
                    {href ? (
                      <a
                        className="break-all font-medium underline underline-offset-2 hover:text-ink"
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
        ) : (
          <p className="mt-6 border-t border-line pt-6 text-sm text-muted">{t("pubcard.contactsEmpty")}</p>
        )}

        <div className="mt-8 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row">
          <Link
            href={`/api/public/profiles/${profile.slug}/vcard`}
            prefetch={false}
            className="btn-primary"
          >
            {t("pubcard.vcard")}
          </Link>
          <Link href={`/api/public/profiles/${profile.slug}/qr.svg`} prefetch={false} className="btn-light">
            {t("pubcard.qr")}
          </Link>
        </div>
        <p className="mt-4 text-xs text-muted">{t("pubcard.buildNote")}</p>
      </article>
    </main>
  );
}
