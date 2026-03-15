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
 * Get upcoming reservations for a specific listing
 */
export async function getUpcomingReservations(listingId: number): Promise<Reservation[]> {
  const today = new Date().toISOString().split('T')[0];
  const result = await hostawayGet('/reservations', {
    listingMapId: String(listingId),
    arrivalDateStart: today,
    sortOrder: 'arrivalDate',
    limit: '50',
  });
  return result || [];
}

/**
 * Get all upcoming reservations across all listings
 */
export async function getAllUpcomingReservations(): Promise<Reservation[]> {
  const today = new Date().toISOString().split('T')[0];
  const result = await hostawayGet('/reservations', {
    arrivalDateStart: today,
    sortOrder: 'arrivalDate',
    limit: '100',
  });
  return result || [];
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

// Phrases from Brady's pool heat offer email that uniquely identify it.
// "gallons of propane" is the strongest signal — no other message would say this.
const OFFER_KEYWORDS = [
  'gallons of propane',
  'heat the pool for you',
  'pool heat',
  '$150 per day',
  '$125 per day',
  '$95 per day',
  '[pool heat offer]', // optional explicit tag Brady can add
];

/**
 * Scan a conversation for pool heat status.
 *
 * Logic:
 * 1. Find outbound (host) messages containing pool heat offer keywords
 * 2. If found, look for the guest's response after the offer
 * 3. Classify response as agreed / declined / pending / not_discussed
 */
export function scanMessagesForPoolHeat(
  messages: any[]
): 'agreed' | 'declined' | 'pending' | 'not_discussed' {
  // Sort messages by date ascending
  const sorted = [...messages].sort(
    (a, b) => new Date(a.insertedOn || a.createdAt).getTime() - new Date(b.insertedOn || b.createdAt).getTime()
  );

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

  if (!hostOfferedHeat) return 'not_discussed';

  // Look for guest responses after the pool heat offer
  const responsesAfter = sorted.slice(lastOfferIndex + 1).filter(
    m => m.isIncoming === 1 || m.senderType === 'guest'
  );

  if (responsesAfter.length === 0) return 'pending';

  // Check the first guest response(s) for agreement/disagreement
  const positiveSignals = [
    'yes', 'please', 'sounds good', 'go ahead', 'sure', 'absolutely',
    'that would be great', 'love that', "let's do it", 'we want', 'i want',
    'definitely', 'perfect', "we'd like", "i'd like", 'we would like',
    'would love', 'we\'ll take', 'i\'ll take', 'sign us up', 'count us in',
    'go for it', 'add it', 'add the heat', 'add pool heat', 'want the heat',
    'want pool heat', 'like to heat', 'like the pool heated',
  ];
  const negativeSignals = [
    'no thanks', 'no thank', "don't need", 'do not need', 'not necessary',
    'pass on', 'skip', 'decline', "won't need", 'will not need',
    'not interested', 'no pool heat', "don't want", 'do not want',
    'too expensive', 'not worth', "we'll pass", "i'll pass", 'no heat',
    'without heat', 'not this time',
  ];

  for (const resp of responsesAfter) {
    const body = (resp.body || '').toLowerCase();
    if (negativeSignals.some(kw => body.includes(kw))) return 'declined';
    if (positiveSignals.some(kw => body.includes(kw))) return 'agreed';
  }

  // Guest responded but couldn't classify — treat as pending (needs manual review)
  return 'pending';
}
