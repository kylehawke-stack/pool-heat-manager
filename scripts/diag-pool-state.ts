// Read-only: dump live ScreenLogic state for one property (bodies, circuits, schedules, controller clock).
// Usage: npx tsx scripts/diag-pool-state.ts "Pentair: XX-XX-XX"
import { RemoteLogin, UnitConnection, SchedTypes } from 'node-screenlogic';

async function main() {
  const gatewayName = process.argv[2];
  if (!gatewayName) throw new Error('gateway name required');
  const gw = await new RemoteLogin(gatewayName).connectAsync();
  if (!gw?.gatewayFound) throw new Error('gateway not found');
  const client = new UnitConnection();
  client.init(gatewayName, gw.ipAddr, gw.port, undefined);
  await client.connectAsync();
  try {
    const time = await client.equipment.getSystemTimeAsync();
    const state = await client.equipment.getEquipmentStateAsync();
    const config: any = await client.equipment.getControllerConfigAsync();
    const recurring = await client.schedule.getScheduleDataAsync(SchedTypes.RECURRING);
    const runOnce = await client.schedule.getScheduleDataAsync(SchedTypes.RUNONCE);
    const names = new Map<number, string>((config.circuitArray ?? []).map((c: any) => [c.circuitId, `${c.name} (fn=${c.function})`]));
    console.log(JSON.stringify({
      controllerTime: time,
      airTemp: state.airTemp,
      freezeMode: state.freezeMode,
      poolDelay: state.poolDelay,
      alarms: state.alarms,
      bodies: state.bodies,
      circuitsOn: state.circuitArray.filter(c => c.state).map(c => ({ id: c.id, name: names.get(c.id) })),
      allCircuits: (config.circuitArray ?? []).map((c: any) => ({ id: c.circuitId, name: c.name, fn: c.function, on: state.circuitArray.find(s => s.id === c.circuitId)?.state })),
      heaterConfig: config.heaterConfig ?? config.equipFlags,
      recurring: recurring.data,
      runOnce: runOnce.data,
    }, null, 2));
  } finally {
    await client.closeAsync();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
