'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Modal, Toast, useToast } from '../../../components/modal';
import { fill } from '../../../components/fill';
import type { LinkKind } from '../../../domain/links';

/** Contact kinds a member can choose to reveal on mutual acceptance. */
const REVEAL_KINDS: readonly LinkKind[] = ['linkedin_url', 'website', 'github_url', 'telegram_username', 'whatsapp'];

/**
 * Card CTA.
 *
 * The introduction flow is event-scoped and requires mutual consent, so the card
 * only offers it when the viewer shares an active event membership with the card
 * owner (the server passes both the event id and the target profile id in that
 * case — ids the viewer can already see in that event's directory). Everyone else
 * gets a sign-in link: contacts are never revealed from a public card.
 *
 * WHERE IT RENDERS. The card puts this in its HERO, directly under the name and
 * the role, so the page's primary action is on the first screen at 390px (before
 * that it sat at the bottom of a ~1070px card and never was). That is also why
 * the wrapper carries no `border-t`/`pt-5`: those were the separators of the
 * bottom-of-card block, and a rule drawn under a person's name is not a section
 * break. `tests/e2e/design-gate.spec.ts` measures the fold in all three locales.
 */
export function IntroCta({
  profileId,
  eventId,
  displayName,
  kindLabels,
  strings,
}: {
  /** Present only together with eventId, and only for a shared-event viewer. */
  profileId: string;
  eventId: string;
  displayName: string;
  kindLabels: Record<LinkKind, string>;
  strings: {
    ctaIntro: string;
    ctaIntroSent: string;
    ctaIntroAlready: string;
    ctaSignIn: string;
    ctaSignInHint: string;
    revealTitle: string;
    revealHint: string;
    sendRequest: string;
    sending: string;
    cancel: string;
    errorNetwork: string;
    errorGeneric: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState<LinkKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const toast = useToast();

  const send = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/introductions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target_profile_id: profileId, event_id: eventId, reveal_fields: reveal }),
      });
      const body = (await res.json().catch(() => null)) as { already_existed?: boolean } | null;
      if (res.ok) {
        setSent(true);
        setOpen(false);
        toast.show(body?.already_existed ? strings.ctaIntroAlready : strings.ctaIntroSent);
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5">
      <button
        type="button"
        className="btn-accent w-full sm:w-auto"
        disabled={busy || sent}
        onClick={() => setOpen(true)}
        data-testid="pubcard-intro-cta"
      >
        {sent ? strings.ctaIntroSent : strings.ctaIntro}
      </button>
      <p className="mt-2 text-xs text-muted">{strings.ctaSignInHint}</p>

      <Modal open={open} onClose={() => setOpen(false)} title={fill(strings.revealTitle, { name: displayName })}>
        <p className="text-xs text-muted">{strings.revealHint}</p>
        <fieldset className="mt-3">
          <legend className="sr-only">{strings.revealHint}</legend>
          <div className="flex flex-wrap gap-3">
            {REVEAL_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={reveal.includes(kind)}
                  onChange={(e) =>
                    setReveal((prev) => (e.target.checked ? [...prev, kind] : prev.filter((k) => k !== kind)))
                  }
                />
                {kindLabels[kind]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setOpen(false)}>
            {strings.cancel}
          </button>
          <button type="button" className="btn-accent btn-small" disabled={busy} onClick={() => void send()} data-testid="pubcard-send-intro">
            {busy ? strings.sending : strings.sendRequest}
          </button>
        </div>
      </Modal>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}

/** Sign-in CTA shown when the visitor is ANONYMOUS — a visitor with no session
 * has exactly one way to reach the introduction, and this names it. Renders in
 * the card's hero, beside (never instead of) the introduction affordance — see
 * the note on `IntroCta` for why it carries no top rule. */
export function SignInCta({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <div className="mt-5" data-testid="pubcard-signin-cta">
      <Link href={href} className="btn-accent w-full sm:w-auto">
        {label}
      </Link>
      <p className="mt-2 text-xs text-muted">{hint}</p>
    </div>
  );
}

/**
 * The card's third state: the visitor IS signed in, and shares no event with the
 * card's owner — so there is nothing to connect here YET.
 *
 * WHY THIS EXISTS AS A STATE OF ITS OWN. This visitor used to be handed
 * `SignInCta` — "Sign in to connect" — which is a lie: they are already signed
 * in, the link cannot sign them in again, and the action it points at cannot
 * produce a connection. The button that means something to them (propose an
 * introduction) is event-scoped and correctly absent, because there is no event
 * the two of them are both in. What is TRUE here is smaller than a call to
 * action, so this state says it plainly and then names the one honest way
 * forward: the visitor's own events (`href`), because an introduction becomes
 * possible exactly when the two of them are in the same one.
 *
 * WHAT IT DOES NOT DO. It does not reveal which events the card's owner belongs
 * to. `findSharedEvent` (src/lib/public-profile.ts) is the single place that
 * decides a shared event exists, and a negative answer here means no event is
 * named on this page at all — the same privacy boundary the introduction
 * affordance keeps.
 */
export function NoConnectionCta({
  href,
  text,
  label,
  hint,
}: {
  href: string;
  text: string;
  label: string;
  hint: string;
}) {
  return (
    <div className="mt-5" data-testid="pubcard-noconnection-cta">
      <p className="text-sm font-semibold text-ink" data-testid="pubcard-noconnection-text">
        {text}
      </p>
      <Link href={href} className="btn-accent mt-2 w-full sm:w-auto">
        {label}
      </Link>
      <p className="mt-2 text-xs text-muted">{hint}</p>
    </div>
  );
}
