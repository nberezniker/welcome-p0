import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { SESSION_COOKIE, getSessionByToken } from '../../../lib/auth';
import { loadActiveSessions } from '../../../lib/sessions';
import { getT } from '../../../i18n';
import { getMfaCredential, unusedRecoveryCodeCount } from '../../../lib/mfa';
import { SecurityPanel, type SecurityStrings } from './security-panel';
import { SessionsPanel, type SessionsStrings } from './sessions-panel';

export const metadata: Metadata = { title: 'Безопасность', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * /me/security — F-03: MFA self-service. Shows the TOTP factor status and the
 * enable/confirm/disable flow. Secrets and recovery codes only ever appear
 * once, in the client panel, right after they are issued — the server page
 * itself never receives them.
 *
 * It also lists the account's ACTIVE DEVICES (sessions): an opaque id, two
 * timestamps and which one is this browser. No token, no user-agent, no IP —
 * the server never has those to hand out.
 */
export default async function SecurityPage() {
  const accountId = await requireAccountId('/me/security');
  const { locale, t } = await getT();
  const sql = getSql();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await getSessionByToken(token) : null;

  const [credential, unusedCodes, sessions] = await Promise.all([
    getMfaCredential(sql, accountId),
    unusedRecoveryCodeCount(sql, accountId),
    loadActiveSessions(sql, accountId, session?.sessionId ?? null),
  ]);

  const strings: SecurityStrings = {
    title: t('sec.title'),
    subtitle: t('sec.subtitle'),
    statusOn: t('sec.status.on'),
    statusOff: t('sec.status.off'),
    statusPending: t('sec.status.pending'),
    recoveryRemaining: t('sec.recoveryRemaining', { count: unusedCodes }),
    enable: t('sec.enable'),
    enabling: t('sec.enabling'),
    disable: t('sec.disable'),
    disabling: t('sec.disabling'),
    emailLabel: t('sec.emailLabel'),
    emailHint: t('sec.emailHint'),
    scanTitle: t('sec.scanTitle'),
    secretLabel: t('sec.secretLabel'),
    recoveryTitle: t('sec.recoveryTitle'),
    recoveryNote: t('sec.recoveryNote'),
    confirmTitle: t('sec.confirmTitle'),
    confirmCta: t('sec.confirmCta'),
    confirming: t('sec.confirming'),
    codeLabel: t('sec.codeLabel'),
    savedToast: t('sec.savedToast'),
    disabledToast: t('sec.disabledToast'),
    errorInvalidCode: t('sec.errorInvalidCode'),
    errorGeneric: t('sec.errorGeneric'),
  };

  const sessionsStrings: SessionsStrings = {
    title: t('sec.sessionsTitle'),
    subtitle: t('sec.sessionsSubtitle'),
    currentBadge: t('sec.sessionsCurrent'),
    createdLabel: t('sec.sessionsCreated'),
    lastSeenLabel: t('sec.sessionsLastSeen'),
    revoke: t('sec.sessionsRevoke'),
    revoking: t('sec.sessionsRevoking'),
    revokeAll: t('sec.sessionsRevokeAll'),
    revokeAllConfirmTitle: t('sec.sessionsRevokeAllConfirmTitle'),
    revokeAllConfirmBody: t('sec.sessionsRevokeAllConfirmBody'),
    revokeConfirmTitle: t('sec.sessionsRevokeConfirmTitle'),
    revokeConfirmBody: t('sec.sessionsRevokeConfirmBody'),
    confirm: t('common.confirm'),
    cancel: t('common.cancel'),
    empty: t('sec.sessionsEmpty'),
    revokedToast: t('sec.sessionsRevokedToast'),
    errorGeneric: t('common.errorGeneric'),
    errorNetwork: t('common.errorNetwork'),
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{strings.title}</h1>
      <p className="mt-1.5 text-sm text-muted">{strings.subtitle}</p>
      <div className="mt-6">
        <SecurityPanel
          enabled={credential?.confirmed_at != null}
          pending={credential != null && credential.confirmed_at == null}
          unusedCodes={unusedCodes}
          strings={strings}
        />
      </div>
      <div className="mt-6">
        <SessionsPanel sessions={sessions} locale={locale} strings={sessionsStrings} />
      </div>
    </div>
  );
}
