import crypto from 'crypto';
import { config } from './config';

/**
 * Signed one-click override tokens for smart-timing alert emails.
 *
 * Same trust model as `confirm.ts` (Brady-only links from his inbox), so we
 * reuse the CONFIRM_SECRET env var rather than juggle two secrets.
 *
 * Action is a string discriminator so we can add more override types later
 * (cancel auto, set explicit heat hours, etc.) without changing the URL shape.
 */
export interface OverridePayload {
  r: number;        // reservationId
  a: 'delay-on';    // action discriminator
  h: number;        // delay amount in hours (for 'delay-on')
  e: number;        // exp (unix ms)
}

function getSecret(): string {
  const s = process.env.OVERRIDE_SECRET || process.env.CONFIRM_SECRET;
  if (!s) throw new Error('OVERRIDE_SECRET or CONFIRM_SECRET env var is required');
  return s;
}

export function signOverride(payload: OverridePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyOverride(token: string): OverridePayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as OverridePayload;
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

export function buildDelayOnLink(reservationId: number, hours: number): string {
  // 7-day expiry — smart-timing alerts only matter for ON events within ~72h
  // anyway, so a week of slack is plenty.
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const token = signOverride({ r: reservationId, a: 'delay-on', h: hours, e: exp });
  return publicUrl(`/delay-on?t=${encodeURIComponent(token)}`);
}

/**
 * Render the inline "delay heater ON" button row for HTML alert emails.
 * Returns empty string if reservationId is missing (e.g., non-smart-timing alerts).
 */
export function renderDelayButtons(reservationId: number | null): string {
  if (reservationId == null) return '';
  const opts: Array<{ hours: number; label: string }> = [
    { hours: 6, label: 'Delay 6h' },
    { hours: 12, label: 'Delay 12h' },
    { hours: 24, label: 'Delay 24h' },
  ];
  const buttons = opts.map(o => {
    const href = buildDelayOnLink(reservationId, o.hours);
    return `<a href="${href}" style="background:#0369a1;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;margin:4px 6px 4px 0">${o.label}</a>`;
  }).join('');
  return `
<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0">
  <div style="color:#475569;font-size:13px;margin-bottom:8px">Override this plan? Push the heater ON event later:</div>
  ${buttons}
  <div style="color:#94a3b8;font-size:11px;margin-top:8px">Each click delays from the current ON time. Capped at check-in − 2h. Safety re-checks (T-24/T-12/T-6) auto-realign. Links expire in 7 days.</div>
</div>`;
}

/**
 * Render the full HTML body for a smart-timing alert (informational text +
 * delay buttons). Plain-text lines mirror what goes into the email's `text`
 * fallback and into SMS.
 */
export function renderSmartTimingHtml(
  subject: string,
  lines: string[],
  reservationId: number | null,
  level: 'info' | 'warning' | 'error',
): string {
  const headerColor = level === 'warning' ? '#b45309' : level === 'error' ? '#b91c1c' : '#0f172a';
  const textLines = lines.map(l => l === '' ? '<div style="height:8px"></div>' : `<div>${escapeHtml(l)}</div>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;background:#f8fafc">
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#0f172a;background:#fff">
  <h2 style="margin:0 0 12px 0;color:${headerColor};font-size:18px">${escapeHtml(subject)}</h2>
  <div style="font-size:14px;line-height:1.55;color:#0f172a">${textLines}</div>
  ${renderDelayButtons(reservationId)}
</div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!));
}
