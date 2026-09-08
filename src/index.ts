import express from 'express';
import crypto from 'crypto';
import { config } from './config';
import { handleReservationWebhook, handleMessageWebhook, startScheduler, getScheduleState, scanReservations, forceAgreement, markDeclined, markUndecided, delayHeaterOn } from './scheduler';
import { getReservation, hasOAuth } from './ownerrez';
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
  const messaging = hasOAuth() ? 'ok' : 'blind — no OwnerRez OAuth token';
  res.json({
    // Degraded, not ok: without message access the system cannot detect a single
    // pool-heat agreement, so /health must not report a clean bill of health.
    status: hasOAuth() ? 'ok' : 'degraded',
    pms: 'ownerrez',
    messaging,
    uptime: process.uptime(),
    schedule: {
      pending: schedule.pending.length,
      executed: schedule.executed.length,
    },
  });
});

/**
 * Verify Basic Auth credentials sent with webhook requests.
 * OwnerRez sends `Authorization: Basic` using the User/Password configured
 * alongside the Webhook URL in the OAuth app settings. Returns true if no
 * credentials are configured locally (local dev / OSS default).
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

// OwnerRez webhook — one URL receives every subscribed entity type.
// Payload shape: { id, user_id, action, entity_type, entity_id, categories, entity }
// (https://www.ownerrez.com/support/articles/api-webhooks)
app.post('/webhook/ownerrez', async (req, res) => {
  try {
    if (!verifyWebhookAuth(req)) {
      console.warn('[Webhook] Auth failed — rejecting');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body || {};
    console.log(`[Webhook] Received:`, JSON.stringify(body).slice(0, 500));

    const action: string = body.action || '';
    const entityType: string = body.entity_type || '';
    const entity = body.entity || {};

    // Connection-level events carry no entity.
    if (action === 'application_authorization_revoked') {
      console.error('[Webhook] OwnerRez authorization REVOKED — messaging and webhooks are now dead until re-authorised');
      await sendAlert('error', 'OwnerRez access revoked',
        'The OAuth app authorization was revoked. Pool heat detection is blind until `npm run orz:auth` is re-run.');
      res.status(200).json({ received: true });
      return;
    }

    if (action === 'webhook_test') {
      console.log('[Webhook] Test ping from OwnerRez');
      res.status(200).json({ received: true });
      return;
    }

    if (entityType === 'thread_message' && action === 'entity_create') {
      // Only guest messages matter. from_role covers the guest and the people
      // booking on their behalf; owner/co_host/bot messages are ours.
      const role = String(entity.from_role || '');
      const isGuest = role === 'guest' || role === 'cotraveler' || role === 'third_party_booker';
      const threadId = entity.thread_id ?? entity.thread?.id;
      const bookingId = entity.thread?.booking_id;

      if (!isGuest) {
        console.log(`[Webhook] Message from '${role || 'unknown'}' — skipping`);
      } else if (!threadId) {
        console.warn(`[Webhook] thread_message with no thread id — cannot scan: ${JSON.stringify(body).slice(0, 300)}`);
      } else {
        console.log(`[Webhook] Guest message on thread ${threadId}${bookingId ? ` (booking ${bookingId})` : ''}`);
        await handleMessageWebhook(Number(threadId), bookingId ? Number(bookingId) : undefined);
      }
    }

    else if (entityType === 'booking' && (action === 'entity_create' || action === 'entity_update')) {
      const bookingId = body.entity_id ?? entity.id;
      console.log(`[Webhook] booking ${action} — ${bookingId} (categories: ${(body.categories || []).join(', ') || 'none'})`);
      // Refetch rather than trusting the embedded entity: the webhook body has
      // no guest name and the scheduler needs one for its alerts.
      if (bookingId) {
        const reservation = await getReservation(Number(bookingId));
        await handleReservationWebhook(reservation);
      }
    }

    else {
      console.log(`[Webhook] Ignoring ${action || 'unknown action'} on ${entityType || 'unknown entity'}`);
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
      res.send(confirmPage('? Marked undecided', `Reservation ${payload.r} kept in the pending queue and snoozed — no more confirm emails for this guest unless they reply. The system will not message the guest; follow up yourself when you're ready.`, '#7c3aed'));
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

  if (!hasOAuth()) {
    console.error('[Startup] No OwnerRez OAuth token — guest messages cannot be read and pool-heat detection is BLIND. Run `npm run orz:auth`.');
  }

  await sendAlert(
    hasOAuth() ? 'info' : 'warning',
    hasOAuth() ? 'Pool Heat Manager started' : '⚠️ Pool Heat Manager started — detection is BLIND',
    hasOAuth()
      ? `Server is running on port ${config.server.port} (PMS: OwnerRez)`
      : `Server is running on port ${config.server.port}, but no OwnerRez OAuth token is present. ` +
        'Guest messages cannot be read, so no pool-heat agreement will be detected. Run `npm run orz:auth`.'
  );
});
