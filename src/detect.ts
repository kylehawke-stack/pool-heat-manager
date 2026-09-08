/**
 * PMS-agnostic pool-heat agreement detection.
 *
 * Moved out of hostaway.ts unchanged (2026-09-08) so the same signal lists and
 * parsing serve both the retired Hostaway client and the OwnerRez one. The
 * message shape this module consumes is a small normalised record — each PMS
 * client is responsible for mapping its own payload onto it.
 */

/** Normalised message record. Both PMS clients map onto this shape. */
export interface NormalisedMessage {
  body: string;
  /** 1 = from the guest, 0 = from the host/system. */
  isIncoming: 0 | 1;
  senderType: 'guest' | 'host';
  /** ISO timestamp. */
  insertedOn: string;
}

// "gallons of propane" is the primary signal — uniquely identifies Brady's pool heat offer.
// It survives verbatim in the OwnerRez snippets /poolheatabb and /poolheatvrbo.
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
  'ok with', 'okay with', 'fine with', // "we are ok with the heating charge"
  'looks good', 'pricing breakdown', 'payment has been sent',
  'love for the pool', 'would love for the pool',
  'if it\'s heated', // "if it's heated first thing Friday"
  'avail the heated', 'will avail', 'gonna avail', // "we'll gonna avail the heated pool"
  'send the payment', 'send payment link', 'payment link for', // "send the payment link for two days"
  'send the link', 'send me the link', // variants of payment link ask
  'heated pool for', 'heat the pool for', // "heated pool for the whole stay"
];

const NEGATIVE_SIGNALS = [
  'no thanks', 'no thank', "don't need", 'do not need', 'not necessary',
  'pass on', 'skip the heat', 'decline', "won't need", 'will not need',
  'not interested', 'no pool heat', "don't want", 'do not want',
  'too expensive', 'not worth', "we'll pass", "i'll pass", 'no heat',
  'without heat', 'not this time',
  // Explicit "decided against it" phrasings. Without these, "we have decided
  // not to heat the pool" matched NO negative ('not to heat' != 'no heat') and
  // then tripped the 'please' POSITIVE signal from an unrelated sentence in the
  // same message ("Please let us know about early check-in") → false 'agreed'.
  // (Ana Ness / Elmwood, res 53236431, near-miss 2026-05-29.)
  'not to heat', 'decided not to', 'not heating', 'decided against',
  "won't be heating", 'rather not heat', 'no longer want', 'changed our mind',
];

/**
 * Deterministic host-side "the guest already said yes" signals, checked before
 * the fuzzy guest-reply parse. Brady only sends these AFTER a verbal agreement.
 *
 * Airbnb: he raises a resolution-centre payment request.
 * Vrbo / direct: the OwnerRez snippet promises "I can charge your credit card
 * on file", so the confirmation wording differs — hence the extra phrases.
 */
const HOST_PAYMENT_SIGNALS = [
  'airbnb.com/resolutions',
  'sent the payment request',
  'charged your card',
  'charged the card on file',
  'charged your credit card',
  'card on file has been charged',
];

/**
 * A guest raising pool heat themselves, with no host offer in the thread.
 *
 * The classifier is offer-gated: it locates the "gallons of propane" template
 * and only then reads replies after it. That structurally cannot see a guest
 * who asks first — and it cannot see an exchange where the host answered
 * off-template ("What did you decide regarding pool heat? $375 for 3 nights").
 * Both happened live: Vasiliki McDonough (Elmwood 9/18) wrote "We would love
 * the pool heated" on 2026-09-02, and the reply that followed never contained
 * the template phrase, so the whole conversation classified `not_discussed`.
 *
 * Matching one of these NEVER schedules heat. It can only return `pending`,
 * which routes to Brady's confirm email. Auto-scheduling still requires the
 * real offer template plus a positive reply — a loose match must not be able
 * to fire a heater (cf. the Ana Ness false-positive, 2026-05-29).
 *
 * Deliberately requires heat/warm NEAR pool. "a pool day & hot tub" (Rosemary
 * Jones, Boho 9/17) is trip chatter, not a request, and must not match.
 */
const GUEST_HEAT_REQUEST: RegExp[] = [
  /pool[^.!?]{0,25}heat/i,
  /heat[^.!?]{0,25}pool/i,
  /heated pool/i,
  /pool[^.!?]{0,15}warm/i,
  /warm[^.!?]{0,15}pool/i,
  // Spanish — Brady/Kyle host Spanish-speaking guests (Alba Portillo, Boho).
  /climatizador/i,
  /climatiz[a-zé]*[^.!?]{0,15}piscina/i,
  /piscina[^.!?]{0,15}climatiz/i,
  /calentar[^.!?]{0,15}piscina/i,
  /piscina[^.!?]{0,15}(?:caliente|temperada|climatizada)/i,
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
function parseHeatDays(messages: NormalisedMessage[], offerIndex: number): number | null {
  // Only look at guest messages after the offer
  const guestResponsesAfterOffer = messages.slice(offerIndex + 1).filter(
    (m) => m.isIncoming === 1 || m.senderType === 'guest'
  );

  for (const msg of guestResponsesAfterOffer) {
    const body = (msg.body || '').toLowerCase();

    // Full stay indicators
    if (/\b(the week|full week|whole stay|whole week|all \d+ days|entire stay|for the week)\b/.test(body)) {
      return null; // Full stay
    }

    // Day-of-week counting: "Friday and Saturday" = 2 days, "Wed to Fri" = 3 days
    const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
                       'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const dayAbbrevToNum: Record<string, number> = {
      'monday': 1, 'mon': 1, 'tuesday': 2, 'tue': 2, 'wednesday': 3, 'wed': 3,
      'thursday': 4, 'thu': 4, 'friday': 5, 'fri': 5, 'saturday': 6, 'sat': 6, 'sunday': 7, 'sun': 7,
    };
    // "X and Y" pattern: "Friday and Saturday" = 2 days
    // Allow optional words between connector and second day name (e.g. "friday and all saturday")
    const andPattern = new RegExp(`\\b(${dayNames.join('|')})\\s+(?:and|&|through|thru|to)\\s+(?:\\w+\\s+)?(${dayNames.join('|')})\\b`);
    const andMatch = body.match(andPattern);
    if (andMatch) {
      const from = dayAbbrevToNum[andMatch[1]];
      const to = dayAbbrevToNum[andMatch[2]];
      if (from && to) {
        const span = to >= from ? to - from + 1 : 7 - from + to + 1;
        if (span >= 1 && span <= 7) return span;
      }
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
export function scanMessagesForPoolHeat(messages: NormalisedMessage[]): PoolHeatResult {
  // Use API return order (chronological). Sorting by insertedOn is unreliable
  // because bulk-imported conversations can have identical timestamps.
  // Fall back to ID ascending only if timestamps differ meaningfully.
  const sorted = [...messages];
  const timestamps = sorted.map(m => new Date(m.insertedOn || 0).getTime());
  const allSameTimestamp = timestamps.every(t => Math.abs(t - timestamps[0]) < 5000);
  if (!allSameTimestamp) {
    sorted.sort((a, b) =>
      new Date(a.insertedOn).getTime() - new Date(b.insertedOn).getTime()
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

  if (!hostOfferedHeat) {
    // No offer template in the thread. Before concluding nobody discussed heat,
    // check whether the GUEST raised it — see GUEST_HEAT_REQUEST. This returns
    // `pending` (→ Brady's confirm email) and never `agreed`: without the offer
    // we have no quoted price and no reply to parse days from, so a human
    // decides. A negative reply still wins, so a guest who asks and then backs
    // out ("we decided not to heat after all") is not sent for confirmation.
    const guestRaisedIt = sorted.some(m => {
      const isGuest = m.isIncoming === 1 || m.senderType === 'guest';
      return isGuest && GUEST_HEAT_REQUEST.some(rx => rx.test(m.body || ''));
    });
    if (!guestRaisedIt) return { status: 'not_discussed', heatDays: null };

    const guestDeclined = sorted.some(m => {
      const isGuest = m.isIncoming === 1 || m.senderType === 'guest';
      return isGuest && NEGATIVE_SIGNALS.some(kw => (m.body || '').toLowerCase().includes(kw));
    });
    return { status: guestDeclined ? 'declined' : 'pending', heatDays: null };
  }

  // PRIMARY SIGNAL: host confirmed payment after the offer. Kyle only sends
  // these AFTER a guest has already verbally agreed, so this is deterministic.
  const hostMessagesAfter = sorted.slice(lastOfferIndex + 1).filter(
    m => m.isIncoming === 0 || m.senderType === 'host'
  );
  for (const msg of hostMessagesAfter) {
    const body = (msg.body || '').toLowerCase();
    if (HOST_PAYMENT_SIGNALS.some(kw => body.includes(kw))) {
      const heatDays = parseHeatDays(sorted, lastOfferIndex);
      return { status: 'agreed', heatDays };
    }
  }

  // Look for guest responses after the pool heat offer (fallback path)
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
