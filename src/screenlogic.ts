import { RemoteLogin, UnitConnection, BodyIndex, HeatModes, SchedTypes } from 'node-screenlogic';
import type { SLEquipmentStateData, SLScheduleDatum } from 'node-screenlogic';

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
 * If the heater is already on (e.g. manually turned on), it stays on
 * and we just update the set point if needed.
 */
export async function setPoolHeat(
  gatewayName: string,
  targetTemp: number,
  password?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const client = await connectRemote(gatewayName, password);

    try {
      // Check current state first
      const currentState = await client.equipment.getEquipmentStateAsync();
      const poolBody = currentState.bodies.find(b => b.id === BodyIndex.POOL) ?? currentState.bodies[0];
      const alreadyHeating = (poolBody?.heatStatus ?? 0) > 0;
      const currentSetPoint = poolBody?.setPoint ?? 0;

      if (alreadyHeating && currentSetPoint === targetTemp) {
        // Already on at the right temp — leave it alone
        await client.closeAsync();
        return {
          success: true,
          message: `Heater already ON at ${targetTemp}°F — no changes needed. Pool temp: ${poolBody?.currentTemp ?? 'unknown'}°F`,
        };
      }

      // Set target temp and heat mode for pool body
      await client.bodies.setSetPointAsync(BodyIndex.POOL, targetTemp);
      await client.bodies.setHeatModeAsync(BodyIndex.POOL, HeatModes.HEAT_MODE_HEATER);

      // Verify by reading state back
      const verifyState = await client.equipment.getEquipmentStateAsync();
      const verifyBody = verifyState.bodies.find(b => b.id === BodyIndex.POOL) ?? verifyState.bodies[0];

      const verifySetPoint = verifyBody?.setPoint ?? 0;
      const verifyHeatMode = verifyBody?.heatMode ?? 0;

      if (verifySetPoint === targetTemp && verifyHeatMode === HeatModes.HEAT_MODE_HEATER) {
        const prefix = alreadyHeating ? 'Heater was already running — updated' : 'Heater ON';
        return {
          success: true,
          message: `${prefix} — target ${targetTemp}°F, mode HEATER. Current pool temp: ${verifyBody?.currentTemp ?? 'unknown'}°F`,
        };
      } else {
        return {
          success: false,
          message: `Commands sent but verification failed. SetPoint: ${verifySetPoint} (expected ${targetTemp}), Mode: ${verifyHeatMode} (expected ${HeatModes.HEAT_MODE_HEATER})`,
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

// --- Pentair Schedule Management ---

/** Convert decoded time string "HHMM" back to minutes since midnight. */
function timeStringToMinutes(t: string): number {
  return parseInt(t.substring(0, 2)) * 60 + parseInt(t.substring(2, 4));
}

interface PoolScheduleInfo {
  poolCircuitId: number;
  schedule: {
    scheduleId: number;
    circuitId: number;
    startTime: number;
    stopTime: number;
    dayMask: number;
    flags: number;
    heatCmd: number;
    heatSetPoint: number;
  };
}

/**
 * Discover the pool circuit and its recurring schedule dynamically.
 * Finds the circuit with function=2 (Pool), then finds its recurring schedule.
 */
async function discoverPoolSchedule(client: UnitConnection): Promise<PoolScheduleInfo> {
  const equipConfig = await client.equipment.getControllerConfigAsync();
  const circuitArray = (equipConfig as any).circuitArray as Array<{ circuitId: number; function: number; name: string }>;
  if (!circuitArray) {
    throw new Error('No circuitArray in controller config');
  }

  const poolCircuit = circuitArray.find(c => c.function === 2);
  if (!poolCircuit) {
    throw new Error('No pool circuit found (function=2)');
  }

  const schedules = await client.schedule.getScheduleDataAsync(SchedTypes.RECURRING);
  const poolSchedule = schedules.data.find(s => s.circuitId === poolCircuit.circuitId);
  if (!poolSchedule) {
    throw new Error(`No recurring schedule found for pool circuit ${poolCircuit.circuitId} ("${poolCircuit.name}")`);
  }

  return {
    poolCircuitId: poolCircuit.circuitId,
    schedule: {
      scheduleId: poolSchedule.scheduleId,
      circuitId: poolSchedule.circuitId,
      startTime: timeStringToMinutes(poolSchedule.startTime),
      stopTime: timeStringToMinutes(poolSchedule.stopTime),
      dayMask: poolSchedule.dayMask,
      flags: poolSchedule.flags,
      heatCmd: poolSchedule.heatCmd,
      heatSetPoint: poolSchedule.heatSetPoint,
    },
  };
}

/**
 * Update the Pentair controller's pool schedule to enable heating.
 * Keeps all existing schedule settings (time, days, flags) but sets
 * heatCmd=HEATER and heatSetPoint to the target temp.
 */
export async function updatePoolScheduleHeatOn(
  gatewayName: string,
  targetTemp: number,
  password?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const client = await connectRemote(gatewayName, password);
    try {
      const { poolCircuitId, schedule: s } = await discoverPoolSchedule(client);

      await client.schedule.setScheduleEventByIdAsync(
        s.scheduleId, s.circuitId, s.startTime, s.stopTime,
        s.dayMask, s.flags, HeatModes.HEAT_MODE_HEATER, targetTemp
      );

      return {
        success: true,
        message: `Schedule #${s.scheduleId} (circuit ${poolCircuitId}) updated: heater ON at ${targetTemp}°F`,
      };
    } finally {
      await client.closeAsync();
    }
  } catch (err: any) {
    return { success: false, message: `Failed to update pool schedule: ${err.message}` };
  }
}

/**
 * Update the Pentair controller's pool schedule to disable heating.
 * Keeps all existing schedule settings but sets heatCmd=OFF.
 */
export async function updatePoolScheduleHeatOff(
  gatewayName: string,
  password?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const client = await connectRemote(gatewayName, password);
    try {
      const { poolCircuitId, schedule: s } = await discoverPoolSchedule(client);

      await client.schedule.setScheduleEventByIdAsync(
        s.scheduleId, s.circuitId, s.startTime, s.stopTime,
        s.dayMask, s.flags, HeatModes.HEAT_MODE_OFF, s.heatSetPoint
      );

      return {
        success: true,
        message: `Schedule #${s.scheduleId} (circuit ${poolCircuitId}) updated: heater OFF`,
      };
    } finally {
      await client.closeAsync();
    }
  } catch (err: any) {
    return { success: false, message: `Failed to update pool schedule: ${err.message}` };
  }
}
