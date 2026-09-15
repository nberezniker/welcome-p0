import type { ReactElement } from 'react';

/**
 * Markup for the public preview cards behind /p/[slug]/opengraph-image and
 * /e/[slug]/opengraph-image.
 *
 * Two rules shape this module:
 *
 * 1. PRIVACY BY TYPE. Both builders take a narrow input — the exact list of
 *    values a public preview is allowed to render. A private field (a goal, a
 *    contact value, the event `online_link`, attendance or consent state) has no
 *    slot, so passing one in is a compile error at the call site; and because
 *    the builders only read the fields they name (they never spread the input or
 *    walk its keys), a value arriving through a wider object at runtime cannot
 *    reach the markup either. The OG routes feed these builders from the same
 *    public projections the pages use (src/lib/public-profile.ts,
 *    src/lib/event-view.ts), so "what the page shows" and "what the preview
 *    shows" cannot drift apart.
 *
 * 2. NO BROWSER, NO CASCADE. next/og renders through satori: flexbox only, no
 *    CSS cascade, no variables. Hence literal colours (mirroring the @theme
 *    tokens in src/app/globals.css, which satori cannot read) and inline styles.
 *    Text is elided because satori lays text out but does not shrink it — an
 *    over-long value would push the footer off a fixed 1200×630 canvas.
 */

/** Fixed canvas of both preview routes (re-exported as their `size`). */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

const INK = '#18241f';
const MUTED = '#59665e';
const PAPER = '#f5f4ee';
const ACCENT = '#c93d26';

/** Longest value kept, in characters. The image is a preview: the full value is
 * one click away in the page that links to it. */
const MAX_TITLE_CHARS = 46;
const MAX_LINE_CHARS = 88;

/**
 * The public half of a person card. Deliberately NOT `PublicProfile`: the type
 * is the privacy boundary, so a caller cannot hand a builder a value that must
 * never appear in a public image.
 */
export interface OgPersonCard {
  readonly displayName: string;
  readonly headline?: string | null;
  readonly company?: string | null;
  /** Site host printed as the card footer (see hostFromBaseUrl). */
  readonly host?: string | null;
}

/**
 * The public half of an event card. `when` is preformatted by
 * src/lib/event-time.ts so the page and its preview agree on the string; the
 * event description is deliberately absent even though the page shows it — an
 * organizer can paste anything (including the room link) into free text, and a
 * public image is the wrong place to discover that.
 */
export interface OgEventCard {
  readonly title: string;
  readonly when?: string | null;
  readonly place?: string | null;
  readonly host?: string | null;
}

/** Whitespace-collapsed text, or null when there is nothing worth rendering. */
function filled(value: string | null | undefined): string | null {
  const flat = value?.trim().replace(/\s+/g, ' ');
  return flat ? flat : null;
}

/** Collapses whitespace and elides at `max` characters (see rule 2 above). */
function elide(value: string, max: number): string {
  const flat = value.trim().replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The host a preview card footers. Derived from `appBaseUrl()` (src/lib/env.ts)
 * so the footer follows the configured site rather than a hardcoded string.
 *
 * `hostname` and not `host`: the port a developer happens to run on is not part
 * of the site's identity. A value URL() rejects yields '' and simply drops the
 * footer — a cosmetic line must never take an image route down.
 */
export function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/** Shared card frame: the accent dot + wordmark row, the body, the footer. */
function cardFrame(body: ReactElement, host: string | null): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        height: '100%',
        padding: '64px 72px',
        backgroundColor: PAPER,
        color: INK,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div
          style={{
            display: 'flex',
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: ACCENT,
            marginRight: 14,
          }}
        />
        <div style={{ display: 'flex', fontSize: 24, fontWeight: 700, letterSpacing: 4, color: MUTED }}>
          WELCOME
        </div>
      </div>
      {body}
      {host ? <div style={{ display: 'flex', fontSize: 26, color: MUTED }}>{host}</div> : null}
    </div>
  );
}

/** Body of a person preview: name, then the optional headline and company. */
export function personCardMarkup(card: OgPersonCard): ReactElement {
  const headline = filled(card.headline);
  const company = filled(card.company);
  return cardFrame(
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', fontSize: 74, fontWeight: 800, lineHeight: 1.15 }}>
        {elide(card.displayName, MAX_TITLE_CHARS)}
      </div>
      {headline ? (
        <div style={{ display: 'flex', fontSize: 34, color: MUTED, marginTop: 16 }}>
          {elide(headline, MAX_LINE_CHARS)}
        </div>
      ) : null}
      {company ? (
        <div style={{ display: 'flex', fontSize: 28, fontWeight: 600, marginTop: 10 }}>
          {elide(company, MAX_LINE_CHARS)}
        </div>
      ) : null}
    </div>,
    filled(card.host),
  );
}

/** Body of an event preview: title, then the optional schedule and place. */
export function eventCardMarkup(card: OgEventCard): ReactElement {
  const when = filled(card.when);
  const place = filled(card.place);
  return cardFrame(
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', fontSize: 68, fontWeight: 800, lineHeight: 1.15 }}>
        {elide(card.title, MAX_TITLE_CHARS)}
      </div>
      {when ? (
        <div style={{ display: 'flex', fontSize: 34, color: MUTED, marginTop: 16 }}>
          {elide(when, MAX_LINE_CHARS)}
        </div>
      ) : null}
      {place ? (
        <div style={{ display: 'flex', fontSize: 28, fontWeight: 600, marginTop: 10 }}>
          {elide(place, MAX_LINE_CHARS)}
        </div>
      ) : null}
    </div>,
    filled(card.host),
  );
}
