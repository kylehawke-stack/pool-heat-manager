import express from 'express';
import crypto from 'crypto';
import { config } from './config';
import { handleReservationWebhook, handleMessageWebhook, startScheduler, getScheduleState, scanReservations, forceAgreement, markDeclined, markUndecided, delayHeaterOn } from './scheduler';
import { sendAlert } from './alerts';
import { verifyConfirm } from './confirm';
import { verifyOverride } from './override';
import { handleInboundSms } from './sms';
import { sendWeeklyDigest, buildDigestHtml } from './digest';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded

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
 * Hostaway includes an Authorization: Basic header only when the webhook
 * registration has login/password set. Returns true if no credentials are
 * configured locally (local dev / OSS default).
 */
function verifyWebhookAuth(req: express.Request): boolean {
  const { webhookLogin, webhookPassword } = config.server;
  if (!webhookLogin && !webhookPassword) {
    console.warn('[Webhook] WEBHOOK_LOGIN/WEBHOOK_PASSWORD not set — accepting unauthenticated webhook');
    return true;
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const expected = Buffer.from(`${webhookLogin}:${webhookPassword}`);
  const received = Buffer.from(decoded);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
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

// Confirm email callback (YES/NO links from sendConfirmRequest)
app.get('/confirm', async (req, res) => {
  const token = String(req.query.t || '');
  const payload = verifyConfirm(token);
  if (!payload) {
    res.status(400).send(confirmPage('Link invalid or expired', 'This confirmation link is no longer valid. Please check your email for a newer request or reply to the system.', '#dc2626'));
    return;
  }
  try {
    if (payload.a === 'yes') {
      await forceAgreement(payload.r, payload.d);
      const days = payload.d === null ? 'full stay' : `${payload.d} day${payload.d > 1 ? 's' : ''}`;
      res.send(confirmPage('✓ Confirmed', `Pool heat scheduled (${days}) for reservation ${payload.r}. You should receive a scheduling alert shortly.`, '#16a34a'));
    } else if (payload.a === 'undecided') {
      markUndecided(payload.r);
      res.send(confirmPage('? Marked undecided', `Reservation ${payload.r} kept in pending queue. We'll send the guest a Hostaway message asking them to decide once we're 5 days from arrival.`, '#7c3aed'));
    } else {
      markDeclined(payload.r);
      res.send(confirmPage('✗ Declined', `Reservation ${payload.r} marked as declined. No pool heat will be scheduled.`, '#dc2626'));
    }
  } catch (err: any) {
    res.status(500).send(confirmPage('Error', err.message, '#dc2626'));
  }
});

// Email override: delay the pending heater ON for a reservation by N hours.
// Token signed by override.ts; payload carries reservationId + hours.
app.get('/delay-on', async (req, res) => {
  const token = String(req.query.t || '');
  const payload = verifyOverride(token);
  if (!payload || payload.a !== 'delay-on') {
    res.status(400).send(confirmPage('Link invalid or expired', 'This override link is no longer valid. Check your inbox for a newer alert or use the Pentair app directly.', '#dc2626'));
    return;
  }
  try {
    const result = await delayHeaterOn(payload.r, payload.h);
    if (result.ok) {
      res.send(confirmPage(`✓ Delayed +${payload.h}h`, result.message, '#16a34a'));
    } else {
      res.status(409).send(confirmPage('Could not delay', result.message, '#b45309'));
    }
  } catch (err: any) {
    res.status(500).send(confirmPage('Error', err.message, '#dc2626'));
  }
});

// Twilio inbound SMS webhook
app.post('/sms', async (req, res) => {
  try {
    const from = String(req.body.From || '');
    const body = String(req.body.Body || '');
    const signature = String(req.headers['x-twilio-signature'] || '');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const fullUrl = `${proto}://${host}${req.originalUrl}`;
    const twiml = await handleInboundSms(from, body, signature, fullUrl, req.body);
    res.type('text/xml').send(twiml);
  } catch (err: any) {
    console.error(`[SMS] Handler error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

// Manual digest triggers
app.post('/digest/send', async (_req, res) => {
  try {
    await sendWeeklyDigest();
    res.json({ sent: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/digest/preview', async (_req, res) => {
  try {
    const html = await buildDigestHtml();
    res.type('text/html').send(html);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

function confirmPage(title: string, message: string, color: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:500px;margin:60px auto;padding:24px;color:#0f172a;text-align:center">
<h1 style="color:${color};margin:0 0 12px">${title}</h1>
<p style="color:#475569;line-height:1.5">${message}</p>
</body></html>`;
}

// Start
app.listen(config.server.port, async () => {
  console.log(`Pool Heat Manager running on port ${config.server.port}`);
  startScheduler();

  await sendAlert('info', 'Pool Heat Manager started', `Server is running on port ${config.server.port}`);
});
