/**
 * OwnerRez PMS client.
 *
 * Replaces hostaway.ts (2026-09-08). Hostaway was retired as part of the
 * property-management migration and its Public API is now switched off for the
 * account — every scan since the cutover failed with
 * `403 {"status":"fail","message":"Public api is disabled for this account"}`.
 *
 * Two auth modes, because OwnerRez splits them:
 *   - Personal Access Token (Basic email:token) — bookings, properties, guests.
 *     Works today with the credentials already used by the migration scripts.
 *   - OAuth app access token (Bearer) — REQUIRED for the messaging endpoints.
 *     PATs get HTTP 402 `messaging_not_enabled`. Self-use is free: create an
 *     OAuth app under Settings → Developer/API, then Users → "Grant Access To
 *     Me". See scripts/ownerrez-auth.ts for the device-grant helper.
 *
 * The OAuth token is used for everything when present; the PAT is the fallback
 * for the non-messaging calls so the booking half of the system keeps working
 * before the OAuth app exists.
 *
 * NOTE: like hostaway.ts, this module is deliberately read-only against guest
 * conversations. There is no send path and none should be added — talking to
 * guests is Brady's call (rule established 2026-08-10).
 */

import fs from 'fs';
import path from 'path';
import { config } from './config';
import { NormalisedMessage } from './detect';

export { scanMessagesForPoolHeat, PoolHeatResult } from './detect';

const BASE = 'https://api.ownerrez.com';
const USER_AGENT = 'pool-heat-manager/1.0 (+https://github.com/kylehawke-stack/pool-heat-manager)';

// OwnerRez returns 403 for requests without a User-Agent, so it is set on every call.

// ---------------------------------------------------------------------------
// OAuth token store
// ---------------------------------------------------------------------------

const TOKEN_PATH = path.resolve(process.cwd(), 'data', 'ownerrez-token.json');

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms. Absent for permanent tokens. */
  expires_at?: number;
  user_id?: number;
}

let tokenCache: StoredToken | null | undefined; // undefined = not loaded yet

function loadToken(): StoredToken | null {
  if (tokenCache !== undefined) return tokenCache;
  try {
    tokenCache = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as StoredToken;
  } catch {
    tokenCache = null;
  }
  return tokenCache;
}

export function saveToken(t: StoredToken): void {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2));
  tokenCache = t;
}

/**
 * Exchange a refresh token for a fresh access token.
 * Throws if the app credentials or refresh token are missing.
 */
export async function refreshAccessToken(): Promise<StoredToken> {
  const stored = loadToken();
  const { clientId, clientSecret } = config.ownerrez;
  if (!stored?.refresh_token) {
    throw new Error('OwnerRez OAuth refresh failed: no refresh_token stored — re-run scripts/ownerrez-auth.ts');
  }
  if (!clientId || !clientSecret) {
    throw new Error('OwnerRez OAuth refresh failed: OWNERREZ_CLIENT_ID / OWNERREZ_CLIENT_SECRET not set');
  }

  const res = await fetch(`${BASE}/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(`OwnerRez OAuth refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as any;
  const next: StoredToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || stored.refresh_token,
    expires_at: data.expires_in ? Date.now() + (data.expires_in - 300) * 1000 : undefined,
    user_id: data.user_id ?? stored.user_id,
  };
  saveToken(next);
  console.log(`[OwnerRez] OAuth access token refreshed (expires ${next.expires_at ? new Date(next.expires_at).toISOString() : 'never'})`);
  return next;
}

function patHeader(): string | null {
  const { patEmail, patToken } = config.ownerrez;
  if (!patEmail || !patToken) return null;
  return `Basic ${Buffer.from(`${patEmail}:${patToken}`).toString('base64')}`;
}

/** True when an OAuth access token is present — the only way to read messages. */
export function hasOAuth(): boolean {
  return Boolean(loadToken()?.access_token);
}

/**
 * Thrown when a messaging call is attempted without a usable OAuth token.
 * Callers must treat this as "detection is blind", never as "no pool heat" —
 * silently returning an empty message list would read as `not_discussed` and
 * quietly skip a paid heat booking.
 */
export class MessagingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface GetOptions {
  /** Messaging endpoints reject PAT auth — force OAuth and fail loudly. */
  requireOAuth?: boolean;
}

async function orzGet(pathname: string, params?: Record<string, string>, opts: GetOptions = {}): Promise<any> {
  const url = new URL(`${BASE}${pathname}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const attempt = async (auth: string): Promise<Response> =>
    fetch(url.toString(), { headers: { Authorization: auth, 'User-Agent': USER_AGENT, Accept: 'application/json' } });

  const stored = loadToken();
  let auth: string;

  if (stored?.access_token) {
    // Proactively refresh a token we know is expired rather than burning a 401.
    if (stored.expires_at && Date.now() >= stored.expires_at && stored.refresh_token) {
      auth = `Bearer ${(await refreshAccessToken()).access_token}`;
    } else {
      auth = `Bearer ${stored.access_token}`;
    }
  } else {
    const pat = patHeader();
    if (opts.requireOAuth) {
      throw new MessagingUnavailableError(
        'OwnerRez messaging requires an OAuth app access token; only a Personal Access Token is configured. ' +
        'Create an OAuth app at Settings → Developer/API, click Users → "Grant Access To Me", then run scripts/ownerrez-auth.ts.'
      );
    }
    if (!pat) throw new Error('OwnerRez credentials missing: set OWNERREZ_PAT_EMAIL/OWNERREZ_PAT_TOKEN or authorise an OAuth app');
    auth = pat;
  }

  let res = await attempt(auth);

  // Expired bearer token — refresh once and retry.
  if (res.status === 401 && auth.startsWith('Bearer ') && loadToken()?.refresh_token) {
    console.warn('[OwnerRez] 401 on bearer token — refreshing and retrying');
    auth = `Bearer ${(await refreshAccessToken()).access_token}`;
    res = await attempt(auth);
  }

  if (res.status === 402) {
    throw new MessagingUnavailableError(
      `OwnerRez refused a messaging call (402): ${await res.text()}. ` +
      'Messaging needs an OAuth app with self-use access granted (Users → "Grant Access To Me").'
    );
  }

  if (!res.ok) {
    throw new Error(`OwnerRez GET ${pathname} failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

/** Walk a paged OwnerRez collection, returning every item. */
async function orzGetAll(pathname: string, params: Record<string, string>, opts: GetOptions = {}): Promise<any[]> {
  const limit = Number(params.limit || 50);
  const out: any[] = [];
  let offset = 0;

  for (let page = 0; page < 50; page++) { // hard stop; 50 pages is far beyond this account
    const data = await orzGet(pathname, { ...params, limit: String(limit), offset: String(offset) }, opts);
    const items: any[] = data?.items || [];
    out.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Reservations (OwnerRez "bookings")
// ---------------------------------------------------------------------------

/**
 * The shape the scheduler works in. Field names are inherited from the
 * Hostaway era so the scheduler, digest, SMS and confirm modules did not have
 * to be rewritten; `listingMapId` now carries the OwnerRez property id.
 *
 * `status` is OwnerRez's own vocabulary: 'active' | 'pending' | 'canceled'.
 * Only 'active' is a confirmed booking — the equivalent of Hostaway 'modified'.
 */
export interface Reservation {
  id: number;
  listingMapId: number;
  guestName: string;
  arrivalDate: string; // YYYY-MM-DD
  departureDate: string;
  status: string;
  /** Message threads attached to this booking. Empty for bookings with no channel thread. */
  threadIds: number[];
  /** 'Airbnb' | 'Vrbo' | null (direct). Informational. */
  listingSite: string | null;
  isBlock: boolean;
}

function mapBooking(b: any): Reservation {
  const g = b.guest || {};
  const guestName = [g.first_name, g.last_name].filter(Boolean).join(' ').trim() || `Guest ${b.guest_id ?? b.id}`;
  return {
    id: b.id,
    listingMapId: b.property_id,
    guestName,
    arrivalDate: b.arrival,
    departureDate: b.departure,
    status: b.status,
    threadIds: Array.isArray(b.thread_ids) ? b.thread_ids : [],
    listingSite: b.listing_site ?? null,
    isBlock: Boolean(b.is_block),
  };
}

/**
 * Get all upcoming confirmed bookings for the given OwnerRez property ids.
 *
 * `from` filters on departure date, so a stay already in progress is still
 * returned — that matches the old Hostaway behaviour (departure > today).
 * Owner blocks are excluded: they have no guest and no conversation.
 */
export async function getAllUpcomingReservations(propertyIds: number[]): Promise<Reservation[]> {
  const today = new Date().toISOString().split('T')[0];
  const items = await orzGetAll('/v2/bookings', {
    property_ids: propertyIds.join(','),
    from: `${today}T00:00:00Z`,
    status: 'active',
    include_guest: 'true',
    limit: '50',
  });

  return items
    .map(mapBooking)
    .filter(r =>
      propertyIds.includes(r.listingMapId) &&
      r.status === 'active' &&
      !r.isBlock &&
      r.departureDate > today
    );
}

/**
 * Get a single booking by id.
 *
 * Callers MUST check `status` themselves. The 2026-08-10 incident (a followup
 * sent to a guest who had cancelled in July) happened precisely because the
 * status filter lived only in the list fetch and every by-id path skipped it.
 */
export async function getReservation(id: number): Promise<Reservation> {
  const b = await orzGet(`/v2/bookings/${id}`, { include_guest: 'true' });
  return mapBooking(b);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const GUEST_ROLES = new Set(['guest', 'cotraveler', 'third_party_booker']);

function mapMessage(m: any): NormalisedMessage {
  const isGuest = GUEST_ROLES.has(String(m.from_role || ''));
  return {
    body: m.body || '',
    isIncoming: isGuest ? 1 : 0,
    senderType: isGuest ? 'guest' : 'host',
    insertedOn: m.date_utc || '',
  };
}

/** Fetch every message on one OwnerRez thread, oldest first. */
export async function getThreadMessages(threadId: number): Promise<NormalisedMessage[]> {
  const data = await orzGet('/v2/messages', { threadId: String(threadId) }, { requireOAuth: true });
  const items: any[] = data?.items || data?.messages || [];
  return items
    .filter(m => !m.is_draft && !m.removed_utc)
    .map(mapMessage);
}

/**
 * Get the conversation for a booking, across all of its threads.
 *
 * OwnerRez has no thread-list endpoint — threads are discovered through the
 * `thread_ids` array on the booking, which is why `threadIds` is carried on
 * Reservation. Passing them in avoids a second booking fetch on the hot path.
 *
 * Throws MessagingUnavailableError when OAuth is not configured. It must NOT
 * be swallowed into an empty array: an empty conversation classifies as
 * `not_discussed`, which looks exactly like "the guest never asked for heat".
 */
export async function getConversationMessages(
  reservationId: number,
  threadIds?: number[],
): Promise<NormalisedMessage[]> {
  let ids = threadIds;
  if (!ids) {
    ids = (await getReservation(reservationId)).threadIds;
  }
  if (!ids.length) return [];

  const all: NormalisedMessage[] = [];
  for (const tid of ids) {
    all.push(...await getThreadMessages(tid));
  }

  // Multiple threads (rare — e.g. a channel thread plus a direct email thread)
  // interleave by timestamp so the offer/reply ordering stays correct.
  if (ids.length > 1) {
    all.sort((a, b) => new Date(a.insertedOn).getTime() - new Date(b.insertedOn).getTime());
  }
  return all;
}

/**
 * Find the booking a thread belongs to. Used by the message webhook, whose
 * payload carries the thread but not always the booking.
 */
export async function getBookingIdForThread(threadId: number): Promise<number | null> {
  const data = await orzGet('/v2/messages', { threadId: String(threadId), include_drafts: 'false' }, { requireOAuth: true });
  return data?.thread?.booking_id ?? null;
}

// ---------------------------------------------------------------------------
// Webhook subscriptions (OAuth apps only)
// ---------------------------------------------------------------------------

export async function listWebhookSubscriptions(): Promise<any[]> {
  const data = await orzGet('/v2/webhooksubscriptions', { limit: '50' });
  return data?.items || [];
}

export async function registerWebhookSubscription(
  webhookUrl: string,
  type: 'booking' | 'message',
  action: 'entity_create' | 'entity_update',
): Promise<any> {
  const stored = loadToken();
  if (!stored?.access_token) {
    throw new Error('Webhook subscriptions require an OAuth access token — run scripts/ownerrez-auth.ts');
  }

  const res = await fetch(`${BASE}/v2/webhooksubscriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stored.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ webhook_url: webhookUrl, type, action }),
  });

  if (!res.ok) {
    throw new Error(`OwnerRez webhook subscription failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function deleteWebhookSubscription(id: number): Promise<void> {
  const stored = loadToken();
  if (!stored?.access_token) throw new Error('Webhook subscriptions require an OAuth access token');

  const res = await fetch(`${BASE}/v2/webhooksubscriptions/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${stored.access_token}`, 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`OwnerRez webhook delete failed: ${res.status} ${await res.text()}`);
  }
}
