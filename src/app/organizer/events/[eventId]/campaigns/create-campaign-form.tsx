'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, useToast } from '../../../../../components/modal';

type Strings = {
  createTitle: string;
  purposeLabel: string;
  bodyLabel: string;
  bodyError: string;
  createCta: string;
  saving: string;
  errorGeneric: string;
  errorNetwork: string;
};

/** Create-campaign form (POST /api/organizer/campaigns) — owner/admin only. */
export function CreateCampaignForm({
  eventId,
  purposeLabels,
  strings,
}: {
  eventId: string;
  purposeLabels: Record<string, string>;
  strings: Strings;
}) {
  const router = useRouter();
  const [purpose, setPurpose] = useState<'organizer_marketing' | 'service_channel'>('organizer_marketing');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async () => {
    if (body.trim().length === 0) {
      setError(strings.bodyError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/organizer/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: eventId, purpose, body_text: body.trim() }),
      });
      if (res.status === 201) {
        setBody('');
        toast.show(strings.createCta, 'success');
        router.refresh();
      } else {
        const payload = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(payload?.message ?? strings.errorGeneric);
      }
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
      data-testid="create-campaign"
    >
      <h2 className="text-lg font-bold tracking-tight">{strings.createTitle}</h2>
      <div className="mt-3">
        <label className="label" htmlFor="camp-purpose">
          {strings.purposeLabel}
        </label>
        <select
          id="camp-purpose"
          className="input"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value as 'organizer_marketing' | 'service_channel')}
        >
          {['organizer_marketing', 'service_channel'].map((p) => (
            <option key={p} value={p}>
              {purposeLabels[p] ?? p}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3">
        <label className="label" htmlFor="camp-body">
          {strings.bodyLabel}
        </label>
        <textarea id="camp-body" className="input min-h-24" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} data-testid="camp-body" />
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <button type="submit" className="btn-primary mt-4" disabled={busy}>
        {busy ? strings.saving : strings.createCta}
      </button>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </form>
  );
}
