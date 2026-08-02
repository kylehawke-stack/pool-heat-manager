import { Resend } from 'resend';
import { config, properties } from './config';
import { getAllUpcomingReservations, getConversationMessages, scanMessagesForPoolHeat } from './hostaway';
import { getScheduleState, pendingConfirms, declinedReservations } from './scheduler';

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

/**
 * Build and send the weekly digest: upcoming 14 days across all properties,
 * with heat status and scheduled ON/OFF events.
 */
export async function sendWeeklyDigest(): Promise<void> {
  if (!resend || !config.alerts.email) {
    console.error('[Digest] Resend not configured');
    return;
  }

  const html = await buildDigestHtml();
  await resend.emails.send({
    from: config.resend.fromAddress,
    to: config.alerts.email,
    subject: `Pool Heat Weekly Digest — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}`,
    html,
  });
  console.log('[Digest] Sent weekly digest');
}

export async function buildDigestHtml(): Promise<string> {
  const listingIds = properties.map(p => p.hostawayListingId);
  const allReservations = await getAllUpcomingReservations(listingIds);
  const in14 = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const upcoming = allReservations.filter(r => r.arrivalDate <= in14);

  const state = getScheduleState();
  const eventsByReservation = new Map<number, typeof state.pending>();
  for (const e of [...state.pending, ...state.executed]) {
    const arr = eventsByReservation.get(e.reservationId) || [];
    arr.push(e);
    eventsByReservation.set(e.reservationId, arr);
  }

  const propertyName: Record<number, string> = {};
  for (const p of properties) propertyName[p.hostawayListingId] = p.name;

  const rows = await Promise.all(upcoming.map(async (r) => {
    const messages = await getConversationMessages(r.id);
    const scan = scanMessagesForPoolHeat(messages);
    const events = eventsByReservation.get(r.id) || [];
    const statusBadge = renderStatus(scan.status, pendingConfirms.has(r.id), declinedReservations.has(r.id), events.length > 0);
    const timezoneOfProp = properties.find(p => p.hostawayListingId === r.listingMapId)?.timezone || 'America/New_York';
    const isIntelliConnect = properties.find(p => p.hostawayListingId === r.listingMapId)?.poolSystem === 'intelliconnect';
    const eventsHtml = events.filter(e => e.action !== 'RECALCULATE').map(e =>
      `<div style="font-size:13px;color:${e.executed?'#94a3b8':'#0f172a'}">${e.action}: ${new Date(e.scheduledTime).toLocaleString('en-US', { timeZone: timezoneOfProp, weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}${e.executed?' <span style="color:#94a3b8">(done)</span>':''}</div>`
    ).join('') || '<div style="color:#94a3b8;font-size:13px">—</div>';

    return `
<tr style="border-top:1px solid #e2e8f0">
  <td style="padding:12px 8px;vertical-align:top">
    <div style="font-weight:600">${escapeHtml(propertyName[r.listingMapId] || 'Unknown')}</div>
    ${isIntelliConnect ? '<div style="font-size:11px;color:#dc2626">⚠ IntelliConnect (manual)</div>' : ''}
  </td>
  <td style="padding:12px 8px;vertical-align:top">
    <div>${escapeHtml(r.guestName)}</div>
    <div style="font-size:12px;color:#64748b">${r.arrivalDate} → ${r.departureDate}</div>
  </td>
  <td style="padding:12px 8px;vertical-align:top">${statusBadge}</td>
  <td style="padding:12px 8px;vertical-align:top">${eventsHtml}</td>
</tr>`;
  }));

  const manualActionFlags: string[] = [];
  for (const r of upcoming) {
    const p = properties.find(pp => pp.hostawayListingId === r.listingMapId);
    if (!p) continue;
    if (p.poolSystem === 'intelliconnect') {
      const events = eventsByReservation.get(r.id) || [];
      const onEvent = events.find(e => e.action === 'ON' && !e.executed);
      if (onEvent) {
        manualActionFlags.push(`<li><b>${p.name}</b> — turn heater ON ${new Date(onEvent.scheduledTime).toLocaleString('en-US', { timeZone: p.timezone, weekday:'short', hour:'numeric', minute:'2-digit' })} for ${escapeHtml(r.guestName)}</li>`);
      }
    }
  }

  return `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#0f172a">
  <h1 style="margin:0 0 4px 0">Weekly Pool Heat Digest</h1>
  <p style="color:#64748b;margin:0 0 20px 0">Next 14 days across ${properties.length} properties</p>

  ${manualActionFlags.length > 0 ? `
  <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:4px;margin-bottom:20px">
    <div style="font-weight:600;margin-bottom:8px">⚠ Manual actions this week</div>
    <ul style="margin:0;padding-left:20px">${manualActionFlags.join('')}</ul>
  </div>` : ''}

  <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
    <thead>
      <tr style="background:#f8fafc">
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">Property</th>
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">Guest & Stay</th>
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">Heat Status</th>
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">Schedule</th>
      </tr>
    </thead>
    <tbody>${rows.join('')}</tbody>
  </table>

  <p style="color:#94a3b8;font-size:12px;margin-top:24px">Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET.</p>
</div>`;
}

function renderStatus(status: string, awaitingConfirm: boolean, declined: boolean, scheduled: boolean): string {
  if (declined) return badge('declined', '#dc2626', '#fee2e2');
  if (scheduled) return badge('scheduled ✓', '#065f46', '#d1fae5');
  if (awaitingConfirm) return badge('awaiting your confirm', '#b45309', '#fef3c7');
  if (status === 'agreed') return badge('agreed', '#065f46', '#d1fae5');
  if (status === 'declined') return badge('declined', '#dc2626', '#fee2e2');
  if (status === 'pending') return badge('unclear — needs confirm', '#b45309', '#fef3c7');
  return badge('not discussed', '#475569', '#e2e8f0');
}

function badge(text: string, color: string, bg: string): string {
  return `<span style="background:${bg};color:${color};padding:3px 8px;border-radius:10px;font-size:12px;font-weight:600">${text}</span>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!));
}
