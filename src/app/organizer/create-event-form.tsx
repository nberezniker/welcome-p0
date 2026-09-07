'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, useToast } from '../../components/modal';
import { COMMON_TIMEZONES } from '../../lib/timezones';

type Strings = {
  createTitle: string;
  nameLabel: string;
  nameError: string;
  modeLabel: string;
  accessModeLabel: string;
  timezoneLabel: string;
  startsLabel: string;
  endsLabel: string;
  locationLabel: string;
  onlineLinkLabel: string;
  descriptionLabel: string;
  consentTextLabel: string;
  slugLabel: string;
  slugHint: string;
  createCta: string;
  creating: string;
  created: string;
  errorGeneric: string;
  errorNetwork: string;
};

const MODE_OPTIONS = [
  { value: 'offline', labelKey: 'offline' },
  { value: 'online', labelKey: 'online' },
  { value: 'hybrid', labelKey: 'hybrid' },
];

/** Create-event form (POST /api/organizer/events). */
export function CreateEventForm({ modeLabels, strings }: { modeLabels: Record<string, string>; strings: Strings }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [mode, setMode] = useState('offline');
  const [accessMode, setAccessMode] = useState('public');
  const [timezone, setTimezone] = useState('Europe/Madrid');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [onlineLink, setOnlineLink] = useState('');
  const [description, setDescription] = useState('');
  const [consentText, setConsentText] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async () => {
    if (name.trim().length === 0) {
      setError(strings.nameError);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        mode,
        access_mode: accessMode,
        timezone,
        starts_at: startsAt === '' ? null : new Date(startsAt).toISOString(),
        ends_at: endsAt === '' ? null : new Date(endsAt).toISOString(),
        location_label: location.trim() === '' ? null : location.trim(),
        online_link: onlineLink.trim() === '' ? null : onlineLink.trim(),
        description: description.trim() === '' ? null : description.trim(),
        consent_text: consentText.trim() === '' ? null : consentText.trim(),
        slug: slug.trim() === '' ? null : slug.trim(),
      };
      const res = await fetch('/api/organizer/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok || res.status === 201) {
        const payload = (await res.json().catch(() => null)) as { event?: { id?: string; slug?: string } } | null;
        toast.show(strings.created, 'success');
        router.refresh();
        const event = payload?.event;
        if (event?.id) {
          router.push(`/organizer/events/${event.id}`);
        }
        return;
      }
      const payload = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(payload?.message ?? strings.errorGeneric);
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h2 className="text-lg font-bold tracking-tight">{strings.createTitle}</h2>

      <div>
        <label className="label" htmlFor="ev-name">
          {strings.nameLabel} <span className="normal-case text-accent">*</span>
        </label>
        <input id="ev-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required data-testid="ev-name" />
        {error ? <p className="field-error">{error}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="ev-mode">
            {strings.modeLabel}
          </label>
          <select id="ev-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {modeLabels[o.labelKey] ?? o.value}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ev-access">
            {strings.accessModeLabel}
          </label>
          <select id="ev-access" className="input" value={accessMode} onChange={(e) => setAccessMode(e.target.value)}>
            {['public', 'closed', 'registration'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="ev-tz">
          {strings.timezoneLabel}
        </label>
        <select id="ev-tz" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {COMMON_TIMEZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="ev-starts">
            {strings.startsLabel}
          </label>
          <input id="ev-starts" type="datetime-local" className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ev-ends">
            {strings.endsLabel}
          </label>
          <input id="ev-ends" type="datetime-local" className="input" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="ev-location">
          {strings.locationLabel}
        </label>
        <input id="ev-location" className="input" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} />
      </div>

      <div>
        <label className="label" htmlFor="ev-online">
          {strings.onlineLinkLabel}
        </label>
        <input id="ev-online" type="url" className="input" value={onlineLink} onChange={(e) => setOnlineLink(e.target.value)} maxLength={500} />
      </div>

      <div>
        <label className="label" htmlFor="ev-desc">
          {strings.descriptionLabel}
        </label>
        <textarea id="ev-desc" className="input min-h-20" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </div>

      <div>
        <label className="label" htmlFor="ev-consent">
          {strings.consentTextLabel}
        </label>
        <textarea id="ev-consent" className="input min-h-16" value={consentText} onChange={(e) => setConsentText(e.target.value)} maxLength={5000} />
      </div>

      <div>
        <label className="label" htmlFor="ev-slug">
          {strings.slugLabel} <span className="normal-case text-muted">({strings.slugHint})</span>
        </label>
        <input id="ev-slug" className="input" value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={64} pattern="[a-z0-9][a-z0-9-]*[a-z0-9]" />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
        <button type="submit" className="btn-primary" disabled={busy} data-testid="ev-submit">
          {busy ? strings.creating : strings.createCta}
        </button>
      </div>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </form>
  );
}
