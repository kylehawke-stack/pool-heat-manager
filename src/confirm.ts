import crypto from 'crypto';
import { Resend } from 'resend';
import { config } from './config';
import { PropertyConfig } from './config';
import { Reservation, getConversationMessages } from './hostaway';

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

function getSecret(): string {
  const s = process.env.CONFIRM_SECRET;
  if (!s) throw new Error('CONFIRM_SECRET env var is required');
  return s;
}

export interface ConfirmPayload {
  r: number;                            // reservationId
  a: 'yes' | 'no' | 'undecided';        // answer; 'undecided' = snooze, keeps in pending queue and stops re-emailing Brady
  d: number | null;                     // heatDays (null = full stay; ignored when a='undecided' or 'no')
  e: number;                            // exp (unix ms)
}

export function signConfirm(payload: ConfirmPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyConfirm(token: string): ConfirmPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as ConfirmPayload;
    if (payload.e < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function publicUrl(path: string): string {
  const base = config.server.publicUrl || `http://localhost:${config.server.port}`;
  return `${base}${path}`;
}

function buildLink(reservationId: number, answer: 'yes' | 'no' | 'undecided', heatDays: number | null): string {
  const exp = Date.now() + 14 * 24 * 60 * 60 * 1000; // 14 days
  const token = signConfirm({ r: reservationId, a: answer, d: heatDays, e: exp });
  return publicUrl(`/confirm?t=${encodeURIComponent(token)}`);
}

/**
 * Email Brady with YES/NO links for an ambiguous pool-heat conversation.
 */
export async function sendConfirmRequest(reservation: Reservation, property: PropertyConfig): Promise<void> {
  if (!resend || !config.alerts.email) {
    console.error('[Confirm] Resend not configured — cannot send confirm email');
    return;
  }

  const messages = await getConversationMessages(reservation.id);
  const last6 = messages.slice(-6);
  const transcript = last6.map(m => {
    const who = m.isIncoming === 1 ? 'GUEST' : 'HOST';
    const body = (m.body || '').replace(/\n/g, ' ').slice(0, 300);
    return `<div style="margin:8px 0"><b style="color:${who==='GUEST'?'#0369a1':'#475569'}">${who}:</b> ${escapeHtml(body)}</div>`;
  }).join('');

  const yesFull = buildLink(reservation.id, 'yes', null);
  const yes1 = buildLink(reservation.id, 'yes', 1);
  const yes2 = buildLink(reservation.id, 'yes', 2);
  const yes3 = buildLink(reservation.id, 'yes', 3);
  const undecided = buildLink(reservation.id, 'undecided', null);
  const no = buildLink(reservation.id, 'no', null);

  const nights = daysBetween(reservation.arrivalDate, reservation.departureDate);

  const html = `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#0f172a">
  <h2 style="margin:0 0 4px 0;color:#0f172a">Confirm pool heat?</h2>
  <p style="color:#64748b;margin:0 0 16px 0">I couldn't automatically classify this conversation. Please confirm.</p>

  <div style="background:#f1f5f9;border-radius:8px;padding:16px;margin-bottom:16px">
    <div><b>${escapeHtml(property.name)}</b></div>
    <div>${escapeHtml(reservation.guestName)}</div>
    <div style="color:#64748b">${reservation.arrivalDate} → ${reservation.departureDate} (${nights} night${nights===1?'':'s'})</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:20px;font-size:14px">
    <div style="color:#64748b;font-size:12px;margin-bottom:6px">Recent messages:</div>
    ${transcript}
  </div>

  <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
    <a href="${yesFull}" style="background:#16a34a;color:#fff;padding:12px;border-radius:6px;text-align:center;text-decoration:none;font-weight:600">✓ YES — full stay (${nights} night${nights===1?'':'s'})</a>
    <a href="${yes1}" style="background:#0369a1;color:#fff;padding:10px;border-radius:6px;text-align:center;text-decoration:none">✓ YES — 1 day</a>
    <a href="${yes2}" style="background:#0369a1;color:#fff;padding:10px;border-radius:6px;text-align:center;text-decoration:none">✓ YES — 2 days</a>
    <a href="${yes3}" style="background:#0369a1;color:#fff;padding:10px;border-radius:6px;text-align:center;text-decoration:none">✓ YES — 3 days</a>
    <a href="${undecided}" style="background:#7c3aed;color:#fff;padding:12px;border-radius:6px;text-align:center;text-decoration:none;font-weight:600">? Guest undecided — snooze (I'll follow up myself)</a>
    <a href="${no}" style="background:#dc2626;color:#fff;padding:12px;border-radius:6px;text-align:center;text-decoration:none;font-weight:600">✗ NO — decline</a>
  </div>
  <p style="color:#94a3b8;font-size:12px;margin:0">Links expire in 14 days. Reservation ID ${reservation.id}.</p>
</div>`;

  await resend.emails.send({
    from: config.resend.fromAddress,
    to: config.alerts.email,
    subject: `❓ Confirm pool heat — ${property.name} — ${reservation.guestName} (${reservation.arrivalDate})`,
    html,
  });
  console.log(`[Confirm] Sent email for reservation ${reservation.id} (${reservation.guestName})`);
}

function daysBetween(a: string, b: string): number {
  const toMs = (d: string) => new Date(d + 'T00:00:00Z').getTime();
  return Math.round((toMs(b) - toMs(a)) / (1000 * 60 * 60 * 24));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!));
}
