'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TagInput } from '../../../components/tag-input';
import { Toast, useToast } from '../../../components/modal';

export interface MembershipItem {
  membershipId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  eventMode: string;
  state: string;
  directoryVisible: boolean;
  matchingEnabled: boolean;
  offerTags: string[];
  needTags: string[];
}

type Strings = {
  openEvent: string;
  openDirectory: string;
  leftBadge: string;
  leave: string;
  leaveConfirm: string;
  leftToast: string;
  intentTitle: string;
  offerTagsLabel: string;
  needTagsLabel: string;
  directoryVisible: string;
  directoryVisibleHint: string;
  matchingEnabled: string;
  matchingEnabledHint: string;
  savedToast: string;
  save: string;
  saving: string;
  tagPlaceholder: string;
  errorNetwork: string;
  errorGeneric: string;
};

/** Per-event membership editor: intent tags, visibility, matching, leave. */
export function MembershipEditor({ membership, strings }: { membership: MembershipItem; strings: Strings }) {
  const router = useRouter();
  const [offerTags, setOfferTags] = useState(membership.offerTags);
  const [needTags, setNeedTags] = useState(membership.needTags);
  const [directoryVisible, setDirectoryVisible] = useState(membership.directoryVisible);
  const [matchingEnabled, setMatchingEnabled] = useState(membership.matchingEnabled);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(membership.state !== 'active');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const toast = useToast();

  const patch = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/me/memberships/${membership.membershipId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        if (payload['state'] === 'left') {
          setLeft(true);
          toast.show(strings.leftToast);
        } else {
          toast.show(strings.savedToast);
        }
        router.refresh();
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
      setConfirmLeave(false);
    }
  };

  return (
    <section className="card" data-testid={`membership-${membership.eventId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold tracking-tight">{membership.eventName}</h3>
        <span className={left ? 'chip !bg-paper !text-muted' : 'chip'}>{left ? strings.leftBadge : '✓'}</span>
      </div>
      <p className="mt-1 text-xs uppercase tracking-wide text-muted">{membership.eventMode}</p>

      {!left ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
          <p className="text-sm font-bold">{strings.intentTitle}</p>
          <TagInput
            id={`offer-${membership.membershipId}`}
            label={strings.offerTagsLabel}
            values={offerTags}
            onChange={setOfferTags}
            placeholder={strings.tagPlaceholder}
          />
          <TagInput
            id={`need-${membership.membershipId}`}
            label={strings.needTagsLabel}
            values={needTags}
            onChange={setNeedTags}
            placeholder={strings.tagPlaceholder}
          />
          <button
            type="button"
            className="btn-primary btn-small self-start"
            disabled={busy}
            onClick={() => void patch({ offer_tags: offerTags, need_tags: needTags })}
            data-testid={`save-intent-${membership.eventId}`}
          >
            {busy ? strings.saving : strings.save}
          </button>

          <div className="flex items-start gap-2">
            <input
              id={`dir-${membership.membershipId}`}
              type="checkbox"
              className="mt-1 size-4"
              checked={directoryVisible}
              disabled={busy}
              onChange={(e) => {
                setDirectoryVisible(e.target.checked);
                void patch({ directory_visible: e.target.checked });
              }}
              aria-describedby={`dir-hint-${membership.membershipId}`}
              data-testid={`dir-toggle-${membership.eventId}`}
            />
            <div>
              <label htmlFor={`dir-${membership.membershipId}`} className="text-sm font-semibold">
                {strings.directoryVisible}
              </label>
              <p id={`dir-hint-${membership.membershipId}`} className="text-xs leading-relaxed text-muted">
                {strings.directoryVisibleHint}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <input
              id={`match-${membership.membershipId}`}
              type="checkbox"
              className="mt-1 size-4"
              checked={matchingEnabled}
              disabled={busy}
              onChange={(e) => {
                setMatchingEnabled(e.target.checked);
                void patch({ matching_enabled: e.target.checked });
              }}
              aria-describedby={`match-hint-${membership.membershipId}`}
              data-testid={`matching-toggle-${membership.eventId}`}
            />
            <div>
              <label htmlFor={`match-${membership.membershipId}`} className="text-sm font-semibold">
                {strings.matchingEnabled}
              </label>
              <p id={`match-hint-${membership.membershipId}`} className="text-xs leading-relaxed text-muted">
                {strings.matchingEnabledHint}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <a href={`/e/${membership.eventSlug}`} className="btn-light btn-small">
              {strings.openEvent}
            </a>
            <a href={`/me/events/${membership.eventId}/directory`} className="btn-light btn-small">
              {strings.openDirectory}
            </a>
            {!confirmLeave ? (
              <button type="button" className="btn-light btn-small !text-accent" disabled={busy} onClick={() => setConfirmLeave(true)}>
                {strings.leave}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2" role="alert">
                <span className="text-xs text-muted">{strings.leaveConfirm}</span>
                <button type="button" className="btn-light btn-small" onClick={() => setConfirmLeave(false)}>
                  ✕
                </button>
                <button
                  type="button"
                  className="btn-danger btn-small"
                  disabled={busy}
                  onClick={() => void patch({ state: 'left' })}
                  data-testid={`confirm-leave-${membership.eventId}`}
                >
                  {strings.leave}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </section>
  );
}
