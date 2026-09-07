'use client';

import { useEffect, useState } from 'react';
import { Modal, Toast, useToast } from '../../../components/modal';

export type ContactKind = 'whatsapp' | 'telegram_username' | 'linkedin_url' | 'website' | 'phone';
export const ALL_KINDS: ContactKind[] = ['whatsapp', 'telegram_username', 'linkedin_url', 'website', 'phone'];

interface IntroDetail {
  introduction: {
    id: string;
    state: 'pending' | 'mutual' | 'declined' | 'revoked';
    my_decision: 'pending' | 'accept' | 'decline' | 'withdraw';
    other_accepted: boolean;
  };
  revealed: { kind: ContactKind; value: string }[];
}

type Strings = {
  stateLabels: Record<IntroDetail['introduction']['state'], string>;
  otherPending: (name: string) => string;
  waitingForYou: string;
  accept: string;
  decline: string;
  withdraw: string;
  revealFieldsLabel: string;
  revealNone: string;
  responded: string;
  report: string;
  block: string;
  reportDone: string;
  blockDone: string;
  declineNote: string;
  mutualNote: string;
  decisionLabels: Record<IntroDetail['introduction']['my_decision'], string>;
  revealedFrom: (name: string) => string;
  reportModalTitle: string;
  reportReasonLabel: string;
  reportDetailsLabel: string;
  reportSubmit: string;
  cancel: string;
  loading: string;
  errorNetwork: string;
  errorGeneric: string;
};

const REPORT_REASONS = ['spam', 'harassment', 'inappropriate', 'other'] as const;

/** One introduction card: authoritative per-party state via GET /api/introductions/[id]. */
export function IntroCard({
  introId,
  otherName,
  otherAccountId,
  kindLabels,
  strings,
}: {
  introId: string;
  otherName: string;
  /** Counterpart account id (computed server-side for the party only). */
  otherAccountId: string;
  kindLabels: Record<ContactKind, string>;
  strings: Strings;
}) {
  const [detail, setDetail] = useState<IntroDetail | null>(null);
  const [reveal, setReveal] = useState<ContactKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<(typeof REPORT_REASONS)[number]>('spam');
  const [reportDetails, setReportDetails] = useState('');
  const toast = useToast();

  const load = async () => {
    try {
      const res = await fetch(`/api/introductions/${introId}`);
      const payload = (await res.json().catch(() => null)) as IntroDetail | null;
      if (res.ok && payload?.introduction) {
        setDetail(payload);
      } else {
        setDetail(null);
      }
    } catch {
      setDetail(null);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introId]);

  const respond = async (decision: 'accept' | 'decline' | 'withdraw', revealFields?: ContactKind[]) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { decision };
      if (revealFields) body['reveal_fields'] = revealFields;
      const res = await fetch(`/api/introductions/${introId}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.show(strings.responded);
        await load();
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doBlock = async (target: string) => {
    setBusy(true);
    try {
      const res = await fetch('/api/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target_account_id: target }),
      });
      if (res.ok) toast.show(strings.blockDone);
      else toast.show(strings.errorGeneric, 'error');
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doReport = async () => {
    if (!otherAccountId) return;
    setBusy(true);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_account_id: otherAccountId,
          reason: reportReason,
          details: reportDetails.trim() === '' ? null : reportDetails,
        }),
      });
      if (res.ok) {
        toast.show(strings.reportDone);
        setReportOpen(false);
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (detail === null) return <p className="text-sm text-muted">{strings.loading}</p>;

  const state = detail.introduction.state;
  const myDecision = detail.introduction.my_decision;

  return (
    <section className="card" data-testid={`intro-${introId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-bold">{otherName}</h3>
        <span
          className={
            state === 'mutual' ? 'chip' : 'chip !bg-paper !text-muted'
          }
          data-testid={`intro-state-${introId}`}
        >
          {strings.stateLabels[state]}
        </span>
      </div>

      {state === 'pending' && myDecision === 'pending' ? (
        <div className="mt-3">
          <p className="text-sm font-semibold">{strings.waitingForYou}</p>
          <fieldset className="mt-2">
            <legend className="text-xs font-bold uppercase tracking-wide text-muted">{strings.revealFieldsLabel}</legend>
            <div className="mt-1.5 flex flex-wrap gap-3">
              {ALL_KINDS.map((kind) => (
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
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary btn-small"
              disabled={busy}
              onClick={() => void respond('accept', reveal)}
              data-testid={`intro-accept-${introId}`}
            >
              {strings.accept}
            </button>
            <button
              type="button"
              className="btn-light btn-small"
              disabled={busy}
              onClick={() => void respond('decline')}
              data-testid={`intro-decline-${introId}`}
            >
              {strings.decline}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">{strings.declineNote}</p>
        </div>
      ) : null}

      {state === 'pending' && myDecision === 'accept' ? (
        <div className="mt-3">
          <p className="text-sm text-muted">{strings.otherPending(otherName)}</p>
          <button
            type="button"
            className="btn-light btn-small mt-2"
            disabled={busy}
            onClick={() => void respond('withdraw')}
            data-testid={`intro-withdraw-${introId}`}
          >
            {strings.withdraw}
          </button>
        </div>
      ) : null}

      {state === 'pending' && myDecision === 'withdraw' ? (
        <p className="mt-3 text-sm text-muted">{strings.decisionLabels[myDecision]}</p>
      ) : null}

      {state === 'mutual' ? (
        <div className="mt-3" data-testid={`intro-revealed-${introId}`}>
          <p className="text-xs text-muted">{strings.mutualNote}</p>
          {detail.revealed.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{strings.revealNone}</p>
          ) : (
            <div className="mt-2">
              <p className="text-sm font-semibold">{strings.revealedFrom(otherName)}</p>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {detail.revealed.map((r) => (
                  <li key={r.kind} className="card-tight flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-muted">{kindLabels[r.kind]}</span>
                    <span className="font-mono text-sm">{r.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      {state === 'declined' || state === 'revoked' || myDecision !== 'pending' ? (
        <p className="mt-2 text-xs text-muted">{strings.decisionLabels[myDecision]}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <button
          type="button"
          className="btn-light btn-small !text-accent"
          disabled={busy}
          onClick={() => void doBlock(otherAccountId)}
        >
          {strings.block}
        </button>
        <button type="button" className="btn-light btn-small !text-accent" onClick={() => setReportOpen(true)}>
          {strings.report}
        </button>
      </div>

      <Modal open={reportOpen} onClose={() => setReportOpen(false)} title={strings.reportModalTitle}>
        <label className="label" htmlFor={`report-reason-${introId}`}>
          {strings.reportReasonLabel}
        </label>
        <select
          id={`report-reason-${introId}`}
          className="input"
          value={reportReason}
          onChange={(e) => setReportReason(e.target.value as (typeof REPORT_REASONS)[number])}
        >
          {REPORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <label className="label mt-3" htmlFor={`report-details-${introId}`}>
          {strings.reportDetailsLabel}
        </label>
        <textarea
          id={`report-details-${introId}`}
          className="input min-h-20"
          value={reportDetails}
          maxLength={1000}
          onChange={(e) => setReportDetails(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setReportOpen(false)}>
            {strings.cancel}
          </button>
          <button type="button" className="btn-accent btn-small" disabled={busy} onClick={() => void doReport()}>
            {strings.reportSubmit}
          </button>
        </div>
      </Modal>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </section>
  );
}
