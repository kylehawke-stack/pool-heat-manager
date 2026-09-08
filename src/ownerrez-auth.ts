/**
 * One-time OwnerRez OAuth authorisation, via the Device Authorization Grant.
 *
 * Run this on the server (where data/ownerrez-token.json needs to land):
 *
 *   npm run orz:auth
 *
 * It prints a short code, you approve it in a browser on any device, and the
 * resulting access + refresh tokens are written to data/ownerrez-token.json.
 * The device grant is used rather than the web flow because this app has no
 * browser and no need for a public redirect handler.
 *
 * Prerequisites (one-time, in OwnerRez):
 *   1. Settings → Developer/API → create an app.
 *      - OAuth API scope: Full   - Token expiration policy: Standard
 *      - Record the client id (c_...) and secret (s_...) — the secret is shown once.
 *   2. On the app's Users tab, click "Grant Access To Me". This is what enables
 *      the messaging endpoints for your own account; without it every /v2/messages
 *      call returns 402 messaging_not_enabled.
 *   3. Put OWNERREZ_CLIENT_ID / OWNERREZ_CLIENT_SECRET in .env.
 */

import { config } from './config';
import { saveToken, StoredToken } from './ownerrez';

const BASE = 'https://api.ownerrez.com';
const USER_AGENT = 'pool-heat-manager/1.0 (+https://github.com/kylehawke-stack/pool-heat-manager)';

function basicAuth(): string {
  const { clientId, clientSecret } = config.ownerrez;
  if (!clientId || !clientSecret) {
    throw new Error('Set OWNERREZ_CLIENT_ID and OWNERREZ_CLIENT_SECRET in .env first (see the header of this file).');
  }
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function post(pathname: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OwnerRez ${pathname} returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('Requesting device authorisation from OwnerRez...\n');

  const { json: dev } = await post('/oauth/device_authorization', {});
  if (!dev.device_code || !dev.user_code) {
    throw new Error(`Unexpected device_authorization response: ${JSON.stringify(dev)}`);
  }

  const verifyUrl = dev.verification_uri_complete
    || `https://app.ownerrez.com/oauth/device?user_code=${dev.user_code}`;

  console.log('─'.repeat(64));
  console.log(`  Open this URL while logged in to OwnerRez:\n`);
  console.log(`    ${verifyUrl}\n`);
  console.log(`  Code: ${dev.user_code}`);
  console.log('─'.repeat(64));
  console.log('\nWaiting for approval (polling every 5s, up to 10 minutes)...\n');

  const intervalMs = (Number(dev.interval) || 5) * 1000;
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const { status, json } = await post('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dev.device_code,
    });

    if (json.access_token) {
      const token: StoredToken = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: json.expires_in ? Date.now() + (json.expires_in - 300) * 1000 : undefined,
        user_id: json.user_id,
      };
      saveToken(token);

      console.log('✓ Authorised.');
      console.log(`  user: ${json.user_display_name || json.user_id}`);
      console.log(`  scope: ${json.scope}`);
      console.log(`  expires: ${token.expires_at ? new Date(token.expires_at).toISOString() : 'never'}`);
      console.log(`  refreshable: ${json.refresh_token_supported ?? Boolean(json.refresh_token)}`);
      console.log('\nSaved to data/ownerrez-token.json. Restart the service:');
      console.log('  pm2 restart pool-heat-manager');
      return;
    }

    if (json.error === 'authorization_pending' || json.error === 'slow_down') {
      process.stdout.write('.');
      continue;
    }

    throw new Error(`Authorisation failed (${status}): ${json.error} — ${json.error_description || ''}`);
  }

  throw new Error('Timed out waiting for approval. Re-run the command.');
}

main().catch(err => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
