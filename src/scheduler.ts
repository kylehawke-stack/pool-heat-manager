import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { properties, PropertyConfig } from './config';
import { getAllUpcomingReservations, getConversationMessages, getReservation, getBookingIdForThread, MessagingUnavailableError, hasOAuth, Reservation } from './ownerrez';
import { scanMessagesForPoolHeat, PoolHeatResult, NormalisedMessage } from './detect';
import { getPoolStatus, setPoolHeat, turnOffPoolHeat, updatePoolScheduleHeatOn, updatePoolScheduleHeatOff } from './screenlogic';
import { calculateHeaterStartTime } from './weather';
import { alertHeaterAction, alertManualReminder, sendAlert } from './alerts';
import { getTargetTempForStay } from './pricing';
import { sendConfirmRequest } from './confirm';
import { renderSmartTimingHtml } from './override';

interface ScheduledEvent {
  reservationId: number;
  propertyName: string;
  // SANITY_READ = pre-ON cold-pool check (panic-pull ON forward if pool is too
  // cold to reach target by check-in at conservative rate). Independent of
  // Open-Meteo, so it survives weather-API outages that could break RECALCULATE.
  // VERIFY = re-read the controller VERIFY_DELAY_MS after an ON/OFF. A readback
  // at command time is not proof: on 2026-09-14 Elmwood read back HEATER, the
  // email said SUCCESS, and the mode was OFF again within ~7 minutes.
  action: 'ON' | 'OFF' | 'RECALCULATE' | 'SANITY_READ' | 'VERIFY';
  scheduledTime: Date;
  guestName: string;
  executed: boolean;
  targetTemp: number;
  heatDays?: number | null;
  // VERIFY only: which command is being checked, when it ran (ISO — a later
  // ON/OFF at the same property supersedes the check), which round this is,
  // and whether the burner was already firing when the command was sent.
  verifyOf?: 'ON' | 'OFF';
  verifyActionTime?: string;
  verifyRound?: number;
  firingAtAction?: boolean;
  // Retry tracking — incremented on each handler attempt; if the handler throws
  // and attempts < MAX_EXECUTOR_ATTEMPTS the event stays unexecuted so the
  // next executor tick (every minute) re-fires it. Prevents transient API
  // outages from silently dropping ON events (root cause of the 2026-05-02
  // Pamela Taylor cold-pool incident — Open-Meteo 502 with no retry).
  attempts?: number;
}

const MAX_EXECUTOR_ATTEMPTS = 5;

// Persistence: PM2 restarts (deploys, OOM, crashes) used to wipe the in-memory
// schedule, silently dropping pending ON events. Now we round-trip to disk on
// every mutation. File path overridable for tests; default lives next to the
// repo on the prod box.
const SCHEDULE_PERSIST_PATH =
  process.env.SCHEDULE_PERSIST_PATH || path.join(process.cwd(), 'data', 'schedule.json');

function persistEvents(): void {
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_PERSIST_PATH), { recursive: true });
    const serialized = scheduledEvents.map(e => ({
      ...e,
      scheduledTime: e.scheduledTime.toISOString(),
    }));
    fs.writeFileSync(SCHEDULE_PERSIST_PATH, JSON.stringify(serialized, null, 2));
  } catch (err: any) {
    console.error(`[Persist] Failed to write ${SCHEDULE_PERSIST_PATH}: ${err.message}`);
  }
}

function loadEvents(): number {
  try {
    if (!fs.existsSync(SCHEDULE_PERSIST_PATH)) return 0;
    const raw = fs.readFileSync(SCHEDULE_PERSIST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Array<Omit<ScheduledEvent, 'scheduledTime'> & { scheduledTime: string }>;
    scheduledEvents.length = 0;
    for (const e of parsed) {
      scheduledEvents.push({ ...e, scheduledTime: new Date(e.scheduledTime) });
    }
    return scheduledEvents.length;
  } catch (err: any) {
    console.error(`[Persist] Failed to load ${SCHEDULE_PERSIST_PATH}: ${err.message}`);
    return 0;
  }
}

// Confirm state: pendingConfirms / declinedReservations.
// Same persistence rationale as the schedule — PM2 restarts no longer wipe
// "Brady said NO to this guest" or "guest is still thinking" memory.
const CONFIRM_STATE_PATH =
  process.env.CONFIRM_STATE_PATH || path.join(process.cwd(), 'data', 'confirm-state.json');

function persistConfirmState(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIRM_STATE_PATH), { recursive: true });
    const data = {
      pendingConfirms: Array.from(pendingConfirms),
      declinedReservations: Array.from(declinedReservations),
      // When Brady was last emailed about each reservation. Drives the re-nudge
      // (see requestConfirmation) — without it, a restart would forget that we
      // already asked and either spam or, worse, go quiet on a guest's yes.
      confirmAskedAt: Object.fromEntries(
        Array.from(confirmAskedAt.entries()).map(([id, ms]) => [String(id), new Date(ms).toISOString()])
      ),
    };
    fs.writeFileSync(CONFIRM_STATE_PATH, JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error(`[Persist] Failed to write ${CONFIRM_STATE_PATH}: ${err.message}`);
  }
}

function loadConfirmState(): { pending: number; declined: number } {
  try {
    if (!fs.existsSync(CONFIRM_STATE_PATH)) return { pending: 0, declined: 0 };
    // `undecidedReservations` was dropped in the 2026-08-10 guest-messaging
    // removal; older state files still carry the key and are simply ignored.
    const data = JSON.parse(fs.readFileSync(CONFIRM_STATE_PATH, 'utf8')) as {
      pendingConfirms?: number[];
      declinedReservations?: number[];
      confirmAskedAt?: Record<string, string>;
    };
    pendingConfirms.clear();
    declinedReservations.clear();
    confirmAskedAt.clear();
    (data.pendingConfirms ?? []).forEach(id => pendingConfirms.add(id));
    (data.declinedReservations ?? []).forEach(id => declinedReservations.add(id));
    // State written before the re-nudge existed has no timestamps. Those
    // reservations get one reminder on the next scan (any guest message beats
    // an unknown ask time), which is the right answer for a backlog that has
    // been sitting unanswered.
    for (const [id, iso] of Object.entries(data.confirmAskedAt ?? {})) {
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) confirmAskedAt.set(Number(id), ms);
    }
    return {
      pending: pendingConfirms.size,
      declined: declinedReservations.size,
    };
  } catch (err: any) {
    console.error(`[Persist] Failed to load ${CONFIRM_STATE_PATH}: ${err.message}`);
    return { pending: 0, declined: 0 };
  }
}

// In-memory schedule (persisted to disk would be better for production)
const scheduledEvents: ScheduledEvent[] = [];

/**
 * Add a scheduled event with dedup.
 * Considers two events "the same" when (reservationId, action) match AND the
 * scheduledTime is within 5 minutes. Prevents duplicates from racy scans.
 */
function addEvent(ev: ScheduledEvent): boolean {
  const FIVE_MIN = 5 * 60 * 1000;
  const dup = scheduledEvents.find(e =>
    e.reservationId === ev.reservationId &&
    e.action === ev.action &&
    Math.abs(e.scheduledTime.getTime() - ev.scheduledTime.getTime()) < FIVE_MIN
  );
  if (dup) {
    console.log(`[Dedup] Skipping duplicate ${ev.action} for reservation ${ev.reservationId} (${ev.guestName})`);
    return false;
  }
  scheduledEvents.push(ev);
  persistEvents();
  return true;
}

/**
 * Remove all unexecuted events of a given action for a reservation.
 *
 * Used when re-running smart timing (a fresh RECALCULATE may shift ON earlier
 * or later by hours, beyond the addEvent dedup window) or when a SANITY_READ
 * panic-pulls ON forward — we need to drop the stale future ON before adding
 * the new one.
 */
function removeUnexecutedEvents(reservationId: number, action: ScheduledEvent['action']): number {
  let removed = 0;
  for (let i = scheduledEvents.length - 1; i >= 0; i--) {
    const e = scheduledEvents[i];
    if (e.reservationId === reservationId && e.action === action && !e.executed) {
      scheduledEvents.splice(i, 1);
      removed++;
    }
  }
  if (removed > 0) persistEvents();
  return removed;
}

/**
 * Schedule recurring RECALCULATEs at fixed offsets BEFORE the planned ON.
 *
 * Each refresh re-reads pool temp + forecast and reschedules ON. The 2026-05-08
 * Karen Hunter incident locked in a noon ON two days ahead and never
 * re-evaluated when overnight cooling dropped the pool 11°F. This guarantees
 * the schedule keeps tracking real conditions as ON approaches.
 *
 * Past offsets are silently skipped (e.g. on an in-window agreement detected
 * <12h before ON, only T-6 may fire).
 */
function scheduleRecurringRecalcs(
  reservation: Reservation,
  property: PropertyConfig,
  targetTemp: number,
  heatDays: number | null,
  onStartTime: Date
): number {
  removeUnexecutedEvents(reservation.id, 'RECALCULATE');
  const now = new Date();
  const offsetsBeforeOn = [24, 12]; // hours
  let added = 0;
  for (const off of offsetsBeforeOn) {
    const t = new Date(onStartTime.getTime() - off * 60 * 60 * 1000);
    if (t <= now || t >= onStartTime) continue;
    const ok = addEvent({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'RECALCULATE',
      scheduledTime: t,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
      heatDays,
    });
    if (ok) added++;
  }
  return added;
}

/**
 * Schedule a SANITY_READ 6h before the planned ON.
 *
 * Independent of Open-Meteo: only reads pool temp and applies a conservative
 * 0.5°F/hr planning rate. If the pool can't reach target by check-in even at
 * full power, we panic-pull ON forward to NOW and fire ⚠️ Cold-pool override.
 *
 * This is belt-and-suspenders alongside RECALCULATE — survives weather-API
 * outages that could otherwise leave a stale ON in place.
 */
function scheduleSanityRead(
  reservation: Reservation,
  property: PropertyConfig,
  targetTemp: number,
  heatDays: number | null,
  onStartTime: Date
): boolean {
  removeUnexecutedEvents(reservation.id, 'SANITY_READ');
  const now = new Date();
  const t = new Date(onStartTime.getTime() - 6 * 60 * 60 * 1000);
  if (t <= now || t >= onStartTime) return false;
  return addEvent({
    reservationId: reservation.id,
    propertyName: property.name,
    action: 'SANITY_READ',
    scheduledTime: t,
    guestName: reservation.guestName,
    executed: false,
    targetTemp,
    heatDays,
  });
}

/**
 * Bootstrap backfill: for every unexecuted future ON, ensure the T-24/T-12
 * RECALCULATE + T-6 SANITY_READ safety events exist.
 *
 * Why this is needed: in-flight reservations whose ON was scheduled BEFORE the
 * 2026-05-08 safety-rails rollout don't have these events on disk. Without
 * backfill they'd run with the old "decide once, never re-evaluate" semantics
 * — exactly the failure mode that caused the cold-pool incident.
 *
 * Idempotent — `scheduleRecurringRecalcs` / `scheduleSanityRead` clear any
 * prior unexecuted versions before re-adding, so multiple boots don't dupe.
 *
 * Past offsets are skipped (e.g. ON in 4h → all of T-24/T-12/T-6 are past →
 * nothing added; that reservation is too close to ON for safety rails to help
 * and a fresh smart-timing run would just re-pick "start now" anyway).
 */
async function bootstrapBackfillSafetyEvents(): Promise<{
  recalcsAdded: number;
  sanityAdded: number;
  reservationsCovered: number;
}> {
  const now = new Date();
  const futureOns = scheduledEvents.filter(
    e => e.action === 'ON' && !e.executed && e.scheduledTime > now
  );

  let recalcsAdded = 0;
  let sanityAdded = 0;
  const seen = new Set<number>();

  for (const onEvent of futureOns) {
    if (seen.has(onEvent.reservationId)) continue;
    seen.add(onEvent.reservationId);

    const property = properties.find(p => p.name === onEvent.propertyName);
    if (!property) continue;

    let reservation: Reservation;
    try {
      reservation = await getReservation(onEvent.reservationId);
    } catch (err: any) {
      console.error(`[Bootstrap] Failed to fetch reservation ${onEvent.reservationId} (${onEvent.guestName}): ${err.message}`);
      continue;
    }

    // heatDays wasn't carried on legacy ON events. The existing OFF event sits
    // unchanged on disk (scheduleSmartTiming only adds OFF if absent), so a
    // null heatDays here can't shift the off time. Worst case: a partial-stay
    // alert email reads "full stay" — cosmetic only.
    const heatDays = onEvent.heatDays ?? null;

    recalcsAdded += scheduleRecurringRecalcs(
      reservation, property, onEvent.targetTemp, heatDays, onEvent.scheduledTime
    );
    if (scheduleSanityRead(reservation, property, onEvent.targetTemp, heatDays, onEvent.scheduledTime)) {
      sanityAdded++;
    }
  }

  return { recalcsAdded, sanityAdded, reservationsCovered: seen.size };
}

/** One-time sweep of the in-memory events to remove any existing dupes. */
export function dedupeExistingEvents(): number {
  const FIVE_MIN = 5 * 60 * 1000;
  const seen: ScheduledEvent[] = [];
  let removed = 0;
  for (const e of scheduledEvents) {
    const dup = seen.find(s =>
      s.reservationId === e.reservationId &&
      s.action === e.action &&
      Math.abs(s.scheduledTime.getTime() - e.scheduledTime.getTime()) < FIVE_MIN
    );
    if (dup) { removed++; continue; }
    seen.push(e);
  }
  scheduledEvents.length = 0;
  scheduledEvents.push(...seen);
  if (removed > 0) persistEvents();
  return removed;
}

/** Force a reservation into "agreed" state (used by /confirm email callback). */
export async function forceAgreement(reservationId: number, heatDays: number | null): Promise<boolean> {
  const reservation = await getReservation(reservationId);
  const property = getPropertyForListing(reservation.listingMapId);
  if (!property) return false;
  await scheduleForReservation(reservation, property, { status: 'agreed', heatDays });
  pendingConfirms.delete(reservationId);
  declinedReservations.delete(reservationId);
  confirmAskedAt.delete(reservationId);
  persistConfirmState();
  return true;
}

/** Mark a reservation as declined (used by /confirm NO). */
export function markDeclined(reservationId: number): void {
  pendingConfirms.delete(reservationId);
  declinedReservations.add(reservationId);
  confirmAskedAt.delete(reservationId);
  persistConfirmState();
}

/**
 * Mark a reservation as "guest undecided" (used by /confirm UNDECIDED).
 * Purely a snooze: stays in pendingConfirms so Brady doesn't get re-emailed
 * every scan. The system never contacts the guest — following up is Brady's
 * call (see the 2026-08-10 removal of guest messaging).
 *
 * The snooze silences repeat scans, NOT the guest: stamping `confirmAskedAt` to
 * now means the next thing the guest says still re-opens the ask. That is the
 * point of snoozing an undecided guest — you want to hear when they decide.
 */
export function markUndecided(reservationId: number): void {
  pendingConfirms.add(reservationId);
  declinedReservations.delete(reservationId);
  confirmAskedAt.set(reservationId, Date.now());
  persistConfirmState();
}

/**
 * Push the future heater-ON event for a reservation later by `hours`.
 * Used by the /delay-on email override link.
 *
 * - Anchor is the CURRENT pending ON time (so two clicks of "Delay 12h" =
 *   24h total, not 12h).
 * - Capped at `checkIn − 2h` so we never delay past the safety buffer the
 *   smart-timing model itself enforces.
 * - Rebuilds the T-24/T-12 RECALCULATE and T-6 SANITY_READ staircase relative
 *   to the new ON, so the safety rails stay aligned.
 * - Sends a confirmation alert (text + plain — no override buttons on the
 *   confirmation, to avoid recursive override chains).
 */
export async function delayHeaterOn(
  reservationId: number,
  hours: number,
): Promise<{ ok: boolean; message: string }> {
  const now = new Date();
  const futureOn = scheduledEvents.find(
    e => e.reservationId === reservationId && e.action === 'ON' && !e.executed && e.scheduledTime > now,
  );
  if (!futureOn) {
    return { ok: false, message: `No pending heater ON event for reservation ${reservationId}.` };
  }
  const property = properties.find(p => p.name === futureOn.propertyName);
  if (!property) return { ok: false, message: `Unknown property: ${futureOn.propertyName}` };

  let reservation: Reservation;
  try {
    reservation = await getReservation(reservationId);
  } catch (err: any) {
    return { ok: false, message: `Could not load reservation: ${err.message}` };
  }

  const checkIn = zonedDate(reservation.arrivalDate, property.checkInHour, 0, property.timezone);
  const minBufferMs = 2 * 60 * 60 * 1000;
  const maxAllowed = new Date(checkIn.getTime() - minBufferMs);
  const proposed = new Date(futureOn.scheduledTime.getTime() + hours * 60 * 60 * 1000);
  const clamped = proposed > maxAllowed;
  const newOn = clamped ? maxAllowed : proposed;

  if (newOn.getTime() <= now.getTime()) {
    return { ok: false, message: 'Delay would push ON into the past or no usable window remains before check-in.' };
  }

  const oldOn = futureOn.scheduledTime;
  const heatDays = futureOn.heatDays ?? null;
  const targetTemp = futureOn.targetTemp;
  const guestName = futureOn.guestName;

  removeUnexecutedEvents(reservationId, 'ON');
  addEvent({
    reservationId,
    propertyName: property.name,
    action: 'ON',
    scheduledTime: newOn,
    guestName,
    executed: false,
    targetTemp,
    heatDays,
  });

  scheduleRecurringRecalcs(reservation, property, targetTemp, heatDays, newOn);
  scheduleSanityRead(reservation, property, targetTemp, heatDays, newOn);

  const fmt = (d: Date) => d.toLocaleString('en-US', { timeZone: property.timezone });
  const hoursToCheckIn = (checkIn.getTime() - newOn.getTime()) / (1000 * 60 * 60);
  console.log(
    `[Override] delayHeaterOn r=${reservationId} (${guestName} / ${property.name}) ` +
    `requested=+${hours}h applied=${clamped ? 'clamped' : 'as-requested'} ` +
    `oldOn=${oldOn.toISOString()} newOn=${newOn.toISOString()} ` +
    `hoursToCheckInAfter=${hoursToCheckIn.toFixed(1)}`,
  );

  await sendAlert(
    clamped ? 'warning' : 'info',
    `Heater ON delayed — ${property.name}`,
    [
      `Guest: ${guestName}`,
      `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
      `Target: ${targetTemp}°F`,
      `Requested delay: +${hours}h${clamped ? ' (clamped — see below)' : ''}`,
      `Old heater ON: ${fmt(oldOn)}`,
      `New heater ON: ${fmt(newOn)}`,
      `Check-in: ${fmt(checkIn)} (${hoursToCheckIn.toFixed(1)}h after new ON)`,
      ``,
      `Safety re-checks rescheduled: T-24h + T-12h RECALCULATE, T-6h SANITY_READ.`,
      clamped
        ? `Note: requested delay would have left less than 2h before check-in; clamped to check-in − 2h.`
        : ``,
    ].filter(Boolean).join('\n'),
  );

  return { ok: true, message: `Heater ON delayed to ${fmt(newOn)} (${clamped ? 'clamped' : 'as requested'}).` };
}

// Tracks reservations we've already emailed a confirm for, so we don't spam.
export const pendingConfirms = new Set<number>();
// Reservations Brady said NO to.
export const declinedReservations = new Set<number>();
// Epoch ms of the last confirm email per reservation. A guest message newer than
// this is unanswered news, and re-opens the ask (see requestConfirmation).
export const confirmAskedAt = new Map<number, number>();

function getPropertyForListing(listingId: number): PropertyConfig | undefined {
  return properties.find(p => p.ownerrezPropertyId === listingId);
}

/**
 * Construct a Date representing a wall-clock time in a specific IANA timezone.
 *
 * JavaScript's `new Date('YYYY-MM-DDTHH:MM:SS')` parses the string in the server's
 * local timezone, which is UTC on the DigitalOcean droplet. That caused heater
 * actions to fire 4 hours early (e.g. "8 PM ET" becoming 20:00 UTC = 4 PM ET).
 * This helper uses Intl.DateTimeFormat to find the correct UTC offset, handling DST.
 */
function zonedDate(isoDate: string, hour: number, minute: number, timezone: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);

  // Build the wall-clock values as if they were UTC
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Ask Intl what wall-clock time that UTC instant represents in the target zone.
  // The difference between the target and actual is the offset to apply.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(asUtc));
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const shownAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));

  // shownAsUtc - asUtc = timezone offset (negative for zones west of UTC)
  // To represent the desired wall time, shift UTC by the opposite of that offset.
  return new Date(asUtc - (shownAsUtc - asUtc));
}

/**
 * Check if a reservation qualifies for pool heat by scanning messages.
 * Returns the scan result with status and heat days.
 */
async function checkReservationHeat(
  reservation: Reservation
): Promise<{ result: PoolHeatResult; messages: NormalisedMessage[] }> {
  // Deliberately NOT wrapped in a try/catch. A messaging failure must propagate:
  // swallowing it returns an empty conversation, which classifies as
  // 'not_discussed' and is indistinguishable from "the guest never asked for
  // heat" — a silent skip of a paid booking. Callers surface it as an alert.
  const messages = await getConversationMessages(reservation.id, reservation.threadIds);
  const result: PoolHeatResult = messages.length > 0
    ? scanMessagesForPoolHeat(messages)
    : { status: 'not_discussed', heatDays: null };
  // The thread comes back with the verdict so callers can reason about *when*
  // the guest last spoke (the re-nudge) and render a transcript, without a
  // second round trip to OwnerRez for the same messages.
  return { result, messages };
}

/** Epoch ms of the newest GUEST message in a thread, or null if there are none. */
function latestGuestMessageTime(messages: NormalisedMessage[]): number | null {
  let latest: number | null = null;
  for (const m of messages) {
    const isGuest = m.isIncoming === 1 || m.senderType === 'guest';
    if (!isGuest) continue;
    const ms = parseUtcTimestamp(m.insertedOn);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/**
 * OwnerRez `date_utc` is UTC but is not always suffixed with `Z`. A bare
 * `2026-09-09T13:26:47` would otherwise parse as server-local — the same class
 * of bug as the 2026-04-09 four-hour offset.
 */
function parseUtcTimestamp(raw: string): number | null {
  if (!raw) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const ms = Date.parse(hasZone ? raw : `${raw}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** At most one confirm email per reservation per hour, however chatty the guest. */
export const RENUDGE_COOLDOWN_MS = 60 * 60 * 1000;

export type ConfirmDecision =
  | 'send'
  | 'remind'
  | 'skip-declined'
  | 'skip-scheduled'
  | 'skip-nothing-new'
  | 'skip-cooldown';

/**
 * Pure decision for "should Brady be emailed about this booking right now?".
 * Split out from the I/O so every branch is testable without a live thread.
 */
export function decideConfirmAction(input: {
  declined: boolean;
  /** Heat is already on the calendar for this booking — the question is settled. */
  scheduled: boolean;
  alreadyAsked: boolean;
  /** Epoch ms of the last confirm email; 0/undefined = never asked. */
  askedAt: number;
  /** Epoch ms of the newest guest message, or null if the guest never wrote. */
  latestGuestMs: number | null;
  now: number;
}): ConfirmDecision {
  if (input.declined) return 'skip-declined';
  // A thread that reads `pending` reads `pending` forever — the offer template
  // is never going to appear retroactively. Without this guard, clicking YES
  // removed the booking from pendingConfirms and the very next scan asked
  // again, and again every 4 hours. Seen live 2026-09-09 16:00 and 16:32 on
  // Vasiliki McDonough, minutes after her heat was scheduled.
  if (input.scheduled) return 'skip-scheduled';
  if (!input.alreadyAsked) return 'send';
  if (input.latestGuestMs === null || input.latestGuestMs <= input.askedAt) return 'skip-nothing-new';
  if (input.now - input.askedAt < RENUDGE_COOLDOWN_MS) return 'skip-cooldown';
  return 'remind';
}

/**
 * Ask Brady to classify an ambiguous conversation — and ask AGAIN when the guest
 * has said something new since the last ask.
 *
 * The old rule was "one email per reservation, ever", which went wrong on
 * 2026-09-09: Vasiliki McDonough was already `pending` from a 9/2 "we would love
 * the pool heated", so when she wrote "We want the pool. :)" — the actual yes,
 * nine days before check-in — the system classified it `pending`, saw it had
 * already asked, and said nothing. Nothing was scheduled and no one was told.
 *
 * A `pending` classification can never become `agreed` on its own (no offer
 * template means no quoted price and no days to parse), so the confirm email is
 * the ONLY path to heat. Sending it once and going quiet makes a missed click
 * permanent.
 *
 * Guardrails: only a GUEST message re-opens the ask (Brady replying to his own
 * guest must not email himself), never for a declined reservation, and at most
 * one nudge an hour.
 */
async function requestConfirmation(
  reservation: Reservation,
  property: PropertyConfig,
  messages: NormalisedMessage[]
): Promise<void> {
  const askedAt = confirmAskedAt.get(reservation.id) ?? 0;
  const decision = decideConfirmAction({
    declined: declinedReservations.has(reservation.id),
    scheduled: scheduledEvents.some(e => e.reservationId === reservation.id),
    alreadyAsked: pendingConfirms.has(reservation.id),
    askedAt,
    latestGuestMs: latestGuestMessageTime(messages),
    now: Date.now(),
  });

  if (decision === 'skip-scheduled') {
    // Self-heal: a booking that got scheduled while sitting in the pending
    // queue shouldn't stay there — it skews the digest and the SMS status.
    if (pendingConfirms.delete(reservation.id)) {
      confirmAskedAt.delete(reservation.id);
      persistConfirmState();
      console.log(`[Confirm] ${reservation.guestName} (${reservation.id}) is already scheduled — cleared from the pending queue.`);
    }
    return;
  }
  if (decision === 'skip-cooldown') {
    console.log(`[Confirm] ${reservation.guestName} (${reservation.id}) has new guest activity but was emailed <1h ago — holding.`);
    return;
  }
  if (decision !== 'send' && decision !== 'remind') return;
  const reminder = decision === 'remind';

  try {
    await sendConfirmRequest(reservation, property, { reminder, since: askedAt || undefined, messages });
    pendingConfirms.add(reservation.id);
    confirmAskedAt.set(reservation.id, Date.now());
    persistConfirmState();
  } catch (err: any) {
    console.error(`[Confirm] Failed to send ${reminder ? 'reminder' : 'request'} for ${reservation.id}: ${err.message}`);
  }
}

/**
 * Calculate the heater OFF time.
 * - If heatDays is null (full stay): 8 PM local on departure date
 * - If heatDays is a number: 8 PM local on (arrival + heatDays) days
 *
 * The heater turns off at 8 PM on the last paid heat day, not at checkout.
 *
 * Special case: for 1-night stays, the heater stays on until 23:59 on the arrival
 * day (through the guest's single night), rather than cutting off at 8 PM.
 */
function calculateHeaterOffTime(
  arrivalDate: string,
  departureDate: string,
  heatDays: number | null,
  timezone: string
): Date {
  // Use UTC parsing for date arithmetic so it's immune to server timezone.
  const parseDay = (d: string) => new Date(d + 'T00:00:00Z');
  const addDays = (d: Date, n: number) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; };
  const toIsoDay = (d: Date) => d.toISOString().split('T')[0];

  const arrDay = parseDay(arrivalDate);
  const depDay = parseDay(departureDate);
  const totalNights = Math.round((depDay.getTime() - arrDay.getTime()) / (1000 * 60 * 60 * 24));

  let lastHeatDate: string;

  if (heatDays === null) {
    // Full stay — last heat day is the night before departure
    lastHeatDate = toIsoDay(addDays(depDay, -1));
  } else {
    // Partial stay — heat for N days starting from arrival, capped at departure
    const lastPaidDay = addDays(arrDay, heatDays - 1);
    const lastStayDay = addDays(depDay, -1);
    lastHeatDate = toIsoDay(lastPaidDay > lastStayDay ? lastStayDay : lastPaidDay);
  }

  // 1-night stays: keep the heater on through the night (23:59 on arrival day)
  // instead of cutting off at 8 PM. Brady's rule: guest should get the pool
  // for their whole single evening.
  if (totalNights === 1) {
    return zonedDate(lastHeatDate, 23, 59, timezone);
  }

  // Otherwise: 8 PM local time on the last heat day.
  return zonedDate(lastHeatDate, 20, 0, timezone);
}

/**
 * Schedule heater on/off events for a reservation.
 */
async function scheduleForReservation(
  reservation: Reservation,
  property: PropertyConfig,
  heatResult: PoolHeatResult
) {
  // Don't schedule for reservations that have already departed
  const today = new Date().toISOString().split('T')[0];
  if (reservation.departureDate <= today) {
    console.log(`[Schedule] Skipping ${reservation.guestName} at ${property.name} — departure ${reservation.departureDate} is today or past`);
    return;
  }

  // Check if already scheduled (include executed events to prevent re-scheduling after restart)
  const existing = scheduledEvents.find(
    e => e.reservationId === reservation.id
  );
  if (existing) return;

  // Build check-in datetime in the property's local timezone.
  const checkIn = zonedDate(reservation.arrivalDate, property.checkInHour, 0, property.timezone);

  // Use season-based target temp — majority month of the stay, not just arrival date
  // e.g. March 31 check-in with April stay = 80°F (April rate)
  const targetTemp = getTargetTempForStay(reservation.arrivalDate, reservation.departureDate);

  // Calculate heater OFF: 8 PM on last paid heat day
  const heaterOffTime = calculateHeaterOffTime(
    reservation.arrivalDate,
    reservation.departureDate,
    heatResult.heatDays,
    property.timezone
  );

  const heatDaysLabel = heatResult.heatDays === null
    ? 'full stay'
    : `${heatResult.heatDays} day${heatResult.heatDays > 1 ? 's' : ''}`;

  const now = new Date();
  const hoursUntilCheckIn = (checkIn.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursUntilCheckIn <= 72) {
    // Check-in is within 72 hours — calculate smart timing NOW
    await scheduleSmartTiming(reservation, property, targetTemp, checkIn, heaterOffTime, heatDaysLabel, heatResult.heatDays);
  } else {
    // Check-in is far away — schedule a RECALCULATE event for 72h before check-in.
    // No pool temp reads, no weather API calls. Just note the agreement.
    const recalcTime = new Date(checkIn.getTime() - 72 * 60 * 60 * 1000);

    addEvent({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'RECALCULATE',
      scheduledTime: recalcTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
      heatDays: heatResult.heatDays,
    });

    // Always schedule heater OFF now (doesn't need smart timing)
    addEvent({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'OFF',
      scheduledTime: heaterOffTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
    });

    const autoLabel = property.poolSystem === 'screenlogic' ? 'auto' : 'reminder';
    await sendAlert('info',
      `Heat confirmed — ${property.name} (${autoLabel})`,
      [
        `Guest: ${reservation.guestName}`,
        `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
        `Heat duration: ${heatDaysLabel}`,
        `Target: ${targetTemp}°F`,
        `Heater OFF: ${heaterOffTime.toLocaleString('en-US', { timeZone: property.timezone })}`,
        `Smart timing will be calculated ${recalcTime.toLocaleString('en-US', { timeZone: property.timezone })} (72h before check-in).`,
      ].join('\n')
    );
  }
}

/**
 * Smart timing: read pool temp + weather forecast, schedule ON event.
 * Only called when check-in is within 72 hours.
 */
async function scheduleSmartTiming(
  reservation: Reservation,
  property: PropertyConfig,
  targetTemp: number,
  checkIn: Date,
  heaterOffTime: Date,
  heatDaysLabel: string,
  heatDays: number | null
) {
  if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
    let currentPoolTemp: number | null = null;
    try {
      const status = await getPoolStatus(property.screenlogicGateway);
      currentPoolTemp = status.poolTemp;
    } catch {
      // Can't read temp — will estimate from air temp
    }

    const {
      startTime, estimatedHours, avgAirTemp, clamped, shortfallHours,
      poolTempAtOn, poolTempAtCheckIn,
    } = await calculateHeaterStartTime(
      checkIn, targetTemp, currentPoolTemp, property.latitude, property.longitude
    );

    const gapF = currentPoolTemp != null ? Math.max(0, targetTemp - currentPoolTemp) : null;

    // Greppable single-line stdout summary of the simulation inputs/outputs.
    // Added after the 2026-05-08 Karen Hunter RCA: the alert email had this
    // info, but PM2 logs did NOT — making post-incident root-causing painful.
    console.log(
      `[Smart] ${reservation.guestName} (${property.name}): ` +
      `poolNow=${currentPoolTemp ?? 'unknown'}°F target=${targetTemp}°F ` +
      `gap=${gapF?.toFixed(1) ?? '?'}°F avgAir=${avgAirTemp.toFixed(1)}°F ` +
      `poolAtOn=${poolTempAtOn}°F poolAtCheckIn=${poolTempAtCheckIn}°F ` +
      `heatHours=${estimatedHours} ON=${startTime.toISOString()} ` +
      `checkIn=${checkIn.toISOString()} clamped=${clamped}`
    );

    // Replace any stale future ON for this reservation (a re-run RECALCULATE
    // can shift ON by hours — beyond addEvent's 5-min dedup window).
    removeUnexecutedEvents(reservation.id, 'ON');
    addEvent({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'ON',
      scheduledTime: startTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
    });

    // Only add OFF if not already scheduled
    const hasOff = scheduledEvents.some(
      e => e.reservationId === reservation.id && e.action === 'OFF' && !e.executed
    );
    if (!hasOff) {
      addEvent({
        reservationId: reservation.id,
        propertyName: property.name,
        action: 'OFF',
        scheduledTime: heaterOffTime,
        guestName: reservation.guestName,
        executed: false,
        targetTemp,
      });
    }

    // Schedule the next refresh + sanity check based on the new ON time.
    // Each call clears the prior set, so re-running smart-timing keeps the
    // T-24/T-12/T-6 staircase aligned with the current ON (not stale offsets).
    scheduleRecurringRecalcs(reservation, property, targetTemp, heatDays, startTime);
    scheduleSanityRead(reservation, property, targetTemp, heatDays, startTime);

    // Alert framing:
    //   clamped → "⚠️ Heat compressed" (sim says we won't make target)
    //   gap >8°F (but not clamped) → "⚠️ Large heat gap — verify"
    //   else → "Heat smart-timed" (informational)
    const largeGap = gapF != null && gapF > 8;
    const alertLevel = clamped || largeGap ? 'warning' : 'info';
    const alertSubject = clamped
      ? `⚠️ Heat compressed — ${property.name}`
      : largeGap
      ? `⚠️ Large heat gap — ${property.name}`
      : `Heat smart-timed — ${property.name}`;

    const hoursUntilCheckIn = (checkIn.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    const lines = [
      `Guest: ${reservation.guestName}`,
      `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
      `Heat duration: ${heatDaysLabel}`,
      `Target: ${targetTemp}°F`,
      `Current pool temp: ${currentPoolTemp ?? 'unknown'}°F`,
      `Modeled pool temp at heater-ON: ${poolTempAtOn}°F (after idle cooling)`,
      `Modeled pool temp at check-in: ${poolTempAtCheckIn}°F`,
      `Avg air temp forecast: ${avgAirTemp.toFixed(1)}°F`,
      `Heater ON: ${startTime.toLocaleString('en-US', { timeZone: property.timezone })} (${estimatedHours}h to heat)`,
      `Heater OFF: ${heaterOffTime.toLocaleString('en-US', { timeZone: property.timezone })}`,
    ];
    if (clamped) {
      lines.push('');
      lines.push(`⚠️ NOT ON TRACK: even starting now, modeled check-in temp is ${poolTempAtCheckIn}°F (target ${targetTemp}°F).`);
      lines.push(`Only ${hoursUntilCheckIn.toFixed(1)}h until check-in at ${checkIn.toLocaleString('en-US', { timeZone: property.timezone })}.`);
      if (gapF != null) {
        lines.push(`Need ${gapF.toFixed(1)}°F of heat-up; at conservative 0.5°F/hr that's ${(gapF / 0.5 + 2).toFixed(0)}h including buffer.`);
      }
      lines.push(`Estimated shortfall vs ideal: ${shortfallHours.toFixed(1)}h.`);
      lines.push(`Pool may not reach ${targetTemp}°F by guest arrival. Consider manual intervention.`);
    } else if (largeGap) {
      lines.push('');
      lines.push(`⚠️ LARGE GAP: pool is ${gapF!.toFixed(1)}°F below target. Sim says we'll make it, but verify the plan looks reasonable.`);
    }

    await sendAlert(
      alertLevel,
      alertSubject,
      lines.join('\n'),
      renderSmartTimingHtml(alertSubject, lines, reservation.id, alertLevel),
    );
  } else {
    // IntelliConnect — smart reminder timing
    let reminderTime: Date;
    try {
      const { startTime } = await calculateHeaterStartTime(
        checkIn, targetTemp, null, property.latitude, property.longitude
      );
      reminderTime = startTime;
    } catch {
      reminderTime = new Date(checkIn.getTime() - 24 * 60 * 60 * 1000);
    }

    addEvent({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'ON',
      scheduledTime: reminderTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
    });

    const hasOff = scheduledEvents.some(
      e => e.reservationId === reservation.id && e.action === 'OFF' && !e.executed
    );
    if (!hasOff) {
      addEvent({
        reservationId: reservation.id,
        propertyName: property.name,
        action: 'OFF',
        scheduledTime: heaterOffTime,
        guestName: reservation.guestName,
        executed: false,
        targetTemp,
      });
    }

    await sendAlert('info',
      `Heat reminder timed — ${property.name} (manual)`,
      [
        `Guest: ${reservation.guestName}`,
        `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
        `Heat duration: ${heatDaysLabel}`,
        `Target: ${targetTemp}°F`,
        `Reminder ON: ${reminderTime.toLocaleString('en-US', { timeZone: property.timezone })}`,
        `Reminder OFF: ${heaterOffTime.toLocaleString('en-US', { timeZone: property.timezone })}`,
        `This is an IntelliConnect pool — manual action required.`,
      ].join('\n')
    );
  }
}

/**
 * Execute any scheduled events that are due.
 */
async function executeScheduledEvents() {
  const now = new Date();

  for (const event of scheduledEvents) {
    if (event.executed) continue;
    if (event.scheduledTime > now) continue;

    const property = properties.find(p => p.name === event.propertyName);

    if (!property) {
      await sendAlert('error', `Unknown property: ${event.propertyName}`, 'Could not find property config.');
      event.executed = true; // unrecoverable — config issue, no point retrying
      continue;
    }

    event.attempts = (event.attempts ?? 0) + 1;
    let succeeded = false;

    // RECALCULATE: 72h before check-in, now do the smart timing
    if (event.action === 'RECALCULATE') {
      try {
        try {
          // Primary path: smart timing (weather-driven heat-up simulation)
          const reservation = await getReservation(event.reservationId);
          const checkIn = zonedDate(reservation.arrivalDate, property.checkInHour, 0, property.timezone);
          const heaterOffTime = calculateHeaterOffTime(
            reservation.arrivalDate, reservation.departureDate, event.heatDays ?? null, property.timezone
          );
          const heatDaysLabel = event.heatDays == null
            ? 'full stay'
            : `${event.heatDays} day${event.heatDays > 1 ? 's' : ''}`;

          await scheduleSmartTiming(reservation, property, event.targetTemp, checkIn, heaterOffTime, heatDaysLabel, event.heatDays ?? null);
        } catch (smartErr: any) {
          // Fallback path: smart timing failed (typically: Open-Meteo down after
          // retries). Schedule a "dumb safe" ON 24h before check-in (or NOW if
          // check-in is closer than 24h). If the fallback ALSO throws (e.g.,
          // Hostaway is down), the outer catch leaves the event unexecuted so
          // the next executor tick retries — up to MAX_EXECUTOR_ATTEMPTS.
          const reservation = await getReservation(event.reservationId);
          const checkIn = zonedDate(reservation.arrivalDate, property.checkInHour, 0, property.timezone);
          const heaterOffTime = calculateHeaterOffTime(
            reservation.arrivalDate, reservation.departureDate, event.heatDays ?? null, property.timezone
          );
          const fallbackStart = new Date(Math.max(now.getTime(), checkIn.getTime() - 24 * 60 * 60 * 1000));

          addEvent({
            reservationId: reservation.id,
            propertyName: property.name,
            action: 'ON',
            scheduledTime: fallbackStart,
            guestName: reservation.guestName,
            executed: false,
            targetTemp: event.targetTemp,
          });

          const hasOff = scheduledEvents.some(
            e => e.reservationId === reservation.id && e.action === 'OFF' && !e.executed
          );
          if (!hasOff) {
            addEvent({
              reservationId: reservation.id,
              propertyName: property.name,
              action: 'OFF',
              scheduledTime: heaterOffTime,
              guestName: reservation.guestName,
              executed: false,
              targetTemp: event.targetTemp,
            });
          }

          await sendAlert('warning',
            `⚠️ Heat fallback scheduled — ${property.name}`,
            [
              `Smart timing failed: ${smartErr.message}`,
              ``,
              `Using fallback: heater ON 24h before check-in (no weather/temp simulation).`,
              `Guest: ${event.guestName}`,
              `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
              `Target: ${event.targetTemp}°F`,
              `Heater ON: ${fallbackStart.toLocaleString('en-US', { timeZone: property.timezone })}`,
              `Heater OFF: ${heaterOffTime.toLocaleString('en-US', { timeZone: property.timezone })}`,
              ``,
              `Pool may run cooler than target. Consider checking actual temp before guest arrives.`,
            ].join('\n')
          );
        }
        succeeded = true;
      } catch (err: any) {
        console.error(`[Executor] RECALCULATE for ${event.guestName} (${property.name}) attempt ${event.attempts} threw: ${err.message}`);
      }
    } else if (event.action === 'SANITY_READ') {
      // Pre-ON cold-pool check, 6h before scheduled ON. Reads pool temp only —
      // no Open-Meteo dependency — so it survives weather-API outages. If the
      // pool can't reach target by check-in even at conservative 0.5°F/hr, we
      // panic-pull ON forward to NOW and fire ⚠️ Cold-pool override. Sister
      // mechanism to RECALCULATE; together they guard against the 2026-05-08
      // failure mode (stale ON time vs. drifted pool temp).
      try {
        const reservation = await getReservation(event.reservationId);
        const checkIn = zonedDate(reservation.arrivalDate, property.checkInHour, 0, property.timezone);
        const hoursToCheckIn = (checkIn.getTime() - now.getTime()) / (1000 * 60 * 60);

        let poolTemp: number | null = null;
        if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
          try {
            const status = await getPoolStatus(property.screenlogicGateway);
            poolTemp = status.poolTemp;
          } catch {
            // ignore — handled below
          }
        }

        if (poolTemp == null) {
          console.log(`[Sanity] ${event.guestName} (${property.name}): pool temp unavailable, skipping`);
          succeeded = true;
        } else {
          const gap = event.targetTemp - poolTemp;
          const CONSERVATIVE_RATE = 0.5; // °F/hr — matches netHeatingRate floor
          const SAFETY_BUFFER = 1; // hour
          const hoursNeeded = gap > 0 ? gap / CONSERVATIVE_RATE + SAFETY_BUFFER : 0;
          const onTrack = hoursNeeded <= hoursToCheckIn;

          console.log(
            `[Sanity] ${event.guestName} (${property.name}): ` +
            `poolT=${poolTemp}°F target=${event.targetTemp}°F gap=${gap.toFixed(1)}°F ` +
            `hoursToCheckIn=${hoursToCheckIn.toFixed(1)}h hoursNeeded≤${hoursNeeded.toFixed(1)}h ` +
            `onTrack=${onTrack}`
          );

          if (!onTrack) {
            // Panic-pull: replace any future ON with one scheduled at NOW.
            removeUnexecutedEvents(event.reservationId, 'ON');
            addEvent({
              reservationId: event.reservationId,
              propertyName: property.name,
              action: 'ON',
              scheduledTime: now,
              guestName: event.guestName,
              executed: false,
              targetTemp: event.targetTemp,
            });

            await sendAlert('warning',
              `⚠️ Cold-pool override — ${property.name}`,
              [
                `T-6h sanity check failed.`,
                ``,
                `Guest: ${event.guestName}`,
                `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
                `Pool temp: ${poolTemp}°F`,
                `Target: ${event.targetTemp}°F`,
                `Hours until check-in: ${hoursToCheckIn.toFixed(1)}h`,
                `Heat-up needed at conservative ${CONSERVATIVE_RATE}°F/hr: ${hoursNeeded.toFixed(1)}h`,
                ``,
                `Action: ON pulled forward to NOW. Pool may still run cool.`,
                `Consider manual heater override or warning the guest.`,
              ].join('\n')
            );
          }
          succeeded = true;
        }
      } catch (err: any) {
        console.error(`[Executor] SANITY_READ for ${event.guestName} (${property.name}) attempt ${event.attempts} threw: ${err.message}`);
      }
    } else if (event.action === 'VERIFY') {
      try {
        await executeVerify(event, property, now);
        succeeded = true;
      } catch (err: any) {
        console.error(`[Verify] ${event.verifyOf} for ${event.guestName} (${property.name}) attempt ${event.attempts} threw: ${err.message}`);
      }
    } else {
      // ON/OFF: execute heater action (existing logic has its own setTimeout
      // retry for screenlogic transients; outer attempt counter guards against
      // unhandled exceptions taking the event out of rotation forever).
      try {
        await executeHeaterAction(event, property);
        succeeded = true;
      } catch (err: any) {
        console.error(`[Executor] ${event.action} for ${event.guestName} (${property.name}) attempt ${event.attempts} threw: ${err.message}`);
      }
    }

    if (succeeded) {
      event.executed = true;
      persistEvents();
    } else if (event.attempts >= MAX_EXECUTOR_ATTEMPTS) {
      event.executed = true;
      persistEvents();
      await sendAlert('error',
        `Event abandoned after ${MAX_EXECUTOR_ATTEMPTS} attempts — ${property.name}`,
        `${event.action} for ${event.guestName} failed every time. MANUAL ACTION REQUIRED.`
      );
    }
    continue;
  }
}

/**
 * Execute a single ON/OFF heater action. Extracted from the executor so the
 * top-level retry logic can wrap it cleanly. Throws on unhandled errors;
 * known-failure paths (heater unreachable, screenlogic timeout) are surfaced
 * via alertHeaterAction and do NOT throw — the existing in-process setTimeout
 * retry handles those without needing the outer cron-level retry.
 */
const VERIFY_DELAY_MS = 10 * 60 * 1000;
const VERIFY_MAX_ROUNDS = 3;
const HEAT_MODE_OFF = 0;
const HEAT_MODE_HEATER = 3;

export type VerifyDecision =
  | 'confirmed'        // controller holds the commanded state (ON: burner firing)
  | 'at-temp'          // ON: mode held, heater idle because pool is already at set point
  | 'recheck'          // ON: mode held, burner not firing yet — give it another round
  | 'reapply'          // setting reverted — send the command again and re-verify
  | 'fail-reverted'    // reverted on every round — manual action
  | 'fail-not-firing'; // ON: mode held but burner never fired — propane/pump/ignition

/**
 * Pure decision for a VERIFY check. Exported for scripts/test-verify.ts.
 */
export function decideVerifyAction(input: {
  verifyOf: 'ON' | 'OFF';
  heatMode: number;
  setPoint: number;
  poolTemp: number;
  firing: boolean;
  targetTemp: number;
  round: number;
}): VerifyDecision {
  const { verifyOf, heatMode, setPoint, poolTemp, firing, targetTemp, round } = input;
  const lastRound = round >= VERIFY_MAX_ROUNDS;

  if (verifyOf === 'OFF') {
    if (heatMode === HEAT_MODE_OFF) return 'confirmed';
    return lastRound ? 'fail-reverted' : 'reapply';
  }

  if (heatMode !== HEAT_MODE_HEATER || setPoint !== targetTemp) {
    return lastRound ? 'fail-reverted' : 'reapply';
  }
  if (firing) return 'confirmed';
  if (poolTemp > 0 && poolTemp >= setPoint) return 'at-temp';
  // A gas heater can take a few minutes to light; one quiet re-check before alarming.
  return round >= 2 ? 'fail-not-firing' : 'recheck';
}

/**
 * Send an ON/OFF to the controller.
 * IMPORTANT: update the schedule FIRST, then set the body. The Pentair
 * controller periodically re-syncs the pool body's heat settings from the
 * active schedule. If we set the body first, the controller can undo it
 * before we update the schedule — leaving "schedule ON, body OFF".
 */
async function applyHeaterCommand(
  property: PropertyConfig,
  heaterAction: 'ON' | 'OFF',
  targetTemp: number,
  logPrefix = ''
): Promise<{ success: boolean; message: string; firing?: boolean }> {
  const gateway = property.screenlogicGateway!;
  try {
    const schedResult = heaterAction === 'ON'
      ? await updatePoolScheduleHeatOn(gateway, targetTemp)
      : await updatePoolScheduleHeatOff(gateway);
    if (schedResult.success) {
      console.log(`[Schedule] ${logPrefix}${schedResult.message}`);
    } else {
      console.error(`[Schedule] ${logPrefix}${schedResult.message}`);
      await sendAlert('warning', `Schedule update failed — ${property.name}`, schedResult.message);
    }
  } catch (schedErr: any) {
    console.error(`[Schedule] ${logPrefix}Error for ${property.name}: ${schedErr.message}`);
    await sendAlert('warning', `Schedule update error — ${property.name}`, schedErr.message);
  }

  return heaterAction === 'ON'
    ? await setPoolHeat(gateway, targetTemp)
    : await turnOffPoolHeat(gateway);
}

function scheduleVerify(
  event: ScheduledEvent,
  heaterAction: 'ON' | 'OFF',
  actionTime: Date,
  round: number,
  firingAtAction: boolean
) {
  addEvent({
    reservationId: event.reservationId,
    propertyName: event.propertyName,
    action: 'VERIFY',
    scheduledTime: new Date(Date.now() + VERIFY_DELAY_MS),
    guestName: event.guestName,
    executed: false,
    targetTemp: event.targetTemp,
    verifyOf: heaterAction,
    verifyActionTime: actionTime.toISOString(),
    verifyRound: round,
    firingAtAction,
  });
}

/**
 * VERIFY handler: re-read the controller after an ON/OFF and act on what it
 * actually shows. Throws only on read failure (outer executor retries).
 */
async function executeVerify(event: ScheduledEvent, property: PropertyConfig, now: Date) {
  const verifyOf = event.verifyOf!;
  const actionTime = new Date(event.verifyActionTime ?? event.scheduledTime);
  const round = event.verifyRound ?? 1;

  if (property.poolSystem !== 'screenlogic' || !property.screenlogicGateway) return;

  // A later ON/OFF at this property (the guest's own OFF, or the next guest's
  // ON on a turnover day) owns the heater now — this check is moot.
  const superseded = scheduledEvents.find(e =>
    e.propertyName === property.name &&
    (e.action === 'ON' || e.action === 'OFF') &&
    e.action !== verifyOf &&
    e.scheduledTime > actionTime &&
    (e.executed || e.scheduledTime <= now)
  );
  if (superseded) {
    console.log(`[Verify] ${verifyOf} for ${event.guestName} (${property.name}) superseded by ${superseded.action} for ${superseded.guestName} — skipping`);
    return;
  }

  const status = await getPoolStatus(property.screenlogicGateway);
  const decision = decideVerifyAction({
    verifyOf,
    heatMode: status.poolHeatMode,
    setPoint: status.poolSetPoint,
    poolTemp: status.poolTemp,
    firing: status.isPoolHeaterOn,
    targetTemp: event.targetTemp,
    round,
  });
  const reading = `heatMode=${status.poolHeatMode} setPoint=${status.poolSetPoint}°F burner=${status.isPoolHeaterOn ? 'FIRING' : 'off'} poolTemp=${status.poolTemp}°F`;
  console.log(`[Verify] ${verifyOf} round ${round} for ${event.guestName} (${property.name}): ${reading} → ${decision}`);

  switch (decision) {
    case 'confirmed':
      if (verifyOf === 'ON' && (!event.firingAtAction || round > 1)) {
        await alertHeaterAction(property.name, 'ON', true, `Confirmed running — ${reading}`, event.guestName);
      }
      return;
    case 'at-temp':
      if (!event.firingAtAction || round > 1) {
        await alertHeaterAction(property.name, 'ON', true,
          `Heater set to ${event.targetTemp}°F and holding; burner idle because the pool is already at temperature — ${reading}`,
          event.guestName);
      }
      return;
    case 'recheck':
      scheduleVerify(event, verifyOf, actionTime, round + 1, !!event.firingAtAction);
      return;
    case 'reapply': {
      const result = await applyHeaterCommand(property, verifyOf, event.targetTemp, 'VERIFY re-apply: ');
      await sendAlert('warning',
        `Heater ${verifyOf} did not hold — re-applied — ${property.name}`,
        [
          `Property: ${property.name}`,
          `Guest: ${event.guestName}`,
          `The ${verifyOf} command was accepted at ${actionTime.toLocaleString('en-US', { timeZone: property.timezone })}, but the controller has since changed.`,
          `Reading (round ${round}): ${reading}`,
          `Re-applied: ${result.success ? 'OK' : 'FAILED'} — ${result.message}`,
          `Checking again in 10 minutes.`,
        ].join('\n'));
      scheduleVerify(event, verifyOf, actionTime, round + 1, false);
      return;
    }
    case 'fail-reverted':
    case 'fail-not-firing':
      await sendAlert('error',
        `FAILED: Heater ${verifyOf} not holding — ${property.name} — MANUAL ACTION NEEDED`,
        [
          `Property: ${property.name}`,
          `Guest: ${event.guestName}`,
          decision === 'fail-reverted'
            ? `The heater was set ${verifyOf} ${round} times and the controller changed it back each time. Something else is controlling it (Pentair app, another schedule, or the controller itself).`
            : `Heat mode is set to HEATER at ${event.targetTemp}°F, but the burner has not fired after ${round * 10} minutes. Check the pump is running, the propane tank, and the heater for an error code.`,
          `Reading: ${reading}`,
          '',
          '⚠️ Please check the heater in the Pentair app.',
        ].join('\n'));
      return;
  }
}

async function executeHeaterAction(event: ScheduledEvent, property: PropertyConfig) {
  const heaterAction = event.action as 'ON' | 'OFF';

  if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
    // Automated control.
    try {
      const actionTime = new Date();
      const result = await applyHeaterCommand(property, heaterAction, event.targetTemp);

      await alertHeaterAction(
        property.name,
        heaterAction,
        result.success,
        result.message,
        event.guestName,
        heaterAction === 'ON' && result.success && !result.firing
      );
      if (result.success) {
        scheduleVerify(event, heaterAction, actionTime, 1, !!result.firing);
      }

      // If failed, retry once after 5 minutes (in-process; outer cron-level
      // retry separately re-fires events that throw — these are different
      // recovery layers).
      if (!result.success) {
        setTimeout(async () => {
          try {
            const retryTime = new Date();
            const retry = await applyHeaterCommand(property, heaterAction, event.targetTemp, 'RETRY: ');

            await alertHeaterAction(
              property.name,
              heaterAction,
              retry.success,
              `RETRY: ${retry.message}`,
              event.guestName,
              heaterAction === 'ON' && retry.success && !retry.firing
            );
            if (retry.success) {
              scheduleVerify(event, heaterAction, retryTime, 1, !!retry.firing);
            }
          } catch (err: any) {
            await alertHeaterAction(property.name, heaterAction, false, `RETRY FAILED: ${err.message}`, event.guestName);
          }
        }, 5 * 60 * 1000);
      }
    } catch (err: any) {
      await alertHeaterAction(property.name, heaterAction, false, err.message, event.guestName);
      throw err; // surface to outer retry counter
    }
  } else {
    // IntelliConnect — send reminder
    const checkTime = event.scheduledTime.toLocaleString('en-US', { timeZone: property.timezone });
    await alertManualReminder(property.name, heaterAction, event.guestName, checkTime);
  }
}

/**
 * Scan all upcoming reservations and schedule heat events.
 * Runs periodically to catch new bookings and changes.
 */
export async function scanReservations() {
  console.log(`[${new Date().toISOString()}] Scanning reservations...`);

  try {
    const listingIds = properties.map(p => p.ownerrezPropertyId);
    const reservations = await getAllUpcomingReservations(listingIds);

    // Detection reads guest conversations, which OwnerRez gates behind an OAuth
    // app. Without one the loop below would classify every booking as
    // 'not_discussed' and report a clean scan while seeing nothing — so stop
    // here and say so, loudly, rather than shipping a silent partial.
    if (!hasOAuth()) {
      const msg =
        `${reservations.length} upcoming booking(s) found, but guest messages cannot be read: ` +
        'no OwnerRez OAuth token. Pool-heat detection is BLIND until one is authorised ' +
        '(create an OAuth app, Users → "Grant Access To Me", then run `npm run orz:auth`).';
      console.error(`[Scan] ABORTED — ${msg}`);
      await sendAlert('error', 'Pool heat detection is blind — OwnerRez OAuth missing', msg);
      return;
    }

    for (const res of reservations) {
      const property = getPropertyForListing(res.listingMapId);
      if (!property) continue;

      // A booking with no message thread (direct bookings, and the ones migrated
      // by hand) can't be scanned. Log it so the gap is visible instead of
      // silently reading as "no heat requested".
      if (res.threadIds.length === 0) {
        console.log(`[Scan] ${res.guestName} (${property.name}, ${res.arrivalDate}) has no message thread — cannot scan, check manually`);
        continue;
      }

      const { result: heatResult, messages } = await checkReservationHeat(res);
      if (heatResult.status === 'agreed' && declinedReservations.has(res.id)) {
        // A human/explicit decline always wins over an 'agreed' classification.
        // Guards against a parser false-positive re-scheduling heat after a NO.
        console.log(`[Scan] ${res.guestName} (${res.id}) classified 'agreed' but is in declinedReservations — skipping.`);
      } else if (heatResult.status === 'agreed') {
        await scheduleForReservation(res, property, heatResult);
      } else if (heatResult.status === 'pending') {
        // Guest raised heat (or replied to the offer) but we can't classify.
        // Email Brady with YES/NO links — and re-ask if the guest has spoken
        // since the last email.
        await requestConfirmation(res, property, messages);
      }
    }

    console.log(`[${new Date().toISOString()}] Scan complete. ${scheduledEvents.filter(e => !e.executed).length} pending events.`);
  } catch (err: any) {
    console.error(`Reservation scan failed: ${err.message}`);
    await sendAlert('error', 'Reservation scan failed', err.message);
  }
}

/**
 * Handle a webhook from OwnerRez for new/updated bookings.
 */
export async function handleReservationWebhook(reservation: Reservation) {
  const property = getPropertyForListing(reservation.listingMapId);
  if (!property) return;

  // Every by-id path needs its own status check. The 2026-08-10 incident (a
  // message sent to a guest who had cancelled in July) happened because the
  // status filter lived only in the list fetch; this handler had no guard at all.
  if (reservation.status !== 'active' || reservation.isBlock) {
    console.log(`[Webhook] Skipping ${reservation.guestName} — status '${reservation.status}'${reservation.isBlock ? ' (block)' : ''}, not an active booking`);
    return;
  }

  // Skip checked-out reservations (webhooks fire on checkout status changes too)
  const today = new Date().toISOString().split('T')[0];
  if (reservation.departureDate <= today) {
    console.log(`[Webhook] Skipping ${reservation.guestName} — already departed ${reservation.departureDate}`);
    return;
  }

  if (reservation.threadIds.length === 0) {
    console.log(`[Webhook] ${reservation.guestName} (${property.name}) has no message thread yet — nothing to scan`);
    return;
  }

  const { result: heatResult } = await checkReservationHeat(reservation);
  if (heatResult.status === 'agreed' && declinedReservations.has(reservation.id)) {
    console.log(`[Webhook] ${reservation.guestName} (${reservation.id}) classified 'agreed' but is in declinedReservations — skipping.`);
  } else if (heatResult.status === 'agreed') {
    await scheduleForReservation(reservation, property, heatResult);
  }
}

/**
 * Handle a message webhook — a new guest message arrived on a thread.
 *
 * OwnerRez `thread_message` webhooks carry the thread, not always the booking,
 * so the booking is resolved from the thread. `bookingId` is passed through when
 * the payload already contains it, saving a round trip.
 */
export async function handleMessageWebhook(threadId: number, bookingId?: number) {
  const conversationId = threadId; // kept for the log lines below
  try {
    const reservationId = bookingId ?? await getBookingIdForThread(threadId);
    if (!reservationId) {
      console.log(`[Message Webhook] Thread ${threadId} has no booking — skipping`);
      return;
    }

    // Get the reservation to find the property
    const reservation = await getReservation(reservationId);
    const property = getPropertyForListing(reservation.listingMapId);
    if (!property) {
      console.log(`[Message Webhook] Reservation ${reservationId} is not a pool property — skipping`);
      return;
    }

    // Skip cancelled/pending bookings — a guest replying on a dead thread
    // shouldn't produce a confirm email or scheduling (Stephanie Gillman, 8/10).
    // OwnerRez vocabulary: 'active' is the confirmed booking (was Hostaway 'modified').
    if (reservation.status !== 'active' || reservation.isBlock) {
      console.log(`[Message Webhook] Reservation ${reservationId} status '${reservation.status}' — not an active booking, skipping`);
      pendingConfirms.delete(reservationId);
      persistConfirmState();
      return;
    }

    // Skip checked-out reservations
    const today = new Date().toISOString().split('T')[0];
    if (reservation.departureDate <= today) {
      console.log(`[Message Webhook] Reservation ${reservationId} already departed ${reservation.departureDate} — skipping`);
      return;
    }

    // Already scheduled? Skip re-scan (include executed events to prevent re-fire after restart).
    const alreadyScheduled = scheduledEvents.some(
      e => e.reservationId === reservationId
    );
    if (alreadyScheduled) {
      console.log(`[Message Webhook] Reservation ${reservationId} already scheduled — skipping`);
      return;
    }

    // Scan messages for pool heat agreement
    const { result: heatResult, messages } = await checkReservationHeat(reservation);
    console.log(`[Message Webhook] Reservation ${reservationId} (${property.name}) — status: ${heatResult.status}`);

    if (heatResult.status === 'agreed' && declinedReservations.has(reservation.id)) {
      console.log(`[Message Webhook] ${reservation.guestName} (${reservation.id}) classified 'agreed' but is in declinedReservations — skipping.`);
    } else if (heatResult.status === 'agreed') {
      await scheduleForReservation(reservation, property, heatResult);
      await sendAlert('info',
        `Real-time detection — ${property.name}`,
        `Guest ${reservation.guestName} agreed to pool heat via message webhook (no polling delay).`
      );
    } else if (heatResult.status === 'pending') {
      await requestConfirmation(reservation, property, messages);
    }
  } catch (err: any) {
    console.error(`[Message Webhook] Error processing conversation ${conversationId}: ${err.message}`);
    await sendAlert('error', 'Message webhook error', `Conversation ${conversationId}: ${err.message}`);
  }
}

/**
 * Get current schedule state (for health check / debugging).
 */
export function getScheduleState() {
  return {
    total: scheduledEvents.length,
    pending: scheduledEvents.filter(e => !e.executed),
    executed: scheduledEvents.filter(e => e.executed),
  };
}

/**
 * Start the scheduler.
 */
export function startScheduler() {
  // Check for due events every minute
  cron.schedule('* * * * *', executeScheduledEvents);

  // Scan reservations every 4 hours
  cron.schedule('0 */4 * * *', scanReservations);

  // Digest at 8 AM ET on Mondays and Fridays (deduped + fresh scan has run
  // recently). Two checkpoints per week: Monday previews the upcoming weekend
  // bookings; Friday recaps and flags anything still unresolved heading into
  // peak guest-arrival days.
  cron.schedule('0 8 * * 1,5', async () => {
    try {
      const { sendWeeklyDigest } = await import('./digest');
      await sendWeeklyDigest();
    } catch (err: any) {
      console.error(`[Digest] Failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Restore persisted state (PM2 restarts no longer drop ON events or
  // forget which reservations Brady already classified).
  const restored = loadEvents();
  if (restored > 0) console.log(`[Persist] Restored ${restored} events from ${SCHEDULE_PERSIST_PATH}`);
  const confirmCounts = loadConfirmState();
  if (confirmCounts.pending + confirmCounts.declined > 0) {
    console.log(`[Persist] Restored confirm state: ${confirmCounts.pending} pending, ${confirmCounts.declined} declined`);
  }

  // Dedupe on startup (defensive — scanner also uses addEvent's dedup now)
  const removed = dedupeExistingEvents();
  if (removed > 0) console.log(`[Dedup] Removed ${removed} duplicate events on startup`);

  // Backfill T-24/T-12 RECALCULATE + T-6 SANITY_READ for any in-flight ON
  // that predates the 2026-05-08 safety-rails rollout. Fire-and-forget so a
  // slow Hostaway doesn't block startup; failures log and we move on.
  bootstrapBackfillSafetyEvents()
    .then(({ recalcsAdded, sanityAdded, reservationsCovered }) => {
      if (reservationsCovered > 0) {
        console.log(
          `[Bootstrap] Backfilled safety events for ${reservationsCovered} reservation(s): ` +
          `+${recalcsAdded} RECALCULATE, +${sanityAdded} SANITY_READ`
        );
      }
    })
    .catch((err: any) => console.error(`[Bootstrap] Safety backfill failed: ${err.message}`));

  // Initial scan on startup
  setTimeout(scanReservations, 5000);

  console.log('Scheduler started: events/1min, scan/4h, Mon+Fri digest 8am ET');
}
