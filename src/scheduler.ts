import cron from 'node-cron';
import { properties, PropertyConfig } from './config';
import { getAllUpcomingReservations, getConversationMessages, scanMessagesForPoolHeat, Reservation, PoolHeatResult } from './hostaway';
import { getPoolStatus, setPoolHeat, turnOffPoolHeat } from './screenlogic';
import { calculateHeaterStartTime } from './weather';
import { alertHeaterAction, alertManualReminder, sendAlert } from './alerts';
import { getTargetTempForDate } from './pricing';

interface ScheduledEvent {
  reservationId: number;
  propertyName: string;
  action: 'ON' | 'OFF';
  scheduledTime: Date;
  guestName: string;
  executed: boolean;
  targetTemp: number;
}

// In-memory schedule (persisted to disk would be better for production)
const scheduledEvents: ScheduledEvent[] = [];

function getPropertyForListing(listingId: number): PropertyConfig | undefined {
  return properties.find(p => p.hostawayListingId === listingId);
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
 * - If heatDays is null (full stay): 8 PM on departure date
 * - If heatDays is a number: 8 PM on (arrival + heatDays) days
 *
 * The heater turns off at 8 PM on the last paid heat day, not at checkout.
 */
function calculateHeaterOffTime(
  arrivalDate: string,
  departureDate: string,
  heatDays: number | null,
  timezone: string
): Date {
  let lastHeatDate: string;

  if (heatDays === null) {
    // Full stay — last heat day is the day before departure (guest's last night)
    const dep = new Date(departureDate + 'T00:00:00');
    dep.setDate(dep.getDate() - 1);
    lastHeatDate = dep.toISOString().split('T')[0];
  } else {
    // Partial stay — heat for N days starting from arrival
    const arr = new Date(arrivalDate + 'T00:00:00');
    arr.setDate(arr.getDate() + heatDays - 1);
    // Don't go past departure
    const dep = new Date(departureDate + 'T00:00:00');
    dep.setDate(dep.getDate() - 1);
    if (arr > dep) {
      lastHeatDate = dep.toISOString().split('T')[0];
    } else {
      lastHeatDate = arr.toISOString().split('T')[0];
    }
  }

  // 8 PM on the last heat day
  return new Date(`${lastHeatDate}T20:00:00`);
}

/**
 * Schedule heater on/off events for a reservation.
 */
async function scheduleForReservation(
  reservation: Reservation,
  property: PropertyConfig,
  heatResult: PoolHeatResult
) {
  // Check if already scheduled
  const existing = scheduledEvents.find(
    e => e.reservationId === reservation.id && !e.executed
  );
  if (existing) return;

  // Build check-in datetime
  const checkIn = new Date(`${reservation.arrivalDate}T${String(property.checkInHour).padStart(2, '0')}:00:00`);

  // Use season-based target temp from pricing table
  const targetTemp = getTargetTempForDate(checkIn);

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

  if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
    // Smart scheduling: calculate optimal start time based on pool temp + weather
    let currentPoolTemp: number | null = null;
    try {
      const status = await getPoolStatus(property.screenlogicGateway);
      currentPoolTemp = status.poolTemp;
    } catch {
      // Can't read temp — will estimate from air temp
    }

    const { startTime, estimatedHours, avgAirTemp } = await calculateHeaterStartTime(
      checkIn,
      targetTemp,
      currentPoolTemp,
      property.latitude,
      property.longitude
    );

    // Schedule heater ON (smart-timed to reach target by check-in)
    scheduledEvents.push({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'ON',
      scheduledTime: startTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
    });

    // Schedule heater OFF at 8 PM on last paid heat day
    scheduledEvents.push({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'OFF',
      scheduledTime: heaterOffTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
    });

    await sendAlert('info',
      `Heat scheduled — ${property.name}`,
      [
        `Guest: ${reservation.guestName}`,
        `Stay: ${reservation.arrivalDate} → ${reservation.departureDate}`,
        `Heat duration: ${heatDaysLabel}`,
        `Target: ${targetTemp}°F`,
        `Current pool temp: ${currentPoolTemp ?? 'unknown'}°F`,
        `Avg air temp forecast: ${avgAirTemp.toFixed(1)}°F`,
        `Heater ON: ${startTime.toLocaleString('en-US', { timeZone: property.timezone })} (${estimatedHours}h to heat)`,
        `Heater OFF: ${heaterOffTime.toLocaleString('en-US', { timeZone: property.timezone })}`,
      ].join('\n')
    );
  } else {
    // IntelliConnect — schedule reminders only
    // Smart reminder: same timing logic but manual action
    let reminderTime: Date;
    try {
      const { startTime } = await calculateHeaterStartTime(
        checkIn,
        targetTemp,
        null, // Can't read IntelliConnect pool temp
        property.latitude,
        property.longitude
      );
      reminderTime = startTime;
    } catch {
      // Fallback: 24h before check-in
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

    scheduledEvents.push({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'OFF',
      scheduledTime: heaterOffTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp,
    });

    await sendAlert('info',
      `Heat reminders set — ${property.name} (manual)`,
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

    if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
      // Automated control
      try {
        let result;
        if (event.action === 'ON') {
          result = await setPoolHeat(property.screenlogicGateway, event.targetTemp);
        } else {
          result = await turnOffPoolHeat(property.screenlogicGateway);
        }

        await alertHeaterAction(
          property.name,
          event.action,
          result.success,
          result.message,
          event.guestName
        );

        // If failed, retry once after 5 minutes
        if (!result.success) {
          setTimeout(async () => {
            try {
              const retry = event.action === 'ON'
                ? await setPoolHeat(property.screenlogicGateway!, event.targetTemp)
                : await turnOffPoolHeat(property.screenlogicGateway!);

              await alertHeaterAction(
                property.name,
                event.action,
                retry.success,
                `RETRY: ${retry.message}`,
                event.guestName
              );
            } catch (err: any) {
              await alertHeaterAction(property.name, event.action, false, `RETRY FAILED: ${err.message}`, event.guestName);
            }
          }, 5 * 60 * 1000);
        }
      } catch (err: any) {
        await alertHeaterAction(property.name, event.action, false, err.message, event.guestName);
      }
    } else {
      // IntelliConnect — send reminder
      const checkTime = event.scheduledTime.toLocaleString('en-US', { timeZone: property.timezone });
      await alertManualReminder(property.name, event.action, event.guestName, checkTime);
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

  const heatResult = await checkReservationHeat(reservation);
  if (heatResult.status === 'agreed') {
    await scheduleForReservation(reservation, property, heatResult);
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
