'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, Toast, useToast } from '../../../../../components/modal';
import { fill } from '../../../../../components/fill';
import type { TaxonomyCatalog, UiLocale } from '../../../../../domain/picker';
import type { AudienceFilter } from '../../../../../domain/campaigns';
import { SegmentPicker, type SegmentStrings } from './segment-picker';

export interface CampaignItem {
  id: string;
  purpose: 'organizer_marketing' | 'service_channel';
  state: 'draft' | 'approved' | 'running' | 'completed' | 'cancelled';
  content_revision: number;
  approved_revision: number | null;
  body_text: string | null;
  audience_filter: AudienceFilter;
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
  segment: SegmentStrings;
  segmentPreview: string;
  segmentCountTemplate: string;
  approve: string;
  approvedTemplate: string;
  send: string;
  sendTitle: string;
  sendConfirmTemplate: string;
  sendCta: string;
  sending: string;
  sentTemplate: string;
  /** The stop button: label, confirm, in-flight and the two numbers it reports. */
  cancelCampaign: string;
  cancelTitle: string;
  cancelConfirmText: string;
  cancelCta: string;
  cancelling: string;
  cancelResultTemplate: string;
  cancelResultSentTemplate: string;
  cancelTooLate: string;
  statsTitle: string;
  statsLabels: Record<keyof StatsCounters, string>;
  statsNote: string;
  refresh: string;
  errorGeneric: string;
  errorNetwork: string;
  mfaTitle: string;
  mfaText: string;
  mfaCodeLabel: string;
  mfaCta: string;
  mfaVerifying: string;
};

type AudienceData = {
  count: number;
  channel_ready: number;
  sample: { display_name: string }[];
  filter?: AudienceFilter;
  segment?: boolean;
};

/** One campaign card: edit (resets approval), audience preview, approve (owner), send with confirm, live stats. */
export function CampaignCard({
  campaign,
  isOwner,
  catalog,
  locale,
  strings,
}: {
  campaign: CampaignItem;
  isOwner: boolean;
  catalog: TaxonomyCatalog;
  locale: UiLocale;
  strings: Strings;
}) {
  const router = useRouter();
  const [body, setBody] = useState(campaign.body_text ?? '');
  // The segment is edited as local state and only persisted on save; the preview
  // sizes the UNSAVED selection (query overrides) so the organizer can try a
  // segment before writing it to the campaign.
  const [segment, setSegment] = useState<AudienceFilter>(campaign.audience_filter);
  const [editing, setEditing] = useState(false);
  const [audience, setAudience] = useState<AudienceData | null>(null);
  const [stats, setStats] = useState<{ counters: StatsCounters; outcome_codes: { state: string; code: string; count: number }[]; state: string } | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // F-03 step-up: on 403 mfa_required the owner confirms the second factor
  // here and the interrupted action is retried automatically.
  const [mfaOpen, setMfaOpen] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);
  const retryAfterMfa = useRef<(() => Promise<void>) | null>(null);
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

  /** Query string for an unsaved segment: every axis is ALWAYS sent, so an
   * emptied selection means "no segment" instead of falling back to the stored one. */
  const segmentQuery = (filter: AudienceFilter): string => {
    const sp = new URLSearchParams();
    sp.set('need_intents', filter.need_intents.join(','));
    sp.set('offer_intents', filter.offer_intents.join(','));
    sp.set('interests', filter.interests.join(','));
    sp.set('job_function', filter.job_function ?? '');
    sp.set('industry', filter.industry ?? '');
    return sp.toString();
  };

  const loadAudience = async (withFormSegment = false) => {
    const query = withFormSegment ? `?${segmentQuery(segment)}` : '';
    const res = await call(`/api/organizer/campaigns/${campaign.id}/audience${query}`);
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
      // AC-40: editing the body OR the segment bumps the content revision and
      // drops a prior approval — the segment decides who receives the message.
      body: JSON.stringify({ body_text: body, audience_filter: segment }),
    });
    if (!res) return;
    if (res.ok) {
      setEditing(false);
      setNote(null);
      setAudience(null);
      toast.show(strings.savedToast);
      router.refresh();
    } else {
      const payload = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(payload?.message ?? strings.errorGeneric);
    }
  };

  /** Opens the MFA modal when the API answered 403 mfa_required. */
  const gateMfa = async (res: Response, retry: () => Promise<void>): Promise<boolean> => {
    if (res.status !== 403) return false;
    const payload = (await res.json().catch(() => null)) as { code?: string } | null;
    if (payload?.code !== 'mfa_required') return false;
    retryAfterMfa.current = retry;
    setMfaError(null);
    setMfaCode('');
    setMfaOpen(true);
    return true;
  };

  const doApprove = async () => {
    const res = await call(`/api/organizer/campaigns/${campaign.id}/approve`, { method: 'POST' });
    if (!res) return;
    if (await gateMfa(res, doApprove)) return;
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
    if (await gateMfa(res, doSend)) return;
    const payload = (await res.json().catch(() => null)) as { queued?: number } | null;
    if (res.status === 202) {
      setNote(fill(strings.sentTemplate, { queued: payload?.queued ?? 0 }));
      await loadStats();
      router.refresh();
    } else {
      setError(strings.errorGeneric);
    }
  };

  /**
   * The stop button. The API owns the semantics (queued work suppressed, sent
   * work untouched) and reports both numbers back; this only has to say them
   * without rounding one of them to zero. A 409 means the campaign moved out of
   * 'running' between render and click — almost always because it drained — and
   * gets its own sentence rather than the generic error, because "there is
   * nothing left to stop" is a true and useful answer.
   */
  const doCancel = async () => {
    setCancelOpen(false);
    const res = await call(`/api/organizer/campaigns/${campaign.id}/cancel`, { method: 'POST' });
    if (!res) return;
    if (res.ok) {
      const payload = (await res.json().catch(() => null)) as { suppressed?: number; sent?: number } | null;
      setNote(
        `${fill(strings.cancelResultTemplate, { suppressed: payload?.suppressed ?? 0 })} ${fill(
          strings.cancelResultSentTemplate,
          { sent: payload?.sent ?? 0 },
        )}`,
      );
      await loadStats();
      router.refresh();
    } else if (res.status === 409) {
      setError(strings.cancelTooLate);
      router.refresh();
    } else {
      setError(strings.errorGeneric);
    }
  };

  const verifyMfa = async () => {
    setMfaBusy(true);
    setMfaError(null);
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: mfaCode }),
      });
      if (res.ok) {
        setMfaOpen(false);
        const retry = retryAfterMfa.current;
        retryAfterMfa.current = null;
        await retry?.();
      } else {
        setMfaError(strings.errorGeneric);
      }
    } catch {
      setMfaError(strings.errorGeneric);
    } finally {
      setMfaBusy(false);
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
              <SegmentPicker
                catalog={catalog}
                locale={locale}
                value={segment}
                onChange={setSegment}
                strings={strings.segment}
                testId={`segment-${campaign.id}`}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary btn-small"
                  disabled={busy}
                  onClick={() => void doEdit()}
                  data-testid={`campaign-save-${campaign.id}`}
                >
                  {busy ? strings.saving : strings.save}
                </button>
                <button
                  type="button"
                  className="btn-light btn-small"
                  disabled={busy}
                  onClick={() => void loadAudience(true)}
                  data-testid={`campaign-segment-preview-${campaign.id}`}
                >
                  {strings.segmentPreview}
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

      {/*
        THE STOP BUTTON, and where it is NOT offered. It sits OUTSIDE the
        `canEdit` block above on purpose: that block is the campaign's EDITING
        surface and it is closed to a `running` campaign, while `running` is
        exactly the one state this button exists for.

        It renders exactly when the API can carry it out — `running`, the state
        that has queued sends to stop — so the affordance is never a button that
        can only fail. Everything else is answered honestly instead: `draft`/
        `approved` have nothing queued (editing resets an approval), `completed`
        has nothing left to stop, and `cancelled` is already the outcome. The
        server enforces the same rule (409 with the state named), because the UI
        is not the defence; this is the difference between a defence and an
        invitation.
      */}
      {campaign.state === 'running' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* btn-small-tap, not btn-small: the rest of this console is compact by
              design (36px is a deliberate density choice there), but a stop
              button is pressed in a hurry and mid-send, so it takes the 44px
              minimum every touch-facing control here holds to. Compact type,
              bigger box — the same class the card's share strip and the member
              panel's links use, and for the same reason. */}
          <button
            type="button"
            className="btn-light btn-small-tap"
            disabled={busy}
            onClick={() => setCancelOpen(true)}
            data-testid={`campaign-cancel-${campaign.id}`}
          >
            {strings.cancelCampaign}
          </button>
        </div>
      ) : null}
      </div>

      {audience ? (
        <div className="mt-3 rounded-xl bg-paper p-3 text-sm" data-testid={`audience-${campaign.id}`}>
          <p className="font-semibold">{fill(strings.audienceCountTemplate, { count: audience.count, channelReady: audience.channel_ready })}</p>
          {audience.segment ? (
            <p className="mt-1 font-semibold" data-testid={`audience-segment-${campaign.id}`}>
              {fill(strings.segmentCountTemplate, { count: audience.count, channelReady: audience.channel_ready })}
            </p>
          ) : null}
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
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={strings.cancelTitle}>
        {/* The confirm text is where the honest semantics live: what a cancel
            does (suppress what has not been handed to a channel) and what it
            cannot do (recall what has). A confirmation that promised to "stop
            the messages" would be the flattering version of that sentence. */}
        <p className="text-sm">{strings.cancelConfirmText}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setCancelOpen(false)}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn-primary btn-small-tap"
            disabled={busy}
            onClick={() => void doCancel()}
            data-testid="confirm-cancel"
          >
            {busy ? strings.cancelling : strings.cancelCta}
          </button>
        </div>
      </Modal>
      <Modal open={mfaOpen} onClose={() => setMfaOpen(false)} title={strings.mfaTitle}>
        <p className="text-sm">{strings.mfaText}</p>
        {mfaError ? (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {mfaError}
          </p>
        ) : null}
        <label className="label mt-3" htmlFor={`mfa-code-${campaign.id}`}>
          {strings.mfaCodeLabel}
        </label>
        <input
          id={`mfa-code-${campaign.id}`}
          className="input w-40"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          value={mfaCode}
          onChange={(e) => setMfaCode(e.target.value)}
          data-testid={`mfa-stepup-code-${campaign.id}`}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setMfaOpen(false)}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn-primary btn-small"
            disabled={mfaBusy || mfaCode.trim().length === 0}
            onClick={() => void verifyMfa()}
            data-testid={`mfa-stepup-verify-${campaign.id}`}
          >
            {mfaBusy ? strings.mfaVerifying : strings.mfaCta}
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
