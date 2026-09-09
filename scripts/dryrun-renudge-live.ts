/**
 * Live dry-run of the re-nudge against a real OwnerRez thread.
 *
 * Reads real messages, runs the real classifier, and sends the real reminder
 * email — but to whatever ALERT_EMAIL is set in the environment, and against a
 * throwaway CONFIRM_STATE_PATH, so production state and Brady's inbox are
 * untouched. Never run this pointed at the production confirm state.
 *
 * Usage:
 *   ALERT_EMAIL=you@example.com CONFIRM_STATE_PATH=/tmp/dryrun.json \
 *     npx tsx scripts/dryrun-renudge-live.ts <threadId> <bookingId> <lastAskedIso>
 */
import { handleMessageWebhook, pendingConfirms, confirmAskedAt } from '../src/scheduler';

const [threadId, bookingId, lastAsked] = process.argv.slice(2);

if (!threadId || !bookingId) {
  console.error('usage: dryrun-renudge-live.ts <threadId> <bookingId> [lastAskedIso]');
  process.exit(1);
}
if (!process.env.CONFIRM_STATE_PATH || process.env.CONFIRM_STATE_PATH.includes('/root/pool-heat-manager/data')) {
  console.error('Refusing to run: set CONFIRM_STATE_PATH to a throwaway file.');
  process.exit(1);
}

async function main() {
  const id = Number(bookingId);
  if (lastAsked) {
    // Simulate "Brady was already emailed at this time" — the state that made
    // the system go quiet on the guest's yes.
    pendingConfirms.add(id);
    confirmAskedAt.set(id, Date.parse(lastAsked));
    console.log(`Seeded: pending=${id}, askedAt=${lastAsked}`);
  } else {
    console.log(`Seeded: no prior ask for ${id}`);
  }

  await handleMessageWebhook(Number(threadId), id);

  const asked = confirmAskedAt.get(id);
  console.log(`\nAfter: pending=${pendingConfirms.has(id)} askedAt=${asked ? new Date(asked).toISOString() : 'unset'}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
