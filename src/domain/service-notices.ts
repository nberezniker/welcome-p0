import { DEFAULT_LOCALE, type Locale } from '../i18n/locale';

/**
 * Service-notice copy for the EMAIL channel (ADR 0011).
 *
 * The Telegram bodies are written for the chat window and (for the "requested"
 * notice only) name the initiator. An email leaves the app's surface — it can be
 * forwarded, indexed and read on a lock screen — so the email channel renders
 * its OWN copy from the notice KIND and never from the payload text:
 *
 *   - no names, no contact values, no reason, no counts;
 *   - the only actionable content is the deep link into the app;
 *   - one subject + one plain-text body, localized (EN / RU / ES).
 *
 * That is why this module takes a kind, not a message: there is no code path
 * that can put a private field into an email body by accident.
 */

/** Outbound kinds that have an email rendering. */
export const SERVICE_NOTICE_KINDS = [
  'intro_requested_notice',
  'intro_mutual_notice',
  'intro_declined_notice',
  'intro_withdrawn_notice',
] as const;

export type ServiceNoticeKind = (typeof SERVICE_NOTICE_KINDS)[number];

export function isServiceNoticeKind(value: unknown): value is ServiceNoticeKind {
  return typeof value === 'string' && (SERVICE_NOTICE_KINDS as readonly string[]).includes(value);
}

/** Deep link into the authenticated introductions page (one route for all four). */
export const INTRODUCTIONS_PATH = '/me/introductions';

interface NoticeCopy {
  readonly subject: string;
  /** `{link}` is replaced with the absolute app URL at render time. */
  readonly body: string;
}

const COPY: Record<ServiceNoticeKind, Record<Locale, NoticeCopy>> = {
  intro_requested_notice: {
    en: {
      subject: 'WELCOME: someone asked to connect',
      body: 'Someone asked to connect with you at WELCOME. Open WELCOME to see the request and answer it — nothing is shared until you both agree.\n\n{link}\n',
    },
    ru: {
      subject: 'WELCOME: вам отправили запрос на знакомство',
      body: 'Вам отправили запрос на знакомство в WELCOME. Откройте WELCOME, чтобы посмотреть запрос и ответить — ничего не раскрывается, пока не согласны оба.\n\n{link}\n',
    },
    es: {
      subject: 'WELCOME: alguien quiere conectar contigo',
      body: 'Alguien quiere conectar contigo en WELCOME. Abre WELCOME para ver la solicitud y responderla: no se comparte nada hasta que ambos estéis de acuerdo.\n\n{link}\n',
    },
  },
  intro_mutual_notice: {
    en: {
      subject: 'WELCOME: you both agreed to connect',
      body: 'The introduction is mutual. The contact details you both chose to share are now visible in WELCOME.\n\n{link}\n',
    },
    ru: {
      subject: 'WELCOME: знакомство состоялось',
      body: 'Знакомство состоялось. Контактные данные, которые вы оба решили раскрыть, теперь видны в WELCOME.\n\n{link}\n',
    },
    es: {
      subject: 'WELCOME: ambos aceptasteis conectar',
      body: 'La presentación es mutua. Los datos de contacto que ambos decidisteis compartir ya están visibles en WELCOME.\n\n{link}\n',
    },
  },
  intro_declined_notice: {
    en: {
      subject: 'WELCOME: the introduction did not happen',
      body: 'An introduction you requested did not go ahead. The answer itself stays private, no contact details were exchanged and nothing further is needed from you.\n\n{link}\n',
    },
    ru: {
      subject: 'WELCOME: знакомство не состоялось',
      body: 'Запрошенное вами знакомство не состоялось. Ответ остаётся приватным, контакты не передавались, от вас больше ничего не требуется.\n\n{link}\n',
    },
    es: {
      subject: 'WELCOME: la presentación no siguió adelante',
      body: 'Una presentación que solicitaste no siguió adelante. La respuesta se mantiene privada, no se intercambiaron contactos y no hace falta que hagas nada más.\n\n{link}\n',
    },
  },
  intro_withdrawn_notice: {
    en: {
      subject: 'WELCOME: the introduction was withdrawn',
      body: 'An introduction was withdrawn before it became mutual. No contact details were exchanged and nothing further is needed from you.\n\n{link}\n',
    },
    ru: {
      subject: 'WELCOME: знакомство отозвано',
      body: 'Знакомство было отозвано до взаимного согласия. Контакты не передавались, от вас больше ничего не требуется.\n\n{link}\n',
    },
    es: {
      subject: 'WELCOME: la presentación se retiró',
      body: 'Una presentación se retiró antes de ser mutua. No se intercambiaron contactos y no hace falta que hagas nada más.\n\n{link}\n',
    },
  },
};

export interface NoticeEmail {
  subject: string;
  text: string;
}

/**
 * Renders one service notice as a plain-text email. `locale` defaults to the
 * product default because WELCOME stores NO per-account locale: the language
 * preference lives in the `welcome_locale` cookie only (src/i18n/locale.ts), so
 * a server-side notification has no stored preference to honor and uses EN.
 * `baseUrl` comes from APP_BASE_URL — never a guessed host.
 */
export function serviceNoticeEmail(
  kind: ServiceNoticeKind,
  baseUrl: string,
  locale: Locale = DEFAULT_LOCALE,
): NoticeEmail {
  const copy = COPY[kind][locale];
  const link = `${baseUrl.replace(/\/+$/, '')}${INTRODUCTIONS_PATH}`;
  return { subject: copy.subject, text: copy.body.replace('{link}', link) };
}

/**
 * Neutral subject for an organizer campaign delivered by email. The BODY is the
 * organizer's own text (verbatim, as the Telegram channel sends it); only the
 * subject is generated, because a campaign has no subject field.
 */
export function campaignEmailSubject(locale: Locale = DEFAULT_LOCALE): string {
  switch (locale) {
    case 'ru':
      return 'WELCOME: сообщение от организатора события';
    case 'es':
      return 'WELCOME: mensaje del organizador del evento';
    default:
      return 'WELCOME: a message from the event organizer';
  }
}
