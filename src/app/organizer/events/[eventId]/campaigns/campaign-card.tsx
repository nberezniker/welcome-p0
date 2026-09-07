'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, Toast, useToast } from '../../../../../components/modal';
import { fill } from '../../../../../components/fill';

export interface CampaignItem {
  id: string;
  purpose: 'organizer_marketing' | 'service_channel';
  state: 'draft' | 'approved' | 'running' | 'completed' | 'cancelled';
  content_revision: number;
  approved_revision: number | null;
  body_text: string | null;
}

type StatsCounters = {
  pending: number;
  leased: number;
  sent: number;
  delivered: number;
  failed: number;
  unknown: number;
  suppressed: number;
  cancelled: number;
};

type Strings = {
  purposeLabels: Record<CampaignItem['purpose'], string>;
  stateLabels: Record<CampaignItem['state'], string>;
  revisionTemplate: string;
  approvedRevisionTemplate: string;
  edit: string;
  editTitle: string;
  editWarning: string;
  bodyLabel: string;
  bodyError: string;
  save: string;
  savedToast: string;
  cancel: string;
  saving: string;
  audiencePreview: string;
  audienceCountTemplate: string;
  audienceEmpty: string;
  audienceNote: string;
  approve: string;
  approvedTemplate: string;
  send: string;
  sendTitle: string;
  sendConfirmTemplate: string;
  sendCta: string;
  sending: string;
  sentTemplate: string;
  statsTitle: string;
  statsLabels: Record<keyof StatsCounters, string>;
  statsNote: string;
  refresh: string;
  errorGeneric: string;
  errorNetwork: string;
};

type AudienceData = { count: number; channel_ready: number; sample: { display_name: string }[] };

/** One campaign card: edit (resets approval), audience preview, approve (owner), send with confirm, live stats. */
export function CampaignCard({
  campaign,
  isOwner,
  strings,
}: {
  campaign: CampaignItem;
  isOwner: boolean;
  strings: Strings;
}) {
  const router = useRouter();
  const [body, setBody] = useState(campaign.body_text ?? '');
  const [editing, setEditing] = useState(false);
  const [audience, setAudience] = useState<AudienceData | null>(null);
  const [stats, setStats] = useState<{ counters: StatsCounters; outcome_codes: { state: string; code: string; count: number }[]; state: string } | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const immutable = campaign.state === 'running' || campaign.state === 'completed' || campaign.state === 'cancelled';

  const call = async (path: string, init?: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      return await fetch(path, init);
    } catch {
      setError(strings.errorNetwork);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const loadAudience = async () => {
    const res = await call(`/api/organizer/campaigns/${campaign.id}/audience`);
    if (!res) return;
    const payload = (await res.json().catch(() => null)) as { audience?: AudienceData } | null;
    if (res.ok && payload?.audience) setAudience(payload.audience);
    else setError(strings.errorGeneric);
  };

  const doEdit = async () => {
    if (body.trim().length === 0) {
      setError(strings.bodyError);
      return;
    }
    const res = await call(`/api/organizer/campaigns/${campaign.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body_text: body }),
    });
    if (res && res.ok) {
      setEditing(false);
      setNote(null);
      setAudience(null);
      toast.show(strings.savedToast);
      router.refresh();
    } else if (res) {
      setError(strings.errorGeneric);
    }
  };

  const doApprove = async () => {
    const res = await call(`/api/organizer/campaigns/${campaign.id}/approve`, { method: 'POST' });
    if (!res) return;
    const payload = (await res.json().catch(() => null)) as { audience_count?: number } | null;
    if (res.ok) {
      setNote(fill(strings.approvedTemplate, { count: payload?.audience_count ?? 0 }));
      router.refresh();
    } else if (res.status === 403) {
      setError(strings.errorGeneric);
    } else {
      setError(strings.errorGeneric);
    }
  };

  const doSend = async () => {
    setSendOpen(false);
    const res = await call(`/api/organizer/campaigns/${campaign.id}/send`, { method: 'POST' });
    if (!res) return;
    const payload = (await res.json().catch(() => null)) as { queued?: number } | null;
    if (res.status === 202) {
      setNote(fill(strings.sentTemplate, { queued: payload?.queued ?? 0 }));
      await loadStats();
      router.refresh();
    } else {
      setError(strings.errorGeneric);
    }
  };

  const loadStats = async () => {
    const res = await call(`/api/organizer/campaigns/${campaign.id}/stats`);
    if (!res) return;
    const payload = (await res.json().catch(() => null)) as
      | { counters?: StatsCounters; outcome_codes?: { state: string; code: string; count: number }[]; state?: string }
      | null;
    if (res.ok && payload?.counters) {
      setStats({ counters: payload.counters, outcome_codes: payload.outcome_codes ?? [], state: payload.state ?? campaign.state });
    } else {
      setError(strings.errorGeneric);
    }
  };

  return (
    <section className="card" data-testid={`campaign-${campaign.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="chip">{strings.purposeLabels[campaign.purpose]}</span>
        <span className={campaign.state === 'approved' ? 'chip' : 'chip !bg-paper !text-muted'} data-testid={`campaign-state-${campaign.id}`}>
          {strings.stateLabels[campaign.state]}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-line text-sm">{campaign.body_text ?? ''}</p>
      <p className="mt-1 text-xs text-muted">
        {fill(strings.revisionTemplate, { n: campaign.content_revision })}
        {campaign.approved_revision !== null ? ` · ${fill(strings.approvedRevisionTemplate, { n: campaign.approved_revision })}` : ''}
      </p>

      {note ? (
        <p className="mt-2 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-pine" role="status">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {!isOwner ? <p className="mt-2 text-xs text-muted">{strings.audienceNote}</p> : null}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          <button type="button" className="btn-light btn-small" disabled={busy} onClick={() => void loadStats()} data-testid={`campaign-stats-${campaign.id}`}>
            {strings.statsTitle}
          </button>
      {canEdit(campaign, immutable) ? (
        <>
          {!editing ? (
            <button type="button" className="btn-light btn-small" onClick={() => setEditing(true)} data-testid={`campaign-edit-${campaign.id}`}>
              {strings.edit}
            </button>
          ) : (
            <div className="w-full">
              <p className="rounded-lg bg-accent-pale px-3 py-2 text-xs font-semibold text-accent">{strings.editWarning}</p>
              <label className="label mt-2" htmlFor={`body-${campaign.id}`}>
                {strings.bodyLabel}
              </label>
              <textarea
                id={`body-${campaign.id}`}
                className="input min-h-20"
                value={body}
                maxLength={4000}
                onChange={(e) => setBody(e.target.value)}
              />
              <div className="mt-2 flex gap-2">
                <button type="button" className="btn-primary btn-small" disabled={busy} onClick={() => void doEdit()}>
                  {busy ? strings.saving : strings.save}
                </button>
                <button type="button" className="btn-light btn-small" onClick={() => setEditing(false)}>
                  {strings.cancel}
                </button>
              </div>
            </div>
          )}

          <button type="button" className="btn-light btn-small" disabled={busy} onClick={() => void loadAudience()} data-testid={`campaign-audience-${campaign.id}`}>
            {strings.audiencePreview}
          </button>

          {isOwner && campaign.state === 'draft' ? (
            <button type="button" className="btn-primary btn-small" disabled={busy} onClick={() => void doApprove()} data-testid={`campaign-approve-${campaign.id}`}>
              {strings.approve}
            </button>
          ) : null}

          {campaign.state === 'approved' ? (
            <button
              type="button"
              className="btn-accent btn-small"
              disabled={busy}
              onClick={() => {
                setSendOpen(true);
                if (!audience) void loadAudience();
              }}
              data-testid={`campaign-send-${campaign.id}`}
            >
              {strings.send}
            </button>
          ) : null}

        </>
      ) : null}
      </div>

      {audience ? (
        <div className="mt-3 rounded-xl bg-paper p-3 text-sm" data-testid={`audience-${campaign.id}`}>
          <p className="font-semibold">{fill(strings.audienceCountTemplate, { count: audience.count, channelReady: audience.channel_ready })}</p>
          <p className="mt-1 text-xs text-muted">{strings.audienceNote}</p>
        </div>
      ) : null}

      {stats ? (
        <div className="mt-3" data-testid={`stats-${campaign.id}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-bold">{strings.statsTitle}</h3>
            <button type="button" className="btn-light btn-small" disabled={busy} onClick={() => void loadStats()}>
              {strings.refresh}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(Object.keys(stats.counters) as (keyof StatsCounters)[]).map((key) => (
              <div key={key} className="rounded-lg border border-line bg-paper px-2.5 py-1.5">
                <b className="block text-lg tabular-nums">{stats.counters[key]}</b>
                <span className="text-[11px] text-muted">{strings.statsLabels[key]}</span>
              </div>
            ))}
          </div>
          {stats.outcome_codes.length > 0 ? (
            <p className="mt-2 text-xs text-muted">
              {strings.statsNote} · {stats.outcome_codes.map((o) => `${o.code}: ${o.count}`).join(', ')}
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted">{strings.statsNote}</p>
          )}
        </div>
      ) : null}

      <Modal open={sendOpen} onClose={() => setSendOpen(false)} title={strings.sendTitle}>
        <p className="text-sm">{fill(strings.sendConfirmTemplate, { purpose: strings.purposeLabels[campaign.purpose], count: audience?.count ?? 0 })}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setSendOpen(false)}>
            {strings.cancel}
          </button>
          <button type="button" className="btn-accent btn-small" disabled={busy} onClick={() => void doSend()} data-testid="confirm-send">
            {busy ? strings.sending : strings.sendCta}
          </button>
        </div>
      </Modal>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </section>
  );
}

function canEdit(campaign: CampaignItem, immutable: boolean): boolean {
  return !immutable && campaign.state !== 'running';
}
