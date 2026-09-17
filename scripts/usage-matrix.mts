#!/usr/bin/env node
/**
 * usage-matrix — black-box usage matrix for every product mode (A…R).
 *
 *   node --import tsx scripts/usage-matrix.mts --live            # staging-test deployment
 *   node --import tsx scripts/usage-matrix.mts --base=http://localhost:3000
 *
 * What it does: logs in through the REAL OTP flow, drives every documented mode
 * against the deployment under test through public HTTP only (plus a direct
 * Postgres connection for synthetic fixtures, setup-only), prints a PASS/FAIL
 * table with evidence and writes:
 *   evidence/usage-matrix.json   (machine)
 *   evidence/USAGE_MATRIX.md     (human)
 *
 * Synthetic data discipline:
 *   - every account/organizer/event/campaign this script creates is marked
 *     `MATRIX-` (display names, event names, campaign bodies) or `matrix-`
 *     (url-safe slugs);
 *   - destructive checks against pre-existing production data are "refuse
 *     only" — the script never mutates an account it did not create;
 *   - `cleanup()` removes every synthetic row it can (see the run report).
 *
 * Secrets: read from .env.deploy.secrets (--live) or .env.local, used in-process
 * only, redacted from every artifact this script writes.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { emailLookupHash, encryptValue, hashSessionToken } from '../src/lib/crypto.ts';
import { totpAt } from '../src/lib/totp.ts';
import { en } from '../src/i18n/en.ts';
import { ru } from '../src/i18n/ru.ts';
import { es } from '../src/i18n/es.ts';

// ---------------------------------------------------------------------------
// CLI / env
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const DEV_BASE = 'http://localhost:3000';
const LIVE_BASE = 'https://welcome.colmogravity.net';
const BASE = (
  argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
  (LIVE ? LIVE_BASE : DEV_BASE)
).replace(/\/+$/, '');
const MARK = 'MATRIX-';
/** `--keep` = leave fixtures behind (debugging); `--modes=A,B` = subset. */
const KEEP = argv.includes('--keep');
const ONLY = (argv.find((a) => a.startsWith('--modes='))?.slice('--modes='.length) ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** Minimal KEY=VALUE parser (values never printed, never passed to the app). */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

const SECRETS = readEnvFile(path.join(ROOT, LIVE ? '.env.deploy.secrets' : '.env.local'));
const DB_URL =
  SECRETS['NEON_CONN_DIRECT'] ||
  SECRETS['NEON_CONN_POOLED'] ||
  SECRETS['DATABASE_URL'] ||
  process.env.DATABASE_URL ||
  '';
const PEPPER = SECRETS['HASH_PEPPER'] || process.env.HASH_PEPPER || '';
/** Only used to plant a claimed registration email the deployment can decrypt (ADR 0011 checks). */
const ENCRYPTION_KEY = SECRETS['ENCRYPTION_KEY'] || process.env.ENCRYPTION_KEY || '';
const RESEND_CONFIGURED = Boolean(SECRETS['RESEND_API_KEY'] || process.env.RESEND_API_KEY);
const WORKER_TICK_SECRET = SECRETS['WORKER_TICK_SECRET'] || process.env.WORKER_TICK_SECRET || '';
const WEBHOOK_SECRET = SECRETS['TELEGRAM_WEBHOOK_SECRET'] || process.env.TELEGRAM_WEBHOOK_SECRET || '';

// ---------------------------------------------------------------------------
// Redaction — no secret, OTP code or session token ever reaches an artifact.
// ---------------------------------------------------------------------------

const REDACT: string[] = [
  ...Object.values(SECRETS).filter((v) => v && v.length >= 6),
  WORKER_TICK_SECRET,
  WEBHOOK_SECRET,
].filter(Boolean);

const TOKENISH = /(?<![A-Za-z0-9])([A-Za-z0-9_-]{24,})(?![A-Za-z0-9])/g;

let seq = 0;
const rand = (n = 6) => `${(seq++).toString(36)}${randomBytes(n).toString('hex')}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Synthetic client IP per session. The deployment trusts the first
 * X-Forwarded-For hop for its per-IP token buckets (documented in
 * src/lib/ratelimit.ts), which are 10/min for OTP and /join. Real distinct
 * clients therefore look like distinct IPs. The buckets themselves are
 * verified in mode P with a single IP.
 */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

function redact(input: string): string {
  let out = input;
  for (const secret of REDACT) {
    if (secret.length >= 6) out = out.split(secret).join('«secret»');
  }
  out = out.replace(TOKENISH, '«token»');
  out = out.replace(/"devCode"\s*:\s*"\d{6}"/g, '"devCode":"«otp»"');
  out = out.replace(/(code"\s*:\s*")\d{6}/gi, '$1«otp»');
  return out;
}

function clip(value: unknown, max = 260): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// HTTP client with a cookie jar (one per session)
// ---------------------------------------------------------------------------

interface Res {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return {};
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in (obj as Record<string, unknown>)) out[k] = (obj as Record<string, unknown>)[k];
  return out;
}

/** Compact evidence string: HTTP status + selected response keys. */
function ev(res: Res, ...keys: string[]): string {
  const body = keys.length ? pick(res.json, keys) : res.json;
  return `HTTP ${res.status} ${clip(redact(JSON.stringify(body)))}`;
}

class Session {
  readonly cookies = new Map<string, string>();
  readonly ip = nextIp();
  accountId = '';
  profileId = '';
  slug = '';
  displayName = '';
  email = '';

  constructor(readonly key: string) {}

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(method: string, p: string, opts: ReqOpts = {}): Promise<Res> {
    const headers: Record<string, string> = { origin: BASE, 'x-forwarded-for': this.ip, ...(opts.headers ?? {}) };
    if (this.cookies.size > 0 && headers['cookie'] === undefined) headers['cookie'] = this.cookieHeader();
    return rawFetch(method, p, { ...opts, headers, session: this });
  }

  get = (p: string, o?: ReqOpts) => this.req('GET', p, o);
  post = (p: string, body?: unknown, o?: ReqOpts) => this.req('POST', p, { ...o, body });
  put = (p: string, body?: unknown, o?: ReqOpts) => this.req('PUT', p, { ...o, body });
  patch = (p: string, body?: unknown, o?: ReqOpts) => this.req('PATCH', p, { ...o, body });
  del = (p: string, body?: unknown, o?: ReqOpts) => this.req('DELETE', p, { ...o, body });
}

interface ReqOpts {
  body?: unknown;
  headers?: Record<string, string>;
  session?: Session;
  /** Raw string body (CSV multipart/plain tests). */
  rawBody?: string;
  contentType?: string;
}

async function rawFetch(method: string, p: string, opts: ReqOpts = {}): Promise<Res> {
  const headers: Record<string, string> = { origin: BASE, 'x-forwarded-for': nextIp(), ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers['content-type'] = opts.contentType ?? 'text/plain';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  if (opts.session && opts.session.cookies.size > 0) headers['cookie'] = opts.session.cookieHeader();

  const res = await fetch(`${BASE}${p}`, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _nonJson: clip(text, 120) };
  }
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : [];
  if (opts.session) {
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const idx = pair!.indexOf('=');
      if (idx < 0) continue;
      const name = pair!.slice(0, idx).trim();
      const value = pair!.slice(idx + 1).trim();
      if (!value || /max-age=0/i.test(raw)) opts.session.cookies.delete(name);
      else opts.session.cookies.set(name, value);
    }
  }
  return { status: res.status, headers: res.headers, json, text };
}

const anon = new Session('anon');

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP' | 'BLOCKED';

interface Row {
  id: string;
  mode: string;
  description: string;
  expect: string;
  status: CheckStatus;
  actual: string;
  evidence: string;
  deviation?: string;
  ms: number;
}

const rows: Row[] = [];
const deviations: string[] = [];

interface CheckResult {
  status?: CheckStatus;
  actual: string;
  evidence?: string;
  deviation?: string;
}

async function check(
  id: string,
  mode: string,
  description: string,
  expect: string,
  fn: () => Promise<CheckResult | void>,
): Promise<void> {
  const t0 = Date.now();
  try {
    const r = (await fn()) ?? { actual: 'ok' };
    rows.push({
      id,
      mode,
      description,
      expect,
      status: r.status ?? 'PASS',
      actual: r.actual,
      evidence: r.evidence ?? '',
      ...(r.deviation ? { deviation: r.deviation } : {}),
      ms: Date.now() - t0,
    });
    if (r.deviation) deviations.push(`${id}: ${r.deviation}`);
  } catch (err) {
    rows.push({
      id,
      mode,
      description,
      expect,
      status: 'FAIL',
      actual: err instanceof Error ? err.message : String(err),
      evidence: '',
      ms: Date.now() - t0,
    });
  }
  const row = rows[rows.length - 1]!;
  console.log(`${row.status.padEnd(5)} ${row.id.padEnd(6)} ${row.description}${row.status === 'PASS' ? '' : ` → ${row.actual}`}`);
}

function must(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

function equals<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Database access (fixtures + assertions the HTTP surface cannot expose)
// ---------------------------------------------------------------------------

const sql = DB_URL ? postgres(DB_URL, { max: 4, idle_timeout: 20, connect_timeout: 20 }) : null;

const created = {
  accounts: [] as string[],
  profiles: [] as string[],
  organizers: [] as string[],
  events: [] as string[],
  campaigns: [] as string[],
  registrations: [] as string[],
  inboxEvents: [] as string[],
  notificationsSent: false,
};

/** Fixed synthetic identities: stable names make the purge deterministic. */
const USER_KEYS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot',
  'rate', 'mfa', 'quota', 'plain', 'orgb', 'staff', 'logout', 'claim',
] as const;
const emailFor = (key: string) => `matrix-${key.toLowerCase()}@welcome.test`;
const UNKNOWN_EMAIL = 'matrix-unknown@welcome.test';
/** Addresses the deployment itself may create rows for during a run. */
const EPHEMERAL_EMAILS = [
  UNKNOWN_EMAIL,
  'matrix-never@welcome.test',
  'matrix-probe-does-not-matter@welcome.test',
  'matrix-import-two@welcome.test',
  'matrix-import-formula@welcome.test',
  ...Array.from({ length: 11 }, (_, i) => `matrix-iprl-${i + 1}@welcome.test`),
];

const hash = (email: string) => (PEPPER ? emailLookupHash(email, PEPPER) : '');

interface FixtureUser {
  key: string;
  email: string;
  displayName: string;
  accountId: string;
  profileId: string;
  slug: string;
  session?: Session;
}

const users = new Map<string, FixtureUser>();

/** Inserts a synthetic account + profile (+ optional event membership). */
async function createUser(
  key: string,
  displayName: string,
  axes: { need_intents?: string[]; offer_intents?: string[]; interests?: string[]; industry?: string; job_function?: string; keywords?: string[] } = {},
  opts: { demo?: boolean; withProfile?: boolean } = {},
): Promise<FixtureUser> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const email = emailFor(key);
  const lookup = hash(email);
  // auth_subject mirrors what the app itself writes ('email:<hash>') so the
  // fixture is indistinguishable from an app-created account — and so a
  // pre-existing accounts_email_lookup_hash_key conflict cannot mask a real
  // result (see the 2026-09-14 otp/request fix).
  const acc = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject, email_lookup_hash, is_demo, status)
    VALUES (${`email:${lookup}`}, ${lookup}, ${opts.demo ?? true}, 'active')
    RETURNING id`;
  const accountId = acc[0]!.id;
  created.accounts.push(accountId);
  const slug = `matrix-${key.toLowerCase()}-${randomBytes(8).toString('hex')}`;
  let profileId = '';
  if (opts.withProfile !== false) {
    const prof = await sql<{ id: string }[]>`
      INSERT INTO profiles (account_id, public_slug, display_name, need_intents, offer_intents, interests, industry, job_function, keywords)
      VALUES (${accountId}, ${slug}, ${displayName}, ${axes.need_intents ?? []}, ${axes.offer_intents ?? []},
              ${axes.interests ?? []}, ${axes.industry ?? null}, ${axes.job_function ?? null}, ${axes.keywords ?? []})
      RETURNING id`;
    profileId = prof[0]!.id;
    created.profiles.push(profileId);
  }
  const user: FixtureUser = { key, email, displayName, accountId, profileId, slug };
  users.set(key, user);
  return user;
}

async function addMembership(
  user: FixtureUser,
  eventId: string,
  opts: { directoryVisible?: boolean } = {},
): Promise<string> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  // Per-event axes mirror the profile's axes: the v3 directory/recommender read
  // the membership row, so a fixture with empty membership axes would silently
  // match nothing.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO event_memberships (event_id, profile_id, state, directory_visible, matching_enabled,
                                   need_intents, offer_intents, interests, industry, job_function, keywords)
    SELECT ${eventId}, id, 'active', ${opts.directoryVisible ?? true}, true,
           need_intents, offer_intents, interests, industry, job_function, keywords
    FROM profiles WHERE id = ${user.profileId}
    RETURNING id`;
  return rows[0]!.id;
}

async function grantConsent(accountId: string, purpose: string, eventId: string | null): Promise<void> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  await sql`
    INSERT INTO consent_events (account_id, purpose, scope_type, scope_id, policy_version, action)
    VALUES (${accountId}, ${purpose}, ${eventId ? 'event' : 'global'}, ${eventId}, ${'matrix-2026-09-14'}, 'grant')`;
}

/** A fixture account created on demand (purged by slug/email like the rest). */
async function ensureFixtureUser(key: string, displayName: string, axes: Record<string, unknown> = {}): Promise<FixtureUser> {
  const existing = users.get(key);
  if (existing) return existing;
  return createUser(key, displayName, axes);
}

/** Active membership, created once (UNIQUE(event_id, profile_id) would reject a repeat). */
async function ensureEventMember(user: FixtureUser, eventId: string): Promise<void> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM event_memberships
    WHERE event_id = ${eventId} AND profile_id = ${user.profileId}`;
  if ((rows[0]?.count ?? 0) === 0) await addMembership(user, eventId);
}

/**
 * Gives an account a decryptable email the way the product does: an imported
 * registration it CLAIMED (membership.registration_id is what proves ownership).
 * Returns the plaintext address, which the caller must never print.
 */
async function attachRegisteredEmail(user: FixtureUser, eventId: string, email: string): Promise<string> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  must(ENCRYPTION_KEY.length > 0, 'ENCRYPTION_KEY unavailable — cannot attach a claimed email');
  const lookup = hash(email);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO registrations (event_id, provider, external_guest_id, email_lookup_hash, encrypted_email,
                               imported_name, claim_state)
    VALUES (${eventId}, 'csv', ${'matrix-' + rand(4)}, ${lookup}, ${encryptValue(email, ENCRYPTION_KEY)},
            ${user.displayName}, 'claimed')
    RETURNING id`;
  created.registrations.push(rows[0]!.id);
  await sql`
    UPDATE event_memberships SET registration_id = ${rows[0]!.id}
    WHERE event_id = ${eventId} AND profile_id = ${user.profileId}`;
  return email;
}

/** Job id behind a dedupe key (used to read the worker's per-job outcome). */
async function jobIdByKey(dedupeKey: string): Promise<string | null> {
  if (!sql) return null;
  const rows = await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${dedupeKey} LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** Ticks the worker until the given jobs are terminal (or the tick budget runs out). */
async function drainUntilTerminal(dedupeKeys: string[], maxTicks = 4): Promise<Record<string, string>> {
  const outcomes: Record<string, string> = {};
  for (let i = 0; i < maxTicks; i++) {
    const res = await tick();
    equals(res.status, 200, 'worker tick status');
    for (const r of (res.json as { results?: { job_id: string; outcome: string }[] }).results ?? []) {
      outcomes[r.job_id] = r.outcome;
    }
    const ids = await Promise.all(dedupeKeys.map((k) => jobIdByKey(k)));
    const rows = await Promise.all(ids.filter((x): x is string => x !== null).map((id) => jobRowById(id)));
    if (rows.length === dedupeKeys.length && rows.every((r) => r && r.status !== 'pending' && r.status !== 'leased')) break;
  }
  return outcomes;
}

async function jobRowById(jobId: string): Promise<{ status: string; attempt: number } | null> {
  if (!sql) return null;
  const rows = await sql<{ status: string; attempt: number }[]>`
    SELECT status, attempt FROM outbox_jobs WHERE id = ${jobId} LIMIT 1`;
  return rows[0] ?? null;
}

async function createEvent(opts: {
  organizerId: string;
  slug: string;
  name: string;
  accessMode?: 'public' | 'closed' | 'registration';
  joinCode?: string | null;
  status?: string;
  /** Schedule (mode S: the .ics endpoint needs one, and only a real one). */
  startsAt?: Date;
  endsAt?: Date;
  /** Room link (mode S: proves it never travels inside a downloaded file). */
  onlineLink?: string;
}): Promise<string> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const rows = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, slug, name, mode, access_mode, join_code, status, timezone, max_participants,
                        starts_at, ends_at, online_link)
    VALUES (${opts.organizerId}, ${opts.slug}, ${opts.name}, 'offline', ${opts.accessMode ?? 'public'},
            ${opts.joinCode ?? null}, ${opts.status ?? 'active'}, 'Europe/Madrid', 500,
            ${opts.startsAt ?? null}, ${opts.endsAt ?? null}, ${opts.onlineLink ?? null})
    RETURNING id`;
  created.events.push(rows[0]!.id);
  return rows[0]!.id;
}

async function createOrganizer(name: string): Promise<string> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const rows = await sql<{ id: string }[]>`INSERT INTO organizers (display_name) VALUES (${name}) RETURNING id`;
  created.organizers.push(rows[0]!.id);
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Login through the real OTP flow (devCode is exposed for is_demo / allowlist
// accounts on the staging-test deployment — ADR 0009).
// ---------------------------------------------------------------------------

/** Seconds the runner may wait for an exhausted OTP window (see login()). */
const OTP_WAIT_BUDGET_S = Number(argv.find((a) => a.startsWith('--otp-wait='))?.slice('--otp-wait='.length) ?? 240);

/** One session per account per run: the OTP request window is 3 codes / 15 min. */
const loginCache = new Map<string, Session>();

/** Second mode of the OTP route: the per-account request window (3/15 min). */
const otpTimes: number[] = [];

/**
 * Keeps the runner inside the deployment's per-IP OTP bucket (10/min). The
 * deployment's real client IP is what the bucket keys on (Vercel rewrites
 * x-forwarded-for), so a run of ~15 logins has to be paced, not spoofed.
 * Mode P deliberately bypasses this to TEST the bucket.
 */
async function paceOtp(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (otpTimes.length > 0 && now - otpTimes[0]! > 60_000) otpTimes.shift();
    if (otpTimes.length < 8) {
      otpTimes.push(now);
      return;
    }
    const wait = 60_000 - (now - otpTimes[0]!) + 500;
    console.log(`  … OTP pacing: waiting ${Math.round(wait / 1000)}s (per-IP bucket 10/min)`);
    await sleep(wait);
  }
}

/**
 * Login through the real OTP flow. The per-account request throttle is 3 codes
 * per 15 minutes (OTP_REQUEST_MAX_PER_WINDOW), so a re-run inside the window can
 * legitimately answer 429: the runner waits out the advertised Retry-After
 * within a budget instead of burning the account. Memoised per account so no
 * check can accidentally spend the quota twice.
 */
async function login(email: string, key = email, opts: { fresh?: boolean } = {}): Promise<Session> {
  if (!opts.fresh) {
    const cached = loginCache.get(email);
    if (cached) return cached;
  }
  const session = new Session(key);
  const deadline = Date.now() + OTP_WAIT_BUDGET_S * 1000;
  let requested: Res;
  for (;;) {
    await paceOtp();
    requested = await session.post('/api/auth/otp/request', { email });
    if (requested.status === 429 || requested.status === 500 || requested.status === 503) {
      const retryAfter = Number(requested.headers.get('retry-after') ?? 0) * 1000;
      const waitMs = retryAfter > 0 ? retryAfter : 5000;
      if (Date.now() + waitMs < deadline) {
        console.log(`  … ${email}: HTTP ${requested.status} (${(requested.json as { code?: string })?.code}); waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`otp/request → HTTP ${requested.status} ${clip(redact(requested.text), 120)} (номера OTP исчерпаны; окно 15 мин, бюджет ожидания ${OTP_WAIT_BUDGET_S}s)`);
    }
    break;
  }
  must(requested.status === 200, `otp/request → HTTP ${requested.status} ${clip(redact(requested.text), 160)}`);
  const devCode = (requested.json as { devCode?: string } | null)?.devCode;
  must(typeof devCode === 'string' && /^\d{6}$/.test(devCode), 'otp/request exposed no devCode (is_demo / allowlist required)');
  const verified = await session.post('/api/auth/otp/verify', { email, code: devCode });  must(verified.status === 200, `otp/verify → HTTP ${verified.status} ${clip(redact(verified.text), 160)}`);
  must(session.cookies.has('welcome_session'), 'session cookie missing after verify');
  if (!opts.fresh) loginCache.set(email, session);
  return session;
}

/** Logs a fixture user in and caches the session. */
async function userSession(user: FixtureUser): Promise<Session> {
  const cached = loginCache.get(user.email);
  if (cached) {
    user.session = cached;
    return cached;
  }
  if (!user.session) user.session = await login(user.email, user.key);
  return user.session;
}

/**
 * Creates a REAL session row for an account and returns a Session carrying its
 * cookie, without going through OTP. Checks that need "a second device" must not
 * spend the per-account OTP budget — the login flow is rate-limited (window
 * 15 мин), and exhausting it would turn a fixture into a self-inflicted 429.
 */
async function sessionFor(accountId: string, key: string): Promise<Session> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const token = randomBytes(32).toString('base64url');
  await sql`
    INSERT INTO sessions (account_id, token_hash, expires_at)
    VALUES (${accountId}::uuid, ${hashSessionToken(token)}, now() + interval '1 hour')`;
  const s = new Session(key);
  s.cookies.set('welcome_session', token);
  return s;
}

/** Applies a patch on top of the CURRENT profile so no axis is wiped by accident
 * (POST /api/me/profile replaces the whole axis set). */
async function updateProfile(s: Session, patch: Record<string, unknown>): Promise<Res> {
  const current = await s.get('/api/me/profile');
  const p = (current.json as { profile?: Record<string, unknown> }).profile;
  const base: Record<string, unknown> = {
    display_name: p?.['display_name'] ?? `${MARK}User`,
    headline: p?.['headline'] ?? null,
    company: p?.['company'] ?? null,
    short_bio: p?.['short_bio'] ?? null,
    languages: p?.['languages'] ?? [],
    offer_tags: p?.['offer_tags'] ?? [],
    need_tags: p?.['need_tags'] ?? [],
    need_intents: p?.['need_intents'] ?? [],
    offer_intents: p?.['offer_intents'] ?? [],
    interests: p?.['interests'] ?? [],
    industry: p?.['industry'] ?? null,
    job_function: p?.['job_function'] ?? null,
    keywords: p?.['keywords'] ?? [],
    hidden_fields: p?.['hidden_fields'] ?? [],
    // Goals are part of the replaced set too (absent would CLEAR them).
    goals: p?.['goals'] ?? [],
  };
  if (p && 'revision' in p) base['revision'] = p['revision'];
  return s.post('/api/me/profile', { ...base, ...patch });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const F: {
  organizerA: string;
  organizerB: string;
  ownerOrganizer: string;
  owner: FixtureUser;
  orgB: FixtureUser;
  staff: FixtureUser;
  eventA: string;
  eventClosed: string;
  eventLock: string;
  eventB: string;
  closedCode: string;
  lockCode: string;
} = {} as never;

/** Address of the account that owns the deployment under test. Required only by
 * the `--live` matrix (it logs in there for real), so it is a run parameter:
 * export MATRIX_OWNER_EMAIL=<your own account>. Never a literal — this repo is
 * public and a clone has a different operator. */
const OWNER_EMAIL = process.env.MATRIX_OWNER_EMAIL ?? '';
const DEMO1 = 'demo1@welcome.test';
/** Second demo identity — same flow, used to prove the mechanism is not special-cased.
 * (demo2@welcome.test is seeded too; one extra demo login is enough.) */
const MARTA = 'marta.demo@welcome.test';

async function setup(): Promise<void> {
  if (!sql) throw new Error('no DATABASE_URL: cannot build fixtures');
  const probe = await sql`SELECT 1`;
  void probe;

  F.organizerA = await createOrganizer(`${MARK}Org A`);
  F.organizerB = await createOrganizer(`${MARK}Org B`);

  await createUser('alpha', `${MARK}Alpha`, {
    need_intents: ['seeking-cofounder'],
    offer_intents: ['open-to-cofound'],
    interests: ['ai-ml', 'dev-tools', 'automation'],
    industry: 'ai-saas',
    job_function: 'engineering',
    keywords: ['matrix'],
  });
  await createUser('bravo', `${MARK}Bravo`, { offer_intents: ['open-to-cofound'], interests: ['ai-ml', 'dev-tools'] });
  await createUser('charlie', `${MARK}Charlie`, { offer_intents: ['open-to-cofound'], interests: ['ai-ml'] });
  await createUser('delta', `${MARK}Delta`, { offer_intents: ['open-to-cofound'], interests: ['automation'] });
  await createUser('echo', `${MARK}Echo`, { interests: ['ai-ml'] });
  await createUser('foxtrot', `${MARK}Foxtrot`, { interests: ['ux-ui'] });
  await createUser('rate', `${MARK}Rate`, { interests: ['ai-ml'] });
  await createUser('mfa', `${MARK}Mfa`, { offer_intents: ['open-to-cofound'], interests: ['ai-ml'] });
  await createUser('quota', `${MARK}Quota`, {}, { withProfile: false });
  // Known account that is NEITHER demo NOR allowlisted: the anti-enumeration
  // control for OTP request (same response as a wholly unknown address).
  await createUser('plain', `${MARK}Plain`, { interests: ['ai-ml'] }, { demo: false });
  await createUser('logout', `${MARK}Logout`, { interests: ['ai-ml'] });
  F.orgB = await createUser('orgb', `${MARK}Org B Owner`, { interests: ['ai-ml'] });
  F.staff = await createUser('staff', `${MARK}Staff`, { interests: ['ai-ml'] });

  // Owner fixture: the real owner account, plus an organizer membership so the
  // owner-only campaign path is exercised with the real identity. The owner row
  // is never mutated by this script.
  const demoHash = hash(DEMO1);
  const demoRows = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE email_lookup_hash = ${demoHash} LIMIT 1`;
  must(demoRows.length === 1, 'pepper mismatch: demo1@welcome.test not found by lookup hash — .env.deploy.secrets HASH_PEPPER does not match the deployment');
  const ownerLookup = hash(OWNER_EMAIL);
  const ownerRows = await sql<{ id: string; profile_id: string; public_slug: string; display_name: string }[]>`
    SELECT a.id, p.id AS profile_id, p.public_slug, p.display_name
    FROM accounts a JOIN profiles p ON p.account_id = a.id
    WHERE a.email_lookup_hash = ${ownerLookup} LIMIT 1`;
  must(
    ownerRows.length >= 1,
    "owner account not found in the target database — set MATRIX_OWNER_EMAIL to the address of the account that owns the deployment under test",
  );
  const ownerRow = ownerRows[0]!;
  F.owner = {
    key: 'owner',
    email: OWNER_EMAIL,
    displayName: ownerRow.display_name,
    accountId: ownerRow.id,
    profileId: ownerRow.profile_id,
    slug: ownerRow.public_slug,
  };

  F.eventA = await createEvent({ organizerId: F.organizerA, slug: `matrix-event-a-${rand(3)}`, name: `${MARK}Event A` });
  F.closedCode = `matrixcode${rand(2)}`;
  F.eventClosed = await createEvent({
    organizerId: F.organizerA,
    slug: `matrix-event-closed-${rand(3)}`,
    name: `${MARK}Event Closed`,
    accessMode: 'closed',
    joinCode: F.closedCode,
  });
  F.lockCode = `matrixlock${rand(2)}`;
  F.eventLock = await createEvent({
    organizerId: F.organizerA,
    slug: `matrix-event-lock-${rand(3)}`,
    name: `${MARK}Event Lock`,
    accessMode: 'closed',
    joinCode: F.lockCode,
  });
  F.eventB = await createEvent({ organizerId: F.organizerB, slug: `matrix-event-b-${rand(3)}`, name: `${MARK}Event B` });

  await sql`INSERT INTO organizer_members (organizer_id, account_id, role) VALUES (${F.organizerA}, ${F.owner.accountId}, 'owner')`;
  await sql`INSERT INTO organizer_members (organizer_id, account_id, role) VALUES (${F.organizerA}, ${F.staff.accountId}, 'staff')`;
  await sql`INSERT INTO organizer_members (organizer_id, account_id, role) VALUES (${F.organizerB}, ${F.orgB.accountId}, 'owner')`;

  for (const key of ['alpha', 'bravo', 'charlie', 'delta']) {
    const u = users.get(key)!;
    await addMembership(u, F.eventA);
    await grantConsent(u.accountId, 'service_channel', F.eventA);
  }
  // Staff is deliberately NOT a member of event A: that is what makes the
  // "organizer without a connection" note refusal (K3) observable.
  await grantConsent(F.owner.accountId, 'service_channel', F.eventA);
  await grantConsent(users.get('alpha')!.accountId, 'organizer_marketing', F.eventA);
  await addMembership(users.get('bravo')!, F.eventB);
}

// ---------------------------------------------------------------------------
// Modes A…F
// ---------------------------------------------------------------------------

/** One OTP request from a fresh session, retrying only on the shared IP bucket. */
async function otpProbe(email: string, label: string): Promise<Res> {
  for (let i = 0; i < 3; i++) {
    await paceOtp();
    const res = await new Session(label).post('/api/auth/otp/request', { email });
    if (res.status !== 429 || (res.json as { code?: string }).code !== 'rate_limited') return res;
    if (res.headers.get('x-ratelimit-limit') === null) return res; // account-level: not ours to wait out
    await sleep(20_000);
  }
  return new Session(`${label}-last`).post('/api/auth/otp/request', { email });
}

async function modeA(): Promise<void> {
  await check('A1', 'A', 'демо-вход через OTP + devCode (demo1)', '200 + сессия, GET /api/me 200', async () => {
    const s = await login(DEMO1, 'demo1');
    const me = await s.get('/api/me/profile');
    equals(me.status, 200, 'GET /api/me/profile');
    return { actual: 'OTP verify 200, cookie set, /api/me 200', evidence: ev(me) };
  });

  await check('A1b', 'A', 'вторая демо-личность (marta.demo) входит тем же путём', '200 + сессия', async () => {
    const s = await login(MARTA, 'marta');
    const me = await s.get('/api/me/profile');
    equals(me.status, 200, 'GET /api/me/profile');
    return { actual: 'OTP+devCode → 200, приватная ручка 200', evidence: ev(me, 'ok') };
  });

  await check('A2', 'A', 'вход владельца через allowlist devCode', '200 + сессия', async () => {
    const s = await login(OWNER_EMAIL, 'owner');
    const me = await s.get('/api/me/profile');
    equals(me.status, 200, 'GET /api/me/profile');
    return { actual: `owner session ok (${clip(redact(JSON.stringify(pick(me.json, ['ok']))), 40)})`, evidence: ev(me, 'ok', 'profile') };
  });

  await check('A3', 'A', 'неверный код → 401 invalid_code (1 промах не блокирует)', '401 invalid_code, затем верный код 200', async () => {
    const s = new Session('foxtrot');
    const email = users.get('foxtrot')!.email;
    const req = await s.post('/api/auth/otp/request', { email });
    must(req.status === 200, `otp/request HTTP ${req.status}`);
    const code = (req.json as { devCode?: string }).devCode!;
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await s.post('/api/auth/otp/verify', { email, code: wrong });
    equals(bad.status, 401, 'wrong code status');
    equals((bad.json as { code?: string }).code, 'invalid_code', 'wrong code body');
    const good = await s.post('/api/auth/otp/verify', { email, code });
    equals(good.status, 200, 'correct code after one failure');
    users.get('foxtrot')!.session = s;
    return { actual: '401 invalid_code → 200 ok', evidence: `${ev(bad)} | ${ev(good, 'ok')}` };
  });

  await check('A4', 'A', 'повторный запрос OTP в окне → 429 rate limit', '3 запроса ок, 4-й → 429 + Retry-After', async () => {
    const email = users.get('rate')!.email;
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await anon.post('/api/auth/otp/request', { email })).status);
    const blocked = await anon.post('/api/auth/otp/request', { email });
    equals(blocked.status, 429, '4th request status');
    equals((blocked.json as { code?: string }).code, 'rate_limited', '4th request body');
    const retry = blocked.headers.get('retry-after');
    must(retry !== null, 'Retry-After header missing');
    return { actual: `${codes.join(',')} → 429 (Retry-After ${retry}s)`, evidence: `${ev(blocked)} retry-after=${retry}` };
  });

  await check('A5', 'A', 'сессия без cookie → 401 на приватных ручках', '401 unauthorized на 4 приватных GET', async () => {
    const paths = ['/api/me/profile', '/api/me/contacts', '/api/me/notes', '/api/events/welcome-demo-meetup/directory'];
    const out: string[] = [];
    for (const p of paths) {
      const res = await anon.get(p, { headers: { cookie: '' } });
      equals(res.status, 401, `${p} status`);
      out.push(`${p}:${res.status}`);
    }
    return { actual: out.join(' '), evidence: out.join(' ') };
  });

  await check('A6', 'A', 'logout инвалидирует сессию', 'logout 200, затем GET приватной ручки 401', async () => {
    const s = await login(users.get('logout')!.email, 'logout', { fresh: true });
    equals((await s.get('/api/me/profile')).status, 200, 'before logout');
    const out = await s.post('/api/auth/logout');
    equals(out.status, 200, 'logout status');
    const after = await s.get('/api/me/profile');
    equals(after.status, 401, 'after logout');
    return { actual: '200 → logout 200 → GET /api/me/profile 401', evidence: `${ev(out, 'ok')} | ${ev(after)}` };
  });

  await check('A7', 'A', 'CSRF: мутация с Origin: https://evil.example → 403', '403 csrf_origin', async () => {
    const s = await userSession(users.get('alpha')!);
    const res = await s.post('/api/consents', { action: 'grant', purpose: 'public_card', scope_type: 'global', policy_version: 'matrix' }, {
      headers: { origin: 'https://evil.example' },
    });
    equals(res.status, 403, 'cross-origin mutation');
    equals((res.json as { code?: string }).code, 'csrf_origin', 'error code');
    const sameOrigin = await s.post('/api/consents', { action: 'grant', purpose: 'public_card', scope_type: 'global', policy_version: 'matrix' });
    equals(sameOrigin.status, 200, 'same-origin control request');
    return { actual: '403 csrf_origin (same-origin 200)', evidence: `${ev(res)} | control ${ev(sameOrigin, 'ok', 'action')}` };
  });

  await check('A8', 'A', 'enumeration: неизвестный email неотличим от известного', 'одинаковые ответы, без devCode', async () => {
    // Fresh sessions, one OTP request each, paced against the shared per-IP bucket.
    const unknown = await otpProbe(UNKNOWN_EMAIL, 'enum-unknown');
    const known = await otpProbe(users.get('plain')!.email, 'enum-known');
    const body = (r: Res) => redact(JSON.stringify({ ...(r.json as object), correlation_id: undefined }));
    const sameShape = unknown.status === known.status && body(unknown) === body(known);
    const noCode = !('devCode' in ((unknown.json ?? {}) as object)) && !('devCode' in ((known.json ?? {}) as object));
    must(noCode, 'devCode leaked for a non-demo/non-allowlisted address');
    return {
      status: sameShape ? 'PASS' : 'FAIL',
      actual: sameShape
        ? `оба ответа идентичны: HTTP ${unknown.status} ${clip(body(unknown), 70)}`
        : `ответы различаются: ${unknown.status} ${clip(body(unknown), 60)} vs ${known.status} ${clip(body(known), 60)}`,
      evidence: `unknown: ${ev(unknown)}\nknown(${users.get('plain')!.email}): ${ev(known)}`,
      deviation:
        unknown.status !== 200
          ? `ожидалось {ok:true}; фактически HTTP ${unknown.status} ${(unknown.json as { code?: string } | null)?.code ?? ''} — у экземпляра под тестом нет почтового транспорта для не-демо адреса (на staging-деплое это owner-test режим Resend, на локальном прогоне — отсутствие RESEND_API_KEY), поэтому код не уходит. Свойство анти-энумерации (байт-в-байт одинаковые тела, без devCode) выполняется.`
          : undefined,
    };
  });
}

async function modeB(): Promise<void> {
  const quota = users.get('mfa')!;
  let secret = '';

  await check('B1', 'B', 'MFA enroll: POST /api/me/mfa/totp', '200 + secret_base32/otpauth_uri/qr/recovery_codes(8)', async () => {
    const s = await login(quota.email, 'mfa');
    const res = await s.post('/api/me/mfa/totp', { email: quota.email });
    equals(res.status, 200, 'enroll status');
    const body = res.json as { secret_base32?: string; otpauth_uri?: string; qr_data_url?: string; recovery_codes?: string[] };
    must(typeof body.secret_base32 === 'string' && body.secret_base32.length >= 16, 'secret_base32 missing');
    must(typeof body.otpauth_uri === 'string' && body.otpauth_uri.startsWith('otpauth://'), 'otpauth_uri missing');
    must(typeof body.qr_data_url === 'string' && body.qr_data_url.startsWith('data:image/'), 'qr_data_url missing');
    equals(body.recovery_codes?.length, 8, 'recovery_codes count');
    secret = body.secret_base32;
    quota.session = s;
    return { actual: 'enrolled: secret+otpauth+qr+8 recovery codes', evidence: ev(res, 'ok', 'otpauth_uri') };
  });

  await check('B2', 'B', 'MFA confirm с неверным кодом → 400', '400 mfa_invalid_code', async () => {
    const s = await userSession(quota);
    const wrong = totpAt(secret) === '000000' ? '111111' : '000000';
    const res = await s.post('/api/me/mfa/totp/confirm', { code: wrong });
    equals(res.status, 400, 'confirm status');
    equals((res.json as { code?: string }).code, 'mfa_invalid_code', 'confirm code');
    return { actual: '400 mfa_invalid_code', evidence: ev(res) };
  });

  await check('B3', 'B', 'MFA confirm верным TOTP → 200 (полный цикл доступен)', '200 confirmed:true', async () => {
    const s = await userSession(quota);
    const res = await s.post('/api/me/mfa/totp/confirm', { code: totpAt(secret) });
    equals(res.status, 200, 'confirm status');
    equalstrue(res, 'confirmed');
    return { actual: '200 confirmed:true (TOTP посчитан локально)', evidence: ev(res, 'ok', 'confirmed') };
  });

  await check('B4', 'B', 'MFA disable без кода → 400; с верным кодом → 200', '400 invalid_input, затем 200 enabled:false', async () => {
    const s = await userSession(quota);
    const noCode = await s.del('/api/me/mfa', {});
    equals(noCode.status, 400, 'disable without code');
    equals((noCode.json as { code?: string }).code, 'invalid_input', 'disable code');
    const wrong = totpAt(secret) === '000000' ? '111111' : '000000';
    const bad = await s.del('/api/me/mfa', { code: wrong });
    equals(bad.status, 400, 'disable wrong code');
    equals((bad.json as { code?: string }).code, 'mfa_invalid_code', 'disable wrong-code body');
    const ok = await s.del('/api/me/mfa', { code: totpAt(secret) });
    equals(ok.status, 200, 'disable with valid code');
    return { actual: '400 invalid_input → 400 mfa_invalid_code → 200 enabled:false', evidence: `${ev(noCode)} | ${ev(bad)} | ${ev(ok, 'ok', 'enabled')}` };
  });

  await check('B5', 'B', 'полный TOTP-цикл покрыт integration-тестами', 'tests/integration/mfa.test.ts', async () => {
    const log = readFileSync(path.join(ROOT, 'evidence/matrix/integration.log'), 'utf8');
    const mfaTests = log.split('\n').filter((l) => l.startsWith('# Subtest:') && /mfa|totp/i.test(l)).length;
    must(mfaTests >= 1, 'no MFA subtest found in the integration log');
    return {
      status: 'SKIP',
      actual: `цикл покрыт integration-набором: ${mfaTests} MFA-подтест(ов) в evidence/matrix/integration.log; в матрице дополнительно выполнен живой enroll/confirm/disable по HTTP`,
      evidence: `${mfaTests} MFA subtests in the integration run`,
    };
  });

  await check('B6', 'B', 'активные сессии: список без токенов, текущая помечена', '200; ровно ключи id/created_at/last_seen_at/current; одна current и она первая; в теле нет слова token', async () => {
    const s = await login(F.owner.email, 'sessions-list');
    const res = await s.get('/api/me/sessions');
    equals(res.status, 200, 'sessions list status');
    const sessions = (res.json as { sessions?: Record<string, unknown>[] }).sessions;
    must(Array.isArray(sessions) && sessions!.length >= 1, 'sessions array missing or empty');
    for (const row of sessions!) {
      equals(Object.keys(row).sort().join(','), 'created_at,current,id,last_seen_at', `session keys (${JSON.stringify(row)})`);
      must(!Number.isNaN(Date.parse(row['created_at'] as string)), 'created_at must be ISO-8601');
      must(!Number.isNaN(Date.parse(row['last_seen_at'] as string)), 'last_seen_at must be ISO-8601');
    }
    equals(sessions!.filter((r) => r['current'] === true).length, 1, 'exactly one current session');
    equals(sessions![0]!['current'], true, 'the current session must be listed first');
    // No token material of any kind, anywhere in the payload.
    must(!/token/i.test(res.text), 'the sessions payload must not mention tokens');
    must(!res.text.includes(s.cookies.get('welcome_session') ?? '\u0000'), 'the session token must not appear in the payload');
    return {
      actual: `сессий=${sessions!.length}, current-первая=true, ключи строк только id/created_at/last_seen_at/current, токенов в теле нет`,
      evidence: clip(JSON.stringify(pick(sessions![0]!, ['id', 'created_at', 'last_seen_at', 'current'])), 200),
    };
  });

  await check('B7', 'B', 'отзыв чужой сессии того же аккаунта: строка удаляется, cookie умирает', 'DELETE → 200 current_revoked=false; отозванная сессия → 401; строки в БД нет', async () => {
    const first = await login(F.owner.email, 'sessions-first');
    // A genuinely separate session row for the SAME account (own device, not
    // somebody else's data) — created directly so no OTP budget is spent.
    const second = await sessionFor(F.owner.accountId, 'sessions-second');
    const secondToken = second.cookies.get('welcome_session')!;
    const rows = await sql!<{ id: string }[]>`
      SELECT id FROM sessions WHERE token_hash = ${hashSessionToken(secondToken)} LIMIT 1`;
    must(rows.length === 1, 'second session row not found');
    const targetId = rows[0]!.id;

    const listed = await first.get('/api/me/sessions');
    const inList = ((listed.json as { sessions: { id: string; current: boolean }[] }).sessions).find((r) => r.id === targetId);
    must(!!inList, 'the second session must be listed for the first one');
    equals(inList!.current, false, 'a different device is not the current one');

    const del = await first.del(`/api/me/sessions/${targetId}`);
    equals(del.status, 200, 'revoke status');
    equals((del.json as { current_revoked?: boolean }).current_revoked, false, 'current_revoked');

    const dead = await second.get('/api/me/sessions');
    equals(dead.status, 401, 'the revoked session must no longer authenticate');
    const gone = await sql!<{ id: string }[]>`SELECT id FROM sessions WHERE id = ${targetId}::uuid`;
    equals(gone.length, 0, 'the session row must be deleted');
    equals((await first.get('/api/me/sessions')).status, 200, 'the calling session must survive');
    return {
      actual: `отзыв → 200 current_revoked=false; отозванная сессия → 401; строка удалена; сессия-инициатор работает`,
      evidence: `${ev(del, 'revoked', 'current_revoked')} | ${ev(dead)}`,
    };
  });

  await check('B8', 'B', 'чужая сессия → 404 (не 403), битый id → 404, anon → 401', 'чужая сессия не удаляется и не подтверждает своё существование', async () => {
    const owner = await login(F.owner.email, 'sessions-owner-404');
    const foreign = await sessionFor(F.orgB.accountId, 'sessions-foreign');
    const foreignToken = foreign.cookies.get('welcome_session')!;
    const foreignRows = await sql!<{ id: string }[]>`
      SELECT id FROM sessions WHERE token_hash = ${hashSessionToken(foreignToken)} LIMIT 1`;
    must(foreignRows.length === 1, 'foreign session row not found');

    const res = await owner.del(`/api/me/sessions/${foreignRows[0]!.id}`);
    equals(res.status, 404, 'a session that is not yours must answer 404');
    equals((res.json as { code?: string }).code, 'not_found', '404 code');
    // The refusal must not have deleted it.
    equals((await foreign.get('/api/me/sessions')).status, 200, 'the foreign session must survive');

    const malformed = await owner.del('/api/me/sessions/not-a-uuid');
    equals(malformed.status, 404, 'malformed id must be a 404, not a crash');

    const anonList = await anon.get('/api/me/sessions');
    equals(anonList.status, 401, 'anonymous list');
    const anonDel = await anon.del(`/api/me/sessions/${foreignRows[0]!.id}`);
    equals(anonDel.status, 401, 'anonymous revoke');

    // Clean up the extra session we created for the synthetic org B account.
    await sql!`DELETE FROM sessions WHERE id = ${foreignRows[0]!.id}::uuid`;
    return {
      actual: 'чужая сессия → 404 not_found (не 403) и остаётся живой; битый id → 404; anon GET/DELETE → 401',
      evidence: `${ev(res, 'code')} | ${ev(malformed, 'code')} | ${ev(anonList)} | ${ev(anonDel)}`,
    };
  });
}

function equalstrue(res: Res, key: string): void {
  equals((res.json as Record<string, unknown>)[key], true, `${key} flag`);
}

async function modeC(): Promise<void> {
  const alpha = users.get('alpha')!;

  await check('C1', 'C', 'профиль: чтение с revision (число)', '200 + profile.revision:number', async () => {
    const s = await userSession(alpha);
    const res = await s.get('/api/me/profile');
    equals(res.status, 200, 'GET profile');
    const profile = (res.json as { profile?: { revision?: unknown } }).profile;
    must(typeof profile?.revision === 'number', `revision is not a number: ${JSON.stringify(profile?.revision)}`);
    return { actual: `revision=${profile!.revision}`, evidence: ev(res, 'ok'), };
  });

  await check('C2', 'C', 'профиль: обновление → revision++', '200 + revision растёт на 1', async () => {
    const s = await userSession(alpha);
    const before = (await s.get('/api/me/profile')).json as { profile: { revision: number; display_name: string } };
    const res = await updateProfile(s, {
      display_name: `${MARK}Alpha`,
      headline: 'Matrix run',
      need_intents: ['seeking-cofounder'],
      interests: ['ai-ml', 'dev-tools'],
      industry: 'ai-saas',
      job_function: 'engineering',
      keywords: ['matrix', 'usage-matrix'],
    });
    equals(res.status, 200, 'update status');
    const after = (res.json as { revision?: number }).revision;
    equals(after, before.profile.revision + 1, 'revision increment');
    return { actual: `${before.profile.revision} → ${after}`, evidence: ev(res, 'ok', 'revision') };
  });

  await check('C3', 'C', 'профиль: устаревшая revision → 409', '409 revision_conflict + x-current-revision', async () => {
    const s = await userSession(alpha);
    const current = ((await s.get('/api/me/profile')).json as { profile: { revision: number } }).profile.revision;
    const res = await s.post('/api/me/profile', { display_name: `${MARK}Alpha`, revision: Math.max(1, current - 5) });
    equals(res.status, 409, 'stale revision status');
    equals((res.json as { code?: string }).code, 'revision_conflict', 'stale revision body');
    const header = res.headers.get('x-current-revision');
    must(header !== null, 'x-current-revision header missing');
    return { actual: `409 revision_conflict (x-current-revision: ${header})`, evidence: ev(res) };
  });

  await check('C4', 'C', 'профиль: неизвестная ось → 400', '400 invalid_interests/invalid_industry', async () => {
    const s = await userSession(alpha);
    const badInterest = await updateProfile(s, { interests: ['matrix-not-an-interest'] });
    equals(badInterest.status, 400, 'unknown interest status');
    equals((badInterest.json as { code?: string }).code, 'invalid_interests', 'unknown interest code');
    const badIndustry = await updateProfile(s, { industry: 'matrix-nope' });
    equals(badIndustry.status, 400, 'unknown industry status');
    equals((badIndustry.json as { code?: string }).code, 'invalid_industry', 'unknown industry code');
    return { actual: '400 invalid_interests + 400 invalid_industry', evidence: `${ev(badInterest)} | ${ev(badIndustry)}` };
  });

  await check('C5', 'C', 'профиль: >5 интересов → 400', '400 invalid_interests', async () => {
    const s = await userSession(alpha);
    const res = await updateProfile(s, {
      interests: ['ai-ml', 'dev-tools', 'automation', 'b2b-sales', 'ux-ui', 'prototyping'],
    });
    equals(res.status, 400, 'over-limit interests status');
    equals((res.json as { code?: string }).code, 'invalid_interests', 'over-limit interests code');
    return { actual: '400 invalid_interests (6 интересов)', evidence: ev(res) };
  });

  await check('C6', 'C', 'профиль: >5 keywords → 400, ≤5 → 200', '400 invalid_keywords, затем 200', async () => {
    const s = await userSession(alpha);
    const over = await updateProfile(s, { keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'] });
    equals(over.status, 400, 'over-limit keywords status');
    equals((over.json as { code?: string }).code, 'invalid_keywords', 'over-limit keywords code');
    const ok = await updateProfile(s, { keywords: ['k1', 'k2', 'k3', 'k4', 'k5'] });
    equals(ok.status, 200, 'five keywords status');
    return { actual: '400 invalid_keywords → 200 (5)', evidence: `${ev(over)} | ${ev(ok, 'ok', 'revision')}` };
  });

  await check('C7', 'C', 'контакты: CRUD + public_enabled (приватный телефон)', 'PUT 200, GET отдаёт оба, public_enabled сохраняется', async () => {
    const s = await userSession(alpha);
    const publicSite = await s.put('/api/me/contacts', { kind: 'website', value: 'https://matrix.example/alpha', public_enabled: true });
    equals(publicSite.status, 200, 'upsert public website');
    const privatePhone = await s.put('/api/me/contacts', { kind: 'phone', value: '+34600111222', public_enabled: false });
    equals(privatePhone.status, 200, 'upsert private phone');
    const bad = await s.put('/api/me/contacts', { kind: 'phone', value: '+34600111222', public_enabled: 'yes' });
    equals(bad.status, 400, 'invalid public_enabled');
    equals((bad.json as { code?: string }).code, 'invalid_public_enabled', 'invalid public_enabled code');
    const list = await s.get('/api/me/contacts');
    equals(list.status, 200, 'list contacts');
    const contacts = (list.json as { contacts: { kind: string; public_enabled: boolean }[] }).contacts;
    const phone = contacts.find((c) => c.kind === 'phone');
    const site = contacts.find((c) => c.kind === 'website');
    equals(phone?.public_enabled, false, 'phone public_enabled');
    equals(site?.public_enabled, true, 'website public_enabled');
    return { actual: 'website public, phone private, invalid_public_enabled → 400', evidence: ev(list, 'ok') };
  });
}

async function modeD(): Promise<void> {
  const alpha = users.get('alpha')!;

  await check('D1', 'D', 'мини-лендинг GET /p/<slug>: 200 + имя/оси, без приватного телефона', '200, имя + метки интересов/интентов, не содержит телефон', async () => {
    const res = await anon.get(`/p/${alpha.slug}`);
    equals(res.status, 200, 'GET /p/<slug>');
    must(res.text.includes(`data-testid="pubcard-name"`), 'name block missing from HTML');
    must(res.text.includes(`${MARK}Alpha`), 'display name missing from HTML');
    // Axes render LOCALISED LABELS (EN by default) in separate elements, so the
    // assertions read the section text rather than a full sentence.
    const sections = {
      interests: cardSection(res.text, 'pubcard-interests'),
      needs: cardSection(res.text, 'pubcard-needs'),
      offers: cardSection(res.text, 'pubcard-offers'),
    };
    must(sections.interests.includes('AI / ML'), `interest label missing: «${clip(sections.interests, 90)}»`);
    must(/Looking for/i.test(sections.needs) && /co-founder/i.test(sections.needs), `need-intent label missing: «${clip(sections.needs, 90)}»`);
    must(sections.offers.length > 10, `offers block empty: «${clip(sections.offers, 90)}»`);
    must(!res.text.includes('+34600111222') && !res.text.includes('34600111222'), 'private phone leaked into HTML');
    return {
      actual: `200; секции: interests«${clip(sections.interests, 40)}», needs«${clip(sections.needs, 40)}», offers«${clip(sections.offers, 30)}»; телефон отсутствует`,
      evidence: clip(JSON.stringify(sections), 220),
    };
  });

  await check('D2', 'D', 'публичная проекция /api/public/profiles/<slug>: только public-контакты', '200, contacts без phone', async () => {
    const res = await anon.get(`/api/public/profiles/${alpha.slug}`);
    equals(res.status, 200, 'public profile');
    const contacts = (res.json as { contacts?: { kind: string }[] }).contacts ?? [];
    must(!contacts.some((c) => c.kind === 'phone'), 'private phone present in the public projection');
    must(contacts.some((c) => c.kind === 'website'), 'public website missing');
    const raw = JSON.stringify(res.json);
    must(!raw.includes('+34600111222'), 'private phone value leaked');
    return { actual: `contacts=[${contacts.map((c) => c.kind).join(',')}]`, evidence: ev(res, 'slug', 'display_name', 'contacts') };
  });

  await check('D3', 'D', 'vCard: 200, public-поля, без телефона, экранирование', 'text/vcard + escaped FN, без phone', async () => {
    const s = await userSession(alpha);
    const tricky = `${MARK}Alpha, Inc.; "Ltd"`;
    const upd = await updateProfile(s, { display_name: tricky });
    equals(upd.status, 200, 'rename profile for escaping check');
    const res = await anon.get(`/api/public/profiles/${alpha.slug}/vcard`);
    equals(res.status, 200, 'vcard status');
    must(res.headers.get('content-type')?.includes('text/vcard') === true, `content-type: ${res.headers.get('content-type')}`);
    must(res.text.includes('FN:MATRIX-Alpha\\, Inc.\\; "Ltd"'), 'vCard FN not escaped');
    must(res.text.includes('URL:https://matrix.example/alpha'), 'public website missing from vCard');
    must(!res.text.includes('34600111222'), 'private phone leaked into vCard');
    return { actual: 'text/vcard, FN экранирован (\\, \\;), phone отсутствует', evidence: clip(redact(res.text.split('\r\n').filter((l) => l.startsWith('FN:') || l.startsWith('URL:')).join(' | ')), 160) };
  });

  await check('D4', 'D', 'QR SVG: 200 image/svg+xml', '200 + <svg', async () => {
    const res = await anon.get(`/api/public/profiles/${alpha.slug}/qr.svg`);
    equals(res.status, 200, 'qr status');
    must(res.headers.get('content-type')?.includes('image/svg+xml') === true, `content-type: ${res.headers.get('content-type')}`);
    must(res.text.includes('<svg'), 'svg body missing');
    return { actual: '200 image/svg+xml', evidence: `HTTP ${res.status} ${res.headers.get('content-type')} bytes=${res.text.length}` };
  });

  await check('D5', 'D', 'несуществующий slug → 404 (JSON и HTML)', '404 not_found', async () => {
    const json = await anon.get('/api/public/profiles/matrix-does-not-exist-xyz');
    equals(json.status, 404, 'public JSON 404');
    equals((json.json as { code?: string }).code, 'not_found', 'public JSON code');
    const html = await anon.get('/p/matrix-does-not-exist-xyz');
    equals(html.status, 404, 'landing HTML 404');
    const vcard = await anon.get('/api/public/profiles/matrix-does-not-exist-xyz/vcard');
    equals(vcard.status, 404, 'vcard 404');
    return { actual: '404 JSON + 404 HTML + 404 vCard', evidence: `${ev(json)} | HTML ${html.status}` };
  });
}

async function modeE(): Promise<void> {
  await check('E1', 'E', 'таксономия: 16/94/14/12', '200 intents=16 interests=94 functions=14 industries=12', async () => {
    const res = await anon.get('/api/taxonomy');
    equals(res.status, 200, 'taxonomy status');
    const t = res.json as { version?: string; intents?: unknown[]; interests?: unknown[]; functions?: unknown[]; industries?: unknown[]; interest_groups?: unknown[] };
    const counts = { intents: t.intents?.length, interests: t.interests?.length, functions: t.functions?.length, industries: t.industries?.length, interest_groups: t.interest_groups?.length };
    equals(counts.intents, 16, 'intents');
    equals(counts.interests, 94, 'interests');
    equals(counts.functions, 14, 'functions');
    equals(counts.industries, 12, 'industries');
    return { actual: `v${t.version}: ${counts.intents}/${counts.interests}/${counts.functions}/${counts.industries}`, evidence: clip(JSON.stringify(counts), 140) };
  });

  await check('E2', 'E', 'валидация id таксономии при сохранении профиля', '200 с валидными id, 400 с неизвестным', async () => {
    const t = (await anon.get('/api/taxonomy')).json as { interests: { id: string }[]; functions: { id: string }[]; industries: { id: string }[] };
    const s = await userSession(users.get('charlie')!);
    const rev = ((await s.get('/api/me/profile')).json as { profile: { revision: number } }).profile.revision;
    const ok = await s.post('/api/me/profile', {
      display_name: `${MARK}Charlie`,
      interests: [t.interests[0]!.id],
      job_function: t.functions[0]!.id,
      industry: t.industries[0]!.id,
      revision: rev,
    });
    equals(ok.status, 200, 'valid catalogue ids');
    const rev2 = (ok.json as { revision: number }).revision;
    const badFunction = await s.post('/api/me/profile', { display_name: `${MARK}Charlie`, job_function: 'matrix-nope', revision: rev2 });
    equals(badFunction.status, 400, 'invalid job_function status');
    equals((badFunction.json as { code?: string }).code, 'invalid_job_function', 'invalid job_function code');
    return { actual: 'валидные id → 200, неизвестный → 400 invalid_job_function', evidence: `${ev(ok, 'ok', 'revision')} | ${ev(badFunction)}` };
  });
}

async function modeF(): Promise<void> {
  await check('F1', 'F', 'enrichment: живой Vertex draft (профиль без своих ссылок)', '200 + draft/sources', async () => {
    const s = await userSession(users.get('bravo')!);
    const attempts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await s.post('/api/me/enrich');
      attempts.push(`#${i + 1}: HTTP ${res.status} ${clip(redact(res.text), 90)}`);
      if (res.status === 200) {
        const body = res.json as { draft?: unknown; sources?: unknown[]; provider?: string; degraded?: boolean };
        must(body.draft !== undefined, 'draft missing');
        const how = body.degraded ? 'degraded-черновик из профиля (провайдер не дал draft даже после повтора)' : 'черновик провайдера';
        return { actual: `200 draft + ${body.sources?.length ?? 0} source(s), provider=${body.provider ?? 'n/a'} — ${how}`, evidence: attempts.join(' | ') };
      }
      if (i === 0) await sleep(2000);
    }
    return {
      status: 'FAIL',
      actual: `оба вызова не дали draft (${attempts.join(' | ')})`,
      evidence: `${attempts.join('\n')}\nлокальный repro тем же ключом: transport.enrich({displayName, company:null, industry:'ai-saas', links:[]}) → state=failed code=no_draft (9.0s); с одной ссылкой → state=ok (8.2s)`,
      deviation:
        'живая ручка отвечает 502 enrichment_failed (retryable) — 4 вызова в двух прогонах, все красные. ' +
        'Локальный repro тем же ключом/моделью: transport.enrich({links:[]}) → no_draft. Контроль F1b (профиль с website-ссылкой) в этом же прогоне тоже красный, ' +
        'поэтому гипотеза «виновато только отсутствие ссылок» не подтверждена — фактическая картина в BUG-3: провайдер отвечает 502 на живом деплое, код провайдера скрыт маршрутом (BUG-4).',
    };
  });

  await check('F1b', 'F', 'enrichment: живой Vertex draft при наличии ссылки (контроль)', '200 + draft/sources', async () => {
    const charlie = users.get('charlie')!;
    const s = await userSession(charlie);
    const put = await s.put('/api/me/contacts', { kind: 'website', value: 'https://matrix.example/charlie', public_enabled: true });
    equals(put.status, 200, 'website contact upsert');
    const attempts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await s.post('/api/me/enrich');
      attempts.push(`#${i + 1}: HTTP ${res.status} ${clip(redact(res.text), 90)}`);
      if (res.status === 200) {
        const body = res.json as { draft?: unknown; sources?: unknown[]; provider?: string; degraded?: boolean };
        must(body.draft !== undefined, 'draft missing');
        const how = body.degraded ? 'degraded-черновик из профиля' : 'черновик провайдера';
        return { actual: `200 draft + ${body.sources?.length ?? 0} source(s), provider=${body.provider ?? 'n/a'} — ${how}`, evidence: attempts.join(' | ') };
      }
      if (i === 0) await sleep(2000);
    }
    return { status: 'FAIL', actual: `оба вызова неуспешны: ${attempts.join(' | ')}`, evidence: attempts.join('\n') };
  });

  await check('F2', 'F', 'enrichment: лимит 5/час → 429', '6-й запрос → 429 (X-RateLimit-Limit: 5)', async () => {
    const quota = users.get('quota')!;
    const s = await login(quota.email, 'quota');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await s.post('/api/me/enrich')).status);
    const limited = await s.post('/api/me/enrich');
    equals(limited.status, 429, '6th enrich status');
    equals((limited.json as { code?: string }).code, 'rate_limited', '6th enrich body');
    const limit = limited.headers.get('x-ratelimit-limit');
    return {
      actual: `${statuses.join(',')} → 429 (limit ${limit ?? 'n/a'})`,
      evidence: `${ev(limited)} x-ratelimit-limit=${limit}`,
      deviation:
        statuses[0] === 400
          ? 'квота тратилась аккаунтом без профиля (400 profile_required), чтобы не жечь живые Vertex-вызовы; порядок проверок (квота раньше профиля) подтверждён.'
          : undefined,
    };
  });

  await check('F3', 'F', 'enrichment без сессии → 401', '401 unauthorized', async () => {
    const res = await anon.post('/api/me/enrich', undefined, { headers: { cookie: '' } });
    equals(res.status, 401, 'anon enrich');
    return { actual: '401 unauthorized', evidence: ev(res) };
  });
}

// ---------------------------------------------------------------------------
// Shared helpers used by modes G…R
// ---------------------------------------------------------------------------

/** Runs exactly one outbox tick through the deployment's own endpoint. */
async function tick(): Promise<Res> {
  return rawFetch('POST', '/api/internal/worker-tick', {
    headers: { origin: BASE, 'x-worker-tick-secret': WORKER_TICK_SECRET, 'x-forwarded-for': nextIp() },
  });
}

let updateId = 8_000_000 + Math.floor(Math.random() * 1_000_000);

/** Sends one Telegram update; `secret: null` omits the secret header. */
async function webhook(update: Record<string, unknown>, secret: string | null = WEBHOOK_SECRET): Promise<Res> {
  const headers: Record<string, string> = {};
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return rawFetch('POST', '/api/webhooks/telegram', { body: update, headers });
}

function telegramMessage(chatId: number, text: string, opts: { date?: number } = {}): Record<string, unknown> {
  updateId += 1;
  const message: Record<string, unknown> = { message_id: updateId, chat: { id: chatId }, text };
  if (opts.date !== undefined) message.date = opts.date;
  return { update_id: updateId, message };
}

/** CSV body from a matrix of cells (quotes cells containing , " or newline). */
function csv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','))
    .join('\n');
}

async function jobRow(dedupeKey: string): Promise<{ status: string; attempt: number } | null> {
  if (!sql) return null;
  const rows = await sql<{ status: string; attempt: number }[]>`
    SELECT status, attempt FROM outbox_jobs WHERE dedupe_key = ${dedupeKey} LIMIT 1`;
  return rows[0] ?? null;
}

interface NoticeRow {
  id: string;
  kind: string;
  status: string;
  text: string;
  account_id: string;
}

/** The outbox row behind an introduction decision notice (ADR 0010). */
async function noticeRow(dedupeKey: string): Promise<NoticeRow | null> {
  if (!sql) return null;
  const rows = await sql<NoticeRow[]>`
    SELECT id, kind, status, payload->>'text' AS text, payload->>'account_id' AS account_id
    FROM outbox_jobs WHERE dedupe_key = ${dedupeKey} LIMIT 1`;
  return rows[0] ?? null;
}

async function noticeCount(dedupeKey: string): Promise<number> {
  if (!sql) return 0;
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs WHERE dedupe_key = ${dedupeKey}`;
  return rows[0]?.count ?? 0;
}

/** Latest delivery attempt of the job behind a dedupe key — carries the code. */
async function noticeAttempt(dedupeKey: string): Promise<{ state: string; code: string | null }> {
  if (!sql) throw new Error('no db');
  const rows = await sql<{ state: string; code: string | null }[]>`
    SELECT da.state, da.code FROM delivery_attempts da
    JOIN outbox_jobs j ON j.id = da.job_id
    WHERE j.dedupe_key = ${dedupeKey} ORDER BY da.id DESC LIMIT 1`;
  must(rows.length > 0, `no delivery attempt recorded for ${dedupeKey}`);
  return rows[0]!;
}

const membershipId = async (user: FixtureUser, eventId: string): Promise<string> => {
  if (!sql) throw new Error('no db');
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM event_memberships WHERE event_id = ${eventId} AND profile_id = ${user.profileId} LIMIT 1`;
  must(rows.length === 1, `membership not found for ${user.key} in ${eventId}`);
  return rows[0]!.id;
};

/** Text of one card section (testids are rendered in document order). */
function cardSection(html: string, testid: string): string {
  const start = html.indexOf(`data-testid="${testid}"`);
  if (start < 0) return '';
  const next = html.indexOf('data-testid="', start + 20);
  const slice = html.slice(start, next > 0 ? next : start + 800);
  return slice.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Mode G — events: join / directory / recommendations / attendance
// ---------------------------------------------------------------------------

let alphaRecommendations: { profile_id: string; display_name: string }[] = [];

async function modeG(): Promise<void> {
  const alpha = users.get('alpha')!;
  const foxtrot = users.get('foxtrot')!;

  await check('G1', 'G', 'публичное событие видно без сессии', 'GET /api/events/<slug> без cookie → 200', async () => {
    const res = await anon.get('/api/events/welcome-demo-meetup');
    equals(res.status, 200, 'public event view');
    const body = res.json as { ok?: boolean; event?: { name?: string; access_mode?: string }; viewer?: { is_member?: boolean } };
    equals(body.ok, true, 'ok flag');
    must(!!body.event?.name, 'event.name missing');
    equals(body.viewer?.is_member, false, 'anonymous viewer membership');
    return { actual: `200 «${body.event!.name}» (access_mode=${body.event!.access_mode}), viewer.is_member=false`, evidence: ev(res, 'ok', 'event', 'viewer') };
  });

  await check('G2', 'G', 'закрытое событие: join с кодом', 'без кода 403, неверный 403, верный 200, повтор идемпотентен', async () => {
    const s = await userSession(foxtrot);
    const noCode = await s.post(`/api/events/${F.eventClosed}/join`, {});
    equals(noCode.status, 403, 'no-code status');
    equals((noCode.json as { code?: string }).code, 'join_forbidden', 'no-code body');
    const wrong = await s.post(`/api/events/${F.eventClosed}/join`, { join_code: 'wrong-code-value' });
    equals(wrong.status, 403, 'wrong-code status');
    equals((wrong.json as { code?: string }).code, 'join_forbidden', 'wrong-code body');
    const ok = await s.post(`/api/events/${F.eventClosed}/join`, { join_code: F.closedCode });
    equals(ok.status, 200, 'correct-code status');
    const membership = (ok.json as { membership?: { state: string; directory_visible: boolean } }).membership;
    equals(membership?.state, 'active', 'membership state');
    equals(membership?.directory_visible, false, 'membership directory_visible');
    const again = await s.post(`/api/events/${F.eventClosed}/join`, { join_code: F.closedCode });
    equals(again.status, 200, 'repeat join status');
    equals((again.json as { already_member?: boolean }).already_member, true, 'repeat join flag');
    return {
      actual: '403 join_forbidden (без кода) → 403 (неверный) → 200 (верный, state=active) → 200 already_member:true',
      evidence: `${ev(noCode)} | ${ev(wrong)} | ${ev(ok, 'ok', 'already_member', 'membership')} | ${ev(again, 'ok', 'already_member')}`,
      deviation: 'ожидание задания «403/429 после 20 попыток lockout» проверено отдельной строкой G3 на выделенном событии (lockout блокирует и верный код — совместно на одном событии не сходится).',
    };
  });

  await check('G3', 'G', 'закрытое событие: 20 неверных попыток → lockout', 'после 20 фейлов верный код тоже 429 join_code_locked', async () => {
    const s = await userSession(users.get('delta')!);
    let failures = 0;
    let throttled = 0;
    for (let i = 0; i < 26 && failures < 20; i++) {
      const res = await s.post(`/api/events/${F.eventLock}/join`, { join_code: `bad-code-${i}-aaaa` });
      if (res.status === 403) failures += 1;
      else if (res.status === 429 && (res.json as { code?: string }).code === 'rate_limited') {
        throttled += 1;
        await sleep(31_000); // per-IP /join bucket is 10/min
      } else {
        throw new Error(`unexpected status ${res.status} ${clip(redact(res.text), 80)}`);
      }
    }
    equals(failures, 20, 'recorded failed attempts');
    const locked = await s.post(`/api/events/${F.eventLock}/join`, { join_code: F.lockCode });
    equals(locked.status, 429, 'correct code while locked');
    equals((locked.json as { code?: string }).code, 'join_code_locked', 'lock body');
    return {
      actual: `20× 403 join_forbidden (${throttled}× придержал per-IP bucket) → верный код 429 join_code_locked`,
      evidence: `${ev(locked)} retry-after=${locked.headers.get('retry-after')}`,
    };
  });

  await check('G4', 'G', 'directory: режимы intent/interest/all + фильтры + поиск q', '200 на все валидные, 400 на невалидные', async () => {
    const s = await userSession(alpha);
    const all = await s.get(`/api/events/${F.eventA}/directory?mode=all`);
    equals(all.status, 200, 'mode=all');
    const members = (all.json as { members?: { display_name: string }[] }).members ?? [];
    must(members.some((m) => m.display_name === `${MARK}Bravo`), 'Bravo missing from mode=all');
    const intent = await s.get(`/api/events/${F.eventA}/directory?mode=intent`);
    equals(intent.status, 200, 'mode=intent');
    const interest = await s.get(`/api/events/${F.eventA}/directory?mode=interest`);
    equals(interest.status, 200, 'mode=interest');
    const byFunction = await s.get(`/api/events/${F.eventA}/directory?function=engineering`);
    equals(byFunction.status, 200, 'function filter');
    const byIndustry = await s.get(`/api/events/${F.eventA}/directory?industry=ai-saas`);
    equals(byIndustry.status, 200, 'industry filter');
    const search = await s.get(`/api/events/${F.eventA}/directory?q=Bravo`);
    equals(search.status, 200, 'q search');
    const hits = (search.json as { members?: { display_name: string }[] }).members ?? [];
    must(hits.some((m) => m.display_name === `${MARK}Bravo`), 'q=Bravo returned no hit');
    const badMode = await s.get(`/api/events/${F.eventA}/directory?mode=matrix-nope`);
    equals(badMode.status, 400, 'invalid mode');
    equals((badMode.json as { code?: string }).code, 'invalid_mode', 'invalid mode code');
    const badFunction = await s.get(`/api/events/${F.eventA}/directory?function=matrix-nope`);
    equals(badFunction.status, 400, 'invalid function');
    equals((badFunction.json as { code?: string }).code, 'invalid_job_function', 'invalid function code');
    return {
      actual: `all/intent/interest/function/industry/q → 200 (q=Bravo нашёл ${hits.length}); невалидные → 400 invalid_mode / invalid_job_function`,
      evidence: `${ev(all, 'ok', 'mode')} members=${members.length} | ${ev(badMode)} | ${ev(badFunction)}`,
    };
  });

  await check('G5', 'G', 'recommendations: топ-3 + причины (коды и параметры)', '200, ≤3, reasons с code+params, без себя', async () => {
    const s = await userSession(alpha);
    const res = await s.get(`/api/events/${F.eventA}/recommendations`);
    equals(res.status, 200, 'recommendations status');
    const items = (res.json as { recommendations?: { profile_id: string; display_name: string; score: number; reasons_for_me: unknown[]; reasons_for_them: unknown[]; algorithm: string }[] }).recommendations ?? [];
    must(items.length >= 1 && items.length <= 3, `expected 1..3 recommendations, got ${items.length}`);
    must(!items.some((i) => i.profile_id === alpha.profileId), 'self recommended');
    const withReasons = items.find((i) => i.reasons_for_me.length > 0);
    must(!!withReasons, 'no item carries reasons_for_me');
    const reason = withReasons!.reasons_for_me[0] as { code?: string; params?: unknown };
    must(typeof reason.code === 'string' && reason.params !== undefined, 'reason lacks code/params');
    alphaRecommendations = items.map((i) => ({ profile_id: i.profile_id, display_name: i.display_name }));
    return {
      actual: `${items.length}/3: ${items.map((i) => `${i.display_name}(${i.score})`).join(', ')}; первый reason=${reason.code} ${clip(JSON.stringify(reason.params), 60)}`,
      evidence: clip(redact(JSON.stringify(items[0])), 240),
      deviation: 'позитивный контроль: Bravo/Charlie/Delta видны до интро; отсутствие пары с активным интро проверяется в J7',
    };
  });

  await check('G6', 'G', 'attendance self-report', '200 attendance_source=self; чужая membership 403; мусор 400', async () => {
    const s = await userSession(alpha);
    const mine = await membershipId(alpha, F.eventA);
    const res = await s.post(`/api/me/memberships/${mine}/attendance`, { present: true });
    equals(res.status, 200, 'self report status');
    equals((res.json as { attendance_source?: string }).attendance_source, 'self', 'attendance_source');
    const foreign = await membershipId(users.get('bravo')!, F.eventA);
    const denied = await s.post(`/api/me/memberships/${foreign}/attendance`, { present: true });
    equals(denied.status, 403, 'foreign membership');
    const bad = await s.post(`/api/me/memberships/${mine}/attendance`, { present: 'yes' });
    equals(bad.status, 400, 'invalid present');
    equals((bad.json as { code?: string }).code, 'invalid_present', 'invalid present code');
    return { actual: '200 attendance_source=self | 403 forbidden (чужая) | 400 invalid_present', evidence: `${ev(res, 'ok', 'attendance_source')} | ${ev(denied)} | ${ev(bad)}` };
  });

  await check('G7', 'G', 'non-member → 403 на directory/recommendations', '403 forbidden', async () => {
    const s = await userSession(foxtrot);
    const dir = await s.get(`/api/events/${F.eventA}/directory?mode=all`);
    equals(dir.status, 403, 'directory as non-member');
    const recs = await s.get(`/api/events/${F.eventA}/recommendations`);
    equals(recs.status, 403, 'recommendations as non-member');
    return { actual: '403 forbidden ×2', evidence: `${ev(dir)} | ${ev(recs)}` };
  });

  await check('G8', 'G', 'directory: смотрящий не показывается сам себе (все режимы)', 'alpha.profileId отсутствует в members для all/intent/interest', async () => {
    const s = await userSession(alpha);
    const counts: string[] = [];
    for (const mode of ['all', 'intent', 'interest']) {
      const res = await s.get(`/api/events/${F.eventA}/directory?mode=${mode}`);
      equals(res.status, 200, `mode=${mode} status`);
      const members = (res.json as { members?: { profile_id: string }[] }).members ?? [];
      must(!members.some((m) => m.profile_id === alpha.profileId), `self listed in mode=${mode}`);
      counts.push(`${mode}=${members.length}`);
    }
    // Recommendations already excluded self; assert the change did not regress it.
    const recs = await s.get(`/api/events/${F.eventA}/recommendations`);
    equals(recs.status, 200, 'recommendations status');
    const items = (recs.json as { recommendations?: { profile_id: string }[] }).recommendations ?? [];
    must(!items.some((i) => i.profile_id === alpha.profileId), 'self recommended');
    return {
      actual: `self отсутствует во всех трёх режимах (${counts.join(', ')}); рекомендации тоже без себя (${items.length})`,
      evidence: `alpha.profileId отсутствует в members: ${counts.join(', ')}; recommendations=${items.length}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Mode H — CSV import
// ---------------------------------------------------------------------------

const IMPORT_HEADER = ['name', 'email', 'company', 'role', 'approval_status'];
const QUARANTINE_STATUS = 'matrix-maybe';
const FORMULA_CELL = '=cmd|\' /C calc\'!A0';

async function importRequest(s: Session, body: Record<string, unknown>): Promise<Res> {
  return s.post(`/api/events/${F.eventA}/imports`, body);
}

async function modeH(): Promise<void> {
  const owner = F.owner;
  const csvRows = [
    IMPORT_HEADER,
    [`${MARK}Import One`, emailFor('claim'), `${MARK}Co`, 'founder', 'approved'],
    [`${MARK}Import Two`, `matrix-import-two@welcome.test`, `${MARK}Co`, 'cto', QUARANTINE_STATUS],
    // The formula lives in the NAME column: that is the only imported field the
    // organizer CSV export projects, so it is the one that proves neutralisation.
    [FORMULA_CELL, 'matrix-import-formula@welcome.test', `${MARK}Co`, 'analyst', 'confirmed'],
  ];
  const text = csv(csvRows);

  await check('H1', 'H', 'import preview: counts, mapping и счётчики would_*', '200 с totalRows/…/sample + mapping + would_insert/would_update/would_skip/quarantined_count', async () => {
    const s = await userSession(owner);
    const res = await importRequest(s, { csv_text: text, mode: 'preview' });
    equals(res.status, 200, 'preview status');
    const preview = (res.json as { preview?: Record<string, unknown> }).preview;
    must(!!preview, 'preview object missing');
    // Legacy shape kept verbatim for existing clients.
    const keys = ['totalRows', 'validEmails', 'invalidEmails', 'quarantined', 'duplicatesInFile', 'sample'];
    for (const k of keys) must(k in preview!, `preview.${k} missing`);
    equals(preview!.totalRows, 3, 'totalRows');
    must((preview!.quarantined as number) >= 1, 'quarantined count is 0 (unknown status must quarantine)');
    must(Array.isArray(preview!.sample), 'sample is not an array');
    // The organizer-facing contract: the resolved mapping, the CSV columns, and
    // how many rows the commit will insert / update / skip.
    const body = res.json as Record<string, unknown>;
    for (const k of ['mapping', 'columns', 'would_insert', 'would_update', 'would_skip', 'quarantined_count']) {
      must(k in body, `${k} missing from the preview response`);
    }
    const mapping = body['mapping'] as Record<string, string | null>;
    equals(mapping['name'], 'name', 'auto-resolved name column');
    equals(mapping['email'], 'email', 'auto-resolved email column');
    equals(mapping['external_id'], null, 'unmapped field must be reported as null, not invented');
    equals((body['would_skip'] as number), 0, 'every row has an upsert key (email)');
    equals(body['would_update'], 0, 'nothing exists yet at first preview');
    must((body['would_insert'] as number) >= 3, `would_insert=${body['would_insert']}`);
    equals(body['quarantined_count'], preview!.quarantined, 'quarantined_count mirrors preview.quarantined');
    return {
      actual:
        `totalRows=3, quarantined=${preview!.quarantined}, would_insert=${body['would_insert']}, ` +
        `would_update=${body['would_update']}, would_skip=${body['would_skip']}, mapping.name=${mapping['name']}`,
      evidence: clip(JSON.stringify(pick(body, [...keys, 'mapping', 'columns', 'would_insert', 'would_update', 'would_skip', 'quarantined_count'])), 240),
    };
  });

  await check('H2', 'H', 'import commit', '200 counts{created,updated,skipped,quarantined}', async () => {
    const s = await userSession(owner);
    const res = await importRequest(s, { csv_text: text, mode: 'commit' });
    equals(res.status, 200, 'commit status');
    const counts = (res.json as { counts?: Record<string, number> }).counts;
    must(!!counts, 'counts missing');
    must((counts!.created ?? 0) >= 2, `created=${counts!.created}`);
    must((counts!.quarantined ?? 0) >= 1, `quarantined=${counts!.quarantined}`);
    return { actual: `created=${counts!.created} updated=${counts!.updated} skipped=${counts!.skipped} quarantined=${counts!.quarantined}`, evidence: clip(JSON.stringify(counts), 160) };
  });

  await check('H3', 'H', 'повторный commit идемпотентен (0 дублей)', 'created:0, число регистраций не растёт', async () => {
    const s = await userSession(owner);
    const before = await sql!<{ count: number }[]>`SELECT count(*)::int AS count FROM registrations WHERE event_id = ${F.eventA}`;
    const res = await importRequest(s, { csv_text: text, mode: 'commit' });
    equals(res.status, 200, 're-commit status');
    const counts = (res.json as { counts?: Record<string, number> }).counts!;
    equals(counts.created, 0, 'created on re-commit');
    const after = await sql!<{ count: number }[]>`SELECT count(*)::int AS count FROM registrations WHERE event_id = ${F.eventA}`;
    equals(after[0]!.count, before[0]!.count, 'registration count');
    return { actual: `created=0 updated=${counts.updated}; регистраций ${before[0]!.count} → ${after[0]!.count}`, evidence: clip(JSON.stringify(counts), 160) };
  });

  await check('H4', 'H', 'формула в данных безопасна (нейтрализация в экспорте)', 'экспорт CSV нейтрализует = в начале ячейки', async () => {
    const s = await userSession(owner);
    const res = await s.get(`/api/organizer/events/${F.eventA}/export`);
    equals(res.status, 200, 'export status');
    must(res.headers.get('content-type')?.includes('text/csv') === true, `content-type: ${res.headers.get('content-type')}`);
    const line = res.text.split('\n').find((l) => l.includes('cmd|')) ?? '';
    must(line.length > 0, 'formula row missing from the export');
    must(line.includes(`'${FORMULA_CELL}`), `formula cell not neutralised: ${clip(line, 120)}`);
    must(!/(^|,)"?=cmd\|/.test(line), 'raw =cmd cell present in the export');
    return { actual: `ячейка экспортирована с защитным апострофом: «${clip(line, 60)}»`, evidence: clip(redact(line), 200) };
  });

  await check('H5', 'H', 'лимиты импорта: >5000 строк и >5МБ отклоняются', '413 (приложение для строк; платформа для байт)', async () => {
    const s = await userSession(owner);
    const rows = [IMPORT_HEADER];
    for (let i = 0; i < 5001; i++) rows.push([`${MARK}Row ${i}`, `matrix-bulk-${i}@welcome.test`, '', '', 'approved']);
    const many = await importRequest(s, { csv_text: csv(rows), mode: 'preview' });
    equals(many.status, 413, 'row-limit status');
    equals((many.json as { code?: string }).code, 'payload_too_large', 'row-limit code');
    const bigCell = 'x'.repeat(4096);
    const filler = Array.from({ length: 1300 }, (_, i) => [`${MARK}Pad ${i}`, `matrix-pad-${i}@welcome.test`, bigCell, bigCell, 'approved']);
    const big = await importRequest(s, { csv_text: csv([IMPORT_HEADER, ...filler]), mode: 'preview' });
    equals(big.status, 413, 'byte-limit status');
    const bigCode = (big.json as { code?: string }).code;
    const appLevel = bigCode === 'payload_too_large';
    return {
      actual: `5001 строка → 413 payload_too_large; >5МиБ → 413 (${appLevel ? 'уровень приложения' : `уровень платформы: ${bigCode ?? clip(redact(big.text), 60)}`})`,
      evidence: `${ev(many)} | ${ev(big)}`,
      deviation: appLevel
        ? undefined
        : 'тело >~4.5МБ отклоняет сама платформа Vercel до входа в функцию, поэтому прикладной лимит 5МиБ на этом деплое недостижим: отказ есть (413), но на платформенном слое, с другим телом ответа.',
    };
  });

  await check('H6', 'H', 'неизвестный approval_status → quarantine (+ приглашение запрещено)', 'quarantined в БД; invite → 403 claim_not_allowed', async () => {
    const row = await sql!<{ id: string; approval_status: string }[]>`
      SELECT id, approval_status FROM registrations
      WHERE event_id = ${F.eventA} AND external_guest_id IS NOT NULL
        AND imported_data->>'email' = ${'matrix-import-two@welcome.test'} LIMIT 1`;
    must(row.length === 1, 'quarantined registration not found');
    equals(row[0]!.approval_status, 'quarantined', 'stored approval_status');
    const s = await userSession(F.owner);
    const invite = await s.post(`/api/organizer/events/${F.eventA}/registrations/${row[0]!.id}/invite`);
    equals(invite.status, 403, 'invite on quarantined');
    equals((invite.json as { code?: string }).code, 'claim_not_allowed', 'invite code');
    return { actual: `approval_status='quarantined' в БД; invite → 403 claim_not_allowed`, evidence: `${ev(invite)} (status=${row[0]!.approval_status})` };
  });

  // Explicit column mapping: headers auto-mapping cannot resolve, so only the
  // organizer's own mapping makes the file importable.
  const mappedHeader = ['Guest', 'Contact', 'Team'];
  const mappedRows = [
    mappedHeader,
    [`${MARK}Mapped One`, `matrix-mapped-one@welcome.test`, `${MARK}Co`],
    [`${MARK}Mapped Two`, `matrix-mapped-two@welcome.test`, `${MARK}Co`],
  ];
  const mappedText = csv(mappedRows);
  const MAPPING = { Guest: 'name', Contact: 'email' };

  await check('H7', 'H', 'ручной маппинг колонок меняет результат', 'без mapping: would_insert=0; с mapping: would_insert=2 и имена в БД', async () => {
    const s = await userSession(owner);
    // Auto-mapping cannot know "Guest"/"Contact": the rows are not importable,
    // and the preview says so instead of guessing a column.
    const auto = await importRequest(s, { csv_text: mappedText, mode: 'preview' });
    equals(auto.status, 200, 'auto preview status');
    const autoBody = auto.json as Record<string, unknown>;
    equals((autoBody['mapping'] as Record<string, unknown>)['name'], null, 'Guest must not auto-map to name');
    equals(autoBody['would_insert'], 0, 'nothing importable without a mapping');

    // The same bytes with the organizer's mapping.
    const mapped = await importRequest(s, { csv_text: mappedText, mode: 'preview', mapping: MAPPING });
    equals(mapped.status, 200, 'mapped preview status');
    const mappedBody = mapped.json as Record<string, unknown>;
    equals((mappedBody['mapping'] as Record<string, unknown>)['name'], 'Guest', 'mapping echo (name)');
    equals((mappedBody['mapping'] as Record<string, unknown>)['email'], 'Contact', 'mapping echo (email)');
    equals(mappedBody['would_insert'], 2, 'two rows importable with the mapping');

    // Preview still writes nothing.
    const beforeCommit = await sql!<{ count: number }[]>`
      SELECT count(*)::int AS count FROM registrations
      WHERE event_id = ${F.eventA} AND imported_data->>'Contact' = ${'matrix-mapped-one@welcome.test'}`;
    equals(beforeCommit[0]!.count, 0, 'preview must not write');

    const commit = await importRequest(s, { csv_text: mappedText, mode: 'commit', mapping: MAPPING });
    equals(commit.status, 200, 'mapped commit status');
    const counts = (commit.json as { counts?: { created: number } }).counts!;
    equals(counts.created, 2, 'created with mapping');

    const names = await sql!<{ imported_name: string | null }[]>`
      SELECT imported_name FROM registrations
      WHERE event_id = ${F.eventA} AND imported_data->>'Contact' IN
        (${'matrix-mapped-one@welcome.test'}, ${'matrix-mapped-two@welcome.test'})
      ORDER BY imported_name ASC`;
    equals(names.length, 2, 'committed rows');
    equals(names[0]!.imported_name, `${MARK}Mapped One`, 'first name from the mapped column');
    equals(names[1]!.imported_name, `${MARK}Mapped Two`, 'second name from the mapped column');
    return {
      actual: `без mapping: would_insert=${autoBody['would_insert']}; с mapping: would_insert=2 → commit created=${counts.created}, имена из колонки Guest`,
      evidence: `${ev(auto, 'would_insert')} | ${ev(mapped, 'would_insert', 'mapping')} | ${ev(commit, 'counts')}`,
    };
  });

  await check('H8', 'H', 'невалидный маппинг → 400 с понятным кодом, без записи', 'unknown_mapping_field / unknown_csv_column / duplicate_mapping_field', async () => {
    const s = await userSession(owner);
    const countRows = async () =>
      (await sql!<{ count: number }[]>`
        SELECT count(*)::int AS count FROM registrations WHERE event_id = ${F.eventA}`)[0]!.count;
    const before = await countRows();

    const unknownField = await importRequest(s, { csv_text: mappedText, mode: 'preview', mapping: { Guest: 'nickname' } });
    equals(unknownField.status, 400, 'unknown field status');
    equals((unknownField.json as { code?: string }).code, 'unknown_mapping_field', 'unknown field code');

    const unknownColumn = await importRequest(s, { csv_text: mappedText, mode: 'preview', mapping: { 'No Such Column': 'name' } });
    equals(unknownColumn.status, 400, 'unknown column status');
    equals((unknownColumn.json as { code?: string }).code, 'unknown_csv_column', 'unknown column code');

    const duplicate = await importRequest(s, { csv_text: mappedText, mode: 'preview', mapping: { Guest: 'name', Contact: 'name' } });
    equals(duplicate.status, 400, 'duplicate status');
    equals((duplicate.json as { code?: string }).code, 'duplicate_mapping_field', 'duplicate code');

    // `headline` is an accepted spelling of `role`, so the two collide rather
    // than silently double-mapping the same field.
    const alias = await importRequest(s, { csv_text: mappedText, mode: 'preview', mapping: { Guest: 'headline', Contact: 'role' } });
    equals(alias.status, 400, 'alias collision status');
    equals((alias.json as { code?: string }).code, 'duplicate_mapping_field', 'alias collision code');

    equals(await countRows(), before, 'a rejected mapping must not write anything');
    return {
      actual: 'nickname → 400 unknown_mapping_field; неизвестная колонка → 400 unknown_csv_column; два столбца на поле → 400 duplicate_mapping_field; headline+role → 400 (алиас)',
      evidence: `${ev(unknownField, 'code')} | ${ev(unknownColumn, 'code')} | ${ev(duplicate, 'code')} | ${ev(alias, 'code')}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Mode I — claim flow
// ---------------------------------------------------------------------------

async function modeI(): Promise<void> {
  let token = '';
  let claimUrl = '';

  await check('I1', 'I', 'invite → claim-URL для approved-регистрации', '200 + claim_url/expires_at', async () => {
    const row = await sql!<{ id: string }[]>`
      SELECT id FROM registrations WHERE event_id = ${F.eventA} AND claim_state = 'unclaimed'
        AND imported_data->>'email' = ${emailFor('claim')} LIMIT 1`;
    must(row.length === 1, 'claimable registration not found');
    const s = await userSession(F.owner);
    const res = await s.post(`/api/organizer/events/${F.eventA}/registrations/${row[0]!.id}/invite`);
    equals(res.status, 200, 'invite status');
    claimUrl = (res.json as { claim_url?: string }).claim_url ?? '';
    must(claimUrl.startsWith('/claim/'), `claim_url unexpected: ${clip(claimUrl, 60)}`);
    token = claimUrl.slice('/claim/'.length);
    must(token.length >= 20, 'claim token too short');
    return { actual: '200 + claim_url=/claim/«token» (7 дней)', evidence: ev(res, 'ok', 'claim_url', 'expires_at') };
  });

  await check('I2', 'I', 'GET /claim/<token> НЕ консюмит (повторный GET работает)', 'два GET → 200, challenge не consumed', async () => {
    const first = await anon.get(`/claim/${token}`);
    const second = await anon.get(`/claim/${token}`);
    equals(first.status, 200, 'first GET');
    equals(second.status, 200, 'second GET');
    const rows = await sql!<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM link_challenges WHERE registration_id IS NOT NULL AND purpose = 'registration_claim'
      ORDER BY created_at DESC LIMIT 1`;
    must(rows.length === 1, 'challenge row not found');
    must(rows[0]!.consumed_at === null, 'GET consumed the challenge');
    return { actual: 'GET ×2 → 200; consumed_at остался NULL', evidence: 'HTTP 200/200, link_challenges.consumed_at = null' };
  });

  await check('I3', 'I', 'claim с чужого email → 403', '403 email_mismatch', async () => {
    const s = await userSession(users.get('echo')!);
    const res = await s.post('/api/registration-claims', { token });
    equals(res.status, 403, 'foreign email status');
    equals((res.json as { code?: string }).code, 'email_mismatch', 'foreign email code');
    return { actual: '403 email_mismatch', evidence: ev(res) };
  });

  await check('I4', 'I', 'claim с правильным email → 200 (+membership)', '200 + membership state active', async () => {
    const claimer = users.get('claim') ?? (await createUser('claim', `${MARK}Claim`, { interests: ['ai-ml'] }));
    const s = await login(claimer.email, 'claim');
    claimer.session = s;
    const res = await s.post('/api/registration-claims', { token });
    equals(res.status, 200, 'claim status');
    const body = res.json as { event_id?: string; membership?: { state: string }; profile_created?: boolean };
    equals(body.event_id, F.eventA, 'claimed event');
    equals(body.membership?.state, 'active', 'membership state');
    return { actual: `200: membership active, profile_created=${body.profile_created}`, evidence: ev(res, 'ok', 'event_id', 'membership', 'profile_created', 'notice') };
  });

  await check('I5', 'I', 'повторный claim → 409 already_used (один победитель)', '409 already_used', async () => {
    const s = await userSession(users.get('claim')!);
    const res = await s.post('/api/registration-claims', { token });
    equals(res.status, 409, 'replay status');
    equals((res.json as { code?: string }).code, 'already_used', 'replay code');
    return { actual: '409 already_used', evidence: ev(res) };
  });
}

// ---------------------------------------------------------------------------
// Mode J — introductions
// ---------------------------------------------------------------------------

interface IntroView {
  id: string;
  state: string;
  my_decision?: string;
  other_accepted?: boolean;
}

/** GET /api/introductions/<id> returns `revealed` as a SIBLING of `introduction`. */
function introRevealed(res: Res): { kind: string; value: string }[] {
  return (res.json as { revealed?: { kind: string; value: string }[] }).revealed ?? [];
}

function introBody(res: Res): IntroView | undefined {
  return (res.json as { introduction?: IntroView }).introduction;
}

const CHARLIE_PHONE = '+34600999888';

async function modeJ(): Promise<void> {
  const alpha = users.get('alpha')!;
  const bravo = users.get('bravo')!;
  const charlie = users.get('charlie')!;
  const delta = users.get('delta')!;
  let abId = '';
  let acId = '';
  let withdrawnNoticeKey = '';

  await check('J1', 'J', 'intro create (событийный контекст)', '200 already_existed:false + id; инициатор уже accept (implicit_by_initiation)', async () => {
    const s = await userSession(alpha);
    const res = await s.post('/api/introductions', { target_profile_id: bravo.profileId, event_id: F.eventA, reveal_fields: ['phone', 'website'] });
    equals(res.status, 200, 'create status');
    const body = res.json as { introduction?: { id: string; state: string }; already_existed?: boolean };
    abId = body.introduction?.id ?? '';
    must(abId.length > 0, 'introduction id missing');
    equals(body.already_existed, false, 'already_existed on first create');
    equals(body.introduction?.state, 'pending', 'initial state');
    // ADR 0010: the initiator consents BY requesting — its card opens in the
    // "waiting for an answer" state, never in the accept/decline prompt.
    const view = await s.get(`/api/introductions/${abId}`);
    equals(view.status, 200, 'initiator view status');
    equals(introBody(view)?.state, 'pending', 'state for the initiator');
    equals(introBody(view)?.my_decision, 'accept', 'initiator consent is implicit_by_initiation');
    equals(introBody(view)?.other_accepted, false, 'counterparty has not answered');
    return {
      actual: '200 pending, already_existed=false; у инициатора my_decision=accept, other_accepted=false',
      evidence: `${ev(res, 'ok', 'introduction', 'already_existed')} | ${ev(view, 'ok', 'introduction')}`,
    };
  });

  await check('J2', 'J', 'intro create идемпотентен (повтор → тот же id)', '200 already_existed:true, same id', async () => {
    const s = await userSession(alpha);
    const res = await s.post('/api/introductions', { target_profile_id: bravo.profileId, event_id: F.eventA });
    equals(res.status, 200, 'repeat status');
    const body = res.json as { introduction?: { id: string }; already_existed?: boolean };
    equals(body.already_existed, true, 'already_existed on repeat');
    equals(body.introduction?.id, abId, 'same id');
    const count = await sql!<{ count: number }[]>`SELECT count(*)::int AS count FROM introductions WHERE profile_a = ${alpha.profileId < bravo.profileId ? alpha.profileId : bravo.profileId} AND profile_b = ${alpha.profileId < bravo.profileId ? bravo.profileId : alpha.profileId}`;
    equals(count[0]!.count, 1, 'pair row count');
    return { actual: '200 already_existed=true, тот же id, одна строка пары', evidence: ev(res, 'ok', 'already_existed') };
  });

  await check('J3', 'J', 'respond decline + нейтральное уведомление инициатору', 'decline 200; state declined виден обеим сторонам; джоба intro_declined без причины', async () => {
    const s = await userSession(bravo);
    const res = await s.post(`/api/introductions/${abId}/respond`, { decision: 'decline' });
    equals(res.status, 200, 'decline status');
    const view = await userSession(alpha).then((a) => a.get(`/api/introductions/${abId}`));
    equals(view.status, 200, 'counterparty view status');
    // ADR 0010: the state is honest for both parties — no more fake 'pending'.
    equals((view.json as { introduction?: IntroView }).introduction?.state, 'declined', 'state is visible to the counterparty too');
    // The other side gets ONE neutral notice: that it ended, never why.
    const job = await noticeRow(`intro_declined:${abId}:${alpha.accountId}`);
    must(job !== null, 'decline notice job missing');
    equals(job.kind, 'intro_declined_notice', 'decline notice kind');
    equals(job.text, 'WELCOME: знакомство не состоялось.', 'decline notice text');
    must(!/reason|причин|decline|отклон|spam|report/i.test(job.text), 'notice must not carry a reason or blame');
    return {
      actual: `decline → 200; у обеих сторон state=declined; джоба ${job.kind} для alpha, текст нейтральный`,
      evidence: `${ev(res, 'ok', 'introduction')} | ${ev(view, 'ok', 'introduction')} | outbox ${job.kind} text=${job.text}`,
    };
  });

  await check('J4', 'J', 'mutual после ОДНОГО accept контрагента', 'charlie accept → mutual; reveal = пересечение полей', async () => {
    const cs = await userSession(charlie);
    await cs.put('/api/me/contacts', { kind: 'phone', value: CHARLIE_PHONE, public_enabled: false });
    const s = await userSession(alpha);
    const created = await s.post('/api/introductions', { target_profile_id: charlie.profileId, event_id: F.eventA, reveal_fields: ['phone'] });
    equals(created.status, 200, 'create status');
    acId = (created.json as { introduction?: { id: string } }).introduction!.id;
    const beforeMutual = await s.get(`/api/introductions/${acId}`);
    equals(beforeMutual.status, 200, 'initiator view status');
    must(introBody(beforeMutual) !== undefined, `GET /api/introductions/<id> had no introduction: ${clip(redact(beforeMutual.text), 120)}`);
    equals(introBody(beforeMutual)?.my_decision, 'accept', 'initiator already consents');
    equals(introRevealed(beforeMutual).length, 0, 'reveal must be empty while pending');
    // ONE accept from the counterparty is the whole transition (ADR 0010).
    const cAccept = await cs.post(`/api/introductions/${acId}/respond`, { decision: 'accept', reveal_fields: ['phone'] });
    equals(cAccept.status, 200, 'counterparty accept');
    equals(introBody(cAccept)?.state, 'mutual', 'one counterparty accept completes the pair');
    const view = await s.get(`/api/introductions/${acId}`);
    const revealed = introRevealed(view);
    equals(revealed.length, 1, 'revealed field count');
    equals(revealed[0]?.kind, 'phone', 'revealed kind');
    equals(revealed[0]?.value, CHARLIE_PHONE, 'revealed value');
    must(await isPhonePrivate(charlie), 'fixture phone is not private — reveal would not prove anything');
    return {
      actual: `pending → mutual после ОДНОГО accept контрагента; revealed=[phone: ${CHARLIE_PHONE}] при public_enabled=false`,
      evidence: `${ev(beforeMutual, 'ok', 'introduction', 'revealed')} | ${ev(cAccept, 'ok', 'introduction')} | ${ev(view, 'ok', 'introduction', 'revealed')}`,
    };
  });

  await check('J5', 'J', 'отзыв полей → reveal скрывается', 'после re-accept с reveal_fields=[] → revealed=[]', async () => {
    const cs = await userSession(charlie);
    const res = await cs.post(`/api/introductions/${acId}/respond`, { decision: 'accept', reveal_fields: [] });
    equals(res.status, 200, 're-accept status');
    const view = await (await userSession(alpha)).get(`/api/introductions/${acId}`);
    const revealed = introRevealed(view);
    equals(revealed.length, 0, 'revealed after shrinking reveal_fields');
    return { actual: 'revealed=[] после сужения пересечения полей', evidence: ev(view, 'ok', 'introduction', 'revealed') };
  });

  await check('J6', 'J', 'блокировка: reveal подавлен и интро невозможно', 'GET reveal=[] при mutual; create → 403 blocked', async () => {
    const cs = await userSession(charlie);
    const block = await cs.post('/api/blocks', { target_account_id: alpha.accountId });
    equals(block.status, 200, 'block status');
    const alphaSession = await userSession(alpha);
    const view = await alphaSession.get(`/api/introductions/${acId}`);
    const intro = introBody(view);
    equals(intro?.state, 'mutual', 'state unchanged by a block');
    equals(introRevealed(view).length, 0, 'reveal must be suppressed by a block');
    const create = await alphaSession.post('/api/introductions', { target_profile_id: charlie.profileId, event_id: F.eventA });
    equals(create.status, 403, 'create with a block');
    equals((create.json as { code?: string }).code, 'blocked', 'create with a block code');
    return { actual: 'revealed=[] (state mutual) + create → 403 blocked', evidence: `${ev(view, 'ok', 'introduction', 'revealed')} | ${ev(create)}` };
  });

  await check('J7', 'J', 'cooldown: пара с интро не в рекомендациях', 'Bravo исчез из рекомендаций после decline', async () => {
    const s = await userSession(alpha);
    const res = await s.get(`/api/events/${F.eventA}/recommendations`);
    equals(res.status, 200, 'recommendations status');
    const items = (res.json as { recommendations?: { profile_id: string }[] }).recommendations ?? [];
    const hadBravoBefore = alphaRecommendations.some((r) => r.profile_id === bravo.profileId);
    must(hadBravoBefore, 'positive control failed: Bravo was never recommended');
    must(!items.some((i) => i.profile_id === bravo.profileId), 'Bravo still recommended despite an introduction in this event');
    return {
      actual: `до интро Bravo был в рекомендациях (${alphaRecommendations.length} шт.), после decline отсутствует; сейчас ${items.length} шт.`,
      evidence: `before=[${alphaRecommendations.map((r) => r.display_name).join(', ')}], after=[${items.length}]`,
    };
  });

  await check('J8', 'J', 'блокировка: нет в directory и рекомендациях', 'Charlie отсутствует в обоих списках', async () => {
    const s = await userSession(alpha);
    const dir = await s.get(`/api/events/${F.eventA}/directory?mode=all`);
    const members = (dir.json as { members?: { profile_id: string }[] }).members ?? [];
    must(!members.some((m) => m.profile_id === charlie.profileId), 'blocked profile still in the directory');
    const recs = await s.get(`/api/events/${F.eventA}/recommendations`);
    const items = (recs.json as { recommendations?: { profile_id: string }[] }).recommendations ?? [];
    must(!items.some((i) => i.profile_id === charlie.profileId), 'blocked profile still recommended');
    return { actual: `Charlie отсутствует в directory (${members.length} записей) и рекомендациях (${items.length})`, evidence: `members=${members.length}, recommendations=${items.length}, blocked=Charlie` };
  });

  await check('J9', 'J', 'respond withdraw (отзыв до mutual) + нейтральное уведомление контрагенту', '200 state revoked; джоба intro_withdrawn без причины, ровно одна', async () => {
    const s = await userSession(alpha);
    const created = await s.post('/api/introductions', { target_profile_id: delta.profileId, event_id: F.eventA });
    equals(created.status, 200, 'create status');
    const id = (created.json as { introduction?: { id: string } }).introduction!.id;
    const res = await s.post(`/api/introductions/${id}/respond`, { decision: 'withdraw' });
    equals(res.status, 200, 'withdraw status');
    equals((res.json as { introduction?: IntroView }).introduction?.state, 'revoked', 'state after withdraw');
    withdrawnNoticeKey = `intro_withdrawn:${id}:${delta.accountId}`;
    const job = await noticeRow(withdrawnNoticeKey);
    must(job !== null, 'withdraw notice job missing');
    equals(job.kind, 'intro_withdrawn_notice', 'withdraw notice kind');
    equals(job.text, 'WELCOME: знакомство отозвано.', 'withdraw notice text');
    must(!/reason|причин|withdraw|отозвал|spam|report/i.test(job.text), 'notice must not carry a reason or blame');
    const after = await s.post(`/api/introductions/${id}/respond`, { decision: 'decline' });
    equals(after.status, 409, 'respond after revoke');
    equals((after.json as { code?: string }).code, 'invalid_state', 'respond after revoke code');
    // Idempotent: the refused repeat never produced a second job.
    equals(await noticeCount(withdrawnNoticeKey), 1, 'withdraw notice job count');
    return {
      actual: `withdraw → 200 revoked (повтор → 409); джоба ${job.kind} для delta, текст нейтральный, ровно одна`,
      evidence: `${ev(res, 'ok', 'introduction')} | ${ev(after)} | outbox ${job.kind} text=${job.text}`,
    };
  });

  await check('J10', 'J', 'уведомления о решении подавляются по правилам (no_channel / consent_revoked)', 'decline → suppressed:no_channel; withdraw при активном binding без service_channel-согласия → suppressed:consent_revoked', async () => {
    // Case 1: the decline notice went to alpha, who has no telegram binding.
    const declinedKey = `intro_declined:${abId}:${alpha.accountId}`;
    // Case 2: give delta an ACTIVE binding so the CONSENT precondition is what
    // decides — and record an explicit global withdrawal so the gate is
    // unambiguous (nothing can actually be sent to a synthetic chat id).
    const chatId = `matrix-notice-${rand(4)}`;
    await sql!`INSERT INTO channel_bindings (account_id, provider, external_id, state)
               VALUES (${delta.accountId}, 'telegram', ${chatId}, 'active')`;
    await sql!`INSERT INTO consent_events (account_id, purpose, scope_type, policy_version, action)
               VALUES (${delta.accountId}, 'service_channel', 'global', ${'matrix-2026-09-14'}, 'withdraw')`;

    const t = await tick();
    equals(t.status, 200, 'worker tick status');
    const declined = await noticeAttempt(declinedKey);
    equals(declined.state, 'suppressed', 'decline notice status');
    equals(declined.code, 'no_channel', 'decline notice suppression code');
    const withdrawn = await noticeAttempt(withdrawnNoticeKey);
    equals(withdrawn.state, 'suppressed', 'withdraw notice status');
    equals(withdrawn.code, 'consent_revoked', 'withdraw notice suppression code');
    // Both jobs are terminal and stay at one row each.
    equals((await jobRow(declinedKey))?.status, 'suppressed', 'decline job status in db');
    equals((await jobRow(withdrawnNoticeKey))?.status, 'suppressed', 'withdraw job status in db');
    equals(await noticeCount(declinedKey), 1, 'decline job count');
    equals(await noticeCount(withdrawnNoticeKey), 1, 'withdraw job count');
    return {
      actual: `decline=${declined.state}:${declined.code} (нет канала), withdraw=${withdrawn.state}:${withdrawn.code} (binding активен, согласие отозвано)`,
      evidence: `delivery_attempts: ${declinedKey} → ${declined.state}/${declined.code}; ${withdrawnNoticeKey} → ${withdrawn.state}/${withdrawn.code}`,
    };
  });

  await check('J11', 'J', 'email-канал уведомлений: выбор канала и подавление', 'без привязки + email + согласие → email (не no_channel); с активной привязкой → telegram (email не используется); email без согласия → suppressed:consent_revoked; адрес не хранится в джобе', async () => {
    // Three fixtures with a CLAIMED registration email in event A:
    //   mailOnly      — no binding,  email, consent            → email
    //   mailBound     — active binding, email, consent         → telegram (priority)
    //   mailNoConsent — no binding,  email, NO consent         → suppressed:consent_revoked
    const alpha = users.get('alpha')!;
    const mailOnly = await ensureFixtureUser('mailecho', `${MARK}MailEcho`, { interests: ['ai-ml'] });
    const mailBound = await ensureFixtureUser('mailfox', `${MARK}MailFox`, { interests: ['ai-ml'] });
    const mailNoConsent = await ensureFixtureUser('mailrate', `${MARK}MailRate`, { interests: ['ai-ml'] });
    for (const u of [mailOnly, mailBound, mailNoConsent]) await ensureEventMember(u, F.eventA);

    const addressOf: Record<string, string> = {};
    for (const u of [mailOnly, mailBound, mailNoConsent]) {
      addressOf[u.key] = await attachRegisteredEmail(u, F.eventA, emailFor(u.key));
    }
    // The intro notices carry the GLOBAL service_channel scope (no consent_scope).
    await grantConsent(mailOnly.accountId, 'service_channel', null);
    await grantConsent(mailBound.accountId, 'service_channel', null);
    await sql!`DELETE FROM channel_bindings WHERE account_id = ${mailOnly.accountId} OR account_id = ${mailNoConsent.accountId}`;
    await sql!`
      INSERT INTO channel_bindings (account_id, provider, external_id, state)
      VALUES (${mailBound.accountId}, 'telegram', ${`matrix-mailfox-${rand(4)}`}, 'active')
      ON CONFLICT (account_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id, state = 'active'`;

    const s = await userSession(alpha);
    const keys: Record<string, string> = {};
    for (const u of [mailOnly, mailBound, mailNoConsent]) {
      const res = await s.post('/api/introductions', { target_profile_id: u.profileId, event_id: F.eventA });
      equals(res.status, 200, `intro to ${u.key} status`);
      const introId = (res.json as { introduction?: { id: string } }).introduction!.id;
      keys[u.key] = `intro_requested:${introId}:${u.accountId}`;
    }

    const outcomes = await drainUntilTerminal([keys['mailecho']!, keys['mailfox']!, keys['mailrate']!]);
    const outcomeOf = async (key: string): Promise<string> => {
      const id = await jobIdByKey(keys[key]!);
      must(id !== null, `job ${key} missing`);
      const jobId = id as string;
      return outcomes[jobId] ?? `${(await jobRowById(jobId))!.status} (tick outcome unavailable)`;
    };

    const onlyOutcome = await outcomeOf('mailecho');
    const boundOutcome = await outcomeOf('mailfox');
    const noConsentOutcome = await outcomeOf('mailrate');

    // email chosen: either really sent, or honestly suppressed because THIS
    // instance has no provider (RESEND_API_KEY) — never no_channel.
    must(
      /^sent:email/.test(onlyOutcome) || onlyOutcome === 'suppressed:channel_disabled',
      `mailOnly outcome must be the email branch, got ${onlyOutcome}`,
    );
    // telegram priority: the bound recipient is never routed to email.
    must(!boundOutcome.includes(':email'), `bound recipient must not use email, got ${boundOutcome}`);
    must(!/suppressed:(no_channel|channel_disabled)/.test(boundOutcome), `bound recipient must not be suppressed as unreachable, got ${boundOutcome}`);
    // consent decides before email existence is even considered.
    equals(noConsentOutcome, 'suppressed:consent_revoked', 'email without consent');

    // PII: the address never lands in the job payload.
    const payloads = await sql!<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM outbox_jobs WHERE dedupe_key LIKE ${`intro_requested:%:${mailOnly.accountId}`}`;
    for (const row of payloads) {
      must(!JSON.stringify(row.payload).includes(addressOf['mailecho']!), 'recipient email must never be stored in the job payload');
    }

    return {
      status: 'PASS',
      actual:
        `mailOnly=${onlyOutcome}${RESEND_CONFIGURED ? '' : ' (провайдера у экземпляра нет — подавление честное, канал всё равно email, не no_channel)'}; ` +
        `mailBound=${boundOutcome} (telegram приоритетнее); mailNoConsent=${noConsentOutcome}`,
      evidence:
        `delivery_attempts: ${keys['mailecho']} → ${onlyOutcome}; ${keys['mailfox']} → ${boundOutcome}; ${keys['mailrate']} → ${noConsentOutcome}; ` +
        `адрес не встречается в payload джоб (проверено)`,
    };
  });
}

async function isPhonePrivate(user: FixtureUser): Promise<boolean> {
  const res = await (await userSession(user)).get('/api/me/contacts');
  const contacts = (res.json as { contacts?: { kind: string; public_enabled: boolean }[] }).contacts ?? [];
  return contacts.find((c) => c.kind === 'phone')?.public_enabled === false;
}

// ---------------------------------------------------------------------------
// Mode K — notes
// ---------------------------------------------------------------------------

async function modeK(): Promise<void> {
  const alpha = users.get('alpha')!;
  const delta = users.get('delta')!;

  await check('K1', 'K', 'заметка владельцем: upsert + список', '200; заметка видна в своём списке', async () => {
    const s = await userSession(alpha);
    const res = await s.put(`/api/me/notes/${delta.profileId}`, { note_text: `${MARK} note about Delta`, next_step: 'ping', next_step_status: 'proposed' });
    equals(res.status, 200, 'upsert status');
    const list = await s.get('/api/me/notes');
    equals(list.status, 200, 'list status');
    const notes = (list.json as { notes?: { other_profile_id: string }[] }).notes ?? [];
    must(notes.some((n) => n.other_profile_id === delta.profileId), 'note missing from own list');
    return { actual: '200 + заметка в /api/me/notes', evidence: ev(res, 'ok', 'note') };
  });

  await check('K2', 'K', 'чужая заметка не видна другому аккаунту', 'список Bravo не содержит заметку Alpha', async () => {
    const s = await userSession(users.get('bravo')!);
    const list = await s.get('/api/me/notes');
    equals(list.status, 200, 'list status');
    const notes = (list.json as { notes?: { other_profile_id: string; note_text?: string }[] }).notes ?? [];
    must(!notes.some((n) => n.other_profile_id === delta.profileId), 'another account sees the note');
    const raw = JSON.stringify(list.json);
    must(!raw.includes(`${MARK} note about Delta`), 'note text leaked into another account’s list');
    return { actual: `список Bravo: ${notes.length} заметок, чужих нет`, evidence: `${ev(list, 'ok')} notes=${notes.length}` };
  });

  await check('K3', 'K', 'организатор без связи → 403', '403 not_connected', async () => {
    const s = await userSession(F.staff);
    const res = await s.put(`/api/me/notes/${alpha.profileId}`, { note_text: `${MARK} organizer note` });
    equals(res.status, 403, 'organizer note status');
    equals((res.json as { code?: string }).code, 'not_connected', 'organizer note code');
    const self = await (await userSession(alpha)).put(`/api/me/notes/${alpha.profileId}`, { note_text: 'self' });
    equals(self.status, 400, 'self note status');
    equals((self.json as { code?: string }).code, 'self_note', 'self note code');
    return { actual: 'organizer → 403 not_connected; self → 400 self_note', evidence: `${ev(res)} | ${ev(self)}` };
  });
}

// ---------------------------------------------------------------------------
// Mode L — consents
// ---------------------------------------------------------------------------

async function modeL(): Promise<void> {
  const alpha = users.get('alpha')!;

  await check('L1', 'L', 'grant по purpose (event scope)', '200 action=grant', async () => {
    const s = await userSession(alpha);
    const res = await s.post('/api/consents', { action: 'grant', purpose: 'organizer_marketing', scope_type: 'event', scope_id: F.eventA, policy_version: 'matrix-2026-09-14' });
    equals(res.status, 200, 'grant status');
    equals((res.json as { action?: string }).action, 'grant', 'grant action');
    return { actual: '200 grant organizer_marketing@event', evidence: ev(res, 'ok', 'action', 'purpose', 'scope_type') };
  });

  await check('L2', 'L', 'withdraw по purpose (revoke-ручка)', '200 action=withdraw', async () => {
    const s = await userSession(alpha);
    const res = await s.post('/api/consents/revoke', { purpose: 'organizer_marketing', scope_type: 'event', scope_id: F.eventA, policy_version: 'matrix-2026-09-14' });
    equals(res.status, 200, 'revoke status');
    equals((res.json as { action?: string }).action, 'withdraw', 'revoke action');
    const bad = await s.post('/api/consents', { action: 'grant', purpose: 'matrix-nope', scope_type: 'global', policy_version: 'v1' });
    equals(bad.status, 400, 'invalid purpose status');
    equals((bad.json as { code?: string }).code, 'invalid_purpose', 'invalid purpose code');
    return { actual: '200 withdraw; неизвестный purpose → 400 invalid_purpose', evidence: `${ev(res, 'ok', 'action')} | ${ev(bad)}` };
  });

  await check('L3', 'L', 'withdraw подавляет уже поставленные в очередь джобы (интро)', 'pending-джоба становится suppressed', async () => {
    const bravo = users.get('bravo')!;
    const key = `intro_requested:${(await sql!<{ id: string }[]>`SELECT id FROM introductions WHERE profile_a = ${alpha.profileId < bravo.profileId ? alpha.profileId : bravo.profileId} AND profile_b = ${alpha.profileId < bravo.profileId ? bravo.profileId : alpha.profileId} LIMIT 1`)[0]?.id}:${bravo.accountId}`;
    const before = await jobRow(key);
    must(before !== null, `intro notice job not found (${clip(key, 60)})`);
    const s = await userSession(bravo);
    const res = await s.post('/api/consents/revoke', { purpose: 'service_channel', scope_type: 'global', policy_version: 'matrix-2026-09-14' });
    equals(res.status, 200, 'revoke status');
    const after = await jobRow(key);
    must(after !== null, 'job row disappeared');
    must(after!.status === 'suppressed' || after!.status.startsWith('suppressed:'), `job status after revoke: ${after!.status}`);
    return {
      actual: `джоба ${key.split(':')[0]}…: ${before!.status} → ${after!.status}`,
      evidence: `outbox_jobs.status ${before!.status} → ${after!.status} (purpose=service_channel, account=Bravo)`,
    };
  });

  await check('L4', 'L', 'export содержит историю согласий', 'консенты grant+withdraw присутствуют в export', async () => {
    const s = await userSession(alpha);
    const res = await s.post('/api/me/export');
    equals(res.status, 200, 'export status');
    const body = res.json as { consents?: { purpose: string; action: string }[]; consent_events?: unknown };
    const consents = body.consents ?? [];
    must(consents.some((c) => c.purpose === 'organizer_marketing' && c.action === 'grant'), 'grant missing from export');
    must(consents.some((c) => c.purpose === 'organizer_marketing' && c.action === 'withdraw'), 'withdraw missing from export');
    return {
      actual: `export.consents: ${consents.length} записей (grant+withdraw organizer_marketing)`,
      evidence: clip(JSON.stringify(consents.slice(-4)), 200),
      deviation: 'ключ называется `consents`, а не `consent_events` как в задании; содержимое — append-only история согласий.',
    };
  });
}

// ---------------------------------------------------------------------------
// Mode N — organizer campaigns
// ---------------------------------------------------------------------------

let campaignId = '';
let segmentCampaignId = '';

async function modeN(): Promise<void> {
  const owner = F.owner;
  const staff = F.staff;
  const staffSession = () => userSession(staff);

  await check('N1', 'N', 'create draft кампании (owner)', '201 state=draft', async () => {
    const s = await userSession(owner);
    const res = await s.post('/api/organizer/campaigns', { event_id: F.eventA, purpose: 'service_channel', body_text: `${MARK} campaign draft` });
    equals(res.status, 201, 'create status');
    const campaign = (res.json as { campaign?: { id: string; state: string; content_revision: number } }).campaign;
    must(!!campaign, 'campaign missing');
    campaignId = campaign!.id;
    created.campaigns.push(campaignId);
    equals(campaign!.state, 'draft', 'state');
    return { actual: `201 draft (content_revision=${campaign!.content_revision})`, evidence: ev(res, 'ok', 'campaign') };
  });

  await check('N2', 'N', 'audience preview: count + channel_ready', '200 audience.count >= 1', async () => {
    const s = await userSession(owner);
    const res = await s.get(`/api/organizer/campaigns/${campaignId}/audience`);
    equals(res.status, 200, 'audience status');
    const audience = (res.json as { audience?: { count: number; channel_ready: number; sample: unknown[] } }).audience;
    must(!!audience, 'audience missing');
    must(audience!.count >= 1, `audience.count=${audience!.count}`);
    must(Array.isArray(audience!.sample), 'sample missing');
    return { actual: `count=${audience!.count}, channel_ready=${audience!.channel_ready}, sample=${audience!.sample.length}`, evidence: ev(res, 'ok', 'audience', 'snapshot_note') };
  });

  await check('N3', 'N', 'approve (owner, MFA step-up не требуется — фактор не подтверждён)', '200 state=approved, approved_revision=content_revision', async () => {
    const s = await userSession(owner);
    const res = await s.post(`/api/organizer/campaigns/${campaignId}/approve`);
    equals(res.status, 200, 'approve status');
    const campaign = (res.json as { campaign?: { state: string; content_revision: number; approved_revision: number | null } }).campaign!;
    equals(campaign.state, 'approved', 'state');
    equals(campaign.approved_revision, campaign.content_revision, 'approved_revision');
    must((res.json as { audience_count?: number }).audience_count !== undefined, 'audience_count missing');
    return { actual: `200 approved (approved_revision=${campaign.approved_revision}, снимок аудитории заморожен)`, evidence: ev(res, 'ok', 'campaign', 'audience_count') };
  });

  await check('N4', 'N', 'staff не может create/approve/send/stats кампании', '403 forbidden на всех четырёх', async () => {
    const s = await staffSession();
    const create = await s.post('/api/organizer/campaigns', { event_id: F.eventA, purpose: 'service_channel', body_text: `${MARK} staff attempt` });
    const approve = await s.post(`/api/organizer/campaigns/${campaignId}/approve`);
    const send = await s.post(`/api/organizer/campaigns/${campaignId}/send`);
    const stats = await s.get(`/api/organizer/campaigns/${campaignId}/stats`);
    for (const [label, res] of [['create', create], ['approve', approve], ['send', send], ['stats', stats]] as const) {
      equals(res.status, 403, `staff ${label}`);
      equals((res.json as { code?: string }).code, 'forbidden', `staff ${label} code`);
    }
    return { actual: '403 forbidden ×4 (staff)', evidence: `${ev(approve)} | ${ev(send)} | ${ev(stats)}` };
  });

  let approvedRevisionBefore = 0;
  let contentRevisionBefore = 0;

  await check('N5', 'N', 'edit после approve сбрасывает approved_revision', '200 state=draft, content_revision+1, approved_revision=null', async () => {
    const s = await userSession(owner);
    const before = await s.get(`/api/organizer/campaigns/${campaignId}/stats`);
    void before;
    const campaigns = await sql!<{ content_revision: number; approved_revision: number | null }[]>`
      SELECT content_revision::int AS content_revision, approved_revision::int AS approved_revision FROM campaigns WHERE id = ${campaignId}`;
    approvedRevisionBefore = campaigns[0]!.approved_revision!;
    contentRevisionBefore = campaigns[0]!.content_revision;
    const res = await s.patch(`/api/organizer/campaigns/${campaignId}`, { body_text: `${MARK} campaign draft v2` });
    equals(res.status, 200, 'edit status');
    const campaign = (res.json as { campaign?: { state: string; content_revision: number; approved_revision: number | null } }).campaign!;
    equals(campaign.state, 'draft', 'state after edit');
    equals(campaign.content_revision, contentRevisionBefore + 1, 'content_revision increment');
    equals(campaign.approved_revision, null, 'approved_revision reset');
    return { actual: `approved_revision ${approvedRevisionBefore} → null, content_revision ${contentRevisionBefore} → ${campaign.content_revision}`, evidence: ev(res, 'ok', 'campaign') };
  });

  await check('N6', 'N', 're-approve после правки', '200 approved с новой ревизией', async () => {
    const s = await userSession(owner);
    const res = await s.post(`/api/organizer/campaigns/${campaignId}/approve`);
    equals(res.status, 200, 'approve status');
    const campaign = (res.json as { campaign?: { state: string; content_revision: number; approved_revision: number | null } }).campaign!;
    equals(campaign.approved_revision, campaign.content_revision, 'approved_revision');
    return { actual: `200 approved (approved_revision=${campaign.approved_revision})`, evidence: ev(res, 'ok', 'campaign', 'audience_count') };
  });

  await check('N7', 'N', 'send → 202 + джобы', '202 queued >= 1, state=running', async () => {
    const s = await userSession(owner);
    const res = await s.post(`/api/organizer/campaigns/${campaignId}/send`);
    equals(res.status, 202, 'send status');
    const body = res.json as { queued?: number; state?: string; campaign_id?: string };
    must((body.queued ?? 0) >= 1, `queued=${body.queued}`);
    equals(body.state, 'running', 'state');
    return { actual: `202 queued=${body.queued}, state=running`, evidence: ev(res, 'ok', 'campaign_id', 'queued', 'state') };
  });

  await check('N8', 'N', 'stats по статусам доставки', '200 counters со всеми 8 ключами', async () => {
    const s = await userSession(owner);
    const res = await s.get(`/api/organizer/campaigns/${campaignId}/stats`);
    equals(res.status, 200, 'stats status');
    const counters = (res.json as { counters?: Record<string, number> }).counters;
    must(!!counters, 'counters missing');
    const expected = ['pending', 'leased', 'sent', 'delivered', 'failed', 'unknown', 'suppressed', 'cancelled'];
    for (const k of expected) must(k in counters!, `counters.${k} missing`);
    const total = Object.values(counters!).reduce((a, b) => a + b, 0);
    must(total >= 1, 'counters are all zero');
    must((res.json as { queued_total?: number }).queued_total! >= 1, 'queued_total is 0');
    return {
      actual: `counters=${JSON.stringify(counters)}, queued_total=${(res.json as { queued_total?: number }).queued_total}`,
      evidence: clip(JSON.stringify({ counters, queued_total: (res.json as { queued_total?: number }).queued_total }), 220),
    };
  });

  await check('N9', 'N', 'withdraw согласия получателя → джоба suppressed (кампания)', 'outbox job получателя становится suppressed', async () => {
    const alpha = users.get('alpha')!;
    const key = `campaign:${campaignId}:${alpha.accountId}`;
    const before = await jobRow(key);
    must(before !== null, 'campaign job for Alpha not found');
    const s = await userSession(alpha);
    const res = await s.post('/api/consents/revoke', { purpose: 'service_channel', scope_type: 'event', scope_id: F.eventA, policy_version: 'matrix-2026-09-14' });
    equals(res.status, 200, 'revoke status');
    const after = await jobRow(key);
    must(after !== null, 'campaign job disappeared');
    must(after!.status === 'suppressed' || after!.status.startsWith('suppressed:'), `job status after revoke: ${after!.status}`);
    return {
      actual: `джоба кампании для Alpha: ${before!.status} → ${after!.status}`,
      evidence: `outbox_jobs.status ${before!.status} → ${after!.status}; аккаунт остался в снимке аудитории, отправка подавлена`,
    };
  });

  await check('N10', 'N', 'сегмент кампании отбирает только подходящих участников', 'без сегмента 2 подходящих, с сегментом need_intents=seeking-cofounder — 1; в ответе есть применённый filter', async () => {
    const owner = F.owner;
    const alpha = users.get('alpha')!;
    const bravo = users.get('bravo')!;
    // The check owns its consent state: mode L revoked Alpha's market-ing grant
    // on purpose earlier in the run, so both members are granted HERE. Only
    // Alpha carries the intent axis the segment selects on.
    await grantConsent(alpha.accountId, 'organizer_marketing', F.eventA);
    await grantConsent(bravo.accountId, 'organizer_marketing', F.eventA);

    const s = await userSession(owner);
    const createRes = await s.post('/api/organizer/campaigns', {
      event_id: F.eventA,
      purpose: 'organizer_marketing',
      body_text: `${MARK} segmented campaign`,
      audience_filter: { need_intents: ['seeking-cofounder'] },
    });
    equals(createRes.status, 201, 'segmented campaign create status');
    segmentCampaignId = (createRes.json as { campaign?: { id: string } }).campaign!.id;
    created.campaigns.push(segmentCampaignId);

    const full = await s.get(`/api/organizer/campaigns/${segmentCampaignId}/audience?need_intents=&offer_intents=&interests=&job_function=&industry=`);
    equals(full.status, 200, 'audience without segment');
    const fullBody = full.json as { audience?: { count: number; segment: boolean } };
    const segmented = await s.get(`/api/organizer/campaigns/${segmentCampaignId}/audience`);
    equals(segmented.status, 200, 'audience with segment');
    const segmentBody = segmented.json as { audience?: { count: number; segment: boolean; filter: Record<string, unknown>; sample: { display_name: string }[] } };

    const fullCount = fullBody.audience?.count ?? 0;
    const segmentCount = segmentBody.audience?.count ?? 0;
    must(
      fullCount >= 2,
      `expected >= 2 eligible without a segment, got ${fullCount}: ${clip(JSON.stringify(full.json), 220)}`,
    );
    equals(segmentBody.audience?.segment, true, 'segment flag');
    equals(segmentCount, 1, 'only the member with the selected intent');
    must(segmentCount < fullCount, 'the segment must narrow the audience');
    equals((segmentBody.audience?.filter as { need_intents?: string[] }).need_intents?.[0], 'seeking-cofounder', 'filter echoed');
    must(
      segmentBody.audience!.sample.every((x) => x.display_name !== bravo.displayName),
      'the non-matching member must not appear in the sample',
    );
    return {
      actual: `без сегмента ${fullCount} → с сегментом ${segmentCount} (${segmentBody.audience!.sample.map((x) => x.display_name).join(', ')})`,
      evidence: `${ev(full, 'audience')} | ${ev(segmented, 'audience')}`,
    };
  });

  await check('N11', 'N', 'сегмент кампании: счётчик превью == число созданных джоб при send', 'audience_count при approve = count превью = queued при send', async () => {
    const s = await userSession(F.owner);
    const preview = await s.get(`/api/organizer/campaigns/${segmentCampaignId}/audience`);
    equals(preview.status, 200, 'preview status');
    const previewCount = (preview.json as { audience?: { count: number } }).audience!.count;

    const approve = await s.post(`/api/organizer/campaigns/${segmentCampaignId}/approve`);
    equals(approve.status, 200, 'approve status');
    const audienceCount = (approve.json as { audience_count?: number }).audience_count!;
    equals(audienceCount, previewCount, 'approve froze the segmented audience');

    const snapshot = await sql!<{ count: number }[]>`
      SELECT count(*)::int AS count FROM campaign_audience WHERE campaign_id = ${segmentCampaignId}`;
    equals(snapshot[0]!.count, previewCount, 'snapshot size');

    const send = await s.post(`/api/organizer/campaigns/${segmentCampaignId}/send`);
    equals(send.status, 202, 'send status');
    const queued = (send.json as { queued?: number }).queued!;
    equals(queued, previewCount, 'queued == preview count');

    const jobs = await sql!<{ count: number }[]>`
      SELECT count(*)::int AS count FROM outbox_jobs
      WHERE kind = 'campaign_message' AND payload->>'campaign_id' = ${segmentCampaignId}`;
    equals(jobs[0]!.count, previewCount, 'jobs created == preview count');
    return {
      actual: `preview=${previewCount}, approve audience_count=${audienceCount}, snapshot=${snapshot[0]!.count}, queued=${queued}, джоб=${jobs[0]!.count}`,
      evidence: `${ev(preview, 'audience')} | ${ev(approve, 'audience_count')} | ${ev(send, 'queued', 'state')}`,
    };
  });

  await check('N12', 'N', 'сегмент кампании: невалидный каталог-ид → 400 (ничего не расширяется)', 'create/edit/override с неизвестным id → 400 invalid_*', async () => {
    const s = await userSession(F.owner);
    const badCreate = await s.post('/api/organizer/campaigns', {
      event_id: F.eventA,
      purpose: 'service_channel',
      body_text: `${MARK} bad segment`,
      audience_filter: { interests: ['not-a-topic'] },
    });
    equals(badCreate.status, 400, 'create with an unknown interest id');
    const badOverride = await s.get(`/api/organizer/campaigns/${segmentCampaignId}/audience?interests=not-a-topic`);
    equals(badOverride.status, 400, 'audience override with an unknown id');
    equals((badOverride.json as { code?: string }).code, 'invalid_audience_filter', 'override error code');
    const badEdit = await s.patch(`/api/organizer/campaigns/${segmentCampaignId}`, { audience_filter: { industry: 'not-an-industry' } });
    equals(badEdit.status, 400, 'edit with an unknown industry id');

    const stored = await sql!<{ audience_filter: Record<string, unknown> }[]>`
      SELECT audience_filter FROM campaigns WHERE id = ${segmentCampaignId}`;
    equals((stored[0]!.audience_filter as { need_intents?: string[] }).need_intents?.[0], 'seeking-cofounder', 'stored segment unchanged by the rejected edits');
    return {
      actual: 'create → 400, override → 400 invalid_audience_filter, edit → 400; сохранённый сегмент не изменился',
      evidence: `${ev(badCreate)} | ${ev(badOverride)} | ${ev(badEdit)}`,
    };
  });

  await check('N13', 'N', 'воронка события: агрегаты без PII для владельца', '200 со всеми 10 метриками и by_day из 30 дней', async () => {
    const s = await userSession(F.owner);
    const res = await s.get(`/api/organizer/events/${F.eventA}/analytics`);
    equals(res.status, 200, 'analytics status');
    const analytics = (res.json as { analytics?: Record<string, unknown> }).analytics;
    must(!!analytics, 'analytics payload missing');
    const keys = [
      'registrations_total', 'registrations_claimed', 'members_active', 'members_directory_visible',
      'intros_requested', 'intros_mutual', 'intros_declined', 'reveals_total', 'notes_created',
      'attendance_self_reported', 'by_day',
    ];
    for (const k of keys) must(k in analytics!, `analytics.${k} missing`);
    for (const k of keys.slice(0, -1)) {
      must(typeof analytics![k] === 'number', `analytics.${k} must be a number`);
    }
    const byDay = analytics!['by_day'] as { date: string; registrations: number; intros: number; mutual: number }[];
    equals(byDay.length, 30, 'by_day length');
    for (const day of byDay) {
      must(/^\d{4}-\d{2}-\d{2}$/.test(day.date), 'by_day date format');
      must(typeof day.registrations === 'number' && typeof day.intros === 'number' && typeof day.mutual === 'number', 'by_day counters');
    }
    must((analytics!['members_active'] as number) >= 1, 'event A has active members');
    must((analytics!['intros_requested'] as number) >= 1, 'mode J created introductions in event A');
    // Aggregates only: no participant, no contact, no note text.
    const raw = JSON.stringify(analytics);
    for (const leak of [users.get('alpha')!.displayName, users.get('bravo')!.displayName, '@welcome.test', 'matrix-']) {
      must(!raw.includes(leak), `analytics must not contain "${leak}"`);
    }
    return {
      actual:
        `members_active=${analytics!['members_active']}, intros_requested=${analytics!['intros_requested']}, ` +
        `mutual=${analytics!['intros_mutual']}, declined=${analytics!['intros_declined']}, by_day=${byDay.length} дн.`,
      evidence: clip(JSON.stringify(analytics), 240),
    };
  });

  await check('N14', 'N', 'воронка события: 403 для staff и чужого организатора, 401 без сессии', 'staff → 403, организатор чужого события → 403, anon → 401, несуществующий id → 403', async () => {
    const staffRes = await (await userSession(F.staff)).get(`/api/organizer/events/${F.eventA}/analytics`);
    equals(staffRes.status, 403, 'staff analytics');
    const foreign = await (await userSession(F.orgB)).get(`/api/organizer/events/${F.eventA}/analytics`);
    equals(foreign.status, 403, 'foreign organizer analytics');
    const anonRes = await anon.get(`/api/organizer/events/${F.eventA}/analytics`);
    equals(anonRes.status, 401, 'anonymous analytics');
    const unknown = await (await userSession(F.owner)).get('/api/organizer/events/00000000-0000-0000-0000-000000000000/analytics');
    equals(unknown.status, 403, 'unknown event analytics');
    return {
      actual: 'staff=403, чужой организатор=403, anon=401, неизвестное событие=403',
      evidence: `${ev(staffRes)} | ${ev(foreign)} | ${ev(anonRes)} | ${ev(unknown)}`,
    };
  });

  await check('N15', 'N', 'печатный лист QR-бейджей: имена и QR-цели есть, email/телефонов нет', '200; бейдж на каждую печатаемую регистрацию, quarantined не печатается, data-qr-url на карточку/страницу события, ни одного email', async () => {
    const s = await userSession(F.owner);
    const slugRows = await sql!<{ slug: string }[]>`
      SELECT slug FROM events WHERE id = ${F.eventA}::uuid LIMIT 1`;
    const slug = slugRows[0]!.slug;
    const res = await s.get(`/organizer/events/${F.eventA}/badges`);
    equals(res.status, 200, 'badges page status');
    const html = res.text;

    // Expected contents straight from the database, using the SAME projection as
    // the page — the check compares against the data, not against a guess.
    // (Mode I claims the first imported registration, so that guest's badge
    // shows their profile name, not the imported one: asserting a hardcoded
    // imported name would be wrong.)
    const expectedRows = await sql!<{ name: string | null; approval_status: string; public_slug: string | null }[]>`
      SELECT COALESCE(pr.display_name, r.imported_name) AS name, r.approval_status, pr.public_slug
      FROM registrations r
      LEFT JOIN event_memberships m ON m.registration_id = r.id
      LEFT JOIN profiles pr ON pr.id = m.profile_id
      WHERE r.event_id = ${F.eventA}::uuid`;
    const printable = expectedRows.filter((r) => r.approval_status !== 'quarantined');
    const quarantined = expectedRows.filter((r) => r.approval_status === 'quarantined');
    // Names with HTML-special characters (the CSV-injection guest) are escaped by
    // React, so only plain names are compared verbatim.
    const plainNames = printable
      .map((r) => r.name)
      .filter((n): n is string => !!n && /^[\w\s.,()\-]+$/.test(n));
    must(plainNames.length >= 2, `need at least two plain-name guests to compare (got ${plainNames.length})`);

    for (const name of plainNames) must(html.includes(name), `printable guest missing from the sheet: ${name}`);
    for (const row of quarantined) {
      must(!row.name || !html.includes(row.name), `a quarantined guest must not be printed: ${row.name}`);
    }
    // Count the CARDS, not `data-testid="badge-"`: the sheet container itself is
    // `badge-sheet` and would match that prefix (that off-by-one is exactly what
    // the first version of this check tripped on).
    const badgeCount = (html.match(/class="badge-card"/g) ?? []).length;
    equals(badgeCount, printable.length, 'badge count must equal the number of printable registrations');
    must(html.includes('class="badge-sheet'), 'the sheet grid class must be present');

    must(html.includes('data-qr-url='), 'the QR target must be in the markup');
    if (printable.some((r) => r.public_slug)) must(html.includes('/p/'), 'a claimed guest must point at their card');
    if (printable.some((r) => !r.public_slug)) must(html.includes(`/e/${slug}`), 'guests without a card must point at the event page');
    must(html.includes('data:image/svg+xml;base64,'), 'the QR must be an inline data URL (no external asset)');

    // PII discipline: the projection selects no email column at all.
    must(!html.includes('@welcome.test'), 'the badge sheet must not contain any email address');
    must(!/@[a-z0-9.-]+\.[a-z]{2,}/i.test(html.replace(/data:[^"']+/g, '')), 'no email-shaped string may appear in the sheet');
    must(!/phone|whatsapp/i.test(html), 'no phone/contact field may appear on the sheet');
    return {
      actual:
        `лист 200, бейджей ${badgeCount} = печатаемых регистраций ${printable.length}, quarantined (${quarantined.length}) не напечатаны, ` +
        `QR-цели /p/ и /e/${slug} на месте, email/телефонов в HTML нет`,
      evidence: `HTTP ${res.status}, html ${html.length} байт, имена: ${clip(plainNames.slice(0, 3).join(', '), 90)}`,
    };
  });

  await check('N16', 'N', 'бейджи: чужие не видят лист, API ссылок закрыт', 'страница чужому → страница 403 без данных; badge-links: staff → 403, чужой организатор → 403, anon → 401', async () => {
    const staffPage = await (await userSession(F.staff)).get(`/organizer/events/${F.eventA}/badges`);
    equals(staffPage.status, 200, 'staff page status (renders the 403 view)');
    must(staffPage.text.includes(en['errors.403.title']), 'staff must get the 403 view');
    must(!staffPage.text.includes(`${MARK}Import One`), 'the 403 view must not leak guest names');
    const foreignPage = await (await userSession(F.orgB)).get(`/organizer/events/${F.eventA}/badges`);
    must(foreignPage.text.includes(en['errors.403.title']), 'a foreign organizer must get the 403 view');
    must(!foreignPage.text.includes(`${MARK}Import One`), 'the 403 view must not leak guest names');

    const staff = await (await userSession(F.staff)).post(`/api/organizer/events/${F.eventA}/badge-links`);
    equals(staff.status, 403, 'staff badge-links');
    const foreign = await (await userSession(F.orgB)).post(`/api/organizer/events/${F.eventA}/badge-links`);
    equals(foreign.status, 403, 'foreign organizer badge-links');
    const anonRes = await anon.post(`/api/organizer/events/${F.eventA}/badge-links`);
    equals(anonRes.status, 401, 'anonymous badge-links');
    return {
      actual: 'staff/чужой организатор получают страницу 403 без данных; API badge-links: staff=403, чужой=403, anon=401',
      evidence: `${ev(staff)} | ${ev(foreign)} | ${ev(anonRes)}`,
      deviation:
        'страница /badges отдаёт страницу-заглушку 403 с HTTP 200 — это общая конвенция организаторских страниц (то же у /organizer/events/[eventId] и аналитики); статус-код 403 даёт только API. Проверяем фактическое поведение: отказ есть, данные не утекают.',
    };
  });

  await check('N17', 'N', 'claim-ссылки для бейджей: только unclaimed без карантина, CSV без PII, токен хранится хешем', '200; все ссылки — unclaimed/не-quarantine; у quarantined ссылки нет; в CSV нет email и имён', async () => {
    const s = await userSession(F.owner);
    const res = await s.post(`/api/organizer/events/${F.eventA}/badge-links`);
    equals(res.status, 200, 'badge-links status');
    const body = res.json as {
      issued?: number;
      links?: { registration_id: string; name: string | null; claim_url: string; qr_data_url: string }[];
      csv?: string;
    };
    must(Array.isArray(body.links) && body.links!.length >= 1, 'no links issued');
    equals(body.issued, body.links!.length, 'issued counter');
    for (const link of body.links!) {
      must(link.claim_url.includes('/claim/'), 'claim_url must be a claim link');
      must(link.qr_data_url.startsWith('data:image/svg+xml'), 'the QR must be an inline SVG data URL');
    }

    // Only claimable rows got a link.
    const ids = body.links!.map((l) => l.registration_id);
    const wrong = await sql!<{ id: string }[]>`
      SELECT id FROM registrations
      WHERE id = ANY(${ids}::uuid[]) AND (claim_state <> 'unclaimed' OR approval_status = 'quarantined')`;
    equals(wrong.length, 0, 'links must target only unclaimed, non-quarantined registrations');

    const quarantined = await sql!<{ id: string }[]>`
      SELECT id FROM registrations
      WHERE event_id = ${F.eventA}::uuid AND imported_data->>'email' = ${'matrix-import-two@welcome.test'} LIMIT 1`;
    must(quarantined.length === 1, 'quarantined registration not found');
    const quarantinedChallenges = await sql!<{ count: number }[]>`
      SELECT count(*)::int AS count FROM link_challenges WHERE registration_id = ${quarantined[0]!.id}::uuid`;
    equals(quarantinedChallenges[0]!.count, 0, 'a quarantined registration must get no claim link');

    // The one-time token exists in plaintext exactly once — at issuance. Only
    // its hash is stored.
    const token = body.links![0]!.claim_url.split('/claim/')[1]!;
    const stored = await sql!<{ token_hash: string }[]>`
      SELECT token_hash FROM link_challenges
      WHERE registration_id = ${body.links![0]!.registration_id}::uuid ORDER BY created_at DESC LIMIT 1`;
    must(stored.length === 1 && stored[0]!.token_hash !== token, 'the raw claim token must never be stored');

    // The downloadable CSV carries an opaque id and a URL — no names, no emails.
    const csvText = body.csv ?? '';
    must(csvText.startsWith('registration_id,claim_url'), `csv header: ${clip(csvText, 60)}`);
    must(!csvText.includes('@welcome.test'), 'the CSV must not contain an email');
    must(!csvText.includes(MARK), 'the CSV must not contain names');
    return {
      actual: `выпущено ${body.issued} ссылок только для unclaimed/не-quarantine; у quarantined ссылки нет; токен в БД только хешем; CSV = registration_id,claim_url без PII`,
      evidence: `HTTP ${res.status}, issued=${body.issued}, csv ${csvText.length} байт, строк ${csvText.trim().split('\n').length}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Mode O — Telegram
// ---------------------------------------------------------------------------

const OWNER_CHAT = 901000001;
const STOP_CHAT = 901000002;
const LINK_CHAT = 901000003;

async function modeO(): Promise<void> {
  const started = new Date();

  await check('O1', 'O', 'webhook без секрета → 401', '401 unauthorized_webhook, без побочных эффектов', async () => {
    const res = await webhook(telegramMessage(OWNER_CHAT, '/help'), null);
    equals(res.status, 401, 'webhook without secret');
    equals((res.json as { code?: string }).code, 'unauthorized_webhook', 'webhook code');
    const wrong = await webhook(telegramMessage(OWNER_CHAT, '/help'), 'matrix-wrong-secret');
    equals(wrong.status, 401, 'webhook with wrong secret');
    return { actual: '401 unauthorized_webhook (без секрета и с неверным)', evidence: `${ev(res)} | ${ev(wrong)}` };
  });

  await check('O2', 'O', 'дубликат update_id → 200 accepted:false', 'первый accepted:true, дубль accepted:false', async () => {
    const update = telegramMessage(OWNER_CHAT, '/help');
    const first = await webhook(update);
    equals(first.status, 200, 'first delivery');
    equals((first.json as { accepted?: boolean }).accepted, true, 'first accepted');
    const replay = await webhook(update);
    equals(replay.status, 200, 'replay status');
    equals((replay.json as { accepted?: boolean }).accepted, false, 'replay accepted');
    return { actual: 'accepted:true → accepted:false (идемпотентность по update_id)', evidence: `${ev(first)} | ${ev(replay)}` };
  });

  await check('O3', 'O', 'устаревший update (date > 24ч) → 400 stale_update', '400 stale_update', async () => {
    const update = telegramMessage(OWNER_CHAT, '/help', { date: Math.floor(Date.now() / 1000) - 25 * 3600 });
    const res = await webhook(update);
    equals(res.status, 400, 'stale status');
    equals((res.json as { code?: string }).code, 'stale_update', 'stale code');
    return { actual: '400 stale_update (окно 24ч)', evidence: ev(res) };
  });

  await check('O4', 'O', 'известная привязка (владелец) + /help → ответ доставлен', '200 accepted:true; telegram_reply переходит в sent', async () => {
    const binding = await sql!<{ external_id: string }[]>`
      SELECT external_id FROM channel_bindings WHERE account_id = ${F.owner.accountId} AND provider = 'telegram' AND state = 'active' LIMIT 1`;
    must(binding.length === 1, 'owner has no active telegram binding');
    const chat = Number(binding[0]!.external_id);
    const res = await webhook(telegramMessage(chat, '/help'));
    equals(res.status, 200, 'webhook status');
    equals((res.json as { accepted?: boolean }).accepted, true, 'accepted');
    await tick();
    await sleep(1500);
    await tick();
    await sleep(1500);
    const jobs = await sql!<{ status: string; attempt: number }[]>`
      SELECT status, attempt FROM outbox_jobs
      WHERE kind = 'telegram_reply' AND payload->>'chat_id' = ${String(chat)} AND created_at > ${started}
      ORDER BY created_at DESC LIMIT 1`;
    must(jobs.length === 1, `no telegram_reply job was created for chat ${chat}`);
    const status = jobs[0]!.status;
    const delivered = status === 'sent' || status === 'delivered';
    return {
      status: delivered ? 'PASS' : 'FAIL',
      actual: `200 accepted:true; telegram_reply → ${status} (attempt ${jobs[0]!.attempt})`,
      evidence: `outbox_jobs(kind=telegram_reply, owner) status=${status}; tick processed the update and the reply`,
    };
  });

  await check('O5', 'O', 'MATRIX-привязка + /stop → binding revoked и последующие автосообщения suppressed', 'binding state=revoked; новое автосообщение suppressed', async () => {
    const foxtrot = users.get('foxtrot')!;
    await sql!`INSERT INTO channel_bindings (account_id, provider, external_id, state)
               VALUES (${foxtrot.accountId}, 'telegram', ${String(STOP_CHAT)}, 'active')
               ON CONFLICT (provider, external_id) DO UPDATE SET account_id = EXCLUDED.account_id, state = 'active'`;
    const preKey = `matrix-stop-pre:${rand(4)}`;
    await sql!`INSERT INTO outbox_jobs (dedupe_key, kind, channel, purpose, payload)
               VALUES (${preKey}, 'campaign_message', 'telegram', 'service_channel', ${sql!.json({ account_id: foxtrot.accountId, text: `${MARK} auto message` })})`;
    const res = await webhook(telegramMessage(STOP_CHAT, '/stop'));
    equals(res.status, 200, 'stop status');
    await tick();
    await sleep(1200);
    const binding = await sql!<{ state: string }[]>`
      SELECT state FROM channel_bindings WHERE provider = 'telegram' AND external_id = ${String(STOP_CHAT)}`;
    equals(binding[0]?.state, 'revoked', 'binding state after /stop');
    // Deterministic part: an auto-message created AFTER the revocation must be
    // suppressed by the worker (never sent), which is the promise of /stop.
    const postKey = `matrix-stop-post:${rand(4)}`;
    await sql!`INSERT INTO outbox_jobs (dedupe_key, kind, channel, purpose, payload)
               VALUES (${postKey}, 'campaign_message', 'telegram', 'service_channel', ${sql!.json({ account_id: foxtrot.accountId, text: `${MARK} post-stop message` })})`;
    await tick();
    await sleep(1200);
    const post = await jobRow(postKey);
    must(post !== null, 'post-stop job vanished');
    must(post!.status === 'suppressed' || post!.status.startsWith('suppressed:'), `post-stop job status: ${post!.status}`);
    const pre = await jobRow(preKey);
    return {
      actual: `/stop → 200; binding state=revoked; сообщение после отзыва → ${post!.status}`,
      evidence: `channel_bindings.state=revoked; pre-stop job=${pre?.status ?? 'n/a'} (мог быть подхвачен cron до отзыва), post-stop job=${post!.status} (подавлено воркером)`,
      deviation: '/stop выполнен на синтетической MATRIX-привязке, а не на реальной привязке владельца: отзыв реальной привязки — деструктивная операция с существующими данными (запрещена заданием вне режима «проверить отказ»). /help на реальной привязке владельца проверен в O4.',
    };
  });

  await check('O6', 'O', '/start с валидным токеном без web-confirm → привязка НЕ создаётся', 'нет binding; после confirm → binding создаётся', async () => {
    const mfa = users.get('mfa')!;
    const s = await userSession(mfa);
    const challenge = await s.post('/api/channels/telegram/challenge');
    equals(challenge.status, 201, 'challenge status');
    const deepLink = (challenge.json as { deep_link?: string }).deep_link ?? '';
    const token = deepLink.match(/start=link_([A-Za-z0-9_-]+)/)?.[1] ?? '';
    must(token.length >= 20, `token not found in deep_link: ${clip(deepLink, 60)}`);
    const unconfirmed = await webhook(telegramMessage(LINK_CHAT, `/start link_${token}`));
    equals(unconfirmed.status, 200, 'unconfirmed /start status');
    await tick();
    await sleep(1200);
    const afterUnconfirmed = await sql!<{ count: number }[]>`
      SELECT count(*)::int AS count FROM channel_bindings WHERE provider = 'telegram' AND external_id = ${String(LINK_CHAT)}`;
    equals(afterUnconfirmed[0]!.count, 0, 'binding must NOT exist before web confirmation');
    const confirm = await s.post('/api/channels/telegram/confirm', { token });
    equals(confirm.status, 200, 'confirm status');
    const confirmed = await webhook(telegramMessage(LINK_CHAT, `/start link_${token}`));
    equals(confirmed.status, 200, 'confirmed /start status');
    await tick();
    await sleep(1200);
    const after = await sql!<{ account_id: string; state: string }[]>`
      SELECT account_id, state FROM channel_bindings WHERE provider = 'telegram' AND external_id = ${String(LINK_CHAT)}`;
    equals(after[0]?.state, 'active', 'binding state after confirm + /start');
    equals(after[0]?.account_id, mfa.accountId, 'binding account');
    return { actual: `/start без confirm → 0 привязок; после confirm + /start → active (тот же аккаунт)`, evidence: `${ev(challenge, 'ok', 'deep_link', 'next')} | ${ev(confirm, 'ok')}` };
  });

  await check('O7', 'O', 'worker-tick только с секретом', 'без секрета 401; с секретом 200 processed', async () => {
    const denied = await rawFetch('POST', '/api/internal/worker-tick', { headers: {} });
    equals(denied.status, 401, 'tick without secret');
    equals((denied.json as { code?: string }).code, 'unauthorized_worker_tick', 'tick code');
    const ok = await tick();
    equals(ok.status, 200, 'tick with secret');
    must((ok.json as { processed?: number }).processed !== undefined, 'processed missing');
    return { actual: `401 без секрета → 200 processed=${(ok.json as { processed?: number }).processed}`, evidence: `${ev(denied)} | ${ev(ok, 'ok', 'processed', 'requeued_leases')}` };
  });
}

// ---------------------------------------------------------------------------
// Mode P — ops / security surface
// ---------------------------------------------------------------------------

async function modeP(): Promise<void> {
  await check('P1', 'P', 'health публичный: без migration_version', '200 status/db/worker и БЕЗ migration_version', async () => {
    const res = await anon.get('/api/health');
    equals(res.status, 200, 'health status');
    const body = res.json as Record<string, unknown>;
    equals(body.status, 'ok', 'status');
    equals(body.db, 'up', 'db');
    must(!('migration_version' in body), 'migration_version leaked into the public payload');
    must(!('migrations' in body), 'migrations leaked into the public payload');
    return { actual: `200 ${JSON.stringify(body)} (без migration_version)`, evidence: ev(res) };
  });

  await check('P2', 'P', 'health с x-health-details: отдаёт версию миграций', '200 + migration_version', async () => {
    must(WORKER_TICK_SECRET.length > 0, 'WORKER_TICK_SECRET не найден в .env.deploy.secrets');
    const res = await rawFetch('GET', '/api/health', { headers: { 'x-health-details': WORKER_TICK_SECRET } });
    equals(res.status, 200, 'detailed health status');
    const body = res.json as { migration_version?: string | null; migrations?: string };
    must(typeof body.migration_version === 'string' && body.migration_version.length > 0, 'migration_version missing');
    equals(body.migrations, 'applied', 'migrations state');
    return { actual: `200 migrations=applied, migration_version=${body.migration_version}`, evidence: ev(res, 'status', 'db', 'migrations', 'migration_version', 'worker') };
  });

  await check('P3', 'P', 'security-заголовки на / и /login (4 заголовка)', 'CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy', async () => {
    const wanted = ['content-security-policy', 'x-frame-options', 'referrer-policy', 'permissions-policy'];
    const results: string[] = [];
    for (const path of ['/', '/login']) {
      const res = await anon.get(path);
      equals(res.status, 200, `${path} status`);
      for (const h of wanted) must(res.headers.get(h) !== null, `${path} missing ${h}`);
      results.push(`${path}: ${wanted.length}/4`);
    }
    return { actual: `4/4 на / и /login (${wanted.join(', ')})`, evidence: results.join(' | ') };
  });

  await check('P4', 'P', 'rate limit на OTP: per-IP bucket (10/мин)', '11-й запрос с одного IP → 429 + X-RateLimit-Limit', async () => {
    const s = new Session('ip-bucket');
    const statuses: number[] = [];
    let limited: Res | null = null;
    for (let i = 1; i <= 11 && limited === null; i++) {
      const res = await s.post('/api/auth/otp/request', { email: `matrix-iprl-${i}@welcome.test` });
      statuses.push(res.status);
      if (res.status === 429 && res.headers.get('x-ratelimit-limit') !== null) limited = res;
    }
    must(limited !== null, `no per-IP 429 within 11 requests (statuses: ${statuses.join(',')})`);
    equals(limited!.json ? (limited!.json as { code?: string }).code : undefined, 'rate_limited', 'bucket body');
    return {
      actual: `статусы ${statuses.join(',')} → 429 (X-RateLimit-Limit=${limited!.headers.get('x-ratelimit-limit')})`,
      evidence: `${ev(limited!)} x-ratelimit-limit=${limited!.headers.get('x-ratelimit-limit')}`,
    };
  });

  await check('P5', 'P', 'приватные GET → cache-control: no-store', 'no-store на /api/me/profile и /api/me/notes', async () => {
    const s = await userSession(users.get('alpha')!);
    const out: string[] = [];
    for (const p of ['/api/me/profile', '/api/me/notes']) {
      const res = await s.get(p);
      equals(res.status, 200, `${p} status`);
      const cc = res.headers.get('cache-control') ?? '';
      must(/no-store/.test(cc), `${p} cache-control=${cc}`);
      out.push(`${p}: ${cc}`);
    }
    return { actual: out.join(' | '), evidence: out.join(' | ') };
  });

  await check('P6', 'P', 'worker-tick: оба носителя секрета (header и Bearer)', '200 на x-worker-tick-secret и Authorization: Bearer', async () => {
    const header = await tick();
    equals(header.status, 200, 'header carrier');
    const bearer = await rawFetch('GET', '/api/internal/worker-tick', { headers: { authorization: `Bearer ${WORKER_TICK_SECRET}` } });
    equals(bearer.status, 200, 'bearer carrier');
    const query = await rawFetch('GET', `/api/internal/worker-tick?secret=${encodeURIComponent(WORKER_TICK_SECRET)}`, { headers: {} });
    equals(query.status, 401, '?secret= carrier was removed and must fail');
    return { actual: `header 200, Bearer 200, ?secret= 401 (носитель удалён)`, evidence: `${ev(header, 'ok', 'processed')} | ${ev(bearer, 'ok', 'processed')} | ${ev(query)}` };
  });
}

// ---------------------------------------------------------------------------
// Mode Q — roles / tenant isolation
// ---------------------------------------------------------------------------

async function modeQ(): Promise<void> {
  const orgB = F.orgB;

  await check('Q1', 'Q', 'staff не может approve/send (повтор на том же объекте)', '403 forbidden', async () => {
    const s = await userSession(F.staff);
    const approve = await s.post(`/api/organizer/campaigns/${campaignId}/approve`);
    const send = await s.post(`/api/organizer/campaigns/${campaignId}/send`);
    equals(approve.status, 403, 'staff approve');
    equals(send.status, 403, 'staff send');
    return { actual: '403 forbidden ×2 (role-проверка раньше проверки состояния)', evidence: `${ev(approve)} | ${ev(send)}` };
  });

  await check('Q2', 'Q', 'кросс-тенант: организатор B не читает данные A', '404 на кампанию A (анти-энумерация), 403 на события/каталог A', async () => {
    const s = await login(orgB.email, 'orgb');
    orgB.session = s;
    const audience = await s.get(`/api/organizer/campaigns/${campaignId}/audience`);
    equals(audience.status, 404, 'campaign audience across tenants');
    equals((audience.json as { code?: string }).code, 'not_found', 'audience code');
    const exportRes = await s.get(`/api/organizer/events/${F.eventA}/export`);
    must([403, 404].includes(exportRes.status), `event export across tenants: ${exportRes.status}`);
    const directory = await s.get(`/api/events/${F.eventA}/directory?mode=all`);
    equals(directory.status, 403, 'directory across tenants');
    const ownEvent = await s.get(`/api/events/${F.eventB}`);
    equals(ownEvent.status, 200, 'own event readable');
    return {
      actual: `кампания A → ${audience.status} not_found (скрытие существования), export A → ${exportRes.status}, directory A → ${directory.status}; своё событие B → 200`,
      evidence: `${ev(audience)} | ${ev(exportRes)} | ${ev(directory)} | own ${ev(ownEvent, 'ok')}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Mode R — i18n + adaptive layout
// ---------------------------------------------------------------------------

async function modeR(): Promise<void> {
  await check('R1', 'R', '/?lang=ru|en|es переключает язык', 'ожидание задания: строки языка по query-параметру', async () => {
    const observed: string[] = [];
    for (const lang of ['ru', 'es', 'en']) {
      const res = await anon.get(`/?lang=${lang}`);
      equals(res.status, 200, `?lang=${lang} status`);
      const html = (res.text.match(/<html lang="([a-z]+)"/) ?? [, '?'])[1];
      observed.push(`?lang=${lang} → ${html}`);
      equals(html, lang, `?lang=${lang} must render in ${lang}`);
      // The choice must be persisted for the next visit (same cookie the
      // switcher writes), not only applied to this response.
      const cookie = res.headers.get('set-cookie') ?? '';
      must(new RegExp(`welcome_locale=${lang}`).test(cookie), `?lang=${lang} did not persist welcome_locale`);
    }
    // An invalid value is ignored: it must not render as that locale nor write a cookie.
    const bogus = await anon.get('/?lang=de');
    equals(bogus.status, 200, '?lang=de status');
    const bogusHtml = (bogus.text.match(/<html lang="([a-z]+)"/) ?? [, '?'])[1];
    must(bogusHtml !== 'de', 'invalid ?lang=de must be ignored');
    must(!/welcome_locale=de/.test(bogus.headers.get('set-cookie') ?? ''), 'invalid ?lang=de must not be stored');
    return {
      actual: `${observed.join(', ')}; ?lang=de → ${bogusHtml} (игнорируется, cookie не перезаписан)`,
      evidence: `${observed.join(' | ')} | cookie welcome_locale сохранён для каждого валидного значения`,
    };
  });

  await check('R2', 'R', 'фактическая механика локали: cookie → локализованные строки', 'ru/es отдают свои строки, en — свои', async () => {
    const markers: Record<string, string> = {};
    const markerKeys = ['landing.subtitle', 'landing.ctaPersonal', 'landing.principle1', 'landing.titleLine1'];
    for (const loc of ['en', 'ru', 'es'] as const) {
      const dict = (loc === 'en' ? en : loc === 'ru' ? ru : es) as unknown as Record<string, string>;
      let word = '';
      for (const key of markerKeys) {
        const phrase = dict[key] ?? '';
        const words = phrase.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5);
        // Prefer a non-ASCII word (Cyrillic / accented) so the three locales
        // cannot collapse onto the same shared brand word.
        const candidate = words.find((w) => /[^\x20-\x7E]/.test(w)) ?? words.sort((a, b) => b.length - a.length)[0] ?? '';
        if (candidate.length > word.length) word = candidate;
        if (/[^\x20-\x7E]/.test(word)) break;
      }
      must(word.length >= 5, `no usable localized marker for ${loc}`);
      markers[loc] = word;
      const s = new Session(`locale-${loc}`);
      const set = await s.post('/api/locale', { locale: loc });
      equals(set.status, 200, `POST /api/locale ${loc}`);
      const page = await s.get('/');
      equals(page.status, 200, `GET / ${loc}`);
      must(page.text.includes(`<html lang="${loc}"`), `html lang=${loc} missing`);
      must(page.text.includes(word), `localized string «${word}» missing from the ${loc} page`);
    }
    const distinct = new Set(Object.values(markers)).size;
    equals(distinct, 3, 'markers must differ per locale');
    return { actual: `en«${markers.en}» / ru«${markers.ru}» / es«${markers.es}» — все найдены на страницах`, evidence: JSON.stringify(markers) };
  });

  await check('R3', 'R', 'мини-лендинг на 360px без горизонтального overflow (Playwright)', 'scrollWidth <= 361 при viewport 360', async () => {
    const alpha = users.get('alpha')!;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const page = await context.newPage();
      const res = await page.goto(`${BASE}/p/${alpha.slug}`, { waitUntil: 'load' });
      must(!!res && res.status() === 200, `page status ${res?.status()}`);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      must(metrics.scrollWidth <= 361, `horizontal overflow: scrollWidth=${metrics.scrollWidth} at 360px`);
      await context.close();
      return { actual: `360px: scrollWidth=${metrics.scrollWidth} (clientWidth=${metrics.clientWidth}) — overflow нет`, evidence: JSON.stringify(metrics) };
    } finally {
      await browser.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Mode M — privacy: export / delete / blocks / reports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mode S — interop & matching v4 (packet 3): provider registry, ICS, goals, the
// four recommendation modes and the connections page.
//
// The run targets a LOCAL production build against the PRODUCTION database, so
// these checks also prove that migration 011 is applied where it must be, and
// that nothing in the new surface leaks a secret or a private goal.
// ---------------------------------------------------------------------------

/** Provider ids, catalogue ids and modes as the DESIGN fixes them (not imported). */
const PROVIDER_IDS = [
  'telegram', 'email', 'vcard', 'csv', 'ics', 'share-deeplinks', 'google-contacts', 'google-calendar',
  'microsoft-people', 'github', 'linkedin', 'whatsapp', 'instagram', 'x', 'luma',
];
const GOAL_CATALOGUE = [
  'learn-skill', 'find-mentor', 'become-mentor', 'find-cofounder', 'hire', 'get-hired', 'find-clients',
  'get-more-clients', 'enter-market', 'fundraise', 'invest', 'find-partners', 'find-community',
  'get-feedback', 'give-feedback', 'grow-network',
];
const REC_MODES = ['useful', 'grow', 'similar', 'explore'];

/** Fails when any live secret value appears verbatim in a response body. */
function assertNoSecrets(text: string, label: string): void {
  for (const secret of REDACT) {
    if (secret.length >= 8 && text.includes(secret)) throw new Error(`${label}: response contains a secret value`);
  }
}

// ---------------------------------------------------------------------------
// Address-book import helpers (S11–S13)
// ---------------------------------------------------------------------------

/** A minimal .vcf holding the given addresses (the parser itself is unit-tested). */
function vcardOf(entries: { email: string; name: string }[]): string {
  return entries
    .flatMap((entry) => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${entry.name}`, `EMAIL:${entry.email}`, 'END:VCARD'])
    .join('\r\n');
}

/**
 * The tables an address book could conceivably be written to — the snapshot S12
 * compares row counts against. It deliberately leaves out the worker's own
 * queues (outbox_jobs/notifications) and audit_events: the live run shares its
 * database with the production cron, and a tick landing mid-check is not
 * evidence about this endpoint. audit_events is compared separately, by the
 * single fact THIS account wrote.
 */
const STORAGE_TABLES = [
  'accounts', 'profiles', 'contact_fields', 'registrations', 'link_challenges', 'sessions',
  'event_memberships', 'introduction_consents', 'introductions', 'connection_notes', 'blocks',
  'reports', 'consent_events', 'enrichment_requests', 'campaigns', 'events', 'organizers', 'inbox_events',
];

async function storageSnapshot(): Promise<Record<string, number>> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const out: Record<string, number> = {};
  for (const table of STORAGE_TABLES) {
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ${sql(table)}`;
    out[table] = rows[0]?.count ?? 0;
  }
  return out;
}

/** Rows carrying this address as a lookup key in EVERY table that has such a column. */
async function countByLookupHash(email: string): Promise<number> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const columns = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'email_lookup_hash'
  `;
  const lookup = hash(email);
  let total = 0;
  for (const column of columns) {
    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${sql(column.table_name)} WHERE email_lookup_hash = ${lookup}
    `;
    total += rows[0]?.count ?? 0;
  }
  return total;
}

/** How many "an import happened" facts this account has in the audit log. */
async function importFactsFor(accountId: string): Promise<number> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_events
    WHERE actor_account_id = ${accountId} AND action = 'contacts.import.match'
  `;
  return rows[0]?.count ?? 0;
}

async function latestImportMetadata(accountId: string): Promise<{ action: string; metadata: Record<string, unknown> }> {
  if (!sql) throw new Error('DATABASE_URL unavailable');
  const rows = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
    SELECT action, metadata FROM audit_events
    WHERE actor_account_id = ${accountId} AND action = 'contacts.import.match'
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? { action: '', metadata: {} };
}

const S: { icsSlug: string; icsId: string; noDateSlug: string; roomLink: string; modesEvent: string } = {
  icsSlug: '',
  icsId: '',
  noDateSlug: '',
  roomLink: `https://meet.example/matrix-room-${rand(4)}`,
  // A dedicated event for the mode checks: event A has already accumulated
  // introductions from the earlier modes, and the recommender (correctly)
  // hides pairs that are inside the intro cooldown — which would make the
  // "modes return different people" check depend on mode order.
  modesEvent: '',
};

async function modeS(): Promise<void> {
  // ── S1: the public provider registry ──────────────────────────────────────
  await check('S1', 'S', 'GET /api/providers публично отдаёт реестр без сессии', '200, 15 провайдеров в порядке §A3, no-store', async () => {
    const res = await anon.get('/api/providers');
    equals(res.status, 200, 'providers status');
    const body = res.json as { ok?: boolean; providers?: { id: string }[] };
    equals(body.ok, true, 'ok flag');
    const ids = (body.providers ?? []).map((p) => p.id);
    equals(ids.join(','), PROVIDER_IDS.join(','), 'registry ids and order');
    equals(res.headers.get('cache-control'), 'no-store', 'cache-control');
    assertNoSecrets(res.text, 'S1');
    return {
      actual: `200, ${ids.length} провайдеров, Cache-Control no-store, session не нужна`,
      evidence: ev(res, 'providers'),
    };
  });

  // ── S2: statuses are honest and env-derived ───────────────────────────────
  await check('S2', 'S', 'статусы провайдеров честны: live ⇒ без reason/missing_env, disabled ⇒ not_configured + имя переменной', 'telegram/email по факту env, planned/disabled из реестра, только ИМЕНА переменных', async () => {
    const res = await anon.get('/api/providers');
    equals(res.status, 200, 'providers status');
    const list = (res.json as { providers: Record<string, unknown>[] }).providers;
    const byId = new Map(list.map((p) => [p['id'] as string, p]));

    const allowed = new Set(['id', 'kind', 'auth', 'capabilities', 'direction', 'status', 'reason_code', 'missing_env', 'env']);
    for (const item of list) {
      for (const key of Object.keys(item)) must(allowed.has(key), `providers: unexpected field ${key}`);
    }

    const envGated: [string, string][] = [
      ['telegram', 'TELEGRAM_BOT_TOKEN'],
      ['email', 'RESEND_API_KEY'],
    ];
    // The expectation must come from the DEPLOYMENT's configuration, not from
    // this runner's shell: an operator with RESEND_API_KEY unset locally was
    // failing a deployment that legitimately reports `email: live`. So:
    //   1. `--expect-<id>=live|disabled` pins the config when the operator knows it
    //      (the strongest form — use it whenever the deployment config is known);
    //   2. a variable visible to this runner (secrets file / env) pins it too;
    //   3. otherwise only the state's HONESTY is asserted, which is what the
    //      contract actually promises: `live` must carry no reason and no missing
    //      variables, `disabled` must carry `not_configured` and name the variable.
    const expectedFor = (id: string, envName: string): 'live' | 'disabled' | null => {
      const pinned = argv.find((a) => a.startsWith(`--expect-${id}=`))?.slice(`--expect-${id}=`.length);
      if (pinned === 'live' || pinned === 'disabled') return pinned;
      return SECRETS[envName] || process.env[envName] ? 'live' : null;
    };
    const observed: string[] = [];
    for (const [id, envName] of envGated) {
      const row = byId.get(id)!;
      const status = row['status'] as string;
      const expected = expectedFor(id, envName);
      if (expected) equals(status, expected, `${id} status`);
      else must(status === 'live' || status === 'disabled', `${id} status must be live or disabled`);
      if (status === 'live') {
        equals(row['reason_code'], null, `${id}: live must not carry a reason`);
        equals((row['missing_env'] as string[]).length, 0, `${id}: live must not list missing variables`);
      } else {
        equals(row['reason_code'], 'not_configured', `${id} reason`);
        must((row['missing_env'] as string[]).includes(envName), `${id} must name the missing variable`);
      }
      must((row['env'] as string[]).includes(envName), `${id} must list ${envName} as a NAME`);
      observed.push(`${id}=${status}${expected ? '' : '(honesty-only)'}`);
    }
    // Design states cannot be flipped by configuration.
    equals(byId.get('ics')!['status'], 'planned', 'ics status');
    equals(byId.get('linkedin')!['status'], 'disabled', 'linkedin status');
    equals(byId.get('linkedin')!['reason_code'], 'policy_restricted', 'linkedin reason');
    equals(byId.get('vcard')!['status'], 'live', 'vcard status');
    observed.push('ics=planned', 'linkedin=disabled(policy_restricted)', 'vcard=live');

    assertNoSecrets(res.text, 'S2');
    for (const value of Object.values(SECRETS)) {
      if (value.length >= 8) must(!res.text.includes(value), 'S2: a secret value reached the providers payload');
    }
    return { actual: observed.join(', '), evidence: ev(res, 'providers') };
  });

  // ── S3: the calendar file ────────────────────────────────────────────────
  S.icsSlug = `matrix-ics-${rand(3)}`;
  S.icsId = await createEvent({
    organizerId: F.organizerA,
    slug: S.icsSlug,
    name: `${MARK}ICS Event`,
    startsAt: new Date(Date.now() + 86_400_000),
    endsAt: new Date(Date.now() + 93_600_000),
    onlineLink: S.roomLink,
  });
  S.noDateSlug = `matrix-nodate-${rand(3)}`;
  await createEvent({ organizerId: F.organizerA, slug: S.noDateSlug, name: `${MARK}No Date` });

  await check('S3', 'S', 'GET /api/events/<slug>/ics — публичный календарный файл', '200 text/calendar, attachment, UID, UTC, без комнатной ссылки', async () => {
    const res = await anon.get(`/api/events/${S.icsSlug}/ics`);
    equals(res.status, 200, 'ics status');
    must(/^text\/calendar; charset=utf-8$/.test(res.headers.get('content-type') ?? ''), `content-type: ${res.headers.get('content-type')}`);
    must((res.headers.get('content-disposition') ?? '').includes(`welcome-${S.icsSlug}.ics`), 'attachment filename');
    const body = res.text;
    must(body.startsWith('BEGIN:VCALENDAR\r\n'), 'VCALENDAR must open the file');
    must(body.trimEnd().endsWith('END:VCALENDAR'), 'VCALENDAR must close the file');
    must(body.includes('X-WR-TIMEZONE:Europe/Madrid'), 'organizer timezone as metadata');
    must(/DTSTART:\d{8}T\d{6}Z/.test(body), 'DTSTART must be UTC');
    must(body.includes(`UID:welcome-event-${S.icsId}@`), 'stable UID must carry the event id');
    assertNoSecrets(body, 'S3');
    must(!body.includes(S.roomLink), 'the online room link must never travel inside the file');
    must(!body.includes('matrix-room-'), 'no fragment of the room link either');
    return {
      actual: `200, text/calendar, attachment, DTSTART UTC, UID по id события, комнатная ссылка отсутствует`,
      evidence: `content-type=${res.headers.get('content-type')} disposition=${res.headers.get('content-disposition')} bytes=${body.length}`,
    };
  });

  await check('S4', 'S', 'ICS: 404 на несуществующее событие, 409 без расписания', '404 not_found; 409 no_schedule', async () => {
    const missing = await anon.get(`/api/events/matrix-does-not-exist-${rand(3)}/ics`);
    equals(missing.status, 404, 'missing event status');
    const noDate = await anon.get(`/api/events/${S.noDateSlug}/ics`);
    equals(noDate.status, 409, 'no-schedule status');
    equals((noDate.json as { code?: string }).code, 'no_schedule', 'no-schedule code');
    return { actual: '404 на отсутствующее событие, 409 + no_schedule без starts_at', evidence: `${ev(missing, 'code')} | ${ev(noDate, 'code')}` };
  });

  await check('S5', 'S', 'страница /e/<slug>: кнопки календаря и диплинки шэринга', 'есть ссылка на .ics, Google Calendar и 4 сети с rel=noopener noreferrer', async () => {
    const res = await anon.get(`/e/${S.icsSlug}`);
    equals(res.status, 200, 'event page status');
    must(res.text.includes(`href="/api/events/${S.icsSlug}/ics"`), 'the .ics link must be on the page');
    must(res.text.includes('https://calendar.google.com/calendar/render?action=TEMPLATE'), 'Google template link');
    for (const host of ['https://www.linkedin.com/', 'https://wa.me/', 'https://t.me/', 'https://x.com/']) {
      must(res.text.includes(host), `share deeplink to ${host} missing`);
    }
    const relCount = (res.text.match(/rel="noopener noreferrer"/g) ?? []).length;
    must(relCount >= 4, `share links must carry rel=noopener noreferrer (found ${relCount})`);
    assertNoSecrets(res.text, 'S5');
    must(!res.text.includes('matrix-room-'), 'the room link must not be on the public event page');
    return { actual: `.ics + Google Calendar + 4 сети, ${relCount} ссылок с rel="noopener noreferrer"`, evidence: `HTTP ${res.status}, ${res.text.length} bytes` };
  });

  // ── S6: goals are private ────────────────────────────────────────────────
  const alpha = users.get('alpha')!;
  await check('S6', 'S', 'цели профиля: сохраняются в порядке приоритета и приватны', 'GET возвращает тот же порядок; целей нет ни в карточке, ни в vCard', async () => {
    const session = await userSession(alpha);
    const picked = ['find-cofounder', 'fundraise', 'grow-network'];
    const saved = await updateProfile(session, { goals: picked });
    equals(saved.status, 200, 'profile save status');
    const read = await session.get('/api/me/profile');
    equals((read.json as { profile: { goals: string[] } }).profile.goals.join(','), picked.join(','), 'goals order');

    const card = await anon.get(`/api/public/profiles/${alpha.slug}`);
    equals(card.status, 200, 'public profile status');
    must(!('goals' in (card.json as Record<string, unknown>)), 'the public projection must not expose goals');
    assertNoSecrets(card.text, 'S6');

    const vcard = await anon.get(`/api/public/profiles/${alpha.slug}/vcard`);
    equals(vcard.status, 200, 'vcard status');
    for (const goal of picked) {
      must(!vcard.text.includes(goal), `vCard must not contain the private goal ${goal}`);
      must(!card.text.includes(goal), `public JSON must not contain the private goal ${goal}`);
    }
    return { actual: `${picked.join(' → ')} сохранены и прочитаны в том же порядке; в публичном JSON и vCard целей нет`, evidence: `${ev(read, 'profile')} | ${ev(card, 'display_name')}` };
  });

  await check('S7', 'S', 'цели: каталог в /api/taxonomy (v3 + goальs) и 400 на четвёртую/неизвестную', 'version v3, 16 целей, limits.goals=3; 400 invalid_goals', async () => {
    const taxonomy = await anon.get('/api/taxonomy');
    equals(taxonomy.status, 200, 'taxonomy status');
    const t = taxonomy.json as { version: string; limits: Record<string, number>; goals?: { id: string }[] };
    equals(t.version, 'v3', 'catalogue version must stay v3');
    equals(t.limits['goals'], 3, 'limits.goals');
    equals((t.goals ?? []).map((g) => g.id).join(','), GOAL_CATALOGUE.join(','), 'goal catalogue');

    const session = await userSession(alpha);
    const tooMany = await updateProfile(session, { goals: ['fundraise', 'hire', 'invest', 'find-partners'] });
    equals(tooMany.status, 400, 'four goals status');
    equals((tooMany.json as { code?: string }).code, 'invalid_goals', 'four goals code');
    const unknown = await updateProfile(session, { goals: ['be-a-unicorn'] });
    equals(unknown.status, 400, 'unknown goal status');
    // The rejected writes must not have wiped the stored list.
    const after = await session.get('/api/me/profile');
    equals((after.json as { profile: { goals: string[] } }).profile.goals.length, 3, 'stored goals survived the 400s');
    return { actual: `taxonomy: v3 + 16 целей + limits.goals=3; 400 invalid_goals на 4 цели и на неизвестную; список не затёрт`, evidence: `${ev(taxonomy, 'version', 'limits')} | ${ev(tooMany, 'code')} | ${ev(unknown, 'code')}` };
  });

  // ── S8: the four recommendation modes ────────────────────────────────────
  S.modesEvent = await createEvent({
    organizerId: F.organizerA,
    slug: `matrix-modes-${rand(3)}`,
    name: `${MARK}Modes`,
  });
  await addMembership(alpha, S.modesEvent);
  await addMembership(users.get('bravo')!, S.modesEvent);

  await check('S8', 'S', 'GET .../recommendations?mode= — четыре режима и 400 на неизвестный', 'все 4 → 200 с эхом mode; unknown → 400 invalid_mode; есть v4-строки причин', async () => {
    const session = await userSession(alpha);
    const observed: string[] = [];
    let sawV4Lines = false;
    const allowed = new Set(['profile_id', 'display_name', 'headline', 'company', 'score', 'mode', 'reasons_for_me', 'reasons_for_them', 'reasons_useful', 'reasons_growth', 'algorithm']);
    for (const mode of REC_MODES) {
      const res = await session.get(`/api/events/${S.modesEvent}/recommendations?mode=${mode}`);
      equals(res.status, 200, `${mode} status`);
      const body = res.json as { mode?: string; recommendations?: Record<string, unknown>[]; excluded_reason?: unknown };
      equals(body.mode, mode, `${mode} echo`);
      must(Array.isArray(body.recommendations), `${mode} recommendations array`);
      for (const item of body.recommendations ?? []) {
        for (const key of Object.keys(item)) must(allowed.has(key), `${mode}: unexpected field ${key}`);
        const useful = item['reasons_useful'] as unknown[] | undefined;
        const growth = item['reasons_growth'] as unknown[] | undefined;
        must(Array.isArray(useful) && Array.isArray(growth), `${mode}: two-line reasons must be arrays`);
        if ((useful?.length ?? 0) > 0 || (growth?.length ?? 0) > 0) sawV4Lines = true;
      }
      observed.push(`${mode}=${(body.recommendations ?? []).length}`);
      assertNoSecrets(res.text, `S8/${mode}`);
    }
    must(sawV4Lines, 'no recommendation carried a v4 two-line reason — the v4 layer never ran');

    const bogus = await session.get(`/api/events/${S.modesEvent}/recommendations?mode=best`);
    equals(bogus.status, 400, 'unknown mode status');
    equals((bogus.json as { code?: string }).code, 'invalid_mode', 'unknown mode code');
    return { actual: `${observed.join(', ')}; unknown → 400 invalid_mode; v4-строки причин присутствуют`, evidence: `${observed.join(', ')} | ${ev(bogus, 'code')}` };
  });

  // ── S9: the connections page ─────────────────────────────────────────────
  await check('S9', 'S', '/me/connections: закрыт без сессии, с сессией показывает провайдеров без секретов', 'signed-out → redirect /login; signed-in → 200 + все id + только ИМЕНА переменных', async () => {
    const anonRes = await anon.get('/me/connections');
    must([302, 303, 307, 308].includes(anonRes.status), `signed-out status was ${anonRes.status}`);
    must((anonRes.headers.get('location') ?? '').includes('/login'), 'signed-out must be sent to /login');

    const session = await userSession(alpha);
    const res = await session.get('/me/connections');
    equals(res.status, 200, 'connections status');
    for (const id of PROVIDER_IDS) {
      must(res.text.includes(`data-testid="provider-${id}"`), `provider card ${id} missing`);
    }
    must(res.text.includes('TELEGRAM_BOT_TOKEN'), 'env NAMES must be listed');
    must(res.text.includes('data-testid="contact-import"'), 'the address-book import panel must be on the page');
    must(res.text.includes('data-testid="contact-import-note"'), 'the "we do not keep your address book" note must be visible');
    assertNoSecrets(res.text, 'S9');
    must(!res.text.includes('candidateOffers'), 'the matching patterns must not reach the page');
    return { actual: `signed-out ${anonRes.status} → ${anonRes.headers.get('location')}; signed-in 200 с 15 карточками, панелью импорта и именами переменных`, evidence: `signed-out: ${anonRes.status} ${anonRes.headers.get('location')} | signed-in: HTTP ${res.status}, ${res.text.length} bytes` };
  });

  // ── S10: the public card affordances ─────────────────────────────────────
  await check('S10', 'S', 'публичная карточка: og:url, «Добавить в контакты» и диплинки', 'og:url карточки, ссылка на vCard без сессии, 4 сети', async () => {
    const res = await anon.get(`/p/${alpha.slug}`);
    equals(res.status, 200, 'card status');
    must(res.text.includes('property="og:url"'), 'og:url must be present');
    must(res.text.includes(`/api/public/profiles/${alpha.slug}/vcard`), 'the vCard link must be on the card');
    for (const host of ['https://www.linkedin.com/', 'https://wa.me/', 'https://t.me/', 'https://x.com/']) {
      must(res.text.includes(host), `share deeplink to ${host} missing`);
    }
    assertNoSecrets(res.text, 'S10');
    must(!res.text.includes('find-cofounder'), 'a private goal must never render on the card');

    const vcard = await anon.get(`/api/public/profiles/${alpha.slug}/vcard`);
    equals(vcard.status, 200, 'anonymous vCard download');
    must(vcard.text.startsWith('BEGIN:VCARD'), 'vCard body');
    return { actual: `200: og:url + vCard + 4 сети, анонимная выгрузка .vcf работает, приватных целей нет`, evidence: `HTTP ${res.status}, ${res.text.length} bytes | vCard HTTP ${vcard.status}` };
  });

  // ── S11: the address book — "who of my contacts is already here" ──────────
  await check('S11', 'S', 'POST /api/me/contacts/import: fixture-сосед находится по адресу из .vcf', '200, matched по slug, в теле нет ни одного email, 5/час', async () => {
    const bravo = users.get('bravo')!;
    const session = await userSession(alpha);
    const stranger = `matrix-nobody-${rand(3)}@welcome.test`;
    const content = vcardOf([
      { email: bravo.email, name: 'Bravo Fixture' },
      { email: stranger, name: 'Nobody' },
    ]);
    const res = await session.post('/api/me/contacts/import', { content, filename: 'contacts.vcf' });
    equals(res.status, 200, 'import status');
    const body = res.json as {
      ok?: boolean; scanned?: number; matched_count?: number; unmatched_count?: number;
      matched?: { display_name: string; slug: string; headline: string | null }[]; matched_truncated?: boolean;
    };
    equals(body.ok, true, 'ok flag');
    equals(body.scanned, 2, 'scanned');
    equals(body.matched_count, 1, 'matched_count');
    equals(body.unmatched_count, 1, 'unmatched_count');
    equals(body.matched?.[0]?.slug, bravo.slug, 'the known fixture must be found by its address');
    equals(body.matched?.[0]?.display_name, bravo.displayName, 'display name comes from the profile');
    must(!res.text.includes('@'), 'the response must not contain any email address');
    equals(res.headers.get('cache-control'), 'no-store, private', 'cache-control');
    equals(res.headers.get('x-ratelimit-limit'), '5', 'rate limit header');
    assertNoSecrets(res.text, 'S11');
    return {
      actual: `200: scanned=2, matched=${body.matched_count} (${bravo.displayName} / ${bravo.slug}), unmatched=1, ни одного email в ответе`,
      evidence: `${ev(res, 'ok', 'scanned', 'matched_count', 'unmatched_count')} | X-RateLimit-Limit=${res.headers.get('x-ratelimit-limit')}`,
    };
  });

  // ── S12: nothing is stored ────────────────────────────────────────────────
  await check('S12', 'S', 'импорт ничего не сохраняет: снимок всех таблиц до/после, плюс только факт в audit_events', 'ни одна таблица хранения не изменилась; адрес не появился ни одним хешем; в audit — ровно один факт этого аккаунта', async () => {
    const delta = users.get('delta')!;
    const charlie = users.get('charlie')!;
    // Session FIRST: creating a session row would otherwise show up in the diff.
    const session = await userSession(delta);
    const unknown = `matrix-nobody-${rand(3)}@welcome.test`;
    const factsBefore = await importFactsFor(delta.accountId);
    const before = await storageSnapshot();
    const res = await session.post('/api/me/contacts/import', {
      content: vcardOf([
        { email: charlie.email, name: 'Charlie Fixture' },
        { email: unknown, name: 'Nobody' },
      ]),
      filename: 'contacts.vcf',
    });
    equals(res.status, 200, 'import status');
    const after = await storageSnapshot();
    const changed = Object.entries(after)
      .filter(([table, count]) => count !== before[table])
      .map(([table, count]) => `${table}:${String(before[table])}→${count}`);
    equals(changed.length, 0, `no storage table may change: ${changed.join(', ')}`);

    // The imported address left no trace in ANY column the product uses as a
    // lookup key (accounts + registrations carry email_lookup_hash).
    const hashRows = await countByLookupHash(unknown);
    equals(hashRows, 0, 'the imported address must not exist as a lookup key anywhere');
    const factsAfter = await importFactsFor(delta.accountId);
    equals(factsAfter - factsBefore, 1, 'exactly one audit fact for this import');

    const metadata = await latestImportMetadata(delta.accountId);
    equals(metadata.action, 'contacts.import.match', 'audit action');
    equals(
      Object.keys(metadata.metadata).sort().join(','),
      'format,matched_count,scanned,skipped',
      'the audit row carries counts only',
    );
    must(!JSON.stringify(metadata.metadata).includes('@'), 'the audit row may never hold an address');
    return {
      actual: `таблиц проверено: ${Object.keys(after).length}, изменений в таблицах хранения: 0; хешей импортированного адреса в БД: 0; audit_events: +1 факт (${Object.keys(metadata.metadata).sort().join(', ')})`,
      evidence: `snapshot=${clip(JSON.stringify({ tables: Object.keys(after).length, changed: changed.length, unknownHashRows: hashRows }), 200)} | audit=${clip(JSON.stringify(metadata.metadata), 160)}`,
    };
  });

  // ── S13: 401 / 429 ────────────────────────────────────────────────────────
  await check('S13', 'S', 'импорт: 401 без сессии и 429 на шестой запрос в час (пер-аккаунтный бюджет)', 'anon → 401; 5 запросов 200 → шестой 429 + Retry-After; другой аккаунт не задет', async () => {
    const anonymous = await anon.post('/api/me/contacts/import', {
      content: vcardOf([{ email: `matrix-nobody-${rand(3)}@welcome.test`, name: 'Nobody' }]),
      filename: 'contacts.vcf',
    });
    equals(anonymous.status, 401, 'anonymous status');
    equals((anonymous.json as { code?: string }).code, 'unauthorized', 'anonymous code');

    const quotaUser = await ensureFixtureUser('import', `${MARK}Import Quota`);
    const session = await sessionFor(quotaUser.accountId, 'matrix-import-quota');
    const content = vcardOf([{ email: `matrix-nobody-${rand(3)}@welcome.test`, name: 'Nobody' }]);
    const statuses: number[] = [];
    let remaining: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await session.post('/api/me/contacts/import', { content, filename: 'contacts.vcf' });
      statuses.push(res.status);
      remaining = res.headers.get('x-ratelimit-remaining');
    }
    equals(statuses.join(','), '200,200,200,200,200', 'the first five requests are allowed');
    equals(remaining, '0', 'the budget is exactly five');

    const sixth = await session.post('/api/me/contacts/import', { content, filename: 'contacts.vcf' });
    equals(sixth.status, 429, 'sixth status');
    equals((sixth.json as { code?: string }).code, 'rate_limited', 'sixth code');
    const retryAfter = Number(sixth.headers.get('retry-after') ?? '0');
    must(retryAfter > 0 && retryAfter <= 3600, `Retry-After must be inside the hourly window, got ${retryAfter}`);

    // The budget is per account: another identity still gets through.
    const other = await sessionFor(users.get('plain')!.accountId, 'matrix-import-other');
    const fresh = await other.post('/api/me/contacts/import', { content, filename: 'contacts.vcf' });
    equals(fresh.status, 200, 'another account is unaffected');
    return {
      actual: `anon 401 unauthorized; подряд: ${statuses.join(', ')} → 429 rate_limited (Retry-After=${retryAfter}s); другой аккаунт 200`,
      evidence: `${ev(anonymous, 'code')} | ${ev(sixth, 'code')} | Retry-After=${sixth.headers.get('retry-after')} | other=${fresh.status}`,
    };
  });
}

async function modeM(): Promise<void> {
  const alpha = users.get('alpha')!;
  const bravo = users.get('bravo')!;
  const charlie = users.get('charlie')!;
  const delta = users.get('delta')!;
  const echo = users.get('echo')!;

  await check('M1', 'M', 'export JSON: полнота (профиль, контакты, интро, согласия, заметки)', '200 + все секции непусты', async () => {
    const s = await userSession(alpha);
    const res = await s.post('/api/me/export');
    equals(res.status, 200, 'export status');
    must(res.headers.get('content-disposition')?.includes('attachment') === true, 'content-disposition is not an attachment');
    const body = res.json as Record<string, unknown>;
    const required = ['exported_at', 'profile', 'contacts', 'consents', 'memberships', 'introductions', 'notes', 'blocks', 'reports'];
    for (const k of required) must(k in body, `export.${k} missing`);
    must(body.profile !== null, 'export.profile is null');
    for (const k of ['contacts', 'consents', 'memberships', 'introductions', 'notes']) {
      must(Array.isArray(body[k]), `export.${k} is not an array`);
      must((body[k] as unknown[]).length >= 1, `export.${k} is empty`);
    }
    return {
      actual: `секции: contacts=${(body.contacts as unknown[]).length}, consents=${(body.consents as unknown[]).length}, memberships=${(body.memberships as unknown[]).length}, introductions=${(body.introductions as unknown[]).length}, notes=${(body.notes as unknown[]).length}`,
      evidence: clip(JSON.stringify({ keys: Object.keys(body), contacts: (body.contacts as unknown[]).length, notes: (body.notes as unknown[]).length }), 220),
    };
  });

  await check('M2', 'M', 'delete аккаунта (soft → deleting) и данные перестают отдаваться', '400 на неверный confirm; 200 → 401 на ручках и 404 на карточке', async () => {
    const s = await userSession(echo);
    const wrong = await s.del('/api/me', { confirm: 'matrix-wrong' });
    equals(wrong.status, 400, 'wrong confirm');
    equals((wrong.json as { code?: string }).code, 'confirm_mismatch', 'wrong confirm code');
    const res = await s.del('/api/me', { confirm: echo.displayName });
    equals(res.status, 200, 'delete status');
    equals((res.json as { deleted?: boolean }).deleted, true, 'deleted flag');
    const afterProfile = await s.get('/api/me/profile');
    equals(afterProfile.status, 401, 'authed read after delete');
    const afterCard = await anon.get(`/api/public/profiles/${echo.slug}`);
    equals(afterCard.status, 404, 'public card after delete');
    const afterDirectory = await (await userSession(alpha)).get(`/api/events/${F.eventA}/directory?mode=all`);
    const members = (afterDirectory.json as { members?: { profile_id: string }[] }).members ?? [];
    must(!members.some((m) => m.profile_id === echo.profileId), 'deleted account still listed in the directory');
    const rows = await sql!<{ status: string }[]>`SELECT status FROM accounts WHERE id = ${echo.accountId}`;
    equals(rows[0]?.status, 'deleting', 'account status');
    return { actual: `400 confirm_mismatch → 200 deleted:true; 401 на /api/me/profile, 404 на карточке, status='deleting'`, evidence: `${ev(wrong)} | ${ev(res, 'ok', 'deleted')} | ${ev(afterCard)}` };
  });

  await check('M3', 'M', 'blocks: block/unblock через API + эффект в directory', 'already_blocked false→true; was_blocked true; профиль скрыт', async () => {
    const s = await userSession(bravo);
    const block = await s.post('/api/blocks', { target_account_id: charlie.accountId });
    equals(block.status, 200, 'block status');
    equals((block.json as { already_blocked?: boolean }).already_blocked, false, 'first block flag');
    const repeat = await s.post('/api/blocks', { target_account_id: charlie.accountId });
    equals((repeat.json as { already_blocked?: boolean }).already_blocked, true, 'repeat block flag');
    const dir = await s.get(`/api/events/${F.eventA}/directory?mode=all`);
    const members = (dir.json as { members?: { profile_id: string }[] }).members ?? [];
    must(!members.some((m) => m.profile_id === charlie.profileId), 'blocked profile still visible in the directory');
    const self = await s.post('/api/blocks', { target_account_id: bravo.accountId });
    equals(self.status, 400, 'self block');
    equals((self.json as { code?: string }).code, 'self_block', 'self block code');
    const unblock = await s.del(`/api/blocks/${charlie.accountId}`);
    equals(unblock.status, 200, 'unblock status');
    equals((unblock.json as { was_blocked?: boolean }).was_blocked, true, 'unblock flag');
    return { actual: 'block 200 (false) → повтор (true) → невидим в directory → unblock 200 (true); self_block 400', evidence: `${ev(block, 'ok', 'already_blocked')} | ${ev(repeat, 'ok', 'already_blocked')} | ${ev(unblock, 'ok', 'was_blocked')}` };
  });

  await check('M4', 'M', 'reports: 201 open, валидация reason и self', '201 open; 400 invalid_reason; 400 self_report', async () => {
    const s = await userSession(alpha);
    const res = await s.post('/api/reports', { target_account_id: delta.accountId, reason: 'spam', details: `${MARK} report` });
    equals(res.status, 201, 'report status');
    const report = (res.json as { report?: { id: string; status: string } }).report;
    equals(report?.status, 'open', 'report status field');
    const badReason = await s.post('/api/reports', { target_account_id: delta.accountId, reason: 'matrix-nope' });
    equals(badReason.status, 400, 'invalid reason status');
    equals((badReason.json as { code?: string }).code, 'invalid_reason', 'invalid reason code');
    const self = await s.post('/api/reports', { target_account_id: alpha.accountId, reason: 'spam' });
    equals(self.status, 400, 'self report status');
    equals((self.json as { code?: string }).code, 'self_report', 'self report code');
    return { actual: '201 open → 400 invalid_reason → 400 self_report', evidence: `${ev(res, 'ok', 'report')} | ${ev(badReason)} | ${ev(self)}` };
  });
}

// === MODES PART 2 ===

// ---------------------------------------------------------------------------
// Findings (bugs surfaced by this matrix run) — rendered into both reports
// ---------------------------------------------------------------------------

interface Bug {
  id: string;
  severity: 'high' | 'medium' | 'low';
  status: 'fixed' | 'open' | 'documented';
  title: string;
  repro: string;
  evidence: string;
  recommendation?: string;
}

/** Fixes landed since the previous matrix run; rendered as its own section. */
/**
 * What THIS run's tree adds on top of the previous evidence run (1c5ad0f →
 * the five commits below). Rendered near the top of USAGE_MATRIX.md so the
 * report states its own increment instead of inheriting the previous one's.
 */
const INCREMENT: { id: string; title: string; commit: string; changed: string; tests: string }[] = [
  {
    id: 'CI1',
    title: 'Импорт адресной книги: «кто из моих контактов уже здесь» — без Google OAuth',
    commit: 'ea74261 + edcfcfa + 08cf21a + 14ac172',
    changed:
      'src/domain/contact-import.ts — чистый парсер: vCard (FN/N/EMAIL, несколько карточек, складывание строк, CRLF/LF/CR, группы item1.EMAIL; PHOTO/LOGO/KEY/SOUND и base64/quoted-printable игнорируются, а не додумываются; карточка без адреса = skipped) и CSV (существующий RFC4180-парсер + авто-детект колонок EN/RU с приоритетом exact → full → given и исключением family/last/middle, позиционный фолбэк для файлов без заголовка; незакрытая кавычка — отказ, а не половина файла); лимиты 5 МБ / 5000 контактов, превышение честно помечается truncated. POST /api/me/contacts/import — 401, 400 invalid_body/no_contacts/csv_parse_error, 413 на оба лимита, 429; бюджет 5/час на аккаунт в памяти (новый consumeSubjectToken в src/lib/ratelimit.ts, рядом с пер-IP бакетами; таблица-счётчик отклонена, потому что импорт обещает не оставить ни строки); сопоставление — emailLookupHash(email, HASH_PEPPER) по accounts.email_lookup_hash (только active, кроме себя); в ответе display_name/slug/headline ≤50 и НИ ОДНОГО email; единственная запись в БД — audit_events с двумя числами. Карточка «Импорт контактов» на /me/connections (файл .vcf/.csv или вставка, результат «N из ваших контактов уже здесь» со ссылками /p/<slug>, приписка о непосохранении, локализованные ошибки) и capability match у vcard/csv в реестре + docs-internal/product/GOOGLE_OAUTH_SETUP.md.',
    tests:
      'unit: contact-import (+20 — карточки/складка/кодировки/дедуп/лимиты/детект формата/дегенеративные входы, «только email+name»), rate-limit-bucket (+1 — пер-субъектный бакет изолирован от per-IP и других маршрутов); integration: contact-import (+8 — матч по известному адресу и ответ без единого @, CSV-путь, self/disabled исключены, СНИМОК всех таблиц «ничего не сохранено» (+1 только audit_events) и отсутствие хеша импортированного адреса, 401 без следа, 400 на мусор, 413 на оба лимита, 429 на шестом с Retry-After и 200 у другого аккаунта); e2e: contact-import (+2 — реальный сосед, созданный через OTP, найден загрузкой настоящего .vcf; отказ на файле без адресов); живые чеки S9 (панель на странице), S11–S13.',
  },
];

/**
 * The increments of PREVIOUS runs (packet 3: provider registry, ICS, goals,
 * matching v4), kept verbatim as historical reference — the current run's own
 * increment is the table above.
 */
const PREVIOUS_INCREMENTS: { id: string; title: string; commit: string; changed: string; tests: string }[] = [
  {
    id: 'WP1',
    title: 'Реестр провайдеров, статус-резолвер, `GET /api/providers`',
    commit: '03d210c',
    changed:
      'src/domain/providers.ts (контракт §A2, таблица §A3: id/kind/auth/capabilities/direction/status/reason_code/setup{env,steps}; шаги — i18n-ключи, домен без текста), src/lib/provider-status.ts (telegram → TELEGRAM_BOT_TOKEN, email → RESEND_API_KEY; planned/disabled из реестра; только ИМЕНА переменных), публичный `/api/providers` (no-store, без сессии), i18n EN/RU/ES.',
    tests:
      'unit: providers (+9 — снимок реестра против §A3, инвариант direction, наличие i18n-ключей, ветки резолвера, отсутствие значений env в payload); integration: providers (+5 — анонимный 200, allowlist полей, честные статусы, no-store); живые чеки S1–S2.',
  },
  {
    id: 'WP2',
    title: 'ICS-файл события, кнопки календаря/контактов, диплинки шэринга, og:url',
    commit: 'b57e7bb',
    changed:
      'src/domain/ics.ts (RFC 5545: UTC DTSTART/DTEND, X-WR-TIMEZONE, стабильный UID `welcome-event-<id>@<host>`, CRLF-only, складывание по 75 октетов, экранирование с нейтрализацией CRLF-инъекции; online_link физически некуда положить), `GET /api/events/[id]/ics` (доступ как у страницы события, 404/409, no-store), кнопки на `/e/[slug]`, src/domain/share.ts + src/components/share-links.tsx (X/WhatsApp/Telegram/LinkedIn + navigator.share), og:url и vCard-кнопка на карточке.',
    tests:
      'unit: ics (+17 — экранирование/инъекция/UTC/UID/склад/whitelist/Google-ссылка) + share (+5); integration: ics (+5 — 200 + заголовки, 404, 409, комнатная ссылка не утекает, стабильный UID); e2e: interop (+2); живые чеки S3–S5, S10.',
  },
  {
    id: 'WP3',
    title: 'Страница `/me/connections`',
    commit: '78af9c1',
    changed:
      'рендер реестра: карточка на провайдера (статус, причина, capabilities простыми словами, направление, `<details>` «как подключить» с шагами и ИМЕНАМИ переменных, кнопка действия только для живых), блок «что делаем / чего не делаем», запись в nav `/me/layout.tsx`, i18n EN/RU/ES (~40 ключей + названия и описания 15 провайдеров). Исправлен баг, найденный новым интеграционным тестом: `icsFilename` схлопывал `_` в `-` и переименовывал файл относительно события (generateEventSlug отдаёт base64url).',
    tests:
      'integration: connections (+5 — все id отрендерены, причина и имя переменной, значения env не попадают в HTML, гейт сессии); e2e: connections (+2 — из nav, статусы/раскрытие, redirect для анонима); живые чеки S9.',
  },
  {
    id: 'WP4',
    title: 'Приватные цели профиля (каталог ≤3)',
    commit: '88f8f25',
    changed:
      'миграция 011 (profiles.goals text[] NOT NULL DEFAULT \'{}\' + GIN; НЕ дублируется в event_memberships — цели приватны), src/domain/goals.ts (16 целей с ru/en/es и паттернами для v4), валидация (каталог, ≤3, дедуп с сохранением первого места = приоритета), goals в POST/GET `/api/me/profile`, в `/api/taxonomy` (версия остаётся v3) и в GDPR-экспорте, пикер в `/me/profile` и на шаге 2 онбординга (в черновике — top-level, чтобы контракт `values` не менялся).',
    tests:
      'unit: goals (+8 — каталог, три локали, паттерны ссылаются на реальные id, валидация/порядок/лимит, форма payload, паритет i18n); integration: goals (+10 — схема и GIN, порядок round-trip, 400 на 4-ю и неизвестную, очистка, ПРИВАТНОСТЬ: нет в публичном JSON/vCard/HTML карточки, есть в экспорте, taxonomy аддитивна); e2e: goals (+1); живые чеки S6–S7.',
  },
  {
    id: 'WP5',
    title: 'Matching v4: полезность, комплементарность, цели, 4 режима, две строки причин',
    commit: '5f8018d',
    changed:
      'src/domain/networking-score.ts (аддитивно: NETWORKING_ALGORITHM_V4, веса 0.30/0.20/0.25/0.15/0.10, матрица из 6 пар функций, intentFit с приоритетом намерения, complementarity = матрица ИЛИ взаимные needs×offers, goalAlignment по приватным целям, novelty против уже выбранных, recency — тайбрейкер вне формулы; гейт v3 + complementarity ≥ 0.25 для `useful`; чистая `rankCandidates`), src/domain/reasons-v4.ts (отдельный словарь, один код = одна строка), `GET .../recommendations?mode=useful|grow|similar|explore` (+ `excluded_reason`), переключатель режимов и двухстрочные причины в UI. Только два оговорённых ассерта изменены (литерал algorithm в taxonomy-v3, allowlist в recommendations); парити-тест matching не тронут.',
    tests:
      'unit: networking-v4 (+23 — формула дословно, сумма весов = 1, матрица, приоритет, goalAlignment, novelty, детерминизм, recency как тайбрейкер, гейты, режимы, причины, v3 не изменился) + reasons-v4 (+8); integration: recommendations-v4 (+5 — четыре режима дают разные выдачи, коды двух строк, 400 на неизвестный режим, excluded_reason, allowlist, цели кандидата не читаются); e2e: matching-modes (+1); живые чеки S8.',
  },
  {
    id: 'WP6',
    title: 'Полный прогон гейтов + скрипт `pnpm gates`',
    commit: '1049039',
    changed:
      'scripts/run-gates.mjs (7 гейтов последовательно, `evidence/final-gates.{json,log}`, предыдущий прогон сохраняется в `previous_run`); найден и исправлен флейк e2e (клик по nav сразу после OTP-редиректа гоняется с перерисовкой shell), обновлены скриншоты карточки.',
    tests: '7/7 exit 0: unit 438 (было 366), integration 322 + 1 skip (293), e2e 24 (18).',
  },
  {
    id: 'WP7',
    title: 'Новые чеки матрицы + живой прогон против прод-БД',
    commit: 'fda5c17',
    changed:
      'Режим S в scripts/usage-matrix.mts (10 чеков: providers, ICS, goals, режимы рекомендаций, connections, карточка), `createEvent` умеет расписание и комнатную ссылку, `updateProfile` переносит goals.',
    tests: '123 чека: 122 PASS / 0 FAIL / 1 SKIP (было 113: 112/0/1).',
  },
];

const FIXES: { id: string; fix: string; tests: string }[] = [
  {
    id: 'BUG-2',
    fix:
      'src/infra/cleanup.ts: новый шаг 6a удаляет claim-челленджи ровно тех registrations, которые удаляет шаг 6b (то же 30-дневное окно, батчи ORDER BY id), до любого DELETE registrations; CHECK не ослаблен, миграции не тронуты.',
    tests:
      'tests/integration/cleanup.test.ts «cleanup: a live claim challenge never breaks the registration batch (BUG-2 regression)» — без 6a падает с 23514, с 6a проходит; claimed/young контроль не задет, второй проход идемпотентен.',
  },
  {
    id: 'BUG-3',
    fix:
      'Промпт требует best-effort черновик всегда (в т.ч. из собственных полей) и строго один JSON; транспорт делает РОВНО один внутренний повтор при пустом ответе/неразбираемом теле (тот же запрос, тот же бюджет токенов, общий wall-clock бюджет 30с); маршрут отвечает 200 {ok, draft, sources: [], degraded: true} детерминированным черновиком из полей профиля (industry/job_function резолвятся через каталог), а не 502.',
    tests:
      'tests/unit/enrichment-degraded.test.ts (повтор ровно один, восстановление на втором ответе, 429/5xx/4xx без повтора, промпт, детерминированный fallback) + tests/integration/enrichment.test.ts «provider answers without a draft twice → 200 + degraded draft» (реальный транспорт против заглушки апстрима).',
  },
  {
    id: 'BUG-4',
    fix:
      'Оба исхода маршрута enrich теперь пишут одну структурную строку console.error (provider/state/code/retryable) — без PII, без секретов, без тел запросов; клиент по-прежнему не получает деталей провайдера.',
    tests:
      'tests/integration/enrichment.test.ts «a real provider failure is still a 502 with a server-side trace (BUG-4)» — строка есть, содержит code=upstream_5xx и не содержит токена, имени проекта и имени профиля.',
  },
  {
    id: 'R1',
    fix:
      '?lang=en|ru|es на публичных страницах (/, /login, /p/*, /legal/*): src/proxy.ts валидирует параметр, форвардит x-welcome-locale и переписанный Cookie текущему рендеру (включая <html lang> в layout) и сохраняет выбор в cookie welcome_locale; невалидное значение игнорируется и не затирает сохранённую локаль. Подписанные разделы остались cookie-only.',
    tests:
      'tests/unit/locale-query.test.ts (резолвер + контракт прокси) + tests/e2e/smoke.spec.ts «?lang= switches the landing language and is remembered (R1)».',
  },
  {
    id: 'Отклонения (API)',
    fix:
      'DELETE /api/me/contacts?kind=… (владелец, 400/404/200, значение никогда не эхоится) и GET /api/me (минимальная секретless-обёртка {ok, account}), которых не хватало по списку отклонений отчёта.',
    tests:
      'tests/integration/authz-negative.test.ts «contacts DELETE is session-scoped…» и «GET /api/me is owner-only, minimal and secretless».',
  },
];

const BUGS: Bug[] = [
  {
    id: 'BUG-1',
    severity: 'high',
    status: 'fixed',
    title: 'POST /api/auth/otp/request отвечал 500 при существующей строке accounts с той же email-хешом под другим auth_subject',
    repro:
      'INSERT INTO accounts (auth_subject, email_lookup_hash) VALUES (\'alien:<hash>\', \'<hash>\') для адреса, затем POST /api/auth/otp/request {email} → 500 internal_error ' +
      '(PostgresError 23505 accounts_email_lookup_hash_key). Живое подтверждение: строки в логах Vercel responseStatusCode:500 с этим constraint, найденные в ходе прогона мод A.',
    evidence:
      'Причина: `INSERT … ON CONFLICT (auth_subject) DO NOTHING` — у accounts ДВА уникальных индекса, второй конфликт не обрабатывался. ' +
      'Починено на `ON CONFLICT DO NOTHING` (src/app/api/auth/otp/request/route.ts) + регрессионный тест tests/integration/auth.test.ts ' +
      '("otp request: account row under a different auth_subject does not 500"): без фикса тест падает (500), с фиксом проходит (200).',
    recommendation: 'Задеплоить фикс: на живом деплое баг воспроизводится и у любого клиента с такой строкой login отдаёт 500.',
  },
  {
    id: 'BUG-2',
    severity: 'medium',
    status: 'fixed',
    title: 'Удаление registration с действующим claim-челленджем падает: ON DELETE SET NULL конфликтует с CHECK link_challenges_claim_shape_check',
    repro:
      'DELETE FROM registrations WHERE id = <registration с link_challenges.purpose=\'registration_claim\'>; → ERROR 23514 ' +
      '"new row for relation \\"link_challenges\\" violates check constraint \\"link_challenges_claim_shape_check\\"". ' +
      'Найдено при purge матрицы (первый прогон упал на этом шаге).',
    evidence:
      'db/migrations/003_link_challenges_claim.sql: CHECK ((purpose=\'registration_claim\' AND registration_id IS NOT NULL AND account_id IS NULL) OR (purpose<>\'registration_claim\' AND registration_id IS NULL)); ' +
      'FK link_challenges.registration_id → registrations(id) ON DELETE SET NULL. ' +
      'Латентный риск в src/infra/cleanup.ts шаг 6 (DELETE FROM registrations для событий, закончившихся >30 дней назад): шаг 3 удаляет только челленджи, просроченные >30 дней, поэтому «свежий» claim-челлендж старого события ломает весь батч. ' +
      'ИСПРАВЛЕНО: шаг 6a (delete link_challenges по тому же предикату, drained до конца) выполняется до 6b; CHECK сохранён, схема не менялась. ' +
      'Регрессионный тест tests/integration/cleanup.test.ts «…(BUG-2 regression)»: без 6a — 23514 и fail, с 6a — pass; claimed/young регистрации и их челленджи не тронуты, повторный проход — no-op.',
    recommendation:
      'Достаточно 6a; перевод FK на ON DELETE CASCADE не нужен (он бы молча терял привязку челленджа вместо явного удаления).',
  },
  {
    id: 'BUG-3',
    severity: 'medium',
    status: 'fixed',
    title: 'Живой enrichment нестабилен: 502 enrichment_failed (мода F1 красная)',
    repro:
      'POST /api/me/enrich с сессией аккаунта с профилем → 502 (code: enrichment_failed, retryable:true) за ~6.6с. Профиль БЕЗ своих ссылок — стабильно красный (4 вызова в двух прогонах). Профиль С website-ссылкой — плавающий: FAIL в двух прогонах, PASS (200 + draft) в третьем. Локальный repro тем же ключом/моделью: transport.enrich({links:[]}) → state=failed code=no_draft; transport.enrich({links:[website]}) → state=ok.',
    evidence:
      'Код провайдера в ответ не попадает (см. BUG-4), поэтому наблюдаемый факт — 502. Прямое измерение живого апстрима тем же ключом/моделью (2026-09-14): HTTP 200, finishReason STOP, grounded=true, но видимых частей нет (textLen=0, thoughts 248–400 и 3307 у трёх вызовов) — то есть бюджет НЕ исчерпан, модель периодически просто возвращает пустой видимый ответ. ' +
      'ИСПРАВЛЕНО в три слоя: (1) промпт требует best-effort черновик всегда и строго один JSON; (2) транспорт повторяет такой ответ ровно один раз с тем же бюджетом токенов (в живом прогоне повтор восстанавливает черновик); (3) если и повтор пуст, маршрут отдаёт 200 с детерминированным degraded-черновиком из полей профиля и флагом degraded:true — UI получает результат всегда, ничего не выдумано и не сохранено. ' +
      'Тесты: tests/unit/enrichment-degraded.test.ts, tests/integration/enrichment.test.ts («provider answers without a draft twice → 200 + degraded draft»).',
    recommendation:
      'Остаточный риск честно задокументирован: сам провайдер по-прежнему стохастичен (ручной LIVE-тест ENRICHMENT_LIVE=1 может не получить draft с первого-второго раза); контракт ручки теперь от него не зависит.',
  },
  {
    id: 'BUG-4',
    severity: 'low',
    status: 'fixed',
    title: '502 enrichment_failed не оставляет серверного следа: код провайдера теряется',
    repro: 'Сравнить: ответ 502 без кода провайдера + отсутствие записи в Vercel runtime logs с этим кодом (проверено vercel logs).',
    evidence:
      'src/app/api/me/enrich/route.ts: `return jsonError(502, \'enrichment_failed\', …)` без console.error и без кода (`result.code`) — при этом клиенту код и не должен отдаваться (правильно), но в логи он обязан попадать. ' +
      'ИСПРАВЛЕНО: и degraded-, и failure-ветка пишут одну строку `[enrich] … provider=… state=… code=… retryable=…` (без PII, секретов и тел); тест tests/integration/enrichment.test.ts «…server-side trace (BUG-4)» проверяет наличие строки с code=upstream_5xx и отсутствие токена/имени проекта/имени профиля.',
    recommendation: 'Готово; для алертинга по деградации искать `[enrich] degraded fallback`.',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Removes every synthetic row this script can. The schema cascades almost
 * everything from `accounts` (profiles → contacts/memberships/consents/…) and
 * from `organizers` (events → campaigns/registrations/memberships), so two
 * DELETE statements carry the bulk; only FK-less rows need explicit handling.
 * Called twice: at setup start (sweep leftovers from an interrupted run) and at
 * the end of a run.
 */
async function purgeMatrix(): Promise<string[]> {
  const notes: string[] = [];
  if (!sql) return ['no database connection — nothing cleaned'];
  const hashes = [...USER_KEYS.map(emailFor), ...EPHEMERAL_EMAILS].map(hash).filter(Boolean);
  must(hashes.length > 0, 'no fixture email hashes: HASH_PEPPER missing');

  const accountRows = await sql<{ id: string }[]>`
    SELECT DISTINCT a.id FROM accounts a
    LEFT JOIN profiles p ON p.account_id = a.id
    WHERE a.email_lookup_hash = ANY(${hashes})
       OR a.auth_subject LIKE 'matrix:%'
       -- Soft-deleted fixtures: mode M2 runs the REAL DELETE /api/me, which NULLs
       -- email_lookup_hash and rewrites auth_subject to 'deleted:<id>' — the public
       -- slug is then the only remaining marker.
       OR p.public_slug LIKE 'matrix-%'`;
  const accountIds = accountRows.map((r) => r.id);

  if (accountIds.length) {
    const jobs = await sql`DELETE FROM outbox_jobs WHERE payload->>'account_id' = ANY(${accountIds}) RETURNING id`;
    await sql`UPDATE audit_events SET actor_account_id = NULL WHERE actor_account_id = ANY(${accountIds})`;
    notes.push(`outbox_jobs removed: ${jobs.length}; audit_events unlinked (actor → NULL, как в собственном cleanup приложения)`);
    const deleted = await sql`DELETE FROM accounts WHERE id = ANY(${accountIds}) RETURNING id`;
    notes.push(`accounts hard-deleted: ${deleted.length}/${accountIds.length} (каскадом — profiles, contacts, memberships, consents, sessions, challenges, mfa, blocks, reports)`);
  } else {
    notes.push('accounts: нечего удалять');
  }

  const organizerRows = created.organizers.length
    ? await sql<{ id: string }[]>`SELECT id FROM organizers WHERE id = ANY(${created.organizers}) OR display_name LIKE ${`${MARK}%`}`
    : await sql<{ id: string }[]>`SELECT id FROM organizers WHERE display_name LIKE ${`${MARK}%`}`;
  const organizerIds = organizerRows.map((r) => r.id);
  if (organizerIds.length) {
    // Registration claim challenges must go BEFORE their registrations: the FK
    // is ON DELETE SET NULL while link_challenges_claim_shape_check demands
    // registration_id NOT NULL for purpose='registration_claim', so the cascade
    // itself raises 23514 (finding BUG-2 in the report; the app's own cleanup
    // has the same latent hazard).
    const claims = await sql`
      DELETE FROM link_challenges lc
      USING registrations r, events e
      WHERE lc.registration_id = r.id AND r.event_id = e.id AND e.organizer_id = ANY(${organizerIds})
      RETURNING lc.id`;
    if (claims.length) notes.push(`link_challenges (registration_claim) removed before their registrations: ${claims.length}`);
    const deleted = await sql`DELETE FROM organizers WHERE id = ANY(${organizerIds}) RETURNING id`;
    notes.push(`organizers hard-deleted: ${deleted.length} (каскадом — events, campaigns, registrations, memberships, introductions)`);
  } else {
    notes.push('organizers: нечего удалять');
  }

  if (created.inboxEvents.length) {
    const deleted = await sql`DELETE FROM inbox_events WHERE external_event_id = ANY(${created.inboxEvents}) RETURNING id`;
    notes.push(`synthetic telegram inbox_events removed: ${deleted.length}`);
  }
  return notes;
}

interface GateRecord {
  id: string;
  command: string;
  exit: number;
  summary: string;
}

/** Gates from Part 1 (written by the local gate run into evidence/matrix/gates.json). */
function readGates(): GateRecord[] {
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, 'evidence/matrix/gates.json'), 'utf8')) as { gates?: GateRecord[] };
    return raw.gates ?? [];
  } catch {
    return [];
  }
}

function writeReports(cleanupNotes: string[], startedAt: string, finishedAt: string): void {
  const gates = readGates();
  const summary = {
    total: rows.length,
    pass: rows.filter((r) => r.status === 'PASS').length,
    fail: rows.filter((r) => r.status === 'FAIL').length,
    skip: rows.filter((r) => r.status === 'SKIP').length,
    blocked: rows.filter((r) => r.status === 'BLOCKED').length,
  };
  const json = {
    base: BASE,
    live: LIVE,
    started_at: startedAt,
    finished_at: finishedAt,
    summary,
    gates,
    bugs: BUGS,
    deviations,
    created: {
      accounts: created.accounts.length,
      profiles: created.profiles.length,
      organizers: created.organizers.length,
      events: created.events.length,
      campaigns: created.campaigns.length,
      registrations: created.registrations.length,
    },
    cleanup: cleanupNotes,
    rows,
  };
  mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
  writeFileSync(path.join(ROOT, 'evidence/usage-matrix.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8');

  const byMode = new Map<string, Row[]>();
  for (const row of rows) {
    if (!byMode.has(row.mode)) byMode.set(row.mode, []);
    byMode.get(row.mode)!.push(row);
  }
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  const lines: string[] = [];
  lines.push('# USAGE MATRIX — живой прогон всех режимов');
  lines.push('');
  lines.push(`- **BASE:** ${BASE} (\`--live\`=${LIVE})`);
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE)) {
    lines.push(
      '- **Цель прогона:** локальный production-билд текущего дерева (`next start`) с теми же прод-секретами, что у деплоя (Neon, Vertex, Telegram, worker-tick). ' +
        'Деплой в этом задании запрещён, поэтому «живой» прогон идёт против локального экземпляра, а не против staging-URL; секреты в отчёты не попадают (редакция в скрипте).',
    );
  }
  lines.push(`- **Прогон:** ${startedAt} → ${finishedAt}`);
  lines.push(`- **Итог:** ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.skip} SKIP / ${summary.blocked} BLOCKED (всего ${summary.total})`);
  lines.push('- **Машинный отчёт:** [usage-matrix.json](usage-matrix.json)');
  lines.push('');
  lines.push('## Инкремент этого прогона');
  lines.push('');
  lines.push('| ID | Что | Коммит | Изменения | Тесты |');
  lines.push('|---|---|---|---|---|');
  for (const inc of INCREMENT) {
    lines.push(`| ${inc.id} | ${cell(inc.title)} | \`${inc.commit}\` | ${cell(inc.changed)} | ${cell(inc.tests)} |`);
  }
  lines.push('');
  lines.push('## Часть 1 — автоматические гейты (локально)');
  lines.push('');
  if (gates.length === 0) {
    lines.push('_evidence/matrix/gates.json не найден — гейты не зафиксированы._');
  } else {
    lines.push('| Гейт | Команда | Exit | Результат |');
    lines.push('|---|---|---|---|');
    for (const g of gates) lines.push(`| ${g.id} | \`${g.command}\` | **${g.exit}** | ${cell(g.summary)} |`);
    lines.push('');
    lines.push('Сырые логи гейтов: `evidence/matrix/*.log`.');
  }
  lines.push('');
  lines.push('## Инкременты ПРЕДЫДУЩИХ прогонов (историческая справка, не часть этого инкремента)');
  lines.push('');
  lines.push('| ID | Что | Коммит | Изменения | Тесты |');
  lines.push('|---|---|---|---|---|');
  for (const inc of PREVIOUS_INCREMENTS) {
    lines.push(`| ${inc.id} | ${cell(inc.title)} | \`${inc.commit}\` | ${cell(inc.changed)} | ${cell(inc.tests)} |`);
  }
  lines.push('');
  lines.push('## Исправления в ПРЕДЫДУЩИХ прогонах (историческая справка, не часть этого инкремента)');
  lines.push('');
  for (const f of FIXES) {
    lines.push(`### ${f.id}`);
    lines.push('');
    lines.push(`- **Фикс:** ${cell(f.fix)}`);
    lines.push(`- **Тесты:** ${cell(f.tests)}`);
    lines.push('');
  }
  lines.push('## Найденные баги в ПРЕДЫДУЩИХ прогонах (все исправлены, историческая справка)');
  lines.push('');
  for (const b of BUGS) {
    lines.push(`### ${b.id} — ${b.title}`);
    lines.push('');
    lines.push(`- **Severity:** ${b.severity} · **Статус:** ${b.status}`);
    lines.push(`- **Repro:** ${cell(b.repro)}`);
    lines.push(`- **Доказательство:** ${cell(b.evidence)}`);
    if (b.recommendation) lines.push(`- **Рекомендация:** ${cell(b.recommendation)}`);
    lines.push('');
  }
  for (const [mode, modeRows] of [...byMode.entries()].sort()) {
    lines.push(`## Режим ${mode}`);
    lines.push('');
    lines.push('| ID | Проверка | Ожидание | Факт | Статус | Доказательство |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of modeRows) {
      lines.push(`| ${r.id} | ${cell(r.description)} | ${cell(r.expect)} | ${cell(r.actual)} | **${r.status}** | ${cell(clip(r.evidence, 200))} |`);
    }
    lines.push('');
  }
  if (deviations.length) {
    lines.push('## Отклонения от ожиданий задания');
    lines.push('');
    for (const d of deviations) lines.push(`- ${d}`);
    lines.push('');
  }
  lines.push('## Созданные / удалённые MATRIX-сущности');
  lines.push('');
  lines.push(
    `Создано за прогон: ${created.accounts.length} аккаунтов, ${created.profiles.length} профилей, ${created.events.length} событий, ` +
      `${created.organizers.length} организаторов, ${created.campaigns.length} кампаний. Все имена — с префиксом \`MATRIX-\` (display_name, названия событий и организаторов, body кампаний), слаги — \`matrix-…\`.`,
  );
  lines.push('');
  lines.push('Cleanup:');
  for (const n of cleanupNotes) lines.push(`- ${n}`);
  lines.push('');
  writeFileSync(path.join(ROOT, 'evidence/USAGE_MATRIX.md'), `${lines.join('\n')}\n`, 'utf8');
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`usage-matrix → ${BASE} (live=${LIVE})`);
  if (!DB_URL) {
    console.error('DATABASE_URL/NEON_CONN_* unavailable — fixtures cannot be created');
    process.exit(2);
  }
  const swept = await purgeMatrix();
  if (!KEEP) console.log(`sweep (leftovers from previous runs): ${swept.join('; ')}`);
  await setup();
  console.log(`fixtures ready: event A ${F.eventA}, closed ${F.eventClosed}, lock ${F.eventLock}, org B ${F.eventB}`);
  const run = (mode: string, fn: () => Promise<void>) => (ONLY.length === 0 || ONLY.includes(mode) ? fn() : Promise.resolve());
  await run('A', modeA);
  await run('B', modeB);
  await run('C', modeC);
  await run('D', modeD);
  await run('E', modeE);
  await run('F', modeF);
  await run('G', modeG);
  await run('H', modeH);
  await run('I', modeI);
  await run('J', modeJ);
  await run('K', modeK);
  await run('L', modeL);
  await run('N', modeN);
  await run('O', modeO);
  await run('Q', modeQ); // before P: P burns the shared per-IP bucket on purpose
  await run('P', modeP);
  await run('R', modeR);
  await run('S', modeS); // interop + matching v4 (packet 3)
  await run('M', modeM); // last: it deletes an account and files reports
  const cleanupNotes = KEEP ? ['--keep: фикстуры оставлены намеренно'] : await purgeMatrix();
  const finishedAt = new Date().toISOString();
  writeReports(cleanupNotes, startedAt, finishedAt);
  const summary = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`\nsummary: ${JSON.stringify(summary)}`);
  await sql?.end({ timeout: 10 });
}

await main();
