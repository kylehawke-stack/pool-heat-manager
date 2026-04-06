import express from 'express';
import { config } from './config';
import { handleReservationWebhook, handleMessageWebhook, startScheduler, getScheduleState, scanReservations } from './scheduler';
import { sendAlert } from './alerts';

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  const schedule = getScheduleState();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    schedule: {
      pending: schedule.pending.length,
      executed: schedule.executed.length,
    },
  });
});

/**
 * Verify Basic Auth credentials sent by Hostaway with webhook requests.
 * Returns true if no credentials are configured (backwards compatible).
 */
function verifyWebhookAuth(req: express.Request): boolean {
  // TODO: Re-enable once we confirm Hostaway sends Basic Auth correctly
  // For now, log what headers Hostaway actually sends so we can debug
  console.log('[Webhook] Headers:', JSON.stringify(req.headers));
  return true;
}

// Hostaway unified webhook — receives ALL event types on one URL
app.post('/webhook/hostaway', async (req, res) => {
  try {
    if (!verifyWebhookAuth(req)) {
      console.warn('[Webhook] Auth failed — rejecting');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body;
    console.log(`[Webhook] Received:`, JSON.stringify(body).slice(0, 500));

    // Hostaway unified webhooks may use different payload shapes.
    // Try to detect the event type from the payload.
    const event = body.event || body.type || '';

    // --- Reservation events ---
    if (event === 'reservation.created' || event === 'reservation.updated') {
      const reservation = body.data || body.reservation || body;
      console.log(`[Webhook] ${event} — reservation ${reservation?.id}`);
      await handleReservationWebhook(reservation);
    }

    // --- Message events ---
    else if (
      event === 'conversationMessage.created' ||
      event === 'conversation_message.created' ||
      event === 'message.created' ||
      event === 'message.received' ||
      event === 'new_message'
    ) {
      const data = body.data || body.message || body;
      const isGuest = data?.isIncoming === 1 || data?.senderType === 'guest';
      if (isGuest) {
        const conversationId = data?.conversationId || data?.conversation_id;
        if (conversationId) {
          console.log(`[Webhook] Guest message in conversation ${conversationId}`);
          await handleMessageWebhook(conversationId);
        }
      } else {
        console.log(`[Webhook] Host/system message — skipping`);
      }
    }

    // --- Unknown event — log it so we can see what Hostaway actually sends ---
    else {
      console.log(`[Webhook] Unknown event type: "${event}" — logging full payload for debugging`);
      // If there's a conversationId anywhere in the payload, it might be a message
      const conversationId = body.data?.conversationId || body.conversationId || body.conversation_id;
      const reservationId = body.data?.id || body.data?.reservationId || body.reservationId;

      if (conversationId) {
        console.log(`[Webhook] Found conversationId ${conversationId} — treating as message event`);
        const isGuest = body.data?.isIncoming === 1 || body.data?.senderType === 'guest' || body.isIncoming === 1;
        if (isGuest) {
          await handleMessageWebhook(conversationId);
        }
      } else if (reservationId) {
        console.log(`[Webhook] Found reservationId ${reservationId} — treating as reservation event`);
        await handleReservationWebhook(body.data || body);
      }
    }

    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`[Webhook] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger: scan reservations now
app.post('/scan', async (_req, res) => {
  try {
    await scanReservations();
    res.json({ status: 'scan complete', schedule: getScheduleState() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// View current schedule
app.get('/schedule', (_req, res) => {
  res.json(getScheduleState());
});

// Start
app.listen(config.server.port, async () => {
  console.log(`Pool Heat Manager running on port ${config.server.port}`);
  startScheduler();

  await sendAlert('info', 'Pool Heat Manager started', `Server is running on port ${config.server.port}`);
});
