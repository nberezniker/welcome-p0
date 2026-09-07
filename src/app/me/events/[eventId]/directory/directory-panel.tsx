'use client';

import { useEffect, useState } from 'react';
import { Modal, Toast, useToast } from '../../../../../components/modal';
import { fill } from '../../../../../components/fill';

export interface DirectoryMember {
  profile_id: string;
  display_name: string;
  headline: string | null;
  company: string | null;
  offer_tags: string[];
  need_tags: string[];
}

export interface RecommendationItem extends DirectoryMember {
  score: number;
  reasons_for_me: string[];
  reasons_for_them: string[];
}

type Strings = {
  loading: string;
  empty: string;
  closed: string;
  membersTitle: string;
  proposeIntro: string;
  proposed: string;
  introSentToast: string;
  introAlready: string;
  revealChooserTitleTemplate: string;
  revealChooserHint: string;
  sendRequest: string;
  sending: string;
  recommendationsTitle: string;
  recommendationsEmpty: string;
  scoreTemplate: string;
  reasonsForMeTemplate: string;
  reasonsForThemTemplate: string;
  notVisibleNote: string;
  cancel: string;
  errorNetwork: string;
  errorGeneric: string;
};

const ALL_KINDS = ['whatsapp', 'telegram_username', 'linkedin_url', 'website', 'phone'] as const;
type Kind = (typeof ALL_KINDS)[number];

/** Directory list + recommendations strip. Data via the existing APIs. */
export function DirectoryPanel({
  eventId,
  kindLabels,
  strings,
}: {
  eventId: string;
  kindLabels: Record<Kind, string>;
  strings: Strings;
}) {
  const [members, setMembers] = useState<DirectoryMember[] | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationItem[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [chooserMember, setChooserMember] = useState<DirectoryMember | null>(null);
  const [revealKinds, setRevealKinds] = useState<Kind[]>([]);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const toast = useToast();

  const load = async () => {
    try {
      const [dirRes, recRes] = await Promise.all([
        fetch(`/api/events/${eventId}/directory`),
        fetch(`/api/events/${eventId}/recommendations`),
      ]);
      if (dirRes.status === 403) {
        const body = (await dirRes.json().catch(() => null)) as { code?: string } | null;
        if (body?.code === 'directory_closed') setClosed(true);
        setMembers([]);
      } else if (dirRes.ok) {
        const body = (await dirRes.json().catch(() => null)) as { members?: DirectoryMember[] } | null;
        setMembers(body?.members ?? []);
      } else {
        setMembers([]);
      }
      if (recRes.ok) {
        const body = (await recRes.json().catch(() => null)) as { recommendations?: RecommendationItem[] } | null;
        setRecommendations(body?.recommendations ?? []);
      } else {
        setRecommendations([]);
      }
    } catch {
      setMembers([]);
      setRecommendations([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const propose = async () => {
    if (!chooserMember) return;
    setBusy(true);
    try {
      const res = await fetch('/api/introductions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_profile_id: chooserMember.profile_id,
          event_id: eventId,
          reveal_fields: revealKinds,
        }),
      });
      const body = (await res.json().catch(() => null)) as { already_existed?: boolean } | null;
      if (res.ok) {
        setSentTo((prev) => new Set(prev).add(chooserMember.profile_id));
        toast.show(body?.already_existed ? strings.introAlready : strings.introSentToast);
        setChooserMember(null);
        setRevealKinds([]);
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (closed) return <p className="text-sm text-muted">{strings.closed}</p>;
  if (members === null || recommendations === null) return <p className="text-sm text-muted">{strings.loading}</p>;

  return (
    <div className="flex flex-col gap-8">
      {/* Recommendations strip */}
      <section aria-labelledby="recs-heading">
        <h2 id="recs-heading" className="text-lg font-bold tracking-tight">
          {strings.recommendationsTitle}
        </h2>
        {recommendations.length === 0 ? (
          <p className="mt-2 text-sm text-muted" data-testid="recommendations-empty">
            {strings.recommendationsEmpty}
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {recommendations.map((rec) => (
              <article key={rec.profile_id} className="card-tight" data-testid={`rec-${rec.profile_id}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold">{rec.display_name}</h3>
                  <span className="chip">{fill(strings.scoreTemplate, { score: rec.score })}</span>
                </div>
                <p className="text-xs text-muted">{rec.headline ?? rec.company ?? ''}</p>
                {rec.reasons_for_me.length > 0 ? (
                  <p className="mt-2 text-xs text-pine">{fill(strings.reasonsForMeTemplate, { reasons: rec.reasons_for_me.join(', ') })}</p>
                ) : null}
                {rec.reasons_for_them.length > 0 ? (
                  <p className="mt-1 text-xs text-muted">{fill(strings.reasonsForThemTemplate, { reasons: rec.reasons_for_them.join(', ') })}</p>
                ) : null}
                <button
                  type="button"
                  className="btn-light btn-small mt-3 w-full"
                  disabled={busy || sentTo.has(rec.profile_id)}
                  onClick={() => {
                    setChooserMember(rec);
                    setRevealKinds([]);
                  }}
                >
                  {sentTo.has(rec.profile_id) ? strings.proposed : strings.proposeIntro}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Member list */}
      <section aria-labelledby="dir-heading">
        <h2 id="dir-heading" className="text-lg font-bold tracking-tight">{strings.membersTitle}</h2>
        {members.length === 0 ? (
          <p className="mt-2 text-sm text-muted" data-testid="directory-empty">
            {strings.empty}
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 md:grid-cols-2" data-testid="member-list">
            {members.map((m) => (
              <li key={m.profile_id} className="card-tight" data-testid={`member-${m.profile_id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold">{m.display_name}</h3>
                  <span className="text-xs text-muted">{m.company ?? ''}</span>
                </div>
                {m.headline ? <p className="text-xs text-muted">{m.headline}</p> : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.offer_tags.map((tag) => (
                    <span key={`o-${tag}`} className="chip-offer">
                      {tag}
                    </span>
                  ))}
                  {m.need_tags.map((tag) => (
                    <span key={`n-${tag}`} className="chip-need">
                      {tag}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn-primary btn-small mt-3"
                  disabled={busy || sentTo.has(m.profile_id)}
                  onClick={() => {
                    setChooserMember(m);
                    setRevealKinds([]);
                  }}
                  data-testid={`propose-${m.profile_id}`}
                >
                  {sentTo.has(m.profile_id) ? strings.proposed : strings.proposeIntro}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Reveal-fields chooser */}
      <Modal
        open={chooserMember !== null}
        onClose={() => setChooserMember(null)}
        title={chooserMember ? fill(strings.revealChooserTitleTemplate, { name: chooserMember.display_name }) : ''}
      >
        <p className="text-xs text-muted">{strings.revealChooserHint}</p>
        <fieldset className="mt-3">
          <legend className="sr-only">{strings.revealChooserHint}</legend>
          <div className="flex flex-wrap gap-3">
            {ALL_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={revealKinds.includes(kind)}
                  onChange={(e) =>
                    setRevealKinds((prev) => (e.target.checked ? [...prev, kind] : prev.filter((k) => k !== kind)))
                  }
                />
                {kindLabels[kind]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setChooserMember(null)}>
            {strings.cancel}
          </button>
          <button type="button" className="btn-accent btn-small" disabled={busy} onClick={() => void propose()} data-testid="send-intro">
            {busy ? strings.sending : strings.sendRequest}
          </button>
        </div>
      </Modal>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}
