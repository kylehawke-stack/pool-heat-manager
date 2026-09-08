/**
 * Inspect and register OwnerRez webhook subscriptions.
 *
 *   npm run orz:webhooks           # list current subscriptions
 *   npm run orz:webhooks -- setup  # subscribe to guest messages + bookings
 *   npm run orz:webhooks -- delete <id>
 *
 * Webhooks are OAuth-app only — run `npm run orz:auth` first. The subscription
 * URL is PUBLIC_URL + /webhook/ownerrez, and OwnerRez authenticates to it with
 * the Webhook User/Password configured on the app (match WEBHOOK_LOGIN /
 * WEBHOOK_PASSWORD in .env, which is what verifyWebhookAuth checks).
 *
 * Note that an individual subscription created here OVERRIDES the app's global
 * webhook URL for that type, so listing before changing anything matters.
 */

import { config } from './config';
import { listWebhookSubscriptions, registerWebhookSubscription, deleteWebhookSubscription } from './ownerrez';

async function list(): Promise<void> {
  const subs = await listWebhookSubscriptions();
  if (!subs.length) {
    console.log('No webhook subscriptions. The app\'s global Webhook URL (if set) receives everything.');
    return;
  }
  for (const s of subs) {
    console.log(`  #${s.id}  type=${s.type}  action=${s.action}  category=${s.category ?? 'all'}  url=${s.webhook_url}`);
  }
}

async function setup(): Promise<void> {
  const base = config.server.publicUrl;
  if (!base) throw new Error('PUBLIC_URL is not set — the webhook needs a public https URL to post to.');
  const url = `${base.replace(/\/$/, '')}/webhook/ownerrez`;

  // Guest messages are the detection path; booking creates/updates catch new
  // stays and cancellations. Booking updates are noisy but the handler filters.
  const wanted: Array<['message' | 'booking', 'entity_create' | 'entity_update']> = [
    ['message', 'entity_create'],
    ['booking', 'entity_create'],
    ['booking', 'entity_update'],
  ];

  for (const [type, action] of wanted) {
    const created = await registerWebhookSubscription(url, type, action);
    console.log(`✓ subscribed ${type}/${action} → ${url} (#${created?.id})`);
  }
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'setup') {
    await setup();
    console.log('\nCurrent subscriptions:');
    await list();
  } else if (cmd === 'delete') {
    if (!arg) throw new Error('Usage: npm run orz:webhooks -- delete <id>');
    await deleteWebhookSubscription(Number(arg));
    console.log(`✓ deleted subscription ${arg}`);
  } else {
    await list();
  }
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
