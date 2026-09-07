import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../lib/http';
import { generateEventSlug, validateEventInput, isValidEventSlug } from '../../../../domain/events';
import { ensureOrganizerForAccount } from '../../../../domain/organizer';
import { recordAudit } from '../../../../lib/audit';

interface EventRow {
  id: string;
  slug: string;
  name: string;
  mode: string | null;
  access_mode: string | null;
  status: string;
  starts_at: Date | null;
  ends_at: Date | null;
  timezone: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** POST /api/organizer/events — creates an event; the creator becomes the
 * owner of their (reused) organizer. Status starts as 'active'. */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const input = validateEventInput(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    const bodyObj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    let requestedSlug: string | null = null;
    if (bodyObj.slug !== undefined && bodyObj.slug !== null) {
      if (typeof bodyObj.slug !== 'string' || !isValidEventSlug(bodyObj.slug.trim())) {
        return jsonError(400, 'invalid_slug', 'slug must be 3..64 chars: lowercase letters, digits, dashes');
      }
      requestedSlug = bodyObj.slug.trim();
    }

    const sql = getSql();

    // Organizer-chosen slugs are checked up front for a clear error message;
    // generated slugs retry on the (unlikely) collision.
    if (requestedSlug) {
      const taken = await sql<{ id: string }[]>`SELECT id FROM events WHERE slug = ${requestedSlug} LIMIT 1`;
      if (taken[0]) return jsonError(409, 'slug_taken', 'This event slug is already in use');
    }

    const organizerId = await ensureOrganizerForAccount(sql, auth.accountId, input.value.name);

    const insert = async (slug: string) =>
      sql<EventRow[]>`
        INSERT INTO events (organizer_id, slug, name, mode, access_mode, max_participants,
                            location_label, online_link, description, consent_text,
                            starts_at, ends_at, timezone, status)
        VALUES (${organizerId}, ${slug}, ${input.value.name}, ${input.value.mode}, ${input.value.accessMode},
                ${input.value.maxParticipants}, ${input.value.locationLabel}, ${input.value.onlineLink},
                ${input.value.description}, ${input.value.consentText},
                ${input.value.startsAt}, ${input.value.endsAt}, ${input.value.timezone}, 'active')
        RETURNING id, slug, name, mode, access_mode, status, starts_at, ends_at, timezone
      `;

    let row: EventRow | undefined;
    if (requestedSlug) {
      row = (await insert(requestedSlug))[0];
    } else {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          row = (await insert(generateEventSlug()))[0];
          if (row) break;
        } catch (err) {
          if (!isUniqueViolation(err) || attempt === 4) throw err;
        }
      }
    }
    if (!row) {
      return jsonError(500, 'internal_error', 'Unexpected error. Please retry later.', { retryable: true });
    }

    await recordAudit(sql, auth.accountId, 'event.created', 'event', row.id, {
      slug: row.slug,
      access_mode: row.access_mode,
    });

    return jsonOk({ ok: true, event: row }, { status: 201 });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);
