import { RemoteLogin, UnitConnection, BodyIndex, HeatModes } from 'node-screenlogic';
import type { SLEquipmentStateData } from 'node-screenlogic';

interface PoolStatus {
  poolTemp: number;
  airTemp: number;
  poolHeatMode: number;
  poolSetPoint: number;
  isPoolHeaterOn: boolean;
}

/**
 * Connect to a ScreenLogic system via Pentair's cloud relay.
 * Uses the gateway name (e.g. "Pentair: XX-XX-XX") to find the system remotely.
 */
async function connectRemote(gatewayName: string, password?: string): Promise<UnitConnection> {
  const gateway = new RemoteLogin(gatewayName);
  const gatewayData = await gateway.connectAsync();

  if (!gatewayData || !gatewayData.gatewayFound || gatewayData.ipAddr === '') {
    throw new Error(`ScreenLogic gateway "${gatewayName}" not found via cloud relay`);
  }

  const client = new UnitConnection();
  client.init(gatewayName, gatewayData.ipAddr, gatewayData.port, password);
  await client.connectAsync();

  return client;
}

/**
 * Get current pool status (temperatures, heat mode).
 * Note: pool temp is only accurate when the pool pump is running.
 */
export async function getPoolStatus(gatewayName: string, password?: string): Promise<PoolStatus> {
  const client = await connectRemote(gatewayName, password);

  try {
    const state: SLEquipmentStateData = await client.equipment.getEquipmentStateAsync();
    const poolBody = state.bodies.find(b => b.id === BodyIndex.POOL) ?? state.bodies[0];

    return {
      poolTemp: poolBody?.currentTemp ?? 0,
      airTemp: state.airTemp ?? 0,
      poolHeatMode: poolBody?.heatMode ?? 0,
      poolSetPoint: poolBody?.setPoint ?? 0,
      isPoolHeaterOn: (poolBody?.heatStatus ?? 0) > 0,
    };
  } finally {
    await client.closeAsync();
  }
}

/**
 * Set the pool heater target temperature and turn on heating.
 */
export async function setPoolHeat(
  gatewayName: string,
  targetTemp: number,
  password?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const client = await connectRemote(gatewayName, password);

    try {
      // Set target temp and heat mode for pool body
      await client.bodies.setSetPointAsync(BodyIndex.POOL, targetTemp);
      await client.bodies.setHeatModeAsync(BodyIndex.POOL, HeatModes.HEAT_MODE_HEATER);

      // Verify by reading state back
      const state = await client.equipment.getEquipmentStateAsync();
      const poolBody = state.bodies.find(b => b.id === BodyIndex.POOL) ?? state.bodies[0];

      const currentSetPoint = poolBody?.setPoint ?? 0;
      const currentHeatMode = poolBody?.heatMode ?? 0;

      if (currentSetPoint === targetTemp && currentHeatMode === HeatModes.HEAT_MODE_HEATER) {
        return {
          success: true,
          message: `Heater ON — target ${targetTemp}°F, mode HEATER. Current pool temp: ${poolBody?.currentTemp ?? 'unknown'}°F`,
        };
      } else {
        return {
          success: false,
          message: `Commands sent but verification failed. SetPoint: ${currentSetPoint} (expected ${targetTemp}), Mode: ${currentHeatMode} (expected ${HeatModes.HEAT_MODE_HEATER})`,
        };
      }
    } finally {
      await client.closeAsync();
    }
  } catch (err: any) {
    return { success: false, message: `Failed to set pool heat: ${err.message}` };
  }
}

/**
 * Turn off the pool heater (set heat mode to OFF).
 */
export async function turnOffPoolHeat(
  gatewayName: string,
  password?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const client = await connectRemote(gatewayName, password);

    try {
      await client.bodies.setHeatModeAsync(BodyIndex.POOL, HeatModes.HEAT_MODE_OFF);

      // Verify
      const state = await client.equipment.getEquipmentStateAsync();
      const poolBody = state.bodies.find(b => b.id === BodyIndex.POOL) ?? state.bodies[0];

      if ((poolBody?.heatMode ?? -1) === HeatModes.HEAT_MODE_OFF) {
        return {
          success: true,
          message: `Heater OFF confirmed. Pool temp: ${poolBody?.currentTemp ?? 'unknown'}°F`,
        };
      } else {
        return {
          success: false,
          message: `Turn-off command sent but verification failed. Heat mode still: ${poolBody?.heatMode}`,
        };
      }
    } finally {
      await client.closeAsync();
    }
  } catch (err: any) {
    return { success: false, message: `Failed to turn off pool heat: ${err.message}` };
  }
}
