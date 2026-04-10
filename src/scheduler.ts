import cron from 'node-cron';
import { properties, PropertyConfig } from './config';
import { getAllUpcomingReservations, getConversationMessages, scanMessagesForPoolHeat, getReservation, getConversation, Reservation, PoolHeatResult } from './hostaway';
import { getPoolStatus, setPoolHeat, turnOffPoolHeat, updatePoolScheduleHeatOn, updatePoolScheduleHeatOff } from './screenlogic';
import { calculateHeaterStartTime } from './weather';
import { alertHeaterAction, alertManualReminder, sendAlert } from './alerts';
import { getTargetTempForStay } from './pricing';

interface ScheduledEvent {
  reservationId: number;
  propertyName: string;
  action: 'ON' | 'OFF' | 'RECALCULATE';
  scheduledTime: Date;
  guestName: string;
  executed: boolean;
  targetTemp: number;
  heatDays?: number | null;
}

// In-memory schedule (persisted to disk would be better for production)
const scheduledEvents: ScheduledEvent[] = [];

function getPropertyForListing(listingId: number): PropertyConfig | undefined {
  return properties.find(p => p.hostawayListingId === listingId);
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
async function checkReservationHeat(reservation: Reservation): Promise<PoolHeatResult> {
  const messages = await getConversationMessages(reservation.id);
  if (messages.length > 0) {
    return scanMessagesForPoolHeat(messages);
  }
  return { status: 'not_discussed', heatDays: null };
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
    await scheduleSmartTiming(reservation, property, targetTemp, checkIn, heaterOffTime, heatDaysLabel);
  } else {
    // Check-in is far away — schedule a RECALCULATE event for 72h before check-in.
    // No pool temp reads, no weather API calls. Just note the agreement.
    const recalcTime = new Date(checkIn.getTime() - 72 * 60 * 60 * 1000);

    scheduledEvents.push({
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
    scheduledEvents.push({
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
  heatDaysLabel: string
) {
  if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
    let currentPoolTemp: number | null = null;
    try {
      const status = await getPoolStatus(property.screenlogicGateway);
      currentPoolTemp = status.poolTemp;
    } catch {
      // Can't read temp — will estimate from air temp
    }

    const { startTime, estimatedHours, avgAirTemp, clamped, shortfallHours } = await calculateHeaterStartTime(
      checkIn, targetTemp, currentPoolTemp, property.latitude, property.longitude
    );

    scheduledEvents.push({
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
      scheduledEvents.push({
        reservationId: reservation.id,
        propertyName: property.name,
        action: 'OFF',
        scheduledTime: heaterOffTime,
        guestName: reservation.guestName,
        executed: false,
        targetTemp,
      });
    }

    // Late-detection warning: if we had to clamp the start time to "now",
    // the pool may not reach target by check-in. Surface it on the alert.
    const alertLevel = clamped ? 'warning' : 'info';
    const alertSubject = clamped
      ? `⚠️ Heat compressed — ${property.name}`
      : `Heat smart-timed — ${property.name}`;

    const hoursUntilCheckIn = (checkIn.getTime() - startTime.getTime()) / (1000 * 60 * 60);
    const gapF = currentPoolTemp != null ? Math.max(0, targetTemp - currentPoolTemp) : null;

    const lines = [
      `Guest: ${reservation.guestName}`,
      `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
      `Heat duration: ${heatDaysLabel}`,
      `Target: ${targetTemp}°F`,
      `Current pool temp: ${currentPoolTemp ?? 'unknown'}°F`,
      `Avg air temp forecast: ${avgAirTemp.toFixed(1)}°F`,
      `Heater ON: ${startTime.toLocaleString('en-US', { timeZone: property.timezone })} (${estimatedHours}h to heat)`,
      `Heater OFF: ${heaterOffTime.toLocaleString('en-US', { timeZone: property.timezone })}`,
    ];
    if (clamped) {
      lines.push('');
      lines.push(`⚠️ LATE DETECTION: ideal start was ${shortfallHours.toFixed(1)}h ago.`);
      lines.push(`Only ${hoursUntilCheckIn.toFixed(1)}h until check-in at ${checkIn.toLocaleString('en-US', { timeZone: property.timezone })}.`);
      if (gapF != null) {
        lines.push(`Need ${gapF.toFixed(1)}°F of heat-up; at ~1°F/hr that needs ${(gapF + 2).toFixed(0)}h including buffer.`);
      }
      lines.push(`Pool may not reach ${targetTemp}°F by guest arrival. Consider manual intervention.`);
    }

    await sendAlert(alertLevel,
      alertSubject,
      lines.join('\n')
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

    scheduledEvents.push({
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
      scheduledEvents.push({
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

    event.executed = true;
    const property = properties.find(p => p.name === event.propertyName);

    if (!property) {
      await sendAlert('error', `Unknown property: ${event.propertyName}`, 'Could not find property config.');
      continue;
    }

    // RECALCULATE: 72h before check-in, now do the smart timing
    if (event.action === 'RECALCULATE') {
      try {
        // Find the reservation to get dates
        const reservation = await getReservation(event.reservationId);
        const checkIn = zonedDate(reservation.arrivalDate, property.checkInHour, 0, property.timezone);
        const heaterOffTime = calculateHeaterOffTime(
          reservation.arrivalDate, reservation.departureDate, event.heatDays ?? null, property.timezone
        );
        const heatDaysLabel = event.heatDays == null
          ? 'full stay'
          : `${event.heatDays} day${event.heatDays > 1 ? 's' : ''}`;

        await scheduleSmartTiming(reservation, property, event.targetTemp, checkIn, heaterOffTime, heatDaysLabel);
      } catch (err: any) {
        await sendAlert('error', `Recalculate failed — ${property.name}`, `Guest: ${event.guestName}\nError: ${err.message}`);
      }
      continue;
    }

    const heaterAction = event.action as 'ON' | 'OFF';

    if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
      // Automated control.
      // IMPORTANT: update the schedule FIRST, then set the body. The Pentair
      // controller periodically re-syncs the pool body's heat settings from the
      // active schedule. If we set the body first, the controller can undo it
      // before we update the schedule — leaving "schedule ON, body OFF".
      try {
        // Step 1: Update the Pentair controller's built-in schedule
        try {
          const schedResult = heaterAction === 'ON'
            ? await updatePoolScheduleHeatOn(property.screenlogicGateway, event.targetTemp)
            : await updatePoolScheduleHeatOff(property.screenlogicGateway);
          if (schedResult.success) {
            console.log(`[Schedule] ${schedResult.message}`);
          } else {
            console.error(`[Schedule] ${schedResult.message}`);
            await sendAlert('warning', `Schedule update failed — ${property.name}`, schedResult.message);
          }
        } catch (schedErr: any) {
          console.error(`[Schedule] Error for ${property.name}: ${schedErr.message}`);
          await sendAlert('warning', `Schedule update error — ${property.name}`, schedErr.message);
        }

        // Step 2: Set pool body heat mode (now safe — schedule already agrees)
        let result;
        if (heaterAction === 'ON') {
          result = await setPoolHeat(property.screenlogicGateway, event.targetTemp);
        } else {
          result = await turnOffPoolHeat(property.screenlogicGateway);
        }

        await alertHeaterAction(
          property.name,
          heaterAction,
          result.success,
          result.message,
          event.guestName
        );

        // If failed, retry once after 5 minutes
        if (!result.success) {
          setTimeout(async () => {
            try {
              // Retry schedule first, then body (same order)
              try {
                const schedRetry = heaterAction === 'ON'
                  ? await updatePoolScheduleHeatOn(property.screenlogicGateway!, event.targetTemp)
                  : await updatePoolScheduleHeatOff(property.screenlogicGateway!);
                if (schedRetry.success) {
                  console.log(`[Schedule] RETRY: ${schedRetry.message}`);
                } else {
                  console.error(`[Schedule] RETRY failed: ${schedRetry.message}`);
                }
              } catch (schedErr: any) {
                console.error(`[Schedule] RETRY error: ${schedErr.message}`);
              }

              const retry = event.action === 'ON'
                ? await setPoolHeat(property.screenlogicGateway!, event.targetTemp)
                : await turnOffPoolHeat(property.screenlogicGateway!);

              await alertHeaterAction(
                property.name,
                heaterAction,
                retry.success,
                `RETRY: ${retry.message}`,
                event.guestName
              );
            } catch (err: any) {
              await alertHeaterAction(property.name, heaterAction, false, `RETRY FAILED: ${err.message}`, event.guestName);
            }
          }, 5 * 60 * 1000);
        }
      } catch (err: any) {
        await alertHeaterAction(property.name, event.action, false, err.message, event.guestName);
      }
    } else {
      // IntelliConnect — send reminder
      const checkTime = event.scheduledTime.toLocaleString('en-US', { timeZone: property.timezone });
      await alertManualReminder(property.name, heaterAction, event.guestName, checkTime);
    }
  }
}

/**
 * Scan all upcoming reservations and schedule heat events.
 * Runs periodically to catch new bookings and changes.
 */
export async function scanReservations() {
  console.log(`[${new Date().toISOString()}] Scanning reservations...`);

  try {
    const listingIds = properties.map(p => p.hostawayListingId);
    const reservations = await getAllUpcomingReservations(listingIds);

    for (const res of reservations) {
      const property = getPropertyForListing(res.listingMapId);
      if (!property) continue;

      const heatResult = await checkReservationHeat(res);
      if (heatResult.status === 'agreed') {
        await scheduleForReservation(res, property, heatResult);
      }
    }

    console.log(`[${new Date().toISOString()}] Scan complete. ${scheduledEvents.filter(e => !e.executed).length} pending events.`);
  } catch (err: any) {
    console.error(`Reservation scan failed: ${err.message}`);
    await sendAlert('error', 'Reservation scan failed', err.message);
  }
}

/**
 * Handle a webhook from Hostaway for new/updated reservations.
 */
export async function handleReservationWebhook(reservation: Reservation) {
  const property = getPropertyForListing(reservation.listingMapId);
  if (!property) return;

  // Skip checked-out reservations (webhooks fire on checkout status changes too)
  const today = new Date().toISOString().split('T')[0];
  if (reservation.departureDate <= today) {
    console.log(`[Webhook] Skipping ${reservation.guestName} — already departed ${reservation.departureDate}`);
    return;
  }

  const heatResult = await checkReservationHeat(reservation);
  if (heatResult.status === 'agreed') {
    await scheduleForReservation(reservation, property, heatResult);
  }
}

/**
 * Handle a message webhook — a new guest message arrived in a conversation.
 * Look up the reservation, scan for pool heat, and schedule if agreed.
 */
export async function handleMessageWebhook(conversationId: number) {
  try {
    // Get the conversation to find the reservationId
    const conversation = await getConversation(conversationId);
    const reservationId = conversation?.reservationId;
    if (!reservationId) {
      console.log(`[Message Webhook] Conversation ${conversationId} has no reservation — skipping`);
      return;
    }

    // Get the reservation to find the property
    const reservation = await getReservation(reservationId);
    const property = getPropertyForListing(reservation.listingMapId);
    if (!property) {
      console.log(`[Message Webhook] Reservation ${reservationId} is not a pool property — skipping`);
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
    const heatResult = await checkReservationHeat(reservation);
    console.log(`[Message Webhook] Reservation ${reservationId} (${property.name}) — status: ${heatResult.status}`);

    if (heatResult.status === 'agreed') {
      await scheduleForReservation(reservation, property, heatResult);
      await sendAlert('info',
        `Real-time detection — ${property.name}`,
        `Guest ${reservation.guestName} agreed to pool heat via message webhook (no polling delay).`
      );
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

  // Initial scan on startup
  setTimeout(scanReservations, 5000);

  console.log('Scheduler started: event check every 1min, reservation scan every 4h');
}
