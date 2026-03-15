import cron from 'node-cron';
import { properties, PropertyConfig } from './config';
import { getAllUpcomingReservations, getConversationMessages, scanMessagesForPoolHeat, Reservation } from './hostaway';
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
 * Looks for Brady's pool heat offer (keyed on "gallons of propane") and guest agreement.
 */
async function reservationNeedsHeat(reservation: Reservation): Promise<boolean> {
  const messages = await getConversationMessages(reservation.id);
  if (messages.length > 0) {
    const status = scanMessagesForPoolHeat(messages);
    return status === 'agreed';
  }
  return false;
}

/**
 * Schedule heater on/off events for a reservation.
 */
async function scheduleForReservation(reservation: Reservation, property: PropertyConfig) {
  // Check if already scheduled
  const existing = scheduledEvents.find(
    e => e.reservationId === reservation.id && !e.executed
  );
  if (existing) return;

  // Build check-in datetime
  const checkIn = new Date(`${reservation.arrivalDate}T${String(property.checkInHour).padStart(2, '0')}:00:00`);
  const checkOut = new Date(`${reservation.departureDate}T${String(property.checkOutHour).padStart(2, '0')}:00:00`);

  // Use season-based target temp (from pricing table) instead of static config
  const targetTemp = getTargetTempForDate(checkIn);

  if (property.poolSystem === 'screenlogic' && property.screenlogicGateway) {
    // Smart scheduling: calculate optimal start time
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

    // Schedule heater ON
    scheduledEvents.push({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'ON',
      scheduledTime: startTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp: targetTemp,
    });

    // Schedule heater OFF at checkout
    scheduledEvents.push({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'OFF',
      scheduledTime: checkOut,
      guestName: reservation.guestName,
      executed: false,
      targetTemp: targetTemp,
    });

    await sendAlert('info',
      `Heat scheduled — ${property.name}`,
      `Guest: ${reservation.guestName}\nCheck-in: ${checkIn.toISOString()}\nHeater ON: ${startTime.toISOString()} (${estimatedHours}h to heat)\nHeater OFF: ${checkOut.toISOString()}\nTarget: ${targetTemp}°F\nAvg air temp forecast: ${avgAirTemp.toFixed(1)}°F\nCurrent pool temp: ${currentPoolTemp ?? 'unknown'}°F`
    );
  } else {
    // IntelliConnect — schedule reminders only
    // 24h before check-in reminder
    const reminderTime = new Date(checkIn.getTime() - 24 * 60 * 60 * 1000);

    scheduledEvents.push({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'ON',
      scheduledTime: reminderTime,
      guestName: reservation.guestName,
      executed: false,
      targetTemp: targetTemp,
    });

    scheduledEvents.push({
      reservationId: reservation.id,
      propertyName: property.name,
      action: 'OFF',
      scheduledTime: checkOut,
      guestName: reservation.guestName,
      executed: false,
      targetTemp: targetTemp,
    });

    await sendAlert('info',
      `Heat reminders set — ${property.name} (manual)`,
      `Guest: ${reservation.guestName}\nReminder ON: ${reminderTime.toISOString()}\nReminder OFF: ${checkOut.toISOString()}\nThis is an IntelliConnect pool — you'll need to turn heat on/off manually.`
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
    const reservations = await getAllUpcomingReservations();

    for (const res of reservations) {
      const property = getPropertyForListing(res.listingMapId);
      if (!property) continue;

      const needsHeat = await reservationNeedsHeat(res);
      if (needsHeat) {
        await scheduleForReservation(res, property);
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

  const needsHeat = await reservationNeedsHeat(reservation);
  if (needsHeat) {
    await scheduleForReservation(reservation, property);
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
