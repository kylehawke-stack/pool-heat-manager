import { config } from './config';

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const res = await fetch(`${config.hostaway.baseUrl}/accessTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.hostaway.clientId,
      client_secret: config.hostaway.clientSecret,
      scope: 'general',
    }),
  });

  if (!res.ok) {
    throw new Error(`Hostaway auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 3600) * 1000,
  };
  return cachedToken.token;
}

async function hostawayGet(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${config.hostaway.baseUrl}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Hostaway GET ${path} failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { result: any };
  return data.result;
}

export interface Reservation {
  id: number;
  listingMapId: number;
  channelId: number;
  guestName: string;
  guestEmail: string;
  arrivalDate: string; // YYYY-MM-DD
  departureDate: string;
  status: string;
}

/**
 * Get all upcoming reservations across all listings.
 * Filters client-side by listingMapId since the Hostaway API filter is unreliable.
 */
export async function getAllUpcomingReservations(listingIds: number[]): Promise<Reservation[]> {
  const today = new Date().toISOString().split('T')[0];
  const result = await hostawayGet('/reservations', {
    arrivalStartDate: today,
    sortOrder: 'arrivalDate',
    limit: '200',
  });

  // Client-side filter: only confirmed reservations for our pool properties
  // "modified" = confirmed booking. Exclude inquiry, cancelled, ownerStay, etc.
  return (result || []).filter((r: Reservation) =>
    listingIds.includes(r.listingMapId) && r.status === 'modified'
  );
}

/**
 * Get a single reservation by ID
 */
export async function getReservation(id: number): Promise<Reservation> {
  return hostawayGet(`/reservations/${id}`);
}

/**
 * Get conversation messages for a reservation to scan for pool heat discussion.
 */
export async function getConversationMessages(reservationId: number): Promise<any[]> {
  try {
    const conversations = await hostawayGet('/conversations', {
      reservationId: String(reservationId),
    });
    if (!conversations || conversations.length === 0) return [];

    const conversationId = conversations[0].id;
    const messages = await hostawayGet(`/conversations/${conversationId}/messages`);
    return messages || [];
  } catch {
    return [];
  }
}

// "gallons of propane" is the primary signal — uniquely identifies Brady's pool heat offer.
const OFFER_KEYWORDS = [
  'gallons of propane',
  '[pool heat offer]',
];

const POSITIVE_SIGNALS = [
  'yes', 'please', 'sounds good', 'go ahead', 'sure', 'absolutely',
  'that would be great', 'love that', "let's do it", 'we want', 'i want',
  'definitely', 'perfect', "we'd like", "i'd like", 'we would like',
  'would love', "we'll take", "i'll take", 'sign us up', 'count us in',
  'go for it', 'add it', 'add the heat', 'add pool heat', 'want the heat',
  'want pool heat', 'like to heat', 'like the pool heated', 'pool heated',
  'no problem', "that's fair",
];

const NEGATIVE_SIGNALS = [
  'no thanks', 'no thank', "don't need", 'do not need', 'not necessary',
  'pass on', 'skip the heat', 'decline', "won't need", 'will not need',
  'not interested', 'no pool heat', "don't want", 'do not want',
  'too expensive', 'not worth', "we'll pass", "i'll pass", 'no heat',
  'without heat', 'not this time',
];

export interface PoolHeatResult {
  status: 'agreed' | 'declined' | 'pending' | 'not_discussed';
  /** Number of days of heat requested. null = full stay, number = partial. */
  heatDays: number | null;
}

/**
 * Parse number of heat days from guest messages after the offer.
 * Only checks GUEST responses — ignores host messages (which contain
 * "two day minimum" in the offer template that would false-match).
 *
 * Looks for patterns like "2 days", "3 nights", "just the first 2 days", "only 3 days".
 * Returns null for full stay ("the week", "whole stay", or no specific count mentioned).
 */
function parseHeatDays(messages: any[], offerIndex: number): number | null {
  // Only look at guest messages after the offer
  const guestResponsesAfterOffer = messages.slice(offerIndex + 1).filter(
    (m: any) => m.isIncoming === 1 || m.senderType === 'guest'
  );

  for (const msg of guestResponsesAfterOffer) {
    const body = (msg.body || '').toLowerCase();

    // Full stay indicators
    if (/\b(the week|full week|whole stay|whole week|all \d+ days|entire stay|for the week)\b/.test(body)) {
      return null; // Full stay
    }

    // Specific day count: "2 days", "3 nights", "just 2 days", "only 3 days"
    const dayMatch = body.match(/\b(?:just|only)?\s*(\d+)\s*(?:days?|nights?)\b/);
    if (dayMatch) {
      const days = parseInt(dayMatch[1], 10);
      if (days >= 1 && days <= 14) return days;
    }

    // Word-number patterns: "two days", "three nights"
    const wordNums: Record<string, number> = {
      'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
      'six': 6, 'seven': 7,
    };
    const wordMatch = body.match(/\b(one|two|three|four|five|six|seven)\s+(?:days?|nights?)\b/);
    if (wordMatch && wordNums[wordMatch[1]]) {
      return wordNums[wordMatch[1]];
    }
  }

  return null; // Default: full stay
}

/**
 * Scan a conversation for pool heat status and duration.
 *
 * Logic:
 * 1. Find outbound (host) messages containing "gallons of propane" (the offer)
 * 2. Look for guest response after the offer
 * 3. Classify as agreed/declined/pending
 * 4. If agreed, parse how many days of heat they want
 */
export function scanMessagesForPoolHeat(messages: any[]): PoolHeatResult {
  // Use API return order (chronological). Sorting by insertedOn is unreliable
  // because bulk-imported conversations can have identical timestamps.
  // Fall back to ID ascending only if timestamps differ meaningfully.
  const sorted = [...messages];
  const timestamps = sorted.map(m => new Date(m.insertedOn || m.createdAt || 0).getTime());
  const allSameTimestamp = timestamps.every(t => Math.abs(t - timestamps[0]) < 5000);
  if (!allSameTimestamp) {
    sorted.sort((a, b) =>
      new Date(a.insertedOn || a.createdAt).getTime() - new Date(b.insertedOn || b.createdAt).getTime()
    );
  }
  // If all timestamps are within 5 seconds, trust the API's return order

  let hostOfferedHeat = false;
  let lastOfferIndex = -1;

  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i];
    const body = (msg.body || '').toLowerCase();
    const isFromHost = msg.isIncoming === 0 || msg.senderType === 'host';

    if (isFromHost && OFFER_KEYWORDS.some(kw => body.includes(kw))) {
      hostOfferedHeat = true;
      lastOfferIndex = i;
    }
  }

  if (!hostOfferedHeat) return { status: 'not_discussed', heatDays: null };

  // Look for guest responses after the pool heat offer
  const responsesAfter = sorted.slice(lastOfferIndex + 1).filter(
    m => m.isIncoming === 1 || m.senderType === 'guest'
  );

  if (responsesAfter.length === 0) return { status: 'pending', heatDays: null };

  for (const resp of responsesAfter) {
    const body = (resp.body || '').toLowerCase();
    if (NEGATIVE_SIGNALS.some(kw => body.includes(kw))) {
      return { status: 'declined', heatDays: null };
    }
    if (POSITIVE_SIGNALS.some(kw => body.includes(kw))) {
      const heatDays = parseHeatDays(sorted, lastOfferIndex);
      return { status: 'agreed', heatDays };
    }
  }

  // Guest responded but couldn't classify
  return { status: 'pending', heatDays: null };
}
