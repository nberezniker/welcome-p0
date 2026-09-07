'use client';

import { useEffect, useState } from 'react';
import { Toast, useToast } from '../../../components/modal';

export const CONTACT_KINDS = ['whatsapp', 'telegram_username', 'linkedin_url', 'website', 'phone'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export interface ContactRow {
  kind: ContactKind;
  value: string;
  public_enabled: boolean;
}

type Strings = {
  valueLabel: string;
  valueRequired: string;
  publicEnabled: string;
  publicWarning: string;
  save: string;
  saving: string;
  savedToast: string;
  empty: string;
  loading: string;
  hintEncrypted: string;
  publishedBadge: string;
  privateBadge: string;
  errorNetwork: string;
  errorGeneric: string;
};

/** Contacts manager: GET list → per-kind upsert (PUT /api/me/contacts). */
export function ContactsManager({
  labels,
  strings,
}: {
  labels: Record<ContactKind, string>;
  strings: Strings;
}) {
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { value: string; public_enabled: boolean }>>({});
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/me/contacts');
        const payload = (await res.json().catch(() => null)) as { contacts?: ContactRow[] } | null;
        if (!cancelled && res.ok && payload?.contacts) {
          setContacts(payload.contacts);
          setDrafts(
            Object.fromEntries(
              payload.contacts.map((c) => [c.kind, { value: c.value, public_enabled: c.public_enabled }]),
            ),
          );
        } else if (!cancelled) {
          setContacts([]);
        }
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (kind: ContactKind) => {
    const draft = drafts[kind] ?? { value: '', public_enabled: false };
    const value = draft.value.trim();
    if (value.length < 1 || value.length > 300) {
      setErrors((e) => ({ ...e, [kind]: strings.valueRequired }));
      return;
    }
    setErrors((e) => ({ ...e, [kind]: null }));
    setBusyKind(kind);
    try {
      const res = await fetch('/api/me/contacts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, value, public_enabled: draft.public_enabled }),
      });
      if (res.ok) {
        setContacts((prev) => {
          const base = prev ?? [];
          const exists = base.some((c) => c.kind === kind);
          const next = exists
            ? base.map((c) => (c.kind === kind ? { ...c, value, public_enabled: draft.public_enabled } : c))
            : [...base, { kind, value, public_enabled: draft.public_enabled }];
          return next;
        });
        toast.show(strings.savedToast);
      } else if (res.status === 400) {
        const payload = (await res.json().catch(() => null)) as { code?: string } | null;
        setErrors((e) => ({
          ...e,
          [kind]:
            payload?.code === 'invalid_value'
              ? strings.valueRequired
              : strings.errorGeneric,
        }));
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusyKind(null);
    }
  };

  if (contacts === null) {
    return <p className="text-sm text-muted">{strings.loading}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {contacts.length === 0 ? <p className="text-sm text-muted">{strings.empty}</p> : null}
      {CONTACT_KINDS.map((kind) => {
        const draft = drafts[kind] ?? { value: contacts.find((c) => c.kind === kind)?.value ?? '', public_enabled: contacts.find((c) => c.kind === kind)?.public_enabled ?? false };
        const existing = contacts.find((c) => c.kind === kind);
        const error = errors[kind];
        return (
          <section key={kind} className="card-tight" data-testid={`contact-${kind}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold">{labels[kind]}</h3>
              {existing ? (
                <span className={existing.public_enabled ? 'chip' : 'chip !bg-paper !text-muted'}>
                  {existing.public_enabled ? strings.publishedBadge : strings.privateBadge}
                </span>
              ) : null}
            </div>
            <label className="label mt-2" htmlFor={`contact-value-${kind}`}>
              {strings.valueLabel}
            </label>
            <input
              id={`contact-value-${kind}`}
              className="input"
              value={draft.value}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [kind]: { ...draft, value: e.target.value } }))
              }
              maxLength={300}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `contact-error-${kind}` : `contact-warn-${kind}`}
            />
            {error ? (
              <p id={`contact-error-${kind}`} className="field-error">
                {error}
              </p>
            ) : null}
            <div className="mt-2 flex items-start gap-2">
              <input
                id={`contact-public-${kind}`}
                type="checkbox"
                className="mt-1 size-4"
                checked={draft.public_enabled}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [kind]: { ...draft, public_enabled: e.target.checked } }))
                }
                aria-describedby={`contact-warn-${kind}`}
              />
              <div>
                <label htmlFor={`contact-public-${kind}`} className="text-sm font-semibold">
                  {strings.publicEnabled}
                </label>
                <p id={`contact-warn-${kind}`} className="text-xs leading-relaxed text-muted">
                  {strings.publicWarning}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="btn-primary btn-small mt-3"
              disabled={busyKind === kind}
              onClick={() => void save(kind)}
              data-testid={`contact-save-${kind}`}
            >
              {busyKind === kind ? strings.saving : strings.save}
            </button>
          </section>
        );
      })}
      <p className="text-xs text-muted">{strings.hintEncrypted}</p>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}
