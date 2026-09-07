'use client';

import { useEffect, useState } from 'react';
import { Toast, useToast } from '../../../components/modal';
import { fill } from '../../../components/fill';

export interface NoteItem {
  other_profile_id: string;
  note_text: string | null;
  next_step: string | null;
  next_step_status: 'none' | 'proposed' | 'confirmed' | 'done' | 'dropped';
  updated_at: string;
}

type Strings = {
  empty: string;
  loading: string;
  noteLabel: string;
  nextStepLabel: string;
  nextStepStatusLabel: string;
  statusOptions: { value: NoteItem['next_step_status']; label: string }[];
  saveNote: string;
  saving: string;
  savedToast: string;
  noteTooLong: string;
  stepTooLong: string;
  updatedTemplate: string;
  errorNetwork: string;
  errorGeneric: string;
};

/** Saved-contacts notes list (GET /api/me/notes, PUT /api/me/notes/[id]). */
export function NotesList({ names, strings }: { names: Record<string, string>; strings: Strings }) {
  const [notes, setNotes] = useState<NoteItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { note_text: string; next_step: string; next_step_status: NoteItem['next_step_status'] }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/me/notes');
        const payload = (await res.json().catch(() => null)) as { notes?: NoteItem[] } | null;
        if (!cancelled && res.ok && payload?.notes) {
          setNotes(payload.notes);
          setDrafts(
            Object.fromEntries(
              payload.notes.map((n) => [
                n.other_profile_id,
                { note_text: n.note_text ?? '', next_step: n.next_step ?? '', next_step_status: n.next_step_status },
              ]),
            ),
          );
        } else if (!cancelled) {
          setNotes([]);
        }
      } catch {
        if (!cancelled) setNotes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    if (draft.note_text.length > 5000) {
      toast.show(strings.noteTooLong, 'error');
      return;
    }
    if (draft.next_step.length > 500) {
      toast.show(strings.stepTooLong, 'error');
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(`/api/me/notes/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          note_text: draft.note_text.trim() === '' ? null : draft.note_text,
          next_step: draft.next_step.trim() === '' ? null : draft.next_step,
          next_step_status: draft.next_step_status,
        }),
      });
      if (res.ok) {
        toast.show(strings.savedToast);
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (notes === null) return <p className="text-sm text-muted">{strings.loading}</p>;
  if (notes.length === 0) return <p className="text-sm text-muted">{strings.empty}</p>;

  return (
    <div className="flex flex-col gap-4">
      {notes.map((n) => {
        const draft = drafts[n.other_profile_id];
        if (!draft) return null;
        return (
          <section key={n.other_profile_id} className="card" data-testid={`note-${n.other_profile_id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-bold">{names[n.other_profile_id] ?? n.other_profile_id}</h3>
              <span className="text-xs text-muted">{fill(strings.updatedTemplate, { date: new Date(n.updated_at).toLocaleString() })}</span>
            </div>
            <label className="label mt-3" htmlFor={`note-text-${n.other_profile_id}`}>
              {strings.noteLabel}
            </label>
            <textarea
              id={`note-text-${n.other_profile_id}`}
              className="input min-h-20"
              value={draft.note_text}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [n.other_profile_id]: { ...draft, note_text: e.target.value } }))
              }
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={`note-step-${n.other_profile_id}`}>
                  {strings.nextStepLabel}
                </label>
                <input
                  id={`note-step-${n.other_profile_id}`}
                  className="input"
                  value={draft.next_step}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [n.other_profile_id]: { ...draft, next_step: e.target.value } }))
                  }
                />
              </div>
              <div>
                <label className="label" htmlFor={`note-status-${n.other_profile_id}`}>
                  {strings.nextStepStatusLabel}
                </label>
                <select
                  id={`note-status-${n.other_profile_id}`}
                  className="input"
                  value={draft.next_step_status}
                  onChange={(e) =>
                    setDrafts((d) => ({
                      ...d,
                      [n.other_profile_id]: { ...draft, next_step_status: e.target.value as NoteItem['next_step_status'] },
                    }))
                  }
                >
                  {strings.statusOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="button"
              className="btn-primary btn-small mt-3"
              disabled={busyId === n.other_profile_id}
              onClick={() => void save(n.other_profile_id)}
              data-testid={`note-save-${n.other_profile_id}`}
            >
              {busyId === n.other_profile_id ? strings.saving : strings.saveNote}
            </button>
          </section>
        );
      })}
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}
