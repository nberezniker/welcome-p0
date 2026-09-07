import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { jsonError, internalError } from '../../../../../../lib/http';
import { requireEventRole } from '../../../../../../domain/organizer';
import { neutralizeCsvCell } from '../../../../../../domain/csv';

export const dynamic = 'force-dynamic';

/** GET /api/organizer/events/[eventId]/export — owner/admin CSV export of
 * EVENT-SCOPED data only:
 *   1. registrations: imported_name, claim_state, approval_status — emails
 *      (plaintext or lookup hashes) are NEVER selected;
 *   2. members who opted into the directory: display_name, headline, company,
 *      tags, attendance_source;
 *   3. per-member intro aggregates (requested/mutual counts) — no pair
 *      identities, no notes, no private contacts.
 * Every cell passes neutralizeCsvCell (CSV formula injection defense);
 * cells containing quotes/commas/newlines are RFC4180-quoted. */

function csvCell(value: string): string {
  const neutral = neutralizeCsvCell(value);
  return /[",\r\n]/.test(neutral) ? `"${neutral.replace(/"/g, '""')}"` : neutral;
}

function csvRow(cells: (string | number | null)[]): string {
  return cells.map((c) => csvCell(c === null ? '' : String(c))).join(',');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventId } = await params;
    const sql = getSql();
    const role = await requireEventRole(sql, auth.accountId, eventId, ['owner', 'admin']);
    if (!role) return jsonError(403, 'forbidden', 'You do not manage this event');

    const eventRows = await sql<{ slug: string }[]>`SELECT slug FROM events WHERE id = ${eventId} LIMIT 1`;
    const event = eventRows[0];
    if (!event) return jsonError(404, 'not_found', 'Event not found');

    // 1. Registrations — no email columns exist in this projection by design.
    const registrations = await sql<{ imported_name: string | null; claim_state: string; approval_status: string }[]>`
      SELECT imported_name, claim_state, approval_status
      FROM registrations
      WHERE event_id = ${eventId}
      ORDER BY created_at ASC, id ASC
    `;

    // 2. Members who opted into the directory (active, active accounts).
    const members = await sql<{
      profile_id: string; display_name: string; headline: string | null; company: string | null;
      offer_tags: string[]; need_tags: string[]; attendance_source: string;
    }[]>`
      SELECT pr.id AS profile_id, pr.display_name, pr.headline, pr.company,
             m.offer_tags, m.need_tags, m.attendance_source
      FROM event_memberships m
      JOIN profiles pr ON pr.id = m.profile_id
      JOIN accounts a ON a.id = pr.account_id
      WHERE m.event_id = ${eventId} AND m.state = 'active'
        AND m.directory_visible = true AND a.status = 'active'
      ORDER BY pr.display_name ASC, pr.id ASC
    `;

    // 3. Per-member intro aggregates within THIS event only. Members outside
    // the directory are never named, so counts cover directory members only.
    const introCounts = await sql<{ profile_id: string; requested: number; mutual: number }[]>`
      SELECT party.profile_id,
             count(*)::int AS requested,
             count(*) FILTER (WHERE i.state = 'mutual')::int AS mutual
      FROM introductions i
      JOIN (
        SELECT m.profile_id
        FROM event_memberships m
        JOIN profiles pr ON pr.id = m.profile_id
        JOIN accounts a ON a.id = pr.account_id
        WHERE m.event_id = ${eventId} AND m.state = 'active'
          AND m.directory_visible = true AND a.status = 'active'
      ) party ON party.profile_id IN (i.profile_a, i.profile_b)
      WHERE i.event_id = ${eventId}
      GROUP BY party.profile_id
    `;
    const counts = new Map<string, { requested: number; mutual: number }>();
    for (const row of introCounts) {
      counts.set(row.profile_id, { requested: row.requested, mutual: row.mutual });
    }

    const lines: string[] = [
      `# WELCOME event export — event-scoped data only for event "${event.slug}": no emails, no encrypted email values, no private contacts, no intro pair identities, no notes.`,
      `# generated_at: ${new Date().toISOString()}`,
      '#',
      '# section: registrations',
      'imported_name,claim_state,approval_status',
    ];
    for (const r of registrations) {
      lines.push(csvRow([r.imported_name, r.claim_state, r.approval_status]));
    }
    lines.push('#', '# section: directory_members', 'display_name,headline,company,tags,attendance_source');
    for (const m of members) {
      const tags = [...m.offer_tags, ...m.need_tags].join(';');
      lines.push(csvRow([m.display_name, m.headline, m.company, tags, m.attendance_source]));
    }
    lines.push('#', '# section: intro_counts', 'display_name,intros_requested,intros_mutual');
    for (const m of members) {
      const c = counts.get(m.profile_id);
      lines.push(csvRow([m.display_name, c?.requested ?? 0, c?.mutual ?? 0]));
    }

    const body = lines.join('\r\n') + '\r\n';
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${event.slug}.csv"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return internalError(err);
  }
}
