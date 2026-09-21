'use client';

import { useState } from 'react';

/**
 * The SECONDARY calendar option, behind a disclosure: the Google Calendar
 * template link. The primary control — the `.ics` download — stays a plain `<a>`
 * rendered by the page (src/app/e/[slug]/page.tsx), for the reason the interop
 * layer exists at all: a calendar file must not require JavaScript.
 *
 * WHY THERE IS A TOGGLE AND NOT A SECOND BUTTON. The audit found the page
 * rendering `Add to calendar` and `Google Calendar` as two buttons side by side
 * — one action split in two, both competing with the join CTA. The Google
 * template is now reached THROUGH the calendar control rather than beside it,
 * which is why it is not in the document until this disclosure is opened: a
 * collapsed option is not a control the page offers twice.
 *
 * The label comes from the dictionary through the caller: this component names
 * the action it reveals, it does not invent wording (`event.calendarMore`).
 */
export function CalendarOptions({
  googleHref,
  toggleLabel,
  linkLabel,
}: {
  /** The Google template URL — the same one the page has always emitted. */
  googleHref: string;
  /** The disclosure control's own text (`event.calendarMore`). */
  toggleLabel: string;
  /** The revealed link's text (`event.addToGoogleCalendar`). */
  linkLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = 'event-calendar-options';

  return (
    <>
      <button
        type="button"
        className="btn-light"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        data-testid="event-calendar-more"
      >
        {toggleLabel}
      </button>
      {open ? (
        // `w-full` so the revealed option takes its own row instead of pushing
        // the two controls it belongs to apart.
        <div id={panelId} className="flex w-full flex-wrap items-center gap-2" data-testid="event-calendar-options">
          <a
            href={googleHref}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-light"
            data-testid="event-gcal"
          >
            {linkLabel}
          </a>
        </div>
      ) : null}
    </>
  );
}
