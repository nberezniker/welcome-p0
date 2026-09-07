import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { NotesList } from './notes-list';

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

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('notes.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('notes.subtitle')}</p>
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
