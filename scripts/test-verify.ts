/**
 * Decision table for the post-command VERIFY check (scheduler.decideVerifyAction).
 *
 * Run: npx tsx scripts/test-verify.ts
 *
 * The case that matters is ELMWOOD: ON read back HEATER at 12:13 ET on
 * 2026-09-14, the email said SUCCESS, and by 12:20 the mode was OFF with the
 * burner never having fired (2026-09-14, Charmaine Irizarry).
 */
import { decideVerifyAction, VerifyDecision } from '../src/scheduler';

type Input = Parameters<typeof decideVerifyAction>[0];
const on = (o: Partial<Input>): Input =>
  ({ verifyOf: 'ON', heatMode: 3, setPoint: 82, poolTemp: 77, firing: true, targetTemp: 82, round: 1, ...o });
const off = (o: Partial<Input>): Input =>
  ({ verifyOf: 'OFF', heatMode: 0, setPoint: 82, poolTemp: 80, firing: false, targetTemp: 82, round: 1, ...o });

const cases: Array<{ name: string; input: Input; expect: VerifyDecision }> = [
  { name: 'ELMWOOD: ON reverted to OFF, round 1 → re-apply', input: on({ heatMode: 0, firing: false }), expect: 'reapply' },
  { name: 'ON reverted on round 2 → re-apply again', input: on({ heatMode: 0, firing: false, round: 2 }), expect: 'reapply' },
  { name: 'ON reverted on final round → manual', input: on({ heatMode: 0, firing: false, round: 3 }), expect: 'fail-reverted' },
  { name: 'ON set point changed by someone → re-apply', input: on({ setPoint: 78 }), expect: 'reapply' },
  { name: 'ON held, burner firing → confirmed', input: on({}), expect: 'confirmed' },
  { name: 'ON held, pool already at target, idle → at-temp', input: on({ poolTemp: 82, firing: false }), expect: 'at-temp' },
  { name: 'ON held, pool above target, idle → at-temp', input: on({ poolTemp: 84, firing: false }), expect: 'at-temp' },
  { name: 'ON held, not firing yet, round 1 → recheck quietly', input: on({ firing: false }), expect: 'recheck' },
  { name: 'ON held, still not firing round 2 → propane/pump alert', input: on({ firing: false, round: 2 }), expect: 'fail-not-firing' },
  { name: 'ON held, pool temp unknown (0), not firing → recheck (not at-temp)', input: on({ poolTemp: 0, firing: false }), expect: 'recheck' },
  { name: 'Solar mode is not HEATER → re-apply', input: on({ heatMode: 1, firing: false }), expect: 'reapply' },
  { name: 'OFF held → confirmed', input: off({}), expect: 'confirmed' },
  { name: 'OFF reverted to HEATER → re-apply', input: off({ heatMode: 3, firing: true }), expect: 'reapply' },
  { name: 'OFF reverted on final round → manual', input: off({ heatMode: 3, round: 3 }), expect: 'fail-reverted' },
];

let failed = 0;
for (const c of cases) {
  const got = decideVerifyAction(c.input);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : `  (got ${got}, expected ${c.expect})`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
