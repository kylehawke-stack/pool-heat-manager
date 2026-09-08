import Anthropic from '@anthropic-ai/sdk';
import twilio from 'twilio';
import { config, properties } from './config';
import { getAllUpcomingReservations, getConversationMessages, getReservation } from './ownerrez';
import { scanMessagesForPoolHeat } from './detect';
import { getScheduleState, pendingConfirms, declinedReservations } from './scheduler';

const anthropic = config.anthropic.apiKey ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;
const twilioClient = config.twilio.accountSid
  ? twilio(config.twilio.accountSid, config.twilio.authToken)
  : null;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_upcoming_reservations',
    description: 'List all upcoming reservations across the 3 pool properties (Marshall House, Elmwood, Boho Mountain) sorted by arrival date.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'Only include reservations within this many days. Default 30.' },
      },
    },
  },
  {
    name: 'get_reservation_detail',
    description: 'Get a single reservation with its pool heat status, messages, and scheduled events.',
    input_schema: {
      type: 'object',
      properties: {
        reservation_id: { type: 'number' },
      },
      required: ['reservation_id'],
    },
  },
  {
    name: 'get_current_schedule',
    description: 'Get all pending and executed heater ON/OFF/RECALCULATE events.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_guest_by_name',
    description: 'Search upcoming reservations for a guest by partial name match.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

async function runTool(name: string, input: any): Promise<string> {
  switch (name) {
    case 'list_upcoming_reservations': {
      const days = input.days_ahead || 30;
      const cutoff = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
      const rs = await getAllUpcomingReservations(properties.map(p => p.ownerrezPropertyId));
      const filtered = rs.filter(r => r.arrivalDate <= cutoff);
      const propName: Record<number, string> = {};
      properties.forEach(p => { propName[p.ownerrezPropertyId] = p.name; });
      return JSON.stringify(filtered.map(r => ({
        id: r.id,
        property: propName[r.listingMapId],
        guest: r.guestName,
        arrival: r.arrivalDate,
        departure: r.departureDate,
      })));
    }
    case 'get_reservation_detail': {
      const r = await getReservation(input.reservation_id);
      const messages = await getConversationMessages(r.id);
      const scan = scanMessagesForPoolHeat(messages);
      const state = getScheduleState();
      const events = [...state.pending, ...state.executed].filter(e => e.reservationId === r.id);
      const propName = properties.find(p => p.ownerrezPropertyId === r.listingMapId)?.name || 'Unknown';
      const lastMsgs = messages.slice(-5).map(m => ({
        from: m.isIncoming === 1 ? 'guest' : 'host',
        date: (m.insertedOn || '').slice(0, 19),
        body: (m.body || '').slice(0, 300),
      }));
      return JSON.stringify({
        id: r.id,
        property: propName,
        guest: r.guestName,
        arrival: r.arrivalDate,
        departure: r.departureDate,
        heat_scan: scan,
        awaiting_confirm: pendingConfirms.has(r.id),
        declined: declinedReservations.has(r.id),
        events: events.map(e => ({ action: e.action, time: e.scheduledTime, executed: e.executed })),
        recent_messages: lastMsgs,
      });
    }
    case 'get_current_schedule': {
      const state = getScheduleState();
      return JSON.stringify({
        pending: state.pending.map(e => ({
          property: e.propertyName,
          action: e.action,
          time: e.scheduledTime,
          guest: e.guestName,
          reservation_id: e.reservationId,
        })),
        executed_count: state.executed.length,
      });
    }
    case 'search_guest_by_name': {
      const rs = await getAllUpcomingReservations(properties.map(p => p.ownerrezPropertyId));
      const needle = (input.name || '').toLowerCase();
      const propName: Record<number, string> = {};
      properties.forEach(p => { propName[p.ownerrezPropertyId] = p.name; });
      const matches = rs.filter(r => r.guestName.toLowerCase().includes(needle));
      return JSON.stringify(matches.map(r => ({
        id: r.id,
        property: propName[r.listingMapId],
        guest: r.guestName,
        arrival: r.arrivalDate,
        departure: r.departureDate,
      })));
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

const SYSTEM_PROMPT = `You are a concise SMS assistant for Brady's pool heat automation system.
He manages 3 short-term-rental properties with pools: Marshall House (ScreenLogic), Elmwood (ScreenLogic), Boho Mountain (IntelliConnect — manual only).

The system watches Hostaway messages, detects when guests agree to pool heat, and schedules heater ON/OFF via Pentair.

Brady texts you questions. Answer in 1-3 short sentences. Be direct. Use local ET times (e.g. "Fri 1pm"). When unsure, use tools to check state.
Never invent reservation details. If a reservation isn't in the data, say so.
Keep responses under 300 characters when possible (SMS-friendly).`;

export async function answerSmsQuery(query: string): Promise<string> {
  if (!anthropic) return 'Claude API not configured (missing ANTHROPIC_API_KEY).';

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: query }];

  for (let step = 0; step < 6; step++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const text = response.content.filter(c => c.type === 'text').map(c => (c as any).text).join('').trim();
      return text || 'No response.';
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          try {
            const result = await runTool(block.name, block.input);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          } catch (err: any) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
          }
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  return 'Ran out of steps. Please rephrase.';
}

/**
 * Twilio webhook handler. Validates signature, checks allowed number, runs query, sends SMS reply.
 */
export async function handleInboundSms(from: string, body: string, signature: string, fullUrl: string, rawParams: Record<string, string>): Promise<string> {
  // Verify Twilio signature (defense against spoofed requests)
  if (config.twilio.authToken && signature) {
    const valid = twilio.validateRequest(config.twilio.authToken, signature, fullUrl, rawParams);
    if (!valid) {
      console.warn(`[SMS] Invalid Twilio signature from ${from}`);
      return '<Response></Response>';
    }
  }

  // Only allow Brady's configured phone number
  const allowed = config.alerts.phone;
  if (allowed && normalizePhone(from) !== normalizePhone(allowed)) {
    console.warn(`[SMS] Rejected inbound from ${from} (not ${allowed})`);
    return '<Response></Response>';
  }

  console.log(`[SMS] From ${from}: ${body}`);

  // Respond immediately (Twilio needs <15s), then async-send the real reply
  answerSmsQuery(body).then(async (answer) => {
    if (!twilioClient) return;
    try {
      await twilioClient.messages.create({
        body: answer.slice(0, 1500),
        from: config.twilio.fromNumber,
        to: from,
      });
    } catch (err: any) {
      console.error(`[SMS] Failed to reply: ${err.message}`);
    }
  }).catch(err => console.error(`[SMS] Query error: ${err.message}`));

  // Empty TwiML — we reply via REST async
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function normalizePhone(p: string): string {
  return p.replace(/[^\d]/g, '');
}
