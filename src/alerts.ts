import { Resend } from 'resend';
import twilio from 'twilio';
import { config } from './config';

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

const twilioClient = config.twilio.accountSid
  ? twilio(config.twilio.accountSid, config.twilio.authToken)
  : null;

export type AlertLevel = 'info' | 'success' | 'warning' | 'error';

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '🚨',
};

/**
 * Send an alert via both email and SMS.
 * Failures in one channel don't block the other.
 */
export async function sendAlert(
  level: AlertLevel,
  subject: string,
  body: string,
  html?: string
): Promise<{ email: boolean; sms: boolean }> {
  const results = { email: false, sms: false };
  const prefix = LEVEL_EMOJI[level];

  // Send SMS — text only; HTML overrides don't apply here.
  if (twilioClient && config.alerts.phone) {
    try {
      const smsBody = `${prefix} Pool Heat: ${subject}\n\n${body}`.slice(0, 1600);
      await twilioClient.messages.create({
        body: smsBody,
        from: config.twilio.fromNumber,
        to: config.alerts.phone,
      });
      results.sms = true;
    } catch (err: any) {
      console.error(`SMS alert failed: ${err.message}`);
    }
  }

  // Send email via Resend
  if (resend && config.alerts.email) {
    try {
      const payload: { from: string; to: string; subject: string; text: string; html?: string } = {
        from: config.resend.fromAddress,
        to: config.alerts.email,
        subject: `${prefix} Pool Heat: ${subject}`,
        text: body,
      };
      if (html) payload.html = html;
      await resend.emails.send(payload as any);
      results.email = true;
    } catch (err: any) {
      console.error(`Email alert failed: ${err.message}`);
    }
  }

  if (!results.email && !results.sms) {
    console.error(`ALL ALERTS FAILED for: ${subject} — ${body}`);
  }

  return results;
}

/**
 * Send a heater action confirmation.
 */
export async function alertHeaterAction(
  propertyName: string,
  action: 'ON' | 'OFF',
  success: boolean,
  details: string,
  guestName?: string,
  // true = the controller accepted the command but the heater is not yet
  // confirmed running; a VERIFY check follows. Keeps the email from claiming
  // "ON" on a readback alone (2026-09-14 Elmwood: SUCCESS email, cold pool).
  verifying = false
) {
  const level: AlertLevel = success ? (verifying ? 'info' : 'success') : 'error';
  const subject = !success
    ? `FAILED: Heater ${action} — ${propertyName} — MANUAL ACTION NEEDED`
    : verifying
      ? `Heater ${action} command sent (verifying) — ${propertyName}`
      : `Heater ${action} — ${propertyName}`;

  const body = [
    `Property: ${propertyName}`,
    guestName ? `Guest: ${guestName}` : '',
    `Action: Turn heater ${action}`,
    `Status: ${!success ? 'FAILED' : verifying ? 'ACCEPTED — re-checking the controller in 10 minutes' : 'SUCCESS'}`,
    `Details: ${details}`,
    '',
    success ? '' : '⚠️ Please manually turn the heater on/off via the Pentair app.',
  ].filter(Boolean).join('\n');

  return sendAlert(level, subject, body);
}

/**
 * Send a reminder for IntelliConnect pools (can't automate).
 */
export async function alertManualReminder(
  propertyName: string,
  action: 'ON' | 'OFF',
  guestName: string,
  checkTime: string
) {
  const subject = `REMINDER: Turn heater ${action} — ${propertyName}`;
  const body = [
    `Property: ${propertyName}`,
    `Guest: ${guestName}`,
    `${action === 'ON' ? 'Check-in' : 'Check-out'}: ${checkTime}`,
    '',
    `Please turn the pool heater ${action} via the Pentair IntelliConnect app.`,
    'This pool cannot be automated — manual action required.',
  ].join('\n');

  return sendAlert('warning', subject, body);
}
