'use client';

import { useState } from 'react';

type Strings = {
  settingsTitle: string;
  accessModeSetting: string;
  joinCodeLabel: string;
  joinCodeSet: string;
  joinCodeClear: string;
  directoryCloseLabel: string;
  settingsSaved: string;
  save: string;
  saving: string;
  errorGeneric: string;
  errorNetwork: string;
};

/** Event access settings (owner/admin): access mode, join code, directory close. */
export function SettingsPanel({
  eventId,
  initialAccessMode,
  initialJoinCodeSet,
  initialDirectoryCloseAt,
  strings,
}: {
  eventId: string;
  initialAccessMode: string;
  initialJoinCodeSet: boolean;
  initialDirectoryCloseAt: string | null;
  strings: Strings;
}) {
  const [accessMode, setAccessMode] = useState(initialAccessMode);
  const [joinCode, setJoinCode] = useState('');
  const [joinCodeSet, setJoinCodeSet] = useState(initialJoinCodeSet);
  const [directoryCloseAt, setDirectoryCloseAt] = useState(initialDirectoryCloseAt ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as { settings?: { join_code_set?: boolean } } | null;
      if (res.ok) {
        setSaved(true);
        setJoinCode('');
        if (body?.settings) setJoinCodeSet(body.settings.join_code_set ?? joinCodeSet);
        setTimeout(() => setSaved(false), 3000);
      } else {
        setError(strings.errorGeneric);
      }
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mt-6" aria-label={strings.settingsTitle} data-testid="settings-panel">
      <h2 className="text-lg font-bold tracking-tight">{strings.settingsTitle}</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="set-access">
            {strings.accessModeSetting}
          </label>
          <select
            id="set-access"
            className="input"
            value={accessMode}
            onChange={(e) => {
              setAccessMode(e.target.value);
              void save({ access_mode: e.target.value });
            }}
          >
            {['public', 'closed', 'registration'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="set-close">
            {strings.directoryCloseLabel}
          </label>
          <input
            id="set-close"
            type="datetime-local"
            className="input"
            value={directoryCloseAt}
            onChange={(e) => setDirectoryCloseAt(e.target.value)}
          />
          <button
            type="button"
            className="btn-light btn-small mt-2"
            disabled={busy || directoryCloseAt === ''}
            onClick={() =>
              void save({ directory_close_at: directoryCloseAt === '' ? null : new Date(directoryCloseAt).toISOString() })
            }
          >
            {strings.save}
          </button>
        </div>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <label className="label" htmlFor="set-code">
          {strings.joinCodeLabel}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="set-code"
            className="input max-w-56"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            autoComplete="off"
            placeholder={joinCodeSet ? strings.joinCodeSet : ''}
          />
          <button
            type="button"
            className="btn-primary btn-small"
            disabled={busy || joinCode.trim().length < 4}
            onClick={() => void save({ join_code: joinCode.trim() })}
            data-testid="set-join-code"
          >
            {strings.saving}
          </button>
          {joinCodeSet ? (
            <button type="button" className="btn-light btn-small" disabled={busy} onClick={() => void save({ join_code: null })}>
              {strings.joinCodeClear}
            </button>
          ) : null}
        </div>
      </div>

      {saved ? (
        <p className="mt-3 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-pine" role="status">
          {strings.settingsSaved}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
