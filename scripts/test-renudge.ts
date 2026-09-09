/**
 * Decision table for the confirm re-nudge (scheduler.decideConfirmAction).
 *
 * Run: npx tsx scripts/test-renudge.ts
 *
 * The case that matters is VASILIKI: already pending from an earlier message,
 * guest sends the actual yes days later, and the old code stayed silent because
 * it had already asked once (2026-09-09).
 */
import { decideConfirmAction, RENUDGE_COOLDOWN_MS, ConfirmDecision } from '../src/scheduler';

const NOW = Date.parse('2026-09-09T14:40:00Z');
const H = 60 * 60 * 1000;

const cases: Array<{
  name: string;
  input: Parameters<typeof decideConfirmAction>[0];
  expect: ConfirmDecision;
}> = [
  {
    name: 'VASILIKI — pending since yesterday, guest said yes today',
    input: { scheduled: false, declined: false, alreadyAsked: true, askedAt: Date.parse('2026-09-08T22:19:00Z'), latestGuestMs: Date.parse('2026-09-09T13:26:47Z'), now: NOW },
    expect: 'remind',
  },
  {
    name: 'first ambiguous conversation — never asked',
    input: { scheduled: false, declined: false, alreadyAsked: false, askedAt: 0, latestGuestMs: NOW - 5 * 60 * 1000, now: NOW },
    expect: 'send',
  },
  {
    name: 'pending, guest silent since the ask — no repeat email every scan',
    input: { scheduled: false, declined: false, alreadyAsked: true, askedAt: NOW - 6 * H, latestGuestMs: NOW - 7 * H, now: NOW },
    expect: 'skip-nothing-new',
  },
  {
    name: 'guest message exactly at the ask time is not new',
    input: { scheduled: false, declined: false, alreadyAsked: true, askedAt: NOW - 3 * H, latestGuestMs: NOW - 3 * H, now: NOW },
    expect: 'skip-nothing-new',
  },
  {
    name: 'chatty guest — second message inside the hour is held',
    input: { scheduled: false, declined: false, alreadyAsked: true, askedAt: NOW - 10 * 60 * 1000, latestGuestMs: NOW - 60 * 1000, now: NOW },
    expect: 'skip-cooldown',
  },
  {
    name: 'cooldown just expired',
    input: { scheduled: false, declined: false, alreadyAsked: true, askedAt: NOW - RENUDGE_COOLDOWN_MS, latestGuestMs: NOW - 30 * 60 * 1000, now: NOW },
    expect: 'remind',
  },
  {
    name: 'declined booking is never re-raised, however loudly the guest asks',
    input: { scheduled: false, declined: true, alreadyAsked: true, askedAt: NOW - 48 * H, latestGuestMs: NOW - 60 * 1000, now: NOW },
    expect: 'skip-declined',
  },
  {
    name: 'declined wins even on a first ask',
    input: { scheduled: false, declined: true, alreadyAsked: false, askedAt: 0, latestGuestMs: NOW, now: NOW },
    expect: 'skip-declined',
  },
  {
    name: 'host-only activity (no guest message) does not nudge',
    input: { scheduled: false, declined: false, alreadyAsked: true, askedAt: NOW - 5 * H, latestGuestMs: null, now: NOW },
    expect: 'skip-nothing-new',
  },
  {
    name: 'backlog with no recorded ask time gets one reminder',
    input: { scheduled: false, declined: false, alreadyAsked: true, askedAt: 0, latestGuestMs: Date.parse('2026-09-02T12:00:00Z'), now: NOW },
    expect: 'remind',
  },
  {
    name: 'VASILIKI after YES — heat scheduled, thread still reads pending, no re-ask',
    input: { scheduled: true, declined: false, alreadyAsked: false, askedAt: 0, latestGuestMs: Date.parse('2026-09-09T13:26:47Z'), now: NOW },
    expect: 'skip-scheduled',
  },
  {
    name: 'scheduled booking with a brand-new guest message still does not re-ask',
    input: { scheduled: true, declined: false, alreadyAsked: true, askedAt: NOW - 6 * H, latestGuestMs: NOW - 60 * 1000, now: NOW },
    expect: 'skip-scheduled',
  },
  {
    name: 'declined outranks scheduled',
    input: { scheduled: true, declined: true, alreadyAsked: false, askedAt: 0, latestGuestMs: NOW, now: NOW },
    expect: 'skip-declined',
  },
];

let failed = 0;
for (const c of cases) {
  const got = decideConfirmAction(c.input);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : ` — expected ${c.expect}, got ${got}`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
