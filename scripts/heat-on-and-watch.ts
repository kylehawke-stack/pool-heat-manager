// Re-apply heat ON exactly as the executor does (schedule first, then body), then poll
// body state to see whether the mode reverts and whether the heater actually fires.
// Usage: npx tsx scripts/heat-on-and-watch.ts "Pentair: XX-XX-XX" 82 [minutes=10]
import { RemoteLogin, UnitConnection } from 'node-screenlogic';
import { setPoolHeat, updatePoolScheduleHeatOn } from '../src/screenlogic';

async function readBody(gatewayName: string) {
  const gw = await new RemoteLogin(gatewayName).connectAsync();
  const client = new UnitConnection();
  client.init(gatewayName, gw.ipAddr, gw.port, undefined);
  await client.connectAsync();
  try {
    const s = await client.equipment.getEquipmentStateAsync();
    const b = s.bodies.find(x => x.id === 1)!;
    const poolCircuit = s.circuitArray.find(c => c.id === 6)?.state;
    return `mode=${b.heatMode} status=${b.heatStatus} set=${b.setPoint} temp=${b.currentTemp} pumpCircuit=${poolCircuit} poolDelay=${s.poolDelay}`;
  } finally {
    await client.closeAsync();
  }
}

async function main() {
  const [gatewayName, tempArg, minArg] = process.argv.slice(2);
  const target = Number(tempArg);
  const minutes = Number(minArg ?? 10);
  console.log(new Date().toISOString(), 'BEFORE', await readBody(gatewayName));
  console.log(new Date().toISOString(), 'SCHED', (await updatePoolScheduleHeatOn(gatewayName, target)).message);
  console.log(new Date().toISOString(), 'BODY', (await setPoolHeat(gatewayName, target)).message);
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 30_000));
    try {
      console.log(new Date().toISOString(), 'POLL', await readBody(gatewayName));
    } catch (e: any) {
      console.log(new Date().toISOString(), 'POLL ERR', e.message);
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
