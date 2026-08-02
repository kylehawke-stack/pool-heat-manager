/**
 * Smart heat-up time estimation using empirical heating rates + weather forecasts.
 *
 * Based on real-world observation: ~1°F/hr net heating rate for a 250K BTU
 * propane heater on a ~20K gallon uncovered pool, with reduced rates during
 * cold overnight temps when heat loss is higher.
 */

interface HourlyForecast {
  time: string[];
  temperature_2m: number[];
  wind_speed_10m: number[];
}

interface ForecastResponse {
  hourly: HourlyForecast;
}

export interface ForecastPoint {
  time: Date;
  tempF: number;
  windMph: number;
}

/**
 * Brady's seasonal pool-temp defaults (°F) for IntelliConnect pools where we
 * can't read the actual temperature. Uses the check-in date's month.
 */
function seasonalPoolTempDefault(checkInTime: Date): number {
  const month = checkInTime.getMonth() + 1; // 1-12
  const byMonth: Record<number, number> = {
    4: 70,   // April
    5: 72,   // May
    6: 76,   // June
    7: 78,   // July
    8: 78,   // August
    9: 76,   // September
    10: 70,  // October
  };
  return byMonth[month] ?? 70;
}

/**
 * Empirical net heating rate based on air temperature, used for PLANNING.
 *
 * Brady's original observation was ~1°F/hr in mild weather — that's best-case.
 * For scheduling we need conservatism: under-promise, over-deliver. Rates here
 * are 75% of empirical to account for wind, partial coverage of forecast hours,
 * and unit-to-unit variability between heaters.
 *
 * Tuned after the 2026-05-08 Karen Hunter Elmwood incident, where the optimistic
 * 1°F/hr rate produced a 4-hour heat-up plan that left the pool 13°F short.
 */
function netHeatingRate(airTempF: number): number {
  if (airTempF >= 50) return 0.75;
  if (airTempF >= 35) return 0.5;
  return 0.4;
}

/**
 * Empirical idle-cooling rate (°F/hr) when the heater is OFF.
 *
 * A 20K-gallon uncovered pool drops at roughly 0.018 × (poolF − airF) per hour.
 * Tuned to match Elmwood's observed ~11°F drop over 41h of cool VA spring nights
 * (avg air ~58°F) in the 2026-05-08 incident: 0.018 × 20°F gap × 41h ≈ 14.8°F
 * (slight over-estimate vs. observed 11°F — conservative bias is intentional).
 *
 * Without this term, the simulator assumes the pool stays at sim-time temp until
 * the heater fires — exactly the bug that caused the 2026-05-08 cold-pool miss.
 */
function idleCoolRate(airTempF: number, poolTempF: number): number {
  const gap = Math.max(0, poolTempF - airTempF);
  return gap * 0.018;
}

// Retry schedule for transient Open-Meteo failures (5xx, network errors).
// Picked to ride out a typical CDN outage without delaying RECALCULATE
// past the next executor tick (cron runs every minute).
const OPEN_METEO_RETRY_DELAYS_MS = [0, 30_000, 120_000];

export async function getHourlyForecast(
  latitude: number,
  longitude: number,
  hours: number = 72
): Promise<ForecastPoint[]> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_hours=${hours}&timezone=auto`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < OPEN_METEO_RETRY_DELAYS_MS.length; attempt++) {
    if (OPEN_METEO_RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise(r => setTimeout(r, OPEN_METEO_RETRY_DELAYS_MS[attempt]));
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as ForecastResponse;
        return data.hourly.time.map((t, i) => ({
          time: new Date(t),
          tempF: data.hourly.temperature_2m[i],
          windMph: data.hourly.wind_speed_10m[i] ?? 5,
        }));
      }
      // 4xx: don't retry (bad request, won't fix itself)
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Open-Meteo API failed: ${res.status} ${await res.text()}`);
      }
      // 5xx: retry
      lastErr = new Error(`Open-Meteo API failed: ${res.status} ${await res.text()}`);
      console.warn(`[Weather] attempt ${attempt + 1}/${OPEN_METEO_RETRY_DELAYS_MS.length} failed: ${lastErr.message}`);
    } catch (err: any) {
      // Network error (DNS, ECONNRESET, etc.) — retry
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Weather] attempt ${attempt + 1}/${OPEN_METEO_RETRY_DELAYS_MS.length} threw: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error('Open-Meteo API failed: unknown error');
}

/**
 * Simulate hour-by-hour pool heating using empirical rates + weather forecast.
 *
 * Returns: how many hours of heating needed and the hourly trajectory.
 */
export function simulateHeatUp(
  currentPoolTemp: number,
  targetTemp: number,
  forecast: ForecastPoint[],
  checkInTime: Date,
): { hoursNeeded: number; trajectory: { hour: number; poolTemp: number; airTemp: number; netRate: number }[] } {
  if (currentPoolTemp >= targetTemp) {
    return { hoursNeeded: 0, trajectory: [] };
  }

  const trajectory: { hour: number; poolTemp: number; airTemp: number; netRate: number }[] = [];
  let poolTemp = currentPoolTemp;
  let hoursNeeded = 0;

  for (let h = 0; h < forecast.length && h < 72; h++) {
    const fc = forecast[h];
    const rate = netHeatingRate(fc.tempF);

    trajectory.push({
      hour: h,
      poolTemp: Math.round(poolTemp * 10) / 10,
      airTemp: fc.tempF,
      netRate: rate,
    });

    poolTemp += rate;

    if (poolTemp >= targetTemp) {
      hoursNeeded = h + 1;
      break;
    }
  }

  if (poolTemp < targetTemp) {
    hoursNeeded = 72;
  }

  return { hoursNeeded, trajectory };
}

/**
 * Given a check-in time, calculate when to turn the heater on.
 *
 * Two-phase forward simulation:
 *   1. From now until heater-ON: pool sits idle and cools per `idleCoolRate`.
 *   2. From heater-ON until check-in: heater runs; pool rises at `netHeatingRate`
 *      (already net of typical loss — see comment in `simulate()`).
 *
 * We pick the LATEST start hour H ∈ [0, hoursToCheckIn − 2] such that the pool
 * still reaches `targetTemp` by check-in. If no H works (cold pool, short
 * runway), we clamp H to 0 and signal `clamped=true` so the caller can fire a
 * late-detection warning.
 *
 * Why two-phase: the previous one-pass model treated current pool temp as the
 * temp at heater-start. That assumption silently failed in the 2026-05-08 Karen
 * Hunter incident: pool was ~80°F at decision time on Tue evening, sat for 41h
 * of cool nights, dropped to 69°F by Fri noon — but the schedule was set for a
 * 4h heat-up assuming 80°F starting temp. New model accounts for that gap.
 */
export async function calculateHeaterStartTime(
  checkInTime: Date,
  targetTemp: number,
  currentPoolTemp: number | null,
  latitude: number,
  longitude: number
): Promise<{
  startTime: Date;
  estimatedHours: number;
  avgAirTemp: number;
  clamped: boolean;
  shortfallHours: number;
  poolTempAtOn: number;
  poolTempAtCheckIn: number;
}> {
  const forecast = await getHourlyForecast(latitude, longitude, 72);
  const now = new Date();
  const hoursToCheckIn = Math.max(
    0,
    (checkInTime.getTime() - now.getTime()) / (1000 * 60 * 60)
  );

  const poolTempNow = currentPoolTemp ?? seasonalPoolTempDefault(checkInTime);

  const SAFETY_BUFFER_HOURS = 2;
  const horizonHours = Math.min(forecast.length, Math.ceil(hoursToCheckIn) + 1);

  // Forward simulation: pool sits idle for H hours, then heats. Returns the
  // pool temp at heater-ON and at check-in.
  function simulate(H: number): { poolAtOn: number; poolAtCheckIn: number } {
    let pool = poolTempNow;
    let poolAtOn = poolTempNow;
    for (let h = 0; h < horizonHours; h++) {
      if (h === Math.floor(H)) poolAtOn = pool;
      const fc = forecast[h];
      if (h < H) {
        pool -= idleCoolRate(fc.tempF, pool);
      } else if (pool < targetTemp) {
        // `netHeatingRate` is already net of typical loss — Brady's empirical
        // ~1°F/hr was a net observation under similar conditions, and the
        // 0.75× factor in the rate table is the conservatism margin.
        // Subtracting `idleCoolRate` here too double-counted loss and pushed
        // the planner to absurd windows (e.g. 48h to close an 11°F gap at 54°F
        // air — see 2026-05-12 Marshall/Zuehshow alert). Idle-cool only applies
        // when the heater is OFF.
        pool += netHeatingRate(fc.tempF);
      }
      // pool >= target while heating: assume heater modulates to hold (flat)
    }
    return { poolAtOn, poolAtCheckIn: pool };
  }

  // Pick the LARGEST integer H ∈ [0, hoursToCheckIn − buffer] that still
  // reaches target by check-in. Saves propane vs. naive "start ASAP" while
  // honoring the safety buffer.
  const maxH = Math.max(0, Math.floor(hoursToCheckIn - SAFETY_BUFFER_HOURS));
  let bestH = 0;
  let bestSim = simulate(0);
  for (let H = 1; H <= maxH; H++) {
    const s = simulate(H);
    if (s.poolAtCheckIn >= targetTemp) {
      bestH = H;
      bestSim = s;
    }
  }

  const startTime = new Date(now.getTime() + bestH * 60 * 60 * 1000);
  const heatWindowHours = Math.max(0, hoursToCheckIn - bestH);

  const relevant = forecast.slice(
    Math.floor(bestH),
    Math.floor(bestH) + Math.max(1, Math.ceil(heatWindowHours))
  );
  const avgAirTemp = relevant.length > 0
    ? relevant.reduce((a, f) => a + f.tempF, 0) / relevant.length
    : 60;

  const reachesTarget = bestSim.poolAtCheckIn >= targetTemp;
  // "clamped" now means "we are not on track to hit target" — covers both the
  // started-now-still-cold case and the no-runway case. Drives ⚠️ alert text.
  const clamped = !reachesTarget;
  const shortfallHours = clamped
    ? (targetTemp - bestSim.poolAtCheckIn) / 0.5
    : 0;

  return {
    startTime,
    estimatedHours: Math.round(heatWindowHours * 10) / 10,
    avgAirTemp,
    clamped,
    shortfallHours,
    poolTempAtOn: Math.round(bestSim.poolAtOn * 10) / 10,
    poolTempAtCheckIn: Math.round(bestSim.poolAtCheckIn * 10) / 10,
  };
}
