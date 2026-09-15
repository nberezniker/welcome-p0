import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { hasGrant } from '../../../domain/consent';
import { loadOptInState } from '../../../infra/followup-preferences';
import { digestEnabled, followupReminderDays, followupRemindersEnabled } from '../../../lib/env';
import { NotesList } from './notes-list';
import { FollowupToggles } from './followup-toggles';

export const metadata: Metadata = { title: 'Заметки', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function NotesPage() {
  const accountId = await requireAccountId('/me/notes');
  const { t } = await getT();
  const sql = getSql();
  const nameRows = await sql<{ other_profile_id: string; display_name: string }[]>`
    SELECT cn.other_profile_id, p.display_name
    FROM connection_notes cn
    JOIN profiles p ON p.id = cn.other_profile_id
    WHERE cn.owner_account_id = ${accountId}`;
  const names = Object.fromEntries(nameRows.map((r) => [r.other_profile_id, r.display_name]));

  // Phase 4: the follow-up card exists only while at least one mechanic is
  // switched on for this instance — with both flags off nothing is read and
  // nothing is rendered (the endpoint answers 404 for the same reason).
  const enabled = { reminders: followupRemindersEnabled(), digest: digestEnabled() };
  const followupEnabled = enabled.reminders || enabled.digest;
  const followupState = followupEnabled ? await loadOptInState(sql, accountId) : { reminders: false, digest: false };
  // A reminder needs `service_channel` consent: without it the switch stays
  // disabled with an explanation instead of pretending to work.
  const serviceChannelConsent =
    followupEnabled && enabled.reminders ? await hasGrant(sql, accountId, 'service_channel') : false;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('notes.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('notes.subtitle')}</p>
      {followupEnabled ? (
        <div className="mt-6">
          <FollowupToggles
            initial={followupState}
            enabled={enabled}
            serviceChannelConsent={serviceChannelConsent}
            strings={{
              title: t('followup.title'),
              subtitle: t('followup.subtitle'),
              remindersLabel: t('followup.remindersLabel'),
              // {days} is the REAL configured delay (FOLLOWUP_REMINDER_DAYS), so
              // the copy cannot promise a week the worker is not using.
              remindersHint: t('followup.remindersHint', { days: followupReminderDays() }),
              digestLabel: t('followup.digestLabel'),
              digestHint: t('followup.digestHint'),
              stateOn: t('followup.stateOn'),
              stateOff: t('followup.stateOff'),
              savedToast: t('followup.savedToast'),
              stopHint: t('followup.stopHint'),
              remindersNeedsConsent: t('followup.remindersNeedsConsent'),
              openPrivacy: t('followup.openPrivacy'),
              errorNetwork: t('common.errorNetwork'),
            }}
          />
        </div>
      ) : null}
      <div className="mt-6">
        <NotesList
          names={names}
          strings={{
            empty: t('notes.empty'),
            loading: t('common.loading'),
            noteLabel: t('notes.noteLabel'),
            nextStepLabel: t('notes.nextStepLabel'),
            nextStepStatusLabel: t('notes.nextStepStatusLabel'),
            statusOptions: [
              { value: 'none', label: t('notes.status.none') },
              { value: 'proposed', label: t('notes.status.proposed') },
              { value: 'confirmed', label: t('notes.status.confirmed') },
              { value: 'done', label: t('notes.status.done') },
              { value: 'dropped', label: t('notes.status.dropped') },
            ],
            saveNote: t('notes.saveNote'),
            saving: t('common.saving'),
            savedToast: t('notes.savedToast'),
            noteTooLong: t('notes.noteTooLong'),
            stepTooLong: t('notes.stepTooLong'),
            updatedTemplate: t('notes.updated'),
            errorNetwork: t('common.errorNetwork'),
            errorGeneric: t('common.errorGeneric'),
          }}
        />
      </div>
    </div>
  );
}
